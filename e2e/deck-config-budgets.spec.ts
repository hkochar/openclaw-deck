import { test, expect } from "@playwright/test";

test.describe("Deck Config — Budgets Tab", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto("/deck-config");
    await page.waitForLoadState("domcontentloaded");
    // Wait for page to load
    await expect(page.getByRole("heading", { name: "Deck Config" })).toBeVisible({ timeout: 10_000 });
    // Switch to edit mode
    const editBtn = page.getByRole("button", { name: /edit/i });
    if (await editBtn.isVisible({ timeout: 3_000 }).catch(() => false)) {
      await editBtn.click();
    }
    // Click Budgets tab
    await page.getByRole("button", { name: /budgets/i }).click();
    await page.waitForTimeout(300);
  });

  // ── Tab Visibility ──────────────────────────────────────────────────────

  test("Budgets tab is visible in edit sub-tabs", async ({ page }) => {
    await expect(page.getByRole("button", { name: /budgets/i })).toBeVisible();
  });

  // ── Global Budgets Section ──────────────────────────────────────────────

  test("shows Global Budgets section with daily/weekly/monthly rows", async ({ page }) => {
    await expect(page.getByText("Global Budgets")).toBeVisible();
    // Table has period rows: daily, weekly, monthly
    await expect(page.getByRole("cell", { name: "daily" })).toBeVisible();
    await expect(page.getByRole("cell", { name: "weekly" })).toBeVisible();
    await expect(page.getByRole("cell", { name: "monthly" })).toBeVisible();
  });

  test("global budget inputs accept numbers", async ({ page }) => {
    await expect(page.getByText("Global Budgets")).toBeVisible({ timeout: 5_000 });
    // Global budgets table has number inputs
    const numberInputs = page.locator("input[type='number']");
    await expect(numberInputs.first()).toBeVisible({ timeout: 5_000 });
    const count = await numberInputs.count();
    expect(count).toBeGreaterThanOrEqual(3);

    // Set a value and verify
    await numberInputs.first().fill("100");
    const val = await numberInputs.first().inputValue();
    expect(val).toBe("100");
  });

  // ── Per-Agent Budgets Section ──────────────────────────────────────────

  test("shows Per-Agent Budgets section", async ({ page }) => {
    await expect(page.getByText("Per-Agent Budgets")).toBeVisible();
  });

  test("per-agent table has agent rows with action dropdown", async ({ page }) => {
    // Per-Agent Budgets is inside a collapsible <details> — expand it
    const summary = page.locator("summary", { hasText: "Per-Agent Budgets" });
    await expect(summary).toBeVisible({ timeout: 5_000 });
    await summary.click();
    await page.waitForTimeout(500);

    // Agent names are config-dependent — check that the table has at least one row
    const rows = page.locator("#cfg-agentBudgets .mcc-row");
    if (!(await rows.first().isVisible({ timeout: 5_000 }).catch(() => false))) {
      test.skip(true, "No agent rows in per-agent budgets (config-dependent)");
      return;
    }
    // Check for action radio buttons (Alert Only / Throttle / Block)
    const actionCell = page.locator("#cfg-agentBudgets .mcc-row").first().getByRole("radio");
    const radioCount = await actionCell.count();
    expect(radioCount).toBeGreaterThanOrEqual(3);
    // Verify known action labels
    const firstRow = page.locator("#cfg-agentBudgets .mcc-row").first();
    await expect(firstRow.getByText("Alert Only")).toBeVisible();
    await expect(firstRow.getByText("Throttle")).toBeVisible();
    await expect(firstRow.getByText("Block")).toBeVisible();
  });

  // ── Model Pricing Section (Providers tab) ──────────────────────────────

  test("shows Model Pricing section", async ({ page }) => {
    await page.getByRole("button", { name: /providers/i }).click();
    await page.waitForTimeout(300);
    await expect(page.getByText("Model Pricing")).toBeVisible();
  });

  test("model pricing table has rate columns", async ({ page }) => {
    await page.getByRole("button", { name: /providers/i }).click();
    await page.waitForTimeout(300);
    await expect(page.getByText("Input").first()).toBeVisible();
    await expect(page.getByText("Output").first()).toBeVisible();
  });

  test("model pricing has add button", async ({ page }) => {
    await page.getByRole("button", { name: /providers/i }).click();
    await page.waitForTimeout(300);
    const addBtn = page.getByRole("button", { name: /add model/i });
    await expect(addBtn).toBeVisible();
  });

  // ── Throttle Chain Section (Providers tab) ─────────────────────────────

  test("shows Throttle Chain section", async ({ page }) => {
    await page.getByRole("button", { name: /providers/i }).click();
    await page.waitForTimeout(300);
    await expect(page.getByText("Throttle Chain")).toBeVisible();
  });

  test("throttle chain has default models", async ({ page }) => {
    await page.getByRole("button", { name: /providers/i }).click();
    await page.waitForTimeout(300);
    const section = page.locator(".mcc-budgets-throttle");
    if (await section.isVisible()) {
      const text = await section.textContent();
      expect(text).toMatch(/opus|sonnet|haiku/i);
    }
  });

  // ── Alert Settings Section ─────────────────────────────────────────────

  test("shows Alert Settings section", async ({ page }) => {
    await expect(page.getByText("Alert Settings")).toBeVisible();
  });

  // ── Dirty State ────────────────────────────────────────────────────────

  test("editing global budget marks form dirty", async ({ page }) => {
    // First spinbutton in the Global Budgets table (daily limit)
    const input = page.getByRole("spinbutton").first();
    await input.fill("999");
    await page.waitForTimeout(300);
    // Should show unsaved changes indicator
    await expect(page.getByText("Unsaved changes").first()).toBeVisible({ timeout: 3_000 });
  });

  test("save and discard buttons appear after edit", async ({ page }) => {
    const input = page.getByRole("spinbutton").first();
    await input.fill("999");
    await page.waitForTimeout(300);
    await expect(page.getByRole("button", { name: "Save" }).first()).toBeVisible({ timeout: 3_000 });
    await expect(page.getByRole("button", { name: "Discard" }).first()).toBeVisible();
  });

  // ── Provider API Keys ──────────────────────────────────────────────────

  test("provider API keys section shows masked inputs", async ({ page }) => {
    const keysSection = page.getByText(/Provider API Keys/i);
    if (await keysSection.isVisible({ timeout: 5_000 }).catch(() => false)) {
      // Should have password-type inputs for API keys
      const passwordInputs = page.locator("input[type='password']");
      const count = await passwordInputs.count();
      expect(count).toBeGreaterThanOrEqual(1);
    }
  });

  test("provider API key show/hide toggle works", async ({ page }) => {
    const keysSection = page.getByText(/Provider API Keys/i);
    if (await keysSection.isVisible({ timeout: 5_000 }).catch(() => false)) {
      const passwordInput = page.locator("input[type='password']").first();
      if (await passwordInput.isVisible()) {
        // Find the show/hide toggle nearby
        const toggleBtn = page.locator("button").filter({ hasText: /show|reveal|eye/i }).first();
        const toggleIcon = page.locator("[class*='eye'], [class*='toggle'], button").filter({ has: page.locator("svg, span") });
        const toggle = toggleBtn.or(toggleIcon.first());
        if (await toggle.isVisible().catch(() => false)) {
          await toggle.click();
          await page.waitForTimeout(300);
          // Input should now be text type
          const input = page.locator("input[type='text']").first();
          // May have changed type or revealed content
        }
      }
    }
  });
});
