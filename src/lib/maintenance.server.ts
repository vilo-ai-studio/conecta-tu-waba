import { getPool } from "@/integrations/database/client.server";

export async function cleanupOperationalData(): Promise<void> {
  const queueDays = Number(process.env.QUEUE_RETENTION_DAYS ?? 30);
  const failedDays = Number(process.env.FAILED_JOB_RETENTION_DAYS ?? 180);
  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    await client.query("DELETE FROM sessions WHERE expires_at < now()");
    await client.query(
      `DELETE FROM webhook_jobs
        WHERE status = 'completed' AND completed_at < now() - ($1 || ' days')::interval`,
      [queueDays],
    );
    await client.query(
      `DELETE FROM webhook_jobs
        WHERE status = 'failed' AND failed_at < now() - ($1 || ' days')::interval`,
      [failedDays],
    );
    await client.query(
      "DELETE FROM n8n_forward_logs WHERE attempted_at < now() - interval '90 days'",
    );
    await client.query(
      "DELETE FROM message_send_logs WHERE created_at < now() - interval '90 days'",
    );
    await client.query(
      "DELETE FROM whatsapp_send_logs WHERE created_at < now() - interval '90 days'",
    );
    await client.query(
      `DELETE FROM raw_meta_webhook_events raw
        WHERE received_at < now() - interval '30 days'
          AND processed = true
          AND processing_error IS NULL
          AND NOT EXISTS (SELECT 1 FROM webhook_jobs jobs WHERE jobs.raw_event_id = raw.id)`,
    );
    await client.query(
      `DELETE FROM raw_meta_webhook_events raw
        WHERE received_at < now() - ($1 || ' days')::interval
          AND processing_error IS NOT NULL
          AND NOT EXISTS (SELECT 1 FROM webhook_jobs jobs WHERE jobs.raw_event_id = raw.id)`,
      [failedDays],
    );
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}
