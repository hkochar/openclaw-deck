import { NextRequest, NextResponse } from "next/server";
import { execFileSync } from "child_process";
import fs from "fs";
import path from "path";
import { safePath, safeGitSha, parseDiff } from "@/app/api/_lib/git-utils";
import { WORKSPACE_DIR, DECK_DIR } from "@/app/api/_lib/paths";
import { commitWorkspaceFile } from "@/app/api/_lib/config-git";
import { logSystemEvent } from "@/app/api/_lib/system-log";

export const dynamic = "force-dynamic";

function resolveRepo(repo: string | null): string {
  if (repo === "deck") return DECK_DIR;
  return WORKSPACE_DIR;
}

export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url);
  const action = searchParams.get("action") || "log";
  const filePath = searchParams.get("file");
  const cwd = resolveRepo(searchParams.get("repo"));

  if (!filePath) {
    return NextResponse.json({ error: "Missing file param" }, { status: 400 });
  }
  const safe = safePath(filePath);
  if (!safe) {
    return NextResponse.json({ error: "Invalid file path" }, { status: 400 });
  }

  try {
    if (action === "log") {
      const limit = Number(searchParams.get("limit") || 30);
      const output = execFileSync(
        "git", ["log", `--format=%H %aI %s`, `-${limit}`, "--", safe],
        { cwd, encoding: "utf-8", timeout: 5000 },
      );
      const commits = output.trim().split("\n").filter(Boolean).map(line => {
        const sp1 = line.indexOf(" ");
        const sha = line.slice(0, sp1);
        const rest = line.slice(sp1 + 1);
        const sp2 = rest.indexOf(" ");
        const date = rest.slice(0, sp2);
        const message = rest.slice(sp2 + 1);
        return { sha, date, message, short: sha.slice(0, 7) };
      });
      return NextResponse.json({ ok: true, commits });
    }

    if (action === "show") {
      const sha = searchParams.get("sha");
      if (!sha || !safeGitSha(sha)) {
        return NextResponse.json({ error: "Invalid SHA" }, { status: 400 });
      }
      const content = execFileSync(
        "git", ["show", `${sha}:${safe}`],
        { cwd, encoding: "utf-8", timeout: 5000 },
      );
      return NextResponse.json({ ok: true, content });
    }

    if (action === "diff") {
      const from = searchParams.get("from");
      const to = searchParams.get("to");

      if (!from || !safeGitSha(from)) {
        return NextResponse.json({ error: "Invalid 'from' SHA" }, { status: 400 });
      }

      let diffOutput: string;
      if (!to || to === "working") {
        diffOutput = execFileSync(
          "git", ["diff", from, "--", safe],
          { cwd, encoding: "utf-8", timeout: 5000 },
        );
      } else {
        if (!safeGitSha(to)) {
          return NextResponse.json({ error: "Invalid 'to' SHA" }, { status: 400 });
        }
        diffOutput = execFileSync(
          "git", ["diff", from, to, "--", safe],
          { cwd, encoding: "utf-8", timeout: 5000 },
        );
      }

      const lines = parseDiff(diffOutput);
      return NextResponse.json({ ok: true, raw: diffOutput, lines });
    }

    return NextResponse.json({ error: `Unknown action: ${action}` }, { status: 400 });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes("does not exist") || msg.includes("exists on disk")) {
      return NextResponse.json({ ok: true, commits: [], lines: [], content: "", raw: "" });
    }
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}

/** POST: restore a file from git history */
export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const { file, content, repo } = body;

    if (!file || typeof content !== "string") {
      return NextResponse.json({ ok: false, error: "Missing file or content" }, { status: 400 });
    }

    const safe = safePath(file);
    if (!safe) {
      return NextResponse.json({ ok: false, error: "Invalid file path" }, { status: 400 });
    }

    const cwd = resolveRepo(repo || null);
    const absPath = path.join(cwd, safe);

    const dir = path.dirname(absPath);
    if (!fs.existsSync(dir)) {
      return NextResponse.json({ ok: false, error: "Directory does not exist" }, { status: 400 });
    }

    fs.writeFileSync(absPath, content, "utf-8");

    const fileName = path.basename(safe);
    logSystemEvent({
      category: "config",
      action: "restore",
      summary: `Restored ${fileName} from git history`,
      status: "ok",
    });

    commitWorkspaceFile(safe, `restore ${fileName} from git history`);

    return NextResponse.json({ ok: true });
  } catch (e) {
    return NextResponse.json(
      { ok: false, error: e instanceof Error ? e.message : String(e) },
      { status: 500 },
    );
  }
}
