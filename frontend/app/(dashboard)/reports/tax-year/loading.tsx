import { CardGridSkeleton, HeaderSkeleton } from "@/components/skeletons/page-skeletons";

export default function Loading() {
  return <><HeaderSkeleton title="Tax-year report" /><div className="flex flex-1 flex-col gap-4 p-4 pt-0"><CardGridSkeleton count={6} /></div></>;
}
