const crypto = require("node:crypto");
const db = require("./db");

// Código de verificación por WhatsApp para el registro de pasajeros: frena a
// quien se registra con un teléfono falso o ajeno (si el número no es suyo,
// el código nunca le llega).
//
// OTP_MODE decide cómo funciona:
//   "off"      → (default) no se pide código; el registro queda como antes.
//                Así este archivo puede subir a producción antes de tener
//                Twilio listo, sin cambiar nada para nadie.
//   "simulado" → no manda nada: el código regresa en la respuesta para
//                probar el flujo completo en local. NUNCA en producción
//                (en Render se ignora y queda como "off").
//   "twilio"   → manda el código por WhatsApp con Twilio, usando la
//                plantilla de autenticación aprobada por Meta.
const CODE_TTL_MS = 10 * 60 * 1000; // el código vale 10 minutos
const RESEND_COOLDOWN_MS = 60 * 1000; // un reenvío por minuto
const MAX_SENDS_PER_HOUR = 5; // por teléfono — cada envío cuesta dinero
const MAX_WRONG_ATTEMPTS = 5; // por código; después hay que pedir otro

db.exec(`
  CREATE TABLE IF NOT EXISTS phone_otps (
    phone TEXT PRIMARY KEY,
    code_hash TEXT NOT NULL,
    expires_at INTEGER NOT NULL,
    attempts INTEGER NOT NULL DEFAULT 0,
    last_sent_at INTEGER NOT NULL,
    window_start INTEGER NOT NULL,
    sends_in_window INTEGER NOT NULL DEFAULT 0
  );
`);

function otpMode() {
  const mode = (process.env.OTP_MODE || "off").toLowerCase();
  if (mode === "simulado" && process.env.RENDER) {
    console.warn("OTP_MODE=simulado ignorado en Render: se trata como 'off'");
    return "off";
  }
  return ["simulado", "twilio"].includes(mode) ? mode : "off";
}

function otpEnabled() {
  return otpMode() !== "off";
}

function hashCode(phone, code) {
  return crypto.createHash("sha256").update(`${phone}:${code}`).digest("hex");
}

async function sendViaTwilio(e164, code) {
  const sid = process.env.TWILIO_ACCOUNT_SID;
  const token = process.env.TWILIO_AUTH_TOKEN;
  const from = process.env.TWILIO_WHATSAPP_FROM; // ej. +529991234567
  const contentSid = process.env.TWILIO_OTP_CONTENT_SID; // plantilla aprobada (HX...)
  if (!sid || !token || !from || !contentSid) {
    throw new Error("Faltan variables de Twilio");
  }
  const body = new URLSearchParams({
    From: `whatsapp:${from}`,
    To: `whatsapp:${e164}`,
    ContentSid: contentSid,
    ContentVariables: JSON.stringify({ 1: code }),
  });
  const res = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${sid}/Messages.json`, {
    method: "POST",
    headers: {
      Authorization: "Basic " + Buffer.from(`${sid}:${token}`).toString("base64"),
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body,
  });
  if (!res.ok) {
    throw new Error(`Twilio ${res.status}: ${await res.text()}`);
  }
}

// Genera y "manda" un código nuevo. `phone` es como se guarda en riders (la
// llave del límite) y `e164` el número completo con "+" al que se manda.
// Regresa { ok, devCode? } o { status, error }.
async function sendOtp(phone, e164) {
  const now = Date.now();
  const row = db.prepare("SELECT * FROM phone_otps WHERE phone = ?").get(phone);

  if (row && now - row.last_sent_at < RESEND_COOLDOWN_MS) {
    const wait = Math.ceil((RESEND_COOLDOWN_MS - (now - row.last_sent_at)) / 1000);
    return { status: 429, error: `Espera ${wait} segundos para pedir otro código`, retryIn: wait };
  }
  const windowFresh = !row || now - row.window_start > 60 * 60 * 1000;
  const sends = windowFresh ? 0 : row.sends_in_window;
  if (sends >= MAX_SENDS_PER_HOUR) {
    return { status: 429, error: "Pediste demasiados códigos. Intenta en una hora o escríbenos por WhatsApp." };
  }

  const code = String(crypto.randomInt(0, 1000000)).padStart(6, "0");
  db.prepare(`
    INSERT INTO phone_otps (phone, code_hash, expires_at, attempts, last_sent_at, window_start, sends_in_window)
    VALUES (?, ?, ?, 0, ?, ?, ?)
    ON CONFLICT(phone) DO UPDATE SET code_hash = excluded.code_hash, expires_at = excluded.expires_at,
      attempts = 0, last_sent_at = excluded.last_sent_at, window_start = excluded.window_start,
      sends_in_window = excluded.sends_in_window
  `).run(phone, hashCode(phone, code), now + CODE_TTL_MS, now, windowFresh ? now : row.window_start, sends + 1);

  // Limpieza de paso: códigos vencidos hace más de un día ya no sirven ni
  // para el límite por hora.
  db.prepare("DELETE FROM phone_otps WHERE expires_at < ?").run(now - 24 * 60 * 60 * 1000);

  if (otpMode() === "simulado") {
    console.log(`[OTP simulado] ${phone} → ${code}`);
    return { ok: true, devCode: code };
  }
  try {
    await sendViaTwilio(e164, code);
    return { ok: true };
  } catch (e) {
    console.error("No se pudo mandar el código por WhatsApp:", e.message);
    // No cuenta como envío: que pueda reintentar sin esperar.
    db.prepare("UPDATE phone_otps SET last_sent_at = 0, sends_in_window = sends_in_window - 1 WHERE phone = ?").run(phone);
    return { status: 502, error: "No pudimos mandarte el código por WhatsApp. Revisa tu número o escríbenos." };
  }
}

// Revisa el código. Si es correcto lo borra (solo sirve una vez).
function verifyOtp(phone, code) {
  const row = db.prepare("SELECT * FROM phone_otps WHERE phone = ?").get(phone);
  if (!row) {
    return { status: 400, error: "Primero pide tu código por WhatsApp." };
  }
  if (row.expires_at < Date.now()) {
    return { status: 400, error: "Tu código venció. Pide uno nuevo." };
  }
  if (row.attempts >= MAX_WRONG_ATTEMPTS) {
    return { status: 429, error: "Demasiados intentos con este código. Pide uno nuevo." };
  }
  const given = typeof code === "string" ? code.trim() : "";
  const ok = /^\d{6}$/.test(given) &&
    crypto.timingSafeEqual(Buffer.from(hashCode(phone, given)), Buffer.from(row.code_hash));
  if (!ok) {
    db.prepare("UPDATE phone_otps SET attempts = attempts + 1 WHERE phone = ?").run(phone);
    return { status: 400, error: "Código incorrecto" };
  }
  db.prepare("DELETE FROM phone_otps WHERE phone = ?").run(phone);
  return { ok: true };
}

module.exports = { otpEnabled, otpMode, sendOtp, verifyOtp };
