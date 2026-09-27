// Standalone try-on page — no Chrome extension needed.
// The server (server/index.js) holds the Decart key in .env and mints
// short-lived client tokens at /tokens.
import { createDecartClient, models } from "@decartai/sdk";

const $ = (id) => document.getElementById(id);
const video = $("output");
const localPreview = $("localPreview");
const placeholder = $("placeholder");
const statusEl = $("status");
const startBtn = $("startBtn");
const stopBtn = $("stopBtn");
const fileInput = $("fileInput");
const urlInput = $("urlInput");
const urlBtn = $("urlBtn");
const promptInput = $("promptInput");
const aiPromptEl = $("aiPrompt");
const stage = $("stage");
const garmentBadge = $("garmentBadge");
const garmentThumb = $("garmentThumb");
const errorEl = $("error");

const MODEL_ID = "lucy-vton-latest";

let client = null;
let rt = null;             // realtime session
let localStream = null;
let starting = false;
let currentGarment = null; // Blob
let frameVideo = null;
let remoteStreamReceived = false;
let noVideoTimer = null;

console.log("[Anywhere Try-On] page loaded", new Date().toISOString());

/* ---------- ui helpers ---------- */

function setStatus(text, tone = "") {
  statusEl.textContent = text;
  statusEl.className = "status " + tone;
}

function showError(msg) { errorEl.textContent = msg; errorEl.hidden = false; }
function clearError() { errorEl.hidden = true; }

/* ---------- token from the server (key stays in .env) ---------- */

async function getToken() {
  const res = await fetch("/tokens", { method: "POST" });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error || `Token server error (HTTP ${res.status})`);
  }
  const { apiKey } = await res.json();
  if (!apiKey) throw new Error("Token server returned no token");
  return apiKey;
}

/* ---------- session ---------- */

async function startSession() {
  if (rt || starting) return false;
  starting = true;
  clearError();
  setStatus("connecting…", "warn");
  try {
    const token = await getToken();
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
    client = createDecartClient({ apiKey: token, telemetry: false });
    rt = await client.realtime.connect(localStream, {
      model,
      mirror: "auto",
      onRemoteStream: (stream) => {
        remoteStreamReceived = true;
        video.srcObject = stream;
        placeholder.classList.add("live");
      },
    });
    rt.on("connectionChange", (state) => {
      if (state === "generating") setStatus("generating…", "warn");
      else if (state === "connected") {
        setStatus(currentGarment ? "live" : "ready — add a garment", currentGarment ? "ok" : "warn");
      } else if (state === "disconnected" || state === "failed") setStatus("idle");
      else setStatus(String(state).replace(/-/g, " "), "warn");
    });
    startBtn.hidden = true;
    stopBtn.hidden = false;

    // If the AI session is up but no video frames arrive, warn (credits/account).
    clearTimeout(noVideoTimer);
    noVideoTimer = setTimeout(() => {
      if (!remoteStreamReceived || video.videoWidth === 0) {
        showError(
          "The AI connected but no video is coming back. Most likely your Decart account has no credits/billing — check platform.decart.ai → Billing, then reload this page."
        );
        setStatus("no video from AI", "bad");
      }
    }, 20000);
    return true;
  } catch (err) {
    await stopSession();
    const msg = String(err?.message || err);
    let friendly = msg;
    if (/NotFoundError|no camera/i.test(msg)) {
      friendly = "No camera found on this computer. Plug in a webcam (or use a laptop with one) and try again.";
    } else if (/permission|denied|NotAllowed/i.test(msg)) {
      friendly = "Camera blocked — click the camera icon in the address bar → Allow, and check Windows Settings → Privacy → Camera.";
    }
    showError(friendly);
    setStatus("error", "bad");
    return false;
  } finally {
    starting = false;
  }
}

async function stopSession() {
  clearTimeout(noVideoTimer);
  remoteStreamReceived = false;
  try { rt?.disconnect(); } catch {}
  rt = null;
  try { localStream?.getTracks().forEach((t) => t.stop()); } catch {}
  localStream = null;
  video.srcObject = null;
  localPreview.srcObject = null;
  localPreview.classList.remove("on");
  placeholder.classList.remove("live");
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

/* ---------- AI prompt (optional) ---------- */

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
    await new Promise((r) => setTimeout(r, 120));
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
  if (!aiPromptEl.checked) return null;
  try {
    const form = new FormData();
    form.append("image", blob, "garment.jpg");
    const frame = await captureFrame();
    if (frame) form.append("personFrame", frame, "frame.jpg");
    const res = await fetch("/enhance-prompt", { method: "POST", body: form });
    if (!res.ok) return null;
    const { prompt } = await res.json();
    return prompt || null;
  } catch {
    return null;
  }
}

/* ---------- garment ---------- */

async function applyGarment(blob) {
  garmentThumb.src = URL.createObjectURL(blob);
  garmentBadge.hidden = false;

  if (!(await ensureSession())) return;

  const typed = promptInput.value.trim();
  setStatus("applying garment…", "warn");
  try {
    const prompt = typed || (await enhancePrompt(blob)) || null;
    await rt.set(prompt ? { prompt, image: blob, enhance: false } : { image: blob });
    setStatus("live", "ok");
  } catch (err) {
    showError("Try-on failed: " + String(err?.message || err));
    setStatus("live", "ok");
  }
}

/* ---------- controls ---------- */

startBtn.addEventListener("click", async () => {
  clearError();
  if (await startSession()) {
    if (currentGarment) applyGarment(currentGarment);
  }
});
stopBtn.addEventListener("click", stopSession);

fileInput.addEventListener("change", () => {
  const f = fileInput.files?.[0];
  if (!f) return;
  currentGarment = f; // File is a Blob
  applyGarment(f);
  fileInput.value = "";
});

urlBtn.addEventListener("click", async () => {
  const url = urlInput.value.trim();
  if (!/^https?:\/\//i.test(url)) return showError("Paste a full image URL starting with https://");
  clearError();
  setStatus("downloading garment…", "warn");
  try {
    const res = await fetch("/garment?url=" + encodeURIComponent(url));
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      throw new Error(body.error || `HTTP ${res.status}`);
    }
    const blob = await res.blob();
    currentGarment = blob;
    await applyGarment(blob);
  } catch (err) {
    showError("Couldn't load that image: " + String(err?.message || err));
    setStatus("idle");
  }
});

/* drag & drop an image onto the video */
stage.addEventListener("dragover", (e) => {
  e.preventDefault();
  stage.classList.add("drop");
});
stage.addEventListener("dragleave", () => stage.classList.remove("drop"));
stage.addEventListener("drop", (e) => {
  e.preventDefault();
  stage.classList.remove("drop");
  const f = e.dataTransfer?.files?.[0];
  if (f && f.type.startsWith("image/")) {
    currentGarment = f;
    applyGarment(f);
  }
});