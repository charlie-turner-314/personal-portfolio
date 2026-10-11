import { describe, expect, it } from "vitest";
import { getAccountFreshness } from "./account-freshness";

const now = new Date("2026-10-11T00:00:00.000Z");

describe("getAccountFreshness", () => {
  it("keeps a recently synced Up account current", () => {
    const lastSyncedAt = new Date("2026-10-10T00:00:00.000Z");

    expect(getAccountFreshness({ provider: "up", lastSyncedAt, now })).toEqual({
      source: "up",
      status: "current",
      lastUpdatedAt: lastSyncedAt,
      dataThrough: null,
    });
  });

  it("marks an old API sync as stale", () => {
    const lastSyncedAt = new Date("2026-08-01T00:00:00.000Z");

    expect(getAccountFreshness({ provider: "up", lastSyncedAt, now }).status).toBe("stale");
  });

  it("judges CSV freshness by the transaction date, not upload date", () => {
    const importedAt = new Date("2026-10-10T00:00:00.000Z");
    const dataThrough = new Date("2026-08-01T00:00:00.000Z");

    expect(
      getAccountFreshness({
        provider: "manual",
        lastCsvImportAt: importedAt,
        dataThrough,
        now,
      }).status
    ).toBe("stale");
  });

  it("leaves accounts without an import as manual", () => {
    expect(getAccountFreshness({ provider: "manual", now })).toEqual({
      source: "manual",
      status: "manual",
      lastUpdatedAt: null,
      dataThrough: null,
    });
  });
});
