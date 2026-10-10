// Prueba de Celestún (9-oct-2026, zona de prueba de unos días): el dueño da
// de alta un mototaxista en el cajón "celestun" desde el admin, el registro
// público está cerrado, solo Propón tu precio con mínimo $17, y los choferes
// de Celestún y de Tekax no se cruzan viajes.
//   BASE=http://localhost:3077 node tools/test-celestun.js
const path = require("node:path");
process.loadEnvFile(path.join(__dirname, "..", ".env"));
const BASE = process.env.BASE || "http://localhost:3077";
if (!/^https?:\/\/(localhost|127\.0\.0\.1)[:/]/.test(BASE)) throw new Error("Esto solo se corre en localhost: " + BASE);
const ADMIN = process.env.ADMIN_PIN;
const C = { lat: 20.8590, lng: -90.4000 }; // plaza de Celestún
const T = { lat: 20.2071, lng: -89.2809 }; // Tekax

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
  const res = await api("GET", `/cities/resolve?lat=${C.lat}&lng=${C.lng}`);
  check("Celestún se reconoce", res.data.city === "celestun" && res.data.zone === "in" && res.data.label === "Celestún", res.data);
  check("Celestún: registro público cerrado", res.data.inService === false, res.data);
  check("Celestún: mínimo $15 + $2", res.data.cityOffer && res.data.cityOffer.minOffer === 15, res.data);
  const puente = await api("GET", "/cities/resolve?lat=20.8635&lng=-90.3880");
  check("el puente de la ría es Celestún", puente.data.city === "celestun" && puente.data.zone === "in", puente.data);
  const tk = await api("GET", `/cities/resolve?lat=${T.lat}&lng=${T.lng}`);
  check("Tekax sigue igual", tk.data.city === "tekax" && tk.data.inService === true, tk.data);

  const form = await post("/chofer-solicitudes", { name: "Prueba Celestún", phone: `97100${stamp}`.slice(0, 10), city: "celestun", lat: C.lat, lng: C.lng, acceptedLegal: true });
  check("formulario público en Celestún no", form.status === 400, form);

  const login = await post("/admin/login", { adminPin: ADMIN, adminZone: "celestun" });
  check("el dueño ve el cajón Celestún", login.status === 200 && login.data.city === "celestun" && login.data.zones.some((z) => z.id === "celestun"), login.data);
  const mc = await post("/admin/drivers", { adminPin: ADMIN, adminZone: "celestun", name: `Moto Celestún ${stamp}`, phone: `97200${stamp}`.slice(0, 10), acceptedLegal: true, vehicleType: "moto" });
  check("alta de mototaxista en Celestún", mc.status === 201 || mc.status === 200, mc);
  const moto = mc.data;
  const mt = (await post("/admin/drivers", { adminPin: ADMIN, name: `Moto Tekax ${stamp}`, phone: `97300${stamp}`.slice(0, 10), acceptedLegal: true, vehicleType: "moto" })).data;
  const reg = await post("/riders/register", { name: "Pasajero Celestún", phone: `97400${stamp}`.slice(0, 10) });
  const R = { rider_phone: reg.data.phone, rider_pin: reg.data.pin };

  const ex = await post("/rides", { ...R, pickup_lat: C.lat, pickup_lng: C.lng, dest_lat: C.lat + 0.01, dest_lng: C.lng, ride_type: "moto", extra: 10 });
  check("Celestún: sin precio fijo", ex.status === 400, ex);
  const low = await post("/rides", { ...R, pickup_lat: C.lat, pickup_lng: C.lng, dest_lat: C.lat + 0.01, dest_lng: C.lng, ride_type: "moto", offer_price: 16 });
  check("Celestún: menos de $17 no", low.status === 400, low);
  const r = await post("/rides", { ...R, pickup_lat: C.lat, pickup_lng: C.lng, dest_lat: C.lat + 0.01, dest_lng: C.lng, ride_type: "moto", offer_price: 20 });
  check("Celestún: viaje por $20", r.status === 201 && r.data.city === "celestun", r.data);
  const fromTekax = await post(`/rides/${r.data.id}/offer`, { driverId: mt.id, pin: mt.pin, price: 25 });
  check("un mototaxi de Tekax no toma viajes de Celestún", fromTekax.status >= 400, fromTekax);
  const acc = await post(`/rides/${r.data.id}/accept`, { driverId: moto.id, pin: moto.pin });
  check("el mototaxista de Celestún acepta", acc.status === 200, acc);
  await post(`/rides/${r.data.id}/arrived`, { driverId: moto.id, pin: moto.pin });
  await post(`/rides/${r.data.id}/start`, { driverId: moto.id, pin: moto.pin });
  const done = await post(`/rides/${r.data.id}/complete`, { driverId: moto.id, pin: moto.pin });
  check("gana $20 − $2", done.status === 200 && done.data.todayEarned === 18, done.data);

  const rt = await post("/rides", { ...R, pickup_lat: T.lat, pickup_lng: T.lng, dest_lat: T.lat + 0.01, dest_lng: T.lng, ride_type: "moto", offer_price: 17 });
  const fromCel = await post(`/rides/${rt.data.id}/accept`, { driverId: moto.id, pin: moto.pin });
  check("el de Celestún no toma viajes de Tekax", fromCel.status >= 400, fromCel);
  await post(`/rides/${rt.data.id}/cancel`, { riderPhone: R.rider_phone, riderPin: R.rider_pin });

  console.log(`\n${fail ? "✗" : "✓"} ${pass} bien, ${fail} mal`);
  process.exit(fail ? 1 : 0);
}
main().catch((e) => { console.error("✗ La prueba se cayó:", e); process.exit(1); });
