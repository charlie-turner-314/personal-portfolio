"use server";

import { and, desc, eq, sql } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { accounts, accountBalances } from "@/lib/db/schema";
import { accountAccess } from "@/lib/household/account-access";
import { householdTransaction } from "@/lib/household/transaction";
import { getAuthenticatedSession } from "@/lib/household/financial-auth";
import { convertReportingAmount, reportingCurrencyForUser } from "@/lib/household/reporting-currency";
import { refreshAccountBalances } from "@/lib/balances/mutations";
import { DEMO_RESTRICTED_ACTION_ERROR, isDemoRestrictedUserEmail } from "@/lib/demo-access";

/** Record a supplied closing balance without inventing an economic movement. */
export async function recordAccountBalance(input:{accountId:string;date:string;balance:number}) {
  const session=await getAuthenticatedSession();
  const actor=session?.user?.id;
  if(!actor) return {success:false,error:"Not authenticated"};
  if(isDemoRestrictedUserEmail(session.user.email)) return {success:false,error:DEMO_RESTRICTED_ACTION_ERROR};
  const stamp=new Date(`${input.date}T00:00:00.000Z`);
  if(!/^\d{4}-\d{2}-\d{2}$/.test(input.date) || !Number.isFinite(stamp.valueOf()) || stamp.toISOString().slice(0,10)!==input.date || input.date>new Date().toISOString().slice(0,10) || !Number.isFinite(input.balance) || Math.abs(input.balance)>=1e13) {
    return {success:false,error:"Enter a valid closing date and balance"};
  }
  try {
    await householdTransaction(async tx=>{
      const [account]=await tx.select().from(accounts).where(and(eq(accounts.id,input.accountId),accountAccess(accounts.id,actor))).for("update");
      if(!account) throw new Error("Account no longer available");
      const [existing]=await tx.select().from(accountBalances).where(and(eq(accountBalances.accountId,account.id),sql`${accountBalances.date}::date=${input.date}::date`)).orderBy(desc(accountBalances.date)).limit(1);
      const currency=reportingCurrencyForUser(account.userId);
      const values={balanceSource:"manual",recordedByUserId:actor,accountCurrency:account.currency,functionalCurrency:currency,
        balanceInAccountCurrency:input.balance.toFixed(2),
        balanceInFunctionalCurrency:convertReportingAmount(sql`${input.balance.toFixed(2)}::numeric`,sql`${account.currency}`,currency,sql`${input.date}::date`),updatedAt:new Date()};
      if(existing) await tx.update(accountBalances).set(values).where(and(eq(accountBalances.id,existing.id),accountAccess(accountBalances.accountId,actor)));
      else await tx.insert(accountBalances).values({accountId:account.id,date:stamp,...values});
      await refreshAccountBalances(tx,actor,account.id,stamp,Number(account.startingBalance??0));
    });
    for(const path of ["/","/assets","/settings",`/accounts/${input.accountId}`]) revalidatePath(path);
    return {success:true};
  } catch { return {success:false,error:"Unable to record balance; account access or data may have changed"}; }
}
