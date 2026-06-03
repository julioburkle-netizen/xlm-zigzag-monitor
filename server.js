// ═══════════════════════════════════════════════════════════
// XLM/USDT ZigZag Monitor — Servidor Node.js para Render
// Versión original funcional (con todas las temporalidades)
// ═══════════════════════════════════════════════════════════

const https = require("https");
const http  = require("http");

const SYMBOL    = "XLMUSDT";
const TG_TOKEN  = process.env.TG_TOKEN;
const TG_CHAT   = process.env.TG_CHAT;
const PCT       = 0.01;
const MIN_BARS  = 1;
const POLL_MS   = 2 * 60 * 1000;
const PORT      = process.env.PORT || 3000;

// TODAS las temporalidades (como al principio)
const TF_CONFIG = {
  "2m":  { label: "2 Min",   limit: 800 },
  "5m":  { label: "5 Min",   limit: 800 },
  "15m": { label: "15 Min",  limit: 800 },
  "30m": { label: "30 Min",  limit: 800 },
  "1h":  { label: "1 Hora",  limit: 800 },
  "4h":  { label: "4 Horas", limit: 800 },
  "1d":  { label: "Diario",  limit: 800 },
  "1w":  { label: "Semanal", limit: 500 },
  "1M":  { label: "Mensual", limit: 200 },
};

let prevPivotCount = {};
let isFirstRun     = true;
let lastPollTime   = null;
let statusLog      = [];

function log(type, msg) {
  const ts    = new Date().toLocaleString("es-AR");
  const entry = `[${ts}] [${type}] ${msg}`;
  console.log(entry);
  statusLog.unshift({ ts, type, msg });
  if (statusLog.length > 100) statusLog.pop();
}

function fetchJSON(url) {
  return new Promise((resolve, reject) => {
    const options = {
      headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
        "Accept": "application/json"
      }
    };
    https.get(url, options, (res) => {
      let data = "";
      res.on("data", chunk => data += chunk);
      res.on("end", () => {
        if (res.statusCode !== 200) {
          reject(new Error(`HTTP ${res.statusCode}: ${data}`));
          return;
        }
        try {
          resolve(JSON.parse(data));
        } catch(e) {
          reject(new Error("JSON parse error"));
        }
      });
    }).on("error", reject);
  });
}

function postJSON(url, body) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body);
    const urlObj  = new URL(url);
    const options = {
      hostname: urlObj.hostname,
      path:     urlObj.pathname,
      method:   "POST",
      headers:  {
        "Content-Type":   "application/json",
        "Content-Length": Buffer.byteLength(payload),
      },
    };
    const req = https.request(options, (res) => {
      let data = "";
      res.on("data", chunk => data += chunk);
      res.on("end", () => {
        try { resolve(JSON.parse(data)); }
        catch(e) { reject(new Error("JSON parse")); }
      });
    });
    req.on("error", reject);
    req.write(payload);
    req.end();
  });
}

async function sendTelegram(msg) {
  if (!TG_TOKEN || !TG_CHAT) return false;
  try {
    const res = await postJSON(`https://api.telegram.org/bot${TG_TOKEN}/sendMessage`, { chat_id: TG_CHAT, text: msg, parse_mode: "HTML" });
    return res.ok;
  } catch(e) {
    log("ERROR", `Telegram: ${e.message}`);
    return false;
  }
}

async function fetchClosedCandles(tf, limit) {
  const url = `https://api.binance.com/api/v3/klines?symbol=${SYMBOL}&interval=${tf}&limit=${limit}`;
  const raw = await fetchJSON(url);
  if (!Array.isArray(raw)) throw new Error("Binance no devolvió array");
  const now = Date.now();
  return raw.filter(k => parseInt(k[6]) < now).map(k => ({
    h: parseFloat(k[2]),
    l: parseFloat(k[3]),
    c: parseFloat(k[4]),
  }));
}

function calcZigZag(candles, pct, minBars) {
  if (!candles || candles.length < 3) return null;
  let seekHigh = true;
  let runHigh = NaN, runLow = NaN;
  let htfBarCount = 0;
  const pivots = [];
  for (let i = 0; i < candles.length; i++) {
    const c = candles[i];
    if (isNaN(runHigh)) { runHigh = c.h; runLow = c.l; }
    htfBarCount++;
    if (seekHigh) {
      if (c.h >= runHigh) { runHigh = c.h; htfBarCount = 0; }
    } else {
      if (c.l <= runLow) { runLow = c.l; htfBarCount = 0; }
    }
    if (seekHigh && htfBarCount >= minBars && c.c < runHigh * (1 - pct)) {
      pivots.push({ type: "high", price: runHigh });
      seekHigh = false; runLow = c.l; htfBarCount = 0;
    } else if (!seekHigh && htfBarCount >= minBars && c.c > runLow * (1 + pct)) {
      pivots.push({ type: "low", price: runLow });
      seekHigh = true; runHigh = c.h; htfBarCount = 0;
    }
  }
  const lastPivot = pivots.length ? pivots[pivots.length-1] : null;
  const trend = pivots.length ? (seekHigh ? "ALCISTA" : "BAJISTA") : "NEUTRAL";
  return { pivotCount: pivots.length, lastPivot, trend, seekHigh };
}

async function poll() {
  lastPollTime = new Date();
  log("INFO", `── Ciclo ${lastPollTime.toLocaleTimeString("es-AR")} ──`);
  for (const [tf, cfg] of Object.entries(TF_CONFIG)) {
    try {
      const candles = await fetchClosedCandles(tf, cfg.limit);
      if (candles.length < 5) continue;
      const zz = calcZigZag(candles, PCT, MIN_BARS);
      if (!zz) continue;
      const prev = prevPivotCount[tf] ?? -1;
      const curr = zz.pivotCount;
      if (!isFirstRun && curr > prev && zz.lastPivot) {
        const lp = zz.lastPivot;
        const isBull = lp.type === "low";
        const emoji = isBull ? "📈" : "📉";
        const dir = isBull ? "▲ ALCISTA" : "▼ BAJISTA";
        const msg = `${emoji} <b>ZigZag ${dir} — CONFIRMADO</b>\nPar: <b>XLM/USDT</b>  ·  TF: <b>${cfg.label}</b>\nPivot: <b>${lp.type === "high" ? "▼ MÁXIMO" : "▲ MÍNIMO"}</b> en <b>${lp.price.toFixed(5)}</b>\nBuscando ahora: ${zz.seekHigh ? "▲ MÁXIMO" : "▼ MÍNIMO"}\nPivots totales: ${curr}\n🕐 ${new Date().toLocaleString("es-AR")}`;
        const ok = await sendTelegram(msg);
        log(isBull ? "BULL" : "BEAR", `${cfg.label}: ${dir} @ ${lp.price.toFixed(5)} → Telegram ${ok ? "✓" : "✗"}`);
      } else if (isFirstRun) {
        log("INFO", `${cfg.label}: init · ${zz.trend} · ${curr} pivots`);
      }
      prevPivotCount[tf] = curr;
    } catch(e) {
      log("ERROR", `${cfg.label}: ${e.message}`);
    }
  }
  if (isFirstRun) {
    isFirstRun = false;
    log("INFO", "✅ Estado inicial cargado. Alertas activas.");
    await sendTelegram(`🟢 <b>XLM/USDT ZigZag Monitor ACTIVO</b>\nRetroceso: ${PCT*100}% · Cada 2 min\nTFs: ${Object.values(TF_CONFIG).map(c=>c.label).join(", ")}\n🕐 ${new Date().toLocaleString("es-AR")}`);
  }
}

const server = http.createServer((req, res) => {
  if (req.url === "/health" || req.url === "/") {
    const data = { status: "✅ corriendo", symbol: SYMBOL, pct: `${PCT*100}%`, lastPoll: lastPollTime ? lastPollTime.toLocaleString("es-AR") : "pendiente", uptime: `${Math.floor(process.uptime()/60)} min`, recentLog: statusLog.slice(0,15) };
    res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
    res.end(JSON.stringify(data, null, 2));
  } else { res.writeHead(404); res.end("Not found"); }
});

server.listen(PORT, () => {
  log("INFO", `Puerto ${PORT} activo`);
  log("INFO", "XLM/USDT ZigZag Monitor iniciado");
  poll();
  setInterval(poll, POLL_MS);
});
