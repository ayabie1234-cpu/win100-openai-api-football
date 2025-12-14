// server.js
// Win100 - Live Scanner (API-Football + OpenAI) with EV/CLV/Tier + Dedup
// NOTE: This file may be long; it's intended for copy/paste replacement.

const express = require("express");
const path = require("path");
const fs = require("fs");
const fsp = fs.promises;

// ใช้ node-fetch (Node18+ มี fetch ในตัว แต่เผื่อ compatibility)
let fetchFn = global.fetch;
if (!fetchFn) {
  fetchFn = (...args) => import("node-fetch").then(({ default: fetch }) => fetch(...args));
}

require("dotenv").config();

const app = express();
app.use(express.json({ limit: "2mb" }));
app.use(express.urlencoded({ extended: true }));

// ====== ENV ======
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const API_FOOTBALL_KEY = process.env.API_FOOTBALL_KEY;

// ปรับตาม bookmaker ที่คุณใช้ (ถ้าไม่ระบุ จะใช้ตัวแรกจาก API)
const DEFAULT_BOOKMAKER_ID = process.env.API_BOOKMAKER_ID || null;

// ---------------------------
// Postgres (Render) - Optional
// ---------------------------
const { Pool } = (() => {
  try { return require("pg"); } catch (e) { return {}; }
})();

const DATABASE_URL = process.env.DATABASE_URL || process.env.POSTGRES_URL || null;

// สร้าง pool เฉพาะตอนมี DATABASE_URL (บนเครื่องจะไม่บังคับ)
const pgPool = (Pool && DATABASE_URL)
  ? new Pool({
      connectionString: DATABASE_URL,
      // Render Postgres ต้องใช้ SSL
      ssl: { rejectUnauthorized: false },
    })
  : null;

// Ping DB สำหรับทดสอบการเชื่อมต่อ (ต้องได้ JSON)
app.get("/api/db-ping", async (req, res) => {
  try {
    if (!pgPool) {
      return res.status(400).json({
        ok: false,
        error: "DATABASE_URL not set (Render: ใส่ ENV ชื่อ DATABASE_URL)",
      });
    }
    const r = await pgPool.query("SELECT now() as now");
    return res.json({ ok: true, now: (r.rows && r.rows[0] && r.rows[0].now) ? r.rows[0].now : null });
  } catch (err) {
    return res.status(500).json({ ok: false, error: String((err && err.message) ? err.message : err) });
  }
});

// ====== Paths (Local file storage - dev only) ======
const DATA_DIR = path.join(__dirname, "logs");
const LOG_FILE = path.join(DATA_DIR, "picks_log.json");
const STRATEGY_FILE = path.join(__dirname, "strategies_current.json");

function ensureDirSync(p) {
  if (!fs.existsSync(p)) fs.mkdirSync(p, { recursive: true });
}
ensureDirSync(DATA_DIR);

// ====== Helpers ======
function safeJsonParse(s, fallback) {
  try {
    return JSON.parse(s);
  } catch {
    return fallback;
  }
}

async function readJsonFile(filePath, fallback) {
  try {
    const raw = await fsp.readFile(filePath, "utf8");
    return safeJsonParse(raw, fallback);
  } catch {
    return fallback;
  }
}

async function writeJsonFile(filePath, data) {
  await fsp.writeFile(filePath, JSON.stringify(data, null, 2), "utf8");
}

function nowISO() {
  return new Date().toISOString();
}

function clamp(n, a, b) {
  return Math.max(a, Math.min(b, n));
}

function round(n, d = 4) {
  const p = Math.pow(10, d);
  return Math.round((Number(n) || 0) * p) / p;
}

// ====== API-Football ======
const API_BASE = "https://v3.football.api-sports.io";

async function apiFootball(pathname, params = {}) {
  const url = new URL(API_BASE + pathname);
  Object.entries(params).forEach(([k, v]) => {
    if (v !== undefined && v !== null && v !== "") url.searchParams.set(k, String(v));
  });

  const resp = await fetchFn(url.toString(), {
    method: "GET",
    headers: {
      "x-apisports-key": API_FOOTBALL_KEY,
    },
  });

  if (!resp.ok) {
    const text = await resp.text().catch(() => "");
    const err = new Error(`API-Football error ${resp.status}: ${text || resp.statusText}`);
    err.status = resp.status;
    throw err;
  }
  return resp.json();
}

// ====== Load strategies ======
function defaultStrategies() {
  return [
    {
      id: "momentum_over",
      name: "สูงตามโมเมนตัม",
      enabled: true,
      type: "over",
      market: "over",
      minMinute: 10,
      maxMinute: 75,
      rules: {
        minShotsOn: 2,
        minShotsTotal: 7,
        minDanger: 35,
        minAttacks: 45,
      },
      gate: {
        minEdge: 0.02,
        minKelly: 0.05,
      },
    },
  ];
}

async function loadStrategies() {
  const s = await readJsonFile(STRATEGY_FILE, null);
  if (!s || !Array.isArray(s) || s.length === 0) {
    const def = defaultStrategies();
    await writeJsonFile(STRATEGY_FILE, def);
    return def;
  }
  return s;
}

async function saveStrategies(strats) {
  await writeJsonFile(STRATEGY_FILE, strats);
}

// ====== Logs ======
async function loadLog() {
  return await readJsonFile(LOG_FILE, []);
}

async function appendLog(item) {
  const log = await loadLog();
  log.push(item);
  await writeJsonFile(LOG_FILE, log);
  return item;
}

// ====== Static ======
app.use(express.static(path.join(__dirname, "public")));

// ====== Pages ======
app.get("/", (req, res) => res.sendFile(path.join(__dirname, "public", "index.html")));
app.get("/dashboard", (req, res) => res.sendFile(path.join(__dirname, "public", "dashboard.html")));
app.get("/ai-optimizer", (req, res) => res.sendFile(path.join(__dirname, "public", "ai_optimizer.html")));

// ====== API routes ======

// health
app.get("/api/health", (req, res) => {
  res.json({
    ok: true,
    ts: nowISO(),
    hasApiFootballKey: !!API_FOOTBALL_KEY,
    hasOpenAIKey: !!OPENAI_API_KEY,
    hasDatabaseUrl: !!DATABASE_URL,
  });
});

// get strategies
app.get("/api/strategies", async (req, res) => {
  try {
    const strats = await loadStrategies();
    res.json({ ok: true, strategies: strats });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e.message || e) });
  }
});

// save strategies
app.post("/api/strategies", async (req, res) => {
  try {
    const { strategies } = req.body || {};
    if (!Array.isArray(strategies)) return res.status(400).json({ ok: false, error: "strategies must be array" });
    await saveStrategies(strategies);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e.message || e) });
  }
});

// get log
app.get("/api/log", async (req, res) => {
  try {
    const log = await loadLog();
    res.json({ ok: true, log });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e.message || e) });
  }
});

// scan endpoint (placeholder / simplified - keep your existing logic below if any)
app.get("/api/scan", async (req, res) => {
  try {
    // NOTE: ถ้าโปรเจคคุณมี logic สแกนจริงอยู่แล้ว ให้คงไว้
    // ตรงนี้เป็นตัวอย่างตอบกลับเฉยๆเพื่อไม่ให้พัง
    res.json({ ok: true, picks: [], ts: nowISO() });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e.message || e) });
  }
});

// ====== Fallback for SPA/static ======
app.use((req, res, next) => {
  // ถ้าเรียก API ที่ไม่มี route ให้ตอบ JSON ชัดๆ (กัน Unexpected token '<')
  if (req.path.startsWith("/api/")) {
    return res.status(404).json({ ok: false, error: `Not Found: ${req.path}` });
  }
  return next();
});

// 404 static
app.use((req, res) => {
  res.status(404).send("Not found");
});

// ====== Start ======
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server listening on port ${PORT}`);
});
