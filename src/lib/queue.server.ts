import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { Queue } from "bullmq";
import IORedis from "ioredis";
import { getPool, withTransaction } from "@/integrations/database/client.server";

export const META_QUEUE_NAME = "meta-webhook-changes";
export const WORKER_HEARTBEAT_KEY = "conecta:worker:heartbeat";

export type MetaChangeJobV1 = {
  version: 1;
  jobId: string;
  rawEventId: string;
  receivedAt: string;
  phoneNumberId: string | null;
  wabaId: string | null;
  objectType: string | null;
  entryId: string | null;
  change: unknown;
  headers: Record<string, string>;
};

type MetaWebhookChange = {
  field?: string;
  value?: {
    metadata?: { phone_number_id?: string };
    messages?: Array<{ id?: string; from?: string; timestamp?: string }>;
    statuses?: Array<{
      id?: string;
      status?: string;
      recipient_id?: string;
      timestamp?: string;
    }>;
  };
  [key: string]: unknown;
};

type MetaWebhookEntry = {
  id?: string;
  changes?: MetaWebhookChange[];
};

type MetaWebhookBody = {
  object?: string;
  entry?: MetaWebhookEntry[];
};

let redis: IORedis | undefined;
let metaQueue: Queue<MetaChangeJobV1> | undefined;

export function getRedis(): IORedis {
  if (!redis) {
    redis = new IORedis(process.env.REDIS_URL ?? "redis://127.0.0.1:6379", {
      maxRetriesPerRequest: null,
      enableReadyCheck: true,
      lazyConnect: true,
    });
    redis.on("error", (error) => console.error("[redis]", error.message));
  }
  return redis;
}

export function getMetaQueue(): Queue<MetaChangeJobV1> {
  if (!metaQueue) {
    metaQueue = new Queue<MetaChangeJobV1>(META_QUEUE_NAME, { connection: getRedis() });
  }
  return metaQueue;
}

export function safeRequestHeaders(headers: Headers): Record<string, string> {
  const result: Record<string, string> = {};
  headers.forEach((value, key) => {
    const lower = key.toLowerCase();
    if (
      lower === "authorization" ||
      lower === "cookie" ||
      lower.includes("token") ||
      lower.includes("secret") ||
      lower === "x-hub-signature-256"
    ) {
      return;
    }
    result[key] = value;
  });
  return result;
}

export function verifyMetaSignature(rawBody: string, signature: string | null): boolean {
  const secret = process.env.META_APP_SECRET;
  if (!secret || !signature?.startsWith("sha256=")) return false;
  const providedHex = signature.slice("sha256=".length);
  if (!/^[a-f0-9]{64}$/i.test(providedHex)) return false;
  const expected = createHmac("sha256", secret).update(rawBody).digest();
  const provided = Buffer.from(providedHex, "hex");
  return expected.length === provided.length && timingSafeEqual(expected, provided);
}

function jobDeduplicationKey(entryId: string | null, change: MetaWebhookChange): string {
  const value = change?.value ?? {};
  const messageIds = Array.isArray(value.messages)
    ? value.messages.map((message) => message?.id).filter(Boolean)
    : [];
  if (messageIds.length === 1) return `message:${messageIds[0]}`;
  if (messageIds.length > 1)
    return `messages:${createHash("sha256").update(messageIds.sort().join(",")).digest("hex")}`;
  const statuses = Array.isArray(value.statuses) ? value.statuses : [];
  const statusIds = statuses.map((status) => `${status?.id ?? ""}:${status?.status ?? "unknown"}`);
  if (statusIds.length === 1 && statuses[0]?.id) return `status:${statusIds[0]}`;
  if (statusIds.length > 1)
    return `statuses:${createHash("sha256").update(statusIds.sort().join(",")).digest("hex")}`;
  const message = Array.isArray(value.messages) ? value.messages[0] : null;
  const status = statuses[0] ?? null;
  return `change:${createHash("sha256")
    .update(
      JSON.stringify({
        account: entryId,
        field: change?.field ?? null,
        status: status?.status ?? null,
        recipient: status?.recipient_id ?? message?.from ?? null,
        timestamp: status?.timestamp ?? message?.timestamp ?? null,
        phoneNumberId: value?.metadata?.phone_number_id ?? null,
      }),
    )
    .digest("hex")}`;
}

function queueOptions(maxAttempts: number) {
  return {
    attempts: maxAttempts,
    backoff: { type: "conecta" },
    removeOnComplete: { age: 86_400, count: 1_000 },
    removeOnFail: false,
  } as const;
}

async function publishJob(job: MetaChangeJobV1, maxAttempts: number): Promise<void> {
  await getMetaQueue().add("meta.change.process", job, {
    ...queueOptions(maxAttempts),
    jobId: job.jobId,
  });
  await getPool().query(
    `UPDATE webhook_jobs
        SET status = 'queued', queued_at = now(), locked_by = NULL, last_error = NULL
      WHERE id = $1 AND status IN ('pending', 'queued')`,
    [job.jobId],
  );
}

async function publishJobBestEffort(
  job: MetaChangeJobV1,
  maxAttempts: number,
  timeoutMs = 500,
): Promise<void> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      publishJob(job, maxAttempts),
      new Promise<never>((_, reject) => {
        timeout = setTimeout(() => reject(new Error("redis_publish_timeout")), timeoutMs);
      }),
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

export async function republishStoredJob(jobId: string): Promise<void> {
  const result = await getPool().query<{
    payload: MetaChangeJobV1;
    max_attempts: number;
  }>("SELECT payload, max_attempts FROM webhook_jobs WHERE id = $1", [jobId]);
  const stored = result.rows[0];
  if (!stored) throw new Error("Trabajo no encontrado");
  const existing = await getMetaQueue().getJob(jobId);
  if (existing) await existing.remove();
  await publishJob(stored.payload, stored.max_attempts);
}

export async function persistAndEnqueueMetaWebhook(input: {
  rawBody: string;
  parsedBody: unknown;
  requestUrl: string;
  headers: Record<string, string>;
  queryParams: Record<string, string>;
}): Promise<{ rawEventId: string; accepted: number; duplicate: number; queued: number }> {
  const receivedAt = new Date().toISOString();
  const maxAttempts = Number(process.env.QUEUE_MAX_ATTEMPTS ?? 8);
  const body = (input.parsedBody ?? {}) as MetaWebhookBody;
  const entries = Array.isArray(body.entry) ? body.entry : [];
  const changes = entries.flatMap((entry) =>
    (Array.isArray(entry.changes) ? entry.changes : []).map((change) => ({ entry, change })),
  );
  const detectedPhoneId =
    changes.map(({ change }) => change.value?.metadata?.phone_number_id).find(Boolean) ?? null;

  const transactionResult = await withTransaction(async (client) => {
    const rawResult = await client.query<{ id: string }>(
      `INSERT INTO raw_meta_webhook_events
        (method, url, query_params, headers, body_raw, body_json, phone_number_id, object_type, is_meta_test, processing_error, processed)
       VALUES ('POST', $1, $2, $3, $4, $5, $6, $7, false, NULL, false)
       RETURNING id`,
      [
        input.requestUrl,
        input.queryParams,
        input.headers,
        input.rawBody,
        input.parsedBody,
        detectedPhoneId,
        body.object ?? null,
      ],
    );
    const rawEventId = rawResult.rows[0].id;
    const jobs: Array<{ payload: MetaChangeJobV1; maxAttempts: number }> = [];
    let duplicate = 0;

    for (const { entry, change } of changes) {
      const phoneNumberId = change?.value?.metadata?.phone_number_id ?? null;
      const accountResult = phoneNumberId
        ? await client.query<{ client_id: string; waba_id: string | null }>(
            "SELECT client_id, waba_id FROM whatsapp_accounts WHERE phone_number_id = $1 LIMIT 1",
            [phoneNumberId],
          )
        : { rows: [] as Array<{ client_id: string; waba_id: string | null }> };
      const idResult = await client.query<{ id: string }>("SELECT gen_random_uuid() AS id");
      const jobId = idResult.rows[0].id;
      const payload: MetaChangeJobV1 = {
        version: 1,
        jobId,
        rawEventId,
        receivedAt,
        phoneNumberId,
        wabaId: accountResult.rows[0]?.waba_id ?? entry?.id ?? null,
        objectType: body.object ?? null,
        entryId: entry?.id ?? null,
        change,
        headers: input.headers,
      };
      const inserted = await client.query<{ id: string }>(
        `INSERT INTO webhook_jobs
          (id, raw_event_id, client_id, job_type, payload_version, payload, deduplication_key, max_attempts)
         VALUES ($1, $2, $3, 'meta.change.process', 1, $4, $5, $6)
         ON CONFLICT (deduplication_key) DO NOTHING
         RETURNING id`,
        [
          jobId,
          rawEventId,
          accountResult.rows[0]?.client_id ?? null,
          payload,
          jobDeduplicationKey(entry?.id ?? null, change),
          maxAttempts,
        ],
      );
      if (inserted.rows[0]) jobs.push({ payload, maxAttempts });
      else duplicate += 1;
    }

    if (changes.length === 0 || jobs.length === 0) {
      await client.query(
        "UPDATE raw_meta_webhook_events SET processed = true, processing_error = $2 WHERE id = $1",
        [rawEventId, changes.length === 0 ? "payload_without_changes" : null],
      );
    }
    return { rawEventId, jobs, duplicate };
  });

  let queued = 0;
  const publishResults = await Promise.allSettled(
    transactionResult.jobs.map((job) => publishJobBestEffort(job.payload, job.maxAttempts)),
  );
  for (const result of publishResults) {
    if (result.status === "fulfilled") queued += 1;
    else console.error("[queue] publish deferred to reconciler", result.reason);
  }
  return {
    rawEventId: transactionResult.rawEventId,
    accepted: transactionResult.jobs.length,
    duplicate: transactionResult.duplicate,
    queued,
  };
}

export async function reconcilePendingJobs(limit = 100): Promise<number> {
  const lockToken = crypto.randomUUID();
  const lockKey = "conecta:reconciler:lock";
  const acquired = await getRedis().set(lockKey, lockToken, "EX", 10, "NX");
  if (acquired !== "OK") return 0;
  try {
    const claimed = await withTransaction(async (client) => {
      const result = await client.query<{
        id: string;
        payload: MetaChangeJobV1;
        max_attempts: number;
      }>(
        `SELECT id, payload, max_attempts
         FROM webhook_jobs
        WHERE status IN ('pending', 'queued') AND available_at <= now()
        ORDER BY updated_at, created_at
        FOR UPDATE SKIP LOCKED
        LIMIT $1`,
        [limit],
      );
      return result.rows;
    });
    let published = 0;
    for (const row of claimed) {
      try {
        await publishJob(row.payload, row.max_attempts);
        published += 1;
      } catch (error) {
        console.error("[queue] reconcile publish failed", error);
        break;
      }
    }
    return published;
  } finally {
    await getRedis().eval(
      "if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('del', KEYS[1]) else return 0 end",
      1,
      lockKey,
      lockToken,
    );
  }
}

export async function rateLimit(input: {
  key: string;
  limit: number;
  windowSeconds: number;
}): Promise<{ allowed: boolean; remaining: number; retryAfterSeconds: number }> {
  const key = `conecta:rate:${input.key}`;
  const count = await getRedis().incr(key);
  if (count === 1) await getRedis().expire(key, input.windowSeconds);
  const ttl = Math.max(1, await getRedis().ttl(key));
  return {
    allowed: count <= input.limit,
    remaining: Math.max(0, input.limit - count),
    retryAfterSeconds: ttl,
  };
}

export async function tokenBucketRateLimit(input: {
  key: string;
  ratePerSecond: number;
  burst: number;
}): Promise<{ allowed: boolean; remaining: number; retryAfterSeconds: number }> {
  const redisKey = `conecta:bucket:${input.key}`;
  const now = Date.now();
  const ttlMs = Math.max(1_000, Math.ceil((input.burst / input.ratePerSecond) * 2_000));
  const script = `
    local current = redis.call('HMGET', KEYS[1], 'tokens', 'updated_at')
    local tokens = tonumber(current[1]) or tonumber(ARGV[2])
    local updated_at = tonumber(current[2]) or tonumber(ARGV[1])
    local elapsed = math.max(0, tonumber(ARGV[1]) - updated_at) / 1000
    tokens = math.min(tonumber(ARGV[2]), tokens + elapsed * tonumber(ARGV[3]))
    local allowed = 0
    if tokens >= 1 then
      tokens = tokens - 1
      allowed = 1
    end
    redis.call('HSET', KEYS[1], 'tokens', tokens, 'updated_at', ARGV[1])
    redis.call('PEXPIRE', KEYS[1], ARGV[4])
    return {allowed, math.floor(tokens)}
  `;
  const result = (await getRedis().eval(
    script,
    1,
    redisKey,
    String(now),
    String(input.burst),
    String(input.ratePerSecond),
    String(ttlMs),
  )) as [number, number];
  const allowed = Number(result[0]) === 1;
  const remaining = Math.max(0, Number(result[1]));
  return {
    allowed,
    remaining,
    retryAfterSeconds: allowed ? 0 : Math.max(1, Math.ceil(1 / input.ratePerSecond)),
  };
}

export async function closeQueueConnections(): Promise<void> {
  await metaQueue?.close();
  await redis?.quit();
  metaQueue = undefined;
  redis = undefined;
}
