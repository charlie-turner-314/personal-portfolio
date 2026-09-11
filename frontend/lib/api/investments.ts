"use server";

import { getAuthenticatedSession, requireAuth } from "@/lib/auth-helpers";
import { getBackendBaseUrl } from "@/lib/backend-url";
import { createInternalAuthHeaders } from "@/lib/internal-auth";
import {
  isDemoRestrictedUserEmail,
  DEMO_RESTRICTED_ACTION_ERROR,
} from "@/lib/demo-access";

async function assertNotDemoRestricted(): Promise<void> {
  const session = await getAuthenticatedSession();
  if (isDemoRestrictedUserEmail(session?.user?.email)) {
    throw new Error(DEMO_RESTRICTED_ACTION_ERROR);
  }
}

export type Holding = {
  id: string;
  account_id: string;
  symbol: string;
  provider_symbol?: string | null;
  name: string | null;
  currency: string;
  instrument_type: "equity" | "etf" | "cash" | "crypto" | "other";
  quantity: string;
  avg_cost?: string | null;
  as_of_date?: string | null;
  source: "manual" | "ibkr_flex" | "trade_import" | "activity_import" | "coinspot_api" | "binance_api";
  current_price?: string | null;
  current_value_user_currency?: string | null;
  cost_basis_user_currency?: string | null;
  is_stale: boolean;
};

export type PortfolioAccount = {
  id: string;
  name: string;
  value: string | number;
  type: string;
  currency?: string;
};

export type PortfolioSummary = {
  total_value: string;
  total_value_today_change: string;
  currency: string;
  accounts: PortfolioAccount[];
  allocation_by_type: Record<string, string>;
  allocation_by_currency: Record<string, string>;
};

export type ValuationPoint = { date: string; value: string };

export type SymbolSearchResult = {
  symbol: string;
  name: string;
  exchange?: string | null;
  currency?: string | null;
};

function buildUrl(path: string, query?: Record<string, string | undefined>): {
  url: string;
  pathWithQuery: string;
} {
  const backendBase = getBackendBaseUrl().replace(/\/+$/, "");
  const search = new URLSearchParams();
  if (query) {
    for (const [k, v] of Object.entries(query)) {
      if (v !== undefined && v !== null && v !== "") search.set(k, v);
    }
  }
  const qs = search.toString();
  const pathWithQuery = qs ? `${path}?${qs}` : path;
  return { url: `${backendBase}${pathWithQuery}`, pathWithQuery };
}

async function signedFetch(
  method: string,
  path: string,
  options: { query?: Record<string, string | undefined>; body?: unknown } = {},
): Promise<Response> {
  const userId = await requireAuth();
  if (!userId) throw new Error("Not authenticated");
  const { url, pathWithQuery } = buildUrl(path, options.query);
  const signatureHeaders = createInternalAuthHeaders({
    method,
    pathWithQuery,
    userId,
  });
  const headers: Record<string, string> = { ...signatureHeaders };
  let body: string | undefined;
  if (options.body !== undefined) {
    headers["Content-Type"] = "application/json";
    body = JSON.stringify(options.body);
  }
  return fetch(url, { method, headers, body, cache: "no-store" });
}

async function readJsonOrThrow<T>(resp: Response): Promise<T> {
  if (!resp.ok) {
    const text = await resp.text().catch(() => "");
    try {
      const parsed = JSON.parse(text) as { detail?: string };
      throw new Error(parsed.detail || text || `Request failed: ${resp.status}`);
    } catch (error) {
      if (error instanceof SyntaxError) {
        throw new Error(text || `Request failed: ${resp.status}`);
      }
      throw error;
    }
  }
  return (await resp.json()) as T;
}

export async function listHoldings(accountId?: string): Promise<Holding[]> {
  const resp = await signedFetch("GET", "/api/investments/holdings", {
    query: accountId ? { account_id: accountId } : undefined,
  });
  return readJsonOrThrow<Holding[]>(resp);
}

export async function getPortfolio(): Promise<PortfolioSummary> {
  const resp = await signedFetch("GET", "/api/investments/portfolio/summary");
  return readJsonOrThrow<PortfolioSummary>(resp);
}

export type InvestmentAccount = {
  id: string;
  name: string;
  base_currency: string;
  source: "manual" | "ibkr_flex";
};

export async function listInvestmentAccounts(): Promise<InvestmentAccount[]> {
  const portfolio = await getPortfolio();
  return portfolio.accounts.map((a) => ({
    id: a.id,
    name: a.name,
    base_currency: portfolio.currency,
    source: "manual",
  }));
}

export async function getPortfolioHistory(
  from: string,
  to: string,
): Promise<ValuationPoint[]> {
  const resp = await signedFetch("GET", "/api/investments/portfolio/history", {
    query: { from, to },
  });
  return readJsonOrThrow<ValuationPoint[]>(resp);
}

export async function getHoldingHistory(
  holdingId: string,
  from: string,
  to: string,
): Promise<ValuationPoint[]> {
  const resp = await signedFetch(
    "GET",
    `/api/investments/holdings/${holdingId}/history`,
    { query: { from, to } },
  );
  return readJsonOrThrow<ValuationPoint[]>(resp);
}

export type HoldingTrade = {
  id: string;
  trade_date: string;
  symbol: string;
  side: "buy" | "sell";
  quantity: string;
  price: string;
  currency: string;
  fees: string;
  external_id?: string | null;
  economic_type?: string;
  taxable_disposal?: boolean;
  aud_value?: string | null;
  valuation_source?: string | null;
  valuation_timestamp?: string | null;
  valuation_missing?: boolean;
  cost_native?: string | null;
  proceeds_native?: string | null;
  running_quantity: string;
};

export type HoldingLot = {
  open_date: string;
  quantity_remaining: string;
  cost_per_share_native: string;
  original_cost_per_share_native: string;
  cost_base_adjustment_per_share_native: string;
  adjustment_ids: string[];
  acquisition_trade_id?: string | null;
  cost_per_share_user?: string | null;
  age_days: number;
  currency: string;
};

export type CgtAllocation = {
  id: string;
  acquisition_trade_id: string;
  disposal_trade_id: string;
  symbol: string;
  instrument_type: string;
  acquisition_date: string;
  disposal_date: string;
  quantity: string;
  currency: string;
  cost_base_native: string;
  proceeds_native: string;
  gain_native: string;
  cost_base_adjustment_native: string;
  cost_base_aud?: string | null;
  proceeds_aud?: string | null;
  gain_aud?: string | null;
  cost_base_adjustment_aud?: string | null;
  adjustment_ids: string[];
  acquisition_valuation_source?: string | null;
  disposal_valuation_source?: string | null;
  acquisition_valuation_timestamp?: string | null;
  disposal_valuation_timestamp?: string | null;
  acquisition_economic_type: string;
  disposal_economic_type: string;
  fx_missing: boolean;
  discount_eligible: boolean;
  calculation_version: string;
  assumptions: string[];
};

export type CgtFinancialYearSummary = {
  financial_year_start: number;
  gross_gains_aud: string;
  capital_losses_aud: string;
  discounted_gains_aud: string;
  net_capital_gain_before_losses_aud: string;
  allocation_count: number;
  missing_fx_allocation_count: number;
  assumptions: string[];
};

export type AustralianTaxReport = {
  financial_year_start: number;
  financial_year_end: number;
  period: { start: string; end_exclusive: string };
  investment_income: Record<string, unknown>;
  cgt: Record<string, unknown>;
  transactions: Record<string, unknown>;
  crypto_transfers: Record<string, unknown>;
  assumptions: string[];
};

export async function getAustralianTaxReport(financialYearStart: number): Promise<AustralianTaxReport> {
  const resp = await signedFetch("GET", `/api/tax-reports/australian/${financialYearStart}`);
  return readJsonOrThrow<AustralianTaxReport>(resp);
}

export async function getHoldingCgtAllocations(holdingId: string): Promise<CgtAllocation[]> {
  const resp = await signedFetch("GET", `/api/investments/holdings/${holdingId}/cgt-allocations`);
  return readJsonOrThrow<CgtAllocation[]>(resp);
}

export async function getCgtFinancialYearSummary(financialYearStart: number): Promise<CgtFinancialYearSummary> {
  const resp = await signedFetch("GET", "/api/investments/cgt/summary", {
    query: { financial_year_start: String(financialYearStart) },
  });
  return readJsonOrThrow<CgtFinancialYearSummary>(resp);
}

export type InvestmentIncomeEvent = {
  id: string;
  account_id: string;
  holding_id: string;
  event_type: "dividend" | "distribution" | "interest" | "staking_reward" | "airdrop";
  pay_date: string;
  ex_date?: string | null;
  currency: string;
  cash_received: string;
  franked_amount?: string | null;
  unfranked_amount?: string | null;
  franking_credit?: string | null;
  foreign_income?: string | null;
  foreign_tax_paid?: string | null;
  tfn_withholding?: string | null;
  amit_amma_components?: Record<string, string | null> | null;
  is_drp: boolean;
  drp_quantity?: string | null;
  drp_price?: string | null;
  source_id?: string | null;
  notes?: string | null;
  reinvestment_trade_id?: string | null;
  reconciliation_status: "provisional" | "confirmed" | "conflict";
  user_confirmed_at?: string | null;
  matched_transaction_id?: string | null;
  component_sources: Record<string, unknown>;
  annual_statement_reference?: string | null;
  asset_quantity?: string | null;
  aud_market_value?: string | null;
  valuation_source?: string | null;
  valuation_timestamp?: string | null;
  valuation_missing: boolean;
};

export type InvestmentIncomeSummary = {
  financial_year_start: number;
  currency: string;
  cash_income: string;
  franking_credits: string;
  foreign_income: string;
  foreign_tax_paid: string;
  tfn_withholding: string;
};

export type CreateInvestmentIncomeEvent = Omit<
  InvestmentIncomeEvent,
  | "id"
  | "reinvestment_trade_id"
  | "reconciliation_status"
  | "user_confirmed_at"
  | "matched_transaction_id"
  | "component_sources"
  | "annual_statement_reference"
  | "valuation_missing"
>;

export async function listHoldingIncomeEvents(holdingId: string): Promise<InvestmentIncomeEvent[]> {
  const resp = await signedFetch("GET", "/api/investments/income-events", {
    query: { holding_id: holdingId },
  });
  return readJsonOrThrow<InvestmentIncomeEvent[]>(resp);
}

export async function listAccountIncomeEvents(accountId: string): Promise<InvestmentIncomeEvent[]> {
  const resp = await signedFetch("GET", "/api/investments/income-events", {
    query: { account_id: accountId },
  });
  return readJsonOrThrow<InvestmentIncomeEvent[]>(resp);
}

export async function getInvestmentIncomeSummary(
  financialYearStart: number,
  holdingId?: string,
): Promise<InvestmentIncomeSummary[]> {
  const resp = await signedFetch("GET", "/api/investments/income-events/summary", {
    query: {
      financial_year_start: String(financialYearStart),
      holding_id: holdingId,
    },
  });
  return readJsonOrThrow<InvestmentIncomeSummary[]>(resp);
}

export async function createInvestmentIncomeEvent(
  payload: CreateInvestmentIncomeEvent,
): Promise<InvestmentIncomeEvent> {
  await assertNotDemoRestricted();
  const resp = await signedFetch("POST", "/api/investments/income-events", { body: payload });
  return readJsonOrThrow<InvestmentIncomeEvent>(resp);
}

export async function createHoldingIncomeEvent(
  accountId: string,
  holdingId: string,
  payload: Omit<CreateInvestmentIncomeEvent, "account_id" | "holding_id">,
): Promise<InvestmentIncomeEvent> {
  return createInvestmentIncomeEvent({
    ...payload,
    account_id: accountId,
    holding_id: holdingId,
  });
}

export async function getHoldingTrades(
  holdingId: string,
): Promise<HoldingTrade[]> {
  const resp = await signedFetch(
    "GET",
    `/api/investments/holdings/${holdingId}/trades`,
  );
  return readJsonOrThrow<HoldingTrade[]>(resp);
}

export async function getHoldingLots(
  holdingId: string,
): Promise<HoldingLot[]> {
  const resp = await signedFetch(
    "GET",
    `/api/investments/holdings/${holdingId}/lots`,
  );
  return readJsonOrThrow<HoldingLot[]>(resp);
}

export async function searchSymbols(q: string): Promise<SymbolSearchResult[]> {
  const resp = await signedFetch("GET", "/api/investments/symbols/search", {
    query: { q },
  });
  return readJsonOrThrow<SymbolSearchResult[]>(resp);
}

export type BrokerConnection = {
  id: string;
  account_id: string;
  account_name: string;
  provider: "ibkr_flex" | "coinspot" | "binance";
  last_sync_at: string | null;
  last_sync_status: "pending" | "ok" | "partial" | "needs_reauth" | "error" | null;
  last_sync_error: string | null;
  read_only_verified_at: string | null;
  consecutive_failures: number;
  next_retry_at: string | null;
  health_details: {
    balances_reconciled?: boolean;
    pending_records?: number;
    total_absolute_aud_difference?: string;
    history_from?: string;
    history_through?: string;
    differences?: Array<{
      symbol: string;
      activity_quantity: string;
      provider_quantity: string;
      difference: string;
      aud_difference: string;
    }>;
    trade_symbols?: string[];
    configured_trade_symbols?: string[];
    missing_product_warnings?: string[];
    unpriced_assets?: string[];
  };
};

export type BrokerConnectionPayload =
  | {
      provider: "ibkr_flex";
      flex_token: string;
      query_id_positions: string;
      query_id_trades: string;
      account_name: string;
      base_currency: string;
    }
  | {
      provider: "coinspot";
      api_key: string;
      api_secret: string;
      history_start_date?: string;
      account_name: string;
      base_currency: "AUD";
    }
  | {
      provider: "binance";
      api_key: string;
      api_secret: string;
      history_start_date?: string;
      trade_symbols?: string[];
      account_name: string;
      base_currency: "AUD";
    };

export async function createBrokerConnection(
  payload: BrokerConnectionPayload,
): Promise<{ connection_id: string; account_id: string }> {
  await assertNotDemoRestricted();
  const resp = await signedFetch("POST", "/api/investments/broker-connections", {
    body: payload,
  });
  return readJsonOrThrow<{ connection_id: string; account_id: string }>(resp);
}

export async function getBrokerConnections(): Promise<BrokerConnection[]> {
  const resp = await signedFetch("GET", "/api/investments/broker-connections");
  return readJsonOrThrow<BrokerConnection[]>(resp);
}

export async function syncBrokerConnection(connectionId: string): Promise<void> {
  await assertNotDemoRestricted();
  const resp = await signedFetch(
    "POST",
    `/api/investments/broker-connections/${connectionId}/sync`,
  );
  await readJsonOrThrow(resp);
}

export async function updateBrokerApiCredentials(
  connectionId: string,
  payload: { api_key: string; api_secret: string; trade_symbols?: string[] },
): Promise<void> {
  await assertNotDemoRestricted();
  const resp = await signedFetch(
    "PATCH",
    `/api/investments/broker-connections/${connectionId}/credentials`,
    { body: payload },
  );
  await readJsonOrThrow(resp);
}

export async function updateBinanceTradeSymbols(
  connectionId: string,
  tradeSymbols: string[],
): Promise<void> {
  await assertNotDemoRestricted();
  const resp = await signedFetch(
    "PATCH",
    `/api/investments/broker-connections/${connectionId}/configuration`,
    { body: { trade_symbols: tradeSymbols } },
  );
  await readJsonOrThrow(resp);
}

export async function disconnectBrokerConnection(connectionId: string): Promise<void> {
  await assertNotDemoRestricted();
  const resp = await signedFetch(
    "DELETE",
    `/api/investments/broker-connections/${connectionId}`,
  );
  if (!resp.ok) {
    const message = await resp.text().catch(() => "");
    throw new Error(message || `Request failed: ${resp.status}`);
  }
}

export async function createManualAccount(
  name: string,
  base_currency: string,
): Promise<{ account_id: string }> {
  await assertNotDemoRestricted();
  const resp = await signedFetch("POST", "/api/investments/manual-accounts", {
    body: { name, base_currency },
  });
  return readJsonOrThrow<{ account_id: string }>(resp);
}

export async function addManualHolding(
  accountId: string,
  payload: {
    symbol: string;
    quantity: string;
    instrument_type: "equity" | "etf" | "cash";
    currency: string;
    as_of_date?: string;
    avg_cost?: string;
  },
): Promise<{ holding_id: string }> {
  await assertNotDemoRestricted();
  const resp = await signedFetch(
    "POST",
    `/api/investments/manual-accounts/${accountId}/holdings`,
    { body: payload },
  );
  return readJsonOrThrow<{ holding_id: string }>(resp);
}

export async function deleteHolding(holdingId: string): Promise<void> {
  const session = await getAuthenticatedSession();
  if (!session?.user?.id) throw new Error("Not authenticated");
  if (isDemoRestrictedUserEmail(session.user.email)) {
    throw new Error(DEMO_RESTRICTED_ACTION_ERROR);
  }
  await signedFetch("DELETE", `/api/investments/holdings/${holdingId}`);
}

export async function syncAllInvestments(): Promise<{ count: number }> {
  await assertNotDemoRestricted();
  const resp = await signedFetch("POST", "/api/investments/sync-all");
  return readJsonOrThrow<{ count: number }>(resp);
}

export async function updateHolding(
  holdingId: string,
  payload: {
    symbol?: string;
    quantity?: string;
    avg_cost?: string | null;
    as_of_date?: string | null;
    provider_symbol?: string | null;
  },
): Promise<void> {
  const session = await getAuthenticatedSession();
  if (!session?.user?.id) throw new Error("Not authenticated");
  if (isDemoRestrictedUserEmail(session.user.email)) {
    throw new Error(DEMO_RESTRICTED_ACTION_ERROR);
  }
  const resp = await signedFetch("PATCH", `/api/investments/holdings/${holdingId}`, {
    body: payload,
  });
  if (!resp.ok) {
    const text = await resp.text().catch(() => "");
    throw new Error(text || `Request failed: ${resp.status}`);
  }
}

export type InvestmentImportMapping = {
  occurred_at: string | null;
  activity_type: string | null;
  asset_symbol: string | null;
  asset_name: string | null;
  asset_type: string | null;
  quantity: string | null;
  price: string | null;
  gross_amount: string | null;
  net_amount: string | null;
  currency: string | null;
  fee_amount: string | null;
  fee_currency: string | null;
  fee_aud_value: string | null;
  fee_valuation_source: string | null;
  fee_valuation_timestamp: string | null;
  tax_amount: string | null;
  tax_currency: string | null;
  source_reference: string | null;
  counter_asset_symbol: string | null;
  counter_quantity: string | null;
  direction: string | null;
  external_group_id: string | null;
  transaction_hash: string | null;
  aud_value: string | null;
  valuation_source: string | null;
  valuation_timestamp: string | null;
  description: string | null;
  ex_date: string | null;
  franked_amount: string | null;
  unfranked_amount: string | null;
  franking_credit: string | null;
  foreign_income: string | null;
  foreign_tax_paid: string | null;
  tfn_withholding: string | null;
  amit_amma_components: string | null;
  cost_base_increase: string | null;
  cost_base_decrease: string | null;
  cost_base_effective_date: string | null;
  annual_statement_reference: string | null;
  amma_interest: string | null;
  amma_capital_gains_discounted: string | null;
  amma_capital_gains_other: string | null;
  amma_capital_gains_discount: string | null;
  amma_tax_deferred: string | null;
  amma_tax_free: string | null;
  amma_other_non_assessable: string | null;
};

export type InvestmentImportRequest = {
  account_id: string;
  provider: string;
  file_name: string;
  file_content: string;
  mapping: InvestmentImportMapping;
  date_format: "AUTO" | "DD-MM-YYYY" | "MM-DD-YYYY";
  amount_format: "AUTO" | "DOT_DECIMAL" | "COMMA_DECIMAL";
  default_asset_type: "equity" | "fund" | "crypto" | "cash" | "option" | "bond" | "other";
  default_currency?: string | null;
  default_activity_type?: string | null;
  activity_type_aliases?: Record<string, string>;
  income_data_kind?: "cash_activity" | "annual_statement";
};

export type InvestmentImportPreviewRow = {
  row_number: number;
  status: "ready" | "duplicate" | "conflict";
  duplicate_reason?: string;
  conflict_reason?: string;
  asset_status: "existing" | "new";
  normalized: Record<string, string | string[] | null>;
  warnings: string[];
  raw: Record<string, string>;
};

export type InvestmentImportPreview = {
  provider: string;
  file_name: string;
  source_hash: string;
  headers: string[];
  resolved_amount_format: string;
  rows: InvestmentImportPreviewRow[];
  rejected_rows: Array<{
    row_number: number;
    reasons: string[];
    raw: Record<string, string>;
  }>;
  unmatched_assets: string[];
  summary: {
    total_rows: number;
    ready_rows: number;
    duplicate_rows: number;
    rejected_rows: number;
    conflict_rows: number;
    warning_rows: number;
  };
};

export type InvestmentImportRun = {
  id: string;
  account_id: string;
  provider: string;
  status: "applying" | "completed" | "partial" | "failed" | "reverted";
  source_name: string | null;
  summary: Record<string, number | string | string[]>;
  warnings: string[];
  error: string | null;
  started_at: string;
  completed_at: string | null;
  reverted_at: string | null;
};

export type InvestmentCryptoTransfer = {
  id: string;
  account_id: string;
  source_activity_id: string;
  matched_transfer_id: string | null;
  direction: "in" | "out" | "internal";
  asset_symbol: string;
  quantity: string;
  occurred_at: string;
  transaction_hash: string | null;
  status: "pending" | "matched" | "ambiguous" | "internal";
  match_method: "transaction_hash" | "quantity_time_window" | null;
  reason: string | null;
  assumptions: string[];
};

export type InvestmentImportProfile = {
  id: string;
  account_id: string;
  provider: string;
  profile_variant: "cash_activity" | "annual_statement" | "default";
  name: string;
  mapping: {
    columns: InvestmentImportMapping;
    date_format?: InvestmentImportRequest["date_format"];
    amount_format?: InvestmentImportRequest["amount_format"];
    default_asset_type?: InvestmentImportRequest["default_asset_type"];
    default_currency?: string | null;
    default_activity_type?: string | null;
    activity_type_aliases?: Record<string, string>;
    income_data_kind?: InvestmentImportRequest["income_data_kind"];
  };
  header_signature: string[];
  last_used_at: string | null;
};

export async function previewInvestmentImport(
  payload: InvestmentImportRequest,
): Promise<InvestmentImportPreview> {
  await assertNotDemoRestricted();
  const resp = await signedFetch("POST", "/api/investments/imports/preview", { body: payload });
  return readJsonOrThrow<InvestmentImportPreview>(resp);
}

export async function applyInvestmentImport(
  payload: InvestmentImportRequest & {
    selected_row_numbers?: number[];
    save_mapping?: boolean;
    mapping_name?: string;
  },
): Promise<{ run_id: string; inserted_records: number; skipped_duplicate_records: number; inserted_activities: number }> {
  await assertNotDemoRestricted();
  const resp = await signedFetch("POST", "/api/investments/imports", { body: payload });
  return readJsonOrThrow(resp);
}

export async function listInvestmentImports(accountId: string): Promise<InvestmentImportRun[]> {
  const resp = await signedFetch("GET", "/api/investments/imports", {
    query: { account_id: accountId },
  });
  return readJsonOrThrow(resp);
}

export async function listInvestmentCryptoTransfers(
  accountId?: string,
  status: InvestmentCryptoTransfer["status"] | "all" = "all",
): Promise<InvestmentCryptoTransfer[]> {
  const resp = await signedFetch("GET", "/api/investments/crypto-transfers", {
    query: { account_id: accountId, status },
  });
  return readJsonOrThrow(resp);
}

export async function listInvestmentImportProfiles(
  accountId: string,
  provider?: string,
  incomeDataKind?: "cash_activity" | "annual_statement",
): Promise<InvestmentImportProfile[]> {
  const resp = await signedFetch("GET", "/api/investments/import-profiles", {
    query: { account_id: accountId, provider, income_data_kind: incomeDataKind },
  });
  return readJsonOrThrow(resp);
}

export async function revertInvestmentImport(runId: string): Promise<{
  run_id: string;
  status: "reverted";
  removed_trades: number;
  removed_income_events: number;
  removed_income_enrichments?: number;
  removed_cost_base_adjustments?: number;
  removed_reconciliation_items?: number;
}> {
  await assertNotDemoRestricted();
  const resp = await signedFetch("POST", `/api/investments/imports/${runId}/revert`);
  return readJsonOrThrow(resp);
}

export type InvestmentReconciliationItem = {
  id: string;
  account_id: string;
  source_activity_id: string;
  income_event_id: string | null;
  kind: "cash_match" | "annual_statement" | "component_conflict";
  status: "pending" | "resolved" | "ignored";
  reason: string;
  candidate_income_event_ids: string[];
  candidate_transaction_ids: string[];
  details: Record<string, unknown>;
  resolution: Record<string, unknown> | null;
  resolved_at: string | null;
  created_at: string;
};

export async function listInvestmentReconciliationItems(
  accountId: string,
  status: "pending" | "resolved" | "ignored" | "all" = "pending",
): Promise<InvestmentReconciliationItem[]> {
  const resp = await signedFetch("GET", "/api/investments/reconciliation-items", {
    query: { account_id: accountId, status },
  });
  return readJsonOrThrow(resp);
}

export async function resolveInvestmentReconciliationItem(
  itemId: string,
  payload: {
    action: "ignore" | "link_transaction" | "link_income_event" | "keep_existing" | "apply_statement";
    income_event_id?: string;
    transaction_id?: string;
  },
): Promise<InvestmentReconciliationItem> {
  await assertNotDemoRestricted();
  const resp = await signedFetch("POST", `/api/investments/reconciliation-items/${itemId}/resolve`, { body: payload });
  return readJsonOrThrow(resp);
}
