import {
  ASSET_CATEGORY_COLORS,
  ASSET_CATEGORY_LABELS,
  ASSET_CATEGORY_ORDER,
  getAssetCategory,
  type AssetCategoryKey,
} from "@/lib/assets/asset-category";
import { isLiabilityAccountType } from "@/lib/constants/account-types";

export type NetWorthEntrySource = "account" | "property" | "vehicle" | "portfolio";

export interface NetWorthEntry {
  id: string;
  name: string;
  institution: string | null;
  value: number | string | null | undefined;
  currency?: string | null;
  source: NetWorthEntrySource;
  accountType?: string | null;
  isSuperannuation?: boolean;
  includeInNetWorth?: boolean | null;
}

export interface NetWorthAssetAccount {
  id: string;
  name: string;
  institution: string | null;
  value: number;
  percentage: number;
  currency: string;
  initial: string;
}

export interface NetWorthLiability {
  id: string;
  name: string;
  institution: string | null;
  value: number;
  currency: string;
  initial: string;
  source: NetWorthEntrySource;
  accountType?: string | null;
}

export interface NetWorthAssetCategory {
  key: AssetCategoryKey;
  label: string;
  color: string;
  value: number;
  percentage: number;
  isActive: boolean;
  accounts: NetWorthAssetAccount[];
}

export interface NetWorthSuperannuation {
  includedValue: number;
  excludedValue: number;
  includedAccounts: NetWorthAssetAccount[];
  excludedAccounts: NetWorthAssetAccount[];
}

export interface NetWorthOverview {
  total: number;
  grossAssets: number;
  totalLiabilities: number;
  netWorth: number;
  currency: string;
  categories: NetWorthAssetCategory[];
  liabilities: NetWorthLiability[];
  superannuation: NetWorthSuperannuation;
}

function parseAmount(value: NetWorthEntry["value"]): number {
  const parsed = typeof value === "number" ? value : parseFloat(value || "0");
  return Number.isFinite(parsed) ? parsed : 0;
}

function getInitial(name: string): string {
  return name.charAt(0).toUpperCase();
}

function getEntryAssetCategory(entry: NetWorthEntry): AssetCategoryKey {
  if (entry.source === "property") return "property";
  if (entry.source === "vehicle") return "vehicle";
  if (entry.source === "portfolio") return "investment";
  return getAssetCategory(entry.accountType);
}

function buildEmptyCategories(): NetWorthAssetCategory[] {
  return ASSET_CATEGORY_ORDER.map((key) => ({
    key,
    label: ASSET_CATEGORY_LABELS[key],
    color: ASSET_CATEGORY_COLORS[key],
    value: 0,
    percentage: 0,
    isActive: false,
    accounts: [],
  }));
}

function buildEmptySuperannuation(): NetWorthSuperannuation {
  return {
    includedValue: 0,
    excludedValue: 0,
    includedAccounts: [],
    excludedAccounts: [],
  };
}

export function emptyNetWorthOverview(currency = "EUR"): NetWorthOverview {
  return {
    total: 0,
    grossAssets: 0,
    totalLiabilities: 0,
    netWorth: 0,
    currency,
    categories: buildEmptyCategories(),
    liabilities: [],
    superannuation: buildEmptySuperannuation(),
  };
}

export function calculateNetWorthOverview(
  entries: NetWorthEntry[],
  currency: string,
): NetWorthOverview {
  const categoryMap = new Map<AssetCategoryKey, NetWorthAssetAccount[]>();
  const liabilities: NetWorthLiability[] = [];
  const superannuation = buildEmptySuperannuation();
  let grossAssets = 0;
  let totalLiabilities = 0;

  for (const entry of entries) {
    const value = parseAmount(entry.value);
    if (value === 0) continue;

    const isExcludedSuper = entry.isSuperannuation && entry.includeInNetWorth === false;
    if (isExcludedSuper) {
      const account = {
        id: entry.id,
        name: entry.name,
        institution: entry.institution,
        value,
        percentage: 0,
        currency: entry.currency || currency,
        initial: getInitial(entry.name),
      };
      superannuation.excludedValue += value;
      superannuation.excludedAccounts.push(account);
      continue;
    }

    const liability = value < 0 || (
      entry.source === "account" &&
      isLiabilityAccountType(entry.accountType)
    );

    if (liability) {
      const liabilityValue = Math.abs(value);
      totalLiabilities += liabilityValue;
      liabilities.push({
        id: entry.id,
        name: entry.name,
        institution: entry.institution,
        value: liabilityValue,
        currency: entry.currency || currency,
        initial: getInitial(entry.name),
        source: entry.source,
        accountType: entry.accountType,
      });
      continue;
    }

    if (value > 0) {
      if (entry.isSuperannuation) {
        const account = {
          id: entry.id,
          name: entry.name,
          institution: entry.institution,
          value,
          percentage: 0,
          currency: entry.currency || currency,
          initial: getInitial(entry.name),
        };
        superannuation.includedValue += value;
        superannuation.includedAccounts.push(account);
        grossAssets += value;
        continue;
      }

      const category = getEntryAssetCategory(entry);
      grossAssets += value;

      if (!categoryMap.has(category)) {
        categoryMap.set(category, []);
      }

      categoryMap.get(category)!.push({
        id: entry.id,
        name: entry.name,
        institution: entry.institution,
        value,
        percentage: 0,
        currency: entry.currency || currency,
        initial: getInitial(entry.name),
      });
    }
  }

  const categories = ASSET_CATEGORY_ORDER.map((key) => {
    const accountsInCategory = categoryMap.get(key) || [];
    const categoryValue = accountsInCategory.reduce((sum, account) => sum + account.value, 0);
    const accountsWithPercentages = accountsInCategory
      .map((account) => ({
        ...account,
        percentage: categoryValue > 0 ? (account.value / categoryValue) * 100 : 0,
      }))
      .sort((a, b) => b.value - a.value);

    return {
      key,
      label: ASSET_CATEGORY_LABELS[key],
      color: ASSET_CATEGORY_COLORS[key],
      value: categoryValue,
      percentage: grossAssets > 0 ? (categoryValue / grossAssets) * 100 : 0,
      isActive: categoryValue > 0,
      accounts: accountsWithPercentages,
    };
  });

  const superAccountsWithPercentages = (accounts: NetWorthAssetAccount[], total: number) =>
    accounts
      .map((account) => ({
        ...account,
        percentage: total > 0 ? (account.value / total) * 100 : 0,
      }))
      .sort((a, b) => b.value - a.value);

  superannuation.includedAccounts = superAccountsWithPercentages(
    superannuation.includedAccounts,
    superannuation.includedValue,
  );
  superannuation.excludedAccounts = superAccountsWithPercentages(
    superannuation.excludedAccounts,
    superannuation.excludedValue,
  );

  liabilities.sort((a, b) => b.value - a.value);

  const netWorth = grossAssets - totalLiabilities;
  return {
    total: netWorth,
    grossAssets,
    totalLiabilities,
    netWorth,
    currency,
    categories,
    liabilities,
    superannuation,
  };
}
