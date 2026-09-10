from pathlib import Path

from app.models import InvestmentActivity, InvestmentIngestionRun, InvestmentSourceRecord


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
