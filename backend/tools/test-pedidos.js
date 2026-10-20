// Pedidos a negocios (11-oct-2026). Solo en localhost:
//   BASE=http://localhost:3093 ADMIN_PIN=... node tools/test-pedidos.js
// Catálogo y pedido especial, transferencia con comprobante y efectivo (el
// chofer paga al negocio al recoger), aceptar/rechazar, confirmar pago y
// "Pedir chofer" → domicilio con Propón tu precio y clave de entrega.
const path = require("node:path");
const WebSocket = require("ws");
try { process.loadEnvFile(path.join(__dirname, "..", ".env")); } catch {}

const BASE = process.env.BASE || "http://localhost:3077";
if (!/^https?:\/\/(localhost|127\.0\.0\.1)[:/]/.test(BASE)) throw new Error("Esto solo se corre en localhost: " + BASE);
const ADMIN = process.env.ADMIN_PIN;
const TEKAX = { lat: 20.2071, lng: -89.2809 };

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
async function get(url) {
  const res = await fetch(BASE + "/api" + url);
  let data = null; try { data = await res.json(); } catch {}
  return { status: res.status, data };
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function driverSocket(id, pin) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`${BASE.replace("http", "ws")}/ws?role=driver&driverId=${id}&pin=${pin}`);
    ws.msgs = [];
    ws.on("message", (raw) => ws.msgs.push(JSON.parse(raw.toString())));
    ws.on("open", () => resolve(ws));
    ws.on("error", reject);
  });
}
const JPG = "data:image/jpeg;base64,/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/wAALCAABAAEBAREA/8QAFAABAAAAAAAAAAAAAAAAAAAACf/EABQQAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQEAAD8AKp//2Q==";
const stamp = String(Date.now()).slice(-6);
const phone = (p) => (p + stamp).slice(0, 10);
const dest = { dest_lat: TEKAX.lat + 0.006, dest_lng: TEKAX.lng + 0.003, dest_label: "Calle 50 x 47" };

async function main() {
  // ---------- Negocio ----------
  await post("/admin/food/enabled", { adminPin: ADMIN, enabled: true });
  const owner = (await post("/riders/register", { name: "Dueña Farmacia", phone: phone("9971") })).data;
  const save = await post("/admin/businesses/save", { adminPin: ADMIN, name: `Farmacia Prueba ${stamp}`, phone: owner.phone, lat: TEKAX.lat + 0.001, lng: TEKAX.lng - 0.001, address: "Calle 53" });
  check("alta negocio", save.status === 200, save);
  const O = { phone: owner.phone, pin: owner.pin };
  await post("/business/profile/save", { ...O, whatsapp: "9990001234", category: "Otro", pay_bank: "BBVA", pay_account: "012790001234567890", pay_holder: "Ana" });
  await post("/business/open", { ...O, open: true });
  await post("/business/menu/save", { ...O, name: "Paracetamol", price: 35 });
  const menu = (await post("/business/menu/save", { ...O, name: "Suero oral", price: 28 })).data.menu;
  const para = menu.find((m) => m.name === "Paracetamol"), suero = menu.find((m) => m.name === "Suero oral");
  const bizId = save.data.id;

  const opts0 = await get(`/orders/options/${bizId}`);
  check("opciones: transferencia sí, efectivo no (por defecto)", opts0.data.transfer === true && opts0.data.cash === false && opts0.data.min_delivery === 17, opts0.data);
  const set = await post("/business/orders/settings", { ...O, cash: true, cash_cap: 100, special: true });
  check("ajustes: efectivo con tope $100 y pedido especial", set.status === 200 && set.data.cash && set.data.cash_cap === 100 && set.data.special, set.data);
  const badSet = await post("/business/orders/settings", { ...O, catalog: false, special: false });
  check("no deja apagar catálogo y especial a la vez", badSet.status === 400, badSet);

  // ---------- Clientes ----------
  const nuevo = (await post("/riders/register", { name: "Cliente Nuevo", phone: phone("9881") })).data;
  const N = { phone: nuevo.phone, pin: nuevo.pin };
  const own = await post("/orders", { ...O, business_id: bizId, items: [{ id: para.id, n: 1 }], pay_method: "transferencia", receipt: JPG, delivery_offer: 17, ...dest });
  check("el dueño no le pide a su propio negocio", own.status === 400, own);
  const lowOffer = await post("/orders", { ...N, business_id: bizId, items: [{ id: para.id, n: 1 }], pay_method: "transferencia", receipt: JPG, delivery_offer: 10, ...dest });
  check("envío menor al mínimo = 400", lowOffer.status === 400, lowOffer);
  const noRec = await post("/orders", { ...N, business_id: bizId, items: [{ id: para.id, n: 1 }], pay_method: "transferencia", delivery_offer: 17, ...dest });
  check("transferencia sin comprobante = 400", noRec.status === 400, noRec);
  const cashNew = await post("/orders", { ...N, business_id: bizId, items: [{ id: para.id, n: 1 }], pay_method: "efectivo", delivery_offer: 17, ...dest });
  check("efectivo a cliente sin viajes = 400", cashNew.status === 400 && /primer viaje/.test(cashNew.data.error), cashNew);

  const t1 = await post("/orders", { ...N, business_id: bizId, items: [{ id: para.id, n: 2, price: 1 }, { id: suero.id, n: 1 }], pay_method: "transferencia", receipt: JPG, delivery_offer: 20, client_note: "Sin caja, por favor", ...dest });
  check("pedido por transferencia creado", t1.status === 201 && t1.data.status === "nuevo", t1);
  check("el total sale de los precios del negocio ($98), no del celular", t1.data.total === 98, t1.data.total);
  check("el cliente ve la cuenta para pagar", t1.data.pay_to && t1.data.pay_to.account === "012790001234567890", t1.data.pay_to);
  check("la nota del cliente se guarda", t1.data.client_note === "Sin caja, por favor", t1.data.client_note);

  // ---------- Negocio atiende ----------
  const list = await post("/business/orders/list", O);
  check("al negocio le llega el pedido", list.status === 200 && list.data.some((o) => o.id === t1.data.id), list.status);
  const other = (await post("/riders/register", { name: "Otro", phone: phone("9972") })).data;
  const intr = await post(`/business/orders/${t1.data.id}/accept`, { phone: other.phone, pin: other.pin, minutes: 10 });
  check("otra cuenta no puede tocar el pedido", intr.status === 403, intr);
  const badMin = await post(`/business/orders/${t1.data.id}/accept`, { ...O, minutes: 7 });
  check("minutos raros = 400", badMin.status === 400, badMin);
  const rec = await post(`/business/orders/${t1.data.id}/receipt`, O);
  check("el negocio ve el comprobante", rec.status === 200 && rec.data.receipt === JPG, rec.status);
  const accUnpaid = await post(`/business/orders/${t1.data.id}/accept`, { ...O, minutes: 10 });
  check("primero el pago: sin confirmarlo no se acepta", accUnpaid.status === 409 && /revisa el pago/.test(accUnpaid.data.error), accUnpaid);
  const early = await post(`/business/orders/${t1.data.id}/request-driver`, O);
  check("sin aceptar no pide chofer", early.status === 409, early);
  const notYet = await post(`/business/orders/${t1.data.id}/payment`, { ...O, received: false });
  check("'no me ha llegado' queda marcado", notYet.data.payment_problem === true, notYet.data);
  const reup = await post(`/orders/${t1.data.id}/receipt`, { ...N, receipt: JPG });
  check("el cliente puede volver a subir comprobante", reup.status === 200 && reup.data.payment_problem === false, reup);
  const paid = await post(`/business/orders/${t1.data.id}/payment`, { ...O, received: true });
  check("'sí me llegó el pago'", paid.data.paid_confirmed === true, paid.data);
  const acc = await post(`/business/orders/${t1.data.id}/accept`, { ...O, minutes: 10 });
  check("aceptar pedido (10 min) ya pagado", acc.status === 200 && acc.data.status === "aceptado" && acc.data.ready_minutes === 10, acc);
  const left = acc.data.ready_at_ms - acc.data.server_now_ms;
  check("cronómetro: listo en ~10 min", left > 9 * 60000 && left <= 10 * 60000 + 2000, left);
  const lateCancel = await post(`/orders/${t1.data.id}/cancel`, N);
  check("ya aceptado: el cliente no lo cancela solo", lateCancel.status === 409, lateCancel);

  // Chofer conectado para ver la solicitud.
  const dr = (await post("/admin/drivers", { adminPin: ADMIN, name: `Repartidor ${stamp}`, phone: phone("9994"), vehicle: "Moto", acceptedLegal: true, vehicleType: "moto" })).data;
  const ws = await driverSocket(dr.id, dr.pin);
  ws.send(JSON.stringify({ type: "location", lat: TEKAX.lat + 0.002, lng: TEKAX.lng }));
  ws.send(JSON.stringify({ type: "status", status: "disponible" }));
  await sleep(400);
  ws.msgs = [];

  const req1 = await post(`/business/orders/${t1.data.id}/request-driver`, O);
  check("pedir chofer", req1.status === 200 && req1.data.status === "enviado" && req1.data.ride, req1);
  check("el negocio no ve el token del viaje", req1.data.ride && req1.data.ride.share_token === undefined);
  await sleep(500);
  const nr = ws.msgs.find((m) => m.type === "new_ride" && m.payload.order_id === t1.data.id);
  check("al chofer le llega el domicilio", !!nr, ws.msgs.map((m) => m.type));
  check("solicitud: pagado (no cobra al negocio), envío $20, sin clave ni token",
    nr && nr.payload.cash_to_business === 0 && nr.payload.offer_price === 20 && nr.payload.delivery_code_required === true && !("delivery_code" in nr.payload) && !("share_token" in nr.payload), nr && nr.payload);
  check("solicitud trae nombre del negocio", nr && /Farmacia Prueba/.test(nr.payload.business_name), nr && nr.payload.business_name);
  const mine = await post("/orders/mine", N);
  const m1 = mine.data.find((o) => o.id === t1.data.id);
  check("el cliente ve su pedido enviado con su viaje", m1 && m1.status === "enviado" && m1.ride && m1.ride.share_token, m1);
  const rideView = await get(`/rides/${m1.ride.id}?t=${m1.ride.share_token}`);
  check("el cliente ve su clave de entrega", rideView.status === 200 && /^\d{4}$/.test(rideView.data.delivery_code), rideView.data && rideView.data.delivery_code);

  // Entrega completa con clave.
  const a = await post(`/rides/${m1.ride.id}/accept`, { driverId: dr.id, pin: dr.pin });
  check("chofer acepta", a.status === 200 && a.data.cash_to_business === 0, a.status);
  await post(`/rides/${m1.ride.id}/arrived`, { driverId: dr.id, pin: dr.pin });
  await post(`/rides/${m1.ride.id}/start`, { driverId: dr.id, pin: dr.pin });
  const done = await post(`/rides/${m1.ride.id}/complete`, { driverId: dr.id, pin: dr.pin, deliveryCode: rideView.data.delivery_code });
  check("entrega con clave", done.status === 200, done);

  // ---------- Efectivo (ahora el cliente ya tiene 1 viaje) ----------
  const big = await post("/orders", { ...N, business_id: bizId, items: [{ id: para.id, n: 3 }], pay_method: "efectivo", delivery_offer: 17, ...dest });
  check("efectivo arriba del tope ($105 > $100) = 400", big.status === 400 && /máximo \$100/.test(big.data.error), big);
  const c1 = await post("/orders", { ...N, business_id: bizId, items: [{ id: para.id, n: 2 }], pay_method: "efectivo", delivery_offer: 17, big: true, ...dest });
  check("pedido en efectivo ($70)", c1.status === 201 && c1.data.pay_method === "efectivo" && c1.data.total === 70, c1);
  await post(`/business/orders/${c1.data.id}/accept`, { ...O, minutes: 5 });
  const payCash = await post(`/business/orders/${c1.data.id}/payment`, { ...O, received: true });
  check("efectivo no usa 'confirmar transferencia'", payCash.status === 409, payCash);
  ws.msgs = [];
  const req2 = await post(`/business/orders/${c1.data.id}/request-driver`, O);
  check("efectivo: pide chofer sin confirmar pago", req2.status === 200, req2);
  await sleep(500);
  const nr2 = ws.msgs.find((m) => m.type === "new_ride" && m.payload.order_id === c1.data.id);
  check("chofer ve: paga $70 al negocio y es pedido grande", nr2 && nr2.payload.cash_to_business === 70 && nr2.payload.order_big === 1, nr2 && nr2.payload);
  const again = await post(`/business/orders/${c1.data.id}/request-driver`, O);
  check("no se pide chofer dos veces", again.status === 409, again);
  // Que no se quede buscando y confunda a las otras pruebas.
  await post(`/rides/${req2.data.ride.id}/cancel`, { riderPhone: N.phone, riderPin: N.pin, reason: "prueba" });
  const retry = await post(`/business/orders/${c1.data.id}/request-driver`, O);
  check("si el envío se canceló, se puede volver a pedir chofer", retry.status === 200 && retry.data.ride.id !== req2.data.ride.id, retry);
  await post(`/rides/${retry.data.ride.id}/cancel`, { riderPhone: N.phone, riderPin: N.pin, reason: "prueba" });

  // ---------- Pedido especial ----------
  const e1 = await post("/orders", { ...N, business_id: bizId, kind: "especial", special_text: "2 cajas de curitas\n1 alcohol", delivery_offer: 17, ...dest });
  check("pedido especial: espera precio", e1.status === 201 && e1.data.status === "cotizando" && e1.data.total == null, e1);
  const accEarly = await post(`/business/orders/${e1.data.id}/accept`, { ...O, minutes: 10 });
  check("no se acepta antes de mandar precio", accEarly.status === 409, accEarly);
  const q = await post(`/business/orders/${e1.data.id}/quote`, { ...O, total: 85, note: "Solo hay alcohol de 250 ml" });
  check("negocio manda precio $85", q.status === 200 && q.data.status === "por_aceptar_precio" && q.data.total === 85, q);
  const strangerAcc = await post(`/orders/${e1.data.id}/accept-price`, { phone: other.phone, pin: other.pin, pay_method: "transferencia", receipt: JPG });
  check("otro cliente no acepta mi precio", strangerAcc.status === 404, strangerAcc);
  const ap = await post(`/orders/${e1.data.id}/accept-price`, { ...N, pay_method: "efectivo" });
  check("cliente acepta precio y paga en efectivo", ap.status === 200 && ap.data.status === "nuevo" && ap.data.pay_method === "efectivo", ap);
  const rej = await post(`/business/orders/${e1.data.id}/reject`, { ...O, reason: "Se acabaron las curitas" });
  check("negocio rechaza", rej.status === 200, rej);
  const mine2 = await post("/orders/mine", N);
  const m2 = mine2.data.find((o) => o.id === e1.data.id);
  check("el cliente ve el rechazo y el motivo", m2 && m2.status === "rechazado" && /curitas/.test(m2.reject_reason), m2);

  const e2 = await post("/orders", { ...N, business_id: bizId, kind: "especial", special_text: "1 termómetro", delivery_offer: 17, ...dest });
  const cancel = await post(`/orders/${e2.data.id}/cancel`, N);
  check("el cliente cancela antes de que acepten", cancel.status === 200, cancel);

  // "Lo entrego yo" (19-oct): el repartidor del negocio lo lleva, sin chofer.
  const p1 = await post("/orders", { ...N, business_id: bizId, items: [{ id: para.id, n: 1 }], pay_method: "transferencia", receipt: JPG, delivery_offer: 20, ...dest });
  const ownEarly = await post(`/business/orders/${p1.data.id}/own-delivery`, O);
  check("propio: no antes de aceptar", ownEarly.status === 409, ownEarly);
  await post(`/business/orders/${p1.data.id}/payment`, { ...O, received: true });
  await post(`/business/orders/${p1.data.id}/accept`, { ...O, minutes: 10 });
  const deliveredEarly = await post(`/business/orders/${p1.data.id}/delivered`, O);
  check("propio: no se marca entregado sin 'Lo entrego yo'", deliveredEarly.status === 409, deliveredEarly);
  ws.msgs = [];
  const ownRes = await post(`/business/orders/${p1.data.id}/own-delivery`, O);
  check("propio: 'Lo entrego yo'", ownRes.status === 200 && ownRes.data.status === "propio" && !ownRes.data.ride, ownRes);
  await sleep(400);
  check("propio: no le llega nada a los choferes", !ws.msgs.some((m) => m.type === "new_ride" && m.payload.order_id === p1.data.id), ws.msgs.map((m) => m.type));
  const ownAgain = await post(`/business/orders/${p1.data.id}/own-delivery`, O);
  check("propio: no se repite", ownAgain.status === 409, ownAgain);
  const stranger = await post(`/business/orders/${p1.data.id}/delivered`, { phone: other.phone, pin: other.pin });
  check("propio: otra cuenta no lo marca entregado", stranger.status === 403 || stranger.status === 404, stranger);
  const pm = (await post("/orders/mine", N)).data.find((o) => o.id === p1.data.id);
  check("propio: el cliente lo ve en camino", pm && pm.status === "propio", pm);
  const listOwn = (await post("/business/orders/list", O)).data.find((o) => o.id === p1.data.id);
  check("propio: sigue en la lista del negocio", listOwn && listOwn.status === "propio", listOwn);
  const dlv = await post(`/business/orders/${p1.data.id}/delivered`, O);
  check("propio: 'Ya se entregó'", dlv.status === 200 && dlv.data.status === "entregado", dlv);
  const pm2 = (await post("/orders/mine", N)).data.find((o) => o.id === p1.data.id);
  check("propio: el cliente lo ve entregado", pm2 && pm2.status === "entregado", pm2);

  // Su repartidor no puede: de "Lo entrego yo" a "Pedir chofer".
  const p2 = await post("/orders", { ...N, business_id: bizId, items: [{ id: suero.id, n: 2 }], pay_method: "transferencia", receipt: JPG, delivery_offer: 20, ...dest });
  await post(`/business/orders/${p2.data.id}/payment`, { ...O, received: true });
  await post(`/business/orders/${p2.data.id}/accept`, { ...O, minutes: 5 });
  await post(`/business/orders/${p2.data.id}/own-delivery`, O);
  const switchDr = await post(`/business/orders/${p2.data.id}/request-driver`, O);
  check("propio → pedir chofer", switchDr.status === 200 && switchDr.data.status === "enviado" && switchDr.data.ride, switchDr);
  const ownAfterRide = await post(`/business/orders/${p2.data.id}/own-delivery`, O);
  check("con chofer buscando ya no pasa a propio", ownAfterRide.status === 409, ownAfterRide);
  await post(`/rides/${switchDr.data.ride.id}/cancel`, { riderPhone: N.phone, riderPin: N.pin, reason: "prueba" });

  // Negocio cerrado.
  await post("/business/open", { ...O, open: false });
  const closed = await post("/orders", { ...N, business_id: bizId, items: [{ id: para.id, n: 1 }], pay_method: "transferencia", receipt: JPG, delivery_offer: 17, ...dest });
  check("negocio cerrado = 409", closed.status === 409, closed);

  ws.close();
  console.log(`\n${fail ? "✗" : "✓"} ${pass} bien, ${fail} mal`);
  process.exit(fail ? 1 : 0);
}
main().catch((e) => { console.error(e); process.exit(1); });
