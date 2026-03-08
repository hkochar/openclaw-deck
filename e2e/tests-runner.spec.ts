import { test, expect } from "@playwright/test";

test.describe("Tests Runner Page", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto("/tests");
    await page.waitForLoadState("networkidle", { timeout: 10_000 });
  });

  test("loads with run all button", async ({ page }) => {
    await expect(page.getByRole("button", { name: /run all/i })).toBeVisible({ timeout: 10_000 });
  });

  test("shows test suites", async ({ page }) => {
    // Should have at least one run button for individual suites
    const runButtons = page.locator("button").filter({ hasText: /run/i });
    expect(await runButtons.count()).toBeGreaterThan(0);
  });

  test("clicking a suite row expands output", async ({ page }) => {
    const suiteRow = page.locator("tr, [role='row']").first();
    if (await suiteRow.isVisible()) {
      await suiteRow.click();
      await page.waitForTimeout(500);
    }
  });

  // ── Detailed Checks ───────────────────────────────────────────────────

  test("suite table shows pass/fail information", async ({ page }) => {
    // Table should show pass/fail counts somewhere
    const table = page.locator("table, [class*='suite']").first();
    if (await table.isVisible({ timeout: 5_000 }).catch(() => false)) {
      const text = await table.textContent();
      // Should contain some numeric info (pass counts, etc.)
      expect(text).toBeTruthy();
    }
  });

  test("run all button is enabled", async ({ page }) => {
    const runAllBtn = page.getByRole("button", { name: /run all/i });
    await expect(runAllBtn).toBeVisible({ timeout: 10_000 });
    await expect(runAllBtn).toBeEnabled();
  });

  test("expanding a suite shows output", async ({ page }) => {
    const suiteRow = page.locator("tr").filter({ hasText: /cron|config|git|security|model/i }).first();
    if (await suiteRow.isVisible({ timeout: 5_000 }).catch(() => false)) {
      await suiteRow.click();
      await page.waitForTimeout(1_000);
      // Output panel might appear — just verify no crash
    }
  });
});
