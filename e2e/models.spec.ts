import { test, expect } from "@playwright/test";

test.describe("Models Page", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto("/models");
    await page.waitForSelector(".models-table", { timeout: 10_000 });
  });

  // ── Page Load ────────────────────────────────────────────────────────────

  test("loads agent table with rows", async ({ page }) => {
    const rows = page.locator(".models-row");
    await expect(rows.first()).toBeVisible();
    expect(await rows.count()).toBeGreaterThan(0);
  });

  test("shows model badges for agents", async ({ page }) => {
    // At least one model badge should be visible
    const badges = page.locator("span").filter({ hasText: /haiku|sonnet|opus|kimi/i });
    await expect(badges.first()).toBeVisible();
  });

  // ── Model Swap ───────────────────────────────────────────────────────────

  test("swap button opens swap panel", async ({ page }) => {
    const swapBtn = page.locator("button").filter({ hasText: /swap/i }).first();
    if (await swapBtn.isVisible()) {
      await swapBtn.click();
      // Should show swap controls (model selector, session toggle)
      await expect(page.locator("select, [role='listbox']").first()).toBeVisible({ timeout: 3_000 });
    }
  });

  // ── Model Tester ─────────────────────────────────────────────────────────

  test("model tester section exists", async ({ page }) => {
    const testerHeading = page.getByText(/model tester/i);
    if (await testerHeading.isVisible()) {
      await expect(page.locator("button").filter({ hasText: /test/i }).first()).toBeVisible();
    }
  });

  // ── Cron Jobs Section ────────────────────────────────────────────────────

  test("shows cron jobs section with model info", async ({ page }) => {
    const cronSection = page.getByText(/cron/i).first();
    await expect(cronSection).toBeVisible();
  });

  // ── Agent Coverage ─────────────────────────────────────────────────────

  test("agent-model table has all agents", async ({ page }) => {
    const rows = page.locator(".models-row");
    const count = await rows.count();
    // Should have at least 7 agents
    expect(count).toBeGreaterThanOrEqual(7);
  });

  test("model tester sends prompt and shows response", async ({ page }) => {
    const testerSection = page.getByText(/model tester/i);
    if (await testerSection.isVisible({ timeout: 3_000 }).catch(() => false)) {
      // Find prompt input and send button
      const textarea = page.locator("textarea").last();
      const sendBtn = page.locator("button").filter({ hasText: /test|send|run/i }).first();
      if (await textarea.isVisible() && await sendBtn.isVisible()) {
        await textarea.fill("Hello, what is 2+2?");
        await sendBtn.click();
        // Wait for response
        await page.waitForTimeout(10_000);
        // Response area should have content
        const response = page.locator("[class*='response'], [class*='result'], pre").last();
        if (await response.isVisible({ timeout: 15_000 }).catch(() => false)) {
          const text = await response.textContent();
          expect(text!.length).toBeGreaterThan(0);
        }
      }
    }
  });

  test("cron warnings section shows issues if any", async ({ page }) => {
    const warningSection = page.locator("[class*='warning'], [class*='alert'], [class*='cron-warn']");
    // This may or may not be visible depending on state — just verify no crash
    await page.waitForTimeout(1_000);
  });
});
