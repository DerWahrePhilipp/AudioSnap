const views = {
  idle: document.getElementById("idle-view"),
  recording: document.getElementById("recording-view"),
  paused: document.getElementById("paused-view"),
  stopped: document.getElementById("stopped-view"),
};

const characterText = document.getElementById("character-text");
const pronunciationText = document.getElementById("pronunciation-text");

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

connect();
