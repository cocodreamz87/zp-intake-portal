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

/** zp-landing's base address, from ZP_LANDING_ONBOARD_URL (…/api/onboard). */
export function landingBase(env: Env): string | null {
  try {
    const u = new URL(env.ZP_LANDING_ONBOARD_URL!);
    return u.origin;
  } catch {
    return null;
  }
}

async function landingCall(env: Env, path: string, init: RequestInit, fetchImpl: typeof fetch) {
  const base = landingBase(env);
  if (!base || !env.ZP_LANDING_WEBHOOK_SECRET) throw new Error("ZP_LANDING_ONBOARD_URL or ZP_LANDING_WEBHOOK_SECRET is not set");
  const res = await fetchImpl(`${base}${path}`, {
    ...init,
    headers: { ...(init.headers as Record<string, string>), "X-Webhook-Secret": env.ZP_LANDING_WEBHOOK_SECRET },
  });
  const text = await res.text();
  let body: unknown = text;
  try {
    body = JSON.parse(text);
  } catch {
    /* keep text */
  }
  // 409 = zp-landing hasn't onboarded this client yet (no Drive folder / Airtable row). The cron retries.
  if (!res.ok) throw new Error(`zp-landing ${path} failed (${res.status}): ${text.slice(0, 300)}`);
  return { status: res.status, body };
}

/** Copies the signed contract PDF into the client's Drive "01_Contracts_and_Scope" folder via zp-landing. */
export async function uploadContractToLanding(env: Env, row: SessionRow, pdf: Uint8Array, fileName: string, fetchImpl: typeof fetch = fetch) {
  const q = new URLSearchParams({ project_id: row.project_id, file_name: fileName });
  return landingCall(env, `/api/contracts/upload?${q}`, { method: "POST", headers: { "Content-Type": "application/pdf" }, body: pdf }, fetchImpl);
}

/** Sets the client's Airtable Clients "Status" (via zp-landing). */
export async function setLandingClientStatus(env: Env, row: SessionRow, status: "Complete", fetchImpl: typeof fetch = fetch) {
  return landingCall(
    env,
    "/api/clients/status",
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ project_id: row.project_id, status, contact_email: row.spoc_email || row.client_email, company_name: row.client_name }),
    },
    fetchImpl,
  );
}
