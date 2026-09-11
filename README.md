# AudioSnap - Pronunciation Recording Tool

A two-screen tool for recording labeled audio, one entry at a time, from a CSV list. It was built for large character sets (a syllabary or alphabet with thousands of entries), but an entry isn't limited to a single glyph — it can just as well be a whole word, a phrase, or a full sentence. Anything you can put in a CSV cell and want a clean, individually-named recording of works here.

- **Screen 1 (control)**: the operator drives the session — pick an entry, start/stop recording, redo takes, review waveforms and playback.
- **Screen 2 (recordee)**: a clean full-screen display showing only the current entry's text and its pronunciation/gloss, updating live as the operator moves through the list.
- Each take is saved as its own `.mp3`, named after the entry's `id` and the recorder's label.

It's a local web app: a small Python server on one machine, opened as two browser windows (drag one to each monitor).

## Prerequisites

- **Python 3.9+**
- **ffmpeg** (with `ffprobe`, which normally ships alongside it) — used to convert recordings to mp3 and to read their duration for the session log.
  - The server looks for `ffmpeg`/`ffprobe` on your `PATH` first. If they're installed somewhere else, set the `FFMPEG_PATH` environment variable to the full path of `ffmpeg.exe` (`ffprobe.exe` is expected in the same folder).
- **A Chromium-based browser** (Chrome or Edge) — needed for microphone capture (`getUserMedia`/`MediaRecorder`) and the live waveform preview.
- **Hardware**: one machine with two monitors (extended desktop) and one microphone. Both browser windows run on the same computer; you just drag one window to each screen.

## Setup

```bash
git clone https://github.com/DerWahrePhilipp/AudioSnap
cd AudioSnap
pip install -r requirements.txt
```

Confirm ffmpeg is reachable:

```bash
ffmpeg -version
```

If that fails, either add ffmpeg to your `PATH` or set `FFMPEG_PATH` to its full location before starting the server.

## Running

```bash
python server.py
```

The server prints two URLs:

- Control screen: `http://127.0.0.1:8765/control.html` — open on your monitor.
- Display screen: `http://127.0.0.1:8765/display.html` — open in a second window, drag it to the recordee's monitor, and fullscreen it.

## CSV format

The input CSV needs exactly these three columns (case-insensitive header names, any order):

| Column          | Meaning                                                                 |
|-----------------|--------------------------------------------------------------------------|
| `id`            | A short, filename-safe, **unique** identifier (letters, digits, `-`, `_` only). Used to name the output file. |
| `character`     | The text shown to the recordee for this entry. Despite the name, there's no length limit — a single letter, a word, a phrase, even a full sentence all work. |
| `pronunciation` | The pronunciation/gloss/translation shown alongside it.                  |

Example (`letters.sample.csv`) — single characters:

```csv
id,character,pronunciation
0001,A,ay
0002,B,bee
```

It works just as well for longer entries:

```csv
id,character,pronunciation
0001,Good morning,"greeting, used before noon"
0002,See you tomorrow,"farewell, casual"
```

The CSV is rejected (with a clear per-row error) if `id` is empty, not filename-safe, or duplicated, or if `character` is empty. A ready-made example is included: [`letters.sample.csv`](letters.sample.csv).

## Using the tool

1. **Load a CSV** — use the file picker at the top of the control screen (or drop `letters.csv` next to `server.py` before starting the server to have it auto-load).
2. **Set a recorder label** — a short name/initials identifying who's being recorded (e.g. `A`, `Philipp`). This becomes part of every output filename, and can be changed between sessions (e.g. to record the same list with a different person).
3. **Enable the microphone** — click "Enable Microphone" once and allow the browser's permission prompt. A live input-level meter confirms it's picking up sound.
4. **Pick a character** — click any row in the list on the left to select it (this only highlights it — nothing starts recording yet). The center panel shows:
   - **Start from here** — begins recording at the selected character.
   - **Retake recording** — re-records a character that already has a take (same action, enabled only once it's recorded).
   - **Play recording** — plays back the selected character's saved take.
   - Every row also has its own small ▶ play button and a waveform preview (live while recording, or loaded from disk once you've scrolled to it).
5. **During a session**, the control screen shows:
   - **Break** — stops and saves the current character's take, and pauses (the display screen shows "Paused"). **Continue** starts a fresh take for the same character; pressing **Next** directly after a Break (without Continue) just keeps the take Break already saved.
   - **Previous** / **Next** (hotkeys `p` / `n`) — finalizes the current take and moves to the adjacent character.
   - **Redo character** — discards the current take and starts over on the same character.
   - **Jump to selected** — finalizes the current take and jumps to whatever character you've clicked in the list.
   - **Stop** — finalizes the current take and ends the session.
   - **Jump to first unrecorded** (also available before starting) — finds the first character with no take yet for the current recorder and starts there.

## Output

Recordings are saved to `output/<id>_<recorder>.mp3`. A running `output/session_log.csv` logs every saved take (timestamp, id, character, recorder, filename, action, take number, duration).

## Troubleshooting

- **"ffmpeg was not found on this machine"** — install ffmpeg, or set `FFMPEG_PATH` to its full path before starting the server.
- **Microphone permission denied** — check your browser's site permissions for `127.0.0.1:8765` and retry "Enable Microphone".
- **CSV won't load** — the error message lists the exact row(s) and reason (empty/duplicate/unsafe `id`, empty `character`, missing column).

## How to cite

If you use AudioSnap to collect data for a paper, you can cite it as:

> Kaminski, P. (2026). *AudioSnap: A two-screen pronunciation recording tool* [Computer software]. https://github.com/DerWahrePhilipp/AudioSnap

BibTeX:

```bibtex
@software{kaminski2026audiosnap,
  author = {Kaminski, Philipp},
  title  = {AudioSnap: A Two-Screen Pronunciation Recording Tool},
  year   = {2026},
  url    = {https://github.com/DerWahrePhilipp/AudioSnap}
}
```

## License

GPLv3 — see [LICENSE](LICENSE). Copyright (C) 2026 Philipp Kaminski.
