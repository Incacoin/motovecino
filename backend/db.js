const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { DatabaseSync } = require("node:sqlite");
const { SERVICE_FEE_START_DATE } = require("./constants");
const { recomputeFounders } = require("./founders");

// En un clon nuevo (o un deploy limpio) esta carpeta no existe todavía —
// sin esto, SQLite no puede crear el archivo y truena con "unable to open
// database file".
const dataDir = path.join(__dirname, "data");
fs.mkdirSync(dataDir, { recursive: true });

const dbPath = path.join(dataDir, "motoya.db");
const db = new DatabaseSync(dbPath);

db.exec(`
  CREATE TABLE IF NOT EXISTS drivers (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    phone TEXT NOT NULL,
    vehicle TEXT,
    pin TEXT NOT NULL UNIQUE,
    status TEXT NOT NULL DEFAULT 'offline',
    lat REAL,
    lng REAL,
    last_seen TEXT,
    paid_until TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS rides (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    rider_name TEXT NOT NULL,
    rider_phone TEXT NOT NULL,
    pickup_lat REAL NOT NULL,
    pickup_lng REAL NOT NULL,
    pickup_label TEXT,
    dest_lat REAL,
    dest_lng REAL,
    dest_label TEXT,
    passengers INTEGER NOT NULL DEFAULT 1,
    status TEXT NOT NULL DEFAULT 'buscando',
    driver_id INTEGER REFERENCES drivers(id),
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS driver_applications (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    phone TEXT NOT NULL,
    photo TEXT,
    status TEXT NOT NULL DEFAULT 'pendiente',
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS driver_payments (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    driver_id INTEGER NOT NULL REFERENCES drivers(id),
    amount REAL NOT NULL,
    period_start TEXT,
    period_end TEXT,
    paid_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
`);

try {
  db.exec("ALTER TABLE drivers ADD COLUMN paid_until TEXT");
} catch {
  // la columna ya existe
}

try {
  db.exec("ALTER TABLE drivers ADD COLUMN vouched_by TEXT");
} catch {
  // la columna ya existe
}

try {
  db.exec("ALTER TABLE drivers ADD COLUMN vouched_at TEXT");
} catch {
  // la columna ya existe
}

try {
  db.exec("ALTER TABLE rides ADD COLUMN passengers INTEGER NOT NULL DEFAULT 1");
} catch {
  // la columna ya existe
}

try {
  db.exec("ALTER TABLE rides ADD COLUMN driver_disconnected_at TEXT");
} catch {
  // la columna ya existe
}

try {
  db.exec("ALTER TABLE drivers ADD COLUMN deleted_at TEXT");
} catch {
  // la columna ya existe
}

try {
  db.exec("ALTER TABLE drivers ADD COLUMN tipo TEXT NOT NULL DEFAULT 'informal'");
} catch {
  // la columna ya existe
}

try {
  db.exec("ALTER TABLE driver_applications ADD COLUMN photo TEXT");
} catch {
  // la columna ya existe
}

try {
  db.exec("ALTER TABLE driver_applications ADD COLUMN accepted_legal_at TEXT");
} catch {
  // la columna ya existe
}

try {
  db.exec("ALTER TABLE driver_applications ADD COLUMN accepted_legal_version TEXT");
} catch {
  // la columna ya existe
}

try {
  db.exec("ALTER TABLE rides ADD COLUMN rating INTEGER");
} catch {
  // la columna ya existe
}

try {
  db.exec("ALTER TABLE drivers ADD COLUMN accepted_legal_at TEXT");
} catch {
  // la columna ya existe
}

try {
  db.exec("ALTER TABLE drivers ADD COLUMN accepted_legal_version TEXT");
} catch {
  // la columna ya existe
}

try {
  db.exec("ALTER TABLE drivers ADD COLUMN photo TEXT");
} catch {
  // la columna ya existe
}

try {
  db.exec("ALTER TABLE drivers ADD COLUMN vehicle_type TEXT NOT NULL DEFAULT 'moto'");
} catch {
  // la columna ya existe
}

try {
  db.exec("ALTER TABLE rides ADD COLUMN ride_type TEXT NOT NULL DEFAULT 'moto'");
} catch {
  // la columna ya existe
}

// Precio que el chofer reporta al completar un viaje de taxi (se negocia
// directo con el pasajero, no tiene fórmula fija) — de ahí sale la comisión
// variable, a diferencia de moto que paga SERVICE_FEE fijo por viaje.
try {
  db.exec("ALTER TABLE rides ADD COLUMN agreed_price REAL");
} catch {
  // la columna ya existe
}

try {
  db.exec("ALTER TABLE driver_applications ADD COLUMN vehicle_type TEXT NOT NULL DEFAULT 'moto'");
} catch {
  // la columna ya existe
}

try {
  db.exec("ALTER TABLE rides ADD COLUMN cancelled_by TEXT");
} catch {
  // la columna ya existe
}

try {
  db.exec("ALTER TABLE rides ADD COLUMN cancel_reason TEXT");
} catch {
  // la columna ya existe
}

try {
  db.exec("ALTER TABLE drivers ADD COLUMN cancel_count INTEGER NOT NULL DEFAULT 0");
} catch {
  // la columna ya existe
}

try {
  db.exec("ALTER TABLE drivers ADD COLUMN cooldown_until TEXT");
} catch {
  // la columna ya existe
}

try {
  db.exec("ALTER TABLE drivers ADD COLUMN grupo TEXT");
} catch {
  // la columna ya existe
}

db.exec(`
  CREATE TABLE IF NOT EXISTS riders (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    phone TEXT NOT NULL UNIQUE,
    name TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    last_ride_at TEXT
  );
`);

try {
  db.exec("ALTER TABLE rides ADD COLUMN rider_id INTEGER REFERENCES riders(id)");
} catch {
  // la columna ya existe
}

// Backfill: da de alta un rider por cada teléfono que ya aparece en viajes
// viejos (de antes de que existiera esta tabla) y liga esos viajes con su
// rider_id. Es idempotente: solo toca teléfonos/viajes que aún no tienen dueño.
db.exec(`
  INSERT OR IGNORE INTO riders (phone, name, created_at, last_ride_at)
  SELECT rider_phone, rider_name, MIN(created_at), MAX(created_at)
  FROM rides
  GROUP BY rider_phone;

  UPDATE rides
  SET rider_id = (SELECT id FROM riders WHERE riders.phone = rides.rider_phone)
  WHERE rider_id IS NULL;
`);

try {
  db.exec("ALTER TABLE rides ADD COLUMN fee_settled_at TEXT");
} catch {
  // la columna ya existe
}

try {
  db.exec("ALTER TABLE driver_payments ADD COLUMN concept TEXT NOT NULL DEFAULT 'mensual'");
} catch {
  // la columna ya existe
}

try {
  db.exec("ALTER TABLE driver_payments ADD COLUMN ride_count INTEGER");
} catch {
  // la columna ya existe
}

try {
  db.exec("ALTER TABLE rides ADD COLUMN children INTEGER NOT NULL DEFAULT 0");
} catch {
  // la columna ya existe
}

// Los viajes completados antes de que la cuota por viaje existiera en Tekax
// se marcan como ya liquidados: no se le cobra a nadie de forma retroactiva.
// El filtro por fecha lo hace idempotente — al reiniciar el servidor no
// borra las cuotas realmente pendientes de viajes nuevos.
db.prepare(
  "UPDATE rides SET fee_settled_at = updated_at WHERE status = 'completado' AND fee_settled_at IS NULL AND date(updated_at) < date(?)"
).run(SERVICE_FEE_START_DATE);

try {
  db.exec("ALTER TABLE driver_applications ADD COLUMN signature TEXT");
} catch {
  // la columna ya existe
}

try {
  db.exec("ALTER TABLE drivers ADD COLUMN signature TEXT");
} catch {
  // la columna ya existe
}

try {
  db.exec("ALTER TABLE driver_applications ADD COLUMN grupo TEXT");
} catch {
  // la columna ya existe
}

try {
  db.exec("ALTER TABLE driver_applications ADD COLUMN tipo TEXT NOT NULL DEFAULT 'informal'");
} catch {
  // la columna ya existe
}

try {
  db.exec("ALTER TABLE driver_applications ADD COLUMN photo_placa TEXT");
} catch {
  // la columna ya existe
}

try {
  db.exec("ALTER TABLE drivers ADD COLUMN photo_placa TEXT");
} catch {
  // la columna ya existe
}

// Ciudad "de casa" de cada quien — de dónde es, no necesariamente dónde está
// parado ahora mismo (eso se resuelve por GPS en tiempo real, ver cities.js).
// Todo lo que ya existía en esta base es de Tekax, por eso el default.
try {
  db.exec("ALTER TABLE drivers ADD COLUMN city TEXT NOT NULL DEFAULT 'tekax'");
} catch {
  // la columna ya existe
}

try {
  db.exec("ALTER TABLE riders ADD COLUMN city TEXT NOT NULL DEFAULT 'tekax'");
} catch {
  // la columna ya existe
}

try {
  db.exec("ALTER TABLE rides ADD COLUMN city TEXT NOT NULL DEFAULT 'tekax'");
} catch {
  // la columna ya existe
}

try {
  db.exec("ALTER TABLE driver_applications ADD COLUMN city TEXT NOT NULL DEFAULT 'tekax'");
} catch {
  // la columna ya existe
}

// Corrige pasajeros que quedaron con city='tekax' por default aunque su
// viaje más reciente fue en otro pueblo (el registro nunca pedía ubicación,
// solo /rides la actualiza desde hace poco — ver routes/rides.js). Re-correr
// esto en cada arranque es inofensivo: solo alinea a cada quien con su
// viaje más reciente, y a quien nunca ha pedido viaje no lo toca.
db.exec(`
  UPDATE riders
  SET city = (
    SELECT city FROM rides WHERE rides.rider_id = riders.id ORDER BY updated_at DESC LIMIT 1
  )
  WHERE EXISTS (SELECT 1 FROM rides WHERE rides.rider_id = riders.id)
`);

// PIN del pasajero — igual que el del chofer, es lo que convierte "cualquiera
// escribe cualquier teléfono" en una cuenta real: una vez que un teléfono
// tiene PIN, hace falta para volver a usarlo. Nullable porque los riders que
// ya existían antes de esto (de antes de esta función) no tienen uno todavía
// — lo reciben la próxima vez que usen ese teléfono (ver routes/riders.js).
try {
  db.exec("ALTER TABLE riders ADD COLUMN pin TEXT");
} catch {
  // la columna ya existe
}
db.exec("CREATE UNIQUE INDEX IF NOT EXISTS idx_riders_pin ON riders(pin) WHERE pin IS NOT NULL");

// Cuenta las veces que un chofer canceló un viaje de este pasajero con el
// motivo exacto "El pasajero no llegó" — mismo patrón que cancel_count en
// drivers. Es solo un contador (nadie se bloquea automático); el admin lo ve
// en Pasajeros/Alertas y decide si contacta o restringe manualmente.
try {
  db.exec("ALTER TABLE riders ADD COLUMN no_show_count INTEGER NOT NULL DEFAULT 0");
} catch {
  // la columna ya existe
}

try {
  db.exec("ALTER TABLE riders ADD COLUMN photo TEXT");
} catch {
  // la columna ya existe
}

// Miniatura (~240px) de la foto de perfil. Los avatares y tarjetas usan esta
// versión chica; la foto grande solo se baja si alguien la abre. Si está en
// NULL (fotos anteriores a este cambio) se sirve la foto grande como respaldo.
try {
  db.exec("ALTER TABLE riders ADD COLUMN photo_thumb TEXT");
} catch {
  // la columna ya existe
}
try {
  db.exec("ALTER TABLE drivers ADD COLUMN photo_thumb TEXT");
} catch {
  // la columna ya existe
}

// Un solo lugar guardado ("Casa") para no escribir la dirección de cero cada
// vez que se pide un mandado o viaje repetido — no es una libreta de varios
// lugares, solo el caso de uso más frecuente (ver conversación con el
// usuario sobre mandados/medicinas a domicilio).
try {
  db.exec("ALTER TABLE riders ADD COLUMN home_lat REAL");
} catch {
  // la columna ya existe
}
try {
  db.exec("ALTER TABLE riders ADD COLUMN home_lng REAL");
} catch {
  // la columna ya existe
}
try {
  db.exec("ALTER TABLE riders ADD COLUMN home_label TEXT");
} catch {
  // la columna ya existe
}

// Contacto de emergencia: un botón directo en el viaje activo que manda el
// link de seguimiento en vivo a este número por WhatsApp, sin pasar por el
// menú general de compartir cada vez (ver seguir.html / shareRide()).
try {
  db.exec("ALTER TABLE riders ADD COLUMN emergency_contact_name TEXT");
} catch {
  // la columna ya existe
}
try {
  db.exec("ALTER TABLE riders ADD COLUMN emergency_contact_phone TEXT");
} catch {
  // la columna ya existe
}

// Qué es el viaje, no de qué tamaño (eso ya lo cubre ride_type moto/taxi):
// 'pasaje' (default, llevar a una persona), 'domicilio' (comida de una
// fonda) o 'mandado' (hacer una diligencia). Mismo precio para los tres —
// es solo una etiqueta para que el chofer sepa qué esperar antes de aceptar,
// no cambia la tarifa por distancia.
try {
  db.exec("ALTER TABLE rides ADD COLUMN service_kind TEXT NOT NULL DEFAULT 'pasaje'");
} catch {
  // la columna ya existe
}

// Contacto de emergencia del propio chofer — mismo campo que ya existe para
// riders, pero para el chofer no había ninguno: si tiene un accidente en la
// calle, hoy no hay a quién avisar desde la app.
try {
  db.exec("ALTER TABLE drivers ADD COLUMN emergency_contact_name TEXT");
} catch {
  // la columna ya existe
}
try {
  db.exec("ALTER TABLE drivers ADD COLUMN emergency_contact_phone TEXT");
} catch {
  // la columna ya existe
}
try {
  db.exec("ALTER TABLE driver_applications ADD COLUMN emergency_contact_name TEXT");
} catch {
  // la columna ya existe
}
try {
  db.exec("ALTER TABLE driver_applications ADD COLUMN emergency_contact_phone TEXT");
} catch {
  // la columna ya existe
}

// Quién invitó a este chofer — ya no hay gremios ni líder que avale a nadie,
// así que este campo (opcional, texto libre) es el único rastro informal de
// confianza que queda cuando alguien trae a su gente (ver conversación sobre
// Sergio y la ola de choferes de Tekax).
try {
  db.exec("ALTER TABLE drivers ADD COLUMN referred_by TEXT");
} catch {
  // la columna ya existe
}

// Insignia simbólica para los primeros choferes de cada ciudad — no depende
// de viajes ni de ninguna meta, solo de haberse dado de alta a tiempo (ver
// routes/admin.js, se marca al momento de crear el chofer).
try {
  db.exec("ALTER TABLE drivers ADD COLUMN es_fundador INTEGER NOT NULL DEFAULT 0");
} catch {
  // la columna ya existe
}

// Cuentas de prueba (del dueño o de pruebas internas): se marcan desde el
// admin para que no ocupen lugares de fundador — ver founders.js.
try {
  db.exec("ALTER TABLE drivers ADD COLUMN es_prueba INTEGER NOT NULL DEFAULT 0");
} catch {
  // la columna ya existe
}
// Lo mismo para pasajeros: sus viajes no cuentan en el resumen del admin.
try {
  db.exec("ALTER TABLE riders ADD COLUMN es_prueba INTEGER NOT NULL DEFAULT 0");
} catch {
  // la columna ya existe
}

// Recalcula los fundadores en cada arranque (también cubre a los choferes que
// ya estaban dados de alta antes de que existiera la insignia).
recomputeFounders(db);
try {
  db.exec("ALTER TABLE driver_applications ADD COLUMN referred_by TEXT");
} catch {
  // la columna ya existe
}

// Historial real de conexión/desconexión de cada chofer — a diferencia de
// drivers.status (un solo estado actual, se sobrescribe) esto permite saber
// cuánto tiempo estuvo conectado en un día dado y en cuántos días distintos
// se conectó, no solo "cuándo fue la última vez que se le vio".
db.exec(`
  CREATE TABLE IF NOT EXISTS driver_activity_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    driver_id INTEGER NOT NULL REFERENCES drivers(id),
    connected_at TEXT NOT NULL DEFAULT (datetime('now')),
    disconnected_at TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_driver_activity_log_driver_id ON driver_activity_log(driver_id);
`);

// Cuenta del chofer para recibir anticipos de viajes foráneos de taxi (ver
// routes/rides.js, /deposit/*). El dinero va DIRECTO del pasajero a esta
// cuenta — MotoVecino nunca lo toca, solo muestra a dónde depositar y lleva
// el registro. deposit_account es CLABE (18 dígitos) o tarjeta (16).
for (const col of ["deposit_bank", "deposit_account", "deposit_holder"]) {
  try {
    db.exec(`ALTER TABLE drivers ADD COLUMN ${col} TEXT`);
  } catch {
    // la columna ya existe
  }
}

// Anticipo de un viaje de taxi. Los datos de la cuenta se copian al viaje al
// aceptar (no se leen del chofer cada vez) para que el registro diga a qué
// cuenta se depositó aunque el chofer la cambie después.
// deposit_status: NULL (sin anticipo) | 'pendiente' (esperando depósito) |
// 'enviado' (el pasajero subió comprobante) | 'confirmado' (el chofer lo vio
// en su banco) | 'rechazado' (no le llegó; el pasajero puede volver a subir).
for (const [col, type] of [
  ["deposit_amount", "REAL"],
  ["deposit_status", "TEXT"],
  ["deposit_bank", "TEXT"],
  ["deposit_account", "TEXT"],
  ["deposit_holder", "TEXT"],
  ["deposit_receipt", "TEXT"],
  ["deposit_receipt_at", "TEXT"],
  ["deposit_confirmed_at", "TEXT"],
]) {
  try {
    db.exec(`ALTER TABLE rides ADD COLUMN ${col} ${type}`);
  } catch {
    // la columna ya existe
  }
}

// Token opaco por viaje: lo que de verdad protege el seguimiento en vivo
// (WebSocket + enlace "Compartir") en vez del id numérico consecutivo, que
// cualquiera puede adivinar/barrer del 1 en adelante. El id sigue siendo la
// llave primaria de siempre; este token es solo la credencial para verlo.
try {
  db.exec("ALTER TABLE rides ADD COLUMN share_token TEXT");
} catch {
  // la columna ya existe
}
db.exec("CREATE UNIQUE INDEX IF NOT EXISTS idx_rides_share_token ON rides(share_token) WHERE share_token IS NOT NULL");

// Backfill: los viajes que ya existían (de antes de este campo) se quedarían
// sin token para siempre si no se los generamos aquí una vez.
const ridesWithoutToken = db.prepare("SELECT id FROM rides WHERE share_token IS NULL").all();
if (ridesWithoutToken.length) {
  const assignToken = db.prepare("UPDATE rides SET share_token = ? WHERE id = ?");
  for (const { id } of ridesWithoutToken) {
    assignToken.run(crypto.randomBytes(16).toString("base64url"), id);
  }
}

// Taxi con ofertas (estilo inDrive): el precio que propone el pasajero al
// pedir, y las contraofertas de los choferes. El precio que acepta el
// pasajero es el que queda como agreed_price (base de la comisión).
try {
  db.exec("ALTER TABLE rides ADD COLUMN offer_price INTEGER");
} catch {
  // la columna ya existe
}
db.exec(`
  CREATE TABLE IF NOT EXISTS ride_offers (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    ride_id INTEGER NOT NULL REFERENCES rides(id),
    driver_id INTEGER NOT NULL REFERENCES drivers(id),
    price INTEGER NOT NULL,
    deposit_amount INTEGER,
    status TEXT NOT NULL DEFAULT 'pendiente',
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    responded_at TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_ride_offers_ride ON ride_offers(ride_id);
`);

// Momento exacto (ms) en que el chofer tocó "Ya llegué" e "Iniciar viaje":
// con eso chofer y pasajero calculan igual la espera en la recogida del taxi.
// stop_wait_*: espera MANUAL del taxi (paradas en el camino) que el chofer
// prende/apaga; se guarda aquí para que el pasajero la vea en vivo.
for (const col of ["arrived_at_ms", "started_at_ms", "stop_wait_total_ms", "stop_wait_since_ms"]) {
  try {
    db.exec(`ALTER TABLE rides ADD COLUMN ${col} INTEGER`);
  } catch {
    // la columna ya existe
  }
}

module.exports = db;
