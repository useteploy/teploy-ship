# Akiroo delivery contract

Ship initiates collection. The pull token is workspace-scoped; forge credentials
never leave Ship. Akiroo owns the queue and the human approvals.

## Collection is not execution

Acknowledgements now carry `receipts: [{id,status,detail}]` alongside `ids`.
`succeeded` means the handler completed, not that code was merged or deployed.
`rejected` is a known refusal. `unknown` requires reconciliation: an issue or run
may already exist. Akiroo commits receipts with acknowledgements, blocks affected
assigned Work items, and raises informational Today cards. Acknowledging a card
does not retry, approve, merge or buy anything.

Ship persists receipts separately from its replay claims. A failed HTTP ack
resends the saved receipt, not the action. A processing receipt is held for ten
minutes before becoming unknown; this is an uncertainty deadline, not proof
that a slow handler stopped. Receipt initialization has its own claim fence.
A crash before that receipt exists leaves the queue row pending until the claim
expires or an operator reconciles it. Neither claim expiration nor a reconnect
may erase an existing durable outcome.

Legacy claims have no outcome evidence. A legacy transport ack remains blank in
Akiroo and must not be backfilled as success. The new receipt storage must be
included in Ship backups. Failed/unknown Akiroo queue records are excluded from
ordinary acknowledged-row pruning.

## Result delivery

Worker notifications enter the durable outbox before sending. Delivery failure
backs off to at most fifteen minutes; the former six-attempt cap no longer
deletes owed notifications. `event_seq` and `event_at` come from the recorded
workflow event; old queued notifications fall back to their saved creation time,
never the time of a retry. Sequence numbers order events within a run.

Akiroo verifies the signature and timestamp on every request, then stores a
body-hash receipt. A completed duplicate returns success without repeating its
projections. Failed run, approval, Work, scan and plan writes return an error and
leave the receipt pending. Per-workspace advisory locking serializes the
projections across replicas; a four-connection per-process cap bounds waiters.
State guards reject old events before room/approval/Work changes. Sparse updates
retain known PR/evidence fields. A reported merged PR closes standalone Work;
merge is not deployment. Revert stamping, demotion and the decision log commit
together and dedupe by project/PR.

These are recovery guarantees for received/queued events, not a distributed
exactly-once transaction. Automatic unknown-action reconciliation, repairing
historical missing notifications, a crash before notification enqueue, and
durable scheduling of optional follow-up model/email work remain separate work.
Verification still needs commit-bound evidence and independent forge-merge
reconciliation before claiming an end-to-end production proof.

## Upgrade and verify

Deploy Akiroo's additive schema and receiver **before** this Ship sender; an old
receiver ignores receipt fields. Keep existing settings and approval authority.
First managed registration refuses to erase manual verification, sandbox,
budget or never-auto settings. Reconcile them before syncing; do not blindly
publish an empty Akiroo configuration over a populated Ship project.

Use the ordinary build/test and replay-preflight gates plus a store backup.
`scripts/probe-akiroo-receipts.mjs`, after `pnpm build`, exercises receipt restart,
failed-action containment and notification retries against a disposable Nucleus
selected by `SHIP_TEST_NUCLEUS_URL` (loopback only). It invokes no model or forge.
