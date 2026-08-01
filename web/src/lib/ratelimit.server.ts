/**
 * In-process rate limiting for the unauthenticated login surface.
 *
 * `/login` is exempt from the auth middleware (it has to be), performs a scrypt
 * derivation on EVERY attempt including misses (deliberately — it hides which
 * usernames exist), and had no limit of any kind. Both halves of that are a
 * problem: unlimited guesses against whatever passwords exist, and an
 * unauthenticated way to make the process do unbounded scrypt work, which runs
 * on libuv's threadpool and therefore competes with the store I/O the rest of
 * the app needs.
 *
 * Deliberately in-process and not in Nucleus: this must keep working when the
 * database is the thing under strain, and a per-replica limit is the useful
 * part of the protection. A determined attacker spreading across replicas still
 * hits the concurrency ceiling below, which is what protects the event loop.
 */

interface Bucket {
  /** Attempt timestamps within the window. */
  hits: number[];
  /** Set while a lockout is in force. */
  lockedUntil?: number;
}

const buckets = new Map<string, Bucket>();

export interface RateLimitConfig {
  /** Attempts allowed per window, per key. */
  limit: number;
  windowMs: number;
  /** How long a key is locked out once it exceeds the limit. */
  lockoutMs: number;
  /** Password verifications allowed to be in flight at once, process-wide. */
  maxConcurrent: number;
}

export const loginLimits: RateLimitConfig = {
  limit: 10,
  windowMs: 5 * 60_000,
  lockoutMs: 5 * 60_000,
  maxConcurrent: 4,
};

export interface RateLimitResult {
  allowed: boolean;
  /** Seconds until the caller may try again (only when blocked). */
  retryAfterSeconds?: number;
}

/** Record an attempt for `key`, and say whether it may proceed. */
export function checkRateLimit(key: string, now = Date.now(), config: RateLimitConfig = loginLimits): RateLimitResult {
  const bucket = buckets.get(key) ?? { hits: [] };
  if (bucket.lockedUntil !== undefined && bucket.lockedUntil > now) {
    return { allowed: false, retryAfterSeconds: Math.ceil((bucket.lockedUntil - now) / 1000) };
  }
  bucket.hits = bucket.hits.filter((t) => now - t < config.windowMs);
  bucket.hits.push(now);
  if (bucket.hits.length > config.limit) {
    bucket.lockedUntil = now + config.lockoutMs;
    bucket.hits = [];
    buckets.set(key, bucket);
    return { allowed: false, retryAfterSeconds: Math.ceil(config.lockoutMs / 1000) };
  }
  delete bucket.lockedUntil;
  buckets.set(key, bucket);
  // Opportunistic sweep so the map cannot grow without bound from one-off keys.
  if (buckets.size > 10_000) {
    for (const [k, b] of buckets) {
      if (b.hits.length === 0 && (b.lockedUntil ?? 0) < now) buckets.delete(k);
    }
  }
  return { allowed: true };
}

/** A successful login clears the key, so a legitimate user is never punished for typos. */
export function clearRateLimit(key: string): void {
  buckets.delete(key);
}

/** Test seam. */
export function resetRateLimits(): void {
  buckets.clear();
}

let inFlight = 0;

/**
 * Run `fn` under a process-wide concurrency ceiling.
 *
 * Rejecting past the ceiling is the point: scrypt is CPU-bound work on the
 * threadpool, so a burst of login attempts could otherwise starve every other
 * async file and database operation in the process. Shedding load here keeps
 * the rest of the dashboard responsive while a flood is in progress.
 */
export async function withVerifySlot<T>(
  fn: () => Promise<T>,
  config: RateLimitConfig = loginLimits,
): Promise<{ shed: true } | { shed: false; value: T }> {
  // A discriminated result, not null: "we refused to do the work" and "the
  // password was wrong" are different answers and must not collapse into one,
  // or a user hitting a busy server is told their credentials are bad.
  if (inFlight >= config.maxConcurrent) return { shed: true };
  inFlight += 1;
  try {
    return { shed: false, value: await fn() };
  } finally {
    inFlight -= 1;
  }
}

/**
 * Best-effort client identity for limiting.
 *
 * The forwarded headers are only believed when the operator has declared a
 * proxy (same rule as everything else here); otherwise every request shares one
 * bucket, which is strictly safer — it cannot be split by spoofing a header.
 */
export function clientKey(request: Request, trustProxy: boolean): string {
  if (trustProxy) {
    const forwarded = request.headers.get("x-forwarded-for")?.split(",")[0]?.trim();
    if (forwarded !== undefined && forwarded !== "") return `ip:${forwarded}`;
  }
  return "ip:shared";
}
