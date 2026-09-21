import { createServerFn } from "@tanstack/react-start";
import { requireDatabaseAuth } from "@/integrations/database/auth-middleware";
import { z } from "zod";
import { isMetaSubscriptionConfirmed } from "@/lib/meta-subscription";
import {
  getMetaSystemUserToken,
  metaAuthFailureMessage,
  MetaSystemUserTokenMissingError,
} from "@/lib/meta-system-user.server";

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

// Envía un mensaje de prueba de WhatsApp para un cliente dado usando el System
// User de Búho. El token nunca sale del backend y no depende de OAuth temporal
// del cliente.
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
      .select("id, phone_number_id, status")
      .eq("client_id", client.id)
      .eq("status", "connected")
      .order("connected_at", { ascending: false })
      .limit(1)
      .maybeSingle();

    if (!acct || !acct.phone_number_id) {
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

    let systemUserToken: string;
    try {
      systemUserToken = getMetaSystemUserToken();
    } catch (error) {
      const errMsg =
        error instanceof MetaSystemUserTokenMissingError
          ? error.message
          : "No se pudo cargar la credencial del System User de Meta.";
      await databaseAdmin.from("message_send_logs").insert({
        client_id: client.id,
        phone_number_id: acct.phone_number_id,
        to,
        message_preview: data.message.slice(0, 200),
        status: "error",
        error_message: errMsg,
        raw_response: null,
      });
      return { ok: false, error: { message: errMsg, type: "meta_system_token_missing" } };
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
          Authorization: `Bearer ${systemUserToken}`,
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
          message:
            metaAuthFailureMessage(httpStatus, metaJson) ??
            metaJson?.error?.message ??
            networkErr ??
            "Fallo al enviar",
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
      .select("phone_number_id")
      .eq("id", data.whatsapp_account_id)
      .maybeSingle();
    if (!acct?.phone_number_id) throw new Error("Cuenta sin número conectado");
    const systemUserToken = getMetaSystemUserToken();
    const version = process.env.META_GRAPH_API_VERSION ?? "v25.0";
    const to = data.to.replace(/[^\d]/g, "");
    const res = await fetch(
      `https://graph.facebook.com/${version}/${acct.phone_number_id}/messages`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${systemUserToken}`,
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
// POST /{waba_id}/subscribed_apps con la credencial del System User y
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
      .select("id, client_id, waba_id, phone_number_id")
      .eq("id", data.whatsapp_account_id)
      .maybeSingle();
    if (acctErr) throw new Error(acctErr.message);
    if (!acct) return { ok: false, error: { message: "Cuenta no encontrada", type: "not_found" } };
    if (!acct.waba_id)
      return {
        ok: false,
        error: { message: "La cuenta no tiene WABA ID", type: "missing_waba_id" },
      };
    let systemUserToken: string;
    try {
      systemUserToken = getMetaSystemUserToken();
    } catch (error) {
      return {
        ok: false,
        error: {
          message:
            error instanceof Error
              ? error.message
              : "Falta la credencial del System User de Meta.",
          type: "meta_system_token_missing",
        },
      };
    }

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
          Authorization: `Bearer ${systemUserToken}`,
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
      ? (metaAuthFailureMessage(httpStatus, metaJson) ?? metaJson?.error?.message ?? networkErr ?? `HTTP ${httpStatus}`)
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

// Cambia el callback alterno de un WABA hacia este router. Meta conserva este
// override aunque cambie el callback general de la aplicación, por lo que esta
// acción es necesaria para sustituir, por ejemplo, un túnel temporal de ngrok.
// El token de verificación nunca se expone al navegador.
export const redirectWabaWebhookToRouter = createServerFn({ method: "POST" })
  .middleware([requireDatabaseAuth])
  .inputValidator((input: { whatsapp_account_id: string }) =>
    z.object({ whatsapp_account_id: z.string().uuid() }).parse(input),
  )
  .handler(async ({ context, data }) => {
    await assertAdmin(context.database, context.userId);
    const { databaseAdmin } = await import("@/integrations/database/client.server");

    const { data: acct, error: acctErr } = await databaseAdmin
      .from("whatsapp_accounts")
      .select("id, client_id, waba_id, phone_number_id")
      .eq("id", data.whatsapp_account_id)
      .maybeSingle();
    if (acctErr) throw new Error(acctErr.message);
    if (!acct) return { ok: false, error: { message: "Cuenta no encontrada", type: "not_found" } };
    if (!acct.waba_id)
      return { ok: false, error: { message: "La cuenta no tiene WABA ID", type: "missing_waba_id" } };
    let systemUserToken: string;
    try {
      systemUserToken = getMetaSystemUserToken();
    } catch (error) {
      return {
        ok: false,
        error: {
          message:
            error instanceof Error
              ? error.message
              : "Falta la credencial del System User de Meta.",
          type: "meta_system_token_missing",
        },
      };
    }

    const verifyToken = process.env.WHATSAPP_VERIFY_TOKEN;
    const appUrl = process.env.APP_URL?.replace(/\/$/, "");
    if (!verifyToken)
      return {
        ok: false,
        error: { message: "Falta WHATSAPP_VERIFY_TOKEN en el servidor", type: "missing_verify_token" },
      };
    if (!appUrl)
      return { ok: false, error: { message: "Falta APP_URL en el servidor", type: "missing_app_url" } };

    let callbackUrl: string;
    try {
      const parsed = new URL(appUrl);
      if (parsed.protocol !== "https:") throw new Error("APP_URL debe usar HTTPS");
      callbackUrl = `${parsed.toString().replace(/\/$/, "")}/api/public/whatsapp/webhook`;
    } catch (error: any) {
      return {
        ok: false,
        error: { message: error?.message ?? "APP_URL inválida", type: "invalid_app_url" },
      };
    }

    const version = process.env.META_GRAPH_API_VERSION ?? "v25.0";
    const url = `https://graph.facebook.com/${version}/${acct.waba_id}/subscribed_apps`;
    let httpStatus = 0;
    let metaJson: any = null;
    let networkErr: string | null = null;

    try {
      // Meta exige que la app esté suscrita al WABA antes de permitir un override.
      const subscribeResponse = await fetch(url, {
        method: "POST",
        headers: { Authorization: `Bearer ${systemUserToken}` },
        signal: AbortSignal.timeout(Number(process.env.META_TIMEOUT_MS ?? 15_000)),
      });
      const subscribeJson = await subscribeResponse.json().catch(() => ({}));
      if (!subscribeResponse.ok || !isMetaSubscriptionConfirmed(subscribeJson)) {
        httpStatus = subscribeResponse.status;
        metaJson = subscribeJson;
        throw new Error(subscribeJson?.error?.message ?? `HTTP ${subscribeResponse.status}`);
      }

      const response = await fetch(url, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${systemUserToken}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ override_callback_uri: callbackUrl, verify_token: verifyToken }),
        signal: AbortSignal.timeout(Number(process.env.META_TIMEOUT_MS ?? 15_000)),
      });
      httpStatus = response.status;
      metaJson = await response.json().catch(() => ({}));
    } catch (error: any) {
      networkErr = String(error?.message ?? error).slice(0, 500);
      console.error("[redirectWabaWebhookToRouter] request error", networkErr);
    }

    const ok = httpStatus >= 200 && httpStatus < 300 && isMetaSubscriptionConfirmed(metaJson);
    const errorMessage = !ok
      ? (metaAuthFailureMessage(httpStatus, metaJson) ?? metaJson?.error?.message ?? networkErr ?? `HTTP ${httpStatus}`)
      : null;

    await databaseAdmin.from("meta_webhook_events").insert({
      client_id: acct.client_id,
      whatsapp_account_id: acct.id,
      phone_number_id: acct.phone_number_id,
      direction: "admin",
      event_kind: "redirect_waba_webhook_to_router",
      processed: ok,
      processing_error: errorMessage,
      raw_payload: {
        request: { url, method: "POST", waba_id: acct.waba_id, override_callback_uri: callbackUrl },
        response: { http_status: httpStatus, body: metaJson, network_error: networkErr },
      },
      error_code: metaJson?.error?.code != null ? String(metaJson.error.code) : null,
      error_title: metaJson?.error?.type ?? (networkErr ? "network_error" : null),
      error_message: errorMessage,
      error_details: metaJson?.error ?? null,
    } as any);

    if (ok) {
      await databaseAdmin
        .from("whatsapp_accounts")
        .update({ webhook_subscribed: true })
        .eq("id", acct.id);
      return { ok: true, webhook_subscribed: true, callback_url: callbackUrl };
    }

    return {
      ok: false,
      error: {
        message: errorMessage ?? "No se pudo cambiar el callback",
        type: metaJson?.error?.type ?? (networkErr ? "network_error" : "meta_error"),
        code: metaJson?.error?.code ?? null,
        http_status: httpStatus || null,
        fbtrace_id: metaJson?.error?.fbtrace_id ?? null,
      },
    };
  });

// Comprueba que el System User de Búho puede administrar el número conectado.
// No reautentica ni rota tokens: Meta exige esa acción por un administrador.
export const verifyWhatsAppAccountMetaAccess = createServerFn({ method: "POST" })
  .middleware([requireDatabaseAuth])
  .inputValidator((input: { whatsapp_account_id: string }) =>
    z.object({ whatsapp_account_id: z.string().uuid() }).parse(input),
  )
  .handler(async ({ context, data }) => {
    await assertAdmin(context.database, context.userId);
    const { databaseAdmin } = await import("@/integrations/database/client.server");
    const { data: acct, error: accountError } = await databaseAdmin
      .from("whatsapp_accounts")
      .select("id, client_id, phone_number_id")
      .eq("id", data.whatsapp_account_id)
      .maybeSingle();
    if (accountError) throw new Error(accountError.message);
    if (!acct?.phone_number_id) {
      return {
        ok: false,
        error: { message: "La cuenta no tiene un Phone Number ID conectado.", type: "missing_phone_number_id" },
      };
    }

    let systemUserToken: string;
    try {
      systemUserToken = getMetaSystemUserToken();
    } catch (error) {
      return {
        ok: false,
        error: {
          message:
            error instanceof Error
              ? error.message
              : "Falta la credencial del System User de Meta.",
          type: "meta_system_token_missing",
        },
      };
    }

    const version = process.env.META_GRAPH_API_VERSION ?? "v25.0";
    const url = `https://graph.facebook.com/${version}/${acct.phone_number_id}?fields=id,display_phone_number,verified_name`;
    let httpStatus = 0;
    let response: any = null;
    let networkError: string | null = null;
    try {
      const result = await fetch(url, {
        headers: { Authorization: `Bearer ${systemUserToken}` },
        signal: AbortSignal.timeout(Number(process.env.META_TIMEOUT_MS ?? 15_000)),
      });
      httpStatus = result.status;
      response = await result.json().catch(() => ({}));
    } catch (error: any) {
      networkError = String(error?.message ?? error).slice(0, 500);
    }

    const ok = httpStatus >= 200 && httpStatus < 300;
    const errorMessage = ok
      ? null
      : metaAuthFailureMessage(httpStatus, response) ?? response?.error?.message ?? networkError ?? `HTTP ${httpStatus}`;
    await databaseAdmin.from("meta_webhook_events").insert({
      client_id: acct.client_id,
      whatsapp_account_id: acct.id,
      phone_number_id: acct.phone_number_id,
      direction: "admin",
      event_kind: "verify_meta_system_user_access",
      processed: ok,
      processing_error: errorMessage,
      raw_payload: {
        request: { method: "GET", phone_number_id: acct.phone_number_id },
        response: { http_status: httpStatus, body: response, network_error: networkError },
      },
      error_code: response?.error?.code != null ? String(response.error.code) : null,
      error_title: response?.error?.type ?? (networkError ? "network_error" : null),
      error_message: errorMessage,
      error_details: response?.error ?? null,
    } as any);

    return ok
      ? { ok: true, account: response }
      : {
          ok: false,
          error: {
            message: errorMessage ?? "No se pudo validar el acceso de Meta.",
            type: response?.error?.type ?? (networkError ? "network_error" : "meta_error"),
            code: response?.error?.code ?? null,
            http_status: httpStatus || null,
          },
        };
  });
