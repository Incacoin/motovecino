const express = require("express");
const db = require("../db");
const { isRateLimited, recordFailedAttempt, clearAttempts, RATE_LIMIT_MESSAGE, isSubmissionRateLimited, recordSubmission } = require("../pinRateLimit");
const { photoUrls, cleanThumb } = require("../photos");
const { toStored } = require("../imageStore");
const { otpEnabled, sendOtp, verifyOtp, sendWelcome } = require("../whatsappOtp");
const { parseRiderPhone } = require("../phone");
const { rideCityAt } = require("../cities");

const router = express.Router();

// Los ids son números: algo como /x/abc/... se contesta "no encontrado" (como
// antes con SQLite) en vez de un error de Postgres por el tipo de dato.
const numericParam = (req, res, next, value) => (/^\d{1,9}$/.test(value) ? next() : res.status(404).json({ error: "No encontrado" }));
router.param("id", numericParam);

async function generateRiderPin() {
  let pin;
  do {
    pin = String(Math.floor(1000 + Math.random() * 9000));
  } while (await db.prepare("SELECT id FROM riders WHERE pin = ?").get(pin));
  return pin;
}

// Primer paso del registro: manda el código de verificación por WhatsApp.
// Si el teléfono ya tiene cuenta responde 409 (igual que /riders/register)
// para que el frontend pida el PIN en vez de mandar un código. Con OTP_MODE
// en "off" responde required:false y el frontend registra directo.
router.post("/riders/otp/send", async (req, res) => {
  const parsed = parseRiderPhone(req.body.phone);
  if (!parsed) {
    return res.status(400).json({ error: "Revisa tu teléfono (le faltan o sobran números)" });
  }
  const { phone } = parsed;
  const existing = await db.prepare("SELECT pin FROM riders WHERE phone = ?").get(phone);
  if (existing && existing.pin) {
    return res.status(409).json({ error: "Ese teléfono ya tiene cuenta" });
  }
  if (!otpEnabled()) {
    return res.json({ required: false });
  }
  if (isSubmissionRateLimited(req.ip)) {
    return res.status(429).json({ error: RATE_LIMIT_MESSAGE });
  }
  const result = await sendOtp(phone, parsed.e164, req.body.channel === "call", req.body.deviceId);
  if (!result.ok) {
    return res.status(result.status).json({ error: result.error, retryIn: result.retryIn });
  }
  recordSubmission(req.ip);
  res.json({ required: true, channel: result.channel, ...(result.devCode ? { devCode: result.devCode } : {}) });
});

// Da de alta un teléfono nuevo (le genera PIN) o, si ese teléfono ya tiene
// cuenta, lo rechaza con 409 — el frontend entonces le pide su PIN en vez de
// dejarlo re-registrarse con un nombre distinto. Así deja de ser "cualquiera
// escribe cualquier teléfono": una vez que un número tiene PIN, hace falta
// para volver a usarlo.
router.post("/riders/register", async (req, res) => {
  // A diferencia de las demás rutas de este archivo, esta es pública (nadie
  // ha probado PIN todavía) — sin este límite, un script podía crear cuentas
  // sin parar. Mismo contador que ya usa /chofer-solicitudes.
  if (isSubmissionRateLimited(req.ip)) {
    return res.status(429).json({ error: RATE_LIMIT_MESSAGE });
  }
  const { name } = req.body;
  const parsed = parseRiderPhone(req.body.phone);
  const phone = parsed && parsed.phone;
  if (typeof name !== "string" || !name.trim() || !parsed) {
    return res.status(400).json({ error: "Falta nombre o teléfono válido" });
  }

  const existing = await db.prepare("SELECT id, pin FROM riders WHERE phone = ?").get(phone);

  if (existing && existing.pin) {
    return res.status(409).json({ error: "Ese teléfono ya tiene cuenta" });
  }

  if (otpEnabled()) {
    // El envío del código ya contó para el límite por IP (ver /riders/otp/send).
    const check = await verifyOtp(phone, req.body.code, parsed.e164);
    if (!check.ok) return res.status(check.status).json({ error: check.error });
  } else {
    recordSubmission(req.ip);
  }

  const pin = await generateRiderPin();
  // Cajón de la cuenta nueva: el municipio donde está el celular al
  // registrarse (sin GPS, Tekax como siempre). Al pedir su primer viaje se
  // vuelve a acomodar según la recogida (ver rides.js).
  const lat = Number(req.body.lat);
  const lng = Number(req.body.lng);
  const city = Number.isFinite(lat) && Number.isFinite(lng) && req.body.lat != null && req.body.lng != null
    ? rideCityAt(lat, lng)
    : "tekax";

  if (existing) {
    // Rider de antes de que existiera el PIN (dato viejo) — se lo asignamos
    // ahora, de una vez, en vez de dejarlo sin dueño para siempre.
    await db.prepare("UPDATE riders SET name = ?, pin = ?, city = ? WHERE id = ?").run(name, pin, city, existing.id);
    sendWelcome(parsed.e164, name);
    return res.status(200).json({ id: existing.id, name, phone, pin, isNewPin: true });
  }

  const result = await db
    .prepare("INSERT INTO riders (phone, name, pin, city, created_at) VALUES (?, ?, ?, ?, datetime('now'))")
    .run(phone, name, pin, city);
  // Sin await: el WhatsApp de bienvenida no hace esperar a la persona.
  sendWelcome(parsed.e164, name);
  res.status(201).json({ id: result.lastInsertRowid, name, phone, pin, isNewPin: true });
});

router.post("/riders/:id/update-name", async (req, res) => {
  if (isRateLimited(req.ip)) {
    return res.status(429).json({ error: RATE_LIMIT_MESSAGE });
  }
  const { phone, pin, name } = req.body;
  if (!name || !name.trim()) {
    return res.status(400).json({ error: "Falta nombre" });
  }
  const rider = await db
    .prepare("SELECT id FROM riders WHERE id = ? AND phone = ? AND pin = ?")
    .get(req.params.id, phone, pin);
  if (!rider) {
    recordFailedAttempt(req.ip);
    return res.status(404).json({ error: "No autorizado" });
  }
  clearAttempts(req.ip);
  const trimmed = name.trim();
  await db.prepare("UPDATE riders SET name = ? WHERE id = ?").run(trimmed, rider.id);
  res.json({ id: rider.id, name: trimmed, phone, pin });
});

router.post("/riders/:id/change-pin", async (req, res) => {
  if (isRateLimited(req.ip)) {
    return res.status(429).json({ error: RATE_LIMIT_MESSAGE });
  }
  const { phone, pin } = req.body;
  const rider = await db
    .prepare("SELECT id FROM riders WHERE id = ? AND phone = ? AND pin = ?")
    .get(req.params.id, phone, pin);
  if (!rider) {
    recordFailedAttempt(req.ip);
    return res.status(404).json({ error: "No autorizado" });
  }
  clearAttempts(req.ip);
  const newPin = await generateRiderPin();
  await db.prepare("UPDATE riders SET pin = ? WHERE id = ?").run(newPin, rider.id);
  res.json({ id: rider.id, pin: newPin });
});

router.post("/riders/login", async (req, res) => {
  if (isRateLimited(req.ip)) {
    return res.status(429).json({ error: RATE_LIMIT_MESSAGE });
  }
  const { phone, pin } = req.body || {};
  if (!phone || !pin) {
    return res.status(400).json({ error: "Falta teléfono o PIN" });
  }
  const rider = await db
    .prepare(
      "SELECT id, name, phone, pin, photo, home_lat, home_lng, home_label, emergency_contact_name, emergency_contact_phone FROM riders WHERE phone = ? AND pin = ?"
    )
    .get(phone, pin);

  if (!rider) {
    recordFailedAttempt(req.ip);
    return res.status(404).json({ error: "Teléfono o PIN incorrectos" });
  }
  clearAttempts(req.ip);
  res.json({ ...rider, ...photoUrls("r", rider.id, rider.photo) });
});

// La foto es lo único que el pasajero puede cambiar de su propio perfil, igual
// que con el chofer (ver routes/drivers.js) — mismo límite de tamaño y mismo
// formato esperado (data URL ya recortada/comprimida por el navegador).
router.post("/riders/:id/photo", async (req, res) => {
  if (isRateLimited(req.ip)) {
    return res.status(429).json({ error: RATE_LIMIT_MESSAGE });
  }
  const { phone, pin, photo, thumb } = req.body;
  const rider = await db
    .prepare("SELECT id FROM riders WHERE id = ? AND phone = ? AND pin = ?")
    .get(req.params.id, phone, pin);
  if (!rider) {
    recordFailedAttempt(req.ip);
    return res.status(404).json({ error: "No autorizado" });
  }
  clearAttempts(req.ip);
  if (typeof photo !== "string" || !/^data:image\/(jpeg|png|webp);base64,/.test(photo)) {
    return res.status(400).json({ error: "Foto inválida" });
  }
  if (photo.length > 900000) {
    return res.status(413).json({ error: "La foto pesa demasiado, intenta con otra" });
  }

  await db.prepare("UPDATE riders SET photo = ?, photo_thumb = ? WHERE id = ?").run(toStored(photo), toStored(cleanThumb(thumb)), rider.id);
  res.json({ ok: true });
});

// "Casa" del pasajero: un solo lugar guardado para no escribir la dirección
// de cero en cada mandado/viaje repetido. clear:true la borra; si no, exige
// lat/lng numéricos (el label es opcional, ej. "casa azul, portón negro").
router.post("/riders/:id/home", async (req, res) => {
  if (isRateLimited(req.ip)) {
    return res.status(429).json({ error: RATE_LIMIT_MESSAGE });
  }
  const { phone, pin, lat, lng, label, clear } = req.body;
  const rider = await db
    .prepare("SELECT id FROM riders WHERE id = ? AND phone = ? AND pin = ?")
    .get(req.params.id, phone, pin);
  if (!rider) {
    recordFailedAttempt(req.ip);
    return res.status(404).json({ error: "No autorizado" });
  }
  clearAttempts(req.ip);

  if (clear) {
    await db.prepare(
      "UPDATE riders SET home_lat = NULL, home_lng = NULL, home_label = NULL WHERE id = ?"
    ).run(rider.id);
    return res.json({ ok: true });
  }

  if (typeof lat !== "number" || typeof lng !== "number") {
    return res.status(400).json({ error: "Faltan coordenadas" });
  }
  const cleanLabel = typeof label === "string" ? label.trim().slice(0, 200) : null;
  await db.prepare(
    "UPDATE riders SET home_lat = ?, home_lng = ?, home_label = ? WHERE id = ?"
  ).run(lat, lng, cleanLabel || null, rider.id);
  res.json({ ok: true, lat, lng, label: cleanLabel || null });
});

// Contacto de emergencia: un solo número guardado para el botón "Avisar" del
// viaje activo. clear:true lo borra; si no, exige un teléfono con al menos
// 8 dígitos (el nombre es opcional, solo para personalizar el mensaje).
router.post("/riders/:id/emergency-contact", async (req, res) => {
  if (isRateLimited(req.ip)) {
    return res.status(429).json({ error: RATE_LIMIT_MESSAGE });
  }
  const { phone, pin, name, contactPhone, clear } = req.body;
  const rider = await db
    .prepare("SELECT id FROM riders WHERE id = ? AND phone = ? AND pin = ?")
    .get(req.params.id, phone, pin);
  if (!rider) {
    recordFailedAttempt(req.ip);
    return res.status(404).json({ error: "No autorizado" });
  }
  clearAttempts(req.ip);

  if (clear) {
    await db.prepare(
      "UPDATE riders SET emergency_contact_name = NULL, emergency_contact_phone = NULL WHERE id = ?"
    ).run(rider.id);
    return res.json({ ok: true });
  }

  const digits = typeof contactPhone === "string" ? contactPhone.replace(/\D/g, "") : "";
  if (digits.length < 8 || digits.length > 15) {
    return res.status(400).json({ error: "Escribe un teléfono válido" });
  }
  const cleanName = typeof name === "string" ? name.trim().slice(0, 100) : null;
  await db.prepare(
    "UPDATE riders SET emergency_contact_name = ?, emergency_contact_phone = ? WHERE id = ?"
  ).run(cleanName || null, digits, rider.id);
  res.json({ ok: true, name: cleanName || null, contactPhone: digits });
});

module.exports = router;
module.exports.generateRiderPin = generateRiderPin;
