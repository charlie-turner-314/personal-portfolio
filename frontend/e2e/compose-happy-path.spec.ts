import { expect, test, type Page } from "@playwright/test";
import path from "node:path";

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

  await page.goto("/register");
  await page.getByLabel("Name").fill("Compose E2E");
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password", { exact: true }).fill(password);
  await page.getByLabel("Confirm Password").fill(password);
  await page.getByRole("button", { name: "Sign up" }).click();

  await expect(page.getByRole("heading", { name: /welcome.*set up your profile/i })).toBeVisible();
  await page.getByLabel("Your Name *").fill("Compose E2E");
  await page.getByRole("button", { name: "Continue" }).click();

  await expect(page.getByRole("heading", { name: "Set up your categories" })).toBeVisible();
  await page.getByRole("button", { name: "Continue" }).click();
  await page.getByRole("button", { name: "Continue" }).click();
  await page.getByRole("button", { name: "Save & Continue" }).click();

  await expect(page.getByRole("heading", { name: "Set up your first bank account" })).toBeVisible();
  await page.getByRole("button", { name: "Create your first account" }).click();
  await page.getByLabel("Account Name").fill("E2E Savings");
  await page.getByText("Account Type", { exact: true }).locator("..").getByRole("button").click();
  await page.getByRole("option", { name: "Savings Account" }).click();
  await page.getByRole("button", { name: "Create Account" }).click();
  await expect(page.getByText("E2E Savings", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Continue" }).click();

  await expect(page.getByRole("heading", { name: "Import your transactions" })).toBeVisible();
  await page.locator("#csv-file-input").setInputFiles(path.join(process.cwd(), "e2e/fixtures/transactions.csv"));
  await page.getByRole("button", { name: "Continue" }).click();

  await expect(page.getByRole("heading", { name: "Map your columns" })).toBeVisible();
  await mapColumn(page, "Date", "Date");
  await mapColumn(page, "Amount", "Amount");
  await mapColumn(page, "Description", "Description");
  await page.getByRole("checkbox", { name: "Amount is signed" }).check();
  await page.getByRole("button", { name: "Preview Transactions" }).click();

  await expect(page.getByRole("heading", { name: "Review your transactions" })).toBeVisible();
  await expect(page.getByText("Salary payment")).toBeVisible();
  await page.getByRole("button", { name: /Import 2 Transactions/ }).click();
  await expect(page.getByRole("button", { name: "Get Started" })).toBeVisible();
  await page.getByRole("button", { name: "Get Started" }).click();

  await expect(page.getByText("Dashboard")).toBeVisible();
  await expect.poll(() => browserErrors, { message: "browser console errors" }).toEqual([]);
  expect(serverFailures, "server-side failures observed by the browser").toEqual([]);

  await page.getByRole("button", { name: /Compose E2E/ }).click();
  await page.getByRole("menuitem", { name: "Log out" }).click();
  await expect(page.getByRole("heading", { name: "Login to your account" })).toBeVisible();
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password").fill(password);
  await page.getByRole("button", { name: "Login" }).click();
  await expect(page.getByText("Dashboard")).toBeVisible();
});

async function mapColumn(page: Page, field: string, column: string) {
  const row = page.getByText(field, { exact: true }).locator("xpath=../..");
  await row.getByRole("button").click();
  await page.getByRole("option", { name: column, exact: true }).click();
}
