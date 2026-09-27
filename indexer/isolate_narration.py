#!/usr/bin/env python3
"""
EXPERIMENT: keep only the narration of an audio-described video.

The described version = original soundtrack (often turned down under the
narration) + narration. Given both files, this lines the original up with the
described version to a fraction of a millisecond, follows its volume changes,
and removes it frequency by frequency, leaving mostly the narration.

    python isolate_narration.py ORIGINAL AD_VERSION --out narration.mp3
    python isolate_narration.py --find "song 12" --out narration.mp3   (uses manifest.json)

ORIGINAL / AD_VERSION can be files or URLs. Also prints a short report.
"""
import argparse
import json
import subprocess
import sys

import numpy as np
from scipy.ndimage import median_filter, uniform_filter1d
from scipy.signal import fftconvolve, stft, istft

sys.path.insert(0, __import__("os").path.dirname(__file__))
from fingerprint import PARAMS, fingerprint  # noqa: E402
from build_index import align  # noqa: E402

SR = 24000          # processing rate: plenty for speech, keeps files small
NFFT, HOP = 1024, 256


def load(src, sr):
    cmd = ["ffmpeg", "-nostdin", "-loglevel", "error", "-i", src, "-vn", "-ac", "1",
           "-ar", str(sr), "-f", "f32le", "-"]
    return np.frombuffer(subprocess.run(cmd, check=True, capture_output=True).stdout, np.float32).astype(np.float64)


def fine_offset(orig, ad, o_sec, ad_sec, search_ms=60, win_sec=8.0):
    """Exact delay (in samples) between orig at o_sec and ad at ad_sec, by cross-correlation."""
    n, s = int(win_sec * SR), int(search_ms / 1000 * SR)
    i0, j0 = int(o_sec * SR), int(ad_sec * SR)
    a = orig[i0:i0 + n]
    b = ad[max(0, j0 - s): j0 + n + s]
    if len(a) < n // 2 or len(b) < len(a):
        return 0
    c = fftconvolve(b, a[::-1], mode="valid")
    lag = int(np.argmax(np.abs(c)))
    return (max(0, j0 - s) + lag) - j0


def fill_gaps(orig, ad, segments, step=0.25):
    """Cover the whole original: stretch the first/last pieces to the ends, and split the
    gaps between pieces (around inserted narration) into short bits, each given to the
    side it actually matches (or left out if it matches neither)."""
    segs = [dict(s) for s in segments]
    segs[0]["o0"] = 0.0
    segs[-1]["o1"] = len(orig) / SR
    out = [segs[0]]
    n = int(step * SR)
    for nxt in segs[1:]:
        prev = out[-1]
        t = prev["o1"]
        while t + step <= nxt["o0"]:
            a = orig[int(t * SR): int(t * SR) + n]
            best, best_d = 0.5, None  # need a clear match
            for d in (prev["d"], nxt["d"]):
                j = int((t + d) * SR)
                b = ad[j: j + n]
                if len(b) == len(a) and np.std(a) > 1e-4:
                    c = float(np.dot(a, b) / (np.linalg.norm(a) * np.linalg.norm(b) + 1e-12))
                    if c > best:
                        best, best_d = c, d
            if best_d == prev["d"]:
                prev["o1"] = t + step
            elif best_d == nxt["d"]:
                nxt["o0"] = min(nxt["o0"], t)
                break
            t += step
        # and backwards from the next piece, for what the forward pass left over
        t = nxt["o0"] - step
        while t >= prev["o1"]:
            a = orig[int(t * SR): int(t * SR) + n]
            j = int((t + nxt["d"]) * SR)
            b = ad[j: j + n]
            if len(b) != len(a) or np.std(a) <= 1e-4:
                break
            if float(np.dot(a, b) / (np.linalg.norm(a) * np.linalg.norm(b) + 1e-12)) <= 0.5:
                break
            nxt["o0"] = t
            t -= step
        out.append(nxt)
    return out


def build_reference(orig, ad, segments):
    """Original soundtrack placed on the described version's timeline, sample-accurately."""
    ref = np.zeros_like(ad)
    for seg in segments:
        o0, o1, d = seg["o0"], seg["o1"], seg["d"]
        # measure the exact delay in a few places and use the median (robust to narration)
        spots = np.linspace(o0, max(o0, o1 - 8), num=min(5, max(1, int((o1 - o0) // 10) + 1)))
        offs = [fine_offset(orig, ad, t, t + d) for t in spots]
        extra = int(np.median(offs))
        delay = int(round(d * SR)) + extra
        i0, i1 = int(o0 * SR), int(o1 * SR)
        j0 = i0 + delay
        if j0 < 0:
            i0 -= j0
            j0 = 0
        n = min(i1 - i0, len(ad) - j0)
        if n > 0:
            ref[j0:j0 + n] = orig[i0:i0 + n]
        seg["fineMs"] = round(1000 * extra / SR, 2)
    return ref


def isolate(ad, ref, cleanup=0.25, floor=0.03, smooth=0.3):
    """
    Cancel the original soundtrack out of the described mix:
      1. learn the fixed tone difference between the two mixes (per frequency,
         including tiny phase differences) by least squares; the narration is
         unrelated to the soundtrack, so it doesn't disturb the estimate,
      2. follow the soundtrack's volume over time (it is turned down under narration),
      3. subtract it wave-for-wave,
      4. clean up the small remainder left because each file was compressed separately.
    """
    _, _, A = stft(ad, SR, nperseg=NFFT, noverlap=NFFT - HOP)
    _, _, R = stft(ref, SR, nperseg=NFFT, noverlap=NFFT - HOP)
    H = np.sum(A * np.conj(R), axis=1) / (np.sum(np.abs(R) ** 2, axis=1) + 1e-12)
    HR = H[:, None] * R
    g = np.real(np.sum(A * np.conj(HR), axis=0)) / (np.sum(np.abs(HR) ** 2, axis=0) + 1e-12)
    g = np.clip(uniform_filter1d(median_filter(g, int(smooth * SR / HOP) | 1), 5), 0, 2)
    est = g[None, :] * HR
    E = A - est
    if cleanup > 0:
        m = np.clip(1 - (cleanup * np.abs(est)) ** 2 / (np.abs(E) ** 2 + 1e-12), 0, 1) ** 0.5
        E = E * np.maximum(median_filter(m, (3, 3)), floor)
    _, y = istft(E, SR, nperseg=NFFT, noverlap=NFFT - HOP)
    active = g[g > 0.05]
    return y[: len(ad)], float(np.median(active)) if len(active) else 0.0


def speech_intervals(ad, ref, chunk=60.0, frame=0.05, rel_db=-12.0, floor_db=-45.0,
                     join=0.8, min_len=0.3, pad_before=0.3, pad_after=0.5):
    """
    When is someone describing? Remove the soundtrack (in chunks, to keep memory
    low), then mark the moments where what is left is a real part of the mix.
    Returns [[start, end], ...] in seconds of the described version, or None if
    the result looks unreliable (then the app simply never mutes).
    """
    hop = int(frame * SR)
    n_frames = len(ad) // hop
    resid = np.zeros(n_frames)
    total = np.zeros(n_frames)
    step, over = int(chunk * SR), int(2 * SR)
    for c0 in range(0, len(ad), step):
        a0, a1 = max(0, c0 - over), min(len(ad), c0 + step + over)
        y, _ = isolate(ad[a0:a1], ref[a0:a1])
        f0, f1 = c0 // hop, min(n_frames, (c0 + step) // hop)
        for f in range(f0, f1):
            i = f * hop - a0
            resid[f] = np.mean(y[i:i + hop] ** 2)
            total[f] = np.mean(ad[a0 + i:a0 + i + hop] ** 2)
    k = 5  # smooth over ~0.25 s
    resid = uniform_filter1d(resid, k)
    total = uniform_filter1d(total, k)
    peak = np.percentile(total, 99) + 1e-12
    db = lambda x: 10 * np.log10(x + 1e-12)
    on = (db(resid) - db(total) > rel_db) & (db(resid) - db(peak) > floor_db)

    spans, start = [], None
    for f, v in enumerate(np.append(on, False)):
        if v and start is None:
            start = f
        elif not v and start is not None:
            spans.append([start * frame, f * frame])
            start = None
    merged = []
    for s0, s1 in spans:
        if merged and s0 - merged[-1][1] < join:
            merged[-1][1] = s1
        else:
            merged.append([s0, s1])
    dur = len(ad) / SR
    out = [[round(max(0.0, s0 - pad_before), 2), round(min(dur, s1 + pad_after), 2)]
           for s0, s1 in merged if s1 - s0 >= min_len]
    covered = sum(b - a for a, b in out) / max(dur, 1e-9)
    if covered > 0.85:
        return None  # nearly everything flagged: the soundtrack wasn't removed well
    return out


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("original", nargs="?")
    ap.add_argument("ad", nargs="?")
    ap.add_argument("--find", help="pick the video from manifest.json by (part of) its title")
    ap.add_argument("--manifest", default="manifest.json")
    ap.add_argument("--out", default="narration.mp3")
    ap.add_argument("--seconds", type=float, default=0, help="only process the first N seconds (0 = all)")
    ap.add_argument("--compare", help="also save the same stretch of the normal described version here")
    args = ap.parse_args()
    title = None
    if args.find:
        with open(args.manifest, encoding="utf-8") as f:
            videos = json.load(f)["videos"]
        words = args.find.lower().split()
        hits = [v for v in videos if all(w in (v.get("title") or "").lower() for w in words)]
        if not hits:
            sys.exit(f"no video in {args.manifest} matches {args.find!r}")
        v = hits[0]
        title = v["title"]
        print(f"using: {title}" + (f"  ({len(hits) - 1} other matches)" if len(hits) > 1 else ""), file=sys.stderr)
        args.original, args.ad = v["original"], v["ad_source"]
    if not (args.original and args.ad):
        ap.error("give ORIGINAL and AD_VERSION, or --find")

    orig8, ad8 = load(args.original, PARAMS["sr"]), load(args.ad, PARAMS["sr"])
    segs = align(*fingerprint(orig8), *fingerprint(ad8))
    if not segs:
        sys.exit("could not line the two versions up")
    orig, ad = load(args.original, SR), load(args.ad, SR)
    if args.seconds:
        ad = ad[: int(args.seconds * SR)]
    segs = fill_gaps(orig, ad, segs)
    ref = build_reference(orig, ad, segs)
    y, duck = isolate(ad, ref)
    y = y / max(1e-6, np.max(np.abs(y))) * 0.9

    subprocess.run(["ffmpeg", "-y", "-nostdin", "-loglevel", "error", "-f", "f64le", "-ar", str(SR), "-ac", "1",
                    "-i", "-", "-b:a", "96k", args.out], input=y.astype("<f8").tobytes(), check=True)
    if args.compare:
        z = ad / max(1e-6, np.max(np.abs(ad))) * 0.9
        subprocess.run(["ffmpeg", "-y", "-nostdin", "-loglevel", "error", "-f", "f64le", "-ar", str(SR), "-ac", "1",
                        "-i", "-", "-b:a", "96k", args.compare], input=z.astype("<f8").tobytes(), check=True)
    report = {"title": title, "pieces": [{k: s[k] for k in ("o0", "o1", "d", "fineMs")} for s in segs],
              "seconds": round(len(ad) / SR, 1), "output": args.out}
    print(json.dumps(report, indent=1))


if __name__ == "__main__":
    main()
