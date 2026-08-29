"use client";

import { useMemo, useState, useTransition } from "react";
import Link from "next/link";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  addSuperBalanceSnapshot,
  addSuperContribution,
  getSuperCapProgress,
  saveSuperContributionCaps,
  updateSuperAccountMetadata,
} from "@/lib/actions/superannuation";
import {
  SUPER_CONTRIBUTION_KINDS,
  type SuperCapProgress,
  type SuperContributionKind,
} from "@/lib/superannuation/cap-progress";
import {
  formatAustralianFinancialYearLabel,
  getAustralianFinancialYearStartYear,
} from "@/lib/dates/australian-financial-year";

type Contribution = {
  id: string;
  date: string;
  amount: string;
  currency: string;
  kind: string;
  notes: string | null;
};

export interface SuperAccountManagerProps {
  accountId: string;
  currency: string | null;
  fundName: string;
  investmentOption: string | null;
  includeInNetWorth: boolean;
  contributions: Contribution[];
  financialYearStart: number;
  capProgress: SuperCapProgress | null;
}

const KIND_LABELS: Record<SuperContributionKind, string> = {
  employer_sg: "Employer SG",
  salary_sacrifice: "Salary sacrifice",
  personal_concessional: "Personal concessional",
  personal_non_concessional: "Personal non-concessional",
  fee: "Fee",
  insurance: "Insurance",
};

function today(): string {
  return new Date().toISOString().slice(0, 10);
}

function money(value: number | string, currency: string): string {
  const amount = typeof value === "number" ? value : Number(value);
  return new Intl.NumberFormat(undefined, { style: "currency", currency }).format(amount || 0);
}

function capValue(value: number | null): string {
  return value === null ? "" : String(value);
}

export function SuperAccountManager({
  accountId,
  currency,
  fundName: initialFundName,
  investmentOption: initialInvestmentOption,
  includeInNetWorth: initialIncludeInNetWorth,
  contributions,
  financialYearStart: initialFinancialYearStart,
  capProgress: initialCapProgress,
}: SuperAccountManagerProps) {
  const displayCurrency = currency || "AUD";
  const [fundName, setFundName] = useState(initialFundName);
  const [investmentOption, setInvestmentOption] = useState(initialInvestmentOption || "");
  const [includeInNetWorth, setIncludeInNetWorth] = useState(initialIncludeInNetWorth);
  const [balanceDate, setBalanceDate] = useState(today);
  const [balance, setBalance] = useState("");
  const [contributionDate, setContributionDate] = useState(today);
  const [contributionAmount, setContributionAmount] = useState("");
  const [contributionKind, setContributionKind] = useState<SuperContributionKind>("employer_sg");
  const [notes, setNotes] = useState("");
  const [financialYearStart, setFinancialYearStart] = useState(initialFinancialYearStart);
  const [capProgress, setCapProgress] = useState(initialCapProgress);
  const [concessionalCap, setConcessionalCap] = useState(capValue(initialCapProgress?.concessional.cap ?? null));
  const [nonConcessionalCap, setNonConcessionalCap] = useState(capValue(initialCapProgress?.nonConcessional.cap ?? null));
  const [isPending, startTransition] = useTransition();

  const financialYears = useMemo(() => {
    const current = getAustralianFinancialYearStartYear();
    return Array.from({ length: 6 }, (_, index) => current - index);
  }, []);

  const run = (action: () => Promise<{ success: boolean; error?: string }>, onSuccess?: () => void) => {
    startTransition(async () => {
      const result = await action();
      if (!result.success) {
        toast.error(result.error || "Unable to save super account details");
        return;
      }
      toast.success("Saved");
      onSuccess?.();
    });
  };

  const handleFinancialYearChange = async (value: string) => {
    const nextYear = Number(value);
    setFinancialYearStart(nextYear);
    const progress = await getSuperCapProgress(nextYear);
    setCapProgress(progress);
    setConcessionalCap(capValue(progress?.concessional.cap ?? null));
    setNonConcessionalCap(capValue(progress?.nonConcessional.cap ?? null));
  };

  const parseOptionalCap = (value: string): number | null => {
    if (!value.trim()) return null;
    const parsed = Number(value);
    return Number.isFinite(parsed) && parsed >= 0 ? parsed : Number.NaN;
  };

  return (
    <section className="border bg-card p-4" aria-labelledby="super-account-heading">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 id="super-account-heading" className="font-medium">Superannuation</h2>
          <p className="text-sm text-muted-foreground">Track your fund balance and contribution caps separately from bank transactions.</p>
        </div>
        <Link
          href={`/accounts/${accountId}/super/import`}
          className="inline-flex h-10 items-center justify-center rounded-md border border-input bg-background px-4 text-sm font-medium"
        >
          Import statement
        </Link>
      </div>

      <div className="mt-5 grid gap-5 xl:grid-cols-2">
        <form className="space-y-3 border p-4" onSubmit={(event) => {
          event.preventDefault();
          run(() => updateSuperAccountMetadata(accountId, { fundName, investmentOption, includeInNetWorth }));
        }}>
          <div><h3 className="text-sm font-medium">Fund details</h3><p className="text-xs text-muted-foreground">Used to identify this super account in your net worth.</p></div>
          <div className="space-y-1"><Label htmlFor="super-fund-name">Fund or provider</Label><Input id="super-fund-name" value={fundName} onChange={(event) => setFundName(event.target.value)} required /></div>
          <div className="space-y-1"><Label htmlFor="super-investment-option">Investment option</Label><Input id="super-investment-option" value={investmentOption} onChange={(event) => setInvestmentOption(event.target.value)} placeholder="e.g. Balanced" /></div>
          <div className="flex items-center justify-between gap-3"><Label htmlFor="super-include-net-worth">Include in net worth</Label><Switch id="super-include-net-worth" checked={includeInNetWorth} onCheckedChange={setIncludeInNetWorth} /></div>
          <Button type="submit" disabled={isPending}>Save fund details</Button>
        </form>

        <form className="space-y-3 border p-4" onSubmit={(event) => {
          event.preventDefault();
          const value = Number(balance);
          run(() => addSuperBalanceSnapshot(accountId, { date: balanceDate, balance: value }), () => setBalance(""));
        }}>
          <div><h3 className="text-sm font-medium">Balance snapshot</h3><p className="text-xs text-muted-foreground">Record a dated statement balance. This does not create a contribution.</p></div>
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="space-y-1"><Label htmlFor="super-balance-date">Date</Label><Input id="super-balance-date" type="date" value={balanceDate} onChange={(event) => setBalanceDate(event.target.value)} required /></div>
            <div className="space-y-1"><Label htmlFor="super-balance">Balance ({displayCurrency})</Label><Input id="super-balance" type="number" min="0" step="0.01" value={balance} onChange={(event) => setBalance(event.target.value)} required /></div>
          </div>
          <Button type="submit" disabled={isPending}>Save balance snapshot</Button>
        </form>

        <form className="space-y-3 border p-4" onSubmit={(event) => {
          event.preventDefault();
          const amount = Number(contributionAmount);
          run(() => addSuperContribution(accountId, { date: contributionDate, amount, currency: displayCurrency, kind: contributionKind, notes }), () => {
            setContributionAmount(""); setNotes("");
          });
        }}>
          <div><h3 className="text-sm font-medium">Contribution or charge</h3><p className="text-xs text-muted-foreground">Contribution types drive cap progress; fees and insurance do not.</p></div>
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="space-y-1"><Label htmlFor="super-contribution-date">Date</Label><Input id="super-contribution-date" type="date" value={contributionDate} onChange={(event) => setContributionDate(event.target.value)} required /></div>
            <div className="space-y-1"><Label htmlFor="super-contribution-amount">Amount ({displayCurrency})</Label><Input id="super-contribution-amount" type="number" min="0.01" step="0.01" value={contributionAmount} onChange={(event) => setContributionAmount(event.target.value)} required /></div>
          </div>
          <div className="space-y-1"><Label htmlFor="super-contribution-kind">Type</Label><Select value={contributionKind} onValueChange={(value) => setContributionKind(value as SuperContributionKind)}><SelectTrigger id="super-contribution-kind"><SelectValue /></SelectTrigger><SelectContent>{SUPER_CONTRIBUTION_KINDS.map((kind) => <SelectItem key={kind} value={kind}>{KIND_LABELS[kind]}</SelectItem>)}</SelectContent></Select></div>
          <div className="space-y-1"><Label htmlFor="super-contribution-notes">Notes</Label><Input id="super-contribution-notes" value={notes} onChange={(event) => setNotes(event.target.value)} /></div>
          <Button type="submit" disabled={isPending}>Add contribution</Button>
        </form>

        <div className="space-y-3 border p-4">
          <div className="flex flex-wrap items-end justify-between gap-3"><div><h3 className="text-sm font-medium">Contribution caps</h3><p className="text-xs text-muted-foreground">Caps are user-configured values, not tax advice.</p></div><div className="w-40 space-y-1"><Label htmlFor="super-financial-year">Financial year</Label><Select value={String(financialYearStart)} onValueChange={(value) => value && handleFinancialYearChange(value)}><SelectTrigger id="super-financial-year"><SelectValue /></SelectTrigger><SelectContent>{financialYears.map((year) => <SelectItem key={year} value={String(year)}>{formatAustralianFinancialYearLabel(year)}</SelectItem>)}</SelectContent></Select></div></div>
          {capProgress ? <div className="grid gap-3 sm:grid-cols-2"><CapProgress label="Concessional" progress={capProgress.concessional} currency={displayCurrency} /><CapProgress label="Non-concessional" progress={capProgress.nonConcessional} currency={displayCurrency} /></div> : <p className="border border-dashed p-3 text-sm text-muted-foreground">Cap progress is unavailable for this financial year.</p>}
          <form className="grid gap-3 sm:grid-cols-2" onSubmit={(event) => { event.preventDefault(); const concessional = parseOptionalCap(concessionalCap); const nonConcessional = parseOptionalCap(nonConcessionalCap); if (Number.isNaN(concessional) || Number.isNaN(nonConcessional)) { toast.error("Caps must be zero or greater"); return; } run(() => saveSuperContributionCaps(financialYearStart, { concessionalCap: concessional, nonConcessionalCap: nonConcessional }), async () => { setCapProgress(await getSuperCapProgress(financialYearStart)); }); }}>
            <div className="space-y-1"><Label htmlFor="super-concessional-cap">Concessional cap ({displayCurrency})</Label><Input id="super-concessional-cap" type="number" min="0" step="0.01" value={concessionalCap} onChange={(event) => setConcessionalCap(event.target.value)} placeholder="Not configured" /></div>
            <div className="space-y-1"><Label htmlFor="super-non-concessional-cap">Non-concessional cap ({displayCurrency})</Label><Input id="super-non-concessional-cap" type="number" min="0" step="0.01" value={nonConcessionalCap} onChange={(event) => setNonConcessionalCap(event.target.value)} placeholder="Not configured" /></div>
            <Button type="submit" className="sm:col-span-2" disabled={isPending}>Save cap configuration</Button>
          </form>
        </div>
      </div>

      <div className="mt-5 border p-4"><h3 className="text-sm font-medium">Contribution history</h3>{contributions.length === 0 ? <p className="mt-2 text-sm text-muted-foreground">No contributions or charges recorded yet.</p> : <div className="mt-3 overflow-x-auto"><table className="w-full text-sm"><thead className="text-left text-muted-foreground"><tr><th className="pb-2 font-medium">Date</th><th className="pb-2 font-medium">Type</th><th className="pb-2 font-medium">Amount</th><th className="pb-2 font-medium">Notes</th></tr></thead><tbody>{contributions.map((contribution) => <tr className="border-t" key={contribution.id}><td className="py-2">{contribution.date}</td><td className="py-2">{isKnownKind(contribution.kind) ? KIND_LABELS[contribution.kind] : contribution.kind}</td><td className="py-2">{money(contribution.amount, contribution.currency || displayCurrency)}</td><td className="py-2 text-muted-foreground">{contribution.notes || "-"}</td></tr>)}</tbody></table></div>}</div>
    </section>
  );
}

function isKnownKind(value: string): value is SuperContributionKind {
  return (SUPER_CONTRIBUTION_KINDS as readonly string[]).includes(value);
}

function CapProgress({ label, progress, currency }: { label: string; progress: { used: number; cap: number | null; remaining: number | null; configured: boolean }; currency: string }) {
  return <div className="border p-3"><p className="font-medium">{label}</p><p className="mt-1 text-sm">Used: {money(progress.used, currency)}</p>{progress.configured ? <p className="text-sm text-muted-foreground">{money(progress.remaining || 0, currency)} remaining of {money(progress.cap || 0, currency)}</p> : <p className="mt-1 text-sm text-muted-foreground">Cap not configured</p>}</div>;
}
