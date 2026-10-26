import { expect, test } from "@playwright/test";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";

// Mutations are allowed only against a named, isolated lab and brand-new users.
const dbContainer = process.env.FINANCE_UAT_DB_CONTAINER;
test.skip(!dbContainer, "Requires an isolated release-lab database");
const literal = (value: string) => `'${value.replaceAll("'", "''")}'`;

test("saving stays independent of a partner contribution and explicit principal allocation", async ({ page, browser, baseURL }, testInfo) => {
  test.setTimeout(150_000);
  const url = new URL(baseURL!);
  expect(["localhost", "127.0.0.1", "[::1]"]).toContain(url.hostname);
  const project = execFileSync("docker", ["inspect", dbContainer!, "--format", '{{ index .Config.Labels "com.docker.compose.project" }}'], { encoding: "utf8" }).trim();
  expect(project).toMatch(/^syllogic-release-lab-/);
  const psql = (input: string) => execFileSync("docker", ["exec", "-i", dbContainer!, "psql", "-U", process.env.FINANCE_UAT_DB_USER || "financeuser", "-d", process.env.FINANCE_UAT_DB_NAME || "finance_db", "-Atq", "-v", "ON_ERROR_STOP=1"], { input, encoding: "utf8" });
  const register = async (request: typeof page.request, name: string) => {
    const response = await request.post("/api/auth/sign-up/email", {
      headers: { Origin: url.origin },
      data: { email: `cash-flow-${randomUUID()}@example.test`, password: `Synthetic!${randomUUID()}`, name },
    });
    expect(response.ok()).toBeTruthy();
    return (await response.json()).user.id as string;
  };
  const owner = await register(page.request, "Cash Flow Owner");
  const partnerContext = await browser.newContext({ baseURL });
  const partner = await register(partnerContext.request, "Cash Flow Partner");
  const ids = Object.fromEntries(["ownerSelf", "own", "shared", "partnerCash", "linked", "housing", "investment", "transfer", "primary", "credit", "principal", "group"].map(key => [key, randomUUID()]));
  const o = literal(owner), p = literal(partner);
  psql(`BEGIN;
    DO $$ BEGIN
      IF EXISTS (SELECT 1 FROM accounts WHERE user_id IN (${o},${p})) THEN RAISE EXCEPTION 'Expected empty synthetic users'; END IF;
    END $$;
    UPDATE users SET functional_currency='AUD', onboarding_status='completed', onboarding_completed_at=now() WHERE id IN (${o},${p});
    INSERT INTO people(id,user_id,name,kind,linked_user_id)
      SELECT '${ids.ownerSelf}',${o},'Cash Flow Owner','self',${o}
      WHERE NOT EXISTS (SELECT 1 FROM people WHERE user_id=${o} AND kind='self');
    INSERT INTO people(id,user_id,name,kind,linked_user_id) VALUES ('${ids.linked}',${o},'Cash Flow Partner','member',${p});
    INSERT INTO household_memberships(member_user_id,owner_user_id,person_id) VALUES (${p},${o},'${ids.linked}');
    INSERT INTO accounts(id,user_id,name,account_type,currency,provider) VALUES
      ('${ids.own}',${o},'Personal cash','checking','AUD','manual'),
      ('${ids.shared}',${o},'Shared cash','checking','AUD','manual'),
      ('${ids.partnerCash}',${p},'Partner private cash','checking','AUD','manual');
    INSERT INTO account_ownership_allocations(account_id,person_id,effective_from,share)
      SELECT '${ids.shared}',id,'1900-01-01',0.5 FROM people
      WHERE (user_id=${o} AND kind='self') OR id='${ids.linked}';
    INSERT INTO household_account_shares(account_id,member_user_id,granted_by_user_id) VALUES ('${ids.shared}',${p},${o});
    INSERT INTO categories(id,user_id,name,category_type,cash_flow_kind) VALUES
      ('${ids.housing}',${o},'Housing','expense',NULL),
      ('${ids.investment}',${o},'Long-term allocation','expense','investment'),
      ('${ids.transfer}',${o},'Internal Transfer','transfer',NULL);
    INSERT INTO transactions(user_id,account_id,amount,functional_amount,currency,description,booked_at) VALUES
      (${o},'${ids.own}',6000,6000,'AUD','Earned income',CURRENT_DATE-2),
      (${o},'${ids.own}',-2000,-2000,'AUD','Everyday spending',CURRENT_DATE-2);
    INSERT INTO transactions(user_id,account_id,amount,functional_amount,currency,description,booked_at,category_id) VALUES
      (${o},'${ids.own}',-1000,-1000,'AUD','Investment cash movement',CURRENT_DATE-2,'${ids.investment}');
    INSERT INTO transactions(id,user_id,account_id,amount,functional_amount,currency,description,booked_at,category_id) VALUES
      ('${ids.primary}',${p},'${ids.partnerCash}',-70000,-70000,'AUD','Partner contribution',CURRENT_DATE-2,'${ids.transfer}'),
      ('${ids.credit}',${o},'${ids.shared}',70000,70000,'AUD','Shared contribution received',CURRENT_DATE-2,'${ids.transfer}'),
      ('${ids.principal}',${o},'${ids.shared}',-70000,-70000,'AUD','Mortgage payment for purpose review',CURRENT_DATE-1,'${ids.housing}');
    INSERT INTO transaction_links(user_id,group_id,transaction_id,link_role) VALUES
      (${o},'${ids.group}','${ids.primary}','primary'),(${o},'${ids.group}','${ids.credit}','reimbursement');
    COMMIT;`);
  await page.addInitScript(({ userId }) => {
    localStorage.setItem("personal-portfolio.walkthrough.completed", JSON.stringify({ state: { completedPages: ["home", "transactions"], userId }, version: 0 }));
  }, { userId: owner });
  const errors: string[] = [];
  page.on("pageerror", error => errors.push(error.message));
  page.on("response", response => { if (response.status() >= 500) errors.push(`${response.status()} ${new URL(response.url()).pathname}`); });
  const summary = () => page.locator('[data-slot="card"]').filter({ has: page.getByText("Income, consumption and capital movements", { exact: true }) });
  const assertMetric = async (label: string, amount: string) => {
    await expect(summary().locator("dl > div").filter({ has: page.getByText(label, { exact: true }) })).toContainText(amount);
  };
  await page.goto("/?horizon=30");
  await assertMetric("Saving from income", "-A$31,000");
  await assertMetric("Investments", "A$1,000");
  await assertMetric("Ownership transfers in", "A$35,000");
  await expect(summary().getByRole("status")).toContainText("unavailable");
  await expect(page.getByText("Partner private cash", { exact: true })).toHaveCount(0);
  // Classify through the actual transaction UI, preserving category and money.
  await page.goto(`/transactions?search=Mortgage%20payment%20for%20purpose%20review&horizon=30`);
  await page.getByText("Mortgage payment for purpose review", { exact: true }).first().click();
  await expect(page.getByLabel("Cash-flow purpose")).toBeVisible();
  await page.getByLabel("Cash-flow purpose").selectOption("loan_principal");
  await page.getByRole("button", { name: "Save cash-flow purpose" }).click();
  await expect.poll(() => psql(`SELECT cash_flow_parts->0->>'detail' FROM transactions WHERE id='${ids.principal}';`).trim()).toBe("loan_principal");
  psql(`INSERT INTO account_balances(account_id,date,balance_in_account_currency,balance_in_functional_currency) VALUES
    ('${ids.own}',CURRENT_DATE-31,10000,10000),('${ids.own}',CURRENT_DATE-1,13000,13000),
    ('${ids.shared}',CURRENT_DATE-31,0,0),('${ids.shared}',CURRENT_DATE-1,0,0);`);
  await page.goto("/?horizon=30");
  await assertMetric("Saving from income", "A$4,000");
  await assertMetric("Loan principal", "A$35,000");
  await assertMetric("Explained cash flow", "A$3,000");
  await assertMetric("Recorded cash balance change", "A$3,000");
  await assertMetric("Unreconciled difference", "A$0");
  await expect(summary().getByRole("status")).toContainText("agree");
  await expect(page.getByText("Calculated net outflow", { exact: true })).toHaveCount(0);
  const preserved = psql(`SELECT amount || ':' || category_id::text FROM transactions WHERE id='${ids.principal}';`).trim();
  expect(preserved).toBe(`-70000.00:${ids.housing}`);
  await page.screenshot({ path: testInfo.outputPath("ownership-contributions.png"), fullPage: true });
  // General portions: principal and interest, rather than a special principal remainder.
  await page.goto(`/transactions?search=Mortgage%20payment%20for%20purpose%20review&horizon=30`);
  await page.getByText("Mortgage payment for purpose review", { exact: true }).first().click();
  await page.getByLabel("Cash-flow purpose").selectOption("split");
  await page.getByLabel("Portion 1 amount (AUD)").fill("60000");
  await page.getByLabel("Portion 2 amount (AUD)").fill("10000");
  await page.getByRole("button", { name: "Save cash-flow purpose" }).click();
  await expect.poll(() => psql(`SELECT jsonb_array_length(cash_flow_parts) FROM transactions WHERE id='${ids.principal}';`).trim()).toBe("2");
  await page.goto("/?horizon=30");
  await assertMetric("Saving from income", "-A$1,000");
  await assertMetric("Loan principal", "A$30,000");
  await assertMetric("Explained cash flow", "A$3,000");
  // A missing transfer explanation remains a difference, never becomes earned income.
  psql(`INSERT INTO transactions(user_id,account_id,amount,functional_amount,currency,description,booked_at,category_id)
    VALUES (${o},'${ids.own}',500,500,'AUD','Unmatched transfer',CURRENT_DATE-1,'${ids.transfer}');
    UPDATE account_balances SET balance_in_account_currency=13500,balance_in_functional_currency=13500 WHERE account_id='${ids.own}' AND date::date=CURRENT_DATE-1;`);
  await page.reload();
  await assertMetric("Recorded cash balance change", "A$3,500");
  await assertMetric("Unreconciled difference", "A$500");
  await expect(summary().getByRole("status")).toContainText("not fully reconciled");
  expect(errors).toEqual([]);
  await partnerContext.close();
});
