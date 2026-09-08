import { createFileRoute } from "@tanstack/react-router";
import {
  BodyTooLargeError,
  enforceRateLimit,
  readJsonWithLimit,
  requestIp,
} from "@/lib/request-security.server";

// Public self-service onboarding start.
// Creates a `clients` row (status = onboarding_started), a pending
// `whatsapp_accounts` row, and a fresh `onboarding_links` token so the
// browser can drive Meta Embedded Signup exactly like the manual /connect/:token flow.
//
// Body: { name: string, email: string, company_name?: string, phone?: string }
// Response: { ok: true, token: string } | { ok: false, error: string }
export const Route = createFileRoute("/api/public/onboarding/self-start")({
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
            name?: string;
            email?: string;
            company_name?: string;
            phone?: string;
          }>(request, 32_768);
          if (!body) return Response.json({ ok: false, error: "invalid_json" }, { status: 400 });

          const name = (body.name ?? "").trim();
          const email = (body.email ?? "").trim();
          const company_name = (body.company_name ?? "").trim() || null;

          if (!name || name.length > 200) {
            return Response.json({ ok: false, error: "invalid_name" }, { status: 400 });
          }
          if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 255) {
            return Response.json({ ok: false, error: "invalid_email" }, { status: 400 });
          }

          const { databaseAdmin } = await import("@/integrations/database/client.server");

          // 1) Create client
          const { data: client, error: cErr } = await databaseAdmin
            .from("clients")
            .insert({
              name,
              email,
              company_name,
              status: "onboarding_started",
            })
            .select("id")
            .single();
          if (cErr || !client) {
            console.error("[onboarding.self-start] client insert failed", cErr);
            return Response.json({ ok: false, error: "db_error" }, { status: 500 });
          }

          // 2) Create pending whatsapp_accounts row (best-effort — non-fatal)
          const { error: waErr } = await databaseAdmin
            .from("whatsapp_accounts")
            .insert({ client_id: client.id, status: "pending" });
          if (waErr) console.warn("[onboarding.self-start] wa insert warn", waErr);

          // 3) Create onboarding link (30-day expiry)
          const token =
            (globalThis.crypto?.randomUUID?.() ?? "").replace(/-/g, "") +
            (globalThis.crypto?.randomUUID?.() ?? "").replace(/-/g, "");
          if (token.length < 32) {
            return Response.json({ ok: false, error: "token_gen_failed" }, { status: 500 });
          }
          const expiresAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString();
          const { error: lErr } = await databaseAdmin
            .from("onboarding_links")
            .insert({ client_id: client.id, token, expires_at: expiresAt });
          if (lErr) {
            console.error("[onboarding.self-start] link insert failed", lErr);
            return Response.json({ ok: false, error: "db_error" }, { status: 500 });
          }

          return Response.json({ ok: true, token });
        } catch (err) {
          if (err instanceof BodyTooLargeError) {
            return Response.json({ ok: false, error: "payload_too_large" }, { status: 413 });
          }
          console.error("[onboarding.self-start] unexpected", err);
          return Response.json({ ok: false, error: "server_error" }, { status: 500 });
        }
      },
    },
  },
});
