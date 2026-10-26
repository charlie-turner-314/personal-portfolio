// @vitest-environment node
import { randomUUID } from "node:crypto";
import { afterEach,beforeAll,beforeEach,describe,expect,it,vi } from "vitest";
import { and,eq,inArray,sql } from "drizzle-orm";
import * as schema from "@/lib/db/schema";

const session=vi.hoisted(()=>({actor:"",email:"synthetic@example.test"}));
vi.mock("@/lib/household/financial-auth",()=>({requireAuth:async()=>session.actor,getAuthenticatedSession:async()=>({user:{id:session.actor,email:session.email}})}));
vi.mock("@/lib/auth-helpers",()=>({getAuthenticatedSession:async()=>({user:{id:session.actor,email:session.email}})}));
vi.mock("next/cache",()=>({revalidatePath:vi.fn(),updateTag:vi.fn()}));
vi.mock("@/lib/balances/mutations",async original=>{
  const actual=await original<typeof import("@/lib/balances/mutations")>();
  return {...actual,refreshAccountBalances:vi.fn(actual.refreshAccountBalances)};
});
const url=process.env.HOUSEHOLD_MODEL_TEST_DATABASE_URL;
let db:typeof import("@/lib/db").db;
let actions:typeof import("./account-balances");
let transactions:typeof import("./transactions");
let accounts:typeof import("./accounts");
let rateIds:string[]=[];
let refresh:typeof import("@/lib/balances/mutations").refreshAccountBalances;
let custodian:string,member:string,outsider:string,account:string,privateAccount:string,movement:string;
const day=(offset:number)=>new Date(Date.now()+offset*86400000).toISOString().slice(0,10);
const stamp=(offset:number)=>new Date(`${day(offset)}T00:00:00Z`);

beforeAll(async()=>{
  if(!url) return;
  if(process.env.HOUSEHOLD_TEST_ISOLATED!=="yes"||!new URL(url).pathname.includes("household_model_test")) throw new Error("Use the dedicated synthetic database");
  process.env.DATABASE_URL=url;
  ({db}=await import("@/lib/db"));
  actions=await import("./account-balances");
  transactions=await import("./transactions");
  accounts=await import("./accounts");
  ({refreshAccountBalances:refresh}=await import("@/lib/balances/mutations"));
});
beforeEach(async()=>{
  if(!url) return;
  [custodian,member,outsider]=["custodian","member","outsider"].map(name=>`balance-${name}-${randomUUID()}`);
  [account,privateAccount,movement]=[randomUUID(),randomUUID(),randomUUID()];
  await db.insert(schema.users).values([custodian,member,outsider].map(id=>({id,email:`${id}@example.test`,functionalCurrency:id===custodian?"ZBB":"ZCC"})));
  const person=randomUUID();
  await db.insert(schema.people).values({id:person,userId:custodian,name:"Partner",kind:"member",linkedUserId:member});
  await db.insert(schema.householdMemberships).values({ownerUserId:custodian,memberUserId:member,personId:person});
  await db.insert(schema.accounts).values([{id:account,userId:custodian,name:"Shared cash",accountType:"checking",currency:"ZAA",startingBalance:"100",createdAt:stamp(-2)},
    {id:privateAccount,userId:outsider,name:"PRIVATE OUTSIDER",accountType:"cash",currency:"ZAA",startingBalance:"99999"}]);
  await db.insert(schema.householdAccountShares).values({accountId:account,memberUserId:member,grantedByUserId:custodian});
  await db.insert(schema.transactions).values({id:movement,userId:custodian,accountId:account,amount:"20",currency:"ZAA",bookedAt:stamp(0),description:"Original bank movement"});
  rateIds=[];
  session.actor=member;
  session.email="synthetic@example.test";
});
afterEach(async()=>{
  if(!url||!db) return;
  await db.delete(schema.users).where(inArray(schema.users.id,[custodian,member,outsider]));
  if(rateIds.length) await db.delete(schema.exchangeRates).where(inArray(schema.exchangeRates.id,rateIds));
});

describe.skipIf(!url)("manual balances and deletion over migrated PostgreSQL",()=>{
  it("records an independent value with actor/units, creates no transaction, and estimates only subsequent activity",async()=>{
    expect(await actions.recordAccountBalance({accountId:account,date:day(-2),balance:500})).toEqual({success:true});
    const rows=await db.query.accountBalances.findMany({where:eq(schema.accountBalances.accountId,account),orderBy:schema.accountBalances.date});
    expect(rows).toHaveLength(3);
    expect(rows[0]).toMatchObject({balanceSource:"manual",recordedByUserId:member,accountCurrency:"ZAA",functionalCurrency:"ZBB",balanceInAccountCurrency:"500.00",balanceInFunctionalCurrency:null});
    expect(rows[2]).toMatchObject({balanceSource:"calculated",balanceInAccountCurrency:"520.00",balanceInFunctionalCurrency:null});
    expect(await db.query.transactions.findMany({where:eq(schema.transactions.accountId,account)})).toHaveLength(1);
    expect((await db.query.accounts.findFirst({where:eq(schema.accounts.id,account)}))?.functionalBalance).toBeNull();
    expect(await actions.recordAccountBalance({accountId:account,date:day(-2),balance:600})).toEqual({success:true});
    const revisions=await db.execute(sql`SELECT snapshot->>'balance_in_account_currency' amount FROM account_balance_revisions WHERE account_id=${account}`);
    expect(revisions.some(row=>row.amount==="500.00")).toBe(true);
  },20_000);
  it("rejects outsiders, revoked selections, invalid dates and missing values without writing",async()=>{
    session.actor=outsider;
    expect((await actions.recordAccountBalance({accountId:account,date:day(-1),balance:500})).success).toBe(false);
    session.actor=member;
    await db.delete(schema.householdAccountShares).where(eq(schema.householdAccountShares.accountId,account));
    expect((await actions.recordAccountBalance({accountId:account,date:day(-1),balance:500})).success).toBe(false);
    session.actor=custodian;
    for(const input of [{date:"2026-02-30",balance:500},{date:day(2),balance:500},{date:day(-1),balance:Number.NaN}]) expect((await actions.recordAccountBalance({accountId:account,...input})).success).toBe(false);
    expect(await db.query.accountBalances.findMany({where:eq(schema.accountBalances.accountId,account)})).toHaveLength(0);
  },20_000);
  it("previews deletion in account units and preserves recorded balances after deletion",async()=>{
    await actions.recordAccountBalance({accountId:account,date:day(-2),balance:500});
    const preview=await transactions.getDeleteImpact([movement]);
    expect(preview.success).toBe(true);
    if(!preview.success) return;
    expect(preview.data.accountImpacts[0]).toMatchObject({currency:"ZAA",currentBalance:520,projectedBalance:500,amountChange:-20,balanceIsAnchored:true});
    expect(await transactions.deleteTransactions([movement])).toMatchObject({success:true,deletedCount:1});
    const rows=await db.query.accountBalances.findMany({where:eq(schema.accountBalances.accountId,account),orderBy:schema.accountBalances.date});
    expect(rows[0]).toMatchObject({balanceSource:"manual",balanceInAccountCurrency:"500.00"});
    expect(rows.at(-1)?.balanceInAccountCurrency).toBe("500.00");
  },20_000);
  it("rejects a mixed permitted/private selection atomically and reports no private names",async()=>{
    const privateMovement=randomUUID();
    await db.insert(schema.transactions).values({id:privateMovement,userId:outsider,accountId:privateAccount,amount:"99999",currency:"ZAA",bookedAt:stamp(0)});
    expect(await transactions.getDeleteImpact([movement,privateMovement])).toMatchObject({success:false});
    expect(await transactions.deleteTransactions([movement,privateMovement])).toMatchObject({success:false});
    expect(await db.query.transactions.findMany({where:inArray(schema.transactions.id,[movement,privateMovement])})).toHaveLength(2);
  },20_000);
  it("converts every deleted movement at its own date and leaves unknown FX unavailable",async()=>{
    const previous=randomUUID();
    await db.insert(schema.transactions).values({id:previous,userId:custodian,accountId:account,amount:"10",currency:"ZDD",bookedAt:stamp(-1)});
    await db.update(schema.transactions).set({amount:"10",currency:"ZDD"}).where(eq(schema.transactions.id,movement));
    rateIds=[randomUUID(),randomUUID()];
    await db.insert(schema.exchangeRates).values([{id:rateIds[0],date:stamp(-1),baseCurrency:"ZDD",targetCurrency:"ZAA",rate:"2"},{id:rateIds[1],date:stamp(0),baseCurrency:"ZDD",targetCurrency:"ZAA",rate:"3"}]);
    const preview=await transactions.getDeleteImpact([previous,movement]);
    expect(preview.success && preview.data.accountImpacts[0]).toMatchObject({currentBalance:150,projectedBalance:100,amountChange:-50,currency:"ZAA"});
    await db.delete(schema.exchangeRates).where(eq(schema.exchangeRates.id,rateIds[0]));
    const unknown=await transactions.getDeleteImpact([previous]);
    expect(unknown.success && unknown.data.accountImpacts[0]).toMatchObject({currentBalance:null,projectedBalance:130,amountChange:null});
  },20_000);
  it("uses functional currency for new accounts and never renames existing financial units",async()=>{
    session.actor=custodian;
    rateIds=[randomUUID()];
    await db.insert(schema.exchangeRates).values({id:rateIds[0],date:stamp(0),baseCurrency:"ZAA",targetCurrency:"ZBB",rate:"2"});
    const created=await accounts.createAccount({name:"New manual",accountType:"cash",currency:"ZAA",startingBalance:30});
    expect(created.success).toBe(true);
    const stored=await db.query.accounts.findFirst({where:eq(schema.accounts.id,created.accountId!)});
    expect(stored).toMatchObject({currency:"ZAA",startingBalance:"30.00",functionalBalance:"60.00"});
    expect((await accounts.updateAccount(account,{currency:"ZBB"})).success).toBe(false);
    expect((await db.query.transactions.findFirst({where:eq(schema.transactions.id,movement)}))?.currency).toBe("ZAA");
  },20_000);
  it("serializes a concurrent withdrawal with the write and rejects subsequent access",async()=>{
    const {householdTransaction}=await import("@/lib/household/transaction");
    let entered!:()=>void,release!:()=>void;
    const started=new Promise<void>(resolve=>{entered=resolve;});
    const gate=new Promise<void>(resolve=>{release=resolve;});
    const original=vi.mocked(refresh).getMockImplementation()!;
    vi.mocked(refresh).mockImplementationOnce(async(...args)=>{entered();await gate;return original(...args);});
    const writing=actions.recordAccountBalance({accountId:account,date:day(-2),balance:500});
    await started;
    const withdrawing=householdTransaction(async tx=>{await tx.delete(schema.householdAccountShares).where(eq(schema.householdAccountShares.accountId,account));});
    release();
    expect(await writing).toEqual({success:true});
    await withdrawing;
    expect((await actions.recordAccountBalance({accountId:account,date:day(-2),balance:900})).success).toBe(false);
    expect((await transactions.getDeleteImpact([movement])).success).toBe(false);
    expect((await db.query.accountBalances.findFirst({where:and(eq(schema.accountBalances.accountId,account),eq(schema.accountBalances.balanceSource,"manual"))}))?.balanceInAccountCurrency).toBe("500.00");
  },20_000);
  it("rolls back deletion and observation replacement if recalculation fails",async()=>{
    await actions.recordAccountBalance({accountId:account,date:day(-2),balance:500});
    vi.mocked(refresh).mockRejectedValueOnce(new Error("Synthetic calculation failure"));
    expect((await transactions.deleteTransactions([movement])).success).toBe(false);
    expect(await db.query.transactions.findFirst({where:eq(schema.transactions.id,movement)})).toBeDefined();
    vi.mocked(refresh).mockRejectedValueOnce(new Error("Synthetic calculation failure"));
    expect((await actions.recordAccountBalance({accountId:account,date:day(-2),balance:900})).success).toBe(false);
    expect((await db.query.accountBalances.findFirst({where:and(eq(schema.accountBalances.accountId,account),eq(schema.accountBalances.balanceSource,"manual"))}))?.balanceInAccountCurrency).toBe("500.00");
  },20_000);
});
