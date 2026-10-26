"use server";

import { householdTransaction } from "@/lib/household/transaction";
import { refreshAccountBalances } from "@/lib/balances/mutations";
import { nativeBalanceEstimate } from "@/lib/balances/estimate";
import { requireReportingCoverage } from "@/lib/reporting/coverage";
import { transactionReportingValue } from "@/lib/reporting/transaction-value";
import { reportingCurrencyForUser } from "@/lib/household/reporting-currency";
import { categoryAccess } from "@/lib/household/category-access";
import { validateCashFlowPortions, type CashFlowPortion } from "@/lib/dashboard/cash-flow";
import { reportingCategoryFilter } from "@/lib/categories/reporting-sql";
import { accountAccess, propertyAccess } from "@/lib/household/account-access";
import { revalidatePath } from "next/cache";
import { eq, and, desc, inArray, sql, gte, lte, asc, or, ilike, isNull } from "drizzle-orm";
import { db } from "@/lib/db";
import { transactions, accounts, categories, properties, recurringTransactions } from "@/lib/db/schema";
import { requireAuth, getAuthenticatedSession } from "@/lib/household/financial-auth";
import { isDemoRestrictedUserEmail, DEMO_RESTRICTED_ACTION_ERROR } from "@/lib/demo-access";
import { getBackendBaseUrl } from "@/lib/backend-url";
import { createInternalAuthHeaders } from "@/lib/internal-auth";
import { resolveMissingAccountLogos } from "@/lib/actions/account-logos";
import type {
  TransactionSortField,
  TransactionSortOrder,
  TransactionsQueryState,
} from "@/lib/transactions/query-state";
import { hasActiveTransactionFilters } from "@/lib/transactions/query-state";

export interface CreateTransactionInput {
  accountId: string;
  amount: number;
  description: string;
  categoryId?: string;
  bookedAt: Date;
  transactionType: "debit" | "credit";
  merchant?: string;
}


export async function createTransaction(
  input: CreateTransactionInput
): Promise<{ success: boolean; error?: string; transactionId?: string }> {
  const userId = await requireAuth();

  if (!userId) {
    return { success: false, error: "Not authenticated" };
  }

  try {
    // Call backend API to import the transaction
    const backendUrl = getBackendBaseUrl();
    const pathWithQuery = "/api/transactions/import";

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
      body: JSON.stringify({
        transactions: [
          {
            account_id: input.accountId,
            amount: input.amount,
            description: input.description,
            merchant: input.merchant || null,
            booked_at: input.bookedAt.toISOString(),
            transaction_type: input.transactionType,
            category_id: input.categoryId || null, // Pre-selected category (skips AI categorization)
          },
        ],
        sync_exchange_rates: true,
        update_functional_amounts: true,
        calculate_balances: true,
      }),
    });

    if (!response.ok) {
      const errorText = await response.text();
      console.error("Backend import failed:", response.status, errorText);
      return { success: false, error: `Failed to create transaction: ${response.status}` };
    }

    const backendResponse = await response.json();

    if (!backendResponse.success) {
      return { success: false, error: backendResponse.message };
    }

    revalidatePath("/transactions");
    revalidatePath("/");
    revalidatePath("/settings");
    revalidatePath("/assets");

    return {
      success: true,
      transactionId: backendResponse.transaction_ids?.[0] || undefined
    };
  } catch (error) {
    console.error("Failed to create transaction:", error);
    return { success: false, error: "Failed to create transaction" };
  }
}

export async function updateTransactionCategory(
  transactionId: string,
  categoryId: string | null
): Promise<{ success: boolean; error?: string }> {
  const userId = await requireAuth();

  if (!userId) {
    return { success: false, error: "Not authenticated" };
  }

  try {
    // Verify the transaction belongs to the user
    const transaction = await db.query.transactions.findFirst({
      where: and(
        eq(transactions.id, transactionId),
        accountAccess(transactions.accountId, userId)
      ),
    });

    if (!transaction) {
      return { success: false, error: "Transaction not found" };
    }

    // Verify the category belongs to the user (if provided)
    if (categoryId) {
      const category = await db.query.categories.findFirst({
        where: and(
          eq(categories.id, categoryId),
          categoryAccess(userId)
        ),
      });

      if (!category) {
        return { success: false, error: "Category not found" };
      }
    }

    await db
      .update(transactions)
      .set({
        categoryId,
        categoryVerifiedAt: categoryId ? new Date() : null,
        updatedAt: new Date(),
      })
      .where(and(eq(transactions.id, transactionId), accountAccess(transactions.accountId, userId)));

    revalidatePath("/transactions");
    return { success: true };
  } catch (error) {
    console.error("Failed to update transaction category:", error);
    return { success: false, error: "Failed to update transaction category" };
  }
}

export async function updateTransactionProperty(
  transactionId: string,
  propertyId: string | null
): Promise<{ success: boolean; error?: string }> {
  const userId = await requireAuth();

  if (!userId) {
    return { success: false, error: "Not authenticated" };
  }

  try {
    const transaction = await db.query.transactions.findFirst({
      where: and(
        eq(transactions.id, transactionId),
        accountAccess(transactions.accountId, userId)
      ),
    });

    if (!transaction) {
      return { success: false, error: "Transaction not found" };
    }

    if (propertyId) {
      const property = await db.query.properties.findFirst({
        where: and(
          eq(properties.id, propertyId),
          propertyAccess(properties.id, userId),
          eq(properties.isActive, true)
        ),
      });

      if (!property) {
        return { success: false, error: "Property not found" };
      }
    }

    await db
      .update(transactions)
      .set({
        propertyId,
        updatedAt: new Date(),
      })
      .where(and(eq(transactions.id, transactionId), accountAccess(transactions.accountId, userId)));

    revalidatePath("/transactions");
    revalidatePath("/");
    revalidatePath("/assets");
    if (propertyId) {
      revalidatePath(`/assets/properties/${propertyId}`);
    }

    return { success: true };
  } catch (error) {
    console.error("Failed to update transaction property:", error);
    return { success: false, error: "Failed to update transaction property" };
  }
}

import { getUserAccounts as _dashboardGetUserAccounts } from "@/lib/actions/dashboard";

export async function getUserAccounts() {
  return _dashboardGetUserAccounts();
}

// Note: getUserCategories has been consolidated in lib/actions/categories.ts
// Use: import { getUserCategories } from "@/lib/actions/categories"

export interface TransactionWithRelations {
  id: string;
  accountId: string;
  account: {
    id: string;
    name: string;
    institution: string | null;
    accountType: string;
    logo: {
      id: string;
      logoUrl: string | null;
      updatedAt?: Date | null;
    } | null;
  } | null;
  description: string | null;
  merchant: string | null;
  creditor: string | null;
  debtor: string | null;
  amount: number; // original signed bank amount, preserved for editing
  attributedAmount?:number|null;
  economicShare?:number;
  reportingCurrency?:string;
  currency: string | null;
  categoryId: string | null;
  category: {
    id: string;
    name: string;
    color: string | null;
    icon: string | null;
  } | null;
  categorySystemId: string | null;
  categoryConfidence?: number | null;
  categorySystem: {
    id: string;
    name: string;
    color: string | null;
    icon: string | null;
  } | null;
  propertyId: string | null;
  property: {
    id: string;
    name: string;
  } | null;
  recurringTransactionId: string | null;
  recurringTransaction: {
    id: string;
    name: string;
    merchant: string | null;
    frequency: string;
  } | null;
  transactionLink: {
    groupId: string;
    linkRole: string;
  } | null;
  internalTransferId: string | null;
  internalTransfer: {
    id: string;
    pocketAccount: {
      id: string;
      name: string;
    } | null;
  } | null;
  bookedAt: Date;
  pending: boolean | null;
  transactionType: string | null;
  cashFlowParts?: CashFlowPortion[] | null;
  cashFlowKind?: string | null;
  cashFlowAllocationAmount?: string | null;
  includeInAnalytics: boolean;
  isGeneratedMirror?:boolean;
}

export interface TransactionsPageResult {
  rows: TransactionWithRelations[];
  totalCount: number;
  filteredTotals: FilteredTransactionTotals | null;
  page: number;
  pageSize: number;
  resolvedFrom?: string;
  resolvedTo?: string;
  effectiveHorizon?: number;
}

export interface FilteredTransactionTotals {
  totalIn: number|null;
  totalOut: number|null;
  currency?:string;
  missingConversions?:number;
}

/** Linked private resources must not leak through an otherwise shared transaction. */
async function sanitizeTransactionRelations<T extends TransactionRowWithRelations>(rows: T[], actorUserId: string): Promise<T[]> {
  const propertyIds = [...new Set(rows.flatMap((row) => row.propertyId ? [row.propertyId] : []))];
  const pocketIds = [...new Set(rows.flatMap((row) => row.internalTransfer?.pocketAccount ? [row.internalTransfer.pocketAccount.id] : []))];
  const recurringIds = [...new Set(rows.flatMap((row) => row.recurringTransactionId ? [row.recurringTransactionId] : []))];
  const [visibleProperties, visiblePockets, visibleRecurring] = await Promise.all([
    propertyIds.length ? db.select({ id: properties.id }).from(properties).where(and(inArray(properties.id, propertyIds), propertyAccess(properties.id, actorUserId))) : [],
    pocketIds.length ? db.select({ id: accounts.id }).from(accounts).where(and(inArray(accounts.id, pocketIds), accountAccess(accounts.id, actorUserId))) : [],
    recurringIds.length ? db.select({ id: recurringTransactions.id }).from(recurringTransactions).where(and(inArray(recurringTransactions.id, recurringIds), eq(recurringTransactions.userId, actorUserId))) : [],
  ]);
  const propertySet = new Set(visibleProperties.map((p) => p.id));
  const pocketSet = new Set(visiblePockets.map((a) => a.id));
  const recurringSet = new Set(visibleRecurring.map((r) => r.id));
  return rows.map((row) => {
    const propertyVisible = !!row.propertyId && propertySet.has(row.propertyId);
    const transferVisible = !!row.internalTransfer?.pocketAccount && pocketSet.has(row.internalTransfer.pocketAccount.id);
    const generatedMirror=row.externalId?.startsWith("mirror-")??false;
    return { ...row,
      ...(generatedMirror?{description:"Transfer",merchant:null,creditor:null,debtor:null}:{}),
      propertyId: propertyVisible ? row.propertyId : null, property: propertyVisible ? row.property : null,
      recurringTransactionId: row.recurringTransactionId && recurringSet.has(row.recurringTransactionId) ? row.recurringTransactionId : null,
      recurringTransaction: row.recurringTransactionId && recurringSet.has(row.recurringTransactionId) ? row.recurringTransaction : null,
      internalTransferId: transferVisible ? row.internalTransferId : null,
      internalTransfer: transferVisible ? row.internalTransfer : null,
    };
  });
}

function normalizeAccountIds(accountIds: string[]): string[] {
  return Array.from(new Set(accountIds.map((id) => id.trim()).filter(Boolean)));
}

function toNumberOrUndefined(value?: string): number | undefined {
  if (!value) return undefined;
  const parsed = Number.parseFloat(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

// Older generated mirrors embedded the private source account name in text.
// Apply the same projection to search/sort as to serialization, preventing an
// existence or ordering oracle through a sanitized result.
const safeDescription=sql<string|null>`CASE WHEN ${transactions.externalId} LIKE 'mirror-%' THEN 'Transfer' ELSE ${transactions.description} END`;
const safeMerchant=sql<string|null>`CASE WHEN ${transactions.externalId} LIKE 'mirror-%' THEN NULL ELSE ${transactions.merchant} END`;

function resolveSortOrder(
  sort: TransactionSortField,
  order: TransactionSortOrder,
  actor?:string,personId?:string
) {
  if (sort === "categoryConfidence") {
    // Review unscored rows first, scored suggestions next, and manual choices last.
    const group = sql`CASE WHEN ${transactions.categoryId} IS NOT NULL THEN 2
      WHEN ${transactions.categorySystemId} IS NULL OR ${transactions.categoryConfidence} IS NULL THEN 0
      ELSE 1 END`;
    const score = sql`CASE WHEN ${transactions.categoryId} IS NULL AND ${transactions.categorySystemId} IS NOT NULL
      THEN ${transactions.categoryConfidence} END`;
    return [asc(group), order === "asc" ? asc(score) : desc(score), desc(transactions.bookedAt), desc(transactions.id)];
  }
  if (sort === "amount") {
    const amount=actor?transactionReportingValue(actor,personId).amount:transactions.amount;
    return order === "asc"
      ? [asc(amount), desc(transactions.bookedAt)]
      : [desc(amount), desc(transactions.bookedAt)];
  }
  if (sort === "description") {
    return order === "asc"
      ? [asc(safeDescription), desc(transactions.bookedAt)]
      : [desc(safeDescription), desc(transactions.bookedAt)];
  }
  if (sort === "merchant") {
    return order === "asc"
      ? [asc(safeMerchant), desc(transactions.bookedAt)]
      : [desc(safeMerchant), desc(transactions.bookedAt)];
  }

  return order === "asc"
    ? [asc(transactions.bookedAt), desc(transactions.id)]
    : [desc(transactions.bookedAt), desc(transactions.id)];
}

interface TransactionRowWithRelations {
  id: string;
  accountId: string;
  description: string | null;
  merchant: string | null;
  creditor: string | null;
  debtor: string | null;
  amount: string;
  externalId?:string|null;
  attributedAmount?:string|null;
  economicShare?:string;
  reportingCurrency?:string;
  currency: string | null;
  categoryId: string | null;
  categorySystemId: string | null;
  categoryConfidence?: number | null;
  propertyId: string | null;
  recurringTransactionId: string | null;
  bookedAt: Date;
  pending: boolean | null;
  transactionType: string | null;
  cashFlowParts?: CashFlowPortion[] | null;
  cashFlowKind?: string | null;
  cashFlowAllocationAmount?: string | null;
  includeInAnalytics: boolean;
  account: {
    id: string;
    name: string;
    institution: string | null;
    accountType: string;
    logoId: string | null;
    logo: {
      id: string;
      logoUrl: string | null;
      updatedAt: Date | null;
    } | null;
  } | null;
  category: {
    id: string;
    name: string;
    color: string | null;
    icon: string | null;
  } | null;
  categorySystem: {
    id: string;
    name: string;
    color: string | null;
    icon: string | null;
  } | null;
  property: {
    id: string;
    name: string;
  } | null;
  recurringTransaction: {
    id: string;
    name: string;
    merchant: string | null;
    frequency: string;
  } | null;
  transactionLink: {
    groupId: string;
    linkRole: string;
  } | null;
  internalTransferId: string | null;
  internalTransfer: {
    id: string;
    pocketAccount: {
      id: string;
      name: string;
    } | null;
  } | null;
}

function mapTransactionRowsForUi(
  rows: TransactionRowWithRelations[],
  contextLabel: string
): TransactionWithRelations[] {
  return rows.flatMap((tx) => {
    if (!tx.account) {
      console.warn(`[${contextLabel}] Transaction missing account relation`, {
        transactionId: tx.id,
        accountId: tx.accountId,
      });
      return [];
    }

    return [
      {
        id: tx.id,
        accountId: tx.accountId,
        account: {
          id: tx.account.id,
          name: tx.account.name,
          institution: tx.account.institution,
          accountType: tx.account.accountType,
          logo: tx.account.logo
            ? {
                id: tx.account.logo.id,
                logoUrl: tx.account.logo.logoUrl,
                updatedAt: tx.account.logo.updatedAt,
              }
            : null,
        },
        description: tx.description,
        merchant: tx.merchant,
        creditor: tx.creditor,
        debtor: tx.debtor,
        isGeneratedMirror:tx.externalId?.startsWith("mirror-")??false,
        amount: parseFloat(tx.amount),
        ...(tx.attributedAmount!==undefined?{attributedAmount:tx.attributedAmount===null?null:Number(tx.attributedAmount),economicShare:Number(tx.economicShare),reportingCurrency:tx.reportingCurrency}:{}),
        currency: tx.currency,
        categoryId: tx.categoryId,
        category: tx.category
          ? {
              id: tx.category.id,
              name: tx.category.name,
              color: tx.category.color,
              icon: tx.category.icon,
            }
          : null,
        categorySystemId: tx.categorySystemId,
        categoryConfidence: tx.categoryConfidence ?? null,
        categorySystem: tx.categorySystem
          ? {
              id: tx.categorySystem.id,
              name: tx.categorySystem.name,
              color: tx.categorySystem.color,
              icon: tx.categorySystem.icon,
            }
          : null,
        propertyId: tx.propertyId,
        property: tx.property
          ? {
              id: tx.property.id,
              name: tx.property.name,
            }
          : null,
        recurringTransactionId: tx.recurringTransactionId,
        recurringTransaction: tx.recurringTransaction
          ? {
              id: tx.recurringTransaction.id,
              name: tx.recurringTransaction.name,
              merchant: tx.recurringTransaction.merchant,
              frequency: tx.recurringTransaction.frequency,
            }
          : null,
        transactionLink: tx.transactionLink
          ? {
              groupId: tx.transactionLink.groupId,
              linkRole: tx.transactionLink.linkRole,
            }
          : null,
        internalTransferId: tx.internalTransferId,
        internalTransfer: tx.internalTransfer
          ? {
              id: tx.internalTransfer.id,
              pocketAccount: tx.internalTransfer.pocketAccount
                ? {
                    id: tx.internalTransfer.pocketAccount.id,
                    name: tx.internalTransfer.pocketAccount.name,
                  }
                : null,
            }
          : null,
        bookedAt: tx.bookedAt,
        pending: tx.pending,
        transactionType: tx.transactionType,
        cashFlowParts: tx.cashFlowParts,
        cashFlowKind: tx.cashFlowKind,
        cashFlowAllocationAmount: tx.cashFlowAllocationAmount,
        includeInAnalytics: tx.includeInAnalytics,
      },
    ];
  });
}

async function hydrateTransactionRowsWithResolvedAccountLogos(
  rows: TransactionRowWithRelations[]
): Promise<TransactionRowWithRelations[]> {
  const uniqueAccounts = Array.from(
    new Map(
      rows
        .filter((row) => row.account)
        .map((row) => [
          row.account!.id,
          {
            id: row.account!.id,
            institution: row.account!.institution,
            logoId: row.account!.logoId,
            logo: row.account!.logo,
          },
        ])
    ).values()
  );

  const resolvedAccounts = await resolveMissingAccountLogos(uniqueAccounts);
  const resolvedById = new Map(resolvedAccounts.map((account) => [account.id, account]));

  return rows.map((row) => {
    if (!row.account) {
      return row;
    }

    const resolved = resolvedById.get(row.account.id);
    if (!resolved) {
      return row;
    }

    return {
      ...row,
      account: {
        ...row.account,
        logoId: resolved.logoId,
        logo: resolved.logo
          ? {
              id: resolved.logo.id,
              logoUrl: resolved.logo.logoUrl,
              updatedAt: resolved.logo.updatedAt ?? null,
            }
          : null,
      },
    };
  });
}

async function getLatestTransactionDateForScope(
  userId: string,
  accountIds: string[]
): Promise<Date> {
  const conditions = [accountAccess(transactions.accountId, userId)];
  if (accountIds.length > 0) {
    conditions.push(inArray(transactions.accountId, accountIds));
  }

  const result = await db
    .select({
      latestDate: sql<string>`MAX(${transactions.bookedAt})`,
    })
    .from(transactions)
    .where(and(...conditions));

  const latestDate = result[0]?.latestDate;
  return latestDate ? new Date(latestDate) : new Date();
}

interface ResolvedTransactionsWhereClause {
  whereClause: NonNullable<ReturnType<typeof and>>;
  resolvedFrom?: Date;
  resolvedTo?: Date;
  effectiveHorizon?: number;
}

async function buildTransactionsWhereClause(
  userId: string,
  input: TransactionsQueryState
): Promise<ResolvedTransactionsWhereClause> {
  const normalizedAccountIds = normalizeAccountIds(input.accountIds);
  if(normalizedAccountIds.length)await requireReportingCoverage(userId,normalizedAccountIds);
  const conditions = [accountAccess(transactions.accountId, userId)];

  if (normalizedAccountIds.length > 0) {
    conditions.push(inArray(transactions.accountId, normalizedAccountIds));
  }

  let resolvedFrom: Date | undefined;
  let resolvedTo: Date | undefined;
  let effectiveHorizon: number | undefined;

  if (input.from) {
    resolvedFrom = new Date(`${input.from}T00:00:00.000Z`);
    resolvedTo = input.to
      ? new Date(`${input.to}T23:59:59.999Z`)
      : await getLatestTransactionDateForScope(userId, normalizedAccountIds);
    resolvedTo.setHours(23, 59, 59, 999);
    if (resolvedTo < resolvedFrom) {
      resolvedTo = new Date(resolvedFrom);
      resolvedTo.setHours(23, 59, 59, 999);
    }
  } else if (input.horizon) {
    const latestDate = await getLatestTransactionDateForScope(userId, normalizedAccountIds);
    resolvedTo = new Date(latestDate);
    resolvedTo.setHours(23, 59, 59, 999);
    effectiveHorizon = input.horizon;
    resolvedFrom = new Date(resolvedTo);
    resolvedFrom.setDate(resolvedFrom.getDate() - (effectiveHorizon - 1));
    resolvedFrom.setHours(0, 0, 0, 0);
  }

  if (resolvedFrom) {
    conditions.push(gte(transactions.bookedAt, resolvedFrom));
  }
  if (resolvedTo) {
    conditions.push(lte(transactions.bookedAt, resolvedTo));
  }

  if (input.search) {
    conditions.push(
      or(
        ilike(safeDescription, `%${input.search}%`),
        ilike(safeMerchant, `%${input.search}%`)
      )!
    );
  }

  const categoryIds = input.category.filter((value) => value !== "uncategorized");
  const includeUncategorized = input.category.includes("uncategorized");
  if (categoryIds.length > 0 || includeUncategorized) {
    const categoryConditions = [];
    if (categoryIds.length > 0) {
      categoryConditions.push(reportingCategoryFilter(
        sql`COALESCE(${transactions.categoryId}, ${transactions.categorySystemId})`, categoryIds,
      ));
    }
    if (includeUncategorized) {
      categoryConditions.push(
        and(isNull(transactions.categoryId), isNull(transactions.categorySystemId))
      );
    }
    conditions.push(or(...categoryConditions)!);
  }

  const includesPending = input.status.includes("pending");
  const includesCompleted = input.status.includes("completed");
  if (includesPending !== includesCompleted) {
    if (includesPending) {
      conditions.push(eq(transactions.pending, true));
    } else {
      conditions.push(or(eq(transactions.pending, false), isNull(transactions.pending))!);
    }
  }

  const personalRecurringId=sql<string|null>`CASE WHEN EXISTS(SELECT 1 FROM recurring_transactions own_rule
    WHERE own_rule.id=${transactions.recurringTransactionId} AND own_rule.user_id=${userId}) THEN ${transactions.recurringTransactionId} END`;
  const subscriptionIds = input.subscription.filter((value) => value !== "no_subscription");
  const includesNoSubscription = input.subscription.includes("no_subscription");
  if (subscriptionIds.length > 0 || includesNoSubscription) {
    const subscriptionConditions = [];
    if (subscriptionIds.length > 0) {
      subscriptionConditions.push(inArray(personalRecurringId, subscriptionIds));
    }
    if (includesNoSubscription) {
      subscriptionConditions.push(isNull(personalRecurringId));
    }
    conditions.push(or(...subscriptionConditions)!);
  }

  const includesAnalytics = input.analytics.includes("included");
  const includesNonAnalytics = input.analytics.includes("excluded");
  if (includesAnalytics !== includesNonAnalytics) {
    conditions.push(eq(transactions.includeInAnalytics, includesAnalytics));
  }

  const minAmount = toNumberOrUndefined(input.minAmount);
  const maxAmount = toNumberOrUndefined(input.maxAmount);
  if (minAmount !== undefined) {
    conditions.push(sql`(${transactionReportingValue(userId,input.personId).amount} IS NULL OR ABS(${transactionReportingValue(userId,input.personId).amount}) >= ${minAmount})`);
  }
  if (maxAmount !== undefined) {
    conditions.push(sql`(${transactionReportingValue(userId,input.personId).amount} IS NULL OR ABS(${transactionReportingValue(userId,input.personId).amount}) <= ${maxAmount})`);
  }

  return {
    whereClause: and(...conditions)!,
    resolvedFrom,
    resolvedTo,
    effectiveHorizon,
  };
}

const transactionDetailsRelations={
        account: {
          with: {
            logo: {
              columns: {
                id: true,
                logoUrl: true,
                updatedAt: true,
              },
            },
          },
        },
        category: true,
        categorySystem: true,
        property: {
          columns: {
            id: true,
            name: true,
          },
        },
        recurringTransaction: true,
        transactionLink: true,
        internalTransfer: {
          with: {
            pocketAccount: {
              columns: {
                id: true,
                name: true,
              },
            },
          },
        },
      } as const;

export async function getTransactionsPage(
  input: TransactionsQueryState
): Promise<TransactionsPageResult> {
  const userId = await requireAuth();

  if (!userId) {
    return {
      rows: [],
      totalCount: 0,
      filteredTotals: null,
      page: input.page,
      pageSize: input.pageSize,
    };
  }

  const {
    whereClause,
    resolvedFrom,
    resolvedTo,
    effectiveHorizon,
  } = await buildTransactionsWhereClause(userId, input);
  const shouldComputeFilteredTotals = hasActiveTransactionFilters(input);
  const filteredValues=db.$with("filtered_transaction_values").as(db.select({
    amount:transactionReportingValue(userId,input.personId).amount.as("scope_amount"),
  }).from(transactions).where(whereClause));

  const [countRows, rows, totalsRows] = await Promise.all([
    db
      .select({
        count: sql<number>`COUNT(*)::int`,
      })
      .from(transactions)
      .where(whereClause),
    db.query.transactions.findMany({
      where: whereClause,
      orderBy: resolveSortOrder(input.sort, input.order,userId,input.personId),
      extras:{
        attributedAmount:transactionReportingValue(userId,input.personId).amount.as("attributed_amount"),
        economicShare:transactionReportingValue(userId,input.personId).share.as("economic_share"),
        reportingCurrency:sql<string>`${reportingCurrencyForUser(userId)}`.as("reporting_currency"),
      },
      limit: input.pageSize,
      offset: (input.page - 1) * input.pageSize,
      with: transactionDetailsRelations,
    }),
    shouldComputeFilteredTotals
      ? db.with(filteredValues).select({
          totalIn:sql<string|null>`CASE WHEN count(*) FILTER(WHERE scope_amount IS NULL)>0 THEN NULL ELSE coalesce(sum(greatest(scope_amount,0)),0) END`,
          totalOut:sql<string|null>`CASE WHEN count(*) FILTER(WHERE scope_amount IS NULL)>0 THEN NULL ELSE coalesce(sum(greatest(-scope_amount,0)),0) END`,
          currency:sql<string>`${reportingCurrencyForUser(userId)}`,
          missingConversions:sql<number>`count(*) FILTER(WHERE scope_amount IS NULL)::int`,
        }).from(filteredValues)
      : Promise.resolve([]),
  ]);

  const filteredTotals = shouldComputeFilteredTotals
    ? {
        totalIn: totalsRows[0]?.totalIn===null?null:Number(totalsRows[0]?.totalIn??0),
        totalOut: totalsRows[0]?.totalOut===null?null:Number(totalsRows[0]?.totalOut??0),
        currency:String(totalsRows[0]?.currency??"EUR"),
        missingConversions:totalsRows[0]?.missingConversions??0,
      }
    : null;
  const hydratedRows = await hydrateTransactionRowsWithResolvedAccountLogos(await sanitizeTransactionRelations(rows, userId));

  return {
    rows: mapTransactionRowsForUi(hydratedRows, "getTransactionsPage"),
    totalCount: countRows[0]?.count ?? 0,
    filteredTotals,
    page: input.page,
    pageSize: input.pageSize,
    resolvedFrom: resolvedFrom ? resolvedFrom.toISOString().slice(0, 10) : undefined,
    resolvedTo: resolvedTo ? resolvedTo.toISOString().slice(0, 10) : undefined,
    effectiveHorizon,
  };
}

/** Export always refreshes authorized records; browser-held rows are not authority. */
export async function getTransactionsForExport(ids:string[],personId?:string):Promise<TransactionWithRelations[]> {
  const userId=await requireAuth();
  if(!userId)throw new Error("Not authenticated");
  const requested=[...new Set(ids)];
  if(!requested.length||requested.length>1000)throw new Error("Select between one and 1,000 transactions");
  const rows=await db.query.transactions.findMany({
    where:and(accountAccess(transactions.accountId,userId),inArray(transactions.id,requested)),
    extras:{attributedAmount:transactionReportingValue(userId,personId).amount.as("attributed_amount"),
      economicShare:transactionReportingValue(userId,personId).share.as("economic_share"),
      reportingCurrency:sql<string>`${reportingCurrencyForUser(userId)}`.as("reporting_currency")},
    with:transactionDetailsRelations,
  });
  if(rows.length!==requested.length)throw new Error("Some selected records are no longer available. Refresh the selection before exporting.");
  return mapTransactionRowsForUi(await hydrateTransactionRowsWithResolvedAccountLogos(await sanitizeTransactionRelations(rows,userId)),"export");
}

export async function getTransactions(): Promise<TransactionWithRelations[]> {
  const userId = await requireAuth();

  if (!userId) {
    return [];
  }

  try {
    const result = await db.query.transactions.findMany({
      where: accountAccess(transactions.accountId, userId),
      orderBy: [desc(transactions.bookedAt)],
      with: {
        account: {
          with: {
            logo: {
              columns: {
                id: true,
                logoUrl: true,
                updatedAt: true,
              },
            },
          },
        },
        category: true,
        categorySystem: true,
        property: {
          columns: {
            id: true,
            name: true,
          },
        },
        recurringTransaction: true,
        transactionLink: true,
        internalTransfer: {
          with: {
            pocketAccount: {
              columns: {
                id: true,
                name: true,
              },
            },
          },
        },
      },
    });
    const hydratedRows = await hydrateTransactionRowsWithResolvedAccountLogos(await sanitizeTransactionRelations(result, userId));
    return mapTransactionRowsForUi(hydratedRows, "getTransactions");
  } catch (error: unknown) {
    const normalizedError =
      error instanceof Error
        ? {
            message: error.message,
            cause: "cause" in error ? (error as Error & { cause?: unknown }).cause : undefined,
            stack: error.stack,
          }
        : { message: String(error), cause: undefined, stack: undefined };
    console.error("[getTransactions] Query failed:", {
      error: normalizedError.message,
      cause: normalizedError.cause,
      stack: normalizedError.stack,
      userId,
    });
    // Return empty array on error to prevent app crash
    return [];
  }
}

export async function getTransactionsForAccount(
  accountId: string
): Promise<TransactionWithRelations[]> {
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

  try {
    const result = await db.query.transactions.findMany({
      where: and(
        accountAccess(transactions.accountId, userId),
        eq(transactions.accountId, accountId)
      ),
      orderBy: [desc(transactions.bookedAt)],
      with: {
        account: {
          with: {
            logo: {
              columns: {
                id: true,
                logoUrl: true,
                updatedAt: true,
              },
            },
          },
        },
        category: true,
        categorySystem: true,
        property: {
          columns: {
            id: true,
            name: true,
          },
        },
        recurringTransaction: true,
        transactionLink: true,
        internalTransfer: {
          with: {
            pocketAccount: {
              columns: {
                id: true,
                name: true,
              },
            },
          },
        },
      },
    });
    const hydratedRows = await hydrateTransactionRowsWithResolvedAccountLogos(await sanitizeTransactionRelations(result, userId));
    return mapTransactionRowsForUi(hydratedRows, "getTransactionsForAccount");
  } catch (error: unknown) {
    const normalizedError =
      error instanceof Error
        ? {
            message: error.message,
            cause: "cause" in error ? (error as Error & { cause?: unknown }).cause : undefined,
            stack: error.stack,
          }
        : { message: String(error), cause: undefined, stack: undefined };
    console.error("[getTransactionsForAccount] Query failed:", {
      error: normalizedError.message,
      cause: normalizedError.cause,
      stack: normalizedError.stack,
      userId,
      accountId,
    });
    // Return empty array on error to prevent app crash
    return [];
  }
}

export async function bulkUpdateTransactionCategory(
  transactionIds: string[],
  categoryId: string | null
): Promise<{ success: boolean; error?: string; updatedCount?: number }> {
  const userId = await requireAuth();

  if (!userId) {
    return { success: false, error: "Not authenticated" };
  }

  if (transactionIds.length === 0) {
    return { success: false, error: "No transactions selected" };
  }

  try {
    // Verify the category belongs to the user (if provided)
    if (categoryId) {
      const category = await db.query.categories.findFirst({
        where: and(
          eq(categories.id, categoryId),
          categoryAccess(userId)
        ),
      });

      if (!category) {
        return { success: false, error: "Category not found" };
      }
    }

    // Update all transactions that belong to the user
    await db
      .update(transactions)
      .set({
        categoryId,
        categoryVerifiedAt: categoryId ? new Date() : null,
        updatedAt: new Date(),
      })
      .where(
        and(
          inArray(transactions.id, transactionIds),
          accountAccess(transactions.accountId, userId)
        )
      );

    revalidatePath("/transactions");
    return { success: true, updatedCount: transactionIds.length };
  } catch (error) {
    console.error("Failed to bulk update transaction categories:", error);
    return { success: false, error: "Failed to update transactions" };
  }
}

export async function updateTransactionIncludeInAnalytics(
  transactionId: string,
  includeInAnalytics: boolean
): Promise<{ success: boolean; error?: string }> {
  const userId = await requireAuth();

  if (!userId) {
    return { success: false, error: "Not authenticated" };
  }

  try {
    // Verify the transaction belongs to the user
    const transaction = await db.query.transactions.findFirst({
      where: and(
        eq(transactions.id, transactionId),
        accountAccess(transactions.accountId, userId)
      ),
    });

    if (!transaction) {
      return { success: false, error: "Transaction not found" };
    }

    await db
      .update(transactions)
      .set({
        includeInAnalytics,
        updatedAt: new Date(),
      })
      .where(and(eq(transactions.id, transactionId), accountAccess(transactions.accountId, userId)));

    revalidatePath("/transactions");
    revalidatePath("/");
    return { success: true };
  } catch (error) {
    console.error("Failed to update transaction include_in_analytics:", error);
    return { success: false, error: "Failed to update transaction" };
  }
}

export async function bulkUpdateTransactionIncludeInAnalytics(
  transactionIds: string[],
  includeInAnalytics: boolean
): Promise<{ success: boolean; error?: string; updatedCount?: number }> {
  const userId = await requireAuth();

  if (!userId) {
    return { success: false, error: "Not authenticated" };
  }

  if (transactionIds.length === 0) {
    return { success: false, error: "No transactions selected" };
  }

  try {
    // Update all transactions that belong to the user
    await db
      .update(transactions)
      .set({
        includeInAnalytics,
        updatedAt: new Date(),
      })
      .where(
        and(
          inArray(transactions.id, transactionIds),
          accountAccess(transactions.accountId, userId)
        )
      );

    revalidatePath("/transactions");
    revalidatePath("/");
    return { success: true, updatedCount: transactionIds.length };
  } catch (error) {
    console.error("Failed to bulk update transaction include_in_analytics:", error);
    return { success: false, error: "Failed to update transactions" };
  }
}

/** Existing adjustment records retain their history; new balances are observations. */
export async function deleteBalancingTransaction(transactionId:string):Promise<{success:boolean;error?:string}> {
  const actor=await requireAuth();
  if(!actor) return {success:false,error:"Not authenticated"};
  const record=await db.query.transactions.findFirst({where:and(eq(transactions.id,transactionId),accountAccess(transactions.accountId,actor)),with:{category:true}});
  if(!record || record.category?.name!=="Balancing Transfer") return {success:false,error:"Balance adjustment not found"};
  return deleteTransactions([transactionId]);
}

// ============================================================================
// Deletion Flows
// ============================================================================

export interface AccountDeleteImpact {
  accountId:string;
  accountName:string;
  currency:string;
  amountChange:number|null;
  currentBalance:number|null;
  projectedBalance:number|null;
  balanceIsAnchored:boolean;
}
export interface DeleteImpact {
  accountImpacts:AccountDeleteImpact[];
  totalTransactions:number;
  earliestDate:Date;
}

/** Preview the same permitted records and dated units used by the deletion. */
export async function getDeleteImpact(transactionIds:string[]):Promise<{success:true;data:DeleteImpact}|{success:false;error:string}> {
  const actor=await requireAuth();
  if(!actor) return {success:false,error:"Not authenticated"};
  const ids=[...new Set(transactionIds)];
  if(!ids.length) return {success:false,error:"No transactions selected"};
  try {
    const data=await householdTransaction(async tx=>{
      const rows=await tx.query.transactions.findMany({where:and(inArray(transactions.id,ids),accountAccess(transactions.accountId,actor)),with:{account:true}});
      if(rows.length!==ids.length) throw new Error("Selection no longer available");
      if(rows.some(row=>row.internalTransferId)) throw new Error("Unlink automatic transfers before deleting their records");
      const byAccount=new Map(rows.filter(row=>row.account).map(row=>[row.accountId,row.account!]));
      const accountImpacts:AccountDeleteImpact[]=[];
      const day=new Date().toISOString().slice(0,10);
      for(const [accountId,account] of byAccount) {
        const [values]=await tx.select({
          current:nativeBalanceEstimate(accountId,account.currency,account.startingBalance??"0",day),
          projected:nativeBalanceEstimate(accountId,account.currency,account.startingBalance??"0",day,ids),
          recorded:sql<boolean>`EXISTS(SELECT 1 FROM account_balances ab WHERE ab.account_id=${accountId} AND ab.balance_source<>'calculated' AND ab.date::date<=${day}::date)`,
        }).from(accounts).where(and(eq(accounts.id,accountId),accountAccess(accounts.id,actor)));
        if(!values) throw new Error("Selection no longer available");
        const current=values.current===null?null:Number(values.current), projected=values.projected===null?null:Number(values.projected);
        accountImpacts.push({accountId,accountName:account.name,currency:account.currency??"XXX",
          currentBalance:current,projectedBalance:projected,amountChange:current===null||projected===null?null:projected-current,
          balanceIsAnchored:values.recorded||!!account.balanceIsAnchored});
      }
      return {accountImpacts,totalTransactions:rows.length,earliestDate:new Date(Math.min(...rows.map(row=>row.bookedAt.valueOf())))};
    });
    return {success:true,data};
  } catch(error) {return {success:false,error:error instanceof Error && error.message.startsWith("Unlink ") ? error.message : "Selection no longer available; refresh your transactions"};}
}

/** Delete the complete authorized selection and refresh derived caches atomically.
 * Recorded balances are independent evidence and survive transaction deletion.
 */
export async function deleteTransactions(transactionIds:string[]):Promise<{success:boolean;error?:string;affectedAccountIds?:string[];deletedCount?:number}> {
  const session=await getAuthenticatedSession();
  const actor=session?.user?.id;
  if(!actor) return {success:false,error:"Not authenticated"};
  if(isDemoRestrictedUserEmail(session.user.email)) return {success:false,error:DEMO_RESTRICTED_ACTION_ERROR};
  const ids=[...new Set(transactionIds)];
  if(!ids.length) return {success:false,error:"No transactions selected"};
  try {
    const result=await householdTransaction(async tx=>{
      await tx.execute(sql`SELECT id FROM transactions WHERE id IN (${sql.join(ids.map(id=>sql`${id}::uuid`),sql`, `)}) AND ${accountAccess(sql`transactions.account_id`,actor)} ORDER BY id FOR UPDATE`);
      const rows=await tx.query.transactions.findMany({where:and(inArray(transactions.id,ids),accountAccess(transactions.accountId,actor)),with:{account:true}});
      if(rows.length!==ids.length) throw new Error("Selection no longer available; refresh your transactions");
      // A linked generated leg is maintained by its transfer lifecycle. Removing
      // an arbitrary leg here would orphan a second economic record.
      if(rows.some(row=>row.internalTransferId)) throw new Error("Unlink automatic transfers before deleting their records");
      const byAccount=new Map<string,{startingBalance:number;earliest:Date}>();
      for(const row of rows) {
        if(!row.account) throw new Error("Selection no longer available; refresh your transactions");
        const existing=byAccount.get(row.accountId);
        if(existing) {if(row.bookedAt<existing.earliest) existing.earliest=row.bookedAt;}
        else byAccount.set(row.accountId,{startingBalance:Number(row.account.startingBalance??0),earliest:row.bookedAt});
      }
      const deleted=await tx.delete(transactions).where(and(inArray(transactions.id,ids),accountAccess(transactions.accountId,actor))).returning({id:transactions.id});
      if(deleted.length!==ids.length) throw new Error("Selection no longer available; refresh your transactions");
      for(const [accountId,values] of [...byAccount.entries()].sort(([a],[b])=>a.localeCompare(b))) {
        await refreshAccountBalances(tx,actor,accountId,values.earliest,values.startingBalance);
      }
      return {affectedAccountIds:[...byAccount.keys()],deletedCount:deleted.length};
    });
    for(const path of ["/transactions","/","/settings","/assets","/subscriptions",...result.affectedAccountIds.map(id=>`/accounts/${id}`)]) revalidatePath(path);
    return {success:true,...result};
  } catch(error) {return {success:false,error:error instanceof Error && /^(Selection|Unlink)/.test(error.message)?error.message:"Unable to delete transactions; no changes were saved"};}
}

/** Purpose is explicit reporting metadata; never infer principal from a payee or amount. */
export async function updateTransactionCashFlowPurpose(
  transactionId: string, parts: CashFlowPortion[] | null
): Promise<{ success: boolean; error?: string }> {
  const userId = await requireAuth();
  if (!userId) return { success: false, error: "Not authenticated" };
  try {
    const permitted = and(eq(transactions.id, transactionId), accountAccess(transactions.accountId, userId));
    const transaction = await db.query.transactions.findFirst({ where: permitted });
    if (!transaction) return { success: false, error: "Transaction not found" };
    const error = validateCashFlowPortions(parts, Number(transaction.amount));
    if (error) return { success: false, error };
    // Balance adjustments and synthetic transfer legs must retain their accounting meaning.
    if (transaction.externalId?.startsWith("mirror-")) return { success: false, error: "Generated transfer mirrors keep their transfer purpose. Edit the original bank record." };
    const categoryId = transaction.categoryId ?? transaction.categorySystemId;
    if (categoryId) {
      const category = await db.query.categories.findFirst({ where: eq(categories.id, categoryId) });
      if (category?.name === "Balancing Transfer") return { success: false, error: "Balance adjustments cannot be allocations" };
    }
    await db.update(transactions).set({
      cashFlowParts: parts,
      cashFlowKind: null,
      cashFlowAllocationAmount: null,
      updatedAt: new Date(),
    }).where(permitted);
    revalidatePath("/");
    revalidatePath("/transactions");
    return { success: true };
  } catch {
    return { success: false, error: "Failed to update cash-flow purpose" };
  }
}
