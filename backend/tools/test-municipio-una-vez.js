// Municipio del pasajero se acomoda UNA sola vez con su ubicación (9-nov-2026).
// Solo en localhost:  BASE=http://localhost:3077 ADMIN_PIN=... node tools/test-municipio-una-vez.js
const path = require("node:path");
try { process.loadEnvFile(path.join(__dirname, "..", ".env")); } catch {}
const BASE = process.env.BASE || "http://localhost:3077";
if (!/^https?:\/\/(localhost|127\.0\.0\.1)[:/]/.test(BASE)) throw new Error("Esto solo se corre en localhost: " + BASE);
const ADMIN = process.env.ADMIN_PIN;
const OXK = { lat: 20.3028, lng: -89.4180 };
const TICUL = { lat: 20.39528, lng: -89.53389 };
const TEKAX = { lat: 20.2071, lng: -89.2809 };
const CANCUN = { lat: 21.16, lng: -86.85 };

let pass = 0, fail = 0;
function check(label, cond, extra) {
  if (cond) pass++;
  else { fail++; console.log("✗", label, extra !== undefined ? JSON.stringify(extra).slice(0, 300) : ""); }
}
async function post(url, body) {
  const res = await fetch(BASE + "/api" + url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  let data = null; try { data = await res.json(); } catch {}
  return { status: res.status, data };
}
const stamp = String(Date.now()).slice(-6);
const db = require("../db");
async function cityOf(id) {
  const r = await db.prepare("SELECT city FROM riders WHERE id = ?").get(id);
  return r ? r.city : undefined;
}

async function main() {
  // 1) Sin GPS al registrarse → Tekax; luego se acomoda una vez.
  const a = (await post("/riders/register", { name: "Sin GPS", phone: ("9962" + stamp).slice(0, 10) })).data;
  check("sin GPS queda en Tekax", (await cityOf(a.id)) === "tekax", a);
  check("PIN malo = 404", (await post("/riders/locate", { phone: a.phone, pin: "0000", ...OXK })).status === 404);
  check("sin ubicación = 400", (await post("/riders/locate", { phone: a.phone, pin: a.pin })).status === 400);
  const out = await post("/riders/locate", { phone: a.phone, pin: a.pin, ...CANCUN });
  check("fuera de los municipios: no se mueve ni gasta su vez", out.status === 200 && !out.data.moved && !out.data.done, out);
  const l1 = await post("/riders/locate", { phone: a.phone, pin: a.pin, ...OXK });
  check("primera ubicación en Oxkutzcab: se pasa", l1.status === 200 && l1.data.moved && l1.data.city === "oxkutzcab" && l1.data.done, l1);
  check("admin: ya sale en Oxkutzcab", (await cityOf(a.id)) === "oxkutzcab");
  const l2 = await post("/riders/locate", { phone: a.phone, pin: a.pin, ...TICUL });
  check("segunda vez en Ticul: ya NO se mueve", l2.status === 200 && !l2.data.moved && l2.data.done, l2);
  check("sigue en Oxkutzcab", (await cityOf(a.id)) === "oxkutzcab");

  // 2) Con GPS al registrarse → ya está acomodado, no se mueve después.
  const b = (await post("/riders/register", { name: "Con GPS", phone: ("9963" + stamp).slice(0, 10), ...TICUL })).data;
  check("con GPS en Ticul queda en Ticul", (await cityOf(b.id)) === "ticul");
  const lb = await post("/riders/locate", { phone: b.phone, pin: b.pin, ...OXK });
  check("con GPS desde el registro: no se mueve", !lb.data.moved && lb.data.done, lb);
  check("sigue en Ticul", (await cityOf(b.id)) === "ticul");

  // 3) Ya pidió un viaje → no se mueve (manda el último viaje).
  const c = (await post("/riders/register", { name: "Con viaje", phone: ("9964" + stamp).slice(0, 10) })).data;
  await db.prepare("INSERT INTO rides (rider_name, rider_phone, rider_id, pickup_lat, pickup_lng, dest_lat, dest_lng, city, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, 'tekax', 'cancelled', datetime('now'), datetime('now'))")
    .run("Con viaje", c.phone, c.id, TEKAX.lat, TEKAX.lng, TEKAX.lat, TEKAX.lng);
  const lc = await post("/riders/locate", { phone: c.phone, pin: c.pin, ...OXK });
  check("con viajes: no se mueve", !lc.data.moved && lc.data.done, lc);
  check("sigue en Tekax", (await cityOf(c.id)) === "tekax");

  console.log(`\n${fail ? "✗" : "✓"} ${pass} bien, ${fail} mal`);
  process.exit(fail ? 1 : 0);
}
main().catch((e) => { console.error("Error:", e); process.exit(1); });
