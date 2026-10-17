import { expect, test, type Page } from "@playwright/test";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";

// Explicitly opt in: these fixtures belong only in the isolated release lab.
const dbContainer = process.env.FINANCE_UAT_DB_CONTAINER;
test.skip(!dbContainer, "Set FINANCE_UAT_DB_CONTAINER to an isolated release-lab postgres container");

function sqlLiteral(value: string) { return `'${value.replaceAll("'", "''")}'`; }
function card(page: Page, title: string) {
  return page.locator('[data-slot="card"]').filter({ has: page.getByText(title, { exact: true }) });
}
async function money(page: Page, title: string, value: string) {
  await expect(card(page, title)).toContainText(value);
}

async function assertCharts(page: Page) {
  const bars = card(page, "Income vs Expenses").locator(".recharts-bar-rectangle path");
  await expect.poll(async () => bars.count()).toBeGreaterThan(0);
  // Non-zero heights prove actual plotted income/expense, rather than an empty SVG.
  await expect.poll(async () => bars.evaluateAll(nodes => nodes.filter(node => node.getBoundingClientRect().height > 1).length)).toBeGreaterThanOrEqual(2);
  const flow = card(page, "Cash Flow");
  await flow.scrollIntoViewIfNeeded();
  await expect(flow.getByText("No transaction data available for cash flow visualization")).toHaveCount(0);
  await expect.poll(async () => flow.locator('path[stroke^="url(#sankey-link-"]').count()).toBeGreaterThan(0);
  await expect(flow).toContainText(/Uncategor/i);
}

test("uncategorised activity, gross property, debt and unequal ownership reconcile in the browser", async ({ page, baseURL }, testInfo) => {
  test.setTimeout(150_000);
  const url = new URL(baseURL!);
  expect(["localhost", "127.0.0.1", "[::1]"]).toContain(url.hostname);
  const project = execFileSync("docker", ["inspect", dbContainer!, "--format", '{{ index .Config.Labels "com.docker.compose.project" }}'], { encoding: "utf8" }).trim();
  expect(project).toMatch(/^syllogic-release-lab-/);
  const psql = (input: string) => execFileSync("docker", ["exec", "-i", dbContainer!, "psql", "-U", process.env.FINANCE_UAT_DB_USER || "financeuser", "-d", process.env.FINANCE_UAT_DB_NAME || "finance_db", "-Atq", "-v", "ON_ERROR_STOP=1"], { input, encoding: "utf8" });
  const email = `finance-reporting-${randomUUID()}@example.test`;
  const password = `SyntheticUat!${randomUUID()}`;
  const response = await page.request.post("/api/auth/sign-up/email", {
    headers: { Origin: url.origin }, data: { email, password, name: "Finance UAT" },
  });
  expect(response.ok(), `synthetic registration status ${response.status()}`).toBeTruthy();
  const { user } = await response.json();
  expect(typeof user?.id).toBe("string");
  const userId = user.id as string;
  const ids = { cash: randomUUID(), mortgage: randomUUID(), property: randomUUID(), alex: randomUUID(), bea: randomUUID() };
  const u = sqlLiteral(userId);
  // Only a brand-new randomly named user is seeded. No existing user data or
  // release-lab demo fixtures are reset, updated, or removed.
  psql(`BEGIN;
    DO $$ BEGIN
      IF NOT EXISTS (SELECT 1 FROM users WHERE id=${u} AND email=${sqlLiteral(email)})
        OR EXISTS (SELECT 1 FROM accounts WHERE user_id=${u}) THEN
        RAISE EXCEPTION 'Expected empty synthetic UAT user';
      END IF;
    END $$;
    UPDATE users SET functional_currency='AUD', onboarding_status='completed', onboarding_completed_at=now() WHERE id=${u};
    UPDATE people SET kind='member' WHERE user_id=${u} AND kind='self';
    INSERT INTO people(id,user_id,name,kind) VALUES
      ('${ids.alex}',${u},'UAT Alex','self'),('${ids.bea}',${u},'UAT Bea','member');
    INSERT INTO accounts(id,user_id,name,account_type,currency,provider,starting_balance,functional_balance) VALUES
      ('${ids.cash}',${u},'UAT Shared Cash','checking','AUD','manual',21000,25000),
      ('${ids.mortgage}',${u},'UAT Mortgage','mortgage','AUD','manual',520000,520000);
    INSERT INTO account_balances(account_id,date,balance_in_account_currency,balance_in_functional_currency) VALUES
      ('${ids.cash}',CURRENT_DATE,25000,25000),('${ids.mortgage}',CURRENT_DATE,520000,520000);
    INSERT INTO properties(id,user_id,name,property_type,current_value,currency,valuation_date) VALUES
      ('${ids.property}',${u},'UAT Home','residential',750000,'AUD',CURRENT_DATE);
    INSERT INTO property_liability_links(property_id,account_id,user_id) VALUES ('${ids.property}','${ids.mortgage}',${u});
    INSERT INTO property_owners(property_id,person_id,share) VALUES
      ('${ids.property}','${ids.alex}',0.5),('${ids.property}','${ids.bea}',0.5);
    INSERT INTO account_owners(account_id,person_id,share) VALUES
      ('${ids.cash}','${ids.alex}',0.6),('${ids.cash}','${ids.bea}',0.4),
      ('${ids.mortgage}','${ids.alex}',0.6),('${ids.mortgage}','${ids.bea}',0.4);
    INSERT INTO account_ownership_allocations(account_id,person_id,effective_from,share)
      SELECT account_id,person_id,CURRENT_DATE-60,share FROM account_owners WHERE account_id IN ('${ids.cash}','${ids.mortgage}');
    INSERT INTO transactions(user_id,account_id,amount,functional_amount,currency,description,booked_at,transaction_type,category_id,category_system_id,include_in_analytics) VALUES
      (${u},'${ids.cash}',5000,5000,'AUD','UAT uncategorised income',CURRENT_DATE-1,NULL,NULL,NULL,true),
      (${u},'${ids.cash}',-1000,-1000,'AUD','UAT uncategorised expense',CURRENT_DATE-1,NULL,NULL,NULL,true);
    COMMIT;`);

  await page.addInitScript(({ userId }) => {
    localStorage.setItem("personal-portfolio.walkthrough.completed", JSON.stringify({ state: { completedPages: ["home", "assets", "transactions"], userId }, version: 0 }));
  }, { userId });
  const errors: string[] = [];
  page.on("pageerror", error => errors.push(error.message));
  page.on("response", response => { if (response.status() >= 500) errors.push(`${response.status()} ${new URL(response.url()).pathname}`); });
  await page.goto("/?horizon=30");
  await expect(page.getByRole("heading", { name: "Dashboard", exact: true })).toBeVisible();
  await money(page, "Total Cash", "A$25,000");
  await money(page, "Total Liabilities", "-A$520,000");
  await money(page, "30-Day Spending", "A$1,000");
  await money(page, "30-Day Income", "A$5,000");
  await expect(card(page, "Savings Rate")).toContainText("80.0%");
  const netWorth = page.locator('[data-slot="card"]').filter({ has: page.locator('[data-slot="card-title"]').getByText("Net Worth", { exact: true }) });
  await expect(netWorth).toContainText("A$255,000");
  await expect(netWorth).toContainText("A$775,000");
  await expect(netWorth).toContainText("-A$520,000");
  await expect(netWorth).toContainText("Whole household");
  await assertCharts(page);
  await page.screenshot({ path: testInfo.outputPath("whole-household.png"), fullPage: true });

  // Use the visible person controls, not a hard-coded filtered API request.
  await page.getByRole("button", { name: /UAT Alex$/ }).click();
  await expect(page).toHaveURL(new RegExp(`person=${ids.alex}`));
  await money(page, "Total Cash", "A$15,000");
  await money(page, "Total Liabilities", "-A$312,000");
  await money(page, "30-Day Spending", "A$600");
  await money(page, "30-Day Income", "A$3,000");
  await expect(netWorth).toContainText("A$78,000");
  await expect(netWorth).toContainText("A$390,000");
  await expect(netWorth).toContainText("Selected person’s share");
  await assertCharts(page);
  await page.screenshot({ path: testInfo.outputPath("alex-share.png"), fullPage: true });

  await page.getByRole("button", { name: /UAT Bea$/ }).click();
  await money(page, "Total Cash", "A$10,000");
  await money(page, "Total Liabilities", "-A$208,000");
  await expect(netWorth).toContainText("A$177,000");
  await expect(netWorth).toContainText("A$385,000");
  await page.getByRole("button", { name: "All", exact: true }).click();
  await money(page, "Total Cash", "A$25,000");
  await expect(netWorth).toContainText("A$255,000");

  await page.goto(`/accounts/${ids.mortgage}`);
  await expect(page.getByText("-A$520,000.00", { exact: true })).toHaveClass(/text-red/);
  await expect(page.getByText("Balance owed", { exact: true })).toBeVisible();
  expect(errors, "rendered-page errors and server failures").toEqual([]);
  await testInfo.attach("fixture-identifiers", { body: JSON.stringify({ email, userId, ...ids }), contentType: "application/json" });
});
