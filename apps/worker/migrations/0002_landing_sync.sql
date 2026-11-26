-- When zp-landing's /api/onboard accepted this client (Drive, Airtable, HubSpot, welcome email, Slack).
-- Empty = not handed over yet; the hourly cron retries until it is set.
-- Apply with: npx wrangler d1 migrations apply zp-intake --remote
ALTER TABLE onboarding_sessions ADD COLUMN landing_synced_at TEXT;
