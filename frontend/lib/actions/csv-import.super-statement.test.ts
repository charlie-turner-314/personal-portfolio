import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
  const insertTables: unknown[] = [];
  const insertValues: Array<Record<string, unknown>> = [];
  const insertResults: Array<Array<{ id: string }>> = [];
  const updateValues: Array<Record<string, unknown>> = [];
  const storage = {
    download: vi.fn(),
    upload: vi.fn(),
  };
  const db = {
    query: {
      csvImports: { findFirst: vi.fn() },
      accounts: { findFirst: vi.fn() },
      superAccounts: { findFirst: vi.fn() },
      accountBalances: { findFirst: vi.fn() },
      csvImportProfiles: { findFirst: vi.fn() },
    },
    insert: vi.fn((table: unknown) => {
      insertTables.push(table);
      return {
        values: vi.fn((values: Record<string, unknown>) => {
          insertValues.push(values);
          return ({
          onConflictDoNothing: vi.fn(() => ({
            returning: vi.fn(async () => insertResults.shift() ?? []),
          })),
          returning: vi.fn(async () => [{ id: "csv-import-1" }]),
          });
        }),
      };
    }),
    update: vi.fn(() => ({
      set: vi.fn((values: Record<string, unknown>) => {
        updateValues.push(values);
        return { where: vi.fn(async () => undefined) };
      }),
    })),
  };

  return {
    db,
    getAuthenticatedSession: vi.fn(),
    insertResults,
    insertTables,
    insertValues,
    revalidatePath: vi.fn(),
    storage,
    updateValues,
  };
});

vi.mock("@/lib/db", () => ({ db: mocks.db }));
vi.mock("@/lib/auth-helpers", () => ({
  getAuthenticatedSession: mocks.getAuthenticatedSession,
  requireAuth: vi.fn(),
}));
vi.mock("@/lib/storage", () => ({ storage: mocks.storage }));
vi.mock("@/lib/security/data-encryption", () => ({
  decryptWithFallback: (_ciphertext: string | null, plain: string | null) => plain,
  encryptValue: (value: string) => value,
}));
vi.mock("@/lib/demo-access", () => ({
  DEMO_RESTRICTED_ACTION_ERROR: "Demo accounts cannot import",
  isDemoRestrictedUserEmail: () => false,
}));
vi.mock("@/lib/actions/transactions", () => ({ deleteTransactions: vi.fn() }));
vi.mock("next/cache", () => ({ revalidatePath: mocks.revalidatePath }));

import {
  createSuperStatementRowHash,
  importSuperStatement,
  initializeCsvImport,
  type SuperStatementColumnMapping,
} from "./csv-import";
import {
  accountBalances,
  csvImports,
  superContributions,
} from "@/lib/db/schema";

const MAPPING: SuperStatementColumnMapping = {
  date: "Date",
  amount: "Amount",
  eventType: "Event",
  balance: "Balance",
  description: "Description",
};

function configureSuperStatement() {
  mocks.getAuthenticatedSession.mockResolvedValue({ user: { id: "user-1", email: "person@example.com" } });
  mocks.db.query.csvImports.findFirst.mockResolvedValue({
    id: "import-1",
    accountId: "account-1",
    userId: "user-1",
    filePath: "csv-imports/user-1/statement.csv",
    filePathCiphertext: null,
  });
  mocks.db.query.accounts.findFirst.mockResolvedValue({
    id: "account-1",
    userId: "user-1",
    accountType: "superannuation",
    currency: "AUD",
  });
  mocks.db.query.superAccounts.findFirst.mockResolvedValue({ id: "super-1", accountId: "account-1", userId: "user-1" });
  mocks.db.query.accountBalances.findFirst.mockResolvedValue({ balanceInFunctionalCurrency: "10000.00" });
  mocks.storage.download.mockResolvedValue(Buffer.from("Date,Amount,Event,Balance,Description\n2026-07-01,1000,Employer SG,10000,July contribution"));
}

describe("super statement CSV import", () => {
  beforeEach(() => {
    mocks.insertTables.length = 0;
    mocks.insertValues.length = 0;
    mocks.insertResults.length = 0;
    mocks.updateValues.length = 0;
    mocks.getAuthenticatedSession.mockReset();
    mocks.storage.download.mockReset();
    mocks.storage.upload.mockReset();
    mocks.db.insert.mockClear();
    mocks.db.update.mockClear();
    Object.values(mocks.db.query).forEach((query) => query.findFirst.mockReset());
  });

  it("uses a stable source-row identity", () => {
    const row = ["2026-07-01", "1000", "Employer SG"];
    expect(createSuperStatementRowHash("import-1", 0, row)).toBe(createSuperStatementRowHash("import-1", 0, row));
    expect(createSuperStatementRowHash("import-1", 0, row)).not.toBe(createSuperStatementRowHash("import-1", 1, row));
  });

  it("persists each contribution and balance snapshot once when a statement is replayed", async () => {
    configureSuperStatement();
    mocks.insertResults.push([{ id: "balance-1" }], [{ id: "contribution-1" }]);

    const first = await importSuperStatement("import-1", MAPPING);
    expect(first).toMatchObject({
      success: true,
      contributionsImported: 1,
      balanceSnapshotsImported: 1,
      duplicatesSkipped: 0,
    });
    expect(mocks.insertTables).toEqual(expect.arrayContaining([accountBalances, superContributions]));
    expect(mocks.insertValues).toEqual(expect.arrayContaining([
      expect.objectContaining({
        sourceImportId: "import-1",
        sourceRowHash: createSuperStatementRowHash("import-1", 0, [
          "2026-07-01", "1000", "Employer SG", "10000", "July contribution",
        ]),
      }),
    ]));

    const replay = await importSuperStatement("import-1", MAPPING);
    expect(replay).toMatchObject({
      success: true,
      contributionsImported: 0,
      balanceSnapshotsImported: 0,
      duplicatesSkipped: 2,
    });
    expect(mocks.insertTables).not.toContain(csvImports);
  });

  it("leaves the ordinary CSV session initializer available to a non-super account", async () => {
    mocks.getAuthenticatedSession.mockResolvedValue({ user: { id: "user-1", email: "person@example.com" } });
    mocks.db.query.accounts.findFirst.mockResolvedValue({ id: "bank-account", accountType: "checking" });
    mocks.db.query.csvImportProfiles.findFirst.mockResolvedValue(null);
    mocks.storage.upload.mockResolvedValue(undefined);

    const result = await initializeCsvImport("bank-account", "bank.csv", "Date,Amount\n2026-07-01,10");

    expect(result).toEqual({ success: true, importId: "csv-import-1" });
    expect(mocks.insertTables).toContain(csvImports);
  });
});
