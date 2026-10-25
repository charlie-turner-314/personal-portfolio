import { and, eq } from "drizzle-orm";
import { accounts, householdAccountShares, householdNetWorthShares, users } from "@/lib/db/schema";
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
    await tx.delete(householdAccountShares).where(eq(householdAccountShares.accountId, accountId));
    if (targets.length) await tx.insert(householdAccountShares).values(targets.map((memberUserId) => ({
      accountId, memberUserId, grantedByUserId: actorUserId,
    })));
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
