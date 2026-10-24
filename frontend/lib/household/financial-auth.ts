"use server";

import { getAuthenticatedSession as getLoginSession } from "@/lib/auth-helpers";
import { getHouseholdAccess } from "./access";

/** For financial resources only. Profile, auth and admin callers use login identity. */
export async function getAuthenticatedSession() {
  const session = await getLoginSession();
  if (!session?.user?.id) return null;
  const access = await getHouseholdAccess(session.user.id);
  return { ...session, actorUserId: session.user.id, householdPersonId: access.personId,
    user: { ...session.user, id: access.ownerUserId } };
}

export async function requireAuth(): Promise<string | null> {
  const session = await getAuthenticatedSession();
  return session?.user.id ?? null;
}
