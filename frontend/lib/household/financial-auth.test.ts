import { beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ session: vi.fn(), access: vi.fn() }));
vi.mock("@/lib/auth-helpers", () => ({ getAuthenticatedSession: mocks.session }));
vi.mock("./access", () => ({ getHouseholdAccess: mocks.access }));
import { getAuthenticatedSession, requireAuth } from "./financial-auth";

describe("financial authorization boundary", () => {
  beforeEach(() => vi.resetAllMocks());
  it("never resolves grants for unauthenticated callers", async () => {
    mocks.session.mockResolvedValue(null);
    expect(await requireAuth()).toBeNull();
    expect(mocks.access).not.toHaveBeenCalled();
  });
  it("uses household scope without inheriting owner login privileges", async () => {
    mocks.session.mockResolvedValue({ user: { id: "member", email: "member@example.test", role: "user" }, session: { userId: "member" } });
    mocks.access.mockResolvedValue({ ownerUserId: "owner", personId: "existing-person" });
    const result = await getAuthenticatedSession();
    expect(result?.user).toEqual({ id: "owner", email: "member@example.test", role: "user" });
    expect(result?.actorUserId).toBe("member");
    expect(result?.session.userId).toBe("member");
    expect(result?.householdPersonId).toBe("existing-person");
  });
  it("rechecks access after revocation instead of caching the membership", async () => {
    mocks.session.mockResolvedValue({ user: { id: "member" } });
    mocks.access.mockResolvedValueOnce({ ownerUserId: "owner" }).mockResolvedValueOnce({ ownerUserId: "member" });
    expect(await requireAuth()).toBe("owner");
    expect(await requireAuth()).toBe("member");
    expect(mocks.access).toHaveBeenCalledTimes(2);
  });
});
