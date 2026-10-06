// Prueba: las funciones de fecha de Postgres (schema.sql) dan EXACTAMENTE lo
// mismo que las de SQLite, con las mismas expresiones que usa la app.
//   DATABASE_URL=postgres://... node tools/test-fechas.js
const { DatabaseSync } = require("node:sqlite");
const db = require("../db");

const lite = new DatabaseSync(":memory:");

const fechas = [
  "2026-10-05 05:59:59", "2026-10-05 06:00:00", "2026-10-05 23:30:00", "2026-10-01 03:00:00",
  "2026-10-31 23:59:59", "2026-11-01 05:00:00", "2026-01-01 02:00:00", "2026-03-01 04:00:00",
  "2026-10-04 12:00:00", "2026-10-05T14:00:00.000Z", "2026-02-28 23:00:00", "2024-02-29 12:00:00",
  "basura", "", "2026-10-05",
];
const mods = [
  [], ["-6 hours"], ["+5 minutes"], ["-90 seconds"], ["-7 days"], ["-24 hours"], ["start of month"],
  ["-6 hours", "start of month"], ["-6 hours", "weekday 0", "-6 days"], ["-6 hours", "-6 days"],
  ["-29 days"], ["-30 days"], ["weekday 0"], ["weekday 3"], ["-14 hours"],
];

async function main() {
  let fails = 0;
  let total = 0;
  for (const f of [...fechas, null]) {
    for (const m of mods) {
      for (const fn of ["datetime", "date"]) {
        const args = [f, ...m];
        const ph = args.map(() => "?").join(", ");
        const a = lite.prepare(`SELECT ${fn}(${ph}) AS v`).get(...args).v;
        const b = (await db.prepare(`SELECT ${fn}(${ph}) AS v`).get(...args)).v;
        total++;
        if (a !== b) {
          fails++;
          console.log(`✗ ${fn}(${args.map((x) => JSON.stringify(x)).join(", ")}): SQLite ${a} · Postgres ${b}`);
        }
      }
    }
    if (f === null || f === "basura" || f === "") continue;
    const a = lite.prepare("SELECT julianday(?) AS v").get(f).v;
    const b = (await db.prepare("SELECT julianday(?) AS v").get(f)).v;
    total++;
    if (Math.abs(a - b) > 1e-6) {
      fails++;
      console.log(`✗ julianday(${f}): SQLite ${a} · Postgres ${b}`);
    }
  }
  // 'now': mismo valor al segundo (las dos leen el reloj al mismo tiempo).
  for (const m of mods) {
    const args = ["now", ...m];
    const ph = args.map(() => "?").join(", ");
    const a = lite.prepare(`SELECT datetime(${ph}) AS v`).get(...args).v;
    const b = (await db.prepare(`SELECT datetime(${ph}) AS v`).get(...args)).v;
    total++;
    if (a !== b) {
      fails++;
      console.log(`✗ datetime('now', ${m.join(", ")}): SQLite ${a} · Postgres ${b}`);
    }
  }
  // Comparación de fechas como en referrals.js (debe dar 1/0, no true/false).
  const ok = (await db.prepare("SELECT date('now', '-6 hours') <= ? AS ok").get("2026-12-31")).ok;
  total++;
  if (ok !== 1) {
    fails++;
    console.log("✗ comparación debe dar 1 y dio", ok);
  }
  // ROUND(real, 2)
  const r = (await db.prepare("SELECT ROUND(?::double precision, 2) AS v").get(20.123456)).v;
  total++;
  if (r !== 20.12) {
    fails++;
    console.log("✗ ROUND dio", r);
  }
  console.log(fails ? `\n✗ ${fails} de ${total} diferentes` : `✓ ${total} de ${total} iguales a SQLite`);
  await db.close();
  process.exit(fails ? 1 : 0);
}

main().catch(async (e) => {
  console.error(e);
  await db.close();
  process.exit(1);
});
