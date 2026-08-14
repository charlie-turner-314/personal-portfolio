import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { currencySymbol } from "@/lib/utils/currency";
import type { RealisedCgtDisposal } from "./cgt-types";

function money(value: string | null, currency: string) {
  const number = Number(value);
  return value != null && Number.isFinite(number)
    ? `${currencySymbol(currency)} ${number.toLocaleString("en", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
    : "Unavailable";
}

function gainClass(value: string | null) {
  const number = Number(value);
  if (!Number.isFinite(number)) return "text-muted-foreground";
  return number < 0 ? "text-destructive" : "text-emerald-600 dark:text-emerald-400";
}

function StatusBadge({ status }: { status: RealisedCgtDisposal["calculation_status"] }) {
  if (status === "complete") return <Badge variant="outline">Calculated</Badge>;
  if (status === "partial") return <Badge variant="secondary">Review required</Badge>;
  return <Badge variant="outline">Unavailable</Badge>;
}

function Assumptions({ assumptions }: { assumptions?: string[] }) {
  if (!assumptions?.length) return null;
  return <p className="mt-2 text-xs text-muted-foreground">Assumptions: {assumptions.join(" ")}</p>;
}

export function RealisedCgtDisposals({ disposals = [] }: { disposals?: RealisedCgtDisposal[] }) {
  return <Card>
    <CardHeader className="p-4 pb-0">
      <CardTitle className="text-sm">Realised capital gains</CardTitle>
      <p className="mt-1 text-xs text-muted-foreground">Disposals are shown with their recorded FIFO allocation detail. This is a record of calculation inputs, not tax advice.</p>
    </CardHeader>
    <CardContent className="p-4">
      {disposals.length === 0 ? <p className="text-sm text-muted-foreground">No realised disposals are available for this holding.</p> : <div className="overflow-x-auto">
        <table className="w-full min-w-[700px] text-sm">
          <thead><tr className="border-b text-left text-xs uppercase tracking-wider text-muted-foreground"><th className="py-2 pr-4">Disposal date</th><th className="py-2 pr-4 text-right">Quantity</th><th className="py-2 pr-4 text-right">Cost base</th><th className="py-2 pr-4 text-right">Proceeds</th><th className="py-2 pr-4 text-right">Gain / loss</th><th className="py-2 pr-4">Status</th><th className="py-2 text-right">Lots</th></tr></thead>
          <tbody>{disposals.map((disposal) => <tr className="border-b last:border-b-0" key={disposal.id}>
            <td className="py-3 pr-4 tabular-nums align-top">{disposal.disposal_date}</td>
            <td className="py-3 pr-4 text-right tabular-nums align-top">{Number(disposal.quantity).toLocaleString("en", { maximumFractionDigits: 4 })}</td>
            <td className="py-3 pr-4 text-right tabular-nums align-top">{money(disposal.cost_base, disposal.currency)}</td>
            <td className="py-3 pr-4 text-right tabular-nums align-top">{money(disposal.proceeds, disposal.currency)}</td>
            <td className={`py-3 pr-4 text-right tabular-nums align-top ${gainClass(disposal.capital_gain)}`}>{money(disposal.capital_gain, disposal.currency)}</td>
            <td className="py-3 pr-4 align-top"><StatusBadge status={disposal.calculation_status} /></td>
            <td className="py-3 text-right align-top"><details className="text-left"><summary className="cursor-pointer text-xs font-medium text-foreground">{disposal.allocations.length} allocation{disposal.allocations.length === 1 ? "" : "s"}</summary><div className="mt-3 min-w-[520px] border-l pl-3"><table className="w-full text-xs"><thead><tr className="text-left text-muted-foreground"><th className="pb-2">Acquired</th><th className="pb-2 text-right">Qty</th><th className="pb-2 text-right">Cost base</th><th className="pb-2 text-right">Proceeds</th><th className="pb-2 text-right">Gain / loss</th><th className="pb-2">Discount</th></tr></thead><tbody>{disposal.allocations.map((allocation) => <tr className="border-t" key={allocation.id}><td className="py-2 tabular-nums">{allocation.acquisition_date}</td><td className="py-2 text-right tabular-nums">{Number(allocation.quantity).toLocaleString("en", { maximumFractionDigits: 4 })}</td><td className="py-2 text-right tabular-nums">{money(allocation.cost_base, allocation.currency)}</td><td className="py-2 text-right tabular-nums">{money(allocation.proceeds, allocation.currency)}</td><td className={`py-2 text-right tabular-nums ${gainClass(allocation.capital_gain)}`}>{money(allocation.capital_gain, allocation.currency)}</td><td className="py-2">{allocation.discount_eligible == null ? "Unavailable" : allocation.discount_eligible ? "Eligible" : "Not eligible"}</td></tr>)}</tbody></table><Assumptions assumptions={disposal.assumptions} />{disposal.unavailable_reason ? <p className="mt-2 text-xs text-muted-foreground">Unavailable: {disposal.unavailable_reason}</p> : null}</div></details></td>
          </tr>)}</tbody>
        </table>
      </div>}
    </CardContent>
  </Card>;
}
