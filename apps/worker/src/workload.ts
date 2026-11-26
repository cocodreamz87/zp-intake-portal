import { audit } from "./db";
import type { Env } from "./env";
import { DEFAULT_TIMEZONE, isoDate, zonedParts } from "./schedule";
import { sendSlackAlert, tierLabel } from "./services/slack";

/** Hour (Eastern by default) when the daily check posts to #sprint-ops. */
export const DAILY_CHECK_HOUR = 8;
/** At this many sprints running at once, post a capacity heads-up. */
export const CAPACITY_ALERT_SPRINTS = 2;
/** A client who has had their intake link this long without submitting counts as stalled. */
export const STALLED_AFTER_HOURS = 48;

/**
 * Morning workload check, posted to #sprint-ops.
 *
 * The cron runs every hour (minute 17), so this only does anything on the run
 * that lands in the 8 AM hour in BUSINESS_TIMEZONE (8:17 AM Eastern), and only
 * once per day: it records that it posted in the audit log and skips if a
 * post already went out that day (for example after a manual /run-cron).
 * It posts only when there's something to say.
 */
export async function runDailyWorkloadCheck(env: Env, fetchImpl: typeof fetch = fetch, now = new Date()) {
  if (!env.SLACK_WEBHOOK_SPRINT_OPS) return { ran: false as const, reason: "slack_not_configured" };
  const timeZone = env.BUSINESS_TIMEZONE || DEFAULT_TIMEZONE;
  const local = zonedParts(now, timeZone);
  if (local.hour !== DAILY_CHECK_HOUR) return { ran: false as const, reason: "not_check_hour" };

  const today = isoDate(local);
  const marker = JSON.stringify({ date: today });
  const already = await env.DB.prepare("SELECT 1 AS x FROM audit_log WHERE event = 'daily_check.posted' AND detail = ?")
    .bind(marker)
    .first();
  if (already) return { ran: false as const, reason: "already_posted_today" };

  const active = await env.DB.prepare(
    `SELECT project_id, client_name, tier, guaranteed_deadline FROM onboarding_sessions
     WHERE status = 'CLOCK_RUNNING' ORDER BY guaranteed_deadline LIMIT 25`,
  ).all<{ project_id: string; client_name: string; tier: string; guaranteed_deadline: string | null }>();

  const stalledBefore = new Date(now.getTime() - STALLED_AFTER_HOURS * 3_600_000).toISOString();
  const stalled = await env.DB.prepare(
    `SELECT project_id, client_name, COALESCE(intake_email_sent_at, created_at) AS since FROM onboarding_sessions
     WHERE status = 'AWAITING_CREDENTIALS' AND COALESCE(intake_email_sent_at, created_at) <= ?
     ORDER BY since LIMIT 10`,
  )
    .bind(stalledBefore)
    .all<{ project_id: string; client_name: string; since: string }>();

  const sprints = active.results ?? [];
  const waiting = stalled.results ?? [];
  const posts: string[] = [];

  const deadline = (iso: string | null) =>
    iso
      ? new Intl.DateTimeFormat("en-US", { timeZone, weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }).format(new Date(iso))
      : "no deadline";

  if (sprints.length >= CAPACITY_ALERT_SPRINTS) {
    const r = await sendSlackAlert(
      env,
      {
        channel: "SPRINT_OPS",
        title: `⚠️ ${sprints.length} sprints running at once`,
        note:
          `You're at capacity. Consider pausing the 9 AM outbound audits today.\n` +
          sprints.map((s) => `• ${s.project_id} (${s.client_name}, ${tierLabel(s.tier)}): due ${deadline(s.guaranteed_deadline)}`).join("\n"),
      },
      fetchImpl,
    );
    if (r.sent) posts.push("capacity");
  }

  if (waiting.length) {
    const hours = (iso: string) => Math.floor((now.getTime() - new Date(iso).getTime()) / 3_600_000);
    const r = await sendSlackAlert(
      env,
      {
        channel: "SPRINT_OPS",
        title: `⏳ ${waiting.length} paid client${waiting.length === 1 ? "" : "s"} stuck on the intake form`,
        note:
          `These clients got their intake link over ${STALLED_AFTER_HOURS} hours ago and haven't submitted, so their clock hasn't started.\n` +
          waiting.map((w) => `• ${w.project_id} (${w.client_name}): waiting ${hours(w.since)} hours`).join("\n"),
      },
      fetchImpl,
    );
    if (r.sent) posts.push("stalled");
  }

  if (posts.length) await audit(env.DB, null, "daily_check.posted", { date: today });
  return { ran: true as const, activeSprints: sprints.length, stalledClients: waiting.length, posted: posts };
}
