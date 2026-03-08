import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { parseField, nextCronTime, computeNextRun, scheduleLabel } from "@/app/api/_lib/cron-parser";

// ── parseField ──────────────────────────────────────────────────────────────

describe("parseField", () => {
  it("wildcard * returns all values in range", () => {
    const result = parseField("*", 0, 5);
    assert.deepEqual(result, [0, 1, 2, 3, 4, 5]);
  });

  it("step */15 on minutes returns 0,15,30,45", () => {
    assert.deepEqual(parseField("*/15", 0, 59), [0, 15, 30, 45]);
  });

  it("exact value 5 returns [5]", () => {
    assert.deepEqual(parseField("5", 0, 59), [5]);
  });

  it("range 1-5 returns [1,2,3,4,5]", () => {
    assert.deepEqual(parseField("1-5", 1, 31), [1, 2, 3, 4, 5]);
  });

  it("comma-separated list 1,15,30", () => {
    assert.deepEqual(parseField("1,15,30", 0, 59), [1, 15, 30]);
  });

  it("combined ranges and values 1-3,7,10-12", () => {
    assert.deepEqual(parseField("1-3,7,10-12", 1, 31), [1, 2, 3, 7, 10, 11, 12]);
  });

  it("step */10 on months (min=1) returns [1, 11]", () => {
    assert.deepEqual(parseField("*/10", 1, 12), [1, 11]);
  });

  it("step */0 returns empty (invalid step)", () => {
    assert.deepEqual(parseField("*/0", 0, 59), []);
  });

  it("NaN field returns empty", () => {
    assert.deepEqual(parseField("abc", 0, 59), []);
  });
});

// ── nextCronTime ────────────────────────────────────────────────────────────

describe("nextCronTime", () => {
  it("every hour on the hour (0 * * * *)", () => {
    // From 10:30, next should be 11:00
    const from = new Date("2026-01-15T10:30:00Z").getTime();
    const next = nextCronTime("0 * * * *", from);
    assert.ok(next !== null);
    const d = new Date(next!);
    assert.equal(d.getUTCMinutes(), 0);
    assert.equal(d.getUTCHours(), 11);
  });

  it("every 5 minutes (*/5 * * * *) from :03", () => {
    const from = new Date("2026-01-15T10:03:00Z").getTime();
    const next = nextCronTime("*/5 * * * *", from);
    assert.ok(next !== null);
    const d = new Date(next!);
    assert.equal(d.getUTCMinutes(), 5);
    assert.equal(d.getUTCHours(), 10);
  });

  it("midnight first of month (0 0 1 * *) from mid-month", () => {
    const from = new Date("2026-01-15T10:00:00Z").getTime();
    const next = nextCronTime("0 0 1 * *", from);
    assert.ok(next !== null);
    const d = new Date(next!);
    // cron uses local time, so check local date/time
    assert.equal(d.getDate(), 1);
    assert.equal(d.getHours(), 0);
    assert.equal(d.getMinutes(), 0);
  });

  it("weekdays only (30 8 * * 1-5) from a weekday → next weekday 8:30", () => {
    // Use a known Wednesday and check result is a weekday at 8:30
    const from = new Date(2026, 0, 14, 22, 0, 0).getTime(); // Wed Jan 14 22:00 local
    const next = nextCronTime("30 8 * * 1-5", from);
    assert.ok(next !== null);
    const d = new Date(next!);
    assert.ok(d.getDay() >= 1 && d.getDay() <= 5); // weekday
    assert.equal(d.getHours(), 8);
    assert.equal(d.getMinutes(), 30);
  });

  it("DOM/DOW OR semantics: 15th OR Monday (0 0 15 * 1)", () => {
    // Use a date before the 13th (Monday). OR means 15th or any Monday.
    const from = new Date(2026, 0, 12, 23, 0, 0).getTime(); // Mon Jan 12 23:00 local
    const next = nextCronTime("0 0 15 * 1", from);
    assert.ok(next !== null);
    const d = new Date(next!);
    // Should match either dom=15 or dow=1 (Monday)
    const matchesDom = d.getDate() === 15;
    const matchesDow = d.getDay() === 1;
    assert.ok(matchesDom || matchesDow, `Expected dom=15 or dow=Monday, got date=${d.getDate()} day=${d.getDay()}`);
  });

  it("invalid 6-field expression returns null", () => {
    assert.equal(nextCronTime("0 0 * * * *", Date.now()), null);
  });

  it("empty string returns null", () => {
    assert.equal(nextCronTime("", Date.now()), null);
  });

  it("noon on Sundays (0 12 * * 0) from a weekday", () => {
    const from = new Date(2026, 0, 14, 10, 0, 0).getTime(); // Wed Jan 14 local
    const next = nextCronTime("0 12 * * 0", from);
    assert.ok(next !== null);
    const d = new Date(next!);
    assert.equal(d.getDay(), 0); // Sunday (local)
    assert.equal(d.getHours(), 12); // local time
  });
});

// ── computeNextRun ──────────────────────────────────────────────────────────

describe("computeNextRun", () => {
  it("kind=at returns the at timestamp directly", () => {
    const result = computeNextRun({ kind: "at", at: "2026-06-01T12:00:00Z" });
    assert.equal(result, "2026-06-01T12:00:00Z");
  });

  it("kind=every computes next interval from lastRunAtMs", () => {
    const now = Date.now();
    const lastRun = now - 1000; // 1 second ago
    const result = computeNextRun(
      { kind: "every", everyMs: 60000 },
      { lastRunAtMs: lastRun }
    );
    assert.ok(result !== null);
    const nextMs = new Date(result!).getTime();
    // Should be ~59 seconds from now (lastRun + 60s)
    assert.ok(nextMs > now);
    assert.ok(nextMs <= now + 60000);
  });

  it("kind=every without lastRunAtMs uses anchorMs", () => {
    const anchor = Date.now() - 500;
    const result = computeNextRun(
      { kind: "every", everyMs: 1000, anchorMs: anchor },
    );
    assert.ok(result !== null);
    const nextMs = new Date(result!).getTime();
    assert.ok(nextMs >= anchor + 1000);
  });

  it("kind=cron delegates to nextCronTime", () => {
    const result = computeNextRun({ kind: "cron", expr: "0 * * * *" });
    assert.ok(result !== null);
    // Should be an ISO string
    assert.ok(result!.includes("T"));
  });

  it("unknown kind returns null", () => {
    assert.equal(computeNextRun({ kind: "unknown" }), null);
  });
});

// ── scheduleLabel ───────────────────────────────────────────────────────────

describe("scheduleLabel", () => {
  it("every 1h", () => {
    assert.equal(scheduleLabel({ kind: "every", everyMs: 3600000 }), "every 1h");
  });

  it("every 5m", () => {
    assert.equal(scheduleLabel({ kind: "every", everyMs: 300000 }), "every 5m");
  });

  it("every 500ms", () => {
    assert.equal(scheduleLabel({ kind: "every", everyMs: 500 }), "every 500ms");
  });

  it("fractional hours (90min) → every 90m", () => {
    assert.equal(scheduleLabel({ kind: "every", everyMs: 5400000 }), "every 90m");
  });

  it("cron expression", () => {
    assert.equal(scheduleLabel({ kind: "cron", expr: "0 9 * * *" }), "cron: 0 9 * * *");
  });

  it("unknown kind", () => {
    assert.equal(scheduleLabel({ kind: "unknown" }), "unknown");
  });
});
