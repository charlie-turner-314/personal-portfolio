import { Suspense } from "react";
import { Header } from "@/components/layout/header";
import { BudgetClient } from "@/components/budget/budget-client";
import { CardGridSkeleton, TableSkeleton } from "@/components/skeletons/page-skeletons";
import { getBudgetData } from "@/lib/actions/budget";
import { getUserAccounts } from "@/lib/actions/transactions";
import {
  getBudgetPlannedExpenseSummary,
  getPlannedExpenseFormOptions,
} from "@/lib/actions/planned-expenses";

interface BudgetPageProps {
  searchParams: Promise<{
    [key: string]: string | string[] | undefined;
  }>;
}

export default async function BudgetPage({ searchParams }: BudgetPageProps) {
  const params = await searchParams;
  const month = typeof params.month === "string" ? params.month : undefined;
  const accountIds = normalizeAccountIds(params.account);

  return (
    <>
      <Header title="Budget" />
      <Suspense
        key={`${month ?? "current"}:${accountIds.join(",")}`}
        fallback={
          <div className="flex flex-1 flex-col gap-4 p-4 pt-0">
            <CardGridSkeleton count={4} />
            <TableSkeleton rows={8} />
          </div>
        }
      >
        <BudgetSection month={month} accountIds={accountIds} />
      </Suspense>
    </>
  );
}

function normalizeAccountIds(value: string | string[] | undefined): string[] {
  if (!value) {
    return [];
  }

  const values = Array.isArray(value) ? value : [value];
  return Array.from(
    new Set(
      values
        .flatMap((entry) => entry.split(","))
        .map((entry) => entry.trim())
        .filter(Boolean)
    )
  );
}

async function BudgetSection({
  month,
  accountIds,
}: {
  month?: string;
  accountIds: string[];
}) {
  let data;
  let accounts;
  let plannedExpenses;
  let plannedExpenseOptions;

  try {
    [data, accounts, plannedExpenses, plannedExpenseOptions] = await Promise.all([
      getBudgetData(month, { accountIds }),
      getUserAccounts(),
      getBudgetPlannedExpenseSummary(month, { accountIds }),
      getPlannedExpenseFormOptions(),
    ]);
  } catch (error) {
    console.error("[budget] Failed to load budget data", {
      month: month ?? "current",
      accountCount: accountIds.length,
      error,
    });
    throw error;
  }

  return (
    <BudgetClient
      data={data}
      accounts={accounts}
      plannedExpenses={plannedExpenses}
      plannedExpenseOptions={plannedExpenseOptions}
    />
  );
}
