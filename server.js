const https = require("https");
const http  = require("http");

const SYMBOL_KUCOIN = "XLM-USDT";   // KuCoin no tiene restricciones geográficas
const TG_TOKEN = "8274180473:AAHy2A3sFt3peQWoT41CTOAnXPZwIrznNkQ";
const TG_CHAT  = "966057563";
const PCT      = 0.01;
const MIN_BARS = 1;
const POLL_MS  = 2 * 60 * 1000;
const PORT     = process.env.PORT || 3000;

// KuCoin intervals
const TF_CONFIG = {
  "2min":  { label: "2 Minutos",  interval: "2min",  limit: 800 },
  "5min":  { label: "5 Minutos",  interval: "5min",  limit: 800 },
  "15min": { label: "15 Minutos", interval: "15min", limit: 800 },
  "30min": { label: "30 Minutos", interval: "30min", limit: 800 },
  "1hour": { label: "1 Hora",     interval: "1hour", limit: 800 },
  "4hour": { label: "4 Horas",    interval: "4hour", limit: 800 },
  "1day":  { label: "Diario",     interval: "1day",  limit: 500 },
  "1week": { label: "Semanal",    interval: "1week", limit: 200 },
};

let prevPivotCount = {};
let prevTrend      = {};
let isFirstRun     = true;
let lastPollTime   = null;
let statusLog      = [];

function log(type, msg) {
  const ts = new Date().toLocaleString("es-AR");
  console.log(`[${ts}] [${type}] ${msg}`);
  statusLog.unshift({ ts, type, msg });
  if (statusLog.length > 100) statusLog.pop();
}

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
      hostname: u.hostname,
      path: u.pathname,
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Content-Length": Buffer.byteLength(payload)
      },
    }, (res) => {
      let data = "";
      res.on("data", c => data += c);
      res.on("end", () => {
        try { resolve(JSON.parse(data)); }
        catch(e) { reject(e); }
      });
    });
    req.on("error", reject);
    req.write(payload);
    req.end();
  });
}

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

// KuCoin API — sin restricciones geográficas
// Devuelve: [timestamp, open, close, high, low, volume, turnover]
async function fetchClosedCandles(interval, limit) {
  const url = `https://api.kucoin.com/api/v1/market/candles?type=${interval}&symbol=${SYMBOL_KUCOIN}`;
  const res  = await fetchJSON(url);

  if (!res || res.code !== "200000" || !Array.isArray(res.data)) {
    throw new Error(`KuCoin error: ${JSON.stringify(res)}`);
  }

  const now = Date.now();

  // KuCoin devuelve en orden DESCENDENTE (más reciente primero)
  // y timestamp en segundos. Invertimos para procesar cronológicamente.
  const candles = res.data
    .filter(k => parseInt(k[0]) * 1000 < now)   // solo velas cerradas
    .map(k => ({
      time: parseInt(k[0]) * 1000,
      h:    parseFloat(k[3]),   // high
      l:    parseFloat(k[4]),   // low
      c:    parseFloat(k[2]),   // close
    }))
    .reverse()                                    // orden cronológico
    .slice(-limit);                               // últimas N velas

  return candles;
}

function calcZigZag(candles, pct, minBars) {
  if (!candles || candles.length < 3) return null;
  let seekHigh = true;
  let runHigh = NaN, runHighIdx = -1;
  let runLow  = NaN, runLowIdx  = -1;
  let htfBarCount = 0;
  const pivots = [];

  for (let i = 0; i < candles.length; i++) {
    const { h, l, c } = candles[i];
    if (isNaN(runHigh)) {
      runHigh = h; runHighIdx = i;
      runLow  = l; runLowIdx  = i;
    }
    htfBarCount++;
    if (seekHigh) {
      if (h >= runHigh) { runHigh = h; runHighIdx = i; htfBarCount = 0; }
    } else {
      if (l <= runLow)  { runLow  = l; runLowIdx  = i; htfBarCount = 0; }
    }
    if (seekHigh && htfBarCount >= minBars && c < runHigh * (1 - pct)) {
      pivots.push({ type: "high", price: runHigh });
      seekHigh = false; runLow = l; runLowIdx = i; htfBarCount = 0;
    } else if (!seekHigh && htfBarCount >= minBars && c > runLow * (1 + pct)) {
      pivots.push({ type: "low", price: runLow });
      seekHigh = true; runHigh = h; runHighIdx = i; htfBarCount = 0;
    }
  }

  const lp    = pivots[pivots.length - 1] || null;
  const trend = pivots.length > 0 ? (seekHigh ? "ALCISTA" : "BAJISTA") : "NEUTRAL";
  return { pivotCount: pivots.length, lastPivot: lp, trend, seekHigh };
}

function buildAlertMsg(cfg, zz) {
  const lp     = zz.lastPivot;
  const isBull = lp.type === "low";
  const emoji  = isBull ? "📈" : "📉";
  const señal  = isBull ? "🟢 SEÑAL ALCISTA" : "🔴 SEÑAL BAJISTA";
  const pivot  = isBull ? "▲ MÍNIMO confirmado" : "▼ MÁXIMO confirmado";
  const next   = isBull ? "🔼 Buscando próximo MÁXIMO" : "🔽 Buscando próximo MÍNIMO";
  const explica = isBull
    ? "El precio tocó fondo y rebotó +1%"
    : "El precio tocó techo y cayó -1%";
  return (
    `${emoji} <b>${señal}</b>\n` +
    `━━━━━━━━━━━━━━━━━━━\n` +
    `📊 Par: <b>XLM/USDT</b>\n` +
    `⏱ Temporalidad: <b>${cfg.label}</b>\n` +
    `━━━━━━━━━━━━━━━━━━━\n` +
    `〽️ ZigZag: <b>${pivot}</b>\n` +
    `💰 Precio pivot: <b>${lp.price.toFixed(5)} USDT</b>\n` +
    `${next}\n` +
    `━━━━━━━━━━━━━━━━━━━\n` +
    `ℹ️ ${explica}\n` +
    `🕐 ${new Date().toLocaleString("es-AR")}`
  );
}

async function poll() {
  lastPollTime = new Date();
  log("INFO", `── Ciclo ${lastPollTime.toLocaleTimeString("es-AR")} ──`);

  for (const [tf, cfg] of Object.entries(TF_CONFIG)) {
    try {
      const candles = await fetchClosedCandles(cfg.interval, cfg.limit);

      if (!candles || candles.length < 5) {
        log("WARN", `${cfg.label}: pocas velas (${candles?.length || 0})`);
        continue;
      }

      const zz = calcZigZag(candles, PCT, MIN_BARS);
      if (!zz) continue;

      const prev = prevPivotCount[tf] ?? -1;
      const curr = zz.pivotCount;

      prevTrend[tf] = zz.trend;

      if (!isFirstRun && curr > prev && zz.lastPivot) {
        const msg = buildAlertMsg(cfg, zz);
        const ok  = await sendTelegram(msg);
        const dir = zz.lastPivot.type === "low" ? "ALCISTA" : "BAJISTA";
        log(zz.lastPivot.type === "low" ? "BULL" : "BEAR",
          `${cfg.label}: ${dir} @ ${zz.lastPivot.price.toFixed(5)} Telegram ${ok?"OK":"FAIL"}`);
      } else {
        log("INFO", `${cfg.label}: ${zz.trend} · ${curr} pivots`);
      }

      prevPivotCount[tf] = curr;

    } catch(e) {
      log("ERROR", `${cfg.label}: ${e.message}`);
    }
  }

  if (isFirstRun) {
    isFirstRun = false;
    log("INFO", "Estado inicial cargado. Alertas activas.");

    let msg = `🟢 <b>XLM/USDT ZigZag Monitor ACTIVO</b>\n`;
    msg    += `KuCoin · Render 24/7 · Retroceso: ${PCT * 100}%\n`;
    msg    += `━━━━━━━━━━━━━━━━━━━\n`;
    msg    += `📊 <b>Estado actual:</b>\n`;

    for (const [tf, cfg] of Object.entries(TF_CONFIG)) {
      const trend = prevTrend[tf] || "─";
      const emoji = trend === "ALCISTA" ? "🟢" : trend === "BAJISTA" ? "🔴" : "⚪";
      msg += `${emoji} ${cfg.label}: <b>${trend}</b>\n`;
    }

    msg += `━━━━━━━━━━━━━━━━━━━\n`;
    msg += `🕐 ${new Date().toLocaleString("es-AR")}`;

    await sendTelegram(msg);
  }
}

const server = http.createServer((req, res) => {
  if (req.url === "/health" || req.url === "/") {
    const estado = Object.entries(TF_CONFIG).map(([tf, cfg]) => ({
      tf, label: cfg.label,
      trend:  prevTrend[tf]      || "pendiente",
      pivots: prevPivotCount[tf] ?? 0,
    }));
    const data = {
      status:    "corriendo",
      fuente:    "KuCoin",
      lastPoll:  lastPollTime ? lastPollTime.toLocaleString("es-AR") : "pendiente",
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
  log("INFO", "XLM/USDT ZigZag Monitor — KuCoin");
  poll();
  setInterval(poll, POLL_MS);
});
