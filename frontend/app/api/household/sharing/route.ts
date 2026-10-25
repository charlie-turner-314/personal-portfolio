import { NextRequest, NextResponse } from "next/server";
import { and, eq, ne } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/lib/db";
import { accounts, properties, householdPropertyShares, householdAccountShares, householdNetWorthShares, users } from "@/lib/db/schema";
import { getAuthenticatedSession } from "@/lib/auth-helpers";
import { sameHousehold } from "@/lib/household/account-access";
import { setAccountSharing, setPropertySharing, setNetWorthSharing } from "@/lib/household/sharing";
import { isDemoRestrictedUserEmail } from "@/lib/demo-access";

export const dynamic = "force-dynamic";
export async function GET() {
  const session = await getAuthenticatedSession();
  if (!session?.user.id) return NextResponse.json({ error: "Not authenticated" }, { status: 401 });
  const actor = session.user.id;
  const [members, ownedAccounts, grants, netWorthGrants, ownedProperties, propertyGrants] = await Promise.all([
    db.select({ id: users.id, name: users.name }).from(users).where(and(ne(users.id, actor), sameHousehold(actor, users.id))),
    db.select({ id: accounts.id, name: accounts.name }).from(accounts).where(and(eq(accounts.userId, actor), eq(accounts.isActive, true))),
    db.select({ accountId: householdAccountShares.accountId, memberUserId: householdAccountShares.memberUserId }).from(householdAccountShares).where(eq(householdAccountShares.grantedByUserId, actor)),
    db.select({ memberUserId: householdNetWorthShares.memberUserId }).from(householdNetWorthShares).where(eq(householdNetWorthShares.ownerUserId, actor)),
    db.select({ id: properties.id, name: properties.name }).from(properties).where(and(eq(properties.userId, actor), eq(properties.isActive, true))),
    db.select({ propertyId: householdPropertyShares.propertyId, memberUserId: householdPropertyShares.memberUserId }).from(householdPropertyShares).where(eq(householdPropertyShares.grantedByUserId, actor)),
  ]);
  return NextResponse.json({ properties: ownedProperties.map(property => ({ ...property, sharedWith: propertyGrants.filter(g => g.propertyId === property.id && members.some(m => m.id === g.memberUserId)).map(g => g.memberUserId) })), members, accounts: ownedAccounts.map((account) => ({ ...account, sharedWith: grants.filter((g) => g.accountId === account.id && members.some((m) => m.id === g.memberUserId)).map((g) => g.memberUserId) })), netWorthSharedWith: netWorthGrants.filter((g) => members.some((m) => m.id === g.memberUserId)).map((g) => g.memberUserId) }, { headers: { "Cache-Control": "private, no-store" } });
}
const bodySchema = z.discriminatedUnion("resource", [
  z.object({ resource: z.literal("account"), accountId: z.string().uuid(), memberUserIds: z.array(z.string().min(1).max(255)).max(100) }),
  z.object({ resource: z.literal("property"), propertyId: z.string().uuid(), memberUserIds: z.array(z.string().min(1).max(255)).max(100) }),
  z.object({ resource: z.literal("net-worth"), memberUserIds: z.array(z.string().min(1).max(255)).max(100) }),
]);
export async function POST(req: NextRequest) {
  const session = await getAuthenticatedSession();
  if (!session?.user.id) return NextResponse.json({ error: "Not authenticated" }, { status: 401 });
  if (isDemoRestrictedUserEmail(session.user.email)) return NextResponse.json({ error: "Sharing is unavailable for demo accounts" }, { status: 403 });
  const allowed = [req.nextUrl.origin, process.env.APP_URL, process.env.BETTER_AUTH_URL].filter(Boolean).map((v) => new URL(v!).origin);
  const origin = req.headers.get("origin");
  if (origin && !allowed.includes(origin)) return NextResponse.json({ error: "Invalid origin" }, { status: 403 });
  const parsed = bodySchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "Invalid sharing request" }, { status: 400 });
  try {
    if (parsed.data.resource === "account") await setAccountSharing(session.user.id, parsed.data.accountId, parsed.data.memberUserIds);
    else if (parsed.data.resource === "property") await setPropertySharing(session.user.id, parsed.data.propertyId, parsed.data.memberUserIds);
    else await setNetWorthSharing(session.user.id, parsed.data.memberUserIds);
    return NextResponse.json({ success: true });
  } catch (error) {
    const message = error instanceof Error ? error.message : "";
    const expected = /^(Only the (?:account|property) owner|Choose )/.test(message);
    return NextResponse.json({ error: expected ? message : "Could not update sharing" }, { status: expected ? 403 : 500 });
  }
}
