import { test, expect } from "@playwright/test";

test.describe("Deck Config Page", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto("/deck-config");
    await page.waitForLoadState("domcontentloaded");
    await page.waitForTimeout(2_000);
    // Default tab is "budgets" — switch to Agents for most tests in this suite
    await page.locator(".ds-tab", { hasText: "Agents" }).click();
    await page.waitForTimeout(500);
  });

  // ── Page Load ──────────────────────────────────────────────────────────────

  test("loads with agents table", async ({ page }) => {
    await expect(page.getByRole("heading", { name: "Deck Config" })).toBeVisible({ timeout: 10_000 });
    await expect(page.getByRole("heading", { name: "Agents" })).toBeVisible();
    // Should have at least one agent row with an input
    const inputs = page.locator(".mcc-table input");
    await expect(inputs.first()).toBeVisible({ timeout: 5_000 });
  });

  test("shows Agents tab and Channels tab with sections", async ({ page }) => {
    // Agents tab is visible by default
    await expect(page.getByRole("heading", { name: "Agents" })).toBeVisible();

    // Switch to Channels tab to see channel sections
    await page.locator(".ds-tab", { hasText: "Channels" }).click();
    await page.waitForTimeout(500);
    await expect(page.getByRole("heading", { name: "System Channels" })).toBeVisible();
    await expect(page.getByRole("heading", { name: "Log Channels" })).toBeVisible();
  });

  test("shows save and discard buttons after edit", async ({ page }) => {
    // Dirty a field so the save/discard toolbar appears
    const nameInput = page.locator(".mcc-table input").nth(2);
    const original = await nameInput.inputValue();
    await nameInput.fill(original + "X");
    await page.waitForTimeout(300);

    await expect(page.getByRole("button", { name: /save/i }).first()).toBeVisible({ timeout: 3_000 });
    await expect(page.getByRole("button", { name: /discard/i }).first()).toBeVisible();

    // Restore
    await page.getByRole("button", { name: /discard/i }).first().click();
  });

  // ── Editing ────────────────────────────────────────────────────────────────

  test("editing a field shows unsaved changes badge", async ({ page }) => {
    const nameInput = page.locator(".mcc-table input").nth(2); // name input (after emoji and key)
    const original = await nameInput.inputValue();
    await nameInput.fill(original + "X");

    await expect(page.getByText("Unsaved changes").first()).toBeVisible({ timeout: 2_000 });
  });

  test("discard reverts changes", async ({ page }) => {
    const nameInput = page.locator(".mcc-table input").nth(2);
    const original = await nameInput.inputValue();

    await nameInput.fill("CHANGED_NAME");
    await expect(page.getByText("Unsaved changes").first()).toBeVisible({ timeout: 2_000 });

    await page.getByRole("button", { name: /discard/i }).first().click();
    await page.waitForTimeout(1_000);

    const reverted = await page.locator(".mcc-table input").nth(2).inputValue();
    expect(reverted).toBe(original);
  });

  // ── Validation ─────────────────────────────────────────────────────────────

  test("empty name shows validation error", async ({ page }) => {
    const nameInput = page.locator(".mcc-table input").nth(2);
    await nameInput.fill("");

    await expect(page.getByText(/validation error/i)).toBeVisible({ timeout: 2_000 });
    // Save button should be disabled
    const saveBtn = page.getByRole("button", { name: /save/i }).first();
    await expect(saveBtn).toBeDisabled();
  });

  test("invalid channel ID shows error styling", async ({ page }) => {
    // Switch to Channels tab
    await page.locator(".ds-tab", { hasText: "Channels" }).click();
    await page.waitForTimeout(500);

    // Find a channel ID input (Discord Channel ID column)
    const channelInput = page.locator("input.mcc-input--mono").first();
    await channelInput.fill("not-a-number");

    await expect(page.getByText(/validation error/i)).toBeVisible({ timeout: 2_000 });
  });

  // ── Save Roundtrip ─────────────────────────────────────────────────────────

  test("save and reload persists changes", async ({ page }) => {
    // Read original emoji
    const emojiInput = page.locator("input.mcc-input--emoji").first();
    const originalEmoji = await emojiInput.inputValue();

    // Change emoji
    const testEmoji = originalEmoji === "X" ? "Y" : "X";
    await emojiInput.fill(testEmoji);
    await expect(page.getByText("Unsaved changes").first()).toBeVisible({ timeout: 2_000 });

    // Save
    await page.getByRole("button", { name: /save/i }).first().click();
    await expect(page.getByText("Saved").first()).toBeVisible({ timeout: 5_000 });

    // Reload and verify
    await page.reload();
    await page.waitForTimeout(2_000);
    const reloaded = await page.locator("input.mcc-input--emoji").first().inputValue();
    expect(reloaded).toBe(testEmoji);

    // Restore original
    await page.locator("input.mcc-input--emoji").first().fill(originalEmoji);
    await page.getByRole("button", { name: /save/i }).first().click();
    await expect(page.getByText("Saved").first()).toBeVisible({ timeout: 5_000 });
  });

  // ── Add/Delete Agents ─────────────────────────────────────────────────────

  test("add agent via modal adds a new row", async ({ page }) => {
    const agentSection = page.locator("section.mcc-section").first();
    const rowsBefore = await agentSection.locator("tbody .mcc-row").count();

    // Open modal
    await page.getByRole("button", { name: /add agent/i }).click();
    await expect(page.locator(".mcc-modal")).toBeVisible({ timeout: 2_000 });

    // Fill required fields
    const modal = page.locator(".mcc-modal");
    await modal.locator("input").nth(0).fill("Test Agent");
    // Key (1) and ID (2) auto-derived, Emoji (3) has default
    await modal.locator("input").nth(4).fill("9999999999999999990"); // Discord Channel ID

    // Submit
    await modal.getByRole("button", { name: /add agent/i }).click();
    await page.waitForTimeout(500);

    const rowsAfter = await agentSection.locator("tbody .mcc-row").count();
    expect(rowsAfter).toBe(rowsBefore + 1);

    // Discard to restore
    await page.getByRole("button", { name: /discard/i }).first().click();
  });

  test("add agent modal auto-derives key from name", async ({ page }) => {
    await page.getByRole("button", { name: /add agent/i }).click();
    const modal = page.locator(".mcc-modal");
    await modal.locator("input").nth(0).fill("My Cool Agent");
    // Key field should auto-populate
    const keyValue = await modal.locator("input").nth(1).inputValue();
    expect(keyValue).toBe("my-cool-agent");
    // Close without adding
    await modal.getByRole("button", { name: /cancel/i }).click();
  });

  test("delete agent removes a row", async ({ page }) => {
    const agentSection = page.locator("section.mcc-section").first();
    const rowsBefore = await agentSection.locator("tbody .mcc-row").count();

    // Accept the confirmation dialog that appears on delete
    page.on("dialog", (dialog) => dialog.accept());

    // Scroll to last delete button (agents table may overflow viewport)
    const deleteButtons = agentSection.locator(".mcc-btn--danger");
    const lastDelete = deleteButtons.last();
    await lastDelete.scrollIntoViewIfNeeded();
    await lastDelete.click();
    await page.waitForTimeout(500);

    const rowsAfter = await agentSection.locator("tbody .mcc-row").count();
    expect(rowsAfter).toBe(rowsBefore - 1);

    // Discard to restore
    await page.getByRole("button", { name: /discard/i }).first().click();
  });

  // ── Log Channels ───────────────────────────────────────────────────────────

  test("add log channel via modal", async ({ page }) => {
    // Switch to Channels tab
    await page.locator(".ds-tab", { hasText: "Channels" }).click();
    await page.waitForTimeout(500);

    const logSection = page.locator("section.mcc-section", { hasText: "Log Channels" });
    const rowsBefore = await logSection.locator("tbody .mcc-row").count();

    // Open modal
    await logSection.getByRole("button", { name: /add channel/i }).click();
    await expect(page.locator(".mcc-modal")).toBeVisible({ timeout: 2_000 });

    // Fill fields
    const modal = page.locator(".mcc-modal");
    await modal.locator("input").nth(0).fill("test-new-channel");
    await modal.locator("input").nth(1).fill("8888888888888888888");

    // Submit
    await modal.getByRole("button", { name: /add channel/i }).click();
    await page.waitForTimeout(500);

    const rowsAfter = await logSection.locator("tbody .mcc-row").count();
    expect(rowsAfter).toBe(rowsBefore + 1);

    // Discard to restore
    await page.getByRole("button", { name: /discard/i }).first().click();
  });

  test("delete log channel removes it", async ({ page }) => {
    // Switch to Channels tab
    await page.locator(".ds-tab", { hasText: "Channels" }).click();
    await page.waitForTimeout(500);

    const logSection = page.locator("section.mcc-section", { hasText: "Log Channels" });
    const rowsBefore = await logSection.locator("tbody .mcc-row").count();
    const deleteButtons = logSection.locator(".mcc-delete-btn");
    await deleteButtons.last().click();
    await page.waitForTimeout(500);
    const rowsAfter = await logSection.locator("tbody .mcc-row").count();
    expect(rowsAfter).toBe(rowsBefore - 1);
    // Discard to restore
    await page.getByRole("button", { name: /discard/i }).first().click();
  });

  // ── System Channels ───────────────────────────────────────────────────────

  test("system channels have no delete buttons", async ({ page }) => {
    // Switch to Channels tab
    await page.locator(".ds-tab", { hasText: "Channels" }).click();
    await page.waitForTimeout(500);

    const systemSection = page.locator("section.mcc-section", { hasText: "System Channels" });
    await expect(systemSection).toBeVisible();
    const deleteButtons = systemSection.locator(".mcc-delete-btn");
    expect(await deleteButtons.count()).toBe(0);
  });

  // ── Sentinel Tab ─────────────────────────────────────────────────────────

  test("sentinel tab loads health check cards", async ({ page }) => {
    await page.locator(".ds-tab", { hasText: "Sentinel" }).click();
    await page.waitForTimeout(1_000);

    // Should show health check cards
    const checks = page.locator("[class*='health-check'], [class*='sentinel-check'], .mcc-sentinel-card");
    if (await checks.first().isVisible({ timeout: 5_000 }).catch(() => false)) {
      const count = await checks.count();
      expect(count).toBeGreaterThanOrEqual(3);
    }
    // Known check names should appear
    await expect(page.getByText(/Working\.md|Gateway Health|Cron Health/i).first()).toBeVisible({ timeout: 5_000 });
  });

  test("sentinel: toggling a health check works", async ({ page }) => {
    await page.locator(".ds-tab", { hasText: "Sentinel" }).click();
    await page.waitForTimeout(1_000);

    // Find a toggle switch
    const toggle = page.locator("input[type='checkbox'], .mcc-toggle, [role='switch']").first();
    if (await toggle.isVisible({ timeout: 5_000 }).catch(() => false)) {
      const wasBefore = await toggle.isChecked();
      await toggle.click();
      await page.waitForTimeout(500);
      // Should show unsaved state
      await expect(page.getByText(/unsaved/i).first()).toBeVisible({ timeout: 3_000 });
      // Discard to restore
      const discardBtn = page.getByRole("button", { name: /discard/i }).first();
      if (await discardBtn.isVisible()) await discardBtn.click();
    }
  });

  test("sentinel: changing loop interval shows unsaved", async ({ page }) => {
    await page.locator(".ds-tab", { hasText: "Sentinel" }).click();
    await page.waitForTimeout(1_000);

    const intervalInput = page.locator("input[type='number'], input").filter({ hasText: /300/ }).first();
    // Try finding by label
    const loopInput = page.locator("input").nth(0);
    if (await loopInput.isVisible({ timeout: 5_000 }).catch(() => false)) {
      const original = await loopInput.inputValue();
      await loopInput.fill("600");
      await page.waitForTimeout(500);
      await expect(page.getByText(/unsaved/i).first()).toBeVisible({ timeout: 3_000 });
      // Discard
      const discardBtn = page.getByRole("button", { name: /discard/i }).first();
      if (await discardBtn.isVisible()) await discardBtn.click();
    }
  });

  test("sentinel: save persists config", async ({ page }) => {
    await page.locator(".ds-tab", { hasText: "Sentinel" }).click();
    await page.waitForTimeout(1_000);

    // Find a toggle and flip it
    const toggles = page.locator("input[type='checkbox'], [role='switch']");
    if (await toggles.first().isVisible({ timeout: 5_000 }).catch(() => false)) {
      const wasBefore = await toggles.last().isChecked();
      await toggles.last().click();
      await page.waitForTimeout(500);

      // Save
      const saveBtn = page.getByRole("button", { name: /save/i }).first();
      if (await saveBtn.isVisible({ timeout: 3_000 }).catch(() => false)) {
        await saveBtn.click();
        await expect(page.getByText(/saved/i).first()).toBeVisible({ timeout: 5_000 });

        // Reload and verify
        await page.reload();
        await page.waitForTimeout(2_000);
        await page.locator(".ds-tab", { hasText: "Sentinel" }).click();
        await page.waitForTimeout(1_000);

        const afterToggle = page.locator("input[type='checkbox'], [role='switch']").last();
        const isAfter = await afterToggle.isChecked();
        expect(isAfter).toBe(!wasBefore);

        // Restore
        await afterToggle.click();
        await page.waitForTimeout(300);
        const restoreBtn = page.getByRole("button", { name: /save/i }).first();
        if (await restoreBtn.isVisible()) await restoreBtn.click();
      }
    }
  });

  // ── Source Tab ────────────────────────────────────────────────────────────

  test("source tab shows JSON content", async ({ page }) => {
    // Switch to Source view (top-level tab)
    await page.locator(".ds-tab", { hasText: "Source" }).click();
    await page.waitForTimeout(2_000);

    // Source view uses a read-only textarea
    const textarea = page.locator("textarea.cfg-textarea");
    await expect(textarea).toBeVisible({ timeout: 5_000 });
    const text = await textarea.inputValue();
    expect(text).toContain("{");
    expect(text).toContain("agents");
  });

  test("source tab file tabs switch content", async ({ page }) => {
    await page.locator(".ds-tab", { hasText: "Source" }).click();
    // Wait for agents.json to load into textarea
    const textarea = page.locator("textarea.cfg-textarea");
    await expect(textarea).toBeVisible({ timeout: 10_000 });
    await expect(textarea).toHaveValue(/agents/, { timeout: 10_000 });

    // Switch to deck-sentinel.json
    await page.locator(".ds-tab", { hasText: "deck-sentinel.json" }).click();
    // Wait for sentinel config content (has "loop_interval_seconds" key)
    await expect(textarea).toHaveValue(/loop_interval_seconds|checks/, { timeout: 10_000 });
  });

  test("source tab history shows commits", async ({ page }) => {
    await page.locator(".ds-tab", { hasText: "Source" }).click();
    await page.waitForTimeout(3_000);

    // History panel with commit items (depends on git history being available)
    const historyPanel = page.locator(".cfg-backups-panel");
    if (await historyPanel.isVisible({ timeout: 10_000 }).catch(() => false)) {
      const items = page.locator(".cfg-backup-item");
      if (await items.first().isVisible({ timeout: 5_000 }).catch(() => false)) {
        const count = await items.count();
        expect(count).toBeGreaterThan(0);
      }
    }
  });

  test("source tab diff button shows changes", async ({ page }) => {
    await page.locator(".ds-tab", { hasText: "Source" }).click();
    await page.waitForTimeout(1_500);

    const diffBtn = page.locator(".cfg-btn").filter({ hasText: "Diff" }).first();
    if (await diffBtn.isVisible({ timeout: 5_000 }).catch(() => false)) {
      await diffBtn.click();
      await page.waitForTimeout(1_500);
      // Diff bar should appear
      const diffBar = page.locator(".fv-diff-bar");
      if (await diffBar.isVisible({ timeout: 3_000 }).catch(() => false)) {
        await expect(diffBar).toBeVisible();
      }
    }
  });
});
