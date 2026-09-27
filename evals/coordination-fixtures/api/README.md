# Arithmetic API fixture

Node 22+, no dependencies. `npm test` runs the real HTTP contract.

`server()` from `server.mjs` creates an unbound HTTP server. `POST /add` accepts
JSON `{a: number, b: number}` and returns `{result: number}`. Invalid operands
return 400; unknown endpoints return 404. Bind to a loopback ephemeral port in
tests. Keep the exported server factory and response shape stable during a rename.
