// scene.json schema + semantic validation with humanized, actionable errors.
// These messages are how the authoring agent learns the format, so every error
// says where it is (JSON path), what is wrong, and what to do instead.
import { z } from 'zod';
import { getAsset, hasAsset, suggestAssets } from './assets.js';
import { findAnchor, suggestAnchors } from './align.js';
import { computeSchedule } from './timeline.js';
import { cellRect } from './geometry.js';
import { closest, quoteList, resolveAudioPath } from './util.js';

const int = (min) => z.number().int().min(min);
const cell = z.tuple([int(0), int(0)]);
const size = z.tuple([int(1), int(1)]);
const id = z
  .string()
  .regex(/^[A-Za-z][A-Za-z0-9_-]*$/, 'must start with a letter and contain only letters, digits, "-" and "_"');

const exitSchema = z.strictObject({
  anchor: z.string().min(1), // leaves when this phrase is spoken
  occurrence: int(1).optional(),
  lead: z.number().min(0).optional(), // start leaving this many seconds before the anchor
  duration: z.number().positive().max(3).optional(), // default 0.4 s
  style: z.enum(['pop', 'fade']).optional(), // default: "pop" for popped elements, else "fade"
});

const timingFields = {
  anchor: z.string().min(1),
  occurrence: int(1).optional(),
  lead: z.number().min(0).default(0.4),
  duration: z.number().positive().default(0.7),
  enter: z.enum(['draw', 'pop', 'fade']).optional(), // default "draw" (text is written on)
  exit: exitSchema.optional(),
};

const color = z
  .string()
  .regex(/^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/, 'must be a hex color like "#e63946"');

const assetEl = z.strictObject({
  id,
  type: z.literal('asset'),
  asset: z.string().min(1),
  at: cell,
  size,
  colors: z.boolean().optional(), // false = line art (color fills become paper)
  flip: z.boolean().optional(), // mirror horizontally (e.g. make a person face right)
  roughness: z.number().min(0).max(5).optional(), // multiplier on style.roughness
  ...timingFields,
});
const textEl = z.strictObject({
  id,
  type: z.literal('text'),
  text: z.string().min(1),
  at: cell,
  size,
  color: color.optional(),
  font: z.string().min(1).optional(),
  weight: z.enum(['normal', 'bold']).optional(),
  align: z.enum(['left', 'center', 'right']).optional(),
  ...timingFields,
});
const arrowEl = z.strictObject({
  id,
  type: z.literal('arrow'),
  from: z.string().min(1),
  to: z.string().min(1),
  color: color.optional(),
  ...timingFields,
});
const imageEl = z.strictObject({
  id,
  type: z.literal('image'),
  src: z.string().regex(/\.(png|jpe?g)$/i, 'must be a .png or .jpg file'),
  at: cell,
  size,
  panel: z.boolean().optional(), // white rounded card behind the image
  ...timingFields,
});
const element = z.discriminatedUnion('type', [assetEl, textEl, arrowEl, imageEl]);

const canvas = z.strictObject({
  width: int(16).default(1920),
  height: int(16).default(1080),
  grid: z.tuple([int(1), int(1)]).default([12, 8]),
});
const style = z.strictObject({
  stroke: color.default('#1a1a1a'),
  strokeWidth: z.number().positive().default(3),
  background: color.default('#fdfdf8'),
  roughness: z.number().min(0).max(10).default(1.2),
  fontFamily: z.string().optional(),
});
const sceneSchema = z.strictObject({
  id,
  clearBefore: z.boolean().default(false),
  background: color.optional(), // board color while this scene is on screen
  camera: z
    .strictObject({
      zoom: z.number().min(1).max(2), // slow push-in from 1x to this over the scene
      focus: cell.optional(), // grid cell to push in toward (default: canvas center)
    })
    .optional(),
  elements: z.array(element).min(1),
});
export const sceneFileSchema = z.strictObject({
  canvas: canvas.prefault({}),
  style: style.prefault({}),
  audio: z.string().min(1).optional(),
  scenes: z.array(sceneSchema).min(1),
});

export const timingSchema = z.object({
  duration: z.number().positive(),
  words: z
    .array(z.object({ word: z.string(), start: z.number().min(0), end: z.number().min(0) }))
    .min(1),
});

const FIELDS = {
  root: Object.keys(sceneFileSchema.shape),
  canvas: Object.keys(canvas.shape),
  style: Object.keys(style.shape),
  scene: Object.keys(sceneSchema.shape),
  asset: Object.keys(assetEl.shape),
  text: Object.keys(textEl.shape),
  arrow: Object.keys(arrowEl.shape),
  image: Object.keys(imageEl.shape),
};

// ---------------------------------------------------------------------------
// Formatting helpers

export function formatPath(path) {
  return path.reduce((s, p) => (typeof p === 'number' ? `${s}[${p}]` : s ? `${s}.${p}` : p), '') || '(root)';
}

function describe(v) {
  if (v === undefined) return 'nothing';
  if (v === null) return 'null';
  if (Array.isArray(v)) return `an array (${JSON.stringify(v).slice(0, 40)})`;
  if (typeof v === 'string') return `the string ${JSON.stringify(v)}`;
  if (typeof v === 'object') return 'an object';
  return `${typeof v} ${JSON.stringify(v)}`;
}

function fieldsFor(path, root) {
  if (path.length === 0) return FIELDS.root;
  if (path.length === 1 && FIELDS[path[0]]) return FIELDS[path[0]];
  if (path.length === 2 && path[0] === 'scenes') return FIELDS.scene;
  if (path.length === 4 && path[2] === 'elements') {
    const t = root?.scenes?.[path[1]]?.elements?.[path[3]]?.type;
    return FIELDS[t] ?? [];
  }
  return [];
}

function humanizeIssue(issue, root) {
  const where = formatPath(issue.path);
  const last = issue.path[issue.path.length - 1];
  switch (issue.code) {
    case 'invalid_type':
      if (issue.input === undefined) {
        return `${where}: required field "${last}" is missing`;
      }
      if (issue.expected === 'int') return `${where}: must be a whole number (grid cells are integers), got ${describe(issue.input)}`;
      return `${where}: expected ${issue.expected}, got ${describe(issue.input)}`;
    case 'unrecognized_keys': {
      const allowed = fieldsFor(issue.path, root);
      return issue.keys
        .map((k) => {
          const [best] = closest(k, allowed, 1);
          const hint = best ? ` Did you mean "${best}"?` : '';
          const type = issue.input?.type ? ` for a "${issue.input.type}" element` : '';
          return `${where}: unknown field "${k}"${type}.${hint} Allowed fields: ${quoteList(allowed)}`;
        })
        .join('\n');
    }
    case 'invalid_union':
      if (issue.note === 'No matching discriminator') {
        const got = issue.input?.type;
        return got === undefined
          ? `${where}: element is missing "type"; expected one of ${quoteList(issue.options)}`
          : `${where}: unknown element type ${JSON.stringify(got)}; expected one of ${quoteList(issue.options)}`;
      }
      return `${where}: ${issue.message}`;
    case 'invalid_value':
      return `${where}: expected ${issue.values.map((v) => JSON.stringify(v)).join(' or ')}, got ${describe(issue.input)}`;
    case 'too_small':
      if (issue.origin === 'array') {
        if (last === 'at') return `${where}: must be [col, row] (2 integers), got ${describe(issue.input)}`;
        if (last === 'size' || last === 'grid') return `${where}: must be [cols, rows] (2 integers), got ${describe(issue.input)}`;
        return `${where}: must have at least ${issue.minimum} item(s)`;
      }
      if (issue.origin === 'string') return `${where}: must not be empty`;
      return `${where}: must be ${issue.inclusive ? '>=' : '>'} ${issue.minimum}, got ${describe(issue.input)}`;
    case 'too_big':
      if (issue.origin === 'array') return `${where}: must have at most ${issue.maximum} item(s), got ${describe(issue.input)}`;
      return `${where}: must be ${issue.inclusive ? '<=' : '<'} ${issue.maximum}, got ${describe(issue.input)}`;
    case 'invalid_format':
      return `${where}: ${issue.message}, got ${describe(issue.input)}`;
    default:
      return `${where}: ${issue.message}`;
  }
}

const cellList = (c0, r0, c1, r1) => {
  const cells = [];
  for (let r = r0; r <= r1; r++) for (let c = c0; c <= c1; c++) cells.push(`[${c}, ${r}]`);
  return cells.length > 8 ? `${cells.slice(0, 8).join(', ')} … (${cells.length} cells)` : cells.join(', ');
};

const span = (what, a, n) => (n === 1 ? `${what} ${a}` : `${what}s ${a}–${a + n - 1}`);

const MIN_SCENE_HOLD = 2.0; // seconds a finished scene should stay up before a clearBefore wipe
const CROP_TOLERANCE = 12; // px an element may be pushed past the frame edge by the camera
const MAX_TEXT_WORDS = 3; // more words than this in one text element triggers a warning

const fmtSec = (s) => (Number.isFinite(s) ? `${s.toFixed(2)}s` : "the end");

// ---------------------------------------------------------------------------

/**
 * Validate a parsed scene.json object against the schema, the asset library
 * and the transcript timing.
 * -> { ok, errors: string[], warnings: string[], scene (with defaults applied) }
 */
export function validateScene(raw, rawTiming, { scenePath } = {}) {
  const errors = [];
  const warnings = [];

  const t = timingSchema.safeParse(rawTiming, { reportInput: true });
  if (!t.success) {
    errors.push(...t.error.issues.map((i) => `timing.json: ${humanizeIssue(i, rawTiming)} (regenerate it with \`whiteboard align\`)`));
  }
  const parsed = sceneFileSchema.safeParse(raw, { reportInput: true });
  if (!parsed.success) {
    errors.push(...parsed.error.issues.flatMap((i) => humanizeIssue(i, raw).split('\n')));
  }
  if (errors.length) {
    errors.push('(fix these first: asset, anchor, arrow, bounds and overlap checks run once the structure is valid)');
    return { ok: false, errors, warnings };
  }

  const scene = parsed.data;
  const timing = t.data;
  const [cols, rows] = scene.canvas.grid;
  const P = (si, ei, field) => formatPath(['scenes', si, 'elements', ei, ...(field ? [field] : [])]);
  let anchorErrors = !t.success;
  const checkAnchor = (anchor, occurrence, where, occWhere) => {
    const hits = findAnchor(timing, anchor);
    if (hits.length === 0) {
      const near = suggestAnchors(timing, anchor, 3);
      errors.push(
        `${where}: phrase "${anchor}" not found in the transcript. ` +
          `Closest phrases: ${quoteList(near)}. Anchors must be copied verbatim (case and punctuation are ignored).`,
      );
    } else if (hits.length > 1 && occurrence === undefined) {
      errors.push(
        `${where}: phrase "${anchor}" appears ${hits.length} times in the transcript. ` +
          `Add "occurrence": 1–${hits.length} next to it to choose one, or use a longer phrase that is unique.`,
      );
    } else if ((occurrence ?? 1) > hits.length) {
      errors.push(
        `${occWhere}: "occurrence": ${occurrence} but phrase "${anchor}" appears only ` +
          `${hits.length} time(s) in the transcript. Use a value from 1 to ${hits.length}.`,
      );
    }
  };

  // Unique ids (elements across all scenes; scene ids among scenes).
  const seenScenes = new Map();
  scene.scenes.forEach((sc, si) => {
    if (seenScenes.has(sc.id)) {
      errors.push(`scenes[${si}].id: duplicate scene id "${sc.id}" (already used by scenes[${seenScenes.get(sc.id)}])`);
    } else seenScenes.set(sc.id, si);
  });
  const seen = new Map(); // id -> { si, ei }
  scene.scenes.forEach((sc, si) =>
    sc.elements.forEach((el, ei) => {
      const prev = seen.get(el.id);
      if (prev) {
        errors.push(
          `${P(si, ei, 'id')}: duplicate element id "${el.id}" (scene ${si}); already used by ${P(prev.si, prev.ei)} ` +
            `(scene ${prev.si}). Element ids must be unique across all scenes; rename one of them.`,
        );
      } else seen.set(el.id, { si, ei });
    }),
  );

  scene.scenes.forEach((sc, si) => {
    sc.elements.forEach((el, ei) => {
      // Assets.
      if (el.type === 'asset' && !hasAsset(el.asset)) {
        const s = suggestAssets(el.asset, 5);
        errors.push(
          `${P(si, ei)}: asset "${el.asset}" not found. Did you mean "${s[0]}"? ` +
            `Closest matches: ${quoteList(s)}. Run \`whiteboard list-assets\` for the full list.`,
        );
      }

      // Arrow endpoints: must be non-arrow elements of the same scene.
      if (el.type === 'arrow') {
        const targets = sc.elements.filter((e) => e.type !== 'arrow' && e.id !== el.id).map((e) => e.id);
        for (const end of ['from', 'to']) {
          const ref = el[end];
          if (targets.includes(ref)) continue;
          const inScene = sc.elements.find((e) => e.id === ref);
          let why;
          if (ref === el.id) why = 'an arrow cannot point at itself';
          else if (inScene) why = `"${ref}" is an arrow; arrows can only connect asset or text elements`;
          else if (seen.has(ref)) why = `"${ref}" is in scenes[${seen.get(ref).si}], but arrows can only connect elements of the same scene`;
          else why = `no element with id "${ref}" exists in scenes[${si}]`;
          errors.push(
            `${P(si, ei, end)}: arrow ${end} "${ref}" is invalid: ${why}. ` +
              `Valid ids in scenes[${si}]: ${targets.length ? quoteList(targets) : '(none: add asset or text elements first)'}`,
          );
        }
        if (el.from === el.to && targets.includes(el.from)) {
          errors.push(`${P(si, ei)}: arrow "from" and "to" are both "${el.from}"; an arrow must connect two different elements`);
        }
      }

      // Grid bounds.
      if (el.type !== 'arrow') {
        const [c, r] = el.at;
        const [w, h] = el.size;
        if (c + w > cols || r + h > rows) {
          const fixes = [];
          if (c + w > cols) fixes.push(`column must be <= ${Math.max(0, cols - w)} for width ${w}`);
          if (r + h > rows) fixes.push(`row must be <= ${Math.max(0, rows - h)} for height ${h}`);
          errors.push(
            `${P(si, ei)}: "${el.id}" at [${c}, ${r}] with size [${w}, ${h}] covers ${span('column', c, w)} and ${span('row', r, h)}, ` +
              `which extends past the ${cols}×${rows} grid (columns 0–${cols - 1}, rows 0–${rows - 1}). Fix: ${fixes.join('; ')}, or shrink it.`,
          );
        }
      }

      // Anchors (entry, and exit if any).
      if (t.success) {
        const before = errors.length;
        checkAnchor(el.anchor, el.occurrence, P(si, ei, 'anchor'), P(si, ei, 'occurrence'));
        if (el.exit) checkAnchor(el.exit.anchor, el.exit.occurrence, `${P(si, ei, 'exit')}.anchor`, `${P(si, ei, 'exit')}.occurrence`);
        if (errors.length > before) anchorErrors = true;
      }

      // Text should stay minimal: numbers, symbols and a word or two.
      if (el.type === 'text') {
        // A word has 3+ letters including lowercase; formulas (CO, CH₄) and numbers don't count.
        const words = el.text.split(/\s+/).filter((w) => /\p{L}\p{Ll}{2,}/u.test(w)).length;
        if (words > MAX_TEXT_WORDS) {
          warnings.push(
            `${P(si, ei)}: text "${el.text}" has ${words} words. Professional explainers keep on-screen text to ` +
              `numbers, symbols and labels of 1–${MAX_TEXT_WORDS} words; let the narration and pictures carry the idea.`,
          );
        }
      }
    });
  });

  // Overlaps: two elements collide when they share grid cells while both are
  // on screen (an element leaves at its exit or when a clearBefore scene starts).
  // Exception: layers of one drawing, i.e. framed assets (imported with --frame) placed in
  // exactly the same cells, which line up by construction.
  // Needs resolved anchors, so it runs once the anchors are valid.
  if (!anchorErrors && !errors.length) {
    const { items } = computeSchedule(scene, timing);
    const isLayer = (el) => el.type === 'asset' && !!getAsset(el.asset).frame;
    const placed = [];
    for (const it of items) {
      const el = it.el;
      if (el.type === 'arrow') continue;
      const a = { c0: el.at[0], r0: el.at[1], c1: el.at[0] + el.size[0] - 1, r1: el.at[1] + el.size[1] - 1 };
      const from = it.start;
      const until = Math.min(it.hideAt, it.exitEnd);
      for (const o of placed) {
        if (from >= o.until || o.from >= until) continue;
        const c0 = Math.max(a.c0, o.c0);
        const r0 = Math.max(a.r0, o.r0);
        const c1 = Math.min(a.c1, o.c1);
        const r1 = Math.min(a.r1, o.r1);
        if (c0 > c1 || r0 > r1) continue;
        if (o.layer && isLayer(el) && o.c0 === a.c0 && o.r0 === a.r0 && o.c1 === a.c1 && o.r1 === a.r1) continue;
        const sameScene = o.si === it.sceneIndex;
        errors.push(
          `${P(it.sceneIndex, it.elementIndex)}: "${el.id}" overlaps "${o.id}" (${P(o.si, o.ei)}) at cells ` +
            `${cellList(c0, r0, c1, r1)} while both are on screen (${fmtSec(Math.max(from, o.from))}–` +
            `${fmtSec(Math.min(until, o.until))}). ` +
            (sameScene
              ? `Move or resize one of them, or give "${o.id}" an "exit" before "${el.id}" appears.`
              : `"${o.id}" is still on screen because scenes[${it.sceneIndex}] does not set "clearBefore": true. ` +
                'Move one of them, or set clearBefore on this scene.'),
        );
      }
      placed.push({ ...a, from, until, id: el.id, si: it.sceneIndex, ei: it.elementIndex, layer: isLayer(el) });
    }
  }

  // Image files.
  scene.scenes.forEach((sc, si) =>
    sc.elements.forEach((el, ei) => {
      if (el.type === 'image' && !resolveAudioPath(el.src, scenePath, { mustExist: true })) {
        errors.push(
          `${P(si, ei, 'src')}: image "${el.src}" not found (looked relative to the current directory and to the scene file).`,
        );
      }
    }),
  );

  // Audio file.
  if (scene.audio && !resolveAudioPath(scene.audio, scenePath, { mustExist: true })) {
    errors.push(
      `audio: file "${scene.audio}" not found (looked relative to the current directory and to the scene file). ` +
        'Fix the path or remove the "audio" field.',
    );
  }

  if (errors.length) return { ok: false, errors, warnings, scene };

  // Timing sanity checks (warnings: renderable, but probably not intended).
  const { items, sceneStarts } = computeSchedule(scene, timing);
  const byId = new Map(items.map((it) => [it.el.id, it]));
  for (const it of items) {
    const where = P(it.sceneIndex, it.elementIndex);
    if (it.clamped) {
      warnings.push(
        `${where}: "${it.el.id}" would need to start drawing before t=0 (anchor at ${fmtSec(it.anchorSec)}, ` +
          `lead ${it.el.lead}s + duration ${it.el.duration}s); its window was clamped to ${fmtSec(it.start)}–${fmtSec(it.end)}.`,
      );
    }
    if (it.el.type === 'arrow') {
      const late = ['from', 'to'].map((k) => byId.get(it.el[k])).filter((e) => e.start > it.start);
      for (const e of late) {
        warnings.push(
          `${where}: arrow "${it.el.id}" starts drawing at ${fmtSec(it.start)}, before "${e.el.id}" appears at ` +
            `${fmtSec(e.start)}. Anchor the arrow later or the endpoint earlier.`,
        );
      }
    }
    if (it.el.exit && it.exitStart === it.end && it.anchorSec !== undefined) {
      const exitAt = it.exitStart;
      if (exitAt - it.end < 0.5) {
        warnings.push(
          `${where}: "${it.el.id}" starts leaving at ${fmtSec(exitAt)}, right as it finishes appearing. ` +
            'Anchor its exit later so it can be seen.',
        );
      }
    }
    if (it.end > it.hideAt) {
      warnings.push(
        `${where}: "${it.el.id}" finishes drawing at ${fmtSec(it.end)}, but a later clearBefore scene wipes the board at ` +
          `${fmtSec(it.hideAt)}${it.start >= it.hideAt ? ', so it is never visible' : ''}. Anchor it earlier or move it into the later scene.`,
      );
    }
  }
  scene.scenes.forEach((sc, si) => {
    if (si > 0 && sceneStarts[si] < sceneStarts[si - 1]) {
      warnings.push(
        `scenes[${si}]: starts at ${fmtSec(sceneStarts[si])}, before scenes[${si - 1}] (${fmtSec(sceneStarts[si - 1])}). ` +
          'Scenes should follow the order of the narration.',
      );
    }
    // A wipe right after the previous scene finishes leaves no time to read it.
    if (si > 0 && sc.clearBefore) {
      const prevEnd = Math.max(...items.filter((it) => it.sceneIndex === si - 1).map((it) => it.end));
      const shown = sceneStarts[si] - prevEnd;
      if (shown < MIN_SCENE_HOLD) {
        warnings.push(
          `scenes[${si}]: wipes the board at ${fmtSec(sceneStarts[si])}, only ${Math.max(0, shown).toFixed(2)}s after ` +
            `scenes[${si - 1}] finished drawing (${fmtSec(prevEnd)}), so the finished scene is barely seen. ` +
            `Anchor this scene's first element a few words into its paragraph (with a small lead), ` +
            `or finish scenes[${si - 1}] earlier; aim for at least ${MIN_SCENE_HOLD}s.`,
        );
      }
    }
    // A camera push-in enlarges everything around its focus; edges can leave the frame.
    if (sc.camera) {
      const { width, height } = scene.canvas;
      const focus = sc.camera.focus ? cellRect(scene.canvas, sc.camera.focus, [1, 1]) : null;
      const cx = focus ? focus.x + focus.w / 2 : width / 2;
      const cy = focus ? focus.y + focus.h / 2 : height / 2;
      const z = sc.camera.zoom;
      const onBoard = items.filter(
        (it) => it.sceneIndex <= si && it.hideAt > sceneStarts[si] && it.exitEnd > sceneStarts[si] && it.el.type !== 'arrow',
      );
      for (const it of onBoard) {
        const r = cellRect(scene.canvas, it.el.at, it.el.size);
        const x0 = cx + (r.x - cx) * z;
        const y0 = cy + (r.y - cy) * z;
        const x1 = cx + (r.x + r.w - cx) * z;
        const y1 = cy + (r.y + r.h - cy) * z;
        const out = Math.max(-x0, -y0, x1 - width, y1 - height);
        if (out > CROP_TOLERANCE) {
          warnings.push(
            `${P(it.sceneIndex, it.elementIndex)}: "${it.el.id}" will be cut off by up to ${Math.round(out)}px when ` +
              `scenes[${si}]'s camera reaches ${z}x. Move it away from the edge, lower "zoom", or set "focus" ` +
              'near the edge it touches (zoom grows away from the focus).',
          );
        }
      }
    }
  });

  return { ok: true, errors, warnings, scene };
}
