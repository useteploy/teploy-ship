/**
 * In-process rate limiting for the unauthenticated login surface.
 *
 * `/login` is exempt from the auth middleware (it has to be), performs a scrypt
 * derivation on EVERY attempt including misses (deliberately — it hides which
 * usernames exist), and had no limit of any kind: unlimited guesses, plus an
 * unauthenticated way to make the process do unbounded scrypt work on libuv's
 * threadpool, competing with the store I/O the rest of the app needs.
 *
 * The shape matters as much as the existence. OWASP's guidance on lockouts is
 * that an aggressive one is itself a denial-of-service vector — an attacker who
 * can lock accounts (or, worse, lock everyone) has found a cheaper attack than
 * the one being prevented. So this deliberately does NOT hard-lock on anything
 * an attacker can choose:
 *
 *   per client IP  — lockout, but only when a declared proxy makes the address
 *                    trustworthy. The attacker is the one locked out.
 *   per username   — increasing delay, never a lock. Otherwise anyone who knows
 *                    a username can lock its owner out at will.
 *   no trusted IP  — NO lockout at all. A shared bucket would mean ten failures
 *                    from anywhere logs the whole instance out, which is a
 *                    self-inflicted outage. Delay plus the concurrency ceiling
 *                    carry it instead.
 *
 * In-process rather than in Nucleus on purpose: this has to keep working when
 * the database is the thing under strain.
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
  /** Artificial delay to apply before answering, for keys that must not lock. */
  delayMs?: number;
}

/**
 * Record an attempt for `key`.
 *
 * `lockable` decides the response to going over the limit: a hard lock (safe
 * only when the key identifies the ATTACKER, i.e. a trustworthy client
 * address) or an increasing delay (everything else). Delay still makes
 * guessing impractical without handing anyone an outage button.
 */
export function checkRateLimit(
  key: string,
  now = Date.now(),
  config: RateLimitConfig = loginLimits,
  lockable = false,
): RateLimitResult {
  const bucket = buckets.get(key) ?? { hits: [] };
  if (bucket.lockedUntil !== undefined && bucket.lockedUntil > now) {
    return { allowed: false, retryAfterSeconds: Math.ceil((bucket.lockedUntil - now) / 1000) };
  }
  bucket.hits = bucket.hits.filter((t) => now - t < config.windowMs);
  bucket.hits.push(now);
  if (bucket.hits.length > config.limit) {
    if (lockable) {
      bucket.lockedUntil = now + config.lockoutMs;
      bucket.hits = [];
      buckets.set(key, bucket);
      return { allowed: false, retryAfterSeconds: Math.ceil(config.lockoutMs / 1000) };
    }
    // Over the limit but not lockable: slow it down instead. Capped, so a
    // flood cannot pin requests open and exhaust connections either.
    buckets.set(key, bucket);
    const over = bucket.hits.length - config.limit;
    return { allowed: true, delayMs: Math.min(250 * 2 ** Math.min(over, 5), 5000) };
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
 * Client identity for limiting, and whether it is trustworthy enough to lock.
 *
 * The forwarded address is only believed when the operator has declared a
 * proxy. Without one there is no per-client identity at all — and crucially the
 * answer to that is NOT "put everyone in one bucket", which would let any
 * failed-login flood lock the whole instance out. It is "do not lock anyone".
 */
export function clientKey(request: Request, trustProxy: boolean): { key: string; lockable: boolean } {
  if (trustProxy) {
    const forwarded = request.headers.get("x-forwarded-for")?.split(",")[0]?.trim();
    if (forwarded !== undefined && forwarded !== "") return { key: `ip:${forwarded}`, lockable: true };
  }
  return { key: "ip:unidentified", lockable: false };
}

/** Sleep, for applying a rate-limit delay. */
export function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
