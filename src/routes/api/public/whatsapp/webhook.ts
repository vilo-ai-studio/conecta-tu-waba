import { createFileRoute } from "@tanstack/react-router";
import { normalizeWaId } from "@/lib/wa-id";

// Meta calls this endpoint for webhook verification (GET) and events (POST).
// GET: verifies hub.verify_token and echoes hub.challenge.
// POST:
//   1. Guarda inmediatamente el payload crudo en meta_webhook_events (una fila por change).
//   2. Detecta si es mensaje entrante o status update y extrae campos útiles.
//   3. Si el cliente asociado tiene n8n habilitado y URL configurada, reenvía y
//      registra cada intento en n8n_forward_logs (sin exponer el secreto real).
//   4. Si es status update, actualiza el whatsapp_send_logs correspondiente.
//   5. Siempre responde 200 a Meta rápidamente.
export const Route = createFileRoute("/api/public/whatsapp/webhook")({
  server: {
    handlers: {
      GET: async ({ request }) => {
        const url = new URL(request.url);
        const mode = url.searchParams.get("hub.mode");
        const token = url.searchParams.get("hub.verify_token");
        const challenge = url.searchParams.get("hub.challenge");
        const expected = process.env.WHATSAPP_VERIFY_TOKEN;
        if (mode === "subscribe" && expected && token === expected && challenge) {
          return new Response(challenge, { status: 200, headers: { "content-type": "text/plain" } });
        }
        console.warn("[wa-webhook] verify failed", { mode, hasToken: !!token });
        return new Response("Forbidden", { status: 403 });
      },

      POST: async ({ request }) => {
        const rawBody = await request.text();
        // Serializar headers sin secretos sensibles.
        const rawHeaders: Record<string, string> = {};
        request.headers.forEach((v, k) => {
          const lk = k.toLowerCase();
          if (lk === "authorization" || lk === "cookie" || lk.includes("token") || lk.includes("secret")) return;
          rawHeaders[k] = v;
        });

        const reqUrl = new URL(request.url);
        const queryParams: Record<string, string> = {};
        reqUrl.searchParams.forEach((v, k) => { queryParams[k] = v; });

    const { databaseAdmin } = await import("@/integrations/database/client.server");

        // 0) Guardar SIEMPRE el payload crudo, antes de cualquier validación.
        let parsedBody: any = null;
        let parseError: string | null = null;
        try {
          parsedBody = rawBody ? JSON.parse(rawBody) : null;
        } catch (err: any) {
          parseError = `JSON parse error: ${String(err?.message ?? err).slice(0, 300)}`;
        }

        // Detectar phone_number_id en cualquier lugar del payload (puede faltar en tests de Meta).
        let detectedPhoneId: string | null = null;
        try {
          const entries: any[] = Array.isArray(parsedBody?.entry) ? parsedBody.entry : [];
          for (const entry of entries) {
            const changes: any[] = Array.isArray(entry?.changes) ? entry.changes : [];
            for (const ch of changes) {
              const pid = ch?.value?.metadata?.phone_number_id;
              if (pid) { detectedPhoneId = pid; break; }
            }
            if (detectedPhoneId) break;
          }
        } catch {}

        // Heurística para detectar el botón "Test" de Meta:
        // suele mandar un payload sin metadata.phone_number_id, con IDs ficticios
        // (ej. "WHATSAPP_BUSINESS_ACCOUNT_ID") o messages con from de ejemplo.
        const bodyStr = rawBody || "";
        const isMetaTest =
          !detectedPhoneId && (
            /WHATSAPP_BUSINESS_ACCOUNT_ID|PHONE_NUMBER|WHATSAPP_ID|MESSAGE_ID/i.test(bodyStr) ||
            (parsedBody?.entry && !detectedPhoneId)
          );

        const rawInsert = await databaseAdmin
          .from("raw_meta_webhook_events")
          .insert({
            method: "POST",
            url: request.url,
            query_params: queryParams,
            headers: rawHeaders,
            body_raw: bodyStr.slice(0, 20000),
            body_json: parsedBody,
            phone_number_id: detectedPhoneId,
            object_type: parsedBody?.object ?? null,
            is_meta_test: isMetaTest,
            processing_error: parseError ?? (!detectedPhoneId ? "phone_number_id not found" : null),
            processed: false,
          })
          .select("id")
          .single();

        if (isMetaTest) {
          console.log("[wa-webhook] Meta Test button event received", { id: rawInsert.data?.id });
        }
        if (!detectedPhoneId) {
          console.warn("[wa-webhook] event without phone_number_id", { id: rawInsert.data?.id, is_meta_test: isMetaTest });
        }

        // Si no hay body válido o no hay phone_number_id, respondemos 200 y no procesamos más.
        if (!parsedBody || !detectedPhoneId) {
          return new Response("ok", { status: 200 });
        }

        try {
          const payload = parsedBody;

          const entries: any[] = Array.isArray(payload?.entry) ? payload.entry : [];

          // 1) Recolectar phone_number_ids presentes para mapear cuentas.
          const phoneNumberIds = new Set<string>();
          for (const entry of entries) {
            const changes: any[] = Array.isArray(entry?.changes) ? entry.changes : [];
            for (const ch of changes) {
              const pid = ch?.value?.metadata?.phone_number_id;
              if (pid) phoneNumberIds.add(pid);
            }
          }

          const accountsByPhone = new Map<
            string,
            {
              account_id: string;
              client_id: string;
              n8n_enabled: boolean;
              n8n_webhook_url: string | null;
              n8n_webhook_secret_encrypted: string | null;
            }
          >();

          if (phoneNumberIds.size > 0) {
            const { data: accounts } = await databaseAdmin
              .from("whatsapp_accounts")
              .select(
                "id, phone_number_id, client_id, clients:client_id(n8n_enabled, n8n_webhook_url, n8n_webhook_secret_encrypted)",
              )
              .in("phone_number_id", Array.from(phoneNumberIds));

            for (const acct of accounts ?? []) {
              if (!acct.phone_number_id) continue;
              const client: any = (acct as any).clients ?? {};
              accountsByPhone.set(acct.phone_number_id, {
                account_id: acct.id,
                client_id: acct.client_id,
                n8n_enabled: !!client.n8n_enabled,
                n8n_webhook_url: client.n8n_webhook_url ?? null,
                n8n_webhook_secret_encrypted: client.n8n_webhook_secret_encrypted ?? null,
              });
            }
          }

          // 2) Procesar cada change: guardar meta_webhook_events y SIEMPRE crear
          //    un log de diagnóstico en n8n_forward_logs (aunque no se reenvíe).
          for (const entry of entries) {
            const changes: any[] = Array.isArray(entry?.changes) ? entry.changes : [];
            for (const change of changes) {
              const field: string | null = change?.field ?? null;
              const value: any = change?.value ?? {};
              const phoneNumberId: string | null = value?.metadata?.phone_number_id ?? null;
              const displayPhoneNumber: string | null = value?.metadata?.display_phone_number ?? null;
              const account = phoneNumberId ? accountsByPhone.get(phoneNumberId) : undefined;

              // Extraer campos útiles según tipo de change.
              const msg = Array.isArray(value?.messages) ? value.messages[0] : null;
              const stt = Array.isArray(value?.statuses) ? value.statuses[0] : null;
              const contact = Array.isArray(value?.contacts) ? value.contacts[0] : null;
              const contactName: string | null = contact?.profile?.name ?? null;

              let event_kind: string | null = null;
              let wa_message_id: string | null = null;
              let from_wa_id: string | null = null;
              let to_phone_number: string | null = displayPhoneNumber;
              let message_type: string | null = null;
              let text_body: string | null = null;
              let msg_timestamp: string | null = null;
              let status: string | null = null;
              let error_code: string | null = null;
              let error_title: string | null = null;
              let error_message: string | null = null;
              let error_details: any = null;

              if (msg) {
                event_kind = "message";
                wa_message_id = msg.id ?? null;
                from_wa_id = normalizeWaId(msg.from ?? null) || (msg.from ?? null);
                message_type = msg.type ?? null;
                text_body = msg?.text?.body ?? null;
                msg_timestamp = msg.timestamp ?? null;
              } else if (stt) {
                event_kind = "status";
                wa_message_id = stt.id ?? null;
                status = stt.status ?? null;
                const err = Array.isArray(stt?.errors) ? stt.errors[0] : null;
                if (err) {
                  error_code = err.code != null ? String(err.code) : null;
                  error_title = err.title ?? null;
                  error_message = err.message ?? err.error_data?.details ?? null;
                  error_details = err;
                }
              } else if (field) {
                event_kind = field;
              } else {
                event_kind = "unknown";
              }

              const processing_error = phoneNumberId && !account
                ? `No client found for phone_number_id=${phoneNumberId}`
                : null;

              // Insertar meta_webhook_events y recuperar id.
              const { data: insertedEvent } = await databaseAdmin
                .from("meta_webhook_events")
                .insert({
                  client_id: account?.client_id ?? null,
                  whatsapp_account_id: account?.account_id ?? null,
                  phone_number_id: phoneNumberId,
                  direction: "inbound_from_meta",
                  field,
                  event_kind,
                  wa_message_id,
                  from_wa_id,
                  to_phone_number,
                  message_type,
                  text_body,
                  status,
                  error_code,
                  error_title,
                  error_message,
                  error_details,
                  raw_headers: rawHeaders,
                  raw_payload: {
                    object: payload?.object ?? null,
                    entry: [{ id: entry?.id ?? null, changes: [change] }],
                  },
                  processed: !!account,
                  processing_error,
                })
                .select("id")
                .single();

              // Mantener compatibilidad con webhook_events viejo.
              await databaseAdmin.from("webhook_events").insert({
                whatsapp_account_id: account?.account_id ?? null,
                event_type: field,
                payload: {
                  object: payload?.object ?? null,
                  entry: [{ id: entry?.id ?? null, changes: [change] }],
                },
              });

              // Si es un status para un envío nuestro, actualizar whatsapp_send_logs.
              if (event_kind === "status" && wa_message_id && status) {
                await databaseAdmin
                  .from("whatsapp_send_logs")
                  .update({
                    meta_message_status: status,
                    error_code: error_code,
                    error_message: error_message,
                    success: status === "delivered" || status === "read" || status === "sent",
                  })
                  .eq("meta_message_id", wa_message_id);
              }

              // 3) SIEMPRE registrar diagnóstico en n8n_forward_logs si hay
              //    phone_number_id, incluso cuando no reenviamos.
              if (!phoneNumberId) continue;

              const baseLog: Record<string, any> = {
                client_id: account?.client_id ?? null,
                whatsapp_account_id: account?.account_id ?? null,
                meta_webhook_event_id: insertedEvent?.id ?? null,
                phone_number_id: phoneNumberId,
                n8n_webhook_url: account?.n8n_webhook_url ?? null,
                forward_attempted: false,
                success: false,
                attempted_at: new Date().toISOString(),
              };

              // A) No whatsapp_account
              if (!account) {
                await databaseAdmin.from("n8n_forward_logs").insert({
                  ...baseLog,
                  error_message: "No whatsapp_account found for phone_number_id",
                });
                continue;
              }

              // B) whatsapp_account sin client_id (defensivo)
              if (!account.client_id) {
                await databaseAdmin.from("n8n_forward_logs").insert({
                  ...baseLog,
                  error_message: "No client found for whatsapp_account",
                });
                continue;
              }

              // C) n8n_enabled !== true
              if (!account.n8n_enabled) {
                await databaseAdmin.from("n8n_forward_logs").insert({
                  ...baseLog,
                  n8n_enabled_value: account.n8n_enabled ?? false,
                  error_message: "n8n disabled for client",
                });
                continue;
              }

              // D) Sin URL
              if (!account.n8n_webhook_url || account.n8n_webhook_url.length === 0) {
                await databaseAdmin.from("n8n_forward_logs").insert({
                  ...baseLog,
                  n8n_enabled_value: true,
                  error_message: "n8n webhook URL missing",
                });
                continue;
              }

              // E) Sin secreto
              if (!account.n8n_webhook_secret_encrypted) {
                await databaseAdmin.from("n8n_forward_logs").insert({
                  ...baseLog,
                  n8n_enabled_value: true,
                  error_message: "n8n webhook secret missing",
                });
                continue;
              }

              // E.5) Bloquear reenvío de status events a n8n. Solo message
              // events se reenvían al bot.
              if (event_kind !== "message") {
                await databaseAdmin.from("n8n_forward_logs").insert({
                  ...baseLog,
                  n8n_enabled_value: true,
                  error_message: `status_event_ignored:${event_kind ?? "unknown"}${status ? `:${status}` : ""}`,
                });
                continue;
              }

              // E.6) Anti-duplicados para mensajes entrantes: usar
              // processed_whatsapp_messages como fuente de verdad.
              if (wa_message_id) {
                const existing = await databaseAdmin
                  .from("processed_whatsapp_messages")
                  .select("id, duplicate_count")
                  .eq("message_id", wa_message_id)
                  .maybeSingle();

                if (existing.data?.id) {
                  const nextCount = (existing.data.duplicate_count ?? 0) + 1;
                  await databaseAdmin
                    .from("processed_whatsapp_messages")
                    .update({
                      duplicate_count: nextCount,
                      last_seen_at: new Date().toISOString(),
                    })
                    .eq("id", existing.data.id);
                  console.log("[wa-webhook] duplicate_ignored", { message_id: wa_message_id, count: nextCount });
                  await databaseAdmin.from("n8n_forward_logs").insert({
                    ...baseLog,
                    n8n_enabled_value: true,
                    error_message: `duplicate_ignored:count=${nextCount}`,
                  });
                  continue;
                }

                // Insertar ANTES de reenviar para que un retry paralelo no dispare 2 veces.
                const nowIso = new Date().toISOString();
                const insertRes = await databaseAdmin
                  .from("processed_whatsapp_messages")
                  .insert({
                    client_id: account.client_id,
                    whatsapp_account_id: account.account_id,
                    phone_number_id: phoneNumberId,
                    message_id: wa_message_id,
                    from_wa_id: from_wa_id,
                    message_type: message_type,
                    text: text_body,
                    meta_timestamp: msg_timestamp,
                    first_seen_at: nowIso,
                    last_seen_at: nowIso,
                    duplicate_count: 0,
                  })
                  .select("id")
                  .maybeSingle();
                if (insertRes.error && (insertRes.error as any).code === "23505") {
                  await databaseAdmin
                    .from("processed_whatsapp_messages")
                    .update({ last_seen_at: nowIso })
                    .eq("message_id", wa_message_id);
                  await databaseAdmin.from("n8n_forward_logs").insert({
                    ...baseLog,
                    n8n_enabled_value: true,
                    error_message: "duplicate_ignored:race",
                  });
                  continue;
                }
                if (insertRes.error) {
                  console.error("[wa-webhook] processed_whatsapp_messages insert error", insertRes.error);
                }
              }

              // F.pre) Chatwoot sync (opcional por cliente). Si el bot queda
              // pausado (label 'human' o asignación), NO reenviamos a n8n.
              let chatwootPaused = false;
              let chatwootNote: string | null = null;
              try {
                if (!from_wa_id) throw new Error("missing_from_wa_id");
                const { syncInboundToChatwoot } = await import("@/lib/chatwoot-sync.server");
                const result = await syncInboundToChatwoot({
                  client_id: account.client_id,
                  wa_id: from_wa_id,
                  profile_name: contactName,
                  wa_message_id: wa_message_id,
                  message_type,
                  text: text_body,
                });

                if (result.synced) {
                  chatwootPaused = result.bot_paused;
                  chatwootNote = `chatwoot_synced:paused=${result.bot_paused}`;
                } else {
                  chatwootNote = `chatwoot_${result.reason}`;
                }
              } catch (err: any) {
                console.error("[wa-webhook] chatwoot sync unexpected error", err);
                chatwootNote = `chatwoot_error:${String(err?.message ?? err).slice(0, 200)}`;
              }

              if (chatwootPaused) {
                await databaseAdmin.from("n8n_forward_logs").insert({
                  ...baseLog,
                  n8n_enabled_value: true,
                  error_message: `chatwoot_paused:label_or_assignee (${chatwootNote ?? "n/a"})`,
                });
                continue;
              }

              // F) Reenviar a n8n.
              const recipientId: string | null = stt?.recipient_id ?? null;




              const basePayload = {
                source: "meta_whatsapp",
                client_id: account.client_id,
                whatsapp_account_id: account.account_id,
                phone_number_id: phoneNumberId,
                display_phone_number: displayPhoneNumber,
                raw: {
                  object: payload?.object ?? null,
                  entry: [{ id: entry?.id ?? null, changes: [change] }],
                },
              };

              let requestPayload: Record<string, any>;
              if (event_kind === "message") {
                requestPayload = {
                  ...basePayload,
                  event_kind: "message",
                  from: from_wa_id,
                  contact_name: contactName,
                  message_id: wa_message_id,
                  message_type,
                  text: text_body,
                  timestamp: msg_timestamp,
                };
              } else if (event_kind === "status") {
                requestPayload = {
                  ...basePayload,
                  event_kind: "status",
                  status,
                  recipient_id: recipientId,
                  message_id: wa_message_id,
                  timestamp: stt?.timestamp ?? null,
                };
              } else {
                requestPayload = {
                  ...basePayload,
                  event_kind: event_kind ?? "unknown",
                  field,
                };
              }

              const logHeaders = {
                "content-type": "application/json",
                "X-Client-ID": account.client_id,
                "X-Phone-Number-ID": phoneNumberId,
                "X-N8N-Webhook-Secret": "***",
                secret_present: true,
              };

              let responseStatus: number | null = null;
              let responseBody: string | null = null;
              let ok = false;
              let fwdErrorMessage: string | null = null;
              const attemptedAt = new Date().toISOString();
              try {
                const res = await fetch(account.n8n_webhook_url, {
                  method: "POST",
                  headers: {
                    "content-type": "application/json",
                    "X-Client-ID": account.client_id,
                    "X-Phone-Number-ID": phoneNumberId,
                    "X-N8N-Webhook-Secret": account.n8n_webhook_secret_encrypted,
                  },
                  body: JSON.stringify(requestPayload),
                });
                responseStatus = res.status;
                responseBody = (await res.text().catch(() => "")).slice(0, 4000);
                ok = res.ok;
                if (!ok) fwdErrorMessage = `HTTP ${res.status}: ${responseBody.slice(0, 500)}`;
              } catch (err: any) {
                fwdErrorMessage = String(err?.message ?? err).slice(0, 500);
                console.error("[wa-webhook] n8n forward failed", fwdErrorMessage);
              }

              await databaseAdmin.from("n8n_forward_logs").insert({
                client_id: account.client_id,
                whatsapp_account_id: account.account_id,
                meta_webhook_event_id: insertedEvent?.id ?? null,
                phone_number_id: phoneNumberId,
                n8n_webhook_url: account.n8n_webhook_url,
                forward_attempted: true,
                n8n_enabled_value: true,
                request_headers: logHeaders,
                request_payload: requestPayload,
                response_status: responseStatus,
                response_body: responseBody,
                success: ok,
                error_message: fwdErrorMessage,
                attempted_at: attemptedAt,
              });

              await databaseAdmin
                .from("clients")
                .update({
                  n8n_last_delivery_at: attemptedAt,
                  n8n_last_delivery_status: ok ? "success" : "error",
                  n8n_last_delivery_error: ok ? null : fwdErrorMessage,
                })
                .eq("id", account.client_id);
            }
          }
          if (rawInsert.data?.id) {
            await databaseAdmin
              .from("raw_meta_webhook_events")
              .update({ processed: true })
              .eq("id", rawInsert.data.id);
          }
        } catch (err: any) {
          console.error("[wa-webhook] error", err);
          if (rawInsert.data?.id) {
            await databaseAdmin
              .from("raw_meta_webhook_events")
              .update({ processing_error: String(err?.message ?? err).slice(0, 500) })
              .eq("id", rawInsert.data.id);
          }
        }
        return new Response("ok", { status: 200 });
      },
    },
  },
});
