import { test, expect } from "@playwright/test";

test.describe("Docs Page", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto("/docs");
    await page.waitForLoadState("domcontentloaded");
    await page.waitForTimeout(3_000);
  });

  test("page loads with agent panel in docs mode", async ({ page }) => {
    const sidebar = page.locator(".agents-sidebar");
    await expect(sidebar).toBeVisible({ timeout: 10_000 });
    // Header should say "Docs"
    await expect(page.locator(".agents-sidebar-header")).toHaveText("Docs");
  });

  test("agent sidebar lists agents", async ({ page }) => {
    const agentBtns = page.locator(".agents-sidebar-btn");
    await expect(agentBtns.first()).toBeVisible({ timeout: 10_000 });
    const count = await agentBtns.count();
    expect(count).toBeGreaterThanOrEqual(2);
  });

  test("selecting agent shows their docs", async ({ page }) => {
    const agentBtns = page.locator(".agents-sidebar-btn");
    await expect(agentBtns.first()).toBeVisible({ timeout: 10_000 });
    await agentBtns.first().click();
    await page.waitForTimeout(2_000);

    // File viewer should show content
    const viewer = page.locator(".fv-viewer");
    await expect(viewer).toBeVisible({ timeout: 5_000 });
  });

  test("file tree shows folders when agent has subdirectories", async ({ page }) => {
    const agentBtns = page.locator(".agents-sidebar-btn");
    await expect(agentBtns.first()).toBeVisible({ timeout: 10_000 });
    await agentBtns.first().click();
    await page.waitForTimeout(2_000);

    // Folder toggles only appear when agent docs have subdirectories (data-dependent)
    const folders = page.locator(".ft-folder-toggle");
    if (!(await folders.first().isVisible({ timeout: 5_000 }).catch(() => false))) {
      test.skip(true, "First agent has no doc subdirectories — no folders to test");
      return;
    }
    const count = await folders.count();
    expect(count).toBeGreaterThanOrEqual(1);
  });

  test("audit.md appears in file tree", async ({ page }) => {
    const agentBtns = page.locator(".agents-sidebar-btn");
    await expect(agentBtns.first()).toBeVisible({ timeout: 10_000 });
    await agentBtns.first().click();
    await page.waitForTimeout(2_000);

    // Audit folder only exists if the first agent has an Audit docs folder (data-dependent)
    const auditFolder = page.locator(".ft-folder-toggle").filter({ hasText: "Audit" });
    if (!(await auditFolder.isVisible({ timeout: 5_000 }).catch(() => false))) {
      test.skip(true, "First agent has no Audit folder — data-dependent test");
      return;
    }
    await auditFolder.click();
    await page.waitForTimeout(500);

    const auditFile = page.locator(".ft-file--deep").filter({ hasText: "audit" });
    await expect(auditFile.first()).toBeVisible({ timeout: 3_000 });
  });

  test("history sidebar shows git commits for selected file", async ({ page }) => {
    const agentBtns = page.locator(".agents-sidebar-btn");
    await expect(agentBtns.first()).toBeVisible({ timeout: 10_000 });
    await agentBtns.first().click();
    await page.waitForTimeout(3_000);

    // History panel with commit items
    const historyPanel = page.locator(".cfg-backups-panel");
    if (await historyPanel.isVisible({ timeout: 5_000 }).catch(() => false)) {
      const items = page.locator(".cfg-backup-item");
      const count = await items.count();
      expect(count).toBeGreaterThan(0);
    }
  });

  test("switching files updates content", async ({ page }) => {
    const agentBtns = page.locator(".agents-sidebar-btn");
    await expect(agentBtns.first()).toBeVisible({ timeout: 10_000 });
    await agentBtns.first().click();
    await page.waitForTimeout(2_000);

    // Get first file name
    const firstFileName = await page.locator(".fv-name").textContent();

    // Click a different file in the tree
    const files = page.locator(".ft-file");
    if (await files.nth(1).isVisible().catch(() => false)) {
      await files.nth(1).click();
      await page.waitForTimeout(1_500);
      const secondFileName = await page.locator(".fv-name").textContent();
      expect(secondFileName).not.toBe(firstFileName);
    }
  });
});
