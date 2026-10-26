"use server";

import { categoryAccess, categoryDefinitionForActor } from "@/lib/household/category-access";
import { accountAccess } from "@/lib/household/account-access";
import { revalidatePath, updateTag } from "next/cache";
import { eq, and, count, sql, asc } from "drizzle-orm";
import { db } from "@/lib/db";
import { categories, transactions, type Category, type NewCategory } from "@/lib/db/schema";
import { requireAuth } from "@/lib/household/financial-auth";
import { getCachedUserCategories, CACHE_TAGS } from "@/lib/data/cached";

export interface CategoryCreateInput {
  cashFlowKind?: "investment" | "loan_principal" | null;
  name: string;
  categoryType: "expense" | "income" | "transfer";
  color: string;
  icon: string;
  description?: string;
  categorizationInstructions?: string;
}

export interface CategoryInput {
  cashFlowKind?: "investment" | "loan_principal" | null;
  name: string;
  categoryType: "expense" | "income" | "transfer";
  color: string;
  icon: string;
  description?: string;
  categorizationInstructions?: string;
  isSystem?: boolean;
  hideFromSelection?: boolean;
}

export interface CategoryUpdateInput {
  cashFlowKind?: "investment" | "loan_principal" | null;
  name?: string;
  color?: string;
  icon?: string;
  description?: string;
  categorizationInstructions?: string;
}

export async function createCategory(
  input: CategoryCreateInput
): Promise<{ success: boolean; error?: string; categoryId?: string }> {
  const userId = await requireAuth();

  if (!userId) {
    return { success: false, error: "Not authenticated" };
  }

  if (input.cashFlowKind != null && !["investment", "loan_principal"].includes(input.cashFlowKind)) {
    return { success: false, error: "Invalid cash-flow purpose" };
  }
  if (input.cashFlowKind && input.categoryType !== "expense") return { success: false, error: "Only expense categories can default to allocations" };
  try {
    // Check for duplicate name in the same category type
    const existing = await db.query.categories.findFirst({
      where: and(
        eq(categories.userId, userId),
        eq(categories.name, input.name.trim()),
        eq(categories.categoryType, input.categoryType)
      ),
    });

    if (existing) {
      return { success: false, error: "A category with this name already exists" };
    }

    const newCategory: NewCategory = {
      userId,
      name: input.name.trim(),
      categoryType: input.categoryType,
      color: input.color,
      icon: input.icon,
      description: input.description?.trim() || null,
      categorizationInstructions: input.categorizationInstructions?.trim() || null,
      cashFlowKind: input.cashFlowKind ?? null,
      isSystem: false,
    };

    const [inserted] = await db.insert(categories).values(newCategory).returning({ id: categories.id });

    revalidatePath("/");
    revalidatePath("/settings");
    updateTag(CACHE_TAGS.categories(userId));
    return { success: true, categoryId: inserted.id };
  } catch (error) {
    console.error("Failed to create category:", error);
    return { success: false, error: "Failed to create category" };
  }
}

export async function updateCategory(
  categoryId: string,
  input: CategoryUpdateInput
): Promise<{ success: boolean; error?: string }> {
  const userId = await requireAuth();

  if (!userId) {
    return { success: false, error: "Not authenticated" };
  }

  try {
    // Get the existing category
    const existing = await db.query.categories.findFirst({
      where: and(
        eq(categories.id, categoryId),
        eq(categories.userId, userId)
      ),
    });

    if (!existing) {
      return { success: false, error: "Category not found" };
    }

    if (input.cashFlowKind != null && (!["investment", "loan_principal"].includes(input.cashFlowKind) || existing.categoryType !== "expense")) {
      return { success: false, error: "Invalid cash-flow purpose for this category" };
    }

    // System categories accept description/categorization_instructions updates
    // (user-tailored context) but reject structural changes.
    if (existing.isSystem) {
      const attemptingStructuralChange =
        (input.cashFlowKind !== undefined && input.cashFlowKind !== existing.cashFlowKind) ||
        (input.name !== undefined && input.name.trim() !== existing.name) ||
        (input.color !== undefined && input.color !== existing.color) ||
        (input.icon !== undefined && input.icon !== existing.icon);

      if (attemptingStructuralChange) {
        return {
          success: false,
          error: "System categories only allow editing description and categorization instructions",
        };
      }

      await db
        .update(categories)
        .set({
          ...(input.description !== undefined && { description: input.description?.trim() || null }),
          ...(input.categorizationInstructions !== undefined && {
            categorizationInstructions: input.categorizationInstructions?.trim() || null,
          }),
        })
        .where(eq(categories.id, categoryId));

      revalidatePath("/");
      revalidatePath("/settings");
      updateTag(CACHE_TAGS.categories(userId));
      return { success: true };
    }

    // Check for duplicate name if name is being changed
    if (input.name && input.name.trim() !== existing.name && existing.categoryType) {
      const duplicate = await db.query.categories.findFirst({
        where: and(
          eq(categories.userId, userId),
          eq(categories.name, input.name.trim()),
          eq(categories.categoryType, existing.categoryType)
        ),
      });

      if (duplicate) {
        return { success: false, error: "A category with this name already exists" };
      }
    }

    await db
      .update(categories)
      .set({
        ...(input.cashFlowKind !== undefined && { cashFlowKind: input.cashFlowKind }),
        ...(input.name && { name: input.name.trim() }),
        ...(input.color && { color: input.color }),
        ...(input.icon && { icon: input.icon }),
        ...(input.description !== undefined && { description: input.description?.trim() || null }),
        ...(input.categorizationInstructions !== undefined && {
          categorizationInstructions: input.categorizationInstructions?.trim() || null,
        }),
      })
      .where(eq(categories.id, categoryId));

    revalidatePath("/");
    revalidatePath("/settings");
    updateTag(CACHE_TAGS.categories(userId));
    return { success: true };
  } catch (error) {
    console.error("Failed to update category:", error);
    return { success: false, error: "Failed to update category" };
  }
}

/** Retiring a definition preserves every historical and planning reference. */
export async function deleteCategory(categoryId: string): Promise<{ success: boolean; error?: string }> {
  return deleteCategoryWithReassignment(categoryId, null);
}

export async function getCategories(): Promise<Category[]> {
  return getCachedUserCategories() as Promise<Category[]>;
}

/** Vocabulary definitions, independent of private category activity. */
export async function getReportingCategories() {
  const userId = await requireAuth();
  if (!userId) return [];
  return db.select({ id: categories.id, name: categories.name, color: categories.color,
    categoryType: categories.categoryType, cashFlowKind: categories.cashFlowKind }).from(categories)
    .where(categoryAccess(userId)).orderBy(asc(categories.name), asc(categories.id));
}

// Alias for backward compatibility
export const getUserCategories = getCategories;

export async function getCategoriesByType(
  type: "expense" | "income" | "transfer"
): Promise<Category[]> {
  const userId = await requireAuth();

  if (!userId) {
    return [];
  }

  const rows = await db.query.categories.findMany({
    where: and(
      categoryAccess(userId),
      eq(categories.categoryType, type)
    ),
    orderBy: (categories, { asc }) => [asc(categories.name), asc(categories.id)],
  });
  return rows.map(category => categoryDefinitionForActor(category, userId));
}

export async function getCategoryByName(name: string): Promise<Category | null> {
  const userId = await requireAuth();

  if (!userId) {
    return null;
  }

  const category = await db.query.categories.findFirst({
    where: and(
      categoryAccess(userId),
      eq(categories.name, name)
    ),
  });

  return category ? categoryDefinitionForActor(category, userId) : null;
}

/**
 * Get the count of transactions assigned to a category
 */
export async function getCategoryTransactionCount(
  categoryId: string
): Promise<{ count: number; error?: string }> {
  const userId = await requireAuth();

  if (!userId) {
    return { count: 0, error: "Not authenticated" };
  }

  try {
    const result = await db
      .select({ count: count() })
      .from(transactions)
      .where(
        and(
          accountAccess(transactions.accountId, userId),
          sql`COALESCE(${transactions.categoryId}, ${transactions.categorySystemId}) = ${categoryId}`
        )
      );

    return { count: result[0]?.count ?? 0 };
  } catch (error) {
    console.error("Failed to count category transactions:", error);
    return { count: 0, error: "Failed to count transactions" };
  }
}

/**
 * Delete a category with optional reassignment of transactions
 * @param categoryId - The category to delete
 * @param reassignToCategoryId - If provided, reassign transactions to this category; if null, set to uncategorized
 */
export async function deleteCategoryWithReassignment(
  categoryId: string,
  reassignToCategoryId: string | null
): Promise<{ success: boolean; error?: string; reassignedCount?: number }> {
  const userId = await requireAuth();
  if (!userId) return { success: false, error: "Not authenticated" };
  try {
    const reassignedCount = await db.transaction(async tx => {
      const [source] = await tx.select().from(categories).where(and(
        eq(categories.id, categoryId), eq(categories.userId, userId))).for("update");
      if (!source) throw new Error("Only the category creator can retire this definition");
      if (source.isSystem) throw new Error("System categories cannot be retired");
      let reassigned = 0;
      if (reassignToCategoryId && reassignToCategoryId !== categoryId) {
        const [target] = await tx.select().from(categories).where(and(
          eq(categories.id, reassignToCategoryId), categoryAccess(userId)));
        if (!target || target.categoryType !== source.categoryType || target.cashFlowKind !== source.cashFlowKind) {
          throw new Error("Choose a category with the same type and cash-flow purpose");
        }
        const changed = await tx.update(transactions).set({ categoryId: target.id, categoryVerifiedAt: new Date() })
          .where(and(accountAccess(transactions.accountId, userId),
            sql`COALESCE(${transactions.categoryId}, ${transactions.categorySystemId}) = ${source.id}`))
          .returning({ id: transactions.id });
        reassigned = changed.length;
      }
      await tx.update(categories).set({ hideFromSelection: true }).where(eq(categories.id, source.id));
      return reassigned;
    });
    revalidatePath("/"); revalidatePath("/settings"); revalidatePath("/transactions");
    updateTag(CACHE_TAGS.categories(userId));
    return { success: true, reassignedCount };
  } catch (error) {
    const message = error instanceof Error ? error.message : "";
    return { success: false, error: /^(Only |System |Choose )/.test(message) ? message : "Could not retire category" };
  }
}
