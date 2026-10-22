// Small shared helpers: string distance, hashing, number formatting, paths.
import { existsSync } from 'node:fs';
import { isAbsolute, resolve, dirname } from 'node:path';

export function levenshtein(a, b) {
  if (a === b) return 0;
  if (!a.length) return b.length;
  if (!b.length) return a.length;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  let curr = new Array(b.length + 1);
  for (let i = 1; i <= a.length; i++) {
    curr[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      curr[j] = Math.min(prev[j] + 1, curr[j - 1] + 1, prev[j - 1] + cost);
    }
    [prev, curr] = [curr, prev];
  }
  return prev[b.length];
}

/** Return up to `n` candidates sorted by Levenshtein distance to `target`. */
export function closest(target, candidates, n) {
  return [...new Set(candidates)]
    .map((c) => ({ c, d: levenshtein(target, c) }))
    .sort((x, y) => x.d - y.d || x.c.localeCompare(y.c))
    .slice(0, n)
    .map((x) => x.c);
}

/** FNV-1a 32-bit hash -> positive int, used as a deterministic rough.js seed. */
export function hashSeed(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  // rough.js treats seed 0 as "random", so never return 0.
  return (h >>> 0) % 2147483646 + 1;
}

/** Fixed-precision number formatting so SVG output is stable and compact. */
export function fmt(n, digits = 2) {
  const s = n.toFixed(digits);
  // Strip trailing zeros ("12.50" -> "12.5", "3.00" -> "3") and "-0".
  const t = s.includes('.') ? s.replace(/\.?0+$/, '') : s;
  return t === '-0' ? '0' : t;
}

export function quoteList(items) {
  return items.map((s) => `"${s}"`).join(', ');
}

/**
 * Resolve an audio path from scene.json: absolute paths as-is, otherwise
 * relative to the current directory, falling back to the scene file's folder.
 * With { mustExist: true }, returns null when no candidate exists.
 */
export function resolveAudioPath(audio, scenePath, { mustExist = false } = {}) {
  if (isAbsolute(audio)) return mustExist && !existsSync(audio) ? null : audio;
  const candidates = [resolve(audio)];
  if (scenePath) candidates.push(resolve(dirname(scenePath), audio));
  const found = candidates.find((p) => existsSync(p));
  return found ?? (mustExist ? null : candidates[0]);
}
