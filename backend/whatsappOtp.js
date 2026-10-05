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
//   "verify"   → Twilio Verify genera, manda y revisa el código. Canal en
//                OTP_CHANNEL: "sms" (default, no depende de Meta) o
//                "whatsapp" (cuando Meta apruebe el número propio).
//                Con "verify" la persona también puede pedir el código por
//                llamada ("¿No te llegó? Recibir llamada"), por si el SMS se
//                le fue a spam o su compañía no se lo pasó.
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
  return ["simulado", "twilio", "verify"].includes(mode) ? mode : "off";
}

function otpEnabled() {
  return otpMode() !== "off";
}

function otpChannel() {
  return (process.env.OTP_CHANNEL || "sms").toLowerCase() === "whatsapp" ? "whatsapp" : "sms";
}

// Con TWILIO_API_KEY/TWILIO_API_SECRET (SK...) se puede cambiar el Auth Token
// de la cuenta sin tumbar la app; si no están, usa SID + Auth Token.
function twilioAuth() {
  const user = process.env.TWILIO_API_KEY || process.env.TWILIO_ACCOUNT_SID;
  const pass = process.env.TWILIO_API_KEY ? process.env.TWILIO_API_SECRET : process.env.TWILIO_AUTH_TOKEN;
  if (!user || !pass) throw new Error("Faltan variables de Twilio");
  return "Basic " + Buffer.from(`${user}:${pass}`).toString("base64");
}

async function verifyRequest(path, params) {
  const service = process.env.TWILIO_VERIFY_SID; // VA...
  if (!service) throw new Error("Falta TWILIO_VERIFY_SID");
  const res = await fetch(`https://verify.twilio.com/v2/Services/${service}/${path}`, {
    method: "POST",
    headers: { Authorization: twilioAuth(), "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(params),
  });
  const data = await res.json().catch(() => ({}));
  return { ok: res.ok, status: res.status, data };
}

function hashCode(phone, code) {
  return crypto.createHash("sha256").update(`${phone}:${code}`).digest("hex");
}

async function sendViaTwilio(e164, code) {
  const sid = process.env.TWILIO_ACCOUNT_SID;
  const from = process.env.TWILIO_WHATSAPP_FROM; // ej. +529991234567
  const contentSid = process.env.TWILIO_OTP_CONTENT_SID; // plantilla aprobada (HX...)
  if (!sid || !from || !contentSid) {
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
      Authorization: twilioAuth(),
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
// `wantCall`: la persona pidió el código por llamada (solo en modo verify o
// simulado; usa el mismo límite de reenvíos que el SMS).
// Regresa { ok, channel, devCode? } o { status, error }.
async function sendOtp(phone, e164, wantCall = false) {
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

  const call = wantCall && ["verify", "simulado"].includes(otpMode());
  if (otpMode() === "simulado") {
    console.log(`[OTP simulado${call ? " llamada" : ""}] ${phone} → ${code}`);
    return { ok: true, devCode: code, channel: call ? "call" : "whatsapp" };
  }
  try {
    if (otpMode() === "verify") {
      // Twilio genera su propio código; el nuestro (guardado arriba) nunca se
      // manda y solo sirve para llevar el límite de envíos e intentos.
      const channel = call ? "call" : otpChannel();
      // Locale "es": la voz de la llamada dicta el código en español.
      const r = await verifyRequest("Verifications", { To: e164, Channel: channel, Locale: "es" });
      if (!r.ok) throw new Error(`Verify ${r.status}: ${JSON.stringify(r.data)}`);
      return { ok: true, channel };
    }
    await sendViaTwilio(e164, code);
    return { ok: true, channel: "whatsapp" };
  } catch (e) {
    console.error("No se pudo mandar el código:", e.message);
    // No cuenta como envío: que pueda reintentar sin esperar.
    db.prepare("UPDATE phone_otps SET last_sent_at = 0, sends_in_window = sends_in_window - 1 WHERE phone = ?").run(phone);
    return { status: 502, error: "No pudimos mandarte el código. Revisa tu número o escríbenos." };
  }
}

// Revisa el código. Si es correcto lo borra (solo sirve una vez).
// `e164` solo hace falta en modo "verify" (Twilio revisa por número completo).
async function verifyOtp(phone, code, e164) {
  const row = db.prepare("SELECT * FROM phone_otps WHERE phone = ?").get(phone);
  if (!row) {
    return { status: 400, error: "Primero pide tu código." };
  }
  if (row.expires_at < Date.now()) {
    return { status: 400, error: "Tu código venció. Pide uno nuevo." };
  }
  if (row.attempts >= MAX_WRONG_ATTEMPTS) {
    return { status: 429, error: "Demasiados intentos con este código. Pide uno nuevo." };
  }
  const given = typeof code === "string" ? code.trim() : "";
  let ok;
  if (otpMode() === "verify") {
    if (!/^\d{4,10}$/.test(given)) {
      ok = false;
    } else {
      try {
        const r = await verifyRequest("VerificationCheck", { To: e164, Code: given });
        ok = r.ok && r.data.status === "approved";
      } catch (e) {
        console.error("No se pudo revisar el código con Twilio Verify:", e.message);
        return { status: 502, error: "No pudimos revisar tu código. Intenta de nuevo." };
      }
    }
  } else {
    ok = /^\d{6}$/.test(given) &&
      crypto.timingSafeEqual(Buffer.from(hashCode(phone, given)), Buffer.from(row.code_hash));
  }
  if (!ok) {
    db.prepare("UPDATE phone_otps SET attempts = attempts + 1 WHERE phone = ?").run(phone);
    return { status: 400, error: "Código incorrecto" };
  }
  db.prepare("DELETE FROM phone_otps WHERE phone = ?").run(phone);
  return { ok: true };
}

module.exports = { otpEnabled, otpMode, otpChannel, sendOtp, verifyOtp };
