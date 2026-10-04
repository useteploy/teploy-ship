# Independent HTTP client

Ship works without Akiroo. `examples/http-client.mjs` is a dependency-free Node
22 example using the same external HTTP surfaces as the dashboard. It imports
no Ship runtime, store, or Akiroo code. First add the repository in Ship’s Projects
page with its test command and intended authority; an allowlisted forge alone
does not create a connected project. Supply your Ship origin and bearer token
through your own secret handling; never commit tokens or put them in URLs.

```js
import { randomUUID } from 'node:crypto';
import { ShipClient } from './examples/http-client.mjs';
const ship = new ShipClient(process.env.SHIP_URL, process.env.SHIP_WEB_TOKEN);
const requestId = randomUUID(); // persist before submission
const id = await ship.create({
  task: 'Explain the request validation path, with file citations.',
  repo: 'https://github.com/your-org/your-repo', journey: 'investigate', requestId,
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

## Verifying webhook events

Ship's run webhook (`SHIP_NOTIFY_URL`) is signed as before:
`X-Teploy-Signature: sha256=hex(HMAC-SHA256(secret, timestamp + "." + body))`.
That is unchanged and is all a receiver needs. Delivery is at-least-once, so a
receiver should also dedupe on `X-Teploy-Delivery`.

If the operator sets `SHIP_EVENT_ENVELOPE=on` (default off) and a
`SHIP_NOTIFY_SECRET`, each delivery that carries an `event_seq` also gets two
additive headers; the body and every existing header stay byte-identical:

- `X-Teploy-Event`: a JSON envelope (`eventId`, `schemaVersion`, `type`,
  `cursor`, `occurredAt`, `data`). `eventId` equals `X-Teploy-Delivery`, `cursor`
  is `event_seq`, and `data.payloadSha256` is the SHA-256 of the exact body.
- `X-Teploy-Event-Signature`: `sha256=hex(HMAC-SHA256(secret, X-Teploy-Timestamp + "." + <the X-Teploy-Event value>))`.

`verifyEvent` and `EventDedupe` in `examples/http-client.mjs` check all of that
(signature, a 5 minute replay window, schema major, body binding) and report a
retried delivery as `duplicate: true`, which you acknowledge without acting on:

```js
import { EventDedupe, verifyEvent } from './examples/http-client.mjs';
const dedupe = new EventDedupe();
// `raw` is the unparsed request body string; headers are lower-cased (node:http)
const r = verifyEvent(req.headers, raw, process.env.SHIP_NOTIFY_SECRET, { dedupe });
if (!r.ok) return reply(401, r.reason);          // never act on an unverified event
if (r.duplicate) return reply(200, 'duplicate'); // already handled
handle(JSON.parse(raw), r.event.cursor);
```

Verify against the raw bytes, not a re-serialised body. Keep the dedupe set
durable if your receiver restarts. Run webhooks carry no `requestId`: a run
notification is not the answer to one of your calls.
