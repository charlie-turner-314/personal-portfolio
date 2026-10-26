import { sql, type SQL } from "drizzle-orm";
import { categories, type Category } from "@/lib/db/schema";
import { sameHousehold } from "./account-access";

/** Definitions only: financial activity always needs its own account predicate.
 * Retained classifications remain usable after an account leaves a household.
 * Never infer category equivalence from names.
 */
export function categoryAccess(actorUserId: string): SQL {
  return sql`(${sameHousehold(categories.userId, actorUserId)} OR EXISTS (
    SELECT 1 FROM category_vocabulary_entries vocabulary_entry
    WHERE vocabulary_entry.category_id = ${categories.id}
      AND vocabulary_entry.owner_user_id = coalesce(
        (SELECT owner_user_id FROM household_memberships WHERE member_user_id = ${actorUserId}), ${actorUserId})
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
