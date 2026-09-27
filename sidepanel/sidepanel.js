// Loader: boots the bundled app (dist/sidepanel.bundle.js) and surfaces any
// load error directly in the panel UI instead of failing silently.
(async () => {
  const status = document.getElementById("status");
  const errorEl = document.getElementById("error");
  try {
    await import("../dist/sidepanel.bundle.js");
  } catch (err) {
    console.error("[Anywhere Try-On] bundle failed to load:", err);
    if (status) {
      status.textContent = "error";
      status.className = "status bad";
    }
    if (errorEl) {
      errorEl.hidden = false;
      errorEl.textContent = "Panel failed to load: " + (err?.message || err);
    }
  }
})();