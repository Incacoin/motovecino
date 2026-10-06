// Prueba de la sesión del admin (pase/token) y del registro de movimientos.
//   BASE=http://localhost:3077 DATABASE_URL=postgres://...localhost... node tools/test-sesion.js
const path = require("node:path");
process.loadEnvFile(path.join(__dirname, "..", ".env"));
const BASE = process.env.BASE || "http://localhost:3077";
for (const u of [BASE, process.env.DATABASE_URL]) {
  if (!/^(https?|postgres):\/\/([^@/]*@)?(localhost|127\.0\.0\.1)[:/]/.test(String(u))) throw new Error("Esto solo se corre en localhost: " + u);
}
const db = require("../db");
const ADMIN = process.env.ADMIN_PIN;

let pass = 0;
let fail = 0;
function check(label, cond, extra) {
  if (cond) pass++;
  else {
    fail++;
    console.log("✗", label, extra !== undefined ? JSON.stringify(extra).slice(0, 300) : "");
  }
}
async function post(url, body, token) {
  const headers = { "Content-Type": "application/json" };
  if (token) headers.Authorization = "Bearer " + token;
  const res = await fetch(BASE + "/api" + url, { method: "POST", headers, body: JSON.stringify(body || {}) });
  let data = null;
  try { data = await res.json(); } catch {}
  return { status: res.status, data };
}

async function main() {
  // Entrar con PIN → pase
  const login = await post("/admin/login", { adminPin: ADMIN });
  check("entrar con PIN da un pase", login.status === 200 && typeof login.data.token === "string" && login.data.token.length >= 40, login.data);
  const T = login.data.token;
  const row = await db.prepare("SELECT token_hash FROM admin_sessions ORDER BY id DESC LIMIT 1").get();
  check("en la base no está el pase, solo su huella", row && row.token_hash !== T && row.token_hash.length === 64);

  // Usar el pase sin PIN
  const list = await post("/admin/drivers/list", {}, T);
  check("con el pase se usa el admin sin PIN", list.status === 200 && Array.isArray(list.data), list.status);
  const re = await post("/admin/login", {}, T);
  check("reabrir con el pase entra sin crear otro", re.status === 200 && !re.data.token && re.data.role === "tekax", re.data);

  // Pase falso / vencido
  const fake = await post("/admin/drivers/list", {}, "x".repeat(43));
  check("pase falso = 401 sesión cerrada", fake.status === 401 && fake.data.sessionExpired === true, fake.data);
  await db.prepare("UPDATE admin_sessions SET last_seen_ms = last_seen_ms - ? WHERE token_hash = ?").run(13 * 3600 * 1000, row.token_hash);
  const idle = await post("/admin/drivers/list", {}, T);
  check("pase sin usar 13 h = vencido", idle.status === 401 && idle.data.sessionExpired === true, idle.data);

  // Salir
  const l2 = await post("/admin/login", { adminPin: ADMIN });
  const T2 = l2.data.token;
  const out = await post("/admin/logout", {}, T2);
  const after = await post("/admin/drivers/list", {}, T2);
  check("después de cerrar sesión el pase ya no sirve", out.status === 200 && after.status === 401, after);

  // Cerrar en todos los celulares
  const a = (await post("/admin/login", { adminPin: ADMIN })).data.token;
  const b = (await post("/admin/login", { adminPin: ADMIN })).data.token;
  const all = await post("/admin/logout-all", {}, a);
  const ra = await post("/admin/drivers/list", {}, a);
  const rb = await post("/admin/drivers/list", {}, b);
  check("cerrar en todos cierra todas", all.status === 200 && all.data.closed >= 2 && ra.status === 401 && rb.status === 401, all.data);

  // El PIN sigue sirviendo (apps viejas en caché)
  const viejo = await post("/admin/drivers/list", { adminPin: ADMIN });
  check("el PIN sigue funcionando para apps viejas", viejo.status === 200, viejo.status);

  // Movimientos
  const t3 = (await post("/admin/login", { adminPin: ADMIN })).data.token;
  const stamp = String(Date.now()).slice(-6);
  const alta = await post("/admin/drivers", { name: `Audit ${stamp}`, phone: `94100${stamp}`.slice(0, 10), acceptedLegal: true, vehicleType: "moto", photo: "data:image/png;base64,iVBORw0KGgo=" }, t3);
  await post("/admin/drivers/" + alta.data.id + "/reset-pin", {}, t3);
  await post("/admin/login", { adminPin: "000000-malo" });
  await new Promise((r) => setTimeout(r, 300));
  const aud = await post("/admin/audit/list", {}, t3);
  const acts = aud.data.map((x) => x.action);
  check("movimientos: alta de chofer anotada", acts.includes("/admin/drivers"), acts.slice(0, 8));
  check("movimientos: cambio de PIN anotado con el chofer", aud.data.some((x) => x.action === "/admin/drivers/:id/reset-pin" && x.target_id === alta.data.id), aud.data.slice(0, 3));
  check("movimientos: entrada anotada", acts.includes("/admin/login"), acts.slice(0, 8));
  check("movimientos: PIN equivocado anotado", aud.data.some((x) => x.action === "login_fallido" && x.ok === 0), acts.slice(0, 8));
  check("movimientos: las listas no se anotan", !acts.includes("/admin/drivers/list"));
  const altaRow = aud.data.find((x) => x.action === "/admin/drivers");
  check("movimientos: nunca guarda PIN ni fotos", altaRow && !/adminPin|data:image|photo/i.test(altaRow.detail || "") && /Audit/.test(altaRow.detail || ""), altaRow);

  await db.close();
  console.log(`\n${fail ? "✗" : "✓"} ${pass} bien, ${fail} mal`);
  process.exit(fail ? 1 : 0);
}
main().catch(async (e) => { console.error("✗ La prueba se cayó:", e); try { await db.close(); } catch {} process.exit(1); });
