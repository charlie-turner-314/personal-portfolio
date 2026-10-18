import importlib.util
import json
import threading
import unittest
import urllib.request
import urllib.error
from http.server import ThreadingHTTPServer
from pathlib import Path
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('gateway', Path(__file__).parents[1] / 'ollama-lan-proxy.py')
gateway = importlib.util.module_from_spec(spec); spec.loader.exec_module(gateway)

class GatewayTest(unittest.TestCase):
    def setUp(self):
        self.server = ThreadingHTTPServer(('127.0.0.1', 0), gateway.handler({'allowed_clients': ['127.0.0.1'], 'token': 'synthetic-test-token'}))
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True); self.thread.start()
        self.url = 'http://127.0.0.1:' + str(self.server.server_port)

    def tearDown(self):
        self.server.shutdown(); self.server.server_close(); self.thread.join()

    def call(self, path, token='', body=None):
        request = urllib.request.Request(self.url + path, data=json.dumps(body).encode() if body is not None else None,
                                         headers={'Authorization': 'Bearer '+token})
        try:
            with urllib.request.urlopen(request, timeout=3) as response: return response.status, json.load(response)
        except urllib.error.HTTPError as error: return error.code, json.load(error)

    def test_rejects_missing_token_and_nonallowlisted_client(self):
        self.assertEqual(self.call('/api/tags')[0], 403)
        server = ThreadingHTTPServer(('127.0.0.1', 0), gateway.handler({'allowed_clients': ['192.0.2.1'], 'token': 'synthetic-test-token'}))
        thread=threading.Thread(target=server.serve_forever,daemon=True);thread.start()
        old=self.url;self.url='http://127.0.0.1:'+str(server.server_port)
        try: self.assertEqual(self.call('/api/tags','synthetic-test-token')[0],403)
        finally:self.url=old;server.shutdown();server.server_close();thread.join()

    def test_exposes_only_required_operations_and_local_models(self):
        token='synthetic-test-token'
        self.assertEqual(self.call('/api/pull',token,{'model':'anything'})[0],404)
        with patch.object(gateway,'local_models',return_value=[{'name':'qwen3:8b'}]):
            self.assertEqual(self.call('/api/tags',token)[1],{'models':[{'name':'qwen3:8b'}]})
            self.assertEqual(self.call('/v1/chat/completions',token,{'model':'remote:cloud'})[0],400)

    def test_sanitizes_upstream_failure(self):
        with patch.object(gateway,'local_models',side_effect=RuntimeError('secret diagnostic')):
            status,body=self.call('/api/tags','synthetic-test-token')
            self.assertEqual(status,503)
            self.assertNotIn('secret',json.dumps(body))

if __name__ == '__main__': unittest.main()
