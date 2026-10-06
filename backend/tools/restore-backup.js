// Regresa un respaldo (motovecino-db.json.gz, el que backup.js sube a GitHub
// cada 6 h) a una base de Postgres VACÍA.
//
//   DATABASE_URL=postgres://... node tools/restore-backup.js motovecino-db.json.gz
//
// Si la base ya tiene datos, no hace nada (no se puede pisar nada por error).
const fs = require("node:fs");
const db = require("../db");
const { gunzipJson, loadAll, TABLES } = require("../pgData");

const file = process.argv[2];
if (!file) {
  console.error("Uso: node tools/restore-backup.js motovecino-db.json.gz");
  process.exit(1);
}

async function main() {
  const data = gunzipJson(fs.readFileSync(file));
  if (data.format !== "motovecino-pg-1") throw new Error("Este archivo no es un respaldo de MotoVecino");
  console.log(`Respaldo del ${data.createdAt}`);
  // Solo el esquema (sin la copia automática de SQLite del arranque).
  await db.pool.query(fs.readFileSync(require("node:path").join(__dirname, "..", "schema.sql"), "utf8"));
  await loadAll(db, data);
  for (const t of TABLES) {
    const { n } = await db.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get();
    const expected = (data.tables[t] || []).length;
    if (n !== expected) throw new Error(`${t}: se esperaban ${expected} filas y hay ${n}`);
  }
  console.log("✓ Respaldo restaurado completo.");
  await db.close();
}

main().catch(async (err) => {
  console.error("✗ Error:", err.message);
  try { await db.close(); } catch {}
  process.exit(1);
});
