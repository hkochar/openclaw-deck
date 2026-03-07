import { test, expect } from "@playwright/test";

test.describe("Memory Operations — Costs Page Section", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto("/costs");
    await page.waitForLoadState("domcontentloaded");
    await page.waitForTimeout(3_000);
  });

  test("Memory Operations section appears on Costs page", async ({ page }) => {
    // Memory Operations is inside the "Detailed Breakdowns" accordion — expand it first
    const toggle = page.locator(".cg-advanced-toggle");
    if (await toggle.isVisible({ timeout: 5_000 }).catch(() => false)) {
      await toggle.click();
      await page.waitForTimeout(1_000);
    }
    const section = page.locator(".cg-tool-costs").filter({ hasText: "Memory Operations" });
    await expect(section).toBeVisible({ timeout: 10_000 });
  });

  test("Memory Operations table has correct column headers", async ({ page }) => {
    const section = page.locator(".cg-tool-costs").filter({ hasText: "Memory Operations" });
    if (await section.isVisible({ timeout: 10_000 }).catch(() => false)) {
      await expect(section.locator("th").filter({ hasText: "File" })).toBeVisible();
      await expect(section.locator("th").filter({ hasText: "Reads" })).toBeVisible();
      await expect(section.locator("th").filter({ hasText: "Writes" })).toBeVisible();
      await expect(section.locator("th").filter({ hasText: "Edits" })).toBeVisible();
      await expect(section.locator("th").filter({ hasText: "Agents" })).toBeVisible();
      await expect(section.locator("th").filter({ hasText: "Sessions" })).toBeVisible();
      await expect(section.locator("th").filter({ hasText: "Last Access" })).toBeVisible();
    }
  });

  test("Memory Operations shows file rows with data", async ({ page }) => {
    const section = page.locator(".cg-tool-costs").filter({ hasText: "Memory Operations" });
    if (await section.isVisible({ timeout: 10_000 }).catch(() => false)) {
      const rows = section.locator(".cg-tool-row");
      const count = await rows.count();
      expect(count).toBeGreaterThan(0);
      // First row should have a file name
      const fileName = await rows.first().locator(".cg-tool-name").textContent();
      expect(fileName).toBeTruthy();
      expect(fileName!.length).toBeGreaterThan(0);
    }
  });

  test("WORKING.md appears as a frequently accessed file", async ({ page }) => {
    const section = page.locator(".cg-tool-costs").filter({ hasText: "Memory Operations" });
    if (await section.isVisible({ timeout: 10_000 }).catch(() => false)) {
      const workingRow = section.locator(".cg-tool-row").filter({ hasText: /WORKING\.md/ });
      await expect(workingRow).toBeVisible({ timeout: 5_000 });
    }
  });

  test("Memory Operations day range buttons work", async ({ page }) => {
    const section = page.locator(".cg-tool-costs").filter({ hasText: "Memory Operations" });
    if (await section.isVisible({ timeout: 10_000 }).catch(() => false)) {
      // Click 30d (wider range)
      const btn30d = section.locator(".logs-chip").filter({ hasText: "30d" });
      await btn30d.click();
      await page.waitForTimeout(3_000);
      await expect(btn30d).toHaveClass(/active/);
      // Click 14d (should still have data, unlike 1d which may hide the section)
      const btn14d = section.locator(".logs-chip").filter({ hasText: "14d" });
      await btn14d.click();
      await page.waitForTimeout(3_000);
      // Section may auto-hide if no data, so just verify button was clickable
      const sectionStillVisible = await section.isVisible().catch(() => false);
      if (sectionStillVisible) {
        await expect(btn14d).toHaveClass(/active/);
      }
    }
  });

  test("clicking a memory file row navigates to Logs with search", async ({ page }) => {
    const section = page.locator(".cg-tool-costs").filter({ hasText: "Memory Operations" });
    if (await section.isVisible({ timeout: 10_000 }).catch(() => false)) {
      const firstRow = section.locator(".cg-tool-row").first();
      const fileName = await firstRow.locator(".cg-tool-name").textContent();
      await firstRow.click();
      await page.waitForURL(/\/logs\?search=/, { timeout: 5_000 });
      const url = page.url();
      expect(url).toContain("/logs");
      expect(url).toContain("search=");
      // The search param should contain part of the file name
      if (fileName) {
        expect(decodeURIComponent(url)).toContain(fileName.split("/").pop()!);
      }
    }
  });

  test("Memory Operations shows agent names in Agents column", async ({ page }) => {
    const section = page.locator(".cg-tool-costs").filter({ hasText: "Memory Operations" });
    if (await section.isVisible({ timeout: 10_000 }).catch(() => false)) {
      const rows = section.locator(".cg-tool-row");
      const count = await rows.count();
      for (let i = 0; i < Math.min(count, 3); i++) {
        const cells = rows.nth(i).locator("td");
        // 5th column (index 4) is Agents
        const agentText = await cells.nth(4).textContent();
        expect(agentText).toMatch(/jane|scout|forge|maya|pulse|vigil|sentinel/);
      }
    }
  });
});

test.describe("Memory Operations — Logs Page Timeline", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto("/logs");
    await page.waitForLoadState("domcontentloaded");
    await page.waitForTimeout(3_000);
    // Switch to 7d range to ensure memory data is available
    const btn7d = page.getByRole("button", { name: "7d" });
    if (await btn7d.isVisible({ timeout: 3_000 }).catch(() => false)) {
      await btn7d.click();
      await page.waitForTimeout(2_000);
    }
  });

  test("Memory ops toggle button exists in View section", async ({ page }) => {
    const memBtn = page.locator("button.logs-chip").filter({ hasText: "Memory ops" });
    await expect(memBtn).toBeVisible({ timeout: 10_000 });
  });

  test("clicking Memory ops toggle shows memory timeline", async ({ page }) => {
    const memBtn = page.locator("button.logs-chip").filter({ hasText: "Memory ops" });
    await memBtn.click();
    await page.waitForTimeout(3_000);

    // Should show Memory Operations heading
    await expect(page.getByRole("heading", { name: "Memory Operations" })).toBeVisible({ timeout: 10_000 });
  });

  test("memory timeline shows session groups", async ({ page }) => {
    const memBtn = page.locator("button.logs-chip").filter({ hasText: "Memory ops" });
    await memBtn.click();
    await page.waitForTimeout(5_000);

    const groups = page.locator(".logs-run-group");
    await expect(groups.first()).toBeVisible({ timeout: 10_000 });
    const count = await groups.count();
    expect(count).toBeGreaterThan(0);
  });

  test("memory session groups have trigger badges", async ({ page }) => {
    const memBtn = page.locator("button.logs-chip").filter({ hasText: "Memory ops" });
    await memBtn.click();
    await page.waitForTimeout(3_000);

    const triggers = page.locator(".logs-mem-trigger");
    if (await triggers.first().isVisible({ timeout: 5_000 }).catch(() => false)) {
      const count = await triggers.count();
      expect(count).toBeGreaterThan(0);
      // Each trigger should be one of: cron, discord, session, unknown
      for (let i = 0; i < Math.min(count, 5); i++) {
        const text = await triggers.nth(i).textContent();
        expect(text).toMatch(/cron|discord|session|unknown/);
      }
    }
  });

  test("memory session header shows op counts", async ({ page }) => {
    const memBtn = page.locator("button.logs-chip").filter({ hasText: "Memory ops" });
    await memBtn.click();
    await page.waitForTimeout(3_000);

    const header = page.locator(".logs-run-header").first();
    if (await header.isVisible({ timeout: 5_000 }).catch(() => false)) {
      const text = await header.textContent();
      // Should contain op count like "5 ops"
      expect(text).toMatch(/\d+ ops?/);
      // Should contain r/w breakdown like "3r / 2w"
      expect(text).toMatch(/\d+r \/ \d+w/);
    }
  });

  test("expanding a memory session shows individual operations", async ({ page }) => {
    const memBtn = page.locator("button.logs-chip").filter({ hasText: "Memory ops" });
    await memBtn.click();
    await page.waitForTimeout(3_000);

    const header = page.locator(".logs-run-header").first();
    if (await header.isVisible({ timeout: 5_000 }).catch(() => false)) {
      await header.click();
      await page.waitForTimeout(500);

      // Should show events inside
      const events = page.locator(".logs-run-events .logs-stream-event");
      const count = await events.count();
      expect(count).toBeGreaterThan(0);
    }
  });

  test("expanded session shows trigger detail", async ({ page }) => {
    const memBtn = page.locator("button.logs-chip").filter({ hasText: "Memory ops" });
    await memBtn.click();
    await page.waitForTimeout(3_000);

    const header = page.locator(".logs-run-header").first();
    if (await header.isVisible({ timeout: 5_000 }).catch(() => false)) {
      await header.click();
      await page.waitForTimeout(500);

      const triggerDetail = page.locator(".logs-mem-trigger-detail");
      if (await triggerDetail.isVisible({ timeout: 3_000 }).catch(() => false)) {
        const text = await triggerDetail.textContent();
        expect(text!.length).toBeGreaterThan(5);
      }
    }
  });

  test("expanded events show op type badges (read/write/edit/exec)", async ({ page }) => {
    const memBtn = page.locator("button.logs-chip").filter({ hasText: "Memory ops" });
    await memBtn.click();
    await page.waitForTimeout(3_000);

    const header = page.locator(".logs-run-header").first();
    if (await header.isVisible({ timeout: 5_000 }).catch(() => false)) {
      await header.click();
      await page.waitForTimeout(500);

      const opBadges = page.locator(".logs-run-events .logs-se-type");
      const count = await opBadges.count();
      expect(count).toBeGreaterThan(0);
      for (let i = 0; i < Math.min(count, 5); i++) {
        const text = await opBadges.nth(i).textContent();
        expect(text).toMatch(/read|write|edit|exec/);
      }
    }
  });

  test("expanded session has 'View full session trace' link", async ({ page }) => {
    const memBtn = page.locator("button.logs-chip").filter({ hasText: "Memory ops" });
    await memBtn.click();
    await page.waitForTimeout(3_000);

    const header = page.locator(".logs-run-header").first();
    if (await header.isVisible({ timeout: 5_000 }).catch(() => false)) {
      await header.click();
      await page.waitForTimeout(500);

      const traceLink = page.locator(".logs-run-link").filter({ hasText: /full session trace/ });
      await expect(traceLink).toBeVisible({ timeout: 3_000 });
    }
  });

  test("clicking 'View full session trace' exits memory mode and sets search", async ({ page }) => {
    const memBtn = page.locator("button.logs-chip").filter({ hasText: "Memory ops" });
    await memBtn.click();
    await page.waitForTimeout(3_000);

    const header = page.locator(".logs-run-header").first();
    if (await header.isVisible({ timeout: 5_000 }).catch(() => false)) {
      await header.click();
      await page.waitForTimeout(500);

      const traceLink = page.locator(".logs-run-link").filter({ hasText: /full session trace/ });
      if (await traceLink.isVisible({ timeout: 3_000 }).catch(() => false)) {
        await traceLink.click();
        await page.waitForTimeout(2_000);

        // Should exit memory mode — heading should be "Event Stream" not "Memory Operations"
        await expect(page.getByRole("heading", { name: "Event Stream" })).toBeVisible({ timeout: 5_000 });
        // Memory ops button should no longer be active
        await expect(memBtn).not.toHaveClass(/active/);
      }
    }
  });

  test("toggling Memory ops off returns to Event Stream", async ({ page }) => {
    const memBtn = page.locator("button.logs-chip").filter({ hasText: "Memory ops" });
    await memBtn.click();
    await page.waitForTimeout(3_000);
    await expect(page.getByRole("heading", { name: "Memory Operations" })).toBeVisible({ timeout: 5_000 });

    // Toggle off
    await memBtn.click();
    await page.waitForTimeout(1_000);
    await expect(page.getByRole("heading", { name: "Event Stream" })).toBeVisible({ timeout: 5_000 });
  });
});

test.describe("Memory Operations — Cross-Page Navigation", () => {
  test("navigating from Costs memory row to Logs preserves search context", async ({ page }) => {
    await page.goto("/costs");
    await page.waitForLoadState("domcontentloaded");
    await page.waitForTimeout(3_000);

    const section = page.locator(".cg-tool-costs").filter({ hasText: "Memory Operations" });
    if (await section.isVisible({ timeout: 10_000 }).catch(() => false)) {
      const workingRow = section.locator(".cg-tool-row").filter({ hasText: /WORKING\.md/ });
      if (await workingRow.isVisible({ timeout: 3_000 }).catch(() => false)) {
        await workingRow.click();
        await page.waitForURL(/\/logs/, { timeout: 5_000 });

        // Search input should be pre-filled
        const searchInput = page.locator("input.logs-search, input[type='text'][placeholder*='earch']");
        if (await searchInput.isVisible({ timeout: 5_000 }).catch(() => false)) {
          const value = await searchInput.inputValue();
          expect(value).toContain("WORKING");
        }
      }
    }
  });

  test("Logs ?memory=1 URL param activates memory mode on load", async ({ page }) => {
    await page.goto("/logs?memory=1");
    await page.waitForLoadState("domcontentloaded");
    await page.waitForTimeout(3_000);

    // Memory ops button should be active
    const memBtn = page.locator("button.logs-chip").filter({ hasText: "Memory ops" });
    await expect(memBtn).toHaveClass(/active/, { timeout: 10_000 });
    // Should show Memory Operations heading
    await expect(page.getByRole("heading", { name: "Memory Operations" })).toBeVisible({ timeout: 10_000 });
  });
});
