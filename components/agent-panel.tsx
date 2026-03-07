'use client';

import { useEffect, useState, useMemo } from 'react';

/* ── Types ──────────────────────────────────────────────────────── */

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

export type PanelMode = 'memory' | 'docs';

/* ── Helpers ────────────────────────────────────────────────────── */

function timeAgo(ts: number): string {
  const diff = Date.now() - ts;
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  return `${Math.floor(hrs / 24)}d ago`;
}

function groupFiles(files: FileEntry[], pinnedNames: string[]) {
  const pinned: FileEntry[] = [];
  const folders: Record<string, FileEntry[]> = {};
  const ungrouped: FileEntry[] = [];

  for (const f of files) {
    if (pinnedNames.includes(f.name)) {
      pinned.push(f);
    } else if (f.folder) {
      if (!folders[f.folder]) folders[f.folder] = [];
      folders[f.folder].push(f);
    } else {
      ungrouped.push(f);
    }
  }

  for (const folder of Object.keys(folders)) {
    folders[folder].sort((a, b) => b.name.localeCompare(a.name));
  }
  pinned.sort((a, b) => pinnedNames.indexOf(a.name) - pinnedNames.indexOf(b.name));

  return { pinned, folders, ungrouped };
}

/* ── Inline FileTree (renders inside sidebar under agent) ──────── */

function InlineFileTree({ files, pinnedNames, selectedPath, onSelect }: {
  files: FileEntry[];
  pinnedNames: string[];
  selectedPath: string | null;
  onSelect: (f: FileEntry) => void;
}) {
  const { pinned, folders, ungrouped } = useMemo(() => groupFiles(files, pinnedNames), [files, pinnedNames]);
  const [openFolders, setOpenFolders] = useState<Set<string>>(() => {
    if (!selectedPath) return new Set<string>();
    const sel = files.find(f => f.path === selectedPath);
    return sel?.folder ? new Set([sel.folder]) : new Set<string>();
  });

  useEffect(() => {
    if (!selectedPath) return;
    const sel = files.find(f => f.path === selectedPath);
    if (sel?.folder) setOpenFolders(prev => {
      if (prev.has(sel.folder!)) return prev;
      return new Set([...prev, sel.folder!]);
    });
  }, [selectedPath, files]);

  const toggleFolder = (folder: string) => {
    setOpenFolders((prev) => {
      const next = new Set(prev);
      if (next.has(folder)) next.delete(folder); else next.add(folder);
      return next;
    });
  };

  if (files.length === 0) return <div className="ft-empty">No files</div>;

  return (
    <div className="ft-inline">
      {pinned.map((f) => (
        <button key={f.path} className={`ft-file ft-file--nested${selectedPath === f.path ? ' ft-file--active' : ''}`} onClick={() => onSelect(f)}>
          {f.name.replace(/\.md$/i, '')}
        </button>
      ))}
      {Object.entries(folders).map(([folder, items]) => (
        <div key={folder} className="ft-folder ft-folder--nested">
          <button className="ft-folder-toggle" onClick={() => toggleFolder(folder)}>
            <span className="ft-arrow">{openFolders.has(folder) ? '▾' : '▸'}</span>
            {folder}
            <span className="ft-count">{items.length}</span>
          </button>
          <div className={`ft-folder-children${openFolders.has(folder) ? '' : ' ft-folder-children--closed'}`}>
            {items.map((f) => (
              <button key={f.path} className={`ft-file ft-file--deep${selectedPath === f.path ? ' ft-file--active' : ''}`} onClick={() => onSelect(f)}>
                {f.name.replace(/\.md$/i, '')}
              </button>
            ))}
          </div>
        </div>
      ))}
      {ungrouped.map((f) => (
        <button key={f.path} className={`ft-file ft-file--nested${selectedPath === f.path ? ' ft-file--active' : ''}`} onClick={() => onSelect(f)}>
          {f.name.replace(/\.md$/i, '')}
        </button>
      ))}
    </div>
  );
}

/* ── Types for git ──────────────────────────────────────────────── */

interface GitCommit {
  sha: string;
  short: string;
  date: string;
  message: string;
}

interface DiffLine {
  type: 'add' | 'del' | 'ctx' | 'hdr';
  content: string;
  oldLine?: number;
  newLine?: number;
}


function relativeTime(dateStr: string): string {
  const diff = Date.now() - new Date(dateStr).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  return `${Math.floor(hrs / 24)}d ago`;
}

/* ── FileViewer with git history + diff ────────────────────────── */

function FileViewer({ file, contentLoading }: { file: FileEntry | null; contentLoading?: boolean }) {
  const [commits, setCommits] = useState<GitCommit[]>([]);
  const [diffFrom, setDiffFrom] = useState<string>('');
  const [diffTo, setDiffTo] = useState<string>('working');
  const [diffLines, setDiffLines] = useState<DiffLine[] | null>(null);
  const [diffLoading, setDiffLoading] = useState(false);
  const [showDiff, setShowDiff] = useState(false);
  const [previewSha, setPreviewSha] = useState<string>('');
  const [previewLabel, setPreviewLabel] = useState<string>('');
  const [previewContent, setPreviewContent] = useState<string>('');
  const [previewLoading, setPreviewLoading] = useState(false);
  const [confirmRestore, setConfirmRestore] = useState(false);
  const [restoreStatus, setRestoreStatus] = useState<'' | 'restoring' | 'restored'>('');

  const relPath = file?.relativePath ?? null;

  useEffect(() => {
    setCommits([]);
    setDiffLines(null);
    setShowDiff(false);
    setDiffFrom('');
    setDiffTo('working');
    setPreviewSha('');
    setPreviewContent('');
    setPreviewLabel('');
    setConfirmRestore(false);
    setRestoreStatus('');
    if (!relPath) return;

    fetch(`/api/git-file?action=log&file=${encodeURIComponent(relPath)}`)
      .then(r => r.json())
      .then(data => {
        if (data.ok && data.commits?.length) {
          setCommits(data.commits);
          setDiffFrom(data.commits[0].sha);
        }
      })
      .catch(() => {});
  }, [relPath]);

  useEffect(() => {
    if (!showDiff || !diffFrom || !relPath) { setDiffLines(null); return; }
    setDiffLoading(true);
    const toParam = diffTo === 'working' ? '' : `&to=${diffTo}`;
    fetch(`/api/git-file?action=diff&file=${encodeURIComponent(relPath)}&from=${diffFrom}${toParam}`)
      .then(r => r.json())
      .then(data => { if (data.ok) setDiffLines(data.lines ?? []); })
      .catch(() => {})
      .finally(() => setDiffLoading(false));
  }, [showDiff, diffFrom, diffTo, relPath]);

  useEffect(() => {
    if (!previewSha || !relPath) { setPreviewContent(''); return; }
    setPreviewLoading(true);
    fetch(`/api/git-file?action=show&file=${encodeURIComponent(relPath)}&sha=${previewSha}`)
      .then(r => r.json())
      .then(data => { if (data.ok) setPreviewContent(data.content ?? ''); })
      .catch(() => {})
      .finally(() => setPreviewLoading(false));
  }, [previewSha, relPath]);

  const handlePreview = (sha: string, label: string) => {
    setPreviewSha(sha);
    setPreviewLabel(label);
    setShowDiff(false);
    setConfirmRestore(false);
    setRestoreStatus('');
  };

  const handleDiscard = () => {
    setPreviewSha('');
    setPreviewContent('');
    setPreviewLabel('');
    setConfirmRestore(false);
    setRestoreStatus('');
  };

  const handleRestore = async () => {
    if (!relPath || !previewContent) return;
    setRestoreStatus('restoring');
    try {
      const res = await fetch('/api/git-file', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ file: relPath, content: previewContent }),
      });
      const data = await res.json();
      if (data.ok) {
        setRestoreStatus('restored');
        setConfirmRestore(false);
        const logRes = await fetch(`/api/git-file?action=log&file=${encodeURIComponent(relPath)}`);
        const logData = await logRes.json();
        if (logData.ok) {
          setCommits(logData.commits ?? []);
          if (logData.commits?.length) setDiffFrom(logData.commits[0].sha);
        }
        setPreviewSha('');
        setPreviewContent('');
        setPreviewLabel('');
      }
    } catch {}
    setTimeout(() => setRestoreStatus(''), 2000);
  };

  if (!file) return <div className="agents-placeholder">Select a file from the sidebar to view its contents, git history, and diffs.</div>;
  if (contentLoading) return <div className="agents-placeholder"><div className="loading">Loading file...</div></div>;

  const displayContent = previewSha ? previewContent : (file.content ?? '');

  return (
    <div className="fv-viewer">
      <div className="fv-header">
        <span className="fv-name">{file.name}</span>
        {file.modified && !previewSha ? <span className="fv-modified">Modified {timeAgo(file.modified)}</span> : null}
      </div>

      <div className="cfg-toolbar">
        <div className="cfg-status">
          {previewSha && (
            <span className="cfg-status-badge cfg-status-badge--preview">Previewing: {previewLabel}</span>
          )}
          {restoreStatus === 'restored' && (
            <span className="cfg-status-badge cfg-status-badge--ok">Restored</span>
          )}
          {commits.length > 0 && (
            <button
              className={`cfg-btn${showDiff ? ' cfg-btn--active' : ''}`}
              onClick={() => setShowDiff(!showDiff)}
            >
              Diff
            </button>
          )}
        </div>
        <div className="cfg-actions">
          {!showDiff && previewSha && !confirmRestore && (
            <>
              <button className="cfg-btn cfg-btn--muted" onClick={handleDiscard}>Discard</button>
              <button className="cfg-btn cfg-btn--primary" onClick={() => setConfirmRestore(true)}>
                Restore
              </button>
            </>
          )}
          {confirmRestore && (
            <>
              <span className="cfg-confirm-warn">Overwrite current file with this version?</span>
              <button className="cfg-btn" onClick={() => setConfirmRestore(false)}>Cancel</button>
              <button className="cfg-btn cfg-btn--danger" onClick={handleRestore} disabled={restoreStatus === 'restoring'}>
                {restoreStatus === 'restoring' ? 'Restoring...' : 'Confirm Restore'}
              </button>
            </>
          )}
        </div>
      </div>

      {showDiff && commits.length > 0 && (
        <div className="fv-diff-bar">
          <span className="fv-diff-label">From:</span>
          <select className="fv-git-select" value={diffFrom} onChange={e => setDiffFrom(e.target.value)}>
            {commits.map(c => (
              <option key={c.sha} value={c.sha}>{c.short} — {c.message.slice(0, 50)} ({relativeTime(c.date)})</option>
            ))}
          </select>
          <span className="fv-diff-label">To:</span>
          <select className="fv-git-select" value={diffTo} onChange={e => setDiffTo(e.target.value)}>
            <option value="working">Working copy</option>
            {commits.map(c => (
              <option key={c.sha} value={c.sha}>{c.short} — {c.message.slice(0, 50)} ({relativeTime(c.date)})</option>
            ))}
          </select>
          <button className="cfg-btn" onClick={() => setShowDiff(false)}>Close</button>
        </div>
      )}

      <div className="cfg-layout">
        <div className="cfg-editor-panel">
          {showDiff && diffLines !== null && (
            <div className="fv-diff" style={{ flex: 1 }}>
              {diffLoading && <div className="loading" style={{ padding: 20 }}>Loading diff...</div>}
              {!diffLoading && diffLines.length === 0 && <div className="fv-diff-empty">No changes</div>}
              {!diffLoading && diffLines.map((line, i) => (
                <div key={i} className={`fv-diff-line fv-diff-line--${line.type}`}>
                  <span className="fv-diff-gutter">
                    {line.type === 'del' ? line.oldLine : line.type === 'add' ? line.newLine : line.type === 'ctx' ? line.newLine : ''}
                  </span>
                  <span className="fv-diff-sign">
                    {line.type === 'add' ? '+' : line.type === 'del' ? '-' : line.type === 'ctx' ? ' ' : ''}
                  </span>
                  <span className="fv-diff-text">{line.content}</span>
                </div>
              ))}
            </div>
          )}

          {!showDiff && (
            <div className="fv-content">
              {previewLoading ? (
                <div className="loading">Loading...</div>
              ) : (
                displayContent.split('\n').map((line, i) => (
                  <span key={i}>{line}<br /></span>
                ))
              )}
            </div>
          )}
        </div>

        {commits.length > 0 && (
          <div className="cfg-backups-panel">
            <div className="cfg-backups-header">
              <span className="cfg-backups-title">History</span>
              <span className="cfg-backups-count">{commits.length}</span>
            </div>
            <div className="cfg-backups-list">
              {commits.map((c) => (
                <div
                  key={c.sha}
                  className={`cfg-backup-item${previewSha === c.sha ? ' cfg-backup-item--active' : ''}`}
                >
                  <div className="cfg-backup-top">
                    <span className="cfg-backup-source cfg-backup-source--git">git</span>
                    <span className="cfg-backup-time">{relativeTime(c.date)}</span>
                  </div>
                  <div className="cfg-backup-label">{c.message}</div>
                  <div className="cfg-backup-actions">
                    <button className="cfg-btn cfg-btn--sm" onClick={() => handlePreview(c.sha, c.message)}>Preview</button>
                    <button
                      className={`cfg-btn cfg-btn--sm${showDiff && diffFrom === c.sha ? ' cfg-btn--active' : ''}`}
                      onClick={() => { setDiffFrom(c.sha); setDiffTo('working'); setShowDiff(true); }}
                    >
                      Diff
                    </button>
                    <button className="cfg-btn cfg-btn--sm" onClick={() => handlePreview(c.sha, c.message)}>Restore</button>
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

/* ── Main Panel ─────────────────────────────────────────────────── */

function buildNavPath(agent: AgentData | null, file: FileEntry | null): string {
  if (!agent) return '';
  const name = agent.agentName.toLowerCase();
  if (!file) return name;
  const fileName = file.name.replace(/\.md$/i, '');
  return file.folder ? `${name}/${file.folder}/${fileName}` : `${name}/${fileName}`;
}

export default function AgentPanel({ mode, path: navPath, onNavigate }: {
  mode: PanelMode;
  path?: string;
  onNavigate?: (path: string) => void;
}) {
  const [agents, setAgents] = useState<AgentData[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [selectedAgentId, setSelectedAgentId] = useState<string | null>(null);
  const [selectedFile, setSelectedFile] = useState<FileEntry | null>(null);
  const [contentLoading, setContentLoading] = useState(false);
  const [initialPathApplied, setInitialPathApplied] = useState(false);

  // Cache for loaded file content: path → content string
  const contentCache = useMemo(() => new Map<string, string>(), []);

  function loadFileContent(file: FileEntry) {
    const cached = contentCache.get(file.path);
    if (cached !== undefined) {
      setSelectedFile({ ...file, content: cached });
      return;
    }
    setSelectedFile({ ...file, content: '' });
    setContentLoading(true);
    fetch(`/api/agent-docs/content?path=${encodeURIComponent(file.path)}`)
      .then(r => r.json())
      .then(data => {
        if (data.ok) {
          contentCache.set(file.path, data.content);
          setSelectedFile(prev => prev?.path === file.path ? { ...prev, content: data.content } : prev);
        }
      })
      .catch(() => {})
      .finally(() => setContentLoading(false));
  }

  useEffect(() => {
    fetch('/api/agent-docs?content=false')
      .then((r) => r.json())
      .then((data: AgentData[] | Record<string, unknown>) => {
        if (!Array.isArray(data)) { setError("Unexpected API response"); setLoading(false); return; }
        setAgents(data);
        if (navPath && data.length > 0) {
          applyNavPath(navPath, data, mode);
        } else if (data.length > 0) {
          setSelectedAgentId(data[0].agentId);
        }
        setInitialPathApplied(true);
        setLoading(false);
      })
      .catch((e) => { setError(e instanceof Error ? e.message : String(e)); setLoading(false); });
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  function applyNavPath(np: string, agentList: AgentData[], m: PanelMode) {
    const parts = np.split('/');
    const agentName = parts[0]?.toLowerCase();
    if (!agentName) return;
    const agent = agentList.find(a => a.agentName.toLowerCase() === agentName);
    if (!agent) return;
    setSelectedAgentId(agent.agentId);
    if (parts.length > 1) {
      const files = m === 'memory' ? agent.memory : agent.docs;
      const filePart = parts.slice(1).join('/').toLowerCase();
      const match = files.find(f => {
        const fName = f.name.replace(/\.md$/i, '').toLowerCase();
        const fPath = f.folder ? `${f.folder.toLowerCase()}/${fName}` : fName;
        return fPath === filePart;
      });
      if (match) loadFileContent(match);
    }
  }

  const selectedAgent = agents.find((a) => a.agentId === selectedAgentId) ?? null;

  const pinnedNames = mode === 'memory' ? ['WORKING.md', 'MEMORY.md'] : ['AGENT.md', 'SOUL.md'];

  function handleSelectAgent(agentId: string) {
    setSelectedAgentId(agentId);
    setSelectedFile(null);
    const agent = agents.find(a => a.agentId === agentId);
    if (onNavigate && agent) onNavigate(agent.agentName.toLowerCase());
  }

  function handleSelectFile(file: FileEntry) {
    if (onNavigate && selectedAgent) onNavigate(buildNavPath(selectedAgent, file));
    loadFileContent(file);
  }

  const selectedFilePath = selectedFile?.path ?? null;
  useEffect(() => {
    if (!selectedAgent || selectedFilePath) return;
    if (!initialPathApplied) return;
    const files = mode === 'memory' ? selectedAgent.memory : selectedAgent.docs;
    if (files.length > 0) {
      const pinned = files.find(f => pinnedNames.includes(f.name));
      const file = pinned ?? files[0];
      handleSelectFile(file);
    }
  }, [selectedAgent, selectedFilePath, mode, pinnedNames, initialPathApplied]); // eslint-disable-line react-hooks/exhaustive-deps

  const modeLabel = mode.charAt(0).toUpperCase() + mode.slice(1);

  return (
    <div className="agents-page">
      <div className="agents-sidebar">
        <div className="agents-sidebar-header">{modeLabel}</div>
        {loading && <div className="agents-sidebar-msg">Loading...</div>}
        {error && <div className="agents-sidebar-error">{error}</div>}
        {!loading && agents.map((agent) => {
          const isSelected = agent.agentId === selectedAgentId;
          const files = mode === 'memory' ? agent.memory : agent.docs;
          return (
            <div key={agent.agentId}>
              <button
                onClick={() => handleSelectAgent(agent.agentId)}
                className={`agents-sidebar-btn${isSelected ? ' agents-sidebar-btn--active' : ''}`}
              >
                <span className="agents-sidebar-emoji">{agent.emoji}</span>
                <span className="agents-sidebar-name">{agent.agentName}</span>
                {files.length > 0 && (
                  <span className="agents-sidebar-count">{files.length}</span>
                )}
              </button>
              {isSelected && files.length > 0 && (
                <InlineFileTree
                  files={files}
                  pinnedNames={pinnedNames}
                  selectedPath={selectedFilePath}
                  onSelect={handleSelectFile}
                />
              )}
            </div>
          );
        })}
      </div>

      <div className="agents-content">
        <div className="agents-breadcrumb">
          <span>{modeLabel}</span>
          {selectedAgent && (
            <>
              <span className="agents-breadcrumb-sep">&rsaquo;</span>
              <span className="agents-breadcrumb-agent">{selectedAgent.emoji} {selectedAgent.agentName}</span>
            </>
          )}
          {selectedFile && (
            <>
              <span className="agents-breadcrumb-sep">&rsaquo;</span>
              <span className="agents-breadcrumb-file">{selectedFile.name.replace(/\.md$/i, '')}</span>
            </>
          )}
        </div>

        <div className="agents-file-content">
          {loading && <div className="loading">Loading...</div>}

          {!loading && !selectedAgent && !error && (
            <div className="agents-placeholder">Select an agent to browse their memory files and documentation. Each agent&apos;s knowledge base includes CLAUDE.md instructions, learned memories, and reference docs.</div>
          )}

          {!loading && selectedAgent && (
            <FileViewer key={selectedFile?.path ?? ''} file={selectedFile} contentLoading={contentLoading} />
          )}
        </div>
      </div>
    </div>
  );
}
