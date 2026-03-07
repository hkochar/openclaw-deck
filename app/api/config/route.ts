import { NextResponse } from "next/server";
import fs from "fs";
import path from "path";
import { execFileSync } from "child_process";
import { commitConfigChange, commitWorkspaceFile } from "@/app/api/_lib/config-git";
import { logSystemEvent } from "@/app/api/_lib/system-log";
import { stripSecrets } from "@/app/api/_lib/security";

export const dynamic = "force-dynamic";

const HOME = process.env.HOME || "~";
const CONFIG_DIR = path.join(HOME, ".openclaw");
const WORKSPACE_DIR = path.join(HOME, ".openclaw", "workspace");

// Whitelist of editable config files — prevents arbitrary file access
interface FileSpec {
  absPath: string;
  backupPrefix: string;
  backupDir: string;
  /** Relative path inside workspace repo for git tracking (null = not tracked) */
  workspacePath: string | null;
  label: string;
  /** Fields to redact from the editor (shown as "••••••") */
  redactPaths?: string[][];
}

const ALLOWED_FILES: Record<string, FileSpec> = {
  "openclaw.json": {
    absPath: path.join(CONFIG_DIR, "openclaw.json"),
    backupPrefix: "openclaw.json",
    backupDir: CONFIG_DIR,
    workspacePath: "openclaw.json",
    label: "Config",
    redactPaths: [
      ["socket", "token"],
      ["channels", "discord", "token"],
      ["channels", "telegram", "token"],
      ["channels", "slack", "token"],
    ],
  },
  "cron/jobs.json": {
    absPath: path.join(CONFIG_DIR, "cron", "jobs.json"),
    backupPrefix: "jobs.json",
    backupDir: path.join(CONFIG_DIR, "cron"),
    workspacePath: "cron-jobs.json",
    label: "Cron Jobs",
  },
  "exec-approvals.json": {
    absPath: path.join(CONFIG_DIR, "exec-approvals.json"),
    backupPrefix: "exec-approvals.json",
    backupDir: CONFIG_DIR,
    workspacePath: null,
    label: "Exec Approvals",
    redactPaths: [["socket", "token"]],
  },
  "update-check.json": {
    absPath: path.join(CONFIG_DIR, "update-check.json"),
    backupPrefix: "update-check.json",
    backupDir: CONFIG_DIR,
    workspacePath: "update-check.json",
    label: "Update Checks",
  },
};

function resolveFile(fileParam: string | null): FileSpec | null {
  const key = fileParam || "openclaw.json";
  return ALLOWED_FILES[key] ?? null;
}

const REDACTED = "••••••";

/** Redact sensitive fields before sending to the editor */
function redactJson(raw: string, paths: string[][]): string {
  try {
    const obj = JSON.parse(raw);
    for (const keyPath of paths) {
      let target = obj;
      for (let i = 0; i < keyPath.length - 1; i++) {
        if (target == null || typeof target !== "object") break;
        target = target[keyPath[i]];
      }
      const lastKey = keyPath[keyPath.length - 1];
      if (target != null && typeof target === "object" && lastKey in target) {
        target[lastKey] = REDACTED;
      }
    }
    return JSON.stringify(obj, null, 2);
  } catch {
    return raw;
  }
}

/** Restore redacted fields from the original file before saving */
function unredactJson(edited: string, spec: FileSpec): string {
  if (!spec.redactPaths?.length) return edited;
  try {
    const editedObj = JSON.parse(edited);
    const originalObj = JSON.parse(fs.readFileSync(spec.absPath, "utf-8"));
    for (const keyPath of spec.redactPaths) {
      // Walk to the parent in both objects
      let editTarget = editedObj;
      let origTarget = originalObj;
      for (let i = 0; i < keyPath.length - 1; i++) {
        if (editTarget == null || typeof editTarget !== "object") break;
        if (origTarget == null || typeof origTarget !== "object") break;
        editTarget = editTarget[keyPath[i]];
        origTarget = origTarget[keyPath[i]];
      }
      const lastKey = keyPath[keyPath.length - 1];
      // If the edited value is still the redacted placeholder, restore original
      if (editTarget?.[lastKey] === REDACTED && origTarget?.[lastKey] != null) {
        editTarget[lastKey] = origTarget[lastKey];
      }
    }
    return JSON.stringify(editedObj, null, 2);
  } catch {
    return edited;
  }
}

interface Backup {
  id: string;
  label: string;
  source: "file" | "git";
  timestamp: string;
  timestampMs: number;
}

function listFileBackups(spec: FileSpec): Backup[] {
  const backups: Backup[] = [];
  try {
    const entries = fs.readdirSync(spec.backupDir);
    for (const entry of entries) {
      if (
        !entry.startsWith(`${spec.backupPrefix}.bak`) &&
        !entry.startsWith(`${spec.backupPrefix}.backup`)
      )
        continue;
      const filePath = path.join(spec.backupDir, entry);
      try {
        const stat = fs.statSync(filePath);
        if (!stat.isFile()) continue;

        let label = entry.replace(`${spec.backupPrefix}.`, "");
        if (label === "bak") label = "Latest .bak";
        else if (label === "backup") label = "Latest .backup";
        else label = label.replace(/^(bak-|backup-)/, "");

        backups.push({
          id: entry,
          label,
          source: "file",
          timestamp: stat.mtime.toISOString(),
          timestampMs: stat.mtimeMs,
        });
      } catch {
        // skip unreadable
      }
    }
  } catch {
    // directory read failed
  }
  return backups;
}

function listGitBackups(spec: FileSpec): Backup[] {
  if (!spec.workspacePath) return [];
  const backups: Backup[] = [];
  try {
    const output = execFileSync(
      "git", ["log", "--format=%H %aI %s", "-20", "--", spec.workspacePath],
      { cwd: WORKSPACE_DIR, encoding: "utf-8", timeout: 5000 },
    );
    for (const line of output.trim().split("\n")) {
      if (!line.trim()) continue;
      const spaceIdx = line.indexOf(" ");
      const sha = line.slice(0, spaceIdx);
      const rest = line.slice(spaceIdx + 1);
      const spaceIdx2 = rest.indexOf(" ");
      const dateStr = rest.slice(0, spaceIdx2);
      const message = rest.slice(spaceIdx2 + 1);

      backups.push({
        id: sha,
        label: message || sha.slice(0, 8),
        source: "git",
        timestamp: dateStr,
        timestampMs: new Date(dateStr).getTime(),
      });
    }
  } catch {
    // git not available or no history
  }
  return backups;
}

/** Copy a config file into the workspace repo and commit it. */
function commitFileToWorkspace(spec: FileSpec, reason: string): void {
  if (!spec.workspacePath) return;
  if (spec.workspacePath === "openclaw.json") {
    commitConfigChange(reason);
    return;
  }
  const dst = path.join(WORKSPACE_DIR, spec.workspacePath);
  try {
    fs.copyFileSync(spec.absPath, dst);
  } catch {
    return;
  }
  commitWorkspaceFile(spec.workspacePath, reason);
}

export async function GET(request: Request) {
  const url = new URL(request.url);
  const spec = resolveFile(url.searchParams.get("file"));
  if (!spec) {
    return NextResponse.json({ ok: false, error: "Unknown file" }, { status: 400 });
  }

  try {
    let raw = fs.readFileSync(spec.absPath, "utf-8");
    if (spec.redactPaths?.length) raw = redactJson(raw, spec.redactPaths);
    raw = stripSecrets(raw);
    const fileBackups = listFileBackups(spec);
    const gitBackups = listGitBackups(spec);
    const backups = [...fileBackups, ...gitBackups].sort(
      (a, b) => b.timestampMs - a.timestampMs,
    );

    return NextResponse.json({ ok: true, raw, backups });
  } catch (err) {
    return NextResponse.json(
      { ok: false, error: err instanceof Error ? err.message : String(err) },
      { status: 500 },
    );
  }
}

export async function POST(request: Request) {
  const url = new URL(request.url);
  const spec = resolveFile(url.searchParams.get("file"));
  if (!spec) {
    return NextResponse.json({ ok: false, error: "Unknown file" }, { status: 400 });
  }

  try {
    const body = await request.json();
    const action = body.action as string;

    if (action === "save") {
      const content = body.content as string;
      if (!content?.trim()) {
        return NextResponse.json(
          { ok: false, error: "Empty content" },
          { status: 400 },
        );
      }
      // Validate JSON
      try {
        JSON.parse(content);
      } catch (e) {
        return NextResponse.json(
          {
            ok: false,
            error: `Invalid JSON: ${e instanceof Error ? e.message : String(e)}`,
          },
          { status: 400 },
        );
      }
      // Backup current
      try {
        fs.copyFileSync(spec.absPath, path.join(spec.backupDir, `${spec.backupPrefix}.bak`));
      } catch {
        // current file might not exist
      }
      // Restore any redacted fields from the original before writing
      const finalContent = unredactJson(content, spec);
      fs.writeFileSync(spec.absPath, finalContent, "utf-8");
      if (spec.workspacePath) commitFileToWorkspace(spec, `${spec.label}: manual edit via Config Editor`);
      logSystemEvent({ category: "config", action: "save", summary: `${spec.label} saved via editor`, status: "ok" });
      return NextResponse.json({ ok: true });
    }

    if (action === "preview" || action === "restore") {
      const backupId = body.backupId as string;
      const source = body.source as "file" | "git";

      if (!backupId) {
        return NextResponse.json(
          { ok: false, error: "Missing backupId" },
          { status: 400 },
        );
      }

      let content: string;

      if (source === "git") {
        if (!/^[0-9a-f]{7,40}$/.test(backupId)) {
          return NextResponse.json(
            { ok: false, error: "Invalid git SHA" },
            { status: 400 },
          );
        }
        try {
          content = execFileSync("git", ["show", `${backupId}:${spec.workspacePath}`], {
            cwd: WORKSPACE_DIR,
            encoding: "utf-8",
            timeout: 5000,
          });
        } catch (e) {
          return NextResponse.json(
            {
              ok: false,
              error: `Git show failed: ${e instanceof Error ? e.message : String(e)}`,
            },
            { status: 404 },
          );
        }
      } else {
        if (backupId.includes("/") || backupId.includes("..")) {
          return NextResponse.json(
            { ok: false, error: "Invalid backup filename" },
            { status: 400 },
          );
        }
        const backupPath = path.join(spec.backupDir, backupId);
        try {
          content = fs.readFileSync(backupPath, "utf-8");
        } catch {
          return NextResponse.json(
            { ok: false, error: `Backup file not found: ${backupId}` },
            { status: 404 },
          );
        }
      }

      if (action === "preview") {
        return NextResponse.json({ ok: true, content });
      }

      // Restore: backup current first, then write
      try {
        fs.copyFileSync(spec.absPath, path.join(spec.backupDir, `${spec.backupPrefix}.bak`));
      } catch {
        // current might not exist
      }
      fs.writeFileSync(spec.absPath, content, "utf-8");
      commitFileToWorkspace(spec, `${spec.label}: restored from ${source} backup ${backupId.slice(0, 12)}`);
      logSystemEvent({ category: "config", action: "restore", summary: `${spec.label} restored from ${source} backup ${backupId.slice(0, 12)}`, detail: { source, backupId }, status: "ok" });
      return NextResponse.json({ ok: true, content });
    }

    return NextResponse.json(
      { ok: false, error: `Unknown action: ${action}` },
      { status: 400 },
    );
  } catch (err) {
    return NextResponse.json(
      { ok: false, error: err instanceof Error ? err.message : String(err) },
      { status: 500 },
    );
  }
}
