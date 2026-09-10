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
      "UPDATE rides SET status = 'cancelado', updated_at = datetime('now') WHERE id = ?"
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

function attach(httpServer) {
  const wss = new WebSocketServer({ server: httpServer, path: "/ws" });

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
    .prepare("SELECT * FROM rides WHERE status = 'buscando' AND ride_type = ?")
    .all(driver.vehicle_type);
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
