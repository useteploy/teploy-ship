import { createHash, createHmac, timingSafeEqual } from "node:crypto";

/**
 * E7 EV4 — signature verification primitives shared by the vendor adapters.
 *
 * constantTimeEqualMac and verifyWebhookSignature are adapted from T3 Code's
 * scheduledTasks/webhookVerification.ts (MIT): hash both sides to a fixed
 * width before timingSafeEqual, because timingSafeEqual alone throws on a
 * length mismatch and comparing hex strings with === leaks byte-by-byte.
 * Every comparison here is over attacker-chosen input on an unauthenticated
 * route, so it must not leak the position of the first differing byte.
 */

/**
 * Constant-time string equality that does not leak length through timing.
 * Both sides are hashed to 32 bytes first, so timingSafeEqual always sees
 * equal-length buffers and the comparison time depends on nothing the
 * caller controls.
 */
export function constantTimeEqualStrings(a: string, b: string): boolean {
  const digestA = createHash("sha256").update(a, "utf8").digest();
  const digestB = createHash("sha256").update(b, "utf8").digest();
  return timingSafeEqual(digestA, digestB);
}

/**
 * Constant-time comparison of a hex MAC against a digest. Returns false on a
 * length mismatch rather than throwing: a truncated or padded signature is
 * simply wrong, not exceptional.
 */
export function constantTimeEqualHex(givenHex: string, digest: Buffer): boolean {
  const given = Buffer.from(givenHex.toLowerCase(), "hex");
  return given.length === digest.length && timingSafeEqual(given, digest);
}

export interface SignatureScheme {
  /** Which header carries the signature. */
  header: string;
  /** The prefix before the MAC value, e.g. "sha256=", "v1=". No prefix = bare value. */
  prefix?: string;
  /** Encoding of the MAC value once the prefix is stripped. */
  encoding: "hex" | "base64";
}

/**
 * One configurable signature check (the T3 webhookVerification shape): read
 * the named header, strip the prefix, decode, and compare the HMAC of the
 * message against it in constant time. The per-vendor message construction
 * (raw body vs "id.timestamp.body") stays with the adapter, because that is
 * what actually differs between vendors; this is the part that must never be
 * re-implemented five ways and drift.
 */
export function verifyWebhookSignature(
  message: string,
  headerValue: string | null,
  scheme: SignatureScheme,
  secret: string,
): boolean {
  if (headerValue === null || headerValue === "") return false;
  let value = headerValue.trim();
  if (scheme.prefix !== undefined) {
    if (!value.toLowerCase().startsWith(scheme.prefix.toLowerCase())) return false;
    value = value.slice(scheme.prefix.length);
  }
  const digest = createHmac("sha256", secret).update(message, "utf8").digest();
  return scheme.encoding === "hex"
    ? constantTimeEqualHex(value, digest)
    : constantTimeEqualStrings(value, digest.toString("base64"));
}
