// Recoverable publication, not a multi-file atomic transaction. Keep this helper
// identical in consumers. Only run recovery after the previous process stopped.
import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync,
  readdirSync, renameSync, rmSync, rmdirSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, join, resolve } from 'node:path';

const directoryName = '.framework-lock-refresh';
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const syncDirectory = path => {
  const fd = openSync(path, 'r');
  try { fsyncSync(fd); } finally { closeSync(fd); }
};
function writeVerified(path, bytes) {
  const fd = openSync(path, 'wx', 0o600);
  try { writeFileSync(fd, bytes); fsyncSync(fd); } finally { closeSync(fd); }
  if (!readFileSync(path).equals(bytes)) throw new Error(`Verification failed: ${path}`);
  syncDirectory(dirname(path));
}
function writeRecord(path, bytes) {
  const temporary = `${path}.tmp`;
  rmSync(temporary, { force: true });
  writeVerified(temporary, bytes);
  renameSync(temporary, path);
  syncDirectory(dirname(path));
}
const pathsFor = (root, files) => files.map((file, index) => ({
  file,
  destination: resolve(root, file),
  prepared: resolve(root, `${file}.framework-refresh-new`),
  restore: resolve(root, `${file}.framework-refresh-restore`),
  backup: join(root, directoryName, `${index}.original`),
}));
export function assertNoPendingPublication(root) {
  if (existsSync(join(root, directoryName))) {
    throw new Error('Incomplete lock refresh detected. Stop the previous process and run node scripts/refresh-framework-locks.mjs --recover; do not install or deploy.');
  }
}
function complete(root, entries, hashes) {
  writeRecord(join(root, directoryName, 'complete.json'), Buffer.from(JSON.stringify({
    version: 1, entries: entries.map((entry, i) => ({ file: entry.file, hash: hashes[i] })),
  }) + '\n'));
}
function cleanup(root, entries) {
  for (const entry of entries) {
    for (const path of [entry.prepared, entry.restore]) rmSync(path, { force: true });
    syncDirectory(dirname(entry.destination));
  }
  // Backups/journal are removed only after replacement or restoration verified.
  const directory = join(root, directoryName);
  // Keep completion durable until the journal and all backups are gone. A
  // crash during cleanup can then finish without needing deleted backups.
  for (const entry of entries) rmSync(entry.backup, { force: true });
  for (const name of ['journal.json', 'journal.json.tmp', 'complete.json.tmp']) {
    rmSync(join(directory, name), { force: true });
  }
  syncDirectory(directory);
  rmSync(join(directory, 'complete.json'));
  syncDirectory(directory);
  rmdirSync(directory);
  syncDirectory(root);
}
function readJournal(root, files) {
  const entries = pathsFor(root, files);
  const journal = JSON.parse(readFileSync(join(root, directoryName, 'journal.json'), 'utf8'));
  if (journal.version !== 1 || journal.entries?.length !== entries.length ||
      entries.some((entry, i) => journal.entries[i].file !== entry.file ||
        !/^[a-f0-9]{64}$/.test(journal.entries[i].originalHash))) {
    throw new Error('Invalid lock refresh journal; preserve recovery material for manual inspection.');
  }
  return entries.map((entry, i) => ({ ...entry, originalHash: journal.entries[i].originalHash }));
}
export function recoverPublication(root, files, { replace = renameSync } = {}) {
  if (!existsSync(join(root, directoryName))) return false;
  const directory = join(root, directoryName);
  const expected = pathsFor(root, files);
  if (existsSync(join(directory, 'complete.json'))) {
    const completion = JSON.parse(readFileSync(join(directory, 'complete.json'), 'utf8'));
    if (completion.version !== 1 || completion.entries?.length !== expected.length ||
        expected.some((entry, i) => completion.entries[i].file !== entry.file ||
          hash(readFileSync(entry.destination)) !== completion.entries[i].hash)) {
      throw new Error('Completed lock refresh differs from recorded bytes; preserve recovery material for inspection.');
    }
    cleanup(root, expected);
    return true;
  }
  if (!existsSync(join(directory, 'journal.json'))) {
    // Interruption immediately after mkdir, or at the very end of cleanup.
    // Neither state can have pending sibling files or other recovery material.
    if (readdirSync(directory).some(name => name !== 'journal.json.tmp') || expected.some(entry =>
      existsSync(entry.prepared) || existsSync(entry.restore))) {
      throw new Error('Missing journal; preserve recovery material for manual inspection.');
    }
    rmSync(join(directory, 'journal.json.tmp'), { force: true });
    rmdirSync(directory);
    syncDirectory(root);
    return true;
  }
  const entries = readJournal(root, files);
  // Preflight every backup before restoring anything. During preparation a backup
  // may not exist yet, but no replacement is allowed before all backups exist.
  const originals = entries.map(entry => {
    if (existsSync(entry.backup)) {
      const bytes = readFileSync(entry.backup);
      if (hash(bytes) !== entry.originalHash) throw new Error(`Corrupt backup: ${entry.backup}`);
      return bytes;
    }
    const bytes = readFileSync(entry.destination);
    if (hash(bytes) !== entry.originalHash) throw new Error(`Missing backup: ${entry.backup}`);
    return bytes;
  });
  for (const [i, entry] of entries.entries()) {
    if (hash(readFileSync(entry.destination)) === entry.originalHash) continue;
    rmSync(entry.restore, { force: true });
    writeVerified(entry.restore, originals[i]);
    replace(entry.restore, entry.destination, 'rollback', i);
    syncDirectory(dirname(entry.destination));
    if (!readFileSync(entry.destination).equals(originals[i])) throw new Error(`Restore failed: ${entry.destination}`);
  }
  complete(root, entries, originals.map(hash));
  cleanup(root, entries);
  return true;
}
export function publishPair(root, pairs, { replace = renameSync } = {}) {
  assertNoPendingPublication(root);
  const files = pairs.map(pair => pair.file);
  const entries = pathsFor(root, files);
  const originals = entries.map(entry => readFileSync(entry.destination));
  const generated = pairs.map(pair => readFileSync(pair.source));
  for (const entry of entries) {
    if (existsSync(entry.prepared) || existsSync(entry.restore)) {
      throw new Error(`Unexpected sibling recovery file for ${entry.file}; inspect before refreshing.`);
    }
  }
  const directory = join(root, directoryName);
  mkdirSync(directory, { mode: 0o700 }); // Exclusive publication ownership.
  syncDirectory(root);
  // Journal is immutable. Before the durable completion record, interrupted
  // publication conservatively restores the old pair.
  try {
    writeRecord(join(directory, 'journal.json'), Buffer.from(JSON.stringify({
      version: 1, entries: entries.map((entry, i) => ({ file: entry.file, originalHash: hash(originals[i]) })),
    }) + '\n'));
    for (const [i, entry] of entries.entries()) {
      writeVerified(entry.backup, originals[i]);
      writeVerified(entry.prepared, generated[i]);
    }
    for (const [i, entry] of entries.entries()) {
      replace(entry.prepared, entry.destination, 'publish', i);
      syncDirectory(dirname(entry.destination));
      if (!readFileSync(entry.destination).equals(generated[i])) throw new Error(`Replacement failed: ${entry.destination}`);
    }
  } catch (error) {
    try { recoverPublication(root, files, { replace }); }
    catch (rollbackError) {
      throw new AggregateError([error, rollbackError], `Lock refresh failed; recovery material retained at ${directory}. Stop the process and run --recover before installing or deploying.`);
    }
    throw new Error('Lock refresh failed; original lock bytes restored.', { cause: error });
  }
  complete(root, entries, generated.map(hash));
  // Cleanup errors leave an incomplete marker; they must not trigger rollback
  // after cleanup may already have removed some backups.
  cleanup(root, entries);
}
