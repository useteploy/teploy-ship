import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, readdirSync, readFileSync } from "node:fs";
import { registerHooks } from "node:module";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";

// The framework's own path functions, by file: the point of half of this suite
// is that the gate and the ROUTER agree, so the router's code is the oracle.
import { bindPathParams, normalizePathname, parseUrlPath } from "../../node_modules/@neutron-build/core/dist/core/route-path.js";

process.env.SHIP_WEB_TOKEN ??= "test-token";
process.env.TEPLOY_SHIP_STATE ??= mkdtempSync(join(tmpdir(), "ship-web-route-access-"));
process.env.SHIP_STORE ??= "file";

// routes/_layout.tsx imports its favicon through Vite (`?url`); under plain
// node that import has no loader. Nothing here reads the value.
registerHooks({
  load(url, context, next) {
    if (/\.svg(\?|$)/.test(url)) return { format: "module", source: 'export default "/favicon.svg";', shortCircuit: true };
    return next(url, context);
  },
});

const { requiredRole, roleAllows, signSession, SESSION_COOKIE } = await import("./session.server.js");
const { gatePath, ROUTE_ACCESS, routeNeed } = await import("./route-access.server.js");
const { middleware } = await import("../routes/_layout.js");
type RoutePattern = keyof typeof ROUTE_ACCESS;
type Handler = "loader" | "action";
type Role = "viewer" | "editor" | "admin";

const ROUTES_DIR = join(import.meta.dirname, "../routes");
const PATTERNS = Object.keys(ROUTE_ACCESS) as RoutePattern[];
const PRINCIPALS: Array<Role | null> = [null, "viewer", "editor", "admin"];

/** A request as `role`. Same session shapes as authority-paths.test.ts: the role rides in the cookie. */
function as(role: Role | null, path: string, method = "GET"): Request {
  const headers = new Headers({ "sec-fetch-site": "same-origin" });
  if (role === "admin") headers.set("cookie", `${SESSION_COOKIE}=${signSession({ user: "token", role: "admin" })}`);
  else if (role !== null) headers.set("cookie", `${SESSION_COOKIE}=${signSession({ user: role, role }, "sso")}`);
  return new Request(`http://ship.internal${path}`, {
    method,
    headers,
    ...(method === "GET" ? {} : { body: new URLSearchParams({ intent: "create", username: "evil", password: "correct horse battery", role: "admin" }) }),
  });
}

/** A concrete URL path for a pattern. */
function concrete(pattern: string): string {
  return pattern.replace(/:[A-Za-z]+/g, "x1");
}

/** The pattern the ROUTER dispatches a raw request path to: null = 404, undefined = 400. */
function routed(rawPath: string): RoutePattern | null | undefined {
  const normalized = normalizePathname(rawPath);
  if (normalized === null) return undefined;
  const segments = parseUrlPath(normalized);
  // Static patterns before parameterised ones, as the trie ranks them.
  const ordered = [...PATTERNS].sort((a, b) => (a.match(/:/g)?.length ?? 0) - (b.match(/:/g)?.length ?? 0));
  return ordered.find((pattern) => bindPathParams(pattern, segments) !== null) ?? null;
}

/**
 * The need of the handler a method reaches on a pattern, or null when it runs
 * no handler at all (a GET to an action-only route renders its empty default
 * export). A POST to a loader-only route still renders through its loader.
 */
function needFor(pattern: RoutePattern, method: string): Role | "public" | null {
  const entry = ROUTE_ACCESS[pattern] as { loader?: Role | "public"; action?: Role | "public" };
  return (method === "GET" ? entry.loader : (entry.action ?? entry.loader)) ?? null;
}

function allowed(role: Role | null, need: Role | "public"): boolean {
  return need === "public" || (role !== null && roleAllows(role, need));
}

/** Spellings of one path. `same` = the router sends it to the same route as the plain path. */
function variants(path: string): Array<{ name: string; raw: string }> {
  const letter = path.search(/[a-z]/);
  const out = [{ name: "plain", raw: path }];
  if (path !== "/") out.push({ name: "trailing slash", raw: `${path}/` });
  out.push({ name: "doubled leading slash", raw: `/${path}` });
  if (letter !== -1) {
    const hex = path.charCodeAt(letter).toString(16);
    const swap = (to: string): string => path.slice(0, letter) + to + path.slice(letter + 1);
    out.push({ name: "percent-encoded letter", raw: swap(`%${hex}`) });
    out.push({ name: "percent-encoded letter, upper hex", raw: swap(`%${hex.toUpperCase()}`) });
    out.push({ name: "percent-encoded letter + trailing slash", raw: `${swap(`%${hex}`)}/` });
    out.push({ name: "double-encoded letter", raw: swap(`%25${hex}`) });
    out.push({ name: "mixed case", raw: swap(path[letter]!.toUpperCase()) });
    out.push({ name: "upper case", raw: path.toUpperCase() });
    out.push({ name: "encoded slash", raw: `/%2f${path.slice(1)}` });
    out.push({ name: "encoded dot segment", raw: `/%2e${path}` });
    out.push({ name: "encoded parent segment", raw: `/x/%2e%2e${path}` });
    out.push({ name: "doubled inner slash", raw: path.replace(/\/(?=[^/]*$)/, "//") });
  }
  return out;
}

// ── gatePath ────────────────────────────────────────────────────────────

test("gatePath reduces every spelling of a path to the one the router dispatches on", () => {
  for (const [raw, want] of [
    ["/", "/"],
    ["", "/"],
    ["/settings", "/settings"],
    ["/settings/", "/settings"],
    ["/%73ettings", "/settings"],
    ["/%53ettings", "/Settings"],
    ["//settings", "/settings"],
    ["/settings//", "/settings"],
    ["/api//runs/r1/decide", "/api/runs/r1/decide"],
    ["/runs/a%20b", "/runs/a b"],
    ["/.well-known/teploy.json", "/.well-known/teploy.json"],
    ["/hooks/events/v1.2..3", "/hooks/events/v1.2..3"],
  ] as const) {
    assert.equal(gatePath(raw), want, raw);
  }
});

test("gatePath refuses what two readers could read two ways", () => {
  for (const raw of [
    "/%2573ettings", // double-encoded
    "/%252573ettings",
    "/settings%2f", // encoded slash
    "/%2Fsettings",
    "/a%5csettings", // encoded backslash
    "/a\\settings",
    "/%2e%2e/settings", // encoded dots
    "/x/%2E/settings",
    "/x/../settings",
    "/x/./settings",
    "/settings%00",
    "/settings%0a", // control character
    "/%", // does not decode
    "/%zz",
    "/%c3", // truncated UTF-8
    "settings", // not rooted
  ]) {
    assert.equal(gatePath(raw), null, raw);
  }
});

test("gatePath agrees with the framework's router wherever it answers at all", () => {
  const corpus = new Set<string>(["/", "/%E2%9C%93", "/a%20b/", "/a/b//c", "///", "/a/..b", "/a..b/c"]);
  for (const pattern of PATTERNS) for (const v of variants(concrete(pattern))) corpus.add(v.raw);
  let compared = 0;
  for (const raw of corpus) {
    const gate = gatePath(raw);
    if (gate === null) continue;
    const router = normalizePathname(raw);
    assert.notEqual(router, null, `the gate accepted ${raw} but the router refuses it`);
    assert.deepEqual(parseUrlPath(gate), parseUrlPath(router!), `${raw}: gate and router see different segments`);
    compared += 1;
  }
  assert.ok(compared > 200, `only ${compared} paths compared`);
});

// ── The table ───────────────────────────────────────────────────────────

/** routes/runs/[id].tsx → /runs/:id, the way the framework's discovery names it. */
function patternOf(file: string): string {
  const segments = relative(ROUTES_DIR, file)
    .replace(/\.tsx$/, "")
    .split("/")
    .flatMap((part) => part.replace(/\[\.\]/g, "\u0000").split(".").map((s) => s.replace(/\u0000/g, ".")))
    .filter((s) => s !== "index")
    .map((s) => s.replace(/^\[(.+)\]$/, ":$1"));
  return `/${segments.join("/")}`;
}

function routeFiles(dir = ROUTES_DIR): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) return routeFiles(full);
    return entry.name.endsWith(".tsx") && !entry.name.startsWith("_") ? [full] : [];
  });
}

const FILES = new Map(routeFiles().map((file) => [patternOf(file), file]));

test("every route file is classified, and every classified handler exists", () => {
  assert.deepEqual([...FILES.keys()].sort(), [...PATTERNS].sort(), "ROUTE_ACCESS and routes/ list different routes");
  for (const [pattern, file] of FILES) {
    const source = readFileSync(file, "utf8");
    const entry = ROUTE_ACCESS[pattern as RoutePattern] as { loader?: string; action?: string };
    for (const handler of ["loader", "action"] as const) {
      const exported = new RegExp(`export (?:async function|const) ${handler}\\b|export \\{[^}]*\\b${handler}\\b`).test(source);
      assert.equal(entry[handler] !== undefined, exported, `${pattern}: ${handler} is ${exported ? "exported but not classified" : "classified but not exported"}`);
    }
  }
});

test("the middleware's role for each route is the table's", () => {
  for (const pattern of PATTERNS) {
    for (const handler of ["loader", "action"] as const) {
      const need = (ROUTE_ACCESS[pattern] as { loader?: string; action?: string })[handler];
      if (need === undefined || need === "public") continue;
      assert.equal(requiredRole(handler === "loader" ? "GET" : "POST", concrete(pattern)), need, `${handler} ${pattern}`);
    }
  }
});

test("admin areas stay admin whatever the case; nothing else is lowered by case", () => {
  for (const path of ["/Settings", "/SETTINGS", "/settings/Users", "/Connect/return", "/USERS/x"]) {
    assert.equal(requiredRole("GET", path), "admin", path);
    assert.equal(requiredRole("POST", path), "admin", path);
  }
  // An authority path in another case is NOT the authority path: it keeps the editor default.
  assert.equal(requiredRole("POST", "/Runs/r1"), "editor");
  assert.equal(requiredRole("POST", "/API/runs/r1/decide"), "editor");
});

// ── Layer 1: the middleware, walked over the whole table ────────────────────

test("no spelling of any route reaches a handler above the caller's role (middleware)", async () => {
  let walked = 0;
  for (const pattern of PATTERNS) {
    for (const method of ["GET", "POST"]) {
      for (const variant of variants(concrete(pattern))) {
        const target = routed(variant.raw);
        for (const role of PRINCIPALS) {
          const label = `${method} ${variant.raw} (${variant.name} of ${pattern}) as ${role ?? "nobody"}`;
          let reached = false;
          const response = await middleware(as(role, variant.raw, method), {} as never, async () => {
            reached = true;
            return new Response("handler");
          });
          walked += 1;
          // What the router would run if the middleware let the request through.
          if (reached && target !== null && target !== undefined) {
            const need = needFor(target, method);
            if (need !== null) assert.ok(allowed(role, need), `${label} reached ${target}, which needs ${need}`);
          }
          const handler = method === "GET" ? "loader" : "action";
          const own = (ROUTE_ACCESS[pattern] as { loader?: Role | "public"; action?: Role | "public" })[handler];
          if (own === undefined) continue;
          // The plain path is not over-blocked, and an under-privileged caller gets the documented status.
          if (variant.name === "plain") {
            assert.equal(reached, allowed(role, own), `${label}: needs ${own}`);
            if (!reached && role !== null) assert.equal(response.status, 403, label);
          }
          // A spelling the gate accepts and the router sends to this very route is decided exactly as the plain path is.
          if (target === pattern && gatePath(variant.raw) === concrete(pattern)) {
            assert.equal(reached, allowed(role, own), `${label}: same route, different answer`);
          }
        }
      }
    }
  }
  assert.ok(walked > 4000, `only ${walked} requests walked`);
});

test("SHIP-01: an editor's POST /%73ettings is refused, as is a viewer's GET", async () => {
  const never = async (): Promise<Response> => {
    throw new Error("the Settings route must not run");
  };
  for (const path of ["/%73ettings", "/%73ettings/", "//settings", "/settings//", "/s%65ttings", "/Settings", "/%53ettings"]) {
    assert.equal((await middleware(as("editor", path, "POST"), {} as never, never)).status, 403, `POST ${path} as editor`);
    assert.equal((await middleware(as("viewer", path), {} as never, never)).status, 403, `GET ${path} as viewer`);
  }
  for (const path of ["/%2573ettings", "/%2fsettings", "/x/%2e%2e%2fsettings", "/settings%00"]) {
    assert.equal((await middleware(as("editor", path, "POST"), {} as never, never)).status, 400, `POST ${path} as editor`);
    assert.equal((await middleware(as(null, path), {} as never, never)).status, 400, `GET ${path} as nobody`);
  }
  assert.equal((await middleware(as("viewer", "/%63onnect"), {} as never, never)).status, 403);
  // And the encoded spelling is not a way around the login either.
  assert.equal((await middleware(as(null, "/%73ettings"), {} as never, never)).status, 302);
});

// ── Layer 2: every handler, called directly, with no middleware in front ─────

type HandlerFn = (args: { request: Request; params: Record<string, string> }) => Promise<unknown>;

/** What a handler answered: a status, or "forbidden-page" for the connect pages' own refusal. */
async function answer(run: () => Promise<unknown>): Promise<number | string> {
  let value: unknown;
  try {
    value = await run();
  } catch (thrown) {
    value = thrown;
  }
  if (value instanceof Response) return value.status;
  if (typeof value === "object" && value !== null && (value as { state?: unknown }).state === "forbidden") return "forbidden-page";
  return "ran";
}

test("every handler refuses a caller below its role by itself (no middleware)", async () => {
  let checked = 0;
  for (const [pattern, file] of FILES) {
    const module = (await import(file)) as Partial<Record<Handler, HandlerFn>>;
    for (const handler of ["loader", "action"] as const) {
      const entry = ROUTE_ACCESS[pattern as RoutePattern] as { loader?: string; action?: string };
      // The module's real exports, not a reading of its source: a handler
      // exported in a spelling the source check above does not know (a plain
      // `export function loader`, a re-export) must still be classified, or it
      // would ship with no entry and no check here.
      assert.equal(typeof module[handler] === "function", entry[handler] !== undefined, `${pattern}: ${handler} is ${entry[handler] === undefined ? "exported but not classified" : "classified but not exported"}`);
      if (entry[handler] === undefined || entry[handler] === "public") continue;
      const need = routeNeed(pattern as RoutePattern, handler) as Role;
      const fn = module[handler];
      assert.equal(typeof fn, "function", `${pattern} exports no ${handler}`);
      const call = (role: Role | null): Promise<number | string> =>
        answer(() => fn!({ request: as(role, concrete(pattern), handler === "loader" ? "GET" : "POST"), params: { id: "x1", slug: "x1", source: "x1" } }));
      const refusedSignedOut = await call(null);
      assert.ok(refusedSignedOut === 401 || refusedSignedOut === 403 || refusedSignedOut === "forbidden-page", `${handler} ${pattern} as nobody answered ${refusedSignedOut}`);
      checked += 1;
      for (const role of ["viewer", "editor"] as const) {
        if (roleAllows(role, need)) continue;
        const refused = await call(role);
        assert.ok(refused === 403 || refused === "forbidden-page", `${handler} ${pattern} (needs ${need}) as ${role} answered ${refused}`);
        checked += 1;
      }
    }
  }
  assert.ok(checked > 70, `only ${checked} handler calls checked`);
});

test("SHIP-01: the Settings action creates no account for an editor, and the loader lists none for a viewer", async () => {
  const settings = (await import("../routes/settings.js")) as unknown as Record<Handler, HandlerFn>;
  const { shipRuntime } = await import("./store.server.js");
  const runtime = await shipRuntime();
  const before = (await runtime.users.list()).map((u) => u.username);
  for (const role of [null, "viewer", "editor"] as const) {
    const status = await answer(() => settings.action({ request: as(role, "/settings", "POST"), params: {} }));
    assert.equal(status, role === null ? 401 : 403, `POST as ${role ?? "nobody"}`);
    assert.equal(await answer(() => settings.loader({ request: as(role, "/settings"), params: {} })), role === null ? 401 : 403, `GET as ${role ?? "nobody"}`);
  }
  assert.deepEqual((await runtime.users.list()).map((u) => u.username), before, "no account was created");
  // The admin still can.
  assert.deepEqual(await settings.action({ request: as("admin", "/settings", "POST"), params: {} }), { ok: "Added evil." });
});
