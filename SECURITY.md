# Security Policy

## Supported Versions

| Version | Supported |
|---------|-----------|
| 0.1.x   | Yes       |

## Reporting a Vulnerability

If you discover a security vulnerability in Deck, please report it privately. **Do not open a public GitHub issue.**

**Email:** [security@openclaw.ai](mailto:security@openclaw.ai)

### What to Include

- Description of the vulnerability
- Steps to reproduce
- Affected version(s)
- Impact assessment (what an attacker could achieve)
- Any suggested fix (optional)

### Response Timeline

- **Acknowledgment:** Within 48 hours
- **Initial assessment:** Within 7 days
- **Fix or mitigation:** Within 90 days (critical issues prioritized)

We will coordinate disclosure timing with you and credit you in the advisory unless you prefer to remain anonymous.

## Scope

### In Scope

- SQL injection in API routes or database queries
- Authentication/authorization bypass
- Secret exposure (API keys, tokens leaked in logs, responses, or UI)
- Cross-site scripting (XSS) in the dashboard
- Path traversal in file-reading endpoints
- Insecure default configurations that expose sensitive data

### Out of Scope

- Vulnerabilities in third-party dependencies (report upstream; we'll update)
- Self-hosted misconfiguration (e.g., exposing the dashboard to the internet without auth)
- Denial of service against the local SQLite database
- Security issues in the OpenClaw gateway itself (report to [openclaw/openclaw](https://github.com/openclaw/openclaw))
- Social engineering

## Security Design

Deck is designed as a **self-hosted, single-operator dashboard**. Key security assumptions:

- The dashboard runs on the same machine as the OpenClaw gateway
- Access is restricted to the operator (localhost or private network)
- API keys and tokens are stored in `~/.openclaw/.env` (not in the repo or database)
- The [`stripSecrets()`](app/api/_lib/security.ts) utility redacts API keys (`sk-*` patterns) before displaying config in the UI
- SQLite queries use parameterized statements to prevent injection
- No user-submitted content is rendered as raw HTML

## Best Practices for Operators

- **For non-localhost deployments, see [docs/SECURING.md](docs/SECURING.md)** — step-by-step guides for Tailscale, Cloudflare Access, nginx basic auth, Caddy, and OAuth2 Proxy
- Do not expose the dashboard port (default 3000) to the public internet without authentication
- Keep API keys in `~/.openclaw/.env`, never in config files or environment variables visible to other users
- Review `config/deck-config.json` before sharing — it may contain provider API key references
- Run `pnpm test:security` to verify secret redaction works correctly
