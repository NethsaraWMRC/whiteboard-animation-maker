// (timeline, t) -> SVG string. A pure function of t: it only reads the frozen
// timeline, never mutates anything, and never computes geometry.
import { fmt } from './util.js';

const clamp01 = (x) => (x < 0 ? 0 : x > 1 ? 1 : x);
const easeOutCubic = (p) => 1 - (1 - p) ** 3;
const ceil2 = (n) => fmt(Math.ceil(n * 100) / 100);

// Assets with fills: the outline takes the first 70% of the draw window and
// the color wipe the last 40% (they overlap slightly, like an artist who starts
// coloring while finishing the last details).
const OUTLINE_END = 0.7;
const FILL_START = 0.6;

function elementProgress(el, t) {
  const span = el.end - el.start;
  return easeOutCubic(span > 0 ? clamp01((t - el.start) / span) : 1);
}

function phases(geom, p) {
  if (!geom.hasColorFills) return { stroke: p, fill: 0 };
  return { stroke: clamp01(p / OUTLINE_END), fill: clamp01((p - FILL_START) / (1 - FILL_START)) };
}

function strokePathSVG(path, drawn) {
  const pp = path.span > 0 ? clamp01((drawn - path.offset) / path.span) : 1;
  if (pp <= 0) return '';
  const len = ceil2(path.length);
  const offset = pp >= 1 ? '0' : fmt(path.length * (1 - pp));
  return (
    `<path d="${path.d}" fill="none" stroke="${path.stroke}" stroke-width="${fmt(path.strokeWidth)}" ` +
    `stroke-linecap="round" stroke-linejoin="round" stroke-dasharray="${len}" stroke-dashoffset="${offset}"/>`
  );
}

function strokesSVG(geom, p) {
  const drawn = p * geom.totalLength;
  let out = '';
  for (const path of geom.paths) out += strokePathSVG(path, drawn);
  return out;
}

/** Fills and strokes interleaved in the artwork's layer order. */
function layeredSVG(geom, ph, clipId) {
  const drawn = ph.stroke * geom.totalLength;
  const partial = ph.fill > 0 && ph.fill < 1;
  let out = partial ? sweepClip(clipId, geom.fillBounds, ph.fill) : '';
  for (const layer of geom.layers) {
    if (layer.s !== undefined) {
      out += strokePathSVG(geom.paths[layer.s], drawn);
    } else {
      const f = geom.fills[layer.f];
      const attrs = `d="${f.d}" fill="${f.fill}"${f.rule ? ` fill-rule="${f.rule}"` : ''}`;
      if (f.ink) {
        // Ink shapes are revealed top to bottom when the drawing reaches them.
        const q = f.span > 0 ? clamp01((drawn - f.offset) / f.span) : 1;
        if (q >= 1) out += `<path ${attrs}/>`;
        else if (q > 0) {
          const id = `${clipId}-k${layer.f}`;
          out += `${dropClip(id, f.b, q)}<path ${attrs} clip-path="url(#${id})"/>`;
        }
      } else if (ph.fill > 0) {
        out += `<path ${attrs}${partial ? ` clip-path="url(#${clipId})"` : ''}/>`;
      }
    }
  }
  return out;
}

/** A clip rectangle growing top-to-bottom over `b` (p = 0..1). */
function dropClip(id, b, p) {
  const m = 4;
  return (
    `<clipPath id="${id}"><rect x="${fmt(b.x - m)}" y="${fmt(b.y - m)}" ` +
    `width="${fmt(b.w + 2 * m)}" height="${fmt((b.h + 2 * m) * p)}"/></clipPath>`
  );
}

/** A clip rectangle sweeping left-to-right across `b` (p = 0..1). */
function sweepClip(id, b, p) {
  const m = 4;
  return (
    `<clipPath id="${id}"><rect x="${fmt(b.x - m)}" y="${fmt(b.y - m)}" ` +
    `width="${fmt((b.w + 2 * m) * p)}" height="${fmt(b.h + 2 * m)}"/></clipPath>`
  );
}

function textSVG(geom, p, clipId) {
  if (p <= 0) return '';
  if (p >= 1) return `<path d="${geom.d}" fill="${geom.fill}"/>`;
  return `${sweepClip(clipId, geom.bounds, p)}<path d="${geom.d}" fill="${geom.fill}" clip-path="url(#${clipId})"/>`;
}

const easeOutBack = (x) => 1 + 2.70158 * (x - 1) ** 3 + 1.70158 * (x - 1) ** 2;
const easeInOutSine = (x) => -(Math.cos(Math.PI * x) - 1) / 2;

/** An image (and its panel) revealed by a left-to-right sweep. */
function imageSVG(g, p, clipId, style) {
  if (p <= 0) return '';
  let body = '';
  if (g.panel) {
    const r = g.panel;
    body +=
      `<rect x="${fmt(r.x)}" y="${fmt(r.y)}" width="${fmt(r.w)}" height="${fmt(r.h)}" rx="16" ` +
      `fill="#ffffff" stroke="${style.stroke}" stroke-width="${fmt(style.strokeWidth)}"/>`;
  }
  body +=
    `<image href="${g.href}" x="${fmt(g.x)}" y="${fmt(g.y)}" width="${fmt(g.w)}" height="${fmt(g.h)}" ` +
    'preserveAspectRatio="none"/>';
  if (p >= 1) return body;
  return `${sweepClip(clipId, g.bounds, p)}<g clip-path="url(#${clipId})">${body}</g>`;
}

/** Markup of one element, drawn up to progress p (1 = finished). */
function elementSVG(el, p, idPrefix, style) {
  const g = el.geometry;
  if (g.kind === 'text') return textSVG(g, p, `${idPrefix}clip-${el.id}`);
  if (g.kind === 'image') return imageSVG(g, p, `${idPrefix}img-${el.id}`, style);
  const ph = phases(g, p);
  return g.layers ? layeredSVG(g, ph, `${idPrefix}fill-${el.id}`) : strokesSVG(g, ph.stroke);
}

/**
 * Scale and opacity of an element at t. "draw" reveals by drawing (no
 * transform), "pop" grows in with a small overshoot, "fade" fades in.
 * Exits shrink away ("pop") or fade out ("fade").
 */
function appearance(el, t) {
  let scale = 1;
  let opacity = 1;
  const span = el.end - el.start;
  const raw = span > 0 ? clamp01((t - el.start) / span) : 1;
  if (el.enter === 'pop') scale = Math.max(0, easeOutBack(raw));
  else if (el.enter === 'fade') opacity = raw;
  if (t >= el.exitStart) {
    const q = clamp01((t - el.exitStart) / (el.exitEnd - el.exitStart || 1));
    if (el.exit === 'pop') scale *= 1 - easeOutCubic(q);
    else opacity *= 1 - q;
  }
  return { scale, opacity };
}

/** Just the elements visible at t (no background, no camera). */
export function renderElements(timeline, t, idPrefix = '') {
  let body = '';
  for (const el of timeline.elements) {
    if (t < el.start || t >= el.hideAt || t >= el.exitEnd) continue;
    const { scale, opacity } = appearance(el, t);
    if (scale <= 0.001 || opacity <= 0.001) continue;
    const drawn = el.enter === 'draw' ? elementProgress(el, t) : 1;
    const markup = elementSVG(el, drawn, idPrefix, timeline.style);
    if (scale === 1 && opacity === 1) {
      body += markup;
      continue;
    }
    const b = el.geometry.bounds;
    const cx = b ? b.x + b.w / 2 : 0;
    const cy = b ? b.y + b.h / 2 : 0;
    const tf =
      scale !== 1
        ? ` transform="translate(${fmt(cx)} ${fmt(cy)}) scale(${fmt(scale, 4)}) translate(${fmt(-cx)} ${fmt(-cy)})"`
        : '';
    const op = opacity !== 1 ? ` opacity="${fmt(opacity, 3)}"` : '';
    body += `<g${tf}${op}>${markup}</g>`;
  }
  return body;
}

/** The scene that owns the board at t (the latest one that has started). */
function activeScene(timeline, t) {
  let active = timeline.scenes[0];
  for (const sc of timeline.scenes) if (sc.start <= t) active = sc;
  return active;
}

/**
 * Inner SVG markup (no <svg> wrapper) for time t: the scene's background, then
 * the elements under the scene's camera. `idPrefix` keeps clip ids unique when
 * frames are combined.
 */
export function renderFrameBody(timeline, t, idPrefix = '') {
  const { canvas } = timeline;
  const sc = activeScene(timeline, t);
  const bg = `<rect x="0" y="0" width="${canvas.width}" height="${canvas.height}" fill="${sc.background}"/>`;
  const elements = renderElements(timeline, t, idPrefix);
  if (!sc.camera || sc.end <= sc.start) return bg + elements;
  // Slow push-in from 1x to camera.zoom across the scene's lifetime.
  const u = easeInOutSine(clamp01((t - sc.start) / (sc.end - sc.start)));
  const s = 1 + (sc.camera.zoom - 1) * u;
  const { cx, cy } = sc.camera;
  return (
    bg +
    `<g transform="translate(${fmt(cx)} ${fmt(cy)}) scale(${fmt(s, 4)}) translate(${fmt(-cx)} ${fmt(-cy)})">${elements}</g>`
  );
}

export function renderFrameSVG(timeline, t) {
  const { width, height } = timeline.canvas;
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">` +
    renderFrameBody(timeline, t) +
    '</svg>'
  );
}
