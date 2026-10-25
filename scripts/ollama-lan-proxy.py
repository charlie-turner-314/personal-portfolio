#!/usr/bin/env python3
"""Private, token-authenticated gateway to localhost Ollama; no request logging.

Run with a mode-600 JSON config containing listen_host, listen_port,
allowed_clients (IP addresses), and token. Only local models and the required
Portfolio chat/identity operations are exposed. Never point this at an internet port forward.
"""
import argparse
import hmac
import ipaddress
import json
import threading
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

UPSTREAM = 'http://127.0.0.1:11434'
MAX_BODY = 1024 * 1024


def local_models():
    with urllib.request.urlopen(UPSTREAM + '/api/tags', timeout=10) as response:
        data = json.load(response)
    return [m for m in data['models'] if not m.get('remote_host') and not m.get('remote_model') and not m['name'].endswith(':cloud')]


def handler(config):
    slots = threading.BoundedSemaphore(1)

    class Handler(BaseHTTPRequestHandler):
        def setup(self):
            super().setup()
            self.connection.settimeout(15)

        def log_message(self, *_):
            pass

        def reply(self, status, data):
            body = json.dumps(data).encode()
            self.send_response(status)
            self.send_header('Content-Type', 'application/json')
            self.send_header('Content-Length', str(len(body)))
            self.end_headers()
            self.wfile.write(body)

        def authorized(self):
            return (self.client_address[0] in config['allowed_clients'] and
                    hmac.compare_digest(self.headers.get('Authorization', ''), 'Bearer ' + config['token']))

        def do_GET(self):
            if not self.authorized():
                self.reply(403, {'error': 'Forbidden'}); return
            if self.path not in ('/api/tags', '/api/version'):
                self.reply(404, {'error': 'Not found'}); return
            try:
                if self.path == '/api/tags':
                    self.reply(200, {'models': local_models()})
                else:
                    with urllib.request.urlopen(UPSTREAM + '/api/version', timeout=10) as response:
                        self.reply(200, {'version': json.load(response)['version']})
            except Exception:
                self.reply(503, {'error': 'Local Ollama unavailable'})

        def do_POST(self):
            if not self.authorized():
                self.reply(403, {'error': 'Forbidden'}); return
            if self.path not in ('/v1/chat/completions', '/api/chat', '/api/show'):
                self.reply(404, {'error': 'Not found'}); return
            if not slots.acquire(blocking=False):
                self.reply(429, {'error': 'Local model is busy. Retry later.'}); return
            try:
                length = int(self.headers.get('Content-Length', '0'))
                if not 0 < length <= MAX_BODY or self.headers.get('Transfer-Encoding'):
                    self.reply(400, {'error': 'Invalid request size'}); return
                payload = json.loads(self.rfile.read(length))
                if payload.get('model') not in {m['name'] for m in local_models()}:
                    self.reply(400, {'error': 'Select an installed local model'}); return
                if self.path == '/api/show':
                    payload = {'model': payload['model']}
                else:
                    payload['stream'] = False
                    if self.path == '/api/chat':
                        payload['think'] = False
                        options = payload.setdefault('options', {})
                        if not isinstance(options, dict):
                            raise ValueError('Invalid options')
                        context, predict = options.get('num_ctx', 8192), options.get('num_predict', 150)
                        if type(context) is not int or not 512 <= context <= 32768 or type(predict) is not int or not 1 <= predict <= 4096:
                            raise ValueError('Invalid generation bounds')
                        options['num_ctx'], options['num_predict'] = context, predict
                    else:
                        payload['reasoning_effort'] = 'none'
                request = urllib.request.Request(UPSTREAM + self.path, data=json.dumps(payload).encode(), headers={'Content-Type': 'application/json'})
                with urllib.request.urlopen(request, timeout=185) as response:
                    result = json.load(response)
                if self.path == '/api/show':
                    result = {key: result.get(key) for key in ('parameters', 'template', 'details', 'model_info')}
                self.reply(200, result)
            except (ValueError, KeyError, TypeError):
                self.reply(400, {'error': 'Invalid request'})
            except Exception:
                self.reply(503, {'error': 'Local Ollama unavailable or request failed'})
            finally:
                slots.release()

    return Handler


def main():
    parser = argparse.ArgumentParser(); parser.add_argument('config', type=Path)
    args = parser.parse_args()
    if args.config.stat().st_mode & 0o077:
        raise SystemExit('Config must be accessible only to its owner (chmod 600).')
    config = json.loads(args.config.read_text())
    if len(config.get('token', '')) < 32 or not config.get('allowed_clients'):
        raise SystemExit('A strong token and explicit client IP allowlist are required.')
    for address in config['allowed_clients']:
        ipaddress.ip_address(address)
    server = ThreadingHTTPServer((config.get('listen_host', '0.0.0.0'), config.get('listen_port', 11435)), handler(config))
    server.serve_forever()


if __name__ == '__main__':
    main()
