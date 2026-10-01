#!/usr/bin/env python3
"""
Save the meeting songs for a week into songs.json (used by every phone).

    python set_songs.py "12, 45, 151, 3, 98"                 # this week
    python set_songs.py "12 45 151" --week 2026-10-12        # a week in advance
    python set_songs.py ""  --week 2026-10-12                # remove that week
    python set_songs.py "2026-10-05: 12, 45; 2026-10-12: 3, 98"   # several weeks at once

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
# How jw.org labels meeting songs, most reliable first:
KEY_RE = re.compile(r"(?:^|[-_])sjj[a-z]*_(\d{1,3})(?:_|$)", re.I)    # code like pub-sjjm_79_VIDEO
WORD_RE = re.compile(r"\bsong\s*(?:no\.?\s*)?(\d{1,3})\b", re.I)    # "Song 79", "Song No. 79"
LEAD_RE = re.compile(r"^\s*(\d{1,3})(?=\s*[.:\-\u2013\u2014]?\s+[^\d\s])")  # "79 Teach Them…"
NOT_SONG = re.compile(r"^\s*\d+\s+(minutes?|ways?|things?|reasons?|days?|years?|tips?|steps?|questions?|lessons?|keys?|secrets?)\b", re.I)


def song_number(video):
    """(number, rank) of a meeting song, or (None, None); rank 0 = surest (must match matcher.js)."""
    title = video.get("title") or ""
    for rank, (rx, text) in enumerate(((KEY_RE, video.get("id") or ""), (WORD_RE, title), (LEAD_RE, title))):
        if rank == 2 and NOT_SONG.search(title):
            continue
        m = rx.search(text)
        if m and 1 <= int(m.group(1)) <= 200:
            return int(m.group(1)), rank
    return None, None


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
    best = {}  # number -> (rank, title): a code or "Song N" beats a number at the start
    for v in videos:
        n, rank = song_number(v)
        if n is not None and (n not in best or rank < best[n][0]):
            best[n] = (rank, v.get("title") or v.get("id"))
    return {n: (t if re.search(rf"\b{n}\b", t) else f"Song {n}: {t}") for n, (_, t) in best.items()}


def parse_entries(text, week_text, today):
    """
    One week:      "12, 45, 151" (+ optional --week)
    Several weeks: "2026-10-05: 12, 45, 151; 2026-10-12: 3, 98"
    Returns [(monday, [numbers]), ...].
    """
    def to_day(t):
        try:
            return dt.date.fromisoformat(t.strip())
        except ValueError:
            sys.exit(f"Dates must look like 2026-10-12, not {t.strip()!r}")
    text = text or ""
    if ":" not in text and re.search(r"\d{4}-\d{1,2}-\d{1,2}", text):
        sys.exit("It looks like you typed a date. Put a colon after it, like '2026-10-12: 3, 98'.")
    if ":" not in text:
        day = to_day(week_text) if (week_text or "").strip() else today
        return [(monday(day), parse_numbers(text))]
    entries = []
    for part in re.split(r"[;\n]+", text):
        if not part.strip():
            continue
        if ":" not in part:
            sys.exit(f"Each week needs a date and a colon, like '2026-10-12: 3, 98'. Problem with: {part.strip()!r}")
        date_text, nums = part.split(":", 1)
        entries.append((monday(to_day(date_text)), parse_numbers(nums)))
    return entries


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("songs", help="song numbers, or several weeks as 'DATE: numbers; DATE: numbers'")
    ap.add_argument("--week", default="", help="any date in the week (YYYY-MM-DD); default: this week")
    ap.add_argument("--file", default="songs.json")
    ap.add_argument("--manifest", default="manifest.json")
    args = ap.parse_args()

    today = dt.date.today()
    entries = parse_entries(args.songs, args.week, today)

    data = {"weeks": []}
    if os.path.exists(args.file):
        with open(args.file, encoding="utf-8") as f:
            data = json.load(f)
    changed = {w.isoformat() for w, _ in entries}
    weeks = [w for w in data.get("weeks", []) if w.get("from") not in changed]
    weeks += [{"from": w.isoformat(), "songs": nums, "source": "manual"} for w, nums in entries if nums]
    oldest = monday(today) - dt.timedelta(weeks=KEEP_WEEKS)
    weeks = sorted((w for w in weeks if dt.date.fromisoformat(w["from"]) >= oldest), key=lambda w: w["from"])
    with open(args.file, "w", encoding="utf-8") as f:
        json.dump({"weeks": weeks}, f, indent=1)
        f.write("\n")

    # Summary for the person who ran it
    known = described_songs(args.manifest)
    lines = []
    for week, numbers in entries:
        lines += [f"## Week of {week.strftime('%A %d %B %Y')}", ""]
        if not numbers:
            lines += ["Removed the songs for this week.", ""]
            continue
        for n in numbers:
            if known is None:
                lines.append(f"- Song {n}")
            elif n in known:
                lines.append(f"- ✅ {known[n]}")
            else:
                lines.append(f"- ⚠️ Song {n}: no audio-described version in the library, so the app can't play it")
        lines.append("")
    if known is not None:
        examples = [known[n] for n in sorted(known)[:3]]
        lines += [f"_The library has {len(known)} meeting songs with audio description"
                  + (f", for example: {'; '.join(examples)}._" if examples else "._"), ""]
    lines += ["Phones pick this up within a few minutes, the next time the app is opened or brought back to the screen.",
              "", "**All weeks saved:**"]
    lines += [f"- week of {w['from']}: {', '.join(map(str, w['songs']))}" for w in weeks] or ["- none"]
    print("\n".join(lines))


if __name__ == "__main__":
    main()
