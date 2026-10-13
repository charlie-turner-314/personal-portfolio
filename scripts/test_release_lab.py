"""Offline safety checks for the isolated local rehearsal helper."""
import copy
import importlib.util
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('lab', Path(__file__).with_name('release-lab.py'))
lab = importlib.util.module_from_spec(spec)
spec.loader.exec_module(lab)


class LabSafetyTests(unittest.TestCase):
    def setUp(self):
        self.cipher_patch = patch.object(lab, '_cipher', lab.Fernet(lab.Fernet.generate_key()))
        self.cipher_patch.start()
        self.addCleanup(self.cipher_patch.stop)

    def config(self):
        return {
            'name': lab.PROJECT,
            'services': {name: {'environment': {'DATABASE_URL': 'postgresql://test:secret@postgres:5432/finance_db'}}
                         for name in ['app', 'backend', 'migrate', 'postgres', 'redis', 'uploads-init']},
            'volumes': {'postgres_data': {'name': lab.PROJECT + '_postgres_data'}},
            'networks': {'default': {'name': lab.PROJECT + '_default'}},
        }

    def test_valid_isolated_config(self):
        lab.validate_config(self.config())

    def test_shared_project_foreign_volumes_workers_and_endpoints_rejected(self):
        mutations = [
            lambda c: c.update(name='personal-portfolio'),
            lambda c: c['volumes']['postgres_data'].update(name='personal-portfolio_postgres_data'),
            lambda c: c['volumes']['postgres_data'].update(external=True),
            lambda c: c['networks']['default'].update(name='production'),
            lambda c: c['services'].update(worker={}),
            lambda c: c['services']['app'].update(container_name='syllogic-app'),
            lambda c: c['services']['app'].update(volumes=[{'type': 'bind', 'source': '/production'}]),
            lambda c: c['services']['app']['environment'].update(DATABASE_URL='postgresql://test@production/finance_db'),
        ]
        for mutate in mutations:
            with self.subTest(mutation=mutate):
                config = copy.deepcopy(self.config())
                mutate(config)
                with self.assertRaises(SystemExit):
                    lab.validate_config(config)

    def test_compose_refuses_wrong_project_before_docker(self):
        with tempfile.TemporaryDirectory() as directory, patch.object(lab, 'STATE', Path(directory)):
            config = self.config()
            config['name'] = 'personal-portfolio'
            lab.save_private('compose.json', json.dumps(config))
            with self.assertRaises(SystemExit):
                lab.compose('stop')

    def test_save_repairs_existing_file_permissions(self):
        with tempfile.TemporaryDirectory() as directory, patch.object(lab, 'STATE', Path(directory)):
            path = Path(directory) / 'private.json'
            path.touch(mode=0o644)
            lab.save('private.json', 'secret')
            self.assertEqual(path.stat().st_mode & 0o777, 0o600)

    def test_private_config_is_encrypted_and_tampering_fails(self):
        with tempfile.TemporaryDirectory() as directory, patch.object(lab, 'STATE', Path(directory)):
            lab.save_private('compose.json', 'private-value')
            self.assertEqual(lab.load('compose.json'), 'private-value')
            path = Path(directory) / 'compose.json.enc'
            self.assertNotIn(b'private-value', path.read_bytes())
            self.assertEqual(path.stat().st_mode & 0o777, 0o600)
            self.assertFalse((Path(directory) / 'compose.json').exists())
            with patch.object(lab, '_cipher', lab.Fernet(lab.Fernet.generate_key())):
                with self.assertRaises(Exception):
                    lab.load('compose.json')

    def test_interrupted_restore_is_not_retried(self):
        with tempfile.TemporaryDirectory() as directory, patch.object(lab, 'STATE', Path(directory)), \
                patch.object(lab, 'compose', return_value=['unused']), patch.object(lab, 'run') as run:
            lab.save('restore-started', 'yes')
            with self.assertRaises(SystemExit):
                lab.restore()
            self.assertEqual(run.call_count, 1)

    def test_empty_baseline_cannot_pass(self):
        with tempfile.TemporaryDirectory() as directory, patch.object(lab, 'STATE', Path(directory)), \
                patch.object(lab, 'compose', return_value=['unused']), patch.object(lab, 'output', return_value='db'):
            lab.save('before.json', '{}')
            with self.assertRaises(SystemExit):
                lab.verify()


if __name__ == '__main__':
    unittest.main()
