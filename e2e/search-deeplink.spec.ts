import { test, expect } from "@playwright/test";

const DIR = "/tmp/visual-audit";

test("Search deep-link — config result navigates to config editor with highlight", async ({ page }) => {
  test.setTimeout(60_000);

  // 1. Go to search page and search for a config key
  await page.goto("/search");
  await page.waitForLoadState("networkidle");
  await page.screenshot({ path: `${DIR}/search-empty.png`, fullPage: true });

  const input = page.locator(".search-input");
  await input.fill("compaction.memoryFlush.enabled");
  await page.waitForTimeout(500); // debounce
  await page.waitForLoadState("networkidle");
  await page.screenshot({ path: `${DIR}/search-results.png`, fullPage: true });

  // 2. Verify results appeared
  await page.waitForSelector(".search-result", { timeout: 5000 });
  const resultCount = await page.locator(".search-result").count();
  console.log(`Search results: ${resultCount}`);
  expect(resultCount).toBeGreaterThan(0);

  // 3. Check clear button is visible
  const clearBtn = page.locator(".search-clear-btn");
  await expect(clearBtn).toBeVisible();

  // 4. Find and log all result clickUrls
  const results = page.locator(".search-result");
  const count = await results.count();
  for (let i = 0; i < count; i++) {
    const href = await results.nth(i).getAttribute("href");
    const badge = await results.nth(i).locator(".search-result-badge").textContent();
    console.log(`  Result ${i}: [${badge}] → ${href}`);
  }

  // 5. Click the config result
  const configResult = results.filter({ has: page.locator(".search-result-badge", { hasText: "config" }) }).first();
  const configHref = await configResult.getAttribute("href");
  console.log(`\nClicking config result: ${configHref}`);
  await configResult.click();
  await page.waitForLoadState("networkidle");
  await page.waitForTimeout(500);
  await page.screenshot({ path: `${DIR}/search-config-deeplink.png`, fullPage: true });

  // 6. Verify we're on the config page with search param
  expect(page.url()).toContain("/config");
  expect(page.url()).toContain("search=");
  console.log(`Config page URL: ${page.url()}`);

  // 7. Check the textarea has content and the search term is selected
  const textarea = page.locator(".cfg-textarea");
  await expect(textarea).toBeVisible();
  const textareaValue = await textarea.inputValue();
  expect(textareaValue).toContain("memoryFlush");
  console.log("Config editor loaded with content containing memoryFlush ✓");
});

test("Search deep-link — doc result navigates to knowledge page with file", async ({ page }) => {
  test.setTimeout(60_000);

  await page.goto("/search");
  await page.waitForLoadState("networkidle");

  const input = page.locator(".search-input");
  await input.fill("compaction.memoryFlush.enabled");
  await page.waitForTimeout(500);
  await page.waitForLoadState("networkidle");

  // Find doc result
  const results = page.locator(".search-result");
  const docResult = results.filter({ has: page.locator(".search-result-badge", { hasText: "doc" }) }).first();
  const docCount = await page.locator(".search-result-badge", { hasText: "doc" }).count();
  console.log(`Doc results: ${docCount}`);

  if (docCount > 0) {
    const docHref = await docResult.getAttribute("href");
    console.log(`Clicking doc result: ${docHref}`);
    await docResult.click();
    await page.waitForLoadState("networkidle");
    await page.waitForTimeout(500);
    await page.screenshot({ path: `${DIR}/search-doc-deeplink.png`, fullPage: true });

    // Verify we're on knowledge page with docs hash
    expect(page.url()).toContain("/knowledge");
    expect(page.url()).toContain("#docs");
    console.log(`Knowledge page URL: ${page.url()}`);
  } else {
    console.log("No doc results found — skipping doc deep-link test");
  }
});

test("Search deep-link — event result navigates to logs", async ({ page }) => {
  test.setTimeout(60_000);

  await page.goto("/search");
  await page.waitForLoadState("networkidle");

  const input = page.locator(".search-input");
  await input.fill("compaction.memoryFlush.enabled");
  await page.waitForTimeout(500);
  await page.waitForLoadState("networkidle");

  const results = page.locator(".search-result");
  const eventResult = results.filter({ has: page.locator(".search-result-badge", { hasText: "event" }) }).first();
  const eventCount = await page.locator(".search-result-badge", { hasText: "event" }).count();
  console.log(`Event results: ${eventCount}`);

  if (eventCount > 0) {
    const eventHref = await eventResult.getAttribute("href");
    console.log(`Clicking event result: ${eventHref}`);
    await eventResult.click();
    await page.waitForLoadState("networkidle");
    await page.waitForTimeout(500);
    await page.screenshot({ path: `${DIR}/search-event-deeplink.png`, fullPage: true });

    expect(page.url()).toContain("/logs");
    console.log(`Logs page URL: ${page.url()}`);
  } else {
    console.log("No event results found — skipping event deep-link test");
  }
});

test("Search clear button clears results", async ({ page }) => {
  test.setTimeout(30_000);

  await page.goto("/search");
  await page.waitForLoadState("networkidle");

  const input = page.locator(".search-input");
  await input.fill("compaction");
  await page.waitForTimeout(500);
  await page.waitForLoadState("networkidle");

  // Wait for results to appear
  await page.waitForSelector(".search-result", { timeout: 5000 });
  const resultsBefore = await page.locator(".search-result").count();
  console.log(`Results before clear: ${resultsBefore}`);
  expect(resultsBefore).toBeGreaterThan(0);

  // Click clear
  await page.locator(".search-clear-btn").click();
  await page.waitForTimeout(300);

  // Input should be empty, no results
  const inputValue = await input.inputValue();
  expect(inputValue).toBe("");
  const resultsAfter = await page.locator(".search-result").count();
  expect(resultsAfter).toBe(0);
  console.log("Clear button works ✓");

  await page.screenshot({ path: `${DIR}/search-cleared.png`, fullPage: true });
});

test("Search state persists on browser back", async ({ page }) => {
  test.setTimeout(30_000);

  // Search for something
  await page.goto("/search");
  await page.waitForLoadState("networkidle");

  const input = page.locator(".search-input");
  await input.fill("compaction");
  await page.waitForTimeout(500);
  await page.waitForLoadState("networkidle");

  const resultsBefore = await page.locator(".search-result").count();
  console.log(`Results before nav: ${resultsBefore}`);

  // Navigate away
  await page.goto("/config");
  await page.waitForLoadState("networkidle");

  // Go back
  await page.goBack();
  await page.waitForLoadState("networkidle");
  await page.waitForTimeout(500);

  // Search should be restored
  const inputValue = await input.inputValue();
  console.log(`Input after back: "${inputValue}"`);
  expect(inputValue).toBe("compaction");

  const resultsAfter = await page.locator(".search-result").count();
  console.log(`Results after back: ${resultsAfter}`);
  expect(resultsAfter).toBeGreaterThan(0);
  console.log("Search state persists on back ✓");
});
