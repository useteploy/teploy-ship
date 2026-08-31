import assert from "node:assert/strict";
import { test } from "node:test";

import {
  DEFAULT_NETWORK_TIER,
  detectEgressRefusal,
  egressEntryError,
  egressRefusalHint,
  egressRefusalNote,
  networkForTrust,
  normalizeEgressAllow,
  parseNetworkTier,
  resolveNetworkTier,
  splitEgressAllow,
  wireNetwork,
} from "./egress.js";
import { sandboxOverridesOf, sandboxProvider } from "./durable.js";
import { formatObservation } from "./prompt.js";
import { explainRun } from "./explain.js";

test("three tiers, and `egress` is the alias every old record and log is written in", () => {
  assert.equal(parseNetworkTier("none"), "none");
  assert.equal(parseNetworkTier("allowlist"), "allowlist");
  assert.equal(parseNetworkTier("open"), "open");
  assert.equal(parseNetworkTier("egress"), "allowlist", "the old spelling means the middle tier");
  assert.equal(parseNetworkTier(" EGRESS "), "allowlist");
  assert.equal(parseNetworkTier(undefined), undefined);
  assert.equal(parseNetworkTier(""), undefined);
  assert.equal(parseNetworkTier("bridge"), null, "unknown is refusable, not silently a tier");
  assert.equal(parseNetworkTier(7), null);
});

test("the allowlist tier goes on the wire as `egress`, because a daemon that has not been upgraded seals anything else", () => {
  // teploy-sandbox's Create switches on `case "egress"` and its default is
  // `--network none`. Sending "allowlist" to a daemon built before the rename
  // would seal every run Ship believed it was putting on the allowlist — on
  // the tier that is now the DEFAULT, so it would be every run.
  assert.equal(wireNetwork("allowlist"), "egress");
  assert.equal(wireNetwork("none"), "none");
  assert.equal(wireNetwork("open"), "open", "no compatible spelling exists; an old daemon seals it, which is the safe direction");
});

test("the default tier is allowlist: an unconfigured install can clone, and is still closed", () => {
  assert.equal(DEFAULT_NETWORK_TIER, "allowlist");
  // The cliff this closes: unset used to mean the DAEMON's default, which is
  // `none`, and a container with no network cannot clone — so an install where
  // nobody set SHIP_SANDBOX_NETWORK could run no repo task at all.
  assert.equal(resolveNetworkTier(undefined, undefined, undefined), "allowlist");
  assert.equal(resolveNetworkTier(undefined, "", undefined), "allowlist");
  // ...and `none` remains available, as a decision somebody made.
  assert.equal(resolveNetworkTier(undefined, "none", undefined), "none");
  assert.equal(resolveNetworkTier(undefined, undefined, "egress"), "allowlist", "an existing config file keeps working");
  assert.equal(resolveNetworkTier("open", "none", undefined), "open", "flag beats env beats config");
  assert.equal(resolveNetworkTier(undefined, "bridge", undefined), null, "set but unusable is refused, never guessed");
});

test("allowlist entries: the daemon's grammar, validated at the save", () => {
  assert.equal(egressEntryError("rubygems.org"), null);
  assert.equal(egressEntryError(".hex.pm"), null);
  assert.equal(egressEntryError("git.internal:3000"), null);
  assert.equal(egressEntryError("10.1.2.3:49152"), null);
  assert.match(String(egressEntryError("https://rubygems.org")), /not a URL/);
  assert.match(String(egressEntryError("rubygems.org/gems")), /not a URL/);
  assert.match(String(egressEntryError("*.hex.pm")), /no wildcards/);
  assert.match(String(egressEntryError("has space")), /not a host/);
  assert.match(String(egressEntryError("git.internal:99999")), /port out of range/);
  assert.equal(normalizeEgressAllow([]), undefined);
  assert.equal(normalizeEgressAllow(undefined), undefined);
  assert.throws(() => normalizeEgressAllow(new Array(65).fill(0).map((_, i) => `h${i}.example.com`)), /at most 64/);
  assert.deepEqual(splitEgressAllow("a.com, .b.com  c.com:8080"), ["a.com", ".b.com", "c.com:8080"]);
});

// ---------------------------------------------------------------------------
// THE SAFETY COUPLING
// ---------------------------------------------------------------------------

test("an externally-sourced task never runs on the open network, whatever the project record says", () => {
  // The rule itself.
  assert.deepEqual(networkForTrust("open", "external"), { network: "allowlist", downgradedFrom: "open" });
  assert.deepEqual(networkForTrust("open", "operator"), { network: "open" }, "work the operator started keeps it");
  assert.deepEqual(networkForTrust("open", undefined), { network: "open" }, "absent trust reads as operator, as everywhere else");
  assert.deepEqual(networkForTrust("allowlist", "external"), { network: "allowlist" }, "nothing else moves");
  assert.deepEqual(networkForTrust("none", "external"), { network: "none" }, "the downgrade never WIDENS a tier");
  assert.deepEqual(networkForTrust(undefined, "external"), { network: undefined }, "no declaration, nothing to downgrade");
});

test("the downgrade is enforced where the container is created, not merely at enqueue", () => {
  // sandboxOverridesOf is the single funnel every workspace creation goes
  // through (`sandbox`, `plan-restore`, `turn-N-restore`, `merge-restore`).
  // Enforcing here — not at enqueue — is what covers a run enqueued by an
  // older binary, and what keeps the operator's declared tier in the log.
  const external = { task: "t", repo: "http://forge/o/r", trust: "external", sandboxNetwork: "open" } as never;
  assert.equal(sandboxOverridesOf(external)!.network, "allowlist");

  const operator = { task: "t", repo: "http://forge/o/r", trust: "operator", sandboxNetwork: "open" } as never;
  assert.equal(sandboxOverridesOf(operator)!.network, "open");

  // A log written before three tiers existed.
  const legacy = { task: "t", repo: "http://forge/o/r", trust: "external", sandboxNetwork: "egress" } as never;
  assert.equal(sandboxOverridesOf(legacy)!.network, "allowlist", "the alias parses, and is not mistaken for `open`");

  // The run input is NOT rewritten: the record's declaration and the fact of
  // the downgrade both have to stay readable afterwards.
  assert.equal((external as { sandboxNetwork: string }).sandboxNetwork, "open");
});

test("the downgraded tier is what reaches the daemon, not the declared one", async () => {
  const bodies: Array<Record<string, unknown>> = [];
  const fetchImpl: typeof globalThis.fetch = async (_url, init) => {
    bodies.push(JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>);
    return new Response(JSON.stringify({ runId: "sbx-1", id: "sbx-1" }), { status: 200, headers: { "content-type": "application/json" } });
  };
  const provider = sandboxProvider({ baseURL: "http://sbx", token: "t", image: "node:22", network: "allowlist", fetch: fetchImpl });

  await provider.create(sandboxOverridesOf({ task: "t", trust: "external", sandboxNetwork: "open", sandboxEgressAllow: ["rubygems.org"] } as never));
  assert.equal(bodies[0]!.network, "egress", "an issue-sourced task does not get `open` on the wire");
  assert.deepEqual(bodies[0]!.egressAllow, ["rubygems.org"], "its repo's own hosts still apply");

  await provider.create(sandboxOverridesOf({ task: "t", trust: "operator", sandboxNetwork: "open" } as never));
  assert.equal(bodies[1]!.network, "open", "the operator's own run is not downgraded");

  // The restore paths a parked run takes go through the same funnel.
  await provider.createFrom!("snap:1", sandboxOverridesOf({ task: "t", trust: "external", sandboxNetwork: "open" } as never));
  assert.equal(bodies[2]!.network, "egress", "a run that parked and restored does not come back on the open network");

  // The worker-wide default, when the run recorded no tier of its own.
  await provider.create(sandboxOverridesOf({ task: "t" } as never));
  assert.equal(bodies[3]!.network, "egress", "the worker default is the allowlist tier, in its wire spelling");
});

// ---------------------------------------------------------------------------
// SURFACING A REFUSAL
// ---------------------------------------------------------------------------

test("a sandbox refusal is recognised, and nothing else is", () => {
  const denied = detectEgressRefusal("fatal: unable to access: egress denied by the sandbox allowlist: rubygems.org");
  assert.equal(denied?.host, "rubygems.org");
  assert.equal(detectEgressRefusal("Received HTTP code 403 from proxy after CONNECT")?.host, undefined, "the tooling never sees the body; the fact still lands");
  assert.notEqual(detectEgressRefusal("proxyconnect tcp: dial: 403 Forbidden"), null);

  // The narrowness is the feature: each of these is what a sealed run, a dead
  // host, a real 403 and an ordinary build break look like, and telling the
  // agent to give up on any of them would be worse than saying nothing.
  assert.equal(detectEgressRefusal("curl: (6) Could not resolve host: rubygems.org"), null);
  assert.equal(detectEgressRefusal("connect: Network is unreachable"), null);
  assert.equal(detectEgressRefusal("HTTP/1.1 403 Forbidden"), null);
  assert.equal(detectEgressRefusal("npm ERR! code ELIFECYCLE"), null);
  assert.equal(detectEgressRefusal(""), null);
  assert.equal(detectEgressRefusal(undefined), null);
});

test("the agent is told to stop retrying a blocked host, and only when a command actually failed", () => {
  const blocked = formatObservation({
    exitCode: 128,
    stdout: "",
    stderr: "fatal: unable to access 'https://rubygems.org/': egress denied by the sandbox allowlist: rubygems.org",
    timedOut: false,
    truncated: false,
  });
  assert.match(blocked, /NETWORK BLOCKED/);
  assert.match(blocked, /rubygems\.org/);
  assert.match(blocked, /Do not run it again/, "the whole point: it stops the agent burning turns on a wall");
  assert.match(blocked, /finish/, "and tells it what to do instead — hand the host to the operator");
  assert.match(blocked, /stderr:/, "the real output is still there; the hint is added, never substituted");

  const succeeded = formatObservation({
    exitCode: 0,
    stdout: "egress denied by the sandbox allowlist: rubygems.org",
    stderr: "",
    timedOut: false,
    truncated: false,
  });
  assert.doesNotMatch(succeeded, /NETWORK BLOCKED/, "a refusal that did not fail the command stopped nothing");

  const ordinary = formatObservation({ exitCode: 1, stdout: "", stderr: "make: *** [test] Error 1", timedOut: false, truncated: false });
  assert.doesNotMatch(ordinary, /NETWORK BLOCKED/);
});

test("the hint and the note name the host and the remedy", () => {
  const hint = egressRefusalHint({ host: "rubygems.org", evidence: "x" });
  assert.match(hint, /rubygems\.org/);
  const note = egressRefusalNote({ host: "rubygems.org", evidence: "x" });
  assert.match(note, /egress allowlist/);
  assert.match(note, /project set/, "the operator gets the command, not an invitation to read the logs");
  assert.match(note, /SBX_EGRESS_ALLOW/, "and the host-wide alternative, so the trade is stated");
});

test("explainRun leads with the blocked host, and says when the run was downgraded", () => {
  const at = "2026-08-30T00:00:00Z";
  const events = [
    { type: "run-started", at, data: { input: { task: "add a gem", trust: "external", sandboxNetwork: "open" } } },
    {
      type: "step-completed",
      name: "turn-0-exec",
      at,
      data: { result: { exitCode: 1, stdout: "", stderr: "egress denied by the sandbox allowlist: rubygems.org" } },
    },
    { type: "run-completed", at, data: { output: { status: "max-steps", turns: 40 } } },
  ] as never;
  const e = explainRun(events);
  assert.match(e.headline, /egress allowlist/, "not 'ran out of turns' — that is the symptom");
  assert.match(e.nextStep, /rubygems\.org/);
  assert.ok(e.evidence.some((x) => x.includes("sandbox blocked rubygems.org")), e.evidence.join(" | "));
  assert.ok(
    e.evidence.some((x) => x.includes("network downgraded to allowlist")),
    "the downgrade is on the run where an operator reads it, derived from the recorded input alone",
  );
  assert.equal(e.needsAttention, true);

  // The same log without the external provenance: no downgrade to report.
  const operatorRun = explainRun([
    { type: "run-started", at, data: { input: { task: "t", trust: "operator", sandboxNetwork: "open" } } },
  ] as never);
  assert.equal(operatorRun.evidence.some((x) => x.includes("downgraded")), false);
});
