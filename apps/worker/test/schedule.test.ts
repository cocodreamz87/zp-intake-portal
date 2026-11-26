import { describe, expect, it } from "vitest";
import { calculateSprintSchedule, parseHolidays, zonedTimeToUtc } from "../src/schedule";

// Reminder: Eastern is UTC-5 in winter (EST) and UTC-4 in summer (EDT).
// So 9:00 AM Eastern is 14:00Z in winter and 13:00Z in summer.

describe("calculateSprintSchedule (America/New_York)", () => {
  it("same-day kickoff when submitted on a business-day morning before 9 AM", () => {
    // Tue Nov 24 2026, 7:30 AM EST
    const r = calculateSprintSchedule(new Date("2026-11-24T12:30:00Z"), "TIER_1");
    expect(r.clockStartedAt).toBe("2026-11-24T14:00:00.000Z"); // Tue 9:00 AM EST
    expect(r.guaranteedDeadline).toBe("2026-12-01T14:00:00.000Z"); // next Tue 9:00 AM EST (no holidays given)
  });

  it("exactly 9:00:00 AM still counts as today", () => {
    const r = calculateSprintSchedule(new Date("2026-11-24T14:00:00Z"), "TIER_1");
    expect(r.clockStartedAt).toBe("2026-11-24T14:00:00.000Z");
  });

  it("next business morning when submitted after 9 AM", () => {
    // Tue 10:00 AM EST
    const r = calculateSprintSchedule(new Date("2026-11-24T15:00:00Z"), "TIER_1");
    expect(r.clockStartedAt).toBe("2026-11-25T14:00:00.000Z"); // Wed
    expect(r.guaranteedDeadline).toBe("2026-12-02T14:00:00.000Z"); // next Wed
  });

  it("Friday night in Atlanta (already Saturday in UTC) kicks off Monday", () => {
    // Fri Nov 27 2026 10:00 PM EST = Sat 03:00Z. The original UTC-based code got this wrong.
    const r = calculateSprintSchedule(new Date("2026-11-28T03:00:00Z"), "TIER_1");
    expect(r.clockStartedAt).toBe("2026-11-30T14:00:00.000Z"); // Mon 9:00 AM
    expect(r.guaranteedDeadline).toBe("2026-12-07T14:00:00.000Z"); // next Mon 9:00 AM
  });

  it("Tier 1 is 5 business days and skips the weekend: Thursday kickoff lands next Thursday", () => {
    // Wed Dec 2 2026, 3:00 PM EST -> kickoff Thu Dec 3
    const r = calculateSprintSchedule(new Date("2026-12-02T20:00:00Z"), "TIER_1");
    expect(r.clockStartedAt).toBe("2026-12-03T14:00:00.000Z");
    expect(r.guaranteedDeadline).toBe("2026-12-10T14:00:00.000Z"); // next Thu, weekend skipped
  });

  it("Tier 2 is 10 business days, Tier 3 is 20", () => {
    const monMorning = new Date("2026-11-30T12:00:00Z"); // Mon 7 AM EST
    expect(calculateSprintSchedule(monMorning, "TIER_2").guaranteedDeadline).toBe("2026-12-14T14:00:00.000Z");
    expect(calculateSprintSchedule(monMorning, "TIER_3").guaranteedDeadline).toBe("2026-12-28T14:00:00.000Z");
  });

  it("skips holidays for both kickoff and deadline", () => {
    const holidays = parseHolidays("2026-11-26, 2026-11-27, nonsense");
    expect(holidays).toEqual(["2026-11-26", "2026-11-27"]);
    // Wed Nov 25 10 AM -> Thu & Fri are holidays -> kickoff Mon Nov 30
    const r = calculateSprintSchedule(new Date("2026-11-25T15:00:00Z"), "TIER_1", { holidays });
    expect(r.clockStartedAt).toBe("2026-11-30T14:00:00.000Z");
    expect(r.guaranteedDeadline).toBe("2026-12-07T14:00:00.000Z");
  });

  it("follows daylight saving: kickoff after the March switch is 9 AM EDT", () => {
    // Fri Mar 12 2027 noon EST. DST starts Sun Mar 14.
    const r = calculateSprintSchedule(new Date("2027-03-12T17:00:00Z"), "TIER_1");
    expect(r.clockStartedAt).toBe("2027-03-15T13:00:00.000Z"); // Mon 9:00 AM EDT
    expect(r.guaranteedDeadline).toBe("2027-03-22T13:00:00.000Z");
  });

  it("deadline crossing the November switch back to EST", () => {
    // Thu Oct 28 2027, 8 AM EDT -> kickoff Thu 9 AM EDT. DST ends Sun Nov 7 2027,
    // so Tier 3's deadline (+20 business days, Thu Nov 25) is 9 AM EST.
    const r = calculateSprintSchedule(new Date("2027-10-28T12:00:00Z"), "TIER_3");
    expect(r.clockStartedAt).toBe("2027-10-28T13:00:00.000Z"); // 9 AM EDT
    expect(r.guaranteedDeadline).toBe("2027-11-25T14:00:00.000Z"); // 9 AM EST, four weeks later
  });

  it("reports the deadline's local date for Jira", () => {
    const r = calculateSprintSchedule(new Date("2026-11-24T12:30:00Z"), "TIER_2");
    expect(r.deadlineLocalDate).toBe("2026-12-08");
    expect(r.timeZone).toBe("America/New_York");
  });

  it("the time zone is one setting", () => {
    const r = calculateSprintSchedule(new Date("2026-11-24T12:30:00Z"), "TIER_1", { timeZone: "America/Chicago" });
    expect(r.clockStartedAt).toBe("2026-11-24T15:00:00.000Z"); // 9 AM CST
  });

  it("rejects an invalid date", () => {
    expect(() => calculateSprintSchedule(new Date("nope"), "TIER_1")).toThrow();
  });
});

describe("zonedTimeToUtc", () => {
  it("handles summer and winter", () => {
    expect(zonedTimeToUtc({ year: 2027, month: 7, day: 1 }, 9, 0, "America/New_York").toISOString()).toBe(
      "2027-07-01T13:00:00.000Z",
    );
    expect(zonedTimeToUtc({ year: 2027, month: 1, day: 4 }, 9, 0, "America/New_York").toISOString()).toBe(
      "2027-01-04T14:00:00.000Z",
    );
  });
});
