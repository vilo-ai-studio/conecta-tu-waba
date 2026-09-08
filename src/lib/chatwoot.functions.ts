import { createServerFn } from "@tanstack/react-start";
import { requireDatabaseAuth } from "@/integrations/database/auth-middleware";
import { z } from "zod";

async function assertAdmin(database: any, userId: string) {
  const { data } = await database
    .from("user_roles")
    .select("role")
    .eq("user_id", userId)
    .eq("role", "admin")
    .maybeSingle();
  if (!data) throw new Error("No autorizado");
}

function normalizeBaseUrl(url: string): string {
  return url.trim().replace(/\/+$/, "");
}

// Devuelve la configuración de Chatwoot del cliente (sin exponer secretos en claro).
export const getChatwootConfig = createServerFn({ method: "GET" })
  .middleware([requireDatabaseAuth])
  .inputValidator((input: { client_id: string }) =>
    z.object({ client_id: z.string().uuid() }).parse(input),
  )
  .handler(async ({ context, data }) => {
    await assertAdmin(context.database, context.userId);
    const { databaseAdmin } = await import("@/integrations/database/client.server");
    const { data: row, error } = await databaseAdmin
      .from("client_integrations")
      .select(
        "id, client_id, chatwoot_enabled, chatwoot_base_url, chatwoot_account_id, chatwoot_inbox_id, chatwoot_api_access_token_encrypted, chatwoot_webhook_secret_encrypted, chatwoot_webhook_signature_enabled, chatwoot_bot_pause_label, chatwoot_bot_active_label, pause_on_assigned, last_test_status, last_test_error, last_test_at, last_sync_at, updated_at",
      )
      .eq("client_id", data.client_id)
      .maybeSingle();
    if (error) throw new Error(error.message);
    if (!row) {
      return {
        exists: false,
        chatwoot_enabled: false,
        chatwoot_base_url: "",
        chatwoot_account_id: "",
        chatwoot_inbox_id: "",
        has_api_token: false,
        has_webhook_secret: false,
        chatwoot_webhook_signature_enabled: true,
        chatwoot_bot_pause_label: "human",
        chatwoot_bot_active_label: "bot_on",
        pause_on_assigned: false,
        last_test_status: null as string | null,
        last_test_error: null as string | null,
        last_test_at: null as string | null,
        last_sync_at: null as string | null,
      };
    }
    return {
      exists: true,
      chatwoot_enabled: !!row.chatwoot_enabled,
      chatwoot_base_url: row.chatwoot_base_url ?? "",
      chatwoot_account_id: row.chatwoot_account_id ?? "",
      chatwoot_inbox_id: row.chatwoot_inbox_id ?? "",
      has_api_token: !!row.chatwoot_api_access_token_encrypted,
      has_webhook_secret: !!row.chatwoot_webhook_secret_encrypted,
      chatwoot_webhook_signature_enabled: (row as any).chatwoot_webhook_signature_enabled !== false,
      chatwoot_bot_pause_label: row.chatwoot_bot_pause_label ?? "human",
      chatwoot_bot_active_label: row.chatwoot_bot_active_label ?? "bot_on",
      pause_on_assigned: !!row.pause_on_assigned,
      last_test_status: row.last_test_status,
      last_test_error: row.last_test_error,
      last_test_at: row.last_test_at,
      last_sync_at: row.last_sync_at,
    };
  });

export const updateChatwootConfig = createServerFn({ method: "POST" })
  .middleware([requireDatabaseAuth])
  .inputValidator(
    (input: {
      client_id: string;
      chatwoot_enabled: boolean;
      chatwoot_base_url?: string | null;
      chatwoot_account_id?: string | null;
      chatwoot_inbox_id?: string | null;
      chatwoot_api_token?: string | null;
      chatwoot_webhook_secret?: string | null;
      chatwoot_bot_pause_label?: string;
      chatwoot_bot_active_label?: string;
      pause_on_assigned?: boolean;
      chatwoot_webhook_signature_enabled?: boolean;
      clear_webhook_secret?: boolean;
    }) =>
      z
        .object({
          client_id: z.string().uuid(),
          chatwoot_enabled: z.boolean(),
          chatwoot_base_url: z
            .string()
            .trim()
            .max(500)
            .url()
            .nullable()
            .optional()
            .or(z.literal("").transform(() => null)),
          chatwoot_account_id: z
            .string()
            .trim()
            .max(100)
            .nullable()
            .optional()
            .or(z.literal("").transform(() => null)),
          chatwoot_inbox_id: z
            .string()
            .trim()
            .max(100)
            .nullable()
            .optional()
            .or(z.literal("").transform(() => null)),
          chatwoot_api_token: z
            .string()
            .trim()
            .max(2000)
            .nullable()
            .optional()
            .or(z.literal("").transform(() => null)),
          chatwoot_webhook_secret: z
            .string()
            .trim()
            .max(1000)
            .nullable()
            .optional()
            .or(z.literal("").transform(() => null)),
          chatwoot_bot_pause_label: z.string().trim().min(1).max(100).optional(),
          chatwoot_bot_active_label: z.string().trim().min(1).max(100).optional(),
          pause_on_assigned: z.boolean().optional(),
          chatwoot_webhook_signature_enabled: z.boolean().optional(),
          clear_webhook_secret: z.boolean().optional(),
        })
        .parse(input),
  )
  .handler(async ({ context, data }) => {
    await assertAdmin(context.database, context.userId);
    const { databaseAdmin } = await import("@/integrations/database/client.server");

    const patch: Record<string, unknown> = {
      client_id: data.client_id,
      chatwoot_enabled: data.chatwoot_enabled,
      chatwoot_base_url: data.chatwoot_base_url ? normalizeBaseUrl(data.chatwoot_base_url) : null,
      chatwoot_account_id: data.chatwoot_account_id ?? null,
      chatwoot_inbox_id: data.chatwoot_inbox_id ?? null,
      chatwoot_bot_pause_label: data.chatwoot_bot_pause_label ?? "human",
      chatwoot_bot_active_label: data.chatwoot_bot_active_label ?? "bot_on",
      pause_on_assigned: data.pause_on_assigned ?? false,
    };
    if (data.chatwoot_webhook_signature_enabled !== undefined) {
      patch.chatwoot_webhook_signature_enabled = data.chatwoot_webhook_signature_enabled;
    }
    // Solo tocar secretos si vienen explícitos.
    if (data.chatwoot_api_token !== undefined) {
      patch.chatwoot_api_access_token_encrypted = data.chatwoot_api_token;
    }
    if (data.clear_webhook_secret) {
      patch.chatwoot_webhook_secret_encrypted = null;
    } else if (data.chatwoot_webhook_secret !== undefined) {
      patch.chatwoot_webhook_secret_encrypted = data.chatwoot_webhook_secret;
    }

    const { data: existing } = await databaseAdmin
      .from("client_integrations")
      .select("id")
      .eq("client_id", data.client_id)
      .maybeSingle();

    let error;
    if (existing?.id) {
      const { error: uErr } = await databaseAdmin
        .from("client_integrations")
        .update(patch as any)
        .eq("id", existing.id);
      error = uErr;
    } else {
      const { error: iErr } = await databaseAdmin
        .from("client_integrations")
        .insert(patch as any);
      error = iErr;
    }
    if (error) throw new Error(error.message);
    return { ok: true };
  });

// Prueba de conexión: llama GET /api/v1/accounts/{account_id}/inboxes/{inbox_id}
// con el api_access_token guardado. No expone el token; solo devuelve ok + detalle.
export const testChatwootConnection = createServerFn({ method: "POST" })
  .middleware([requireDatabaseAuth])
  .inputValidator((input: { client_id: string }) =>
    z.object({ client_id: z.string().uuid() }).parse(input),
  )
  .handler(async ({ context, data }) => {
    await assertAdmin(context.database, context.userId);
    const { databaseAdmin } = await import("@/integrations/database/client.server");

    const { data: cfg, error } = await databaseAdmin
      .from("client_integrations")
      .select(
        "id, chatwoot_base_url, chatwoot_account_id, chatwoot_inbox_id, chatwoot_api_access_token_encrypted",
      )
      .eq("client_id", data.client_id)
      .maybeSingle();
    if (error) throw new Error(error.message);
    if (!cfg) {
      return { ok: false, error: "Chatwoot no está configurado para este cliente." };
    }
    if (!cfg.chatwoot_base_url || !cfg.chatwoot_account_id || !cfg.chatwoot_api_access_token_encrypted) {
      return { ok: false, error: "Faltan base_url, account_id o api_access_token." };
    }

    const base = normalizeBaseUrl(cfg.chatwoot_base_url);
    const url = cfg.chatwoot_inbox_id
      ? `${base}/api/v1/accounts/${cfg.chatwoot_account_id}/inboxes/${cfg.chatwoot_inbox_id}`
      : `${base}/api/v1/accounts/${cfg.chatwoot_account_id}/inboxes`;

    let httpStatus = 0;
    let body: any = null;
    let ok = false;
    let netErr: string | null = null;
    const startedAt = Date.now();
    try {
      const res = await fetch(url, {
        method: "GET",
        headers: {
          "content-type": "application/json",
          api_access_token: cfg.chatwoot_api_access_token_encrypted,
        },
      });
      httpStatus = res.status;
      body = await res.json().catch(() => ({}));
      ok = res.ok;
    } catch (err: any) {
      netErr = String(err?.message ?? err).slice(0, 500);
    }

    const now = new Date().toISOString();
    const errMsg = !ok
      ? netErr ?? body?.message ?? body?.error ?? `HTTP ${httpStatus}`
      : null;

    await databaseAdmin.from("chatwoot_integration_logs").insert({
      client_id: data.client_id,
      event_type: "test_connection",
      direction: "outgoing",
      status: ok ? "success" : "error",
      http_status: httpStatus || null,
      request_payload: { url, method: "GET" },
      response_payload: body ?? (netErr ? { network_error: netErr } : null),
      error_message: errMsg,
    } as any);

    await databaseAdmin
      .from("client_integrations")
      .update({
        last_test_status: ok ? "success" : "error",
        last_test_error: errMsg,
        last_test_at: now,
      })
      .eq("client_id", data.client_id);

    return ok
      ? { ok: true, http_status: httpStatus, latency_ms: Date.now() - startedAt }
      : { ok: false, error: errMsg, http_status: httpStatus || null };
  });

// Detecta conversaciones/contactos duplicados para el mismo número real
// agrupando por wa_id normalizado. NO borra nada: sólo lista para revisión.
export const detectDuplicateChatwootConversations = createServerFn({ method: "GET" })
  .middleware([requireDatabaseAuth])
  .inputValidator((input: { client_id: string }) =>
    z.object({ client_id: z.string().uuid() }).parse(input),
  )
  .handler(async ({ context, data }) => {
    await assertAdmin(context.database, context.userId);
    const { databaseAdmin } = await import("@/integrations/database/client.server");
    const { normalizeWaId } = await import("@/lib/wa-id");

    const { data: rows, error } = await databaseAdmin
      .from("chatwoot_conversation_mappings")
      .select(
        "wa_id, chatwoot_conversation_id, chatwoot_contact_id, status, bot_paused, created_at",
      )
      .eq("client_id", data.client_id)
      .order("created_at", { ascending: true });
    if (error) throw new Error(error.message);

    const groups = new Map<string, any[]>();
    for (const r of rows ?? []) {
      const key = normalizeWaId(r.wa_id) || r.wa_id;
      const g = groups.get(key) ?? [];
      g.push(r);
      groups.set(key, g);
    }
    const duplicates: Array<{
      canonical_wa_id: string;
      canonical: any;
      duplicates: any[];
    }> = [];
    for (const [canonical_wa_id, list] of groups.entries()) {
      if (list.length < 2) continue;
      // Canónico = el que ya tiene wa_id igual al normalizado; fallback al primero.
      const canonical = list.find((r) => r.wa_id === canonical_wa_id) ?? list[0];
      const dups = list.filter((r) => r !== canonical);
      duplicates.push({ canonical_wa_id, canonical, duplicates: dups });

      // Log detección (una vez por grupo).
      await databaseAdmin.from("chatwoot_integration_logs").insert({
        client_id: data.client_id,
        event_type: "chatwoot_duplicate_conversation_detected",
        direction: null,
        status: "ignored",
        wa_id: canonical_wa_id,
        chatwoot_conversation_id: canonical.chatwoot_conversation_id,
        response_payload: {
          canonical_conversation_id: canonical.chatwoot_conversation_id,
          duplicate_conversation_ids: dups.map((d) => d.chatwoot_conversation_id),
          duplicate_wa_ids: dups.map((d) => d.wa_id),
        },
      } as any);
    }
    return { count: duplicates.length, groups: duplicates };
  });
