import { test, expect } from "@playwright/test";

// Run only against an isolated lab, with its generated demo credentials supplied
// in the environment. Never log credentials or store authenticated browser state.
test.beforeEach(async ({ page }) => {
  test.skip(!process.env.MOBILE_UAT_EMAIL || !process.env.MOBILE_UAT_PASSWORD, "Requires isolated lab credentials");
  let response = await page.request.post("/api/auth/sign-in/email", {
    data: { email: process.env.MOBILE_UAT_EMAIL, password: process.env.MOBILE_UAT_PASSWORD },
    headers: { Origin: process.env.E2E_BASE_URL || "http://localhost:8102" },
  });
  for (let attempt = 0; response.status() === 429 && attempt < 4; attempt++) {
    await page.waitForTimeout(15_000);
    response = await page.request.post("/api/auth/sign-in/email", {
      data: { email: process.env.MOBILE_UAT_EMAIL, password: process.env.MOBILE_UAT_PASSWORD },
      headers: { Origin: process.env.E2E_BASE_URL || "http://localhost:8102" },
    });
  }
  expect(response.ok()).toBeTruthy();
});

for (const width of [320, 390, 768, 1440]) {
  test(`dashboard routes fit a ${width}px viewport and navigation remains available`, async ({ page }, testInfo) => {
    test.setTimeout(180_000);
    await page.setViewportSize({ width, height: width < 768 ? 844 : 1000 });
    for (const path of ["/", "/category-spending", "/investments/connect", "/settings/connect-bank", ...(process.env.MOBILE_UAT_ACCOUNT_ID ? [`/accounts/${process.env.MOBILE_UAT_ACCOUNT_ID}`] : []), ...(process.env.MOBILE_UAT_HOLDING_ID ? [`/investments/${process.env.MOBILE_UAT_HOLDING_ID}`] : []), "/transactions", "/subscriptions", "/budget", "/cashflow", "/investments", "/assets", "/reports", "/reports/new", "/reports/tax-year", "/settings", "/transactions/import"]) {
      await page.goto(path);
      await expect(page.locator("main")).toBeVisible();
      await page.waitForTimeout(500);
      expect(new URL(page.url()).pathname, `authenticated route ${path}`).toBe(path);
      const overflow = await page.evaluate(() => ({ width: document.documentElement.clientWidth, scroll: document.documentElement.scrollWidth }));
      expect.soft(overflow.scroll, `${path} page must fit without clipping or page-wide horizontal scrolling`).toBeLessThanOrEqual(overflow.width + 1);
      if (width < 768) {
        await expect(page.getByRole("navigation", { name: "Mobile navigation" })).toBeVisible();
      }
      if (path === "/settings") {
        const tabs = page.getByRole("tablist");
        const tabBounds = await tabs.boundingBox();
        const panelBounds = await page.getByRole("tabpanel").boundingBox();
        expect.soft(panelBounds?.y, "settings panel must follow all tab rows").toBeGreaterThanOrEqual((tabBounds?.y ?? 0) + (tabBounds?.height ?? 0));
        for (const tab of await tabs.getByRole("tab").all()) {
          const bounds = await tab.boundingBox();
          expect.soft((bounds?.y ?? 0) + (bounds?.height ?? 0), "tab must fit within its list").toBeLessThanOrEqual((tabBounds?.y ?? 0) + (tabBounds?.height ?? 0) + 1);
        }
      }
      const closeWalkthrough = page.getByRole("button", { name: "Close walkthrough" });
      if (await closeWalkthrough.isVisible()) {
        const bounds = await closeWalkthrough.boundingBox();
        expect.soft(bounds?.x).toBeGreaterThanOrEqual(0);
        expect.soft((bounds?.x ?? 0) + (bounds?.width ?? 0)).toBeLessThanOrEqual(width);
        await closeWalkthrough.click();
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

test("phone overlays, date presets, transaction details and bulk actions stay reachable", async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 640 });
  const closeTour = async () => {
    const close = page.getByRole("button", { name: "Close walkthrough" });
    await expect(close).toBeVisible();
    await close.click();
  };
  const expectFits = async (locator: ReturnType<typeof page.locator>) => {
    await expect(locator).toBeVisible();
    await expect(async () => {
    const bounds = await locator.boundingBox();
    expect(bounds!.x).toBeGreaterThanOrEqual(0);
    expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(321);
    expect(bounds!.y).toBeGreaterThanOrEqual(0);
    expect(bounds!.y + bounds!.height).toBeLessThanOrEqual(641);
    }).toPass({ timeout: 5_000 });
  };
  await page.goto("/");
  await closeTour();
  await page.getByRole("button", { name: "Date", exact: true }).click();
  const datePicker = page.locator('[data-slot="popover-content"]');
  await expectFits(datePicker);
  await datePicker.getByRole("button", { name: "Last Month", exact: true }).click();
  await expect(datePicker).not.toBeVisible();

  await page.goto("/transactions");
  await closeTour();
  await page.getByRole("button", { name: "Add Transaction", exact: true }).click();
  const dialog = page.getByRole("dialog");
  await expectFits(dialog);
  await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(dialog).not.toBeVisible();

  await page.getByRole("checkbox", { name: "Select row", exact: true }).first().click();
  await expect(page.getByText("1 selected", { exact: true })).toBeVisible();
  await expectFits(page.getByTitle("Categorize", { exact: true }));
  await expectFits(page.getByTitle("Analytics", { exact: true }));
  await page.screenshot({ path: "test-results/phone-bulk-actions.png", fullPage: true });

  await page.getByRole("checkbox", { name: "Select row", exact: true }).first().click();
  await page.getByRole("button", { name: "Table", exact: true }).click();
  await expect(page.getByRole("table")).toBeVisible();
  await page.getByRole("button", { name: "Cards", exact: true }).click();
  const firstCard = page.getByRole("article").first();
  await expect(firstCard.getByText("Account", { exact: true })).toBeVisible();
  await expect(firstCard.getByText("Category", { exact: true })).toBeVisible();
  await firstCard.getByRole("button", { name: /^View transaction:/ }).click();
  await expectFits(page.getByRole("dialog"));
  await page.getByRole("dialog").getByRole("button", { name: "Close", exact: true }).click();
  await expect(page.getByRole("dialog")).not.toBeVisible();
});
