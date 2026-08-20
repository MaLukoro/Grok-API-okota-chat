"""Local preview + /v1 proxy (stdlib only). iOS本番では使わない。"""

from __future__ import annotations

import json
import os
import socket
from http.client import HTTPSConnection
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

ROOT = Path(__file__).resolve().parent
HOST = os.environ.get("HOST", "0.0.0.0")
PORT = int(os.environ.get("PORT", "8765"))


def lan_ip() -> str:
    try:
        s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        s.connect(("8.8.8.8", 80))
        ip = s.getsockname()[0]
        s.close()
        return ip
    except OSError:
        return "127.0.0.1"


class Handler(SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(ROOT), **kwargs)

    def log_message(self, fmt: str, *args) -> None:
        print("[preview]", self.address_string(), "-", fmt % args)

    def end_headers(self) -> None:
        self.send_header("Cache-Control", "no-store")
        super().end_headers()

    def do_OPTIONS(self) -> None:
        if self.path.startswith("/v1") or self.path.startswith("/mgmt"):
            self.send_response(204)
            self.send_header("Access-Control-Allow-Origin", "*")
            self.send_header("Access-Control-Allow-Headers", "Authorization,Content-Type")
            self.send_header("Access-Control-Allow-Methods", "GET,POST,OPTIONS")
            self.end_headers()
            return
        self.send_error(404)

    def do_GET(self) -> None:
        if self.path.startswith("/v1"):
            self._proxy("api.x.ai")
            return
        if self.path.startswith("/mgmt"):
            self._proxy("management-api.x.ai", strip_prefix="/mgmt")
            return
        super().do_GET()

    def do_POST(self) -> None:
        if self.path.startswith("/v1"):
            self._proxy("api.x.ai")
            return
        if self.path.startswith("/mgmt"):
            self._proxy("management-api.x.ai", strip_prefix="/mgmt")
            return
        self.send_error(404)

    def _proxy(self, host: str, strip_prefix: str = "") -> None:
        length = int(self.headers.get("Content-Length") or 0)
        body = self.rfile.read(length) if length else None
        headers = {}
        for key in ("Authorization", "Content-Type", "Accept"):
            val = self.headers.get(key)
            if val:
                headers[key] = val
        path = self.path
        if strip_prefix and path.startswith(strip_prefix):
            path = path[len(strip_prefix) :] or "/"
            if not path.startswith("/"):
                path = "/" + path
        conn = HTTPSConnection(host, timeout=300)
        try:
            conn.request(self.command, path, body=body, headers=headers)
            resp = conn.getresponse()
            self.send_response(resp.status)
            ct = resp.getheader("Content-Type") or "application/octet-stream"
            self.send_header("Content-Type", ct)
            self.send_header("Access-Control-Allow-Origin", "*")
            self.send_header("Cache-Control", "no-store")
            self.end_headers()
            while True:
                chunk = resp.read(4096)
                if not chunk:
                    break
                self.wfile.write(chunk)
                self.wfile.flush()
        except Exception as e:
            if not self.wfile.closed and not getattr(self, "_headers_buffer", None):
                try:
                    msg = json.dumps({"error": {"message": str(e)}}).encode()
                    self.send_response(502)
                    self.send_header("Content-Type", "application/json")
                    self.send_header("Access-Control-Allow-Origin", "*")
                    self.send_header("Content-Length", str(len(msg)))
                    self.end_headers()
                    self.wfile.write(msg)
                except Exception:
                    pass
        finally:
            conn.close()


def main() -> None:
    httpd = ThreadingHTTPServer((HOST, PORT), Handler)
    ip = lan_ip()
    print(f"Grok Kotatsu preview")
    print(f"  PC     http://127.0.0.1:{PORT}/")
    print(f"  iPhone http://{ip}:{PORT}/")
    print("Ctrl+C to stop")
    httpd.serve_forever()


if __name__ == "__main__":
    main()
