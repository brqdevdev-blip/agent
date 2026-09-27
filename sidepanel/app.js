// Webcam → Decart lucy-vton-latest (realtime virtual try-on) via WebRTC.
// Auth: token server (short-lived client tokens, recommended) or raw API key.
// Prompts: AI-generated from garment + camera frame, heuristic fallback.
// NOTE: this file is bundled to dist/sidepanel.bundle.js and loaded by
// sidepanel.js (the loader), which surfaces load errors in the panel UI.
import { createDecartClient, models } from "@decartai/sdk";

const $ = (id) => document.getElementById(id);
const video = $("output");
const localPreview = $("localPreview");
const placeholder = $("placeholder");
const statusEl = $("status");
const spinner = $("spinner");
const startBtn = $("startBtn");
const stopBtn = $("stopBtn");
const fileInput = $("fileInput");
const fastMode = $("fastMode");
const aiPromptEl = $("aiPrompt");
const stage = $("stage");
const garmentBadge = $("garmentBadge");
const garmentThumb = $("garmentThumb");
const backendUrlInput = $("backendUrl");
const saveBackendBtn = $("saveBackend");
const apiKeyInput = $("apiKey");
const saveKeyBtn = $("saveKey");
const errorEl = $("error");

const MODEL_ID = "lucy-vton-latest";

let client = null;
let rt = null;             // realtime session
let localStream = null;
let starting = false;
let currentGarment = null; // { blob, hint }
let frameVideo = null;

console.log("[Anywhere Try-On] panel app loaded", new Date().toISOString());

/* ---------- ui helpers ---------- */

function setStatus(text, tone = "") {
  statusEl.textContent = text;
  statusEl.className = "status " + tone;
  spinner.hidden = tone !== "warn";
}

function showError(msg) { errorEl.textContent = msg; errorEl.hidden = false; }
function clearError() { errorEl.hidden = true; }

function setLive(on) {
  placeholder.classList.toggle("live", on);
}

/* ---------- camera check with clear diagnostics ---------- */

async function checkCamera() {
  const devices = await navigator.mediaDevices.enumerateDevices();
  const cams = devices.filter((d) => d.kind === "videoinput");
  if (cams.length === 0) {
    throw new Error(
      "No camera detected. If your PC has a webcam, check Windows Settings → Privacy → Camera → allow Chrome, then reopen the panel."
    );
  }
}

/* ---------- heuristic prompt fallback (VTON 3.5 patterns) ---------- */

function buildPrompt(hint) {
  if (!hint) return null; // image-only try-on still works
  let d = String(hint).replace(/["“”]/g, "").trim();
  if (d.length > 140) d = d.slice(0, 137) + "…";
  const s = d.toLowerCase();
  if (/(hat|cap\b|beanie|headband|bandana|helmet)/.test(s)) return `Add ${d} to the person's head`;
  if (/(sunglass|eyeglass|glasses)/.test(s)) return `Add ${d} to the person's face`;
  if (/(scarf|necklace|chain)/.test(s)) return `Add ${d} around the person's neck`;
  if (/(jean|trouser|pant|legging|short\b|skirt)/.test(s)) return `Substitute the current pants with ${d}`;
  if (/(shoe|sneaker|boot|sandal|heel)/.test(s)) return `Substitute the current shoes with ${d}`;
  if (/(bag|handbag|purse|backpack)/.test(s)) return `Add ${d} to the person's shoulder`;
  return `Substitute the current top with ${d}`;
}

/* ---------- credentials ---------- */

const normalizeUrl = (u) => (u || "").trim().replace(/\/+$/, "");

async function getClientCredential() {
  const { backendUrl, apiKey } = await chrome.storage.local.get(["backendUrl", "apiKey"]);
  const base = normalizeUrl(backendUrl);
  if (base) {
    // Fresh token per session (10-min TTL). Raw key stays on the server.
    const res = await fetch(`${base}/tokens`, { method: "POST" });
    if (!res.ok) throw new Error(`Token server error (HTTP ${res.status})`);
    const { apiKey: token } = await res.json();
    if (!token) throw new Error("Token server returned no token");
    return token;
  }
  if (apiKey) return apiKey;
  throw new Error("no-credentials");
}

/* ---------- AI prompt (optional, via token server) ---------- */

async function captureFrame() {
  if (!localStream) return null;
  try {
    if (!frameVideo) {
      frameVideo = document.createElement("video");
      frameVideo.muted = true;
      frameVideo.playsInline = true;
    }
    frameVideo.srcObject = localStream;
    await frameVideo.play();
    await new Promise((r) => setTimeout(r, 120)); // let a frame land
    const w = frameVideo.videoWidth;
    const h = frameVideo.videoHeight;
    if (!w || !h) return null;
    const canvas = document.createElement("canvas");
    canvas.width = 512;
    canvas.height = Math.max(1, Math.round((h / w) * 512));
    canvas.getContext("2d").drawImage(frameVideo, 0, 0, canvas.width, canvas.height);
    frameVideo.srcObject = null;
    return await new Promise((resolve) => canvas.toBlob((b) => resolve(b), "image/jpeg", 0.8));
  } catch {
    return null;
  }
}

async function enhancePrompt(blob) {
  const { backendUrl } = await chrome.storage.local.get("backendUrl");
  const base = normalizeUrl(backendUrl);
  if (!base || !aiPromptEl.checked) return null;
  try {
    const form = new FormData();
    form.append("image", blob, "garment.jpg");
    const frame = await captureFrame(); // context: what you're wearing now
    if (frame) form.append("personFrame", frame, "frame.jpg");
    const res = await fetch(`${base}/enhance-prompt`, { method: "POST", body: form });
    if (!res.ok) return null;
    const { prompt } = await res.json();
    return prompt || null;
  } catch {
    return null; // fall back to the heuristic prompt
  }
}

/* ---------- session ---------- */

async function startSession() {
  if (rt || starting) return false;
  starting = true;
  clearError();
  setStatus("connecting…", "warn");
  try {
    let credential;
    try {
      credential = await getClientCredential();
    } catch (err) {
      if (err.message === "no-credentials") {
        showError("Add a token-server URL or your Decart API key below first.");
        $("settings").scrollIntoView({ behavior: "smooth" });
        setStatus("idle");
        return false;
      }
      throw err;
    }

    await checkCamera(); // clear message if no webcam / blocked

    const model = models.realtime(MODEL_ID);
    localStream = await navigator.mediaDevices.getUserMedia({
      video: {
        facingMode: "user",
        width: model.width ?? 1280,
        height: model.height ?? 720,
        frameRate: model.fps ?? 30,
      },
    });
    // Show the raw camera in the corner so you always see yourself.
    localPreview.srcObject = localStream;
    localPreview.classList.add("on");
    try { await localPreview.play(); } catch {}

    client = createDecartClient({ apiKey: credential, telemetry: false });

    const opts = {
      model,
      mirror: "auto",
      onRemoteStream: (stream) => {
        video.srcObject = stream;
        setLive(true);
      },
    };
    if (fastMode.checked) opts.speed = "fast"; // lower latency, 2x billing, US only

    rt = await client.realtime.connect(localStream, opts);

    rt.on("connectionChange", (state) => {
      if (state === "connected" || state === "generating") {
        setStatus(currentGarment ? "live" : "ready — add a garment", currentGarment ? "ok" : "warn");
      } else if (state === "disconnected" || state === "failed") setStatus("idle");
      else setStatus(String(state).replace(/-/g, " "), "warn");
    });
    rt.on("connectionQuality", ({ quality }) => {
      if (quality === "poor" || quality === "critical") {
        setStatus(`live · ${quality} connection`, "warn");
      }
    });

    startBtn.hidden = true;
    stopBtn.hidden = false;
    return true;
  } catch (err) {
    await stopSession();
    const msg = String(err?.message || err);
    let friendly = msg;
    if (/NotFoundError|no camera/i.test(msg)) {
      friendly = "No camera found on this computer. Plug in a webcam (or use a laptop with one) and try again.";
    } else if (/permission|denied|NotAllowed/i.test(msg)) {
      friendly = "Camera blocked — click the camera icon in Chrome's address bar → Allow, and check Windows Settings → Privacy → Camera.";
    }
    showError(friendly);
    setStatus("error", "bad");
    return false;
  } finally {
    starting = false;
  }
}

async function stopSession() {
  try { rt?.disconnect(); } catch {}
  rt = null;
  try { localStream?.getTracks().forEach((t) => t.stop()); } catch {}
  localStream = null;
  video.srcObject = null;
  localPreview.srcObject = null;
  localPreview.classList.remove("on");
  setLive(false);
  startBtn.hidden = false;
  stopBtn.hidden = true;
  setStatus("idle");
}

async function ensureSession() {
  if (rt) return true;
  if (!starting) await startSession();
  while (starting) await new Promise((r) => setTimeout(r, 200));
  return !!rt;
}

/* ---------- garment ---------- */

async function applyGarment({ blob, hint }) {
  garmentThumb.src = URL.createObjectURL(blob);
  garmentBadge.hidden = false;

  if (!(await ensureSession())) return;

  setStatus("writing prompt…", "warn");
  const prompt = (await enhancePrompt(blob)) || buildPrompt(hint);

  setStatus("applying garment…", "warn");
  try {
    // set() replaces state — switching garments needs no reconnect.
    await rt.set(prompt ? { prompt, image: blob, enhance: false } : { image: blob });
    setStatus("live", "ok");
  } catch (err) {
    showError("Try-on failed: " + String(err?.message || err));
    setStatus("live", "ok");
  }
}

function dataUrlToBlob(dataUrl) {
  const [meta, b64] = dataUrl.split(",");
  const mime = /data:([^;]+)/.exec(meta)?.[1] || "image/jpeg";
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new Blob([bytes], { type: mime });
}

/* ---------- messages from background ---------- */

chrome.runtime.onMessage.addListener((msg) => {
  if (msg?.type !== "GARMENT_READY") return;
  currentGarment = { blob: dataUrlToBlob(msg.dataUrl), hint: msg.hint };
  applyGarment(currentGarment);
});

/* ---------- local controls ---------- */

startBtn.addEventListener("click", async () => {
  clearError();
  if (await startSession()) {
    if (currentGarment) applyGarment(currentGarment);
  }
});
stopBtn.addEventListener("click", stopSession);

fileInput.addEventListener("change", () => {
  const file = fileInput.files?.[0];
  if (!file) return;
  currentGarment = { blob: file, hint: null };
  applyGarment(currentGarment);
  fileInput.value = "";
});

saveBackendBtn.addEventListener("click", async () => {
  await chrome.storage.local.set({ backendUrl: normalizeUrl(backendUrlInput.value) });
  clearError();
  setStatus("token server saved", "ok");
  setTimeout(() => setStatus("idle"), 1500);
});

saveKeyBtn.addEventListener("click", async () => {
  const key = apiKeyInput.value.trim();
  if (!key) return showError("Paste your API key first.");
  await chrome.storage.local.set({ apiKey: key });
  clearError();
  setStatus("key saved", "ok");
  setTimeout(() => setStatus("idle"), 1500);
});

aiPromptEl.addEventListener("change", () => {
  chrome.storage.local.set({ aiPrompt: aiPromptEl.checked });
});

/* drop garment images directly on the video */
stage.addEventListener("dragover", (e) => {
  e.preventDefault();
  stage.classList.add("drop");
});
stage.addEventListener("dragleave", () => stage.classList.remove("drop"));
stage.addEventListener("drop", (e) => {
  e.preventDefault();
  stage.classList.remove("drop");
  const file = e.dataTransfer?.files?.[0];
  if (file && file.type.startsWith("image/")) {
    currentGarment = { blob: file, hint: null };
    applyGarment(currentGarment);
    return;
  }
  const url = (e.dataTransfer?.getData("text/uri-list") || e.dataTransfer?.getData("text/plain") || "").trim();
  if (/^https?:/i.test(url)) {
    chrome.runtime.sendMessage({ type: "TRYON_GARMENT", url, hint: null });
  }
});

/* ---------- init ---------- */

(async () => {
  const { apiKey, backendUrl, aiPrompt, pendingGarment } = await chrome.storage.local.get([
    "apiKey", "backendUrl", "aiPrompt", "pendingGarment",
  ]);
  if (apiKey) apiKeyInput.value = apiKey;
  if (backendUrl) backendUrlInput.value = backendUrl;
  if (typeof aiPrompt === "boolean") aiPromptEl.checked = aiPrompt;

  // A garment was clicked/dropped while the panel was closed → resume it.
  if (pendingGarment?.dataUrl && Date.now() - (pendingGarment.at || 0) < 5 * 60_000) {
    currentGarment = { blob: dataUrlToBlob(pendingGarment.dataUrl), hint: pendingGarment.hint };
    applyGarment(currentGarment); // auto-starts the session
  }
})();