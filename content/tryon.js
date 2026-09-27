// Detects product images on any site: adds a floating "Try it on" button
// on hover and a drop dock during HTML5 drags.
(() => {
  if (window.__decartTryon) return;
  window.__decartTryon = true;

  const MIN_WIDTH = 200;
  const MIN_HEIGHT = 220;
  const OUR_UI = "#decart-tryon-btn, #decart-tryon-dock, #decart-tryon-toast";

  let hoverImg = null;
  let dragUrl = null;
  let dragHint = null;

  /* ---------- helpers ---------- */

  const isOurUi = (el) => !!(el && el.closest && el.closest(OUR_UI));

  function isCandidate(img) {
    if (!img || isOurUi(img)) return false;
    const r = img.getBoundingClientRect();
    if (r.width < MIN_WIDTH || r.height < MIN_HEIGHT) return false;
    const s = getComputedStyle(img);
    return s.visibility !== "hidden" && s.display !== "none" && +s.opacity !== 0;
  }

  function bestSrc(img) {
    return (
      img.currentSrc ||
      img.src ||
      img.getAttribute("data-src") ||
      img.getAttribute("data-original") ||
      ""
    );
  }

  function cleanText(s) {
    return (s || "")
      .replace(/\s+/g, " ")
      .replace(/\|.*$/, "")
      .replace(/\s*[-–—]\s*[^-–—]{0,40}(€|\$|£)\s*[\d.,]+.*$/i, "")
      .trim();
  }

  // Best-effort product description → used to build the try-on prompt.
  function describe(img) {
    const found = [];
    const push = (s) => {
      const t = cleanText(s);
      if (t.length > 3 && t.length < 160 && !found.includes(t)) found.push(t);
    };

    push(img.alt);
    push(img.title);

    document.querySelectorAll('script[type="application/ld+json"]').forEach((el) => {
      try {
        const data = JSON.parse(el.textContent);
        const items = Array.isArray(data) ? data : [data, ...(data["@graph"] || [])];
        items.forEach((it) => {
          if (it && it["@type"] === "Product" && it.name) push(it.name);
        });
      } catch {}
    });

    const box = img.closest('[itemtype*="Product"], [class*="product" i], figure, li, article');
    if (box) {
      const h = box.querySelector("h1, h2, h3, h4, [class*='title' i], [class*='name' i]");
      push(h && (h.getAttribute("title") || h.textContent));
    }

    push(document.querySelector('meta[property="og:title"]')?.content);
    return found[0] || null;
  }

  function sendGarment(payload) {
    try {
      chrome.runtime.sendMessage({ type: "TRYON_GARMENT", ...payload });
    } catch {
      toast("Extension reloaded — refresh this page");
    }
  }

  function readAsDataUrl(file) {
    return new Promise((resolve, reject) => {
      const r = new FileReader();
      r.onload = () => resolve(r.result);
      r.onerror = reject;
      r.readAsDataURL(file);
    });
  }

  /* ---------- floating "Try it on" button ---------- */

  const btn = document.createElement("button");
  btn.id = "decart-tryon-btn";
  btn.textContent = "Try it on ✨";
  btn.hidden = true;
  document.documentElement.appendChild(btn);

  document.addEventListener(
    "mouseover",
    (e) => {
      const img = e.target instanceof Element ? e.target.closest("img") : null;
      if (!isCandidate(img)) {
        btn.hidden = true;
        hoverImg = null;
        return;
      }
      hoverImg = img;
      const r = img.getBoundingClientRect();
      btn.hidden = false;
      btn.style.left = Math.max(8, Math.min(window.innerWidth - 110, r.right - 104)) + "px";
      btn.style.top = Math.max(8, r.top + 10) + "px";
    },
    true
  );

  window.addEventListener("scroll", () => { btn.hidden = true; }, { passive: true });

  btn.addEventListener("click", (e) => {
    e.preventDefault();
    e.stopPropagation();
    if (!hoverImg) return;
    const url = bestSrc(hoverImg);
    if (!url) return toast("Couldn't read that image");
    sendGarment({ url, hint: describe(hoverImg) });
    btn.hidden = true;
  });

  /* ---------- drag & drop dock ---------- */

  const dock = document.createElement("div");
  dock.id = "decart-tryon-dock";
  dock.textContent = "👕 Drop to try on";
  dock.hidden = true;
  document.documentElement.appendChild(dock);

  document.addEventListener(
    "dragstart",
    (e) => {
      const img = e.target instanceof Element ? e.target.closest("img") : null;
      if (!img || isOurUi(img)) return;
      const url = bestSrc(img);
      if (!url) return;
      dragUrl = url;
      dragHint = describe(img);
      try {
        e.dataTransfer.setData("text/uri-list", url);
        e.dataTransfer.setData("text/plain", url);
        e.dataTransfer.effectAllowed = "copy";
      } catch {}
      dock.hidden = false;
    },
    true
  );

  document.addEventListener("dragend", () => {
    dock.hidden = true;
    dock.classList.remove("over");
    dragUrl = null;
    dragHint = null;
  }, true);

  dock.addEventListener("dragover", (e) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = "copy";
    dock.classList.add("over");
  });

  dock.addEventListener("dragleave", () => dock.classList.remove("over"));

  dock.addEventListener("drop", async (e) => {
    e.preventDefault();
    dock.hidden = true;
    dock.classList.remove("over");

    const file = e.dataTransfer?.files?.[0];
    if (file && file.type.startsWith("image/")) {
      sendGarment({ dataUrl: await readAsDataUrl(file), hint: null });
      return;
    }

    const url =
      dragUrl ||
      e.dataTransfer?.getData("text/uri-list") ||
      e.dataTransfer?.getData("text/plain") ||
      "";

    if (/^https?:/i.test(url.trim())) {
      sendGarment({ url: url.trim(), hint: dragHint });
    } else {
      toast("Drop a clothing image");
    }
    dragUrl = null;
    dragHint = null;
  });

  /* ---------- toast + error relay ---------- */

  let toastEl = null;
  let toastTimer = null;

  function toast(msg) {
    if (!toastEl) {
      toastEl = document.createElement("div");
      toastEl.id = "decart-tryon-toast";
      document.documentElement.appendChild(toastEl);
    }
    toastEl.textContent = msg;
    toastEl.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { toastEl.hidden = true; }, 3200);
  }

  chrome.runtime.onMessage.addListener((msg) => {
    if (msg?.type === "TRYON_ERROR") toast("Try-On: " + msg.message);
  });
})();
