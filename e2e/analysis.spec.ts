import { test, expect } from "@playwright/test";

test.describe("Analysis Page", () => {
  test("shows Sessions, Outcomes, and Deliverables tabs", async ({ page }) => {
    await page.goto("/analysis");
    await expect(page.locator(".ds-tabs")).toBeVisible({ timeout: 15000 });
    await expect(page.locator(".ds-tab", { hasText: "Sessions" })).toBeVisible();
    await expect(page.locator(".ds-tab", { hasText: "Outcomes" })).toBeVisible();
    await expect(page.locator(".ds-tab", { hasText: "Deliverables" })).toBeVisible();
    await expect(page.locator(".ds-tab.active")).toContainText("Sessions");
  });

  test("Sessions tab loads session picker with agent chips", async ({ page }) => {
    await page.goto("/analysis");
    // Wait for tabs to appear, then wait for sessions to load (agent chips appear after fetch)
    await expect(page.locator(".ds-tabs")).toBeVisible({ timeout: 15000 });
    await expect(page.locator(".logs-chip").first()).toBeVisible({ timeout: 15000 });
    const chips = page.locator(".logs-chip");
    const count = await chips.count();
    expect(count).toBeGreaterThan(1);
  });

  test("Outcomes tab loads and shows outcomes", async ({ page }) => {
    await page.goto("/analysis#outcomes");

    // Wait for Outcomes tab to be active and content to load
    await expect(page.locator(".logs-filter-label").filter({ hasText: "Agent" })).toBeVisible({ timeout: 15000 });
    await expect(page.locator(".logs-filter-label").filter({ hasText: "Type" })).toBeVisible();
    await expect(page.locator(".logs-filter-label").filter({ hasText: "Time Range" })).toBeVisible();

    // Should show outcome rows
    const outcomeRows = page.locator(".si-region");
    await expect(outcomeRows.first()).toBeVisible({ timeout: 15000 });
    const rowCount = await outcomeRows.count();
    expect(rowCount).toBeGreaterThan(0);
  });

  test("Outcomes tab filters by agent", async ({ page }) => {
    await page.goto("/analysis#outcomes");
    await expect(page.locator(".logs-filter-label").filter({ hasText: "Agent" })).toBeVisible({ timeout: 15000 });
    await expect(page.locator(".si-region").first()).toBeVisible({ timeout: 15000 });

    // Get agent chips from the Agent filter group
    const agentGroup = page.locator(".logs-filter-group").filter({ hasText: /^Agent/ });
    const agentChips = agentGroup.locator(".logs-chip");
    const chipCount = await agentChips.count();
    if (chipCount > 1) {
      await agentChips.nth(1).click();
      await page.waitForTimeout(1000);
      await expect(agentChips.nth(1)).toHaveClass(/active/);
    }
  });

  test("clicking outcome arrow navigates to session analysis", async ({ page }) => {
    await page.goto("/analysis#outcomes");
    await expect(page.locator(".si-region").first()).toBeVisible({ timeout: 15000 });

    // Click the arrow button (not the row itself — row text is selectable)
    await page.locator(".si-outcome-link").first().click();
    await page.waitForURL(/session=/, { timeout: 10000 });

    await expect(
      page.locator(".si-score-card--overall, .si-loading, .si-error").first(),
    ).toBeVisible({ timeout: 15000 });
  });

  test("deep link with filters works", async ({ page }) => {
    await page.goto("/analysis#outcomes&agent=scout&type=file_written");
    // Outcomes tab should be active
    await expect(page.locator(".ds-tab.active")).toContainText("Outcomes", { timeout: 15000 });
    // Agent "scout" chip should be active
    const agentGroup = page.locator(".logs-filter-group").filter({ hasText: /^Agent/ });
    await expect(agentGroup.locator(".logs-chip.active")).toContainText("scout", { timeout: 10000 });
    // Type "File Written" chip should be active
    const typeGroup = page.locator(".logs-filter-group").filter({ hasText: /^Type/ });
    await expect(typeGroup.locator(".logs-chip.active")).toContainText("File Written", { timeout: 5000 });
  });

  test("Deliverables tab loads and shows grouped deliverables", async ({ page }) => {
    await page.goto("/analysis#deliverables");
    await expect(page.locator(".ds-tab.active")).toContainText("Deliverables", { timeout: 15000 });

    // Should show agent chips
    await expect(page.locator(".logs-filter-label").filter({ hasText: "Agent" })).toBeVisible({ timeout: 15000 });
    await expect(page.locator(".logs-chip").first()).toBeVisible({ timeout: 15000 });

    // Should show deliverable groups
    await expect(page.locator(".si-deliverable-group").first()).toBeVisible({ timeout: 15000 });
    const groupCount = await page.locator(".si-deliverable-group").count();
    expect(groupCount).toBeGreaterThan(0);

    // Each group should have a main deliverable with a star
    await expect(page.locator(".si-deliverable-star").first()).toBeVisible();
  });

  test("Deliverables tab filters by agent", async ({ page }) => {
    await page.goto("/analysis#deliverables");
    await expect(page.locator(".si-deliverable-group").first()).toBeVisible({ timeout: 15000 });

    // Click a specific agent chip (not "All")
    const agentChips = page.locator(".logs-filter-group").filter({ hasText: /^Agent/ }).locator(".logs-chip");
    const chipCount = await agentChips.count();
    if (chipCount > 1) {
      const agentName = await agentChips.nth(1).textContent();
      await agentChips.nth(1).click();
      await page.waitForTimeout(1000);
      await expect(agentChips.nth(1)).toHaveClass(/active/);
      // All visible groups should be for that agent
      const groups = page.locator(".si-deliverable-agent");
      const count = await groups.count();
      for (let i = 0; i < Math.min(count, 5); i++) {
        await expect(groups.nth(i)).toContainText(agentName!.trim());
      }
    }
  });

  test("Deliverables group arrow navigates to detail view", async ({ page }) => {
    await page.goto("/analysis#deliverables");
    await expect(page.locator(".si-deliverable-group").first()).toBeVisible({ timeout: 15000 });

    await page.locator(".si-deliverable-group .si-outcome-link").first().click();
    await page.waitForURL(/deliverable=/, { timeout: 10000 });

    // Should show detail view with outputs section or loading state
    await expect(
      page.locator(".si-detail-section-title, .si-loading, .si-error").first(),
    ).toBeVisible({ timeout: 15000 });
  });

  test("clicking a session loads analysis with history", async ({ page }) => {
    await page.goto("/analysis");
    await expect(page.locator(".ds-tabs")).toBeVisible({ timeout: 15000 });
    // Wait for sessions to load
    await expect(page.locator(".logs-chip").first()).toBeVisible({ timeout: 15000 });
    await expect(page.locator(".si-region").first()).toBeVisible({ timeout: 10000 });

    await page.locator(".si-region").first().click();

    await expect(page.locator(".si-section-title").filter({ hasText: "Analysis History" })).toBeVisible({ timeout: 15000 });
    await expect(page.locator(".si-history-card").first()).toBeVisible({ timeout: 10000 });
    await expect(page.locator(".si-score-card--overall")).toBeVisible();
  });
});
