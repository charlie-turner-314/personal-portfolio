"""Exercise worker startup, not incidental task imports in API/tests."""
import os
from pathlib import Path
import subprocess
import sys


def test_fresh_worker_registers_up_and_scheduled_tasks():
    # Importing up_tasks in this process would mask a missing worker include.
    result = subprocess.run(
        [sys.executable, "-c", """
from celery_app import celery_app
celery_app.loader.import_default_modules()
celery_app.finalize()
assert 'tasks.up_tasks.sync_up_connection' in celery_app.tasks
for entry in celery_app.conf.beat_schedule.values():
    assert entry['task'] in celery_app.tasks, entry['task']
assert celery_app.tasks['tasks.up_tasks.sync_up_connection'].app is celery_app
print('worker task registration verified')
"""],
        cwd=Path(__file__).resolve().parents[1],
        env=os.environ.copy(), capture_output=True, text=True, timeout=60,
    )
    assert result.returncode == 0, result.stderr
    assert 'worker task registration verified' in result.stdout
