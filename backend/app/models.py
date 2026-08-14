"""
SQLAlchemy models matching the Drizzle schema.ts structure.
These models mirror the frontend Drizzle schema for consistency.
"""
import uuid
from datetime import datetime, time
from sqlalchemy import (
    Column,
    String,
    Boolean,
    Date,
    DateTime,
    Time,
    Numeric,
    Text,
    Integer,
    ForeignKey,
    Index,
    UniqueConstraint,
    CheckConstraint,
    JSON,
    text,
)
from sqlalchemy.dialects.postgresql import UUID, JSONB
from sqlalchemy.orm import relationship
from decimal import Decimal

from app.database import Base


class Account(Base):
    """
    Account model matching Drizzle schema.
    Note: Includes userId for multi-tenancy support.
    """
    __tablename__ = "accounts"

    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    user_id = Column(String, ForeignKey("users.id", ondelete="CASCADE"), nullable=False, index=True)
    name = Column(String(255), nullable=False)
    account_type = Column(String(50), nullable=False)  # checking, savings, credit
    institution = Column(String(255))
    logo_id = Column(UUID(as_uuid=True), ForeignKey("company_logos.id", ondelete="SET NULL"), nullable=True)
    currency = Column(String(3), default="EUR")
    provider = Column(String(50), nullable=True)  # gocardless, manual
    external_id = Column(String(255), nullable=True)  # Provider's account ID
    external_id_ciphertext = Column(Text, nullable=True)
    external_id_hash = Column(String(64), nullable=True, index=True)
    iban_ciphertext = Column(Text, nullable=True)
    iban_hash = Column(String(64), nullable=True, index=False)  # composite index defined in __table_args__
    bank_connection_id = Column(UUID(as_uuid=True), ForeignKey("bank_connections.id", ondelete="SET NULL"), nullable=True)
    balance_available = Column(Numeric(15, 2), nullable=True)
    starting_balance = Column(Numeric(15, 2), default=Decimal("0"))  # Starting balance for calculation
    functional_balance = Column(Numeric(15, 2), nullable=True)  # Calculated balance (sum of transactions + starting_balance)
    balance_is_anchored = Column(Boolean, default=False)  # True when starting_balance is from verified bank data
    liability_interest_rate = Column(Numeric(7, 4), nullable=True)
    liability_repayment_amount = Column(Numeric(15, 2), nullable=True)
    liability_repayment_frequency = Column(String(20), nullable=True)
    liability_loan_term_months = Column(Integer, nullable=True)
    liability_secured = Column(Boolean, nullable=True)
    is_active = Column(Boolean, default=True)
    alias_patterns = Column(JSONB, nullable=False, server_default=text("'[]'::jsonb"))
    last_synced_at = Column(DateTime, nullable=True)
    created_at = Column(DateTime, default=datetime.utcnow)
    updated_at = Column(DateTime, default=datetime.utcnow, onupdate=datetime.utcnow)

    # Relationships
    user = relationship("User", back_populates="accounts")
    logo = relationship("CompanyLogo", back_populates="accounts")
    bank_connection = relationship("BankConnection", back_populates="accounts")
    transactions = relationship(
        "Transaction",
        back_populates="account",
        cascade="all, delete-orphan",
        passive_deletes=True,
    )
    csv_imports = relationship("CsvImport", back_populates="account")
    csv_import_profiles = relationship("CsvImportProfile", back_populates="account", cascade="all, delete-orphan")
    balances = relationship("AccountBalance", back_populates="account")
    recurring_transactions = relationship("RecurringTransaction", back_populates="account")
    property_liability_links = relationship("PropertyLiabilityLink", back_populates="account")
    subscription_suggestions = relationship("SubscriptionSuggestion", back_populates="account")
    planned_expenses = relationship("PlannedExpense", back_populates="account")
    cashflow_overrides = relationship("CashflowOverride", back_populates="account")
    super_account = relationship("SuperAccount", back_populates="account", uselist=False, cascade="all, delete-orphan")

    # Indexes and constraints
    __table_args__ = (
        Index("idx_accounts_user", "user_id"),
        UniqueConstraint("user_id", "provider", "external_id", name="accounts_user_provider_external_id"),
        Index(
            "accounts_user_provider_external_id_hash_uq",
            "user_id",
            "provider",
            "external_id_hash",
            unique=True,
            postgresql_where=text("external_id_hash IS NOT NULL"),
        ),
        Index("idx_accounts_bank_connection", "bank_connection_id"),
        Index("idx_accounts_user_iban_hash", "user_id", "iban_hash"),
    )


class BankConnection(Base):
    """
    Bank connection model for Enable Banking sessions.
    Tracks consent lifecycle and sync state.
    """
    __tablename__ = "bank_connections"

    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    user_id = Column(String, ForeignKey("users.id", ondelete="CASCADE"), nullable=False, index=True)
    provider = Column(String(50), nullable=False, default="enable_banking")
    session_id = Column(String(255), nullable=False)
    aspsp_name = Column(String(255), nullable=False)
    aspsp_country = Column(String(2), nullable=False)
    consent_expires_at = Column(DateTime, nullable=True)
    consent_notified_at = Column(DateTime, nullable=True)
    status = Column(String(20), nullable=False, default="active")
    last_synced_at = Column(DateTime, nullable=True)
    sync_started_at = Column(DateTime, nullable=True)
    last_sync_error = Column(Text, nullable=True)
    sync_cursor = Column(JSONB, nullable=True)
    initial_sync_days = Column(Integer, nullable=False, server_default="90")
    raw_session_data = Column(JSONB, nullable=True)
    created_at = Column(DateTime, default=datetime.utcnow)
    updated_at = Column(DateTime, default=datetime.utcnow, onupdate=datetime.utcnow)

    # Relationships
    user = relationship("User", back_populates="bank_connections")
    accounts = relationship("Account", back_populates="bank_connection")

    __table_args__ = (
        Index("idx_bank_connections_user", "user_id"),
        Index("idx_bank_connections_status", "status"),
        Index("idx_bank_connections_consent_expires", "consent_expires_at"),
        UniqueConstraint("user_id", "session_id", name="bank_connections_user_session"),
    )


class Category(Base):
    """
    Category model matching Drizzle schema.
    Note: Includes userId for multi-tenancy support.
    """
    __tablename__ = "categories"

    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    user_id = Column(String, ForeignKey("users.id", ondelete="CASCADE"), nullable=False, index=True)
    name = Column(String(255), nullable=False)
    parent_id = Column(UUID(as_uuid=True), ForeignKey("categories.id"), nullable=True)
    category_type = Column(String(20), default="expense")  # expense, income, transfer
    color = Column(String(7))  # Hex color
    icon = Column(String(50))  # Remix icon name
    description = Column(Text, nullable=True)  # Category description
    categorization_instructions = Column(Text, nullable=True)  # User instructions for AI categorization
    is_system = Column(Boolean, default=False)
    hide_from_selection = Column(Boolean, default=False)
    created_at = Column(DateTime, default=datetime.utcnow)

    # Relationships
    user = relationship("User", back_populates="categories")
    parent = relationship("Category", remote_side=[id], backref="children")
    transactions = relationship("Transaction", back_populates="category", foreign_keys="Transaction.category_id")
    system_transactions = relationship("Transaction", back_populates="category_system", foreign_keys="Transaction.category_system_id")
    categorization_rules = relationship("CategorizationRule", back_populates="category")
    subscription_suggestions = relationship("SubscriptionSuggestion", back_populates="suggested_category")
    budget_limits = relationship("BudgetLimit", back_populates="category")
    planned_expenses = relationship("PlannedExpense", back_populates="category")
    cashflow_overrides = relationship("CashflowOverride", back_populates="category")

    # Indexes and constraints
    __table_args__ = (
        Index("idx_categories_user", "user_id"),
        UniqueConstraint("user_id", "name", "parent_id", name="categories_user_name_parent"),
    )


class BudgetLimit(Base):
    """Monthly planned spend for a category."""
    __tablename__ = "budget_limits"

    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    user_id = Column(String, ForeignKey("users.id", ondelete="CASCADE"), nullable=False, index=True)
    category_id = Column(UUID(as_uuid=True), ForeignKey("categories.id", ondelete="CASCADE"), nullable=False, index=True)
    month = Column(Date, nullable=False)
    planned_amount = Column(Numeric(15, 2), nullable=False, default=Decimal("0"))
    notes = Column(Text, nullable=True)
    created_at = Column(DateTime, default=datetime.utcnow)
    updated_at = Column(DateTime, default=datetime.utcnow, onupdate=datetime.utcnow)

    user = relationship("User")
    category = relationship("Category", back_populates="budget_limits")

    __table_args__ = (
        Index("idx_budget_limits_user_month", "user_id", "month"),
        Index("idx_budget_limits_category", "category_id"),
        UniqueConstraint("user_id", "month", "category_id", name="budget_limits_user_month_category"),
    )


class PlannedExpense(Base):
    """Expected irregular expense with recurrence and optional sinking-fund target."""
    __tablename__ = "planned_expenses"

    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    user_id = Column(String, ForeignKey("users.id", ondelete="CASCADE"), nullable=False, index=True)
    name = Column(String(255), nullable=False)
    amount = Column(Numeric(15, 2), nullable=False)
    currency = Column(String(3), nullable=False, default="EUR")
    category_id = Column(UUID(as_uuid=True), ForeignKey("categories.id", ondelete="RESTRICT"), nullable=False, index=True)
    account_id = Column(UUID(as_uuid=True), ForeignKey("accounts.id", ondelete="CASCADE"), nullable=False, index=True)
    due_date = Column(Date, nullable=False)
    recurrence_type = Column(String(20), nullable=False)
    custom_interval_months = Column(Integer, nullable=True)
    sinking_fund_target_amount = Column(Numeric(15, 2), nullable=False)
    sinking_fund_start_date = Column(Date, nullable=False, server_default=text("CURRENT_DATE"))
    notes = Column(Text, nullable=True)
    is_active = Column(Boolean, nullable=False, default=True)
    created_at = Column(DateTime, default=datetime.utcnow)
    updated_at = Column(DateTime, default=datetime.utcnow, onupdate=datetime.utcnow)

    user = relationship("User", back_populates="planned_expenses")
    category = relationship("Category", back_populates="planned_expenses")
    account = relationship("Account", back_populates="planned_expenses")
    linked_transactions = relationship(
        "PlannedExpenseTransactionLink",
        back_populates="planned_expense",
        cascade="all, delete-orphan",
        passive_deletes=True,
    )

    __table_args__ = (
        Index("idx_planned_expenses_user_active_due", "user_id", "is_active", "due_date"),
        Index("idx_planned_expenses_category", "category_id"),
        Index("idx_planned_expenses_account", "account_id"),
        CheckConstraint("amount > 0", name="planned_expenses_amount_positive"),
        CheckConstraint("sinking_fund_target_amount > 0", name="planned_expenses_sinking_target_positive"),
        CheckConstraint(
            "recurrence_type in ('one_off', 'monthly', 'quarterly', 'annual', 'custom')",
            name="planned_expenses_recurrence_type_check",
        ),
        CheckConstraint(
            "recurrence_type <> 'custom' or custom_interval_months between 1 and 120",
            name="planned_expenses_custom_interval_check",
        ),
    )


class PlannedExpenseTransactionLink(Base):
    """Transaction linked as payment for a planned irregular expense occurrence."""
    __tablename__ = "planned_expense_transaction_links"

    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    user_id = Column(String, ForeignKey("users.id", ondelete="CASCADE"), nullable=False, index=True)
    planned_expense_id = Column(UUID(as_uuid=True), ForeignKey("planned_expenses.id", ondelete="CASCADE"), nullable=False, index=True)
    transaction_id = Column(UUID(as_uuid=True), ForeignKey("transactions.id", ondelete="CASCADE"), nullable=False, index=True)
    occurrence_due_date = Column(Date, nullable=False)
    amount_applied = Column(Numeric(15, 2), nullable=False)
    created_at = Column(DateTime, default=datetime.utcnow)

    user = relationship("User", back_populates="planned_expense_transaction_links")
    planned_expense = relationship("PlannedExpense", back_populates="linked_transactions")
    transaction = relationship("Transaction", back_populates="planned_expense_links")

    __table_args__ = (
        Index("idx_planned_expense_links_user", "user_id"),
        Index("idx_planned_expense_links_expense_occurrence", "planned_expense_id", "occurrence_due_date"),
        Index("idx_planned_expense_links_transaction", "transaction_id"),
        UniqueConstraint("planned_expense_id", "transaction_id", "occurrence_due_date", name="planned_expense_link_occurrence_unique"),
        UniqueConstraint("transaction_id", name="planned_expense_link_transaction_unique"),
        CheckConstraint("amount_applied > 0", name="planned_expense_links_amount_positive"),
    )


class CashflowOverride(Base):
    """Manual expected cashflow entry used by the forecast."""
    __tablename__ = "cashflow_overrides"

    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    user_id = Column(String, ForeignKey("users.id", ondelete="CASCADE"), nullable=False, index=True)
    account_id = Column(UUID(as_uuid=True), ForeignKey("accounts.id", ondelete="CASCADE"), nullable=False, index=True)
    category_id = Column(UUID(as_uuid=True), ForeignKey("categories.id", ondelete="SET NULL"), nullable=True, index=True)
    expected_date = Column(Date, nullable=False)
    direction = Column(String(20), nullable=False)
    amount = Column(Numeric(15, 2), nullable=False)
    description = Column(String(255), nullable=False)
    notes = Column(Text, nullable=True)
    is_active = Column(Boolean, nullable=False, default=True)
    created_at = Column(DateTime, default=datetime.utcnow)
    updated_at = Column(DateTime, default=datetime.utcnow, onupdate=datetime.utcnow)

    user = relationship("User", back_populates="cashflow_overrides")
    account = relationship("Account", back_populates="cashflow_overrides")
    category = relationship("Category", back_populates="cashflow_overrides")

    __table_args__ = (
        Index("idx_cashflow_overrides_user_date", "user_id", "expected_date"),
        Index("idx_cashflow_overrides_account", "account_id"),
        Index("idx_cashflow_overrides_category", "category_id"),
        CheckConstraint(
            "direction in ('income', 'expense', 'transfer_in', 'transfer_out')",
            name="cashflow_overrides_direction_check",
        ),
        CheckConstraint("amount > 0", name="cashflow_overrides_amount_positive"),
    )


class RecurringTransactionScheduleOverride(Base):
    """User-controlled anchor and direction for forecasting a recurring item."""
    __tablename__ = "recurring_transaction_schedule_overrides"

    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    user_id = Column(String, ForeignKey("users.id", ondelete="CASCADE"), nullable=False, index=True)
    recurring_transaction_id = Column(UUID(as_uuid=True), ForeignKey("recurring_transactions.id", ondelete="CASCADE"), nullable=False)
    anchor_date = Column(Date, nullable=False)
    direction = Column(String(10), nullable=False)
    created_at = Column(DateTime, default=datetime.utcnow)
    updated_at = Column(DateTime, default=datetime.utcnow, onupdate=datetime.utcnow)

    user = relationship("User", back_populates="recurring_transaction_schedule_overrides")
    recurring_transaction = relationship("RecurringTransaction", back_populates="schedule_override")

    __table_args__ = (
        Index("idx_recurring_schedule_overrides_user", "user_id"),
        UniqueConstraint("recurring_transaction_id", name="recurring_schedule_overrides_recurring_unique"),
        CheckConstraint(
            "direction in ('inflow', 'outflow')",
            name="recurring_schedule_overrides_direction_check",
        ),
    )


class Transaction(Base):
    """
    Transaction model matching Drizzle schema.
    Note: Includes userId for multi-tenancy support and separate category fields.
    """
    __tablename__ = "transactions"

    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    user_id = Column(String, ForeignKey("users.id", ondelete="CASCADE"), nullable=False, index=True)
    account_id = Column(UUID(as_uuid=True), ForeignKey("accounts.id", ondelete="CASCADE"), nullable=False, index=True)
    external_id = Column(String(255), nullable=True)
    transaction_type = Column(String(20))  # debit, credit
    amount = Column(Numeric(15, 2), nullable=False)
    currency = Column(String(3), default="EUR")
    functional_amount = Column(Numeric(15, 2), nullable=True)  # Amount converted to user's functional currency
    description = Column(Text)
    merchant = Column(String(255))
    creditor = Column(String(255), nullable=True)   # Counterparty name for debits (payee)
    debtor = Column(String(255), nullable=True)     # Counterparty name for credits (payer)
    counterparty_iban_ciphertext = Column(Text, nullable=True)
    counterparty_iban_hash = Column(String(64), nullable=True)
    internal_transfer_id = Column(
        UUID(as_uuid=True),
        ForeignKey("internal_transfers.id", ondelete="SET NULL"),
        nullable=True,
    )
    category_id = Column(UUID(as_uuid=True), ForeignKey("categories.id"), nullable=True, index=True)  # User-overridden category
    category_system_id = Column(UUID(as_uuid=True), ForeignKey("categories.id"), nullable=True, index=True)  # AI-assigned category
    property_id = Column(UUID(as_uuid=True), ForeignKey("properties.id", ondelete="SET NULL"), nullable=True, index=True)
    booked_at = Column(DateTime, nullable=False, index=True)
    pending = Column(Boolean, default=False)
    categorization_instructions = Column(Text)  # User instructions for AI categorization
    enrichment_data = Column(JSONB)  # Enriched merchant info, logos, etc.
    recurring_transaction_id = Column(UUID(as_uuid=True), ForeignKey("recurring_transactions.id", ondelete="SET NULL"), nullable=True, index=True)  # Link to recurring transaction label
    include_in_analytics = Column(Boolean, default=True, nullable=False)  # Whether to include in analytics (charts, KPIs, etc.)
    csv_import_id = Column(UUID(as_uuid=True), ForeignKey("csv_imports.id", ondelete="SET NULL"), nullable=True, index=True)  # Source CSV import (null for manual/bank-synced)
    created_at = Column(DateTime, default=datetime.utcnow)
    updated_at = Column(DateTime, default=datetime.utcnow, onupdate=datetime.utcnow)

    # Relationships
    user = relationship("User", back_populates="transactions")
    account = relationship("Account", back_populates="transactions")
    category = relationship("Category", foreign_keys=[category_id], back_populates="transactions")
    category_system = relationship("Category", foreign_keys=[category_system_id], back_populates="system_transactions")
    property = relationship("Property", back_populates="transactions")
    recurring_transaction = relationship("RecurringTransaction", back_populates="linked_transactions")
    transaction_link = relationship("TransactionLink", back_populates="transaction", uselist=False)
    planned_expense_links = relationship("PlannedExpenseTransactionLink", back_populates="transaction")
    csv_import = relationship("CsvImport", back_populates="transactions")

    # Indexes and constraints
    __table_args__ = (
        Index("idx_transactions_user", "user_id"),
        Index("idx_transactions_account", "account_id"),
        Index("idx_transactions_booked_at", "booked_at"),
        Index("idx_transactions_category", "category_id"),
        Index("idx_transactions_category_system", "category_system_id"),
        Index("idx_transactions_recurring", "recurring_transaction_id"),
        Index("idx_transactions_csv_import", "csv_import_id"),
        UniqueConstraint("account_id", "external_id", name="transactions_account_external_id"),
        Index("idx_transactions_user_counterparty_iban", "user_id", "counterparty_iban_hash"),
    )


class Report(Base):
    """Newsletter report configuration."""
    __tablename__ = "reports"

    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    user_id = Column(String, ForeignKey("users.id", ondelete="CASCADE"), nullable=False)
    name = Column(String(255), nullable=False)
    account_ids = Column(JSONB, nullable=False, server_default=text("'[]'::jsonb"))
    transaction_mode = Column(String(20), nullable=False, default="RECENT")
    transaction_count = Column(Integer, nullable=False, default=10)
    transaction_direction = Column(String(20), nullable=False, default="ALL")
    frequency = Column(String(20), nullable=False)
    send_time = Column(Time, nullable=False, default=time(8, 0))
    send_day_of_week = Column(Integer, nullable=True)
    send_day_of_month = Column(Integer, nullable=True)
    timezone = Column(String(64), nullable=False, default="UTC")
    recipient_emails = Column(JSONB, nullable=False, server_default=text("'[]'::jsonb"))
    is_active = Column(Boolean, default=True, nullable=False)
    next_run_at = Column(DateTime, nullable=True)
    created_at = Column(DateTime, default=datetime.utcnow)
    updated_at = Column(DateTime, default=datetime.utcnow, onupdate=datetime.utcnow)

    user = relationship("User")
    runs = relationship("ReportRun", back_populates="report", cascade="all, delete-orphan")

    __table_args__ = (
        Index("idx_reports_user", "user_id"),
        Index("idx_reports_next_run_at", "next_run_at"),
    )


class ReportRun(Base):
    """Single scheduled or ad-hoc execution of a Report."""
    __tablename__ = "report_runs"

    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    report_id = Column(UUID(as_uuid=True), ForeignKey("reports.id", ondelete="CASCADE"), nullable=False)
    scheduled_for = Column(DateTime, nullable=True)
    is_test = Column(Boolean, default=False, nullable=False)
    started_at = Column(DateTime, nullable=True)
    finished_at = Column(DateTime, nullable=True)
    status = Column(String(20), nullable=False, default="SCHEDULED")
    error_message = Column(Text, nullable=True)
    recipient_emails = Column(JSONB, nullable=False, server_default=text("'[]'::jsonb"))
    created_at = Column(DateTime, default=datetime.utcnow)

    report = relationship("Report", back_populates="runs")

    __table_args__ = (
        Index("idx_report_runs_report", "report_id"),
        Index("idx_report_runs_status", "status"),
    )


class InternalTransfer(Base):
    """
    Internal transfer model matching Drizzle schema.
    Links a source transaction on a synced account to a mirror transaction
    on a manually-registered pocket account, matched by counterparty IBAN.
    """
    __tablename__ = "internal_transfers"

    id = Column(UUID(as_uuid=True), primary_key=True, server_default=text("gen_random_uuid()"))
    user_id = Column(String, ForeignKey("users.id", ondelete="CASCADE"), nullable=False)
    source_txn_id = Column(
        UUID(as_uuid=True),
        ForeignKey("transactions.id", ondelete="CASCADE"),
        nullable=False,
        unique=True,
    )
    mirror_txn_id = Column(
        UUID(as_uuid=True),
        ForeignKey("transactions.id", ondelete="SET NULL"),
        nullable=True,
        unique=True,
    )
    source_account_id = Column(
        UUID(as_uuid=True),
        ForeignKey("accounts.id", ondelete="CASCADE"),
        nullable=False,
    )
    pocket_account_id = Column(
        UUID(as_uuid=True),
        ForeignKey("accounts.id", ondelete="CASCADE"),
        nullable=False,
    )
    amount = Column(Numeric(15, 2), nullable=False)
    currency = Column(String(3), nullable=False)
    detected_at = Column(DateTime, server_default=text("now()"))
    created_at = Column(DateTime, server_default=text("now()"))

    __table_args__ = (
        Index("idx_internal_transfers_user", "user_id"),
        Index("idx_internal_transfers_pocket", "pocket_account_id"),
    )


class RecurringTransaction(Base):
    """
    Recurring Transaction model matching Drizzle schema.
    Stores recurring transaction labels (subscriptions, bills, etc.) for automatic linking.
    """
    __tablename__ = "recurring_transactions"

    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    user_id = Column(String, ForeignKey("users.id", ondelete="CASCADE"), nullable=False, index=True)
    account_id = Column(UUID(as_uuid=True), ForeignKey("accounts.id", ondelete="SET NULL"), nullable=True, index=True)
    name = Column(String(255), nullable=False)
    merchant = Column(String(255), nullable=True)
    amount = Column(Numeric(15, 2), nullable=False)
    currency = Column(String(3), default="EUR")
    category_id = Column(UUID(as_uuid=True), ForeignKey("categories.id"), nullable=True, index=True)
    logo_id = Column(UUID(as_uuid=True), ForeignKey("company_logos.id", ondelete="SET NULL"), nullable=True)
    importance = Column(Integer, nullable=False, default=3)  # 1-5 scale
    frequency = Column(String(20), nullable=False)  # monthly, weekly, yearly, quarterly, biweekly
    is_active = Column(Boolean, default=True)
    description = Column(Text, nullable=True)
    created_at = Column(DateTime, default=datetime.utcnow)
    updated_at = Column(DateTime, default=datetime.utcnow, onupdate=datetime.utcnow)

    # Relationships
    user = relationship("User", back_populates="recurring_transactions")
    account = relationship("Account", back_populates="recurring_transactions")
    category = relationship("Category")
    logo = relationship("CompanyLogo", back_populates="recurring_transactions")
    linked_transactions = relationship("Transaction", back_populates="recurring_transaction")
    schedule_override = relationship(
        "RecurringTransactionScheduleOverride",
        back_populates="recurring_transaction",
        uselist=False,
        cascade="all, delete-orphan",
    )

    # Indexes and constraints
    __table_args__ = (
        Index("idx_recurring_transactions_user", "user_id"),
        Index("idx_recurring_transactions_account", "account_id"),
        Index("idx_recurring_transactions_category", "category_id"),
        Index("idx_recurring_transactions_active", "is_active"),
    )


class CategorizationRule(Base):
    """
    Categorization rules model matching Drizzle schema.
    Stores user-provided instructions for AI categorization.
    """
    __tablename__ = "categorization_rules"

    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    user_id = Column(String, ForeignKey("users.id", ondelete="CASCADE"), nullable=False)
    category_id = Column(UUID(as_uuid=True), ForeignKey("categories.id", ondelete="CASCADE"), nullable=False)
    instructions = Column(Text)  # User-provided instructions for AI categorization
    is_active = Column(Boolean, default=True)
    created_at = Column(DateTime, default=datetime.utcnow)

    # Relationships
    user = relationship("User", back_populates="categorization_rules")
    category = relationship("Category", back_populates="categorization_rules")



class CsvImport(Base):
    """
    CSV Import model matching Drizzle schema.
    Stores CSV import job information.
    """
    __tablename__ = "csv_imports"

    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    user_id = Column(String, ForeignKey("users.id", ondelete="CASCADE"), nullable=False, index=True)
    account_id = Column(UUID(as_uuid=True), ForeignKey("accounts.id", ondelete="CASCADE"), nullable=False, index=True)
    import_profile_id = Column(UUID(as_uuid=True), ForeignKey("csv_import_profiles.id", ondelete="SET NULL"), nullable=True, index=True)
    file_name = Column(String(255), nullable=False)
    file_path = Column(Text, nullable=True)
    file_path_ciphertext = Column(Text, nullable=True)
    status = Column(String(20), default="pending")  # pending, mapping, previewing, importing, completed, failed
    column_mapping = Column(JSONB, nullable=True)
    total_rows = Column(Integer, nullable=True)
    imported_rows = Column(Integer, nullable=True)
    duplicates_found = Column(Integer, nullable=True)
    rows_needing_attention = Column(Integer, default=0, server_default=text("0"), nullable=True)
    error_message = Column(Text, nullable=True)
    # Background worker fields
    celery_task_id = Column(String(255), nullable=True)
    progress_count = Column(Integer, default=0)
    selected_indices = Column(JSONB, nullable=True)  # Array of row indices selected for import
    created_at = Column(DateTime, default=datetime.utcnow)
    completed_at = Column(DateTime, nullable=True)

    # Relationships
    user = relationship("User", back_populates="csv_imports")
    account = relationship("Account", back_populates="csv_imports")
    import_profile = relationship("CsvImportProfile", back_populates="csv_imports")
    transactions = relationship("Transaction", back_populates="csv_import")

    # Indexes and constraints
    __table_args__ = (
        Index("idx_csv_imports_user", "user_id"),
        Index("idx_csv_imports_account", "account_id"),
        Index("idx_csv_imports_import_profile", "import_profile_id"),
    )


class CsvImportProfile(Base):
    """
    Saved CSV column mapping for an account.
    At most one profile is stored per user/account pair.
    """
    __tablename__ = "csv_import_profiles"

    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    user_id = Column(String, ForeignKey("users.id", ondelete="CASCADE"), nullable=False, index=True)
    account_id = Column(UUID(as_uuid=True), ForeignKey("accounts.id", ondelete="CASCADE"), nullable=False, index=True)
    name = Column(String(255), nullable=False, default="Default CSV mapping", server_default=text("'Default CSV mapping'"))
    column_mapping = Column(JSONB, nullable=False)
    header_signature = Column(JSONB, nullable=True)
    last_used_at = Column(DateTime, nullable=True)
    created_at = Column(DateTime, default=datetime.utcnow)
    updated_at = Column(DateTime, default=datetime.utcnow, onupdate=datetime.utcnow)

    user = relationship("User", back_populates="csv_import_profiles")
    account = relationship("Account", back_populates="csv_import_profiles")
    csv_imports = relationship("CsvImport", back_populates="import_profile")

    __table_args__ = (
        Index("idx_csv_import_profiles_user", "user_id"),
        Index("idx_csv_import_profiles_account", "account_id"),
        UniqueConstraint("user_id", "account_id", name="csv_import_profiles_user_account_unique"),
    )


class ExchangeRate(Base):
    """
    Exchange rate model for currency conversion.
    Stores daily exchange rates between base currencies and target currencies (EUR, USD).
    """
    __tablename__ = "exchange_rates"

    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    date = Column(DateTime, nullable=False, index=True)  # Date of the exchange rate
    base_currency = Column(String(3), nullable=False, index=True)  # Source currency (transaction currency)
    target_currency = Column(String(3), nullable=False, index=True)  # Target currency (EUR or USD)
    rate = Column(Numeric(18, 8), nullable=False)  # Exchange rate (how many target currency = 1 base currency)
    created_at = Column(DateTime, default=datetime.utcnow)
    updated_at = Column(DateTime, default=datetime.utcnow, onupdate=datetime.utcnow)

    # Indexes and constraints
    __table_args__ = (
        Index("idx_exchange_rates_date", "date"),
        Index("idx_exchange_rates_base", "base_currency"),
        Index("idx_exchange_rates_target", "target_currency"),
        UniqueConstraint("date", "base_currency", "target_currency", name="exchange_rates_date_base_target"),
    )


class AccountBalance(Base):
    """
    Account balance model for daily balance snapshots.
    Stores daily balance for each account in both account currency and functional currency.
    """
    __tablename__ = "account_balances"

    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    account_id = Column(UUID(as_uuid=True), ForeignKey("accounts.id", ondelete="CASCADE"), nullable=False, index=True)
    date = Column(DateTime, nullable=False, index=True)  # Date of the balance snapshot
    balance_in_account_currency = Column(Numeric(15, 2), nullable=False)  # Balance in account's currency
    balance_in_functional_currency = Column(Numeric(15, 2), nullable=False)  # Balance converted to functional currency
    created_at = Column(DateTime, default=datetime.utcnow)
    updated_at = Column(DateTime, default=datetime.utcnow, onupdate=datetime.utcnow)

    # Relationships
    account = relationship("Account", back_populates="balances")

    # Indexes and constraints
    __table_args__ = (
        Index("idx_account_balances_account", "account_id"),
        Index("idx_account_balances_date", "date"),
        UniqueConstraint("account_id", "date", name="account_balances_account_date"),
    )


class SuperAccount(Base):
    """First-class superannuation metadata for a manual super account."""
    __tablename__ = "super_accounts"

    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    account_id = Column(UUID(as_uuid=True), ForeignKey("accounts.id", ondelete="CASCADE"), nullable=False, unique=True)
    user_id = Column(String, ForeignKey("users.id", ondelete="CASCADE"), nullable=False, index=True)
    fund_name = Column(String(255), nullable=False)
    investment_option = Column(String(255), nullable=True)
    include_in_net_worth = Column(Boolean, nullable=False, default=True)
    created_at = Column(DateTime, default=datetime.utcnow)
    updated_at = Column(DateTime, default=datetime.utcnow, onupdate=datetime.utcnow)

    account = relationship("Account", back_populates="super_account")
    user = relationship("User", back_populates="super_accounts")
    contributions = relationship("SuperContribution", back_populates="super_account", cascade="all, delete-orphan")

    __table_args__ = (Index("idx_super_accounts_user", "user_id"),)


class SuperContribution(Base):
    """Immutable fund-statement or manual contribution event, never a cash transaction."""
    __tablename__ = "super_contributions"

    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    user_id = Column(String, ForeignKey("users.id", ondelete="CASCADE"), nullable=False, index=True)
    super_account_id = Column(UUID(as_uuid=True), ForeignKey("super_accounts.id", ondelete="CASCADE"), nullable=False, index=True)
    date = Column(Date, nullable=False)
    amount = Column(Numeric(15, 2), nullable=False)
    currency = Column(String(3), nullable=False, default="AUD")
    kind = Column(String(40), nullable=False)
    notes = Column(Text, nullable=True)
    source_import_id = Column(UUID(as_uuid=True), ForeignKey("csv_imports.id", ondelete="SET NULL"), nullable=True)
    source_row_hash = Column(String(64), nullable=True)
    created_at = Column(DateTime, default=datetime.utcnow)

    super_account = relationship("SuperAccount", back_populates="contributions")
    user = relationship("User", back_populates="super_contributions")

    __table_args__ = (
        Index("idx_super_contributions_user_date", "user_id", "date"),
        Index("idx_super_contributions_account_date", "super_account_id", "date"),
        Index("super_contributions_import_row_unique", "source_import_id", "source_row_hash", unique=True, postgresql_where=text("source_import_id IS NOT NULL AND source_row_hash IS NOT NULL")),
        CheckConstraint("amount > 0", name="super_contributions_amount_positive"),
        CheckConstraint("kind in ('employer_sg', 'salary_sacrifice', 'personal_concessional', 'personal_non_concessional', 'fee', 'insurance')", name="super_contributions_kind_check"),
    )


class SuperContributionCap(Base):
    """User-configured contribution caps for one Australian financial year."""
    __tablename__ = "super_contribution_caps"

    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    user_id = Column(String, ForeignKey("users.id", ondelete="CASCADE"), nullable=False, index=True)
    financial_year_start = Column(Integer, nullable=False)
    concessional_cap = Column(Numeric(15, 2), nullable=True)
    non_concessional_cap = Column(Numeric(15, 2), nullable=True)
    created_at = Column(DateTime, default=datetime.utcnow)
    updated_at = Column(DateTime, default=datetime.utcnow, onupdate=datetime.utcnow)

    user = relationship("User", back_populates="super_contribution_caps")

    __table_args__ = (
        UniqueConstraint("user_id", "financial_year_start", name="super_contribution_caps_user_fy_unique"),
        CheckConstraint("financial_year_start BETWEEN 1900 AND 9998", name="super_contribution_caps_fy_check"),
        CheckConstraint("concessional_cap IS NULL OR concessional_cap >= 0", name="super_contribution_caps_concessional_positive"),
        CheckConstraint("non_concessional_cap IS NULL OR non_concessional_cap >= 0", name="super_contribution_caps_non_concessional_positive"),
    )


class Property(Base):
    """
    Property model matching Drizzle schema.
    Stores real estate properties owned by users.
    """
    __tablename__ = "properties"

    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    user_id = Column(String, ForeignKey("users.id", ondelete="CASCADE"), nullable=False, index=True)
    name = Column(String(255), nullable=False)
    property_type = Column(String(50), nullable=False)  # residential, commercial, land, other
    address = Column(Text, nullable=True)
    current_value = Column(Numeric(15, 2), default=Decimal("0"))
    currency = Column(String(3), default="EUR")
    is_rental = Column(Boolean, default=False, nullable=False)
    valuation_date = Column(Date, nullable=True)
    valuation_source = Column(String(100), nullable=True)
    notes = Column(Text, nullable=True)
    is_active = Column(Boolean, default=True)
    created_at = Column(DateTime, default=datetime.utcnow)
    updated_at = Column(DateTime, default=datetime.utcnow, onupdate=datetime.utcnow)

    # Relationships
    user = relationship("User", back_populates="properties")
    linked_liabilities = relationship("PropertyLiabilityLink", back_populates="property")
    valuations = relationship("PropertyValuation", back_populates="property")
    transactions = relationship("Transaction", back_populates="property")

    # Indexes and constraints
    __table_args__ = (
        Index("idx_properties_user", "user_id"),
    )


class PropertyLiabilityLink(Base):
    """Link a property to liability accounts secured against it."""
    __tablename__ = "property_liability_links"

    property_id = Column(UUID(as_uuid=True), ForeignKey("properties.id", ondelete="CASCADE"), primary_key=True)
    account_id = Column(UUID(as_uuid=True), ForeignKey("accounts.id", ondelete="CASCADE"), primary_key=True)
    user_id = Column(String, ForeignKey("users.id", ondelete="CASCADE"), nullable=False)
    created_at = Column(DateTime, default=datetime.utcnow, nullable=False)

    user = relationship("User", back_populates="property_liability_links")
    property = relationship("Property", back_populates="linked_liabilities")
    account = relationship("Account", back_populates="property_liability_links")

    __table_args__ = (
        Index("idx_property_liability_links_user", "user_id"),
        Index("idx_property_liability_links_account", "account_id"),
    )


class PropertyValuation(Base):
    """Historical valuation snapshots for a property."""
    __tablename__ = "property_valuations"

    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    property_id = Column(UUID(as_uuid=True), ForeignKey("properties.id", ondelete="CASCADE"), nullable=False)
    user_id = Column(String, ForeignKey("users.id", ondelete="CASCADE"), nullable=False)
    valuation_date = Column(Date, nullable=False)
    value = Column(Numeric(15, 2), nullable=False)
    currency = Column(String(3), default="EUR", nullable=False)
    source = Column(String(100), nullable=True)
    notes = Column(Text, nullable=True)
    created_at = Column(DateTime, default=datetime.utcnow, nullable=False)

    user = relationship("User", back_populates="property_valuations")
    property = relationship("Property", back_populates="valuations")

    __table_args__ = (
        Index("idx_property_valuations_property_date", "property_id", "valuation_date"),
        Index("idx_property_valuations_user", "user_id"),
    )


class Vehicle(Base):
    """
    Vehicle model matching Drizzle schema.
    Stores vehicles owned by users.
    """
    __tablename__ = "vehicles"

    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    user_id = Column(String, ForeignKey("users.id", ondelete="CASCADE"), nullable=False, index=True)
    name = Column(String(255), nullable=False)
    vehicle_type = Column(String(50), nullable=False)  # car, motorcycle, boat, rv, other
    make = Column(String(100), nullable=True)
    model = Column(String(100), nullable=True)
    year = Column(Integer, nullable=True)
    current_value = Column(Numeric(15, 2), default=Decimal("0"))
    currency = Column(String(3), default="EUR")
    is_active = Column(Boolean, default=True)
    created_at = Column(DateTime, default=datetime.utcnow)
    updated_at = Column(DateTime, default=datetime.utcnow, onupdate=datetime.utcnow)

    # Relationships
    user = relationship("User", back_populates="vehicles")

    # Indexes and constraints
    __table_args__ = (
        Index("idx_vehicles_user", "user_id"),
    )


class SubscriptionSuggestion(Base):
    """
    Subscription suggestion model matching Drizzle schema.
    Stores detected subscription patterns for user review.
    """
    __tablename__ = "subscription_suggestions"

    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    user_id = Column(String, ForeignKey("users.id", ondelete="CASCADE"), nullable=False, index=True)

    # Suggestion details
    suggested_name = Column(String(255), nullable=False)
    suggested_merchant = Column(String(255), nullable=True)
    suggested_amount = Column(Numeric(15, 2), nullable=False)
    currency = Column(String(3), default="EUR", nullable=False)
    detected_frequency = Column(String(20), nullable=False)  # weekly, biweekly, monthly, quarterly, yearly
    confidence = Column(Integer, nullable=False)  # 0-100
    account_id = Column(UUID(as_uuid=True), ForeignKey("accounts.id", ondelete="SET NULL"), nullable=True, index=True)
    suggested_category_id = Column(UUID(as_uuid=True), ForeignKey("categories.id", ondelete="SET NULL"), nullable=True, index=True)

    # Linked transactions (stored as JSON array of IDs)
    matched_transaction_ids = Column(Text, nullable=False)  # JSON array

    # Status
    status = Column(String(20), default="pending", nullable=False)  # pending, approved, dismissed

    # Timestamps
    created_at = Column(DateTime, default=datetime.utcnow, nullable=False)
    updated_at = Column(DateTime, default=datetime.utcnow, onupdate=datetime.utcnow, nullable=False)

    # Relationships
    user = relationship("User", back_populates="subscription_suggestions")
    account = relationship("Account", back_populates="subscription_suggestions")
    suggested_category = relationship("Category", back_populates="subscription_suggestions")

    # Indexes
    __table_args__ = (
        Index("idx_subscription_suggestions_user", "user_id"),
        Index("idx_subscription_suggestions_status", "status"),
        Index("idx_subscription_suggestions_account", "account_id"),
        Index("idx_subscription_suggestions_category", "suggested_category_id"),
    )


class TransactionLink(Base):
    """
    Transaction link model matching Drizzle schema.
    Links transactions together for reimbursement/expense tracking.
    """
    __tablename__ = "transaction_links"

    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    user_id = Column(String, ForeignKey("users.id", ondelete="CASCADE"), nullable=False, index=True)
    group_id = Column(UUID(as_uuid=True), nullable=False, index=True)  # Groups linked transactions together
    transaction_id = Column(UUID(as_uuid=True), ForeignKey("transactions.id", ondelete="CASCADE"), nullable=False)
    link_role = Column(String(20), nullable=False)  # "primary" | "reimbursement" | "expense"
    created_at = Column(DateTime, default=datetime.utcnow)

    # Relationships
    user = relationship("User", back_populates="transaction_links")
    transaction = relationship("Transaction", back_populates="transaction_link")

    # Indexes and constraints
    __table_args__ = (
        Index("idx_transaction_links_user", "user_id"),
        Index("idx_transaction_links_group", "group_id"),
        UniqueConstraint("transaction_id", name="transaction_links_transaction_unique"),
    )


class CompanyLogo(Base):
    """
    Company logo model matching Drizzle schema.
    Stores company logos for subscriptions and recurring transactions.
    """
    __tablename__ = "company_logos"

    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    domain = Column(String(255), nullable=True)  # "netflix.com"
    company_name = Column(String(255), nullable=True)  # "Netflix"
    logo_url = Column(Text, nullable=True)  # Local path: "/uploads/logos/netflix.png"
    status = Column(String(20), default="found", nullable=False)  # "found" | "not_found"
    last_checked_at = Column(DateTime, default=datetime.utcnow)
    created_at = Column(DateTime, default=datetime.utcnow)
    updated_at = Column(DateTime, default=datetime.utcnow, onupdate=datetime.utcnow)

    # Relationships
    accounts = relationship("Account", back_populates="logo")
    recurring_transactions = relationship("RecurringTransaction", back_populates="logo")

    # Indexes and constraints
    __table_args__ = (
        Index("idx_company_logos_domain", "domain"),
        Index("idx_company_logos_name", "company_name"),
        UniqueConstraint("domain", name="company_logos_domain_unique"),
    )


# ============================================================================
# BetterAuth Tables (minimal models for foreign key relationships)
# ============================================================================

class VerificationToken(Base):
    """
    VerificationToken model for BetterAuth integration.
    Stores email verification tokens.
    Minimal model matching Drizzle schema for foreign key relationships.
    """
    __tablename__ = "verification_tokens"

    id = Column(String, primary_key=True)
    identifier = Column(String, nullable=False)
    token = Column(String, unique=True, nullable=False)
    expires_at = Column(DateTime, nullable=False)
    created_at = Column(DateTime, default=datetime.utcnow)
    updated_at = Column(DateTime, default=datetime.utcnow, onupdate=datetime.utcnow)


class Session(Base):
    """
    Session model for BetterAuth integration.
    Stores user session information.
    Minimal model matching Drizzle schema for foreign key relationships.
    """
    __tablename__ = "sessions"

    id = Column(String, primary_key=True)
    user_id = Column(String, ForeignKey("users.id", ondelete="CASCADE"), nullable=False)
    token = Column(String, unique=True, nullable=False)
    expires_at = Column(DateTime, nullable=False)
    ip_address = Column(Text, nullable=True)
    user_agent = Column(Text, nullable=True)
    created_at = Column(DateTime, default=datetime.utcnow)
    updated_at = Column(DateTime, default=datetime.utcnow, onupdate=datetime.utcnow)

    # Relationships
    user = relationship("User", back_populates="sessions")


class AuthAccount(Base):
    """
    AuthAccount model for BetterAuth integration.
    Stores authentication account information (OAuth providers, credentials, etc.).
    Minimal model matching Drizzle schema for foreign key relationships.
    """
    __tablename__ = "auth_accounts"

    id = Column(String, primary_key=True)
    user_id = Column(String, ForeignKey("users.id", ondelete="CASCADE"), nullable=False)
    account_id = Column(String, nullable=False)
    provider_id = Column(String, nullable=False)
    access_token = Column(Text, nullable=True)
    refresh_token = Column(Text, nullable=True)
    access_token_expires_at = Column(DateTime, nullable=True)
    refresh_token_expires_at = Column(DateTime, nullable=True)
    scope = Column(Text, nullable=True)
    id_token = Column(Text, nullable=True)
    password = Column(Text, nullable=True)
    created_at = Column(DateTime, default=datetime.utcnow)
    updated_at = Column(DateTime, default=datetime.utcnow, onupdate=datetime.utcnow)

    # Relationships
    user = relationship("User", back_populates="auth_accounts")


class User(Base):
    """
    User model for BetterAuth integration.
    Minimal model for foreign key relationships.
    Full user management is handled by BetterAuth in the frontend.
    """
    __tablename__ = "users"

    id = Column(String, primary_key=True)
    name = Column(Text, nullable=True)
    email = Column(Text, unique=True, nullable=False)
    email_verified = Column(Boolean, default=False)
    image = Column(Text, nullable=True)
    onboarding_status = Column(String(20), default="pending")  # pending, step_1, step_2, step_3, completed
    onboarding_completed_at = Column(DateTime, nullable=True)
    functional_currency = Column(String(3), default="EUR")  # User's functional currency for reporting
    country_code = Column(String(2), nullable=True)
    locale = Column(String(35), nullable=True)
    profile_photo_path = Column(Text, nullable=True)
    created_at = Column(DateTime, default=datetime.utcnow)
    updated_at = Column(DateTime, default=datetime.utcnow, onupdate=datetime.utcnow)

    # Relationships
    sessions = relationship("Session", back_populates="user", cascade="all, delete-orphan")
    auth_accounts = relationship("AuthAccount", back_populates="user", cascade="all, delete-orphan")
    accounts = relationship("Account", back_populates="user", cascade="all, delete-orphan")
    categories = relationship("Category", back_populates="user", cascade="all, delete-orphan")
    transactions = relationship("Transaction", back_populates="user", cascade="all, delete-orphan")
    recurring_transactions = relationship("RecurringTransaction", back_populates="user", cascade="all, delete-orphan")
    categorization_rules = relationship("CategorizationRule", back_populates="user", cascade="all, delete-orphan")
    csv_imports = relationship("CsvImport", back_populates="user", cascade="all, delete-orphan")
    csv_import_profiles = relationship("CsvImportProfile", back_populates="user", cascade="all, delete-orphan")
    properties = relationship("Property", back_populates="user", cascade="all, delete-orphan")
    property_liability_links = relationship("PropertyLiabilityLink", back_populates="user", cascade="all, delete-orphan")
    property_valuations = relationship("PropertyValuation", back_populates="user", cascade="all, delete-orphan")
    vehicles = relationship("Vehicle", back_populates="user", cascade="all, delete-orphan")
    subscription_suggestions = relationship("SubscriptionSuggestion", back_populates="user", cascade="all, delete-orphan")
    api_keys = relationship("ApiKey", back_populates="user", cascade="all, delete-orphan")
    transaction_links = relationship("TransactionLink", back_populates="user", cascade="all, delete-orphan")
    planned_expenses = relationship("PlannedExpense", back_populates="user", cascade="all, delete-orphan")
    planned_expense_transaction_links = relationship("PlannedExpenseTransactionLink", back_populates="user", cascade="all, delete-orphan")
    cashflow_overrides = relationship("CashflowOverride", back_populates="user", cascade="all, delete-orphan")
    recurring_transaction_schedule_overrides = relationship("RecurringTransactionScheduleOverride", back_populates="user", cascade="all, delete-orphan")
    bank_connections = relationship("BankConnection", back_populates="user", cascade="all, delete-orphan")
    super_accounts = relationship("SuperAccount", back_populates="user", cascade="all, delete-orphan")
    super_contributions = relationship("SuperContribution", back_populates="user", cascade="all, delete-orphan")
    super_contribution_caps = relationship("SuperContributionCap", back_populates="user", cascade="all, delete-orphan")


class ApiKey(Base):
    """
    API Key model for MCP server authentication.
    Stores hashed API keys for secure authentication.
    """
    __tablename__ = "api_keys"

    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    user_id = Column(String, ForeignKey("users.id", ondelete="CASCADE"), nullable=False, index=True)
    name = Column(String(255), nullable=False)
    key_hash = Column(String(128), nullable=False, index=True)  # Supports bcrypt (60 chars) and SHA-256 (64 chars)
    key_prefix = Column(String(12), nullable=False)
    last_used_at = Column(DateTime, nullable=True)
    expires_at = Column(DateTime, nullable=True)
    created_at = Column(DateTime, default=datetime.utcnow)

    # Relationships
    user = relationship("User", back_populates="api_keys")

    # Indexes
    __table_args__ = (
        Index("idx_api_keys_user", "user_id"),
        Index("idx_api_keys_hash", "key_hash"),
    )


class BrokerConnection(Base):
    __tablename__ = "broker_connections"

    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    user_id = Column(String, ForeignKey("users.id", ondelete="CASCADE"), nullable=False, index=True)
    account_id = Column(UUID(as_uuid=True), ForeignKey("accounts.id", ondelete="CASCADE"), nullable=False)
    provider = Column(String(50), nullable=False)
    credentials_encrypted = Column(Text, nullable=False)
    last_sync_at = Column(DateTime, nullable=True)
    last_sync_status = Column(String(20), default="pending")
    last_sync_error = Column(Text, nullable=True)
    created_at = Column(DateTime, default=datetime.utcnow)
    updated_at = Column(DateTime, default=datetime.utcnow, onupdate=datetime.utcnow)

    account = relationship("Account")


class Holding(Base):
    __tablename__ = "holdings"

    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    user_id = Column(String, ForeignKey("users.id", ondelete="CASCADE"), nullable=False)
    account_id = Column(UUID(as_uuid=True), ForeignKey("accounts.id", ondelete="CASCADE"), nullable=False)
    symbol = Column(String(64), nullable=False)
    provider_symbol = Column(String(64), nullable=True)
    name = Column(String(255))
    currency = Column(String(3), nullable=False)
    instrument_type = Column(String(20), nullable=False)
    quantity = Column(Numeric(28, 8), nullable=False)
    avg_cost = Column(Numeric(28, 8), nullable=True)
    as_of_date = Column(Date, nullable=True)
    source = Column(String(20), nullable=False)
    last_price_error = Column(Text, nullable=True)
    created_at = Column(DateTime, default=datetime.utcnow)
    updated_at = Column(DateTime, default=datetime.utcnow, onupdate=datetime.utcnow)

    valuations = relationship("HoldingValuation", back_populates="holding", cascade="all, delete-orphan")

    __table_args__ = (
        UniqueConstraint("account_id", "symbol", "instrument_type", name="holdings_account_symbol_type_uq"),
        Index("idx_holdings_account", "account_id"),
    )


class BrokerTrade(Base):
    __tablename__ = "broker_trades"

    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    account_id = Column(UUID(as_uuid=True), ForeignKey("accounts.id", ondelete="CASCADE"), nullable=False)
    symbol = Column(String(64), nullable=False)
    trade_date = Column(Date, nullable=False)
    side = Column(String(10), nullable=False)
    quantity = Column(Numeric(28, 8), nullable=False)
    price = Column(Numeric(28, 8), nullable=False)
    currency = Column(String(3), nullable=False)
    fees = Column(Numeric(28, 8), nullable=False, default=0)
    external_id = Column(String(128), nullable=False)

    __table_args__ = (
        UniqueConstraint("account_id", "external_id", name="broker_trades_account_external_uq"),
    )


class PriceSnapshot(Base):
    __tablename__ = "price_snapshots"

    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    symbol = Column(String(64), nullable=False)
    currency = Column(String(3), nullable=False)
    date = Column(Date, nullable=False)
    close = Column(Numeric(28, 8), nullable=False)
    provider = Column(String(20), nullable=False)

    __table_args__ = (
        UniqueConstraint("symbol", "date", name="price_snapshots_symbol_date_uq"),
    )


class HoldingValuation(Base):
    __tablename__ = "holding_valuations"

    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    holding_id = Column(UUID(as_uuid=True), ForeignKey("holdings.id", ondelete="CASCADE"), nullable=False)
    date = Column(Date, nullable=False)
    quantity = Column(Numeric(28, 8), nullable=False)
    price = Column(Numeric(28, 8), nullable=False)
    value_user_currency = Column(Numeric(15, 2), nullable=False)
    is_stale = Column(Boolean, default=False)

    holding = relationship("Holding", back_populates="valuations")

    __table_args__ = (
        UniqueConstraint("holding_id", "date", name="holding_valuations_holding_date_uq"),
    )


class Person(Base):
    __tablename__ = "people"

    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    user_id = Column(Text, ForeignKey("users.id", ondelete="CASCADE"), nullable=False)
    name = Column(String(255), nullable=False)
    kind = Column(String(20), nullable=False, default="member")
    color = Column(String(7), nullable=True)
    avatar_path = Column(Text, nullable=True)
    created_at = Column(DateTime, default=datetime.utcnow, nullable=False)
    updated_at = Column(DateTime, default=datetime.utcnow, onupdate=datetime.utcnow, nullable=False)

    user = relationship("User", backref="people")

    __table_args__ = (
        Index("idx_people_user", "user_id"),
    )


class AccountOwner(Base):
    __tablename__ = "account_owners"

    account_id = Column(UUID(as_uuid=True), ForeignKey("accounts.id", ondelete="CASCADE"), primary_key=True)
    person_id = Column(UUID(as_uuid=True), ForeignKey("people.id", ondelete="CASCADE"), primary_key=True)
    share = Column(Numeric(5, 4), nullable=True)
    created_at = Column(DateTime, default=datetime.utcnow, nullable=False)


class PropertyOwner(Base):
    __tablename__ = "property_owners"

    property_id = Column(UUID(as_uuid=True), ForeignKey("properties.id", ondelete="CASCADE"), primary_key=True)
    person_id = Column(UUID(as_uuid=True), ForeignKey("people.id", ondelete="CASCADE"), primary_key=True)
    share = Column(Numeric(5, 4), nullable=True)
    created_at = Column(DateTime, default=datetime.utcnow, nullable=False)


class VehicleOwner(Base):
    __tablename__ = "vehicle_owners"

    vehicle_id = Column(UUID(as_uuid=True), ForeignKey("vehicles.id", ondelete="CASCADE"), primary_key=True)
    person_id = Column(UUID(as_uuid=True), ForeignKey("people.id", ondelete="CASCADE"), primary_key=True)
    share = Column(Numeric(5, 4), nullable=True)
    created_at = Column(DateTime, default=datetime.utcnow, nullable=False)
