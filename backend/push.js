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

// ---- Avisos al pasajero ("✅ Pedro aceptó tu viaje", "📍 Ya llegó por ti") ----
// A diferencia del chofer, estos SÍ llevan texto (nombre del chofer, el
// mensaje del chat), así que van cifrados de punta a punta (RFC 8291,
// aes128gcm): el servicio de push de Google/Apple no puede leerlos. La
// suscripción se guarda por VIAJE y se da de alta con el token del viaje, así
// sirve igual para quien pide para sí mismo y, más adelante, para la familia
// que pide por otra persona. Al terminar el viaje se borra.
db.exec(`
  CREATE TABLE IF NOT EXISTS rider_push_subs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    ride_id INTEGER NOT NULL REFERENCES rides(id),
    endpoint TEXT NOT NULL,
    p256dh TEXT NOT NULL,
    auth TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE (ride_id, endpoint)
  );
`);

function hkdfExpand(prk, info, length) {
  return crypto.createHmac("sha256", prk).update(Buffer.concat([info, Buffer.from([1])])).digest().subarray(0, length);
}

function encryptPayload(p256dhB64, authB64, text) {
  const uaPublic = Buffer.from(p256dhB64, "base64url");
  const authSecret = Buffer.from(authB64, "base64url");
  const ecdh = crypto.createECDH("prime256v1");
  const asPublic = ecdh.generateKeys();
  const shared = ecdh.computeSecret(uaPublic);
  const prkKey = crypto.createHmac("sha256", authSecret).update(shared).digest();
  const ikm = hkdfExpand(prkKey, Buffer.concat([Buffer.from("WebPush: info\0"), uaPublic, asPublic]), 32);
  const salt = crypto.randomBytes(16);
  const prk = crypto.createHmac("sha256", salt).update(ikm).digest();
  const cek = hkdfExpand(prk, Buffer.from("Content-Encoding: aes128gcm\0"), 16);
  const nonce = hkdfExpand(prk, Buffer.from("Content-Encoding: nonce\0"), 12);
  const cipher = crypto.createCipheriv("aes-128-gcm", cek, nonce);
  // 0x02 = último (y único) bloque del mensaje.
  const body = Buffer.concat([cipher.update(Buffer.concat([Buffer.from(text), Buffer.from([2])])), cipher.final(), cipher.getAuthTag()]);
  const rs = Buffer.alloc(4);
  rs.writeUInt32BE(4096);
  return Buffer.concat([salt, rs, Buffer.from([asPublic.length]), asPublic, body]);
}

function isValidRiderKeys(p256dh, auth) {
  try {
    const pub = Buffer.from(String(p256dh), "base64url");
    const sec = Buffer.from(String(auth), "base64url");
    return pub.length === 65 && pub[0] === 4 && sec.length === 16;
  } catch { return false; }
}

async function sendToRider(sub, message) {
  try {
    const res = await fetch(sub.endpoint, {
      method: "POST",
      headers: {
        Authorization: vapidHeader(sub.endpoint),
        TTL: "600",
        Urgency: "high",
        "Content-Encoding": "aes128gcm",
        "Content-Type": "application/octet-stream",
      },
      body: encryptPayload(sub.p256dh, sub.auth, JSON.stringify({ kind: "rider", ...message })),
    });
    if (res.status === 404 || res.status === 410) {
      db.prepare("DELETE FROM rider_push_subs WHERE id = ?").run(sub.id);
    } else if (!res.ok) {
      console.warn("[push] respuesta", res.status, "viaje", sub.ride_id);
    }
  } catch (e) {
    console.warn("[push] error", e.message);
  }
}

const firstName = (name) => String(name || "").trim().split(/\s+/)[0] || "Tu chofer";

// Qué aviso le toca al pasajero por cada evento del viaje (los mismos que ya
// recibe su app abierta por WebSocket). null = ese evento no avisa.
function riderMessage(ride, type, payload) {
  const tag = `viaje-${ride.id}`;
  const driverName = () => {
    const d = ride.driver_id && db.prepare("SELECT name FROM drivers WHERE id = ?").get(ride.driver_id);
    return firstName(d && d.name);
  };
  // Viaje pedido para otra persona (ver familyRides.js): el aviso habla de ella.
  const para = ride.for_name;
  if (type === "ride_accepted") {
    const vehiculo = ride.ride_type === "taxi" ? "El taxi" : "El mototaxi";
    return para
      ? { tag, title: `✅ ${firstName(payload.name)} va por ${para}`, body: `${vehiculo} ya va en camino por ${para}.` }
      : { tag, title: `✅ ${firstName(payload.name)} aceptó tu viaje`, body: `${vehiculo.replace("El", "Tu")} ya va en camino por ti.` };
  }
  if (type === "offer_new") {
    return { tag: `oferta-${ride.id}`, title: "🚕 Te llegó una oferta de taxi", body: `$${payload.price} · Tócala para verla antes de que se venza.` };
  }
  if (type === "status_change" && payload.status === "llegue") {
    return para
      ? { tag, title: `📍 El chofer ya llegó por ${para}`, body: `${driverName()} está esperando a ${para}.` }
      : { tag, title: "📍 Tu chofer ya llegó por ti", body: `${driverName()} te está esperando.` };
  }
  // "Ya llegó": solo cuando se pidió para otra persona (quien viaja no necesita
  // que le avisen que llegó). Es el aviso que deja dormir tranquila a la familia.
  // De noche (8pm-6am, hora de Yucatán) se agrega "Ya puedes descansar"; siempre
  // se dan las gracias.
  if (type === "status_change" && payload.status === "completado" && para) {
    const hora = new Date(Date.now() - 6 * 3600 * 1000).getUTCHours();
    const deNoche = hora >= 20 || hora < 6;
    return {
      tag,
      title: `✅ ${para} ya llegó`,
      body: `${driverName()} terminó el viaje.${deNoche ? " Ya puedes descansar." : ""} Gracias por confiar en MotoVecino.`,
    };
  }
  // Viaje propio: al terminar se le invita a calificar (al abrir la app le sale
  // "¿Tuviste buen servicio?", ver restoreActiveRide en pasajero.html).
  if (type === "status_change" && payload.status === "completado") {
    const chofer = driverName();
    return { tag, title: "✅ Llegaste a tu destino", body: `¿Qué tal te fue con ${chofer}? Toca para calificarlo. Gracias por confiar en MotoVecino.` };
  }
  if (type === "status_change" && payload.status === "cancelado" && ride.cancelled_by !== "rider") {
    return { tag, title: "Tu viaje se canceló", body: "Puedes pedir otro desde la app." };
  }
  if (type === "no_drivers_available") {
    return { tag, title: "😕 No encontramos chofer esta vez", body: "Intenta de nuevo en unos minutos." };
  }
  if (type === "chat" && payload.text) {
    return { tag: `chat-${ride.id}`, title: `💬 ${driverName()}`, body: String(payload.text).slice(0, 140) };
  }
  return null;
}

const RIDER_PUSH_TYPES = new Set(["ride_accepted", "offer_new", "status_change", "no_drivers_available", "chat"]);
const RIDE_OVER = new Set(["completado", "cancelado"]);

// Se llama desde realtime.notifyRide con cada evento del viaje. La ubicación
// del chofer (cada pocos segundos) se descarta aquí mismo, sin tocar la base.
// onScreen = celulares que tienen la app del pasajero en pantalla ahorita.
function notifyRider(rideId, type, payload, onScreen) {
  if (!RIDER_PUSH_TYPES.has(type)) return;
  const subs = db.prepare("SELECT id, ride_id, endpoint, p256dh, auth FROM rider_push_subs WHERE ride_id = ?").all(rideId);
  if (!subs.length) return;
  const ride = db.prepare("SELECT id, ride_type, status, driver_id, cancelled_by, for_name FROM rides WHERE id = ?").get(rideId);
  if (!ride) return;
  const message = riderMessage(ride, type, payload || {});
  const sends = message ? subs.filter((s) => !(onScreen && onScreen.has(s.endpoint))).map((s) => sendToRider(s, message)) : [];
  // El viaje terminó: ya no hay nada más que avisar.
  if (RIDE_OVER.has(ride.status) && (type === "status_change" || type === "no_drivers_available")) {
    Promise.allSettled(sends).then(() => db.prepare("DELETE FROM rider_push_subs WHERE ride_id = ?").run(rideId));
  }
}

function saveRiderSubscription(rideId, endpoint, p256dh, auth) {
  db.prepare(
    `INSERT INTO rider_push_subs (ride_id, endpoint, p256dh, auth) VALUES (?, ?, ?, ?)
     ON CONFLICT(ride_id, endpoint) DO UPDATE SET p256dh = excluded.p256dh, auth = excluded.auth`
  ).run(rideId, endpoint, p256dh, auth);
}

module.exports = {
  getKeys, notifyNewRide, setWantsRides, saveSubscription, removeSubscription, isValidEndpoint,
  notifyRider, saveRiderSubscription, isValidRiderKeys, encryptPayload,
};
