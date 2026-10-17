"use client";

import { getLiabilityMagnitude } from "@/lib/properties/equity";
import { cn } from "@/lib/utils";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
import { AccountLogo } from "@/components/ui/account-logo";
import type { Account } from "@/lib/db/schema";
import { getAccountTypeLabel, isLiabilityAccountType } from "@/lib/constants/account-types";
import { AccountFreshnessIndicator } from "./account-freshness";
import type { AccountFreshness } from "@/lib/account-freshness";

interface AccountHeaderProps {
  account: Account & {
    logo?: {
      id: string;
      logoUrl: string | null;
      updatedAt?: Date | null;
    } | null;
  };
  currency: string;
  freshness: AccountFreshness;
  onUploadCsv?: () => void;
}

function formatCurrency(value: string | null, currency: string): string {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: currency || "EUR",
  }).format(parseFloat(value || "0"));
}

export function AccountHeader({ account, currency, freshness, onUploadCsv }: AccountHeaderProps) {
  const typeLabel = getAccountTypeLabel(account.accountType);
  const isLiability = isLiabilityAccountType(account.accountType);

  return (
    <Card>
      <CardContent className="flex items-center justify-between p-6">
        <div className="flex items-center gap-4">
          <AccountLogo
            name={account.name}
            logoUrl={account.logo?.logoUrl}
            updatedAt={account.logo?.updatedAt}
            className="!size-12"
          />
          <div className="space-y-1">
            <div className="flex items-center gap-2">
              <h2 className="text-lg font-semibold">{account.name}</h2>
              <Badge variant="secondary">{typeLabel}</Badge>
            </div>
            <div className="flex items-center gap-2 text-sm text-muted-foreground">
              {account.institution && (
                <>
                  <span>{account.institution}</span>
                  <span>-</span>
                </>
              )}
              <AccountFreshnessIndicator freshness={freshness} onUploadCsv={onUploadCsv} />
            </div>
            {isLiability && (
              <div className="flex flex-wrap gap-2 text-xs text-muted-foreground">
                {account.liabilityInterestRate && (
                  <span>{account.liabilityInterestRate}% interest</span>
                )}
                {account.liabilityRepaymentAmount && (
                  <span>
                    {formatCurrency(account.liabilityRepaymentAmount, currency)}
                    {account.liabilityRepaymentFrequency
                      ? ` ${account.liabilityRepaymentFrequency}`
                      : " repayment"}
                  </span>
                )}
                {account.liabilityLoanTermMonths && (
                  <span>{account.liabilityLoanTermMonths} month term</span>
                )}
                {typeof account.liabilitySecured === "boolean" && (
                  <span>{account.liabilitySecured ? "Secured" : "Unsecured"}</span>
                )}
              </div>
            )}
          </div>
        </div>
        <div className="text-right">
          <p className={cn("font-mono text-2xl font-semibold", isLiability && "text-red-600 dark:text-red-400")}>
            {formatCurrency(isLiability ? (-getLiabilityMagnitude(account)).toString() : account.functionalBalance, currency)}
          </p>
          <p className="text-sm text-muted-foreground">
            {isLiability ? "Balance owed" : currency}
          </p>
        </div>
      </CardContent>
    </Card>
  );
}
