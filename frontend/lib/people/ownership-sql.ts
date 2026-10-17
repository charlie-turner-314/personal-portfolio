import { sql, type SQL, type SQLWrapper } from "drizzle-orm";
import { accountOwnershipAllocations, accountOwners, accounts, people } from "@/lib/db/schema";

/** Resolve a complete dated set before looking up its member; removed owners get zero. */
export function ownershipShareSql(
  personId: string | undefined,
  accountId: SQLWrapper,
  asOf: SQLWrapper,
): SQL<unknown> {
  if (!personId) return sql`1`;
  return sql`CASE WHEN EXISTS (
    SELECT 1 FROM ${accountOwnershipAllocations} history WHERE history.account_id = ${accountId}
  ) THEN COALESCE((
    SELECT allocation.share FROM ${accountOwnershipAllocations} allocation
    WHERE allocation.account_id = ${accountId} AND allocation.person_id = ${personId}
      AND allocation.effective_from = (
        SELECT MAX(latest.effective_from) FROM ${accountOwnershipAllocations} latest
        WHERE latest.account_id = ${accountId} AND latest.effective_from <= (${asOf})::date
      )
  ), 0) WHEN EXISTS (
    SELECT 1 FROM ${accountOwners} legacy WHERE legacy.account_id = ${accountId}
  ) THEN COALESCE((
    SELECT COALESCE(owner.share, 1.0 / (SELECT COUNT(*) FROM ${accountOwners} members WHERE members.account_id = ${accountId}))
    FROM ${accountOwners} owner WHERE owner.account_id = ${accountId} AND owner.person_id = ${personId}
  ), 0) ELSE CASE WHEN EXISTS (
    SELECT 1 FROM ${accounts} owned JOIN ${people} person ON person.user_id = owned.user_id
    WHERE owned.id = ${accountId} AND person.id = ${personId} AND person.kind = 'self'
  ) THEN 1 ELSE 0 END END`;
}
