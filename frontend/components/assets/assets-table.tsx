"use client";

import { useState } from "react";
import { RiArrowDownSLine, RiArrowRightSLine } from "@remixicon/react";
import { cn, formatCurrency } from "@/lib/utils";
import { WeightBarVisualizer } from "./weight-bar-visualizer";
import type { AssetCategory, AssetAccount, AssetCategoryKey, AssetLiability } from "./types";
import type { NetWorthSuperannuation } from "@/lib/net-worth/calculation";

interface AssetsTableProps {
  categories: AssetCategory[];
  currency: string;
  liabilities?: AssetLiability[];
  superannuation: NetWorthSuperannuation;
}

// Asset categories that are bank accounts (navigable to account detail)
const ACCOUNT_CATEGORY_KEYS: AssetCategoryKey[] = [
  "cash",
  "savings",
  "investment",
  "crypto",
];
const LIABILITY_COLOR = "var(--destructive)";
type AccountRowData = AssetAccount | AssetLiability;

function AccountRow({
  account,
  currency,
  color,
  isLinkable = false,
  categoryKey,
  showWeight = true,
  displayMagnitude = false,
  descriptor,
}: {
  account: AccountRowData;
  currency: string;
  color: string;
  isLinkable?: boolean;
  categoryKey?: AssetCategoryKey;
  showWeight?: boolean;
  displayMagnitude?: boolean;
  descriptor?: string;
}) {
  const handleClick = () => {
    if (!isLinkable) return;
    if (categoryKey === "investment") {
      window.location.href = `/investments`;
    } else {
      window.location.href = `/accounts/${account.id}`;
    }
  };
  const displayedValue = displayMagnitude ? Math.abs(account.value) : account.value;
  const percentage = "percentage" in account ? account.percentage : 0;

  return (
    <div
      className={cn(
        "grid grid-cols-[minmax(0,1fr)_6.5rem] gap-3 border-t border-border/50 py-2 pl-8 pr-4 sm:grid-cols-[minmax(0,1fr)_9rem_7rem]",
        isLinkable && "cursor-pointer transition-colors hover:bg-muted/50"
      )}
      onClick={handleClick}
    >
      <div className="flex min-w-0 flex-1 items-center gap-2">
        <div
          className="h-3 w-3 shrink-0 rounded-sm"
          style={{ backgroundColor: color }}
        />
        <div className="min-w-0 truncate">
          <span className="text-sm">{account.name}</span>
          {account.institution && (
            <span className="text-xs text-muted-foreground ml-2">
              {account.institution}
            </span>
          )}
        </div>
      </div>
      <div className="hidden items-center justify-end gap-2 sm:flex">
        {showWeight ? (
          <>
            <WeightBarVisualizer percentage={percentage} color={color} />
            <span className="w-12 text-right text-sm text-muted-foreground">
              {percentage.toFixed(0)}%
            </span>
          </>
        ) : (
          <span className="text-sm text-muted-foreground">{descriptor}</span>
        )}
      </div>
      <div className="min-w-0 text-right">
        <span className="whitespace-nowrap text-sm font-medium tabular-nums">
          {formatCurrency(displayedValue, currency)}
        </span>
      </div>
    </div>
  );
}

function CategoryRow({
  category,
  currency,
  defaultOpen = false,
}: {
  category: AssetCategory;
  currency: string;
  defaultOpen?: boolean;
}) {
  const [isOpen, setIsOpen] = useState(defaultOpen);
  const hasAccounts = category.accounts.length > 0;

  if (!category.isActive) {
    return (
      <div className="grid grid-cols-[minmax(0,1fr)_6.5rem] gap-3 py-3 px-4 border-t sm:grid-cols-[minmax(0,1fr)_9rem_7rem]">
        <div className="flex min-w-0 items-center gap-2">
          <div className="w-4 h-4" /> {/* Spacer for alignment */}
          <span className="truncate text-sm text-muted-foreground">
            {category.label}
          </span>
        </div>
        <span className="hidden text-right text-sm text-muted-foreground sm:block">
          -
        </span>
        <div className="min-w-0 text-right">
          <span className="whitespace-nowrap text-sm text-muted-foreground tabular-nums">
            {formatCurrency(0, currency)}
          </span>
        </div>
      </div>
    );
  }

  return (
    <div>
      <div
        className="grid grid-cols-[minmax(0,1fr)_6.5rem] gap-3 py-3 px-4 border-t cursor-pointer hover:bg-muted/50 transition-colors sm:grid-cols-[minmax(0,1fr)_9rem_7rem]"
        onClick={() => hasAccounts && setIsOpen(!isOpen)}
      >
        <div className="flex min-w-0 items-center gap-2">
          {hasAccounts ? (
            isOpen ? (
              <RiArrowDownSLine className="h-4 w-4 text-muted-foreground" />
            ) : (
              <RiArrowRightSLine className="h-4 w-4 text-muted-foreground" />
            )
          ) : (
            <div className="w-4 h-4" />
          )}
          <span className="truncate text-sm font-medium">{category.label}</span>
        </div>
        <div className="hidden items-center justify-end gap-2 sm:flex">
          <WeightBarVisualizer
            percentage={category.percentage}
            color={category.color}
          />
          <span className="w-12 text-right text-sm text-muted-foreground">
            {category.percentage.toFixed(0)}%
          </span>
        </div>
        <div className="min-w-0 text-right">
          <span className="whitespace-nowrap text-sm font-medium tabular-nums">
            {formatCurrency(category.value, currency)}
          </span>
        </div>
      </div>
      {hasAccounts && isOpen && (
        <div>
          {category.accounts.map((account) => (
            <AccountRow
              key={account.id}
              account={account}
              currency={currency}
              color={category.color}
              isLinkable={ACCOUNT_CATEGORY_KEYS.includes(category.key)}
              categoryKey={category.key}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function LiabilitiesSection({
  liabilities,
  currency,
}: {
  liabilities: AssetLiability[];
  currency: string;
}) {
  if (liabilities.length === 0) {
    return null;
  }

  return (
    <>
      <div className="border-t bg-muted/30 px-4 py-2 text-xs font-medium uppercase tracking-wider text-muted-foreground">
        Liabilities
      </div>
      {liabilities.map((account) => (
        <AccountRow
          key={account.id}
          account={account}
          currency={currency}
          color={LIABILITY_COLOR}
          isLinkable={account.source === "account"}
          showWeight={false}
          displayMagnitude
          descriptor="Balance owed"
        />
      ))}
    </>
  );
}

function SuperannuationSection({
  superannuation,
  currency,
}: {
  superannuation: NetWorthSuperannuation;
  currency: string;
}) {
  const hasIncluded = superannuation.includedAccounts.length > 0;
  const hasExcluded = superannuation.excludedAccounts.length > 0;

  if (!hasIncluded && !hasExcluded) {
    return null;
  }

  return (
    <>
      <div className="border-t bg-muted/30 px-4 py-2 text-xs font-medium uppercase tracking-wider text-muted-foreground">
        Superannuation
      </div>
      {hasIncluded && (
        <>
          <div className="grid grid-cols-[minmax(0,1fr)_6.5rem] gap-3 border-t px-4 py-2 text-xs text-muted-foreground sm:grid-cols-[minmax(0,1fr)_9rem_7rem]">
            <span>Included in net worth</span>
            <span className="hidden sm:block" />
            <span className="text-right tabular-nums">{formatCurrency(superannuation.includedValue, currency)}</span>
          </div>
          {superannuation.includedAccounts.map((account) => (
            <AccountRow
              key={account.id}
              account={account}
              currency={currency}
              color="#14B8A6"
              isLinkable
              categoryKey="other"
              showWeight={false}
              descriptor="Included"
            />
          ))}
        </>
      )}
      {hasExcluded && (
        <>
          <div className="grid grid-cols-[minmax(0,1fr)_6.5rem] gap-3 border-t px-4 py-2 text-xs text-muted-foreground sm:grid-cols-[minmax(0,1fr)_9rem_7rem]">
            <span>Excluded from net worth</span>
            <span className="hidden sm:block" />
            <span className="text-right tabular-nums">{formatCurrency(superannuation.excludedValue, currency)}</span>
          </div>
          {superannuation.excludedAccounts.map((account) => (
            <AccountRow
              key={account.id}
              account={account}
              currency={currency}
              color="#94A3B8"
              isLinkable
              categoryKey="other"
              showWeight={false}
              descriptor="Excluded"
            />
          ))}
        </>
      )}
    </>
  );
}

export function AssetsTable({
  categories,
  currency,
  liabilities = [],
  superannuation,
}: AssetsTableProps) {
  return (
    <div className="rounded-md border">
      <div className="grid grid-cols-[minmax(0,1fr)_6.5rem] gap-3 py-2 px-4 text-xs font-medium text-muted-foreground uppercase tracking-wider sm:grid-cols-[minmax(0,1fr)_9rem_7rem]">
        <div>Name</div>
        <div className="hidden text-right sm:block">Asset allocation</div>
        <div className="text-right">Value</div>
      </div>

      {categories.map((category, index) => (
        <CategoryRow
          key={category.key}
          category={category}
          currency={currency}
          defaultOpen={index === 0 && category.isActive}
        />
      ))}
      <SuperannuationSection superannuation={superannuation} currency={currency} />
      <LiabilitiesSection liabilities={liabilities} currency={currency} />
    </div>
  );
}
