import { createServerFn } from "@tanstack/react-start";
import { requireDatabaseAuth } from "@/integrations/database/auth-middleware";
import { z } from "zod";

async function assertAdmin(database: any, userId: string) {
  const { data, error } = await database
    .from("user_roles")
    .select("role")
    .eq("user_id", userId)
    .eq("role", "admin")
    .maybeSingle();
  if (error || !data) throw new Error("No autorizado. Se requiere rol admin.");
}

export const listClients = createServerFn({ method: "GET" })
  .middleware([requireDatabaseAuth])
  .handler(async ({ context }) => {
    await assertAdmin(context.database, context.userId);
    const { data, error } = await context.database
      .from("clients")
      .select(
        "id,name,email,company_name,status,n8n_enabled,created_at,whatsapp_accounts(id,status,display_phone_number,verified_name,waba_id,phone_number_id,webhook_subscribed)",
      )
      .order("created_at", { ascending: false });
    if (error) throw new Error(error.message);
    return data;
  });

export const getClient = createServerFn({ method: "GET" })
  .middleware([requireDatabaseAuth])
  .inputValidator((input: { id: string }) => z.object({ id: z.string().uuid() }).parse(input))
  .handler(async ({ context, data }) => {
    await assertAdmin(context.database, context.userId);
    const { data: client, error } = await context.database
      .from("clients")
      .select("*, whatsapp_accounts(*), onboarding_links(id,token,expires_at,used_at,created_at)")
      .eq("id", data.id)
      .maybeSingle();
    if (error) throw new Error(error.message);
    if (!client) throw new Error("Cliente no encontrado");
    return client;
  });

export const createClient = createServerFn({ method: "POST" })
  .middleware([requireDatabaseAuth])
  .inputValidator((input: { name: string; email?: string; company_name?: string }) =>
    z
      .object({
        name: z.string().trim().min(1).max(200),
        email: z
          .string()
          .trim()
          .email()
          .max(255)
          .optional()
          .or(z.literal("").transform(() => undefined)),
        company_name: z
          .string()
          .trim()
          .max(200)
          .optional()
          .or(z.literal("").transform(() => undefined)),
      })
      .parse(input),
  )
  .handler(async ({ context, data }) => {
    await assertAdmin(context.database, context.userId);
    const { data: created, error } = await context.database
      .from("clients")
      .insert({
        name: data.name,
        email: data.email ?? null,
        company_name: data.company_name ?? null,
      })
      .select()
      .single();
    if (error) throw new Error(error.message);
    return created;
  });

function makeToken() {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

export const createOnboardingLink = createServerFn({ method: "POST" })
  .middleware([requireDatabaseAuth])
  .inputValidator((input: { client_id: string; expires_in_hours?: number }) =>
    z
      .object({
        client_id: z.string().uuid(),
        expires_in_hours: z.number().int().min(1).max(720).optional(),
      })
      .parse(input),
  )
  .handler(async ({ context, data }) => {
    await assertAdmin(context.database, context.userId);
    const hours = data.expires_in_hours ?? 72;
    const expires_at = new Date(Date.now() + hours * 3_600_000).toISOString();
    const token = makeToken();
    const { data: link, error } = await context.database
      .from("onboarding_links")
      .insert({ client_id: data.client_id, token, expires_at })
      .select()
      .single();
    if (error) throw new Error(error.message);
    return link;
  });

export const deleteClient = createServerFn({ method: "POST" })
  .middleware([requireDatabaseAuth])
  .inputValidator((input: { id: string }) => z.object({ id: z.string().uuid() }).parse(input))
  .handler(async ({ context, data }) => {
    await assertAdmin(context.database, context.userId);
    const { error } = await context.database.from("clients").delete().eq("id", data.id);
    if (error) throw new Error(error.message);
    return { ok: true };
  });

// Configura la instancia de n8n de un cliente. Cada cliente puede tener su
// propia URL y secreto; si `n8n_enabled` es false o falta la URL, el webhook
// central de Meta simplemente no reenvía nada para ese cliente.
// de producción. Por ahora se almacena tal cual (mismo enfoque que
// `token_encrypted`).
export const updateClientN8n = createServerFn({ method: "POST" })
  .middleware([requireDatabaseAuth])
  .inputValidator(
    (input: {
      id: string;
      n8n_enabled: boolean;
      n8n_webhook_url?: string | null;
      n8n_webhook_secret?: string | null;
    }) =>
      z
        .object({
          id: z.string().uuid(),
          n8n_enabled: z.boolean(),
          n8n_webhook_url: z
            .string()
            .trim()
            .url()
            .max(2000)
            .nullable()
            .optional()
            .or(z.literal("").transform(() => null)),
          n8n_webhook_secret: z
            .string()
            .trim()
            .max(1000)
            .nullable()
            .optional()
            .or(z.literal("").transform(() => null)),
        })
        .parse(input),
  )
  .handler(async ({ context, data }) => {
    await assertAdmin(context.database, context.userId);
    const { databaseAdmin } = await import("@/integrations/database/client.server");
    const update: {
      n8n_enabled: boolean;
      n8n_webhook_url: string | null;
      n8n_webhook_secret_encrypted?: string | null;
    } = {
      n8n_enabled: data.n8n_enabled,
      n8n_webhook_url: data.n8n_webhook_url ?? null,
    };
    // Solo tocar el secreto si el admin envió uno explícito. Si `n8n_webhook_secret`
    // viene undefined => conservamos el anterior. Si viene "" o null => borrar.
    if (data.n8n_webhook_secret !== undefined) {
      update.n8n_webhook_secret_encrypted = data.n8n_webhook_secret;
    }
    console.log("[updateClientN8n] update", {
      id: data.id,
      ...update,
      n8n_webhook_secret_encrypted: update.n8n_webhook_secret_encrypted
        ? "***"
        : update.n8n_webhook_secret_encrypted,
    });
    const { data: updated, error } = await databaseAdmin
      .from("clients")
      .update(update)
      .eq("id", data.id)
      .select(
        "id, n8n_enabled, n8n_webhook_url, n8n_webhook_secret_encrypted, n8n_last_delivery_at, n8n_last_delivery_status, n8n_last_delivery_error",
      )
      .single();
    if (error) {
      console.error("[updateClientN8n] error", error);
      throw new Error(error.message);
    }
    return {
      id: updated.id,
      n8n_enabled: updated.n8n_enabled,
      n8n_webhook_url: updated.n8n_webhook_url,
      has_secret: !!updated.n8n_webhook_secret_encrypted,
      n8n_last_delivery_at: updated.n8n_last_delivery_at,
      n8n_last_delivery_status: updated.n8n_last_delivery_status,
      n8n_last_delivery_error: updated.n8n_last_delivery_error,
    };
  });

// Envía un evento sintético a la URL de n8n del cliente para verificar la
// configuración. Actualiza los campos n8n_last_delivery_* con el resultado.
export const sendN8nTestEvent = createServerFn({ method: "POST" })
  .middleware([requireDatabaseAuth])
  .inputValidator((input: { id: string }) => z.object({ id: z.string().uuid() }).parse(input))
  .handler(async ({ context, data }) => {
    await assertAdmin(context.database, context.userId);
    const { data: client, error } = await context.database
      .from("clients")
      .select("id, n8n_webhook_url, n8n_webhook_secret_encrypted, n8n_enabled")
      .eq("id", data.id)
      .maybeSingle();
    if (error) throw new Error(error.message);
    if (!client) throw new Error("Cliente no encontrado");
    if (!client.n8n_webhook_url) throw new Error("URL de n8n no configurada");

    const { databaseAdmin } = await import("@/integrations/database/client.server");
    const now = new Date().toISOString();
    const testPayload = {
      object: "whatsapp_business_account",
      test: true,
      client_id: client.id,
      timestamp: now,
      entry: [
        {
          id: "test",
          changes: [
            {
              field: "messages",
              value: {
                messaging_product: "whatsapp",
                metadata: { display_phone_number: "test", phone_number_id: "test" },
                messages: [
                  {
                    from: "test",
                    id: "test",
                    timestamp: `${Date.now()}`,
                    text: { body: "Evento de prueba desde el panel" },
                    type: "text",
                  },
                ],
              },
            },
          ],
        },
      ],
    };

    const requestHeaders = {
      "content-type": "application/json",
      "X-Client-ID": client.id,
      "X-Phone-Number-ID": "test",
      "X-N8N-Webhook-Secret": client.n8n_webhook_secret_encrypted ? "***" : null,
    };

    let responseStatus: number | null = null;
    let responseBody: string | null = null;
    let ok = false;
    let errMsg: string | null = null;
    try {
      const res = await fetch(client.n8n_webhook_url, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "X-Client-ID": client.id,
          "X-Phone-Number-ID": "test",
          ...(client.n8n_webhook_secret_encrypted
            ? { "X-N8N-Webhook-Secret": client.n8n_webhook_secret_encrypted }
            : {}),
        },
        body: JSON.stringify(testPayload),
        signal: AbortSignal.timeout(Number(process.env.N8N_TIMEOUT_MS ?? 10_000)),
      });
      responseStatus = res.status;
      responseBody = (await res.text().catch(() => "")).slice(0, 4000);
      ok = res.ok;
      if (!ok) errMsg = `HTTP ${res.status}: ${responseBody.slice(0, 500)}`;
    } catch (err: any) {
      errMsg = String(err?.message ?? err).slice(0, 500);
    }

    await databaseAdmin.from("n8n_forward_logs").insert({
      client_id: client.id,
      phone_number_id: "test",
      n8n_webhook_url: client.n8n_webhook_url,
      request_headers: requestHeaders,
      request_payload: testPayload,
      response_status: responseStatus,
      response_body: responseBody,
      success: ok,
      error_message: errMsg,
    });

    await databaseAdmin
      .from("clients")
      .update({
        n8n_last_delivery_at: now,
        n8n_last_delivery_status: ok ? "success" : "error",
        n8n_last_delivery_error: ok ? null : errMsg,
      })
      .eq("id", client.id);

    return ok
      ? { ok: true, status: responseStatus, response_body: responseBody }
      : { ok: false, status: responseStatus, error: errMsg, response_body: responseBody };
  });
