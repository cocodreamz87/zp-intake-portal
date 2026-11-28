import type { PublicTestimonial, Tier } from "@zinkpress/shared";
import { generateToken, sha256Hex } from "./crypto";
import { addDaysIso, nowIso, type SessionRow } from "./db";
import { BUSINESS_DAYS_BY_TIER } from "./schedule";

export interface TestimonialRow {
  id: string;
  session_id: string;
  project_id: string;
  token_hash: string;
  token_expires_at: string;
  status: "REQUESTED" | "PENDING" | "APPROVED" | "REJECTED";
  quote: string | null;
  author_name: string | null;
  author_role: string | null;
  company: string | null;
  link_url: string | null;
  consent_at: string | null;
  consent_ip: string | null;
  headline: string | null;
  submitted_at: string | null;
  reviewed_at: string | null;
  created_at: string;
  updated_at: string;
}

/**
 * The testimonial link for a project: makes the row the first time, otherwise gives the
 * existing row a fresh token (the old link stops working). A quote the client already sent stays.
 */
export async function testimonialLink(db: D1Database, row: SessionRow, ttlDays: number) {
  const token = generateToken();
  const hash = await sha256Hex(token);
  const expiresAt = addDaysIso(ttlDays);
  const existing = await db.prepare("SELECT * FROM testimonials WHERE session_id = ?").bind(row.id).first<TestimonialRow>();
  if (existing) {
    await db
      .prepare("UPDATE testimonials SET token_hash = ?, token_expires_at = ?, updated_at = ? WHERE id = ?")
      .bind(hash, expiresAt, nowIso(), existing.id)
      .run();
    return { id: existing.id, token, expiresAt, status: existing.status };
  }
  const id = crypto.randomUUID();
  await db
    .prepare("INSERT INTO testimonials (id, session_id, project_id, token_hash, token_expires_at) VALUES (?, ?, ?, ?, ?)")
    .bind(id, row.id, row.project_id, hash, expiresAt)
    .run();
  return { id, token, expiresAt, status: "REQUESTED" as const };
}

export async function findTestimonialByToken(db: D1Database, token: string) {
  return db.prepare("SELECT * FROM testimonials WHERE token_hash = ?").bind(await sha256Hex(token)).first<TestimonialRow>();
}

/** Approved quotes, newest first. Only fields the client agreed to show. */
export async function approvedTestimonials(db: D1Database, limit = 12): Promise<PublicTestimonial[]> {
  const rows =
    (
      await db
        .prepare(
          `SELECT t.*, s.tier AS tier FROM testimonials t JOIN onboarding_sessions s ON s.id = t.session_id
           WHERE t.status = 'APPROVED' AND t.consent_at IS NOT NULL ORDER BY t.reviewed_at DESC LIMIT ?`,
        )
        .bind(limit)
        .all<TestimonialRow & { tier: Tier }>()
    ).results ?? [];
  return rows.map((t) => ({
    id: t.id,
    quote: t.quote ?? "",
    authorName: t.author_name ?? "",
    authorRole: t.author_role,
    company: t.company,
    headline: t.headline,
    tier: t.tier,
    businessDays: BUSINESS_DAYS_BY_TIER[t.tier],
    linkUrl: t.link_url,
    approvedAt: t.reviewed_at ?? t.updated_at,
  }));
}
