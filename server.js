const https = require("https");
const http  = require("http");

const SYMBOL   = "XLM-USDT";

// 🔐 Credenciales por variable de entorno (configúralas en Render → Environment)
const TG_TOKEN = process.env.TG_TOKEN || "";
const TG_CHAT  = process.env.TG_CHAT  || "966057563";

const PCT      = 0.01;   // 1% retroceso para confirmar pivote — igual que "pct" en el Pine
const MIN_BARS = 1;      // velas mínimas entre pivotes — igual que "minBars" en el Pine
const POLL_MS  = 30 * 1000;
const PORT     = process.env.PORT || 3000;
const HTTP_TIMEOUT_MS = 10 * 1000;

// Solo estas 3 temporalidades ("limit" = profundidad del histórico SOLO para
// la primera siembra de estado; después de eso, ya no se usa)
const TF_CONFIG = {
  "1hour": { label: "1 Hora",  limit: 800, seconds: 3600  },
  "4hour": { label: "4 Horas", limit: 800, seconds: 14400 },
  "1day":  { label: "Diario",  limit: 500, seconds: 86400 },
};

let state       = {};   // state[tf] = estado persistente del ZigZag (igual que los "var" del Pine)
let lastPoll    = null;
let statusLog   = [];
let cycleCount  = 0;
let initialized = false;
let isPolling   = false;

function log(type, msg) {
  const ts = new Date().toLocaleString("es-AR");
  console.log(`[${ts}] [${type}] ${msg}`);
  statusLog.unshift({ ts, type, msg });
  if (statusLog.length > 200) statusLog.pop();
}

// ── HTTP helpers con timeout ──────────────────────────────────────────
function fetchJSON(url, timeoutMs = HTTP_TIMEOUT_MS) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { headers: { "User-Agent": "XLM-ZigZag/1.0" } }, (res) => {
      let data = "";
      res.on("data", c => data += c);
      res.on("end", () => {
        try { resolve(JSON.parse(data)); }
        catch (e) { reject(new Error("JSON parse")); }
      });
    });
    req.setTimeout(timeoutMs, () => req.destroy(new Error(`Timeout tras ${timeoutMs}ms`)));
    req.on("error", reject);
  });
}

function postJSON(url, body, timeoutMs = HTTP_TIMEOUT_MS) {
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
      res.on("end", () => { try { resolve(JSON.parse(data)); } catch (e) { reject(e); } });
    });
    req.setTimeout(timeoutMs, () => req.destroy(new Error(`Timeout tras ${timeoutMs}ms`)));
    req.on("error", reject);
    req.write(payload); req.end();
  });
}

async function sendTelegram(msg) {
  if (!TG_TOKEN) {
    log("ERROR", "TG_TOKEN no configurado — alerta NO enviada");
    return false;
  }
  try {
    const r = await postJSON(
      `https://api.telegram.org/bot${TG_TOKEN}/sendMessage`,
      { chat_id: TG_CHAT, text: msg, parse_mode: "HTML" }
    );
    if (!r.ok) throw new Error(r.description);
    return true;
  } catch (e) {
    log("ERROR", `Telegram: ${e.message}`);
    return false;
  }
}

// ── Velas: ascendentes, sin la vela en formación, y con "sinceMs" para ──
// pedir SOLO lo nuevo (igual que el Pine solo procesa "isNewHTFBar") ────
async function fetchCandles(interval, cfg, sinceMs) {
  const { seconds, limit } = cfg;
  const nowSec = Math.floor(Date.now() / 1000);
  const startAt = sinceMs != null
    ? Math.floor(sinceMs / 1000) + 1   // solo velas cerradas después de la última procesada
    : nowSec - limit * seconds;        // primera vez: traer histórico para "sembrar" el estado

  const url = `https://api.kucoin.com/api/v1/market/candles?type=${interval}&symbol=${SYMBOL}&startAt=${startAt}&endAt=${nowSec}`;
  const res = await fetchJSON(url);
  if (!res || res.code !== "200000" || !Array.isArray(res.data))
    throw new Error(`KuCoin: ${JSON.stringify(res)}`);

  const nowMs = Date.now();
  const candles = res.data
    .map(k => ({ t: parseInt(k[0]) * 1000, h: parseFloat(k[3]), l: parseFloat(k[4]), c: parseFloat(k[2]) }))
    .filter(k => k.t + seconds * 1000 <= nowMs)   // excluir vela en curso (por cierre, no apertura)
    .sort((a, b) => a.t - b.t);                   // orden ascendente: barra por barra, como el Pine

  return sinceMs != null ? candles : candles.slice(-limit);
}

// ── Un paso de ZigZag = un bloque "if isNewHTFBar" del Pine, aplicado ──
// a UNA vela. El estado (st) persiste entre llamadas — no se recalcula. ─
function stepZigZag(st, k) {
  const { t, h, l, c } = k;
  let pivot = null;

  if (st.runHigh === null) {
    st.runHigh = h; st.runHighTime = t;
    st.runLow  = l; st.runLowTime  = t;
  }

  st.htfBarCount++;

  if (st.seekHigh) {
    if (h >= st.runHigh) { st.runHigh = h; st.runHighTime = t; st.htfBarCount = 0; }
  } else {
    if (l <= st.runLow)  { st.runLow  = l; st.runLowTime  = t; st.htfBarCount = 0; }
  }

  if (st.seekHigh && st.htfBarCount >= MIN_BARS && c < st.runHigh * (1 - PCT)) {
    pivot = { type: "high", price: st.runHigh, time: st.runHighTime };
    st.lastPrice   = st.runHigh;
    st.lastWasHigh = true;
    st.seekHigh    = false;
    st.runLow      = l; st.runLowTime = t;
    st.htfBarCount = 0;
  } else if (!st.seekHigh && st.htfBarCount >= MIN_BARS && c > st.runLow * (1 + PCT)) {
    pivot = { type: "low", price: st.runLow, time: st.runLowTime };
    st.lastPrice   = st.runLow;
    st.lastWasHigh = false;
    st.seekHigh    = true;
    st.runHigh     = h; st.runHighTime = t;
    st.htfBarCount = 0;
  }

  return pivot;
}

function buildMsg(cfg, lp) {
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

// ── Procesa UNA temporalidad: solo las velas nuevas desde la última vez ─
async function processTimeframe(tf, cfg) {
  const seeding = !state[tf];
  const st = state[tf] || {
    seekHigh: true,
    runHigh: null, runLow: null,
    runHighTime: null, runLowTime: null,
    htfBarCount: 0,
    lastPrice: null, lastWasHigh: false,
    pivotCount: 0,
    lastProcessedTime: null,
  };

  const candles = await fetchCandles(tf, cfg, st.lastProcessedTime);

  if (candles.length === 0) {
    state[tf] = st;
    return; // nada nuevo cerró todavía — exactamente como "not isNewHTFBar" en el Pine
  }

  const newPivots = [];
  for (const k of candles) {
    const pivot = stepZigZag(st, k);
    st.lastProcessedTime = k.t;
    if (pivot) { st.pivotCount++; newPivots.push(pivot); }
  }
  state[tf] = st;

  if (seeding) {
    // Al iniciar, se "siembra" el estado con el histórico, sin alertar —
    // igual que cuando cargás el indicador por primera vez en TradingView.
    log("INFO", `${cfg.label}: estado inicial sembrado · ${st.pivotCount}p históricos · ${candles.length} velas · último ${st.lastWasHigh ? "▼MAX" : "▲MIN"} @ ${st.lastPrice?.toFixed(5) ?? "—"}`);
    return;
  }

  for (const pivot of newPivots) {
    const msg = buildMsg(cfg, pivot);
    const ok  = await sendTelegram(msg);
    log(pivot.type === "low" ? "BULL" : "BEAR",
      `${cfg.label}: nuevo pivote ${pivot.type === "low" ? "▲MIN" : "▼MAX"} @ ${pivot.price.toFixed(5)} · Telegram ${ok ? "OK" : "FAIL"}`);
  }
}

async function poll() {
  if (isPolling) {
    log("WARN", "Ciclo anterior aún en curso — se omite este poll");
    return;
  }
  isPolling = true;
  lastPoll = new Date();
  cycleCount++;

  try {
    for (const [tf, cfg] of Object.entries(TF_CONFIG)) {
      try {
        await processTimeframe(tf, cfg);
      } catch (e) {
        log("ERROR", `${cfg.label}: ${e.message}`);
      }
    }
    if (!initialized) {
      initialized = true;
      log("INFO", "Monitoreando 1H · 4H · Diario · cada 30s · motor incremental (igual que TradingView)");
    }
  } finally {
    isPolling = false;
  }
}

const server = http.createServer((req, res) => {
  if (req.url === "/health" || req.url === "/") {
    const estado = Object.entries(TF_CONFIG).map(([tf, cfg]) => {
      const st = state[tf];
      return {
        label:  cfg.label,
        trend:  st ? (st.seekHigh ? "ALCISTA" : "BAJISTA") : "─",
        pivots: st?.pivotCount || 0,
        ultimo: st && st.lastPrice != null
          ? `${st.lastWasHigh ? "▼MAX" : "▲MIN"} @ ${st.lastPrice.toFixed(5)}`
          : "─",
      };
    });
    res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
    res.end(JSON.stringify({
      status:        "corriendo",
      telegramListo: !!TG_TOKEN,
      lastPoll:      lastPoll?.toLocaleString("es-AR") || "─",
      uptime:        `${Math.floor(process.uptime() / 60)} min`,
      ciclos:        cycleCount,
      estado,
      log:           statusLog.slice(0, 15),
    }, null, 2));
  } else {
    res.writeHead(404); res.end("Not found");
  }
});

server.listen(PORT, () => {
  if (!TG_TOKEN) {
    log("ERROR", "⚠ Falta variable de entorno TG_TOKEN — configúrala en Render. Las alertas de Telegram NO se enviarán hasta entonces.");
  }
  log("INFO", `Puerto ${PORT} · XLM/USDT · 1H 4H Diario`);
  poll();
  setInterval(poll, POLL_MS);
});
