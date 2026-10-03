import assert from "node:assert/strict";
import { test } from "node:test";
import { retrieveUntrusted, validateRetrievalTarget, type Pin, type RetrieveDeps } from "./safe-fetch.js";

// The resolver is a table: name -> answers. An unlisted name is NXDOMAIN.
function resolver(table: Record<string, string[]>) {
  const calls: string[] = [];
  const resolve = async (host: string) => {
    calls.push(host);
    const a = table[host];
    if (a === undefined) throw new Error(`ENOTFOUND ${host}`);
    return a;
  };
  return { resolve, calls };
}

// What a hostname-only check would say. Used as the NEGATIVE CONTROL: for the
// resolved-address cases below it must return "allow", proving the resolved
// check is what stops them (a test that both checkers deny proves nothing).
function naiveHostnameAllows(raw: string): boolean {
  let u: URL;
  try { u = new URL(raw); } catch { return false; }
  if (u.protocol !== "https:") return false;
  const h = u.hostname;
  return !(h === "localhost" || /^(127|10|169\.254|192\.168)\./.test(h) || h.startsWith("["));
}

const PUBLIC = "93.184.216.34";
const DNS = resolver({
  "docs.example.com": [PUBLIC],
  "public.example.com": [PUBLIC, "2606:2800:220:1:248:1893:25c8:1946"],
  "rebind.example.com": [PUBLIC, "10.0.0.5"],
  "meta.example.com": ["169.254.169.254"],
  "tailnet.example.com": ["100.100.1.1"],
  "loop.example.com": ["127.0.0.1"],
  "v6ula.example.com": ["fd12:3456::1"],
  "v6ll.example.com": ["fe80::1"],
  "mapped.example.com": ["::ffff:10.0.0.1"],
  "mapped2.example.com": ["::ffff:7f00:1"],
  "garbage.example.com": ["not-an-ip"],
  "octal.example.com": ["010.0.0.1"],
  "empty.example.com": [],
  "xn--80ak6aa92e.com": ["192.168.1.1"],
});
const opts = { resolve: DNS.resolve };

async function denied(url: string, reason: string, o: Partial<Parameters<typeof validateRetrievalTarget>[1]> = {}) {
  const d = await validateRetrievalTarget(url, { ...opts, ...o });
  assert.equal(d.allowed, false, `${url} must be denied`);
  if (!d.allowed) assert.equal(d.reason, reason, `${url}: ${d.detail}`);
}

test("public targets are allowed and pinned to the validated address", async () => {
  const d = await validateRetrievalTarget("https://Docs.Example.COM./a/b?q=1", opts);
  assert.ok(d.allowed);
  if (d.allowed) {
    assert.deepEqual(d.pin, { address: PUBLIC, family: 4, hostname: "docs.example.com" });
    assert.equal(d.url.href, "https://docs.example.com./a/b?q=1");
  }
  const lit = await validateRetrievalTarget("https://93.184.216.34/", opts);
  assert.ok(lit.allowed);
  const v6 = await validateRetrievalTarget("https://[2606:2800:220:1:248:1893:25c8:1946]/", opts);
  assert.ok(v6.allowed);
});

test("hostile literal table: every spelling of a private address is denied", async () => {
  const cases: [string, string][] = [
    ["https://127.0.0.1/", "private_address"],
    ["https://127.255.255.254/", "private_address"],
    ["https://0.0.0.0/", "private_address"],
    ["https://169.254.169.254/latest/meta-data/", "private_address"],
    ["https://169.254.1.1/", "private_address"],
    ["https://10.1.2.3/", "private_address"],
    ["https://172.16.0.1/", "private_address"],
    ["https://172.31.255.255/", "private_address"],
    ["https://192.168.0.1/", "private_address"],
    ["https://100.64.0.1/", "private_address"],
    ["https://100.127.255.255/", "private_address"],
    ["https://100.100.100.200/", "host_denied"],
    ["https://[::1]/", "private_address"],
    ["https://[::]/", "private_address"],
    ["https://[fe80::1]/", "private_address"],
    ["https://[fc00::1]/", "private_address"],
    ["https://[fd00:ec2::254]/", "private_address"],
    ["https://[::ffff:127.0.0.1]/", "private_address"],
    ["https://[::ffff:7f00:1]/", "private_address"],
    ["https://[::ffff:8.8.8.8]/", "private_address"], // mapped is refused outright
    ["https://[64:ff9b::7f00:1]/", "private_address"],
    ["https://[2002:7f00:1::]/", "private_address"],
    // alternate IPv4 spellings; the URL parser folds them to dotted form
    ["https://2130706433/", "private_address"],
    ["https://0x7f000001/", "private_address"],
    ["https://0x7f.0.0.1/", "private_address"],
    ["https://017700000001/", "private_address"],
    ["https://0177.0.0.1/", "private_address"],
    ["https://127.1/", "private_address"],
    ["https://127.0.1/", "private_address"],
    ["https://2852039166/", "private_address"], // 169.254.169.254 as decimal
    ["https://0xa9fea9fe/", "private_address"],
    ["https://0251.0376.0251.0376/", "private_address"],
    // full-width digits and ideographic full stop normalise to 127.0.0.1
    ["https://１２７.０.０.１/", "private_address"],
    ["https://127。0。0。1/", "private_address"],
  ];
  for (const [url, reason] of cases) await denied(url, reason);
});

test("hostile name table: local names, case, trailing dots, IDN, metadata hostnames", async () => {
  await denied("https://localhost/", "host_denied");
  await denied("https://LOCALHOST/", "host_denied");
  await denied("https://localhost./", "host_denied");
  await denied("https://LocalHost.../", "host_denied");
  await denied("https://ｌｏｃａｌｈｏｓｔ/", "host_denied"); // full-width, folds to localhost
  await denied("https://app.localhost/", "host_denied");
  await denied("https://printer.local/", "host_denied");
  await denied("https://db.internal/", "host_denied");
  await denied("https://box.tail1234.ts.net/", "host_denied");
  await denied("https://metadata.google.internal/computeMetadata/v1/", "host_denied");
  await denied("https://METADATA.GOOGLE.INTERNAL./", "host_denied");
  await denied("https://metadata/", "host_denied");
  await denied("https://intranet/", "host_denied"); // single label
  await denied("https://1.2.3.4.5/", "invalid_url");
  await denied("https://xn--a.example.com/", "invalid_url"); // invalid punycode
  await denied("https://example.0x10/", "invalid_url"); // the parser rejects it before our ambiguous_ip backstop
  await denied("https://999.999.999.999/", "invalid_url");
  await denied("https://xn--80ak6aa92e.com/", "private_address"); // punycode resolves private
  await denied("https://[fe80::1%25eth0]/", "invalid_url"); // zone id
  await denied("https://exa mple.com/", "invalid_url");
  await denied("not a url", "invalid_url");
  // soft hyphen is stripped by IDNA: "loca­lhost" is still localhost
  await denied("https://loca­lhost/", "host_denied");
});

test("scheme, userinfo, port rules", async () => {
  await denied("http://docs.example.com/", "scheme");
  await denied("ftp://docs.example.com/", "scheme");
  await denied("file:///etc/passwd", "scheme");
  await denied("gopher://docs.example.com/", "scheme");
  await denied("javascript:alert(1)", "scheme");
  await denied("data:text/plain,hi", "scheme");
  await denied("https://user:pw@docs.example.com/", "userinfo");
  await denied("https://user@docs.example.com/", "userinfo");
  await denied("https://@docs.example.com/", "userinfo");
  // backslash is a path separator to the one parser: the host is docs.example.com, not 127.0.0.1
  const bs = await validateRetrievalTarget("https://docs.example.com\\@127.0.0.1/", opts);
  assert.ok(bs.allowed && bs.url.hostname === "docs.example.com");
  await denied("https://docs.example.com:22/", "port");
  await denied("https://docs.example.com:6379/", "port");
  await denied("https://docs.example.com:80/", "port"); // 80 is only the default for http
  const ok = await validateRetrievalTarget("http://docs.example.com/", { ...opts, allowHttp: true });
  assert.ok(ok.allowed);
  const okPort = await validateRetrievalTarget("https://docs.example.com:8443/", { ...opts, allowPorts: [8443] });
  assert.ok(okPort.allowed);
  const stillBad = await validateRetrievalTarget("https://docs.example.com:22/", { ...opts, allowPorts: [8443] });
  assert.equal(stillBad.allowed, false);
});

test("resolved-address denial: any private answer refuses the name (rebinding mix, v6, mapped, garbage)", async () => {
  await denied("https://rebind.example.com/", "private_address");
  await denied("https://meta.example.com/", "private_address");
  await denied("https://tailnet.example.com/", "private_address");
  await denied("https://loop.example.com/", "private_address");
  await denied("https://v6ula.example.com/", "private_address");
  await denied("https://v6ll.example.com/", "private_address");
  await denied("https://mapped.example.com/", "private_address");
  await denied("https://mapped2.example.com/", "private_address");
  await denied("https://garbage.example.com/", "bad_address");
  await denied("https://octal.example.com/", "bad_address");
  await denied("https://empty.example.com/", "no_addresses");
  await denied("https://nx.example.com/", "resolve_failed");
});

test("NEGATIVE CONTROL: a hostname-only check passes every case the resolved check denies", async () => {
  const resolvedOnly = [
    "https://rebind.example.com/",
    "https://meta.example.com/",
    "https://tailnet.example.com/",
    "https://loop.example.com/",
    "https://v6ula.example.com/",
    "https://mapped.example.com/",
    "https://xn--80ak6aa92e.com/",
    "https://100.64.0.1/", // CGNAT: not in the naive list
    "https://172.16.0.1/",
    "https://0.0.0.0/",
  ];
  for (const url of resolvedOnly) {
    assert.equal(naiveHostnameAllows(url), true, `naive check would have allowed ${url}`);
    const d = await validateRetrievalTarget(url, opts);
    assert.equal(d.allowed, false, `resolved check must deny ${url}`);
  }
});

test("allowHosts restricts to the list (exact and wildcard); allowPrivate never opens link-local or metadata", async () => {
  const allowHosts = ["docs.example.com", "*.cdn.example.com"];
  assert.ok((await validateRetrievalTarget("https://docs.example.com/", { ...opts, allowHosts })).allowed);
  await denied("https://public.example.com/", "host_not_allowed", { allowHosts });
  await denied("https://cdn.example.com/", "host_not_allowed", { allowHosts });
  await denied("https://evilcdn.example.com/", "host_not_allowed", { allowHosts });
  assert.ok((await validateRetrievalTarget("https://loop.example.com/", { ...opts, allowPrivate: true })).allowed);
  assert.ok((await validateRetrievalTarget("https://10.0.0.5/", { ...opts, allowPrivate: true })).allowed);
  await denied("https://169.254.169.254/", "private_address", { allowPrivate: true });
  await denied("https://meta.example.com/", "private_address", { allowPrivate: true });
  await denied("https://v6ll.example.com/", "private_address", { allowPrivate: true });
});

// ---------------------------------------------------------------- retrieval

function bodyOf(chunks: (Uint8Array | "stall")[]): ReadableStream<Uint8Array> {
  let i = 0;
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      const c = chunks[i++];
      if (c === undefined) return controller.close();
      if (c === "stall") return new Promise<void>(() => undefined); // never settles, ignores abort
      controller.enqueue(c);
    },
  });
}
const text = (s: string) => new TextEncoder().encode(s);
const redirect = (to: string, status = 302) => new Response(null, { status, headers: { location: to } });

function deps(routes: Record<string, () => Response>, extra: Partial<RetrieveDeps> = {}) {
  const seen: { url: string; init: RequestInit; pin: Pin }[] = [];
  const d: RetrieveDeps = {
    resolve: DNS.resolve,
    fetch: async (url, init, pin) => {
      seen.push({ url, init, pin });
      const r = routes[url];
      if (r === undefined) throw new Error(`no route ${url}`);
      return r();
    },
    ...extra,
  };
  return { d, seen };
}

test("retrieves a public page: manual redirect, credentials omitted, only safe headers sent", async () => {
  const { d, seen } = deps(
    { "https://docs.example.com/": () => new Response("hello", { headers: { "content-type": "text/plain" } }) },
    { headers: { Authorization: "Bearer x", Cookie: "s=1", "Proxy-Authorization": "y", "User-Agent": "ship" } },
  );
  const r = await retrieveUntrusted("https://docs.example.com/", d);
  assert.ok(r.ok);
  if (r.ok) {
    assert.equal(new TextDecoder().decode(r.body), "hello");
    assert.equal(r.contentType, "text/plain");
  }
  assert.equal(seen.length, 1);
  assert.equal(seen[0]!.init.redirect, "manual");
  assert.equal(seen[0]!.init.credentials, "omit");
  const h = seen[0]!.init.headers as Record<string, string>;
  assert.deepEqual(Object.keys(h).sort(), ["accept", "user-agent"]);
  assert.equal(seen[0]!.pin.address, PUBLIC);
});

test("a denied first URL never reaches fetch", async () => {
  const { d, seen } = deps({});
  const r = await retrieveUntrusted("https://meta.example.com/", d);
  assert.equal(r.ok, false);
  assert.equal(seen.length, 0);
});

test("redirect: public first hop then private target is refused, and the private host is never fetched", async () => {
  for (const target of [
    "http://169.254.169.254/latest/meta-data/",
    "https://meta.example.com/",
    "https://10.0.0.5/",
    "https://localhost/admin",
    "https://[::1]/",
    "https://2130706433/",
    "https://user:pw@docs.example.com/",
    "file:///etc/passwd",
  ]) {
    const { d, seen } = deps({ "https://docs.example.com/start": () => redirect(target) }, { allowHttp: true });
    const r = await retrieveUntrusted("https://docs.example.com/start", d);
    assert.equal(r.ok, false, target);
    assert.equal(seen.length, 1, `only the public hop is fetched for ${target}`);
  }
});

test("redirect: relative Location resolves against the current hop and each hop is re-validated; public chain succeeds", async () => {
  const { d, seen } = deps({
    "https://docs.example.com/a": () => redirect("/b", 301),
    "https://docs.example.com/b": () => redirect("https://public.example.com/c", 307),
    "https://public.example.com/c": () => new Response("end"),
  });
  const r = await retrieveUntrusted("https://docs.example.com/a", d);
  assert.ok(r.ok);
  if (r.ok) assert.deepEqual(r.hops, ["https://docs.example.com/a", "https://docs.example.com/b", "https://public.example.com/c"]);
  assert.equal(seen[2]!.pin.hostname, "public.example.com");
});

test("redirect loop, hop limit, missing Location", async () => {
  const loop = deps({
    "https://docs.example.com/a": () => redirect("/b"),
    "https://docs.example.com/b": () => redirect("/a"),
  });
  const r = await retrieveUntrusted("https://docs.example.com/a", loop.d);
  assert.ok(!r.ok && r.reason === "redirect_loop");

  let n = 0;
  const endless = { ...loop.d, maxHops: 3, fetch: async () => redirect(`/n${++n}`) };
  const r2 = await retrieveUntrusted("https://docs.example.com/", endless);
  assert.ok(!r2.ok && r2.reason === "too_many_redirects");
  assert.equal(r2.hops.length, 4); // the start plus three followed redirects

  const missing = deps({ "https://docs.example.com/": () => new Response(null, { status: 302 }) });
  const r3 = await retrieveUntrusted("https://docs.example.com/", missing.d);
  assert.ok(!r3.ok && r3.reason === "redirect_missing_location");
});

test("rebinding: resolved once per hop, the pin is the first answer, a later private answer is never consulted", async () => {
  let answers = 0;
  const calls: string[] = [];
  const { d, seen } = deps(
    { "https://flip.example.com/": () => new Response("ok") },
    {
      resolve: async (host) => {
        calls.push(host);
        return answers++ === 0 ? [PUBLIC] : ["127.0.0.1"]; // a second lookup would be the attack
      },
    },
  );
  const r = await retrieveUntrusted("https://flip.example.com/", d);
  assert.ok(r.ok);
  assert.deepEqual(calls, ["flip.example.com"]);
  assert.equal(seen[0]!.pin.address, PUBLIC);
  // and when the first answer is the private one, nothing is fetched
  const again = await retrieveUntrusted("https://flip.example.com/", d);
  assert.ok(!again.ok && again.reason === "private_address");
  assert.equal(seen.length, 1);
});

test("size: oversized body (streamed), oversized declared length, and a body exactly at the limit", async () => {
  const big = deps({ "https://docs.example.com/": () => new Response(bodyOf([text("aaaa"), text("bbbb"), text("cccc")])) }, { maxBytes: 10 });
  const r = await retrieveUntrusted("https://docs.example.com/", big.d);
  assert.ok(!r.ok && r.reason === "too_large");

  const declared = deps({ "https://docs.example.com/": () => new Response("x", { headers: { "content-length": "999999" } }) }, { maxBytes: 10 });
  const r2 = await retrieveUntrusted("https://docs.example.com/", declared.d);
  assert.ok(!r2.ok && r2.reason === "too_large");

  const exact = deps({ "https://docs.example.com/": () => new Response(bodyOf([text("12345"), text("67890")])) }, { maxBytes: 10 });
  const r3 = await retrieveUntrusted("https://docs.example.com/", exact.d);
  assert.ok(r3.ok);
});

test("timeout: slow body that never finishes, a hung fetch, and a hung resolver are all cut off", async () => {
  const slow = deps({ "https://docs.example.com/": () => new Response(bodyOf([text("start"), "stall"])) }, { timeoutMs: 60 });
  const t0 = Date.now();
  const r = await retrieveUntrusted("https://docs.example.com/", slow.d);
  assert.ok(!r.ok && r.reason === "timeout");
  assert.ok(Date.now() - t0 < 2000);

  const hungFetch = { ...slow.d, fetch: () => new Promise<Response>(() => undefined) };
  const r2 = await retrieveUntrusted("https://docs.example.com/", hungFetch);
  assert.ok(!r2.ok && r2.reason === "timeout");

  const hungResolve = { ...slow.d, resolve: () => new Promise<string[]>(() => undefined) };
  const r3 = await retrieveUntrusted("https://docs.example.com/", hungResolve);
  assert.ok(!r3.ok && r3.reason === "timeout");
});

test("a fetch error is reported, not thrown", async () => {
  const { d } = deps({});
  const r = await retrieveUntrusted("https://docs.example.com/", d);
  assert.ok(!r.ok && r.reason === "fetch_failed");
});
