// Downloads garment images (host_permissions bypass CORS) and relays them
// to the side panel. Remembers the latest garment so a freshly opened
// panel can pick it up.

const MAX_BYTES = 10 * 1024 * 1024;

chrome.runtime.onInstalled.addListener(() => {
  chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {});
});

function blobToDataUrl(blob) {
  return blob.arrayBuffer().then((buf) => {
    const bytes = new Uint8Array(buf);
    let bin = "";
    const CHUNK = 0x8000;
    for (let i = 0; i < bytes.length; i += CHUNK) {
      bin += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
    }
    return `data:${blob.type || "image/jpeg"};base64,${btoa(bin)}`;
  });
}

async function fetchImageAsDataUrl(url) {
  let res;
  try {
    res = await fetch(url, { credentials: "omit", redirect: "follow" });
  } catch {
    throw new Error("couldn't download that image (blocked by the site)");
  }
  if (!res.ok) throw new Error(`image download failed (HTTP ${res.status})`);
  const type = (res.headers.get("content-type") || "").toLowerCase();
  if (type && !type.startsWith("image/")) throw new Error("that link isn't an image");
  const blob = await res.blob();
  if (blob.size > MAX_BYTES) throw new Error("image too large (max 10 MB)");
  return blobToDataUrl(blob);
}

chrome.runtime.onMessage.addListener((msg, sender) => {
  if (msg?.type !== "TRYON_GARMENT") return;

  const tabId = sender.tab?.id ?? null;

  // Open the panel FIRST, synchronously — chrome.sidePanel.open() only works
  // inside the user-gesture window, and the image fetch below would consume it.
  if (tabId != null) {
    chrome.sidePanel.open({ tabId }).catch(() => {});
  }

  (async () => {
    try {
      const dataUrl = msg.dataUrl || (msg.url ? await fetchImageAsDataUrl(msg.url) : null);
      if (!dataUrl) throw new Error("no image provided");

      const garment = { dataUrl, hint: msg.hint || null, at: Date.now() };
      // Store so a panel that opens later can pick it up on load.
      await chrome.storage.local.set({ pendingGarment: garment });

      chrome.runtime.sendMessage({ type: "GARMENT_READY", ...garment }).catch(() => {});
    } catch (err) {
      const message = String(err?.message || err);
      if (tabId != null) {
        chrome.tabs.sendMessage(tabId, { type: "TRYON_ERROR", message }).catch(() => {});
      }
    }
  })();
});
