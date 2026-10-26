import { getTableName, sql, type SQL, type SQLWrapper } from "drizzle-orm";
import type { AnyPgColumn } from "drizzle-orm/pg-core";

export type OwnershipScope = string | { userId: string | SQL; householdPersonId?: string | null };

/** Preserve the outer qualification inside subqueries. Drizzle strips column
 * qualifications in single-table selections, where an inner `id` can shadow it.
 */
function qualified(value: SQLWrapper): SQLWrapper {
  if ("table" in value && "name" in value) {
    const column = value as AnyPgColumn;
    return sql`${sql.identifier(getTableName(column.table))}.${sql.identifier(column.name)}`;
  }
  return value;
}

function ownershipIdentitiesSql(scope: OwnershipScope) {
  if (typeof scope !== "string") return sql`SELECT identity.id FROM people identity
    WHERE (identity.user_id = ${scope.userId} AND identity.kind = 'self')
      OR identity.linked_user_id = ${scope.userId}
      OR identity.id = ${scope.householdPersonId ?? null}
      OR identity.id IN (SELECT person_id FROM household_memberships WHERE member_user_id = ${scope.userId})`;
  const login = sql`SELECT coalesce(CASE WHEN selected.kind='self' THEN selected.user_id ELSE selected.linked_user_id END,
    (SELECT member_user_id FROM household_memberships WHERE person_id=selected.id)) FROM people selected WHERE selected.id=${scope}`;
  return sql`SELECT identity.id FROM people identity WHERE identity.id=${scope}
    OR identity.linked_user_id=(${login}) OR (identity.kind='self' AND identity.user_id=(${login}))`;
}

/** All three entity types use the same dated complete-set rule. Ownership never
 * substitutes for the caller's separate access predicate.
 */
function entityOwnershipShareSql(entity: "account" | "property" | "vehicle", scope: OwnershipScope | undefined,
  entityReference: SQLWrapper, asOf: SQLWrapper): SQL<unknown> {
  if (!scope) return sql`1`;
  const id = qualified(entityReference);
  const when = qualified(asOf);
  const field = `${entity}_id`;
  const history = sql.identifier(`${entity}_ownership_allocations`);
  const legacy = sql.identifier(`${entity}_owners`);
  const resource = sql.identifier(entity === "property" ? "properties" : `${entity}s`);
  const column = (alias: string) => sql`${sql.identifier(alias)}.${sql.identifier(field)}`;
  const identities = ownershipIdentitiesSql(scope);
  const defaultOwner = typeof scope === "string"
    ? sql`EXISTS(SELECT 1 FROM ${resource} owned JOIN people person ON person.user_id=owned.user_id
        WHERE owned.id=${id} AND person.id IN (${identities}) AND person.kind='self')`
    : sql`EXISTS(SELECT 1 FROM ${resource} owned WHERE owned.id=${id} AND owned.user_id=${scope.userId})`;
  return sql`CASE WHEN EXISTS(SELECT 1 FROM ${history} history WHERE ${column("history")}=${id})
    THEN coalesce((SELECT sum(allocation.share) FROM ${history} allocation
      WHERE ${column("allocation")}=${id} AND allocation.person_id IN (${identities})
        AND allocation.effective_from=(SELECT max(latest.effective_from) FROM ${history} latest
          WHERE ${column("latest")}=${id} AND latest.effective_from<=(${when})::date)),0)
    WHEN EXISTS(SELECT 1 FROM ${legacy} legacy WHERE ${column("legacy")}=${id})
    THEN coalesce((SELECT sum(coalesce(owner.share,1.0/(SELECT count(*) FROM ${legacy} peers WHERE ${column("peers")}=${id})))
      FROM ${legacy} owner WHERE ${column("owner")}=${id} AND owner.person_id IN (${identities})),0)
    ELSE CASE WHEN ${defaultOwner} THEN 1 ELSE 0 END END`;
}

export function ownershipShareSql(scope: OwnershipScope | undefined, id: SQLWrapper, asOf: SQLWrapper) {
  return entityOwnershipShareSql("account", scope, id, asOf);
}
export function propertyOwnershipShareSql(scope: OwnershipScope | undefined, id: SQLWrapper, asOf: SQLWrapper = sql`CURRENT_DATE`) {
  return entityOwnershipShareSql("property", scope, id, asOf);
}
export function vehicleOwnershipShareSql(scope: OwnershipScope | undefined, id: SQLWrapper, asOf: SQLWrapper = sql`CURRENT_DATE`) {
  return entityOwnershipShareSql("vehicle", scope, id, asOf);
}
