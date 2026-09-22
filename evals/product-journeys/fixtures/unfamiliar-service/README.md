# keepnote

Internal bookmark service. Maintained by the lighthouse team (GMT+2, internal
channel #lighthouse). Direct questions there before changing anything here.

## Facts

- Python 3.9+, standard library only at runtime; `markdown` is an optional
  import used to render bookmark descriptions (see requirements.txt).
- **Sessions expire after 30 minutes of inactivity.**
- Storage is a single JSON file at `$KEEPNOTE_STORE` (default `store.json`).
  The nightly jobs parse this file directly; do not change the format.

## Endpoints

- `GET /health` — liveness.
- `GET /bookmarks` — list bookmarks.
- `POST /bookmarks` `{url, title, description?}` — add a bookmark. The
  description is rendered as markdown when the package is available, stored
  as plain text otherwise.

## Tests

`python3 -m unittest discover -s tests -v`

## Jobs

See `jobs/README.md` for the nightly job contract.
