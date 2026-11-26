import type { Tier } from "@zinkpress/shared";

/**
 * Sprint clock math.
 *
 * Rules (all in the business time zone, default America/New_York = Eastern,
 * which follows daylight saving automatically: EST in winter, EDT in summer):
 *
 * 1. Kickoff is the next 9:00 AM on a business day that is at or after the
 *    moment the client submits. Submit Tuesday 7:30 AM -> kickoff Tuesday 9:00 AM.
 *    Submit Tuesday 9:01 AM -> kickoff Wednesday 9:00 AM. Submit Friday night or
 *    Saturday -> kickoff Monday 9:00 AM.
 * 2. Business days are Monday to Friday, minus any dates listed in HOLIDAYS.
 * 3. Deadline = kickoff + N business days, same 9:00 AM wall-clock time.
 *    TIER_1 = 5 business days (one working week, so a Monday kickoff lands
 *    the next Monday 9 AM).
 *    TIER_2 = 10 business days (the top of the "7 to 10 business days" sold),
 *    TIER_3 = 20 business days (the top of the "3 to 4 weeks" sold).
 *
 * Why not do this with Date#setHours like the original snippet?
 * A Cloudflare Worker runs in UTC, so setHours(9) means 9:00 UTC = 4 or 5 AM in
 * Atlanta, and getDay() reads the UTC weekday, which is wrong for evenings in
 * Eastern time. Everything below converts through Intl with an explicit zone.
 */

export const DEFAULT_TIMEZONE = "America/New_York";
export const KICKOFF_HOUR = 9;

export const BUSINESS_DAYS_BY_TIER: Record<Tier, number> = {
  TIER_1: 5,
  TIER_2: 10,
  TIER_3: 20,
};

export interface ScheduleOptions {
  timeZone?: string;
  /** Dates to skip, as "YYYY-MM-DD" in the business time zone. */
  holidays?: Iterable<string>;
}

interface CivilDate {
  year: number;
  month: number; // 1-12
  day: number;
}

const partsCache = new Map<string, Intl.DateTimeFormat>();
function formatter(timeZone: string) {
  let f = partsCache.get(timeZone);
  if (!f) {
    f = new Intl.DateTimeFormat("en-US", {
      timeZone,
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    });
    partsCache.set(timeZone, f);
  }
  return f;
}

/** Wall-clock parts of an instant in a given zone. */
export function zonedParts(instant: Date, timeZone: string) {
  const parts = formatter(timeZone).formatToParts(instant);
  const get = (t: string) => Number(parts.find((p) => p.type === t)?.value);
  return {
    year: get("year"),
    month: get("month"),
    day: get("day"),
    hour: get("hour"),
    minute: get("minute"),
    second: get("second"),
  };
}

/** The UTC instant at which the clock in `timeZone` reads the given wall time. */
export function zonedTimeToUtc(d: CivilDate, hour: number, minute: number, timeZone: string): Date {
  // Start by pretending the wall time is UTC, then correct by the zone offset.
  // Two passes handle the rare case where the offset differs between guesses.
  const wallAsUtc = Date.UTC(d.year, d.month - 1, d.day, hour, minute, 0);
  let guess = wallAsUtc;
  for (let i = 0; i < 2; i++) {
    const p = zonedParts(new Date(guess), timeZone);
    const seen = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
    guess += wallAsUtc - seen;
  }
  return new Date(guess);
}

function addDays(d: CivilDate, n: number): CivilDate {
  const t = new Date(Date.UTC(d.year, d.month - 1, d.day + n));
  return { year: t.getUTCFullYear(), month: t.getUTCMonth() + 1, day: t.getUTCDate() };
}

function weekday(d: CivilDate): number {
  return new Date(Date.UTC(d.year, d.month - 1, d.day)).getUTCDay(); // 0 Sun .. 6 Sat
}

export function isoDate(d: CivilDate): string {
  return `${d.year}-${String(d.month).padStart(2, "0")}-${String(d.day).padStart(2, "0")}`;
}

export function isBusinessDay(d: CivilDate, holidays: Set<string>): boolean {
  const wd = weekday(d);
  return wd !== 0 && wd !== 6 && !holidays.has(isoDate(d));
}

export function parseHolidays(raw: string | undefined): string[] {
  if (!raw) return [];
  return raw
    .split(",")
    .map((s) => s.trim())
    .filter((s) => /^\d{4}-\d{2}-\d{2}$/.test(s));
}

export function calculateSprintSchedule(submittedAt: Date, tier: Tier, opts: ScheduleOptions = {}) {
  if (Number.isNaN(submittedAt.getTime())) throw new Error("submittedAt is not a valid date");
  const timeZone = opts.timeZone ?? DEFAULT_TIMEZONE;
  const holidays = new Set(opts.holidays ?? []);

  const now = zonedParts(submittedAt, timeZone);
  let day: CivilDate = { year: now.year, month: now.month, day: now.day };

  // Today counts only if it's a business day and 9:00 AM hasn't passed yet.
  const beforeKickoffHour = now.hour < KICKOFF_HOUR || (now.hour === KICKOFF_HOUR && now.minute === 0 && now.second === 0);
  if (!(isBusinessDay(day, holidays) && beforeKickoffHour)) {
    do {
      day = addDays(day, 1);
    } while (!isBusinessDay(day, holidays));
  }
  const kickoffDay = day;

  let added = 0;
  const target = BUSINESS_DAYS_BY_TIER[tier];
  while (added < target) {
    day = addDays(day, 1);
    if (isBusinessDay(day, holidays)) added++;
  }

  return {
    clockStartedAt: zonedTimeToUtc(kickoffDay, KICKOFF_HOUR, 0, timeZone).toISOString(),
    guaranteedDeadline: zonedTimeToUtc(day, KICKOFF_HOUR, 0, timeZone).toISOString(),
    /** Deadline date in the business zone, used as Jira's due date. */
    deadlineLocalDate: isoDate(day),
    timeZone,
  };
}
