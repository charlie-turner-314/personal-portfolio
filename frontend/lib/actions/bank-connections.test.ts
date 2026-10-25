import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("@/lib/db", () => ({ db: {} }));
vi.mock("@/lib/auth-helpers", () => ({
  requireAuth: vi.fn(),
  getAuthenticatedSession: async () => ({ user: { id: "user", email: "user@example.test" } }),
}));
vi.mock("@/lib/demo-access", () => ({ isDemoRestrictedUserEmail: () => false, DEMO_RESTRICTED_ACTION_ERROR: "Restricted" }));
vi.mock("@/lib/backend-url", () => ({ getBackendBaseUrl: () => "http://backend:8000" }));
const auth = vi.hoisted(() => vi.fn(() => ({})));
vi.mock("@/lib/internal-auth", () => ({ createInternalAuthHeaders: auth }));
import { triggerSync, disconnectBank } from "./bank-connections";

describe("bank connection URL boundaries", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubGlobal("fetch", vi.fn(async () => new Response("{}", { status: 200 })));
  });
  it.each(["../../admin?x=1#fragment", "//evil.example/path", "a\\b", "normal-id"])("encodes connection ID %s and signs the same path", async (id) => {
    await triggerSync(id);
    const expected = `/api/enable-banking/sync/${encodeURIComponent(id)}`;
    expect(fetch).toHaveBeenCalledWith(`http://backend:8000${expected}`, expect.anything());
    expect(auth).toHaveBeenCalledWith(expect.objectContaining({ pathWithQuery: expected }));
  });
});
