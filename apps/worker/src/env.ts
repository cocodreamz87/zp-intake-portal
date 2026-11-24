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

  // Secrets (Cloudflare dashboard: Settings > Variables and Secrets, type Secret)
  STRIPE_WEBHOOK_SECRET?: string;
  SECRETS_ENCRYPTION_KEY?: string;
  ADMIN_API_TOKEN?: string;
  JIRA_EMAIL?: string;
  JIRA_API_TOKEN?: string;
  RESEND_API_KEY?: string;
  GITHUB_TOKEN?: string;
}

export function numberVar(v: string | undefined, fallback: number): number {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

export function jiraConfigured(env: Env): boolean {
  return Boolean(env.JIRA_DOMAIN && env.JIRA_PROJECT_KEY && env.JIRA_EMAIL && env.JIRA_API_TOKEN);
}

export function resendConfigured(env: Env): boolean {
  return Boolean(env.RESEND_API_KEY && (env.RECEIPT_FROM_EMAIL || env.AGENCY_EMAIL));
}
