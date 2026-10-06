// Compara respuesta por respuesta la app vieja (SQLite) y la nueva (Postgres)
// corriendo con LOS MISMOS datos. Solo lectura: no pide ni cambia viajes.
//   OLD=http://localhost:3081 NEW=http://localhost:3082 SQLITE=ruta/motoya.db node tools/comparar-apps.js
const path = require("node:path");
const { DatabaseSync } = require("node:sqlite");
process.loadEnvFile(path.join(__dirname, "..", ".env"));
const OLD = process.env.OLD;
const NEW = process.env.NEW;
for (const u of [OLD, NEW]) if (!/^http:\/\/localhost:\d+$/.test(u || "")) throw new Error("Solo en localhost");
const ADMIN = process.env.ADMIN_PIN;
const lite = new DatabaseSync(process.env.SQLITE, { readOnly: true });

async function call(base, method, url, body) {
  const r = await fetch(base + "/api" + url, {
    method,
    headers: { "Content-Type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
  let data = null;
  try { data = await r.json(); } catch {}
  return { status: r.status, data };
}

// Igualdad profunda; los números con tolerancia mínima (sumas de decimales).
function diff(a, b, at = "") {
  if (typeof a === "number" && typeof b === "number") return Math.abs(a - b) < 1e-9 ? [] : [`${at}: ${a} ≠ ${b}`];
  if (a === null || b === null || typeof a !== "object" || typeof b !== "object") return a === b ? [] : [`${at}: ${JSON.stringify(a)} ≠ ${JSON.stringify(b)}`];
  if (Array.isArray(a) !== Array.isArray(b)) return [`${at}: tipo distinto`];
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  if (Array.isArray(a) && a.length !== b.length) return [`${at}: largo ${a.length} ≠ ${b.length}`];
  let out = [];
  for (const k of keys) {
    if (!(k in a)) out.push(`${at}.${k}: falta en la vieja`);
    else if (!(k in b)) out.push(`${at}.${k}: falta en la nueva`);
    else out = out.concat(diff(a[k], b[k], `${at}.${k}`));
    if (out.length > 5) break;
  }
  return out;
}

let same = 0;
let different = 0;
async function compare(label, method, url, body) {
  const [o, n] = await Promise.all([call(OLD, method, url, body), call(NEW, method, url, body)]);
  const d = o.status !== n.status ? [`status ${o.status} ≠ ${n.status}`] : diff(o.data, n.data);
  if (d.length) {
    different++;
    console.log(`✗ ${label}\n    ${d.slice(0, 5).join("\n    ")}`);
  } else same++;
}

async function main() {
  const A = { adminPin: ADMIN };
  for (const ep of [
    "/admin/login", "/admin/stats", "/admin/drivers/list", "/admin/riders/list", "/admin/rides/list",
    "/admin/reports/cancelaciones", "/admin/chofer-solicitudes/list", "/admin/ally-ads/list",
    "/admin/businesses/list", "/admin/food/status", "/admin/family-rides",
  ]) await compare(ep, "POST", ep, A);

  for (const ep of [
    "/config", "/drivers/ranking", "/cities", "/cities/resolve?lat=20.2071&lng=-89.2809",
    "/drivers/available?type=moto&lat=20.2071&lng=-89.2809", "/drivers/available?type=taxi&lat=20.2071&lng=-89.2809",
    "/food/businesses?city=tekax", "/taxi/suggest?plat=20.2071&plng=-89.2809&dlat=20.3028&dlng=-89.4180",
  ]) await compare(ep, "GET", ep);

  const drivers = lite.prepare("SELECT id, phone, pin FROM drivers ORDER BY id").all();
  for (const d of drivers) {
    await compare(`chofer ${d.id} login`, "POST", "/drivers/login", { phone: d.phone, pin: d.pin });
    await compare(`chofer ${d.id} perfil`, "POST", "/drivers/profile", { phone: d.phone, pin: d.pin });
    await compare(`chofer ${d.id} viaje activo`, "POST", "/rides/active", { driverId: d.id, pin: d.pin });
    for (const ep of ["pending-fees", "payments", "activity"]) {
      await compare(`chofer ${d.id} ${ep}`, "POST", `/admin/drivers/${d.id}/${ep}`, A);
    }
  }

  const riders = lite.prepare("SELECT id, phone, pin FROM riders WHERE pin IS NOT NULL ORDER BY id").all();
  for (const r of riders) await compare(`pasajero ${r.id} login`, "POST", "/riders/login", { phone: r.phone, pin: r.pin });

  const rides = lite.prepare("SELECT id, share_token FROM rides WHERE share_token IS NOT NULL ORDER BY id DESC LIMIT 150").all();
  for (const r of rides) await compare(`viaje ${r.id}`, "GET", `/rides/${r.id}?t=${r.share_token}`);

  console.log(`\n${different ? "✗" : "✓"} ${same} respuestas iguales, ${different} diferentes`);
  process.exit(different ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
