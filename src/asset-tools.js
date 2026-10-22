// Asset acquisition: normalize arbitrary SVG into the library format, search and
// download open-licensed icons from the Iconify API, and write library entries.
//
// Library format (assets/<name>.svg): viewBox="0 0 100 100", only <path>
// elements with absolute coordinates, no transforms/groups. Each path has
//   fill="#rrggbb" | fill="none", optional fill-rule, and optional
//   stroke="#rrggbb" stroke-width="n".
// Legacy hand-made assets may omit both fill and stroke: that means "pen stroke".
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { Resvg } from '@resvg/resvg-js';
import { svgPathProperties } from 'svg-path-properties';
import { ASSET_DIR, reloadAssets } from './assets.js';
import { fmt } from './util.js';

// ---------------------------------------------------------------------------
// Affine helpers. Matrices are [a, b, c, d, e, f] as in SVG matrix().

const IDENTITY = [1, 0, 0, 1, 0, 0];
const mul = (m, n) => [
  m[0] * n[0] + m[2] * n[1],
  m[1] * n[0] + m[3] * n[1],
  m[0] * n[2] + m[2] * n[3],
  m[1] * n[2] + m[3] * n[3],
  m[0] * n[4] + m[2] * n[5] + m[4],
  m[1] * n[4] + m[3] * n[5] + m[5],
];

export function parseTransform(s) {
  let m = IDENTITY;
  for (const [, fn, args] of s.matchAll(/(matrix|translate|scale|rotate|skewX|skewY)\s*\(([^)]*)\)/g)) {
    const a = args.split(/[\s,]+/).filter(Boolean).map(Number);
    const rad = (deg) => (deg * Math.PI) / 180;
    let n;
    if (fn === 'matrix') n = a;
    else if (fn === 'translate') n = [1, 0, 0, 1, a[0], a[1] ?? 0];
    else if (fn === 'scale') n = [a[0], 0, 0, a[1] ?? a[0], 0, 0];
    else if (fn === 'skewX') n = [1, 0, Math.tan(rad(a[0])), 1, 0, 0];
    else if (fn === 'skewY') n = [1, Math.tan(rad(a[0])), 0, 1, 0, 0];
    else {
      const c = Math.cos(rad(a[0]));
      const s2 = Math.sin(rad(a[0]));
      n = [c, s2, -s2, c, 0, 0];
      if (a.length === 3) n = mul(mul([1, 0, 0, 1, a[1], a[2]], n), [1, 0, 0, 1, -a[1], -a[2]]);
    }
    m = mul(m, n);
  }
  return m;
}

/** Apply an affine matrix to usvg path data (absolute M/L/C/Q/Z only). */
function affinePath(d, m, digits = 2) {
  const tokens = d.match(/[MLCQZmlcqzHhVvSsTtAa]|[-+]?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?/g) ?? [];
  const out = [];
  let i = 0;
  while (i < tokens.length) {
    const cmd = tokens[i++];
    if (!'MLCQZ'.includes(cmd)) throw new Error(`unexpected path command "${cmd}" in normalized SVG`);
    if (cmd === 'Z') {
      out.push('Z');
      continue;
    }
    const n = { M: 2, L: 2, C: 6, Q: 4 }[cmd];
    const pts = [];
    for (let k = 0; k < n; k += 2) {
      const x = Number(tokens[i + k]);
      const y = Number(tokens[i + k + 1]);
      pts.push(`${fmt(m[0] * x + m[2] * y + m[4], digits)} ${fmt(m[1] * x + m[3] * y + m[5], digits)}`);
    }
    i += n;
    out.push(cmd + pts.join(' '));
    // usvg never relies on implicit repeated commands, but guard anyway.
    while (i < tokens.length && !/^[A-Za-z]$/.test(tokens[i])) {
      const x = Number(tokens[i]);
      const y = Number(tokens[i + 1]);
      out.push(`L${fmt(m[0] * x + m[2] * y + m[4], digits)} ${fmt(m[1] * x + m[3] * y + m[5], digits)}`);
      i += 2;
    }
  }
  return out.join(' ');
}

// ---------------------------------------------------------------------------
// Colors

export function parseHex(c) {
  let h = c.replace('#', '');
  if (h.length === 3) h = [...h].map((x) => x + x).join('');
  return [0, 2, 4].map((k) => parseInt(h.slice(k, k + 2), 16));
}
export const toHex = (rgb) => '#' + rgb.map((v) => Math.round(Math.max(0, Math.min(255, v))).toString(16).padStart(2, '0')).join('');
export function luminance(c) {
  const [r, g, b] = parseHex(c);
  return (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
}
const blendWhite = (c, a) => toHex(parseHex(c).map((v) => v * a + 255 * (1 - a)));

// ---------------------------------------------------------------------------
// Normalization

const attrsOf = (s) => Object.fromEntries([...s.matchAll(/([\w:-]+)="([^"]*)"/g)].map((m) => [m[1], m[2]]));
const SKIP_CONTAINERS = new Set(['defs', 'clipPath', 'mask', 'pattern', 'filter', 'marker', 'symbol']);

function samplePoints(d) {
  const pts = [];
  for (const sub of d.split(/(?=M)/)) {
    const props = new svgPathProperties(sub);
    const len = props.getTotalLength();
    const n = Math.max(4, Math.ceil(len / 2));
    for (let k = 0; k <= n; k++) pts.push(props.getPointAtLength((len * k) / n));
  }
  return pts;
}

/**
 * Normalize any SVG into the library format.
 * With `frame`, the SVG's viewBox (not the drawing's extent) is what gets fitted, and its
 * normalized rectangle is returned as `frame`: assets drawn on the same canvas then line up
 * when placed in the same cells (layered builds: a molecule, then its labels on top).
 * -> { svg, paths, frame?, stats: { strokes, fills, colors: string[] } }
 */
export function normalizeSvg(input, { ink = '#1a1a1a', frame = false } = {}) {
  if (/<image\b/.test(input)) throw new Error('raster <image> elements are not supported; use a vector-only SVG');
  const source = input.replace(/currentColor/g, ink);
  let usvg;
  try {
    usvg = new Resvg(source, { font: { loadSystemFonts: /<text\b/.test(source) } }).toString();
  } catch (e) {
    throw new Error(`could not parse SVG: ${e.message}`);
  }

  // Gradients -> average stop color (whiteboard art uses flat colors).
  const gradients = new Map();
  for (const m of usvg.matchAll(/<(linearGradient|radialGradient)\b([^>]*)>([\s\S]*?)<\/\1>/g)) {
    const { id } = attrsOf(m[2]);
    const stops = [...m[3].matchAll(/<stop\b([^>]*)\/?>/g)].map((s) => attrsOf(s[1]));
    const cols = stops.map((s) => blendWhite(s['stop-color'] ?? '#000000', Number(s['stop-opacity'] ?? 1))).map(parseHex);
    if (id && cols.length) gradients.set(id, toHex([0, 1, 2].map((k) => cols.reduce((a, c) => a + c[k], 0) / cols.length)));
  }
  const paint = (v) => {
    if (!v || v === 'none') return null;
    const url = v.match(/^url\(#([^)]+)\)/);
    if (url) return gradients.get(url[1]) ?? '#888888';
    if (/^#[0-9a-fA-F]{3}([0-9a-fA-F]{3})?$/.test(v)) return v.toLowerCase().length === 4 ? toHex(parseHex(v)) : v.toLowerCase();
    return null;
  };

  const raw = [];
  const stack = [{ m: IDENTITY, opacity: 1, skip: false }];
  for (const tm of usvg.matchAll(/<(\/?)([A-Za-z][\w:-]*)([^>]*?)(\/?)>/g)) {
    const [, close, name, attrText, selfClose] = tm;
    if (close) {
      if (stack.length > 1) stack.pop();
      continue;
    }
    const a = attrsOf(attrText);
    const top = stack[stack.length - 1];
    const m = a.transform ? mul(top.m, parseTransform(a.transform)) : top.m;
    const opacity = top.opacity * Number(a.opacity ?? 1);
    const skip = top.skip || SKIP_CONTAINERS.has(name);
    if (name === 'path' && !skip && a.d) {
      const fillA = opacity * Number(a['fill-opacity'] ?? 1);
      const strokeA = opacity * Number(a['stroke-opacity'] ?? 1);
      let fill = paint(a.fill ?? '#000000');
      let stroke = paint(a.stroke);
      if (fill && fillA < 0.15) fill = null;
      if (stroke && strokeA < 0.15) stroke = null;
      if (fill && fillA < 1) fill = blendWhite(fill, fillA);
      if (stroke && strokeA < 1) stroke = blendWhite(stroke, strokeA);
      if (fill || stroke) {
        const scale = Math.sqrt(Math.abs(m[0] * m[3] - m[1] * m[2]));
        raw.push({
          d: affinePath(a.d, m, 4),
          fill,
          rule: a['fill-rule'] === 'evenodd' ? 'evenodd' : null,
          stroke,
          width: stroke ? Number(a['stroke-width'] ?? 1) * scale : 0,
        });
      }
    }
    if (!selfClose && name !== 'path') stack.push({ m, opacity, skip });
    else if (!selfClose && name === 'path') stack.push({ m, opacity, skip });
  }
  if (!raw.length) throw new Error('the SVG contains no visible paths');

  // Fit everything into 0..100 with a small margin, centered.
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  for (const p of raw) {
    for (const pt of samplePoints(p.d)) {
      x0 = Math.min(x0, pt.x - p.width / 2);
      y0 = Math.min(y0, pt.y - p.width / 2);
      x1 = Math.max(x1, pt.x + p.width / 2);
      y1 = Math.max(y1, pt.y + p.width / 2);
    }
  }
  if (frame) {
    const vb = input.match(/viewBox="([^"]+)"/)?.[1]?.trim().split(/[\s,]+/).map(Number);
    if (!vb || vb.length !== 4 || vb.some((v) => !Number.isFinite(v))) throw new Error('--frame needs an SVG with a viewBox');
    [x0, y0, x1, y1] = [vb[0], vb[1], vb[0] + vb[2], vb[1] + vb[3]];
  }
  const s = 96 / Math.max(x1 - x0, y1 - y0);
  const fit = [s, 0, 0, s, 50 - ((x0 + x1) / 2) * s, 50 - ((y0 + y1) / 2) * s];

  const paths = raw.map((p) => ({
    d: affinePath(p.d, fit),
    fill: p.fill,
    rule: p.rule,
    stroke: p.stroke,
    width: p.stroke ? +(p.width * s).toFixed(2) : 0,
  }));
  const lines = paths.map((p) => {
    let attrs = `d="${p.d}" fill="${p.fill ?? 'none'}"`;
    if (p.fill && p.rule) attrs += ` fill-rule="${p.rule}"`;
    if (p.stroke) attrs += ` stroke="${p.stroke}" stroke-width="${p.width}"`;
    return `  <path ${attrs}/>`;
  });
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">\n${lines.join('\n')}\n</svg>\n`;
  const colors = [...new Set(paths.flatMap((p) => [p.fill, p.stroke]).filter(Boolean))];
  const box = frame
    ? [50 - ((x1 - x0) * s) / 2, 50 - ((y1 - y0) * s) / 2, (x1 - x0) * s, (y1 - y0) * s].map((v) => +v.toFixed(2))
    : null;
  return {
    svg,
    paths,
    ...(box ? { frame: box } : {}),
    stats: { strokes: paths.filter((p) => p.stroke).length, fills: paths.filter((p) => p.fill).length, colors },
  };
}

/**
 * Draw order for a new asset: "document" keeps the SVG's own order (use it for
 * art you drew yourself), "top" sorts top to bottom then left to right (how
 * people sketch; the default for downloaded icons), "left" sorts left to right.
 */
export function strokeOrderFor(paths, order = 'top') {
  if (order === 'document') return paths.map((_, i) => i);
  if (order === 'left') {
    return paths
      .map((p, i) => {
        const pts = samplePoints(p.d);
        return { i, left: Math.min(...pts.map((q) => q.x)), top: Math.min(...pts.map((q) => q.y)) };
      })
      .sort((a, b) => a.left - b.left || a.top - b.top)
      .map((x) => x.i);
  }
  if (order !== 'top') throw new Error(`--order must be document, top or left, got "${order}"`);
  return defaultStrokeOrder(paths);
}

/** Default draw order: top to bottom, then left to right (how people sketch). */
export function defaultStrokeOrder(paths) {
  return paths
    .map((p, i) => {
      const pts = samplePoints(p.d);
      const top = Math.min(...pts.map((q) => q.y));
      const left = Math.min(...pts.map((q) => q.x));
      return { i, top, left };
    })
    .sort((a, b) => a.top - b.top || a.left - b.left)
    .map((x) => x.i);
}

// ---------------------------------------------------------------------------
// Library writes

const MANIFEST = join(ASSET_DIR, 'manifest.json');

export function validateAssetName(name) {
  if (!/^[a-z][a-z0-9_]*$/.test(name)) {
    throw new Error(`asset name "${name}" must be lowercase snake_case (letters, digits, "_"), e.g. "office_worker"`);
  }
}

/** Add (or with force, replace) a normalized asset in the library. */
export function writeAsset(name, normalized, meta, { force = false } = {}) {
  validateAssetName(name);
  mkdirSync(ASSET_DIR, { recursive: true });
  const manifest = existsSync(MANIFEST) ? JSON.parse(readFileSync(MANIFEST, 'utf8')) : {};
  const file = join(ASSET_DIR, `${name}.svg`);
  if (!force && (manifest[name] || existsSync(file))) {
    throw new Error(`asset "${name}" already exists; pick another name or pass --force to replace it`);
  }
  writeFileSync(file, normalized.svg);
  manifest[name] = {
    description: meta.description,
    ...(meta.tags?.length ? { tags: meta.tags } : {}),
    strokeOrder: strokeOrderFor(normalized.paths, meta.order),
    ...(meta.roughness !== undefined ? { roughness: meta.roughness } : {}),
    ...(normalized.frame ? { frame: normalized.frame } : {}),
    ...(meta.source ? { source: meta.source } : {}),
    ...(meta.license ? { license: meta.license } : {}),
  };
  writeFileSync(MANIFEST, JSON.stringify(manifest, null, 2) + '\n');
  reloadAssets();
  return manifest[name];
}

// ---------------------------------------------------------------------------
// Iconify (https://iconify.design): thousands of open-licensed icon sets.

const API = 'https://api.iconify.design';

/** Curated sets that suit whiteboard art, best first. */
export const ICON_SETS = {
  color: ['openmoji', 'streamline-ultimate-color', 'streamline-color', 'fluent-emoji-flat', 'twemoji', 'noto', 'flat-color-icons', 'fxemoji'],
  line: ['tabler', 'lucide', 'ph', 'streamline', 'mdi-light'],
};
ICON_SETS.any = [...ICON_SETS.color.slice(0, 3), ...ICON_SETS.line.slice(0, 2), ...ICON_SETS.color.slice(3)];

async function getJson(url) {
  let res;
  try {
    res = await fetch(url);
  } catch (e) {
    throw new Error(`cannot reach ${API} (${e.cause?.code ?? e.message}); check the internet connection`);
  }
  if (!res.ok) throw new Error(`${url} -> HTTP ${res.status}`);
  return res.json();
}

export async function searchIcons(query, { style = 'any', sets, limit = 24 } = {}) {
  const prefixes = sets ?? ICON_SETS[style];
  if (!prefixes) throw new Error(`--style must be one of ${Object.keys(ICON_SETS).join(', ')}`);
  const url = `${API}/search?query=${encodeURIComponent(query)}&limit=${Math.max(32, limit)}&prefixes=${prefixes.join(',')}`;
  const res = await getJson(url);
  const order = new Map(prefixes.map((p, i) => [p, i]));
  // Interleave sets so the best-suited sets appear first but every set is represented.
  const icons = res.icons
    .map((id, rank) => ({ id, rank, set: id.split(':')[0] }))
    .sort((a, b) => a.rank + (order.get(a.set) ?? 9) * 2 - (b.rank + (order.get(b.set) ?? 9) * 2))
    .slice(0, limit);
  return icons.map(({ id, set }) => ({ id, set, collection: res.collections?.[set] }));
}

export async function fetchIconSvg(id) {
  const [set, name] = id.split(':');
  if (!set || !name) throw new Error(`icon id must look like "set:name" (e.g. "openmoji:house"), got "${id}"`);
  const res = await fetch(`${API}/${set}/${name}.svg`).catch((e) => {
    throw new Error(`cannot reach ${API}: ${e.message}`);
  });
  const text = await res.text();
  if (!res.ok || !text.includes('<svg') || text.trim() === '404') {
    throw new Error(`icon "${id}" not found on Iconify; search for it with \`whiteboard asset search\``);
  }
  return text;
}

export async function iconLicense(set) {
  const res = await getJson(`${API}/collections?prefixes=${set}`);
  const c = res[set];
  if (!c) return null;
  return { title: c.license?.title, spdx: c.license?.spdx, url: c.license?.url, author: c.author?.name, collection: c.name };
}

/** Numbered preview sheet of raw SVGs (as downloaded), for visual picking. */
export function rawSheetPng(items) {
  const cols = Math.min(6, items.length);
  const cell = 240;
  const rows = Math.ceil(items.length / cols);
  let body = '';
  items.forEach(({ svg, label }, i) => {
    const x = (i % cols) * cell;
    const y = Math.floor(i / cols) * (cell + 40);
    const vb = svg.match(/viewBox="([^"]+)"/)?.[1] ?? '0 0 24 24';
    const inner = svg.replace(/^[\s\S]*?<svg[^>]*>/, '').replace(/<\/svg>\s*$/, '');
    body +=
      `<rect x="${x + 6}" y="${y + 6}" width="${cell - 12}" height="${cell + 28}" fill="#ffffff" stroke="#dddddd"/>` +
      `<svg x="${x + 30}" y="${y + 24}" width="${cell - 60}" height="${cell - 60}" viewBox="${vb}" color="#1a1a1a">${inner}</svg>` +
      `<text x="${x + cell / 2}" y="${y + cell - 4}" font-size="15" font-family="Arial" text-anchor="middle" fill="#1a1a1a">` +
      `${label.replace(/[<&]/g, (c) => (c === '<' ? '&lt;' : '&amp;'))}</text>`;
  });
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${cols * cell}" height="${rows * (cell + 40)}"><rect width="100%" height="100%" fill="#f4f4f4"/>${body}</svg>`;
  return new Resvg(svg, { font: { loadSystemFonts: true, defaultFontFamily: 'Arial' } }).render().asPng();
}

// ---------------------------------------------------------------------------
// Preview library assets exactly as the renderer draws them.

/**
 * One row per asset: mid-draw, finished in color, finished as line art.
 * -> PNG buffer
 */
export async function previewAssetsPng(names, style) {
  const { assetGeometry } = await import('./geometry.js');
  const { renderElements } = await import('./frame.js');
  const cellW = 380;
  const cellH = 420; // the art is square (fits the width); the extra height holds the caption
  const cols = [
    { title: 'drawing…', t: 0.2, colors: true },
    { title: 'color', t: 1, colors: true },
    { title: 'line art ("colors": false)', t: 1, colors: false },
  ];
  const canvas = { width: cellW * cols.length, height: cellH * names.length, grid: [cols.length, names.length] };
  let body = '';
  names.forEach((name, r) => {
    cols.forEach((c, k) => {
      const el = { id: `pv-${name}-${k}`, asset: name, at: [k, r], size: [1, 1], colors: c.colors };
      const timeline = {
        canvas,
        style,
        elements: [
          {
            id: el.id,
            start: 0,
            end: 1,
            hideAt: Infinity,
            exitStart: Infinity,
            exitEnd: Infinity,
            enter: 'draw',
            geometry: assetGeometry(el, canvas, style),
          },
        ],
      };
      body += renderElements(timeline, c.t, `r${r}c${k}-`);
      body +=
        `<text x="${k * cellW + cellW / 2}" y="${(r + 1) * cellH - 8}" font-family="Arial" font-size="17" ` +
        `text-anchor="middle" fill="#555555">${name} · ${c.title}</text>`;
    });
  });
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" width="${canvas.width}" height="${canvas.height}">` +
    `<rect width="100%" height="100%" fill="${style.background}"/>` +
    cols.map((_, k) => `<line x1="${k * cellW}" y1="0" x2="${k * cellW}" y2="${canvas.height}" stroke="#e4e4e4"/>`).join('') +
    names.map((_, r) => `<line x1="0" y1="${r * cellH}" x2="${canvas.width}" y2="${r * cellH}" stroke="#e4e4e4"/>`).join('') +
    `${body}</svg>`;
  return new Resvg(svg, { font: { loadSystemFonts: true, defaultFontFamily: 'Arial' } }).render().asPng();
}
