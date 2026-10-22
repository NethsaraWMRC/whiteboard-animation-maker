// Shared art kit for the exam-question explainer videos: one palette and a few
// builders, so every video looks like part of the same series.
//
// Use from a per-question script (e.g. my/q3/art/make-art.cjs), at any folder depth inside the
// project (package.json "exports" maps the name to this file):
//   const K = require('whiteboard-poc/art-kit');
//   K.writeArt(__dirname, { my_asset: [K.svg('0 0 100 100', ...), 'description', 'tags'] });
// then import with the loop in K.importCommand().

const fs = require('fs');
const path = require('path');

// ---------------------------------------------------------------------------
// Palette (the series look: teal ink on a cream board, few accents)

const C = {
  INK: '#134a52', // outlines, labels; matches style.stroke in scene.json
  TEAL: '#1f6f78', // main color: character shirt, badges
  TEAL_L: '#4f9da6', // secondary: labels, light bars
  PALE: '#cfe7e8', // light fills: electron clouds, liquids
  SKIN: '#fdf8ee',
  PAPER: '#fffaf0', // cards, empty orbitals
  ORANGE: '#f2994a', // accent 1: the thing to look at
  RED: '#e05d5d', // wrong, broken, "no"
  GREEN: '#4caf7a', // right, "yes"
  BLUE: '#3b7dd8', // delta minus
  YELLOW: '#f2c94c',
  GREY: '#b8bec0',
  WHITE: '#ffffff',
  RED_TINT: '#fbe1e1', // highlight ring: a problem
  ORANGE_TINT: '#fde4cc', // highlight ring: the one we count
};

// Scene style that goes with the palette (copy into scene.json "style").
const STYLE = { stroke: C.INK, strokeWidth: 3.5, background: '#f6efd8', roughness: 0.4, fontFamily: 'Arial' };
const ALT_BACKGROUND = '#eef1e4'; // every other scene, for rhythm

// ---------------------------------------------------------------------------
// Basics

/** Centered bold Arial text. `s` may contain <tspan> markup (e.g. sub()). */
const T = (x, y, size, color, s, weight = 'bold') =>
  `<text x="${x}" y="${y}" font-family="Arial" font-weight="${weight}" font-size="${size}" text-anchor="middle" fill="${color}">${s}</text>`;

/** Subscript inside a T() string: sub('l') -> m_l. Arial lacks most Unicode subscripts. */
const sub = (s, scale = 0.65) => `<tspan baseline-shift="sub" font-size="${Math.round(scale * 100)}%">${s}</tspan>`;

const svg = (vb, body) => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${vb}">\n${body}\n</svg>`;

// ---------------------------------------------------------------------------
// Builders used across videos

/** Option card: number badge + main label (formula or value). */
const card = (n, label, { labelSize = 46 } = {}) =>
  svg(
    '0 0 170 120',
    `<rect x="4" y="4" width="162" height="112" rx="18" fill="${C.PAPER}" stroke="${C.INK}" stroke-width="5"/>
  <circle cx="34" cy="34" r="20" fill="${C.TEAL}"/>
  ${T(34, 43, 26, C.WHITE, n)}
  ${T(98, 86, labelSize, C.INK, label)}`,
  );

/** Rounded pill with a short label (1 word or a symbol expression) and optional mark. */
const pill = (label, color, mark = null, { width = 260, size = 34 } = {}) =>
  svg(
    `0 0 ${width} 84`,
    `<rect x="4" y="4" width="${width - 8}" height="76" rx="38" fill="${C.WHITE}" stroke="${color}" stroke-width="5"/>
  ${T(mark ? width / 2 - 18 : width / 2, 55, size, color, label)}
  ${mark ? T(width - 46, 57, 38, color, mark) : ''}`,
  );

/** Filled electron arrow centered at (x, cy). */
function arrow(x, cy, up, color = C.TEAL) {
  const h = 42;
  const y0 = cy - h / 2;
  const y1 = cy + h / 2;
  return up
    ? `<path d="M${x - 3} ${y1} L${x - 3} ${y0 + 12} L${x - 10} ${y0 + 14} L${x} ${y0} L${x + 10} ${y0 + 14} L${x + 3} ${y0 + 12} L${x + 3} ${y1} Z" fill="${color}"/>`
    : `<path d="M${x - 3} ${y0} L${x - 3} ${y1 - 12} L${x - 10} ${y1 - 14} L${x} ${y1} L${x + 10} ${y1 - 14} L${x + 3} ${y1 - 12} L${x + 3} ${y0} Z" fill="${color}"/>`;
}

/** One orbital circle (r = 30) holding '', 'u', 'd' or 'ud'. */
function orbital(cx, cy, fill = '', ring = C.PAPER, r = 30) {
  let s = `<circle cx="${cx}" cy="${cy}" r="${r}" fill="${ring}" stroke="${C.INK}" stroke-width="4"/>`;
  if (fill === 'u') s += arrow(cx, cy, true);
  if (fill === 'd') s += arrow(cx, cy, false);
  if (fill === 'ud') s += arrow(cx - 9, cy, true) + arrow(cx + 9, cy, false);
  return s;
}

// ---------------------------------------------------------------------------
// Equations: fractions, brackets, cancel strokes, laid out left to right.
//
// A token is one of:
//   'KE = ½ m'                      text run (may hold sub() markup; use ² ³ for powers)
//   { t: 'm', color, cancel: true } text run with its own color, optionally struck out
//   { f: [numTokens, denTokens] }   fraction (token arrays, or plain strings)
//   { p: tokens, sup: '2' }         tokens in tall brackets, with an optional power
//   { gap: 0.3 }                    extra space, in em

// Arial Bold advance widths (per 1000 em) for the characters equations use.
const ADV = {
  ' ': 278, '=': 584, '+': 584, '−': 584, '-': 333, '×': 584, ':': 333, '·': 278, '(': 333, ')': 333,
  '/': 278, '.': 278, ',': 278, '½': 834, '²': 333, '³': 333, 'λ': 556, '∝': 714, '→': 1000, '↑': 500, '↓': 500, '?': 611,
  i: 278, l: 278, j: 278, f: 333, t: 333, r: 389, m: 889, w: 778, M: 833, W: 944, I: 278, J: 556,
};
const advance = (ch) =>
  ADV[ch] ?? (/[0-9]/.test(ch) ? 556 : /[a-z]/.test(ch) ? 611 : /[A-Z]/.test(ch) ? 722 : 600);

/** Width of a text run in px at font size `size`; sub()/tspan parts count at their scale. */
function textWidth(s, size) {
  let w = 0;
  for (const m of s.matchAll(/<tspan[^>]*font-size="(\d+)%"[^>]*>([^<]*)<\/tspan>|<[^>]+>|([^<]+)/g)) {
    const [, pct, inner, plain] = m;
    const run = inner ?? plain ?? '';
    const k = inner != null ? Number(pct) / 100 : 1;
    for (const ch of run.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')) w += (advance(ch) / 1000) * size * k;
  }
  return w;
}

const textAt = (x, y, size, color, s) =>
  `<text x="${x.toFixed(1)}" y="${y.toFixed(1)}" font-family="Arial" font-weight="bold" font-size="${size.toFixed(1)}" fill="${color}">${s}</text>`;

/**
 * Lay out tokens; returns { w, up, down, draw(x, baseline) -> svg }.
 * `up`/`down` are the extents above/below the baseline.
 */
function layout(tokens, size, color = C.INK) {
  if (typeof tokens === 'string') tokens = [tokens];
  // Arial lacks ∝ (the fallback font is thin and not bold), so it is drawn as a path
  tokens = tokens.flatMap((tok) => {
    const str = typeof tok === 'string' ? tok : tok.t;
    if (str == null || !str.includes('∝')) return [tok];
    return str.split('∝').flatMap((part, i) => [
      ...(i ? [{ prop: true, color: tok.color }] : []),
      ...(part.trim() ? [typeof tok === 'string' ? part.trim() : { ...tok, t: part.trim() }] : []),
    ]);
  });
  const axis = size * 0.3; // fraction bar height above the baseline
  const boxes = tokens.map((tok) => {
    if (typeof tok === 'string') tok = { t: tok };
    if (tok.gap != null) return { w: tok.gap * size, up: 0, down: 0, draw: () => '' };
    if (tok.prop) {
      const P = (x, y, u, v) => `${(x + u * size).toFixed(1)} ${(y - axis + v * size).toFixed(1)}`;
      return {
        w: size * 0.78,
        up: size * 0.5,
        down: 0,
        draw: (x, y) =>
          `<path d="M${P(x, y, 0.74, -0.2)} C${P(x, y, 0.5, -0.2)} ${P(x, y, 0.36, 0.2)} ${P(x, y, 0.2, 0.2)} ` +
          `C${P(x, y, 0.02, 0.2)} ${P(x, y, 0.02, -0.2)} ${P(x, y, 0.2, -0.2)} ` +
          `C${P(x, y, 0.36, -0.2)} ${P(x, y, 0.5, 0.2)} ${P(x, y, 0.74, 0.2)}" fill="none" stroke="${tok.color ?? color}" stroke-width="${(size * 0.085).toFixed(1)}" stroke-linecap="round"/>`,
      };
    }
    if (tok.t != null) {
      const w = textWidth(tok.t, size);
      const c = tok.color ?? color;
      return {
        w,
        up: size * 0.74,
        down: size * 0.22,
        draw: (x, y) =>
          textAt(x, y, size, c, tok.t) +
          (tok.cancel
            ? `<path d="M${(x - size * 0.05).toFixed(1)} ${(y + size * 0.12).toFixed(1)} L${(x + w + size * 0.05).toFixed(1)} ${(y - size * 0.78).toFixed(1)}" fill="none" stroke="${C.RED}" stroke-width="${(size * 0.07).toFixed(1)}" stroke-linecap="round"/>`
            : ''),
      };
    }
    if (tok.f) {
      const ps = size * 0.85;
      const num = layout(tok.f[0], ps, tok.color ?? color);
      const den = layout(tok.f[1], ps, tok.color ?? color);
      const pad = size * 0.14;
      const w = Math.max(num.w, den.w) + 2 * pad;
      const nb = -axis - size * 0.2 - num.down; // numerator baseline (relative)
      const db = -axis + size * 0.2 + den.up; // denominator baseline (relative)
      return {
        w,
        up: -nb + num.up,
        down: db + den.down,
        draw: (x, y) =>
          num.draw(x + (w - num.w) / 2, y + nb) +
          `<path d="M${(x + size * 0.04).toFixed(1)} ${(y - axis).toFixed(1)} L${(x + w - size * 0.04).toFixed(1)} ${(y - axis).toFixed(1)}" fill="none" stroke="${tok.color ?? color}" stroke-width="${(size * 0.07).toFixed(1)}" stroke-linecap="round"/>` +
          den.draw(x + (w - den.w) / 2, y + db),
      };
    }
    if (tok.p) {
      const inner = layout(tok.p, size, color);
      const bw = size * 0.32; // bracket width
      const top = inner.up + size * 0.08;
      const bot = inner.down + size * 0.08;
      const sw = inner.w + 2 * bw + size * 0.08;
      const supW = tok.sup ? textWidth(tok.sup, size * 0.62) + size * 0.06 : 0;
      const bracket = (x, y, dir) => {
        const x0 = dir < 0 ? x + bw * 0.85 : x + bw * 0.15;
        const x1 = dir < 0 ? x + bw * 0.2 : x + bw * 0.8;
        return `<path d="M${x0.toFixed(1)} ${(y - top).toFixed(1)} Q${x1.toFixed(1)} ${(y - (top - bot) / 2).toFixed(1)} ${x0.toFixed(1)} ${(y + bot).toFixed(1)}" fill="none" stroke="${color}" stroke-width="${(size * 0.07).toFixed(1)}" stroke-linecap="round"/>`;
      };
      return {
        w: sw + supW,
        up: top,
        down: bot,
        draw: (x, y) =>
          bracket(x, y, -1) +
          inner.draw(x + bw + size * 0.04, y) +
          bracket(x + sw - bw, y, 1) +
          (tok.sup ? textAt(x + sw + size * 0.02, y - top + size * 0.5, size * 0.62, tok.supColor ?? color, tok.sup) : ''),
      };
    }
    throw new Error(`unknown equation token ${JSON.stringify(tok)}`);
  });
  const gap = size * 0.22;
  const w = boxes.reduce((a, b) => a + b.w, 0) + gap * Math.max(0, boxes.length - 1);
  return {
    w,
    up: Math.max(size * 0.74, ...boxes.map((b) => b.up)),
    down: Math.max(size * 0.22, ...boxes.map((b) => b.down)),
    draw: (x, y) => {
      let s = '';
      for (const b of boxes) {
        s += b.draw(x, y);
        x += b.w + gap;
      }
      return s;
    },
  };
}

/**
 * Equation on a card of a fixed size, left aligned, with an optional step number.
 * Cards of the same w/h drawn at the same cell height show equations at the same scale,
 * so a derivation reads as one aligned column of steps.
 */
function eqCard(tokens, { w = 760, h = 170, size = 56, step = null, accent = null, align = 'left' } = {}) {
  const e = layout(tokens, size);
  const left = step != null ? 112 : 36;
  const x = align === 'center' ? (w - e.w) / 2 : left;
  const y = h / 2 + (e.up - e.down) / 2;
  if (x + e.w > w - 20 || e.up + e.down > h - 16) {
    throw new Error(`equation does not fit its ${w}x${h} card (needs ${Math.round(x + e.w + 20)}x${Math.round(e.up + e.down + 16)})`);
  }
  return svg(
    `0 0 ${w} ${h}`,
    `<rect x="4" y="4" width="${w - 8}" height="${h - 8}" rx="22" fill="${accent ? C.ORANGE_TINT : C.PAPER}" stroke="${accent ?? C.TEAL_L}" stroke-width="${accent ? 6 : 4}"/>
  ${step != null ? `<circle cx="58" cy="${h / 2}" r="30" fill="${C.TEAL}"/>\n  ${T(58, h / 2 + 12, 34, C.WHITE, String(step))}` : ''}
  ${e.draw(x, y)}`,
  );
}

// ---------------------------------------------------------------------------
// Output

/**
 * Write <name>.svg files and art.json (for the import loop) into `dir`.
 * art: { name: [svgString, description, tags, { frame }?] }
 * frame: true imports the drawing with its whole viewBox as its box, so layered pieces drawn
 * on the same canvas line up when placed in the same cells.
 */
function writeArt(dir, art) {
  const meta = [];
  for (const [name, [content, description, tags, opts = {}]] of Object.entries(art)) {
    fs.writeFileSync(path.join(dir, `${name}.svg`), content + '\n');
    meta.push({ name, description, tags, ...(opts.frame ? { frame: true } : {}) });
  }
  fs.writeFileSync(path.join(dir, 'art.json'), JSON.stringify(meta, null, 2) + '\n');
  console.log(`wrote ${meta.length} drawings to ${dir}`);
  return meta;
}

/** Card width that fits the widest of several equations (so a group of step cards matches). */
const eqCardWidth = (list, { size = 56, step = null } = {}) =>
  Math.ceil(Math.max(...list.map((t) => layout(t, size).w)) + (step != null ? 112 : 36) + 44);

module.exports = { C, STYLE, ALT_BACKGROUND, T, sub, svg, card, pill, arrow, orbital, layout, eqCard, eqCardWidth, writeArt };
