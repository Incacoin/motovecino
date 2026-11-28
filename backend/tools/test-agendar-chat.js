// Prueba del chat en viajes agendados (routes/bookings.js, 27-nov-2026):
// se abre cuando un chofer confirma y se cierra al soltar, cancelar o salir el
// viaje; solo ese pasajero y ese chofer lo leen; los teléfonos se tapan; el
// chofer nuevo no ve la plática del anterior; límites; borrado a los 30 días;
// llaves del aviso del chofer.
//   BASE=http://localhost:3077 DATABASE_URL=postgres://... node tools/test-agendar-chat.js
// La copia tiene que correr con BOOKING_SWEEP_MS=2000 (para la parte de "sale solo").
const path = require("node:path");
const fs = require("node:fs");
const crypto = require("node:crypto");
const envFile = path.join(__dirname, "..", ".env");
if (fs.existsSync(envFile)) process.loadEnvFile(envFile);
const BASE = process.env.BASE || "http://localhost:3077";
if (!/^https?:\/\/(localhost|127\.0\.0\.1)[:/]/.test(BASE)) throw new Error("Esto solo se corre en localhost: " + BASE);
if (!/localhost|127\.0\.0\.1/.test(process.env.DATABASE_URL || "")) throw new Error("DATABASE_URL tiene que ser local");
const db = require("../db");
const { purgeOldPersonalData } = require("../retention");
const ADMIN = process.env.ADMIN_PIN;
const T = { lat: 20.2071, lng: -89.2809 }; // Tekax
const MIN = 60 * 1000;

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
  const res = await fetch(BASE + "/api" + url, { method, headers: { "Content-Type": "application/json" }, body: body ? JSON.stringify(body) : undefined });
  let data = null;
  try { data = await res.json(); } catch {}
  return { status: res.status, data };
}
const post = (u, b) => api("POST", u, b);
const stamp = String(Date.now()).slice(-6);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(fn, ms = 20000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const v = await fn();
    if (v) return v;
    await sleep(500);
  }
  return null;
}
const getBooking = (id) => db.prepare("SELECT * FROM ride_bookings WHERE id = ?").get(id);
const mineOf = async (creds, id) => (await post("/bookings/mine", creds)).data.find((x) => x.id === id);
const driverMine = async (creds, id) => (await post("/bookings/driver", creds)).data.mine.find((x) => x.id === id);

async function main() {
  const mk = async (name, phone) => (await post("/admin/drivers", { adminPin: ADMIN, name, phone, acceptedLegal: true, vehicleType: "moto" })).data;
  const phoneA = `96600${stamp}`.slice(0, 10);
  const phoneB = `96700${stamp}`.slice(0, 10);
  const A = await mk(`Pedro Chat ${stamp}`, phoneA);
  const B = await mk(`Juan Chat ${stamp}`, phoneB);
  check("choferes creados", A?.id && B?.id, { A, B });
  // Pasajeros directo en la base: /riders/register solo deja 20 por hora desde
  // el mismo lugar y npm test corre todas las pruebas seguidas.
  const mkRider = async (name, phone) => {
    const pin = String(1000 + Math.floor(Math.random() * 9000));
    const r = await db.prepare("INSERT INTO riders (phone, name, city, pin) VALUES (?, ?, 'tekax', ?)").run(phone, name, pin);
    return { riderPhone: phone, riderPin: pin, id: r.lastInsertRowid };
  };
  const R = await mkRider("Rosa Chat Pérez", `96800${stamp}`.slice(0, 10));
  const R2 = await mkRider("Ana Chat Chan", `96900${stamp}`.slice(0, 10));
  const DA = { driverId: A.id, pin: A.pin };
  const DB_ = { driverId: B.id, pin: B.pin };
  const trip = { pickup_lat: T.lat, pickup_lng: T.lng, pickup_label: "Casa verde", dest_lat: T.lat + 0.01, dest_lng: T.lng, ride_type: "moto", offer_price: 17 };
  const at = (min) => Date.now() + min * MIN;

  const b1 = (await post("/bookings", { ...trip, ...R, scheduled_at_ms: at(180) })).data;
  check("viaje agendado", b1?.status === "agendado", b1);

  // --- Antes de que un chofer confirme: no hay chat ---
  const pre = await post(`/bookings/${b1.id}/chat`, R);
  check("sin chofer el chat está cerrado", pre.status === 200 && pre.data.open === false, pre);
  check("sin chofer no se puede mandar", (await post(`/bookings/${b1.id}/chat`, { ...R, text: "hola" })).status === 409);
  check("un chofer que no confirmó no entra", (await post(`/bookings/${b1.id}/driver-chat`, DA)).status === 404);

  // --- Pedro confirma: se abre ---
  check("Pedro confirma", (await post(`/bookings/${b1.id}/take`, DA)).status === 200);
  const open = await post(`/bookings/${b1.id}/chat`, R);
  check("chat abierto y vacío", open.data.open === true && open.data.messages.length === 0, open);
  check("mensaje vacío no", (await post(`/bookings/${b1.id}/chat`, { ...R, text: "   " })).status === 400);
  check("texto que no es texto no", (await post(`/bookings/${b1.id}/chat`, { ...R, text: 12345 })).status === 400);

  const s1 = await post(`/bookings/${b1.id}/chat`, { ...R, text: "Hola, es la casa verde. Mi cel es 997 123-4567" });
  check("Rosa manda un mensaje", s1.status === 200 && s1.data.messages.length === 1 && s1.data.messages[0].mine === true, s1);
  const t1 = s1.data?.messages?.[0]?.text || "";
  check("el teléfono se tapa", !/4567/.test(t1) && t1.includes("•") && t1.includes("casa verde"), t1);
  check("dos mensajes seguidos de golpe no", (await post(`/bookings/${b1.id}/chat`, { ...R, text: "otro" })).status === 429);
  const saved = await db.prepare("SELECT text FROM booking_messages WHERE booking_id = ?").get(b1.id);
  check("en la base también se guarda tapado", saved && !/4567/.test(saved.text), saved);

  check("Pedro tiene 1 sin leer", (await driverMine(DA, b1.id))?.chatUnread === 1);
  check("Pedro tiene botón de chat", (await driverMine(DA, b1.id))?.chat === true);
  const dl = await post(`/bookings/${b1.id}/driver-chat`, DA);
  check("Pedro lo lee", dl.status === 200 && dl.data.open && dl.data.messages.length === 1 && dl.data.messages[0].mine === false, dl);
  check("ya no tiene sin leer", (await driverMine(DA, b1.id))?.chatUnread === 0);

  await sleep(1600);
  const long = "a".repeat(500);
  const s2 = await post(`/bookings/${b1.id}/driver-chat`, { ...DA, text: long });
  check("Pedro contesta (se recorta a 300)", s2.status === 200 && s2.data.messages[1].text.length === 300, s2.status);
  check("Rosa tiene 1 sin leer", (await mineOf(R, b1.id))?.chatUnread === 1);
  await post(`/bookings/${b1.id}/chat`, R);
  check("al abrir el chat se marca leído", (await mineOf(R, b1.id))?.chatUnread === 0);

  // --- Nadie más lo lee ---
  check("otro chofer no", (await post(`/bookings/${b1.id}/driver-chat`, DB_)).status === 404);
  check("otra pasajera no", (await post(`/bookings/${b1.id}/chat`, R2)).status === 404);
  check("PIN malo del pasajero no", (await post(`/bookings/${b1.id}/chat`, { riderPhone: R.riderPhone, riderPin: "0000" })).status === 401);
  check("PIN malo del chofer no", (await post(`/bookings/${b1.id}/driver-chat`, { driverId: A.id, pin: "0000" })).status === 401);

  // --- Pedro lo suelta: Juan no ve la plática de Pedro ---
  check("Pedro suelta el viaje", (await post(`/bookings/${b1.id}/release`, DA)).status === 200);
  check("Pedro ya no entra al chat", (await post(`/bookings/${b1.id}/driver-chat`, DA)).status === 404);
  check("para Rosa queda cerrado", (await post(`/bookings/${b1.id}/chat`, R)).data.open === false);
  check("Juan confirma", (await post(`/bookings/${b1.id}/take`, DB_)).status === 200);
  const jl = await post(`/bookings/${b1.id}/driver-chat`, DB_);
  check("Juan ve el chat vacío", jl.status === 200 && jl.data.open && jl.data.messages.length === 0, jl);
  check("Rosa también lo ve vacío con Juan", (await post(`/bookings/${b1.id}/chat`, R)).data.messages.length === 0);
  check("sin mensajes de Pedro sin leer", (await mineOf(R, b1.id))?.chatUnread === 0);

  // --- Tope de mensajes por viaje ---
  for (let i = 0; i < 80; i++) await db.prepare("INSERT INTO booking_messages (booking_id, driver_id, sender, text, created_at) VALUES (?, ?, 'driver', 'x', datetime('now', '-1 hour'))").run(b1.id, B.id);
  check("arriba de 80 mensajes no", (await post(`/bookings/${b1.id}/chat`, { ...R, text: "uno más" })).status === 409);
  await db.prepare("DELETE FROM booking_messages WHERE booking_id = ? AND driver_id = ?").run(b1.id, B.id);

  // --- Teléfono partido en dos mensajes ---
  await sleep(1600);
  check("Rosa manda la primera mitad", (await post(`/bookings/${b1.id}/chat`, { ...R, text: "Mi cel 997 123" })).status === 200);
  await sleep(1600);
  const half = await post(`/bookings/${b1.id}/chat`, { ...R, text: "4567" });
  const lastTxt = half.data?.messages?.at(-1)?.text || "";
  check("la segunda mitad también se tapa", half.status === 200 && !/4567/.test(lastTxt) && lastTxt.includes("•"), lastTxt);
  await sleep(1600);
  const price = await post(`/bookings/${b1.id}/chat`, { ...R, text: "Le doy $30" });
  check("un precio normal no se tapa", price.data?.messages?.at(-1)?.text === "Le doy $30", price.data?.messages?.at(-1));

  // --- Pasajero bloqueado: ya no escribe ---
  await sleep(1600);
  check("el admin bloquea a Rosa", (await post(`/admin/riders/${R.id}/block`, { adminPin: ADMIN, block: true })).status === 200);
  const blk = await post(`/bookings/${b1.id}/chat`, { ...R, text: "hola" });
  check("bloqueada no puede escribir (403)", blk.status === 403 && blk.data?.blocked === true, blk);
  check("bloqueada sí puede leer", (await post(`/bookings/${b1.id}/chat`, R)).status === 200);
  check("el admin la desbloquea", (await post(`/admin/riders/${R.id}/block`, { adminPin: ADMIN, block: false })).status === 200);

  // --- Cancelado: se cierra ---
  check("Rosa cancela", (await post(`/bookings/${b1.id}/cancel`, R)).status === 200);
  check("cancelado: chat cerrado para Rosa", (await post(`/bookings/${b1.id}/chat`, R)).data.open === false);
  check("cancelado: Juan no puede mandar", (await post(`/bookings/${b1.id}/driver-chat`, { ...DB_, text: "hola" })).status === 409);

  // --- Envío de negocio: sin chat ---
  const envio = await db.prepare("SELECT id FROM ride_bookings WHERE business_id IS NOT NULL LIMIT 1").get();
  if (envio) check("envío de negocio: sin chat", (await post(`/bookings/${envio.id}/driver-chat`, DA)).status === 404);

  // --- Sale el viaje: el chat se cierra y lo dice ---
  const b2 = (await post("/bookings", { ...trip, ...R2, scheduled_at_ms: at(180) })).data;
  check("Pedro confirma el de Ana", (await post(`/bookings/${b2.id}/take`, DA)).status === 200);
  check("Ana escribe", (await post(`/bookings/${b2.id}/chat`, { ...R2, text: "Gracias, lo espero" })).status === 200);
  await db.prepare("UPDATE ride_bookings SET scheduled_at_ms = ? WHERE id = ?").run(at(10), b2.id);
  const l2 = await waitFor(async () => { const b = await getBooking(b2.id); return b.status === "lanzado" ? b : null; }, 45000);
  check("el viaje salió solo", !!l2, await getBooking(b2.id));
  if (l2) {
    const c = await post(`/bookings/${b2.id}/chat`, R2);
    check("ya salió: chat cerrado con aviso", c.data.open === false && /ya salió/.test(c.data.closedText || ""), c);
    check("ya salió: Pedro no puede mandar", (await post(`/bookings/${b2.id}/driver-chat`, { ...DA, text: "voy" })).status === 409);
    await post(`/rides/${l2.ride_id}/cancel`, { riderPhone: R2.riderPhone, riderPin: R2.riderPin });
  }

  // --- Se borra a los 30 días ---
  const viejo = await db.prepare("INSERT INTO booking_messages (booking_id, driver_id, sender, text, created_at) VALUES (?, ?, 'rider', 'viejo', datetime('now', '-31 days'))").run(b2.id, A.id);
  await purgeOldPersonalData();
  check("mensaje de hace 31 días borrado", !(await db.prepare("SELECT id FROM booking_messages WHERE id = ?").get(viejo.lastInsertRowid)));
  check("el de hoy se queda", Number((await db.prepare("SELECT COUNT(*) AS n FROM booking_messages WHERE booking_id = ?").get(b2.id)).n) === 1);

  // --- El admin puede borrar a una pasajera que usó el chat ---
  const delR2 = await post(`/admin/riders/${R2.id}/delete`, { adminPin: ADMIN });
  check("borrar pasajera con mensajes funciona", delR2.status === 200, delR2);
  check("sus mensajes se borraron", Number((await db.prepare("SELECT COUNT(*) AS n FROM booking_messages WHERE booking_id = ?").get(b2.id)).n) === 0);

  // --- Llaves del aviso del chofer ---
  const ecdh = crypto.createECDH("prime256v1");
  ecdh.generateKeys();
  const keys = { p256dh: ecdh.getPublicKey().toString("base64url"), auth: crypto.randomBytes(16).toString("base64url") };
  const endpoint = `https://fcm.googleapis.com/fcm/send/prueba-chat-${stamp}`;
  const subRow = () => db.prepare("SELECT driver_id, p256dh, auth FROM driver_push_subs WHERE endpoint = ?").get(endpoint);
  check("suscripción con llaves", (await post("/drivers/push/subscribe", { phone: phoneA, pin: A.pin, endpoint, ...keys })).status === 200);
  check("se guardaron las llaves", (await subRow())?.p256dh === keys.p256dh && (await subRow())?.auth === keys.auth, await subRow());
  await post("/drivers/push/subscribe", { phone: phoneA, pin: A.pin, endpoint });
  check("sin llaves (app vieja) no se borran", (await subRow())?.p256dh === keys.p256dh);
  await post("/drivers/push/subscribe", { phone: phoneA, pin: A.pin, endpoint, p256dh: "basura", auth: "x" });
  check("llaves raras no se guardan", (await subRow())?.p256dh === keys.p256dh);
  await post("/drivers/push/subscribe", { phone: phoneB, pin: B.pin, endpoint });
  const moved = await subRow();
  check("celular pasa a otro chofer: llaves fuera", moved?.driver_id === B.id && moved.p256dh == null && moved.auth == null, moved);
  await db.prepare("DELETE FROM driver_push_subs WHERE endpoint = ?").run(endpoint);

  console.log(fail ? `✗ ${fail} mal, ${pass} bien` : `✓ ${pass} bien`);
  await db.close();
  process.exit(fail ? 1 : 0);
}

main().catch(async (e) => {
  console.error("✗ Error:", e);
  try { await db.close(); } catch {}
  process.exit(1);
});
