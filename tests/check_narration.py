#!/usr/bin/env python3
"""Check that the library's narration times match the known truth of the test video.
Run after make_fixture.py and build_index.py (see roundtrip.mjs for the commands)."""
import json, os, sys
import numpy as np

here = os.path.join(os.path.dirname(os.path.abspath(__file__)), "fixtures")
truth = json.load(open(os.path.join(here, "narration_truth.json")))
cat = json.load(open(os.path.join(here, "data", "catalog.json")))
got = next(v for v in cat["videos"] if v["id"] == "narrated")["speech"] or []
t = np.arange(0, 64, 0.05)

T = np.array([any(a <= x < a + d for a, d in truth) for x in t])
G = np.array([any(a <= x < b for a, b in got) for x in t])
heard, quiet = 100 * np.mean(G[T]), 100 * np.mean(~G[~T])
print(f"narration times {got}\nnarration heard: {heard:.0f}% | muted when nobody speaks: {quiet:.0f}%")
video_d = next(v for v in cat["videos"] if v["id"] == "video_d")["speech"]
ok = heard >= 98 and quiet >= 85 and video_d == []
print("PASS" if ok else "FAIL")
sys.exit(0 if ok else 1)
