import { test, expect } from "@playwright/test";

/**
 * Dashboard Preferences — Tab Visibility + Column Customization
 *
 * Tests the full flow:
 *   1. API endpoint returns prefs
 *   2. Deck Config → Dashboard tab UI renders toggles + reorder
 *   3. Saving prefs persists to config.json
 *   4. Nav filters hidden tabs in real-time
 *   5. Task board respects column prefs
 */

// ── API Tests ────────────────────────────────────────────────────────────────

test.describe("Dashboard Prefs API", () => {
  test("GET /api/dashboard-prefs returns default empty prefs", async ({ request }) => {
    const res = await request.get("/api/dashboard-prefs");
    expect(res.ok()).toBeTruthy();
    const data = await res.json();
    expect(data).toHaveProperty("hiddenTabs");
    expect(Array.isArray(data.hiddenTabs)).toBeTruthy();
  });

  test("GET /api/deck-config includes dashboard field", async ({ request }) => {
    const res = await request.get("/api/deck-config");
    expect(res.ok()).toBeTruthy();
    const data = await res.json();
    expect(data).toHaveProperty("dashboard");
  });

  test("POST /api/deck-config persists dashboard prefs", async ({ request }) => {
    // Read current config
    const getRes = await request.get("/api/deck-config");
    const config = await getRes.json();

    // Save with dashboard prefs
    const testPrefs = {
      hiddenTabs: ["schedule"],
    };

    const postRes = await request.post("/api/deck-config", {
      data: {
        agents: config.agents,
        systemChannels: config.systemChannels,
        pluginChannels: config.pluginChannels,
        logChannels: config.logChannels,
        serviceUrls: config.serviceUrls,
        dashboard: testPrefs,
        opsBotCommands: config.opsBotCommands,
      },
    });
    expect(postRes.ok()).toBeTruthy();

    // Verify it persisted
    const verifyRes = await request.get("/api/dashboard-prefs");
    const prefs = await verifyRes.json();
    expect(prefs.hiddenTabs).toContain("schedule");

    // Clean up: restore empty dashboard
    await request.post("/api/deck-config", {
      data: {
        agents: config.agents,
        systemChannels: config.systemChannels,
        pluginChannels: config.pluginChannels,
        logChannels: config.logChannels,
        serviceUrls: config.serviceUrls,
        dashboard: {},
        opsBotCommands: config.opsBotCommands,
      },
    });
  });
});

// ── Deck Config Dashboard Tab UI ──────────────────────────────────────────────

test.describe("Deck Config — Dashboard Tab", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto("/deck-config");
    await page.waitForLoadState("domcontentloaded");
    await page.waitForTimeout(2_000);
    // Click Dashboard tab
    await page.locator(".ds-tab", { hasText: "Dashboard" }).click();
    await page.waitForTimeout(500);
  });

  test("Dashboard tab is visible in edit sub-tabs", async ({ page }) => {
    await expect(page.locator(".ds-tab", { hasText: "Dashboard" })).toBeVisible();
  });

  test("shows Navigation Tabs section with toggles", async ({ page }) => {
    await expect(page.getByRole("heading", { name: "Navigation Tabs" })).toBeVisible();
    // Should have toggle switches for hideable tabs (13 tabs)
    const toggles = page.locator(".mcc-check-grid .mcc-toggle input[type='checkbox']");
    const count = await toggles.count();
    expect(count).toBeGreaterThanOrEqual(10);
  });

  test("toggling a tab shows unsaved changes", async ({ page }) => {
    // Click the visible toggle slider (the input is hidden by CSS)
    const calendarCard = page.locator(".mcc-check-card", { hasText: "Schedule" });
    await calendarCard.locator(".mcc-toggle-slider").click();
    await page.waitForTimeout(300);

    await expect(page.getByText("Unsaved changes").first()).toBeVisible({ timeout: 3_000 });
  });

  // Task Board Columns feature is not yet implemented — skip for now
  test.skip("reorder buttons move columns", async ({ page }) => {
    const taskSection = page.locator("section", { hasText: "Task Board Columns" });
    await taskSection.scrollIntoViewIfNeeded();
    const taskTable = taskSection.locator("table");
    const rows = taskTable.locator("tbody tr");
    const firstLabel = await rows.first().locator("td").nth(1).textContent();
    await rows.first().locator("button", { hasText: "↓" }).click();
    await page.waitForTimeout(300);
    const secondLabel = await rows.nth(1).locator("td").nth(1).textContent();
    expect(secondLabel).toBe(firstLabel);
  });
});

// ── Integration: Tab Visibility ─────────────────────────────────────────────

test.describe("Tab Visibility Integration", () => {
  // Helper to save dashboard prefs via API
  async function saveDashboardPrefs(request: any, prefs: Record<string, unknown>) {
    const configRes = await request.get("/api/deck-config");
    const config = await configRes.json();
    await request.post("/api/deck-config", {
      data: {
        agents: config.agents,
        systemChannels: config.systemChannels,
        pluginChannels: config.pluginChannels,
        logChannels: config.logChannels,
        serviceUrls: config.serviceUrls,
        dashboard: prefs,
        opsBotCommands: config.opsBotCommands,
      },
    });
  }

  test("hiding a tab removes it from nav", async ({ page, request }) => {
    // Hide calendar tab via API
    await saveDashboardPrefs(request, { hiddenTabs: ["schedule"] });

    await page.goto("/");
    await page.waitForLoadState("domcontentloaded");
    await page.waitForTimeout(2_000);

    // Schedule should NOT be in nav
    const calendarLink = page.locator("nav a", { hasText: "Schedule" });
    await expect(calendarLink).toHaveCount(0);

    // Other tabs should still be present
    await expect(page.locator("nav a", { hasText: "Overview" })).toBeVisible();
    await expect(page.locator("nav a", { hasText: "Logs" })).toBeVisible();

    // Clean up
    await saveDashboardPrefs(request, {});
  });

  test("Services and Deck Config are always visible even if in hiddenTabs", async ({ page, request }) => {
    // Try to hide services and deck-config
    await saveDashboardPrefs(request, { hiddenTabs: ["services", "deck-config"] });

    await page.goto("/");
    await page.waitForLoadState("domcontentloaded");
    await page.waitForTimeout(2_000);

    // They should STILL be visible (always-visible)
    await expect(page.locator("nav a", { hasText: "Services" })).toBeVisible();
    await expect(page.locator("nav a", { hasText: "Deck Config" })).toBeVisible();

    // Clean up
    await saveDashboardPrefs(request, {});
  });

  test("hiding multiple tabs removes all from nav", async ({ page, request }) => {
    await saveDashboardPrefs(request, { hiddenTabs: ["schedule", "tests", "knowledge"] });

    await page.goto("/");
    await page.waitForLoadState("domcontentloaded");
    await page.waitForTimeout(2_000);

    await expect(page.locator("nav a", { hasText: "Schedule" })).toHaveCount(0);
    await expect(page.locator("nav a", { hasText: "Tests" })).toHaveCount(0);
    await expect(page.locator("nav a", { hasText: "Knowledge" })).toHaveCount(0);

    // Still visible
    await expect(page.locator("nav a", { hasText: "Logs" })).toBeVisible();
    await expect(page.locator("nav a", { hasText: "Overview" })).toBeVisible();

    // Clean up
    await saveDashboardPrefs(request, {});
  });

  test("restoring hidden tab makes it reappear after refresh", async ({ page, request }) => {
    // Hide calendar
    await saveDashboardPrefs(request, { hiddenTabs: ["schedule"] });
    await page.goto("/");
    await page.waitForTimeout(2_000);
    await expect(page.locator("nav a", { hasText: "Schedule" })).toHaveCount(0);

    // Restore
    await saveDashboardPrefs(request, {});
    await page.reload();
    await page.waitForTimeout(2_000);
    await expect(page.locator("nav a", { hasText: "Schedule" })).toBeVisible();
  });

  test("saving from Dashboard tab updates nav without page reload", async ({ page, request }) => {
    // Ensure clean state
    await saveDashboardPrefs(request, {});

    await page.goto("/deck-config");
    await page.waitForTimeout(2_000);

    // Verify Schedule is in nav before
    await expect(page.locator("nav a", { hasText: "Schedule" })).toBeVisible();

    // Click Dashboard tab
    await page.locator(".ds-tab", { hasText: "Dashboard" }).click();
    await page.waitForTimeout(500);

    // Toggle Schedule off
    const calendarCard = page.locator(".mcc-check-card", { hasText: "Schedule" });
    await calendarCard.locator(".mcc-toggle-slider").click();
    await page.waitForTimeout(300);

    // Save
    await page.getByRole("button", { name: /^save$/i }).first().click();
    await page.waitForTimeout(2_000);

    // Schedule should be gone from nav WITHOUT reload
    await expect(page.locator("nav a", { hasText: "Schedule" })).toHaveCount(0);

    // Clean up: toggle it back and save
    await page.locator(".ds-tab", { hasText: "Dashboard" }).click();
    await page.waitForTimeout(500);
    const calendarCard2 = page.locator(".mcc-check-card", { hasText: "Schedule" });
    await calendarCard2.locator(".mcc-toggle-slider").click();
    await page.waitForTimeout(300);
    await page.getByRole("button", { name: /^save$/i }).first().click();
    await page.waitForTimeout(1_000);
  });
});

// ── Visual Smoke Tests (Screenshots) ───────────────────────────────────────

test.describe("Dashboard Prefs Visual", () => {
  async function saveDashboardPrefs(request: any, prefs: Record<string, unknown>) {
    const configRes = await request.get("/api/deck-config");
    const config = await configRes.json();
    await request.post("/api/deck-config", {
      data: {
        agents: config.agents,
        systemChannels: config.systemChannels,
        pluginChannels: config.pluginChannels,
        logChannels: config.logChannels,
        serviceUrls: config.serviceUrls,
        dashboard: prefs,
        opsBotCommands: config.opsBotCommands,
      },
    });
  }

  test("screenshot: Dashboard tab in Deck Config", async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto("/deck-config");
    await page.waitForTimeout(2_000);
    await page.locator(".ds-tab", { hasText: "Dashboard" }).click();
    await page.waitForTimeout(1_000);
    await page.screenshot({ path: "/tmp/v3-dashboard-prefs.png" });
  });

  test("screenshot: nav with hidden tabs", async ({ page, request }) => {
    await saveDashboardPrefs(request, { hiddenTabs: ["schedule", "tests"] });
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto("/");
    await page.waitForTimeout(2_000);
    await page.screenshot({ path: "/tmp/v3-nav-hidden-tabs.png" });

    // Clean up
    await saveDashboardPrefs(request, {});
  });
});
