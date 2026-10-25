import { beforeEach, describe, expect, it, vi } from "vitest";
import { PgDialect } from "drizzle-orm/pg-core";
import type { SQL } from "drizzle-orm";
const mocks = vi.hoisted(() => ({
  auth: vi.fn(), find: vi.fn(), category: vi.fn(), set: vi.fn(), where: vi.fn(), revalidate: vi.fn(),
}));
vi.mock("@/lib/household/financial-auth", () => ({ requireAuth: mocks.auth, getAuthenticatedSession: vi.fn() }));
vi.mock("next/cache", () => ({ revalidatePath: mocks.revalidate }));
vi.mock("@/lib/actions/account-logos", () => ({ resolveMissingAccountLogos: vi.fn() }));
vi.mock("@/lib/db", () => ({ db: {
  query: { transactions: { findFirst: mocks.find }, categories: { findFirst: mocks.category } },
  update: () => ({ set: (value: unknown) => { mocks.set(value); return { where: mocks.where }; } }),
} }));
import { updateTransactionCashFlowPurpose } from "./transactions";

describe("cash-flow purpose authorization and validation", () => {
  beforeEach(() => {
    vi.clearAllMocks(); mocks.auth.mockResolvedValue("actor");
    mocks.find.mockResolvedValue({ amount: "-1000", categoryId: "housing", internalTransferId: null });
    mocks.category.mockResolvedValue({ name: "Housing" }); mocks.where.mockResolvedValue(undefined);
  });
  it("requires login and live transaction access before changing metadata", async () => {
    mocks.auth.mockResolvedValue(null);
    expect((await updateTransactionCashFlowPurpose("id", "loan_principal", 600)).success).toBe(false);
    expect(mocks.find).not.toHaveBeenCalled();
    mocks.auth.mockResolvedValue("actor"); mocks.find.mockResolvedValue(null);
    expect((await updateTransactionCashFlowPurpose("private", "loan_principal", 600)).success).toBe(false);
    expect(mocks.set).not.toHaveBeenCalled();
  });
  it("rechecks account access in the update and modifies only reporting metadata", async () => {
    expect(await updateTransactionCashFlowPurpose("id", "loan_principal", 600)).toEqual({ success: true });
    expect(mocks.set).toHaveBeenCalledWith({ cashFlowKind: "loan_principal", cashFlowAllocationAmount: "600.00", updatedAt: expect.any(Date) });
    const query = new PgDialect().sqlToQuery(mocks.where.mock.calls[0][0] as SQL);
    expect(query.sql).toContain("household_account_shares");
    expect(query.params).toContain("actor");
    expect(mocks.revalidate).toHaveBeenCalledWith("/");
  });
  it("rejects invalid partial allocations, synthetic legs and balance adjustments", async () => {
    expect((await updateTransactionCashFlowPurpose("id", "investment", 2000)).success).toBe(false);
    mocks.find.mockResolvedValue({ amount: "-1000", internalTransferId: "mirror" });
    expect((await updateTransactionCashFlowPurpose("id", "loan_principal", null)).success).toBe(false);
    mocks.find.mockResolvedValue({ amount: "-1000", categoryId: "balance", internalTransferId: null });
    mocks.category.mockResolvedValue({ name: "Balancing Transfer" });
    expect((await updateTransactionCashFlowPurpose("id", "loan_principal", null)).success).toBe(false);
    expect(mocks.set).not.toHaveBeenCalled();
  });
});
