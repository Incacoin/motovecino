const express = require("express");
const db = require("../db");
const { AVISO_LEGAL_VERSION, SERVICE_FEE, LAUNCH_DATE, TRIAL_END_DATE } = require("../constants");
const { isRateLimited, recordFailedAttempt, clearAttempts, RATE_LIMIT_MESSAGE } = require("../pinRateLimit");
const { getCityById } = require("../cities");
const { generateRiderPin } = require("./riders");

const router = express.Router();

// Un PIN de admin por ciudad — cada quien solo entra a la suya. Es la misma
// separación que ya existía al tener Tekax y Ticul como apps y bases de datos
// totalmente aparte; ahora que comparten base de datos, esto es lo que
// mantiene esa frontera. ADMIN_PIN (sin sufijo) queda como alias de Tekax
// para no invalidar el PIN que ya se venía usando.
const ADMIN_PINS = {
  tekax: process.env.ADMIN_PIN_TEKAX || process.env.ADMIN_PIN,
  ticul: process.env.ADMIN_PIN_TICUL,
};

function checkAdminPin(req, res, next) {
  if (isRateLimited(req.ip)) {
    return res.status(429).json({ error: RATE_LIMIT_MESSAGE });
  }
  const city = Object.keys(ADMIN_PINS).find(
    (c) => ADMIN_PINS[c] && req.body.adminPin === ADMIN_PINS[c]
  );
  if (!city) {
    recordFailedAttempt(req.ip);
    return res.status(401).json({ error: "PIN de admin incorrecto" });
  }
  clearAttempts(req.ip);
  req.adminCity = city;
  next();
}

// Confirma que el chofer/solicitud sobre el que se va a actuar es de la
// ciudad de este admin — sin esto, un admin de Tekax podría tocar a un
// chofer de Ticul con solo adivinar/probar su id.
function assertOwnCity(table, req, res) {
  const row = db.prepare(`SELECT city FROM ${table} WHERE id = ?`).get(req.params.id);
  if (!row || row.city !== req.adminCity) {
    res.status(404).json({ error: "No encontrado" });
    return false;
  }
  return true;
}

function generateDriverPin() {
  let pin;
  do {
    pin = String(Math.floor(1000 + Math.random() * 9000));
  } while (db.prepare("SELECT id FROM drivers WHERE pin = ?").get(pin));
  return pin;
}

router.post("/admin/login", checkAdminPin, (req, res) => {
  res.json({ ok: true, city: req.adminCity, cityLabel: getCityById(req.adminCity)?.label });
});

router.post("/admin/drivers", checkAdminPin, (req, res) => {
  const {
    name, phone, vehicle, tipo, acceptedLegal, photo, photoPlaca, signature, vehicleType, grupo,
    emergencyContactName, emergencyContactPhone, referredBy,
  } = req.body;
  if (!name || !phone) {
    return res.status(400).json({ error: "Falta nombre o teléfono" });
  }
  // La ciudad la decide el PIN con el que entró el admin, no un campo que
  // mande el navegador — así nadie puede darse de alta "en otra ciudad".
  const cityId = req.adminCity;
  if (!acceptedLegal) {
    return res.status(400).json({ error: "Confirma que el chofer aceptó el aviso legal" });
  }

  const existingPhone = db
    .prepare("SELECT id, name FROM drivers WHERE phone = ? AND deleted_at IS NULL")
    .get(phone);
  if (existingPhone) {
    return res.status(409).json({
      error: `Ese teléfono ya está registrado con el chofer "${existingPhone.name}"`,
    });
  }

  const existingName = db
    .prepare("SELECT id FROM drivers WHERE lower(trim(name)) = lower(trim(?)) AND deleted_at IS NULL")
    .get(name);
  if (existingName) {
    return res.status(409).json({
      error: `Ya hay un chofer registrado con el nombre "${name}"`,
    });
  }

  const pin = generateDriverPin();
  const result = db
    .prepare(
      "INSERT INTO drivers (name, phone, vehicle, pin, tipo, accepted_legal_at, accepted_legal_version, photo, photo_placa, signature, vehicle_type, grupo, city, emergency_contact_name, emergency_contact_phone, referred_by) VALUES (?, ?, ?, ?, ?, datetime('now'), ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"
    )
    .run(
      name, phone, vehicle || null, pin, tipo === "formal" ? "formal" : "informal", AVISO_LEGAL_VERSION, photo || null, photoPlaca || null, signature || null, vehicleType === "taxi" ? "taxi" : "moto", grupo || null, cityId,
      emergencyContactName || null, emergencyContactPhone || null, referredBy || null
    );

  const driver = db
    .prepare("SELECT id, name, phone, vehicle, pin, status, tipo, photo, photo_placa, signature, vehicle_type, grupo, city, emergency_contact_name, emergency_contact_phone, referred_by FROM drivers WHERE id = ?")
    .get(result.lastInsertRowid);

  res.status(201).json(driver);
});

router.post("/admin/drivers/list", checkAdminPin, (req, res) => {
  const drivers = db
    .prepare(
      `SELECT d.id, d.name, d.phone, d.vehicle, d.pin, d.status, d.last_seen, d.paid_until, d.vouched_by, d.vouched_at,
              d.tipo, d.photo, d.photo_placa, d.signature, d.vehicle_type, d.cancel_count, d.cooldown_until, d.grupo, d.city, d.created_at,
              d.emergency_contact_name, d.emergency_contact_phone, d.referred_by,
              (SELECT amount FROM driver_payments WHERE driver_id = d.id ORDER BY paid_at DESC LIMIT 1) AS last_payment_amount,
              (SELECT paid_at FROM driver_payments WHERE driver_id = d.id ORDER BY paid_at DESC LIMIT 1) AS last_payment_at,
              (SELECT COUNT(*) FROM rides WHERE driver_id = d.id AND status = 'completado' AND fee_settled_at IS NULL) AS pending_rides
       FROM drivers d
       WHERE d.deleted_at IS NULL AND d.city = ?
       ORDER BY d.created_at DESC`
    )
    .all(req.adminCity);
  res.json(drivers);
});

router.post("/admin/drivers/:id/paid-until", checkAdminPin, (req, res) => {
  if (!assertOwnCity("drivers", req, res)) return;
  const { paidUntil } = req.body;
  db.prepare("UPDATE drivers SET paid_until = ? WHERE id = ?").run(
    paidUntil || null,
    req.params.id
  );
  res.json({ ok: true });
});

router.post("/admin/drivers/:id/register-payment", checkAdminPin, (req, res) => {
  if (!assertOwnCity("drivers", req, res)) return;
  const driver = db.prepare("SELECT id, paid_until FROM drivers WHERE id = ?").get(req.params.id);
  if (!driver) {
    return res.status(404).json({ error: "Chofer no encontrado" });
  }

  const amount = Number(req.body.amount);
  if (!amount || amount <= 0) {
    return res.status(400).json({ error: "Monto inválido" });
  }

  const today = new Date().toISOString().slice(0, 10);
  const base = driver.paid_until && driver.paid_until > today ? driver.paid_until : today;
  const periodEnd = new Date(base);
  periodEnd.setDate(periodEnd.getDate() + 30);
  const periodEndStr = periodEnd.toISOString().slice(0, 10);

  db.prepare(
    "INSERT INTO driver_payments (driver_id, amount, period_start, period_end, concept) VALUES (?, ?, ?, ?, 'mensual')"
  ).run(req.params.id, amount, base, periodEndStr);
  db.prepare("UPDATE drivers SET paid_until = ? WHERE id = ?").run(periodEndStr, req.params.id);

  res.json({ ok: true, paidUntil: periodEndStr });
});

router.post("/admin/drivers/:id/pending-fees", checkAdminPin, (req, res) => {
  if (!assertOwnCity("drivers", req, res)) return;
  const { count } = db
    .prepare(
      "SELECT COUNT(*) AS count FROM rides WHERE driver_id = ? AND status = 'completado' AND fee_settled_at IS NULL"
    )
    .get(req.params.id);
  res.json({ count, amount: count * SERVICE_FEE, feePerRide: SERVICE_FEE });
});

router.post("/admin/drivers/:id/register-trip-fees", checkAdminPin, (req, res) => {
  if (!assertOwnCity("drivers", req, res)) return;
  const pendingRides = db
    .prepare(
      "SELECT id FROM rides WHERE driver_id = ? AND status = 'completado' AND fee_settled_at IS NULL"
    )
    .all(req.params.id);

  if (pendingRides.length === 0) {
    return res.status(400).json({ error: "No hay viajes pendientes de cobrar" });
  }

  const amount = pendingRides.length * SERVICE_FEE;
  db.prepare(
    "UPDATE rides SET fee_settled_at = datetime('now') WHERE driver_id = ? AND status = 'completado' AND fee_settled_at IS NULL"
  ).run(req.params.id);
  db.prepare(
    "INSERT INTO driver_payments (driver_id, amount, concept, ride_count) VALUES (?, ?, 'viajes', ?)"
  ).run(req.params.id, amount, pendingRides.length);

  res.json({ ok: true, count: pendingRides.length, amount });
});

router.post("/admin/drivers/:id/payments", checkAdminPin, (req, res) => {
  if (!assertOwnCity("drivers", req, res)) return;
  const payments = db
    .prepare(
      "SELECT id, amount, period_start, period_end, paid_at, concept, ride_count FROM driver_payments WHERE driver_id = ? ORDER BY paid_at DESC"
    )
    .all(req.params.id);
  res.json(payments);
});

// Igual que el de pasajero: si un chofer pierde su PIN, esto le da uno nuevo
// SIN tocar su fila (mismo id) — así conserva su historial de viajes, su
// lugar en el ranking y todo lo demás. Borrarlo y volver a darlo de alta
// perdería todo eso.
router.post("/admin/drivers/:id/reset-pin", checkAdminPin, (req, res) => {
  if (!assertOwnCity("drivers", req, res)) return;
  const pin = generateDriverPin();
  db.prepare("UPDATE drivers SET pin = ? WHERE id = ?").run(pin, req.params.id);
  res.json({ ok: true, pin });
});

router.post("/admin/drivers/:id/vouch", checkAdminPin, (req, res) => {
  if (!assertOwnCity("drivers", req, res)) return;
  const { vouchedBy } = req.body;
  const vouchedAt = vouchedBy ? new Date().toISOString().slice(0, 10) : null;
  db.prepare("UPDATE drivers SET vouched_by = ?, vouched_at = ? WHERE id = ?").run(
    vouchedBy || null,
    vouchedAt,
    req.params.id
  );
  res.json({ ok: true });
});

router.post("/admin/drivers/:id/update", checkAdminPin, (req, res) => {
  if (!assertOwnCity("drivers", req, res)) return;
  const { name, phone, vehicle, tipo, vehicleType, grupo } = req.body;
  if (!name || !phone) {
    return res.status(400).json({ error: "Falta nombre o teléfono" });
  }
  // La ciudad no se toca desde aquí: ya se validó que el chofer es de la
  // ciudad de este admin, y no puede "mudarlo" a otra a la que no tiene acceso.
  const cityId = req.adminCity;

  const existingPhone = db
    .prepare("SELECT id, name FROM drivers WHERE phone = ? AND deleted_at IS NULL AND id != ?")
    .get(phone, req.params.id);
  if (existingPhone) {
    return res.status(409).json({
      error: `Ese teléfono ya está registrado con el chofer "${existingPhone.name}"`,
    });
  }

  const existingName = db
    .prepare("SELECT id FROM drivers WHERE lower(trim(name)) = lower(trim(?)) AND deleted_at IS NULL AND id != ?")
    .get(name, req.params.id);
  if (existingName) {
    return res.status(409).json({
      error: `Ya hay un chofer registrado con el nombre "${name}"`,
    });
  }

  db.prepare(
    "UPDATE drivers SET name = ?, phone = ?, vehicle = ?, tipo = ?, vehicle_type = ?, grupo = ?, city = ? WHERE id = ?"
  ).run(name, phone, vehicle || null, tipo === "formal" ? "formal" : "informal", vehicleType === "taxi" ? "taxi" : "moto", grupo || null, cityId, req.params.id);

  const driver = db
    .prepare(
      "SELECT id, name, phone, vehicle, pin, status, last_seen, paid_until, tipo, vehicle_type, grupo, city, created_at FROM drivers WHERE id = ?"
    )
    .get(req.params.id);
  res.json(driver);
});

router.post("/admin/drivers/:id/delete", checkAdminPin, (req, res) => {
  if (!assertOwnCity("drivers", req, res)) return;
  const activeRide = db
    .prepare("SELECT id FROM rides WHERE driver_id = ? AND status IN ('aceptado', 'llegue', 'en_curso')")
    .get(req.params.id);
  if (activeRide) {
    return res.status(409).json({ error: "Este chofer tiene un viaje activo en este momento, no se puede eliminar todavía" });
  }
  // Soft delete: conserva la fila (y su nombre en el historial de viajes),
  // solo lo saca de la lista de choferes activos y le cierra el acceso.
  db.prepare("UPDATE drivers SET deleted_at = datetime('now'), status = 'offline' WHERE id = ?").run(req.params.id);
  res.json({ ok: true });
});

router.post("/admin/chofer-solicitudes/list", checkAdminPin, (req, res) => {
  const apps = db
    .prepare(
      "SELECT id, name, phone, photo, photo_placa, signature, status, created_at, accepted_legal_at, accepted_legal_version, vehicle_type, grupo, tipo, city, emergency_contact_name, emergency_contact_phone, referred_by FROM driver_applications WHERE status = 'pendiente' AND city = ? ORDER BY created_at DESC"
    )
    .all(req.adminCity);
  res.json(apps);
});

router.post("/admin/chofer-solicitudes/:id/dismiss", checkAdminPin, (req, res) => {
  if (!assertOwnCity("driver_applications", req, res)) return;
  db.prepare("UPDATE driver_applications SET status = 'descartada' WHERE id = ?").run(
    req.params.id
  );
  res.json({ ok: true });
});

router.post("/admin/riders/list", checkAdminPin, (req, res) => {
  const riders = db
    .prepare(
      `SELECT r.id, r.name, r.phone, r.pin, r.created_at, r.last_ride_at, r.no_show_count,
              (SELECT COUNT(*) FROM rides WHERE rider_id = r.id AND status = 'completado') AS trips
       FROM riders r
       WHERE r.city = ?
       ORDER BY r.created_at DESC`
    )
    .all(req.adminCity);
  res.json(riders);
});

// Único recurso de soporte hoy: si un pasajero pierde su PIN (o cambia de
// celular sin haberlo apuntado), no hay forma de recuperarlo solo — el admin
// le genera uno nuevo y se lo pasa por su cuenta (llamada, WhatsApp, etc.).
router.post("/admin/riders/:id/reset-pin", checkAdminPin, (req, res) => {
  if (!assertOwnCity("riders", req, res)) return;
  const pin = generateRiderPin();
  db.prepare("UPDATE riders SET pin = ? WHERE id = ?").run(pin, req.params.id);
  res.json({ ok: true, pin });
});

router.post("/admin/rides/list", checkAdminPin, (req, res) => {
  const rides = db
    .prepare(
      `SELECT r.id, r.rider_name, r.rider_phone, r.pickup_label, r.dest_label,
              r.passengers, r.children, r.status, r.created_at, r.updated_at, r.driver_disconnected_at, r.rating, r.ride_type,
              r.cancelled_by, r.cancel_reason,
              d.name AS driver_name
       FROM rides r
       LEFT JOIN drivers d ON d.id = r.driver_id
       WHERE r.city = ?
       ORDER BY r.updated_at DESC
       LIMIT 50`
    )
    .all(req.adminCity);
  res.json(rides);
});

router.post("/admin/rides/reset", checkAdminPin, (req, res) => {
  db.prepare("DELETE FROM rides WHERE city = ?").run(req.adminCity);
  res.json({ ok: true });
});

router.post("/admin/stats", checkAdminPin, (req, res) => {
  const city = req.adminCity;
  const ridesToday = db
    .prepare("SELECT COUNT(*) AS n FROM rides WHERE status = 'completado' AND date(updated_at) = date('now') AND city = ?")
    .get(city).n;
  const ridesWeek = db
    .prepare("SELECT COUNT(*) AS n FROM rides WHERE status = 'completado' AND date(updated_at) >= date('now', '-6 days') AND city = ?")
    .get(city).n;
  const cancelledToday = db
    .prepare("SELECT COUNT(*) AS n FROM rides WHERE status = 'cancelado' AND date(updated_at) = date('now') AND city = ?")
    .get(city).n;
  const driversOnline = db
    .prepare("SELECT COUNT(*) AS n FROM drivers WHERE status IN ('disponible', 'en_viaje') AND deleted_at IS NULL AND city = ?")
    .get(city).n;
  const topDrivers = db
    .prepare(
      `SELECT d.name, COUNT(*) AS rides
       FROM rides r JOIN drivers d ON d.id = r.driver_id
       WHERE r.status = 'completado' AND date(r.updated_at) >= date('now', '-6 days') AND r.city = ?
       GROUP BY r.driver_id
       ORDER BY rides DESC
       LIMIT 5`
    )
    .all(city);
  const ratings = db
    .prepare(
      `SELECT COUNT(*) AS total, SUM(rating) AS good
       FROM rides
       WHERE rating IS NOT NULL AND date(updated_at) >= date('now', '-6 days') AND city = ?`
    )
    .get(city);
  const satisfactionPct = ratings.total > 0 ? Math.round((ratings.good / ratings.total) * 100) : null;
  const collectedWeek = db
    .prepare(
      `SELECT COALESCE(SUM(p.amount), 0) AS total FROM driver_payments p
       JOIN drivers d ON d.id = p.driver_id
       WHERE date(p.paid_at) >= date('now', '-6 days') AND d.city = ?`
    )
    .get(city).total;
  const collectedMonth = db
    .prepare(
      `SELECT COALESCE(SUM(p.amount), 0) AS total FROM driver_payments p
       JOIN drivers d ON d.id = p.driver_id
       WHERE date(p.paid_at) >= date('now', '-29 days') AND d.city = ?`
    )
    .get(city).total;
  const launchRanking = db
    .prepare(
      `SELECT d.id, d.name, COUNT(*) AS rides
       FROM rides r JOIN drivers d ON d.id = r.driver_id
       WHERE r.status = 'completado' AND date(r.updated_at) >= date(?) AND (r.rating IS NULL OR r.rating = 1) AND r.city = ?
       GROUP BY r.driver_id
       ORDER BY rides DESC
       LIMIT 5`
    )
    .all(LAUNCH_DATE, city);

  res.json({
    ridesToday, ridesWeek, cancelledToday, driversOnline, topDrivers, satisfactionPct, ratedCount: ratings.total,
    collectedWeek, collectedMonth, launchRanking, trialEndDate: TRIAL_END_DATE,
  });
});

// Detecta el patrón de "cancela y te llevo por fuera": un chofer acepta un
// viaje, se pone de acuerdo con el pasajero por chat para que este cancele en
// la app, y el viaje se completa en efectivo sin que nunca llegue a
// "completado" — así nunca se acumula la cuota de $2/viaje. No hay forma de
// probarlo con certeza desde los datos (una cancelación real de pasajero se
// ve idéntica), así que esto es una señal para que el admin revise con el
// líder del gremio, no una acusación automática.
router.post("/admin/reports/cancelaciones", checkAdminPin, (req, res) => {
  const porChofer = db
    .prepare(
      `SELECT d.id, d.name, d.grupo,
              COUNT(*) AS total_asignados,
              SUM(CASE WHEN r.status = 'cancelado' AND r.cancelled_by = 'rider' THEN 1 ELSE 0 END) AS cancelados_pasajero
       FROM rides r
       JOIN drivers d ON d.id = r.driver_id
       WHERE d.city = ?
       GROUP BY r.driver_id
       HAVING total_asignados >= 3 AND cancelados_pasajero > 0
       ORDER BY (1.0 * cancelados_pasajero / total_asignados) DESC
       LIMIT 20`
    )
    .all(req.adminCity)
    .map((row) => ({ ...row, pct: Math.round((row.cancelados_pasajero / row.total_asignados) * 100) }));

  // La señal más fuerte: el mismo pasajero cancelando repetido justo con el
  // mismo chofer. Una cancelación real y aislada es normal; que se repita con
  // la misma pareja chofer-pasajero casi no pasa por accidente.
  const paresRepetidos = db
    .prepare(
      `SELECT r.driver_id, d.name AS driver_name, r.rider_phone, r.rider_name,
              COUNT(*) AS veces, MAX(r.updated_at) AS ultima_vez
       FROM rides r
       JOIN drivers d ON d.id = r.driver_id
       WHERE r.status = 'cancelado' AND r.cancelled_by = 'rider' AND d.city = ?
       GROUP BY r.driver_id, r.rider_phone
       HAVING veces >= 2
       ORDER BY veces DESC, ultima_vez DESC
       LIMIT 20`
    )
    .all(req.adminCity);

  // Pasajeros que ya acumularon varias veces "El pasajero no llegó" (ver
  // no_show_count en riders/rides.js). No se bloquean solos — es para que el
  // admin decida si contacta o restringe, porque un "no llegó" también puede
  // ser el chofer equivocándose de ubicación.
  const NO_SHOW_ALERT_THRESHOLD = 2;
  const inasistencias = db
    .prepare(
      `SELECT id, name, phone, no_show_count
       FROM riders
       WHERE city = ? AND no_show_count >= ?
       ORDER BY no_show_count DESC`
    )
    .all(req.adminCity, NO_SHOW_ALERT_THRESHOLD);

  res.json({ porChofer, paresRepetidos, inasistencias });
});

module.exports = router;
