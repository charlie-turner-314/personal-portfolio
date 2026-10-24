/** Bundle with esbuild and run only inside an isolated release-lab app container. */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { eq, inArray } from "drizzle-orm";
import { db } from "../lib/db";
import { accounts, accountOwners, householdInvitations, householdMemberships, people, users } from "../lib/db/schema";
import { createHouseholdInvitation, acceptHouseholdInvitation, revokeHouseholdAccess, leaveHousehold } from "../lib/household/invitations";
import { getHouseholdAccess } from "../lib/household/access";

async function main() {
  assert.equal(process.env.HOUSEHOLD_TEST_ISOLATED, "yes", "Run only in an explicitly isolated release lab");
  const ids = Array.from({ length: 4 }, () => `household-test-${randomUUID()}`);
  const [owner, member, stranger, otherOwner] = ids;
  const email = (id: string) => `${id}@example.test`;
  try {
    await db.insert(users).values(ids.map((id) => ({ id, email: email(id), name: id, onboardingStatus: "completed" })));
    const [person, secondPerson, otherPerson] = await db.insert(people).values([
      { userId: owner, name: "Existing partner", kind: "member" },
      { userId: owner, name: "Other partner", kind: "member" },
      { userId: otherOwner, name: "Other household person", kind: "member" },
    ]).returning();
    const [sharedAccount, privateAccount] = await db.insert(accounts).values([
      { userId: owner, name: "Shared historical account", accountType: "savings", currency: "AUD", startingBalance: "123.45" },
      { userId: member, name: "Preserved private account", accountType: "savings", currency: "AUD", startingBalance: "456.78" },
    ]).returning();
    await db.insert(accountOwners).values({ accountId: sharedAccount.id, personId: person.id, share: "1.0000" });
    const before = await db.select().from(accountOwners).where(eq(accountOwners.accountId, sharedAccount.id));
    await assert.rejects(createHouseholdInvitation(stranger, person.id, email(member)), /placeholder/);
    await assert.rejects(createHouseholdInvitation(owner, person.id, email(owner)), /another person's/);
    const invitation = await createHouseholdInvitation(owner, person.id, email(member));
    const [stored] = await db.select().from(householdInvitations).where(eq(householdInvitations.id, invitation.id));
    assert.notEqual(stored.tokenHash, invitation.token);
    await assert.rejects(acceptHouseholdInvitation(stranger, invitation.token), /email address/);
    const attempts = await Promise.allSettled([
      acceptHouseholdInvitation(member, invitation.token), acceptHouseholdInvitation(member, invitation.token),
    ]);
    assert.equal(attempts.filter((r) => r.status === "fulfilled").length, 1, "exactly one concurrent acceptance succeeds");
    assert.equal((await getHouseholdAccess(member)).ownerUserId, owner);
    assert.equal((await getHouseholdAccess(member)).personId, person.id);
    assert.equal((await getHouseholdAccess(stranger)).ownerUserId, stranger);
    assert.deepEqual(await db.select().from(accountOwners).where(eq(accountOwners.accountId, sharedAccount.id)), before);
    await assert.rejects(createHouseholdInvitation(member, otherPerson.id, email(stranger)), /Only the household owner/);
    await assert.rejects(createHouseholdInvitation(owner, person.id, email(stranger)), /already has a linked login/);
    const otherInvitation = await createHouseholdInvitation(otherOwner, otherPerson.id, email(member));
    await assert.rejects(acceptHouseholdInvitation(member, otherInvitation.token), /Leave your current household/);
    await assert.rejects(revokeHouseholdAccess(stranger, person.id), /Only the household owner/);
    await revokeHouseholdAccess(owner, person.id);
    assert.equal((await getHouseholdAccess(member)).ownerUserId, member);
    await assert.rejects(acceptHouseholdInvitation(member, invitation.token), /already used/);
    const expired = await createHouseholdInvitation(owner, person.id, email(member));
    await db.update(householdInvitations).set({ expiresAt: new Date(0) }).where(eq(householdInvitations.id, expired.id));
    await assert.rejects(acceptHouseholdInvitation(member, expired.token), /expired/);
    const revoked = await createHouseholdInvitation(owner, person.id, email(member));
    await revokeHouseholdAccess(owner, person.id);
    await assert.rejects(acceptHouseholdInvitation(member, revoked.token), /already used/);
    const superseded = await createHouseholdInvitation(owner, person.id, email(member));
    const latest = await createHouseholdInvitation(owner, person.id, email(member));
    await assert.rejects(acceptHouseholdInvitation(member, superseded.token), /already used/);
    await acceptHouseholdInvitation(member, latest.token);
    await leaveHousehold(member);
    assert.equal((await getHouseholdAccess(member)).ownerUserId, member);
    const [savedPrivate] = await db.select().from(accounts).where(eq(accounts.id, privateAccount.id));
    assert.equal(savedPrivate.userId, member);
    assert.equal(savedPrivate.startingBalance, "456.78");
    const reciprocal = await createHouseholdInvitation(otherOwner, otherPerson.id, email(owner));
    const forward = await createHouseholdInvitation(owner, secondPerson.id, email(otherOwner));
    await acceptHouseholdInvitation(otherOwner, forward.token);
    await assert.rejects(acceptHouseholdInvitation(owner, reciprocal.token), /already used|no longer available|Remove members/);
    await leaveHousehold(otherOwner);
    assert.deepEqual(await db.select().from(accountOwners).where(eq(accountOwners.accountId, sharedAccount.id)), before);
    console.log("PASS: real PostgreSQL invitation acceptance, concurrency, expiry, replay, revocation, leave, graph isolation and ownership preservation");
  } finally {
    await db.delete(householdMemberships).where(inArray(householdMemberships.ownerUserId, ids));
    await db.delete(householdInvitations).where(inArray(householdInvitations.ownerUserId, ids));
    await db.delete(users).where(inArray(users.id, ids));
  }
}
main().then(() => process.exit(0), () => { console.error("Household integration test failed; inspect restricted lab logs"); process.exit(1); });
