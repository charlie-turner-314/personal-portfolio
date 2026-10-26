"use client";
import { useTransition } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { PersonFilter } from "@/components/dashboard/person-filter";

export function InvestmentsPersonFilterBar() {
  const router = useRouter();
  const params = useSearchParams();
  const [pending, startTransition] = useTransition();
  const selected = params.get("personIds")?.split(",").filter(Boolean) ?? [];
  return <div>
    <PersonFilter personalDefault value={selected} onChange={(value) => {
      const next = new URLSearchParams(params.toString());
      const selection = value.length > 1 ? value.filter((item) => item !== "all") : value;
      if (selection.length) next.set("personIds", selection.join(",")); else next.delete("personIds");
      startTransition(() => router.push(`/investments?${next}`));
    }} />
    {pending && <p role="status" className="text-xs text-muted-foreground">Updating investment ownership view…</p>}
  </div>;
}
