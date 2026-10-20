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
// Correcciones a mano en frontend/lugares/<ciudad>-extra.json (se aplican al generar):
//   "quitar": nombres de OSM que no sirven ("Áreas verdes"),
//   "renombrar": { "nombre en OSM": "nombre como lo dice la gente" },
//   "palabras": { "nombre": "otras formas de buscarlo" } ("centro zocalo"),
//   "lugares": [{ "n": "IMSS", "p": [lat, lng], "b": "hospital clinica" }] los que faltan.
// Solo reaplicar el extra sin volver a pedir OSM:
//   node backend/tools/gen-lugares.js tekax --solo-extra
// Solo agregar las esquinas aproximadas al archivo que ya existe (una sola consulta a OSM):
//   node backend/tools/gen-lugares.js tekax --solo-esquinas
// Esquinas aproximadas (20-oct): en las orillas OSM tiene calles SIN nombre, así
// que "25 x 50" no salía. Se calculan con la cuadrícula (ver completarCruces) y
// llevan un 1 al final ([lat, lng, 1]); el buscador dice "Esquina aproximada".

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

// En Yucatán las calles pares cruzan con las impares; "56 x 58" es un error de
// OSM (una calle mal numerada) y mandaría al pasajero a otro lado.
const crucePosible = (k) => {
  const [a, b] = k.split("x").map(Number);
  return a % 2 !== b % 2;
};

function aplicarExtra(data, fileId) {
  for (const k of Object.keys(data.cruces)) if (!crucePosible(k)) delete data.cruces[k];
  const file = path.join(__dirname, "../../frontend/lugares", fileId + "-extra.json");
  if (!fs.existsSync(file)) return data;
  const extra = JSON.parse(fs.readFileSync(file, "utf8"));
  // "m" = vino del extra: se quitan y se vuelven a poner, para que un lugar
  // corregido o borrado en el extra no se quede con su versión vieja.
  data.lugares = data.lugares.filter((l) => !l.m);
  const key = (n) => n.toLowerCase().replace(/\s+/g, " ").trim();
  const quitar = new Set((extra.quitar || []).map(key));
  const renombrar = new Map(Object.entries(extra.renombrar || {}).map(([a, b]) => [key(a), b]));
  const palabras = new Map(Object.entries(extra.palabras || {}).map(([a, b]) => [key(a), b]));
  let lugares = data.lugares.filter((l) => !quitar.has(key(l.n)));
  for (const l of lugares) {
    if (renombrar.has(key(l.n))) l.n = renombrar.get(key(l.n));
    if (palabras.has(key(l.n))) l.b = palabras.get(key(l.n));
  }
  // Los de a mano van primero y reemplazan a uno de OSM con el mismo nombre.
  const propios = (extra.lugares || []).map((l) => ({ n: l.n, t: l.t || "lugar", p: l.p, ...(l.b ? { b: l.b } : {}), m: 1 }));
  const nombres = new Set(propios.map((l) => key(l.n)));
  lugares = [...propios, ...lugares.filter((l) => !nombres.has(key(l.n)))];
  return { ...data, lugares };
}

// Las calles de aquí son una cuadrícula: las pares cruzan con las nones y el
// número sube de 2 en 2 por cuadra. Con las esquinas conocidas más cercanas
// (en números) se ajusta un plano lat/lng = a + b·par + c·non y se estima la
// esquina que falta; solo se acepta si ahí hay un cruce real de calles en OSM
// (a ≤ SNAP_KM) que no sea ya otra esquina. Probado en Tekax quitando cada
// esquina conocida y volviéndola a calcular: error típico 14 m, 80% ≤ 32 m.
const SNAP_KM = 0.045;
function completarCruces(cruces, todas) {
  const kmBetween = (a, b) => Math.hypot((a[0] - b[0]) * 111, (a[1] - b[1]) * 111 * Math.cos((a[0] * Math.PI) / 180));
  const known = Object.entries(cruces).filter(([k]) => crucePosible(k)).map(([k, p]) => {
    const [a, b] = k.split("x").map(Number);
    return a % 2 ? { e: b, o: a, p } : { e: a, o: b, p };
  });
  if (known.length < 12) return cruces;
  const nodes = new Map(), uses = new Map();
  for (const e of todas) if (e.type === "node") nodes.set(e.id, [e.lat, e.lon]);
  for (const w of todas) if (w.type === "way") for (const n of new Set(w.nodes)) uses.set(n, (uses.get(n) || 0) + 1);
  const reales = [...uses].filter(([, c]) => c >= 2).map(([n]) => nodes.get(n)).filter(Boolean);
  // Mínimos cuadrados de 3 incógnitas (regla de Cramer).
  const det = (m) => m[0][0] * (m[1][1] * m[2][2] - m[1][2] * m[2][1]) - m[0][1] * (m[1][0] * m[2][2] - m[1][2] * m[2][0]) + m[0][2] * (m[1][0] * m[2][1] - m[1][1] * m[2][0]);
  function ajuste(filas, v) {
    const A = [[0, 0, 0], [0, 0, 0], [0, 0, 0]], y = [0, 0, 0];
    filas.forEach((r, i) => { for (let j = 0; j < 3; j++) { y[j] += r[j] * v[i]; for (let k = 0; k < 3; k++) A[j][k] += r[j] * r[k]; } });
    const d = det(A);
    if (Math.abs(d) < 1e-9) return null;
    return [0, 1, 2].map((c) => det(A.map((row, i) => row.map((x, j) => (j === c ? y[i] : x)))) / d);
  }
  function estimar(e, o) {
    const cerca = known.map((k) => ({ k, d: Math.abs(k.e - e) + Math.abs(k.o - o) })).sort((a, b) => a.d - b.d).slice(0, 8);
    if (!cerca.length || cerca[0].d > 8) return null; // máximo 4 cuadras más allá de lo conocido
    if (new Set(cerca.map((c) => c.k.e)).size < 2 || new Set(cerca.map((c) => c.k.o)).size < 2) return null;
    const filas = cerca.map((c) => [1, c.k.e, c.k.o]);
    const la = ajuste(filas, cerca.map((c) => c.k.p[0])), ln = ajuste(filas, cerca.map((c) => c.k.p[1]));
    return la && ln ? [la[0] + la[1] * e + la[2] * o, ln[0] + ln[1] * e + ln[2] * o] : null;
  }
  const es = known.map((k) => k.e), os = known.map((k) => k.o);
  const out = { ...cruces };
  let nuevos = 0;
  for (let e = Math.max(2, Math.min(...es) - 6); e <= Math.max(...es) + 6; e += 2) {
    for (let o = Math.max(1, Math.min(...os) - 8) | 1; o <= Math.max(...os) + 6; o += 2) {
      const k = e < o ? e + "x" + o : o + "x" + e;
      if (out[k]) continue;
      const est = estimar(e, o);
      if (!est) continue;
      let mejor = null, dist = Infinity;
      for (const p of reales) { const d = kmBetween(p, est); if (d < dist) { dist = d; mejor = p; } }
      if (dist > SNAP_KM || known.some((x) => kmBetween(x.p, mejor) < 0.025)) continue;
      out[k] = [round(mejor[0]), round(mejor[1]), 1];
      nuevos++;
    }
  }
  console.log(`  esquinas aproximadas agregadas: ${nuevos}`);
  return out;
}

async function main() {
  const id = process.argv[2] || "tekax";
  const zoneId = process.argv[3] && !process.argv[3].startsWith("--") ? process.argv[3] : null;
  if (process.argv.includes("--solo-extra")) {
    const fileId = zoneId ? `${id}-${zoneId}` : id;
    const out = path.join(__dirname, "../../frontend/lugares", fileId + ".json");
    const data = aplicarExtra(JSON.parse(fs.readFileSync(out, "utf8")), fileId);
    fs.writeFileSync(out, JSON.stringify(data));
    console.log(`${out}: ${Object.keys(data.cruces).length} cruces, ${data.lugares.length} lugares (solo extra)`);
    return;
  }
  const city = CITIES.find((c) => c.id === id);
  if (process.argv.includes("--solo-esquinas")) {
    if (!city || city.zones) throw new Error("--solo-esquinas es para municipios sin comisarías: " + id);
    const out = path.join(__dirname, "../../frontend/lugares", id + ".json");
    const data = JSON.parse(fs.readFileSync(out, "utf8"));
    const bb = bbox(city.lat, city.lng, Math.min(Math.max(STREET_KM, city.serviceRadiusKm || 0), STREET_KM_MAX));
    const todas = await overpass(`[out:json][timeout:90];way["highway"~"^(residential|unclassified|tertiary|secondary|primary|living_street|service|track|road)$"](${bb});out body;>;out skel qt;`);
    // Las aproximadas de antes se vuelven a calcular.
    for (const [k, p] of Object.entries(data.cruces)) if (p[2]) delete data.cruces[k];
    data.cruces = completarCruces(data.cruces, todas);
    fs.writeFileSync(out, JSON.stringify(aplicarExtra(data, id)));
    console.log(`${out}: ${Object.keys(data.cruces).length} cruces`);
    return;
  }
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
  let cruces = {};
  const c0 = [center.lat, center.lng];
  for (const [k, list] of Object.entries(groups)) {
    const pts = list.map(([la, ln, c]) => [la / c, ln / c]);
    pts.sort((a, b) => kmBetween(a, c0) - kmBetween(b, c0));
    cruces[k] = [round(pts[0][0]), round(pts[0][1])];
  }

  const todas = await overpass(`[out:json][timeout:90];way["highway"~"^(residential|unclassified|tertiary|secondary|primary|living_street|service|track|road)$"](${bb});out body;>;out skel qt;`);
  cruces = completarCruces(cruces, todas);

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
  const data = aplicarExtra({ city: fileId, generado: new Date().toISOString().slice(0, 10), cruces, lugares }, fileId);
  fs.writeFileSync(out, JSON.stringify(data));
  console.log(`${out}: ${Object.keys(data.cruces).length} cruces, ${data.lugares.length} lugares`);
}

main().catch((e) => { console.error(e.message); process.exit(1); });
