import { describe, expect, it } from "vitest";
import { assertInvitationAcceptable, hashInvitationToken, newInvitationToken } from "./invitation-policy";

describe("household invitation policy", () => {
  const now = new Date("2026-10-24T00:00:00Z");
  const invitation = { email: "partner@example.com", expiresAt: new Date(now.getTime() + 1000), consumedAt: null };
  it("requires the intended authenticated email", () => {
    expect(() => assertInvitationAcceptable(invitation, " Partner@Example.com ", now)).not.toThrow();
    expect(() => assertInvitationAcceptable(invitation, "other@example.com", now)).toThrow("email address");
  });
  it("rejects expiry at the boundary and previously used invitations", () => {
    expect(() => assertInvitationAcceptable({ ...invitation, expiresAt: now }, invitation.email, now)).toThrow("expired");
    expect(() => assertInvitationAcceptable({ ...invitation, consumedAt: now }, invitation.email, now)).toThrow("already used");
  });
  it("generates independent high entropy secrets and stores only their hashes", () => {
    const first = newInvitationToken();
    const second = newInvitationToken();
    expect(first.token).toHaveLength(64);
    expect(first.token).not.toBe(second.token);
    expect(first.tokenHash).not.toBe(first.token);
    expect(hashInvitationToken(first.token)).toBe(first.tokenHash);
    expect(() => hashInvitationToken("bad")).toThrow("Invalid invitation");
  });
});
