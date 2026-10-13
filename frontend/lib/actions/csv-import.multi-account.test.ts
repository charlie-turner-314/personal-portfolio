import { readFileSync } from "node:fs";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  session: vi.fn(), download: vi.fn(), existing: vi.fn(), accounts: vi.fn(), update: vi.fn(),
}));
vi.mock("@/lib/db", () => ({ db: {
  query: { csvImports: { findFirst: mocks.session }, accounts: { findMany: mocks.accounts }, transactions: { findMany: mocks.existing } },
  update: () => ({ set: mocks.update.mockImplementation(() => ({ where: async () => undefined })) }),
} }));
vi.mock("@/lib/auth-helpers", () => ({ getAuthenticatedSession: async () => ({ user: { id: "u", email: "test@example.test" } }), requireAuth: async () => "u" }));
vi.mock("@/lib/storage", () => ({ storage: { download: mocks.download } }));
vi.mock("@/lib/security/data-encryption", () => ({ decryptWithFallback: (_cipher: unknown, plain: string) => plain, encryptValue: (value: string) => value }));
vi.mock("@/lib/actions/transactions", () => ({ deleteTransactions: vi.fn() }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

import { previewImportedTransactions, saveColumnMapping } from "./csv-import";
import { suggestAustralianCsvMapping } from "@/lib/import/csv-presets";
import { parseDelimitedText } from "@/lib/import/parsing";

const fixture = "Date and time,Description,Debit,Credit,From account,To account,Transaction ID\n12:13 08-10-26,Move funds,,$100,Savings,Spending,one\n12:12 08-10-26,Purchase,$20,,Spending,,two";
let mapping: ReturnType<typeof suggestAustralianCsvMapping> & { accountMappings: Record<string, string | null> };
function setup(content: string, aliases: Record<string, string | null>) {
  mapping = { ...suggestAustralianCsvMapping(parseDelimitedText(content, ",").headers), accountMappings: aliases };
  mocks.session.mockResolvedValue({ id: "import", accountId: "a", userId: "u", filePath: "file.csv", columnMapping: mapping });
  mocks.download.mockResolvedValue(Buffer.from(content));
  mocks.accounts.mockResolvedValue([{ id: "a", name: "Savings", currency: "AUD" }, { id: "b", name: "Spending", currency: "AUD" }]);
  mocks.existing.mockResolvedValue([]);
}

describe("multi-account server preview", () => {
  beforeEach(() => { vi.clearAllMocks(); setup(fixture, { Savings: "a", Spending: "b" }); });
  it("previews a transfer once and a purchase on its confirmed account", async () => {
    const result = await previewImportedTransactions("import");
    expect(result.success).toBe(true);
    expect(result.transactions).toHaveLength(2);
    expect(result.transactions?.[0]).toMatchObject({ accountId: "a", destinationAccountId: "b", amount: -100 });
    expect(result.transactions?.[1]).toMatchObject({ accountId: "b", amount: -20 });
  });
  it("requires a decision for every alias at save and preview", async () => {
    delete mapping.accountMappings.Savings;
    expect(await saveColumnMapping("import", mapping)).toMatchObject({ success: false });
    expect(await previewImportedTransactions("import")).toMatchObject({ success: false });
  });
  it("rejects a foreign account and cross-currency transfers", async () => {
    mapping.accountMappings.Savings = "foreign";
    expect(await previewImportedTransactions("import")).toMatchObject({ success: false, error: "Mapped account is unavailable" });
    mapping.accountMappings.Savings = "a";
    mocks.accounts.mockResolvedValue([{ id: "a", currency: "USD" }, { id: "b", currency: "AUD" }]);
    expect(await previewImportedTransactions("import")).toMatchObject({ success: false, error: "Internal transfers must use accounts with the same currency" });
  });
  it("marks reimported bank IDs as duplicates without confusing the other account", async () => {
    const first = await previewImportedTransactions("import");
    mocks.existing.mockResolvedValue([{ externalId: first.transactions![0].externalId, accountId: "a" }]);
    const second = await previewImportedTransactions("import");
    expect(second.transactions?.map((tx) => Boolean(tx.isDuplicate))).toEqual([true, false]);
  });
  it("supports arbitrary column names, semicolons, signed comma-decimal amounts and no bank ID", async () => {
    mocks.download.mockResolvedValue(Buffer.from("When;Memo;Value;Origin wallet;Beneficiary wallet\n2026-10-09;Move;-125,50;Rainy day;Daily\n2026-10-10;Deposit;25,00;;Daily"));
    Object.assign(mapping, { date: "When", description: "Memo", amount: "Value", debitAmount: null, creditAmount: null,
      sourceAccount: "Origin wallet", destinationAccount: "Beneficiary wallet", transactionId: null,
      accountMappings: { "Rainy day": "a", Daily: "b" }, typeConfig: { isAmountSigned: true, amountFormat: "COMMA_DECIMAL" } });
    const result = await previewImportedTransactions("import");
    expect(result.success).toBe(true);
    expect(result.transactions?.map((tx) => [tx.accountId, tx.destinationAccountId, tx.amount])).toEqual([["a", "b", -125.5], ["b", undefined, 25]]);
    expect((await previewImportedTransactions("import")).transactions?.map((tx) => tx.externalId)).toEqual(result.transactions?.map((tx) => tx.externalId));
  });
  it("keeps single-account signed import behavior when routing columns are not mapped", async () => {
    mocks.download.mockResolvedValue(Buffer.from("Date,Description,Amount\n2026-10-09,Purchase,-12\n2026-10-10,Refund,12"));
    Object.assign(mapping, { ...suggestAustralianCsvMapping(["Date", "Description", "Amount"], [["2026-10-09", "Purchase", "-12"]]), sourceAccount: null, destinationAccount: null });
    const result = await previewImportedTransactions("import");
    expect(result.success).toBe(true);
    expect(result.transactions?.map((tx) => [tx.accountId, tx.amount])).toEqual([[undefined, -12], [undefined, 12]]);
  });
  it.skipIf(!process.env.PPF41_SAMPLE_CSV)("parses every row of the private sample with explicit synthetic accounts", async () => {
    setup(readFileSync(process.env.PPF41_SAMPLE_CSV!, "utf8"), { "Save Account": "a", "Savings account": "a", "Pay Account": "b", "Spend account": "b" });
    const result = await previewImportedTransactions("import");
    expect(result.success).toBe(true);
    expect(result.rowsNeedingAttention).toBe(0);
    expect(result.transactions).toHaveLength(50);
    expect(result.transactions?.filter((tx) => tx.destinationAccountId)).toHaveLength(22);
    expect(new Set(result.transactions?.map((tx) => tx.externalId)).size).toBe(50);
  });
});
