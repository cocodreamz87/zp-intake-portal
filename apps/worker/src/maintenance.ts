import { generateToken, sha256Hex } from "./crypto";
import { addDaysIso, nowIso, type SessionRow } from "./db";

export interface MaintenanceRow {
  id: string;
  session_id: string;
  project_id: string;
  token_hash: string;
  token_expires_at: string;
  required_integrations_json: string;
  note: string | null;
  status: "OPEN" | "SUBMITTED" | "DONE" | "EXPIRED";
  encrypted_secrets_blob: string | null;
  secrets_iv: string | null;
  submitted_at: string | null;
  done_at: string | null;
  secrets_purge_after: string | null;
  secrets_purged_at: string | null;
  created_at: string;
  updated_at: string;
}

/**
 * A new re-auth link for a launched project. Any earlier open link for the same project stops
 * working, so only the newest email is live. Returns the plain token once; only its hash is stored.
 */
export async function createMaintenanceRequest(
  db: D1Database,
  row: SessionRow,
  opts: { requiredIntegrations: string[]; note: string | null; ttlDays: number },
) {
  const now = nowIso();
  await db
    .prepare("UPDATE maintenance_requests SET status = 'EXPIRED', updated_at = ? WHERE project_id = ? AND status = 'OPEN'")
    .bind(now, row.project_id)
    .run();
  const id = crypto.randomUUID();
  const token = generateToken();
  const expiresAt = addDaysIso(opts.ttlDays);
  await db
    .prepare(
      `INSERT INTO maintenance_requests (id, session_id, project_id, token_hash, token_expires_at, required_integrations_json, note)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(id, row.id, row.project_id, await sha256Hex(token), expiresAt, JSON.stringify(opts.requiredIntegrations), opts.note)
    .run();
  return { id, token, expiresAt };
}

export async function findMaintenanceByToken(db: D1Database, token: string) {
  return db.prepare("SELECT * FROM maintenance_requests WHERE token_hash = ?").bind(await sha256Hex(token)).first<MaintenanceRow>();
}

export function maintenanceLive(m: MaintenanceRow, now = new Date()) {
  return m.status === "OPEN" && new Date(m.token_expires_at).getTime() > now.getTime();
}

/** Hourly: wipe re-entered keys past their purge date, and close links that ran out unused. */
export async function maintenanceHousekeeping(db: D1Database, now = nowIso()) {
  const purged = await db
    .prepare(
      `UPDATE maintenance_requests SET encrypted_secrets_blob = NULL, secrets_iv = NULL, secrets_purged_at = ?, updated_at = ?
       WHERE secrets_purge_after IS NOT NULL AND secrets_purge_after <= ? AND secrets_purged_at IS NULL`,
    )
    .bind(now, now, now)
    .run();
  const expired = await db
    .prepare("UPDATE maintenance_requests SET status = 'EXPIRED', updated_at = ? WHERE status = 'OPEN' AND token_expires_at <= ?")
    .bind(now, now)
    .run();
  return { maintenanceKeysPurged: purged.meta?.changes ?? 0, maintenanceLinksExpired: expired.meta?.changes ?? 0 };
}
