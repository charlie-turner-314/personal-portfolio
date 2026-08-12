import {
  ASSET_CATEGORY_COLORS,
  ASSET_CATEGORY_LABELS,
  ASSET_CATEGORY_ORDER,
  getAssetCategory,
  type AssetCategoryKey,
} from "@/lib/assets/asset-category";

export type NetWorthEntrySource = "account" | "property" | "vehicle" | "portfolio";

export interface NetWorthEntry {
  id: string;
  name: string;
  institution: string | null;
  value: number | string | null | undefined;
  currency?: string | null;
  source: NetWorthEntrySource;
  accountType?: string | null;
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

export interface NetWorthOverview {
  total: number;
  grossAssets: number;
  totalLiabilities: number;
  netWorth: number;
  currency: string;
  categories: NetWorthAssetCategory[];
  liabilities: NetWorthLiability[];
}

export const LIABILITY_ACCOUNT_TYPES = new Set([
  "credit",
  "credit_card",
  "loan",
  "mortgage",
  "line_of_credit",
]);

function parseAmount(value: NetWorthEntry["value"]): number {
  const parsed = typeof value === "number" ? value : parseFloat(value || "0");
  return Number.isFinite(parsed) ? parsed : 0;
}

function getInitial(name: string): string {
  return name.charAt(0).toUpperCase();
}

function isLiabilityAccountType(accountType: string | null | undefined): boolean {
  return accountType ? LIABILITY_ACCOUNT_TYPES.has(accountType.toLowerCase()) : false;
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

export function emptyNetWorthOverview(currency = "EUR"): NetWorthOverview {
  return {
    total: 0,
    grossAssets: 0,
    totalLiabilities: 0,
    netWorth: 0,
    currency,
    categories: buildEmptyCategories(),
    liabilities: [],
  };
}

export function calculateNetWorthOverview(
  entries: NetWorthEntry[],
  currency: string,
): NetWorthOverview {
  const categoryMap = new Map<AssetCategoryKey, NetWorthAssetAccount[]>();
  const liabilities: NetWorthLiability[] = [];
  let grossAssets = 0;
  let totalLiabilities = 0;

  for (const entry of entries) {
    const value = parseAmount(entry.value);
    if (value === 0) continue;

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
  };
}
