"use client";

import { useState, useEffect, useCallback, useRef, Suspense } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { RiArrowLeftLine, RiArrowRightLine } from "@remixicon/react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { OnboardingProgress } from "@/components/onboarding/onboarding-progress";
import { CsvMappingTable } from "@/components/transactions/csv-mapping-table";
import { CsvSamplePreview } from "@/components/transactions/csv-sample-preview";
import {
  CsvAiMappingStatus,
  type AiMappingStatus,
} from "@/components/transactions/csv-ai-mapping-status";
import {
  parseCsvHeaders,
  getAiColumnMapping,
  saveColumnMapping,
  getCsvImportSession,
  type ColumnMapping,
  type ParsedCsvData,
} from "@/lib/actions/csv-import";

function MappingPageContent() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const importId = searchParams.get("id");

  const [isLoading, setIsLoading] = useState(true);
  const [isSaving, setIsSaving] = useState(false);
  const [aiMappingStatus, setAiMappingStatus] = useState<AiMappingStatus>("idle");
  const [aiMappingError, setAiMappingError] = useState<string | undefined>();
  const [csvData, setCsvData] = useState<ParsedCsvData | null>(null);
  const [mapping, setMapping] = useState<ColumnMapping>({
    date: null,
    amount: null,
    debitAmount: null,
    creditAmount: null,
    description: null,
    merchant: null,
    transactionType: null,
    fee: null,
    state: null,
    startingBalance: null,
    endingBalance: null,
    typeConfig: {
      isAmountSigned: false,
      amountFormat: "AUTO",
      dateFormat: "DD-MM-YYYY",
    },
  });

  const aiMappingTriggeredRef = useRef(false);
  const mappingSectionRef = useRef<HTMLDivElement>(null);

  const triggerAiMapping = useCallback(async (
    id: string,
    data: ParsedCsvData,
    options: { retry?: boolean } = {}
  ) => {
    if (aiMappingTriggeredRef.current && !options.retry) return;
    aiMappingTriggeredRef.current = true;

    setAiMappingError(undefined);
    setAiMappingStatus("analyzing");
    try {
      const result = await getAiColumnMapping(id, data.headers, data.sampleRows);
      if (result.success) {
        setMapping(result.mapping);
        setAiMappingStatus("succeeded");
      } else {
        setAiMappingStatus(result.outcome);
        setAiMappingError(result.error);
      }
    } catch {
      setAiMappingStatus("failed");
      setAiMappingError("AI could not analyze this CSV. Try again or map the columns manually.");
    }
  }, []);

  const loadData = useCallback(async () => {
    if (!importId) {
      toast.error("Import ID not found");
      router.push("/step-4");
      return;
    }

    try {
      const session = await getCsvImportSession(importId);
      if (!session) {
        toast.error("Import session not found");
        router.push("/step-4");
        return;
      }

      const hasExistingMapping = session.columnMapping &&
        (
          session.columnMapping.date ||
          session.columnMapping.amount ||
          session.columnMapping.debitAmount ||
          session.columnMapping.creditAmount ||
          session.columnMapping.description
        );

      if (hasExistingMapping) {
        setMapping(session.columnMapping!);
        aiMappingTriggeredRef.current = true;
      }

      const result = await parseCsvHeaders(importId);
      if (result.success && result.data) {
        setCsvData(result.data);

        if (!hasExistingMapping) {
          triggerAiMapping(importId, result.data);
        }
      } else {
        toast.error(result.error || "Failed to parse CSV");
        router.push("/step-4");
      }
    } catch (error) {
      console.error("Failed to load data:", error);
      toast.error("Failed to load import data");
      router.push("/step-4");
    } finally {
      setIsLoading(false);
    }
  }, [importId, router, triggerAiMapping]);

  useEffect(() => {
    loadData();
  }, [loadData]);

  const handleRetryAiMapping = () => {
    if (importId && csvData) {
      void triggerAiMapping(importId, csvData, { retry: true });
    }
  };

  const handleMapManually = () => {
    setAiMappingStatus("idle");
    requestAnimationFrame(() => mappingSectionRef.current?.focus());
  };

  const handleContinue = async () => {
    if (!importId) return;

    const hasAmountMapping = Boolean(mapping.amount || mapping.debitAmount || mapping.creditAmount);
    if (!mapping.date || !hasAmountMapping || !mapping.description) {
      toast.error("Please map Date, Description, and at least one amount column");
      return;
    }

    setIsSaving(true);
    try {
      const result = await saveColumnMapping(importId, mapping);
      if (result.success) {
        router.push(`/step-4/preview?id=${importId}`);
      } else {
        toast.error(result.error || "Failed to save mapping");
      }
    } catch {
      toast.error("Failed to save mapping");
    } finally {
      setIsSaving(false);
    }
  };

  if (isLoading) {
    return (
      <div className="space-y-8">
        <OnboardingProgress currentStep={4} />
        <Card className="min-h-[640px] h-[640px] flex flex-col">
          <CardContent className="flex items-center justify-center py-12">
            <div className="text-center">
              <div className="mx-auto mb-4 h-8 w-8 animate-spin rounded-full border-2 border-muted border-t-primary" />
              <p className="text-muted-foreground">Loading CSV data...</p>
            </div>
          </CardContent>
        </Card>
      </div>
    );
  }

  if (!csvData) {
    return null;
  }

  return (
    <div className="space-y-8">
      <OnboardingProgress currentStep={4} />
      <Card className="min-h-[640px] h-[640px] flex flex-col">
        <CardHeader>
          <CardTitle>Map your columns</CardTitle>
          <CardDescription>
            Match each CSV column to the corresponding transaction field.
          </CardDescription>
        </CardHeader>
        <CardContent className="flex-1 min-h-0 flex flex-col overflow-hidden">
          <CsvAiMappingStatus
            status={aiMappingStatus}
            error={aiMappingError}
            onRetry={handleRetryAiMapping}
            onMapManually={handleMapManually}
          />

          <div className="flex-1 min-h-0 rounded-lg border bg-card overflow-hidden">
            <div className="grid h-full lg:grid-cols-2 lg:divide-x">
              <div className="flex flex-col p-6 min-h-0">
                <div className="mb-4" ref={mappingSectionRef} tabIndex={-1}>
                  <h2 className="text-lg font-semibold">Field Mapping</h2>
                  <p className="text-sm text-muted-foreground">
                    Match each CSV column to the corresponding transaction field
                  </p>
                </div>
                <div className="flex-1 min-h-0 overflow-y-auto pr-2">
                  <CsvMappingTable
                    headers={csvData.headers}
                    mapping={mapping}
                    onMappingChange={setMapping}
                  />
                </div>
              </div>

              <div className="flex flex-col border-t p-6 lg:border-t-0 min-h-0">
                <CsvSamplePreview
                  headers={csvData.headers}
                  sampleRows={csvData.sampleRows}
                  mapping={mapping}
                />
              </div>
            </div>
          </div>
        </CardContent>
        <CardFooter className="flex justify-between">
          <Button
            type="button"
            variant="outline"
            onClick={() => router.push("/step-4")}
          >
            <RiArrowLeftLine className="mr-2 h-4 w-4" />
            Back
          </Button>
          <Button onClick={handleContinue} disabled={isSaving || aiMappingStatus === "analyzing"}>
            {isSaving ? "Saving..." : "Preview Transactions"}
            <RiArrowRightLine className="ml-2 h-4 w-4" />
          </Button>
        </CardFooter>
      </Card>
    </div>
  );
}

export default function MappingPage() {
  return (
    <Suspense
      fallback={
        <div className="space-y-8">
          <OnboardingProgress currentStep={4} />
          <Card className="min-h-[640px] h-[640px] flex flex-col">
            <CardContent className="flex items-center justify-center py-12">
              <div className="text-center">
                <div className="mx-auto mb-4 h-8 w-8 animate-spin rounded-full border-2 border-muted border-t-primary" />
                <p className="text-muted-foreground">Loading...</p>
              </div>
            </CardContent>
          </Card>
        </div>
      }
    >
      <MappingPageContent />
    </Suspense>
  );
}
