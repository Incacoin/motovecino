const express = require("express");
const db = require("../db");
const realtime = require("../realtime");
const { resolveCity, DEFAULT_CITY_ID, isWithinServiceRadius } = require("../cities");
const { isRateLimited, recordFailedAttempt, clearAttempts, RATE_LIMIT_MESSAGE } = require("../pinRateLimit");

const router = express.Router();

// Verifica que el PIN de verdad sea de ese chofer antes de dejarlo tocar un
// viaje — antes estas acciones solo pedían driverId (un entero consecutivo
// fácil de adivinar) y cualquiera podía aceptar/completar/cancelar el viaje
// de otro chofer sin saber su PIN.
function driverPinValid(driverId, pin) {
  return !!db
    .prepare("SELECT id FROM drivers WHERE id = ? AND pin = ? AND deleted_at IS NULL")
    .get(driverId, pin);
}

router.post("/rides", (req, res) => {
  const {
    rider_phone,
    rider_pin,
    pickup_lat,
    pickup_lng,
    pickup_label,
    dest_lat,
    dest_lng,
    dest_label,
    passengers,
    children,
    ride_type,
    service_kind,
  } = req.body;
  const VALID_SERVICE_KINDS = ["pasaje", "domicilio", "mandado"];
  const cleanServiceKind = VALID_SERVICE_KINDS.includes(service_kind) ? service_kind : "pasaje";

  if (!rider_phone || !rider_pin || pickup_lat == null || pickup_lng == null) {
    return res.status(400).json({ error: "Faltan datos del viaje" });
  }

  // El nombre y el teléfono del viaje salen de la cuenta ya autenticada, no
  // de lo que mande el navegador — así nadie puede pedir un viaje "como si
  // fuera" el teléfono de alguien más sin saber su PIN.
  if (isRateLimited(req.ip)) {
    return res.status(429).json({ error: RATE_LIMIT_MESSAGE });
  }
  const rider = db
    .prepare("SELECT id, name, phone FROM riders WHERE phone = ? AND pin = ?")
    .get(rider_phone, rider_pin);
  if (!rider) {
    recordFailedAttempt(req.ip);
    return res.status(401).json({ error: "Teléfono o PIN incorrectos" });
  }
  clearAttempts(req.ip);
  const rider_name = rider.name;

  db.prepare("UPDATE riders SET last_ride_at = datetime('now') WHERE id = ?").run(rider.id);

  // La ciudad del viaje es la de la recogida (no la de quien lo pide desde su
  // celular) — es lo que decide a qué admin/red le toca ese viaje.
  const city = resolveCity(pickup_lat, pickup_lng)?.id || DEFAULT_CITY_ID;

  // Fuera del radio real de servicio de esa ciudad (ej. alguien pidiendo
  // desde otro país) — antes esto caía en DEFAULT_CITY_ID sin más, dejando
  // pedir un viaje que ningún chofer real podría atender.
  if (!isWithinServiceRadius(city, pickup_lat, pickup_lng)) {
    return res.status(400).json({ error: "MotoVecino todavía no está disponible en tu zona." });
  }

  // El registro de pasajero nunca pregunta ubicación, así que su `city` se
  // queda pegado al default para siempre si no lo actualizamos aquí — esto
  // lo mantiene sincronizado con dónde pidió viaje realmente la última vez,
  // que es lo que filtra el admin de cada pueblo (ver routes/admin.js).
  db.prepare("UPDATE riders SET city = ? WHERE id = ?").run(city, rider.id);

  const result = db
    .prepare(
      `INSERT INTO rides (rider_name, rider_phone, rider_id, pickup_lat, pickup_lng, pickup_label, dest_lat, dest_lng, dest_label, passengers, children, ride_type, city, service_kind)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      rider_name,
      rider_phone,
      rider.id,
      pickup_lat,
      pickup_lng,
      pickup_label || null,
      dest_lat ?? null,
      dest_lng ?? null,
      dest_label || null,
      passengers || 1,
      children || 0,
      ride_type === "taxi" ? "taxi" : "moto",
      city,
      cleanServiceKind
    );

  const ride = db
    .prepare("SELECT * FROM rides WHERE id = ?")
    .get(result.lastInsertRowid);

  // Viajes completados anteriores de este mismo teléfono y su foto — para
  // mostrarle al pasajero su propio contador/insignia, y (pegado al objeto
  // `ride`) para que el chofer también lo vea en la solicitud entrante y,
  // más abajo en /accept, en el viaje activo.
  const riderInfo = riderInfoFor(rider_phone);
  Object.assign(ride, riderInfo);

  realtime.broadcastNewRide(ride);
  realtime.startNoDriverTimer(ride.id);
  res.status(201).json({ ...ride, riderTripCount: riderInfo.riderTripCount });
});

// Si un pasajero o chofer se quedó a medias (app cerrada, celular apagado,
// etc.) el viaje se queda "vivo" — esta revisión perezosa lo cierra en
// cuanto alguien consulta ese viaje específico, como respaldo rápido del
// barrido real que corre solo cada 30s en realtime.js (sweepStaleRides),
// que es el que de verdad garantiza que se cierre aunque nadie lo consulte.
const { ABANDONED_AFTER_MIN } = realtime;

router.get("/rides/:id", (req, res) => {
  let ride = db.prepare("SELECT * FROM rides WHERE id = ?").get(req.params.id);
  if (!ride) return res.status(404).json({ error: "Viaje no encontrado" });

  if (!["completado", "cancelado"].includes(ride.status)) {
    const { mins } = db
      .prepare(
        "SELECT (julianday('now') - julianday(created_at)) * 24 * 60 AS mins FROM rides WHERE id = ?"
      )
      .get(ride.id);
    if (mins > ABANDONED_AFTER_MIN) {
      db.prepare(
        "UPDATE rides SET status = 'cancelado', updated_at = datetime('now'), cancelled_by = ?, cancel_reason = ? WHERE id = ?"
      ).run("system", `Abandonado automáticamente tras ${ABANDONED_AFTER_MIN} min sin completarse`, ride.id);
      if (ride.driver_id) {
        db.prepare("UPDATE drivers SET status = 'disponible' WHERE id = ?").run(ride.driver_id);
        realtime.notifyDriver(ride.driver_id, "ride_cancelled", { rideId: ride.id });
      }
      realtime.clearDisconnectTimer(ride.id);
      realtime.clearNoDriverTimer(ride.id);
      realtime.clearPreAcceptContact(ride.id);
      ride = db.prepare("SELECT * FROM rides WHERE id = ?").get(ride.id);
    }
  }

  if (ride.driver_id) {
    ride.driver = db
      .prepare(
        "SELECT id, name, phone, vehicle, grupo, lat, lng, photo FROM drivers WHERE id = ?"
      )
      .get(ride.driver_id);
  }
  Object.assign(ride, riderInfoFor(ride.rider_phone));
  res.json(ride);
});

// Cuántos viajes completados lleva este teléfono y su foto de perfil — antes
// solo se calculaba el conteo para el pasajero (ver POST /rides), ahora
// también para que el chofer vea con quién está tratando antes/durante el
// viaje (solicitud entrante y viaje activo).
function riderInfoFor(phone) {
  if (!phone) return { riderTripCount: null, riderPhoto: null };
  const { trips } = db
    .prepare("SELECT COUNT(*) AS trips FROM rides WHERE rider_phone = ? AND status = 'completado'")
    .get(phone);
  const riderRow = db.prepare("SELECT photo FROM riders WHERE phone = ?").get(phone);
  return { riderTripCount: trips, riderPhoto: riderRow ? riderRow.photo : null };
}

router.post("/rides/:id/accept", (req, res) => {
  const rideId = Number(req.params.id);
  const { driverId, pin } = req.body;
  if (!driverId || !pin) return res.status(400).json({ error: "Falta driverId o PIN" });
  if (isRateLimited(req.ip)) {
    return res.status(429).json({ error: RATE_LIMIT_MESSAGE });
  }
  if (!driverPinValid(driverId, pin)) {
    recordFailedAttempt(req.ip);
    return res.status(401).json({ error: "PIN incorrecto" });
  }
  clearAttempts(req.ip);

  // Sin esto, un doble tap en "aceptar" sobre dos solicitudes distintas (muy
  // fácil con señal lenta) dejaba al chofer "asignado" a dos viajes a la
  // vez: su pantalla solo puede mostrar uno, así que el otro pasajero se
  // quedaba esperando a un chofer que nunca se iba a enterar.
  const alreadyActive = db
    .prepare(
      "SELECT id FROM rides WHERE driver_id = ? AND status IN ('aceptado', 'llegue', 'en_curso')"
    )
    .get(driverId);
  if (alreadyActive) {
    return res.status(409).json({ error: "Ya tienes otro viaje activo" });
  }

  const result = db
    .prepare(
      "UPDATE rides SET driver_id = ?, status = 'aceptado', updated_at = datetime('now') WHERE id = ? AND status = 'buscando'"
    )
    .run(driverId, rideId);

  if (result.changes === 0) {
    return res.status(409).json({ error: "El viaje ya fue tomado" });
  }

  db.prepare("UPDATE drivers SET status = 'en_viaje' WHERE id = ?").run(
    driverId
  );
  realtime.clearNoDriverTimer(rideId);
  realtime.clearPreAcceptContact(rideId);

  const ride = db.prepare("SELECT * FROM rides WHERE id = ?").get(rideId);
  Object.assign(ride, riderInfoFor(ride.rider_phone));
  const driver = db
    .prepare(
      "SELECT id, name, phone, vehicle, grupo, lat, lng, photo FROM drivers WHERE id = ?"
    )
    .get(driverId);

  realtime.notifyRide(rideId, "ride_accepted", driver);
  realtime.broadcastRideTaken(rideId, driverId);
  res.json(ride);
});

router.post("/rides/:id/arrived", (req, res) => {
  const rideId = Number(req.params.id);
  const { driverId, pin } = req.body;
  if (!driverId || !pin) return res.status(400).json({ error: "Falta driverId o PIN" });
  if (isRateLimited(req.ip)) {
    return res.status(429).json({ error: RATE_LIMIT_MESSAGE });
  }
  if (!driverPinValid(driverId, pin)) {
    recordFailedAttempt(req.ip);
    return res.status(401).json({ error: "PIN incorrecto" });
  }
  clearAttempts(req.ip);

  const result = db
    .prepare(
      "UPDATE rides SET status = 'llegue', updated_at = datetime('now') WHERE id = ? AND driver_id = ? AND status = 'aceptado'"
    )
    .run(rideId, driverId);

  if (result.changes === 0) {
    return res.status(409).json({ error: "No se pudo actualizar el viaje" });
  }

  realtime.notifyRide(rideId, "status_change", { status: "llegue" });
  res.json({ ok: true });
});

router.post("/rides/:id/start", (req, res) => {
  const rideId = Number(req.params.id);
  const { driverId, pin } = req.body;
  if (!driverId || !pin) return res.status(400).json({ error: "Falta driverId o PIN" });
  if (isRateLimited(req.ip)) {
    return res.status(429).json({ error: RATE_LIMIT_MESSAGE });
  }
  if (!driverPinValid(driverId, pin)) {
    recordFailedAttempt(req.ip);
    return res.status(401).json({ error: "PIN incorrecto" });
  }
  clearAttempts(req.ip);

  const result = db
    .prepare(
      "UPDATE rides SET status = 'en_curso', updated_at = datetime('now') WHERE id = ? AND driver_id = ? AND status = 'llegue'"
    )
    .run(rideId, driverId);

  if (result.changes === 0) {
    return res.status(409).json({ error: "No se pudo actualizar el viaje" });
  }

  realtime.notifyRide(rideId, "status_change", { status: "en_curso" });
  res.json({ ok: true });
});

router.post("/rides/:id/complete", (req, res) => {
  const rideId = Number(req.params.id);
  const { driverId, pin } = req.body;
  if (!driverId || !pin) return res.status(400).json({ error: "Falta driverId o PIN" });
  if (isRateLimited(req.ip)) {
    return res.status(429).json({ error: RATE_LIMIT_MESSAGE });
  }
  if (!driverPinValid(driverId, pin)) {
    recordFailedAttempt(req.ip);
    return res.status(401).json({ error: "PIN incorrecto" });
  }
  clearAttempts(req.ip);

  const result = db
    .prepare(
      "UPDATE rides SET status = 'completado', updated_at = datetime('now') WHERE id = ? AND driver_id = ? AND status = 'en_curso'"
    )
    .run(rideId, driverId);

  if (result.changes === 0) {
    return res.status(409).json({ error: "No se pudo actualizar el viaje" });
  }

  db.prepare("UPDATE drivers SET status = 'disponible' WHERE id = ?").run(
    driverId
  );

  const { count: todayCount } = db
    .prepare(
      "SELECT COUNT(*) as count FROM rides WHERE driver_id = ? AND status = 'completado' AND date(updated_at) = date('now')"
    )
    .get(driverId);

  const { count: lifetimeTrips } = db
    .prepare(
      "SELECT COUNT(*) as count FROM rides WHERE driver_id = ? AND status = 'completado'"
    )
    .get(driverId);

  realtime.notifyRide(rideId, "status_change", { status: "completado" });
  res.json({ ok: true, todayCount, lifetimeTrips });
});

// Enfriamiento tras cancelación del chofer: si ya se había comprometido con un
// pasajero (driver_id asignado) y él mismo cancela, no vuelve a recibir
// solicitudes nuevas por unos minutos — le quita lo "gratis" a cancelar para
// irse con alguien que lo paró en la calle. Cancelaciones del pasajero no cuentan.
const DRIVER_CANCEL_COOLDOWN_MIN = 5;

router.post("/rides/:id/cancel", (req, res) => {
  const rideId = Number(req.params.id);
  const { driverId, pin, riderPhone, riderPin, reason } = req.body || {};
  const ride = db.prepare("SELECT * FROM rides WHERE id = ?").get(rideId);
  if (!ride) return res.status(404).json({ error: "Viaje no encontrado" });

  if (isRateLimited(req.ip)) {
    return res.status(429).json({ error: RATE_LIMIT_MESSAGE });
  }

  // Quién cancela lo decide el servidor verificando la credencial que mandó
  // (PIN de chofer o PIN de pasajero) — antes se confiaba en el campo
  // "cancelledBy" que mandaba el propio navegador, así que cualquiera podía
  // hacerse pasar por el chofer de un viaje ajeno nada más mandando
  // cancelledBy: "driver" y el rideId.
  let cancelledBy;
  if (driverId) {
    if (!driverPinValid(driverId, pin) || ride.driver_id !== Number(driverId)) {
      recordFailedAttempt(req.ip);
      return res.status(401).json({ error: "PIN incorrecto" });
    }
    cancelledBy = "driver";
  } else if (riderPhone) {
    const riderMatch = db.prepare("SELECT id FROM riders WHERE phone = ? AND pin = ?").get(riderPhone, riderPin);
    if (!riderMatch || ride.rider_phone !== riderPhone) {
      recordFailedAttempt(req.ip);
      return res.status(401).json({ error: "Teléfono o PIN incorrectos" });
    }
    cancelledBy = "rider";
  } else {
    return res.status(400).json({ error: "Faltan credenciales" });
  }
  clearAttempts(req.ip);

  // Sin el filtro de status aquí, un cancel que llega tarde (el pasajero le
  // da "cancelar" justo cuando el chofer ya le dio "completar") volteaba un
  // viaje ya terminado — con cobro y calificación ya hechos — de vuelta a
  // "cancelado", dejando esos datos de dinero inconsistentes.
  const result = db
    .prepare(
      "UPDATE rides SET status = 'cancelado', updated_at = datetime('now'), driver_disconnected_at = NULL, cancelled_by = ?, cancel_reason = ? WHERE id = ? AND status NOT IN ('completado', 'cancelado')"
    )
    .run(cancelledBy || null, reason || null, rideId);
  if (result.changes === 0) {
    return res.status(409).json({ error: "Este viaje ya terminó y no se puede cancelar" });
  }
  realtime.clearDisconnectTimer(rideId);
  realtime.clearNoDriverTimer(rideId);
  realtime.clearPreAcceptContact(rideId);

  let cooldownUntil = null;
  if (ride.driver_id) {
    if (cancelledBy === "driver") {
      cooldownUntil = db
        .prepare(`SELECT datetime('now', '+${DRIVER_CANCEL_COOLDOWN_MIN} minutes') AS cu`)
        .get().cu;
      db.prepare(
        "UPDATE drivers SET status = 'disponible', cancel_count = cancel_count + 1, cooldown_until = ? WHERE id = ?"
      ).run(cooldownUntil, ride.driver_id);
      // Motivo exacto del botón "El pasajero no llegó" en chofer.html — cuenta
      // contra el pasajero, no contra el chofer. Sin rider_id (viajes viejos)
      // no hay a quién cargárselo.
      if (reason === "El pasajero no llegó" && ride.rider_id) {
        db.prepare("UPDATE riders SET no_show_count = no_show_count + 1 WHERE id = ?").run(
          ride.rider_id
        );
      }
    } else {
      db.prepare("UPDATE drivers SET status = 'disponible' WHERE id = ?").run(
        ride.driver_id
      );
    }
    realtime.notifyDriver(ride.driver_id, "ride_cancelled", { rideId });
  } else {
    realtime.broadcastRideRemoved(rideId);
  }

  realtime.notifyRide(rideId, "status_change", { status: "cancelado" });
  res.json({ ok: true, cooldownUntil });
});

router.post("/rides/:id/rate", (req, res) => {
  const rideId = Number(req.params.id);
  const { rating, riderPhone, riderPin } = req.body;
  if (rating !== 0 && rating !== 1) {
    return res.status(400).json({ error: "Calificación inválida" });
  }
  if (isRateLimited(req.ip)) {
    return res.status(429).json({ error: RATE_LIMIT_MESSAGE });
  }

  // Solo el pasajero de ESE viaje puede calificarlo — antes bastaba con
  // adivinar el rideId para poder calificar (o mal-calificar) el viaje de
  // cualquier otro chofer.
  const ride = db.prepare("SELECT rider_phone FROM rides WHERE id = ?").get(rideId);
  if (!ride) return res.status(404).json({ error: "Viaje no encontrado" });
  const riderMatch = db.prepare("SELECT id FROM riders WHERE phone = ? AND pin = ?").get(riderPhone, riderPin);
  if (!riderMatch || ride.rider_phone !== riderPhone) {
    recordFailedAttempt(req.ip);
    return res.status(401).json({ error: "Teléfono o PIN incorrectos" });
  }
  clearAttempts(req.ip);

  const result = db
    .prepare(
      "UPDATE rides SET rating = ? WHERE id = ? AND status = 'completado' AND rating IS NULL"
    )
    .run(rating, rideId);

  if (result.changes === 0) {
    return res.status(409).json({ error: "Este viaje ya fue calificado o no se puede calificar" });
  }

  res.json({ ok: true });
});

module.exports = router;
