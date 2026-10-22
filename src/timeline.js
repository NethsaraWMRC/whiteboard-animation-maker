// scene.json + timing.json -> fully resolved, immutable timeline.
// Every number a frame needs (draw windows, visibility, geometry, camera) is
// computed here once; frame.js only reads it.
import { anchorTime } from './align.js';
import { assetGeometry, arrowGeometry, textGeometries, imageGeometry, cellRect } from './geometry.js';
import { resolveAudioPath } from './util.js';

const TAIL = 1.0; // seconds of hold after the last element finishes
export const DEFAULT_EXIT = 0.4; // seconds an exit animation takes

/**
 * Resolve each element's draw window from its anchor:
 *   [anchor - lead - duration, anchor - lead], clamped to >= 0.
 * An element with `exit` leaves when its exit anchor is spoken:
 *   [max(end, exitAnchor - exit.lead), + exit.duration].
 * A scene with clearBefore hides every element of earlier scenes once its
 * own first element starts drawing (`hideAt`).
 * Assumes the scene has already passed schema validation.
 */
export function computeSchedule(scene, timing) {
  const items = [];
  scene.scenes.forEach((sc, sceneIndex) => {
    sc.elements.forEach((el, elementIndex) => {
      const anchorSec = anchorTime(timing, el.anchor, el.occurrence ?? 1);
      const rawStart = anchorSec - el.lead - el.duration;
      const start = Math.max(0, rawStart);
      const end = Math.max(start, anchorSec - el.lead);
      let exitStart = Infinity;
      let exitEnd = Infinity;
      if (el.exit) {
        const a = anchorTime(timing, el.exit.anchor, el.exit.occurrence ?? 1);
        exitStart = Math.max(end, a - (el.exit.lead ?? 0));
        exitEnd = exitStart + (el.exit.duration ?? DEFAULT_EXIT);
      }
      items.push({
        el,
        sceneIndex,
        elementIndex,
        anchorSec,
        start,
        end,
        exitStart,
        exitEnd,
        clamped: rawStart < 0,
        hideAt: Infinity,
      });
    });
  });
  const sceneStarts = scene.scenes.map((_, i) =>
    Math.min(...items.filter((it) => it.sceneIndex === i).map((it) => it.start)),
  );
  for (const it of items) {
    for (let j = it.sceneIndex + 1; j < scene.scenes.length; j++) {
      if (scene.scenes[j].clearBefore) it.hideAt = Math.min(it.hideAt, sceneStarts[j]);
    }
  }
  return { items, sceneStarts };
}

function deepFreeze(o) {
  if (o && typeof o === 'object' && !Object.isFrozen(o)) {
    Object.freeze(o);
    for (const v of Object.values(o)) deepFreeze(v);
  }
  return o;
}

/**
 * -> { canvas, style, duration,
 *      scenes: [{ start, end, background, camera: { zoom, cx, cy } | null }],
 *      elements: [{ id, type, sceneIndex, start, end, exitStart, exitEnd, hideAt, enter, exit, geometry }] }
 */
export function buildTimeline(scene, timing, { scenePath } = {}) {
  const { canvas, style } = scene;
  const { items, sceneStarts } = computeSchedule(scene, timing);

  const texts = textGeometries(
    items.filter((it) => it.el.type === 'text').map((it) => it.el),
    canvas,
    style,
  );
  const geometry = new Map();
  for (const { el } of items) {
    if (el.type === 'asset') geometry.set(el.id, assetGeometry(el, canvas, style));
    else if (el.type === 'text') geometry.set(el.id, texts.get(el.id));
    else if (el.type === 'image') {
      geometry.set(el.id, imageGeometry(el, canvas, resolveAudioPath(el.src, scenePath, { mustExist: true }) ?? el.src));
    }
  }
  for (const { el } of items) {
    if (el.type === 'arrow') {
      geometry.set(el.id, arrowGeometry(el, geometry.get(el.from).bounds, geometry.get(el.to).bounds, style));
    }
  }

  const elements = items.map((it) => ({
    id: it.el.id,
    type: it.el.type,
    sceneIndex: it.sceneIndex,
    start: it.start,
    end: it.end,
    exitStart: it.exitStart,
    exitEnd: it.exitEnd,
    hideAt: it.hideAt,
    enter: it.el.enter ?? 'draw',
    exit: it.el.exit ? (it.el.exit.style ?? (it.el.enter === 'pop' ? 'pop' : 'fade')) : null,
    geometry: geometry.get(it.el.id),
  }));
  const lastEnd = Math.max(0, ...elements.map((e) => (Number.isFinite(e.exitEnd) ? Math.max(e.end, e.exitEnd) : e.end)));
  const duration = Math.max(timing.duration, lastEnd + TAIL);

  // Scenes: board background (inherited until the next clearBefore) and an
  // optional slow camera push-in over the scene's lifetime.
  const scenes = [];
  scene.scenes.forEach((sc, i) => {
    let end = duration;
    for (let j = i + 1; j < scene.scenes.length; j++) {
      if (scene.scenes[j].clearBefore) {
        end = sceneStarts[j];
        break;
      }
    }
    const inherited = i > 0 && !sc.clearBefore ? scenes[i - 1].background : style.background;
    let camera = null;
    if (sc.camera) {
      const focus = sc.camera.focus ? cellRect(canvas, sc.camera.focus, [1, 1]) : null;
      camera = {
        zoom: sc.camera.zoom,
        cx: focus ? focus.x + focus.w / 2 : canvas.width / 2,
        cy: focus ? focus.y + focus.h / 2 : canvas.height / 2,
      };
    }
    scenes.push({ start: sceneStarts[i], end, background: sc.background ?? inherited, camera });
  });

  return deepFreeze({ canvas, style, duration, scenes, elements });
}
