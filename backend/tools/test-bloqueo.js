// Pasajeros que piden y no salen (26-nov-2026, ver riderBlock.js):
// bloqueo a mano desde el panel (por número, sobrevive a borrar la cuenta) y
// pausa automática con 3 «El pasajero no llegó» en 7 días de 2+ choferes.
//   BASE=http://localhost:3077 node tools/test-bloqueo.js
const path = require("node:path");
const fs = require("node:fs");
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
  // IP propia: no gasta los límites que comparten las demás pruebas.
  const res = await fetch(BASE + "/api" + url, { method: "POST", headers: { "Content-Type": "application/json", "X-Forwarded-For": "10.77.0.31" }, body: JSON.stringify(body || {}) });
  let data = null;
  try { data = await res.json(); } catch {}
  return { status: res.status, data };
}
const stamp = String(Date.now()).slice(-6);
const creados = { riders: [], drivers: [] };

async function main() {
  const mkDriver = async (n) => {
    const r = await post("/admin/drivers", { adminPin: ADMIN, name: `Chofer Bloqueo ${n} ${stamp}`, phone: `9977${n}${stamp}`.slice(0, 10), vehicle: "Prueba", acceptedLegal: true, vehicleType: "moto", photo: PNG });
    check(`alta chofer ${n}`, r.status === 201, r);
    creados.drivers.push(r.data.id);
    return r.data;
  };
  const d1 = await mkDriver(1);
  const d2 = await mkDriver(2);

  const reg = await post("/riders/register", { name: "Jorge Prueba Bloqueo", phone: `96600${stamp}`.slice(0, 10), lat: TEKAX.lat, lng: TEKAX.lng });
  check("alta del pasajero", reg.status === 201, reg);
  creados.riders.push(reg.data.id);
  const R = { rider_phone: reg.data.phone, rider_pin: reg.data.pin };
  const pedir = () => post("/rides", { ...R, pickup_lat: TEKAX.lat, pickup_lng: TEKAX.lng, dest_lat: TEKAX.lat + 0.01, dest_lng: TEKAX.lng, ride_type: "moto", offer_price: 30 });
  // Simula que un chofer lo aceptó y canceló con «El pasajero no llegó».
  const noLlego = async (driverId) => {
    const r = await pedir();
    check("pide viaje", r.status === 201, r);
    if (r.status !== 201) return;
    await db.prepare("UPDATE rides SET driver_id = ?, status = 'cancelado', cancelled_by = 'driver', cancel_reason = 'El pasajero no llegó', updated_at = datetime('now') WHERE id = ?").run(driverId, r.data.id);
    // Lo mismo que hace /rides/:id/cancel con ese motivo.
    await db.prepare("UPDATE riders SET no_show_count = no_show_count + 1 WHERE id = ?").run(reg.data.id);
  };
  const lista = async () => (await post("/admin/riders/list", { adminPin: ADMIN })).data.find((x) => x.id === reg.data.id);

  // --- Pausa automática ---
  await noLlego(d1.id);
  await noLlego(d1.id);
  await noLlego(d1.id);
  const unSolo = await pedir();
  check("3 faltas de UN solo chofer: todavía puede pedir", unSolo.status === 201, unSolo);
  await db.prepare("UPDATE rides SET driver_id = ?, status = 'cancelado', cancelled_by = 'driver', cancel_reason = 'El pasajero no llegó', updated_at = datetime('now') WHERE id = ?").run(d2.id, unSolo.data?.id);
  await db.prepare("UPDATE riders SET no_show_count = no_show_count + 1 WHERE id = ?").run(reg.data.id);
  const pausado = await pedir();
  check("4 faltas de 2 choferes: ya no puede pedir (403)", pausado.status === 403 && pausado.data?.blocked === true && /Ayuda/.test(pausado.data?.error || ""), pausado);
  check("panel: sale PAUSADO", (await lista())?.pausado === true);
  const agenda = await post("/bookings", { riderPhone: R.rider_phone, riderPin: R.rider_pin, scheduled_at_ms: Date.now() + 3 * 3600e3, pickup_lat: TEKAX.lat, pickup_lng: TEKAX.lng, dest_lat: TEKAX.lat + 0.01, dest_lng: TEKAX.lng, offer_price: 30 });
  check("pausado tampoco puede agendar", agenda.status === 403 && agenda.data?.blocked === true, agenda);

  // Faltas viejas (más de 7 días) no cuentan
  await db.prepare("UPDATE rides SET updated_at = datetime('now', '-8 days') WHERE rider_id = ? AND cancel_reason = 'El pasajero no llegó'").run(reg.data.id);
  const viejas = await pedir();
  check("faltas de hace más de 7 días ya no pausan", viejas.status === 201, viejas);
  await db.prepare("UPDATE rides SET status = 'cancelado', cancelled_by = 'rider', updated_at = datetime('now', '-8 days') WHERE id = ?").run(viejas.data?.id);
  await db.prepare("UPDATE rides SET updated_at = datetime('now') WHERE rider_id = ? AND cancel_reason = 'El pasajero no llegó'").run(reg.data.id);
  check("de nuevo pausado con faltas recientes", (await pedir()).status === 403);

  // --- Desbloquear quita la pausa ---
  const sinBool = await post(`/admin/riders/${reg.data.id}/block`, { adminPin: ADMIN });
  check("bloquear sin decir sí/no = 400", sinBool.status === 400, sinBool);
  const sinPin = await post(`/admin/riders/${reg.data.id}/block`, { adminPin: "malo", block: false });
  check("sin PIN de admin no se puede", sinPin.status === 401 || sinPin.status === 403, sinPin);
  const desb = await post(`/admin/riders/${reg.data.id}/block`, { adminPin: ADMIN, block: false });
  check("desbloquear ok", desb.status === 200, desb);
  const libre = await pedir();
  check("desbloqueado: ya puede pedir", libre.status === 201, libre);
  await post(`/rides/${libre.data?.id}/cancel`, { riderPhone: R.rider_phone, riderPin: R.rider_pin });
  check("panel: ya no sale pausado", (await lista())?.pausado === false);

  // --- Bloqueo a mano ---
  const bl = await post(`/admin/riders/${reg.data.id}/block`, { adminPin: ADMIN, block: true });
  check("bloquear ok", bl.status === 200, bl);
  const bloq = await pedir();
  check("bloqueado no puede pedir (403)", bloq.status === 403 && bloq.data?.blocked === true, bloq);
  check("panel: sale BLOQUEADO", (await lista())?.bloqueado === true);
  const otraVez = await post(`/admin/riders/${reg.data.id}/block`, { adminPin: ADMIN, block: true });
  check("bloquear dos veces no truena", otraVez.status === 200, otraVez);

  // Sigue bloqueado aunque se borre la cuenta y se registre otra vez con el mismo número
  await db.prepare("DELETE FROM rides WHERE rider_id = ?").run(reg.data.id);
  const del = await post(`/admin/riders/${reg.data.id}/delete`, { adminPin: ADMIN });
  check("borrar la cuenta", del.status === 200, del);
  creados.riders = creados.riders.filter((x) => x !== reg.data.id);
  const reg2 = await post("/riders/register", { name: "Jorge Otra Vez", phone: reg.data.phone, lat: TEKAX.lat, lng: TEKAX.lng });
  check("se registra otra vez con el mismo número", reg2.status === 201, reg2);
  creados.riders.push(reg2.data?.id);
  const r2 = await post("/rides", { rider_phone: reg2.data?.phone, rider_pin: reg2.data?.pin, pickup_lat: TEKAX.lat, pickup_lng: TEKAX.lng, dest_lat: TEKAX.lat + 0.01, dest_lng: TEKAX.lng, ride_type: "moto", offer_price: 30 });
  check("cuenta nueva con número bloqueado: sigue sin poder pedir", r2.status === 403 && r2.data?.blocked === true, r2);
  const desb2 = await post(`/admin/riders/${reg2.data?.id}/block`, { adminPin: ADMIN, block: false });
  check("desbloquear la cuenta nueva", desb2.status === 200, desb2);

  // Otro pasajero no se ve afectado
  const otro = await post("/riders/register", { name: "Pasajera Normal", phone: `96700${stamp}`.slice(0, 10), lat: TEKAX.lat, lng: TEKAX.lng });
  creados.riders.push(otro.data?.id);
  const ok = await post("/rides", { rider_phone: otro.data?.phone, rider_pin: otro.data?.pin, pickup_lat: TEKAX.lat, pickup_lng: TEKAX.lng, dest_lat: TEKAX.lat + 0.01, dest_lng: TEKAX.lng, ride_type: "moto", offer_price: 30 });
  check("otro pasajero pide normal", ok.status === 201, ok);

  console.log(fail ? `NO: ${fail} fallaron, ${pass} bien` : `Todo bien (${pass})`);
}

async function limpiar() {
  for (const id of creados.riders.filter(Boolean)) {
    const r = await db.prepare("SELECT phone FROM riders WHERE id = ?").get(id);
    if (r) await db.prepare("DELETE FROM blocked_phones WHERE phone = ?").run(r.phone);
    await db.prepare("DELETE FROM rides WHERE rider_id = ?").run(id);
    await post(`/admin/riders/${id}/delete`, { adminPin: ADMIN });
  }
  for (const id of creados.drivers) await post(`/admin/drivers/${id}/delete`, { adminPin: ADMIN });
}

main()
  .catch((e) => { console.error(e); fail++; })
  .finally(async () => { await limpiar().catch((e) => console.error("limpieza:", e.message)); process.exit(fail ? 1 : 0); });
