---
name: whiteboard-animation
description: Turn a narration transcript (and optional narration audio) into a professional animated explainer video (whiteboard / flat motion-graphics style) by authoring scene.json for the whiteboard-poc renderer, including finding, downloading or drawing the illustrations it needs. Use when the user asks for a whiteboard animation, an explainer or doodle video, an animated lesson, or an animated diagram synced to a voice-over or transcript.
---

# Animated explainer videos

You author `scene.json`; the `whiteboard` CLI renders it deterministically. Elements are drawn on
stroke by stroke, pop in, or fade in, exactly when the narration reaches them. You never write
timestamps: each element names a phrase from the transcript (its **anchor**) and the tool works
out the seconds from `timing.json`.

Run commands from the project root as `node src/cli.js <command>` (or `whiteboard <command>`
after `npm link`).

## The style: what professional explainers do

Study any good explainer channel and you see the same rules. Follow them:

1. **Pictures carry the idea, the narration explains it.** On-screen text is only numbers,
   symbols, formulas and at most a 1–3 word label (`$15`, `112 K`, `CH₄ > CO`, `δ+ δ−`, ✓ ✗, `?`).
   Never put sentences or the narration on screen. Validation warns about wordy text.
2. **A clean board.** 1–4 big objects at a time, lots of empty space. Remove things the narration
   has moved past with `exit`, or start a new scene with `clearBefore`.
3. **Hold the picture.** Give each idea time to sink in: a scene stays up while it is being talked
   about, and finished scenes stay at least 2 s before the next wipe (validation warns). Use a slow
   `camera` push-in so long holds don't feel frozen.
4. **One consistent look.** A small palette (e.g. dark teal ink, cream board, one or two accent
   colors), flat filled shapes, the same character throughout. Draw or recolor assets to match
   instead of mixing icon styles.
5. **A recurring character** (a narrator / student) reacting to the story makes it feel produced:
   thinking at a question, pointing at an answer.
6. **Motion with meaning.** Diagrams the narration walks through are **drawn** (`enter: "draw"`,
   the default) so the eye follows; characters, symbols, badges and numbers **pop** in
   (`enter: "pop"`); transformations are a pop-out followed by a pop-in in the same spot (A
   becomes B).

## Setup check (first video of a session)

Run `node tools/check-setup.mjs`. If something is missing, tell the user what and the install
command it prints, and offer to run that install (ask first; only plain downloads such as
`npm install`, `pip install -r requirements.txt`, `winget`/`brew`/`apt`). Without the
required items the tool does not work. Details: `CLAUDE.md`.

## Workflow

1. **Prepare the transcript.** If it contains things that are not spoken (caption timestamps,
   chapter headings, speaker names), write a cleaned copy and use that.
2. **Align.** `node src/cli.js align transcript.txt [--audio narration.mp3] -o timing.json`
   With audio, sentence and clause ends are snapped to pauses detected in the recording; check
   the "snapped N/M sentence ends" line. Any language works (anchors match the transcript's own
   words, e.g. Sinhala) while on-screen symbols can be language-neutral. The aligner uses pause
   lengths (sentence ends pause longer than commas) and speaking rate to place sentences; still
   print each sentence's start time once and sanity-check that no sentence gets an implausibly
   short or long slot before anchoring visuals to it.
3. **Storyboard before any JSON.** One scene per idea (usually one per paragraph). For each scene
   write: the 1–4 objects on screen, what the viewer should *see* happen (A becomes B, X grows,
   two things compared side by side), the one or two objects in accent color, and which symbol or
   number (if any) appears.
4. **Gather the assets.** See *Getting assets*. Check the library → search online → add it, or
   draw it yourself (most diagrams and the character) → **preview it and look**.
5. **Write `scene.json`.** See *Schema*, *Layout*, *Motion*.
6. **Validate.** `node src/cli.js validate scene.json --timing timing.json --schedule`. Fix every
   error and re-run until it prints `OK`, then clear the warnings: short holds, wordy text,
   camera crops, elements wiped before they finish.
7. **Preview and look at the frames.** Pick times from `--schedule`: just *before* each next
   scene starts (the finished scene) plus moments in the middle of pop-ins and swaps.
   `node src/cli.js preview scene.json --timing timing.json --at "4,9.5,13,17,24" -o sheet.png`
   **Open the PNG and look at it** (Read the image). Check: is the board clean? Can you tell what
   is being explained without the audio? Anything cut off, tiny, crowded, or unbalanced? Fix and
   preview again.
8. **Render.** `node src/cli.js render scene.json --timing timing.json -o out.mp4`
9. **Credits.** `node src/cli.js credits scene.json` prints the attribution lines that
   CC-BY / CC-BY-SA assets require. Give them to the user with the video.

## Getting assets

```
node src/cli.js list-assets                      # whole library ([color] = has color fills)
node src/cli.js list-assets --search "chart"     # search the library by name/description/tags
node src/cli.js asset search office worker --sheet results.png
node src/cli.js asset add openmoji:man-office-worker --name office_worker \
    --description "A man in a suit holding documents; a professional or client" --tags person,business
node src/cli.js asset import my-drawing.svg --name rocket --description "A rocket taking off; launch, fast growth"
node src/cli.js asset preview office_worker rocket -o check.png
```

- **Library first.** Reuse what exists. Never invent asset names in scene.json.
- **Search online** with `asset search <words> --sheet results.png`, then **Read the sheet** and pick
  by eye. Sets: `openmoji` / `streamline-ultimate-color` (outlines + flat color, closest to drawn
  art), `fluent-emoji-flat` / `noto` / `twemoji` (color, no outlines), `tabler` / `lucide` (line
  icons). Downloaded icons rarely match a video's palette; for a polished video, draw the key
  objects yourself in one palette and use downloads only for small accents.
- **Draw it yourself** (preferred for anything central: diagrams, the character, cards, badges).
  Write any SVG, using shapes, groups and transforms as you like, then
  `asset import file.svg --name ... --force` to (re)import. Keep the source SVGs, or a script that
  writes them (see `my/q1/art/make-art.cjs`), so they can be edited and re-imported.
  - **Layers:** to build one picture up step by step, draw the base and each addition on the same
    canvas and import each with `--frame` (the viewBox, not the drawing's extent, becomes the
    asset's box). Elements of framed assets in the same `at`/`size` line up exactly and may
    overlap (see `my/q5`).
  - **Palette:** define a few constants (ink, main color, light fill, paper, 2–3 accents) and use
    only those. Dark near-neutral strokes and near-black fills take the scene's `style.stroke`.
  - **Outlines** to be drawn: `fill="none" stroke="<ink>"`. **Color areas:** `fill="#hex"`, written
    before the outlines that sit on them. Thick limbs or bold marks are filled shapes, not wide
    strokes (stroke widths are normalized).
  - **Order:** imported art is drawn in the SVG's own element order (`--order document`, the
    default for `import`), so write elements in the order a teacher would draw them.
  - **Labels inside a drawing** (atom symbols, axis numbers): `<text font-family="Arial">`.
  - **Size:** assets are scaled to fit their drawn shape into the element's box, so draw at a
    natural aspect ratio; a wide drawing fills a wide box.
  - Keep it to 5–40 paths; simple and bold reads best.
- **Always preview new assets** (`asset preview`) and look at all three columns.

## Schema

```jsonc
{
  "canvas": { "width": 1920, "height": 1080, "grid": [16, 9] },   // default grid is [12, 8]
  "style": { "stroke": "#134a52", "strokeWidth": 3.5, "background": "#f6efd8",
             "roughness": 0.4, "fontFamily": "Arial" },             // roughness 0.3–0.5 = clean
  "audio": "narration.mp3",
  "scenes": [
    { "id": "intro",
      "clearBefore": false,          // true = wipe earlier scenes when this scene's first element starts
      "background": "#eef1e4",       // optional board color while this scene is up
      "camera": { "zoom": 1.05, "focus": [8, 8] },   // optional slow push-in over the scene
      "elements": [ /* see below */ ] }
  ]
}
```

Every element: `id` (unique across all scenes), `type`, `anchor` (verbatim transcript phrase),
optional `occurrence`, `lead` (default 0.4 s: finish this long **before** the anchor),
`duration` (default 0.7 s), `enter` (`"draw"` default / `"pop"` / `"fade"`) and `exit`:

```json
"exit": { "anchor": "phrase where it should leave", "lead": 0.2, "duration": 0.3, "style": "pop" }
```

| type | fields |
|---|---|
| `asset` | `asset`, `at: [col, row]`, `size: [cols, rows]`; optional `colors` (false = line art), `flip` (mirror), `roughness` |
| `text` | `text`, `at`, `size`; optional `color`, `font`, `weight` ("bold"), `align` |
| `arrow` | `from`, `to` (ids of asset/text elements in the same scene); optional `color` |
| `image` | `src` (PNG/JPEG, resolved from the cwd or the scene file's folder), `at`, `size`; optional `panel` (white rounded card behind it). Fitted to the box keeping its aspect ratio; `draw` wipes it on left to right |

Use `image` for material the user supplies, e.g. the exam question screenshot shown at the top of
the first scene. Small screenshots look soft when enlarged; make a 2–3× Lanczos copy first
(`ffmpeg -i q.png -vf "scale=iw*3:ih*3:flags=lanczos" q@3x.png`). If the screenshot has a
watermark or stray marks, tell the user instead of editing it.

## Layout

- Use a **32×18 grid** (square 60 px cells) for precise placement; 16×9 (120 px) is fine for
  simple videos. Cells may be reused once an element has exited: validation only rejects
  overlaps while both elements are on screen.
- **Size tiers** (32×18 grid) keep a video consistent; pick from these instead of improvising:

  | role | box (cells) | on screen |
  |---|---|---|
  | hero object (the one thing a scene is about) | 10×10 – 11×14 | ≈ 600–750 px |
  | comparison pair, one per side of a divider | 12×4 (wide) or 6×5 each | ≈ 350–700 px wide |
  | table / row of five | 6 wide each, from column 1 | ≈ 350 px |
  | character bust (touches the bottom edge) | 9×9 at row 9 | ≈ 530 px |
  | cards, small icons | 4×3 | ≈ 230 px |
  | badges (δ, ✓, ✗) | 4×2 – 4×3 (badges), 4×4 (✓/✗ beside a card) | ≈ 200–230 px |
  | labels / numbers | 6×2 (≈ 70 px text); results 13×3 (≈ 110 px) | |
  | question screenshot on top | 28×4 at [2, 1] with `"panel": true` | full width |

- **Margins:** keep columns 0 and 31 empty (1 cell), rows 0 and 17 empty except for a bust.
- **Center things:** a row of items should be centered on column 16 (e.g. five 4-wide cards at
  columns 6, 10, 14, 18, 22); a two-sided comparison mirrors around a divider at columns 15–16.
- **Big objects** (4–8 cells wide). A character bust can touch the bottom edge.
- **Composition:** one focal object near the center, or two side by side for a comparison
  (left vs right), or a row of up to five for a summary. Leave margins of one cell when the scene
  has a camera; validation warns if the push-in will crop something.
- Make the character face what they present (`"flip": true` mirrors).
- Text sizes come from the box height (≤65% of it) unless the box is too narrow; give a row of
  matching labels the same height. Use `"font": "Arial"` for symbols (₂ ₄ ⁻ δ → ✓).

## Motion

- **draw** (default): outlines are traced in order, then colors wipe in. Use for the diagrams the
  narration explains. Give colored drawings 1.2–2 s; a chart that is read out bar by bar can take
  as long as the reading (e.g. 8 s).
- **pop**: grows in with a small overshoot (0.3–0.5 s). Use for characters, cards, badges, symbols,
  numbers and anything that should simply *appear*.
- **fade**: for subtle background pieces.
- **exit**: shrink away (`"style": "pop"`, default for popped elements) or fade. To show A turning
  into B, exit A and pop B into the same cells right after; validation tells you if they overlap
  in time.
- **camera**: `zoom` 1.03–1.08 over the scene's lifetime; `focus` is the cell the push moves
  toward (put it on the edge the content touches, e.g. a bottom-row cell for a character bust).
- Scenes change with a hard cut when the next `clearBefore` scene starts. Anchor a new scene's
  first element a few words *into* its paragraph so the previous scene can be seen finished.

## Anchoring

- Pick a **distinctive 3–6 word phrase** copied from the transcript. If it is ambiguous, prefer a
  longer phrase over `occurrence`.
- Prefer a phrase slightly **before** the concept is named, so the visual lands as it is heard.
- Main object first, then badges or numbers that comment on it, then arrows.
- If validation says a phrase is not found, copy one of the suggested phrases; don't paraphrase.

## Example (a question scene)

```json
{ "id": "question", "camera": { "zoom": 1.03, "focus": [6, 8] }, "elements": [
  { "id": "think", "type": "asset", "asset": "narrator_think", "at": [0, 2], "size": [5, 7],
    "enter": "pop", "anchor": "are you looking for", "duration": 0.5 },
  { "id": "c1", "type": "asset", "asset": "card_he", "at": [5, 1], "size": [2, 2],
    "enter": "pop", "anchor": "helium neon methane", "lead": 0, "duration": 0.4 },
  { "id": "thermo", "type": "asset", "asset": "thermo_high", "at": [7, 4], "size": [3, 5],
    "anchor": "highest boiling point", "lead": 0.3, "duration": 1.0 },
  { "id": "q", "type": "text", "text": "?", "at": [10, 4], "size": [3, 5], "enter": "pop",
    "color": "#f2994a", "weight": "bold", "anchor": "which one", "lead": 0, "duration": 0.4 }
]}
```

Worked videos: `my/q1_v2`, `my/q2`, `my/q3` (32×18 grid, question screenshot, size tiers), each
with its art in `art/make-art.cjs`. For exam-question videos follow the **exam-question-video**
skill (series structure and checks); shared palette and builders live in `tools/art-kit.cjs`, and
`node tools/import-art.cjs <art-dir>` imports a whole art folder.
For long topic lessons (10-20 min, narration possibly in several parts) follow the
**theory-video** skill (`my/theories/Titration`): chapters with a tracker, anchors by sentence
number from a generator script, and `node tools/align-parts.mjs <dir>` for multi-part audio.
