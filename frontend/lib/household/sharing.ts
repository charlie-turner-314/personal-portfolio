import { and, eq, sql } from "drizzle-orm";
import { accounts, upAccountSources, properties, householdPropertyShares, householdAccountShares, householdNetWorthShares, users } from "@/lib/db/schema";
import { householdTransaction } from "./invitations";
import { sameHousehold } from "./account-access";

/** Shared edits do not include changing someone else's consent. */
export async function setAccountSharing(actorUserId: string, accountId: string, memberUserIds: string[]) {
  const targets = [...new Set(memberUserIds)];
  if (targets.length > 100) throw new Error("Choose fewer household members");
  return householdTransaction(async (tx) => {
    const [account] = await tx.select({ id: accounts.id }).from(accounts)
      .where(and(eq(accounts.id, accountId), eq(accounts.userId, actorUserId))).for("update");
    if (!account) throw new Error("Only the account owner can change sharing");
    for (const memberUserId of targets) {
      if (memberUserId === actorUserId) throw new Error("Choose another household member");
      const [member] = await tx.select({ id: users.id }).from(users)
        .where(and(eq(users.id, memberUserId), sameHousehold(actorUserId, memberUserId)));
      if (!member) throw new Error("Choose a current household member");
    }
    await tx.delete(upAccountSources).where(and(eq(upAccountSources.accountId, accountId),
      sql`${upAccountSources.connectionId} IN (SELECT id FROM bank_connections
        WHERE user_id <> ${actorUserId} ${targets.length ? sql`AND user_id NOT IN (${sql.join(targets.map(id => sql`${id}`), sql`, `)})` : sql``})`));
    await tx.delete(householdAccountShares).where(eq(householdAccountShares.accountId, accountId));
    if (targets.length) await tx.insert(householdAccountShares).values(targets.map((memberUserId) => ({
      accountId, memberUserId, grantedByUserId: actorUserId,
    })));
  });
}

/** Mortgage access remains a separate explicit account grant. */
export async function setPropertySharing(actorUserId: string, propertyId: string, memberUserIds: string[]) {
  const targets = [...new Set(memberUserIds)];
  if (targets.length > 100) throw new Error("Choose fewer household members");
  return householdTransaction(async tx => {
    const [property] = await tx.select({ id: properties.id }).from(properties)
      .where(and(eq(properties.id, propertyId), eq(properties.userId, actorUserId), eq(properties.isActive, true))).for("update");
    if (!property) throw new Error("Only the property owner can change sharing");
    for (const memberUserId of targets) {
      if (memberUserId === actorUserId) throw new Error("Choose another household member");
      const [member] = await tx.select({ id: users.id }).from(users)
        .where(and(eq(users.id, memberUserId), sameHousehold(actorUserId, memberUserId)));
      if (!member) throw new Error("Choose a current household member");
    }
    await tx.delete(householdPropertyShares).where(eq(householdPropertyShares.propertyId, propertyId));
    if (targets.length) await tx.insert(householdPropertyShares).values(targets.map(memberUserId => ({ propertyId, memberUserId, grantedByUserId: actorUserId })));
  });
}

export async function setNetWorthSharing(actorUserId: string, memberUserIds: string[]) {
  const targets = [...new Set(memberUserIds)];
  if (targets.length > 100) throw new Error("Choose fewer household members");
  return householdTransaction(async (tx) => {
    for (const memberUserId of targets) {
      if (memberUserId === actorUserId) throw new Error("Choose another household member");
      const [member] = await tx.select({ id: users.id }).from(users)
        .where(and(eq(users.id, memberUserId), sameHousehold(actorUserId, memberUserId)));
      if (!member) throw new Error("Choose a current household member");
    }
    await tx.delete(householdNetWorthShares).where(eq(householdNetWorthShares.ownerUserId, actorUserId));
    if (targets.length) await tx.insert(householdNetWorthShares).values(targets.map((memberUserId) => ({ ownerUserId: actorUserId, memberUserId })));
  });
}
