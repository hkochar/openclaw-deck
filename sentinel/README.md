# 🛡️ Sentinel — Self-Healing System Monitor

Sentinel is a lightweight Python health-monitoring loop that detects problems in the OpenClaw stack and raises structured incidents.

**Python 3.10+ only. Zero external dependencies (stdlib only).**

---

## ⚠️ CRITICAL WARNING — READ BEFORE CONTINUING

```
╔══════════════════════════════════════════════════════════════════╗
║  DO NOT ENABLE CRON FOR THIS SCRIPT WITHOUT OPERATOR APPROVAL.  ║
║                                                                  ║
║  Sentinel is code-complete and ready to run MANUALLY.            ║
║  Scheduling it as a cron job requires an explicit sign-off       ║
║  from the operator before any cron entry is created.             ║
╚══════════════════════════════════════════════════════════════════╝
```

Running Sentinel manually is fine. Adding it to crontab is **not permitted** without approval.

---

## Files

```
sentinel/
├── sentinel_loop.py          # Main check runner
├── notifier.py               # Incident notification formatter
├── deck-sentinel.example.json  # Template config (copy → deck-sentinel.json)
├── incident_template.md      # Structured incident report template
├── sentinel_runs.jsonl       # Auto-created; one JSON record per incident
└── README.md                 # This file
```

---

## Quick Start

```bash
# 1. Copy example config
cp sentinel/deck-sentinel.example.json sentinel/deck-sentinel.json

# 2. Edit deck-sentinel.json with your paths / URLs

# 3. Dry-run (no writes, no HTTP calls)
python3 sentinel/sentinel_loop.py --config sentinel/deck-sentinel.json --dry-run

# 4. Run once (checks all enabled monitors, exits)
python3 sentinel/sentinel_loop.py --config sentinel/deck-sentinel.json --once

# 5. Run in loop (5-minute default interval; Ctrl-C to stop)
python3 sentinel/sentinel_loop.py --config sentinel/deck-sentinel.json
```

---

## Checks

### 1. 🔧 Cron Health (`cron_health`)

**What it checks:** Reads `cron_status_file` (a JSON file your cron jobs write after each run) and flags any job where `consecutive_errors` exceeds `cron_consecutive_error_threshold` (default: 3).

**Expected input file format (`cron_status.json`):**
```json
{
  "jobs": [
    {
      "name": "forge-cron",
      "consecutive_errors": 0,
      "last_run": "2026-02-18T10:00:00Z",
      "last_error": null
    }
  ]
}
```

**Config keys:**
| Key | Default | Description |
|-----|---------|-------------|
| `cron_status_file` | *(required)* | Path to the cron status JSON |
| `cron_consecutive_error_threshold` | `3` | Errors before incident fires |

---

### 2. 📝 WORKING.md Freshness (`working_md`)

**What it checks:** Verifies that `memory/WORKING.md` has been modified within the last N hours. A stale WORKING.md may indicate the active agent has crashed or stalled.

**Config keys:**
| Key | Default | Description |
|-----|---------|-------------|
| `working_md_path` | `memory/WORKING.md` | Path to WORKING.md |
| `working_md_max_age_hours` | `4.0` | Max allowed age in hours |

---

### 3. 🔒 Security Audit (`security_audit`)

**What it checks:** Currently implements a basic world-writable file scan across `security_scan_paths`. Additional checks (credential scanning via gitleaks/trufflehog, permission audits) are stubbed and will be added when approved.

**Config keys:**
| Key | Default | Description |
|-----|---------|-------------|
| `security_scan_paths` | `[]` | List of directory paths to scan |

---

## Incident IDs

Every detected problem gets a unique incident ID:

```
INC-20260218-143022-A3F1
    ^^^^^^^^ ^^^^^^ ^^^^
    date     time   4 random hex chars
```

Incidents are appended to `sentinel_runs.jsonl`:
```json
{"run_timestamp": "2026-02-18T14:30:22+00:00", "incident_id": "INC-20260218-143022-A3F1", "check": "working_md_freshness", "severity": "medium", "message": "WORKING.md is stale: last modified 5.2h ago (threshold: 4.0h).", "details": {"age_hours": 5.2}}
```

---

## Severity Levels

| Level | Colour | Meaning |
|-------|--------|---------|
| `critical` | 🔴 Bold Red | Immediate action required |
| `high` | 🔴 Red | Urgent — address within 1 hour |
| `medium` | 🟡 Yellow | Address within 4 hours |
| `low` | 🔵 Cyan | Monitor; non-urgent |
| `info` | ⚪ White | Informational only |

---

## Configuration Reference

See `deck-sentinel.example.json` for a fully-annotated template.

### Enabling / Disabling Individual Checks

```json
{
  "checks": {
    "cron_health":      { "enabled": true },
    "working_md":       { "enabled": true },
    "security_audit":   { "enabled": true }
  }
}
```

---

## Filing an Incident Report

When Sentinel raises an incident that needs manual tracking, use `incident_template.md`:

```bash
cp sentinel/incident_template.md incidents/INC-20260218-143022-A3F1.md
# Fill in the template fields
```

---

## Architecture

```
sentinel_loop.py
    │
    ├── check_cron_health()        → reads cron_status.json
    ├── check_working_md()         → checks file mtime
    └── check_security_audit()     → filesystem scan (stub)
            │
            └── notifier.notify()  → formats + prints alert
                                   → appends to sentinel_runs.jsonl
```

---

## Approval Required Before Cron Scheduling

> **⚠️ This bears repeating:** Sentinel must **not** be added to any cron schedule
> (system crontab, user crontab, launchd plist, or any other scheduler) without
> **explicit written approval from the system operator.**
>
> Manual one-shot runs (`--once`) and loop runs started interactively are fine.
> Automated scheduling is a different matter — it requires the operator to review the
> check logic, thresholds, and notification channels before enabling.

To request approval, ask the operator in `#tasks` or the relevant task channel.

---

*Sentinel — Self-Healing Monitor | Python 3.10+ | stdlib only | feature/sentinel*
