/**
 * Budget reservation ledger and write fencing (S11).
 *
 * Two defects this exists to close, both of the "read, decide, write" shape:
 *
 * 1. `SpendStore.reserve` (spend.ts) holds money per SOURCE per day, but knows
 *    nothing about parent/child tasks or retries: a parent with a $5 cap can
 *    have ten children each admitted against their own $1 view of "room left".
 *    The ledger below makes the whole tree one decision: a reserve is checked
 *    against its scope AND every ancestor, in one transaction, so the sum of
 *    live child holds can never exceed a parent's cap.
 * 2. A worker whose lease expired keeps running and keeps writing. A second
 *    worker takes over and now two actors write. Each resource carries a
 *    monotonic epoch (the lease generation); a write presenting an older epoch
 *    is refused. The fence check lives in the SAME transaction as the write it
 *    guards — checked-then-written separately would be the same race again.
 *
 * Unknown pricing: a settlement that cannot be priced is never recorded as $0
 * (that is how a spend cap fails open; see UNKNOWN_MODEL_PRICING in pricing.ts).
 * It KEEPS its reservation, is counted separately, and holds until an operator
 * resolves it with a real number. Late usage after a release (cancellation,
 * lease loss) is recorded as an overrun and counts against the cap; it is
 * never dropped, because the provider bills it regardless.
 *
 * ATOMICITY CEILING: the in-memory ledger is atomic within one process (a
 * promise-chain mutex). The file-backed ledger is atomic across callers in ONE
 * process (file-store.ts withFileLock) and its writes are crash-safe (temp +
 * fsync + rename), but two PROCESSES can still both read, decide and rename.
 * Cross-process atomicity needs a Nucleus conditional write (compare-and-set on
 * the ledger document's version, or a single `UPDATE ... WHERE committed + $n
 * <= cap` per scope chain). That is NOT done here and nothing in this module
 * should be described as multi-process safe.
 *
 * Money is held internally as integer micro-USD so repeated add/subtract of
 * cents cannot drift a total across the cap.
 */
import { readJsonFile, withFileLock, writeJsonFile } from "./file-store.js";

export type ScopeKind = "parent" | "child" | "retry";

export interface ScopeSpec {
  id: string;
  kind: ScopeKind;
  /** Hard cap in USD for everything held or spent under this scope (descendants included). */
  capUSD: number;
  /** Required for child/retry scopes; the parent scope must already exist. */
  parentId?: string;
}

/** Epoch presented by a writer; see {@link checkFence}. */
export interface FenceToken {
  resource: string;
  epoch: number;
}

export type ReservationState = "held" | "settled" | "unpriced-held" | "released";

export interface ReservationView {
  reservationId: string;
  scopeId: string;
  state: ReservationState;
  reservedUSD: number;
  /** Priced actual, once settled (or operator-resolved). */
  actualUSD?: number;
}

export type Refusal =
  | { ok: false; reason: "over-cap"; scopeId: string; capUSD: number; committedUSD: number; requestedUSD: number }
  | { ok: false; reason: "unknown-scope"; scopeId: string }
  | { ok: false; reason: "stale-epoch"; resource: string; presented: number; current: number | undefined }
  | { ok: false; reason: "unknown-reservation"; reservationId: string }
  | { ok: false; reason: "already-settled"; reservationId: string }
  | { ok: false; reason: "not-unpriced-held"; reservationId: string }
  | { ok: false; reason: "invalid"; detail: string };

export type ReserveResult = { ok: true; reservation: ReservationView; replay: boolean } | Refusal;

export type SettleOutcome =
  | { ok: true; recorded: "settled"; overrunUSD: number }
  /** The reservation is HELD, not zeroed, until {@link ReservationLedger.resolveUnpriced}. */
  | { ok: true; recorded: "unpriced-held" }
  /** Usage arrived after release: counted as overrun, never dropped. */
  | { ok: true; recorded: "late-overrun"; overrunUSD: number }
  /** Unpriced usage arrived after release: nothing to hold, so it is counted and flagged. */
  | { ok: true; recorded: "late-unpriced" }
  | Refusal;

export type Settlement = { priced: true; actualUSD: number } | { priced: false };

export interface ScopeSnapshot {
  scopeId: string;
  capUSD: number;
  /** Live holds + priced spend + unpriced holds + late overruns, descendants included. */
  committedUSD: number;
  heldUSD: number;
  settledUSD: number;
  /** Money still held by unpriced settlements awaiting an operator. */
  unpricedHeldUSD: number;
  /** Count of unpriced settlements (held or late) — shown separately, never as $0 spend. */
  unpricedCount: number;
  overrunUSD: number;
  remainingUSD: number;
}

export interface ReservationLedger {
  defineScope(spec: ScopeSpec): Promise<{ ok: true } | Refusal>;
  reserve(
    args: { reservationId: string; scopeId: string; amountUSD: number },
    fence?: FenceToken,
  ): Promise<ReserveResult>;
  settle(reservationId: string, settlement: Settlement, fence?: FenceToken): Promise<SettleOutcome>;
  release(reservationId: string, fence?: FenceToken): Promise<{ ok: true; released: boolean } | Refusal>;
  /** Operator supplies the real cost of an unpriced settlement; its hold converts to spend. */
  resolveUnpriced(reservationId: string, actualUSD: number): Promise<SettleOutcome>;
  snapshot(scopeId: string): Promise<ScopeSnapshot | Refusal>;
  /** A new worker takes the resource: returns the next epoch; older tokens are refused from now on. */
  takeOver(resource: string): Promise<number>;
}

// ---------------------------------------------------------------------------
// Fencing (pure)
// ---------------------------------------------------------------------------

/**
 * Is a write carrying `presented` allowed against a resource whose newest
 * issued epoch is `current`? Only an exact match is. Older is a stale worker.
 * NEWER is refused too: an epoch nobody was issued is a forged or corrupted
 * token, and honouring it would let it silently outrank the real holder.
 * No epoch issued yet (`undefined`) refuses every write: acquire first.
 */
export function checkFence(current: number | undefined, presented: number): { ok: true } | { ok: false; reason: string } {
  if (!Number.isInteger(presented) || presented < 1) return { ok: false, reason: `epoch ${presented} is not a positive integer` };
  if (current === undefined) return { ok: false, reason: "no epoch has been issued for this resource" };
  if (presented < current) return { ok: false, reason: `stale epoch ${presented}, current is ${current}` };
  if (presented > current) return { ok: false, reason: `epoch ${presented} was never issued, current is ${current}` };
  return { ok: true };
}

/** The next epoch for a resource. Monotonic: never reused, never lowered. */
export function nextEpoch(current: number | undefined): number {
  return (current ?? 0) + 1;
}

// ---------------------------------------------------------------------------
// State and pure transitions
// ---------------------------------------------------------------------------

interface ScopeRec {
  id: string;
  kind: ScopeKind;
  capMicro: number;
  parentId?: string;
}

interface ResRec {
  id: string;
  scopeId: string;
  state: ReservationState;
  reservedMicro: number;
  /** Priced spend recorded against this reservation. */
  actualMicro?: number;
  /** Usage beyond what was reserved (or after release). */
  overrunMicro: number;
  /** Unpriced usage that arrived after release, recorded without a hold. */
  lateUnpriced: number;
}

export interface LedgerState {
  scopes: Record<string, ScopeRec>;
  reservations: Record<string, ResRec>;
  epochs: Record<string, number>;
}

const emptyState = (): LedgerState => ({ scopes: {}, reservations: {}, epochs: {} });

const toMicro = (usd: number): number => Math.round(usd * 1_000_000);
const toUSD = (micro: number): number => micro / 1_000_000;

function validMoney(usd: number, allowZero: boolean): boolean {
  return Number.isFinite(usd) && (allowZero ? usd >= 0 : usd > 0);
}

/** The scope and every ancestor, nearest first; undefined if any link is missing or cyclic. */
function chain(state: LedgerState, scopeId: string): ScopeRec[] | undefined {
  const out: ScopeRec[] = [];
  const seen = new Set<string>();
  let cur: string | undefined = scopeId;
  while (cur !== undefined) {
    const s: ScopeRec | undefined = state.scopes[cur];
    if (s === undefined || seen.has(cur)) return undefined;
    seen.add(cur);
    out.push(s);
    cur = s.parentId;
  }
  return out;
}

/**
 * What one reservation contributes to the cap. A released hold contributes
 * only late overrun; a settled one its actual (which already includes any
 * overrun past the reservation).
 */
function contribution(r: ResRec): number {
  switch (r.state) {
    case "held":
    case "unpriced-held":
      return r.reservedMicro + r.overrunMicro;
    case "settled":
      return r.actualMicro ?? 0;
    case "released":
      return r.overrunMicro;
  }
}

function inScope(state: LedgerState, r: ResRec, scopeId: string): boolean {
  const c = chain(state, r.scopeId);
  return c !== undefined && c.some((s) => s.id === scopeId);
}

function committedMicro(state: LedgerState, scopeId: string): number {
  let sum = 0;
  for (const r of Object.values(state.reservations)) if (inScope(state, r, scopeId)) sum += contribution(r);
  return sum;
}

function fenceRefusal(state: LedgerState, fence: FenceToken | undefined): Refusal | undefined {
  if (fence === undefined) return undefined;
  const current = state.epochs[fence.resource];
  const verdict = checkFence(current, fence.epoch);
  return verdict.ok ? undefined : { ok: false, reason: "stale-epoch", resource: fence.resource, presented: fence.epoch, current };
}

function view(r: ResRec): ReservationView {
  return {
    reservationId: r.id,
    scopeId: r.scopeId,
    state: r.state,
    reservedUSD: toUSD(r.reservedMicro),
    ...(r.actualMicro !== undefined ? { actualUSD: toUSD(r.actualMicro) } : {}),
  };
}

function defineScopeIn(state: LedgerState, spec: ScopeSpec): { ok: true } | Refusal {
  if (!validMoney(spec.capUSD, false)) return { ok: false, reason: "invalid", detail: `cap ${spec.capUSD} must be a positive number` };
  if (spec.kind !== "parent" && spec.parentId === undefined) return { ok: false, reason: "invalid", detail: `${spec.kind} scope needs a parentId` };
  if (spec.parentId !== undefined && state.scopes[spec.parentId] === undefined) return { ok: false, reason: "unknown-scope", scopeId: spec.parentId };
  const existing = state.scopes[spec.id];
  if (existing !== undefined) {
    // Idempotent for an identical definition; a different cap on an existing
    // scope is a refusal, not a silent resize of a limit others rely on.
    const same = existing.capMicro === toMicro(spec.capUSD) && existing.kind === spec.kind && existing.parentId === spec.parentId;
    return same ? { ok: true } : { ok: false, reason: "invalid", detail: `scope ${spec.id} already defined differently` };
  }
  state.scopes[spec.id] = {
    id: spec.id,
    kind: spec.kind,
    capMicro: toMicro(spec.capUSD),
    ...(spec.parentId !== undefined ? { parentId: spec.parentId } : {}),
  };
  return { ok: true };
}

function reserveIn(
  state: LedgerState,
  a: { reservationId: string; scopeId: string; amountUSD: number },
  fence?: FenceToken,
): ReserveResult {
  const stale = fenceRefusal(state, fence);
  if (stale) return stale;
  if (!validMoney(a.amountUSD, false)) return { ok: false, reason: "invalid", detail: `amount ${a.amountUSD} must be a positive number` };
  const prior = state.reservations[a.reservationId];
  // Idempotent by id (a retried admission must not hold twice) — but only for
  // the same scope; reusing an id elsewhere is a caller bug, not a replay.
  if (prior !== undefined) {
    return prior.scopeId === a.scopeId
      ? { ok: true, reservation: view(prior), replay: true }
      : { ok: false, reason: "invalid", detail: `reservation ${a.reservationId} exists under scope ${prior.scopeId}` };
  }
  const scopes = chain(state, a.scopeId);
  if (scopes === undefined) return { ok: false, reason: "unknown-scope", scopeId: a.scopeId };
  const amount = toMicro(a.amountUSD);
  // Every ancestor is checked before anything is written: a child under its
  // own cap still loses to a parent that is full.
  for (const s of scopes) {
    const committed = committedMicro(state, s.id);
    if (committed + amount > s.capMicro) {
      return { ok: false, reason: "over-cap", scopeId: s.id, capUSD: toUSD(s.capMicro), committedUSD: toUSD(committed), requestedUSD: a.amountUSD };
    }
  }
  const rec: ResRec = { id: a.reservationId, scopeId: a.scopeId, state: "held", reservedMicro: amount, overrunMicro: 0, lateUnpriced: 0 };
  state.reservations[a.reservationId] = rec;
  return { ok: true, reservation: view(rec), replay: false };
}

function settleIn(state: LedgerState, id: string, s: Settlement, fence?: FenceToken): SettleOutcome {
  const stale = fenceRefusal(state, fence);
  if (stale) return stale;
  const r = state.reservations[id];
  if (r === undefined) return { ok: false, reason: "unknown-reservation", reservationId: id };
  if (s.priced && !validMoney(s.actualUSD, true)) return { ok: false, reason: "invalid", detail: `actual ${s.actualUSD} must be a non-negative number` };
  if (r.state === "settled" || r.state === "unpriced-held") return { ok: false, reason: "already-settled", reservationId: id };
  if (r.state === "released") {
    // Late usage: the money was released but the provider billed anyway.
    if (!s.priced) {
      r.lateUnpriced += 1;
      return { ok: true, recorded: "late-unpriced" };
    }
    const late = toMicro(s.actualUSD);
    r.overrunMicro += late;
    return { ok: true, recorded: "late-overrun", overrunUSD: toUSD(late) };
  }
  if (!s.priced) {
    r.state = "unpriced-held";
    return { ok: true, recorded: "unpriced-held" };
  }
  const actual = toMicro(s.actualUSD);
  r.state = "settled";
  r.actualMicro = actual;
  r.overrunMicro = Math.max(0, actual - r.reservedMicro);
  return { ok: true, recorded: "settled", overrunUSD: toUSD(r.overrunMicro) };
}

function snapshotIn(state: LedgerState, scopeId: string): ScopeSnapshot | Refusal {
  const sc = state.scopes[scopeId];
  if (sc === undefined) return { ok: false, reason: "unknown-scope", scopeId };
  let held = 0;
  let settled = 0;
  let unpricedHeld = 0;
  let unpricedCount = 0;
  let overrun = 0;
  for (const r of Object.values(state.reservations)) {
    if (!inScope(state, r, scopeId)) continue;
    if (r.state === "held") held += r.reservedMicro;
    if (r.state === "settled") settled += r.actualMicro ?? 0;
    if (r.state === "unpriced-held") {
      unpricedHeld += r.reservedMicro;
      unpricedCount += 1;
    }
    unpricedCount += r.lateUnpriced;
    overrun += r.overrunMicro;
  }
  const committed = committedMicro(state, scopeId);
  return {
    scopeId,
    capUSD: toUSD(sc.capMicro),
    committedUSD: toUSD(committed),
    heldUSD: toUSD(held),
    settledUSD: toUSD(settled),
    unpricedHeldUSD: toUSD(unpricedHeld),
    unpricedCount,
    overrunUSD: toUSD(overrun),
    remainingUSD: toUSD(Math.max(0, sc.capMicro - committed)),
  };
}

// ---------------------------------------------------------------------------
// Ledger over a transactional backend
// ---------------------------------------------------------------------------

/** One read-decide-write unit. Backends must not interleave two of these. */
export interface LedgerBackend {
  transact<T>(fn: (state: LedgerState) => T): Promise<T>;
}

class TransactionalLedger implements ReservationLedger {
  constructor(private readonly backend: LedgerBackend) {}
  defineScope(spec: ScopeSpec) {
    return this.backend.transact((s) => defineScopeIn(s, spec));
  }
  reserve(args: { reservationId: string; scopeId: string; amountUSD: number }, fence?: FenceToken) {
    return this.backend.transact((s) => reserveIn(s, args, fence));
  }
  settle(id: string, settlement: Settlement, fence?: FenceToken) {
    return this.backend.transact((s) => settleIn(s, id, settlement, fence));
  }
  release(id: string, fence?: FenceToken) {
    return this.backend.transact((s): { ok: true; released: boolean } | Refusal => {
      const stale = fenceRefusal(s, fence);
      if (stale) return stale;
      const r = s.reservations[id];
      if (r === undefined) return { ok: false, reason: "unknown-reservation", reservationId: id };
      // Only a plain hold can be released. Settled spend happened; an unpriced
      // hold must stay until an operator resolves it — releasing it would turn
      // unknown spend into $0, the exact failure this ledger refuses.
      if (r.state !== "held") return { ok: true, released: r.state === "released" };
      r.state = "released";
      return { ok: true, released: true };
    });
  }
  resolveUnpriced(id: string, actualUSD: number) {
    return this.backend.transact((s): SettleOutcome => {
      const r = s.reservations[id];
      if (r === undefined) return { ok: false, reason: "unknown-reservation", reservationId: id };
      if (r.state !== "unpriced-held") return { ok: false, reason: "not-unpriced-held", reservationId: id };
      if (!validMoney(actualUSD, true)) return { ok: false, reason: "invalid", detail: `actual ${actualUSD} must be a non-negative number` };
      const actual = toMicro(actualUSD);
      r.state = "settled";
      r.actualMicro = actual;
      r.overrunMicro = Math.max(0, actual - r.reservedMicro);
      return { ok: true, recorded: "settled", overrunUSD: toUSD(r.overrunMicro) };
    });
  }
  snapshot(scopeId: string) {
    return this.backend.transact((s) => snapshotIn(s, scopeId));
  }
  takeOver(resource: string) {
    return this.backend.transact((s) => {
      const next = nextEpoch(s.epochs[resource]);
      s.epochs[resource] = next;
      return next;
    });
  }
}

/** In-memory backend: a promise-chain mutex, atomic within this process. */
export class MemoryLedgerBackend implements LedgerBackend {
  private state: LedgerState = emptyState();
  private tail: Promise<unknown> = Promise.resolve();
  transact<T>(fn: (state: LedgerState) => T): Promise<T> {
    const run = this.tail.then(() => {
      // Work on a copy and commit only on success, so a throwing transition
      // cannot leave a half-applied state behind.
      const draft = structuredClone(this.state);
      const out = fn(draft);
      this.state = draft;
      return out;
    });
    this.tail = run.catch(() => undefined);
    return run;
  }
}

/**
 * File backend: read + decide + atomic write under `withFileLock(path)`.
 * Serializes callers in this process only — see the ATOMICITY CEILING above.
 * A throwing transition writes nothing.
 */
export class FileLedgerBackend implements LedgerBackend {
  constructor(private readonly path: string) {}
  transact<T>(fn: (state: LedgerState) => T): Promise<T> {
    return withFileLock(this.path, async () => {
      const current = await readJsonFile<LedgerState>(this.path, emptyState());
      const out = fn(current);
      await writeJsonFile(this.path, current);
      return out;
    });
  }
}

export function memoryReservationLedger(): ReservationLedger {
  return new TransactionalLedger(new MemoryLedgerBackend());
}

export function fileReservationLedger(path: string): ReservationLedger {
  return new TransactionalLedger(new FileLedgerBackend(path));
}
