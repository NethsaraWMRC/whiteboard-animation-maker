// Rasterize frames with resvg and pipe them into ffmpeg.
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { Resvg } from '@resvg/resvg-js';
import { renderFrameSVG, renderFrameBody } from './frame.js';
import { probeDuration } from './align.js';
import { fmt } from './util.js';

// Text is converted to outlines at build time, so frames never need fonts;
// skipping system font loading saves seconds per frame.
const NO_FONTS = { loadSystemFonts: false };

export function rasterize(svg, width) {
  return new Resvg(svg, { fitTo: { mode: 'width', value: width }, font: NO_FONTS }).render().asPng();
}

/** One frame as PNG, or a labeled contact sheet when several times are given. */
export function previewPng(timeline, times) {
  const { width, height } = timeline.canvas;
  if (times.length === 1) return rasterize(renderFrameSVG(timeline, times[0]), width);

  const cols = Math.ceil(Math.sqrt(times.length));
  const rowsN = Math.ceil(times.length / cols);
  const scale = Math.min(1, 1920 / cols / width);
  const cw = width * scale;
  const ch = height * scale;
  const gap = 16;
  const label = 40;
  const W = cols * cw + (cols + 1) * gap;
  const H = rowsN * (ch + label) + (rowsN + 1) * gap;
  let body = `<rect width="${W}" height="${H}" fill="#9a9a9a"/>`;
  times.forEach((t, i) => {
    const x = gap + (i % cols) * (cw + gap);
    const y = gap + Math.floor(i / cols) * (ch + label + gap);
    body +=
      `<text x="${fmt(x)}" y="${fmt(y + 30)}" font-family="Arial, Helvetica, sans-serif" font-size="26" ` +
      `font-weight="bold" fill="#ffffff">#${i + 1}  t = ${t}s</text>` +
      `<g transform="translate(${fmt(x)} ${fmt(y + label)}) scale(${scale})">${renderFrameBody(timeline, t, `f${i}-`)}</g>`;
  });
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${fmt(W)}" height="${fmt(H)}">${body}</svg>`;
  // The labels need a font; loading system fonts once per contact sheet is fine.
  return new Resvg(svg, { font: { loadSystemFonts: true, defaultFontFamily: 'Arial' } }).render().asPng();
}

function assertFfmpeg() {
  const r = spawnSync('ffmpeg', ['-version'], { stdio: 'ignore' });
  if (r.error) {
    throw new Error(
      r.error.code === 'ENOENT'
        ? 'ffmpeg not found on PATH. Install it (https://ffmpeg.org/download.html, or e.g. `winget install ffmpeg`, ' +
            '`brew install ffmpeg`, `apt install ffmpeg`) and make sure the `ffmpeg` command works in this shell.'
        : `could not run ffmpeg: ${r.error.message}`,
    );
  }
}

/** Pipe frames [f0, f1) into one ffmpeg process writing `out` (video only unless `audio`). */
async function encodeFrames(timeline, fps, f0, f1, out, { audio, log }) {
  const { width } = timeline.canvas;
  const args = ['-y', '-loglevel', 'error', '-f', 'image2pipe', '-framerate', String(fps), '-i', '-'];
  if (audio) args.push('-i', audio);
  args.push('-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-crf', '18', '-preset', 'medium');
  if (audio) args.push('-c:a', 'aac', '-b:a', '192k', '-shortest');
  args.push(out);

  const ff = spawn('ffmpeg', args, { stdio: ['pipe', 'ignore', 'pipe'] });
  let stderr = '';
  ff.stderr.on('data', (d) => {
    stderr = (stderr + d).slice(-20000);
  });
  const exited = new Promise((resolve, reject) => {
    ff.on('error', reject);
    ff.on('close', (code) => resolve(code));
  });
  ff.stdin.on('error', () => {}); // EPIPE if ffmpeg dies; reported via its exit code

  for (let f = f0; f < f1; f++) {
    if (ff.exitCode !== null) break;
    const png = rasterize(renderFrameSVG(timeline, f / fps), width);
    if (!ff.stdin.write(png)) await Promise.race([once(ff.stdin, 'drain'), exited]);
    log(f + 1);
  }
  ff.stdin.end();
  const code = await exited;
  if (code !== 0) throw new Error(`ffmpeg exited with code ${code}:\n${stderr.trim()}`);
}

/**
 * Render the timeline to MP4. Frames are encoded in chunks of `chunk` seconds into
 * `<out>.parts/`; a finished chunk is kept, so an interrupted render (crash, power loss)
 * resumes where it stopped when run again with the same scene. The chunks are then joined
 * without re-encoding and the audio is muxed in. The parts folder is removed at the end.
 */
export async function renderVideo(timeline, { fps = 30, audio, out = 'out.mp4', chunk = 60 } = {}) {
  assertFfmpeg();
  if (audio) {
    const audioSec = await probeDuration(audio);
    if (Math.abs(audioSec - timeline.duration) > 0.5) {
      console.error(
        `warning: audio is ${audioSec.toFixed(2)}s but the timeline is ${timeline.duration.toFixed(2)}s; ` +
          'drawings may be out of sync. Re-run `whiteboard align <transcript> --audio <file>` to fit timing to the audio.',
      );
    }
  }

  const totalFrames = Math.ceil(timeline.duration * fps);
  const per = Math.max(1, Math.round(chunk * fps));
  const nChunks = Math.ceil(totalFrames / per);
  const partsDir = `${out}.parts`;
  // Chunks from an earlier run are reused only if they were made from the same timeline
  const key = createHash('sha1').update(JSON.stringify({ fps, per, timeline })).digest('hex');
  const keyFile = path.join(partsDir, 'key.txt');
  if (fs.existsSync(partsDir) && (!fs.existsSync(keyFile) || fs.readFileSync(keyFile, 'utf8') !== key)) {
    fs.rmSync(partsDir, { recursive: true, force: true });
  }
  fs.mkdirSync(partsDir, { recursive: true });
  fs.writeFileSync(keyFile, key);
  const part = (i) => path.join(partsDir, `part-${String(i).padStart(4, '0')}.mp4`);
  const done = (i) => fs.existsSync(`${part(i)}.done`);

  const todo = [...Array(nChunks).keys()].filter((i) => !done(i));
  const framesTodo = todo.reduce((a, i) => a + Math.min(per, totalFrames - i * per), 0);
  console.log(
    `rendering ${totalFrames} frames (${timeline.duration.toFixed(2)}s @ ${fps}fps) -> ${out}` +
      (todo.length < nChunks ? ` (resuming: ${nChunks - todo.length}/${nChunks} chunks already done)` : ''),
  );
  const t0 = performance.now();
  let rendered = 0;
  for (const i of todo) {
    const f0 = i * per;
    const f1 = Math.min(totalFrames, f0 + per);
    await encodeFrames(timeline, fps, f0, f1, part(i), {
      log: (f) => {
        rendered++;
        if (f % 30 === 0 || f === totalFrames) {
          const elapsed = (performance.now() - t0) / 1000;
          const pct = ((f / totalFrames) * 100).toFixed(0).padStart(3);
          console.log(`  frame ${String(f).padStart(String(totalFrames).length)}/${totalFrames} ${pct}%  ${(rendered / elapsed).toFixed(1)} fps`);
        }
      },
    });
    fs.writeFileSync(`${part(i)}.done`, '');
  }
  if (framesTodo !== rendered) throw new Error(`rendered ${rendered} of ${framesTodo} frames`);

  // Join the chunks (stream copy) and mux the audio
  const list = path.join(partsDir, 'list.txt');
  fs.writeFileSync(list, [...Array(nChunks).keys()].map((i) => `file '${path.basename(part(i))}'`).join('\n') + '\n');
  const args = ['-y', '-loglevel', 'error', '-f', 'concat', '-safe', '0', '-i', list];
  if (audio) args.push('-i', audio, '-map', '0:v', '-map', '1:a', '-c:v', 'copy', '-c:a', 'aac', '-b:a', '192k', '-shortest');
  else args.push('-c', 'copy');
  args.push(out);
  const r = spawnSync('ffmpeg', args, { encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`ffmpeg could not join the chunks:\n${(r.stderr || '').trim()}`);
  fs.rmSync(partsDir, { recursive: true, force: true });
  console.log(`wrote ${out} in ${((performance.now() - t0) / 1000).toFixed(1)}s${audio ? ' (with audio)' : ''}`);
}
