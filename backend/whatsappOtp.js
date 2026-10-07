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

// Tabla phone_otps: ver schema.sql.

// Candados contra gastar códigos de más (cada uno cuesta). Ver otp_daily y
// otp_devices en schema.sql.
// - Toda la app: OTP_DAILY_CAP al día (20 de arranque; se sube con la
//   variable de Render el día que haya reclutamiento).
// - Por celular: MAX_PHONES_PER_DEVICE números distintos al día.
const MAX_PHONES_PER_DEVICE = 3;
const HELP_TEXT = "Escríbenos por WhatsApp al 997 973 9422 y te ayudamos.";

function otpDailyCap() {
  const n = parseInt(process.env.OTP_DAILY_CAP, 10);
  return Number.isFinite(n) && n > 0 ? n : 20;
}

// Día en hora de Yucatán (el contador se reinicia a medianoche de aquí).
function todayYucatan() {
  return new Date().toLocaleDateString("en-CA", { timeZone: "America/Merida" });
}

// Aparta un envío del tope del día. false = ya se llegó al tope.
async function reserveDailySend() {
  const day = todayYucatan();
  await db.prepare("INSERT INTO otp_daily (day, sends) VALUES (?, 0) ON CONFLICT(day) DO NOTHING").run(day);
  const r = await db.prepare("UPDATE otp_daily SET sends = sends + 1 WHERE day = ? AND sends < ?").run(day, otpDailyCap());
  return r.changes > 0;
}

async function releaseDailySend() {
  await db.prepare("UPDATE otp_daily SET sends = sends - 1 WHERE day = ? AND sends > 0").run(todayYucatan());
}

// Para el admin: cuántos van hoy y cuál es el tope.
async function otpDailyStatus() {
  const row = await db.prepare("SELECT sends FROM otp_daily WHERE day = ?").get(todayYucatan());
  return { sent: row ? row.sends : 0, cap: otpDailyCap() };
}

// ¿Este celular puede pedir código para este número? Sin deviceId (versión
// vieja de la página en caché) no se revisa: queda el tope del día.
async function deviceAllows(deviceId, phone) {
  if (!deviceId) return true;
  const day = todayYucatan();
  const rows = await db.prepare("SELECT phone FROM otp_devices WHERE device_id = ? AND day = ?").all(deviceId, day);
  if (rows.some((r) => r.phone === phone)) return true;
  if (rows.length >= MAX_PHONES_PER_DEVICE) return false;
  await db.prepare("INSERT INTO otp_devices (device_id, day, phone) VALUES (?, ?, ?) ON CONFLICT DO NOTHING").run(deviceId, day, phone);
  return true;
}

function cleanDeviceId(v) {
  return typeof v === "string" && /^[A-Za-z0-9-]{8,64}$/.test(v) ? v : null;
}

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
async function sendOtp(phone, e164, wantCall = false, deviceId = null) {
  const now = Date.now();
  const row = await db.prepare("SELECT * FROM phone_otps WHERE phone = ?").get(phone);

  if (row && now - row.last_sent_at < RESEND_COOLDOWN_MS) {
    const wait = Math.ceil((RESEND_COOLDOWN_MS - (now - row.last_sent_at)) / 1000);
    return { status: 429, error: `Espera ${wait} segundos para pedir otro código`, retryIn: wait };
  }
  const windowFresh = !row || now - row.window_start > 60 * 60 * 1000;
  const sends = windowFresh ? 0 : row.sends_in_window;
  if (sends >= MAX_SENDS_PER_HOUR) {
    return { status: 429, error: "Pediste demasiados códigos. Intenta en una hora o escríbenos por WhatsApp." };
  }
  if (!(await deviceAllows(cleanDeviceId(deviceId), phone))) {
    return { status: 429, error: "Desde este celular ya se pidieron códigos para varios números hoy. " + HELP_TEXT };
  }
  if (!(await reserveDailySend())) {
    console.warn(`[OTP] Se llegó al tope de ${otpDailyCap()} códigos de hoy`);
    return { status: 429, error: "Por hoy no podemos mandar más códigos. " + HELP_TEXT, capReached: true };
  }

  const code = String(crypto.randomInt(0, 1000000)).padStart(6, "0");
  // Solo se guarda si nadie más mandó un código a este teléfono desde que lo
  // leímos arriba (last_sent_at sigue igual): dos toques al mismo tiempo en
  // "Mandar código" ya no mandan (ni cobran) dos mensajes.
  const saved = await db.prepare(`
    INSERT INTO phone_otps (phone, code_hash, expires_at, attempts, last_sent_at, window_start, sends_in_window)
    VALUES (?, ?, ?, 0, ?, ?, ?)
    ON CONFLICT(phone) DO UPDATE SET code_hash = excluded.code_hash, expires_at = excluded.expires_at,
      attempts = 0, last_sent_at = excluded.last_sent_at, window_start = excluded.window_start,
      sends_in_window = excluded.sends_in_window
    WHERE phone_otps.last_sent_at = ?
  `).run(phone, hashCode(phone, code), now + CODE_TTL_MS, now, windowFresh ? now : row.window_start, sends + 1, row ? row.last_sent_at : -1);
  if (saved.changes === 0) {
    await releaseDailySend();
    return { status: 429, error: "Espera unos segundos para pedir otro código", retryIn: 60 };
  }

  // Limpieza de paso: códigos vencidos hace más de un día ya no sirven ni
  // para el límite por hora.
  await db.prepare("DELETE FROM phone_otps WHERE expires_at < ?").run(now - 24 * 60 * 60 * 1000);

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
    await db.prepare("UPDATE phone_otps SET last_sent_at = 0, sends_in_window = sends_in_window - 1 WHERE phone = ?").run(phone);
    await releaseDailySend();
    return { status: 502, error: "No pudimos mandarte el código. Revisa tu número o escríbenos." };
  }
}

// Revisa el código. Si es correcto lo borra (solo sirve una vez).
// `e164` solo hace falta en modo "verify" (Twilio revisa por número completo).
async function verifyOtp(phone, code, e164) {
  const row = await db.prepare("SELECT * FROM phone_otps WHERE phone = ?").get(phone);
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
    await db.prepare("UPDATE phone_otps SET attempts = attempts + 1 WHERE phone = ?").run(phone);
    return { status: 400, error: "Código incorrecto" };
  }
  await db.prepare("DELETE FROM phone_otps WHERE phone = ?").run(phone);
  return { ok: true };
}

// Bienvenida por WhatsApp al terminar el registro (plantilla de utilidad
// aprobada, TWILIO_WELCOME_CONTENT_SID = HX...). Solo en modo "twilio": ahí la
// persona acaba de recibir su código por WhatsApp, así que sí tiene WhatsApp.
// Sin la variable no se manda nada. Nunca frena el registro: si falla, solo
// queda en el log.
function welcomeName(name) {
  // Meta no acepta saltos de línea ni muchos espacios en una variable.
  const first = String(name || "").replace(/[\s\u0000-\u001f]+/g, " ").trim().split(" ")[0] || "";
  return first.slice(0, 30) || "vecino";
}

async function sendWelcome(e164, name) {
  const contentSid = process.env.TWILIO_WELCOME_CONTENT_SID;
  const sid = process.env.TWILIO_ACCOUNT_SID;
  const from = process.env.TWILIO_WHATSAPP_FROM;
  if (otpMode() !== "twilio" || !contentSid || !sid || !from) return;
  try {
    const res = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${sid}/Messages.json`, {
      method: "POST",
      headers: { Authorization: twilioAuth(), "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        From: `whatsapp:${from}`,
        To: `whatsapp:${e164}`,
        ContentSid: contentSid,
        ContentVariables: JSON.stringify({ 1: welcomeName(name) }),
      }),
    });
    if (!res.ok) console.error("No se pudo mandar la bienvenida:", res.status, await res.text());
  } catch (e) {
    console.error("No se pudo mandar la bienvenida:", e.message);
  }
}

module.exports = { otpEnabled, otpMode, otpChannel, sendOtp, verifyOtp, sendWelcome, welcomeName, otpDailyStatus };
