import { sql, type SQL, type SQLWrapper } from "drizzle-orm";
import { accountOwnershipAllocations, accountOwners, accounts, people, properties, propertyOwners } from "@/lib/db/schema";

export type OwnershipScope = string | { userId: string | SQL; householdPersonId?: string | null };

function ownershipIdentitiesSql(scope: OwnershipScope) {
  return typeof scope === "string"
    ? sql`SELECT identity.id FROM ${people} identity WHERE identity.id = ${scope}
        OR (identity.kind = 'self' AND identity.user_id IN (
          SELECT member_user_id FROM household_memberships WHERE person_id = ${scope}
        ))`
    : sql`SELECT identity.id FROM ${people} identity
        WHERE (identity.user_id = ${scope.userId} AND identity.kind = 'self')
          OR identity.linked_user_id = ${scope.userId}
          OR identity.id = ${scope.householdPersonId ?? null}
          OR identity.id IN (SELECT person_id FROM household_memberships WHERE member_user_id = ${scope.userId})`;
}

export function propertyOwnershipShareSql(scope: OwnershipScope | undefined, propertyId: SQLWrapper): SQL<unknown> {
  if (!scope) return sql`1`;
  const identities = ownershipIdentitiesSql(scope);
  const ownsUnallocatedProperty = typeof scope === "string"
    ? sql`EXISTS (SELECT 1 FROM ${properties} owned JOIN ${people} person ON person.user_id = owned.user_id
        WHERE owned.id = ${propertyId} AND person.id IN (${identities}) AND person.kind = 'self')`
    : sql`EXISTS (SELECT 1 FROM ${properties} owned WHERE owned.id = ${propertyId} AND owned.user_id = ${scope.userId})`;
  return sql`CASE WHEN EXISTS (SELECT 1 FROM ${propertyOwners} owners WHERE owners.property_id = ${propertyId})
    THEN COALESCE((SELECT SUM(COALESCE(owner.share, 1.0 / (SELECT COUNT(*) FROM ${propertyOwners} peers WHERE peers.property_id = ${propertyId})))
      FROM ${propertyOwners} owner WHERE owner.property_id = ${propertyId} AND owner.person_id IN (${identities})), 0)
    ELSE CASE WHEN ${ownsUnallocatedProperty} THEN 1 ELSE 0 END END`;
}

/** Resolve a complete dated set before looking up its member; removed owners get zero. */
export function ownershipShareSql(
  personId: OwnershipScope | undefined,
  accountId: SQLWrapper,
  asOf: SQLWrapper,
): SQL<unknown> {
  if (!personId) return sql`1`;
  const identities = ownershipIdentitiesSql(personId);
  const ownsUnallocatedAccount = typeof personId === "string"
    ? sql`EXISTS (SELECT 1 FROM ${accounts} owned JOIN ${people} person ON person.user_id = owned.user_id
        WHERE owned.id = ${accountId} AND person.id IN (${identities}) AND person.kind = 'self')`
    : sql`EXISTS (SELECT 1 FROM ${accounts} owned
        WHERE owned.id = ${accountId} AND owned.user_id = ${personId.userId})`;
  return sql`CASE WHEN EXISTS (
    SELECT 1 FROM ${accountOwnershipAllocations} history WHERE history.account_id = ${accountId}
  ) THEN COALESCE((
    SELECT SUM(allocation.share) FROM ${accountOwnershipAllocations} allocation
    WHERE allocation.account_id = ${accountId} AND allocation.person_id IN (${identities})
      AND allocation.effective_from = (
        SELECT MAX(latest.effective_from) FROM ${accountOwnershipAllocations} latest
        WHERE latest.account_id = ${accountId} AND latest.effective_from <= (${asOf})::date
      )
  ), 0) WHEN EXISTS (
    SELECT 1 FROM ${accountOwners} legacy WHERE legacy.account_id = ${accountId}
  ) THEN COALESCE((
    SELECT SUM(COALESCE(owner.share, 1.0 / (SELECT COUNT(*) FROM ${accountOwners} members WHERE members.account_id = ${accountId})))
    FROM ${accountOwners} owner WHERE owner.account_id = ${accountId} AND owner.person_id IN (${identities})
  ), 0) ELSE CASE WHEN ${ownsUnallocatedAccount} THEN 1 ELSE 0 END END`;
}
