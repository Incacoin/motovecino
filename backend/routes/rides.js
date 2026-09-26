const crypto = require("node:crypto");
const express = require("express");
const db = require("../db");
const realtime = require("../realtime");
const { resolveCity, DEFAULT_CITY_ID, isWithinServiceRadius } = require("../cities");
const { isRateLimited, recordFailedAttempt, clearAttempts, RATE_LIMIT_MESSAGE } = require("../pinRateLimit");
const { photoUrls } = require("../photos");
const { ABANDONED_AFTER_MIN_TAXI, TAXI_OFFER_TTL_SEC } = require("../constants");
const { suggestTaxiFare } = require("../taxiFares");

function generateShareToken() {
  return crypto.randomBytes(16).toString("base64url");
}

// El comprobante del anticipo es una foto (~100-300 KB) con datos bancarios
// del pasajero: nunca viaja pegado al viaje (lo ven el enlace "Compartir" y
// el contacto de emergencia) — solo el chofer de ese viaje lo pide aparte,
// con su PIN (ver /deposit/receipt/view).
function publicRide(ride) {
  if (!ride) return ride;
  const { deposit_receipt, ...rest } = ride;
  return { ...rest, deposit_has_receipt: !!deposit_receipt };
}

// Lo que ve el pasajero del anticipo (y el chofer, para pintar su tarjeta).
function depositInfo(ride) {
  if (!ride || !ride.deposit_status) return null;
  return {
    amount: ride.deposit_amount,
    status: ride.deposit_status,
    bank: ride.deposit_bank,
    account: ride.deposit_account,
    holder: ride.deposit_holder,
  };
}

const MAX_RECEIPT_LENGTH = 900000;

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
    offer_price,
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

  // Taxi estilo inDrive: el pasajero propone su precio y hace falta destino
  // (sin destino no hay precio que sugerir ni que negociar). Clientes viejos
  // sin offer_price siguen con el flujo anterior (el chofer pone el precio).
  const isTaxiRequest = ride_type === "taxi";
  let offerPrice = null;
  if (isTaxiRequest && offer_price != null) {
    offerPrice = Math.round(Number(offer_price));
    if (!(offerPrice >= 10) || offerPrice > 20000) {
      return res.status(400).json({ error: "Revisa el precio que ofreces" });
    }
    if (dest_lat == null || dest_lng == null) {
      return res.status(400).json({ error: "Marca tu destino para pedir taxi" });
    }
  }

  db.prepare("UPDATE riders SET last_ride_at = datetime('now') WHERE id = ?").run(rider.id);

  // La ciudad del viaje es la de la recogida (no la de quien lo pide desde su
  // celular) — es lo que decide a qué admin/red le toca ese viaje.
  const city = resolveCity(pickup_lat, pickup_lng)?.id || DEFAULT_CITY_ID;

  // Fuera del radio real de servicio de esa ciudad (ej. alguien pidiendo
  // desde otro país) — antes esto caía en DEFAULT_CITY_ID sin más, dejando
  // pedir un viaje que ningún chofer real podría atender.
  if (!isWithinServiceRadius(city, pickup_lat, pickup_lng, ride_type === "taxi" ? "taxi" : "moto")) {
    return res.status(400).json({ error: "MotoVecino todavía no está disponible en tu zona." });
  }

  // El registro de pasajero nunca pregunta ubicación, así que su `city` se
  // queda pegado al default para siempre si no lo actualizamos aquí — esto
  // lo mantiene sincronizado con dónde pidió viaje realmente la última vez,
  // que es lo que filtra el admin de cada pueblo (ver routes/admin.js).
  db.prepare("UPDATE riders SET city = ? WHERE id = ?").run(city, rider.id);

  const result = db
    .prepare(
      `INSERT INTO rides (rider_name, rider_phone, rider_id, pickup_lat, pickup_lng, pickup_label, dest_lat, dest_lng, dest_label, passengers, children, ride_type, city, service_kind, share_token, offer_price)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
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
      cleanServiceKind,
      generateShareToken(),
      offerPrice
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
  realtime.startNoDriverTimer(ride.id, ride.ride_type);
  res.status(201).json({ ...ride, riderTripCount: riderInfo.riderTripCount });
});

// Si un pasajero o chofer se quedó a medias (app cerrada, celular apagado,
// etc.) el viaje se queda "vivo" — esta revisión perezosa lo cierra en
// cuanto alguien consulta ese viaje específico, como respaldo rápido del
// barrido real que corre solo cada 30s en realtime.js (sweepStaleRides),
// que es el que de verdad garantiza que se cierre aunque nadie lo consulte.
const { ABANDONED_AFTER_MIN } = realtime;

// El id es consecutivo (1, 2, 3...) y fácil de barrer — sin el token nadie
// puede leer, ni siquiera de rebote, la ubicación/teléfono/chat de un viaje
// ajeno. Se responde 404 igual que "no existe" (nunca "token incorrecto")
// para no darle a quien está probando una pista de que el id sí es válido.
router.get("/rides/:id", (req, res) => {
  let ride = db.prepare("SELECT * FROM rides WHERE id = ?").get(req.params.id);
  if (!ride || !req.query.t || ride.share_token !== req.query.t) {
    return res.status(404).json({ error: "Viaje no encontrado" });
  }

  if (!["completado", "cancelado"].includes(ride.status)) {
    // Se mide desde el último avance real (updated_at), igual que el barrido
    // de realtime.js — medirlo desde created_at cancelaba un taxi foráneo
    // que seguía avanzando bien, nada más porque se pidió hace más de 1 hora.
    const limitMin = ride.ride_type === "taxi" ? ABANDONED_AFTER_MIN_TAXI : ABANDONED_AFTER_MIN;
    const { mins } = db
      .prepare(
        "SELECT (julianday('now') - julianday(updated_at)) * 24 * 60 AS mins FROM rides WHERE id = ?"
      )
      .get(ride.id);
    if (mins > limitMin) {
      db.prepare(
        "UPDATE rides SET status = 'cancelado', updated_at = datetime('now'), cancelled_by = ?, cancel_reason = ? WHERE id = ?"
      ).run("system", `Abandonado automáticamente tras ${limitMin} min sin avanzar`, ride.id);
      if (ride.driver_id) {
        db.prepare("UPDATE drivers SET status = 'disponible' WHERE id = ?").run(ride.driver_id);
        realtime.notifyDriver(ride.driver_id, "ride_cancelled", { rideId: ride.id });
      }
      realtime.clearDisconnectTimer(ride.id);
      realtime.clearNoDriverTimer(ride.id);
      ride = db.prepare("SELECT * FROM rides WHERE id = ?").get(ride.id);
    }
  }

  if (ride.driver_id) {
    ride.driver = driverForRide(ride.driver_id);
  }
  if (ride.status === "buscando" && ride.ride_type === "taxi") {
    ride.offers = openOffersForRide(ride.id);
  }
  Object.assign(ride, riderInfoFor(ride.rider_phone));
  res.json(publicRide(ride));
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
  const riderRow = db.prepare("SELECT id, photo FROM riders WHERE phone = ?").get(phone);
  // Solo la miniatura: el chofer la ve como avatar chico junto al nombre.
  return { riderTripCount: trips, riderPhoto: riderRow ? photoUrls("r", riderRow.id, riderRow.photo).photo : null };
}

// Datos del chofer que ve el pasajero. La foto va como URLs (miniatura +
// grande para el visor) en vez de base64 pegado en cada mensaje.
function driverForRide(driverId) {
  const driver = db
    .prepare("SELECT id, name, phone, vehicle, grupo, lat, lng, photo, es_fundador FROM drivers WHERE id = ?")
    .get(driverId);
  if (!driver) return driver;
  return { ...driver, ...photoUrls("d", driver.id, driver.photo) };
}

// El viaje que el chofer ya tiene en curso (aceptado / llegué / en curso). La
// app del chofer arranca siempre en blanco: si se cierra (a mano, o porque
// Android la mata por falta de memoria) y se vuelve a abrir, sin esto el viaje
// seguía vivo en el servidor y para el pasajero, pero el chofer ya no lo veía
// ni podía terminarlo. Devuelve el mismo objeto que /accept, o null.
router.post("/rides/active", (req, res) => {
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

  const ride = db
    .prepare(
      "SELECT * FROM rides WHERE driver_id = ? AND status IN ('aceptado', 'llegue', 'en_curso') ORDER BY id DESC LIMIT 1"
    )
    .get(driverId);
  if (!ride) return res.json(null);

  Object.assign(ride, riderInfoFor(ride.rider_phone));
  res.json(publicRide(ride));
});

router.post("/rides/:id/accept", (req, res) => {
  const rideId = Number(req.params.id);
  const { driverId, pin, agreedPrice, depositAmount } = req.body;
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

  // El taxi captura el precio acordado AQUÍ, al aceptar — no hasta que llega
  // a recoger. Así el pasajero ve el precio desde que el chofer se
  // compromete, en vez de quedarse esperando a un chofer específico sin
  // saber si el precio le va a convenir. El precio se negocia con las ofertas
  // (ya no hay chat antes de aceptar).
  const pendingRide = db.prepare("SELECT ride_type, offer_price FROM rides WHERE id = ?").get(rideId);
  const isTaxi = pendingRide?.ride_type === "taxi";
  if (isTaxi && !(Number(agreedPrice) > 0)) {
    return res.status(400).json({ error: "Captura el precio que acordaste con el pasajero" });
  }
  // Taxi con oferta del pasajero: "Aceptar" es aceptar SU precio. Un precio
  // distinto es una contraoferta (POST /rides/:id/offer) que el pasajero
  // tiene que aprobar antes de que el chofer salga.
  if (isTaxi && pendingRide.offer_price != null && Number(agreedPrice) !== pendingRide.offer_price) {
    return res.status(400).json({ error: "Para cobrar otro precio, manda una contraoferta" });
  }

  // Anticipo (solo taxi): el chofer pide que le depositen una parte ANTES de
  // salir — pensado para viajes foráneos (comisarías a ~50 km), donde ir en
  // vacío y que el pasajero no aparezca le cuesta la gasolina de ida y
  // vuelta. El dinero va directo a la cuenta del chofer, la app solo le
  // enseña al pasajero a dónde depositar y le deja subir el comprobante.
  const deposit = isTaxi ? Math.round(Number(depositAmount) || 0) : 0;
  let bank = null;
  if (deposit > 0) {
    if (deposit > Number(agreedPrice)) {
      return res.status(400).json({ error: "El anticipo no puede ser mayor que el precio acordado" });
    }
    bank = db
      .prepare("SELECT deposit_bank, deposit_account, deposit_holder FROM drivers WHERE id = ?")
      .get(driverId);
    if (!bank?.deposit_account) {
      return res.status(400).json({ error: "Primero registra tu cuenta en Mi perfil → Cuenta para anticipos" });
    }
  }

  const result = db
    .prepare(
      `UPDATE rides SET driver_id = ?, status = 'aceptado', agreed_price = ?,
              deposit_amount = ?, deposit_status = ?, deposit_bank = ?, deposit_account = ?, deposit_holder = ?,
              updated_at = datetime('now')
       WHERE id = ? AND status = 'buscando'`
    )
    .run(
      driverId,
      isTaxi ? Number(agreedPrice) : null,
      deposit > 0 ? deposit : null,
      deposit > 0 ? "pendiente" : null,
      bank?.deposit_bank ?? null,
      bank?.deposit_account ?? null,
      bank?.deposit_holder ?? null,
      rideId
    );

  if (result.changes === 0) {
    return res.status(409).json({ error: "El viaje ya fue tomado" });
  }

  db.prepare("UPDATE drivers SET status = 'en_viaje' WHERE id = ?").run(
    driverId
  );
  realtime.clearNoDriverTimer(rideId);
  realtime.closeOpenOffers(rideId, "cerrada");
  closeDriverOtherOffers(driverId);

  const ride = db.prepare("SELECT * FROM rides WHERE id = ?").get(rideId);
  Object.assign(ride, riderInfoFor(ride.rider_phone));
  const driver = driverForRide(driverId);

  realtime.notifyRide(rideId, "ride_accepted", { ...driver, agreedPrice: ride.agreed_price, deposit: depositInfo(ride) });
  realtime.broadcastRideTaken(rideId, driverId);
  res.json(publicRide(ride));
});

// --- Taxi con ofertas (estilo inDrive) ---

// Precio sugerido para el taxi: punto de partida que ve el pasajero.
router.get("/taxi/suggest", (req, res) => {
  const [plat, plng, dlat, dlng] = ["plat", "plng", "dlat", "dlng"].map((k) => Number(req.query[k]));
  if (![plat, plng, dlat, dlng].every(Number.isFinite)) {
    return res.status(400).json({ error: "Faltan coordenadas" });
  }
  res.json(suggestTaxiFare(plat, plng, dlat, dlng));
});

const OFFER_SELECT = "SELECT o.id, o.price, o.deposit_amount, o.created_at, d.id AS driver_id, d.name, d.vehicle, d.photo, d.es_fundador FROM ride_offers o JOIN drivers d ON d.id = o.driver_id";

// Lo que ve el pasajero de cada contraoferta: quién ofrece y cuánto. El
// teléfono del chofer no: ese solo se entrega cuando el pasajero acepta.
function openOffersForRide(rideId) {
  return db
    .prepare(
      OFFER_SELECT +
        " WHERE o.ride_id = ? AND o.status = 'pendiente' AND (julianday('now') - julianday(o.created_at)) * 86400 <= ? ORDER BY o.price ASC, o.id ASC"
    )
    .all(rideId, TAXI_OFFER_TTL_SEC)
    .map(offerForRider);
}

function offerForRider(o) {
  const ageSec = (Date.now() - Date.parse(o.created_at.replace(" ", "T") + "Z")) / 1000;
  return {
    id: o.id,
    price: o.price,
    depositAmount: o.deposit_amount || null,
    expiresInSec: Math.max(0, Math.round(TAXI_OFFER_TTL_SEC - ageSec)),
    driver: { id: o.driver_id, name: o.name, vehicle: o.vehicle, es_fundador: o.es_fundador, ...photoUrls("d", o.driver_id, o.photo) },
  };
}

// Al tomar un viaje, sus contraofertas en OTROS viajes dejan de valer (ya no
// está libre); cada pasajero la ve desaparecer de su lista.
function closeDriverOtherOffers(driverId) {
  const open = db.prepare("SELECT id, ride_id FROM ride_offers WHERE driver_id = ? AND status = 'pendiente'").all(driverId);
  for (const o of open) {
    db.prepare("UPDATE ride_offers SET status = 'cerrada', responded_at = datetime('now') WHERE id = ?").run(o.id);
    realtime.notifyRide(o.ride_id, "offer_removed", { offerId: o.id });
  }
}

// Valida el anticipo que pide el chofer (mismas reglas que /accept).
function validateDeposit(driverId, price, depositAmount) {
  const deposit = Math.round(Number(depositAmount) || 0);
  if (deposit <= 0) return { deposit: 0, bank: null };
  if (deposit > price) return { error: "El anticipo no puede ser mayor que el precio" };
  const bank = db
    .prepare("SELECT deposit_bank, deposit_account, deposit_holder FROM drivers WHERE id = ?")
    .get(driverId);
  if (!bank?.deposit_account) return { error: "Primero registra tu cuenta en Mi perfil → Cuenta para anticipos" };
  return { deposit, bank };
}

// El chofer de taxi manda una contraoferta (un precio distinto al que ofreció
// el pasajero). No toma el viaje: el pasajero tiene que aceptarla.
router.post("/rides/:id/offer", (req, res) => {
  const rideId = Number(req.params.id);
  const { driverId, pin, price, depositAmount } = req.body || {};
  if (!driverId || !pin) return res.status(400).json({ error: "Falta driverId o PIN" });
  if (isRateLimited(req.ip)) return res.status(429).json({ error: RATE_LIMIT_MESSAGE });
  if (!driverPinValid(driverId, pin)) {
    recordFailedAttempt(req.ip);
    return res.status(401).json({ error: "PIN incorrecto" });
  }
  clearAttempts(req.ip);

  const ride = db.prepare("SELECT id, status, ride_type, offer_price FROM rides WHERE id = ?").get(rideId);
  if (!ride || ride.status !== "buscando") return res.status(409).json({ error: "El viaje ya no está disponible" });
  if (ride.ride_type !== "taxi" || ride.offer_price == null) {
    return res.status(400).json({ error: "Este viaje no acepta contraofertas" });
  }
  const driverRow = db.prepare("SELECT vehicle_type FROM drivers WHERE id = ?").get(driverId);
  if (driverRow?.vehicle_type !== "taxi") return res.status(403).json({ error: "Solo choferes de taxi" });
  const active = db
    .prepare("SELECT id FROM rides WHERE driver_id = ? AND status IN ('aceptado', 'llegue', 'en_curso')")
    .get(driverId);
  if (active) return res.status(409).json({ error: "Ya tienes otro viaje activo" });

  const offerPrice = Math.round(Number(price));
  if (!(offerPrice >= 10) || offerPrice > 20000) return res.status(400).json({ error: "Revisa el precio" });
  const dep = validateDeposit(driverId, offerPrice, depositAmount);
  if (dep.error) return res.status(400).json({ error: dep.error });

  // Una sola oferta viva por chofer en cada viaje: la nueva reemplaza la anterior.
  const previous = db
    .prepare("SELECT id FROM ride_offers WHERE ride_id = ? AND driver_id = ? AND status = 'pendiente'")
    .all(rideId, driverId);
  for (const p of previous) {
    db.prepare("UPDATE ride_offers SET status = 'reemplazada', responded_at = datetime('now') WHERE id = ?").run(p.id);
    realtime.notifyRide(rideId, "offer_removed", { offerId: p.id });
  }
  const result = db
    .prepare("INSERT INTO ride_offers (ride_id, driver_id, price, deposit_amount) VALUES (?, ?, ?, ?)")
    .run(rideId, driverId, offerPrice, dep.deposit || null);
  const row = db.prepare(OFFER_SELECT + " WHERE o.id = ?").get(result.lastInsertRowid);
  realtime.notifyRide(rideId, "offer_new", offerForRider(row));
  res.status(201).json({ offerId: row.id, price: row.price, expiresInSec: TAXI_OFFER_TTL_SEC });
});

// El pasajero acepta una contraoferta: el viaje queda asignado a ese chofer
// con ese precio, igual que si el chofer hubiera aceptado.
router.post("/rides/:id/offers/:offerId/accept", (req, res) => {
  const rideId = Number(req.params.id);
  const ride = riderOwnsRide(req, res, rideId);
  if (!ride) return;
  if (ride.status !== "buscando") return res.status(409).json({ error: "Este viaje ya no está buscando taxi" });

  const offer = db
    .prepare(
      "SELECT * FROM ride_offers WHERE id = ? AND ride_id = ? AND status = 'pendiente' AND (julianday('now') - julianday(created_at)) * 86400 <= ?"
    )
    .get(Number(req.params.offerId), rideId, TAXI_OFFER_TTL_SEC);
  if (!offer) return res.status(409).json({ error: "Esa oferta ya no está disponible" });

  const busy = db
    .prepare("SELECT id FROM rides WHERE driver_id = ? AND status IN ('aceptado', 'llegue', 'en_curso')")
    .get(offer.driver_id);
  if (busy) {
    db.prepare("UPDATE ride_offers SET status = 'cerrada', responded_at = datetime('now') WHERE id = ?").run(offer.id);
    realtime.notifyRide(rideId, "offer_removed", { offerId: offer.id });
    return res.status(409).json({ error: "Ese chofer ya tomó otro viaje" });
  }

  // Si mientras tanto el chofer quitó su cuenta, el viaje sigue sin anticipo.
  const dep = validateDeposit(offer.driver_id, offer.price, offer.deposit_amount);
  const deposit = dep.error ? 0 : dep.deposit;
  const bank = dep.error ? null : dep.bank;

  const result = db
    .prepare(
      `UPDATE rides SET driver_id = ?, status = 'aceptado', agreed_price = ?,
              deposit_amount = ?, deposit_status = ?, deposit_bank = ?, deposit_account = ?, deposit_holder = ?,
              updated_at = datetime('now')
       WHERE id = ? AND status = 'buscando'`
    )
    .run(
      offer.driver_id, offer.price,
      deposit > 0 ? deposit : null, deposit > 0 ? "pendiente" : null,
      bank?.deposit_bank ?? null, bank?.deposit_account ?? null, bank?.deposit_holder ?? null,
      rideId
    );
  if (result.changes === 0) return res.status(409).json({ error: "Este viaje ya no está buscando taxi" });

  db.prepare("UPDATE ride_offers SET status = 'aceptada', responded_at = datetime('now') WHERE id = ?").run(offer.id);
  db.prepare("UPDATE drivers SET status = 'en_viaje' WHERE id = ?").run(offer.driver_id);
  realtime.clearNoDriverTimer(rideId);
  realtime.closeOpenOffers(rideId, "rechazada", offer.id);
  closeDriverOtherOffers(offer.driver_id);

  const updated = db.prepare("SELECT * FROM rides WHERE id = ?").get(rideId);
  Object.assign(updated, riderInfoFor(updated.rider_phone));
  const driver = driverForRide(offer.driver_id);
  // Al chofer: su oferta ganó, con el viaje completo (igual que la respuesta de /accept).
  realtime.notifyDriver(offer.driver_id, "offer_accepted", { rideId, offerId: offer.id, ride: publicRide(updated) });
  realtime.notifyRide(rideId, "ride_accepted", { ...driver, agreedPrice: updated.agreed_price, deposit: depositInfo(updated) });
  realtime.broadcastRideTaken(rideId, offer.driver_id);
  res.json({ ok: true, driver, agreedPrice: updated.agreed_price, deposit: depositInfo(updated) });
});

// El pasajero dice "No, gracias" a una contraoferta. El viaje sigue buscando.
router.post("/rides/:id/offers/:offerId/reject", (req, res) => {
  const rideId = Number(req.params.id);
  const ride = riderOwnsRide(req, res, rideId);
  if (!ride) return;
  const offer = db
    .prepare("SELECT id, driver_id FROM ride_offers WHERE id = ? AND ride_id = ? AND status = 'pendiente'")
    .get(Number(req.params.offerId), rideId);
  if (!offer) return res.json({ ok: true }); // ya se había vencido o cerrado
  db.prepare("UPDATE ride_offers SET status = 'rechazada', responded_at = datetime('now') WHERE id = ?").run(offer.id);
  realtime.notifyDriver(offer.driver_id, "offer_closed", { rideId, offerId: offer.id, reason: "rechazada" });
  res.json({ ok: true });
});

// --- Anticipo del taxi foráneo ---

// Carga el viaje y confirma que quien llama es el pasajero de ESE viaje.
function riderOwnsRide(req, res, rideId) {
  const { riderPhone, riderPin } = req.body || {};
  if (isRateLimited(req.ip)) {
    res.status(429).json({ error: RATE_LIMIT_MESSAGE });
    return null;
  }
  const ride = db.prepare("SELECT * FROM rides WHERE id = ?").get(rideId);
  if (!ride) {
    res.status(404).json({ error: "Viaje no encontrado" });
    return null;
  }
  const riderMatch = riderPhone && riderPin
    ? db.prepare("SELECT id FROM riders WHERE phone = ? AND pin = ?").get(riderPhone, riderPin)
    : null;
  if (!riderMatch || ride.rider_phone !== riderPhone) {
    recordFailedAttempt(req.ip);
    res.status(401).json({ error: "Teléfono o PIN incorrectos" });
    return null;
  }
  clearAttempts(req.ip);
  return ride;
}

// Igual, pero para el chofer asignado a ese viaje.
function driverOwnsRide(req, res, rideId) {
  const { driverId, pin } = req.body || {};
  if (isRateLimited(req.ip)) {
    res.status(429).json({ error: RATE_LIMIT_MESSAGE });
    return null;
  }
  if (!driverId || !pin || !driverPinValid(driverId, pin)) {
    recordFailedAttempt(req.ip);
    res.status(401).json({ error: "PIN incorrecto" });
    return null;
  }
  clearAttempts(req.ip);
  const ride = db.prepare("SELECT * FROM rides WHERE id = ?").get(rideId);
  if (!ride || ride.driver_id !== Number(driverId)) {
    res.status(404).json({ error: "Viaje no encontrado" });
    return null;
  }
  return ride;
}

const ACTIVE_STATUSES = ["aceptado", "llegue", "en_curso"];

// El pasajero sube la foto del comprobante. Se puede volver a subir si el
// chofer dijo que no le llegó ('rechazado') o si se equivocó de foto antes
// de que el chofer lo revise ('enviado').
router.post("/rides/:id/deposit/receipt", (req, res) => {
  const rideId = Number(req.params.id);
  const ride = riderOwnsRide(req, res, rideId);
  if (!ride) return;
  if (!ACTIVE_STATUSES.includes(ride.status) || !["pendiente", "enviado", "rechazado"].includes(ride.deposit_status)) {
    return res.status(409).json({ error: "Este viaje ya no está esperando anticipo" });
  }
  const { image } = req.body;
  if (typeof image !== "string" || !/^data:image\/(jpeg|png|webp);base64,/.test(image)) {
    return res.status(400).json({ error: "Sube una foto del comprobante" });
  }
  if (image.length > MAX_RECEIPT_LENGTH) {
    return res.status(413).json({ error: "La foto pesa demasiado, intenta con otra" });
  }

  db.prepare(
    "UPDATE rides SET deposit_receipt = ?, deposit_receipt_at = datetime('now'), deposit_status = 'enviado', updated_at = datetime('now') WHERE id = ?"
  ).run(image, rideId);
  realtime.notifyDriver(ride.driver_id, "deposit_receipt", { rideId });
  res.json({ ok: true, status: "enviado" });
});

// El chofer ve el comprobante (solo él, con su PIN).
router.post("/rides/:id/deposit/receipt/view", (req, res) => {
  const ride = driverOwnsRide(req, res, Number(req.params.id));
  if (!ride) return;
  if (!ride.deposit_receipt) return res.status(404).json({ error: "El pasajero todavía no sube el comprobante" });
  res.json({ image: ride.deposit_receipt, uploadedAt: ride.deposit_receipt_at });
});

// El chofer decide sobre el anticipo:
//   confirm → ya lo vio en SU banco (no basta la foto: puede estar editada)
//   reject  → no le ha llegado; el pasajero puede volver a subir comprobante
//   waive   → quita el anticipo (ej. el pasajero no tiene cómo depositar y
//             el chofer decide ir de todos modos, cobrando todo al llegar)
const DEPOSIT_ACTIONS = {
  confirm: { from: ["pendiente", "enviado", "rechazado"], to: "confirmado" },
  reject: { from: ["enviado"], to: "rechazado" },
  waive: { from: ["pendiente", "enviado", "rechazado"], to: null },
};

router.post("/rides/:id/deposit/:action", (req, res) => {
  const action = DEPOSIT_ACTIONS[req.params.action];
  if (!action) return res.status(404).json({ error: "Acción no válida" });
  const rideId = Number(req.params.id);
  const ride = driverOwnsRide(req, res, rideId);
  if (!ride) return;
  if (!ACTIVE_STATUSES.includes(ride.status) || !action.from.includes(ride.deposit_status)) {
    return res.status(409).json({ error: "El anticipo de este viaje ya no se puede cambiar" });
  }

  if (action.to === "confirmado") {
    db.prepare(
      "UPDATE rides SET deposit_status = 'confirmado', deposit_confirmed_at = datetime('now'), updated_at = datetime('now') WHERE id = ?"
    ).run(rideId);
  } else if (action.to === "rechazado") {
    db.prepare("UPDATE rides SET deposit_status = 'rechazado', updated_at = datetime('now') WHERE id = ?").run(rideId);
  } else {
    // Sin anticipo: se borra todo rastro (incluida la foto), como si nunca se
    // hubiera pedido — no hay nada que el registro deba conservar.
    db.prepare(
      `UPDATE rides SET deposit_status = NULL, deposit_amount = NULL, deposit_bank = NULL, deposit_account = NULL,
              deposit_holder = NULL, deposit_receipt = NULL, deposit_receipt_at = NULL, updated_at = datetime('now')
       WHERE id = ?`
    ).run(rideId);
  }

  const updated = db.prepare("SELECT * FROM rides WHERE id = ?").get(rideId);
  realtime.notifyRide(rideId, "deposit_update", { deposit: depositInfo(updated) });
  res.json({ ok: true, deposit: depositInfo(updated) });
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

  const arrivedAt = Date.now();
  const result = db
    .prepare(
      "UPDATE rides SET status = 'llegue', arrived_at_ms = ?, updated_at = datetime('now') WHERE id = ? AND driver_id = ? AND status = 'aceptado'"
    )
    .run(arrivedAt, rideId, driverId);

  if (result.changes === 0) {
    return res.status(409).json({ error: "No se pudo actualizar el viaje" });
  }

  realtime.notifyRide(rideId, "status_change", { status: "llegue", arrivedAt });
  res.json({ ok: true, arrivedAt });
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

  // El precio del taxi ya se capturó al aceptar (ver /accept) — aquí solo
  // se cambia el estado, sin tocar agreed_price.
  const startedAt = Date.now();
  const result = db
    .prepare(
      "UPDATE rides SET status = 'en_curso', started_at_ms = ?, updated_at = datetime('now') WHERE id = ? AND driver_id = ? AND status = 'llegue'"
    )
    .run(startedAt, rideId, driverId);

  if (result.changes === 0) {
    return res.status(409).json({ error: "No se pudo actualizar el viaje" });
  }

  realtime.notifyRide(rideId, "status_change", { status: "en_curso", startedAt });
  res.json({ ok: true, startedAt });
});

// Espera manual del taxi (paradas en el camino). El chofer manda su estado
// (tiempo acumulado y, si está corriendo, desde hace cuánto) y aquí se pasa
// al reloj del servidor, para que el pasajero vea lo mismo aunque los
// relojes de los dos celulares no estén iguales.
router.post("/rides/:id/wait", (req, res) => {
  const rideId = Number(req.params.id);
  const { driverId, pin, totalMs, runningForMs } = req.body;
  if (!driverId || !pin) return res.status(400).json({ error: "Falta driverId o PIN" });
  if (isRateLimited(req.ip)) {
    return res.status(429).json({ error: RATE_LIMIT_MESSAGE });
  }
  if (!driverPinValid(driverId, pin)) {
    recordFailedAttempt(req.ip);
    return res.status(401).json({ error: "PIN incorrecto" });
  }
  clearAttempts(req.ip);

  const SIX_HOURS = 6 * 60 * 60 * 1000;
  const total = Number(totalMs);
  const runningFor = runningForMs == null ? null : Number(runningForMs);
  if (!Number.isFinite(total) || total < 0 || total > SIX_HOURS ||
      (runningFor !== null && (!Number.isFinite(runningFor) || runningFor < 0 || runningFor > SIX_HOURS))) {
    return res.status(400).json({ error: "Tiempo de espera inválido" });
  }
  const since = runningFor === null ? null : Date.now() - runningFor;
  const result = db
    .prepare(
      "UPDATE rides SET stop_wait_total_ms = ?, stop_wait_since_ms = ? WHERE id = ? AND driver_id = ? AND ride_type = 'taxi' AND status = 'en_curso'"
    )
    .run(Math.round(total), since, rideId, driverId);
  if (result.changes === 0) {
    return res.status(409).json({ error: "No se pudo actualizar la espera" });
  }

  realtime.notifyRide(rideId, "wait_update", { totalMs: Math.round(total), runningSince: since });
  res.json({ ok: true });
});

router.post("/rides/:id/complete", (req, res) => {
  const rideId = Number(req.params.id);
  const { driverId, pin, agreedPrice } = req.body;
  if (!driverId || !pin) return res.status(400).json({ error: "Falta driverId o PIN" });
  if (isRateLimited(req.ip)) {
    return res.status(429).json({ error: RATE_LIMIT_MESSAGE });
  }
  if (!driverPinValid(driverId, pin)) {
    recordFailedAttempt(req.ip);
    return res.status(401).json({ error: "PIN incorrecto" });
  }
  clearAttempts(req.ip);

  const ride = db.prepare("SELECT ride_type, agreed_price FROM rides WHERE id = ?").get(rideId);
  // El precio del taxi ya se capturó al aceptar (ver /accept) — aquí solo se
  // vuelve a pedir si por alguna razón no quedó guardado entonces (viajes
  // viejos, o un reintento). Si el chofer manda uno nuevo aquí, se respeta
  // (algo pudo cambiar de verdad a medio viaje), pero ya no es obligatorio
  // volver a escribirlo si no cambió nada.
  const finalPrice = Number(agreedPrice) > 0 ? Number(agreedPrice) : ride?.agreed_price;
  if (ride?.ride_type === "taxi" && !(finalPrice > 0)) {
    return res.status(400).json({ error: "Falta el precio acordado con el pasajero" });
  }

  const result = db
    .prepare(
      "UPDATE rides SET status = 'completado', agreed_price = ?, updated_at = datetime('now') WHERE id = ? AND driver_id = ? AND status = 'en_curso'"
    )
    .run(ride?.ride_type === "taxi" ? finalPrice : null, rideId, driverId);

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
  realtime.closeOpenOffers(rideId, "cerrada");

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
