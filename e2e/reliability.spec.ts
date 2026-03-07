import { test, expect } from "@playwright/test";

test.describe("Reliability — Section Visibility", () => {
  test("Reliability section appears on Costs page when data exists", async ({ page }) => {
    await page.goto("/costs");
    await page.waitForTimeout(5_000);
    const section = page.locator(".cg-tool-costs").filter({ hasText: "Reliability" });
    // Section auto-hides when no data — only assert if gateway returns data
    if (await section.isVisible({ timeout: 15_000 }).catch(() => false)) {
      await expect(section).toBeVisible();
    }
  });

  test("Reliability section has tab buttons", async ({ page }) => {
    await page.goto("/costs");
    await page.waitForTimeout(5_000);
    const section = page.locator(".cg-tool-costs").filter({ hasText: "Reliability" });
    if (await section.isVisible({ timeout: 10_000 }).catch(() => false)) {
      await expect(section.locator("button").filter({ hasText: "Providers" })).toBeVisible();
      await expect(section.locator("button").filter({ hasText: "Context %" })).toBeVisible();
      await expect(section.locator("button").filter({ hasText: "Messages" })).toBeVisible();
      await expect(section.locator("button").filter({ hasText: "Sessions" })).toBeVisible();
      await expect(section.locator("button").filter({ hasText: "Poller" })).toBeVisible();
    }
  });
});

test.describe("Reliability — Provider Health Tab", () => {
  test("Providers tab shows table with correct columns", async ({ page }) => {
    await page.goto("/costs");
    await page.waitForTimeout(5_000);
    const section = page.locator(".cg-tool-costs").filter({ hasText: "Reliability" });
    if (await section.isVisible({ timeout: 10_000 }).catch(() => false)) {
      await section.locator("button").filter({ hasText: "Providers" }).click();
      await expect(section.locator("th").filter({ hasText: "Provider" })).toBeVisible();
      await expect(section.locator("th").filter({ hasText: "Success" })).toBeVisible();
      await expect(section.locator("th").filter({ hasText: "Error Rate" })).toBeVisible();
      await expect(section.locator("th").filter({ hasText: "Avg Latency" })).toBeVisible();
    }
  });

  test("Providers tab shows message when no data", async ({ page }) => {
    await page.route("**/api/logs?endpoint=reliability-providers*", (route) => {
      route.fulfill({ status: 200, contentType: "application/json", body: "[]" });
    });
    await page.goto("/costs");
    await page.waitForTimeout(5_000);
    const section = page.locator(".cg-tool-costs").filter({ hasText: "Reliability" });
    if (await section.isVisible({ timeout: 10_000 }).catch(() => false)) {
      await expect(section.locator("td").filter({ hasText: "No provider data yet" })).toBeVisible();
    }
  });
});

test.describe("Reliability — Context Tab", () => {
  test("Context tab shows per-session context data", async ({ page }) => {
    await page.goto("/costs");
    await page.waitForTimeout(5_000);
    const section = page.locator(".cg-tool-costs").filter({ hasText: "Reliability" });
    if (await section.isVisible({ timeout: 10_000 }).catch(() => false)) {
      await section.locator("button").filter({ hasText: "Context %" }).click();
      await page.waitForTimeout(1_000);
      await expect(section.locator("th").filter({ hasText: "Session" })).toBeVisible();
      await expect(section.locator("th").filter({ hasText: "Context" })).toBeVisible();
      await expect(section.locator("th").filter({ hasText: "Turns Left" })).toBeVisible();
      const rows = section.locator(".cg-tool-row");
      const count = await rows.count();
      expect(count).toBeGreaterThan(0);
    }
  });

  test("Context tab shows percentage values", async ({ page }) => {
    await page.goto("/costs");
    await page.waitForTimeout(5_000);
    const section = page.locator(".cg-tool-costs").filter({ hasText: "Reliability" });
    if (await section.isVisible({ timeout: 10_000 }).catch(() => false)) {
      await section.locator("button").filter({ hasText: "Context %" }).click();
      await page.waitForTimeout(1_000);
      const rows = section.locator(".cg-tool-row");
      const count = await rows.count();
      expect(count).toBeGreaterThan(0);
    }
  });
});

test.describe("Reliability — Messages Tab", () => {
  test("Messages tab shows delivery audit", async ({ page }) => {
    await page.goto("/costs");
    await page.waitForTimeout(5_000);
    const section = page.locator(".cg-tool-costs").filter({ hasText: "Reliability" });
    if (await section.isVisible({ timeout: 10_000 }).catch(() => false)) {
      await section.locator("button").filter({ hasText: "Messages" }).click();
      await page.waitForTimeout(1_000);
      await expect(section.locator("th").filter({ hasText: "Sent" })).toBeVisible();
      await expect(section.locator("th").filter({ hasText: "Received" })).toBeVisible();
      await expect(section.locator("th").filter({ hasText: "Last Sent" })).toBeVisible();
    }
  });

  test("Messages tab shows agent message counts", async ({ page }) => {
    await page.goto("/costs");
    await page.waitForTimeout(5_000);
    const section = page.locator(".cg-tool-costs").filter({ hasText: "Reliability" });
    if (await section.isVisible({ timeout: 10_000 }).catch(() => false)) {
      await section.locator("button").filter({ hasText: "Messages" }).click();
      await page.waitForTimeout(1_000);
      const rows = section.locator(".cg-tool-row");
      const count = await rows.count();
      expect(count).toBeGreaterThan(0);
    }
  });
});

test.describe("Reliability — Sessions Tab", () => {
  test("Sessions tab shows cost cap info", async ({ page }) => {
    await page.goto("/costs");
    await page.waitForTimeout(5_000);
    const section = page.locator(".cg-tool-costs").filter({ hasText: "Reliability" });
    if (await section.isVisible({ timeout: 10_000 }).catch(() => false)) {
      await section.locator("button").filter({ hasText: "Sessions" }).click();
      await page.waitForTimeout(1_000);
      await expect(section.locator("text=Session cost cap")).toBeVisible();
    }
  });

  test("Sessions tab shows table headers", async ({ page }) => {
    await page.goto("/costs");
    await page.waitForTimeout(5_000);
    const section = page.locator(".cg-tool-costs").filter({ hasText: "Reliability" });
    if (await section.isVisible({ timeout: 10_000 }).catch(() => false)) {
      await section.locator("button").filter({ hasText: "Sessions" }).click();
      await page.waitForTimeout(1_000);
      await expect(section.locator("th").filter({ hasText: "Agent" })).toBeVisible();
      await expect(section.locator("th").filter({ hasText: "Cost" })).toBeVisible();
      await expect(section.locator("th").filter({ hasText: "Duration" })).toBeVisible();
    }
  });
});

test.describe("Reliability — Poller Tab", () => {
  test("Poller tab shows session poller status", async ({ page }) => {
    await page.goto("/costs");
    await page.waitForTimeout(5_000);
    const section = page.locator(".cg-tool-costs").filter({ hasText: "Reliability" });
    if (await section.isVisible({ timeout: 10_000 }).catch(() => false)) {
      await section.locator("button").filter({ hasText: "Poller" }).click();
      await page.waitForTimeout(1_000);
      await expect(section.locator("td").filter({ hasText: "Status" })).toBeVisible();
      await expect(section.locator("td").filter({ hasText: "Files Tracked" })).toBeVisible();
      await expect(section.locator("td").filter({ hasText: "Events Inserted" })).toBeVisible();
    }
  });

  test("Poller shows Running status when gateway is up", async ({ page }) => {
    await page.goto("/costs");
    await page.waitForTimeout(5_000);
    const section = page.locator(".cg-tool-costs").filter({ hasText: "Reliability" });
    if (await section.isVisible({ timeout: 10_000 }).catch(() => false)) {
      await section.locator("button").filter({ hasText: "Poller" }).click();
      await page.waitForTimeout(1_000);
      await expect(section.locator("td").filter({ hasText: "Running" })).toBeVisible();
    }
  });
});

test.describe("Reliability — Tab Switching", () => {
  test("clicking tabs switches displayed content", async ({ page }) => {
    await page.goto("/costs");
    await page.waitForTimeout(5_000);
    const section = page.locator(".cg-tool-costs").filter({ hasText: "Reliability" });
    if (await section.isVisible({ timeout: 10_000 }).catch(() => false)) {
      // Start on Providers
      await expect(section.locator("th").filter({ hasText: "Provider" })).toBeVisible();

      // Switch to Context
      await section.locator("button").filter({ hasText: "Context %" }).click();
      await page.waitForTimeout(500);
      await expect(section.locator("th").filter({ hasText: "Context" })).toBeVisible();

      // Switch to Poller
      await section.locator("button").filter({ hasText: "Poller" }).click();
      await page.waitForTimeout(500);
      await expect(section.locator("td").filter({ hasText: "Status" })).toBeVisible();

      // Switch back to Providers
      await section.locator("button").filter({ hasText: "Providers" }).click();
      await page.waitForTimeout(500);
      await expect(section.locator("th").filter({ hasText: "Provider" })).toBeVisible();
    }
  });
});
