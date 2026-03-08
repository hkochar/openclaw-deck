"""
Tests for sentinel_loop.py — stdlib unittest only.

Run: python3 -m unittest test_sentinel -v
"""

from __future__ import annotations

import json
import os
import re
import tempfile
import time
import unittest
from pathlib import Path
from unittest.mock import patch, MagicMock

# Import the module under test
import sentinel_loop


class TestExpand(unittest.TestCase):
    def test_tilde_expansion(self):
        result = sentinel_loop._expand("~/foo")
        self.assertEqual(result, os.path.expanduser("~/foo"))

    def test_env_var_expansion(self):
        with patch.dict(os.environ, {"MY_VAR": "/custom/path"}):
            result = sentinel_loop._expand("$MY_VAR/bar")
            self.assertEqual(result, "/custom/path/bar")


class TestMakeIncidentId(unittest.TestCase):
    def test_format(self):
        inc_id = sentinel_loop._make_incident_id()
        # Format: INC-YYYYMMDD-HHMMSS-XXXX
        self.assertTrue(inc_id.startswith("INC-"))
        parts = inc_id.split("-")
        self.assertEqual(len(parts), 4)
        self.assertEqual(len(parts[3]), 4)  # 4 hex chars

    def test_uniqueness(self):
        ids = {sentinel_loop._make_incident_id() for _ in range(10)}
        # Random component should make them unique
        self.assertGreater(len(ids), 1)


class TestCheckCronHealth(unittest.TestCase):
    def test_no_status_file_configured(self):
        incidents = sentinel_loop.check_cron_health({}, dry_run=False)
        self.assertEqual(incidents, [])

    def test_missing_file(self):
        cfg = {"cron_status_file": "/nonexistent/path/status.json"}
        incidents = sentinel_loop.check_cron_health(cfg, dry_run=False)
        self.assertEqual(incidents, [])

    def test_invalid_json(self):
        with tempfile.NamedTemporaryFile(mode="w", suffix=".json", delete=False) as f:
            f.write("{not valid json}")
            f.flush()
            try:
                cfg = {"cron_status_file": f.name}
                incidents = sentinel_loop.check_cron_health(cfg, dry_run=False)
                self.assertEqual(len(incidents), 1)
                self.assertEqual(incidents[0]["severity"], "medium")
            finally:
                os.unlink(f.name)

    def test_all_jobs_under_threshold(self):
        data = {"jobs": [
            {"name": "job1", "consecutive_errors": 0},
            {"name": "job2", "consecutive_errors": 2},
        ]}
        with tempfile.NamedTemporaryFile(mode="w", suffix=".json", delete=False) as f:
            json.dump(data, f)
            f.flush()
            try:
                cfg = {"cron_status_file": f.name, "cron_consecutive_error_threshold": 3}
                incidents = sentinel_loop.check_cron_health(cfg, dry_run=False)
                self.assertEqual(incidents, [])
            finally:
                os.unlink(f.name)

    def test_job_over_threshold(self):
        data = {"jobs": [
            {"name": "failing-job", "consecutive_errors": 5, "last_run": "2026-01-01T00:00:00Z"},
        ]}
        with tempfile.NamedTemporaryFile(mode="w", suffix=".json", delete=False) as f:
            json.dump(data, f)
            f.flush()
            try:
                cfg = {"cron_status_file": f.name, "cron_consecutive_error_threshold": 3}
                incidents = sentinel_loop.check_cron_health(cfg, dry_run=False)
                self.assertEqual(len(incidents), 1)
                self.assertEqual(incidents[0]["severity"], "high")
                self.assertIn("failing-job", incidents[0]["message"])
            finally:
                os.unlink(f.name)

    def test_exactly_at_threshold_no_incident(self):
        """consecutive_errors == threshold should NOT trigger (uses > not >=)."""
        data = {"jobs": [{"name": "edge", "consecutive_errors": 3}]}
        with tempfile.NamedTemporaryFile(mode="w", suffix=".json", delete=False) as f:
            json.dump(data, f)
            f.flush()
            try:
                cfg = {"cron_status_file": f.name, "cron_consecutive_error_threshold": 3}
                incidents = sentinel_loop.check_cron_health(cfg, dry_run=False)
                self.assertEqual(incidents, [])
            finally:
                os.unlink(f.name)


class TestCheckWorkingMd(unittest.TestCase):
    def test_fresh_file(self):
        with tempfile.NamedTemporaryFile(mode="w", suffix=".md", delete=False) as f:
            f.write("# Working\n")
            f.flush()
            try:
                cfg = {"working_md_path": f.name, "working_md_max_age_hours": 4.0}
                incidents = sentinel_loop.check_working_md(cfg, dry_run=False)
                self.assertEqual(incidents, [])
            finally:
                os.unlink(f.name)

    def test_missing_file(self):
        cfg = {"working_md_path": "/nonexistent/WORKING.md"}
        incidents = sentinel_loop.check_working_md(cfg, dry_run=False)
        self.assertEqual(len(incidents), 1)
        self.assertIn("not found", incidents[0]["message"])

    def test_stale_file(self):
        with tempfile.NamedTemporaryFile(mode="w", suffix=".md", delete=False) as f:
            f.write("# Working\n")
            f.flush()
            # Set mtime to 10 hours ago
            old_time = time.time() - (10 * 3600)
            os.utime(f.name, (old_time, old_time))
            try:
                cfg = {"working_md_path": f.name, "working_md_max_age_hours": 4.0}
                incidents = sentinel_loop.check_working_md(cfg, dry_run=False)
                self.assertEqual(len(incidents), 1)
                self.assertIn("stale", incidents[0]["message"])
            finally:
                os.unlink(f.name)


class TestCheckGatewayHealth(unittest.TestCase):
    def test_dry_run_skips(self):
        cfg = {"gateway_url": "http://localhost:18789"}
        incidents = sentinel_loop.check_gateway_health(cfg, dry_run=True)
        self.assertEqual(incidents, [])

    @patch("sentinel_loop.urllib.request.urlopen")
    def test_gateway_up(self, mock_urlopen):
        mock_resp = MagicMock()
        mock_resp.status = 200
        mock_resp.__enter__ = lambda s: mock_resp
        mock_resp.__exit__ = MagicMock(return_value=False)
        mock_urlopen.return_value = mock_resp

        cfg = {"gateway_url": "http://localhost:18789"}
        incidents = sentinel_loop.check_gateway_health(cfg, dry_run=False)
        self.assertEqual(incidents, [])

    @patch("sentinel_loop.urllib.request.urlopen")
    def test_gateway_down_config_valid(self, mock_urlopen):
        import urllib.error
        mock_urlopen.side_effect = urllib.error.URLError("Connection refused")

        with tempfile.NamedTemporaryFile(mode="w", suffix=".json", delete=False) as f:
            json.dump({"agents": {"list": []}}, f)
            f.flush()
            try:
                cfg = {
                    "gateway_url": "http://localhost:18789",
                    "openclaw_config_path": f.name,
                }
                incidents = sentinel_loop.check_gateway_health(cfg, dry_run=False)
                self.assertEqual(len(incidents), 1)
                self.assertEqual(incidents[0]["severity"], "high")
            finally:
                os.unlink(f.name)

    @patch("sentinel_loop.urllib.request.urlopen")
    def test_gateway_down_config_corrupt(self, mock_urlopen):
        import urllib.error
        mock_urlopen.side_effect = urllib.error.URLError("Connection refused")

        with tempfile.NamedTemporaryFile(mode="w", suffix=".json", delete=False) as f:
            f.write("{invalid json!!}")
            f.flush()
            try:
                cfg = {
                    "gateway_url": "http://localhost:18789",
                    "openclaw_config_path": f.name,
                }
                incidents = sentinel_loop.check_gateway_health(cfg, dry_run=False)
                self.assertEqual(len(incidents), 1)
                self.assertEqual(incidents[0]["severity"], "critical")
                self.assertIn("corrupt", incidents[0]["message"])
            finally:
                os.unlink(f.name)


class TestCheckGhostCrons(unittest.TestCase):
    def test_dry_run_returns_empty(self):
        cfg = {"gateway_url": "http://localhost:18789"}
        # Need a token for the function to proceed before dry_run check
        with patch.object(sentinel_loop, "_load_openclaw_env", return_value={"OPENCLAW_GATEWAY_TOKEN": "test"}):
            incidents = sentinel_loop.check_ghost_crons(cfg, dry_run=True)
        self.assertEqual(incidents, [])

    def test_no_token_returns_empty(self):
        cfg = {"gateway_url": "http://localhost:18789"}
        with patch.object(sentinel_loop, "_load_openclaw_env", return_value={}):
            incidents = sentinel_loop.check_ghost_crons(cfg, dry_run=False)
        self.assertEqual(incidents, [])


class TestCheckDashboardHealth(unittest.TestCase):
    def test_dry_run_skips(self):
        cfg = {"checks": {"dashboard_health": {"url": "http://localhost:3000"}}}
        incidents = sentinel_loop.check_dashboard_health(cfg, dry_run=True)
        self.assertEqual(incidents, [])

    @patch("sentinel_loop.urllib.request.urlopen")
    def test_dashboard_up(self, mock_urlopen):
        mock_resp = MagicMock()
        mock_resp.status = 200
        mock_resp.__enter__ = lambda s: mock_resp
        mock_resp.__exit__ = MagicMock(return_value=False)
        mock_urlopen.return_value = mock_resp

        cfg = {"checks": {"dashboard_health": {"url": "http://localhost:3000"}}}
        incidents = sentinel_loop.check_dashboard_health(cfg, dry_run=False)
        self.assertEqual(incidents, [])

    @patch("sentinel_loop.urllib.request.urlopen")
    def test_dashboard_down(self, mock_urlopen):
        import urllib.error
        mock_urlopen.side_effect = urllib.error.URLError("Connection refused")

        cfg = {"checks": {"dashboard_health": {"url": "http://localhost:3000"}}}
        incidents = sentinel_loop.check_dashboard_health(cfg, dry_run=False)
        self.assertEqual(len(incidents), 1)
        self.assertEqual(incidents[0]["severity"], "high")
        self.assertIn("unreachable", incidents[0]["message"])

    @patch("sentinel_loop.urllib.request.urlopen")
    def test_dashboard_500(self, mock_urlopen):
        import urllib.error
        mock_urlopen.side_effect = urllib.error.HTTPError(
            "http://localhost:3000", 500, "Internal Server Error", {}, None
        )

        cfg = {"checks": {"dashboard_health": {"url": "http://localhost:3000"}}}
        incidents = sentinel_loop.check_dashboard_health(cfg, dry_run=False)
        self.assertEqual(len(incidents), 1)
        self.assertIn("500", incidents[0]["message"])


class TestCheckPortConflicts(unittest.TestCase):
    def test_dry_run_skips(self):
        cfg = {"checks": {"port_conflicts": {"ports": [3000]}}}
        incidents = sentinel_loop.check_port_conflicts(cfg, dry_run=True)
        self.assertEqual(incidents, [])

    @patch("sentinel_loop.subprocess.run")
    def test_no_conflict_single_listener(self, mock_run):
        mock_result = MagicMock()
        mock_result.stdout = "12345\n"
        mock_result.stderr = ""
        mock_run.return_value = mock_result

        cfg = {"checks": {"port_conflicts": {"ports": [3000]}}}
        incidents = sentinel_loop.check_port_conflicts(cfg, dry_run=False)
        self.assertEqual(incidents, [])

    @patch("sentinel_loop.os.kill")
    @patch("sentinel_loop.subprocess.run")
    def test_conflict_auto_kills_stale(self, mock_run, mock_kill):
        """When launchd PID is known, kill the other listeners."""
        def side_effect(cmd, **kwargs):
            result = MagicMock()
            if cmd[0] == "lsof":
                result.stdout = "12345\n67890\n"
                result.stderr = ""
            elif cmd[0] == "launchctl":
                result.returncode = 0
                result.stdout = "12345\t0\tai.openclaw.deck"
            elif cmd[0] == "ps":
                result.stdout = "67890  1  11:00PM next-server"
                result.stderr = ""
            return result
        mock_run.side_effect = side_effect

        cfg = {"checks": {"port_conflicts": {"ports": [3000], "auto_kill": True}}}
        incidents = sentinel_loop.check_port_conflicts(cfg, dry_run=False)
        self.assertEqual(len(incidents), 1)
        self.assertIn("killed", incidents[0]["message"])
        self.assertIn("67890", incidents[0]["message"])
        mock_kill.assert_called_once_with(67890, 15)

    @patch("sentinel_loop.subprocess.run")
    def test_conflict_no_launchd_no_kill(self, mock_run):
        """When launchd PID is unknown, report but don't kill."""
        def side_effect(cmd, **kwargs):
            result = MagicMock()
            if cmd[0] == "lsof":
                result.stdout = "12345\n67890\n"
                result.stderr = ""
            elif cmd[0] == "launchctl":
                result.returncode = 113  # not found
                result.stdout = ""
                result.stderr = "Could not find service"
            elif cmd[0] == "ps":
                result.stdout = "12345  1  11:00PM next-server"
                result.stderr = ""
            return result
        mock_run.side_effect = side_effect

        cfg = {"checks": {"port_conflicts": {"ports": [3000], "auto_kill": True}}}
        incidents = sentinel_loop.check_port_conflicts(cfg, dry_run=False)
        self.assertEqual(len(incidents), 1)
        self.assertIn("manual intervention", incidents[0]["message"])

    @patch("sentinel_loop.subprocess.run")
    def test_no_listeners(self, mock_run):
        mock_result = MagicMock()
        mock_result.stdout = ""
        mock_result.stderr = ""
        mock_run.return_value = mock_result

        cfg = {"checks": {"port_conflicts": {"ports": [3000]}}}
        incidents = sentinel_loop.check_port_conflicts(cfg, dry_run=False)
        self.assertEqual(incidents, [])


# ── Notifier tests ──────────────────────────────────────────────────────────

import notifier


class TestNotifier(unittest.TestCase):
    @patch("notifier._send_discord")
    @patch("notifier._log_to_mc_system_db")
    def test_critical_sends_discord(self, mock_db, mock_discord):
        notifier.notify("INC-TEST-001", "critical", "test message")
        mock_discord.assert_called_once()
        mock_db.assert_called_once()
        # DB should get status="error" for critical
        self.assertEqual(mock_db.call_args[1].get("status", mock_db.call_args[0][4] if len(mock_db.call_args[0]) > 4 else None), "error")

    @patch("notifier._send_discord")
    @patch("notifier._log_to_mc_system_db")
    def test_high_sends_discord(self, mock_db, mock_discord):
        notifier.notify("INC-TEST-002", "high", "high sev")
        mock_discord.assert_called_once()

    @patch("notifier._send_discord")
    @patch("notifier._log_to_mc_system_db")
    def test_medium_sends_discord(self, mock_db, mock_discord):
        notifier.notify("INC-TEST-003", "medium", "medium sev")
        mock_discord.assert_called_once()

    @patch("notifier._send_discord")
    @patch("notifier._log_to_mc_system_db")
    def test_low_skips_discord(self, mock_db, mock_discord):
        notifier.notify("INC-TEST-004", "low", "low sev")
        mock_discord.assert_not_called()
        mock_db.assert_called_once()

    @patch("notifier._send_discord")
    @patch("notifier._log_to_mc_system_db")
    def test_info_skips_discord(self, mock_db, mock_discord):
        notifier.notify("INC-TEST-005", "info", "info sev")
        mock_discord.assert_not_called()
        mock_db.assert_called_once()

    @patch("notifier._send_discord")
    @patch("notifier._log_to_mc_system_db")
    def test_details_passed_to_db(self, mock_db, mock_discord):
        notifier.notify("INC-TEST-006", "high", "msg", details={"key": "val"})
        # _log_to_mc_system_db called with detail={"key": "val"}
        call_args = mock_db.call_args
        self.assertEqual(call_args[1].get("detail", call_args[0][3] if len(call_args[0]) > 3 else None), {"key": "val"})

    def test_log_to_mc_system_db_creates_row(self):
        """Test that _log_to_mc_system_db writes a row to SQLite."""
        import sqlite3 as _sqlite3
        with tempfile.NamedTemporaryFile(suffix=".db", delete=False) as f:
            db_path = f.name
        try:
            conn = _sqlite3.connect(db_path)
            conn.execute(
                "CREATE TABLE system_log (ts INTEGER, category TEXT, action TEXT, "
                "summary TEXT, detail TEXT, status TEXT)"
            )
            conn.commit()
            conn.close()
            with patch.dict(os.environ, {"HOME": "/tmp/_sentinel_test_home"}):
                # Override the db path by patching
                with patch("notifier.Path") as MockPath:
                    # Make the path chain resolve to our temp db
                    mock_path_inst = MagicMock()
                    MockPath.return_value.__truediv__ = lambda *a: mock_path_inst
                    # Actually just patch sqlite3.connect in notifier
                    pass
            # Simpler approach: call with mocked path
            original_fn = notifier._log_to_mc_system_db
            with patch("notifier.sqlite3.connect") as mock_connect:
                mock_conn = MagicMock()
                mock_connect.return_value = mock_conn
                notifier._log_to_mc_system_db("sentinel", "test_action", "test summary", {"k": "v"}, "ok")
                mock_conn.execute.assert_called_once()
                args = mock_conn.execute.call_args[0]
                self.assertIn("INSERT INTO system_log", args[0])
                self.assertEqual(args[1][1], "sentinel")  # category
                self.assertEqual(args[1][2], "test_action")  # action
                mock_conn.commit.assert_called_once()
        finally:
            os.unlink(db_path)

    def test_db_error_swallowed(self):
        """_log_to_mc_system_db swallows exceptions silently."""
        with patch("notifier.sqlite3.connect", side_effect=Exception("db exploded")):
            # Should not raise
            notifier._log_to_mc_system_db("sentinel", "test", "summary")





# ── Security audit tests ────────────────────────────────────────────────────

class TestCheckSecurityAudit(unittest.TestCase):
    def test_clean_scan(self):
        import tempfile as _tf
        with _tf.TemporaryDirectory() as tmpdir:
            # Create a normal file (not world-writable)
            normal = Path(tmpdir) / "normal.txt"
            normal.write_text("safe content")
            cfg = {"security_scan_paths": [tmpdir]}
            incidents = sentinel_loop.check_security_audit(cfg, dry_run=False)
            self.assertEqual(incidents, [])

    def test_world_writable_detected(self):
        import tempfile as _tf
        with _tf.TemporaryDirectory() as tmpdir:
            vuln = Path(tmpdir) / "writable.txt"
            vuln.write_text("oops")
            os.chmod(str(vuln), 0o777)
            cfg = {"security_scan_paths": [tmpdir]}
            incidents = sentinel_loop.check_security_audit(cfg, dry_run=False)
            self.assertEqual(len(incidents), 1)
            self.assertEqual(incidents[0]["severity"], "medium")
            self.assertIn("World-writable", incidents[0]["message"])


# ── Ghost crons (extended) ──────────────────────────────────────────────────

class TestCheckGhostCronsExtended(unittest.TestCase):
    def test_ghost_sessions_detected(self):
        """Sessions with cron IDs not in registered set are flagged."""
        cfg = {"gateway_url": "http://localhost:18789", "ghost_cron_max_age_hours": 24}
        now_ms = int(time.time() * 1000)
        ghost_sessions = [
            {"session_key": "agent:main:cron:job-deleted", "agent": "scout",
             "job_id": "job-deleted", "updated_ms": now_ms},
        ]
        with patch.object(sentinel_loop, "_load_openclaw_env",
                          return_value={"OPENCLAW_GATEWAY_TOKEN": "tok"}):
            with patch.object(sentinel_loop, "_get_registered_cron_ids",
                              return_value=set()):
                with patch.object(sentinel_loop, "_find_cron_sessions",
                                  return_value=ghost_sessions):
                    incidents = sentinel_loop.check_ghost_crons(cfg, dry_run=False)
        self.assertEqual(len(incidents), 1)
        self.assertEqual(incidents[0]["severity"], "high")
        self.assertIn("ghost", incidents[0]["message"])
        self.assertIn("scout", incidents[0]["message"])

    def test_no_ghost_sessions(self):
        """All cron sessions are registered — no incidents."""
        cfg = {"gateway_url": "http://localhost:18789"}
        now_ms = int(time.time() * 1000)
        sessions = [
            {"session_key": "agent:main:cron:job-active", "agent": "forge",
             "job_id": "job-active", "updated_ms": now_ms},
        ]
        with patch.object(sentinel_loop, "_load_openclaw_env",
                          return_value={"OPENCLAW_GATEWAY_TOKEN": "tok"}):
            with patch.object(sentinel_loop, "_get_registered_cron_ids",
                              return_value={"job-active"}):
                with patch.object(sentinel_loop, "_find_cron_sessions",
                                  return_value=sessions):
                    incidents = sentinel_loop.check_ghost_crons(cfg, dry_run=False)
        self.assertEqual(incidents, [])

    def test_stale_session_ignored(self):
        """Sessions older than ghost_cron_max_age_hours are skipped."""
        cfg = {"gateway_url": "http://localhost:18789", "ghost_cron_max_age_hours": 24}
        # updated_ms is 48 hours ago
        old_ms = int((time.time() - 48 * 3600) * 1000)
        sessions = [
            {"session_key": "agent:main:cron:old-job", "agent": "forge",
             "job_id": "old-job", "updated_ms": old_ms},
        ]
        with patch.object(sentinel_loop, "_load_openclaw_env",
                          return_value={"OPENCLAW_GATEWAY_TOKEN": "tok"}):
            with patch.object(sentinel_loop, "_get_registered_cron_ids",
                              return_value=set()):
                with patch.object(sentinel_loop, "_find_cron_sessions",
                                  return_value=sessions):
                    incidents = sentinel_loop.check_ghost_crons(cfg, dry_run=False)
        self.assertEqual(incidents, [])


# ── Dashboard health (extended) ─────────────────────────────────────────────

class TestCheckDashboardHealthExtended(unittest.TestCase):
    @patch("sentinel_loop.time.sleep")
    @patch("sentinel_loop.subprocess.run")
    @patch("sentinel_loop.urllib.request.urlopen")
    def test_auto_restart_success(self, mock_urlopen, mock_run, mock_sleep):
        """Dashboard down → auto-restart → comes back → severity info."""
        import urllib.error
        call_count = [0]
        def urlopen_side_effect(req, **kwargs):
            call_count[0] += 1
            if call_count[0] == 1:
                raise urllib.error.URLError("Connection refused")
            # Second call: recovered
            mock_resp = MagicMock()
            mock_resp.status = 200
            mock_resp.__enter__ = lambda s: mock_resp
            mock_resp.__exit__ = MagicMock(return_value=False)
            return mock_resp
        mock_urlopen.side_effect = urlopen_side_effect

        # kickstart succeeds
        mock_kick = MagicMock()
        mock_kick.returncode = 0
        mock_kick.stdout = ""
        mock_kick.stderr = ""
        mock_run.return_value = mock_kick

        cfg = {"checks": {"dashboard_health": {
            "url": "http://localhost:3000", "auto_restart": True
        }}}
        with patch("sentinel_loop.Path") as MockPath:
            # .next dir doesn't exist
            mock_next = MagicMock()
            mock_next.is_dir.return_value = False
            MockPath.return_value.__truediv__ = MagicMock(return_value=mock_next)
            # Need _expand to work normally
            with patch("sentinel_loop._expand", return_value="/tmp/mc"):
                incidents = sentinel_loop.check_dashboard_health(cfg, dry_run=False)

        self.assertEqual(len(incidents), 1)
        self.assertEqual(incidents[0]["severity"], "info")
        self.assertIn("auto-restarted", incidents[0]["message"])

    @patch("sentinel_loop.time.sleep")
    @patch("sentinel_loop.subprocess.run")
    @patch("sentinel_loop.urllib.request.urlopen")
    def test_auto_restart_failure(self, mock_urlopen, mock_run, mock_sleep):
        """Dashboard down → auto-restart → still down → severity high."""
        import urllib.error
        mock_urlopen.side_effect = urllib.error.URLError("Connection refused")

        mock_kick = MagicMock()
        mock_kick.returncode = 0
        mock_kick.stdout = ""
        mock_kick.stderr = ""
        mock_run.return_value = mock_kick

        cfg = {"checks": {"dashboard_health": {
            "url": "http://localhost:3000", "auto_restart": True
        }}}
        with patch("sentinel_loop._expand", return_value="/tmp/mc"):
            with patch("sentinel_loop.Path") as MockPath:
                mock_next = MagicMock()
                mock_next.is_dir.return_value = False
                MockPath.return_value.__truediv__ = MagicMock(return_value=mock_next)
                incidents = sentinel_loop.check_dashboard_health(cfg, dry_run=False)

        self.assertEqual(len(incidents), 1)
        self.assertEqual(incidents[0]["severity"], "high")


# ── Gateway health (extended) ───────────────────────────────────────────────

class TestCheckGatewayHealthExtended(unittest.TestCase):
    @patch("sentinel_loop.urllib.request.urlopen")
    def test_http_error_counts_as_up(self, mock_urlopen):
        """HTTPError means gateway process is alive — no incident."""
        import urllib.error
        mock_urlopen.side_effect = urllib.error.HTTPError(
            "http://localhost:18789/health", 404, "Not Found", {}, None
        )
        cfg = {"gateway_url": "http://localhost:18789"}
        incidents = sentinel_loop.check_gateway_health(cfg, dry_run=False)
        self.assertEqual(incidents, [])


# ── run_once integration tests ──────────────────────────────────────────────

class TestRunOnce(unittest.TestCase):
    @patch("sentinel_loop.notify")
    def test_stale_working_md_triggers_notify(self, mock_notify):
        """Full chain: stale WORKING.md → check detects → notify called."""
        with tempfile.NamedTemporaryFile(mode="w", suffix=".md", delete=False) as f:
            f.write("# Working\n")
            f.flush()
            # Backdate 10 hours
            old_time = time.time() - (10 * 3600)
            os.utime(f.name, (old_time, old_time))
        try:
            cfg = {
                "working_md_path": f.name,
                "working_md_max_age_hours": 4.0,
                "checks": {
                    # Disable everything except working_md
                    "cron_health":       {"enabled": False},
                    "working_md":        {"enabled": True},

                    "security_audit":    {"enabled": False},
                    "ghost_crons":       {"enabled": False},

                    "port_conflicts":    {"enabled": False},
                    "dashboard_health":  {"enabled": False},
                    "gateway_health":    {"enabled": False},
                },
            }
            with tempfile.NamedTemporaryFile(suffix=".jsonl", delete=False) as rf:
                run_file = Path(rf.name)
            try:
                count = sentinel_loop.run_once(cfg, run_file, dry_run=False)
                self.assertEqual(count, 1)
                mock_notify.assert_called_once()
                call_args = mock_notify.call_args
                # notify(inc_id, severity, message, details=details)
                self.assertIn("stale", call_args[0][2])
                self.assertEqual(call_args[0][1], "medium")
            finally:
                os.unlink(run_file)
        finally:
            os.unlink(f.name)

    @patch("sentinel_loop.notify")
    def test_all_disabled_no_incidents(self, mock_notify):
        """All checks disabled → 0 incidents, notify never called."""
        cfg = {
            "checks": {name: {"enabled": False} for name, _ in sentinel_loop.CHECKS},
        }
        with tempfile.NamedTemporaryFile(suffix=".jsonl", delete=False) as rf:
            run_file = Path(rf.name)
        try:
            count = sentinel_loop.run_once(cfg, run_file, dry_run=False)
            self.assertEqual(count, 0)
            mock_notify.assert_not_called()
        finally:
            os.unlink(run_file)

    @patch("sentinel_loop.notify")
    def test_writes_jsonl(self, mock_notify):
        """run_once writes incident records to JSONL file."""
        with tempfile.NamedTemporaryFile(mode="w", suffix=".md", delete=False) as f:
            f.write("# Working\n")
            f.flush()
            # Stale file
            old_time = time.time() - (10 * 3600)
            os.utime(f.name, (old_time, old_time))
        try:
            cfg = {
                "working_md_path": f.name,
                "working_md_max_age_hours": 4.0,
                "checks": {name: {"enabled": False} for name, _ in sentinel_loop.CHECKS},
            }
            cfg["checks"]["working_md"] = {"enabled": True}

            with tempfile.NamedTemporaryFile(suffix=".jsonl", delete=False) as rf:
                run_file = Path(rf.name)
            try:
                sentinel_loop.run_once(cfg, run_file, dry_run=False)
                content = run_file.read_text()
                record = json.loads(content.strip())
                self.assertIn("incident_id", record)
                self.assertIn("INC-", record["incident_id"])
                self.assertEqual(record["severity"], "medium")
                self.assertIn("stale", record["message"])
            finally:
                os.unlink(run_file)
        finally:
            os.unlink(f.name)

    @patch("sentinel_loop.notify")
    def test_exception_in_check_becomes_medium_incident(self, mock_notify):
        """Uncaught exception in a check → medium incident, doesn't crash."""
        cfg = {
            "checks": {name: {"enabled": False} for name, _ in sentinel_loop.CHECKS},
        }
        cfg["checks"]["working_md"] = {"enabled": True}

        # Patch the CHECKS list entry directly so run_once picks up the mock
        original_checks = sentinel_loop.CHECKS[:]
        boom_fn = MagicMock(side_effect=RuntimeError("boom"))
        sentinel_loop.CHECKS = [
            (name, boom_fn if name == "working_md" else fn)
            for name, fn in original_checks
        ]
        try:
            with tempfile.NamedTemporaryFile(suffix=".jsonl", delete=False) as rf:
                run_file = Path(rf.name)
            try:
                count = sentinel_loop.run_once(cfg, run_file, dry_run=False)
                self.assertEqual(count, 1)
                mock_notify.assert_called_once()
                call_args = mock_notify.call_args
                self.assertEqual(call_args[0][1], "medium")
                self.assertIn("Unhandled exception", call_args[0][2])
                self.assertIn("boom", call_args[0][2])
            finally:
                os.unlink(run_file)
        finally:
            sentinel_loop.CHECKS = original_checks


if __name__ == "__main__":
    unittest.main()
