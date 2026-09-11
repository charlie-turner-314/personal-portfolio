"use client";
import { useState } from "react";
import { RiArrowLeftLine, RiLinksLine, RiPencilLine, RiUploadCloud2Line } from "@remixicon/react";
import type { InvestmentAccount } from "@/lib/api/investments";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { BrokerForm } from "./BrokerForm";
import { ManualForm } from "./ManualForm";
import { InvestmentImportWizard } from "./InvestmentImportWizard";

type Path = "broker" | "import" | "manual" | null;

export function ConnectPathPicker({
  accounts,
}: {
  accounts: InvestmentAccount[];
}) {
  const [picked, setPicked] = useState<Path>(null);

  const paths: {
    id: "broker" | "import" | "manual";
    icon: React.ReactNode;
    title: string;
    sub: string;
    badge: string | null;
    detail: string;
  }[] = [
    {
      id: "import",
      icon: <RiUploadCloud2Line size={17} />,
      title: "Import statement",
      sub: "Upload a broker or exchange CSV/XLSX and preview every activity.",
      badge: null,
      detail: "Reusable mappings, duplicate detection, provenance, and batch undo.",
    },
    {
      id: "broker",
      icon: <RiLinksLine size={17} />,
      title: "Connect broker",
      sub: "Read-only CoinSpot, Binance, Crypto.com Exchange, and IBKR activity sync automatically.",
      badge: "RECOMMENDED",
      detail:
        "Exchange APIs are separate from the Crypto.com App CSV import workflow.",
    },
    {
      id: "manual",
      icon: <RiPencilLine size={17} />,
      title: "Add manually",
      sub: "Search by symbol, enter quantity and optional cost basis.",
      badge: null,
      detail:
        "Prices are fetched automatically. You manage quantity updates yourself.",
    },
  ];

  if (picked === null) {
    return (
      <div className="flex-1 overflow-auto">
        <div className="p-8 max-w-3xl space-y-5">
          <p className="text-sm text-muted-foreground leading-relaxed max-w-xl">
            Choose how to track your investments. You can use both methods
            across different accounts — a brokerage account synced from IBKR
            alongside a manually-managed account for assets held elsewhere.
          </p>
          <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
            {paths.map((p) => (
              <Card
                key={p.id}
                onClick={() => setPicked(p.id)}
                className="cursor-pointer transition-colors hover:bg-muted/20 hover:border-primary"
              >
                <CardContent className="p-6 flex flex-col gap-3.5 h-full">
                  <div className="flex items-start justify-between">
                    <div className="w-9 h-9 border border-border flex items-center justify-center text-muted-foreground">
                      {p.icon}
                    </div>
                    {p.badge && (
                      <Badge className="text-[9px] tracking-wider rounded-none">
                        {p.badge}
                      </Badge>
                    )}
                  </div>
                  <div>
                    <div className="font-bold text-sm mb-1.5">{p.title}</div>
                    <div className="text-xs text-muted-foreground leading-relaxed">
                      {p.sub}
                    </div>
                  </div>
                  <div className="text-xs text-muted-foreground border-t border-border pt-3 mt-auto leading-relaxed">
                    {p.detail}
                  </div>
                </CardContent>
              </Card>
            ))}
          </div>
        </div>
      </div>
    );
  }

  const pickedTitle = paths.find((p) => p.id === picked)?.title ?? "";

  return (
    <div className="flex-1 overflow-auto">
      <div className="p-8 max-w-3xl space-y-5">
        <Button
          variant="ghost"
          size="sm"
          onClick={() => setPicked(null)}
          className="-ml-2"
        >
          <RiArrowLeftLine className="size-4" />
          Choose a different path
        </Button>
        <div className="text-xs uppercase tracking-wider text-muted-foreground">
          {pickedTitle}
        </div>
        {picked === "manual" && (
          <ManualForm accounts={accounts} onCancel={() => setPicked(null)} />
        )}
        {picked === "broker" && <BrokerForm onCancel={() => setPicked(null)} />}
        {picked === "import" && <InvestmentImportWizard accounts={accounts} />}
      </div>
    </div>
  );
}
