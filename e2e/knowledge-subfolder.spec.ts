import { test, expect } from "@playwright/test";

test.describe("Knowledge Page — Subfolder Navigation", () => {
  test("can navigate to shared-docs subfolders (Open-source, Session-logs)", async ({ page }) => {
    const errors: string[] = [];
    page.on("pageerror", (err) => errors.push(err.message));
    page.on("console", (msg) => {
      if (msg.type() === "error") errors.push(msg.text());
    });

    // Go to Knowledge > Docs tab
    await page.goto("/knowledge#docs");
    await page.waitForLoadState("domcontentloaded");
    await page.waitForTimeout(3_000);

    // Should show Docs mode
    const sidebar = page.locator(".agents-sidebar");
    await expect(sidebar).toBeVisible({ timeout: 10_000 });
    await expect(page.locator(".agents-sidebar-header")).toHaveText("Docs");

    // First agent should be auto-selected
    const agentBtns = page.locator(".agents-sidebar-btn");
    await expect(agentBtns.first()).toBeVisible({ timeout: 10_000 });

    // Click first agent if not already selected
    const firstAgentBtn = agentBtns.first();
    await firstAgentBtn.click();
    await page.waitForTimeout(2_000);

    // Should see folder toggles in sidebar
    const folders = page.locator(".ft-folder-toggle");
    await expect(folders.first()).toBeVisible({ timeout: 5_000 });

    // Collect all folder names
    const folderNames: string[] = [];
    const count = await folders.count();
    for (let i = 0; i < count; i++) {
      const text = await folders.nth(i).textContent();
      if (text) folderNames.push(text.trim());
    }
    console.log("Folders found:", folderNames);

    // Should have "shared-docs" folder with subfolders like "shared-docs/Open-source"
    const hasSharedDocs = folderNames.some((n) => n.includes("shared-docs") && !n.includes("/"));
    const hasSharedDocsSubfolder = folderNames.some((n) => n.includes("shared-docs/"));

    console.log("Has shared-docs:", hasSharedDocs);
    console.log("Has shared-docs subfolder:", hasSharedDocsSubfolder);
    expect(hasSharedDocsSubfolder).toBeTruthy();

    // Find and click the "shared-docs/Open-source" folder
    const openSourceFolder = folders.filter({ hasText: /Open-source/ });
    if (await openSourceFolder.count() > 0) {
      await openSourceFolder.first().click();
      await page.waitForTimeout(1_000);

      // Should see files inside
      const filesInFolder = page.locator(".ft-folder-children:not(.ft-folder-children--closed) .ft-file--deep");
      const fileCount = await filesInFolder.count();
      console.log("Files in Open-source folder:", fileCount);
      expect(fileCount).toBeGreaterThan(0);

      // Click a file
      await filesInFolder.first().click();
      await page.waitForTimeout(2_000);

      // File viewer should show
      const viewer = page.locator(".fv-viewer");
      await expect(viewer).toBeVisible({ timeout: 5_000 });
    }

    // Report any errors
    const realErrors = errors.filter(
      (e) => !e.includes("favicon") && !e.includes("hydration")
    );
    console.log("Console errors:", realErrors);
    expect(realErrors).toHaveLength(0);
  });
});
