export const ACCOUNT_FRESHNESS_STALE_DAYS = 45;

export type AccountFreshnessSource = "up" | "api" | "csv" | "manual";
export type AccountFreshnessStatus = "current" | "stale" | "needs_update" | "manual";

export interface AccountFreshnessInput {
  provider?: string | null;
  lastSyncedAt?: Date | null;
  lastCsvImportAt?: Date | null;
  dataThrough?: Date | null;
  now?: Date;
}

export interface AccountFreshness {
  source: AccountFreshnessSource;
  status: AccountFreshnessStatus;
  lastUpdatedAt: Date | null;
  dataThrough: Date | null;
}

function isOlderThanDays(date: Date, now: Date, days: number): boolean {
  return now.getTime() - date.getTime() > days * 24 * 60 * 60 * 1000;
}

/**
 * Builds the user-facing freshness state for an account.
 *
 * API-backed accounts are judged by their last successful sync. CSV-backed
 * accounts are judged by the date their imported data reaches, since a file
 * can be uploaded today while still containing old transactions.
 */
export function getAccountFreshness({
  provider,
  lastSyncedAt = null,
  lastCsvImportAt = null,
  dataThrough = null,
  now = new Date(),
}: AccountFreshnessInput): AccountFreshness {
  if (lastSyncedAt) {
    const source: AccountFreshnessSource = provider === "up" ? "up" : "api";
    return {
      source,
      status: isOlderThanDays(lastSyncedAt, now, ACCOUNT_FRESHNESS_STALE_DAYS)
        ? "stale"
        : "current",
      lastUpdatedAt: lastSyncedAt,
      dataThrough,
    };
  }

  if (lastCsvImportAt) {
    const referenceDate = dataThrough ?? lastCsvImportAt;
    return {
      source: "csv",
      status: isOlderThanDays(referenceDate, now, ACCOUNT_FRESHNESS_STALE_DAYS)
        ? "stale"
        : "current",
      lastUpdatedAt: lastCsvImportAt,
      dataThrough,
    };
  }

  return {
    source: "manual",
    status: "manual",
    lastUpdatedAt: null,
    dataThrough,
  };
}
