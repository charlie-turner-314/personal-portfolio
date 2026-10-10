import { and, eq, gte, inArray, isNull, lte, or, sql, type SQL } from "drizzle-orm";
import { db } from "@/lib/db";
import {
  accountOwnershipAllocations,
  categories,
  transactions,
  transactionLinks,
} from "@/lib/db/schema";

export interface CategoryActualAmount {
  id: string;
  name: string;
  color: string | null;
  icon: string | null;
  amount: number;
}

interface FetchCategoryActualAmountsOptions {
  startDate: Date;
  endDate: Date;
  accountIds?: string[];
  personId?: string;
  includeUncategorized?: boolean;
}

interface LinkedExpenseAmountSqlOptions {
  userId: string;
  startDate: Date;
  endDate: Date;
  accountIds: string[];
  personId?: string;
  aggregate?: boolean;
}

export function buildLinkedExpenseAmountSql({
  userId,
  startDate,
  endDate,
  accountIds,
  personId,
  aggregate = true,
}: LinkedExpenseAmountSqlOptions): SQL<string> {
  const linkedGroupConditions = [
    sql`tl2.group_id = ${transactionLinks.groupId}`,
    sql`tl2.group_id IS NOT NULL`,
    sql`t2.user_id = ${userId}`,
    sql`t2.include_in_analytics = true`,
    sql`t2.internal_transfer_id IS NULL`,
    // `t2` is an SQL alias, so Drizzle cannot infer the timestamp encoder
    // from a column reference. Preserve it explicitly to avoid passing a
    // raw Date object to postgres-js.
    sql`t2.booked_at >= ${sql.param(startDate, transactions.bookedAt)}`,
    sql`t2.booked_at <= ${sql.param(endDate, transactions.bookedAt)}`,
  ];

  if (accountIds.length > 0) {
    linkedGroupConditions.push(
      sql`t2.account_id IN (${sql.join(
        accountIds.map((id) => sql`${id}`),
        sql`, `
      )})`
    );
  }

  // The most recent allocation that started on or before the booked date is
  // the only one applicable to a transaction. A correlated scalar keeps this
  // correct for a report range that crosses an ownership change.
  const ownershipMultiplier = (transactionAlias: string) => personId
    ? sql`COALESCE((
        SELECT aoa.share
        FROM ${accountOwnershipAllocations} aoa
        WHERE aoa.account_id = ${sql.raw(`${transactionAlias}.account_id`)}
          AND aoa.person_id = ${personId}
          AND aoa.effective_from <= ${sql.raw(`${transactionAlias}.booked_at::date`)}
        ORDER BY aoa.effective_from DESC
        LIMIT 1
      ), 0)`
    : sql`1`;

  const amountSql = sql<string>`CASE
    WHEN ${transactionLinks.linkRole} = 'primary' AND ${transactionLinks.groupId} IS NOT NULL THEN
      COALESCE((
        SELECT CASE
          WHEN COALESCE(SUM(t2.amount * ${ownershipMultiplier("t2")}), 0) < 0 THEN ABS(COALESCE(SUM(t2.amount * ${ownershipMultiplier("t2")}), 0))
          ELSE 0
        END
        FROM ${transactions} t2
        JOIN ${transactionLinks} tl2 ON t2.id = tl2.transaction_id
        WHERE ${sql.join(linkedGroupConditions, sql` AND `)}
      ), 0)
    WHEN ${transactionLinks.linkRole} IS NOT NULL THEN 0
    ELSE ABS(${transactions.amount} * ${ownershipMultiplier("transactions")})
  END`;

  return aggregate ? sql<string>`COALESCE(SUM(${amountSql}), 0)` : amountSql;
}

function parseAmount(value: unknown): number {
  const parsed = typeof value === "number" ? value : Number(value ?? 0);
  return Number.isFinite(parsed) ? parsed : 0;
}

function normalizeAccountIds(accountIds?: string[]): string[] {
  if (!accountIds?.length) {
    return [];
  }

  return Array.from(new Set(accountIds.map((id) => id.trim()).filter(Boolean)));
}

export async function fetchCategoryActualAmounts(
  userId: string,
  {
    startDate,
    endDate,
    accountIds,
    personId,
    includeUncategorized = true,
  }: FetchCategoryActualAmountsOptions
): Promise<CategoryActualAmount[]> {
  const normalizedAccountIds = normalizeAccountIds(accountIds);
  const baseConditions = [
    eq(transactions.userId, userId),
    eq(transactions.transactionType, "debit"),
    eq(transactions.includeInAnalytics, true),
    isNull(transactions.internalTransferId),
    gte(transactions.bookedAt, startDate),
    lte(transactions.bookedAt, endDate),
  ];

  if (normalizedAccountIds.length > 0) {
    baseConditions.push(inArray(transactions.accountId, normalizedAccountIds));
  }
  const linkedExpenseAmountSql = buildLinkedExpenseAmountSql({
    userId,
    startDate,
    endDate,
    accountIds: normalizedAccountIds,
    personId,
  });

  const categorizedResult = await db
    .select({
      id: categories.id,
      name: categories.name,
      color: categories.color,
      icon: categories.icon,
      amount: linkedExpenseAmountSql,
    })
    .from(transactions)
    .innerJoin(
      categories,
      sql`${categories.id} = COALESCE(${transactions.categoryId}, ${transactions.categorySystemId})`
    )
    .leftJoin(transactionLinks, eq(transactions.id, transactionLinks.transactionId))
    .where(
      and(
        ...baseConditions,
        eq(categories.userId, userId),
        eq(categories.categoryType, "expense"),
        or(isNull(transactionLinks.linkRole), eq(transactionLinks.linkRole, "primary"))!
      )
    )
    .groupBy(categories.id, categories.name, categories.color, categories.icon);

  const items: CategoryActualAmount[] = categorizedResult
    .map((row) => ({
      id: row.id,
      name: row.name,
      color: row.color,
      icon: row.icon,
      amount: parseAmount(row.amount),
    }))
    .filter((item) => item.amount > 0);

  if (!includeUncategorized) {
    return items.sort((a, b) => b.amount - a.amount);
  }

  const uncategorizedResult = await db
    .select({
      amount: personId
        ? sql<string>`COALESCE(SUM(ABS(${transactions.amount} * COALESCE((
            SELECT aoa.share
            FROM ${accountOwnershipAllocations} aoa
            WHERE aoa.account_id = ${transactions.accountId}
              AND aoa.person_id = ${personId}
              AND aoa.effective_from <= ${transactions.bookedAt}::date
            ORDER BY aoa.effective_from DESC
            LIMIT 1
          ), 0))), 0)`
        : sql<string>`COALESCE(SUM(ABS(${transactions.amount})), 0)`,
    })
    .from(transactions)
    .leftJoin(transactionLinks, eq(transactions.id, transactionLinks.transactionId))
    .where(
      and(
        ...baseConditions,
        isNull(transactions.categoryId),
        isNull(transactions.categorySystemId),
        isNull(transactionLinks.linkRole)
      )
    );

  const uncategorizedAmount = parseAmount(uncategorizedResult[0]?.amount);
  if (uncategorizedAmount > 0) {
    items.push({
      id: "uncategorized",
      name: "Uncategorized",
      color: null,
      icon: null,
      amount: uncategorizedAmount,
    });
  }

  return items.sort((a, b) => b.amount - a.amount);
}
