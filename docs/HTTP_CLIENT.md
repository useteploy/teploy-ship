# Independent HTTP client

Ship works without Akiroo. `examples/http-client.mjs` is a dependency-free Node
22 example using the same external HTTP surfaces as the dashboard. It imports
no Ship runtime, store, or Akiroo code. Supply your Ship origin and bearer token
through your own secret handling; never commit tokens or put them in URLs.

```js
import { randomUUID } from 'node:crypto';
import { ShipClient } from './examples/http-client.mjs';
const ship = new ShipClient(process.env.SHIP_URL, process.env.SHIP_WEB_TOKEN);
const requestId = randomUUID(); // persist before submission
const id = await ship.create({
  task: 'Explain the request validation path, with file citations.',
  repo: 'https://github.com/your-org/your-repo', journey: 'question', requestId,
});
console.log(await ship.workspace(id));
```

The workspace response exposes current metadata, conversation, verification,
artifacts and recorded activity. Poll it with a bounded deadline and backoff.
`waiting` requires inspecting its current `meta.eventName` and evidence. Present
that evidence to the person authorized to decide, then submit their exact choice:

```js
await ship.decide(id, {
  eventName: reviewedEventName, approved: ownerApproved, reason: ownerReason,
  // answer: ownerAnswer, // for a question
  // plan: ownerEditedPlan, // for a plan decision
});
```

Never automatically approve an unfamiliar waiting event. `401` means credentials
are missing/invalid; `403` means the actor lacks authority; `409` means a decision
is stale or no longer applicable. A 409 is not successful approval: refresh the
workspace and require a new review. Ship rechecks authority and the current park.
A revoked credential must not be replaced with a more privileged one automatically.

`cancel(id)` requests cancellation and reads back the workspace; `cancelling` is
not terminal. Continue polling until the executor settles. `followUp(id, ... )`
starts linked work; pass a persisted requestId and choose `target: 'pr'` only when
you intend to continue an existing PR. Include the reviewed eventName when the
current review requires it. Follow-ups retain normal policy and verification.

The create/follow-up form endpoints return redirects; this client parses those
without following them or forwarding a bearer token elsewhere. Persist requestId
and the exact submitted fields. After a lost response, replay only that same
creation request; changing its fields under the same ID is refused. Decisions and
cancellation have no automatic retries: first read authoritative state, since a
lost response can hide an accepted action. Failures must remain visible.

These are the current dashboard-compatible interfaces, not a versioned general
SDK. Raw durable storage is deliberately absent. Workspace activity is the
recorded view, not an event-stream subscription. Contract tests do not prove a
particular live provider/forge configuration; installation and live lifecycle
receipts are separate acceptance evidence.
