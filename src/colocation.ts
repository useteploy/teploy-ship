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
 * HOW IT DETECTS IT, and what each check can and cannot see:
 *
 *  1. The forge origin is loopback. Decisive, free, and catches the obvious
 *     case of a forge on the same machine addressed as localhost.
 *  2. The forge origin resolves to an address on one of THIS PROCESS's own
 *     interfaces. Decisive when Ship runs on the host. It is blind when Ship
 *     runs in a container, because the container's netns has none of the host's
 *     addresses — which is the normal deployment, hence check 3.
 *  3. The forge answers on the SANDBOX HOST'S OWN ADDRESS. From inside a
 *     sandbox the host is the container's default gateway, so if the forge's
 *     port answers there, the forge is on the box the sandboxes run on. This is
 *     the check that catches the real case (Ship deployed to infra-home), and
 *     the only one that sees through the container boundary. It costs one
 *     sandbox at startup, once.
 *
 * A check that cannot run (no sandbox configured, a probe that errors) reports
 * "unknown" rather than "safe": this gate must fail loud, not open.
 */
import { networkInterfaces } from "node:os";
import { lookup } from "node:dns/promises";

export interface ColocationFinding {
  /** The forge origin that was checked, as configured. */
  origin: string;
  /** Which check fired. */
  how: "loopback" | "local-interface" | "sandbox-host";
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

export interface DetectOptions {
  /** Forge origins Ship is configured to clone from. */
  origins: string[];
  /** Runs a command inside a sandbox. Omit and check 3 reports "unknown". */
  probe?: SandboxProbe;
  /** Injected for tests. */
  resolve?: (host: string) => Promise<string[]>;
  interfaces?: NodeJS.Dict<Array<{ address: string }>>;
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

export async function detectForgeColocation(options: DetectOptions): Promise<ColocationResult> {
  const colocated: ColocationFinding[] = [];
  const unknown: string[] = [];
  const mine = localAddresses(options.interfaces);

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

    // Check 3. The only one that sees past the container boundary, and the one
    // that catches the real case.
    if (options.probe === undefined) {
      unknown.push(
        `${origin}: no sandbox is configured, so Ship cannot ask whether the forge is on the box its sandboxes run on`,
      );
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
      unknown.push(`${origin}: the sandbox has no default route, so its host's address could not be determined`);
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
    "Move the worker to a box that is not the forge (this is what `teploy-ship join` is for), or, if you have " +
    `decided the blast radius is acceptable, set ${COLOCATION_OVERRIDE_ENV}=1. The override is logged on every start.`
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
