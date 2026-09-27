// Avisos push al chofer con la app cerrada o la pantalla apagada ("🛵 Nuevo
// viaje cerca de ti"). Web Push estándar con llaves VAPID, sin librerías y sin
// contenido en el mensaje: el aviso es genérico y el detalle del viaje lo ve
// al abrir la app (así no hay que cifrar nada ni viajan datos del pasajero).
//
// A quién se le avisa: choferes que se pusieron "Disponible" (wants_rides) y
// no se desconectaron a propósito — cerrar la app NO cuenta como
// desconectarse. Si se le olvida desconectarse, deja de sonar solo tras
// WANTS_RIDES_HOURS.
const crypto = require("node:crypto");
const db = require("./db");

const WANTS_RIDES_HOURS = 14;
// Radio desde la última ubicación conocida del chofer: más amplio que el de la
// app abierta porque, con la app cerrada, esa ubicación puede ser de hace rato.
const PUSH_RADIUS_KM = { moto: 8, taxi: 60 };
const CONTACT = "https://motovecinoapp.com";

db.exec(`
  CREATE TABLE IF NOT EXISTS push_keys (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    public_key TEXT NOT NULL,
    private_pem TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS driver_push_subs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    driver_id INTEGER NOT NULL REFERENCES drivers(id),
    endpoint TEXT NOT NULL UNIQUE,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    last_ok_at TEXT
  );
`);
for (const [col, type] of [["wants_rides", "INTEGER NOT NULL DEFAULT 0"], ["wants_rides_at", "TEXT"]]) {
  try { db.exec(`ALTER TABLE drivers ADD COLUMN ${col} ${type}`); } catch { /* ya existe */ }
}

const b64url = (buf) => Buffer.from(buf).toString("base64url");

// Las llaves se crean una sola vez y se guardan en la base (vive en el disco
// persistente y entra en los respaldos): si cambiaran, todos los choferes
// tendrían que volver a activar sus avisos.
function getKeys() {
  let row = db.prepare("SELECT public_key, private_pem FROM push_keys WHERE id = 1").get();
  if (!row) {
    const { publicKey, privateKey } = crypto.generateKeyPairSync("ec", { namedCurve: "prime256v1" });
    const jwk = publicKey.export({ format: "jwk" });
    const raw = Buffer.concat([Buffer.from([4]), Buffer.from(jwk.x, "base64url"), Buffer.from(jwk.y, "base64url")]);
    row = { public_key: b64url(raw), private_pem: privateKey.export({ format: "pem", type: "pkcs8" }) };
    db.prepare("INSERT OR IGNORE INTO push_keys (id, public_key, private_pem) VALUES (1, ?, ?)").run(row.public_key, row.private_pem);
    row = db.prepare("SELECT public_key, private_pem FROM push_keys WHERE id = 1").get();
  }
  return row;
}

function vapidHeader(endpoint) {
  const { public_key, private_pem } = getKeys();
  const header = b64url(JSON.stringify({ typ: "JWT", alg: "ES256" }));
  const payload = b64url(JSON.stringify({ aud: new URL(endpoint).origin, exp: Math.floor(Date.now() / 1000) + 12 * 3600, sub: CONTACT }));
  const sig = crypto.sign("sha256", Buffer.from(`${header}.${payload}`), { key: private_pem, dsaEncoding: "ieee-p1363" });
  return `vapid t=${header}.${payload}.${b64url(sig)}, k=${public_key}`;
}

// Solo se aceptan servicios de push conocidos (Chrome/Android, Firefox,
// Safari/iPhone, Edge): el servidor nunca le hace peticiones a una URL
// cualquiera que mande el navegador.
const PUSH_HOSTS = [/\.googleapis\.com$/, /\.mozilla\.com$/, /\.push\.apple\.com$/, /\.notify\.windows\.com$/];
function isValidEndpoint(endpoint) {
  try {
    const u = new URL(endpoint);
    return u.protocol === "https:" && PUSH_HOSTS.some((re) => re.test(u.hostname));
  } catch { return false; }
}

async function sendOne(sub) {
  try {
    const res = await fetch(sub.endpoint, {
      method: "POST",
      headers: { Authorization: vapidHeader(sub.endpoint), TTL: "120", Urgency: "high", "Content-Length": "0" },
    });
    if (res.status === 404 || res.status === 410) {
      db.prepare("DELETE FROM driver_push_subs WHERE id = ?").run(sub.id); // el chofer quitó el permiso o desinstaló
    } else if (res.ok) {
      db.prepare("UPDATE driver_push_subs SET last_ok_at = datetime('now') WHERE id = ?").run(sub.id);
    } else {
      console.warn("[push] respuesta", res.status, "chofer", sub.driver_id);
    }
  } catch (e) {
    console.warn("[push] error", e.message);
  }
}

function haversineKm(lat1, lng1, lat2, lng2) {
  const R = 6371, rad = Math.PI / 180;
  const a = Math.sin(((lat2 - lat1) * rad) / 2) ** 2 + Math.cos(lat1 * rad) * Math.cos(lat2 * rad) * Math.sin(((lng2 - lng1) * rad) / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

// Se llama al crear un viaje (realtime.broadcastNewRide). A los choferes con
// la app abierta y visible no les sale doble: el service worker no muestra el
// aviso si la app del chofer está en pantalla.
function notifyNewRide(ride) {
  const type = ride.ride_type === "taxi" ? "taxi" : "moto";
  const drivers = db
    .prepare(
      `SELECT d.id, d.lat, d.lng FROM drivers d
       WHERE d.wants_rides = 1 AND d.wants_rides_at >= datetime('now', ?)
         AND d.vehicle_type = ? AND d.city = ? AND d.deleted_at IS NULL
         AND (d.cooldown_until IS NULL OR d.cooldown_until <= datetime('now'))
         AND NOT EXISTS (SELECT 1 FROM rides r WHERE r.driver_id = d.id AND r.status IN ('aceptado', 'llegue', 'en_curso'))
         AND EXISTS (SELECT 1 FROM driver_push_subs s WHERE s.driver_id = d.id)`
    )
    .all(`-${WANTS_RIDES_HOURS} hours`, type, ride.city || "tekax");
  const subsFor = db.prepare("SELECT id, driver_id, endpoint FROM driver_push_subs WHERE driver_id = ?");
  for (const d of drivers) {
    if (d.lat != null && d.lng != null && haversineKm(ride.pickup_lat, ride.pickup_lng, d.lat, d.lng) > PUSH_RADIUS_KM[type]) continue;
    for (const sub of subsFor.all(d.id)) sendOne(sub);
  }
}

// El chofer se puso "Disponible" (quiere trabajar) o "Desconectado" a propósito.
function setWantsRides(driverId, wants) {
  db.prepare("UPDATE drivers SET wants_rides = ?, wants_rides_at = datetime('now') WHERE id = ?").run(wants ? 1 : 0, driverId);
}

function saveSubscription(driverId, endpoint) {
  db.prepare(
    `INSERT INTO driver_push_subs (driver_id, endpoint) VALUES (?, ?)
     ON CONFLICT(endpoint) DO UPDATE SET driver_id = excluded.driver_id`
  ).run(driverId, endpoint);
}
function removeSubscription(driverId, endpoint) {
  db.prepare("DELETE FROM driver_push_subs WHERE driver_id = ? AND endpoint = ?").run(driverId, endpoint);
}

module.exports = { getKeys, notifyNewRide, setWantsRides, saveSubscription, removeSubscription, isValidEndpoint };
