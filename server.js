import express from "express";
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = join(__dirname, "data");
const PORT = process.env.PORT || 3001;

if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true });

function storagePath(key) {
  // Sanitize key to prevent path traversal
  const safe = key.replace(/[^a-zA-Z0-9_:-]/g, "_");
  return join(DATA_DIR, `${safe}.json`);
}

const app = express();
app.use(express.json());

// Serve built frontend in production
const distDir = join(__dirname, "dist");
if (existsSync(distDir)) {
  app.use(express.static(distDir));
}

// ─── Storage API ───

app.get("/api/storage/:key", (req, res) => {
  const file = storagePath(req.params.key);
  if (!existsSync(file)) return res.json({ value: null });
  try {
    const raw = readFileSync(file, "utf-8");
    res.json({ value: raw });
  } catch {
    res.json({ value: null });
  }
});

app.put("/api/storage/:key", (req, res) => {
  const file = storagePath(req.params.key);
  try {
    writeFileSync(file, req.body.value, "utf-8");
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ ok: false, error: "Write failed" });
  }
});

// SPA fallback for production
if (existsSync(distDir)) {
  app.get("*", (_req, res) => {
    res.sendFile(join(distDir, "index.html"));
  });
}

app.listen(PORT, () => {
  console.log(`Server listening on http://localhost:${PORT}`);
});
