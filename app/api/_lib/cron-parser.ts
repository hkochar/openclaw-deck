/**
 * Cron expression parser and schedule utilities.
 *
 * Extracted from cron-schedule/route.ts and crons/route.ts for testability.
 */

export interface CronSchedule {
  kind: string;
  everyMs?: number;
  expr?: string;
  at?: string;
  anchorMs?: number;
}

export interface CronState {
  lastStatus?: string | null;
  lastRunAtMs?: number | null;
  lastError?: string | null;
}

/**
 * Parse a single cron field into an array of matching values.
 * Supports: * (any), *\/n (step), n (exact), n-m (range), comma-separated combinations.
 */
export function parseField(field: string, min: number, max: number): number[] {
  const values = new Set<number>();
  const parts = field.split(",");
  for (const part of parts) {
    if (part === "*") {
      for (let i = min; i <= max; i++) values.add(i);
    } else if (part.startsWith("*/")) {
      const step = parseInt(part.slice(2), 10);
      if (!isNaN(step) && step > 0) {
        for (let i = min; i <= max; i += step) values.add(i);
      }
    } else if (part.includes("-")) {
      const [lo, hi] = part.split("-").map(Number);
      if (!isNaN(lo) && !isNaN(hi)) {
        for (let i = lo; i <= hi; i++) values.add(i);
      }
    } else {
      const n = parseInt(part, 10);
      if (!isNaN(n)) values.add(n);
    }
  }
  return Array.from(values).sort((a, b) => a - b);
}

/**
 * Parse a 5-field cron expression and find the next occurrence after `fromMs`.
 * Supports: * (any), *\/n (step), n (exact), n-m (range)
 */
export function nextCronTime(expr: string, fromMs: number): number | null {
  const fields = expr.trim().split(/\s+/);
  if (fields.length !== 5) return null;

  const [minuteField, hourField, domField, monthField, dowField] = fields;

  const minutes = parseField(minuteField, 0, 59);
  const hours = parseField(hourField, 0, 23);
  const doms = parseField(domField, 1, 31);
  const months = parseField(monthField, 1, 12);
  const dows = parseField(dowField, 0, 6);

  // Start searching from next minute
  const start = new Date(fromMs + 60_000);
  start.setSeconds(0, 0);

  // Search up to 4 years ahead to find a match
  const limit = fromMs + 4 * 365 * 24 * 60 * 60 * 1000;

  const d = new Date(start);

  while (d.getTime() < limit) {
    const month = d.getMonth() + 1; // 1-12
    if (!months.includes(month)) {
      d.setMonth(d.getMonth() + 1, 1);
      d.setHours(0, 0, 0, 0);
      continue;
    }

    const dom = d.getDate();
    const dow = d.getDay(); // 0-6 (Sun=0)
    // If both dom and dow are restricted (not *), standard cron uses OR semantics
    const domRestricted = domField !== "*";
    const dowRestricted = dowField !== "*";
    let dayMatch: boolean;
    if (domRestricted && dowRestricted) {
      dayMatch = doms.includes(dom) || dows.includes(dow);
    } else {
      dayMatch = doms.includes(dom) && dows.includes(dow);
    }

    if (!dayMatch) {
      d.setDate(d.getDate() + 1);
      d.setHours(0, 0, 0, 0);
      continue;
    }

    const hour = d.getHours();
    if (!hours.includes(hour)) {
      const nextHour = hours.find((h) => h > hour);
      if (nextHour !== undefined) {
        d.setHours(nextHour, 0, 0, 0);
      } else {
        d.setDate(d.getDate() + 1);
        d.setHours(hours[0], 0, 0, 0);
      }
      continue;
    }

    const minute = d.getMinutes();
    const nextMinute = minutes.find((m) => m >= minute);
    if (nextMinute === undefined) {
      const nextHour = hours.find((h) => h > hour);
      if (nextHour !== undefined) {
        d.setHours(nextHour, minutes[0], 0, 0);
      } else {
        d.setDate(d.getDate() + 1);
        d.setHours(hours[0], minutes[0], 0, 0);
      }
      continue;
    }

    d.setMinutes(nextMinute, 0, 0);
    return d.getTime();
  }

  return null;
}

/**
 * Compute the next run time from the schedule and last run state.
 */
export function computeNextRun(schedule: CronSchedule, state?: CronState): string | null {
  const now = Date.now();

  if (schedule.kind === "at" && schedule.at) {
    return schedule.at;
  }

  if (schedule.kind === "every" && schedule.everyMs) {
    const base = state?.lastRunAtMs ?? schedule.anchorMs ?? now;
    let next = base + schedule.everyMs;
    while (next < now) {
      next += schedule.everyMs;
    }
    return new Date(next).toISOString();
  }

  if (schedule.kind === "cron" && schedule.expr) {
    try {
      const next = nextCronTime(schedule.expr, now);
      if (next !== null) {
        return new Date(next).toISOString();
      }
    } catch {
      // If parsing fails, return null
    }
  }

  return null;
}

/**
 * Human-readable label for a schedule.
 */
export function scheduleLabel(schedule: { kind: string; everyMs?: number; expr?: string; at?: string }): string {
  if (schedule.kind === "at" && schedule.at) {
    return `once @ ${new Date(schedule.at).toLocaleString("en-US", {
      month: "short",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    })}`;
  }
  if (schedule.kind === "every" && schedule.everyMs) {
    const ms = schedule.everyMs;
    const mins = ms / 60000;
    const hrs = mins / 60;
    if (hrs >= 1 && hrs % 1 === 0) return `every ${hrs}h`;
    if (mins >= 1 && mins % 1 === 0) return `every ${mins}m`;
    return `every ${ms}ms`;
  }
  if (schedule.kind === "cron") return `cron: ${schedule.expr}`;
  return "unknown";
}
