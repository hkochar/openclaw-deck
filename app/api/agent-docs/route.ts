import { NextRequest, NextResponse } from 'next/server';
import fs from 'fs';
import path from 'path';
import { WORKSPACE_DIR } from '@/app/api/_lib/paths';
import { queryAgentsWithHealth } from '@/plugin/event-log';

export const dynamic = 'force-dynamic';

interface FileEntry {
  name: string;
  path: string;
  relativePath?: string;
  content: string;
  folder?: string;
  modified?: number;
}

interface AgentData {
  agentId: string;
  agentName: string;
  emoji: string;
  docs: FileEntry[];
  memory: FileEntry[];
}

import { agents, agentMetadata, agentDirs } from "@/lib/agent-config";

// Use the first configured agent as the "workspace" agent
const firstAgent = agents()[0];
const AGENT_METADATA: Record<string, { name: string; emoji: string }> = {
  ...agentMetadata(),
  workspace: firstAgent ? { name: firstAgent.name, emoji: firstAgent.emoji } : { name: "Workspace", emoji: "🏠" },
};

const AGENT_DIRS = agentDirs(WORKSPACE_DIR);

const WORKSPACE_ROOT = WORKSPACE_DIR;

import { stripSecrets } from '@/app/api/_lib/security';

function readMdFile(filePath: string): FileEntry | null {
  try {
    const stat = fs.statSync(filePath);
    if (!stat.isFile()) return null;
    const rel = filePath.startsWith(WORKSPACE_DIR + '/')
      ? filePath.slice(WORKSPACE_DIR.length + 1)
      : undefined;
    return {
      name: path.basename(filePath),
      path: filePath,
      relativePath: rel,
      content: stripSecrets(fs.readFileSync(filePath, 'utf-8')),
      modified: stat.mtimeMs,
    };
  } catch { return null; }
}

/** Read all .md files from a directory (non-recursive). */
function readMdFilesFlat(dir: string, folder?: string): FileEntry[] {
  const files: FileEntry[] = [];
  try {
    for (const entry of fs.readdirSync(dir)) {
      if (!entry.endsWith('.md')) continue;
      const f = readMdFile(path.join(dir, entry));
      if (f) {
        if (folder) f.folder = folder;
        files.push(f);
      }
    }
  } catch {}
  return files;
}

/** Directories to skip when recursively scanning for docs. */
const EXCLUDED_DIRS = new Set([
  'node_modules', '.next', '.git', '.turbo', '.vercel', 'dist', 'build',
  '.cache', '__pycache__', 'memory', 'screenshots',
]);

/** Recursively read all .md files from a directory tree, using subdir names as folder labels. */
function readMdFilesRecursive(dir: string, baseFolder: string, maxDepth = 3): FileEntry[] {
  const files: FileEntry[] = [];

  function walk(currentDir: string, folder: string, depth: number) {
    if (depth > maxDepth) return;
    try {
      for (const entry of fs.readdirSync(currentDir)) {
        const fullPath = path.join(currentDir, entry);
        try {
          const stat = fs.statSync(fullPath);
          if (stat.isDirectory()) {
            if (EXCLUDED_DIRS.has(entry) || entry.startsWith('.')) continue;
            const label = entry.charAt(0).toUpperCase() + entry.slice(1);
            const subFolder = `${folder}/${label}`;
            walk(fullPath, subFolder, depth + 1);
          } else if (entry.endsWith('.md')) {
            const f = readMdFile(fullPath);
            if (f) {
              f.folder = folder || baseFolder;
              files.push(f);
            }
          }
        } catch {}
      }
    } catch {}
  }

  walk(dir, baseFolder, 0);
  return files;
}

/** Classify a memory file name into a folder grouping. */
function classifyMemoryFile(name: string): string | undefined {
  if (name === 'WORKING.md' || name === 'MEMORY.md') return undefined; // pinned, no folder
  if (/^\d{4}-\d{2}-\d{2}\.md$/.test(name)) return 'Daily Notes';
  if (name === 'HISTORY.md') return undefined;
  return undefined; // ungrouped
}

/** Build memory entries for a given memory directory. */
function buildMemory(memoryDir: string, agentDir?: string): FileEntry[] {
  const entries: FileEntry[] = [];

  // Agent-level MEMORY.md (outside memory/ dir)
  if (agentDir) {
    const agentMemory = readMdFile(path.join(agentDir, 'MEMORY.md'));
    if (agentMemory) entries.push(agentMemory);
  }

  // Files directly in memory/
  const flat = readMdFilesFlat(memoryDir);
  for (const f of flat) {
    // Skip if we already added agent-level MEMORY.md
    if (agentDir && f.name === 'MEMORY.md' && entries.some(e => e.name === 'MEMORY.md')) continue;
    f.folder = classifyMemoryFile(f.name);
    entries.push(f);
  }

  // Subdirectories of memory/ (e.g. investigations/)
  try {
    for (const sub of fs.readdirSync(memoryDir)) {
      const subPath = path.join(memoryDir, sub);
      try {
        if (!fs.statSync(subPath).isDirectory()) continue;
        const folderName = sub.charAt(0).toUpperCase() + sub.slice(1); // capitalize
        const subFiles = readMdFilesFlat(subPath, folderName);
        entries.push(...subFiles);
      } catch {}
    }
  } catch {}

  return entries;
}

/** Names to exclude from docs (shown on Memory page instead). */
const MEMORY_FILES = new Set(['MEMORY.md', 'WORKING.md']);

/** Build docs entries for an agent. isPrimary=true includes workspace root .md files. */
function buildDocs(agentDir: string | null, isPrimary: boolean): FileEntry[] {
  const entries: FileEntry[] = [];

  // Agent-specific docs — all .md in the agent dir (not just AGENT.md/SOUL.md)
  if (agentDir) {
    const agentFiles = readMdFilesFlat(agentDir, 'Agent');
    entries.push(...agentFiles.filter(f => !MEMORY_FILES.has(f.name)));
  }

  // Shared docs from /workspace/docs/ (recursive)
  const sharedDir = path.join(WORKSPACE_ROOT, 'docs');
  entries.push(...readMdFilesRecursive(sharedDir, 'shared-docs'));

  // Deck dashboard docs — research/, audit/, and any other subdirs (recursive)
  const mcDir = process.cwd();
  for (const sub of ['research', 'audit']) {
    const subDir = path.join(mcDir, sub);
    try {
      if (fs.statSync(subDir).isDirectory()) {
        const label = sub.charAt(0).toUpperCase() + sub.slice(1);
        entries.push(...readMdFilesRecursive(subDir, label));
      }
    } catch {}
  }

  // Root workspace .md files — only for the primary agent
  if (isPrimary) {
    const rootFiles = readMdFilesFlat(WORKSPACE_ROOT, 'Workspace');
    entries.push(...rootFiles.filter(f => !MEMORY_FILES.has(f.name)));
  }

  return entries;
}

function fetchLastHeartbeats(): Record<string, number> {
  try {
    const agents = queryAgentsWithHealth();
    const map: Record<string, number> = {};
    for (const a of agents) {
      if (a.agent_key) map[a.agent_key] = a.last_heartbeat ?? 0;
    }
    if (firstAgent && map[firstAgent.key]) map['workspace'] = map[firstAgent.key];
    return map;
  } catch {
    return {};
  }
}

export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url);
  const includeContent = searchParams.get("content") !== "false";
  const results: AgentData[] = [];

  // Workspace agent — workspace-level memory + docs
  const wsMeta = AGENT_METADATA['workspace'];
  const wsMemoryDir = path.join(WORKSPACE_ROOT, 'memory');
  results.push({
    agentId: 'workspace',
    agentName: wsMeta.name,
    emoji: wsMeta.emoji,
    memory: buildMemory(wsMemoryDir),
    docs: buildDocs(null, true),
  });

  // Other agents
  for (const [agentId, dir] of Object.entries(AGENT_DIRS)) {
    const meta = AGENT_METADATA[agentId];
    const memoryDir = path.join(dir, 'memory');
    results.push({
      agentId,
      agentName: meta.name,
      emoji: meta.emoji,
      memory: buildMemory(memoryDir, dir),
      docs: buildDocs(dir, false),
    });
  }

  const heartbeats = await fetchLastHeartbeats();
  results.sort((a, b) => (heartbeats[b.agentId] ?? 0) - (heartbeats[a.agentId] ?? 0));

  if (!includeContent) {
    const lite = results.map(agent => ({
      ...agent,
      docs: agent.docs.map(({ content: _, ...rest }) => rest),
      memory: agent.memory.map(({ content: _, ...rest }) => rest),
    }));
    return NextResponse.json(lite);
  }

  return NextResponse.json(results);
}
