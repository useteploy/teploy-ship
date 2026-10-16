// A stdio MCP server that paginates tools/list: 10 tools per page, 150 tools
// total (15 pages, so the client's own 10-page ceiling is NOT what stops a
// well-behaved client). Every tools/list request is appended to
// mcp-pages.log in the working directory, so a test can prove the client
// stopped pulling pages once it held MAX_TOOLS_PER_SERVER tools.
import { appendFileSync } from "node:fs";

const PAGE_SIZE = 10;
const TOTAL_TOOLS = 150;

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
      reply = { jsonrpc: "2.0", id: msg.id, result: { protocolVersion: msg.params?.protocolVersion ?? "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "pager", version: "1.0.0" } } };
    } else if (msg.method === "tools/list") {
      appendFileSync("mcp-pages.log", `${msg.params?.cursor ?? 0}\n`);
      const page = Number(msg.params?.cursor ?? 0);
      const base = page * PAGE_SIZE;
      const tools = Array.from({ length: Math.min(PAGE_SIZE, TOTAL_TOOLS - base) }, (_, k) => ({
        name: `tool-${String(base + k).padStart(3, "0")}`,
        annotations: { readOnlyHint: true },
      }));
      const result = { tools };
      if (base + PAGE_SIZE < TOTAL_TOOLS) result.nextCursor = String(page + 1);
      reply = { jsonrpc: "2.0", id: msg.id, result };
    }
    if (reply !== null) process.stdout.write(`${JSON.stringify(reply)}\n`);
  }
});
