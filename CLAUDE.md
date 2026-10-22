# Whiteboard animation videos

Makes animated explainer videos from a script and its narration audio. Skills in
`.claude/skills/` (exam-question-video, theory-video, whiteboard-animation) and the agent in
`.claude/agents/` hold the workflows. Code: `src/` (renderer + CLI), `tools/` (shared helpers).
`my/` (videos) is local only; `assets/` is the shared drawing library (in git).

## Before the first video of a session: check the setup

Run `node tools/check-setup.mjs`. If it reports anything missing:

1. **Tell the user** what is missing, why it is needed, and the exact install command it prints.
   Without the required items (Node 20+, ffmpeg/ffprobe, `npm install`) the tool does not work.
2. **Offer to install it** when it is a plain download you can run here (`npm install`, the
   `.venv-align` + `pip install -r requirements.txt`, `winget`/`brew`/`apt` for ffmpeg).
   **Ask first** and run it only after the user agrees; system installs may need their
   permission or an admin prompt.
3. Otherwise ask the user to install it manually, then run the check again.

The optional exact-timing environment (`.venv-align`) can be skipped: fall back to
`node src/cli.js align` (pause-based timing) and say that timing will be less exact.

## Rules

- Never edit the user's `script.txt`, narration audio or screenshot.
- Put reusable code in `tools/` or `src/`, never under `my/`.
