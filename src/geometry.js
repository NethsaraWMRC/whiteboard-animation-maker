// All geometry is computed here, once per element, at timeline-build time.
// Nothing in this module may be called per frame: rough.js output must be
// generated exactly once (with a deterministic seed) or strokes will flicker.
import rough from 'roughjs';
import { svgPathProperties } from 'svg-path-properties';
import { Resvg } from '@resvg/resvg-js';
import { readFileSync } from 'node:fs';
import { getAsset, isNeutral } from './assets.js';
import { hashSeed, fmt } from './util.js';

const generator = rough.generator();
const ARROW_GAP = 12; // px between an arrow's ends and the boxes it connects
const PADDING = 0.1; // inner padding as a fraction of one grid cell
const DEFAULT_FONT = 'Segoe Print, Comic Sans MS, Ink Free, Patrick Hand, Comic Neue, cursive, sans-serif';

/** Pixel rectangle for a grid placement, inset by 10% of a cell on every side. */
export function cellRect(canvas, at, size) {
  const cw = canvas.width / canvas.grid[0];
  const ch = canvas.height / canvas.grid[1];
  const px = cw * PADDING;
  const py = ch * PADDING;
  return {
    x: at[0] * cw + px,
    y: at[1] * ch + py,
    w: size[0] * cw - 2 * px,
    h: size[1] * ch - 2 * py,
  };
}

// ---------------------------------------------------------------------------
// Path parsing: convert any path to absolute coordinates, apply a uniform
// scale + translation (baked into the numbers so measured lengths are in
// pixel space), and split into subpaths so each one becomes its own stroke.

const ARG_COUNT = { M: 2, L: 2, H: 1, V: 1, C: 6, S: 4, Q: 4, T: 2, A: 7, Z: 0 };

function parsePath(d) {
  const tokens = d.match(/[MmLlHhVvCcSsQqTtAaZz]|[-+]?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?/g) ?? [];
  const segs = [];
  let i = 0;
  let cmd = null;
  while (i < tokens.length) {
    if (/^[A-Za-z]$/.test(tokens[i])) cmd = tokens[i++];
    else if (!cmd) throw new Error(`path data must start with a command: "${d.slice(0, 40)}"`);
    const n = ARG_COUNT[cmd.toUpperCase()];
    if (n === 0) {
      segs.push({ cmd, args: [] });
      continue;
    }
    const args = tokens.slice(i, i + n).map(Number);
    if (args.length < n || args.some(Number.isNaN)) {
      throw new Error(`malformed path data near "${cmd}" in "${d.slice(0, 60)}"`);
    }
    segs.push({ cmd, args });
    i += n;
    // Implicit repeats after a moveto are linetos.
    if (cmd === 'M') cmd = 'L';
    else if (cmd === 'm') cmd = 'l';
  }
  return segs;
}

/**
 * -> array of absolute, transformed subpath strings. With `flip`, x is
 * mirrored within the 0..100 asset box (x -> 100 - x) before scaling.
 */
export function transformPath(d, scale, ox, oy, flip = false) {
  const X = (x) => fmt(ox + (flip ? 100 - x : x) * scale);
  const Y = (y) => fmt(oy + y * scale);
  const subpaths = [];
  let cur = null;
  let cx = 0;
  let cy = 0;
  let sx = 0;
  let sy = 0;
  const begin = (x, y) => {
    if (cur && cur.length > 1) subpaths.push(cur.join(' '));
    cur = [`M${X(x)} ${Y(y)}`];
    sx = x;
    sy = y;
  };
  for (const { cmd, args } of parsePath(d)) {
    const C = cmd.toUpperCase();
    const rel = cmd !== C;
    const ax = (v) => (rel ? cx + v : v);
    const ay = (v) => (rel ? cy + v : v);
    if (C !== 'M' && !cur) begin(cx, cy);
    switch (C) {
      case 'M':
        cx = ax(args[0]);
        cy = ay(args[1]);
        begin(cx, cy);
        break;
      case 'L':
      case 'T':
        cx = ax(args[0]);
        cy = ay(args[1]);
        cur.push(`${C}${X(cx)} ${Y(cy)}`);
        break;
      case 'H':
        cx = ax(args[0]);
        cur.push(`L${X(cx)} ${Y(cy)}`);
        break;
      case 'V':
        cy = rel ? cy + args[0] : args[0];
        cur.push(`L${X(cx)} ${Y(cy)}`);
        break;
      case 'C':
      case 'S':
      case 'Q': {
        const pts = [];
        for (let k = 0; k < args.length; k += 2) pts.push(`${X(ax(args[k]))} ${Y(ay(args[k + 1]))}`);
        cx = ax(args[args.length - 2]);
        cy = ay(args[args.length - 1]);
        cur.push(`${C}${pts.join(' ')}`);
        break;
      }
      case 'A': {
        const [rx, ry, rot, large, sweep, x, y] = args;
        cx = ax(x);
        cy = ay(y);
        cur.push(`A${fmt(rx * scale)} ${fmt(ry * scale)} ${flip ? -rot : rot} ${large} ${flip ? 1 - sweep : sweep} ${X(cx)} ${Y(cy)}`);
        break;
      }
      case 'Z':
        cur.push('Z');
        cx = sx;
        cy = sy;
        if (cur.length > 1) subpaths.push(cur.join(' '));
        cur = null;
        break;
    }
  }
  if (cur && cur.length > 1) subpaths.push(cur.join(' '));
  return subpaths;
}

export function measure(d) {
  return new svgPathProperties(d).getTotalLength();
}

/** Exact bounding box of a set of path strings, by sampling along their length. */
function sampledBounds(ds) {
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  for (const d of ds) {
    const props = new svgPathProperties(d);
    const len = props.getTotalLength();
    const n = Math.max(8, Math.ceil(len / 4));
    for (let k = 0; k <= n; k++) {
      const p = props.getPointAtLength((len * k) / n);
      x0 = Math.min(x0, p.x);
      y0 = Math.min(y0, p.y);
      x1 = Math.max(x1, p.x);
      y1 = Math.max(y1, p.y);
    }
  }
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}


// ---------------------------------------------------------------------------
// Rough strokes. rough.js normally draws every segment twice and emits each
// segment of each pass as its own subpath ("M ... C ..."), interleaved. To get
// a hand-like reveal we generate the two passes separately (single-stroke mode,
// different seeds). Within a pass, segments are revealed one after another;
// the two passes are revealed side by side over the same span; separate input
// strokes are revealed sequentially.
//
// Each emitted path carries `offset` and `span` in "drawn length" units: it is
// fully hidden while drawn <= offset and fully shown once drawn >= offset + span.

const SECOND_PASS_SEED = 7919;

function passSegments(drawable) {
  return generator
    .toPaths(drawable)
    .flatMap((p) => p.d.split(/(?=M)/).map((s) => s.trim()).filter(Boolean))
    .map((d) => ({ d, length: measure(d) }))
    .filter((p) => p.length > 0);
}

/**
 * specs: one per input stroke, { build: (roughOptions) => drawable, stroke,
 * strokeWidth, roughness }, or { ink: fillIndex, effort } for a filled ink
 * shape that is revealed in sequence like a stroke (its own span = effort).
 * Seeds derive from `baseSeed` (the element id hash).
 * -> { paths, inks: [{ f, offset, span }], totalLength }
 */
function roughStrokes(specs, baseSeed) {
  const paths = [];
  const inks = [];
  let offset = 0;
  specs.forEach((spec, k) => {
    if (spec.ink !== undefined) {
      inks.push({ f: spec.ink, offset, span: spec.effort });
      offset += spec.effort;
      return;
    }
    const seed = baseSeed + k;
    const passes = [seed, seed + SECOND_PASS_SEED]
      .map((s) => passSegments(spec.build(roughOptions(spec, s))))
      .filter((segs) => segs.length);
    if (!passes.length) return;
    const totals = passes.map((segs) => segs.reduce((a, s) => a + s.length, 0));
    const span = Math.max(...totals);
    passes.forEach((segs, i) => {
      const k2 = span / totals[i]; // stretch each pass over the stroke's span
      let cum = 0;
      for (const s of segs) {
        paths.push({
          d: s.d,
          length: s.length,
          stroke: spec.stroke,
          strokeWidth: spec.strokeWidth,
          offset: offset + cum * k2,
          span: s.length * k2,
          ...(spec.z !== undefined ? { z: spec.z } : {}),
        });
        cum += s.length;
      }
    });
    offset += span;
  });
  return { paths, inks, totalLength: offset };
}

function roughOptions(spec, seed) {
  return {
    roughness: spec.roughness,
    strokeWidth: spec.strokeWidth,
    stroke: spec.stroke,
    seed: (seed % 2147483646) + 1,
    disableMultiStroke: true,
  };
}

const memo = new Map();
function memoize(key, fn) {
  if (!memo.has(key)) memo.set(key, fn());
  return memo.get(key);
}

function unionBounds(boxes) {
  const valid = boxes.filter((b) => b && Number.isFinite(b.x));
  if (!valid.length) return null;
  const x0 = Math.min(...valid.map((b) => b.x));
  const y0 = Math.min(...valid.map((b) => b.y));
  const x1 = Math.max(...valid.map((b) => b.x + b.w));
  const y1 = Math.max(...valid.map((b) => b.y + b.h));
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}

function luminanceOf(hex) {
  const h = hex.replace('#', '');
  const f = h.length === 3 ? [...h].map((x) => x + x).join('') : h;
  const [r, g, b] = [0, 2, 4].map((k) => parseInt(f.slice(k, k + 2), 16));
  return (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
}
const isDark = (c) => isNeutral(c) && luminanceOf(c) < 0.5;

/** A long thin filled shape (e.g. a trend line drawn as a polygon) reads as a line. */
function isLineLike(d, scale) {
  const { thickness, perimeter } = fillShape(d);
  return thickness < 6 * scale && perimeter / 2 > 20 * thickness;
}

/** Average thickness (2 * area / perimeter) and perimeter of a filled shape, in pixels. */
function fillShape(d) {
  let area = 0;
  let perimeter = 0;
  for (const sub of d.split(/(?=M)/)) {
    const props = new svgPathProperties(sub);
    const len = props.getTotalLength();
    if (!len) continue;
    const n = Math.max(8, Math.ceil(len / 3));
    let a = 0;
    let prev = props.getPointAtLength(0);
    for (let k = 1; k <= n; k++) {
      const q = props.getPointAtLength((len * k) / n);
      a += prev.x * q.y - q.x * prev.y;
      prev = q;
    }
    area += Math.abs(a) / 2;
    perimeter += len;
  }
  return { thickness: perimeter ? (2 * area) / perimeter : 0, perimeter };
}

/** Near-black fills are ink: drawn with the outlines, not colored in afterwards. */
const isInk = (c) => isNeutral(c) && luminanceOf(c) < 0.2;

/** Bounds of an asset's drawing in its 0..100 space (cached per asset). */
function contentBounds(asset) {
  if (asset.frame) {
    const [x, y, w, h] = asset.frame;
    return { x, y, w, h };
  }
  return memoize(JSON.stringify(['content', asset.name, asset.paths.length]), () => {
    const b = sampledBounds(asset.paths.flatMap((p) => transformPath(p.d, 1, 0, 0)));
    const pad = Math.max(0, ...asset.paths.map((p) => (p.stroke && p.strokeWidth) || 0)) / 2;
    return {
      x: b.x - pad,
      y: b.y - pad,
      w: Math.max(1, b.w + 2 * pad),
      h: Math.max(1, b.h + 2 * pad),
    };
  });
}

/**
 * Geometry for an "asset" element. The 100x100 asset is scaled uniformly to fit
 * the padded cell rectangle and centered in it (mirrored when `flip`).
 *
 * Stroked paths become rough pen strokes (dark strokes use the style's ink
 * color; colored strokes keep their color unless `colors: false`). Filled
 * paths are colored in after the outline is drawn; with `colors: false`,
 * colored fills become paper (background) so the asset reads as line art.
 * Assets that have fills but no strokes get outlines traced from their larger
 * fill shapes so there is something to draw.
 * -> { kind: 'strokes', paths, totalLength, bounds, fills, fillBounds }
 */
export function assetGeometry(el, canvas, style) {
  const key = JSON.stringify(['asset', el.id, el.asset, el.at, el.size, el.flip, el.colors, el.roughness, canvas, style]);
  return memoize(key, () => {
    const asset = getAsset(el.asset);
    const rect = cellRect(canvas, el.at, el.size);
    // Fit the drawing's own bounds (not the 100x100 box) into the rectangle, so
    // wide art fills wide boxes and tall art fills tall boxes.
    const flip = !!el.flip;
    const cb = contentBounds(asset);
    const scale = Math.min(rect.w / cb.w, rect.h / cb.h);
    const left = flip ? 100 - cb.x - cb.w : cb.x;
    const ox = rect.x + (rect.w - cb.w * scale) / 2 - left * scale;
    const oy = rect.y + (rect.h - cb.h * scale) / 2 - cb.y * scale;
    const colors = el.colors !== false;
    const roughness = style.roughness * asset.roughness * (el.roughness ?? 1);
    const maxWidth = Math.max(0, ...asset.paths.map((p) => (p.stroke && p.strokeWidth) || 0));
    const tx = (d) => transformPath(d, scale, ox, oy, flip);

    const inkFor = (c) => (c === 'ink' || isDark(c) || (!colors && !isNeutral(c)) ? style.stroke : c);
    const widthFor = (w) =>
      w && maxWidth ? style.strokeWidth * Math.min(1, Math.max(0.5, w / maxWidth)) : style.strokeWidth;

    // Fills. Ink (near-black) fills, and in line art long thin colored shapes,
    // are drawn in sequence with the strokes; other fills are colored in at the
    // end. Line art turns the remaining colored fills into paper.
    const fills = [];
    const fillAt = new Map(); // asset path index -> fills index
    asset.paths.forEach((p, i) => {
      if (!p.fill) return;
      const d = tx(p.d).join(' ');
      if (!d) return;
      const lineLike = !colors && !isNeutral(p.fill) && isLineLike(d, scale);
      const ink = isInk(p.fill) || lineLike;
      const fill =
        lineLike || isInk(p.fill) ? style.stroke : colors || isNeutral(p.fill) ? p.fill : style.background;
      fillAt.set(i, fills.length);
      fills.push({ d, fill, rule: p.rule, z: i, ink, ...(ink ? { b: sampledBounds([d]) } : {}) });
    });

    const specs = [];
    const strokeDs = [];
    const addStroke = (d, stroke, strokeWidth, z) => {
      strokeDs.push(d);
      specs.push({ build: (opts) => generator.path(d, opts), stroke, strokeWidth, roughness, z });
    };
    const hasStrokes = asset.paths.some((p) => p.stroke);
    for (const i of asset.strokeOrder) {
      const p = asset.paths[i];
      if (p.stroke) {
        for (const d of tx(p.d)) addStroke(d, inkFor(p.stroke), widthFor(p.strokeWidth), i);
      }
      if (fillAt.has(i) && fills[fillAt.get(i)].ink) {
        const f = fills[fillAt.get(i)];
        specs.push({ ink: fillAt.get(i), effort: Math.max(10, fillShape(f.d).perimeter / 2) });
      } else if (!hasStrokes && p.fill && asset.outline !== 'none') {
        // Trace outlines of the larger fill shapes only; small shading blobs stay unoutlined.
        const minArea = (100 * scale) ** 2 * 0.02;
        for (const d of tx(p.d)) {
          const b = sampledBounds([d]);
          if (b.w * b.h >= minArea) addStroke(d, style.stroke, style.strokeWidth, i);
        }
      }
    }


    const strokeBounds = strokeDs.length ? sampledBounds(strokeDs) : null;
    const colorFills = fills.filter((f) => !f.ink);
    const fillBounds = colorFills.length ? sampledBounds(colorFills.map((f) => f.d)) : null;
    const strokes = roughStrokes(specs, hashSeed(el.id));
    for (const ink of strokes.inks) Object.assign(fills[ink.f], { offset: ink.offset, span: ink.span });
    // Paint in the artwork's layer order: each fill, then the outlines of that
    // same shape, so later fills hide the lines of shapes behind them.
    const layers = [
      ...fills.map((f, idx) => ({ z: f.z, k: 0, f: idx })),
      ...strokes.paths.map((p, idx) => ({ z: p.z, k: 1, s: idx })),
    ]
      .sort((a, b) => a.z - b.z || a.k - b.k)
      .map(({ f, s }) => (f !== undefined ? { f } : { s }));
    return {
      kind: 'strokes',
      paths: strokes.paths,
      totalLength: strokes.totalLength,
      layers,
      fills,
      hasColorFills: colorFills.length > 0,
      fillBounds,
      bounds: unionBounds([strokeBounds, fills.length ? sampledBounds(fills.map((f) => f.d)) : null]),
    };
  });
}

/** Point where the ray from the box center towards (tx, ty) leaves the box. */
function exitPoint(box, tx, ty) {
  const cx = box.x + box.w / 2;
  const cy = box.y + box.h / 2;
  const dx = tx - cx;
  const dy = ty - cy;
  const sx = dx === 0 ? Infinity : box.w / 2 / Math.abs(dx);
  const sy = dy === 0 ? Infinity : box.h / 2 / Math.abs(dy);
  const s = Math.min(sx, sy);
  return { x: cx + dx * s, y: cy + dy * s };
}

/**
 * Geometry for an "arrow" between two element bounding boxes: a shaft between
 * the facing edges (12px gap at each end) plus two head strokes at 30 degrees.
 * -> { kind: 'strokes', paths, totalLength, shaftLength }
 */
export function arrowGeometry(el, fromBox, toBox, style) {
  const key = JSON.stringify(['arrow', el.id, el.color, fromBox, toBox, style]);
  return memoize(key, () => {
    const fc = { x: fromBox.x + fromBox.w / 2, y: fromBox.y + fromBox.h / 2 };
    const tc = { x: toBox.x + toBox.w / 2, y: toBox.y + toBox.h / 2 };
    const a = exitPoint(fromBox, tc.x, tc.y);
    const b = exitPoint(toBox, fc.x, fc.y);
    let ux = b.x - a.x;
    let uy = b.y - a.y;
    const raw = Math.hypot(ux, uy) || 1;
    ux /= raw;
    uy /= raw;
    const gap = Math.min(ARROW_GAP, raw / 4);
    const p1 = { x: a.x + ux * gap, y: a.y + uy * gap };
    const p2 = { x: b.x - ux * gap, y: b.y - uy * gap };
    const shaftLength = Math.hypot(p2.x - p1.x, p2.y - p1.y);
    const head = Math.min(26, Math.max(8, shaftLength * 0.3));
    const wing = (angle) => {
      const c = Math.cos(angle);
      const s = Math.sin(angle);
      // Rotate the backwards direction (-u) by +/- 30 degrees.
      return { x: p2.x + head * (-ux * c - -uy * s), y: p2.y + head * (-ux * s + -uy * c) };
    };
    const w1 = wing(Math.PI / 6);
    const w2 = wing(-Math.PI / 6);
    const line = (x1, y1, x2, y2) => ({
      build: (opts) => generator.line(x1, y1, x2, y2, opts),
      stroke: el.color ?? style.stroke,
      strokeWidth: style.strokeWidth,
      roughness: style.roughness,
    });
    const specs = [line(p1.x, p1.y, p2.x, p2.y), line(p2.x, p2.y, w1.x, w1.y), line(p2.x, p2.y, w2.x, w2.y)];
    const { paths, totalLength } = roughStrokes(specs, hashSeed(el.id));
    const xs = [p1.x, p2.x, w1.x, w2.x];
    const ys = [p1.y, p2.y, w1.y, w2.y];
    const bounds = {
      x: Math.min(...xs),
      y: Math.min(...ys),
      w: Math.max(...xs) - Math.min(...xs),
      h: Math.max(...ys) - Math.min(...ys),
    };
    return { kind: 'strokes', paths, totalLength, fills: [], shaftLength, bounds };
  });
}

// ---------------------------------------------------------------------------
// Text: glyphs are converted to filled outlines once (resvg's usvg pass turns
// <text> into paths), then revealed per frame by a sweeping clip rectangle.
// Loading system fonts costs seconds, so all text elements share one pass, and
// frames are later rasterized with fonts disabled.

const escapeXml = (s) =>
  s.replace(/[<>&"']/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&apos;' })[c]);

function pointBounds(d) {
  const nums = (d.match(/[-+]?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?/g) ?? []).map(Number);
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  for (let k = 0; k + 1 < nums.length; k += 2) {
    x0 = Math.min(x0, nums[k]);
    x1 = Math.max(x1, nums[k]);
    y0 = Math.min(y0, nums[k + 1]);
    y1 = Math.max(y1, nums[k + 1]);
  }
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}

/**
 * Geometry for all "text" elements at once. Per element: `font` (family list),
 * `weight` ("normal" | "bold"), `align` ("left" | "center" | "right"), `color`.
 * -> Map(id -> { kind: 'text', d, fill, bounds, totalLength })
 */
export function textGeometries(textEls, canvas, style) {
  const result = new Map();
  if (!textEls.length) return result;
  const key = JSON.stringify([
    'text',
    textEls.map((e) => [e.id, e.text, e.at, e.size, e.font, e.weight, e.align, e.color]),
    canvas,
    style,
  ]);
  return memoize(key, () => {
    const baseFamily = style.fontFamily ?? DEFAULT_FONT;
    const NOMINAL = 100; // outline at 100px, then scale to fit the cell box
    const body = textEls
      .map(
        (el) =>
          `<g id="t-${escapeXml(el.id)}"><text x="0" y="${NOMINAL}" font-size="${NOMINAL}" ` +
          `font-family="${escapeXml(el.font ?? baseFamily)}" font-weight="${el.weight === 'bold' ? 700 : 400}">` +
          `${escapeXml(el.text)}</text></g>`,
      )
      .join('');
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10">${body}</svg>`;
    const usvg = new Resvg(svg, {
      font: { loadSystemFonts: true, defaultFontFamily: baseFamily.split(',')[0].trim() },
    }).toString();
    const unescape = (s) =>
      s.replace(/&quot;|&apos;|&lt;|&gt;|&amp;/g, (e) => ({ '&quot;': '"', '&apos;': "'", '&lt;': '<', '&gt;': '>', '&amp;': '&' })[e]);
    const groups = new Map();
    for (const m of usvg.matchAll(/<g id="t-([^"]+)">([\s\S]*?)(?=<g id="t-|<\/svg>)/g)) {
      const ds = [...m[2].matchAll(/\sd="([^"]+)"/g)].map((x) => x[1]);
      groups.set(unescape(m[1]), ds.join(' '));
    }
    for (const el of textEls) {
      const glyphs = groups.get(el.id);
      if (!glyphs) {
        throw new Error(`text element "${el.id}": no font could render "${el.text}" (font-family: ${el.font ?? baseFamily})`);
      }
      const nb = pointBounds(glyphs);
      const rect = cellRect(canvas, el.at, el.size);
      // Font size at most ~65% of the box height; shrink further to fit the width.
      const scale = Math.min((rect.h * 0.65) / NOMINAL, (rect.w * 0.96) / nb.w);
      const align = el.align ?? 'center';
      const ox =
        align === 'left'
          ? rect.x - nb.x * scale
          : align === 'right'
            ? rect.x + rect.w - (nb.x + nb.w) * scale
            : rect.x + (rect.w - nb.w * scale) / 2 - nb.x * scale;
      // Center the em box (ascent ~0.75em above the baseline, descent ~0.25em
      // below), not the glyph bounds, so labels in a row share a baseline.
      const oy = rect.y + rect.h / 2 - 0.75 * NOMINAL * scale;
      const d = transformPath(glyphs, scale, ox, oy).join(' ');
      const bounds = pointBounds(d);
      result.set(el.id, { kind: 'text', d, fill: el.color ?? style.stroke, bounds, totalLength: bounds.w });
    }
    return result;
  });
}


// ---------------------------------------------------------------------------
// Images (PNG/JPEG): embedded as a data URI, fitted into the cell rectangle
// keeping their aspect ratio, optionally on a white rounded panel.

function imageSize(buf) {
  if (buf.length > 24 && buf.readUInt32BE(0) === 0x89504e47) {
    return { w: buf.readUInt32BE(16), h: buf.readUInt32BE(20), mime: 'image/png' };
  }
  if (buf[0] === 0xff && buf[1] === 0xd8) {
    let i = 2;
    while (i < buf.length) {
      if (buf[i] !== 0xff) break;
      const marker = buf[i + 1];
      const len = buf.readUInt16BE(i + 2);
      if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
        return { w: buf.readUInt16BE(i + 7), h: buf.readUInt16BE(i + 5), mime: 'image/jpeg' };
      }
      i += 2 + len;
    }
  }
  throw new Error('unsupported image (use PNG or JPEG)');
}

const PANEL_PAD = 18; // px between a panel's edge and its image

/** -> { kind: 'image', href, x, y, w, h, panel: {x, y, w, h} | null, bounds } */
export function imageGeometry(el, canvas, file) {
  const key = JSON.stringify(['image', el.id, file, el.at, el.size, el.panel, canvas]);
  return memoize(key, () => {
    const buf = readFileSync(file);
    const { w: iw, h: ih, mime } = imageSize(buf);
    const rect = cellRect(canvas, el.at, el.size);
    const pad = el.panel ? PANEL_PAD : 0;
    const scale = Math.min((rect.w - 2 * pad) / iw, (rect.h - 2 * pad) / ih);
    const w = iw * scale;
    const h = ih * scale;
    const x = rect.x + (rect.w - w) / 2;
    const y = rect.y + (rect.h - h) / 2;
    const panel = el.panel ? { x: x - pad, y: y - pad, w: w + 2 * pad, h: h + 2 * pad } : null;
    return {
      kind: 'image',
      href: `data:${mime};base64,${buf.toString('base64')}`,
      x,
      y,
      w,
      h,
      panel,
      bounds: panel ?? { x, y, w, h },
    };
  });
}

/** Drop memoized geometry (used by the determinism check to force recomputation). */
export function clearGeometryCache() {
  memo.clear();
}
