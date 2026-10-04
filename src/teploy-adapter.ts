/**
 * TeployAdapter (S27): the native Teploy implementation of `DeploymentAdapter`,
 * over the same argv runner and the same `teploy` commands delivery.ts uses
 * (`status --json`, `deploy --image --version --skip-dns-check`, `rollback
 * --to`, `exec <server> -- docker image inspect`).
 *
 * WHY it exists. deployment-adapter.ts states the delivery invariants once,
 * provider-blind; this is the first provider to run under them. delivery.ts's
 * hand-written copies of those rules stay the default path. This adapter is an
 * ALTERNATIVE reached only through SHIP_DEPLOY_ADAPTER=teploy (see
 * `deployAdapterFlagOn`), so nothing changes until an operator opts in.
 *
 * WHAT IT DOES NOT CLAIM. The capability declaration lists, in
 * `unsupported`, what Teploy cannot do today: a destination-level fence that a
 * hand-run `teploy deploy` respects, a provider-side dry-run, a target
 * generation token, a recorded recovery artifact digest, logs (the `teploy
 * logs` flags are not verified here), provisioning, and the recovery modes
 * other than rollback-to-version. Each is declared, not approximated, and the
 * conformance checks that depend on one report `skipped` rather than pass.
 *
 * Attribution is a property of every answer: the adapter is bound to ONE
 * service@destination (the trusted copy's teploy.yml `app:` plus the approved
 * destination) and `status --json`'s `app` must name that service, otherwise
 * the answer is `unknown`, never a state for somebody else's service.
 *
 * `revision` is the version string teploy itself reports (`current_hash`, the
 * 7-character short SHA delivery.ts deploys with); `artifact` is the image
 * name the deploy was given.
 */
import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";

import type { CommandRunner } from "./deploy.js";
import type { DeliveryAdapterFactory } from "./delivery.js";
import {
  authorisationCovers,
  ok,
  refused,
  unknown,
  type AdapterCapabilities,
  type AdapterResult,
  type DeliveryIdentity,
  type DeliveryPlan,
  type DeployInput,
  type DeployReceipt,
  type DeploymentAdapter,
  type HealthReading,
  type Lease,
  type RecoverInput,
  type Refused,
  type TargetRef,
  type TargetState,
} from "./deployment-adapter.js";

/** The operator opt-in. Anything but the exact value `teploy` leaves the legacy path in force. */
export const DEPLOY_ADAPTER_ENV = "SHIP_DEPLOY_ADAPTER";
export function deployAdapterFlagOn(env: NodeJS.ProcessEnv = process.env): boolean {
  return env[DEPLOY_ADAPTER_ENV] === "teploy";
}

/** Where leases live when the operator names no directory: inside the trusted copy. */
export const DEFAULT_LEASE_DIRNAME = ".teploy-ship-leases";

export const TEPLOY_UNSUPPORTED: readonly { capability: string; reason: string }[] = [
  {
    capability: "destination-fence-vs-manual-deploy",
    reason: "the lease is a file on the Ship host: it serialises Ship's own releases but a human running `teploy deploy` by hand (or another host not sharing the lease directory) is not fenced, and the pre-command status re-read leaves a window",
  },
  { capability: "provider-dry-run", reason: "no teploy command validates a deploy without acting, so plan() is a description and validatedByProvider is always false" },
  { capability: "target-generation-token", reason: "teploy status exposes no deploy generation; `generation` is a fingerprint of status (app, current_hash, container ID/image/state) that a same-hash same-container change would not move" },
  { capability: "recovery-artifact-digest", reason: "the recovery artifact is not recorded (version + a live container is the bar), so recovery is verified against the revision only" },
  { capability: "logs", reason: "the `teploy logs` invocation is not verified against the CLI, so no logs() is offered" },
  { capability: "provisioning", reason: "teploy deploys to an existing server; provisioning has its own authority and is not part of this adapter" },
  { capability: "recovery:redeploy-previous-artifact", reason: "\"previous\" is not a stable recovery target (rollbackDeploy)" },
  { capability: "recovery:roll-forward", reason: "no teploy roll-forward command exists; a redeploy of a known-good revision is a new delivery" },
];

export interface TeployAdapterOptions {
  /** The service (teploy.yml `app:`) this adapter is bound to. */
  service: string;
  /** The destination label the delivery was approved for. */
  destination: string;
  /** The trusted working copy: status/rollback/exec run here, and teploy.yml is read from here. */
  dir: string;
  run: CommandRunner;
  /** Where `teploy deploy` runs (the detached build tree in delivery.ts). Defaults to `dir`. */
  deployDir?: string;
  /** Lease directory. Absent means NO lease and NO fencing declared (the orchestrator then refuses to deploy). */
  leaseDir?: string;
  leaseTtlMs?: number;
  now?: () => Date;
  /** Optional telemetry binding. Absent means observe is not declared. */
  observe?: { service: string; read: () => Promise<{ health: HealthReading["health"]; reason: string }> };
}

interface StatusContainer { ID?: unknown; Name?: unknown; Image?: unknown; State?: unknown }
interface StatusDoc { app?: unknown; server?: unknown; state?: { current_hash?: unknown }; containers?: StatusContainer[] }

const STATUS_TIMEOUT = 120_000;
const DEPLOY_TIMEOUT = 900_000;
const EXEC_TIMEOUT = 60_000;

const idForm = (name: string): boolean => /^(sha256:)?[0-9a-f]{12,64}$/i.test(name);

export class TeployAdapter implements DeploymentAdapter {
  observe?: DeploymentAdapter["observe"];
  acquireLease?: DeploymentAdapter["acquireLease"];
  releaseLease?: DeploymentAdapter["releaseLease"];

  private readonly options: TeployAdapterOptions;
  private readonly now: () => Date;
  /** Artifacts this adapter was asked to plan: used only to choose WHICH observed image name to report. */
  private readonly known = new Set<string>();

  constructor(options: TeployAdapterOptions) {
    this.options = options;
    this.now = options.now ?? (() => new Date());
    if (options.observe !== undefined) {
      const binding = options.observe;
      this.observe = async (target) => {
        if (target.service !== binding.service) return unknown(`telemetry is bound to ${binding.service}, not ${target.service}`);
        try {
          const read = await binding.read();
          return ok({ service: binding.service, health: read.health, reason: read.reason });
        } catch (error) {
          return unknown(`telemetry read failed: ${error instanceof Error ? error.message : String(error)}`);
        }
      };
    }
    if (options.leaseDir !== undefined) {
      this.acquireLease = (target, holder) => this.lease(target, holder);
      this.releaseLease = (lease) => this.unlease(lease);
    }
  }

  capabilities(): AdapterCapabilities {
    return {
      adapter: "teploy",
      readback: true,
      logs: false,
      observe: this.observe !== undefined,
      dryRun: false,
      provisioning: false,
      fencing: this.options.leaseDir !== undefined ? ["lease"] : [],
      recovery: ["rollback-to-version"],
      unsupported: TEPLOY_UNSUPPORTED,
    };
  }

  private bound(target: TargetRef): Refused | undefined {
    if (target.service === this.options.service && target.destination === this.options.destination) return undefined;
    return refused(`this adapter is bound to ${this.options.service}@${this.options.destination}, not ${target.service}@${target.destination}`);
  }

  // -------------------------------------------------------------- reading

  /** The server as teploy.yml spells it (delivery.ts: exec by display name fails DNS in the worker). */
  private async execServer(doc: StatusDoc): Promise<string> {
    let server = typeof doc.server === "string" ? doc.server : "";
    try {
      const yml = await readFile(join(this.options.dir, "teploy.yml"), "utf8");
      const m = /^server:\s*(["']?)([^\s"']+)\1\s*$/m.exec(yml);
      if (m !== null) server = m[2]!;
    } catch {
      // keep the status-derived name; exec then fails and the read is unknown
    }
    return server;
  }

  /** Resolve an image ID to its RepoTags through the same SSH channel the deploy used. */
  private async tagsOf(name: string, server: string): Promise<string[] | undefined> {
    if (server === "") return undefined;
    const inspect = await this.options.run(["teploy", "exec", server, "--", "docker", "image", "inspect", name], { cwd: this.options.dir, timeoutMs: EXEC_TIMEOUT });
    if (inspect.code !== 0) return undefined;
    try {
      const docs = JSON.parse(inspect.stdout.trim()) as unknown;
      if (!Array.isArray(docs) || docs.length === 0) return undefined;
      const tags = (docs[0] as { RepoTags?: unknown }).RepoTags;
      return Array.isArray(tags) ? tags.filter((t): t is string => typeof t === "string") : [];
    } catch {
      return undefined;
    }
  }

  private async status(): Promise<AdapterResult<{ doc: StatusDoc; generation: string }>> {
    const read = await this.options.run(["teploy", "status", "--json"], { cwd: this.options.dir, timeoutMs: STATUS_TIMEOUT });
    if (read.code !== 0) return unknown(`target status could not be read (exit ${read.code}): ${(read.stderr || read.stdout).slice(0, 300)}`);
    let doc: StatusDoc;
    try {
      const parsed = JSON.parse(read.stdout.trim()) as unknown;
      if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return unknown(`target status was not an object: ${read.stdout.slice(0, 300)}`);
      doc = parsed as StatusDoc;
    } catch {
      return unknown(`target status was not JSON: ${read.stdout.slice(0, 300)}`);
    }
    if (typeof doc.app !== "string" || doc.app !== this.options.service) {
      return unknown(`status describes app ${typeof doc.app === "string" ? doc.app : "(none)"}, not ${this.options.service}; wrong-service attribution refused`);
    }
    const containers = (doc.containers ?? []).map((c) => [String(c.ID ?? ""), String(c.Image ?? ""), String(c.State ?? "")]).sort((a, b) => a.join("|").localeCompare(b.join("|")));
    const hash = typeof doc.state?.current_hash === "string" ? doc.state.current_hash : "";
    const generation = `status:${createHash("sha256").update(JSON.stringify({ app: doc.app, hash, containers })).digest("hex").slice(0, 32)}`;
    return ok({ doc, generation });
  }

  private async stateOf(hint?: string): Promise<AdapterResult<TargetState>> {
    const got = await this.status();
    if (got.kind !== "ok") return got;
    const { doc, generation } = got.value;
    const running = (doc.containers ?? []).filter((c) => c.State === "running");
    const hash = typeof doc.state?.current_hash === "string" ? doc.state.current_hash : "";
    const base = { service: this.options.service, destination: this.options.destination, generation };
    if (running.length === 0) {
      return ok({ ...base, serving: false, ...(hash !== "" ? { revision: hash } : {}) });
    }
    const wanted = new Set([...(hint !== undefined ? [hint] : []), ...this.known]);
    const server = await this.execServer(doc);
    const plain: string[] = [];
    const unresolved: string[] = [];
    let matched: string | undefined;
    let firstTag: string | undefined;
    for (const c of running) {
      const name = typeof c.Image === "string" ? c.Image : "";
      if (name === "") continue;
      if (wanted.has(name)) { matched = name; break; }
      if (!idForm(name)) { plain.push(name); continue; }
      const tags = await this.tagsOf(name, server);
      if (tags === undefined) { unresolved.push(name); continue; }
      const hit = [...wanted].find((w) => tags.some((t) => t === w || t.startsWith(`${w}:`)));
      if (hit !== undefined) { matched = hit; break; }
      firstTag ??= tags[0];
    }
    // A lost read of an image ID is not evidence of a different artifact
    // (delivery.ts's "unresolved" answer): unknown, so the caller retries.
    if (matched === undefined && unresolved.length > 0 && plain.length === 0) {
      return unknown(`running image(s) [${unresolved.join(", ")}] could not be resolved to tags through teploy exec on ${server === "" ? "(no server)" : server}`);
    }
    const artifact = matched ?? plain[0] ?? firstTag;
    return ok({ ...base, serving: true, ...(hash !== "" ? { revision: hash } : {}), ...(artifact !== undefined ? { artifact } : {}) });
  }

  async inspect(target: TargetRef): Promise<AdapterResult<TargetState>> {
    const unbound = this.bound(target);
    if (unbound !== undefined) return unbound;
    return this.stateOf((target as Partial<DeliveryIdentity>).artifact);
  }

  async readback(target: TargetRef): Promise<AdapterResult<TargetState>> {
    const unbound = this.bound(target);
    if (unbound !== undefined) return unbound;
    // Callers pass the DeliveryIdentity they are verifying; its artifact only
    // chooses which OBSERVED image name to report, never what is reported.
    return this.stateOf((target as Partial<DeliveryIdentity>).artifact);
  }

  // -------------------------------------------------------------- acting

  async plan(identity: DeliveryIdentity, baseline: TargetState): Promise<AdapterResult<DeliveryPlan>> {
    const unbound = this.bound(identity);
    if (unbound !== undefined) return unbound;
    if (baseline.service !== identity.service || baseline.destination !== identity.destination) {
      return refused("the baseline describes a different target than the one being planned");
    }
    if (identity.artifact.trim() === "" || identity.revision.trim() === "") return refused("a teploy deploy needs both an image and a version");
    this.known.add(identity.artifact);
    return ok({
      planId: `teploy-${identity.revision}-${baseline.generation.slice(-8)}`,
      identity,
      baseline: { generation: baseline.generation, ...(baseline.revision !== undefined ? { revision: baseline.revision } : {}), ...(baseline.artifact !== undefined ? { artifact: baseline.artifact } : {}) },
      steps: [`teploy deploy --image ${identity.artifact} --version ${identity.revision} --skip-dns-check`],
      validatedByProvider: false,
    });
  }

  private async leaseHeld(lease: Lease): Promise<boolean> {
    if (this.options.leaseDir === undefined) return false;
    try {
      const held = JSON.parse(await readFile(this.leasePath(lease.target), "utf8")) as { token?: unknown; expiresAt?: unknown };
      return held.token === lease.token && typeof held.expiresAt === "string" && Date.parse(held.expiresAt) > this.now().getTime();
    } catch {
      return false;
    }
  }

  async deploy(input: DeployInput): Promise<DeployReceipt> {
    const { plan } = input;
    const identity = plan.identity;
    const unbound = this.bound(identity);
    if (unbound !== undefined) return { outcome: "rejected", rejection: "other", detail: unbound.reason };
    const authority = authorisationCovers(input.authorisation, "deploy", identity, this.now());
    if (!authority.ok) return { outcome: "rejected", rejection: "unauthorised", detail: authority.reason };
    if (input.lease !== undefined && !(await this.leaseHeld(input.lease))) {
      return { outcome: "rejected", rejection: "other", detail: "the destination lease is not held (expired, released or taken); not acting" };
    }
    // Pre-command compare: narrows, but cannot close, the window between this
    // read and the command (declared in `unsupported`).
    const now = await this.status();
    if (now.kind !== "ok") return { outcome: "rejected", rejection: "other", detail: `the target could not be read before deploy (${now.reason}); not acting on an unread target` };
    if (now.value.generation !== input.expectGeneration) {
      return { outcome: "rejected", rejection: "stale-generation", detail: "the target's status changed since the plan was made; nothing was run" };
    }
    this.known.add(identity.artifact);
    const ran = await this.options.run(
      ["teploy", "deploy", "--image", identity.artifact, "--version", identity.revision, "--skip-dns-check"],
      { cwd: this.options.deployDir ?? this.options.dir, timeoutMs: DEPLOY_TIMEOUT },
    );
    if (ran.code !== 0) {
      // A non-zero exit may follow a swap (a timeout after the switch): never "rejected".
      return { outcome: "indeterminate", detail: `teploy deploy exited ${ran.code}: ${(ran.stderr || ran.stdout).slice(0, 300)}; the target may have changed` };
    }
    const after = await this.stateOf(identity.artifact);
    if (after.kind === "ok" && after.value.serving && after.value.revision === identity.revision && after.value.artifact === identity.artifact) {
      return { outcome: "applied", detail: "teploy deploy exited 0 and status shows the approved version and image" };
    }
    return { outcome: "indeterminate", detail: `teploy deploy exited 0 but ${after.kind === "ok" ? `status shows ${after.value.revision ?? "(none)"} / ${after.value.artifact ?? "(no image)"}` : `status could not be read (${after.reason})`}` };
  }

  async recover(input: RecoverInput): Promise<DeployReceipt> {
    const { plan } = input;
    const unbound = this.bound(plan.target);
    if (unbound !== undefined) return { outcome: "rejected", rejection: "other", detail: unbound.reason };
    if (plan.mode !== "rollback-to-version") {
      return { outcome: "rejected", rejection: "other", detail: `teploy supports only rollback-to-version, not ${plan.mode}; nothing was run` };
    }
    const authority = authorisationCovers(input.authorisation, "recover", plan.target, this.now());
    if (!authority.ok) return { outcome: "rejected", rejection: "unauthorised", detail: authority.reason };
    if (plan.to.revision.trim() === "") return { outcome: "rejected", rejection: "other", detail: "recovery needs an explicit retained version" };
    if (input.lease !== undefined && !(await this.leaseHeld(input.lease))) {
      return { outcome: "rejected", rejection: "other", detail: "the destination lease is not held; not acting" };
    }
    const now = await this.status();
    if (now.kind !== "ok") return { outcome: "rejected", rejection: "other", detail: `the target could not be read before rollback (${now.reason})` };
    if (now.value.generation !== input.expectGeneration) {
      return { outcome: "rejected", rejection: "stale-generation", detail: "the target's status changed since the recovery was planned; nothing was run" };
    }
    const ran = await this.options.run(["teploy", "rollback", "--to", plan.to.revision], { cwd: this.options.dir, timeoutMs: DEPLOY_TIMEOUT });
    if (ran.code !== 0) {
      return { outcome: "indeterminate", detail: `teploy rollback exited ${ran.code}: ${(ran.stderr || ran.stdout).slice(0, 300)}; the target may have changed` };
    }
    const after = await this.stateOf(plan.to.artifact);
    if (after.kind === "ok" && after.value.serving && after.value.revision === plan.to.revision) {
      return { outcome: "applied", detail: `teploy rollback exited 0 and status shows ${plan.to.revision} serving` };
    }
    return { outcome: "indeterminate", detail: `teploy rollback exited 0 but ${after.kind === "ok" ? `status shows ${after.value.revision ?? "(none)"}` : `status could not be read (${after.reason})`}` };
  }

  // -------------------------------------------------------------- lease

  private leasePath(target: TargetRef): string {
    return join(this.options.leaseDir!, `${encodeURIComponent(`${target.service}@${target.destination}`)}.lease`);
  }

  private async lease(target: TargetRef, holder: string): Promise<AdapterResult<Lease>> {
    const unbound = this.bound(target);
    if (unbound !== undefined) return unbound;
    const path = this.leasePath(target);
    const ttl = this.options.leaseTtlMs ?? 20 * 60_000;
    const token = randomUUID();
    const body = (): string => JSON.stringify({ token, holder, expiresAt: new Date(this.now().getTime() + ttl).toISOString() });
    try {
      await mkdir(this.options.leaseDir!, { recursive: true });
      for (let attempt = 0; attempt < 2; attempt++) {
        try {
          await writeFile(path, body(), { flag: "wx" });
          return ok({ target: { service: target.service, destination: target.destination }, token, holder });
        } catch (error) {
          if ((error as { code?: unknown }).code !== "EEXIST") throw error;
        }
        let held: { holder?: unknown; expiresAt?: unknown };
        try {
          held = JSON.parse(await readFile(path, "utf8")) as typeof held;
        } catch {
          return refused("a lease file exists and cannot be read; refusing to break it");
        }
        const expires = typeof held.expiresAt === "string" ? Date.parse(held.expiresAt) : NaN;
        if (!Number.isFinite(expires) || expires > this.now().getTime()) {
          return refused(`the destination is leased${typeof held.holder === "string" ? ` by ${held.holder}` : ""}`);
        }
        await unlink(path).catch(() => undefined); // an expired lease: the holder's TTL ran out
      }
      return refused("the destination lease was taken while reclaiming an expired one");
    } catch (error) {
      return unknown(`the lease directory could not be used: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  private async unlease(lease: Lease): Promise<void> {
    const path = this.leasePath(lease.target);
    try {
      const held = JSON.parse(await readFile(path, "utf8")) as { token?: unknown };
      if (held.token === lease.token) await unlink(path);
    } catch {
      // gone or unreadable: the TTL is the backstop
    }
  }
}

/** The service a trusted copy serves: its teploy.yml `app:` line, as teploy itself reads it. */
export async function serviceFromTeployYml(dir: string): Promise<string | undefined> {
  try {
    const yml = await readFile(join(dir, "teploy.yml"), "utf8");
    const m = /^app:\s*(["']?)([^\s"']+)\1\s*$/m.exec(yml);
    return m === null ? undefined : m[2]!;
  } catch {
    return undefined;
  }
}

/**
 * The factory delivery.ts takes under SHIP_DEPLOY_ADAPTER=teploy: one adapter
 * per use, bound to the trusted copy's service (its teploy.yml `app:`) and the
 * approved destination. No readable `app:` means no adapter (an honest hold),
 * never a guessed service.
 */
export function teployDeliveryAdapterFactory(options: { dir: string; run: CommandRunner; leaseDir?: string; env?: NodeJS.ProcessEnv }): DeliveryAdapterFactory {
  const env = options.env ?? process.env;
  return {
    async create({ deployDir, destination }) {
      const service = await serviceFromTeployYml(options.dir);
      if (service === undefined) return { unavailable: `no \`app:\` line readable in ${join(options.dir, "teploy.yml")}, so the service this trusted copy serves is unknown` };
      const leaseDir = options.leaseDir ?? (env.SHIP_DEPLOY_LEASE_DIR !== undefined && env.SHIP_DEPLOY_LEASE_DIR !== "" ? env.SHIP_DEPLOY_LEASE_DIR : join(options.dir, DEFAULT_LEASE_DIRNAME));
      return { service, adapter: new TeployAdapter({ service, destination, dir: options.dir, run: options.run, deployDir, leaseDir }) };
    },
  };
}
