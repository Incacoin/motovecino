// Prueba de las entregas del padrón (26-nov-2026): casillas «QR», «Tríptico» y
// «Grupo WhatsApp» por chofer (POST /admin/drivers/:id/entrega). Guardan la
// fecha, se quitan, solo el admin de ese municipio las toca y quedan en
// Movimientos. Los choferes no las ven.
//   BASE=http://localhost:3077 node tools/test-entregas.js
const path = require("node:path");
process.loadEnvFile(path.join(__dirname, "..", ".env"));
const BASE = process.env.BASE || "http://localhost:3077";
if (!/^https?:\/\/(localhost|127\.0\.0\.1)[:/]/.test(BASE)) throw new Error("Esto solo se corre en localhost: " + BASE);
const ADMIN = process.env.ADMIN_PIN;
const db = require("../db");

let pass = 0;
let fail = 0;
function check(label, cond, extra) {
  if (cond) pass++;
  else {
    fail++;
    console.log("✗", label, extra !== undefined ? JSON.stringify(extra).slice(0, 300) : "");
  }
}
async function post(url, body) {
  // IP propia: no gasta los límites que comparten las demás pruebas.
  const res = await fetch(BASE + "/api" + url, { method: "POST", headers: { "Content-Type": "application/json", "X-Forwarded-For": "10.77.0.26" }, body: JSON.stringify(body) });
  let data = null;
  try { data = await res.json(); } catch {}
  return { status: res.status, data };
}
const stamp = String(Date.now()).slice(-6);
const TI = { adminPin: ADMIN, adminZone: "ticul" };
const creados = [];

async function main() {
  const alta = await post("/admin/drivers", { ...TI, name: `Entrega ${stamp}`, phone: `9781${stamp}`.slice(0, 10), acceptedLegal: true, vehicleType: "moto", grupo: "Por su cuenta" });
  check("admin: alta del chofer de prueba", alta.status === 201, alta);
  const id = alta.data?.id;
  if (!id) return;
  creados.push(id);
  const entrega = (body, zona = TI) => post(`/admin/drivers/${id}/entrega`, { ...zona, ...body });
  const enLista = async () => ((await post("/admin/drivers/list", TI)).data || []).find((d) => d.id === id);

  let d = await enLista();
  check("nuevo: sin entregas", d && d.qr_entregado_at === null && d.triptico_entregado_at === null && d.grupo_wa_at === null, d);

  const qr = await entrega({ que: "qr", hecho: true });
  check("marcar QR → guarda la fecha", qr.status === 200 && qr.data?.ok && typeof qr.data?.at === "string" && qr.data.at.length >= 10, qr);
  await entrega({ que: "triptico", hecho: true });
  await entrega({ que: "grupo", hecho: true });
  d = await enLista();
  check("la lista del admin trae las tres fechas", d && d.qr_entregado_at && d.triptico_entregado_at && d.grupo_wa_at, d);

  const quitar = await entrega({ que: "triptico", hecho: false });
  check("quitar la palomita del tríptico", quitar.status === 200 && quitar.data?.at === null, quitar);
  d = await enLista();
  check("solo se quitó el tríptico", d && d.qr_entregado_at && !d.triptico_entregado_at && d.grupo_wa_at, d);

  check("algo que no es QR/tríptico/grupo → 400", (await entrega({ que: "pin", hecho: true })).status === 400);
  check("«que» con nombre de columna → 400", (await entrega({ que: "qr_entregado_at", hecho: true })).status === 400);
  check("sin decir sí o no → 400", (await entrega({ que: "qr" })).status === 400);
  check("«hecho» como texto → 400", (await entrega({ que: "qr", hecho: "true" })).status === 400);

  const tekax = await entrega({ que: "grupo", hecho: false }, { adminPin: ADMIN, adminZone: "tekax" });
  check("admin de otro municipio no puede", tekax.status === 403 || tekax.status === 404, tekax);
  check("y no cambió nada", !!(await enLista())?.grupo_wa_at);
  check("sin PIN no se puede", (await post(`/admin/drivers/${id}/entrega`, { que: "qr", hecho: false })).status === 401);

  const mov = await db.prepare("SELECT COUNT(*) AS n FROM admin_audit WHERE action = '/admin/drivers/:id/entrega' AND target_id = ?").get(id);
  check("queda en Movimientos (4 cambios buenos)", Number(mov?.n) === 4, mov);

  // El chofer no ve sus casillas en su perfil.
  const cred = await db.prepare("SELECT phone, pin FROM drivers WHERE id = ?").get(id);
  const perfil = (await post("/drivers/profile", cred)).data || {};
  check("el perfil del chofer no trae las entregas", !JSON.stringify(perfil).match(/entregado|grupo_wa/), Object.keys(perfil));

  await db.prepare("UPDATE drivers SET deleted_at = datetime('now') WHERE id = ?").run(id);
  check("chofer borrado → 404", (await entrega({ que: "qr", hecho: true })).status === 404);

  console.log(fail ? `NO: ${fail} fallaron, ${pass} bien` : `Todo bien (${pass})`);
}

main()
  .catch((e) => { console.error(e); fail++; })
  .finally(async () => {
    try {
      for (const did of creados) {
        await db.prepare("UPDATE drivers SET deleted_at = datetime('now') WHERE id = ?").run(did);
        await db.prepare("DELETE FROM admin_audit WHERE target_id = ? AND action LIKE '/admin/drivers%'").run(did);
      }
    } catch (e) { console.error("limpieza:", e.message); }
    await db.close?.();
    process.exit(fail ? 1 : 0);
  });
