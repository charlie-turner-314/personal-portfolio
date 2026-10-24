"""Run in an ephemeral privacy-test container against its disposable database."""
import os
import subprocess
import sys
from pathlib import Path
import tempfile
import re

assert os.environ.get('HOUSEHOLD_TEST_ISOLATED') == 'yes'
assert '/household_privacy_test_' in os.environ['DATABASE_URL']
root = Path(__file__).resolve().parent
libraries = Path(tempfile.mkdtemp(prefix='household-test-dependencies-'))
installed = subprocess.run([sys.executable, '-m', 'pip', 'install', '--quiet', '--target', str(libraries), 'pytest', 'pytest-asyncio'], capture_output=True)
if installed.returncode:
    diagnostic = installed.stderr.decode(errors='replace')
    diagnostic = re.sub(r'https?://\S+', '[redacted URL]', diagnostic)
    print(diagnostic[-1500:], flush=True)
    raise RuntimeError('Unable to install test dependencies in the ephemeral container')
sys.path.insert(0, str(libraries))
import pytest

files = [
    'test_household_auth.py', 'test_mcp_composite_auth.py', 'test_mcp_bulk_update.py',
    'test_mcp_update_category.py', 'test_mcp_accounts_asset_class.py', 'test_people_filter.py',
    'test_mcp_investments_tools.py', 'test_mcp_broker_trade_import.py', 'test_broker_trade_service.py',
    'test_multi_account_csv.py', 'test_transaction_import.py', 'test_tax_report_service.py',
    'test_report_data_service.py', 'test_report_service.py', 'test_bank_connectivity_fixes.py', 'test_up_adapter.py', 'test_up_sync.py', 'test_investments_routes.py',
    'test_pocket_account_routes.py', 'services/test_account_ownership_allocation_service.py',
]
raise SystemExit(pytest.main(['-q', '--tb=short', '-p', 'no:cacheprovider', *[str(root / 'regression-tests' / file) for file in files]]))
