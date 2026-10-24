import { expect, test, type Page } from "@playwright/test";
import path from "node:path";
import { readFileSync } from "node:fs";
import { parseDelimitedText } from "../lib/import/parsing";

async function expectPageFits(page: Page) {
  const bounds = await page.evaluate(() => ({ width: document.documentElement.clientWidth, scroll: document.documentElement.scrollWidth }));
  expect(bounds.scroll, `Page ${new URL(page.url()).pathname} must fit the viewport`).toBeLessThanOrEqual(bounds.width + 1);
}

async function registerAndReachTransactionImport(page: Page, email: string, password: string, multiAccount = false) {
  await page.goto("/register");
  await page.getByLabel("Name").fill("Compose E2E");
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password", { exact: true }).fill(password);
  await page.getByLabel("Confirm Password").fill(password);
  await page.getByRole("button", { name: "Sign up" }).click();

  await expect(page.getByLabel("Your Name *")).toBeVisible();
  await page.getByLabel("Your Name *").fill("Compose E2E");
  await expectPageFits(page);
  await page.getByRole("button", { name: "Continue" }).click();

  await expect(page.getByRole("button", { name: "Reset to Defaults" })).toBeVisible();
  await expectPageFits(page);
  await page.getByRole("button", { name: "Continue" }).click();
  await page.getByRole("button", { name: "Continue" }).click();
  await page.getByRole("button", { name: "Save & Continue" }).click();

  await expect(page.getByText("Set up your first bank account", { exact: true })).toBeVisible();
  await expectPageFits(page);
  await page.getByRole("button", { name: "Create your first account" }).click();
  await page.getByLabel("Account Name").fill("E2E Savings");
  await page.getByRole("dialog").getByRole("combobox").first().click();
  await page.getByRole("option", { name: "Savings Account" }).click();
  if (multiAccount) {
    await page.getByRole("dialog").getByRole("combobox").nth(1).click();
    await page.getByRole("option", { name: "AUD - Australian Dollar", exact: true }).click();
  }
  // Wait for the Select portal's exit animation before submitting the form.
  await expect(page.getByRole("option")).toHaveCount(0);
  await page.getByRole("button", { name: "Create Account" }).click();
  await expect(page.getByText("E2E Savings", { exact: true })).toBeVisible();
  if (multiAccount) {
    await page.getByRole("button", { name: "Add another account" }).click();
    await page.getByLabel("Account Name").fill("E2E Spending");
    await page.getByRole("dialog").getByRole("combobox").first().click();
    await page.getByRole("option", { name: "Savings Account" }).click();
    await page.getByRole("dialog").getByRole("combobox").nth(1).click();
    await page.getByRole("option", { name: "AUD - Australian Dollar", exact: true }).click();
    await expect(page.getByRole("option")).toHaveCount(0);
    await page.getByRole("button", { name: "Create Account" }).click();
    await expect(page.getByText("E2E Spending", { exact: true })).toBeVisible();
  }
  await page.getByRole("button", { name: "Continue" }).click();

  await expect(page.getByText("Import your transactions", { exact: true })).toBeVisible();
  await expectPageFits(page);
}

test("a new user can onboard, import transactions, and sign in again", async ({ page }) => {
  const email = `compose-e2e-${Date.now()}@example.test`;
  const password = "ComposeE2E!123";
  const browserErrors: string[] = [];
  const serverFailures: string[] = [];

  page.on("console", (message) => {
    if (message.type() === "error") browserErrors.push(message.text());
  });
  page.on("response", (response) => {
    if (response.status() >= 500) serverFailures.push(`${response.status()} ${response.url()}`);
  });

  await registerAndReachTransactionImport(page, email, password);
  // Deliberately historical data: a recent upload must not make old data current.
  const csv = readFileSync(path.join(process.cwd(), "e2e/fixtures/transactions.csv"), "utf8")
    .replaceAll("2026-07-", "2000-07-");
  await page.locator("#csv-file-input").setInputFiles({
    name: "transactions.csv", mimeType: "text/csv", buffer: Buffer.from(csv),
  });
  await page.getByRole("button", { name: "Continue" }).click();

  await expect(page.getByText("Map your columns", { exact: true })).toBeVisible();
  await expectPageFits(page);
  await expect(page.getByText("Suggested mapping applied from CSV headers; AI analysis was not used.")).toBeVisible();
  await page.getByRole("button", { name: "Preview Transactions" }).click();

  await expect(page.getByText("Preview your import", { exact: true })).toBeVisible();
  await expectPageFits(page);
  await expect(page.getByText("Salary payment")).toBeVisible();
  await page.getByRole("button", { name: /Import 2 Transactions/ }).click();
  await expect(page.getByRole("button", { name: "Get Started" })).toBeVisible();
  await page.getByRole("button", { name: "Get Started" }).click();

  await expect(page.getByRole("heading", { name: "Dashboard" })).toBeVisible();
  await page.getByRole("button", { name: "Close walkthrough" }).click();

  await page.goto("/budget");
  await expect(page.getByRole("heading", { name: "Budget" })).toBeVisible();
  await expect(page.getByText("Budget failed to load")).not.toBeVisible();
  await expect(page.getByRole("main").getByText("Monthly Budget", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Close walkthrough" })).toBeVisible();
  await page.getByRole("button", { name: "Close walkthrough" }).click();

  if ((page.viewportSize()?.width ?? 1440) < 768) {
    await page.getByRole("button", { name: "Toggle Sidebar" }).click();
  } else {
    await page.getByRole("button", { name: "Expand sidebar" }).click();
  }
  await page.getByRole("button", { name: /Compose E2E/ }).click();
  await page.getByRole("menuitem", { name: "Log out" }).click();
  await expect(page.getByText("Login to your account", { exact: true })).toBeVisible();
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password").fill(password);
  await page.getByRole("button", { name: "Login" }).click();
  await expect(page.getByRole("heading", { name: "Dashboard" })).toBeVisible();

  await page.goto("/assets");
  await page.getByRole("button", { name: "Close walkthrough" }).click();
  // Onboarding can finish while the queued CSV import is still processing.
  await expect(async () => {
    await page.reload();
    await expect(page.getByText(/Update recommended/)).toBeVisible();
  }).toPass({ timeout: 60_000 });
  // Closing a walkthrough skips it for this render; a reload starts it again.
  await page.getByRole("button", { name: "Close walkthrough" }).click();
  await page.getByRole("button", { name: "Upload CSV", exact: true }).click();
  await expect(page).toHaveURL(/\/transactions\/import\?accountId=/);
  await expect(page.getByRole("combobox")).toHaveText("E2E Savings");
  const accountId = new URL(page.url()).searchParams.get("accountId");
  expect(accountId).toBeTruthy();
  await page.goto(`/accounts/${accountId}`);
  await expect(page.getByText(/Update recommended/)).toBeVisible();
  await page.getByRole("button", { name: "Upload CSV", exact: true }).click();
  await expect(page.getByRole("combobox")).toHaveText("E2E Savings");

  await expect.poll(() => browserErrors, { message: "browser console errors" }).toEqual([]);
  expect(serverFailures, "server-side failures observed by the browser").toEqual([]);
});

test("a new user can finish onboarding without a transaction CSV", async ({ page }) => {
  const email = `compose-e2e-no-csv-${Date.now()}@example.test`;
  const password = "ComposeE2E!123";
  const serverFailures: string[] = [];
  page.on("response", (response) => {
    if (response.status() >= 500) serverFailures.push(`${response.status()} ${response.url()}`);
  });

  await registerAndReachTransactionImport(page, email, password);
  await expect(page.getByText(/import transactions later/i)).toBeVisible();
  await page.getByRole("button", { name: "Do this later" }).click();

  await expect(page.getByRole("heading", { name: "Dashboard" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Close walkthrough" })).toBeVisible();
  await page.getByRole("button", { name: "Close walkthrough" }).click();
  expect(serverFailures, "server-side failures observed by the browser").toEqual([]);
});


test("multi-account CSV confirms aliases, imports transfer pairs and detects reimports", async ({ page }) => {
  test.setTimeout(150_000);
  const email = `compose-e2e-multi-${Date.now()}@example.test`;
  await registerAndReachTransactionImport(page, email, "ComposeE2E!123", true);
  const privateSample = process.env.PPF41_SAMPLE_CSV;
  const csv = privateSample ? readFileSync(privateSample, "utf8") :
    "Date,Description,Debit,Credit,Source account,Destination account,Transaction ID\n2026-10-08,Shared move,,100,Reserve,Daily,transfer-1\n2026-10-09,Example purchase,20,,Daily,,purchase-1";
  const rows = privateSample ? 50 : 2;
  const aliases = privateSample ? { "Save Account": "E2E Savings", "Savings account": "E2E Savings", "Pay Account": "E2E Spending", "Spend account": "E2E Spending" } : { Reserve: "E2E Savings", Daily: "E2E Spending" };
  const upload = async () => {
    await page.locator("#csv-file-input").setInputFiles({ name: "multi-account.csv", mimeType: "text/csv", buffer: Buffer.from(csv) });
    await page.getByRole("button", { name: "Continue", exact: true }).click();
    await expect(page.getByRole("heading", { name: "Confirm accounts" })).toBeVisible();
    for (const [alias, account] of Object.entries(aliases)) {
      const selector = page.getByLabel(`Account for ${alias}`, { exact: true });
      await expect(selector).toHaveValue("");
      await selector.selectOption({ label: `${account} (AUD)` });
    }
    await page.getByRole("button", { name: "Preview Transactions" }).click();
  };
  await upload();
  await expect(page.getByText(/E2E Savings → E2E Spending · Internal transfer/).first()).toBeVisible();
  await page.getByRole("button", { name: `Import ${rows} Transactions`, exact: true }).click();
  await page.getByRole("button", { name: "Get Started" }).click();
  await expect(page.getByRole("heading", { name: "Dashboard" })).toBeVisible();
  await page.getByRole("button", { name: "Close walkthrough" }).click();
  await page.goto("/transactions");
  // The import must finish before testing duplicate detection.
  const expectedDescription = privateSample ? parseDelimitedText(csv, ",").rows[0][1] : "Example purchase";
  await expect(async () => {
    await page.reload();
    await expect(page.getByText(expectedDescription, { exact: true }).first()).toBeVisible();
  }).toPass({ timeout: 60_000 });
  await page.goto("/transactions/import");
  await upload();
  await expect(page.getByRole("button", { name: "Import 0 Transactions", exact: true })).toBeDisabled();
});
