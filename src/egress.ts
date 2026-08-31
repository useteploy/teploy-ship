/**
 * The sandbox network tier, its per-run allowlist additions, and how a refusal
 * is recognised when one comes back in a command's output.
 *
 * DELIBERATELY A LEAF. This module imports nothing — not a node builtin, not
 * another Ship module — because the dashboard imports it directly as
 * `teploy-ship/egress` from `web/src/lib/timeline.ts`, which is bundled into
 * the BROWSER half of the run page. `web/src/lib/ship.server.ts` explains why
 * a bare `teploy-ship/runtime` import cannot appear there (it drags node:fs
 * into the client bundle and the build fails); the answer for a pure string
 * function is not to copy it into the web tree by hand — two spellings of one
 * rule is how the rule rots — but to export it from a module that has nothing
 * to drag. Keep it that way: adding an import here breaks `cd web && pnpm run
 * build`, not any test.
 *
 * THREE TIERS, because two were not enough:
 *
 *   none       no network at all. The container joins no bridge. A run cannot
 *              clone, so a repo task cannot start — `setupRepo` clones INSIDE
 *              the container.
 *   allowlist  the default-deny boundary: an internal bridge with no route out
 *              plus the daemon's allowlist proxy on its gateway. Package
 *              registries, Debian and GitHub are built in; a project adds its
 *              own hosts with `sandboxEgressAllow`.
 *   open       ordinary egress. Anything the box can reach, the run can reach.
 *
 * `egress` is the OLD spelling of `allowlist`, and it is still what goes on the
 * wire for that tier — see `wireNetwork`.
 */

/** What Ship records and reasons about. */
export type NetworkTier = "none" | "allowlist" | "open";

export const NETWORK_TIERS: readonly NetworkTier[] = ["none", "allowlist", "open"];

/** For error messages, so every surface refuses an unknown tier in the same words. */
export const NETWORK_TIER_HELP = "none, allowlist (alias: egress) or open";

/**
 * What a Ship install with nothing configured does.
 *
 * `allowlist`, not `none`, and the choice is load-bearing enough to argue for.
 *
 * `none` is the sandbox daemon's default, and inheriting it is how a fresh
 * install arrives broken: a container with no network cannot `git clone`, the
 * clone happens INSIDE the container, so every repo task fails at `repo-setup`
 * on a box where nothing is wrong. The operator's read is "Ship does not work",
 * and the remedy they reach for is the largest one in range — hand-editing the
 * daemon's systemd unit, or turning the boundary off for everything.
 *
 * `open` would also make the install work, and that is exactly what makes it
 * the wrong default: it would hand unrestricted egress to every webhook-sourced
 * task on a box whose operator never made a decision about it. A default that
 * silently widens a security boundary is a security decision taken by
 * omission.
 *
 * `allowlist` is the only default that is both functional and closed: clone,
 * push and the common dependency installs work, and everything else is refused
 * by name — legibly, now (see `detectEgressRefusal`), with a per-project remedy
 * that does not touch any other project on the host.
 */
export const DEFAULT_NETWORK_TIER: NetworkTier = "allowlist";

/**
 * Read a tier from config, a record, a flag or a recorded run input.
 *
 * Accepts `egress` as an alias for `allowlist` — that is the pinned wire
 * contract's own alias, and it is also what every project record, config file
 * and run log written before three tiers existed contains. Returns null for
 * anything else so the caller can refuse in its own idiom (throw, `fail`, a
 * redirect with a message); undefined and "" read as "not set".
 */
export function parseNetworkTier(value: unknown): NetworkTier | null | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  if (typeof value !== "string") return null;
  const v = value.trim().toLowerCase();
  if (v === "") return undefined;
  if (v === "egress") return "allowlist";
  return (NETWORK_TIERS as readonly string[]).includes(v) ? (v as NetworkTier) : null;
}

/**
 * flag > env > config file, and NOTHING falls back to the daemon's `none`.
 *
 * This is the function that closes the first-run cliff: `SHIP_SANDBOX_NETWORK`
 * unset used to mean the daemon's default, which is `network: "none"`, and a
 * sandbox with no network cannot `git clone` — `setupRepo` clones INSIDE the
 * container. So an install where nobody set the variable could run no repo
 * task at all, and looked broken rather than closed. Returns null for a value
 * that is set but unusable, so the caller refuses rather than guessing.
 */
export function resolveNetworkTier(
  flag?: string | undefined,
  env?: string | undefined,
  config?: string | undefined,
): NetworkTier | null {
  const chosen = parseNetworkTier(flag ?? env ?? config);
  return chosen === null ? null : (chosen ?? DEFAULT_NETWORK_TIER);
}

/**
 * The value that goes in the create body's `network` field.
 *
 * `allowlist` is sent as **`egress`**, and that is not laziness. The pinned
 * contract accepts both spellings, and only one of them is understood by a
 * daemon that has not been upgraded yet: teploy-sandbox's `Create` switches on
 * `case "egress"` and its `default` is `--network none`. So a Ship that sent
 * the new spelling to an old daemon would seal every run it believed it was
 * putting on the allowlist — a silent, total failure, on exactly the tier that
 * is now the default. Sending the alias costs nothing and cannot do that.
 *
 * `open` has no backwards-compatible spelling. An old daemon falls through to
 * `--network none` and the run is sealed rather than opened, which is the safe
 * direction for a value it does not understand.
 */
export function wireNetwork(tier: NetworkTier): "none" | "egress" | "open" {
  return tier === "allowlist" ? "egress" : tier;
}

// ---------------------------------------------------------------------------
// Per-project allowlist additions
// ---------------------------------------------------------------------------

/** Bounded so a create body cannot grow without limit from an editable record. */
export const MAX_EGRESS_ALLOW_ENTRIES = 64;

/**
 * `host`, `.suffix`, or `host:port` — the daemon's own entry grammar
 * (teploy-sandbox `internal/egress`). A portless entry admits ONLY 80 and 443;
 * naming a port is the only way to open anything else.
 */
const ENTRY = /^\.?[a-z0-9]([a-z0-9.-]*[a-z0-9])?(:\d{1,5})?$/;

/** Why this entry is not usable, or null if it is. */
export function egressEntryError(entry: string): string | null {
  const e = entry.trim().toLowerCase();
  if (e === "") return "empty entry";
  if (e.length > 260) return `too long: ${e.slice(0, 40)}…`;
  if (e.includes("://") || e.includes("/")) return `entry is a host, not a URL: ${entry}`;
  if (e.includes("*")) return `no wildcards; use a leading dot for subdomains (".example.com"), got: ${entry}`;
  if (!ENTRY.test(e)) return `not a host, .suffix or host:port: ${entry}`;
  const port = e.split(":")[1];
  if (port !== undefined && (Number(port) < 1 || Number(port) > 65535)) return `port out of range: ${entry}`;
  return null;
}

/**
 * Normalise an allowlist: trimmed, lowercased, de-duplicated, order preserved,
 * empty means absent. Throws on an entry the daemon could not act on — a typo
 * saved through the dashboard would otherwise surface much later as a blocked
 * host nobody can explain, on a run that has already been paid for.
 */
export function normalizeEgressAllow(entries: readonly string[] | undefined): string[] | undefined {
  if (entries === undefined) return undefined;
  const out: string[] = [];
  for (const raw of entries) {
    const e = raw.trim().toLowerCase();
    if (e === "") continue;
    const error = egressEntryError(e);
    if (error !== null) throw new Error(`sandboxEgressAllow: ${error}`);
    if (!out.includes(e)) out.push(e);
  }
  if (out.length === 0) return undefined;
  if (out.length > MAX_EGRESS_ALLOW_ENTRIES) {
    throw new Error(`sandboxEgressAllow: at most ${MAX_EGRESS_ALLOW_ENTRIES} entries, got ${out.length}`);
  }
  return out;
}

/** Split a comma/space separated list (a CLI flag, a textarea) into entries. */
export function splitEgressAllow(raw: string | undefined): string[] {
  return (raw ?? "")
    .split(/[,\s]+/)
    .map((s) => s.trim())
    .filter((s) => s !== "");
}

// ---------------------------------------------------------------------------
// The safety coupling
// ---------------------------------------------------------------------------

/**
 * The tier a run may actually execute on, given where its task came from.
 *
 * **An externally-sourced task never runs on `open`.** Ship already knows the
 * provenance of every task — `trust === "external"` is anything that arrived
 * through a webhook, an issue body or a chat message — and durable.ts already
 * refuses to run those without an isolated executor for the same reason: the
 * agent writes the commands, and a stranger wrote the prompt. Unrestricted
 * egress on a task a stranger authored is an exfiltration channel out of a
 * container that is holding a git credential; the allowlist is the boundary
 * that makes the sandbox mean something.
 *
 * A DOWNGRADE, not a refusal. Refusing would strand every externally-sourced
 * task on a project whose record happens to say `open`, and an operator with a
 * queue of stranded runs turns the rule off. Downgrading runs the task on the
 * tier the operator would have chosen for it, and says so.
 *
 * Absent trust reads as `operator`, matching `input.trust ?? "operator"`
 * everywhere else in durable.ts: an eval, a workspace run and a CLI invocation
 * record no trust, and none of them came from outside.
 *
 * Pure, and a function of the RECORDED input alone, so a replay reaches the
 * same answer as the original run and this needs no step of its own.
 */
export function networkForTrust(
  tier: NetworkTier | undefined,
  trust: string | undefined,
): { network: NetworkTier | undefined; downgradedFrom?: NetworkTier } {
  if (tier === "open" && trust === "external") return { network: "allowlist", downgradedFrom: "open" };
  return { network: tier };
}

/** What an operator reads on the run's timeline when the downgrade fired. */
export const NETWORK_DOWNGRADE_NOTE =
  "This task came from outside — a webhook, an issue body or a chat message — so it ran on the sandbox's " +
  "default-deny allowlist rather than the open network its project record asks for. Full network access is for " +
  "work an operator started. Nothing needs fixing; add the hosts this repo genuinely needs to the project's " +
  "egress allowlist and every run gets them, whoever filed the task.";

// ---------------------------------------------------------------------------
// Recognising a refusal
// ---------------------------------------------------------------------------

/**
 * Signatures of "the sandbox allowlist said no", most specific first.
 *
 * DELIBERATELY NARROW. A false positive tells the agent to stop retrying a
 * command that would have worked on the next attempt, and tells the operator to
 * go widen an allowlist that is not the problem — so nothing here matches a
 * generic failure. `Could not resolve host`, `Network is unreachable` and a
 * bare 403 are all absent for that reason: they are what a sealed run, a
 * genuinely dead host and an ordinary auth failure look like too, and this
 * function cannot tell which it is looking at.
 *
 * The first pattern is the daemon's own refusal text, and it names the host.
 * The rest are what proxy-aware tooling prints when the proxy answers a CONNECT
 * with 403 and the body never reaches the user.
 */
const REFUSALS: ReadonlyArray<{ re: RegExp; host: number }> = [
  // teploy-sandbox internal/egress: `http.Error(w, "egress denied by the sandbox allowlist: "+host, 403)`
  { re: /egress denied by the sandbox allowlist:\s*([^\s"'\\)]+)/i, host: 1 },
  // curl, and git over curl: "Received HTTP code 403 from proxy after CONNECT"
  { re: /received http code 403 from proxy after connect/i, host: 0 },
  // Go's transport: `proxyconnect tcp: ... 403`; npm/pnpm: `407/403 ... proxy`
  { re: /proxyconnect[^\n]*\b403\b/i, host: 0 },
  { re: /\b403\b[^\n]{0,60}\bfrom proxy\b/i, host: 0 },
];

export interface EgressRefusal {
  /** The host the sandbox refused, when the output named it. */
  host?: string;
  /** The matched line, trimmed — what to quote back at whoever reads this. */
  evidence: string;
}

/**
 * Did this command output carry a sandbox egress refusal, and which host?
 *
 * Returns null for anything it is not sure about. Scans a bounded prefix and
 * suffix rather than the whole blob: an output can be megabytes, this runs on
 * every executed action in both loops, and a refusal is at the point of
 * failure — the end — or in the first thing that tried to reach the network.
 */
export function detectEgressRefusal(output: string | undefined): EgressRefusal | null {
  if (output === undefined || output === "") return null;
  const text = output.length > 40_000 ? `${output.slice(0, 20_000)}\n${output.slice(-20_000)}` : output;
  for (const { re, host } of REFUSALS) {
    const m = re.exec(text);
    if (m === null) continue;
    const line = (m[0] ?? "").replace(/\s+/g, " ").trim();
    const named = host > 0 ? m[host] : undefined;
    // A trailing period or quote is punctuation from the surrounding sentence,
    // not part of a hostname.
    const cleaned = named?.replace(/[.,;:'")\]]+$/, "");
    return { ...(cleaned !== undefined && cleaned !== "" ? { host: cleaned } : {}), evidence: line.slice(0, 200) };
  }
  return null;
}

/**
 * What the AGENT is told when its command was refused by the allowlist.
 *
 * The problem this solves is measurable and expensive: a blocked host and a
 * broken build are indistinguishable in raw command output, so the agent reads
 * a network refusal as a flaky step, retries it, tries a mirror, retries again,
 * and spends its turn budget on a wall. The one thing it needs to know is that
 * no amount of retrying changes the answer, and what to do instead.
 *
 * Appended to the observation rather than replacing it: the real output is
 * still the evidence, and an agent that is told only "blocked" cannot tell
 * which of its five commands was.
 */
export function egressRefusalHint(refusal: EgressRefusal): string {
  const host = refusal.host !== undefined ? `\`${refusal.host}\`` : "a host that is not on the allowlist";
  return (
    `[NETWORK BLOCKED] The sandbox's egress allowlist refused ${host}. This is a policy decision by the machine ` +
    `you are running on, not a fault in the command and not a transient error: retrying it, adding --retry, ` +
    `switching mirrors or waiting will fail identically every time. Do not run it again. Continue with what is ` +
    `already in the workspace if you can. If the task genuinely cannot proceed without that host, stop and say so ` +
    `in a \`\`\`finish block, naming the host — an operator adds it to the project's egress allowlist, which is ` +
    `something only they can do.`
  );
}

/** The same fact, for an operator reading the run rather than the model. */
export function egressRefusalNote(refusal: EgressRefusal): string {
  const host = refusal.host !== undefined ? refusal.host : "an unnamed host";
  return (
    `The sandbox refused this run's connection to ${host}: it is not on the egress allowlist. ` +
    `Add it to this project's egress allowlist (Projects page, or \`teploy-ship project set <repo> ` +
    `--egress-allow ${refusal.host ?? "host.example.com"}\`) to allow it for this repo only, or to ` +
    `SBX_EGRESS_ALLOW on the sandbox daemon to allow it for every project on that host.`
  );
}
