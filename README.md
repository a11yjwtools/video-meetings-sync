# Described

A web app that listens to a video playing in the room, recognises it, and plays
the **audio-described** version in sync, so someone with headphones can follow
along with the description. Recognition runs entirely on the phone; the site is
static and can be hosted on GitHub Pages.

## How it works

1. **Indexer (Python, run on your computer).** For every audio-described video,
   it fingerprints the *original* video's soundtrack (what the phone will hear)
   and aligns it to the described version, producing a time map. Output goes to
   `docs/data/`: `catalog.json` (titles, video URLs, time maps), `auto.bin`
   (fingerprints of the shorter videos, which are recognised automatically) and
   `v/<n>.bin` (one small file per video, downloaded only when that video is
   picked from the list).
2. **Web app (`docs/`).** It records the microphone, fingerprints the last 10
   seconds every second, and looks them up in the index. Once two matches in a
   row agree, it opens the described video at the matching position.
3. **Staying in sync.** Every match refines the timing. Small drift is fixed by
   nudging the playback speed (at most 7%, which isn't noticeable); larger
   errors trigger a seek. When the described version contains extra
   narration that the original doesn't have, the app skips it so it stays
   with the room.

## Build the library and publish (nothing to install)

GitHub builds the fingerprint library on its own servers and publishes the app.

1. Create a new repository on GitHub and upload this project to it (the
   **Add file → Upload files** button accepts the whole folder, including
   the hidden `.github` folder; if your browser skips it, create
   `.github/workflows/library.yml` by hand and paste the file in).
2. Go to **Settings → Pages** and set **Source** to **GitHub Actions**.
3. Go to the **Actions** tab, choose **Build library and publish app**, and
   click **Run workflow**. Leave *rediscover* ticked the first time.
4. Wait for it to finish; the first run downloads every video once, so it can
   take a while. The run's summary page shows how many videos were
   added and lists any problems. The app's address appears on the
   **deploy** step, usually `https://<you>.github.io/<repo>/`.

After that:

- **New videos are picked up automatically.** The workflow runs again every
  Monday, adds new described videos, and republishes. Downloaded audio is
  cached, so weekly runs are quick.
- **Fixing a pairing by hand:** the workflow saves `manifest.json` in the
  repository. Open it on GitHub, click the pencil icon, and for any entry under
  `"unpaired"` fill in `"original"` with the original video's download link.
  Then run the workflow again. Your edits are kept on every later run.
- **Another language:** run the workflow with a different language code
  (for example `S` for Spanish).

## Build the library on your own computer (optional)

Requires Python 3.9+ and [ffmpeg](https://ffmpeg.org/) on your PATH.

```bash
cd indexer
pip install -r requirements.txt
python discover.py --out ../manifest.json --merge ../manifest.json
python build_index.py ../manifest.json
```

Check the log from the last step. Each video should show one aligned segment,
or several if the described version adds narration pauses. `could not align`
means the pair is probably wrong.

## Try it locally

```bash
python tests/serve.py            # then open http://localhost:8000/docs/
```

`localhost` is allowed to use the microphone without HTTPS. Play one of the
original videos from another device (a TV, a laptop) and press **Start listening**.

### Offline self-test (no jw.org needed)

```bash
python tests/make_fixture.py
python indexer/build_index.py tests/fixtures/manifest.json --out tests/fixtures/data --auto-max-minutes 1.2 --coarse-budget-mb 0.02
node tests/roundtrip.mjs         # recognition accuracy in simulated rooms
python tests/serve.py            # open http://localhost:8000/docs/?data=../tests/fixtures/data/
```

For the demo page, play `tests/fixtures/song_a.wav` out loud from another device.

## Size limits

The fingerprint files are not stored in the repository. The workflow
publishes them straight to GitHub Pages, which allows 1 GB per site. The
phone downloads two lists when the app opens:

- `auto/*.bin` (up to 40 MB): full detail for videos up to 10 minutes (songs, short clips), shortest first.
- `coarse/*.bin` (up to 25 MB): a thinned-out copy of every other video.

After the first visit these stay on the phone (see *Install it like an app*),
so repeat visits cost almost no bandwidth, even with many users.

When the coarse list suggests a video, the app downloads that video's own
small file, checks it in full, and only then starts playing. Every video can
be recognised automatically; picking one from the list just skips the search.
The limits can be changed with `--auto-max-minutes`, `--auto-budget-mb` and
`--coarse-budget-mb`.

## Meeting songs (set once a week)

Songs are hardest to catch, because once everyone starts singing the room is
mostly voices. Tell the app which songs are coming, and every phone listens for
those first and recognises them on much less evidence, usually during the
instrumental introduction.

1. On GitHub, open **Actions → Set meeting songs → Run workflow**.
2. Type the song numbers for the week, for example `12, 45, 151, 3, 98`
   (both meetings together). Optionally type a date to set a future week.
3. Click **Run workflow**. The run's summary confirms which songs have an
   audio-described version.

Every phone picks the list up within a few minutes (when the app is opened or
brought back to the screen); the library is not rebuilt. A list is used for its
week and up to 10 days after its Monday. The songs also appear in the app under
**This week's songs** for quick manual choice. They are stored in `songs.json`.

Without a list the app still gives songs priority: a song heard near its
beginning is accepted on less evidence if it keeps winning. In tests with loud
congregation singing in an echoey hall, songs were found in 9 of 10 cases
without a list and 10 of 10 with one (most within 4–8 seconds), with no false
alarms on talks or other music.

## Install it like an app

**Share one link:** send people the app's address (for example
`https://<you>.github.io/<repo>/`). When they open it on a phone, the first
screen walks them through installing it:

- **Android (Chrome):** an **Install Described** button.
- **iPhone (Safari):** screen-reader-friendly steps for *Share → Add to Home Screen*
  (Apple doesn't allow an install button).
- **Opened inside WhatsApp, Facebook, Instagram…:** those built-in browsers can't
  install apps, so the page offers **Open in Chrome** (Android) or **Copy the link**
  with steps for Safari (iPhone).
- **Continue without installing** uses it in the browser instead.

When the installed app opens, its first question is **Allow the microphone**,
with a short explanation; if the microphone was refused before, it explains
how to turn it back on.


Described can be installed on a phone's home screen, like a regular app:

- **Android (Chrome):** open the app's address and tap **Install** in the app (or *Add to Home screen* in Chrome's menu).
- **iPhone (Safari):** open the app's address, tap the **Share** button, then **Add to Home Screen**.

Once opened, the app keeps itself and its video library on the phone. It
starts instantly and works on poor Wi-Fi; the sound still streams from
jw.org, so an internet connection is needed to play. When the library is
updated, the phone downloads only the pieces that changed (the library is
split into pieces of 25 videos). App updates are picked up in the
background and apply the next time the app is opened.

## Using it (designed for blind and low-vision users)

The app is one short screen, built for VoiceOver (iPhone) and TalkBack (Android):

- **Headings** to jump between parts: *Listen*, *Choose a video*, *Settings*, *Install the app*, *How to use*.
- **One main button** right after the title: *Start listening* / *Stop listening*.
- **Quiet by design:** the screen reader only speaks at the moments that matter: listening started, *Playing …* when a video is found, *Video finished*, and problems. In-between updates stay on screen only, so speech never talks over the description.
- **Headphone and lock-screen controls:** pause stops the description, play finds your place again.
- **Vibration** (Android) when a video is found and when it ends; can be switched off in Settings.
- **Text follows the phone's text-size setting**; nothing scrolls sideways even at the largest sizes. High contrast in dark and light mode; big touch targets; animations respect *Reduce motion*.
- **Settings are remembered:** headphones (wired or Bluetooth, which adds 150 ms to make up for Bluetooth delay) and timing (*Earlier* / *Later* in 20 ms steps).

Tips:

- **Use headphones**, otherwise the phone hears its own sound.
- Once in sync, the microphone switches off and the description plays to the end; then the app listens for the next video. **Find my place again** switches the microphone back on if needed.
- Only the sound of the described version is played, in the second-lowest quality: smooth playback, good sound, little data.

### iPhone notes

Safari requires the starting tap before it will play sound, and the app handles
that. With the microphone active, iOS may route sound to the earpiece unless
headphones are connected, which is another reason to use headphones. Keep the
page open; iOS pauses web audio when the screen locks. The app requests a
wake lock to prevent that.

## Tuning

`docs/js/engine.js` → `TUNING` controls recognition thresholds and sync
behaviour. Fingerprint parameters live in **both** `indexer/fingerprint.py`
and `docs/js/fingerprint.js`. They must match; the app refuses to load an index
built with different values. After changing them, rebuild the index and run
`node tests/roundtrip.mjs`.

## Project layout

```
indexer/   discover.py, build_index.py, fingerprint.py, set_songs.py   (Python)
songs.json this week's meeting songs (set with the "Set meeting songs" workflow)
.github/   workflows/library.yml  (builds the library and publishes the app)
           workflows/songs.yml    (the "Set meeting songs" form)
docs/      the web app (GitHub Pages root)
  js/      fingerprint.js  matcher.js  engine.js  mic-worklet.js  app.js
  data/    catalog.json, auto/, coarse/, v/  (generated by the workflow)
  sw.js    offline support; its VERSION is stamped by build_index.py
  icons/   app icons
tests/     fixtures generator, Node round-trip test, dev server with Range support
```

## Content and terms

The app streams the described videos from jw.org's own CDN. It never hosts
them, and the index contains only fingerprints (not audio). jw.org's Terms of
Use still restrict automated downloading and apps built on their content,
though, so read them and ask for permission before publishing this beyond
personal use.
