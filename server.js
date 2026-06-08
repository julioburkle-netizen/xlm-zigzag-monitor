const https = require("https");
const http  = require("http");

const SYMBOL   = "XLM-USDT";
const TG_TOKEN = "8274180473:AAHy2A3sFt3peQWoT41CTOAnXPZwIrznNkQ";
const TG_CHAT  = "966057563";
const PCT      = 0.01;
const MIN_BARS = 1;
const POLL_MS  = 30 * 1000;
const PORT     = process.env.PORT || 3000;

// Solo estas 3 temporalidades
const TF_CONFIG = {
  "1hour": { label: "1 Hora",  limit: 800 },
  "4hour": { label: "4 Horas", limit: 800 },
  "1day":  { label: "Diario",  limit: 500 },
};

let state       = {};
let lastPoll    = null;
let statusLog   = [];
let cycleCount  = 0;
let initialized = false;

function log(type, msg) {
  const ts = new Date().toLocaleString("es-AR");
  console.log(`[${ts}] [${type}] ${msg}`);
  statusLog.unshift({ ts, type, msg });
  if (statusLog.length > 200) statusLog.pop();
}

function fetchJSON(url) {
  return new Promise((resolve, reject) => {
    https.get(url, { headers: { "User-Agent": "XLM-ZigZag/1.0" } }, (res) => {
      let data = "";
      res.on("data", c => data += c);
      res.on("end", () => {
        try { resolve(JSON.parse(data)); }
        catch(e) { reject(new Error("JSON parse")); }
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
      headers: {
        "Content-Type": "application/json",
        "Content-Length": Buffer.byteLength(payload)
      },
    }, (res) => {
      let data = "";
      res.on("data", c => data += c);
      res.on("end", () => { try { resolve(JSON.parse(data)); } catch(e) { reject(e); } });
    });
    req.on("error", reject);
    req.write(payload); req.end();
  });
}

async function sendTelegram(msg) {
  try {
    const r = await postJSON(
      `https://api.telegram.org/bot${TG_TOKEN}/sendMessage`,
      { chat_id: TG_CHAT, text: msg, parse_mode: "HTML" }
    );
    if (!r.ok) throw new Error(r.description);
    return true;
  } catch(e) {
    log("ERROR", `Telegram: ${e.message}`);
    return false;
  }
}

async function fetchCandles(interval, limit) {
  const url = `https://api.kucoin.com/api/v1/market/candles?type=${interval}&symbol=${SYMBOL}`;
  const res  = await fetchJSON(url);
  if (!res || res.code !== "200000" || !Array.isArray(res.data))
    throw new Error(`KuCoin: ${JSON.stringify(res)}`);
  const now = Date.now();
  return res.data
    .filter(k => parseInt(k[0]) * 1000 < now)
    .map(k => ({ h: parseFloat(k[3]), l: parseFloat(k[4]), c: parseFloat(k[2]) }))
    .reverse()
    .slice(-limit);
}

function calcZigZag(candles) {
  if (!candles || candles.length < 3) return null;
  let seekHigh = true;
  let runHigh = NaN, runLow = NaN;
  let htfCount = 0;
  const pivots = [];

  for (const { h, l, c } of candles) {
    if (isNaN(runHigh)) { runHigh = h; runLow = l; }
    htfCount++;
    if (seekHigh) {
      if (h >= runHigh) { runHigh = h; htfCount = 0; }
    } else {
      if (l <= runLow)  { runLow  = l; htfCount = 0; }
    }
    if (seekHigh && htfCount >= MIN_BARS && c < runHigh * (1 - PCT)) {
      pivots.push({ type: "high", price: runHigh });
      seekHigh = false; runLow = l; htfCount = 0;
    } else if (!seekHigh && htfCount >= MIN_BARS && c > runLow * (1 + PCT)) {
      pivots.push({ type: "low", price: runLow });
      seekHigh = true; runHigh = h; htfCount = 0;
    }
  }

  const lp    = pivots[pivots.length - 1] || null;
  const trend = pivots.length > 0 ? (seekHigh ? "ALCISTA" : "BAJISTA") : "NEUTRAL";
  return { pivotCount: pivots.length, lastPivot: lp, trend };
}

function buildMsg(cfg, zz) {
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
  lastPoll = new Date();
  cycleCount++;

  for (const [tf, cfg] of Object.entries(TF_CONFIG)) {
    try {
      const candles = await fetchCandles(tf, cfg.limit);
      if (!candles || candles.length < 5) continue;

      const zz = calcZigZag(candles);
      if (!zz || !zz.lastPivot) continue;

      const prev = state[tf];

      if (!prev) {
        state[tf] = {
          pivotCount:     zz.pivotCount,
          lastPivotPrice: zz.lastPivot.price,
          lastPivotType:  zz.lastPivot.type,
          trend:          zz.trend,
        };
        log("INFO", `${cfg.label}: init · ${zz.trend} · ${zz.pivotCount}p · ${zz.lastPivot.type} @ ${zz.lastPivot.price.toFixed(5)}`);
        continue;
      }

      const nuevoContador = zz.pivotCount > prev.pivotCount;
      const nuevoPrecio   = zz.lastPivot.price !== prev.lastPivotPrice;
      const nuevoTipo     = zz.lastPivot.type  !== prev.lastPivotType;

      if (nuevoContador || (nuevoPrecio && nuevoTipo)) {
        const msg = buildMsg(cfg, zz);
        const ok  = await sendTelegram(msg);
        log(zz.lastPivot.type === "low" ? "BULL" : "BEAR",
          `${cfg.label}: ${zz.trend} @ ${zz.lastPivot.price.toFixed(5)} · Telegram ${ok?"OK":"FAIL"}`);
      }

      state[tf] = {
        pivotCount:     zz.pivotCount,
        lastPivotPrice: zz.lastPivot.price,
        lastPivotType:  zz.lastPivot.type,
        trend:          zz.trend,
      };

    } catch(e) {
      log("ERROR", `${cfg.label}: ${e.message}`);
    }
  }

  if (!initialized) {
    initialized = true;
    log("INFO", "Monitoreando 1H · 4H · Diario · cada 30 segundos");
  }
}

const server = http.createServer((req, res) => {
  if (req.url === "/health" || req.url === "/") {
    const estado = Object.entries(TF_CONFIG).map(([tf, cfg]) => ({
      label:  cfg.label,
      trend:  state[tf]?.trend || "─",
      pivots: state[tf]?.pivotCount || 0,
      ultimo: state[tf]
        ? `${state[tf].lastPivotType === "low" ? "▲MIN" : "▼MAX"} @ ${state[tf].lastPivotPrice?.toFixed(5)}`
        : "─",
    }));
    res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
    res.end(JSON.stringify({
      status:   "corriendo",
      lastPoll: lastPoll?.toLocaleString("es-AR") || "─",
      uptime:   `${Math.floor(process.uptime() / 60)} min`,
      ciclos:   cycleCount,
      estado,
      log:      statusLog.slice(0, 15),
    }, null, 2));
  } else {
    res.writeHead(404); res.end("Not found");
  }
});

server.listen(PORT, () => {
  log("INFO", `Puerto ${PORT} · XLM/USDT · 1H 4H Diario`);
  poll();
  setInterval(poll, POLL_MS);
});
