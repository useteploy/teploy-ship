/**
 * Centralized redaction for anything that leaves the run and reaches a human,
 * a log, or another service.
 *
 * `secretEnvNames` already keeps Ship's OWN credentials out of the environment
 * agent commands run with. That is a different problem from this one: the
 * repository under test has its own secrets, and tools print them. A test
 * harness echoes a connection string, a failing request dumps an Authorization
 * header, a build prints an env dump — and all of it went verbatim into the
 * event log, the dashboard timeline, notifications, and Observe.
 *
 * The patterns below are the shapes that are unambiguous enough to rewrite
 * automatically. This is a reduction, not a guarantee: nothing can recognise
 * every secret, so the run log stays an authenticated surface regardless.
 */

interface Rule {
  pattern: RegExp;
  /** Replacement keeping enough shape that the output is still readable. */
  replace: string;
}

const RULES: Rule[] = [
  // Credentials embedded in URLs — the shape Ship itself builds for git.
  { pattern: /\b([a-z][a-z0-9+.-]*:\/\/)[^\s/@:]+:[^\s/@]*@/gi, replace: "$1***:***@" },
  { pattern: /\b([a-z][a-z0-9+.-]*:\/\/)[^\s/@:]+@/gi, replace: "$1***@" },
  // Provider tokens with recognisable prefixes.
  { pattern: /\bgh[pousr]_[A-Za-z0-9]{20,}/g, replace: "gh*_[redacted]" },
  { pattern: /\bsk-[A-Za-z0-9_-]{20,}/g, replace: "sk-[redacted]" },
  { pattern: /\bxox[abposr]-[A-Za-z0-9-]{10,}/g, replace: "xox*-[redacted]" },
  { pattern: /\bAKIA[0-9A-Z]{16}\b/g, replace: "AKIA[redacted]" },
  { pattern: /\bey[JI][A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{5,}/g, replace: "[redacted jwt]" },
  // Authorization headers, however they are printed.
  { pattern: /\b(authorization\s*[:=]\s*)(bearer\s+|token\s+|basic\s+)?\S+/gi, replace: "$1$2[redacted]" },
  // KEY=value / "secret": "value" assignments.
  {
    pattern: /\b([A-Z0-9_]*(?:TOKEN|SECRET|PASSWORD|PASSWD|APIKEY|API_KEY|CREDENTIAL)[A-Z0-9_]*)(\s*[:=]\s*)("?)([^\s"',;]{6,})\3/g,
    replace: "$1$2$3[redacted]$3",
  },
  {
    pattern: /("(?:[a-z_]*(?:token|secret|password|api_?key|credential)[a-z_]*)"\s*:\s*")([^"]{6,})"/gi,
    replace: '$1[redacted]"',
  },
  // Private key blocks: drop the body, keep the fact.
  {
    pattern: /-----BEGIN ([A-Z ]*)PRIVATE KEY-----[\s\S]*?-----END \1PRIVATE KEY-----/g,
    replace: "[redacted $1private key]",
  },
];

/** Rewrite recognisable secrets in free text. Safe on any string, including "". */
export function redact(text: string): string {
  if (text === "") return text;
  let out = text;
  for (const { pattern, replace } of RULES) {
    out = out.replace(pattern, replace);
  }
  return out;
}

/**
 * Redact known-secret ENV VALUES by exact match.
 *
 * Pattern matching cannot recognise an arbitrary deploy token, but the process
 * knows its own: any value of a secret-named variable that appears in output is
 * that variable's value, whatever it looks like. Short values are skipped —
 * a two-character secret would rewrite half the text.
 */
export function redactKnownValues(text: string, env: NodeJS.ProcessEnv = process.env): string {
  let out = text;
  const secretish = /(^|_)(TOKEN|SECRET|SECRETS|KEY|KEYS|APIKEY|API_KEY|PASSWORD|PASSWD|CREDENTIAL|CREDENTIALS|AUTH)(_|$)/i;
  for (const [name, value] of Object.entries(env)) {
    if (value === undefined || value.length < 8) continue;
    if (!secretish.test(name)) continue;
    if (!out.includes(value)) continue;
    out = out.split(value).join(`[redacted ${name}]`);
  }
  return out;
}

/** Both passes, in the order that keeps the exact-value one from being defeated by rewriting. */
export function scrub(text: string, env?: NodeJS.ProcessEnv): string {
  return redact(redactKnownValues(text, env));
}

/**
 * Truncate a large blob to a readable size, keeping both ends.
 *
 * Output was retained inline at full length, so one run with a noisy build
 * could make its own detail page expensive to load forever. The head and tail
 * are what a person reads; the middle is what makes it huge.
 */
export function clamp(text: string, max = 20_000): string {
  if (text.length <= max) return text;
  const head = Math.floor(max * 0.6);
  const tail = max - head;
  return `${text.slice(0, head)}\n… [${text.length - max} characters omitted] …\n${text.slice(-tail)}`;
}

/** Scrub and clamp — what anything leaving the run should go through. */
export function safeForDisplay(text: string, max?: number, env?: NodeJS.ProcessEnv): string {
  return clamp(scrub(text, env), max);
}
