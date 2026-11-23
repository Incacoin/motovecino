// Prueba de "¿Quién lo invitó?" al editar un chofer (23-nov-2026): el admin lo
// corrige después de aprobar (ej. los que trajo Gabriel sin link) y eso arma el
// padrón interno por secciones. Solo se toca si viene; "" lo quita; el link de
// invitación (referred_by_driver_id) no se toca.
//   BASE=http://localhost:3077 node tools/test-invito.js
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
  const res = await fetch(BASE + "/api" + url, { method: "POST", headers: { "Content-Type": "application/json", "X-Forwarded-For": "10.77.0.3" }, body: JSON.stringify(body) });
  let data = null;
  try { data = await res.json(); } catch {}
  return { status: res.status, data };
}
const stamp = String(Date.now()).slice(-6);
const tel = (p) => `${p}${stamp}`; // prefijo de 4 + stamp de 6 = 10
const A = { adminPin: ADMIN, adminZone: "ticul" };

async function main() {
  const ids = [];
  try {
    const inv = await post("/admin/drivers", { ...A, name: `Invitador ${stamp}`, phone: tel("9510"), acceptedLegal: true, vehicleType: "moto", grupo: "Alcones Alfa" });
    check("alta del que invita", inv.status === 201 || inv.status === 200, inv);
    ids.push(inv.data?.id);
    const d = await post("/admin/drivers", { ...A, name: `Invitado ${stamp}`, phone: tel("9520"), acceptedLegal: true, vehicleType: "moto", grupo: "Por su cuenta", referredByDriverId: inv.data?.id });
    check("alta del invitado", d.status === 201 || d.status === 200, d);
    ids.push(d.data?.id);
    const id = d.data?.id;
    // La lista del admin sí manda el link (referredByDriverId solo aplica con solicitud; se fija a mano).
    await db.prepare("UPDATE drivers SET referred_by_driver_id = ? WHERE id = ?").run(inv.data?.id, id);
    const base = { ...A, name: `Invitado ${stamp}`, phone: tel("9520"), vehicleType: "moto" };
    const lista = async () => ((await post("/admin/drivers/list", { ...A, photoRefs: true })).data || []).find((x) => x.id === id);

    const r1 = await post(`/admin/drivers/${id}/update`, { ...base, referredBy: "  Gabriel  " });
    check("guardar «Gabriel»", r1.status === 200, r1);
    let x = await lista();
    check("se guarda sin espacios", x?.referred_by === "Gabriel", x?.referred_by);
    check("el link de invitación no se toca", x?.inviter_name === `Invitador ${stamp}`, x?.inviter_name);

    await post(`/admin/drivers/${id}/update`, { ...base });
    x = await lista();
    check("si no viene, se queda igual", x?.referred_by === "Gabriel", x?.referred_by);

    const largo = await post(`/admin/drivers/${id}/update`, { ...base, referredBy: "x".repeat(200) });
    x = await lista();
    check("texto largo se corta a 80 (igual que el registro)", largo.status === 200 && x?.referred_by?.length === 80, x?.referred_by?.length);
    // Texto viejo de más de 80 (de antes): editar otra cosa mandándolo igual no lo recorta.
    const viejo = "y".repeat(90);
    await db.prepare("UPDATE drivers SET referred_by = ? WHERE id = ?").run(viejo, id);
    await post(`/admin/drivers/${id}/update`, { ...base, referredBy: viejo });
    x = await lista();
    check("si no cambió, no se recorta", x?.referred_by === viejo, x?.referred_by?.length);

    const malo = await post(`/admin/drivers/${id}/update`, { ...base, referredBy: { a: 1 } });
    check("si no es texto, error 400", malo.status === 400, malo);

    await post(`/admin/drivers/${id}/update`, { ...base, referredBy: "" });
    x = await lista();
    check("vacío lo quita", x?.referred_by == null, x?.referred_by);

    // Otro municipio no puede tocarlo.
    const ajeno = await post(`/admin/drivers/${id}/update`, { ...base, adminZone: "tekax", referredBy: "Hack" });
    check("admin de otro municipio no lo cambia", ajeno.status === 403 || ajeno.status === 404, ajeno);
    x = await lista();
    check("sigue sin «Hack»", x?.referred_by == null, x?.referred_by);
  } finally {
    // Por la ruta real: así también se recalculan los fundadores.
    for (const id of ids.filter(Boolean)) await post(`/admin/drivers/${id}/delete`, A);
  }
  console.log(`invito: ${pass} bien, ${fail} mal`);
  process.exit(fail ? 1 : 0);
}
main().catch((e) => { console.error(e); process.exit(1); });
