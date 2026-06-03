// ═══════════════════════════════════════════════════════════
// XLM/USDT ZigZag Monitor — Servidor Node.js para Render
// Corre 24/7, no necesita pantalla ni celular encendido
// VERSION CORREGIDA (maneja errores de Binance)
// ═══════════════════════════════════════════════════════════

const https = require("https");
const http  = require("http");

// ── CONFIG ──────────────────────────────────────────────────
const SYMBOL    = "XLMUSDT";
const TG_TOKEN  = process.env.TG_TOKEN;
const TG_CHAT   = process.env.TG_CHAT;
const PCT       = 0.01;
const MIN_BARS  = 1;
const POLL_MS   = 2 * 60 * 1000;
const PORT      = process.env.PORT || 3000;

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

// ── HELPERS ──────────────────────────────────────────────────
function log(type, msg) {
  const ts    = new Date().toLocaleString("es-AR");
  const entry = `[${ts}] [${type}] ${msg}`;
  console.log(entry);
  statusLog.unshift({ ts, type, msg });
  if (statusLog.length > 100) statusLog.pop();
}

function fetchJSON(url) {
  return new Promise((resolve, reject) => {
    https.get(url, { headers: { "User-Agent": "XLM-ZigZag-Monitor/1.0" } }, (res) => {
      let data = "";
      res.on("data", chunk => data += chunk);
      res.on("end", () => {
        // Verificar código de estado HTTP
        if (res.statusCode !== 200) {
          reject(new Error(`HTTP ${res.statusCode}: ${data}`));
          return;
        }
        try {
          const parsed = JSON.parse(data);
          resolve(parsed);
        } catch(e) {
          reject(new Error("JSON parse error: " + data.substring(0, 100)));
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

// ── TELEGRAM ─────────────────────────────────────────────────
async function sendTelegram(msg) {
  if (!TG_TOKEN || !TG_CHAT) {
    log("ERROR", "Faltan variables TG_TOKEN o TG_CHAT");
    return false;
  }
  try {
    const res = await postJSON(
      `https://api.telegram.org/bot${TG_TOKEN}/sendMessage`,
      { chat_id: TG_CHAT, text: msg, parse_mode: "HTML" }
    );
    if (!res.ok) throw new Error(res.description || "Error Telegram");
    return true;
  } catch(e) {
    log("ERROR", `Telegram: ${e.message}`);
    return false;
  }
}

// ── BINANCE — solo velas cerradas (CORREGIDO) ─────────────────
async function fetchClosedCandles(tf, limit) {
  const url = `https://api.binance.com/api/v3/klines?symbol=${SYMBOL}&interval=${tf}&limit=${limit}`;
  const raw = await fetchJSON(url);
  
  // Si Binance devuelve un objeto de error, raw no será array
  if (!Array.isArray(raw)) {
    throw new Error(`Binance devolvió: ${JSON.stringify(raw)}`);
  }
  
  const now = Date.now();
  return raw
    .filter(k => parseInt(k[6]) < now)
    .map(k => ({
      h: parseFloat(k[2]),
      l: parseFloat(k[3]),
      c: parseFloat(k[4]),
    }));
}

// ── ZIGZAG — lógica idéntica al Pine Script ───────────────────
function calcZigZag(candles, pct, minBars) {
  if (!candles || candles.length < 3) return null;

  let seekHigh    = true;
  let runHigh     = NaN, runHighIdx = -1;
  let runLow      = NaN, runLowIdx  = -1;
  let htfBarCount = 0;
  const pivots    = [];

  for (let i = 0; i < candles.length; i++) {
    const c = candles[i];

    if (isNaN(runHigh)) {
      runHigh = c.h; runHighIdx = i;
      runLow  = c.l; runLowIdx  = i;
    }

    htfBarCount++;

    if (seekHigh) {
      if (c.h >= runHigh) { runHigh = c.h; runHighIdx = i; htfBarCount = 0; }
    } else {
      if (c.l <= runLow)  { runLow  = c.l; runLowIdx  = i; htfBarCount = 0; }
    }

    if (seekHigh && htfBarCount >= minBars && c.c < runHigh * (1 - pct)) {
      pivots.push({ type: "high", price: runHigh });
      seekHigh = false; runLow = c.l; runLowIdx = i; htfBarCount = 0;
    } else if (!seekHigh && htfBarCount >= minBars && c.c > runLow * (1 + pct)) {
      pivots.push({ type: "low", price: runLow });
      seekHigh = true; runHigh = c.h; runHighIdx = i; htfBarCount = 0;
    }
  }

  const lp    = pivots[pivots.length - 1] || null;
  const trend = pivots.length > 0 ? (seekHigh ? "ALCISTA" : "BAJISTA") : "NEUTRAL";

  return { pivotCount: pivots.length, lastPivot: lp, trend, seekHigh };
}

// ── CICLO PRINCIPAL ───────────────────────────────────────────
async function poll() {
  lastPollTime = new Date();
  log("INFO", `── Ciclo ${lastPollTime.toLocaleTimeString("es-AR")} ──`);

  for (const [tf, cfg] of Object.entries(TF_CONFIG)) {
    try {
      const candles = await fetchClosedCandles(tf, cfg.limit);

      if (!candles || candles.length < 5) {
        log("WARN", `${cfg.label}: solo ${candles?.length || 0} velas`);
        continue;
      }

      const zz   = calcZigZag(candles, PCT, MIN_BARS);
      if (!zz) continue;

      const prev = prevPivotCount[tf] ?? -1;
      const curr = zz.pivotCount;

      if (!isFirstRun && curr > prev && zz.lastPivot) {
        const lp     = zz.lastPivot;
        const isBull = lp.type === "low";
        const emoji  = isBull ? "📈" : "📉";
        const dir    = isBull ? "▲ ALCISTA" : "▼ BAJISTA";

        const msg =
          `${emoji} <b>ZigZag ${dir} — CONFIRMADO</b>\n` +
          `Par: <b>XLM/USDT</b>  ·  TF: <b>${cfg.label}</b>\n` +
          `Pivot: <b>${lp.type === "high" ? "▼ MÁXIMO" : "▲ MÍNIMO"}</b> en <b>${lp.price.toFixed(5)}</b>\n` +
          `Buscando ahora: ${zz.seekHigh ? "▲ MÁXIMO" : "▼ MÍNIMO"}\n` +
          `Pivots totales: ${curr}\n` +
          `🕐 ${new Date().toLocaleString("es-AR")}`;

        const ok = await sendTelegram(msg);
        log(isBull ? "BULL" : "BEAR",
          `${cfg.label}: ${dir} @ ${lp.price.toFixed(5)} → Telegram ${ok ? "✓" : "✗"}`);

      } else if (isFirstRun) {
        log("INFO", `${cfg.label}: init · ${zz.trend} · ${curr} pivots`);
      } else {
        log("INFO", `${cfg.label}: sin cambio · ${zz.trend} · ${curr}p`);
      }

      prevPivotCount[tf] = curr;

    } catch(e) {
      log("ERROR", `${cfg.label}: ${e.message}`);
    }
  }

  if (isFirstRun) {
    isFirstRun = false;
    log("INFO", "✅ Estado inicial cargado. Alertas activas.");
    await sendTelegram(
      `🟢 <b>XLM/USDT ZigZag Monitor ACTIVO</b>\n` +
      `Servidor corriendo en Render 24/7\n` +
      `Retroceso: ${PCT * 100}%  ·  Cada 2 minutos\n` +
      `TFs: ${Object.values(TF_CONFIG).map(c => c.label).join(", ")}\n` +
      `🕐 ${new Date().toLocaleString("es-AR")}`
    );
  }
}

// ── SERVIDOR HTTP ─────────────────────────────────────────────
const server = http.createServer((req, res) => {
  if (req.url === "/health" || req.url === "/") {
    const data = {
      status:    "✅ corriendo",
      symbol:    SYMBOL,
      pct:       `${PCT * 100}%`,
      lastPoll:  lastPollTime ? lastPollTime.toLocaleString("es-AR") : "pendiente",
      uptime:    `${Math.floor(process.uptime() / 60)} min`,
      recentLog: statusLog.slice(0, 15),
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
  log("INFO", "XLM/USDT ZigZag Monitor iniciado (versión corregida)");
  poll();
  setInterval(poll, POLL_MS);
});
