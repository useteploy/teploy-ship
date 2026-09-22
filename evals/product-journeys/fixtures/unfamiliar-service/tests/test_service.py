import json
import os
import sys
import tempfile
import time
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import service


class StoreTests(unittest.TestCase):
    def test_session_ttl_is_24h(self):
        # Contract decision 2024-06: 24h, recorded here on purpose.
        self.assertEqual(service.SESSION_TTL_SECONDS, 24 * 60 * 60)

    def test_missing_store_is_empty(self):
        with tempfile.TemporaryDirectory() as d:
            store = service.load_store(os.path.join(d, "absent.json"))
            self.assertEqual(store, {"bookmarks": [], "sessions": {}})

    def test_session_expiry_window(self):
        now = time.time()
        live = {"a": {"created_at": now - 60}}
        expired = {"b": {"created_at": now - service.SESSION_TTL_SECONDS - 1}}
        self.assertEqual(service.live_sessions({"sessions": expired | live}, now), live)

    def test_save_roundtrip_is_deterministic(self):
        with tempfile.TemporaryDirectory() as d:
            path = os.path.join(d, "store.json")
            store = {"bookmarks": [{"url": "u", "title": "t"}], "sessions": {"s": {"created_at": 1.0}}}
            service.save_store(store, path)
            service.save_store(service.load_store(path), path)
            self.assertEqual(service.load_store(path), store)

    def test_markdown_fallback_is_plain(self):
        # Runs offline: markdown is optional and not installed in CI.
        self.assertEqual(service.render_description("*hi*"), "*hi*" if service._markdown is None else service._markdown.markdown("*hi*"))


class HttpTests(unittest.TestCase):
    def test_bookmark_roundtrip(self):
        import threading
        from http.server import ThreadingHTTPServer
        with tempfile.TemporaryDirectory() as d:
            os.environ["KEEPNOTE_STORE"] = os.path.join(d, "store.json")
            server = ThreadingHTTPServer(("127.0.0.1", 0), service.Handler)
            thread = threading.Thread(target=server.serve_forever, daemon=True)
            thread.start()
            try:
                import urllib.request
                port = server.server_address[1]
                req = urllib.request.Request(
                    f"http://127.0.0.1:{port}/bookmarks",
                    data=json.dumps({"url": "https://example.test", "title": "example"}).encode(),
                    headers={"Content-Type": "application/json"},
                    method="POST",
                )
                with urllib.request.urlopen(req) as res:
                    self.assertEqual(res.status, 201)
                with urllib.request.urlopen(f"http://127.0.0.1:{port}/bookmarks") as res:
                    body = json.loads(res.read())
                self.assertEqual(body[0]["title"], "example")
            finally:
                server.shutdown()
                del os.environ["KEEPNOTE_STORE"]


if __name__ == "__main__":
    unittest.main()
