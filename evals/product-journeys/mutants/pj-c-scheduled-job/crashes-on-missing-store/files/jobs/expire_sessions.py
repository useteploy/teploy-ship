#!/usr/bin/env python3
"""Nightly session expiry (lighthouse cron, 02:00 UTC)."""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import service


def main():
    path = service.store_path()
    open(path).close()  # raises FileNotFoundError when the box is quiesced
    store = service.load_store(path)
    service.save_store({**store, "sessions": service.live_sessions(store)}, path)
    return 0


if __name__ == "__main__":
    sys.exit(main())
