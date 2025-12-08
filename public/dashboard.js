let winLoseChart = null;
let strategyChart = null;

async function loadStats(isAuto = false) {
  try {
    const res = await fetch("/api/stats");
    const data = await res.json();
    if (data.status !== "success") return;

    const { overall, strategies, topStrategies, today, recentSettled } = data;

    // การ์ดด้านบน
    document.getElementById("stat-total").textContent = overall.total;
    document.getElementById("stat-win").textContent = overall.win;
    document.getElementById("stat-lose").textContent = overall.lose;
    document.getElementById("stat-profit").textContent = overall.profitUnits;
    document.getElementById("stat-winrate").textContent =
      `WinRate: ${overall.winRate || 0}%`;

    // กราฟ WIN/LOSE
    const wlData = [overall.win, overall.lose];
    const wlCtx = document.getElementById("winLoseChart").getContext("2d");

    if (!winLoseChart) {
      winLoseChart = new Chart(wlCtx, {
        type: "pie",
        data: {
          labels: ["WIN", "LOSE"],
          datasets: [{
            data: wlData,
            backgroundColor: ["#22c55e", "#ef4444"]
          }]
        }
      });
    } else {
      winLoseChart.data.datasets[0].data = wlData;
      winLoseChart.update();
    }

    // กราฟตามสูตร
    const labels = strategies.map(s => s.strategy);
    const winData = strategies.map(s => s.win);
    const loseData = strategies.map(s => s.lose);

    const stratCtx = document.getElementById("strategyChart").getContext("2d");

    if (!strategyChart) {
      strategyChart = new Chart(stratCtx, {
        type: "bar",
        data: {
          labels,
          datasets: [
            {
              label: "WIN",
              data: winData,
              backgroundColor: "#22c55e"
            },
            {
              label: "LOSE",
              data: loseData,
              backgroundColor: "#ef4444"
            }
          ]
        },
        options: {
          responsive: true,
          plugins: {
            legend: { position: "top" }
          },
          scales: {
            x: { ticks: { color: "#e5e7eb" } },
            y: { ticks: { color: "#e5e7eb" } }
          }
        }
      });
    } else {
      strategyChart.data.labels = labels;
      strategyChart.data.datasets[0].data = winData;
      strategyChart.data.datasets[1].data = loseData;
      strategyChart.update();
    }

    // Top สูตรย้อนหลัง
    const topList = document.getElementById("top-strategies");
    if (!topStrategies.length) {
      topList.innerHTML = `<li class="text-gray-400">ยังไม่มีข้อมูลเพียงพอ</li>`;
    } else {
      topList.innerHTML = topStrategies.map(s => `
        <li>
          <span class="font-semibold text-emerald-300">${s.strategy}</span>
          — เล่น ${s.total - s.pending} ตา |
          WIN ${s.win} | LOSE ${s.lose} |
          WinRate ${s.winRate}% |
          กำไร ${s.profitUnits} หน่วย
        </li>
      `).join("");
    }

    // สูตรฟอร์มดีวันนี้
    const todayList = document.getElementById("today-strategies");
    if (!today || !today.strategies.length) {
      todayList.innerHTML = `<li class="text-gray-400">วันนี้ยังไม่มีสูตรไหนชัดเจน</li>`;
    } else {
      todayList.innerHTML = today.strategies.map(s => `
        <li>
          <span class="font-semibold text-sky-300">${s.strategy}</span>
          — เล่นวันนี้ ${s.total - s.pending} ตา |
          WIN ${s.win} | LOSE ${s.lose} |
          WinRate ${s.winRate}% |
          กำไรวันนี้ ${s.profitUnits} หน่วย
        </li>
      `).join("");
    }

    // ตารางผลล่าสุด
    const recent = recentSettled || [];
    const table = document.getElementById("recentTable");
    if (!recent.length) {
      table.innerHTML = `
        <tr><td colspan="4" class="p-2 text-center text-gray-400">
          ยังไม่มีผลที่สรุปแล้ว
        </td></tr>`;
    } else {
      table.innerHTML = recent.map(p => `
        <tr class="border-b border-gray-700">
          <td class="p-2">${p.settledAt || p.ts || "-"}</td>
          <td class="p-2">${p.home} vs ${p.away} (${p.finalScore || p.scoreAtScan || "-"})</td>
          <td class="p-2">${p.strategy}</td>
          <td class="p-2 font-bold ${p.result === "WIN" ? "text-green-400" : "text-red-400"}">
            ${p.result}
          </td>
        </tr>
      `).join("");
    }

    if (!isAuto) {
      console.log("🔄 Stats loaded", new Date().toLocaleTimeString());
    }
  } catch (err) {
    console.error("Stats load error:", err);
  }
}

// โหลดครั้งแรก
loadStats(false);

// อัปเดตทุก 10 วินาที
setInterval(() => loadStats(true), 10000);
