// Prueba de la contraoferta en viajes agendados (routes/bookings.js, 13-nov-2026):
// el chofer propone otro precio con su motivo, el pasajero acepta o rechaza,
// el pasajero sube su precio, y "gana el primero" cuando otro confirma.
//   BASE=http://localhost:3077 DATABASE_URL=postgres://... node tools/test-agendar-oferta.js
// La copia tiene que correr con BOOKING_SWEEP_MS=2000 (para la parte de "sale solo").
const path = require("node:path");
const fs = require("node:fs");
const envFile = path.join(__dirname, "..", ".env");
if (fs.existsSync(envFile)) process.loadEnvFile(envFile);
const BASE = process.env.BASE || "http://localhost:3077";
if (!/^https?:\/\/(localhost|127\.0\.0\.1)[:/]/.test(BASE)) throw new Error("Esto solo se corre en localhost: " + BASE);
if (!/localhost|127\.0\.0\.1/.test(process.env.DATABASE_URL || "")) throw new Error("DATABASE_URL tiene que ser local");
const db = require("../db");
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
const offerStatus = async (bookingId, driverId) =>
  (await db.prepare("SELECT status FROM booking_offers WHERE booking_id = ? AND driver_id = ? ORDER BY id DESC").get(bookingId, driverId))?.status;

async function main() {
  const mk = async (name, phone, vehicleType) => (await post("/admin/drivers", { adminPin: ADMIN, name, phone, acceptedLegal: true, vehicleType })).data;
  const A = await mk(`Pedro Oferta ${stamp}`, `96100${stamp}`.slice(0, 10), "moto");
  const B = await mk(`Juan Oferta ${stamp}`, `96200${stamp}`.slice(0, 10), "moto");
  const TX = await mk(`Taxi Oferta ${stamp}`, `96300${stamp}`.slice(0, 10), "taxi");
  check("choferes creados", A?.id && B?.id && TX?.id, { A, B, TX });
  const reg1 = await post("/riders/register", { name: "Rosa Oferta Pérez", phone: `96400${stamp}`.slice(0, 10) });
  const reg2 = await post("/riders/register", { name: "Ana Oferta Chan", phone: `96500${stamp}`.slice(0, 10) });
  const R = { riderPhone: reg1.data.phone, riderPin: reg1.data.pin };
  const R2 = { riderPhone: reg2.data.phone, riderPin: reg2.data.pin };
  const DA = { driverId: A.id, pin: A.pin };
  const DB_ = { driverId: B.id, pin: B.pin };
  const DT = { driverId: TX.id, pin: TX.pin };
  const trip = { pickup_lat: T.lat, pickup_lng: T.lng, pickup_label: "Casa verde", dest_lat: T.lat + 0.01, dest_lng: T.lng, ride_type: "moto", offer_price: 17 };
  const at = (min) => Date.now() + min * MIN;

  const b1 = (await post("/bookings", { ...trip, ...R, scheduled_at_ms: at(180) })).data;
  check("viaje agendado", b1 && b1.status === "agendado" && Array.isArray(b1.offers) && b1.offers.length === 0, b1);

  // --- Reglas de la propuesta del chofer ---
  check("sin motivo no", (await post(`/bookings/${b1.id}/offer`, { ...DA, price: 25 })).status === 400);
  check("motivo 'lluvia' no existe en agendados", (await post(`/bookings/${b1.id}/offer`, { ...DA, price: 25, reason: "lluvia" })).status === 400);
  check("igual al precio del pasajero no", (await post(`/bookings/${b1.id}/offer`, { ...DA, price: 17, reason: "lejos" })).status === 400);
  check("más de $40 arriba no", (await post(`/bookings/${b1.id}/offer`, { ...DA, price: 58, reason: "lejos" })).status === 400);
  check("PIN malo no", (await post(`/bookings/${b1.id}/offer`, { driverId: A.id, pin: "0000", price: 25, reason: "lejos" })).status === 401);
  check("el taxista no propone en un mototaxi", (await post(`/bookings/${b1.id}/offer`, { ...DT, price: 25, reason: "lejos" })).status === 404);
  const oA = await post(`/bookings/${b1.id}/offer`, { ...DA, price: 25, reason: "lejos" });
  check("Pedro propone $25 porque es lejos", oA.status === 200, oA);

  const lA = await post("/bookings/driver", DA);
  const seenA = lA.data.available.find((x) => x.id === b1.id);
  check("Pedro ve su propuesta esperando", seenA?.myOffer?.price === 25 && seenA.myOffer.reason === "lejos", seenA);
  check("la lista trae los motivos y el máximo", lA.data.offerReasons?.temprano === "Es muy temprano" && !lA.data.offerReasons.lluvia && lA.data.offerMaxUp === 40, lA.data);
  const lB = await post("/bookings/driver", DB_);
  check("Juan no ve la propuesta de Pedro", lB.data.available.find((x) => x.id === b1.id)?.myOffer === null);

  // Reemplaza: una sola viva por chofer
  check("Pedro cambia a $27", (await post(`/bookings/${b1.id}/offer`, { ...DA, price: 27, reason: "temprano" })).status === 200);
  check("Juan propone $30 porque es de noche", (await post(`/bookings/${b1.id}/offer`, { ...DB_, price: 30, reason: "noche" })).status === 200);
  const m1 = (await post("/bookings/mine", R)).data.find((x) => x.id === b1.id);
  check("el pasajero ve 2 propuestas (la vieja de Pedro ya no)", m1?.offers.length === 2 && m1.offers[0].price === 27 && m1.offers[1].price === 30, m1);
  check("con nombre, motivo y sin teléfono del chofer", m1?.offers[0].driver.name === "Pedro" && m1.offers[0].reason === "Es muy temprano" && !JSON.stringify(m1).includes(A.phone || "@@"), m1);
  const offA = m1.offers.find((o) => o.price === 27);
  const offB = m1.offers.find((o) => o.price === 30);

  // Otra pasajera no toca propuestas ajenas
  check("otra pasajera no acepta lo ajeno", (await post(`/bookings/${b1.id}/offers/${offA.id}/accept`, R2)).status === 404);

  // Rechaza a Juan, acepta a Pedro
  check("rechaza a Juan", (await post(`/bookings/${b1.id}/offers/${offB.id}/reject`, R)).status === 200);
  check("la de Juan queda rechazada", (await offerStatus(b1.id, B.id)) === "rechazada");
  check("ya no se acepta la rechazada", (await post(`/bookings/${b1.id}/offers/${offB.id}/accept`, R)).status === 409);
  const acc = await post(`/bookings/${b1.id}/offers/${offA.id}/accept`, R);
  check("acepta a Pedro por $27", acc.status === 200 && acc.data.status === "confirmado" && acc.data.offer_price === 27 && acc.data.driver?.name === "Pedro" && acc.data.offers.length === 0, acc);
  const g1 = await getBooking(b1.id);
  check("en la base: confirmado con Pedro a $27", g1.status === "confirmado" && g1.driver_id === A.id && g1.offer_price === 27, g1);
  const lA2 = await post("/bookings/driver", DA);
  const mineA = lA2.data.mine.find((x) => x.id === b1.id);
  check("Pedro lo tiene en los suyos con el lugar exacto", mineA && mineA.pickup_lat === T.lat && mineA.pickup_label === "Casa verde" && mineA.offer_price === 27, mineA);
  check("no se acepta dos veces", (await post(`/bookings/${b1.id}/offers/${offA.id}/accept`, R)).status === 409);
  check("ya confirmado no se proponen precios", (await post(`/bookings/${b1.id}/offer`, { ...DB_, price: 30, reason: "lejos" })).status === 409);

  // --- Gana el primero: Juan confirma al precio del pasajero mientras Pedro espera ---
  const b2 = (await post("/bookings", { ...trip, ...R, scheduled_at_ms: at(600) })).data;
  check("Pedro propone en el segundo", (await post(`/bookings/${b2.id}/offer`, { ...DA, price: 22, reason: "camino" })).status === 200);
  const pend = (await post("/bookings/mine", R)).data.find((x) => x.id === b2.id).offers[0];
  check("Juan confirma a $17", (await post(`/bookings/${b2.id}/take`, DB_)).status === 200);
  check("la propuesta de Pedro se cerró sola", (await offerStatus(b2.id, A.id)) === "cerrada");
  check("ya no se puede aceptar a Pedro", (await post(`/bookings/${b2.id}/offers/${pend.id}/accept`, R)).status === 409);
  check("el viaje sigue a $17 con Juan", (await getBooking(b2.id)).driver_id === B.id && (await getBooking(b2.id)).offer_price === 17);

  // --- Pedro no propone en un viaje pegado al suyo (b1 a las 3 h) ---
  const b3 = (await post("/bookings", { ...trip, ...R2, scheduled_at_ms: at(190) })).data;
  const gap = await post(`/bookings/${b3.id}/offer`, { ...DA, price: 25, reason: "lejos" });
  check("Pedro no propone a 10 min de su otro viaje", gap.status === 409, gap);

  // --- La pasajera sube su precio ---
  const b4 = (await post("/bookings", { ...trip, ...R2, scheduled_at_ms: at(900) })).data;
  check("Juan propone $25", (await post(`/bookings/${b4.id}/offer`, { ...DB_, price: 25, reason: "lejos" })).status === 200);
  check("Pedro propone $35", (await post(`/bookings/${b4.id}/offer`, { ...DA, price: 35, reason: "noche" })).status === 200);
  check("subir a menos o igual no", (await post(`/bookings/${b4.id}/price`, { ...R2, price: 17 })).status === 400);
  check("otra persona no le sube el precio", (await post(`/bookings/${b4.id}/price`, { ...R, price: 30 })).status === 404);
  const up = await post(`/bookings/${b4.id}/price`, { ...R2, price: 30 });
  check("Ana sube a $30", up.status === 200 && up.data.offer_price === 30, up);
  check("la de Juan ($25) se quitó sola", (await offerStatus(b4.id, B.id)) === "cerrada");
  check("la de Pedro ($35) sigue", up.data.offers?.length === 1 && up.data.offers[0].price === 35, up.data);
  const lB4 = (await post("/bookings/driver", DB_)).data.available.find((x) => x.id === b4.id);
  check("los choferes ven el precio nuevo", lB4?.offer_price === 30 && lB4.myOffer === null, lB4);
  check("ahora Juan tiene que proponer más de $30", (await post(`/bookings/${b4.id}/offer`, { ...DB_, price: 28, reason: "lejos" })).status === 400);

  // Pedro retira la suya
  check("Pedro retira su propuesta", (await post(`/bookings/${b4.id}/offer/withdraw`, DA)).status === 200);
  check("la pasajera ya no la ve", (await post("/bookings/mine", R2)).data.find((x) => x.id === b4.id).offers.length === 0);

  // Cancelar con una propuesta viva la cierra
  check("Juan propone otra vez", (await post(`/bookings/${b4.id}/offer`, { ...DB_, price: 40, reason: "otro" })).status === 200);
  check("Ana cancela", (await post(`/bookings/${b4.id}/cancel`, R2)).status === 200);
  check("la propuesta quedó cerrada", (await offerStatus(b4.id, B.id)) === "cerrada");
  check("ya confirmado no se sube el precio", (await post(`/bookings/${b1.id}/price`, { ...R, price: 40 })).status === 409);

  // --- Sale solo al precio acordado ---
  await db.prepare("UPDATE ride_bookings SET scheduled_at_ms = ? WHERE id = ?").run(at(10), b1.id);
  const l1 = await waitFor(async () => { const b = await getBooking(b1.id); return b.status === "lanzado" ? b : null; });
  check("el viaje con precio aceptado salió solo", !!l1, await getBooking(b1.id));
  if (l1) {
    const ride = await db.prepare("SELECT * FROM rides WHERE id = ?").get(l1.ride_id);
    check("aceptado por Pedro a $27", ride && ride.status === "aceptado" && ride.driver_id === A.id && ride.agreed_price === 27, ride);
    await post(`/rides/${l1.ride_id}/cancel`, { riderPhone: R.riderPhone, riderPin: R.riderPin });
  }
  for (const b of [b2, b3]) await post(`/bookings/${b.id}/cancel`, b === b3 ? R2 : R);

  // --- Arreglos de la revisión ---
  const b5 = (await post("/bookings", { ...trip, ...R2, scheduled_at_ms: at(300) })).data;
  check("Juan propone en el viaje de Ana", (await post(`/bookings/${b5.id}/offer`, { ...DB_, price: 22, reason: "lejos" })).status === 200);
  check("Juan cambia su precio", (await post(`/bookings/${b5.id}/offer`, { ...DB_, price: 24, reason: "lejos" })).status === 200);
  const vivas = await db.prepare("SELECT COUNT(*) AS n FROM booking_offers WHERE booking_id = ? AND driver_id = ? AND status = 'pendiente'").get(b5.id, B.id);
  check("solo 1 propuesta viva de Juan", Number(vivas.n) === 1, vivas);
  const del = await post(`/admin/riders/${reg2.data.id}/delete`, { adminPin: ADMIN });
  check("el panel puede borrar a una pasajera con propuestas", del.status === 200, del);
  check("sus propuestas se borraron", Number((await db.prepare("SELECT COUNT(*) AS n FROM booking_offers WHERE booking_id = ?").get(b5.id)).n) === 0);

  console.log(fail ? `✗ ${fail} mal, ${pass} bien` : `✓ ${pass} bien`);
  await db.close();
  process.exit(fail ? 1 : 0);
}

main().catch(async (e) => {
  console.error("✗ Error:", e);
  try { await db.close(); } catch {}
  process.exit(1);
});
