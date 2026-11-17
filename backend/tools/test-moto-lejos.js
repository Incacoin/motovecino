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
const { CITIES, motoReachesDest, motoReach } = require("../cities");

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

  // 2. La app recibe el alcance (GET: no gasta límites).
  const res = await fetch(`${BASE}/api/cities/resolve?lat=${TICUL.lat}&lng=${TICUL.lng}`).then((r) => r.json());
  check("resolve manda motoReach de Ticul", res.motoReach && res.motoReach.km === 6, res);

  console.log(`\n${fail ? "✗" : "✓"} ${pass} bien, ${fail} mal`);
  process.exit(fail ? 1 : 0);
}
main().catch((e) => { console.error("✗ La prueba se cayó:", e); process.exit(1); });
