import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
const mocks = vi.hoisted(() => ({ session: vi.fn(), headers: vi.fn(() => ({})) }));
vi.mock("@/lib/auth", () => ({ auth: { api: { getSession: mocks.session } } }));
vi.mock("@/lib/internal-auth", () => ({ createInternalAuthHeaders: mocks.headers }));
vi.mock("@/lib/backend-url", () => ({ getBackendBaseUrl: () => "http://backend:8000" }));
import { GET as callback } from "@/app/api/enable-banking/callback/route";
import { GET as status } from "@/app/api/enable-banking/status/[connectionId]/route";

describe("personal bank connection identity", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.session.mockResolvedValue({ user: { id: "member" } });
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ connection_id: "new-connection" }), { status: 200 })));
  });
  it("signs a bank callback as the member who authorized it", async () => {
    await callback(new NextRequest("http://localhost/api/enable-banking/callback?code=code&state=state"));
    expect(mocks.headers).toHaveBeenCalledWith(expect.objectContaining({ userId: "member", pathWithQuery: "/api/enable-banking/session" }));
  });
  it("checks only the member's connection status and encodes the identifier", async () => {
    await status(new NextRequest("http://localhost/api/enable-banking/status/id"), { params: Promise.resolve({ connectionId: "../../other?query" }) });
    expect(mocks.headers).toHaveBeenCalledWith(expect.objectContaining({ userId: "member", pathWithQuery: "/api/enable-banking/status/..%2F..%2Fother%3Fquery" }));
  });
  it("does not call the backend without a login", async () => {
    mocks.session.mockResolvedValue(null);
    const result = await status(new NextRequest("http://localhost/api/enable-banking/status/id"), { params: Promise.resolve({ connectionId: "id" }) });
    expect(result.status).toBe(401);
    expect(fetch).not.toHaveBeenCalled();
  });
});
