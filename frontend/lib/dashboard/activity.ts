import { reportingCategoryKey } from "@/lib/categories/reporting";
import { buildConservativeSankey, type SankeyCategoryInput } from "./sankey";

export interface ActivityRow {
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
  for (const row of rows) {
    if (row.categoryType === "transfer") continue;
    if (row.amount === null) { missingConversions += 1; continue; }
    const signed = Number(row.amount);
    if (!Number.isFinite(signed) || signed === 0 || row.categoryType === "transfer") continue;
    const type = row.categoryType === "income" || row.categoryType === "expense"
      ? row.categoryType : signed > 0 ? "income" : "expense";
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
  const dailyData = [...daily.values()].sort((a, b) => a.date.localeCompare(b.date));
  const categories = [...grouped.values()].sort((a, b) => b.amount - a.amount);
  return {
    missingConversions,
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
  return buildConservativeSankey(chartCategories(summary, "income", 6), chartCategories(summary, "expense", 8));
}
