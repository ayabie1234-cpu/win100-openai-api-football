import fs from "fs";
import path from "path";
import dotenv from "dotenv";
import fetch from "node-fetch";

dotenv.config();

const API_KEY = process.env.API_FOOTBALL_KEY;
const API_BASE = "https://v3.football.api-sports.io";

const LOG_DIR = path.join(process.cwd(), "logs");
const PICK_LOG = path.join(LOG_DIR, "picks.log");

if (!API_KEY) {
  console.error("❌ ไม่มี API_FOOTBALL_KEY ใน .env");
  process.exit(1);
}

function parseScoreText(text) {
  let [h, a] = text.split(/-|:/).map(x => parseInt(x.trim(), 10));
  return {
    home: isNaN(h) ? 0 : h,
    away: isNaN(a) ? 0 : a,
  };
}

function settlePick(pick, finalScore) {
  const side = pick.betSide;
  const line = pick.ouLine || 2.5;  
  const total = finalScore.home + finalScore.away;

  if (side === "home") {
    if (finalScore.home > finalScore.away) return "WIN";
    return "LOSE";
  }

  if (side === "away") {
    if (finalScore.away > finalScore.home) return "WIN";
    return "LOSE";
  }

  if (side === "over") {
    return total > line ? "WIN" : "LOSE";
  }

  if (side === "under") {
    return total < line ? "WIN" : "LOSE";
  }

  return "INVALID";
}

async function fetchFinalScore(fixtureId) {
  const headers = { "x-apisports-key": API_KEY };
  try {
    const res = await fetch(`${API_BASE}/fixtures?id=${fixtureId}`, { headers });
    if (!res.ok) return null;
    const data = await res.json();
    const fix = data.response[0];

    if (!fix) return null;

    return {
      home: fix.goals.home ?? 0,
      away: fix.goals.away ?? 0,
      status: fix.fixture.status.short,
    };
  } catch {
    return null;
  }
}

async function updateLogs() {
  if (!fs.existsSync(PICK_LOG)) {
    console.log("❌ ไม่พบ logs/picks.log");
    return;
  }

  const lines = fs.readFileSync(PICK_LOG, "utf-8")
      .trim()
      .split("\n")
      .filter(Boolean);

  let newLines = [];
  let updated = 0;

  for (let line of lines) {
    let pick;
    try {
      pick = JSON.parse(line);
    } catch {
      continue;
    }

    // ข้ามคู่ที่เคยอัปเดตแล้ว
    if (pick.result !== "PENDING") {
      newLines.push(JSON.stringify(pick));
      continue;
    }

    console.log(`⏳ เช็คผล: ${pick.home} vs ${pick.away} (ID ${pick.fixtureId})`);

    const fsResult = await fetchFinalScore(pick.fixtureId);

    if (!fsResult) {
      console.log("⚠ ดึงผลไม่ได้ ข้ามชั่วคราว...");
      newLines.push(JSON.stringify(pick));
      continue;
    }

    if (fsResult.status !== "FT") {
      console.log("⌛ เกมยังไม่จบ:", fsResult.status);
      newLines.push(JSON.stringify(pick));
      continue;
    }

    const result = settlePick(pick, fsResult);

    pick.result = result;
    pick.finalScore = `${fsResult.home}-${fsResult.away}`;
    pick.settledAt = new Date().toISOString();

    updated++;
    newLines.push(JSON.stringify(pick));

    console.log(`🎉 อัปเดตผล → ${result}`);
  }

  fs.writeFileSync(PICK_LOG, newLines.join("\n") + "\n", "utf-8");

  console.log(`\n✅ อัปเดตผลเสร็จแล้ว จำนวนที่เปลี่ยนสถานะ: ${updated}`);
}

updateLogs();
