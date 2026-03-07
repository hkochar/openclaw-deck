import { NextRequest, NextResponse } from "next/server";
import fs from "fs";
import path from "path";
import { WORKSPACE_DIR } from "@/app/api/_lib/paths";
import { logSystemEvent } from "@/app/api/_lib/system-log";
import { commitSentinelConfig } from "@/app/api/_lib/config-git";

export const dynamic = "force-dynamic";

const SENTINEL_CONFIG = path.join(process.cwd(), "sentinel/deck-sentinel.json");

function readConfig() {
  try {
    return JSON.parse(fs.readFileSync(SENTINEL_CONFIG, "utf-8"));
  } catch {
    return null;
  }
}

export async function GET() {
  const cfg = readConfig();
  if (!cfg) {
    return NextResponse.json(
      { ok: false, error: "deck-sentinel.json not found" },
      { status: 404 },
    );
  }
  return NextResponse.json(cfg);
}

// ── Validation ───────────────────────────────────────────────────────────────

function validate(body: Record<string, unknown>): string[] {
  const errors: string[] = [];

  if (typeof body.loop_interval_seconds !== "number" || body.loop_interval_seconds < 60) {
    errors.push("loop_interval_seconds must be a number >= 60");
  }

  const checks = body.checks as Record<string, Record<string, unknown>> | undefined;
  if (!checks || typeof checks !== "object") {
    errors.push("checks must be an object");
    return errors;
  }

  for (const [name, check] of Object.entries(checks)) {
    if (typeof check.enabled !== "boolean") {
      errors.push(`checks.${name}.enabled must be a boolean`);
    }
  }

  // Numeric thresholds (top-level)
  const numericFields = [
    "working_md_max_age_hours",
    "gateway_health_timeout_seconds",
  ];
  for (const key of numericFields) {
    if (key in body && (typeof body[key] !== "number" || (body[key] as number) <= 0)) {
      errors.push(`${key} must be a positive number`);
    }
  }

  // URL fields
  const urlFields = ["gateway_url"];
  for (const key of urlFields) {
    const val = body[key];
    if (typeof val === "string" && val.trim() && !/^https?:\/\/.+/.test(val.trim())) {
      errors.push(`${key} must start with http:// or https://`);
    }
  }

  // Dashboard health URL (nested)
  const dashUrl = (checks.dashboard_health as Record<string, unknown> | undefined)?.url;
  if (typeof dashUrl === "string" && dashUrl.trim() && !/^https?:\/\/.+/.test(dashUrl.trim())) {
    errors.push("checks.dashboard_health.url must start with http:// or https://");
  }

  // Port conflicts ports array
  const portCheck = checks.port_conflicts as Record<string, unknown> | undefined;
  if (portCheck?.ports) {
    if (!Array.isArray(portCheck.ports)) {
      errors.push("checks.port_conflicts.ports must be an array");
    } else {
      for (const p of portCheck.ports) {
        if (typeof p !== "number" || p <= 0 || !Number.isInteger(p)) {
          errors.push(`checks.port_conflicts.ports: ${p} must be a positive integer`);
        }
      }
    }
  }

  // Boolean fields in checks
  if (portCheck && "auto_kill" in portCheck && typeof portCheck.auto_kill !== "boolean") {
    errors.push("checks.port_conflicts.auto_kill must be a boolean");
  }
  return errors;
}

// ── Diff helper ──────────────────────────────────────────────────────────────

/** Shallow diff two objects, returning human-readable change descriptions. */
function diffChanges(
  before: Record<string, unknown>,
  after: Record<string, unknown>,
  prefix = "",
): string[] {
  const changes: string[] = [];
  const allKeys = new Set([...Object.keys(before), ...Object.keys(after)]);

  for (const key of allKeys) {
    const path = prefix ? `${prefix}.${key}` : key;
    const oldVal = before[key];
    const newVal = after[key];

    if (key.startsWith("_")) continue; // skip _note etc.

    if (
      oldVal !== null && newVal !== null &&
      typeof oldVal === "object" && typeof newVal === "object" &&
      !Array.isArray(oldVal) && !Array.isArray(newVal)
    ) {
      changes.push(
        ...diffChanges(
          oldVal as Record<string, unknown>,
          newVal as Record<string, unknown>,
          path,
        ),
      );
    } else if (JSON.stringify(oldVal) !== JSON.stringify(newVal)) {
      changes.push(`${path}: ${JSON.stringify(oldVal)} → ${JSON.stringify(newVal)}`);
    }
  }
  return changes;
}

// ── POST ─────────────────────────────────────────────────────────────────────

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const errors = validate(body);
    if (errors.length > 0) {
      return NextResponse.json({ ok: false, errors }, { status: 400 });
    }

    const previous = readConfig() ?? {};

    fs.writeFileSync(SENTINEL_CONFIG, JSON.stringify(body, null, 2) + "\n", "utf-8");

    const changes = diffChanges(previous, body);

    logSystemEvent({
      category: "config",
      action: "save",
      summary: changes.length > 0
        ? `Sentinel config: ${changes.join(", ")}`
        : "Sentinel config saved (no changes)",
      detail: {
        file: "sentinel/deck-sentinel.json",
        changes,
      },
      status: "ok",
    });

    if (changes.length > 0) {
      commitSentinelConfig(changes.slice(0, 3).join(", "));
    }

    return NextResponse.json({ ok: true });
  } catch (err) {
    return NextResponse.json(
      { ok: false, errors: [err instanceof Error ? err.message : String(err)] },
      { status: 500 },
    );
  }
}
