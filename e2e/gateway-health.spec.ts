import { test, expect } from "@playwright/test";

const HEALTH_ROUTE = "**/api/gateway-health";

function mockHealth(page: import("@playwright/test").Page, data: Record<string, unknown>) {
  return page.route(HEALTH_ROUTE, (route) => {
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(data),
    });
  });
}

const OK_RESPONSE = {
  ok: true, status: 200, uptime: 7200, droppedEvents: 0,
  activeLoops: 0, loops: [], memoryMB: 142,
};

test.describe("Gateway Health — Status Indicator", () => {
  test("gateway health indicator is visible in header", async ({ page }) => {
    await mockHealth(page, OK_RESPONSE);
    await page.goto("/");
    await page.waitForTimeout(3_000);
    const health = page.locator(".gateway-health");
    await expect(health).toBeVisible({ timeout: 10_000 });
  });

  test("gateway health shows 'Gateway' label", async ({ page }) => {
    await mockHealth(page, OK_RESPONSE);
    await page.goto("/");
    await page.waitForTimeout(3_000);
    const label = page.locator(".gateway-health-label");
    await expect(label).toBeVisible({ timeout: 10_000 });
    await expect(label).toHaveText("Gateway");
  });

  test("gateway health shows a status dot", async ({ page }) => {
    await mockHealth(page, OK_RESPONSE);
    await page.goto("/");
    await page.waitForTimeout(3_000);
    const dot = page.locator(".gateway-health-dot");
    await expect(dot).toBeAttached({ timeout: 10_000 });
    const classes = await dot.getAttribute("class");
    expect(classes).toContain("gateway-health-dot--");
  });

  test("gateway health resolves to ok with mocked healthy response", async ({ page }) => {
    await mockHealth(page, OK_RESPONSE);
    await page.goto("/");
    await page.waitForTimeout(3_000);
    const statusEl = page.locator(".gateway-health-status--ok");
    await expect(statusEl).toBeVisible({ timeout: 10_000 });
    await expect(statusEl).toHaveText("Ok");
  });

  test("status dot has correct CSS class for ok state", async ({ page }) => {
    await mockHealth(page, OK_RESPONSE);
    await page.goto("/");
    await page.waitForTimeout(3_000);
    const dot = page.locator(".gateway-health-dot");
    await expect(dot).toBeAttached({ timeout: 10_000 });
    const classes = await dot.getAttribute("class");
    expect(classes).toContain("gateway-health-dot--ok");
  });
});

test.describe("Gateway Health — OK State Details", () => {
  test("ok state shows green dot", async ({ page }) => {
    await mockHealth(page, OK_RESPONSE);
    await page.goto("/");
    await page.waitForTimeout(3_000);
    const okDot = page.locator(".gateway-health-dot--ok");
    await expect(okDot).toBeAttached({ timeout: 10_000 });
  });

  test("ok state shows uptime and memory in tooltip", async ({ page }) => {
    await mockHealth(page, OK_RESPONSE);
    await page.goto("/");
    await page.waitForTimeout(3_000);
    const health = page.locator(".gateway-health");
    await expect(health).toHaveAttribute("title", /Gateway up \d+m/, { timeout: 10_000 });
    const title = await health.getAttribute("title");
    expect(title).toMatch(/\d+MB RAM/);
  });

  test("ok state status label shows 'Ok'", async ({ page }) => {
    await mockHealth(page, OK_RESPONSE);
    await page.goto("/");
    await page.waitForTimeout(3_000);
    const okStatus = page.locator(".gateway-health-status--ok");
    await expect(okStatus).toBeVisible({ timeout: 10_000 });
    await expect(okStatus).toHaveText("Ok");
  });
});

test.describe("Gateway Health — Offline State", () => {
  test("offline state shows when gateway is unreachable", async ({ page }) => {
    await mockHealth(page, { ok: false, status: 0 });
    await page.goto("/");
    await page.waitForTimeout(3_000);

    const offlineStatus = page.locator(".gateway-health-status--offline");
    await expect(offlineStatus).toBeVisible({ timeout: 10_000 });
    await expect(offlineStatus).toHaveText("Offline");
  });

  test("offline state tooltip says 'Gateway status'", async ({ page }) => {
    await mockHealth(page, { ok: false, status: 0 });
    await page.goto("/");
    await page.waitForTimeout(3_000);

    const health = page.locator(".gateway-health");
    await expect(health).toHaveAttribute("title", "Gateway status", { timeout: 10_000 });
  });
});

test.describe("Gateway Health — Warn State (Stuck Loop)", () => {
  const mockLoopResponse = {
    ok: false,
    status: 503,
    uptime: 3600,
    droppedEvents: 0,
    activeLoops: 1,
    loops: [{ agent: "jane", tool: "Read", count: 15, since: Date.now() - 60000 }],
    memoryMB: 145,
  };

  test("warn state shows amber pulsing dot", async ({ page }) => {
    await mockHealth(page, mockLoopResponse);
    await page.goto("/");
    await page.waitForTimeout(3_000);

    const warnDot = page.locator(".gateway-health-dot--warn");
    await expect(warnDot).toBeAttached({ timeout: 10_000 });
  });

  test("warn state shows 'Loop!' label", async ({ page }) => {
    await mockHealth(page, mockLoopResponse);
    await page.goto("/");
    await page.waitForTimeout(3_000);

    const warnStatus = page.locator(".gateway-health-status--warn");
    await expect(warnStatus).toBeVisible({ timeout: 10_000 });
    await expect(warnStatus).toHaveText("Loop!");
  });

  test("warn tooltip shows stuck loop details", async ({ page }) => {
    await mockHealth(page, mockLoopResponse);
    await page.goto("/");
    await page.waitForTimeout(3_000);

    const health = page.locator(".gateway-health");
    const title = await health.getAttribute("title");
    expect(title).toContain("STUCK LOOP");
    expect(title).toContain("jane/Read");
    expect(title).toContain("15x");
  });

  test("warn state with multiple loops shows all in tooltip", async ({ page }) => {
    const multiLoop = {
      ...mockLoopResponse,
      activeLoops: 2,
      loops: [
        { agent: "jane", tool: "Read", count: 15, since: Date.now() - 60000 },
        { agent: "scout", tool: "Bash", count: 8, since: Date.now() - 30000 },
      ],
    };
    await mockHealth(page, multiLoop);
    await page.goto("/");
    await page.waitForTimeout(3_000);

    const health = page.locator(".gateway-health");
    const title = await health.getAttribute("title");
    expect(title).toContain("jane/Read (15x)");
    expect(title).toContain("scout/Bash (8x)");
  });
});

test.describe("Gateway Health — Dropped Events", () => {
  test("dropped events badge shows when events > 0 and not offline", async ({ page }) => {
    await mockHealth(page, {
      ok: true, status: 200, uptime: 600, droppedEvents: 5,
      activeLoops: 0, loops: [], memoryMB: 100,
    });
    await page.goto("/");
    await page.waitForTimeout(3_000);

    const dropped = page.locator(".gateway-health-dropped");
    await expect(dropped).toBeVisible({ timeout: 10_000 });
    await expect(dropped).toContainText("5 dropped");
  });

  test("dropped events badge shows count", async ({ page }) => {
    await mockHealth(page, {
      ok: true, status: 200, uptime: 600, droppedEvents: 3,
      activeLoops: 0, loops: [], memoryMB: 100,
    });
    await page.goto("/");
    await page.waitForTimeout(3_000);

    const dropped = page.locator(".gateway-health-dropped");
    await expect(dropped).toBeVisible({ timeout: 10_000 });
    await expect(dropped).toContainText("3 dropped");
  });

  test("dropped events badge hidden when count is 0", async ({ page }) => {
    await mockHealth(page, OK_RESPONSE);
    await page.goto("/");
    await page.waitForTimeout(3_000);

    const dropped = page.locator(".gateway-health-dropped");
    await expect(dropped).not.toBeVisible();
  });

  test("dropped events badge hidden when offline even if count > 0", async ({ page }) => {
    await mockHealth(page, { ok: false, status: 0 });
    await page.goto("/");
    await page.waitForTimeout(3_000);

    const dropped = page.locator(".gateway-health-dropped");
    await expect(dropped).not.toBeVisible();
  });
});

test.describe("Gateway Health — Auto-Refresh", () => {
  test("health refreshes on gateway-changed event", async ({ page }) => {
    let fetchCount = 0;
    await page.route(HEALTH_ROUTE, (route) => {
      fetchCount++;
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify(OK_RESPONSE),
      });
    });
    await page.goto("/");
    // Wait for initial fetch
    await page.waitForTimeout(3_000);
    const beforeEvent = fetchCount;
    expect(beforeEvent).toBeGreaterThanOrEqual(1);
    // Fire gateway-changed event (triggers setTimeout(check, 2000))
    await page.evaluate(() => {
      window.dispatchEvent(new Event("gateway-changed"));
    });
    // Wait 2s delay + buffer
    await page.waitForTimeout(5_000);
    expect(fetchCount).toBeGreaterThan(beforeEvent);
  });
});

test.describe("Gateway Health — Visible On All Pages", () => {
  const pages = ["/", "/logs", "/costs", "/config"];

  for (const path of pages) {
    test(`gateway health visible on ${path}`, async ({ page }) => {
      await mockHealth(page, OK_RESPONSE);
      await page.goto(path);
      await page.waitForLoadState("domcontentloaded");
      await page.waitForTimeout(3_000);
      const health = page.locator(".gateway-health");
      await expect(health).toBeVisible({ timeout: 10_000 });
    });
  }
});
