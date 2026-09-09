import { createFileRoute } from "@tanstack/react-router";
import {
  BodyTooLargeError,
  enforceRateLimit,
  readJsonWithLimit,
  requestIp,
} from "@/lib/request-security.server";
import { isMetaSubscriptionConfirmed } from "@/lib/meta-subscription";

// Called by the public onboarding page after Meta Embedded Signup succeeds.
// Exchanges the temporary code for a long-lived access token, stores it,
// fetches the phone-number details, and subscribes the app to the WABA webhook.
//
// Body: { token: string, code: string, waba_id?: string, phone_number_id?: string, business_id?: string }
// The `token` field is the ONBOARDING token (identifies the client). It is
// revalidated on the server; the browser never sees the client_id.
export const Route = createFileRoute("/api/public/onboarding/complete")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        try {
          const limited = await enforceRateLimit({
            key: `onboarding:${requestIp(request)}`,
            limit: 10,
            windowSeconds: 60,
          });
          if (limited) return limited;
          const body = await readJsonWithLimit<{
            token?: string;
            code?: string;
            waba_id?: string;
            phone_number_id?: string;
            business_id?: string;
          }>(request, 32_768);
          if (!body) return Response.json({ ok: false, error: "invalid_json" }, { status: 400 });
          if (!body.token || !body.code) {
            return Response.json({ ok: false, error: "missing_params" }, { status: 400 });
          }

          if (!body.waba_id || !body.phone_number_id) {
            return Response.json(
              {
                ok: false,
                error: "missing_meta_ids",
                detail: "Meta must return code, WABA ID and Phone Number ID.",
              },
              { status: 400 },
            );
          }

          const { databaseAdmin } = await import("@/integrations/database/client.server");

          // 1) Validate onboarding link
          const { data: link, error: linkErr } = await databaseAdmin
            .from("onboarding_links")
            .select("id,client_id,expires_at,used_at")
            .eq("token", body.token)
            .maybeSingle();
          if (linkErr || !link) {
            console.error("[onboarding.complete] link not found", linkErr);
            return Response.json({ ok: false, error: "invalid_token" }, { status: 404 });
          }
          if (link.used_at)
            return Response.json({ ok: false, error: "already_used" }, { status: 410 });
          if (link.expires_at && new Date(link.expires_at) < new Date()) {
            return Response.json({ ok: false, error: "expired" }, { status: 410 });
          }

          const appId = process.env.META_APP_ID ?? process.env.VITE_META_APP_ID;
          const appSecret = process.env.META_APP_SECRET;
          const version = process.env.META_GRAPH_API_VERSION ?? "v25.0";
          if (!appId || !appSecret) {
            console.error("[onboarding.complete] missing META_APP_ID/META_APP_SECRET");
            return Response.json({ ok: false, error: "server_misconfigured" }, { status: 500 });
          }

          // Mark client as in_progress
          await databaseAdmin
            .from("clients")
            .update({ status: "in_progress" })
            .eq("id", link.client_id);

          // 2) Exchange code -> access_token
          // TODO Meta: confirm exact endpoint/params for Embedded Signup (Tech Provider / Coexistence flow).
          const tokenUrl = new URL(`https://graph.facebook.com/${version}/oauth/access_token`);
          tokenUrl.searchParams.set("client_id", appId);
          tokenUrl.searchParams.set("client_secret", appSecret);
          tokenUrl.searchParams.set("code", body.code);
          // TODO Meta: if Embedded Signup requires redirect_uri, set it here to the same value used by the SDK.

          const tokenRes = await fetch(tokenUrl.toString(), {
            method: "GET",
            signal: AbortSignal.timeout(Number(process.env.META_TIMEOUT_MS ?? 15_000)),
          });
          const tokenJson: any = await tokenRes.json();
          if (!tokenRes.ok || !tokenJson.access_token) {
            console.error("[onboarding.complete] token exchange failed", tokenJson);
            await databaseAdmin
              .from("clients")
              .update({ status: "onboarding_error" })
              .eq("id", link.client_id);
            return Response.json(
              { ok: false, error: "token_exchange_failed", detail: tokenJson },
              { status: 502 },
            );
          }
          const accessToken: string = tokenJson.access_token;

          // 3) Fetch phone number details (if we have phone_number_id)
          let phoneDetails: any = null;
          if (body.phone_number_id) {
            const phoneRes = await fetch(
              `https://graph.facebook.com/${version}/${body.phone_number_id}?fields=display_phone_number,verified_name,id`,
              {
                headers: { Authorization: `Bearer ${accessToken}` },
                signal: AbortSignal.timeout(Number(process.env.META_TIMEOUT_MS ?? 15_000)),
              },
            );
            phoneDetails = await phoneRes.json();
            if (!phoneRes.ok)
              console.warn("[onboarding.complete] phone lookup failed", phoneDetails);
          }

          // 4) Subscribe app to WABA
          let webhookSubscribed = false;
          if (body.waba_id) {
            const subRes = await fetch(
              `https://graph.facebook.com/${version}/${body.waba_id}/subscribed_apps`,
              {
                method: "POST",
                headers: { Authorization: `Bearer ${accessToken}` },
                signal: AbortSignal.timeout(Number(process.env.META_TIMEOUT_MS ?? 15_000)),
              },
            );
            const subJson: any = await subRes.json().catch(() => ({}));
            webhookSubscribed = subRes.ok && isMetaSubscriptionConfirmed(subJson);
            if (!webhookSubscribed)
              console.warn("[onboarding.complete] subscribe not confirmed", subJson);
          }

          // 5) Store account (upsert on phone_number_id)
          // The database adapter encrypts token_encrypted before persistence.
          const upsertPayload = {
            client_id: link.client_id,
            waba_id: body.waba_id ?? null,
            phone_number_id: body.phone_number_id ?? null,
            business_id: body.business_id ?? null,
            display_phone_number: phoneDetails?.display_phone_number ?? null,
            verified_name: phoneDetails?.verified_name ?? null,
            status: "connected",
            webhook_subscribed: webhookSubscribed,
            token_encrypted: accessToken,
            connected_at: new Date().toISOString(),
          };

          // Prefer updating an existing pending row for this client (created by
          // /api/public/onboarding/self-start) so we don't leave orphaned pendings.
          let waErr: any = null;
          const { data: pendingRow } = await databaseAdmin
            .from("whatsapp_accounts")
            .select("id")
            .eq("client_id", link.client_id)
            .is("phone_number_id", null)
            .maybeSingle();

          if (pendingRow?.id) {
            const { error } = await databaseAdmin
              .from("whatsapp_accounts")
              .update(upsertPayload)
              .eq("id", pendingRow.id);
            waErr = error;
          } else if (body.phone_number_id) {
            const { error } = await databaseAdmin
              .from("whatsapp_accounts")
              .upsert(upsertPayload, { onConflict: "phone_number_id" });
            waErr = error;
          } else {
            const { error } = await databaseAdmin.from("whatsapp_accounts").insert(upsertPayload);
            waErr = error;
          }
          if (waErr) {
            console.error("[onboarding.complete] db upsert failed", waErr);
            await databaseAdmin
              .from("clients")
              .update({ status: "onboarding_error" })
              .eq("id", link.client_id);
            return Response.json({ ok: false, error: "db_error" }, { status: 500 });
          }

          // 6) Mark link used + client connected
          await databaseAdmin
            .from("onboarding_links")
            .update({ used_at: new Date().toISOString() })
            .eq("id", link.id);
          await databaseAdmin
            .from("clients")
            .update({ status: "connected" })
            .eq("id", link.client_id);

          return Response.json({ ok: true, webhook_subscribed: webhookSubscribed });
        } catch (err: any) {
          if (err instanceof BodyTooLargeError) {
            return Response.json({ ok: false, error: "payload_too_large" }, { status: 413 });
          }
          console.error("[onboarding.complete] unexpected", err);
          return Response.json({ ok: false, error: "server_error" }, { status: 500 });
        }
      },
    },
  },
});
