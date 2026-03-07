"""
Tests for ops-bot commands — stdlib unittest only.

Run: python3 -m unittest test_commands -v
"""

from __future__ import annotations

import unittest
from unittest.mock import patch, MagicMock

import commands


class TestCmdHelp(unittest.TestCase):
    def test_returns_dict_with_components(self):
        result = commands.cmd_help("")
        self.assertIsInstance(result, dict)
        self.assertIn("content", result)
        self.assertIn("components", result)

    def test_has_button_rows(self):
        result = commands.cmd_help("")
        components = result["components"]
        self.assertEqual(len(components), 2)  # 2 ActionRows
        for row in components:
            self.assertEqual(row["type"], 1)  # ActionRow type
            for button in row["components"]:
                self.assertEqual(button["type"], 2)  # Button type
                self.assertIn("custom_id", button)
                self.assertTrue(button["custom_id"].startswith("cmd:"))

    def test_all_commands_in_buttons(self):
        result = commands.cmd_help("")
        custom_ids = []
        for row in result["components"]:
            for btn in row["components"]:
                custom_ids.append(btn["custom_id"])
        # Check key commands are present
        cmds = [cid.split("cmd:")[1].split()[0] for cid in custom_ids]
        self.assertIn("!status", cmds)
        self.assertIn("!doctor", cmds)
        self.assertIn("!restart-all", cmds)
        self.assertIn("!revert-config", cmds)


class TestCmdGateway(unittest.TestCase):
    def test_invalid_action(self):
        result = commands.cmd_gateway("invalid")
        self.assertIn("Usage", result)

    def test_empty_action(self):
        result = commands.cmd_gateway("")
        self.assertIn("Usage", result)

    @patch("commands._run")
    def test_start(self, mock_run):
        mock_run.return_value = "Gateway started"
        result = commands.cmd_gateway("start")
        self.assertIn("gateway start", result)
        mock_run.assert_called_once()

    @patch("commands._run")
    def test_stop(self, mock_run):
        mock_run.return_value = "Gateway stopped"
        result = commands.cmd_gateway("stop")
        self.assertIn("gateway stop", result)

    @patch("commands._run")
    def test_restart(self, mock_run):
        mock_run.return_value = "Gateway restarted"
        result = commands.cmd_gateway("restart")
        self.assertIn("gateway restart", result)


class TestCmdNextjs(unittest.TestCase):
    def test_invalid_action(self):
        result = commands.cmd_nextjs("invalid")
        self.assertIn("Usage", result)

    def test_empty_action(self):
        result = commands.cmd_nextjs("")
        self.assertIn("Usage", result)

    @patch("commands._run")
    def test_status(self, mock_run):
        mock_run.return_value = "PID\tStatus\tLabel\n89071\t0\tai.openclaw.deck"
        result = commands.cmd_nextjs("status")
        self.assertIn("nextjs status", result)
        mock_run.assert_called_once_with(["launchctl", "list", "ai.openclaw.deck"], timeout=5)

    @patch("commands._run")
    def test_start(self, mock_run):
        mock_run.return_value = ""
        result = commands.cmd_nextjs("start")
        self.assertIn("nextjs start", result)
        self.assertIn("(started)", result)

    @patch("commands._run")
    def test_stop(self, mock_run):
        mock_run.return_value = ""
        result = commands.cmd_nextjs("stop")
        self.assertIn("nextjs stop", result)
        self.assertIn("(stopped)", result)

    @patch("commands.time.sleep")
    @patch("commands._run")
    def test_restart(self, mock_run, mock_sleep):
        mock_run.return_value = ""
        result = commands.cmd_nextjs("restart")
        self.assertIn("nextjs restart", result)
        self.assertEqual(mock_run.call_count, 2)
        mock_sleep.assert_called_once_with(3)

    @patch("commands._run")
    def test_logs(self, mock_run):
        mock_run.return_value = "ready on http://localhost:3000"
        result = commands.cmd_nextjs("logs")
        self.assertIn("nextjs logs", result)


class TestCmdOpsbot(unittest.TestCase):
    def test_invalid_action(self):
        result = commands.cmd_opsbot("invalid")
        self.assertIn("Usage", result)

    def test_empty_action(self):
        result = commands.cmd_opsbot("")
        self.assertIn("Usage", result)

    @patch("commands._run")
    def test_status(self, mock_run):
        mock_run.return_value = "PID\tStatus\tLabel\n5536\t0\tai.openclaw.ops-bot"
        result = commands.cmd_opsbot("status")
        self.assertIn("ops-bot status", result)
        mock_run.assert_called_once_with(["launchctl", "list", "ai.openclaw.ops-bot"], timeout=5)

    @patch("commands.threading.Thread")
    def test_restart_schedules_exit(self, mock_thread):
        mock_instance = MagicMock()
        mock_thread.return_value = mock_instance
        result = commands.cmd_opsbot("restart")
        self.assertIn("ops-bot restarting", result)
        mock_instance.start.assert_called_once()

    @patch("commands._run")
    def test_logs(self, mock_run):
        mock_run.return_value = "[ops-bot] Connected"
        result = commands.cmd_opsbot("logs")
        self.assertIn("ops-bot logs", result)


class TestCmdRestartAll(unittest.TestCase):
    @patch("commands.threading.Thread")
    @patch("commands._run")
    def test_restarts_all_services(self, mock_run, mock_thread):
        mock_run.return_value = ""
        mock_instance = MagicMock()
        mock_thread.return_value = mock_instance
        result = commands.cmd_restart_all("")
        self.assertIn("Restarting all Deck", result)
        self.assertIn("openclaw-deck: restarted", result)
        self.assertIn("sentinel: restarted", result)
        self.assertIn("ops-bot: restarting", result)
        # 2 services × 2 calls (stop + start) = 4
        self.assertEqual(mock_run.call_count, 4)
        mock_instance.start.assert_called_once()


class TestCommandRegistry(unittest.TestCase):
    def test_all_commands_registered(self):
        expected = {"!doctor", "!status", "!openclaw-gw", "!nextjs", "!ops-bot", "!restart-all", "!revert-config", "!help"}
        self.assertEqual(set(commands.COMMAND_REGISTRY.keys()), expected)

    def test_registry_values_are_callable(self):
        for name, handler in commands.COMMAND_REGISTRY.items():
            self.assertTrue(callable(handler), f"{name} handler is not callable")


class TestRun(unittest.TestCase):
    @patch("commands.subprocess.run")
    def test_truncation(self, mock_run):
        mock_result = MagicMock()
        mock_result.stdout = "x" * 2000
        mock_result.stderr = ""
        mock_run.return_value = mock_result
        result = commands._run(["echo", "test"])
        self.assertIn("(truncated)", result)

    @patch("commands.subprocess.run")
    def test_timeout(self, mock_run):
        import subprocess
        mock_run.side_effect = subprocess.TimeoutExpired(cmd=["test"], timeout=30)
        result = commands._run(["test"], timeout=30)
        self.assertIn("timed out", result)

    @patch("commands.subprocess.run")
    def test_command_not_found(self, mock_run):
        mock_run.side_effect = FileNotFoundError()
        result = commands._run(["nonexistent"])
        self.assertIn("not found", result)


if __name__ == "__main__":
    unittest.main()
