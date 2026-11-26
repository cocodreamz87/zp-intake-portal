/**
 * PandaDoc contract pipeline: Populate -> Slack approve -> Send -> Archive & back up.
 *
 *  1. draftContract(): creates the MSA/SOW from PANDADOC_TEMPLATE_ID with the project's
 *     tokens and a "Client" recipient. contract_status = DRAFT_PENDING_APPROVAL.
 *     Runs on invoice.paid, from POST /api/contracts/draft, and from the hourly cron
 *     for any paid project that has no draft yet. Before creating, it looks for a
 *     document already tagged with this project_id, so a retry never makes a second one.
 *  2. The draft is posted to #contract-approvals with an "Approve & Send Contract" button.
 *  3. sendContract(): on the click (or POST /api/admin/sessions/:id/send-contract),
 *     PandaDoc emails it to the client. contract_status = SENT.
 *  4. On PandaDoc's document.completed webhook: contract_status = SIGNED, then
 *     archiveSignedContract() downloads the signed PDF into R2 and hands a copy to
 *     zp-landing for the client's Drive "01_Contracts_and_Scope" folder (cron retries).
 */
import { hmacSha256Hex, timingSafeEqual } from "./crypto";
import { audit, nowIso, type SessionRow } from "./db";
import type { Env } from "./env";
import { formatMoney, tierLabel } from "./services/slack";
import { BUSINESS_DAYS_BY_TIER, DEFAULT_TIMEZONE } from "./schedule";

const PANDADOC = "https://api.pandadoc.com/public/v1";

export function pandadocConfigured(env: Env) {
  return Boolean(env.PANDADOC_API_KEY && env.PANDADOC_TEMPLATE_ID);
}

function headers(env: Env, json = true) {
  return { Authorization: `API-Key ${env.PANDADOC_API_KEY}`, ...(json ? { "Content-Type": "application/json" } : {}) };
}

async function pd<T>(env: Env, path: string, init: RequestInit, fetchImpl: typeof fetch): Promise<{ status: number; body: T }> {
  const res = await fetchImpl(`${PANDADOC}${path}`, init);
  const text = await res.text();
  if (!res.ok) {
    const err = new Error(`PandaDoc ${init.method ?? "GET"} ${path.split("?")[0]} failed (${res.status}): ${text.slice(0, 400)}`);
    (err as any).status = res.status;
    throw err;
  }
  let body: any = null;
  try {
    body = JSON.parse(text);
  } catch {
    body = text;
  }
  return { status: res.status, body };
}

function splitName(full: string) {
  const parts = full.trim().split(/\s+/).filter(Boolean);
  return { first: parts[0] ?? "", last: parts.slice(1).join(" ") };
}

export function contractDate(iso: string, timeZone = DEFAULT_TIMEZONE) {
  return new Intl.DateTimeFormat("en-US", { timeZone, month: "long", day: "numeric", year: "numeric" }).format(new Date(iso));
}

/** The template tokens. Names match the spec exactly; add the same names as variables in your PandaDoc template. */
export function contractTokens(env: Env, row: SessionRow, now = new Date()) {
  const tz = env.BUSINESS_TIMEZONE || DEFAULT_TIMEZONE;
  const company = row.legal_business_name || row.client_name;
  return [
    { name: "Client.CompanyName", value: company },
    { name: "Client.ContactName", value: row.contact_name || row.spoc_name || row.client_name },
    { name: "Client.Email", value: row.client_email },
    { name: "Project.ID", value: row.project_id },
    { name: "Project.Tier", value: tierLabel(row.tier) },
    { name: "Project.DeliveryBusinessDays", value: String(BUSINESS_DAYS_BY_TIER[row.tier]) },
    { name: "Project.Amount", value: formatMoney(row.amount_cents, row.currency) },
    // The day the contract is drafted (the client paid). The sprint clock itself starts after intake.
    { name: "Project.StartDate", value: contractDate(row.clock_started_at ?? now.toISOString(), tz) },
  ];
}

export function contractPayload(env: Env, row: SessionRow, now = new Date()) {
  const signer = splitName(row.contact_name || row.client_name);
  return {
    name: `${row.project_id} · ${row.legal_business_name || row.client_name} · MSA + SOW`,
    template_uuid: env.PANDADOC_TEMPLATE_ID,
    recipients: [{ email: row.client_email, first_name: signer.first, last_name: signer.last, role: "Client" }],
    tokens: contractTokens(env, row, now),
    metadata: { project_id: row.project_id, tier: row.tier },
    tags: ["zinkpress", row.tier.toLowerCase()],
  };
}

/** Finds a document already made for this project (PandaDoc filters by metadata_<key>). */
async function findExisting(env: Env, projectId: string, fetchImpl: typeof fetch): Promise<string | null> {
  const { body } = await pd<{ results?: Array<{ id: string; status: string }> }>(
    env,
    `/documents?metadata_project_id=${encodeURIComponent(projectId)}&count=5`,
    { headers: headers(env, false) },
    fetchImpl,
  );
  const live = (body?.results ?? []).filter((d) => d.status !== "document.voided" && d.status !== "document.declined");
  return live[0]?.id ?? null;
}

export type DraftOutcome =
  | { status: "drafted"; documentId: string; reused: boolean }
  | { status: "exists"; documentId: string }
  | { status: "skipped"; reason: string };

/** Creates the draft (once) and saves its id. Throws on PandaDoc errors so the caller/cron retries. */
export async function draftContract(env: Env, row: SessionRow, fetchImpl: typeof fetch = fetch): Promise<DraftOutcome> {
  if (row.pandadoc_document_id) return { status: "exists", documentId: row.pandadoc_document_id };
  if (!pandadocConfigured(env)) return { status: "skipped", reason: "PANDADOC_API_KEY or PANDADOC_TEMPLATE_ID is not set" };

  let documentId = await findExisting(env, row.project_id, fetchImpl);
  const reused = Boolean(documentId);
  if (!documentId) {
    const { body } = await pd<{ id: string }>(
      env,
      "/documents",
      { method: "POST", headers: headers(env), body: JSON.stringify(contractPayload(env, row)) },
      fetchImpl,
    );
    documentId = body.id;
  }
  const r = await env.DB.prepare(
    `UPDATE onboarding_sessions SET pandadoc_document_id = ?, contract_status = 'DRAFT_PENDING_APPROVAL',
       contract_drafted_at = ?, updated_at = ? WHERE id = ? AND pandadoc_document_id IS NULL`,
  )
    .bind(documentId, nowIso(), nowIso(), row.id)
    .run();
  if ((r.meta?.changes ?? 0) === 0) return { status: "exists", documentId };
  await audit(env.DB, row, "contract.drafted", { documentId, reused });
  return { status: "drafted", documentId, reused };
}

export type SendOutcome =
  | { status: "sent"; documentId: string }
  | { status: "already"; contractStatus: string | null }
  | { status: "not_ready"; reason: string };

/**
 * Sends the draft for signature. Claims the row first (DRAFT_PENDING_APPROVAL -> SENDING),
 * so a double click or two approvers at once send it only once.
 */
export async function sendContract(
  env: Env,
  row: SessionRow,
  approver: string,
  fetchImpl: typeof fetch = fetch,
): Promise<SendOutcome> {
  if (!row.pandadoc_document_id) return { status: "not_ready", reason: "No contract draft yet." };
  if (!env.PANDADOC_API_KEY) return { status: "not_ready", reason: "PANDADOC_API_KEY is not set." };

  const claim = await env.DB.prepare(
    "UPDATE onboarding_sessions SET contract_status = 'SENDING', updated_at = ? WHERE id = ? AND contract_status = 'DRAFT_PENDING_APPROVAL'",
  )
    .bind(nowIso(), row.id)
    .run();
  if ((claim.meta?.changes ?? 0) === 0) {
    const fresh = await env.DB.prepare("SELECT contract_status FROM onboarding_sessions WHERE id = ?").bind(row.id).first<{ contract_status: string | null }>();
    return { status: "already", contractStatus: fresh?.contract_status ?? null };
  }

  const release = async () =>
    env.DB.prepare("UPDATE onboarding_sessions SET contract_status = 'DRAFT_PENDING_APPROVAL', updated_at = ? WHERE id = ? AND contract_status = 'SENDING'")
      .bind(nowIso(), row.id)
      .run();

  try {
    // PandaDoc builds a new document in the background ("document.uploaded"); it can only be sent once it's a draft.
    const { body: doc } = await pd<{ status: string }>(
      env,
      `/documents/${encodeURIComponent(row.pandadoc_document_id)}`,
      { headers: headers(env, false) },
      fetchImpl,
    );
    if (doc.status === "document.uploaded") {
      await release();
      return { status: "not_ready", reason: "PandaDoc is still preparing the draft. Try again in a few seconds." };
    }
    if (doc.status !== "document.draft") {
      // Already sent or signed in PandaDoc (for example from PandaDoc's own screen). Record it.
      const status = doc.status === "document.completed" ? "SIGNED" : doc.status === "document.voided" ? "VOIDED" : doc.status === "document.declined" ? "DECLINED" : "SENT";
      await env.DB.prepare("UPDATE onboarding_sessions SET contract_status = ?, contract_sent_at = COALESCE(contract_sent_at, ?), updated_at = ? WHERE id = ?")
        .bind(status, nowIso(), nowIso(), row.id)
        .run();
      return { status: "already", contractStatus: status };
    }
    await pd(
      env,
      `/documents/${encodeURIComponent(row.pandadoc_document_id)}/send`,
      {
        method: "POST",
        headers: headers(env),
        body: JSON.stringify({
          subject: `${env.AGENCY_NAME}: your agreement for ${row.project_id}`,
          message: `Hi, here is your ${env.AGENCY_NAME} Master Services Agreement and Statement of Work for ${row.project_id}. Questions? Write to ${env.AGENCY_EMAIL}.`,
          silent: false,
        }),
      },
      fetchImpl,
    );
  } catch (err) {
    await release();
    throw err;
  }

  const at = nowIso();
  await env.DB.prepare(
    "UPDATE onboarding_sessions SET contract_status = 'SENT', contract_sent_at = ?, contract_approved_by = ?, updated_at = ? WHERE id = ?",
  )
    .bind(at, approver.slice(0, 200), at, row.id)
    .run();
  await audit(env.DB, row, "contract.sent", { documentId: row.pandadoc_document_id, approvedBy: approver });
  return { status: "sent", documentId: row.pandadoc_document_id };
}

/* ---------------------------- PandaDoc webhook ---------------------------- */

/**
 * PandaDoc signs webhooks with the shared key from Settings > Webhooks:
 * the request URL gets ?signature=<hex HMAC-SHA256(shared key, raw body)>.
 */
export async function verifyPandadocSignature(rawBody: string, signature: string | null | undefined, key: string | undefined) {
  if (!key || !signature || !/^[0-9a-f]{64}$/i.test(signature)) return false;
  return timingSafeEqual(signature.toLowerCase(), await hmacSha256Hex(key, rawBody));
}

/** PandaDoc status -> our contract_status. */
export function contractStatusFor(pandadocStatus: string): "SENT" | "SIGNED" | "DECLINED" | "VOIDED" | null {
  switch (pandadocStatus) {
    case "document.sent":
    case "document.viewed":
    case "document.waiting_approval":
    case "document.approved":
    case "document.waiting_pay":
      return "SENT";
    case "document.completed":
    case "document.paid":
      return "SIGNED";
    case "document.declined":
      return "DECLINED";
    case "document.voided":
      return "VOIDED";
    default:
      return null;
  }
}

export function signedPdfKey(projectId: string) {
  return `${projectId}/contracts/${projectId}-MSA-SOW-SIGNED.pdf`;
}

/** Downloads the signed PDF into R2 (once). Throws on failure; the cron retries. */
export async function backupSignedContractToR2(env: Env, row: SessionRow, fetchImpl: typeof fetch = fetch): Promise<string> {
  if (row.contract_r2_key) return row.contract_r2_key;
  if (!row.pandadoc_document_id) throw new Error("no PandaDoc document id");
  if (!env.PANDADOC_API_KEY) throw new Error("PANDADOC_API_KEY is not set");
  const res = await fetchImpl(`${PANDADOC}/documents/${encodeURIComponent(row.pandadoc_document_id)}/download`, {
    headers: headers(env, false),
  });
  if (!res.ok) throw new Error(`PandaDoc download failed (${res.status}): ${(await res.text()).slice(0, 300)}`);
  const bytes = new Uint8Array(await res.arrayBuffer());
  // A real PDF starts with "%PDF".
  if (bytes.length < 5 || String.fromCharCode(...bytes.slice(0, 4)) !== "%PDF") throw new Error("PandaDoc download was not a PDF");
  const key = signedPdfKey(row.project_id);
  await env.ASSETS_BUCKET.put(key, bytes, {
    httpMetadata: { contentType: "application/pdf" },
    customMetadata: { projectId: row.project_id, pandadocDocumentId: row.pandadoc_document_id, signedAt: row.contract_signed_at ?? "" },
  });
  await env.DB.prepare("UPDATE onboarding_sessions SET contract_r2_key = ?, updated_at = ? WHERE id = ?").bind(key, nowIso(), row.id).run();
  await audit(env.DB, row, "contract.backed_up", { key, bytes: bytes.length });
  return key;
}
