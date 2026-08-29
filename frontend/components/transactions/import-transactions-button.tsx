import { RiUploadCloud2Line } from "@remixicon/react";
import { Button } from "@/components/ui/button";

interface ImportTransactionsButtonProps {
  onImport: () => void;
}

export function ImportTransactionsButton({
  onImport,
}: ImportTransactionsButtonProps) {
  return (
    <Button
      variant="outline"
      onClick={onImport}
      data-walkthrough="walkthrough-import"
    >
      <RiUploadCloud2Line className="mr-2 h-4 w-4" />
      Import transactions
    </Button>
  );
}
