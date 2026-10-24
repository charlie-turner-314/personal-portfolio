import { and, eq, isNull, or, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { householdInvitations, householdMemberships, householdAccountShares, householdNetWorthShares, people, users } from "@/lib/db/schema";
import { assertInvitationAcceptable, hashInvitationToken, INVITATION_LIFETIME_MS, newInvitationToken, normalizeInvitationEmail } from "./invitation-policy";

// Serialize household graph changes, including reciprocal invites/acceptance.
// The transaction-scoped lock is released on both success and rollback.
export async function householdTransaction<T>(work: (tx: Parameters<Parameters<typeof db.transaction>[0]>[0]) => Promise<T>) {
  return db.transaction(async (tx) => {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(73194, 1)`);
    return work(tx);
  });
}

export async function createHouseholdInvitation(actorUserId: string, personId: string, email: string) {
  const normalizedEmail = normalizeInvitationEmail(email);
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalizedEmail) || normalizedEmail.length > 320) throw new Error("Enter a valid email address");
  return householdTransaction(async (tx) => {
    const [member] = await tx.select().from(householdMemberships).where(eq(householdMemberships.memberUserId, actorUserId));
    if (member) throw new Error("Only the household owner can invite members");
    const [person] = await tx.select().from(people).where(and(eq(people.id, personId), eq(people.userId, actorUserId)));
    if (!person || person.kind !== "member") throw new Error("Choose a household placeholder");
    const [linked] = await tx.select().from(householdMemberships).where(eq(householdMemberships.personId, personId));
    if (linked) throw new Error("This person already has a linked login");
    const [actor] = await tx.select().from(users).where(eq(users.id, actorUserId));
    if (!actor || normalizeInvitationEmail(actor.email) === normalizedEmail) throw new Error("Invite another person's email address");
    await tx.update(householdInvitations).set({ consumedAt: new Date() }).where(and(eq(householdInvitations.personId, personId), isNull(householdInvitations.consumedAt)));
    const { token, tokenHash } = newInvitationToken();
    const expiresAt = new Date(Date.now() + INVITATION_LIFETIME_MS);
    const [invitation] = await tx.insert(householdInvitations).values({ ownerUserId: actorUserId, personId, email: normalizedEmail, tokenHash, expiresAt }).returning({ id: householdInvitations.id });
    return { ...invitation, token, expiresAt };
  });
}

export async function acceptHouseholdInvitation(actorUserId: string, token: string) {
  const tokenHash = hashInvitationToken(token);
  return householdTransaction(async (tx) => {
    const [invitation] = await tx.select().from(householdInvitations).where(eq(householdInvitations.tokenHash, tokenHash));
    if (!invitation) throw new Error("Invitation not found");
    // Read the email from the database, not a caller-supplied field or stale cookie.
    const [actor] = await tx.select().from(users).where(eq(users.id, actorUserId));
    if (!actor || actor.banned) throw new Error("An active login is required");
    assertInvitationAcceptable(invitation, actor.email);
    if (actorUserId === invitation.ownerUserId) throw new Error("You already own this household");
    const memberships = await tx.select().from(householdMemberships);
    if (memberships.some((m) => m.memberUserId === actorUserId)) throw new Error("Leave your current household before joining another");
    if (memberships.some((m) => m.ownerUserId === actorUserId)) throw new Error("Remove members from your own household before joining another");
    if (memberships.some((m) => m.memberUserId === invitation.ownerUserId)) throw new Error("This invitation is no longer available");
    if (memberships.some((m) => m.personId === invitation.personId)) throw new Error("This person already has a linked login");
    const [person] = await tx.select().from(people).where(and(eq(people.id, invitation.personId), eq(people.userId, invitation.ownerUserId), eq(people.kind, "member")));
    if (!person) throw new Error("This household person is no longer available");
    await tx.update(people).set({ linkedUserId: actorUserId }).where(eq(people.id, person.id));
    await tx.insert(householdMemberships).values({ memberUserId: actorUserId, ownerUserId: invitation.ownerUserId, personId: invitation.personId });
    await tx.update(householdInvitations).set({ consumedAt: new Date() }).where(eq(householdInvitations.id, invitation.id));
    // Joining cannot leave outstanding invitations capable of creating nested households.
    await tx.update(householdInvitations).set({ consumedAt: new Date() }).where(and(eq(householdInvitations.ownerUserId, actorUserId), isNull(householdInvitations.consumedAt)));
    return { personId: person.id, ownerUserId: invitation.ownerUserId };
  });
}

/** Remove both directions so leaving/rejoining can never reactivate old consent. */
async function clearFinancialShares(tx: Parameters<Parameters<typeof db.transaction>[0]>[0], memberUserId: string) {
  await tx.delete(householdAccountShares).where(or(eq(householdAccountShares.memberUserId, memberUserId), eq(householdAccountShares.grantedByUserId, memberUserId)));
  await tx.delete(householdNetWorthShares).where(or(eq(householdNetWorthShares.memberUserId, memberUserId), eq(householdNetWorthShares.ownerUserId, memberUserId)));
}

export async function revokeHouseholdAccess(actorUserId: string, personId: string) {
  await householdTransaction(async (tx) => {
    const [person] = await tx.select().from(people).where(and(eq(people.id, personId), eq(people.userId, actorUserId)));
    if (!person || person.kind !== "member") throw new Error("Only the household owner can revoke access");
    const linked = await tx.select().from(householdMemberships).where(and(eq(householdMemberships.ownerUserId, actorUserId), eq(householdMemberships.personId, personId)));
    for (const member of linked) await clearFinancialShares(tx, member.memberUserId);
    await tx.delete(householdMemberships).where(and(eq(householdMemberships.ownerUserId, actorUserId), eq(householdMemberships.personId, personId)));
    await tx.update(householdInvitations).set({ consumedAt: new Date() }).where(and(eq(householdInvitations.ownerUserId, actorUserId), eq(householdInvitations.personId, personId), isNull(householdInvitations.consumedAt)));
  });
}

export async function leaveHousehold(actorUserId: string) {
  await householdTransaction(async (tx) => {
    await clearFinancialShares(tx, actorUserId);
    await tx.delete(householdMemberships).where(eq(householdMemberships.memberUserId, actorUserId));
  });
}
