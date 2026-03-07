"""
sentinel_loop.py — Self-Healing Sentinel main loop.

Python 3.10+ stdlib only.  No pip installs required.

Usage:
    python3 sentinel_loop.py --config deck-sentinel.json [--once] [--dry-run]

Checks performed (in order):
    1. Cron health         — consecutive_errors > threshold in cron_status_file JSON
    2. WORKING.md freshness — file mtime older than working_md_max_age_hours
    3. Security audit stub — placeholder for future security checks
    5. Ghost crons         — cron sessions persisting after job deletion from gateway
    6. Gateway health      — HTTP ping to gateway; checks config validity on failure

Each incident is:
    • Assigned a unique ID:  INC-YYYYMMDD-HHMMSS-<4HEX>
    • Appended to sentinel_runs.jsonl (one JSON object per line)
    • Dispatched through notifier.notify()

⚠️  DO NOT enable cron for this script without the operator's explicit approval.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import secrets
import shutil
import subprocess
import sys
import time
import urllib.error
import urllib.request
from datetime import datetime, timezone
from pathlib import Path

# Local import — must live in the same directory
sys.path.insert(0, str(Path(__file__).parent))
from notifier import notify


# ── Helpers ───────────────────────────────────────────────────────────────────

def _expand(p: str) -> str:
    """Expand ~ and environment variables in a path string."""
    return os.path.expandvars(os.path.expanduser(p))


def _now() -> datetime:
    return datetime.now(timezone.utc)


def _make_incident_id() -> str:
    """Generate INC-YYYYMMDD-HHMMSS-XXXX (4 random hex chars)."""
    ts = _now().strftime("%Y%m%d-%H%M%S")
    rand = secrets.token_hex(2).upper()          # 4 hex chars
    return f"INC-{ts}-{rand}"


def _format_duration(seconds: float) -> str:
    """Format seconds into a human-readable string like '20h 41m' or '3m'."""
    total_min = int(seconds / 60)
    if total_min < 60:
        return f"{total_min}m"
    hours = total_min // 60
    mins = total_min % 60
    if hours < 24:
        return f"{hours}h {mins}m" if mins else f"{hours}h"
    days = hours // 24
    rem_hours = hours % 24
    return f"{days}d {rem_hours}h" if rem_hours else f"{days}d"


def _append_run(run_file: Path, record: dict) -> None:
    """Append a JSONL record to sentinel_runs.jsonl."""
    run_file.parent.mkdir(parents=True, exist_ok=True)
    with open(run_file, "a", encoding="utf-8") as fh:
        fh.write(json.dumps(record) + "\n")


def _load_config(path: str) -> dict:
    with open(path, encoding="utf-8") as fh:
        return json.load(fh)


# ── Check 1: Cron health ──────────────────────────────────────────────────────

def check_cron_health(cfg: dict, dry_run: bool) -> list[dict]:
    """
    Read the cron status JSON file and flag any job with
    consecutive_errors > cfg["cron_consecutive_error_threshold"].

    Expected JSON format (cron_status_file):
        {
          "jobs": [
            {"name": "forge-cron", "consecutive_errors": 0, "last_run": "2026-02-18T10:00:00Z"},
            ...
          ]
        }
    Returns a list of incident dicts.
    """
    incidents = []
    status_file = _expand(cfg.get("cron_status_file", "")) if cfg.get("cron_status_file") else None
    threshold   = int(cfg.get("cron_consecutive_error_threshold", 3))

    if not status_file:
        return incidents

    status_path = Path(status_file)
    if not status_path.exists():
        return incidents

    try:
        data = json.loads(status_path.read_text(encoding="utf-8"))
    except (json.JSONDecodeError, OSError) as exc:
        incidents.append({
            "check": "cron_health",
            "severity": "medium",
            "message": f"Could not parse cron status file {status_file!r}: {exc}",
        })
        return incidents

    for job in data.get("jobs", []):
        errors = int(job.get("consecutive_errors", 0))
        name   = job.get("name", "unknown")
        if errors > threshold:
            incidents.append({
                "check": "cron_health",
                "severity": "high",
                "message": (
                    f"Cron job '{name}' has {errors} consecutive errors "
                    f"(threshold: {threshold})."
                ),
                "details": {
                    "job": name,
                    "consecutive_errors": errors,
                    "last_run": job.get("last_run", "unknown"),
                },
            })

    return incidents


# ── Check 2: Agent memory freshness ───────────────────────────────────────────

def _load_agents_config(cfg: dict) -> list[dict]:
    """
    Load agent definitions from deck-agents.json.  Returns list of agent dicts.
    Path resolution order:
      1. cfg["agents_config_path"] (absolute or ~ expanded)
      2. config/deck-agents.json relative to sentinel directory
    """
    explicit = cfg.get("agents_config_path", "")
    if explicit:
        p = Path(_expand(explicit))
    else:
        p = Path(__file__).parent.parent / "config" / "deck-agents.json"

    if not p.exists():
        return []

    try:
        data = json.loads(p.read_text(encoding="utf-8"))
        return data.get("agents", [])
    except (json.JSONDecodeError, OSError):
        return []


def _get_active_agents_from_db(cfg: dict, hours: float) -> set[str] | None:
    """
    Query the events DB for agents with recent activity.
    Returns a set of agent keys, or None if the DB is unavailable.
    """
    import sqlite3

    db_path = cfg.get("usage_db_path", "")
    if not db_path:
        # Try standard location
        db_path = os.path.expanduser("~/.openclaw-deck/data/usage.db")

    if not os.path.exists(db_path):
        return None

    try:
        cutoff_ms = int((_now().timestamp() - hours * 3600) * 1000)
        conn = sqlite3.connect(db_path)
        rows = conn.execute(
            "SELECT DISTINCT agent FROM events WHERE ts >= ? AND type = 'llm_output'",
            (cutoff_ms,),
        ).fetchall()
        conn.close()
        return {r[0] for r in rows}
    except Exception:
        return None


def _derive_memory_dirs(agents: list[dict], workspace: str) -> list[tuple[str, str, Path]]:
    """
    Build a list of (agent_name, agent_key, memory_dir) from agents.json.
    Agents with empty agentDir use the workspace root memory dir.
    """
    ws = Path(_expand(workspace))
    result: list[tuple[str, str, Path]] = []
    for agent in agents:
        name = agent.get("name", agent.get("key", agent.get("id", "unknown")))
        key = agent.get("key", agent.get("id", name))
        agent_dir = agent.get("agentDir", "")
        mem_dir = ws / agent_dir / "memory" if agent_dir else ws / "memory"
        result.append((name, key, mem_dir))
    return result


def check_working_md(cfg: dict, dry_run: bool) -> list[dict]:
    """
    Check that agent memory files are fresh.

    Derives memory directories from config/deck-agents.json agent definitions.
    Falls back to a single configured path if deck-agents.json is unavailable.

    Config options:
      - workspace_path:         base workspace dir (default: ~/.openclaw/workspace)
      - agents_config_path:     path to deck-agents.json (default: ../config/deck-agents.json)
      - working_md_max_age_hours: staleness threshold in hours (default: 5)
      - memory_files:           list of filenames to check (default: ["WORKING.md"])
      - active_agents:          list of agent names to check (default: all agents)
      - working_md_path:        legacy single-path fallback
    """
    incidents = []
    max_age_hours = float(cfg.get("working_md_max_age_hours", 5.0))
    memory_files = cfg.get("memory_files", ["WORKING.md"])
    workspace = cfg.get("workspace_path", "~/.openclaw/workspace")
    active_agents_cfg = cfg.get("active_agents", None)  # None = auto-detect
    activity_window_hours = float(cfg.get("activity_window_hours", 48))
    config_path = str(Path(__file__).parent / "deck-sentinel.json")

    # Try to derive paths from agents.json
    agents = _load_agents_config(cfg)

    # Determine which agents are active
    if active_agents_cfg is not None:
        # Explicit list in config
        active_set: set[str] | None = {a.lower() for a in active_agents_cfg}
    else:
        # Auto-detect from recent DB activity
        db_active = _get_active_agents_from_db(cfg, activity_window_hours)
        active_set = {a.lower() for a in db_active} if db_active is not None else None

    if agents:
        # Derived mode: check memory dirs for each agent
        memory_entries = _derive_memory_dirs(agents, workspace)
        for agent_name, agent_key, mem_dir in memory_entries:
            # Skip inactive agents (auto-detected from DB or explicit config list)
            if active_set is not None and agent_name.lower() not in active_set and agent_key.lower() not in active_set:
                continue

            if not mem_dir.exists():
                # Skip agents whose memory dir doesn't exist yet — not an error
                continue

            for filename in memory_files:
                fpath = mem_dir / filename
                if not fpath.exists():
                    continue

                mtime_ts = fpath.stat().st_mtime
                mtime_dt = datetime.fromtimestamp(mtime_ts, tz=timezone.utc)
                age_hours = (_now() - mtime_dt).total_seconds() / 3600

                if age_hours > max_age_hours:
                    incidents.append({
                        "check": "working_md_freshness",
                        "severity": "medium",
                        "message": (
                            f"{agent_name}'s {filename} is stale: "
                            f"last modified {age_hours:.1f}h ago "
                            f"(threshold: {max_age_hours}h)."
                        ),
                        "details": {
                            "agent": agent_name,
                            "file": filename,
                            "age": f"{age_hours:.1f}h (threshold: {max_age_hours}h)",
                            "last_modified": mtime_dt.isoformat(timespec="seconds"),
                            "path": str(fpath),
                            "settings": "/deck-config#edit.sentinel.working_md_max_age_hours",
                        },
                    })
    else:
        # Fallback: single hardcoded path (legacy / no agents.json)
        working_md_path = Path(_expand(cfg.get("working_md_path", "memory/WORKING.md")))
        if not working_md_path.exists():
            # No agents.json and no fallback file — skip silently
            return incidents

        mtime_ts = working_md_path.stat().st_mtime
        mtime_dt = datetime.fromtimestamp(mtime_ts, tz=timezone.utc)
        age_hours = (_now() - mtime_dt).total_seconds() / 3600

        if age_hours > max_age_hours:
            incidents.append({
                "check": "working_md_freshness",
                "severity": "medium",
                "message": (
                    f"WORKING.md is stale: last modified {age_hours:.1f}h ago "
                    f"(threshold: {max_age_hours}h)."
                ),
                "details": {
                    "path": str(working_md_path),
                    "last_modified": mtime_dt.isoformat(timespec="seconds"),
                    "age_hours": round(age_hours, 2),
                },
            })

    return incidents




# ── Check 4: Security audit stub ──────────────────────────────────────────────

def check_security_audit(cfg: dict, dry_run: bool) -> list[dict]:
    """
    Security audit stub — placeholder for future checks.

    Planned checks (not yet implemented):
        • Scan for credentials committed to git (gitleaks / trufflehog)
        • Verify file permissions on sensitive paths
        • Check for world-writable files in workspace
        • Validate no .env files outside approved locations

    Returns empty list until checks are implemented.
    """
    incidents = []

    # World-writable files check (basic stub)
    scan_paths = [_expand(p) for p in cfg.get("security_scan_paths", [])]
    for scan_path in scan_paths:
        p = Path(scan_path)
        if not p.exists():
            continue
        for f in p.rglob("*"):
            if not f.is_file():
                continue
            try:
                mode = f.stat().st_mode
                if mode & 0o002:          # world-writable bit
                    incidents.append({
                        "check": "security_audit",
                        "severity": "medium",
                        "message": f"World-writable file detected: {f}",
                        "details": {"path": str(f), "mode": oct(mode)},
                    })
            except OSError:
                pass

    # TODO: integrate gitleaks / trufflehog when approved
    return incidents


# ── Check 6: Ghost cron sessions ──────────────────────────────────────────

def _load_openclaw_env() -> dict:
    """Load key-value pairs from ~/.openclaw/.env."""
    env_path = Path(os.environ.get("HOME", os.path.expanduser("~"))) / ".openclaw" / ".env"
    env: dict[str, str] = {}
    try:
        for line in env_path.read_text("utf-8").splitlines():
            line = line.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            k, _, v = line.partition("=")
            env[k.strip()] = v.strip()
    except OSError:
        pass
    return env


def _get_registered_cron_ids(gateway_url: str, token: str) -> set[str] | None:
    """Fetch registered cron job IDs from the gateway. Returns None on error."""
    url = f"{gateway_url}/tools/invoke"
    payload = json.dumps({
        "tool": "cron",
        "args": {"action": "list", "includeDisabled": True},
        "sessionKey": "main",
    }).encode("utf-8")
    req = urllib.request.Request(
        url, data=payload, method="POST",
        headers={
            "Content-Type": "application/json",
            "Authorization": f"Bearer {token}",
        },
    )
    try:
        with urllib.request.urlopen(req, timeout=10) as resp:
            data = json.loads(resp.read().decode("utf-8"))
        text = data.get("result", {}).get("content", [{}])[0].get("text", "")
        parsed = json.loads(text)
        jobs = parsed.get("jobs", []) if isinstance(parsed, dict) else parsed
        return {j["id"] for j in jobs if isinstance(j, dict) and "id" in j}
    except (urllib.error.URLError, OSError, json.JSONDecodeError, KeyError):
        return None


def _find_cron_sessions() -> list[dict]:
    """Scan agent session files for cron session keys."""
    agents_dir = Path(os.environ.get("HOME", os.path.expanduser("~"))) / ".openclaw" / "agents"
    results = []
    if not agents_dir.exists():
        return results
    for sessions_file in agents_dir.glob("*/sessions/sessions.json"):
        agent_id = sessions_file.parent.parent.name
        try:
            data = json.loads(sessions_file.read_text("utf-8"))
            for key in data:
                if ":cron:" not in key:
                    continue
                # Extract cron job ID from session key like agent:main:cron:<jobId>
                cron_part = key.split(":cron:")[-1]
                # Skip sub-keys like :run:xxx
                if ":run:" in cron_part:
                    continue
                job_id = cron_part
                if not job_id:
                    continue
                session_data = data[key]
                updated_ms = session_data.get("updatedAt", session_data.get("createdAt", 0))
                results.append({
                    "session_key": key,
                    "agent": agent_id,
                    "job_id": job_id,
                    "updated_ms": updated_ms if isinstance(updated_ms, int) else 0,
                })
        except (json.JSONDecodeError, OSError):
            continue
    return results


def check_ghost_crons(cfg: dict, dry_run: bool) -> list[dict]:
    """
    Detect cron sessions whose parent cron job no longer exists in the gateway.
    These are 'ghost' sessions that persist after a job is deleted.
    """
    incidents = []
    gateway_url = cfg.get("gateway_url", "http://localhost:18789")

    env = _load_openclaw_env()
    token_key = cfg.get("gateway_token_env", "OPENCLAW_GATEWAY_TOKEN")
    token = env.get(token_key, "")
    if not token:
        return incidents

    if dry_run:
        print(f"[dry-run] Would check gateway at {gateway_url} for ghost crons")
        return incidents

    registered = _get_registered_cron_ids(gateway_url, token)
    if registered is None:
        return incidents

    cron_sessions = _find_cron_sessions()

    # Only flag sessions updated recently — old session files are just
    # stale history, not evidence of an actively running ghost process.
    max_age_ms = cfg.get("ghost_cron_max_age_hours", 24) * 3600 * 1000
    now_ms = int(time.time() * 1000)

    # Group ghosts by agent for a consolidated report
    ghosts_by_agent: dict[str, list[dict]] = {}
    seen_ghosts: set[str] = set()
    for sess in cron_sessions:
        job_id = sess["job_id"]
        if job_id in registered or job_id in seen_ghosts:
            continue
        # Skip stale session files — only recent activity counts
        updated_ms = sess.get("updated_ms", 0)
        if now_ms - updated_ms > max_age_ms:
            continue
        seen_ghosts.add(job_id)
        agent = sess["agent"]
        ghosts_by_agent.setdefault(agent, []).append(sess)

    if not ghosts_by_agent:
        return incidents

    # One incident per agent (not per ghost session) to avoid alert flooding
    for agent, sessions in ghosts_by_agent.items():
        job_ids = [s["job_id"][:12] for s in sessions]
        incidents.append({
            "check": "ghost_crons",
            "severity": "high",
            "message": (
                f"{len(sessions)} ghost cron session(s) for agent '{agent}': "
                f"jobs {', '.join(job_ids[:5])}"
                f"{f' (+{len(job_ids)-5} more)' if len(job_ids) > 5 else ''}"
            ),
            "details": {
                "agent": agent,
                "count": len(sessions),
                "job_ids": [s["job_id"] for s in sessions],
                "session_keys": [s["session_key"] for s in sessions[:3]],
            },
        })

    return incidents


# ── Check 7: LaunchAgent services ────────────────────────────────────────────

def _kickstart_launchd(label: str) -> tuple[bool, str]:
    """Attempt to restart a LaunchAgent via kickstart. Returns (success, detail)."""
    uid = os.getuid()
    try:
        result = subprocess.run(
            ["launchctl", "kickstart", "-k", f"gui/{uid}/{label}"],
            capture_output=True, text=True, timeout=15,
        )
        if result.returncode == 0:
            return True, f"kickstart succeeded for {label}"
        return False, f"kickstart failed (rc={result.returncode}): {result.stderr.strip()}"
    except (FileNotFoundError, subprocess.TimeoutExpired) as exc:
        return False, f"kickstart error: {exc}"


# ── Check 7: Duplicate port listeners ─────────────────────────────────────────

# Map ports to their managing LaunchAgent labels
_PORT_LAUNCHD_LABELS: dict[int, str] = {
    3000:  "ai.openclaw.deck",
    18789: "ai.openclaw.gateway",
}


def _get_launchd_pid(label: str) -> str | None:
    """Get the PID of a LaunchAgent by label. Returns None if not running."""
    try:
        result = subprocess.run(
            ["launchctl", "list", label],
            capture_output=True, text=True, timeout=5,
        )
    except (FileNotFoundError, subprocess.TimeoutExpired):
        return None
    if result.returncode != 0:
        return None
    # Tabular format: PID\tStatus\tLabel
    parts = result.stdout.strip().split("\t")
    if len(parts) >= 1:
        pid_val = parts[0].strip()
        if pid_val and pid_val != "-":
            return pid_val
    return None


def check_port_conflicts(cfg: dict, dry_run: bool) -> list[dict]:
    """
    Detect multiple processes listening on the same port.
    Auto-kills stale processes, keeping the one managed by launchd.
    """
    incidents: list[dict] = []
    check_cfg = cfg.get("checks", {}).get("port_conflicts", {})
    ports = check_cfg.get("ports", [3000, 18789])
    auto_kill = check_cfg.get("auto_kill", True)

    if dry_run:
        print(f"[dry-run] Would check for duplicate listeners on ports {ports}")
        return incidents

    for port in ports:
        try:
            result = subprocess.run(
                ["lsof", "-i", f":{port}", "-sTCP:LISTEN", "-t"],
                capture_output=True, text=True, timeout=5,
            )
        except (FileNotFoundError, subprocess.TimeoutExpired):
            continue

        pids = [p.strip() for p in result.stdout.strip().splitlines() if p.strip()]
        if len(pids) <= 1:
            continue

        # Get process details for the report
        details = []
        for pid in pids:
            try:
                ps = subprocess.run(
                    ["ps", "-p", pid, "-o", "pid=,ppid=,start=,command="],
                    capture_output=True, text=True, timeout=3,
                )
                details.append(ps.stdout.strip())
            except Exception:
                details.append(f"PID {pid} (details unavailable)")

        # Identify the correct PID via launchd
        label = _PORT_LAUNCHD_LABELS.get(port)
        launchd_pid = _get_launchd_pid(label) if label else None
        killed: list[str] = []

        if auto_kill and launchd_pid and launchd_pid in pids:
            stale_pids = [p for p in pids if p != launchd_pid]
            for stale in stale_pids:
                try:
                    os.kill(int(stale), 15)  # SIGTERM
                    killed.append(stale)
                except (OSError, ValueError):
                    pass

        if killed:
            incidents.append({
                "check": "port_conflicts",
                "severity": "high",
                "message": (
                    f"Port {port}: killed {len(killed)} stale process(es) "
                    f"(PIDs: {', '.join(killed)}), kept launchd PID {launchd_pid}."
                ),
                "details": {
                    "port": port, "killed": killed,
                    "kept": launchd_pid, "processes": details,
                },
            })
        else:
            incidents.append({
                "check": "port_conflicts",
                "severity": "high",
                "message": (
                    f"Port {port} has {len(pids)} listeners (PIDs: {', '.join(pids)}). "
                    + (f"Could not identify launchd owner — manual intervention needed."
                       if not launchd_pid
                       else f"Stale process may serve outdated responses.")
                ),
                "details": {"port": port, "pids": pids, "processes": details},
            })

    return incidents


# ── Check 9: Dashboard health ────────────────────────────────────────────────

def _probe_dashboard(url: str, timeout_s: float) -> tuple[bool, str | None, dict]:
    """
    Deep-probe the dashboard: check HTML page loads AND an API route responds.
    Returns (ok, error_msg, details).
    """
    details: dict = {"url": url}

    # 1. Check HTML page returns 200
    try:
        req = urllib.request.Request(url, method="GET")
        with urllib.request.urlopen(req, timeout=timeout_s) as resp:
            if resp.status >= 400:
                return False, f"Dashboard returned HTTP {resp.status} at {url}.", details
    except urllib.error.HTTPError as exc:
        details["http_status"] = exc.code
        return False, f"Dashboard returned HTTP {exc.code} at {url}.", details
    except (urllib.error.URLError, OSError) as exc:
        details["error"] = str(exc)
        return False, f"Dashboard unreachable at {url}: {exc}", details

    # 2. Check an API route to verify JS compilation is healthy
    # If the Next.js dev server has stale chunks, the page returns 200 (HTML shell)
    # but JS bundles 404 — the app is completely broken client-side.
    api_url = url.rstrip("/") + "/api/agents"
    try:
        api_req = urllib.request.Request(api_url, method="GET")
        with urllib.request.urlopen(api_req, timeout=timeout_s) as api_resp:
            if api_resp.status >= 400:
                details["api_status"] = api_resp.status
                details["api_url"] = api_url
                return False, f"Dashboard HTML loads but API broken (HTTP {api_resp.status}). JS chunks likely stale.", details
    except urllib.error.HTTPError as exc:
        details["api_status"] = exc.code
        details["api_url"] = api_url
        return False, f"Dashboard HTML loads but API broken (HTTP {exc.code}). JS chunks likely stale.", details
    except (urllib.error.URLError, OSError) as exc:
        details["api_error"] = str(exc)
        details["api_url"] = api_url
        return False, f"Dashboard HTML loads but API unreachable: {exc}", details

    return True, None, details


def check_dashboard_health(cfg: dict, dry_run: bool) -> list[dict]:
    """
    Deep health check for the Deck dashboard.
    Probes both the HTML page AND an API route to catch stale JS chunks.
    If auto_restart is enabled and probe fails, clears .next cache and restarts.
    """
    incidents: list[dict] = []
    check_cfg = cfg.get("checks", {}).get("dashboard_health", {})
    url = check_cfg.get("url", "http://localhost:3000")
    timeout_s = float(check_cfg.get("timeout_seconds", 5.0))
    auto_restart = check_cfg.get("auto_restart", True)

    if dry_run:
        print(f"[dry-run] Would GET {url} + {url}/api/agents")
        return incidents

    ok, error_msg, error_details = _probe_dashboard(url, timeout_s)
    if ok:
        return incidents

    # Auto-restart: clear stale .next cache (top cause of 500s) and restart
    if auto_restart:
        mc_dir = Path(os.environ.get("DECK_ROOT") or _expand(cfg.get("deck_root", str(Path(__file__).resolve().parent.parent))))
        next_dir = mc_dir / ".next"
        if next_dir.is_dir():
            import shutil
            try:
                shutil.rmtree(next_dir)
                error_details["cleared_next_cache"] = True
            except Exception:
                error_details["cleared_next_cache"] = False

        restart_ok, restart_detail = _kickstart_launchd("ai.openclaw.deck")
        error_details["auto_restart"] = restart_ok
        error_details["restart_detail"] = restart_detail

        if restart_ok:
            # Give it time to rebuild, then re-check
            import time
            time.sleep(8)
            ok2, _, _ = _probe_dashboard(url, timeout_s)
            if ok2:
                incidents.append({
                    "check": "dashboard_health",
                    "severity": "info",
                    "message": "Dashboard was down, auto-restarted successfully.",
                    "details": error_details,
                })
                return incidents

    incidents.append({
        "check": "dashboard_health",
        "severity": "high",
        "message": error_msg,
        "details": error_details,
    })

    return incidents


# ── Check 10: Gateway health ─────────────────────────────────────────────────

def check_gateway_health(cfg: dict, dry_run: bool) -> list[dict]:
    """
    Ping the gateway HTTP endpoint.  If unreachable, check whether
    openclaw.json is valid JSON — config corruption is the #1 cause of
    gateway restart failures.
    """
    incidents: list[dict] = []
    gateway_url = cfg.get("gateway_url", "http://localhost:18789")
    timeout_s = float(cfg.get("gateway_health_timeout_seconds", 5.0))
    config_path = Path(_expand(cfg.get(
        "openclaw_config_path",
        "~/.openclaw/workspace/openclaw.json",
    )))

    if dry_run:
        print(f"[dry-run] Would GET {gateway_url}/health")
        return incidents

    # Step 1: Ping gateway
    gateway_up = False
    http_error = None
    try:
        req = urllib.request.Request(f"{gateway_url}/health", method="GET")
        with urllib.request.urlopen(req, timeout=timeout_s) as resp:
            if resp.status < 400:
                gateway_up = True
    except urllib.error.HTTPError as exc:
        # Any HTTP response means process is alive — 4xx/5xx still counts
        gateway_up = True
        http_error = f"HTTP {exc.code}"
    except (urllib.error.URLError, OSError) as exc:
        http_error = str(exc)

    if gateway_up:
        return incidents

    # Step 2: Gateway is down — check config validity
    config_valid = True
    config_error = None
    try:
        text = config_path.read_text(encoding="utf-8")
        json.loads(text)
    except json.JSONDecodeError as exc:
        config_valid = False
        config_error = f"Invalid JSON at line {exc.lineno}, col {exc.colno}: {exc.msg}"
    except OSError as exc:
        config_valid = False
        config_error = f"Cannot read config: {exc}"

    if not config_valid:
        incidents.append({
            "check": "gateway_health",
            "severity": "critical",
            "message": (
                f"Gateway unreachable at {gateway_url} AND config is corrupt: {config_error}. "
                f"Run `!revert-config` in Discord or `openclaw doctor` to fix."
            ),
            "details": {
                "gateway_url": gateway_url,
                "connection_error": http_error,
                "config_path": str(config_path),
                "config_error": config_error,
            },
        })
    else:
        incidents.append({
            "check": "gateway_health",
            "severity": "high",
            "message": (
                f"Gateway unreachable at {gateway_url} ({http_error}). "
                f"Config appears valid — may need `!gateway restart` or `openclaw doctor`."
            ),
            "details": {
                "gateway_url": gateway_url,
                "connection_error": http_error,
                "config_path": str(config_path),
                "config_valid": True,
            },
        })

    return incidents


# ── Main orchestrator ─────────────────────────────────────────────────────────

# ── System Resources Check ────────────────────────────────────────────────────

# Cooldown: only alert once per resource per this many seconds
_RESOURCE_ALERT_COOLDOWNS: dict[str, float] = {}
_RESOURCE_COOLDOWN_SECONDS = 1800  # 30 min


def _get_memory_percent() -> float | None:
    """Return system memory usage % on macOS via vm_stat + sysctl."""
    try:
        total_bytes = int(subprocess.check_output(
            ["sysctl", "-n", "hw.memsize"], text=True).strip())
        vm_out = subprocess.check_output(["vm_stat"], text=True)
        page_size = 16384  # default on Apple Silicon
        for line in vm_out.splitlines():
            if "page size of" in line:
                page_size = int(line.split()[-2])
                break
        pages: dict[str, int] = {}
        for line in vm_out.splitlines():
            parts = line.split(":")
            if len(parts) != 2:
                continue
            key = parts[0].strip().lower().strip('"')
            val_str = parts[1].strip().rstrip(".")
            if not val_str.isdigit():
                continue
            pages[key] = int(val_str)
        active = pages.get("pages active", 0)
        wired = pages.get("pages wired down", 0)
        compressed = pages.get("pages occupied by compressor", 0)
        used_pages = active + wired + compressed
        total_pages = total_bytes // page_size
        if total_pages == 0:
            return None
        return round((used_pages / total_pages) * 100, 1)
    except (subprocess.SubprocessError, ValueError, OSError):
        return None


def _get_cpu_load() -> tuple[float, int] | None:
    """Return (1-min load avg, core count) on macOS."""
    try:
        load_str = subprocess.check_output(
            ["sysctl", "-n", "vm.loadavg"], text=True).strip()
        # Format: "{ 2.34 1.56 1.12 }"
        parts = load_str.strip("{ }").split()
        load_1m = float(parts[0])
        cores = int(subprocess.check_output(
            ["sysctl", "-n", "hw.ncpu"], text=True).strip())
        return (load_1m, cores)
    except (subprocess.SubprocessError, ValueError, OSError, IndexError):
        return None


def _get_disk_percent(path: str = "/") -> float | None:
    """Return disk usage % for the given mount point."""
    try:
        usage = shutil.disk_usage(path)
        return round((usage.used / usage.total) * 100, 1)
    except OSError:
        return None


def check_system_resources(cfg: dict, dry_run: bool) -> list[dict]:
    """Check CPU load, memory, and disk usage against configurable thresholds."""
    incidents: list[dict] = []
    res_cfg = cfg.get("checks", {}).get("system_resources", {})
    mem_threshold = res_cfg.get("memory_percent", 80)
    disk_threshold = res_cfg.get("disk_percent", 85)
    cpu_multiplier = res_cfg.get("cpu_load_multiplier", 2.0)
    disk_path = res_cfg.get("disk_path", "/")
    now = time.time()

    # ── Memory ──
    mem_pct = _get_memory_percent()
    if mem_pct is not None and mem_pct > mem_threshold:
        cooldown_key = "memory"
        last_alert = _RESOURCE_ALERT_COOLDOWNS.get(cooldown_key, 0)
        if now - last_alert > _RESOURCE_COOLDOWN_SECONDS:
            _RESOURCE_ALERT_COOLDOWNS[cooldown_key] = now
            incidents.append({
                "check": "system_resources",
                "severity": "critical" if mem_pct > 95 else "high",
                "message": f"Memory usage at {mem_pct}% (threshold: {mem_threshold}%)",
                "details": {
                    "resource": "memory",
                    "usage": f"{mem_pct}%",
                    "threshold": f"{mem_threshold}%",
                    "settings": "/deck-config#edit.sentinel.system_resources",
                },
            })

    # ── CPU load ──
    cpu_info = _get_cpu_load()
    if cpu_info is not None:
        load_1m, cores = cpu_info
        cpu_threshold = cores * cpu_multiplier
        if load_1m > cpu_threshold:
            cooldown_key = "cpu"
            last_alert = _RESOURCE_ALERT_COOLDOWNS.get(cooldown_key, 0)
            if now - last_alert > _RESOURCE_COOLDOWN_SECONDS:
                _RESOURCE_ALERT_COOLDOWNS[cooldown_key] = now
                incidents.append({
                    "check": "system_resources",
                    "severity": "critical" if load_1m > cores * 3 else "high",
                    "message": f"CPU load average {load_1m:.1f} ({cores} cores, threshold: {cpu_threshold:.0f})",
                    "details": {
                        "resource": "cpu",
                        "load_1m": f"{load_1m:.1f}",
                        "cores": str(cores),
                        "threshold": f"{cpu_threshold:.0f} ({cpu_multiplier}x cores)",
                        "settings": "/deck-config#edit.sentinel.system_resources",
                    },
                })

    # ── Disk ──
    disk_pct = _get_disk_percent(disk_path)
    if disk_pct is not None and disk_pct > disk_threshold:
        cooldown_key = "disk"
        last_alert = _RESOURCE_ALERT_COOLDOWNS.get(cooldown_key, 0)
        if now - last_alert > _RESOURCE_COOLDOWN_SECONDS:
            _RESOURCE_ALERT_COOLDOWNS[cooldown_key] = now
            incidents.append({
                "check": "system_resources",
                "severity": "critical" if disk_pct > 95 else "high",
                "message": f"Disk usage at {disk_pct}% (threshold: {disk_threshold}%)",
                "details": {
                    "resource": "disk",
                    "usage": f"{disk_pct}%",
                    "path": disk_path,
                    "threshold": f"{disk_threshold}%",
                    "settings": "/deck-config#edit.sentinel.system_resources",
                },
            })

    return incidents


# ── Plugin Health Check ───────────────────────────────────────────────────────

def check_plugin_health(cfg: dict, dry_run: bool) -> list[dict]:
    """
    Check that the Deck plugin is alive:
      1. Gateway /health → poller.running must be true
      2. poller.lastPollMs must be recent (configurable stale_poll_minutes)
      3. Most recent event in usage.db must be recent (configurable stale_events_minutes)
    """
    incidents: list[dict] = []
    pcfg = cfg.get("checks", {}).get("plugin_health", {})
    stale_poll_min = pcfg.get("stale_poll_minutes", 10)
    stale_events_min = pcfg.get("stale_events_minutes", 60)
    usage_db_path = _expand(pcfg.get("usage_db", "~/.openclaw-deck/data/usage.db"))
    gateway_url = cfg.get("gateway_url", "http://localhost:18789")
    timeout_s = float(cfg.get("gateway_health_timeout_seconds", 5.0))

    if dry_run:
        print(f"[dry-run] Would check plugin health via {gateway_url}/health + {usage_db_path}")
        return incidents

    # Step 1: Check poller status via gateway /health
    poller_data = None
    try:
        req = urllib.request.Request(f"{gateway_url}/health", method="GET")
        with urllib.request.urlopen(req, timeout=timeout_s) as resp:
            data = json.loads(resp.read().decode("utf-8"))
            poller_data = data.get("poller")
    except (urllib.error.URLError, OSError, json.JSONDecodeError):
        # Gateway unreachable — gateway_health check handles this
        return incidents

    if poller_data is None:
        incidents.append({
            "check": "plugin_health",
            "severity": "high",
            "message": (
                "Deck plugin not detected — gateway /health has no poller data. "
                "The plugin may not be loaded."
            ),
            "details": {
                "gateway_url": gateway_url,
                "settings": "/deck-config#edit.sentinel.plugin_health",
            },
        })
        return incidents

    if not poller_data.get("running"):
        incidents.append({
            "check": "plugin_health",
            "severity": "critical",
            "message": "Deck plugin poller is NOT running — events are not being recorded.",
            "details": {
                "poller_running": False,
                "settings": "/deck-config#edit.sentinel.plugin_health",
            },
        })

    # Check poller freshness
    last_poll_ms = poller_data.get("lastPollMs", 0)
    if last_poll_ms > 0:
        age_min = (time.time() * 1000 - last_poll_ms) / 60000
        if age_min > stale_poll_min:
            incidents.append({
                "check": "plugin_health",
                "severity": "high",
                "message": (
                    f"Plugin poller stale — last poll was {age_min:.0f}m ago "
                    f"(threshold: {stale_poll_min}m)"
                ),
                "details": {
                    "last_poll_age_minutes": round(age_min, 1),
                    "threshold_minutes": stale_poll_min,
                    "settings": "/deck-config#edit.sentinel.plugin_health",
                },
            })

    # Step 2: Check event freshness in SQLite DB (skip outside active hours)
    active_start = pcfg.get("active_hours_start", 8)
    active_end = pcfg.get("active_hours_end", 23)
    current_hour = datetime.now().astimezone().hour
    in_active_hours = active_start <= current_hour < active_end

    if in_active_hours and os.path.isfile(usage_db_path):
        try:
            import sqlite3
            conn = sqlite3.connect(f"file:{usage_db_path}?mode=ro", uri=True)
            row = conn.execute("SELECT MAX(ts) FROM events").fetchone()
            conn.close()
            if row and row[0]:
                last_event_ts = row[0]
                # ts is milliseconds
                if last_event_ts > 1e12:
                    age_min = (time.time() * 1000 - last_event_ts) / 60000
                else:
                    age_min = (time.time() - last_event_ts) / 60
                if age_min > stale_events_min:
                    incidents.append({
                        "check": "plugin_health",
                        "severity": "high",
                        "message": (
                            f"No new events in {_format_duration(age_min * 60)} "
                            f"(threshold: {stale_events_min}m). Plugin may not be recording."
                        ),
                        "details": {
                            "last_event_age_minutes": round(age_min, 1),
                            "threshold_minutes": stale_events_min,
                            "db_path": usage_db_path,
                            "settings": "/deck-config#edit.sentinel.plugin_health",
                        },
                    })
        except Exception:
            pass  # DB read failures are not plugin health issues

    return incidents


_CONTEXT_ALERT_COOLDOWNS: dict[str, float] = {}
_CONTEXT_COOLDOWN_SECONDS = 1800  # 30 min per session key


def check_context_pressure(cfg: dict, dry_run: bool) -> list[dict]:
    """
    Hit /api/session-context and alert when any session exceeds the
    context threshold. Respects active_hours and per-session cooldown.
    """
    incidents: list[dict] = []
    pcfg = cfg.get("checks", {}).get("context_pressure", {})
    threshold = pcfg.get("context_threshold_percent", 80)
    active_start = pcfg.get("active_hours_start", 8)
    active_end = pcfg.get("active_hours_end", 23)

    dashboard_url = cfg.get("checks", {}).get("dashboard_health", {}).get("url", "http://localhost:3000")
    url = f"{dashboard_url}/api/session-context"

    if dry_run:
        print(f"[dry-run] Would check context pressure via {url} (threshold: {threshold}%)")
        return incidents

    current_hour = datetime.now().astimezone().hour
    if not (active_start <= current_hour < active_end):
        return incidents

    try:
        req = urllib.request.Request(url, method="GET")
        with urllib.request.urlopen(req, timeout=5) as resp:
            data = json.loads(resp.read().decode("utf-8"))
    except (urllib.error.URLError, OSError, json.JSONDecodeError):
        return incidents  # dashboard unreachable — dashboard_health handles this

    sessions = data.get("sessions", [])
    now = time.time()

    for s in sessions:
        pct = s.get("contextPercent", 0)
        if pct < threshold:
            break  # sorted desc, no more above threshold

        session_key = s.get("session", "")
        cooldown_key = f"ctx:{session_key}"
        last_alert = _CONTEXT_ALERT_COOLDOWNS.get(cooldown_key, 0)
        if now - last_alert < _CONTEXT_COOLDOWN_SECONDS:
            continue
        _CONTEXT_ALERT_COOLDOWNS[cooldown_key] = now

        agent = s.get("agent", "unknown")
        model = s.get("model", "unknown")
        prompt_tokens = s.get("promptTokens", 0)
        max_context = s.get("maxContext", 0)
        incidents.append({
            "check": "context_pressure",
            "severity": "high" if pct >= 90 else "medium",
            "message": (
                f"Session context pressure: {agent} / {session_key} at {pct:.1f}% "
                f"({prompt_tokens:,} / {max_context:,} tokens, model: {model}). "
                f"Consider compacting or resetting the session."
            ),
            "details": {
                "agent": agent,
                "session": session_key,
                "context_percent": pct,
                "prompt_tokens": prompt_tokens,
                "max_context": max_context,
                "model": model,
                "settings": "/deck-config#edit.sentinel.context_pressure",
            },
        })

    return incidents


CHECKS = [
    ("cron_health",        check_cron_health),
    ("working_md",         check_working_md),
    ("security_audit",     check_security_audit),
    ("ghost_crons",        check_ghost_crons),
    ("port_conflicts",     check_port_conflicts),
    ("dashboard_health",   check_dashboard_health),
    ("gateway_health",     check_gateway_health),
    ("system_resources",   check_system_resources),
    ("plugin_health",      check_plugin_health),
    ("context_pressure",   check_context_pressure),
]


_SENTINEL_HEARTBEAT_FILE = Path(os.environ.get("HOME", "~")) / ".openclaw" / "state" / "sentinel-heartbeat.json"
_SENTINEL_MAX_GAP_SECONDS = 900  # 15 minutes (3x the 5-min interval)


def _check_self_staleness() -> list[dict]:
    """Detect if sentinel itself was down (gap between runs > 15 min)."""
    incidents: list[dict] = []
    try:
        if _SENTINEL_HEARTBEAT_FILE.exists():
            data = json.loads(_SENTINEL_HEARTBEAT_FILE.read_text("utf-8"))
            last_ts = data.get("last_run_epoch", 0)
            gap = time.time() - last_ts
            if gap > _SENTINEL_MAX_GAP_SECONDS:
                gap_min = round(gap / 60, 1)
                gap_human = _format_duration(gap)
                last_dt = datetime.fromtimestamp(last_ts).astimezone()
                last_human = last_dt.strftime("%b %d %H:%M %Z")
                incidents.append({
                    "check": "sentinel_self",
                    "severity": "high",
                    "message": f"Sentinel was down for {gap_human}. Monitoring gap detected — alerts were not firing during this period.",
                    "details": {
                        "last_run": last_human,
                        "down_for": gap_human,
                        "threshold": _format_duration(_SENTINEL_MAX_GAP_SECONDS),
                    },
                })
    except (json.JSONDecodeError, OSError):
        pass
    return incidents


def _write_sentinel_heartbeat() -> None:
    """Record the current run timestamp for self-staleness detection."""
    try:
        _SENTINEL_HEARTBEAT_FILE.parent.mkdir(parents=True, exist_ok=True)
        _SENTINEL_HEARTBEAT_FILE.write_text(
            json.dumps({"last_run_epoch": time.time(), "ts": _now().isoformat(timespec="seconds")}),
            encoding="utf-8",
        )
    except OSError:
        pass


def run_once(cfg: dict, run_file: Path, dry_run: bool) -> int:
    """
    Execute all checks, emit notifications, and write results to the JSONL log.
    Returns the number of incidents found.
    """
    total_incidents = 0
    run_ts = _now().isoformat(timespec="seconds")

    # Self-staleness check: detect if sentinel itself was down
    for inc in _check_self_staleness():
        inc_id = _make_incident_id()
        notify(inc_id, inc["severity"], inc["message"], details=inc.get("details"))
        if not dry_run:
            _append_run(run_file, {
                "run_timestamp": run_ts, "incident_id": inc_id,
                "check": "sentinel_self", "severity": inc["severity"],
                "message": inc["message"], **({"details": inc["details"]} if inc.get("details") else {}),
            })
        total_incidents += 1

    for check_name, check_fn in CHECKS:
        if not cfg.get("checks", {}).get(check_name, {}).get("enabled", True):
            continue

        try:
            raw_incidents = check_fn(cfg, dry_run)
        except Exception as exc:          # noqa: BLE001
            raw_incidents = [{
                "check": check_name,
                "severity": "medium",
                "message": f"Unhandled exception in check '{check_name}': {exc}",
            }]

        for inc in raw_incidents:
            inc_id = _make_incident_id()
            severity = inc.get("severity", "medium")
            message  = inc.get("message", "(no message)")
            details  = inc.get("details")

            notify(inc_id, severity, message, details=details)

            record = {
                "run_timestamp": run_ts,
                "incident_id":   inc_id,
                "check":         inc.get("check", check_name),
                "severity":      severity,
                "message":       message,
            }
            if details:
                record["details"] = details

            if not dry_run:
                _append_run(run_file, record)

            total_incidents += 1

    if total_incidents == 0:
        print(f"[sentinel] {run_ts} — All checks passed. No incidents.")

    # Record heartbeat for self-staleness detection on next run
    if not dry_run:
        _write_sentinel_heartbeat()

    return total_incidents


def main() -> None:
    parser = argparse.ArgumentParser(
        description="Self-Healing Sentinel — monitors system health and raises incidents."
    )
    parser.add_argument(
        "--config",
        required=True,
        help="Path to deck-sentinel.json",
    )
    parser.add_argument(
        "--once",
        action="store_true",
        help="Run all checks once and exit (default: loop according to config interval).",
    )
    parser.add_argument(
        "--dry-run",
        action="store_true",
        help="Run checks but do not write to sentinel_runs.jsonl or make HTTP calls.",
    )
    args = parser.parse_args()

    cfg = _load_config(args.config)

    # Resolve sentinel_runs.jsonl path relative to config file
    cfg_dir   = Path(args.config).parent
    run_file  = cfg_dir / cfg.get("sentinel_runs_file", "sentinel_runs.jsonl")

    loop_interval = int(cfg.get("loop_interval_seconds", 300))

    if args.once or args.dry_run:
        run_once(cfg, run_file, dry_run=args.dry_run)
        return

    print(f"[sentinel] Starting loop (interval: {loop_interval}s). Ctrl-C to stop.")
    print("⚠️  DO NOT run this via cron without the operator's explicit approval.\n")

    try:
        while True:
            run_once(cfg, run_file, dry_run=False)
            time.sleep(loop_interval)
    except KeyboardInterrupt:
        print("\n[sentinel] Stopped.")


if __name__ == "__main__":
    main()
