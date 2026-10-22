// Unit check: geometry for the same element id must be byte-identical across
// separate calls (in-process with the cache cleared, and in a fresh process).
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
// fixed fixture library, so the test does not depend on the local (untracked) assets/ folder;
// set before geometry.js loads, and inherited by the --print child process
process.env.WHITEBOARD_ASSETS = fileURLToPath(new URL('./fixtures/assets', import.meta.url));
const { assetGeometry, arrowGeometry, textGeometries, clearGeometryCache } = await import('../src/geometry.js');

const canvas = { width: 1920, height: 1080, grid: [12, 8] };
const style = { stroke: '#1a1a1a', strokeWidth: 3, background: '#fdfdf8', roughness: 1.2 };

function snapshot() {
  const db = assetGeometry({ id: 'db1', asset: 'database', at: [8, 2], size: [2, 2] }, canvas, style);
  const user = assetGeometry({ id: 'u1', asset: 'user', at: [1, 2], size: [2, 2] }, canvas, style);
  const arrow = arrowGeometry({ id: 'a1' }, user.bounds, db.bounds, style);
  // Imported art: color fills, ink fills, layer order, line-art mode, flip.
  const art = assetGeometry({ id: 'p1', asset: 'artist', at: [0, 4], size: [4, 4], flip: true }, canvas, style);
  const lineArt = assetGeometry({ id: 'p2', asset: 'detective', at: [4, 4], size: [3, 3], colors: false }, canvas, style);
  const text = textGeometries([{ id: 't1', text: 'Database', at: [8, 4], size: [2, 1] }], canvas, style);
  return JSON.stringify({ db, user, arrow, art, lineArt, text: [...text] });
}

const digest = (s) => createHash('sha256').update(s).digest('hex');

if (process.argv[2] === '--print') {
  process.stdout.write(digest(snapshot()));
} else {
  const first = snapshot();
  clearGeometryCache();
  const second = snapshot();
  assert.equal(first, second, 'geometry differs between two in-process calls');
  assert.ok(JSON.parse(first).db.paths.length > 0, 'expected rough paths for the database asset');

  const other = execFileSync(process.execPath, [fileURLToPath(import.meta.url), '--print'], { encoding: 'utf8' });
  assert.equal(other, digest(first), 'geometry differs between two processes');

  // A different id must give a different seed, i.e. different rough output.
  clearGeometryCache();
  const a = assetGeometry({ id: 'x', asset: 'server', at: [0, 0], size: [2, 2] }, canvas, style);
  const b = assetGeometry({ id: 'y', asset: 'server', at: [0, 0], size: [2, 2] }, canvas, style);
  assert.notEqual(a.paths[0].d, b.paths[0].d, 'different ids should produce different strokes');

  console.log(`OK geometry is deterministic (sha256 ${digest(first).slice(0, 16)}…, ${first.length} bytes)`);
}
