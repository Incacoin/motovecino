// Aviso de saldo bajo en Twilio (25-nov-2026). Si se acaba el saldo dejan de
// llegar los códigos por WhatsApp y nadie puede entrar a la app.
//   - Al arrancar y luego cada 6 h le pregunta a Twilio el saldo (no cuesta).
//   - /api/twilio-health responde 500 si está abajo del mínimo, o si ya van
//     2 consultas seguidas que fallan (clave cambiada/revocada): un monitor de
//     UptimeRobot apuntado ahí manda el correo de siempre. No enseña la
//     cantidad (es pública); la cantidad queda en Movimientos del admin.
//   - Mínimo: TWILIO_SALDO_MINIMO en Render, si no, 6. Va en la moneda de la
//     cuenta de Twilio (hoy dólares; la anotación dice cuál).
// Todo en memoria; para no repetir anotaciones en cada deploy se revisa si ya
// hay una igual en Movimientos de las últimas 24 h.
const db = require("./db");
const { twilioAuth } = require("./whatsappOtp");
const { recordError } = require("./errorAlerts");

const EVERY_MS = 6 * 60 * 60 * 1000;
const FIRST_CHECK_MS = 5 * 1000;
const DEFAULT_MIN = 6;
const FAILS_TO_ALERT = 2;

let state = { status: "sin_configurar", balance: null, currency: null, checkedAt: null };
let fails = 0;

function minimo() {
  const n = Number(process.env.TWILIO_SALDO_MINIMO);
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_MIN;
}

function configured() {
  const sid = process.env.TWILIO_ACCOUNT_SID;
  const hasAuth = process.env.TWILIO_API_KEY ? !!process.env.TWILIO_API_SECRET : !!process.env.TWILIO_AUTH_TOKEN;
  return !!(sid && hasAuth);
}

// Anota en Movimientos, salvo que ya haya una igual en las últimas 24 h.
async function anotarUnaVez(action, detail) {
  try {
    const ya = await db.prepare("SELECT 1 FROM admin_audit WHERE action = ? AND at > datetime('now', '-1 day') LIMIT 1").get(action);
    if (ya) return;
    await db.prepare("INSERT INTO admin_audit (role, zone, action, target_id, detail, ip, ok) VALUES (?, ?, ?, ?, ?, ?, ?)")
      .run(null, null, action, null, detail.slice(0, 400), null, 0);
  } catch (e) {
    console.error("[twilioSaldo] no se pudo anotar:", e.message);
  }
}

// fetchFn se puede cambiar en la prueba (Twilio de mentira).
async function checkNow(fetchFn = fetch) {
  if (!configured()) {
    state = { status: "sin_configurar", balance: null, currency: null, checkedAt: new Date().toISOString() };
    fails = 0;
    return state;
  }
  try {
    const sid = process.env.TWILIO_ACCOUNT_SID;
    const res = await fetchFn(`https://api.twilio.com/2010-04-01/Accounts/${encodeURIComponent(sid)}/Balance.json`, {
      headers: { Authorization: twilioAuth() },
      signal: AbortSignal.timeout(15_000),
    });
    const data = await res.json().catch(() => ({}));
    const balance = Number(data && data.balance);
    if (!res.ok || !Number.isFinite(balance)) throw new Error(`Twilio respondió ${res.status} sin saldo`);
    fails = 0;
    const low = balance < minimo();
    state = { status: low ? "bajo" : "ok", balance, currency: data.currency || "USD", checkedAt: new Date().toISOString() };
    if (low) {
      await anotarUnaVez("twilio_saldo_bajo", `Saldo de Twilio ${balance.toFixed(2)} ${state.currency} (mínimo ${minimo()}). Recargar en console.twilio.com`);
    }
  } catch (err) {
    fails++;
    recordError("twilioSaldo", err);
    // Una falla suelta no cambia nada (puede ser Twilio un rato); dos seguidas
    // ya es aviso: con un saldo viejo no se puede saber si se está acabando.
    if (fails >= FAILS_TO_ALERT) {
      state = { ...state, status: "sin_dato", checkedAt: new Date().toISOString() };
      await anotarUnaVez("twilio_saldo_sin_dato", `No se pudo leer el saldo de Twilio (${String(err && err.message).slice(0, 120)}). Revisar la clave en Render`);
    } else if (state.balance === null) {
      state = { ...state, status: "pendiente", checkedAt: new Date().toISOString() };
    }
  }
  return state;
}

function twilioHealth() {
  return { alert: state.status === "bajo" || state.status === "sin_dato", status: state.status };
}

// Siempre programado: checkNow revisa cada vez si hay claves.
function startTwilioSaldoSchedule() {
  setTimeout(() => checkNow(), FIRST_CHECK_MS).unref();
  setInterval(() => checkNow(), EVERY_MS).unref();
}

// Solo para la prueba.
function _reset() {
  state = { status: "sin_configurar", balance: null, currency: null, checkedAt: null };
  fails = 0;
}

module.exports = { checkNow, twilioHealth, startTwilioSaldoSchedule, minimo, _reset };
