import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@/lib/db", () => ({
  db: {
    select: vi.fn(),
    query: { categories: { findMany: vi.fn() } },
  },
}));

vi.mock("@/lib/household/financial-auth", () => ({
  getAuthenticatedSession: vi.fn(),
}));

vi.mock("@/lib/auth-helpers", () => ({ getAuthenticatedSession: vi.fn() }));

vi.mock("next/cache", () => ({
  unstable_cache: <T extends (...args: any[]) => any>(fn: T) => fn,
  revalidateTag: vi.fn(),
}));

vi.mock("@/lib/actions/account-logos", () => ({
  resolveMissingAccountLogos: (rows: any) => rows,
  resolveMissingAccountLogo: (row: any) => row,
}));

describe("cached data layer", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
  });

  it("projects shared definitions without private guidance and rechecks independent calls", async () => {
    const { getAuthenticatedSession } = await import("@/lib/household/financial-auth");
    vi.mocked(getAuthenticatedSession).mockResolvedValue({user:{id:"user-1"}} as Awaited<ReturnType<typeof getAuthenticatedSession>>);
    const {db}=await import("@/lib/db");
    vi.mocked(db.query.categories.findMany).mockResolvedValueOnce([{
      id:"category",name:"Housing",userId:"other",categoryType:"expense",cashFlowKind:"loan_principal",
      selectionHidden:false,categorizationInstructions:"PRIVATE INSTRUCTION",description:"PRIVATE DETAIL",parentId:"private-parent",
    }] as never).mockResolvedValueOnce([]);
    const {getCachedUserCategories}=await import("../cached");
    const first=await getCachedUserCategories();
    expect(first).toMatchObject([{id:"category",name:"Housing",cashFlowKind:"loan_principal",hideFromSelection:false,parentId:null,categorizationInstructions:null,description:null}]);
    expect(JSON.stringify(first)).not.toContain("PRIVATE");
    expect(await getCachedUserCategories()).toEqual([]);
    expect(db.query.categories.findMany).toHaveBeenCalledTimes(2);
  });
});
