// @vitest-environment node
import { randomUUID } from "node:crypto";
import { afterAll,beforeAll,describe,expect,it,vi } from "vitest";
import { eq,inArray } from "drizzle-orm";
import * as schema from "@/lib/db/schema";
import { parseTransactionsSearchParams } from "@/lib/transactions/query-state";
const actor=vi.hoisted(()=>({id:""}));
vi.mock("@/lib/household/financial-auth",()=>({requireAuth:async()=>actor.id,getAuthenticatedSession:async()=>({user:{id:actor.id}})}));
vi.mock("@/lib/actions/account-logos",()=>({resolveMissingAccountLogos:async(rows:unknown[])=>rows}));
vi.mock("@/lib/actions/dashboard",()=>({getUserAccounts:async()=>[]}));
vi.mock("next/cache",()=>({revalidatePath:vi.fn()}));
const url=process.env.HOUSEHOLD_MODEL_TEST_DATABASE_URL;
let db:typeof import("@/lib/db").db;
let page:typeof import("./transactions").getTransactionsPage;
let exportRows:typeof import("./transactions").getTransactionsForExport;
let categoryData:typeof import("./category-spending").getCategorySpendingData;
let categoryPage:typeof import("./category-spending").getCategorySpendingTransactionsPage;
const suffix=randomUUID(),owner=`scope-owner-${suffix}`,member=`scope-member-${suffix}`,outsider=`scope-outside-${suffix}`;
const users=[owner,member,outsider];
const joint=randomUUID(),own=randomUUID(),privateAccount=randomUUID();
const memberPerson=randomUUID(),ownerPerson=randomUUID(),category=randomUUID();
const first=randomUUID(),second=randomUUID(),ownTx=randomUUID(),privateTx=randomUUID(),unknown=randomUUID();
const params=(extra:Record<string,string>={})=>parseTransactionsSearchParams({from:"2026-01-01",to:"2026-12-31",...extra});
beforeAll(async()=>{
  if(!url)return;
  if(process.env.HOUSEHOLD_TEST_ISOLATED!=="yes"||!new URL(url).pathname.includes("household_model_test"))throw new Error("Dedicated synthetic database required");
  process.env.DATABASE_URL=url;
  ({db}=await import("@/lib/db"));({getTransactionsPage:page,getTransactionsForExport:exportRows}=await import("./transactions"));
  await db.insert(schema.users).values(users.map((id,i)=>({id,email:`${i}-${suffix}@example.test`,name:id,functionalCurrency:i===1?"USD":"AUD"})));
  await db.insert(schema.people).values([{id:ownerPerson,userId:owner,name:"Owner",kind:"self"},{id:memberPerson,userId:owner,name:"Member",kind:"member",linkedUserId:member}]);
  await db.insert(schema.householdMemberships).values({memberUserId:member,ownerUserId:owner,personId:memberPerson});
  await db.insert(schema.accounts).values([{id:joint,userId:owner,name:"Joint",accountType:"checking",currency:"AUD"},{id:own,userId:member,name:"Own",accountType:"checking",currency:"USD"},{id:privateAccount,userId:owner,name:"Private",accountType:"checking",currency:"AUD"}]);
  await db.insert(schema.householdAccountShares).values({accountId:joint,memberUserId:member,grantedByUserId:owner});
  await db.insert(schema.accountOwnershipAllocations).values([
    {accountId:joint,personId:ownerPerson,share:"0.5",effectiveFrom:"2026-01-01"},{accountId:joint,personId:memberPerson,share:"0.5",effectiveFrom:"2026-01-01"},
    {accountId:joint,personId:ownerPerson,share:"0.75",effectiveFrom:"2026-07-01"},{accountId:joint,personId:memberPerson,share:"0.25",effectiveFrom:"2026-07-01"},
  ]);
  await db.insert(schema.categories).values({id:category,userId:owner,name:"Housing",categoryType:"expense"});
  await db.insert(schema.exchangeRates).values({baseCurrency:"AUD",targetCurrency:"USD",rate:"2",date:new Date("2026-01-01")}).onConflictDoNothing();
  await db.insert(schema.transactions).values([
    {id:first,userId:owner,accountId:joint,amount:"-100",functionalAmount:"-100",currency:"AUD",bookedAt:new Date("2026-06-01"),categoryId:category},
    {id:second,userId:owner,accountId:joint,amount:"-100",functionalAmount:"-100",currency:"AUD",bookedAt:new Date("2026-07-01"),categoryId:category},
    {id:ownTx,userId:member,accountId:own,amount:"40",functionalAmount:"40",currency:"USD",bookedAt:new Date("2026-07-01")},
    {id:privateTx,userId:owner,accountId:privateAccount,amount:"999",currency:"AUD",bookedAt:new Date("2026-07-01")},
  ]);
  ({getCategorySpendingData:categoryData,getCategorySpendingTransactionsPage:categoryPage}=await import("./category-spending"));
  actor.id=member;
});
afterAll(async()=>{
  if(!url||!db)return;
  await db.delete(schema.users).where(inArray(schema.users.id,users));
  // The shared synthetic FX fixture is retained for parallel model suites.
});
describe.skipIf(!url)("transaction scope over real migrated PostgreSQL",()=>{
  it("keeps original bank amounts and uses dated ownership plus actor currency for rows and totals",async()=>{
    const data=await page(params());
    expect(data.totalCount).toBe(3);
    expect(data.rows.find(row=>row.id===first)).toMatchObject({amount:-100,currency:"AUD",attributedAmount:-100,economicShare:0.5,reportingCurrency:"USD"});
    expect(data.rows.find(row=>row.id===second)).toMatchObject({amount:-100,attributedAmount:-50,economicShare:0.25});
    expect(data.filteredTotals).toMatchObject({totalIn:40,totalOut:150,currency:"USD",missingConversions:0});
    const household=await page(params({person:"all"}));
    expect(household.totalCount).toBe(3);
    expect(household.filteredTotals).toMatchObject({totalIn:40,totalOut:400});
    expect(household.rows.find(row=>row.id===second)).toMatchObject({amount:-100,attributedAmount:-200,economicShare:1});
  });
  it("applies amount filtering and sorting to selected-view reporting values",async()=>{
    const data=await page(params({minAmount:"75",sort:"amount",order:"asc"}));
    expect(data.rows.map(row=>row.id)).toEqual([first]);
    expect(data.filteredTotals).toMatchObject({totalOut:100,totalIn:0});
  });
  it("keeps missing conversion unknown and does not expose records to an outsider",async()=>{
    await db.insert(schema.transactions).values({id:unknown,userId:owner,accountId:joint,amount:"-80",functionalAmount:null,currency:"EUR",bookedAt:new Date("2026-08-01")});
    try {
      const data=await page(params());
      expect(data.rows.find(row=>row.id===unknown)?.attributedAmount).toBeNull();
      expect(data.filteredTotals).toMatchObject({totalIn:null,totalOut:null,missingConversions:1});
      const uncertain=await page(params({minAmount:"10000"}));
      expect(uncertain.rows.map(row=>row.id)).toEqual([unknown]);
      expect(uncertain.filteredTotals?.totalOut).toBeNull();
      actor.id=outsider;
      expect((await page(params())).rows).toEqual([]);
    }finally {actor.id=member;await db.delete(schema.transactions).where(eq(schema.transactions.id,unknown));}
  });
  it("refreshes export attribution and suppresses generated private-source names in reads and search",async()=>{
    expect((await exportRows([second],"all"))[0]).toMatchObject({amount:-100,attributedAmount:-200});
    await db.update(schema.transactions).set({externalId:`mirror-${privateTx}`,description:"PRIVATE SOURCE NAME",merchant:"PRIVATE SOURCE NAME"}).where(eq(schema.transactions.id,second));
    try {
      const data=await page(params());
      expect(data.rows.find(row=>row.id===second)).toMatchObject({description:"Transfer",merchant:null});
      expect((await page(params({search:"PRIVATE SOURCE NAME"}))).rows).toEqual([]);
      expect((await exportRows([second]))[0]).toMatchObject({description:"Transfer",merchant:null,attributedAmount:-50});
      await expect(exportRows([privateTx])).rejects.toThrow("no longer available");
    }finally {await db.update(schema.transactions).set({externalId:null,description:null,merchant:null}).where(eq(schema.transactions.id,second));}
  });
  it("uses consumption portions and refunds for both category totals and exact transaction drilldowns",async()=>{
    const refund=randomUUID();
    await db.update(schema.transactions).set({cashFlowParts:[{kind:"capital",detail:"loan_principal",amount:60},{kind:"consumption",amount:40}]}).where(eq(schema.transactions.id,first));
    await db.insert(schema.transactions).values({id:refund,userId:member,accountId:own,amount:"20",currency:"USD",bookedAt:new Date("2026-07-10"),categoryId:category});
    try {
      const filters={dateFrom:"2026-01-01",dateTo:"2026-12-31"};
      const data=await categoryData(filters),details=await categoryPage(filters);
      expect(data.summary.totalSpend).toBe(70);
      expect(details.rows.reduce((sum,row)=>sum-(row.attributedAmount??0),0)).toBe(70);
      expect(details.rows.find(row=>row.id===first)).toMatchObject({amount:-100,attributedAmount:-40});
      expect(details.rows.find(row=>row.id===refund)).toMatchObject({amount:20,attributedAmount:20});
      expect((await categoryData({...filters,personId:"all"})).summary.totalSpend).toBe(260);
    }finally {await db.update(schema.transactions).set({cashFlowParts:null}).where(eq(schema.transactions.id,first));await db.delete(schema.transactions).where(eq(schema.transactions.id,refund));}
  });
  it("compares stable category identities when names are identical",async()=>{
    const otherCategory=randomUUID(),otherTx=randomUUID();
    await db.insert(schema.categories).values({id:otherCategory,userId:member,name:"Housing",categoryType:"expense"});
    await db.insert(schema.transactions).values({id:otherTx,userId:member,accountId:own,amount:"-20",currency:"USD",bookedAt:new Date("2026-07-10"),categoryId:otherCategory});
    try {
      const data=await categoryData({dateFrom:"2026-07-01",dateTo:"2026-07-31"});
      expect(data.categories.find(row=>row.id===otherCategory)).toMatchObject({amount:20,deltaAmount:20});
      expect(data.categories.find(row=>row.id===category)).toMatchObject({amount:50,deltaAmount:-50});
    }finally {await db.delete(schema.transactions).where(eq(schema.transactions.id,otherTx));await db.delete(schema.categories).where(eq(schema.categories.id,otherCategory));}
  });
  it("keeps a custodian's closed account history in coverage but denies stale/private selections",async()=>{
    const {getReportingCoverage}=await import("@/lib/reporting/coverage");
    await db.update(schema.accounts).set({isActive:false}).where(eq(schema.accounts.id,own));
    try {
      expect((await getReportingCoverage(member)).accounts.find(account=>account.id===own)).toMatchObject({isActive:false,name:"Own"});
      expect((await page(params({account:own}))).rows.map(row=>row.id)).toEqual([ownTx]);
      await expect(page(params({account:privateAccount}))).rejects.toThrow("no longer available");
      await expect(categoryData({accountIds:[privateAccount],dateFrom:"2026-01-01",dateTo:"2026-12-31"})).rejects.toThrow("no longer available");
    }finally {await db.update(schema.accounts).set({isActive:true}).where(eq(schema.accounts.id,own));}
  });
  it("rechecks current account grants on every request",async()=>{
    await db.delete(schema.householdAccountShares).where(eq(schema.householdAccountShares.accountId,joint));
    const data=await page(params());
    expect(data.rows.map(row=>row.id)).toEqual([ownTx]);
    expect(data.filteredTotals).toMatchObject({totalIn:40,totalOut:0});
    await expect(exportRows([second])).rejects.toThrow("no longer available");
    await expect(page(params({account:joint}))).rejects.toThrow("no longer available");
  });
});
