/** Everything the Worker reads from wrangler.toml [vars], bindings, and Secrets set in the Cloudflare dashboard. */
export interface Env {
  // Bindings
  DB: D1Database;
  ASSETS_BUCKET: R2Bucket;

  // Plain settings ([vars] in wrangler.toml)
  AGENCY_NAME: string;
  AGENCY_EMAIL: string;
  /** Where the intake form lives. Empty = this Worker's own address. */
  PORTAL_URL?: string;
  /** Extra sites allowed to call the API from a browser (comma list). Empty = same site only. */
  ALLOWED_ORIGIN?: string;
  BUSINESS_TIMEZONE?: string;
  HOLIDAYS?: string;
  TOKEN_TTL_DAYS?: string;
  SECRETS_PURGE_DAYS?: string;
  CLOUDFLARE_HELP_URL?: string;
  RECEIPT_FROM_EMAIL?: string;
  STAGING_URL_TEMPLATE?: string;
  JIRA_DOMAIN?: string;
  JIRA_PROJECT_KEY?: string;
  JIRA_EPIC_TYPE?: string;
  JIRA_TASK_TYPE?: string;
  /** zp-landing's onboarding endpoint, e.g. https://zp-landing.peaceiam4now.workers.dev/api/onboard. Empty = skip. */
  ZP_LANDING_ONBOARD_URL?: string;

  // Secrets (Cloudflare dashboard: Settings > Variables and Secrets, type Secret)
  STRIPE_WEBHOOK_SECRET?: string;
  SECRETS_ENCRYPTION_KEY?: string;
  ADMIN_API_TOKEN?: string;
  JIRA_EMAIL?: string;
  JIRA_API_TOKEN?: string;
  RESEND_API_KEY?: string;
  GITHUB_TOKEN?: string;
  /** Same value as WEBHOOK_SECRET on zp-landing. */
  ZP_LANDING_WEBHOOK_SECRET?: string;

  // Slack Incoming Webhook URLs, one per channel (optional; each alert is
  // skipped quietly when its URL isn't set). The URL itself is the secret.
  SLACK_WEBHOOK_REVENUE?: string; // #pipeline-revenue
  SLACK_WEBHOOK_SPRINT_OPS?: string; // #sprint-ops
  SLACK_WEBHOOK_APPROVALS?: string; // #staging-approvals
  SLACK_WEBHOOK_ERRORS?: string; // #worker-errors
}

export function numberVar(v: string | undefined, fallback: number): number {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

export function jiraConfigured(env: Env): boolean {
  return Boolean(env.JIRA_DOMAIN && env.JIRA_PROJECT_KEY && env.JIRA_EMAIL && env.JIRA_API_TOKEN);
}

/**
 * Email goes out only with a Resend key AND a Resend-verified sender. AGENCY_EMAIL is never used
 * as the sender: it is a Proton address, which Resend rejects, so every send would fail and retry.
 */
export function resendConfigured(env: Env): boolean {
  return Boolean(env.RESEND_API_KEY && env.RECEIPT_FROM_EMAIL);
}

export function landingConfigured(env: Env): boolean {
  return Boolean(env.ZP_LANDING_ONBOARD_URL && env.ZP_LANDING_WEBHOOK_SECRET);
}
