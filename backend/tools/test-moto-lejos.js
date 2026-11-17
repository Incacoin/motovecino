// Prueba (17-nov-2026): el mototaxi solo deja dentro de su municipio.
// Antes solo se revisaba la recogida y se podía pedir mototaxi de Ticul a
// Uxmal (30 km) por $17. Ahora el destino también tiene que caer dentro del
// radio del mototaxi (serviceRadiusKm); más lejos es taxi.
// Los viajes de verdad (Ticul → Uxmal, Tekax → Akil) se prueban en
// test-comisarias.js con su mismo pasajero: cada registro cuenta para el
// límite de 20 por hora y npm test ya está cerca del tope.
//   BASE=http://localhost:3077 node tools/test-moto-lejos.js
const path = require("node:path");
process.loadEnvFile(path.join(__dirname, "..", ".env"));
const BASE = process.env.BASE || "http://localhost:3077";
if (!/^https?:\/\/(localhost|127\.0\.0\.1)[:/]/.test(BASE)) throw new Error("Esto solo se corre en localhost: " + BASE);
const { CITIES, motoReachesDest, motoReach, getCityById } = require("../cities");
const { haversineKm } = require("../geo");

let pass = 0;
let fail = 0;
function check(label, cond, extra) {
  if (cond) pass++;
  else {
    fail++;
    console.log("✗", label, extra !== undefined ? JSON.stringify(extra).slice(0, 300) : "");
  }
}

const TICUL = { lat: 20.39528, lng: -89.53389 };
const UXMAL = { lat: 20.36095, lng: -89.76975 };
const north = (p, km) => ({ lat: p.lat + km / 111, lng: p.lng });

async function main() {
  // 1. La regla, municipio por municipio: justo adentro sí, justo afuera no.
  for (const c of CITIES) {
    const r = motoReach(c.id);
    if (!r) continue;
    const inside = north(c, r.km - 0.2);
    const outside = north(c, r.km + 0.2);
    check(`${c.label}: destino a ${r.km - 0.2} km sí`, motoReachesDest(c.id, inside.lat, inside.lng));
    check(`${c.label}: destino a ${r.km + 0.2} km no`, !motoReachesDest(c.id, outside.lat, outside.lng));
  }
  check("Ticul llega a 6 km", motoReach("ticul") && motoReach("ticul").km === 6);
  check("Ticul → Uxmal no", !motoReachesDest("ticul", UXMAL.lat, UXMAL.lng));
  check("sin destino no bloquea", motoReachesDest("ticul", null, null));

  // Oxkutzcab y Akil se enciman (centros a ~8.4 km, radio de Oxkutzcab 7):
  // a 6.5 km de Oxkutzcab rumbo a Akil ya es Akil → no; a 3 km sí.
  const OX = getCityById("oxkutzcab");
  const AK = getCityById("akil");
  const toward = (a, b, km) => {
    const f = km / haversineKm(a.lat, a.lng, b.lat, b.lng);
    return { lat: a.lat + (b.lat - a.lat) * f, lng: a.lng + (b.lng - a.lng) * f };
  };
  const p65 = toward(OX, AK, 6.5);
  const p3 = toward(OX, AK, 3);
  check("Oxkutzcab → orilla de Akil (6.5 km): no", !motoReachesDest("oxkutzcab", p65.lat, p65.lng));
  check("Oxkutzcab → 3 km rumbo a Akil: sí", motoReachesDest("oxkutzcab", p3.lat, p3.lng));

  // La app (destTooFarForMoto en frontend/pasajero.html) usa esta misma cuenta
  // con lo que manda motoReach. Tiene que dar lo mismo que el servidor en una
  // cuadrícula alrededor de cada municipio (si no, la app deja elegir mototaxi
  // y el servidor lo rechaza, o al revés).
  const appFar = (r, p) => {
    const own = haversineKm(p.lat, p.lng, r.lat, r.lng);
    if (own > r.km) return true;
    return (r.others || []).some((o) => {
      const d = haversineKm(p.lat, p.lng, o.lat, o.lng);
      return d <= o.km && d < own;
    });
  };
  let differ = 0;
  let tried = 0;
  for (const c of CITIES) {
    const r = motoReach(c.id);
    if (!r) continue;
    for (let dy = -9; dy <= 9; dy += 0.5) {
      for (let dx = -9; dx <= 9; dx += 0.5) {
        const p = { lat: c.lat + dy / 111, lng: c.lng + dx / 104 };
        tried++;
        if (appFar(r, p) === motoReachesDest(c.id, p.lat, p.lng)) differ++;
      }
    }
  }
  check(`app y servidor dicen lo mismo (${tried} puntos)`, differ === 0, { differ });

  // Los agendados de antes de la regla (keepMotoDest) se prueban de verdad en
  // test-agendar.js: se le sube el precio y sale a su hora.

  // 2. La app recibe el alcance (GET: no gasta límites).
  const res = await fetch(`${BASE}/api/cities/resolve?lat=${TICUL.lat}&lng=${TICUL.lng}`).then((r) => r.json());
  check("resolve manda motoReach de Ticul", res.motoReach && res.motoReach.km === 6 && Array.isArray(res.motoReach.others), res);
  const out = await fetch(`${BASE}/api/cities/resolve?lat=21.5&lng=-88.0`).then((r) => r.json());
  check("fuera de todo municipio: sin motoReach", out.motoReach === null, out);
  const p9 = north(TICUL, 9);
  const com = await fetch(`${BASE}/api/cities/resolve?lat=${p9.lat}&lng=${p9.lng}`).then((r) => r.json());
  check("comisaría de Ticul (solo taxi): sin motoReach", com.zone === "taxi" && com.motoReach === null, com);

  console.log(`\n${fail ? "✗" : "✓"} ${pass} bien, ${fail} mal`);
  // exitCode (no process.exit): cortar de golpe con conexiones de fetch
  // cerrándose tumba a Node en Windows y la prueba sale como fallida.
  process.exitCode = fail ? 1 : 0;
}
main().catch((e) => { console.error("✗ La prueba se cayó:", e); process.exit(1); });
