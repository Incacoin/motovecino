// Viajes agendados (12-nov-2026): el pasajero pide su viaje para más tarde
// ("mañana a las 6:00 a.m.") y un chofer de su municipio lo puede confirmar
// desde antes. Cerca de la hora, este mismo archivo crea el viaje de verdad:
//   - con chofer confirmado → 15 min antes, ya asignado a ese chofer;
//   - sin chofer → 10 min antes sale como un viaje normal a los choferes cercanos.
// Las reglas del viaje (precio mínimo, zona, destino) son las mismas del viaje
// normal (checkRideRequest en rides.js). Tabla: ride_bookings (schema.sql).
const express = require("express");
const db = require("../db");
const push = require("../push");
const realtime = require("../realtime");
const { photoUrls } = require("../photos");
const { getCityById, zoneAt, sameCityForRide } = require("../cities");
const { isRateLimited, recordFailedAttempt, clearAttempts, RATE_LIMIT_MESSAGE } = require("../pinRateLimit");
const rides = require("./rides");
const { MOTO_OFFER_MAX_UP, TAXI_OFFER_MAX_UP } = require("../constants");

const MIN = 60 * 1000;
const MIN_AHEAD_MS = 40 * MIN; // menos que esto: mejor pedir el viaje normal
const MAX_AHEAD_MS = 7 * 24 * 60 * MIN; // hasta 7 días antes
const LAUNCH_CONFIRMED_MS = 15 * MIN; // con chofer: se le asigna 15 min antes
const LAUNCH_OPEN_MS = 10 * MIN; // sin chofer: sale a todos 10 min antes
const REMIND_MS = 60 * MIN; // aviso al pasajero 1 h antes
const EXPIRE_AFTER_MS = 15 * MIN; // si el servidor estuvo apagado y ya pasó la hora
const DRIVER_GAP_MS = 45 * MIN; // un chofer no confirma dos viajes tan pegados
const MAX_PER_RIDER = 3;
const MAX_PER_DRIVER = 6;
const LIVE = ["agendado", "confirmado"];
const MAX_OPEN_OFFERS_PER_DRIVER = 10; // propuestas de precio sin contestar a la vez
// Por qué el chofer pide más en un viaje agendado (13-nov-2026). Sin "está
// lloviendo": el viaje es para otro día y no se sabe.
const BOOKING_OFFER_REASONS = { lejos: "Es lejos", noche: "Es de noche", temprano: "Es muy temprano", camino: "Camino difícil", otro: "Otro" };

const router = express.Router();
router.param("id", (req, res, next, v) => (/^\d{1,9}$/.test(v) ? next() : res.status(404).json({ error: "No encontrado" })));
router.param("offerId", (req, res, next, v) => (/^\d{1,9}$/.test(v) ? next() : res.status(404).json({ error: "No encontrado" })));

const firstName = (name) => String(name || "").trim().split(/\s+/)[0] || "";

// "jueves 13 nov, 6:00 a.m." en hora de Yucatán.
function whenText(ms) {
  const d = new Date(Number(ms));
  const day = d.toLocaleDateString("es-MX", { timeZone: "America/Merida", weekday: "long", day: "numeric", month: "short" }).replace(/\./g, "");
  const hour = d.toLocaleTimeString("es-MX", { timeZone: "America/Merida", hour: "numeric", minute: "2-digit", hour12: true });
  return `${day}, ${hour}`;
}
function hourText(ms) {
  return new Date(Number(ms)).toLocaleTimeString("es-MX", { timeZone: "America/Merida", hour: "numeric", minute: "2-digit", hour12: true });
}

// ---- Quién es quién (mismo cuidado con el PIN que en rides.js) ----

async function authRider(req, res) {
  const { riderPhone, riderPin } = req.body || {};
  if (!riderPhone || !riderPin) { res.status(400).json({ error: "Faltan credenciales" }); return null; }
  if (isRateLimited(req.ip, req.body)) { res.status(429).json({ error: RATE_LIMIT_MESSAGE }); return null; }
  const rider = await db.prepare("SELECT id, name, phone FROM riders WHERE phone = ? AND pin = ?").get(riderPhone, riderPin);
  if (!rider) {
    recordFailedAttempt(req.ip, req.body);
    res.status(401).json({ error: "Teléfono o PIN incorrectos" });
    return null;
  }
  clearAttempts(req.ip);
  return rider;
}

async function authDriver(req, res) {
  const { driverId, pin } = req.body || {};
  if (!driverId || !pin) { res.status(400).json({ error: "Falta driverId o PIN" }); return null; }
  if (isRateLimited(req.ip, req.body)) { res.status(429).json({ error: RATE_LIMIT_MESSAGE }); return null; }
  const driver = await db
    .prepare("SELECT id, name, city, zone, lat, lng, vehicle_type FROM drivers WHERE id = ? AND pin = ? AND deleted_at IS NULL")
    .get(driverId, pin);
  if (!driver) {
    recordFailedAttempt(req.ip, req.body);
    res.status(401).json({ error: "PIN incorrecto" });
    return null;
  }
  clearAttempts(req.ip);
  return driver;
}

// El chofer puede atender este viaje: mismo tipo de vehículo, mismo municipio
// (el taxi, toda la región) y, donde hay comisarías (Progreso), la suya — la
// fija de su alta o, sin ella, donde estuvo la última vez (misma regla que
// driverInRideZone en rides.js, sin la ubicación en vivo: el viaje es para
// más tarde).
function driverFits(driver, b) {
  if ((driver.vehicle_type === "taxi" ? "taxi" : "moto") !== b.ride_type) return false;
  if (!sameCityForRide(b.ride_type, b.city, driver.city)) return false;
  const cfg = getCityById(b.city);
  if (cfg?.zones) {
    const z = zoneAt(b.city, b.pickup_lat, b.pickup_lng);
    const zDriver = driver.zone ? { id: driver.zone } : (driver.lat != null ? zoneAt(b.city, driver.lat, driver.lng) : null);
    return !!(z && zDriver && zDriver.id === z.id);
  }
  return true;
}

// ¿El chofer puede comprometerse a este viaje? (máximo de viajes y que no
// choque con otro suyo). Lo mismo al confirmar y al aceptarle su precio.
async function commitError(driverId, b) {
  const when = Number(b.scheduled_at_ms);
  const others = await db
    .prepare("SELECT scheduled_at_ms FROM ride_bookings WHERE driver_id = ? AND status = 'confirmado' AND id != ?")
    .all(driverId, b.id);
  if (others.length >= MAX_PER_DRIVER) return `Ya tienes ${MAX_PER_DRIVER} viajes agendados`;
  if (others.some((o) => Math.abs(Number(o.scheduled_at_ms) - when) < DRIVER_GAP_MS)) return "Ya tienes otro viaje agendado muy cerca de esa hora";
  return null;
}

// Cierra las propuestas de precio que siguen sin contestar en este viaje (ya
// lo confirmó alguien, lo cancelaron o ya salió) y avisa a esos choferes para
// que su lista se actualice. exceptId: la que se acaba de aceptar.
// maxPrice: solo las que quedaron igual o abajo de ese precio.
async function closeOffers(bookingId, status = "cerrada", exceptId = 0, maxPrice = null) {
  const open = maxPrice == null
    ? await db.prepare("SELECT id, driver_id FROM booking_offers WHERE booking_id = ? AND status = 'pendiente' AND id != ?").all(bookingId, exceptId)
    : await db.prepare("SELECT id, driver_id FROM booking_offers WHERE booking_id = ? AND status = 'pendiente' AND id != ? AND price <= ?").all(bookingId, exceptId, maxPrice);
  for (const o of open) {
    const r = await db.prepare("UPDATE booking_offers SET status = ?, responded_at = datetime('now') WHERE id = ? AND status = 'pendiente'").run(status, o.id);
    if (r.changes) realtime.notifyDriver(o.driver_id, "bookings_changed", {});
  }
}

// ---- Avisos ----

// Aviso al celular del pasajero (si los activó al agendar).
async function pushRider(bookingId, title, body) {
  const subs = await db.prepare("SELECT endpoint, p256dh, auth FROM booking_push_subs WHERE booking_id = ?").all(bookingId);
  // id null: si el celular ya no acepta avisos, sendToRider no borra nada de
  // rider_push_subs por error (esta suscripción es de otra tabla).
  for (const s of subs) push.sendToRider({ ...s, id: null }, { tag: `agenda-${bookingId}`, title, body });
}

// A los choferes con la app abierta en ese municipio: que vuelvan a pedir su
// lista de agendados (no se manda nada del viaje por aquí).
async function bookingsChanged(b) {
  const taxi = b.ride_type === "taxi";
  const list = await db
    .prepare(`SELECT id FROM drivers WHERE deleted_at IS NULL AND vehicle_type = ? ${taxi ? "" : "AND city = ?"}`)
    .all(...(taxi ? ["taxi"] : ["moto", b.city]));
  // (la app del chofer espera un momento al azar antes de volver a pedir la
  // lista, para que no lleguen todos al mismo tiempo)
  for (const d of list) realtime.notifyDriver(d.id, "bookings_changed", {});
}

// ---- Lo que ve cada quien ----

async function riderView(b) {
  const out = {
    id: b.id,
    status: b.status,
    scheduled_at_ms: Number(b.scheduled_at_ms),
    ride_type: b.ride_type,
    pickup_lat: b.pickup_lat,
    pickup_lng: b.pickup_lng,
    pickup_label: b.pickup_label,
    dest_lat: b.dest_lat,
    dest_lng: b.dest_lng,
    dest_label: b.dest_label,
    passengers: b.passengers,
    children: b.children,
    offer_price: b.offer_price,
    fail_reason: b.fail_reason,
    driver: null,
    ride: null,
  };
  if (b.driver_id && b.status === "confirmado") {
    const d = await db.prepare("SELECT id, name, vehicle, photo, es_fundador FROM drivers WHERE id = ?").get(b.driver_id);
    if (d) out.driver = { name: firstName(d.name), vehicle: d.vehicle, es_fundador: d.es_fundador, photo: photoUrls("d", d.id, d.photo).photo };
  }
  if (b.ride_id) {
    const r = await db.prepare("SELECT id, status, share_token FROM rides WHERE id = ?").get(b.ride_id);
    if (r) out.ride = { id: r.id, status: r.status, token: r.share_token };
  }
  // Propuestas de precio de los choferes (sin su teléfono: igual que en el
  // viaje normal, ese se entrega hasta que el viaje sale).
  out.offers = [];
  if (b.status === "agendado") {
    const list = await db
      .prepare(
        `SELECT o.id, o.price, o.reason, d.id AS driver_id, d.name, d.vehicle, d.photo, d.es_fundador
         FROM booking_offers o JOIN drivers d ON d.id = o.driver_id
         WHERE o.booking_id = ? AND o.status = 'pendiente' AND d.deleted_at IS NULL ORDER BY o.price, o.id`
      )
      .all(b.id);
    out.offers = list.map((o) => ({
      id: o.id,
      price: o.price,
      reason: BOOKING_OFFER_REASONS[o.reason] || null,
      driver: { name: firstName(o.name), vehicle: o.vehicle, es_fundador: o.es_fundador, photo: photoUrls("d", o.driver_id, o.photo).photo },
    }));
  }
  return out;
}

// Al chofer: recogida y destino aproximados (~100 m) y sin la referencia de
// la casa hasta que él lo confirme, porque la lista la ven todos los choferes
// del municipio durante días (regla de CLAUDE.md: nada de ubicación exacta
// de otra persona al público). b trae rider_name y rider_trips (ver
// BOOKING_DRIVER_SELECT).
function driverView(b, driverId, myOffers = {}) {
  const mine = b.driver_id === driverId;
  const round = (v) => Math.round(v * 1000) / 1000;
  return {
    id: b.id,
    mine,
    scheduled_at_ms: Number(b.scheduled_at_ms),
    ride_type: b.ride_type,
    pickup_lat: mine ? b.pickup_lat : round(b.pickup_lat),
    pickup_lng: mine ? b.pickup_lng : round(b.pickup_lng),
    pickup_label: mine ? b.pickup_label : null,
    dest_lat: mine ? b.dest_lat : round(b.dest_lat),
    dest_lng: mine ? b.dest_lng : round(b.dest_lng),
    dest_label: mine ? b.dest_label : null,
    passengers: b.passengers,
    children: b.children,
    offer_price: b.offer_price,
    rider_name: firstName(b.rider_name) || "Pasajero",
    riderTripCount: Number(b.rider_trips) || 0,
    // Su propuesta de precio que el pasajero todavía no contesta.
    myOffer: !mine && myOffers[b.id] ? { id: myOffers[b.id].id, price: myOffers[b.id].price, reason: myOffers[b.id].reason } : null,
  };
}
// Una sola consulta con el nombre del pasajero y cuántos viajes ha completado
// (antes eran 2 consultas por cada viaje de la lista).
const BOOKING_DRIVER_SELECT = `SELECT b.*, r.name AS rider_name,
    (SELECT COUNT(*) FROM rides x WHERE x.rider_phone = r.phone AND x.status = 'completado') AS rider_trips
  FROM ride_bookings b LEFT JOIN riders r ON r.id = b.rider_id`;

// ---- Pasajero ----

router.post("/bookings", async (req, res) => {
  const rider = await authRider(req, res);
  if (!rider) return;
  const b = req.body;
  const when = Math.round(Number(b.scheduled_at_ms));
  const now = Date.now();
  if (!Number.isFinite(when)) return res.status(400).json({ error: "Elige el día y la hora" });
  if (when < now + MIN_AHEAD_MS) return res.status(400).json({ error: "Para antes de 40 minutos pide tu viaje normal" });
  if (when > now + MAX_AHEAD_MS) return res.status(400).json({ error: "Puedes agendar hasta 7 días antes" });
  if (b.pickup_lat == null || b.pickup_lng == null || b.dest_lat == null || b.dest_lng == null) {
    return res.status(400).json({ error: "Marca tu punto de encuentro y tu destino" });
  }
  if (b.offer_price == null) return res.status(400).json({ error: "Escribe cuánto ofreces" });

  const rideType = b.ride_type === "taxi" ? "taxi" : "moto";
  const body = {
    pickup_lat: Number(b.pickup_lat), pickup_lng: Number(b.pickup_lng),
    dest_lat: Number(b.dest_lat), dest_lng: Number(b.dest_lng),
    passengers: Math.max(1, Math.min(8, Math.round(Number(b.passengers) || 1))),
    children: Math.max(0, Math.min(8, Math.round(Number(b.children) || 0))),
    ride_type: rideType, service_kind: "pasaje", offer_price: b.offer_price,
  };
  if (![body.pickup_lat, body.pickup_lng, body.dest_lat, body.dest_lng].every(Number.isFinite)) {
    return res.status(400).json({ error: "Revisa el punto de encuentro y el destino" });
  }
  const checked = rides.checkRideRequest(body);
  if (checked.error) return res.status(400).json({ error: checked.error });

  const { n } = await db.prepare("SELECT COUNT(*) AS n FROM ride_bookings WHERE rider_id = ? AND status IN ('agendado', 'confirmado')").get(rider.id);
  if (n >= MAX_PER_RIDER) return res.status(409).json({ error: `Ya tienes ${MAX_PER_RIDER} viajes agendados. Cancela uno para agendar otro.` });

  const clean = (v, max) => (typeof v === "string" && v.trim() ? v.trim().slice(0, max) : null);
  const result = await db
    .prepare(
      `INSERT INTO ride_bookings (rider_id, city, ride_type, pickup_lat, pickup_lng, pickup_label, dest_lat, dest_lng, dest_label, passengers, children, offer_price, scheduled_at_ms, reminded)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    // Agendado con poco tiempo (menos de 1 h 15 min): no se le manda el aviso
    // de "es en 1 hora" (sería falso y le llegaría casi al instante).
    .run(rider.id, checked.city, rideType, body.pickup_lat, body.pickup_lng, clean(b.pickup_label, 120), body.dest_lat, body.dest_lng, clean(b.dest_label, 120), body.passengers, body.children, checked.offerPrice, when, when - now < REMIND_MS + 15 * MIN ? 1 : 0);
  const booking = await db.prepare("SELECT * FROM ride_bookings WHERE id = ?").get(result.lastInsertRowid);
  bookingsChanged(booking).catch(() => {});
  res.status(201).json(await riderView(booking));
});

router.post("/bookings/mine", async (req, res) => {
  const rider = await authRider(req, res);
  if (!rider) return;
  // Los que siguen pendientes y los que salieron hace poco (para que la app
  // abra el viaje que ya se creó).
  const list = await db
    .prepare(
      `SELECT * FROM ride_bookings WHERE rider_id = ? AND (status IN ('agendado', 'confirmado', 'lanzando')
         OR (status IN ('lanzado', 'fallido', 'vencido') AND scheduled_at_ms > ?))
       ORDER BY scheduled_at_ms`
    )
    .all(rider.id, Date.now() - 3 * 60 * MIN);
  res.json(await Promise.all(list.map(riderView)));
});

router.post("/bookings/:id/cancel", async (req, res) => {
  const rider = await authRider(req, res);
  if (!rider) return;
  const b = await db.prepare("SELECT * FROM ride_bookings WHERE id = ? AND rider_id = ?").get(Number(req.params.id), rider.id);
  if (!b) return res.status(404).json({ error: "No encontrado" });
  const r = await db
    .prepare("UPDATE ride_bookings SET status = 'cancelado', cancelled_by = 'rider', updated_at = datetime('now') WHERE id = ? AND status IN ('agendado', 'confirmado')")
    .run(b.id);
  if (r.changes === 0) return res.status(409).json({ error: "Este viaje ya salió. Si quieres cancelarlo, hazlo desde la pantalla del viaje." });
  await closeOffers(b.id);
  if (b.driver_id) realtime.notifyDriver(b.driver_id, "booking_cancelled", { bookingId: b.id, when: whenText(b.scheduled_at_ms) });
  bookingsChanged(b).catch(() => {});
  res.json({ ok: true });
});

// Avisos al celular del pasajero para este viaje agendado.
router.post("/bookings/:id/push", async (req, res) => {
  const rider = await authRider(req, res);
  if (!rider) return;
  const { endpoint, p256dh, auth } = req.body || {};
  const b = await db.prepare("SELECT id, status FROM ride_bookings WHERE id = ? AND rider_id = ?").get(Number(req.params.id), rider.id);
  if (!b) return res.status(404).json({ error: "No encontrado" });
  if (!push.isValidEndpoint(endpoint) || !push.isValidRiderKeys(p256dh, auth)) return res.status(400).json({ error: "Suscripción no válida" });
  if (!LIVE.includes(b.status)) return res.json({ ok: false });
  const { n } = await db.prepare("SELECT COUNT(*) AS n FROM booking_push_subs WHERE booking_id = ? AND endpoint != ?").get(b.id, endpoint);
  if (n >= 3) return res.json({ ok: false });
  await db.prepare(
    `INSERT INTO booking_push_subs (booking_id, endpoint, p256dh, auth) VALUES (?, ?, ?, ?)
     ON CONFLICT(booking_id, endpoint) DO UPDATE SET p256dh = excluded.p256dh, auth = excluded.auth`
  ).run(b.id, endpoint, p256dh, auth);
  res.json({ ok: true });
});

// ---- Chofer ----

router.post("/bookings/driver", async (req, res) => {
  const driver = await authDriver(req, res);
  if (!driver) return;
  const now = Date.now();
  const mine = await db
    .prepare(`${BOOKING_DRIVER_SELECT} WHERE b.driver_id = ? AND b.status = 'confirmado' ORDER BY b.scheduled_at_ms`)
    .all(driver.id);
  // Solo los que todavía se pueden confirmar (después salen solos como viaje
  // normal). Mototaxi: solo de su municipio, ya filtrado en la consulta para
  // que el LIMIT no se llene con viajes de otros municipios.
  const taxi = driver.vehicle_type === "taxi";
  const open = (await db
    .prepare(`${BOOKING_DRIVER_SELECT} WHERE b.status = 'agendado' AND b.ride_type = ? ${taxi ? "" : "AND b.city = ?"} AND b.scheduled_at_ms > ? ORDER BY b.scheduled_at_ms LIMIT 60`)
    .all(...(taxi ? ["taxi"] : ["moto", driver.city || "tekax"]), now + LAUNCH_CONFIRMED_MS))
    .filter((b) => driverFits(driver, b));
  const offers = await db.prepare("SELECT id, booking_id, price, reason FROM booking_offers WHERE driver_id = ? AND status = 'pendiente'").all(driver.id);
  const myOffers = Object.fromEntries(offers.map((o) => [o.booking_id, o]));
  res.json({
    mine: mine.map((b) => driverView(b, driver.id)),
    available: open.map((b) => driverView(b, driver.id, myOffers)),
    offerReasons: BOOKING_OFFER_REASONS,
    offerMaxUp: taxi ? TAXI_OFFER_MAX_UP : MOTO_OFFER_MAX_UP,
  });
});

router.post("/bookings/:id/take", async (req, res) => {
  const driver = await authDriver(req, res);
  if (!driver) return;
  const b = await db.prepare("SELECT * FROM ride_bookings WHERE id = ?").get(Number(req.params.id));
  if (!b || !driverFits(driver, b)) return res.status(404).json({ error: "Este viaje ya no está disponible" });
  const when = Number(b.scheduled_at_ms);
  if (when <= Date.now() + LAUNCH_CONFIRMED_MS) return res.status(409).json({ error: "Ya falta muy poco: este viaje va a salir como viaje normal" });
  const busy = await commitError(driver.id, b);
  if (busy) return res.status(409).json({ error: busy });
  const r = await db
    .prepare("UPDATE ride_bookings SET status = 'confirmado', driver_id = ?, updated_at = datetime('now') WHERE id = ? AND status = 'agendado'")
    .run(driver.id, b.id);
  if (r.changes === 0) return res.status(409).json({ error: "Otro chofer ya lo confirmó" });
  // Ya tiene chofer al precio del pasajero: las propuestas de otros se cierran.
  await closeOffers(b.id);
  pushRider(b.id, `✅ ${firstName(driver.name)} confirmó tu viaje`, `Pasa por ti el ${whenText(when)}.`).catch(() => {});
  bookingsChanged(b).catch(() => {});
  res.json({ ok: true });
});

// ---- Propuestas de precio (contraoferta) en viajes agendados, 13-nov-2026 ----
// El chofer propone más que el pasajero (con su motivo). No se queda con el
// viaje: el pasajero acepta o rechaza. Mientras tanto otro chofer lo puede
// confirmar al precio del pasajero (gana el primero, como en el viaje normal).
router.post("/bookings/:id/offer", async (req, res) => {
  const driver = await authDriver(req, res);
  if (!driver) return;
  const reason = Object.hasOwn(BOOKING_OFFER_REASONS, req.body?.reason) ? req.body.reason : null;
  if (!reason) return res.status(400).json({ error: "Elige por qué pides más" });
  const b = await db.prepare("SELECT * FROM ride_bookings WHERE id = ?").get(Number(req.params.id));
  if (!b || !driverFits(driver, b)) return res.status(404).json({ error: "Este viaje ya no está disponible" });
  if (b.status !== "agendado") return res.status(409).json({ error: "Este viaje ya tiene chofer" });
  if (Number(b.scheduled_at_ms) <= Date.now() + LAUNCH_CONFIRMED_MS) return res.status(409).json({ error: "Ya falta muy poco: este viaje va a salir como viaje normal" });
  const maxUp = b.ride_type === "taxi" ? TAXI_OFFER_MAX_UP : MOTO_OFFER_MAX_UP;
  const price = Math.round(Number(req.body?.price));
  if (!(price > b.offer_price) || price > b.offer_price + maxUp) {
    return res.status(400).json({ error: `Tu precio debe ser más que $${b.offer_price} y máximo $${b.offer_price + maxUp}` });
  }
  const busy = await commitError(driver.id, b);
  if (busy) return res.status(409).json({ error: busy });
  // Límite de propuestas abiertas (sin contar la de este viaje, que se reemplaza).
  const { n } = await db
    .prepare("SELECT COUNT(*) AS n FROM booking_offers WHERE driver_id = ? AND status = 'pendiente' AND booking_id != ?")
    .get(driver.id, b.id);
  if (n >= MAX_OPEN_OFFERS_PER_DRIVER) return res.status(409).json({ error: "Ya tienes muchas propuestas sin contestar. Espera a que te respondan." });
  // Una sola propuesta viva por chofer en cada viaje: la nueva reemplaza la anterior.
  const prev = await db
    .prepare("UPDATE booking_offers SET status = 'reemplazada', responded_at = datetime('now') WHERE booking_id = ? AND driver_id = ? AND status = 'pendiente'")
    .run(b.id, driver.id);
  try {
    await db.prepare("INSERT INTO booking_offers (booking_id, driver_id, price, reason) VALUES (?, ?, ?, ?)").run(b.id, driver.id, price, reason);
  } catch {
    // Dos toques al mismo tiempo: el índice único deja pasar solo uno.
    return res.status(409).json({ error: "Ya enviaste una propuesta para este viaje" });
  }
  // Aviso al celular solo la primera vez (si cambia su precio, el pasajero lo ve al abrir).
  if (!prev.changes) {
    pushRider(b.id, `💬 ${firstName(driver.name)} propone $${price} para tu viaje`, `${whenText(b.scheduled_at_ms)} · Motivo: ${BOOKING_OFFER_REASONS[reason]}. Ábrelo en Mis viajes agendados para aceptar o rechazar.`).catch(() => {});
  }
  res.json({ ok: true });
});

// El chofer retira su propuesta.
router.post("/bookings/:id/offer/withdraw", async (req, res) => {
  const driver = await authDriver(req, res);
  if (!driver) return;
  await db
    .prepare("UPDATE booking_offers SET status = 'retirada', responded_at = datetime('now') WHERE booking_id = ? AND driver_id = ? AND status = 'pendiente'")
    .run(Number(req.params.id), driver.id);
  res.json({ ok: true });
});

// El pasajero acepta la propuesta: el viaje queda confirmado con ese chofer y ese precio.
router.post("/bookings/:id/offers/:offerId/accept", async (req, res) => {
  const rider = await authRider(req, res);
  if (!rider) return;
  const b = await db.prepare("SELECT * FROM ride_bookings WHERE id = ? AND rider_id = ?").get(Number(req.params.id), rider.id);
  if (!b) return res.status(404).json({ error: "No encontrado" });
  const o = await db.prepare("SELECT * FROM booking_offers WHERE id = ? AND booking_id = ? AND status = 'pendiente'").get(Number(req.params.offerId), b.id);
  if (!o) return res.status(409).json({ error: "Esta propuesta ya no está disponible" });
  if (b.status !== "agendado") return res.status(409).json({ error: "Tu viaje ya tiene chofer" });
  if (Number(b.scheduled_at_ms) <= Date.now() + LAUNCH_CONFIRMED_MS) return res.status(409).json({ error: "Ya falta muy poco: tu viaje va a salir a los choferes cercanos" });
  const d = await db.prepare("SELECT * FROM drivers WHERE id = ? AND deleted_at IS NULL").get(o.driver_id);
  const busy = !d || !driverFits(d, b) ? "Ese chofer ya no está disponible" : await commitError(d.id, b);
  if (busy) {
    await db.prepare("UPDATE booking_offers SET status = 'cerrada', responded_at = datetime('now') WHERE id = ? AND status = 'pendiente'").run(o.id);
    return res.status(409).json({ error: "Ese chofer ya no puede ir a esa hora. Su propuesta se quitó." });
  }
  // Primero se aparta la propuesta (si el chofer la cambió o retiró en este
  // mismo momento, no se acepta un precio viejo) y luego el viaje.
  const took = await db.prepare("UPDATE booking_offers SET status = 'aceptada', responded_at = datetime('now') WHERE id = ? AND status = 'pendiente'").run(o.id);
  if (took.changes === 0) return res.status(409).json({ error: "Esta propuesta ya no está disponible" });
  const r = await db
    .prepare("UPDATE ride_bookings SET status = 'confirmado', driver_id = ?, offer_price = ?, updated_at = datetime('now') WHERE id = ? AND status = 'agendado' AND driver_id IS NULL")
    .run(d.id, o.price, b.id);
  if (r.changes === 0) {
    await db.prepare("UPDATE booking_offers SET status = 'cerrada', responded_at = datetime('now') WHERE id = ?").run(o.id);
    realtime.notifyDriver(d.id, "bookings_changed", {});
    return res.status(409).json({ error: "Tu viaje ya tiene chofer" });
  }
  await closeOffers(b.id, "cerrada", o.id);
  realtime.notifyDriver(d.id, "booking_offer_accepted", { bookingId: b.id, when: whenText(b.scheduled_at_ms), price: o.price });
  bookingsChanged(b).catch(() => {});
  res.json(await riderView(await db.prepare("SELECT * FROM ride_bookings WHERE id = ?").get(b.id)));
});

// El pasajero rechaza la propuesta: se borra y el viaje sigue abierto.
router.post("/bookings/:id/offers/:offerId/reject", async (req, res) => {
  const rider = await authRider(req, res);
  if (!rider) return;
  const b = await db.prepare("SELECT id FROM ride_bookings WHERE id = ? AND rider_id = ?").get(Number(req.params.id), rider.id);
  if (!b) return res.status(404).json({ error: "No encontrado" });
  const o = await db.prepare("SELECT id, driver_id FROM booking_offers WHERE id = ? AND booking_id = ?").get(Number(req.params.offerId), b.id);
  if (!o) return res.status(404).json({ error: "No encontrado" });
  const r = await db.prepare("UPDATE booking_offers SET status = 'rechazada', responded_at = datetime('now') WHERE id = ? AND status = 'pendiente'").run(o.id);
  if (r.changes) realtime.notifyDriver(o.driver_id, "booking_offer_rejected", { bookingId: b.id });
  res.json({ ok: true });
});

// El pasajero sube su precio (nadie lo ha confirmado). Las propuestas que ya
// quedaron igual o abajo del precio nuevo se quitan solas.
router.post("/bookings/:id/price", async (req, res) => {
  const rider = await authRider(req, res);
  if (!rider) return;
  const b = await db.prepare("SELECT * FROM ride_bookings WHERE id = ? AND rider_id = ?").get(Number(req.params.id), rider.id);
  if (!b) return res.status(404).json({ error: "No encontrado" });
  if (b.status !== "agendado") return res.status(409).json({ error: "Tu viaje ya tiene chofer: ya no se puede cambiar el precio" });
  if (Number(b.scheduled_at_ms) <= Date.now() + LAUNCH_CONFIRMED_MS) return res.status(409).json({ error: "Ya falta muy poco para tu viaje" });
  const price = Math.round(Number(req.body?.price));
  if (!(price > b.offer_price)) return res.status(400).json({ error: `Escribe más de $${b.offer_price}` });
  const checked = rides.checkRideRequest({
    pickup_lat: b.pickup_lat, pickup_lng: b.pickup_lng, dest_lat: b.dest_lat, dest_lng: b.dest_lng,
    passengers: b.passengers, children: b.children, ride_type: b.ride_type, service_kind: "pasaje", offer_price: price,
  });
  if (checked.error) return res.status(400).json({ error: checked.error });
  const r = await db
    .prepare("UPDATE ride_bookings SET offer_price = ?, updated_at = datetime('now') WHERE id = ? AND status = 'agendado' AND offer_price = ?")
    .run(checked.offerPrice, b.id, b.offer_price);
  if (r.changes === 0) return res.status(409).json({ error: "Tu viaje cambió. Vuelve a abrirlo." });
  await closeOffers(b.id, "cerrada", 0, checked.offerPrice);
  bookingsChanged(b).catch(() => {});
  res.json(await riderView(await db.prepare("SELECT * FROM ride_bookings WHERE id = ?").get(b.id)));
});

// El chofer ya no puede ir: el viaje vuelve a quedar libre para otro.
router.post("/bookings/:id/release", async (req, res) => {
  const driver = await authDriver(req, res);
  if (!driver) return;
  const b = await db.prepare("SELECT * FROM ride_bookings WHERE id = ? AND driver_id = ?").get(Number(req.params.id), driver.id);
  if (!b) return res.status(404).json({ error: "No encontrado" });
  const r = await db
    .prepare("UPDATE ride_bookings SET status = 'agendado', driver_id = NULL, updated_at = datetime('now') WHERE id = ? AND driver_id = ? AND status = 'confirmado'")
    .run(b.id, driver.id);
  if (r.changes === 0) return res.status(409).json({ error: "Este viaje ya salió. Si no puedes ir, cancélalo desde el viaje." });
  pushRider(b.id, "Tu chofer ya no podrá ir", `Tu viaje del ${whenText(b.scheduled_at_ms)} sigue agendado: otro chofer lo puede confirmar, o sale a los choferes cercanos antes de la hora.`).catch(() => {});
  bookingsChanged(b).catch(() => {});
  res.json({ ok: true });
});

// ---- Cerca de la hora: crear el viaje de verdad ----

async function failBooking(b, reason) {
  await db.prepare("UPDATE ride_bookings SET status = 'fallido', fail_reason = ?, updated_at = datetime('now') WHERE id = ?").run(reason, b.id);
  await closeOffers(b.id).catch(() => {});
  await pushRider(b.id, "No pudimos sacar tu viaje agendado", `${reason}. Pide tu viaje desde la app.`);
  if (b.driver_id) realtime.notifyDriver(b.driver_id, "bookings_changed", {});
}

// Algo falló a medias: el viaje que ya se había creado (si hubo) se cancela
// para que no se quede "buscando" sin que nadie lo vea, y se le avisa.
async function abortLaunch(bookingId, rideId) {
  const r = await db.prepare("UPDATE ride_bookings SET status = 'fallido', fail_reason = 'Error del sistema', updated_at = datetime('now') WHERE id = ? AND status = 'lanzando'").run(bookingId);
  const cancel = rideId
    ? await db.prepare("UPDATE rides SET status = 'cancelado', cancelled_by = 'system', cancel_reason = 'Error al sacar el viaje agendado', updated_at = datetime('now') WHERE id = ? AND status = 'buscando'").run(rideId)
    : await db.prepare("UPDATE rides SET status = 'cancelado', cancelled_by = 'system', cancel_reason = 'Error al sacar el viaje agendado', updated_at = datetime('now') WHERE booking_id = ? AND status = 'buscando'").run(bookingId);
  if (r.changes) await pushRider(bookingId, "No pudimos sacar tu viaje agendado", "Hubo un error. Pide tu viaje desde la app.").catch(() => {});
  await closeOffers(bookingId).catch(() => {});
  return cancel.changes;
}

async function launchBooking(b) {
  // Lo toma uno solo (si el barrido se encima, o el chofer lo suelta justo ahora).
  const claim = b.driver_id
    ? await db
      .prepare("UPDATE ride_bookings SET status = 'lanzando', updated_at = datetime('now') WHERE id = ? AND status = ? AND driver_id = ?")
      .run(b.id, b.status, b.driver_id)
    : await db
      .prepare("UPDATE ride_bookings SET status = 'lanzando', updated_at = datetime('now') WHERE id = ? AND status = ? AND driver_id IS NULL")
      .run(b.id, b.status);
  if (claim.changes === 0) return;
  // Ya sale: las propuestas de precio sin contestar se cierran.
  await closeOffers(b.id).catch(() => {});
  let ride = null;
  try {
    const rider = await db.prepare("SELECT id, name, phone FROM riders WHERE id = ?").get(b.rider_id);
    if (!rider) return failBooking(b, "Tu cuenta ya no existe");
    const body = {
      pickup_lat: b.pickup_lat, pickup_lng: b.pickup_lng, pickup_label: b.pickup_label,
      dest_lat: b.dest_lat, dest_lng: b.dest_lng, dest_label: b.dest_label,
      passengers: b.passengers, children: b.children,
      ride_type: b.ride_type, service_kind: "pasaje", offer_price: b.offer_price,
    };
    const checked = rides.checkRideRequest(body);
    if (checked.error) return failBooking(b, checked.error);

    ride = await rides.insertRide(rider, body, checked, b.id);
    // Sus avisos del viaje agendado pasan a ser avisos de este viaje.
    const subs = await db.prepare("SELECT endpoint, p256dh, auth FROM booking_push_subs WHERE booking_id = ?").all(b.id);
    for (const s of subs) await push.saveRiderSubscription(ride.id, s.endpoint, s.p256dh, s.auth);
    Object.assign(ride, await rides.riderInfoFor(rider.phone));

    let assigned = false;
    if (b.status === "confirmado" && b.driver_id) {
      const ok = await db.prepare("SELECT id FROM drivers WHERE id = ? AND deleted_at IS NULL").get(b.driver_id);
      if (ok) {
        try {
          const r = await db
            .prepare("UPDATE rides SET driver_id = ?, status = 'aceptado', agreed_price = offer_price, updated_at = datetime('now') WHERE id = ? AND status = 'buscando'")
            .run(b.driver_id, ride.id);
          assigned = r.changes > 0;
        } catch (err) {
          // Ya trae otro viaje en curso (un solo viaje activo por chofer).
          if (!db.isUniqueViolation(err)) throw err;
        }
      }
    }
    await db.prepare("UPDATE ride_bookings SET status = 'lanzado', ride_id = ?, updated_at = datetime('now') WHERE id = ?").run(ride.id, b.id);

    if (assigned) {
      await db.prepare("UPDATE drivers SET status = 'en_viaje' WHERE id = ?").run(b.driver_id);
      // Igual que al aceptar un viaje (rides.js /accept): sus contraofertas
      // pendientes en otros viajes se cierran.
      await rides.closeDriverOtherOffers(b.driver_id);
      const driver = await rides.driverForRide(b.driver_id);
      realtime.notifyRide(ride.id, "ride_accepted", { ...driver, agreedPrice: ride.offer_price, deposit: null });
      realtime.notifyDriver(b.driver_id, "booking_started", { rideId: ride.id });
      // Si tiene la app cerrada: el aviso de siempre ("Nuevo viaje"); al
      // abrirla le sale el viaje ya aceptado.
      const dsubs = await db.prepare("SELECT id, driver_id, endpoint FROM driver_push_subs WHERE driver_id = ?").all(b.driver_id);
      for (const s of dsubs) push.sendOne(s);
    } else {
      if (b.driver_id) realtime.notifyDriver(b.driver_id, "bookings_changed", {});
      await realtime.broadcastNewRide(ride);
      realtime.startNoDriverTimer(ride.id, ride.ride_type, ride.offer_price != null, true);
      await pushRider(b.id, "🔎 Buscando chofer para tu viaje", `Tu viaje de las ${hourText(b.scheduled_at_ms)} ya salió a los choferes cercanos. Abre la app para verlo.`);
    }
  } catch (err) {
    await abortLaunch(b.id, ride && ride.id);
    throw err;
  }
}

let sweeping = false;
async function sweepBookings() {
  if (sweeping) return;
  sweeping = true;
  try {
    const now = Date.now();
    // Se quedó a medias al salir (el servidor se reinició justo ahí).
    const stuck = await db
      .prepare("SELECT id FROM ride_bookings WHERE status = 'lanzando' AND (julianday('now') - julianday(updated_at)) * 86400 > 120")
      .all();
    for (const b of stuck) await abortLaunch(b.id, null);
    // Al chofer que confirmó lo dieron de baja: el viaje vuelve a quedar libre.
    const orphan = await db
      .prepare("SELECT b.* FROM ride_bookings b JOIN drivers d ON d.id = b.driver_id WHERE b.status = 'confirmado' AND d.deleted_at IS NOT NULL")
      .all();
    for (const b of orphan) {
      const r = await db.prepare("UPDATE ride_bookings SET status = 'agendado', driver_id = NULL, updated_at = datetime('now') WHERE id = ? AND status = 'confirmado' AND driver_id = ?").run(b.id, b.driver_id);
      if (r.changes) {
        await pushRider(b.id, "Tu chofer ya no podrá ir", `Tu viaje del ${whenText(b.scheduled_at_ms)} sigue agendado: otro chofer lo puede confirmar.`);
        bookingsChanged(b).catch(() => {});
      }
    }
    // Se pasó la hora y no salió (el servidor estuvo apagado): ya no sirve.
    const late = await db
      .prepare("SELECT * FROM ride_bookings WHERE status IN ('agendado', 'confirmado') AND scheduled_at_ms < ?")
      .all(now - EXPIRE_AFTER_MS);
    for (const b of late) {
      const r = await db.prepare("UPDATE ride_bookings SET status = 'vencido', updated_at = datetime('now') WHERE id = ? AND status = ?").run(b.id, b.status);
      if (r.changes) {
        await closeOffers(b.id);
        await pushRider(b.id, "Tu viaje agendado no salió", "Lo sentimos. Pide tu viaje desde la app.");
      }
    }
    // Aviso 1 h antes.
    const soon = await db
      .prepare("SELECT * FROM ride_bookings WHERE status IN ('agendado', 'confirmado') AND reminded = 0 AND scheduled_at_ms <= ?")
      .all(now + REMIND_MS);
    for (const b of soon) {
      const r = await db.prepare("UPDATE ride_bookings SET reminded = 1 WHERE id = ? AND reminded = 0").run(b.id);
      if (!r.changes) continue;
      if (b.status === "confirmado" && b.driver_id) {
        const d = await db.prepare("SELECT name FROM drivers WHERE id = ?").get(b.driver_id);
        await pushRider(b.id, "⏰ Tu viaje es en 1 hora", `${firstName(d && d.name) || "Tu chofer"} pasa por ti a las ${hourText(b.scheduled_at_ms)}.`);
      } else {
        await pushRider(b.id, "⏰ Tu viaje es en 1 hora", `Todavía ningún chofer lo confirmó. A las ${hourText(Number(b.scheduled_at_ms) - LAUNCH_OPEN_MS)} lo mandamos a los choferes cercanos.`);
      }
    }
    // Hora de salir.
    const due = await db
      .prepare(
        `SELECT * FROM ride_bookings WHERE (status = 'confirmado' AND scheduled_at_ms <= ?) OR (status = 'agendado' AND scheduled_at_ms <= ?)
         ORDER BY scheduled_at_ms`
      )
      .all(now + LAUNCH_CONFIRMED_MS, now + LAUNCH_OPEN_MS);
    for (const b of due) {
      try {
        await launchBooking(b);
      } catch (err) {
        console.error("[bookings] no se pudo sacar el viaje agendado", b.id, err);
      }
    }
  } catch (err) {
    console.error("[sweepBookings] error:", err);
  } finally {
    sweeping = false;
  }
}

function startBookingSweep() {
  // BOOKING_SWEEP_MS solo para las pruebas locales (tools/test-agendar.js).
  setInterval(sweepBookings, Number(process.env.BOOKING_SWEEP_MS) || 30 * 1000);
}

module.exports = router;
module.exports.startBookingSweep = startBookingSweep;
module.exports.sweepBookings = sweepBookings;
module.exports.BOOKING_OFFER_REASONS = BOOKING_OFFER_REASONS;
module.exports.BOOKING_TIMES = { MIN_AHEAD_MS, MAX_AHEAD_MS, LAUNCH_CONFIRMED_MS, LAUNCH_OPEN_MS };
