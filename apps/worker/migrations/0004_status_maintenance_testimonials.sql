-- Part 2: client status emails, post-launch re-auth (maintenance) links,
-- testimonials, and invoices made from a HubSpot scoping deal.
--
-- Only adds columns and new tables, so nothing existing is rebuilt or copied.
-- Apply with: npx wrangler d1 migrations apply zp-intake --remote

-- Sprint milestone emails and alerts (each one goes out once).
ALTER TABLE onboarding_sessions ADD COLUMN milestone_half_sent_at TEXT;   -- 50% email (or skipped: see audit log)
ALTER TABLE onboarding_sessions ADD COLUMN milestone_full_sent_at TEXT;   -- 100% email (or skipped)
ALTER TABLE onboarding_sessions ADD COLUMN deadline_alert_sent_at TEXT;   -- #sprint-ops "deadline today, not in review yet"
ALTER TABLE onboarding_sessions ADD COLUMN testimonial_requested_at TEXT; -- the "2 sentences?" email 3 days after launch
-- The HubSpot deal this project came from (invoice metadata hubspot_deal_id). zp-landing moves it to Closed Won.
ALTER TABLE onboarding_sessions ADD COLUMN hubspot_deal_id TEXT;

-- A private link that lets a launched client re-enter API keys for a change request.
-- The client's original keys were wiped 7 days after launch; these are kept only for the change.
CREATE TABLE IF NOT EXISTS maintenance_requests (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  token_hash TEXT NOT NULL UNIQUE,
  token_expires_at TEXT NOT NULL,
  required_integrations_json TEXT NOT NULL DEFAULT '[]',
  note TEXT,                                    -- what the change is, shown to the client
  status TEXT NOT NULL DEFAULT 'OPEN' CHECK (status IN ('OPEN', 'SUBMITTED', 'DONE', 'EXPIRED')),
  encrypted_secrets_blob TEXT,                  -- AES-256-GCM, same key and project binding as the intake
  secrets_iv TEXT,
  submitted_at TEXT,
  done_at TEXT,
  secrets_purge_after TEXT,
  secrets_purged_at TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
CREATE INDEX IF NOT EXISTS idx_maintenance_project ON maintenance_requests (project_id);
CREATE INDEX IF NOT EXISTS idx_maintenance_purge ON maintenance_requests (secrets_purge_after);

-- One testimonial per project. REQUESTED (link sent) -> PENDING (client sent it) -> APPROVED or REJECTED (you decide).
-- Only APPROVED rows are ever shown publicly (GET /api/testimonials, used by zp-landing).
CREATE TABLE IF NOT EXISTS testimonials (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL UNIQUE,
  project_id TEXT NOT NULL,
  token_hash TEXT NOT NULL UNIQUE,
  token_expires_at TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'REQUESTED' CHECK (status IN ('REQUESTED', 'PENDING', 'APPROVED', 'REJECTED')),
  quote TEXT,
  author_name TEXT,
  author_role TEXT,
  company TEXT,
  link_url TEXT,                                -- optional Senja / review link the client pasted
  consent_at TEXT,                              -- they ticked "you may show this with my name and company"
  consent_ip TEXT,
  headline TEXT,                                -- your one-line result, e.g. "Replaced 6 hours a week of copy-paste"
  submitted_at TEXT,
  reviewed_at TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
CREATE INDEX IF NOT EXISTS idx_testimonials_status ON testimonials (status);

-- Which project id each HubSpot deal got, so making the invoice twice reuses the same id.
CREATE TABLE IF NOT EXISTS deal_projects (
  deal_id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL UNIQUE,
  tier TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
