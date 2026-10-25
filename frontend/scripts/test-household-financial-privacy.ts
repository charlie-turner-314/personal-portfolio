/** Bundle and run against a disposable database in an isolated release lab. */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { eq, inArray } from "drizzle-orm";
import { db } from "../lib/db";
import { accounts, accountOwners, householdAccountShares, householdMemberships, householdNetWorthShares, householdPropertyShares, propertyOwners, people, transactions, users, properties, exchangeRates, transactionLinks, accountOwnershipAllocations, bankConnections, upAccountSources } from "../lib/db/schema";
import { deletePerson } from "../lib/people/mutations";
import { getVisibleNetWorthTotals } from "../lib/household/net-worth";
import { accountAccess, propertyAccess, transactionAccess } from "../lib/household/account-access";
import { setAccountSharing, setPropertySharing, setNetWorthSharing } from "../lib/household/sharing";
import { acceptHouseholdInvitation, createHouseholdInvitation, leaveHousehold, revokeHouseholdAccess } from "../lib/household/invitations";

async function main() {
  assert.equal(process.env.HOUSEHOLD_TEST_ISOLATED, "yes");
  assert.match(new URL(process.env.DATABASE_URL!).pathname, /^\/household_privacy_test_/);
  const ids = Array.from({ length: 5 }, () => `privacy-${randomUUID()}`);
  const [owner, member, third, stranger, otherOwner] = ids;
  const email = (id: string) => `${id}@example.test`;
  try {
    await db.insert(users).values(ids.map((id) => ({ id, email: email(id), name: id, functionalCurrency: "AUD" })));
    const [partner, housemate, outsider, ownerSelf] = await db.insert(people).values([
      { userId: owner, name: "Partner", kind: "member" },
      { userId: owner, name: "Housemate", kind: "member" },
      { userId: otherOwner, name: "Unrelated", kind: "member" },
      { userId: owner, name: "Owner self", kind: "self" },
    ]).returning();
    await db.insert(householdMemberships).values([
      { memberUserId: member, ownerUserId: owner, personId: partner.id },
      { memberUserId: third, ownerUserId: owner, personId: housemate.id },
      { memberUserId: stranger, ownerUserId: otherOwner, personId: outsider.id },
    ]);
    const [joint, ownerPrivate, memberPrivate, thirdPrivate] = await db.insert(accounts).values([
      { userId: owner, name: "Joint", accountType: "checking", currency: "AUD", functionalBalance: "1000" },
      { userId: owner, name: "Owner private", accountType: "checking", currency: "AUD", functionalBalance: "200" },
      { userId: member, name: "Member private", accountType: "checking", currency: "AUD", functionalBalance: "50" },
      { userId: third, name: "Third private", accountType: "checking", currency: "AUD" },
    ]).returning();
    await db.insert(accountOwners).values([
      { accountId: joint.id, personId: ownerSelf.id, share: "0.5" },
      { accountId: joint.id, personId: partner.id, share: "0.5" },
    ]);
    // Economic ownership must never grant data access by itself.
    await db.insert(accountOwners).values({ accountId: ownerPrivate.id, personId: partner.id, share: "0.5" });
    await db.insert(transactions).values([joint, ownerPrivate, memberPrivate, thirdPrivate].map((a) => ({
      userId: a.userId, accountId: a.id, amount: "10", currency: "AUD", bookedAt: new Date(), description: `${a.name} secret`,
    })));
    const visible = async (actor: string) => (await db.select({ id: accounts.id }).from(accounts).where(accountAccess(accounts.id, actor))).map((a) => a.id).sort();
    assert.deepEqual(await visible(member), [memberPrivate.id]);
    assert.deepEqual(await visible(third), [thirdPrivate.id]);
    await assert.rejects(setAccountSharing(member, joint.id, [third]), /Only the account owner/);
    await assert.rejects(setAccountSharing(owner, joint.id, [stranger]), /current household member/);
    await assert.rejects(setAccountSharing(owner, joint.id, [owner]), /another household member/);
    await setAccountSharing(owner, joint.id, [member, member]);
    assert.deepEqual(await visible(member), [joint.id, memberPrivate.id].sort());
    assert.deepEqual(await visible(third), [thirdPrivate.id]);
    assert.deepEqual(await visible(stranger), []);
    const txs = await db.select().from(transactions).where(accountAccess(transactions.accountId, member));
    assert.equal(txs.length, 2);
    assert.ok(txs.every((t) => t.accountId === joint.id || t.accountId === memberPrivate.id));
    const updated = await db.update(transactions).set({ description: "Shared edit" }).where(accountAccess(transactions.accountId, member)).returning();
    assert.equal(updated.length, 2);
    assert.equal((await db.select().from(transactions).where(eq(transactions.accountId, ownerPrivate.id)))[0].description, "Owner private secret");
    const [sharedTransaction] = await db.select().from(transactions).where(eq(transactions.accountId, joint.id));
    const [privateTransaction] = await db.select().from(transactions).where(eq(transactions.accountId, ownerPrivate.id));
    const groupId = randomUUID();
    await db.insert(transactionLinks).values([
      { userId: member, groupId, transactionId: sharedTransaction.id, linkRole: "primary" },
      { userId: member, groupId, transactionId: privateTransaction.id, linkRole: "reimbursement" },
    ]);
    const visibleLinks = await db.select().from(transactionLinks).where(transactionAccess(transactionLinks.transactionId, member));
    assert.equal(visibleLinks.length, 1, "creating a link never grants private counterpart access");
    assert.equal(visibleLinks[0].transactionId, sharedTransaction.id);
    const memberTotal = (await getVisibleNetWorthTotals(member)).find((t) => t.isOwn)!;
    assert.equal(Number(memberTotal.total), 550, "joint account counts only the member’s economic share");
    assert.equal((await getVisibleNetWorthTotals(owner)).length, 1, "net worth is private by default");
    await setNetWorthSharing(member, [owner]);
    const sharedTotal = (await getVisibleNetWorthTotals(owner)).find((t) => t.userId === member)!;
    assert.equal(Number(sharedTotal.total), 550);
    assert.deepEqual(Object.keys(sharedTotal).sort(), ["userId", "name", "currency", "total", "isOwn"].sort(), "aggregate sharing returns no account or transaction detail");
    assert.ok(!(await visible(owner)).includes(memberPrivate.id), "aggregate sharing never grants private account access");
    assert.equal((await getVisibleNetWorthTotals(third)).length, 1, "aggregate sharing is selective");
    // Member-to-owner sharing is symmetric, not an owner privilege.
    await setAccountSharing(member, memberPrivate.id, [owner]);
    assert.deepEqual(await visible(owner), [joint.id, ownerPrivate.id, memberPrivate.id].sort());
    await setNetWorthSharing(member, [owner]);
    await assert.rejects(setNetWorthSharing(member, [stranger]), /current household member/);
    const sources = await db.insert(bankConnections).values([
      { userId: owner, provider: "up", sessionId: randomUUID(), aspspName: "Up", aspspCountry: "AU", status: "active" },
      { userId: member, provider: "up", sessionId: randomUUID(), aspspName: "Up", aspspCountry: "AU", status: "active" },
    ]).returning();
    await db.insert(upAccountSources).values([
      { connectionId: sources[0].id, accountId: joint.id },
      { connectionId: sources[1].id, accountId: joint.id },
      { connectionId: sources[1].id, accountId: memberPrivate.id },
    ]);
    await setAccountSharing(owner, joint.id, []);
    assert.equal((await db.select().from(upAccountSources)).length, 2, "unsharing detaches only cross-login Up source");
    assert.deepEqual(await visible(member), [memberPrivate.id]);
    await setAccountSharing(owner, joint.id, [member]);
    await db.update(people).set({ linkedUserId: member }).where(eq(people.id, partner.id));
    await db.insert(accountOwners).values({ accountId: memberPrivate.id, personId: partner.id, share: "1" });
    const [retainedProperty] = await db.insert(properties).values({ userId: member, name: "Retained personal property", propertyType: "residential", currency: "AUD", currentValue: "99" }).returning();
    await db.insert(propertyOwners).values({ propertyId: retainedProperty.id, personId: partner.id, share: "1" });
    await db.insert(upAccountSources).values({ connectionId: sources[1].id, accountId: joint.id });
    await leaveHousehold(member);
    assert.equal((await db.select().from(upAccountSources)).length, 2, "leaving preserves each personal connection while removing shared sources");
    assert.deepEqual(await visible(member), [memberPrivate.id]);
    assert.equal(Number((await getVisibleNetWorthTotals(member)).find((t) => t.isOwn)!.total), 149, "leaving preserves linked-person economic ownership of private accounts and property");
    assert.deepEqual(await visible(owner), [joint.id, ownerPrivate.id].sort());
    assert.equal((await db.select().from(householdAccountShares)).length, 0);
    assert.equal((await db.select().from(householdNetWorthShares)).length, 0);
    assert.equal((await getVisibleNetWorthTotals(owner)).length, 1, "leaving removes aggregate access");
    await assert.rejects(createHouseholdInvitation(owner, partner.id, email(third)), /already has a login identity/);
    await assert.rejects(deletePerson({ userId: owner, id: partner.id }), /preserve/);
    const invitation = await createHouseholdInvitation(owner, partner.id, email(member));
    await acceptHouseholdInvitation(member, invitation.token);
    assert.deepEqual(await visible(member), [memberPrivate.id], "rejoining does not restore old grants");
    await setAccountSharing(owner, joint.id, [member]);
    await revokeHouseholdAccess(owner, partner.id);
    assert.deepEqual(await visible(member), [memberPrivate.id]);
    // Even a stale/corrupt grant cannot cross household boundaries.
    await db.insert(householdAccountShares).values({ accountId: joint.id, memberUserId: stranger, grantedByUserId: owner });
    assert.deepEqual(await visible(stranger), []);
    // A forged grantor cannot share an account they do not own.
    await db.insert(householdAccountShares).values({ accountId: ownerPrivate.id, memberUserId: third, grantedByUserId: member });
    assert.deepEqual(await visible(third), [thirdPrivate.id]);
    await db.insert(accounts).values({ userId: owner, name: "Private debt", accountType: "mortgage", currency: "AUD", functionalBalance: "100" });
    const [foreignProperty] = await db.insert(properties).values({ userId: owner, name: "Private foreign property", propertyType: "residential", currency: "USD", currentValue: "100" }).returning();
    await db.insert(exchangeRates).values({ date: new Date(), baseCurrency: "USD", targetCurrency: "AUD", rate: "1.5" });
    assert.equal(Number((await getVisibleNetWorthTotals(owner)).find((t) => t.isOwn)!.total), 550, "personal totals deduct debt and convert foreign assets");
    await db.update(properties).set({ currency: "CHF" }).where(eq(properties.id, foreignProperty.id));
    assert.equal((await getVisibleNetWorthTotals(owner)).find((t) => t.isOwn)!.total, null, "missing FX cannot silently produce a misleading total");
    const [privateHistoryPerson] = await db.insert(people).values({ userId: owner, name: "Historical placeholder", kind: "member" }).returning();
    await db.insert(accountOwnershipAllocations).values({ accountId: memberPrivate.id, personId: privateHistoryPerson.id, share: "1", effectiveFrom: "2026-01-01" });
    await assert.rejects(deletePerson({ userId: owner, id: privateHistoryPerson.id }), (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.match(error.message, /preserve ownership history/);
      assert.equal("blockers" in error, false, "a deletion conflict must not disclose private account IDs");
      return true;
    });
    // Property ownership does not grant detail. Property and mortgage grants are independent.
    const rejoin = await createHouseholdInvitation(owner, partner.id, email(member));
    await acceptHouseholdInvitation(member, rejoin.token);
    const [home, privateHome] = await db.insert(properties).values([
      { userId: owner, name: "Shared home", propertyType: "residential", currency: "AUD", currentValue: "800" },
      { userId: owner, name: "Private home", propertyType: "residential", currency: "AUD", currentValue: "9000" },
    ]).returning();
    await db.insert(propertyOwners).values([
      { propertyId: home.id, personId: partner.id, share: "0.5" },
      { propertyId: home.id, personId: ownerSelf.id, share: "0.5" },
      { propertyId: privateHome.id, personId: partner.id, share: "1" },
    ]);
    const visibleProperties = async (actor: string) => (await db.select({ id: properties.id }).from(properties).where(propertyAccess(properties.id, actor))).map(p => p.id).sort();
    assert.deepEqual(await visibleProperties(member), [retainedProperty.id]);
    await assert.rejects(setPropertySharing(member, home.id, [third]), /Only the property owner/);
    await assert.rejects(setPropertySharing(owner, home.id, [stranger]), /current household member/);
    const beforePropertyShare = Number((await getVisibleNetWorthTotals(member)).find(t => t.isOwn)!.total);
    await setPropertySharing(owner, home.id, [member]);
    assert.deepEqual(await visibleProperties(member), [home.id, retainedProperty.id].sort());
    assert.deepEqual(await visibleProperties(third), []);
    assert.equal(Number((await getVisibleNetWorthTotals(member)).find(t => t.isOwn)!.total), beforePropertyShare + 400);
    await setPropertySharing(owner, home.id, []);
    assert.deepEqual(await visibleProperties(member), [retainedProperty.id]);
    await setPropertySharing(owner, home.id, [member]);
    await leaveHousehold(member);
    assert.equal((await db.select().from(householdPropertyShares).where(eq(householdPropertyShares.memberUserId, member))).length, 0);
    const secondRejoin = await createHouseholdInvitation(owner, partner.id, email(member));
    await acceptHouseholdInvitation(member, secondRejoin.token);
    assert.deepEqual(await visibleProperties(member), [retainedProperty.id], "rejoining cannot revive property grants");
    await setPropertySharing(owner, home.id, [member]);
    await revokeHouseholdAccess(owner, partner.id);
    assert.deepEqual(await visibleProperties(member), [retainedProperty.id]);
    assert.equal((await db.select().from(householdPropertyShares).where(eq(householdPropertyShares.memberUserId, member))).length, 0);
    console.log("Household privacy integration: private defaults, selective symmetric sharing, shared edits, unrelated isolation, ownership separation, revoke/leave/rejoin and stale-grant defenses passed.");
  } finally {
    await db.delete(householdMemberships).where(inArray(householdMemberships.memberUserId, ids));
    await db.delete(users).where(inArray(users.id, ids));
  }
}
main().then(() => process.exit(0)).catch((error) => { console.error(error); process.exit(1); });
