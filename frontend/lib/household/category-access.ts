import { sql, type SQL } from "drizzle-orm";
import { categories, type Category } from "@/lib/db/schema";
import { accountAccess, sameHousehold } from "./account-access";

/** Definitions only: financial activity always needs its own account predicate.
 * Retained classifications remain usable after an account leaves a household.
 * Never infer category equivalence from names.
 */
export function categoryAccess(actorUserId: string): SQL {
  return sql`(${sameHousehold(categories.userId, actorUserId)} OR EXISTS (
    SELECT 1 FROM transactions classified_transaction
    WHERE (${categories.id} = classified_transaction.category_id
      OR ${categories.id} = classified_transaction.category_system_id)
      AND ${accountAccess(sql`classified_transaction.account_id`, actorUserId)}
  ))`;
}

/** Shared vocabulary never carries the source user's private guidance or links. */
export function categoryDefinitionForActor(category: Category, actorUserId: string): Category {
  if (category.userId === actorUserId) return category;
  return {
    id: category.id,
    name: category.name,
    categoryType: category.categoryType,
    cashFlowKind: category.cashFlowKind,
    color: category.color,
    icon: category.icon,
    isSystem: category.isSystem,
    hideFromSelection: category.hideFromSelection,
    userId: "",
    parentId: null,
    description: null,
    categorizationInstructions: null,
    createdAt: null,
  };
}
