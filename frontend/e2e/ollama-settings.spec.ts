import { test, expect } from "@playwright/test";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
const dbContainer = process.env.AI_UAT_DB_CONTAINER;
test.skip(!dbContainer || process.env.AI_UAT_OLLAMA !== "1", "Requires isolated lab with local Ollama");
const literal = (value: string) => `'${value.replaceAll("'", "''")}'`;

test("Ollama settings select a local model, categorise across batches, persist progress and disconnect", async ({ page, baseURL }, testInfo) => {
  test.setTimeout(240_000);
  expect(["localhost", "127.0.0.1"]).toContain(new URL(baseURL!).hostname);
  const project=execFileSync("docker",["inspect",dbContainer!,"--format",'{{index .Config.Labels "com.docker.compose.project"}}'],{encoding:"utf8"}).trim();
  expect(project).toMatch(/^syllogic-release-lab-/);
  const sql=(input: string)=>execFileSync("docker",["exec","-i",dbContainer!,"psql","-U","financeuser","-d","finance_db","-Atq","-v","ON_ERROR_STOP=1"],{input,encoding:"utf8"}).trim();
  const email=`ai-e2e-${randomUUID()}@example.test`;
  const signup=await page.request.post("/api/auth/sign-up/email",{headers:{Origin:baseURL!},data:{email,password:`Synthetic!${randomUUID()}`,name:"AI UAT"}});
  expect(signup.ok()).toBeTruthy();
  const {user}=await signup.json();const u=literal(user.id), account=randomUUID(), cat=randomUUID();
  sql(`BEGIN; UPDATE users SET onboarding_status='completed',onboarding_completed_at=now() WHERE id=${u} AND email=${literal(email)};
  INSERT INTO accounts(id,user_id,name,account_type,currency) VALUES ('${account}',${u},'AI fixture','checking','AUD');
  INSERT INTO categories(id,user_id,name,category_type) VALUES ('${cat}',${u},'Groceries','expense');
  INSERT INTO transactions(user_id,account_id,description,merchant,amount,currency,booked_at)
    SELECT ${u},'${account}','Woolworths groceries','WOOLWORTHS',-10,'AUD',now() FROM generate_series(1,11);COMMIT;`);
  await page.addInitScript((userId) => {
    localStorage.setItem("personal-portfolio.walkthrough.completed", JSON.stringify({ state: { completedPages: ["settings"], userId }, version: 0 }));
  }, user.id);
  await page.goto("/settings?tab=ai");
  const tour=page.getByRole("button",{name:"Close walkthrough"});if(await tour.isVisible())await tour.click();
  await expect(page.getByText("11 eligible uncategorised transactions")).toBeVisible();
  await page.getByLabel("AI provider").selectOption("ollama");
  await expect(page.getByRole("option",{name:"qwen3:8b",exact:true})).toBeAttached({timeout:15000});
  await page.getByLabel("Ollama model").selectOption("qwen3:8b");
  await page.getByRole("button",{name:"Test connection"}).click();
  await expect(page.getByText(/Connection successful/)).toBeVisible({timeout:135000});
  await page.getByRole("button",{name:"Save settings"}).click();
  await expect(page.getByText("AI settings saved.",{exact:true})).toBeVisible({timeout:135000});
  expect(sql(`SELECT provider='ollama' AND model='qwen3:8b' AND api_key_encrypted IS NULL FROM user_ai_settings WHERE user_id=${u};`)).toBe("t");
  await page.reload();
  await expect(page.getByLabel("AI provider")).toHaveValue("ollama");
  await expect(page.getByLabel("Ollama model")).toHaveValue("qwen3:8b");
  await page.getByRole("button",{name:"Categorise uncategorised transactions"}).click();
  await page.reload();
  await expect(page.getByText("Categorisation complete",{exact:true})).toBeVisible({timeout:180000});
  await expect(page.getByText(/11 of 11 processed · 11 categorised/)).toBeVisible();
  expect(sql(`SELECT count(*) FROM transactions WHERE user_id=${u} AND category_system_id='${cat}' AND category_id IS NULL;`)).toBe("11");
  await page.screenshot({path:testInfo.outputPath("ollama-settings.png"),fullPage:true});
  await page.getByRole("button",{name:"Disconnect AI"}).click();
  await expect(page.getByText(/AI disconnected/)).toBeVisible();
  expect(sql(`SELECT api_key_encrypted IS NULL AND model IS NULL AND automatic=false FROM user_ai_settings WHERE user_id=${u};`)).toBe("t");
});
