import type { CashReconciliation } from "@/lib/dashboard/cash-flow";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { formatCurrency } from "@/lib/utils";

export interface CashFlowSummaryData {
  savingsFromIncome: number;
  investments: number;
  loanPrincipal: number;
  otherCapital?: number;
  boundaryTransfersIn?:number;
  boundaryTransfersOut?:number;
  ownershipTransfersIn?:number;
  ownershipTransfersOut?:number;
  transfersIn: number;
  transfersOut: number;
  explainedCashFlow: number;
}

export function CashFlowSummary({ data, currency, reconciliation }: { data: CashFlowSummaryData; currency: string; reconciliation?: CashReconciliation }) {
  return <Card>
    <CardHeader><CardTitle className="text-sm font-medium">Income, consumption and capital movements</CardTitle></CardHeader>
    <CardContent className="space-y-4">
      <dl className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {[
          ["Saving from income", data.savingsFromIncome],
          ["Investments", data.investments],
          ["Loan principal", data.loanPrincipal],
          ["Other capital", data.otherCapital ?? 0],
          ["Boundary transfers in", data.boundaryTransfersIn??data.transfersIn],
          ["Boundary transfers out", data.boundaryTransfersOut??data.transfersOut],
          ["Ownership redistribution in", data.ownershipTransfersIn??0],
          ["Ownership redistribution out", data.ownershipTransfersOut??0],
          ["Explained cash flow", data.explainedCashFlow],
        ].map(([label, value]) => <div key={String(label)}>
          <dt className="text-sm text-muted-foreground">{label}</dt>
          <dd className="font-mono font-medium">{formatCurrency(Number(value), currency, { showSign: true, maximumFractionDigits: 2 })}</dd>
        </div>)}
      </dl>
      <dl className="grid gap-4 sm:grid-cols-2">
        {[["Recorded cash balance change", reconciliation?.recordedChange], ["Unreconciled difference", reconciliation?.difference]].map(([label, value]) => <div key={String(label)}>
          <dt className="text-sm text-muted-foreground">{label}</dt>
          <dd className="font-mono font-medium">{typeof value === "number" ? formatCurrency(value, currency, { showSign: true, maximumFractionDigits: 2 }) : "Unavailable"}</dd>
        </div>)}
      </dl>
      <p role="status" className="text-xs text-muted-foreground">
        {reconciliation?.status === "matched" ? "Recorded cash balances agree with explained flows." :
          reconciliation?.status === "difference" ? "Cash is not fully reconciled. The difference may include unmatched transfers, balance adjustments, credit facilities or ownership changes; it is not a measure of personal overspending." :
          reconciliation?.status === "incomplete" ? "Cash reconciliation is incomplete while currency conversions are missing." :
          "Cash balance change is unavailable: exact opening and closing balances are needed for every selected active bank/cash account."}
      </p>
      <p className="text-xs text-muted-foreground">
        Saving from income is income minus everyday expenses, including loan interest.
        Investments and loan principal remain cash movements, shown separately from spending.
        Set payment portions in transaction details; unclassified payments remain spending.
      </p>
      <p className="text-xs text-muted-foreground">
        Ownership redistribution uses balanced, visible linked legs and their dated shares. A missing, private, unselected or out-of-period counterpart is a boundary movement; it establishes no gift, loan or funding relationship.
        Explained cash flow is saving minus capital allocations plus net boundary and ownership movements.
        Recorded cash change uses independent daily balances; a difference stays visible rather than being called a funding gap.
      </p>
    </CardContent>
  </Card>;
}
