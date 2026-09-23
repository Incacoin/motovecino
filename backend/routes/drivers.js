const express = require("express");
const db = require("../db");
const { AVISO_LEGAL_VERSION, MAX_MATCH_DISTANCE_KM, MAX_MATCH_DISTANCE_KM_TAXI, DRIVER_STALE_SECONDS, SERVICE_FEE, TAXI_COMMISSION_RATE, TAXI_COMMISSION_CAP, TAXI_WAIT_RATE_PER_MIN, MONTHLY_FEE, TRIAL_END_DATE, DEPOSIT_SUGGESTED_RATE } = require("../constants");
const { normalizeAccount } = require("../bankAccount");
const { haversineKm } = require("../geo");
const { isRateLimited, recordFailedAttempt, clearAttempts, RATE_LIMIT_MESSAGE, isSubmissionRateLimited, recordSubmission } = require("../pinRateLimit");
const MAX_APPLICATION_IMAGE_LENGTH = 900000;
const { DEFAULT_CITY_ID, getCityById, isWithinServiceRadius } = require("../cities");
const { rideFee } = require("../fees");
const { photoUrls, cleanThumb } = require("../photos");

const router = express.Router();

// Fuente única de las cuotas para los 3 frontends (pasajero, chofer, admin)
// — evita que se desincronicen del valor real que se cobra.
router.get("/config", (req, res) => {
  res.json({ serviceFee: SERVICE_FEE, monthlyFee: MONTHLY_FEE, taxiCommissionRate: TAXI_COMMISSION_RATE, taxiCommissionCap: TAXI_COMMISSION_CAP, taxiWaitRatePerMin: TAXI_WAIT_RATE_PER_MIN, depositSuggestedRate: DEPOSIT_SUGGESTED_RATE });
});

// Choferes "disponibles" de verdad: con GPS reciente (no fantasmas de una
// sesión que se quedó abierta) y cerca de quien está mirando el mapa.
router.get("/drivers/available", (req, res) => {
  const type = req.query.type === "taxi" ? "taxi" : "moto";
  const refLat = Number(req.query.lat);
  const refLng = Number(req.query.lng);
  const hasRef = Number.isFinite(refLat) && Number.isFinite(refLng);
  // El centro de Tekax vive en un solo lugar (cities.js) — antes había un
  // segundo "centro" hardcodeado aquí (SERVICE_CENTER) que quedó mal
  // cargado (~19 km de distancia del real) y nadie lo notó porque solo
  // se usaba en los primeros segundos, antes de que el GPS resolviera.
  const ref = hasRef ? { lat: refLat, lng: refLng } : getCityById(DEFAULT_CITY_ID);

  const drivers = db
    .prepare(
      `SELECT id, lat, lng, vehicle_type FROM drivers
       WHERE status = 'disponible' AND lat IS NOT NULL AND lng IS NOT NULL AND deleted_at IS NULL
         AND vehicle_type = ?
         AND (cooldown_until IS NULL OR cooldown_until <= datetime('now'))
         AND last_seen >= datetime('now', '-${DRIVER_STALE_SECONDS} seconds')`
    )
    .all(type);

  const maxDistance = type === "taxi" ? MAX_MATCH_DISTANCE_KM_TAXI : MAX_MATCH_DISTANCE_KM;
  const nearby = drivers.filter(
    (d) => haversineKm(ref.lat, ref.lng, d.lat, d.lng) <= maxDistance
  );
  res.json(nearby);
});

// Insignia de "top chofer": los 3 con más viajes en los últimos 30 días,
// pero solo entre los que además tienen buena calificación — así no gana
// solo por volumen alguien con mala fama. Requiere mínimo de viajes y de
// calificaciones recibidas para no premiar una racha de suerte con 1-2 viajes.
// Las cuentas de prueba (es_prueba, se marcan en el admin) no entran.
router.get("/drivers/ranking", (req, res) => {
  const rows = db
    .prepare(
      `SELECT d.id, d.name,
              COUNT(r.id) AS trips,
              SUM(CASE WHEN r.rating = 1 THEN 1 ELSE 0 END) AS thumbsUp,
              SUM(CASE WHEN r.rating IS NOT NULL THEN 1 ELSE 0 END) AS ratedCount
       FROM drivers d
       JOIN rides r ON r.driver_id = d.id AND r.status = 'completado' AND date(r.updated_at) >= date('now', '-30 days')
       WHERE d.deleted_at IS NULL AND d.es_prueba = 0
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
  // Antes se entraba solo con el PIN (4 dígitos, 10,000 combinaciones) sin
  // decir de quién es — a quien adivinara CUALQUIER PIN válido le servía,
  // no hacía falta apuntarle a un chofer en particular. Pedir también el
  // teléfono (igual que ya hace el login de pasajero) obliga a saber a
  // quién se le apunta, no solo un número de 4 dígitos cualquiera.
  const { phone, pin } = req.body;
  if (!phone || !pin) {
    return res.status(400).json({ error: "Falta teléfono o PIN" });
  }
  const driver = db
    .prepare(
      "SELECT id, name, phone, vehicle, vehicle_type, status, cooldown_until, deposit_account FROM drivers WHERE phone = ? AND pin = ? AND deleted_at IS NULL"
    )
    .get(phone, pin);

  if (!driver) {
    recordFailedAttempt(req.ip);
    return res.status(404).json({ error: "Teléfono o PIN incorrectos" });
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

  // El número de cuenta completo no hace falta en el login (se guarda en el
  // celular) — basta saber si ya tiene una para ofrecerle pedir anticipo.
  const { deposit_account, ...driverOut } = driver;
  res.json({ ...driverOut, hasDepositAccount: !!deposit_account, todayCount, lifetimeTrips });
});

// Pantalla "Mi perfil" del chofer. Se autentica igual que el login: con su
// propio teléfono + PIN — nunca con un id que mande el cliente, para que
// nadie pueda pedir el perfil (ni el estado de cuenta) de otro chofer.
router.post("/drivers/profile", (req, res) => {
  if (isRateLimited(req.ip)) {
    return res.status(429).json({ error: RATE_LIMIT_MESSAGE });
  }
  const { phone, pin } = req.body;
  if (!phone || !pin) {
    return res.status(400).json({ error: "Falta teléfono o PIN" });
  }
  const driver = db
    .prepare(
      `SELECT id, name, phone, vehicle, vehicle_type, grupo, photo, tipo, pin, created_at,
              paid_until, cancel_count, es_fundador, deposit_bank, deposit_account, deposit_holder
       FROM drivers WHERE phone = ? AND pin = ? AND deleted_at IS NULL`
    )
    .get(phone, pin);

  if (!driver) {
    recordFailedAttempt(req.ip);
    return res.status(404).json({ error: "Teléfono o PIN incorrectos" });
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

  // Viajes completados que todavía no se le han cobrado la cuota de
  // servicio (fija en moto, comisión % con tope en taxi). En un pueblo sin
  // cuota por viaje (SERVICE_FEE = 0) esta sección ni existe, y su tabla
  // `rides` puede no tener la columna `fee_settled_at`.
  const pendingFeeRows = SERVICE_FEE
    ? db
        .prepare(
          "SELECT ride_type, agreed_price FROM rides WHERE driver_id = ? AND status = 'completado' AND fee_settled_at IS NULL"
        )
        .all(driver.id)
    : [];
  const pendingRides = pendingFeeRows.length;
  const pendingRidesAmount = pendingFeeRows.reduce((sum, r) => sum + rideFee(r), 0);

  // Anticipos que el propio chofer confirmó haber recibido en su cuenta —
  // se van sumando para que lleve la cuenta sin anotarlo aparte.
  const depositTotals = db
    .prepare(
      `SELECT COUNT(*) AS count,
              COALESCE(SUM(deposit_amount), 0) AS total,
              COALESCE(SUM(CASE WHEN date(deposit_confirmed_at) >= date('now', 'start of month') THEN deposit_amount ELSE 0 END), 0) AS totalMonth,
              COALESCE(SUM(CASE WHEN date(deposit_confirmed_at) >= date('now', '-6 days') THEN deposit_amount ELSE 0 END), 0) AS totalWeek
       FROM rides WHERE driver_id = ? AND deposit_status = 'confirmado'`
    )
    .get(driver.id);
  const recentDeposits = db
    .prepare(
      `SELECT id, deposit_amount AS amount, deposit_confirmed_at AS confirmedAt, rider_name AS riderName, pickup_label AS pickupLabel
       FROM rides WHERE driver_id = ? AND deposit_status = 'confirmado'
       ORDER BY deposit_confirmed_at DESC LIMIT 10`
    )
    .all(driver.id);

  res.json({
    id: driver.id,
    name: driver.name,
    phone: driver.phone,
    vehicle: driver.vehicle,
    vehicleType: driver.vehicle_type,
    grupo: driver.grupo,
    ...photoUrls("d", driver.id, driver.photo),
    pin: driver.pin,
    createdAt: driver.created_at,
    cancelCount: driver.cancel_count,
    esFundador: !!driver.es_fundador,
    lifetimeTrips: stats.lifetimeTrips || 0,
    tripsMonth: stats.tripsMonth || 0,
    ratedCount: stats.ratedCount || 0,
    ratingPct: stats.ratedCount ? Math.round((stats.thumbsUp / stats.ratedCount) * 100) : null,
    paidUntil: driver.paid_until,
    lastPayment: lastPayment || null,
    monthlyFee: MONTHLY_FEE,
    trialEndDate: TRIAL_END_DATE,
    pendingRides,
    pendingRidesAmount,
    serviceFee: SERVICE_FEE,
    bankAccount: driver.deposit_account
      ? { bank: driver.deposit_bank, account: driver.deposit_account, holder: driver.deposit_holder }
      : null,
    deposits: { ...depositTotals, recent: recentDeposits },
  });
});

// Cuenta para recibir anticipos (CLABE o tarjeta). La captura el propio
// chofer — a diferencia de nombre/placa, esto no lo avala nadie: es SU
// dinero y SU cuenta. Mandar account vacío la borra (deja de pedir anticipos).
router.post("/drivers/bank-account", (req, res) => {
  if (isRateLimited(req.ip)) {
    return res.status(429).json({ error: RATE_LIMIT_MESSAGE });
  }
  const { phone, pin, bank, account, holder } = req.body;
  if (!phone || !pin) {
    return res.status(400).json({ error: "Falta teléfono o PIN" });
  }
  const driver = db
    .prepare("SELECT id FROM drivers WHERE phone = ? AND pin = ? AND deleted_at IS NULL")
    .get(phone, pin);
  if (!driver) {
    recordFailedAttempt(req.ip);
    return res.status(404).json({ error: "Teléfono o PIN incorrectos" });
  }
  clearAttempts(req.ip);

  if (!String(account ?? "").trim()) {
    db.prepare("UPDATE drivers SET deposit_bank = NULL, deposit_account = NULL, deposit_holder = NULL WHERE id = ?").run(driver.id);
    return res.json({ ok: true, bankAccount: null });
  }

  const normalized = normalizeAccount(account);
  if (normalized.error) return res.status(400).json({ error: normalized.error });
  const cleanBank = String(bank ?? "").trim().slice(0, 40);
  const cleanHolder = String(holder ?? "").trim().slice(0, 80);
  if (!cleanBank) return res.status(400).json({ error: "Escribe el nombre de tu banco" });
  if (!cleanHolder) return res.status(400).json({ error: "Escribe el nombre del titular de la cuenta" });

  db.prepare("UPDATE drivers SET deposit_bank = ?, deposit_account = ?, deposit_holder = ? WHERE id = ?").run(
    cleanBank, normalized.account, cleanHolder, driver.id
  );
  res.json({ ok: true, bankAccount: { bank: cleanBank, account: normalized.account, holder: cleanHolder } });
});

// La foto es lo único que el chofer puede cambiar de su propio perfil.
// Nombre, placa, agrupación y tipo de vehículo los avaló su líder y solo se
// tocan desde el admin — si el chofer pudiera cambiarlos, el aval no valdría.
router.post("/drivers/photo", (req, res) => {
  if (isRateLimited(req.ip)) {
    return res.status(429).json({ error: RATE_LIMIT_MESSAGE });
  }
  const { phone, pin, photo, thumb } = req.body;
  if (!phone || !pin) {
    return res.status(400).json({ error: "Falta teléfono o PIN" });
  }
  const driver = db
    .prepare("SELECT id FROM drivers WHERE phone = ? AND pin = ? AND deleted_at IS NULL")
    .get(phone, pin);

  if (!driver) {
    recordFailedAttempt(req.ip);
    return res.status(404).json({ error: "Teléfono o PIN incorrectos" });
  }
  clearAttempts(req.ip);
  if (typeof photo !== "string" || !/^data:image\/(jpeg|png|webp);base64,/.test(photo)) {
    return res.status(400).json({ error: "Foto inválida" });
  }
  if (photo.length > 900000) {
    return res.status(413).json({ error: "La foto pesa demasiado, intenta con otra" });
  }

  // Si el cliente (una versión vieja en caché) no manda miniatura, se limpia la
  // anterior: si no, quedaría la miniatura de la foto vieja junto a la nueva.
  db.prepare("UPDATE drivers SET photo = ?, photo_thumb = ? WHERE id = ?").run(photo, cleanThumb(thumb), driver.id);
  res.json({ ok: true });
});

router.post("/chofer-solicitudes", (req, res) => {
  if (isSubmissionRateLimited(req.ip)) {
    return res.status(429).json({ error: RATE_LIMIT_MESSAGE });
  }
  const {
    name, phone, photo, photoPlaca, acceptedLegal, signature, vehicleType, grupo, viaLiderLink, formalIntent, city,
    emergencyContactName, emergencyContactPhone, referredBy, lat, lng,
  } = req.body;
  for (const img of [photo, photoPlaca, signature]) {
    if (typeof img === "string" && img.length > MAX_APPLICATION_IMAGE_LENGTH) {
      return res.status(413).json({ error: "Una de las fotos pesa demasiado, intenta con otra" });
    }
  }
  // Este formulario es público (sin PIN) — sin este chequeo, cualquiera
  // podía mandar cualquier texto en `photo`/`photoPlaca` (no solo una
  // imagen) y quedaba guardado tal cual en driver_applications.
  for (const img of [photo, photoPlaca]) {
    if (img && (typeof img !== "string" || !/^data:image\/(jpeg|png|webp);base64,/.test(img))) {
      return res.status(400).json({ error: "Una de las fotos no es válida, intenta con otra" });
    }
  }
  const cityId = getCityById(city) ? city : DEFAULT_CITY_ID;
  // Ticul aun corre en su propio servidor aparte de este backend unificado;
  // una solicitud etiquetada "ticul" aqui no le llegaria a ningun admin.
  if (cityId === "ticul") {
    return res.status(400).json({ error: "Ticul todavía no está disponible en este formulario" });
  }
  // Si el navegador sí entregó GPS (aunque haya caído en el selector manual
  // de ciudad, ej. porque el GPS no resolvió a ninguna ciudad conocida), lo
  // validamos contra el radio real — evita altas "de Tekax" desde fuera de
  // Tekax. Sin GPS (permiso negado) no bloqueamos: no queremos perder un
  // chofer real solo porque no dio permiso de ubicación.
  // A propósito NO se usa el radio ampliado de taxi aquí (ver rides.js) — el
  // viaje foráneo sí puede pedirse desde Peto/Xul, pero darse de alta como
  // chofer sigue exigiendo estar físicamente en Tekax, para cualquier
  // vehículo. Es una decisión de control de quién se vuelve chofer, no un
  // descuido.
  if (!isWithinServiceRadius(cityId, lat, lng)) {
    return res.status(400).json({ error: "MotoVecino todavía no está disponible en tu zona." });
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
