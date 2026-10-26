import { fetchFinancialActivity, type ActivityBoundary } from "@/lib/reporting/activity-query";
import type { ActivitySummary } from "@/lib/dashboard/activity";

export interface CategoryActualAmount {
  id:string;
  name:string;
  color:string|null;
  icon:string|null;
  amount:number|null;
  consumptionAmount:number|null;
  capitalAmount:number|null;
}

/** Plans compare category movements while consumption and capital remain
 * separate factual amounts. Refunds/withdrawals reduce their own purpose.
 */
export function categoryActualsFromActivity(activity:ActivitySummary,includeUncategorized=true):CategoryActualAmount[] {
  const result=new Map<string,CategoryActualAmount>();
  for(const entry of activity.entries) {
    if(entry.kind==="income" || (!includeUncategorized && entry.categoryId==="uncategorized")) continue;
    const row=result.get(entry.categoryId)??{id:entry.categoryId,name:entry.categoryName,color:entry.color,icon:entry.icon,
      amount:0,consumptionAmount:0,capitalAmount:0};
    row.amount=(row.amount??0)+entry.amount;
    if(entry.kind==="capital") row.capitalAmount=(row.capitalAmount??0)+entry.amount;
    else row.consumptionAmount=(row.consumptionAmount??0)+entry.amount;
    result.set(entry.categoryId,row);
  }
  for(const missing of activity.incompleteMovementCategories) {
    if(!includeUncategorized && missing.id==="uncategorized") continue;
    result.set(missing.id,{...missing,amount:null,consumptionAmount:null,capitalAmount:null});
  }
  return [...result.values()].sort((a,b)=>(b.amount??0)-(a.amount??0)||a.id.localeCompare(b.id));
}

export async function fetchCategoryActualAmounts(actor:string,options:ActivityBoundary&{includeUncategorized?:boolean}):Promise<CategoryActualAmount[]> {
  return categoryActualsFromActivity(await fetchFinancialActivity(actor,options),options.includeUncategorized??true);
}
