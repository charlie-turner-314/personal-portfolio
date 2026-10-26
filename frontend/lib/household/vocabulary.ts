import { sql } from "drizzle-orm";
import type { HouseholdTransaction } from "./transaction";

/** Snapshot safe definition IDs before the membership graph changes. Private
 * guidance/activity is never copied, and every financial reference stays intact.
 */
export async function retainHouseholdVocabulary(tx: HouseholdTransaction, owner: string, destinations: string[]) {
  for (const destination of [...new Set([owner, ...destinations])]) {
    await tx.execute(sql`INSERT INTO category_vocabulary_entries(owner_user_id,category_id,hidden_from_selection)
      SELECT DISTINCT ${destination}, definition.id, coalesce((SELECT source_entry.hidden_from_selection FROM category_vocabulary_entries source_entry WHERE source_entry.category_id=definition.id AND source_entry.owner_user_id=${owner}),coalesce(definition.hide_from_selection,false)) FROM categories definition
      WHERE coalesce((SELECT owner_user_id FROM household_memberships WHERE member_user_id=definition.user_id), definition.user_id) = ${owner}
        OR EXISTS (SELECT 1 FROM category_vocabulary_entries entry
          WHERE entry.category_id=definition.id AND entry.owner_user_id=${owner})
      ON CONFLICT DO NOTHING`);
  }
}

export async function mergeVocabularyOnJoin(tx: HouseholdTransaction, actor: string, destination: string) {
  await retainHouseholdVocabulary(tx, actor, [destination]);
}
