import { Suspense } from "react";
import { Header } from "@/components/layout/header";
import { CardGridSkeleton, ChartSkeleton, DetailListSkeleton } from "@/components/skeletons/page-skeletons";
import { InvestmentsSection } from "./_sections";
import { InvestmentsPersonFilterBar } from "./_client";

export default async function InvestmentsPage({ searchParams }: { searchParams: Promise<{ financialYearStart?: string; personIds?: string }> }) {
  const params = await searchParams;
  const year = Number(params.financialYearStart);
  const financialYearStart = Number.isInteger(year) && year >= 1900 && year <= 2200 ? year : undefined;
  return (
    <>
      <Header title="Investments" />
      <div className="flex flex-1 flex-col gap-6 p-4 pt-0">
        <Suspense><InvestmentsPersonFilterBar /></Suspense>
        <Suspense
          fallback={
            <>
              <CardGridSkeleton count={3} />
              <ChartSkeleton />
              <DetailListSkeleton rows={6} />
            </>
          }
        >
          <InvestmentsSection financialYearStart={financialYearStart} personScope={params.personIds || "self"} />
        </Suspense>
      </div>
    </>
  );
}
