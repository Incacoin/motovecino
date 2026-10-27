// Prueba (26-oct-2026) del motivo de la contraoferta: el chofer dice por qué
// pide más (lluvia, lejos, noche, camino, otro) y el pasajero lo ve junto a
// la oferta. Un motivo raro o una app vieja sin motivo quedan sin motivo.
//   BASE=http://localhost:3077 node tools/test-motivo.js
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
  const mk = async (name, phone, vehicleType) => (await post("/admin/drivers", { adminPin: ADMIN, name, phone, acceptedLegal: true, vehicleType })).data;
  const m1 = await mk(`Moto Motivo A ${stamp}`, `95100${stamp}`.slice(0, 10), "moto");
  const m2 = await mk(`Moto Motivo B ${stamp}`, `95200${stamp}`.slice(0, 10), "moto");
  const m3 = await mk(`Moto Motivo C ${stamp}`, `95300${stamp}`.slice(0, 10), "moto");
  const reg = await post("/riders/register", { name: "Pasajero Motivo", phone: `95400${stamp}`.slice(0, 10) });
  const R = { rider_phone: reg.data.phone, rider_pin: reg.data.pin };

  const ride = await post("/rides", { ...R, pickup_lat: T.lat, pickup_lng: T.lng, dest_lat: T.lat + 0.01, dest_lng: T.lng, ride_type: "moto", offer_price: 25 });
  check("viaje con Propón tu precio $25", ride.status === 201 && ride.data.offer_price === 25, ride.data);
  const id = ride.data.id, tok = ride.data.share_token;

  const a = await post(`/rides/${id}/offer`, { driverId: m1.id, pin: m1.pin, price: 35, reason: "lluvia" });
  check("contraoferta con motivo lluvia", a.status === 201, a.data);
  const b = await post(`/rides/${id}/offer`, { driverId: m2.id, pin: m2.pin, price: 30, reason: "<script>" });
  check("motivo raro igual se manda", b.status === 201, b.data);
  const c = await post(`/rides/${id}/offer`, { driverId: m3.id, pin: m3.pin, price: 40 });
  check("app vieja sin motivo igual se manda", c.status === 201, c.data);

  const view = await api("GET", `/rides/${id}?t=${tok}`);
  const offers = view.data?.offers || [];
  const by = (oid) => offers.find((o) => o.id === oid);
  check("el pasajero ve las 3 ofertas", offers.length === 3, view.data);
  check("ve el motivo lluvia", by(a.data.offerId)?.reason === "lluvia", by(a.data.offerId));
  check("motivo raro queda sin motivo", by(b.data.offerId) && by(b.data.offerId).reason === null, by(b.data.offerId));
  check("sin motivo queda sin motivo", by(c.data.offerId) && by(c.data.offerId).reason === null, by(c.data.offerId));
  check("no se filtra el teléfono del chofer", !JSON.stringify(offers).includes(m1.phone), offers);

  // El chofer cambia su oferta: la nueva trae su propio motivo
  const a2 = await post(`/rides/${id}/offer`, { driverId: m1.id, pin: m1.pin, price: 33, reason: "lejos" });
  const view2 = await api("GET", `/rides/${id}?t=${tok}`);
  const mine = (view2.data?.offers || []).filter((o) => o.driver.id === m1.id);
  check("oferta reemplazada trae el motivo nuevo", a2.status === 201 && mine.length === 1 && mine[0].reason === "lejos", mine);

  // "No, gracias": el viaje sigue buscando
  const rej = await post(`/rides/${id}/offers/${b.data.offerId}/reject`, { riderPhone: R.rider_phone, riderPin: R.rider_pin });
  const view3 = await api("GET", `/rides/${id}?t=${tok}`);
  check("No, gracias: el viaje sigue buscando", rej.status === 200 && view3.data.status === "buscando" && view3.data.offers.length === 2, view3.data);

  // Aceptar la del motivo: precio acordado correcto
  const acc = await post(`/rides/${id}/offers/${a2.data.offerId}/accept`, { riderPhone: R.rider_phone, riderPin: R.rider_pin });
  check("aceptar la contraoferta con motivo", acc.status === 200 && acc.data.agreedPrice === 33, acc.data);

  console.log(`\n${fail ? "✗" : "✓"} ${pass} bien, ${fail} mal`);
  process.exit(fail ? 1 : 0);
}
main().catch((e) => { console.error("✗ La prueba se cayó:", e); process.exit(1); });
