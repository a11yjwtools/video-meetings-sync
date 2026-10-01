#!/usr/bin/env python3
"""
Fill songs.json with the meeting songs published in the Watchtower ONLINE
LIBRARY (wol.jw.org) for the coming weeks:

  - midweek meeting: the three songs in the Life and Ministry Meeting Workbook
  - weekend meeting: the opening and closing songs of the Watchtower Study
    (the song before the public talk is chosen locally, so it is not published;
    add it by hand with set_songs.py if you like)

    python fetch_songs.py --weeks 5

Weeks set by hand (with set_songs.py / the "Set meeting songs" form) are never
overwritten. Prints a Markdown summary.
"""
import argparse
import datetime as dt
import html
import json
import os
import re
import sys
import time

import requests

from set_songs import KEEP_WEEKS, described_songs, monday

HEADERS = {"User-Agent": "Described accessibility app (weekly meeting songs; a few requests per week)"}
DOC_LINK = re.compile(r'href="(/[a-z-]+/wol/d/r\d+/lp-[a-z-]+/\d+)"')
SONG = re.compile(r"\bsong\s+(\d{1,3})\b", re.I)


def get(url):
    for attempt in range(3):
        try:
            r = requests.get(url, headers=HEADERS, timeout=30)
            if r.status_code == 404:
                return None
            r.raise_for_status()
            return r.text
        except requests.RequestException:
            time.sleep(2 ** attempt)
    return None


def text_of(page):
    return html.unescape(re.sub(r"<[^>]+>", " ", page))


def section_links(page, start, end):
    """Document links between two headings of the weekly meetings page."""
    i = page.find(start)
    if i < 0:
        return []
    j = page.find(end, i + len(start)) if end else -1
    return DOC_LINK.findall(page[i: j if j > 0 else len(page)])


def songs_in(doc_html, limit):
    nums = []
    for m in SONG.finditer(text_of(doc_html)):
        n = int(m.group(1))
        if 1 <= n <= 200 and n not in nums:
            nums.append(n)
    return nums[:limit]


def week_songs(base, week_monday, log):
    """Published songs for one week: (midweek, weekend) lists, or None if not published yet."""
    iso_year, iso_week, _ = week_monday.isocalendar()
    page = get(f"{base}{MEETINGS_PATH}/{iso_year}/{iso_week}")
    if not page:
        return None
    root = re.match(r"https?://[^/]+", base).group(0)
    mid_links = section_links(page, "Life and Ministry", "Watchtower Study")
    wt_links = section_links(page, "Watchtower Study", "Other Meeting Publications")
    if not mid_links and not wt_links:  # page layout changed: fall back to the first two documents
        links = DOC_LINK.findall(page)
        mid_links, wt_links = links[:1], links[1:2]
    midweek = songs_in(get(root + mid_links[0]) or "", 3) if mid_links else []
    time.sleep(1)
    weekend = songs_in(get(root + wt_links[0]) or "", 2) if wt_links else []
    if not midweek and not weekend:
        log(f"- week of {week_monday}: no songs found on the schedule page")
        return None
    return midweek, weekend


MEETINGS_PATH = "/meetings/r1/lp-e"


def main():
    global MEETINGS_PATH
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--weeks", type=int, default=5, help="how many weeks to fill, starting this week")
    ap.add_argument("--file", default="songs.json")
    ap.add_argument("--manifest", default="manifest.json")
    ap.add_argument("--base", default="https://wol.jw.org/en/wol",
                    help="online library for the language (English by default)")
    ap.add_argument("--meetings-path", default="/meetings/r1/lp-e")
    args = ap.parse_args()
    MEETINGS_PATH = args.meetings_path

    today = dt.date.today()
    data = {"weeks": []}
    if os.path.exists(args.file):
        with open(args.file, encoding="utf-8") as f:
            data = json.load(f)
    weeks = {w["from"]: w for w in data.get("weeks", [])}

    notes = []
    filled = []
    for k in range(args.weeks):
        wk = monday(today) + dt.timedelta(weeks=k)
        key = wk.isoformat()
        current = weeks.get(key)
        if current and current.get("source", "manual") == "manual":
            filled.append((wk, current["songs"], "set by hand, kept"))
            continue
        found = week_songs(args.base, wk, notes.append)
        if found is None:
            filled.append((wk, current["songs"] if current else [], "not published yet" if not current else "kept"))
            continue
        midweek, weekend = found
        songs = midweek + [n for n in weekend if n not in midweek]
        weeks[key] = {"from": key, "songs": songs, "source": "schedule",
                      "midweek": midweek, "weekend": weekend}
        filled.append((wk, songs, f"midweek {', '.join(map(str, midweek)) or '–'} · weekend {', '.join(map(str, weekend)) or '–'}"))
        time.sleep(1)

    oldest = monday(today) - dt.timedelta(weeks=KEEP_WEEKS)
    out = sorted((w for w in weeks.values() if dt.date.fromisoformat(w["from"]) >= oldest), key=lambda w: w["from"])
    with open(args.file, "w", encoding="utf-8") as f:
        json.dump({"weeks": out}, f, indent=1)
        f.write("\n")

    known = described_songs(args.manifest)
    lines = ["## Meeting songs from the published schedule", ""]
    for wk, songs, how in filled:
        lines.append(f"**Week of {wk.strftime('%d %B %Y')}** ({how})")
        if not songs:
            lines.append("- none yet")
        for n in songs:
            if known is None:
                lines.append(f"- Song {n}")
            elif n in known:
                lines.append(f"- ✅ {known[n]}")
            else:
                lines.append(f"- ⚠️ Song {n}: no audio-described version in the library")
        lines.append("")
    lines += notes + ["", "The song before the public talk is chosen locally; add it with the form if you like "
                      "(typing the whole list for that week keeps it as set by hand)."]
    print("\n".join(lines))


if __name__ == "__main__":
    main()
