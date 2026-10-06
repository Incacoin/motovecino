// Prueba de la zona de Progreso (comisarías, Moto Exprés y Propón tu precio).
// La app debe correr con ENABLE_PROGRESO=1 y ADMIN_PIN_PROGRESO en localhost.
//   BASE=http://localhost:3077 node tools/test-progreso.js
const path = require("node:path");
const WebSocket = require("ws");
process.loadEnvFile(path.join(__dirname, "..", ".env"));

const BASE = process.env.BASE || "http://localhost:3077";
if (!/^https?:\/\/(localhost|127\.0\.0\.1)[:/]/.test(BASE)) throw new Error("Esto solo se corre en localhost: " + BASE);
const ADMIN = process.env.ADMIN_PIN;
const ADMIN_PROGRESO = process.env.ADMIN_PIN_PROGRESO;
if (!ADMIN_PROGRESO) throw new Error("Falta ADMIN_PIN_PROGRESO en el ambiente");

const Z = {
  flamboyanes: { lat: 21.2102, lng: -89.6605 },
  chicxulub: { lat: 21.2933, lng: -89.6068 },
  chelem: { lat: 21.2687, lng: -89.7423 },
  centro: { lat: 21.2822, lng: -89.6637 },
};
const off = (p, dLat, dLng = 0) => ({ lat: p.lat + dLat, lng: p.lng + dLng });

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
const get = (u) => api("GET", u);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function driverSocket(id, pin) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`${BASE.replace("http", "ws")}/ws?role=driver&driverId=${id}&pin=${pin}`);
    ws.msgs = [];
    ws.on("message", (raw) => ws.msgs.push(JSON.parse(raw.toString())));
    ws.on("open", () => resolve(ws));
    ws.on("error", reject);
  });
}
async function waitFor(ws, type, ms = 2500) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    const m = ws.msgs.find((x) => x.type === type);
    if (m) return m;
    await sleep(50);
  }
  return null;
}
const stamp = String(Date.now()).slice(-6);

async function main() {
  // ---------- Mapa: comisarías ----------
  for (const [name, p, label, fare] of [["flamboyanes", Z.flamboyanes, "Flamboyanes", 7], ["chicxulub", Z.chicxulub, "Chicxulub", 10], ["chelem", Z.chelem, "Chelem", 10]]) {
    const r = await get(`/cities/resolve?lat=${p.lat}&lng=${p.lng}`);
    check(`resolve ${name}`, r.data.city === "progreso" && r.data.zone === "in" && r.data.comisaria && r.data.comisaria.label === label && r.data.comisaria.fare === fare, r.data);
  }
  const cen = await get(`/cities/resolve?lat=${Z.centro.lat}&lng=${Z.centro.lng}`);
  check("Progreso centro sin viajes", cen.data.zone === "out" && !cen.data.comisaria, cen.data);
  const tk = await get(`/cities/resolve?lat=20.2071&lng=-89.2809`);
  check("Tekax igual que siempre", tk.data.city === "tekax" && tk.data.zone === "in" && tk.data.comisaria === null, tk.data);

  // ---------- Admin de Daniel ----------
  const dl = await post("/admin/login", { adminPin: ADMIN_PROGRESO });
  check("admin de Daniel entra a progreso", dl.status === 200 && dl.data.city === "progreso", dl);
  const mk = async (name, phone) => {
    const r = await post("/admin/drivers", { adminPin: ADMIN_PROGRESO, name, phone, vehicle: "Motocarro", acceptedLegal: true, vehicleType: "moto" });
    check(`alta chofer ${name}`, r.status === 201 && r.data.city === "progreso", r);
    return r.data;
  };
  const dChelem = await mk(`Chelem Uno ${stamp}`, `98100${stamp}`.slice(0, 10));
  const dChelem2 = await mk(`Chelem Dos ${stamp}`, `98200${stamp}`.slice(0, 10));
  const dChix = await mk(`Chicxulub Uno ${stamp}`, `98300${stamp}`.slice(0, 10));
  const tekaxList = await post("/admin/drivers/list", { adminPin: ADMIN });
  check("Tekax no ve choferes de Progreso", !tekaxList.data.some((d) => d.id === dChelem.id), tekaxList.data.length);
  const progList = await post("/admin/drivers/list", { adminPin: ADMIN_PROGRESO });
  check("Daniel ve sus choferes", progList.data.some((d) => d.id === dChelem.id) && progList.data.every((d) => d.city === "progreso"), progList.data.length);

  // ---------- Selector de zona del dueño ----------
  const ownerLogin = await post("/admin/login", { adminPin: ADMIN });
  check("el dueño tiene selector (Tekax y Progreso)", ownerLogin.data.zones && ownerLogin.data.zones.map((z) => z.id).join() === "tekax,progreso", ownerLogin.data);
  const ownerProg = await post("/admin/drivers/list", { adminPin: ADMIN, adminZone: "progreso" });
  check("el dueño ve los choferes de Daniel al cambiar a Progreso", ownerProg.data.some((d) => d.id === dChelem.id) && ownerProg.data.every((d) => d.city === "progreso"), ownerProg.data.length);
  const ownerTk = await post("/admin/drivers/list", { adminPin: ADMIN, adminZone: "tekax" });
  check("el dueño en Tekax no ve los de Progreso", !ownerTk.data.some((d) => d.id === dChelem.id), ownerTk.data.length);
  const danielLogin = await post("/admin/login", { adminPin: ADMIN_PROGRESO, adminZone: "tekax" });
  check("Daniel no tiene selector", danielLogin.data.city === "progreso" && danielLogin.data.zones.length === 1, danielLogin.data);
  const danielTk = await post("/admin/drivers/list", { adminPin: ADMIN_PROGRESO, adminZone: "tekax" });
  check("Daniel NO puede ver Tekax aunque lo pida", danielTk.data.every((d) => d.city === "progreso"), danielTk.data.length);
  const ownerAdd = await post("/admin/drivers", { adminPin: ADMIN, adminZone: "progreso", name: `Alta Dueño ${stamp}`, phone: `98400${stamp}`.slice(0, 10), acceptedLegal: true, vehicleType: "moto" });
  check("el dueño da de alta un chofer en Progreso", ownerAdd.status === 201 && ownerAdd.data.city === "progreso", ownerAdd);

  // ---------- Choferes conectados en su comisaría ----------
  const ws1 = await driverSocket(dChelem.id, dChelem.pin);
  ws1.send(JSON.stringify({ type: "location", ...off(Z.chelem, 0.002) }));
  ws1.send(JSON.stringify({ type: "status", status: "disponible" }));
  const ws2 = await driverSocket(dChelem2.id, dChelem2.pin);
  ws2.send(JSON.stringify({ type: "location", ...off(Z.chelem, -0.002) }));
  ws2.send(JSON.stringify({ type: "status", status: "disponible" }));
  const ws3 = await driverSocket(dChix.id, dChix.pin);
  ws3.send(JSON.stringify({ type: "location", ...off(Z.chicxulub, 0.001) }));
  ws3.send(JSON.stringify({ type: "status", status: "disponible" }));
  await sleep(600);
  const av = await get(`/drivers/available?type=moto&lat=${Z.chelem.lat}&lng=${Z.chelem.lng}`);
  check("mapa en Chelem solo ve choferes de Chelem", av.data.some((d) => d.id === dChelem.id) && !av.data.some((d) => d.id === dChix.id), av.data);

  // ---------- Pasajero ----------
  const phone = `97700${stamp}`.slice(0, 10);
  const reg = await post("/riders/register", { name: "Pasajera Chelem", phone });
  const rider = reg.data;

  // Reglas
  const toCentro = await post("/rides", { rider_phone: phone, rider_pin: rider.pin, pickup_lat: Z.chelem.lat, pickup_lng: Z.chelem.lng, dest_lat: Z.centro.lat, dest_lng: Z.centro.lng, ride_type: "moto" });
  check("no deja ir de Chelem a Progreso centro", toCentro.status === 400 && /Chelem/.test(toCentro.data.error), toCentro);
  const noDest = await post("/rides", { rider_phone: phone, rider_pin: rider.pin, pickup_lat: Z.chelem.lat, pickup_lng: Z.chelem.lng, ride_type: "moto" });
  check("pide destino", noDest.status === 400, noDest);
  const taxi = await post("/rides", { rider_phone: phone, rider_pin: rider.pin, pickup_lat: Z.chelem.lat, pickup_lng: Z.chelem.lng, dest_lat: Z.chelem.lat + 0.003, dest_lng: Z.chelem.lng, ride_type: "taxi", offer_price: 100 });
  check("no hay taxi en Progreso", taxi.status === 400, taxi);
  const fromCentro = await post("/rides", { rider_phone: phone, rider_pin: rider.pin, pickup_lat: Z.centro.lat, pickup_lng: Z.centro.lng, dest_lat: Z.centro.lat + 0.002, dest_lng: Z.centro.lng, ride_type: "moto" });
  check("no se pide desde Progreso centro", fromCentro.status === 400, fromCentro);

  // ---------- Moto Exprés en Chelem ----------
  const exp = await post("/rides", { rider_phone: phone, rider_pin: rider.pin, pickup_lat: Z.chelem.lat, pickup_lng: Z.chelem.lng, dest_lat: Z.chelem.lat + 0.006, dest_lng: Z.chelem.lng, passengers: 2, ride_type: "moto", extra: 10 });
  check("Moto Exprés pedido", exp.status === 201 && exp.data.city === "progreso" && exp.data.offer_price === null, exp);
  check("Moto Exprés en Progreso sin extra (aunque lo manden)", exp.data.extra === 0, exp.data.extra);
  check("le llega al chofer de Chelem", !!(await waitFor(ws1, "new_ride")));
  check("NO le llega al de Chicxulub", !(await waitFor(ws3, "new_ride", 800)));
  const wrongZone = await post(`/rides/${exp.data.id}/accept`, { driverId: dChix.id, pin: dChix.pin });
  check("chofer de otra comisaría no puede aceptar", wrongZone.status === 409, wrongZone);
  const acc = await post(`/rides/${exp.data.id}/accept`, { driverId: dChelem.id, pin: dChelem.pin });
  check("chofer de Chelem acepta", acc.status === 200, acc);
  await post(`/rides/${exp.data.id}/arrived`, { driverId: dChelem.id, pin: dChelem.pin });
  await post(`/rides/${exp.data.id}/start`, { driverId: dChelem.id, pin: dChelem.pin });
  const done = await post(`/rides/${exp.data.id}/complete`, { driverId: dChelem.id, pin: dChelem.pin });
  check("Moto Exprés: ganancia = $10 × 2", done.status === 200 && done.data.todayEarned === 20, done.data);

  // ---------- Propón tu precio ----------
  ws1.msgs.length = 0; ws2.msgs.length = 0;
  const of = await post("/rides", { rider_phone: phone, rider_pin: rider.pin, pickup_lat: Z.chelem.lat, pickup_lng: Z.chelem.lng, dest_lat: Z.chelem.lat + 0.005, dest_lng: Z.chelem.lng, ride_type: "moto", offer_price: 15, extra: 10 });
  check("Propón tu precio pedido ($15)", of.status === 201 && of.data.offer_price === 15 && of.data.extra === 0, of.data);
  check("chofer ve la oferta", !!(await waitFor(ws2, "new_ride")));
  const tooHigh = await post(`/rides/${of.data.id}/offer`, { driverId: dChelem2.id, pin: dChelem2.pin, price: 56 });
  check("contraoferta de más de +$40 se rechaza", tooHigh.status === 400, tooHigh);
  const tooLow = await post(`/rides/${of.data.id}/offer`, { driverId: dChelem2.id, pin: dChelem2.pin, price: 15 });
  check("contraoferta igual o menor se rechaza", tooLow.status === 400, tooLow);
  const offChix = await post(`/rides/${of.data.id}/offer`, { driverId: dChix.id, pin: dChix.pin, price: 20 });
  check("chofer de otra comisaría no contraoferta", offChix.status === 409, offChix);
  const counter = await post(`/rides/${of.data.id}/offer`, { driverId: dChelem2.id, pin: dChelem2.pin, price: 55 });
  check("contraoferta de $55 (+$40) sí", counter.status === 201 && counter.data.price === 55, counter);
  const g = await get(`/rides/${of.data.id}?t=${of.data.share_token}`);
  check("el viaje trae la contraoferta", g.data.offers && g.data.offers.length === 1 && g.data.offers[0].price === 55, g.data.offers);
  const wrongPrice = await post(`/rides/${of.data.id}/accept`, { driverId: dChelem.id, pin: dChelem.pin, agreedPrice: 30 });
  check("aceptar a otro precio = 400", wrongPrice.status === 400, wrongPrice);
  const accOffer = await post(`/rides/${of.data.id}/offers/${counter.data.offerId}/accept`, { riderPhone: phone, riderPin: rider.pin });
  check("pasajera acepta los $55", accOffer.status === 200 && accOffer.data.agreedPrice === 55, accOffer);
  await post(`/rides/${of.data.id}/arrived`, { driverId: dChelem2.id, pin: dChelem2.pin });
  await post(`/rides/${of.data.id}/start`, { driverId: dChelem2.id, pin: dChelem2.pin });
  const done2 = await post(`/rides/${of.data.id}/complete`, { driverId: dChelem2.id, pin: dChelem2.pin });
  check("Propón tu precio: ganancia = $55 − $2", done2.status === 200 && done2.data.todayEarned === 53, done2.data);
  const final = await get(`/rides/${of.data.id}?t=${of.data.share_token}`);
  check("precio acordado guardado", final.data.agreed_price === 55 && final.data.status === "completado", final.data);

  // Aceptar directo la oferta del pasajero
  const of2 = await post("/rides", { rider_phone: phone, rider_pin: rider.pin, pickup_lat: Z.chelem.lat, pickup_lng: Z.chelem.lng, dest_lat: Z.chelem.lat + 0.004, dest_lng: Z.chelem.lng, ride_type: "moto", offer_price: 12 });
  const acc2 = await post(`/rides/${of2.data.id}/accept`, { driverId: dChelem.id, pin: dChelem.pin, agreedPrice: 12 });
  check("chofer acepta la oferta tal cual", acc2.status === 200 && acc2.data.agreed_price === 12, acc2);
  await post(`/rides/${of2.data.id}/cancel`, { riderPhone: phone, riderPin: rider.pin });

  // Admin de Daniel: cuotas y resumen
  const pf = await post(`/admin/drivers/${dChelem2.id}/pending-fees`, { adminPin: ADMIN_PROGRESO });
  check("cuota de la app $2 por viaje", pf.status === 200 && pf.data.amount === 2, pf.data);
  const stats = await post("/admin/stats", { adminPin: ADMIN_PROGRESO });
  check("resumen de Daniel", stats.status === 200 && stats.data.ridesToday >= 2, stats.data);
  const tkStats = await post("/admin/stats", { adminPin: ADMIN });
  check("Tekax admin no ve el chofer de Progreso en su lista", tkStats.status === 200);
  const otherCity = await post(`/admin/drivers/${dChelem.id}/pending-fees`, { adminPin: ADMIN });
  check("Tekax no puede tocar choferes de Progreso", otherCity.status === 404, otherCity);

  for (const w of [ws1, ws2, ws3]) w.close();
  await sleep(300);
  console.log(`\n${fail ? "✗" : "✓"} ${pass} bien, ${fail} mal`);
  process.exit(fail ? 1 : 0);
}

main().catch((e) => {
  console.error("✗ La prueba se cayó:", e);
  process.exit(1);
});
