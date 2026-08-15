"use client";

import { RiErrorWarningLine, RiRefreshLine } from "@remixicon/react";
import { Header } from "@/components/layout/header";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

export default function Error({ reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return <><Header title="Tax-year report" /><div className="flex flex-1 flex-col p-4 pt-0"><Card className="max-w-xl"><CardHeader><div className="flex items-center gap-2"><RiErrorWarningLine className="size-4 text-destructive" /><CardTitle>Tax-year report failed to load</CardTitle></div></CardHeader><CardContent className="flex flex-col items-start gap-4"><p className="text-muted-foreground">Try loading the report again.</p><Button type="button" onClick={reset}><RiRefreshLine />Retry</Button></CardContent></Card></div></>;
}
