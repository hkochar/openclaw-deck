"use client";

import { useEffect, useState, useCallback, useRef, Suspense } from "react";
import { useSearchParams } from "next/navigation";
import { useHashTab } from "@/components/use-hash-tab";

// ── Tab definitions ──────────────────────────────────────────────

const TABS = [
  { key: "config", label: "Config Editor", file: "openclaw.json", path: "~/.openclaw/openclaw.json" },
  { key: "crons", label: "Cron Jobs", file: "cron/jobs.json", path: "~/.openclaw/cron/jobs.json" },
  { key: "exec", label: "Exec Approvals", file: "exec-approvals.json", path: "~/.openclaw/exec-approvals.json" },
  { key: "update", label: "Update Checks", file: "update-check.json", path: "~/.openclaw/update-check.json" },
] as const;

type TabKey = (typeof TABS)[number]["key"];
const TAB_KEYS = TABS.map(t => t.key) as unknown as readonly TabKey[];

// ── Types ────────────────────────────────────────────────────────

interface Backup {
  id: string;
  label: string;
  source: "file" | "git";
  timestamp: string;
  timestampMs: number;
}

interface DiffLine {
  type: "add" | "del" | "ctx" | "hdr";
  content: string;
  oldLine?: number;
  newLine?: number;
}

interface GitCommit {
  sha: string;
  short: string;
  date: string;
  message: string;
}

function relativeTime(ts: string): string {
  const ms = Date.now() - new Date(ts).getTime();
  if (ms < 60_000) return "just now";
  if (ms < 3_600_000) return `${Math.floor(ms / 60_000)}m ago`;
  if (ms < 86_400_000) return `${Math.floor(ms / 3_600_000)}h ago`;
  return `${Math.floor(ms / 86_400_000)}d ago`;
}

// Git file path mapping — workspace repo uses flat filenames
function gitFilePath(file: string): string {
  if (file === "cron/jobs.json") return "cron-jobs.json";
  return file;
}

function ConfigPageInner() {
  const [activeTab, setActiveTab] = useHashTab<TabKey>("config", TAB_KEYS);
  const tab = TABS.find(t => t.key === activeTab)!;
  const searchParams = useSearchParams();
  const searchHighlight = searchParams.get("search") ?? "";
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  const [content, setContent] = useState("");
  const [originalContent, setOriginalContent] = useState("");
  const [backups, setBackups] = useState<Backup[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [saveStatus, setSaveStatus] = useState<"idle" | "saving" | "saved" | "error">("idle");
  const [saveError, setSaveError] = useState("");
  const [previewingId, setPreviewingId] = useState<string | null>(null);
  const [previewingLabel, setPreviewingLabel] = useState<string>("");
  const [jsonError, setJsonError] = useState<string | null>(null);
  const [confirmRestore, setConfirmRestore] = useState(false);

  // Diff state
  const [showDiff, setShowDiff] = useState(false);
  const [gitCommits, setGitCommits] = useState<GitCommit[]>([]);
  const [diffFrom, setDiffFrom] = useState("");
  const [diffTo, setDiffTo] = useState("working");
  const [diffLines, setDiffLines] = useState<DiffLine[]>([]);
  const [diffLoading, setDiffLoading] = useState(false);

  const loadConfig = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const res = await fetch(`/api/config?file=${tab.file}`);
      const data = await res.json();
      if (data.ok) {
        const formatted = formatJson(data.raw);
        setContent(formatted);
        setOriginalContent(formatted);
        setBackups(data.backups || []);
        setPreviewingId(null);
        setJsonError(null);
      } else {
        setError(data.error || "Failed to load config");
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, [tab.file]);

  useEffect(() => { loadConfig(); }, [loadConfig]);

  // Load git commits for diff selectors
  useEffect(() => {
    const gfp = gitFilePath(tab.file);
    fetch(`/api/git-file?action=log&file=${gfp}&limit=50`)
      .then(r => r.json())
      .then(data => {
        if (data.ok && data.commits?.length) {
          setGitCommits(data.commits);
          setDiffFrom(data.commits[0].sha);
        } else {
          setGitCommits([]);
          setDiffFrom("");
        }
      })
      .catch(() => { setGitCommits([]); setDiffFrom(""); });
  }, [tab.file]);

  // Validate JSON on every edit
  useEffect(() => {
    if (!content.trim()) { setJsonError(null); return; }
    try { JSON.parse(content); setJsonError(null); }
    catch (e) { setJsonError(e instanceof SyntaxError ? e.message : String(e)); }
  }, [content]);

  // Load diff when selectors change
  useEffect(() => {
    if (!showDiff || !diffFrom) { setDiffLines([]); return; }
    setDiffLoading(true);
    const gfp = gitFilePath(tab.file);
    const toParam = diffTo === "working" ? "" : `&to=${diffTo}`;
    fetch(`/api/git-file?action=diff&file=${gfp}&from=${diffFrom}${toParam}`)
      .then(r => r.json())
      .then(data => { if (data.ok) setDiffLines(data.lines ?? []); })
      .catch(() => setDiffLines([]))
      .finally(() => setDiffLoading(false));
  }, [showDiff, diffFrom, diffTo, tab.file]);

  function formatJson(raw: string): string {
    try { return JSON.stringify(JSON.parse(raw), null, 2); }
    catch { return raw; }
  }

  async function handleSave() {
    setSaveStatus("saving");
    setSaveError("");
    try {
      const res = await fetch(`/api/config?file=${tab.file}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "save", content }),
      });
      const data = await res.json();
      if (data.ok) {
        setSaveStatus("saved");
        setOriginalContent(content);
        setPreviewingId(null);
        const refreshRes = await fetch(`/api/config?file=${tab.file}`);
        const refreshData = await refreshRes.json();
        if (refreshData.ok) setBackups(refreshData.backups || []);
        setTimeout(() => setSaveStatus("idle"), 2000);
      } else {
        setSaveStatus("error");
        setSaveError(data.error || "Save failed");
      }
    } catch (e) {
      setSaveStatus("error");
      setSaveError(e instanceof Error ? e.message : String(e));
    }
  }

  async function handlePreview(backup: Backup) {
    try {
      const res = await fetch(`/api/config?file=${tab.file}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "preview", backupId: backup.id, source: backup.source }),
      });
      const data = await res.json();
      if (data.ok) {
        setContent(formatJson(data.content));
        setPreviewingId(backup.id);
        setPreviewingLabel(backup.label);
        setJsonError(null);
      }
    } catch {}
  }

  async function handleRestore(backup: Backup) {
    try {
      const res = await fetch(`/api/config?file=${tab.file}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "restore", backupId: backup.id, source: backup.source }),
      });
      const data = await res.json();
      if (data.ok) {
        const formatted = formatJson(data.content);
        setContent(formatted);
        setOriginalContent(formatted);
        setPreviewingId(null);
        setSaveStatus("saved");
        const refreshRes = await fetch(`/api/config?file=${tab.file}`);
        const refreshData = await refreshRes.json();
        if (refreshData.ok) setBackups(refreshData.backups || []);
        setTimeout(() => setSaveStatus("idle"), 2000);
      }
    } catch {}
  }

  function handleFormat() {
    try { setContent(JSON.stringify(JSON.parse(content), null, 2)); } catch {}
  }

  function handleDiscard() {
    setContent(originalContent);
    setPreviewingId(null);
    setJsonError(null);
    setShowDiff(false);
    setConfirmRestore(false);
  }

  function handleDiffFromBackup(sha: string) {
    setDiffFrom(sha);
    setDiffTo("working");
    setShowDiff(true);
  }

  async function handleDiffFromFileBackup(backup: Backup) {
    await handlePreview(backup);
    if (gitCommits.length > 0) {
      setDiffFrom(gitCommits[0].sha);
      setDiffTo("working");
    }
    setShowDiff(true);
  }

  function switchTab(key: TabKey) {
    if (key === activeTab) return;
    setActiveTab(key);
  }

  // Reset editor state whenever the active tab changes
  useEffect(() => {
    setContent("");
    setOriginalContent("");
    setBackups([]);
    setPreviewingId(null);
    setPreviewingLabel("");
    setJsonError(null);
    setSaveStatus("idle");
    setSaveError("");
    setShowDiff(false);
    setGitCommits([]);
    setDiffFrom("");
    setDiffTo("working");
    setDiffLines([]);
    setConfirmRestore(false);
  }, [activeTab]);

  // Scroll textarea to search highlight when content loads from deep link
  useEffect(() => {
    if (!searchHighlight || !content || !textareaRef.current) return;
    const ta = textareaRef.current;
    // Find the search term in content (try dotted path first, then individual words)
    const terms = searchHighlight.split(/\s+/).filter(Boolean);
    let idx = -1;
    for (const term of terms) {
      // Try exact match first
      idx = content.indexOf(term);
      if (idx >= 0) break;
      // Try case-insensitive
      idx = content.toLowerCase().indexOf(term.toLowerCase());
      if (idx >= 0) break;
      // For dotted paths, try last segment (the key name)
      if (term.includes(".")) {
        const lastSeg = term.split(".").pop()!;
        idx = content.indexOf(`"${lastSeg}"`);
        if (idx >= 0) break;
      }
    }
    if (idx >= 0) {
      ta.focus();
      // Select the matching text
      const matchLen = terms.find(t => {
        const i = content.toLowerCase().indexOf(t.toLowerCase());
        return i >= 0;
      })?.length ?? 0;
      ta.setSelectionRange(idx, idx + matchLen);
      // Scroll to the match — calculate approximate line position
      const linesBefore = content.slice(0, idx).split("\n").length;
      const lineHeight = 18; // approximate monospace line height
      ta.scrollTop = Math.max(0, (linesBefore - 5) * lineHeight);
    }
  }, [searchHighlight, content]);

  const isDirty = content !== originalContent;
  const isValid = jsonError === null && content.trim().length > 0;
  const needsFormat = isValid && (() => {
    try { return JSON.stringify(JSON.parse(content), null, 2) !== content; }
    catch { return false; }
  })();

  if (loading) return (
    <div className="cfg-page">
      <div className="ds-tabs">
        {TABS.map(t => (
          <button key={t.key} className={`ds-tab${t.key === activeTab ? " active" : ""}`} onClick={() => switchTab(t.key)}>{t.label}</button>
        ))}
      </div>
      <p style={{ color: "var(--text-muted)" }}>Loading {tab.label.toLowerCase()}...</p>
    </div>
  );

  if (error) return (
    <div className="cfg-page">
      <div className="ds-tabs">
        {TABS.map(t => (
          <button key={t.key} className={`ds-tab${t.key === activeTab ? " active" : ""}`} onClick={() => switchTab(t.key)}>{t.label}</button>
        ))}
      </div>
      <p style={{ color: "#ef4444" }}>Error: {error}</p>
    </div>
  );

  return (
    <div className="cfg-page">
      {/* Tab bar */}
      <div className="ds-tabs">
        {TABS.map(t => (
          <button key={t.key} className={`ds-tab${t.key === activeTab ? " active" : ""}`} onClick={() => switchTab(t.key)}>{t.label}</button>
        ))}
      </div>

      <div className="cfg-header">
        <h2>{tab.label}</h2>
        <p className="cfg-subtitle">{tab.path}</p>
      </div>

      <div className="cfg-layout">
        {/* Left: Editor + Diff */}
        <div className="cfg-editor-panel">
          <div className="cfg-toolbar">
            <div className="cfg-status">
              {jsonError ? (
                <span className="cfg-status-badge cfg-status-badge--error">Invalid JSON</span>
              ) : (
                <span className="cfg-status-badge cfg-status-badge--ok">Valid JSON</span>
              )}
              {previewingId && (
                <span className="cfg-status-badge cfg-status-badge--preview">Previewing: {previewingLabel}</span>
              )}
              {isDirty && !previewingId && (
                <span className="cfg-status-badge cfg-status-badge--dirty">Unsaved changes</span>
              )}
            </div>
            <div className="cfg-actions">
              {!showDiff && needsFormat && <button className="cfg-btn" onClick={handleFormat}>Format</button>}
              {gitCommits.length > 0 && (
                <button
                  className={`cfg-btn${showDiff ? " cfg-btn--active" : ""}`}
                  onClick={() => setShowDiff(!showDiff)}
                >
                  Diff
                </button>
              )}
              {!showDiff && (isDirty || previewingId) && (
                <button className="cfg-btn cfg-btn--muted" onClick={handleDiscard}>Discard</button>
              )}
              {!showDiff && isDirty && !confirmRestore && (
                <button
                  className="cfg-btn cfg-btn--primary"
                  onClick={() => previewingId ? setConfirmRestore(true) : handleSave()}
                  disabled={!isValid || saveStatus === "saving"}
                >
                  {saveStatus === "saving" ? "Saving..." : saveStatus === "saved" ? "Saved" : previewingId ? "Restore" : "Save"}
                </button>
              )}
              {confirmRestore && (
                <>
                  <span className="cfg-confirm-warn">Overwrite current config with this backup?</span>
                  <button className="cfg-btn" onClick={() => setConfirmRestore(false)}>Cancel</button>
                  <button className="cfg-btn cfg-btn--danger" onClick={() => { setConfirmRestore(false); handleSave(); }}>Confirm Restore</button>
                </>
              )}
            </div>
          </div>

          {jsonError && <div className="cfg-error-bar">{jsonError}</div>}
          {saveStatus === "error" && saveError && <div className="cfg-error-bar">{saveError}</div>}

          {/* Diff from/to selectors */}
          {showDiff && gitCommits.length > 0 && (
            <div className="fv-diff-bar">
              <span className="fv-diff-label">From:</span>
              <select className="fv-git-select" value={diffFrom} onChange={e => setDiffFrom(e.target.value)}>
                {gitCommits.map(c => (
                  <option key={c.sha} value={c.sha}>
                    {c.short} — {c.message.slice(0, 50)} ({relativeTime(c.date)})
                  </option>
                ))}
              </select>
              <span className="fv-diff-label">To:</span>
              <select className="fv-git-select" value={diffTo} onChange={e => setDiffTo(e.target.value)}>
                <option value="working">Working copy</option>
                {gitCommits.map(c => (
                  <option key={c.sha} value={c.sha}>
                    {c.short} — {c.message.slice(0, 50)} ({relativeTime(c.date)})
                  </option>
                ))}
              </select>
              <button className="cfg-btn" onClick={() => setShowDiff(false)}>Close</button>
            </div>
          )}

          {/* Editor textarea (hidden when diff is active) */}
          <textarea
            ref={textareaRef}
            className="cfg-textarea"
            value={content}
            onChange={(e) => setContent(e.target.value)}
            spellCheck={false}
            style={showDiff ? { display: "none" } : undefined}
          />

          {/* Diff viewer */}
          {showDiff && (
            <div className="fv-diff" style={{ flex: 1 }}>
              {diffLoading && <div className="loading" style={{ padding: 20 }}>Loading diff...</div>}
              {!diffLoading && diffLines.length === 0 && <div className="fv-diff-empty">No changes between these versions</div>}
              {!diffLoading && diffLines.map((line, i) => (
                <div key={i} className={`fv-diff-line fv-diff-line--${line.type}`}>
                  <span className="fv-diff-gutter">
                    {line.type === "del" ? line.oldLine : line.type === "add" ? line.newLine : line.type === "ctx" ? line.newLine : ""}
                  </span>
                  <span className="fv-diff-sign">
                    {line.type === "add" ? "+" : line.type === "del" ? "-" : line.type === "ctx" ? " " : ""}
                  </span>
                  <span className="fv-diff-text">{line.content}</span>
                </div>
              ))}
            </div>
          )}
        </div>

        {/* Right: Backups */}
        <div className="cfg-backups-panel">
          <div className="cfg-backups-header">
            <span className="cfg-backups-title">Backups</span>
            <span className="cfg-backups-count">{backups.length}</span>
          </div>
          <div className="cfg-backups-list">
            {backups.length === 0 && (
              <p className="cfg-backups-empty">No backups found</p>
            )}
            {backups.map((b) => (
              <div
                key={`${b.source}-${b.id}`}
                className={`cfg-backup-item ${previewingId === b.id ? "cfg-backup-item--active" : ""}`}
              >
                <div className="cfg-backup-top">
                  <span className={`cfg-backup-source cfg-backup-source--${b.source}`}>
                    {b.source}
                  </span>
                  <span className="cfg-backup-time">{relativeTime(b.timestamp)}</span>
                </div>
                <div className="cfg-backup-label">{b.label}</div>
                <div className="cfg-backup-actions">
                  <button className="cfg-btn cfg-btn--sm" onClick={() => handlePreview(b)}>Preview</button>
                  {b.source === "git" ? (
                    <button
                      className={`cfg-btn cfg-btn--sm${showDiff && diffFrom === b.id ? " cfg-btn--active" : ""}`}
                      onClick={() => handleDiffFromBackup(b.id)}
                    >
                      Diff
                    </button>
                  ) : (
                    <button
                      className={`cfg-btn cfg-btn--sm${showDiff && previewingId === b.id ? " cfg-btn--active" : ""}`}
                      onClick={() => handleDiffFromFileBackup(b)}
                    >
                      Diff
                    </button>
                  )}
                  <button className="cfg-btn cfg-btn--sm" onClick={() => handleRestore(b)}>Restore</button>
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}

export default function ConfigPage() {
  return (
    <Suspense fallback={<div className="cfg-page"><p style={{ color: "var(--text-muted)" }}>Loading...</p></div>}>
      <ConfigPageInner />
    </Suspense>
  );
}
