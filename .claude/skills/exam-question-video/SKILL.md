---
name: exam-question-video
description: Make a professional animated explainer video for one exam question (A/L chemistry style series) from a folder containing the question screenshot, the narration script and the narration audio, following the series' fixed structure and look. Use when the user adds a question folder such as my/q4 (q*.png + script.txt + narration.mp3) and asks for its video, or asks to redo one.
---

# Exam-question explainer videos (series guideline)

Every video in this series has the same structure, look and quality bar. This skill is the
series-specific layer on top of the general **whiteboard-animation** skill: load that one too for
the CLI, schema and motion reference. Finished examples to copy from: `my/q1_v2`, `my/q2`,
`my/q3`, `my/q4` (calculation with a full derivation), `my/q5` (layered build for beginners)
(each has `scene.json`, `timing.json`, `art/make-art.cjs`).

## Inputs and outputs

A question folder `my/<id>/` contains:
- `<id>.png`: the exam question screenshot (Sinhala text is fine, it is shown as an image)
- `script.txt`: the narration script (Sinhala); paragraphs separated by blank lines
- `narration.mp3`: the recorded narration of exactly that script

You produce, in the same folder: `transcript.txt`, `timing.json`, `<id>@2x.png` (or `@3x`),
`art/make-art.cjs` + its SVGs, `scene.json`, `sheet.png` (last preview) and **`<id>.mp4`**.
Never modify the user's `script.txt`, `narration.mp3` or screenshot. If a redo is requested,
build it in a new folder (e.g. `my/q1_v2`) so the previous version stays intact.

## Setup check (first video of a session)

Run `node tools/check-setup.mjs`. If something is missing, tell the user what and the install
command it prints, and offer to run that install (ask first; only plain downloads such as
`npm install`, `pip install -r requirements.txt`, `winget`/`brew`/`apt`). Without the
required items the tool does not work. Details: `CLAUDE.md`.

## Step 0: understand and check the question

1. Read the screenshot and the script. Solve the question yourself.
2. If the script's answer or a fact in it disagrees with established data, **follow the script**
   (it is the user's lesson) but tell the user clearly in the final report, with the numbers.
   Never put on screen a number that contradicts the narration.
3. Note any watermark or stray marks in the screenshot. Do not remove them; mention them.

## Step 1: timing

```
cp my/<id>/script.txt my/<id>/transcript.txt
node src/cli.js align my/<id>/transcript.txt --audio my/<id>/narration.mp3 -o my/<id>/timing.json
```
- Better (exact word times, and a check that the audio really says the script): `node
  tools/align-parts.mjs my/<id> --mms` then `.venv-align/Scripts/python tools/spoken-check.py my/<id>`
  (see the theory-video skill, Step 1). A TTS narration can drop sentences.
- With the pause-based aligner, expect "snapped N/N sentence ends". Print each sentence with its start time (see
  `my/q3` history: a short node one-liner over `timing.json`) and keep the list open while
  anchoring.
- Sanity-check: no sentence gets an implausible slot (e.g. six words in one second); every long
  pause (≥0.55 s) should be a sentence end. If not, fix the aligner, not timing.json by hand.

## Step 2: question image

`ffmpeg -i my/<id>/<id>.png -vf "scale=iw*2:ih*2:flags=lanczos" my/<id>/<id>@2x.png`
(use 3× when the screenshot is narrower than ~700 px).

## Step 3: storyboard (fixed series structure)

Write the plan as a numbered list before any JSON: one scene per script paragraph.

1. **Question scene** (always first, shows the screenshot for the first ~10 s):
   - screenshot on top: `image` at `[2, 1]`, size `[28, 4]` for one-line questions or up to
     `[28, 9]` for questions with diagrams, `"panel": true`, `enter: draw`, anchored on the
     second or third spoken word with `lead` 0 and `duration` 0.6
   - `narrator_think` bust at `[3, 9]` size `[9, 9]`, popping with the screenshot
   - the question's key items as cards or pills popping as they are read (option cards
     centered on column 16, e.g. five 4-wide cards at columns 6, 10, 14, 18, 22), and an orange
     `?` (or `= ?`) when the question itself is asked
2. **Concept scenes** (one per explanatory paragraph): one hero drawing (10×10 – 12×14 cells)
   plus 1–3 supporting items (tiles, badges, a rule written as symbols). Use an everyday analogy
   when the script has one (building floors, bus seats). Comparisons mirror around a `divider`
   at columns 15–16.
3. **Application scenes**: apply the concept to each case or option: a row or table of up to
   five items with verdict badges (✓ / ✗ / rule pills) popping as each is discussed, and a large
   orange result (`= 2`, `CO > N₂`).
4. **Answer scene** (always last): `narrator_point` at `[1, 9]` size `[9, 9]`; the answer card
   (option number + value) about `[12, 3..8]` size `[7..8, 5..6]` with `badge_check` beside
   it; the "remember" takeaway as 2–3 symbols or pills in the bottom rows (`e⁻ → δ±`,
   `n = 3 + n = 4`). An equation the narrator reads (`2 + 3 = 5`) pops piece by piece on top.

## Step 4: art (one palette for the whole series)

- Reuse the library first (`node src/cli.js list-assets`): `narrator_think`, `narrator_point`,
  `badge_check`, `badge_cross`, `badge_polar`, `badge_nonpolar`, `arrow_up`, `arrow_down`,
  `divider`, cards, pills, orbitals, tiles, molecules from earlier questions.
- Draw what is missing in `my/<id>/art/make-art.cjs`, built on the shared kit:
  ```js
  const K = require('whiteboard-poc/art-kit');           // palette C, T(), sub(), svg(), card(), pill(), orbital()
  K.writeArt(__dirname, { my_asset: [svgString, 'what it shows; when to use it', 'tags'] });
  ```
  then `node my/<id>/art/make-art.cjs && node tools/import-art.cjs my/<id>/art`.
- Palette only (`K.C`): INK outlines and labels, TEAL main, ORANGE "look here", RED wrong,
  GREEN right, PALE light fills, PAPER cards. Name question-specific assets with the question id
  (`card_q3_opt4`, `q2_opt1`); give reusable ones generic names (`tile_p`, `shells`).
- Subscripts and special labels (mₗ, n−1) go **inside art** using `sub()`; plain text elements
  cannot do subscripts reliably. Formulas with Unicode digits (CH₄, N₂, e⁻) are fine in text.
- Preview every new asset (`asset preview ... -o file.png`) and look at it before use.

### Layered builds for beginners (one drawing that grows)

The audience includes complete beginners: build **one** main picture slowly instead of showing
many items. Example: `my/q5` (a molecule drawn as carbon balls, then each group, then a ring
around the main group, then carbon numbers one by one, then the name assembled piece by piece).
- Draw the base picture and every overlay on the **same SVG canvas** (same viewBox), and pass
  `{ frame: true }` as the 4th item in `writeArt` (imports with `--frame`). Placed in the
  **same cells**, the layers line up exactly; the validator allows framed assets in identical
  cells to overlap.
- Typical layers: the bare structure (draw, 1.5–2.5 s), each part (draw 0.5–0.8 s), highlight
  rings in ORANGE, numbers/badges (pop one by one, 0.3 s apart via decreasing `lead`), labels.
- One new thing per spoken phrase; at most ~8 layers plus 2–3 side items per scene; keep
  each part's color fixed through the video (e.g. OH orange, NH₂ blue, Cl green) and reuse that
  color for its numbers and its piece of the name.
- Long results (a name, an equation) build from framed pieces on one strip canvas so each piece
  pops in place as it is spoken.
- Comparisons of two options: the same drawing twice, stacked (rows 1–9 and 10–18), with the
  result of each on the right and ✗ / ✓ beside it.

### Calculations and derivations (show every step)

The narration often summarizes a calculation ("substitute and simplify"); the screen must still
show **every algebra step** so a student can follow it without the audio. Example: `my/q4`.
- One equation per step, written with `K.layout` tokens: text runs, `{ f: [num, den] }`
  fractions, `{ p: tokens, sup: '2' }` brackets with a power, `{ t, color, cancel }`; use ² ³ for
  powers and `sub()` for subscripts (KE${sub('X')}). `∝` is drawn as a path automatically.
- Put each step on `K.eqCard(tokens, { w, h, size, step: n })`. Give all cards of one derivation
  the **same** `w` (`K.eqCardWidth(listOfSteps, { step: 1 })`) and `h`, and the **same cell box
  height** in scene.json: the steps then render at one scale and line up as a numbered column.
- Highlight what changed in each step in ORANGE (the substituted term, the factor that cancels);
  show a cancellation as its own small red note (`m/m² = 1/m`) next to the step.
- The final relation goes in an accent card (`accent: C.ORANGE`) with an orange `arrow` from the
  last step; its consequence as symbols (`mλ² ↑ → KE ↓`).
- Numeric substitution: one row per value, then the expression, then each simplification on its
  own line under the `=` (`mλ² = 3 × 1²`, `= 3 × 1`, `= 3`), the result in orange. Ratios: show
  `1/3 : 1/9`, then `× 9` on both sides, then `= 3 : 1`.
- Step cards each draw on (`enter: draw`, 1.0–1.4 s) at the word where that step is spoken; five
  3-row cards fill a column (rows 1, 4, 7, 10, 13).

## Step 5: scene.json rules

- Style (copy exactly): `{"stroke":"#134a52","strokeWidth":3.5,"background":"#f6efd8","roughness":0.4,"fontFamily":"Arial"}`,
  canvas grid `[32, 18]`, `"audio": "narration.mp3"`, every scene after the first has
  `"clearBefore": true`; alternate `"background": "#eef1e4"` on every other scene.
- Text: only formulas, numbers, symbols and labels of at most three words. No sentences.
- Sizes: follow the size tiers in the whiteboard-animation skill. Additionally in this series:
  subshell/option tiles 3–4 cells, pills 6–8×3, result numbers 5–6 × 4–5, l-values and small
  labels 3–6 × 2. Labels in a row share the same box height.
- Motion: pop for characters, cards, pills, badges, numbers; draw for hero diagrams; A→B swaps
  are `exit` + pop in the same cells; list items pop one by one on successive words (or the same
  anchor with decreasing `lead`). Camera push (zoom 1.03–1.04) only on concept scenes, never on
  the question scene.
- Anchors: copy phrases verbatim from `transcript.txt`. Repeated sentences (the script often
  repeats "ඒ කියන්නේ එස්, පී, ...") need `occurrence` or a longer phrase. Avoid anchoring on the
  very first word (clamps at t = 0).

## Step 6: validate, preview, render

1. `node src/cli.js validate my/<id>/scene.json --timing my/<id>/timing.json --schedule` must
   print `OK` with **no warnings** (holds ≥ 2 s, no crops, no wordy text, no early wipes).
2. Preview the finished state of every scene: times just *before* each next scene's start from
   `--schedule`, plus one or two mid-animation moments; **Read the sheet** and check balance,
   sizes, overlaps, empty or crowded areas. Fix and repeat.
3. Render in the background (≈5 min for 2 min of video):
   `node src/cli.js render my/<id>/scene.json --timing my/<id>/timing.json -o my/<id>/<id>.mp4`
   The render is encoded in 60 s chunks in `<id>.mp4.parts/`; if it is interrupted (power
   loss, crash), run the same command again and it resumes from the last finished chunk
   (chunks are reused only while scene/timing are unchanged).
4. Check the result: video and audio durations match (`ffprobe`), and a frame tile of the
   real video (`ffmpeg -i <id>.mp4 -vf "fps=1/9,scale=480:-1,tile=4x4" -frames:v 1 tile.png`)
   looks right.
5. `node src/cli.js credits my/<id>/scene.json` for any third-party assets.

## Final report to the user

A short summary: the output path and length; a table of scenes with start times and what is
shown; new art drawn; anything fixed in the tool; notes the user must know (answer/fact
concerns with numbers, watermarks, credits). Keep it scannable.

## Pitfalls already met in this series

- Preview frames taken *after* a scene wipe look empty; use times before the next scene's start.
- Swapping two drawings in the same cells needs the first `exit` to finish before the second
  starts; the validator reports the overlap window, adjust `exit.lead`.
- Rule/title text in a big box becomes huge; keep titles at 2–3 rows tall.
- Bold Arial lacks most Unicode subscripts (ₗ) and `∝`; a run containing them falls back to a
  thin font. Use `sub()` inside art; `K.layout` draws `∝` itself.
- Assets fit their content box, so cards of different widths or heights render at different
  text sizes; equal card sizes (`eqCardWidth`) keep a derivation at one scale.
- An `arrow` must start after both endpoints have appeared; anchor it a few words after the
  later one.
- Escape `<`, `>` and `&` in art text (`&lt;`, `&gt;`, `&amp;`), or the SVG fails to import.
- An element finishes drawing at its anchor word (minus `lead`), so a slow 2 s draw starts 2 s
  before the word; check scene starts in `--schedule`.
- The narrator's pause lengths separate sentences (≈0.6–0.8 s) from commas (≈0.3–0.5 s); the
  aligner relies on that, so check sentence starts after every new narration.
