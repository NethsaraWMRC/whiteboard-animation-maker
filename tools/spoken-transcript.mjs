// The narration does not always say everything in script.txt (a TTS run can drop sentences).
// From <dir>/audio-gaps.json this writes what is really spoken:
//
//   node tools/spoken-transcript.mjs my/theories/Titration
//
//   <dir>/transcript.txt    script.txt without the unspoken words (paragraphs kept)
//   <dir>/spoken-map.json   for every script word index: its index in transcript.txt, or -1
//
// audio-gaps.json: { gaps: [ { sentences: [from, to] } | { sentence: n, keepWords: k } ] }
// (sentence numbers count script.txt sentences split at . ! ?, from 1).
import fs from 'node:fs';
import path from 'node:path';

const dir = process.argv[2];
if (!dir) throw new Error('usage: node tools/spoken-transcript.mjs <dir>');
const script = fs.readFileSync(path.join(dir, 'script.txt'), 'utf8');
const { gaps } = JSON.parse(fs.readFileSync(path.join(dir, 'audio-gaps.json'), 'utf8'));

const paras = script.split(/\n\s*\n/).map((p) => p.trim()).filter(Boolean).map((p) => p.split(/\s+/));
const words = paras.flat();
const sentOf = [];
let n = 1;
words.forEach((w) => {
  sentOf.push(n);
  if (/[.!?]$/.test(w)) n++;
});
const posInSent = [];
words.forEach((w, i) => posInSent.push(i > 0 && sentOf[i - 1] === sentOf[i] ? posInSent[i - 1] + 1 : 0));

const dropped = words.map((w, i) => gaps.some((g) => (g.sentences ? sentOf[i] >= g.sentences[0] && sentOf[i] <= g.sentences[1] : sentOf[i] === g.sentence && posInSent[i] >= g.keepWords)));
const map = [];
let k = 0;
let wi = 0;
const outParas = [];
for (const p of paras) {
  const kept = [];
  for (const w of p) {
    if (dropped[wi]) map.push(-1);
    else {
      map.push(k++);
      kept.push(w);
    }
    wi++;
  }
  if (kept.length) outParas.push(kept.join(' '));
}
fs.writeFileSync(path.join(dir, 'transcript.txt'), outParas.join('\n\n') + '\n');
fs.writeFileSync(path.join(dir, 'spoken-map.json'), JSON.stringify(map) + '\n');
const lost = dropped.filter(Boolean).length;
console.log(`transcript.txt: ${k} of ${words.length} script words are spoken (${lost} dropped, ${paras.length - outParas.length} whole paragraphs)`);
