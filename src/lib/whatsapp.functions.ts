import { createServerFn } from "@tanstack/react-start";
import { requireDatabaseAuth } from "@/integrations/database/auth-middleware";
import { z } from "zod";
import { isMetaSubscriptionConfirmed } from "@/lib/meta-subscription";

async function assertAdmin(database: any, userId: string) {
  const { data } = await database
    .from("user_roles")
    .select("role")
    .eq("user_id", userId)
    .eq("role", "admin")
    .maybeSingle();
  if (!data) throw new Error("No autorizado");
}

function normalizePhone(raw: string): string {
  return raw.replace(/[^\d]/g, "");
}

// Envía un mensaje de prueba de WhatsApp para un cliente dado, usando su cuenta
// conectada. El access token nunca sale del backend. Registra el intento en
// message_send_logs.
export const sendTestMessage = createServerFn({ method: "POST" })
  .middleware([requireDatabaseAuth])
  .inputValidator((input: { client_id: string; to: string; message: string; type?: string }) =>
    z
      .object({
        client_id: z.string().uuid(),
        to: z.string().trim().min(4).max(30),
        message: z.string().trim().min(1).max(4096),
        type: z.string().optional(),
      })
      .parse(input),
  )
  .handler(async ({ context, data }) => {
    await assertAdmin(context.database, context.userId);

    const type = (data.type ?? "text").toLowerCase();
    if (type !== "text") {
      return { ok: false, error: { message: "Tipo no soportado", type: "unsupported_type" } };
    }

    const to = normalizePhone(data.to);
    if (to.length < 6) {
      return { ok: false, error: { message: "Número de destino inválido", type: "invalid_to" } };
    }

    const { databaseAdmin } = await import("@/integrations/database/client.server");

    const { data: client } = await databaseAdmin
      .from("clients")
      .select("id")
      .eq("id", data.client_id)
      .maybeSingle();
    if (!client) {
      return { ok: false, error: { message: "Cliente no encontrado", type: "client_not_found" } };
    }

    const { data: acct } = await databaseAdmin
      .from("whatsapp_accounts")
      .select("id, phone_number_id, token_encrypted, status")
      .eq("client_id", client.id)
      .eq("status", "connected")
      .order("connected_at", { ascending: false })
      .limit(1)
      .maybeSingle();

    if (!acct || !acct.phone_number_id || !acct.token_encrypted) {
      const errMsg =
        "El cliente no tiene una cuenta de WhatsApp conectada con credenciales válidas.";
      await databaseAdmin.from("message_send_logs").insert({
        client_id: client.id,
        phone_number_id: acct?.phone_number_id ?? null,
        to,
        message_preview: data.message.slice(0, 200),
        status: "error",
        error_message: errMsg,
        raw_response: null,
      });
      return { ok: false, error: { message: errMsg, type: "no_connected_account" } };
    }

    const version = process.env.META_GRAPH_API_VERSION ?? "v25.0";
    const url = `https://graph.facebook.com/${version}/${acct.phone_number_id}/messages`;
    const metaBody = {
      messaging_product: "whatsapp",
      to,
      type: "text",
      text: { body: data.message },
    };

    let metaJson: any = null;
    let httpStatus = 0;
    let ok = false;
    let networkErr: string | null = null;

    try {
      const res = await fetch(url, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${acct.token_encrypted}`,
          "content-type": "application/json",
        },
        body: JSON.stringify(metaBody),
        signal: AbortSignal.timeout(Number(process.env.META_TIMEOUT_MS ?? 15_000)),
      });
      httpStatus = res.status;
      metaJson = await res.json().catch(() => ({}));
      ok = res.ok;
    } catch (err: any) {
      networkErr = String(err?.message ?? err);
      console.error("[sendTestMessage] network error", networkErr);
    }

    const metaMessageId = ok ? (metaJson?.messages?.[0]?.id ?? null) : null;
    const metaError = !ok
      ? {
          message: metaJson?.error?.message ?? networkErr ?? "Fallo al enviar",
          type: metaJson?.error?.type ?? (networkErr ? "network_error" : "meta_error"),
          code: metaJson?.error?.code ?? null,
          error_subcode: metaJson?.error?.error_subcode ?? null,
          fbtrace_id: metaJson?.error?.fbtrace_id ?? null,
          http_status: httpStatus || null,
        }
      : null;

    await databaseAdmin.from("message_send_logs").insert({
      client_id: client.id,
      phone_number_id: acct.phone_number_id,
      to,
      message_preview: data.message.slice(0, 200),
      status: ok ? "success" : "error",
      meta_message_id: metaMessageId,
      error_message: metaError?.message ?? null,
      raw_response: metaJson ?? (networkErr ? { network_error: networkErr } : null),
      source: "panel",
      http_status: httpStatus || null,
      request_payload: metaBody,
    } as any);

    // Nuevo log dedicado a envíos → Meta.
    await databaseAdmin.from("whatsapp_send_logs").insert({
      client_id: client.id,
      whatsapp_account_id: acct.id,
      phone_number_id: acct.phone_number_id,
      to_wa_id: to,
      message_type: "text",
      message_preview: data.message.slice(0, 200),
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
      error_message: metaError?.message ?? null,
      fbtrace_id: metaJson?.error?.fbtrace_id ?? null,
      source: "panel",
    } as any);

    if (!ok) {
      console.error("[sendTestMessage] Meta error", httpStatus, metaError);
      return { ok: false, error: metaError };
    }
    return { ok: true, message_id: metaMessageId, meta: metaJson };
  });

// Legacy helper kept for compatibility with any existing callers.
export const sendWhatsAppMessage = createServerFn({ method: "POST" })
  .middleware([requireDatabaseAuth])
  .inputValidator((input: { whatsapp_account_id: string; to: string; text: string }) =>
    z
      .object({
        whatsapp_account_id: z.string().uuid(),
        to: z.string().trim().min(5).max(30),
        text: z.string().trim().min(1).max(4096),
      })
      .parse(input),
  )
  .handler(async ({ context, data }) => {
    await assertAdmin(context.database, context.userId);
    const { databaseAdmin } = await import("@/integrations/database/client.server");
    const { data: acct } = await databaseAdmin
      .from("whatsapp_accounts")
      .select("phone_number_id, token_encrypted")
      .eq("id", data.whatsapp_account_id)
      .maybeSingle();
    if (!acct?.phone_number_id || !acct?.token_encrypted)
      throw new Error("Cuenta sin credenciales");
    const version = process.env.META_GRAPH_API_VERSION ?? "v25.0";
    const to = data.to.replace(/[^\d]/g, "");
    const res = await fetch(
      `https://graph.facebook.com/${version}/${acct.phone_number_id}/messages`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${acct.token_encrypted}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          messaging_product: "whatsapp",
          to,
          type: "text",
          text: { body: data.text },
        }),
        signal: AbortSignal.timeout(Number(process.env.META_TIMEOUT_MS ?? 15_000)),
      },
    );
    const json: any = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(json?.error?.message ?? "Fallo al enviar mensaje");
    return { ok: true, message_id: json?.messages?.[0]?.id ?? null };
  });

// Re-suscribe la app de Meta al WABA del cliente. Útil cuando el webhook_subscribed
// aparece en falso o Meta perdió la suscripción. Llama a
// POST /{waba_id}/subscribed_apps con el access token guardado del cliente y
// actualiza whatsapp_accounts.webhook_subscribed según la respuesta.
export const resubscribeWabaWebhook = createServerFn({ method: "POST" })
  .middleware([requireDatabaseAuth])
  .inputValidator((input: { whatsapp_account_id: string }) =>
    z.object({ whatsapp_account_id: z.string().uuid() }).parse(input),
  )
  .handler(async ({ context, data }) => {
    await assertAdmin(context.database, context.userId);
    const { databaseAdmin } = await import("@/integrations/database/client.server");

    const { data: acct, error: acctErr } = await databaseAdmin
      .from("whatsapp_accounts")
      .select("id, client_id, waba_id, phone_number_id, token_encrypted")
      .eq("id", data.whatsapp_account_id)
      .maybeSingle();
    if (acctErr) throw new Error(acctErr.message);
    if (!acct) return { ok: false, error: { message: "Cuenta no encontrada", type: "not_found" } };
    if (!acct.waba_id)
      return {
        ok: false,
        error: { message: "La cuenta no tiene WABA ID", type: "missing_waba_id" },
      };
    if (!acct.token_encrypted)
      return {
        ok: false,
        error: { message: "La cuenta no tiene token guardado", type: "missing_token" },
      };

    const version = process.env.META_GRAPH_API_VERSION ?? "v25.0";
    const url = `https://graph.facebook.com/${version}/${acct.waba_id}/subscribed_apps`;

    let httpStatus = 0;
    let metaJson: any = null;
    let ok = false;
    let networkErr: string | null = null;

    try {
      const res = await fetch(url, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${acct.token_encrypted}`,
          "content-type": "application/json",
        },
        signal: AbortSignal.timeout(Number(process.env.META_TIMEOUT_MS ?? 15_000)),
      });
      httpStatus = res.status;
      metaJson = await res.json().catch(() => ({}));
      ok = res.ok && isMetaSubscriptionConfirmed(metaJson);
    } catch (err: any) {
      networkErr = String(err?.message ?? err).slice(0, 500);
      console.error("[resubscribeWabaWebhook] network error", networkErr);
    }

    const errorMessage = !ok
      ? (metaJson?.error?.message ?? networkErr ?? `HTTP ${httpStatus}`)
      : null;

    // Log the request/response for auditing.
    await databaseAdmin.from("meta_webhook_events").insert({
      client_id: acct.client_id,
      whatsapp_account_id: acct.id,
      phone_number_id: acct.phone_number_id,
      direction: "admin",
      event_kind: "resubscribe_waba",
      processed: ok,
      processing_error: ok ? null : errorMessage,
      raw_payload: {
        request: { url, method: "POST", waba_id: acct.waba_id },
        response: { http_status: httpStatus, body: metaJson, network_error: networkErr },
      },
      error_code: metaJson?.error?.code != null ? String(metaJson.error.code) : null,
      error_title: metaJson?.error?.type ?? (networkErr ? "network_error" : null),
      error_message: errorMessage,
      error_details: metaJson?.error ?? null,
    } as any);

    await databaseAdmin
      .from("whatsapp_accounts")
      .update({ webhook_subscribed: ok })
      .eq("id", acct.id);

    if (!ok) {
      return {
        ok: false,
        error: {
          message: errorMessage ?? "Fallo al re-suscribir",
          type: metaJson?.error?.type ?? (networkErr ? "network_error" : "meta_error"),
          code: metaJson?.error?.code ?? null,
          http_status: httpStatus || null,
          fbtrace_id: metaJson?.error?.fbtrace_id ?? null,
        },
      };
    }
    return { ok: true, webhook_subscribed: true, response: metaJson };
  });
