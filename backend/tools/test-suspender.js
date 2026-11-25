// Suspender chofer (26-nov-2026, ver driverSuspend.js): suspendido no se pone
// disponible, no le llegan solicitudes, no acepta viajes ni agendados, no
// cuenta como chofer; «Reactivar» lo deja como antes sin perder nada.
//   BASE=http://localhost:3077 node tools/test-suspender.js
const path = require("node:path");
const fs = require("node:fs");
const WebSocket = require("ws");
const envFile = path.join(__dirname, "..", ".env");
if (fs.existsSync(envFile)) process.loadEnvFile(envFile);
const BASE = process.env.BASE || "http://localhost:3077";
if (!/^https?:\/\/(localhost|127\.0\.0\.1)[:/]/.test(BASE)) throw new Error("Esto solo se corre en localhost: " + BASE);
const ADMIN = process.env.ADMIN_PIN;
const db = require("../db");

const TEKAX = { lat: 20.2071, lng: -89.2809 };
const PNG = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

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
  const res = await fetch(BASE + "/api" + url, { method: "POST", headers: { "Content-Type": "application/json", "X-Forwarded-For": "10.77.0.33" }, body: JSON.stringify(body || {}) });
  let data = null;
  try { data = await res.json(); } catch {}
  return { status: res.status, data };
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function driverSocket(driverId, pin) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`${BASE.replace("http", "ws")}/ws?role=driver&driverId=${driverId}&pin=${pin}`);
    ws.msgs = [];
    ws.on("message", (raw) => ws.msgs.push(JSON.parse(raw.toString())));
    ws.on("open", () => resolve(ws));
    ws.on("error", reject);
  });
}
async function waitFor(ws, type, ms = 3000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    const m = ws.msgs.find((x) => x.type === type);
    if (m) return m;
    await sleep(50);
  }
  return null;
}
const stamp = String(Date.now()).slice(-6);
const creados = { riders: [], drivers: [] };
const status = async (id) => (await db.prepare("SELECT status FROM drivers WHERE id = ?").get(id))?.status;

async function main() {
  const mk = await post("/admin/drivers", { adminPin: ADMIN, name: `Chofer Suspender ${stamp}`, phone: `99788${stamp}`.slice(0, 10), vehicle: "Prueba", acceptedLegal: true, vehicleType: "moto", photo: PNG });
  check("alta chofer", mk.status === 201, mk);
  const d = mk.data;
  creados.drivers.push(d.id);
  const D = { driverId: d.id, pin: d.pin };
  const reg = await post("/riders/register", { name: "Pasajera Suspender", phone: `96900${stamp}`.slice(0, 10), lat: TEKAX.lat, lng: TEKAX.lng });
  creados.riders.push(reg.data?.id);
  const R = { rider_phone: reg.data?.phone, rider_pin: reg.data?.pin };
  const pedir = () => post("/rides", { ...R, pickup_lat: TEKAX.lat, pickup_lng: TEKAX.lng, dest_lat: TEKAX.lat + 0.01, dest_lng: TEKAX.lng, ride_type: "moto", offer_price: 30 });

  // --- Validaciones de la ruta ---
  check("sin decir sí/no = 400", (await post(`/admin/drivers/${d.id}/suspend`, { adminPin: ADMIN })).status === 400);
  check("sin motivo = 400", (await post(`/admin/drivers/${d.id}/suspend`, { adminPin: ADMIN, suspend: true })).status === 400);
  check("motivo inventado = 400", (await post(`/admin/drivers/${d.id}/suspend`, { adminPin: ADMIN, suspend: true, reason: "porque si" })).status === 400);
  const sinPin = await post(`/admin/drivers/${d.id}/suspend`, { adminPin: "malo", suspend: true, reason: "documentos" });
  check("sin PIN de admin no se puede", sinPin.status === 401 || sinPin.status === 403, sinPin);

  // --- Conectado y disponible; lo suspenden ---
  const ws = await driverSocket(d.id, d.pin);
  ws.send(JSON.stringify({ type: "location", lat: TEKAX.lat + 0.001, lng: TEKAX.lng }));
  ws.send(JSON.stringify({ type: "status", status: "disponible" }));
  await sleep(500);
  check("antes: disponible", (await status(d.id)) === "disponible");
  // Antes de suspenderlo: propone precio en un viaje y confirma un agendado
  const r0 = await pedir();
  const of0 = await post(`/rides/${r0.data?.id}/offer`, { ...D, price: 40 });
  check("antes: propone precio", of0.status === 201, of0);
  const bk0 = await post("/bookings", { riderPhone: R.rider_phone, riderPin: R.rider_pin, scheduled_at_ms: Date.now() + 5 * 3600e3, pickup_lat: TEKAX.lat, pickup_lng: TEKAX.lng, dest_lat: TEKAX.lat + 0.01, dest_lng: TEKAX.lng, offer_price: 30 });
  check("pasajero agenda", bk0.status === 201, bk0);
  const tk0 = await post(`/bookings/${bk0.data?.id}/take`, D);
  check("antes: confirma el agendado", tk0.status === 200, tk0);

  const s = await post(`/admin/drivers/${d.id}/suspend`, { adminPin: ADMIN, suspend: true, reason: "documentos", note: "  falta   INE  " });
  check("suspender ok", s.status === 200, s);
  const acOf = await post(`/rides/${r0.data?.id}/offers/${of0.data?.offerId}/accept`, { riderPhone: R.rider_phone, riderPin: R.rider_pin });
  check("su propuesta de antes ya no se puede aceptar", acOf.status === 409, acOf);
  await post(`/rides/${r0.data?.id}/cancel`, { riderPhone: R.rider_phone, riderPin: R.rider_pin });
  const bkAhora = await db.prepare("SELECT status, driver_id FROM ride_bookings WHERE id = ?").get(bk0.data?.id);
  check("su agendado confirmado vuelve a quedar libre", bkAhora?.status === "agendado" && bkAhora?.driver_id == null, bkAhora);
  await post(`/bookings/${bk0.data?.id}/cancel`, { riderPhone: R.rider_phone, riderPin: R.rider_pin });
  const aviso = await waitFor(ws, "suspended");
  check("su app recibe el aviso con el motivo", aviso?.payload?.reason === "Faltan documentos" && aviso?.payload?.note === "falta INE", aviso);
  check("queda desconectado", (await status(d.id)) === "offline");

  // Intenta ponerse disponible otra vez
  ws.msgs = [];
  ws.send(JSON.stringify({ type: "status", status: "disponible" }));
  await sleep(500);
  check("suspendido no se pone disponible", (await status(d.id)) === "offline");
  check("y le repite el aviso", !!(await waitFor(ws, "suspended")));

  // Un viaje cerca no le llega y no lo puede aceptar
  ws.msgs = [];
  const r1 = await pedir();
  check("pasajero pide", r1.status === 201, r1);
  await sleep(800);
  check("no le llega la solicitud", !ws.msgs.some((m) => m.type === "new_ride"));
  const acc = await post(`/rides/${r1.data?.id}/accept`, D);
  check("suspendido no acepta viaje (403)", acc.status === 403 && acc.data?.suspended === true, acc);
  const off = await post(`/rides/${r1.data?.id}/offer`, { ...D, price: 40 });
  check("suspendido no propone precio (403)", off.status === 403, off);
  const bk = await post("/bookings/999999/take", D);
  check("suspendido no toma agendados (403)", bk.status === 403, bk);
  await post(`/rides/${r1.data?.id}/cancel`, { riderPhone: R.rider_phone, riderPin: R.rider_pin });

  // Al reconectar su app, se le avisa de nuevo
  ws.close();
  await sleep(300);
  const ws2 = await driverSocket(d.id, d.pin);
  check("al volver a abrir la app ve el aviso", !!(await waitFor(ws2, "suspended")));

  // Panel
  const lista = (await post("/admin/drivers/list", { adminPin: ADMIN })).data;
  const fila = Array.isArray(lista) ? lista.find((x) => x.id === d.id) : null;
  check("panel: sale suspendido con motivo", fila?.suspended_at && fila?.suspended_reason === "documentos", fila);

  // Con viaje en curso no se suspende
  const reac = await post(`/admin/drivers/${d.id}/suspend`, { adminPin: ADMIN, suspend: false });
  check("reactivar ok", reac.status === 200, reac);
  check("su app recibe «reactivado»", !!(await waitFor(ws2, "unsuspended")));
  ws2.send(JSON.stringify({ type: "location", lat: TEKAX.lat + 0.001, lng: TEKAX.lng }));
  ws2.send(JSON.stringify({ type: "status", status: "disponible" }));
  await sleep(500);
  check("reactivado: ya se pone disponible", (await status(d.id)) === "disponible");
  const r2 = await pedir();
  const acc2 = await post(`/rides/${r2.data?.id}/accept`, D);
  check("reactivado: acepta viaje", acc2.status === 200, acc2);
  const enViaje = await post(`/admin/drivers/${d.id}/suspend`, { adminPin: ADMIN, suspend: true, reason: "reporte" });
  check("con viaje en curso no se suspende (409)", enViaje.status === 409, enViaje);
  await post(`/rides/${r2.data?.id}/cancel`, { riderPhone: R.rider_phone, riderPin: R.rider_pin });
  ws2.close();

  // No cuenta como chofer registrado
  const antes = await db.prepare("SELECT COUNT(*) AS n FROM drivers WHERE deleted_at IS NULL AND es_prueba = 0 AND suspended_at IS NULL AND city = 'tekax'").get();
  await post(`/admin/drivers/${d.id}/suspend`, { adminPin: ADMIN, suspend: true, reason: "reporte" });
  const despues = await db.prepare("SELECT COUNT(*) AS n FROM drivers WHERE deleted_at IS NULL AND es_prueba = 0 AND suspended_at IS NULL AND city = 'tekax'").get();
  check("suspendido ya no cuenta como chofer", Number(despues.n) === Number(antes.n) - 1, { antes, despues });
  const fd = await db.prepare("SELECT es_fundador, deleted_at FROM drivers WHERE id = ?").get(d.id);
  check("suspender no lo borra", fd && !fd.deleted_at);

  console.log(fail ? `NO: ${fail} fallaron, ${pass} bien` : `Todo bien (${pass})`);
}

async function limpiar() {
  for (const id of creados.riders.filter(Boolean)) {
    await db.prepare("DELETE FROM ride_offers WHERE ride_id IN (SELECT id FROM rides WHERE rider_id = ?)").run(id);
    await db.prepare("DELETE FROM rides WHERE rider_id = ?").run(id);
    await db.prepare("DELETE FROM booking_offers WHERE booking_id IN (SELECT id FROM ride_bookings WHERE rider_id = ?)").run(id);
    await db.prepare("DELETE FROM ride_bookings WHERE rider_id = ?").run(id);
    await post(`/admin/riders/${id}/delete`, { adminPin: ADMIN });
  }
  for (const id of creados.drivers) {
    await post(`/admin/drivers/${id}/suspend`, { adminPin: ADMIN, suspend: false });
    await post(`/admin/drivers/${id}/delete`, { adminPin: ADMIN });
  }
}

main()
  .catch((e) => { console.error(e); fail++; })
  .finally(async () => { await limpiar().catch((e) => console.error("limpieza:", e.message)); process.exit(fail ? 1 : 0); });
