"""
AudioSnap - two-screen pronunciation recording tool.
Copyright (C) 2026  Philipp Kaminski

This program is free software: you can redistribute it and/or modify
it under the terms of the GNU General Public License as published by
the Free Software Foundation, either version 3 of the License, or
(at your option) any later version.

This program is distributed in the hope that it will be useful,
but WITHOUT ANY WARRANTY; without even the implied warranty of
MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
GNU General Public License for more details.

You should have received a copy of the GNU General Public License
along with this program.  If not, see <https://www.gnu.org/licenses/>.

Run:
    pip install -r requirements.txt
    python server.py

Then open:
    Control screen : http://127.0.0.1:8765/control.html
    Display screen : http://127.0.0.1:8765/display.html
"""

import asyncio
import csv
import io
import re
import shutil
import subprocess
import tempfile
import os
from datetime import datetime, timezone
from pathlib import Path
from typing import Optional

from fastapi import FastAPI, File, Form, HTTPException, UploadFile, WebSocket, WebSocketDisconnect
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles
import uvicorn

BASE_DIR = Path(__file__).resolve().parent
STATIC_DIR = BASE_DIR / "static"
OUTPUT_DIR = BASE_DIR / "output"
SESSION_LOG_PATH = OUTPUT_DIR / "session_log.csv"
DEFAULT_CSV_PATH = BASE_DIR / "letters.csv"
SAMPLE_CSV_PATH = BASE_DIR / "letters.sample.csv"

OUTPUT_DIR.mkdir(exist_ok=True)

ID_RE = re.compile(r"^[A-Za-z0-9_\-]+$")
RECORDER_UNSAFE_RE = re.compile(r"[^A-Za-z0-9_\-]+")


# ---------------------------------------------------------------------------
# ffmpeg / ffprobe discovery
# ---------------------------------------------------------------------------

def _find_ffmpeg_family(binary_name: str, env_var: str) -> Optional[str]:
    env_path = os.environ.get(env_var)
    if env_path and Path(env_path).exists():
        return env_path

    which = shutil.which(binary_name)
    if which:
        return which

    fallbacks = [
        Path.home() / "Videos" / f"{binary_name}.exe",
        Path.home() / "AppData/Local/Programs/Shotcut" / f"{binary_name}.exe",
        Path("C:/ffmpeg/bin") / f"{binary_name}.exe",
    ]
    for candidate in fallbacks:
        if candidate.exists():
            return str(candidate)
    return None


FFMPEG = _find_ffmpeg_family("ffmpeg", "FFMPEG_PATH")
FFPROBE = None
if FFMPEG:
    sibling = Path(FFMPEG).parent / "ffprobe.exe"
    if sibling.exists():
        FFPROBE = str(sibling)
if not FFPROBE:
    FFPROBE = _find_ffmpeg_family("ffprobe", "FFPROBE_PATH")

print(f"[startup] ffmpeg  -> {FFMPEG or 'NOT FOUND'}")
print(f"[startup] ffprobe -> {FFPROBE or 'NOT FOUND'}")


def convert_to_mp3(input_path: str, output_path: str) -> None:
    if not FFMPEG:
        raise RuntimeError("ffmpeg was not found on this machine (set FFMPEG_PATH env var if it's installed somewhere unusual).")
    cmd = [FFMPEG, "-y", "-i", input_path, "-vn", "-codec:a", "libmp3lame", "-qscale:a", "2", output_path]
    result = subprocess.run(cmd, capture_output=True, text=True)
    if result.returncode != 0:
        raise RuntimeError(result.stderr[-2000:])


def get_duration_seconds(path: str) -> Optional[float]:
    if not FFPROBE:
        return None
    cmd = [FFPROBE, "-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", path]
    try:
        result = subprocess.run(cmd, capture_output=True, text=True, timeout=10)
        return round(float(result.stdout.strip()), 2)
    except Exception:
        return None


# ---------------------------------------------------------------------------
# Session state (single in-memory session; this is a local single-operator tool)
# ---------------------------------------------------------------------------

class SessionState:
    def __init__(self):
        self.characters: list[dict] = []   # [{id, character, pronunciation}]
        self.by_id: dict[str, dict] = {}
        self.current_index: Optional[int] = None
        self.recorder: str = ""
        self.status: str = "idle"       # idle | recording | paused | stopped
        self.last_saved_file: Optional[str] = None
        self.csv_name: Optional[str] = None
        self.take_counts: dict[str, int] = {}  # f"{id}|{recorder}" -> count

    def current_character(self) -> Optional[dict]:
        if self.current_index is None:
            return None
        if 0 <= self.current_index < len(self.characters):
            return self.characters[self.current_index]
        return None

    def compact(self) -> dict:
        current = self.current_character()
        return {
            "status": self.status,
            "recorder": self.recorder,
            "current_index": self.current_index,
            "total": len(self.characters),
            "csv_name": self.csv_name,
            "current": current,
            "last_saved_file": self.last_saved_file,
        }


state = SessionState()
connections: list[WebSocket] = []


def take_key(char_id: str, recorder: str) -> str:
    return f"{char_id}|{recorder}"


def output_filename(char_id: str, recorder: str) -> str:
    return f"{char_id}_{recorder}.mp3"


def sanitize_token(raw: str) -> str:
    cleaned = RECORDER_UNSAFE_RE.sub("_", raw.strip())
    cleaned = re.sub(r"_+", "_", cleaned).strip("_")
    return cleaned


def sanitize_recorder(raw: str) -> str:
    return sanitize_token(raw)


async def broadcast_state():
    payload = state.compact()
    dead = []
    for ws in connections:
        try:
            await ws.send_json(payload)
        except Exception:
            dead.append(ws)
    for ws in dead:
        if ws in connections:
            connections.remove(ws)


def append_session_log(character: dict, recorder: str, filename: str, action: str, take_number: int, duration: Optional[float]):
    is_new = not SESSION_LOG_PATH.exists()
    with open(SESSION_LOG_PATH, "a", newline="", encoding="utf-8-sig") as f:
        writer = csv.writer(f)
        if is_new:
            writer.writerow(["timestamp", "id", "character", "recorder", "filename", "action", "take_number", "duration_sec"])
        writer.writerow([
            datetime.now(timezone.utc).isoformat(),
            character["id"],
            character["character"],
            recorder,
            filename,
            action,
            take_number,
            duration if duration is not None else "",
        ])


# ---------------------------------------------------------------------------
# CSV loading
# ---------------------------------------------------------------------------

def parse_characters_csv(raw_bytes: bytes, name: str) -> list[dict]:
    text = raw_bytes.decode("utf-8-sig")
    reader = csv.DictReader(io.StringIO(text))
    if not reader.fieldnames:
        raise ValueError("CSV has no header row.")

    normalized = {h.strip().lower(): h for h in reader.fieldnames}
    for required in ("id", "character", "pronunciation"):
        if required not in normalized:
            raise ValueError(f"CSV is missing required column '{required}'. Found columns: {reader.fieldnames}")

    id_col = normalized["id"]
    character_col = normalized["character"]
    pron_col = normalized["pronunciation"]

    rows = []
    seen_ids = set()
    errors = []
    for i, raw_row in enumerate(reader, start=2):  # header is row 1
        rid = (raw_row.get(id_col) or "").strip()
        character = (raw_row.get(character_col) or "").strip()
        pron = (raw_row.get(pron_col) or "").strip()

        if not rid:
            errors.append(f"Row {i}: empty id")
            continue
        if not ID_RE.match(rid):
            errors.append(f"Row {i}: id '{rid}' has characters that aren't filename-safe (use letters, digits, - or _)")
            continue
        if rid in seen_ids:
            errors.append(f"Row {i}: duplicate id '{rid}'")
            continue
        if not character:
            errors.append(f"Row {i}: empty character")
            continue

        seen_ids.add(rid)
        rows.append({"id": rid, "character": character, "pronunciation": pron})

    if errors:
        raise ValueError("CSV has problems:\n" + "\n".join(errors))
    if not rows:
        raise ValueError("CSV has no valid rows.")

    return rows


def load_characters_from_bytes(raw_bytes: bytes, name: str):
    rows = parse_characters_csv(raw_bytes, name)
    state.characters = rows
    state.by_id = {r["id"]: r for r in rows}
    state.current_index = None
    state.status = "idle"
    state.recorder = ""
    state.last_saved_file = None
    state.csv_name = name


def try_autoload_default_csv():
    for path in (DEFAULT_CSV_PATH, SAMPLE_CSV_PATH):
        if path.exists():
            try:
                load_characters_from_bytes(path.read_bytes(), path.name)
                print(f"[startup] auto-loaded {path.name} ({len(state.characters)} characters)")
                return
            except Exception as exc:
                print(f"[startup] failed to auto-load {path.name}: {exc}")


try_autoload_default_csv()


# ---------------------------------------------------------------------------
# App
# ---------------------------------------------------------------------------

app = FastAPI()


def require_characters_loaded():
    if not state.characters:
        raise HTTPException(400, "No CSV loaded yet.")


@app.get("/api/state")
async def api_state():
    return JSONResponse(state.compact())


@app.get("/api/characters")
async def api_characters():
    require_characters_loaded()
    recorder = state.recorder
    result = []
    for idx, row in enumerate(state.characters):
        fname = output_filename(row["id"], recorder) if recorder else None
        recorded = bool(fname and (OUTPUT_DIR / fname).exists())
        result.append({
            "index": idx,
            "id": row["id"],
            "character": row["character"],
            "pronunciation": row["pronunciation"],
            "recorded": recorded,
        })
    return {"recorder": recorder, "characters": result}


@app.post("/api/load_csv")
async def api_load_csv(file: UploadFile = File(...)):
    raw = await file.read()
    try:
        load_characters_from_bytes(raw, file.filename)
    except ValueError as exc:
        raise HTTPException(400, str(exc))
    await broadcast_state()
    return {"ok": True, "count": len(state.characters), "csv_name": state.csv_name}


@app.post("/api/set_recorder")
async def api_set_recorder(recorder: str = Form(...)):
    if state.status in ("recording", "paused"):
        raise HTTPException(400, "Stop the current session before changing the recorder.")
    cleaned = sanitize_recorder(recorder)
    if not cleaned:
        raise HTTPException(400, "Recorder label is empty after removing unsafe characters.")
    state.recorder = cleaned
    state.status = "idle"
    state.current_index = None
    state.last_saved_file = None
    await broadcast_state()
    return {"ok": True, "recorder": cleaned}


@app.get("/api/first_unrecorded")
async def api_first_unrecorded():
    require_characters_loaded()
    if not state.recorder:
        raise HTTPException(400, "Set a recorder label first.")
    for idx, row in enumerate(state.characters):
        fname = output_filename(row["id"], state.recorder)
        if not (OUTPUT_DIR / fname).exists():
            return {"index": idx}
    return {"index": None}


@app.post("/api/start")
async def api_start(target_index: int = Form(...)):
    require_characters_loaded()
    if not state.recorder:
        raise HTTPException(400, "Set a recorder label first.")
    if state.status in ("recording", "paused"):
        raise HTTPException(400, "A session is already running. Stop it first.")
    if not (0 <= target_index < len(state.characters)):
        raise HTTPException(400, "target_index out of range.")
    state.current_index = target_index
    state.status = "recording"
    await broadcast_state()
    return JSONResponse(state.compact())


def _parse_target_index(raw: str) -> Optional[int]:
    if raw is None or raw == "" or raw.lower() == "null":
        return None
    return int(raw)


@app.post("/api/finalize_take")
async def api_finalize_take(
    file: UploadFile = File(...),
    target_index: Optional[str] = Form(None),
    status_after: str = Form(...),
    action: str = Form(...),
):
    if state.status != "recording":
        raise HTTPException(400, f"Cannot finalize a take while status is '{state.status}'.")
    character = state.current_character()
    if character is None:
        raise HTTPException(400, "No current character.")
    if status_after not in ("recording", "paused", "stopped"):
        raise HTTPException(400, "Invalid status_after.")

    parsed_target = _parse_target_index(target_index)
    if parsed_target is not None and not (0 <= parsed_target < len(state.characters)):
        raise HTTPException(400, "target_index out of range.")

    raw_bytes = await file.read()
    fname = output_filename(character["id"], state.recorder)
    out_path = OUTPUT_DIR / fname

    with tempfile.NamedTemporaryFile(suffix=".webm", delete=False) as tmp:
        tmp.write(raw_bytes)
        tmp_path = tmp.name

    try:
        await asyncio.to_thread(convert_to_mp3, tmp_path, str(out_path))
    except RuntimeError as exc:
        raise HTTPException(500, f"ffmpeg conversion failed: {exc}")
    finally:
        try:
            os.remove(tmp_path)
        except OSError:
            pass

    duration = await asyncio.to_thread(get_duration_seconds, str(out_path))

    key = take_key(character["id"], state.recorder)
    state.take_counts[key] = state.take_counts.get(key, 0) + 1
    append_session_log(character, state.recorder, fname, action, state.take_counts[key], duration)

    state.last_saved_file = fname
    if parsed_target is not None:
        state.current_index = parsed_target
    state.status = status_after

    await broadcast_state()
    return JSONResponse(state.compact())


@app.post("/api/advance_only")
async def api_advance_only(target_index: Optional[str] = Form(None), status_after: str = Form(...)):
    if state.status != "paused":
        raise HTTPException(400, "advance_only is only valid while paused (nothing new was recorded).")
    if status_after not in ("recording", "stopped"):
        raise HTTPException(400, "Invalid status_after.")

    parsed_target = _parse_target_index(target_index)
    if parsed_target is not None and not (0 <= parsed_target < len(state.characters)):
        raise HTTPException(400, "target_index out of range.")

    if parsed_target is not None:
        state.current_index = parsed_target
    state.status = status_after
    await broadcast_state()
    return JSONResponse(state.compact())


@app.post("/api/redo")
async def api_redo():
    if state.status not in ("recording", "paused"):
        raise HTTPException(400, "Nothing to redo.")
    if state.status != "recording":
        state.status = "recording"
        await broadcast_state()
    return JSONResponse(state.compact())


@app.post("/api/continue")
async def api_continue():
    if state.status != "paused":
        raise HTTPException(400, "Not paused.")
    state.status = "recording"
    await broadcast_state()
    return JSONResponse(state.compact())


@app.websocket("/ws")
async def ws_endpoint(websocket: WebSocket):
    await websocket.accept()
    connections.append(websocket)
    try:
        await websocket.send_json(state.compact())
        while True:
            await websocket.receive_text()
    except WebSocketDisconnect:
        pass
    finally:
        if websocket in connections:
            connections.remove(websocket)


app.mount("/output", StaticFiles(directory=str(OUTPUT_DIR)), name="output")
app.mount("/", StaticFiles(directory=str(STATIC_DIR), html=True), name="static")


if __name__ == "__main__":
    print("Control screen : http://127.0.0.1:8765/control.html")
    print("Display screen : http://127.0.0.1:8765/display.html")
    uvicorn.run(app, host="127.0.0.1", port=8765, log_level="info")
