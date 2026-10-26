import { and,inArray } from "drizzle-orm";
import { db } from "@/lib/db";
import { accounts } from "@/lib/db/schema";
import { accountAccess } from "@/lib/household/account-access";

export class ReportingSelectionUnavailable extends Error {
  constructor(){super("Some selected accounts are no longer available. Clear the account filter to update this report.");this.name="ReportingSelectionUnavailable";}
}

/** Historical records in a custodian's closed accounts remain reportable.
 * A former household grant never provides historical access after revocation.
 * Only permitted account names are returned; unavailable IDs are not looked up.
 */
export async function getReportingCoverage(actor:string,selectedIds?:string[]) {
  const selected=[...new Set(selectedIds?.map(id=>id.trim()).filter(Boolean)??[])];
  const permitted=await db.select({id:accounts.id,name:accounts.name,institution:accounts.institution,
    accountType:accounts.accountType,currency:accounts.currency,isActive:accounts.isActive})
    .from(accounts).where(and(accountAccess(accounts.id,actor),selected.length?inArray(accounts.id,selected):undefined))
    .orderBy(accounts.name);
  const available=new Set(permitted.map(account=>account.id));
  return {accounts:permitted,complete:selected.every(id=>available.has(id))};
}

export async function requireReportingCoverage(actor:string,selectedIds?:string[]) {
  const coverage=await getReportingCoverage(actor,selectedIds);
  if(!coverage.complete)throw new ReportingSelectionUnavailable();
  return coverage;
}
