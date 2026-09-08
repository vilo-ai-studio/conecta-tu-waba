CREATE EXTENSION IF NOT EXISTS pgcrypto;

DO $$ BEGIN
  CREATE TYPE app_role AS ENUM ('admin', 'user');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

CREATE OR REPLACE FUNCTION set_updated_at() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;

CREATE TABLE IF NOT EXISTS users (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email text NOT NULL,
  password_hash text NOT NULL,
  name text,
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS users_email_lower_unique ON users (lower(email));

CREATE TABLE IF NOT EXISTS user_roles (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role app_role NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, role)
);

CREATE TABLE IF NOT EXISTS sessions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash text NOT NULL UNIQUE,
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS sessions_expires_at_idx ON sessions (expires_at);

CREATE TABLE IF NOT EXISTS clients (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,
  email text,
  company_name text,
  status text NOT NULL DEFAULT 'pending',
  n8n_webhook_url text,
  n8n_webhook_secret_encrypted text,
  n8n_enabled boolean NOT NULL DEFAULT false,
  n8n_last_delivery_at timestamptz,
  n8n_last_delivery_status text,
  n8n_last_delivery_error text,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS onboarding_links (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id uuid NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  token text NOT NULL UNIQUE,
  expires_at timestamptz,
  used_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS onboarding_links_token_idx ON onboarding_links (token);

CREATE TABLE IF NOT EXISTS whatsapp_accounts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id uuid NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  waba_id text UNIQUE,
  phone_number_id text UNIQUE,
  business_id text,
  display_phone_number text,
  verified_name text,
  status text NOT NULL DEFAULT 'pending',
  webhook_subscribed boolean NOT NULL DEFAULT false,
  token_encrypted text,
  connected_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS whatsapp_accounts_phone_number_id_idx ON whatsapp_accounts (phone_number_id);
CREATE INDEX IF NOT EXISTS whatsapp_accounts_client_id_idx ON whatsapp_accounts (client_id);
DROP TRIGGER IF EXISTS whatsapp_accounts_updated ON whatsapp_accounts;
CREATE TRIGGER whatsapp_accounts_updated BEFORE UPDATE ON whatsapp_accounts
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE IF NOT EXISTS webhook_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  whatsapp_account_id uuid REFERENCES whatsapp_accounts(id) ON DELETE SET NULL,
  event_type text,
  payload jsonb NOT NULL,
  processed boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS raw_meta_webhook_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  received_at timestamptz NOT NULL DEFAULT now(),
  method text,
  url text,
  query_params jsonb,
  headers jsonb,
  body_raw text,
  body_json jsonb,
  phone_number_id text,
  object_type text,
  is_meta_test boolean NOT NULL DEFAULT false,
  processing_error text,
  processed boolean NOT NULL DEFAULT false
);
CREATE INDEX IF NOT EXISTS raw_meta_webhook_events_received_idx ON raw_meta_webhook_events (received_at DESC);
CREATE INDEX IF NOT EXISTS raw_meta_webhook_events_phone_idx ON raw_meta_webhook_events (phone_number_id);

CREATE TABLE IF NOT EXISTS meta_webhook_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id uuid REFERENCES clients(id) ON DELETE SET NULL,
  whatsapp_account_id uuid REFERENCES whatsapp_accounts(id) ON DELETE SET NULL,
  phone_number_id text,
  direction text NOT NULL DEFAULT 'inbound_from_meta',
  field text,
  event_kind text,
  wa_message_id text,
  from_wa_id text,
  to_phone_number text,
  message_type text,
  text_body text,
  status text,
  error_code text,
  error_title text,
  error_message text,
  error_details jsonb,
  raw_headers jsonb,
  raw_payload jsonb NOT NULL,
  received_at timestamptz NOT NULL DEFAULT now(),
  processed boolean NOT NULL DEFAULT false,
  processing_error text
);
CREATE INDEX IF NOT EXISTS meta_webhook_events_client_received_idx ON meta_webhook_events (client_id, received_at DESC);
CREATE INDEX IF NOT EXISTS meta_webhook_events_message_idx ON meta_webhook_events (wa_message_id);

CREATE TABLE IF NOT EXISTS n8n_forward_logs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id uuid REFERENCES clients(id) ON DELETE CASCADE,
  whatsapp_account_id uuid REFERENCES whatsapp_accounts(id) ON DELETE SET NULL,
  meta_webhook_event_id uuid REFERENCES meta_webhook_events(id) ON DELETE SET NULL,
  phone_number_id text,
  n8n_webhook_url text,
  request_headers jsonb,
  request_payload jsonb,
  response_status integer,
  response_body text,
  forward_attempted boolean NOT NULL DEFAULT false,
  n8n_enabled_value boolean,
  success boolean NOT NULL DEFAULT false,
  error_message text,
  attempted_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS n8n_forward_logs_client_attempted_idx ON n8n_forward_logs (client_id, attempted_at DESC);

CREATE TABLE IF NOT EXISTS processed_whatsapp_messages (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id uuid REFERENCES clients(id) ON DELETE CASCADE,
  whatsapp_account_id uuid REFERENCES whatsapp_accounts(id) ON DELETE SET NULL,
  phone_number_id text,
  message_id text NOT NULL UNIQUE,
  from_wa_id text,
  message_type text,
  text text,
  meta_timestamp text,
  processed_at timestamptz NOT NULL DEFAULT now(),
  first_seen_at timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  duplicate_count integer NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS message_send_logs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id uuid REFERENCES clients(id) ON DELETE CASCADE,
  phone_number_id text,
  "to" text NOT NULL,
  message_preview text,
  status text NOT NULL,
  meta_message_id text,
  error_message text,
  raw_response jsonb,
  source text NOT NULL DEFAULT 'panel',
  http_status integer,
  request_payload jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS message_send_logs_client_idx ON message_send_logs (client_id, created_at DESC);

CREATE TABLE IF NOT EXISTS whatsapp_send_logs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id uuid NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  whatsapp_account_id uuid REFERENCES whatsapp_accounts(id) ON DELETE SET NULL,
  phone_number_id text,
  to_wa_id text,
  message_type text,
  message_preview text,
  request_payload jsonb,
  response_status integer,
  response_body jsonb,
  meta_message_id text,
  meta_message_status text,
  success boolean NOT NULL DEFAULT false,
  error_code text,
  error_subcode text,
  error_type text,
  error_message text,
  fbtrace_id text,
  source text NOT NULL DEFAULT 'panel',
  inbound_message_id text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS whatsapp_send_logs_client_created_idx ON whatsapp_send_logs (client_id, created_at DESC);
CREATE INDEX IF NOT EXISTS whatsapp_send_logs_meta_message_idx ON whatsapp_send_logs (meta_message_id);
CREATE INDEX IF NOT EXISTS whatsapp_send_logs_inbound_idx ON whatsapp_send_logs (inbound_message_id) WHERE inbound_message_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS test_contacts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id uuid NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  label text NOT NULL,
  phone text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS test_contacts_client_idx ON test_contacts (client_id, created_at DESC);

CREATE TABLE IF NOT EXISTS client_integrations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id uuid NOT NULL REFERENCES clients(id) ON DELETE CASCADE UNIQUE,
  chatwoot_enabled boolean NOT NULL DEFAULT false,
  chatwoot_base_url text,
  chatwoot_account_id text,
  chatwoot_inbox_id text,
  chatwoot_api_access_token_encrypted text,
  chatwoot_webhook_secret_encrypted text,
  chatwoot_webhook_signature_enabled boolean NOT NULL DEFAULT true,
  chatwoot_bot_pause_label text NOT NULL DEFAULT 'human',
  chatwoot_bot_active_label text NOT NULL DEFAULT 'bot_on',
  pause_on_assigned boolean NOT NULL DEFAULT false,
  chatwoot_unhealthy boolean NOT NULL DEFAULT false,
  chatwoot_unhealthy_reason text,
  chatwoot_unhealthy_since timestamptz,
  last_test_status text,
  last_test_error text,
  last_test_at timestamptz,
  last_sync_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
DROP TRIGGER IF EXISTS client_integrations_updated_at ON client_integrations;
CREATE TRIGGER client_integrations_updated_at BEFORE UPDATE ON client_integrations
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE IF NOT EXISTS chatwoot_contact_mappings (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id uuid NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  wa_id text NOT NULL,
  phone text,
  profile_name text,
  chatwoot_contact_id text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (client_id, wa_id)
);
CREATE INDEX IF NOT EXISTS chatwoot_contact_client_idx ON chatwoot_contact_mappings (client_id);
DROP TRIGGER IF EXISTS chatwoot_contact_updated_at ON chatwoot_contact_mappings;
CREATE TRIGGER chatwoot_contact_updated_at BEFORE UPDATE ON chatwoot_contact_mappings
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE IF NOT EXISTS chatwoot_conversation_mappings (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id uuid NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  wa_id text NOT NULL,
  chatwoot_contact_id text,
  chatwoot_conversation_id text NOT NULL,
  status text,
  labels jsonb NOT NULL DEFAULT '[]'::jsonb,
  assignee_id text,
  bot_paused boolean NOT NULL DEFAULT false,
  last_inbound_message_id text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (client_id, wa_id)
);
CREATE INDEX IF NOT EXISTS chatwoot_conversation_client_idx ON chatwoot_conversation_mappings (client_id);
CREATE INDEX IF NOT EXISTS chatwoot_conversation_id_idx ON chatwoot_conversation_mappings (client_id, chatwoot_conversation_id);
DROP TRIGGER IF EXISTS chatwoot_conversation_updated_at ON chatwoot_conversation_mappings;
CREATE TRIGGER chatwoot_conversation_updated_at BEFORE UPDATE ON chatwoot_conversation_mappings
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE IF NOT EXISTS chatwoot_message_mappings (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id uuid NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  wa_id text,
  inbound_message_id text,
  outbound_message_id text,
  chatwoot_message_id text,
  chatwoot_conversation_id text,
  direction text NOT NULL CHECK (direction IN ('incoming', 'outgoing')),
  source text NOT NULL CHECK (source IN ('meta', 'n8n', 'chatwoot_agent', 'system', 'backend')),
  idempotency_key text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS chatwoot_message_cw_unique ON chatwoot_message_mappings (client_id, chatwoot_message_id) WHERE chatwoot_message_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS chatwoot_message_inbound_unique ON chatwoot_message_mappings (client_id, inbound_message_id) WHERE inbound_message_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS chatwoot_message_outbound_unique ON chatwoot_message_mappings (client_id, outbound_message_id) WHERE outbound_message_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS chatwoot_message_idem_unique ON chatwoot_message_mappings (client_id, idempotency_key) WHERE idempotency_key IS NOT NULL;

CREATE TABLE IF NOT EXISTS chatwoot_integration_logs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id uuid REFERENCES clients(id) ON DELETE CASCADE,
  event_type text NOT NULL,
  direction text,
  wa_id text,
  chatwoot_contact_id text,
  chatwoot_conversation_id text,
  chatwoot_message_id text,
  status text,
  http_status integer,
  request_payload jsonb,
  response_payload jsonb,
  error_message text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS chatwoot_logs_client_created_idx ON chatwoot_integration_logs (client_id, created_at DESC);
CREATE INDEX IF NOT EXISTS chatwoot_logs_event_type_idx ON chatwoot_integration_logs (event_type);
