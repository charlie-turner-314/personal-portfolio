import { expect, test } from "@playwright/test";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
const container = process.env.HOUSEHOLD_UAT_DB_CONTAINER;
test.skip(!container, "Requires an explicitly selected isolated release-lab database");
const quote = (s: string) => `'${s.replaceAll("'", "''")}'`;
test("property consent shares detail and edits, mortgage consent stays separate, and revocation removes access", async ({ page: owner, browser, baseURL }) => {
  test.setTimeout(150_000);
  expect(["localhost", "127.0.0.1"]).toContain(new URL(baseURL!).hostname);
  const project = execFileSync("docker", ["inspect", container!, "--format", '{{index .Config.Labels "com.docker.compose.project"}}'], { encoding: "utf8" }).trim();
  expect(project).toMatch(/^syllogic-release-lab-/);
  const sql = (input: string) => execFileSync("docker", ["exec", "-i", container!, "psql", "-U", "financeuser", "-d", "finance_db", "-qAt", "-v", "ON_ERROR_STOP=1"], { input, encoding: "utf8" }).trim();
  const memberContext = await browser.newContext();
  const member = await memberContext.newPage();
  try {
    const password = `Synthetic!${randomUUID()}`;
    async function signup(page: typeof owner, name: string) {
      for (let attempt = 0; attempt < 4; attempt++) {
        const response = await page.request.post(`${baseURL}/api/auth/sign-up/email`, { headers: { Origin: baseURL! }, data: { name, email: `property-${randomUUID()}@example.test`, password } });
        if (response.status() === 429) { await new Promise(resolve => setTimeout(resolve, 10000)); continue; }
        expect(response.ok()).toBeTruthy();
        return (await response.json()).user.id as string;
      }
      throw new Error("Synthetic signup rate limit did not reset");
    }
    const ownerId = await signup(owner, "Property Owner");
    const memberId = await signup(member, "Property Member");
    const [home, privateHome, linked, ownerSelf, memberSelf, mortgage, personal, privateCash] = Array.from({ length: 8 }, () => randomUUID());
    sql(`BEGIN;
      UPDATE users SET onboarding_status='completed',functional_currency='AUD' WHERE id IN (${quote(ownerId)},${quote(memberId)});
      INSERT INTO people(id,user_id,name,kind) VALUES ('${linked}',${quote(ownerId)},'Property Member','member'),('${ownerSelf}',${quote(ownerId)},'Property Owner','self'),('${memberSelf}',${quote(memberId)},'Member Self','self');
      INSERT INTO household_memberships(member_user_id,owner_user_id,person_id) VALUES (${quote(memberId)},${quote(ownerId)},'${linked}');
      INSERT INTO properties(id,user_id,name,property_type,current_value,currency,is_rental) VALUES ('${home}',${quote(ownerId)},'Joint Home Fixture','residential',750000,'AUD',true),('${privateHome}',${quote(ownerId)},'Private Home Fixture','residential',900000,'AUD',false);
      INSERT INTO property_owners(property_id,person_id,share) VALUES ('${home}','${linked}',0.5),('${home}','${ownerSelf}',0.5),('${privateHome}','${linked}',1);
      INSERT INTO property_valuations(user_id,property_id,valuation_date,value,currency,source) VALUES (${quote(ownerId)},'${home}','2026-01-01',750000,'AUD','original fixture');
      INSERT INTO accounts(id,user_id,name,account_type,currency,provider,functional_balance) VALUES ('${mortgage}',${quote(ownerId)},'Home Mortgage Fixture','mortgage','AUD','manual',520000),('${personal}',${quote(memberId)},'Member Cash','checking','AUD','manual',2000),('${privateCash}',${quote(ownerId)},'Private Cash','checking','AUD','manual',10000);
      INSERT INTO account_owners(account_id,person_id,share) VALUES ('${mortgage}','${linked}',0.5),('${mortgage}','${ownerSelf}',0.5);
      INSERT INTO property_liability_links(user_id,property_id,account_id) VALUES (${quote(ownerId)},'${home}','${mortgage}');
      INSERT INTO transactions(user_id,account_id,amount,functional_amount,currency,booked_at,property_id,description,transaction_type) VALUES (${quote(ownerId)},'${mortgage}',-100,-100,'AUD','2026-10-01','${home}','Visible property payment','debit'),(${quote(ownerId)},'${privateCash}',-9999,-9999,'AUD','2026-10-01','${home}','Private property payment','debit');
      COMMIT;`);
    for (const [page, userId] of [[owner, ownerId], [member, memberId]] as const) {
      await page.addInitScript(({ userId }) => localStorage.setItem("personal-portfolio.walkthrough.completed", JSON.stringify({ state: { completedPages: ["home", "settings", "assets"], userId }, version: 0 })), { userId });
    }
    await member.goto("/assets");
    await expect(member.getByText("Joint Home Fixture", { exact: true })).toHaveCount(0);
    expect((await member.request.get(`/api/owners/property/${home}`)).status()).toBe(404);
    await owner.goto("/settings?tab=household");
    await owner.getByRole("checkbox", { name: "Share property Joint Home Fixture with Property Member", exact: true }).check();
    await expect.poll(() => sql(`SELECT count(*) FROM household_property_shares WHERE property_id='${home}' AND member_user_id=${quote(memberId)}`)).toBe("1");
    await member.goto(`/assets/properties/${home}`);
    await expect(member.getByRole("heading", { name: "Joint Home Fixture", exact: true })).toBeVisible();
    await expect(member.getByText("original fixture", { exact: false })).toBeVisible();
    await expect(member.getByText("Home Mortgage Fixture", { exact: true })).toHaveCount(0);
    await expect(member.getByText("Private Home Fixture", { exact: true })).toHaveCount(0);
    const memberTotal = async () => (await (await member.request.get("/api/household/net-worth")).json()).totals.find((t: { isOwn: boolean }) => t.isOwn).total;
    expect(Number(await memberTotal())).toBe(377000);
    await owner.getByRole("checkbox", { name: "Share Home Mortgage Fixture with Property Member", exact: true }).check();
    await expect.poll(async () => (await member.request.get(`/api/accounts/${mortgage}`)).status()).toBe(200);
    await member.reload();
    await expect(member.getByText("Home Mortgage Fixture", { exact: true })).toBeVisible();
    await expect(member.getByText("Visible property payment", { exact: true })).toBeVisible();
    await expect(member.getByText("Private property payment", { exact: true })).toHaveCount(0);
    expect(Number(await memberTotal())).toBe(117000);
    const ownership = await member.request.get(`/api/owners/property/${home}`);
    expect(ownership.ok()).toBeTruthy();
    expect((await ownership.json()).owners).toHaveLength(2);
    expect((await member.request.put(`/api/owners/property/${home}`, { data: { owners: [{ personId: linked, share: 1 }] } })).status()).toBe(404);
    await member.goto("/assets");
    const propertyRow = member.getByTestId(`property-${home}`);
    await expect(propertyRow.getByText("Shared with you", { exact: true })).toBeVisible();
    await propertyRow.getByRole("button").last().click();
    await expect(member.getByRole("menuitem", { name: "Delete", exact: true })).toHaveCount(0);
    await member.getByRole("menuitem", { name: "Edit", exact: true }).click();
    await member.getByLabel("Property Name", { exact: true }).fill("Updated Joint Home");
    await member.getByLabel("Current Value", { exact: true }).fill("800000");
    await member.getByRole("button", { name: "Save Changes", exact: true }).click();
    await expect(member.getByRole("dialog")).toHaveCount(0);
    expect(sql(`SELECT user_id || ':' || current_value::integer FROM properties WHERE id='${home}'`)).toBe(`${ownerId}:800000`);
    expect(sql(`SELECT count(*) FROM property_valuations WHERE property_id='${home}' AND user_id <> ${quote(ownerId)}`)).toBe("0");
    expect(sql(`SELECT count(*) FROM property_valuations WHERE property_id='${home}' AND value=750000 AND source='original fixture'`)).toBe("1");
    expect(sql(`SELECT count(*) FROM property_owners WHERE property_id='${home}' AND share=0.5`)).toBe("2");
    expect(sql(`SELECT account_id FROM property_liability_links WHERE property_id='${home}'`)).toBe(mortgage);
    expect(Number(await memberTotal())).toBe(142000);
    await owner.reload();
    await owner.getByRole("checkbox", { name: "Share property Updated Joint Home with Property Member", exact: true }).uncheck();
    await expect.poll(async () => (await member.request.get(`/api/owners/property/${home}`)).status()).toBe(404);
    expect((await member.request.get(`/api/accounts/${mortgage}`)).status()).toBe(200);
    await member.goto(`/assets/properties/${home}`);
    await expect(member.getByRole("heading", { name: "Updated Joint Home", exact: true })).toHaveCount(0);
    await owner.getByRole("checkbox", { name: "Share property Updated Joint Home with Property Member", exact: true }).check();
    await expect.poll(async () => (await member.request.get(`/api/owners/property/${home}`)).status()).toBe(200);
    expect((await member.request.post("/api/household", { headers: { Origin: baseURL! }, data: { action: "leave" } })).ok()).toBeTruthy();
    expect(sql(`SELECT count(*) FROM household_property_shares WHERE member_user_id=${quote(memberId)}`)).toBe("0");
    sql(`INSERT INTO household_memberships(member_user_id,owner_user_id,person_id) VALUES (${quote(memberId)},${quote(ownerId)},'${linked}')`);
    expect((await member.request.get(`/api/owners/property/${home}`)).status()).toBe(404);
    expect((await member.request.get(`/api/accounts/${mortgage}`)).status()).toBe(404);
  } finally { await memberContext.close(); }
});
