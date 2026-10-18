// Genera frontend/lugares/<ciudad>.json para el buscador del mapa del pasajero.
// Sale de OpenStreetMap (Overpass): los cruces de calles numeradas ("50 x 47"),
// lugares con nombre del pueblo (escuelas, iglesias, mercado...) y las
// comisarías/pueblos cercanos (sirven para el destino del taxi).
//
// Uso:  node backend/tools/gen-lugares.js tekax
//       ENABLE_PROGRESO=1 node backend/tools/gen-lugares.js progreso flamboyanes
// Para un pueblo nuevo: agregarlo a cities.js y correr esto con su id.
// Ciudad por comisarías (Progreso): un archivo por comisaría (<ciudad>-<zona>.json),
// porque cada una repite los mismos números de calle y el motocarro no sale
// de su comisaría (por eso tampoco lleva pueblos cercanos).
// Los lugares que no estén en OSM se agregan a mano en frontend/lugares/<ciudad>-extra.json.

const fs = require("node:fs");
const path = require("node:path");
const { CITIES } = require("../cities");

const SERVERS = [
  "https://overpass.private.coffee/api/interpreter",
  "https://maps.mail.ru/osm/tools/overpass/api/interpreter",
  "https://overpass-api.de/api/interpreter",
  "https://overpass.kumi.systems/api/interpreter",
];
const STREET_KM = 3.5; // calles y lugares: el área urbana (mínimo)
const STREET_KM_MAX = 7; // municipios grandes (Oxkutzcab, Ticul): su radio de servicio
const PLACES_KM = 50; // comisarías y pueblos: radio del taxi

function bbox(lat, lng, km) {
  const dLat = km / 111;
  const dLng = km / (111 * Math.cos((lat * Math.PI) / 180));
  return [lat - dLat, lng - dLng, lat + dLat, lng + dLng].map((n) => n.toFixed(5)).join(",");
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Overpass es gratis y limita: si contesta 429 (muchas consultas), se espera y se reintenta.
async function overpass(query) {
  for (let intento = 0; intento < 8; intento++) {
    const url = SERVERS[intento % SERVERS.length];
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded", "User-Agent": "MotoVecino-gen-lugares/1.0" },
        body: "data=" + encodeURIComponent(query),
        signal: AbortSignal.timeout(90000),
      });
      if (res.ok) return (await res.json()).elements;
      console.log(`  ${url} → ${res.status}, reintento...`);
    } catch (e) {
      console.log(`  ${url} → ${e.message}, reintento...`);
    }
    await sleep(4000);
  }
  throw new Error("Overpass no respondió");
}

const round = (n) => Math.round(n * 1e6) / 1e6;
// "Calle 50", "C. 50", "Calle 50A" → 50. Solo calles numeradas.
function streetNum(name) {
  const m = /^(?:calle|c\.)\s*(\d{1,3})\b/i.exec((name || "").trim());
  return m ? m[1] : null;
}

async function main() {
  const id = process.argv[2] || "tekax";
  const zoneId = process.argv[3];
  const city = CITIES.find((c) => c.id === id);
  if (!city) throw new Error("Ciudad no encontrada en cities.js: " + id + (id === "progreso" ? " (corre con ENABLE_PROGRESO=1)" : ""));
  const zone = zoneId ? (city.zones || []).find((z) => z.id === zoneId) : null;
  if (zoneId && !zone) throw new Error("Comisaría no encontrada: " + zoneId);
  if (city.zones && !zone) throw new Error("Esta ciudad va por comisarías: " + city.zones.map((z) => z.id).join(", "));
  const center = zone || city;
  const km = zone ? zone.radiusKm + 0.5 : Math.min(Math.max(STREET_KM, city.serviceRadiusKm || 0), STREET_KM_MAX);
  const bb = bbox(center.lat, center.lng, km);

  const streets = await overpass(`[out:json][timeout:90];way["highway"]["name"](${bb});out body;>;out skel qt;`);
  const nodes = new Map();
  const nodeStreets = new Map();
  for (const e of streets) if (e.type === "node") nodes.set(e.id, [e.lat, e.lon]);
  for (const w of streets) {
    if (w.type !== "way") continue;
    const num = streetNum(w.tags.name);
    if (!num) continue;
    for (const n of w.nodes) {
      if (!nodeStreets.has(n)) nodeStreets.set(n, new Set());
      nodeStreets.get(n).add(num);
    }
  }
  // cruces[a][b] = [lat, lng] (se guarda en los dos sentidos al cargar).
  // Las comisarías de junto repiten los números (Pustunich también tiene
  // 23 x 28): se agrupan los puntos que están a menos de CLUSTER_KM y se queda
  // el grupo más cercano al centro. Antes se promediaban todos y la esquina
  // caía en el monte, entre Ticul y Pustunich.
  const CLUSTER_KM = 0.3;
  const kmBetween = (a, b) => Math.hypot((a[0] - b[0]) * 111, (a[1] - b[1]) * 111 * Math.cos((a[0] * Math.PI) / 180));
  const groups = {};
  for (const [n, set] of nodeStreets) {
    if (set.size < 2 || !nodes.has(n)) continue;
    const nums = [...set].sort((a, b) => a - b);
    const p = nodes.get(n);
    for (let i = 0; i < nums.length; i++)
      for (let j = i + 1; j < nums.length; j++) {
        const list = groups[nums[i] + "x" + nums[j]] || (groups[nums[i] + "x" + nums[j]] = []);
        const g = list.find((g) => kmBetween([g[0] / g[2], g[1] / g[2]], p) < CLUSTER_KM);
        if (g) { g[0] += p[0]; g[1] += p[1]; g[2]++; } else list.push([p[0], p[1], 1]);
      }
  }
  const cruces = {};
  const c0 = [center.lat, center.lng];
  for (const [k, list] of Object.entries(groups)) {
    const pts = list.map(([la, ln, c]) => [la / c, ln / c]);
    pts.sort((a, b) => kmBetween(a, c0) - kmBetween(b, c0));
    cruces[k] = [round(pts[0][0]), round(pts[0][1])];
  }

  const pois = await overpass(`[out:json][timeout:90];(
    nwr["name"]["amenity"](${bb});nwr["name"]["shop"](${bb});nwr["name"]["leisure"](${bb});
    nwr["name"]["tourism"](${bb});nwr["name"]["office"](${bb});nwr["name"]["healthcare"](${bb});
    nwr["name"]["historic"](${bb});nwr["name"]["place"~"neighbourhood|suburb|quarter"](${bb});
  );out center tags;`);
  const places = zone ? [] : await overpass(`[out:json][timeout:90];node["place"~"town|village|hamlet"]["name"](${bbox(city.lat, city.lng, PLACES_KM)});out body;`);
  if (!zone && !places.length) console.log("  OJO: no llegaron comisarías/pueblos; vuelve a correr el script más tarde.");

  const seen = new Set();
  const lugares = [];
  function add(name, lat, lng, tipo) {
    const key = name.toLowerCase();
    if (!name || lat == null || seen.has(key)) return;
    seen.add(key);
    lugares.push({ n: name, t: tipo, p: [round(lat), round(lng)] });
  }
  for (const e of pois) {
    const t = e.tags;
    add(t.name, e.lat ?? e.center?.lat, e.lon ?? e.center?.lon, t.place ? "colonia" : "lugar");
  }
  for (const e of places) if (e.tags.name.toLowerCase() !== city.label.toLowerCase()) add(e.tags.name, e.lat, e.lon, "pueblo");

  const fileId = zone ? `${id}-${zone.id}` : id;
  const out = path.join(__dirname, "../../frontend/lugares", fileId + ".json");
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, JSON.stringify({ city: fileId, generado: new Date().toISOString().slice(0, 10), cruces, lugares }));
  console.log(`${out}: ${Object.keys(cruces).length} cruces, ${lugares.length} lugares`);
}

main().catch((e) => { console.error(e.message); process.exit(1); });
