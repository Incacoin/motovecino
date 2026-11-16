// Prueba de "Conoce tu municipio" (16-nov-2026):
//  1. La regla de vehículo de "Llévame aquí" (frontend/turismo.js): taxi si el
//     viaje real es largo, regresa a mototaxi solo si el taxi lo puso la sección.
//  2. Los archivos frontend/turismo/<ciudad>.json: lugares completos, cerca del
//     municipio, fotos que existen y con su crédito.
//  3. El servidor acepta el viaje en taxi de Ticul a Uxmal y es de Ticul.
//   BASE=http://localhost:3077 node tools/test-turismo.js
const path = require("node:path");
const fs = require("node:fs");
process.loadEnvFile(path.join(__dirname, "..", ".env"));
const BASE = process.env.BASE || "http://localhost:3077";
if (!/^https?:\/\/(localhost|127\.0\.0\.1)[:/]/.test(BASE)) throw new Error("Esto solo se corre en localhost: " + BASE);

const FRONT = path.join(__dirname, "..", "..", "frontend");
const T = require(path.join(FRONT, "turismo.js"));

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

const TICUL = { lat: 20.39528, lng: -89.53389 };
const UXMAL = { lat: 20.36095, lng: -89.76975 };
const IGLESIA = { lat: 20.396776, lng: -89.534032 };
const north = (km) => ({ lat: TICUL.lat + km / 111, lng: TICUL.lng });

async function main() {
  // 1. Regla de vehículo.
  const v = (o) => T.vehicleFor({ motoKm: 6, serviceZone: "in", ...o });
  check("Uxmal desde el centro en mototaxi → taxi", v({ from: TICUL, to: UXMAL, serviceType: "moto" }) === "taxi");
  check("Uxmal ya en taxi → no tocar", v({ from: TICUL, to: UXMAL, serviceType: "taxi" }) === null);
  check("Iglesia en mototaxi → no tocar", v({ from: TICUL, to: IGLESIA, serviceType: "moto" }) === null);
  check("Iglesia después de Uxmal (taxi puesto por la sección) → mototaxi",
    v({ from: TICUL, to: IGLESIA, serviceType: "taxi", tourForcedTaxi: true }) === "moto");
  check("Iglesia con taxi que eligió el pasajero → no tocar",
    v({ from: TICUL, to: IGLESIA, serviceType: "taxi", tourForcedTaxi: false }) === null);
  check("cerca pero recogida fuera de la zona del mototaxi → no regresar a mototaxi",
    v({ from: TICUL, to: IGLESIA, serviceType: "taxi", tourForcedTaxi: true, serviceZone: "taxi" }) === null);
  // Se mide desde la recogida, no desde el centro: lugar a 5 km al norte,
  // recogida a 5 km al sur = 10 km de viaje.
  const south5 = { lat: TICUL.lat - 5 / 111, lng: TICUL.lng };
  check("lugar a 5 km del centro pero 10 km de la recogida → taxi", v({ from: south5, to: north(5), serviceType: "moto" }) === "taxi");
  check("lugar a 7 km del centro pero 1 km de la recogida → no tocar", v({ from: north(6), to: north(7), serviceType: "moto" }) === null);
  check("sin recogida ni ubicación → no tocar", v({ from: null, to: UXMAL, serviceType: "moto" }) === null);
  check("distancia Ticul–Uxmal ≈ 25 km", Math.abs(T.km(TICUL, UXMAL) - 25) < 1, T.km(TICUL, UXMAL));

  // 2. Archivos de lugares.
  const dir = path.join(FRONT, "turismo");
  const files = fs.readdirSync(dir).filter((f) => f.endsWith(".json"));
  check("hay al menos un municipio con lugares", files.length >= 1, files);
  for (const f of files) {
    const d = JSON.parse(fs.readFileSync(path.join(dir, f), "utf8"));
    check(`${f}: ciudad igual al nombre del archivo`, d.city + ".json" === f, d.city);
    check(`${f}: tiene título y centro`, !!d.titulo && Array.isArray(d.centro) && d.centro.length === 2);
    const centro = { lat: d.centro[0], lng: d.centro[1] };
    const cats = new Set((d.categorias || []).map((c) => c.id));
    const ids = new Set();
    for (const l of d.lugares || []) {
      check(`${f}/${l.id}: id sin repetir`, !ids.has(l.id));
      ids.add(l.id);
      check(`${f}/${l.id}: nombre, descripción y categoría válida`, !!l.n && !!l.d && cats.has(l.cat), l);
      if (l.p) {
        const km = T.km(centro, { lat: l.p[0], lng: l.p[1] });
        check(`${f}/${l.id}: a menos de 40 km del municipio`, km < 40, km);
      }
      if (l.foto) {
        check(`${f}/${l.id}: la foto existe`, fs.existsSync(path.join(dir, "fotos", l.foto + ".webp")), l.foto);
        const c = d.creditos && d.creditos[l.foto];
        check(`${f}/${l.id}: la foto tiene autor, licencia y fuente`, !!(c && c.autor && c.licencia && /^https:\/\/commons\.wikimedia\.org\//.test(c.fuente)), c);
      }
    }
    for (const k of [].concat(d.portada || [])) check(`${f}: foto de portada ${k} existe`, fs.existsSync(path.join(dir, "fotos", k + ".webp")));
  }

  // 3. El viaje en taxi a Uxmal desde el centro de Ticul.
  const stamp = String(Date.now()).slice(-6);
  const reg = await post("/riders/register", { name: "Pasajero Turismo", phone: `97600${stamp}`.slice(0, 10) });
  check("registro de pasajero", reg.status === 200 || reg.status === 201, reg);
  const R = { rider_phone: reg.data.phone, rider_pin: reg.data.pin };
  const ride = await post("/rides", { ...R, pickup_lat: TICUL.lat, pickup_lng: TICUL.lng, dest_lat: UXMAL.lat, dest_lng: UXMAL.lng, dest_label: "Uxmal", ride_type: "taxi", offer_price: 330 });
  check("taxi de Ticul a Uxmal: se puede pedir y es de Ticul", ride.status === 201 && ride.data.city === "ticul", ride);
  if (ride.data && ride.data.id) await post(`/rides/${ride.data.id}/cancel`, { riderPhone: R.rider_phone, riderPin: R.rider_pin });

  console.log(`\n${fail ? "✗" : "✓"} ${pass} bien, ${fail} mal`);
  process.exit(fail ? 1 : 0);
}
main().catch((e) => { console.error("✗ La prueba se cayó:", e); process.exit(1); });
