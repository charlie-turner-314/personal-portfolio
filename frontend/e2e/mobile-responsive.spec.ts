import { test, expect } from "@playwright/test";

// Run only against an isolated lab, with its generated demo credentials supplied
// in the environment. Never log credentials or store authenticated browser state.
test.beforeEach(async ({ page }) => {
  test.skip(!process.env.MOBILE_UAT_EMAIL || !process.env.MOBILE_UAT_PASSWORD, "Requires isolated lab credentials");
  const response = await page.request.post("/api/auth/sign-in/email", {
    data: { email: process.env.MOBILE_UAT_EMAIL, password: process.env.MOBILE_UAT_PASSWORD },
    headers: { Origin: process.env.E2E_BASE_URL || "http://localhost:8102" },
  });
  expect(response.ok()).toBeTruthy();
});

for (const width of [320, 390, 768, 1440]) {
  test(`dashboard routes fit a ${width}px viewport and navigation remains available`, async ({ page }, testInfo) => {
    test.setTimeout(180_000);
    await page.setViewportSize({ width, height: width < 768 ? 844 : 1000 });
    for (const path of ["/", "/transactions", "/subscriptions", "/budget", "/cashflow", "/investments", "/assets", "/reports", "/reports/new", "/reports/tax-year", "/settings", "/transactions/import"]) {
      await page.goto(path);
      await expect(page.locator("main")).toBeVisible();
      await page.waitForTimeout(500);
      expect(new URL(page.url()).pathname, `authenticated route ${path}`).toBe(path);
      const overflow = await page.evaluate(() => ({ width: document.documentElement.clientWidth, scroll: document.documentElement.scrollWidth }));
      expect(overflow.scroll, `${path} page must fit without clipping or page-wide horizontal scrolling`).toBeLessThanOrEqual(overflow.width + 1);
      if (width < 768) {
        await expect(page.getByRole("navigation", { name: "Mobile navigation" })).toBeVisible();
      }
      await page.screenshot({ path: testInfo.outputPath(`${path.replaceAll("/", "_") || "home"}.png`), fullPage: true });
    }
    if (width < 768) {
      await page.getByRole("button", { name: "Toggle Sidebar" }).click();
      const drawer = page.getByRole("dialog");
      await expect(drawer).toBeVisible();
      for (const name of ["Home", "Transactions", "Subscriptions", "Budget", "Cashflow", "Investments", "Assets", "Reports", "Settings"]) {
        await expect(drawer.getByRole("link", { name, exact: true })).toBeVisible();
      }
      await drawer.getByRole("link", { name: "Transactions", exact: true }).click();
      await expect(drawer).not.toBeVisible();
      await expect(page).toHaveURL(/\/transactions(?:\?|$)/);
    }
  });
}
