// Tarifa del mototaxi en Ticul según la hoja oficial de la Dirección de
// Transporte (25-nov-2026): de noche el viaje corto (hasta 0.5 km) tiene su
// propio mínimo ($15; el largo $20) y el mototaxi lleva máximo 3 adultos y
// 1 niño. El taxi y Tekax siguen igual.
//   BASE=http://localhost:3077 node tools/test-tarifa-ticul.js
const path = require("node:path");
const fs = require("node:fs");
const envFile = path.join(__dirname, "..", ".env");
if (fs.existsSync(envFile)) process.loadEnvFile(envFile);
const BASE = process.env.BASE || "http://localhost:3077";
if (!/^https?:\/\/(localhost|127\.0\.0\.1)[:/]/.test(BASE)) throw new Error("Esto solo se corre en localhost: " + BASE);

const SAN_JUAN = { lat: 20.39866, lng: -89.527154 }; // Parque de San Juan
const MERCADO = { lat: 20.397676, lng: -89.537258 }; // ~1.1 km: viaje largo
const CERCA = { lat: 20.39866, lng: -89.5305 }; // ~0.35 km: viaje corto
const TEKAX = { lat: 20.2071, lng: -89.2809 };
const SAN_ENRIQUE = { lat: 20.397151, lng: -89.544172 }; // ~1.8 km del Parque de San Juan: largo normal
const PUNTA = { lat: 20.39866, lng: -89.552 }; // ~2.5 km al poniente: de punta a punta

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
  // IP propia: no gasta los límites que comparten las demás pruebas.
  const res = await fetch(BASE + "/api" + url, { method, headers: { "Content-Type": "application/json", "X-Forwarded-For": "10.77.0.25" }, body: body ? JSON.stringify(body) : undefined });
  let data = null;
  try { data = await res.json(); } catch {}
  return { status: res.status, data };
}
const post = (u, b) => api("POST", u, b);
const stamp = String(Date.now()).slice(-6);

async function main() {
  const reg = await post("/riders/register", { name: "Pasajero Tarifa Ticul", phone: `96400${stamp}`.slice(0, 10), lat: SAN_JUAN.lat, lng: SAN_JUAN.lng });
  check("alta del pasajero", reg.status === 201, reg);
  const R = { rider_phone: reg.data.phone, rider_pin: reg.data.pin };
  const pedir = (extra) => post("/rides", { ...R, pickup_lat: SAN_JUAN.lat, pickup_lng: SAN_JUAN.lng, dest_lat: MERCADO.lat, dest_lng: MERCADO.lng, ride_type: "moto", ...extra });
  const cancelar = (r) => r.data?.id && post(`/rides/${r.data.id}/cancel`, { riderPhone: R.rider_phone, riderPin: R.rider_pin });

  // Reglas que recibe la app del pasajero en Ticul
  const res = await api("GET", `/cities/resolve?lat=${SAN_JUAN.lat}&lng=${SAN_JUAN.lng}`);
  const o = res.data?.cityOffer || {};
  check("Ticul: de día corto $10 y largo $15", o.minOfferShort === 10 && o.minOffer === 15 && o.shortTripKm === 0.5, o);
  check("Ticul: de noche corto $15 y largo $20", o.minOfferShortNight === 15 && o.minOfferNight === 20, o);
  check("Ticul: niño $5 de día y $10 de noche", o.minChild === 5 && o.minChildNight === 10, o);
  check("Ticul: máximo 3 adultos y 1 niño", o.maxAdults === 3 && o.maxChildren === 1, o);
  check("Ticul: de punta a punta (2.5 km) $25 de día y $30 de noche", o.longTripKm === 2.5 && o.minOfferLong === 25 && o.minOfferLongNight === 30, o);
  const tk = await api("GET", `/cities/resolve?lat=${TEKAX.lat}&lng=${TEKAX.lng}`);
  check("Tekax: sin cupo especial ni corto de noche", tk.data?.cityOffer && tk.data.cityOffer.maxAdults === undefined && tk.data.cityOffer.minOfferShortNight === undefined, tk.data?.cityOffer);

  // Cupo del mototaxi en Ticul
  const cuatro = await pedir({ passengers: 4, children: 0, offer_price: 62 });
  check("Ticul: 4 adultos en mototaxi no", cuatro.status === 400 && /3 adultos y 1 niño/.test(cuatro.data?.error || ""), cuatro);
  const dosNinos = await pedir({ passengers: 2, children: 2, offer_price: 42 });
  check("Ticul: 2 niños en mototaxi no", dosNinos.status === 400 && /Taxi/.test(dosNinos.data?.error || ""), dosNinos);
  const bajo = await pedir({ passengers: 3, children: 1, offer_price: 51 });
  check("Ticul: 3 adultos + 1 niño, menos de $52 no", bajo.status === 400 && /52/.test(bajo.data?.error || ""), bajo);
  const ok = await pedir({ passengers: 3, children: 1, offer_price: 52 });
  check("Ticul: 3 adultos + 1 niño por $52 sí", ok.status === 201 && ok.data?.passengers === 3 && ok.data?.children === 1, ok);
  await cancelar(ok);

  // Viaje corto de día sigue en $10 (+$2 de la app)
  const corto = await post("/rides", { ...R, pickup_lat: SAN_JUAN.lat, pickup_lng: SAN_JUAN.lng, dest_lat: CERCA.lat, dest_lng: CERCA.lng, ride_type: "moto", offer_price: 12 });
  check("Ticul: viaje corto por $12 sí", corto.status === 201, corto);
  await cancelar(corto);

  // De punta a punta: 2.5 km o más, mínimo $25 (+$2 de la app)
  const viaje = (d, price, extra) => post("/rides", { ...R, pickup_lat: SAN_JUAN.lat, pickup_lng: SAN_JUAN.lng, dest_lat: d.lat, dest_lng: d.lng, ride_type: "moto", offer_price: price, ...extra });
  const puntaBajo = await viaje(PUNTA, 26);
  check("Ticul: de punta a punta, menos de $27 no", puntaBajo.status === 400 && /27/.test(puntaBajo.data?.error || ""), puntaBajo);
  const puntaOk = await viaje(PUNTA, 27);
  check("Ticul: de punta a punta por $27 sí", puntaOk.status === 201, puntaOk);
  await cancelar(puntaOk);
  const puntaNino = await viaje(PUNTA, 31, { passengers: 1, children: 1 });
  check("Ticul: de punta a punta con niño por $32, $31 no", puntaNino.status === 400 && /32/.test(puntaNino.data?.error || ""), puntaNino);
  const normal = await viaje(SAN_ENRIQUE, 17);
  check("Ticul: 1.8 km sigue en $17 (no es de punta a punta)", normal.status === 201, normal);
  await cancelar(normal);

  // Viaje agendado antes del cambio (keepMotoDest): no se le exige el mínimo de punta a punta
  const { getCityById, cityMinOffer } = require("../cities");
  const ticul = getCityById("ticul");
  check("agendado viejo de punta a punta: mínimo $17, no $27", cityMinOffer(ticul, 1, 0, 2.6, { noLong: true }) === 17 && cityMinOffer(ticul, 1, 0, 2.6) === 27);

  // El taxi no tiene ese cupo
  const taxi = await pedir({ ride_type: "taxi", passengers: 4, children: 0, offer_price: 80 });
  check("Ticul: el taxi sí lleva 4 adultos", taxi.status === 201, taxi);
  await cancelar(taxi);

  // Tekax sigue como antes: 4 adultos en mototaxi sí
  const tek = await post("/rides", { ...R, pickup_lat: TEKAX.lat, pickup_lng: TEKAX.lng, dest_lat: TEKAX.lat + 0.01, dest_lng: TEKAX.lng, ride_type: "moto", passengers: 4, offer_price: 62 });
  check("Tekax: 4 adultos en mototaxi sí (sin cambio)", tek.status === 201, tek);
  await cancelar(tek);

  console.log(fail ? `NO: ${fail} fallaron, ${pass} bien` : `Todo bien (${pass})`);
}

main()
  .catch((e) => { console.error(e); fail++; })
  .finally(() => process.exit(fail ? 1 : 0));
