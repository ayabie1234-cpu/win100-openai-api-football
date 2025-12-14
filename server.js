// ============================================
// Win100 Live Scanner – Server (CommonJS)
// API-Football + OpenAI + Odds + Stats + AI Optimizer
// ============================================

require("dotenv").config();
// ---- Postgres (Render) ----
const { Pool } = require("pg");

const DATABASE_URL = process.env.DATABASE_URL || "";
const USE_DB = !!DATABASE_URL;

const pool = USE_DB
  ? new Pool({
      connectionString: DATABASE_URL,
      ssl: { rejectUnauthorized: false },
    })
  : null;

async function initDb() {
  if (!pool) return;
  await pool.query(`
    CREATE TABLE IF NOT EXISTS win100_picks (
      id BIGSERIAL PRIMARY KEY,
      ts TIMESTAMPTZ,
      fixture_id BIGINT,
      league TEXT,
      home TEXT,
      away TEXT,
      score_at_scan TEXT,
      strategy TEXT,
      bet_type TEXT,
      bet_side TEXT,
      minute_at_scan INT,
      confidence_score NUMERIC,
      confidence_label TEXT,
      result TEXT,
      ai TEXT,
      raw JSONB NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_win100_picks_ts ON win100_picks (ts DESC);`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_win100_picks_fixture ON win100_picks (fixture_id);`);
}

const express = require("express");
const axios = require("axios");
const fs = require("fs");
const path = require("path");

const app = express();

const PORT = process.env.PORT || 3000;
const OPENAI_KEY = process.env.OPENAI_API_KEY;
const FOOTBALL_KEY = process.env.API_FOOTBALL_KEY;

// ปรับตาม bookmaker ที่คุณใช้ (ถ้าไม่ระบุ จะใช้ตัวแรกจาก API)
const DEFAULT_BOOKMAKER_ID = process.env.API_BOOKMAKER_ID || null;

app.use(express.json());
app.use(express.text({ type: ["text/plain","application/x-ndjson"], limit: "10mb" }));
app.use(express.static("public"));

// ---------------------------
// Log & strategies paths
// ---------------------------
const LOG_DIR = path.join(__dirname, "logs");
const LOG_FILE = path.join(LOG_DIR, "picks.log");
const STRATEGIES_FILE = path.join(__dirname, "strategies_current.json");

// ---------------------------
// API-Football base config (ใส่ timeout)
// ---------------------------
const api = axios.create({
  baseURL: "https://v3.football.api-sports.io/",
  headers: {
    "x-apisports-key": FOOTBALL_KEY,
  },
  timeout: 15000, // 15s ป้องกันค้าง
});

// ---------------------------
// Helper: เวลาไทย (ใช้ timezone ตามเครื่อง)
// ---------------------------
function getLocalTimestamp() {
  // ใช้เวลา local ของเครื่อง (ถ้า server ตั้งเป็น Asia/Bangkok ก็จะเป็นเวลาไทย)
  const d = new Date();
  const year = d.getFullYear();
  const month = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  const hh = String(d.getHours()).padStart(2, "0");
  const mm = String(d.getMinutes()).padStart(2, "0");
  const ss = String(d.getSeconds()).padStart(2, "0");
  // เก็บเป็นรูปแบบ YYYY-MM-DDTHH:mm:ss  (ไม่มี Z = ไม่ใช่ UTC)
  return `${year}-${month}-${day}T${hh}:${mm}:${ss}`;
}

// ---------------------------
// Helper: load/save strategies (threshold config)
// ---------------------------
const defaultStrategies = require("./strategies_current.json");

let STRATEGIES = loadStrategies();

function loadStrategies() {
  try {
    if (fs.existsSync(STRATEGIES_FILE)) {
      const txt = fs.readFileSync(STRATEGIES_FILE, "utf8");
      const obj = JSON.parse(txt);
      console.log("[STRATEGIES] loaded from file");
      return obj;
    }
  } catch (e) {
    console.error("Error loading strategies_current.json", e.message);
  }
  console.log("[STRATEGIES] use default from require()");
  return defaultStrategies;
}

function saveStrategies(newStrategies) {
  STRATEGIES = newStrategies;
  fs.writeFileSync(
    STRATEGIES_FILE,
    JSON.stringify(newStrategies, null, 2),
    "utf8"
  );
  console.log("[STRATEGIES] saved & reloaded");
}

// ---------------------------
// Helper: ดึงราคา Odds
// ---------------------------
async function fetchOdds(fixtureId) {
  try {
    const params = { fixture: fixtureId };
    if (DEFAULT_BOOKMAKER_ID) params.bookmaker = DEFAULT_BOOKMAKER_ID;

    const r = await api.get("/odds", { params });
    const resp = r.data.response || [];
    if (!resp.length) return null;

    const bookmaker = resp[0].bookmakers?.[0];
    if (!bookmaker) return null;

    const bets = bookmaker.bets || [];
    const bet1x2 =
      bets.find((b) => /1x2|Match Winner/i.test(b.name)) || bets[0];

    if (!bet1x2 || !Array.isArray(bet1x2.values)) return null;

    let homeOdd = null;
    let drawOdd = null;
    let awayOdd = null;

    for (const v of bet1x2.values) {
      if (v.value === "Home" || v.value === "1") homeOdd = parseFloat(v.odd);
      if (v.value === "Draw" || v.value === "X") drawOdd = parseFloat(v.odd);
      if (v.value === "Away" || v.value === "2") awayOdd = parseFloat(v.odd);
    }

    return { homeOdd, drawOdd, awayOdd, bookmaker: bookmaker.name };
  } catch (err) {
    console.error("fetchOdds error:", fixtureId, err.message);
    return null;
  }
}

// ---------------------------
// Helper: ดึงสถิติ live จาก /fixtures/statistics
// ---------------------------
async function fetchFixtureStatsForFixture(fixtureObj) {
  try {
    const fixtureId = fixtureObj.fixture.id;
    const homeId = fixtureObj.teams.home.id;
    const awayId = fixtureObj.teams.away.id;

    const r = await api.get("/fixtures/statistics", {
      params: { fixture: fixtureId },
    });

    const arr = r.data.response || [];
    let homeStats = [];
    let awayStats = [];

    for (const item of arr) {
      const teamId = item.team?.id;
      const statsArr = Array.isArray(item.statistics) ? item.statistics : [];
      if (teamId === homeId) homeStats = statsArr;
      else if (teamId === awayId) awayStats = statsArr;
    }

    return { homeStats, awayStats };
  } catch (err) {
    console.error(
      "fetchFixtureStatsForFixture error:",
      fixtureObj.fixture.id,
      err.message
    );
    return { homeStats: [], awayStats: [] };
  }
}

/* ======================================================
 * evaluateStrategies – ใช้สถิติจริงถ้ามี / ถ้าไม่มีใช้ fallback
 * ==================================================== */
function evaluateStrategies(f, odds, extraStats = {}) {
  const picks = [];

  const fixtureId = f.fixture.id;
  const minute = f.fixture.status.elapsed ?? 0;
  const league = `${f.league.country} - ${f.league.name}`;

  const home = f.teams.home.name;
  const away = f.teams.away.name;

  const gh = f.goals.home ?? 0;
  const ga = f.goals.away ?? 0;
  const score = `${gh} - ${ga}`;
  const tg = gh + ga;

  // ---------- สถิติจาก /fixtures/statistics ----------
  const homeStats = Array.isArray(extraStats.homeStats)
    ? extraStats.homeStats
    : [];
  const awayStats = Array.isArray(extraStats.awayStats)
    ? extraStats.awayStats
    : [];

  function getStat(statsArr, types) {
    const arr = Array.isArray(statsArr) ? statsArr : [];
    for (const t of types) {
      const row = arr.find((s) => s.type === t);
      if (!row || row.value == null) continue;
      let v = row.value;
      if (typeof v === "string") {
        v = v.replace("%", "").trim();
        const num = parseFloat(v);
        if (!isNaN(num)) return num;
      }
      if (typeof v === "number") return v;
    }
    return 0;
  }

  const sogH = getStat(homeStats, ["Shots on Goal", "Shots on target"]);
  const sogA = getStat(awayStats, ["Shots on Goal", "Shots on target"]);

  const attH = getStat(homeStats, ["Attacks"]);
  const attA = getStat(awayStats, ["Attacks"]);

  const possH = getStat(homeStats, ["Ball Possession", "Ball Possession %"]);
  const possA = getStat(awayStats, ["Ball Possession", "Ball Possession %"]);

  const cornersH = getStat(homeStats, ["Corner Kicks", "Corners"]);
  const cornersA = getStat(awayStats, ["Corner Kicks", "Corners"]);

  const xG_H = getStat(homeStats, ["Expected Goals", "xG"]);
  const xG_A = getStat(awayStats, ["Expected Goals", "xG"]);

  const sogTotal = sogH + sogA;
  const xGTotal = xG_H + xG_A;
  const cornersTotal = cornersH + cornersA;

  const hasStats =
    sogTotal > 0 ||
    xGTotal > 0 ||
    attH + attA > 0 ||
    possH + possA > 0 ||
    cornersTotal > 0;

  // ---------- ทีมต่อ/ทีมรองจากราคา ----------
  const favByOdds =
    odds && odds.homeOdd && odds.awayOdd
      ? odds.homeOdd < odds.awayOdd
        ? "home"
        : "away"
      : null;

  function push(strategy, betSide, extra = {}) {
    picks.push({
      fixtureId,
      strategy,
      strategyVersion: "v2",
      betSide,
      league,
      home,
      away,
      goalsHome: gh,
      goalsAway: ga,
      minuteAtScan: minute,
      scoreAtScan: score,
      ts: getLocalTimestamp(), // ✅ ใช้เวลาไทย/local
      result: "PENDING",
      odds: odds || null,
      ...extra,
    });
  }

  // ============================================
  // 1) Attack Pressure
  // ============================================
  const cfgAttack = STRATEGIES.attack_pressure?.params || {};
  if (STRATEGIES.attack_pressure?.enabled !== false) {
    const mMin = cfgAttack.minuteMin ?? 20;
    const mMax = cfgAttack.minuteMax ?? 85;
    const sogDiffMin = cfgAttack.sogDiffMin ?? 3;
    const possDiffMin = cfgAttack.possDiffMin ?? 5;
    const xgDiffMin = cfgAttack.xgDiffMin ?? 0.3;

    if (minute >= mMin && minute <= mMax) {
      if (hasStats) {
        const sogDiff = sogH - sogA;
        const possDiff = possH - possA;
        const xgDiff = xG_H - xG_A;

        if (
          sogDiff >= sogDiffMin &&
          possDiff >= possDiffMin &&
          xgDiff >= xgDiffMin
        ) {
          push("attack_pressure", "home");
        }
        if (
          -sogDiff >= sogDiffMin &&
          -possDiff >= possDiffMin &&
          -xgDiff >= xgDiffMin
        ) {
          push("attack_pressure", "away");
        }
      } else if (favByOdds) {
        if (favByOdds === "home" && gh <= ga && minute >= 30 && gh - ga >= -2) {
          push("attack_pressure", "home", { note: "fallback_no_stats" });
        }
        if (favByOdds === "away" && ga <= gh && minute >= 30 && ga - gh >= -2) {
          push("attack_pressure", "away", { note: "fallback_no_stats" });
        }
      }
    }
  }

  // ============================================
  // 2) One-Side Attack
  // ============================================
  const cfgOne = STRATEGIES.one_side_attack?.params || {};
  if (STRATEGIES.one_side_attack?.enabled !== false) {
    const mMin = cfgOne.minuteMin ?? 15;
    const mMax = cfgOne.minuteMax ?? 80;
    const attDiffMin = cfgOne.attDiffMin ?? 20;
    const sogDiffMin = cfgOne.sogDiffMin ?? 2;

    if (minute >= mMin && minute <= mMax && hasStats) {
      if (attH >= attA + attDiffMin && sogH >= sogA + sogDiffMin) {
        push("one_side_attack", "home");
      }
      if (attA >= attH + attDiffMin && sogA >= sogH + sogDiffMin) {
        push("one_side_attack", "away");
      }
    }
  }

  // ============================================
  // 3) Anti Price
  // ============================================
  const cfgAntiPrice = STRATEGIES.anti_price?.params || {};
  if (STRATEGIES.anti_price?.enabled !== false && favByOdds) {
    const mMin = cfgAntiPrice.minuteMin ?? 30;
    const mMax = cfgAntiPrice.minuteMax ?? 80;
    const mDrawExtra = cfgAntiPrice.minuteDrawExtra ?? 55;
    const sogDiffMin = cfgAntiPrice.sogDiffMin ?? 2;
    const possDiffMin = cfgAntiPrice.possDiffMin ?? 4;
    const xgDiffMin = cfgAntiPrice.xgDiffMin ?? 0.3;
    const xgTotalMin = cfgAntiPrice.xgTotalMin ?? 0.8;

    if (minute >= mMin && minute <= mMax) {
      if (hasStats && xGTotal >= xgTotalMin) {
        const homeBehindOrDraw =
          favByOdds === "home" &&
          (gh < ga || (gh === ga && minute >= mDrawExtra));
        const awayBehindOrDraw =
          favByOdds === "away" &&
          (ga < gh || (ga === gh && minute >= mDrawExtra));

        if (homeBehindOrDraw) {
          const sogDiff = sogH - sogA;
          const possDiff = possH - possA;
          const xgDiff = xG_H - xG_A;
          if (
            sogDiff >= sogDiffMin &&
            possDiff >= possDiffMin &&
            xgDiff >= xgDiffMin
          ) {
            push("anti_price", "home");
          }
        }

        if (awayBehindOrDraw) {
          const sogDiff = sogA - sogH;
          const possDiff = possA - possH;
          const xgDiff = xG_A - xG_H;
          if (
            sogDiff >= sogDiffMin &&
            possDiff >= possDiffMin &&
            xgDiff >= xgDiffMin
          ) {
            push("anti_price", "away");
          }
        }
      } else {
        if (favByOdds === "home" && gh <= ga && minute >= 50 && gh - ga >= -2) {
          push("anti_price", "home", { note: "fallback_no_stats" });
        }
        if (favByOdds === "away" && ga <= gh && minute >= 50 && ga - gh >= -2) {
          push("anti_price", "away", { note: "fallback_no_stats" });
        }
      }
    }
  }

  // ============================================
  // 4) Over75
  // ============================================
  const cfgOver75 = STRATEGIES.over75?.params || {};
  if (STRATEGIES.over75?.enabled !== false) {
    const mMin = cfgOver75.minuteMin ?? 72;
    const mMax = cfgOver75.minuteMax ?? 88;
    const totalGoalsMax = cfgOver75.totalGoalsMax ?? 2;
    const sogTotalMin = cfgOver75.sogTotalMin ?? 8;
    const xgTotalMin = cfgOver75.xgTotalMin ?? 1.6;

    if (minute >= mMin && minute <= mMax) {
      if (tg <= totalGoalsMax) {
        if (hasStats) {
          if (sogTotal >= sogTotalMin && xGTotal >= xgTotalMin) {
            push("over75", "over");
          }
        } else {
          push("over75", "over", { note: "fallback_no_stats" });
        }
      }
    }
  }

  // ============================================
  // 5) Smart Underdog
  // ============================================
  const cfgUnderdog = STRATEGIES.smart_underdog?.params || {};
  if (STRATEGIES.smart_underdog?.enabled !== false && hasStats) {
    const mMin = cfgUnderdog.minuteMin ?? 35;
    const mMax = cfgUnderdog.minuteMax ?? 80;
    const dogOddDiffMin = cfgUnderdog.dogOddDiffMin ?? 0.5;
    const sogMin = cfgUnderdog.sogMin ?? 2;
    const possMin = cfgUnderdog.possMin ?? 40;
    const xgMin = cfgUnderdog.xgMin ?? 0.4;

    if (minute >= mMin && minute <= mMax) {
      if (gh < ga) {
        const isHomeDog =
          favByOdds === "away" ||
          (odds && odds.homeOdd && odds.awayOdd
            ? odds.homeOdd > odds.awayOdd + dogOddDiffMin
            : false);

        if (
          isHomeDog &&
          sogH >= Math.max(sogMin, sogA - 1) &&
          possH >= possMin &&
          xG_H >= xgMin
        ) {
          push("smart_underdog", "home");
        }
      }

      if (ga < gh) {
        const isAwayDog =
          favByOdds === "home" ||
          (odds && odds.homeOdd && odds.awayOdd
            ? odds.awayOdd > odds.homeOdd + dogOddDiffMin
            : false);

        if (
          isAwayDog &&
          sogA >= Math.max(sogMin, sogH - 1) &&
          possA >= possMin &&
          xG_A >= xgMin
        ) {
          push("smart_underdog", "away");
        }
      }
    }
  }

  // ============================================
  // 6) AH +1.5
  // ============================================
  const cfgAH = STRATEGIES.ah_1_5?.params || {};
  if (STRATEGIES.ah_1_5?.enabled !== false) {
    const mMin = cfgAH.minuteMin ?? 50;
    const mMax = cfgAH.minuteMax ?? 82;
    const sogTotalMin = cfgAH.sogTotalMin ?? 8;
    const xgTotalMin = cfgAH.xgTotalMin ?? 1.4;
    const goalDiffMax = cfgAH.goalDiffMax ?? 1;

    if (minute >= mMin && minute <= mMax && Math.abs(gh - ga) <= goalDiffMax) {
      if (hasStats) {
        if (sogTotal >= sogTotalMin && xGTotal >= xgTotalMin) {
          const side = gh < ga ? "home +1.5" : "away +1.5";
          push("ah_1_5", side);
        }
      } else {
        const side = gh < ga ? "home +1.5" : "away +1.5";
        push("ah_1_5", side, { note: "fallback_no_stats" });
      }
    }
  }

  // ============================================
  // 7) Corner Storm
  // ============================================
  const cfgCorner = STRATEGIES.corner_storm?.params || {};
  if (STRATEGIES.corner_storm?.enabled !== false && hasStats) {
    const mMin = cfgCorner.minuteMin ?? 55;
    const cornersTotalMin = cfgCorner.cornersTotalMin ?? 7;
    const cornersDiffMin = cfgCorner.cornersDiffMin ?? 2;
    const sogDiffMin = cfgCorner.sogDiffMin ?? 1;

    if (minute >= mMin && cornersTotal >= cornersTotalMin) {
      if (cornersH >= cornersA + cornersDiffMin && sogH >= sogA + sogDiffMin) {
        push("corner_storm", "home_corner");
      }
      if (cornersA >= cornersH + cornersDiffMin && sogA >= sogH + sogDiffMin) {
        push("corner_storm", "away_corner");
      }
    }
  }

  // ============================================
  // 8) PP Index
  // ============================================
  const cfgPP = STRATEGIES.pp_index?.params || {};
  if (STRATEGIES.pp_index?.enabled !== false && hasStats) {
    const mMin = cfgPP.minuteMin ?? 25;
    const mMax = cfgPP.minuteMax ?? 80;
    const possMin = cfgPP.possMin ?? 60;
    const sogDiffMin = cfgPP.sogDiffMin ?? 1;
    const xgDiffMin = cfgPP.xgDiffMin ?? 0.25;

    if (minute >= mMin && minute <= mMax) {
      if (
        possH >= possMin &&
        sogH >= sogA + sogDiffMin &&
        xG_H >= xG_A + xgDiffMin
      ) {
        push("pp_index", "home");
      }
      if (
        possA >= possMin &&
        sogA >= sogH + sogDiffMin &&
        xG_A >= xG_H + xgDiffMin
      ) {
        push("pp_index", "away");
      }
    }
  }

  // ============================================
  // 9) Favorite Comeback
  // ============================================
  const cfgFav = STRATEGIES.favorite_comeback?.params || {};
  if (STRATEGIES.favorite_comeback?.enabled !== false && favByOdds && hasStats) {
    const mMin = cfgFav.minuteMin ?? 30;
    const mMax = cfgFav.minuteMax ?? 80;
    const sogDiffMin = cfgFav.sogDiffMin ?? 1;
    const possMin = cfgFav.possMin ?? 52;
    const xgDiffMin = cfgFav.xgDiffMin ?? 0.3;
    const sogMin = cfgFav.sogMin ?? 3;

    if (minute >= mMin && minute <= mMax) {
      if (favByOdds === "home" && gh < ga) {
        if (
          sogH >= sogA + sogDiffMin &&
          possH >= possMin &&
          xG_H >= xG_A + xgDiffMin &&
          sogH >= sogMin
        ) {
          push("favorite_comeback", "home");
        }
      }
      if (favByOdds === "away" && ga < gh) {
        if (
          sogA >= sogH + sogDiffMin &&
          possA >= possMin &&
          xG_A >= xG_H + xgDiffMin &&
          sogA >= sogMin
        ) {
          push("favorite_comeback", "away");
        }
      }
    }
  }

  // ============================================
  // 10) Goal 85
  // ============================================
  const cfgG85 = STRATEGIES.goal_85?.params || {};
  if (STRATEGIES.goal_85?.enabled !== false) {
    const mMin = cfgG85.minuteMin ?? 82;
    const mMax = cfgG85.minuteMax ?? 93;
    const totalGoalsMax = cfgG85.totalGoalsMax ?? 4;
    const sogTotalMin = cfgG85.sogTotalMin ?? 9;
    const xgTotalMin = cfgG85.xgTotalMin ?? 1.8;

    if (minute >= mMin && minute <= mMax && tg <= totalGoalsMax) {
      if (hasStats) {
        if (sogTotal >= sogTotalMin && xGTotal >= xgTotalMin) {
          push("goal_85", "next_goal");
        }
      } else {
        push("goal_85", "next_goal", { note: "fallback_no_stats" });
      }
    }
  }

  // ============================================
  // 11) Anti Book
  // ============================================
  const cfgAntiBook = STRATEGIES.anti_book?.params || {};
  if (STRATEGIES.anti_book?.enabled !== false && favByOdds && hasStats) {
    const mMin = cfgAntiBook.minuteMin ?? 40;
    const mMax = cfgAntiBook.minuteMax ?? 80;
    const sogMin = cfgAntiBook.sogMin ?? 3;
    const sogDiffMin = cfgAntiBook.sogDiffMin ?? 2;
    const possMin = cfgAntiBook.possMin ?? 55;
    const xgMin = cfgAntiBook.xgMin ?? 0.8;

    if (minute >= mMin && minute <= mMax) {
      if (favByOdds === "home" && gh === 0) {
        if (
          sogH >= sogMin &&
          sogH >= sogA + sogDiffMin &&
          possH >= possMin &&
          xG_H >= xgMin
        ) {
          push("anti_book", "home");
        }
      }
      if (favByOdds === "away" && ga === 0) {
        if (
          sogA >= sogMin &&
          sogA >= sogH + sogDiffMin &&
          possA >= possMin &&
          xG_A >= xgMin
        ) {
          push("anti_book", "away");
        }
      }
    }
  }

  // ============================================
  // 12) Over Momentum
  // ============================================
  const cfgOM = STRATEGIES.over_momentum?.params || {};
  if (STRATEGIES.over_momentum?.enabled !== false) {
    const mMin = cfgOM.minuteMin ?? 50;
    const sogTotalMin = cfgOM.sogTotalMin ?? 9;
    const xgTotalMin = cfgOM.xgTotalMin ?? 1.8;

    if (minute >= mMin) {
      if (hasStats) {
        if (sogTotal >= sogTotalMin && xGTotal >= xgTotalMin) {
          push("over_momentum", "over");
        }
      } else if (tg <= 2 && minute >= 60) {
        push("over_momentum", "over", { note: "fallback_no_stats" });
      }
    }
  }

  // ============================================
  // 13) Live xG
  // ============================================
  const cfgLXG = STRATEGIES.live_xg?.params || {};
  if (STRATEGIES.live_xg?.enabled !== false) {
    const mMin = cfgLXG.minuteMin ?? 35;
    const mMax = cfgLXG.minuteMax ?? 82;
    const xgTotalMin = cfgLXG.xgTotalMin ?? 2.0;
    const totalGoalsMax = cfgLXG.totalGoalsMax ?? 2;

    if (minute >= mMin && minute <= mMax) {
      if (hasStats && xGTotal >= xgTotalMin && tg <= totalGoalsMax) {
        push("live_xg", "goal_soon");
      } else if (!hasStats && tg <= 1 && minute >= 40) {
        push("live_xg", "goal_soon", { note: "fallback_no_stats" });
      }
    }
  }

  return picks;
}

/* ======================================================
 * gradeResult – ตัดสิน WIN/LOSE หลังจบเกม
 * ==================================================== */
function gradeResult(pick, fh, fa) {
  const diff = fh - fa;

  switch (pick.strategy) {
    case "attack_pressure":
    case "one_side_attack":
    case "favorite_comeback":
    case "pp_index":
    case "anti_book":
      return diff > 0 ? "WIN" : "LOSE";

    case "smart_underdog":
      return (pick.betSide.includes("home") ? fh : fa) >=
        (pick.betSide.includes("home") ? fa : fh)
        ? "WIN"
        : "LOSE";

    case "over75":
    case "over_momentum":
    case "live_xg":
      return fh + fa >= 2 ? "WIN" : "LOSE";

    case "goal_85":
    case "corner_storm":
      return "PENDING";

    case "ah_1_5":
      return "WIN";

    case "anti_price":
      return diff > 0 ? "WIN" : "LOSE";

    default:
      return "PENDING";
  }
}

/* ======================================================
 * askAI – วิเคราะห์เพิ่มเติม
 * ==================================================== */
async function askAI(pick) {
  try {
    const { odds } = pick;
    const oddsText =
      odds && odds.homeOdd && odds.awayOdd
        ? `ราคาเปิดประมาณ: เจ้าบ้าน ${odds.homeOdd}, ทีมเยือน ${odds.awayOdd}`
        : "ไม่มีข้อมูลราคาแบบละเอียดจาก API";

    const prompt = `
คุณเป็นนักวิเคราะห์ฟุตบอลสด ตอบเป็นภาษาไทยแบบย่อ 3-5 บรรทัด

ข้อมูลแมตช์:
- ลีก: ${pick.league}
- คู่: ${pick.home} vs ${pick.away}
- สกอร์ปัจจุบัน: ${pick.scoreAtScan}
- นาที: ${pick.minuteAtScan}
- สูตรที่เข้า: ${pick.strategy}
- ฝั่งที่ระบบมองว่าได้เปรียบ: ${pick.betSide}
- ข้อมูลราคา (ถ้ามี): ${oddsText}

ให้ตอบ:
1) รูปเกมตอนนี้เป็นอย่างไร ใครกดดันมากกว่า
2) โอกาสเกิดประตูถัดไปประมาณกี่เปอร์เซ็นต์ และโน้มเอียงไปทางไหน
3) ฝั่ง ${pick.betSide} ดูมีภาษีดีกว่าจริงไหม จากข้อมูลที่มี
4) เตือนว่าการวิเคราะห์นี้ไม่ใช่การการันตีผล และไม่ใช่คำแนะนำการลงทุน
`;

    const r = await axios.post(
      "https://api.openai.com/v1/chat/completions",
      {
        model: "gpt-4.1-mini",
        messages: [{ role: "user", content: prompt }],
        temperature: 0.3,
      },
      {
        headers: {
          Authorization: `Bearer ${OPENAI_KEY}`,
        },
        timeout: 30000,
      }
    );

    return r.data.choices?.[0]?.message?.content?.trim() || "";
  } catch (err) {
    console.error("askAI error:", err.message);
    return "";
  }
}

/* ======================================================
 * LOG SYSTEM
 * ==================================================== */
function ensureLogDir() {
  if (!fs.existsSync(LOG_DIR)) fs.mkdirSync(LOG_DIR);
}

function logPick(pick) {
  // Always normalize to a plain object
  const obj = pick && typeof pick === "object" ? pick : { value: pick };

  // Store to Postgres when available (Render)
  if (pool) {
    // Fire-and-forget, but log error if any
    pool
      .query(
        `
        INSERT INTO win100_picks
          (ts, fixture_id, league, home, away, score_at_scan, strategy, bet_type, bet_side,
           minute_at_scan, confidence_score, confidence_label, result, ai, raw)
        VALUES
          ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)
        `,
        [
          obj.ts ? new Date(obj.ts) : null,
          obj.fixtureId ?? obj.fixture_id ?? null,
          obj.league ?? null,
          obj.home ?? null,
          obj.away ?? null,
          obj.scoreAtScan ?? obj.score_at_scan ?? null,
          obj.strategy ?? null,
          obj.betType ?? obj.bet_type ?? null,
          obj.betSide ?? obj.bet_side ?? null,
          Number.isFinite(obj.minuteAtScan) ? obj.minuteAtScan : (obj.minute_at_scan ?? null),
          obj.confidenceScore ?? obj.confidence_score ?? null,
          obj.confidenceLabel ?? obj.confidence_label ?? null,
          obj.result ?? null,
          obj.ai ?? null,
          obj,
        ]
      )
      .catch((e) => console.error("DB insert error:", e.message));
    return;
  }

  // Fallback: local file log (for dev/local)
  try {
    fs.mkdirSync(path.dirname(LOG_FILE), { recursive: true });
  } catch (_) {}
  fs.appendFile(LOG_FILE, JSON.stringify(obj) + "\n", (err) => {
    if (err) console.error("Log write error:", err);
  });
}

/* ======================================================
 * Helper: โหลด log ทั้งหมด / week key
 * ==================================================== */
async function loadAllPicksFromLog(limit = 5000) {
  // Prefer DB on Render
  if (pool) {
    const { rows } = await pool.query(
      `SELECT raw FROM win100_picks ORDER BY COALESCE(ts, created_at) DESC LIMIT $1`,
      [limit]
    );
    return rows.map((r) => r.raw);
  }

  // Local file fallback
  try {
    if (!fs.existsSync(LOG_FILE)) return [];
    const text = fs.readFileSync(LOG_FILE, "utf-8");
    return text
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter(Boolean)
      .map((l) => JSON.parse(l))
      .filter(Boolean);
  } catch (e) {
    console.error("loadAllPicksFromLog error:", e.message);
    return [];
  }
}

function getWeekKeyFromTimestamp(ts) {
  try {
    const d = new Date(ts); // ts ที่เก็บเป็น local string -> JS มองเป็น local time
    if (isNaN(d.getTime())) return "unknown week";

    const day = d.getDay(); // 0=Sun..6
    const diff = d.getDate() - day + (day === 0 ? -6 : 1); // ไปวันจันทร์
    const monday = new Date(d);
    monday.setDate(diff);

    const y = monday.getFullYear();
    const m = String(monday.getMonth() + 1).padStart(2, "0");
    const dd = String(monday.getDate()).padStart(2, "0");
    return `${y}-W${y}-${m}-${dd}`;
  } catch (e) {
    return "unknown week";
  }
}

/* ======================================================
 * computeStatsFromLog – ภาพรวมทั้งหมด
 * ==================================================== */
async function computeStatsFromLog() {
  const picks = await loadAllPicksFromLog();
if (!picks.length) {
    return {
      totalPicks: 0,
      gradedPicks: 0,
      byStrategy: {},
      byLeague: {},
      byDate: {},
      timelineByDate: {},
      timelineByWeek: {},
    };
  }

  const fixtureIds = [...new Set(picks.map((p) => p.fixtureId))];
  const results = {};

  for (const id of fixtureIds) {
    try {
      const r = await api.get("/fixtures", { params: { id } });
      const fx = r.data.response?.[0];
      if (!fx) {
        results[id] = { final: false };
        continue;
      }
      const status = fx.fixture.status?.short;
      if (status !== "FT") {
        results[id] = { final: false };
        continue;
      }
      results[id] = {
        final: true,
        fh: fx.goals.home ?? 0,
        fa: fx.goals.away ?? 0,
      };
    } catch (err) {
      results[id] = { final: false };
    }
  }

  const byStrategy = {};
  const byLeague = {};
  const byDate = {};
  const timelineByDate = {};
  const timelineByWeek = {};
  let gradedPicks = 0;

  function add(map, key, result) {
    if (!map[key]) map[key] = { total: 0, win: 0, lose: 0 };
    map[key].total += 1;
    if (result === "WIN") map[key].win += 1;
    if (result === "LOSE") map[key].lose += 1;
  }

  function addNestedTimeline(map, outerKey, strategy, result) {
    if (!map[outerKey]) map[outerKey] = {};
    if (!map[outerKey][strategy]) {
      map[outerKey][strategy] = { total: 0, win: 0, lose: 0 };
    }
    const obj = map[outerKey][strategy];
    obj.total += 1;
    if (result === "WIN") obj.win += 1;
    if (result === "LOSE") obj.lose += 1;
  }

  for (const p of picks) {
    const fr = results[p.fixtureId];
    if (!fr || !fr.final) continue;

    const result = gradeResult(p, fr.fh, fr.fa);
    if (result === "PENDING") continue;

    gradedPicks += 1;

    const dateKey = (p.ts || "").substring(0, 10) || "unknown date"; // ✅ ใช้วันที่ local
    const weekKey = getWeekKeyFromTimestamp(p.ts || "");

    add(byStrategy, p.strategy, result);
    add(byLeague, p.league || "unknown league", result);
    add(byDate, dateKey, result);
    addNestedTimeline(timelineByDate, dateKey, p.strategy, result);
    addNestedTimeline(timelineByWeek, weekKey, p.strategy, result);
  }

  return {
    totalPicks: picks.length,
    gradedPicks,
    byStrategy,
    byLeague,
    byDate,
    timelineByDate,
    timelineByWeek,
  };
}

/* ======================================================
 * getPicksAndStatsByDate – สรุปรายวัน + รายการคู่
 * ==================================================== */
async function getPicksAndStatsByDate(dateStr) {
  const all = loadAllPicksFromLog();
  const picks = all.filter(
    (p) => (p.ts || "").substring(0, 10) === dateStr
  ); // ✅ เทียบจากวันที่ local

  if (!picks.length) {
    return {
      picks: [],
      summary: { total: 0, win: 0, lose: 0, pending: 0 },
      byStrategy: {},
    };
  }

  const fixtureIds = [...new Set(picks.map((p) => p.fixtureId))];
  const results = {};

  for (const id of fixtureIds) {
    try {
      const r = await api.get("/fixtures", { params: { id } });
      const fx = r.data.response?.[0];
      if (!fx) {
        results[id] = { final: false };
        continue;
      }
      const status = fx.fixture.status?.short;
      if (status !== "FT") {
        results[id] = { final: false };
        continue;
      }
      results[id] = {
        final: true,
        fh: fx.goals.home ?? 0,
        fa: fx.goals.away ?? 0,
      };
    } catch (err) {
      results[id] = { final: false };
    }
  }

  const summary = { total: picks.length, win: 0, lose: 0, pending: 0 };
  const byStrategy = {};
  const enriched = [];

  for (const p of picks) {
    const fr = results[p.fixtureId];
    let result = "PENDING";

    if (fr && fr.final) {
      let r = gradeResult(p, fr.fh, fr.fa);
      if (r === "WIN" || r === "LOSE") result = r;
      else result = "PENDING";
    }

    if (!byStrategy[p.strategy]) {
      byStrategy[p.strategy] = { total: 0, win: 0, lose: 0, pending: 0 };
    }
    const s = byStrategy[p.strategy];
    s.total += 1;
    if (result === "WIN") {
      s.win += 1;
      summary.win += 1;
    } else if (result === "LOSE") {
      s.lose += 1;
      summary.lose += 1;
    } else {
      s.pending += 1;
      summary.pending += 1;
    }

    enriched.push({
      ...p,
      result,
    });
  }

  return { picks: enriched, summary, byStrategy };
}

/* ======================================================
 * /api/scan – สแกนบอล live + เขียน log
 * ==================================================== */
app.get("/api/scan", async (req, res) => {
  console.log("---- /api/scan called ----");
  try {
    const fx = await api.get("/fixtures", { params: { live: "all" } });
    let fixtures = fx.data.response || [];
    console.log("live fixtures from API:", fixtures.length);

    const LIMIT = 60;
    if (fixtures.length > LIMIT) {
      fixtures = fixtures.slice(0, LIMIT);
      console.log(`limit fixtures to first ${LIMIT}`);
    }

    let allPicks = [];
    let idx = 0;

    for (const f of fixtures) {
      idx++;
      try {
        console.log(
          `scan fixture ${idx}/${fixtures.length} id=${f.fixture.id} ${f.teams.home.name} vs ${f.teams.away.name}`
        );
        const odds = await fetchOdds(f.fixture.id);
        const stats = await fetchFixtureStatsForFixture(f);
        const picks = evaluateStrategies(f, odds, stats);
        allPicks.push(...picks);
      } catch (e) {
        console.error("error in per-fixture scan:", f.fixture.id, e.message);
      }
    }

    console.log("total picks this scan:", allPicks.length);

    for (const p of allPicks) {
      p.ai = await askAI(p);
      logPick(p);
    }

    res.json({
      status: "success",
      totalFixtures: fixtures.length,
      totalPicks: allPicks.length,
      picks: allPicks,
    });
    console.log("---- /api/scan done ----");
  } catch (err) {
    console.error("/api/scan error:", err.message);
    res.json({ status: "error", message: err.message });
  }
});

/* ======================================================
 * /api/test-ai
 * ==================================================== */
app.get("/api/test-ai", async (req, res) => {
  const msg = await askAI({
    league: "Test League",
    home: "Team A",
    away: "Team B",
    scoreAtScan: "0-0",
    minuteAtScan: 60,
    strategy: "attack_pressure",
    betSide: "home",
    odds: {
      homeOdd: 1.8,
      awayOdd: 4.0,
    },
  });

  res.json({ status: "success", ai_result: msg });
});

/* ======================================================
 * /api/stats – overall หรือ รายวัน
 * ==================================================== */
app.get("/api/stats", async (req, res) => {
  try {
    const date = req.query.date;

    if (date) {
      const data = await getPicksAndStatsByDate(date);
      return res.json({
        status: "success",
        mode: "byDate",
        date,
        ...data,
      });
    }

    const stats = await computeStatsFromLog();
    res.json({
      status: "success",
      mode: "overall",
      ...stats,
    });
  } catch (err) {
    res.json({ status: "error", message: err.message });
  }
});

/* ======================================================
 * /api/ai-optimize – ให้ AI แนะนำ threshold ใหม่ (clean JSON)
 * ==================================================== */
app.post("/api/ai-optimize", async (req, res) => {
  try {
    const stats = await computeStatsFromLog();

    const payload = {
      strategies: STRATEGIES,
      performance: {
        totalPicks: stats.totalPicks,
        gradedPicks: stats.gradedPicks,
        byStrategy: stats.byStrategy,
        byDate: stats.byDate,
        byWeek: stats.timelineByWeek,
      },
    };

    const prompt = `
คุณเป็น data scientist และนักออกแบบสูตรวิเคราะห์บอล
ข้อมูลต่อไปนี้คือ:
- strategies: config สูตรปัจจุบัน (threshold ต่าง ๆ)
- performance: ผลการทำงานย้อนหลังของแต่ละสูตร

ให้คุณ:
1) ปรับ threshold ของแต่ละสูตร (ไม่ต้องเปลี่ยนโครงสร้าง params)
2) สามารถ disable สูตรที่ performance แย่มาก (enabled = false) ได้
3) ถ้ามีไอเดียสูตรใหม่ 1-2 สูตรให้ใส่เพิ่ม (เช่น pressure_flip_goal, xg_imbalance_surge)

ตอบกลับเป็น JSON เท่านั้น รูปแบบ:

{
  "strategies": {
    "<key>": {
      "label": "ชื่อสูตร",
      "enabled": true,
      "params": {
        "...": <ตัวเลข>
      }
    }
  },
  "notes": [
    "ข้อความอธิบายสั้น ๆ",
    "..."
  ]
}

ห้ามส่งคำอธิบายอื่นนอกจาก JSON นี้

นี่คือ data:
${JSON.stringify(payload, null, 2)}
`;

    const r = await axios.post(
      "https://api.openai.com/v1/chat/completions",
      {
        model: "gpt-4.1-mini",
        messages: [{ role: "user", content: prompt }],
        temperature: 0.3,
      },
      {
        headers: {
          Authorization: `Bearer ${OPENAI_KEY}`,
        },
        timeout: 60000,
      }
    );

    let text = r.data.choices?.[0]?.message?.content || "{}";
    console.log("[AI-OPTIMIZER] raw response from OpenAI:\n", text);

    let cleaned = text.trim();

    // ตัด ```json ... ``` ถ้ามี
    if (cleaned.startsWith("```")) {
      cleaned = cleaned.replace(/^```[a-zA-Z]*\s*/i, "");
      cleaned = cleaned.replace(/```$/, "").trim();
    }

    // ดึงเฉพาะก้อน { ... } แรก
    const firstBrace = cleaned.indexOf("{");
    const lastBrace = cleaned.lastIndexOf("}");
    if (firstBrace !== -1 && lastBrace !== -1 && lastBrace > firstBrace) {
      cleaned = cleaned.substring(firstBrace, lastBrace + 1);
    }

    let parsed;
    try {
      parsed = JSON.parse(cleaned);
    } catch (err) {
      console.error("[AI-OPTIMIZER] JSON parse error:", err.message);
      return res.json({
        status: "error",
        message: "ไม่สามารถ parse JSON ที่ AI ส่งกลับมาได้",
        raw: text,
        cleaned,
        error: err.message,
      });
    }

    res.json({
      status: "success",
      currentStrategies: STRATEGIES,
      suggestions: parsed,
    });
  } catch (err) {
    console.error("/api/ai-optimize error:", err.message);
    res.json({ status: "error", message: err.message });
  }
});

/* ======================================================
 * /api/apply-strategies – ให้ user กด Apply เอง
 * ==================================================== */
app.post("/api/apply-strategies", (req, res) => {
  try {
    const body = req.body || {};
    if (!body.strategies || typeof body.strategies !== "object") {
      return res.json({
        status: "error",
        message: "ต้องส่ง field 'strategies' แบบ JSON object",
      });
    }
    saveStrategies(body.strategies);
    res.json({ status: "success", strategies: STRATEGIES });
  } catch (err) {
    res.json({ status: "error", message: err.message });
  }
});

/* ====================================================== */
initDb()
  .catch((e) => console.error("DB init error:", e.message))
  .finally(() => {
    app.listen(PORT, () => {
  console.log(`Win100 Full Scanner running at: http://localhost:${PORT}`);
  console.log(`dashboard : http://localhost:${PORT}/dashboard`);
  console.log(`optimizer : http://localhost:${PORT}/ai_optimizer.html`);
    });
  });
