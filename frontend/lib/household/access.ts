import { eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { householdMemberships } from "@/lib/db/schema";

/** Never cached across requests: removing membership immediately removes access. */
export async function getHouseholdAccess(actorUserId: string) {
  const [membership] = await db.select().from(householdMemberships)
    .where(eq(householdMemberships.memberUserId, actorUserId)).limit(1);
  return {
    actorUserId,
    ownerUserId: membership?.ownerUserId ?? actorUserId,
    personId: membership?.personId ?? null,
    isOwner: !membership,
  };
}
