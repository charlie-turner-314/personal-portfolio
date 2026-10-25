import importlib.util
import json
import threading
import unittest
import urllib.request
import urllib.error
from http.server import ThreadingHTTPServer
from pathlib import Path
from unittest.mock import patch, MagicMock

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

    def test_native_chat_is_local_nonstreaming_and_bounded(self):
        response=MagicMock();response.__enter__.return_value.read.return_value=json.dumps({'done':True,'message':{'content':'0|Food|90'}}).encode()
        real_urlopen=urllib.request.urlopen
        def route(request, **kwargs):
            return real_urlopen(request, **kwargs) if getattr(request, "full_url", request).startswith(self.url) else response
        with patch.object(gateway,'local_models',return_value=[{'name':'qwen3:8b'}]), patch.object(gateway.urllib.request,'urlopen',side_effect=route) as upstream:
            status,_=self.call('/api/chat','synthetic-test-token',{'model':'qwen3:8b','stream':True,'think':True,'messages':[],'options':{'num_ctx':8192,'num_predict':150}})
            self.assertEqual(status,200)
            request=upstream.call_args.args[0];payload=json.loads(request.data)
            self.assertEqual(request.full_url,gateway.UPSTREAM+'/api/chat')
            self.assertFalse(payload['stream']);self.assertFalse(payload['think'])
            self.assertEqual(payload['options']['num_ctx'],8192)
            self.assertEqual(self.call('/api/chat','synthetic-test-token',{'model':'qwen3:8b','options':{'num_ctx':999999}})[0],400)
            self.assertEqual(self.call('/api/chat','synthetic-test-token',{'model':'remote:cloud'})[0],400)

    def test_identity_routes_exclude_modelfile_and_administrative_operations(self):
        response=MagicMock();response.__enter__.return_value.read.return_value=json.dumps({'version':'test','template':'prompt template','parameters':'defaults','modelfile':'private path'}).encode()
        real_urlopen=urllib.request.urlopen
        def route(request, **kwargs):
            return real_urlopen(request, **kwargs) if getattr(request, "full_url", request).startswith(self.url) else response
        with patch.object(gateway,'local_models',return_value=[{'name':'qwen3:8b'}]), patch.object(gateway.urllib.request,'urlopen',side_effect=route) as upstream:
            self.assertEqual(self.call('/api/version','synthetic-test-token')[1],{'version':'test'})
            status,data=self.call('/api/show','synthetic-test-token',{'model':'qwen3:8b','extra':'ignored'})
            self.assertEqual(status,200);self.assertEqual(data['template'],'prompt template');self.assertNotIn('modelfile',data)
            self.assertEqual(json.loads(upstream.call_args.args[0].data),{'model':'qwen3:8b'})
            for path in ['/api/pull','/api/delete','/api/create','/api/copy']:
                self.assertEqual(self.call(path,'synthetic-test-token',{'model':'qwen3:8b'})[0],404)
            self.assertEqual(self.call('/api/show','wrong-token',{'model':'qwen3:8b'})[0],403)

if __name__ == '__main__': unittest.main()
