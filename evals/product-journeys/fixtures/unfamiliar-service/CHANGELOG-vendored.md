# markdown changelog (vendored, authoritative for this fixture)

Vendored so dependency decisions are checkable offline. This file is the
fixture universe's source of truth for upstream markdown releases.

## 4.0.0 (unreleased upstream, tracked here)

- The top-level render entrypoint `markdown.markdown(text)` is renamed to
  `markdown.render(text)`.
- The old `markdown.markdown` callable is REMOVED (not merely deprecated).
- No other breaking changes.

## 3.5.x

- Current pinned line for keepnote (`>=3.5,<4` in requirements.txt).
- lighthouse note: keepnote stays on 3.x until its `_markdown.markdown(...)`
  call site handles the 4.x rename.
