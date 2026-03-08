# Contributing to Deck

Thanks for your interest in contributing! Deck is the orchestration dashboard for [OpenClaw](https://github.com/openclaw/openclaw).

## Getting Started

```bash
git clone https://github.com/openclaw/openclaw-deck.git
cd openclaw-deck
pnpm install
pnpm dev          # http://localhost:3000
```

Config files are created automatically on first run. See [docs/FRESH-INSTALL-GUIDE.md](docs/FRESH-INSTALL-GUIDE.md) for the full setup walkthrough.

## Development

| Command | Purpose |
|---------|---------|
| `pnpm dev` | Start dev server (port 3000) |
| `pnpm build` | Production build |
| `pnpm lint` | ESLint |
| `pnpm typecheck` | TypeScript type checking |
| `pnpm test` | Unit tests |
| `pnpm test:smoke` | Fresh install validation (no services needed) |
| `pnpm test:smoke:live` | Service health checks (needs Deck + Gateway) |
| `pnpm test:e2e` | Playwright end-to-end tests |

### Prerequisites

- **Node.js** 18+
- **pnpm** 8+
- **Python** 3.10+ (only for ops-bot and sentinel)

## Code Style

- **Language:** TypeScript (ESM), strict typing. Avoid `any`.
- **Formatting:** We use ESLint with the Next.js config. Run `pnpm lint` before committing.
- **File size:** Aim to keep files under ~500 LOC. Split when it helps clarity.
- **Comments:** Add brief comments for tricky or non-obvious logic. Don't over-document obvious code.

## Project Structure

```
app/            Next.js 14 dashboard (pages, API routes, components)
plugin/         OpenClaw gateway plugin (data collection → SQLite)
config/         Config templates (*.example.json)
ops-bot/        Discord operations bot (Python)
sentinel/       Health monitoring agent (Python)
__tests__/      Unit and smoke tests
e2e/            Playwright end-to-end tests
scripts/        Bootstrap and utility scripts
docs/           Setup guides and reference docs
```

## Making Changes

1. **Fork and branch** from `main`.
2. **Read before editing.** Understand existing code before modifying it.
3. **Run tests** before submitting: `pnpm test && pnpm test:smoke && pnpm typecheck`.
4. **Keep changes focused.** One concern per PR. Don't bundle unrelated fixes.
5. **Don't over-engineer.** Only make changes that are directly needed. Skip speculative features, unnecessary abstractions, and premature configurability.

## Commit Messages

Use concise, action-oriented messages:

```
fix: resolve gateway health check timeout
feat: add per-agent cost breakdown to budget alerts
docs: add Discord integration setup guide
test: add smoke test for bootstrap config
```

Prefix with the area when helpful: `plugin:`, `sentinel:`, `ops-bot:`.

## Pull Requests

- Keep the title short (under 70 characters).
- Include a summary of what changed and why.
- Add a test plan — how can reviewers verify the change works?
- Reference related issues with `#123`.

## Reporting Issues

- Check [existing issues](https://github.com/openclaw/openclaw-deck/issues) first.
- Include: what you expected, what happened, steps to reproduce.
- For config/setup issues, include your OS, Node version, and relevant env vars (redact secrets).

## Security

If you discover a security vulnerability, **do not open a public issue**. Please report it privately by emailing [security@openclaw.ai](mailto:security@openclaw.ai). See [SECURITY.md](SECURITY.md) for our full security policy, scope, and response timeline.

## License

By contributing, you agree that your contributions will be licensed under the MIT License.
