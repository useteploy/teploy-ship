import { createServer } from 'node:http';
export function server() {
  return createServer(async (req, res) => {
    if (req.method !== 'POST' || req.url !== '/add') {
      res.writeHead(404).end(); return;
    }
    let text = '';
    for await (const chunk of req) {
      text += chunk;
      if (text.length > 1024) { res.writeHead(413).end(); return; }
    }
    try {
      const { a, b } = JSON.parse(text);
      if (!Number.isFinite(a) || !Number.isFinite(b)) { res.writeHead(400).end(); return; }
      res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ result: a + b }));
    } catch { res.writeHead(400).end(); }
  });
}
