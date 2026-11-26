import type { SessionRow } from "./db";
import type { Env } from "./env";

/** What zp-landing's POST /api/onboard expects. event_id = project_id, so a retry resumes the same run. */
export function landingPayload(row: SessionRow) {
  return {
    event_id: row.project_id,
    company_name: row.client_name || row.spoc_name || row.client_email,
    contact_name: row.spoc_name || row.client_name,
    contact_email: row.spoc_email || row.client_email,
    scope_tier: row.tier,
  };
}

export interface LandingResult {
  status: number;
  /** zp-landing answered 200 but some optional step (HubSpot, Resend, Slack) failed. */
  partial: boolean;
  body: unknown;
}

/**
 * Hands a submitted client to zp-landing. Any 2xx counts as done: zp-landing keeps its own
 * per-step state keyed on event_id and only caches a run once everything finished.
 * Anything else throws, so the hourly cron tries again.
 */
export async function syncToLanding(env: Env, row: SessionRow, fetchImpl: typeof fetch = fetch): Promise<LandingResult> {
  const res = await fetchImpl(env.ZP_LANDING_ONBOARD_URL!, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Webhook-Secret": env.ZP_LANDING_WEBHOOK_SECRET! },
    body: JSON.stringify(landingPayload(row)),
  });
  const text = await res.text();
  let body: unknown = text;
  try {
    body = JSON.parse(text);
  } catch {
    // keep the raw text
  }
  if (!res.ok) throw new Error(`zp-landing onboard failed (${res.status}): ${text.slice(0, 300)}`);
  const partial = typeof body === "object" && body !== null && (body as { status?: string }).status === "partial";
  return { status: res.status, partial, body };
}
