"use client";

import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { getAustralianFinancialYearRange } from "@/lib/dates/australian-financial-year";

type AustralianFinancialYearSelectorProps = {
  value: number;
  years: number[];
  onValueChange: (year: number) => void;
  label?: string;
};

export function AustralianFinancialYearSelector({ value, years, onValueChange, label = "Australian financial year" }: AustralianFinancialYearSelectorProps) {
  const options = Array.from(new Set([value, ...years])).sort((a, b) => b - a);

  return <Select value={String(value)} onValueChange={(next) => onValueChange(Number(next))}>
    <SelectTrigger aria-label={label} className="w-28 shrink-0"><SelectValue /></SelectTrigger>
    <SelectContent>{options.map((year) => <SelectItem key={year} value={String(year)}>{getAustralianFinancialYearRange(year).label}</SelectItem>)}</SelectContent>
  </Select>;
}
