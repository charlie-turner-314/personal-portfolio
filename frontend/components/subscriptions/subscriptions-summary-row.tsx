"use client";

import type { SubscriptionOrSuggestion } from "./subscriptions-client";
import { formatCurrency } from "@/lib/utils";
import { calculateMonthlyEquivalent } from "./subscription-math";

interface SubscriptionsSummaryRowProps {
  data: SubscriptionOrSuggestion[];
  currency: string;
  locale: string;
}

export function SubscriptionsSummaryRow({
  data,
  currency,
  locale,
}: SubscriptionsSummaryRowProps) {
  // Only sum active subscriptions (exclude suggestions)
  const activeSubscriptions = data.filter((s) => !s.isSuggestion && s.isActive);

  const monthlyTotal = activeSubscriptions.reduce((sum, subscription) => {
    return sum + calculateMonthlyEquivalent(subscription);
  }, 0);

  return (
    <div className="border-t bg-muted/30 px-4 py-3 flex items-center justify-between">
      <span className="text-sm font-medium text-muted-foreground">
        Monthly Total
      </span>
      <span className="text-sm font-mono font-semibold">
        {formatCurrency(monthlyTotal, currency, {
          minimumFractionDigits: 2,
          maximumFractionDigits: 2,
          locale,
        })}
      </span>
    </div>
  );
}
