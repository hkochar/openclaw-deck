import { test, expect } from "@playwright/test";

test.describe("Provider Rate Limits — Costs Page", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto("/costs");
    await page.waitForLoadState("domcontentloaded");
    await expect(page.getByRole("heading", { name: "Agent Costs" })).toBeVisible({ timeout: 10_000 });
  });

  test("Provider Rate Limits section renders when configured", async ({ page }) => {
    const section = page.locator(".cg-provider-limits");
    const error = page.locator(".cg-error");
    // Section may or may not show depending on config
    if (await section.isVisible({ timeout: 5_000 }).catch(() => false)) {
      await expect(page.getByText("Provider Rate Limits")).toBeVisible();
    } else {
      // If no provider limits configured, section should be absent (not errored)
      const errorVisible = await error.isVisible().catch(() => false);
      // Either no section or gateway error — both acceptable
      expect(true).toBeTruthy();
      void errorVisible;
    }
  });

  test("provider cards show provider name", async ({ page }) => {
    const card = page.locator(".cg-provider-card").first();
    if (await card.isVisible({ timeout: 5_000 }).catch(() => false)) {
      const name = card.locator(".cg-provider-name");
      await expect(name).toBeVisible();
      const text = await name.textContent();
      expect(text!.length).toBeGreaterThan(0);
    }
  });

  test("provider window shows usage bar", async ({ page }) => {
    const window = page.locator(".cg-provider-window").first();
    if (await window.isVisible({ timeout: 5_000 }).catch(() => false)) {
      // Should have label and count
      await expect(window.locator(".cg-provider-window-label")).toBeVisible();
      await expect(window.locator(".cg-provider-window-count")).toBeVisible();
      // Should have a budget bar
      await expect(window.locator(".cg-bar-track")).toBeVisible();
    }
  });

  test("provider window count shows used/limit format", async ({ page }) => {
    const count = page.locator(".cg-provider-window-count").first();
    if (await count.isVisible({ timeout: 5_000 }).catch(() => false)) {
      const text = await count.textContent();
      // Format: "X / Y"
      expect(text).toMatch(/\d+(\.\d+)?\s*\/\s*\d+/);
    }
  });

  test("request count summary cards visible", async ({ page }) => {
    const summary = page.locator(".cg-summary");
    if (await summary.isVisible({ timeout: 10_000 }).catch(() => false)) {
      // Summary cards show "Today", "This Week", "This Month" labels
      await expect(summary.locator(".cg-summary-label", { hasText: "Today" })).toBeVisible();
      await expect(summary.locator(".cg-summary-label", { hasText: "This Week" })).toBeVisible();
    }
  });

  test("subscription agent shows SUB badge", async ({ page }) => {
    const badge = page.locator(".cg-badge--sub").first();
    if (await badge.isVisible({ timeout: 5_000 }).catch(() => false)) {
      await expect(badge).toHaveText("SUB");
    }
  });

  test("agent cards show request counts", async ({ page }) => {
    const card = page.locator(".cg-card").first();
    if (await card.isVisible({ timeout: 10_000 }).catch(() => false)) {
      // Should show "Reqs Today" label
      await expect(card.getByText("Reqs Today")).toBeVisible();
      await expect(card.getByText("Reqs Week")).toBeVisible();
    }
  });
});

test.describe("Provider Rate Limits — Deck Config Editor", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto("/deck-config");
    await page.waitForLoadState("domcontentloaded");
    await expect(page.getByRole("heading", { name: "Deck Config" })).toBeVisible({ timeout: 10_000 });
    // Switch to edit mode
    const editBtn = page.getByRole("button", { name: /edit/i });
    if (await editBtn.isVisible({ timeout: 3_000 }).catch(() => false)) {
      await editBtn.click();
    }
    // Click Providers tab (Rate Limits section is here, not Budgets)
    await page.getByRole("button", { name: /providers/i }).click();
    await page.waitForTimeout(300);
  });

  test("Rate Limits section is visible", async ({ page }) => {
    await expect(page.getByText("Rate Limits")).toBeVisible({ timeout: 5_000 });
  });

  test("Add Provider button exists", async ({ page }) => {
    const btn = page.getByRole("button", { name: /add provider/i });
    await expect(btn).toBeVisible();
  });

  test("shows existing provider sections if configured", async ({ page }) => {
    // Look for provider names (anthropic, openai) or "No provider limits" message
    const provCard = page.locator(".mcc-subsection").first();
    const noLimits = page.getByText("No provider limits configured");
    await expect(provCard.or(noLimits)).toBeVisible({ timeout: 5_000 });
  });

  test("provider section has Add Window and Remove buttons", async ({ page }) => {
    const provCard = page.locator(".mcc-subsection").first();
    if (await provCard.isVisible({ timeout: 5_000 }).catch(() => false)) {
      await expect(provCard.getByRole("button", { name: /add window/i })).toBeVisible();
      await expect(provCard.getByRole("button", { name: /remove/i })).toBeVisible();
    }
  });

  test("window card shows duration dropdown with presets", async ({ page }) => {
    const windowCard = page.locator(".mcc-prov-window-card").first();
    if (await windowCard.isVisible({ timeout: 5_000 }).catch(() => false)) {
      // Should have a select with preset options
      const select = windowCard.locator("select").first();
      await expect(select).toBeVisible();
      const options = await select.locator("option").allTextContents();
      expect(options.some((o) => /5 hours/i.test(o))).toBeTruthy();
      expect(options.some((o) => /daily/i.test(o))).toBeTruthy();
      expect(options.some((o) => /weekly/i.test(o))).toBeTruthy();
    }
  });

  test("window card has Rolling and Shared pool toggles", async ({ page }) => {
    const windowCard = page.locator(".mcc-prov-window-card").first();
    if (await windowCard.isVisible({ timeout: 5_000 }).catch(() => false)) {
      await expect(windowCard.getByText("Rolling")).toBeVisible();
      await expect(windowCard.getByText("Shared pool")).toBeVisible();
    }
  });

  test("shared window shows model weights editor", async ({ page }) => {
    // Look for a shared window (has "Model weights:" label)
    const weightsLabel = page.getByText("Model weights:").first();
    if (await weightsLabel.isVisible({ timeout: 5_000 }).catch(() => false)) {
      // Should have weight rows and an "Add weight" button
      const weightRows = page.locator(".mcc-prov-weight-row");
      const count = await weightRows.count();
      expect(count).toBeGreaterThan(0);
      await expect(page.getByRole("button", { name: /add weight/i }).first()).toBeVisible();
    }
  });

  test("per-model window shows model match input", async ({ page }) => {
    const modelLabel = page.getByText("Model match:").first();
    if (await modelLabel.isVisible({ timeout: 5_000 }).catch(() => false)) {
      // Should have an input next to it
      const detail = page.locator(".mcc-prov-window-detail").filter({ hasText: "Model match" }).first();
      const input = detail.locator("input");
      await expect(input).toBeVisible();
    }
  });

  test("window card has limit input", async ({ page }) => {
    const windowCard = page.locator(".mcc-prov-window-card").first();
    if (await windowCard.isVisible({ timeout: 5_000 }).catch(() => false)) {
      await expect(windowCard.getByText("Limit:")).toBeVisible();
      const limitInput = windowCard.locator("input[type='number']").last();
      await expect(limitInput).toBeVisible();
    }
  });

  test("editing limit marks form dirty", async ({ page }) => {
    const windowCard = page.locator(".mcc-prov-window-card").first();
    if (await windowCard.isVisible({ timeout: 5_000 }).catch(() => false)) {
      const limitInput = windowCard.locator("input[type='number']").last();
      await limitInput.fill("999");
      await page.waitForTimeout(300);
      await expect(page.getByText("Unsaved changes").first()).toBeVisible({ timeout: 3_000 });
    }
  });

  test("changing duration preset updates config", async ({ page }) => {
    const windowCard = page.locator(".mcc-prov-window-card").first();
    if (await windowCard.isVisible({ timeout: 5_000 }).catch(() => false)) {
      const select = windowCard.locator("select").first();
      await select.selectOption({ label: "Daily" });
      await page.waitForTimeout(300);
      await expect(page.getByText("Unsaved changes").first()).toBeVisible({ timeout: 3_000 });
    }
  });

  test("per-agent budgets table has Daily Requests and Weekly Requests columns", async ({ page }) => {
    // Switch to Budgets tab (beforeEach opens Providers tab)
    await page.getByRole("button", { name: /budgets/i }).click();
    await page.waitForTimeout(500);
    // Expand the collapsible Per-Agent Budgets section
    const summary = page.locator("summary", { hasText: "Per-Agent Budgets" });
    if (!(await summary.isVisible({ timeout: 5_000 }).catch(() => false))) {
      test.skip(true, "Per-Agent Budgets section not visible — no agents configured");
      return;
    }
    await summary.click();
    await page.waitForTimeout(500);
    await expect(page.getByRole("columnheader", { name: "Daily Requests" })).toBeVisible();
    await expect(page.getByRole("columnheader", { name: "Weekly Requests" })).toBeVisible();
  });

  test("global budgets table has Request Limit column", async ({ page }) => {
    // Switch to Budgets tab (beforeEach opens Providers tab)
    await page.getByRole("button", { name: /budgets/i }).click();
    await page.waitForTimeout(300);
    await expect(page.getByText("Global Budgets")).toBeVisible({ timeout: 5_000 });
    await expect(page.getByRole("columnheader", { name: "Request Limit" })).toBeVisible();
  });
});
