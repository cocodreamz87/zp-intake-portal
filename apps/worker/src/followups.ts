import type { IntakePayload } from "@zinkpress/shared";
import { audit, nowIso, parseJson, type SessionRow } from "./db";
import { kickoffReceiptEmail, sendEmail } from "./email";
import { jiraConfigured, resendConfigured, type Env } from "./env";
import { provisionJiraSprint } from "./jira";
import { calculateSprintSchedule, DEFAULT_TIMEZONE, parseHolidays } from "./schedule";

/**
 * Work that happens after the clock starts: Jira epic and the kickoff receipt email.
 * Each part checks its own "done" column first, so running this twice is harmless.
 * It runs right after submit (in the background) and again from the cron job
 * for anything that failed, until it succeeds.
 */
export async function runPostSubmit(
  env: Env,
  sessionId: string,
  fetchImpl: typeof fetch = fetch,
  opts: { logSkips?: boolean } = {},
) {
  const logSkips = opts.logSkips ?? true;
  const row = await env.DB.prepare("SELECT * FROM onboarding_sessions WHERE id = ?").bind(sessionId).first<SessionRow>();
  if (!row || row.status !== "CLOCK_RUNNING" || !row.clock_started_at || !row.guaranteed_deadline) return;
  const errors: string[] = [];

  if (!row.jira_synced_at) {
    if (!jiraConfigured(env)) {
      if (logSkips) await audit(env.DB, row, "jira.skipped", "Jira settings are not filled in yet");
    } else {
      try {
        const copy = parseJson<IntakePayload["copy"] | null>(row.copy_json, null);
        const schedule = calculateSprintSchedule(new Date(row.submitted_at ?? row.clock_started_at), row.tier, {
          timeZone: env.BUSINESS_TIMEZONE || DEFAULT_TIMEZONE,
          holidays: parseHolidays(env.HOLIDAYS),
        });
        const result = await provisionJiraSprint(
          env,
          {
            projectId: row.project_id,
            clientName: row.client_name,
            tier: row.tier,
            githubTarget: row.github_target ?? "",
            registrarProvider: row.registrar_provider ?? "",
            copySummary: copy?.mode === "link" ? copy.url : "Typed into the intake form (see portal)",
            spocName: row.spoc_name ?? "",
            spocEmail: row.spoc_email ?? "",
            guaranteedDeadline: row.guaranteed_deadline,
            dueDate: schedule.deadlineLocalDate,
            knownEpicKey: row.jira_epic_key,
          },
          async (key) => {
            await env.DB.prepare("UPDATE onboarding_sessions SET jira_epic_key = ?, updated_at = ? WHERE id = ?")
              .bind(key, nowIso(), row.id)
              .run();
          },
          fetchImpl,
        );
        await env.DB.prepare("UPDATE onboarding_sessions SET jira_synced_at = ?, updated_at = ? WHERE id = ?")
          .bind(nowIso(), nowIso(), row.id)
          .run();
        await audit(env.DB, row, "jira.synced", result);
      } catch (err) {
        errors.push(`jira: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  }

  if (!row.receipt_sent_at) {
    if (!resendConfigured(env)) {
      if (logSkips) await audit(env.DB, row, "receipt.skipped", "RESEND_API_KEY is not set yet");
    } else {
      try {
        const mail = kickoffReceiptEmail(env, {
          clientName: row.client_name,
          projectId: row.project_id,
          clockStartedAt: row.clock_started_at,
          guaranteedDeadline: row.guaranteed_deadline,
        });
        const to = [row.client_email, row.spoc_email].filter((e, i, a): e is string => !!e && a.indexOf(e) === i);
        for (const addr of to) {
          await sendEmail(env, { to: addr, ...mail, idempotencyKey: `receipt-${row.id}-${addr}` }, fetchImpl);
        }
        await env.DB.prepare("UPDATE onboarding_sessions SET receipt_sent_at = ?, updated_at = ? WHERE id = ?")
          .bind(nowIso(), nowIso(), row.id)
          .run();
        await audit(env.DB, row, "receipt.sent", { to });
      } catch (err) {
        errors.push(`receipt: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  }

  await env.DB.prepare("UPDATE onboarding_sessions SET last_error = ?, updated_at = ? WHERE id = ?")
    .bind(errors.length ? errors.join(" | ").slice(0, 1000) : null, nowIso(), row.id)
    .run();
  if (errors.length) await audit(env.DB, row, "followup.failed", errors);
}

/** Daily (or hourly) housekeeping, run by the cron trigger in wrangler.toml. */
export async function runScheduled(env: Env, fetchImpl: typeof fetch = fetch) {
  const now = nowIso();

  // 1. Purge client API keys once the purge date passes (7 days after launch by default).
  const purge = await env.DB.prepare(
    `UPDATE onboarding_sessions
       SET encrypted_secrets_blob = NULL, secrets_iv = NULL, secrets_purged_at = ?, updated_at = ?
     WHERE secrets_purge_after IS NOT NULL AND secrets_purge_after <= ?
       AND secrets_purged_at IS NULL`,
  )
    .bind(now, now, now)
    .run();

  // 2. Links that ran out before the client finished.
  const expired = await env.DB.prepare(
    `UPDATE onboarding_sessions SET status = 'EXPIRED', updated_at = ?
     WHERE status = 'AWAITING_CREDENTIALS' AND token_expires_at <= ?`,
  )
    .bind(now, now)
    .run();

  // 3. Retry Jira/receipt for anything that failed earlier.
  const pending = await env.DB.prepare(
    `SELECT id FROM onboarding_sessions
     WHERE status = 'CLOCK_RUNNING' AND (jira_synced_at IS NULL OR receipt_sent_at IS NULL)
     ORDER BY submitted_at LIMIT 10`,
  ).all<{ id: string }>();
  for (const r of pending.results ?? []) await runPostSubmit(env, r.id, fetchImpl, { logSkips: false });

  const summary = {
    secretsPurged: purge.meta?.changes ?? 0,
    linksExpired: expired.meta?.changes ?? 0,
    followupsRetried: pending.results?.length ?? 0,
  };
  if (summary.secretsPurged || summary.linksExpired) await audit(env.DB, null, "cron", summary);
  return summary;
}
