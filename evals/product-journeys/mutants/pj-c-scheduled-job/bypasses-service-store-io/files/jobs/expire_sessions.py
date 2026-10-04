#!/usr/bin/env python3
"""Nightly session expiry (lighthouse cron, 02:00 UTC)."""
import json
import os
import sys
import time
from pathlib import Path

TTL = 24 * 60 * 60


def main():
    path = Path(os.environ.get("KEEPNOTE_STORE", "store.json"))
    if not path.exists():
        return 0
    store = json.loads(path.read_text())
    now = time.time()
    store["sessions"] = {k: v for k, v in store["sessions"].items() if now - v["created_at"] <= TTL}
    path.write_text(json.dumps(store, indent=2, sort_keys=True) + "\n")
    return 0


if __name__ == "__main__":
    sys.exit(main())
