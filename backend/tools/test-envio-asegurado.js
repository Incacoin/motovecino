// Prueba "Asegurar chofer" para envíos de negocio (13-nov-2026).
// El negocio aparta un chofer para cuando su pedido esté listo; el chofer lo
// asegura en "Viajes agendados"; a la hora le llega solo, ya aceptado.
// Uso: node tools/test-envio-asegurado.js (servidor local con BOOKING_SWEEP_MS bajo)
const path = require("node:path");
try { process.loadEnvFile(path.join(__dirname, "..", ".env")); } catch {}

const BASE = process.env.BASE || "http://localhost:3077";
if (!/^https?:\/\/(localhost|127\.0\.0\.1)[:/]/.test(BASE)) throw new Error("Esto solo se corre en localhost: " + BASE);
const db = require("../db");
const ADMIN = process.env.ADMIN_PIN;
const T = { lat: 20.2071, lng: -89.2809 }; // Tekax
const MIN = 60 * 1000;
const JPG = "data:image/jpeg;base64,/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/wAALCAABAAEBAREA/8QAFAABAAAAAAAAAAAAAAAAAAAACf/EABQQAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQEAAD8AKp//2Q==";

let pass = 0, fail = 0;
function check(label, cond, extra) {
  if (cond) pass++;
  else { fail++; console.log("✗", label, extra !== undefined ? JSON.stringify(extra).slice(0, 300) : ""); }
}
async function post(url, body) {
  const res = await fetch(BASE + "/api" + url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  let data = null; try { data = await res.json(); } catch {}
  return { status: res.status, data };
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(fn, ms = 20000) {
  const end = Date.now() + ms;
  while (Date.now() < end) { const v = await fn(); if (v) return v; await sleep(500); }
  return null;
}
const stamp = String(Date.now()).slice(-6);
const phone = (p) => (p + stamp).slice(0, 10);
const getBooking = (id) => db.prepare("SELECT * FROM ride_bookings WHERE id = ?").get(id);
const at = (min) => Date.now() + min * MIN;
const dest = { dest_lat: T.lat + 0.006, dest_lng: T.lng + 0.003, dest_label: "Calle 50 x 47, casa azul" };

async function main() {
  // --- Negocio, choferes y cliente ---
  await post("/admin/food/enabled", { adminPin: ADMIN, enabled: true });
  const owner = (await post("/riders/register", { name: "Dueño Taquería", phone: phone("9951") })).data;
  const save = await post("/admin/businesses/save", { adminPin: ADMIN, name: `Taquería Envío ${stamp}`, phone: owner.phone, lat: T.lat + 0.001, lng: T.lng - 0.001, address: "Calle 53" });
  check("alta negocio", save.status === 200, save);
  const O = { phone: owner.phone, pin: owner.pin };
  await post("/business/profile/save", { ...O, whatsapp: "9990001234", category: "Comida", pay_bank: "BBVA", pay_account: "012790001234567890", pay_holder: "Ana" });
  await post("/business/open", { ...O, open: true });
  const menu = (await post("/business/menu/save", { ...O, name: "Cochinita", price: 40 })).data.menu;
  const coch = menu.find((m) => m.name === "Cochinita");
  const bizId = save.data.id;

  const mk = async (name, ph) => (await post("/admin/drivers", { adminPin: ADMIN, name, phone: ph, acceptedLegal: true, vehicleType: "moto" })).data;
  const A = await mk(`Pedro Envío ${stamp}`, phone("9961"));
  const B = await mk(`Juan Envío ${stamp}`, phone("9962"));
  check("choferes creados", A?.id && B?.id, { A, B });
  const DA = { driverId: A.id, pin: A.pin };
  const DB_ = { driverId: B.id, pin: B.pin };
  const client = (await post("/riders/register", { name: "María Cliente", phone: phone("9971") })).data;
  const C = { phone: client.phone, pin: client.pin };

  // --- Envío de WhatsApp: validaciones ---
  const manual = { ...O, ...dest, client_name: "María", order_note: "2 de cochinita" };
  check("no a 5 minutos (mejor pedir ahora)", (await post("/business/bookings", { ...manual, scheduled_at_ms: at(5) })).status === 400);
  check("no a más de 4 horas", (await post("/business/bookings", { ...manual, scheduled_at_ms: at(5 * 60) })).status === 400);
  check("sin nombre del cliente no", (await post("/business/bookings", { ...O, ...dest, scheduled_at_ms: at(30) })).status === 400);
  check("sin destino no", (await post("/business/bookings", { ...O, client_name: "María", scheduled_at_ms: at(30) })).status === 400);
  check("PIN malo no", (await post("/business/bookings", { ...manual, pin: "0000", scheduled_at_ms: at(30) })).status === 401);
  check("un cliente que no es negocio no", (await post("/business/bookings", { ...C, ...dest, client_name: "X", scheduled_at_ms: at(30) })).status === 403);

  // --- Asegurar chofer para dentro de 30 min ---
  const e1 = await post("/business/bookings", { ...manual, scheduled_at_ms: at(30) });
  check("envío apartado", e1.status === 201 && e1.data.status === "agendado" && e1.data.client_name === "María", e1);
  const l1 = await post("/business/bookings/list", O);
  check("el negocio lo ve en su lista", l1.data.some((x) => x.id === e1.data.id && !x.driver), l1.data);
  const mineRider = await post("/bookings/mine", { riderPhone: O.phone, riderPin: O.pin });
  check("no sale en 'Mis viajes agendados' del dueño", mineRider.status === 200 && !mineRider.data.some((x) => x.id === e1.data.id), mineRider.data);
  check("el dueño no lo cancela como pasajero", (await post(`/bookings/${e1.data.id}/cancel`, { riderPhone: O.phone, riderPin: O.pin })).status === 404);

  const listA = await post("/bookings/driver", DA);
  const seen = listA.data.available.find((x) => x.id === e1.data.id);
  check("el chofer lo ve como envío del negocio", seen && seen.kind === "envio" && /Taquería Envío/.test(seen.business_name) && seen.rider_name === "", seen);
  check("el negocio se ve exacto, la casa del cliente aproximada", seen && seen.pickup_lat === T.lat + 0.001 && seen.dest_lat === Math.round(dest.dest_lat * 1000) / 1000 && seen.dest_label === null && seen.client_name === null, seen);
  check("en envíos no hay propuesta de precio", (await post(`/bookings/${e1.data.id}/offer`, { ...DA, price: 30, reason: "lejos" })).status === 400);

  check("Pedro lo asegura", (await post(`/bookings/${e1.data.id}/take`, DA)).status === 200);
  check("Juan ya no", (await post(`/bookings/${e1.data.id}/take`, DB_)).status === 409);
  const l2 = await post("/business/bookings/list", O);
  const v2 = l2.data.find((x) => x.id === e1.data.id);
  check("el negocio ve 'chofer asegurado: Pedro'", v2 && v2.status === "confirmado" && v2.driver?.name === "Pedro", v2);
  const mineA = (await post("/bookings/driver", DA)).data.mine.find((x) => x.id === e1.data.id);
  check("Pedro ya ve la casa exacta, el cliente y el pedido", mineA && mineA.dest_lat === dest.dest_lat && mineA.dest_label === dest.dest_label && mineA.client_name === "María" && mineA.order_note === "2 de cochinita", mineA);

  // Otro envío pegado: a los 10 min no, a los 25 sí (envíos: 20 min de separación).
  const e2 = (await post("/business/bookings", { ...manual, client_name: "Luis", scheduled_at_ms: at(40) })).data;
  const e3 = (await post("/business/bookings", { ...manual, client_name: "Rosa", scheduled_at_ms: at(55) })).data;
  check("muy pegado al otro envío no", (await post(`/bookings/${e2.id}/take`, DA)).status === 409);
  check("con 25 min de diferencia sí", (await post(`/bookings/${e3.id}/take`, DA)).status === 200);

  // --- Llega la hora: le llega solo a Pedro, ya aceptado ---
  await db.prepare("UPDATE ride_bookings SET scheduled_at_ms = ? WHERE id = ?").run(at(8), e1.data.id);
  const s1 = await waitFor(async () => { const b = await getBooking(e1.data.id); return b.status === "lanzado" ? b : null; });
  check("el envío salió a la hora", !!s1, await getBooking(e1.data.id));
  if (s1) {
    const ride = await db.prepare("SELECT * FROM rides WHERE id = ?").get(s1.ride_id);
    check("es un domicilio del negocio, aceptado por Pedro", ride && ride.service_kind === "domicilio" && ride.business_id === bizId && ride.status === "aceptado" && ride.driver_id === A.id && ride.for_name === "María" && ride.for_note === "2 de cochinita", ride);
    check("sin precio inventado (tarifa normal de envío)", ride && ride.offer_price == null && ride.agreed_price == null, ride);
    check("el viaje queda ligado al apartado", ride && ride.booking_id === e1.data.id, ride && ride.booking_id);
    await post(`/rides/${ride.id}/cancel`, { riderPhone: O.phone, riderPin: O.pin });
  }

  // --- Sin chofer: sale a todos 5 min antes ---
  await db.prepare("UPDATE ride_bookings SET scheduled_at_ms = ? WHERE id = ?").run(at(4), e2.id);
  const s2 = await waitFor(async () => { const b = await getBooking(e2.id); return b.status === "lanzado" ? b : null; });
  check("sin chofer asegurado sale a los choferes cercanos", !!s2, await getBooking(e2.id));
  if (s2) {
    const ride = await db.prepare("SELECT * FROM rides WHERE id = ?").get(s2.ride_id);
    check("buscando chofer", ride && ride.status === "buscando" && ride.driver_id == null && ride.for_name === "Luis", ride);
    // Ligado al apartado: no lo cancela el barrido de "nadie lo tomó" al minuto.
    await sleep(3000);
    const still = await db.prepare("SELECT status, booking_id FROM rides WHERE id = ?").get(ride.id);
    check("sigue buscando (ventana de agendados)", still.status === "buscando" && still.booking_id === e2.id, still);
    await post(`/rides/${ride.id}/cancel`, { riderPhone: O.phone, riderPin: O.pin });
  }

  // --- El negocio cancela uno apartado ---
  check("el negocio cancela el de Rosa", (await post(`/business/bookings/${e3.id}/cancel`, O)).status === 200);
  check("ya cancelado no se cancela otra vez", (await post(`/business/bookings/${e3.id}/cancel`, O)).status === 409);
  check("otro negocio no lo puede cancelar", (await post(`/business/bookings/${e1.data.id}/cancel`, C)).status === 403);

  // --- Pedido de la app: asegurar chofer para cuando esté listo ---
  const order = async () => {
    const o = await post("/orders", { ...C, business_id: bizId, items: [{ id: coch.id, n: 1 }], pay_method: "transferencia", receipt: JPG, delivery_offer: 20, ...dest });
    await post(`/business/orders/${o.data.id}/payment`, { ...O, received: true });
    return (await post(`/business/orders/${o.data.id}/accept`, { ...O, minutes: 30 })).data;
  };
  const o1 = await order();
  check("pedido aceptado (listo en 30 min)", o1 && o1.status === "aceptado", o1);
  const p1 = await post("/business/bookings", { ...O, order_id: o1.id, scheduled_at_ms: o1.ready_at_ms });
  check("chofer apartado para el pedido", p1.status === 201 && p1.data.order_id === o1.id && p1.data.client_name === "María Cliente", p1);
  check("solo uno por pedido", (await post("/business/bookings", { ...O, order_id: o1.id, scheduled_at_ms: o1.ready_at_ms })).status === 409);
  const pb = await getBooking(p1.data.id);
  check("con el precio de envío del pedido", pb.offer_price === 20 && pb.for_note === "1 × Cochinita", pb);
  check("Juan lo asegura", (await post(`/bookings/${p1.data.id}/take`, DB_)).status === 200);
  const olist = await post("/business/orders/list", O);
  const ov = (olist.data.orders || olist.data).find?.((x) => x.id === o1.id);
  check("en el pedido se ve 'chofer asegurado: Juan'", ov && ov.booking && ov.booking.status === "confirmado" && ov.booking.driver?.name === "Juan", ov && ov.booking);

  // "Pedir chofer ahora" gana: el apartado se suelta.
  const now1 = await post(`/business/orders/${o1.id}/request-driver`, O);
  check("pedir chofer ahora sí se puede", now1.status === 200 && now1.data.status === "enviado", now1);
  check("y el apartado quedó cancelado", (await getBooking(p1.data.id)).status === "cancelado");
  const ride1 = await db.prepare("SELECT id FROM rides WHERE order_id = ? AND status = 'buscando'").get(o1.id);
  if (ride1) await post(`/rides/${ride1.id}/cancel`, { riderPhone: C.phone, riderPin: C.pin });

  // Otro pedido: lo asegura Juan y a la hora le llega solo.
  const o2 = await order();
  const p2 = (await post("/business/bookings", { ...O, order_id: o2.id, scheduled_at_ms: o2.ready_at_ms })).data;
  check("Juan asegura el segundo pedido", (await post(`/bookings/${p2.id}/take`, DB_)).status === 200);
  await db.prepare("UPDATE ride_bookings SET scheduled_at_ms = ? WHERE id = ?").run(at(8), p2.id);
  const s3 = await waitFor(async () => { const b = await getBooking(p2.id); return b.status === "lanzado" ? b : null; });
  check("el pedido salió solo a la hora", !!s3, await getBooking(p2.id));
  if (s3) {
    const ride = await db.prepare("SELECT * FROM rides WHERE id = ?").get(s3.ride_id);
    check("con Juan, a $20 y ligado al pedido", ride && ride.status === "aceptado" && ride.driver_id === B.id && ride.order_id === o2.id && ride.agreed_price === 20 && ride.cash_to_business === 0, ride);
    const ord = await db.prepare("SELECT status, ride_id FROM business_orders WHERE id = ?").get(o2.id);
    check("el pedido quedó 'enviado' con ese viaje", ord.status === "enviado" && ord.ride_id === ride.id, ord);
    // El viaje de un pedido de la app es del cliente: él lo cancela.
    const c = await post(`/rides/${ride.id}/cancel`, { riderPhone: C.phone, riderPin: C.pin });
    check("limpieza: viaje del pedido cancelado", c.status === 200, c);
  }

  // "Lo entrego yo" también suelta el apartado.
  const o3 = await order();
  const p3 = (await post("/business/bookings", { ...O, order_id: o3.id, scheduled_at_ms: o3.ready_at_ms })).data;
  await post(`/business/orders/${o3.id}/own-delivery`, O);
  check("'lo entrego yo' suelta el chofer apartado", (await getBooking(p3.id)).status === "cancelado");

  // Con su repartidor ya no se aparta chofer, y al entregarlo no queda nada colgado.
  check("pedido 'lo entrego yo' no aparta chofer", (await post("/business/bookings", { ...O, order_id: o3.id, scheduled_at_ms: o3.ready_at_ms })).status === 409);
  check("entregado por su repartidor", (await post(`/business/orders/${o3.id}/delivered`, O)).status === 200);

  // Pasaje y envío del mismo chofer: el espacio largo de los viajes normales.
  const near = (await post("/business/bookings", { ...manual, client_name: "Ana", scheduled_at_ms: at(150) })).data;
  await db.prepare("INSERT INTO ride_bookings (rider_id, city, ride_type, pickup_lat, pickup_lng, dest_lat, dest_lng, passengers, children, offer_price, scheduled_at_ms, reminded, status, driver_id) VALUES (?, ?, 'moto', ?, ?, ?, ?, 1, 0, 20, ?, 1, 'confirmado', ?)")
    .run(client.id, (await getBooking(near.id)).city, T.lat, T.lng, T.lat + 0.01, T.lng, at(125), B.id);
  check("envío a 25 min de un pasaje suyo no", (await post(`/bookings/${near.id}/take`, DB_)).status === 409);
  await db.prepare("UPDATE ride_bookings SET status = 'cancelado' WHERE driver_id = ? AND business_id IS NULL AND status = 'confirmado'").run(B.id);

  // Limpieza
  for (const b of [e1.data, e2, e3, near]) await post(`/business/bookings/${b.id}/cancel`, O);

  console.log(fail ? `✗ ${fail} mal, ${pass} bien` : `✓ ${pass} bien`);
  await db.close();
  process.exit(fail ? 1 : 0);
}

main().catch(async (e) => {
  console.error("✗ Error:", e);
  try { await db.close(); } catch {}
  process.exit(1);
});
