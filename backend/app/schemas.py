import re
from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator
from datetime import datetime
from datetime import time as _time_type
from decimal import Decimal
from typing import Any, Optional, List
from uuid import UUID
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError


LIABILITY_REPAYMENT_FREQUENCIES = {
    "weekly",
    "fortnightly",
    "monthly",
    "quarterly",
    "annually",
}


class LiabilityAccountDetailsMixin(BaseModel):
    liability_interest_rate: Optional[Decimal] = None
    liability_repayment_amount: Optional[Decimal] = None
    liability_repayment_frequency: Optional[str] = None
    liability_loan_term_months: Optional[int] = None
    liability_secured: Optional[bool] = None

    @field_validator("liability_interest_rate", "liability_repayment_amount")
    @classmethod
    def _non_negative_decimal(cls, value: Optional[Decimal]) -> Optional[Decimal]:
        if value is not None and value < 0:
            raise ValueError("must be non-negative")
        return value

    @field_validator("liability_loan_term_months")
    @classmethod
    def _positive_term_months(cls, value: Optional[int]) -> Optional[int]:
        if value is not None and value <= 0:
            raise ValueError("must be greater than zero")
        return value

    @field_validator("liability_repayment_frequency")
    @classmethod
    def _known_repayment_frequency(cls, value: Optional[str]) -> Optional[str]:
        if value is None:
            return value
        normalized = value.lower()
        if normalized not in LIABILITY_REPAYMENT_FREQUENCIES:
            raise ValueError("unknown repayment frequency")
        return normalized


# Account Schemas
class AccountBase(LiabilityAccountDetailsMixin):
    name: str
    account_type: str
    institution: Optional[str] = None
    currency: str = "EUR"


class AccountCreate(AccountBase):
    pass


class AccountUpdate(LiabilityAccountDetailsMixin):
    name: Optional[str] = None
    account_type: Optional[str] = None
    institution: Optional[str] = None
    balance_current: Optional[Decimal] = None
    is_active: Optional[bool] = None
    alias_patterns: list[str] = Field(default_factory=list)


class AccountResponse(AccountBase):
    id: UUID
    is_active: bool
    alias_patterns: list[str] = Field(default_factory=list)
    provider: Optional[str] = None
    external_id: Optional[str] = None
    created_at: datetime
    updated_at: datetime

    model_config = ConfigDict(from_attributes=True)


# Category Schemas
class CategoryBase(BaseModel):
    name: str
    parent_id: Optional[UUID] = None
    category_type: str = "expense"
    color: Optional[str] = None
    icon: Optional[str] = None


class CategoryCreate(CategoryBase):
    pass


class CategoryUpdate(BaseModel):
    name: Optional[str] = None
    parent_id: Optional[UUID] = None
    color: Optional[str] = None
    icon: Optional[str] = None


class CategoryResponse(CategoryBase):
    id: UUID
    is_system: bool
    created_at: datetime

    model_config = ConfigDict(from_attributes=True)


# Transaction Schemas
class TransactionBase(BaseModel):
    account_id: UUID
    transaction_type: str  # debit, credit
    amount: Decimal
    currency: str = "EUR"
    description: str
    merchant: Optional[str] = None
    booked_at: datetime


class TransactionCreate(TransactionBase):
    category_id: Optional[UUID] = None
    category_system_id: Optional[UUID] = None
    categorization_instructions: Optional[str] = None


class TransactionUpdate(BaseModel):
    description: Optional[str] = None
    merchant: Optional[str] = None
    category_id: Optional[UUID] = None
    category_system_id: Optional[UUID] = None
    categorization_instructions: Optional[str] = None
    enrichment_data: Optional[dict] = None


class CategoryAssign(BaseModel):
    category_id: UUID


class TransactionResponse(TransactionBase):
    id: UUID
    external_id: Optional[str] = None
    category_id: Optional[UUID] = None
    category_system_id: Optional[UUID] = None
    pending: bool
    categorization_instructions: Optional[str] = None
    enrichment_data: Optional[dict] = None
    created_at: datetime
    updated_at: datetime

    model_config = ConfigDict(from_attributes=True)


class TransactionWithDetails(TransactionResponse):
    category_name: Optional[str] = None
    account_name: str


# Analytics Schemas
class CategorySpending(BaseModel):
    category_id: Optional[UUID]
    category_name: Optional[str]
    total: Decimal
    count: int


class AccountSummary(BaseModel):
    id: UUID
    name: str
    account_type: str
    balance: Decimal


# Transaction Input/Output Schemas
class TransactionInput(BaseModel):
    """Input transaction for categorization."""
    description: Optional[str] = None
    merchant: Optional[str] = None
    amount: Decimal
    transaction_type: Optional[str] = None  # "debit" or "credit" - helps determine if expense or income


class TransactionResult(BaseModel):
    """Result of categorization for a single transaction."""
    description: Optional[str]
    merchant: Optional[str]
    amount: Decimal
    category_name: Optional[str] = None
    category_id: Optional[UUID] = None
    method: str  # 'override', 'deterministic', 'llm', or 'none'
    confidence_score: Optional[float] = None
    matched_keywords: Optional[List[str]] = None
    tokens_used: Optional[int] = None
    cost_usd: Optional[float] = None


class UserOverride(BaseModel):
    """User override for a specific transaction pattern."""
    description: Optional[str] = None
    merchant: Optional[str] = None
    amount: Optional[Decimal] = None
    category_name: str  # Required: the category to use for matching transactions


class BatchCategorizationRequest(BaseModel):
    """Request for batch categorization."""
    transactions: List[TransactionInput]
    use_llm: bool = True
    user_overrides: Optional[List[UserOverride]] = None  # User-defined category overrides
    additional_instructions: Optional[List[str]] = None  # User guidance for categorization


class BatchCategorizationResponse(BaseModel):
    """Response for batch categorization."""
    results: List[TransactionResult]
    total_transactions: int
    categorized_count: int
    deterministic_count: int
    llm_count: int
    uncategorized_count: int
    total_tokens_used: int
    total_cost_usd: float
    llm_errors: Optional[List[str]] = None  # List of LLM error messages
    llm_warnings: Optional[List[str]] = None  # List of LLM warning messages


# Production categorization schemas
class CategorizeTransactionRequest(BaseModel):
    """Request to categorize a single transaction."""
    description: Optional[str] = None
    merchant: Optional[str] = None
    amount: Decimal
    transaction_type: Optional[str] = None  # 'debit' or 'credit'
    use_llm: bool = True
    user_overrides: Optional[List[UserOverride]] = None  # User-defined category overrides
    additional_instructions: Optional[List[str]] = None  # User guidance for categorization


class CategorizeTransactionResponse(BaseModel):
    """Response for single transaction categorization."""
    category_id: Optional[UUID] = None
    category_name: Optional[str] = None
    method: str  # 'override', 'deterministic', 'llm', or 'none'
    confidence_score: Optional[float] = None
    matched_keywords: Optional[List[str]] = None
    tokens_used: Optional[int] = None
    cost_usd: Optional[float] = None


class BatchCategorizeRequest(BaseModel):
    """Request to categorize multiple transactions."""
    transactions: List[TransactionInput]
    use_llm: bool = True
    user_overrides: Optional[List[UserOverride]] = None  # User-defined category overrides (applies to all transactions)
    additional_instructions: Optional[List[str]] = None  # User guidance for categorization (applies to all transactions)


class BatchCategorizeResponse(BaseModel):
    """Response for batch transaction categorization."""
    results: List[TransactionResult]
    total_transactions: int
    categorized_count: int
    deterministic_count: int
    llm_count: int
    uncategorized_count: int
    total_tokens_used: int
    total_cost_usd: float
    llm_errors: Optional[List[str]] = None
    llm_warnings: Optional[List[str]] = None


# Daily Balance Import Schemas
class DailyBalanceImport(BaseModel):
    """Daily balance data extracted from CSV for import."""
    date: str  # ISO date format YYYY-MM-DD
    balance: Decimal


# Investment Schemas
from datetime import date as _date_date
from typing import Literal


class BrokerConnectionCreate(BaseModel):
    provider: Literal["ibkr_flex", "coinspot", "binance"]
    flex_token: Optional[str] = None
    query_id_positions: Optional[str] = None
    query_id_trades: Optional[str] = None
    api_key: Optional[str] = None
    api_secret: Optional[str] = None
    history_start_date: Optional[_date_date] = None
    trade_symbols: list[str] = Field(default_factory=list)
    account_name: str
    base_currency: str = "EUR"

    @field_validator(
        "flex_token", "query_id_positions", "query_id_trades", "api_key", "api_secret",
        "account_name", "base_currency",
    )
    @classmethod
    def _trim_connection_values(cls, value: Optional[str]) -> Optional[str]:
        return value.strip() if value is not None else None

    @model_validator(mode="after")
    def _validate_provider_credentials(self):
        required = (
            ("flex_token", "query_id_positions", "query_id_trades")
            if self.provider == "ibkr_flex"
            else ("api_key", "api_secret")
        )
        missing = [name for name in required if not getattr(self, name)]
        if missing:
            raise ValueError(
                f"{self.provider} requires {', '.join(name.replace('_', ' ') for name in missing)}"
            )
        if not self.account_name:
            raise ValueError("account name is required")
        if self.provider in {"coinspot", "binance"} and self.base_currency.upper() != "AUD":
            raise ValueError(f"{self.provider.title()} accounts must use AUD as their base currency")
        normalized_symbols: list[str] = []
        for value in self.trade_symbols:
            symbol = value.strip().upper()
            if not symbol or len(symbol) > 32 or not symbol.isalnum():
                raise ValueError("Binance Spot pairs must contain only letters and numbers")
            if symbol not in normalized_symbols:
                normalized_symbols.append(symbol)
        self.trade_symbols = normalized_symbols
        self.base_currency = self.base_currency.upper()
        return self


class BrokerConnectionResponse(BaseModel):
    id: UUID
    account_id: UUID
    provider: str
    last_sync_at: Optional[datetime]
    last_sync_status: Optional[str]
    last_sync_error: Optional[str]
    read_only_verified_at: Optional[datetime]
    consecutive_failures: int = 0
    next_retry_at: Optional[datetime]
    health_details: dict[str, Any] = Field(default_factory=dict)


class CoinSpotCredentialsUpdate(BaseModel):
    api_key: str
    api_secret: str
    trade_symbols: Optional[list[str]] = None

    @field_validator("api_key", "api_secret")
    @classmethod
    def _non_empty_credential(cls, value: str) -> str:
        value = value.strip()
        if not value:
            raise ValueError("credential is required")
        return value

    @field_validator("trade_symbols")
    @classmethod
    def _normalize_trade_symbols(cls, values: Optional[list[str]]) -> Optional[list[str]]:
        if values is None:
            return None
        result: list[str] = []
        for value in values:
            symbol = value.strip().upper()
            if not symbol or len(symbol) > 32 or not symbol.isalnum():
                raise ValueError("Binance Spot pairs must contain only letters and numbers")
            if symbol not in result:
                result.append(symbol)
        return result


class BinanceTradeSymbolsUpdate(BaseModel):
    trade_symbols: list[str]

    @field_validator("trade_symbols")
    @classmethod
    def _normalize_trade_symbols(cls, values: list[str]) -> list[str]:
        result: list[str] = []
        for value in values:
            symbol = value.strip().upper()
            if not symbol or len(symbol) > 32 or not symbol.isalnum():
                raise ValueError("Binance Spot pairs must contain only letters and numbers")
            if symbol not in result:
                result.append(symbol)
        return result


class ManualAccountCreate(BaseModel):
    name: str
    base_currency: str = "EUR"


class HoldingCreate(BaseModel):
    symbol: str
    provider_symbol: Optional[str] = None
    quantity: Decimal
    instrument_type: Literal["equity", "etf", "cash"]
    currency: str
    as_of_date: Optional[_date_date] = None
    avg_cost: Optional[Decimal] = None


class HoldingUpdate(BaseModel):
    symbol: Optional[str] = None
    quantity: Optional[Decimal] = None
    as_of_date: Optional[_date_date] = None
    avg_cost: Optional[Decimal] = None
    provider_symbol: Optional[str] = None


class HoldingResponse(BaseModel):
    id: UUID
    account_id: UUID
    symbol: str
    provider_symbol: Optional[str] = None
    name: Optional[str]
    currency: str
    instrument_type: str
    quantity: Decimal
    avg_cost: Optional[Decimal]
    as_of_date: Optional[_date_date]
    source: str
    current_price: Optional[Decimal] = None
    current_value_user_currency: Optional[Decimal] = None
    cost_basis_user_currency: Optional[Decimal] = None
    is_stale: bool = False


class PortfolioSummary(BaseModel):
    total_value: Decimal
    total_value_today_change: Decimal
    currency: str
    accounts: list[dict]
    allocation_by_type: dict[str, Decimal]
    allocation_by_currency: dict[str, Decimal]


class ValuationPoint(BaseModel):
    date: _date_date
    value: Decimal


class HoldingTrade(BaseModel):
    """One BrokerTrade row enriched with running quantity / cost."""
    id: UUID
    trade_date: _date_date
    symbol: str
    side: str
    quantity: Decimal
    price: Decimal
    currency: str
    fees: Decimal
    external_id: Optional[str] = None
    economic_type: str = "trade"
    taxable_disposal: bool = True
    aud_value: Optional[Decimal] = None
    valuation_source: Optional[str] = None
    valuation_timestamp: Optional[datetime] = None
    valuation_missing: bool = False
    cost_native: Optional[Decimal] = None
    proceeds_native: Optional[Decimal] = None
    running_quantity: Decimal


class HoldingLot(BaseModel):
    """One open FIFO lot for a holding."""
    open_date: _date_date
    quantity_remaining: Decimal
    cost_per_share_native: Decimal
    original_cost_per_share_native: Decimal = Decimal("0")
    cost_base_adjustment_per_share_native: Decimal = Decimal("0")
    adjustment_ids: list[str] = Field(default_factory=list)
    cost_per_share_user: Optional[Decimal] = None
    age_days: int
    currency: str
    acquisition_trade_id: Optional[UUID] = None


class CgtAllocationResponse(BaseModel):
    id: UUID
    acquisition_trade_id: UUID
    disposal_trade_id: UUID
    symbol: str
    instrument_type: str
    acquisition_date: _date_date
    disposal_date: _date_date
    quantity: Decimal
    currency: str
    cost_base_native: Decimal
    proceeds_native: Decimal
    gain_native: Decimal
    cost_base_adjustment_native: Decimal
    cost_base_aud: Optional[Decimal] = None
    proceeds_aud: Optional[Decimal] = None
    gain_aud: Optional[Decimal] = None
    cost_base_adjustment_aud: Optional[Decimal] = None
    adjustment_ids: list[str]
    acquisition_valuation_source: Optional[str] = None
    disposal_valuation_source: Optional[str] = None
    acquisition_valuation_timestamp: Optional[datetime] = None
    disposal_valuation_timestamp: Optional[datetime] = None
    acquisition_economic_type: str = "trade"
    disposal_economic_type: str = "trade"
    fx_missing: bool
    discount_eligible: bool
    calculation_version: str
    assumptions: list[str]

    model_config = ConfigDict(from_attributes=True)


class CgtFinancialYearSummary(BaseModel):
    financial_year_start: int
    gross_gains_aud: Decimal
    capital_losses_aud: Decimal
    discounted_gains_aud: Decimal
    net_capital_gain_before_losses_aud: Decimal
    allocation_count: int
    missing_fx_allocation_count: int
    assumptions: list[str]


class AustralianTaxReportResponse(BaseModel):
    """Auditable, informational Australian FY reporting pack."""
    financial_year_start: int
    financial_year_end: int
    period: dict[str, str]
    investment_income: dict[str, Any]
    cgt: dict[str, Any]
    transactions: dict[str, Any]
    crypto_transfers: dict[str, Any] = Field(default_factory=dict)
    assumptions: list[str]


class InvestmentIncomeEventCreate(BaseModel):
    account_id: UUID
    holding_id: UUID
    event_type: str
    pay_date: _date_date
    ex_date: Optional[_date_date] = None
    currency: str
    cash_received: Decimal
    franked_amount: Optional[Decimal] = None
    unfranked_amount: Optional[Decimal] = None
    franking_credit: Optional[Decimal] = None
    foreign_income: Optional[Decimal] = None
    foreign_tax_paid: Optional[Decimal] = None
    tfn_withholding: Optional[Decimal] = None
    amit_amma_components: Optional[dict] = None
    is_drp: bool = False
    drp_quantity: Optional[Decimal] = None
    drp_price: Optional[Decimal] = None
    source_id: Optional[str] = None
    notes: Optional[str] = None
    asset_quantity: Optional[Decimal] = None
    aud_market_value: Optional[Decimal] = None
    valuation_source: Optional[str] = None
    valuation_timestamp: Optional[datetime] = None
    valuation_missing: bool = False

    @field_validator("event_type")
    @classmethod
    def _income_event_type(cls, value: str) -> str:
        value = value.lower().strip()
        if value not in {"dividend", "distribution", "interest", "staking_reward", "airdrop"}:
            raise ValueError("must be dividend, distribution, interest, staking_reward, or airdrop")
        return value

    @field_validator("currency")
    @classmethod
    def _income_currency(cls, value: str) -> str:
        value = value.upper().strip()
        if len(value) != 3:
            raise ValueError("must be a 3-letter ISO code")
        return value

    @field_validator(
        "cash_received", "franked_amount", "unfranked_amount", "franking_credit",
        "foreign_income", "foreign_tax_paid", "tfn_withholding", "asset_quantity",
        "aud_market_value",
    )
    @classmethod
    def _income_amounts(cls, value: Optional[Decimal]) -> Optional[Decimal]:
        if value is not None and value < 0:
            raise ValueError("must be non-negative")
        return value

    @model_validator(mode="after")
    def _drp_fields(self):
        if self.is_drp and (self.drp_quantity is None or self.drp_quantity <= 0 or self.drp_price is None or self.drp_price < 0):
            raise ValueError("DRP events require a positive quantity and non-negative price")
        if not self.is_drp and (self.drp_quantity is not None or self.drp_price is not None):
            raise ValueError("DRP quantity and price are only valid for DRP events")
        if self.event_type in {"staking_reward", "airdrop"} and (
            self.asset_quantity is None or self.asset_quantity <= 0
        ):
            raise ValueError("staking and airdrop events require a positive asset quantity")
        if self.aud_market_value is not None and (
            not self.valuation_source or self.valuation_timestamp is None
        ):
            raise ValueError("AUD market values require valuation source and timestamp")
        if self.valuation_missing and self.aud_market_value is not None:
            raise ValueError("a missing valuation cannot also have an AUD market value")
        return self


class InvestmentIncomeEventResponse(InvestmentIncomeEventCreate):
    id: UUID
    user_id: str
    reinvestment_trade_id: Optional[UUID] = None
    reconciliation_status: str
    user_confirmed_at: Optional[datetime] = None
    matched_transaction_id: Optional[UUID] = None
    component_sources: dict[str, Any] = Field(default_factory=dict)
    annual_statement_reference: Optional[str] = None
    created_at: datetime
    updated_at: datetime

    model_config = ConfigDict(from_attributes=True)


class InvestmentIncomeSummary(BaseModel):
    financial_year_start: int
    currency: str
    cash_income: Decimal
    franking_credits: Decimal
    foreign_income: Decimal
    foreign_tax_paid: Decimal
    tfn_withholding: Decimal


class InvestmentReconciliationResolve(BaseModel):
    action: str
    income_event_id: Optional[UUID] = None
    transaction_id: Optional[UUID] = None


class SymbolSearchResult(BaseModel):
    symbol: str
    name: str
    exchange: Optional[str] = None
    currency: Optional[str] = None


# Report Schemas
ReportFrequency = Literal["DAILY", "WEEKLY", "BIWEEKLY", "MONTHLY"]
ReportTransactionMode = Literal["RECENT", "TOP_N"]
ReportTransactionDirection = Literal["ALL", "EXPENSE", "INCOME", "INFLOW", "OUTFLOW"]

_EMAIL_RE = re.compile(r"^[^@\s]+@[^@\s]+\.[^@\s]+$")
_SEND_TIME_RE = re.compile(r"^([01]\d|2[0-3]):([0-5]\d)(:([0-5]\d))?$")


def _validate_timezone(v: Optional[str]) -> Optional[str]:
    if v is None:
        return v
    try:
        ZoneInfo(v)
    except ZoneInfoNotFoundError:
        raise ValueError(f"Unknown timezone: {v}")
    return v


def _validate_recipient_emails(v: Optional[list[str]]) -> Optional[list[str]]:
    if v is None:
        return v
    if len(v) < 1:
        raise ValueError("recipient_emails must contain at least one email address")
    for email in v:
        if not _EMAIL_RE.match(email):
            raise ValueError(f"Invalid email address: {email}")
    return v


def _validate_send_time(v: Optional[str]) -> Optional[str]:
    if v is None:
        return v
    if not _SEND_TIME_RE.match(v):
        raise ValueError(f"Invalid send_time format (expected HH:MM or HH:MM:SS): {v}")
    return v


class ReportBase(BaseModel):
    name: str
    account_ids: list[str] = Field(default_factory=list)
    transaction_mode: ReportTransactionMode = "RECENT"  # RECENT, TOP_N
    transaction_count: int = Field(default=10, ge=1, le=100)
    transaction_direction: ReportTransactionDirection = "ALL"  # ALL, EXPENSE, INCOME, INFLOW, OUTFLOW
    frequency: ReportFrequency  # DAILY, WEEKLY, BIWEEKLY, MONTHLY
    send_time: str = "08:00:00"  # HH:MM:SS
    send_day_of_week: Optional[int] = Field(default=None, ge=0, le=6)
    send_day_of_month: Optional[int] = Field(default=None, ge=1, le=28)
    timezone: str = "UTC"
    recipient_emails: list[str]
    is_active: bool = True

    _check_timezone = field_validator("timezone")(_validate_timezone)
    # NOTE: send_time and recipient_emails are intentionally NOT validated
    # here — ReportResponse also inherits ReportBase, and pydantic v2 field
    # validators are inherited by subclasses even when the field type is
    # overridden (send_time) or the value comes from the ORM (recipient_emails
    # legacy rows could in principle be []), which would break response
    # serialization / reads with a 500 instead of just rejecting bad writes.
    # Validated on ReportCreate/ReportUpdate individually instead, so reads
    # are never blocked by a write-side validation rule. recipient_emails
    # also has no default here so that omitting it on create is itself a
    # 422 "field required" instead of silently defaulting to [] and only
    # failing later (previously: default_factory=list bypassed pydantic v2's
    # skip-validation-on-default behavior, letting an empty list reach the
    # DB unvalidated on create).


class ReportCreate(ReportBase):
    _check_send_time = field_validator("send_time")(_validate_send_time)
    _check_recipient_emails = field_validator("recipient_emails")(_validate_recipient_emails)

    @model_validator(mode="after")
    def _validate_required_day_fields(self) -> "ReportCreate":
        if self.frequency in ("WEEKLY", "BIWEEKLY") and self.send_day_of_week is None:
            raise ValueError("send_day_of_week is required when frequency is WEEKLY or BIWEEKLY")
        if self.frequency == "MONTHLY" and self.send_day_of_month is None:
            raise ValueError("send_day_of_month is required when frequency is MONTHLY")
        return self


class ReportUpdate(BaseModel):
    name: Optional[str] = None
    account_ids: Optional[list[str]] = None
    transaction_mode: Optional[ReportTransactionMode] = None
    transaction_count: Optional[int] = Field(default=None, ge=1, le=100)
    transaction_direction: Optional[ReportTransactionDirection] = None
    frequency: Optional[ReportFrequency] = None
    send_time: Optional[str] = None
    send_day_of_week: Optional[int] = Field(default=None, ge=0, le=6)
    send_day_of_month: Optional[int] = Field(default=None, ge=1, le=28)
    timezone: Optional[str] = None
    recipient_emails: Optional[list[str]] = None
    is_active: Optional[bool] = None
    # Note: no cross-field "day field required" validator here — a PATCH may
    # legitimately update only one field (e.g. recipient_emails) without
    # touching frequency/day fields. The route handler's _recompute_next_run
    # falls back to the already-persisted value for whichever field isn't in
    # this payload, so ReportCreate (which always has full context) is the
    # right place for that check.

    _check_timezone = field_validator("timezone")(_validate_timezone)
    _check_recipient_emails = field_validator("recipient_emails")(_validate_recipient_emails)
    _check_send_time = field_validator("send_time")(_validate_send_time)


class ReportResponse(ReportBase):
    id: UUID
    send_time: _time_type
    next_run_at: Optional[datetime] = None
    created_at: datetime
    updated_at: datetime

    model_config = ConfigDict(from_attributes=True)


class ReportRunResponse(BaseModel):
    id: UUID
    scheduled_for: Optional[datetime] = None
    is_test: bool
    started_at: Optional[datetime] = None
    finished_at: Optional[datetime] = None
    status: str
    error_message: Optional[str] = None
    recipient_emails: list[str] = Field(default_factory=list)
    created_at: datetime

    model_config = ConfigDict(from_attributes=True)
