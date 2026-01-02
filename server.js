/**
 * server.js — Win100 Live Scanner
 * Add: Manual result sync + performance ranking (no DB, NDJSON)
 *
 * HARD CONSTRAINTS:
 * - Do NOT change /api/scan main response structure: {status,totalFixtures,totalPicks,picks,risk}
 * - Do NOT treat picks=[] as error
 * - Do NOT remove pick fields in /api/scan picks: strategy,tier,edge,kelly, market/selection/betType (your scan already)
 */

import express from "express";
import dotenv from "dotenv";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

dotenv.config();

const app = express();
app.use(express.json({ limit: "1mb" }));
app.use(express.static("public"));

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ===== Config =====
const PORT = process.env.PORT || 3000;
const API_FOOTBALL_KEY = process.env.API_FOOTBALL_KEY;
const API_FOOTBALL_BASE = "https://v3.football.api-sports.io";

const STRATEGIES_FILE = path.join(__dirname, "strategies_current.json");
const LOG_DIR = path.join(__dirname, "logs");
const PICKS_LOG = path.join(LOG_DIR, "picks.ndjson");
const RESULTS_LOG = path.join(LOG_DIR, "results.ndjson");

if (!fs.existsSync(LOG_DIR)) fs.mkdirSync(LOG_DIR, { recursive: true });

// ===== Utils =====
function nowIso() {
  return new Date().toISOString();
}
function safeNumber(v, fallback = 0) {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}
function toBool(val) {
  if (val === true) return true;
  if (val === false) return false;
  if (val == null) return false;
  const s = String(val).trim().toLowerCase();
  return s === "1" || s === "true" || s === "yes" || s === "y" || s === "on";
}
function clamp01(x) {
  const n = safeNumber(x, 0);
  if (n < 0) return 0;
  if (n > 1) return 1;
  return n;
}
function appendNdjson(file, obj) {
  try {
    fs.appendFileSync(file, JSON.stringify(obj) + "\n", "utf8");
  } catch (e) {
    console.error("NDJSON append failed:", e?.message || e);
  }
}
function readNdjson(file) {
  if (!fs.existsSync(file)) return [];
  const lines = fs.readFileSync(file, "utf8").split("\n").filter(Boolean);
  const out = [];
  for (const line of lines) {
    try {
      out.push(JSON.parse(line));
    } catch {
      // ignore bad line
    }
  }
  return out;
}

// ===== Load Strategies (your schema) =====
function loadStrategiesMap() {
  try {
    const raw = fs.readFileSync(STRATEGIES_FILE, "utf8");
    const json = JSON.parse(raw);
    if (json && typeof json === "object" && !Array.isArray(json)) return json;
    return {};
  } catch (e) {
    console.error("Failed to load strategies_current.json:", e?.message || e);
    return {};
  }
}

// ===== API-Football Fetch =====
async function apiFootball(pathname, params = {}) {
  if (!API_FOOTBALL_KEY) throw new Error("API_FOOTBALL_KEY is missing in .env");

  const url = new URL(API_FOOTBALL_BASE + pathname);
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== null && v !== "") url.searchParams.set(k, String(v));
  }

  const res = await fetch(url.toString(), {
    method: "GET",
    headers: {
      "x-apisports-key": API_FOOTBALL_KEY,
      accept: "application/json",
    },
  });

  const text = await res.text();

  let json;
  try {
    json = JSON.parse(text);
  } catch {
    throw new Error(`API-Football non-JSON response (${res.status}): ${text?.slice(0, 200)}`);
  }

  if (!res.ok) {
    const msg = json?.message || json?.errors || json?.error || `HTTP ${res.status}`;
    throw new Error(`API-Football error: ${msg}`);
  }
  return json;
}

// ===== Stats Extraction =====
function extractBasicStats(statsResponseArray, homeTeamId, awayTeamId) {
  if (!Array.isArray(statsResponseArray)) return null;

  const byTeamId = new Map();
  for (const entry of statsResponseArray) {
    const tid = entry?.team?.id;
    const stats = entry?.statistics;
    if (tid && Array.isArray(stats)) byTeamId.set(tid, stats);
  }

  const homeStats = byTeamId.get(homeTeamId) || null;
  const awayStats = byTeamId.get(awayTeamId) || null;

  const pull = (statsArr, typeName) => {
    if (!Array.isArray(statsArr)) return null;
    const found = statsArr.find((s) => String(s?.type).toLowerCase() === String(typeName).toLowerCase());
    let v = found?.value;
    if (typeof v === "string") v = v.replace("%", "").trim();
    if (v === null || v === undefined || v === "") return null;
    if (typeof v === "string" && v.includes("/")) v = v.split("/")[0].trim();
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  };

  return {
    shotsOnGoal: { home: pull(homeStats, "Shots on Goal"), away: pull(awayStats, "Shots on Goal") },
    shotsTotal: { home: pull(homeStats, "Total Shots"), away: pull(awayStats, "Total Shots") },
    corners: { home: pull(homeStats, "Corner Kicks"), away: pull(awayStats, "Corner Kicks") },
    yellow: { home: pull(homeStats, "Yellow Cards"), away: pull(awayStats, "Yellow Cards") },
    red: { home: pull(homeStats, "Red Cards"), away: pull(awayStats, "Red Cards") },
  };
}

// ===== Metrics Builder =====
async function buildMetricsForFixture(fixture) {
  const fixtureId = fixture?.fixture?.id;
  const leagueId = fixture?.league?.id;
  const minute = safeNumber(fixture?.fixture?.status?.elapsed, 0);

  const home = fixture?.teams?.home;
  const away = fixture?.teams?.away;

  const goalsHome = safeNumber(fixture?.goals?.home, 0);
  const goalsAway = safeNumber(fixture?.goals?.away, 0);

  let statsArr = null;
  try {
    const statRes = await apiFootball("/fixtures/statistics", { fixture: fixtureId });
    statsArr = statRes?.response || null;
  } catch {
    statsArr = null;
  }

  const derived = extractBasicStats(statsArr, home?.id, away?.id) || {
    shotsOnGoal: { home: null, away: null },
    shotsTotal: { home: null, away: null },
    corners: { home: null, away: null },
    yellow: { home: null, away: null },
    red: { home: null, away: null },
  };

  const pressureHome = clamp01(
    safeNumber(derived.shotsOnGoal.home, 0) * 0.12 +
      safeNumber(derived.shotsTotal.home, 0) * 0.04 +
      safeNumber(derived.corners.home, 0) * 0.06
  );
  const pressureAway = clamp01(
    safeNumber(derived.shotsOnGoal.away, 0) * 0.12 +
      safeNumber(derived.shotsTotal.away, 0) * 0.04 +
      safeNumber(derived.corners.away, 0) * 0.06
  );

  const xgProxy = {
    home: clamp01(safeNumber(derived.shotsOnGoal.home, 0) * 0.15 + safeNumber(derived.shotsTotal.home, 0) * 0.03),
    away: clamp01(safeNumber(derived.shotsOnGoal.away, 0) * 0.15 + safeNumber(derived.shotsTotal.away, 0) * 0.03),
  };

  const scoreDiff = goalsHome - goalsAway;

  return {
    fixtureId,
    leagueId,
    minute,
    teams: {
      home: { id: home?.id, name: home?.name },
      away: { id: away?.id, name: away?.name },
    },
    score: { home: goalsHome, away: goalsAway, diff: scoreDiff },
    shotsOnGoal: derived.shotsOnGoal,
    shotsTotal: derived.shotsTotal,
    corners: derived.corners,
    cards: { yellow: derived.yellow, red: derived.red },
    pressure: { home: pressureHome, away: pressureAway },
    xgProxy,
  };
}

// ===== Strategy Param Evaluator =====
function evaluateParams(params, metrics) {
  const reasons = [];
  const p = params || {};

  if (p.minMinute != null && metrics.minute < safeNumber(p.minMinute)) {
    reasons.push(`minute < minMinute (${metrics.minute} < ${p.minMinute})`);
  }
  if (p.maxMinute != null && metrics.minute > safeNumber(p.maxMinute)) {
    reasons.push(`minute > maxMinute (${metrics.minute} > ${p.maxMinute})`);
  }

  if (p.minPressure != null) {
    const maxPressure = Math.max(safeNumber(metrics.pressure.home, 0), safeNumber(metrics.pressure.away, 0));
    if (maxPressure < safeNumber(p.minPressure)) {
      reasons.push(`pressure < minPressure (${maxPressure.toFixed(2)} < ${p.minPressure})`);
    }
  }

  if (p.minSOTDiff != null) {
    const diff = Math.abs(safeNumber(metrics.shotsOnGoal.home, 0) - safeNumber(metrics.shotsOnGoal.away, 0));
    if (diff < safeNumber(p.minSOTDiff)) {
      reasons.push(`SOT diff < minSOTDiff (${diff} < ${p.minSOTDiff})`);
    }
  }
  if (p.minSOT != null) {
    const mx = Math.max(safeNumber(metrics.shotsOnGoal.home, 0), safeNumber(metrics.shotsOnGoal.away, 0));
    if (mx < safeNumber(p.minSOT)) {
      reasons.push(`SOT < minSOT (${mx} < ${p.minSOT})`);
    }
  }

  if (p.minCornerDiff != null) {
    const diff = Math.abs(safeNumber(metrics.corners.home, 0) - safeNumber(metrics.corners.away, 0));
    if (diff < safeNumber(p.minCornerDiff)) {
      reasons.push(`corner diff < minCornerDiff (${diff} < ${p.minCornerDiff})`);
    }
  }

  if (p.maxTotalShotsSum != null) {
    const sum = safeNumber(metrics.shotsTotal.home, 0) + safeNumber(metrics.shotsTotal.away, 0);
    if (sum > safeNumber(p.maxTotalShotsSum)) {
      reasons.push(`total shots sum > maxTotalShotsSum (${sum} > ${p.maxTotalShotsSum})`);
    }
  }
  if (p.maxSOTSum != null) {
    const sum = safeNumber(metrics.shotsOnGoal.home, 0) + safeNumber(metrics.shotsOnGoal.away, 0);
    if (sum > safeNumber(p.maxSOTSum)) {
      reasons.push(`SOT sum > maxSOTSum (${sum} > ${p.maxSOTSum})`);
    }
  }
  if (p.maxXgProxySum != null) {
    const sum = safeNumber(metrics.xgProxy.home, 0) + safeNumber(metrics.xgProxy.away, 0);
    if (sum > safeNumber(p.maxXgProxySum)) {
      reasons.push(`xG proxy sum > maxXgProxySum (${sum.toFixed(2)} > ${p.maxXgProxySum})`);
    }
  }

  if (p.maxGoalDown != null) {
    const absDiff = Math.abs(safeNumber(metrics.score.diff, 0));
    if (absDiff > safeNumber(p.maxGoalDown)) {
      reasons.push(`goal diff > maxGoalDown (${absDiff} > ${p.maxGoalDown})`);
    }
  }

  return reasons;
}

// ===== Pick Builder (scan keeps required fields) =====
function buildPickBase(metrics, strategyKey, strategyLabel) {
  return {
    fixtureId: metrics.fixtureId,
    leagueId: metrics.leagueId,
    minute: metrics.minute,
    home: metrics.teams.home.name,
    away: metrics.teams.away.name,
    scoreHome: metrics.score.home,
    scoreAway: metrics.score.away,

    // required fields (DO NOT REMOVE)
    strategy: strategyLabel || strategyKey,
    tier: "B",
    edge: 0,
    kelly: 0,
    market: "",
    selection: "",
    betType: "live",
  };
}

// เติม field ให้ครบตามสัญญา UI (additive only)
function finalizePickForUI(pick, metrics) {
  if (!pick || !metrics) return pick;

  // Required by UI/spec
  if (!pick.ts) pick.ts = nowIso();
  if (!pick.pickId) pick.pickId = makePickId({ ...pick, ts: pick.ts });

  // League display (string is simplest for UI)
  if (!pick.league) pick.league = metrics?.league?.name || metrics?.leagueName || metrics?.league_name || "";

  // Ensure teams
  if (!pick.home) pick.home = metrics?.teams?.home?.name || pick.home;
  if (!pick.away) pick.away = metrics?.teams?.away?.name || pick.away;

  // Score/minute at scan (UI uses these fallbacks)
  if (pick.scoreAtScan == null) pick.scoreAtScan = `${safeNumber(metrics?.score?.home, 0)}-${safeNumber(metrics?.score?.away, 0)}`;
  if (pick.minuteAtScan == null) pick.minuteAtScan = metrics?.minute;

  // Stake default
  if (pick.stake == null) pick.stake = 1;

  return pick;
}

// ===== Dedup =====
function makeDedupKey(pick) {
  const fixtureId = pick?.fixtureId ?? "";
  const strategy = pick?.strategy ?? "";
  const side = pick?.side ?? pick?.selection ?? pick?.betSide ?? "";
  return `${fixtureId}__${strategy}__${side}`;
}

// ===== Debug Grouping =====
function ensureFixtureBucket(map, metrics) {
  const id = metrics?.fixtureId;
  if (!id) return null;
  if (!map.has(id)) {
    map.set(id, {
      fixtureId: metrics.fixtureId,
      leagueId: metrics.leagueId,
      minute: metrics.minute,
      home: metrics.teams.home.name,
      away: metrics.teams.away.name,
      score: `${metrics.score.home}-${metrics.score.away}`,
      rejected: [],
      notes: [],
    });
  } else {
    const b = map.get(id);
    b.minute = metrics.minute;
    b.score = `${metrics.score.home}-${metrics.score.away}`;
  }
  return map.get(id);
}
function pushRejected(map, metrics, item) {
  const bucket = ensureFixtureBucket(map, metrics);
  if (!bucket) return;
  bucket.rejected.push(item);
}
function pushNote(map, metrics, note) {
  const bucket = ensureFixtureBucket(map, metrics);
  if (!bucket) return;
  bucket.notes.push(note);
}

// ===== Result Sync Helpers =====

// Normalize "pick" from either:
// 1) legacy flat record: {ts, fixtureId, strategy, betType, betSide, odds, stake, result...}
// 2) new ndjson: {time, type:"pick", pick:{...}}
function normalizePickRecord(obj, idx) {
  if (obj && obj.type === "pick" && obj.pick && typeof obj.pick === "object") {
    const p = obj.pick;
    return {
      _src: "new",
      _line: idx,
      ts: obj.time || p.time || p.ts || nowIso(),
      fixtureId: p.fixtureId,
      strategy: p.strategy,
      tier: p.tier,
      edge: p.edge,
      kelly: p.kelly,
      odds: p.odds,
      stake: p.stake ?? 1,
      // markets
      market: p.market,
      selection: p.selection,
      betType: p.betType,
      side: p.side, // e.g. home/away/draw/over/under
      line: p.line,
      home: p.home,
      away: p.away,
      result: p.result || "PENDING",
    };
  }

  // legacy
  if (obj && typeof obj === "object") {
    return {
      _src: "legacy",
      _line: idx,
      ts: obj.ts || obj.time || nowIso(),
      fixtureId: obj.fixtureId,
      strategy: obj.strategy || obj.betType,
      tier: obj.tier,
      edge: obj.edge,
      kelly: obj.kelly,
      odds: obj.odds,
      stake: obj.stake ?? 1,

      market: obj.market, // often missing in legacy
      selection: obj.selection,
      betType: obj.betType,
      side: obj.betSide,
      line: obj.line,

      home: obj.home,
      away: obj.away,
      result: obj.result || "PENDING",
    };
  }

  return null;
}

// Deterministic id for linking results (no DB)
function makePickId(p) {
  const fixtureId = p?.fixtureId ?? "";
  const strategy = p?.strategy ?? "";
  const side = p?.side ?? p?.selection ?? "";
  const ts = p?.ts ?? "";
  return `${fixtureId}__${strategy}__${side}__${ts}`;
}

// settle helpers
function settle1x2(side, scoreHome, scoreAway) {
  const h = safeNumber(scoreHome, 0);
  const a = safeNumber(scoreAway, 0);
  const winner = h > a ? "home" : h < a ? "away" : "draw";
  if (side === winner) return "WIN";
  return "LOSE";
}
function settleTotal(selection, line, scoreHome, scoreAway) {
  const h = safeNumber(scoreHome, 0);
  const a = safeNumber(scoreAway, 0);
  const total = h + a;
  const ln = Number(line);
  if (!Number.isFinite(ln)) return { outcome: "SKIP", reason: "missing/invalid line" };

  const sel = String(selection || "").toUpperCase();
  if (sel === "OVER") {
    if (total > ln) return { outcome: "WIN" };
    if (total === ln) return { outcome: "PUSH" };
    return { outcome: "LOSE" };
  }
  if (sel === "UNDER") {
    if (total < ln) return { outcome: "WIN" };
    if (total === ln) return { outcome: "PUSH" };
    return { outcome: "LOSE" };
  }
  return { outcome: "SKIP", reason: "unknown total selection" };
}
function profitForOutcome(outcome, odds, stake) {
  const o = Number(odds);
  const s = Number(stake ?? 1);
  if (!Number.isFinite(s) || s <= 0) return 0;
  if (outcome === "WIN") {
    if (!Number.isFinite(o) || o <= 1) return 0;
    return (o - 1) * s;
  }
  if (outcome === "LOSE") return -1 * s;
  return 0; // PUSH/SKIP
}

// ===== Endpoints =====
app.get("/api/health", (req, res) => {
  res.json({ status: "ok", time: nowIso() });
});

app.get("/api/football/status", async (req, res) => {
  try {
    let data;
    try {
      data = await apiFootball("/status");
    } catch {
      data = await apiFootball("/timezone");
    }
    res.json({ status: "success", provider: data });
  } catch (e) {
    res.status(500).json({ status: "error", message: e?.message || String(e) });
  }
});

/**
 * POST /api/scan
 * - main response structure fixed
 * - debug.rejected is grouped + sorted (rejected count desc)
 */
app.post("/api/scan", async (req, res) => {
  const debugEnabled = toBool(req.query?.debug) || toBool(req.body?.debug);
  const startedAt = Date.now();

  const strategiesMap = loadStrategiesMap();

  try {
    const liveRes = await apiFootball("/fixtures", { live: "all" });
    const fixtures = Array.isArray(liveRes?.response) ? liveRes.response : [];

    const picks = [];
    const dedupSet = new Set();

    const rejectedByFixture = new Map();
    const debugPassed = [];
    const debugStats = {
      fixtureCount: fixtures.length,
      strategiesTotal: Object.keys(strategiesMap).length,
      strategiesEnabled: Object.entries(strategiesMap).filter(([, v]) => v?.enabled).length,
      evaluated: 0,
      passed: 0,
      rejected: 0,
      skippedDisabled: 0,
      missingData: 0,
    };

    const strategyKeys = Object.keys(strategiesMap);

    for (const fx of fixtures) {
      let metrics;
      try {
        metrics = await buildMetricsForFixture(fx);
      } catch (e) {
        if (debugEnabled) {
          debugStats.missingData += 1;
          const fixtureId = fx?.fixture?.id;
          if (fixtureId) {
            rejectedByFixture.set(fixtureId, {
              fixtureId,
              leagueId: fx?.league?.id,
              minute: safeNumber(fx?.fixture?.status?.elapsed, 0),
              home: fx?.teams?.home?.name,
              away: fx?.teams?.away?.name,
              score: `${safeNumber(fx?.goals?.home, 0)}-${safeNumber(fx?.goals?.away, 0)}`,
              rejected: [
                { strategy: "*all*", label: "*all*", reasons: [`metrics build failed: ${e?.message || String(e)}`] },
              ],
              notes: [],
            });
          }
        }
        continue;
      }

      let riskPenaltyMult = 1.0;

      // redcard_filter is filter-only (note only)
      if (strategiesMap?.redcard_filter?.enabled) {
        const penalty = safeNumber(strategiesMap.redcard_filter?.params?.penalty, 1.0);
        const redStats = safeNumber(metrics?.cards?.red?.home, 0) + safeNumber(metrics?.cards?.red?.away, 0);

        let redByEvents = null;
        try {
          const ev = await apiFootball("/fixtures/events", { fixture: metrics.fixtureId });
          const arr = Array.isArray(ev?.response) ? ev.response : [];
          redByEvents = arr.some((e) => {
            const type = String(e?.type || "").toLowerCase();
            const detail = String(e?.detail || "").toLowerCase();
            return type === "card" && (detail.includes("red") || detail.includes("second yellow"));
          });
        } catch {
          redByEvents = null;
        }

        const hasRed = redByEvents === true || redStats > 0;
        if (hasRed) {
          riskPenaltyMult *= Math.max(1.0, penalty);
          if (debugEnabled) pushNote(rejectedByFixture, metrics, `red card detected → risk penalty x${penalty}`);
        } else if (debugEnabled) {
          pushNote(rejectedByFixture, metrics, "no red card detected");
        }
      }

      for (const key of strategyKeys) {
        const st = strategiesMap[key];
        const label = st?.label || key;

        if (!st?.enabled) {
          if (debugEnabled) {
            debugStats.skippedDisabled += 1;
            pushRejected(rejectedByFixture, metrics, { strategy: key, label, reasons: ["strategy disabled"] });
          }
          continue;
        }
        if (key === "redcard_filter") continue;

        debugStats.evaluated += 1;

        const reasons = evaluateParams(st?.params, metrics);
        let pick = null;

        if (key === "late_pressure_goal") {
          if (reasons.length === 0) {
            pick = buildPickBase(metrics, key, label);
            pick.tier = "A";
            pick.market = "TOTAL";
            pick.selection = "OVER";
            pick.betType = "live";
            pick.line = 0.5;
            pick.side = "over";

            const maxPressure = Math.max(metrics.pressure.home, metrics.pressure.away);
            const sotDiff = Math.abs(safeNumber(metrics.shotsOnGoal.home, 0) - safeNumber(metrics.shotsOnGoal.away, 0));
            const cornerDiff = Math.abs(safeNumber(metrics.corners.home, 0) - safeNumber(metrics.corners.away, 0));
            const strength = clamp01(0.55 * maxPressure + 0.20 * (sotDiff / 5) + 0.25 * (cornerDiff / 6));
            pick.edge = Number((0.02 + 0.10 * strength).toFixed(4));
            pick.kelly = Number((0.01 + 0.08 * strength).toFixed(4));
          }
        }

        if (key === "equalizer_push") {
          const diff = safeNumber(metrics.score.diff, 0);
          const absDiff = Math.abs(diff);
          const maxGoalDown = safeNumber(st?.params?.maxGoalDown, 1);
          if (absDiff === 0) reasons.push("not trailing (score is level)");

          const trailing = diff < 0 ? "home" : "away";
          const trailingPressure = safeNumber(metrics.pressure[trailing], 0);
          const trailingSOT = safeNumber(metrics.shotsOnGoal[trailing], 0);

          if (st?.params?.minPressure != null && trailingPressure < safeNumber(st.params.minPressure)) {
            reasons.push(`trailing pressure < minPressure (${trailingPressure.toFixed(2)} < ${st.params.minPressure})`);
          }
          if (st?.params?.minSOT != null && trailingSOT < safeNumber(st.params.minSOT)) {
            reasons.push(`trailing SOT < minSOT (${trailingSOT} < ${st.params.minSOT})`);
          }
          if (absDiff > maxGoalDown) {
            // already covered by evaluateParams
          }

          if (reasons.length === 0) {
            pick = buildPickBase(metrics, key, label);
            pick.tier = "A";
            pick.market = "NEXT_GOAL";
            pick.selection = trailing.toUpperCase();
            pick.betType = "live";
            pick.side = trailing;

            const strength = clamp01(0.60 * trailingPressure + 0.40 * (trailingSOT / 6));
            pick.edge = Number((0.02 + 0.10 * strength).toFixed(4));
            pick.kelly = Number((0.01 + 0.08 * strength).toFixed(4));
          }
        }

        if (key === "under_control") {
          if (reasons.length === 0) {
            pick = buildPickBase(metrics, key, label);
            pick.tier = "B";
            pick.market = "TOTAL";
            pick.selection = "UNDER";
            pick.betType = "live";
            const tg = safeNumber(metrics.score.home, 0) + safeNumber(metrics.score.away, 0);
            pick.line = tg + 1.5;
            pick.side = "under";

            const shotsSum = safeNumber(metrics.shotsTotal.home, 0) + safeNumber(metrics.shotsTotal.away, 0);
            const sotSum = safeNumber(metrics.shotsOnGoal.home, 0) + safeNumber(metrics.shotsOnGoal.away, 0);
            const xgSum = safeNumber(metrics.xgProxy.home, 0) + safeNumber(metrics.xgProxy.away, 0);
            const calm = clamp01(1 - clamp01(0.05 * shotsSum + 0.10 * sotSum + 0.35 * xgSum));
            pick.edge = Number((0.01 + 0.06 * calm).toFixed(4));
            pick.kelly = Number((0.005 + 0.05 * calm).toFixed(4));
          }
        }

        if (key === "value_1x2") {
          // placeholder: keep your existing logic here (not central to sync-results)
          // If you already added real odds logic previously, keep it. For now, we just skip pick build to avoid false picks.
          // (You can paste your working value_1x2 builder back here if you want.)
          reasons.push("value_1x2 builder not included in this snippet (keep your working one here)");
        }

        if (!pick) {
          debugStats.rejected += 1;
          if (debugEnabled) pushRejected(rejectedByFixture, metrics, { strategy: key, label, reasons });
          continue;
        }

        pick.riskPenaltyMult = Number(riskPenaltyMult.toFixed(3));

        // Add missing fields for UI (time/league/stake/pickId/score/minute)
        finalizePickForUI(pick, metrics);

        const dkey = makeDedupKey(pick);
        if (dedupSet.has(dkey)) continue;
        dedupSet.add(dkey);

        picks.push(pick);
        debugStats.passed += 1;

        if (debugEnabled) {
          debugPassed.push({
            fixtureId: metrics.fixtureId,
            minute: metrics.minute,
            home: metrics.teams.home.name,
            away: metrics.teams.away.name,
            score: `${metrics.score.home}-${metrics.score.away}`,
            strategy: key,
            label,
            side: pick.side,
          });
        }

        appendNdjson(PICKS_LOG, { time: nowIso(), type: "pick", pick });
      }
    }

    const latencyMs = Date.now() - startedAt;

    const risk = {
      generatedAt: nowIso(),
      latencyMs,
      note: "backend source-of-truth; picks may be empty and is not an error",
    };

    const response = {
      status: "success",
      totalFixtures: fixtures.length,
      totalPicks: picks.length,
      picks,
      risk,
    };

    if (debugEnabled) {
      const rejectedGrouped = Array.from(rejectedByFixture.values())
        .filter((b) => (Array.isArray(b.rejected) && b.rejected.length > 0) || (Array.isArray(b.notes) && b.notes.length > 0))
        .sort((a, b) => {
          const ar = Array.isArray(a.rejected) ? a.rejected.length : 0;
          const br = Array.isArray(b.rejected) ? b.rejected.length : 0;
          if (br !== ar) return br - ar; // rejected count desc
          const am = safeNumber(a.minute, 0);
          const bm = safeNumber(b.minute, 0);
          if (bm !== am) return bm - am; // minute desc
          return safeNumber(b.fixtureId, 0) - safeNumber(a.fixtureId, 0);
        })
        .slice(0, 1200);

      response.debug = {
        enabled: true,
        stats: debugStats,
        passed: debugPassed.slice(0, 600),
        rejected: rejectedGrouped,
      };
    }

    res.json(response);
  } catch (e) {
    res.status(500).json({ status: "error", message: e?.message || String(e) });
  }
});

/**
 * POST /api/results/sync
 * Manual settle after games finish (no DB):
 * - reads logs/picks.ndjson
 * - checks fixture final score/status
 * - settles supported markets (1X2, TOTAL with line)
 * - appends settled records into logs/results.ndjson
 *
 * Optional body:
 * { limit: 300 }  // max picks to inspect (newest-first)
 * { dryRun: true } // no write, just report
 */
app.post("/api/results/sync", async (req, res) => {
  const limit = Math.max(1, Math.min(2000, safeNumber(req.body?.limit, 400)));
  const dryRun = toBool(req.body?.dryRun);

  const picksRaw = readNdjson(PICKS_LOG);
  const resultsRaw = readNdjson(RESULTS_LOG);

  // already-settled pickIds
  const settledIds = new Set();
  for (const r of resultsRaw) {
    const pickId = r?.pickId;
    if (pickId) settledIds.add(pickId);
  }

  // normalize picks (keep newest first)
  const normalized = [];
  for (let i = 0; i < picksRaw.length; i++) {
    const p = normalizePickRecord(picksRaw[i], i);
    if (p && p.fixtureId) normalized.push(p);
  }
  normalized.sort((a, b) => String(b.ts).localeCompare(String(a.ts)));

  const toInspect = normalized.slice(0, limit);

  let checked = 0;
  let settled = 0;
  let skipped = 0;

  const settledOut = [];
  const skippedOut = [];

  for (const p of toInspect) {
    const pickId = makePickId(p);
    if (settledIds.has(pickId)) continue; // already written to results

    // only pending-like picks
    const r = String(p.result || "PENDING").toUpperCase();
    if (r !== "PENDING" && r !== "OPEN") continue;

    checked += 1;

    // fetch fixture by id
    let fx;
    try {
      const fxRes = await apiFootball("/fixtures", { id: p.fixtureId });
      fx = Array.isArray(fxRes?.response) ? fxRes.response[0] : null;
    } catch (e) {
      skipped += 1;
      skippedOut.push({ pickId, fixtureId: p.fixtureId, reason: `fixture fetch failed: ${e?.message || String(e)}` });
      continue;
    }

    if (!fx?.fixture?.status) {
      skipped += 1;
      skippedOut.push({ pickId, fixtureId: p.fixtureId, reason: "fixture status missing" });
      continue;
    }

    const short = String(fx.fixture.status.short || "").toUpperCase();
    const isFinished = ["FT", "AET", "PEN"].includes(short);

    if (!isFinished) {
      skipped += 1;
      skippedOut.push({ pickId, fixtureId: p.fixtureId, reason: `not finished (status=${short || "?"})` });
      continue;
    }

    const scoreHome = safeNumber(fx?.goals?.home, 0);
    const scoreAway = safeNumber(fx?.goals?.away, 0);

    // Determine market from new picks OR fallback legacy betType
    const market = p.market || (p.betType === "value_1x2" ? "1X2" : null);
    const side = (p.side || "").toLowerCase();
    const oddsBet = Number(p.odds);
    const stake = Number(p.stake ?? 1);

    let outcome = "SKIP";
    let reason = "";

    // 1X2
    if (market === "1X2") {
      if (!["home", "away", "draw"].includes(side)) {
        outcome = "SKIP";
        reason = "missing side for 1X2 (need home/away/draw)";
      } else {
        outcome = settle1x2(side, scoreHome, scoreAway);
      }
    }
    // TOTAL
    else if (market === "TOTAL") {
      const selection = p.selection || (side === "over" ? "OVER" : side === "under" ? "UNDER" : "");
      const line = p.line;
      const settledTotal = settleTotal(selection, line, scoreHome, scoreAway);
      outcome = settledTotal.outcome;
      reason = settledTotal.reason || "";
    } else {
      outcome = "SKIP";
      reason = "unsupported/insufficient bet schema for auto-settle (need market 1X2 or TOTAL+line)";
    }

    if (outcome === "SKIP") {
      skipped += 1;
      skippedOut.push({ pickId, fixtureId: p.fixtureId, strategy: p.strategy, reason });
      continue;
    }

    const profit = profitForOutcome(outcome, oddsBet, stake);

    const resultRecord = {
      time: nowIso(),
      type: "result",
      pickId,
      fixtureId: p.fixtureId,
      strategy: p.strategy,
      tier: p.tier,
      market: market || null,
      side: side || null,
      selection: p.selection || null,
      line: p.line ?? null,
      odds_bet: Number.isFinite(oddsBet) ? oddsBet : null,
      stake: Number.isFinite(stake) ? stake : 1,
      finalScore: `${scoreHome}-${scoreAway}`,
      outcome, // WIN / LOSE / PUSH
      profit,
      ts_pick: p.ts,
    };

    if (!dryRun) appendNdjson(RESULTS_LOG, resultRecord);

    settled += 1;
    settledOut.push(resultRecord);
  }

  res.json({
    status: "success",
    inspectedLimit: limit,
    checkedPending: checked,
    settled,
    skipped,
    dryRun: !!dryRun,
    settledPreview: settledOut.slice(0, 50),
    skippedPreview: skippedOut.slice(0, 80),
  });
});

/**
 * GET /api/performance
 * Reads logs/results.ndjson and aggregates by strategy:
 * - bets, wins, losses, pushes
 * - winRate
 * - profitSum, stakeSum, ROI
 */
app.get("/api/performance", (req, res) => {
  const resultsRaw = readNdjson(RESULTS_LOG);

  const byStrat = new Map();

  for (const r of resultsRaw) {
    if (r?.type !== "result") continue;
    const strategy = r?.strategy || "unknown";
    const outcome = String(r?.outcome || "").toUpperCase();
    const stake = safeNumber(r?.stake, 1);
    const profit = safeNumber(r?.profit, 0);

    if (!byStrat.has(strategy)) {
      byStrat.set(strategy, {
        strategy,
        bets: 0,
        wins: 0,
        losses: 0,
        pushes: 0,
        profitSum: 0,
        stakeSum: 0,
      });
    }
    const s = byStrat.get(strategy);
    s.bets += 1;
    if (outcome === "WIN") s.wins += 1;
    else if (outcome === "LOSE") s.losses += 1;
    else s.pushes += 1;

    s.profitSum += profit;
    s.stakeSum += stake;
  }

  const rows = Array.from(byStrat.values()).map((s) => {
    const winRate = s.bets ? s.wins / s.bets : 0;
    const roi = s.stakeSum ? s.profitSum / s.stakeSum : 0;
    return {
      ...s,
      winRate: Number(winRate.toFixed(4)),
      ROI: Number(roi.toFixed(4)),
    };
  });

  // default sort: ROI desc then winRate desc then bets desc
  rows.sort((a, b) => {
    if (b.ROI !== a.ROI) return b.ROI - a.ROI;
    if (b.winRate !== a.winRate) return b.winRate - a.winRate;
    return b.bets - a.bets;
  });

  res.json({ status: "success", strategies: rows });
});



// ===============================
// Daily Summary (baseline) — picks.ndjson + results.ndjson
// GET /api/summary/day?date=YYYY-MM-DD
// Notes:
// - Uses pick.ts as the primary day key (fallback to result.time).
// - Splits totals by market: HANDICAP vs TOTAL (and others if present).
// - P/L is based on result.profit, stake is result.stake.
// ===============================
app.get("/api/summary/day", (req, res) => {
  try {
    const date = String(req.query?.date || "").trim() || nowIso().slice(0, 10); // YYYY-MM-DD
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      return res.status(400).json({ status: "error", message: "Invalid date. Use YYYY-MM-DD" });
    }

    const picksRaw = readNdjson(PICKS_LOG);
    const resultsRaw = readNdjson(RESULTS_LOG);

    const settledById = new Map(); // pickId -> result
    for (const r of resultsRaw) {
      if (r?.type !== "result") continue;
      if (!r?.pickId) continue;
      settledById.set(r.pickId, r);
    }

    function dayKeyFromPick(p) {
      const ts = p?.ts || p?.time || "";
      return String(ts).slice(0, 10);
    }
    function dayKeyFromResult(r) {
      // prefer ts_pick (entry day) to group by "วันที่เข้า"
      const ts = r?.ts_pick || r?.time || "";
      return String(ts).slice(0, 10);
    }
    function normMarket(x) {
      const m = String(x || "").toUpperCase();
      if (m.includes("HANDICAP") || m === "AH") return "HANDICAP";
      if (m.includes("TOTAL") || m === "OU") return "TOTAL";
      if (m === "1X2") return "1X2";
      return m || "UNKNOWN";
    }
    function initBucket(name) {
      return {
        name,
        picks: 0,          // total picks (including pending)
        settled: 0,        // results counted
        pending: 0,
        win: 0,
        lose: 0,
        half_win: 0,
        half_lose: 0,
        push: 0,
        stakeSum: 0,
        profitSum: 0,
        ROI: 0,
        winRate: 0,
      };
    }
    function applyResult(bucket, r) {
      const outcome = String(r?.outcome || "").toUpperCase();
      const stake = safeNumber(r?.stake, 1);
      const profit = safeNumber(r?.profit, 0);

      bucket.settled += 1;
      bucket.stakeSum += stake;
      bucket.profitSum += profit;

      if (outcome === "WIN") bucket.win += 1;
      else if (outcome === "LOSE") bucket.lose += 1;
      else if (outcome === "PUSH") bucket.push += 1;
      else if (outcome === "HALF_WIN") bucket.half_win += 1;
      else if (outcome === "HALF_LOSE") bucket.half_lose += 1;
      else {
        // keep unknown outcomes out of W/L stats but still count settled
      }
    }
    function finalize(bucket) {
      const decided = bucket.win + bucket.lose + bucket.half_win + bucket.half_lose;
      bucket.winRate = decided > 0 ? bucket.win / decided : 0;
      bucket.ROI = bucket.stakeSum > 0 ? bucket.profitSum / bucket.stakeSum : 0;

      // rounding (keep stable JSON)
      bucket.stakeSum = Number(bucket.stakeSum.toFixed(4));
      bucket.profitSum = Number(bucket.profitSum.toFixed(4));
      bucket.winRate = Number(bucket.winRate.toFixed(4));
      bucket.ROI = Number(bucket.ROI.toFixed(4));
      return bucket;
    }

    const overall = initBucket("OVERALL");
    const byMarket = new Map();    // market -> bucket
    const byStrategy = new Map();  // strategy -> bucket
    const byMarketStrategy = new Map(); // key market||strategy

    // 1) Count picks of the day + pending
    for (const p of picksRaw) {
      if (p?.type !== "pick") continue;
      if (dayKeyFromPick(p) !== date) continue;

      const market = normMarket(p.market);
      const strategy = p.strategy || "unknown";

      overall.picks += 1;

      if (!byMarket.has(market)) byMarket.set(market, initBucket(market));
      byMarket.get(market).picks += 1;

      if (!byStrategy.has(strategy)) byStrategy.set(strategy, initBucket(strategy));
      byStrategy.get(strategy).picks += 1;

      const mk = market + "||" + strategy;
      if (!byMarketStrategy.has(mk)) byMarketStrategy.set(mk, initBucket(mk));
      byMarketStrategy.get(mk).picks += 1;

      const settled = p.pickId ? settledById.get(p.pickId) : null;
      if (!settled) {
        overall.pending += 1;
        byMarket.get(market).pending += 1;
        byStrategy.get(strategy).pending += 1;
        byMarketStrategy.get(mk).pending += 1;
      }
    }

    // 2) Aggregate results of the day (group by entry day = ts_pick)
    for (const r of resultsRaw) {
      if (r?.type !== "result") continue;
      if (dayKeyFromResult(r) !== date) continue;

      const market = normMarket(r.market);
      const strategy = r.strategy || "unknown";

      applyResult(overall, r);

      if (!byMarket.has(market)) byMarket.set(market, initBucket(market));
      applyResult(byMarket.get(market), r);

      if (!byStrategy.has(strategy)) byStrategy.set(strategy, initBucket(strategy));
      applyResult(byStrategy.get(strategy), r);

      const mk = market + "||" + strategy;
      if (!byMarketStrategy.has(mk)) byMarketStrategy.set(mk, initBucket(mk));
      applyResult(byMarketStrategy.get(mk), r);
    }

    // finalize
    finalize(overall);

    const marketsOut = {};
    for (const [k, v] of byMarket.entries()) marketsOut[k] = finalize(v);

    // split focus: HANDICAP vs TOTAL for baseline
    const focus = {
      HANDICAP: marketsOut.HANDICAP || finalize(initBucket("HANDICAP")),
      TOTAL: marketsOut.TOTAL || finalize(initBucket("TOTAL")),
    };

    const strategiesOut = Array.from(byStrategy.values()).map(finalize).sort((a, b) => {
      // ROI desc then winRate desc then picks desc
      if (b.ROI !== a.ROI) return b.ROI - a.ROI;
      if (b.winRate !== a.winRate) return b.winRate - a.winRate;
      return (b.picks - a.picks);
    });

    const marketStrategyOut = Array.from(byMarketStrategy.entries()).map(([k, v]) => {
      const [market, strategy] = k.split("||");
      const b = finalize(v);
      return { market, strategy, ...b };
    }).sort((a, b) => {
      if (a.market !== b.market) return a.market.localeCompare(b.market);
      if (b.ROI !== a.ROI) return b.ROI - a.ROI;
      return (b.picks - a.picks);
    });

    res.json({
      status: "success",
      date,
      overall,
      focus,          // { HANDICAP, TOTAL }
      markets: marketsOut,
      strategies: strategiesOut,
      marketStrategies: marketStrategyOut,
    });
  } catch (e) {
    res.status(500).json({ status: "error", message: String(e?.message || e) });
  }
});


// ===== Start =====
app.listen(PORT, () => {
  console.log(`Win100 Live Scanner backend running on port ${PORT}`);
});
