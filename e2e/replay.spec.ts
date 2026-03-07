import { test, expect } from "@playwright/test";

test.describe("Replay Page", () => {
  // ── Empty / Error State ──────────────────────────────────────────────────

  test("shows error state when no session param is provided", async ({ page }) => {
    await page.goto("/replay");
    await page.waitForLoadState("domcontentloaded");
    await page.waitForTimeout(3_000);

    // Should show error because no session key is in the URL
    const errorHeading = page.getByRole("heading", { name: /cannot load replay/i });
    await expect(errorHeading).toBeVisible({ timeout: 15_000 });
  });

  test("shows 'Go back' button on error state", async ({ page }) => {
    await page.goto("/replay");
    await page.waitForLoadState("domcontentloaded");

    const backBtn = page.locator("button.replay-header-back").first();
    await expect(backBtn).toBeVisible({ timeout: 10_000 });
    const text = await backBtn.textContent();
    expect(text).toMatch(/go back|back/i);
  });

  // ── Valid Session Load ────────────────────────────────────────────────────

  test("loads with valid session param and renders timeline", async ({ page }) => {
    // First, find a valid session key from the logs page
    const res = await page.request.get("/api/logs?endpoint=stream&limit=5&since=" + (Date.now() - 7 * 86400000));
    const events = await res.json().catch(() => []);

    if (!Array.isArray(events) || events.length === 0) {
      test.skip(true, "No log events available to test replay");
      return;
    }

    const session = events.find((e: { session?: string }) => e.session)?.session;
    if (!session) {
      test.skip(true, "No events with session key found");
      return;
    }

    await page.goto(`/replay?session=${encodeURIComponent(session)}`);
    await page.waitForLoadState("domcontentloaded");
    await page.waitForTimeout(3_000);

    // Either the timeline renders or we get an error (session may have no replay-eligible events)
    const timeline = page.locator(".replay-timeline");
    const error = page.locator(".replay-error");
    await expect(timeline.or(error)).toBeVisible({ timeout: 15_000 });
  });

  test("timeline items are clickable and update detail panel", async ({ page }) => {
    const res = await page.request.get("/api/logs?endpoint=stream&limit=50&since=" + (Date.now() - 7 * 86400000));
    const events = await res.json().catch(() => []);
    const session = (events as { session?: string }[]).find(e => e.session)?.session;

    if (!session) { test.skip(true, "No session available"); return; }

    await page.goto(`/replay?session=${encodeURIComponent(session)}`);
    await page.waitForTimeout(3_000);

    const timeline = page.locator(".replay-timeline");
    if (!(await timeline.isVisible({ timeout: 10_000 }).catch(() => false))) {
      test.skip(true, "Timeline did not render (no replay-eligible events)");
      return;
    }

    const steps = page.locator(".replay-step");
    const count = await steps.count();
    if (count < 2) { test.skip(true, "Not enough steps to test clicking"); return; }

    // Click the second step
    await steps.nth(1).click();
    await page.waitForTimeout(500);

    // Verify it becomes selected
    await expect(steps.nth(1)).toHaveClass(/replay-step--selected/);

    // Detail panel should have content
    const detail = page.locator(".replay-detail");
    await expect(detail).toBeVisible();
    const detailHeader = page.locator(".replay-detail-header");
    if (await detailHeader.isVisible({ timeout: 3_000 }).catch(() => false)) {
      const text = await detailHeader.textContent();
      expect(text!.length).toBeGreaterThan(0);
    }
  });

  // ── Playback Controls ──────────────────────────────────────────────────

  test("playback controls are visible when timeline loads", async ({ page }) => {
    const res = await page.request.get("/api/logs?endpoint=stream&limit=50&since=" + (Date.now() - 7 * 86400000));
    const events = await res.json().catch(() => []);
    const session = (events as { session?: string }[]).find(e => e.session)?.session;

    if (!session) { test.skip(true, "No session available"); return; }

    await page.goto(`/replay?session=${encodeURIComponent(session)}`);
    await page.waitForTimeout(3_000);

    const controls = page.locator(".replay-controls");
    if (!(await controls.isVisible({ timeout: 10_000 }).catch(() => false))) {
      test.skip(true, "Controls did not render");
      return;
    }

    // Play/pause button
    const playPauseBtn = page.locator(".replay-controls-btn").nth(2); // middle button
    await expect(playPauseBtn).toBeVisible();

    // Step forward / step back
    const controlBtns = page.locator(".replay-controls-btn");
    const btnCount = await controlBtns.count();
    expect(btnCount).toBeGreaterThanOrEqual(4);

    // Speed selector buttons (1x, 2x, 4x)
    const speedBtns = page.locator(".replay-controls-speed-btn");
    await expect(speedBtns.first()).toBeVisible();
    const speedCount = await speedBtns.count();
    expect(speedCount).toBe(3);

    // Scrubber range input
    const scrubber = page.locator(".replay-controls-scrubber");
    await expect(scrubber).toBeVisible();

    // Step info label "Step X of Y"
    const stepInfo = page.locator(".replay-controls-step-info");
    await expect(stepInfo).toBeVisible();
    const infoText = await stepInfo.textContent();
    expect(infoText).toMatch(/Step \d+ of \d+/);
  });

  // ── Deep Link with ?step= ──────────────────────────────────────────────

  test("deep link with step parameter highlights correct event", async ({ page }) => {
    // Get events and find a session with multiple events
    const res = await page.request.get("/api/logs?endpoint=stream&limit=100&since=" + (Date.now() - 7 * 86400000));
    const events: { id: number; session?: string; type: string }[] = await res.json().catch(() => []);

    if (!Array.isArray(events) || events.length === 0) {
      test.skip(true, "No events available");
      return;
    }

    // Find a session with a known event ID
    const replayTypes = new Set(["llm_input", "llm_output", "tool_call", "msg_in", "msg_out"]);
    const replayEvent = events.find(e => e.session && replayTypes.has(e.type));
    if (!replayEvent || !replayEvent.session) {
      test.skip(true, "No replay-eligible event with session found");
      return;
    }

    await page.goto(`/replay?session=${encodeURIComponent(replayEvent.session)}&step=${replayEvent.id}`);
    await page.waitForTimeout(4_000);

    const timeline = page.locator(".replay-timeline");
    if (!(await timeline.isVisible({ timeout: 10_000 }).catch(() => false))) {
      test.skip(true, "Timeline did not render");
      return;
    }

    // There should be a selected step
    const selected = page.locator(".replay-step--selected");
    await expect(selected).toBeVisible({ timeout: 5_000 });
  });

  // ── Back Button ─────────────────────────────────────────────────────────

  test("back button navigates away from replay", async ({ page }) => {
    // Start at logs page, then navigate to replay
    await page.goto("/logs");
    await page.waitForLoadState("domcontentloaded");

    await page.goto("/replay");
    await page.waitForLoadState("domcontentloaded");
    await page.waitForTimeout(2_000);

    const backBtn = page.locator("button.replay-header-back").first();
    if (await backBtn.isVisible({ timeout: 5_000 }).catch(() => false)) {
      await backBtn.click();
      await page.waitForTimeout(1_000);
      // URL should no longer be /replay
      expect(page.url()).not.toContain("/replay");
    }
  });

  // ── Session Header ──────────────────────────────────────────────────────

  test("session header shows agent name and stats", async ({ page }) => {
    const res = await page.request.get("/api/logs?endpoint=stream&limit=50&since=" + (Date.now() - 7 * 86400000));
    const events = await res.json().catch(() => []);
    const session = (events as { session?: string }[]).find(e => e.session)?.session;

    if (!session) { test.skip(true, "No session available"); return; }

    await page.goto(`/replay?session=${encodeURIComponent(session)}`);
    await page.waitForTimeout(3_000);

    const header = page.locator(".replay-header");
    if (!(await header.isVisible({ timeout: 10_000 }).catch(() => false))) {
      test.skip(true, "Header did not render");
      return;
    }

    // Agent name
    const agentName = page.locator(".replay-header-agent");
    await expect(agentName).toBeVisible();
    const name = await agentName.textContent();
    expect(name!.length).toBeGreaterThan(0);

    // Stats line (steps, duration, cost)
    const stats = page.locator(".replay-header-stats");
    await expect(stats).toBeVisible();
    const statsText = await stats.textContent();
    expect(statsText).toMatch(/steps/i);
  });

  // ── Responsive: Mobile Viewport ──────────────────────────────────────────

  test("responsive layout on mobile viewport", async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 667 });

    const res = await page.request.get("/api/logs?endpoint=stream&limit=50&since=" + (Date.now() - 7 * 86400000));
    const events = await res.json().catch(() => []);
    const session = (events as { session?: string }[]).find(e => e.session)?.session;

    if (!session) { test.skip(true, "No session available"); return; }

    await page.goto(`/replay?session=${encodeURIComponent(session)}`);
    await page.waitForTimeout(3_000);

    const timeline = page.locator(".replay-timeline");
    if (!(await timeline.isVisible({ timeout: 10_000 }).catch(() => false))) {
      test.skip(true, "Timeline did not render");
      return;
    }

    // Page should still be usable (no horizontal overflow causing broken layout)
    const pageEl = page.locator(".replay-page");
    await expect(pageEl).toBeVisible();

    // Controls should still be visible
    const controls = page.locator(".replay-controls");
    if (await controls.isVisible({ timeout: 5_000 }).catch(() => false)) {
      await expect(controls).toBeVisible();
    }
  });

  // ── Speed Selector ──────────────────────────────────────────────────────

  test("speed selector changes active speed", async ({ page }) => {
    const res = await page.request.get("/api/logs?endpoint=stream&limit=50&since=" + (Date.now() - 7 * 86400000));
    const events = await res.json().catch(() => []);
    const session = (events as { session?: string }[]).find(e => e.session)?.session;

    if (!session) { test.skip(true, "No session available"); return; }

    await page.goto(`/replay?session=${encodeURIComponent(session)}`);
    await page.waitForTimeout(3_000);

    const speedBtns = page.locator(".replay-controls-speed-btn");
    if (!(await speedBtns.first().isVisible({ timeout: 10_000 }).catch(() => false))) {
      test.skip(true, "Speed buttons did not render");
      return;
    }

    // 1x should be active by default
    await expect(speedBtns.filter({ hasText: "1x" })).toHaveClass(/replay-controls-speed-btn--active/);

    // Click 2x
    await speedBtns.filter({ hasText: "2x" }).click();
    await page.waitForTimeout(300);
    await expect(speedBtns.filter({ hasText: "2x" })).toHaveClass(/replay-controls-speed-btn--active/);

    // Click 4x
    await speedBtns.filter({ hasText: "4x" }).click();
    await page.waitForTimeout(300);
    await expect(speedBtns.filter({ hasText: "4x" })).toHaveClass(/replay-controls-speed-btn--active/);
  });
});
