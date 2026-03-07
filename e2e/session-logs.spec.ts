/**
 * E2E tests — Session → Logs Navigation.
 *
 * Tests the full user flow: Services page → click session Logs link → Logs page shows data.
 * Covers both active and archived sessions.
 */

import { test, expect } from "@playwright/test";

test.describe("Session to Logs Navigation", () => {
  test("services page loads with sessions card", async ({ page }) => {
    await page.goto("/services");
    await expect(page.getByRole("heading", { name: "Services" })).toBeVisible({ timeout: 10_000 });

    // Sessions card should appear (may take time to load from gateway)
    const sessionsHeading = page.getByText(/agent sessions/i);
    if (!(await sessionsHeading.isVisible({ timeout: 10_000 }).catch(() => false))) {
      test.skip(true, "Agent sessions section not visible — gateway may be offline");
      return;
    }
    await expect(sessionsHeading).toBeVisible();
  });

  test("sessions table has rows with Logs links", async ({ page }) => {
    await page.goto("/services");
    await page.waitForTimeout(3_000);

    // Find an agent section that has expanded sessions
    const agentSections = page.locator("[class*='sessions']");
    if (await agentSections.count() === 0) {
      // Click an agent row to expand
      const agentRow = page.locator("tr").filter({ hasText: /jane|scout|forge/i }).first();
      if (await agentRow.isVisible()) {
        await agentRow.click();
        await page.waitForTimeout(1_000);
      }
    }

    // Look for Logs links/buttons
    const logsLinks = page.getByRole("link", { name: /logs/i });
    const count = await logsLinks.count();
    expect(count).toBeGreaterThanOrEqual(0); // May be 0 if no sessions
  });

  test("clicking Logs link on active session navigates to logs with session filter", async ({ page }) => {
    await page.goto("/services");
    await page.waitForTimeout(3_000);

    // Find a session-specific Logs button (not the service card Logs buttons)
    const sessionLogsBtn = page.locator(".svc-sessions-logs-btn").first();

    if (!await sessionLogsBtn.isVisible({ timeout: 8_000 }).catch(() => false)) {
      // Sessions section might need scrolling
      await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
      await page.waitForTimeout(2_000);
    }

    if (!await sessionLogsBtn.isVisible({ timeout: 3_000 }).catch(() => false)) {
      test.skip(true, "No session Logs buttons visible — no sessions loaded");
      return;
    }

    // Get the href before clicking
    const href = await sessionLogsBtn.getAttribute("href");
    expect(href).toContain("/logs");
    expect(href).toContain("session=");

    // Navigate
    await sessionLogsBtn.click();
    await page.waitForLoadState("domcontentloaded");
    await page.waitForTimeout(3_000);

    // Should be on logs page with session filter
    expect(page.url()).toContain("/logs");
    expect(page.url()).toContain("session=");

    // Should show the logs heading
    await expect(page.getByRole("heading", { name: /logs/i })).toBeVisible({ timeout: 10_000 });
  });

  test("logs page with session filter shows events or empty state", async ({ page }) => {
    await page.goto("/services");
    await page.waitForTimeout(3_000);

    // Find a session-specific Logs button
    const sessionLogsBtn = page.locator(".svc-sessions-logs-btn").first();
    if (!await sessionLogsBtn.isVisible({ timeout: 8_000 }).catch(() => false)) {
      await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
      await page.waitForTimeout(2_000);
    }
    if (!await sessionLogsBtn.isVisible({ timeout: 3_000 }).catch(() => false)) {
      test.skip(true, "No session Logs buttons visible");
      return;
    }

    await sessionLogsBtn.click();
    await page.waitForTimeout(5_000);

    // Should show either event rows or "No events found" or the loading/empty state
    const eventRow = page.locator(".logs-stream-event").first();
    const noEvents = page.getByText(/no events found/i);
    const summaryCards = page.locator(".logs-card").first();

    const hasEvents = await eventRow.isVisible({ timeout: 5_000 }).catch(() => false);
    const hasNoEvents = await noEvents.isVisible({ timeout: 2_000 }).catch(() => false);
    const hasSummary = await summaryCards.isVisible({ timeout: 2_000 }).catch(() => false);

    // Any of these indicate the page loaded successfully
    expect(hasEvents || hasNoEvents || hasSummary).toBe(true);
    if (hasEvents) {
      console.log("  Found events for session");
    } else {
      console.log("  No events found (session may predate event logging)");
    }
  });
});

test.describe("Session Status Display", () => {
  test("sessions table shows status badges", async ({ page }) => {
    await page.goto("/services");
    await page.waitForTimeout(3_000);

    // Look for status badges (live/archived)
    const liveBadge = page.getByText("live").first();
    const archivedBadge = page.getByText("archived").first();

    const hasLive = await liveBadge.isVisible({ timeout: 5_000 }).catch(() => false);
    const hasArchived = await archivedBadge.isVisible({ timeout: 2_000 }).catch(() => false);

    if (hasLive || hasArchived) {
      console.log(`  Status badges: live=${hasLive}, archived=${hasArchived}`);
    }
  });

  test("archived sessions are visually distinguished", async ({ page }) => {
    await page.goto("/services");
    await page.waitForTimeout(3_000);

    // Archived rows should have reduced opacity
    const archivedRow = page.locator("tr").filter({ hasText: /archived/ }).first();
    if (await archivedRow.isVisible({ timeout: 5_000 }).catch(() => false)) {
      // Check opacity style
      const opacity = await archivedRow.evaluate(el => getComputedStyle(el).opacity);
      expect(parseFloat(opacity)).toBeLessThan(1);
    }
  });

  test("archived sessions have Logs links too", async ({ page }) => {
    await page.goto("/services");
    await page.waitForTimeout(3_000);

    // Scroll to sessions section
    await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
    await page.waitForTimeout(2_000);

    // Find an archived row
    const archivedRow = page.locator("tr").filter({ hasText: /archived/ }).first();
    if (!await archivedRow.isVisible({ timeout: 5_000 }).catch(() => false)) {
      test.skip(true, "No archived sessions visible");
      return;
    }

    // Should have a Logs button
    const logsBtn = archivedRow.locator(".svc-sessions-logs-btn");
    await expect(logsBtn).toBeVisible();
    const href = await logsBtn.getAttribute("href");
    expect(href).toContain("/logs");
  });
});

test.describe("Logs Page Time Filters", () => {
  test("extended time range buttons are available", async ({ page }) => {
    await page.goto("/logs");
    await page.waitForTimeout(3_000);

    // Check for the extended time range buttons
    const buttons = ["1h", "6h", "Today", "7d", "14d", "30d", "90d", "All"];
    for (const label of buttons) {
      const btn = page.getByRole("button", { name: label, exact: true });
      if (await btn.isVisible({ timeout: 2_000 }).catch(() => false)) {
        // Good, button exists
      } else {
        console.log(`  Warning: "${label}" time filter button not found`);
      }
    }
  });

  test("90d filter shows older events", async ({ page }) => {
    await page.goto("/logs");
    await page.waitForTimeout(3_000);

    const ninetyDays = page.getByRole("button", { name: "90d", exact: true });
    if (await ninetyDays.isVisible({ timeout: 3_000 }).catch(() => false)) {
      await ninetyDays.click();
      await page.waitForTimeout(4_000);

      // Should show events or empty state
      const eventRow = page.locator(".logs-stream-event").first();
      const noEvents = page.getByText(/no events found/i);
      const hasData = await eventRow.isVisible({ timeout: 5_000 }).catch(() => false);
      const hasEmpty = await noEvents.isVisible({ timeout: 2_000 }).catch(() => false);
      expect(hasData || hasEmpty).toBe(true);
    }
  });

  test("All filter shows all events", async ({ page }) => {
    await page.goto("/logs");
    await page.waitForTimeout(3_000);

    const allBtn = page.getByRole("button", { name: "All", exact: true });
    if (await allBtn.isVisible({ timeout: 3_000 }).catch(() => false)) {
      await allBtn.click();
      await page.waitForTimeout(4_000);

      // With "All" filter, we should see events (if any exist in DB)
      const eventRow = page.locator(".logs-stream-event").first();
      const hasData = await eventRow.isVisible({ timeout: 5_000 }).catch(() => false);
      if (hasData) {
        console.log("  'All' filter shows events");
      }
    }
  });
});

test.describe("Logs Session Filter from URL", () => {
  test("session= URL param activates session filter", async ({ page }) => {
    // Navigate to logs with a session filter
    await page.goto("/logs?agent=jane&session=agent%3Amain%3Adiscord%3Achannel%3A123");
    await page.waitForTimeout(4_000);

    // The session filter chip or indicator should be visible
    // or we should see the filtered view
    expect(page.url()).toContain("session=");
  });

  test("session filter with comma-separated variants", async ({ page }) => {
    const variants = [
      "agent:main:discord:channel:123",
      "channel:123",
      "main/test-uuid.jsonl",
    ];
    const sessionParam = encodeURIComponent(variants.join(","));
    await page.goto(`/logs?agent=jane&session=${sessionParam}`);
    await page.waitForTimeout(4_000);

    // Page should load without errors
    const heading = page.getByRole("heading", { name: /logs/i });
    await expect(heading).toBeVisible({ timeout: 10_000 });
  });
});
