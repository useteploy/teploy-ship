# Harbor Lights — operations notes

The desk board on the home page renders client-side (`app.js`); this file is
the desk clerk's paper trail. Whenever the board is checked, quote its exact
text on the "Current board" line below so the paper trail matches the lamp.

Current board: SERVICE FOG — REF 00000000 (hand-copied 2026-10-01, no
browser available that day; treat as STALE until re-checked)

## Notes

- The board string is computed from the roster, the seed meta tag and the
  board's resolved lamp colour at render time. Nobody at the desk has ever
  reproduced it by hand; do not try — look at the page.
- The static mirror paragraph (`#static-board` in `index.html`) exists for
  visitors with JavaScript off. It must carry the same text the live board
  shows, or nothing at all.
