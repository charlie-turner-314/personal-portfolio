"use server";

import { revalidatePath } from "next/cache";
import { eq, and, desc, gte, inArray, lte, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import {
  accounts,
  categories,
  properties,
  propertyLiabilityLinks,
  propertyValuations,
  transactions,
  type NewProperty,
  type NewPropertyValuation,
} from "@/lib/db/schema";
import { requireAuth } from "@/lib/auth-helpers";
import { isLiabilityAccountType } from "@/lib/constants/account-types";
import {
  getAustralianFinancialYearRange,
  getAustralianFinancialYearUtcInterval,
} from "@/lib/dates/australian-financial-year";

export interface CreatePropertyInput {
  name: string;
  propertyType: string;
  address?: string;
  currentValue?: number;
  currency: string;
  isRental?: boolean;
  valuationDate?: string | null;
  valuationSource?: string | null;
  notes?: string | null;
  linkedLiabilityAccountIds?: string[];
}

function todayIsoDate(): string {
  return new Date().toISOString().slice(0, 10);
}

function normalizeLinkedLiabilityIds(ids: string[] | undefined): string[] {
  return [...new Set((ids || []).filter(Boolean))];
}

async function validateLinkedLiabilityAccounts(
  userId: string,
  accountIds: string[],
  propertyId?: string,
) {
  if (accountIds.length === 0) return { success: true as const };

  const linkedAccounts = await db
    .select({
      id: accounts.id,
      accountType: accounts.accountType,
    })
    .from(accounts)
    .where(and(
      eq(accounts.userId, userId),
      eq(accounts.isActive, true),
      inArray(accounts.id, accountIds),
    ));

  if (linkedAccounts.length !== accountIds.length) {
    return { success: false as const, error: "Linked liability account not found" };
  }

  if (linkedAccounts.some((account) => !isLiabilityAccountType(account.accountType))) {
    return { success: false as const, error: "Only liability accounts can be linked to a property" };
  }

  const existingLinks = await db
    .select({
      propertyId: propertyLiabilityLinks.propertyId,
      accountId: propertyLiabilityLinks.accountId,
    })
    .from(propertyLiabilityLinks)
    .where(and(
      eq(propertyLiabilityLinks.userId, userId),
      inArray(propertyLiabilityLinks.accountId, accountIds),
    ));

  const conflictingLink = existingLinks.find((link) => link.propertyId !== propertyId);
  if (conflictingLink) {
    return { success: false as const, error: "A liability account can only be linked to one property" };
  }

  return { success: true as const };
}

function buildValuationSnapshot(
  userId: string,
  propertyId: string,
  input: Pick<CreatePropertyInput, "currentValue" | "currency" | "valuationDate" | "valuationSource" | "notes">,
): NewPropertyValuation | null {
  if (input.currentValue === undefined || input.currentValue < 0) return null;

  return {
    userId,
    propertyId,
    valuationDate: input.valuationDate || todayIsoDate(),
    value: input.currentValue.toString(),
    currency: input.currency || "EUR",
    source: input.valuationSource?.trim() || "manual",
    notes: input.notes?.trim() || null,
  };
}

function revalidatePropertyPaths(propertyId?: string) {
  revalidatePath("/");
  revalidatePath("/assets");
  revalidatePath("/settings");
  if (propertyId) {
    revalidatePath(`/assets/properties/${propertyId}`);
  }
}

export async function createProperty(
  input: CreatePropertyInput
): Promise<{ success: boolean; error?: string; propertyId?: string }> {
  const userId = await requireAuth();

  if (!userId) {
    return { success: false, error: "Not authenticated" };
  }

  try {
    const linkedLiabilityAccountIds = normalizeLinkedLiabilityIds(input.linkedLiabilityAccountIds);
    const validation = await validateLinkedLiabilityAccounts(userId, linkedLiabilityAccountIds);
    if (!validation.success) {
      return { success: false, error: validation.error };
    }

    const newProperty: NewProperty = {
      userId,
      name: input.name,
      propertyType: input.propertyType,
      address: input.address || null,
      currentValue: input.currentValue?.toString() || "0",
      currency: input.currency,
      isRental: input.isRental || false,
      valuationDate: input.valuationDate || null,
      valuationSource: input.valuationSource?.trim() || null,
      notes: input.notes?.trim() || null,
      isActive: true,
    };

    const result = await db.transaction(async (tx) => {
      const [created] = await tx.insert(properties).values(newProperty).returning({ id: properties.id });

      if (linkedLiabilityAccountIds.length > 0) {
        await tx.insert(propertyLiabilityLinks).values(
          linkedLiabilityAccountIds.map((accountId) => ({
            userId,
            propertyId: created.id,
            accountId,
          })),
        );
      }

      const valuation = buildValuationSnapshot(userId, created.id, input);
      if (valuation) {
        await tx.insert(propertyValuations).values(valuation);
      }

      return created;
    });

    revalidatePropertyPaths(result.id);
    return { success: true, propertyId: result.id };
  } catch (error) {
    console.error("Failed to create property:", error);
    return { success: false, error: "Failed to create property" };
  }
}

export async function updateProperty(
  propertyId: string,
  input: Partial<CreatePropertyInput>
): Promise<{ success: boolean; error?: string }> {
  const userId = await requireAuth();

  if (!userId) {
    return { success: false, error: "Not authenticated" };
  }

  try {
    const linkedLiabilityAccountIds = normalizeLinkedLiabilityIds(input.linkedLiabilityAccountIds);
    const validation = await validateLinkedLiabilityAccounts(userId, linkedLiabilityAccountIds, propertyId);
    if (!validation.success) {
      return { success: false, error: validation.error };
    }

    const property = await db.query.properties.findFirst({
      where: and(eq(properties.id, propertyId), eq(properties.userId, userId)),
    });

    if (!property) {
      return { success: false, error: "Property not found" };
    }

    await db.transaction(async (tx) => {
      await tx
        .update(properties)
        .set({
          name: input.name,
          propertyType: input.propertyType,
          address: input.address,
          currentValue: input.currentValue?.toString(),
          currency: input.currency,
          isRental: input.isRental,
          valuationDate: input.valuationDate,
          valuationSource: input.valuationSource?.trim() || null,
          notes: input.notes?.trim() || null,
          updatedAt: new Date(),
        })
        .where(eq(properties.id, propertyId));

      if (input.linkedLiabilityAccountIds !== undefined) {
        await tx
          .delete(propertyLiabilityLinks)
          .where(and(
            eq(propertyLiabilityLinks.propertyId, propertyId),
            eq(propertyLiabilityLinks.userId, userId),
          ));

        if (linkedLiabilityAccountIds.length > 0) {
          await tx.insert(propertyLiabilityLinks).values(
            linkedLiabilityAccountIds.map((accountId) => ({
              userId,
              propertyId,
              accountId,
            })),
          );
        }
      }

      const valuation = buildValuationSnapshot(userId, propertyId, {
        ...input,
        currency: input.currency || property.currency || "EUR",
      });
      if (valuation) {
        await tx.insert(propertyValuations).values(valuation);
      }
    });

    revalidatePropertyPaths(propertyId);
    return { success: true };
  } catch (error) {
    console.error("Failed to update property:", error);
    return { success: false, error: "Failed to update property" };
  }
}

export async function deleteProperty(
  propertyId: string
): Promise<{ success: boolean; error?: string }> {
  const userId = await requireAuth();

  if (!userId) {
    return { success: false, error: "Not authenticated" };
  }

  try {
    const property = await db.query.properties.findFirst({
      where: and(eq(properties.id, propertyId), eq(properties.userId, userId)),
    });

    if (!property) {
      return { success: false, error: "Property not found" };
    }

    // Soft delete by setting isActive to false
    await db
      .update(properties)
      .set({
        isActive: false,
        updatedAt: new Date(),
      })
      .where(eq(properties.id, propertyId));

    revalidatePropertyPaths(propertyId);
    return { success: true };
  } catch (error) {
    console.error("Failed to delete property:", error);
    return { success: false, error: "Failed to delete property" };
  }
}

export async function getProperties() {
  const userId = await requireAuth();

  if (!userId) {
    return [];
  }

  return db.query.properties.findMany({
    where: and(eq(properties.userId, userId), eq(properties.isActive, true)),
    orderBy: (properties, { asc }) => [asc(properties.name)],
  });
}

export async function getProperty(propertyId: string) {
  const userId = await requireAuth();

  if (!userId) {
    return null;
  }

  return db.query.properties.findFirst({
    where: and(
      eq(properties.id, propertyId),
      eq(properties.userId, userId),
      eq(properties.isActive, true)
    ),
  });
}

export async function getPropertyLiabilityLinks(propertyIds?: string[]) {
  const userId = await requireAuth();

  if (!userId) {
    return [];
  }

  const conditions = [eq(propertyLiabilityLinks.userId, userId)];
  if (propertyIds && propertyIds.length > 0) {
    conditions.push(inArray(propertyLiabilityLinks.propertyId, propertyIds));
  }

  return db
    .select()
    .from(propertyLiabilityLinks)
    .where(and(...conditions));
}

export async function getPropertyValuations(propertyIds?: string[]) {
  const userId = await requireAuth();

  if (!userId) {
    return [];
  }

  const conditions = [eq(propertyValuations.userId, userId)];
  if (propertyIds && propertyIds.length > 0) {
    conditions.push(inArray(propertyValuations.propertyId, propertyIds));
  }

  return db
    .select()
    .from(propertyValuations)
    .where(and(...conditions))
    .orderBy(desc(propertyValuations.valuationDate), desc(propertyValuations.createdAt));
}

export interface PropertyTaxYearSummary {
  propertyId: string;
  taxYearStart: string;
  taxYearEnd: string;
  rentReceived: number;
  expenses: { categoryId: string | null; categoryName: string; amount: number }[];
}

export interface PropertyTaggedTransaction {
  id: string;
  bookedAt: Date;
  description: string | null;
  merchant: string | null;
  transactionType: string | null;
  amount: number;
  currency: string | null;
  categoryName: string;
  accountName: string | null;
}

export async function getPropertyTaggedTransactions(
  propertyId: string,
  limit = 50,
): Promise<PropertyTaggedTransaction[]> {
  const userId = await requireAuth();

  if (!userId) {
    return [];
  }

  const property = await db.query.properties.findFirst({
    where: and(
      eq(properties.id, propertyId),
      eq(properties.userId, userId),
      eq(properties.isActive, true),
    ),
  });

  if (!property) {
    return [];
  }

  const rows = await db
    .select({
      id: transactions.id,
      bookedAt: transactions.bookedAt,
      description: transactions.description,
      merchant: transactions.merchant,
      transactionType: transactions.transactionType,
      amount: transactions.amount,
      functionalAmount: transactions.functionalAmount,
      currency: transactions.currency,
      categoryName: sql<string>`COALESCE(${categories.name}, 'Uncategorized')`,
      accountName: accounts.name,
    })
    .from(transactions)
    .innerJoin(accounts, eq(accounts.id, transactions.accountId))
    .leftJoin(
      categories,
      sql`${categories.id} = COALESCE(${transactions.categoryId}, ${transactions.categorySystemId})`,
    )
    .where(and(
      eq(transactions.userId, userId),
      eq(transactions.propertyId, propertyId),
    ))
    .orderBy(desc(transactions.bookedAt))
    .limit(limit);

  return rows.map((row) => ({
    id: row.id,
    bookedAt: row.bookedAt,
    description: row.description,
    merchant: row.merchant,
    transactionType: row.transactionType,
    amount: parseFloat(row.functionalAmount || row.amount || "0"),
    currency: row.currency,
    categoryName: row.categoryName,
    accountName: row.accountName,
  }));
}

export async function getPropertyTaxYearSummary(
  propertyId: string,
  financialYearStartYear: number,
): Promise<{ success: true; summary: PropertyTaxYearSummary } | { success: false; error: string }> {
  const userId = await requireAuth();

  if (!userId) {
    return { success: false, error: "Not authenticated" };
  }

  const property = await db.query.properties.findFirst({
    where: and(
      eq(properties.id, propertyId),
      eq(properties.userId, userId),
      eq(properties.isActive, true),
    ),
  });

  if (!property) {
    return { success: false, error: "Property not found" };
  }

  const range = getAustralianFinancialYearRange(financialYearStartYear);
  const { start: rangeStart, end: rangeEnd } = getAustralianFinancialYearUtcInterval(financialYearStartYear);

  const rows = await db
    .select({
      categoryId: sql<string | null>`COALESCE(${transactions.categoryId}, ${transactions.categorySystemId})`,
      categoryName: sql<string>`COALESCE(${categories.name}, 'Uncategorized')`,
      categoryType: categories.categoryType,
      incomeAmount: sql<string>`COALESCE(SUM(CASE WHEN ${transactions.transactionType} = 'credit' THEN ABS(COALESCE(${transactions.functionalAmount}, ${transactions.amount})) ELSE 0 END), 0)`,
      expenseAmount: sql<string>`COALESCE(SUM(CASE WHEN ${transactions.transactionType} = 'debit' THEN ABS(COALESCE(${transactions.functionalAmount}, ${transactions.amount})) ELSE 0 END), 0)`,
    })
    .from(transactions)
    .leftJoin(
      categories,
      sql`${categories.id} = COALESCE(${transactions.categoryId}, ${transactions.categorySystemId})`,
    )
    .where(and(
      eq(transactions.userId, userId),
      eq(transactions.propertyId, propertyId),
      eq(transactions.includeInAnalytics, true),
      gte(transactions.bookedAt, rangeStart),
      lte(transactions.bookedAt, rangeEnd),
    ))
    .groupBy(
      sql`COALESCE(${transactions.categoryId}, ${transactions.categorySystemId})`,
      categories.name,
      categories.categoryType,
    );

  const rentReceived = rows.reduce((sum, row) => sum + parseFloat(row.incomeAmount || "0"), 0);
  const expenses = rows
    .map((row) => ({
      categoryId: row.categoryId,
      categoryName: row.categoryName,
      amount: parseFloat(row.expenseAmount || "0"),
    }))
    .filter((row) => row.amount > 0)
    .sort((a, b) => b.amount - a.amount);

  return {
    success: true,
    summary: {
      propertyId,
      taxYearStart: range.startDate,
      taxYearEnd: range.endDate,
      rentReceived,
      expenses,
    },
  };
}
