import { TransactionsClient } from "./transactions-client";
import { getTransactionsPage, getUserAccounts } from "@/lib/actions/transactions";
import { getUserCategories } from "@/lib/actions/categories";
import { getProperties } from "@/lib/actions/properties";
import { getAuthenticatedSession } from "@/lib/auth-helpers";
import { isDemoRestrictedUserEmail } from "@/lib/demo-access";
import type { TransactionsQueryState } from "@/lib/transactions/query-state";

export async function TransactionsSection({
  queryState,
}: {
  queryState: TransactionsQueryState;
}) {
  const [session, pageData, categories, accounts, properties] = await Promise.all([
    getAuthenticatedSession(),
    getTransactionsPage(queryState),
    getUserCategories(),
    getUserAccounts(),
    getProperties(),
  ]);

  const canImportCsv =
    !!process.env.OPENAI_API_KEY &&
    !isDemoRestrictedUserEmail(session?.user.email);
  const canDelete = !isDemoRestrictedUserEmail(session?.user.email);

  return (
    <TransactionsClient
      initialTransactions={pageData.rows}
      totalCount={pageData.totalCount}
      filteredTotals={pageData.filteredTotals}
      initialQueryState={queryState}
      categories={categories}
      accounts={accounts}
      properties={properties}
      canImportCsv={canImportCsv}
      canDelete={canDelete}
    />
  );
}
