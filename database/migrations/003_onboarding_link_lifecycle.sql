-- Keep a durable audit trail while making old onboarding URLs unusable.
ALTER TABLE onboarding_links
  ADD COLUMN IF NOT EXISTS revoked_at timestamptz;

CREATE INDEX IF NOT EXISTS onboarding_links_client_lifecycle_idx
  ON onboarding_links (client_id, created_at DESC);

CREATE INDEX IF NOT EXISTS onboarding_links_revoked_idx
  ON onboarding_links (revoked_at DESC)
  WHERE revoked_at IS NOT NULL;
