from __future__ import annotations
from datetime import date
from decimal import Decimal
import logging
from sqlalchemy.orm import Session
from sqlalchemy.dialects.postgresql import insert as pg_insert

from app.models import PriceSnapshot
from app.integrations.price_provider import get_price_provider
from app.integrations.price_provider.base import PriceProvider, PriceQuote

logger = logging.getLogger(__name__)


class PriceService:
    def __init__(self, db: Session, provider: PriceProvider | None = None):
        self.db = db
        self.provider = provider or get_price_provider()

    def get_or_fetch(self, symbols: list[str], on: date) -> dict[str, PriceQuote]:
        if not symbols:
            return {}
        cached_rows = (
            self.db.query(PriceSnapshot)
            .filter(PriceSnapshot.symbol.in_(symbols), PriceSnapshot.date == on, PriceSnapshot.provider == self.provider.name)
            .all()
        )
        cached = {
            r.symbol: PriceQuote(symbol=r.symbol, currency=r.currency, date=on, close=Decimal(r.close))
            for r in cached_rows
        }
        missing = [s for s in symbols if s not in cached]
        if missing:
            try:
                fetched = self.provider.get_daily_closes(missing, on)
            except Exception as e:
                logger.warning("price provider %s failed for %s on %s: %s", self.provider.name, missing, on, e)
                fetched = {}
            for sym, quote in fetched.items():
                stmt = pg_insert(PriceSnapshot).values(
                    symbol=quote.symbol,
                    currency=quote.currency,
                    date=quote.date,
                    close=quote.close,
                    provider=self.provider.name,
                ).on_conflict_do_nothing(index_elements=["symbol", "date", "provider"])
                self.db.execute(stmt)
                cached[sym] = quote
            self.db.commit()
        return cached

    def latest_snapshot(self, symbol: str, on: date, provider: str | None = None) -> PriceSnapshot | None:
        return (
            self.db.query(PriceSnapshot)
            .filter(PriceSnapshot.symbol == symbol, PriceSnapshot.date <= on,
                    *([PriceSnapshot.provider == provider] if provider else []))
            .order_by(PriceSnapshot.date.desc())
            .first()
        )


def holding_price_lookup(holding, market_provider):
    """A ticker is not globally unique across exchange balance and market feeds."""
    override = holding.provider_symbol
    if override and override.startswith("manual:"):
        return override, "manual"
    if override and override.startswith("ibkr:"):
        return override, "ibkr_flex"
    if holding.source == "ibkr_flex" and not override:
        return f"ibkr:{holding.id.hex}", "ibkr_flex"
    exchange_sources = {"coinspot_api": "coinspot", "binance_api": "binance", "crypto_com_api": "crypto_com_exchange"}
    if holding.source in exchange_sources and (not override or len(override) > 64):
        return holding.symbol, exchange_sources[holding.source]
    symbol = override or holding.symbol
    if not override and holding.instrument_type == "crypto" and "-" not in symbol:
        symbol = f"{symbol}-{holding.currency}"
    return symbol, market_provider
