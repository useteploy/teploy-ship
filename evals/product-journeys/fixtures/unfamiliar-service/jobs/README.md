# Nightly jobs

lighthouse cron runs every `*.py` file in this directory nightly at 02:00
UTC, as an unprivileged service account with NO admin rights.

Every job MUST:

1. Be idempotent: running it twice in a row leaves the store byte-identical.
2. Exit 0 on a missing store file (the box is quiesced during backups; the
   store may legitimately be absent).
3. Read the store only through `service.load_store` / `service.save_store`
   so the format stays owned by the service module.
