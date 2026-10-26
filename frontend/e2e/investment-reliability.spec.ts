import { expect, test, type Page } from "@playwright/test";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { writeFileSync } from "node:fs";
import path from "node:path";

const container = process.env.INVESTMENT_UAT_DB_CONTAINER;
test.skip(!container, "Requires an explicitly selected isolated release-lab database");
const quote = (value: string) => `'${value.replaceAll("'", "''")}'`;
function card(page: Page, title: string) {
  return page.locator('[data-slot="card"]').filter({ has: page.getByText(title, { exact: true }) });
}
async function fits(page: Page) {
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBeTruthy();
}

test("Australian investment import, fractional NAV, ownership, FY and mixed currencies reconcile", async ({ page, baseURL }, testInfo) => {
  test.setTimeout(180_000);
  const origin = new URL(baseURL!).origin;
  expect(["localhost", "127.0.0.1"]).toContain(new URL(baseURL!).hostname);
  const project = execFileSync("docker", ["inspect", container!, "--format", '{{index .Config.Labels "com.docker.compose.project"}}'], { encoding: "utf8" }).trim();
  expect(project).toMatch(/^syllogic-release-lab-/);
  const sql = (input: string) => execFileSync("docker", ["exec", "-i", container!, "psql", "-U", "financeuser", "-d", "finance_db", "-qAt", "-v", "ON_ERROR_STOP=1"], { input, encoding: "utf8" }).trim();
  const email = `investment-${randomUUID()}@example.test`;
  const password = `Synthetic!${randomUUID()}`;
  const registered = await page.request.post("/api/auth/sign-up/email", { headers: { Origin: origin }, data: { email, password, name: "Investment Owner" } });
  expect(registered.ok(), `Synthetic registration status ${registered.status()}`).toBeTruthy();
  const userId = (await registered.json()).user.id as string;
  const u = quote(userId);
  const symbol = `UAT${randomUUID().slice(0, 8).toUpperCase()}.AX`;
  const fundSymbol = `FUND${randomUUID().slice(0, 8).toUpperCase()}`;
  const self = randomUUID(), partner = randomUUID();
  // Only a new synthetic user's data is written. Cached synthetic prices avoid
  // contacting a market or broker during the browser journey.
  sql(`BEGIN;
    DO $$ BEGIN
      IF NOT EXISTS (SELECT 1 FROM users WHERE id=${u} AND email=${quote(email)}) OR EXISTS(SELECT 1 FROM accounts WHERE user_id=${u}) THEN
        RAISE EXCEPTION 'Expected empty synthetic investment user';
      END IF;
    END $$;
    UPDATE users SET functional_currency='AUD',onboarding_status='completed',onboarding_completed_at=now() WHERE id=${u};
    UPDATE people SET kind='member' WHERE user_id=${u} AND kind='self';
    INSERT INTO people(id,user_id,name,kind) VALUES ('${self}',${u},'Investment Owner','self'),('${partner}',${u},'Investment Partner','member');
    INSERT INTO price_snapshots(symbol,currency,date,close,provider,source_label) VALUES (${quote(symbol)},'AUD',CURRENT_DATE,110,'yahoo-v2','Synthetic UAT');
    COMMIT;`);
  await page.addInitScript(({ userId }) => {
    localStorage.setItem("personal-portfolio.walkthrough.completed", JSON.stringify({ state: { completedPages: ["home", "assets", "transactions"], userId }, version: 0 }));
  }, { userId });
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));

  await page.goto("/investments/connect");
  await page.getByRole("button", { name: "Import statement", exact: true }).click();
  await expect(page.getByText("Create an investment account", { exact: true })).toBeVisible();
  await page.getByLabel("Account name", { exact: true }).fill("AU statement account");
  await expect(page.getByLabel("Account currency", { exact: true })).toHaveValue("AUD");
  await page.getByRole("button", { name: "Create empty account" }).click();
  await expect(page.locator("#investment-import-currency")).toHaveValue("AUD");
  await page.locator("#csv-file-input").setInputFiles({ name: "synthetic-investments.csv", mimeType: "text/csv", buffer: Buffer.from(`Reference,Date,Type,Symbol,Quantity,Price,Currency,Asset Type\nUAT-1,2025-07-01,Buy,${symbol},10,100,AUD,ETF\n`) });
  await page.getByRole("button", { name: "Preview import", exact: true }).click();
  await expect(page.getByRole("button", { name: "Import 1 ready row", exact: true })).toBeEnabled();
  await page.getByRole("button", { name: "Import 1 ready row", exact: true }).click();
  await expect(page.getByText(/Imported 1 activity\./)).toBeVisible();
  expect(sql(`SELECT count(*) FROM holdings WHERE user_id=${u}`)).toBe("1");
  const account = sql(`SELECT id FROM accounts WHERE user_id=${u} AND name='AU statement account'`);
  const holding = sql(`SELECT id FROM holdings WHERE user_id=${u} AND symbol=${quote(symbol)}`);

  await page.goto("/investments/connect");
  await page.getByRole("button", { name: "Add manually", exact: true }).click();
  await page.getByRole("combobox", { name: "Account", exact: true }).click();
  await page.getByRole("option", { name: "+ Create new account…", exact: true }).click();
  await page.getByLabel("New account name", { exact: true }).fill("AU managed fund");
  await page.getByPlaceholder("Search symbol or name…").fill(fundSymbol);
  await page.getByRole("button", { name: "Managed fund", exact: true }).click();
  await page.getByLabel("Quantity", { exact: true }).fill("2.5");
  await expect(page.getByRole("combobox", { name: "Currency", exact: true })).toContainText("AUD");
  expect(await page.getByLabel("Quantity", { exact: true }).evaluate((element) => (element as HTMLInputElement).checkValidity())).toBeTruthy();
  await page.getByRole("button", { name: "Add 1 holding", exact: true }).click();
  await expect(page).toHaveURL(/\/investments$/);
  await expect(page.getByRole("row", { name: `View details for ${fundSymbol}` })).toBeVisible();
  await page.getByRole("row", { name: `View details for ${fundSymbol}` }).click();
  await page.getByRole("tab", { name: "About", exact: true }).click();
  await page.getByLabel("Price per unit", { exact: true }).fill("20");
  await page.getByRole("button", { name: "Save unit price" }).click();
  await expect.poll(() => sql(`SELECT COALESCE(max(value_user_currency),-1) FROM holding_valuations WHERE holding_id=(SELECT id FROM holdings WHERE user_id=${u} AND symbol=${quote(fundSymbol)})`)).toBe("50.00");
  const fundHolding = sql(`SELECT id FROM holdings WHERE user_id=${u} AND symbol=${quote(fundSymbol)}`);
  sql(`BEGIN;
    INSERT INTO account_ownership_allocations(account_id,person_id,effective_from,share) VALUES ('${account}','${self}',CURRENT_DATE-400,0.6),('${account}','${partner}',CURRENT_DATE-400,0.4);
    INSERT INTO investment_income_events(user_id,account_id,holding_id,event_type,pay_date,currency,cash_received,franking_credit) VALUES
      (${u},'${account}','${holding}','dividend',CURRENT_DATE-1,'AUD',25,5),
      (${u},'${account}','${holding}','dividend',CURRENT_DATE-1,'USD',10,0),
      (${u},'${account}','${holding}','dividend',date_trunc('year',CURRENT_DATE)::date+INTERVAL '5 months 27 days','AUD',40,0);
    COMMIT;`);
  await page.goto("/investments?personIds=all");
  await expect(card(page, "Portfolio value")).toContainText("1,150.00");
  const income = card(page, "Investment income");
  await expect(income.getByText("AUD", { exact: true })).toBeVisible();
  await expect(income.getByText("USD", { exact: true })).toBeVisible();
  await expect(income.getByText("A$ 25.00", { exact: true })).toBeVisible();
  await expect(income.getByText("A$ 65.00", { exact: true })).toBeVisible();
  await expect(page.getByText("Investment return", { exact: true }).locator("..")).toContainText("Unavailable");
  await page.getByRole("combobox", { name: "Australian financial year", exact: true }).click();
  const currentYear = new Date().getFullYear();
  await page.getByRole("option", { name: `FY${currentYear - 1}-${String(currentYear).slice(-2)}`, exact: true }).click();
  await expect(income.getByText("A$ 40.00", { exact: true })).toBeVisible();

  await page.getByRole("button", { name: "Investment Partner", exact: true }).click();
  await expect(card(page, "Portfolio value")).toContainText("440.00");
  await expect(page.getByRole("row", { name: `View details for ${fundSymbol}` })).toHaveCount(0);
  await page.screenshot({ path: testInfo.outputPath("investment-ownership-desktop.png"), fullPage: true });
  await page.goto(`/investments/${fundHolding}`);
  await page.getByRole("button", { name: "Edit", exact: true }).click();
  await page.getByLabel("Quantity", { exact: true }).fill("3.5");
  await page.getByRole("button", { name: "Save changes", exact: true }).click();
  await expect.poll(() => sql(`SELECT value_user_currency FROM holding_valuations WHERE holding_id='${fundHolding}' ORDER BY date DESC LIMIT 1`)).toBe("70.00");

  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/investments/connect");
  await page.getByRole("button", { name: "Add manually", exact: true }).click();
  await page.getByRole("button", { name: "Crypto", exact: true }).click();
  await page.getByLabel("Quantity", { exact: true }).fill("0.125");
  await fits(page);
  await page.screenshot({ path: testInfo.outputPath("investment-entry-mobile.png"), fullPage: true });
  expect(errors).toEqual([]);
  writeFileSync(path.resolve(process.cwd(), "../.release-lab/investment-browser-fixture.json"), JSON.stringify({ user_id: userId, email, account_id: account, holding_id: holding, fund_holding_id: fundHolding }), { mode: 0o600 });
});
