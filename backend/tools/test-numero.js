// Prueba del número del mototaxi (23-nov-2026): en Ticul cada agrupación
// numera sus unidades (ej. Alcones 1-100, Jaguar 101-200). El registro lo pide
// (obligatorio donde hay agrupaciones, opcional en los demás), el admin lo
// conserva al aprobar y al editar, avisa si se repite en la misma agrupación,
// y el pasajero lo ve.
//   BASE=http://localhost:3077 node tools/test-numero.js
const path = require("node:path");
process.loadEnvFile(path.join(__dirname, "..", ".env"));
const BASE = process.env.BASE || "http://localhost:3077";
if (!/^https?:\/\/(localhost|127\.0\.0\.1)[:/]/.test(BASE)) throw new Error("Esto solo se corre en localhost: " + BASE);
const ADMIN = process.env.ADMIN_PIN;
const db = require("../db");
const TI = { lat: 20.39528, lng: -89.53389 }; // centro de Ticul
const TK = { lat: 20.2071, lng: -89.2809 }; // centro de Tekax

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
  // IP propia: no gasta el límite de registros por hora de las demás pruebas.
  const res = await fetch(BASE + "/api" + url, { method, headers: { "Content-Type": "application/json", "X-Forwarded-For": "10.77.0.2" }, body: body ? JSON.stringify(body) : undefined });
  let data = null;
  try { data = await res.json(); } catch {}
  return { status: res.status, data };
}
const post = (u, b) => api("POST", u, b);
const stamp = String(Date.now()).slice(-6);
const tel = (p) => `${p}${stamp}`.slice(0, 10);
const PNG = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";
const JPG = "data:image/jpeg;base64,/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/wAALCAABAAEBAREA/8QAFAABAAAAAAAAAAAAAAAAAAAACf/EABQQAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQEAAD8AKp//2Q==";

async function main() {
  const base = {
    name: `Chofer Número ${stamp}`, phone: tel("97100"), photo: JPG, photoPlaca: JPG, signature: PNG,
    acceptedLegal: true, vehicleType: "moto", city: "ticul", lat: TI.lat, lng: TI.lng,
    emergencyContactName: "Mamá", emergencyContactPhone: "9990000000", vehicleColor: "Rojo", grupo: "Alcones Alfa",
  };

  // Registro (Ticul): obligatorio y solo números.
  const sin = await post("/chofer-solicitudes", { ...base, numeroUnidad: "" });
  check("Ticul: sin número no se puede registrar", sin.status === 400 && /número/i.test(sin.data?.error || ""), sin);
  const letras = await post("/chofer-solicitudes", { ...base, numeroUnidad: "4A" });
  check("Ticul: con letras no", letras.status === 400, letras);
  const largo = await post("/chofer-solicitudes", { ...base, numeroUnidad: "12345" });
  check("Ticul: más de 4 cifras no", largo.status === 400, largo);
  const cero = await post("/chofer-solicitudes", { ...base, numeroUnidad: "0" });
  check("Ticul: el 0 no", cero.status === 400, cero);
  const ok = await post("/chofer-solicitudes", { ...base, numeroUnidad: " 045 " });
  check("Ticul: registro con número 045", ok.status === 201, ok);
  // Formulario abierto antes de esta versión (no manda el campo): se acepta.
  const viejo = await post("/chofer-solicitudes", { ...base, name: `Viejo Num ${stamp}`, phone: tel("97200") });
  check("formulario viejo sin el campo se acepta", viejo.status === 201, viejo);
  // Tekax (sin agrupaciones): opcional.
  const tk = await post("/chofer-solicitudes", { ...base, name: `Tekax Num ${stamp}`, phone: tel("97300"), city: "tekax", lat: TK.lat, lng: TK.lng, grupo: undefined, numeroUnidad: "" });
  check("Tekax: sin número sí se puede registrar", tk.status === 201, tk);

  const apps = await post("/admin/chofer-solicitudes/list", { adminPin: ADMIN, adminZone: "ticul", photoRefs: true });
  const app = (apps.data || []).find((a) => a.phone === base.phone);
  check("el admin ve el número sin ceros a la izquierda", app && app.numero_unidad === "45", app && app.numero_unidad);

  // Alta desde el admin con los datos de la solicitud.
  const alta = await post("/admin/drivers", { adminPin: ADMIN, adminZone: "ticul", name: base.name, phone: base.phone, acceptedLegal: true, vehicleType: "moto", grupo: "Alcones Alfa", vehicleColor: "Rojo", numeroUnidad: app?.numero_unidad, applicationId: app?.id });
  check("admin: alta con número", alta.status === 201 && alta.data?.numero_unidad === "45", alta.data);
  check("admin: primero con ese número, sin aviso", alta.data && !alta.data.numeroRepetido, alta.data);
  const d = alta.data;
  const malo = await post("/admin/drivers", { adminPin: ADMIN, adminZone: "ticul", name: `Malo ${stamp}`, phone: tel("97400"), acceptedLegal: true, vehicleType: "moto", grupo: "Jaguar", numeroUnidad: "x1" });
  check("admin: número con letras no", malo.status === 400, malo);

  // Mismo número en la misma agrupación: se da de alta, pero avisa.
  const rep = await post("/admin/drivers", { adminPin: ADMIN, adminZone: "ticul", name: `Repetido ${stamp}`, phone: tel("97500"), acceptedLegal: true, vehicleType: "moto", grupo: "Alcones Alfa", numeroUnidad: "45" });
  check("admin: número repetido en la misma agrupación avisa", rep.status === 201 && rep.data?.numeroRepetido === base.name, rep.data);
  // Mismo número en otra agrupación: no avisa.
  const otra = await post("/admin/drivers", { adminPin: ADMIN, adminZone: "ticul", name: `Otra Agr ${stamp}`, phone: tel("97600"), acceptedLegal: true, vehicleType: "moto", grupo: "Jaguar", numeroUnidad: "45" });
  check("admin: mismo número en otra agrupación no avisa", otra.status === 201 && !otra.data?.numeroRepetido, otra.data);

  const listaDe = async (id) => ((await post("/admin/drivers/list", { adminPin: ADMIN, adminZone: "ticul", photoRefs: true })).data || []).find((x) => x.id === id);
  check("lista del admin trae el número", (await listaDe(d.id))?.numero_unidad === "45");

  // Editar sin mandar número (ej. corregir el nombre) no lo borra.
  const ed = await post(`/admin/drivers/${d.id}/update`, { adminPin: ADMIN, adminZone: "ticul", name: base.name, phone: base.phone, vehicleType: "moto" });
  check("editar sin número responde bien", ed.status === 200, ed);
  check("editar sin número NO lo borra", (await listaDe(d.id))?.numero_unidad === "45");
  const edRep = await post(`/admin/drivers/${d.id}/update`, { adminPin: ADMIN, adminZone: "ticul", name: base.name, phone: base.phone, vehicleType: "moto", numeroUnidad: "45" });
  check("editar: avisa que otro de Alcones tiene el 45", edRep.data?.numeroRepetido === `Repetido ${stamp}`, edRep.data);
  const edMalo = await post(`/admin/drivers/${d.id}/update`, { adminPin: ADMIN, adminZone: "ticul", name: base.name, phone: base.phone, vehicleType: "moto", numeroUnidad: "abc" });
  check("editar a número con letras no", edMalo.status === 400 && (await listaDe(d.id))?.numero_unidad === "45", edMalo);
  await post(`/admin/drivers/${d.id}/update`, { adminPin: ADMIN, adminZone: "ticul", name: base.name, phone: base.phone, vehicleType: "moto", numeroUnidad: "12" });
  check("editar a 12", (await listaDe(d.id))?.numero_unidad === "12");

  // El pasajero ve el número.
  const R = { rider_phone: tel("97700"), rider_pin: "8" + stamp };
  await db.prepare("INSERT INTO riders (phone, name, pin, city, city_located, created_at) VALUES (?, ?, ?, ?, ?, datetime('now'))")
    .run(R.rider_phone, "Pasajero Número", R.rider_pin, "ticul", 1);
  const r = await post("/rides", { ...R, pickup_lat: TI.lat, pickup_lng: TI.lng, dest_lat: TI.lat + 0.01, dest_lng: TI.lng, ride_type: "moto", offer_price: 20 });
  check("viaje en Ticul", r.status === 201, r);
  const acc = await post(`/rides/${r.data?.id}/accept`, { driverId: d.id, pin: d.pin });
  check("chofer acepta", acc.status === 200, acc);
  const visto = (await api("GET", `/rides/${r.data?.id}?t=${r.data?.share_token}`)).data?.driver;
  check("el pasajero ve el número 12", visto && visto.numero_unidad === "12", visto);
  await post(`/rides/${r.data?.id}/cancel`, { driverId: d.id, pin: d.pin });

  // Quitar el número ("").
  await post(`/admin/drivers/${d.id}/update`, { adminPin: ADMIN, adminZone: "ticul", name: base.name, phone: base.phone, vehicleType: "moto", numeroUnidad: "" });
  check("editar con vacío lo quita", !(await listaDe(d.id))?.numero_unidad);

  // Limpieza: que no queden choferes ni solicitudes de prueba en la copia.
  for (const id of [d.id, rep.data?.id, otra.data?.id].filter(Boolean)) {
    await db.prepare("UPDATE drivers SET deleted_at = datetime('now') WHERE id = ?").run(id);
  }
  await db.prepare("DELETE FROM driver_applications WHERE phone IN (?, ?, ?)").run(tel("97100"), tel("97200"), tel("97300"));

  console.log(fail ? `NO: ${fail} fallaron, ${pass} bien` : `Todo bien (${pass})`);
  await db.close?.();
  process.exit(fail ? 1 : 0);
}
main().catch((e) => { console.error(e); process.exit(1); });
