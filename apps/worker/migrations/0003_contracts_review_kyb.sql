-- Contracts (PandaDoc), client review + launch sign-off, business check (KYB),
-- the $500+ bank-transfer-only rule, and #worker-errors alert de-duplication.
--
-- The spec called this file 0002_contracts_review_kyb.sql; 0002 was already taken by
-- 0002_landing_sync.sql (landing_synced_at), so it runs third.
--
-- SQLite can't change a CHECK constraint in place, and `status` needs a new value
-- (IN_REVIEW). So this rebuilds onboarding_sessions: new table, copy every row,
-- drop the old one, rename. Every existing column and value is kept. No other
-- table points at onboarding_sessions, so nothing else changes.
--
-- Apply with: npx wrangler d1 migrations apply zp-intake --remote
-- Cloudflare D1 keeps 30 days of Time Travel restore points, so this can be rolled back.

PRAGMA defer_foreign_keys = true;

CREATE TABLE onboarding_sessions_new (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL UNIQUE,
  client_name TEXT NOT NULL,
  client_email TEXT NOT NULL,
  tier TEXT NOT NULL CHECK (tier IN ('TIER_1', 'TIER_2', 'TIER_3')),
  status TEXT NOT NULL DEFAULT 'AWAITING_CREDENTIALS'
    CHECK (status IN ('AWAITING_CREDENTIALS', 'CLOCK_RUNNING', 'IN_REVIEW', 'LAUNCHED', 'EXPIRED')),

  token_hash TEXT NOT NULL UNIQUE,
  token_expires_at TEXT NOT NULL,

  stripe_invoice_id TEXT UNIQUE,
  required_integrations_json TEXT NOT NULL DEFAULT '[]',

  registrar_provider TEXT,
  github_target TEXT,
  github_verified INTEGER NOT NULL DEFAULT 0,
  brand_config_json TEXT,
  copy_source_url TEXT,
  copy_json TEXT,
  admin_emails_json TEXT,
  encrypted_secrets_blob TEXT,
  secrets_iv TEXT,
  spoc_name TEXT,
  spoc_email TEXT,

  submitted_at TEXT,
  clock_started_at TEXT,
  guaranteed_deadline TEXT,

  intake_email_sent_at TEXT,
  jira_epic_key TEXT,
  jira_synced_at TEXT,
  receipt_sent_at TEXT,
  landing_synced_at TEXT,
  last_error TEXT,

  launched_at TEXT,
  secrets_purge_after TEXT,
  secrets_purged_at TEXT,

  -- New: who and what was paid (from the Stripe invoice)
  contact_name TEXT,                            -- invoice metadata contact_name
  amount_cents INTEGER,                         -- invoice amount_paid, smallest unit (cents)
  currency TEXT,
  payment_rail TEXT,                            -- us_bank_account | customer_balance | ach_credit_transfer | out_of_band | ...

  -- New: business check (intake Step 1)
  legal_business_name TEXT,
  ein_or_registration TEXT,                     -- never sent to Slack, PandaDoc or the audit log
  webmail_override INTEGER NOT NULL DEFAULT 0,  -- 1 = you allowed a gmail/yahoo/... approver on Tier 2/3
  webmail_override_reason TEXT,

  -- New: PandaDoc contract
  pandadoc_document_id TEXT UNIQUE,
  contract_status TEXT
    CHECK (contract_status IS NULL OR contract_status IN
      ('DRAFT_PENDING_APPROVAL', 'SENDING', 'SENT', 'SIGNED', 'DECLINED', 'VOIDED')),
  contract_drafted_at TEXT,
  contract_approved_by TEXT,                    -- Slack user (or "admin API") who approved the send
  contract_sent_at TEXT,
  contract_signed_at TEXT,
  contract_r2_key TEXT,                         -- signed PDF backup in R2
  contract_drive_synced_at TEXT,                -- signed PDF copied into the client's Drive 01_Contracts_and_Scope

  -- New: staging review and launch sign-off
  staging_url TEXT,
  loom_url TEXT,
  release_notes TEXT,
  review_requested_at TEXT,
  client_approved_at TEXT,
  client_approval_ip TEXT,
  client_approval_name TEXT,                    -- the name the client typed when signing off
  landing_completed_at TEXT,                    -- zp-landing set the Airtable Clients Status to "Complete"

  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

INSERT INTO onboarding_sessions_new (
  id, project_id, client_name, client_email, tier, status, token_hash, token_expires_at,
  stripe_invoice_id, required_integrations_json, registrar_provider, github_target, github_verified,
  brand_config_json, copy_source_url, copy_json, admin_emails_json, encrypted_secrets_blob, secrets_iv,
  spoc_name, spoc_email, submitted_at, clock_started_at, guaranteed_deadline, intake_email_sent_at,
  jira_epic_key, jira_synced_at, receipt_sent_at, landing_synced_at, last_error, launched_at,
  secrets_purge_after, secrets_purged_at, created_at, updated_at
)
SELECT
  id, project_id, client_name, client_email, tier, status, token_hash, token_expires_at,
  stripe_invoice_id, required_integrations_json, registrar_provider, github_target, github_verified,
  brand_config_json, copy_source_url, copy_json, admin_emails_json, encrypted_secrets_blob, secrets_iv,
  spoc_name, spoc_email, submitted_at, clock_started_at, guaranteed_deadline, intake_email_sent_at,
  jira_epic_key, jira_synced_at, receipt_sent_at, landing_synced_at, last_error, launched_at,
  secrets_purge_after, secrets_purged_at, created_at, updated_at
FROM onboarding_sessions;

DROP TABLE onboarding_sessions;
ALTER TABLE onboarding_sessions_new RENAME TO onboarding_sessions;

CREATE INDEX IF NOT EXISTS idx_sessions_status ON onboarding_sessions (status);
CREATE INDEX IF NOT EXISTS idx_sessions_purge ON onboarding_sessions (secrets_purge_after);
CREATE INDEX IF NOT EXISTS idx_sessions_contract ON onboarding_sessions (contract_status);

-- One row per alert signature (service | step | project | status), so the hourly
-- retries don't post the same #worker-errors alert every hour.
CREATE TABLE IF NOT EXISTS worker_alerts (
  signature TEXT PRIMARY KEY,
  last_sent_at TEXT NOT NULL,
  suppressed INTEGER NOT NULL DEFAULT 0          -- repeats skipped since the last post
);
