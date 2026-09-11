// --- element refs -----------------------------------------------------
const csvFileInput = document.getElementById("csv-file");
const csvStatus = document.getElementById("csv-status");
const recorderInput = document.getElementById("recorder-input");
const setRecorderBtn = document.getElementById("set-recorder-btn");
const recorderStatus = document.getElementById("recorder-status");
const enableMicBtn = document.getElementById("enable-mic-btn");
const levelBar = document.getElementById("level-bar");

const progressCount = document.getElementById("progress-count");
const progressList = document.getElementById("progress-list");

const preSessionControls = document.getElementById("pre-session-controls");
const sessionControls = document.getElementById("session-controls");

const selectedInfo = document.getElementById("selected-info");
const startFromSelectedBtn = document.getElementById("start-from-selected-btn");
const retakeBtn = document.getElementById("retake-btn");
const playSelectedBtn = document.getElementById("play-selected-btn");
const jumpFirstUnrecordedBtn = document.getElementById("jump-first-unrecorded-btn");

const breakBtn = document.getElementById("break-btn");
const continueBtn = document.getElementById("continue-btn");
const previousBtn = document.getElementById("previous-btn");
const nextBtn = document.getElementById("next-btn");
const redoBtn = document.getElementById("redo-btn");
const jumpToSelectedBtn = document.getElementById("jump-to-selected-btn");
const stopBtn = document.getElementById("stop-btn");

const playbackBtn = document.getElementById("playback-btn");
const playbackAudio = document.getElementById("playback-audio");

const sessionStatusEl = document.getElementById("session-status");
const errorBanner = document.getElementById("error-banner");

// --- app state ----------------------------------------------------------
let serverState = { status: "idle", recorder: "", current_index: null, total: 0, current: null, last_saved_file: null, csv_name: null };
let characterRows = [];
let selectedIndex = null;

let micStream = null;
let micReady = false;
let mimeType = "";
let mediaRecorder = null;
let recordedChunks = [];
let hasUnsavedAudio = false;

// --- waveform previews ----------------------------------------------------
const WAVE_BUCKETS = 28;
const waveformCache = new Map();       // character id -> Array<0..1> (peak per bucket)
const pendingWaveformFetches = new Set();
let liveTakePeaks = [];                // raw {min,max} samples for the in-progress take
let isRecordingLive = false;
let currentRowCanvas = null;
let waveformObserver = null;
let decodeAudioCtx = null;

function downsamplePeakPairs(rawPeaks, bucketCount = WAVE_BUCKETS) {
  const buckets = new Array(bucketCount).fill(0);
  if (rawPeaks.length === 0) return buckets;
  const each = rawPeaks.length / bucketCount;
  for (let b = 0; b < bucketCount; b++) {
    const start = Math.floor(b * each);
    const end = Math.max(start + 1, Math.floor((b + 1) * each));
    let amp = 0;
    for (let i = start; i < end && i < rawPeaks.length; i++) {
      amp = Math.max(amp, Math.abs(rawPeaks[i].min), Math.abs(rawPeaks[i].max));
    }
    buckets[b] = amp;
  }
  return buckets;
}

function downsampleChannelData(channel, bucketCount = WAVE_BUCKETS) {
  const buckets = new Array(bucketCount).fill(0);
  const each = channel.length / bucketCount;
  for (let b = 0; b < bucketCount; b++) {
    const start = Math.floor(b * each);
    const end = Math.max(start + 1, Math.floor((b + 1) * each));
    let amp = 0;
    for (let i = start; i < end && i < channel.length; i++) {
      const v = Math.abs(channel[i]);
      if (v > amp) amp = v;
    }
    buckets[b] = amp;
  }
  return buckets;
}

function drawWaveform(canvas, buckets) {
  if (!canvas) return;
  const ctx = canvas.getContext("2d");
  const w = canvas.width, h = canvas.height;
  ctx.clearRect(0, 0, w, h);
  if (!buckets || !buckets.length) return;
  const barW = w / buckets.length;
  ctx.fillStyle = "#2f6fed";
  for (let i = 0; i < buckets.length; i++) {
    const amp = Math.min(1, buckets[i]);
    const barH = Math.max(1, amp * (h - 2));
    ctx.fillRect(i * barW, (h - barH) / 2, Math.max(1, barW - 1), barH);
  }
}

function getWaveformCanvasFor(rowId) {
  return progressList.querySelector(`.progress-item[data-id="${CSS.escape(rowId)}"] .pwave`);
}

function getDecodeAudioCtx() {
  if (!decodeAudioCtx) {
    const AudioCtx = window.AudioContext || window.webkitAudioContext;
    decodeAudioCtx = new AudioCtx();
  }
  return decodeAudioCtx;
}

async function loadWaveformFallback(rowId, canvas) {
  if (waveformCache.has(rowId) || pendingWaveformFetches.has(rowId) || !serverState.recorder) return;
  pendingWaveformFetches.add(rowId);
  try {
    const url = "/output/" + encodeURIComponent(`${rowId}_${serverState.recorder}.mp3`);
    const res = await fetch(url);
    if (!res.ok) return;
    const arrayBuf = await res.arrayBuffer();
    const audioBuf = await getDecodeAudioCtx().decodeAudioData(arrayBuf);
    const buckets = downsampleChannelData(audioBuf.getChannelData(0));
    waveformCache.set(rowId, buckets);
    const liveCanvas = canvas.isConnected ? canvas : getWaveformCanvasFor(rowId);
    drawWaveform(liveCanvas, buckets);
  } catch (err) {
    // no audio yet / not decodable -- leave the sparkline blank
  } finally {
    pendingWaveformFetches.delete(rowId);
  }
}

function setupWaveformObserver() {
  if (waveformObserver) return;
  waveformObserver = new IntersectionObserver((entries) => {
    for (const entry of entries) {
      if (!entry.isIntersecting) continue;
      const el = entry.target;
      const rowId = el.dataset.id;
      const recorded = el.dataset.recorded === "1";
      if (recorded) loadWaveformFallback(rowId, el.querySelector(".pwave"));
    }
  }, { root: progressList, rootMargin: "200px 0px" });
}

// --- helpers --------------------------------------------------------------
function showError(msg) {
  errorBanner.textContent = msg;
  errorBanner.hidden = false;
  clearTimeout(showError._t);
  showError._t = setTimeout(() => { errorBanner.hidden = true; }, 8000);
}

async function postForm(url, fields) {
  const form = new FormData();
  for (const k in fields) form.append(k, fields[k]);
  const res = await fetch(url, { method: "POST", body: form });
  if (!res.ok) {
    const text = await res.text();
    showError(text);
    throw new Error(text);
  }
  return res.json();
}

async function postEmpty(url) {
  const res = await fetch(url, { method: "POST" });
  if (!res.ok) {
    const text = await res.text();
    showError(text);
    throw new Error(text);
  }
  return res.json();
}

async function uploadFinalize(blob, targetIndexOrNull, statusAfter, action) {
  const form = new FormData();
  form.append("file", blob, "take.webm");
  form.append("target_index", targetIndexOrNull === null ? "null" : String(targetIndexOrNull));
  form.append("status_after", statusAfter);
  form.append("action", action);
  const res = await fetch("/api/finalize_take", { method: "POST", body: form });
  if (!res.ok) {
    const text = await res.text();
    showError(text);
    throw new Error(text);
  }
  return res.json();
}

// --- microphone / recording ------------------------------------------------
function pickMimeType() {
  const candidates = ["audio/webm;codecs=opus", "audio/webm", "audio/ogg;codecs=opus"];
  for (const c of candidates) {
    if (window.MediaRecorder && MediaRecorder.isTypeSupported(c)) return c;
  }
  return "";
}

async function enableMic() {
  try {
    micStream = await navigator.mediaDevices.getUserMedia({ audio: true });
  } catch (err) {
    showError("Could not access the microphone: " + err.message);
    return;
  }
  mimeType = pickMimeType();
  micReady = true;
  enableMicBtn.textContent = "Microphone enabled";
  enableMicBtn.disabled = true;
  setupLevelMeter(micStream);
  updateButtonAvailability();
}

function setupLevelMeter(stream) {
  const AudioCtx = window.AudioContext || window.webkitAudioContext;
  const audioCtx = new AudioCtx();
  const source = audioCtx.createMediaStreamSource(stream);
  const analyser = audioCtx.createAnalyser();
  analyser.fftSize = 512;
  source.connect(analyser);
  const data = new Uint8Array(analyser.frequencyBinCount);

  function tick() {
    analyser.getByteTimeDomainData(data);
    let sum = 0;
    let mn = 1, mx = -1;
    for (let i = 0; i < data.length; i++) {
      const v = (data[i] - 128) / 128;
      sum += v * v;
      if (v < mn) mn = v;
      if (v > mx) mx = v;
    }
    const rms = Math.sqrt(sum / data.length);
    const pct = Math.min(100, Math.round(rms * 300));
    levelBar.style.width = pct + "%";

    if (isRecordingLive) {
      liveTakePeaks.push({ min: mn, max: mx });
      if (!currentRowCanvas || !currentRowCanvas.isConnected) {
        currentRowCanvas = progressList.querySelector(".progress-item.current .pwave");
      }
      if (currentRowCanvas) drawWaveform(currentRowCanvas, downsamplePeakPairs(liveTakePeaks));
    }

    requestAnimationFrame(tick);
  }
  tick();
}

function startRecorder() {
  recordedChunks = [];
  mediaRecorder = new MediaRecorder(micStream, mimeType ? { mimeType } : undefined);
  mediaRecorder.ondataavailable = (e) => {
    if (e.data && e.data.size > 0) recordedChunks.push(e.data);
  };
  mediaRecorder.start();
  hasUnsavedAudio = true;
  liveTakePeaks = [];
  isRecordingLive = true;
  currentRowCanvas = null;
}

function stopRecorderAndGetBlob() {
  isRecordingLive = false;
  return new Promise((resolve) => {
    mediaRecorder.onstop = () => resolve(new Blob(recordedChunks, { type: mimeType || "audio/webm" }));
    mediaRecorder.stop();
  });
}

function stopRecorderAndDiscard() {
  isRecordingLive = false;
  return new Promise((resolve) => {
    mediaRecorder.onstop = () => resolve();
    mediaRecorder.stop();
  });
}

// --- CSV loading ------------------------------------------------------------
csvFileInput.addEventListener("change", async () => {
  const f = csvFileInput.files[0];
  if (!f) return;
  const form = new FormData();
  form.append("file", f);
  const res = await fetch("/api/load_csv", { method: "POST", body: form });
  if (!res.ok) {
    showError(await res.text());
    return;
  }
  const data = await res.json();
  csvStatus.textContent = `${data.csv_name} (${data.count} characters)`;
  recorderStatus.textContent = "";
  waveformCache.clear();
  await refreshCharacters();
  updateButtonAvailability();
});

// --- recorder label -----------------------------------------------------
setRecorderBtn.addEventListener("click", async () => {
  const val = recorderInput.value;
  if (!val || !val.trim()) {
    showError("Enter a recorder label first.");
    return;
  }
  const data = await postForm("/api/set_recorder", { recorder: val });
  recorderInput.value = data.recorder;
  recorderStatus.textContent = `Recorder set: ${data.recorder}`;
  waveformCache.clear();
  await refreshCharacters();
  updateButtonAvailability();
});

// --- progress list ------------------------------------------------------
async function refreshCharacters() {
  if (!serverState.csv_name) return;
  const res = await fetch("/api/characters");
  if (!res.ok) return;
  const data = await res.json();
  characterRows = data.characters;
  if (selectedIndex === null || selectedIndex >= characterRows.length) {
    selectedIndex = characterRows.length ? 0 : null;
  }
  renderProgressList();
}

function renderProgressList() {
  progressCount.textContent = characterRows.length ? `(${characterRows.filter(r => r.recorded).length}/${characterRows.length} recorded)` : "";
  progressList.innerHTML = "";
  setupWaveformObserver();
  waveformObserver.disconnect();
  const frag = document.createDocumentFragment();
  for (const row of characterRows) {
    const div = document.createElement("div");
    div.className = "progress-item" +
      (row.recorded ? " recorded" : "") +
      (row.index === serverState.current_index ? " current" : "") +
      (row.index === selectedIndex ? " selected" : "");
    div.dataset.id = row.id;
    div.dataset.index = row.index;
    div.dataset.recorded = row.recorded ? "1" : "0";
    div.innerHTML = `<span class="pid">${escapeHtml(row.id)}</span><span class="pchar">${escapeHtml(row.character)}</span><span class="ppron">${escapeHtml(row.pronunciation)}</span><button class="prow-play" type="button" title="Play recording" ${row.recorded ? "" : "disabled"}>&#9654;</button><canvas class="pwave" width="60" height="20"></canvas>`;
    div.addEventListener("click", () => selectRow(row.index));
    div.querySelector(".prow-play").addEventListener("click", (e) => {
      e.stopPropagation();
      playRow(row);
    });
    frag.appendChild(div);

    if (waveformCache.has(row.id)) {
      drawWaveform(div.querySelector(".pwave"), waveformCache.get(row.id));
    } else if (row.recorded) {
      waveformObserver.observe(div);
    }
  }
  progressList.appendChild(frag);
  renderSelectedPanel();
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

// --- selection (click only selects, never triggers recording) -----------
function selectRow(idx) {
  selectedIndex = idx;
  progressList.querySelectorAll(".progress-item.selected").forEach((el) => el.classList.remove("selected"));
  const el = progressList.querySelector(`.progress-item[data-index="${idx}"]`);
  if (el) el.classList.add("selected");
  renderSelectedPanel();
}

function playRow(row) {
  if (!row || !row.recorded || !serverState.recorder) return;
  if (serverState.status === "recording") {
    showError("Can't play back audio while actively recording (it would bleed into the mic).");
    return;
  }
  const url = "/output/" + encodeURIComponent(`${row.id}_${serverState.recorder}.mp3`) + "?t=" + Date.now();
  playbackAudio.src = url;
  playbackAudio.play();
}

function renderSelectedPanel() {
  const row = selectedIndex !== null ? characterRows[selectedIndex] : null;
  const sessionIdle = serverState.status === "idle" || serverState.status === "stopped";
  const canBegin = micReady && !!serverState.recorder && sessionIdle && row;

  if (!row) {
    selectedInfo.textContent = "Click a character in the list to select it.";
  } else {
    selectedInfo.textContent = `Selected: ${row.character} — ${row.pronunciation}${row.recorded ? " (already recorded)" : ""}`;
  }

  startFromSelectedBtn.disabled = !canBegin;
  retakeBtn.disabled = !canBegin || !row.recorded;
  playSelectedBtn.disabled = !row || !row.recorded || serverState.status === "recording";

  jumpToSelectedBtn.hidden = serverState.status !== "recording" && serverState.status !== "paused";
  jumpToSelectedBtn.disabled = !row || selectedIndex === serverState.current_index;
}

// --- session actions ------------------------------------------------------
async function doStart(targetIndex) {
  selectedIndex = targetIndex;
  await postForm("/api/start", { target_index: targetIndex });
  startRecorder();
  await refreshCharacters();
}

async function finalizeOrAdvance(targetIndexOrNull, action) {
  const statusAfter = targetIndexOrNull === null ? "stopped" : "recording";
  if (targetIndexOrNull !== null) selectedIndex = targetIndexOrNull;
  if (hasUnsavedAudio) {
    const savingId = serverState.current && serverState.current.id;
    const blob = await stopRecorderAndGetBlob();
    hasUnsavedAudio = false;
    await uploadFinalize(blob, targetIndexOrNull, statusAfter, action);
    if (savingId) waveformCache.set(savingId, downsamplePeakPairs(liveTakePeaks));
  } else {
    await postForm("/api/advance_only", {
      target_index: targetIndexOrNull === null ? "null" : String(targetIndexOrNull),
      status_after: statusAfter,
    });
  }
  if (statusAfter === "recording") startRecorder();
  await refreshCharacters();
}

function doNext() {
  const nextIdx = serverState.current_index + 1 < serverState.total ? serverState.current_index + 1 : null;
  return finalizeOrAdvance(nextIdx, "next");
}

function doPrevious() {
  if (serverState.current_index === null || serverState.current_index <= 0) return;
  return finalizeOrAdvance(serverState.current_index - 1, "previous");
}

function doJump(targetIndex) {
  return finalizeOrAdvance(targetIndex, "jump");
}

async function doBreak() {
  if (!hasUnsavedAudio) return;
  const savingId = serverState.current && serverState.current.id;
  const blob = await stopRecorderAndGetBlob();
  hasUnsavedAudio = false;
  await uploadFinalize(blob, serverState.current_index, "paused", "break");
  if (savingId) waveformCache.set(savingId, downsamplePeakPairs(liveTakePeaks));
  await refreshCharacters();
}

async function doContinue() {
  await postEmpty("/api/continue");
  startRecorder();
  await refreshCharacters();
}

async function doRedo() {
  if (hasUnsavedAudio) {
    await stopRecorderAndDiscard();
    hasUnsavedAudio = false;
  }
  await postEmpty("/api/redo");
  startRecorder();
}

async function doStop() {
  if (hasUnsavedAudio) {
    const savingId = serverState.current && serverState.current.id;
    const blob = await stopRecorderAndGetBlob();
    hasUnsavedAudio = false;
    await uploadFinalize(blob, null, "stopped", "stop");
    if (savingId) waveformCache.set(savingId, downsamplePeakPairs(liveTakePeaks));
  } else {
    await postForm("/api/advance_only", { target_index: "null", status_after: "stopped" });
  }
  await refreshCharacters();
}

// --- button bindings -----------------------------------------------------
enableMicBtn.addEventListener("click", enableMic);

startFromSelectedBtn.addEventListener("click", () => {
  if (!micReady) { showError("Enable the microphone first."); return; }
  if (!serverState.recorder) { showError("Set a recorder label first."); return; }
  if (selectedIndex === null) { showError("Click a character in the list first."); return; }
  doStart(selectedIndex);
});
retakeBtn.addEventListener("click", () => {
  if (!micReady) { showError("Enable the microphone first."); return; }
  if (!serverState.recorder) { showError("Set a recorder label first."); return; }
  if (selectedIndex === null) { showError("Click a character in the list first."); return; }
  doStart(selectedIndex);
});
playSelectedBtn.addEventListener("click", () => {
  if (selectedIndex === null) return;
  playRow(characterRows[selectedIndex]);
});
jumpToSelectedBtn.addEventListener("click", () => {
  if (selectedIndex === null || selectedIndex === serverState.current_index) return;
  doJump(selectedIndex);
});
jumpFirstUnrecordedBtn.addEventListener("click", async () => {
  if (!micReady) { showError("Enable the microphone first."); return; }
  if (!serverState.recorder) { showError("Set a recorder label first."); return; }
  const res = await fetch("/api/first_unrecorded");
  if (!res.ok) { showError(await res.text()); return; }
  const data = await res.json();
  if (data.index === null) {
    showError("Every character already has a take for this recorder.");
    return;
  }
  doStart(data.index);
});

breakBtn.addEventListener("click", doBreak);
continueBtn.addEventListener("click", doContinue);
previousBtn.addEventListener("click", doPrevious);
nextBtn.addEventListener("click", doNext);
redoBtn.addEventListener("click", doRedo);
stopBtn.addEventListener("click", doStop);

playbackBtn.addEventListener("click", () => {
  if (!serverState.last_saved_file) { showError("No take saved yet."); return; }
  playbackAudio.src = "/output/" + encodeURIComponent(serverState.last_saved_file) + "?t=" + Date.now();
  playbackAudio.play();
});

document.addEventListener("keydown", (e) => {
  const tag = document.activeElement.tagName;
  if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return;
  if (e.key === "n" || e.key === "N") {
    if (serverState.status === "recording" || serverState.status === "paused") { e.preventDefault(); doNext(); }
  } else if (e.key === "p" || e.key === "P") {
    if (serverState.status === "recording" || serverState.status === "paused") { e.preventDefault(); doPrevious(); }
  }
});

// --- rendering --------------------------------------------------------------
function updateButtonAvailability() {
  const canBeginSomething = micReady && !!serverState.recorder && characterRows.length > 0 &&
    (serverState.status === "idle" || serverState.status === "stopped");
  jumpFirstUnrecordedBtn.disabled = !canBeginSomething;

  csvFileInput.disabled = serverState.status === "recording" || serverState.status === "paused";
  recorderInput.disabled = serverState.status === "recording" || serverState.status === "paused";
  setRecorderBtn.disabled = serverState.status === "recording" || serverState.status === "paused";

  previousBtn.disabled = serverState.current_index === null || serverState.current_index <= 0;

  renderSelectedPanel();
}

function render(state) {
  serverState = state;

  const active = state.status === "recording" || state.status === "paused";
  preSessionControls.hidden = active;
  sessionControls.hidden = !active;

  breakBtn.hidden = state.status !== "recording";
  continueBtn.hidden = state.status !== "paused";

  if (state.status === "idle") {
    sessionStatusEl.textContent = state.csv_name ? "Ready." : "Load a CSV to begin.";
  } else if (state.status === "recording") {
    sessionStatusEl.textContent = `Recording ${state.current_index + 1}/${state.total}: ${state.current ? state.current.character : ""}`;
  } else if (state.status === "paused") {
    sessionStatusEl.textContent = `Paused on ${state.current_index + 1}/${state.total}.`;
  } else if (state.status === "stopped") {
    sessionStatusEl.textContent = "Session stopped.";
  }

  updateButtonAvailability();
  // keep the progress list's "current" highlight in sync without refetching recorded flags
  if (characterRows.length) renderProgressList();
}

// --- boot ---------------------------------------------------------------
function connectWs() {
  const proto = location.protocol === "https:" ? "wss" : "ws";
  const ws = new WebSocket(`${proto}://${location.host}/ws`);
  ws.onmessage = (evt) => render(JSON.parse(evt.data));
  ws.onclose = () => setTimeout(connectWs, 1000);
  ws.onerror = () => ws.close();
}

async function boot() {
  const res = await fetch("/api/state");
  const data = await res.json();
  serverState = data;
  if (data.csv_name) {
    csvStatus.textContent = `${data.csv_name} (${data.total} characters)`;
  }
  if (data.recorder) {
    recorderInput.value = data.recorder;
    recorderStatus.textContent = `Recorder set: ${data.recorder}`;
  }
  await refreshCharacters();
  render(data);
  connectWs();
}

boot();
