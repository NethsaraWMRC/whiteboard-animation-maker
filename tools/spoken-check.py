"""Does the narration really say the script? Lists the places where it does not.

    .venv-align/Scripts/python tools/spoken-check.py my/theories/Titration

Run after `node tools/align-parts.mjs <dir> --mms`. For every part it reads align/pN.mms.json (MMS
word times with a match score per word) and reports each run of weakly matched words: the
script words there and what the model hears in that stretch of audio (romanized). A TTS run can
drop or splice sentences; a run of weak words is where the audio and the text disagree.
Write the gaps you confirm into <dir>/audio-gaps.json, then run tools/spoken-transcript.mjs and
align again: a clean result has no runs left.
"""
import glob
import importlib.util
import json
import os
import re
import sys

import torch
import torchaudio

HERE = os.path.dirname(os.path.abspath(__file__))
spec = importlib.util.spec_from_file_location('am', os.path.join(HERE, 'align-mms.py'))
am = importlib.util.module_from_spec(spec)
spec.loader.exec_module(am)


def main(d, weak=0.3, min_run=2):
    bundle = torchaudio.pipelines.MMS_FA
    model = bundle.get_model(with_star=False)
    model.eval()
    labels = bundle.get_labels(star=None)
    parts = sorted(glob.glob(os.path.join(d, 'align', 'p*.mms.json')), key=lambda p: int(re.search(r'p(\d+)\.mms', p).group(1)))
    audio = sorted(glob.glob(os.path.join(d, 'narration-p*.mp3')), key=lambda p: int(re.search(r'p(\d+)\.mp3', p).group(1))) or [os.path.join(d, 'narration.mp3')]
    total = 0
    for pj, au in zip(parts, audio):
        words = json.load(open(pj, encoding='utf-8'))['words']
        runs, cur = [], []
        for i, w in enumerate(words):
            if w['score'] < weak:
                cur.append(i)
            else:
                if len(cur) >= min_run:
                    runs.append(cur)
                cur = []
        if len(cur) >= min_run:
            runs.append(cur)
        print(f'{os.path.basename(au)}: {len(runs)} stretch(es) where audio and text disagree')
        if not runs:
            continue
        wav = am.load_audio(au)
        for r in runs:
            a = max(0.0, words[r[0]]['start'] - 1.0)
            b = words[r[-1]]['end'] + 1.0
            with torch.inference_mode():
                em, _ = model(wav[int(a * am.SR):int(b * am.SR)].unsqueeze(0))
            out, prev = [], None
            for k in em[0].argmax(-1).tolist():
                if k != prev and k != 0:
                    out.append(labels[k])
                prev = k
            print(f'  {int(a // 60)}:{a % 60:04.1f}-{int(b // 60)}:{b % 60:04.1f} ({len(r)} weak words)')
            print(f'    script: {" ".join(words[i]["word"] for i in r)}')
            print(f'    heard:  {"".join(out)}')
            total += 1
    print('OK: the narration says the transcript' if total == 0 else f'{total} stretch(es) to check')


if __name__ == '__main__':
    if len(sys.argv) != 2:
        sys.exit(__doc__)
    main(sys.argv[1])
