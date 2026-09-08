import { normalizeWaId } from "@/lib/wa-id";
import { databaseAdmin, getPool } from "@/integrations/database/client.server";
import type { MetaChangeJobV1 } from "@/lib/queue.server";
import { isRetryableHttpStatus, retryAfterMilliseconds } from "@/lib/retry-policy";
import { decryptSecret } from "@/integrations/database/secrets.server";

export class PermanentJobError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PermanentJobError";
  }
}

export class RetryableJobError extends Error {
  constructor(
    message: string,
    readonly retryAfterMs?: number,
  ) {
    super(message);
    this.name = "RetryableJobError";
  }
}

type AccountRoute = {
  account_id: string;
  client_id: string;
  n8n_enabled: boolean;
  n8n_webhook_url: string | null;
  n8n_webhook_secret: string | null;
};

type MetaMessage = {
  id?: string;
  from?: string;
  type?: string;
  text?: { body?: string };
  timestamp?: string;
};

type MetaStatusError = {
  code?: string | number;
  title?: string;
  message?: string;
  error_data?: { details?: string };
};

type MetaStatus = {
  id?: string;
  status?: string;
  recipient_id?: string;
  timestamp?: string;
  errors?: MetaStatusError[];
};

type MetaContact = { profile?: { name?: string } };

type MetaChange = {
  field?: string;
  value?: {
    metadata?: { phone_number_id?: string; display_phone_number?: string };
    messages?: MetaMessage[];
    statuses?: MetaStatus[];
    contacts?: MetaContact[];
  };
  [key: string]: unknown;
};

function first<T>(value: unknown): T | null {
  return Array.isArray(value) ? (value[0] ?? null) : null;
}

async function loadAccount(phoneNumberId: string | null): Promise<AccountRoute> {
  if (!phoneNumberId) throw new PermanentJobError("missing_phone_number_id");
  const result = await getPool().query<{
    account_id: string;
    client_id: string;
    n8n_enabled: boolean;
    n8n_webhook_url: string | null;
    n8n_webhook_secret_encrypted: string | null;
  }>(
    `SELECT wa.id AS account_id, wa.client_id, c.n8n_enabled, c.n8n_webhook_url,
            c.n8n_webhook_secret_encrypted
       FROM whatsapp_accounts wa
       JOIN clients c ON c.id = wa.client_id
      WHERE wa.phone_number_id = $1
      LIMIT 1`,
    [phoneNumberId],
  );
  const row = result.rows[0];
  if (!row) throw new PermanentJobError(`account_not_found:${phoneNumberId}`);
  return {
    account_id: row.account_id,
    client_id: row.client_id,
    n8n_enabled: row.n8n_enabled,
    n8n_webhook_url: row.n8n_webhook_url,
    n8n_webhook_secret: decryptSecret(row.n8n_webhook_secret_encrypted) as string | null,
  };
}

async function markRawEventIfFinished(rawEventId: string): Promise<void> {
  await getPool().query(
    `UPDATE raw_meta_webhook_events raw
        SET processed = true, processing_error = NULL
      WHERE raw.id = $1
        AND NOT EXISTS (
          SELECT 1 FROM webhook_jobs jobs
           WHERE jobs.raw_event_id = raw.id
             AND jobs.status <> 'completed'
        )`,
    [rawEventId],
  );
}

export async function processMetaChangeJob(job: MetaChangeJobV1): Promise<void> {
  if (job.version !== 1 || !job.change || typeof job.change !== "object") {
    throw new PermanentJobError("invalid_payload_version_or_change");
  }

  const original = job.change as MetaChange;
  const value = original.value ?? {};
  const items: Array<{ key: string; change: MetaChange }> = [];
  if (Array.isArray(value.messages)) {
    value.messages.forEach((message, index) => {
      items.push({
        key: `message:${message?.id ?? index}`,
        change: { ...original, value: { ...value, messages: [message], statuses: undefined } },
      });
    });
  }
  if (Array.isArray(value.statuses)) {
    value.statuses.forEach((status, index) => {
      items.push({
        key: `status:${status?.id ?? index}:${status?.status ?? "unknown"}`,
        change: { ...original, value: { ...value, messages: undefined, statuses: [status] } },
      });
    });
  }
  if (items.length === 0) items.push({ key: "change:0", change: original });
  for (const item of items) {
    await processSingleMetaChangeJob({ ...job, change: item.change }, item.key);
  }
}

async function processSingleMetaChangeJob(job: MetaChangeJobV1, itemKey: string): Promise<void> {
  const change = job.change as MetaChange;
  const value = change.value ?? {};
  const field: string | null = change.field ?? null;
  const phoneNumberId = value?.metadata?.phone_number_id ?? job.phoneNumberId;
  const displayPhoneNumber: string | null = value?.metadata?.display_phone_number ?? null;
  const message = first<MetaMessage>(value.messages);
  const messageStatus = first<MetaStatus>(value.statuses);
  const contact = first<MetaContact>(value.contacts);
  if (!phoneNumberId) throw new PermanentJobError("missing_phone_number_id");
  const account = await loadAccount(phoneNumberId);

  const eventKind = message ? "message" : messageStatus ? "status" : field || "unknown";
  const messageId: string | null = message?.id ?? messageStatus?.id ?? null;
  const fromWaId: string | null = message
    ? normalizeWaId(message.from ?? null) || message.from || null
    : null;
  const status: string | null = messageStatus?.status ?? null;
  const statusError = first<MetaStatusError>(messageStatus?.errors);
  const rawPayload = {
    object: job.objectType,
    entry: [{ id: job.entryId, changes: [change] }],
  };

  const existingEvent = await databaseAdmin
    .from("meta_webhook_events")
    .select("id,processed")
    .eq("webhook_job_id", job.jobId)
    .eq("webhook_item_key", itemKey)
    .maybeSingle();
  if (existingEvent.data?.processed) return;
  const isNewEvent = !existingEvent.data?.id;
  const inserted = existingEvent.data?.id
    ? { data: existingEvent.data, error: null }
    : await databaseAdmin
        .from("meta_webhook_events")
        .insert({
          webhook_job_id: job.jobId,
          webhook_item_key: itemKey,
          client_id: account.client_id,
          whatsapp_account_id: account.account_id,
          phone_number_id: phoneNumberId,
          direction: "inbound_from_meta",
          field,
          event_kind: eventKind,
          wa_message_id: messageId,
          from_wa_id: fromWaId,
          to_phone_number: displayPhoneNumber,
          message_type: message?.type ?? null,
          text_body: message?.text?.body ?? null,
          status,
          error_code: statusError?.code != null ? String(statusError.code) : null,
          error_title: statusError?.title ?? null,
          error_message: statusError?.message ?? statusError?.error_data?.details ?? null,
          error_details: statusError,
          raw_headers: job.headers,
          raw_payload: rawPayload,
          processed: false,
          processing_error: null,
        })
        .select("id")
        .single();
  if (inserted.error) throw new RetryableJobError(`event_insert_failed:${inserted.error.message}`);

  if (isNewEvent) {
    await databaseAdmin.from("webhook_events").insert({
      whatsapp_account_id: account.account_id,
      event_type: field,
      payload: rawPayload,
      processed: false,
    });
  }

  if (eventKind === "status") {
    if (messageId && status) {
      await databaseAdmin
        .from("whatsapp_send_logs")
        .update({
          meta_message_status: status,
          error_code: statusError?.code != null ? String(statusError.code) : null,
          error_message: statusError?.message ?? statusError?.error_data?.details ?? null,
          success: ["sent", "delivered", "read"].includes(status),
        })
        .eq("meta_message_id", messageId);
    }
    await databaseAdmin.from("n8n_forward_logs").insert({
      client_id: account.client_id,
      whatsapp_account_id: account.account_id,
      meta_webhook_event_id: inserted.data.id,
      phone_number_id: phoneNumberId,
      n8n_webhook_url: account.n8n_webhook_url,
      forward_attempted: false,
      n8n_enabled_value: account.n8n_enabled,
      success: true,
      error_message: `status_event_ignored:${status ?? "unknown"}`,
    });
    await databaseAdmin
      .from("meta_webhook_events")
      .update({ processed: true })
      .eq("id", inserted.data.id);
    await markRawEventIfFinished(job.rawEventId);
    return;
  }

  if (!message || eventKind !== "message" || !messageId || !fromWaId) {
    throw new PermanentJobError(`unsupported_or_incomplete_event:${eventKind}`);
  }
  if (!account.n8n_enabled) throw new PermanentJobError("n8n_disabled_for_client");
  if (!account.n8n_webhook_url) throw new PermanentJobError("n8n_webhook_url_missing");
  if (!account.n8n_webhook_secret) throw new PermanentJobError("n8n_webhook_secret_missing");

  let chatwootPaused = false;
  let chatwootNote = "chatwoot_not_run";
  try {
    const { syncInboundToChatwoot } = await import("@/lib/chatwoot-sync.server");
    const result = await syncInboundToChatwoot({
      client_id: account.client_id,
      wa_id: fromWaId,
      profile_name: contact?.profile?.name ?? null,
      wa_message_id: messageId,
      message_type: message.type ?? null,
      text: message?.text?.body ?? null,
    });
    chatwootPaused = result.synced ? result.bot_paused : false;
    chatwootNote = result.synced
      ? `chatwoot_synced:paused=${result.bot_paused}`
      : `chatwoot_${result.reason}`;
    if (!result.synced && result.reason !== "chatwoot_disabled_or_unconfigured") {
      if (result.retryable) {
        throw new RetryableJobError(chatwootNote, result.retryAfterMs);
      }
      throw new PermanentJobError(chatwootNote);
    }
  } catch (error) {
    if (error instanceof RetryableJobError || error instanceof PermanentJobError) throw error;
    chatwootNote = `chatwoot_error:${String(error).slice(0, 200)}`;
    throw new RetryableJobError(chatwootNote);
  }

  if (chatwootPaused) {
    await databaseAdmin.from("n8n_forward_logs").insert({
      client_id: account.client_id,
      whatsapp_account_id: account.account_id,
      meta_webhook_event_id: inserted.data.id,
      phone_number_id: phoneNumberId,
      n8n_webhook_url: account.n8n_webhook_url,
      forward_attempted: false,
      n8n_enabled_value: true,
      success: true,
      error_message: `chatwoot_paused (${chatwootNote})`,
    });
    await databaseAdmin
      .from("meta_webhook_events")
      .update({ processed: true })
      .eq("id", inserted.data.id);
    await markRawEventIfFinished(job.rawEventId);
    return;
  }

  const requestPayload = {
    source: "meta_whatsapp",
    client_id: account.client_id,
    whatsapp_account_id: account.account_id,
    phone_number_id: phoneNumberId,
    display_phone_number: displayPhoneNumber,
    event_kind: "message",
    from: fromWaId,
    contact_name: contact?.profile?.name ?? null,
    message_id: messageId,
    message_type: message.type ?? null,
    text: message?.text?.body ?? null,
    timestamp: message.timestamp ?? null,
    raw: rawPayload,
  };
  const attemptedAt = new Date().toISOString();
  let response: Response;
  let responseBody = "";
  try {
    response = await fetch(account.n8n_webhook_url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "X-Client-ID": account.client_id,
        "X-Phone-Number-ID": phoneNumberId,
        "X-N8N-Webhook-Secret": account.n8n_webhook_secret,
        "Idempotency-Key": `${job.jobId}:${itemKey}`,
      },
      body: JSON.stringify(requestPayload),
      signal: AbortSignal.timeout(Number(process.env.N8N_TIMEOUT_MS ?? 10_000)),
    });
    responseBody = (await response.text().catch(() => "")).slice(0, 4_000);
  } catch (error) {
    const messageText = `network_or_timeout:${String(error).slice(0, 400)}`;
    await recordForward(false, null, messageText);
    throw new RetryableJobError(messageText);
  }

  if (!response.ok) {
    const messageText = `HTTP ${response.status}: ${responseBody.slice(0, 500)}`;
    await recordForward(false, response.status, messageText, responseBody);
    if (isRetryableHttpStatus(response.status)) {
      throw new RetryableJobError(
        messageText,
        retryAfterMilliseconds(response.headers.get("retry-after")),
      );
    }
    throw new PermanentJobError(messageText);
  }

  await recordForward(true, response.status, null, responseBody);
  await databaseAdmin.from("processed_whatsapp_messages").upsert(
    {
      client_id: account.client_id,
      whatsapp_account_id: account.account_id,
      phone_number_id: phoneNumberId,
      message_id: messageId,
      from_wa_id: fromWaId,
      message_type: message.type ?? null,
      text: message?.text?.body ?? null,
      meta_timestamp: message.timestamp ?? null,
      first_seen_at: job.receivedAt,
      last_seen_at: new Date().toISOString(),
      duplicate_count: 0,
    },
    { onConflict: "message_id" },
  );
  await databaseAdmin
    .from("meta_webhook_events")
    .update({ processed: true })
    .eq("id", inserted.data.id);
  await markRawEventIfFinished(job.rawEventId);

  async function recordForward(
    success: boolean,
    responseStatus: number | null,
    errorMessage: string | null,
    body: string | null = null,
  ) {
    await databaseAdmin.from("n8n_forward_logs").insert({
      client_id: account.client_id,
      whatsapp_account_id: account.account_id,
      meta_webhook_event_id: inserted.data.id,
      phone_number_id: phoneNumberId,
      n8n_webhook_url: account.n8n_webhook_url,
      request_headers: {
        "content-type": "application/json",
        "X-Client-ID": account.client_id,
        "X-Phone-Number-ID": phoneNumberId,
        "X-N8N-Webhook-Secret": "***",
        "Idempotency-Key": `${job.jobId}:${itemKey}`,
      },
      request_payload: requestPayload,
      response_status: responseStatus,
      response_body: body,
      forward_attempted: true,
      n8n_enabled_value: true,
      success,
      error_message: errorMessage,
      attempted_at: attemptedAt,
    });
    await databaseAdmin
      .from("clients")
      .update({
        n8n_last_delivery_at: attemptedAt,
        n8n_last_delivery_status: success ? "success" : "error",
        n8n_last_delivery_error: errorMessage,
      })
      .eq("id", account.client_id);
  }
}
