import { audit, type SessionRow } from "./db";
import { formatInZone, milestoneFullEmail, milestoneHalfEmail, sendEmail, testimonialRequestEmail } from "./email";
import { numberVar, resendConfigured, type Env } from "./env";
import { BUSINESS_DAYS_BY_TIER, DEFAULT_TIMEZONE, halfwayDay, parseHolidays, sprintProgress } from "./schedule";
import { sendSlackAlert, tierLabel } from "./services/slack";
import { testimonialLink } from "./testimonials";

/** An email whose moment passed more than this long ago is skipped, so turning Resend on later can't send a backlog. */
const STALE_MS = 48 * 3_600_000;
const TESTIMONIAL_WINDOW_DAYS = 30;

function recipients(row: SessionRow) {
  return [row.spoc_email, row.client_email].filter((e, i, a): e is string => !!e && a.indexOf(e) === i);
}

/**
 * Hourly (from the cron): the 50% and 100% sprint emails, the #sprint-ops alert when a deadline
 * arrives before staging is in review, and the testimonial request 3 days after launch.
 *
 * Without Resend (no RESEND_API_KEY or RECEIPT_FROM_EMAIL) every email here is a no-op: nothing is
 * sent, nothing is marked, nothing is logged. The Slack deadline alert doesn't need Resend.
 */
export async function runMilestones(env: Env, fetchImpl: typeof fetch, now = new Date(), portalBase: string | null = null) {
  const out = { halfSent: 0, fullSent: 0, deadlineAlerts: 0, testimonialRequests: 0 };
  const timeZone = env.BUSINESS_TIMEZONE || DEFAULT_TIMEZONE;
  const holidays = parseHolidays(env.HOLIDAYS);
  const email = resendConfigured(env);
  const at = now.toISOString();

  const mark = (row: SessionRow, col: string) =>
    env.DB.prepare(`UPDATE onboarding_sessions SET ${col} = ?, updated_at = ? WHERE id = ?`).bind(at, at, row.id).run();

  // 1. Running sprints and sprints whose deadline may have arrived.
  const running =
    (
      await env.DB.prepare(
        `SELECT * FROM onboarding_sessions
         WHERE status IN ('CLOCK_RUNNING', 'IN_REVIEW') AND clock_started_at IS NOT NULL AND guaranteed_deadline IS NOT NULL
           AND (milestone_half_sent_at IS NULL OR milestone_full_sent_at IS NULL OR deadline_alert_sent_at IS NULL)
         ORDER BY clock_started_at LIMIT 25`,
      ).all<SessionRow>()
    ).results ?? [];

  for (const row of running) {
    const p = sprintProgress(row.clock_started_at!, row.guaranteed_deadline!, now, { timeZone, holidays });
    const deadlineMs = new Date(row.guaranteed_deadline!).getTime();

    // 50%: day 3 of 5, 5 of 10, 10 of 20, while the sprint is still building.
    if (!row.milestone_half_sent_at && email) {
      if (row.status !== "CLOCK_RUNNING" || p.deadlineReached) {
        await mark(row, "milestone_half_sent_at");
        await audit(env.DB, row, "milestone.half_skipped", { reason: row.status !== "CLOCK_RUNNING" ? "already in review" : "deadline already reached" });
      } else if (p.businessDaysElapsed >= halfwayDay(p.businessDaysTotal)) {
        const mail = milestoneHalfEmail(env, {
          clientName: row.client_name,
          projectId: row.project_id,
          elapsed: p.businessDaysElapsed,
          total: p.businessDaysTotal,
          guaranteedDeadline: row.guaranteed_deadline!,
        });
        const to = recipients(row);
        for (const addr of to) await sendEmail(env, { to: addr, ...mail, idempotencyKey: `milestone50-${row.id}-${addr}` }, fetchImpl);
        await mark(row, "milestone_half_sent_at");
        await audit(env.DB, row, "milestone.half_sent", { to, day: p.businessDaysElapsed, of: p.businessDaysTotal });
        out.halfSent++;
      }
    }

    if (!p.deadlineReached) continue;

    // 100%: the deadline has arrived.
    if (!row.milestone_full_sent_at && email) {
      if (now.getTime() - deadlineMs > STALE_MS) {
        await mark(row, "milestone_full_sent_at");
        await audit(env.DB, row, "milestone.full_skipped", { reason: "deadline passed more than 48 hours ago" });
      } else {
        const mail = milestoneFullEmail(env, {
          clientName: row.client_name,
          projectId: row.project_id,
          total: p.businessDaysTotal,
          inReview: row.status === "IN_REVIEW",
        });
        const to = recipients(row);
        for (const addr of to) await sendEmail(env, { to: addr, ...mail, idempotencyKey: `milestone100-${row.id}-${addr}` }, fetchImpl);
        await mark(row, "milestone_full_sent_at");
        await audit(env.DB, row, "milestone.full_sent", { to, inReview: row.status === "IN_REVIEW" });
        out.fullSent++;
      }
    }

    // Internal heads-up: deadline is here and staging isn't in review yet.
    if (!row.deadline_alert_sent_at) {
      if (row.status === "CLOCK_RUNNING") {
        await sendSlackAlert(
          env,
          {
            channel: "SPRINT_OPS",
            title: `⏰ Deadline reached, staging not in review: ${row.project_id}`,
            fields: [
              { label: "Client", value: row.client_name },
              { label: "Tier", value: tierLabel(row.tier) },
              { label: "Deadline", value: formatInZone(row.guaranteed_deadline!, timeZone) },
            ],
            note: "Send the review link (ready-for-review) as soon as staging is up.",
          },
          fetchImpl,
        );
        out.deadlineAlerts++;
      }
      await mark(row, "deadline_alert_sent_at");
    }
  }

  // 2. Testimonial request, TESTIMONIAL_DELAY_DAYS (3) after launch. Needs email and a link base.
  if (email && portalBase) {
    const delayMs = numberVar(env.TESTIMONIAL_DELAY_DAYS, 3) * 86_400_000;
    const launched =
      (
        await env.DB.prepare(
          `SELECT * FROM onboarding_sessions
           WHERE status = 'LAUNCHED' AND launched_at IS NOT NULL AND testimonial_requested_at IS NULL
           ORDER BY launched_at LIMIT 10`,
        ).all<SessionRow>()
      ).results ?? [];
    for (const row of launched) {
      const age = now.getTime() - new Date(row.launched_at!).getTime();
      if (age < delayMs) continue;
      if (age > TESTIMONIAL_WINDOW_DAYS * 86_400_000) {
        await mark(row, "testimonial_requested_at");
        await audit(env.DB, row, "testimonial.skipped", { reason: `launched more than ${TESTIMONIAL_WINDOW_DAYS} days ago` });
        continue;
      }
      const link = await testimonialLink(env.DB, row, TESTIMONIAL_WINDOW_DAYS);
      if (link.status !== "REQUESTED") {
        // They already sent one (you may have shared the link by hand).
        await mark(row, "testimonial_requested_at");
        continue;
      }
      const mail = testimonialRequestEmail(env, {
        clientName: row.spoc_name || row.client_name,
        projectId: row.project_id,
        link: `${portalBase}/testimonial?token=${link.token}`,
        businessDays: BUSINESS_DAYS_BY_TIER[row.tier],
      });
      const to = recipients(row);
      for (const addr of to) await sendEmail(env, { to: addr, ...mail, idempotencyKey: `testimonial-${row.id}-${link.expiresAt}-${addr}` }, fetchImpl);
      await mark(row, "testimonial_requested_at");
      await audit(env.DB, row, "testimonial.requested", { to });
      out.testimonialRequests++;
    }
  }
  return out;
}
