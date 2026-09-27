// Token server for the Anywhere Try-On extension.
// - POST /tokens         → short-lived Decart client token (raw key never leaves)
// - POST /enhance-prompt → vision-LLM prompt from garment image + camera frame
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import express from "express";
import multer from "multer";
import { createDecartClient } from "@decartai/sdk";
import OpenAI from "openai";

// dependency-free .env loader
try {
  for (const line of readFileSync(new URL("../.env", import.meta.url), "utf8").split("\n")) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m && !(m[1] in process.env)) process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
} catch {}

if (!process.env.DECART_API_KEY) {
  console.error("Missing DECART_API_KEY — copy .env.example to .env and fill it in.");
  process.exit(1);
}

const decart = createDecartClient({ apiKey: process.env.DECART_API_KEY });
const openai = process.env.OPENAI_API_KEY ? new OpenAI() : null;

const app = express();
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 },
});

// Reflect the origin so chrome-extension://<id> pages can call us.
app.use((req, res, next) => {
  const origin = req.headers.origin;
  if (origin) {
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Vary", "Origin");
  }
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.sendStatus(204);
  next();
});

app.get("/health", (req, res) => res.json({ ok: true }));

// Serve the standalone try-on page (no Chrome extension needed).
const __dirname = path.dirname(fileURLToPath(import.meta.url));
app.use(express.static(path.join(__dirname, "..", "public")));

// Proxy garment images from URLs (the page can't fetch cross-origin directly).
app.get("/garment", async (req, res) => {
  const url = String(req.query.url || "");
  if (!/^https?:\/\//i.test(url)) return res.status(400).json({ error: "bad url" });
  try {
    const r = await fetch(url, { credentials: "omit", redirect: "follow" });
    if (!r.ok) return res.status(502).json({ error: `HTTP ${r.status}` });
    const type = r.headers.get("content-type") || "";
    if (type && !type.startsWith("image/")) return res.status(400).json({ error: "not an image" });
    const buf = await r.arrayBuffer();
    res.setHeader("Content-Type", type || "image/jpeg");
    res.send(Buffer.from(buf));
  } catch {
    res.status(502).json({ error: "download failed" });
  }
});

// 10-min TTL is the platform max; mint a fresh one per try-on session.
app.post("/tokens", async (req, res) => {
  try {
    const token = await decart.tokens.create({ expiresIn: 600 });
    res.json(token); // { apiKey: "<client token>", expiresAt }
  } catch (err) {
    res.status(502).json({ error: String(err?.message || err) });
  }
});

const SYSTEM_PROMPT =
  `You write prompts for a virtual try-on model. Examine the garment image and write a prompt ` +
  `using this pattern: "Substitute the current top with [detailed garment description]" or ` +
  `"Add [item] to the person's [body part]". Include color, material, texture, pattern, and fit. ` +
  `20-30 words. Return only the prompt.`;

const toDataUrl = (file) => `data:${file.mimetype};base64,${file.buffer.toString("base64")}`;

app.post(
  "/enhance-prompt",
  upload.fields([
    { name: "image", maxCount: 1 },
    { name: "personFrame", maxCount: 1 },
  ]),
  async (req, res) => {
    const garment = req.files?.image?.[0];
    const frame = req.files?.personFrame?.[0];
    if (!garment) return res.status(400).json({ error: "image required" });
    if (!openai) return res.status(501).json({ error: "OPENAI_API_KEY not configured on the server" });

    try {
      const content = [
        { type: "image_url", image_url: { url: toDataUrl(garment) } },
        ...(frame ? [{ type: "image_url", image_url: { url: toDataUrl(frame) } }] : []),
      ];
      const completion = await openai.chat.completions.create({
        model: "gpt-4o-mini",
        messages: [
          { role: "system", content: SYSTEM_PROMPT },
          { role: "user", content },
        ],
        max_tokens: 100,
      });
      res.json({ prompt: completion.choices[0]?.message?.content?.trim() || "" });
    } catch (err) {
      res.status(502).json({ error: String(err?.message || err) });
    }
  }
);

const port = process.env.PORT || 8787;
app.listen(port, () => {
  console.log(`Try-On token server → http://localhost:${port}`);
  console.log(`AI prompts: ${openai ? "enabled" : "disabled (set OPENAI_API_KEY)"}`);
});
