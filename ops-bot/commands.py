"""
commands.py -- Ops bot command handlers.

Each handler takes an args string and returns a response string.
All output is pre-formatted for Discord (code blocks, truncation).

Python 3.10+ stdlib only.
"""

from __future__ import annotations

import json
import os
import signal
import shutil
import subprocess
import threading
import time
import urllib.error
import urllib.request
from pathlib import Path

OPENCLAW_BIN = shutil.which("openclaw") or "openclaw"
WORKSPACE_DIR = os.path.expanduser("~/.openclaw/workspace")
CONFIG_LIVE = os.path.expanduser("~/.openclaw/openclaw.json")
CONFIG_WORKSPACE = os.path.join(WORKSPACE_DIR, "openclaw.json")
MAX_OUTPUT = 15000  # discord_post() handles splitting into multiple messages


def _run(cmd: list[str], timeout: int = 30) -> str:
    """Run a subprocess and capture output."""
    try:
        result = subprocess.run(
            cmd,
            capture_output=True,
            text=True,
            timeout=timeout,
            env={**os.environ, "NO_COLOR": "1", "TERM": "dumb"},
        )
        output = (result.stdout + result.stderr).strip()
    except subprocess.TimeoutExpired:
        output = f"(command timed out after {timeout}s)"
    except FileNotFoundError:
        output = f"(command not found: {cmd[0]})"
    except Exception as exc:
        output = f"(error: {exc})"

    if len(output) > MAX_OUTPUT:
        output = output[:MAX_OUTPUT] + "\n... (truncated)"
    return output


# ── Command handlers ──────────────────────────────────────────────────────────

def cmd_doctor(args: str) -> str:
    """Run openclaw doctor and return output."""
    output = _run([OPENCLAW_BIN, "doctor"], timeout=60)
    return f"**openclaw doctor**\n```\n{output}\n```"


def cmd_status(args: str) -> str:
    """Quick health summary: gateway ping + LaunchAgent states."""
    lines: list[str] = []

    # Check gateway
    gateway_url = os.environ.get("OPENCLAW_GATEWAY_URL", "http://localhost:18789")
    try:
        req = urllib.request.Request(f"{gateway_url}/health", method="GET")
        with urllib.request.urlopen(req, timeout=3) as resp:
            lines.append(f"Gateway: UP (HTTP {resp.status})")
    except urllib.error.HTTPError as exc:
        lines.append(f"Gateway: UP (HTTP {exc.code})")
    except Exception:
        lines.append("Gateway: DOWN")

    # Check config validity
    try:
        text = Path(CONFIG_WORKSPACE).read_text("utf-8")
        json.loads(text)
        lines.append("Config: valid JSON")
    except json.JSONDecodeError as exc:
        lines.append(f"Config: INVALID JSON (line {exc.lineno})")
    except OSError:
        lines.append("Config: cannot read")

    # Check LaunchAgents
    uid = os.getuid()
    for label in [
        "ai.openclaw.gateway",
        "ai.openclaw.sentinel",
        "ai.openclaw.deck",
        "ai.openclaw.ops-bot",
    ]:
        try:
            result = subprocess.run(
                ["launchctl", "print", f"gui/{uid}/{label}"],
                capture_output=True,
                text=True,
                timeout=5,
            )
            if result.returncode == 0:
                # Extract top-level state and PID (single-tab indent)
                svc_state = "loaded"
                pid = None
                for line in result.stdout.splitlines():
                    if line.startswith("\tstate = ") and not line.startswith("\t\t"):
                        svc_state = line.split("= ", 1)[1]
                    elif line.startswith("\tpid = "):
                        pid = line.split("= ", 1)[1]
                state = svc_state
                if pid:
                    state += f" (pid {pid})"
            else:
                state = "not loaded"
        except Exception:
            state = "unknown"
        short = label.replace("ai.openclaw.", "")
        lines.append(f"{short}: {state}")

    return "```\n" + "\n".join(lines) + "\n```"


def cmd_gateway(args: str) -> str | dict:
    """Control gateway: stop / start / restart."""
    action = args.strip().lower()
    if action not in ("start", "stop", "restart", "status"):
        return {
            "content": "**Gateway**",
            "components": [{"type": 1, "components": [
                {"type": 2, "style": 2, "label": "Status", "custom_id": "cmd:!openclaw-gw status"},
                {"type": 2, "style": 3, "label": "Start", "custom_id": "cmd:!openclaw-gw start"},
                {"type": 2, "style": 4, "label": "Stop", "custom_id": "cmd:!openclaw-gw stop"},
                {"type": 2, "style": 1, "label": "Restart", "custom_id": "cmd:!openclaw-gw restart"},
            ]}],
        }
    if action == "status":
        output = _run(["launchctl", "list", "ai.openclaw.gateway"], timeout=5)
        return f"**gateway status**\n```\n{output}\n```"
    output = _run([OPENCLAW_BIN, "gateway", action], timeout=30)
    emoji = {"start": "\u2705", "stop": "\u26d4", "restart": "\U0001f504"}.get(action, "")
    return f"{emoji} **gateway {action}**\n```\n{output}\n```"



def cmd_nextjs(args: str) -> str | dict:
    """Control Next.js dev server (Deck): status / start / stop / restart / logs."""
    action = args.strip().lower()
    label = "ai.openclaw.deck"
    log_path = os.path.expanduser("~/.openclaw/logs/openclaw-deck.err.log")

    if not action:
        return {
            "content": "**Next.js (Deck)**",
            "components": [{"type": 1, "components": [
                {"type": 2, "style": 2, "label": "Status", "custom_id": "cmd:!nextjs status"},
                {"type": 2, "style": 3, "label": "Start", "custom_id": "cmd:!nextjs start"},
                {"type": 2, "style": 4, "label": "Stop", "custom_id": "cmd:!nextjs stop"},
                {"type": 2, "style": 1, "label": "Restart", "custom_id": "cmd:!nextjs restart"},
                {"type": 2, "style": 2, "label": "Logs", "custom_id": "cmd:!nextjs logs"},
            ]}],
        }

    if action == "status":
        output = _run(["launchctl", "list", label], timeout=5)
        return f"**nextjs status**\n```\n{output}\n```"

    if action == "start":
        output = _run(["launchctl", "start", label], timeout=10)
        return f"\u2705 **nextjs start**\n```\n{output or '(started)'}\n```"

    if action == "stop":
        output = _run(["launchctl", "stop", label], timeout=10)
        return f"\u26d4 **nextjs stop**\n```\n{output or '(stopped)'}\n```"

    if action == "restart":
        stop_out = _run(["launchctl", "stop", label], timeout=10)
        time.sleep(3)
        start_out = _run(["launchctl", "start", label], timeout=10)
        return (
            f"\U0001f504 **nextjs restart**\n"
            f"```\nstop:  {stop_out or '(ok)'}\nstart: {start_out or '(ok)'}\n```"
        )

    if action == "logs":
        output = _run(["tail", "-n", "20", log_path], timeout=5)
        return f"**nextjs logs** (last 20 lines)\n```\n{output}\n```"

    return "Usage: `!nextjs status|start|stop|restart|logs`"


def cmd_opsbot(args: str) -> str | dict:
    """Restart the ops bot itself. Launchd respawns it automatically."""
    action = args.strip().lower()
    label = "ai.openclaw.ops-bot"
    log_path = os.path.expanduser("~/.openclaw/logs/ops-bot.err.log")

    if not action:
        return {
            "content": "**Ops Bot**",
            "components": [{"type": 1, "components": [
                {"type": 2, "style": 2, "label": "Status", "custom_id": "cmd:!ops-bot status"},
                {"type": 2, "style": 1, "label": "Restart", "custom_id": "cmd:!ops-bot restart"},
                {"type": 2, "style": 2, "label": "Logs", "custom_id": "cmd:!ops-bot logs"},
            ]}],
        }

    if action == "status":
        output = _run(["launchctl", "list", label], timeout=5)
        return f"**ops-bot status**\n```\n{output}\n```"

    if action == "restart":
        # Schedule self-termination after response is posted
        def _delayed_exit():
            time.sleep(2)
            os.kill(os.getpid(), signal.SIGTERM)
        threading.Thread(target=_delayed_exit, daemon=True).start()
        return (
            "\U0001f504 **ops-bot restarting...**\n"
            "Launchd will respawn automatically."
        )

    if action == "logs":
        output = _run(["tail", "-n", "20", log_path], timeout=5)
        return f"**ops-bot logs** (last 20 lines)\n```\n{output}\n```"

    return "Usage: `!ops-bot status|restart|logs`"


def cmd_restart_all(args: str) -> str:
    """Restart all Deck services in order."""
    results: list[str] = []
    services = [
        ("openclaw-deck", "ai.openclaw.deck"),
        ("sentinel", "ai.openclaw.sentinel"),
    ]

    for name, label in services:
        _run(["launchctl", "stop", label], timeout=10)
        time.sleep(1)
        _run(["launchctl", "start", label], timeout=10)
        results.append(f"{name}: restarted")

    # Ops-bot restarts itself last
    results.append("ops-bot: restarting...")

    def _delayed_exit():
        time.sleep(3)
        os.kill(os.getpid(), signal.SIGTERM)
    threading.Thread(target=_delayed_exit, daemon=True).start()

    return (
        "\U0001f504 **Restarting all Deck services**\n"
        "```\n" + "\n".join(results) + "\n```\n"
        "> **Note:** OpenClaw gateway is not included — restart it separately with `!openclaw-gw restart`"
    )


def cmd_revert_config(args: str) -> str:
    """Revert openclaw.json to last git-committed version."""
    # Check if there are uncommitted changes
    diff_output = _run(
        ["git", "-C", WORKSPACE_DIR, "diff", "HEAD", "--", "openclaw.json"],
        timeout=10,
    )
    if not diff_output.strip():
        return "Config is already at the last committed version. No changes to revert."

    # Revert workspace copy
    revert_result = _run(
        ["git", "-C", WORKSPACE_DIR, "checkout", "HEAD", "--", "openclaw.json"],
        timeout=10,
    )
    if "error" in revert_result.lower():
        return f"Failed to revert:\n```\n{revert_result}\n```"

    # Copy reverted config to live location
    try:
        shutil.copy2(CONFIG_WORKSPACE, CONFIG_LIVE)
    except OSError as exc:
        return f"Reverted workspace config but failed to copy to live location: {exc}"

    # Show what was reverted
    truncated_diff = diff_output
    if len(truncated_diff) > 1200:
        truncated_diff = truncated_diff[:1200] + "\n... (truncated)"

    return (
        f"\u2705 **Config reverted** to last committed version.\n"
        f"Copied to `~/.openclaw/openclaw.json`.\n"
        f"Run `!gateway restart` to apply.\n"
        f"```diff\n{truncated_diff}\n```"
    )


def cmd_help(args: str) -> dict | str:
    """List available commands with interactive buttons."""
    # Button styles: 1=Primary(blue), 2=Secondary(grey), 3=Success(green), 4=Danger(red)
    return {
        "content": "**Deck Ops Bot**",
        "components": [
            {
                "type": 1,  # ActionRow
                "components": [
                    {"type": 2, "style": 1, "label": "Status", "custom_id": "cmd:!status"},
                    {"type": 2, "style": 1, "label": "Doctor", "custom_id": "cmd:!doctor"},
                    {"type": 2, "style": 3, "label": "Restart All", "custom_id": "cmd:!restart-all"},
                    {"type": 2, "style": 4, "label": "Revert Config", "custom_id": "cmd:!revert-config"},
                ],
            },
            {
                "type": 1,  # ActionRow
                "components": [
                    {"type": 2, "style": 2, "label": "Gateway", "custom_id": "cmd:!openclaw-gw"},
                    {"type": 2, "style": 2, "label": "Next.js", "custom_id": "cmd:!nextjs"},
                    {"type": 2, "style": 2, "label": "Ops Bot", "custom_id": "cmd:!ops-bot"},
                ],
            },
        ],
    }


# ── Registry ──────────────────────────────────────────────────────────────────

COMMAND_REGISTRY: dict[str, callable] = {
    "!doctor": cmd_doctor,
    "!status": cmd_status,
    "!openclaw-gw": cmd_gateway,
    "!nextjs": cmd_nextjs,
    "!ops-bot": cmd_opsbot,
    "!restart-all": cmd_restart_all,
    "!revert-config": cmd_revert_config,
    "!help": cmd_help,
}
