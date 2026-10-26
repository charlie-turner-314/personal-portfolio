import { hasUnavailableAccountSelection,ReportingSelectionNotice } from "@/components/reporting/selection-notice";
import { toTransactionsSearchParams } from "@/lib/transactions/query-state";
import { TransactionsClient } from "./transactions-client";
import { getTransactionsPage, getUserAccounts } from "@/lib/actions/transactions";
import { getUserCategories, getReportingCategories } from "@/lib/actions/categories";
import { getProperties } from "@/lib/actions/properties";
import { getAuthenticatedSession } from "@/lib/household/financial-auth";
import { isDemoRestrictedUserEmail } from "@/lib/demo-access";
import type { TransactionsQueryState } from "@/lib/transactions/query-state";

export async function TransactionsSection({
  queryState,
}: {
  queryState: TransactionsQueryState;
}) {
  const accounts=await getUserAccounts();
  if(hasUnavailableAccountSelection(accounts,queryState.accountIds))return <ReportingSelectionNotice clearHref={`/transactions?${toTransactionsSearchParams({...queryState,accountIds:[],page:1})}`} />;
  const [session, pageData, categories, properties, filterCategories] = await Promise.all([
    getAuthenticatedSession(),
    getTransactionsPage(queryState),
    getUserCategories(),
    getProperties(),
    getReportingCategories(),
  ]);

  const canImportCsv = !isDemoRestrictedUserEmail(session?.user.email);
  const canDelete = !isDemoRestrictedUserEmail(session?.user.email);

  return (
    <TransactionsClient
      initialTransactions={pageData.rows}
      totalCount={pageData.totalCount}
      filteredTotals={pageData.filteredTotals}
      initialQueryState={queryState}
      categories={categories}
      filterCategories={filterCategories}
      accounts={accounts}
      properties={properties}
      canImportCsv={canImportCsv}
      canDelete={canDelete}
    />
  );
}
