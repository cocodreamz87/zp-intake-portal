import type { IntakePayload } from "@zinkpress/shared";
import { audit, nowIso, parseJson, type SessionRow } from "./db";
import { kickoffReceiptEmail, sendEmail } from "./email";
import { jiraConfigured, landingConfigured, resendConfigured, type Env } from "./env";
import { syncToLanding } from "./landing";
import { provisionJiraSprint } from "./jira";
import { calculateSprintSchedule, DEFAULT_TIMEZONE, parseHolidays } from "./schedule";
import { sendSlackAlert, tierLabel } from "./services/slack";
import { runDailyWorkloadCheck } from "./workload";
import { reportingFetch, reportWorkerError } from "./services/errors";
import { archiveSignedContract, draftAndRequestApproval, markLandingComplete } from "./contract-flow";
import { pandadocConfigured } from "./contracts";

/**
 * Work that happens after the clock starts: Jira epic, the kickoff receipt email, and handing
 * the client to zp-landing (Drive, Airtable, HubSpot, welcome email, Slack).
 * Each part checks its own "done" column first, so running this twice is harmless.
 * It runs right after submit (in the background) and again from the cron job
 * for anything that failed, until it succeeds.
 */
export async function runPostSubmit(
  env: Env,
  sessionId: string,
  baseFetch: typeof fetch = fetch,
  opts: { logSkips?: boolean } = {},
) {
  const logSkips = opts.logSkips ?? true;
  const row = await env.DB.prepare("SELECT * FROM onboarding_sessions WHERE id = ?").bind(sessionId).first<SessionRow>();
  // IN_REVIEW too: staging can be ready before a failed hand-off finally goes through.
  if (!row || (row.status !== "CLOCK_RUNNING" && row.status !== "IN_REVIEW") || !row.clock_started_at || !row.guaranteed_deadline) return;
  // Every Jira / Resend / zp-landing call reports its own non-2xx answers to #worker-errors.
  const fetchImpl = reportingFetch(env, baseFetch, { projectId: row.project_id });
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
        await sendSlackAlert(
          env,
          {
            channel: "SPRINT_OPS",
            title: `🗂️ Jira epic ready: ${row.project_id}`,
            fields: [
              { label: "Client", value: row.client_name },
              { label: "Epic", value: result.epicKey },
              { label: "Tasks", value: `${result.createdTasks + result.existingTasks}` },
            ],
            links: [{ label: "Open Jira epic", url: `https://${env.JIRA_DOMAIN}/browse/${encodeURIComponent(result.epicKey)}` }],
          },
          fetchImpl,
        );
      } catch (err) {
        errors.push(`jira: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  }

  if (!row.receipt_sent_at) {
    if (!resendConfigured(env)) {
      if (logSkips) await audit(env.DB, row, "receipt.skipped", "RESEND_API_KEY or RECEIPT_FROM_EMAIL is not set yet");
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

  if (!row.landing_synced_at) {
    if (!landingConfigured(env)) {
      if (logSkips) await audit(env.DB, row, "landing.skipped", "ZP_LANDING_ONBOARD_URL or ZP_LANDING_WEBHOOK_SECRET is not set yet");
    } else {
      try {
        const result = await syncToLanding(env, row, fetchImpl);
        await env.DB.prepare("UPDATE onboarding_sessions SET landing_synced_at = ?, updated_at = ? WHERE id = ?")
          .bind(nowIso(), nowIso(), row.id)
          .run();
        await audit(env.DB, row, "landing.synced", { status: result.status, partial: result.partial, body: result.body });
      } catch (err) {
        errors.push(`landing: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  }

  const lastError = errors.length ? errors.join(" | ").slice(0, 1000) : null;
  await env.DB.prepare("UPDATE onboarding_sessions SET last_error = ?, updated_at = ? WHERE id = ?")
    .bind(lastError, nowIso(), row.id)
    .run();
  if (errors.length) {
    await audit(env.DB, row, "followup.failed", errors);
    // The hourly cron retries failures, so only alert when the error is new or changed.
    if (lastError !== row.last_error) {
      await sendSlackAlert(
        env,
        {
          channel: "ERRORS",
          title: `🔴 Kickoff follow-up failed: ${row.project_id}`,
          fields: [
            { label: "Client", value: row.client_name },
            { label: "Tier", value: tierLabel(row.tier) },
          ],
          note: `${lastError}\nThe hourly job will keep retrying.`,
        },
        fetchImpl,
      );
    }
  }
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

  // 3. Retry Jira/receipt/zp-landing for anything that failed earlier.
  const pending = await env.DB.prepare(
    `SELECT id FROM onboarding_sessions
     WHERE status IN ('CLOCK_RUNNING', 'IN_REVIEW') AND (jira_synced_at IS NULL OR receipt_sent_at IS NULL OR landing_synced_at IS NULL)
     ORDER BY submitted_at LIMIT 10`,
  ).all<{ id: string }>();
  for (const r of pending.results ?? []) await runPostSubmit(env, r.id, fetchImpl, { logSkips: false });

  // 3b. Contracts and launch: drafts that never got made, signed PDFs not yet backed up
  //     or copied to Drive, and launches not yet marked Complete in Airtable.
  const contracts = await retryContractsAndLaunch(env, fetchImpl);

  // 4. Morning workload check to #sprint-ops (only in the 8 AM Eastern hour, once a day).
  let dailyCheck: Awaited<ReturnType<typeof runDailyWorkloadCheck>> | { ran: false; reason: "error" };
  try {
    dailyCheck = await runDailyWorkloadCheck(env, fetchImpl, new Date(now));
  } catch (err) {
    console.error("daily workload check failed:", err);
    dailyCheck = { ran: false, reason: "error" };
  }

  const summary = {
    secretsPurged: purge.meta?.changes ?? 0,
    linksExpired: expired.meta?.changes ?? 0,
    followupsRetried: pending.results?.length ?? 0,
    ...contracts,
    dailyCheck,
  };
  if (summary.secretsPurged || summary.linksExpired) await audit(env.DB, null, "cron", summary);
  return summary;
}

/** One step at a time, 10 rows each, so a bad row can't stall the rest. Failures are reported, then retried next hour. */
export async function retryContractsAndLaunch(env: Env, baseFetch: typeof fetch = fetch) {
  const out = { contractsDrafted: 0, contractsArchived: 0, launchesCompleted: 0 };
  const run = async (sql: string, step: string, fn: (id: string, f: typeof fetch) => Promise<unknown>) => {
    const rows = (await env.DB.prepare(sql).all<{ id: string; project_id: string }>()).results ?? [];
    let done = 0;
    for (const r of rows) {
      try {
        await fn(r.id, reportingFetch(env, baseFetch, { projectId: r.project_id }));
        done++;
      } catch (err) {
        await reportWorkerError(
          env,
          { service: "zp-intake-portal", step, projectId: r.project_id, status: "retrying", detail: err instanceof Error ? err.message : String(err) },
          baseFetch,
        );
      }
    }
    return done;
  };

  if (pandadocConfigured(env)) {
    // Only sessions created by a paid invoice under this version (amount_cents is set), so old test rows don't get drafts.
    out.contractsDrafted = await run(
      `SELECT id, project_id FROM onboarding_sessions
       WHERE pandadoc_document_id IS NULL AND amount_cents IS NOT NULL AND stripe_invoice_id IS NOT NULL AND status != 'EXPIRED'
       ORDER BY created_at LIMIT 10`,
      "contract draft (cron)",
      (id, f) => draftAndRequestApproval(env, id, f),
    );
    out.contractsArchived = await run(
      `SELECT id, project_id FROM onboarding_sessions
       WHERE contract_status = 'SIGNED'
         AND (contract_r2_key IS NULL OR (contract_drive_synced_at IS NULL AND landing_synced_at IS NOT NULL AND ? = 1))
       ORDER BY contract_signed_at LIMIT 10`.replace("?", landingConfigured(env) ? "1" : "0"),
      "signed contract backup (cron)",
      (id, f) => archiveSignedContract(env, id, f),
    );
  }
  if (landingConfigured(env)) {
    out.launchesCompleted = await run(
      `SELECT id, project_id FROM onboarding_sessions
       WHERE status = 'LAUNCHED' AND client_approved_at IS NOT NULL AND landing_completed_at IS NULL
       ORDER BY client_approved_at LIMIT 10`,
      "Airtable Complete (cron)",
      (id, f) => markLandingComplete(env, id, f),
    );
  }
  return out;
}
