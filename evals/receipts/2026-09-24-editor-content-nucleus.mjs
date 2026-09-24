import assert from 'node:assert/strict';
import { NucleusPgwire } from '/app/dist/nucleus-pgwire.js';
import { NucleusWorkspaceContent } from '/app/dist/workspace-content.js';
const db = new NucleusPgwire('postgres://nucleus@codex-editor-nucleus-proof:5432/nucleus');
try {
 const store = new NucleusWorkspaceContent(db);
 const content = 'é"\n'.repeat(50000);
 await store.put('run-proof','request-proof',content);
 assert.equal(await store.get('run-proof','request-proof'),content);
 await assert.rejects(store.get('other-run','request-proof'), /missing/);
 await assert.rejects(store.put('run-proof','oversize',content+'x'), /200000/);
 const rows = await db.query('SELECT content_value FROM ship_workspace_content');
 assert.ok(rows.length>30);
 assert.ok(rows.every(r=>Buffer.byteLength(r.content_value)<14000));
 await db.query('DELETE FROM ship_workspace_content WHERE content_key = $1',['run-proof:request-proof:2']);
 await assert.rejects(store.get('run-proof','request-proof'), /incomplete/);
 await store.put('run-proof','empty','');
 assert.equal(await store.get('run-proof','empty'),'');
 await db.query('UPDATE ship_workspace_content SET expires_at = $1',['2000-01-01T00:00:00.000Z']);
 await store.prune();
 assert.equal((await db.query('SELECT content_value FROM ship_workspace_content')).length,0);
 console.log(JSON.stringify({pass:true,nucleus:'v1.1.1',bytes:Buffer.byteLength(content),rows:rows.length,maxRowBytes:Math.max(...rows.map(r=>Buffer.byteLength(r.content_value))),checks:['UTF8 exact roundtrip','run scoping','oversize refused','missing chunk refused','empty file','expiry pruning']}));
} finally { await db.close(); }
