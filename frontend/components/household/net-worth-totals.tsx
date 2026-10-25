import { getAuthenticatedSession } from "@/lib/auth-helpers";
import { getVisibleNetWorthTotals } from "@/lib/household/net-worth";
import { formatCurrency } from "@/lib/utils";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

export async function NetWorthTotals() {
  const session = await getAuthenticatedSession();
  if (!session?.user.id) return null;
  const totals = await getVisibleNetWorthTotals(session.user.id);
  return <Card>
    <CardHeader><CardTitle>Personal net worth</CardTitle>
      <p className="text-sm text-muted-foreground">Each person’s ownership share. Shared totals do not reveal private accounts and are shown separately.</p>
    </CardHeader>
    <CardContent className="space-y-4">
      {totals.map((total) => <div key={total.userId} className="flex flex-wrap items-baseline justify-between gap-2">
        <span>{total.isOwn ? "You" : total.name || "Household member"}{!total.isOwn && <span className="ml-2 text-xs text-muted-foreground">Shared total only</span>}</span>
        <span className="font-semibold">{total.total === null ? "Total unavailable" : formatCurrency(Number(total.total), total.currency, { showSign: true })}</span>
      </div>)}
      {totals.some((total) => total.total === null) && <p className="text-sm text-muted-foreground">A total is unavailable when a valuation or currency conversion is missing.</p>}
    </CardContent>
  </Card>;
}
