/**
 * Ship's web process reporting into Observe: unhandled errors — including the
 * root ErrorBoundary catch (see routes/_layout.tsx, commit b7d5db3) and any
 * exception/rejection that escapes the request lifecycle entirely — plus a
 * trace span around the run-page loader, the one route with an open
 * reliability question (see the same commit's message).
 *
 * Opt-in and always fire-and-forget, same convention as the worker's LLM-event
 * emitter (teploy-ship/src/observe.ts) — a no-op unless OBSERVE_URL and
 * OBSERVE_API_KEY are set, and telemetry never blocks or fails a request:
 *
 *   OBSERVE_URL      https://observe.example.com
 *   OBSERVE_API_KEY  ingest key (maps to a site)
 *   OBSERVE_SITE     optional explicit site id (X-Observe-Site)
 *
 * Errors post to Observe's Sentry-shaped error ingest (POST /api/v1/errors —
 * grouping, source maps, the Issues UI). The run-page span posts a minimal
 * hand-built OTLP/JSON envelope to the canonical OTLP endpoint
 * (POST /v1/traces) — both accept X-API-Key the same way OTLP exporters do,
 * so no OTel SDK dependency is needed for one route's timing.
 */

interface ObserveConfig {
  base: string;
  key: string;
  site: string;
}

// Route modules in this framework get bundled for the client too (hydration
// needs the component/ErrorBoundary exports alongside the server-only
// loader/action/middleware ones — confirmed live: other *.server.ts files'
// strings already show up in client chunks). `process` does not exist in a
// browser bundle, so every entry point below is guarded to no-op there
// instead of throwing on page load.
function isNode(): boolean {
  return typeof process !== "undefined" && typeof process.env === "object";
}

function config(): ObserveConfig | null {
  if (!isNode()) return null;
  const base = (process.env.OBSERVE_URL ?? "").replace(/\/+$/, "");
  const key = process.env.OBSERVE_API_KEY ?? "";
  if (base === "" || key === "") return null;
  return { base, key, site: process.env.OBSERVE_SITE ?? "" };
}

function post(path: string, body: unknown): void {
  const cfg = config();
  if (cfg === null) return;
  const headers: Record<string, string> = { "content-type": "application/json", "x-api-key": cfg.key };
  if (cfg.site !== "") headers["x-observe-site"] = cfg.site;
  void fetch(`${cfg.base}${path}`, { method: "POST", headers, body: JSON.stringify(body) }).catch(() => {
    // Fire-and-forget: a telemetry failure must never surface as an app failure.
  });
}

interface StackFrame {
  filename: string;
  function: string;
  lineno: number;
  colno: number;
  in_app: boolean;
}

/** V8 stack frame parser, same shape Observe's other JS-family callers send. */
function parseStack(stack: string | undefined): StackFrame[] | undefined {
  if (stack === undefined) return undefined;
  const frames: StackFrame[] = [];
  for (const line of stack.split("\n").slice(0, 50)) {
    const m = line.match(/at (?:(.+?) )?\(?([^()]+?):(\d+):(\d+)\)?\s*$/);
    if (m === null) continue;
    const filename = m[2] ?? "";
    frames.push({
      function: m[1] ?? "<anonymous>",
      filename,
      lineno: parseInt(m[3] ?? "0", 10),
      colno: parseInt(m[4] ?? "0", 10),
      in_app: !/node_modules|node:internal/.test(filename),
    });
  }
  return frames.length > 0 ? frames : undefined;
}

/** Report an error to Observe's error tracking. `mechanism` left unset means
 *  "handled" (e.g. a route's own ErrorBoundary); set it for anything that
 *  escaped the request lifecycle (uncaughtException/unhandledRejection). */
export function reportError(error: unknown, extra?: { mechanism?: string; route?: string }): void {
  if (!isNode()) return;
  const e = error instanceof Error ? error : new Error(typeof error === "string" ? error : String(error));
  post("/api/v1/errors", {
    error_type: e.name || "Error",
    error_value: e.message || String(error),
    level: "error",
    mechanism: extra?.mechanism ?? "generic",
    handled: extra?.mechanism === undefined,
    stack_trace: parseStack(e.stack),
    environment: process.env.NODE_ENV ?? "production",
    contexts: extra?.route !== undefined ? { route: { path: extra.route } } : undefined,
    extra: { source: "teploy-ship-web" },
  });
}

// -- minimal OTLP/JSON trace span (no @opentelemetry dependency) --

function hex(bytes: number): string {
  const arr = new Uint8Array(bytes);
  globalThis.crypto.getRandomValues(arr);
  return Array.from(arr, (b) => b.toString(16).padStart(2, "0")).join("");
}

/** Epoch millis -> OTLP's decimal-string epoch nanos, via BigInt (a plain
 *  number loses precision past 2^53, which a millis-since-1970 * 1e6 blows
 *  through immediately). */
function nanos(ms: number): string {
  return (BigInt(Math.round(ms)) * 1_000_000n).toString();
}

type AttrPrimitive = string | number | boolean | undefined;

function otlpAttrs(obj: Record<string, AttrPrimitive>): { key: string; value: Record<string, unknown> }[] {
  const out: { key: string; value: Record<string, unknown> }[] = [];
  for (const [key, v] of Object.entries(obj)) {
    if (v === undefined) continue;
    if (typeof v === "string") out.push({ key, value: { stringValue: v } });
    else if (typeof v === "number") out.push({ key, value: { intValue: String(Math.round(v)) } });
    else out.push({ key, value: { boolValue: v } });
  }
  return out;
}

/** Start a request-scoped span; call `.end()` when the work finishes (success
 *  or failure) to post it as a single-span OTLP trace export. */
export function startSpan(name: string, attributes: Record<string, AttrPrimitive> = {}) {
  const startMs = Date.now();
  const traceId = hex(16);
  const spanId = hex(8);
  return {
    end(status: "ok" | "error" = "ok", extraAttrs: Record<string, AttrPrimitive> = {}): void {
      const endMs = Date.now();
      post("/v1/traces", {
        resourceSpans: [
          {
            resource: { attributes: otlpAttrs({ "service.name": "teploy-ship-web" }) },
            scopeSpans: [
              {
                scope: { name: "teploy-ship", version: "" },
                spans: [
                  {
                    traceId,
                    spanId,
                    parentSpanId: "",
                    name,
                    kind: 2, // server
                    startTimeUnixNano: nanos(startMs),
                    endTimeUnixNano: nanos(endMs),
                    attributes: otlpAttrs({ ...attributes, ...extraAttrs }),
                    status: { code: status === "error" ? 2 : 1, message: "" },
                    events: [],
                  },
                ],
              },
            ],
          },
        ],
      });
    },
  };
}

/**
 * Catch-alls for anything that escapes every route's own error handling
 * (the ErrorBoundary only covers loader/action/render — it cannot see a
 * stray async callback outside a request). Without a listener, Node's
 * default behavior on either event is to print to stderr and end the
 * process; registering a listener replaces that default, so this always
 * reports-then-exits to preserve the current crash-and-restart behavior
 * rather than silently leaving a corrupted process running.
 */
let processHooksInstalled = false;
export function installProcessErrorHooks(): void {
  if (!isNode() || typeof process.on !== "function" || processHooksInstalled) return;
  // Only when Observe is actually configured. These handlers exist to get the
  // crash reported before exit; without a reporting destination they would do
  // nothing but replace Node's immediate fatal exit with a 2s delay, during
  // which a process known to be in a broken state keeps serving requests.
  if (config() === null) return;
  processHooksInstalled = true;
  const die = (label: string, err: unknown): void => {
    console.error(`[ship] ${label}`, err);
    reportError(err, { mechanism: label });
    // Give the fire-and-forget report a moment to leave the process before
    // exiting; a hard ceiling in case the process is too broken to finish it.
    process.exitCode = 1;
    setTimeout(() => process.exit(1), 2000).unref();
  };
  process.on("uncaughtException", (err) => die("uncaughtException", err));
  process.on("unhandledRejection", (reason) => die("unhandledRejection", reason));
}
