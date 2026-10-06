// Sacar y meter TODOS los datos de la base de un jalón. Lo usan:
//  - backup.js: respaldo cada 6 h a GitHub (todas las tablas en un .json.gz)
//  - tools/restore-backup.js: regresar un respaldo a una base vacía
//  - tools/sqlite-to-pg.js: la copia única de SQLite → Postgres
const zlib = require("node:zlib");

// En orden de dependencias: cada tabla después de las que referencia.
const TABLES = [
  "leaders",
  "leader_payments",
  "drivers",
  "riders",
  "rides",
  "driver_applications",
  "driver_payments",
  "referral_rewards",
  "driver_credits",
  "driver_activity_log",
  "ride_offers",
  "ally_ads",
  "ally_ad_events",
  "ally_settings",
  "businesses",
  "menu_items",
  "food_settings",
  "family_settings",
  "push_keys",
  "driver_push_subs",
  "rider_push_subs",
  "phone_otps",
  "admin_sessions",
  "admin_audit",
];

// Llave para ordenar (las tablas de ajustes no tienen id).
const ORDER_KEY = { ally_settings: "city", food_settings: "city", family_settings: "city", phone_otps: "phone" };

// Columnas que apuntan a la misma tabla: se llenan en una segunda vuelta, por
// si un chofer apunta a otro que todavía no se ha insertado.
const SELF_REFS = { drivers: ["referred_by_driver_id"] };

async function dumpAll(db) {
  const tables = {};
  for (const t of TABLES) {
    tables[t] = await db.prepare(`SELECT * FROM ${t} ORDER BY ${ORDER_KEY[t] || "id"}`).all();
  }
  return { format: "motovecino-pg-1", createdAt: new Date().toISOString(), tables };
}

function gzipJson(obj) {
  return zlib.gzipSync(Buffer.from(JSON.stringify(obj)));
}

function gunzipJson(buf) {
  return JSON.parse(zlib.gunzipSync(buf).toString("utf8"));
}

// Columnas de cada tabla en Postgres.
async function pgColumns(db, table) {
  const rows = await db
    .prepare("SELECT column_name FROM information_schema.columns WHERE table_schema = 'public' AND table_name = ? ORDER BY ordinal_position")
    .all(table);
  return rows.map((r) => r.column_name);
}

// Mete los datos en una base VACÍA (con el esquema ya creado), dentro de una
// sola transacción: o entra todo, o no entra nada. Avisa de columnas que
// vengan en los datos pero no existan en la base (se perderían).
async function loadAll(db, data, log = console.log) {
  await db.tx(async () => {
    for (const t of TABLES) {
      const rows = data.tables[t] || [];
      const { n } = await db.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get();
      if (n > 0) throw new Error(`La tabla ${t} ya tiene datos: esto solo carga en una base vacía`);
      if (!rows.length) continue;

      const cols = await pgColumns(db, t);
      const colSet = new Set(cols);
      const extra = Object.keys(rows[0]).filter((c) => !colSet.has(c));
      if (extra.length) throw new Error(`La tabla ${t} trae columnas que la base no tiene: ${extra.join(", ")}`);
      const use = cols.filter((c) => c in rows[0]);
      const selfRefs = SELF_REFS[t] || [];

      // De a 200 filas por INSERT (rápido sin pasarse del límite de parámetros).
      for (let i = 0; i < rows.length; i += 200) {
        const chunk = rows.slice(i, i + 200);
        const values = [];
        const tuples = chunk.map((row) => {
          const ph = use.map((c) => {
            values.push(selfRefs.includes(c) ? null : row[c]);
            return "?";
          });
          return `(${ph.join(", ")})`;
        });
        await db
          .prepare(`INSERT INTO ${t} (${use.map((c) => `"${c}"`).join(", ")}) VALUES ${tuples.join(", ")}`)
          .run(...values);
      }
      for (const c of selfRefs) {
        for (const row of rows) {
          if (row[c] != null) await db.prepare(`UPDATE ${t} SET ${c} = ? WHERE id = ?`).run(row[c], row.id);
        }
      }
      // El contador de ids sigue después del id más alto copiado.
      if (cols.includes("id")) {
        await db.exec(
          `SELECT setval(pg_get_serial_sequence('${t}', 'id'), COALESCE((SELECT MAX(id) FROM ${t}), 0) + 1, false)
           WHERE pg_get_serial_sequence('${t}', 'id') IS NOT NULL`
        );
      }
      log(`  ${t}: ${rows.length} filas`);
    }
  });
}

module.exports = { TABLES, ORDER_KEY, dumpAll, gzipJson, gunzipJson, loadAll, pgColumns };
