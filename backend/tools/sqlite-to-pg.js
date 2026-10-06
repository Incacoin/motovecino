// Ensayo a mano de la copia SQLite → Postgres (la misma que hace el arranque
// con MIGRATE_FROM_SQLITE=1, ver sqliteMigration.js).
//
//   DATABASE_URL=postgres://... node tools/sqlite-to-pg.js ruta/a/motoya.db
//
// No toca el archivo SQLite (lo abre solo para leer). Postgres debe estar
// vacío: si ya tiene datos, no copia nada. Si algo no cuadra, lo dice, deshace
// la copia y termina con error.
const path = require("node:path");
const db = require("../db");
const { migrateFromSqlite, pgIsEmpty } = require("../sqliteMigration");

const file = process.argv[2];
if (!file) {
  console.error("Uso: node tools/sqlite-to-pg.js ruta/a/motoya.db");
  process.exit(1);
}

async function main() {
  // Solo el esquema (sin la copia automática del arranque).
  const fs = require("node:fs");
  await db.pool.query(fs.readFileSync(path.join(__dirname, "..", "schema.sql"), "utf8"));
  if (!(await pgIsEmpty(db))) throw new Error("Postgres ya tiene datos: esto solo copia a una base vacía");
  await migrateFromSqlite(db, path.resolve(file));
  await db.close();
}

main().catch(async (err) => {
  console.error("✗ Error:", err.message);
  try { await db.close(); } catch {}
  process.exit(1);
});
