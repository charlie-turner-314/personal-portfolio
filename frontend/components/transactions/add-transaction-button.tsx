import { RiAddLine } from "@remixicon/react";
import { Button } from "@/components/ui/button";

interface AddTransactionButtonProps {
  onAddManual: () => void;
}

export function AddTransactionButton({
  onAddManual,
}: AddTransactionButtonProps) {
  return (
    <Button onClick={onAddManual}>
      <RiAddLine className="mr-2 h-4 w-4" />
      Add Transaction
    </Button>
  );
}
