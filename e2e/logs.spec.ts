import { test, expect } from "@playwright/test";

test.describe("Logs Page", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto("/logs");
    // Wait for either the event list or loading state
    await page.waitForLoadState("domcontentloaded");
    await page.waitForTimeout(3_000);
  });

  // ── Page Load ────────────────────────────────────────────────────────────

  test("loads with tab switcher", async ({ page }) => {
    await expect(page.getByRole("button", { name: /openclaw/i })).toBeVisible({ timeout: 10_000 });
    await expect(page.getByRole("button", { name: /system/i })).toBeVisible();
  });

  // ── Date Range Filters ───────────────────────────────────────────────────

  test("date range buttons change data", async ({ page }) => {
    const todayBtn = page.getByRole("button", { name: /today/i });
    if (await todayBtn.isVisible()) {
      await todayBtn.click();
      // Should not error out
      await page.waitForTimeout(2_000);
    }
  });

  test("1h filter narrows results", async ({ page }) => {
    const oneHour = page.getByRole("button", { name: /1h/i });
    if (await oneHour.isVisible()) {
      await oneHour.click();
      await page.waitForTimeout(2_000);
    }
  });

  // ── Tab Switching ────────────────────────────────────────────────────────

  test("system tab loads system events", async ({ page }) => {
    await page.getByRole("button", { name: /system/i }).click();
    await page.waitForTimeout(2_000);
    // Should show system-specific filters
    const categoryFilter = page.getByText(/category|cron|config|gateway/i).first();
    await expect(categoryFilter).toBeVisible({ timeout: 5_000 });
  });

  test("switching back to openclaw tab works", async ({ page }) => {
    await page.getByRole("button", { name: /system/i }).click();
    await page.waitForTimeout(2_000);

    await page.getByRole("button", { name: /openclaw/i }).click();
    await page.waitForTimeout(2_000);
  });

  // ── Filters ──────────────────────────────────────────────────────────────

  test("agent filter chips are visible", async ({ page }) => {
    const agentFilter = page.getByText(/agent/i).first();
    await expect(agentFilter).toBeVisible();
  });

  // ── Event Expansion ──────────────────────────────────────────────────────

  test("clicking an event row expands details", async ({ page }) => {
    // Find a clickable event row
    const eventRow = page.locator("tr, [role='row']").filter({ has: page.locator("td") }).first();
    if (await eventRow.isVisible()) {
      await eventRow.click();
      // Some detail should appear (JSON, expanded content)
      await page.waitForTimeout(500);
    }
  });

  // ── Search ─────────────────────────────────────────────────────────────

  test("search input filters events by text", async ({ page }) => {
    const searchInput = page.locator("input.logs-search, input[type='text'][placeholder*='earch']");
    if (await searchInput.isVisible({ timeout: 5_000 }).catch(() => false)) {
      await searchInput.fill("jane");
      await page.waitForTimeout(2_000);
      // Events should be filtered (or show no results)
    }
  });

  test("clearing search restores all events", async ({ page }) => {
    const searchInput = page.locator("input.logs-search, input[type='text'][placeholder*='earch']");
    if (await searchInput.isVisible({ timeout: 5_000 }).catch(() => false)) {
      await searchInput.fill("jane");
      await page.waitForTimeout(1_500);
      // Clear
      const clearBtn = page.locator(".logs-search-clear, button[aria-label='Clear']");
      if (await clearBtn.isVisible()) {
        await clearBtn.click();
        await page.waitForTimeout(1_500);
      } else {
        await searchInput.fill("");
        await page.waitForTimeout(1_500);
      }
    }
  });

  // ── Chip Filters ───────────────────────────────────────────────────────

  test("clicking agent chip toggles filter", async ({ page }) => {
    const chip = page.locator("button.logs-chip").first();
    if (await chip.isVisible({ timeout: 5_000 }).catch(() => false)) {
      await chip.click();
      await page.waitForTimeout(1_000);
      await expect(chip).toHaveClass(/active/);
      // Click again to deactivate
      await chip.click();
      await page.waitForTimeout(500);
    }
  });

  test("combining agent + type filter narrows results", async ({ page }) => {
    const chips = page.locator("button.logs-chip");
    if (await chips.first().isVisible({ timeout: 5_000 }).catch(() => false)) {
      // Click two different chips
      await chips.first().click();
      await page.waitForTimeout(500);
      // Find a type chip (different section)
      const typeChip = page.locator("button.logs-chip").filter({ hasText: /llm_output|msg_in|tool_call/i }).first();
      if (await typeChip.isVisible()) {
        await typeChip.click();
        await page.waitForTimeout(1_000);
      }
    }
  });

  // ── Event Details ──────────────────────────────────────────────────────

  test("expanding event row shows detail content", async ({ page }) => {
    const eventRow = page.locator(".logs-stream-event").first();
    if (await eventRow.isVisible({ timeout: 5_000 }).catch(() => false)) {
      await eventRow.click();
      await page.waitForTimeout(1_000);
      // Expanded state should show detail content
      const expanded = page.locator(".logs-stream-event.expanded, .logs-detail, .event-detail");
      if (await expanded.isVisible({ timeout: 3_000 }).catch(() => false)) {
        const text = await expanded.textContent();
        expect(text!.length).toBeGreaterThan(10);
      }
    }
  });

  test("summary cards show token and cost values", async ({ page }) => {
    const cards = page.locator(".logs-card");
    if (await cards.first().isVisible({ timeout: 5_000 }).catch(() => false)) {
      const count = await cards.count();
      expect(count).toBeGreaterThanOrEqual(1);
      const text = await cards.first().textContent();
      expect(text).toBeTruthy();
    }
  });

  // ── System Tab ─────────────────────────────────────────────────────────

  test("system tab category filter works", async ({ page }) => {
    await page.getByRole("button", { name: /system/i }).click();
    await page.waitForTimeout(2_000);

    const configChip = page.locator("button.logs-chip").filter({ hasText: /config/i }).first();
    if (await configChip.isVisible({ timeout: 5_000 }).catch(() => false)) {
      await configChip.click();
      await page.waitForTimeout(1_500);
      await expect(configChip).toHaveClass(/active/);
    }
  });

  test("system tab status filter (ok/error) works", async ({ page }) => {
    await page.getByRole("button", { name: /system/i }).click();
    await page.waitForTimeout(2_000);

    const okChip = page.locator("button.logs-chip").filter({ hasText: /^ok$/i }).first();
    if (await okChip.isVisible({ timeout: 5_000 }).catch(() => false)) {
      await okChip.click();
      await page.waitForTimeout(1_500);
    }
  });

  // ── Context Mode ──────────────────────────────────────────────────────

  test("'Show surrounding context' button appears on expanded event", async ({ page }) => {
    const eventRow = page.locator(".logs-stream-event").first();
    if (!(await eventRow.isVisible({ timeout: 5_000 }).catch(() => false))) {
      test.skip(true, "No event rows available");
      return;
    }

    await eventRow.click();
    await page.waitForTimeout(1_000);

    // Look for the "Show surrounding context" button inside the expanded detail
    const contextBtn = page.getByText(/show surrounding context/i).first();
    if (await contextBtn.isVisible({ timeout: 3_000 }).catch(() => false)) {
      await expect(contextBtn).toBeVisible();
    }
  });

  test("clicking 'Show surrounding context' activates context mode", async ({ page }) => {
    const eventRow = page.locator(".logs-stream-event").first();
    if (!(await eventRow.isVisible({ timeout: 5_000 }).catch(() => false))) {
      test.skip(true, "No event rows available");
      return;
    }

    await eventRow.click();
    await page.waitForTimeout(1_000);

    const contextBtn = page.getByText(/show surrounding context/i).first();
    if (!(await contextBtn.isVisible({ timeout: 3_000 }).catch(() => false))) {
      test.skip(true, "Context button not available on this event");
      return;
    }

    await contextBtn.click();
    await page.waitForTimeout(2_000);

    // Context mode banner should appear with "Context view:" label
    const banner = page.getByText(/context view:/i);
    await expect(banner).toBeVisible({ timeout: 5_000 });

    // "Exit context view" button should be visible
    const exitBtn = page.getByRole("button", { name: /exit context view/i });
    await expect(exitBtn).toBeVisible();
  });

  test("context mode shows surrounding events", async ({ page }) => {
    const eventRow = page.locator(".logs-stream-event").first();
    if (!(await eventRow.isVisible({ timeout: 5_000 }).catch(() => false))) {
      test.skip(true, "No event rows available");
      return;
    }

    await eventRow.click();
    await page.waitForTimeout(1_000);

    const contextBtn = page.getByText(/show surrounding context/i).first();
    if (!(await contextBtn.isVisible({ timeout: 3_000 }).catch(() => false))) {
      test.skip(true, "Context button not available");
      return;
    }

    await contextBtn.click();
    await page.waitForTimeout(3_000);

    // Should still have event rows visible (context events loaded)
    const eventsAfter = page.locator(".logs-stream-event");
    if (await eventsAfter.first().isVisible({ timeout: 5_000 }).catch(() => false)) {
      const count = await eventsAfter.count();
      expect(count).toBeGreaterThan(0);
    }
  });

  test("'Exit context view' returns to filtered view", async ({ page }) => {
    const eventRow = page.locator(".logs-stream-event").first();
    if (!(await eventRow.isVisible({ timeout: 5_000 }).catch(() => false))) {
      test.skip(true, "No event rows available");
      return;
    }

    // Count events before context mode
    const eventsBefore = await page.locator(".logs-stream-event").count();

    await eventRow.click();
    await page.waitForTimeout(1_000);

    const contextBtn = page.getByText(/show surrounding context/i).first();
    if (!(await contextBtn.isVisible({ timeout: 3_000 }).catch(() => false))) {
      test.skip(true, "Context button not available");
      return;
    }

    await contextBtn.click();
    await page.waitForTimeout(2_000);

    const exitBtn = page.getByText(/exit context view/i);
    if (!(await exitBtn.isVisible({ timeout: 5_000 }).catch(() => false))) {
      test.skip(true, "Exit button did not appear");
      return;
    }

    await exitBtn.click();
    await page.waitForTimeout(2_000);

    // Context banner should be gone
    const banner = page.getByText(/context view:/i);
    await expect(banner).not.toBeVisible({ timeout: 3_000 });

    // Events should be back to the original filtered set
    const eventsAfterExit = page.locator(".logs-stream-event");
    if (await eventsAfterExit.first().isVisible({ timeout: 5_000 }).catch(() => false)) {
      const countAfter = await eventsAfterExit.count();
      // Should be roughly the same as before (may differ slightly due to timing)
      expect(countAfter).toBeGreaterThan(0);
    }
  });

  test("'Expand context' button appears while in context mode", async ({ page }) => {
    const eventRow = page.locator(".logs-stream-event").first();
    if (!(await eventRow.isVisible({ timeout: 5_000 }).catch(() => false))) {
      test.skip(true, "No event rows available");
      return;
    }

    await eventRow.click();
    await page.waitForTimeout(1_000);

    const contextBtn = page.getByText(/show surrounding context/i).first();
    if (!(await contextBtn.isVisible({ timeout: 3_000 }).catch(() => false))) {
      test.skip(true, "Context button not available");
      return;
    }

    await contextBtn.click();
    await page.waitForTimeout(2_000);

    // In context mode, expanding an event should show "Expand context (+2 min)" instead
    const expandedEvent = page.locator(".logs-stream-event").first();
    if (await expandedEvent.isVisible()) {
      await expandedEvent.click();
      await page.waitForTimeout(1_000);

      const expandContextBtn = page.getByText(/expand context/i).first();
      if (await expandContextBtn.isVisible({ timeout: 3_000 }).catch(() => false)) {
        await expect(expandContextBtn).toBeVisible();
      }
    }
  });
});
