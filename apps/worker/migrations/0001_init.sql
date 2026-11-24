-- ZinkPress intake portal: first schema.
-- Apply with: npx wrangler d1 migrations apply zp-intake --remote

CREATE TABLE IF NOT EXISTS onboarding_sessions (
  id TEXT PRIMARY KEY,                          -- random UUID (internal row id, never sent to clients)
  project_id TEXT NOT NULL UNIQUE,              -- matches the SOW and Stripe invoice metadata
  client_name TEXT NOT NULL,
  client_email TEXT NOT NULL,
  tier TEXT NOT NULL CHECK (tier IN ('TIER_1', 'TIER_2', 'TIER_3')),
  status TEXT NOT NULL DEFAULT 'AWAITING_CREDENTIALS'
    CHECK (status IN ('AWAITING_CREDENTIALS', 'CLOCK_RUNNING', 'LAUNCHED', 'EXPIRED')),

  -- Link token: we keep only its SHA-256 hash, plus when it stops working.
  token_hash TEXT NOT NULL UNIQUE,
  token_expires_at TEXT NOT NULL,

  stripe_invoice_id TEXT UNIQUE,
  required_integrations_json TEXT NOT NULL DEFAULT '[]',

  -- Intake answers
  registrar_provider TEXT,
  github_target TEXT,
  github_verified INTEGER NOT NULL DEFAULT 0,  -- 1 = GitHub confirmed the account exists
  brand_config_json TEXT,                       -- { primaryHex, secondaryHex, font, logoKey, assetKeys }
  copy_source_url TEXT,                         -- set when the client sent a Doc/Notion link
  copy_json TEXT,                               -- the full copy answer (link or typed fields)
  admin_emails_json TEXT,
  encrypted_secrets_blob TEXT,                  -- AES-256-GCM ciphertext of the client's API keys
  secrets_iv TEXT,                              -- 12-byte IV, new for every encryption
  spoc_name TEXT,
  spoc_email TEXT,

  -- Clock
  submitted_at TEXT,
  clock_started_at TEXT,                        -- next business-day 9:00 AM Eastern after submit
  guaranteed_deadline TEXT,

  -- Follow-up work (lets a retry skip what already happened)
  intake_email_sent_at TEXT,
  jira_epic_key TEXT,
  jira_synced_at TEXT,
  receipt_sent_at TEXT,
  last_error TEXT,

  -- Launch and secrets purge
  launched_at TEXT,
  secrets_purge_after TEXT,
  secrets_purged_at TEXT,

  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE INDEX IF NOT EXISTS idx_sessions_status ON onboarding_sessions (status);
CREATE INDEX IF NOT EXISTS idx_sessions_purge ON onboarding_sessions (secrets_purge_after);

CREATE TABLE IF NOT EXISTS audit_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT,
  project_id TEXT,
  event TEXT NOT NULL,
  detail TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE INDEX IF NOT EXISTS idx_audit_project ON audit_log (project_id, created_at);

-- Stripe can send the same event more than once. We remember every event id we finished.
CREATE TABLE IF NOT EXISTS stripe_events (
  event_id TEXT PRIMARY KEY,
  received_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
