"""
ops_bot.py -- Discord Ops Bot for Deck.

Connects to Discord Gateway via WebSocket, listens for !commands
in the #system-status channel, and executes ops tasks.

Python 3.10+ stdlib only.  No pip installs required.

Usage:
    python3 ops_bot.py              # run continuously (default)
    python3 ops_bot.py --once       # handle one batch of messages then exit (for testing)
"""

from __future__ import annotations

import base64
import hashlib
import json
import os
import random
import signal
import socket
import ssl
import struct
import sys
import threading
import time
import urllib.error
import urllib.request
from pathlib import Path

# ── Config ────────────────────────────────────────────────────────────────────

def _load_system_status_channel() -> str:
    """Read systemChannels.systemStatus from Deck config, env override, or fallback."""
    env_val = os.environ.get("DISCORD_CHANNEL_SYSTEM_STATUS")
    if env_val:
        return env_val
    deck_root = os.environ.get("DECK_ROOT") or str(Path(__file__).resolve().parent.parent)
    config_path = Path(deck_root) / "config" / "agents.json"
    try:
        with open(config_path, "r", encoding="utf-8") as f:
            cfg = json.load(f)
        ch = cfg.get("systemChannels", {}).get("systemStatus", "")
        if ch:
            return ch
    except (OSError, json.JSONDecodeError, KeyError):
        pass
    return ""

def _load_command_permissions() -> dict:
    """Read opsBotCommands from Deck config. Returns {cmd: bool} or empty dict."""
    deck_root = os.environ.get("DECK_ROOT") or str(Path(__file__).resolve().parent.parent)
    config_path = Path(deck_root) / "config" / "agents.json"
    try:
        with open(config_path, "r", encoding="utf-8") as f:
            cfg = json.load(f)
        return cfg.get("opsBotCommands", {})
    except (OSError, json.JSONDecodeError, KeyError):
        return {}

ALLOWED_CHANNEL = _load_system_status_channel()
DECK_DASHBOARD_URL = os.environ.get("DECK_DASHBOARD_URL", "http://127.0.0.1:3000")
ADMIN_ROLE_ID = os.environ.get("DECK_OPS_ADMIN_ROLE_ID", "")  # Discord role ID for admin commands
DISCORD_API = "https://discord.com/api/v10"
GATEWAY_URL = "wss://gateway.discord.gg/?v=10&encoding=json"
MAX_MSG_LEN = 1950
INTENTS = (1 << 9) | (1 << 15)  # GUILD_MESSAGES + MESSAGE_CONTENT


# ── Env loading ───────────────────────────────────────────────────────────────

def _load_env() -> dict[str, str]:
    """Read key=value pairs from ~/.openclaw/.env"""
    env_path = Path(os.environ.get("HOME", os.path.expanduser("~"))) / ".openclaw" / ".env"
    result: dict[str, str] = {}
    try:
        for line in env_path.read_text("utf-8").splitlines():
            line = line.strip()
            if not line or line.startswith("#"):
                continue
            if "=" not in line:
                continue
            k, v = line.split("=", 1)
            result[k.strip()] = v.strip().strip("'\"")
    except OSError:
        pass
    return result


# ── Discord REST ──────────────────────────────────────────────────────────────

def _discord_send_one(channel_id: str, payload: str | dict, token: str) -> None:
    """Send a single message. Payload is str (content) or dict (full body). Retries on 429."""
    if isinstance(payload, str):
        data = json.dumps({"content": payload}).encode("utf-8")
    else:
        data = json.dumps(payload).encode("utf-8")
    for attempt in range(3):
        req = urllib.request.Request(
            f"{DISCORD_API}/channels/{channel_id}/messages",
            data=data,
            method="POST",
            headers={
                "Content-Type": "application/json",
                "Authorization": f"Bot {token}",
                "User-Agent": "DeckBot/1.0",
            },
        )
        try:
            urllib.request.urlopen(req, timeout=10)
            return
        except urllib.error.HTTPError as exc:
            if exc.code == 429:
                # Rate limited — read retry_after from response
                try:
                    body = json.loads(exc.read().decode("utf-8", errors="replace"))
                    wait = body.get("retry_after", 2)
                except Exception:
                    wait = 2
                print(f"[ops-bot] Rate limited, waiting {wait}s...", file=sys.stderr)
                time.sleep(wait)
                continue
            print(f"[ops-bot] Failed to post to Discord: HTTP {exc.code}", file=sys.stderr)
            return
        except Exception as exc:
            print(f"[ops-bot] Failed to post to Discord: {exc}", file=sys.stderr)
            return


def discord_post(channel_id: str, content: str | dict, token: str) -> None:
    """Send a message to Discord, splitting into multiple messages if > 2000 chars.

    If content is a dict (e.g. with components/embeds), send as-is without splitting.
    """
    if isinstance(content, dict):
        _discord_send_one(channel_id, content, token)
        return

    if len(content) <= MAX_MSG_LEN:
        _discord_send_one(channel_id, content, token)
        return

    # Reserve room for code block open/close markers when splitting
    SAFE_LEN = MAX_MSG_LEN - 10  # room for ``` markers

    chunks: list[str] = []
    current = ""
    in_code_block = False

    for line in content.split("\n"):
        test = current + "\n" + line if current else line
        if len(test) > SAFE_LEN:
            if current:
                if in_code_block:
                    current += "\n```"
                chunks.append(current)
                current = "```\n" + line if in_code_block else line
            else:
                # Single line exceeds limit — hard truncate
                chunks.append(line[:SAFE_LEN])
                current = ""
        else:
            current = test

        # Track code block state
        if line.strip().startswith("```"):
            in_code_block = not in_code_block

    if current:
        chunks.append(current)

    for i, chunk in enumerate(chunks):
        if i > 0:
            time.sleep(1.2)  # Discord rate limit: 5 msgs per 5s per channel
        # Final safety net — hard split if still over limit
        while len(chunk) > MAX_MSG_LEN:
            # Find last newline before the limit
            cut = chunk.rfind("\n", 0, MAX_MSG_LEN)
            if cut <= 0:
                cut = MAX_MSG_LEN
            _discord_send_one(channel_id, chunk[:cut], token)
            chunk = chunk[cut:].lstrip("\n")
            time.sleep(0.3)
        if chunk:
            _discord_send_one(channel_id, chunk, token)


# ── Minimal RFC 6455 WebSocket client ─────────────────────────────────────────

class WebSocketError(Exception):
    pass


class SimpleWebSocket:
    """
    Minimal WebSocket client over SSL.  Supports text frames only.
    Handles ping/pong, close frames, and client-side masking.
    """

    def __init__(self, url: str):
        self._url = url
        self._sock: socket.socket | None = None
        self._ssl_sock: ssl.SSLSocket | None = None
        self._closed = False

    def connect(self) -> None:
        """Perform HTTP upgrade handshake."""
        # Parse URL: wss://host/path?query
        assert self._url.startswith("wss://"), "Only wss:// supported"
        rest = self._url[6:]
        slash_idx = rest.find("/")
        if slash_idx == -1:
            host = rest
            path = "/"
        else:
            host = rest[:slash_idx]
            path = rest[slash_idx:]

        port = 443
        if ":" in host:
            host, port_str = host.rsplit(":", 1)
            port = int(port_str)

        # TCP + TLS
        raw_sock = socket.create_connection((host, port), timeout=15)
        ctx = ssl.create_default_context()
        self._ssl_sock = ctx.wrap_socket(raw_sock, server_hostname=host)
        # Clear the connection timeout so recv() blocks indefinitely
        # (heartbeat thread handles liveness detection)
        self._ssl_sock.settimeout(None)

        # WebSocket upgrade
        ws_key = base64.b64encode(os.urandom(16)).decode("ascii")
        handshake = (
            f"GET {path} HTTP/1.1\r\n"
            f"Host: {host}\r\n"
            f"Upgrade: websocket\r\n"
            f"Connection: Upgrade\r\n"
            f"Sec-WebSocket-Key: {ws_key}\r\n"
            f"Sec-WebSocket-Version: 13\r\n"
            f"\r\n"
        )
        self._ssl_sock.sendall(handshake.encode("ascii"))

        # Read response headers
        response = b""
        while b"\r\n\r\n" not in response:
            chunk = self._ssl_sock.recv(4096)
            if not chunk:
                raise WebSocketError("Connection closed during handshake")
            response += chunk

        status_line = response.split(b"\r\n", 1)[0].decode("ascii", errors="replace")
        if "101" not in status_line:
            raise WebSocketError(f"Handshake failed: {status_line}")

        # Any data after headers is the start of WebSocket frames
        self._leftover = response.split(b"\r\n\r\n", 1)[1]

    def _recv_exact(self, n: int) -> bytes:
        """Read exactly n bytes, using leftover buffer first."""
        result = b""
        if self._leftover:
            result = self._leftover[:n]
            self._leftover = self._leftover[n:]
            n -= len(result)
        while n > 0:
            chunk = self._ssl_sock.recv(min(n, 65536))
            if not chunk:
                raise WebSocketError("Connection closed")
            result += chunk
            n -= len(chunk)
        return result

    def recv(self) -> str | None:
        """Read one text frame.  Returns None on close.  Handles ping/pong."""
        if self._closed:
            return None

        while True:
            # Read frame header (2 bytes)
            header = self._recv_exact(2)
            fin = (header[0] >> 7) & 1
            opcode = header[0] & 0x0F
            masked = (header[1] >> 7) & 1
            payload_len = header[1] & 0x7F

            if payload_len == 126:
                payload_len = struct.unpack("!H", self._recv_exact(2))[0]
            elif payload_len == 127:
                payload_len = struct.unpack("!Q", self._recv_exact(8))[0]

            mask_key = self._recv_exact(4) if masked else None
            payload = self._recv_exact(payload_len)

            if mask_key:
                payload = bytes(b ^ mask_key[i % 4] for i, b in enumerate(payload))

            if opcode == 0x8:  # Close
                self._closed = True
                # Send close frame back
                try:
                    self._send_frame(0x8, payload[:2] if len(payload) >= 2 else b"")
                except Exception:
                    pass
                return None
            elif opcode == 0x9:  # Ping
                self._send_frame(0xA, payload)  # Pong
                continue
            elif opcode == 0xA:  # Pong
                continue
            elif opcode == 0x1:  # Text
                return payload.decode("utf-8", errors="replace")
            elif opcode == 0x2:  # Binary
                # Discord shouldn't send binary with encoding=json
                continue
            else:
                continue

    def send(self, text: str) -> None:
        """Send a text frame."""
        self._send_frame(0x1, text.encode("utf-8"))

    def _send_frame(self, opcode: int, payload: bytes) -> None:
        """Send a WebSocket frame with client-side masking."""
        if self._closed and opcode != 0x8:
            raise WebSocketError("Connection closed")

        frame = bytearray()
        frame.append(0x80 | opcode)  # FIN + opcode

        length = len(payload)
        if length < 126:
            frame.append(0x80 | length)  # Mask bit set
        elif length < 65536:
            frame.append(0x80 | 126)
            frame.extend(struct.pack("!H", length))
        else:
            frame.append(0x80 | 127)
            frame.extend(struct.pack("!Q", length))

        # Client must mask
        mask = os.urandom(4)
        frame.extend(mask)
        frame.extend(bytes(b ^ mask[i % 4] for i, b in enumerate(payload)))
        self._ssl_sock.sendall(frame)

    def close(self) -> None:
        """Close the connection."""
        if not self._closed:
            try:
                self._send_frame(0x8, b"")
            except Exception:
                pass
            self._closed = True
        if self._ssl_sock:
            try:
                self._ssl_sock.close()
            except Exception:
                pass


# ── Discord Gateway ───────────────────────────────────────────────────────────

class DiscordGateway:
    """
    Discord Gateway client.  Handles:
    - HELLO (opcode 10) → start heartbeat
    - IDENTIFY (opcode 2) → authenticate
    - RESUME (opcode 6) → reconnect without losing events
    - HEARTBEAT (opcode 1) → keep alive
    - DISPATCH (opcode 0) → route events
    - RECONNECT (opcode 7) / INVALID SESSION (opcode 9) → reconnect
    """

    def __init__(self, token: str):
        self.token = token
        self.ws: SimpleWebSocket | None = None
        self.sequence: int | None = None
        self.session_id: str | None = None
        self.resume_gateway_url: str | None = None
        self._heartbeat_interval = 45.0
        self._heartbeat_thread: threading.Thread | None = None
        self._running = False
        self._ack_received = True
        self._should_resume = False  # set True on opcode 7, False on opcode 9 (d=false)

    def connect(self, resume: bool = False) -> None:
        """Connect to Discord Gateway and identify (or resume)."""
        url = GATEWAY_URL
        if resume and self.resume_gateway_url:
            url = self.resume_gateway_url + "/?v=10&encoding=json"

        self.ws = SimpleWebSocket(url)
        self.ws.connect()

        # Wait for HELLO (opcode 10)
        hello_raw = self.ws.recv()
        if hello_raw is None:
            raise WebSocketError("No HELLO received")
        hello = json.loads(hello_raw)
        if hello.get("op") != 10:
            raise WebSocketError(f"Expected HELLO (op 10), got op {hello.get('op')}")

        self._heartbeat_interval = hello["d"]["heartbeat_interval"] / 1000.0
        print(f"[ops-bot] Connected. Heartbeat interval: {self._heartbeat_interval}s")

        if resume and self.session_id and self.sequence is not None:
            # Send RESUME (opcode 6)
            resume_payload = {
                "op": 6,
                "d": {
                    "token": self.token,
                    "session_id": self.session_id,
                    "seq": self.sequence,
                },
            }
            self.ws.send(json.dumps(resume_payload))
            print(f"[ops-bot] Sent RESUME (session={self.session_id}, seq={self.sequence})")
        else:
            # Send IDENTIFY (opcode 2)
            identify = {
                "op": 2,
                "d": {
                    "token": self.token,
                    "intents": INTENTS,
                    "properties": {
                        "os": "darwin",
                        "browser": "openclaw-deck-bot",
                        "device": "openclaw-deck-bot",
                    },
                },
            }
            self.ws.send(json.dumps(identify))
            print("[ops-bot] Sent IDENTIFY")

        # Start heartbeat thread
        self._running = True
        self._ack_received = True
        self._heartbeat_thread = threading.Thread(target=self._heartbeat_loop, daemon=True)
        self._heartbeat_thread.start()

    def _heartbeat_loop(self) -> None:
        """Send heartbeat at the interval Discord specified."""
        # Initial jitter
        time.sleep(self._heartbeat_interval * random.random())
        while self._running:
            if not self._ack_received:
                print("[ops-bot] Heartbeat ACK not received, reconnecting...", file=sys.stderr)
                self._running = False
                break
            self._ack_received = False
            heartbeat = {"op": 1, "d": self.sequence}
            try:
                self.ws.send(json.dumps(heartbeat))
            except Exception:
                self._running = False
                break
            time.sleep(self._heartbeat_interval)

    def run(self, on_dispatch: callable) -> None:
        """
        Main read loop.  Calls on_dispatch(event_name, data) for
        DISPATCH events.  Returns on disconnect.
        """
        while self._running:
            try:
                raw = self.ws.recv()
            except (WebSocketError, OSError) as exc:
                print(f"[ops-bot] WebSocket read error: {exc}", file=sys.stderr)
                break

            if raw is None:
                print("[ops-bot] WebSocket closed by server", file=sys.stderr)
                break

            try:
                msg = json.loads(raw)
            except json.JSONDecodeError:
                continue

            op = msg.get("op")
            if msg.get("s") is not None:
                self.sequence = msg["s"]

            if op == 0:  # DISPATCH
                event = msg.get("t", "")
                data = msg.get("d", {})
                if event == "READY":
                    self.session_id = data.get("session_id")
                    self.resume_gateway_url = data.get("resume_gateway_url")
                    user = data.get("user", {})
                    print(f"[ops-bot] READY as {user.get('username')}#{user.get('discriminator')}")
                elif event == "RESUMED":
                    print("[ops-bot] Session resumed successfully")
                on_dispatch(event, data)
            elif op == 1:  # Heartbeat request
                hb = {"op": 1, "d": self.sequence}
                self.ws.send(json.dumps(hb))
            elif op == 7:  # Reconnect
                print("[ops-bot] Server requested reconnect (will resume)")
                self._should_resume = True
                break
            elif op == 9:  # Invalid session
                can_resume = msg.get("d", False)
                if can_resume:
                    print("[ops-bot] Invalid session (resumable)")
                    self._should_resume = True
                else:
                    print("[ops-bot] Invalid session (not resumable, will re-identify)")
                    self._should_resume = False
                    self.session_id = None
                    self.sequence = None
                break
            elif op == 11:  # Heartbeat ACK
                self._ack_received = True

        self._running = False
        try:
            self.ws.close()
        except Exception:
            pass


# ── Interaction helpers ───────────────────────────────────────────────────────

GATEWAY_API = os.environ.get("OPENCLAW_GATEWAY_URL", "http://127.0.0.1:18789")

def _interaction_respond(interaction_id: str, interaction_token: str, content: str | dict, deferred: bool = False) -> None:
    """Respond to a Discord interaction (button click).

    If deferred=True, sends type 5 (DEFERRED_CHANNEL_MESSAGE_WITH_SOURCE).
    Otherwise sends type 4 (CHANNEL_MESSAGE_WITH_SOURCE).
    """
    url = f"{DISCORD_API}/interactions/{interaction_id}/{interaction_token}/callback"
    if deferred:
        body = {"type": 5}
    elif isinstance(content, dict):
        body = {"type": 4, "data": content}
    else:
        body = {"type": 4, "data": {"content": content}}
    data = json.dumps(body).encode("utf-8")
    req = urllib.request.Request(url, data=data, method="POST",
        headers={"Content-Type": "application/json", "User-Agent": "DeckBot/1.0"})
    try:
        urllib.request.urlopen(req, timeout=10)
    except Exception as exc:
        print(f"[ops-bot] Interaction respond failed: {exc}", file=sys.stderr)


def _interaction_followup(interaction_token: str, content: str | dict, bot_token: str) -> None:
    """Send a follow-up message after a deferred interaction response."""
    # Application ID is extracted from the bot token (first segment is base64-encoded snowflake)
    try:
        app_id = base64.b64decode(bot_token.split(".")[0] + "==").decode("utf-8")
    except Exception:
        app_id = ""
    url = f"{DISCORD_API}/webhooks/{app_id}/{interaction_token}"
    if isinstance(content, dict):
        payload = content
    else:
        payload = {"content": content}
    data = json.dumps(payload).encode("utf-8")
    req = urllib.request.Request(url, data=data, method="POST",
        headers={"Content-Type": "application/json", "User-Agent": "DeckBot/1.0"})
    try:
        urllib.request.urlopen(req, timeout=10)
    except Exception as exc:
        print(f"[ops-bot] Interaction followup failed: {exc}", file=sys.stderr)


def _gateway_post(path: str, body: dict) -> tuple[int, str]:
    """POST to the gateway API. Returns (status_code, response_body)."""
    url = f"{GATEWAY_API}{path}"
    data = json.dumps(body).encode("utf-8")
    req = urllib.request.Request(url, data=data, method="POST",
        headers={"Content-Type": "application/json"})
    try:
        with urllib.request.urlopen(req, timeout=10) as resp:
            return resp.status, resp.read().decode("utf-8", errors="replace")
    except urllib.error.HTTPError as exc:
        return exc.code, exc.read().decode("utf-8", errors="replace")
    except Exception as exc:
        return 0, str(exc)


def _log_system_event(action: str, summary: str, detail: dict | None = None, status: str = "ok") -> None:
    """Fire-and-forget log to Deck dashboard system log."""
    body = {"category": "ops-bot", "action": action, "summary": summary, "status": status}
    if detail:
        body["detail"] = detail
    data = json.dumps(body).encode("utf-8")
    req = urllib.request.Request(f"{DECK_DASHBOARD_URL}/api/system-log", data=data, method="POST",
        headers={"Content-Type": "application/json"})
    try:
        urllib.request.urlopen(req, timeout=5)
    except Exception:
        pass


# ── Interaction handler ──────────────────────────────────────────────────────

def handle_interaction(data: dict, token: str) -> None:
    """Handle button clicks (MESSAGE_COMPONENT interactions)."""
    interaction_type = data.get("type")
    if interaction_type != 3:  # 3 = MESSAGE_COMPONENT
        return

    interaction_id = data.get("id", "")
    interaction_token = data.get("token", "")
    custom_id = data.get("data", {}).get("custom_id", "")
    user = data.get("member", {}).get("user", data.get("user", {}))
    username = user.get("username", "?")

    print(f"[ops-bot] Button click: {custom_id} (from {username})")

    if custom_id.startswith("cmd:"):
        # Command button — run the command
        cmd_str = custom_id[4:]  # strip "cmd:" prefix
        parts = cmd_str.split(None, 1)
        cmd = parts[0].lower()
        args = parts[1] if len(parts) > 1 else ""

        from commands import COMMAND_REGISTRY
        handler = COMMAND_REGISTRY.get(cmd)
        if not handler:
            _interaction_respond(interaction_id, interaction_token, f"Unknown command: `{cmd}`")
            return

        _log_system_event("command", f"{username} ran {cmd} {args}".strip(),
            {"command": cmd, "args": args, "user": username})

        SLOW_COMMANDS = {"!doctor", "!restart-all", "!revert-config", "!openclaw-gw", "!nextjs", "!ops-bot"}
        if cmd in SLOW_COMMANDS:
            # Defer and follow up
            _interaction_respond(interaction_id, interaction_token, "", deferred=True)

            def _exec():
                try:
                    result = handler(args)
                    _log_system_event("command-result", f"{cmd} {args} completed".strip(),
                        {"command": cmd, "args": args, "user": username})
                except Exception as exc:
                    result = f"Error: {exc}"
                    _log_system_event("command-result", f"{cmd} {args} failed: {exc}".strip(),
                        {"command": cmd, "args": args, "error": str(exc)}, status="error")
                _interaction_followup(interaction_token, result, token)

            threading.Thread(target=_exec, daemon=True).start()
        else:
            # Fast command — respond immediately
            def _exec():
                try:
                    result = handler(args)
                except Exception as exc:
                    result = f"Error: {exc}"
                    _log_system_event("command-result", f"{cmd} {args} failed: {exc}".strip(),
                        {"command": cmd, "args": args, "error": str(exc)}, status="error")
                if isinstance(result, dict):
                    _interaction_respond(interaction_id, interaction_token, result)
                else:
                    _interaction_respond(interaction_id, interaction_token, result)

            threading.Thread(target=_exec, daemon=True).start()

    elif custom_id.startswith("budget:"):
        # Budget action button
        parts = custom_id.split(":")
        if len(parts) < 3:
            _interaction_respond(interaction_id, interaction_token, "Invalid budget action")
            return

        action = parts[1]
        agent = parts[2]

        if action == "override":
            hours = int(parts[3]) if len(parts) > 3 else 1
            _interaction_respond(interaction_id, interaction_token, "", deferred=True)

            def _exec():
                status, resp = _gateway_post("/budget/override", {
                    "agent": agent, "hours": hours, "reason": f"Discord button ({username})"
                })
                if status == 200:
                    _interaction_followup(interaction_token,
                        f"\u2705 **Override active** for `{agent}` ({hours}h)\nRequested by {username}", token)
                else:
                    _interaction_followup(interaction_token,
                        f"\u274c Override failed for `{agent}`: {resp}", token)

            threading.Thread(target=_exec, daemon=True).start()

        elif action == "pause":
            _interaction_respond(interaction_id, interaction_token, "", deferred=True)

            def _exec():
                status, resp = _gateway_post("/agent/pause", {"agent": agent, "paused": True})
                if status == 200:
                    _interaction_followup(interaction_token,
                        f"\u23f8\ufe0f **{agent}** paused by {username}", token)
                else:
                    _interaction_followup(interaction_token,
                        f"\u274c Pause failed for `{agent}`: {resp}", token)

            threading.Thread(target=_exec, daemon=True).start()

        elif action == "resume":
            _interaction_respond(interaction_id, interaction_token, "", deferred=True)

            def _exec():
                status, resp = _gateway_post("/agent/pause", {"agent": agent, "paused": False})
                if status == 200:
                    _interaction_followup(interaction_token,
                        f"\u25b6\ufe0f **{agent}** resumed by {username}", token)
                else:
                    _interaction_followup(interaction_token,
                        f"\u274c Resume failed for `{agent}`: {resp}", token)

            threading.Thread(target=_exec, daemon=True).start()

        else:
            _interaction_respond(interaction_id, interaction_token, f"Unknown budget action: `{action}`")

    else:
        _interaction_respond(interaction_id, interaction_token, f"Unknown button: `{custom_id}`")


# ── Message handler ───────────────────────────────────────────────────────────

def handle_dispatch(event: str, data: dict, token: str) -> None:
    """Route MESSAGE_CREATE and INTERACTION_CREATE events."""
    if event == "INTERACTION_CREATE":
        handle_interaction(data, token)
        return

    if event != "MESSAGE_CREATE":
        return

    if not ALLOWED_CHANNEL:
        return  # no system-status channel configured

    channel_id = data.get("channel_id")
    if channel_id != ALLOWED_CHANNEL:
        return

    # Ignore bot messages
    author = data.get("author", {})
    if author.get("bot"):
        return

    content = data.get("content", "").strip()
    if not content.startswith("!"):
        return

    parts = content.split(None, 1)
    cmd = parts[0].lower()
    args = parts[1] if len(parts) > 1 else ""

    # Lazy import to avoid circular deps
    from commands import COMMAND_REGISTRY

    handler = COMMAND_REGISTRY.get(cmd)
    if not handler:
        return

    # Check command permissions (re-read on every command so config changes apply immediately)
    perms = _load_command_permissions()
    cmd_key = cmd.lstrip("!")
    if perms and not perms.get(cmd_key, True):
        discord_post(channel_id, f"`{cmd}` is disabled by admin. Enable it in Deck Config > Ops Bot Commands.", token)
        return

    uname = author.get("username", "?")
    user_id = author.get("id", "")

    # Role-based auth for destructive commands
    ADMIN_COMMANDS = {"!restart-all", "!revert-config", "!openclaw-gw", "!nextjs", "!ops-bot", "!budget-override"}
    if ADMIN_ROLE_ID and cmd in ADMIN_COMMANDS:
        member_roles = data.get("member", {}).get("roles", [])
        if ADMIN_ROLE_ID not in member_roles:
            discord_post(channel_id, f"\u26d4 `{cmd}` requires admin role. Contact your server admin.", token)
            _log_system_event("command-denied", f"{uname} denied {cmd} (missing admin role)",
                {"command": cmd, "user": uname, "user_id": user_id}, status="warning")
            return

    print(f"[ops-bot] Command: {cmd} (from {uname})")
    _log_system_event("command", f"{uname} ran {cmd} {args}".strip(),
        {"command": cmd, "args": args, "user": uname, "user_id": user_id})

    # Commands that take a while — send immediate acknowledgement
    SLOW_COMMANDS = {"!doctor", "!restart-all", "!revert-config"}

    # Run in thread to avoid blocking the gateway read loop
    def _exec():
        if cmd in SLOW_COMMANDS:
            discord_post(channel_id, f"\u23f3 Running `{cmd}`...", token)
        try:
            response = handler(args)
            _log_system_event("command-result", f"{cmd} {args} completed".strip(),
                {"command": cmd, "args": args, "user": uname})
        except Exception as exc:
            response = f"Error executing `{cmd}`: {exc}"
            _log_system_event("command-result", f"{cmd} {args} failed: {exc}".strip(),
                {"command": cmd, "args": args, "error": str(exc)}, status="error")
        discord_post(channel_id, response, token)

    threading.Thread(target=_exec, daemon=True).start()


# ── Main ──────────────────────────────────────────────────────────────────────

def main() -> None:
    env = _load_env()
    token = env.get("DISCORD_BOT_TOKEN_DECK", "")
    if not token:
        print("[ops-bot] DISCORD_BOT_TOKEN_DECK not found in ~/.openclaw/.env", file=sys.stderr)
        sys.exit(1)

    once = "--once" in sys.argv

    # Graceful shutdown
    def _sigterm(sig, frame):
        print("[ops-bot] Received SIGTERM, shutting down...")
        sys.exit(0)
    signal.signal(signal.SIGTERM, _sigterm)

    gw = DiscordGateway(token)
    backoff = 1
    while True:
        try:
            should_resume = gw._should_resume and gw.session_id is not None
            if should_resume:
                print(f"[ops-bot] Resuming session {gw.session_id} (seq {gw.sequence})...")
            else:
                print(f"[ops-bot] Connecting to Discord Gateway...")
            gw.connect(resume=should_resume)
            backoff = 1  # Reset on successful connect
            gw.run(lambda event, data: handle_dispatch(event, data, token))

            if once:
                print("[ops-bot] --once mode, exiting.")
                break

        except KeyboardInterrupt:
            print("[ops-bot] Interrupted, exiting.")
            break
        except Exception as exc:
            print(f"[ops-bot] Error: {exc}. Reconnecting in {backoff}s...", file=sys.stderr)
            # On unexpected errors, reset resume state
            gw._should_resume = False

        if once:
            break

        time.sleep(backoff)
        backoff = min(backoff * 2, 60)


if __name__ == "__main__":
    main()
