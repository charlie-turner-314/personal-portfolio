from __future__ import annotations
import logging
from datetime import date, timedelta
from decimal import Decimal
from .base import PriceProvider, PriceQuote, SymbolMatch

try:
    import yfinance as yf
except ImportError:  # pragma: no cover
    yf = None

logger = logging.getLogger(__name__)


class YahooPriceProvider:
    name = "yahoo-v2"

    def _quote_terms(self, symbol: str, info=None) -> tuple[str, Decimal]:
        info = info if info is not None else (yf.Ticker(symbol).info or {})
        currency = info.get("currency")
        if not currency:
            raise ValueError(f"Quote currency unavailable for {symbol}")
        # Provider minor-unit quotes must not become 100x major-unit prices.
        minor_units = {"GBp": "GBP", "GBX": "GBP", "ZAc": "ZAR", "ILA": "ILS"}
        if currency in minor_units:
            return minor_units[currency], Decimal("0.01")
        if len(currency) != 3:
            raise ValueError(f"Unsupported quote currency for {symbol}")
        return currency.upper(), Decimal(1)

    def _currency_for(self, symbol: str) -> str:
        return self._quote_terms(symbol)[0]

    def resolve_symbol(self, symbol: str) -> SymbolMatch:
        if yf is None:
            raise RuntimeError("yfinance is not installed")
        info = yf.Ticker(symbol).info or {}
        currency, _ = self._quote_terms(symbol, info)
        resolved = info.get("symbol")
        if not resolved or resolved.upper() != symbol.upper():
            raise ValueError("An exact instrument match is required")
        types = {"EQUITY": "equity", "ETF": "etf", "MUTUALFUND": "fund", "CRYPTOCURRENCY": "crypto"}
        return SymbolMatch(symbol=resolved, name=info.get("longName") or info.get("shortName") or resolved,
                           exchange=info.get("fullExchangeName") or info.get("exchange"), currency=currency,
                           instrument_type=types.get(info.get("quoteType")))

    def get_daily_close(self, symbol: str, on: date) -> PriceQuote | None:
        if yf is None:
            raise RuntimeError("yfinance is not installed")
        start = on - timedelta(days=5)
        end = on + timedelta(days=1)
        df = yf.Ticker(symbol).history(start=start.isoformat(), end=end.isoformat(), auto_adjust=False)
        if df is None or df.empty:
            return None
        df = df[df.index.date <= on]
        if df.empty:
            return None
        row = df.iloc[-1]
        currency, scale = self._quote_terms(symbol)
        return PriceQuote(
            symbol=symbol,
            currency=currency,
            date=df.index[-1].date(),
            close=Decimal(str(row["Close"])) * scale,
        )

    def get_daily_closes(self, symbols: list[str], on: date) -> dict[str, PriceQuote]:
        if not symbols:
            return {}
        if yf is None:
            raise RuntimeError("yfinance is not installed")
        start = on - timedelta(days=5)
        end = on + timedelta(days=1)
        data = yf.download(
            tickers=" ".join(symbols),
            start=start.isoformat(),
            end=end.isoformat(),
            group_by="column",
            auto_adjust=False,
            progress=False,
            threads=True,
        )
        out: dict[str, PriceQuote] = {}
        if data is None or data.empty:
            return out
        # yfinance returns a MultiIndex when multiple tickers are requested,
        # but a flat columns Index when only one is requested.
        is_multi = hasattr(data.columns, "get_level_values") and getattr(
            data.columns, "nlevels", 1
        ) > 1
        if is_multi:
            if "Close" not in data.columns.get_level_values(0):
                return out
            closes = data["Close"]
        else:
            if "Close" not in data.columns:
                return out
            # Single-symbol response: build a one-column frame keyed by the symbol.
            import pandas as pd  # local import — already a transitive dep of yfinance
            closes = pd.DataFrame({symbols[0]: data["Close"]})
        for sym in symbols:
            if sym not in closes.columns:
                continue
            series = closes[sym].dropna()
            series = series[series.index.date <= on]
            if series.empty:
                continue
            try:
                currency, scale = self._quote_terms(sym)
            except Exception:
                logger.warning("Quote currency unavailable for %s; skipping its price", sym)
                continue
            out[sym] = PriceQuote(
                symbol=sym,
                currency=currency,
                date=series.index[-1].date(),
                close=Decimal(str(series.iloc[-1])) * scale,
            )
        return out

    def get_daily_closes_range(
        self, symbol: str, start: date, end: date
    ) -> list[PriceQuote]:
        """Fetch all daily closes for `symbol` in [start, end] (inclusive on
        both ends). Returns one PriceQuote per trading day; weekends/holidays
        are absent (caller forward-fills)."""
        if yf is None:
            raise RuntimeError("yfinance is not installed")
        if start > end:
            return []
        # yfinance treats `end` as exclusive; bump by 1 day to include it.
        end_excl = end + timedelta(days=1)
        df = yf.Ticker(symbol).history(
            start=start.isoformat(), end=end_excl.isoformat(), auto_adjust=False
        )
        if df is None or df.empty:
            return []
        currency, scale = self._quote_terms(symbol)
        out: list[PriceQuote] = []
        for ts, row in df.iterrows():
            d = ts.date()
            if d < start or d > end:
                continue
            out.append(PriceQuote(
                symbol=symbol,
                currency=currency,
                date=d,
                close=Decimal(str(row["Close"])) * scale,
            ))
        return out

    def search_symbols(self, query: str) -> list[SymbolMatch]:
        try:
            from yfinance import Search  # type: ignore
            results = Search(query, max_results=10).quotes or []
            return [
                SymbolMatch(
                    symbol=r.get("symbol", ""),
                    name=r.get("shortname") or r.get("longname") or r.get("symbol", ""),
                    exchange=r.get("exchDisp"),
                    currency=r.get("currency"),
                )
                for r in results
                if r.get("symbol")
            ]
        except Exception:
            logger.exception("Symbol search unavailable")
            raise RuntimeError("Symbol search is unavailable; try again or enter an instrument manually")
