# Real producer/consumer coordination fixture

Use separate disposable repositories containing `api/` and `client/`. Both have
an honest, dependency-free `npm test` suite and a working HTTP relationship.
The client is an API consumer, not a documentation-only repository.

Parent task: rename the arithmetic API's `POST /add` endpoint to `POST /sum`,
remove the old endpoint, and update the client to call the new endpoint. Preserve
the response shape, exported server/client functions, validation and error
handling; update each declared suite to the new contract.

Before launch, run both suites and:

```sh
node evals/coordination-fixtures/verify-pair.mjs API_CHECKOUT CLIENT_CHECKOUT /add
```

Keep `verify-pair.mjs` outside both repositories. After API and client changes,
check out the exact API anchor and exact client commit into separate directories,
run their declared suites, then run the same command with `/sum`. It exercises
actual HTTP, positive and fractional/negative operands, the renamed endpoint,
and refusal of the removed endpoint. Record both commit hashes and outputs.

Ship's built-in coordination check remains a static compatibility scan. The
external pair test is additional evidence and must not be described as execution
performed by that scan. An uncertain verdict remains uncertain until resolved
through the product's normal decision path. No automatic merge is implied by
this fixture; retain each approval and its evidence.

Fixture self-check: the original pair passes `/add` and fails `/sum`; changing
only the API to `/sum` still fails; changing the matching client path as well
passes `/sum`. These are grader sensitivity controls, not a live Ship receipt.
