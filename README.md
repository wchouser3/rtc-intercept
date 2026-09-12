# RTC Intercept

A terminal app that joins a [VDO.Ninja](https://vdo.ninja) room and records each
connected guest's audio to its own high-quality `.wav` file.

## How it works

VDO.Ninja is a WebRTC app — there's no server-side "stream" to intercept, the
audio only exists as live peer connections in a browser. So this tool:

1. Launches a real (headless) Chromium browser via Playwright and joins the
   room the same way a normal viewer would (`?room=...&scene`).
2. Watches the page for each guest's `<video>`/`<audio>` element as they connect.
3. Taps each guest's `MediaStream` directly with the Web Audio API
   (`createMediaStreamSource` → an `AudioWorklet`), so we get raw float PCM
   samples rather than a re-encoded/re-recorded copy.
4. Streams those samples straight to a 32-bit float `.wav` file per guest —
   no lossy re-encoding, no shared/mixed track.

Each guest ends up as a separate, isolated recording, ready for editing.

## Install

```bash
cd rtc-intercept
npm install
```

`npm install` runs `playwright install chromium` automatically (via
`postinstall`) to download a matching browser binary. If that step gets
skipped, run it manually:

```bash
npx playwright install chromium
```

You'll also want to link the CLI so `intercept` is on your `PATH`:

```bash
npm link
```

(Or just run it directly with `node bin/intercept.js ...` / `npm start -- ...`.)

## Usage

```bash
intercept <room> [-p|--password <password>] [options]
```

Examples:

```bash
intercept mypodcast
intercept mypodcast -p s3cr3t
intercept mypodcast -p s3cr3t --out ./recordings --headful
```

Options:

| Flag | Description |
|---|---|
| `-p, --password <pass>` | Room password, if the room is protected |
| `-o, --out <dir>` | Output directory (default: `./recordings`) |
| `--headful` | Show the actual browser window instead of running headless |
| `--base-url <url>` | Use a self-hosted VDO.Ninja instance instead of vdo.ninja |
| `--no-proaudio` | Don't request `&proaudio` (raw/unprocessed audio) from senders |
| `-h, --help` | Show help |

Recordings are written to `<outDir>/<room>_<timestamp>/<guest-label>.wav`,
one file per guest, created the moment each guest's audio starts flowing and
finalized when they disconnect (or when you hit `Ctrl+C`, which finalizes
everyone still connected).

## Sync across guests

If a guest joins partway through the show, their file is padded with silence
at the start so every guest's `.wav` file starts at the same point on the
timeline (t=0 = when the recording session began) and stays in sync with
everyone else — no manual dragging of tracks needed in your editor.

This works by using a single shared clock (the browser's own `AudioContext`
clock, created the moment the room is joined, before any guest connects) as
the reference point for every guest, rather than timing things from whenever
Node happens to receive a message from the browser. In practice you should
expect sync accuracy within roughly tens of milliseconds — good enough that
tracks will line up for editing, though not bit-for-bit sample accurate (that
level of precision isn't really achievable over WebRTC anyway, since network
jitter affects when each guest's audio actually left their machine).

Note: this current version doesn't yet handle a guest **dropping and
rejoining** mid-show — that would currently produce a second file (with its
own padding) rather than one continuous file with a silent gap in the middle.
That's a reasonable next feature if you need it — flag it and I'll add it.

## Audio quality notes

- The `&proaudio` URL parameter is included by default. It asks senders to
  disable browser audio processing (echo cancellation, noise suppression,
  auto-gain) and request stereo — this is what you generally want for
  clean, editable multi-track recording rather than voice-chat-optimized audio.
- Output is 32-bit float WAV at whatever sample rate the browser's
  `AudioContext` runs at (48 kHz, matching WebRTC/Opus's native rate).
  This avoids any extra requantization — you're capturing the actual decoded
  audio, uncompressed, with no re-encoding step in between.
- The realistic ceiling on "best possible quality" here is whatever quality
  the guest's own browser encoded and sent — WebRTC audio is still Opus-encoded
  in transit. This tool captures that decoded audio losslessly from that point
  on; it doesn't (and can't) recover fidelity lost before it left the guest's
  machine.

## Known limitations / things to verify against a real room

I built and unit-tested this without live network access to vdo.ninja, so
please treat the first run against a real room as a shakedown, ideally with
`--headful` so you can see what's happening:

- **Guest detection** relies on watching for `<video>`/`<audio>` elements
  VDO.Ninja creates as guests connect. This is deliberately generic (not tied
  to specific CSS class names) so it should hold up across VDO.Ninja UI
  updates, but if a guest isn't detected, `--headful` will let you see the
  page directly and check the console log forwarded to your terminal
  (`[vdo.ninja] ...` lines).
- **Guest labels** are best-effort — the tool looks for nearby text in the DOM
  that looks like a name/label. If nothing reasonable is found it falls back
  to `guest-1`, `guest-2`, etc. If labels come out wrong or blank, that's the
  first place to adjust (`src/pageScript.js`, `guessLabel()`).
- If a guest's audio doesn't start recording immediately, it's likely because
  the `<video>`/`<audio>` element existed before its `srcObject` was attached;
  there's a periodic fallback re-scan every 2s to catch that, but if it's still
  flaky that interval is easy to tighten in `src/pageScript.js`.
- Very large rooms (many guests) will mean many concurrent `AudioWorklet`
  taps and file handles — fine for typical podcast/interview-sized rooms,
  untested at large scale.

## Project layout

```
bin/intercept.js     CLI entry point
src/cli.js            Argument parsing
src/recorder.js       Browser orchestration, room URL building, WAV lifecycle
src/pageScript.js     Code injected into the VDO.Ninja page (guest detection + audio tap)
src/wavWriter.js       Streaming 32-bit float WAV writer
```
