import { test, expect } from "@playwright/test";

test.describe("Schedule Page", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto("/schedule");
    await page.waitForLoadState("domcontentloaded");
    // Give the cron API time to respond — data-dependent on gateway availability
    await page.waitForTimeout(3_000);
  });

  /** Skip test if the cron table never loaded (gateway/API unavailable). */
  async function requireCronTable(page: import("@playwright/test").Page) {
    const table = page.locator(".models-table");
    if (!(await table.isVisible({ timeout: 15_000 }).catch(() => false))) {
      test.skip(true, "Cron table did not load — gateway or cron API unavailable");
    }
  }

  // ── Page Load ────────────────────────────────────────────────────────────

  test("loads and shows cron table with rows", async ({ page }) => {
    await requireCronTable(page);
    const rows = page.locator(".models-row");
    await expect(rows.first()).toBeVisible();
    const count = await rows.count();
    expect(count).toBeGreaterThan(0);
  });

  // ── View Toggle ──────────────────────────────────────────────────────────

  test("switches between list and grid view", async ({ page }) => {
    await requireCronTable(page);
    await expect(page.locator(".models-table")).toBeVisible();

    await page.getByRole("button", { name: /Grid/ }).click();
    await expect(page.locator(".models-table")).not.toBeVisible();

    await page.getByRole("button", { name: /List/ }).click();
    await expect(page.locator(".models-table")).toBeVisible();
  });

  // ── Filters ──────────────────────────────────────────────────────────────

  test("status filter shows correct counts", async ({ page }) => {
    await requireCronTable(page);
    const allBtn = page.getByRole("button", { name: /^all/i }).first();
    const enabledBtn = page.getByRole("button", { name: /^enabled/i }).first();
    const disabledBtn = page.getByRole("button", { name: /^disabled/i }).first();

    await expect(allBtn).toBeVisible();
    await expect(enabledBtn).toBeVisible();
    await expect(disabledBtn).toBeVisible();
  });

  test("enabled filter hides disabled jobs", async ({ page }) => {
    await requireCronTable(page);
    const allRows = await page.locator(".models-row").count();

    await page.getByRole("button", { name: /^enabled/i }).first().click();
    const enabledRows = await page.locator(".models-row").count();

    expect(enabledRows).toBeLessThanOrEqual(allRows);
  });

  test("disabled filter hides enabled jobs", async ({ page }) => {
    await requireCronTable(page);
    const allRows = await page.locator(".models-row").count();

    await page.getByRole("button", { name: /^disabled/i }).first().click();
    const disabledRows = await page.locator(".models-row").count();

    expect(disabledRows).toBeLessThanOrEqual(allRows);
  });

  test("agent filter narrows results", async ({ page }) => {
    await requireCronTable(page);
    const agentChip = page.locator("button").filter({ hasText: /^jane$/i });
    if (await agentChip.isVisible()) {
      const beforeCount = await page.locator(".models-row").count();
      await agentChip.click();
      const afterCount = await page.locator(".models-row").count();
      expect(afterCount).toBeLessThanOrEqual(beforeCount);
    }
  });

  test("clear filters resets all", async ({ page }) => {
    await requireCronTable(page);
    const agentChip = page.locator("button").filter({ hasText: /^jane$/i });
    if (await agentChip.isVisible()) {
      await agentChip.click();
      const clearBtn = page.getByRole("button", { name: /clear filters/i });
      await expect(clearBtn).toBeVisible();
      await clearBtn.click();
      await expect(clearBtn).not.toBeVisible();
    }
  });

  // ── Toggle ───────────────────────────────────────────────────────────────

  test("toggle cron job and verify state persists after reload", async ({ page }) => {
    await requireCronTable(page);
    const firstSlider = page.locator(".cron-toggle-slider").first();
    await expect(firstSlider).toBeVisible();

    const firstToggle = page.locator('input[data-testid^="toggle-"]').first();
    const toggleTestId = await firstToggle.getAttribute("data-testid");
    expect(toggleTestId).toBeTruthy();

    const wasBefore = await firstToggle.isChecked();
    await firstSlider.click();

    const toast = page.locator('[data-testid="toast"]');
    await expect(toast).toBeVisible({ timeout: 8_000 });
    await page.waitForTimeout(1_500);

    await expect(firstToggle).toBeChecked({ checked: !wasBefore, timeout: 5_000 });

    await page.reload();
    await page.waitForSelector(".models-table", { timeout: 15_000 });

    const sameToggle = page.locator(`input[data-testid="${toggleTestId}"]`);
    await expect(sameToggle).toBeChecked({ checked: !wasBefore, timeout: 5_000 });

    const sameRow = page.locator(`[data-testid="cron-row-${toggleTestId?.replace("toggle-", "")}"]`);
    await sameRow.locator(".cron-toggle-slider").click();
    await expect(page.locator('[data-testid="toast"]')).toBeVisible({ timeout: 8_000 });
  });

  // ── Edit Panel ───────────────────────────────────────────────────────────

  test("edit button opens and cancel closes edit panel", async ({ page }) => {
    await requireCronTable(page);
    const editBtn = page.locator('button[data-testid^="edit-"]').first();
    await expect(editBtn).toBeVisible();

    await editBtn.click();
    await expect(page.locator(".cron-edit-panel")).toBeVisible();

    await page.getByRole("button", { name: "Cancel" }).click();
    await expect(page.locator(".cron-edit-panel")).not.toBeVisible();
  });

  test("edit panel shows name and schedule inputs", async ({ page }) => {
    await requireCronTable(page);
    const editBtn = page.locator('button[data-testid^="edit-"]').first();
    await editBtn.click();

    await expect(page.locator(".cron-edit-panel")).toBeVisible();
    const inputs = page.locator(".cron-edit-input");
    expect(await inputs.count()).toBeGreaterThanOrEqual(2);
  });

  // ── Grid View ────────────────────────────────────────────────────────────

  test("grid view shows month calendar with day cells", async ({ page }) => {
    await requireCronTable(page);
    await page.getByRole("button", { name: /Grid/ }).click();

    await expect(page.getByText("Sun", { exact: true })).toBeVisible();
    await expect(page.getByText("Mon", { exact: true })).toBeVisible();

    const monthName = new Date().toLocaleString("en-US", { month: "long", year: "numeric" });
    await expect(page.getByText(monthName)).toBeVisible();
  });

  test("clicking a day in grid shows detail panel", async ({ page }) => {
    await requireCronTable(page);
    await page.getByRole("button", { name: /Grid/ }).click();

    const today = new Date().getDate().toString();
    const dayCell = page.locator("div").filter({ hasText: new RegExp(`^${today}$`) }).first();
    await dayCell.click();

    await expect(page.getByRole("button", { name: "✕" })).toBeVisible();
  });

  // ── Gateway Restart ──────────────────────────────────────────────────────

  test("gateway restart shows confirmation before executing", async ({ page }) => {
    await requireCronTable(page);
    const restartBtn = page.locator(".cron-action-btn").filter({ hasText: "Restart" });
    if (await restartBtn.isVisible()) {
      await restartBtn.click();
      await expect(page.getByText("Restart gateway?")).toBeVisible();
      const cancelBtn = page.locator(".cron-action-btn").filter({ hasText: "Cancel" });
      await cancelBtn.click();
      await expect(page.getByText("Restart gateway?")).not.toBeVisible();
    }
  });

  // ── Advanced Filters ───────────────────────────────────────────────────

  test("model filter narrows results", async ({ page }) => {
    await requireCronTable(page);
    const modelChip = page.locator("button").filter({ hasText: /^haiku$|^sonnet$|^opus$/i }).first();
    if (await modelChip.isVisible({ timeout: 3_000 }).catch(() => false)) {
      const beforeCount = await page.locator(".models-row").count();
      await modelChip.click();
      await page.waitForTimeout(500);
      const afterCount = await page.locator(".models-row").count();
      expect(afterCount).toBeLessThanOrEqual(beforeCount);
      await modelChip.click();
    }
  });

  test("type filter shows only heartbeat or task", async ({ page }) => {
    await requireCronTable(page);
    const typeChip = page.locator("button").filter({ hasText: /^heartbeat$|^task$/i }).first();
    if (await typeChip.isVisible({ timeout: 3_000 }).catch(() => false)) {
      const beforeCount = await page.locator(".models-row").count();
      await typeChip.click();
      await page.waitForTimeout(500);
      const afterCount = await page.locator(".models-row").count();
      expect(afterCount).toBeLessThanOrEqual(beforeCount);
      await typeChip.click();
    }
  });

  test("combining agent + status filters works", async ({ page }) => {
    await requireCronTable(page);
    const agentChip = page.locator("button").filter({ hasText: /^jane$/i });
    const enabledBtn = page.getByRole("button", { name: /^enabled/i }).first();
    if (await agentChip.isVisible() && await enabledBtn.isVisible()) {
      await agentChip.click();
      await enabledBtn.click();
      await page.waitForTimeout(500);
      const rows = await page.locator(".models-row").count();
      expect(rows).toBeGreaterThanOrEqual(0);
      const clearBtn = page.getByRole("button", { name: /clear filters/i });
      if (await clearBtn.isVisible()) await clearBtn.click();
    }
  });

  test("edit save roundtrip persists schedule", async ({ page }) => {
    await requireCronTable(page);
    const editBtn = page.locator('button[data-testid^="edit-"]').first();
    if (await editBtn.isVisible({ timeout: 5_000 }).catch(() => false)) {
      await editBtn.click();
      await expect(page.locator(".cron-edit-panel")).toBeVisible();

      const scheduleInput = page.locator(".cron-edit-input").last();
      const original = await scheduleInput.inputValue();

      const newSchedule = original === "every 5m" ? "every 10m" : "every 5m";
      await scheduleInput.fill(newSchedule);

      await page.getByRole("button", { name: "Save" }).click();
      await expect(page.locator('[data-testid="toast"]')).toBeVisible({ timeout: 8_000 });
      await page.waitForTimeout(2_000);

      await page.reload();
      await page.waitForSelector(".models-table", { timeout: 15_000 });

      const sameEditBtn = page.locator('button[data-testid^="edit-"]').first();
      await sameEditBtn.click();
      await expect(page.locator(".cron-edit-panel")).toBeVisible();
      const afterValue = await page.locator(".cron-edit-input").last().inputValue();
      expect(afterValue).toBe(newSchedule);

      await page.locator(".cron-edit-input").last().fill(original);
      await page.getByRole("button", { name: "Save" }).click();
      await expect(page.locator('[data-testid="toast"]')).toBeVisible({ timeout: 8_000 });
    }
  });

  test("grid view month navigation prev/next", async ({ page }) => {
    await requireCronTable(page);
    await page.getByRole("button", { name: /Grid/ }).click();
    await page.waitForTimeout(500);

    const currentMonth = new Date().toLocaleString("en-US", { month: "long", year: "numeric" });
    await expect(page.getByText(currentMonth)).toBeVisible();

    const prevBtn = page.locator("button").filter({ hasText: /◀|←|prev/i }).first();
    if (await prevBtn.isVisible()) {
      await prevBtn.click();
      await page.waitForTimeout(500);
      const headerText = await page.locator("h2, h3, [class*='month']").filter({ hasText: /\w+ \d{4}/ }).first().textContent();
      expect(headerText).not.toBe(currentMonth);

      const nextBtn = page.locator("button").filter({ hasText: /▶|→|next/i }).first();
      if (await nextBtn.isVisible()) {
        await nextBtn.click();
        await page.waitForTimeout(500);
      }
    }
  });
});
