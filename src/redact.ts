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

/** A credential Ship itself hands to a process, by the name it travels under. */
export interface KnownSecret {
  name: string;
  value: string;
}

/**
 * Values shorter than this are not scrubbed: a short value matches ordinary
 * output ("true", a port, a word) and rewriting every occurrence would mangle
 * the record without protecting much. A credential that short is the
 * operator's problem to rotate, not one this pass can solve.
 */
export const EXACT_SCRUB_MIN_LENGTH = 8;

interface ExactForm {
  needle: string;
  label: string;
  /** The secret's own name, for reports that must name what matched, never the value. */
  name: string;
}

/**
 * Each secret as the strings to look for: the value itself and its base64
 * form (an agent that prints an encoded copy has still printed it). Longest
 * first, so a value that contains another is replaced whole.
 *
 * Exported for the workspace hygiene scans (thread-warm.ts
 * workspaceSecretValueReason): the publish gate and the snapshot steps judge
 * a tree with EXACTLY the needles the scrub would have replaced — same
 * minimum length, same base64 forms, one rule everywhere a value can leak.
 */
export function exactForms(secrets: readonly KnownSecret[]): ExactForm[] {
  const forms = new Map<string, ExactForm>();
  for (const { name, value } of secrets) {
    if (value.length < EXACT_SCRUB_MIN_LENGTH) continue;
    if (!forms.has(value)) forms.set(value, { needle: value, label: `[redacted ${name}]`, name });
    const encoded = Buffer.from(value, "utf8").toString("base64");
    if (!forms.has(encoded)) forms.set(encoded, { needle: encoded, label: `[redacted ${name} base64]`, name });
  }
  return [...forms.values()].sort((a, b) => b.needle.length - a.needle.length);
}

function replaceForms(text: string, forms: readonly ExactForm[]): string {
  let out = text;
  for (const { needle, label } of forms) {
    if (out.includes(needle)) out = out.split(needle).join(label);
  }
  return out;
}

/**
 * A value cut off at the end of the text (a capped stream, a process killed
 * mid-print) is still most of a credential: a trailing prefix of at least
 * EXACT_SCRUB_MIN_LENGTH characters is replaced too.
 */
function replaceTrailingPrefix(text: string, forms: readonly ExactForm[]): string {
  for (const { needle, label } of forms) {
    for (let k = Math.min(needle.length - 1, text.length); k >= EXACT_SCRUB_MIN_LENGTH; k--) {
      if (text.endsWith(needle.slice(0, k))) return `${text.slice(0, text.length - k)}${label}`;
    }
  }
  return text;
}

/**
 * Replace every exact occurrence of the given secrets (and their base64
 * forms) in a complete text. Unlike `redactKnownValues` this is not gated on
 * the variable's NAME: the caller is the one that forwarded the value, so it
 * knows the value is a credential whatever it is called.
 */
export function scrubExact(text: string, secrets: readonly KnownSecret[]): string {
  const forms = exactForms(secrets);
  if (forms.length === 0 || text === "") return text;
  return replaceTrailingPrefix(replaceForms(text, forms), forms);
}

/**
 * The NAME of the first configured secret whose value (or its base64 form)
 * appears verbatim in the text — for withholding decisions (Q3c: a browser
 * recording whose captured page text carries a secret is never stored) that
 * must name their reason without ever naming the value. The same
 * exact-forms and minimum-length rules as scrubExact apply: a value shorter
 * than EXACT_SCRUB_MIN_LENGTH is not a secret this pass can see.
 */
export function firstSecretIn(text: string, secrets: readonly KnownSecret[]): string | undefined {
  if (text === "") return undefined;
  return exactForms(secrets).find(({ needle }) => text.includes(needle))?.name;
}

/**
 * The sentence a withheld recording records (Q3c): WHICH secret by its name,
 * never the value, and what happened to the bytes. Shared by both recording
 * sources — the look session's screencast and the flow rung's WebM.
 */
export function withheldRecordingReason(name: string): string {
  return `a configured secret value (${name}) appeared in the page text captured during the session, so the recording was withheld — nothing was stored, and the captured bytes were deleted`;
}

/**
 * The same scrub over a stream that arrives in chunks. A chunk boundary can
 * split a value, so the scrubber holds back the last (longest needle - 1)
 * characters until the next chunk proves they are not the start of one;
 * `flush` releases the remainder at the end.
 */
export function exactScrubber(secrets: readonly KnownSecret[]): { push(chunk: string): string; flush(): string } {
  const forms = exactForms(secrets);
  const keep = forms.length === 0 ? 0 : forms[0]!.needle.length - 1;
  let buffer = "";
  return {
    push(chunk) {
      if (forms.length === 0) return chunk;
      buffer = replaceForms(buffer + chunk, forms);
      if (buffer.length <= keep) return "";
      const out = buffer.slice(0, buffer.length - keep);
      buffer = buffer.slice(buffer.length - keep);
      return out;
    },
    flush() {
      const out = forms.length === 0 ? buffer : replaceTrailingPrefix(replaceForms(buffer, forms), forms);
      buffer = "";
      return out;
    },
  };
}
