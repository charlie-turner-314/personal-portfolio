"use server";

import { getAuthenticatedSession as getLoginSession } from "@/lib/auth-helpers";
import { getHouseholdAccess } from "./access";

/** Household membership is metadata, never permission to impersonate its owner. */
export async function getAuthenticatedSession() {
  const session = await getLoginSession();
  if (!session?.user?.id) return null;
  const access = await getHouseholdAccess(session.user.id);
  return { ...session, actorUserId: session.user.id, householdPersonId: access.personId,
    user: session.user };
}

export async function requireAuth(): Promise<string | null> {
  const session = await getAuthenticatedSession();
  return session?.user.id ?? null;
}
