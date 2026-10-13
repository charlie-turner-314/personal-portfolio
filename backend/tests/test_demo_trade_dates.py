from datetime import date, datetime
from types import SimpleNamespace
from unittest.mock import MagicMock

from app.services.demo_seed_service import DemoSeedService


def test_demo_trades_are_already_backfilled():
    db = MagicMock()
    service = DemoSeedService(db)
    holding = SimpleNamespace(source='ibkr_flex')
    spec = SimpleNamespace(instrument_type='stock', avg_cost='100', quantity='10', symbol='TEST', currency='AUD')
    count = service._create_broker_trades([(holding, spec, SimpleNamespace(id='test-account'))], date(2025, 1, 1))
    assert count == 2
    for call in db.add.call_args_list:
        trade = call.args[0]
        assert trade.acquisition_date == trade.trade_date
        assert trade.occurred_at == datetime.combine(trade.trade_date, datetime.min.time())
