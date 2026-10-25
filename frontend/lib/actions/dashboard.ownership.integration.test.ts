// @vitest-environment node
import { execFileSync } from "node:child_process";
import { describe, expect, it, vi } from "vitest";
const actor = vi.hoisted(() => ({ id: "member", householdPersonId: "linked" as string | undefined }));
const container = process.env.OWNERSHIP_TEST_POSTGRES_CONTAINER;
const fixture = `
BEGIN;
CREATE TEMP TABLE users(id text, functional_currency text);
CREATE TEMP TABLE accounts(consolidated_into_account_id text, id text, user_id text, is_active boolean);
CREATE TEMP TABLE household_memberships(member_user_id text, owner_user_id text, person_id text);
CREATE TEMP TABLE household_account_shares(account_id text, member_user_id text, granted_by_user_id text);
CREATE TEMP TABLE people(id text, user_id text, kind text, linked_user_id text);
CREATE TEMP TABLE account_owners(account_id text, person_id text, share numeric);
CREATE TEMP TABLE account_ownership_allocations(account_id text, person_id text, effective_from date, share numeric);
CREATE TEMP TABLE categories(id text, name text, category_type text, icon text, color text);
CREATE TEMP TABLE transaction_links(transaction_id text, group_id text, link_role text);
CREATE TEMP TABLE transactions(id text, account_id text, user_id text, booked_at timestamp,
 amount numeric, functional_amount numeric, currency text, category_id text, category_system_id text,
 include_in_analytics boolean, internal_transfer_id text);
INSERT INTO users VALUES ('member','AUD'),('owner','AUD');
INSERT INTO accounts(id,user_id,is_active) VALUES ('shared','owner',true),('savings','owner',true),('own','member',true),('private','owner',true);
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
 ('private','private','owner','2026-10-01',99999,99999,'AUD','income',NULL,true,NULL);
ALTER TABLE categories ADD COLUMN cash_flow_kind text;
UPDATE categories SET cash_flow_kind='investment' WHERE id='invest';
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
`;
vi.mock("@/lib/db", async () => {
  const { drizzle } = await import("drizzle-orm/pg-proxy");
  return { db: drizzle(async (query: string, params: unknown[]) => {
    const literal = query.replace(/\$(\d+)/g, (_, n) => {
      const value = params[Number(n) - 1];
      return value === null ? "NULL" : typeof value === "boolean" ? String(value) : `'${String(value).replaceAll("'", "''")}'`;
    });
    const wrapped = `SELECT COALESCE(json_agg(json_build_array(date, cash_flow_kind, allocation_fraction, transfer_group_id, transfer_amount, category_id, category_name, category_type, icon, color, amount)), '[]') FROM (${literal}) rows(date, cash_flow_kind, allocation_fraction, transfer_group_id, transfer_amount, category_id, category_name, category_type, icon, color, amount);`;
    const output = execFileSync("docker", ["exec", "-i", process.env.OWNERSHIP_TEST_POSTGRES_CONTAINER!, "psql", "-U", "postgres", "-d", "postgres", "-qAt", "-v", "ON_ERROR_STOP=1"], { input: fixture + wrapped + "ROLLBACK;", encoding: "utf8" });
    return { rows: JSON.parse(output.trim()) };
  }) };
});
vi.mock("@/lib/household/financial-auth", () => ({ getAuthenticatedSession: async () => ({ user: { id: actor.id }, householdPersonId: actor.householdPersonId }) }));
vi.mock("@/lib/data/cached", () => ({ getCachedUserAccounts: vi.fn() }));
vi.mock("@/lib/api/investments", () => ({ getPortfolio: vi.fn() }));
vi.mock("@/lib/actions/planned-expenses", () => ({ getUpcomingPlannedExpenses: vi.fn() }));
import { getSankeyData, getCashFlowSummary } from "./dashboard";
const start = new Date("2026-09-26T00:00:00Z");
const end = new Date("2026-10-25T23:59:59Z");
describe.skipIf(!container)("member dashboard attribution on isolated PostgreSQL", () => {
  it("reproduces the reported whole-account gap and fixes the default without hiding investments", async () => {
    const whole = await getSankeyData(start, end, undefined, "all");
    const personal = await getSankeyData(start, end);
    const selectedMember = await getSankeyData(start, end, undefined, "linked");
    expect(selectedMember).toEqual(personal);
    const total = (data: typeof whole, name: string) => data.nodes.find(node => node.name === name)?.total;
    expect(total(whole, "Cash required")).toBeCloseTo(5244.92, 2);
    expect(total(personal, "Cash required")).toBeCloseTo(1974.02, 2);
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
        transfersIn: 35000, transfersOut: 0, netReportedCashFlow: 4000,
      });
      const whole = await getCashFlowSummary(new Date("2026-07-01"), new Date("2026-07-31T23:59:59Z"), undefined, "all");
      expect(whole).toMatchObject({ loanPrincipal: 70000, transfersIn: 70000, netReportedCashFlow: 4000 });
      const filtered = await getCashFlowSummary(new Date("2026-07-01"), new Date("2026-07-31T23:59:59Z"), ["shared"]);
      expect(filtered).toMatchObject({ savingsFromIncome: 0, loanPrincipal: 35000, transfersIn: 35000, netReportedCashFlow: 0 });
      // July 12 principal does not depend on whether the July 9 deposit is in the window.
      const paymentOnly = await getCashFlowSummary(new Date("2026-07-12"), new Date("2026-07-13"));
      expect(paymentOnly).toMatchObject({ savingsFromIncome: 0, loanPrincipal: 35000, transfersIn: 0, netReportedCashFlow: -35000 });
    } finally { actor.id = "member"; actor.householdPersonId = "linked"; }
  });
  it("shows Jessica's contribution out of her share without counting it twice", async () => {
    const result = await getCashFlowSummary(new Date("2026-07-01"), new Date("2026-07-31T23:59:59Z"));
    expect(result).toMatchObject({ savingsFromIncome: 0, loanPrincipal: 35000, transfersOut: 35000, netReportedCashFlow: -70000 });
    const whole = await getCashFlowSummary(new Date("2026-07-01"), new Date("2026-07-31T23:59:59Z"), undefined, "all");
    expect(whole).toMatchObject({ loanPrincipal: 70000, transfersIn: 0, transfersOut: 0, netReportedCashFlow: -70000 });
  });

  it("applies the dated share and native allocation fraction before FX reporting", async () => {
    expect(await getCashFlowSummary(new Date("2026-08-15"), new Date("2026-08-15T23:59:59Z"))).toMatchObject({
      loanPrincipal: 150, savingsFromIncome: -100, netReportedCashFlow: -250,
    });
  });
  it("does not double-count a linked expense reimbursement as a contribution", async () => {
    actor.id = "owner"; actor.householdPersonId = undefined;
    try {
      expect(await getCashFlowSummary(new Date("2026-08-16"), new Date("2026-08-16T23:59:59Z"))).toMatchObject({
        savingsFromIncome: -85, transfersIn: 0, transfersOut: 0, netReportedCashFlow: -85,
      });
    } finally { actor.id = "member"; actor.householdPersonId = "linked"; }
  });

});
