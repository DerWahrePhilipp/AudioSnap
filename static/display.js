const views = {
  idle: document.getElementById("idle-view"),
  recording: document.getElementById("recording-view"),
  paused: document.getElementById("paused-view"),
  stopped: document.getElementById("stopped-view"),
};

const characterText = document.getElementById("character-text");
const pronunciationText = document.getElementById("pronunciation-text");

// Shrink an element's font so its (wrapped) text fits within the given width and
// height budget, never going below minPx. Text is allowed to wrap (see the CSS
// overflow-wrap rules), so the search keeps the font as large as possible and
// only relies on wrapping for the awkward cases (long sentences, unbreakable
// strings). Binary search = no visible flicker.
function fitText(el, maxPx, minPx, maxHeightPx) {
  let lo = minPx;
  let hi = maxPx;
  let best = minPx;
  for (let i = 0; i < 24 && hi - lo > 0.5; i++) {
    const mid = (lo + hi) / 2;
    el.style.fontSize = mid + "px";
    const fitsWidth = el.scrollWidth <= el.clientWidth + 1;
    const fitsHeight = el.scrollHeight <= maxHeightPx + 1;
    if (fitsWidth && fitsHeight) {
      best = mid;
      lo = mid;
    } else {
      hi = mid;
    }
  }
  el.style.fontSize = best + "px";
}

// Re-fit the currently displayed entry. Must run while the recording view is
// visible, otherwise the elements have no measurable size.
function fitCurrent() {
  if (views.recording.hidden) return;
  const w = window.innerWidth;
  const h = window.innerHeight;
  // Mirror the original CSS ceilings (min(32vw, 42vh) / min(8vw, 9vh)) as the
  // max, with a readable floor and a vertical budget for each element.
  fitText(characterText, Math.min(0.32 * w, 0.42 * h), 24, 0.6 * h);
  fitText(pronunciationText, Math.min(0.08 * w, 0.09 * h), 16, 0.2 * h);
}

function showView(name) {
  for (const key in views) {
    views[key].hidden = key !== name;
  }
}

function render(state) {
  if (state.status === "recording" && state.current) {
    characterText.textContent = state.current.character;
    pronunciationText.textContent = state.current.pronunciation;
    showView("recording");
    fitCurrent();
  } else if (state.status === "paused") {
    showView("paused");
  } else if (state.status === "stopped") {
    showView("stopped");
  } else {
    showView("idle");
  }
}

function connect() {
  const proto = location.protocol === "https:" ? "wss" : "ws";
  const ws = new WebSocket(`${proto}://${location.host}/ws`);
  ws.onmessage = (evt) => render(JSON.parse(evt.data));
  ws.onclose = () => setTimeout(connect, 1000);
  ws.onerror = () => ws.close();
}

// Viewport can change when the window is dragged to the other monitor or when
// entering/leaving fullscreen — re-fit so the text stays sized to the screen.
window.addEventListener("resize", fitCurrent);
document.addEventListener("fullscreenchange", fitCurrent);

connect();
