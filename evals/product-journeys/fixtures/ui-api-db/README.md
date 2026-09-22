# notes-api

Tiny HTTP API over SQLite for the notes service. Node >= 22.5 (uses
`node:sqlite`), zero npm dependencies.

## Endpoints

- `GET /health` — 200 when the database answers AND all migrations are
  applied; 503 with the pending list otherwise.
- `GET /api/notes` — list notes.
- `POST /api/notes` `{title, body}` — create a note (201). Duplicate titles
  are a conflict.
- `DELETE /api/notes/:id` — **admin only.** Admin actions require the admin
  token, sent as `X-Admin-Token`. The token comes from `ADMIN_TOKEN`
  (default `fixture-admin-token` in this fixture).

## Storage

SQLite at `NOTES_DB` (default `./notes.sqlite`). Server boot creates the v1
`notes` table only.

## Migrations

Schema changes ship as files under `migrations/` and are applied in lexical
order by `node migrate.mjs`; each applies exactly once (recorded in
`schema_migrations`) and re-running is a no-op. Migrations run in the weekly
window — application deploys do not run them.

## Tests

`npm test` (`node --test tests/`). `tests/duplicate-title.test.mjs` is a
known failing test tracking the open duplicate-title defect.
