const express = require("express");
const db = require("../db");
const { isRateLimited, recordFailedAttempt, clearAttempts, RATE_LIMIT_MESSAGE } = require("../pinRateLimit");
const { photoUrls, cleanThumb } = require("../photos");

const router = express.Router();

function generateRiderPin() {
  let pin;
  do {
    pin = String(Math.floor(1000 + Math.random() * 9000));
  } while (db.prepare("SELECT id FROM riders WHERE pin = ?").get(pin));
  return pin;
}

// Da de alta un teléfono nuevo (le genera PIN) o, si ese teléfono ya tiene
// cuenta, lo rechaza con 409 — el frontend entonces le pide su PIN en vez de
// dejarlo re-registrarse con un nombre distinto. Así deja de ser "cualquiera
// escribe cualquier teléfono": una vez que un número tiene PIN, hace falta
// para volver a usarlo.
router.post("/riders/register", (req, res) => {
  const { name, phone } = req.body;
  if (!name || !phone || phone.length !== 10) {
    return res.status(400).json({ error: "Falta nombre o teléfono válido" });
  }

  const existing = db.prepare("SELECT id, pin FROM riders WHERE phone = ?").get(phone);

  if (existing && existing.pin) {
    return res.status(409).json({ error: "Ese teléfono ya tiene cuenta" });
  }

  const pin = generateRiderPin();

  if (existing) {
    // Rider de antes de que existiera el PIN (dato viejo) — se lo asignamos
    // ahora, de una vez, en vez de dejarlo sin dueño para siempre.
    db.prepare("UPDATE riders SET name = ?, pin = ? WHERE id = ?").run(name, pin, existing.id);
    return res.status(200).json({ id: existing.id, name, phone, pin, isNewPin: true });
  }

  const result = db
    .prepare("INSERT INTO riders (phone, name, pin, created_at) VALUES (?, ?, ?, datetime('now'))")
    .run(phone, name, pin);
  res.status(201).json({ id: result.lastInsertRowid, name, phone, pin, isNewPin: true });
});

router.post("/riders/:id/update-name", (req, res) => {
  if (isRateLimited(req.ip)) {
    return res.status(429).json({ error: RATE_LIMIT_MESSAGE });
  }
  const { phone, pin, name } = req.body;
  if (!name || !name.trim()) {
    return res.status(400).json({ error: "Falta nombre" });
  }
  const rider = db
    .prepare("SELECT id FROM riders WHERE id = ? AND phone = ? AND pin = ?")
    .get(req.params.id, phone, pin);
  if (!rider) {
    recordFailedAttempt(req.ip);
    return res.status(404).json({ error: "No autorizado" });
  }
  clearAttempts(req.ip);
  const trimmed = name.trim();
  db.prepare("UPDATE riders SET name = ? WHERE id = ?").run(trimmed, rider.id);
  res.json({ id: rider.id, name: trimmed, phone, pin });
});

router.post("/riders/:id/change-pin", (req, res) => {
  if (isRateLimited(req.ip)) {
    return res.status(429).json({ error: RATE_LIMIT_MESSAGE });
  }
  const { phone, pin } = req.body;
  const rider = db
    .prepare("SELECT id FROM riders WHERE id = ? AND phone = ? AND pin = ?")
    .get(req.params.id, phone, pin);
  if (!rider) {
    recordFailedAttempt(req.ip);
    return res.status(404).json({ error: "No autorizado" });
  }
  clearAttempts(req.ip);
  const newPin = generateRiderPin();
  db.prepare("UPDATE riders SET pin = ? WHERE id = ?").run(newPin, rider.id);
  res.json({ id: rider.id, pin: newPin });
});

router.post("/riders/login", (req, res) => {
  if (isRateLimited(req.ip)) {
    return res.status(429).json({ error: RATE_LIMIT_MESSAGE });
  }
  const { phone, pin } = req.body;
  const rider = db
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
router.post("/riders/:id/photo", (req, res) => {
  if (isRateLimited(req.ip)) {
    return res.status(429).json({ error: RATE_LIMIT_MESSAGE });
  }
  const { phone, pin, photo, thumb } = req.body;
  const rider = db
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

  db.prepare("UPDATE riders SET photo = ?, photo_thumb = ? WHERE id = ?").run(photo, cleanThumb(thumb), rider.id);
  res.json({ ok: true });
});

// "Casa" del pasajero: un solo lugar guardado para no escribir la dirección
// de cero en cada mandado/viaje repetido. clear:true la borra; si no, exige
// lat/lng numéricos (el label es opcional, ej. "casa azul, portón negro").
router.post("/riders/:id/home", (req, res) => {
  if (isRateLimited(req.ip)) {
    return res.status(429).json({ error: RATE_LIMIT_MESSAGE });
  }
  const { phone, pin, lat, lng, label, clear } = req.body;
  const rider = db
    .prepare("SELECT id FROM riders WHERE id = ? AND phone = ? AND pin = ?")
    .get(req.params.id, phone, pin);
  if (!rider) {
    recordFailedAttempt(req.ip);
    return res.status(404).json({ error: "No autorizado" });
  }
  clearAttempts(req.ip);

  if (clear) {
    db.prepare(
      "UPDATE riders SET home_lat = NULL, home_lng = NULL, home_label = NULL WHERE id = ?"
    ).run(rider.id);
    return res.json({ ok: true });
  }

  if (typeof lat !== "number" || typeof lng !== "number") {
    return res.status(400).json({ error: "Faltan coordenadas" });
  }
  const cleanLabel = typeof label === "string" ? label.trim().slice(0, 200) : null;
  db.prepare(
    "UPDATE riders SET home_lat = ?, home_lng = ?, home_label = ? WHERE id = ?"
  ).run(lat, lng, cleanLabel || null, rider.id);
  res.json({ ok: true, lat, lng, label: cleanLabel || null });
});

// Contacto de emergencia: un solo número guardado para el botón "Avisar" del
// viaje activo. clear:true lo borra; si no, exige un teléfono con al menos
// 8 dígitos (el nombre es opcional, solo para personalizar el mensaje).
router.post("/riders/:id/emergency-contact", (req, res) => {
  if (isRateLimited(req.ip)) {
    return res.status(429).json({ error: RATE_LIMIT_MESSAGE });
  }
  const { phone, pin, name, contactPhone, clear } = req.body;
  const rider = db
    .prepare("SELECT id FROM riders WHERE id = ? AND phone = ? AND pin = ?")
    .get(req.params.id, phone, pin);
  if (!rider) {
    recordFailedAttempt(req.ip);
    return res.status(404).json({ error: "No autorizado" });
  }
  clearAttempts(req.ip);

  if (clear) {
    db.prepare(
      "UPDATE riders SET emergency_contact_name = NULL, emergency_contact_phone = NULL WHERE id = ?"
    ).run(rider.id);
    return res.json({ ok: true });
  }

  const digits = typeof contactPhone === "string" ? contactPhone.replace(/\D/g, "") : "";
  if (digits.length < 8 || digits.length > 15) {
    return res.status(400).json({ error: "Escribe un teléfono válido" });
  }
  const cleanName = typeof name === "string" ? name.trim().slice(0, 100) : null;
  db.prepare(
    "UPDATE riders SET emergency_contact_name = ?, emergency_contact_phone = ? WHERE id = ?"
  ).run(cleanName || null, digits, rider.id);
  res.json({ ok: true, name: cleanName || null, contactPhone: digits });
});

module.exports = router;
module.exports.generateRiderPin = generateRiderPin;
