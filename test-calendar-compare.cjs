const { chromium } = require("playwright");

(async () => {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1400, height: 1200 } });

  // Screenshot /calendar
  await page.goto("http://localhost:3000/calendar");
  await page.waitForTimeout(3000);
  await page.screenshot({ path: "/tmp/calendar-page.png", fullPage: false });

  // Screenshot /calendar with Calendar view
  await page.goto("http://localhost:3000/calendar");
  await page.waitForTimeout(3000);
  
  // Click "Calendar" view tab
  const calBtn = await page.$('button:has-text("Calendar")');
  if (calBtn) {
    await calBtn.click();
    await page.waitForTimeout(2000);
  }
  await page.screenshot({ path: "/tmp/temp-calendar.png", fullPage: false });

  await browser.close();
})();
