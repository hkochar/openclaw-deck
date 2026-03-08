"""
notifier.py — Sentinel notification dispatcher.

Sends formatted incident alerts to stdout, Discord, and optionally to a log file.
Python 3.10+ stdlib only. No external dependencies.
"""

import json
import os
import sqlite3
import sys
import time
import urllib.error
import urllib.request
from datetime import datetime, timezone
from pathlib import Path


# ANSI colour codes for terminal output
_COLOURS = {
    "critical": "\033[1;31m",   # bold red
    "high":     "\033[0;31m",   # red
    "medium":   "\033[0;33m",   # yellow
    "low":      "\033[0;36m",   # cyan
    "info":     "\033[0;37m",   # white
}
_RESET = "\033[0m"
_BOLD  = "\033[1m"

# Discord config
def _load_system_status_channel() -> str:
    """Read systemChannels.systemStatus from Deck config, env override, or fallback."""
    env_val = os.environ.get("DISCORD_CHANNEL_SYSTEM_STATUS")
    if env_val:
        return env_val
    config_path = (
        Path(os.environ.get("DECK_ROOT") or str(Path(__file__).resolve().parent.parent)) / "config" / "agents.json"
    )
    try:
        with open(config_path, "r", encoding="utf-8") as f:
            cfg = json.load(f)
        ch = cfg.get("systemChannels", {}).get("systemStatus", "")
        if ch:
            return ch
    except (OSError, json.JSONDecodeError, KeyError):
        pass
    return ""

_SYSTEM_STATUS_CHANNEL = _load_system_status_channel()
_SEVERITY_EMOJI = {
    "critical": "\U0001f534",  # red circle
    "high":     "\U0001f534",
    "medium":   "\u26a0\ufe0f",   # warning
    "low":      "\u2139\ufe0f",   # info
    "info":     "\u2139\ufe0f",
}


def _load_env_file() -> dict[str, str]:
    """Load ~/.openclaw/.env key-value pairs."""
    env_path = Path(os.environ.get("HOME", "~")) / ".openclaw" / ".env"
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


def _log_to_mc_system_db(category: str, action: str, summary: str,
                         detail: dict | None = None, status: str = "error") -> None:
    """Write a row to deck-system.db so it shows up in Deck Logs > System."""
    db_path = Path(os.environ.get("DECK_ROOT") or str(Path(__file__).resolve().parent.parent)) / "data" / "deck-system.db"
    try:
        conn = sqlite3.connect(str(db_path), timeout=5)
        conn.execute(
            "INSERT INTO system_log (ts, category, action, summary, detail, status) VALUES (?, ?, ?, ?, ?, ?)",
            (int(datetime.now(timezone.utc).timestamp() * 1000), category, action, summary,
             json.dumps(detail) if detail else None, status),
        )
        conn.commit()
        conn.close()
    except Exception:
        pass  # DB might not exist yet — don't crash sentinel


def _get_mc_site_url() -> str:
    """Read Deck dashboard URL from config.json serviceUrls, env, or default."""
    env_val = os.environ.get("OPENCLAW_DECK_SITE_URL")
    if env_val:
        return env_val
    config_path = (
        Path(os.environ.get("DECK_ROOT") or str(Path(__file__).resolve().parent.parent)) / "config" / "config.json"
    )
    try:
        with open(config_path, "r", encoding="utf-8") as f:
            cfg = json.load(f)
        url = cfg.get("serviceUrls", {}).get("deckDashboard", "")
        if url:
            return url
    except (OSError, json.JSONDecodeError, KeyError):
        pass
    return "http://localhost:3000"


def _send_discord(message: str, components: list | None = None, _retries: int = 2) -> None:
    """Post a message to #system-status via Discord Bot API with retry-after handling."""
    if not _SYSTEM_STATUS_CHANNEL:
        print("[notifier] WARNING: no system-status channel configured — skipping Discord",
              file=sys.stderr)
        return
    env = _load_env_file()
    token = env.get("DISCORD_BOT_TOKEN_DECK") or env.get("DISCORD_BOT_TOKEN") or ""
    if not token:
        print("[notifier] WARNING: no Discord bot token found — skipping notification",
              file=sys.stderr)
        return
    url = f"https://discord.com/api/v10/channels/{_SYSTEM_STATUS_CHANNEL}/messages"
    payload: dict = {"content": message}
    if components:
        payload["components"] = components
    data = json.dumps(payload).encode("utf-8")

    for attempt in range(_retries + 1):
        req = urllib.request.Request(
            url, data=data, method="POST",
            headers={
                "Content-Type": "application/json",
                "Authorization": f"Bot {token}",
                "User-Agent": "DiscordBot (https://openclaw.ai, 1.0)",
            },
        )
        try:
            urllib.request.urlopen(req, timeout=10)
            return  # success
        except urllib.error.HTTPError as exc:
            if exc.code == 429 and attempt < _retries:
                # Rate limited — respect retry_after
                body = exc.read().decode("utf-8", errors="replace")[:500]
                retry_after = 1.0
                try:
                    retry_after = float(json.loads(body).get("retry_after", 1.0))
                except (json.JSONDecodeError, ValueError, TypeError):
                    pass
                retry_after = min(max(retry_after, 0.3), 5.0)  # clamp 0.3–5s
                print(f"[notifier] Rate limited, retrying in {retry_after:.1f}s (attempt {attempt + 1}/{_retries + 1})",
                      file=sys.stderr)
                time.sleep(retry_after)
                continue
            err_detail = f"HTTP {exc.code}: {exc.read().decode('utf-8', errors='replace')[:200]}"
            print(f"[notifier] WARNING: Discord send failed: {err_detail}", file=sys.stderr)
            _log_to_mc_system_db(
                category="sentinel",
                action="discord_send_failed",
                summary=f"Failed to deliver Discord notification: {err_detail}",
                detail={"channel": _SYSTEM_STATUS_CHANNEL, "error": err_detail},
            )
            return
        except (urllib.error.URLError, OSError) as exc:
            err_detail = str(exc)
            print(f"[notifier] WARNING: Discord send failed: {err_detail}", file=sys.stderr)
            _log_to_mc_system_db(
                category="sentinel",
                action="discord_send_failed",
                summary=f"Failed to deliver Discord notification: {err_detail}",
                detail={"channel": _SYSTEM_STATUS_CHANNEL, "error": err_detail},
            )
            return


def notify(
    incident_id: str,
    severity: str,
    message: str,
    details: dict | None = None,
    log_file: str | None = None,
) -> None:
    """
    Print a formatted incident alert to stdout and optionally append to a log file.

    Parameters
    ----------
    incident_id : str
        Unique incident identifier (e.g. INC-20260218-123456-AB12).
    severity : str
        One of: critical | high | medium | low | info
    message : str
        Human-readable description of the incident.
    details : dict | None
        Optional structured detail payload (printed as JSON).
    log_file : str | None
        If provided, the formatted record is also appended here as JSONL.
    """
    severity = severity.lower()
    colour = _COLOURS.get(severity, "")
    now_iso = datetime.now(timezone.utc).isoformat(timespec="seconds")

    # ── Terminal output ────────────────────────────────────────────────────────
    border = "=" * 72
    print(f"\n{colour}{border}{_RESET}")
    print(f"{colour}{_BOLD}[SENTINEL ALERT] {now_iso}{_RESET}")
    print(f"{colour}  Incident : {incident_id}{_RESET}")
    print(f"{colour}  Severity : {severity.upper()}{_RESET}")
    print(f"{colour}  Message  : {message}{_RESET}")
    if details:
        print(f"{colour}  Details  :{_RESET}")
        for k, v in details.items():
            print(f"             {k}: {v}")
    print(f"{colour}{border}{_RESET}\n")
    sys.stdout.flush()

    # ── Deck System Log (deck-system.db) ─────────────────────────────────────
    _log_to_mc_system_db(
        category="sentinel",
        action=f"alert_{severity}",
        summary=f"[{incident_id}] {message}",
        detail=details,
        status="error" if severity in ("critical", "high") else "ok",
    )

    # ── Discord notification ─────────────────────────────────────────────────
    if severity in ("critical", "high", "medium"):
        emoji = _SEVERITY_EMOJI.get(severity, "")
        mc_url = _get_mc_site_url()

        # Build code-block body with aligned key-value pairs (matches budget alert format)
        kv_lines: list[str] = []
        settings_url = ""
        if details:
            # Compute max key width for alignment
            display_keys = {k: v for k, v in details.items() if k != "settings"}
            max_key = max((len(k) for k in display_keys), default=0)
            for k, v in display_keys.items():
                label = k.replace("_", " ").title()
                kv_lines.append(f"{label + ':':<{max_key + 2}} {v}")
            settings_url = str(details.get("settings", ""))

        discord_msg = (
            f"{emoji} **Sentinel Alert** [{severity.upper()}]\n"
            "```\n"
            + "\n".join(kv_lines)
            + "\n```"
        )

        # Action buttons (link type = style 5)
        buttons: list[dict] = []
        agent_name = details.get("agent", "") if details else ""
        if agent_name:
            since = int(time.time() * 1000) - 3600_000  # last hour
            buttons.append({
                "type": 2, "style": 5, "label": "View Logs",
                "url": f"{mc_url}/logs?agent={agent_name.lower()}&since={since}",
            })
        if settings_url:
            # Resolve relative or localhost URLs to actual Deck URL
            if settings_url.startswith("/"):
                cfg_url = mc_url + settings_url
            else:
                cfg_url = settings_url.replace("http://localhost:3000", mc_url)
            buttons.append({
                "type": 2, "style": 5, "label": "Configure",
                "url": cfg_url,
            })

        components: list[dict] | None = None
        if buttons:
            components = [{"type": 1, "components": buttons}]  # ActionRow

        _send_discord(discord_msg, components=components)

    # ── Optional file log (JSONL) ──────────────────────────────────────────────
    if log_file:
        record = {
            "timestamp": now_iso,
            "incident_id": incident_id,
            "severity": severity,
            "message": message,
        }
        if details:
            record["details"] = details
        try:
            with open(log_file, "a", encoding="utf-8") as fh:
                fh.write(json.dumps(record) + "\n")
        except OSError as exc:
            print(f"[notifier] WARNING: could not write to log file {log_file!r}: {exc}",
                  file=sys.stderr)


# ── Standalone smoke-test ─────────────────────────────────────────────────────
if __name__ == "__main__":
    notify(
        incident_id="INC-20260218-000000-TEST",
        severity="medium",
        message="Smoke-test alert from notifier.py — everything is fine.",
        details={"component": "notifier", "check": "self-test"},
    )
    print("notifier.py self-test passed.")
