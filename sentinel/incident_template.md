# Incident Report

<!-- Fill in all fields. Required fields are marked ⚠️ -->

---

## Incident Metadata

| Field            | Value                          |
|------------------|-------------------------------|
| **Incident ID**  ⚠️ | `INC-YYYYMMDD-HHMMSS-XXXX`  |
| **Severity**     ⚠️ | `critical` / `high` / `medium` / `low` / `info` |
| **Status**       ⚠️ | `open` / `investigating` / `mitigated` / `resolved` |
| **Detected At**  ⚠️ | `YYYY-MM-DDTHH:MM:SSZ`        |
| **Resolved At**  | `YYYY-MM-DDTHH:MM:SSZ` (if applicable) |
| **Check Name**   ⚠️ | e.g. `cron_health`            |
| **Reported By**  | `sentinel_loop.py` / agent name |

---

## Summary ⚠️

<!-- One-sentence description of what happened. -->

> _Example: Cron job "forge-cron" failed 5 consecutive times between 02:00–03:00 UTC._

---

## Impact Assessment ⚠️

<!-- What was affected? Who noticed? Any user impact? -->

- **Affected component:** 
- **User-visible impact:** None / Minor / Major
- **Data loss risk:** Yes / No

---

## Timeline

| Time (UTC)            | Event                          |
|-----------------------|-------------------------------|
| `YYYY-MM-DDTHH:MM:SSZ` | Sentinel detected incident    |
| `YYYY-MM-DDTHH:MM:SSZ` | Notified agent / operator     |
| `YYYY-MM-DDTHH:MM:SSZ` | Investigation started         |
| `YYYY-MM-DDTHH:MM:SSZ` | Root cause identified         |
| `YYYY-MM-DDTHH:MM:SSZ` | Fix applied                   |
| `YYYY-MM-DDTHH:MM:SSZ` | Incident resolved / closed    |

---

## Root Cause ⚠️

<!-- Technical explanation of why this happened. -->

---

## Resolution Steps ⚠️

1. 
2. 
3. 

---

## Evidence

<!-- Paste relevant log lines, JSON blobs, or screenshots. -->

```
# sentinel_runs.jsonl entry:
{ "incident_id": "INC-...", "check": "...", "severity": "...", "message": "..." }
```

---

## Follow-Up Actions

| Action                         | Owner  | Due Date   | Status  |
|-------------------------------|--------|------------|---------|
|                               |        |            | open    |

---

## Lessons Learned

<!-- What would prevent this from happening again? -->

---

## Sign-Off

- **Reviewed by:** 
- **Approved by:** 
- **Date:** 
