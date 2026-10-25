import { expect, test } from "@playwright/test";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
const container = process.env.HOUSEHOLD_UAT_DB_CONTAINER;
test.skip(!container, "Requires an explicitly selected isolated release-lab database");
const quote = (s: string) => `'${s.replaceAll("'", "''")}'`;
test("named member Sankey retains salary and filter navigation gives immediate feedback", async ({ page, browser, baseURL }) => {
  expect(["localhost", "127.0.0.1"]).toContain(new URL(baseURL!).hostname);
  const project = execFileSync("docker", ["inspect", container!, "--format", '{{index .Config.Labels "com.docker.compose.project"}}'], { encoding: "utf8" }).trim();
  expect(project).toMatch(/^syllogic-release-lab-/);
  const sql = (input: string) => execFileSync("docker", ["exec", "-i", container!, "psql", "-U", "financeuser", "-d", "finance_db", "-qAt", "-v", "ON_ERROR_STOP=1"], { input, encoding: "utf8" });
  const password = `Synthetic!${randomUUID()}`;
  const ownerContext = await browser.newContext();
  try {
    const ownerResponse = await ownerContext.request.post(`${baseURL}/api/auth/sign-up/email`, { headers: { Origin: baseURL! }, data: { name: "Owner Fixture", email: `owner-${randomUUID()}@example.test`, password } });
    expect(ownerResponse.ok()).toBeTruthy();
    const ownerId = (await ownerResponse.json()).user.id;
    const memberResponse = await page.request.post("/api/auth/sign-up/email", { headers: { Origin: baseURL! }, data: { name: "Jessica Fixture", email: `member-${randomUUID()}@example.test`, password } });
    expect(memberResponse.ok()).toBeTruthy();
    const memberId = (await memberResponse.json()).user.id;
    const [linked, self, ownerSelf, personal, shared, salary, spending] = Array.from({ length: 7 }, () => randomUUID());
    sql(`BEGIN;
      UPDATE users SET onboarding_status='completed',functional_currency='AUD' WHERE id IN (${quote(ownerId)},${quote(memberId)});
      INSERT INTO people(id,user_id,name,kind) VALUES ('${linked}',${quote(ownerId)},'Jessica Fixture','member'),('${self}',${quote(memberId)},'Jessica Self','self'),('${ownerSelf}',${quote(ownerId)},'Owner Fixture','self');
      INSERT INTO household_memberships(member_user_id,owner_user_id,person_id) VALUES (${quote(memberId)},${quote(ownerId)},'${linked}');
      INSERT INTO accounts(id,user_id,name,account_type,currency,provider) VALUES ('${personal}',${quote(memberId)},'Personal','checking','AUD','manual'),('${shared}',${quote(ownerId)},'Shared','checking','AUD','manual');
      INSERT INTO household_account_shares(account_id,member_user_id,granted_by_user_id) VALUES ('${shared}',${quote(memberId)},${quote(ownerId)});
      INSERT INTO account_owners(account_id,person_id,share) VALUES ('${personal}','${self}',1),('${shared}','${linked}',0.5),('${shared}','${ownerSelf}',0.5);
      INSERT INTO categories(id,user_id,name,category_type) VALUES ('${salary}',${quote(memberId)},'Salary fixture','income'),('${spending}',${quote(ownerId)},'Spending fixture','expense');
      INSERT INTO transactions(user_id,account_id,amount,functional_amount,currency,category_id,booked_at) VALUES (${quote(memberId)},'${personal}',5000,5000,'AUD','${salary}','2026-10-01'),(${quote(ownerId)},'${shared}',-4000,-4000,'AUD','${spending}','2026-10-01');
      COMMIT;`);
    await page.addInitScript(({ userId }) => localStorage.setItem("personal-portfolio.walkthrough.completed", JSON.stringify({ state: { completedPages: ["home"], userId }, version: 0 })), { userId: memberId });
    await page.goto("/");
    const diagram = page.getByRole("region", { name: "Cash flow diagram" });
    await expect(diagram.getByText("Salary fixture", { exact: true })).toBeVisible();
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    await page.route(url => url.pathname === "/" && url.searchParams.get("person") === linked, async route => { await gate; await route.continue(); });
    await page.getByRole("button", { name: /Jessica Fixture/ }).click({ noWaitAfter: true, timeout: 10000 });
    try { await expect(page.getByRole("status")).toHaveText("Updating dashboard…"); }
    finally { release(); }
    await expect(page).toHaveURL(new RegExp(`person=${linked}`));
    await expect(page.getByRole("status")).toHaveCount(0);
    await expect(diagram.getByText("Salary fixture", { exact: true })).toBeVisible();
    await expect(diagram.getByText("Spending fixture", { exact: true })).toBeVisible();
    await page.getByRole("button", { name: "Whole accounts", exact: true }).click();
    await expect(page).toHaveURL(/person=all/);
    await expect(diagram.getByText("Salary fixture", { exact: true })).toBeVisible();
  } finally { await ownerContext.close(); }
});
