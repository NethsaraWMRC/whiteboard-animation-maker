// Narration recorded in several parts (narration-p1.mp3, narration-p2.mp3, ...) for one script,
// or a single narration.mp3 (then nothing is joined; use it with --mms for exact word times).
//
//   node tools/align-parts.mjs my/theories/Titration [--gap 0.8] [--mms]
//
// --mms: align with tools/align-mms.py (Meta MMS forced alignment, exact word times; needs the
//        .venv-align environment) instead of the pause-based estimate of src/align.js.
//
// 1. Joins the parts into <dir>/narration.mp3 with a short silence between them.
// 2. Splits transcript.txt (or script.txt) at the paragraph break whose share of the spoken text
//    is closest to each part's share of the audio, and prints the split so it can be checked.
// 3. Aligns every part against its own audio (a known boundary keeps errors from spreading
//    across parts) and merges the results, shifted by the part offsets, into <dir>/timing.json.
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { align, probeDuration, wordWeight } from '../src/align.js';

const dir = process.argv[2];
if (!dir) throw new Error('usage: node tools/align-parts.mjs <dir> [--gap seconds]');
const gi = process.argv.indexOf('--gap');
const GAP = gi > 0 ? Number(process.argv[gi + 1]) : 0.8;
const MMS = process.argv.includes('--mms');
// paths from the project root, so the script runs from any working directory
const ROOT = path.join(import.meta.dirname, '..');
const PY = path.join(ROOT, '.venv-align', 'Scripts', 'python');
const MMS_PY = path.join(import.meta.dirname, 'align-mms.py');
const TORCH_HOME = path.join(ROOT, '.venv-align', 'torch-cache');
/** Exact word times for one part via MMS forced alignment (tools/align-mms.py). */
function alignMms(textFile, audio, outFile) {
  execFileSync(PY, [MMS_PY, textFile, audio, outFile], {
    stdio: ['ignore', 'inherit', 'inherit'],
    env: { ...process.env, TORCH_HOME },
  });
  const t = JSON.parse(fs.readFileSync(outFile, 'utf8'));
  const sentences = t.words.filter((w) => /[.!?]$/.test(w.word)).length;
  return { ...t, stats: { snappedSentences: sentences, sentences } };
}

const parts = fs
  .readdirSync(dir)
  .filter((f) => /^narration-p\d+\.mp3$/.test(f))
  .sort((a, b) => Number(a.match(/\d+/)[0]) - Number(b.match(/\d+/)[0]))
  .map((f) => path.join(dir, f));
const single = parts.length === 0 && fs.existsSync(path.join(dir, 'narration.mp3'));
if (single) parts.push(path.join(dir, 'narration.mp3')); // one recording: just align it
if (!parts.length) throw new Error(`need narration.mp3 or narration-p1.mp3, narration-p2.mp3, ... in ${dir}`);

const tPath = fs.existsSync(path.join(dir, 'transcript.txt')) ? path.join(dir, 'transcript.txt') : path.join(dir, 'script.txt');
if (!tPath.endsWith('transcript.txt')) fs.copyFileSync(tPath, path.join(dir, 'transcript.txt'));
const text = fs.readFileSync(path.join(dir, 'transcript.txt'), 'utf8');

// --- durations and the joined audio
const durs = [];
for (const p of parts) durs.push(await probeDuration(p));
const inputs = [];
parts.forEach((p, i) => {
  inputs.push('-i', p);
  if (i < parts.length - 1) inputs.push('-f', 'lavfi', '-t', String(GAP), '-i', 'anullsrc=r=44100:cl=mono');
});
const lab = inputs.filter((a) => a === '-i').map((_, i) => `[${i}:a]`);
const out = path.join(dir, 'narration.mp3');
if (!single) execFileSync('ffmpeg', ['-y', '-loglevel', 'error', ...inputs, '-filter_complex', `${lab.join('')}concat=n=${lab.length}:v=0:a=1[a]`, '-map', '[a]', '-c:a', 'libmp3lame', '-b:a', '128k', out]);
if (!single) console.log(`joined ${parts.length} parts -> ${out}`);

// --- split the transcript at paragraph breaks
const paras = text.split(/\n\s*\n/).map((s) => s.trim()).filter(Boolean);
const weight = (s) => s.split(/\s+/).filter(Boolean).reduce((a, w) => a + wordWeight(w), 0);
const cumW = [0];
for (const p of paras) cumW.push(cumW[cumW.length - 1] + weight(p));
const totalD = durs.reduce((a, b) => a + b, 0);
const cuts = [0];
let accD = 0;
for (let i = 0; i < parts.length - 1; i++) {
  accD += durs[i];
  const target = (accD / totalD) * cumW[cumW.length - 1];
  let best = cuts[cuts.length - 1] + 1;
  for (let j = best; j < paras.length; j++) if (Math.abs(cumW[j] - target) < Math.abs(cumW[best] - target)) best = j;
  if (MMS) {
    // Text length is only a guess (the first Titration split was one paragraph off): listen to
    // the start of the next part and pick the paragraph it really begins with.
    const cands = [];
    for (let j = Math.max(cuts[cuts.length - 1] + 1, best - 3); j <= Math.min(paras.length - 1, best + 3); j++) cands.push(j);
    const tFile = path.join(dir, 'transcript.txt');
    const heard = execFileSync(PY, [MMS_PY, '--pick', tFile, parts[i + 1], cands.join(',')], {
      env: { ...process.env, TORCH_HOME },
      stdio: ['ignore', 'pipe', 'inherit'],
    }).toString().trim().split(/\s+/).pop();
    if (Number(heard) !== best) console.log(`part ${i + 2} starts at paragraph ${Number(heard) + 1} (by listening), not ${best + 1} (by length)`);
    best = Number(heard);
  }
  cuts.push(best);
}
cuts.push(paras.length);

// --- align each part and merge
const words = [];
let offset = 0;
const alignDir = path.join(dir, 'align');
fs.mkdirSync(alignDir, { recursive: true });
for (let i = 0; i < parts.length; i++) {
  const partText = paras.slice(cuts[i], cuts[i + 1]).join('\n\n') + '\n';
  const partFile = path.join(alignDir, `p${i + 1}.txt`);
  fs.writeFileSync(partFile, partText);
  const t = MMS ? alignMms(partFile, parts[i], path.join(alignDir, `p${i + 1}.mms.json`)) : await align(partText, parts[i]);
  fs.writeFileSync(path.join(alignDir, `p${i + 1}.json`), JSON.stringify(t, null, 2) + '\n');
  const first = paras[cuts[i]].slice(0, 50);
  console.log(`part ${i + 1}: ${durs[i].toFixed(1)}s at +${offset.toFixed(2)}s, paragraphs ${cuts[i] + 1}-${cuts[i + 1]}, snapped ${t.stats.snappedSentences}/${t.stats.sentences} sentence ends; starts "${first}…"`);
  for (const w of t.words) words.push({ word: w.word, ...(w.score != null ? { score: w.score } : {}), start: Math.round((w.start + offset) * 1000) / 1000, end: Math.round((w.end + offset) * 1000) / 1000 });
  offset += durs[i] + GAP;
}
const timing = { duration: Math.round((await probeDuration(out)) * 1000) / 1000, words, method: MMS ? 'mms forced alignment, per part' : 'estimate+pauses, per part' };
fs.writeFileSync(path.join(dir, 'timing.json'), JSON.stringify(timing, null, 2) + '\n');
console.log(`wrote ${path.join(dir, 'timing.json')}: ${words.length} words, ${timing.duration}s`);
