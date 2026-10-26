"use server";

import { householdTransaction } from "@/lib/household/transaction";
import { refreshAccountBalances } from "@/lib/balances/mutations";
import { nativeBalanceEstimate } from "@/lib/balances/estimate";
import { convertReportingAmount, reportingCurrencyForUser } from "@/lib/household/reporting-currency";
import { accountAccess } from "@/lib/household/account-access";
import { revalidatePath, updateTag } from "next/cache";
import { eq, and, gte, desc, sql, inArray, max } from "drizzle-orm";
import { db } from "@/lib/db";
import { accounts, accountBalances, transactions, recurringTransactions, subscriptionSuggestions, superAccounts, csvImports, householdAccountShares, type NewAccount } from "@/lib/db/schema";
import { requireAuth, getAuthenticatedSession } from "@/lib/household/financial-auth";
import { isDemoRestrictedUserEmail, DEMO_RESTRICTED_ACTION_ERROR } from "@/lib/demo-access";
import { getBackendBaseUrl } from "@/lib/backend-url";
import { createInternalAuthHeaders } from "@/lib/internal-auth";
import { resolveMissingAccountLogo } from "@/lib/actions/account-logos";
import { getCachedFullUserAccounts, CACHE_TAGS } from "@/lib/data/cached";
import { isLiabilityAccountType } from "@/lib/constants/account-types";
import { getAccountFreshness, type AccountFreshness } from "@/lib/account-freshness";

export interface CreateAccountInput {
  name: string;
  accountType: string;
  institution?: string;
  currency: string;
  startingBalance?: number;
  liabilityInterestRate?: number | null;
  liabilityRepaymentAmount?: number | null;
  liabilityRepaymentFrequency?: string | null;
  liabilityLoanTermMonths?: number | null;
  liabilitySecured?: boolean | null;
  superFundName?: string;
  superInvestmentOption?: string | null;
  includeSuperInNetWorth?: boolean;
}

export interface UpdateAccountInput extends Partial<CreateAccountInput> {
  logoId?: string | null;
}

function decimalStringOrNull(value: number | null | undefined): string | null {
  return typeof value === "number" && Number.isFinite(value)
    ? value.toString()
    : null;
}

function integerOrNull(value: number | null | undefined): number | null {
  return Number.isInteger(value ?? NaN) && (value as number) > 0
    ? value as number
    : null;
}

function buildLiabilityFields(
  accountType: string,
  input: CreateAccountInput | UpdateAccountInput,
): Pick<
  NewAccount,
  | "liabilityInterestRate"
  | "liabilityRepaymentAmount"
  | "liabilityRepaymentFrequency"
  | "liabilityLoanTermMonths"
  | "liabilitySecured"
> {
  if (!isLiabilityAccountType(accountType)) {
    return {
      liabilityInterestRate: null,
      liabilityRepaymentAmount: null,
      liabilityRepaymentFrequency: null,
      liabilityLoanTermMonths: null,
      liabilitySecured: null,
    };
  }

  return {
    liabilityInterestRate: decimalStringOrNull(input.liabilityInterestRate),
    liabilityRepaymentAmount: decimalStringOrNull(input.liabilityRepaymentAmount),
    liabilityRepaymentFrequency: input.liabilityRepaymentFrequency || null,
    liabilityLoanTermMonths: integerOrNull(input.liabilityLoanTermMonths),
    liabilitySecured: input.liabilitySecured ?? null,
  };
}

export async function createAccount(
  input: CreateAccountInput
): Promise<{ success: boolean; error?: string; accountId?: string }> {
  const userId = await requireAuth();

  if (!userId) {
    return { success: false, error: "Not authenticated" };
  }

  try {
    if (input.accountType === "superannuation" && !input.superFundName?.trim()) {
      return { success: false, error: "Fund or provider is required for a super account" };
    }
    const balanceValue = input.startingBalance?.toString() || "0";
    const newAccount: NewAccount = {
      userId,
      name: input.name,
      accountType: input.accountType,
      institution: input.institution || null,
      currency: input.currency,
      startingBalance: balanceValue,
      functionalBalance: null, // Set below in the custodian's declared currency.
      ...buildLiabilityFields(input.accountType, input),
      provider: "manual",
      isActive: true,
    };

    const result = await db.transaction(async (tx) => {
      const [account] = await tx.insert(accounts).values(newAccount).returning({ id: accounts.id });
      await tx.update(accounts).set({functionalBalance:convertReportingAmount(sql`${balanceValue}::numeric`,sql`${input.currency}`,reportingCurrencyForUser(userId),sql`CURRENT_DATE`)}).where(eq(accounts.id,account.id));
      if (input.accountType === "superannuation") {
        await tx.insert(superAccounts).values({
          accountId: account.id,
          userId,
          fundName: input.superFundName!.trim(),
          investmentOption: input.superInvestmentOption?.trim() || null,
          includeInNetWorth: input.includeSuperInNetWorth ?? true,
        });
      }
      return account;
    });

    revalidatePath("/settings");
    revalidatePath("/transactions/import");
    updateTag(CACHE_TAGS.accounts(userId));
    return { success: true, accountId: result.id };
  } catch (error) {
    console.error("Failed to create account:", error);
    return { success: false, error: "Failed to create account" };
  }
}

export async function updateAccount(
  accountId: string,
  input: UpdateAccountInput
): Promise<{ success: boolean; error?: string }> {
  const userId = await requireAuth();

  if (!userId) {
    return { success: false, error: "Not authenticated" };
  }

  try {
    const outcome=await householdTransaction(async tx=>{
    const account = await tx.query.accounts.findFirst({
      where: and(eq(accounts.id, accountId), accountAccess(accounts.id, userId)),
    });

    if (!account) {
      return { success: false, error: "Account not found" };
    }

    if(input.currency!==undefined && input.currency!==account.currency) {
      const [facts]=await tx.select({exists:sql<boolean>`EXISTS(SELECT 1 FROM transactions WHERE account_id=${accountId}) OR EXISTS(SELECT 1 FROM account_balances WHERE account_id=${accountId}) OR EXISTS(SELECT 1 FROM holdings WHERE account_id=${accountId})`}).from(sql`(SELECT 1) seed`);
      if(facts.exists || Number(account.startingBalance??0)!==0) return {success:false,error:"Account currency cannot be renamed after financial records or an opening balance exist. Create an account in the correct currency instead."};
    }
    if(input.startingBalance!==undefined && (!Number.isFinite(input.startingBalance)||Math.abs(input.startingBalance)>=1e13)) return {success:false,error:"Enter a valid opening balance"};
    const updateData: Partial<NewAccount> = {
      updatedAt: new Date(),
    };

    if ("name" in input && input.name !== undefined) {
      updateData.name = input.name;
    }
    if ("accountType" in input && input.accountType !== undefined) {
      updateData.accountType = input.accountType;
    }
    if ("institution" in input) {
      updateData.institution = input.institution ?? null;
    }
    if ("currency" in input && input.currency !== undefined) {
      updateData.currency = input.currency;
    }
    if ("startingBalance" in input && input.startingBalance !== undefined) {
      updateData.startingBalance = input.startingBalance.toString();
    }
    if ("logoId" in input) {
      updateData.logoId = input.logoId ?? null;
    }

    const shouldUpdateLiabilityFields =
      "accountType" in input ||
      "liabilityInterestRate" in input ||
      "liabilityRepaymentAmount" in input ||
      "liabilityRepaymentFrequency" in input ||
      "liabilityLoanTermMonths" in input ||
      "liabilitySecured" in input;
    if (shouldUpdateLiabilityFields) {
      const nextAccountType = input.accountType ?? account.accountType;
      Object.assign(updateData, buildLiabilityFields(nextAccountType, input));
    }

    await tx.update(accounts).set(updateData).where(and(eq(accounts.id, accountId),accountAccess(accounts.id,userId)));
    if(input.startingBalance!==undefined || input.currency!==undefined && input.currency!==account.currency) {
      const [first]=await tx.select({date:sql<Date|null>`min(${transactions.bookedAt})`}).from(transactions).where(eq(transactions.accountId,accountId));
      await refreshAccountBalances(tx,userId,accountId,first?.date?new Date(first.date):new Date(),Number(input.startingBalance??account.startingBalance??0));
    }
    return {success:true};
    });
    if(!outcome.success) return outcome;

    revalidatePath("/assets");
    revalidatePath("/accounts");
    revalidatePath(`/accounts/${accountId}`);
    revalidatePath("/transactions");
    revalidatePath("/settings");
    revalidatePath("/");
    updateTag(CACHE_TAGS.accounts(userId));
    return { success: true };
  } catch (error) {
    console.error("Failed to update account:", error);
    return { success: false, error: "Failed to update account" };
  }
}

export async function deleteAccount(
  accountId: string
): Promise<{ success: boolean; error?: string }> {
  const userId = await requireAuth();

  if (!userId) {
    return { success: false, error: "Not authenticated" };
  }

  try {
    const account = await db.query.accounts.findFirst({
      where: and(eq(accounts.id, accountId), eq(accounts.userId, userId)),
    });

    if (!account) {
      return { success: false, error: "Account not found" };
    }

    // Soft delete by setting isActive to false
    // Note: Transactions and balances remain associated with the deactivated account
    // Use hardDeleteAccount for complete cleanup
    await db.transaction(async (tx) => {
      await tx.update(accounts).set({ isActive: false, updatedAt: new Date() }).where(eq(accounts.id, accountId));
      await tx.delete(householdAccountShares).where(eq(householdAccountShares.accountId, accountId));
    });

    revalidatePath("/settings");
    revalidatePath("/");
    updateTag(CACHE_TAGS.accounts(userId));
    return { success: true };
  } catch (error) {
    console.error("Failed to delete account:", error);
    return { success: false, error: "Failed to delete account" };
  }
}

/**
 * Permanently delete an account and all associated data.
 * This includes all transactions and balance history records.
 * Use with caution - this action cannot be undone.
 */
export async function hardDeleteAccount(
  accountId: string
): Promise<{ success: boolean; error?: string; deletedTransactions?: number; deletedBalances?: number }> {
  const userId = await requireAuth();

  if (!userId) {
    return { success: false, error: "Not authenticated" };
  }

  try {
    const account = await db.query.accounts.findFirst({
      where: and(eq(accounts.id, accountId), eq(accounts.userId, userId)),
    });

    if (!account) {
      return { success: false, error: "Account not found" };
    }

    // Delete subscriptions and suggestions linked to this account.
    // recurringTransactions has ON DELETE SET NULL on account_id, so we must
    // delete them explicitly; deleting them first nulls out
    // transactions.recurring_transaction_id via the DB cascade.
    await db
      .delete(recurringTransactions)
      .where(
        and(
          eq(recurringTransactions.accountId, accountId),
          eq(recurringTransactions.userId, userId)
        )
      );

    await db
      .delete(subscriptionSuggestions)
      .where(
        and(
          eq(subscriptionSuggestions.accountId, accountId),
          eq(subscriptionSuggestions.userId, userId)
        )
      );

    // Delete associated balance records first
    const deletedBalances = await db
      .delete(accountBalances)
      .where(eq(accountBalances.accountId, accountId))
      .returning({ id: accountBalances.id });

    // Delete associated transactions
    const deletedTransactions = await db
      .delete(transactions)
      .where(
        and(
          eq(transactions.accountId, accountId),
          eq(transactions.userId, userId)
        )
      )
      .returning({ id: transactions.id });

    // Delete the account
    await db.delete(accounts).where(eq(accounts.id, accountId));

    revalidatePath("/settings");
    revalidatePath("/");
    revalidatePath("/transactions");
    revalidatePath("/assets");
    updateTag(CACHE_TAGS.accounts(userId));

    return {
      success: true,
      deletedTransactions: deletedTransactions.length,
      deletedBalances: deletedBalances.length,
    };
  } catch (error) {
    console.error("Failed to hard delete account:", error);
    return { success: false, error: "Failed to delete account and associated data" };
  }
}

export async function getAccounts() {
  return getCachedFullUserAccounts();
}

/**
 * Returns freshness metadata for the requested accounts. CSV completion time
 * and transaction dates are queried separately so the Assets page can render
 * a useful status without loading import history or every transaction row.
 */
export async function getAccountsFreshness(
  accountIds: string[]
): Promise<Record<string, AccountFreshness>> {
  const userId = await requireAuth();
  if (!userId || accountIds.length === 0) return {};

  const [accountRows, csvRows, transactionRows] = await Promise.all([
    db
      .select({ id: accounts.id, provider: accounts.provider, lastSyncedAt: accounts.lastSyncedAt })
      .from(accounts)
      .where(and(accountAccess(accounts.id, userId), inArray(accounts.id, accountIds))),
    db
      .select({
        accountId: csvImports.accountId,
        completedAt: csvImports.completedAt,
        createdAt: csvImports.createdAt,
      })
      .from(csvImports)
      .where(
        and(
          eq(csvImports.userId, userId),
          inArray(csvImports.accountId, accountIds),
          eq(csvImports.status, "completed"),
        )
      )
      .orderBy(desc(sql`COALESCE(${csvImports.completedAt}, ${csvImports.createdAt})`)),
    db
      .select({ accountId: transactions.accountId, dataThrough: max(transactions.bookedAt) })
      .from(transactions)
      .where(and(accountAccess(transactions.accountId, userId), inArray(transactions.accountId, accountIds)))
      .groupBy(transactions.accountId),
  ]);

  const latestCsvByAccount = new Map<string, Date>();
  for (const row of csvRows) {
    if (!latestCsvByAccount.has(row.accountId)) {
      const importedAt = row.completedAt ?? row.createdAt;
      if (importedAt) latestCsvByAccount.set(row.accountId, importedAt);
    }
  }

  const dataThroughByAccount = new Map(
    transactionRows.map((row) => [row.accountId, row.dataThrough ?? null])
  );

  return Object.fromEntries(
    accountRows.map((account) => [
      account.id,
      getAccountFreshness({
        provider: account.provider,
        lastSyncedAt: account.lastSyncedAt,
        lastCsvImportAt: latestCsvByAccount.get(account.id) ?? null,
        dataThrough: dataThroughByAccount.get(account.id) ?? null,
      }),
    ])
  );
}

export async function getAccountFreshnessForAccount(
  accountId: string
): Promise<AccountFreshness | null> {
  const freshness = await getAccountsFreshness([accountId]);
  return freshness[accountId] ?? null;
}

export async function getAccountById(accountId: string) {
  const userId = await requireAuth();

  if (!userId) {
    return null;
  }

  const account = await db.query.accounts.findFirst({
    where: and(
      eq(accounts.id, accountId),
      accountAccess(accounts.id, userId),
      eq(accounts.isActive, true)
    ),
    with: {
      logo: {
        columns: {
          id: true,
          logoUrl: true,
          updatedAt: true,
        },
      },
    },
  });

  if (!account) {
    return null;
  }

  const resolved = await resolveMissingAccountLogo(account);
  return account.userId === userId ? resolved : { ...resolved, externalId: null, externalIdCiphertext: null, externalIdHash: null, ibanCiphertext: null, ibanHash: null, bankConnectionId: null };
}

export interface BalanceHistoryPoint {
  date: string;
  balance: number | null;
}

export async function getAccountBalanceHistory(
  accountId: string,
  days: number | null = 90
): Promise<BalanceHistoryPoint[]> {
  const userId = await requireAuth();

  if (!userId) {
    return [];
  }

  // Verify the account belongs to the user
  const account = await db.query.accounts.findFirst({
    where: and(
      eq(accounts.id, accountId),
      accountAccess(accounts.id, userId)
    ),
  });

  if (!account) {
    return [];
  }

  let startDate: Date | null = null;
  if (typeof days === "number") {
    startDate = new Date();
    startDate.setDate(startDate.getDate() - days);
    startDate.setHours(0, 0, 0, 0);
  } else {
    const earliestTx = await db
      .select({
        minBookedAt: sql<Date | null>`MIN(${transactions.bookedAt})`,
      })
      .from(transactions)
      .where(eq(transactions.accountId, accountId));

    if (earliestTx[0]?.minBookedAt) {
      startDate = new Date(earliestTx[0].minBookedAt);
      startDate.setHours(0, 0, 0, 0);
    }
  }

  const balanceHistory = await db.select({
    date: accountBalances.date,
    balance: convertReportingAmount(sql`${accountBalances.balanceInAccountCurrency}`,
      sql`coalesce(${accountBalances.accountCurrency},${account.currency})`,sql`${account.currency}`,accountBalances.date),
  }).from(accountBalances).where(and(eq(accountBalances.accountId,accountId),
    startDate ? gte(accountBalances.date,startDate) : undefined)).orderBy(accountBalances.date);
  if(balanceHistory.length) return balanceHistory.map(row=>({
    date:row.date.toISOString().slice(0,10),balance:row.balance===null?null:Number(row.balance),
  }));
  const from=startDate??new Date(account.createdAt??new Date());
  const rows=await db.select({
    date:sql<string>`to_char(balance_days.day,'YYYY-MM-DD')`,
    balance:nativeBalanceEstimate(accountId,account.currency,account.startingBalance??"0",sql`balance_days.day`),
  }).from(sql`generate_series(${from.toISOString()}::date,CURRENT_DATE,interval '1 day') AS balance_days(day)`);
  return rows.map(row=>({date:row.date,balance:row.balance===null?null:Number(row.balance)}));
}

export async function getAccountBalanceOnDate(accountId:string,date:Date):Promise<{balance:number|null;found:boolean}> {
  const userId=await requireAuth();
  if(!userId) return {balance:null,found:false};
  const account=await db.query.accounts.findFirst({where:and(eq(accounts.id,accountId),accountAccess(accounts.id,userId))});
  if(!account) return {balance:null,found:false};
  const [row]=await db.select({balance:nativeBalanceEstimate(accountId,account.currency,account.startingBalance??"0",date.toISOString().slice(0,10))}).from(sql`(SELECT 1) seed`);
  const balance=row?.balance==null?null:Number(row.balance);
  return {balance,found:balance!==null};
}

export async function recalculateAccountTimeseries(
  accountId: string
): Promise<{ success: boolean; error?: string; message?: string; daysProcessed?: number; recordsStored?: number }> {
  const userId = await requireAuth();

  if (!userId) {
    return { success: false, error: "Not authenticated" };
  }

  try {
    // Verify account belongs to user
    const account = await db.query.accounts.findFirst({
      where: and(eq(accounts.id, accountId), accountAccess(accounts.id, userId)),
    });

    if (!account) {
      return { success: false, error: "Account not found" };
    }

    // Call backend to recalculate timeseries
    const backendUrl = getBackendBaseUrl();
    const pathWithQuery = `/api/accounts/${accountId}/recalculate-timeseries`;
    const response = await fetch(`${backendUrl}${pathWithQuery}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...createInternalAuthHeaders({
          method: "POST",
          pathWithQuery,
          userId,
        }),
      },
    });

    if (!response.ok) {
      const errorData = await response.json().catch(() => ({ detail: "Unknown error" }));
      return { success: false, error: errorData.detail || "Failed to recalculate timeseries" };
    }

    const data = await response.json();

    revalidatePath("/settings");
    revalidatePath("/");
    revalidatePath("/transactions");
    revalidatePath("/assets");

    return {
      success: true,
      message: data.message || "Balance recalculated successfully",
      daysProcessed: data.days_processed,
      recordsStored: data.records_stored,
    };
  } catch (error) {
    console.error("Failed to recalculate timeseries:", error);
    return { success: false, error: "Failed to recalculate timeseries" };
  }
}

export type CreatePocketAccountInput = {
  name: string;
  accountType?: string;
  currency?: string;
  startingBalance?: number;
  iban: string;
};

export async function createPocketAccount(
  input: CreatePocketAccountInput,
): Promise<{ success: boolean; error?: string; accountId?: string; backfilledCount?: number }> {
  const session = await getAuthenticatedSession();
  const userId = session?.user?.id;
  if (!userId) return { success: false, error: "Not authenticated" };
  if (isDemoRestrictedUserEmail(session.user.email)) {
    return { success: false, error: DEMO_RESTRICTED_ACTION_ERROR };
  }

  try {
    const path = "/api/accounts/pocket";
    const url = `${getBackendBaseUrl().replace(/\/+$/, "")}${path}`;
    const headers = createInternalAuthHeaders({ method: "POST", pathWithQuery: path, userId });
    const resp = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...headers },
      body: JSON.stringify({
        name: input.name,
        account_type: input.accountType ?? "savings",
        currency: input.currency ?? "EUR",
        starting_balance: String(input.startingBalance ?? 0),
        iban: input.iban,
      }),
    });
    if (!resp.ok) {
      const data = await resp.json().catch(() => ({ detail: "Failed to create pocket account" }));
      const detail =
        typeof data.detail === "string"
          ? data.detail
          : Array.isArray(data.detail) && data.detail[0]?.msg
            ? data.detail[0].msg
            : "Failed to create pocket account";
      return { success: false, error: detail };
    }
    const data = await resp.json();
    revalidatePath("/settings");
    revalidatePath("/assets");
    revalidatePath("/transactions/import");
    return { success: true, accountId: data.account_id, backfilledCount: data.backfilled_count };
  } catch {
    return { success: false, error: "Failed to create pocket account" };
  }
}

export async function unlinkInternalTransfer(
  transferId: string,
): Promise<{ success: boolean; error?: string }> {
  const session = await getAuthenticatedSession();
  const userId = session?.user?.id;
  if (!userId) return { success: false, error: "Not authenticated" };
  if (isDemoRestrictedUserEmail(session.user.email)) {
    return { success: false, error: DEMO_RESTRICTED_ACTION_ERROR };
  }

  try {
    // URL-encode transferId so a malformed id (e.g. one with a slash) can't
    // produce a mismatch between the signed pathWithQuery and the actual
    // request path. UUIDs don't need it in practice, but be defensive.
    const path = `/api/accounts/internal-transfers/${encodeURIComponent(transferId)}`;
    const url = `${getBackendBaseUrl().replace(/\/+$/, "")}${path}`;
    const headers = createInternalAuthHeaders({ method: "DELETE", pathWithQuery: path, userId });
    const resp = await fetch(url, { method: "DELETE", headers });
    if (!resp.ok) {
      const data = await resp
        .json()
        .catch(() => ({ detail: "Failed to unlink internal transfer" }));
      return {
        success: false,
        error:
          typeof data.detail === "string"
            ? data.detail
            : "Failed to unlink internal transfer",
      };
    }
    revalidatePath("/transactions");
    revalidatePath("/assets");
    return { success: true };
  } catch {
    return { success: false, error: "Failed to unlink internal transfer" };
  }
}
