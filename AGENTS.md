# Working on teploy-ship

Instructions for coding agents. `CLAUDE.md` carries the detail on how this
codebase is built and tested; this file carries the one rule that is easy to get
wrong because it is about a repository other than this one.

## Which layer owns a defect

Ship runs on Neutron: `@neutron-build/agents`, `@neutron-build/ai` and
`@neutron-build/workflow`, plus Nucleus as its store over pgwire
(`src/nucleus-pgwire.ts`). Three layers, and a fault found here often belongs to
one of the lower two.

**Fix a defect in the repository that owns it.**

- A wrong prompt, a bad step sequence, a route that 500s, a missing gate — ours.
- A store that answers a correct query wrongly, a wire layer that loses framing,
  an SDK that drops a field — **upstream**, in Neutron or Nucleus. Not here.

Where you can only work around it from this side — and often you can, because a
run must not fail while an upstream fix is written — the workaround ships **with
a logged report**, not instead of one. A workaround with no report is how an
upstream bug gets paid for twice: once by the person who hit it, and again by
the next person, who has no way to know it was ever diagnosed.

The vendored `deploy/vendor/*.tgz` tarballs are a build input, not a place to
fix anything. Editing one produces a binary nobody else can reproduce.

**Never cut a Neutron or Nucleus release from a Teploy session.** An upstream
fix is a standalone change in the upstream repo plus a written handover. A
release tagged from here has been withdrawn before.

In Tyler's own checkout the log is `Teploy/_internal/UPSTREAM_BUGS.md`
(append-only, template in the file; that directory is private and is not part of
this repository). Working from a clone without it, report upstream directly and
say in the commit message that you did.

## Before you finish

`pnpm run lint`, `pnpm test`, and — if you touched `web/` — `cd web && pnpm test`
**and** `cd web && pnpm run build`. That last one has broken silently before: the
web test suite covers behaviour, and the break was in the browser bundle.
