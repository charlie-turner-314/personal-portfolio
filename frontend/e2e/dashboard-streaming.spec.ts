import { expect, test } from "@playwright/test";
import { execFileSync, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
const container = process.env.HOUSEHOLD_UAT_DB_CONTAINER;
test.skip(!container, "Requires an explicitly selected isolated release-lab database");
const quote = (s: string) => `'${s.replaceAll("'", "''")}'`;

test("cash flow streams while net worth and portfolio queries are blocked", async ({ page, baseURL }) => {
  test.setTimeout(90_000);
  expect(["localhost", "127.0.0.1"]).toContain(new URL(baseURL!).hostname);
  expect(execFileSync("docker", ["inspect", container!, "--format", '{{index .Config.Labels "com.docker.compose.project"}}'], { encoding: "utf8" })).toMatch(/^syllogic-release-lab-/);
  const sql = (input: string) => execFileSync("docker", ["exec", "-i", container!, "psql", "-U", "financeuser", "-d", "finance_db", "-qAt", "-v", "ON_ERROR_STOP=1"], { input, encoding: "utf8" }).trim();
  let userId = "";
  for (let attempt = 0; attempt < 4; attempt++) {
    const response = await page.request.post("/api/auth/sign-up/email", { headers: { Origin: baseURL! }, data: { name: "Streaming Fixture", email: `streaming-${randomUUID()}@example.test`, password: `Synthetic!${randomUUID()}` } });
    if (response.status() === 429) { await new Promise(resolve => setTimeout(resolve, 10000)); continue; }
    expect(response.ok()).toBeTruthy(); userId = (await response.json()).user.id; break;
  }
  expect(userId).not.toBe("");
  const [account, category, investment] = [randomUUID(), randomUUID(), randomUUID()];
  sql(`BEGIN;
    UPDATE users SET onboarding_status='completed',functional_currency='AUD' WHERE id=${quote(userId)};
    INSERT INTO accounts(id,user_id,name,account_type,currency,provider,functional_balance) VALUES ('${account}',${quote(userId)},'Streaming Cash','checking','AUD','manual',100),('${investment}',${quote(userId)},'Streaming investments','investment_manual','AUD','manual',50);
    INSERT INTO categories(id,user_id,name,category_type) VALUES ('${category}',${quote(userId)},'Streaming salary','income');
    INSERT INTO transactions(user_id,account_id,amount,functional_amount,currency,category_id,booked_at) VALUES (${quote(userId)},'${account}',100,100,'AUD','${category}',CURRENT_DATE);
    COMMIT;`);
  await page.addInitScript(({ userId }) => localStorage.setItem("personal-portfolio.walkthrough.completed", JSON.stringify({ state: { completedPages: ["home"], userId }, version: 0 })), { userId });
  // These tables belong only to this isolated lab. Block the secondary queries
  // deterministically, rather than asserting against an arbitrary slow sleep.
  const lock = spawn("docker", ["exec", "-i", container!, "psql", "-U", "financeuser", "-d", "finance_db", "-qAt", "-v", "ON_ERROR_STOP=1"], { stdio: ["pipe", "pipe", "pipe"] });
  let output = "";
  let released = false;
  const closed = new Promise<void>((resolve, reject) => { lock.on("error", reject); lock.on("exit", code => code === 0 ? resolve() : reject(new Error(`Lock helper exited ${code}`))); });
  const ready = new Promise<void>((resolve, reject) => {
    lock.stdout.on("data", chunk => { output += chunk; if (output.includes("SECONDARY_QUERIES_LOCKED")) resolve(); });
    lock.stderr.on("data", chunk => { output += chunk; });
    lock.on("error", reject);
    lock.on("exit", () => { if (!output.includes("SECONDARY_QUERIES_LOCKED")) reject(new Error(output)); });
  });
  const release = () => { if (!released) { released = true; lock.stdin.end("ROLLBACK;\n\\q\n"); } };
  try {
    lock.stdin.write("BEGIN; LOCK TABLE household_net_worth_shares, holdings IN ACCESS EXCLUSIVE MODE; SELECT 'SECONDARY_QUERIES_LOCKED';\n");
    await ready;
    await page.goto("/", { waitUntil: "commit" });
    await expect(page.getByRole("region", { name: "Cash flow diagram" })).toBeVisible();
    await expect(page.getByText("Streaming salary", { exact: true })).toBeVisible();
    await expect(page.getByRole("status", { name: "Loading personal net worth" })).toBeVisible();
    await expect(page.getByRole("status", { name: "Loading assets overview" })).toBeVisible();
    await expect(page.getByRole("status", { name: "Loading liabilities" })).toBeVisible();
    release(); await closed;
    await expect(page.getByText("Personal net worth", { exact: true })).toBeVisible();
    await expect(page.getByRole("status", { name: "Loading assets overview" })).toHaveCount(0);
    await expect(page.getByRole("status", { name: "Loading liabilities" })).toHaveCount(0);
  } finally { release(); await closed; }
});
