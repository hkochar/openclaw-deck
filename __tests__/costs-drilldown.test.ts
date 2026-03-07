import { describe, it } from "node:test";
import assert from "node:assert/strict";

/**
 * Tests for the buildLogsUrl logic from app/costs/page.tsx.
 *
 * The function is inline in the CostsPage component (not exported), so we
 * reimplement the pure URL-building logic here. If buildLogsUrl is ever
 * extracted to a shared module, replace this reimplementation with a direct import.
 */

// ── Reimplementation of buildLogsUrl ─────────────────────────────────────────

type TimeRange = "today" | "7d" | "14d" | "mtd" | "90d" | "ytd" | "all" | "custom";
type BillingFilter = "all" | "metered" | "subscription";

/**
 * Mirrors the TIME_RANGE_PRESETS from costs/page.tsx.
 * The since() functions are simplified for testing — they produce epoch ms.
 */
const TIME_RANGE_PRESETS: Record<Exclude<TimeRange, "custom">, { label: string; since: () => number }> = {
  today:  { label: "Today",  since: () => { const d = new Date(); d.setUTCHours(0,0,0,0); return d.getTime(); } },
  "7d":   { label: "7d",     since: () => Date.now() - 7 * 86400000 },
  "14d":  { label: "14d",    since: () => Date.now() - 14 * 86400000 },
  mtd:    { label: "MTD",    since: () => { const d = new Date(); d.setUTCDate(1); d.setUTCHours(0,0,0,0); return d.getTime(); } },
  "90d":  { label: "90d",    since: () => Date.now() - 90 * 86400000 },
  ytd:    { label: "YTD",    since: () => { const d = new Date(); d.setUTCMonth(0,1); d.setUTCHours(0,0,0,0); return d.getTime(); } },
  all:    { label: "All",    since: () => Date.now() - 365 * 86400000 },
};

interface BuildLogsUrlOptions {
  timeRange: TimeRange;
  customStart?: string;
  customEnd?: string;
  agentFilter?: string;
  billingFilter?: BillingFilter;
  providerFilter?: string;
  modelFilter?: string;
  costView?: string;
  extra?: Record<string, string>;
}

function buildLogsUrl(opts: BuildLogsUrlOptions): string {
  const {
    timeRange,
    customStart = "",
    customEnd = "",
    agentFilter = "",
    billingFilter = "all",
    providerFilter = "",
    modelFilter = "",
    costView = "actual",
    extra,
  } = opts;

  const p = new URLSearchParams();

  // Time range
  if (timeRange === "custom") {
    p.set("since", String(new Date(customStart + "T00:00:00Z").getTime()));
    p.set("until", String(new Date(customEnd + "T23:59:59.999Z").getTime()));
  } else {
    p.set("since", String(TIME_RANGE_PRESETS[timeRange].since()));
  }

  // Agent
  if (agentFilter) p.set("agent", agentFilter);
  // Billing
  if (billingFilter !== "all") p.set("billing", billingFilter);
  // Provider
  if (providerFilter) p.set("provider", providerFilter);
  // Model
  if (modelFilter) p.set("model", modelFilter);
  // Cost view
  if (costView !== "actual") p.set("costView", costView);
  // Time range label
  p.set("timeRangeLabel", timeRange === "custom" ? `${customStart} → ${customEnd}` : TIME_RANGE_PRESETS[timeRange].label);

  // Merge extras
  if (extra) {
    for (const [k, v] of Object.entries(extra)) {
      if (v) p.set(k, v);
    }
  }

  return `/logs?${p}`;
}

// ── Helper to parse the URL back into params ─────────────────────────────────

function parseLogsUrl(url: string): URLSearchParams {
  const qs = url.split("?")[1] || "";
  return new URLSearchParams(qs);
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe("buildLogsUrl — basic construction", () => {
  it("returns a URL starting with /logs?", () => {
    const url = buildLogsUrl({ timeRange: "7d" });
    assert.ok(url.startsWith("/logs?"));
  });

  it("includes since param for preset time ranges", () => {
    const url = buildLogsUrl({ timeRange: "7d" });
    const params = parseLogsUrl(url);
    assert.ok(params.has("since"));
    const since = Number(params.get("since"));
    assert.ok(since > 0);
    // 7d since should be roughly 7 days ago (within 1 minute of test execution)
    const sevenDaysAgo = Date.now() - 7 * 86400000;
    assert.ok(Math.abs(since - sevenDaysAgo) < 60000);
  });

  it("includes timeRangeLabel for preset ranges", () => {
    const url = buildLogsUrl({ timeRange: "14d" });
    const params = parseLogsUrl(url);
    assert.equal(params.get("timeRangeLabel"), "14d");
  });
});

describe("buildLogsUrl — agent filter", () => {
  it("includes agent param when agentFilter is set", () => {
    const url = buildLogsUrl({ timeRange: "7d", agentFilter: "forge" });
    const params = parseLogsUrl(url);
    assert.equal(params.get("agent"), "forge");
  });

  it("omits agent param when agentFilter is empty", () => {
    const url = buildLogsUrl({ timeRange: "7d", agentFilter: "" });
    const params = parseLogsUrl(url);
    assert.equal(params.has("agent"), false);
  });

  it("extra can override agent", () => {
    const url = buildLogsUrl({
      timeRange: "7d",
      agentFilter: "forge",
      extra: { agent: "scout" },
    });
    const params = parseLogsUrl(url);
    assert.equal(params.get("agent"), "scout");
  });
});

describe("buildLogsUrl — model filter", () => {
  it("includes model param when modelFilter is set", () => {
    const url = buildLogsUrl({ timeRange: "7d", modelFilter: "anthropic/claude-sonnet-4-20250514" });
    const params = parseLogsUrl(url);
    assert.equal(params.get("model"), "anthropic/claude-sonnet-4-20250514");
  });

  it("omits model param when modelFilter is empty", () => {
    const url = buildLogsUrl({ timeRange: "7d", modelFilter: "" });
    const params = parseLogsUrl(url);
    assert.equal(params.has("model"), false);
  });
});

describe("buildLogsUrl — time range", () => {
  it("custom time range sets both since and until", () => {
    const url = buildLogsUrl({
      timeRange: "custom",
      customStart: "2026-02-01",
      customEnd: "2026-02-15",
    });
    const params = parseLogsUrl(url);
    assert.ok(params.has("since"));
    assert.ok(params.has("until"));

    const since = Number(params.get("since"));
    const until = Number(params.get("until"));
    assert.ok(since > 0);
    assert.ok(until > since);

    // Verify since is start of Feb 1 UTC
    const sinceDate = new Date(since);
    assert.equal(sinceDate.getUTCFullYear(), 2026);
    assert.equal(sinceDate.getUTCMonth(), 1); // February
    assert.equal(sinceDate.getUTCDate(), 1);
    assert.equal(sinceDate.getUTCHours(), 0);

    // Verify until is end of Feb 15 UTC
    const untilDate = new Date(until);
    assert.equal(untilDate.getUTCDate(), 15);
    assert.equal(untilDate.getUTCHours(), 23);
    assert.equal(untilDate.getUTCMinutes(), 59);
  });

  it("custom time range label shows date range", () => {
    const url = buildLogsUrl({
      timeRange: "custom",
      customStart: "2026-02-01",
      customEnd: "2026-02-15",
    });
    const params = parseLogsUrl(url);
    assert.equal(params.get("timeRangeLabel"), "2026-02-01 → 2026-02-15");
  });

  it("preset time range does not set until", () => {
    const url = buildLogsUrl({ timeRange: "today" });
    const params = parseLogsUrl(url);
    assert.equal(params.has("until"), false);
  });

  it("'today' since is start of current UTC day", () => {
    const url = buildLogsUrl({ timeRange: "today" });
    const params = parseLogsUrl(url);
    const since = Number(params.get("since"));
    const d = new Date(since);
    assert.equal(d.getUTCHours(), 0);
    assert.equal(d.getUTCMinutes(), 0);
    assert.equal(d.getUTCSeconds(), 0);
  });
});

describe("buildLogsUrl — billing filter", () => {
  it("includes billing param when not 'all'", () => {
    const url = buildLogsUrl({ timeRange: "7d", billingFilter: "metered" });
    const params = parseLogsUrl(url);
    assert.equal(params.get("billing"), "metered");
  });

  it("omits billing param when 'all'", () => {
    const url = buildLogsUrl({ timeRange: "7d", billingFilter: "all" });
    const params = parseLogsUrl(url);
    assert.equal(params.has("billing"), false);
  });

  it("includes subscription billing", () => {
    const url = buildLogsUrl({ timeRange: "7d", billingFilter: "subscription" });
    const params = parseLogsUrl(url);
    assert.equal(params.get("billing"), "subscription");
  });
});

describe("buildLogsUrl — provider filter", () => {
  it("includes provider param when set", () => {
    const url = buildLogsUrl({ timeRange: "7d", providerFilter: "anthropic" });
    const params = parseLogsUrl(url);
    assert.equal(params.get("provider"), "anthropic");
  });

  it("omits provider param when empty", () => {
    const url = buildLogsUrl({ timeRange: "7d", providerFilter: "" });
    const params = parseLogsUrl(url);
    assert.equal(params.has("provider"), false);
  });
});

describe("buildLogsUrl — cost view", () => {
  it("omits costView when 'actual' (default)", () => {
    const url = buildLogsUrl({ timeRange: "7d", costView: "actual" });
    const params = parseLogsUrl(url);
    assert.equal(params.has("costView"), false);
  });

  it("includes costView when not 'actual'", () => {
    const url = buildLogsUrl({ timeRange: "7d", costView: "equiv" });
    const params = parseLogsUrl(url);
    assert.equal(params.get("costView"), "equiv");
  });
});

describe("buildLogsUrl — carries all active filters when drilling down", () => {
  it("all filters present in URL when all are active", () => {
    const url = buildLogsUrl({
      timeRange: "14d",
      agentFilter: "forge",
      billingFilter: "metered",
      providerFilter: "anthropic",
      modelFilter: "anthropic/claude-sonnet-4-20250514",
      costView: "equiv",
    });
    const params = parseLogsUrl(url);

    assert.ok(params.has("since"));
    assert.equal(params.get("agent"), "forge");
    assert.equal(params.get("billing"), "metered");
    assert.equal(params.get("provider"), "anthropic");
    assert.equal(params.get("model"), "anthropic/claude-sonnet-4-20250514");
    assert.equal(params.get("costView"), "equiv");
    assert.equal(params.get("timeRangeLabel"), "14d");
  });

  it("extra params merge with existing filters", () => {
    const url = buildLogsUrl({
      timeRange: "7d",
      agentFilter: "forge",
      extra: { search: "readFile", type: "tool_call" },
    });
    const params = parseLogsUrl(url);

    assert.equal(params.get("agent"), "forge");
    assert.equal(params.get("search"), "readFile");
    assert.equal(params.get("type"), "tool_call");
  });

  it("extra with empty value does not set param", () => {
    const url = buildLogsUrl({
      timeRange: "7d",
      extra: { search: "", type: "tool_call" },
    });
    const params = parseLogsUrl(url);

    assert.equal(params.has("search"), false);
    assert.equal(params.get("type"), "tool_call");
  });

  it("drill into agent model carries agent + model + time", () => {
    const url = buildLogsUrl({
      timeRange: "mtd",
      agentFilter: "",
      extra: { agent: "scout", model: "nvidia/kimi-k2" },
    });
    const params = parseLogsUrl(url);

    assert.equal(params.get("agent"), "scout");
    assert.equal(params.get("model"), "nvidia/kimi-k2");
    assert.ok(params.has("since"));
    assert.equal(params.get("timeRangeLabel"), "MTD");
  });

  it("drill into timeline carries since/until + agent", () => {
    const bucketStart = Date.now() - 3600000;
    const bucketEnd = Date.now();
    const url = buildLogsUrl({
      timeRange: "7d",
      extra: {
        since: String(bucketStart),
        until: String(bucketEnd),
        agent: "forge",
      },
    });
    const params = parseLogsUrl(url);

    // Extra 'since' overrides the preset since
    assert.equal(params.get("since"), String(bucketStart));
    assert.equal(params.get("until"), String(bucketEnd));
    assert.equal(params.get("agent"), "forge");
  });
});
