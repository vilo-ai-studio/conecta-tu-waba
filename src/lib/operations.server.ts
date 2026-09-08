import { getPool } from "@/integrations/database/client.server";
import {
  getMetaQueue,
  getRedis,
  republishStoredJob,
  WORKER_HEARTBEAT_KEY,
} from "@/lib/queue.server";

export async function assertOperationsAdmin(userId: string): Promise<void> {
  const result = await getPool().query(
    "SELECT 1 FROM user_roles WHERE user_id = $1 AND role = 'admin' LIMIT 1",
    [userId],
  );
  if (!result.rowCount) throw new Error("No autorizado. Se requiere rol admin.");
}

export async function buildQueueMetrics() {
  const [database, bull, heartbeat] = await Promise.all([
    getPool().query<{
      pending: string;
      queued: string;
      processing: string;
      completed: string;
      failed: string;
      oldest_pending_at: string | null;
      last_completed_at: string | null;
    }>(`SELECT count(*) FILTER (WHERE status = 'pending')::text AS pending,
              count(*) FILTER (WHERE status = 'queued')::text AS queued,
              count(*) FILTER (WHERE status = 'processing')::text AS processing,
              count(*) FILTER (WHERE status = 'completed')::text AS completed,
              count(*) FILTER (WHERE status = 'failed')::text AS failed,
              min(created_at) FILTER (WHERE status IN ('pending', 'queued')) AS oldest_pending_at,
              max(completed_at) FILTER (WHERE status = 'completed') AS last_completed_at
         FROM webhook_jobs`),
    getMetaQueue().getJobCounts("waiting", "active", "delayed", "failed", "completed"),
    getRedis().get(WORKER_HEARTBEAT_KEY),
  ]);
  const row = database.rows[0];
  return {
    pending: Number(row.pending),
    queued: Number(row.queued),
    processing: Number(row.processing),
    completed: Number(row.completed),
    failed: Number(row.failed),
    oldest_pending_at: row.oldest_pending_at,
    last_completed_at: row.last_completed_at,
    bullmq: bull,
    worker_heartbeat_at: heartbeat,
    worker_healthy: Boolean(heartbeat && Date.now() - new Date(heartbeat).getTime() < 30_000),
  };
}

export async function buildOperationsHealth() {
  const pool = getPool();
  await pool.query("SELECT 1");
  await getRedis().ping();
  const queue = await buildQueueMetrics();
  return {
    checked_at: new Date().toISOString(),
    application: "ok" as const,
    postgres: "ok" as const,
    redis: "ok" as const,
    worker: queue.worker_healthy ? ("ok" as const) : ("error" as const),
    pool: { total: pool.totalCount, idle: pool.idleCount, waiting: pool.waitingCount },
    queue,
    meta: {
      app_id_configured: Boolean(process.env.META_APP_ID ?? process.env.VITE_META_APP_ID),
      app_secret_configured: Boolean(process.env.META_APP_SECRET),
      signature_required: (process.env.META_WEBHOOK_SIGNATURE_REQUIRED ?? "true") === "true",
    },
  };
}

export async function listStoredWebhookJobs(data: {
  status?: "pending" | "queued" | "processing" | "completed" | "failed";
  clientId?: string;
  cursor?: string;
  limit: number;
}) {
  const conditions: string[] = [];
  const values: unknown[] = [];
  if (data.status) {
    values.push(data.status);
    conditions.push(`jobs.status = $${values.length}`);
  }
  if (data.clientId) {
    values.push(data.clientId);
    conditions.push(`jobs.client_id = $${values.length}`);
  }
  if (data.cursor) {
    values.push(data.cursor);
    conditions.push(`jobs.created_at < $${values.length}`);
  }
  values.push(data.limit + 1);
  const result = await getPool().query<{
    id: string;
    client_id: string | null;
    client_name: string | null;
    status: string;
    attempts: number;
    max_attempts: number;
    last_error: string | null;
    available_at: string;
    created_at: string;
    failed_at: string | null;
  }>(
    `SELECT jobs.id, jobs.client_id, coalesce(clients.company_name, clients.name) AS client_name,
            jobs.status, jobs.attempts, jobs.max_attempts, jobs.last_error,
            jobs.available_at, jobs.created_at, jobs.failed_at
       FROM webhook_jobs jobs LEFT JOIN clients ON clients.id = jobs.client_id
       ${conditions.length ? `WHERE ${conditions.join(" AND ")}` : ""}
      ORDER BY jobs.created_at DESC LIMIT $${values.length}`,
    values,
  );
  const hasMore = result.rows.length > data.limit;
  const rows = result.rows.slice(0, data.limit);
  return { jobs: rows, nextCursor: hasMore ? (rows.at(-1)?.created_at ?? null) : null };
}

export async function retryStoredWebhookJob(jobId: string) {
  const result = await getPool().query(
    `UPDATE webhook_jobs SET status = 'pending', attempts = 0, available_at = now(),
       queued_at = NULL, started_at = NULL, completed_at = NULL, failed_at = NULL,
       locked_by = NULL, last_error = NULL WHERE id = $1 AND status = 'failed' RETURNING id`,
    [jobId],
  );
  if (!result.rowCount) throw new Error("El trabajo no existe o no está fallido.");
  try {
    await republishStoredJob(jobId);
  } catch (error) {
    console.error("[operations] retry publish deferred", error);
  }
  return { ok: true, jobId };
}
