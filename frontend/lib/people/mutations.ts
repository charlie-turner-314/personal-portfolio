import { db } from "@/lib/db";
import {
  people,
  accountOwners,
  propertyOwners,
  vehicleOwners,
  householdMemberships,
  accounts, properties, vehicles, accountOwnershipAllocations, propertyOwnershipAllocations, vehicleOwnershipAllocations,
} from "@/lib/db/schema";
import { eq, and, inArray, or, ne, sql } from "drizzle-orm";
import { getHouseholdAccess } from "@/lib/household/access";
import { validateOwners, type OwnerInput } from "./validation";
import type { EntityType } from "./queries";

export async function createPerson(input: {
  userId: string;
  name: string;
  color?: string;
  avatarPath?: string | null;
}) {
  const [row] = await db
    .insert(people)
    .values({
      userId: input.userId,
      name: input.name,
      color: input.color,
      avatarPath: input.avatarPath ?? null,
      kind: "member",
    })
    .returning();
  return row;
}

export async function updatePerson(input: {
  userId: string;
  id: string;
  name?: string;
  color?: string;
  avatarPath?: string | null; // pass undefined to leave unchanged, null to clear
}) {
  const [row] = await db
    .update(people)
    .set({
      ...(input.name !== undefined ? { name: input.name } : {}),
      ...(input.color !== undefined ? { color: input.color } : {}),
      ...(input.avatarPath !== undefined ? { avatarPath: input.avatarPath } : {}),
      updatedAt: new Date(),
    })
    .where(and(eq(people.id, input.id), eq(people.userId, input.userId)))
    .returning();
  return row;
}

export async function deletePerson(input: { userId: string; id: string }) {
  return db.transaction(async (tx) => {
    const [target] = await tx
      .select({ kind: people.kind, linkedUserId: people.linkedUserId })
      .from(people)
      .where(and(eq(people.id, input.id), eq(people.userId, input.userId))).for("update");
    if (!target) throw new Error("person not found");
    if (target.kind === "self") throw new Error("cannot delete the self person");
    if (target.linkedUserId) {
      throw Object.assign(new Error("Keep this linked person to preserve their login identity and ownership history"), { code: "LINKED_LOGIN" });
    }
    for (const history of [accountOwnershipAllocations, propertyOwnershipAllocations, vehicleOwnershipAllocations]) {
      const [reference] = await tx.select({ id: history.personId }).from(history).where(eq(history.personId, input.id)).limit(1);
      if (reference) throw Object.assign(new Error("Keep this person to preserve dated ownership history"), { code: "OWNERSHIP_HISTORY" });
    }
    // Never disclose or cascade-delete another login's private ownership records.
    for (const [ownership, resource, idColumn] of [
      [accountOwners, accounts, accountOwners.accountId],
      [accountOwnershipAllocations, accounts, accountOwnershipAllocations.accountId],
      [propertyOwners, properties, propertyOwners.propertyId],
      [vehicleOwners, vehicles, vehicleOwners.vehicleId],
    ] as const) {
      const [privateReference] = await tx.select({ id: ownership.personId }).from(ownership)
        .innerJoin(resource, eq(resource.id, idColumn))
        .where(and(eq(ownership.personId, input.id), ne(resource.userId, input.userId))).limit(1);
      if (privateReference) throw Object.assign(new Error("Keep this person to preserve ownership history"), { code: "LINKED_LOGIN" });
    }


    const [linked] = await tx.select().from(householdMemberships).where(and(
      eq(householdMemberships.personId, input.id), eq(householdMemberships.ownerUserId, input.userId),
    ));
    if (linked) {
      const error = new Error("Revoke this person's login access before deleting them");
      Object.assign(error, { code: "LINKED_LOGIN" });
      throw error;
    }
    // Block delete if this person is the sole owner of any entity.
    const blockers: { entityType: EntityType; entityId: string }[] = [];

    for (const [entityType, table, idCol] of [
      ["account", accountOwners, accountOwners.accountId],
      ["property", propertyOwners, propertyOwners.propertyId],
      ["vehicle", vehicleOwners, vehicleOwners.vehicleId],
    ] as const) {
      const ownedRows = await tx
        .select({ id: idCol })
        .from(table)
        .where(eq(table.personId, input.id));
      for (const row of ownedRows) {
        const peers = await tx
          .select({ pid: table.personId, share: table.share })
          .from(table)
          .where(eq(idCol, row.id));
        if (peers.length === 1) {
          // Sole owner — cannot delete.
          blockers.push({ entityType, entityId: row.id });
          continue;
        }
        // If all owners have explicit shares, removing this person would leave the
        // remaining shares not summing to 1 — block the delete.
        const explicit = peers.filter((r) => r.share !== null);
        if (explicit.length === peers.length) {
          blockers.push({ entityType, entityId: row.id });
        }
      }
    }

    if (blockers.length > 0) {
      const err = new Error("person is sole owner or holds an explicit share that would leave others unbalanced");
      (err as any).blockers = blockers;
      (err as any).code = "SOLE_OWNER";
      throw err;
    }


    await tx.delete(people).where(eq(people.id, input.id));
  });
}

export async function setOwners(input: {
  userId: string;
  entityType: EntityType;
  entityId: string;
  owners: OwnerInput[];
  effectiveFrom?: string;
}) {
  validateOwners(input.owners);

  // Economic ownership can use the household roster or a retained personal identity.
  const access = await getHouseholdAccess(input.userId);
  const ownedPeople = await db
    .select({ id: people.id })
    .from(people)
    .where(
      and(
        or(eq(people.userId, input.userId), eq(people.userId, access.ownerUserId), eq(people.linkedUserId, input.userId)),
        inArray(
          people.id,
          input.owners.map((o) => o.personId)
        )
      )
    );
  if (ownedPeople.length !== input.owners.length) {
    throw new Error("one or more personIds do not belong to this user");
  }

  const entity = input.entityType;
  const field = sql.identifier(`${entity}_id`);
  const history = sql.identifier(`${entity}_ownership_allocations`);
  const resource = sql.identifier(entity === "property" ? "properties" : `${entity}s`);
  if (input.effectiveFrom && (!/^\d{4}-\d{2}-\d{2}$/.test(input.effectiveFrom)
    || input.effectiveFrom.startsWith("0000") || Number.isNaN(Date.parse(input.effectiveFrom))
    || new Date(`${input.effectiveFrom}T00:00:00Z`).toISOString().slice(0,10) !== input.effectiveFrom)) throw new Error("Choose a valid ownership effective date");
  await db.transaction(async tx => {
    const owned = await tx.execute(sql`SELECT id FROM ${resource} WHERE id=${input.entityId} AND user_id=${input.userId} FOR UPDATE`);
    if (!owned.length) throw new Error("Only the custodian can change economic ownership");
    const before = await tx.execute(sql`SELECT person_id,share,effective_from::text FROM ${history}
      WHERE ${field}=${input.entityId} ORDER BY effective_from,person_id`);
    let effectiveFrom = input.effectiveFrom;
    if (!effectiveFrom && before.length) {
      const current = await tx.execute(sql`SELECT person_id,share FROM ${history} WHERE ${field}=${input.entityId}
        AND effective_from=(SELECT max(effective_from) FROM ${history} WHERE ${field}=${input.entityId} AND effective_from<=CURRENT_DATE)`);
      const equal = 1 / input.owners.length;
      if (current.length === input.owners.length && input.owners.every(owner => current.some(row =>
        row.person_id === owner.personId && Math.abs(Number(row.share)-(owner.share ?? equal))<0.00000002))) return;
      throw new Error("Choose an effective date for the ownership change");
    }
    effectiveFrom ??= "0001-01-01";
    // Existing dated sets, including all earlier dates, remain intact. No
    // timeless ownership writer is allowed to supersede these dated facts.
    await tx.execute(sql`DELETE FROM ${history} WHERE ${field}=${input.entityId} AND effective_from=${effectiveFrom}::date`);
    const precision = entity === "account" ? 8 : 14;
    const unit = BigInt(10 ** precision);
    const allEqual = input.owners.every(owner => owner.share === null);
    const equalAtoms = unit / BigInt(input.owners.length);
    const atoms = input.owners.map((owner,index) => allEqual
      ? index === input.owners.length-1 ? unit-equalAtoms*BigInt(input.owners.length-1) : equalAtoms
      : BigInt(Math.round(Number(owner.share) * 10**precision)));
    if (atoms.reduce((sum,share) => sum+share,BigInt(0)) !== unit) throw new Error("Shares must sum exactly to one at the stored precision; use equal split for thirds");
    const resolvedOwners = input.owners.map((owner,index) => ({ personId: owner.personId,
      share: `${atoms[index]/unit}.${String(atoms[index]%unit).padStart(precision,"0")}` }));
    for (const owner of resolvedOwners) {
      await tx.execute(sql`INSERT INTO ${history}(${field},person_id,effective_from,share)
        VALUES (${input.entityId},${owner.personId},${effectiveFrom}::date,${owner.share})`);
    }
    await tx.execute(sql`INSERT INTO household_transition_events(actor_user_id,action,request_digest,preview)
      VALUES (${input.userId},${`ownership-${entity}`},'dated-ownership',${JSON.stringify({
        entityId: input.entityId, effectiveFrom, previousSets: before,
        owners: resolvedOwners, accessAndCustodyChanged: false,
      })}::jsonb)`);
  });
}
