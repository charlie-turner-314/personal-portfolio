"use client";

import { Fragment, useEffect, useMemo, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import {
  RiAddLine,
  RiArrowDownSLine,
  RiArrowGoBackLine,
  RiArrowLeftSLine,
  RiArrowRightSLine,
  RiDeleteBinLine,
  RiEditLine,
  RiExternalLinkLine,
  RiFileCopyLine,
  RiInformationLine,
  RiLink,
  RiSaveLine,
} from "@remixicon/react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { Progress } from "@/components/ui/progress";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  copyPreviousMonthBudget,
  saveBudgetLines,
  type BudgetData,
} from "@/lib/actions/budget";
import {
  createPlannedExpense,
  deletePlannedExpense,
  findTransactionsForPlannedExpense,
  linkTransactionToPlannedExpense,
  updatePlannedExpense,
  type BudgetPlannedExpenseSummary,
  type PlannedExpenseFormOptions,
  type PlannedExpenseInput,
  type PlannedExpenseListItem,
  type PlannedExpenseRecurrence,
  type PlannedExpenseTransactionCandidate,
} from "@/lib/actions/planned-expenses";
import { cn } from "@/lib/utils";

interface BudgetClientProps {
  data: BudgetData;
  accounts: BudgetAccount[];
  plannedExpenses: BudgetPlannedExpenseSummary;
  plannedExpenseOptions: PlannedExpenseFormOptions;
}

interface BudgetAccount {
  id: string;
  name: string;
  institution: string | null;
  accountType: string;
}

type EditableLine = BudgetData["lines"][number] & {
  plannedInput: string;
  notesInput: string;
};
type BudgetInsight = NonNullable<BudgetData["lines"][number]["insight"]>;
type PlannedExpenseFormState = {
  id: string | null;
  name: string;
  amount: string;
  categoryId: string;
  accountId: string;
  dueDate: string;
  recurrenceType: PlannedExpenseRecurrence;
  customIntervalMonths: string;
  sinkingFundTargetAmount: string;
  sinkingFundStartDate: string;
  notes: string;
};

function formatCurrency(value: number, currency: string): string {
  return new Intl.NumberFormat(undefined, {
    style: "currency",
    currency,
    maximumFractionDigits: 0,
  }).format(value);
}

function formatMonth(monthKey: string): string {
  return new Date(`${monthKey}-01T00:00:00`).toLocaleDateString(undefined, {
    month: "long",
    year: "numeric",
  });
}

function addMonths(monthKey: string, offset: number): string {
  const year = Number(monthKey.slice(0, 4));
  const monthIndex = Number(monthKey.slice(5, 7)) - 1;
  const date = new Date(year, monthIndex + offset, 1);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}`;
}

function monthEndDate(monthKey: string): string {
  const year = Number(monthKey.slice(0, 4));
  const monthIndex = Number(monthKey.slice(5, 7)) - 1;
  const date = new Date(year, monthIndex + 1, 0);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

function parseAmount(value: string): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.max(0, parsed) : 0;
}

function amountToInput(value: number): string {
  if (!value) {
    return "";
  }

  return String(Math.round(value * 100) / 100);
}

function todayDateKey(): string {
  return new Date().toISOString().slice(0, 10);
}

function defaultPlannedExpenseForm(
  options: PlannedExpenseFormOptions
): PlannedExpenseFormState {
  return {
    id: null,
    name: "",
    amount: "",
    categoryId: options.categories[0]?.id ?? "",
    accountId: options.accounts[0]?.id ?? "",
    dueDate: todayDateKey(),
    recurrenceType: "annual",
    customIntervalMonths: "",
    sinkingFundTargetAmount: "",
    sinkingFundStartDate: todayDateKey(),
    notes: "",
  };
}

function plannedExpenseToForm(item: PlannedExpenseListItem): PlannedExpenseFormState {
  return {
    id: item.id,
    name: item.name,
    amount: amountToInput(item.amount),
    categoryId: item.categoryId,
    accountId: item.accountId,
    dueDate: item.dueDate,
    recurrenceType: item.recurrenceType,
    customIntervalMonths: item.customIntervalMonths
      ? String(item.customIntervalMonths)
      : "",
    sinkingFundTargetAmount: amountToInput(item.sinkingFundTargetAmount),
    sinkingFundStartDate: item.sinkingFundStartDate,
    notes: item.notes ?? "",
  };
}

function recurrenceLabel(
  recurrenceType: PlannedExpenseRecurrence,
  customIntervalMonths: number | null
): string {
  if (recurrenceType === "one_off") return "One-off";
  if (recurrenceType === "monthly") return "Monthly";
  if (recurrenceType === "quarterly") return "Quarterly";
  if (recurrenceType === "annual") return "Annual";
  return customIntervalMonths ? `Every ${customIntervalMonths} months` : "Custom";
}

function formToPlannedExpenseInput(
  form: PlannedExpenseFormState
): PlannedExpenseInput {
  return {
    name: form.name,
    amount: parseAmount(form.amount),
    categoryId: form.categoryId,
    accountId: form.accountId,
    dueDate: form.dueDate,
    recurrenceType: form.recurrenceType,
    customIntervalMonths:
      form.recurrenceType === "custom" ? Number(form.customIntervalMonths) : null,
    sinkingFundTargetAmount:
      form.sinkingFundTargetAmount.trim() === ""
        ? parseAmount(form.amount)
        : parseAmount(form.sinkingFundTargetAmount),
    sinkingFundStartDate: form.sinkingFundStartDate,
    notes: form.notes,
    isActive: true,
  };
}

function driverLabel(driverType: BudgetInsight["driverType"]): string {
  if (driverType === "one_off") {
    return "One-off";
  }

  if (driverType === "recurring") {
    return "Recurring";
  }

  return "Mixed";
}

function BudgetInsightContent({
  insight,
  currency,
  onOpenTransactions,
}: {
  insight: BudgetInsight;
  currency: string;
  onOpenTransactions: () => void;
}) {
  return (
    <div className="border-t bg-muted/20 p-3">
      <div className="mb-3 flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <span className="text-xs font-medium">Why over budget</span>
            <Badge variant="outline">{driverLabel(insight.driverType)}</Badge>
          </div>
          <p className="mt-1 text-xs text-muted-foreground">{insight.explanation}</p>
        </div>
        <Button
          type="button"
          variant="ghost"
          size="icon-xs"
          aria-label={`View ${insight.categoryName} transactions`}
          onClick={onOpenTransactions}
        >
          <RiExternalLinkLine />
        </Button>
      </div>

      <div className="grid gap-2 text-xs sm:grid-cols-3">
        <div className="border bg-background p-2">
          <p className="text-muted-foreground">Over</p>
          <p className="mt-1 font-medium tabular-nums">
            {formatCurrency(insight.overspendAmount, currency)}
          </p>
        </div>
        <div className="border bg-background p-2">
          <p className="text-muted-foreground">3M Avg</p>
          <p className="mt-1 font-medium tabular-nums">
            {insight.previousThreeMonthAverage === null
              ? "No data"
              : formatCurrency(insight.previousThreeMonthAverage, currency)}
          </p>
        </div>
        <div className="border bg-background p-2">
          <p className="text-muted-foreground">Last Year</p>
          <p className="mt-1 font-medium tabular-nums">
            {insight.sameMonthLastYearAmount === null
              ? "No data"
              : formatCurrency(insight.sameMonthLastYearAmount, currency)}
          </p>
        </div>
      </div>

      <div className="mt-3 grid gap-3 md:grid-cols-2">
        <div>
          <p className="mb-2 flex items-center gap-1 text-xs font-medium">
            <RiInformationLine className="size-3 text-muted-foreground" />
            Top merchants
          </p>
          {insight.topMerchants.length === 0 ? (
            <p className="text-xs text-muted-foreground">No merchants</p>
          ) : (
            <div className="space-y-1">
              {insight.topMerchants.map((merchant) => (
                <button
                  type="button"
                  key={merchant.name}
                  className="flex w-full items-center justify-between gap-3 border bg-background px-2 py-1.5 text-left text-xs hover:bg-muted"
                  onClick={onOpenTransactions}
                >
                  <span className="min-w-0 truncate">{merchant.name}</span>
                  <span className="shrink-0 tabular-nums">
                    {formatCurrency(merchant.amount, currency)}
                  </span>
                </button>
              ))}
            </div>
          )}
        </div>

        <div>
          <p className="mb-2 flex items-center gap-1 text-xs font-medium">
            <RiInformationLine className="size-3 text-muted-foreground" />
            Biggest transactions
          </p>
          {insight.topTransactions.length === 0 ? (
            <p className="text-xs text-muted-foreground">No transactions</p>
          ) : (
            <div className="space-y-1">
              {insight.topTransactions.map((transaction) => (
                <button
                  type="button"
                  key={transaction.id}
                  className="grid w-full grid-cols-[minmax(0,1fr)_auto] gap-3 border bg-background px-2 py-1.5 text-left text-xs hover:bg-muted"
                  onClick={onOpenTransactions}
                >
                  <span className="min-w-0">
                    <span className="block truncate">
                      {transaction.merchant || transaction.description || "Transaction"}
                    </span>
                    <span className="block truncate text-muted-foreground">
                      {transaction.bookedAt}
                      {transaction.recurringName ? ` - ${transaction.recurringName}` : ""}
                    </span>
                  </span>
                  <span className="shrink-0 tabular-nums">
                    {formatCurrency(transaction.amount, currency)}
                  </span>
                </button>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function toEditableLines(data: BudgetData): EditableLine[] {
  return data.lines.map((line) => ({
    ...line,
    plannedInput: amountToInput(line.plannedAmount),
    notesInput: line.notes ?? "",
  }));
}

export function BudgetClient({
  data,
  accounts,
  plannedExpenses,
  plannedExpenseOptions,
}: BudgetClientProps) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const [accountsOpen, setAccountsOpen] = useState(false);
  const [lines, setLines] = useState<EditableLine[]>(() => toEditableLines(data));
  const [plannedExpenseForm, setPlannedExpenseForm] =
    useState<PlannedExpenseFormState>(() =>
      defaultPlannedExpenseForm(plannedExpenseOptions)
    );
  const [candidateExpenseId, setCandidateExpenseId] = useState<string | null>(null);
  const [transactionCandidates, setTransactionCandidates] = useState<
    PlannedExpenseTransactionCandidate[]
  >([]);

  useEffect(() => {
    setLines(toEditableLines(data));
  }, [data]);

  useEffect(() => {
    setPlannedExpenseForm((current) =>
      current.id ? current : defaultPlannedExpenseForm(plannedExpenseOptions)
    );
  }, [plannedExpenseOptions]);

  const totals = useMemo(() => {
    const plannedAmount = lines.reduce(
      (sum, line) => sum + parseAmount(line.plannedInput),
      0
    );
    const actualAmount = lines.reduce((sum, line) => sum + line.actualAmount, 0);
    const categoriesOverBudget = lines.filter((line) => {
      const planned = parseAmount(line.plannedInput);
      return planned > 0 && line.actualAmount > planned;
    }).length;

    return {
      plannedAmount,
      actualAmount,
      remainingAmount: plannedAmount - actualAmount,
      usedPct:
        plannedAmount > 0 ? Math.round((actualAmount / plannedAmount) * 100) : 0,
      categoriesOverBudget,
    };
  }, [lines]);

  const selectedAccountSet = useMemo(
    () => new Set(data.accountIds),
    [data.accountIds]
  );
  const isAllAccountsSelected = data.accountIds.length === 0;
  const accountTriggerText = isAllAccountsSelected ? "All accounts" : "Accounts";
  const actualScopeText = isAllAccountsSelected
    ? "Actuals include all accounts."
    : `Actuals filtered to ${data.accountIds.length} account${data.accountIds.length === 1 ? "" : "s"}.`;

  const buildBudgetPath = (monthKey: string, accountIds: string[]) => {
    const params = new URLSearchParams();
    params.set("month", monthKey);
    accountIds.forEach((accountId) => params.append("account", accountId));
    return `/budget?${params.toString()}`;
  };

  const navigateToMonth = (monthKey: string) => {
    router.push(buildBudgetPath(monthKey, data.accountIds));
  };

  const updateSelectedAccounts = (accountIds: string[]) => {
    router.push(buildBudgetPath(data.monthKey, accountIds), { scroll: false });
  };

  const toggleAccount = (accountId: string) => {
    if (selectedAccountSet.has(accountId)) {
      updateSelectedAccounts(data.accountIds.filter((id) => id !== accountId));
    } else {
      updateSelectedAccounts([...data.accountIds, accountId]);
    }
  };

  const openCategoryTransactions = (categoryId: string) => {
    const params = new URLSearchParams();
    params.set("category", categoryId);
    params.set("from", `${data.monthKey}-01`);
    params.set("to", monthEndDate(data.monthKey));
    params.set("analytics", "included");
    data.accountIds.forEach((accountId) => params.append("account", accountId));
    router.push(`/transactions?${params.toString()}`);
  };

  const updateLine = (
    categoryId: string,
    patch: Partial<Pick<EditableLine, "plannedInput" | "notesInput">>
  ) => {
    setLines((current) =>
      current.map((line) =>
        line.categoryId === categoryId ? { ...line, ...patch } : line
      )
    );
  };

  const handleSave = () => {
    startTransition(async () => {
      const result = await saveBudgetLines(
        data.monthKey,
        lines.map((line) => ({
          categoryId: line.categoryId,
          plannedAmount: parseAmount(line.plannedInput),
          notes: line.notesInput,
        }))
      );

      if (result.success) {
        toast.success("Budget saved");
        router.refresh();
      } else {
        toast.error(result.error || "Failed to save budget");
      }
    });
  };

  const handleCopyPreviousMonth = () => {
    const hasCurrentPlan = lines.some(
      (line) => parseAmount(line.plannedInput) > 0 || line.notesInput.trim()
    );

    if (
      hasCurrentPlan &&
      !window.confirm("Copying last month's budget will replace this month's plan.")
    ) {
      return;
    }

    startTransition(async () => {
      const result = await copyPreviousMonthBudget(data.monthKey);

      if (result.success) {
        if (result.copiedCount) {
          toast.success("Copied last month's budget");
        } else {
          toast.info("No previous budget found");
        }
        router.refresh();
      } else {
        toast.error(result.error || "Failed to copy previous budget");
      }
    });
  };

  const resetAllToActual = () => {
    setLines((current) =>
      current.map((line) => ({
        ...line,
        plannedInput: amountToInput(line.actualAmount),
      }))
    );
  };

  const resetLineToActual = (categoryId: string) => {
    setLines((current) =>
      current.map((line) =>
        line.categoryId === categoryId
          ? { ...line, plannedInput: amountToInput(line.actualAmount) }
          : line
      )
    );
  };

  const resetPlannedExpenseForm = () => {
    setPlannedExpenseForm(defaultPlannedExpenseForm(plannedExpenseOptions));
  };

  const editPlannedExpense = (item: PlannedExpenseListItem) => {
    setPlannedExpenseForm(plannedExpenseToForm(item));
  };

  const handleSavePlannedExpense = () => {
    startTransition(async () => {
      const payload = formToPlannedExpenseInput(plannedExpenseForm);
      const result = plannedExpenseForm.id
        ? await updatePlannedExpense(plannedExpenseForm.id, payload)
        : await createPlannedExpense(payload);

      if (result.success) {
        toast.success(
          plannedExpenseForm.id ? "Irregular expense updated" : "Irregular expense added"
        );
        resetPlannedExpenseForm();
        router.refresh();
      } else {
        toast.error(result.error || "Failed to save irregular expense");
      }
    });
  };

  const handleDeletePlannedExpense = (item: PlannedExpenseListItem) => {
    if (!window.confirm(`Delete ${item.name}? Linked payments will be removed.`)) {
      return;
    }

    startTransition(async () => {
      const result = await deletePlannedExpense(item.id);
      if (result.success) {
        toast.success("Irregular expense deleted");
        router.refresh();
      } else {
        toast.error(result.error || "Failed to delete irregular expense");
      }
    });
  };

  const handleFindTransactions = (item: PlannedExpenseListItem) => {
    if (candidateExpenseId === item.id) {
      setCandidateExpenseId(null);
      setTransactionCandidates([]);
      return;
    }

    startTransition(async () => {
      const candidates = await findTransactionsForPlannedExpense(
        item.id,
        item.nextDueDate ?? item.dueDate
      );
      setCandidateExpenseId(item.id);
      setTransactionCandidates(candidates);
    });
  };

  const handleLinkTransaction = (
    item: PlannedExpenseListItem,
    transactionId: string
  ) => {
    startTransition(async () => {
      const result = await linkTransactionToPlannedExpense({
        plannedExpenseId: item.id,
        transactionId,
        occurrenceDueDate: item.nextDueDate ?? item.dueDate,
      });

      if (result.success) {
        toast.success("Payment linked");
        setTransactionCandidates((current) =>
          current.filter((candidate) => candidate.id !== transactionId)
        );
        router.refresh();
      } else {
        toast.error(result.error || "Failed to link payment");
      }
    });
  };

  return (
    <div className="flex flex-1 flex-col gap-4 p-4 pt-0">
      <div className="flex flex-col gap-3 border-b pb-4 md:flex-row md:items-center md:justify-between">
        <div>
          <h1 className="text-base font-medium">{formatMonth(data.monthKey)}</h1>
          <p className="text-muted-foreground text-xs">
            Planned spending compared with categorized transactions. {actualScopeText}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {accounts.length > 0 && (
            <Popover open={accountsOpen} onOpenChange={setAccountsOpen}>
              <PopoverTrigger
                className={cn(
                  "flex h-8 w-[170px] items-center justify-between border border-input bg-transparent px-2.5 text-xs transition-colors hover:bg-muted"
                )}
              >
                <span className="truncate">{accountTriggerText}</span>
                <span className="flex shrink-0 items-center gap-1">
                  {!isAllAccountsSelected && (
                    <Badge
                      variant="outline"
                      className="h-4 min-w-4 px-1 text-[10px] leading-none"
                    >
                      {data.accountIds.length}
                    </Badge>
                  )}
                  <RiArrowDownSLine className="size-4 text-muted-foreground" />
                </span>
              </PopoverTrigger>
              <PopoverContent align="start" className="w-64 p-0">
                <div className="border-b p-1">
                  <button
                    type="button"
                    className="flex w-full items-center gap-2 px-2 py-1.5 text-xs hover:bg-accent"
                    onClick={() => updateSelectedAccounts([])}
                  >
                    <Checkbox
                      checked={isAllAccountsSelected}
                      className="pointer-events-none"
                    />
                    <span>All accounts ({accounts.length})</span>
                  </button>
                </div>
                <div className="max-h-56 overflow-y-auto p-1">
                  {accounts.map((account) => (
                    <button
                      key={account.id}
                      type="button"
                      className="flex w-full items-center gap-2 px-2 py-1.5 text-xs hover:bg-accent"
                      onClick={() => toggleAccount(account.id)}
                    >
                      <Checkbox
                        checked={selectedAccountSet.has(account.id)}
                        className="pointer-events-none"
                      />
                      <span className="truncate">{account.name}</span>
                    </button>
                  ))}
                </div>
              </PopoverContent>
            </Popover>
          )}
          <Button
            variant="outline"
            size="icon"
            aria-label="Previous month"
            onClick={() => navigateToMonth(addMonths(data.monthKey, -1))}
          >
            <RiArrowLeftSLine />
          </Button>
          <Input
            type="month"
            value={data.monthKey}
            onChange={(event) => navigateToMonth(event.target.value)}
            className="w-36"
          />
          <Button
            variant="outline"
            size="icon"
            aria-label="Next month"
            onClick={() => navigateToMonth(addMonths(data.monthKey, 1))}
          >
            <RiArrowRightSLine />
          </Button>
          <Button onClick={handleSave} disabled={isPending}>
            <RiSaveLine />
            {isPending ? "Saving" : "Save"}
          </Button>
          <Button
            type="button"
            variant="outline"
            onClick={handleCopyPreviousMonth}
            disabled={isPending}
          >
            <RiFileCopyLine />
            Copy Last
          </Button>
          <Button
            type="button"
            variant="outline"
            onClick={resetAllToActual}
            disabled={isPending || lines.length === 0}
          >
            <RiArrowGoBackLine />
            Reset Actual
          </Button>
        </div>
      </div>

      <div className="grid gap-4 md:grid-cols-4">
        <Card>
          <CardHeader>
            <CardTitle>Planned</CardTitle>
          </CardHeader>
          <CardContent className="text-lg font-medium tabular-nums">
            {formatCurrency(totals.plannedAmount, data.currency)}
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle>Actual</CardTitle>
          </CardHeader>
          <CardContent className="text-lg font-medium tabular-nums">
            {formatCurrency(totals.actualAmount, data.currency)}
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle>Remaining</CardTitle>
          </CardHeader>
          <CardContent
            className={cn(
              "text-lg font-medium tabular-nums",
              totals.remainingAmount < 0 && "text-destructive"
            )}
          >
            {formatCurrency(totals.remainingAmount, data.currency)}
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle>Over Budget</CardTitle>
          </CardHeader>
          <CardContent className="text-lg font-medium tabular-nums">
            {totals.categoriesOverBudget}
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Monthly Budget</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="mb-4">
            <div className="mb-2 flex items-center justify-between text-xs">
              <span className="text-muted-foreground">Total used</span>
              <span className="tabular-nums">{totals.usedPct}%</span>
            </div>
            <Progress value={Math.min(totals.usedPct, 100)} />
          </div>

          {lines.length === 0 ? (
            <div className="border border-dashed p-8 text-center text-xs text-muted-foreground">
              Add expense categories in Settings to start budgeting.
            </div>
          ) : (
            <>
              <div className="space-y-3 md:hidden">
                {lines.map((line) => {
                  const plannedAmount = parseAmount(line.plannedInput);
                  const remainingAmount = plannedAmount - line.actualAmount;
                  const usedPct =
                    plannedAmount > 0
                      ? Math.round((line.actualAmount / plannedAmount) * 100)
                      : 0;

                  return (
                    <div key={line.categoryId} className="border p-3">
                      <div className="mb-3 flex items-center justify-between gap-3">
                        <div className="flex min-w-0 items-center gap-2">
                          <span
                            className="size-2 shrink-0"
                            style={{
                              backgroundColor: line.categoryColor || "#71717a",
                            }}
                          />
                          <span className="truncate text-sm font-medium">
                            {line.categoryName}
                          </span>
                        </div>
                        <Button
                          type="button"
                          variant="ghost"
                          size="icon-xs"
                          aria-label={`View ${line.categoryName} transactions`}
                          onClick={() => openCategoryTransactions(line.categoryId)}
                        >
                          <RiExternalLinkLine />
                        </Button>
                      </div>

                      <div className="grid grid-cols-2 gap-3 text-xs">
                        <label className="space-y-1">
                          <span className="text-muted-foreground">Planned</span>
                          <Input
                            type="number"
                            min="0"
                            step="0.01"
                            value={line.plannedInput}
                            onChange={(event) =>
                              updateLine(line.categoryId, {
                                plannedInput: event.target.value,
                              })
                            }
                            className="text-right tabular-nums"
                            aria-label={`${line.categoryName} planned amount`}
                          />
                        </label>
                        <div className="space-y-1">
                          <span className="text-muted-foreground">Actual</span>
                          <button
                            type="button"
                            className="block h-8 w-full border px-2 text-right tabular-nums hover:bg-muted"
                            onClick={() => openCategoryTransactions(line.categoryId)}
                          >
                            {formatCurrency(line.actualAmount, data.currency)}
                          </button>
                        </div>
                        <div className="space-y-1">
                          <span className="text-muted-foreground">Remaining</span>
                          <div
                            className={cn(
                              "h-8 border px-2 py-2 text-right tabular-nums",
                              remainingAmount < 0 && "text-destructive"
                            )}
                          >
                            {formatCurrency(remainingAmount, data.currency)}
                          </div>
                        </div>
                        <div className="space-y-1">
                          <span className="text-muted-foreground">Used</span>
                          <div className="flex h-8 items-center gap-2">
                            <Progress
                              value={Math.min(usedPct, 100)}
                              className="min-w-0 flex-1"
                            />
                            <span className="w-10 text-right tabular-nums text-muted-foreground">
                              {usedPct}%
                            </span>
                          </div>
                        </div>
                      </div>

                      <div className="mt-3 flex gap-2">
                        <Input
                          value={line.notesInput}
                          onChange={(event) =>
                            updateLine(line.categoryId, {
                              notesInput: event.target.value,
                            })
                          }
                          placeholder="Optional note"
                          aria-label={`${line.categoryName} notes`}
                        />
                        <Button
                          type="button"
                          variant="outline"
                          size="icon"
                          aria-label={`Reset ${line.categoryName} to actual amount`}
                          onClick={() => resetLineToActual(line.categoryId)}
                        >
                          <RiArrowGoBackLine />
                        </Button>
                      </div>

                      {line.insight && (
                        <div className="mt-3">
                          <BudgetInsightContent
                            insight={line.insight}
                            currency={data.currency}
                            onOpenTransactions={() =>
                              openCategoryTransactions(line.categoryId)
                            }
                          />
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>

              <div className="hidden overflow-x-auto md:block">
                <Table className="min-w-[920px]">
                  <TableHeader>
                    <TableRow>
                      <TableHead>Category</TableHead>
                      <TableHead className="w-32 text-right">Planned</TableHead>
                      <TableHead className="w-36 text-right">Actual</TableHead>
                      <TableHead className="w-36">Used</TableHead>
                      <TableHead className="w-32 text-right">Remaining</TableHead>
                      <TableHead className="min-w-48">Notes</TableHead>
                      <TableHead className="w-20 text-right">Actions</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {lines.map((line) => {
                      const plannedAmount = parseAmount(line.plannedInput);
                      const remainingAmount = plannedAmount - line.actualAmount;
                      const usedPct =
                        plannedAmount > 0
                          ? Math.round((line.actualAmount / plannedAmount) * 100)
                          : 0;

                      return (
                        <Fragment key={line.categoryId}>
                          <TableRow>
                            <TableCell>
                              <div className="flex items-center gap-2">
                                <span
                                  className="size-2 shrink-0"
                                  style={{
                                    backgroundColor: line.categoryColor || "#71717a",
                                  }}
                                />
                                <span className="font-medium">{line.categoryName}</span>
                              </div>
                            </TableCell>
                            <TableCell>
                              <Input
                                type="number"
                                min="0"
                                step="0.01"
                                value={line.plannedInput}
                                onChange={(event) =>
                                  updateLine(line.categoryId, {
                                    plannedInput: event.target.value,
                                  })
                                }
                                className="text-right tabular-nums"
                                aria-label={`${line.categoryName} planned amount`}
                              />
                            </TableCell>
                            <TableCell className="text-right">
                              <Button
                                type="button"
                                variant="ghost"
                                className="ml-auto tabular-nums"
                                onClick={() => openCategoryTransactions(line.categoryId)}
                              >
                                {formatCurrency(line.actualAmount, data.currency)}
                                <RiExternalLinkLine data-icon="inline-end" />
                              </Button>
                            </TableCell>
                            <TableCell>
                              <div className="flex items-center gap-2">
                                <Progress
                                  value={Math.min(usedPct, 100)}
                                  className="min-w-20 flex-1"
                                />
                                <span className="w-10 text-right tabular-nums text-muted-foreground">
                                  {usedPct}%
                                </span>
                              </div>
                            </TableCell>
                            <TableCell
                              className={cn(
                                "text-right tabular-nums",
                                remainingAmount < 0 && "text-destructive"
                              )}
                            >
                              {formatCurrency(remainingAmount, data.currency)}
                            </TableCell>
                            <TableCell>
                              <Input
                                value={line.notesInput}
                                onChange={(event) =>
                                  updateLine(line.categoryId, {
                                    notesInput: event.target.value,
                                  })
                                }
                                placeholder="Optional"
                                aria-label={`${line.categoryName} notes`}
                              />
                            </TableCell>
                            <TableCell className="text-right">
                              <Button
                                type="button"
                                variant="outline"
                                size="icon-sm"
                                aria-label={`Reset ${line.categoryName} to actual amount`}
                                onClick={() => resetLineToActual(line.categoryId)}
                              >
                                <RiArrowGoBackLine />
                              </Button>
                            </TableCell>
                          </TableRow>
                          {line.insight && (
                            <TableRow>
                              <TableCell colSpan={7} className="p-0">
                                <BudgetInsightContent
                                  insight={line.insight}
                                  currency={data.currency}
                                  onOpenTransactions={() =>
                                    openCategoryTransactions(line.categoryId)
                                  }
                                />
                              </TableCell>
                            </TableRow>
                          )}
                        </Fragment>
                      );
                    })}
                  </TableBody>
                </Table>
              </div>
            </>
          )}
        </CardContent>
      </Card>

      <div className="grid gap-4 md:grid-cols-4">
        <Card>
          <CardHeader>
            <CardTitle>Lumpy Provision</CardTitle>
          </CardHeader>
          <CardContent className="text-lg font-medium tabular-nums">
            {formatCurrency(plannedExpenses.totals.monthlyProvision, data.currency)}
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle>Lumpy Paid</CardTitle>
          </CardHeader>
          <CardContent className="text-lg font-medium tabular-nums">
            {formatCurrency(plannedExpenses.totals.actualPaidThisMonth, data.currency)}
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle>Due This Month</CardTitle>
          </CardHeader>
          <CardContent className="text-lg font-medium tabular-nums">
            {formatCurrency(plannedExpenses.totals.upcomingAmountThisMonth, data.currency)}
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle>Active Items</CardTitle>
          </CardHeader>
          <CardContent className="text-lg font-medium tabular-nums">
            {plannedExpenses.totals.activeCount}
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Irregular Expenses</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid gap-3 border p-3 md:grid-cols-6">
            <Input
              value={plannedExpenseForm.name}
              onChange={(event) =>
                setPlannedExpenseForm((current) => ({
                  ...current,
                  name: event.target.value,
                }))
              }
              placeholder="Name"
              aria-label="Irregular expense name"
            />
            <Input
              type="number"
              min="0"
              step="0.01"
              value={plannedExpenseForm.amount}
              onChange={(event) =>
                setPlannedExpenseForm((current) => ({
                  ...current,
                  amount: event.target.value,
                }))
              }
              placeholder="Amount"
              aria-label="Irregular expense amount"
            />
            <select
              value={plannedExpenseForm.categoryId}
              onChange={(event) =>
                setPlannedExpenseForm((current) => ({
                  ...current,
                  categoryId: event.target.value,
                }))
              }
              className="h-8 border border-input bg-background px-2 text-xs"
              aria-label="Irregular expense category"
            >
              {plannedExpenseOptions.categories.map((category) => (
                <option key={category.id} value={category.id}>
                  {category.name}
                </option>
              ))}
            </select>
            <select
              value={plannedExpenseForm.accountId}
              onChange={(event) =>
                setPlannedExpenseForm((current) => ({
                  ...current,
                  accountId: event.target.value,
                }))
              }
              className="h-8 border border-input bg-background px-2 text-xs"
              aria-label="Irregular expense account"
            >
              {plannedExpenseOptions.accounts.map((account) => (
                <option key={account.id} value={account.id}>
                  {account.name}
                </option>
              ))}
            </select>
            <Input
              type="date"
              value={plannedExpenseForm.dueDate}
              onChange={(event) =>
                setPlannedExpenseForm((current) => ({
                  ...current,
                  dueDate: event.target.value,
                }))
              }
              aria-label="Irregular expense due date"
            />
            <select
              value={plannedExpenseForm.recurrenceType}
              onChange={(event) =>
                setPlannedExpenseForm((current) => ({
                  ...current,
                  recurrenceType: event.target.value as PlannedExpenseRecurrence,
                }))
              }
              className="h-8 border border-input bg-background px-2 text-xs"
              aria-label="Irregular expense recurrence"
            >
              <option value="one_off">One-off</option>
              <option value="monthly">Monthly</option>
              <option value="quarterly">Quarterly</option>
              <option value="annual">Annual</option>
              <option value="custom">Custom</option>
            </select>
            {plannedExpenseForm.recurrenceType === "custom" && (
              <Input
                type="number"
                min="1"
                max="120"
                value={plannedExpenseForm.customIntervalMonths}
                onChange={(event) =>
                  setPlannedExpenseForm((current) => ({
                    ...current,
                    customIntervalMonths: event.target.value,
                  }))
                }
                placeholder="Months"
                aria-label="Custom recurrence interval months"
              />
            )}
            <Input
              type="number"
              min="0"
              step="0.01"
              value={plannedExpenseForm.sinkingFundTargetAmount}
              onChange={(event) =>
                setPlannedExpenseForm((current) => ({
                  ...current,
                  sinkingFundTargetAmount: event.target.value,
                }))
              }
              placeholder="Target"
              aria-label="Sinking fund target"
            />
            <Input
              type="date"
              value={plannedExpenseForm.sinkingFundStartDate}
              onChange={(event) =>
                setPlannedExpenseForm((current) => ({
                  ...current,
                  sinkingFundStartDate: event.target.value,
                }))
              }
              aria-label="Sinking fund start date"
            />
            <Input
              value={plannedExpenseForm.notes}
              onChange={(event) =>
                setPlannedExpenseForm((current) => ({
                  ...current,
                  notes: event.target.value,
                }))
              }
              placeholder="Notes"
              aria-label="Irregular expense notes"
              className="md:col-span-2"
            />
            <div className="flex gap-2">
              <Button
                type="button"
                onClick={handleSavePlannedExpense}
                disabled={
                  isPending ||
                  plannedExpenseOptions.categories.length === 0 ||
                  plannedExpenseOptions.accounts.length === 0
                }
              >
                {plannedExpenseForm.id ? <RiSaveLine /> : <RiAddLine />}
                {plannedExpenseForm.id ? "Update" : "Add"}
              </Button>
              {plannedExpenseForm.id && (
                <Button type="button" variant="outline" onClick={resetPlannedExpenseForm}>
                  Cancel
                </Button>
              )}
            </div>
          </div>

          {plannedExpenses.items.length === 0 ? (
            <div className="border border-dashed p-8 text-center text-xs text-muted-foreground">
              Add annual bills, insurance, repairs, holidays, or other irregular costs.
            </div>
          ) : (
            <div className="overflow-x-auto">
              <Table className="min-w-[1040px]">
                <TableHeader>
                  <TableRow>
                    <TableHead>Name</TableHead>
                    <TableHead>Category</TableHead>
                    <TableHead>Account</TableHead>
                    <TableHead>Next Due</TableHead>
                    <TableHead>Recurrence</TableHead>
                    <TableHead className="text-right">Provision</TableHead>
                    <TableHead className="text-right">Paid</TableHead>
                    <TableHead className="text-right">Due</TableHead>
                    <TableHead className="w-56">Link Payment</TableHead>
                    <TableHead className="w-24 text-right">Actions</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {plannedExpenses.items.map((item) => (
                    <Fragment key={item.id}>
                      <TableRow>
                        <TableCell className="font-medium">{item.name}</TableCell>
                        <TableCell>{item.categoryName}</TableCell>
                        <TableCell>{item.accountName}</TableCell>
                        <TableCell className="tabular-nums">
                          {item.nextDueDate ?? item.dueDate}
                        </TableCell>
                        <TableCell>
                          {recurrenceLabel(item.recurrenceType, item.customIntervalMonths)}
                        </TableCell>
                        <TableCell className="text-right tabular-nums">
                          {formatCurrency(item.monthlyProvision, data.currency)}
                        </TableCell>
                        <TableCell className="text-right tabular-nums">
                          {formatCurrency(item.actualPaidThisMonth, data.currency)}
                        </TableCell>
                        <TableCell className="text-right tabular-nums">
                          {formatCurrency(item.upcomingAmountThisMonth, data.currency)}
                        </TableCell>
                        <TableCell>
                          <Button
                            type="button"
                            variant="outline"
                            size="sm"
                            onClick={() => handleFindTransactions(item)}
                            disabled={isPending}
                          >
                            <RiLink />
                            {candidateExpenseId === item.id ? "Hide" : "Find"}
                          </Button>
                        </TableCell>
                        <TableCell className="text-right">
                          <div className="flex justify-end gap-2">
                            <Button
                              type="button"
                              variant="outline"
                              size="icon-sm"
                              aria-label={`Edit ${item.name}`}
                              onClick={() => editPlannedExpense(item)}
                            >
                              <RiEditLine />
                            </Button>
                            <Button
                              type="button"
                              variant="outline"
                              size="icon-sm"
                              aria-label={`Delete ${item.name}`}
                              onClick={() => handleDeletePlannedExpense(item)}
                            >
                              <RiDeleteBinLine />
                            </Button>
                          </div>
                        </TableCell>
                      </TableRow>
                      {candidateExpenseId === item.id && (
                        <TableRow>
                          <TableCell colSpan={10} className="bg-muted/20">
                            {transactionCandidates.length === 0 ? (
                              <div className="border border-dashed bg-background p-4 text-xs text-muted-foreground">
                                No unmatched debit transactions found within 30 days of the due date.
                              </div>
                            ) : (
                              <div className="grid gap-2 md:grid-cols-2">
                                {transactionCandidates.map((candidate) => (
                                  <div
                                    key={candidate.id}
                                    className="grid grid-cols-[minmax(0,1fr)_auto] gap-3 border bg-background p-2"
                                  >
                                    <div className="min-w-0">
                                      <p className="truncate text-xs font-medium">
                                        {candidate.merchant ||
                                          candidate.description ||
                                          "Transaction"}
                                      </p>
                                      <p className="truncate text-xs text-muted-foreground">
                                        {candidate.bookedAt} ·{" "}
                                        {formatCurrency(candidate.amount, data.currency)}
                                      </p>
                                    </div>
                                    <Button
                                      type="button"
                                      variant="outline"
                                      size="sm"
                                      onClick={() =>
                                        handleLinkTransaction(item, candidate.id)
                                      }
                                      disabled={isPending}
                                    >
                                      <RiLink />
                                      Link
                                    </Button>
                                  </div>
                                ))}
                              </div>
                            )}
                          </TableCell>
                        </TableRow>
                      )}
                    </Fragment>
                  ))}
                </TableBody>
              </Table>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
