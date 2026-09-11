from __future__ import annotations
import os
import time
from datetime import date, datetime, timedelta
from decimal import Decimal
from typing import Callable
from uuid import UUID
import logging
from sqlalchemy import text as sql_text
from sqlalchemy.orm import Session

from app.models import (
    Account, BrokerConnection, Holding, BrokerTrade, PriceSnapshot, InvestmentActivity,
)
from app.services.credentials_crypto import decrypt
from app.services.holding_valuation_service import HoldingValuationService, FxConverter
from app.services.price_service import PriceService
from app.integrations.ibkr_flex_adapter import (
    IBKRFlexAdapter, FlexAuthError, FlexStatementNotReady, FlexTransientError, FlexError,
)
from app.integrations.coinspot_adapter import (
    CoinSpotAdapter,
    CoinSpotAuthError,
    CoinSpotBalance,
    CoinSpotError,
    CoinSpotHistoryLimitError,
    CoinSpotReadOnlyClient,
    CoinSpotTransientError,
)
from app.integrations.binance_adapter import (
    BinanceAdapter,
    BinanceAuthError,
    BinanceBalance,
    BinanceError,
    BinanceHistoryLimitError,
    BinanceReadOnlyClient,
    BinanceTransientError,
    FIAT_CODES,
)
from app.services.investment_activity_service import apply_batch

logger = logging.getLogger(__name__)

AdapterFactory = Callable[[dict], IBKRFlexAdapter]
CoinSpotAdapterFactory = Callable[[dict], CoinSpotAdapter]
BinanceAdapterFactory = Callable[[dict], BinanceAdapter]


def _default_factory(creds: dict) -> IBKRFlexAdapter:
    return IBKRFlexAdapter(
        token=creds["flex_token"],
        query_id_positions=creds["query_id_positions"],
        query_id_trades=creds["query_id_trades"],
    )


def _default_coinspot_factory(creds: dict) -> CoinSpotAdapter:
    return CoinSpotAdapter(CoinSpotReadOnlyClient(
        api_key=creds["api_key"],
        api_secret=creds["api_secret"],
    ))


def _default_binance_factory(creds: dict) -> BinanceAdapter:
    return BinanceAdapter(BinanceReadOnlyClient(
        api_key=creds["api_key"],
        api_secret=creds["api_secret"],
    ))


class InvestmentSyncService:
    def __init__(self, db: Session, fx: FxConverter,
                 adapter_factory: AdapterFactory | None = None,
                 coinspot_adapter_factory: CoinSpotAdapterFactory | None = None,
                 binance_adapter_factory: BinanceAdapterFactory | None = None,
                 price_service: PriceService | None = None,
                 valuation_service: HoldingValuationService | None = None):
        self.db = db
        self.fx = fx
        self.adapter_factory = adapter_factory or _default_factory
        self.coinspot_adapter_factory = coinspot_adapter_factory or _default_coinspot_factory
        self.binance_adapter_factory = binance_adapter_factory or _default_binance_factory
        self.price_service = price_service or PriceService(db=db)
        self.valuation_service = valuation_service or HoldingValuationService(db=db, fx=fx, price_service=self.price_service)

    def sync_account(self, account_id: UUID, on: date | None = None) -> None:
        on = on or date.today()
        account = self.db.query(Account).filter_by(id=account_id).one()
        if account.account_type == "investment_brokerage":
            self._sync_brokerage(account, on)
        elif account.account_type == "investment_manual":
            self._sync_manual(account, on)
        else:
            raise ValueError(f"Account {account_id} is not an investment account")

    def _sync_brokerage(self, account: Account, on: date) -> None:
        conn = self.db.query(BrokerConnection).filter_by(account_id=account.id).one()
        creds = decrypt(conn.credentials_encrypted)
        if conn.provider == "coinspot":
            if not self._try_provider_sync_lock(account.id):
                logger.info("CoinSpot sync already running for account %s", account.id)
                return
            self._sync_coinspot(account, conn, creds, on)
            return
        if conn.provider == "binance":
            if not self._try_provider_sync_lock(account.id):
                logger.info("Binance sync already running for account %s", account.id)
                return
            self._sync_binance(account, conn, creds, on)
            return
        if conn.provider != "ibkr_flex":
            raise ValueError(f"Unsupported investment provider: {conn.provider}")
        self._sync_ibkr(account, conn, creds, on)

    def _sync_ibkr(self, account: Account, conn: BrokerConnection, creds: dict, on: date) -> None:
        adapter = self.adapter_factory(creds)

        # Step 1 — positions (fatal if it fails; nothing useful happens without them).
        try:
            ref_positions = adapter.request_statement(creds["query_id_positions"])
            positions_xml = adapter.fetch_statement(ref_positions)
        except FlexAuthError as e:
            conn.last_sync_status = "needs_reauth"
            conn.last_sync_error = str(e)
            self.db.commit()
            raise
        except FlexStatementNotReady:
            conn.last_sync_status = "pending"
            self.db.commit()
            raise
        except FlexTransientError as e:
            conn.last_sync_status = "pending"
            conn.last_sync_error = str(e)
            self.db.commit()
            raise
        except FlexError as e:
            conn.last_sync_status = "error"
            conn.last_sync_error = str(e)
            self.db.commit()
            raise

        statement = adapter.parse_positions_xml(positions_xml)
        self._upsert_positions(account, statement.positions)
        self._upsert_cash(account, statement.cash)
        # Persist positions immediately so a later trades-fetch failure
        # doesn't roll back the work we already did.
        self.db.commit()

        # Step 2 — trades (best-effort; IBKR Flex throttles a token to ~1
        # request per ~10 min per query, so the back-to-back call here is
        # the most common 1018 trigger). A small delay smooths the bursty
        # double-call pattern; on failure we keep the sync as "partial"
        # so positions still surface and trades catch up next cycle.
        delay_raw = os.getenv("IBKR_FLEX_INTER_QUERY_DELAY_SEC", "5")
        try:
            delay = float(delay_raw)
        except ValueError:
            logger.warning(
                "Invalid IBKR_FLEX_INTER_QUERY_DELAY_SEC=%r; defaulting to 5",
                delay_raw,
            )
            delay = 5.0
        if delay > 0:
            time.sleep(delay)

        trades_error: str | None = None
        try:
            ref_trades = adapter.request_statement(creds["query_id_trades"])
            trades_xml = adapter.fetch_statement(ref_trades)
            trades = adapter.parse_trades_xml(trades_xml)
            self._upsert_trades(account, trades)
        except FlexAuthError as e:
            trades_error = f"trades auth failed: {e}"
            logger.warning("IBKR trades sync failed (auth) for %s: %s", account.id, e)
        except FlexStatementNotReady as e:
            trades_error = f"trades not ready: {e}"
            logger.info("IBKR trades not ready for %s: %s", account.id, e)
        except FlexTransientError as e:
            trades_error = f"trades transient error: {e}"
            logger.info("IBKR trades transient error for %s: %s", account.id, e)
        except FlexError as e:
            trades_error = f"trades fetch failed: {e}"
            logger.warning("IBKR trades sync failed for %s: %s", account.id, e)

        # Re-value either way — positions are saved.
        self.valuation_service.compute(account_id=account.id, on=on)

        if trades_error:
            conn.last_sync_status = "partial"
            conn.last_sync_error = trades_error
        else:
            conn.last_sync_status = "ok"
            conn.last_sync_error = None
        conn.last_sync_at = datetime.utcnow()
        self.db.commit()

    def _sync_coinspot(
        self,
        account: Account,
        conn: BrokerConnection,
        creds: dict,
        on: date,
    ) -> None:
        """Apply an overlapping CoinSpot history window, then anchor to live balances."""
        adapter = self.coinspot_adapter_factory(creds)
        cursor = conn.sync_cursor or {}
        configured_start = date.fromisoformat(creds.get("history_start_date") or "2013-01-01")
        cursor_through = cursor.get("history_through")
        if cursor_through:
            start = max(configured_start, date.fromisoformat(cursor_through) - timedelta(days=2))
        else:
            start = configured_start
        if start > on:
            start = on

        try:
            adapter.verify_read_only()
            conn.read_only_verified_at = datetime.utcnow()
            history = adapter.fetch_history(start=start, end=on)
            application = apply_batch(
                self.db,
                user_id=account.user_id,
                account_id=account.id,
                batch=history.batch,
                commit=False,
            )
            self.db.flush()
            expected = self._canonical_provider_balances(account.id)
            balances = adapter.fetch_balances()
            reconciliation = self._provider_reconciliation(expected, balances)
            self._upsert_provider_balances(
                account, balances, on, source="coinspot_api", price_provider="coinspot"
            )
            self.valuation_service.compute(account_id=account.id, on=on, commit=False)
        except CoinSpotAuthError as exc:
            self._record_coinspot_failure(conn, exc, status="needs_reauth", retry=False)
            raise
        except CoinSpotTransientError as exc:
            self._record_coinspot_failure(conn, exc, status="pending", retry=True)
            raise
        except (CoinSpotHistoryLimitError, CoinSpotError) as exc:
            self._record_coinspot_failure(conn, exc, status="error", retry=False)
            raise
        finally:
            close = getattr(adapter, "close", None)
            if close is not None:
                close()

        conn.sync_cursor = dict(history.batch.cursor or {"history_through": on.isoformat()})
        conn.last_sync_status = "partial" if reconciliation["differences"] else "ok"
        conn.last_sync_error = (
            "CoinSpot balances differ from normalized activity; review connection details."
            if reconciliation["differences"] else None
        )
        conn.health_details = {
            "read_only_namespace": "https://www.coinspot.com.au/api/v2/ro",
            "history_from": start.isoformat(),
            "history_through": on.isoformat(),
            "windows_requested": history.windows_requested,
            "pending_records": history.pending_records,
            "ingestion_run_id": application["run_id"],
            "inserted_records": application["inserted_records"],
            "skipped_duplicate_records": application["skipped_duplicate_records"],
            **reconciliation,
        }
        conn.last_sync_at = datetime.utcnow()
        conn.consecutive_failures = 0
        conn.next_retry_at = None
        self.db.commit()

    def _sync_binance(
        self,
        account: Account,
        conn: BrokerConnection,
        creds: dict,
        on: date,
    ) -> None:
        """Apply Binance histories atomically, then anchor Spot holdings to live balances."""
        adapter = self.binance_adapter_factory(creds)
        cursor = conn.sync_cursor or {}
        configured_start = date.fromisoformat(creds.get("history_start_date") or "2017-07-01")
        cursor_through = cursor.get("history_through")
        if cursor_through:
            start = max(configured_start, date.fromisoformat(cursor_through) - timedelta(days=2))
        else:
            start = configured_start
        if start > on:
            start = on
        configured_symbols = sorted({
            str(value).strip().upper()
            for value in [*(creds.get("trade_symbols") or []), *(cursor.get("trade_symbols") or [])]
            if str(value).strip()
        })

        try:
            adapter.verify_read_only()
            conn.read_only_verified_at = datetime.utcnow()
            balances = adapter.fetch_balances()
            history = adapter.fetch_history(
                start=start,
                end=on,
                configured_trade_symbols=configured_symbols,
                current_assets=[item.symbol for item in balances],
            )
            application = apply_batch(
                self.db,
                user_id=account.user_id,
                account_id=account.id,
                batch=history.batch,
                commit=False,
            )
            self.db.flush()
            expected = self._canonical_provider_balances(account.id)
            reconciliation = self._provider_reconciliation(expected, balances)
            self._upsert_provider_balances(
                account, balances, on, source="binance_api", price_provider="binance"
            )
            self.valuation_service.compute(account_id=account.id, on=on, commit=False)
        except BinanceAuthError as exc:
            self._record_binance_failure(conn, exc, status="needs_reauth", retry=False)
            raise
        except BinanceTransientError as exc:
            self._record_binance_failure(conn, exc, status="pending", retry=True)
            raise
        except (BinanceHistoryLimitError, BinanceError) as exc:
            self._record_binance_failure(conn, exc, status="error", retry=False)
            raise
        finally:
            close = getattr(adapter, "close", None)
            if close is not None:
                close()

        conn.sync_cursor = dict(history.batch.cursor or {"history_through": on.isoformat()})
        conn.last_sync_status = "partial" if reconciliation["differences"] else "ok"
        conn.last_sync_error = (
            "Binance Spot balances differ from normalized activity; review connection details."
            if reconciliation["differences"] else None
        )
        conn.health_details = {
            "read_only_namespace": "Binance signed USER_DATA GET allowlist",
            "history_from": start.isoformat(),
            "history_through": on.isoformat(),
            "windows_requested": history.windows_requested,
            "pending_records": history.pending_records,
            "trade_symbols": list(history.trade_symbols),
            "missing_product_warnings": list(history.missing_product_warnings),
            "unpriced_assets": sorted(item.symbol for item in balances if item.aud_rate <= 0),
            "ingestion_run_id": application["run_id"],
            "inserted_records": application["inserted_records"],
            "skipped_duplicate_records": application["skipped_duplicate_records"],
            **reconciliation,
        }
        conn.last_sync_at = datetime.utcnow()
        conn.consecutive_failures = 0
        conn.next_retry_at = None
        self.db.commit()

    def _record_binance_failure(
        self,
        conn: BrokerConnection,
        exc: Exception,
        *,
        status: str,
        retry: bool,
    ) -> None:
        self.db.rollback()
        conn = self.db.query(BrokerConnection).filter_by(id=conn.id).one()
        failures = int(conn.consecutive_failures or 0) + 1
        now = datetime.utcnow()
        conn.last_sync_status = status
        conn.last_sync_error = str(exc)[:1000]
        conn.consecutive_failures = failures
        if isinstance(exc, BinanceAuthError):
            conn.read_only_verified_at = None
        retry_seconds = min(60 * (2 ** (failures - 1)), 3600)
        provider_retry = getattr(exc, "retry_after_seconds", None)
        if provider_retry is not None:
            retry_seconds = min(max(retry_seconds, int(provider_retry)), 259200)
        conn.next_retry_at = now + timedelta(seconds=retry_seconds) if retry else None
        conn.health_details = {
            **(conn.health_details or {}),
            "last_attempt_at": now.isoformat(),
            "failure_kind": (
                "authentication" if isinstance(exc, BinanceAuthError)
                else "transient" if isinstance(exc, BinanceTransientError)
                else "history_limit" if isinstance(exc, BinanceHistoryLimitError)
                else "provider"
            ),
        }
        self.db.commit()

    def _try_provider_sync_lock(self, account_id: UUID) -> bool:
        """Serialize credential-bearing requests for one account across workers."""
        bind = self.db.get_bind()
        if bind.dialect.name != "postgresql":
            return True
        lock_key = account_id.int & ((1 << 63) - 1)
        return bool(self.db.execute(
            sql_text("SELECT pg_try_advisory_xact_lock(:lock_key)"),
            {"lock_key": lock_key},
        ).scalar_one())

    def _record_coinspot_failure(
        self,
        conn: BrokerConnection,
        exc: Exception,
        *,
        status: str,
        retry: bool,
    ) -> None:
        self.db.rollback()
        # Reload after rollback so health updates survive a failed canonical batch.
        conn = self.db.query(BrokerConnection).filter_by(id=conn.id).one()
        failures = int(conn.consecutive_failures or 0) + 1
        now = datetime.utcnow()
        conn.last_sync_status = status
        conn.last_sync_error = str(exc)[:1000]
        conn.consecutive_failures = failures
        if isinstance(exc, CoinSpotAuthError):
            conn.read_only_verified_at = None
        conn.next_retry_at = (
            now + timedelta(seconds=min(60 * (2 ** (failures - 1)), 3600))
            if retry else None
        )
        conn.health_details = {
            **(conn.health_details or {}),
            "last_attempt_at": now.isoformat(),
            "failure_kind": (
                "authentication" if isinstance(exc, CoinSpotAuthError)
                else "transient" if isinstance(exc, CoinSpotTransientError)
                else "history_limit" if isinstance(exc, CoinSpotHistoryLimitError)
                else "provider"
            ),
        }
        self.db.commit()

    def _canonical_provider_balances(self, account_id: UUID) -> dict[str, Decimal]:
        balances: dict[str, Decimal] = {}

        def add(symbol: str | None, quantity: Decimal) -> None:
            if symbol:
                normalized = symbol.upper()
                balances[normalized] = balances.get(normalized, Decimal("0")) + quantity

        activities = self.db.query(InvestmentActivity).filter(
            InvestmentActivity.account_id == account_id,
        ).order_by(InvestmentActivity.occurred_at, InvestmentActivity.id).all()
        for activity in activities:
            quantity = Decimal(activity.quantity or 0)
            kind = activity.activity_type
            if activity.asset_type == "crypto":
                if kind in {"buy", "staking_reward", "airdrop", "interest", "deposit"}:
                    add(activity.asset_symbol, quantity)
                elif kind in {"sell", "withdrawal"}:
                    add(activity.asset_symbol, -quantity)
                elif kind == "transfer":
                    if activity.direction == "in":
                        add(activity.asset_symbol, quantity)
                    elif activity.direction == "out":
                        add(activity.asset_symbol, -quantity)
                elif kind == "crypto_swap":
                    add(activity.asset_symbol, -quantity)
                    add(activity.counter_asset_symbol, Decimal(activity.counter_quantity or 0))
                elif kind == "fee":
                    add(activity.asset_symbol, -Decimal(activity.quantity or activity.fee_amount or 0))
            elif activity.asset_type == "cash":
                if kind == "deposit":
                    add(activity.asset_symbol, quantity)
                elif kind == "withdrawal":
                    add(activity.asset_symbol, -quantity)

            fee = Decimal(activity.fee_amount or 0)
            if kind != "fee" and fee and activity.fee_currency:
                add(activity.fee_currency, -fee)
            if kind == "buy" and activity.currency:
                cash_value = Decimal(
                    activity.gross_amount
                    or activity.aud_value
                    or (Decimal(activity.price or 0) * quantity)
                )
                add(activity.currency, -cash_value)
            elif kind == "sell" and activity.currency:
                cash_value = Decimal(
                    activity.net_amount
                    or activity.aud_value
                    or (Decimal(activity.price or 0) * quantity)
                )
                add(activity.currency, cash_value)
        return balances

    @staticmethod
    def _provider_reconciliation(
        expected: dict[str, Decimal],
        balances: tuple[CoinSpotBalance | BinanceBalance, ...],
    ) -> dict:
        provider = {item.symbol: item for item in balances}
        differences: list[dict[str, str]] = []
        total_aud_difference = Decimal("0")
        for symbol in sorted(set(expected) | set(provider)):
            expected_quantity = expected.get(symbol, Decimal("0"))
            item = provider.get(symbol)
            actual_quantity = item.quantity if item else Decimal("0")
            difference = actual_quantity - expected_quantity
            tolerance = max(Decimal("0.00000001"), abs(actual_quantity) * Decimal("0.00000001"))
            if abs(difference) <= tolerance:
                continue
            aud_rate = item.aud_rate if item else Decimal("0")
            aud_difference = difference * aud_rate
            total_aud_difference += abs(aud_difference)
            differences.append({
                "symbol": symbol,
                "activity_quantity": format(expected_quantity, "f"),
                "provider_quantity": format(actual_quantity, "f"),
                "difference": format(difference, "f"),
                "aud_difference": format(aud_difference, "f"),
            })
        return {
            "balances_reconciled": not differences,
            "differences": differences,
            "total_absolute_aud_difference": format(total_aud_difference, "f"),
        }

    def _upsert_provider_balances(
        self,
        account: Account,
        balances: tuple[CoinSpotBalance | BinanceBalance, ...],
        on: date,
        *,
        source: str,
        price_provider: str,
    ) -> None:
        reported = {item.symbol: item for item in balances}
        existing = {
            holding.symbol: holding
            for holding in self.db.query(Holding).filter(Holding.account_id == account.id).all()
        }
        for symbol in set(existing) - set(reported):
            existing[symbol].quantity = Decimal("0")
            existing[symbol].as_of_date = on
            existing[symbol].source = source
        for symbol, item in reported.items():
            instrument_type = "cash" if symbol in FIAT_CODES else "crypto"
            holding_currency = symbol if instrument_type == "cash" else "AUD"
            holding = existing.get(symbol)
            if holding is None:
                holding = Holding(
                    user_id=account.user_id,
                    account_id=account.id,
                    symbol=symbol,
                    name=f"Cash ({symbol})" if instrument_type == "cash" else symbol,
                    currency=holding_currency,
                    instrument_type=instrument_type,
                    quantity=item.quantity,
                    as_of_date=on,
                    source=source,
                    provider_symbol=getattr(item, "provider_symbol", None),
                )
                self.db.add(holding)
            else:
                holding.quantity = item.quantity
                holding.currency = holding_currency
                holding.instrument_type = instrument_type
                holding.as_of_date = on
                holding.source = source
                holding.provider_symbol = getattr(item, "provider_symbol", None)
            if instrument_type != "cash" and item.aud_rate > 0:
                snapshot = self.db.query(PriceSnapshot).filter_by(symbol=symbol, date=on).one_or_none()
                if snapshot is None:
                    self.db.add(PriceSnapshot(
                        symbol=symbol,
                        currency="AUD",
                        date=on,
                        close=item.aud_rate,
                        provider=price_provider,
                    ))
                else:
                    snapshot.currency = "AUD"
                    snapshot.close = item.aud_rate
                    snapshot.provider = price_provider
        self.db.flush()

    def _sync_manual(self, account: Account, on: date) -> None:
        holdings = self.db.query(Holding).filter_by(account_id=account.id).all()
        symbols = sorted({h.symbol for h in holdings if h.instrument_type != "cash"})
        if symbols:
            self.price_service.get_or_fetch(symbols, on)
        self.valuation_service.compute(account_id=account.id, on=on)
        account.last_synced_at = datetime.utcnow()
        self.db.commit()

    def _upsert_positions(self, account: Account, positions) -> None:
        seen = set()
        for p in positions:
            seen.add((p.symbol, p.instrument_type))
            row = self.db.query(Holding).filter_by(
                account_id=account.id, symbol=p.symbol, instrument_type=p.instrument_type
            ).one_or_none()
            if row is None:
                row = Holding(
                    user_id=account.user_id, account_id=account.id, symbol=p.symbol,
                    name=p.name, currency=p.currency, instrument_type=p.instrument_type,
                    quantity=p.quantity, avg_cost=p.avg_cost, source="ibkr_flex",
                )
                self.db.add(row)
            else:
                row.quantity = p.quantity
                row.avg_cost = p.avg_cost
                row.name = p.name
                row.currency = p.currency
        for h in list(self.db.query(Holding).filter_by(account_id=account.id, source="ibkr_flex").all()):
            if (h.symbol, h.instrument_type) not in seen and h.instrument_type != "cash":
                self.db.delete(h)

    def _upsert_cash(self, account: Account, cash) -> None:
        seen = set()
        for c in cash:
            seen.add(c.currency)
            row = self.db.query(Holding).filter_by(
                account_id=account.id, symbol=c.currency, instrument_type="cash"
            ).one_or_none()
            if row is None:
                row = Holding(
                    user_id=account.user_id, account_id=account.id, symbol=c.currency,
                    name=f"Cash ({c.currency})", currency=c.currency,
                    instrument_type="cash", quantity=c.balance, source="ibkr_flex",
                )
                self.db.add(row)
            else:
                row.quantity = c.balance
        for h in self.db.query(Holding).filter_by(account_id=account.id, source="ibkr_flex", instrument_type="cash").all():
            if h.symbol not in seen:
                self.db.delete(h)

    def _upsert_trades(self, account: Account, trades) -> None:
        existing = {
            t.external_id for t in
            self.db.query(BrokerTrade.external_id).filter_by(account_id=account.id).all()
        }
        for t in trades:
            if t.external_id in existing:
                continue
            self.db.add(BrokerTrade(
                account_id=account.id, symbol=t.symbol, trade_date=t.trade_date,
                side=t.side, quantity=t.quantity, price=t.price,
                currency=t.currency, external_id=t.external_id,
            ))
