// Prueba de lo que corre solo (barrido de viajes, retención, respaldo).
// Necesita la app corriendo en BASE y DATABASE_URL de esa misma base de
// prueba, y RESTORE_URL: otra base VACÍA para probar restaurar el respaldo.
//   BASE=http://localhost:3077 DATABASE_URL=... RESTORE_URL=... node tools/test-mantenimiento.js
const path = require("node:path");
process.loadEnvFile(path.join(__dirname, "..", ".env"));
const BASE = process.env.BASE || "http://localhost:3077";
// Solo en la computadora: app y bases en localhost.
for (const u of [BASE, process.env.DATABASE_URL, process.env.RESTORE_URL]) {
  if (!/^(https?|postgres):\/\/([^@/]*@)?(localhost|127\.0\.0\.1)[:/]/.test(String(u))) throw new Error("Esto solo se corre en localhost: " + u);
}
const db = require("../db");
const { dumpAll, gzipJson, gunzipJson, TABLES } = require("../pgData");

let pass = 0;
let fail = 0;
function check(label, cond, extra) {
  if (cond) pass++;
  else {
    fail++;
    console.log("✗", label, extra !== undefined ? JSON.stringify(extra).slice(0, 300) : "");
  }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const post = async (u, b) => {
  const r = await fetch(BASE + "/api" + u, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(b) });
  return { status: r.status, data: await r.json().catch(() => null) };
};

async function main() {
  // ---------- Barrido: viaje "buscando" viejo se cancela solo ----------
  const stamp = String(Date.now()).slice(-6);
  const phone = `96611${stamp}`.slice(0, 10);
  const reg = await post("/riders/register", { name: "Barrido", phone });
  const ride = await post("/rides", { rider_phone: phone, rider_pin: reg.data.pin, pickup_lat: 20.2071, pickup_lng: -89.2809, ride_type: "moto" });
  await db.prepare("UPDATE rides SET created_at = datetime('now', '-10 minutes') WHERE id = ?").run(ride.data.id);
  // Viaje activo abandonado (chofer de prueba existente)
  const drv = await db.prepare("SELECT id FROM drivers WHERE deleted_at IS NULL AND vehicle_type = 'moto' AND id NOT IN (SELECT driver_id FROM rides WHERE status IN ('aceptado','llegue','en_curso') AND driver_id IS NOT NULL) LIMIT 1").get();
  const ride2 = await post("/rides", { rider_phone: phone, rider_pin: reg.data.pin, pickup_lat: 20.2071, pickup_lng: -89.2809, ride_type: "moto" });
  await db.prepare("UPDATE rides SET status = 'aceptado', driver_id = ?, updated_at = datetime('now', '-2 hours') WHERE id = ?").run(drv.id, ride2.data.id);
  console.log("Esperando el barrido (hasta 35 s)...");
  let r1, r2;
  for (let i = 0; i < 35; i++) {
    await sleep(1000);
    r1 = await db.prepare("SELECT status, cancel_reason FROM rides WHERE id = ?").get(ride.data.id);
    r2 = await db.prepare("SELECT status, cancel_reason FROM rides WHERE id = ?").get(ride2.data.id);
    if (r1.status === "cancelado" && r2.status === "cancelado") break;
  }
  check("barrido cancela 'buscando' viejo", r1.status === "cancelado" && r1.cancel_reason === "Nadie lo tomó a tiempo", r1);
  check("barrido cancela activo abandonado", r2.status === "cancelado" && /Abandonado/.test(r2.cancel_reason), r2);

  // ---------- Retención: viajes de más de 1 año se anonimizan ----------
  const old = await db.prepare(
    "INSERT INTO rides (rider_name, rider_phone, pickup_lat, pickup_lng, pickup_label, dest_lat, dest_lng, dest_label, status, created_at, share_token) VALUES ('Viejo', ?, 20.207123, -89.280987, 'Casa', 20.211111, -89.289999, 'Destino', 'completado', datetime('now', '-400 days'), 'tok-' || ?)"
  ).run(phone, stamp);
  const { purgeOldPersonalData } = require("../retention");
  const pr = await purgeOldPersonalData();
  const o = await db.prepare("SELECT pickup_label, pickup_lat, dest_lat, share_token FROM rides WHERE id = ?").get(old.lastInsertRowid);
  check("retención anonimiza", pr && pr.rides >= 1 && o.pickup_label === null && o.pickup_lat === 20.21 && o.dest_lat === 20.21 && o.share_token === null, { pr, o });

  // ---------- Respaldo → restaurar en otra base → idéntico ----------
  const dump = await dumpAll(db);
  const gz = gzipJson(dump);
  check("respaldo pesa algo y se comprime", gz.length > 100 && gz.length < 5_000_000, gz.length);
  const back = gunzipJson(gz);
  check("respaldo se lee de vuelta", back.format === "motovecino-pg-1" && back.tables.rides.length === dump.tables.rides.length);
  const fs = require("node:fs");
  const os = require("node:os");
  const file = path.join(os.tmpdir(), `mv-respaldo-${stamp}.json.gz`);
  fs.writeFileSync(file, gz);
  const { execFileSync } = require("node:child_process");
  let restoreOut = "";
  try {
    restoreOut = execFileSync(process.execPath, [path.join(__dirname, "restore-backup.js"), file], {
      env: { ...process.env, DATABASE_URL: process.env.RESTORE_URL },
      encoding: "utf8",
    });
  } catch (e) {
    restoreOut = String(e.stdout) + String(e.stderr);
  }
  check("restaurar respaldo", /Respaldo restaurado completo/.test(restoreOut), restoreOut);
  // Comparar todo, tabla por tabla.
  const { Pool } = require("pg");
  const other = new Pool({ connectionString: process.env.RESTORE_URL });
  let diffTables = [];
  for (const t of TABLES) {
    const key = { ally_settings: "city", food_settings: "city", family_settings: "city", phone_otps: "phone" }[t] || "id";
    const a = JSON.stringify(dump.tables[t]);
    const b = JSON.stringify((await other.query(`SELECT * FROM ${t} ORDER BY ${key}`)).rows);
    if (a !== b) diffTables.push(t);
  }
  check("base restaurada idéntica", diffTables.length === 0, diffTables);
  // El contador de ids sigue después del último (no choca al crear algo nuevo).
  const ins = await other.query("INSERT INTO riders (phone, name) VALUES ('0000000000', 'nuevo') RETURNING id");
  const maxId = Math.max(...dump.tables.riders.map((r) => r.id));
  check("id nuevo después de restaurar no choca", ins.rows[0].id === maxId + 1, [ins.rows[0].id, maxId]);
  await other.end();
  fs.unlinkSync(file);

  await db.close();
  console.log(`\n${fail ? "✗" : "✓"} ${pass} bien, ${fail} mal`);
  process.exit(fail ? 1 : 0);
}

main().catch(async (e) => {
  console.error("✗ La prueba se cayó:", e);
  try { await db.close(); } catch {}
  process.exit(1);
});
