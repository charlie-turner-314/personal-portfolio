import { defaultCashFlowPortions, type CashFlowPortion } from "./cash-flow";
import { reportingCategoryKey } from "@/lib/categories/reporting";
import { buildConservativeSankey, type SankeyCategoryInput } from "./sankey";

export interface ActivityRow {
  cashFlowKind?: string | null;
  cashFlowParts?: CashFlowPortion[] | null;
  nativeAmount?: string | number;
  transferGroupId?: string | null;
  transferAmount?: string | number | null;
  date: string;
  amount: string | number | null;
  categoryId: string | null;
  categoryName: string | null;
  categoryType: string | null;
  icon: string | null;
  color: string | null;
}

/** The query has already applied visibility, ownership and linked-group netting. */
export function summarizeActivity(rows: ActivityRow[]) {
  const daily = new Map<string, { date: string; income: number; expenses: number }>();
  const grouped = new Map<string, {
    id: string; name: string; icon: string | null; color: string | null;
    amount: number; type: "income" | "expense";
  }>();
  let missingConversions = 0;
  let investments = 0;
  let loanPrincipal = 0;
  let otherCapital = 0;
  const transfers = new Map<string, number | null>();
  for (const row of rows) {
    if (row.categoryType === "transfer" && !row.cashFlowKind && !row.cashFlowParts) {
      // Sum each visible leg independently: a hidden primary must not hide a
      // permitted credit. Equal ownership transfers cancel; unequal shares do not.
      if (row.transferGroupId) {
        if (row.transferAmount == null || !Number.isFinite(Number(row.transferAmount))) {
          missingConversions += 1;
          transfers.set(row.transferGroupId, null);
        } else if (transfers.get(row.transferGroupId) !== null) {
          transfers.set(row.transferGroupId, (transfers.get(row.transferGroupId) ?? 0) + Number(row.transferAmount));
        }
      }
      continue;
    }
    if (row.amount === null) { missingConversions += 1; continue; }
    const signedTotal = Number(row.amount);
    if (!Number.isFinite(signedTotal) || signedTotal === 0) continue;
    const nativeAmount = Number(row.nativeAmount ?? signedTotal);
    const parts = row.cashFlowParts ?? defaultCashFlowPortions(nativeAmount, row.categoryType, row.cashFlowKind);
    for (const part of parts) {
      const signed = signedTotal * part.amount / Math.abs(nativeAmount);
      if (part.kind === "capital") {
        // One calculation for every kind of capital movement.
        const allocation = -signed;
        if (part.detail === "investment") investments += allocation;
        else if (part.detail === "loan_principal") loanPrincipal += allocation;
        else otherCapital += allocation;
        continue;
      }
      const type = part.kind === "income" ? "income" : "expense";
    // Refunds retain their expense category and reduce net spending; income
    // reversals similarly reduce income rather than disappearing.
    const amount = type === "income" ? signed : -signed;
    if (!amount) continue;
    const day = daily.get(row.date) ?? { date: row.date, income: 0, expenses: 0 };
    day[type === "income" ? "income" : "expenses"] += amount;
    daily.set(row.date, day);
    const id = row.categoryId ?? "uncategorized";
    const key = row.categoryId && row.categoryName ? reportingCategoryKey(row.categoryName, type) : `${type}:${id}`;
    const category = grouped.get(key) ?? {
      id, name: row.categoryName ?? `Uncategorized ${type === "income" ? "income" : "expenses"}`,
      icon: row.icon, color: row.color, amount: 0, type,
    };
    // Pick a stable real category ID; the drilldown expands its equivalent IDs.
    if (id.localeCompare(category.id) < 0) category.id = id;
    category.amount += amount;
    grouped.set(key, category);
    }
  }
  const transferNets = [...transfers.values()].filter((value): value is number => value !== null);
  const dailyData = [...daily.values()].sort((a, b) => a.date.localeCompare(b.date));
  const categories = [...grouped.values()].sort((a, b) => b.amount - a.amount);
  return {
    missingConversions,
    investments,
    loanPrincipal,
    otherCapital,
    transfersIn: transferNets.reduce((sum, value) => sum + Math.max(value, 0), 0),
    transfersOut: transferNets.reduce((sum, value) => sum + Math.max(-value, 0), 0),
    dailyData,
    income: dailyData.reduce((sum, day) => sum + day.income, 0),
    expenses: dailyData.reduce((sum, day) => sum + day.expenses, 0),
    categories,
  };
}

export type ActivitySummary = ReturnType<typeof summarizeActivity>;

/** Keep a readable chart without silently dropping the smaller categories. */
function chartCategories(summary: ActivitySummary, type: "income" | "expense", limit: number): SankeyCategoryInput[] {
  // A category can be net negative (e.g. a refund for an earlier period).
  // Display that cash on the opposite side with an explicit reversal label;
  // Sankey links cannot be negative. Net cash flow remains unchanged.
  const all = summary.categories.flatMap((category) => {
    const chartType = category.amount < 0
      ? category.type === "expense" ? "income" : "expense"
      : category.type;
    if (chartType !== type || category.amount === 0) return [];
    return [{
      ...category, amount: Math.abs(category.amount),
      name: category.amount < 0
        ? `${category.type === "expense" ? "Refunds" : "Income reversals"}: ${category.name}`
        : category.name,
    }];
  }).sort((a, b) => b.amount - a.amount);
  const visible = all.slice(0, limit).map((category) => ({
    categoryId: category.id, categoryName: category.name, total: category.amount, categoryType: type,
  }));
  const remainder = all.slice(limit).reduce((sum, category) => sum + category.amount, 0);
  if (remainder > 0) visible.push({
    categoryId: "", categoryName: type === "income" ? "Other income" : "Other expenses",
    total: remainder, categoryType: type,
  });
  return visible;
}

export function activitySankey(summary: ActivitySummary) {
  const income = chartCategories(summary, "income", 6);
  const expense = chartCategories(summary, "expense", 8);
  const movement = (name: string, amount: number) => {
    if (!amount) return;
    (amount > 0 ? expense : income).push({
      categoryName: amount > 0 ? name : `Returned: ${name}`,
      total: Math.abs(amount), categoryType: amount > 0 ? "expense" : "income",
    });
  };
  movement("Investments", summary.investments);
  movement("Loan principal", summary.loanPrincipal);
  movement("Other capital", summary.otherCapital);
  if (summary.transfersIn) income.push({ categoryName: "Transfers in", total: summary.transfersIn, categoryType: "income" });
  if (summary.transfersOut) expense.push({ categoryName: "Transfers out", total: summary.transfersOut, categoryType: "expense" });
  return buildConservativeSankey(income, expense);
}

export function cashFlowMetrics(activity: ActivitySummary) {
  const savingsFromIncome = activity.income - activity.expenses;
  return {
    savingsFromIncome,
    investments: activity.investments,
    loanPrincipal: activity.loanPrincipal,
    otherCapital: activity.otherCapital,
    transfersIn: activity.transfersIn,
    transfersOut: activity.transfersOut,
    explainedCashFlow: savingsFromIncome - activity.investments - activity.loanPrincipal - activity.otherCapital + activity.transfersIn - activity.transfersOut,
  };
}
