import { test, expect } from "@playwright/test";

test.describe("Memory Page", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto("/memory");
    await page.waitForLoadState("domcontentloaded");
    await page.waitForTimeout(3_000);
  });

  test("page loads with agent panel in memory mode", async ({ page }) => {
    const sidebar = page.locator(".agents-sidebar");
    await expect(sidebar).toBeVisible({ timeout: 10_000 });
    await expect(page.locator(".agents-sidebar-header")).toHaveText("Memory");
  });

  test("agent sidebar lists agents", async ({ page }) => {
    const agentBtns = page.locator(".agents-sidebar-btn");
    await expect(agentBtns.first()).toBeVisible({ timeout: 10_000 });
    const count = await agentBtns.count();
    expect(count).toBeGreaterThanOrEqual(2);
  });

  test("selecting agent shows MEMORY.md content", async ({ page }) => {
    const agentBtns = page.locator(".agents-sidebar-btn");
    await expect(agentBtns.first()).toBeVisible({ timeout: 10_000 });
    await agentBtns.first().click();
    await page.waitForTimeout(2_000);

    // File viewer should show content
    const viewer = page.locator(".fv-viewer");
    await expect(viewer).toBeVisible({ timeout: 5_000 });
    // File name should be MEMORY.md or WORKING.md (pinned)
    const fileName = await page.locator(".fv-name").textContent();
    expect(fileName).toMatch(/MEMORY\.md|WORKING\.md/);
  });

  test("file tree shows memory files", async ({ page }) => {
    const agentBtns = page.locator(".agents-sidebar-btn");
    await expect(agentBtns.first()).toBeVisible({ timeout: 10_000 });
    await agentBtns.first().click();
    await page.waitForTimeout(2_000);

    // File tree should have file entries
    const fileItems = page.locator(".ft-file");
    await expect(fileItems.first()).toBeVisible({ timeout: 5_000 });
  });

  test("history sidebar shows git commits", async ({ page }) => {
    const agentBtns = page.locator(".agents-sidebar-btn");
    await expect(agentBtns.first()).toBeVisible({ timeout: 10_000 });
    await agentBtns.first().click();
    await page.waitForTimeout(3_000);

    // History panel
    const historyPanel = page.locator(".cfg-backups-panel");
    if (await historyPanel.isVisible({ timeout: 5_000 }).catch(() => false)) {
      const items = page.locator(".cfg-backup-item");
      const count = await items.count();
      expect(count).toBeGreaterThan(0);
    }
  });

  test("clicking diff button shows diff view", async ({ page }) => {
    const agentBtns = page.locator(".agents-sidebar-btn");
    await expect(agentBtns.first()).toBeVisible({ timeout: 10_000 });
    await agentBtns.first().click();
    await page.waitForTimeout(3_000);

    // Find the Diff button in the file viewer header
    const diffBtn = page.locator(".cfg-btn").filter({ hasText: "Diff" }).first();
    if (await diffBtn.isVisible({ timeout: 3_000 }).catch(() => false)) {
      await diffBtn.click();
      await page.waitForTimeout(2_000);
      // Diff bar should appear with from/to selects
      const diffBar = page.locator(".fv-diff-bar");
      await expect(diffBar).toBeVisible({ timeout: 5_000 });
    }
  });
});
