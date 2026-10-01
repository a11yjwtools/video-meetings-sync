#!/usr/bin/env python3
"""
Create manifest.json by pairing every audio-described video with its original.

    python discover.py --out manifest.json

It reads the public JSON API that powers the jw.org video library:
    https://b.jw-cdn.org/apis/mediator/v1/categories/<lang>/<key>?detailed=1

The pairing is heuristic (matching normalised titles). Anything it can't pair
is listed under "unpaired" in the manifest: fill in "original" by hand (a
media URL or a local file path), move the entry into "videos", and re-run
build_index.py. Always review the manifest before building.
"""
import argparse
import difflib
import json
import re
import sys
import time
import unicodedata

import requests

API = "https://b.jw-cdn.org/apis/mediator/v1"
HEADERS = {"User-Agent": "jw-ad-sync indexer (personal accessibility project)"}
AD_WORDS = re.compile(r"(\b(with|including)\s+)?\b(audio[\s-]*descri(bed|ptions?)|\(ad\))", re.I)


def get_json(url, **params):
    for attempt in range(4):
        try:
            r = requests.get(url, params=params, headers=HEADERS, timeout=30)
            r.raise_for_status()
            return r.json()
        except requests.RequestException as e:
            wait = 2 ** attempt
            print(f"  retry in {wait}s: {e}", file=sys.stderr)
            time.sleep(wait)
    raise RuntimeError(f"giving up on {url}")


def walk_category(lang, key, seen=None, depth=0):
    """Yield every media item under a category, recursing into subcategories."""
    seen = seen if seen is not None else set()
    if key in seen:
        return
    seen.add(key)
    data = get_json(f"{API}/categories/{lang}/{key}", detailed=1, clientType="www")
    cat = data.get("category", {})
    print("  " * depth + f"- {cat.get('name', key)} ({len(cat.get('media', []))} items)", file=sys.stderr)
    for m in cat.get("media", []) or []:
        yield m
    for sub in cat.get("subcategories", []) or []:
        time.sleep(0.2)  # be polite
        yield from walk_category(lang, sub["key"], seen, depth + 1)


def norm_title(t):
    t = AD_WORDS.sub(" ", t or "")
    t = unicodedata.normalize("NFKD", t).encode("ascii", "ignore").decode()
    t = re.sub(r"[^a-z0-9]+", " ", t.lower())
    return " ".join(t.split())


def raw_key(m):
    return (m.get("languageAgnosticNaturalKey") or m.get("naturalKey") or "").lower()


AD_WORD = r"(?:ad|aud|vad|desc|audiodesc|audiodescription|audiodescribed)"


def key_candidates(m):
    """Possible keys of the original, derived by removing audio-description markers."""
    k = raw_key(m)
    subs = [
        (rf"[_-]{AD_WORD}(?=[_-]|$)", ""),               # pub-sjjm_1_AD_VIDEO -> pub-sjjm_1_VIDEO
        (rf"^{AD_WORD}[_-]", ""),                         # ad_pub-sjjm_1       -> pub-sjjm_1
        (r"(?<=[a-z0-9])(?:vad|aud|ad)(?=[_-]|$)", ""),    # pub-sjjmad_1        -> pub-sjjm_1
    ]
    out = []
    for pat, rep in subs:
        c = re.sub(pat, rep, k, count=1)
        if c != k:
            out.append(c)
    return list(dict.fromkeys(out))


def pick_files(m):
    files = [f for f in m.get("files", []) if f.get("progressiveDownloadURL")]
    files.sort(key=lambda f: f.get("frameHeight") or 0)
    return files


def poster(m):
    imgs = m.get("images") or {}
    for kind in ("lss", "wss", "pnr", "sqr"):
        for size in ("lg", "md", "sm"):
            u = (imgs.get(kind) or {}).get(size)
            if u:
                return u
    return None


def merge(path, videos, unpaired):
    """Existing paired entries (including hand-paired ones) take priority."""
    try:
        with open(path, encoding="utf-8") as f:
            old = json.load(f)
    except (FileNotFoundError, json.JSONDecodeError):
        return videos, unpaired
    kept = [e for e in old.get("videos", []) if e.get("original") and e.get("ad_source")]
    kept_ids = {e["id"] for e in kept}
    new = [e for e in videos if e["id"] not in kept_ids]
    # an unpaired entry the user has since filled in counts as paired
    old_unpaired = {e["id"]: e for e in old.get("unpaired", [])}
    still = []
    for e in unpaired:
        if e["id"] in kept_ids:
            continue
        prev = old_unpaired.get(e["id"])
        if prev and prev.get("original"):
            new.append(prev)
        else:
            still.append(e)
    print(f"merge: kept {len(kept)} existing, added {len(new)} new", file=sys.stderr)
    return kept + new, still


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--lang", default="E")
    ap.add_argument("--ad-category", default="VODAudioDescriptions")
    ap.add_argument("--library-category", default="VideoOnDemand")
    ap.add_argument("--out", default="manifest.json")
    ap.add_argument("--merge", metavar="EXISTING",
                    help="keep entries from an existing manifest (your hand edits win)")
    args = ap.parse_args()

    print("Audio-description videos:", file=sys.stderr)
    ad_items = {m["guid"]: m for m in walk_category(args.lang, args.ad_category)}
    print(f"found {len(ad_items)} AD videos\n\nFull library:", file=sys.stderr)
    library = {}
    for m in walk_category(args.lang, args.library_category, seen={args.ad_category}):
        if m["guid"] not in ad_items:
            library[m["guid"]] = m

    by_title, by_key = {}, {}
    for m in library.values():
        by_title.setdefault(norm_title(m.get("title")), m)
        by_key.setdefault(raw_key(m), m)
    titles = list(by_title)

    def find_original(ad):
        for k in key_candidates(ad):                   # 1. same key minus the AD marker
            if k in by_key:
                return by_key[k], "key"
        t = norm_title(ad.get("title"))
        if t in by_title:                              # 2. same title minus "audio description"
            return by_title[t], "title"
        close = difflib.get_close_matches(t, titles, n=1, cutoff=0.88)
        if close:                                      # 3. nearly the same title
            return by_title[close[0]], "similar title"
        return None, None

    print("\nSample of audio-described videos found:", file=sys.stderr)
    for ad in list(ad_items.values())[:8]:
        print(f"  {ad.get('title')!r}  key={raw_key(ad)!r}", file=sys.stderr)
    stats = {}

    videos, unpaired = [], []
    for ad in ad_items.values():
        ad_files = pick_files(ad)
        if not ad_files:
            continue
        orig, how = find_original(ad)
        if orig:
            stats[how] = stats.get(how, 0) + 1
        entry = {
            "id": ad.get("languageAgnosticNaturalKey") or ad["guid"],
            "title": ad.get("title"),
            "ad_source": ad_files[0]["progressiveDownloadURL"],  # smallest file is plenty for audio
            "ad_files": [{"label": f.get("label") or f"{f.get('frameHeight')}p",
                          "url": f["progressiveDownloadURL"]} for f in ad_files],
            "poster": poster(ad),
        }
        if orig and pick_files(orig):
            entry["original"] = pick_files(orig)[0]["progressiveDownloadURL"]
            entry["original_title"] = orig.get("title")
            entry["paired_by"] = how
            videos.append(entry)
        else:
            entry["original"] = ""
            unpaired.append(entry)

    if args.merge:
        videos, unpaired = merge(args.merge, videos, unpaired)

    with open(args.out, "w", encoding="utf-8") as f:
        json.dump({"videos": videos, "unpaired": unpaired}, f, ensure_ascii=False, indent=2)
    print(f"\npaired {len(videos)} ({stats or 'none'}), unpaired {len(unpaired)} -> {args.out}", file=sys.stderr)
    if unpaired:
        print("Examples of unpaired videos:", file=sys.stderr)
        for e in unpaired[:8]:
            print(f"  {e['title']!r}  key={e['id']!r}", file=sys.stderr)
    if not ad_items:
        sys.exit(f"ERROR: no videos found in category {args.ad_category!r}; the category name may have changed")
    if not library:
        sys.exit(f"ERROR: no videos found in category {args.library_category!r}")
    if not videos:
        sys.exit("ERROR: none of the audio-described videos could be paired with an original "
                 "(see the examples above; manifest.json was still written so you can pair them by hand)")
    print("Review the pairs (title vs original_title) before running build_index.py.", file=sys.stderr)


if __name__ == "__main__":
    main()
