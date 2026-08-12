import {
  CardGridSkeleton,
  HeaderSkeleton,
  TableSkeleton,
} from "@/components/skeletons/page-skeletons";

export default function Loading() {
  return (
    <>
      <HeaderSkeleton title="Budget" />
      <div className="flex flex-1 flex-col gap-4 p-4 pt-0">
        <CardGridSkeleton count={4} />
        <TableSkeleton rows={8} />
      </div>
    </>
  );
}
