import { isLiabilityAccountType } from "@/lib/constants/account-types";

export interface PropertyEquityAccount {
  id: string;
  accountType?: string | null;
  functionalBalance?: string | number | null;
  startingBalance?: string | number | null;
}

export interface PropertyEquityLink {
  propertyId: string;
  accountId: string;
}

export interface PropertyValueInput {
  id: string;
  currentValue?: string | number | null;
}

export interface PropertyEquityResult {
  propertyId: string;
  grossValue: number;
  linkedDebt: number;
  equity: number;
}

function parseMoney(value: string | number | null | undefined): number {
  const parsed = typeof value === "number" ? value : parseFloat(value || "0");
  return Number.isFinite(parsed) ? parsed : 0;
}

export function getLiabilityMagnitude(account: PropertyEquityAccount): number {
  if (!isLiabilityAccountType(account.accountType)) return 0;
  const balance = account.functionalBalance ?? account.startingBalance;
  return Math.abs(parseMoney(balance));
}

export function calculatePropertyEquity(
  property: PropertyValueInput,
  accounts: PropertyEquityAccount[],
  links: PropertyEquityLink[],
): PropertyEquityResult {
  const accountById = new Map(accounts.map((account) => [account.id, account]));
  const linkedDebt = links
    .filter((link) => link.propertyId === property.id)
    .reduce((sum, link) => {
      const account = accountById.get(link.accountId);
      return sum + (account ? getLiabilityMagnitude(account) : 0);
    }, 0);
  const grossValue = parseMoney(property.currentValue);

  return {
    propertyId: property.id,
    grossValue,
    linkedDebt,
    equity: grossValue - linkedDebt,
  };
}

export function getLinkedLiabilityAccountIds(links: PropertyEquityLink[]): Set<string> {
  return new Set(links.map((link) => link.accountId));
}
