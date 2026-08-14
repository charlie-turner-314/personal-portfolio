"""Create the derived, auditable CGT allocation table."""
from __future__ import annotations

import sys
from pathlib import Path

backend_dir = Path(__file__).resolve().parent.parent
if str(backend_dir) not in sys.path:
    sys.path.insert(0, str(backend_dir))

from sqlalchemy import create_engine, text

from app.database import db_url


SQL = """
CREATE TABLE IF NOT EXISTS cgt_allocations (
  id UUID PRIMARY KEY,
  account_id UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  acquisition_trade_id UUID NOT NULL REFERENCES broker_trades(id) ON DELETE CASCADE,
  disposal_trade_id UUID NOT NULL REFERENCES broker_trades(id) ON DELETE CASCADE,
  symbol VARCHAR(64) NOT NULL,
  acquisition_date DATE NOT NULL,
  disposal_date DATE NOT NULL,
  quantity NUMERIC(28, 8) NOT NULL,
  currency VARCHAR(3) NOT NULL,
  cost_base_native NUMERIC(28, 8) NOT NULL,
  proceeds_native NUMERIC(28, 8) NOT NULL,
  gain_native NUMERIC(28, 8) NOT NULL,
  cost_base_aud NUMERIC(28, 8),
  proceeds_aud NUMERIC(28, 8),
  gain_aud NUMERIC(28, 8),
  fx_missing BOOLEAN NOT NULL DEFAULT FALSE,
  discount_eligible BOOLEAN NOT NULL DEFAULT FALSE,
  calculation_version VARCHAR(32) NOT NULL DEFAULT 'fifo-v1',
  assumptions JSON NOT NULL DEFAULT '[]'::json,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT cgt_allocations_trade_pair_uq UNIQUE (acquisition_trade_id, disposal_trade_id)
);
CREATE INDEX IF NOT EXISTS idx_cgt_allocations_account_disposal
  ON cgt_allocations (account_id, disposal_date);
"""


if __name__ == "__main__":
    engine = create_engine(db_url)
    with engine.begin() as conn:
        conn.execute(text(SQL))
    print("OK: cgt_allocations table is ready.")
