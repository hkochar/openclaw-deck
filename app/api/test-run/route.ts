import { NextResponse } from "next/server";
import { execSync } from "child_process";
import fs from "fs";
import path from "path";
import { logSystemEvent } from "@/app/api/_lib/system-log";
import { DECK_DIR } from "@/app/api/_lib/paths";

export const dynamic = "force-dynamic";

// ── Suite configuration ─────────────────────────────────────────────────────

const DECK_ROOT = DECK_DIR;
const SENTINEL_ROOT = path.join(DECK_ROOT, "sentinel");
const OPSBOT_ROOT = path.join(DECK_ROOT, "ops-bot");

interface SuiteConfig {
  cmd: string;
  cwd: string;
  parser: "node" | "py";
}

const SUITES: Record<string, SuiteConfig> = {
  "cron-parser":       { cmd: "npx tsx --test __tests__/cron-parser.test.ts",       cwd: DECK_ROOT,       parser: "node" },
  "config-validation": { cmd: "npx tsx --test __tests__/config-validation.test.ts", cwd: DECK_ROOT,       parser: "node" },
  "git-utils":         { cmd: "npx tsx --test __tests__/git-utils.test.ts",         cwd: DECK_ROOT,       parser: "node" },
  "model-utils":       { cmd: "npx tsx --test __tests__/model-utils.test.ts",       cwd: DECK_ROOT,       parser: "node" },
  "security":          { cmd: "npx tsx --test __tests__/security.test.ts",          cwd: DECK_ROOT,       parser: "node" },
  "plist-parser":      { cmd: "npx tsx --test __tests__/plist-parser.test.ts",      cwd: DECK_ROOT,       parser: "node" },
  "discord-channels":  { cmd: "npx tsx --test __tests__/discord-channels.test.ts",  cwd: DECK_ROOT,       parser: "node" },
  "deck-config":         { cmd: "npx tsx --test __tests__/deck-config-validation.test.ts", cwd: DECK_ROOT, parser: "node" },
  "sentinel":          { cmd: "python3 -m unittest test_sentinel -v 2>&1",          cwd: SENTINEL_ROOT, parser: "py" },
  "ops-bot":           { cmd: "python3 -m unittest test_commands -v 2>&1",          cwd: OPSBOT_ROOT,   parser: "py" },
  // Integration tests — tier 1 (always runnable with dev server)
  "integration:local":   { cmd: "npx tsx --test __tests__/integration/local-only.test.ts",       cwd: DECK_ROOT, parser: "node" },
  "integration:config":  { cmd: "npx tsx --test __tests__/integration/config-roundtrip.test.ts",  cwd: DECK_ROOT, parser: "node" },
  "integration:deck-config": { cmd: "npx tsx --test __tests__/integration/deck-config-roundtrip.test.ts", cwd: DECK_ROOT, parser: "node" },
  // Integration tests — tier 2 (gateway-required, gracefully skip)
  "integration:gateway": { cmd: "npx tsx --test __tests__/integration/gateway-required.test.ts",  cwd: DECK_ROOT, parser: "node" },
  "integration:cron":    { cmd: "npx tsx --test __tests__/integration/cron-lifecycle.test.ts",    cwd: DECK_ROOT, parser: "node" },
};

const RESULTS_PATH = path.join(process.cwd(), "data", "test-results.json");

// ── Output parsers ──────────────────────────────────────────────────────────

interface ParsedResult {
  pass: number;
  fail: number;
  total: number;
  ok: boolean;
}

function parseNodeTest(output: string): ParsedResult {
  // node:test outputs "ℹ tests N" (unicode info symbol) or "# tests N"
  const tests = output.match(/(?:#|ℹ)\s*tests\s+(\d+)/);
  const pass  = output.match(/(?:#|ℹ)\s*pass\s+(\d+)/);
  const fail  = output.match(/(?:#|ℹ)\s*fail\s+(\d+)/);
  const total = tests ? parseInt(tests[1], 10) : 0;
  const p     = pass  ? parseInt(pass[1], 10)  : 0;
  const f     = fail  ? parseInt(fail[1], 10)  : 0;
  return { pass: p, fail: f, total, ok: f === 0 && total > 0 };
}

function parseUnittest(output: string): ParsedResult {
  const ran = output.match(/Ran (\d+) test/);
  const total = ran ? parseInt(ran[1], 10) : 0;
  const hasFailed = /FAILED/.test(output);
  const failMatch = output.match(/failures=(\d+)/);
  const errorMatch = output.match(/errors=(\d+)/);
  const f = (failMatch ? parseInt(failMatch[1], 10) : 0)
          + (errorMatch ? parseInt(errorMatch[1], 10) : 0);
  return { pass: total - f, fail: f, total, ok: !hasFailed && total > 0 };
}

// ── Suite execution ─────────────────────────────────────────────────────────

interface SuiteResult {
  pass: number;
  fail: number;
  total: number;
  ok: boolean;
  output: string;
  ranAt: string;
}

function runSuite(name: string, cfg: SuiteConfig): SuiteResult {
  const ranAt = new Date().toISOString();
  let stdout = "";
  let stderr = "";
  let exitOk = true;

  try {
    const raw = execSync(cfg.cmd, {
      cwd: cfg.cwd,
      encoding: "utf-8",
      timeout: 60_000,
      env: { ...process.env, PATH: `${process.env.PATH}:/opt/homebrew/bin:/usr/local/bin` },
    });
    stdout = raw;
  } catch (e) {
    exitOk = false;
    const ex = e as { stdout?: string; stderr?: string; message?: string };
    stdout = ex.stdout ?? "";
    stderr = ex.stderr ?? ex.message ?? String(e);
  }

  const combined = stdout + "\n" + stderr;
  const parsed = cfg.parser === "node"
    ? parseNodeTest(combined)
    : parseUnittest(combined);

  // If parser found results, trust that; otherwise use exit code
  const ok = parsed.total > 0 ? parsed.ok : exitOk;

  logSystemEvent({
    category: "testing",
    action: "run",
    summary: `${name}: ${ok ? "PASS" : "FAIL"} (${parsed.pass}/${parsed.total})`,
    detail: { suite: name, ...parsed },
    status: ok ? "ok" : "error",
  });

  return {
    pass: parsed.pass,
    fail: parsed.fail,
    total: parsed.total,
    ok,
    output: combined.slice(0, 10_000), // cap stored output
    ranAt,
  };
}

// ── Persistence ─────────────────────────────────────────────────────────────

interface PersistedResults {
  suites: Record<string, SuiteResult>;
}

function loadResults(): PersistedResults {
  try {
    return JSON.parse(fs.readFileSync(RESULTS_PATH, "utf-8"));
  } catch {
    return { suites: {} };
  }
}

function saveResults(data: PersistedResults): void {
  fs.writeFileSync(RESULTS_PATH, JSON.stringify(data, null, 2));
}

// ── Handlers ────────────────────────────────────────────────────────────────

export async function GET() {
  return NextResponse.json({ ok: true, ...loadResults() });
}

export async function POST(request: Request) {
  try {
    const body = await request.json().catch(() => ({}));
    const suiteName = (body.suite as string) || "all";

    const suitesToRun = suiteName === "all"
      ? Object.keys(SUITES)
      : SUITES[suiteName]
        ? [suiteName]
        : null;

    if (!suitesToRun) {
      return NextResponse.json(
        { ok: false, error: `Unknown suite: ${suiteName}. Valid: ${Object.keys(SUITES).join(", ")}` },
        { status: 400 },
      );
    }

    const results: Record<string, SuiteResult> = {};
    for (const name of suitesToRun) {
      results[name] = runSuite(name, SUITES[name]);
    }

    // Merge into persisted results
    const persisted = loadResults();
    Object.assign(persisted.suites, results);
    saveResults(persisted);

    return NextResponse.json({ ok: true, suites: results });
  } catch (err) {
    return NextResponse.json(
      { ok: false, error: err instanceof Error ? err.message : String(err) },
      { status: 500 },
    );
  }
}
