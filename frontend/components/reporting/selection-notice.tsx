import Link from "next/link";

export function hasUnavailableAccountSelection(accounts:{id:string}[],selectedIds?:string[]) {
  const permitted=new Set(accounts.map(account=>account.id));
  return (selectedIds??[]).some(id=>!permitted.has(id));
}

export function ReportingSelectionNotice({clearHref}:{clearHref:string}) {
  return <div className="p-4 space-y-3">
    <p role="alert">Some selected accounts are no longer available. This report cannot be calculated for that selection.</p>
    <Link className="underline" href={clearHref}>Clear account filter</Link>
  </div>;
}
