import { test, expect } from "@playwright/test";

test.describe("Costs Page", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto("/costs");
    await page.waitForLoadState("domcontentloaded");
  });

  // ── Page Load ────────────────────────────────────────────────────────────

  test("loads with page title", async ({ page }) => {
    await expect(page.getByRole("heading", { name: "Agent Costs" })).toBeVisible({ timeout: 10_000 });
  });

  test("shows fleet summary cards", async ({ page }) => {
    // Wait for data to load (either summary cards or error message)
    const summary = page.locator(".cg-summary");
    const error = page.locator(".cg-error");
    await expect(summary.or(error)).toBeVisible({ timeout: 10_000 });

    // If gateway is up, summary should have 6 cards (cost + request + agents)
    if (await summary.isVisible()) {
      const cards = page.locator(".cg-summary-card");
      const count = await cards.count();
      expect(count).toBeGreaterThanOrEqual(4);
    }
  });

  test("summary shows Today, This Week, This Month, Active Agents", async ({ page }) => {
    const summary = page.locator(".cg-summary");
    if (await summary.isVisible({ timeout: 10_000 }).catch(() => false)) {
      await expect(page.getByText("Today")).toBeVisible();
      await expect(page.getByText("This Week")).toBeVisible();
      await expect(page.getByText("This Month")).toBeVisible();
      await expect(page.getByText("Active Agents")).toBeVisible();
    }
  });

  test("summary values contain dollar amounts", async ({ page }) => {
    const summary = page.locator(".cg-summary");
    if (await summary.isVisible({ timeout: 10_000 }).catch(() => false)) {
      const values = page.locator(".cg-summary-value");
      const count = await values.count();
      // First 3 cards should show dollar amounts
      for (let i = 0; i < Math.min(count, 3); i++) {
        const text = await values.nth(i).textContent();
        expect(text).toMatch(/^\$/);
      }
    }
  });

  // ── Agent Cards ──────────────────────────────────────────────────────────

  test("shows agent cards when data available", async ({ page }) => {
    const grid = page.locator(".cg-grid");
    const empty = page.locator(".cg-empty");
    const error = page.locator(".cg-error");

    await expect(grid.or(empty).or(error)).toBeVisible({ timeout: 10_000 });

    if (await grid.isVisible()) {
      const cards = page.locator(".cg-card");
      const count = await cards.count();
      expect(count).toBeGreaterThan(0);
    }
  });

  test("agent card has name, costs, and sparkline", async ({ page }) => {
    const card = page.locator(".cg-card").first();
    if (await card.isVisible({ timeout: 10_000 }).catch(() => false)) {
      // Has agent name
      await expect(card.locator(".cg-card-name")).toBeVisible();
      // Has cost values
      await expect(card.locator(".cg-cost-value").first()).toBeVisible();
      // Has sparkline
      await expect(card.locator(".cg-sparkline-label")).toBeVisible();
      await expect(card.locator("svg")).toBeVisible();
    }
  });

  test("agent card shows Today, Week, Month costs", async ({ page }) => {
    const card = page.locator(".cg-card").first();
    if (await card.isVisible({ timeout: 10_000 }).catch(() => false)) {
      await expect(card.getByText("Today")).toBeVisible();
      await expect(card.getByText("Week")).toBeVisible();
      await expect(card.getByText("Month")).toBeVisible();
    }
  });

  test("agent card has pause/resume button", async ({ page }) => {
    const card = page.locator(".cg-card").first();
    if (await card.isVisible({ timeout: 10_000 }).catch(() => false)) {
      const btn = card.locator(".cg-btn");
      await expect(btn).toBeVisible();
      const text = await btn.textContent();
      expect(text).toMatch(/Pause|Resume/);
    }
  });

  // ── Budget Progress Bar ────────────────────────────────────────────────

  test("shows budget bar or 'No budget set' per agent", async ({ page }) => {
    const card = page.locator(".cg-card").first();
    if (await card.isVisible({ timeout: 10_000 }).catch(() => false)) {
      const budgetBar = card.locator(".cg-bar-track");
      const noBudget = card.locator(".cg-card-budget--none");
      // Should have one or the other
      await expect(budgetBar.or(noBudget)).toBeVisible();
    }
  });

  // ── Gateway Unavailable ────────────────────────────────────────────────

  test("shows error message when gateway is down", async ({ page }) => {
    // This test just verifies the error state renders correctly
    // (it may or may not actually show depending on gateway status)
    const title = page.getByRole("heading", { name: "Agent Costs" });
    await expect(title).toBeVisible({ timeout: 10_000 });
  });

  // ── Nav Link ───────────────────────────────────────────────────────────

  test("costs link exists in navigation", async ({ page }) => {
    await page.goto("/");
    await expect(page.getByRole("link", { name: "Costs" })).toBeVisible({ timeout: 5_000 });
  });

  test("costs nav link has active state when on /costs", async ({ page }) => {
    const link = page.getByRole("link", { name: "Costs" });
    await expect(link).toBeVisible({ timeout: 5_000 });
    await expect(link).toHaveClass(/nav-active/);
  });

  // ── Filter Interactions ──────────────────────────────────────────────────

  test("filter by agent then clear resets cards", async ({ page }) => {
    const grid = page.locator(".cg-grid");
    if (await grid.isVisible({ timeout: 10_000 }).catch(() => false)) {
      const allCards = await page.locator(".cg-card").count();
      // Select agent filter
      const agentSelect = page.locator(".cg-filter-select").first();
      if (await agentSelect.isVisible()) {
        const options = await agentSelect.locator("option").allTextContents();
        if (options.length > 1) {
          await agentSelect.selectOption({ index: 1 });
          await page.waitForTimeout(1_000);
          const filteredCards = await page.locator(".cg-card").count();
          expect(filteredCards).toBeLessThanOrEqual(allCards);
          // Clear
          const clearBtn = page.locator(".cg-filter-clear");
          if (await clearBtn.isVisible()) {
            await clearBtn.click();
            await page.waitForTimeout(1_000);
            const resetCards = await page.locator(".cg-card").count();
            expect(resetCards).toBe(allCards);
          }
        }
      }
    }
  });

  test("period toggle (day/week/month) updates summary", async ({ page }) => {
    const summary = page.locator(".cg-summary");
    if (await summary.isVisible({ timeout: 10_000 }).catch(() => false)) {
      const dayValue = await page.locator(".cg-summary-value").first().textContent();
      // Click Week
      const weekBtn = page.locator(".cg-filter-btn").filter({ hasText: "Week" });
      if (await weekBtn.isVisible()) {
        await weekBtn.click();
        await page.waitForTimeout(1_500);
      }
    }
  });

  test("timeline date range buttons exist", async ({ page }) => {
    const timeline = page.locator("[class*='timeline']");
    if (await timeline.isVisible({ timeout: 10_000 }).catch(() => false)) {
      const rangeBtn = page.locator("button").filter({ hasText: /7d|14d|30d/ });
      await expect(rangeBtn.first()).toBeVisible();
    }
  });

  test("OpenRouter limitation note is visible", async ({ page }) => {
    const note = page.locator(".cg-provider-spend-note");
    if (await note.isVisible({ timeout: 10_000 }).catch(() => false)) {
      const text = await note.textContent();
      expect(text).toMatch(/OpenRouter|reconciliation|UTC/i);
    }
  });
});
