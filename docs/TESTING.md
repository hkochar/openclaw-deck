# Deck — Testing Guide

How to run tests, write new tests, and understand the test structure.

## Quick Reference

| Command | Category | Services Required |
|---------|----------|-------------------|
| `pnpm test` | Unit tests | None |
| `pnpm test:smoke` | Smoke tests | None |
| `pnpm test:smoke:live` | Live smoke tests | Dashboard + Gateway |
| `pnpm test:integration` | Integration tests | Dashboard dev server |
| `pnpm test:e2e` | E2E browser tests | Dashboard dev server |
| `pnpm test:e2e:ui` | E2E interactive mode | Dashboard dev server |

## Test Framework

Deck uses **Node.js built-in test runner** (`node:test`) for unit, smoke, and integration tests, and **Playwright** for E2E browser tests.

- No Jest or Vitest — uses `node:test` with `tsx` for TypeScript execution
- Assertions via `node:assert/strict`
- Playwright with Chromium for browser tests

## Test Structure

```
__tests__/
├── *.test.ts              # Unit tests (18+ files)
├── smoke/
│   ├── fresh-install.test.ts   # Fresh install validation
│   └── services.test.ts        # Service health probes
└── integration/
    ├── helpers.ts               # Shared HTTP utilities
    ├── config-roundtrip.test.ts # Config API lifecycle
    ├── gateway-required.test.ts # Tests needing gateway
    ├── local-only.test.ts       # Tests without gateway
    └── ...                      # 15+ integration test files

e2e/
├── home.spec.ts           # Dashboard page tests
├── agents.spec.ts         # Agent list/detail
├── costs.spec.ts          # Cost display
├── config.spec.ts         # Config UI
└── ...                    # 30 E2E spec files

playwright.config.ts       # Playwright configuration
```

## Unit Tests

Test isolated functions with no service dependencies.

### Running

```bash
pnpm test                  # All unit tests
pnpm test:models           # Model utilities only
pnpm test:cron             # Cron parser only
pnpm test:config           # Config validation only
pnpm test:security         # Security checks only
```

### Writing a Unit Test

```typescript
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { parseModel } from "@/app/api/_lib/model-utils";

describe("parseModel", () => {
  it("splits provider/model", () => {
    const result = parseModel("anthropic/claude-sonnet-4-20250514");
    assert.equal(result.provider, "anthropic");
    assert.equal(result.modelId, "claude-sonnet-4-20250514");
  });

  it("handles bare model name", () => {
    const result = parseModel("claude-sonnet-4-20250514");
    assert.equal(result.provider, undefined);
    assert.equal(result.modelId, "claude-sonnet-4-20250514");
  });
});
```

**Conventions:**
- File naming: `feature-name.test.ts` in `__tests__/`
- Use `describe()` for grouping, `it()` for individual cases
- Import from `@/` path alias (resolves to project root)
- Use `assert.equal`, `assert.deepEqual`, `assert.throws` — not expect-style

### What to Test

- Utility functions (`app/api/_lib/`)
- Cost calculations and model pricing
- Config parsing and validation
- Data transformations and formatters

## Smoke Tests

Validate that a fresh clone would work correctly. No running services needed.

### Running

```bash
pnpm test:smoke            # Fresh install checks
pnpm test:smoke:live       # Service health (needs Deck + Gateway)
```

### What Smoke Tests Check

**`fresh-install.test.ts`:**
- `scripts/bootstrap-config.mjs` exists and is valid
- `config/*.example.json` files are valid JSON with required keys
- No hardcoded paths (scans for `/Users/dev/` etc.)
- No stale env var names (scans for legacy `MC_*` prefixes)
- LaunchAgent label consistency (`ai.openclaw.deck`, `ai.openclaw.gateway`)
- Package metadata is valid

**`services.test.ts`:**
- Dashboard returns 200 at `http://localhost:3000`
- Gateway health endpoint responds
- Gracefully skips if services are down

## Integration Tests

Test API routes via real HTTP calls to a running dev server.

### Running

```bash
# Terminal 1: start the dev server
pnpm dev

# Terminal 2: run integration tests
pnpm test:integration
```

### Shared Helpers (`__tests__/integration/helpers.ts`)

```typescript
import { GET, POST, isServerUp, isGatewayUp } from "./helpers.js";

// HTTP helpers with timeout
const { status, body } = await GET("/api/agents");
const { status, body } = await POST("/api/config", { key: "value" });

// Conditional execution — skips if server is down
maybeIt(() => serverUp, "server", "returns agents", async () => {
  const { status } = await GET("/api/agents");
  assert.equal(status, 200);
});

// Config isolation
const snapshot = snapshotConfig();   // Save before test
// ... run mutations ...
restoreConfig(snapshot);             // Restore after
```

### Writing an Integration Test

```typescript
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { GET, POST, isServerUp, maybeIt, snapshotConfig, restoreConfig } from "./helpers.js";

let serverUp = false;
let configSnapshot = "";

before(async () => {
  serverUp = await isServerUp();
  if (serverUp) configSnapshot = snapshotConfig();
});

after(() => {
  if (configSnapshot) restoreConfig(configSnapshot);
});

describe("GET /api/agents", () => {
  maybeIt(() => serverUp, "server", "returns agent list", async () => {
    const { status, body } = await GET("/api/agents");
    assert.equal(status, 200);
    assert.ok(body.ok);
    assert.ok(Array.isArray(body.agents));
  });
});
```

**Key patterns:**
- Always probe `isServerUp()` in `before` — never hard-fail if services are down
- Use `snapshotConfig()` / `restoreConfig()` to isolate config mutations
- Tests run sequentially (config mutation safety)

## E2E Tests (Playwright)

Browser tests that validate the full UI.

### Running

```bash
# Start dev server first
pnpm dev

# Headless
pnpm test:e2e

# Interactive UI (for debugging)
pnpm test:e2e:ui
```

### Configuration (`playwright.config.ts`)

- **Browser:** Chromium only
- **Timeout:** 30 seconds per test
- **Retries:** 1 (handles flaky tests)
- **Screenshots:** Captured on failure only
- **Traces:** Retained on failure (HAR + DOM snapshots)
- **Base URL:** `http://localhost:3000`

### Writing an E2E Test

```typescript
import { test, expect } from "@playwright/test";

test.describe("Agents Page", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto("/agents");
  });

  test("displays agent list", async ({ page }) => {
    await expect(page.locator(".agents-sidebar")).toBeVisible({ timeout: 10_000 });
  });

  test("shows agent detail on click", async ({ page }) => {
    await page.click(".agent-card:first-child");
    await expect(page.locator(".agent-detail")).toBeVisible();
  });
});
```

**Conventions:**
- File naming: `feature.spec.ts` in `e2e/`
- Use `page.goto()` in `beforeEach` for page setup
- Use generous timeouts (`{ timeout: 10_000 }`) — dashboard loads data async
- Keep selectors stable — prefer class names or data attributes

## CI Pipeline

The GitHub Actions CI workflow (`.github/workflows/ci.yml`) runs on every push and PR:

| Job | What it runs |
|-----|-------------|
| `lint-and-typecheck` | `pnpm lint` + `pnpm typecheck` |
| `test` | `pnpm test` + `pnpm test:smoke` |
| `build` | `pnpm build` |

**Note:** Integration and E2E tests do not run in CI — they require running services. Run them locally before submitting PRs.

## Before Submitting a PR

```bash
pnpm test           # Unit tests pass
pnpm test:smoke     # Smoke tests pass
pnpm lint           # No lint errors
pnpm typecheck      # No type errors
pnpm build          # Build succeeds
```

If you have the dev server running, also run:

```bash
pnpm test:integration
pnpm test:e2e
```
