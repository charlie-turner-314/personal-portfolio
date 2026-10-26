import { db } from "@/lib/db";
import {
  people,
  accountOwners,
  propertyOwners,
  vehicleOwners,
  users,
} from "@/lib/db/schema";
import { eq, and, inArray, sql } from "drizzle-orm";

import { ownershipShareSql, propertyOwnershipShareSql, vehicleOwnershipShareSql } from "./ownership-sql";

export type EntityType = "account" | "property" | "vehicle";

export async function getPeople(userId: string) {
  return db
    .select()
    .from(people)
    .where(eq(people.userId, userId))
    .orderBy(people.kind, people.createdAt);
}

export async function getSelfPersonId(userId: string): Promise<string> {
  // Try fetch first
  const [existing] = await db
    .select({ id: people.id })
    .from(people)
    .where(and(eq(people.userId, userId), eq(people.kind, "self")))
    .limit(1);
  if (existing) return existing.id;

  // Auto-create. The partial unique index prevents duplicates if two requests race.
  const [user] = await db.select({ name: users.name }).from(users).where(eq(users.id, userId)).limit(1);
  const displayName = (user?.name && user.name.trim()) || "You";
  try {
    const [created] = await db.insert(people).values({
      userId, name: displayName, kind: "self",
    }).returning();
    return created.id;
  } catch {
    // Race: another request created it concurrently. Fetch again.
    const [retry] = await db
      .select({ id: people.id })
      .from(people)
      .where(and(eq(people.userId, userId), eq(people.kind, "self")))
      .limit(1);
    if (!retry) throw new Error(`failed to ensure self person for ${userId}`);
    return retry.id;
  }
}

export async function getOwners(entityType: EntityType, entityId: string, asOf?: string) {
  return (await getOwnersForEntities(entityType, [entityId], asOf)).get(entityId) ?? [];
}

/** Resolve the latest complete set for every entity at the requested date. */
export async function getOwnersForEntities(entityType: EntityType, entityIds: string[], asOf?: string): Promise<Map<string, { personId: string; share: number | null }[]>> {
  const out = new Map<string, { personId: string; share: number | null }[]>();
  if (!entityIds.length) return out;
  const history = sql.identifier(`${entityType}_ownership_allocations`);
  const legacy = sql.identifier(`${entityType}_owners`);
  const resource = sql.identifier(entityType === "property" ? "properties" : `${entityType}s`);
  const field = (alias: string) => sql`${sql.identifier(alias)}.${sql.identifier(`${entityType}_id`)}`;
  const ids = sql.join(entityIds.map(id => sql`${id}::uuid`), sql`, `);
  const when = asOf ? sql`${asOf}::date` : sql`CURRENT_DATE`;
  const rows = await db.execute(sql`SELECT ${field("history")}::text AS entity_id, history.person_id::text, history.share::text
    FROM ${history} history WHERE ${field("history")} IN (${ids}) AND history.effective_from=(
      SELECT max(latest.effective_from) FROM ${history} latest WHERE ${field("latest")}=${field("history")} AND latest.effective_from<=${when})
    UNION ALL
    SELECT ${field("legacy")}::text, legacy.person_id::text,
      coalesce(legacy.share,1.0/(SELECT count(*) FROM ${legacy} peers WHERE ${field("peers")}=${field("legacy")}))::text
    FROM ${legacy} legacy WHERE ${field("legacy")} IN (${ids})
      AND NOT EXISTS(SELECT 1 FROM ${history} history WHERE ${field("history")}=${field("legacy")})
    UNION ALL
    SELECT owned.id::text,person.id::text,'1' FROM ${resource} owned JOIN people person ON person.user_id=owned.user_id AND person.kind='self'
    WHERE owned.id IN (${ids}) AND NOT EXISTS(SELECT 1 FROM ${history} history WHERE ${field("history")}=owned.id)
      AND NOT EXISTS(SELECT 1 FROM ${legacy} legacy WHERE ${field("legacy")}=owned.id)
    ORDER BY entity_id,person_id`);
  for (const row of rows) {
    const id = String(row.entity_id);
    const owners = out.get(id) ?? [];
    owners.push({ personId: String(row.person_id), share: Number(row.share) });
    out.set(id, owners);
  }
  return out;
}

/** Returns the set of entity ids of `entityType` owned by ANY of `personIds`. */
export async function listEntityIdsForPeople(entityType: EntityType, personIds: string[], asOf?: string): Promise<string[]> {
  if (!personIds.length) return [];
  const resource = sql.identifier(entityType === "property" ? "properties" : `${entityType}s`);
  const resolver = entityType === "account" ? ownershipShareSql : entityType === "property" ? propertyOwnershipShareSql : vehicleOwnershipShareSql;
  const when = asOf ? sql`${asOf}::date` : sql`CURRENT_DATE`;
  const rows = await db.execute(sql`SELECT resource.id::text FROM ${resource} resource WHERE
    ${sql.join(personIds.map(personId => sql`(${resolver(personId,sql`resource.id`,when)}) > 0`),sql` OR `)}`);
  return rows.map(row=>String(row.id));
}
