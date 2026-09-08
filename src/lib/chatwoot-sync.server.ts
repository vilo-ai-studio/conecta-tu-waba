// Server-only helper. Never import from client-reachable modules at top level.
// Use dynamic `await import(...)` inside route/server-fn handlers.
import { databaseAdmin } from "@/integrations/database/client.server";
import { normalizeWaId } from "@/lib/wa-id";

export type ChatwootConfig = {
  client_id: string;
  base_url: string;
  account_id: string;
  inbox_id: string;
  api_token: string;
  pause_label: string;
  pause_on_assigned: boolean;
};

function normalizeBaseUrl(url: string): string {
  return url.trim().replace(/\/+$/, "");
}

async function loadChatwootConfig(clientId: string): Promise<ChatwootConfig | null> {
  const { data, error } = await databaseAdmin
    .from("client_integrations")
    .select(
      "chatwoot_enabled, chatwoot_base_url, chatwoot_account_id, chatwoot_inbox_id, chatwoot_api_access_token_encrypted, chatwoot_bot_pause_label, pause_on_assigned",
    )
    .eq("client_id", clientId)
    .maybeSingle();
  if (error || !data) return null;
  if (!data.chatwoot_enabled) return null;
  if (
    !data.chatwoot_base_url ||
    !data.chatwoot_account_id ||
    !data.chatwoot_inbox_id ||
    !data.chatwoot_api_access_token_encrypted
  ) {
    return null;
  }
  return {
    client_id: clientId,
    base_url: normalizeBaseUrl(data.chatwoot_base_url),
    account_id: data.chatwoot_account_id,
    inbox_id: data.chatwoot_inbox_id,
    api_token: data.chatwoot_api_access_token_encrypted,
    pause_label: data.chatwoot_bot_pause_label ?? "human",
    pause_on_assigned: !!data.pause_on_assigned,
  };
}

async function cwFetch(
  cfg: ChatwootConfig,
  path: string,
  init: RequestInit = {},
): Promise<{ ok: boolean; status: number; body: any }> {
  const url = `${cfg.base_url}${path}`;
  const res = await fetch(url, {
    ...init,
    headers: {
      "content-type": "application/json",
      api_access_token: cfg.api_token,
      ...(init.headers as Record<string, string> | undefined),
    },
  });
  const body = await res.json().catch(() => ({}));
  return { ok: res.ok, status: res.status, body };
}

async function logCw(
  clientId: string,
  event_type: string,
  direction: "incoming" | "outgoing" | null,
  status: "success" | "error" | "ignored",
  extras: Record<string, any> = {},
) {
  try {
    await databaseAdmin.from("chatwoot_integration_logs").insert({
      client_id: clientId,
      event_type,
      direction,
      status,
      ...extras,
    } as any);
  } catch (err) {
    console.error("[chatwoot-sync] log insert failed", err);
  }
}

async function ensureContact(
  cfg: ChatwootConfig,
  waId: string,
  profileName: string | null,
): Promise<string | null> {
  // Try local mapping first.
  const existing = await databaseAdmin
    .from("chatwoot_contact_mappings")
    .select("chatwoot_contact_id")
    .eq("client_id", cfg.client_id)
    .eq("wa_id", waId)
    .maybeSingle();
  if (existing.data?.chatwoot_contact_id) return existing.data.chatwoot_contact_id;

  // Search by identifier in Chatwoot.
  const search = await cwFetch(
    cfg,
    `/api/v1/accounts/${cfg.account_id}/contacts/search?q=${encodeURIComponent(waId)}&include=contact_inboxes`,
  );
  let contactId: string | null = null;
  if (search.ok) {
    const payload = search.body?.payload;
    const rows: any[] = Array.isArray(payload) ? payload : Array.isArray(payload?.data) ? payload.data : [];
    const match = rows.find(
      (c) => c?.identifier === waId || c?.phone_number === `+${waId}` || c?.phone_number === waId,
    );
    if (match?.id) contactId = String(match.id);
  }

  if (!contactId) {
    const create = await cwFetch(cfg, `/api/v1/accounts/${cfg.account_id}/contacts`, {
      method: "POST",
      body: JSON.stringify({
        inbox_id: Number(cfg.inbox_id) || cfg.inbox_id,
        name: profileName || waId,
        identifier: waId,
        phone_number: `+${waId}`,
      }),
    });
    if (create.ok && create.body?.payload?.contact?.id) {
      contactId = String(create.body.payload.contact.id);
    } else if (create.body?.payload?.contact?.id) {
      contactId = String(create.body.payload.contact.id);
    } else {
      await logCw(cfg.client_id, "contact_create_failed", "outgoing", "error", {
        wa_id: waId,
        http_status: create.status,
        error_message: JSON.stringify(create.body).slice(0, 500),
      });
      return null;
    }
  }

  await databaseAdmin
    .from("chatwoot_contact_mappings")
    .upsert(
      {
        client_id: cfg.client_id,
        wa_id: waId,
        phone: `+${waId}`,
        profile_name: profileName,
        chatwoot_contact_id: contactId,
      } as any,
      { onConflict: "client_id,wa_id" },
    );
  return contactId;
}

async function ensureConversation(
  cfg: ChatwootConfig,
  waId: string,
  contactId: string,
): Promise<string | null> {
  const existing = await databaseAdmin
    .from("chatwoot_conversation_mappings")
    .select("chatwoot_conversation_id, status")
    .eq("client_id", cfg.client_id)
    .eq("wa_id", waId)
    .maybeSingle();

  if (existing.data?.chatwoot_conversation_id) {
    // If closed/resolved, we still reuse; Chatwoot reopens on new incoming message.
    await logCw(cfg.client_id, "chatwoot_conversation_mapping_reused", null, "success", {
      wa_id: waId,
      chatwoot_conversation_id: existing.data.chatwoot_conversation_id,
    });
    return existing.data.chatwoot_conversation_id;
  }

  // Try to find an existing conversation in Chatwoot for this contact + inbox.
  const list = await cwFetch(
    cfg,
    `/api/v1/accounts/${cfg.account_id}/contacts/${contactId}/conversations`,
  );
  let convId: string | null = null;
  let reusedFromChatwoot = false;
  if (list.ok) {
    const rows: any[] = list.body?.payload ?? [];
    const match = rows.find((c) => String(c?.inbox_id) === String(cfg.inbox_id));
    if (match?.id) {
      convId = String(match.id);
      reusedFromChatwoot = true;
    }
  }

  if (!convId) {
    const create = await cwFetch(cfg, `/api/v1/accounts/${cfg.account_id}/conversations`, {
      method: "POST",
      body: JSON.stringify({
        source_id: waId,
        inbox_id: Number(cfg.inbox_id) || cfg.inbox_id,
        contact_id: Number(contactId) || contactId,
      }),
    });
    if (create.ok && create.body?.id) {
      convId = String(create.body.id);
    } else {
      await logCw(cfg.client_id, "conversation_create_failed", "outgoing", "error", {
        wa_id: waId,
        chatwoot_contact_id: contactId,
        http_status: create.status,
        error_message: JSON.stringify(create.body).slice(0, 500),
      });
      return null;
    }
  }

  await databaseAdmin
    .from("chatwoot_conversation_mappings")
    .upsert(
      {
        client_id: cfg.client_id,
        wa_id: waId,
        chatwoot_contact_id: contactId,
        chatwoot_conversation_id: convId,
      } as any,
      { onConflict: "client_id,wa_id" },
    );

  // Re-read to detect if a concurrent handler beat us to creating the mapping.
  // Unique(client_id, wa_id) means the FIRST upsert wins; ours might have been
  // silently replaced by an earlier one with a different conv id. Fetch canonical.
  const canonical = await databaseAdmin
    .from("chatwoot_conversation_mappings")
    .select("chatwoot_conversation_id")
    .eq("client_id", cfg.client_id)
    .eq("wa_id", waId)
    .maybeSingle();
  const finalConvId = canonical.data?.chatwoot_conversation_id ?? convId;

  await logCw(
    cfg.client_id,
    finalConvId !== convId
      ? "chatwoot_prevented_duplicate_conversation"
      : reusedFromChatwoot
      ? "chatwoot_conversation_mapping_reused"
      : "chatwoot_conversation_mapping_created",
    null,
    "success",
    { wa_id: waId, chatwoot_conversation_id: finalConvId, response_payload: { attempted_conversation_id: convId } },
  );

  return finalConvId;
}

async function postIncomingMessage(
  cfg: ChatwootConfig,
  convId: string,
  waMessageId: string | null,
  text: string | null,
  messageType: string | null,
): Promise<{ ok: boolean; chatwoot_message_id: string | null; status: number; body: any }> {
  const payload: Record<string, any> = {
    content: text ?? `[${messageType ?? "message"}]`,
    message_type: "incoming",
    content_attributes: {
      source: "meta",
      wa_message_id: waMessageId,
      wa_message_type: messageType,
    },
  };
  if (waMessageId) payload.source_id = `wa:${waMessageId}`;
  const res = await cwFetch(
    cfg,
    `/api/v1/accounts/${cfg.account_id}/conversations/${convId}/messages`,
    { method: "POST", body: JSON.stringify(payload) },
  );
  return {
    ok: res.ok,
    status: res.status,
    body: res.body,
    chatwoot_message_id: res.body?.id ? String(res.body.id) : null,
  };
}

async function refreshConversationState(
  cfg: ChatwootConfig,
  convId: string,
  waId: string,
): Promise<{ labels: string[]; assignee_id: string | null; status: string | null }> {
  const [conv, labels] = await Promise.all([
    cwFetch(cfg, `/api/v1/accounts/${cfg.account_id}/conversations/${convId}`),
    cwFetch(cfg, `/api/v1/accounts/${cfg.account_id}/conversations/${convId}/labels`),
  ]);
  const labelList: string[] = Array.isArray(labels.body?.payload) ? labels.body.payload : [];
  const assigneeId = conv.body?.meta?.assignee?.id
    ? String(conv.body.meta.assignee.id)
    : conv.body?.assignee_id
    ? String(conv.body.assignee_id)
    : null;
  const status: string | null = conv.body?.status ?? null;

  const bot_paused =
    labelList.includes(cfg.pause_label) || (cfg.pause_on_assigned && !!assigneeId);

  await databaseAdmin
    .from("chatwoot_conversation_mappings")
    .update({
      status,
      labels: labelList as any,
      assignee_id: assigneeId,
      bot_paused,
    } as any)
    .eq("client_id", cfg.client_id)
    .eq("wa_id", waId);

  return { labels: labelList, assignee_id: assigneeId, status };
}

export type ChatwootSyncResult =
  | { synced: false; reason: string }
  | {
      synced: true;
      bot_paused: boolean;
      chatwoot_conversation_id: string;
      chatwoot_message_id: string | null;
      labels: string[];
      assignee_id: string | null;
    };

// Main entry point: sync one inbound WhatsApp message to Chatwoot.
// Never throws — errors are logged and returned as { synced: false }.
export async function syncInboundToChatwoot(params: {
  client_id: string;
  wa_id: string;
  profile_name: string | null;
  wa_message_id: string | null;
  message_type: string | null;
  text: string | null;
}): Promise<ChatwootSyncResult> {
  try {
    const cfg = await loadChatwootConfig(params.client_id);
    if (!cfg) return { synced: false, reason: "chatwoot_disabled_or_unconfigured" };

    // Canonicalize wa_id (source of truth = Meta's messages[0].from).
    const waId = normalizeWaId(params.wa_id) || params.wa_id;
    params = { ...params, wa_id: waId };

    // Anti-loop: if this wa_message_id was already mirrored, skip re-posting.
    if (params.wa_message_id) {
      const dup = await databaseAdmin
        .from("chatwoot_message_mappings")
        .select("chatwoot_message_id, chatwoot_conversation_id")
        .eq("client_id", cfg.client_id)
        .eq("inbound_message_id", params.wa_message_id)
        .maybeSingle();
      if (dup.data?.chatwoot_conversation_id) {
        const state = await refreshConversationState(cfg, dup.data.chatwoot_conversation_id, params.wa_id);
        return {
          synced: true,
          bot_paused:
            state.labels.includes(cfg.pause_label) ||
            (cfg.pause_on_assigned && !!state.assignee_id),
          chatwoot_conversation_id: dup.data.chatwoot_conversation_id,
          chatwoot_message_id: dup.data.chatwoot_message_id ?? null,
          labels: state.labels,
          assignee_id: state.assignee_id,
        };
      }
    }

    const contactId = await ensureContact(cfg, params.wa_id, params.profile_name);
    if (!contactId) return { synced: false, reason: "contact_unavailable" };

    const convId = await ensureConversation(cfg, params.wa_id, contactId);
    if (!convId) return { synced: false, reason: "conversation_unavailable" };

    const msg = await postIncomingMessage(
      cfg,
      convId,
      params.wa_message_id,
      params.text,
      params.message_type,
    );

    await databaseAdmin.from("chatwoot_message_mappings").insert({
      client_id: cfg.client_id,
      wa_id: params.wa_id,
      inbound_message_id: params.wa_message_id,
      chatwoot_message_id: msg.chatwoot_message_id,
      chatwoot_conversation_id: convId,
      direction: "incoming",
      source: "meta",
    } as any);

    await logCw(cfg.client_id, "inbound_synced", "incoming", msg.ok ? "success" : "error", {
      wa_id: params.wa_id,
      chatwoot_contact_id: contactId,
      chatwoot_conversation_id: convId,
      chatwoot_message_id: msg.chatwoot_message_id,
      wa_message_id: params.wa_message_id,
      http_status: msg.status,
      error_message: msg.ok ? null : JSON.stringify(msg.body).slice(0, 500),
    });

    // Detect reopen: if we had a resolved conversation locally and Chatwoot
    // now returns open (Chatwoot auto-reopens on new incoming message), log it.
    const priorConv = await databaseAdmin
      .from("chatwoot_conversation_mappings")
      .select("status")
      .eq("client_id", cfg.client_id)
      .eq("chatwoot_conversation_id", convId)
      .maybeSingle();
    const wasResolved = priorConv.data?.status === "resolved";

    const state = await refreshConversationState(cfg, convId, params.wa_id);
    const bot_paused =
      state.labels.includes(cfg.pause_label) ||
      (cfg.pause_on_assigned && !!state.assignee_id);

    if (wasResolved && state.status && state.status !== "resolved") {
      await logCw(cfg.client_id, "conversation_reopened_by_inbound", "incoming", "success", {
        wa_id: params.wa_id,
        chatwoot_conversation_id: convId,
        response_payload: { previous_status: "resolved", current_status: state.status },
      });
    }

    await databaseAdmin
      .from("client_integrations")
      .update({ last_sync_at: new Date().toISOString() })
      .eq("client_id", cfg.client_id);

    return {
      synced: true,
      bot_paused,
      chatwoot_conversation_id: convId,
      chatwoot_message_id: msg.chatwoot_message_id,
      labels: state.labels,
      assignee_id: state.assignee_id,
    };
  } catch (err: any) {
    console.error("[chatwoot-sync] error", err);
    await logCw(params.client_id, "inbound_sync_error", "incoming", "error", {
      wa_id: params.wa_id,
      wa_message_id: params.wa_message_id,
      error_message: String(err?.message ?? err).slice(0, 500),
    });
    return { synced: false, reason: "exception" };
  }
}

// Post an outgoing message ALREADY sent through Meta into Chatwoot so the
// human agent sees it in the conversation timeline. Marks source=bot to
// prevent the agent webhook from re-sending it back to Meta.
export type ChatwootMirrorResult =
  | { mirrored: false; reason: string }
  | { mirrored: true; chatwoot_conversation_id: string; chatwoot_message_id: string | null };

export async function mirrorOutboundToChatwoot(params: {
  client_id: string;
  wa_id: string; // destination phone (digits only)
  meta_message_id: string | null;
  text: string | null;
  message_type: string | null; // "text" | "template" | ...
  source: "bot" | "meta_api" | "n8n"; // origin of the outbound
  inbound_message_id: string | null; // triggering inbound (for traceability)
}): Promise<ChatwootMirrorResult> {
  try {
    const cfg = await loadChatwootConfig(params.client_id);
    if (!cfg) return { mirrored: false, reason: "chatwoot_disabled_or_unconfigured" };

    // Canonicalize wa_id.
    const waId = normalizeWaId(params.wa_id) || params.wa_id;
    params = { ...params, wa_id: waId };

    // Anti-loop: if this meta_message_id was already mirrored, skip.
    if (params.meta_message_id) {
      const dup = await databaseAdmin
        .from("chatwoot_message_mappings")
        .select("id, chatwoot_conversation_id, chatwoot_message_id")
        .eq("client_id", cfg.client_id)
        .eq("outbound_message_id", params.meta_message_id)
        .maybeSingle();
      if (dup.data?.id) {
        return {
          mirrored: true,
          chatwoot_conversation_id: dup.data.chatwoot_conversation_id ?? "",
          chatwoot_message_id: dup.data.chatwoot_message_id ?? null,
        };
      }
    }

    // Resolve target conversation via existing mapping (never create a new
    // conversation from "to" alone if we can avoid it).
    // 1) Try mapping by (client_id, wa_id).
    // 2) If missing, try to resolve via the triggering inbound message.
    let convMap = await databaseAdmin
      .from("chatwoot_conversation_mappings")
      .select("chatwoot_conversation_id, chatwoot_contact_id, wa_id")
      .eq("client_id", cfg.client_id)
      .eq("wa_id", waId)
      .maybeSingle();

    let resolvedFromInbound = false;
    if (!convMap.data?.chatwoot_conversation_id && params.inbound_message_id) {
      const { data: inboundMap } = await databaseAdmin
        .from("chatwoot_message_mappings")
        .select("chatwoot_conversation_id, wa_id")
        .eq("client_id", cfg.client_id)
        .eq("inbound_message_id", params.inbound_message_id)
        .maybeSingle();
      if (inboundMap?.chatwoot_conversation_id) {
        await logCw(cfg.client_id, "chatwoot_outgoing_mirrored_to_existing_conversation", "outgoing", "success", {
          wa_id: waId,
          chatwoot_conversation_id: inboundMap.chatwoot_conversation_id,
          response_payload: { resolved_via: "inbound_message_id", inbound_wa_id: inboundMap.wa_id },
        });
        convMap = {
          data: {
            chatwoot_conversation_id: inboundMap.chatwoot_conversation_id,
            chatwoot_contact_id: null,
            wa_id: inboundMap.wa_id,
          },
          error: null,
        } as any;
        resolvedFromInbound = true;
      }
    }

    let convId = convMap.data?.chatwoot_conversation_id ?? null;
    if (!convId) {
      await logCw(cfg.client_id, "chatwoot_mapping_missing", "outgoing", "ignored", {
        wa_id: waId,
        wa_message_id: params.meta_message_id,
        response_payload: { inbound_message_id: params.inbound_message_id },
      });
      const contactId = await ensureContact(cfg, waId, null);
      if (!contactId) return { mirrored: false, reason: "contact_unavailable" };
      convId = await ensureConversation(cfg, waId, contactId);
    } else if (!resolvedFromInbound) {
      await logCw(cfg.client_id, "chatwoot_outgoing_mirrored_to_existing_conversation", "outgoing", "success", {
        wa_id: waId,
        chatwoot_conversation_id: convId,
      });
    }
    if (!convId) return { mirrored: false, reason: "conversation_unavailable" };

    const payload: Record<string, any> = {
      content: params.text ?? `[${params.message_type ?? "message"}]`,
      message_type: "outgoing",
      private: false,
      content_attributes: {
        source: params.source, // "bot" | "meta_api"
        wa_message_id: params.meta_message_id,
        wa_message_type: params.message_type,
        inbound_message_id: params.inbound_message_id,
      },
    };
    if (params.meta_message_id) payload.source_id = `wa:${params.meta_message_id}`;

    const res = await cwFetch(
      cfg,
      `/api/v1/accounts/${cfg.account_id}/conversations/${convId}/messages`,
      { method: "POST", body: JSON.stringify(payload) },
    );
    const chatwootMessageId = res.body?.id ? String(res.body.id) : null;

    await databaseAdmin.from("chatwoot_message_mappings").insert({
      client_id: cfg.client_id,
      wa_id: params.wa_id,
      outbound_message_id: params.meta_message_id,
      inbound_message_id: params.inbound_message_id,
      chatwoot_message_id: chatwootMessageId,
      chatwoot_conversation_id: convId,
      direction: "outgoing",
      source: params.source,
    } as any);

    await logCw(cfg.client_id, "outbound_mirrored", "outgoing", res.ok ? "success" : "error", {
      wa_id: params.wa_id,
      chatwoot_conversation_id: convId,
      chatwoot_message_id: chatwootMessageId,
      wa_message_id: params.meta_message_id,
      http_status: res.status,
      error_message: res.ok ? null : JSON.stringify(res.body).slice(0, 500),
    });

    return { mirrored: true, chatwoot_conversation_id: convId, chatwoot_message_id: chatwootMessageId };
  } catch (err: any) {
    console.error("[chatwoot-sync] mirror error", err);
    await logCw(params.client_id, "outbound_mirror_error", "outgoing", "error", {
      wa_id: params.wa_id,
      wa_message_id: params.meta_message_id,
      error_message: String(err?.message ?? err).slice(0, 500),
    });
    return { mirrored: false, reason: "exception" };
  }
}

// Loader for the Chatwoot agent webhook: identifies which client an incoming
// Chatwoot event belongs to by (account_id, inbox_id) and returns the config
// plus decrypted webhook secret for HMAC verification. Returns null when no
// match — the webhook route should respond 200 and ignore.
export async function loadChatwootConfigForWebhook(
  chatwootAccountId: string,
  chatwootInboxId: string,
): Promise<(ChatwootConfig & { webhook_secret: string | null; signature_enabled: boolean }) | null> {
  const { data, error } = await databaseAdmin
    .from("client_integrations")
    .select(
      "client_id, chatwoot_enabled, chatwoot_base_url, chatwoot_account_id, chatwoot_inbox_id, chatwoot_api_access_token_encrypted, chatwoot_webhook_secret_encrypted, chatwoot_webhook_signature_enabled, chatwoot_bot_pause_label, pause_on_assigned",
    )
    .eq("chatwoot_account_id", chatwootAccountId)
    .eq("chatwoot_inbox_id", chatwootInboxId)
    .eq("chatwoot_enabled", true)
    .maybeSingle();
  if (error || !data) return null;
  if (
    !data.chatwoot_base_url ||
    !data.chatwoot_api_access_token_encrypted
  ) return null;
  return {
    client_id: data.client_id,
    base_url: normalizeBaseUrl(data.chatwoot_base_url),
    account_id: data.chatwoot_account_id!,
    inbox_id: data.chatwoot_inbox_id!,
    api_token: data.chatwoot_api_access_token_encrypted,
    pause_label: data.chatwoot_bot_pause_label ?? "human",
    pause_on_assigned: !!data.pause_on_assigned,
    webhook_secret: data.chatwoot_webhook_secret_encrypted ?? null,
    signature_enabled: (data as any).chatwoot_webhook_signature_enabled !== false,
  };
}

// Look up an existing wa_id for a given Chatwoot conversation to route an
// agent message back to Meta.
export async function lookupWaIdForConversation(
  clientId: string,
  chatwootConversationId: string,
): Promise<string | null> {
  const { data } = await databaseAdmin
    .from("chatwoot_conversation_mappings")
    .select("wa_id")
    .eq("client_id", clientId)
    .eq("chatwoot_conversation_id", chatwootConversationId)
    .maybeSingle();
  return data?.wa_id ?? null;
}

// Anti-loop check: did we (bot / meta) already mirror this Chatwoot message?
export async function chatwootMessageAlreadyMirrored(
  clientId: string,
  chatwootMessageId: string,
): Promise<boolean> {
  const { data } = await databaseAdmin
    .from("chatwoot_message_mappings")
    .select("id")
    .eq("client_id", clientId)
    .eq("chatwoot_message_id", chatwootMessageId)
    .maybeSingle();
  return !!data?.id;
}

export async function recordChatwootAgentSend(params: {
  client_id: string;
  wa_id: string;
  chatwoot_message_id: string;
  chatwoot_conversation_id: string;
  meta_message_id: string | null;
}) {
  // The webhook reserves a row keyed on (client_id, chatwoot_message_id) BEFORE
  // calling Meta. Now that we have the meta_message_id, update it in place.
  const upd = await databaseAdmin
    .from("chatwoot_message_mappings")
    .update({
      outbound_message_id: params.meta_message_id,
      chatwoot_conversation_id: params.chatwoot_conversation_id,
      direction: "outgoing",
      source: "chatwoot_agent",
    } as any)
    .eq("client_id", params.client_id)
    .eq("chatwoot_message_id", params.chatwoot_message_id)
    .select("id")
    .maybeSingle();

  if (!upd.data?.id) {
    // No reservation existed (e.g. race edge case) — insert fresh.
    await databaseAdmin.from("chatwoot_message_mappings").insert({
      client_id: params.client_id,
      wa_id: params.wa_id,
      outbound_message_id: params.meta_message_id,
      chatwoot_message_id: params.chatwoot_message_id,
      chatwoot_conversation_id: params.chatwoot_conversation_id,
      direction: "outgoing",
      source: "chatwoot_agent",
    } as any);
  }
}

export async function logChatwootEvent(
  clientId: string,
  event_type: string,
  direction: "incoming" | "outgoing" | null,
  status: "success" | "error" | "ignored",
  extras: Record<string, any> = {},
) {
  await logCw(clientId, event_type, direction, status, extras);
}

// ---------- Conversation-state webhook handling ----------

// Apply a conversation_updated / labels-changed event from Chatwoot to the
// local mapping. Idempotent: safe to call multiple times.
export async function applyChatwootConversationState(params: {
  client_id: string;
  chatwoot_conversation_id: string;
  labels: string[] | null;
  status: string | null;
  assignee_id: string | null;
  pause_label: string;
  pause_on_assigned: boolean;
}): Promise<{
  bot_paused: boolean;
  previous_bot_paused: boolean | null;
  wa_id: string | null;
}> {
  const prior = await databaseAdmin
    .from("chatwoot_conversation_mappings")
    .select("wa_id, bot_paused, labels, status")
    .eq("client_id", params.client_id)
    .eq("chatwoot_conversation_id", params.chatwoot_conversation_id)
    .maybeSingle();

  const labels: string[] = Array.isArray(params.labels)
    ? params.labels
    : Array.isArray(prior.data?.labels)
    ? ((prior.data?.labels as any[]).filter((x) => typeof x === "string") as string[])
    : [];
  const bot_paused =
    labels.includes(params.pause_label) ||
    (params.pause_on_assigned && !!params.assignee_id);

  const patch: Record<string, any> = { bot_paused, labels };
  if (params.status != null) patch.status = params.status;
  if (params.assignee_id !== undefined) patch.assignee_id = params.assignee_id;

  if (prior.data?.wa_id) {
    await databaseAdmin
      .from("chatwoot_conversation_mappings")
      .update(patch as any)
      .eq("client_id", params.client_id)
      .eq("chatwoot_conversation_id", params.chatwoot_conversation_id);
  }

  return {
    bot_paused,
    previous_bot_paused: prior.data?.bot_paused ?? null,
    wa_id: prior.data?.wa_id ?? null,
  };
}

// ---------- Rate limiting (ad-hoc) ----------
// Counts recent chatwoot_integration_logs rows for a client to throttle abuse.
// Not distributed-perfect (per-worker); good enough to isolate one noisy tenant.

export type RateLimitDecision =
  | { allowed: true }
  | { allowed: false; reason: "rate_limited" | "chatwoot_unhealthy"; retry_after_ms: number };

const DEFAULT_WINDOW_MS = 60_000;
const DEFAULT_MAX_EVENTS = 120; // events per client per minute
const UNHEALTHY_ERROR_THRESHOLD = 20; // consecutive-ish errors in window
const UNHEALTHY_COOLDOWN_MS = 5 * 60_000;

export async function checkChatwootRateLimit(
  clientId: string,
  opts?: { window_ms?: number; max_events?: number },
): Promise<RateLimitDecision> {
  const windowMs = opts?.window_ms ?? DEFAULT_WINDOW_MS;
  const maxEvents = opts?.max_events ?? DEFAULT_MAX_EVENTS;

  // Unhealthy short-circuit.
  const { data: ci } = await databaseAdmin
    .from("client_integrations")
    .select("chatwoot_unhealthy, chatwoot_unhealthy_since")
    .eq("client_id", clientId)
    .maybeSingle();
  if (ci?.chatwoot_unhealthy && ci.chatwoot_unhealthy_since) {
    const since = new Date(ci.chatwoot_unhealthy_since).getTime();
    const elapsed = Date.now() - since;
    if (elapsed < UNHEALTHY_COOLDOWN_MS) {
      return {
        allowed: false,
        reason: "chatwoot_unhealthy",
        retry_after_ms: UNHEALTHY_COOLDOWN_MS - elapsed,
      };
    }
    // Cooldown elapsed — clear the flag so traffic can resume.
    await databaseAdmin
      .from("client_integrations")
      .update({
        chatwoot_unhealthy: false,
        chatwoot_unhealthy_reason: null,
        chatwoot_unhealthy_since: null,
      } as any)
      .eq("client_id", clientId);
  }

  const since = new Date(Date.now() - windowMs).toISOString();
  const { count, error } = await databaseAdmin
    .from("chatwoot_integration_logs")
    .select("id", { head: true, count: "exact" })
    .eq("client_id", clientId)
    .gte("created_at", since);
  if (error) return { allowed: true }; // fail-open; do not block on our own errors

  if ((count ?? 0) >= maxEvents) {
    await markChatwootUnhealthy(clientId, "rate_limited");
    return { allowed: false, reason: "rate_limited", retry_after_ms: windowMs };
  }

  // Health check: too many recent errors → mark unhealthy proactively.
  const { count: errCount } = await databaseAdmin
    .from("chatwoot_integration_logs")
    .select("id", { head: true, count: "exact" })
    .eq("client_id", clientId)
    .eq("status", "error")
    .gte("created_at", since);
  if ((errCount ?? 0) >= UNHEALTHY_ERROR_THRESHOLD) {
    await markChatwootUnhealthy(clientId, "chatwoot_errors");
    return {
      allowed: false,
      reason: "chatwoot_unhealthy",
      retry_after_ms: UNHEALTHY_COOLDOWN_MS,
    };
  }

  return { allowed: true };
}

export async function markChatwootUnhealthy(clientId: string, reason: string) {
  await databaseAdmin
    .from("client_integrations")
    .update({
      chatwoot_unhealthy: true,
      chatwoot_unhealthy_reason: reason,
      chatwoot_unhealthy_since: new Date().toISOString(),
    } as any)
    .eq("client_id", clientId);
}
