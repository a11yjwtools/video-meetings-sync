#!/usr/bin/env python3
"""
Generate synthetic test media so the whole pipeline can be tested offline:

  fixtures/song_a.wav, song_a_ad.wav   AD version has a 4 s pause inserted at 25 s
  fixtures/song_b.wav, song_b_ad.wav   AD version has identical timing
  fixtures/manifest.json
"""
import json
import os
import subprocess

import numpy as np

SR = 48000
HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(HERE, "fixtures")


def song(seed, seconds=60):
    rng = np.random.default_rng(seed)
    x = np.zeros(SR * seconds)
    t = 0.0
    while t < seconds - 1:
        dur = rng.choice([0.25, 0.5, 0.75, 1.0])
        for _ in range(rng.integers(1, 4)):  # chords
            f0 = 110 * 2 ** (rng.integers(0, 36) / 12)
            n = int(dur * SR)
            tt = np.arange(n) / SR
            env = np.exp(-3 * tt) * np.minimum(1, tt * 200)
            note = sum(np.sin(2 * np.pi * f0 * k * tt) / k for k in range(1, 6))
            i = int(t * SR)
            x[i:i + n] += 0.15 * env * note[: len(x) - i]
        t += dur
    return x / np.max(np.abs(x)) * 0.8


def narration(seed, seconds):
    """Speech-ish noise: band-limited bursts."""
    rng = np.random.default_rng(seed)
    n = int(seconds * SR)
    noise = rng.normal(0, 1, n)
    spec = np.fft.rfft(noise)
    f = np.fft.rfftfreq(n, 1 / SR)
    spec[(f < 200) | (f > 3000)] = 0
    s = np.fft.irfft(spec, n)
    syll = (np.sin(2 * np.pi * 4 * np.arange(n) / SR) > 0).astype(float)
    return 0.3 * s / np.max(np.abs(s)) * syll


def speech(seed, seconds):
    """Voice-like sound: pitched harmonics shaped by moving formants, with pauses."""
    rng = np.random.default_rng(seed)
    x = np.zeros(int(seconds * SR))
    t = 0.0
    while t < seconds - 0.5:
        for _ in range(rng.integers(2, 6)):  # syllables in a word
            dur = rng.uniform(0.15, 0.35)
            n = int(dur * SR)
            tt = np.arange(n) / SR
            f0 = rng.uniform(100, 200) * (1 + 0.1 * tt / dur * rng.choice([-1, 1]))
            f1, f2 = rng.uniform(300, 800), rng.uniform(900, 2200)
            phase = 2 * np.pi * np.cumsum(f0) / SR
            y = np.zeros(n)
            for k in range(1, 25):
                fk = k * f0.mean()
                amp = np.exp(-((fk - f1) / 150) ** 2) + 0.6 * np.exp(-((fk - f2) / 250) ** 2) + 0.02
                y += amp * np.sin(k * phase)
            env = np.sin(np.pi * tt / dur) ** 0.5
            i = int(t * SR)
            x[i:i + n] += (env * y)[: len(x) - i]
            t += dur
        t += rng.uniform(0.15, 0.6)  # pause between words
    return 0.5 * x / np.max(np.abs(x))


def write(name, x):
    path = os.path.join(OUT, name)
    subprocess.run(["ffmpeg", "-y", "-loglevel", "error", "-f", "f64le", "-ar", str(SR),
                    "-ac", "1", "-i", "-", path], input=x.astype("<f8").tobytes(), check=True)
    return path


def main():
    os.makedirs(OUT, exist_ok=True)
    a, b = song(1), song(2)
    ins = 25 * SR
    a_ad = np.concatenate([a[:ins], narration(3, 4.0), a[ins:]])
    a_ad[: 10 * SR] += narration(4, 10.0)  # narration mixed over the music
    b_ad = b.copy()
    b_ad[30 * SR: 36 * SR] = 0.4 * b_ad[30 * SR: 36 * SR] + narration(5, 6.0)  # ducked + narration

    # Two longer "videos" that share the same intro music, then differ (narration
    # over quiet background music), like many jw.org videos.
    intro = song(20, 12)
    bed = song(21, 80) * 0.15
    c = np.concatenate([intro, speech(30, 80) + bed])
    d = np.concatenate([intro, speech(31, 80) + bed])
    c_ad = np.concatenate([c[:40 * SR], narration(32, 3.0), c[40 * SR:]])
    d_ad = d.copy()

    manifest = {"videos": []}
    for vid, (o, ad) in {"song_a": (a, a_ad), "song_b": (b, b_ad),
                         "video_c": (c, c_ad), "video_d": (d, d_ad)}.items():
        manifest["videos"].append({
            "id": vid,
            "title": vid.replace("_", " ").title(),
            "original": write(f"{vid}.wav", o),
            "ad_source": write(f"{vid}_ad.wav", ad),
            "ad_files": [{"label": "480p", "url": f"../tests/fixtures/{vid}_ad.wav"}],
        })
        o.astype("<f4").tofile(os.path.join(OUT, f"{vid}.f32"))  # raw 48 kHz for the JS test
    with open(os.path.join(OUT, "manifest.json"), "w") as f:
        json.dump(manifest, f, indent=2)
    print("fixtures written to", OUT)


if __name__ == "__main__":
    main()
