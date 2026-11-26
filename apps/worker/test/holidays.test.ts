import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { TIERS } from "@zinkpress/shared";
import { calculateSprintSchedule, parseHolidays, zonedParts } from "../src/schedule";

// Reads the real HOLIDAYS list the deployed Worker uses.
const wrangler = readFileSync(fileURLToPath(new URL("../../../wrangler.toml", import.meta.url)), "utf8");
const raw = wrangler.match(/^HOLIDAYS\s*=\s*"([^"]*)"/m)?.[1];
const holidays = parseHolidays(raw);
const holidaySet = new Set(holidays);
const TZ = "America/New_York";

function localDay(iso: string) {
  const p = zonedParts(new Date(iso), TZ);
  const date = `${p.year}-${String(p.month).padStart(2, "0")}-${String(p.day).padStart(2, "0")}`;
  const weekday = new Date(Date.UTC(p.year, p.month - 1, p.day)).getUTCDay();
  return { date, weekday, hour: p.hour, minute: p.minute };
}

describe("HOLIDAYS in wrangler.toml", () => {
  it("lists every 2026 and 2027 US federal holiday (observed) plus the Friday after Thanksgiving", () => {
    expect(holidays).toEqual([
      "2026-01-01", "2026-01-19", "2026-02-16", "2026-05-25", "2026-06-19", "2026-07-03",
      "2026-09-07", "2026-10-12", "2026-11-11", "2026-11-26", "2026-11-27", "2026-12-25",
      "2027-01-01", "2027-01-18", "2027-02-15", "2027-05-31", "2027-06-18", "2027-07-05",
      "2027-09-06", "2027-10-11", "2027-11-11", "2027-11-25", "2027-11-26", "2027-12-24",
      "2027-12-31",
    ]);
  });

  it("every listed date is a weekday (observed dates, not the weekend date)", () => {
    for (const d of holidays) {
      const wd = new Date(`${d}T12:00:00Z`).getUTCDay();
      expect(wd, d).not.toBe(0);
      expect(wd, d).not.toBe(6);
    }
  });

  it("no kickoff or deadline ever lands on a weekend or a listed holiday (every 3 hours, 2026-2027)", () => {
    const start = Date.parse("2026-01-01T00:00:00Z");
    const end = Date.parse("2027-12-31T23:00:00Z");
    for (let t = start; t <= end; t += 3 * 60 * 60 * 1000) {
      for (const tier of TIERS) {
        const r = calculateSprintSchedule(new Date(t), tier, { holidays, timeZone: TZ });
        for (const iso of [r.clockStartedAt, r.guaranteedDeadline]) {
          const d = localDay(iso);
          expect([0, 6], `${tier} ${new Date(t).toISOString()} -> ${iso}`).not.toContain(d.weekday);
          expect(holidaySet.has(d.date), `${tier} ${new Date(t).toISOString()} -> ${d.date}`).toBe(false);
          expect(`${d.hour}:${d.minute}`).toBe("9:0");
        }
      }
    }
  });

  it("a Wednesday-night Thanksgiving-week submit kicks off Monday Nov 30", () => {
    // Wed Nov 25 2026, 9:00 PM EST. Thu (Thanksgiving), Fri (day after), Sat and Sun are all off.
    const r = calculateSprintSchedule(new Date("2026-11-26T02:00:00Z"), "TIER_1", { holidays, timeZone: TZ });
    expect(r.clockStartedAt).toBe("2026-11-30T14:00:00.000Z"); // Mon Nov 30, 9:00 AM EST
    expect(r.guaranteedDeadline).toBe("2026-12-07T14:00:00.000Z"); // Mon Dec 7
  });

  it("Christmas and New Year push a Tier 1 deadline past both holidays", () => {
    // Mon Dec 21 2026, 8 AM EST -> kickoff Mon Dec 21. Business days: Dec 22, 23, 24, 28, 29 (Dec 25 off).
    const r = calculateSprintSchedule(new Date("2026-12-21T13:00:00Z"), "TIER_1", { holidays, timeZone: TZ });
    expect(r.clockStartedAt).toBe("2026-12-21T14:00:00.000Z");
    expect(r.guaranteedDeadline).toBe("2026-12-29T14:00:00.000Z");
  });
});
