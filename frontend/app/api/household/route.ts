import { NextRequest, NextResponse } from "next/server";
import { eq, and, isNull, gt } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/lib/db";
import { householdInvitations, householdMemberships, users } from "@/lib/db/schema";
import { getAuthenticatedSession } from "@/lib/auth-helpers";
import { getHouseholdAccess } from "@/lib/household/access";
import { acceptHouseholdInvitation, createHouseholdInvitation, leaveHousehold, revokeHouseholdAccess, dissolveHousehold } from "@/lib/household/invitations";
import { isDemoRestrictedUserEmail } from "@/lib/demo-access";

import { previewHouseholdTransition, confirmHouseholdTransition } from "@/lib/household/transitions";

export const dynamic = "force-dynamic";

export async function GET() {
  const session = await getAuthenticatedSession();
  if (!session?.user.id) return NextResponse.json({ error: "Not authenticated" }, { status: 401 });
  const access = await getHouseholdAccess(session.user.id);
  const [owner] = await db.select({ name: users.name }).from(users).where(eq(users.id, access.ownerUserId));
  const members = await db.select({ personId: householdMemberships.personId, email: users.email })
    .from(householdMemberships).innerJoin(users, eq(users.id, householdMemberships.memberUserId))
    .where(eq(householdMemberships.ownerUserId, access.ownerUserId));
  const invitations = access.isOwner ? await db.select({ id: householdInvitations.id, personId: householdInvitations.personId, email: householdInvitations.email, expiresAt: householdInvitations.expiresAt })
    .from(householdInvitations).where(and(eq(householdInvitations.ownerUserId, session.user.id), isNull(householdInvitations.consumedAt), gt(householdInvitations.expiresAt, new Date()))) : [];
  return NextResponse.json({ ...access, ownerName: owner?.name ?? "Household owner", members, invitations });
}

const requestSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("invite"), personId: z.string().uuid(), email: z.string().email().max(320) }),
  z.object({ action: z.literal("revoke"), personId: z.string().uuid(), phase: z.enum(["preview", "commit"]).optional(), confirmation: z.string().optional() }),
  z.object({ action: z.literal("accept"), token: z.string().regex(/^[a-f0-9]{64}$/), phase: z.enum(["preview", "commit"]).optional(), confirmation: z.string().optional() }),
  z.object({ action: z.literal("leave"), phase: z.enum(["preview", "commit"]).optional(), confirmation: z.string().optional() }),
  z.object({ action: z.literal("dissolve"), phase: z.enum(["preview", "commit"]).optional(), confirmation: z.string().optional() }),
]);

export async function POST(req: NextRequest) {
  const session = await getAuthenticatedSession();
  if (!session?.user.id) return NextResponse.json({ error: "Not authenticated" }, { status: 401 });
  if (isDemoRestrictedUserEmail(session.user.email)) return NextResponse.json({ error: "Household invitations are unavailable for demo accounts" }, { status: 403 });
  const origin = req.headers.get("origin");
  const allowedOrigins = [req.nextUrl.origin, process.env.APP_URL, process.env.BETTER_AUTH_URL].filter(Boolean).map((value) => new URL(value!).origin);
  if (origin && !allowedOrigins.includes(origin)) return NextResponse.json({ error: "Invalid origin" }, { status: 403 });
  const parsed = requestSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "Invalid household request" }, { status: 400 });
  try {
    const body = parsed.data;
    if (body.action === "invite") return NextResponse.json(await createHouseholdInvitation(session.user.id, body.personId, body.email));
    if (body.phase === "preview") return NextResponse.json(await previewHouseholdTransition(session.user.id, body), { headers: { "Cache-Control": "private, no-store" } });
    await confirmHouseholdTransition(session.user.id, body, body.confirmation, async () => {
      if (body.action === "accept") await acceptHouseholdInvitation(session.user.id, body.token);
      if (body.action === "revoke") await revokeHouseholdAccess(session.user.id, body.personId);
      if (body.action === "leave") await leaveHousehold(session.user.id);
      if (body.action === "dissolve") await dissolveHousehold(session.user.id);
    });
    return NextResponse.json({ success: true });
  } catch (error) {
    // Expected policy conflicts are safe to display; database internals are not.
    const message = error instanceof Error ? error.message : "Household request failed";
    const expected = /^(Only |Choose |This |Invite |Enter |Invitation |Sign in |An active |You already |Leave |Remove )/.test(message);
    return NextResponse.json({ error: expected ? message : "Could not update household access. Please try again." }, { status: expected ? 409 : 500 });
  }
}
