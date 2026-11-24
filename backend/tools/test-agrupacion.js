// Prueba del orden del padrón (24-nov-2026): «Otra agrupación» pide «¿Cuál?»
// en el registro; la ventanita de la app del chofer (POST /drivers/agrupacion)
// solo sirve mientras le falte la agrupación y deja registro; el admin guarda y
// borra el «¿Cuál?» y ve quién invitó (para «Invitados de…»). En Tekax nada.
//   BASE=http://localhost:3077 node tools/test-agrupacion.js
const path = require("node:path");
process.loadEnvFile(path.join(__dirname, "..", ".env"));
const BASE = process.env.BASE || "http://localhost:3077";
if (!/^https?:\/\/(localhost|127\.0\.0\.1)[:/]/.test(BASE)) throw new Error("Esto solo se corre en localhost: " + BASE);
const ADMIN = process.env.ADMIN_PIN;
const db = require("../db");
const TI = { lat: 20.39528, lng: -89.53389 }; // centro de Ticul

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
  // IP propia: no gasta los límites que comparten las demás pruebas.
  const res = await fetch(BASE + "/api" + url, { method, headers: { "Content-Type": "application/json", "X-Forwarded-For": "10.77.0.24" }, body: body ? JSON.stringify(body) : undefined });
  let data = null;
  try { data = await res.json(); } catch {}
  return { status: res.status, data };
}
const post = (u, b) => api("POST", u, b);
const stamp = String(Date.now()).slice(-6);
const tel = (p) => `${p}${stamp}`.slice(0, 10);
const PNG = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";
const JPG = "data:image/jpeg;base64,/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/wAALCAABAAEBAREA/8QAFAABAAAAAAAAAAAAAAAAAAAACf/EABQQAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQEAAD8AKp//2Q==";
const creados = [];
const telefonos = [];

async function main() {
  // ---- Registro público ----
  const base = {
    photo: JPG, photoPlaca: JPG, signature: PNG, acceptedLegal: true, vehicleType: "moto", city: "ticul", lat: TI.lat, lng: TI.lng,
    emergencyContactName: "Mamá", emergencyContactPhone: "9990000000", vehicleColor: "Rojo", numeroUnidad: "77",
  };
  const r1 = { ...base, name: `Agr Otra ${stamp}`, phone: tel("97100"), grupo: "Por su cuenta", grupoOtro: " " };
  telefonos.push(r1.phone);
  const sinCual = await post("/chofer-solicitudes", r1);
  check("registro: «Otra» sin decir cuál no se puede", sinCual.status === 400 && /cuál/i.test(sinCual.data?.error || ""), sinCual);
  const conCual = await post("/chofer-solicitudes", { ...r1, grupoOtro: "  Los   Halcones " });
  check("registro: «Otra» con «Los Halcones» se acepta", conCual.status === 201, conCual);
  const r2 = { ...base, name: `Agr Vieja ${stamp}`, phone: tel("97200"), grupo: "Por su cuenta" };
  telefonos.push(r2.phone);
  const viejo = await post("/chofer-solicitudes", r2); // formulario de antes: no manda grupoOtro
  check("registro: formulario viejo con «Otra» y sin el campo se acepta", viejo.status === 201, viejo);
  const r3 = { ...base, name: `Agr Jaguar ${stamp}`, phone: tel("97300"), grupo: "Jaguar", grupoOtro: "Los Halcones" };
  telefonos.push(r3.phone);
  const jag = await post("/chofer-solicitudes", r3);
  check("registro: con Jaguar se acepta", jag.status === 201, jag);

  const apps = (await post("/admin/chofer-solicitudes/list", { adminPin: ADMIN, adminZone: "ticul" })).data || [];
  const a1 = apps.find((a) => a.phone === r1.phone);
  const a3 = apps.find((a) => a.phone === r3.phone);
  check("admin ve «Los Halcones» (espacios limpios) en la solicitud", a1 && a1.grupo === "Por su cuenta" && a1.grupo_otro === "Los Halcones", a1);
  check("con Jaguar no se guarda «¿Cuál?»", a3 && a3.grupo === "Jaguar" && !a3.grupo_otro, a3);

  // ---- Alta desde el admin ----
  const inviter = await post("/admin/drivers", { adminPin: ADMIN, adminZone: "ticul", name: `Agr Invitador ${stamp}`, phone: tel("97400"), acceptedLegal: true, vehicleType: "moto", grupo: "Alcones Alfa" });
  check("admin: alta del que invita", inviter.status === 201, inviter);
  creados.push(inviter.data?.id);
  const alta = await post("/admin/drivers", {
    adminPin: ADMIN, adminZone: "ticul", name: a1.name, phone: a1.phone, acceptedLegal: true, vehicleType: "moto",
    grupo: "Por su cuenta", grupoOtro: a1.grupo_otro, referredByDriverId: inviter.data?.id, applicationId: a1.id,
  });
  check("admin: alta con «Otra: Los Halcones»", alta.status === 201 && alta.data?.grupo_otro === "Los Halcones", alta);
  creados.push(alta.data?.id);
  const listaDe = async (id) => ((await post("/admin/drivers/list", { adminPin: ADMIN, adminZone: "ticul", photoRefs: true })).data || []).find((x) => x.id === id);
  const enLista = await listaDe(alta.data?.id);
  check("lista del admin trae «¿Cuál?» y quién lo invitó", enLista && enLista.grupo_otro === "Los Halcones" && enLista.referred_by_driver_id === inviter.data?.id && enLista.inviter_name === inviter.data?.name, enLista);
  const altaJag = await post("/admin/drivers", { adminPin: ADMIN, adminZone: "ticul", name: `Agr AltaJag ${stamp}`, phone: tel("97500"), acceptedLegal: true, vehicleType: "moto", grupo: "Jaguar", grupoOtro: "No va" });
  creados.push(altaJag.data?.id);
  check("admin: con Jaguar el «¿Cuál?» no se guarda", altaJag.status === 201 && !altaJag.data?.grupo_otro, altaJag);

  // ---- Edición desde el admin ----
  const id = alta.data.id;
  const upd = (extra) => post(`/admin/drivers/${id}/update`, { adminPin: ADMIN, adminZone: "ticul", name: a1.name, phone: a1.phone, vehicleType: "moto", ...extra });
  await upd({});
  check("editar sin mandar «¿Cuál?» lo conserva", (await listaDe(id))?.grupo_otro === "Los Halcones");
  await upd({ grupoOtro: "Halcones del Sur" });
  check("editar «¿Cuál?»", (await listaDe(id))?.grupo_otro === "Halcones del Sur");
  await upd({ grupo: "Jaguar", grupoOtro: "Halcones del Sur" });
  const aJag = await listaDe(id);
  check("pasar a Jaguar borra el «¿Cuál?»", aJag?.grupo === "Jaguar" && !aJag?.grupo_otro, aJag);

  // ---- Ventanita en la app del chofer ----
  const choferId = altaJag.data.id;
  const pinDe = async (did) => (await db.prepare("SELECT phone, pin FROM drivers WHERE id = ?").get(did));
  const cred = await pinDe(choferId);
  await db.prepare("UPDATE drivers SET grupo = NULL, grupo_otro = NULL WHERE id = ?").run(choferId); // como los 11 de antes del padrón
  let perfil = (await post("/drivers/profile", cred)).data;
  check("perfil: sin agrupación → falta (sale la ventanita)", perfil?.faltaAgrupacion === true && perfil?.agrupaciones?.length === 2, perfil && { f: perfil.faltaAgrupacion, a: perfil.agrupaciones });
  check("perfil: la lista trae líderes", perfil?.agrupaciones?.some((a) => a.nombre === "Alcones Alfa" && a.lider === "Abraham Zavala"), perfil?.agrupaciones);
  const malPin = await post("/drivers/agrupacion", { phone: cred.phone, pin: "000000", grupo: "Jaguar" });
  check("ventanita: PIN equivocado no", malPin.status === 404, malPin);
  const inventada = await post("/drivers/agrupacion", { ...cred, grupo: "Inventada" });
  check("ventanita: agrupación inventada no", inventada.status === 400, inventada);
  const otraSin = await post("/drivers/agrupacion", { ...cred, grupo: "Por su cuenta", grupoOtro: "x" });
  check("ventanita: «Otra» sin decir cuál no", otraSin.status === 400, otraSin);
  const otraCon = await post("/drivers/agrupacion", { ...cred, grupo: "Por su cuenta", grupoOtro: "Los Pumas" });
  check("ventanita: «Otra: Los Pumas» se guarda", otraCon.status === 200 && otraCon.data?.grupoOtro === "Los Pumas", otraCon);
  perfil = (await post("/drivers/profile", cred)).data;
  check("perfil: ya contestó → no sale más", perfil?.faltaAgrupacion === false && perfil?.agrupaciones === undefined && perfil?.grupoOtro === "Los Pumas", perfil && { f: perfil.faltaAgrupacion, o: perfil.grupoOtro });
  const cambiar = await post("/drivers/agrupacion", { ...cred, grupo: "Jaguar" });
  check("ventanita: ya contestada, el chofer no puede cambiarla", cambiar.status === 409, cambiar);
  check("sigue en «Otra: Los Pumas»", (await listaDe(choferId))?.grupo_otro === "Los Pumas");
  const audit = await db.prepare("SELECT detail FROM admin_audit WHERE action = 'agrupacion_chofer' AND target_id = ? ORDER BY id DESC LIMIT 1").get(choferId);
  check("queda en el registro del admin", audit && /sin agrupación → Otra agrupación \(Los Pumas\)/.test(audit.detail), audit);

  // «Otra» sin cuál (registro viejo) → también le sale, y ya viene marcada «Otra».
  await db.prepare("UPDATE drivers SET grupo = 'Por su cuenta', grupo_otro = NULL WHERE id = ?").run(choferId);
  perfil = (await post("/drivers/profile", cred)).data;
  check("perfil: «Otra» sin cuál → falta", perfil?.faltaAgrupacion === true && perfil?.grupo === "Por su cuenta", perfil && { f: perfil.faltaAgrupacion });
  const aJaguar = await post("/drivers/agrupacion", { ...cred, grupo: "Jaguar", grupoOtro: "ignorado" });
  check("ventanita: elige Jaguar", aJaguar.status === 200);
  const fin = await listaDe(choferId);
  check("queda Jaguar sin «¿Cuál?»", fin?.grupo === "Jaguar" && !fin?.grupo_otro, fin);

  // Agrupación vieja que ya no está en la lista → también se le pregunta.
  await db.prepare("UPDATE drivers SET grupo = 'Gremio viejo' WHERE id = ?").run(choferId);
  check("perfil: agrupación vieja → falta", (await post("/drivers/profile", cred)).data?.faltaAgrupacion === true);
  await db.prepare("UPDATE drivers SET grupo = 'Jaguar' WHERE id = ?").run(choferId);

  // ---- Tekax: no hay agrupaciones, nunca sale ----
  const tk = await db.prepare("SELECT id, phone, pin FROM drivers WHERE city = 'tekax' AND deleted_at IS NULL AND (grupo IS NULL OR grupo = '') LIMIT 1").get();
  if (tk) {
    const p = (await post("/drivers/profile", { phone: tk.phone, pin: tk.pin })).data;
    check("Tekax: no sale la ventanita", p?.faltaAgrupacion === false, p && p.faltaAgrupacion);
    const t = await post("/drivers/agrupacion", { phone: tk.phone, pin: tk.pin, grupo: "Jaguar" });
    check("Tekax: no se puede poner agrupación", t.status === 409, t);
  } else check("hay un chofer de Tekax en la base de prueba (seed)", false);

  console.log(fail ? `NO: ${fail} fallaron, ${pass} bien` : `Todo bien (${pass})`);
}

main()
  .catch((e) => { console.error(e); fail++; })
  .finally(async () => {
    // Limpia lo que crea.
    try {
      for (const did of creados.filter(Boolean)) await db.prepare("UPDATE drivers SET deleted_at = datetime('now') WHERE id = ?").run(did);
      for (const ph of telefonos) await db.prepare("DELETE FROM driver_applications WHERE phone = ?").run(ph);
    } catch (e) { console.error("limpieza:", e.message); }
    await db.close?.();
    process.exit(fail ? 1 : 0);
  });
