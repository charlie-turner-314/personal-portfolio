import { describe, expect, it, vi } from "vitest";
vi.mock("@/lib/db",()=>({db:{}}));
import { summarizeActivity, type ActivityRow } from "@/lib/dashboard/activity";
import { categoryActualsFromActivity } from "./category-actuals";
const row=(amount:number|null,extra:Partial<ActivityRow>={}):ActivityRow=>({amount,date:"2026-01-01",categoryId:"housing",categoryName:"Housing",categoryType:"expense",icon:null,color:null,...extra});
describe("category plans use the same financial facts as reports",()=>{
  it("compares category movements while keeping consumption, principal, refunds and investment withdrawals separate",()=>{
    const activity=summarizeActivity([
      row(-1000,{cashFlowParts:[{kind:"capital",detail:"loan_principal",amount:600},{kind:"consumption",amount:400}]}),
      row(50),row(-200,{categoryId:"invest",categoryName:"Invest",cashFlowKind:"investment"}),
      row(25,{categoryId:"invest",categoryName:"Invest",cashFlowKind:"investment"}),
      row(500,{categoryType:"income",categoryId:"salary"}),
    ]);
    expect(categoryActualsFromActivity(activity)).toEqual(expect.arrayContaining([
      expect.objectContaining({id:"housing",amount:950,consumptionAmount:350,capitalAmount:600}),
      expect.objectContaining({id:"invest",amount:175,consumptionAmount:0,capitalAmount:175}),
    ]));
    expect(categoryActualsFromActivity(activity).some(category=>category.id==="salary")).toBe(false);
  });
  it("does not replace missing conversion with zero or drop a net refund",()=>{
    const actuals=categoryActualsFromActivity(summarizeActivity([row(null,{nativeAmount:-100}),row(25,{categoryId:"refund"})]));
    expect(actuals).toEqual(expect.arrayContaining([
      expect.objectContaining({id:"housing",amount:null,consumptionAmount:null,capitalAmount:null}),
      expect.objectContaining({id:"refund",amount:-25,consumptionAmount:-25,capitalAmount:0}),
    ]));
  });
});
