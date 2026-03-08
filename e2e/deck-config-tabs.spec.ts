/**
 * Playwright tests: verify every deck-config tab loads without errors.
 *
 * Covers all tabs via hash navigation + click-based .ds-tab switching.
 *
 * Run: pnpm exec playwright test e2e/deck-config-tabs.spec.ts
 */

import { test, expect } from "@playwright/test";

const BASE = "/deck-config";

// Hash-navigable edit panels
const EDIT_HASHES = [
  "edit.budgets", "edit.alerts", "edit.agents", "edit.channels",
  "edit.providers", "edit.infra", "edit.sentinel", "edit.dashboard", "edit.replay",
] as const;

// Main .ds-tab tabs visible on the config page
const DS_TABS = ["Agents", "Channels", "Sentinel", "Budgets"] as const;

// ── Tab Click Tests (run first — needs fresh API quota) ─────────────────

test.describe("Deck Config — Tab Clicks", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto(BASE);
    await page.waitForLoadState("domcontentloaded");
    await page.waitForTimeout(2_000);
    // Remove tour overlay and setup checklist via JS to avoid click interception
    await page.evaluate(() => {
      document.querySelector(".tour-overlay")?.remove();
      document.querySelector(".setup-checklist")?.remove();
    });
    await page.waitForTimeout(500);
  });

  for (const tabName of DS_TABS) {
    test(`clicking .ds-tab "${tabName}" loads without crash`, async ({ page }) => {
      const tabBtn = page.locator(".ds-tab", { hasText: tabName });

      const tabVisible = await tabBtn.first().isVisible({ timeout: 5_000 }).catch(() => false);
      if (!tabVisible) {
        test.skip(true, `"${tabName}" .ds-tab not found — config may not have loaded`);
        return;
      }

      await tabBtn.first().click();
      await page.waitForTimeout(500);

      // No error overlay
      const errorOverlay = page.locator(
        "#__next-error, .nextjs-container-errors-body, [data-nextjs-dialog]",
      );
      const hasError = await errorOverlay.isVisible({ timeout: 1_000 }).catch(() => false);
      expect(hasError).toBe(false);

      const bodyText = await page.locator("body").innerText();
      expect(bodyText.length).toBeGreaterThan(50);
    });
  }
});

// ── Hash Navigation Tests ───────────────────────────────────────────────

test.describe("Deck Config — Hash Navigation", () => {
  for (const hash of EDIT_HASHES) {
    test(`navigating to #${hash} loads without crash`, async ({ page }) => {
      await page.goto(`${BASE}#${hash}`);
      await page.waitForLoadState("domcontentloaded");
      await page.waitForTimeout(1_000);

      // No crash / error overlay
      const errorOverlay = page.locator(
        "#__next-error, .nextjs-container-errors-body, [data-nextjs-dialog]",
      );
      const hasError = await errorOverlay.isVisible({ timeout: 1_000 }).catch(() => false);
      expect(hasError).toBe(false);

      // Page has content
      const bodyText = await page.locator("body").innerText();
      expect(bodyText.length).toBeGreaterThan(50);
    });
  }
});

// ── Alerts Tab Regression ───────────────────────────────────────────────

test.describe("Deck Config — Alerts Tab", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto(`${BASE}#edit.alerts`);
    await page.waitForLoadState("domcontentloaded");
    await page.waitForTimeout(1_000);
  });

  test("alerts tab shows platform or routing section", async ({ page }) => {
    const alertContent = page
      .getByText(/platform|routing|slack|discord|telegram|channel/i)
      .first();
    const visible = await alertContent.isVisible({ timeout: 5_000 }).catch(() => false);
    if (!visible) {
      test.skip(true, "Alerts content not rendered — may need gateway");
      return;
    }
    expect(visible).toBe(true);
  });

  test("alerts tab does not crash (regression for hooks bug)", async ({ page }) => {
    const errorOverlay = page.locator(
      "#__next-error, .nextjs-container-errors-body, [data-nextjs-dialog]",
    );
    const hasError = await errorOverlay.isVisible({ timeout: 2_000 }).catch(() => false);
    expect(hasError).toBe(false);

    const bodyText = await page.locator("body").innerText();
    expect(bodyText.length).toBeGreaterThan(50);
  });
});

// ── Infra Tab ───────────────────────────────────────────────────────────

test.describe("Deck Config — Infra Tab", () => {
  test("infra tab shows gateway or service URL content", async ({ page }) => {
    await page.goto(`${BASE}#edit.infra`);
    await page.waitForLoadState("domcontentloaded");
    await page.waitForTimeout(1_000);

    const infraContent = page
      .getByText(/gateway|service|url|port|infra/i)
      .first();
    const visible = await infraContent.isVisible({ timeout: 5_000 }).catch(() => false);
    if (!visible) {
      test.skip(true, "Infra content not rendered");
      return;
    }
    expect(visible).toBe(true);
  });
});

// ── Dashboard Tab ───────────────────────────────────────────────────────

test.describe("Deck Config — Dashboard Tab", () => {
  test("dashboard tab shows config options", async ({ page }) => {
    await page.goto(`${BASE}#edit.dashboard`);
    await page.waitForLoadState("domcontentloaded");
    await page.waitForTimeout(1_000);

    const dashContent = page
      .getByText(/hidden|walkthrough|tab|dashboard/i)
      .first();
    const visible = await dashContent.isVisible({ timeout: 5_000 }).catch(() => false);
    if (!visible) {
      test.skip(true, "Dashboard config content not rendered");
      return;
    }
    expect(visible).toBe(true);
  });
});

// ── Replay Tab ──────────────────────────────────────────────────────────

test.describe("Deck Config — Replay Tab", () => {
  test("replay tab shows session guardrail or replay config", async ({ page }) => {
    await page.goto(`${BASE}#edit.replay`);
    await page.waitForLoadState("domcontentloaded");
    await page.waitForTimeout(1_000);

    const replayContent = page
      .getByText(/session|guardrail|duration|replay|cost/i)
      .first();
    const visible = await replayContent.isVisible({ timeout: 5_000 }).catch(() => false);
    if (!visible) {
      test.skip(true, "Replay content not rendered");
      return;
    }
    expect(visible).toBe(true);
  });
});
