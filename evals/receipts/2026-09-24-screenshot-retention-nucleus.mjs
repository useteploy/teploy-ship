import assert from 'node:assert/strict';
import { NucleusPgwire } from '/app/dist/nucleus-pgwire.js';
import { NucleusArtifacts } from '/app/dist/artifacts.js';
const db=new NucleusPgwire('postgres://nucleus@codex-retention-nucleus-proof:5432/nucleus');
try {
 const store=new NucleusArtifacts(db);
 const png=Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]),Buffer.alloc(200000,42)]);
 const permanent=await store.put('proof.png',png);
 const old=await store.putTemporary('takeover.png',png);
 const fresh=await store.putTemporary('takeover.png',png);
 assert.equal(new Set([permanent,old,fresh]).size,3);
 assert.equal((await store.get(old)).data,png.toString('base64'));
 const raw=(await db.query('SELECT artifact_value FROM ship_artifacts WHERE artifact_key = $1',[old]))[0].artifact_value;
 const manifest={...JSON.parse(raw),expiresAt:'2000-01-01T00:00:00.000Z'};
 await db.query('UPDATE ship_artifacts SET artifact_value = $1 WHERE artifact_key = $2',[JSON.stringify(manifest),old]);
 await db.query('UPDATE ship_artifact_expiry SET expires_at = $1 WHERE artifact_id = $2',[manifest.expiresAt,old]);
 assert.equal(await store.get(old),null);
 await store.pruneExpired();
 assert.equal(await store.get(old),null);
 assert.equal((await store.get(permanent)).data,png.toString('base64'));
 assert.equal((await store.get(fresh)).data,png.toString('base64'));
 const rows=await db.query('SELECT artifact_key FROM ship_artifacts');
 assert.ok(rows.every(r=>!r.artifact_key.startsWith(old)));
 assert.equal((await db.query('SELECT artifact_id FROM ship_artifact_expiry')).length,1);
 console.log(JSON.stringify({pass:true,nucleusImage:'v1.1.1',bytes:png.length,checks:['temporary full roundtrip','independent identity','expiry hidden on read','expired chunks and manifest deleted','permanent identical image preserved','newer identical capture preserved','expiry index cleaned']}));
} finally {await db.close();}
