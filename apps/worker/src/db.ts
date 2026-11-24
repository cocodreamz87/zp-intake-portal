import type { SessionStatus, Tier } from "@zinkpress/shared";
import { generateToken, sha256Hex } from "./crypto";

export interface SessionRow {
  id: string;
  project_id: string;
  client_name: string;
  client_email: string;
  tier: Tier;
  status: SessionStatus;
  token_hash: string;
  token_expires_at: string;
  stripe_invoice_id: string | null;
  required_integrations_json: string;
  registrar_provider: string | null;
  github_target: string | null;
  github_verified: number;
  brand_config_json: string | null;
  copy_source_url: string | null;
  copy_json: string | null;
  admin_emails_json: string | null;
  encrypted_secrets_blob: string | null;
  secrets_iv: string | null;
  spoc_name: string | null;
  spoc_email: string | null;
  submitted_at: string | null;
  clock_started_at: string | null;
  guaranteed_deadline: string | null;
  intake_email_sent_at: string | null;
  jira_epic_key: string | null;
  jira_synced_at: string | null;
  receipt_sent_at: string | null;
  last_error: string | null;
  launched_at: string | null;
  secrets_purge_after: string | null;
  secrets_purged_at: string | null;
  created_at: string;
  updated_at: string;
}

export const nowIso = () => new Date().toISOString();

export function addDaysIso(days: number, from = new Date()): string {
  return new Date(from.getTime() + days * 86_400_000).toISOString();
}

export async function audit(db: D1Database, row: Pick<SessionRow, "id" | "project_id"> | null, event: string, detail?: unknown) {
  await db
    .prepare("INSERT INTO audit_log (session_id, project_id, event, detail) VALUES (?, ?, ?, ?)")
    .bind(row?.id ?? null, row?.project_id ?? null, event, detail === undefined ? null : JSON.stringify(detail).slice(0, 2000))
    .run();
}

export async function findSessionByToken(db: D1Database, token: string): Promise<SessionRow | null> {
  const hash = await sha256Hex(token);
  return db.prepare("SELECT * FROM onboarding_sessions WHERE token_hash = ?").bind(hash).first<SessionRow>();
}

export async function findSessionByProject(db: D1Database, projectId: string): Promise<SessionRow | null> {
  return db.prepare("SELECT * FROM onboarding_sessions WHERE project_id = ?").bind(projectId).first<SessionRow>();
}

export function isTokenLive(row: SessionRow, now = new Date()): boolean {
  return row.status !== "EXPIRED" && new Date(row.token_expires_at).getTime() > now.getTime();
}

export interface NewSession {
  projectId: string;
  clientName: string;
  clientEmail: string;
  tier: Tier;
  requiredIntegrations: string[];
  stripeInvoiceId?: string | null;
  tokenTtlDays: number;
}

/** Creates the session and returns the one-time plain token (only its hash is stored). */
export async function createSession(db: D1Database, s: NewSession) {
  const token = generateToken();
  const id = crypto.randomUUID();
  const expiresAt = addDaysIso(s.tokenTtlDays);
  await db
    .prepare(
      `INSERT INTO onboarding_sessions
        (id, project_id, client_name, client_email, tier, token_hash, token_expires_at, stripe_invoice_id, required_integrations_json)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      id,
      s.projectId,
      s.clientName,
      s.clientEmail,
      s.tier,
      await sha256Hex(token),
      expiresAt,
      s.stripeInvoiceId ?? null,
      JSON.stringify(s.requiredIntegrations),
    )
    .run();
  return { id, token, expiresAt };
}

/** New link for the same project. The old link stops working immediately. */
export async function reissueToken(db: D1Database, row: SessionRow, ttlDays: number) {
  const token = generateToken();
  const expiresAt = addDaysIso(ttlDays);
  const status = row.status === "EXPIRED" ? "AWAITING_CREDENTIALS" : row.status;
  await db
    .prepare("UPDATE onboarding_sessions SET token_hash = ?, token_expires_at = ?, status = ?, updated_at = ? WHERE id = ?")
    .bind(await sha256Hex(token), expiresAt, status, nowIso(), row.id)
    .run();
  return { token, expiresAt };
}

export function parseJson<T>(s: string | null | undefined, fallback: T): T {
  if (!s) return fallback;
  try {
    return JSON.parse(s) as T;
  } catch {
    return fallback;
  }
}
