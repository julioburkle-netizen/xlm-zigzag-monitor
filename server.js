// ═══════════════════════════════════════════════════════════
// XLM/USDT ZigZag Monitor — Render 24/7
// ZigZag idéntico al Pine Script de TradingView
// Mensajes Telegram claros con señal alcista/bajista
// ═══════════════════════════════════════════════════════════

const https = require("https");
const http  = require("http");

// ── CONFIG ──────────────────────────────────────────────────
const SYMBOL   = "XLMUSDT";
const TG_TOKEN = "8274180473:AAHy2A3sFt3peQWoT41CTOAnXPZwIrznNkQ";
const TG_CHAT  = "966057563";
const PCT      = 0.01;      // 1% igual que TradingView
const MIN_BARS = 1;         // velas mínimas entre pivots
const POLL_MS  = 2 * 60 * 1000;
const PORT     = process.env.PORT || 3000;

// Temporalidades activas — comentá las que no querés
const TF_CONFIG = {
  "2m":  { label: "2 Minutos",  limit: 800 },
  "5m":  { label: "5 Minutos",  limit: 800 },
  "15m": { label: "15 Minutos", limit: 800 },
  "30m": { label: "30 Minutos", limit: 800 },
  "1h":  { label: "1 Hora",     limit: 800 },
  "4h":  { label: "4 Horas",    limit: 800 },
  "1d":  { label: "Diario",     limit: 800 },
  "1w":  { label: "Semanal",    limit: 500 },
  "1M":  { label: "Mensual",    limit: 200 },
};

let prevPivotCount = {};
let prevTrend      = {};   // para detectar cambio de dirección
let isFirstRun     = true;
let lastPollTime   = null;
let statusLog      = [];

// ── LOG ──────────────────────────────────────────────────────
function log(type, msg) {
  const ts = new Date().toLocaleString("es-AR");
  console.log(`[${ts}] [${type}] ${msg}`);
  statusLog.unshift({ ts, type, msg });
  if (statusLog.length > 100) statusLog.pop();
}

// ── HTTP helper ──────────────────────────────────────────────
function fetchJSON(url) {
  return new Promise((resolve, reject) => {
    https.get(url, { headers: { "User-Agent": "XLM-ZigZag/1.0" } }, (res) => {
      let data = "";
      res.on("data", c => data += c);
      res.on("end", () => {
        try { resolve(JSON.parse(data)); }
        catch(e) { reject(new Error("JSON parse error")); }
      });
    }).on("error", reject);
  });
}

function postJSON(url, body) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body);
    const u = new URL(url);
    const req = https.request({
      hostname: u.hostname, path: u.pathname, method: "POST",
      headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(payload) },
    }, (res) => {
      let data = "";
      res.on("data", c => data += c);
      res.on("end", () => { try { resolve(JSON.parse(data)); } catch(e) { reject(e); } });
    });
    req.on("error", reject);
    req.write(payload);
    req.end();
  });
}

// ── TELEGRAM ─────────────────────────────────────────────────
async function sendTelegram(msg) {
  try {
    const r = await postJSON(
      `https://api.telegram.org/bot${TG_TOKEN}/sendMessage`,
      { chat_id: TG_CHAT, text: msg, parse_mode: "HTML" }
    );
    if (!r.ok) throw new Error(r.description || "Error");
    return true;
  } catch(e) {
    log("ERROR", `Telegram: ${e.message}`);
    return false;
  }
}

// ── BINANCE — solo velas 100% cerradas ───────────────────────
async function fetchClosedCandles(tf, limit) {
  const url = `https://api.binance.com/api/v3/klines?symbol=${SYMBOL}&interval=${tf}&limit=${limit}`;
  const raw  = await fetchJSON(url);
  const now  = Date.now();
  return raw
    .filter(k => parseInt(k[6]) < now)   // k[6] = closeTime
    .map(k => ({
      h: parseFloat(k[2]),
      l: parseFloat(k[3]),
      c: parseFloat(k[4]),
    }));
}

// ── ZIGZAG ────────────────────────────────────────────────────
// Traducción literal del Pine Script:
//   seekHigh=true  → buscando máximo → tendencia ALCISTA
//   seekHigh=false → buscando mínimo → tendencia BAJISTA
function calcZigZag(candles, pct, minBars) {
  if (!candles || candles.length < 3) return null;

  let seekHigh    = true;
  let runHigh     = NaN, runHighIdx = -1;
  let runLow      = NaN, runLowIdx  = -1;
  let htfBarCount = 0;
  const pivots    = [];

  for (let i = 0; i < candles.length; i++) {
    const { h, l, c } = candles[i];

    // Pine: if na(runHigh) → inicializar
    if (isNaN(runHigh)) {
      runHigh = h; runHighIdx = i;
      runLow  = l; runLowIdx  = i;
    }

    // Pine: htfBarCount += 1
    htfBarCount++;

    // Pine: actualizar extremo según dirección
    if (seekHigh) {
      if (h >= runHigh) { runHigh = h; runHighIdx = i; htfBarCount = 0; }
    } else {
      if (l <= runLow)  { runLow  = l; runLowIdx  = i; htfBarCount = 0; }
    }

    // Pine: confirmar pivot ALTO → precio cayó 1% desde el máximo
    if (seekHigh && htfBarCount >= minBars && c < runHigh * (1 - pct)) {
      pivots.push({ type: "high", price: runHigh });
      seekHigh = false; runLow = l; runLowIdx = i; htfBarCount = 0;

    // Pine: confirmar pivot BAJO → precio subió 1% desde el mínimo
    } else if (!seekHigh && htfBarCount >= minBars && c > runLow * (1 + pct)) {
      pivots.push({ type: "low", price: runLow });
      seekHigh = true; runHigh = h; runHighIdx = i; htfBarCount = 0;
    }
  }

  const lp = pivots[pivots.length - 1] || null;
  const p2 = pivots[pivots.length - 2] || null;

  // seekHigh=true  → último evento fue LOW confirmado → ALCISTA
  // seekHigh=false → último evento fue HIGH confirmado → BAJISTA
  const trend = pivots.length > 0
    ? (seekHigh ? "ALCISTA" : "BAJISTA")
    : "NEUTRAL";

  return {
    pivotCount: pivots.length,
    lastPivot:  lp,
    prevPivot:  p2,
    trend,
    seekHigh,
    liveExtreme: seekHigh ? runHigh : runLow,
  };
}

// ── MENSAJE TELEGRAM CLARO ────────────────────────────────────
function buildMessage(cfg, zz) {
  const lp     = zz.lastPivot;
  const isBull = lp.type === "low";   // MIN confirmado → alcista

  const emoji    = isBull ? "📈" : "📉";
  const señal    = isBull ? "🟢 SEÑAL ALCISTA" : "🔴 SEÑAL BAJISTA";
  const pivotTxt = isBull ? "▲ MÍNIMO confirmado" : "▼ MÁXIMO confirmado";
  const nextTxt  = isBull
    ? "🔼 Buscando próximo MÁXIMO"
    : "🔽 Buscando próximo MÍNIMO";
  const explica  = isBull
    ? "El precio tocó fondo y rebotó +1%\nMomento de buscar entrada larga"
    : "El precio tocó techo y cayó -1%\nMomento de buscar entrada corta";

  return (
    `${emoji} <b>${señal}</b>\n` +
    `━━━━━━━━━━━━━━━━━━━\n` +
    `📊 Par: <b>XLM/USDT</b>\n` +
    `⏱ Temporalidad: <b>${cfg.label}</b>\n` +
    `━━━━━━━━━━━━━━━━━━━\n` +
    `〽️ ZigZag: <b>${pivotTxt}</b>\n` +
    `💰 Precio del pivot: <b>${lp.price.toFixed(5)} USDT</b>\n` +
    `${nextTxt}\n` +
    `━━━━━━━━━━━━━━━━━━━\n` +
    `ℹ️ ${explica}\n` +
    `━━━━━━━━━━━━━━━━━━━\n` +
    `📌 Pivots en ${cfg.label}: ${zz.pivotCount}\n` +
    `🕐 ${new Date().toLocaleString("es-AR")}`
  );
}

// ── CICLO PRINCIPAL ───────────────────────────────────────────
async function poll() {
  lastPollTime = new Date();
  log("INFO", `── Ciclo ${lastPollTime.toLocaleTimeString("es-AR")} ──`);

  for (const [tf, cfg] of Object.entries(TF_CONFIG)) {
    try {
      const candles = await fetchClosedCandles(tf, cfg.limit);

      if (candles.length < 5) {
        log("WARN", `${cfg.label}: solo ${candles.length} velas cerradas`);
        continue;
      }

      const zz = calcZigZag(candles, PCT, MIN_BARS);
      if (!zz) continue;

      const prevCount = prevPivotCount[tf] ?? -1;
      const currCount = zz.pivotCount;

      if (!isFirstRun && currCount > prevCount && zz.lastPivot) {
        // ── NUEVO PIVOT CONFIRMADO ──
        const msg = buildMessage(cfg, zz);
        const ok  = await sendTelegram(msg);
        const dir = zz.lastPivot.type === "low" ? "ALCISTA" : "BAJISTA";
        log(
          zz.lastPivot.type === "low" ? "BULL" : "BEAR",
          `${cfg.label}: NUEVO PIVOT ${dir} @ ${zz.lastPivot.price.toFixed(5)} · Telegram ${ok ? "✓" : "✗"}`
        );
      } else if (isFirstRun) {
        log("INFO", `${cfg.label}: estado inicial · ${zz.trend} · ${currCount} pivots`);
      } else {
        log("INFO", `${cfg.label}: sin cambio · ${zz.trend} · ${currCount} pivots`);
      }

      prevPivotCount[tf] = currCount;
      prevTrend[tf]      = zz.trend;

    } catch(e) {
      log("ERROR", `${cfg.label}: ${e.message}`);
    }
  }

  if (isFirstRun) {
    isFirstRun = false;
    log("INFO", "✅ Estado inicial cargado. Alertas activas para nuevos pivots.");

    // Resumen de estado inicial a Telegram
    let resumen = `🟢 <b>XLM/USDT ZigZag Monitor ACTIVO</b>\n`;
    resumen    += `Render 24/7 · Retroceso: ${PCT * 100}%\n`;
    resumen    += `━━━━━━━━━━━━━━━━━━━\n`;
    resumen    += `📊 Estado actual:\n`;

    for (const [tf, cfg] of Object.entries(TF_CONFIG)) {
      const trend = prevTrend[tf] || "─";
      const emoji = trend === "ALCISTA" ? "🟢" : trend === "BAJISTA" ? "🔴" : "⚪";
      resumen += `${emoji} ${cfg.label}: <b>${trend}</b>\n`;
    }
    resumen += `━━━━━━━━━━━━━━━━━━━\n`;
    resumen += `🕐 ${new Date().toLocaleString("es-AR")}`;

    await sendTelegram(resumen);
  }
}

// ── SERVIDOR HTTP ─────────────────────────────────────────────
const server = http.createServer((req, res) => {
  if (req.url === "/health" || req.url === "/") {
    // Estado actual de todas las TFs
    const estado = Object.entries(TF_CONFIG).map(([tf, cfg]) => ({
      tf,
      label:  cfg.label,
      trend:  prevTrend[tf]      || "pendiente",
      pivots: prevPivotCount[tf] ?? "─",
    }));

    const data = {
      status:    "✅ corriendo",
      symbol:    SYMBOL,
      pct:       `${PCT * 100}%`,
      lastPoll:  lastPollTime
        ? lastPollTime.toLocaleString("es-AR")
        : "pendiente",
      uptime:    `${Math.floor(process.uptime() / 60)} min`,
      estado,
      recentLog: statusLog.slice(0, 20),
    };

    res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
    res.end(JSON.stringify(data, null, 2));
  } else {
    res.writeHead(404);
    res.end("Not found");
  }
});

server.listen(PORT, () => {
  log("INFO", `Puerto ${PORT} activo`);
  log("INFO", "XLM/USDT ZigZag Monitor iniciado");
  poll();
  setInterval(poll, POLL_MS);
});
