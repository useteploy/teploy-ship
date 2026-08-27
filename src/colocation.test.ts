import assert from "node:assert/strict";
import { test } from "node:test";

import {
  COLOCATION_OVERRIDE_ENV,
  colocationOverridden,
  colocationRefusal,
  detectForgeColocation,
  localAddresses,
  originParts,
  sandboxHostProbeCommand,
} from "./colocation.js";

const FORGE = "http://100.108.123.49:49152";
const ok = (stdout: string) => async (): Promise<{ exitCode: number; stdout: string }> => ({ exitCode: 0, stdout });

test("a forge on localhost is co-located by definition, no probe needed", async () => {
  for (const origin of ["http://localhost:3000", "http://127.0.0.1:49152", "http://127.0.1.1:8080"]) {
    const result = await detectForgeColocation({ origins: [origin], resolve: async () => [] });
    assert.equal(result.colocated.length, 1, origin);
    assert.equal(result.colocated[0]?.how, "loopback");
  }
});

test("a forge that resolves onto this process's own interfaces is co-located", async () => {
  const result = await detectForgeColocation({
    origins: [FORGE],
    resolve: async () => ["100.108.123.49"],
    interfaces: { tailscale0: [{ address: "100.108.123.49" }], lo: [{ address: "127.0.0.1" }] },
  });
  assert.equal(result.colocated[0]?.how, "local-interface");
  assert.match(result.colocated[0]!.detail, /100\.108\.123\.49/, "the message names the evidence");
});

// This is the check that matters, and the only one that sees past the container
// boundary: a containerised worker's netns holds none of the host's addresses,
// so checks 1 and 2 are both blind to the real deployment.
test("the forge answering on the SANDBOX HOST's own address is co-location — the infra-home case", async () => {
  const result = await detectForgeColocation({
    origins: [FORGE],
    resolve: async () => ["100.108.123.49"],
    interfaces: { eth0: [{ address: "172.18.0.5" }] }, // a container's own address
    probe: ok("GW=172.18.0.1\nOPEN\n"),
  });
  assert.equal(result.colocated.length, 1);
  assert.equal(result.colocated[0]?.how, "sandbox-host");
  assert.match(result.colocated[0]!.detail, /172\.18\.0\.1/);
  assert.match(result.colocated[0]!.detail, /the same machine/);
});

test("a forge on a DIFFERENT box is not co-located — the deploy-test case", async () => {
  const result = await detectForgeColocation({
    origins: [FORGE],
    resolve: async () => ["100.108.123.49"],
    interfaces: { eth0: [{ address: "172.18.0.5" }] },
    probe: ok("GW=172.18.0.1\nCLOSED\n"),
  });
  assert.deepEqual(result.colocated, []);
  assert.deepEqual(result.unknown, [], "and nothing was left undetermined");
});

// A gate that cannot see must not report safety. Every one of these used to be
// the difference between "checked and fine" and "never checked".
test("a check that cannot run reports UNKNOWN, never safe", async () => {
  const noSandbox = await detectForgeColocation({ origins: [FORGE], resolve: async () => ["1.2.3.4"] });
  assert.deepEqual(noSandbox.colocated, []);
  assert.equal(noSandbox.unknown.length, 1);
  assert.match(noSandbox.unknown[0]!, /no sandbox is configured/);

  const brokenProbe = await detectForgeColocation({
    origins: [FORGE],
    resolve: async () => ["1.2.3.4"],
    probe: async () => {
      throw new Error("sandbox daemon unreachable");
    },
  });
  assert.match(brokenProbe.unknown[0]!, /sandbox daemon unreachable/);

  const noRoute = await detectForgeColocation({ origins: [FORGE], resolve: async () => ["1.2.3.4"], probe: ok("NOGW\n") });
  assert.match(noRoute.unknown[0]!, /no default route/);
});

test("a forge whose DNS fails is still probed rather than waved through", async () => {
  const result = await detectForgeColocation({
    origins: ["http://forge.internal:49152"],
    resolve: async () => [],
    interfaces: { eth0: [{ address: "172.18.0.5" }] },
    probe: ok("GW=172.18.0.1\nOPEN\n"),
  });
  assert.equal(result.colocated[0]?.how, "sandbox-host");
});

test("a file:// remote has no host to be co-located with", async () => {
  const result = await detectForgeColocation({ origins: ["file:///tmp/bare.git"], probe: ok("OPEN") });
  assert.deepEqual(result.colocated, []);
  assert.deepEqual(result.unknown, []);
});

test("the probe reads the host address from the container's default route, with a fallback", () => {
  const command = sandboxHostProbeCommand(49152);
  assert.match(command, /ip route/, "the tool most images have");
  assert.match(command, /route -n/, "and one for the images that do not");
  assert.match(command, /dev\/tcp\/\$gw\/49152/, "a bare TCP connect: no curl, no python, works in any image");
  assert.match(command, /timeout 3/, "and it cannot hang a worker's startup");
});

test("the refusal names the forge, the reason, and BOTH ways forward", () => {
  const text = colocationRefusal([
    { origin: FORGE, how: "sandbox-host", detail: "the forge's port 49152 answers on 172.18.0.1" },
  ]);
  assert.match(text, /refusing to run sandboxes on the same machine as the forge/);
  assert.match(text, /http:\/\/100\.108\.123\.49:49152/, "names the forge it detected");
  assert.match(text, /answers on 172\.18\.0\.1/, "and the evidence");
  assert.match(text, /clone and push/, "and why the egress allowlist makes this specific");
  assert.match(text, /teploy-ship join/, "and the way to fix it properly");
  assert.match(text, new RegExp(`${COLOCATION_OVERRIDE_ENV}=1`), "and the override");
});

test("the override is explicit and narrow", () => {
  for (const value of ["1", "true", "TRUE", "yes"]) {
    assert.equal(colocationOverridden({ [COLOCATION_OVERRIDE_ENV]: value }), true, value);
  }
  for (const value of ["", "0", "false", "no", "maybe"]) {
    assert.equal(colocationOverridden({ [COLOCATION_OVERRIDE_ENV]: value }), false, value);
  }
  assert.equal(colocationOverridden({}), false);
});

test("originParts understands the shapes a forge origin actually takes", () => {
  assert.deepEqual(originParts("http://100.108.123.49:49152"), { host: "100.108.123.49", port: 49152 });
  assert.deepEqual(originParts("https://github.com"), { host: "github.com", port: 443 });
  assert.deepEqual(originParts("http://forge.internal"), { host: "forge.internal", port: 80 });
  assert.equal(originParts("file:///tmp/x.git"), null);
  assert.equal(originParts("not a url"), null);
});

test("localAddresses flattens every interface", () => {
  const addresses = localAddresses({ lo: [{ address: "127.0.0.1" }], eth0: [{ address: "10.0.0.2" }, { address: "fe80::1" }] });
  assert.deepEqual([...addresses].sort(), ["10.0.0.2", "127.0.0.1", "fe80::1"]);
  assert.ok(localAddresses().size > 0, "and works against the real machine");
});

// The live done-check, frozen as a test.
//
// Both boxes report the SAME gateway (172.17.0.1), which is exactly why naive
// address comparison cannot tell them apart and why the probe asks whether the
// forge ANSWERS there. Captured 2026-08-26 by running
// sandboxHostProbeCommand(49152) in a container on each box.
test("the real outputs from deploy-test and infra-home come out opposite", async () => {
  const origins = ["http://100.108.123.49:49152"];
  const asAContainer = { eth0: [{ address: "172.17.0.5" }] };
  const resolve = async (): Promise<string[]> => ["100.108.123.49"];

  const infraHome = await detectForgeColocation({
    origins,
    interfaces: asAContainer,
    resolve,
    probe: async () => ({ exitCode: 0, stdout: "GW=172.17.0.1\nOPEN\n" }),
  });
  assert.equal(infraHome.colocated.length, 1, "infra-home runs the forge — Ship must refuse");
  assert.equal(infraHome.colocated[0]?.how, "sandbox-host");

  const deployTest = await detectForgeColocation({
    origins,
    interfaces: asAContainer,
    resolve,
    probe: async () => ({ exitCode: 0, stdout: "GW=172.17.0.1\nCLOSED\n" }),
  });
  assert.deepEqual(deployTest.colocated, [], "deploy-test does not — Ship must run");
  assert.deepEqual(deployTest.unknown, []);
});

test("the gateway is read with POSIX awk, not a gawk extension", () => {
  // strtonum() is gawk-only. debian:bookworm-slim ships mawk, so the first
  // version of this probe found no gateway on ANY box and the gate quietly
  // checked nothing. Verified live before and after.
  const command = sandboxHostProbeCommand(49152);
  assert.doesNotMatch(command, /strtonum/, "gawk-only, and the images do not have gawk");
  assert.match(command, /0123456789abcdef/, "hex converted by index, which every awk can do");
  assert.match(command, /proc\/net\/route/, "the source every Linux container has");
});
