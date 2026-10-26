import { getGlobalFilterQueryString,parseGlobalFiltersFromQueryString } from "@/lib/filters/global-filters";
import { describe,expect,it } from "vitest";
import { applyTransactionsQueryPatch,parseTransactionsSearchParams,toTransactionsSearchParams } from "./query-state";
import { buildCategorySpendingQuery,parseCategorySpendingSearchParams } from "@/lib/category-spending/query-params";
import { buildTransactionsDrilldownQuery } from "@/lib/dashboard/drilldown-query";
describe("reporting view survives navigation",()=>{
  it("defaults to My view and retains Household view through pagination and filtering",()=>{
    expect(parseTransactionsSearchParams({}).personId).toBeUndefined();
    const state=parseTransactionsSearchParams({person:"all",account:"joint"});
    expect(toTransactionsSearchParams(state).get("person")).toBe("all");
    const next=applyTransactionsQueryPatch(toTransactionsSearchParams(state),{page:2,search:"housing"});
    expect(next.get("person")).toBe("all");expect(next.get("account")).toBe("joint");
    expect(applyTransactionsQueryPatch(next,{personId:undefined}).has("person")).toBe(false);
  });
  it("preserves scope in cross-page navigation filters",()=>{
    const filters=parseGlobalFiltersFromQueryString("person=all&account=joint&horizon=30");
    expect(filters.personId).toBe("all");
    expect(new URLSearchParams(getGlobalFilterQueryString(filters)).get("person")).toBe("all");
  });
  it("keeps the same scope in chart and category drilldowns",()=>{
    const query=buildCategorySpendingQuery({personId:"all",categoryId:"principal",accountIds:["joint"],dateFrom:"2026-01-01",dateTo:"2026-01-31"});
    const parsed=parseCategorySpendingSearchParams(Object.fromEntries(new URLSearchParams(query)));
    expect(parsed.personId).toBe("all");
    const transactions=buildTransactionsDrilldownQuery({personId:parsed.personId,accountIds:parsed.accountIds,categoryId:"principal",dateFrom:parsed.dateFrom,dateTo:parsed.dateTo});
    expect(parseTransactionsSearchParams(Object.fromEntries(new URLSearchParams(transactions)))).toMatchObject({personId:"all",accountIds:["joint"],category:["principal"],from:"2026-01-01",to:"2026-01-31"});
  });
});
