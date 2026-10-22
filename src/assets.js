// Load the SVG asset library and its manifest.
//
// Each asset is assets/<name>.svg (viewBox 0 0 100 100, <path> elements only)
// plus an entry in assets/manifest.json:
//   { description, tags?, strokeOrder?, roughness?, frame?: [x, y, w, h], source?, license? }
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join, dirname, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { closest, quoteList } from './util.js';

// WHITEBOARD_ASSETS points at another library (the tests use test/fixtures/assets)
export const ASSET_DIR = process.env.WHITEBOARD_ASSETS ?? join(dirname(fileURLToPath(import.meta.url)), '..', 'assets');

let cache = null;

const attrsOf = (s) => Object.fromEntries([...s.matchAll(/([\w:-]+)="([^"]*)"/g)].map((m) => [m[1], m[2]]));
const paintOf = (v) => (v && v !== 'none' ? v : null);

/** -> [{ d, fill, rule, stroke, strokeWidth }] in document order. */
function parseAssetSvg(name, svg) {
  const file = `${name}.svg`;
  if (!/viewBox="0 0 100 100"/.test(svg)) {
    throw new Error(`assets/${file}: must use viewBox="0 0 100 100" (run \`whiteboard asset import\` to normalize it)`);
  }
  const forbidden = svg.match(/<(g|rect|circle|ellipse|line|polyline|polygon|text|use|image)\b/);
  if (forbidden) {
    throw new Error(`assets/${file}: only <path> elements are allowed, found <${forbidden[1]}> (run \`whiteboard asset import\`)`);
  }
  if (/\btransform=/.test(svg)) {
    throw new Error(`assets/${file}: transforms are not allowed (run \`whiteboard asset import\` to bake them in)`);
  }
  const paths = [];
  for (const m of svg.matchAll(/<path\b([^>]*?)\/?>/g)) {
    const a = attrsOf(m[1]);
    if (!a.d) throw new Error(`assets/${file}: <path> without a "d" attribute`);
    const legacy = a.fill === undefined && a.stroke === undefined;
    paths.push({
      d: a.d.trim(),
      // Library convention: a path with neither fill nor stroke is a pen stroke.
      fill: legacy ? null : paintOf(a.fill),
      rule: a['fill-rule'] === 'evenodd' ? 'evenodd' : null,
      stroke: legacy ? 'ink' : paintOf(a.stroke),
      strokeWidth: a['stroke-width'] ? Number(a['stroke-width']) : null,
    });
  }
  if (!paths.length) throw new Error(`assets/${file}: contains no <path> elements`);
  return paths;
}

function loadAll() {
  if (cache) return cache;
  // the library is local (not in git): a fresh clone starts with none, `asset import` creates it
  if (!existsSync(join(ASSET_DIR, 'manifest.json'))) return (cache = new Map());
  const manifest = JSON.parse(readFileSync(join(ASSET_DIR, 'manifest.json'), 'utf8'));
  const files = readdirSync(ASSET_DIR).filter((f) => f.endsWith('.svg'));
  const assets = new Map();
  for (const f of files) {
    const name = basename(f, '.svg');
    const entry = manifest[name];
    if (!entry) throw new Error(`assets/${f}: no entry for "${name}" in assets/manifest.json`);
    const paths = parseAssetSvg(name, readFileSync(join(ASSET_DIR, f), 'utf8'));
    const order = entry.strokeOrder ?? paths.map((_, i) => i);
    const sorted = [...order].sort((a, b) => a - b);
    if (sorted.length !== paths.length || sorted.some((v, i) => v !== i)) {
      throw new Error(
        `assets/manifest.json: "${name}".strokeOrder ${JSON.stringify(order)} must be a permutation of ` +
          `0..${paths.length - 1} (the asset has ${paths.length} paths)`,
      );
    }
    const colorful = paths.some((p) => p.fill && !isNeutral(p.fill));
    assets.set(name, {
      name,
      description: entry.description ?? '',
      tags: entry.tags ?? [],
      paths,
      strokeOrder: order,
      roughness: entry.roughness ?? 1,
      outline: entry.outline ?? 'auto',
      frame: entry.frame ?? null, // fit this box instead of the drawing's extent
      colorful,
      source: entry.source ?? null,
      license: entry.license ?? null,
    });
  }
  for (const name of Object.keys(manifest)) {
    if (!assets.has(name)) throw new Error(`assets/manifest.json: "${name}" has no assets/${name}.svg`);
  }
  cache = assets;
  return assets;
}

/** Black/white/grey fills are "ink" or "paper", not color. */
export function isNeutral(hex) {
  const h = hex.replace('#', '');
  const full = h.length === 3 ? [...h].map((x) => x + x).join('') : h;
  const [r, g, b] = [0, 2, 4].map((k) => parseInt(full.slice(k, k + 2), 16));
  return Math.max(r, g, b) - Math.min(r, g, b) < 24;
}

export function reloadAssets() {
  cache = null;
}

export function listAssets() {
  return [...loadAll().values()].sort((a, b) => a.name.localeCompare(b.name));
}

/** Library search: every query word must match the name, description or tags. */
export function searchLibrary(query) {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  return listAssets().filter((a) => {
    const hay = `${a.name} ${a.description} ${a.tags.join(' ')}`.toLowerCase().replace(/_/g, ' ');
    return words.every((w) => hay.includes(w));
  });
}

export function hasAsset(name) {
  return loadAll().has(name);
}

export function suggestAssets(name, n = 5) {
  return closest(name, listAssets().map((a) => a.name), n);
}

export function getAsset(name) {
  const a = loadAll().get(name);
  if (!a) {
    throw new Error(
      `asset "${name}" not found. Available assets: ${quoteList(listAssets().map((x) => x.name))}`,
    );
  }
  return a;
}
