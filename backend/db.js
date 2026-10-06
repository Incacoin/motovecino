// Conexión a Postgres (antes: archivo SQLite en data/motoya.db).
//
// Para no reescribir cada consulta de la app, se conserva la forma de usarla
// que ya tenía todo el código — db.prepare(sql).get/all/run(...) — pero ahora
// todo regresa una promesa (hay que ponerle `await`). Aquí mismo se traduce el
// SQL de SQLite a Postgres:
//   - los `?` se vuelven $1, $2...
//   - datetime(...) / date(...) → sl_datetime / sl_date (ver schema.sql: dan
//     exactamente lo mismo que SQLite, en texto UTC)
//   - INSERT OR IGNORE → INSERT ... ON CONFLICT DO NOTHING
//   - alias con mayúsculas (AS todayTotal) se ponen entre comillas: Postgres
//     los pasa a minúsculas y la app los busca con mayúsculas
//   - run() de un INSERT pide RETURNING id para dar lastInsertRowid
// Y los resultados se dejan como los daba SQLite: COUNT/SUM como número (no
// texto) y verdadero/falso como 1/0.
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { AsyncLocalStorage } = require("node:async_hooks");
const { Pool, types } = require("pg");

types.setTypeParser(20, (v) => parseInt(v, 10)); // int8: COUNT(*), SUM de enteros, BIGINT
types.setTypeParser(1700, (v) => parseFloat(v)); // numeric: AVG, ROUND
types.setTypeParser(16, (v) => (v === "t" ? 1 : 0)); // boolean → 1/0 como SQLite

if (!process.env.DATABASE_URL) {
  throw new Error("Falta DATABASE_URL (la dirección de Postgres)");
}

// En Render la app y la base van por la red interna (sin SSL). Desde fuera
// (la computadora, para una copia o revisión) hace falta SSL: PGSSL=1.
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  max: Number(process.env.PG_POOL_MAX) || 10,
  ssl: process.env.PGSSL === "1" ? { rejectUnauthorized: false } : undefined,
});
pool.on("error", (err) => console.error("[db] error en una conexión libre:", err.message));

// Transacción en curso (db.tx): las consultas dentro de ella usan la misma
// conexión sin tener que pasarla a mano.
const txStore = new AsyncLocalStorage();

// Tablas sin columna id (su llave es otra): a sus INSERT no se les pide RETURNING id.
const NO_ID_TABLES = new Set(["ally_settings", "food_settings", "family_settings", "phone_otps"]);

const translated = new Map();

function translate(sql, forRun) {
  const key = (forRun ? "r:" : "q:") + sql;
  const hit = translated.get(key);
  if (hit) return hit;
  // Las listas IN (?, ?, ...) de largo variable no deben llenar la memoria.
  if (translated.size > 2000) translated.clear();

  let out = sql
    .replace(/\bAS\s+([a-z][a-z0-9_]*[A-Z][A-Za-z0-9_]*)\b/g, 'AS "$1"')
    .replace(/(?<![\w.])datetime\s*\(/gi, "sl_datetime(")
    .replace(/(?<![\w.])date\s*\(/gi, "sl_date(");

  let ignore = false;
  out = out.replace(/\bINSERT\s+OR\s+IGNORE\s+INTO\b/i, () => {
    ignore = true;
    return "INSERT INTO";
  });

  // ? → $n, sin tocar los que estén dentro de un texto entre comillas.
  let n = 0;
  let inQuote = false;
  let res = "";
  for (const ch of out) {
    if (ch === "'") inQuote = !inQuote;
    res += ch === "?" && !inQuote ? `$${++n}` : ch;
  }
  out = res.trimEnd().replace(/;$/, "");

  if (ignore) out += " ON CONFLICT DO NOTHING";
  if (forRun) {
    const m = /^\s*INSERT\s+INTO\s+(\w+)/i.exec(out);
    if (m && !NO_ID_TABLES.has(m[1].toLowerCase()) && !/\bRETURNING\b/i.test(out)) out += " RETURNING id";
  }
  translated.set(key, out);
  return out;
}

// SQLite aceptaba casi cualquier cosa; Postgres no. Lo que llegue raro de una
// app se manda como NULL (en SQLite daba "no encontrado", no un error).
function cleanParam(v) {
  if (v === undefined) return null;
  if (typeof v === "number" && !Number.isFinite(v)) return null;
  if (typeof v === "boolean") return v ? 1 : 0;
  if (typeof v === "bigint") return v.toString();
  return v;
}

function client() {
  return txStore.getStore() || pool;
}

async function query(sql, params, forRun) {
  return client().query(translate(sql, forRun), params.map(cleanParam));
}

function prepare(sql) {
  return {
    async get(...params) {
      const r = await query(sql, params, false);
      return r.rows[0];
    },
    async all(...params) {
      const r = await query(sql, params, false);
      return r.rows;
    },
    async run(...params) {
      const r = await query(sql, params, true);
      return { changes: r.rowCount ?? 0, lastInsertRowid: r.rows?.[0]?.id ?? null };
    },
  };
}

// Varias sentencias seguidas, sin parámetros (esquema, mantenimiento).
async function exec(sql) {
  return client().query(translate(sql, false));
}

// Todo lo de fn() pasa completo o no pasa nada. Si ya hay una transacción
// abierta, fn() corre dentro de esa misma.
async function tx(fn) {
  if (txStore.getStore()) return fn();
  const conn = await pool.connect();
  try {
    await conn.query("BEGIN");
    const result = await txStore.run(conn, fn);
    await conn.query("COMMIT");
    return result;
  } catch (err) {
    try {
      await conn.query("ROLLBACK");
    } catch {}
    throw err;
  } finally {
    conn.release();
  }
}

// Código de Postgres para "ya existe un registro con ese valor único".
function isUniqueViolation(err) {
  return err && err.code === "23505";
}

// Crea/actualiza el esquema y corre los arreglos de datos que antes vivían al
// inicio de db.js. Se llama una vez al arrancar, antes de abrir el servidor.
async function init() {
  const { SERVICE_FEE_START_DATE } = require("./constants");
  const { recomputeFounders } = require("./founders");

  await pool.query(fs.readFileSync(path.join(__dirname, "schema.sql"), "utf8"));

  // El cambio de SQLite a Postgres (una sola vez). La copia se hace aquí, al
  // arrancar, para tomar la libreta tal como la dejó la versión vieja al
  // apagarse. Si no cuadra, la app no abre (error) y Postgres queda vacío.
  const { migrateFromSqlite, pgIsEmpty } = require("./sqliteMigration");
  const sqliteFile = path.join(__dirname, "data", "motoya.db");
  if (await pgIsEmpty(module.exports)) {
    if (process.env.MIGRATE_FROM_SQLITE === "1") {
      if (!fs.existsSync(sqliteFile)) throw new Error("MIGRATE_FROM_SQLITE=1 pero no existe data/motoya.db");
      await migrateFromSqlite(module.exports, sqliteFile);
    } else if (fs.existsSync(sqliteFile)) {
      // Candado: abrir con la base vacía dejaría a todos sin cuenta.
      throw new Error("Postgres está vacío y existe data/motoya.db: pon MIGRATE_FROM_SQLITE=1 para copiarla (no se abre vacía por error)");
    }
  } else if (process.env.MIGRATE_FROM_SQLITE === "1") {
    console.log("[migración] Postgres ya tiene datos: no se copia nada. Ya se puede quitar MIGRATE_FROM_SQLITE.");
  }

  // Los viajes completados antes de que la cuota por viaje existiera en Tekax
  // se marcan como ya liquidados: no se le cobra a nadie de forma retroactiva.
  await prepare(
    "UPDATE rides SET fee_settled_at = updated_at WHERE status = 'completado' AND fee_settled_at IS NULL AND date(updated_at) < date(?)"
  ).run(SERVICE_FEE_START_DATE);

  // Cada pasajero queda con la ciudad de su viaje más reciente (el registro no
  // pide ubicación; ver routes/rides.js).
  await exec(`
    UPDATE riders
    SET city = (SELECT city FROM rides WHERE rides.rider_id = riders.id ORDER BY updated_at DESC, id DESC LIMIT 1)
    WHERE EXISTS (SELECT 1 FROM rides WHERE rides.rider_id = riders.id)
      AND city IS DISTINCT FROM (SELECT city FROM rides WHERE rides.rider_id = riders.id ORDER BY updated_at DESC, id DESC LIMIT 1)
  `);

  // Viajes sin token de seguimiento (no debería haber, pero por si acaso).
  const withoutToken = await prepare("SELECT id FROM rides WHERE share_token IS NULL").all();
  for (const { id } of withoutToken) {
    await prepare("UPDATE rides SET share_token = ? WHERE id = ?").run(crypto.randomBytes(16).toString("base64url"), id);
  }

  await recomputeFounders(module.exports);
}

async function close() {
  await pool.end();
}

module.exports = { prepare, exec, tx, init, close, isUniqueViolation, translate, pool };
