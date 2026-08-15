import { expect, test } from "@playwright/test";
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

  await expect(page.getByLabel("Your Name *")).toBeVisible();
  await page.getByLabel("Your Name *").fill("Compose E2E");
  await page.getByRole("button", { name: "Continue" }).click();

  await expect(page.getByRole("button", { name: "Reset to Defaults" })).toBeVisible();
  await page.getByRole("button", { name: "Continue" }).click();
  await page.getByRole("button", { name: "Continue" }).click();
  await page.getByRole("button", { name: "Save & Continue" }).click();

  await expect(page.getByText("Set up your first bank account", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Create your first account" }).click();
  await page.getByLabel("Account Name").fill("E2E Savings");
  await page.getByRole("dialog").getByRole("combobox").first().click();
  await page.getByRole("option", { name: "Savings Account" }).click();
  await page.getByRole("button", { name: "Create Account" }).click();
  await expect(page.getByText("E2E Savings", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Continue" }).click();

  await expect(page.getByText("Import your transactions", { exact: true })).toBeVisible();
  await page.locator("#csv-file-input").setInputFiles(path.join(process.cwd(), "e2e/fixtures/transactions.csv"));
  await page.getByRole("button", { name: "Continue" }).click();

  await expect(page.getByText("Map your columns", { exact: true })).toBeVisible();
  await expect(page.getByText("AI mapping applied.", { exact: false })).toBeVisible();
  await page.getByRole("button", { name: "Preview Transactions" }).click();

  await expect(page.getByText("Preview your import", { exact: true })).toBeVisible();
  await expect(page.getByText("Salary payment")).toBeVisible();
  await page.getByRole("button", { name: /Import 2 Transactions/ }).click();
  await expect(page.getByRole("button", { name: "Get Started" })).toBeVisible();
  await page.getByRole("button", { name: "Get Started" }).click();

  await expect(page.getByRole("heading", { name: "Dashboard" })).toBeVisible();
  await page.getByRole("button", { name: "Close walkthrough" }).click();

  await page.goto("/budget");
  await expect(page.getByRole("heading", { name: "Budget" })).toBeVisible();
  await expect(page.getByText("Budget failed to load")).not.toBeVisible();
  await expect(page.getByText("Monthly Budget")).toBeVisible();

  await page.getByRole("button", { name: "Expand sidebar" }).click();
  await page.getByRole("button", { name: /Compose E2E/ }).click();
  await page.getByRole("menuitem", { name: "Log out" }).click();
  await expect(page.getByText("Login to your account", { exact: true })).toBeVisible();
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password").fill(password);
  await page.getByRole("button", { name: "Login" }).click();
  await expect(page.getByRole("heading", { name: "Dashboard" })).toBeVisible();
  await expect.poll(() => browserErrors, { message: "browser console errors" }).toEqual([]);
  expect(serverFailures, "server-side failures observed by the browser").toEqual([]);
});
