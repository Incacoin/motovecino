// Prueba de "Propón tu precio" en Tekax (mototaxi +$40, taxi +$100) y de que
// el extra +$5/+$10 ya no existe.
//   BASE=http://localhost:3077 node tools/test-propon.js
const path = require("node:path");
process.loadEnvFile(path.join(__dirname, "..", ".env"));
const BASE = process.env.BASE || "http://localhost:3077";
if (!/^https?:\/\/(localhost|127\.0\.0\.1)[:/]/.test(BASE)) throw new Error("Esto solo se corre en localhost: " + BASE);
const ADMIN = process.env.ADMIN_PIN;
const T = { lat: 20.2071, lng: -89.2809 };

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
const stamp = String(Date.now()).slice(-6);

async function main() {
  const cfg = await api("GET", "/config");
  check("config trae los topes", cfg.data.motoOfferMaxUp === 40 && cfg.data.taxiOfferMaxUp === 100, cfg.data);

  const mk = async (name, phone, vehicleType) => {
    const r = await post("/admin/drivers", { adminPin: ADMIN, name, phone, acceptedLegal: true, vehicleType });
    return r.data;
  };
  const moto = await mk(`Moto Propón ${stamp}`, `96100${stamp}`.slice(0, 10), "moto");
  const taxi = await mk(`Taxi Propón ${stamp}`, `96200${stamp}`.slice(0, 10), "taxi");
  const reg = await post("/riders/register", { name: "Pasajero Propón", phone: `96300${stamp}`.slice(0, 10) });
  const R = { rider_phone: reg.data.phone, rider_pin: reg.data.pin };

  // Extra: ya no existe
  const ex = await post("/rides", { ...R, pickup_lat: T.lat, pickup_lng: T.lng, ride_type: "moto", extra: 10 });
  check("mototaxi Exprés sin extra (aunque lo manden)", ex.status === 201 && ex.data.extra === 0, ex.data);
  await post(`/rides/${ex.data.id}/cancel`, { riderPhone: R.rider_phone, riderPin: R.rider_pin });

  // Mototaxi Propón tu precio en Tekax
  const noDest = await post("/rides", { ...R, pickup_lat: T.lat, pickup_lng: T.lng, ride_type: "moto", offer_price: 12 });
  check("mototaxi con oferta pide destino", noDest.status === 400, noDest);
  const mo = await post("/rides", { ...R, pickup_lat: T.lat, pickup_lng: T.lng, dest_lat: T.lat + 0.01, dest_lng: T.lng, ride_type: "moto", offer_price: 12 });
  check("mototaxi Propón tu precio en Tekax", mo.status === 201 && mo.data.offer_price === 12 && mo.data.ride_type === "moto", mo.data);
  const tooHigh = await post(`/rides/${mo.data.id}/offer`, { driverId: moto.id, pin: moto.pin, price: 53 });
  check("mototaxi: contraoferta de más de +$40 no", tooHigh.status === 400, tooHigh);
  const okC = await post(`/rides/${mo.data.id}/offer`, { driverId: moto.id, pin: moto.pin, price: 52 });
  check("mototaxi: contraoferta de +$40 sí", okC.status === 201, okC);
  const taxiOnMoto = await post(`/rides/${mo.data.id}/offer`, { driverId: taxi.id, pin: taxi.pin, price: 20 });
  check("un taxista no contraoferta un mototaxi", taxiOnMoto.status === 403, taxiOnMoto);
  const acc = await post(`/rides/${mo.data.id}/offers/${okC.data.offerId}/accept`, { riderPhone: R.rider_phone, riderPin: R.rider_pin });
  check("pasajero acepta $52", acc.status === 200 && acc.data.agreedPrice === 52, acc);
  await post(`/rides/${mo.data.id}/arrived`, { driverId: moto.id, pin: moto.pin });
  await post(`/rides/${mo.data.id}/start`, { driverId: moto.id, pin: moto.pin });
  const done = await post(`/rides/${mo.data.id}/complete`, { driverId: moto.id, pin: moto.pin });
  check("ganancia mototaxi = $52 − $2", done.status === 200 && done.data.todayEarned === 50, done.data);
  const pf = await post(`/admin/drivers/${moto.id}/pending-fees`, { adminPin: ADMIN });
  check("cuota de la app $2", pf.data.amount === 2, pf.data);

  // Taxi: tope +$100
  const tr = await post("/rides", { ...R, pickup_lat: T.lat, pickup_lng: T.lng, dest_lat: 20.3028, dest_lng: -89.418, ride_type: "taxi", offer_price: 250 });
  check("taxi con oferta", tr.status === 201, tr);
  const t101 = await post(`/rides/${tr.data.id}/offer`, { driverId: taxi.id, pin: taxi.pin, price: 351 });
  check("taxi: más de +$100 no", t101.status === 400, t101);
  const t100 = await post(`/rides/${tr.data.id}/offer`, { driverId: taxi.id, pin: taxi.pin, price: 350 });
  check("taxi: +$100 sí", t100.status === 201, t100);
  const tLow = await post(`/rides/${tr.data.id}/offer`, { driverId: taxi.id, pin: taxi.pin, price: 240 });
  check("taxi: menos que la oferta no", tLow.status === 400, tLow);
  await post(`/rides/${tr.data.id}/cancel`, { riderPhone: R.rider_phone, riderPin: R.rider_pin });

  console.log(`\n${fail ? "✗" : "✓"} ${pass} bien, ${fail} mal`);
  process.exit(fail ? 1 : 0);
}
main().catch((e) => { console.error("✗ La prueba se cayó:", e); process.exit(1); });
