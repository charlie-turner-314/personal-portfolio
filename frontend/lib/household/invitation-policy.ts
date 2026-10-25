import { createHash, randomBytes } from "node:crypto";

export const INVITATION_LIFETIME_MS = 7 * 24 * 60 * 60 * 1000;
export function normalizeInvitationEmail(email: string): string {
  return email.trim().toLowerCase();
}
export function hashInvitationToken(token: string): string {
  if (!/^[a-f0-9]{64}$/.test(token)) throw new Error("Invalid invitation link");
  return createHash("sha256").update(token).digest("hex");
}
export function newInvitationToken() {
  const token = randomBytes(32).toString("hex");
  return { token, tokenHash: hashInvitationToken(token) };
}
export function assertInvitationAcceptable(
  invitation: { email: string; expiresAt: Date; consumedAt: Date | null },
  actorEmail: string,
  now = new Date(),
) {
  if (invitation.consumedAt || invitation.expiresAt <= now) throw new Error("Invitation has expired or was already used");
  if (normalizeInvitationEmail(invitation.email) !== normalizeInvitationEmail(actorEmail)) {
    throw new Error("Sign in with the email address this invitation was created for");
  }
}
