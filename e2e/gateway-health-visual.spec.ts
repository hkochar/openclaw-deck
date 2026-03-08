import { test, expect } from "@playwright/test";

/**
 * Visual walkthrough of the Gateway Health reliability features.
 * Captures screenshots showing all health states (ok, warn, offline, dropped).
 * Run: npx playwright test gateway-health-visual --headed
 */
test("Gateway health — full visual walkthrough", async ({ browser }) => {
  test.setTimeout(120_000);
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await context.newPage();

  // ── Step 1: Live gateway health (real state) ───────────────────
  await page.goto("/");
  await page.waitForTimeout(5_000);
  await page.screenshot({ path: "/tmp/health-01-live-state.png", fullPage: false });
  console.log("Step 1: Live gateway health state captured");

  // ── Step 2: OK state with uptime tooltip ───────────────────────
  await page.route("**/api/gateway-health", (route) => {
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        ok: true, status: 200, uptime: 7200, droppedEvents: 0,
        activeLoops: 0, loops: [], memoryMB: 142,
      }),
    });
  });
  await page.goto("/");
  await page.waitForTimeout(4_000);
  // Hover to show tooltip
  const healthOk = page.locator(".gateway-health");
  await healthOk.hover();
  await page.waitForTimeout(500);
  await page.screenshot({ path: "/tmp/health-02-ok-state.png", fullPage: false });
  console.log("Step 2: OK state — green dot, uptime 120m, 142MB RAM");

  // ── Step 3: OK state with dropped events ───────────────────────
  await page.route("**/api/gateway-health", (route) => {
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        ok: true, status: 200, uptime: 3600, droppedEvents: 12,
        activeLoops: 0, loops: [], memoryMB: 98,
      }),
    });
  });
  await page.goto("/");
  await page.waitForTimeout(4_000);
  await page.screenshot({ path: "/tmp/health-03-dropped-events.png", fullPage: false });
  console.log("Step 3: OK state with 12 dropped events — amber badge visible");

  // ── Step 4: Warn state — single stuck loop ─────────────────────
  await page.route("**/api/gateway-health", (route) => {
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        ok: false, status: 503, uptime: 1800, droppedEvents: 2,
        activeLoops: 1,
        loops: [{ agent: "jane", tool: "Read", count: 23, since: Date.now() - 120000 }],
        memoryMB: 210,
      }),
    });
  });
  await page.goto("/");
  await page.waitForTimeout(4_000);
  const healthWarn = page.locator(".gateway-health");
  await healthWarn.hover();
  await page.waitForTimeout(500);
  await page.screenshot({ path: "/tmp/health-04-warn-single-loop.png", fullPage: false });
  console.log("Step 4: WARN state — pulsing amber dot, 'Loop!' label, jane/Read 23x");

  // ── Step 5: Warn state — multiple stuck loops ──────────────────
  await page.route("**/api/gateway-health", (route) => {
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        ok: false, status: 503, uptime: 900, droppedEvents: 5,
        activeLoops: 3,
        loops: [
          { agent: "jane", tool: "Read", count: 15, since: Date.now() - 60000 },
          { agent: "scout", tool: "Bash", count: 8, since: Date.now() - 45000 },
          { agent: "forge", tool: "Write", count: 6, since: Date.now() - 30000 },
        ],
        memoryMB: 312,
      }),
    });
  });
  await page.goto("/");
  await page.waitForTimeout(4_000);
  const healthMulti = page.locator(".gateway-health");
  await healthMulti.hover();
  await page.waitForTimeout(500);
  await page.screenshot({ path: "/tmp/health-05-warn-multi-loop.png", fullPage: false });
  console.log("Step 5: WARN state — 3 stuck loops from jane, scout, forge");

  // ── Step 6: Offline state ──────────────────────────────────────
  await page.route("**/api/gateway-health", (route) => {
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ ok: false, status: 0 }),
    });
  });
  await page.goto("/");
  await page.waitForTimeout(4_000);
  await page.screenshot({ path: "/tmp/health-06-offline.png", fullPage: false });
  console.log("Step 6: OFFLINE state — red dot, 'Offline' label");

  // ── Step 7: Health visible on Logs page ────────────────────────
  // Unroute to use real gateway
  await page.unrouteAll();
  await page.goto("/logs");
  await page.waitForTimeout(4_000);
  await page.screenshot({ path: "/tmp/health-07-logs-page.png", fullPage: false });
  console.log("Step 7: Gateway health visible on Logs page header");

  // ── Step 8: Health visible on Costs page ───────────────────────
  await page.goto("/costs");
  await page.waitForTimeout(4_000);
  await page.screenshot({ path: "/tmp/health-08-costs-page.png", fullPage: false });
  console.log("Step 8: Gateway health visible on Costs page header");

  // ── Step 9: Transition from offline to ok ──────────────────────
  // Start offline
  await page.route("**/api/gateway-health", (route) => {
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ ok: false, status: 0 }),
    });
  });
  await page.goto("/");
  await page.waitForTimeout(4_000);

  const offlineDot = page.locator(".gateway-health-dot--offline");
  await expect(offlineDot).toBeVisible({ timeout: 5_000 });
  await page.screenshot({ path: "/tmp/health-09a-transition-offline.png", fullPage: false });

  // Simulate recovery via gateway-changed event
  await page.unrouteAll();
  await page.route("**/api/gateway-health", (route) => {
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        ok: true, status: 200, uptime: 10, droppedEvents: 0,
        activeLoops: 0, loops: [], memoryMB: 85,
      }),
    });
  });
  await page.evaluate(() => window.dispatchEvent(new Event("gateway-changed")));
  await page.waitForTimeout(4_000);
  await page.screenshot({ path: "/tmp/health-09b-transition-recovered.png", fullPage: false });
  console.log("Step 9: Transition from offline → ok after gateway-changed event");

  await context.close();
  console.log("\nAll screenshots saved to /tmp/health-*.png");
});
