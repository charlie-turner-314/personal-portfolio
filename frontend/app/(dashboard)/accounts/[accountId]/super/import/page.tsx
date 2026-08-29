import { notFound } from "next/navigation";
import { getAccountById } from "@/lib/actions/accounts";
import { getSuperAccountDetails } from "@/lib/actions/superannuation";
import { SuperStatementImport } from "@/components/superannuation/super-statement-import";

interface SuperStatementImportPageProps {
  params: Promise<{ accountId: string }>;
}

export default async function SuperStatementImportPage({ params }: SuperStatementImportPageProps) {
  const { accountId } = await params;
  const [account, superAccount] = await Promise.all([
    getAccountById(accountId),
    getSuperAccountDetails(accountId),
  ]);

  if (!account || account.accountType !== "superannuation" || !superAccount) notFound();

  return <SuperStatementImport accountId={accountId} />;
}
