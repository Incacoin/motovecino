// Prueba de taxis de Ticul en sus comisarías (15-nov-2026): el taxi recoge
// hasta 12 km de Ticul y ese viaje es del cajón de Ticul (no de Tekax); el
// mototaxi sigue solo en 6 km; Oxkutzcab no cambia; más lejos de 12 km queda
// igual que antes (cajón de Tekax, que es la red de taxis foráneos).
//   BASE=http://localhost:3077 node tools/test-comisarias.js
const path = require("node:path");
process.loadEnvFile(path.join(__dirname, "..", ".env"));
const BASE = process.env.BASE || "http://localhost:3077";
if (!/^https?:\/\/(localhost|127\.0\.0\.1)[:/]/.test(BASE)) throw new Error("Esto solo se corre en localhost: " + BASE);

const TICUL = { lat: 20.39528, lng: -89.53389 };
const OX = { lat: 20.3028, lng: -89.4180 };
// Punto a X km al norte de Ticul (1° de latitud ≈ 111 km).
const north = (km) => ({ lat: TICUL.lat + km / 111, lng: TICUL.lng });

let pass = 0;
let fail = 0;
function check(label, cond, extra) {
  if (cond) pass++;
  else {
    fail++;
    console.log("✗", label, extra !== undefined ? JSON.stringify(extra).slice(0, 300) : "");
  }
}
async function api(method, url, body) {
  const res = await fetch(BASE + "/api" + url, { method, headers: { "Content-Type": "application/json" }, body: body ? JSON.stringify(body) : undefined });
  let data = null;
  try { data = await res.json(); } catch {}
  return { status: res.status, data };
}
const post = (u, b) => api("POST", u, b);
const resolve = (p) => api("GET", `/cities/resolve?lat=${p.lat}&lng=${p.lng}`);
const stamp = String(Date.now()).slice(-6);

async function main() {
  // Lo que ve el pasajero al abrir la app.
  const c3 = (await resolve(north(3))).data;
  check("3 km: Ticul, mototaxi y taxi", c3.city === "ticul" && c3.zone === "in", c3);
  for (const km of [6.5, 9, 11.5]) {
    const c = (await resolve(north(km))).data;
    check(`${km} km (comisaría): Ticul, solo taxi`, c.city === "ticul" && c.zone === "taxi" && c.label === "Ticul", c);
  }
  const c15 = (await resolve(north(15))).data;
  check("15 km: igual que antes (sin municipio, taxi de la red de Tekax)", c15.city == null && c15.zone === "taxi", c15);
  const ox = (await resolve(OX)).data;
  check("Oxkutzcab sigue siendo Oxkutzcab", ox.city === "oxkutzcab" && ox.zone === "in", ox);

  const reg = await post("/riders/register", { name: "Pasajero Comisaría", phone: `97500${stamp}`.slice(0, 10) });
  check("registro de pasajero", reg.status === 200 || reg.status === 201, reg);
  const R = { rider_phone: reg.data.phone, rider_pin: reg.data.pin };
  const cancel = (id) => post(`/rides/${id}/cancel`, { riderPhone: R.rider_phone, riderPin: R.rider_pin });

  // Taxi desde una comisaría a 9 km → viaje de Ticul.
  const p9 = north(9);
  const taxi9 = await post("/rides", { ...R, pickup_lat: p9.lat, pickup_lng: p9.lng, dest_lat: TICUL.lat, dest_lng: TICUL.lng, ride_type: "taxi", offer_price: 120 });
  check("taxi a 9 km: se puede pedir y es de Ticul", taxi9.status === 201 && taxi9.data.city === "ticul", taxi9);
  if (taxi9.data && taxi9.data.id) await cancel(taxi9.data.id);

  // Antes, entre 6 y 7 km el taxi se rechazaba.
  const p65 = north(6.5);
  const taxi65 = await post("/rides", { ...R, pickup_lat: p65.lat, pickup_lng: p65.lng, dest_lat: TICUL.lat, dest_lng: TICUL.lng, ride_type: "taxi", offer_price: 100 });
  check("taxi a 6.5 km: ya no se rechaza", taxi65.status === 201 && taxi65.data.city === "ticul", taxi65);
  if (taxi65.data && taxi65.data.id) await cancel(taxi65.data.id);

  // El mototaxi sigue solo dentro de 6 km.
  const moto9 = await post("/rides", { ...R, pickup_lat: p9.lat, pickup_lng: p9.lng, dest_lat: TICUL.lat, dest_lng: TICUL.lng, ride_type: "moto", offer_price: 40 });
  check("mototaxi a 9 km: no", moto9.status === 400, moto9);
  if (moto9.data && moto9.data.id) await cancel(moto9.data.id);

  // Más lejos de 12 km: igual que antes (cajón de Tekax).
  const p15 = north(15);
  const taxi15 = await post("/rides", { ...R, pickup_lat: p15.lat, pickup_lng: p15.lng, dest_lat: TICUL.lat, dest_lng: TICUL.lng, ride_type: "taxi", offer_price: 150 });
  check("taxi a 15 km: igual que antes (Tekax)", taxi15.status === 201 && taxi15.data.city === "tekax", taxi15);
  if (taxi15.data && taxi15.data.id) await cancel(taxi15.data.id);

  console.log(`\n${fail ? "✗" : "✓"} ${pass} bien, ${fail} mal`);
  process.exit(fail ? 1 : 0);
}
main().catch((e) => { console.error("✗ La prueba se cayó:", e); process.exit(1); });
