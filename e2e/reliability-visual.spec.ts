import { test, expect } from "@playwright/test";

/**
 * Visual walkthrough of the Reliability dashboard section.
 * Captures screenshots of each tab for manual review.
 * Run: npx playwright test reliability-visual --headed
 */
test("Reliability dashboard — full visual walkthrough", async ({ browser }) => {
  test.setTimeout(120_000);
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await context.newPage();

  // ── Step 1: Costs page — find Reliability section ──────────────
  await page.goto("/costs");
  await page.waitForTimeout(5_000);

  const section = page.locator(".cg-tool-costs").filter({ hasText: "Reliability" });
  if (await section.isVisible({ timeout: 15_000 }).catch(() => false)) {
    await section.scrollIntoViewIfNeeded();
    await page.waitForTimeout(500);
  }
  await page.screenshot({ path: "/tmp/reliability-01-providers-tab.png", fullPage: false });
  console.log("Step 1: Providers tab (default)");

  // ── Step 2: Context Utilization tab ────────────────────────────
  const contextBtn = section.locator("button").filter({ hasText: "Context %" });
  if (await contextBtn.isVisible().catch(() => false)) {
    await contextBtn.click();
    await page.waitForTimeout(1_000);
    await section.scrollIntoViewIfNeeded();
  }
  await page.screenshot({ path: "/tmp/reliability-02-context-tab.png", fullPage: false });
  console.log("Step 2: Context Utilization tab — shows avg/max % per agent");

  // ── Step 3: Messages tab ───────────────────────────────────────
  const msgsBtn = section.locator("button").filter({ hasText: "Messages" });
  if (await msgsBtn.isVisible().catch(() => false)) {
    await msgsBtn.click();
    await page.waitForTimeout(1_000);
    await section.scrollIntoViewIfNeeded();
  }
  await page.screenshot({ path: "/tmp/reliability-03-messages-tab.png", fullPage: false });
  console.log("Step 3: Messages tab — sent/received counts per agent");

  // ── Step 4: Sessions tab ───────────────────────────────────────
  const sessBtn = section.locator("button").filter({ hasText: "Sessions" });
  if (await sessBtn.isVisible().catch(() => false)) {
    await sessBtn.click();
    await page.waitForTimeout(1_000);
    await section.scrollIntoViewIfNeeded();
  }
  await page.screenshot({ path: "/tmp/reliability-04-sessions-tab.png", fullPage: false });
  console.log("Step 4: Sessions tab — expensive sessions with cost cap info");

  // ── Step 5: Poller tab ─────────────────────────────────────────
  const pollerBtn = section.locator("button").filter({ hasText: "Poller" });
  if (await pollerBtn.isVisible().catch(() => false)) {
    await pollerBtn.click();
    await page.waitForTimeout(1_000);
    await section.scrollIntoViewIfNeeded();
  }
  await page.screenshot({ path: "/tmp/reliability-05-poller-tab.png", fullPage: false });
  console.log("Step 5: Poller tab — JSONL session poller health");

  // ── Step 6: Full page with all sections visible ────────────────
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.waitForTimeout(500);
  await page.screenshot({ path: "/tmp/reliability-06-full-page.png", fullPage: true });
  console.log("Step 6: Full Costs page with all sections");

  await context.close();
  console.log("\nAll screenshots saved to /tmp/reliability-*.png");
});
