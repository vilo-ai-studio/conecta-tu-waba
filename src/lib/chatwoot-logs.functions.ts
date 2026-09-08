import { createServerFn } from "@tanstack/react-start";
import { requireDatabaseAuth } from "@/integrations/database/auth-middleware";
import { z } from "zod";

const SENSITIVE_KEYS = new Set([
  "api_access_token",
  "authorization",
  "Authorization",
  "x-chatwoot-signature",
  "X-Chatwoot-Signature",
  "chatwoot_api_access_token_encrypted",
  "chatwoot_webhook_secret_encrypted",
  "token",
  "token_encrypted",
  "access_token",
  "bearer",
]);

function sanitize(value: any): any {
  if (value == null) return value;
  if (Array.isArray(value)) return value.map(sanitize);
  if (typeof value === "object") {
    const out: Record<string, any> = {};
    for (const [k, v] of Object.entries(value as Record<string, any>)) {
      if (SENSITIVE_KEYS.has(k) || SENSITIVE_KEYS.has(k.toLowerCase())) {
        out[k] = "[redacted]";
      } else {
        out[k] = sanitize(v);
      }
    }
    return out;
  }
  return value;
}

const EVENT_GROUPS: Record<string, string[]> = {
  all: [],
  inbound: ["inbound_synced", "chatwoot_inbound_synced", "inbound_sync_error"],
  outbound: [
    "outbound_mirrored",
    "chatwoot_outbound_mirrored",
    "outbound_mirror_error",
    "chatwoot_outgoing_mirrored_to_existing_conversation",
    "chatwoot_mapping_missing",
    "chatwoot_conversation_mapping_reused",
    "chatwoot_conversation_mapping_created",
    "chatwoot_prevented_duplicate_conversation",
  ],
  agent: [
    "agent_message_sent",
    "meta_agent_message_sent",
    "meta_send_error",
    "chatwoot_agent_outgoing_received",
  ],
  ignored: [
    "webhook_ignored_bot_mirror",
    "webhook_ignored_not_outgoing",
    "webhook_ignored_non_agent",
    "webhook_duplicate",
    "chatwoot_duplicate_message_ignored",
    "chatwoot_ignored_source_n8n",
    "webhook_no_wa_id",
    "webhook_no_meta_account",
    "rate_limited",
  ],
  errors: [
    "inbound_sync_error",
    "outbound_mirror_error",
    "meta_send_error",
    "webhook_invalid_signature",
    "webhook_signature_error",
    "conversation_create_failed",
    "contact_create_failed",
  ],
};

export const listChatwootLogs = createServerFn({ method: "GET" })
  .middleware([requireDatabaseAuth])
  .inputValidator((input: { client_id: string; group?: string; limit?: number }) =>
    z
      .object({
        client_id: z.string().uuid(),
        group: z.string().optional(),
        limit: z.number().int().min(1).max(500).optional(),
      })
      .parse(input),
  )
  .handler(async ({ context, data }) => {
    // Admin-only, matching other diagnostic surfaces.
    const { data: role } = await context.database
      .from("user_roles")
      .select("role")
      .eq("user_id", context.userId)
      .eq("role", "admin")
      .maybeSingle();
    if (!role) throw new Error("No autorizado");

    const { databaseAdmin } = await import("@/integrations/database/client.server");
    let q = databaseAdmin
      .from("chatwoot_integration_logs")
      .select(
        "id, created_at, event_type, direction, status, wa_id, chatwoot_contact_id, chatwoot_conversation_id, chatwoot_message_id, http_status, error_message, request_payload, response_payload",
      )
      .eq("client_id", data.client_id)
      .order("created_at", { ascending: false })
      .limit(data.limit ?? 200);

    const group = data.group ?? "all";
    const eventTypes = EVENT_GROUPS[group] ?? [];
    if (group !== "all" && eventTypes.length > 0) {
      q = q.in("event_type", eventTypes);
    }

    const { data: rows, error } = await q;
    if (error) throw new Error(error.message);

    return (rows ?? []).map((r: Record<string, any>) => ({
      ...r,
      request_payload: sanitize(r.request_payload),
      response_payload: sanitize(r.response_payload),
      error_message: r.error_message
        ? String(r.error_message).replace(/Bearer\s+[A-Za-z0-9._-]+/gi, "Bearer [redacted]")
        : null,
    }));
  });
