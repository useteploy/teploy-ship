// A stdio MCP server that spawns a grandchild which outlives it, proving the
// driver kills the server's whole process GROUP (spawn detached + kill(-pid))
// and not just the direct child. The grandchild is spawned on initialize and
// is NOT detached from this server — it rides the server's process group,
// exactly like a helper a real server might leave behind. It writes
// grandchild-alive.txt 800 ms after initialize if it survives.
import { spawn } from "node:child_process";

const GRANDCHILD_DELAY_MS = 800;

let buf = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buf += chunk;
  let i;
  while ((i = buf.indexOf("\n")) >= 0) {
    const line = buf.slice(0, i).trim();
    buf = buf.slice(i + 1);
    if (line === "") continue;
    const msg = JSON.parse(line);
    let reply = null;
    if (msg.method === "initialize") {
      const grandchild = spawn(
        process.execPath,
        ["-e", `setTimeout(() => require("node:fs").writeFileSync("grandchild-alive.txt", "the group survived"), ${GRANDCHILD_DELAY_MS})`],
        { stdio: "ignore" },
      );
      grandchild.unref();
      reply = { jsonrpc: "2.0", id: msg.id, result: { protocolVersion: msg.params?.protocolVersion ?? "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "spawner", version: "1.0.0" } } };
    } else if (msg.method === "tools/list") {
      reply = { jsonrpc: "2.0", id: msg.id, result: { tools: [{ name: "echo", description: "Echo.", annotations: { readOnlyHint: true } }] } };
    }
    if (reply !== null) process.stdout.write(`${JSON.stringify(reply)}\n`);
  }
});
