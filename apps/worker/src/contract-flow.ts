/** Glue between D1, PandaDoc, Slack, R2 and zp-landing for the contract and launch steps. */
import { backupSignedContractToR2, draftContract, signedPdfKey } from "./contracts";
import { audit, nowIso, type SessionRow } from "./db";
import { landingConfigured, type Env } from "./env";
import { setLandingClientStatus, uploadContractToLanding } from "./landing";
import { postSlackMessage } from "./services/slack";
import { contractApprovalMessage, type ContractCard } from "./services/slack-interactive";

export function contractCard(row: SessionRow): ContractCard {
  return {
    projectId: row.project_id,
    clientName: row.legal_business_name || row.client_name,
    contactName: row.contact_name || row.client_name,
    contactEmail: row.client_email,
    tier: row.tier,
    amountCents: row.amount_cents,
    currency: row.currency,
    documentId: row.pandadoc_document_id ?? "",
  };
}

async function load(env: Env, id: string) {
  return env.DB.prepare("SELECT * FROM onboarding_sessions WHERE id = ?").bind(id).first<SessionRow>();
}

/** Draft the contract (if needed) and post it to #contract-approvals. */
export async function draftAndRequestApproval(env: Env, sessionId: string, fetchImpl: typeof fetch = fetch) {
  const row = await load(env, sessionId);
  if (!row) return { status: "skipped" as const, reason: "no session" };
  const outcome = await draftContract(env, row, fetchImpl);
  if (outcome.status !== "drafted") return outcome;
  const fresh = (await load(env, sessionId))!;
  const posted = await postSlackMessage(env, "CONTRACTS", contractApprovalMessage(contractCard(fresh)), fetchImpl);
  await audit(env.DB, fresh, "contract.approval_requested", { slack: posted.sent ? "posted" : posted.reason });
  return { ...outcome, slack: posted.sent };
}

/** Signed PDF -> R2 backup -> client's Drive (via zp-landing). Each part is skipped once done. */
export async function archiveSignedContract(env: Env, sessionId: string, fetchImpl: typeof fetch = fetch) {
  let row = await load(env, sessionId);
  if (!row || row.contract_status !== "SIGNED") return { r2: false, drive: false };
  if (!row.contract_r2_key) {
    await backupSignedContractToR2(env, row, fetchImpl);
    row = (await load(env, sessionId))!;
  }
  // The client's Drive folder exists only once zp-landing onboarded them (after the intake
  // form). A contract signed before that waits; the hourly job copies it over afterwards.
  if (!row.contract_drive_synced_at && landingConfigured(env) && row.landing_synced_at) {
    const obj = await env.ASSETS_BUCKET.get(row.contract_r2_key ?? signedPdfKey(row.project_id));
    if (!obj) throw new Error("signed contract is missing from R2");
    const bytes = new Uint8Array(await obj.arrayBuffer());
    const result = await uploadContractToLanding(env, row, bytes, `${row.project_id}-MSA-SOW-SIGNED.pdf`, fetchImpl);
    await env.DB.prepare("UPDATE onboarding_sessions SET contract_drive_synced_at = ?, updated_at = ? WHERE id = ?")
      .bind(nowIso(), nowIso(), row.id)
      .run();
    await audit(env.DB, row, "contract.drive_synced", { status: result.status, body: result.body });
    return { r2: true, drive: true };
  }
  return { r2: true, drive: Boolean(row.contract_drive_synced_at) };
}

/** After launch sign-off: Airtable Clients Status = "Complete" (via zp-landing). */
export async function markLandingComplete(env: Env, sessionId: string, fetchImpl: typeof fetch = fetch) {
  const row = await load(env, sessionId);
  if (!row || row.status !== "LAUNCHED" || row.landing_completed_at || !landingConfigured(env)) return false;
  const result = await setLandingClientStatus(env, row, "Complete", fetchImpl);
  await env.DB.prepare("UPDATE onboarding_sessions SET landing_completed_at = ?, updated_at = ? WHERE id = ?")
    .bind(nowIso(), nowIso(), row.id)
    .run();
  await audit(env.DB, row, "landing.completed", { status: result.status, body: result.body });
  return true;
}
