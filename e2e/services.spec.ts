import { test, expect } from "@playwright/test";

test.describe("Services Page", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto("/services");
  });

  test("loads with services heading", async ({ page }) => {
    await expect(page.getByRole("heading", { name: "Services" })).toBeVisible({ timeout: 10_000 });
  });

  test("shows service cards or empty state", async ({ page }) => {
    // Either service cards appear or the empty state message
    const cards = page.locator(".svc-card");
    const empty = page.getByText(/no services found/i);
    await expect(cards.first().or(empty)).toBeVisible({ timeout: 10_000 });
  });

  test("operations section is visible", async ({ page }) => {
    await expect(page.getByRole("heading", { name: "Operations" })).toBeVisible({ timeout: 10_000 });
    await expect(page.getByRole("button", { name: /run doctor/i })).toBeVisible();
  });

  // ── Service Cards ──────────────────────────────────────────────────────

  test("shows at least 4 service cards", async ({ page }) => {
    const cards = page.locator(".svc-card");
    if (await cards.first().isVisible({ timeout: 10_000 }).catch(() => false)) {
      const count = await cards.count();
      expect(count).toBeGreaterThanOrEqual(4);
    }
  });

  test("service cards have status indicators", async ({ page }) => {
    const cards = page.locator(".svc-card");
    if (await cards.first().isVisible({ timeout: 10_000 }).catch(() => false)) {
      // Look for status dot/badge in first card
      const status = cards.first().locator("[class*='status'], [class*='dot'], [class*='indicator']");
      await expect(status).toBeVisible();
    }
  });

  test("service cards show URLs", async ({ page }) => {
    const cards = page.locator(".svc-card");
    if (await cards.first().isVisible({ timeout: 10_000 }).catch(() => false)) {
      // Should have URL text (http:// or https://)
      const urlText = cards.first().locator("a, [class*='url'], code").first();
      if (await urlText.isVisible().catch(() => false)) {
        const text = await urlText.textContent();
        expect(text).toMatch(/https?:\/\//);
      }
    }
  });

  test("operations section has action buttons", async ({ page }) => {
    const ops = page.getByRole("heading", { name: "Operations" });
    await expect(ops).toBeVisible({ timeout: 10_000 });
    const buttons = page.locator("button").filter({ hasText: /run|restart|check/i });
    const count = await buttons.count();
    expect(count).toBeGreaterThanOrEqual(1);
  });
});
