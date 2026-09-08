import { createFileRoute } from "@tanstack/react-router";
import { normalizeWaId } from "@/lib/wa-id";

// Endpoint público llamado por instancias n8n para enviar mensajes de WhatsApp
// a través de Meta Cloud API. n8n NUNCA recibe el access token real; solo envía
// client_id + secreto compartido y este endpoint hace la llamada a Meta.
//
// Autenticación: header `X-N8N-Webhook-Secret` debe coincidir con el secreto
// del cliente (`n8n_webhook_secret_encrypted`).
//
// Body (texto):
// { "client_id": "uuid", "to": "5219991234567", "message": "texto", "type": "text" }
//
// Body (template):
// {
//   "client_id": "uuid",
//   "to": "5219991234567",
//   "template_name": "nombre_plantilla",
//   "template_params": ["p1","p2","p3"],
//   "template_language": "es_MX"  // opcional, default es_MX
// }
export const Route = createFileRoute("/api/public/whatsapp/send-message")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        try {
          const secret = request.headers.get("x-n8n-webhook-secret") ?? "";
          const body = (await request.json().catch(() => null)) as {
            client_id?: string;
            to?: string;
            message?: string;
            type?: string;
            template_name?: string;
            template_params?: string[];
            template_language?: string;
            inbound_message_id?: string;
          } | null;

          if (!body || !body.client_id) {
            return Response.json(
              { ok: false, error: "missing_params", detail: "client_id es requerido" },
              { status: 400 },
            );
          }

          const isTemplate = !!body.template_name;
          const type = (body.type ?? (isTemplate ? "template" : "text")).toLowerCase();
          const isTypingIndicator = type === "typing_indicator";

          if (!isTypingIndicator && !body.to) {
            return Response.json(
              { ok: false, error: "missing_params", detail: "to es requerido" },
              { status: 400 },
            );
          }
          if (isTypingIndicator && !body.inbound_message_id) {
            return Response.json(
              {
                ok: false,
                error: "missing_params",
                detail: "inbound_message_id (wamid) es requerido para type=typing_indicator",
              },
              { status: 400 },
            );
          }
          if (!isTemplate && !isTypingIndicator && !body.message) {
            return Response.json(
              { ok: false, error: "missing_params", detail: "message es requerido para type=text" },
              { status: 400 },
            );
          }
          if (type !== "text" && type !== "template" && type !== "typing_indicator") {
            return Response.json({ ok: false, error: "unsupported_type" }, { status: 400 });
          }

    const { databaseAdmin } = await import("@/integrations/database/client.server");

          // 1) Buscar cliente + secreto n8n
          const { data: client, error: cErr } = await databaseAdmin
            .from("clients")
            .select("id, n8n_enabled, n8n_webhook_secret_encrypted")
            .eq("id", body.client_id)
            .maybeSingle();
          if (cErr || !client) {
            return Response.json({ ok: false, error: "client_not_found" }, { status: 404 });
          }
          if (!client.n8n_webhook_secret_encrypted) {
            return Response.json({ ok: false, error: "n8n_not_configured" }, { status: 403 });
          }
          if (!secret || secret !== client.n8n_webhook_secret_encrypted) {
            return Response.json({ ok: false, error: "invalid_secret" }, { status: 401 });
          }

          // 2) Cuenta WhatsApp conectada del cliente
          const { data: acct, error: aErr } = await databaseAdmin
            .from("whatsapp_accounts")
            .select("id, phone_number_id, token_encrypted, status")
            .eq("client_id", client.id)
            .eq("status", "connected")
            .order("connected_at", { ascending: false })
            .limit(1)
            .maybeSingle();
          if (aErr || !acct || !acct.phone_number_id || !acct.token_encrypted) {
            return Response.json(
              { ok: false, error: "no_connected_account" },
              { status: 409 },
            );
          }

          // Dedup de respuestas: si ya se envió un reply exitoso para este
          // inbound_message_id, no volver a enviar. No aplica a typing_indicator
          // (es un evento efímero, no una respuesta).
          const inboundMessageId = body.inbound_message_id?.trim() || null;
          if (inboundMessageId && !isTypingIndicator) {
            const { data: prior } = await databaseAdmin
              .from("whatsapp_send_logs")
              .select("id, meta_message_id")
              .eq("client_id", client.id)
              .eq("inbound_message_id", inboundMessageId)
              .eq("success", true)
              .limit(1)
              .maybeSingle();
            if (prior?.id) {
              console.log("[send-message] reply_deduped", { inboundMessageId, prior_id: prior.id });
              await databaseAdmin.from("message_send_logs").insert({
                client_id: client.id,
                phone_number_id: null,
                to: String(body.to ?? "").replace(/[^\d]/g, ""),
                message_preview: `[reply_deduped] inbound=${inboundMessageId}`,
                status: "deduped",
                meta_message_id: prior.meta_message_id ?? null,
                error_message: null,
                raw_response: { deduped: true, reason: "reply_already_sent_for_inbound_message" },
                source: "n8n",
                http_status: null,
                request_payload: null,
              } as any);
              return Response.json({
                success: true,
                deduped: true,
                reason: "reply_already_sent_for_inbound_message",
                message_id: prior.meta_message_id ?? null,
              });
            }
          }

          const version = process.env.META_GRAPH_API_VERSION ?? "v25.0";
          const url = `https://graph.facebook.com/${version}/${acct.phone_number_id}/messages`;

          let metaBody: Record<string, any>;
          let messagePreview: string;
          let messageType: string;

          if (isTypingIndicator) {
            // Meta: marca leído + typing indicator ligado a un wamid puntual.
            // Se auto-limpia a los 25s o cuando se envíe la respuesta real.
            metaBody = {
              messaging_product: "whatsapp",
              status: "read",
              message_id: inboundMessageId,
              typing_indicator: { type: "text" },
            };
            messagePreview = `[typing_indicator] inbound=${inboundMessageId}`;
            messageType = "typing_indicator";
          } else if (isTemplate) {
            const params = Array.isArray(body.template_params) ? body.template_params : [];
            const language = body.template_language || "es_MX";
            const components =
              params.length > 0
                ? [
                    {
                      type: "body",
                      parameters: params.map((p) => ({ type: "text", text: String(p) })),
                    },
                  ]
                : [];
            metaBody = {
              messaging_product: "whatsapp",
              to: body.to,
              type: "template",
              template: {
                name: body.template_name,
                language: { code: language },
                ...(components.length > 0 ? { components } : {}),
              },
            };
            messagePreview = `[template:${body.template_name}] ${params.join(" | ")}`.slice(0, 200);
            messageType = "template";
          } else {
            metaBody = {
              messaging_product: "whatsapp",
              to: body.to,
              type: "text",
              text: { body: body.message },
            };
            messagePreview = String(body.message).slice(0, 200);
            messageType = "text";
          }

          let metaJson: any = null;
          let httpStatus = 0;
          let ok = false;
          let networkErr: string | null = null;

          try {
            const res = await fetch(url, {
              method: "POST",
              headers: {
                "content-type": "application/json",
                authorization: `Bearer ${acct.token_encrypted}`,
              },
              body: JSON.stringify(metaBody),
            });
            httpStatus = res.status;
            metaJson = await res.json().catch(() => ({}));
            ok = res.ok;
          } catch (err: any) {
            networkErr = String(err?.message ?? err);
            console.error("[send-message] network error", networkErr);
          }

          const metaMessageId = ok ? metaJson?.messages?.[0]?.id ?? null : null;
          const errMsg = !ok
            ? metaJson?.error?.message ?? networkErr ?? "Fallo al enviar"
            : null;

          const toDigits = String(body.to ?? "").replace(/[^\d]/g, "");

          await databaseAdmin.from("message_send_logs").insert({
            client_id: client.id,
            phone_number_id: acct.phone_number_id,
            to: toDigits,
            message_preview: messagePreview,
            status: ok ? "success" : "error",
            meta_message_id: metaMessageId,
            error_message: errMsg,
            raw_response: metaJson ?? (networkErr ? { network_error: networkErr } : null),
            source: "n8n",
            http_status: httpStatus || null,
            request_payload: metaBody,
          } as any);

          await databaseAdmin.from("whatsapp_send_logs").insert({
            client_id: client.id,
            whatsapp_account_id: acct.id,
            phone_number_id: acct.phone_number_id,
            to_wa_id: toDigits,
            message_type: messageType,
            message_preview: messagePreview,
            request_payload: metaBody,
            response_status: httpStatus || null,
            response_body: metaJson ?? (networkErr ? { network_error: networkErr } : null),
            meta_message_id: metaMessageId,
            meta_message_status: ok ? "accepted" : null,
            success: ok,
            error_code: metaJson?.error?.code != null ? String(metaJson.error.code) : null,
            error_subcode: metaJson?.error?.error_subcode != null ? String(metaJson.error.error_subcode) : null,
            error_type: metaJson?.error?.type ?? (networkErr ? "network_error" : null),
            error_message: errMsg,
            fbtrace_id: metaJson?.error?.fbtrace_id ?? null,
            source: "n8n",
            inbound_message_id: inboundMessageId,
          } as any);

          if (!ok) {
            console.error("[send-message] Meta error", httpStatus, metaJson);
            return Response.json(
              { ok: false, error: "meta_error", status: httpStatus, detail: metaJson ?? { network_error: networkErr } },
              { status: 502 },
            );
          }

          // typing_indicator es efímero: no genera mensaje real, no se espeja
          // a Chatwoot y no devuelve message_id.
          if (isTypingIndicator) {
            return Response.json({ ok: true, typing_indicator: true, inbound_message_id: inboundMessageId });
          }

          // Mirror bot response into Chatwoot (opt-in per client). Never blocks
          // the response to n8n on failure.
          try {
            const { mirrorOutboundToChatwoot } = await import("@/lib/chatwoot-sync.server");
            // Prefer the wa_id from the original inbound message (canonical
            // per Meta) so we mirror into the SAME conversation instead of
            // creating a new one under the "to" variant the caller sent.
            let mirrorWaId: string | null = null;
            if (inboundMessageId) {
              const { databaseAdmin: sa } = await import("@/integrations/database/client.server");
              const { data: inboundMap } = await sa
                .from("chatwoot_message_mappings")
                .select("wa_id")
                .eq("client_id", client.id)
                .eq("inbound_message_id", inboundMessageId)
                .maybeSingle();
              if (inboundMap?.wa_id) mirrorWaId = inboundMap.wa_id;
            }
            if (!mirrorWaId) mirrorWaId = normalizeWaId(body.to);
            await mirrorOutboundToChatwoot({
              client_id: client.id,
              wa_id: mirrorWaId,
              meta_message_id: metaMessageId,
              text: isTemplate ? messagePreview : (body.message ?? null),
              message_type: messageType,
              source: "n8n",
              inbound_message_id: inboundMessageId,
            });
          } catch (mirrorErr) {
            console.error("[send-message] chatwoot mirror failed", mirrorErr);
          }

          return Response.json({ ok: true, message_id: metaMessageId, meta: metaJson });

        } catch (err: any) {
          console.error("[send-message] error", err);
          return Response.json(
            { ok: false, error: "server_error", detail: String(err?.message ?? err) },
            { status: 500 },
          );
        }
      },
    },
  },
});
