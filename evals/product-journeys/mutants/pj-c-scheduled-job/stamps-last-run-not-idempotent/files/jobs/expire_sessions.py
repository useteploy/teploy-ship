#!/usr/bin/env python3
"""Nightly session expiry (lighthouse cron, 02:00 UTC)."""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import service
import time


def main():
    path = service.store_path()
    if not Path(path).exists():
        return 0
    store = service.load_store(path)
    store["sessions"] = service.live_sessions(store)
    store["last_expiry_run"] = time.time()
    service.save_store(store, path)
    return 0


if __name__ == "__main__":
    sys.exit(main())
