---
name: theory-video
description: Make a long animated lesson video (10-20 minutes) that teaches a whole topic (e.g. titration) from a folder with script.txt and one or more narration parts (narration-p1.mp3, narration-p2.mp3, ...), in the same look as the exam-question series. Use when the user adds a folder under my/theories/ and asks for its video, or asks to redo one.
---

# Theory lesson videos (long form)

A theory video teaches a full topic, not one question: many concepts, worked examples and a
recap, 10-20 minutes long. It uses the same palette, character and motion rules as the
exam-question series. Load **whiteboard-animation** for the CLI/schema and read
**exam-question-video** for the shared look; this skill covers what is different.
Finished example: `my/theories/Titration` (15.5 min, 11 chapters, 48 scenes, 361 drawings).

## Inputs and outputs

`my/theories/<Topic>/` contains `script.txt` (Sinhala, paragraphs separated by blank lines) and
`narration.mp3`, or several parts `narration-p1.mp3`, `narration-p2.mp3`, ... recorded for the
one script. Never modify them. You produce in the same folder: `narration.mp3` (joined, if the
audio came in parts), `transcript.txt`, `timing.json`, `sentences.txt`, `art/` (builders +
SVGs), `gen-scene.cjs`, `scene.json`, `schedule.txt`, `sheet*.png` and **`<Topic>.mp4`**.

## Setup check (first video of a session)

Run `node tools/check-setup.mjs`. If something is missing, tell the user what and the install
command it prints, and offer to run that install (ask first; only plain downloads such as
`npm install`, `pip install -r requirements.txt`, `winget`/`brew`/`apt`). Without the
required items the tool does not work. Details: `CLAUDE.md`.

## Step 1: audio, exact timing, and does the audio say the script?

The pause-based estimate (`src/cli.js align`) only guesses where sentences are; on a 15-minute
narration it drifted by up to 28 s. Always use the **MMS forced aligner**, which listens to the
audio and places every word (one-time setup: `python -m venv .venv-align`, then
`pip install torch torchaudio --index-url https://download.pytorch.org/whl/cpu` and
`pip install uroman soundfile rapidfuzz`; the model, ~1.2 GB, is cached in
`.venv-align/torch-cache`).

1. `node tools/align-parts.mjs my/theories/<Topic> --mms`: joins narration-p1/p2/... into
   `narration.mp3` (0.8 s between parts; a single `narration.mp3` also works), finds the
   paragraph each part starts with **by listening** (text length guessed one paragraph wrong on
   Titration), and writes `timing.json` with exact word times (~9 min for 15 min of audio).
2. `.venv-align/Scripts/python tools/spoken-check.py my/theories/<Topic>`: **the recording may not
   say everything in script.txt.** The Titration TTS dropped four stretches (sentences 41-52,
   88-98, 133-142, 213-220) and spliced the rest together, so pictures showed topics the voice
   never mentioned. The check prints each stretch where audio and text disagree, with the
   script words and what the model heard there. Confirm each one (decode a few seconds around
   it: the "heard" text is romanized Sinhala, easy to read against uroman's spelling of the
   script), write it into `audio-gaps.json` (`{ "sentences": [from, to] }` or
   `{ "sentence": n, "keepWords": k }`), run `node tools/spoken-transcript.mjs <dir>` (writes the
   spoken `transcript.txt` and `spoken-map.json`) and repeat 1-2 until the check prints OK.
3. Write `narration-sentences.txt` (start-end, script sentence number, text for every spoken
   sentence); a good alignment has ~all sentence ends inside real pauses (Titration: 208/210).
4. Tell the user which script sentences are not in the audio and what the gap does to the
   lesson (a missing answer, a misleading sentence), so they can re-record those parts.

## Step 2: fact check

Solve every worked example and check every number in the script (indicator ranges, pH values,
ratios, molar masses). Follow the script; report disagreements with numbers. Compute curves
from real chemistry where possible (the Titration art has a charge-balance pH solver), so the
on-screen shapes are right: half-equivalence pH = pKa, equivalence pH ~8.7 / ~5.3, etc.

## Step 3: chapters and storyboard

1. Split the script into **chapters** (5-12) by topic. Every scene carries a **chapter
   tracker** strip in row 0 (`[1, 0]` size `[30, 1]`, faded in): done chapters filled, the
   current one an orange pill with its name, later ones outlined numbers. Each chapter opens
   with a **chapter title card** in the middle (`[7, 7]` size `[18, 4]`) that pops on the
   chapter's first sentence and exits (lead ≈0.7 s) before the content arrives.
2. One scene per paragraph (merge two short ones or split a long worked example), 10-30 s
   each. Write the storyboard as a list before code: objects, what appears on which sentence,
   where it sits.
3. Recurring pictures build trust: draw the lab setup (stand, burette, flask, tile) once as
   framed layers and reuse it in every scene that needs it, with liquid layers in different
   colours; keep one chart canvas for every curve so they line up scene to scene.
4. Worked examples: a "question" scene (given values as small cards, the setup with labels,
   an orange `= ?`) followed by "answer" scenes of numbered step cards (`L.stepCards`, same
   width inside one example, last step orange). Show every arithmetic step the narration says.
5. Analogies the script uses (pens and pupils, wallet and shop) get their own simple
   drawing, and a mapping pill (`pen ↔ known`) when it helps a beginner connect it.
6. End with a recap: the common mistakes as rows, then a summary flow built piece by piece and
   the pointing narrator.

## Step 4: art at scale

- Keep builders in `art/lib.cjs` (palette extras, pills sized to their text, eqPill,
  equilibrium cards, setup layers, chart + bands, step cards, tracker, chapter cards) and the
  pictures in chapter files (`art/ch1-3.cjs`, ...), merged by `art/make-art.cjs`. Name every
  asset with a topic prefix (`tt_`).
- Solution colours (purple permanganate, pink phenolphthalein, brown iodine ...) are content
  and may go beyond the palette; everything else stays in `K.C`.
- Text on screen: formulas, numbers and ≤3-word labels in English (Sinhala does not render
  inside SVG art). Use `sub()` / a `sup()` tspan for every sub/superscript and charge.
- Overlays that sit on a curve (indicator bands) must redraw the curve and anything they would
  hide (orange steep part, equivalence dot) on top, and stop where they would cover brackets.
- Captioned objects: keep the caption close to the drawing (no empty band in the canvas), and
  size canvases so text lands at ≥30 px on the 1080p frame.

## Step 5: gen-scene.cjs (anchors by sentence number)

Write scenes in `gen-scene.cjs`, never by hand in scene.json:
- `at(n, 'word')` = the first word of **script** sentence `n` that begins with `word`, looked up in
  the spoken transcript through spoken-map.json; it returns null when that word is not spoken,
  and helpers, scenes (and whole scenes) built on unspoken sentences drop out by themselves.
  Anchor phrases are copied from timing.json, with `occurrence` computed whenever the phrase
  repeats (the validator requires it even for the first one).
- Helpers: `A` (pop), `D` (draw), `trk(ch, a)`, `chap(ch, a, exitA)`, `setup(cell, size,
  parts)`, `layers(prefix, cell, size, parts)`, `exitAt(a, lead)`.
- **Pictures start on their word, never before it.** The renderer's anchor means "finish by
  this word", which makes every draw begin 0.5-2.5 s early; over a long video viewers hear
  the pictures running ahead of the voice (reported on the first Titration render). So `A()`
  stores the intended word and places the element on the first later word that starts after
  the draw has finished, with the gap as lead. `lead` in the helpers only staggers a row.
  `SYNC=1 node gen-scene.cjs` prints how late each element starts after its word (expect
  min 0.00, median ≈0).
- A **hold pass** at the end: for each scene change, if the previous scene finished less than
  2 s before the wipe, it starts the next scene's early elements later (≤ 0.8 s), then shortens
  the previous scene's last draws (never starts them earlier), and prints what is left. Where
  the recording runs two topics together (a spliced gap) a hold under 2 s is accepted: sync
  matters more. A delayed chapter card may need its exit anchored a word or two later.
- Check content, not just time: list the sentences spoken during each scene (from
  narration-sentences.txt and schedule.txt) and read that every scene shows what is said.
- Then `validate --schedule > schedule.txt` must print `OK` with no warnings.

## Step 6: preview, render, check

- Preview every scene's finished state (next scene start − 0.3 s) in sheets of 12 and read
  them all; then re-preview what you changed.
- Render in the background: about 0.5× real time on this machine with 48 scenes
  (15.5 min of video took ~35 min). Then check durations (`ffprobe`), a frame tile of the real
  video (one frame per minute), and `credits`.

## Aligner notes

`tools/align-mms.py` (used by align-parts --mms) does CTC forced alignment of the romanized
(uroman) transcript against MMS emissions computed in 30 s chunks, in one pass per part (the
CPU aligner keeps one byte per frame x token, ~0.7 GB for 10 minutes). Do not use the MMS star
token as a wildcard: its emission is log-prob 0 and it swallows whole paragraphs.
`align-mms.py --pick transcript part.mp3 i,j,k` picks the paragraph an audio part starts with.

The pause-based estimate in src/align.js (fallback without the venv) was tuned on Titration:
- word weight = letters minus viramas (`wordWeight`), not code points;
- the reference speaking rate excludes pause time;
- `RATE_WEIGHT` 6, `KIND_MISMATCH` 0.3, `SKIP_SENTENCE` 4: speaking rate matters more than pause
  length, because narrators breathe mid-sentence (0.5 s) and run short sentences together
  (0.26 s);
- the snap window grows with the audio (`MAX_SNAP_FRAC`).
