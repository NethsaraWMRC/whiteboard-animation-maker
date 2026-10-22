# Whiteboard Animation

Give Claude a **script** and its **narration audio**. It makes an animated whiteboard
explainer video, with every picture timed to the spoken words.

## 1. You need

- [Node.js](https://nodejs.org) 20 or newer
- [ffmpeg](https://ffmpeg.org) on your PATH (check: `ffmpeg -version`)
- [Claude Code](https://claude.com/claude-code): `npm install -g @anthropic-ai/claude-code`
- Python 3.12 *(optional, for exact word timing)*

## 2. Set up

```
git clone <this-repo-url>
cd whiteboard-animation
npm install
```

Optional, exact word timing (recommended for long or Sinhala narrations):

```
py -3.12 -m venv .venv-align
.venv-align\Scripts\pip install -r requirements.txt
```

The first run downloads the alignment model (about 1 GB).

## 3. Make a video

1. Put your files in a folder under `my/`:
   ```
   my/q12/
     q12.png         question screenshot (exam videos only)
     script.txt      narration text, paragraphs separated by blank lines
     narration.mp3   the recorded narration of exactly that script
   ```
2. Open Claude in the project folder: `claude`
3. Ask for the video, for example:
   ```
   make the video for my/q12
   ```

Claude writes `my/q12/q12.mp4` and reports what each scene shows.

## Skills and agent

Claude picks these automatically. You can also name them in your prompt.

| Name | Use it for | Example prompt |
|---|---|---|
| `exam-question-video` (skill) | One exam question: screenshot + script + audio | `make the video for my/q12` |
| `theory-video` (skill) | A 10–20 min lesson, audio in parts (`narration-p1.mp3`, `-p2`, ...) | `make the theory video for my/theories/Titration` |
| `whiteboard-animation` (skill) | Any other explainer from a transcript (+ audio). Also the tool reference the other two use | `make a whiteboard animation from my/talk/script.txt and narration.mp3` |
| `exam-video-maker` (agent) | Hands a whole question video to a background agent | `use the exam-video-maker agent for my/q12` |

They live in `.claude/skills/` and `.claude/agents/`.

## Good to know

- `my/` (your videos) and `assets/` (the drawing library) stay on your computer and are not in
  git. A fresh clone starts with an empty library; Claude draws the pictures it needs
  (narrator, badges, ...) during the first video and reuses them after that.
- Manual use without Claude: `node src/cli.js --help` (`align`, `validate`, `preview`, `render`).
- Code: `src/` is the renderer and CLI, `tools/` holds the shared helpers (drawing kit, word
  timing).
