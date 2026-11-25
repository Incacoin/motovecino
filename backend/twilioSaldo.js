// Aviso de saldo bajo en Twilio (25-nov-2026). Si se acaba el saldo dejan de
// llegar los códigos por WhatsApp y nadie puede entrar a la app.
//   - Cada 6 h le pregunta a Twilio el saldo (esa consulta no cuesta).
//   - /api/twilio-health responde 500 si está abajo del mínimo: un monitor
//     de UptimeRobot apuntado ahí manda el correo de siempre. No enseña la
//     cantidad (es pública); la cantidad queda en Movimientos del admin.
//   - Mínimo: TWILIO_SALDO_MINIMO en Render (dólares), si no, $6.
// Todo en memoria: al reiniciar vuelve a preguntar al minuto.
const db = require("./db");
const { twilioAuth } = require("./whatsappOtp");
const { recordError } = require("./errorAlerts");

const EVERY_MS = 6 * 60 * 60 * 1000;
const FIRST_CHECK_MS = 60 * 1000;
const DEFAULT_MIN_USD = 6;

let state = { status: "sin_configurar", balance: null, currency: null, checkedAt: null };

function minimo() {
  const n = Number(process.env.TWILIO_SALDO_MINIMO);
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_MIN_USD;
}

function configured() {
  const sid = process.env.TWILIO_ACCOUNT_SID;
  const hasAuth = process.env.TWILIO_API_KEY ? !!process.env.TWILIO_API_SECRET : !!process.env.TWILIO_AUTH_TOKEN;
  return !!(sid && hasAuth);
}

function anotar(action, detail) {
  return db.prepare("INSERT INTO admin_audit (role, zone, action, target_id, detail, ip, ok) VALUES (?, ?, ?, ?, ?, ?, ?)")
    .run(null, null, action, null, detail.slice(0, 400), null, 0)
    .catch((e) => console.error("[twilioSaldo] no se pudo anotar:", e.message));
}

// fetchFn se puede cambiar en la prueba (Twilio de mentira).
async function checkNow(fetchFn = fetch) {
  if (!configured()) {
    state = { status: "sin_configurar", balance: null, currency: null, checkedAt: new Date().toISOString() };
    return state;
  }
  const before = state.status;
  try {
    const sid = process.env.TWILIO_ACCOUNT_SID;
    const res = await fetchFn(`https://api.twilio.com/2010-04-01/Accounts/${encodeURIComponent(sid)}/Balance.json`, {
      headers: { Authorization: twilioAuth() },
      signal: AbortSignal.timeout(15_000),
    });
    const data = await res.json().catch(() => ({}));
    const balance = Number(data && data.balance);
    if (!res.ok || !Number.isFinite(balance)) throw new Error(`Twilio respondió ${res.status} sin saldo`);
    const low = balance < minimo();
    state = { status: low ? "bajo" : "ok", balance, currency: data.currency || "USD", checkedAt: new Date().toISOString() };
    // Solo una vez al bajar (no cada 6 h mientras siga bajo).
    if (low && before !== "bajo") {
      await anotar("twilio_saldo_bajo", `Saldo de Twilio $${balance.toFixed(2)} ${state.currency} (mínimo $${minimo()}). Recargar en console.twilio.com`);
    }
  } catch (err) {
    // Si falla la consulta no se toca el último saldo bueno: solo se marca.
    state = { ...state, status: state.balance === null ? "sin_dato" : state.status, checkedAt: new Date().toISOString(), error: true };
    recordError("twilioSaldo", err);
  }
  return state;
}

function twilioHealth() {
  return { alert: state.status === "bajo", status: state.status };
}

function startTwilioSaldoSchedule() {
  if (!configured()) return;
  setTimeout(() => checkNow(), FIRST_CHECK_MS).unref();
  setInterval(() => checkNow(), EVERY_MS).unref();
}

// Solo para la prueba.
function _reset() {
  state = { status: "sin_configurar", balance: null, currency: null, checkedAt: null };
}

module.exports = { checkNow, twilioHealth, startTwilioSaldoSchedule, minimo, _reset };
