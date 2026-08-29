import { notFound } from "next/navigation";
import { AccountDetail } from "./account-detail";
import { getAccountById, getAccountBalanceHistory } from "@/lib/actions/accounts";
import { getTransactionsForAccount } from "@/lib/actions/transactions";
import { getUserCategories } from "@/lib/actions/categories";
import { listHoldings, type Holding } from "@/lib/api/investments";
import { HoldingsTable } from "@/components/investments/HoldingsTable";
import { SuperAccountManager } from "@/components/superannuation/super-account-manager";
import { getSuperAccountDetails, getSuperCapProgress } from "@/lib/actions/superannuation";
import { getAustralianFinancialYearStartYear } from "@/lib/dates/australian-financial-year";

const INVESTMENT_ACCOUNT_TYPES = new Set([
  "investment_brokerage",
  "investment_manual",
]);

interface AccountPageProps {
  params: Promise<{ accountId: string }>;
}

export default async function AccountPage({ params }: AccountPageProps) {
  const { accountId } = await params;

  // First fetch account to verify it exists and user has access
  const account = await getAccountById(accountId);

  if (!account) {
    notFound();
  }

  const isInvestmentAccount = INVESTMENT_ACCOUNT_TYPES.has(account.accountType);
  const isSuperAccount = account.accountType === "superannuation";
  const financialYearStart = getAustralianFinancialYearStartYear();

  // Then fetch remaining data in parallel
  const [balanceHistory, transactions, categories, holdings, superAccount, superCapProgress] =
    await Promise.all([
      getAccountBalanceHistory(accountId, null),
      getTransactionsForAccount(accountId),
      getUserCategories(),
      isInvestmentAccount
        ? listHoldings(accountId).catch(() => [] as Holding[])
        : Promise.resolve([] as Holding[]),
      isSuperAccount ? getSuperAccountDetails(accountId) : Promise.resolve(null),
      isSuperAccount ? getSuperCapProgress(financialYearStart) : Promise.resolve(null),
    ]);

  return (
    <div className="flex flex-col gap-4 p-4">
      <AccountDetail
        account={account}
        balanceHistory={balanceHistory}
        initialTransactions={transactions}
        categories={categories}
      />
      {isSuperAccount && superAccount && (
        <SuperAccountManager
          accountId={accountId}
          currency={account.currency}
          fundName={superAccount.fundName}
          investmentOption={superAccount.investmentOption}
          includeInNetWorth={superAccount.includeInNetWorth}
          contributions={superAccount.contributions}
          financialYearStart={financialYearStart}
          capProgress={superCapProgress}
        />
      )}
      {isInvestmentAccount && (
        <section className="rounded-xl border p-4">
          <h2 className="font-medium mb-3">Holdings</h2>
          <HoldingsTable holdings={holdings} />
        </section>
      )}
    </div>
  );
}
