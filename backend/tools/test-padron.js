// Prueba del padrón por agrupación (18-nov-2026): en Ticul el registro de
// chofer obliga a elegir Jaguar / Alcones Alfa / "Por su cuenta"; el admin la
// conserva al aprobar y al editar (antes editar la borraba); el pasajero nunca
// ve "Por su cuenta"; en Tekax no se pregunta nada. Color del vehículo:
// obligatorio en el registro, se conserva al editar y el pasajero lo ve.
//   BASE=http://localhost:3077 node tools/test-padron.js
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
  // IP propia (localhost es proxy de confianza): así esta prueba no gasta el
  // límite de 20 registros por hora que comparten las demás de npm test.
  const res = await fetch(BASE + "/api" + url, { method, headers: { "Content-Type": "application/json", "X-Forwarded-For": "10.77.0.1" }, body: body ? JSON.stringify(body) : undefined });
  let data = null;
  try { data = await res.json(); } catch {}
  return { status: res.status, data };
}
const post = (u, b) => api("POST", u, b);
const stamp = String(Date.now()).slice(-6);
const PNG = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";
const JPG = "data:image/jpeg;base64,/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/wAALCAABAAEBAREA/8QAFAABAAAAAAAAAAAAAAAAAAAACf/EABQQAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQEAAD8AKp//2Q==";

async function main() {
  const list = await api("GET", "/agrupaciones?city=ticul");
  const nombres = (list.data?.agrupaciones || []).map((a) => `${a.nombre}|${a.lider}`);
  check("Ticul: Jaguar con Saúl Segura y Alcones Alfa con Abraham Zavaleta",
    nombres.includes("Jaguar|Saúl Segura") && nombres.includes("Alcones Alfa|Abraham Zavaleta"), list.data);
  check("opción Por su cuenta", list.data?.porSuCuenta === "Por su cuenta", list.data);
  const tk = await api("GET", "/agrupaciones?city=tekax");
  check("Tekax: sin agrupaciones", Array.isArray(tk.data?.agrupaciones) && tk.data.agrupaciones.length === 0, tk.data);

  const base = {
    name: `Chofer Padrón ${stamp}`, phone: `98100${stamp}`.slice(0, 10), photo: JPG, photoPlaca: JPG, signature: PNG,
    acceptedLegal: true, vehicleType: "moto", city: "ticul", lat: TI.lat, lng: TI.lng,
    emergencyContactName: "Mamá", emergencyContactPhone: "9990000000", vehicleColor: "Rojo",
  };
  const colores = await api("GET", "/colores-vehiculo");
  check("lista de colores con Rojo y Otro", (colores.data?.colores || []).some((c) => c.nombre === "Rojo") && colores.data.colores.some((c) => c.nombre === "Otro"), colores.data);
  const sinColor = await post("/chofer-solicitudes", { ...base, grupo: "Jaguar", vehicleColor: "" });
  check("sin color no se puede registrar", sinColor.status === 400 && /color/i.test(sinColor.data?.error || ""), sinColor);
  const colorMalo = await post("/chofer-solicitudes", { ...base, grupo: "Jaguar", vehicleColor: "Fosforescente" });
  check("color inventado no", colorMalo.status === 400, colorMalo);
  const sin = await post("/chofer-solicitudes", { ...base, grupo: "" });
  check("Ticul: sin agrupación no se puede registrar", sin.status === 400 && /agrupaci/i.test(sin.data?.error || ""), sin);
  const mala = await post("/chofer-solicitudes", { ...base, grupo: "Inventada" });
  check("Ticul: agrupación inventada no", mala.status === 400, mala);
  const ok = await post("/chofer-solicitudes", { ...base, grupo: "Jaguar" });
  check("Ticul: registro con Jaguar", ok.status === 201, ok);
  // Formulario abierto antes de esta versión (no manda color ni agrupación):
  // se acepta y queda "Sin elegir", para no tirarle lo que ya llenó.
  const viejo = { ...base, name: `Viejo ${stamp}`, phone: `98400${stamp}`.slice(0, 10) };
  delete viejo.vehicleColor;
  const okViejo = await post("/chofer-solicitudes", viejo);
  check("formulario viejo sin color ni agrupación se acepta", okViejo.status === 201, okViejo);
  // Teléfono con texto colado: se guarda solo con números (antes se guardaba tal cual y se pintaba en el admin).
  const sucio = { ...base, grupo: "Jaguar", name: `Sucio ${stamp}`, phone: `98500${stamp}`.slice(0, 10) + "<img src=x onerror=alert()>" };
  const okSucio = await post("/chofer-solicitudes", sucio);
  check("teléfono con texto extra se acepta limpio", okSucio.status === 201, okSucio);
  const emergMala = await post("/chofer-solicitudes", { ...base, grupo: "Jaguar", name: `Emerg ${stamp}`, phone: `98600${stamp}`.slice(0, 10), emergencyContactPhone: "999<b>" });
  check("teléfono de emergencia que no son 10 números no", emergMala.status === 400, emergMala);

  const apps = await post("/admin/chofer-solicitudes/list", { adminPin: ADMIN, adminZone: "ticul" });
  const app = (apps.data || []).find((a) => a.phone === base.phone);
  check("el admin ve la solicitud con su agrupación", app && app.grupo === "Jaguar", app);
  check("el admin ve el color de la solicitud", app && app.vehicle_color === "Rojo", app);
  const appSucio = (apps.data || []).find((a) => a.name === `Sucio ${stamp}`);
  check("se guardó solo el número", appSucio && /^\d{10}$/.test(appSucio.phone), appSucio && appSucio.phone);
  // Al aprobar, se guarda la versión del aviso que aceptó en su solicitud.
  await db.prepare("UPDATE driver_applications SET accepted_legal_version = ? WHERE id = ?").run("2026-09-23", app.id);

  // Alta desde el admin (como "Usar datos"): la agrupación se guarda.
  const malaAlta = await post("/admin/drivers", { adminPin: ADMIN, adminZone: "ticul", name: `Otro ${stamp}`, phone: `98300${stamp}`.slice(0, 10), acceptedLegal: true, vehicleType: "moto", grupo: "Inventada" });
  check("admin: agrupación inventada no", malaAlta.status === 400, malaAlta);
  const alta = await post("/admin/drivers", { adminPin: ADMIN, adminZone: "ticul", name: base.name, phone: base.phone, acceptedLegal: true, vehicleType: "moto", grupo: "Jaguar", vehicleColor: "Rojo", applicationId: app.id });
  check("admin: alta en Ticul", alta.status === 201 || alta.status === 200, alta);
  const d = alta.data;
  const listaDe = async () => ((await post("/admin/drivers/list", { adminPin: ADMIN, adminZone: "ticul", photoRefs: true })).data || []).find((x) => x.id === d.id);
  check("admin: queda en Jaguar", (await listaDe())?.grupo === "Jaguar");
  check("admin: queda en Rojo", (await listaDe())?.vehicle_color === "Rojo");
  const ver = await db.prepare("SELECT accepted_legal_version FROM drivers WHERE id = ?").get(d.id);
  check("guarda la versión del aviso de su solicitud", ver?.accepted_legal_version === "2026-09-23", ver);

  // Editar sin mandar grupo (ej. corregir el nombre) ya no la borra.
  const ed = await post(`/admin/drivers/${d.id}/update`, { adminPin: ADMIN, adminZone: "ticul", name: base.name + " B", phone: base.phone, vehicleType: "moto" });
  check("editar sin grupo responde bien", ed.status === 200, ed);
  check("editar sin grupo NO la borra", (await listaDe())?.grupo === "Jaguar");
  check("editar sin color NO lo borra", (await listaDe())?.vehicle_color === "Rojo");
  await post(`/admin/drivers/${d.id}/update`, { adminPin: ADMIN, adminZone: "ticul", name: base.name + " B", phone: base.phone, vehicleType: "moto", grupo: "Por su cuenta" });
  check("editar a Por su cuenta", (await listaDe())?.grupo === "Por su cuenta");
  // Agrupación vieja (texto libre de antes): editar el nombre sin tocarla no falla.
  await db.prepare("UPDATE drivers SET grupo = ? WHERE id = ?").run("Gremio viejo", d.id);
  const edViejo = await post(`/admin/drivers/${d.id}/update`, { adminPin: ADMIN, adminZone: "ticul", name: base.name + " C", phone: base.phone, vehicleType: "moto", grupo: "Gremio viejo", vehicleColor: "Rojo" });
  check("editar con agrupación vieja sin cambiarla funciona", edViejo.status === 200 && (await listaDe())?.grupo === "Gremio viejo", edViejo);
  await db.prepare("UPDATE drivers SET grupo = ? WHERE id = ?").run("Por su cuenta", d.id);
  const edMala = await post(`/admin/drivers/${d.id}/update`, { adminPin: ADMIN, adminZone: "ticul", name: base.name + " C", phone: base.phone, vehicleType: "moto", grupo: "Inventada" });
  check("editar a una inventada no", edMala.status === 400 && (await listaDe())?.grupo === "Por su cuenta", edMala);

  // El pasajero no ve "Por su cuenta".
  // El pasajero se crea directo en la base de prueba: el registro público
  // cuenta para el límite de 20 por hora y npm test ya lo usa casi completo.
  const R = { rider_phone: `98200${stamp}`.slice(0, 10), rider_pin: "7" + stamp };
  await db.prepare("INSERT INTO riders (phone, name, pin, city, city_located, created_at) VALUES (?, ?, ?, ?, ?, datetime('now'))")
    .run(R.rider_phone, "Pasajero Padrón", R.rider_pin, "ticul", 1);
  const r = await post("/rides", { ...R, pickup_lat: TI.lat, pickup_lng: TI.lng, dest_lat: TI.lat + 0.01, dest_lng: TI.lng, ride_type: "moto", offer_price: 20 });
  check("viaje en Ticul", r.status === 201, r);
  const acc = await post(`/rides/${r.data.id}/accept`, { driverId: d.id, pin: d.pin });
  check("chofer acepta", acc.status === 200, acc);
  const visto = await api("GET", `/rides/${r.data.id}?t=${r.data.share_token}`);
  const drv = visto.data?.driver;
  check("el pasajero ve al chofer", !!drv, visto);
  check("el pasajero NO ve 'Por su cuenta'", drv && !drv.grupo, drv);
  check("el pasajero ve el color Rojo", drv && drv.vehicle_color === "Rojo" && /^#[0-9a-f]{6}$/i.test(drv.vehicle_color_hex || ""), drv);
  await post(`/rides/${r.data.id}/cancel`, { driverId: d.id, pin: d.pin });

  // El login del admin trae las agrupaciones para el selector y el padrón.
  const login = await post("/admin/login", { adminPin: ADMIN, adminZone: "ticul" });
  // "Otro" no le dice nada al pasajero: no se le manda.
  await post(`/admin/drivers/${d.id}/update`, { adminPin: ADMIN, adminZone: "ticul", name: base.name + " B", phone: base.phone, vehicleType: "moto", vehicleColor: "Otro" });
  check("editar a Otro color", (await listaDe())?.vehicle_color === "Otro");
  const r2 = await post("/rides", { ...R, pickup_lat: TI.lat, pickup_lng: TI.lng, dest_lat: TI.lat + 0.01, dest_lng: TI.lng, ride_type: "moto", offer_price: 20 });
  await post(`/rides/${r2.data.id}/accept`, { driverId: d.id, pin: d.pin });
  const visto2 = (await api("GET", `/rides/${r2.data.id}?t=${r2.data.share_token}`)).data?.driver;
  check("con 'Otro' el pasajero no ve color", visto2 && !visto2.vehicle_color, visto2);
  await post(`/rides/${r2.data.id}/cancel`, { driverId: d.id, pin: d.pin });
  const edColorMalo = await post(`/admin/drivers/${d.id}/update`, { adminPin: ADMIN, adminZone: "ticul", name: base.name + " B", phone: base.phone, vehicleType: "moto", vehicleColor: "Fosforescente" });
  check("editar a color inventado no", edColorMalo.status === 400, edColorMalo);

  check("login del admin trae agrupaciones", login.data?.agrupaciones?.ticul?.length === 2 && login.data?.porSuCuenta === "Por su cuenta" && login.data?.coloresVehiculo?.length > 5, login.data);

  console.log(fail ? `NO: ${fail} fallaron, ${pass} bien` : `Todo bien (${pass})`);
  await db.close?.();
  process.exit(fail ? 1 : 0);
}
main().catch((e) => { console.error(e); process.exit(1); });
