import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { and, eq, inArray, or, sql } from "drizzle-orm";
import { accounts, categories, householdAccountShares, householdInvitations,
  householdMemberships, householdPropertyShares, householdNetWorthShares, properties, people, transactions, users } from "@/lib/db/schema";
import { accountAccess, propertyAccess, sameHousehold } from "./account-access";
import { categoryAccess } from "./category-access";
import { assertInvitationAcceptable, hashInvitationToken } from "./invitation-policy";
import { householdTransaction, type HouseholdTransaction } from "./transaction";

export type HouseholdTransitionRequest =
  | { action: "accept"; token: string }
  | { action: "leave" }
  | { action: "revoke"; personId: string }
  | { action: "dissolve" }
  | { action: "share-account"; accountId: string; memberUserIds: string[] };

export type HouseholdTransitionPreview = Awaited<ReturnType<typeof buildPreview>>["preview"];

function normalizedRequest(request: HouseholdTransitionRequest) {
  if (request.action === "accept") return { action: request.action, tokenHash: hashInvitationToken(request.token) };
  if (request.action === "share-account") return { ...request, memberUserIds: [...new Set(request.memberUserIds)].sort() };
  if (request.action === "revoke") return { action: request.action, personId: request.personId };
  return { action: request.action };
}

function digest(value: unknown) { return createHash("sha256").update(JSON.stringify(value)).digest("hex"); }
function seal(value: unknown) {
  const key = process.env.BETTER_AUTH_SECRET;
  if (!key) throw new Error("Household transition signing is unavailable");
  return createHmac("sha256", key).update(JSON.stringify(value)).digest("hex");
}

async function buildPreview(tx: HouseholdTransaction, actor: string, request: HouseholdTransitionRequest) {
  const [membership] = await tx.select().from(householdMemberships)
    .where(eq(householdMemberships.memberUserId, actor));
  const root = membership?.ownerUserId ?? actor;
  const members = await tx.select().from(householdMemberships)
    .where(eq(householdMemberships.ownerUserId, root)).orderBy(householdMemberships.memberUserId);
  let departingUser: string | null = null;
  let invitationState: unknown = null;
  let destinationRoot: string | null = null;
  let targets: string[] = [];
  if (request.action === "accept") {
    const [invitation] = await tx.select().from(householdInvitations)
      .where(eq(householdInvitations.tokenHash, hashInvitationToken(request.token)));
    const [user] = await tx.select().from(users).where(eq(users.id, actor));
    if (!invitation || !user || user.banned) throw new Error("Invitation not found or unavailable");
    assertInvitationAcceptable(invitation, user.email);
    if (membership || members.length) throw new Error("Leave or dissolve your current household before joining another");
    if (invitation.ownerUserId === actor) throw new Error("You already own this household");
    const [nested] = await tx.select().from(householdMemberships)
      .where(eq(householdMemberships.memberUserId, invitation.ownerUserId));
    if (nested) throw new Error("This invitation is no longer available");
    destinationRoot = invitation.ownerUserId;
    invitationState = { id: invitation.id, owner: invitation.ownerUserId, person: invitation.personId,
      consumed: invitation.consumedAt, expires: invitation.expiresAt };
  } else if (request.action === "share-account") {
    const [account] = await tx.select({ id: accounts.id }).from(accounts).where(and(
      eq(accounts.id, request.accountId), eq(accounts.userId, actor), eq(accounts.isActive, true)));
    if (!account) throw new Error("Only the account custodian can change sharing");
    targets = [...new Set(request.memberUserIds)].sort();
    if (targets.includes(actor) || targets.length > 100) throw new Error("Choose current household members");
    const permitted = targets.length ? await tx.select({ id: users.id }).from(users)
      .where(and(inArray(users.id, targets), sameHousehold(actor, users.id))) : [];
    if (permitted.length !== targets.length) throw new Error("Choose current household members");
  } else if (request.action === "leave") {
    if (!membership) throw new Error("Only household members can leave; the administrator must dissolve the household");
    departingUser = actor;
  } else if (request.action === "revoke") {
    if (membership) throw new Error("Only the household administrator can remove a member");
    const [person] = await tx.select().from(people).where(and(eq(people.id, request.personId),
      eq(people.userId, actor), eq(people.kind, "member")));
    if (!person) throw new Error("Choose a household member");
    departingUser = members.find(member => member.personId === request.personId)?.memberUserId ?? null;
  } else if (membership) throw new Error("Only the household administrator can dissolve a household");

  const householdUsers = [root, ...members.map(member => member.memberUserId)];
  const grants = await tx.select().from(householdAccountShares).where(or(
    inArray(householdAccountShares.memberUserId, householdUsers),
    inArray(householdAccountShares.grantedByUserId, householdUsers)))
    .orderBy(householdAccountShares.accountId, householdAccountShares.memberUserId);
  const propertyGrants = await tx.select().from(householdPropertyShares).where(or(
    inArray(householdPropertyShares.memberUserId, householdUsers),
    inArray(householdPropertyShares.grantedByUserId, householdUsers)))
    .orderBy(householdPropertyShares.propertyId, householdPropertyShares.memberUserId);
  const aggregateGrants = await tx.select().from(householdNetWorthShares).where(or(
    inArray(householdNetWorthShares.memberUserId, householdUsers),
    inArray(householdNetWorthShares.ownerUserId, householdUsers)))
    .orderBy(householdNetWorthShares.ownerUserId, householdNetWorthShares.memberUserId);
  const affectedPropertyIds = [...new Set(propertyGrants.filter(grant => request.action === "dissolve"
    || (departingUser && (grant.memberUserId === departingUser || grant.grantedByUserId === departingUser)))
    .map(grant => grant.propertyId))];
  const affectedProperties = affectedPropertyIds.length ? await tx.select({ id: properties.id, name: properties.name })
    .from(properties).where(and(inArray(properties.id, affectedPropertyIds), propertyAccess(properties.id, actor)))
    .orderBy(properties.id) : [];
  const aggregateSharingEnds = aggregateGrants.some(grant => (grant.ownerUserId === actor || grant.memberUserId === actor)
    && (request.action === "dissolve" || (departingUser && (grant.ownerUserId === departingUser || grant.memberUserId === departingUser))));
  const affectedGrants = request.action === "share-account"
    ? grants.filter(grant => grant.accountId === request.accountId)
    : request.action === "dissolve" ? grants
    : departingUser ? grants.filter(grant => grant.memberUserId === departingUser || grant.grantedByUserId === departingUser) : [];
  const personalAccounts = request.action === "accept" ? await tx.select({ id: accounts.id }).from(accounts).where(eq(accounts.userId, actor)) : [];
  const affectedIds = [...new Set([...personalAccounts.map(account => account.id), ...affectedGrants.map(grant => grant.accountId),
    ...(request.action === "share-account" ? [request.accountId] : [])])];
  // Never enumerate another member's private records, even for an administrator.
  const visible = affectedIds.length ? await tx.select({
    id: accounts.id, name: accounts.name, currency: accounts.currency, custodian: accounts.userId,
    firstRecord: sql<string | null>`(SELECT min(booked_at)::text FROM ${transactions} history WHERE history.account_id = accounts.id)`,
    lastRecord: sql<string | null>`(SELECT max(booked_at)::text FROM ${transactions} history WHERE history.account_id = accounts.id)`,
    recordCount: sql<number>`(SELECT count(*)::integer FROM ${transactions} history WHERE history.account_id = accounts.id)`,
  }).from(accounts).where(and(inArray(accounts.id, affectedIds), accountAccess(accounts.id, actor)))
    .orderBy(accounts.id) : [];
  const sourceDefinitions = await tx.select({ id: categories.id, name: categories.name,
    categoryType: categories.categoryType, cashFlowKind: categories.cashFlowKind })
    .from(categories).where(categoryAccess(actor)).orderBy(categories.id);
  const destinationDefinitions = destinationRoot ? await tx.select({ id: categories.id, name: categories.name,
    categoryType: categories.categoryType, cashFlowKind: categories.cashFlowKind })
    .from(categories).where(categoryAccess(destinationRoot)).orderBy(categories.id) : [];
  const definitions = [...new Map([...sourceDefinitions, ...destinationDefinitions].map(category => [category.id, category])).values()]
    .sort((a,b) => a.id.localeCompare(b.id));
  const conflicts = definitions.filter(definition => definitions.some(other =>
    other.id !== definition.id && other.name.trim().toLowerCase() === definition.name.trim().toLowerCase()));
  const preview = {
    action: request.action,
    accounts: visible.map(account => ({
      ...account, custodian: undefined,
      change: request.action === "accept" ? "You retain custody; joining grants nobody access"
        : request.action === "share-account" ? "Recipients replaced by the selected members"
        : account.custodian === actor ? "You retain custody; household grants are revoked" : "Your household access is revoked",
      historyBoundary: { from: account.firstRecord, policy: "All recorded history and future records; no partial history grant" },
    })),
    properties: affectedProperties,
    aggregateSharingEnds,
    recipients: targets,
    previousRecipients: request.action === "share-account" ? affectedGrants.map(grant => grant.memberUserId).sort() : [],
    revokedRecipients: request.action === "share-account" ? affectedGrants.filter(grant => !targets.includes(grant.memberUserId)).map(grant => grant.memberUserId).sort() : [],
    accountPolicy: request.action === "accept" ? "Joining shares no accounts or financial history. Your accounts remain private unless you explicitly share them."
      : "Only explicit account grants change. Private accounts are not published.",
    categoryMappings: definitions.map(definition => ({ ...definition, sourceCategoryId: definition.id,
      destinationCategoryId: definition.id, treatment: "Retain classification identity; never merge by name" })),
    categoryConflicts: conflicts,
    effects: [
      "Economic ownership, dated allocations, bank credentials and the canonical feed remain unchanged.",
      "Budgets, rules and integrations remain personal. Reports and actuals recompute from currently permitted accounts.",
      "Private instructions, private activity and linked resources are excluded from category definitions.",
      "Withdrawing or ending membership revokes current server access in both directions. Rejoining requires new account grants.",
      "Previously downloaded copies cannot be revoked.",
    ],
  };
  const signedState = { actor, request: normalizedRequest(request), membership, members, grants, propertyGrants, aggregateGrants, invitationState, preview };
  return { preview, confirmation: seal(signedState) };
}

export async function previewHouseholdTransition(actor: string, request: HouseholdTransitionRequest) {
  return householdTransaction(tx => buildPreview(tx, actor, request));
}

/** Rebuild under the same lock and transaction used by the actual mutation. */
export async function confirmHouseholdTransition<T>(actor: string, request: HouseholdTransitionRequest,
  confirmation: string | undefined, work: () => Promise<T>): Promise<T> {
  return householdTransaction(async tx => {
    if (!confirmation || !/^[a-f0-9]{64}$/.test(confirmation)) throw new Error("This transition needs a current preview");
    const current = await buildPreview(tx, actor, request);
    if (!timingSafeEqual(Buffer.from(current.confirmation, "hex"), Buffer.from(confirmation, "hex"))) {
      throw new Error("This preview is stale. Review the updated transition before confirming");
    }
    const result = await work();
    await tx.execute(sql`INSERT INTO household_transition_events(actor_user_id, action, request_digest, preview)
      VALUES (${actor}, ${request.action}, ${digest(normalizedRequest(request))}, ${JSON.stringify(current.preview)}::jsonb)`);
    return result;
  });
}
