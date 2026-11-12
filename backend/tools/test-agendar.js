// Prueba de "Agendar viaje" (routes/bookings.js, 12-nov-2026): reglas al
// agendar, chofer confirma / suelta, y que cerca de la hora el viaje salga
// solo (asignado al chofer confirmado, o a todos si nadie lo confirmó).
//   BASE=http://localhost:3077 DATABASE_URL=postgres://... node tools/test-agendar.js
// La copia tiene que correr con BOOKING_SWEEP_MS=2000 para no esperar 30 s.
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
const setWhen = (id, ms) => db.prepare("UPDATE ride_bookings SET scheduled_at_ms = ? WHERE id = ?").run(ms, id);
const getBooking = (id) => db.prepare("SELECT * FROM ride_bookings WHERE id = ?").get(id);

async function main() {
  const mk = async (name, phone, vehicleType) => (await post("/admin/drivers", { adminPin: ADMIN, name, phone, acceptedLegal: true, vehicleType })).data;
  const A = await mk(`Pedro Agenda ${stamp}`, `97100${stamp}`.slice(0, 10), "moto");
  const B = await mk(`Juan Agenda ${stamp}`, `97200${stamp}`.slice(0, 10), "moto");
  const TX = await mk(`Taxi Agenda ${stamp}`, `97300${stamp}`.slice(0, 10), "taxi");
  check("choferes creados", A && A.id && B && B.id && TX && TX.id, { A, B, TX });
  const reg = await post("/riders/register", { name: "María Agenda López", phone: `97400${stamp}`.slice(0, 10) });
  const R = { riderPhone: reg.data.phone, riderPin: reg.data.pin };
  const DA = { driverId: A.id, pin: A.pin };
  const DB_ = { driverId: B.id, pin: B.pin };
  const DT = { driverId: TX.id, pin: TX.pin };

  const trip = { pickup_lat: T.lat, pickup_lng: T.lng, pickup_label: "Casa azul", dest_lat: T.lat + 0.01, dest_lng: T.lng, ride_type: "moto", offer_price: 17 };
  const at = (min) => Date.now() + min * MIN;

  // --- Reglas al agendar ---
  check("PIN malo no agenda", (await post("/bookings", { ...trip, riderPhone: R.riderPhone, riderPin: "0000", scheduled_at_ms: at(120) })).status === 401);
  const soon = await post("/bookings", { ...trip, ...R, scheduled_at_ms: at(10) });
  check("menos de 40 min no", soon.status === 400, soon);
  const far = await post("/bookings", { ...trip, ...R, scheduled_at_ms: at(8 * 24 * 60) });
  check("más de 7 días no", far.status === 400, far);
  const noDest = await post("/bookings", { ...trip, dest_lat: null, ...R, scheduled_at_ms: at(120) });
  check("sin destino no", noDest.status === 400, noDest);
  const low = await post("/bookings", { ...trip, offer_price: 16, ...R, scheduled_at_ms: at(120) });
  check("precio abajo del mínimo de Tekax no", low.status === 400 && /17/.test(low.data.error), low);
  const b1 = await post("/bookings", { ...trip, ...R, scheduled_at_ms: at(120) });
  check("agendar a 2 h sí", b1.status === 201 && b1.data.status === "agendado" && b1.data.offer_price === 17, b1);
  const b2 = await post("/bookings", { ...trip, ...R, scheduled_at_ms: at(300) });
  const b3 = await post("/bookings", { ...trip, ...R, scheduled_at_ms: at(400) });
  check("agendar 2 más", b2.status === 201 && b3.status === 201, [b2, b3]);
  const b4 = await post("/bookings", { ...trip, ...R, scheduled_at_ms: at(500) });
  check("más de 3 agendados no", b4.status === 409, b4);

  const mine = await post("/bookings/mine", R);
  check("el pasajero ve sus 3", mine.status === 200 && mine.data.length === 3, mine);

  // --- Choferes ---
  const listA = await post("/bookings/driver", DA);
  const seen = listA.data && listA.data.available.find((x) => x.id === b1.data.id);
  check("el chofer de Tekax lo ve", !!seen, listA);
  check("ve solo el primer nombre", seen && seen.rider_name === "María", seen);
  check("no ve el teléfono", seen && !("rider_phone" in seen) && !JSON.stringify(seen).includes(R.riderPhone), seen);
  check("ubicación aproximada antes de confirmar", seen && seen.pickup_lat === Math.round(T.lat * 1000) / 1000, seen);
  const listT = await post("/bookings/driver", DT);
  check("el taxista no ve un mototaxi", listT.status === 200 && !listT.data.available.some((x) => x.id === b1.data.id), listT);
  check("PIN malo de chofer no", (await post("/bookings/driver", { driverId: A.id, pin: "0000" })).status === 401);

  const takeA = await post(`/bookings/${b1.data.id}/take`, DA);
  check("Pedro confirma", takeA.status === 200, takeA);
  const takeB = await post(`/bookings/${b1.data.id}/take`, DB_);
  check("Juan ya no puede", takeB.status === 409, takeB);
  const taxiTake = await post(`/bookings/${b2.data.id}/take`, DT);
  check("el taxista no puede confirmar un mototaxi", taxiTake.status === 404, taxiTake);
  const listA2 = await post("/bookings/driver", DA);
  const mineA = listA2.data.mine.find((x) => x.id === b1.data.id);
  check("Pedro lo ve en los suyos con la ubicación exacta", mineA && mineA.pickup_lat === T.lat, listA2.data);
  const mine2 = await post("/bookings/mine", R);
  const v1 = mine2.data.find((x) => x.id === b1.data.id);
  check("el pasajero ve a Pedro", v1 && v1.status === "confirmado" && v1.driver && v1.driver.name === "Pedro", v1);

  // Un chofer no confirma dos viajes muy pegados
  const close = await post("/bookings", { ...trip, ...R, scheduled_at_ms: at(140) });
  // (ya tiene 3; cancela b3 para poder probarlo)
  check("cuarto sigue bloqueado", close.status === 409, close);
  const c3 = await post(`/bookings/${b3.data.id}/cancel`, R);
  check("pasajero cancela uno", c3.status === 200, c3);
  check("no se cancela dos veces", (await post(`/bookings/${b3.data.id}/cancel`, R)).status === 409);
  const b5 = await post("/bookings", { ...trip, ...R, scheduled_at_ms: at(140) });
  check("agenda otro a 2 h 20", b5.status === 201, b5);
  const gap = await post(`/bookings/${b5.data.id}/take`, DA);
  check("Pedro no confirma otro a 20 min del suyo", gap.status === 409, gap);

  // Pedro suelta, Juan lo toma
  const rel = await post(`/bookings/${b1.data.id}/release`, DA);
  check("Pedro suelta el viaje", rel.status === 200, rel);
  check("vuelve a agendado", (await getBooking(b1.data.id)).status === "agendado");
  const takeB2 = await post(`/bookings/${b1.data.id}/take`, DB_);
  check("Juan lo confirma", takeB2.status === 200, takeB2);
  check("Pedro ya no lo suelta (no es suyo)", (await post(`/bookings/${b1.data.id}/release`, DA)).status === 404);

  // --- Sale solo cerca de la hora ---
  // b1 (confirmado por Juan) a 10 min → se asigna a Juan.
  // b5 (sin chofer) a 5 min → sale a todos.
  await setWhen(b1.data.id, at(10));
  await setWhen(b5.data.id, at(5));
  const l1 = await waitFor(async () => { const b = await getBooking(b1.data.id); return b.status === "lanzado" ? b : null; });
  check("el confirmado salió solo", !!l1, await getBooking(b1.data.id));
  if (l1) {
    const ride = await db.prepare("SELECT * FROM rides WHERE id = ?").get(l1.ride_id);
    check("viaje ya aceptado por Juan al precio ofrecido", ride && ride.status === "aceptado" && ride.driver_id === B.id && ride.agreed_price === 17 && ride.booking_id === b1.data.id, ride);
    const act = await post("/rides/active", DB_);
    check("a Juan le sale como viaje en curso", act.status === 200 && act.data && act.data.id === l1.ride_id, act);
    const m = await post("/bookings/mine", R);
    const v = m.data.find((x) => x.id === b1.data.id);
    check("el pasajero recibe el token para abrir su viaje", v && v.ride && v.ride.id === l1.ride_id && v.ride.token === ride.share_token, v);
    const get = await api("GET", `/rides/${l1.ride_id}?t=${ride.share_token}`);
    check("el pasajero abre el viaje con el chofer", get.status === 200 && get.data.driver && get.data.driver.id === B.id, get);
  }
  const l5 = await waitFor(async () => { const b = await getBooking(b5.data.id); return b.status === "lanzado" ? b : null; });
  check("el que no tenía chofer salió solo", !!l5, await getBooking(b5.data.id));
  if (l5) {
    const ride = await db.prepare("SELECT * FROM rides WHERE id = ?").get(l5.ride_id);
    check("sale como viaje buscando chofer", ride && ride.status === "buscando" && ride.driver_id == null && ride.offer_price === 17, ride);
    const acc = await post(`/rides/${l5.ride_id}/accept`, DA);
    check("Pedro lo acepta como viaje normal", acc.status === 200, acc);
  }

  // Confirmado pero el chofer ya trae otro viaje → sale a todos
  const b6 = await post("/bookings", { ...trip, ...R, scheduled_at_ms: at(600) });
  check("agenda otro", b6.status === 201, b6);
  check("Pedro lo confirma", (await post(`/bookings/${b6.data.id}/take`, DA)).status === 200);
  await setWhen(b6.data.id, at(10));
  const l6 = await waitFor(async () => { const b = await getBooking(b6.data.id); return b.status === "lanzado" ? b : null; });
  if (l6) {
    const ride = await db.prepare("SELECT * FROM rides WHERE id = ?").get(l6.ride_id);
    check("Pedro ocupado: sale a todos", ride && ride.status === "buscando", ride);
    await post(`/rides/${l6.ride_id}/cancel`, { riderPhone: R.riderPhone, riderPin: R.riderPin });
  } else check("el de Pedro ocupado salió", false, await getBooking(b6.data.id));

  // Se pasó la hora sin salir (servidor apagado) → vencido
  const b7 = await post("/bookings", { ...trip, ...R, scheduled_at_ms: at(700) });
  await setWhen(b7.data.id, Date.now() - 30 * MIN);
  const l7 = await waitFor(async () => { const b = await getBooking(b7.data.id); return b.status === "vencido" ? b : null; });
  check("el que ya pasó queda vencido", !!l7, await getBooking(b7.data.id));

  // Limpieza: terminar los viajes abiertos de la prueba
  for (const b of [l1, l5]) if (b) await post(`/rides/${b.ride_id}/cancel`, { riderPhone: R.riderPhone, riderPin: R.riderPin });
  check("cancelar el viaje ya salido no se hace desde la agenda", (await post(`/bookings/${b1.data.id}/cancel`, R)).status === 409);

  console.log(fail ? `✗ ${fail} mal, ${pass} bien` : `✓ ${pass} bien`);
  await db.close();
  process.exit(fail ? 1 : 0);
}

main().catch(async (e) => {
  console.error("✗ Error:", e);
  try { await db.close(); } catch {}
  process.exit(1);
});
