import { expect, test } from "@playwright/test";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
const container = process.env.HOUSEHOLD_UAT_DB_CONTAINER;
test.skip(!container, "Requires an explicitly selected isolated release-lab database");
const quote = (s: string) => `'${s.replaceAll("'", "''")}'`;
test("old joint imports require review and consolidate to one shared balance with private archives", async ({ page, baseURL }) => {
  test.setTimeout(120_000);
  expect(["localhost", "127.0.0.1"]).toContain(new URL(baseURL!).hostname);
  expect(execFileSync("docker", ["inspect", container!, "--format", '{{index .Config.Labels "com.docker.compose.project"}}'], { encoding: "utf8" })).toMatch(/syllogic-release-lab-/);
  const sql = (input: string) => execFileSync("docker", ["exec", "-i", container!, "psql", "-U", "financeuser", "-d", "finance_db", "-qAt", "-v", "ON_ERROR_STOP=1"], { input, encoding: "utf8" }).trim();
  let memberId = "";
  for (let attempt = 0; attempt < 4; attempt++) {
    const response = await page.request.post("/api/auth/sign-up/email", { headers: { Origin: baseURL! }, data: { name: "Up Partner", email: `up-joint-${randomUUID()}@example.test`, password: `Synthetic!${randomUUID()}` } });
    if (response.status() === 429) { await new Promise(resolve => setTimeout(resolve, 10000)); continue; }
    expect(response.ok()).toBeTruthy(); memberId = (await response.json()).user.id; break;
  }
  expect(memberId).not.toBe("");
  const [ownerId, person, canonical, original, connection, ownerConnection] = Array.from({ length: 6 }, () => randomUUID());
  sql(`BEGIN;
    INSERT INTO users(id,email,functional_currency,onboarding_status) VALUES ('${ownerId}','up-owner-${ownerId}@example.test','AUD','completed');
    UPDATE users SET onboarding_status='completed',functional_currency='AUD' WHERE id=${quote(memberId)};
    INSERT INTO people(id,user_id,name,kind) VALUES ('${person}','${ownerId}','Up Partner','member');
    INSERT INTO household_memberships(member_user_id,owner_user_id,person_id) VALUES (${quote(memberId)},'${ownerId}','${person}');
    INSERT INTO bank_connections(id,user_id,provider,session_id,aspsp_name,aspsp_country,status) VALUES ('${connection}',${quote(memberId)},'up','${connection}','Up','AU','active'),('${ownerConnection}','${ownerId}','up','${ownerConnection}','Up','AU','active');
    INSERT INTO accounts(id,user_id,name,account_type,currency,provider,external_id,bank_connection_id,balance_available,functional_balance,balance_is_anchored) VALUES ('${canonical}','${ownerId}','Shared Up Fixture','checking','AUD','up','same-provider-id-${canonical}','${ownerConnection}',100,100,true),('${original}',${quote(memberId)},'Old Up Fixture','checking','AUD','up','same-provider-id-${canonical}','${connection}',100,100,true);
    INSERT INTO household_account_shares(account_id,member_user_id,granted_by_user_id) VALUES ('${canonical}',${quote(memberId)},'${ownerId}');
    INSERT INTO up_account_sources(connection_id,account_id) VALUES ('${connection}','${original}'),('${ownerConnection}','${canonical}');
    INSERT INTO transactions(user_id,account_id,external_id,amount,currency,booked_at,description,transaction_type) VALUES ('${ownerId}','${canonical}','same',-10,'AUD','2026-10-01','Shared original','debit'),(${quote(memberId)},'${original}','same',-10,'AUD','2026-10-01','My manual edit','debit'),(${quote(memberId)},'${original}','unique',-20,'AUD','2026-10-02','Unique history','debit');
    COMMIT;`);
  await page.addInitScript(({ userId }) => localStorage.setItem("personal-portfolio.walkthrough.completed", JSON.stringify({ state: { completedPages: ["home", "settings", "assets"], userId }, version: 0 })), { userId: memberId });
  await page.goto("/settings");
  await page.getByRole("button", { name: "Review joint Up accounts" }).click();
  await expect(page.getByText("Shared Up Fixture (AUD)", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Preview consolidation" }).click();
  const consolidate = page.getByRole("button", { name: "Consolidate reviewed imports" });
  await expect(consolidate).toBeDisabled();
  await page.getByLabel("Details to retain").selectOption("keep_mine");
  await consolidate.click();
  await expect(page.getByText(/Consolidated 1 accounts/)).toBeVisible();
  await expect(page.getByRole("button", { name: /Download my original history/ })).toBeVisible();
  expect(sql(`SELECT count(*) FROM transactions WHERE account_id='${canonical}'`)).toBe("2");
  expect(sql(`SELECT description FROM transactions WHERE account_id='${canonical}' AND external_id='same'`)).toBe("My manual edit");
  expect(sql(`SELECT consolidated_into_account_id FROM accounts WHERE id='${original}'`)).toBe(canonical);
  expect(sql(`SELECT starting_balance FROM accounts WHERE id='${canonical}'`)).toBe("130.00");
  expect(sql(`SELECT count(*) FROM up_account_sources WHERE account_id='${canonical}'`)).toBe("2");
});
