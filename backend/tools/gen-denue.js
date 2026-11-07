// Saca lugares útiles para el buscador desde el DENUE del INEGI (directorio
// oficial de negocios, con ubicación): escuelas, salud, farmacias, súpers,
// Oxxos, bancos, gobierno, iglesias, hoteles, salones, restaurantes...
// OpenStreetMap casi no tiene eso en el sur de Yucatán (7-nov: en Ticul no
// salía "mercado", "hospital", "oxxo", "escuela", "farmacia").
//
// Uso (el CSV se baja de inegi.org.mx → DENUE → descarga masiva → Yucatán,
// denue_31_csv.zip; no se sube al repo):
//   node backend/tools/gen-denue.js <ruta/denue_inegi_31_.csv> ticul
//   node backend/tools/gen-denue.js <csv> ticul --municipio "Ticul"
// Escribe frontend/lugares/<ciudad>-denue.json. Después se aplica con:
//   node backend/tools/gen-lugares.js ticul --solo-extra
// (gen-lugares lo junta: primero lo de a mano, luego DENUE, luego OSM).

const fs = require("node:fs");
const path = require("node:path");
const { CITIES } = require("../cities");

// Categoría del DENUE (nombre_act, sin acentos) → palabras para buscarlo.
// Solo lo que la gente usa como destino; el orden importa (gana la primera).
const CATS = [
  [/veterinari/, null], // "hospital veterinario" no es hospital
  [/preescolar|educacion inicial|guarderia/, "escuela kinder jardin de ninos preescolar"],
  [/primaria y secundaria|combinan/, "escuela primaria secundaria"],
  [/primaria/, "escuela primaria"],
  [/secundaria/, "escuela secundaria"],
  [/media superior|bachiller/, "escuela prepa preparatoria bachillerato"],
  [/educacion superior/, "escuela universidad normal tecnologico"],
  [/escuelas? .*(especial|educacion para necesidades|atencion multiple)/, "escuela"],
  [/escuelas? de (computacion|idiomas|oficios|arte|deporte)|otros servicios educativos/, "academia cursos clases"],
  [/hospitales?/, "hospital clinica salud"],
  [/medicina general del sector publico|centros? de salud|sector publico.*consultorio/, "centro de salud clinica doctor medico"],
  [/consultorios? de medicina (general|especializada)/, "consultorio doctor medico clinica"],
  [/consultorios? dentales/, "dentista consultorio dental"],
  [/laboratorios? (medicos|clinicos)/, "laboratorio analisis clinico"],
  [/farmacias?/, "farmacia botica medicinas"],
  [/supermercados|tiendas departamentales|autoservicio/, "super supermercado tienda"],
  [/minisuper/, "tienda minisuper"],
  [/banca multiple|banca de desarrollo/, "banco cajero"],
  [/cajas de ahorro|cooperativas|sociedades financieras|uniones de credito/, "caja de ahorro financiera"],
  [/casas de empeno/, "empeno casa de empeno"],
  [/gasolina|diesel|gas l\.?p|gas licuado/, "gasolinera gasolina pemex"],
  [/transporte colectivo|autotransporte foraneo de pasajeros|terminales? de autobus|sitios? de taxi/, "terminal camiones autobus colectivos"],
  [/administracion publica|actividades administrativas|seguridad nacional|policia|bomberos|imparticion de justicia|procuracion|registro civil|actividades legislativas|regulacion y fomento/, "gobierno oficina"],
  [/bibliotecas/, "biblioteca"],
  [/asociaciones y organizaciones religiosas/, "iglesia templo capilla"],
  [/hoteles|moteles|cabanas|villas|pensiones|casas de huespedes/, "hotel hospedaje"],
  [/salones para fiestas/, "salon de fiestas eventos"],
  [/restaurantes|cafeterias|neverias|bares|cantinas/, "restaurante comida"],
  [/acondicionamiento fisico|clubes deportivos|campos de golf|centros deportivos/, "gimnasio gym deportivo"],
  [/correo|mensajeria|paqueteria/, "paqueteria envios"],
  [/^comercio al por menor en ferreterias/, "ferreteria tlapaleria"],
];

// Nombres que no dicen nada ("ABARROTES", "SIN NOMBRE"): esos no entran.
const GENERICOS = /^(sin nombre|antojitos?|cafeteria|bar|cocteleria|pizzeria|panaderia|abarrotes?|tienda|miscelanea|farmacia|restaurante|loncheria|cocina economica|taqueria|fonda|salon|consultorio|ferreteria|tortilleria|antojitos|ninguno|n\/a)$/;
const PEQUENAS = new Set(["de", "del", "y", "e", "en", "a", "con", "por"]);
// Tampoco los que describen el giro en vez de nombrarlo ("Venta de hotdog...").
const DESCRIPTIVOS = /^(venta|elaboracion|preparacion|expendio|puesto|taller|fabrica|bodega|comercio|distribuidora de|renta|servicio de|servicios de)\b/;
// Siglas que se quedan en mayúsculas.
const SIGLAS = new Set(["dif", "imss", "issste", "isste", "cfe", "cetis", "cbtis", "cobay", "conalep", "inea", "sat", "bbva", "hsbc", "oxxo", "ii", "iii", "iv", "jmas", "japay", "cecytey", "uady", "cam", "ceba", "ine", "sep", "ssy", "umf", "usaer", "pemex", "ado"]);

const quitarAcentos = (t) => t.normalize("NFD").replace(/[̀-ͯ]/g, "");
const norm = (t) => quitarAcentos(String(t || "").toLowerCase()).replace(/\s+/g, " ").trim();

function titulo(t) {
  return String(t).toLowerCase().replace(/\s+/g, " ").trim().split(" ").map((w, i) => {
    const k = quitarAcentos(w).replace(/[^a-z]/g, "");
    if (SIGLAS.has(k)) return w.toUpperCase();
    if (i > 0 && PEQUENAS.has(w)) return w;
    return w.charAt(0).toUpperCase() + w.slice(1);
  }).join(" ");
}

// Los Oxxo y bancos traen claves internas: "OXXO SUC 50F1V TICULENO MID" → "Oxxo Ticuleño".
function limpiarNombre(n) {
  return n
    .replace(/\bSUC(URSAL)?\.?\s*[A-Z0-9]*\d[A-Z0-9]*\b/gi, "")
    .replace(/\b(MID|MER|YUC)\b\s*$/i, "")
    .replace(/\bT\d{3,}\b/g, "")
    .replace(/\b\d{3,}\b/g, "")
    .replace(/\bSIN NOMBRE\b/gi, "")
    .replace(/\s+/g, " ").trim();
}

function calle(v) {
  const s = String(v || "").trim();
  if (!s || /ningun|sin nombre|no aplica/i.test(s)) return null;
  return s.replace(/^calle\s+/i, "").toLowerCase().replace(/\b\w/g, (c) => c.toUpperCase()).replace(/\s+/g, " ");
}

// "Calle 23 x 28 y 30" con la calle y sus entrecalles.
function direccion(r) {
  const a = calle(r.nom_vial), b = calle(r.nom_v_e_1), c = calle(r.nom_v_e_2);
  if (!a) return null;
  const pre = /^\d/.test(a) ? "Calle " : "";
  if (b && c) return `${pre}${a} x ${b} y ${c}`;
  if (b) return `${pre}${a} x ${b}`;
  return `${pre}${a}`;
}

// CSV del INEGI: comillas dobles, comas, latin1.
function parseCsv(text) {
  const rows = [];
  let row = [], field = "", q = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (q) {
      if (ch === '"') { if (text[i + 1] === '"') { field += '"'; i++; } else q = false; }
      else field += ch;
    } else if (ch === '"') q = true;
    else if (ch === ",") { row.push(field); field = ""; }
    else if (ch === "\n") { row.push(field); rows.push(row); row = []; field = ""; }
    else if (ch !== "\r") field += ch;
  }
  if (field || row.length) { row.push(field); rows.push(row); }
  return rows;
}

function km(a, b, c, d) {
  const R = 6371, r = Math.PI / 180;
  const x = Math.sin(((c - a) * r) / 2) ** 2 + Math.cos(a * r) * Math.cos(c * r) * Math.sin(((d - b) * r) / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(x));
}

function main() {
  const [csvPath, cityId] = process.argv.slice(2);
  if (!csvPath || !cityId) {
    console.error("Uso: node backend/tools/gen-denue.js <denue_inegi_31_.csv> <ciudad> [--municipio Nombre]");
    process.exit(1);
  }
  const city = CITIES.find((c) => c.id === cityId);
  if (!city) throw new Error("Ciudad no encontrada en cities.js: " + cityId);
  const mi = process.argv.indexOf("--municipio");
  const municipio = norm(mi > 0 ? process.argv[mi + 1] : city.label);
  const radio = Math.max(city.labelRadiusKm || 0, city.serviceRadiusKm || 0, 4) + 1;

  const rows = parseCsv(fs.readFileSync(csvPath, "latin1"));
  const head = rows.shift().map((h) => h.trim());
  const col = Object.fromEntries(head.map((h, i) => [h, i]));
  const get = (r, k) => (r[col[k]] || "").trim();

  const cuenta = {};
  for (const raw of rows) if (norm(get(raw, "municipio")) === municipio) { const l = norm(get(raw, "localidad")); cuenta[l] = (cuenta[l] || 0) + 1; }
  const cabecera = Object.entries(cuenta).sort((a, b) => b[1] - a[1])[0]?.[0] || municipio;

  const out = [];
  const mercado = [];
  for (const raw of rows) {
    if (norm(get(raw, "municipio")) !== municipio) continue;
    const lat = parseFloat(get(raw, "latitud")), lng = parseFloat(get(raw, "longitud"));
    if (!isFinite(lat) || !isFinite(lng) || km(city.lat, city.lng, lat, lng) > radio) continue;
    const r = Object.fromEntries(head.map((h) => [h, get(raw, h)]));
    if (/mercado/i.test(r.tipoCenCom) && r.nom_CenCom && !/sin nombre/i.test(r.nom_CenCom)) mercado.push([lat, lng, r.nom_CenCom, direccion(r)]);

    const act = norm(r.nombre_act);
    const cat = CATS.find(([re]) => re.test(act));
    if (!cat || !cat[1]) continue;
    const limpio = limpiarNombre(r.nom_estab);
    if (!limpio || GENERICOS.test(norm(limpio)) || DESCRIPTIVOS.test(norm(limpio)) || norm(limpio).length < 4) continue;
    let n = titulo(limpio);
    // Comisarías dentro del radio (Pustunich, Yotholín...): que se note.
    const loc = r.localidad.replace(/\s+/g, " ").trim();
    // La cabecera es la localidad con más negocios (el INEGI dice "Tekax de
    // Álvaro Obregón", no "Tekax"); las demás son comisarías.
    const enComisaria = loc && norm(loc) !== cabecera;
    if (enComisaria) n += ` (${loc})`;
    let b = cat[1];
    if (/oxxo/i.test(n)) b += " oxxo";
    if (/similares/i.test(n)) b += " similares";
    if (/\bdif\b/i.test(n)) b += " dif";
    if (/\bimss\b/i.test(n)) b += " imss seguro social";
    // "x" = está en una comisaría: sus calles repiten números de la cabecera,
    // así que no sirve de referencia para calcular esquinas (gen-lugares).
    out.push({ n, p: [+lat.toFixed(6), +lng.toFixed(6)], b, ...(direccion(r) ? { s: direccion(r) } : {}), ...(enComisaria ? { x: 1 } : {}) });
  }

  // El mercado viene como cientos de locales "dentro de" él: un solo punto al centro.
  const porMercado = {};
  for (const [lat, lng, nom, dir] of mercado) (porMercado[nom] = porMercado[nom] || []).push([lat, lng, dir]);
  for (const [nom, pts] of Object.entries(porMercado)) {
    if (pts.length < 5) continue;
    const lat = pts.reduce((s, p) => s + p[0], 0) / pts.length;
    const lng = pts.reduce((s, p) => s + p[1], 0) / pts.length;
    // La dirección que más se repite entre sus locales.
    const dirs = {};
    for (const p of pts) if (p[2]) dirs[p[2]] = (dirs[p[2]] || 0) + 1;
    const s = Object.entries(dirs).sort((a, b) => b[1] - a[1])[0];
    out.unshift({ n: titulo(nom), p: [+lat.toFixed(6), +lng.toFixed(6)], b: "mercado municipal centro", ...(s ? { s: s[0] } : {}) });
  }

  // Mismo nombre a menos de 80 m = el mismo lugar registrado dos veces.
  const finales = [];
  for (const l of out) {
    if (finales.some((f) => norm(f.n) === norm(l.n) && km(f.p[0], f.p[1], l.p[0], l.p[1]) < 0.08)) continue;
    finales.push(l);
  }
  const file = path.join(__dirname, "../../frontend/lugares", `${cityId}-denue.json`);
  fs.writeFileSync(file, JSON.stringify({ fuente: "INEGI DENUE", lugares: finales }));
  const porTipo = {};
  for (const l of finales) { const k = l.b.split(" ")[0]; porTipo[k] = (porTipo[k] || 0) + 1; }
  console.log(`${file}: ${finales.length} lugares`, porTipo);
}

main();
