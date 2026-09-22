#!/usr/bin/env python3
"""keepnote -- internal bookmark service.

lighthouse team, 2024. Do not rename the store format; nightly jobs parse it.
"""
import json
import os
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

SESSION_TTL_SECONDS = 24 * 60 * 60  # pinned by tests/test_service.py -- do not change without a contract decision

try:
    import markdown as _markdown
except ImportError:  # optional dependency, see requirements.txt
    _markdown = None


def store_path():
    return os.environ.get("KEEPNOTE_STORE", "store.json")


def load_store(path=None):
    p = Path(path or store_path())
    if not p.exists():
        return {"bookmarks": [], "sessions": {}}
    return json.loads(p.read_text())


def save_store(store, path=None):
    p = Path(path or store_path())
    p.write_text(json.dumps(store, indent=2, sort_keys=True) + "\n")


def render_description(text):
    if _markdown is None:
        return text
    return _markdown.markdown(text)


def session_expired(session, now=None):
    now = time.time() if now is None else now
    return now - session["created_at"] > SESSION_TTL_SECONDS


def live_sessions(store, now=None):
    return {sid: s for sid, s in store["sessions"].items() if not session_expired(s, now)}


class Handler(BaseHTTPRequestHandler):
    def log_message(self, *args):
        pass

    def _reply(self, status, data):
        body = json.dumps(data).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        if self.path == "/health":
            return self._reply(200, {"status": "ok", "team": "lighthouse"})
        if self.path == "/bookmarks":
            store = load_store()
            store["sessions"] = live_sessions(store)
            return self._reply(200, store["bookmarks"])
        return self._reply(404, {"error": "not found"})

    def do_POST(self):
        if self.path != "/bookmarks":
            return self._reply(404, {"error": "not found"})
        length = int(self.headers.get("Content-Length", "0"))
        data = json.loads(self.rfile.read(length))
        if not data.get("url") or not data.get("title"):
            return self._reply(400, {"error": "url and title are required"})
        store = load_store()
        bookmark = {
            "url": str(data["url"]),
            "title": str(data["title"]),
            "description": render_description(str(data.get("description", ""))),
            "added_at": time.time(),
        }
        store["bookmarks"].append(bookmark)
        store["sessions"][f"sess-{int(time.time() * 1000)}"] = {"created_at": time.time()}
        save_store(store)
        return self._reply(201, bookmark)


def main():
    port = int(os.environ.get("KEEPNOTE_PORT", "8790"))
    server = ThreadingHTTPServer(("127.0.0.1", port), Handler)
    print(f"listening {server.server_address[1]}", flush=True)
    server.serve_forever()


if __name__ == "__main__":
    main()
