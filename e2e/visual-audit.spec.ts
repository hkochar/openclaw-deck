import { test, expect } from "@playwright/test";

/**
 * Visual audit of all dashboard pages at desktop and mobile viewports.
 * Captures full-page screenshots for manual review.
 * Run: npx playwright test visual-audit --headed
 */

const PAGES = [
  { route: "/", slug: "overview" },
  { route: "/costs", slug: "costs" },
  { route: "/schedule", slug: "schedule" },
  { route: "/logs", slug: "logs" },
  { route: "/tests", slug: "tests" },
  { route: "/knowledge", slug: "knowledge" },
  { route: "/sessions", slug: "sessions" },
  { route: "/analysis", slug: "analysis" },
  { route: "/search", slug: "search" },
  { route: "/services", slug: "services" },
  { route: "/config", slug: "config" },
  { route: "/deck-config", slug: "deck-config" },
  { route: "/models", slug: "models" },
  { route: "/memory", slug: "memory" },
  { route: "/usage", slug: "usage" },
  { route: "/docs", slug: "docs" },
  { route: "/replay", slug: "replay" },
];

const DESKTOP = { width: 1440, height: 900 };
const MOBILE = { width: 375, height: 667 };
const DIR = "/tmp/visual-audit";

test("Desktop visual audit — all pages", async ({ browser }) => {
  test.setTimeout(120_000);
  const context = await browser.newContext({ viewport: DESKTOP });
  const page = await context.newPage();

  for (const p of PAGES) {
    await page.goto(p.route);
    await page.waitForLoadState("networkidle");
    await page.waitForTimeout(500);
    await page.screenshot({ path: `${DIR}/desktop-${p.slug}.png`, fullPage: true });
    console.log(`Desktop: ${p.slug} ✓`);
  }

  await context.close();
});

test("Mobile visual audit — all pages", async ({ browser }) => {
  test.setTimeout(120_000);
  const context = await browser.newContext({ viewport: MOBILE });
  const page = await context.newPage();

  const overflowPages: string[] = [];

  for (const p of PAGES) {
    await page.goto(p.route);
    await page.waitForLoadState("networkidle");
    await page.waitForTimeout(500);
    await page.screenshot({ path: `${DIR}/mobile-${p.slug}.png`, fullPage: true });

    // Check for horizontal overflow
    const scrollWidth = await page.evaluate(() => document.documentElement.scrollWidth);
    if (scrollWidth > MOBILE.width + 5) {
      overflowPages.push(`${p.slug} (scrollWidth: ${scrollWidth}px)`);
      console.log(`Mobile: ${p.slug} ✗ OVERFLOW (${scrollWidth}px > ${MOBILE.width}px)`);
    } else {
      console.log(`Mobile: ${p.slug} ✓`);
    }

    // Verify nav is visible
    const navVisible = await page.locator("nav").isVisible().catch(() => false);
    if (!navVisible) {
      console.log(`Mobile: ${p.slug} ⚠ nav not visible`);
    }

    // Verify page can scroll vertically (content not clipped)
    const scrollHeight = await page.evaluate(() => document.documentElement.scrollHeight);
    const bodyHeight = await page.evaluate(() => document.body.scrollHeight);
    if (scrollHeight < MOBILE.height && bodyHeight < MOBILE.height) {
      console.log(`Mobile: ${p.slug} ⚠ no scrollable content (${scrollHeight}px)`);
    }
  }

  await context.close();

  // Report overflow issues
  if (overflowPages.length > 0) {
    console.log("\n=== HORIZONTAL OVERFLOW DETECTED ===");
    for (const p of overflowPages) {
      console.log(`  • ${p}`);
    }
  }

  // Fail if any pages have horizontal overflow
  expect(overflowPages, `Pages with horizontal overflow:\n${overflowPages.join("\n")}`).toHaveLength(0);
});
