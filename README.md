# GRNLR_2002

A browser-based granular audio mangler designed for glossy Y2K, digital-cloud, electroclash, chopped-vocal and stutter-heavy sound design.

## Features

- Drag-and-drop MP3 / WAV / most browser-decodable audio formats
- Interactive waveform and click-to-seek grain position
- Rotary controls for grain size, density, position spray, pitch, pitch jitter, stereo spread, reverse probability and stretch
- Freeze and chaos modes
- Tempo-synced stutter/retrigger engine with divisions from 1/8 through 1/64 and triplets
- Post-grain low-pass filter, drive, delay/feedback, synthetic reverb and flange
- Sound-first presets: Digital Angel, Y2K Vocal, Broken CD, Silver Pad, Vocal Shredder, Glass Choir, Micro Stutter and Heaven Gate
- Real-time output recording and download
- No server, no API, no AI, no upload: decoding and processing happen locally in the browser

## Run locally

Because browsers restrict local media/audio behavior in some `file://` cases, run a tiny local server:

```bash
python -m http.server 8080
```

Then open:

```text
http://localhost:8080
```

## GitHub Pages

1. Create a new GitHub repository.
2. Upload `index.html`, `styles.css`, `app.js`, and this README.
3. In GitHub, open **Settings → Pages**.
4. Choose **Deploy from a branch**.
5. Select `main` and `/ (root)`.
6. Save. The app will run as a static GitHub Pages site.

## Notes

- Recording is exported as WebM/Opus because that is the browser-native real-time recording format. A future desktop/Electron version can add direct WAV rendering/export.
- The engine intentionally uses no external libraries so the first version is easy to audit, fork, host, and wrap in Electron.

## Next useful upgrades

- Proper offline WAV rendering
- 16-step glitch sequencer with per-step Repeat / Reverse / Pitch / Silence / Crush / Freeze
- Spectral blur / shimmer / chorus
- Grain envelope choices
- Keyboard/MIDI performance mode
- Preset save/load JSON
- Electron build for Windows
