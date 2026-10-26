// @vitest-environment node
import { execFileSync } from "node:child_process";
import { describe, expect, it, vi } from "vitest";
const actor = vi.hoisted(() => ({ id: "member", householdPersonId: "linked" as string | undefined }));
const container = process.env.OWNERSHIP_TEST_POSTGRES_CONTAINER;
const variant=vi.hoisted(()=>({sql:""}));
const fixture = `
BEGIN;
CREATE TEMP TABLE users(id text, functional_currency text);
CREATE TEMP TABLE exchange_rates(base_currency text,target_currency text,rate numeric,date date);
CREATE TEMP TABLE accounts(consolidated_into_account_id text, id text, user_id text, is_active boolean,name text,institution text,account_type text,currency text);
CREATE TEMP TABLE household_memberships(member_user_id text, owner_user_id text, person_id text);
CREATE TEMP TABLE household_account_shares(account_id text, member_user_id text, granted_by_user_id text);
CREATE TEMP TABLE people(id text, user_id text, kind text, linked_user_id text);
CREATE TEMP TABLE account_owners(account_id text, person_id text, share numeric);
CREATE TEMP TABLE account_ownership_allocations(account_id text, person_id text, effective_from date, share numeric);
CREATE TEMP TABLE recurring_transactions(id text,user_id text,name text);
CREATE TEMP TABLE internal_transfers(id text,mirror_txn_id text);
CREATE TEMP TABLE categories(id text, name text, category_type text, icon text, color text);
CREATE TEMP TABLE transaction_links(transaction_id text, group_id text, link_role text);
CREATE TEMP TABLE transactions(id text, account_id text, user_id text, booked_at timestamp,
 amount numeric, functional_amount numeric, currency text, category_id text, category_system_id text,
 include_in_analytics boolean, internal_transfer_id text);
INSERT INTO users VALUES ('member','AUD'),('owner','AUD');
INSERT INTO accounts(id,user_id,is_active) VALUES ('shared','owner',true),('savings','owner',true),('own','member',true),('private','owner',true);
UPDATE accounts SET name=id,account_type='checking',currency='AUD';
INSERT INTO household_memberships VALUES ('member','owner','linked');
INSERT INTO household_account_shares VALUES ('shared','member','owner'),('savings','member','owner');
INSERT INTO people(id,user_id,kind) VALUES ('linked','owner','member'),('owner-self','owner','self'),('own-self','member','self');
INSERT INTO account_ownership_allocations VALUES ('shared','linked','2026-01-01',0.5),('shared','owner-self','2026-01-01',0.5);
INSERT INTO account_owners VALUES ('savings','linked',NULL),('savings','owner-self',NULL);
INSERT INTO categories VALUES ('spend','Spending','expense',NULL,NULL),('invest','Investments','expense',NULL,NULL),('income','Income','income',NULL,NULL),('transfer','Transfer','transfer',NULL,NULL);
INSERT INTO transactions VALUES
 ('shared-spend','shared','owner','2026-10-01',-6551.16,-6551.16,'AUD','spend',NULL,true,NULL),
 ('own-spend','own','member','2026-10-01',-1061.65,-1061.65,'AUD','spend',NULL,true,NULL),
 ('investment','own','member','2026-10-01',-2794.90,-2794.90,'AUD','invest',NULL,true,NULL),
 ('salary','own','member','2026-10-01',5153.43,5153.43,'AUD','income',NULL,true,NULL),
 ('interest','savings','owner','2026-10-01',9.36,9.36,'AUD','income',NULL,true,NULL),
 ('internal','shared','owner','2026-10-01',462,462,'AUD','income',NULL,true,'internal'),
 ('private','private','owner','2026-10-01',99999,99999,'AUD','income',NULL,true,NULL),
 ('internal-mirror','savings','owner','2026-10-01',-462,-462,'AUD','transfer',NULL,false,NULL);
INSERT INTO internal_transfers VALUES ('internal','internal-mirror');
ALTER TABLE transactions ADD COLUMN external_id text;
UPDATE transactions SET external_id='mirror-internal' WHERE id='internal-mirror';
ALTER TABLE transactions ADD COLUMN merchant text;
ALTER TABLE transactions ADD COLUMN description text;
ALTER TABLE transactions ADD COLUMN recurring_transaction_id text;
ALTER TABLE categories ADD COLUMN cash_flow_kind text;
UPDATE categories SET cash_flow_kind='investment' WHERE id='invest';
ALTER TABLE transactions ADD COLUMN cash_flow_parts jsonb;
ALTER TABLE transactions ADD COLUMN cash_flow_kind text;
ALTER TABLE transactions ADD COLUMN cash_flow_allocation_amount numeric;
INSERT INTO transactions(id,account_id,user_id,booked_at,amount,functional_amount,currency,category_id,include_in_analytics,cash_flow_kind) VALUES
 ('partner-out','own','member','2026-07-09',-70000,-70000,'AUD','transfer',true,NULL),
 ('shared-in','shared','owner','2026-07-09',70000,70000,'AUD','transfer',true,NULL),
 ('principal','shared','owner','2026-07-12',-70000,-70000,'AUD','spend',true,'loan_principal'),
 ('owner-income','private','owner','2026-07-01',6000,6000,'AUD','income',true,NULL),
 ('owner-spend','private','owner','2026-07-02',-2000,-2000,'AUD','spend',true,NULL);
INSERT INTO transaction_links VALUES ('partner-out','contribution','primary'),('shared-in','contribution','reimbursement');
INSERT INTO account_ownership_allocations VALUES
 ('shared','linked','2026-08-01',0.25),('shared','owner-self','2026-08-01',0.75),
 ('shared','linked','2026-09-01',0.5),('shared','owner-self','2026-09-01',0.5);
INSERT INTO transactions(id,account_id,user_id,booked_at,amount,functional_amount,currency,category_id,include_in_analytics,cash_flow_kind,cash_flow_allocation_amount) VALUES
 ('fx-principal','shared','owner','2026-08-15',-2000,-1000,'USD','spend',true,'loan_principal',1200),
 ('reimbursable','private','owner','2026-08-16',-100,-100,'AUD','spend',true,NULL,NULL),
 ('reimbursement','shared','owner','2026-08-16',20,20,'AUD','transfer',true,NULL,NULL);
INSERT INTO transaction_links VALUES ('reimbursable','refund','primary'),('reimbursement','refund','reimbursement');
INSERT INTO transactions(id,account_id,user_id,booked_at,amount,functional_amount,currency,category_id,include_in_analytics,cash_flow_kind) VALUES
 ('capital-primary','own','member','2026-08-17',-100,-100,'AUD','invest',true,'investment'),
 ('ordinary-secondary','own','member','2026-08-17',-20,-20,'AUD','spend',true,NULL),
 ('ordinary-primary','own','member','2026-08-18',-100,-100,'AUD','spend',true,NULL),
 ('capital-secondary','own','member','2026-08-18',-20,-20,'AUD','invest',true,'investment');
INSERT INTO transaction_links VALUES
 ('capital-primary','mixed-primary','primary'),('ordinary-secondary','mixed-primary','expense'),
 ('ordinary-primary','mixed-secondary','primary'),('capital-secondary','mixed-secondary','expense');
UPDATE transactions SET cash_flow_parts='[{"kind":"capital","detail":"loan_principal","amount":1200},{"kind":"consumption","amount":800}]'::jsonb WHERE id='fx-principal';

`;
vi.mock("@/lib/db", async () => {
  const { drizzle } = await import("drizzle-orm/pg-proxy");
  return { db: drizzle(async (query: string, params: unknown[]) => {
    const literal = query.replace(/\$(\d+)/g, (_, n) => {
      const value = params[Number(n) - 1];
      return value === null ? "NULL" : typeof value === "boolean" ? String(value) : `'${String(value).replaceAll("'", "''")}'`;
    });
    const fields=query.includes('"financial_records"')?"date, cash_flow_kind, cash_flow_parts, native_amount, transfer_group_id, transfer_amount, category_id, category_name, category_type, icon, color, amount, transfer_full_amount, transaction_id, account_id, merchant, description, recurring_name, recurrence_known":"id, name, institution, account_type, currency, is_active";
    const wrapped = `SELECT COALESCE(json_agg(json_build_array(${fields})), '[]') FROM (${literal}) rows(${fields});`;
    const output = execFileSync("docker", ["exec", "-i", process.env.OWNERSHIP_TEST_POSTGRES_CONTAINER!, "psql", "-U", "postgres", "-d", "postgres", "-qAt", "-v", "ON_ERROR_STOP=1"], { input: fixture + variant.sql + wrapped + "ROLLBACK;", encoding: "utf8" });
    return { rows: JSON.parse(output.trim()) };
  }) };
});
vi.mock("@/lib/household/financial-auth", () => ({ getAuthenticatedSession: async () => ({ user: { id: actor.id }, householdPersonId: actor.householdPersonId }) }));
vi.mock("@/lib/data/cached", () => ({ getCachedUserAccounts: vi.fn() }));
vi.mock("@/lib/api/investments", () => ({ getPortfolio: vi.fn() }));
vi.mock("@/lib/actions/planned-expenses", () => ({ getUpcomingPlannedExpenses: vi.fn() }));
import { getSankeyData, getCashFlowSummary } from "./dashboard";
import { fetchFinancialActivity, fetchFinancialActivityRows } from "@/lib/reporting/activity-query";
import { fetchCategoryActualAmounts } from "@/lib/spending/category-actuals";
const start = new Date("2026-09-26T00:00:00Z");
const end = new Date("2026-10-25T23:59:59Z");
describe.skipIf(!container)("member dashboard attribution on isolated PostgreSQL", () => {
  it("reproduces the reported whole-account gap and fixes the default without hiding investments", async () => {
    const whole = await getSankeyData(start, end, undefined, "all");
    const personal = await getSankeyData(start, end);
    const selectedMember = await getSankeyData(start, end, undefined, "linked");
    expect(selectedMember).toEqual(personal);
    const total = (data: typeof whole, name: string) => data.nodes.find(node => node.name === name)?.total;
    expect(total(whole, "Calculated net outflow")).toBeCloseTo(5244.92, 2);
    expect(total(personal, "Calculated net outflow")).toBeCloseTo(1974.02, 2);
    expect(total(personal, "Income")).toBeCloseTo(5158.11, 2);
    expect(total(personal, "Spending")).toBeCloseTo(4337.23, 2);
    expect(total(personal, "Investments")).toBeCloseTo(2794.90, 2);
    expect(total(whole, "Investments")).toBeCloseTo(2794.90, 2);
  });
  it("reconciles a partner contribution without reading their private source or inventing income", async () => {
    actor.id = "owner"; actor.householdPersonId = undefined;
    try {
      const result = await getCashFlowSummary(new Date("2026-07-01"), new Date("2026-07-31T23:59:59Z"));
      expect(result).toMatchObject({
        savingsFromIncome: 4000, loanPrincipal: 35000, investments: 0,
        transfersIn: 35000, transfersOut: 0, explainedCashFlow: 4000,
      });
      const whole = await getCashFlowSummary(new Date("2026-07-01"), new Date("2026-07-31T23:59:59Z"), undefined, "all");
      expect(whole).toMatchObject({ loanPrincipal: 70000, transfersIn: 70000, explainedCashFlow: 4000 });
      const filtered = await getCashFlowSummary(new Date("2026-07-01"), new Date("2026-07-31T23:59:59Z"), ["shared"]);
      expect(filtered).toMatchObject({ savingsFromIncome: 0, loanPrincipal: 35000, transfersIn: 35000, explainedCashFlow: 0 });
      // July 12 principal does not depend on whether the July 9 deposit is in the window.
      const paymentOnly = await getCashFlowSummary(new Date("2026-07-12"), new Date("2026-07-13"));
      expect(paymentOnly).toMatchObject({ savingsFromIncome: 0, loanPrincipal: 35000, transfersIn: 0, explainedCashFlow: -35000 });
    } finally { actor.id = "member"; actor.householdPersonId = "linked"; }
  }, 20_000);
  it("shows Jessica's contribution out of her share without counting it twice", async () => {
    const result = await getCashFlowSummary(new Date("2026-07-01"), new Date("2026-07-31T23:59:59Z"));
    expect(result).toMatchObject({ savingsFromIncome: 0, loanPrincipal: 35000, transfersOut: 35000, explainedCashFlow: -70000 });
    const whole = await getCashFlowSummary(new Date("2026-07-01"), new Date("2026-07-31T23:59:59Z"), undefined, "all");
    expect(whole).toMatchObject({ loanPrincipal: 70000, transfersIn: 0, transfersOut: 0, explainedCashFlow: -70000 });
  });

  it("applies the dated share and native allocation fraction before FX reporting", async () => {
    expect(await getCashFlowSummary(new Date("2026-08-15"), new Date("2026-08-15T23:59:59Z"))).toMatchObject({
      loanPrincipal: 150, savingsFromIncome: -100, explainedCashFlow: -250,
    });
  });
  it("does not double-count a linked expense reimbursement as a contribution", async () => {
    actor.id = "owner"; actor.householdPersonId = undefined;
    try {
      expect(await getCashFlowSummary(new Date("2026-08-16"), new Date("2026-08-16T23:59:59Z"))).toMatchObject({
        savingsFromIncome: -85, transfersIn: 0, transfersOut: 0, explainedCashFlow: -85,
      });
    } finally { actor.id = "member"; actor.householdPersonId = "linked"; }
  });

  it.each([
    ["2026-08-17", -20, 100], ["2026-08-18", -100, 20],
  ])("reports each purpose once in mixed linked groups on %s", async (day, saving, investment) => {
    expect(await getCashFlowSummary(new Date(day), new Date(day + "T23:59:59Z"))).toMatchObject({
      savingsFromIncome: saving, investments: investment, explainedCashFlow: -120,
    });
  });

  it("uses the same dated, permitted facts for category plans and dashboard consumption/capital",async()=>{
    const boundary={startDate:new Date("2026-08-15"),endDate:new Date("2026-08-15T23:59:59Z")};
    const activity=await fetchFinancialActivity("member",boundary);
    const actuals=await fetchCategoryActualAmounts("member",boundary);
    expect(activity).toMatchObject({expenses:100,loanPrincipal:150});
    expect(actuals).toEqual([expect.objectContaining({id:"spend",amount:250,consumptionAmount:100,capitalAmount:150})]);
    const household=await fetchCategoryActualAmounts("member",{...boundary,personId:"all"});
    expect(household).toEqual([expect.objectContaining({id:"spend",amount:1000,consumptionAmount:400,capitalAmount:600})]);
  });
  it("does not use a linked primary outside the selected account or reporting date",async()=>{
    variant.sql=`INSERT INTO transactions(id,account_id,user_id,booked_at,amount,functional_amount,currency,category_id,include_in_analytics) VALUES
      ('dated-primary','own','member','2026-11-01',-100,-100,'AUD','spend',true),
      ('dated-secondary','shared','owner','2026-11-02',-20,-20,'AUD','spend',true);
      INSERT INTO transaction_links VALUES ('dated-primary','dated-group','primary'),('dated-secondary','dated-group','expense');`;
    try {
      const full={startDate:new Date("2026-11-01"),endDate:new Date("2026-11-02T23:59:59Z")};
      expect(await fetchFinancialActivity("member",full)).toMatchObject({expenses:110});
      expect(await fetchFinancialActivity("member",{...full,accountIds:["shared"]})).toMatchObject({expenses:10});
      expect(await fetchFinancialActivity("member",{...full,startDate:new Date("2026-11-02")})).toMatchObject({expenses:10});
      expect(await fetchCategoryActualAmounts("member",{...full,accountIds:["shared"]})).toEqual([expect.objectContaining({amount:10})]);
    }finally {variant.sql="";}
  });
  it("treats date-straddling and selected-account transfer legs as boundary movements",async()=>{
    variant.sql=`UPDATE transactions SET booked_at='2026-07-08' WHERE id='partner-out';`;
    try {
      const full={startDate:new Date("2026-07-08"),endDate:new Date("2026-07-09T23:59:59Z")};
      expect(await fetchFinancialActivity("member",full)).toMatchObject({ownershipTransfersOut:35000,boundaryTransfersIn:0,boundaryTransfersOut:0});
      expect(await fetchFinancialActivity("member",{...full,startDate:new Date("2026-07-09")})).toMatchObject({boundaryTransfersIn:35000,ownershipTransfersOut:0});
      expect(await fetchFinancialActivity("member",{...full,accountIds:["own"]})).toMatchObject({boundaryTransfersOut:70000,ownershipTransfersOut:0});
      expect(await fetchFinancialActivity("member",{...full,personId:"all"})).toMatchObject({transfersIn:0,transfersOut:0});
    }finally {variant.sql="";}
  });
  it.each([[12000,0.3],[918.24,0.8]])("generalizes contribution %s with member ownership %s",async(amount,share)=>{
    variant.sql=`UPDATE transactions SET amount=sign(amount)*${amount},functional_amount=sign(amount)*${amount} WHERE id IN ('partner-out','shared-in','principal');
      UPDATE account_ownership_allocations SET share=CASE WHEN person_id='linked' THEN ${share} ELSE ${1-share} END WHERE effective_from='2026-01-01';`;
    try {
      const boundary={startDate:new Date("2026-07-01"),endDate:new Date("2026-07-31T23:59:59Z")};
      const jessica=await fetchFinancialActivity("member",boundary);
      expect(jessica.loanPrincipal).toBeCloseTo(amount*share);
      expect(jessica.ownershipTransfersOut).toBeCloseTo(amount*(1-share));
      expect(jessica.income).toBe(0);expect(jessica.expenses).toBe(0);
      const charlie=await fetchFinancialActivity("owner",{...boundary,accountIds:["shared"]});
      expect(charlie.loanPrincipal).toBeCloseTo(amount*(1-share));
      expect(charlie.boundaryTransfersIn).toBeCloseTo(amount*(1-share));
      expect(charlie.income).toBe(0);expect(charlie.expenses).toBe(0);
    }finally {variant.sql="";}
  });
  it("revokes activity and plan actuals immediately and strips generated private counterpart descriptions",async()=>{
    const boundary={startDate:start,endDate:end};
    variant.sql=`UPDATE transactions SET merchant='Private bank name',description='Transfer from private source' WHERE id='internal-mirror';`;
    try {
      const rows=await fetchFinancialActivityRows("member",boundary);
      expect(rows.find(row=>row.transactionId==="internal-mirror")).toMatchObject({merchant:null,description:"Transfer"});
      expect(JSON.stringify(rows)).not.toContain("Private bank name");
      expect(JSON.stringify(rows)).not.toContain("Transfer from private source");
      variant.sql="DELETE FROM household_account_shares WHERE member_user_id='member';";
      expect(await fetchFinancialActivity("member",boundary)).toMatchObject({expenses:1061.65,investments:2794.9,income:5153.43});
      expect(await fetchCategoryActualAmounts("member",boundary)).toEqual(expect.arrayContaining([expect.objectContaining({id:"spend",amount:1061.65})]));
    }finally {variant.sql="";}
  });
  it("marks missing conversions unavailable in plans instead of inventing zero",async()=>{
    variant.sql=`UPDATE transactions SET currency='EUR',functional_amount=NULL WHERE id='fx-principal';`;
    try {
      const boundary={startDate:new Date("2026-08-15"),endDate:new Date("2026-08-15T23:59:59Z")};
      expect(await fetchFinancialActivity("member",boundary)).toMatchObject({missingConversions:1});
      expect(await fetchCategoryActualAmounts("member",boundary)).toEqual([expect.objectContaining({id:"spend",amount:null,consumptionAmount:null,capitalAmount:null})]);
    }finally {variant.sql="";}
  });

  it("uses one purpose boundary for automatic source/mirror legs without double-counting principal",async()=>{
    variant.sql=`UPDATE transactions SET booked_at='2026-11-15',amount=-1000,functional_amount=-1000,category_id='spend',include_in_analytics=false,
      cash_flow_parts='[{"kind":"capital","detail":"loan_principal","amount":600},{"kind":"consumption","amount":400}]'::jsonb WHERE id='internal';
      UPDATE transactions SET booked_at='2026-11-16',amount=1000,functional_amount=1000 WHERE id='internal-mirror';`;
    try {
      const boundary={startDate:new Date("2026-11-15"),endDate:new Date("2026-11-16T23:59:59Z")};
      expect(await getCashFlowSummary(boundary.startDate,boundary.endDate)).toMatchObject({savingsFromIncome:-200,loanPrincipal:300,transfersIn:0,transfersOut:0,explainedCashFlow:-500});
      expect(await getCashFlowSummary(boundary.startDate,boundary.endDate,["shared"])).toMatchObject({loanPrincipal:300,transfersIn:0,explainedCashFlow:-500});
      expect(await getCashFlowSummary(boundary.startDate,boundary.endDate,["savings"])).toMatchObject({loanPrincipal:0,boundaryTransfersIn:500,explainedCashFlow:500});
      expect(await getCashFlowSummary(new Date("2026-11-16"),boundary.endDate)).toMatchObject({loanPrincipal:0,boundaryTransfersIn:500});
      expect(await fetchCategoryActualAmounts("member",boundary)).toEqual([expect.objectContaining({id:"spend",amount:500,consumptionAmount:200,capitalAmount:300})]);
      variant.sql+="DELETE FROM household_account_shares WHERE account_id='shared';";
      expect(await getCashFlowSummary(boundary.startDate,boundary.endDate)).toMatchObject({loanPrincipal:0,boundaryTransfersIn:500});
    }finally {variant.sql="";}
  });

});
