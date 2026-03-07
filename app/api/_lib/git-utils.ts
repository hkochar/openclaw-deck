/**
 * Git-related utility functions.
 *
 * Extracted from git-file/route.ts for testability.
 */

export interface DiffLine {
  type: "add" | "del" | "ctx" | "hdr";
  content: string;
  oldLine?: number;
  newLine?: number;
}

/** Validate a path is within workspace to prevent traversal and shell injection. */
export function safePath(filePath: string): string | null {
  if (filePath.startsWith("/") || filePath.includes("..")) return null;
  // Reject shell metacharacters that could enable command injection
  if (/[`$\\|;&(){}<>!#*?\[\]\n\r]/.test(filePath)) return null;
  return filePath;
}

/** Validate a git SHA is a valid 7-40 char hex string. */
export function safeGitSha(sha: string): boolean {
  return /^[0-9a-f]{7,40}$/.test(sha);
}

/** Parse a unified diff string into structured DiffLine objects. */
export function parseDiff(raw: string): DiffLine[] {
  const result: DiffLine[] = [];
  let oldLine = 0;
  let newLine = 0;

  for (const line of raw.split("\n")) {
    if (line.startsWith("@@")) {
      const m = line.match(/@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
      if (m) {
        oldLine = parseInt(m[1], 10);
        newLine = parseInt(m[2], 10);
      }
      result.push({ type: "hdr", content: line });
    } else if (line.startsWith("+++") || line.startsWith("---") || line.startsWith("diff ") || line.startsWith("index ")) {
      result.push({ type: "hdr", content: line });
    } else if (line.startsWith("+")) {
      result.push({ type: "add", content: line.slice(1), newLine: newLine++ });
    } else if (line.startsWith("-")) {
      result.push({ type: "del", content: line.slice(1), oldLine: oldLine++ });
    } else if (line.startsWith(" ")) {
      result.push({ type: "ctx", content: line.slice(1), oldLine: oldLine++, newLine: newLine++ });
    }
  }
  return result;
}
