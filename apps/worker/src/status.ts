import type { StatusStage, StatusView } from "@zinkpress/shared";
import type { SessionRow } from "./db";
import type { Env } from "./env";
import { DEFAULT_TIMEZONE, parseHolidays, sprintProgress } from "./schedule";

/** Where a project is, in the client's words. Null before the intake form is submitted. */
export function stageFor(row: SessionRow, now = new Date()): StatusStage | null {
  switch (row.status) {
    case "LAUNCHED":
      return "LAUNCHED";
    case "IN_REVIEW":
      return "STAGING_REVIEW";
    case "CLOCK_RUNNING":
      // Submitted, but kickoff (9:00 AM on the next business morning) hasn't come yet.
      return row.clock_started_at && now.getTime() < new Date(row.clock_started_at).getTime() ? "INTAKE_COMPLETE" : "BUILDING";
    default:
      return null;
  }
}

/** The read-only status page. Never includes keys, contract details, or anything internal. */
export function statusView(env: Env, row: SessionRow, now = new Date()): StatusView {
  const timeZone = env.BUSINESS_TIMEZONE || DEFAULT_TIMEZONE;
  const progress =
    row.clock_started_at && row.guaranteed_deadline
      ? sprintProgress(row.clock_started_at, row.guaranteed_deadline, now, { timeZone, holidays: parseHolidays(env.HOLIDAYS) })
      : null;
  // Once staging is in review or launched, the build days are all used as far as the client is concerned.
  const done = row.status === "IN_REVIEW" || row.status === "LAUNCHED";
  return {
    projectId: row.project_id,
    clientName: row.client_name,
    tier: row.tier,
    status: row.status,
    stage: stageFor(row, now),
    agencyName: env.AGENCY_NAME,
    agencyEmail: env.AGENCY_EMAIL,
    timeZone,
    clockStartedAt: row.clock_started_at,
    guaranteedDeadline: row.guaranteed_deadline,
    businessDaysTotal: progress?.businessDaysTotal ?? null,
    businessDaysElapsed: progress ? (done ? progress.businessDaysTotal : progress.businessDaysElapsed) : null,
    businessDaysLeft: progress ? (done ? 0 : progress.businessDaysLeft) : null,
    percent: progress ? (done ? 100 : progress.percent) : null,
    reviewRequestedAt: row.review_requested_at,
    launchedAt: row.launched_at,
  };
}
