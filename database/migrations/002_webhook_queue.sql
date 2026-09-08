CREATE TABLE IF NOT EXISTS webhook_jobs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  raw_event_id uuid REFERENCES raw_meta_webhook_events(id) ON DELETE SET NULL,
  client_id uuid REFERENCES clients(id) ON DELETE SET NULL,
  job_type text NOT NULL DEFAULT 'meta.change.process',
  payload_version integer NOT NULL DEFAULT 1,
  payload jsonb NOT NULL,
  deduplication_key text NOT NULL UNIQUE,
  status text NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'queued', 'processing', 'completed', 'failed')),
  attempts integer NOT NULL DEFAULT 0,
  max_attempts integer NOT NULL DEFAULT 8,
  available_at timestamptz NOT NULL DEFAULT now(),
  queued_at timestamptz,
  started_at timestamptz,
  completed_at timestamptz,
  failed_at timestamptz,
  locked_by text,
  last_error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS webhook_jobs_pending_idx
  ON webhook_jobs (available_at, created_at)
  WHERE status = 'pending';
CREATE INDEX IF NOT EXISTS webhook_jobs_failed_idx
  ON webhook_jobs (failed_at DESC)
  WHERE status = 'failed';
CREATE INDEX IF NOT EXISTS webhook_jobs_client_status_idx
  ON webhook_jobs (client_id, status, created_at DESC);
CREATE INDEX IF NOT EXISTS webhook_jobs_created_idx ON webhook_jobs (created_at DESC);

ALTER TABLE meta_webhook_events ADD COLUMN IF NOT EXISTS webhook_job_id uuid;
ALTER TABLE meta_webhook_events ADD COLUMN IF NOT EXISTS webhook_item_key text NOT NULL DEFAULT '0';
DROP INDEX IF EXISTS meta_webhook_events_job_unique;
CREATE UNIQUE INDEX IF NOT EXISTS meta_webhook_events_job_item_unique
  ON meta_webhook_events (webhook_job_id, webhook_item_key)
  WHERE webhook_job_id IS NOT NULL;

DROP TRIGGER IF EXISTS webhook_jobs_updated_at ON webhook_jobs;
CREATE TRIGGER webhook_jobs_updated_at BEFORE UPDATE ON webhook_jobs
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

ALTER TABLE whatsapp_send_logs ADD COLUMN IF NOT EXISTS idempotency_key text;
CREATE UNIQUE INDEX IF NOT EXISTS whatsapp_send_logs_reply_success_unique
  ON whatsapp_send_logs (client_id, inbound_message_id)
  WHERE inbound_message_id IS NOT NULL AND success = true;
CREATE UNIQUE INDEX IF NOT EXISTS whatsapp_send_logs_idempotency_unique
  ON whatsapp_send_logs (client_id, idempotency_key)
  WHERE idempotency_key IS NOT NULL AND success = true;

CREATE TABLE IF NOT EXISTS outbound_idempotency (
  client_id uuid NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  idempotency_key text NOT NULL,
  status text NOT NULL CHECK (status IN ('processing', 'completed', 'failed')),
  response_status integer,
  response_body jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (client_id, idempotency_key)
);

DROP TRIGGER IF EXISTS outbound_idempotency_updated_at ON outbound_idempotency;
CREATE TRIGGER outbound_idempotency_updated_at BEFORE UPDATE ON outbound_idempotency
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
