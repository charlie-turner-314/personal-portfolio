from pathlib import Path

from app.models import (
    BrokerTrade,
    CsvImportProfile,
    InvestmentActivity,
    InvestmentCostBaseAdjustment,
    InvestmentIncomeEnrichment,
    InvestmentIngestionRun,
    InvestmentReconciliationItem,
    InvestmentSourceRecord,
)


ROOT = Path(__file__).resolve().parents[2]


def test_drizzle_and_sqlalchemy_foundation_columns_stay_in_parity():
    expected = {
        "investment_ingestion_runs": set(InvestmentIngestionRun.__table__.columns.keys()),
        "investment_source_records": set(InvestmentSourceRecord.__table__.columns.keys()),
        "investment_activities": set(InvestmentActivity.__table__.columns.keys()),
    }
    schema = (ROOT / "frontend/lib/db/schema.ts").read_text()
    migration = (ROOT / "frontend/lib/db/migrations/0038_investment_ingestion_foundation.manual.sql").read_text()

    for table_name, columns in expected.items():
        assert f'pgTable("{table_name}"' in schema
        assert f'CREATE TABLE IF NOT EXISTS "{table_name}"' in migration
        for column in columns:
            assert f'"{column}"' in schema, f"Drizzle schema missing {table_name}.{column}"
            assert f'"{column}"' in migration, f"migration missing {table_name}.{column}"


def test_migration_contains_idempotency_and_canonical_type_constraints():
    migration = (ROOT / "frontend/lib/db/migrations/0038_investment_ingestion_foundation.manual.sql").read_text()

    assert "investment_source_records_account_provider_key_uq" in migration
    assert "investment_activities_source_leg_uq" in migration
    for activity_type in (
        "buy",
        "sell",
        "dividend",
        "distribution",
        "drp",
        "deposit",
        "withdrawal",
        "transfer",
        "fee",
        "interest",
        "staking_reward",
        "airdrop",
        "crypto_swap",
    ):
        assert f"'{activity_type}'" in migration


def test_existing_broker_trade_fee_column_is_in_clean_deployment_schema():
    schema = (ROOT / "frontend/lib/db/schema.ts").read_text()
    migration = (ROOT / "frontend/lib/db/migrations/0038_investment_ingestion_foundation.manual.sql").read_text()

    assert 'fees: numeric("fees", { precision: 28, scale: 8 }).default("0").notNull()' in schema
    assert 'ADD COLUMN IF NOT EXISTS "fees" numeric(28, 8) DEFAULT 0 NOT NULL' in migration


def test_source_records_are_database_immutable():
    migration = (ROOT / "frontend/lib/db/migrations/0038_investment_ingestion_foundation.manual.sql").read_text()

    assert 'CREATE OR REPLACE FUNCTION "prevent_investment_source_record_update"()' in migration
    assert 'BEFORE UPDATE ON "investment_source_records"' in migration


def test_csv_mapping_profiles_are_scoped_by_workflow_and_provider():
    schema = (ROOT / "frontend/lib/db/schema.ts").read_text()
    migration = (ROOT / "frontend/lib/db/migrations/0039_generic_investment_csv_import.manual.sql").read_text()

    assert {"import_kind", "provider"}.issubset(CsvImportProfile.__table__.columns.keys())
    assert 'importKind: varchar("import_kind", { length: 24 })' in schema
    assert 'provider: varchar("provider", { length: 64 })' in schema
    assert 'DROP CONSTRAINT IF EXISTS "csv_import_profiles_user_account_unique"' in migration
    assert '"csv_import_profiles_scope_unique"' in schema
    assert "UNIQUE (\"user_id\", \"account_id\", \"import_kind\", \"provider\")" in migration
    assert "instrument_type" in BrokerTrade.__table__.columns.keys()
    assert 'instrumentType: text("instrument_type").default("equity").notNull()' in schema
    assert 'ADD COLUMN IF NOT EXISTS "instrument_type" varchar(20)' in migration


def test_income_reconciliation_models_match_drizzle_schema_and_migration():
    schema = (ROOT / "frontend/lib/db/schema.ts").read_text()
    migration = (ROOT / "frontend/lib/db/migrations/0040_investment_income_reconciliation.manual.sql").read_text()
    models = (
        InvestmentIncomeEnrichment,
        InvestmentCostBaseAdjustment,
        InvestmentReconciliationItem,
    )
    for model in models:
        table_name = model.__tablename__
        assert f'pgTable("{table_name}"' in schema
        assert f'CREATE TABLE IF NOT EXISTS "{table_name}"' in migration
        for column in model.__table__.columns.keys():
            assert f'"{column}"' in schema
            assert f'"{column}"' in migration
    for column in (
        "tfn_withholding", "reconciliation_status", "user_confirmed_at",
        "matched_transaction_id", "component_sources", "annual_statement_reference",
        "created_by_activity_id", "instrument_type", "cost_base_adjustment_native",
        "cost_base_adjustment_aud", "adjustment_ids",
    ):
        assert f'"{column}"' in schema
        assert f'"{column}"' in migration
    assert "profile_variant" in CsvImportProfile.__table__.columns.keys()
    assert 'profileVariant: varchar("profile_variant", { length: 32 })' in schema
    assert 'UNIQUE ("user_id", "account_id", "import_kind", "provider", "profile_variant")' in migration
