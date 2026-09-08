import { createFileRoute } from "@tanstack/react-router";
import { createHmac, timingSafeEqual } from "crypto";

// Chatwoot webhook.
//
// TWO CALLERS, ONE ROUTE:
//   * API Inbox webhook  → agent outgoing messages (must forward to Meta).
//     Configure Chatwoot API Inbox webhook URL as this route (no query),
//     or with `?kind=agent`.
//   * Global account webhook → conversation state / label changes.
//     Configure Chatwoot Account Settings → Integrations → Webhooks URL
//     WITH the query string `?kind=global`. `message_created` events on
//     this kind are IGNORED so a single agent message is never processed
//     twice (once per webhook).
//
// Auth: optional HMAC-SHA256 of raw body with the client's
// chatwoot_webhook_secret_encrypted, sent in "X-Chatwoot-Signature" (hex).
//
// Response policy: ALWAYS 200 for accepted-but-ignored / accepted-and-forwarded
// so Chatwoot does not mark the outgoing message as "Error al enviar"
// (Chatwoot's API channel flags the message failed on any non-2xx response
// from its outgoing-message webhook). Only exception: invalid HMAC → 401.
export const Route = createFileRoute("/api/public/chatwoot/webhook")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const url = new URL(request.url);
        const kind = (url.searchParams.get("kind") ?? "agent").toLowerCase();

        const rawBody = await request.text();
        let event: any;
        try {
          event = JSON.parse(rawBody);
        } catch {
          return Response.json({ ok: true, ignored: "invalid_json" });
        }

        const eventType: string = event?.event ?? "";
        const account = event?.account ?? {};
        const inbox = event?.inbox ?? {};
        const accountId = account?.id != null ? String(account.id) : null;
        const inboxId = inbox?.id != null ? String(inbox.id) : null;

        // Global webhook lacks an inbox on some events; try conversation.inbox_id.
        const effectiveInboxId =
          inboxId ??
          (event?.conversation?.inbox_id != null
            ? String(event.conversation.inbox_id)
            : event?.messages?.[0]?.inbox_id != null
              ? String(event.messages[0].inbox_id)
              : null);

        if (!accountId || !effectiveInboxId) {
          return Response.json({ ok: true, ignored: "missing_account_or_inbox" });
        }

        const {
          loadChatwootConfigForWebhook,
          lookupWaIdForConversation,
          recordChatwootAgentSend,
          logChatwootEvent,
          applyChatwootConversationState,
          checkChatwootRateLimit,
        } = await import("@/lib/chatwoot-sync.server");

        const cfg = await loadChatwootConfigForWebhook(accountId, effectiveInboxId);
        if (!cfg) {
          return Response.json({ ok: true, ignored: "no_matching_client" });
        }

        // HMAC verification (if secret configured). Only real security failure
        // returns non-200 — a genuinely invalid signature is not a Chatwoot
        // outgoing-message we want retried into Meta.
        const signature = request.headers.get("x-chatwoot-signature") ?? "";
        if (cfg.signature_enabled && cfg.webhook_secret) {
          try {
            const expected = createHmac("sha256", cfg.webhook_secret).update(rawBody).digest("hex");
            const a = Buffer.from(signature);
            const b = Buffer.from(expected);
            const valid = a.length === b.length && timingSafeEqual(a, b);
            if (!valid) {
              await logChatwootEvent(
                cfg.client_id,
                "webhook_invalid_signature",
                "incoming",
                "error",
                {
                  event_type: eventType,
                },
              );
              return new Response("invalid signature", { status: 401 });
            }
          } catch (err) {
            await logChatwootEvent(cfg.client_id, "webhook_signature_error", "incoming", "error", {
              event_type: eventType,
              error_message: String((err as any)?.message ?? err).slice(0, 500),
            });
            return new Response("invalid signature", { status: 401 });
          }
        }

        // Rate limit — respond 200 so Chatwoot does not mark the message as
        // failed on the sender side. Log for visibility.
        const rl = await checkChatwootRateLimit(cfg.client_id);
        if (!rl.allowed) {
          await logChatwootEvent(cfg.client_id, "rate_limited", "incoming", "ignored", {
            event_type: eventType,
            response_payload: { reason: rl.reason, retry_after_ms: rl.retry_after_ms },
          });
          return Response.json({ ok: true, ignored: "rate_limited" });
        }

        // ---- conversation_updated / labels-changed events ----
        if (
          eventType === "conversation_updated" ||
          eventType === "conversation_status_changed" ||
          eventType === "conversation_resolved" ||
          eventType === "conversation_opened" ||
          eventType === "conversation_reopened"
        ) {
          const convId =
            event?.id != null
              ? String(event.id)
              : event?.conversation?.id != null
                ? String(event.conversation.id)
                : null;
          if (!convId) return Response.json({ ok: true, ignored: "no_conversation_id" });

          const labelsField = event?.labels ?? event?.additional_attributes?.labels ?? null;
          const labels: string[] | null = Array.isArray(labelsField)
            ? labelsField
                .map((l: any) => (typeof l === "string" ? l : (l?.title ?? "")))
                .filter(Boolean)
            : null;
          const status: string | null = event?.status ?? event?.conversation?.status ?? null;
          const assigneeId =
            event?.meta?.assignee?.id != null
              ? String(event.meta.assignee.id)
              : event?.assignee_id != null
                ? String(event.assignee_id)
                : null;

          const applied = await applyChatwootConversationState({
            client_id: cfg.client_id,
            chatwoot_conversation_id: convId,
            labels,
            status,
            assignee_id: assigneeId,
            pause_label: cfg.pause_label,
            pause_on_assigned: cfg.pause_on_assigned,
          });

          const transitioned =
            applied.previous_bot_paused !== null &&
            applied.previous_bot_paused !== applied.bot_paused;
          const stateEvent = transitioned
            ? applied.bot_paused
              ? "bot_paused_by_label"
              : "bot_resumed"
            : "conversation_state_updated";

          await logChatwootEvent(cfg.client_id, stateEvent, "incoming", "success", {
            chatwoot_conversation_id: convId,
            wa_id: applied.wa_id,
            response_payload: {
              labels,
              status,
              assignee_id: assigneeId,
              bot_paused: applied.bot_paused,
            },
          });
          return Response.json({ ok: true, applied: stateEvent });
        }

        // Below: message_created — only the API Inbox webhook forwards to Meta.
        // The global webhook drops message_created to avoid double-processing.
        if (eventType !== "message_created") {
          await logChatwootEvent(
            cfg.client_id,
            `webhook_${eventType || "unknown"}`,
            "incoming",
            "ignored",
            {
              event_type: eventType,
            },
          );
          return Response.json({ ok: true, ignored: "unhandled_event" });
        }

        if (kind === "global") {
          await logChatwootEvent(
            cfg.client_id,
            "chatwoot_duplicate_message_ignored",
            "incoming",
            "ignored",
            {
              event_type: eventType,
              response_payload: { reason: "message_created_on_global_webhook" },
            },
          );
          return Response.json({ ok: true, ignored: "message_created_on_global_webhook" });
        }

        const messageType: string = event?.message_type ?? "";
        const isPrivate = !!event?.private;
        const senderType: string = event?.sender?.type ?? event?.sender_type ?? "";
        const contentAttributes = event?.content_attributes ?? {};
        const sourceTag: string | null = contentAttributes?.source ?? null;
        const chatwootMessageId = event?.id != null ? String(event.id) : null;
        const conversationId =
          event?.conversation?.id != null
            ? String(event.conversation.id)
            : event?.conversation_id != null
              ? String(event.conversation_id)
              : null;

        if (!chatwootMessageId || !conversationId) {
          return Response.json({ ok: true, ignored: "missing_ids" });
        }

        if (messageType !== "outgoing" || isPrivate) {
          await logChatwootEvent(
            cfg.client_id,
            "webhook_ignored_not_outgoing",
            "incoming",
            "ignored",
            {
              chatwoot_message_id: chatwootMessageId,
              chatwoot_conversation_id: conversationId,
              event_type: eventType,
            },
          );
          return Response.json({ ok: true, ignored: "not_public_outgoing" });
        }

        // Anti-loop: bot/meta/n8n mirrors carry source in content_attributes.
        if (
          sourceTag === "bot" ||
          sourceTag === "meta" ||
          sourceTag === "meta_api" ||
          sourceTag === "n8n"
        ) {
          const evt =
            sourceTag === "n8n" ? "chatwoot_ignored_source_n8n" : "webhook_ignored_bot_mirror";
          await logChatwootEvent(cfg.client_id, evt, "incoming", "ignored", {
            chatwoot_message_id: chatwootMessageId,
            chatwoot_conversation_id: conversationId,
            response_payload: { source: sourceTag },
          });
          return Response.json({ ok: true, ignored: "mirror_source" });
        }

        // Only accept messages sent by human agents ("user"). Bot integrations
        // sometimes appear with sender.type === "agent_bot".
        if (senderType && senderType !== "user" && senderType !== "User") {
          await logChatwootEvent(
            cfg.client_id,
            "webhook_ignored_non_agent",
            "incoming",
            "ignored",
            {
              chatwoot_message_id: chatwootMessageId,
              chatwoot_conversation_id: conversationId,
              sender_type: senderType,
            },
          );
          return Response.json({ ok: true, ignored: "non_human_sender" });
        }

        const content: string = String(event?.content ?? "").trim();
        if (!content) {
          return Response.json({ ok: true, ignored: "empty_content" });
        }

        const { databaseAdmin } = await import("@/integrations/database/client.server");

        // Strict dedup: RESERVE the chatwoot_message_id BEFORE calling Meta.
        // Unique index (client_id, chatwoot_message_id) rejects a duplicate,
        // guaranteeing at-most-once delivery even under concurrent webhook
        // fan-out (global + API Inbox arriving in parallel).
        const waId = await lookupWaIdForConversation(cfg.client_id, conversationId);
        if (!waId) {
          await logChatwootEvent(cfg.client_id, "webhook_no_wa_id", "incoming", "error", {
            chatwoot_message_id: chatwootMessageId,
            chatwoot_conversation_id: conversationId,
          });
          return Response.json({ ok: true, ignored: "no_wa_id_mapping" });
        }

        const reserve = await databaseAdmin
          .from("chatwoot_message_mappings")
          .insert({
            client_id: cfg.client_id,
            wa_id: waId,
            chatwoot_message_id: chatwootMessageId,
            chatwoot_conversation_id: conversationId,
            direction: "outgoing",
            source: "chatwoot_agent",
          } as any)
          .select("id")
          .maybeSingle();

        if (reserve.error) {
          // Unique violation → another concurrent handler already accepted it.
          const code = (reserve.error as any)?.code ?? "";
          if (code === "23505") {
            await logChatwootEvent(
              cfg.client_id,
              "chatwoot_duplicate_message_ignored",
              "incoming",
              "ignored",
              {
                chatwoot_message_id: chatwootMessageId,
                chatwoot_conversation_id: conversationId,
              },
            );
            return Response.json({ ok: true, ignored: "already_processed" });
          }
          // Unknown DB error — proceed but log; better to deliver than to drop.
          console.error("[chatwoot-webhook] reserve failed", reserve.error);
        }

        await logChatwootEvent(
          cfg.client_id,
          "chatwoot_agent_outgoing_received",
          "incoming",
          "success",
          {
            wa_id: waId,
            chatwoot_message_id: chatwootMessageId,
            chatwoot_conversation_id: conversationId,
          },
        );

        const { data: acct } = await databaseAdmin
          .from("whatsapp_accounts")
          .select("id, phone_number_id, token_encrypted, status")
          .eq("client_id", cfg.client_id)
          .eq("status", "connected")
          .order("connected_at", { ascending: false })
          .limit(1)
          .maybeSingle();
        if (!acct?.phone_number_id || !acct.token_encrypted) {
          await logChatwootEvent(cfg.client_id, "webhook_no_meta_account", "outgoing", "error", {
            chatwoot_message_id: chatwootMessageId,
            chatwoot_conversation_id: conversationId,
          });
          return Response.json({ ok: true, ignored: "no_meta_account" });
        }

        const version = process.env.META_GRAPH_API_VERSION ?? "v25.0";
        const metaUrl = `https://graph.facebook.com/${version}/${acct.phone_number_id}/messages`;
        const metaBody = {
          messaging_product: "whatsapp",
          to: waId,
          type: "text",
          text: { body: content.slice(0, 4096) },
        };

        let httpStatus = 0;
        let metaJson: any = null;
        let ok = false;
        let networkErr: string | null = null;
        try {
          const res = await fetch(metaUrl, {
            method: "POST",
            headers: {
              "content-type": "application/json",
              authorization: `Bearer ${acct.token_encrypted}`,
            },
            body: JSON.stringify(metaBody),
            signal: AbortSignal.timeout(Number(process.env.META_TIMEOUT_MS ?? 15_000)),
          });
          httpStatus = res.status;
          metaJson = await res.json().catch(() => ({}));
          ok = res.ok;
        } catch (err: any) {
          networkErr = String(err?.message ?? err).slice(0, 500);
        }

        const metaMessageId = ok ? (metaJson?.messages?.[0]?.id ?? null) : null;
        const errMsg = !ok
          ? (metaJson?.error?.message ?? networkErr ?? `HTTP ${httpStatus}`)
          : null;

        await databaseAdmin.from("whatsapp_send_logs").insert({
          client_id: cfg.client_id,
          whatsapp_account_id: acct.id,
          phone_number_id: acct.phone_number_id,
          to_wa_id: waId,
          message_type: "text",
          message_preview: content.slice(0, 200),
          request_payload: metaBody,
          response_status: httpStatus || null,
          response_body: metaJson ?? (networkErr ? { network_error: networkErr } : null),
          meta_message_id: metaMessageId,
          meta_message_status: ok ? "accepted" : null,
          success: ok,
          error_code: metaJson?.error?.code != null ? String(metaJson.error.code) : null,
          error_subcode:
            metaJson?.error?.error_subcode != null ? String(metaJson.error.error_subcode) : null,
          error_type: metaJson?.error?.type ?? (networkErr ? "network_error" : null),
          error_message: errMsg,
          fbtrace_id: metaJson?.error?.fbtrace_id ?? null,
          source: "chatwoot_agent",
          inbound_message_id: null,
        } as any);

        // Update the reserved mapping with the meta_message_id (best effort).
        if (metaMessageId) {
          await recordChatwootAgentSend({
            client_id: cfg.client_id,
            wa_id: waId,
            chatwoot_message_id: chatwootMessageId,
            chatwoot_conversation_id: conversationId,
            meta_message_id: metaMessageId,
          });
        }

        await logChatwootEvent(
          cfg.client_id,
          ok ? "meta_agent_message_sent" : "meta_send_error",
          "outgoing",
          ok ? "success" : "error",
          {
            wa_id: waId,
            chatwoot_message_id: chatwootMessageId,
            chatwoot_conversation_id: conversationId,
            wa_message_id: metaMessageId,
            http_status: httpStatus || null,
            error_message: errMsg,
          },
        );

        // ALWAYS 200: Meta accepted the message → Chatwoot must not show
        // "Error al enviar". Meta failures are captured in logs, not signaled
        // back to Chatwoot as HTTP errors.
        return Response.json({ ok: true, forwarded: ok, meta_message_id: metaMessageId });
      },
    },
  },
});
