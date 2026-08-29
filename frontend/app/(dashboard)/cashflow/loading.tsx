import {
  CardGridSkeleton,
  HeaderSkeleton,
  TableSkeleton,
} from "@/components/skeletons/page-skeletons";

export default function Loading() {
  return (
    <>
      <HeaderSkeleton title="Cashflow" />
      <div className="flex flex-1 flex-col gap-4 p-4 pt-0">
        <CardGridSkeleton count={5} />
        <TableSkeleton rows={8} />
      </div>
    </>
  );
}
