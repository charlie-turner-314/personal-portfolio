"""Coverage warnings are separate from arithmetic over recorded allocations."""
from datetime import datetime, time

from app.models import BrokerTrade, BrokerConnection, Holding, InvestmentActivity, InvestmentCryptoTransfer, InvestmentIncomeEvent, InvestmentIngestionRun, InvestmentReconciliationItem


def investment_report_warnings(db, user_id, start, end, scope, account_id=None):
    accounts = [key for key in scope.accounts if account_id is None or key == account_id]
    warnings = []
    pending = db.query(InvestmentReconciliationItem, InvestmentActivity.occurred_at).join(
        InvestmentActivity, InvestmentActivity.id == InvestmentReconciliationItem.source_activity_id
    ).filter(InvestmentReconciliationItem.account_id.in_(accounts), InvestmentReconciliationItem.status == "pending", InvestmentActivity.occurred_at >= datetime.combine(start, time.min), InvestmentActivity.occurred_at < datetime.combine(end, time.min)).all()
    count = sum(scope.share(item.account_id, occurred.date()) > 0 for item, occurred in pending)
    if count:
        warnings.append(f"{count} investment reconciliation item(s) remain unresolved.")
    transfers = db.query(InvestmentCryptoTransfer).filter(InvestmentCryptoTransfer.account_id.in_(accounts), InvestmentCryptoTransfer.status.in_(["pending", "ambiguous"]), InvestmentCryptoTransfer.occurred_at >= datetime.combine(start, time.min), InvestmentCryptoTransfer.occurred_at < datetime.combine(end, time.min)).all()
    count = sum(scope.share(item.account_id, item.occurred_at.date()) > 0 for item in transfers)
    if count:
        warnings.append(f"{count} crypto transfer(s) have not been confirmed as owned-wallet transfers.")
    income = db.query(InvestmentIncomeEvent).filter(InvestmentIncomeEvent.account_id.in_(accounts), InvestmentIncomeEvent.valuation_missing.is_(True), InvestmentIncomeEvent.pay_date >= start, InvestmentIncomeEvent.pay_date < end).all()
    count = sum(scope.share(item.account_id, item.pay_date) > 0 for item in income)
    if count:
        warnings.append(f"{count} income event(s) lack an AUD valuation.")
    connections = db.query(BrokerConnection).filter(BrokerConnection.account_id.in_(accounts)).all()
    if any(item.last_sync_status in {"partial", "error", "needs_reauth"} or (item.health_details or {}).get("missing_product_warnings") for item in connections):
        warnings.append("Some connected provider history is incomplete or requires attention.")
    if db.query(InvestmentIngestionRun.id).filter(InvestmentIngestionRun.account_id.in_(accounts), InvestmentIngestionRun.status == "partial").first():
        warnings.append("Partial import batches exist. Review skipped or unsupported activities in import history.")
    missing_trades = db.query(BrokerTrade).filter(BrokerTrade.account_id.in_(accounts), BrokerTrade.valuation_missing.is_(True), BrokerTrade.trade_date >= start, BrokerTrade.trade_date < end).all()
    if any(scope.share(item.account_id, item.trade_date) > 0 for item in missing_trades):
        warnings.append("Recorded trades have missing fee or valuation inputs; complete the source data before using tax totals.")
    if db.query(Holding.id).filter(Holding.account_id.in_(accounts), Holding.quantity < 0).first():
        warnings.append("Short positions require a dedicated tax workflow; the current allocation engine is long-only FIFO.")
    positions = db.query(Holding).filter(Holding.account_id.in_(accounts), Holding.source == "manual", Holding.quantity > 0).all()
    if any((item.as_of_date or item.created_at.date()) < end and scope.share(item.account_id, item.as_of_date or item.created_at.date()) > 0 for item in positions):
        warnings.append("Manual opening positions do not establish a complete acquisition history.")
    archived = db.query(Holding).filter(Holding.account_id.in_(accounts), Holding.archived_at.is_not(None), Holding.quantity > 0).all()
    if any(item.archived_at.date() < end and scope.share(item.account_id, item.archived_at.date()) > 0 for item in archived):
        warnings.append("Archived positions have remaining units. Archiving is not a disposal; verify the source ledger.")
    return warnings
