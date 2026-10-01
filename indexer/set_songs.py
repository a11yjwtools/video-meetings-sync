#!/usr/bin/env python3
"""
Save the meeting songs for a week into songs.json (used by every phone).

    python set_songs.py "12, 45, 151, 3, 98"                 # this week
    python set_songs.py "12 45 151" --week 2026-10-12        # a week in advance
    python set_songs.py ""  --week 2026-10-12                # remove that week

The week is identified by its Monday. Weeks older than 8 weeks are dropped.
Prints a Markdown summary (which songs have a described version).
"""
import argparse
import datetime as dt
import json
import os
import re
import sys

KEEP_WEEKS = 8
SONG_RE = re.compile(r"\bsong\s*(?:no\.?\s*)?(\d{1,3})\b", re.I)


def monday(day):
    return day - dt.timedelta(days=day.weekday())


def parse_numbers(text):
    nums = [int(n) for n in re.findall(r"\d+", text or "")]
    bad = [n for n in nums if not 1 <= n <= 999]
    if bad:
        sys.exit(f"Not valid song numbers: {bad}")
    return list(dict.fromkeys(nums))  # keep order, drop repeats


def described_songs(manifest_path):
    """Song number -> title, for songs that have an audio-described version."""
    try:
        with open(manifest_path, encoding="utf-8") as f:
            videos = json.load(f).get("videos", [])
    except (FileNotFoundError, json.JSONDecodeError):
        return None
    out = {}
    for v in videos:
        m = SONG_RE.search(v.get("title") or "")
        if m:
            out.setdefault(int(m.group(1)), v["title"])
    return out


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("songs", help="song numbers, separated by commas or spaces")
    ap.add_argument("--week", default="", help="any date in the week (YYYY-MM-DD); default: this week")
    ap.add_argument("--file", default="songs.json")
    ap.add_argument("--manifest", default="manifest.json")
    args = ap.parse_args()

    today = dt.date.today()
    try:
        day = dt.date.fromisoformat(args.week.strip()) if args.week.strip() else today
    except ValueError:
        sys.exit(f"Week must be a date like 2026-10-12, not {args.week!r}")
    week = monday(day)
    numbers = parse_numbers(args.songs)

    data = {"weeks": []}
    if os.path.exists(args.file):
        with open(args.file, encoding="utf-8") as f:
            data = json.load(f)
    weeks = [w for w in data.get("weeks", []) if w.get("from") != week.isoformat()]
    if numbers:
        weeks.append({"from": week.isoformat(), "songs": numbers})
    oldest = monday(today) - dt.timedelta(weeks=KEEP_WEEKS)
    weeks = sorted((w for w in weeks if dt.date.fromisoformat(w["from"]) >= oldest), key=lambda w: w["from"])
    with open(args.file, "w", encoding="utf-8") as f:
        json.dump({"weeks": weeks}, f, indent=1)
        f.write("\n")

    # Summary for the person who ran it
    lines = [f"## Meeting songs for the week of {week.strftime('%A %d %B %Y')}", ""]
    if not numbers:
        lines.append("Removed the songs for this week.")
    else:
        known = described_songs(args.manifest)
        for n in numbers:
            if known is None:
                lines.append(f"- Song {n}")
            elif n in known:
                lines.append(f"- ✅ {known[n]}")
            else:
                lines.append(f"- ⚠️ Song {n}: no audio-described version in the library, so the app can't play it")
        lines += ["", "Phones pick this up within a few minutes, the next time the app is opened or brought back to the screen."]
    lines += ["", "**All weeks saved:**"] + [f"- week of {w['from']}: {', '.join(map(str, w['songs']))}" for w in weeks]
    print("\n".join(lines))


if __name__ == "__main__":
    main()
