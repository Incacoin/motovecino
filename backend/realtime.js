const { WebSocketServer } = require("ws");
const url = require("node:url");
const db = require("./db");
const { photoUrls } = require("./photos");
const { MAX_MATCH_DISTANCE_KM, MAX_MATCH_DISTANCE_KM_TAXI, ABANDONED_AFTER_MIN_TAXI, TAXI_SEARCH_MS, TAXI_OFFER_TTL_SEC } = require("./constants");

// driverId -> WebSocket
const driverSockets = new Map();
// rideId -> Set<WebSocket>
const rideSubscribers = new Map();
// rideId -> Timeout (cuenta regresiva de "chofer desconectado" -> "chofer perdido")
const disconnectTimers = new Map();
// rideId -> Timeout (cuenta regresiva de "nadie ha aceptado el viaje")
const noDriverTimers = new Map();
// El chat solo existe entre el chofer y el pasajero de un viaje YA aceptado.
// Antes de aceptar no hay chat: el precio del taxi se negocia con las ofertas
// (quedan registradas y son la base de la comisión) y así nadie se pasa el
// número para arreglar el viaje por fuera de la app.
const CHAT_STATUSES = ["aceptado", "llegue", "en_curso"];

// Tapa los números de teléfono en el chat (7 o más dígitos seguidos, aunque
// vengan separados por espacios, guiones, puntos o paréntesis) para que el
// viaje no se arregle por fuera de la app. Precios ($200) o calles (Calle 41)
// no llegan a 7 dígitos y pasan tal cual.
function maskPhones(text) {
  return text.replace(/\+?\d(?:[\s.\-()]*\d){6,}/g, (m) => m.replace(/\d/g, "•"));
}

// Ventana de gracia antes de avisarle al pasajero que el chofer no vuelve.
// Cubre un parpadeo normal de señal (el chofer reconecta solo, en ~2s) sin
// alarmar al pasajero de más; si pasa esto, algo de verdad se cayó.
const DISCONNECT_GRACE_MS = 20000;

// Cuánto esperar después de crear un viaje antes de avisarle al pasajero que
// no hay choferes disponibles. Si se queda "buscando" más de esto sin que
// nadie lo acepte, probablemente no hay oferta suficiente en ese momento.
const NO_DRIVER_GRACE_MS = 60000;

// El taxi negocia por ofertas (ver rides.js /offer), así que busca más tiempo.
function searchWindowMs(rideType) {
  return rideType === "taxi" ? TAXI_SEARCH_MS : NO_DRIVER_GRACE_MS;
}

// Si un pasajero o chofer se quedó a medias (app cerrada, celular apagado,
// etc.) con un viaje ya asignado, se da por abandonado tras esto — mismo
// límite que usaba antes la limpieza perezosa de GET /rides/:id.
const ABANDONED_AFTER_MIN = 60;

// Cada cuánto revisa el barrido de viajes vencidos (ver sweepStaleRides).
const SWEEP_INTERVAL_MS = 30000;

// Un chofer normalmente solo tiene un viaje activo a la vez, pero si su app se
// recargó a medio viaje (pantalla apagada, refresh) el viaje viejo se queda
// "aceptado" en la base aunque el chofer ya siga con otro. ORDER BY id DESC
// asegura que siempre agarremos el viaje que el chofer está atendiendo de
// verdad (el más reciente), no un viaje fantasma abandonado.
function activeRideForDriver(driverId) {
  return db
    .prepare(
      "SELECT id, driver_disconnected_at FROM rides WHERE driver_id = ? AND status IN ('aceptado', 'llegue', 'en_curso') ORDER BY id DESC LIMIT 1"
    )
    .get(driverId);
}

function handleDriverDisconnected(driverId) {
  const ride = activeRideForDriver(driverId);
  if (!ride) return;

  db.prepare("UPDATE rides SET driver_disconnected_at = datetime('now') WHERE id = ?").run(ride.id);
  notifyRide(ride.id, "driver_disconnected", {});

  const timer = setTimeout(() => {
    disconnectTimers.delete(ride.id);
    const current = db
      .prepare("SELECT status, driver_disconnected_at FROM rides WHERE id = ?")
      .get(ride.id);
    const stillStuck =
      current &&
      ["aceptado", "llegue", "en_curso"].includes(current.status) &&
      current.driver_disconnected_at &&
      !driverSockets.has(driverId);
    if (stillStuck) notifyRide(ride.id, "driver_lost", {});
  }, DISCONNECT_GRACE_MS);
  disconnectTimers.set(ride.id, timer);
}

function handleDriverReconnected(driverId) {
  const ride = activeRideForDriver(driverId);
  if (!ride || !ride.driver_disconnected_at) return;

  db.prepare("UPDATE rides SET driver_disconnected_at = NULL WHERE id = ?").run(ride.id);
  const timer = disconnectTimers.get(ride.id);
  if (timer) {
    clearTimeout(timer);
    disconnectTimers.delete(ride.id);
  }
  notifyRide(ride.id, "driver_reconnected", {});
}

function startNoDriverTimer(rideId, rideType) {
  const timer = setTimeout(() => {
    noDriverTimers.delete(rideId);
    const ride = db.prepare("SELECT status FROM rides WHERE id = ?").get(rideId);
    if (!ride || ride.status !== "buscando") return;

    db.prepare(
      "UPDATE rides SET status = 'cancelado', updated_at = datetime('now'), cancelled_by = 'system', cancel_reason = 'Nadie lo tomó a tiempo' WHERE id = ?"
    ).run(rideId);
    closeOpenOffers(rideId, "cerrada");
    notifyRide(rideId, "no_drivers_available", {});
    broadcastRideRemoved(rideId);
  }, searchWindowMs(rideType));
  noDriverTimers.set(rideId, timer);
}

function clearNoDriverTimer(rideId) {
  const timer = noDriverTimers.get(rideId);
  if (timer) {
    clearTimeout(timer);
    noDriverTimers.delete(rideId);
  }
}

// Cierra solo, sin que nadie tenga que pedirlo, cualquier viaje que ya se
// pasó de su tiempo — antes esto dependía de que alguien siguiera
// consultando ese viaje específico (GET /rides/:id) o de un setTimeout en
// memoria que se borra cada vez que el servidor reinicia (cada deploy).
// Un pasajero que pide un viaje y cierra la app sin cancelar dejaba el
// viaje "buscando" para siempre — y con notifyPendingRides ahora activo,
// ese viaje fantasma se le podía ofrecer a cualquier chofer que se
// conectara días después. Este barrido corre solo mientras el proceso esté
// vivo, sin depender de que nadie lo dispare.
function sweepStaleRides() {
  try {
    const stuckSearching = db
      .prepare(
        "SELECT id FROM rides WHERE status = 'buscando' AND (julianday('now') - julianday(created_at)) * 86400000 > CASE WHEN ride_type = 'taxi' THEN ? ELSE ? END"
      )
      .all(TAXI_SEARCH_MS, NO_DRIVER_GRACE_MS);
    for (const ride of stuckSearching) {
      db.prepare(
        "UPDATE rides SET status = 'cancelado', updated_at = datetime('now'), cancelled_by = 'system', cancel_reason = 'Nadie lo tomó a tiempo' WHERE id = ? AND status = 'buscando'"
      ).run(ride.id);
      clearNoDriverTimer(ride.id);
      closeOpenOffers(ride.id, "cerrada");
      notifyRide(ride.id, "no_drivers_available", {});
      broadcastRideRemoved(ride.id);
    }

    // Contraofertas de taxi que el pasajero no contestó a tiempo.
    const expiredOffers = db
      .prepare(
        "SELECT id, ride_id, driver_id FROM ride_offers WHERE status = 'pendiente' AND (julianday('now') - julianday(created_at)) * 86400 > ?"
      )
      .all(TAXI_OFFER_TTL_SEC);
    for (const offer of expiredOffers) {
      db.prepare("UPDATE ride_offers SET status = 'vencida', responded_at = datetime('now') WHERE id = ? AND status = 'pendiente'").run(offer.id);
      notifyDriver(offer.driver_id, "offer_closed", { rideId: offer.ride_id, offerId: offer.id, reason: "vencida" });
      notifyRide(offer.ride_id, "offer_removed", { offerId: offer.id });
    }

    // Se mide desde updated_at (el último cambio de estado real), no desde
    // created_at — un viaje largo que sigue avanzando de verdad (aceptado ->
    // llegue -> en_curso, cada paso resetea updated_at) nunca debe cancelarse
    // solo por llevar mucho tiempo pedido; lo que importa es que lleve mucho
    // tiempo SIN AVANZAR.
    // El taxi foráneo tiene más margen (ver ABANDONED_AFTER_MIN_TAXI): solo
    // llegar a una comisaría a ~50 km, esperando antes el anticipo, puede
    // pasar de una hora sin que el viaje cambie de estado.
    const stuckActive = db
      .prepare(
        `SELECT id, driver_id, ride_type FROM rides WHERE status IN ('aceptado', 'llegue', 'en_curso')
           AND (julianday('now') - julianday(updated_at)) * 24 * 60 > CASE WHEN ride_type = 'taxi' THEN ? ELSE ? END`
      )
      .all(ABANDONED_AFTER_MIN_TAXI, ABANDONED_AFTER_MIN);
    for (const ride of stuckActive) {
      const limitMin = ride.ride_type === "taxi" ? ABANDONED_AFTER_MIN_TAXI : ABANDONED_AFTER_MIN;
      db.prepare(
        "UPDATE rides SET status = 'cancelado', updated_at = datetime('now'), cancelled_by = 'system', cancel_reason = ? WHERE id = ?"
      ).run(`Abandonado automáticamente tras ${limitMin} min sin avanzar`, ride.id);
      if (ride.driver_id) {
        db.prepare("UPDATE drivers SET status = 'disponible' WHERE id = ?").run(ride.driver_id);
        notifyDriver(ride.driver_id, "ride_cancelled", { rideId: ride.id });
      }
      clearDisconnectTimer(ride.id);
      clearNoDriverTimer(ride.id);
      // El pasajero escucha "status_change" (igual que /cancel y el resto
      // del ciclo de vida del viaje), no "ride_cancelled" — ese tipo es solo
      // para el canal del chofer. Mandar el equivocado aquí dejaba al
      // pasajero pegado en la pantalla de viaje activo para siempre.
      notifyRide(ride.id, "status_change", { status: "cancelado" });
    }
  } catch (err) {
    // Un error aquí (ej. la base ocupada un instante) no debe tumbar todo el
    // servidor — este intervalo corre para siempre en segundo plano, sin la
    // red de seguridad que Express ya le da a las rutas normales.
    console.error("[sweepStaleRides] error:", err);
  }
}

function attach(httpServer) {
  const wss = new WebSocketServer({ server: httpServer, path: "/ws" });
  setInterval(sweepStaleRides, SWEEP_INTERVAL_MS);

  wss.on("connection", (ws, req) => {
    const { query } = url.parse(req.url, true);

    if (query.role === "driver") {
      const driverId = Number(query.driverId);
      // El id de chofer es consecutivo y adivinable — sin exigir también su
      // PIN (igual que cualquier ruta REST de chofer), cualquiera podía
      // conectarse "como" otro chofer sin credenciales: mandar su ubicación
      // falsa, tumbarle la sesión real, o escribirle a sus pasajeros.
      const driver = driverId && query.pin
        ? db.prepare("SELECT id FROM drivers WHERE id = ? AND pin = ? AND deleted_at IS NULL").get(driverId, query.pin)
        : null;
      if (!driver) {
        ws.close(4004, "unknown driver");
        return;
      }

      const existing = driverSockets.get(driverId);
      if (existing && existing.readyState === existing.OPEN) {
        existing.close(4001, "logged in elsewhere");
      }

      driverSockets.set(driverId, ws);
      handleDriverReconnected(driverId);

      // Cierra cualquier sesión que se haya quedado abierta (el socket
      // viejo de "logged in elsewhere" todavía no dispara su 'close', o el
      // servidor se reinició con el chofer conectado) antes de abrir una
      // nueva, para que nunca queden dos sesiones abiertas a la vez ni una
      // colgada para siempre.
      db.prepare(
        "UPDATE driver_activity_log SET disconnected_at = datetime('now') WHERE driver_id = ? AND disconnected_at IS NULL"
      ).run(driverId);
      db.prepare("INSERT INTO driver_activity_log (driver_id) VALUES (?)").run(driverId);

      ws.on("message", (raw) => {
        let msg;
        try {
          msg = JSON.parse(raw.toString());
        } catch {
          return;
        }

        if (msg.type === "location") {
          const { lat, lng } = msg;
          db.prepare(
            "UPDATE drivers SET lat = ?, lng = ?, last_seen = datetime('now') WHERE id = ?"
          ).run(lat, lng, driverId);

          const activeRide = activeRideForDriver(driverId);
          if (activeRide) {
            notifyRide(activeRide.id, "driver_location", { lat, lng });
          }
        } else if (msg.type === "status") {
          // Con un viaje en curso el chofer sigue "en_viaje" aunque su app mande
          // "disponible" (se reconectó, o la reabrió): si no, aparecía libre en
          // el mapa y le llegaban solicitudes de otros pasajeros a media carrera.
          const status =
            msg.status === "disponible" && activeRideForDriver(driverId) ? "en_viaje" : msg.status;
          db.prepare("UPDATE drivers SET status = ? WHERE id = ?").run(
            status,
            driverId
          );
          if (status === "disponible") notifyPendingRides(driverId);
        } else if (msg.type === "chat" && typeof msg.text === "string" && msg.text.trim()) {
          const text = maskPhones(msg.text.trim().slice(0, 300));
          const ride = activeRideForDriver(driverId);
          // activeRideForDriver ya filtra aceptado/llegue/en_curso.
          if (ride) {
            notifyRide(ride.id, "chat", { text, rideId: ride.id });
          }
        }
      });

      ws.on("close", () => {
        if (driverSockets.get(driverId) === ws) {
          driverSockets.delete(driverId);
          db.prepare(
            "UPDATE drivers SET status = 'offline' WHERE id = ?"
          ).run(driverId);
          db.prepare(
            "UPDATE driver_activity_log SET disconnected_at = datetime('now') WHERE driver_id = ? AND disconnected_at IS NULL"
          ).run(driverId);
          handleDriverDisconnected(driverId);
        }
      });
      return;
    }

    if (query.role === "rider") {
      const rideId = Number(query.rideId);
      // Mismo motivo que el rol "driver": el rideId es consecutivo. El token
      // (ver db.js/rides.js) es lo que de verdad limita esto a quien de
      // verdad tiene el viaje o recibió el enlace "Compartir", no a
      // cualquiera que pruebe ids seguidos.
      const ride = rideId && query.t
        ? db.prepare("SELECT id FROM rides WHERE id = ? AND share_token = ?").get(rideId, query.t)
        : null;
      if (!ride) {
        ws.close(4004, "unknown ride");
        return;
      }

      if (!rideSubscribers.has(rideId)) rideSubscribers.set(rideId, new Set());
      rideSubscribers.get(rideId).add(ws);

      ws.on("message", (raw) => {
        let msg;
        try {
          msg = JSON.parse(raw.toString());
        } catch {
          return;
        }
        if (msg.type === "chat" && typeof msg.text === "string" && msg.text.trim()) {
          const current = db.prepare("SELECT driver_id, status FROM rides WHERE id = ?").get(rideId);
          if (current?.driver_id && CHAT_STATUSES.includes(current.status)) {
            notifyDriver(current.driver_id, "chat", { text: maskPhones(msg.text.trim().slice(0, 300)), rideId });
          }
        }
      });

      ws.on("close", () => {
        rideSubscribers.get(rideId)?.delete(ws);
      });
      return;
    }

    ws.close(4000, "missing role");
  });

  return wss;
}

function send(ws, type, payload) {
  if (ws.readyState === ws.OPEN) {
    ws.send(JSON.stringify({ type, payload }));
  }
}

function notifyRide(rideId, type, payload) {
  const clients = rideSubscribers.get(rideId);
  if (!clients) return;
  for (const ws of clients) send(ws, type, payload);
}

function haversineKm(lat1, lng1, lat2, lng2) {
  const R = 6371;
  const dLat = ((lat2 - lat1) * Math.PI) / 180;
  const dLng = ((lng2 - lng1) * Math.PI) / 180;
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos((lat1 * Math.PI) / 180) * Math.cos((lat2 * Math.PI) / 180) * Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

// El chofer que de verdad toma el viaje recibe el teléfono completo del
// pasajero en la respuesta de /accept — este aviso es solo para que decida
// si le conviene aceptar, no hace falta el teléfono todavía, y mandárselo a
// varios choferes cercanos que ni siquiera van a tomar ese viaje era exponer
// el número de alguien a desconocidos de más.
function omitRiderPhone(ride) {
  const { rider_phone, ...rest } = ride;
  return rest;
}

function broadcastNewRide(ride) {
  const rideType = ride.ride_type === "taxi" ? "taxi" : "moto";
  const maxDistance = rideType === "taxi" ? MAX_MATCH_DISTANCE_KM_TAXI : MAX_MATCH_DISTANCE_KM;
  const available = db
    .prepare(
      "SELECT id, lat, lng FROM drivers WHERE status = 'disponible' AND vehicle_type = ? AND (cooldown_until IS NULL OR cooldown_until <= datetime('now'))"
    )
    .all(rideType);
  const payload = omitRiderPhone(ride);
  for (const driver of available) {
    if (driver.lat == null || driver.lng == null) continue;
    const distanceKm = haversineKm(ride.pickup_lat, ride.pickup_lng, driver.lat, driver.lng);
    if (distanceKm > maxDistance) continue;
    const ws = driverSockets.get(driver.id);
    if (ws) send(ws, "new_ride", payload);
  }
}

// Un chofer que se marca disponible (o reconecta) DESPUÉS de que ya se creó
// un viaje nunca se enteraba de él — broadcastNewRide solo avisa una vez, al
// momento de crear el viaje. Esto lo pone al día con lo que ya está
// esperando chofer y sigue dentro de su alcance real.
function notifyPendingRides(driverId) {
  const driver = db
    .prepare(
      "SELECT id, lat, lng, vehicle_type FROM drivers WHERE id = ? AND status = 'disponible' AND (cooldown_until IS NULL OR cooldown_until <= datetime('now'))"
    )
    .get(driverId);
  if (!driver || driver.lat == null || driver.lng == null) return;
  const ws = driverSockets.get(driverId);
  if (!ws) return;

  const pending = db
    .prepare(
      "SELECT * FROM rides WHERE status = 'buscando' AND ride_type = ? AND (julianday('now') - julianday(created_at)) * 86400000 <= ?"
    )
    .all(driver.vehicle_type, searchWindowMs(driver.vehicle_type));
  const maxDistance = driver.vehicle_type === "taxi" ? MAX_MATCH_DISTANCE_KM_TAXI : MAX_MATCH_DISTANCE_KM;
  for (const ride of pending) {
    const distanceKm = haversineKm(ride.pickup_lat, ride.pickup_lng, driver.lat, driver.lng);
    if (distanceKm > maxDistance) continue;
    const riderRow = db.prepare("SELECT id, photo FROM riders WHERE phone = ?").get(ride.rider_phone);
    const { trips } = db
      .prepare("SELECT COUNT(*) AS trips FROM rides WHERE rider_phone = ? AND status = 'completado'")
      .get(ride.rider_phone);
    send(ws, "new_ride", { ...omitRiderPhone(ride), riderTripCount: trips, riderPhoto: riderRow ? photoUrls("r", riderRow.id, riderRow.photo).photo : null });
  }
}

function broadcastRideTaken(rideId, winningDriverId) {
  for (const [driverId, ws] of driverSockets) {
    if (driverId !== winningDriverId) send(ws, "ride_taken", { rideId });
  }
}

function broadcastRideRemoved(rideId) {
  for (const ws of driverSockets.values()) send(ws, "ride_taken", { rideId });
}

function notifyDriver(driverId, type, payload) {
  const ws = driverSockets.get(driverId);
  if (ws) send(ws, type, payload);
}

function clearDisconnectTimer(rideId) {
  const timer = disconnectTimers.get(rideId);
  if (timer) {
    clearTimeout(timer);
    disconnectTimers.delete(rideId);
  }
}

// Cierra las contraofertas que sigan pendientes en ese viaje (el pasajero
// aceptó otra, canceló, o se venció la búsqueda) y le avisa a cada chofer
// para que su tarjeta deje de decir "esperando al pasajero".
function closeOpenOffers(rideId, newStatus, exceptOfferId) {
  const open = db
    .prepare("SELECT id, driver_id FROM ride_offers WHERE ride_id = ? AND status = 'pendiente' AND id != ?")
    .all(rideId, exceptOfferId || 0);
  for (const offer of open) {
    db.prepare("UPDATE ride_offers SET status = ?, responded_at = datetime('now') WHERE id = ?").run(newStatus, offer.id);
    notifyDriver(offer.driver_id, "offer_closed", { rideId, offerId: offer.id, reason: newStatus });
  }
}

module.exports = {
  attach,
  ABANDONED_AFTER_MIN,
  notifyRide,
  broadcastNewRide,
  broadcastRideTaken,
  broadcastRideRemoved,
  notifyDriver,
  clearDisconnectTimer,
  startNoDriverTimer,
  clearNoDriverTimer,
  closeOpenOffers,
};
