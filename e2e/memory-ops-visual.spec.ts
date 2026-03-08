import { test } from "@playwright/test";

/**
 * Visual walkthrough of the Memory Operations debug flow.
 * Captures screenshots at each step for manual review.
 * Run: npx playwright test memory-ops-visual --headed
 */
test("Memory ops — full visual walkthrough", { timeout: 120_000 }, async ({ browser }) => {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await context.newPage();

  // ── Step 1: Costs page — Memory Operations section ──────────────
  await page.goto("/costs");
  await page.waitForTimeout(2_000);

  // Expand "Detailed Breakdowns" accordion first
  const advToggle = page.locator(".cg-advanced-toggle");
  if (await advToggle.isVisible({ timeout: 5_000 }).catch(() => false)) {
    await advToggle.click();
    await page.waitForTimeout(1_000);
  }

  // Scroll to Memory Operations section
  const memSection = page.locator(".cg-tool-costs").filter({ hasText: "Memory Operations" });
  if (await memSection.isVisible({ timeout: 10_000 }).catch(() => false)) {
    await memSection.scrollIntoViewIfNeeded();
    await page.waitForTimeout(500);
  }
  await page.screenshot({ path: "/tmp/memops-01-costs-section.png", fullPage: false });

  // ── Step 2: Costs page — Scroll to show full table ──────────────
  // Also capture the tool costs section above for context
  await page.evaluate(() => {
    const el = document.querySelector(".cg-tool-costs");
    if (el) el.scrollIntoView({ block: "start" });
  });
  await page.waitForTimeout(300);
  await page.screenshot({ path: "/tmp/memops-02-costs-full-table.png", fullPage: true });

  // ── Step 3: Click a memory file row → navigate to Logs ──────────
  const firstRow = memSection.locator(".cg-tool-row").first();
  if (await firstRow.isVisible({ timeout: 5_000 }).catch(() => false)) {
    const fileName = await firstRow.locator(".cg-tool-name").textContent();
    console.log(`Clicking file: ${fileName}`);
    await firstRow.click();
    await page.waitForURL(/\/logs/, { timeout: 5_000 });
    await page.waitForTimeout(3_000);
    await page.screenshot({ path: "/tmp/memops-03-logs-filtered.png" });
  }

  // ── Step 4: Logs page — activate Memory ops mode ────────────────
  await page.goto("/logs");
  await page.waitForTimeout(2_000);
  // Switch to 7d to ensure data
  const btn7d = page.getByRole("button", { name: "7d" });
  if (await btn7d.isVisible({ timeout: 3_000 }).catch(() => false)) {
    await btn7d.click();
    await page.waitForTimeout(1_500);
  }
  const memBtn = page.locator("button.logs-chip").filter({ hasText: "Memory ops" });
  if (await memBtn.isVisible({ timeout: 5_000 }).catch(() => false)) {
    await memBtn.click();
  }
  await page.waitForTimeout(3_000);
  await page.screenshot({ path: "/tmp/memops-04-memory-timeline.png" });

  // ── Step 5: Expand first session group ──────────────────────────
  const firstHeader = page.locator(".logs-run-header").first();
  if (await firstHeader.isVisible({ timeout: 5_000 }).catch(() => false)) {
    await firstHeader.click();
    await page.waitForTimeout(500);
    await page.screenshot({ path: "/tmp/memops-05-session-expanded.png" });
  }

  // ── Step 6: Expand second session to compare ────────────────────
  const secondHeader = page.locator(".logs-run-header").nth(1);
  if (await secondHeader.isVisible({ timeout: 3_000 }).catch(() => false)) {
    await secondHeader.click();
    await page.waitForTimeout(500);
    await page.screenshot({ path: "/tmp/memops-06-two-sessions.png" });
  }

  // ── Step 7: Click "View full session trace" ─────────────────────
  const traceLink = page.locator(".logs-run-link").filter({ hasText: /full session trace/ }).first();
  if (await traceLink.isVisible({ timeout: 3_000 }).catch(() => false)) {
    await traceLink.click();
    await page.waitForTimeout(2_000);
    await page.screenshot({ path: "/tmp/memops-07-full-trace.png" });
  }

  // ── Step 8: Direct URL — memory=1 param ─────────────────────────
  await page.goto("/logs?memory=1");
  await page.waitForTimeout(2_000);
  await page.screenshot({ path: "/tmp/memops-08-url-param-load.png" });

  // ── Step 9: Toggle off memory mode (reuse page from step 8) ────
  const memBtn2 = page.locator("button.logs-chip").filter({ hasText: "Memory ops" });
  if (await memBtn2.isVisible({ timeout: 5_000 }).catch(() => false)) {
    await memBtn2.click();
    await page.waitForTimeout(1_500);
    await page.screenshot({ path: "/tmp/memops-09-back-to-events.png" });
  }

  await context.close();

  console.log("\n📸 Screenshots saved to /tmp/memops-*.png");
  console.log("   01 — Costs page: Memory Operations section");
  console.log("   02 — Costs page: Full page with both Tool and Memory tables");
  console.log("   03 — Logs page: Filtered by memory file (from Costs click)");
  console.log("   04 — Logs page: Memory timeline with session groups");
  console.log("   05 — Logs page: First session expanded (trigger + ops)");
  console.log("   06 — Logs page: Two sessions expanded for comparison");
  console.log("   07 — Logs page: Full session trace (after clicking trace link)");
  console.log("   08 — Logs page: Loaded via ?memory=1 URL param");
  console.log("   09 — Logs page: Back to normal Event Stream");
});
