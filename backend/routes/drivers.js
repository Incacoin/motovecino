const express = require("express");
const db = require("../db");
const { AVISO_LEGAL_VERSION, MAX_MATCH_DISTANCE_KM, SERVICE_CENTER, DRIVER_STALE_SECONDS, SERVICE_FEE, MONTHLY_FEE, TRIAL_END_DATE } = require("../constants");
const { haversineKm } = require("../geo");
const { isRateLimited, recordFailedAttempt, clearAttempts, RATE_LIMIT_MESSAGE, isSubmissionRateLimited, recordSubmission } = require("../pinRateLimit");
const MAX_APPLICATION_IMAGE_LENGTH = 900000;
const { DEFAULT_CITY_ID, getCityById } = require("../cities");

const router = express.Router();

// Fuente única de las cuotas para los 3 frontends (pasajero, chofer, admin)
// — evita que se desincronicen del valor real que se cobra.
router.get("/config", (req, res) => {
  res.json({ serviceFee: SERVICE_FEE, monthlyFee: MONTHLY_FEE });
});

// Choferes "disponibles" de verdad: con GPS reciente (no fantasmas de una
// sesión que se quedó abierta) y cerca de quien está mirando el mapa.
router.get("/drivers/available", (req, res) => {
  const type = req.query.type === "taxi" ? "taxi" : "moto";
  const refLat = Number(req.query.lat);
  const refLng = Number(req.query.lng);
  const hasRef = Number.isFinite(refLat) && Number.isFinite(refLng);
  const ref = hasRef ? { lat: refLat, lng: refLng } : SERVICE_CENTER;

  const drivers = db
    .prepare(
      `SELECT id, name, lat, lng, vehicle_type, photo FROM drivers
       WHERE status = 'disponible' AND lat IS NOT NULL AND lng IS NOT NULL AND deleted_at IS NULL
         AND vehicle_type = ?
         AND (cooldown_until IS NULL OR cooldown_until <= datetime('now'))
         AND last_seen >= datetime('now', '-${DRIVER_STALE_SECONDS} seconds')`
    )
    .all(type);

  const nearby = drivers.filter(
    (d) => haversineKm(ref.lat, ref.lng, d.lat, d.lng) <= MAX_MATCH_DISTANCE_KM
  );
  res.json(nearby);
});

// Insignia de "top chofer": los 3 con más viajes en los últimos 30 días,
// pero solo entre los que además tienen buena calificación — así no gana
// solo por volumen alguien con mala fama. Requiere mínimo de viajes y de
// calificaciones recibidas para no premiar una racha de suerte con 1-2 viajes.
router.get("/drivers/ranking", (req, res) => {
  const rows = db
    .prepare(
      `SELECT d.id, d.name,
              COUNT(r.id) AS trips,
              SUM(CASE WHEN r.rating = 1 THEN 1 ELSE 0 END) AS thumbsUp,
              SUM(CASE WHEN r.rating IS NOT NULL THEN 1 ELSE 0 END) AS ratedCount
       FROM drivers d
       JOIN rides r ON r.driver_id = d.id AND r.status = 'completado' AND date(r.updated_at) >= date('now', '-30 days')
       WHERE d.deleted_at IS NULL
       GROUP BY d.id
       HAVING trips >= 5 AND ratedCount >= 3 AND (thumbsUp * 1.0 / ratedCount) >= 0.8
       ORDER BY trips DESC, (thumbsUp * 1.0 / ratedCount) DESC
       LIMIT 3`
    )
    .all();

  res.json(
    rows.map((r, i) => ({
      id: r.id,
      name: r.name,
      rank: i + 1,
      trips: r.trips,
      ratingPct: Math.round((r.thumbsUp / r.ratedCount) * 100),
    }))
  );
});

router.post("/drivers/login", (req, res) => {
  if (isRateLimited(req.ip)) {
    return res.status(429).json({ error: RATE_LIMIT_MESSAGE });
  }
  const { pin } = req.body;
  const driver = db
    .prepare(
      "SELECT id, name, phone, vehicle, vehicle_type, status, cooldown_until FROM drivers WHERE pin = ? AND deleted_at IS NULL"
    )
    .get(pin);

  if (!driver) {
    recordFailedAttempt(req.ip);
    return res.status(404).json({ error: "PIN no encontrado" });
  }
  clearAttempts(req.ip);

  const { count: todayCount } = db
    .prepare(
      "SELECT COUNT(*) as count FROM rides WHERE driver_id = ? AND status = 'completado' AND date(updated_at) = date('now')"
    )
    .get(driver.id);

  const { count: lifetimeTrips } = db
    .prepare(
      "SELECT COUNT(*) as count FROM rides WHERE driver_id = ? AND status = 'completado'"
    )
    .get(driver.id);

  res.json({ ...driver, todayCount, lifetimeTrips });
});

// Pantalla "Mi perfil" del chofer. Se autentica igual que el login: con su
// propio PIN — nunca con un id que mande el cliente, para que nadie pueda
// pedir el perfil (ni el estado de cuenta) de otro chofer.
router.post("/drivers/profile", (req, res) => {
  if (isRateLimited(req.ip)) {
    return res.status(429).json({ error: RATE_LIMIT_MESSAGE });
  }
  const { pin } = req.body;
  const driver = db
    .prepare(
      `SELECT id, name, phone, vehicle, vehicle_type, grupo, photo, tipo, pin, created_at,
              paid_until, cancel_count
       FROM drivers WHERE pin = ? AND deleted_at IS NULL`
    )
    .get(pin);

  if (!driver) {
    recordFailedAttempt(req.ip);
    return res.status(404).json({ error: "PIN no encontrado" });
  }
  clearAttempts(req.ip);

  const stats = db
    .prepare(
      `SELECT COUNT(*) AS lifetimeTrips,
              SUM(CASE WHEN date(updated_at) >= date('now', 'start of month') THEN 1 ELSE 0 END) AS tripsMonth,
              SUM(CASE WHEN rating = 1 THEN 1 ELSE 0 END) AS thumbsUp,
              SUM(CASE WHEN rating IS NOT NULL THEN 1 ELSE 0 END) AS ratedCount
       FROM rides WHERE driver_id = ? AND status = 'completado'`
    )
    .get(driver.id);

  const lastPayment = db
    .prepare(
      "SELECT amount, paid_at FROM driver_payments WHERE driver_id = ? ORDER BY paid_at DESC LIMIT 1"
    )
    .get(driver.id);

  // Viajes completados que todavía no se le han cobrado los $2 de servicio.
  // En un pueblo sin cuota por viaje (SERVICE_FEE = 0) esta sección ni existe,
  // y su tabla `rides` puede no tener la columna `fee_settled_at`.
  const pendingRides = SERVICE_FEE
    ? db
        .prepare(
          "SELECT COUNT(*) AS count FROM rides WHERE driver_id = ? AND status = 'completado' AND fee_settled_at IS NULL"
        )
        .get(driver.id).count
    : 0;

  res.json({
    id: driver.id,
    name: driver.name,
    phone: driver.phone,
    vehicle: driver.vehicle,
    vehicleType: driver.vehicle_type,
    grupo: driver.grupo,
    photo: driver.photo,
    pin: driver.pin,
    createdAt: driver.created_at,
    cancelCount: driver.cancel_count,
    lifetimeTrips: stats.lifetimeTrips || 0,
    tripsMonth: stats.tripsMonth || 0,
    ratedCount: stats.ratedCount || 0,
    ratingPct: stats.ratedCount ? Math.round((stats.thumbsUp / stats.ratedCount) * 100) : null,
    paidUntil: driver.paid_until,
    lastPayment: lastPayment || null,
    monthlyFee: MONTHLY_FEE,
    trialEndDate: TRIAL_END_DATE,
    pendingRides,
    pendingRidesAmount: pendingRides * SERVICE_FEE,
    serviceFee: SERVICE_FEE,
  });
});

// La foto es lo único que el chofer puede cambiar de su propio perfil.
// Nombre, placa, agrupación y tipo de vehículo los avaló su líder y solo se
// tocan desde el admin — si el chofer pudiera cambiarlos, el aval no valdría.
router.post("/drivers/photo", (req, res) => {
  if (isRateLimited(req.ip)) {
    return res.status(429).json({ error: RATE_LIMIT_MESSAGE });
  }
  const { pin, photo } = req.body;
  const driver = db
    .prepare("SELECT id FROM drivers WHERE pin = ? AND deleted_at IS NULL")
    .get(pin);

  if (!driver) {
    recordFailedAttempt(req.ip);
    return res.status(404).json({ error: "PIN no encontrado" });
  }
  clearAttempts(req.ip);
  if (typeof photo !== "string" || !/^data:image\/(jpeg|png|webp);base64,/.test(photo)) {
    return res.status(400).json({ error: "Foto inválida" });
  }
  if (photo.length > 900000) {
    return res.status(413).json({ error: "La foto pesa demasiado, intenta con otra" });
  }

  db.prepare("UPDATE drivers SET photo = ? WHERE id = ?").run(photo, driver.id);
  res.json({ ok: true });
});

router.post("/chofer-solicitudes", (req, res) => {
  if (isSubmissionRateLimited(req.ip)) {
    return res.status(429).json({ error: RATE_LIMIT_MESSAGE });
  }
  const {
    name, phone, photo, photoPlaca, acceptedLegal, signature, vehicleType, grupo, viaLiderLink, formalIntent, city,
    emergencyContactName, emergencyContactPhone, referredBy,
  } = req.body;
  for (const img of [photo, photoPlaca, signature]) {
    if (typeof img === "string" && img.length > MAX_APPLICATION_IMAGE_LENGTH) {
      return res.status(413).json({ error: "Una de las fotos pesa demasiado, intenta con otra" });
    }
  }
  const cityId = getCityById(city) ? city : DEFAULT_CITY_ID;
  // Ticul aun corre en su propio servidor aparte de este backend unificado;
  // una solicitud etiquetada "ticul" aqui no le llegaria a ningun admin.
  if (cityId === "ticul") {
    return res.status(400).json({ error: "Ticul todavía no está disponible en este formulario" });
  }
  if (!name || !phone || !photo) {
    return res.status(400).json({ error: "Falta nombre, teléfono o foto" });
  }
  if (!emergencyContactName || !emergencyContactPhone) {
    return res.status(400).json({ error: "Falta el contacto de emergencia" });
  }
  if (!acceptedLegal) {
    return res.status(400).json({ error: "Debes aceptar el aviso legal para continuar" });
  }
  // La firma en pantalla es la evidencia de que el chofer aceptó el Contrato
  // de Prestación de Servicios, no solo el aviso legal (checkbox) — el
  // contador la pidió como respaldo adicional, distinto del aviso legal.
  if (typeof signature !== "string" || !/^data:image\/png;base64,/.test(signature)) {
    return res.status(400).json({ error: "Falta tu firma" });
  }

  // Ya no hay gremios ni líderes que avalen a nadie — todo chofer que aplica
  // entra por su cuenta, así que la segunda foto (chofer con su moto, para
  // verificación interna del admin) se exige siempre, sin importar tipo.
  const grupoLimpio = typeof grupo === "string" ? grupo.trim().slice(0, 60) : "";
  const tipo = formalIntent ? "formal" : "informal";

  if (!photoPlaca) {
    return res.status(400).json({ error: "Falta la foto de ti con tu moto" });
  }

  db.prepare(
    "INSERT INTO driver_applications (name, phone, photo, photo_placa, accepted_legal_at, accepted_legal_version, vehicle_type, grupo, tipo, signature, city, emergency_contact_name, emergency_contact_phone, referred_by) VALUES (?, ?, ?, ?, datetime('now'), ?, ?, ?, ?, ?, ?, ?, ?, ?)"
  ).run(
    name, phone, photo, photoPlaca || null, AVISO_LEGAL_VERSION, vehicleType === "taxi" ? "taxi" : "moto", grupoLimpio || null, tipo, signature, cityId,
    emergencyContactName.trim().slice(0, 80), emergencyContactPhone.trim().slice(0, 20),
    typeof referredBy === "string" ? referredBy.trim().slice(0, 80) || null : null
  );
  recordSubmission(req.ip);
  res.status(201).json({ ok: true });
});

module.exports = router;
