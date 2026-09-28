#!/usr/bin/env python3
"""
Build the on-device fingerprint library used by the web app.

    python build_index.py manifest.json --out ../docs/data

For every entry in the manifest it fingerprints the ORIGINAL video's audio
(what the phone hears in the room) and aligns the AUDIO-DESCRIPTION version
to it, producing a time map (original time -> AD time). Output:

  catalog.json   titles, playback URLs, time maps, which file holds each video
  auto.bin       combined fingerprints of the shorter videos (songs, short
                 clips), so the app can recognise them without being told which
  coarse.bin     a thinned-out copy of all the other videos' fingerprints, used
                 to shortlist candidates that are then checked in full
  v/<n>.bin      one small fingerprint file per video, loaded only when the
                 user picks that video from the list

Fingerprints are cached per video in .cache/, so re-runs only download new videos.
"""
import argparse
import hashlib
import json
import os
import shutil
import struct
import subprocess
import sys

import numpy as np

from fingerprint import PARAMS, fingerprint

SR = PARAMS["sr"]
FPS = SR / PARAMS["hop"]
MAX_T = (1 << 20) - 1      # frame times are stored in 20 bits (~4.6 h)
MAX_VIDEOS = 1 << 12       # video index is stored in 12 bits
MAGIC = b"JWAD"
VERSION = 2


# ---------------------------------------------------------------- audio I/O
def load_audio(src: str) -> np.ndarray:
    """Decode any file/URL ffmpeg understands to mono float at SR."""
    cmd = ["ffmpeg", "-nostdin", "-loglevel", "error", "-i", src,
           "-vn", "-ac", "1", "-ar", str(SR), "-f", "f32le", "-"]
    raw = subprocess.run(cmd, check=True, capture_output=True).stdout
    return np.frombuffer(raw, dtype=np.float32).astype(np.float64)


# ---------------------------------------------------------------- alignment
def match_pairs(q_h, q_t, ref_h, ref_t):
    """All (query_time, ref_time - query_time) pairs that share a hash."""
    order = np.argsort(ref_h, kind="stable")
    rh, rt = ref_h[order], ref_t[order].astype(np.int64)
    lo = np.searchsorted(rh, q_h, "left")
    hi = np.searchsorted(rh, q_h, "right")
    counts = hi - lo
    if counts.sum() == 0:
        return np.zeros(0, np.int64), np.zeros(0, np.int64)
    qi = np.repeat(np.arange(len(q_h)), counts)
    starts = np.repeat(lo, counts)
    within = np.arange(counts.sum()) - np.repeat(np.cumsum(counts) - counts, counts)
    ri = starts + within
    tq = q_t[qi].astype(np.int64)
    return tq, rt[ri] - tq


def align(orig_h, orig_t, ad_h, ad_t, win_s=6.0, step_s=2.0, min_votes=8):
    """
    Returns segments [{o0, o1, d}] in seconds: for original time t in a
    segment, the AD time is t + d. Gaps/jumps between segments are places
    where the AD version inserted (or removed) material.
    """
    tq, delta = match_pairs(orig_h, orig_t, ad_h, ad_t)
    if len(tq) == 0:
        return []
    win, step = int(win_s * FPS), int(step_s * FPS)
    records = []  # (window_start, best_delta, votes)
    end = int(tq.max()) + 1
    for w0 in range(0, max(end - win, 0) + 1, step):
        sel = (tq >= w0) & (tq < w0 + win)
        if sel.sum() < min_votes:
            continue
        d = delta[sel]
        dmin = d.min()
        hist = np.bincount(d - dmin)
        smooth = hist.astype(np.int64)
        smooth[1:] += hist[:-1]
        smooth[:-1] += hist[1:]
        best = int((4 * smooth + hist).argmax())  # tie-break toward the centre bin
        if smooth[best] >= min_votes:
            records.append((w0, best + int(dmin), int(smooth[best])))

    # group consecutive windows that agree on the delta
    groups = []
    for rec in records:
        if groups and abs(rec[1] - groups[-1][-1][1]) <= 2 and rec[0] - groups[-1][-1][0] <= step * 2:
            groups[-1].append(rec)
        else:
            groups.append([rec])

    segments = []
    for g in groups:
        if len(g) < 2 and g[0][2] < 2 * min_votes:
            continue  # a single weak window is probably a false match
        d = int(round(np.median([r[1] for r in g])))
        lo_t, hi_t = g[0][0], g[-1][0] + win
        sel = (np.abs(delta - d) <= 1) & (tq >= lo_t) & (tq < hi_t)
        if not sel.any():
            continue
        segments.append([int(tq[sel].min()), int(tq[sel].max()), d])

    segments.sort()
    clean = []
    for s in segments:
        if clean and s[0] <= clean[-1][1]:
            clean[-1][1] = s[0] - 1  # trim overlap
        clean.append(s)
    return [{"o0": round(a / FPS, 3), "o1": round(b / FPS, 3), "d": round(d / FPS, 3)}
            for a, b, d in clean]


# ---------------------------------------------------------------- build
def cache_key(e):
    blob = json.dumps([e["original"], e["ad_source"], PARAMS], sort_keys=True)
    return hashlib.sha1(blob.encode()).hexdigest()[:20]


def process(e, cache_dir, log):
    """Fingerprint + align one pair; results are cached on disk."""
    path = os.path.join(cache_dir, cache_key(e) + ".npz") if cache_dir else None
    if path and os.path.exists(path):
        z = np.load(path, allow_pickle=False)
        return z["h"], z["t"], json.loads(str(z["meta"])), True
    orig = e["original_audio"] if "original_audio" in e else load_audio(e["original"])
    ad = e["ad_audio"] if "ad_audio" in e else load_audio(e["ad_source"])
    if len(orig) < SR * 2 or len(ad) < SR * 2:
        raise ValueError("audio too short")
    oh, ot = fingerprint(orig)
    ah, at = fingerprint(ad)
    segs = align(oh, ot, ah, at)
    if not segs:
        log("   !! could not align AD version; assuming identical timing")
        segs = [{"o0": 0.0, "o1": round(len(orig) / SR, 3), "d": 0.0}]
    meta = {"originalDuration": round(len(orig) / SR, 3),
            "adDuration": round(len(ad) / SR, 3), "map": segs}
    keep = ot <= MAX_T
    oh, ot = oh[keep], ot[keep]
    if path:
        os.makedirs(cache_dir, exist_ok=True)
        np.savez(path, h=oh, t=ot, meta=np.array(json.dumps(meta)))
    return oh, ot, meta, False


def sort_index(h, v):
    order = np.lexsort((v, h))
    h, v = h[order], v[order]
    if len(h):
        keep = np.ones(len(h), bool)
        keep[1:] = (h[1:] != h[:-1]) | (v[1:] != v[:-1])
        h, v = h[keep], v[keep]
    return h.astype("<u4"), v.astype("<u4")


def write_index(path, h, v):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "wb") as f:
        # 16-byte header keeps the Uint32Arrays 4-byte aligned in the browser
        f.write(MAGIC + struct.pack("<III", VERSION, len(h), 0))
        f.write(h.tobytes())
        f.write(v.tobytes())


def coarse_keep(h, k):
    """Deterministic 1-in-k subsample of hashes (must match coarseKeep in matcher.js)."""
    if k <= 1:
        return np.ones(len(h), bool)
    mixed = (h.astype(np.uint64) * np.uint64(2654435761)) & np.uint64(0xFFFFFFFF)
    return (mixed % np.uint64(k)) == 0


def build(entries, out_dir, cache_dir, auto_max_min=10.0, auto_budget_mb=40.0,
          coarse_budget_mb=25.0, log=print):
    videos, per_video = [], []
    for n, e in enumerate(entries):
        vid = len(videos)
        if vid >= MAX_VIDEOS:
            log(f"!! more than {MAX_VIDEOS} videos, ignoring the rest")
            break
        log(f"[{n + 1}/{len(entries)}] {e.get('title', e['id'])}")
        try:
            oh, ot, meta, cached = process(e, cache_dir, log)
        except (subprocess.CalledProcessError, OSError, ValueError) as err:
            msg = getattr(err, "stderr", b"") or b""
            detail = " ".join(msg.decode(errors="ignore").split())[:200] if msg else str(err)
            log(f"   !! skipped, could not download/decode: {detail}")
            continue
        log(f"   {len(oh)} hashes, {len(meta['map'])} segment(s){' (cached)' if cached else ''}")

        v = (np.uint32(vid) << np.uint32(20)) | ot.astype(np.uint32)
        h, v = sort_index(oh.astype(np.uint32), v)
        write_index(os.path.join(out_dir, "v", f"{vid}.bin"), h, v)
        per_video.append((h, v))
        videos.append({
            "id": e["id"],
            "title": e.get("title", e["id"]),
            **meta,
            "adFiles": e.get("ad_files") or [{"label": "default", "url": e["ad_source"]}],
            "poster": e.get("poster"),
            "fp": f"v/{vid}.bin",
            "auto": False,
        })

    # Automatic recognition: shortest videos first, up to the size budget.
    budget = auto_budget_mb * 1e6
    used, auto_h, auto_v = 16, [], []
    for vid in sorted(range(len(videos)), key=lambda i: videos[i]["originalDuration"]):
        if videos[vid]["originalDuration"] > auto_max_min * 60:
            break
        h, v = per_video[vid]
        if used + 8 * len(h) > budget:
            log(f"!! automatic-recognition budget ({auto_budget_mb:.0f} MB) reached; "
                "remaining videos can still be picked from the list")
            break
        used += 8 * len(h)
        auto_h.append(h)
        auto_v.append(v)
        videos[vid]["auto"] = True
    h = np.concatenate(auto_h) if auto_h else np.zeros(0, np.uint32)
    v = np.concatenate(auto_v) if auto_v else np.zeros(0, np.uint32)
    write_index(os.path.join(out_dir, "auto.bin"), *sort_index(h, v))

    # Coarse index: a thinned-out copy of every OTHER video's fingerprints.
    # The app uses it to shortlist candidates, then verifies them with their
    # full per-video files. Thinning is chosen so the file fits its budget.
    rest = [i for i in range(len(videos)) if not videos[i]["auto"]]
    total = sum(len(per_video[i][0]) for i in rest)
    k = max(1, int(np.ceil(8 * total / (coarse_budget_mb * 1e6)))) if total else 1
    ch, cv = [], []
    for i in rest:
        h, v = per_video[i]
        keep = coarse_keep(h, k)
        ch.append(h[keep])
        cv.append(v[keep])
    h = np.concatenate(ch) if ch else np.zeros(0, np.uint32)
    v = np.concatenate(cv) if cv else np.zeros(0, np.uint32)
    write_index(os.path.join(out_dir, "coarse.bin"), *sort_index(h, v))
    log(f"coarse index: {len(rest)} videos, keeping 1 in {k} fingerprints")
    return videos, k


def write_catalog(videos, out_dir, coarse_k=1):
    with open(os.path.join(out_dir, "catalog.json"), "w", encoding="utf-8") as f:
        json.dump({"version": VERSION, "params": PARAMS, "coarseK": coarse_k, "videos": videos},
                  f, ensure_ascii=False, indent=1)
    auto = sum(v["auto"] for v in videos)
    total = sum(os.path.getsize(os.path.join(dp, fn)) for dp, _, fns in os.walk(out_dir) for fn in fns)
    auto_mb = os.path.getsize(os.path.join(out_dir, "auto.bin")) / 1e6
    coarse_mb = os.path.getsize(os.path.join(out_dir, "coarse.bin")) / 1e6
    hours = sum(v["originalDuration"] for v in videos) / 3600
    print(f"wrote {len(videos)} videos ({hours:.1f} h); {auto} recognised automatically "
          f"(auto.bin {auto_mb:.1f} MB), the rest via shortlist (coarse.bin {coarse_mb:.1f} MB); "
          f"{total / 1e6:.0f} MB in total -> {out_dir}")


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("manifest")
    ap.add_argument("--out", default=os.path.join(os.path.dirname(__file__), "..", "docs", "data"))
    ap.add_argument("--cache", default=os.path.join(os.path.dirname(__file__), ".cache"))
    ap.add_argument("--auto-max-minutes", type=float, default=10.0,
                    help="videos up to this length are recognised without picking them (default 10)")
    ap.add_argument("--auto-budget-mb", type=float, default=40.0,
                    help="maximum size of the automatic-recognition file the phone downloads (default 40)")
    ap.add_argument("--coarse-budget-mb", type=float, default=25.0,
                    help="maximum size of the shortlist file covering all other videos (default 25)")
    args = ap.parse_args()

    with open(args.manifest, encoding="utf-8") as f:
        manifest = json.load(f)
    entries = [e for e in manifest["videos"] if e.get("original") and e.get("ad_source")]
    skipped = len(manifest["videos"]) - len(entries)
    if skipped:
        print(f"skipping {skipped} entries without both 'original' and 'ad_source'", file=sys.stderr)

    if os.path.isdir(args.out):  # start clean so removed videos disappear
        for name in ("auto.bin", "coarse.bin", "index.bin", "catalog.json"):
            p = os.path.join(args.out, name)
            if os.path.exists(p):
                os.remove(p)
        shutil.rmtree(os.path.join(args.out, "v"), ignore_errors=True)
    videos, coarse_k = build(entries, args.out, args.cache, args.auto_max_minutes,
                             args.auto_budget_mb, args.coarse_budget_mb)
    if not videos:
        sys.exit("no videos could be indexed; check the log above")
    write_catalog(videos, args.out, coarse_k)


if __name__ == "__main__":
    main()
