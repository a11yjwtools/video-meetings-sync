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

- `auto.bin` (up to 40 MB): full detail for videos up to 10 minutes (songs, short clips), shortest first.
- `coarse.bin` (up to 25 MB): a thinned-out copy of every other video.

When the coarse list suggests a video, the app downloads that video's own
small file, checks it in full, and only then starts playing. Every video can
be recognised automatically; picking one from the list just skips the search.
The limits can be changed with `--auto-max-minutes`, `--auto-budget-mb` and
`--coarse-budget-mb`.

## Using it

The page has three parts:

- **Start listening.** The big button. The app finds whichever described video is playing in the room, starts it at the same moment, and keeps it in sync. The sync line under the video shows how close it is. **Resync now** makes it find the spot again.
- **Pick the video yourself.** Optional. Search the library and tap a video to sync almost instantly. The app then listens only for that one, which is faster and avoids mix-ups between similar songs. Tapping a video also starts listening.
- **Adjust timing**, plus a built-in **How it works** explanation.

Tips:

- **Use headphones.** Otherwise the phone hears its own playback and fights
  itself. Wired headphones are best. Bluetooth adds delay, which the app offsets
  where the browser reports it; the **Timing** control handles the rest.
- If the description sounds late, move **Timing** toward *Earlier*; if early,
  toward *Later*. The setting is remembered.
- Recognition usually takes 5–8 seconds after a video starts. Songs with a
  repeated chorus can take a little longer, because the app waits until
  the position is unambiguous.
- Once the app has confirmed the sync (a few seconds after it starts playing),
  it switches the microphone off and plays the described video to the end on
  its own. When it ends, the microphone switches back on and the app waits for
  the next video. **Resync now** switches the microphone on and finds the place
  again if anything seems off.
- Videos always play in the lowest available quality, to save data.

### iPhone notes

Safari requires the Start tap before it will play sound, and the app handles
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
indexer/   discover.py, build_index.py, fingerprint.py   (Python)
.github/   workflows/library.yml  (builds the library and publishes the app)
docs/      the web app (GitHub Pages root)
  js/      fingerprint.js  matcher.js  engine.js  mic-worklet.js  app.js
  data/    catalog.json, auto.bin, v/*.bin  (generated by the workflow)
tests/     fixtures generator, Node round-trip test, dev server with Range support
```

## Content and terms

The app streams the described videos from jw.org's own CDN. It never hosts
them, and the index contains only fingerprints (not audio). jw.org's Terms of
Use still restrict automated downloading and apps built on their content,
though, so read them and ask for permission before publishing this beyond
personal use.
