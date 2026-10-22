#!/usr/bin/env node
// whiteboard CLI. Heavy modules are imported lazily so `list-assets` stays fast.
import { readFileSync, writeFileSync } from 'node:fs';
import { Command } from 'commander';
import { listAssets, searchLibrary, getAsset } from './assets.js';
import { resolveAudioPath } from './util.js';

const SCHEMA_SUMMARY = `\
GRID & SCHEMA
The canvas (default 1920x1080) is divided into a grid (default 12 columns x 8 rows; cell
0,0 is top-left). Every asset/text element is placed with "at": [col, row] (its top-left
cell) and "size": [cols, rows]; it must stay inside the grid and must not overlap any other
element that is on screen at the same time (each rectangle gets a 10% inner padding).
scene.json = { canvas: {width, height, grid: [cols, rows]}, style: {stroke, strokeWidth,
background, roughness, fontFamily?}, audio?, scenes: [{ id, clearBefore?,
elements: [...] }] }.
Element types: "asset" {asset, at, size, colors?, flip?, roughness?}, "text" {text, at, size,
color?, font?, weight?, align?}, "arrow" {from, to, color?} (ids of elements in the same
scene; drawn edge-to-edge), "image" {src, at, size, panel?} (a PNG/JPEG such as a question
screenshot, optionally on a white card). Assets marked [color] are outlined first, then colored in;
"colors": false draws them as black-and-white line art. Any element may set "enter":
"draw" | "pop" | "fade" and "exit": {anchor, lead?, duration?, style?} to leave the board; a
scene may set "background" and "camera": {zoom, focus?}. Keep on-screen text to numbers,
symbols and 1-3 word labels. Every element also needs a unique
"id" and an "anchor": a verbatim phrase from the transcript (3-6 words, matched ignoring case
and punctuation). Never write timestamps: the element finishes drawing "lead" seconds
(default 0.4) before the anchor is spoken and takes "duration" seconds (default 0.7) to draw.
If the phrase occurs more than once, add "occurrence": N (1-based). A scene with
"clearBefore": true wipes everything from earlier scenes when its first element starts.

MISSING AN OBJECT? Find or create it before writing scene.json:
  whiteboard asset search "<concept>" --sheet results.png   (look at the sheet, pick one)
  whiteboard asset add <set:icon> --name <name> --description "<what it shows>"
  whiteboard asset import <your.svg> --name <name> --description "..."   (SVG you wrote)
  whiteboard asset preview <name...> -o check.png            (look at it before using it)`;

function collect(v, prev) {
  return prev.concat(
    v
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean),
  );
}

function licenseShort(a) {
  if (!a.license) return '';
  return a.license.spdx ?? a.license.title ?? '';
}

function readJson(path, what) {
  let text;
  try {
    text = readFileSync(path, 'utf8');
  } catch (e) {
    fail(`cannot read ${what} "${path}": ${e.code === 'ENOENT' ? 'file not found' : e.message}`);
  }
  try {
    return JSON.parse(text);
  } catch (e) {
    fail(`${what} "${path}" is not valid JSON: ${e.message}`);
  }
}

function fail(msg) {
  console.error(`error: ${msg}`);
  process.exit(1);
}

/** Load + validate scene and timing; exit 1 with the error list on failure. */
async function loadValidated(scenePath, timingPath) {
  const { validateScene } = await import('./schema.js');
  const scene = readJson(scenePath, 'scene');
  const timing = readJson(timingPath, 'timing');
  const result = validateScene(scene, timing, { scenePath });
  for (const w of result.warnings) console.error(`warning: ${w}`);
  if (!result.ok) {
    console.error(result.errors.join('\n'));
    const count = result.errors.filter((e) => !e.startsWith('(')).length;
    console.error(`\n${count} error(s) in ${scenePath}`);
    process.exit(1);
  }
  return { scene: result.scene, timing };
}

const program = new Command();
program
  .name('whiteboard')
  .description('Render a narrated whiteboard animation from a transcript and scene.json');

program
  .command('list-assets')
  .description('List library assets and summarize the scene.json format')
  .option('--search <words>', 'only assets whose name, description or tags contain all these words')
  .action((opts) => {
    const assets = opts.search ? searchLibrary(opts.search) : listAssets();
    if (opts.search && !assets.length) {
      console.log(`no library asset matches "${opts.search}". Find one online with:\n  whiteboard asset search "${opts.search}" --sheet results.png`);
      return;
    }
    const width = Math.max(...assets.map((a) => a.name.length));
    console.log(opts.search ? `ASSETS matching "${opts.search}"` : `ASSETS (${assets.length})`);
    for (const a of assets) {
      const tag = a.colorful ? '[color] ' : '';
      const lic = licenseShort(a) ? `  (${licenseShort(a)})` : '';
      console.log(`  ${a.name.padEnd(width)}  ${tag}${a.description}${lic}`);
    }
    if (!opts.search) console.log(`\n${SCHEMA_SUMMARY}`);
  });

const asset = program.command('asset').description('Find, add, import and preview library assets');

asset
  .command('search')
  .description('Search open-licensed icon sets (Iconify) for an object to add to the library')
  .argument('<query...>', 'what to look for, e.g. "office worker"')
  .option('--style <style>', 'any | color (filled, colorful) | line (outline only)', 'any')
  .option('--sets <prefixes>', 'comma list of Iconify set prefixes to search instead (e.g. openmoji,tabler)')
  .option('--limit <n>', 'max results', '18')
  .option('--sheet <file>', 'also render a numbered PNG of the results to look at')
  .action(async (queryWords, opts) => {
    const { searchIcons, fetchIconSvg, rawSheetPng } = await import('./asset-tools.js');
    const query = queryWords.join(' ');
    const results = await searchIcons(query, {
      style: opts.style,
      sets: opts.sets ? opts.sets.split(',') : undefined,
      limit: Number(opts.limit),
    });
    if (!results.length) {
      console.log(`no icons found for "${query}". Try a simpler or more generic word (e.g. "person" instead of "accountant"),\nor draw it yourself and run \`whiteboard asset import\`.`);
      return;
    }
    results.forEach((r, i) => {
      const c = r.collection;
      console.log(`${String(i + 1).padStart(2)}. ${r.id.padEnd(44)} ${c?.name ?? r.set} — ${c?.license?.spdx ?? c?.license?.title ?? '?'}`);
    });
    if (opts.sheet) {
      const svgs = await Promise.all(results.map((r) => fetchIconSvg(r.id).catch(() => null)));
      const items = results
        .map((r, i) => ({ svg: svgs[i], label: `${i + 1}. ${r.id}` }))
        .filter((x) => x.svg);
      writeFileSync(opts.sheet, rawSheetPng(items));
      console.log(`\nwrote ${opts.sheet} — look at it, then: whiteboard asset add <id> --name <name> --description "..."`);
    } else {
      console.log('\nTip: add --sheet results.png to see them before choosing.');
    }
  });

asset
  .command('add')
  .description('Download an Iconify icon, normalize it and add it to the library')
  .argument('<id>', 'icon id from `asset search`, e.g. openmoji:house')
  .requiredOption('--name <name>', 'library name (lowercase snake_case)')
  .requiredOption('--description <text>', 'one line: what it shows and when to use it')
  .option('--tags <list>', 'comma-separated search keywords', collect, [])
  .option('--roughness <n>', 'roughness multiplier for this asset (detailed art looks best at 0.3-0.6)', '0.5')
  .option('--order <order>', 'draw order: top (top to bottom), left (left to right) or document', 'top')
  .option('--force', 'replace an existing asset with the same name')
  .action(async (id, opts) => {
    const { fetchIconSvg, iconLicense, normalizeSvg, writeAsset } = await import('./asset-tools.js');
    const svg = await fetchIconSvg(id);
    const normalized = normalizeSvg(svg);
    const license = await iconLicense(id.split(':')[0]).catch(() => null);
    writeAsset(
      opts.name,
      normalized,
      {
        description: opts.description,
        tags: opts.tags,
        roughness: Number(opts.roughness),
        order: opts.order,
        source: { provider: 'iconify', id, url: `https://icon-sets.iconify.design/${id.replace(':', '/')}/` },
        license,
      },
      { force: opts.force },
    );
    const s = normalized.stats;
    console.log(
      `added "${opts.name}" from ${id}: ${s.strokes} stroked + ${s.fills} filled paths, ` +
        `${s.colors.length} colors${license ? `, license ${license.spdx ?? license.title} (${license.author})` : ''}`,
    );
    console.log(`check it: whiteboard asset preview ${opts.name} -o check.png`);
  });

asset
  .command('import')
  .description('Normalize a local SVG (e.g. one you drew) and add it to the library')
  .argument('<file>', 'any SVG: shapes, groups and transforms are flattened into paths')
  .requiredOption('--name <name>', 'library name (lowercase snake_case)')
  .requiredOption('--description <text>', 'one line: what it shows and when to use it')
  .option('--tags <list>', 'comma-separated search keywords', collect, [])
  .option('--roughness <n>', 'roughness multiplier for this asset', '1')
  .option('--order <order>', 'draw order: document (as written in the SVG), top (top to bottom) or left (left to right)', 'document')
  .option('--license <spdx>', 'license of the artwork', 'original')
  .option('--author <name>', 'author of the artwork')
  .option('--frame', "fit the SVG's viewBox instead of the drawing's extent, so overlays drawn on the same canvas line up")
  .option('--force', 'replace an existing asset with the same name')
  .action(async (file, opts) => {
    const { normalizeSvg, writeAsset } = await import('./asset-tools.js');
    let svg;
    try {
      svg = readFileSync(file, 'utf8');
    } catch (e) {
      fail(`cannot read "${file}": ${e.message}`);
    }
    const normalized = normalizeSvg(svg, { frame: !!opts.frame });
    writeAsset(
      opts.name,
      normalized,
      {
        description: opts.description,
        tags: opts.tags,
        roughness: Number(opts.roughness),
        order: opts.order,
        source: { provider: 'file', file },
        license: { spdx: opts.license, author: opts.author },
      },
      { force: opts.force },
    );
    const s = normalized.stats;
    console.log(`imported "${opts.name}": ${s.strokes} stroked + ${s.fills} filled paths, ${s.colors.length} colors`);
    console.log(`check it: whiteboard asset preview ${opts.name} -o check.png`);
  });

asset
  .command('preview')
  .description('Render assets as the renderer draws them: mid-draw, in color, and as line art')
  .argument('<names...>', 'library asset names')
  .option('-o, --out <file>', 'output PNG', 'assets-preview.png')
  .action(async (names, opts) => {
    for (const n of names) getAsset(n); // fail early with suggestions
    const { previewAssetsPng } = await import('./asset-tools.js');
    const style = { stroke: '#1a1a1a', strokeWidth: 3, background: '#fdfdf8', roughness: 1.2 };
    writeFileSync(opts.out, await previewAssetsPng(names, style));
    console.log(`wrote ${opts.out} (${names.length} asset(s): mid-draw | color | line art)`);
  });

program
  .command('credits')
  .description('Attribution lines for third-party assets (all, or those used by a scene)')
  .argument('[scene]', 'scene.json; omit to list the whole library')
  .action((scenePath) => {
    let names;
    if (scenePath) {
      const scene = readJson(scenePath, 'scene');
      names = new Set(
        (scene.scenes ?? []).flatMap((s) => (s.elements ?? []).filter((e) => e.type === 'asset').map((e) => e.asset)),
      );
    }
    const assets = listAssets().filter((a) => !names || names.has(a.name));
    const credited = assets.filter((a) => a.source?.provider === 'iconify');
    if (!credited.length) {
      console.log('no third-party assets: nothing to credit');
      return;
    }
    for (const a of credited) {
      const l = a.license ?? {};
      console.log(
        `${a.name}: "${a.source.id}" from ${l.collection ?? 'Iconify'} by ${l.author ?? 'unknown'}, ` +
          `${l.title ?? l.spdx ?? 'see source'}${l.url ? ` (${l.url})` : ''}`,
      );
    }
  });

program
  .command('align')
  .description('Estimate per-word timing for a transcript (writes timing.json)')
  .argument('<transcript>', 'transcript text file')
  .option('--audio <file>', 'narration audio; its duration (via ffprobe) scales the timing')
  .option('-o, --out <file>', 'output path', 'timing.json')
  .action(async (transcriptPath, opts) => {
    const { align } = await import('./align.js');
    let transcript;
    try {
      transcript = readFileSync(transcriptPath, 'utf8');
    } catch (e) {
      fail(`cannot read transcript "${transcriptPath}": ${e.message}`);
    }
    const timing = await align(transcript, opts.audio);
    writeFileSync(opts.out, JSON.stringify(timing, null, 2) + '\n');
    console.log(`wrote ${opts.out}: ${timing.words.length} words, ${timing.duration.toFixed(2)}s`);
    if (timing.stats) {
      const st = timing.stats;
      console.log(
        `  snapped ${st.snappedSentences}/${st.sentences} sentence ends (${st.snapped} boundaries in all) ` +
          `to ${st.pauses} pauses detected in the audio`,
      );
    }
  });

program
  .command('validate')
  .description('Validate scene.json against the schema, asset library and transcript timing')
  .argument('<scene>', 'scene.json')
  .requiredOption('--timing <file>', 'timing.json from `whiteboard align`')
  .option('--schedule', 'also print when each element draws (to choose preview times)')
  .action(async (scenePath, opts) => {
    const { scene, timing } = await loadValidated(scenePath, opts.timing);
    if (opts.schedule) {
      const { computeSchedule } = await import('./timeline.js');
      const { items, sceneStarts } = computeSchedule(scene, timing);
      const w = Math.max(...items.map((it) => it.el.id.length));
      scene.scenes.forEach((sc, si) => {
        const done = Math.max(...items.filter((it) => it.sceneIndex === si).map((it) => it.end));
        console.log(
          `scenes[${si}] "${sc.id}"${sc.clearBefore ? ' (clearBefore)' : ''}: ` +
            `${sceneStarts[si].toFixed(2)}s – ${done.toFixed(2)}s`,
        );
        for (const it of items.filter((x) => x.sceneIndex === si)) {
          console.log(
            `  ${it.el.id.padEnd(w)}  ${it.el.type.padEnd(5)}  draws ${it.start.toFixed(2)}–${it.end.toFixed(2)}s` +
              `  (anchor "${it.el.anchor}" @ ${it.anchorSec.toFixed(2)}s)`,
          );
        }
      });
      console.log(`timeline: ${timing.duration.toFixed(2)}s of narration`);
    }
    console.log('OK');
  });

program
  .command('preview')
  .description('Render one frame, or a contact sheet of several frames, to PNG')
  .argument('<scene>', 'scene.json')
  .requiredOption('--timing <file>', 'timing.json from `whiteboard align`')
  .requiredOption('--at <seconds>', 'a time in seconds, or a comma list like "2,5,8,11" for a contact sheet')
  .option('-o, --out <file>', 'output PNG', 'frame.png')
  .action(async (scenePath, opts) => {
    const times = String(opts.at)
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean)
      .map(Number);
    if (!times.length || times.some((t) => !Number.isFinite(t) || t < 0)) {
      fail(`--at must be a non-negative number or a comma list of them, got "${opts.at}"`);
    }
    const { scene, timing } = await loadValidated(scenePath, opts.timing);
    const { buildTimeline } = await import('./timeline.js');
    const { previewPng } = await import('./render.js');
    const timeline = buildTimeline(scene, timing, { scenePath });
    writeFileSync(opts.out, previewPng(timeline, times));
    console.log(
      times.length === 1
        ? `wrote ${opts.out} (t=${times[0]}s)`
        : `wrote ${opts.out}: contact sheet of ${times.length} frames (t=${times.join(', ')}s)`,
    );
  });

program
  .command('render')
  .description('Render the full animation to MP4 (requires ffmpeg on PATH)')
  .argument('<scene>', 'scene.json')
  .requiredOption('--timing <file>', 'timing.json from `whiteboard align`')
  .option('--audio <file>', 'narration audio to mux in (overrides scene.json "audio")')
  .option('--fps <n>', 'frames per second', '30')
  .option('-o, --out <file>', 'output MP4', 'out.mp4')
  .option('--chunk <seconds>', 'encode in chunks of this length; an interrupted render resumes from the last finished chunk', '60')
  .action(async (scenePath, opts) => {
    const fps = Number(opts.fps);
    const chunk = Number(opts.chunk);
    if (!Number.isFinite(chunk) || chunk <= 0) fail(`--chunk must be a positive number of seconds, got "${opts.chunk}"`);
    if (!Number.isFinite(fps) || fps <= 0 || fps > 120) fail(`--fps must be between 1 and 120, got "${opts.fps}"`);
    const { scene, timing } = await loadValidated(scenePath, opts.timing);
    const { buildTimeline } = await import('./timeline.js');
    const { renderVideo } = await import('./render.js');
    const audio = opts.audio ?? (scene.audio ? resolveAudioPath(scene.audio, scenePath) : undefined);
    const timeline = buildTimeline(scene, timing, { scenePath });
    await renderVideo(timeline, { fps, audio, out: opts.out, chunk });
  });

program.parseAsync().catch((e) => fail(e.message));
