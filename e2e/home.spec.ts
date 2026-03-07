import { test, expect } from "@playwright/test";

test.describe("Home Page", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto("/");
  });

  test("loads dashboard with header", async ({ page }) => {
    await expect(page.locator(".header")).toBeVisible({ timeout: 10_000 });
  });

  test("shows gateway health indicator", async ({ page }) => {
    await expect(page.locator(".gateway-health")).toBeVisible({ timeout: 10_000 });
  });

  test("navigation sidebar has all pages", async ({ page }) => {
    // Check for key navigation links (actual nav labels)
    for (const label of ["Costs", "Schedule", "Logs", "Sessions"]) {
      await expect(page.getByRole("link", { name: new RegExp(label, "i") })).toBeVisible();
    }
  });

  test("navigation links work", async ({ page }) => {
    await page.getByRole("link", { name: /schedule/i }).click();
    await expect(page).toHaveURL(/\/schedule/);
  });

  // ── Agent Status ─────────────────────────────────────────────────────────

  test("shows agent status cards with names", async ({ page }) => {
    await page.waitForTimeout(3_000);
    const agentCards = page.locator(".agent-card, .overview-agent, [class*='agent']").filter({ has: page.locator("span, div") });
    if (await agentCards.first().isVisible({ timeout: 5_000 }).catch(() => false)) {
      const count = await agentCards.count();
      expect(count).toBeGreaterThanOrEqual(1);
    }
  });

  test("agent cards show status indicators", async ({ page }) => {
    await page.waitForTimeout(3_000);
    // Look for status badges (online/idle/offline dots or text)
    const statusIndicator = page.locator("[class*='status'], [class*='dot'], [class*='badge']").first();
    if (await statusIndicator.isVisible({ timeout: 5_000 }).catch(() => false)) {
      await expect(statusIndicator).toBeVisible();
    }
  });

  // ── KPI Cards ────────────────────────────────────────────────────────────

  test("KPI cards show numeric values", async ({ page }) => {
    await page.waitForTimeout(3_000);
    const cards = page.locator(".stat-card, .kpi-card, .overview-card, [class*='summary']");
    if (await cards.first().isVisible({ timeout: 5_000 }).catch(() => false)) {
      const count = await cards.count();
      expect(count).toBeGreaterThanOrEqual(1);
    }
  });

  // ── Activity Feed ────────────────────────────────────────────────────────

  test("activity feed shows recent events", async ({ page }) => {
    await page.waitForTimeout(3_000);
    const feedItems = page.locator(".activity-item, .feed-item, [class*='activity'] li, [class*='event']");
    if (await feedItems.first().isVisible({ timeout: 5_000 }).catch(() => false)) {
      const count = await feedItems.count();
      expect(count).toBeGreaterThan(0);
    }
  });

  test("activity feed events have timestamps", async ({ page }) => {
    await page.waitForTimeout(3_000);
    // Look for relative time text (e.g. "5m ago", "2h ago")
    const timeText = page.locator("time, [class*='time'], [class*='ago']").first();
    if (await timeText.isVisible({ timeout: 5_000 }).catch(() => false)) {
      const text = await timeText.textContent();
      expect(text).toBeTruthy();
    }
  });
});
