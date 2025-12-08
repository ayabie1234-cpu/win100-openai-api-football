// Auto Settle Script – เช็คผล Win/เสีย จาก API-Football
// ใช้ร่วมกับ logs/picks.log ที่ระบบสร้างเอาไว้
// -----------------------------------------------

import fs from "fs";
import path from "path";
import fetch from "node-fetch";
import dotenv from "dotenv";

dotenv.config();

const API_KEY = process.env.API_FOOTBALL_KEY;
if (!API_KEY) {
  console.error("❌ ERROR: ไม่พบ API_FOOTBALL_KEY ในไฟล์ .env");
  process.exit(1);
}

const API_BASE = "https://v3.football.api-sports.io";

// ---------------- PATH ---------------- //

const LOG_DIR = path.join(process.cwd(), "logs");
const PICK_LOG = path.join(LOG_DIR, "picks.log");
const SETTLED_LOG = path.join(LOG_DIR, "picks_settled.log");

// ---------------- Helpers ---------------- //

function parseGoals(scoreText) {
  const spl = String(scoreText).split(/-|:/);
  return {
    home: parseInt(spl[0] || "0", 10),
    away: parseInt(spl[1] || "0", 10),
  };
}

// เช็คผลแพ้ชนะทีม
function settleTeamBet(pickSide, finalScore) {
  if (pickSide === "home") {
    if (finalScore.home > finalScore.away) return "WIN";
    if (finalScore.home < finalScore.away) return "LOSE";
    return "LOSE"; // เสมอถือว่าแพ้
  }
  if (pickSide === "away") {
    if (finalScore.away > finalScore.home) return "WIN";
    if (finalScore.away < finalScore.home) return "LOSE";
    return "LOSE";
  }
  return "INVALID";
}

// เช็คผลสูง/ต่ำ
function settleOverUnder(pickSide, finalScore, line = 2.5) {
  const total = finalScore.home + finalScore.away;

  if (pickSide === "over") {
    if (total > line) return "WIN";
    return "LOSE";
  }

  if (pickSide === "under") {
    if (total < line) return "WIN";
    return "LOSE";
  }

  return "INVALID";
}

// ---------------- Fetch API ---------------- //

async function fetchFinalResult(fixtureId) {
  const headers = { "x-apisports-key": API_KEY };

  const url = `${API_BASE}/fixtures?id=${fixtureId}`;

  try {
    const res = await fetch(url, { headers });
    if (!res.ok) return null;

    const data = await res.json();
    const fixture = data.response?.[0];
    if (!fixture) return null;

    const home = fixture.goals.home ?? 0;
    const away = fixture.goals.away ?? 0;
    const status = fixture.fixture.status.short; // FT, NS, 1H, HT, 2H, etc.

    return {
      home,
      away,
      status,
    };
  } catch (e) {
    console.error("❌ API error:", e.message);
    return null;
  }
}

// ---------------- MAIN FUNCTION ---------------- //

async function runSettle() {
  console.log("🔍 เริ่มระบบ Auto Settle...");

  if (!fs.existsSync(PICK_LOG)) {
    console.log("❌ ไม่พบไฟล์ picks.log");
    return;
  }

  const lines = fs.readFileSync(PICK_LOG, "utf-8").trim().split("\n");
  const pending = [];

  for (const line of lines) {
    try {
      const rec = JSON.parse(line);
      if (rec.result === "PENDING") pending.push(rec);
    } catch {}
  }

  if (!pending.length) {
    console.log("✨ ไม่มีคู่ค้าง PENDING ให้เช็ค");
    return;
  }

  console.log(`⏳ พบคู่ที่ต้องเช็คผล: ${pending.length} รายการ`);

  let settledResults = [];

  for (const rec of pending) {
    console.log(`➡ เช็คผลคู่ ${rec.home} vs ${rec.away} (ID ${rec.fixtureId})`);

    const finalData = await fetchFinalResult(rec.fixtureId);

    if (!finalData) {
      console.log("  ⚠ ไม่สามารถดึงผลจริงได้ ข้าม...");
      continue;
    }

    if (finalData.status !== "FT") {
      console.log("  ⏳ ยังไม่จบเกม (status:", finalData.status, ")");
      continue;
    }

    const score = { home: finalData.home, away: finalData.away };

    let result = "INVALID";

    if (["home", "away"].includes(rec.betSide)) {
      result = settleTeamBet(rec.betSide, score);
    } else if (["over", "under"].includes(rec.betSide)) {
      result = settleOverUnder(rec.betSide, score);
    }

    const settled = {
      ...rec,
      finalScore: `${score.home}-${score.away}`,
      result,
      settledAt: new Date().toISOString(),
    };

    settledResults.push(settled);
  }

  if (settledResults.length === 0) {
    console.log("⭕ ไม่มีคู่จบเกมที่สามารถสรุปผลได้ในตอนนี้");
    return;
  }

  // บันทึกลงไฟล์ picks_settled.log
  const toSave = settledResults.map((r) => JSON.stringify(r)).join("\n") + "\n";
  fs.appendFileSync(SETTLED_LOG, toSave, "utf-8");

  console.log("✅ บันทึกผลลง picks_settled.log แล้ว");
  console.log(`🎉 สรุปผลทั้งสิ้น ${settledResults.length} รายการ`);
}

runSettle();
