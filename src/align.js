// Transcript -> per-word timing, and text-anchor -> seconds resolution.
//
// `align()` is the single seam for timing. This PoC uses a naive length-based
// estimator; a real forced aligner (WhisperX, or a timestamped TTS response)
// can replace its body as long as it returns the same
// { duration, words: [{ word, start, end }] } shape.
import { spawn } from 'node:child_process';
import { closest } from './util.js';

const WORDS_PER_SECOND = 2.5;
const SENTENCE_PAUSE = 0.25;
const CLAUSE_PAUSE = 0.12;

/** Duration of a media file in seconds, via ffprobe. */
export function probeDuration(file) {
  return new Promise((resolve, reject) => {
    const args = ['-v', 'error', '-show_entries', 'format=duration', '-of', 'default=nw=1:nk=1', file];
    const p = spawn('ffprobe', args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    p.stdout.on('data', (d) => (out += d));
    p.stderr.on('data', (d) => (err += d));
    p.on('error', (e) =>
      reject(
        e.code === 'ENOENT'
          ? new Error('ffprobe not found on PATH. Install ffmpeg (which includes ffprobe) and make sure it is on PATH.')
          : e,
      ),
    );
    p.on('close', (code) => {
      const sec = parseFloat(out);
      if (code !== 0 || !Number.isFinite(sec)) {
        reject(new Error(`ffprobe could not read the duration of "${file}": ${err.trim() || `exit code ${code}`}`));
      } else resolve(sec);
    });
  });
}

const round = (n) => Math.round(n * 1000) / 1000;

function pauseAfter(word) {
  const w = word.replace(/["')\]}»”’]+$/, '');
  if (/[.!?]$/.test(w)) return SENTENCE_PAUSE;
  if (/[,;:]$/.test(w)) return CLAUSE_PAUSE;
  return 0;
}

/**
 * Spoken length of a word: letters and digits, minus vowel killers (virama), so
 * scripts with combining marks and joiners (Sinhala, Devanagari) are not
 * over-weighted by invisible code points. Roughly the character count for Latin.
 */
export function wordWeight(word) {
  const letters = (word.match(/[\p{L}\p{N}]/gu) || []).length;
  const killers = (word.match(/[්्্்]/g) || []).length;
  return Math.max(2, letters - killers);
}

/**
 * Length-based estimate: each word gets time proportional to wordWeight(),
 * plus a pause after sentence/clause punctuation, spread over [from, to].
 * -> [{ word, start, end }] (unrounded)
 */
function estimate(tokens, from, to) {
  const total = to - from;
  const weights = tokens.map(wordWeight);
  const weightSum = weights.reduce((a, b) => a + b, 0);
  let pauses = tokens.map(pauseAfter);
  pauses[pauses.length - 1] = 0;
  const pauseSum = pauses.reduce((a, b) => a + b, 0);
  // Never let pauses eat more than a third of the total (very short audio).
  if (pauseSum > total / 3) pauses = pauses.map((p) => (p * total) / 3 / pauseSum);
  const speech = total - pauses.reduce((a, b) => a + b, 0);
  const words = [];
  let t = from;
  tokens.forEach((word, i) => {
    const d = (speech * weights[i]) / weightSum;
    words.push({ word, start: t, end: t + d });
    t += d + pauses[i];
  });
  return words;
}

/** Silent stretches in an audio file, via ffmpeg's silencedetect filter. */
export function detectPauses(file, { noiseDb = -35, minSec = 0.25 } = {}) {
  return new Promise((resolve, reject) => {
    const args = ['-hide_banner', '-nostats', '-i', file, '-af', `silencedetect=noise=${noiseDb}dB:d=${minSec}`, '-f', 'null', '-'];
    const p = spawn('ffmpeg', args, { stdio: ['ignore', 'ignore', 'pipe'] });
    let err = '';
    p.stderr.on('data', (d) => (err += d));
    p.on('error', (e) =>
      reject(e.code === 'ENOENT' ? new Error('ffmpeg not found on PATH (needed to detect pauses in the audio)') : e),
    );
    p.on('close', (code) => {
      if (code !== 0) return reject(new Error(`ffmpeg could not analyse "${file}": ${err.trim().split('\n').pop()}`));
      const pauses = [];
      let start = null;
      for (const m of err.matchAll(/silence_(start|end): (-?[\d.]+)/g)) {
        if (m[1] === 'start') start = Math.max(0, Number(m[2]));
        else if (start !== null) {
          pauses.push({ start, end: Number(m[2]) });
          start = null;
        }
      }
      resolve(pauses);
    });
  });
}

// Costs (in seconds of timing error) for the boundary/pause matching below.
const SKIP_SENTENCE = 4; // a sentence end with no pause found near it
const SKIP_CLAUSE = 0.6; // commas often have no audible pause
const MAX_SNAP = 10; // never move a boundary further than this from its estimate (seconds)…
const MAX_SNAP_FRAC = 0.04; // …or this share of the audio, for long narrations whose estimate drifts
const RATE_WEIGHT = 6; // cost per unit of |ln(segment rate / overall rate)|
const EST_WEIGHT = 0.2; // cost per second of distance from the length-based estimate
const KIND_MISMATCH = 0.3; // sentence end on a short pause, or a comma on a long one (weak: narrators often
// breathe mid-sentence and run short sentences together, so pause length is only a hint)

/**
 * Split pause durations into a short and a long group (Otsu's method on the
 * durations). -> (pause) => isLong, or null when the groups are not clearly
 * different (then pause length is not used).
 */
function classifyPauses(pauses) {
  const d = pauses.map((p) => p.end - p.start).sort((a, b) => a - b);
  if (d.length < 6) return null;
  let best = null;
  for (let k = 2; k <= d.length - 2; k++) {
    const lo = d.slice(0, k);
    const hi = d.slice(k);
    const mLo = lo.reduce((a, b) => a + b, 0) / lo.length;
    const mHi = hi.reduce((a, b) => a + b, 0) / hi.length;
    const between = (lo.length * hi.length * (mHi - mLo) ** 2) / d.length ** 2;
    if (!best || between > best.between) best = { between, mLo, mHi, threshold: (d[k - 1] + d[k]) / 2 };
  }
  if (!best || best.mHi / best.mLo < 1.35) return null;
  return (p) => p.end - p.start >= best.threshold;
}

/**
 * Snap punctuation boundaries onto pauses detected in the audio, then
 * re-spread the words between snapped boundaries. A monotonic alignment
 * (dynamic programming) picks which boundary goes with which pause.
 * -> { words, snapped, sentences }
 */
function snapToPauses(tokens, duration, pauses) {
  let speechStart = 0;
  let speechEnd = duration;
  const inner = [...pauses];
  if (inner.length && inner[0].start < 0.05) speechStart = inner.shift().end;
  if (inner.length && inner[inner.length - 1].end > duration - 0.05) speechEnd = inner.pop().start;

  const est = estimate(tokens, speechStart, speechEnd);
  const bounds = [];
  tokens.forEach((w, i) => {
    if (i === tokens.length - 1) return;
    const kind = pauseAfter(w);
    if (kind) bounds.push({ i, sentence: kind === SENTENCE_PAUSE, at: (est[i].end + est[i + 1].start) / 2 });
  });

  // Choose which boundary goes with which pause (monotonic) by dynamic
  // programming over whole segments. A segment is the run of words between
  // two consecutive matched boundaries; its cost is how far its speaking rate
  // (characters per second) is from the narration's overall rate, so a
  // sentence can't be squeezed into a comma pause's slot. A small pull toward
  // the length-based estimate breaks ties, and skipping a boundary or a long
  // pause costs extra.
  const B = bounds.length;
  const P = inner.length;
  const n = tokens.length;
  const cum = [0];
  for (const w of tokens) cum.push(cum[cum.length - 1] + wordWeight(w));
  // Reference rate over speech only: segments are measured between pauses, so
  // counting pause time here would make every segment look fast.
  const pausedTime = inner.reduce((a, p) => a + (p.end - p.start), 0);
  const rate = cum[n] / Math.max(0.1, speechEnd - speechStart - pausedTime);
  const segCost = (i0, i1, t0, t1) => {
    const dt = t1 - t0;
    if (i1 < i0 || dt < 0.05) return Infinity;
    return RATE_WEIGHT * Math.abs(Math.log((cum[i1 + 1] - cum[i0]) / dt / rate));
  };
  // Narrators (and TTS) pause longer at sentence ends than at commas. When the
  // pauses clearly fall into a long and a short group, use it: sentence ends
  // prefer long pauses, commas short ones, and skipping a long pause is costly.
  const isLong = classifyPauses(inner);
  const skipPause = (p) =>
    isLong ? (isLong(p) ? 1.5 : 0.1) : p.end - p.start >= 0.4 ? 1.0 : 0.15;
  const kindCost = (b, p) => (isLong && bounds[b].sentence !== isLong(inner[p]) ? KIND_MISMATCH : 0);
  const sb = [0];
  for (const b of bounds) sb.push(sb[sb.length - 1] + (b.sentence ? SKIP_SENTENCE : SKIP_CLAUSE));
  const sp = [0];
  for (const p of inner) sp.push(sp[sp.length - 1] + skipPause(p));
  // Cost of skipping boundaries strictly between b0 and b1 (b0 = -1: from the start).
  const skipB = (b0, b1) => sb[b1] - sb[b0 + 1];
  const skipP = (p0, p1) => sp[p1] - sp[p0 + 1];
  const mid = (p) => (inner[p].start + inner[p].end) / 2;
  const maxSnap = Math.max(MAX_SNAP, MAX_SNAP_FRAC * duration);

  const dp = Array.from({ length: B }, () => new Array(P).fill(Infinity));
  const from = Array.from({ length: B }, () => new Array(P).fill(null));
  for (let b = 0; b < B; b++) {
    for (let p = 0; p < P; p++) {
      const err = Math.abs(bounds[b].at - mid(p));
      if (err > maxSnap) continue;
      let best = skipB(-1, b) + skipP(-1, p) + segCost(0, bounds[b].i, speechStart, inner[p].start);
      let arg = null;
      for (let b0 = 0; b0 < b; b0++) {
        for (let p0 = 0; p0 < p; p0++) {
          const c = dp[b0][p0];
          if (c === Infinity) continue;
          const total = c + skipB(b0, b) + skipP(p0, p) + segCost(bounds[b0].i + 1, bounds[b].i, inner[p0].end, inner[p].start);
          if (total < best) [best, arg] = [total, [b0, p0]];
        }
      }
      dp[b][p] = best + EST_WEIGHT * err + kindCost(b, p);
      from[b][p] = arg;
    }
  }
  let bestEnd = skipB(-1, B) + skipP(-1, P) + segCost(0, n - 1, speechStart, speechEnd);
  let last = null;
  for (let b = 0; b < B; b++) {
    for (let p = 0; p < P; p++) {
      if (dp[b][p] === Infinity) continue;
      const total = dp[b][p] + skipB(b, B) + skipP(p, P) + segCost(bounds[b].i + 1, n - 1, inner[p].end, speechEnd);
      if (total < bestEnd) [bestEnd, last] = [total, [b, p]];
    }
  }
  const matched = [];
  for (let cur = last; cur; cur = from[cur[0]][cur[1]]) {
    const [b, p] = cur;
    matched.unshift({ i: bounds[b].i, pause: inner[p], sentence: bounds[b].sentence });
  }

  // Knots: speech start, every matched boundary, speech end. Words between
  // two knots keep their estimated proportions, stretched to fit.
  const words = [];
  const knots = [{ i: -1, t: speechStart }, ...matched.map((m) => ({ i: m.i, t: m.pause.start, next: m.pause.end }))];
  knots.forEach((k, n) => {
    const a = k.i + 1;
    const z = n + 1 < knots.length ? knots[n + 1].i : tokens.length - 1;
    const t0 = k.next ?? k.t;
    const t1 = n + 1 < knots.length ? knots[n + 1].t : speechEnd;
    for (const w of estimate(tokens.slice(a, z + 1), t0, Math.max(t0 + 0.05, t1))) words.push(w);
  });
  return {
    words,
    snapped: matched.length,
    sentences: bounds.filter((b) => b.sentence).length,
    snappedSentences: matched.filter((m) => m.sentence).length,
  };
}

/**
 * -> { duration, words: [{ word, start, end }], method }
 * Without audio: the length-based estimate over wordCount / 2.5 seconds.
 * With audio: the estimate is fitted to the audio's length, and sentence and
 * clause boundaries are snapped onto pauses detected in the audio.
 */
export async function align(transcript, audioPath) {
  const tokens = transcript.split(/\s+/).filter(Boolean);
  if (!tokens.length) throw new Error('transcript is empty');
  const fin = (words) => words.map((w) => ({ word: w.word, start: round(w.start), end: round(w.end) }));
  if (!audioPath) {
    const total = tokens.length / WORDS_PER_SECOND;
    return { duration: round(total), words: fin(estimate(tokens, 0, total)), method: 'estimate' };
  }
  const total = await probeDuration(audioPath);
  const pauses = await detectPauses(audioPath);
  const r = snapToPauses(tokens, total, pauses);
  return {
    duration: round(total),
    words: fin(r.words),
    method: 'estimate+pauses',
    stats: { pauses: pauses.length, snapped: r.snapped, sentences: r.sentences, snappedSentences: r.snappedSentences },
  };
}

// ---------------------------------------------------------------------------
// Anchor resolution. Both transcript and anchor are normalized (lowercase,
// punctuation stripped, hyphens/slashes treated as spaces), then the anchor is
// matched as a contiguous run of normalized tokens.

export function normalizeTokens(text) {
  return text
    .toLowerCase()
    .replace(/[-–—/]+/g, ' ')
    // Keep combining marks (\p{M}): vowel signs in Sinhala, Hindi, etc. are part of words.
    .replace(/[\u200B-\u200D\uFEFF]/g, '')
    .replace(/[^\p{L}\p{M}\p{N}\s]+/gu, '')
    .split(/\s+/)
    .filter(Boolean);
}

/** Token stream for a timing file: [{ tok, wordIndex }] */
function transcriptTokens(timing) {
  if (!timing.__tokens) {
    const toks = [];
    timing.words.forEach((w, wordIndex) => {
      for (const tok of normalizeTokens(w.word)) toks.push({ tok, wordIndex });
    });
    Object.defineProperty(timing, '__tokens', { value: toks, enumerable: false });
  }
  return timing.__tokens;
}

/** -> array of { startWord, endWord } for every occurrence of the anchor. */
export function findAnchor(timing, anchor) {
  const needle = normalizeTokens(anchor);
  const toks = transcriptTokens(timing);
  const hits = [];
  if (!needle.length) return hits;
  outer: for (let i = 0; i + needle.length <= toks.length; i++) {
    for (let j = 0; j < needle.length; j++) if (toks[i + j].tok !== needle[j]) continue outer;
    hits.push({ startWord: toks[i].wordIndex, endWord: toks[i + needle.length - 1].wordIndex });
  }
  return hits;
}

/** Up to `n` transcript phrases closest to the anchor, in original wording. */
export function suggestAnchors(timing, anchor, n = 3) {
  const needle = normalizeTokens(anchor);
  const toks = transcriptTokens(timing);
  const candidates = new Map(); // normalized -> original text
  const lens = [needle.length - 1, needle.length, needle.length + 1].filter((k) => k >= 1);
  for (const k of lens) {
    for (let i = 0; i + k <= toks.length; i++) {
      const norm = toks.slice(i, i + k).map((t) => t.tok).join(' ');
      if (!candidates.has(norm)) {
        const words = timing.words.slice(toks[i].wordIndex, toks[i + k - 1].wordIndex + 1).map((w) => w.word);
        candidates.set(norm, words.join(' ').replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, ''));
      }
    }
  }
  return closest(needle.join(' '), [...candidates.keys()], n).map((k) => candidates.get(k));
}

/** Start time (seconds) of the given 1-based occurrence of the anchor, or null. */
export function anchorTime(timing, anchor, occurrence = 1) {
  const hit = findAnchor(timing, anchor)[occurrence - 1];
  return hit ? timing.words[hit.startWord].start : null;
}
