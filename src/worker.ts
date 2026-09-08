import { randomUUID } from "node:crypto";
import { UnrecoverableError, Worker, type Job } from "bullmq";
import {
  closeQueueConnections,
  getRedis,
  META_QUEUE_NAME,
  reconcilePendingJobs,
  WORKER_HEARTBEAT_KEY,
  type MetaChangeJobV1,
} from "@/lib/queue.server";
import {
  PermanentJobError,
  processMetaChangeJob,
  RetryableJobError,
} from "@/lib/meta-webhook-processor.server";
import { getPool } from "@/integrations/database/client.server";
import { retryDelayMs } from "@/lib/retry-policy";
import { cleanupOperationalData } from "@/lib/maintenance.server";

const workerId = `${process.env.HOSTNAME ?? "worker"}:${process.pid}`;
const concurrency = Math.max(1, Number(process.env.WORKER_CONCURRENCY ?? 5));
const redis = getRedis();

async function conversationKey(data: MetaChangeJobV1): Promise<string> {
  const change = data.change as {
    value?: {
      messages?: Array<{ from?: string }>;
      statuses?: Array<{ recipient_id?: string }>;
    };
  };
  const value = change?.value ?? {};
  const message = Array.isArray(value.messages) ? value.messages[0] : null;
  const status = Array.isArray(value.statuses) ? value.statuses[0] : null;
  const participant = message?.from ?? status?.recipient_id ?? "account";
  const account = data.phoneNumberId
    ? await getPool().query<{ client_id: string }>(
        "SELECT client_id FROM whatsapp_accounts WHERE phone_number_id = $1 LIMIT 1",
        [data.phoneNumberId],
      )
    : null;
  const clientId = account?.rows[0]?.client_id ?? `account:${data.phoneNumberId ?? "unknown"}`;
  return `conecta:conversation:${clientId}:${participant}`;
}

async function withConversationLock<T>(
  data: MetaChangeJobV1,
  callback: () => Promise<T>,
): Promise<T> {
  const key = await conversationKey(data);
  const token = randomUUID();
  const deadline = Date.now() + 30_000;
  let acquired = false;
  while (!acquired && Date.now() < deadline) {
    acquired = (await redis.set(key, token, "PX", 30_000, "NX")) === "OK";
    if (!acquired) await new Promise((resolve) => setTimeout(resolve, 100));
  }
  if (!acquired) throw new RetryableJobError("conversation_lock_timeout", 5_000);
  const renewal = setInterval(() => {
    void redis
      .eval(
        "if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('pexpire', KEYS[1], ARGV[2]) else return 0 end",
        1,
        key,
        token,
        "30000",
      )
      .catch((error) => console.error("[worker] conversation lock renewal failed", error));
  }, 10_000);
  try {
    return await callback();
  } finally {
    clearInterval(renewal);
    await redis.eval(
      "if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('del', KEYS[1]) else return 0 end",
      1,
      key,
      token,
    );
  }
}

const worker = new Worker<MetaChangeJobV1>(
  META_QUEUE_NAME,
  async (job) => {
    await getPool().query(
      `UPDATE webhook_jobs
          SET status = 'processing', started_at = now(), attempts = $2, locked_by = $3
        WHERE id = $1`,
      [job.data.jobId, job.attemptsMade + 1, workerId],
    );
    try {
      await withConversationLock(job.data, () => processMetaChangeJob(job.data));
      await getPool().query(
        `UPDATE webhook_jobs
            SET status = 'completed', completed_at = now(), failed_at = NULL,
                locked_by = NULL, last_error = NULL
          WHERE id = $1`,
        [job.data.jobId],
      );
      await getPool().query(
        `UPDATE raw_meta_webhook_events raw
            SET processed = true, processing_error = NULL
          WHERE raw.id = $1
            AND NOT EXISTS (
              SELECT 1 FROM webhook_jobs jobs
               WHERE jobs.raw_event_id = raw.id AND jobs.status <> 'completed'
            )`,
        [job.data.rawEventId],
      );
    } catch (error) {
      if (error instanceof PermanentJobError) throw new UnrecoverableError(error.message);
      throw error;
    }
  },
  {
    connection: redis,
    concurrency,
    lockDuration: 30_000,
    stalledInterval: 10_000,
    maxStalledCount: 2,
    settings: {
      backoffStrategy: (attemptsMade, type, error) => {
        if (type !== "conecta") return -1;
        const explicit = error instanceof RetryableJobError ? error.retryAfterMs : undefined;
        return explicit ?? retryDelayMs(attemptsMade);
      },
    },
  },
);

worker.on("completed", (job) => console.log("[worker] completed", { jobId: job.id }));
worker.on("failed", async (job, error) => {
  if (!job) return;
  const final = error instanceof UnrecoverableError || job.attemptsMade >= (job.opts.attempts ?? 1);
  const delay = final
    ? 0
    : error instanceof RetryableJobError && error.retryAfterMs
      ? error.retryAfterMs
      : retryDelayMs(job.attemptsMade, () => 0);
  await getPool()
    .query(
      `UPDATE webhook_jobs
          SET status = $2,
              available_at = CASE WHEN $2 = 'queued' THEN now() + ($4 || ' milliseconds')::interval ELSE available_at END,
              failed_at = CASE WHEN $2 = 'failed' THEN now() ELSE NULL END,
              locked_by = NULL, last_error = $3
        WHERE id = $1`,
      [job.data.jobId, final ? "failed" : "queued", error.message.slice(0, 2_000), delay],
    )
    .catch((dbError) => console.error("[worker] failed status update", dbError));
  if (final) {
    await getPool()
      .query("UPDATE raw_meta_webhook_events SET processing_error = $2 WHERE id = $1", [
        job.data.rawEventId,
        error.message.slice(0, 2_000),
      ])
      .catch((dbError) => console.error("[worker] raw event status update", dbError));
  }
});
worker.on("error", (error) => console.error("[worker] error", error));

async function heartbeat() {
  await redis.set(WORKER_HEARTBEAT_KEY, new Date().toISOString(), "EX", 30);
}

async function recoverStaleProcessingJobs() {
  await getPool().query(
    `UPDATE webhook_jobs
        SET status = 'pending', available_at = now(), locked_by = NULL,
            last_error = coalesce(last_error, 'recovered_stale_processing_job')
      WHERE status = 'processing' AND started_at < now() - interval '30 seconds'`,
  );
}

await redis.ping();
await heartbeat();
await recoverStaleProcessingJobs();
await reconcilePendingJobs();
await cleanupOperationalData();
console.log("[worker] started", { workerId, concurrency });

const heartbeatTimer = setInterval(() => heartbeat().catch(console.error), 10_000);
const reconcileTimer = setInterval(
  () =>
    recoverStaleProcessingJobs()
      .then(() => reconcilePendingJobs())
      .catch(console.error),
  5_000,
);
const cleanupTimer = setInterval(() => cleanupOperationalData().catch(console.error), 86_400_000);

async function shutdown(signal: string) {
  console.log("[worker] shutdown", { signal });
  clearInterval(heartbeatTimer);
  clearInterval(reconcileTimer);
  clearInterval(cleanupTimer);
  const deadline = new Promise<void>((resolve) => setTimeout(resolve, 30_000));
  await Promise.race([worker.close(), deadline]);
  await closeQueueConnections();
  await getPool().end();
  process.exit(0);
}

process.once("SIGTERM", () => void shutdown("SIGTERM"));
process.once("SIGINT", () => void shutdown("SIGINT"));
