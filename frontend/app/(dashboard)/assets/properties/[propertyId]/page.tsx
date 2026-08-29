import Link from "next/link";
import { notFound } from "next/navigation";
import { RiArrowLeftLine, RiDownloadLine } from "@remixicon/react";
import { Badge } from "@/components/ui/badge";
import { buttonVariants } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { getAccounts } from "@/lib/actions/accounts";
import {
  getProperty,
  getPropertyLiabilityLinks,
  getPropertyTaggedTransactions,
  getPropertyTaxYearSummary,
  getPropertyValuations,
} from "@/lib/actions/properties";
import { getPeople, getOwnersForEntities } from "@/lib/people";
import { requireAuth } from "@/lib/auth-helpers";
import { calculatePropertyEquity, getLiabilityMagnitude } from "@/lib/properties/equity";
import {
  getAustralianFinancialYearForDate,
  getAustralianFinancialYearRange,
} from "@/lib/dates/australian-financial-year";
import { cn } from "@/lib/utils";

interface PropertyPageProps {
  params: Promise<{ propertyId: string }>;
  searchParams: Promise<{ fy?: string | string[] }>;
}

function formatCurrency(value: string | number | null | undefined, currency: string | null | undefined): string {
  const parsed = typeof value === "number" ? value : parseFloat(value || "0");
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: currency || "EUR",
  }).format(Number.isFinite(parsed) ? parsed : 0);
}

function formatDate(value: Date | string): string {
  return new Intl.DateTimeFormat("en-US", {
    year: "numeric",
    month: "short",
    day: "numeric",
  }).format(new Date(value));
}

function csvEscape(value: string | number | null | undefined): string {
  const text = String(value ?? "");
  return `"${text.replaceAll('"', '""')}"`;
}

function propertyTaxCsv(summary: {
  taxYearStart: string;
  taxYearEnd: string;
  rentReceived: number;
  expenses: { categoryName: string; amount: number }[];
}): string {
  const rows = [
    ["Tax year start", summary.taxYearStart],
    ["Tax year end", summary.taxYearEnd],
    ["Rent received", summary.rentReceived.toFixed(2)],
    [],
    ["Expense category", "Amount"],
    ...summary.expenses.map((expense) => [expense.categoryName, expense.amount.toFixed(2)]),
  ];
  return rows.map((row) => row.map(csvEscape).join(",")).join("\n");
}

function parseFinancialYearStartYear(
  value: string | string[] | undefined,
  fallbackStartYear: number,
): number {
  const raw = Array.isArray(value) ? value[0] : value;
  if (!raw) return fallbackStartYear;
  const parsed = Number.parseInt(raw, 10);
  return Number.isInteger(parsed) && parsed >= 1900 && parsed <= 9998
    ? parsed
    : fallbackStartYear;
}

export default async function PropertyPage({ params, searchParams }: PropertyPageProps) {
  const { propertyId } = await params;
  const query = await searchParams;
  const userId = await requireAuth();
  const property = await getProperty(propertyId);

  if (!userId || !property) {
    notFound();
  }

  const currentFinancialYear = getAustralianFinancialYearForDate();
  const financialYear = getAustralianFinancialYearRange(
    parseFinancialYearStartYear(query.fy, currentFinancialYear.startYear),
  );
  const financialYearOptions = Array.from({ length: 6 }, (_, index) =>
    getAustralianFinancialYearRange(currentFinancialYear.startYear - index)
  );
  const [
    accounts,
    links,
    valuations,
    transactions,
    taxSummaryResult,
    people,
    ownersMap,
  ] = await Promise.all([
    getAccounts(),
    getPropertyLiabilityLinks([property.id]),
    getPropertyValuations([property.id]),
    getPropertyTaggedTransactions(property.id, 25),
    getPropertyTaxYearSummary(property.id, financialYear.startYear),
    getPeople(userId),
    getOwnersForEntities("property", [property.id]),
  ]);

  const equity = calculatePropertyEquity(property, accounts, links);
  const linkedAccounts = links
    .map((link) => accounts.find((account) => account.id === link.accountId))
    .filter(Boolean);
  const peopleById = new Map(people.map((person) => [person.id, person]));
  const owners = ownersMap.get(property.id) || [];
  const taxSummary = taxSummaryResult.success ? taxSummaryResult.summary : null;
  const csvHref = taxSummary
    ? `data:text/csv;charset=utf-8,${encodeURIComponent(propertyTaxCsv(taxSummary))}`
    : "#";

  return (
    <div className="flex flex-col gap-4 p-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="space-y-2">
          <Link
            href="/assets"
            className={cn(buttonVariants({ variant: "ghost", size: "sm" }), "w-fit")}
          >
            <RiArrowLeftLine className="h-4 w-4" />
            Assets
          </Link>
          <div>
            <div className="flex items-center gap-2">
              <h1 className="text-2xl font-semibold">{property.name}</h1>
              {property.isRental && <Badge variant="outline">Rental</Badge>}
            </div>
            {property.address && (
              <p className="text-sm text-muted-foreground">{property.address}</p>
            )}
          </div>
        </div>
        {taxSummary && (
          <div className="flex flex-wrap items-center justify-end gap-2">
            <div className="flex items-center border">
              {financialYearOptions.map((option) => (
                <Link
                  key={option.startYear}
                  href={`/assets/properties/${property.id}?fy=${option.startYear}`}
                  className={cn(
                    buttonVariants({
                      variant: option.startYear === financialYear.startYear ? "default" : "ghost",
                      size: "sm",
                    }),
                    "border-0"
                  )}
                >
                  {option.label}
                </Link>
              ))}
            </div>
            <a
              className={buttonVariants({ variant: "outline" })}
              href={csvHref}
              download={`${property.name.replaceAll(/\s+/g, "-").toLowerCase()}-${financialYear.label.toLowerCase()}.csv`}
            >
              <RiDownloadLine className="h-4 w-4" />
              Export FY CSV
            </a>
          </div>
        )}
      </div>

      <div className="grid gap-4 md:grid-cols-3">
        <Card>
          <CardHeader>
            <CardTitle>Market Value</CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-2xl font-semibold">
              {formatCurrency(equity.grossValue, property.currency)}
            </p>
            {property.valuationDate && (
              <p className="text-sm text-muted-foreground">
                Valued {formatDate(property.valuationDate)}
              </p>
            )}
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle>Linked Debt</CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-2xl font-semibold">
              {formatCurrency(equity.linkedDebt, property.currency)}
            </p>
            <p className="text-sm text-muted-foreground">
              {linkedAccounts.length} linked account{linkedAccounts.length === 1 ? "" : "s"}
            </p>
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle>Equity</CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-2xl font-semibold">
              {formatCurrency(equity.equity, property.currency)}
            </p>
            <p className="text-sm text-muted-foreground">
              Used in dashboard net worth
            </p>
          </CardContent>
        </Card>
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle>Ownership</CardTitle>
            <CardDescription>Property ownership split.</CardDescription>
          </CardHeader>
          <CardContent className="space-y-2">
            {owners.length === 0 ? (
              <p className="text-sm text-muted-foreground">No owners assigned.</p>
            ) : owners.map((owner) => {
              const person = peopleById.get(owner.personId);
              return (
                <div key={owner.personId} className="flex justify-between text-sm">
                  <span>{person?.name || "Unknown"}</span>
                  <span className="text-muted-foreground">
                    {owner.share === null ? "Equal split" : `${Math.round(owner.share * 100)}%`}
                  </span>
                </div>
              );
            })}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Linked Liabilities</CardTitle>
            <CardDescription>Debt subtracted from this property value.</CardDescription>
          </CardHeader>
          <CardContent className="space-y-2">
            {linkedAccounts.length === 0 ? (
              <p className="text-sm text-muted-foreground">No linked liabilities.</p>
            ) : linkedAccounts.map((account) => account && (
              <div key={account.id} className="flex justify-between gap-3 text-sm">
                <span>{account.name}</span>
                <span className="text-muted-foreground">
                  {formatCurrency(getLiabilityMagnitude(account), account.currency)}
                </span>
              </div>
            ))}
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Valuation History</CardTitle>
          <CardDescription>Manual valuation snapshots for this property.</CardDescription>
        </CardHeader>
        <CardContent>
          {valuations.length === 0 ? (
            <p className="text-sm text-muted-foreground">No valuation history yet.</p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Date</TableHead>
                  <TableHead>Source</TableHead>
                  <TableHead className="text-right">Value</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {valuations.map((valuation) => (
                  <TableRow key={valuation.id}>
                    <TableCell>{formatDate(valuation.valuationDate)}</TableCell>
                    <TableCell>{valuation.source || "manual"}</TableCell>
                    <TableCell className="text-right">
                      {formatCurrency(valuation.value, valuation.currency)}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Tagged Rental Activity</CardTitle>
          <CardDescription>Recent transactions tagged to this property.</CardDescription>
        </CardHeader>
        <CardContent>
          {transactions.length === 0 ? (
            <p className="text-sm text-muted-foreground">No tagged transactions yet.</p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Date</TableHead>
                  <TableHead>Description</TableHead>
                  <TableHead>Category</TableHead>
                  <TableHead className="text-right">Amount</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {transactions.map((transaction) => (
                  <TableRow key={transaction.id}>
                    <TableCell>{formatDate(transaction.bookedAt)}</TableCell>
                    <TableCell>{transaction.merchant || transaction.description || "Transaction"}</TableCell>
                    <TableCell>{transaction.categoryName}</TableCell>
                    <TableCell className="text-right">
                      {formatCurrency(transaction.amount, transaction.currency || property.currency)}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
