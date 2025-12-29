/**
 * Win100 - Clean server.js
 * - Stable API JSON responses (no HTML for /api/*)
 * - /api/scan returns UI-friendly shape: { status:"success", ... }
 * - Serves index.html from /public or project root
 * - Adds debug mode: /api/scan?debug=1
 * - Prepares winrate/ROI logging endpoint: POST /api/result
 */

'use strict';

const fs = require('fs');
const path = require('path');
const express = require('express');
const cors = require('cors');

try {
  // optional, but recommended
  require('dotenv').config();
} catch (_) {}

const app = express();
app.use(cors());
app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: true }));

// -------------------- Paths / Files --------------------
const ROOT = process.cwd();

const PUBLIC_DIR = path.join(ROOT, 'public');
const ROOT_INDEX = path.join(ROOT, 'index.html');
const PUBLIC_INDEX = path.join(PUBLIC_DIR, 'index.html');

const STRATEGIES_FILE =
  process.env.STRATEGIES_FILE ||
  path.join(ROOT, 'strategies_current.json');

const LOG_DIR =
  process.env.LOG_DIR ||
  path.join(ROOT, 'logs');

const PICKS_LOG =
  process.env.PICKS_LOG ||
  path.join(LOG_DIR, 'picks.ndjson');

const RESULTS_LOG =
  process.env.RESULTS_LOG ||
  path.join(LOG_DIR, 'results.ndjson');

// Ensure log dir exists
try {
  if (!fs.existsSync(LOG_DIR)) fs.mkdirSync(LOG_DIR, { recursive: true });
} catch (e) {
  // ignore
}

// -------------------- Helpers --------------------
function nowISO() {
  return new Date().toISOString();
}

function safeJson(res, code, payload) {
  res.status(code);
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.end(JSON.stringify(payload));
}

function readJsonFile(filePath, fallback = null) {
  try {
    if (!fs.existsSync(filePath)) return fallback;
    const raw = fs.readFileSync(filePath, 'utf8');
    return JSON.parse(raw);
  } catch (e) {
    return fallback;
  }
}

function appendNdjson(filePath, obj) {
  try {
    fs.appendFileSync(filePath, JSON.stringify(obj) + '\n', 'utf8');
    return true;
  } catch (e) {
    return false;
  }
}

async function apiSportsFetch(endpoint, params = {}) {
  // API-FOOTBALL (API-SPORTS) base
  const base = process.env.API_FOOTBALL_BASE || 'https://v3.football.api-sports.io';
  const key = process.env.API_FOOTBALL_KEY;

  if (!key) {
    const err = new Error('Missing API_FOOTBALL_KEY in env');
    err.code = 'MISSING_KEY';
    throw err;
  }

  const url = new URL(base + endpoint);
  Object.entries(params || {}).forEach(([k, v]) => {
    if (v !== undefined && v !== null && v !== '') url.searchParams.set(k, String(v));
  });

  const r = await fetch(url.toString(), {
    method: 'GET',
    headers: {
      'x-apisports-key': key,
    },
  });

  const text = await r.text();
  let data;
  try {
    data = JSON.parse(text);
  } catch (e) {
    const err = new Error('Upstream returned non-JSON');
    err.code = 'UPSTREAM_NOT_JSON';
    err.details = text.slice(0, 300);
    throw err;
  }

  if (!r.ok) {
    const err = new Error('Upstream error');
    err.code = 'UPSTREAM_ERROR';
    err.status = r.status;
    err.data = data;
    throw err;
  }

  return data;
}

// -------------------- Serve static / SPA --------------------
if (fs.existsSync(PUBLIC_DIR)) {
  app.use(express.static(PUBLIC_DIR));
}

// Root page (make sure UI loads)
app.get('/', (req, res) => {
  if (fs.existsSync(PUBLIC_INDEX)) return res.sendFile(PUBLIC_INDEX);
  if (fs.existsSync(ROOT_INDEX)) return res.sendFile(ROOT_INDEX);

  // fallback (still ok)
  res.type('text/plain').send('Win100 API running');
});

// -------------------- API Routes --------------------

// Health
app.get('/api/health', (req, res) => {
  safeJson(res, 200, { ok: true, ts: nowISO() });
});

// DB ping (db disabled for now)
app.get('/api/db-ping', (req, res) => {
  safeJson(res, 200, { ok: true, db: 'disabled', ts: nowISO() });
});

// Read strategies
app.get('/api/strategies', (req, res) => {
  const strategies = readJsonFile(STRATEGIES_FILE, {});
  safeJson(res, 200, {
    ok: true,
    ts: nowISO(),
    file: STRATEGIES_FILE,
    strategies,
  });
});

// API-Football status proxy
app.get('/api/football/status', async (req, res) => {
  try {
    const data = await apiSportsFetch('/status');
    safeJson(res, 200, { ok: true, data: data.response || data });
  } catch (e) {
    safeJson(res, 200, { ok: false, error: e.message, code: e.code || 'ERR' });
  }
});

// -------------------- Scan (UI friendly) --------------------
async function doScan({ debug = false } = {}) {
  const strategies = readJsonFile(STRATEGIES_FILE, {});
  const enabledKeys = Object.entries(strategies)
    .filter(([, v]) => v && v.enabled)
    .map(([k]) => k);

  // 1) fetch live fixtures
  // Note: this is the minimum to stop UI error; later we will enrich with stats/odds
  let live = [];
  let upstreamMeta = null;

  try {
    const r = await apiSportsFetch('/fixtures', { live: 'all' });
    live = (r.response || []).map(x => x);
    upstreamMeta = {
      results: r.results,
      paging: r.paging,
      errors: r.errors,
    };
  } catch (e) {
    // even if upstream fails, we still return status:success to UI (no hard error)
    return {
      status: 'success',
      ts: nowISO(),
      totalFixtures: 0,
      totalPicks: 0,
      picks: [],
      risk: { stakeUnit: 1, totalStake: 0, note: 'upstream_error' },
      meta: {
        strategiesEnabled: enabledKeys,
        upstream: { ok: false, code: e.code || 'ERR', message: e.message },
      },
      ...(debug ? { debug: { upstreamMeta, error: { code: e.code, message: e.message, details: e.details } } } : {}),
    };
  }

  // 2) Simple placeholder decision engine (Step 1: fix UI, Step 2+: add real reasons/EV/CLV)
  // For now: no picks by default unless you want "เข้า live บ่อยขึ้น" แบบ very loose
  const picks = [];
  const drops = [];

  for (const fx of live) {
    const fixtureId = fx?.fixture?.id;
    const league = fx?.league?.name;
    const home = fx?.teams?.home?.name;
    const away = fx?.teams?.away?.name;
    const minute = fx?.fixture?.status?.elapsed ?? null;
    const goalsHome = fx?.goals?.home ?? 0;
    const goalsAway = fx?.goals?.away ?? 0;

    // Very loose example pick to make it "เข้า live บ่อยขึ้น":
    // late game draw => "late_pressure_goal" candidate (not real EV)
    const isLateDraw = minute !== null && minute >= 75 && minute <= 88 && goalsHome === goalsAway;

    if (enabledKeys.includes('late_pressure_goal') && isLateDraw) {
      const pick = {
        ts: nowISO(),
        fixtureId,
        league,
        home,
        away,
        minute,
        score: `${goalsHome}-${goalsAway}`,
        strategy: 'late_pressure_goal',
        tier: 'C',
        edge: 0.02,       // placeholder
        ev: 0.01,         // placeholder
        kelly: 0.01,      // placeholder
        betType: 'over',
        market: 'goals',
        selection: 'over_0_5',
        price: null,
        note: 'placeholder-loose-signal (Step2 will use real odds/stats)',
      };
      picks.push(pick);
      appendNdjson(PICKS_LOG, pick);
    } else {
      if (debug) {
        drops.push({
          fixtureId,
          league,
          home,
          away,
          minute,
          score: `${goalsHome}-${goalsAway}`,
          droppedBecause: 'no_strategy_matched (placeholder engine)',
        });
      }
    }
  }

  return {
    status: 'success',
    ts: nowISO(),
    totalFixtures: live.length,
    totalPicks: picks.length,
    picks, // UI expects picks
    risk: {
      stakeUnit: 1,
      totalStake: picks.length * 1,
      note: picks.length ? 'placeholder-risk' : 'no-picks',
    },
    meta: {
      strategiesFile: STRATEGIES_FILE,
      strategiesEnabled: enabledKeys,
      upstream: { ok: true, liveCount: live.length, upstreamMeta },
      logs: { picks: PICKS_LOG, results: RESULTS_LOG },
    },
    ...(debug ? { debug: { dropsSample: drops.slice(0, 50) } } : {}),
  };
}

app.get('/api/scan', async (req, res) => {
  const debug = String(req.query.debug || '') === '1';
  const data = await doScan({ debug });
  safeJson(res, 200, data);
});

app.post('/api/scan', async (req, res) => {
  const debug = String(req.query.debug || '') === '1' || !!req.body?.debug;
  const data = await doScan({ debug });
  safeJson(res, 200, data);
});

// -------------------- Result logger (Step 4 starter) --------------------
/**
 * POST /api/result
 * body example:
 * {
 *   "fixtureId": 123,
 *   "strategy": "late_pressure_goal",
 *   "betType": "over",
 *   "selection": "over_0_5",
 *   "price": 1.85,
 *   "stake": 1,
 *   "result": "WIN" | "LOSE" | "VOID",
 *   "pnl": 0.85
 * }
 */
app.post('/api/result', (req, res) => {
  const b = req.body || {};
  if (!b.fixtureId || !b.strategy || !b.result) {
    return safeJson(res, 200, { ok: false, error: 'Missing fixtureId/strategy/result' });
  }
  const row = { ts: nowISO(), ...b };
  const ok = appendNdjson(RESULTS_LOG, row);
  safeJson(res, 200, { ok, saved: ok ? row : null, file: RESULTS_LOG });
});

// -------------------- API 404 (JSON only) --------------------
app.use('/api', (req, res) => {
  safeJson(res, 404, { ok: false, error: 'API route not found', path: req.originalUrl });
});

// -------------------- SPA fallback (NON-API only) --------------------
app.use((req, res) => {
  // If UI routes are used, serve index.html
  if (fs.existsSync(PUBLIC_INDEX)) return res.sendFile(PUBLIC_INDEX);
  if (fs.existsSync(ROOT_INDEX)) return res.sendFile(ROOT_INDEX);
  res.type('text/plain').send('Win100 API running');
});

// -------------------- Start --------------------
const PORT = Number(process.env.PORT || 3000);

app.listen(PORT, '0.0.0.0', () => {
  console.log(`[OK] API_FOOTBALL_KEY ${process.env.API_FOOTBALL_KEY ? 'loaded' : 'missing'}`);
  console.log(`[OK] strategies file: ${STRATEGIES_FILE}`);
  console.log(`[OK] logs: ${PICKS_LOG}`);
  console.log(`[OK] win100 server running on port ${PORT}`);
});
