"""Forced alignment of a narration against its script with Meta's MMS model (torchaudio MMS_FA).

    .venv-align/Scripts/python tools/align-mms.py transcript.txt narration.mp3 timing.json

Unlike the pause-based estimate in src/align.js, this listens to the audio: every word gets the
time it is actually spoken. Works for any script uroman can romanize (Sinhala included).

How:
  1. ffmpeg -> 16 kHz mono; MMS emissions (20 ms frames) computed in overlapping 30 s chunks.
  2. The whole romanized script is force-aligned (CTC) to the emissions in one pass, so every
     word is placed where it is spoken and no error can carry over from one sentence to the next.
     (The CPU aligner keeps one byte per frame x token: ~0.7 GB for a 10-minute part.)
  3. Writes { duration, words: [{ word, start, end }], method } like `whiteboard align`, plus a
     per-word alignment score (`score`, 0..1) for checking.
"""
import json
import os
import re
import subprocess
import sys

import numpy as np
import soundfile as sf
import torch
import torchaudio
import uroman as ur

SR = 16000
FRAME = 0.02  # MMS frame period (s)


def load_audio(path):
    tmp = path + '.16k.wav'
    subprocess.run(['ffmpeg', '-y', '-loglevel', 'error', '-i', path, '-ac', '1', '-ar', str(SR), tmp], check=True)
    wav, sr = sf.read(tmp, dtype='float32')
    os.remove(tmp)
    assert sr == SR
    return torch.from_numpy(wav)


def emissions(model, wav, chunk=30.0, ctx=2.0):
    """Log-prob emissions for the whole file, computed in chunks with context on both sides."""
    n = wav.shape[0]
    total_frames = int(n / SR / FRAME)
    out = []
    t = 0.0
    with torch.inference_mode():
        while t * SR < n:
            a = max(0.0, t - ctx)
            b = min(n / SR, t + chunk + ctx)
            seg = wav[int(a * SR):int(b * SR)].unsqueeze(0)
            em, _ = model(seg)
            em = em[0]
            f0 = int(round((t - a) / FRAME))
            f1 = f0 + int(round(min(chunk, n / SR - t) / FRAME))
            out.append(em[f0:min(f1, em.shape[0])])
            t += chunk
    em = torch.cat(out)
    return em[:total_frames] if em.shape[0] >= total_frames else em


def norm_word(roman):
    return re.sub(r"[^a-z']", '', roman.lower())


def main(text_path, audio_path, out_path):
    torch.set_num_threads(os.cpu_count() or 4)
    bundle = torchaudio.pipelines.MMS_FA
    model = bundle.get_model(with_star=False)
    model.eval()
    dictionary = bundle.get_dict(star=None)
    labels = bundle.get_labels(star=None)
    uro = ur.Uroman()

    text = open(text_path, encoding='utf-8').read()
    words = text.split()
    toks = [[dictionary[c] for c in norm_word(uro.romanize_string(w)) if c in dictionary] for w in words]

    wav = load_audio(audio_path)
    duration = wav.shape[0] / SR
    print(f'audio {duration:.1f}s, {len(words)} words; computing emissions...', flush=True)
    em = emissions(model, wav)
    greedy = []
    prev = None
    for i in em[: int(15 / FRAME)].argmax(-1).tolist():
        if i != prev and i != 0:
            greedy.append(labels[i])
        prev = i
    print('model hears (first 15 s):', ''.join(greedy)[:160], flush=True)

    # One forced alignment over the whole part: every word is placed where it is spoken.
    seq = [t for tw in toks for t in tw]
    print(f'aligning {len(seq)} tokens over {em.shape[0]} frames...', flush=True)
    ali, scores = torchaudio.functional.forced_align(em.unsqueeze(0), torch.tensor([seq], dtype=torch.int32), blank=0)
    spans = torchaudio.functional.merge_tokens(ali[0], scores[0].exp())
    if len(spans) != len(seq):
        raise RuntimeError(f'got {len(spans)} token spans for {len(seq)} tokens')
    result = []
    i = 0
    for w, tw in zip(words, toks):
        if not tw:  # nothing pronounceable (should not happen): borrow the previous word's end
            t0 = result[-1]['end'] if result else 0.0
            result.append({'word': w, 'start': t0, 'end': t0, 'score': 0.0})
            continue
        s = spans[i:i + len(tw)]
        i += len(tw)
        result.append({
            'word': w,
            'start': round(s[0].start * FRAME, 3),
            'end': round(s[-1].end * FRAME, 3),
            'score': round(float(np.mean([sp.score for sp in s])), 3),
        })
    low = [r for r in result if r['score'] < 0.2]
    print(f'mean word score {np.mean([r["score"] for r in result]):.2f}; {len(low)} words below 0.2', flush=True)

    out = {'duration': round(duration, 3), 'words': result, 'method': 'mms forced alignment'}
    with open(out_path, 'w', encoding='utf-8') as fh:
        json.dump(out, fh, ensure_ascii=False, indent=2)
        fh.write('\n')
    print(f'wrote {out_path}: {len(result)} words')


def hear(audio_path, seconds=20.0):
    """Romanized greedy transcript of the first `seconds` of the audio (what the model hears)."""
    bundle = torchaudio.pipelines.MMS_FA
    model = bundle.get_model(with_star=False)
    model.eval()
    labels = bundle.get_labels(star=None)
    wav = load_audio(audio_path)[: int(seconds * SR)]
    with torch.inference_mode():
        em, _ = model(wav.unsqueeze(0))
    out, prev = [], None
    for i in em[0].argmax(-1).tolist():
        if i != prev and i != 0:
            out.append(labels[i])
        prev = i
    return ''.join(out)


def pick(text_path, audio_path, candidates):
    """Which paragraph (0-based, from `candidates`) does this audio part start with?"""
    import difflib
    uro = ur.Uroman()
    paras = [p for p in re.split(r'\n\s*\n', open(text_path, encoding='utf-8').read()) if p.strip()]
    heard = hear(audio_path)
    best = None
    for c in candidates:
        text = ''.join(norm_word(uro.romanize_string(w)) for w in ' '.join(paras[c:]).split())[: len(heard)]
        r = difflib.SequenceMatcher(None, heard, text).ratio()
        print(f'  paragraph {c + 1}: match {r:.2f}  "{paras[c][:40]}"', file=sys.stderr)
        if best is None or r > best[1]:
            best = (c, r)
    print(best[0])


if __name__ == '__main__':
    if len(sys.argv) == 5 and sys.argv[1] == '--pick':
        pick(sys.argv[2], sys.argv[3], [int(x) for x in sys.argv[4].split(',')])
    elif len(sys.argv) == 4:
        main(*sys.argv[1:])
    else:
        sys.exit(__doc__ + '\n    or: align-mms.py --pick transcript.txt part.mp3 i,j,k  (best start paragraph)')
