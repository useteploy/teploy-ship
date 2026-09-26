# Arithmetic client fixture

Node 22+, no dependencies. `npm test` verifies the client request contract and
error handling. `calculate(baseURL, a, b)` calls the API's `POST /add`, returning
the numeric `result`. The optional fourth argument is an injected fetch function.
Keep the export and arguments stable when updating to a renamed API endpoint.
