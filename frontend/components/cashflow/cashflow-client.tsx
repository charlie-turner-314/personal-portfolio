"use client";

import {
  useMemo,
  useState,
  useTransition,
  type FormEvent,
  type ReactNode,
} from "react";
import { useRouter } from "next/navigation";
import {
  RiAddLine,
  RiAlertLine,
  RiArrowDownLine,
  RiArrowUpLine,
  RiBankLine,
  RiCalendarLine,
  RiDeleteBinLine,
  RiExchangeFundsLine,
  RiFundsLine,
  RiWallet3Line,
} from "@remixicon/react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  createCashflowOverride,
  deleteCashflowOverride,
  type CashflowForecastData,
  type CashflowForecastFormOptions,
  type CashflowOverrideDirection,
  type CashflowOverrideInput,
} from "@/lib/actions/cashflow-forecast";
import { cn, formatCurrency } from "@/lib/utils";

interface CashflowClientProps {
  forecast: CashflowForecastData;
  formOptions: CashflowForecastFormOptions;
}

type HorizonDays = 30 | 60 | 90;
type ForecastEntry = CashflowForecastData["entries"][number];
type AccountProjection = CashflowForecastData["accountBalanceProjection"][number];

const HORIZONS: HorizonDays[] = [30, 60, 90];
const NO_CATEGORY = "__none__";

const directionOptions: Array<{
  value: CashflowOverrideDirection;
  label: string;
}> = [
  { value: "income", label: "Income" },
  { value: "expense", label: "Expense" },
  { value: "transfer_in", label: "Transfer in" },
  { value: "transfer_out", label: "Transfer out" },
];

function todayDateKey(): string {
  return new Date().toISOString().slice(0, 10);
}

function formatDateKey(dateKey: string): string {
  return new Date(`${dateKey}T00:00:00Z`).toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    year: "numeric",
    timeZone: "UTC",
  });
}

function formatSignedCurrency(value: number, currency: string): string {
  const formatted = formatCurrency(value, currency, {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });

  if (value > 0) return `+${formatted}`;
  if (value < 0) return `-${formatted}`;
  return formatted;
}

function directionLabel(direction: ForecastEntry["direction"] | CashflowOverrideDirection): string {
  if (direction === "inflow" || direction === "income") return "Inflow";
  if (direction === "outflow" || direction === "expense") return "Outflow";
  if (direction === "transfer_in") return "Transfer in";
  return "Transfer out";
}

function sourceTypeLabel(sourceType: ForecastEntry["sourceType"]): string {
  if (sourceType === "planned_expense") return "Planned";
  if (sourceType === "manual_override") return "Manual";
  if (sourceType === "income_pattern") return "Income pattern";
  if (sourceType === "recurring") return "Recurring";
  return "Transfer";
}

function defaultForm(options: CashflowForecastFormOptions): CashflowOverrideFormState {
  return {
    accountId: options.accounts[0]?.id ?? "",
    categoryId: NO_CATEGORY,
    expectedDate: todayDateKey(),
    direction: "expense",
    amount: "",
    description: "",
    notes: "",
  };
}

interface CashflowOverrideFormState {
  accountId: string;
  categoryId: string;
  expectedDate: string;
  direction: CashflowOverrideDirection;
  amount: string;
  description: string;
  notes: string;
}

function toOverrideInput(form: CashflowOverrideFormState): CashflowOverrideInput {
  return {
    accountId: form.accountId,
    categoryId: form.categoryId === NO_CATEGORY ? null : form.categoryId,
    expectedDate: form.expectedDate,
    direction: form.direction,
    amount: Number(form.amount),
    description: form.description,
    notes: form.notes,
  };
}

function projectionRows(
  projections: AccountProjection[],
  startDate: string,
  endDate: string
) {
  const byAccount = new Map<string, AccountProjection[]>();

  for (const projection of projections) {
    if (projection.date < startDate || projection.date > endDate) continue;
    const rows = byAccount.get(projection.accountId) ?? [];
    rows.push(projection);
    byAccount.set(projection.accountId, rows);
  }

  return Array.from(byAccount.entries())
    .map(([accountId, rows]) => {
      const sortedRows = rows.sort((left, right) => left.date.localeCompare(right.date));
      const ending = sortedRows[sortedRows.length - 1];
      const lowest = sortedRows.reduce((min, row) =>
        row.projectedBalance < min.projectedBalance ? row : min
      );
      const first = sortedRows[0];

      return {
        accountId,
        accountName: ending.accountName ?? first.accountName ?? "Account",
        currentProjectedBalance: first.projectedBalance,
        endingProjectedBalance: ending.projectedBalance,
        lowestProjectedBalance: lowest.projectedBalance,
        lowestDate: lowest.date,
      };
    })
    .sort((left, right) => left.accountName.localeCompare(right.accountName));
}

export function CashflowClient({ forecast, formOptions }: CashflowClientProps) {
  const router = useRouter();
  const [horizonDays, setHorizonDays] = useState<HorizonDays>(90);
  const [form, setForm] = useState(() => defaultForm(formOptions));
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();

  const activeHorizon = useMemo(
    () =>
      forecast.horizons.find((horizon) => horizon.days === horizonDays) ??
      forecast.horizons[forecast.horizons.length - 1],
    [forecast.horizons, horizonDays]
  );

  const activeEntries = activeHorizon?.entries ?? [];
  const activeStartDate = activeHorizon?.startDate ?? forecast.startDate;
  const activeEndDate = activeHorizon?.endDate ?? forecast.endDate;
  const activeWarnings = forecast.lowBalanceWarnings.filter(
    (warning) => warning.date >= activeStartDate && warning.date <= activeEndDate
  );
  const activeOverrides = forecast.overrides.filter(
    (override) =>
      override.expectedDate >= activeStartDate && override.expectedDate <= activeEndDate
  );
  const accountRows = projectionRows(
    forecast.accountBalanceProjection,
    activeStartDate,
    activeEndDate
  );
  const startingBalance = forecast.summary.startingBalance;
  const projectedEndingBalance =
    startingBalance + (activeHorizon?.netBalanceImpact ?? 0);
  const transferTotal =
    (activeHorizon?.transferIn ?? 0) + (activeHorizon?.transferOut ?? 0);

  const updateForm = <Key extends keyof CashflowOverrideFormState>(
    key: Key,
    value: CashflowOverrideFormState[Key]
  ) => {
    setForm((current) => ({ ...current, [key]: value }));
  };

  const handleSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();

    if (!form.accountId) {
      toast.error("Select an account");
      return;
    }
    if (!form.expectedDate) {
      toast.error("Enter an expected date");
      return;
    }
    if (!form.description.trim()) {
      toast.error("Enter a description");
      return;
    }
    if (!Number.isFinite(Number(form.amount)) || Number(form.amount) <= 0) {
      toast.error("Enter an amount greater than 0");
      return;
    }

    startTransition(async () => {
      const result = await createCashflowOverride(toOverrideInput(form));
      if (result.success) {
        toast.success("Cashflow override added");
        setForm((current) => ({
          ...defaultForm(formOptions),
          accountId: current.accountId,
          categoryId: current.categoryId,
        }));
        router.refresh();
      } else {
        toast.error(result.error || "Failed to add override");
      }
    });
  };

  const handleDelete = (id: string) => {
    setDeletingId(id);
    startTransition(async () => {
      const result = await deleteCashflowOverride(id);
      if (result.success) {
        toast.success("Cashflow override deleted");
        router.refresh();
      } else {
        toast.error(result.error || "Failed to delete override");
      }
      setDeletingId(null);
    });
  };

  return (
    <div className="flex flex-1 flex-col gap-4 p-4 pt-0">
      <div className="flex flex-col gap-3 lg:flex-row lg:items-end lg:justify-between">
        <div>
          <div className="flex items-center gap-2">
            <h1 className="text-lg font-semibold">Cashflow forecast</h1>
            <Badge variant="outline">{activeEntries.length} entries</Badge>
          </div>
          <p className="mt-1 text-xs text-muted-foreground">
            {formatDateKey(activeStartDate)} to {formatDateKey(activeEndDate)} ·
            generated {formatDateKey(forecast.generatedAt)}
          </p>
        </div>
        <Tabs
          value={String(horizonDays)}
          onValueChange={(value) => setHorizonDays(Number(value) as HorizonDays)}
          className="w-fit"
        >
          <TabsList className="grid w-[210px] grid-cols-3">
            {HORIZONS.map((days) => (
              <TabsTrigger key={days} value={String(days)}>
                {days}D
              </TabsTrigger>
            ))}
          </TabsList>
        </Tabs>
      </div>

      <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-5">
        <SummaryCard
          title="Starting balance"
          value={formatCurrency(startingBalance, forecast.currency)}
          icon={RiWallet3Line}
        />
        <SummaryCard
          title="Projected ending"
          value={formatCurrency(projectedEndingBalance, forecast.currency)}
          icon={RiFundsLine}
          tone={projectedEndingBalance < 0 ? "bad" : "default"}
        />
        <SummaryCard
          title="Inflows"
          value={formatCurrency(activeHorizon?.totalInflow ?? 0, forecast.currency)}
          icon={RiArrowUpLine}
          tone="good"
        />
        <SummaryCard
          title="Outflows"
          value={formatCurrency(activeHorizon?.totalOutflow ?? 0, forecast.currency)}
          icon={RiArrowDownLine}
          tone="bad"
        />
        <SummaryCard
          title="Transfers / net"
          value={formatCurrency(transferTotal, forecast.currency)}
          detail={formatSignedCurrency(activeHorizon?.netBalanceImpact ?? 0, forecast.currency)}
          icon={RiExchangeFundsLine}
        />
      </div>

      {activeWarnings.length > 0 && (
        <Card className="border-destructive/40 bg-destructive/5">
          <CardHeader className="border-b">
            <div className="flex items-center gap-2">
              <RiAlertLine className="size-4 text-destructive" aria-hidden="true" />
              <CardTitle>Low-balance warnings</CardTitle>
            </div>
          </CardHeader>
          <CardContent>
            <div className="grid gap-2 md:grid-cols-2 xl:grid-cols-3">
              {activeWarnings.map((warning) => (
                <div
                  key={`${warning.accountId}:${warning.date}`}
                  className="border bg-background p-3"
                >
                  <div className="flex items-center justify-between gap-3">
                    <div className="min-w-0">
                      <p className="truncate font-medium">
                        {warning.accountName ?? "Account"}
                      </p>
                      <p className="text-muted-foreground">
                        {formatDateKey(warning.date)}
                      </p>
                    </div>
                    <p className="shrink-0 text-right font-medium tabular-nums text-destructive">
                      {formatCurrency(warning.projectedBalance, forecast.currency)}
                    </p>
                  </div>
                  <p className="mt-1 text-muted-foreground">
                    Threshold {formatCurrency(warning.threshold, forecast.currency)}
                  </p>
                </div>
              ))}
            </div>
          </CardContent>
        </Card>
      )}

      <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_360px]">
        <div className="flex min-w-0 flex-col gap-4">
          <Card>
            <CardHeader className="border-b">
              <div className="flex items-center gap-2">
                <RiBankLine className="size-4 text-muted-foreground" aria-hidden="true" />
                <CardTitle>Account projections</CardTitle>
              </div>
            </CardHeader>
            <CardContent className="p-0">
              {accountRows.length > 0 ? (
                <div className="overflow-x-auto">
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>Account</TableHead>
                        <TableHead className="text-right">Current</TableHead>
                        <TableHead className="text-right">Projected</TableHead>
                        <TableHead className="text-right">Lowest</TableHead>
                        <TableHead>Date</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {accountRows.map((account) => (
                        <TableRow key={account.accountId}>
                          <TableCell className="font-medium">
                            {account.accountName}
                          </TableCell>
                          <TableCell className="text-right tabular-nums">
                            {formatCurrency(
                              account.currentProjectedBalance,
                              forecast.currency
                            )}
                          </TableCell>
                          <TableCell
                            className={cn(
                              "text-right tabular-nums",
                              account.endingProjectedBalance < 0 &&
                                "text-destructive"
                            )}
                          >
                            {formatCurrency(
                              account.endingProjectedBalance,
                              forecast.currency
                            )}
                          </TableCell>
                          <TableCell
                            className={cn(
                              "text-right tabular-nums",
                              account.lowestProjectedBalance < 0 &&
                                "text-destructive"
                            )}
                          >
                            {formatCurrency(
                              account.lowestProjectedBalance,
                              forecast.currency
                            )}
                          </TableCell>
                          <TableCell className="text-muted-foreground">
                            {formatDateKey(account.lowestDate)}
                          </TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </div>
              ) : (
                <EmptyState>No account projection data available.</EmptyState>
              )}
            </CardContent>
          </Card>

          <Card>
            <CardHeader className="border-b">
              <div className="flex items-center gap-2">
                <RiCalendarLine
                  className="size-4 text-muted-foreground"
                  aria-hidden="true"
                />
                <CardTitle>Forecast entries</CardTitle>
              </div>
            </CardHeader>
            <CardContent className="p-0">
              {activeEntries.length > 0 ? (
                <div className="overflow-x-auto">
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>Date</TableHead>
                        <TableHead>Account</TableHead>
                        <TableHead>Source</TableHead>
                        <TableHead>Type</TableHead>
                        <TableHead>Direction</TableHead>
                        <TableHead className="text-right">Amount</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {activeEntries.map((entry) => (
                        <TableRow
                          key={`${entry.sourceType}:${entry.sourceId}:${entry.date}:${entry.accountId}`}
                        >
                          <TableCell className="whitespace-nowrap">
                            {formatDateKey(entry.date)}
                          </TableCell>
                          <TableCell className="max-w-[180px] truncate">
                            {entry.accountName ?? "Account"}
                          </TableCell>
                          <TableCell className="min-w-[220px]">
                            <div className="font-medium">
                              {entry.sourceLabel}
                            </div>
                            <div className="text-muted-foreground">
                              {entry.traceLabel}
                            </div>
                          </TableCell>
                          <TableCell>
                            <Badge variant="outline">
                              {sourceTypeLabel(entry.sourceType)}
                            </Badge>
                          </TableCell>
                          <TableCell>{directionLabel(entry.direction)}</TableCell>
                          <TableCell
                            className={cn(
                              "text-right font-medium tabular-nums",
                              entry.balanceImpact < 0
                                ? "text-destructive"
                                : "text-emerald-600 dark:text-emerald-400"
                            )}
                          >
                            {formatSignedCurrency(
                              entry.balanceImpact,
                              forecast.currency
                            )}
                          </TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </div>
              ) : (
                <EmptyState>No forecast entries in this window.</EmptyState>
              )}
            </CardContent>
          </Card>
        </div>

        <div className="flex flex-col gap-4">
          <Card>
            <CardHeader className="border-b">
              <div className="flex items-center gap-2">
                <RiAddLine className="size-4 text-muted-foreground" aria-hidden="true" />
                <CardTitle>Manual override</CardTitle>
              </div>
            </CardHeader>
            <CardContent>
              <form className="flex flex-col gap-3" onSubmit={handleSubmit}>
                <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-1">
                  <div className="space-y-1">
                    <Label htmlFor="cashflow-account">Account</Label>
                    <Select
                      value={form.accountId}
                      onValueChange={(value) => updateForm("accountId", value ?? "")}
                    >
                      <SelectTrigger id="cashflow-account" className="w-full">
                        <SelectValue placeholder="Select account" />
                      </SelectTrigger>
                      <SelectContent>
                        {formOptions.accounts.map((account) => (
                          <SelectItem key={account.id} value={account.id}>
                            {account.name}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>

                  <div className="space-y-1">
                    <Label htmlFor="cashflow-direction">Direction</Label>
                    <Select
                      value={form.direction}
                      onValueChange={(value) =>
                        updateForm(
                          "direction",
                          (value ?? "expense") as CashflowOverrideDirection
                        )
                      }
                    >
                      <SelectTrigger id="cashflow-direction" className="w-full">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {directionOptions.map((option) => (
                          <SelectItem key={option.value} value={option.value}>
                            {option.label}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>

                  <div className="space-y-1">
                    <Label htmlFor="cashflow-date">Date</Label>
                    <Input
                      id="cashflow-date"
                      type="date"
                      value={form.expectedDate}
                      onChange={(event) =>
                        updateForm("expectedDate", event.target.value)
                      }
                    />
                  </div>

                  <div className="space-y-1">
                    <Label htmlFor="cashflow-amount">Amount</Label>
                    <Input
                      id="cashflow-amount"
                      type="number"
                      min="0"
                      step="0.01"
                      inputMode="decimal"
                      value={form.amount}
                      onChange={(event) => updateForm("amount", event.target.value)}
                      placeholder="0.00"
                    />
                  </div>
                </div>

                <div className="space-y-1">
                  <Label htmlFor="cashflow-description">Description</Label>
                  <Input
                    id="cashflow-description"
                    value={form.description}
                    onChange={(event) =>
                      updateForm("description", event.target.value)
                    }
                    placeholder="Expected rent, invoice, transfer"
                  />
                </div>

                <div className="space-y-1">
                  <Label htmlFor="cashflow-category">Category</Label>
                  <Select
                    value={form.categoryId}
                    onValueChange={(value) =>
                      updateForm("categoryId", value ?? NO_CATEGORY)
                    }
                  >
                    <SelectTrigger id="cashflow-category" className="w-full">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value={NO_CATEGORY}>Uncategorized</SelectItem>
                      {formOptions.categories.map((category) => (
                        <SelectItem key={category.id} value={category.id}>
                          {category.name}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>

                <div className="space-y-1">
                  <Label htmlFor="cashflow-notes">Notes</Label>
                  <Input
                    id="cashflow-notes"
                    value={form.notes}
                    onChange={(event) => updateForm("notes", event.target.value)}
                    placeholder="Optional"
                  />
                </div>

                <Button
                  type="submit"
                  className="w-full"
                  disabled={isPending || formOptions.accounts.length === 0}
                >
                  <RiAddLine aria-hidden="true" />
                  Add override
                </Button>
              </form>
            </CardContent>
          </Card>

          <Card>
            <CardHeader className="border-b">
              <CardTitle>Manual entries</CardTitle>
            </CardHeader>
            <CardContent className="p-0">
              {activeOverrides.length > 0 ? (
                <div className="divide-y">
                  {activeOverrides.map((override) => (
                    <div
                      key={override.id}
                      className="flex items-start justify-between gap-3 p-3"
                    >
                      <div className="min-w-0">
                        <div className="flex items-center gap-2">
                          <p className="truncate font-medium">
                            {override.description}
                          </p>
                          <Badge variant="outline">
                            {directionLabel(override.direction)}
                          </Badge>
                        </div>
                        <p className="mt-1 text-muted-foreground">
                          {formatDateKey(override.expectedDate)} ·{" "}
                          {override.accountName}
                        </p>
                        {override.categoryName && (
                          <p className="text-muted-foreground">
                            {override.categoryName}
                          </p>
                        )}
                      </div>
                      <div className="flex shrink-0 items-start gap-2">
                        <p className="font-medium tabular-nums">
                          {formatCurrency(override.amount, forecast.currency, {
                            minimumFractionDigits: 2,
                            maximumFractionDigits: 2,
                          })}
                        </p>
                        <Button
                          type="button"
                          variant="ghost"
                          size="icon-xs"
                          aria-label={`Delete ${override.description}`}
                          disabled={isPending && deletingId === override.id}
                          onClick={() => handleDelete(override.id)}
                        >
                          <RiDeleteBinLine aria-hidden="true" />
                        </Button>
                      </div>
                    </div>
                  ))}
                </div>
              ) : (
                <EmptyState>No manual entries in this window.</EmptyState>
              )}
            </CardContent>
          </Card>
        </div>
      </div>
    </div>
  );
}

function SummaryCard({
  title,
  value,
  detail,
  icon: Icon,
  tone = "default",
}: {
  title: string;
  value: string;
  detail?: string;
  icon: typeof RiWallet3Line;
  tone?: "default" | "good" | "bad";
}) {
  return (
    <Card size="sm">
      <CardContent>
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <p className="text-muted-foreground">{title}</p>
            <p
              className={cn(
                "mt-2 truncate text-lg font-semibold tabular-nums",
                tone === "good" && "text-emerald-600 dark:text-emerald-400",
                tone === "bad" && "text-destructive"
              )}
            >
              {value}
            </p>
            {detail && (
              <p className="mt-1 text-muted-foreground tabular-nums">
                Net {detail}
              </p>
            )}
          </div>
          <Icon className="size-4 shrink-0 text-muted-foreground" aria-hidden />
        </div>
      </CardContent>
    </Card>
  );
}

function EmptyState({ children }: { children: ReactNode }) {
  return <div className="p-4 text-center text-muted-foreground">{children}</div>;
}
