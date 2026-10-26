import { defaultCashFlowPortions, type CashFlowPortion } from "./cash-flow";
import { reportingCategoryKey } from "@/lib/categories/reporting";
import { buildConservativeSankey, type SankeyCategoryInput } from "./sankey";

export interface ActivityRow {
  cashFlowKind?: string | null;
  cashFlowParts?: CashFlowPortion[] | null;
  nativeAmount?: string | number;
  transferGroupId?: string | null;
  transferAmount?: string | number | null;
  transferFullAmount?: string | number | null;
  transactionId?:string;
  accountId?:string;
  merchant?:string|null;
  description?:string|null;
  recurringName?:string|null;
  recurrenceKnown?:boolean;
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
  const transfers = new Map<string, { net:number|null; fullNet:number|null; legs:number }>();
  const entries: { transactionId?:string; accountId?:string; date:string; categoryId:string; categoryName:string;
    color:string|null; icon:string|null; kind:"income"|"consumption"|"capital"; detail?:string; amount:number;
    merchant?:string|null; description?:string|null; recurringName?:string|null; recurrenceKnown?:boolean }[]=[];
  const incompleteCategories=new Set<string>();
  const incompleteMovements=new Map<string,{id:string;name:string;color:string|null;icon:string|null}>();
  for (const [index,row] of rows.entries()) {
    if (row.categoryType === "transfer" && !row.cashFlowKind && !row.cashFlowParts) {
      // A closed visible pair can establish an economic redistribution; a
      // lone/incomplete leg only establishes movement across this boundary.
      // No private peer, balance or ownership metadata is consulted.
      if(row.transferGroupId===null) continue; // already netted against an included expense
      const key=row.transferGroupId??`unlinked:${row.transactionId??index}`;
      const group=transfers.get(key)??{net:0,fullNet:0,legs:0};
      const value=row.transferAmount===undefined?row.amount:row.transferAmount;
      if(value==null || !Number.isFinite(Number(value))) {missingConversions++;group.net=null;}
      else if(group.net!==null) group.net+=Number(value);
      if(row.transferFullAmount==null || !Number.isFinite(Number(row.transferFullAmount))) group.fullNet=null;
      else if(group.fullNet!==null) group.fullNet+=Number(row.transferFullAmount);
      group.legs++;
      transfers.set(key,group);
      continue;
    }
    if (row.amount === null) {
      missingConversions++;
      incompleteCategories.add(row.categoryId??"uncategorized");
      const parts=row.cashFlowParts??defaultCashFlowPortions(Number(row.nativeAmount??0),row.categoryType,row.cashFlowKind);
      if(parts.some(part=>part.kind!=="income")) incompleteMovements.set(row.categoryId??"uncategorized",{
        id:row.categoryId??"uncategorized",name:row.categoryName??"Uncategorized",color:row.color,icon:row.icon});
      continue;
    }
    const signedTotal = Number(row.amount);
    if (!Number.isFinite(signedTotal) || signedTotal === 0) continue;
    const nativeAmount = Number(row.nativeAmount ?? signedTotal);
    const parts = row.cashFlowParts ?? defaultCashFlowPortions(nativeAmount, row.categoryType, row.cashFlowKind);
    for (const part of parts) {
      const signed = signedTotal * part.amount / Math.abs(nativeAmount);
      const movementAmount=part.kind==="income"?signed:-signed;
      entries.push({transactionId:row.transactionId,accountId:row.accountId,date:row.date,
        categoryId:row.categoryId??"uncategorized",categoryName:row.categoryName??"Uncategorized",
        color:row.color,icon:row.icon,kind:part.kind,detail:part.detail,amount:movementAmount,
        merchant:row.merchant,description:row.description,recurringName:row.recurringName,recurrenceKnown:row.recurrenceKnown});
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
    const key = row.categoryId && row.categoryName ? reportingCategoryKey(row.categoryId, type) : `${type}:${id}`;
    const category = grouped.get(key) ?? {
      id, name: row.categoryName ?? `Uncategorized ${type === "income" ? "income" : "expenses"}`,
      icon: row.icon, color: row.color, amount: 0, type,
    };
    // Retain the real classification ID for exact drilldown.
    if (id.localeCompare(category.id) < 0) category.id = id;
    category.amount += amount;
    grouped.set(key, category);
    }
  }
  const transferGroups=[...transfers.values()].filter(group=>group.net!==null);
  const closed=(group:typeof transferGroups[number])=>group.legs>=2&&group.fullNet!==null&&Math.abs(group.fullNet)<0.005;
  const incoming=(groups:typeof transferGroups)=>groups.reduce((sum,group)=>sum+Math.max(group.net??0,0),0);
  const outgoing=(groups:typeof transferGroups)=>groups.reduce((sum,group)=>sum+Math.max(-(group.net??0),0),0);
  const dailyData = [...daily.values()].sort((a, b) => a.date.localeCompare(b.date));
  const categories = [...grouped.values()].sort((a, b) => b.amount - a.amount);
  return {
    missingConversions,
    investments,
    loanPrincipal,
    otherCapital,
    transfersIn: incoming(transferGroups),
    transfersOut: outgoing(transferGroups),
    boundaryTransfersIn: incoming(transferGroups.filter(group=>!closed(group))),
    boundaryTransfersOut: outgoing(transferGroups.filter(group=>!closed(group))),
    ownershipTransfersIn: incoming(transferGroups.filter(closed)),
    ownershipTransfersOut: outgoing(transferGroups.filter(closed)),
    entries,
    incompleteCategoryIds:[...incompleteCategories],
    incompleteMovementCategories:[...incompleteMovements.values()],
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
    boundaryTransfersIn:activity.boundaryTransfersIn,
    boundaryTransfersOut:activity.boundaryTransfersOut,
    ownershipTransfersIn:activity.ownershipTransfersIn,
    ownershipTransfersOut:activity.ownershipTransfersOut,
    explainedCashFlow: savingsFromIncome - activity.investments - activity.loanPrincipal - activity.otherCapital + activity.transfersIn - activity.transfersOut,
  };
}
