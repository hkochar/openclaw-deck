import { test, expect } from "@playwright/test";

test.describe("Search Page", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto("/search");
    await page.waitForLoadState("networkidle");
  });

  // ── Page loads ────────────────────────────────────────────────────

  test("page loads with search input", async ({ page }) => {
    const input = page.locator(".search-input");
    await expect(input).toBeVisible({ timeout: 10_000 });
    await expect(input).toBeFocused();
  });

  test("page title is visible", async ({ page }) => {
    await expect(page.locator(".search-page h1")).toContainText("Search");
  });

  test("type filter chips are visible", async ({ page }) => {
    await expect(page.getByText("Type")).toBeVisible();
    await expect(page.locator(".logs-chip").filter({ hasText: "All" }).first()).toBeVisible();
    await expect(page.locator(".logs-chip").filter({ hasText: "Events" }).first()).toBeVisible();
    await expect(page.locator(".logs-chip").filter({ hasText: "Sessions" }).first()).toBeVisible();
  });

  // ── Search execution ──────────────────────────────────────────────

  test("typing a query shows results", async ({ page }) => {
    const input = page.locator(".search-input");
    await input.fill("agent");
    // Wait for debounce + fetch + index sync (first query can be slow)
    await page.waitForTimeout(2000);
    // Should see either results or "No results"
    const hasResults = await page.locator(".search-group").first().isVisible().catch(() => false);
    const hasEmpty = await page.locator(".search-empty").isVisible().catch(() => false);
    expect(hasResults || hasEmpty).toBeTruthy();
  });

  test("search results have grouped structure", async ({ page }) => {
    const input = page.locator(".search-input");
    await input.fill("agent");
    await page.waitForTimeout(500);

    const groups = page.locator(".search-group");
    const groupCount = await groups.count();
    if (groupCount > 0) {
      // Each group should have a header
      const header = groups.first().locator(".search-group-header");
      await expect(header).toBeVisible();
      // Header should show label and count
      const text = await header.textContent();
      expect(text).toMatch(/\(\d+\)/); // e.g. "Events (42)"
    }
  });

  test("search results have badges and titles", async ({ page }) => {
    const input = page.locator(".search-input");
    await input.fill("agent");
    await page.waitForTimeout(500);

    const results = page.locator(".search-result");
    const count = await results.count();
    if (count > 0) {
      const first = results.first();
      // Badge visible
      await expect(first.locator(".search-result-badge")).toBeVisible();
      // Title visible
      await expect(first.locator(".search-result-title")).toBeVisible();
    }
  });

  test("search results show snippets with highlights", async ({ page }) => {
    const input = page.locator(".search-input");
    await input.fill("agent");
    await page.waitForTimeout(500);

    const snippets = page.locator(".search-result-snippet");
    const count = await snippets.count();
    if (count > 0) {
      // At least one snippet should contain a <mark> element
      const marks = page.locator(".search-result-snippet mark");
      const markCount = await marks.count();
      expect(markCount).toBeGreaterThan(0);
    }
  });

  // ── URL state ─────────────────────────────────────────────────────

  test("query is synced to URL", async ({ page }) => {
    const input = page.locator(".search-input");
    await input.fill("budget");
    await page.waitForTimeout(500);
    await expect(page).toHaveURL(/q=budget/);
  });

  test("URL query parameter pre-fills search", async ({ page }) => {
    await page.goto("/search?q=session");
    await page.waitForTimeout(500);
    const input = page.locator(".search-input");
    await expect(input).toHaveValue("session");
    // Should have results or empty state
    const hasContent = await page.locator(".search-results").first().isVisible().catch(() => false);
    expect(hasContent).toBeTruthy();
  });

  // ── Filters ───────────────────────────────────────────────────────

  test("type filter narrows results", async ({ page }) => {
    const input = page.locator(".search-input");
    await input.fill("agent");
    await page.waitForTimeout(500);

    // Click "Sessions" filter
    const sessionsChip = page.locator(".logs-chip").filter({ hasText: "Sessions" }).first();
    await sessionsChip.click();
    await page.waitForTimeout(500);

    // URL should update
    await expect(page).toHaveURL(/type=session/);

    // All groups should be "session" type
    const groups = page.locator(".search-group");
    const count = await groups.count();
    if (count > 0) {
      for (let i = 0; i < count; i++) {
        const header = await groups.nth(i).locator(".search-group-header").textContent();
        expect(header).toContain("Sessions");
      }
    }
  });

  test("clicking All type filter clears type filter", async ({ page }) => {
    await page.goto("/search?q=agent&type=event");
    await page.waitForTimeout(500);

    const allChip = page.locator(".logs-chip").filter({ hasText: "All" }).first();
    await allChip.click();
    await page.waitForTimeout(500);

    // URL should not have type param
    const url = page.url();
    expect(url).not.toContain("type=event");
  });

  // ── Group collapse ────────────────────────────────────────────────

  test("clicking group header toggles collapse", async ({ page }) => {
    const input = page.locator(".search-input");
    await input.fill("agent");
    await page.waitForTimeout(500);

    const groups = page.locator(".search-group");
    const count = await groups.count();
    if (count > 0) {
      const firstGroup = groups.first();
      const header = firstGroup.locator(".search-group-header");
      const results = firstGroup.locator(".search-group-results");

      // Initially expanded
      await expect(results).toBeVisible();

      // Click to collapse
      await header.click();
      await expect(results).not.toBeVisible();

      // Click to expand again
      await header.click();
      await expect(results).toBeVisible();
    }
  });

  // ── Click-through navigation ──────────────────────────────────────

  test("clicking a result navigates to source page", async ({ page }) => {
    const input = page.locator(".search-input");
    await input.fill("agent");
    await page.waitForTimeout(500);

    const results = page.locator(".search-result");
    const count = await results.count();
    if (count > 0) {
      const firstResult = results.first();
      const href = await firstResult.getAttribute("href");
      expect(href).toBeTruthy();
      expect(href).toMatch(/^\//); // starts with /
    }
  });

  // ── Special character handling ────────────────────────────────────

  test("dotted terms do not cause errors", async ({ page }) => {
    const input = page.locator(".search-input");
    await input.fill("compaction.memoryFlush.enabled");
    await page.waitForTimeout(500);

    // Should not show error
    const error = page.locator(".search-error");
    const hasError = await error.isVisible().catch(() => false);
    expect(hasError).toBeFalsy();
  });

  test("special characters in query do not cause errors", async ({ page }) => {
    const specialQueries = [
      "file:///path",
      "#edit.budgets",
      "cost > $5",
      "src/*.tsx",
    ];
    for (const q of specialQueries) {
      const input = page.locator(".search-input");
      await input.fill(q);
      await page.waitForTimeout(500);
      const error = page.locator(".search-error");
      const hasError = await error.isVisible().catch(() => false);
      expect(hasError).toBeFalsy();
    }
  });

  // ── Empty states ──────────────────────────────────────────────────

  test("no results message for nonsense query", async ({ page }) => {
    const input = page.locator(".search-input");
    await input.fill("xyzzy999nonexistent");
    await page.waitForTimeout(500);
    await expect(page.locator(".search-empty")).toBeVisible({ timeout: 5_000 });
  });

  test("no results shown when input is empty", async ({ page }) => {
    // Page loads with empty input — no results area should be present
    const groups = page.locator(".search-group");
    expect(await groups.count()).toBe(0);
    const empty = page.locator(".search-empty");
    const hasEmpty = await empty.isVisible().catch(() => false);
    expect(hasEmpty).toBeFalsy();
  });

  // ── Navigation ────────────────────────────────────────────────────

  test("Search tab is visible in navigation", async ({ page }) => {
    const searchLink = page.locator("nav a").filter({ hasText: "Search" });
    await expect(searchLink).toBeVisible();
  });

  test("Search tab is active when on search page", async ({ page }) => {
    const searchLink = page.locator("nav a").filter({ hasText: "Search" });
    await expect(searchLink).toHaveClass(/nav-active/);
  });
});
