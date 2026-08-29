import { Suspense } from "react";
import { Header } from "@/components/layout/header";
import { CashflowClient } from "@/components/cashflow/cashflow-client";
import { CardGridSkeleton, TableSkeleton } from "@/components/skeletons/page-skeletons";
import {
  getCashflowForecast,
  getCashflowOverrideFormOptions,
} from "@/lib/actions/cashflow-forecast";

export default function CashflowPage() {
  return (
    <>
      <Header title="Cashflow" />
      <Suspense
        fallback={
          <div className="flex flex-1 flex-col gap-4 p-4 pt-0">
            <CardGridSkeleton count={5} />
            <TableSkeleton rows={8} />
          </div>
        }
      >
        <CashflowSection />
      </Suspense>
    </>
  );
}

async function CashflowSection() {
  const [forecast, formOptions] = await Promise.all([
    getCashflowForecast(),
    getCashflowOverrideFormOptions(),
  ]);

  return <CashflowClient forecast={forecast} formOptions={formOptions} />;
}
