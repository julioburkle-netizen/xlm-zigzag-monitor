const https = require("https");
const http  = require("http");

// 🔐 Credenciales por variable de entorno (configúralas en Render → Environment)
const TG_TOKEN = process.env.TG_TOKEN || "";
const TG_CHAT  = process.env.TG_CHAT  || "966057563";

const PCT      = 0.01;   // 1% retroceso para confirmar pivote
const MIN_BARS = 1;      // velas mínimas entre pivotes
const POLL_MS  = 30 * 1000;
const PORT     = process.env.PORT || 3000;
const HTTP_TIMEOUT_MS = 10 * 1000;

// ══════════════════════════════════════════════════════════════════════
//   📌 PARES A MONITOREAR — agrega/quita líneas aquí
// ══════════════════════════════════════════════════════════════════════
const MONITORS = [
  { id: "xlm", pairLabel: "XLM/USDT",        exchangeLabel: "KuCoin", exchange: "kucoin", symbol: "XLM-USDT" },
  { id: "a",   pairLabel: "A/USDT (Vaulta)", exchangeLabel: "LBank",  exchange: "lbank",  symbol: "a_usdt"   },
];

// Temporalidades (neutrales) + cuánto histórico pedir al "sembrar" el estado
const TF_DEFS = {
  "1h": { label: "1 Hora",  seconds: 3600,  limit: 800 },
  "4h": { label: "4 Horas", seconds: 14400, limit: 800 },
  "1d": { label: "Diario",  seconds: 86400, limit: 500 },
};

// Cómo se llama cada temporalidad en la API de cada exchange
const TF_NAME = {
  kucoin: { "1h": "1hour", "4h": "4hour", "1d": "1day" },
  lbank:  { "1h": "hour1", "4h": "hour4", "1d": "day1" },
};

let state       = {};   // state["xlm:1h"] = estado persistente del ZigZag para ese par+tf
let lastPoll    = null;
let statusLog   = [];
let cycleCount  = 0;
let initialized = false;
let isPolling   = false;

// Formato forzado a 24hs + zona horaria de Argentina explícita, sin depender
// de defaults del locale (que pueden variar según el motor de Node del host).
function horaAR(date = new Date()) {
  return date.toLocaleString("es-AR", {
    timeZone: "America/Argentina/Buenos_Aires",
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit",
    hour12: false,
  });
}

function log(type, msg) {
  const ts = horaAR();
  console.log(`[${ts}] [${type}] ${msg}`);
  statusLog.unshift({ ts, type, msg });
  if (statusLog.length > 200) statusLog.pop();
}

// ── HTTP helpers con timeout ──────────────────────────────────────────
function fetchJSON(url, timeoutMs = HTTP_TIMEOUT_MS) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { headers: { "User-Agent": "Multi-ZigZag/1.0" } }, (res) => {
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

// ── KuCoin: velas ascendentes, sin la vela en formación ────────────────
async function fetchCandlesKuCoin(symbol, interval, cfg, sinceMs) {
  const { seconds, limit } = cfg;
  const nowSec = Math.floor(Date.now() / 1000);
  const startAt = sinceMs != null
    ? Math.floor(sinceMs / 1000) + 1
    : nowSec - limit * seconds;

  const url = `https://api.kucoin.com/api/v1/market/candles?type=${interval}&symbol=${symbol}&startAt=${startAt}&endAt=${nowSec}`;
  const res = await fetchJSON(url);
  if (!res || res.code !== "200000" || !Array.isArray(res.data))
    throw new Error(`KuCoin: ${JSON.stringify(res)}`);

  const nowMs = Date.now();
  const candles = res.data
    .map(k => ({ t: parseInt(k[0]) * 1000, h: parseFloat(k[3]), l: parseFloat(k[4]), c: parseFloat(k[2]) }))
    .filter(k => k.t + seconds * 1000 <= nowMs)
    .sort((a, b) => a.t - b.t);

  return sinceMs != null ? candles : candles.slice(-limit);
}

// ── LBank: formato y endpoint distintos. El parámetro "time" de LBank ──
// no filtra de forma confiable (bug conocido de su API), así que SIEMPRE
// se filtra localmente por sinceMs en vez de confiar en el rango pedido.
async function fetchCandlesLBank(symbol, type, cfg, sinceMs) {
  const { seconds, limit } = cfg;
  const size = sinceMs != null ? 50 : limit; // si ya hay estado, alcanza con pocas velas recientes
  const nowSec = Math.floor(Date.now() / 1000);
  const url = `https://api.lbkex.com/v1/kline.do?symbol=${symbol}&size=${size}&type=${type}&time=${nowSec}`;
  const res = await fetchJSON(url);
  if (!Array.isArray(res)) throw new Error(`LBank: ${JSON.stringify(res)}`);

  const nowMs = Date.now();
  let candles = res
    // formato LBank: [tiempo(seg), open, high, low, close, volumen]
    .map(k => ({ t: k[0] * 1000, h: k[2], l: k[3], c: k[4] }))
    .filter(k => k.t + seconds * 1000 <= nowMs)
    .sort((a, b) => a.t - b.t);

  if (sinceMs != null) candles = candles.filter(k => k.t > sinceMs);
  return sinceMs != null ? candles : candles.slice(-limit);
}

async function fetchCandles(monitor, tfKey, cfg, sinceMs) {
  const interval = TF_NAME[monitor.exchange][tfKey];
  if (monitor.exchange === "kucoin") return fetchCandlesKuCoin(monitor.symbol, interval, cfg, sinceMs);
  if (monitor.exchange === "lbank")  return fetchCandlesLBank(monitor.symbol, interval, cfg, sinceMs);
  throw new Error(`Exchange desconocido: ${monitor.exchange}`);
}

// ── Un paso de ZigZag, igual lógica que el Pine: estado persistente, ──
// se avanza vela por vela, nunca se recalcula desde cero. ─────────────
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

function buildMsg(monitor, cfg, lp) {
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
    `📊 Par: <b>${monitor.pairLabel}</b> (${monitor.exchangeLabel})\n` +
    `⏱ Temporalidad: <b>${cfg.label}</b>\n` +
    `━━━━━━━━━━━━━━━━━━━\n` +
    `〽️ ZigZag: <b>${pivot}</b>\n` +
    `💰 Precio pivot: <b>${lp.price.toFixed(5)} USDT</b>\n` +
    `${next}\n` +
    `━━━━━━━━━━━━━━━━━━━\n` +
    `ℹ️ ${explica}\n` +
    `🕐 ${horaAR()}`
  );
}

// ── Procesa UNA temporalidad de UN par: solo velas nuevas desde la ──
// última vez. El estado vive en state[`${monitor.id}:${tfKey}`]. ────
async function processTimeframe(monitor, tfKey, cfg) {
  const key     = `${monitor.id}:${tfKey}`;
  const seeding = !state[key];
  const st = state[key] || {
    seekHigh: true,
    runHigh: null, runLow: null,
    runHighTime: null, runLowTime: null,
    htfBarCount: 0,
    lastPrice: null, lastWasHigh: false,
    pivotCount: 0,
    lastProcessedTime: null,
  };

  const candles = await fetchCandles(monitor, tfKey, cfg, st.lastProcessedTime);

  if (candles.length === 0) {
    state[key] = st;
    return;
  }

  const newPivots = [];
  for (const k of candles) {
    const pivot = stepZigZag(st, k);
    st.lastProcessedTime = k.t;
    if (pivot) { st.pivotCount++; newPivots.push(pivot); }
  }
  state[key] = st;

  if (seeding) {
    log("INFO", `${monitor.pairLabel} ${cfg.label}: estado sembrado · ${st.pivotCount}p históricos · ${candles.length} velas · último ${st.lastWasHigh ? "▼MAX" : "▲MIN"} @ ${st.lastPrice?.toFixed(5) ?? "—"}`);
    return;
  }

  for (const pivot of newPivots) {
    const msg = buildMsg(monitor, cfg, pivot);
    const ok  = await sendTelegram(msg);
    log(pivot.type === "low" ? "BULL" : "BEAR",
      `${monitor.pairLabel} ${cfg.label}: nuevo pivote ${pivot.type === "low" ? "▲MIN" : "▼MAX"} @ ${pivot.price.toFixed(5)} · Telegram ${ok ? "OK" : "FAIL"}`);
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
    for (const monitor of MONITORS) {
      for (const [tfKey, cfg] of Object.entries(TF_DEFS)) {
        try {
          await processTimeframe(monitor, tfKey, cfg);
        } catch (e) {
          log("ERROR", `${monitor.pairLabel} ${cfg.label}: ${e.message}`);
        }
      }
    }
    if (!initialized) {
      initialized = true;
      log("INFO", `Monitoreando ${MONITORS.map(m => m.pairLabel).join(" · ")} · 1H/4H/Diario · cada 30s`);
    }
  } finally {
    isPolling = false;
  }
}

const server = http.createServer((req, res) => {
  if (req.url === "/health" || req.url === "/") {
    const estado = [];
    for (const monitor of MONITORS) {
      for (const [tfKey, cfg] of Object.entries(TF_DEFS)) {
        const st = state[`${monitor.id}:${tfKey}`];
        estado.push({
          par:    `${monitor.pairLabel} (${monitor.exchangeLabel})`,
          tf:     cfg.label,
          trend:  st ? (st.seekHigh ? "ALCISTA" : "BAJISTA") : "─",
          pivots: st?.pivotCount || 0,
          ultimo: st && st.lastPrice != null
            ? `${st.lastWasHigh ? "▼MAX" : "▲MIN"} @ ${st.lastPrice.toFixed(5)}`
            : "─",
        });
      }
    }
    res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
    res.end(JSON.stringify({
      status:        "corriendo",
      telegramListo: !!TG_TOKEN,
      lastPoll:      lastPoll ? horaAR(lastPoll) : "─",
      uptime:        `${Math.floor(process.uptime() / 60)} min`,
      ciclos:        cycleCount,
      estado,
      log:           statusLog.slice(0, 20),
    }, null, 2));
  } else {
    res.writeHead(404); res.end("Not found");
  }
});

server.listen(PORT, () => {
  if (!TG_TOKEN) {
    log("ERROR", "⚠ Falta variable de entorno TG_TOKEN — configúrala en Render.");
  }
  log("INFO", `Puerto ${PORT} · ${MONITORS.map(m => m.pairLabel).join(" · ")}`);
  poll();
  setInterval(poll, POLL_MS);
});
