const { WebSocketServer } = require("ws");
const url = require("node:url");
const db = require("./db");

// driverId -> WebSocket
const driverSockets = new Map();
// rideId -> Set<WebSocket>
const rideSubscribers = new Map();
// rideId -> Timeout (cuenta regresiva de "chofer desconectado" -> "chofer perdido")
const disconnectTimers = new Map();
// rideId -> Timeout (cuenta regresiva de "nadie ha aceptado el viaje")
const noDriverTimers = new Map();
// rideId -> driverId: quién le escribió al pasajero antes de aceptar el viaje
// (para poder enrutar su respuesta), se limpia al aceptar/cancelar/completar.
const preAcceptContact = new Map();

// Ventana de gracia antes de avisarle al pasajero que el chofer no vuelve.
// Cubre un parpadeo normal de señal (el chofer reconecta solo, en ~2s) sin
// alarmar al pasajero de más; si pasa esto, algo de verdad se cayó.
const DISCONNECT_GRACE_MS = 20000;

// Cuánto esperar después de crear un viaje antes de avisarle al pasajero que
// no hay choferes disponibles. Si se queda "buscando" más de esto sin que
// nadie lo acepte, probablemente no hay oferta suficiente en ese momento.
const NO_DRIVER_GRACE_MS = 60000;

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

function startNoDriverTimer(rideId) {
  const timer = setTimeout(() => {
    noDriverTimers.delete(rideId);
    const ride = db.prepare("SELECT status FROM rides WHERE id = ?").get(rideId);
    if (!ride || ride.status !== "buscando") return;

    db.prepare(
      "UPDATE rides SET status = 'cancelado', updated_at = datetime('now'), cancelled_by = 'system', cancel_reason = 'Nadie lo tomó a tiempo' WHERE id = ?"
    ).run(rideId);
    notifyRide(rideId, "no_drivers_available", {});
    broadcastRideRemoved(rideId);
  }, NO_DRIVER_GRACE_MS);
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
        "SELECT id FROM rides WHERE status = 'buscando' AND (julianday('now') - julianday(created_at)) * 86400000 > ?"
      )
      .all(NO_DRIVER_GRACE_MS);
    for (const ride of stuckSearching) {
      db.prepare(
        "UPDATE rides SET status = 'cancelado', updated_at = datetime('now'), cancelled_by = 'system', cancel_reason = 'Nadie lo tomó a tiempo' WHERE id = ? AND status = 'buscando'"
      ).run(ride.id);
      clearNoDriverTimer(ride.id);
      notifyRide(ride.id, "no_drivers_available", {});
      broadcastRideRemoved(ride.id);
    }

    // Se mide desde updated_at (el último cambio de estado real), no desde
    // created_at — un viaje largo que sigue avanzando de verdad (aceptado ->
    // llegue -> en_curso, cada paso resetea updated_at) nunca debe cancelarse
    // solo por llevar mucho tiempo pedido; lo que importa es que lleve mucho
    // tiempo SIN AVANZAR.
    const stuckActive = db
      .prepare(
        "SELECT id, driver_id FROM rides WHERE status IN ('aceptado', 'llegue', 'en_curso') AND (julianday('now') - julianday(updated_at)) * 24 * 60 > ?"
      )
      .all(ABANDONED_AFTER_MIN);
    for (const ride of stuckActive) {
      db.prepare(
        "UPDATE rides SET status = 'cancelado', updated_at = datetime('now'), cancelled_by = 'system', cancel_reason = ? WHERE id = ?"
      ).run(`Abandonado automáticamente tras ${ABANDONED_AFTER_MIN} min sin avanzar`, ride.id);
      if (ride.driver_id) {
        db.prepare("UPDATE drivers SET status = 'disponible' WHERE id = ?").run(ride.driver_id);
        notifyDriver(ride.driver_id, "ride_cancelled", { rideId: ride.id });
      }
      clearDisconnectTimer(ride.id);
      clearNoDriverTimer(ride.id);
      clearPreAcceptContact(ride.id);
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
      const driver = driverId
        ? db.prepare("SELECT id FROM drivers WHERE id = ?").get(driverId)
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
          db.prepare("UPDATE drivers SET status = ? WHERE id = ?").run(
            msg.status,
            driverId
          );
          if (msg.status === "disponible") notifyPendingRides(driverId);
        } else if (msg.type === "chat" && typeof msg.text === "string" && msg.text.trim()) {
          const text = msg.text.trim().slice(0, 300);
          if (msg.rideId) {
            // Mensaje a una solicitud pendiente (todavía no aceptada) desde
            // la lista de viajes cercanos — validar que sigue disponible o
            // que ya es del propio chofer, para no dejar escribirle a
            // pasajeros de viajes de otros choferes.
            const rideId = Number(msg.rideId);
            const ride = db
              .prepare("SELECT id, driver_id, status FROM rides WHERE id = ?")
              .get(rideId);
            if (!ride) return;
            if (ride.driver_id && ride.driver_id !== driverId) return;
            if (!["buscando", "aceptado", "llegue", "en_curso"].includes(ride.status)) return;
            if (!ride.driver_id) preAcceptContact.set(rideId, driverId);
            notifyRide(rideId, "chat", { text, rideId });
          } else {
            const ride = activeRideForDriver(driverId);
            if (ride) notifyRide(ride.id, "chat", { text, rideId: ride.id });
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
      const ride = rideId
        ? db.prepare("SELECT id FROM rides WHERE id = ?").get(rideId)
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
          const current = db.prepare("SELECT driver_id FROM rides WHERE id = ?").get(rideId);
          const targetDriverId = current?.driver_id || preAcceptContact.get(rideId);
          if (targetDriverId) {
            notifyDriver(targetDriverId, "chat", { text: msg.text.trim().slice(0, 300), rideId });
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

// Un chofer que dejó su sesión "disponible" mientras anda en otro pueblo (o
// simplemente muy lejos de la recogida) no debería poder recibir ni aceptar
// un viaje que nunca podría cubrir de verdad.
const MAX_MATCH_DISTANCE_KM = 8;

function haversineKm(lat1, lng1, lat2, lng2) {
  const R = 6371;
  const dLat = ((lat2 - lat1) * Math.PI) / 180;
  const dLng = ((lng2 - lng1) * Math.PI) / 180;
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos((lat1 * Math.PI) / 180) * Math.cos((lat2 * Math.PI) / 180) * Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function broadcastNewRide(ride) {
  const rideType = ride.ride_type === "taxi" ? "taxi" : "moto";
  const available = db
    .prepare(
      "SELECT id, lat, lng FROM drivers WHERE status = 'disponible' AND vehicle_type = ? AND (cooldown_until IS NULL OR cooldown_until <= datetime('now'))"
    )
    .all(rideType);
  for (const driver of available) {
    if (driver.lat == null || driver.lng == null) continue;
    const distanceKm = haversineKm(ride.pickup_lat, ride.pickup_lng, driver.lat, driver.lng);
    if (distanceKm > MAX_MATCH_DISTANCE_KM) continue;
    const ws = driverSockets.get(driver.id);
    if (ws) send(ws, "new_ride", ride);
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
    .all(driver.vehicle_type, NO_DRIVER_GRACE_MS);
  for (const ride of pending) {
    const distanceKm = haversineKm(ride.pickup_lat, ride.pickup_lng, driver.lat, driver.lng);
    if (distanceKm > MAX_MATCH_DISTANCE_KM) continue;
    const riderRow = db.prepare("SELECT photo FROM riders WHERE phone = ?").get(ride.rider_phone);
    const { trips } = db
      .prepare("SELECT COUNT(*) AS trips FROM rides WHERE rider_phone = ? AND status = 'completado'")
      .get(ride.rider_phone);
    send(ws, "new_ride", { ...ride, riderTripCount: trips, riderPhoto: riderRow ? riderRow.photo : null });
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

function clearPreAcceptContact(rideId) {
  preAcceptContact.delete(rideId);
}

module.exports = {
  attach,
  ABANDONED_AFTER_MIN,
  notifyRide,
  broadcastNewRide,
  clearPreAcceptContact,
  broadcastRideTaken,
  broadcastRideRemoved,
  notifyDriver,
  clearDisconnectTimer,
  startNoDriverTimer,
  clearNoDriverTimer,
};
