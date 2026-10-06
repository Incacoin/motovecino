// Copia ÚNICA de la base SQLite de antes (data/motoya.db) a Postgres, con
// revisión fila por fila y de totales de dinero. La usan:
//  - db.init() en el arranque del cambio (con MIGRATE_FROM_SQLITE=1), para
//    copiar la libreta en el momento exacto en que se apagó la versión vieja;
//  - tools/sqlite-to-pg.js, para ensayos a mano.
// El archivo SQLite solo se LEE: nunca se modifica, así regresar a la versión
// de antes siempre es posible.
const { DatabaseSync } = require("node:sqlite");
const { TABLES, ORDER_KEY, loadAll, pgColumns } = require("./pgData");

// Mismo valor en las dos bases, sin importar cómo lo devuelve cada una.
function norm(v) {
  if (v === null || v === undefined) return null;
  if (typeof v === "bigint") return Number(v);
  return v;
}

const MONEY_CHECKS = [
  ["viajes completados", "SELECT COUNT(*) AS v FROM rides WHERE status = 'completado'"],
  ["ganancias de choferes", "SELECT COALESCE(SUM(driver_earnings), 0) AS v FROM rides"],
  ["pagos registrados", "SELECT COALESCE(SUM(amount), 0) AS v FROM driver_payments"],
  ["saldo a favor dado", "SELECT COALESCE(SUM(amount), 0) AS v FROM driver_credits"],
  ["viajes sin cobrar cuota", "SELECT COUNT(*) AS v FROM rides WHERE status = 'completado' AND fee_settled_at IS NULL"],
  ["choferes", "SELECT COUNT(*) AS v FROM drivers"],
  ["pasajeros", "SELECT COUNT(*) AS v FROM riders"],
];

// ¿Postgres está vacío? (ni choferes, ni pasajeros, ni viajes)
async function pgIsEmpty(db) {
  for (const t of ["drivers", "riders", "rides"]) {
    const { n } = await db.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get();
    if (n > 0) return false;
  }
  return true;
}

// Revisa que lo que quedó en Postgres sea idéntico a lo que se leyó de SQLite.
// Regresa la lista de problemas (vacía = todo cuadra).
async function verify(db, lite, data, log) {
  const problems = [];
  for (const t of TABLES) {
    const src = data.tables[t] || [];
    const dst = await db.prepare(`SELECT * FROM ${t} ORDER BY ${ORDER_KEY[t] || "id"}`).all();
    if (src.length !== dst.length) {
      problems.push(`${t}: SQLite ${src.length} filas, Postgres ${dst.length}`);
      continue;
    }
    const cols = await pgColumns(db, t);
    let diffs = 0;
    for (let i = 0; i < src.length; i++) {
      for (const c of cols) {
        if (!(c in src[i])) continue; // columna nueva en Postgres con su valor por defecto
        const a = norm(src[i][c]);
        const b = norm(dst[i][c]);
        if (a !== b) {
          if (diffs < 3) problems.push(`${t} fila ${i + 1} ${c}: ${JSON.stringify(a)} ≠ ${JSON.stringify(b)}`);
          diffs++;
        }
      }
    }
    if (diffs) problems.push(`${t}: ${diffs} diferencias`);
  }
  for (const [label, sql] of MONEY_CHECKS) {
    const a = Number(lite.prepare(sql).get().v);
    const b = Number((await db.prepare(sql).get()).v);
    if (Math.abs(a - b) >= 1e-9) problems.push(`${label}: SQLite ${a} · Postgres ${b}`);
    else log(`[migración] ✓ ${label}: ${a}`);
  }
  return problems;
}

// Copia y revisa. Copia Y revisión van en UNA sola transacción: si algo no
// cuadra se lanza un error, la copia se deshace completa y Postgres queda
// vacío otra vez (si no, el siguiente arranque vería datos y abriría la app
// con una copia mala).
async function migrateFromSqlite(db, file, log = console.log) {
  const lite = new DatabaseSync(file, { readOnly: true });
  try {
    const liteTables = new Set(lite.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().map((r) => r.name));
    const unknown = [...liteTables].filter((t) => !TABLES.includes(t) && t !== "sqlite_sequence");
    if (unknown.length) throw new Error(`SQLite tiene tablas que no se copiarían: ${unknown.join(", ")}`);

    const dupActive = lite
      .prepare(
        "SELECT driver_id, COUNT(*) AS n FROM rides WHERE status IN ('aceptado', 'llegue', 'en_curso') AND driver_id IS NOT NULL GROUP BY driver_id HAVING n > 1"
      )
      .all();
    if (dupActive.length) {
      throw new Error(`Choferes con más de un viaje activo (resolver antes de copiar): ${JSON.stringify(dupActive)}`);
    }

    const data = { tables: {} };
    for (const t of TABLES) {
      if (!liteTables.has(t)) continue;
      data.tables[t] = lite.prepare(`SELECT * FROM ${t} ORDER BY ${ORDER_KEY[t] || "id"}`).all().map((r) => ({ ...r }));
    }

    await db.tx(async () => {
      log("[migración] copiando SQLite → Postgres:");
      await loadAll(db, data, (m) => log("[migración]" + m));
      log("[migración] revisando fila por fila...");
      const problems = await verify(db, lite, data, log);
      if (problems.length) throw new Error("La copia NO cuadra:\n  " + problems.join("\n  "));
    });
    log("[migración] ✓ copia completa e idéntica");
  } finally {
    lite.close();
  }
}

module.exports = { migrateFromSqlite, pgIsEmpty };
