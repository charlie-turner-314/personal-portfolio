import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { formatCurrency } from "@/lib/utils";

export interface CashFlowSummaryData {
  savingsFromIncome: number;
  investments: number;
  loanPrincipal: number;
  transfersIn: number;
  transfersOut: number;
  netReportedCashFlow: number;
}

export function CashFlowSummary({ data, currency }: { data: CashFlowSummaryData; currency: string }) {
  return <Card>
    <CardHeader><CardTitle className="text-sm font-medium">Where your saving went</CardTitle></CardHeader>
    <CardContent className="space-y-4">
      <dl className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {[
          ["Saving from income", data.savingsFromIncome],
          ["Investments", data.investments],
          ["Loan principal", data.loanPrincipal],
          ["Transfers into your share", data.transfersIn],
          ["Transfers out of your share", data.transfersOut],
          ["Net reported cash flow", data.netReportedCashFlow],
        ].map(([label, value]) => <div key={String(label)}>
          <dt className="text-sm text-muted-foreground">{label}</dt>
          <dd className="font-mono font-medium">{formatCurrency(Number(value), currency, { showSign: true, maximumFractionDigits: 2 })}</dd>
        </div>)}
      </dl>
      <p className="text-xs text-muted-foreground">
        Saving from income is income minus everyday expenses, including loan interest.
        Investments and loan principal remain cash movements, shown separately from spending.
        Mark the principal portion in transaction details; unclassified payments remain spending.
      </p>
      <p className="text-xs text-muted-foreground">
        Transfers show the net visible legs of linked transfers across your ownership share or selected accounts.
        They are separate from income and do not identify which deposit funded a later payment.
        Net reported cash flow includes these transfers and allocations; unmatched or excluded transfers,
        balance adjustments and missing conversions can make it differ from your bank balance change.
      </p>
    </CardContent>
  </Card>;
}
