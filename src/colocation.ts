/**
 * Is Ship about to run model-authored code on the same box as the forge it
 * clones from?
 *
 * WHY THIS IS A GATE AND NOT A NOTE. Ship executes code a model wrote, and its
 * sandbox egress allowlist permits the forge BY DESIGN — a run has to clone and
 * push. Co-located, that permission is a local hop to every repository and
 * every credential the forge holds, with one container boundary between them
 * instead of a container boundary plus a network. infra-home runs Forgejo,
 * Observe, Dash, omni-analyst, Caddy, Postgres and MinIO on 4 CPU / 30 GB; a
 * sandbox escape there is not a Ship outage, it is everything.
 *
 * The answer is NOT "tell the operator to pick a different box". That pushes a
 * decision onto a person that the software can make, and a person forgets
 * exactly once. Ship detects it and refuses, says precisely what it detected,
 * and takes an explicit override — safe by default, overridable, and zero
 * decisions in the happy path.
 *
 * WHAT IS ACTUALLY BEING ASKED — and this took a correction to get right.
 *
 * The risk is where MODEL-AUTHORED CODE EXECUTES, and that is the sandbox, not
 * the worker. The worker process runs Ship's own TypeScript; it holds
 * credentials wherever it lives. So a worker sitting next to the forge is NOT
 * the hazard, provided its sandboxes are somewhere else — that is the Forgejo
 * Actions shape (forge and coordinator together, runners elsewhere) and it is
 * a legitimate, and safer, topology.
 *
 * The first version of this gate asked "is the forge on the WORKER's box",
 * which conflated the two and would have refused exactly that architecture.
 * The question is per sandbox daemon: IS THAT DAEMON ON THE SAME MACHINE AS
 * THE FORGE?
 *
 *   - A daemon at a remote address: resolve it, compare with the forge. Same
 *     machine means co-located; different machines mean the code runs a network
 *     away from the repositories, which is the whole point.
 *   - A daemon that is local to this process (loopback, an address on our own
 *     interfaces, or our own default gateway — a bridge address means "the
 *     daemon is on my box"): then, and only then, the question collapses to
 *     "is the forge also on MY box", which the checks below answer.
 *   - NO sandbox configured at all: the worker executes agent code itself on
 *     the host (LocalExecutor, isolated: false). Then the worker IS the
 *     executor and worker-co-location is exactly the hazard.
 *
 * A check that cannot run (no sandbox configured, a probe that errors) reports
 * "unknown" rather than "safe": this gate must fail loud, not open.
 *
 * ---------------------------------------------------------------------------
 * PRE-DECIDED 2026-08-26 — check 3 exists because check 4 is INERT on the real
 * deployment, and a security gate that silently checks nothing is worse than no
 * gate.
 *
 * Measured on deploy-test, not reasoned about: the sandbox daemon's egress
 * network is `internal=true` (`docker network inspect teploy-sbx-egress` ->
 * `"Internal": true`), so a run container has NO default route at all —
 * `/proc/net/route` holds only the on-link subnet row. `sandboxHostProbeCommand`
 * therefore returns NOGW every time and check 4 reports "unknown" forever.
 * Worse, an internal network drops traffic to the bridge gateway too: from that
 * network even the sandbox daemon's own port (172.31.99.1:7439, listening on
 * 0.0.0.0) refuses. There is no sandbox-side fix; the isolation that makes the
 * sandbox safe is exactly what blinds the probe.
 *
 * The worker's own container is on a normal bridge and DOES have a default
 * gateway, and on the standard deployment that gateway is literally the sandbox
 * host — on deploy-test `SHIP_SANDBOX_URL=http://172.18.0.1:7439` IS the
 * worker's default gateway. So asking from the worker answers the same question
 * in the shape that ships.
 *
 * Proved both ways 2026-08-26. deploy-test (forge elsewhere): worker gateway
 * 172.18.0.1, port 49152 does not answer. infra-home (RUNS the forge): a
 * container on its `teploy` bridge gets gateway 172.18.0.1 and 49152 answers —
 * the refusal fires.
 *
 * A CONNECT TIMEOUT IS TREATED AS "NOT CO-LOCATED", decisively, and this is the
 * one judgement call here. A co-located forge's port answers from the host's own
 * bridge in every shape Ship supports: docker-published ports are DNAT'd out of
 * the DOCKER-USER chain and bypass the host firewall, and a host-bound service
 * binds 0.0.0.0. A drop means the port is not there. The alternative — calling
 * every timeout "could not determine" — prints an unknown line on every start of
 * every correctly-configured box, and a gate whose normal output is a warning is
 * a gate operators stop reading. Reversal condition: someone runs a forge on the
 * Ship box behind a host firewall that filters the docker bridge.
 * ---------------------------------------------------------------------------
 */
import { networkInterfaces } from "node:os";
import { lookup } from "node:dns/promises";
import { readFile } from "node:fs/promises";
import { connect } from "node:net";

export interface ColocationFinding {
  /** The forge origin that was checked, as configured. */
  origin: string;
  /** Which check fired. */
  how: "loopback" | "local-interface" | "worker-gateway" | "sandbox-host";
  /** What to show a human. Names the forge and the evidence, never just "unsafe". */
  detail: string;
}

export interface ColocationResult {
  colocated: ColocationFinding[];
  /** Checks that could not run. Non-empty means the verdict is incomplete. */
  unknown: string[];
}

/** Run a shell command inside a sandbox on the host the sandboxes run on. */
export type SandboxProbe = (command: string) => Promise<{ exitCode: number; stdout: string }>;

export const COLOCATION_OVERRIDE_ENV = "SHIP_ALLOW_FORGE_COLOCATION";

/** Is the override set? Kept here so the message and the check cannot drift apart. */
export function colocationOverridden(env: NodeJS.ProcessEnv = process.env): boolean {
  const value = (env[COLOCATION_OVERRIDE_ENV] ?? "").trim().toLowerCase();
  return value === "1" || value === "true" || value === "yes";
}

function isLoopback(host: string): boolean {
  return host === "localhost" || host === "127.0.0.1" || host === "::1" || host.startsWith("127.");
}

/**
 * An address a machine of yours can hold: RFC1918, CGNAT (which is the
 * tailnet's 100.64.0.0/10), link-local, loopback, and the IPv6 equivalents.
 *
 * Used only to decide whether check 3 is worth asking — see its call site.
 */
export function isPrivateAddress(address: string): boolean {
  if (address.includes(":")) return /^(::1$|fc|fd|fe8|fe9|fea|feb)/i.test(address);
  const octets = address.split(".").map(Number);
  if (octets.length !== 4 || octets.some((n) => !Number.isInteger(n))) return false;
  const [a, b] = octets as [number, number, number, number];
  if (a === 10 || a === 127) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 169 && b === 254) return true;
  if (a === 100 && b >= 64 && b <= 127) return true;
  return false;
}

/** Every address this process can see on its own interfaces. */
export function localAddresses(interfaces: NodeJS.Dict<Array<{ address: string }>> = networkInterfaces()): Set<string> {
  const out = new Set<string>();
  for (const list of Object.values(interfaces)) {
    for (const entry of list ?? []) out.add(entry.address);
  }
  return out;
}

/**
 * Parse an origin into the pieces the checks need. Returns null for anything
 * that is not an http(s) origin — a `file://` remote has no host to be
 * co-located with.
 */
export function originParts(origin: string): { host: string; port: number } | null {
  try {
    const url = new URL(origin);
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    const port = url.port !== "" ? Number(url.port) : url.protocol === "https:" ? 443 : 80;
    return { host: url.hostname, port };
  } catch {
    return null;
  }
}

/**
 * The sandbox-side probe: does the forge answer on the sandbox host's own
 * address?
 *
 * The container's default gateway IS the host, so this asks the one question
 * that distinguishes "the forge is reachable from here" (true from anywhere on
 * the tailnet, and therefore useless) from "the forge is ON here".
 *
 * It must work in whatever image the operator configured, so it depends on
 * nothing beyond a POSIX shell and /proc.
 */
export function sandboxHostProbeCommand(port: number): string {
  // Written against what a MINIMAL image actually has, which is less than it
  // looks. Verified live 2026-08-26: debian:bookworm-slim has neither `ip` nor
  // `route`, and its /bin/sh is dash, so bash's /dev/tcp is not available
  // either. The first draft of this probe returned NOGW on both boxes and
  // proved nothing, which is a good argument for running a check before
  // believing it.
  //
  // Three ways to find the gateway, ending at /proc/net/route, which every
  // Linux container has; four ways to open a socket, ending in NOTOOL — which
  // is reported as "unknown", never as "safe".
  //
  // Newline-separated rather than `;`-joined: an `if/elif/fi` chain does not
  // survive being flattened onto one line without care, and getting that
  // subtly wrong is how a security gate silently stops testing anything.
  return [
    `gw=$(ip route 2>/dev/null | awk '/^default/ {print $3; exit}')`,
    `[ -z "$gw" ] && gw=$(route -n 2>/dev/null | awk '/^0[.]0[.]0[.]0/ {print $2; exit}')`,
    // Destination 00000000 is the default route; the gateway is a
    // little-endian hex word, so the octets come out back to front.
    //
    // The hex is converted by hand rather than with strtonum(), which is a GAWK
    // EXTENSION. Verified live 2026-08-26: debian:bookworm-slim ships mawk, and
    // the strtonum version of this line silently produced no gateway on every
    // box — so the gate reported "cannot determine" everywhere and checked
    // nothing. An index into a digit string works in gawk, mawk and busybox awk
    // alike.
    `[ -z "$gw" ] && gw=$(awk 'function h(s,  i,c,n,d){n=0;for(i=1;i<=length(s);i++)` +
      `{c=tolower(substr(s,i,1));d=index("0123456789abcdef",c)-1;n=n*16+d}return n}` +
      ` NR>1 && $2=="00000000" && $3!="00000000" {g=$3; printf "%d.%d.%d.%d",` +
      ` h(substr(g,7,2)), h(substr(g,5,2)), h(substr(g,3,2)), h(substr(g,1,2)); exit}'` +
      ` /proc/net/route 2>/dev/null)`,
    `if [ -z "$gw" ]; then echo NOGW; exit 0; fi`,
    `echo "GW=$gw"`,
    // Nothing is written to the socket: the question is only whether something
    // is listening on the sandbox host at the forge's port.
    `if command -v bash >/dev/null 2>&1; then`,
    `  timeout 3 bash -c "exec 3<>/dev/tcp/$gw/${port}" >/dev/null 2>&1 && echo OPEN || echo CLOSED`,
    `elif command -v nc >/dev/null 2>&1; then`,
    `  nc -z -w 3 "$gw" ${port} >/dev/null 2>&1 && echo OPEN || echo CLOSED`,
    `elif command -v curl >/dev/null 2>&1; then`,
    `  curl -s -o /dev/null -m 3 "http://$gw:${port}/" >/dev/null 2>&1 && echo OPEN || echo CLOSED`,
    `elif command -v wget >/dev/null 2>&1; then`,
    `  wget -q -T 3 -O /dev/null "http://$gw:${port}/" >/dev/null 2>&1 && echo OPEN || echo CLOSED`,
    `else`,
    `  echo NOTOOL`,
    `fi`,
  ].join("\n");
}

/**
 * This process's own default gateway, from `/proc/net/route`.
 *
 * Parsed rather than shelled out to: the worker image is `node:22` and has
 * neither `ip` nor `route` (the same discovery that shaped the sandbox-side
 * probe above), while /proc/net/route exists in every Linux container.
 *
 * The gateway is a LITTLE-ENDIAN hex word, so the octets come out back to
 * front — `010012AC` is 172.18.0.1, verified against `docker exec … ip route`
 * on both boxes. Returns null on any shape it does not recognise, including
 * every non-Linux host, where /proc/net/route does not exist at all.
 */
export function parseDefaultGateway(procNetRoute: string): string | null {
  for (const line of procNetRoute.split("\n").slice(1)) {
    const cols = line.trim().split(/\s+/);
    // Iface Destination Gateway Flags RefCnt Use Metric Mask …
    if (cols.length < 3) continue;
    const [, destination, gateway] = cols as [string, string, string];
    if (destination !== "00000000" || gateway === "00000000") continue;
    if (!/^[0-9A-Fa-f]{8}$/.test(gateway)) continue;
    const byte = (i: number): number => parseInt(gateway.slice(i, i + 2), 16);
    return `${byte(6)}.${byte(4)}.${byte(2)}.${byte(0)}`;
  }
  return null;
}

/** Read this process's default gateway. Null when there is none to read. */
export async function readDefaultGateway(read?: () => Promise<string>): Promise<string | null> {
  try {
    const text = read !== undefined ? await read() : await readFile("/proc/net/route", "utf8");
    return parseDefaultGateway(text);
  } catch {
    return null;
  }
}

/**
 * "is something listening there?" — one TCP connect, nothing written.
 *
 * "unknown" is reserved for a probe that could not ask. A refusal and a
 * timeout are both answers; see the PRE-DECIDED block at the top of this file
 * for why a timeout counts as "closed".
 */
export type TcpProbe = (host: string, port: number, timeoutMs: number) => Promise<"open" | "closed" | "unknown">;

export const tcpProbe: TcpProbe = (host, port, timeoutMs) =>
  new Promise((resolve) => {
    let settled = false;
    const done = (verdict: "open" | "closed" | "unknown"): void => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(verdict);
    };
    const socket = connect({ host, port });
    socket.setTimeout(timeoutMs);
    socket.on("connect", () => done("open"));
    socket.on("timeout", () => done("closed"));
    socket.on("error", () => done("closed"));
  });

export interface DetectOptions {
  /** Forge origins Ship is configured to clone from. */
  origins: string[];
  /**
   * The sandbox daemons this worker places runs on (SHIP_SANDBOX_URL, which is
   * a list since B2). THIS is what the gate is about — see the header.
   *
   * An empty list means no sandbox is configured, so the worker executes agent
   * code on its own host and the worker's own box is the one that matters.
   */
  sandboxUrls?: string[];
  /** Runs a command inside a sandbox. Omit and check 4 reports "unknown". */
  probe?: SandboxProbe;
  /** Injected for tests. */
  resolve?: (host: string) => Promise<string[]>;
  interfaces?: NodeJS.Dict<Array<{ address: string }>>;
  /** This process's default gateway (check 3). Injected for tests. */
  gateway?: () => Promise<string | null>;
  /** How check 3 asks whether a port answers. Injected for tests. */
  connect?: TcpProbe;
  /** Check 3's connect timeout. */
  connectTimeoutMs?: number;
}

async function resolveHost(host: string, resolver?: (host: string) => Promise<string[]>): Promise<string[]> {
  if (resolver !== undefined) return resolver(host);
  try {
    const results = await lookup(host, { all: true });
    return results.map((r) => r.address);
  } catch {
    return [];
  }
}

/**
 * Where do sandboxes run, relative to this process?
 *
 * "local" means a daemon on this very box (loopback, one of our own addresses,
 * or our default gateway — a docker bridge address is how a containerised
 * worker names its own host). "remote" carries the resolved addresses of a
 * daemon somewhere else. "none" means no sandbox at all, so the worker is the
 * executor.
 */
export async function sandboxLocality(
  urls: string[],
  options: { resolve?: (host: string) => Promise<string[]>; interfaces?: NodeJS.Dict<Array<{ address: string }>>; gateway?: () => Promise<string | null> },
): Promise<{ kind: "none" } | { kind: "local"; urls: string[] } | { kind: "remote"; hosts: Array<{ url: string; addresses: string[] }> } | { kind: "mixed"; urls: string[]; hosts: Array<{ url: string; addresses: string[] }> }> {
  if (urls.length === 0) return { kind: "none" };
  const mine = localAddresses(options.interfaces);
  const gateway = await (options.gateway ?? (() => readDefaultGateway()))().catch(() => null);
  const local: string[] = [];
  const remote: Array<{ url: string; addresses: string[] }> = [];
  for (const url of urls) {
    const parts = originParts(url);
    if (parts === null) continue;
    if (isLoopback(parts.host)) {
      local.push(url);
      continue;
    }
    const addresses = await resolveHost(parts.host, options.resolve);
    if (addresses.some((a) => mine.has(a)) || (gateway !== null && addresses.includes(gateway)) || parts.host === gateway) {
      local.push(url);
      continue;
    }
    remote.push({ url, addresses });
  }
  if (local.length > 0 && remote.length > 0) return { kind: "mixed", urls: local, hosts: remote };
  if (local.length > 0) return { kind: "local", urls: local };
  if (remote.length > 0) return { kind: "remote", hosts: remote };
  return { kind: "none" };
}

export async function detectForgeColocation(options: DetectOptions): Promise<ColocationResult> {
  const colocated: ColocationFinding[] = [];
  const unknown: string[] = [];
  const mine = localAddresses(options.interfaces);

  // Where the agent's code actually runs decides which question to ask.
  const where = await sandboxLocality(options.sandboxUrls ?? [], {
    ...(options.resolve !== undefined ? { resolve: options.resolve } : {}),
    ...(options.interfaces !== undefined ? { interfaces: options.interfaces } : {}),
    ...(options.gateway !== undefined ? { gateway: options.gateway } : {}),
  });

  // A REMOTE-only sandbox pool is the safe topology this gate exists to permit:
  // the worker may sit beside the forge because nothing model-authored runs
  // there. The only thing left to check is whether a sandbox host IS the forge.
  if (where.kind === "remote") {
    for (const origin of options.origins) {
      const parts = originParts(origin);
      if (parts === null) continue;
      const forge = await resolveHost(parts.host, options.resolve);
      for (const host of where.hosts) {
        const shared = host.addresses.filter((a) => forge.includes(a));
        if (shared.length > 0) {
          colocated.push({
            origin,
            how: "sandbox-host",
            detail: `the sandbox daemon at ${host.url} resolves to ${shared.join(", ")}, which is also where ${parts.host} is — the agent's code would run on the forge's own machine`,
          });
        }
      }
      if (forge.length === 0) {
        unknown.push(`${origin}: could not be resolved, so it could not be compared against the sandbox hosts`);
      }
    }
    return { colocated, unknown };
  }

  for (const origin of options.origins) {
    const parts = originParts(origin);
    if (parts === null) continue;

    if (isLoopback(parts.host)) {
      colocated.push({
        origin,
        how: "loopback",
        detail: `the forge is configured as ${origin}, which is this machine by definition`,
      });
      continue;
    }

    const addresses = await resolveHost(parts.host, options.resolve);
    const shared = addresses.filter((address) => mine.has(address));
    if (shared.length > 0) {
      colocated.push({
        origin,
        how: "local-interface",
        detail: `${parts.host} resolves to ${shared.join(", ")}, which is an address on this machine's own interfaces`,
      });
      continue;
    }

    // Check 3. The worker's own default gateway is the docker bridge on its
    // host, so this asks "is the forge on MY box?" without needing a sandbox —
    // which is what makes it the only check that answers on the real
    // deployment. See the PRE-DECIDED block at the top of this file.
    const gatewayOf = options.gateway ?? (() => readDefaultGateway());
    const dial = options.connect ?? tcpProbe;
    // NOT asked for a public forge on a well-known port, and this exclusion was
    // written after a live run rather than in advance. With
    // `https://github.com` in SHIP_REPO_ALLOWLIST the question becomes "does
    // anything answer on 443 on my default gateway", which on a bare-metal
    // worker is a home router's admin UI — a false positive that refuses to
    // start a perfectly good box, and the file's own argument is that a gate
    // people override on reflex is worse than no gate. github.com is not on
    // your machine. A SELF-HOSTED forge is still asked about, on any port, and
    // so is a public-address forge on a non-standard port.
    const publicWellKnown =
      (parts.port === 80 || parts.port === 443) && addresses.length > 0 && !addresses.some(isPrivateAddress);
    const gateway = publicWellKnown ? null : await gatewayOf();
    let gatewayAnswered = publicWellKnown;
    if (gateway !== null && !isLoopback(gateway)) {
      const verdict = await dial(gateway, parts.port, options.connectTimeoutMs ?? 3000);
      if (verdict === "open") {
        colocated.push({
          origin,
          how: "worker-gateway",
          detail:
            `the forge's port ${parts.port} answers on ${gateway}, which is this worker's own default gateway — ` +
            `so ${parts.host} is the machine this worker (and, on a default install, its sandboxes) runs on`,
        });
        continue;
      }
      gatewayAnswered = verdict === "closed";
    }

    // Check 4. The same question asked from inside a sandbox, which is a
    // different question once the sandbox pool puts containers on other hosts.
    if (options.probe === undefined) {
      // Only worth saying when check 3 could not answer either. On a normal box
      // check 3 IS the answer, and a gate whose happy path prints a warning is
      // a gate nobody reads.
      if (!gatewayAnswered) {
        unknown.push(
          `${origin}: no sandbox is configured and this process has no usable default gateway, so Ship could not ` +
            `ask whether the forge is on the box its code runs on`,
        );
      }
      continue;
    }
    let output: string;
    try {
      const result = await options.probe(sandboxHostProbeCommand(parts.port));
      output = result.stdout;
    } catch (error) {
      unknown.push(`${origin}: the sandbox probe failed (${error instanceof Error ? error.message : String(error)})`);
      continue;
    }
    if (output.includes("NOGW")) {
      // Expected, permanently, whenever SHIP_SANDBOX_NETWORK=egress: that
      // network is docker-`internal`, so a run container has no default route
      // by design. Saying so once per start teaches nothing when check 3
      // already answered for this box; it is worth saying when it did not.
      if (!gatewayAnswered) {
        unknown.push(
          `${origin}: the sandbox has no default route (an egress-mode sandbox network is docker-internal, so this ` +
            `is expected) and this process has no usable default gateway either, so neither check could run`,
        );
      }
      continue;
    }
    if (output.includes("NOTOOL")) {
      unknown.push(
        `${origin}: the sandbox image has no bash, nc, curl or wget, so Ship could not test whether the forge answers on its host`,
      );
      continue;
    }
    if (output.includes("OPEN")) {
      const gateway = /GW=(\S+)/.exec(output)?.[1] ?? "the sandbox host";
      colocated.push({
        origin,
        how: "sandbox-host",
        detail:
          `the forge's port ${parts.port} answers on ${gateway}, which is the host your sandboxes run on — ` +
          `so ${parts.host} and your sandboxes are the same machine`,
      });
    }
  }

  return { colocated, unknown };
}

/**
 * The refusal, written so an operator can act on it without reading source.
 *
 * It names the forge, the evidence, the consequence and both ways forward. A
 * gate that says "unsafe configuration" teaches nobody anything and gets
 * overridden on reflex.
 */
export function colocationRefusal(findings: ColocationFinding[]): string {
  const lines = findings.map((f) => `  - ${f.origin}: ${f.detail}`);
  return (
    "refusing to run sandboxes on the same machine as the forge.\n\n" +
    `${lines.join("\n")}\n\n` +
    "Ship executes code a model wrote, and its sandbox egress allowlist permits the forge by design — a run has to " +
    "clone and push. On the forge's own box that permission is a local hop to every repository and every credential " +
    "it holds, with one container boundary between them instead of a container boundary plus a network.\n\n" +
    "Note what this is NOT objecting to: the worker PROCESS living beside the forge is fine. It runs Ship's own code, " +
    "not the model's. What must not share that machine is the SANDBOX. Point SHIP_SANDBOX_URL at a daemon on another " +
    "box — that is the Forgejo Actions shape, forge and coordinator together with runners elsewhere, and it is the " +
    "topology this gate is built to let you have. SHIP_SANDBOX_URL takes a comma-separated list, so adding compute is " +
    "adding an address.\n\n" +
    `If you have decided the blast radius is acceptable, set ${COLOCATION_OVERRIDE_ENV}=1. The override is logged on every start.`
  );
}

/** What the log says when the override is in force. Deliberately not quiet. */
export function colocationOverrideNotice(findings: ColocationFinding[]): string {
  const where = findings.map((f) => f.origin).join(", ");
  return (
    `[worker] ${COLOCATION_OVERRIDE_ENV}=1: running sandboxes on the same machine as the forge (${where}). ` +
    "Model-authored code and every repository the forge holds are one container boundary apart on this box."
  );
}
