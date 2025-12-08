// ============================================
// Win100 Live Scanner – Server (EV/CLV + Dedup/Cooldown + Caching)
// ============================================

require("dotenv").config();
const express = require("express");
const axios = require("axios");
const fs = require("fs");
const path = require("path");

const app = express();
app.use(express.json());
app.use(express.static("public"));

const PORT = process.env.PORT || 3000;
const OPENAI_KEY = process.env.OPENAI_API_KEY || "";
const FOOTBALL_KEY = process.env.API_FOOTBALL_KEY || "";
const DEFAULT_BOOKMAKER_ID = process.env.API_BOOKMAKER_ID || null;

// ---------------------------
// โควต้า + Performance Config
// ---------------------------
const SCAN_MAX_FIXTURES = Number(process.env.SCAN_MAX_FIXTURES || 60); // จำกัด fixture/รอบ
const TTL_STATS_MS = Number(process.env.TTL_STATS_MS || 30_000);       // cache สถิติ 30s
const TTL_ODDS_MS  = Number(process.env.TTL_ODDS_MS  || 60_000);       // cache ราคา 60s

// Dedup / Cooldown กันยิงซ้ำ
const DEDUP_CFG = {
  cooldownMin: Number(process.env.DEDUP_COOLDOWN_MIN || 8), // นาที
  minEdgeDelta: Number(process.env.DEDUP_MIN_EDGE_DELTA || 0.01),
  minPriceDelta: Number(process.env.DEDUP_MIN_PRICE_DELTA || 0.05),
};

// EV / Kelly
const EV_CONFIG = {
  minEdge: Number(process.env.EV_MIN_EDGE || 0.02),
  kellyFraction: Number(process.env.EV_KELLY_FRACTION || 0.5),
  stakeMin: Number(process.env.EV_STAKE_MIN || 0.25),
  stakeMax: Number(process.env.EV_STAKE_MAX || 1.5),
  tiers: [
    { name: "A", min: 0.62 },
    { name: "B", min: 0.56 },
    { name: "C", min: 0.52 },
  ],
};

// Risk rules
const RISK_CONFIG = {
  dailyLossLimit: Number(process.env.RISK_DAILY_LOSS || -3.0),
  maxConsecutiveLose: Number(process.env.RISK_MAX_CONSECLOSE || 4),
};

const api = axios.create({
  baseURL: "https://v3.football.api-sports.io/",
  headers: { "x-apisports-key": FOOTBALL_KEY },
  timeout: 15000,
});

// Paths / Files
const LOG_DIR = path.join(__dirname, "logs");
const LOG_FILE = path.join(LOG_DIR, "picks.log");
const STRATEGIES_FILE = path.join(__dirname, "strategies_current.json");
const defaultStrategies = require("./strategies_current.json");
let STRATEGIES = loadStrategies();

// ---------------------------
// Utils
// ---------------------------
function clamp(v, a, b) { return Math.max(a, Math.min(b, v)); }
function getLocalTimestamp() {
  const d = new Date();
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  const hh = String(d.getHours()).padStart(2, "0");
  const mi = String(d.getMinutes()).padStart(2, "0");
  const ss = String(d.getSeconds()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd}T${hh}:${mi}:${ss}`;
}
function dateKey(ts) { return (ts || "").substring(0, 10); }
function ensureLogDir(){ if(!fs.existsSync(LOG_DIR)) fs.mkdirSync(LOG_DIR); }
function logPick(p){ ensureLogDir(); fs.appendFileSync(LOG_FILE, JSON.stringify(p) + "\n"); }
function loadAllPicksFromLog(){
  if(!fs.existsSync(LOG_FILE)) return [];
  return fs.readFileSync(LOG_FILE, "utf8")
    .split("\n").map(l=>l.trim()).filter(Boolean)
    .map(l=> { try { return JSON.parse(l); } catch { return null; } })
    .filter(Boolean);
}
function loadStrategies(){
  try{
    if (fs.existsSync(STRATEGIES_FILE)){
      return JSON.parse(fs.readFileSync(STRATEGIES_FILE, "utf8"));
    }
  }catch(e){ console.error("loadStrategies:", e.message); }
  return defaultStrategies;
}
function saveStrategies(obj){
  STRATEGIES = obj;
  fs.writeFileSync(STRATEGIES_FILE, JSON.stringify(obj, null, 2), "utf8");
}

// ---------------------------
// Caching: ลดการเรียก API-FOOTBALL (ช่วยอยู่ใน 7,500 req/day)
// ---------------------------
const cacheStats = new Map(); // key: fixtureId -> { tsMs, data }
const cacheOdds  = new Map(); // key: fixtureId -> { tsMs, data }

async function fetchFixturesLive() {
  const r = await api.get("/fixtures", { params: { live: "all" } });
  let arr = r.data.response || [];
  if (arr.length > SCAN_MAX_FIXTURES) arr = arr.slice(0, SCAN_MAX_FIXTURES);
  return arr;
}
async function fetchFixtureStatsForFixture(fix) {
  const id = fix.fixture.id;
  const c = cacheStats.get(id);
  const now = Date.now();
  if (c && now - c.tsMs < TTL_STATS_MS) return c.data;

  try {
    const r = await api.get("/fixtures/statistics", { params: { fixture: id } });
    const homeId = fix.teams.home.id; const awayId = fix.teams.away.id;
    const arr = r.data.response || [];
    let homeStats = [], awayStats = [];
    for (const it of arr){
      const tid = it.team?.id;
      const st = Array.isArray(it.statistics) ? it.statistics : [];
      if (tid === homeId) homeStats = st;
      else if (tid === awayId) awayStats = st;
    }
    const data = { homeStats, awayStats };
    cacheStats.set(id, { tsMs: now, data });
    return data;
  } catch (e) {
    console.error("fetchFixtureStats:", id, e.message);
    return { homeStats: [], awayStats: [] };
  }
}
async function fetchOdds(fixtureId) {
  const c = cacheOdds.get(fixtureId);
  const now = Date.now();
  if (c && now - c.tsMs < TTL_ODDS_MS) return c.data;
  try{
    const params = { fixture: fixtureId };
    if (DEFAULT_BOOKMAKER_ID) params.bookmaker = DEFAULT_BOOKMAKER_ID;
    const r = await api.get("/odds", { params });
    const resp = r.data.response || [];
    if (!resp.length) { cacheOdds.set(fixtureId, { tsMs: now, data: null }); return null; }

    const bookmaker = resp[0].bookmakers?.[0];
    const bets = bookmaker?.bets || [];
    const bet1x2 = bets.find(b => /1x2|Match Winner/i.test(b.name)) || bets[0];
    let homeOdd = null, drawOdd = null, awayOdd = null;
    for (const v of (bet1x2?.values || [])) {
      if (v.value === "Home" || v.value === "1") homeOdd = parseFloat(v.odd);
      if (v.value === "Draw" || v.value === "X") drawOdd = parseFloat(v.odd);
      if (v.value === "Away" || v.value === "2") awayOdd = parseFloat(v.odd);
    }
    const data = { homeOdd, drawOdd, awayOdd, bookmaker: bookmaker?.name || "" };
    cacheOdds.set(fixtureId, { tsMs: now, data });
    return data;
  }catch(e){
    console.error("fetchOdds:", fixtureId, e.message);
    return null;
  }
}
async function fetchClosingOdds(fid){ return await fetchOdds(fid); }
function choosePrice(odds, betSide){
  if(!odds || !betSide) return null;
  const s = betSide.toLowerCase();
  if (s.includes("home")) return odds.homeOdd ?? null;
  if (s.includes("away")) return odds.awayOdd ?? null;
  return null;
}

// ---------------------------
// Dedup / Cooldown
// ---------------------------
const recentPickMap = new Map(); // key -> { tsMs, edge, price }
function pickKey(p){ return `${p.fixtureId}|${p.strategy}|${p.betSide}`; }
function allowEmit(p){
  const key = pickKey(p);
  const now = Date.now();
  const prev = recentPickMap.get(key);
  if (!prev){
    recentPickMap.set(key, { tsMs: now, edge: p.edge ?? 0, price: p.priceTaken ?? null });
    return true;
  }
  const elapsedMin = (now - prev.tsMs)/60000;
  const edgeDelta  = Math.abs((p.edge ?? 0) - (prev.edge ?? 0));
  const priceDelta = Math.abs((p.priceTaken ?? 0) - (prev.price ?? 0));
  if (elapsedMin >= DEDUP_CFG.cooldownMin &&
      (edgeDelta >= DEDUP_CFG.minEdgeDelta || priceDelta >= DEDUP_CFG.minPriceDelta)){
    recentPickMap.set(key, { tsMs: now, edge: p.edge ?? 0, price: p.priceTaken ?? null });
    return true;
  }
  return false;
}

// ---------------------------
// Stats helpers
// ---------------------------
function getStat(statsArr, types) {
  const arr = Array.isArray(statsArr) ? statsArr : [];
  for (const t of types) {
    const row = arr.find((s) => s.type === t);
    if (!row || row.value == null) continue;
    let v = row.value;
    if (typeof v === "string") {
      v = v.replace("%", "").trim();
      const n = parseFloat(v);
      if (!isNaN(n)) return n;
    }
    if (typeof v === "number") return v;
  }
  return 0;
}
function modelProbFromContext(strategy, ctx){
  let p = 0.54;
  const { minute, sogTotal, xGTotal, sogDiff, xgDiff, favByOdds, fallback } = ctx;

  if (strategy === "attack_pressure"){
    p += 0.04; p += clamp(sogDiff*0.015 + xgDiff*0.08, -0.06, 0.10);
  }
  if (strategy === "one_side_attack"){
    p += 0.03; p += clamp(sogDiff*0.02, -0.05, 0.08);
  }
  if (strategy === "anti_price"){
    p += favByOdds ? 0.03 : 0; p += clamp(xgDiff*0.07, -0.05, 0.09);
  }
  if (["over75","over_momentum","live_xg"].includes(strategy)){
    p = 0.52 + clamp((sogTotal-8)*0.01 + (xGTotal-1.6)*0.08, -0.05, 0.12);
  }
  if (strategy === "favorite_comeback") p += 0.03;
  if (strategy === "pp_index") p += 0.03;

  if (minute >= 70) p += 0.01;
  if (fallback) p -= 0.03;
  return clamp(p, 0.50, 0.70);
}
function evPackFor1x2(priceTaken, modelProb){
  if (typeof priceTaken !== "number" || priceTaken <= 1) {
    return { impliedProb: null, edge: null, kelly: null, stakeUnits: null, tier: "C", edge_ok: false };
  }
  const impliedProb = 1 / priceTaken;
  const edge = modelProb - impliedProb;
  const kellyRaw = edge / (priceTaken - 1);
  const kelly = clamp(kellyRaw, 0, 1);
  const stakeUnits = clamp(kelly * EV_CONFIG.kellyFraction, EV_CONFIG.stakeMin, EV_CONFIG.stakeMax);
  let tier = "C";
  for (const t of EV_CONFIG.tiers) { if (modelProb >= t.min) { tier = t.name; break; } }
  const edge_ok = edge >= EV_CONFIG.minEdge;
  return { impliedProb, edge, kelly, stakeUnits, tier, edge_ok };
}
function gradeResult(pick, fh, fa){
  const diff = fh - fa;
  switch (pick.strategy) {
    case "attack_pressure":
    case "one_side_attack":
    case "favorite_comeback":
    case "pp_index":
    case "anti_book":
    case "anti_price":
      if (pick.betSide?.includes("home")) return diff > 0 ? "WIN" : "LOSE";
      if (pick.betSide?.includes("away")) return diff < 0 ? "WIN" : "LOSE";
      return "PENDING";
    case "smart_underdog":
      return (pick.betSide.includes("home") ? fh : fa) >= (pick.betSide.includes("home") ? fa : fh) ? "WIN" : "LOSE";
    case "over75":
    case "over_momentum":
    case "live_xg":
      return fh + fa >= 2 ? "WIN" : "LOSE";
    case "goal_85":
    case "corner_storm":
      return "PENDING";
    case "ah_1_5":
      return "WIN";
    default:
      return "PENDING";
  }
}
function computeROI(result, priceTaken){
  if (result === "WIN" && typeof priceTaken === "number") return +(priceTaken - 1).toFixed(4);
  if (result === "LOSE") return -1;
  return 0;
}
function computeCLVPercent(priceTaken, closingPrice){
  if (typeof priceTaken !== "number" || typeof closingPrice !== "number" || closingPrice === 0) return null;
  return +(((closingPrice - priceTaken) / closingPrice) * 100).toFixed(2);
}

// ---------------------------
// AI (เฉพาะเมื่อผ่าน allowEmit เท่านั้น เพื่อลด cost)
// ---------------------------
async function askAI(pick){
  try{
    const oddsText =
      pick.odds?.homeOdd && pick.odds?.awayOdd
        ? `ราคา: H ${pick.odds.homeOdd} / A ${pick.odds.awayOdd}`
        : "ไม่มีราคา 1x2";
    const prompt = `สรุปไทยสั้น 3-5 บรรทัด
คู่ ${pick.home} vs ${pick.away} นาที ${pick.minuteAtScan} สกอร์ ${pick.scoreAtScan}
สูตร ${pick.strategy} ฝั่ง ${pick.betSide} | ${oddsText}
เตือน: ไม่ใช่คำแนะนำการลงทุน`;
    const r = await axios.post(
      "https://api.openai.com/v1/chat/completions",
      { model: "gpt-4.1-mini", messages: [{ role: "user", content: prompt }], temperature: 0.3 },
      { headers: { Authorization: `Bearer ${OPENAI_KEY}` }, timeout: 30000 }
    );
    return r.data.choices?.[0]?.message?.content?.trim() || "";
  }catch{ return ""; }
}

// ---------------------------
// Strategy evaluation
// ---------------------------
function evaluateStrategies(f, odds, extraStats = {}, riskState){
  const picks = [];

  const minute = f.fixture.status.elapsed ?? 0;
  const league = `${f.league.country} - ${f.league.name}`;
  const home = f.teams.home.name;
  const away = f.teams.away.name;
  const gh = f.goals.home ?? 0;
  const ga = f.goals.away ?? 0;
  const tg = gh + ga;
  const score = `${gh} - ${ga}`;

  const homeStats = Array.isArray(extraStats.homeStats) ? extraStats.homeStats : [];
  const awayStats = Array.isArray(extraStats.awayStats) ? extraStats.awayStats : [];
  const sogH = getStat(homeStats, ["Shots on Goal", "Shots on target"]);
  const sogA = getStat(awayStats, ["Shots on Goal", "Shots on target"]);
  const possH = getStat(homeStats, ["Ball Possession", "Ball Possession %"]);
  const possA = getStat(awayStats, ["Ball Possession", "Ball Possession %"]);
  const xG_H = getStat(homeStats, ["Expected Goals", "xG"]);
  const xG_A = getStat(awayStats, ["Expected Goals", "xG"]);
  const sogTotal = sogH + sogA;
  const xGTotal = xG_H + xG_A;
  const hasStats = sogTotal > 0 || xGTotal > 0 || (possH + possA) > 0;

  const favByOdds =
    odds && odds.homeOdd && odds.awayOdd
      ? (odds.homeOdd < odds.awayOdd ? "home" : "away")
      : null;

  function push(strategy, betSide, extra = {}){
    if (riskState.paused) return;
    const priceTaken = choosePrice(odds, betSide);
    const ctx = {
      minute, sogTotal, xGTotal,
      sogDiff: betSide.includes("home") ? (sogH - sogA) : (sogA - sogH),
      xgDiff: betSide.includes("home") ? (xG_H - xG_A) : (xG_A - xG_H),
      favByOdds, fallback: !!extra.note,
    };
    const modelProb = modelProbFromContext(strategy, ctx);
    const { impliedProb, edge, kelly, stakeUnits: stake0, tier, edge_ok } =
      evPackFor1x2(priceTaken, modelProb);
    const stakeUnits = (stake0 && riskState.stakeScale < 1) ? +(stake0 * riskState.stakeScale).toFixed(2) : stake0;

    picks.push({
      fixtureId: f.fixture.id,
      strategy, strategyVersion: "v4",
      betSide,
      league, home, away,
      goalsHome: gh, goalsAway: ga,
      minuteAtScan: minute, scoreAtScan: score,
      ts: getLocalTimestamp(),
      result: "PENDING",
      odds: odds || null,
      priceTaken: typeof priceTaken === "number" ? priceTaken : null,
      modelProb: +((modelProb || 0)).toFixed(4),
      impliedProb: impliedProb !== null ? +impliedProb.toFixed(4) : null,
      edge: edge !== null ? +edge.toFixed(4) : null,
      kelly: kelly !== null ? +kelly.toFixed(4) : null,
      stakeUnits: stakeUnits !== null ? +stakeUnits.toFixed(2) : null,
      tier, edge_ok,
      ...extra,
    });
  }

  const S = STRATEGIES;

  // ตัวอย่างสูตร (ชุดย่อ)
  // attack_pressure
  if (S.attack_pressure?.enabled !== false){
    const P = S.attack_pressure.params || {};
    const mMin = P.minuteMin ?? 20, mMax = P.minuteMax ?? 85;
    const sogDiffMin = P.sogDiffMin ?? 3, possDiffMin = P.possDiffMin ?? 5, xgDiffMin = P.xgDiffMin ?? 0.3;
    if (minute >= mMin && minute <= mMax){
      if (hasStats){
        if ((sogH - sogA) >= sogDiffMin && (possH - possA) >= possDiffMin && (xG_H - xG_A) >= xgDiffMin) push("attack_pressure","home");
        if ((sogA - sogH) >= sogDiffMin && (possA - possH) >= possDiffMin && (xG_A - xG_H) >= xgDiffMin) push("attack_pressure","away");
      }else if (favByOdds){
        if (favByOdds==="home" && gh<=ga && minute>=30 && gh-ga>=-2) push("attack_pressure","home",{note:"fallback_no_stats"});
        if (favByOdds==="away" && ga<=gh && minute>=30 && ga-gh>=-2) push("attack_pressure","away",{note:"fallback_no_stats"});
      }
    }
  }

  // one_side_attack
  if (S.one_side_attack?.enabled !== false && hasStats){
    const P = S.one_side_attack.params || {};
    const mMin = P.minuteMin ?? 15, mMax = P.minuteMax ?? 80;
    const sogDiffMin = P.sogDiffMin ?? 2;
    if (minute >= mMin && minute <= mMax){
      if (sogH >= sogA + sogDiffMin) push("one_side_attack","home");
      if (sogA >= sogH + sogDiffMin) push("one_side_attack","away");
    }
  }

  // anti_price
  if (S.anti_price?.enabled !== false && favByOdds){
    const P = S.anti_price.params || {};
    const mMin = P.minuteMin ?? 30, mMax = P.minuteMax ?? 80, xgTotalMin = P.xgTotalMin ?? 0.8;
    if (minute >= mMin && minute <= mMax){
      if (hasStats && (xG_H + xG_A) >= xgTotalMin){
        if (favByOdds==="home" && gh<=ga) push("anti_price","home");
        if (favByOdds==="away" && ga<=gh) push("anti_price","away");
      }else{
        if (favByOdds==="home" && gh<=ga && minute>=50) push("anti_price","home",{note:"fallback_no_stats"});
        if (favByOdds==="away" && ga<=gh && minute>=50) push("anti_price","away",{note:"fallback_no_stats"});
      }
    }
  }

  // over75 / over_momentum / live_xg (ย่อ)
  if (S.over75?.enabled !== false){
    const P = S.over75.params || {};
    const mMin = P.minuteMin ?? 72, mMax = P.minuteMax ?? 88, totalGoalsMax = P.totalGoalsMax ?? 2;
    if (minute >= mMin && minute <= mMax && (gh+ga) <= totalGoalsMax) push("over75","over");
  }
  if (S.over_momentum?.enabled !== false){
    if (minute >= (S.over_momentum.params?.minuteMin ?? 50)) push("over_momentum","over");
  }
  if (S.live_xg?.enabled !== false){
    const P = S.live_xg.params || {};
    if (minute >= (P.minuteMin ?? 35) && minute <= (P.minuteMax ?? 82)) push("live_xg","goal_soon");
  }

  return picks;
}

// ---------------------------
// Risk snapshot (วันนี้)
// ---------------------------
let RISK_SNAPSHOT = { date:null, pnl:0, consecLose:0, paused:false, stakeScale:1 };
async function refreshRiskSnapshot(){
  const all = loadAllPicksFromLog();
  const today = new Date().toISOString().slice(0,10);
  const picks = all.filter(p => dateKey(p.ts) === today);

  // ดึงผล FT + closing odds แบบ cache
  const fids = [...new Set(picks.map(p=>p.fixtureId))];
  const finals = {};
  for(const id of fids){
    try{
      const r = await api.get("/fixtures", { params: { id } });
      const fx = r.data.response?.[0];
      if (fx?.fixture?.status?.short === "FT"){
        finals[id] = { fh: fx.goals.home ?? 0, fa: fx.goals.away ?? 0 };
      }
    }catch{}
  }

  let pnl = 0, consec = 0;
  const ordered = [...picks].sort((a,b)=> (a.ts||"").localeCompare(b.ts||""));
  for(const p of ordered){
    const fr = finals[p.fixtureId];
    if(!fr) continue;
    const res = gradeResult(p, fr.fh, fr.fa);
    if (res === "WIN" || res === "LOSE"){
      const roi = computeROI(res, p.priceTaken);
      pnl += roi;
      if (res === "LOSE") consec += 1; else consec = 0;
    }
  }
  RISK_SNAPSHOT = {
    date: today,
    pnl: +pnl.toFixed(4),
    consecLose: consec,
    paused: pnl <= RISK_CONFIG.dailyLossLimit,
    stakeScale: consec >= RISK_CONFIG.maxConsecutiveLose ? 0.5 : 1.0,
  };
}

// ---------------------------
// Stats / Dashboard helpers
// ---------------------------
async function computeStatsFromLog(){
  const picks = loadAllPicksFromLog();
  if (!picks.length) {
    return {
      totalPicks:0, gradedPicks:0,
      byStrategy:{}, byLeague:{}, byDate:{},
      timelineByDate:{}, timelineByWeek:{},
      roiTotal:0, roiAvg:0, clvAvg:null
    };
  }

  // ดึงผล FT + closing odds แบบประหยัดเรียก API
  const fids = [...new Set(picks.map(p=>p.fixtureId))];
  const results = {};
  for (const id of fids){
    try{
      const r = await api.get("/fixtures", { params: { id } });
      const fx = r.data.response?.[0];
      const final = fx?.fixture?.status?.short === "FT";
      results[id] = { final, fh: fx?.goals?.home ?? 0, fa: fx?.goals?.away ?? 0 };
      results[id].closingOdds = await fetchClosingOdds(id);
    }catch{
      results[id] = { final:false };
    }
  }

  // รวมสถิติภาพรวม + รายมิติ
  let graded = 0, roiTotal = 0, clvSum = 0, clvCount = 0;
  const byStrategy = {}, byLeague = {}, byDate = {};
  const timelineByDate = {}, timelineByWeek = {};

  function addBy(map, key, result, roi=0, clvPct=null){
    if(!map[key]) map[key] = { total:0, win:0, lose:0, pending:0, roiSum:0, roiAvg:0, clvSum:0, clvCount:0, clvAvg:null };
    const o = map[key];
    o.total += 1;
    if (result==="WIN"){ o.win+=1; o.roiSum += roi; }
    else if (result==="LOSE"){ o.lose+=1; o.roiSum += roi; }
    else { o.pending+=1; }

    if (clvPct !== null){ o.clvSum += clvPct; o.clvCount += 1; }
  }

  function addTimeline(map, bucketKey, strat, result, roi=0, clvPct=null){
    if(!map[bucketKey]) map[bucketKey] = {};
    if(!map[bucketKey][strat]) map[bucketKey][strat] =
      { total:0, win:0, lose:0, pending:0, roiSum:0, roiAvg:0, clvSum:0, clvCount:0, clvAvg:null };

    const o = map[bucketKey][strat];
    o.total += 1;
    if (result==="WIN"){ o.win+=1; o.roiSum += roi; }
    else if (result==="LOSE"){ o.lose+=1; o.roiSum += roi; }
    else { o.pending+=1; }

    if (clvPct !== null){ o.clvSum += clvPct; o.clvCount += 1; }
  }

  function weekBucket(ts){
    // คืนคีย์จันทร์แรกของสัปดาห์ในรูป YYYY-MM-DD
    const d = new Date(ts);
    const day = d.getDay(); // 0=Sun
    const delta = d.getDate() - day + (day===0 ? -6 : 1);
    const mon = new Date(d); mon.setDate(delta);
    const y=mon.getFullYear(), m=String(mon.getMonth()+1).padStart(2,"0"), dd=String(mon.getDate()).padStart(2,"0");
    return `${y}-${m}-${dd}`;
  }

  for (const p of picks){
    const fr = results[p.fixtureId] || {};
    const dKey = (p.ts||"").slice(0,10) || "unknown";
    const wKey = weekBucket(p.ts||new Date().toISOString());
    let result = "PENDING", roi = 0, clvPct = null;

    if (fr.final){
      // ให้ผล WIN/LOSE ตามกลยุทธ์
      const res = gradeResult(p, fr.fh, fr.fa);
      result = res;
      if (res==="WIN" || res==="LOSE"){
        graded += 1;
        roi = computeROI(res, p.priceTaken);
        roiTotal += roi;

        // CLV% (เทียบราคาเข้า vs Closing ของฝั่งที่เลือก)
        const closingPrice = choosePrice(fr.closingOdds, p.betSide);
        const c = computeCLVPercent(p.priceTaken, closingPrice);
        if (c !== null){ clvPct = c; clvSum += c; clvCount += 1; }
      }
    }

    // รวมภาพรวม
    addBy(byStrategy, p.strategy, result, roi, clvPct);
    addBy(byLeague, p.league || "unknown", result, roi, clvPct);
    addBy(byDate, dKey, result, roi, clvPct);

    // รวม timeline
    addTimeline(timelineByDate, dKey, p.strategy, result, roi, clvPct);
    addTimeline(timelineByWeek, wKey, p.strategy, result, roi, clvPct);
  }

  // สรุปค่าเฉลี่ย
  Object.keys(byStrategy).forEach(k=>{
    const s = byStrategy[k]; const f = s.win + s.lose;
    s.roiAvg = f ? +(s.roiSum / f).toFixed(4) : 0;
    s.clvAvg = s.clvCount ? +(s.clvSum / s.clvCount).toFixed(2) : null;
  });
  Object.keys(byDate).forEach(k=>{
    const s = byDate[k]; const f = s.win + s.lose;
    s.roiAvg = f ? +(s.roiSum / f).toFixed(4) : 0;
    s.clvAvg = s.clvCount ? +(s.clvSum / s.clvCount).toFixed(2) : null;
  });

  // timeline: คำนวณ roiAvg/clvAvg ต่อ period/strategy
  function finalizeTimeline(map){
    Object.keys(map).forEach(bucket=>{
      Object.keys(map[bucket]).forEach(strat=>{
        const s = map[bucket][strat];
        const f = s.win + s.lose;
        s.roiAvg = f ? +(s.roiSum / f).toFixed(4) : 0;
        s.clvAvg = s.clvCount ? +(s.clvSum / s.clvCount).toFixed(2) : null;
      });
    });
  }
  finalizeTimeline(timelineByDate);
  finalizeTimeline(timelineByWeek);

  const roiAvg = graded ? +(roiTotal/graded).toFixed(4) : 0;
  const clvAvg = clvCount ? +(clvSum/clvCount).toFixed(2) : null;

  return {
    totalPicks: picks.length,
    gradedPicks: graded,
    byStrategy, byLeague, byDate,
    timelineByDate, timelineByWeek,
    roiTotal: +roiTotal.toFixed(4),
    roiAvg, clvAvg
  };
}


async function getPicksAndStatsByDate(dateStr){
  const all = loadAllPicksFromLog();
  const picks = all.filter(p=> dateKey(p.ts) === dateStr);
  if (!picks.length){
    return { picks:[], summary:{ total:0, win:0, lose:0, pending:0, roiSum:0, roiAvg:0, clvAvg:null }, byStrategy:{} };
  }
  const fids = [...new Set(picks.map(p=>p.fixtureId))];
  const results = {};
  for (const id of fids){
    try{
      const r = await api.get("/fixtures", { params: { id } });
      const fx = r.data.response?.[0];
      if (!fx || fx.fixture.status?.short !== "FT"){ results[id] = { final:false }; continue; }
      results[id] = { final:true, fh:fx.goals.home??0, fa:fx.goals.away??0, closingOdds:await fetchClosingOdds(id) };
    }catch{ results[id] = { final:false }; }
  }

  const summary = { total:picks.length, win:0, lose:0, pending:0, roiSum:0, roiAvg:0, clvAvg:null };
  const byStrategy = {}; const enriched = []; let clvSum=0, clvCount=0;

  for (const p of picks){
    const fr = results[p.fixtureId];
    let result="PENDING", roi=0, closingPrice=null, clvPct=null;
    if (fr && fr.final){
      result = gradeResult(p, fr.fh, fr.fa);
      if (result==="WIN" || result==="LOSE"){
        roi = computeROI(result, p.priceTaken);
        summary[result.toLowerCase()] += 1; summary.roiSum += roi;
        closingPrice = choosePrice(fr.closingOdds, p.betSide);
        clvPct = computeCLVPercent(p.priceTaken, closingPrice);
        if (clvPct !== null){ clvSum += clvPct; clvCount += 1; }
      } else summary.pending += 1;
    } else summary.pending += 1;

    if (!byStrategy[p.strategy]) byStrategy[p.strategy] = { total:0, win:0, lose:0, pending:0, roiSum:0, roiAvg:0, clvSum:0, clvCount:0, clvAvg:null };
    const S = byStrategy[p.strategy];
    S.total += 1;
    if (result==="WIN") { S.win += 1; S.roiSum += roi; }
    else if (result==="LOSE") { S.lose += 1; S.roiSum += roi; }
    else { S.pending += 1; }
    if (clvPct !== null){ S.clvSum += clvPct; S.clvCount += 1; }

    enriched.push({ ...p, result, closingPrice, clvPct, roi });
  }

  const f = summary.win + summary.lose;
  summary.roiAvg = f ? +(summary.roiSum / f).toFixed(4) : 0;
  summary.clvAvg = clvCount ? +(clvSum / clvCount).toFixed(2) : null;
  Object.keys(byStrategy).forEach(k=>{
    const S = byStrategy[k]; const ff = S.win + S.lose;
    S.roiAvg = ff ? +(S.roiSum / ff).toFixed(4) : 0;
    S.clvAvg = S.clvCount ? +(S.clvSum / S.clvCount).toFixed(2) : null;
  });

  return { picks: enriched, summary, byStrategy };
}

// ---------------------------
// Routes
// ---------------------------
app.get("/api/scan", async (req, res) => {
  try{
    await refreshRiskSnapshot(); // อัปเดตสถานะวันนี้

    const fixtures = await fetchFixturesLive();
    let totalPicks = 0;
    const out = [];

    for (const f of fixtures){
      try{
        const odds = await fetchOdds(f.fixture.id);
        const stats = await fetchFixtureStatsForFixture(f);
        const picks = evaluateStrategies(f, odds, stats, RISK_SNAPSHOT);

        for (const p of picks){
          const is1x2 = p.betSide?.includes("home") || p.betSide?.includes("away");
          if (is1x2){
            if (p.edge_ok && allowEmit(p)) {
              p.ai = await askAI(p);
              logPick(p); out.push(p); totalPicks++;
            }
          } else {
            if (allowEmit(p)) {
              p.ai = await askAI(p);
              logPick(p); out.push(p); totalPicks++;
            }
          }
        }
      }catch(e){ console.error("scan fixture:", f.fixture.id, e.message); }
    }

    res.json({ status:"success", totalFixtures: fixtures.length, totalPicks, risk: RISK_SNAPSHOT, picks: out });
  }catch(e){
    res.json({ status:"error", message: e.message });
  }
});

app.get("/api/test-ai", async (req,res)=>{
  const ai = await askAI({
    league: "Test", home: "Team A", away: "Team B",
    scoreAtScan: "0-0", minuteAtScan: 60, strategy:"attack_pressure", betSide:"home",
    odds:{ homeOdd:1.9, awayOdd:3.8 }
  });
  res.json({ status:"success", ai_result: ai });
});

app.get("/api/stats", async (req,res)=>{
  try{
    const date = req.query.date;
    if (date){
      const data = await getPicksAndStatsByDate(date);
      return res.json({ status:"success", mode:"byDate", date, ...data });
    }
    const data = await computeStatsFromLog();
    res.json({ status:"success", mode:"overall", ...data });
  }catch(e){ res.json({ status:"error", message:e.message }); }
});

// Optimizer (เดิมใช้ได้ต่อ) – เน้น EV ไม่แดงก่อนคลาย
app.post("/api/ai-optimize", async (req,res)=>{
  try{
    const stats = await computeStatsFromLog();
    const payload = {
      strategies: STRATEGIES,
      performance: { totalPicks: stats.totalPicks, gradedPicks: stats.gradedPicks, byStrategy: stats.byStrategy, roiAvg: stats.roiAvg, clvAvg: stats.clvAvg },
      rule: { focusWinRateAtLeast: 0.55, focusMinSamples: 10, relaxThresholdPct: [0.15,0.25], mustNonNegativeEV: true }
    };

    const prompt = `
คุณเป็นนักปรับ threshold โดยใช้ EV (WinRate/ROI/CLV)
- คลายเฉพาะสูตรที่ WinRate ≥ 55% และ sample ≥ 10 และ (roiAvg ≥ 0 หรือ clvAvg ≥ 0)
- สูตรที่ roiAvg < -0.02 และ WinRate < 50% ให้เข้มขึ้นหรือปิด
ตอบ JSON เท่านั้น: {"strategies":{...}, "notes":[...]}
ข้อมูล:
${JSON.stringify(payload, null, 2)}
`.trim();

    const r = await axios.post(
      "https://api.openai.com/v1/chat/completions",
      { model:"gpt-4.1-mini", messages:[{ role:"user", content: prompt }], temperature:0.2 },
      { headers:{ Authorization:`Bearer ${OPENAI_KEY}` }, timeout:60000 }
    );

    let text = r.data.choices?.[0]?.message?.content || "{}";
    let cleaned = text.trim();
    if (cleaned.startsWith("```")) {
      cleaned = cleaned.replace(/^```[a-zA-Z]*\s*/i,"").replace(/```$/,"").trim();
    }
    const F = cleaned.indexOf("{"), L = cleaned.lastIndexOf("}");
    if (F !== -1 && L !== -1 && L>F) cleaned = cleaned.substring(F, L+1);

    let parsed; try{ parsed = JSON.parse(cleaned); }catch{ return res.json({ status:"error", message:"AI JSON parse error", raw:text, cleaned }); }
    res.json({ status:"success", currentStrategies: STRATEGIES, suggestions: parsed });
  }catch(e){ res.json({ status:"error", message:e.message }); }
});

app.post("/api/apply-strategies", (req,res)=>{
  try{
    const body = req.body || {};
    if (!body.strategies || typeof body.strategies !== "object"){
      return res.json({ status:"error", message:"ต้องส่ง field 'strategies' เป็น JSON object" });
    }
    saveStrategies(body.strategies);
    res.json({ status:"success", strategies: STRATEGIES });
  }catch(e){ res.json({ status:"error", message:e.message }); }
});

app.listen(PORT, ()=>{
  console.log(`Win100 running: http://localhost:${PORT}`);
  console.log(`Scanner  : http://localhost:${PORT}/`);
  console.log(`Dashboard: http://localhost:${PORT}/dashboard`);
  console.log(`Optimizer: http://localhost:${PORT}/ai_optimizer.html`);
});
