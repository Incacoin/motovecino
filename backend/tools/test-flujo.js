// Prueba de punta a punta contra una app corriendo (NUNCA contra producción:
// crea choferes, pasajeros y viajes de prueba).
//   BASE=http://localhost:3077 node tools/test-flujo.js
// Simula pasajero + mototaxista + taxista por HTTP y WebSocket, y revisa
// cada respuesta.
const path = require("node:path");
const WebSocket = require("ws");
process.loadEnvFile(path.join(__dirname, "..", ".env"));

const BASE = process.env.BASE || "http://localhost:3077";
if (!/^https?:\/\/(localhost|127\.0\.0\.1)[:/]/.test(BASE)) throw new Error("Esto solo se corre en localhost: " + BASE);
const ADMIN = process.env.ADMIN_PIN;
const TEKAX = { lat: 20.2071, lng: -89.2809 };
const near = (dLat, dLng = 0) => ({ lat: TEKAX.lat + dLat, lng: TEKAX.lng + dLng });

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
  const res = await fetch(BASE + "/api" + url, {
    method,
    headers: { "Content-Type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
  let data = null;
  try { data = await res.json(); } catch {}
  return { status: res.status, data };
}
const post = (u, b) => api("POST", u, b);
const get = (u) => api("GET", u);

function driverSocket(driverId, pin) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`${BASE.replace("http", "ws")}/ws?role=driver&driverId=${driverId}&pin=${pin}`);
    ws.msgs = [];
    ws.on("message", (raw) => ws.msgs.push(JSON.parse(raw.toString())));
    ws.on("open", () => resolve(ws));
    ws.on("error", reject);
  });
}
function riderSocket(rideId, t) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`${BASE.replace("http", "ws")}/ws?role=rider&rideId=${rideId}&t=${t}`);
    ws.msgs = [];
    ws.on("message", (raw) => ws.msgs.push(JSON.parse(raw.toString())));
    ws.on("open", () => resolve(ws));
    ws.on("error", reject);
  });
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
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
const PNG = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

async function main() {
  // ---------- Admin: login y alta de choferes ----------
  const login = await post("/admin/login", { adminPin: ADMIN });
  check("admin login", login.status === 200 && login.data.city === "tekax", login);
  const bad = await post("/admin/login", { adminPin: "0000-no" });
  check("admin PIN malo = 401", bad.status === 401);

  const mk = async (name, phone, vehicleType) => {
    const r = await post("/admin/drivers", { adminPin: ADMIN, name, phone, vehicle: "Prueba", acceptedLegal: true, vehicleType, photo: PNG });
    check(`alta chofer ${name}`, r.status === 201 && r.data.pin, r);
    return r.data;
  };
  const moto = await mk(`Moto Prueba ${stamp}`, `99911${stamp}`.slice(0, 10), "moto");
  const moto2 = await mk(`Moto Dos ${stamp}`, `99922${stamp}`.slice(0, 10), "moto");
  const taxi = await mk(`Taxi Prueba ${stamp}`, `99933${stamp}`.slice(0, 10), "taxi");
  const dup = await post("/admin/drivers", { adminPin: ADMIN, name: `Moto Prueba ${stamp}`, phone: "9990009999", acceptedLegal: true });
  check("nombre repetido = 409", dup.status === 409, dup);

  const list = await post("/admin/drivers/list", { adminPin: ADMIN });
  check("lista de choferes", list.status === 200 && list.data.some((d) => d.id === moto.id), list.status);
  const mine = list.data.find((d) => d.id === moto.id);
  check("lista: foto como data URL", mine && String(mine.photo).startsWith("data:image/png"), mine && String(mine.photo).slice(0, 30));
  check("lista: números (no texto)", mine && typeof mine.pending_rides === "number" && typeof mine.credit_balance === "number", mine);

  // ---------- Pasajero ----------
  const riderPhone = `98811${stamp}`.slice(0, 10);
  const reg = await post("/riders/register", { name: "Pasajera Prueba", phone: riderPhone });
  check("registro pasajero", reg.status === 201 && reg.data.pin, reg);
  const rider = reg.data;
  const rlogin = await post("/riders/login", { phone: rider.phone, pin: rider.pin });
  check("login pasajero", rlogin.status === 200 && rlogin.data.id === rider.id, rlogin);
  const rbad = await post("/riders/login", { phone: rider.phone, pin: "0000" });
  check("PIN pasajero malo = 404", rbad.status === 404);
  const home = await post(`/riders/${rider.id}/home`, { phone: rider.phone, pin: rider.pin, lat: 20.21, lng: -89.28, label: "casa azul" });
  check("guardar casa", home.status === 200, home);
  const photo = await post(`/riders/${rider.id}/photo`, { phone: rider.phone, pin: rider.pin, photo: PNG, thumb: PNG });
  check("foto pasajero", photo.status === 200, photo);
  const otherId = await post("/riders/abc/update-name", { phone: rider.phone, pin: rider.pin, name: "X" });
  check("id raro = 404 (no 500)", otherId.status === 404, otherId);

  // ---------- Chofer moto: login, socket, disponible ----------
  const dl = await post("/drivers/login", { phone: moto.phone, pin: moto.pin });
  check("login chofer", dl.status === 200 && dl.data.lifetimeTrips === 0 && dl.data.todayCount === 0, dl);
  const ws1 = await driverSocket(moto.id, moto.pin);
  // Se mandan al instante, mientras el servidor revisa el PIN (deben guardarse y procesarse).
  ws1.send(JSON.stringify({ type: "location", ...near(0.002) }));
  ws1.send(JSON.stringify({ type: "status", status: "disponible" }));
  const ws2 = await driverSocket(moto2.id, moto2.pin);
  ws2.send(JSON.stringify({ type: "location", ...near(0.003) }));
  ws2.send(JSON.stringify({ type: "status", status: "disponible" }));
  await sleep(600);
  const avail = await get(`/drivers/available?lat=${TEKAX.lat}&lng=${TEKAX.lng}`);
  check("choferes disponibles (mensajes tempranos del socket)", avail.status === 200 && avail.data.some((d) => d.id === moto.id) && avail.data.some((d) => d.id === moto2.id), avail.data);

  const wsBad = new WebSocket(`${BASE.replace("http", "ws")}/ws?role=driver&driverId=${moto.id}&pin=0000`);
  const closeCode = await new Promise((r) => wsBad.on("close", (c) => r(c)));
  check("socket con PIN malo se cierra 4004", closeCode === 4004, closeCode);

  // ---------- Viaje de mototaxi completo ----------
  const pick = near(0.001);
  const ride = await post("/rides", {
    rider_phone: rider.phone, rider_pin: rider.pin, pickup_lat: pick.lat, pickup_lng: pick.lng, pickup_label: "Parque",
    dest_lat: TEKAX.lat + 0.01, dest_lng: TEKAX.lng, dest_label: "Mercado", passengers: 2, children: 1, ride_type: "moto", extra: 5,
    rider_lat: 20.9674, rider_lng: -89.5926,
  });
  check("pedir viaje", ride.status === 201 && ride.data.status === "buscando" && ride.data.share_token, ride);
  check("pedido desde lejos (Mérida → Tekax)", ride.data.requested_from_km > 50, ride.data.requested_from_km);
  const R = ride.data;
  const nr = await waitFor(ws1, "new_ride");
  check("chofer recibe new_ride", nr && nr.payload.id === R.id && !nr.payload.rider_phone, nr);
  const rws = await riderSocket(R.id, R.share_token);

  const g = await get(`/rides/${R.id}?t=${R.share_token}`);
  check("ver viaje con token", g.status === 200 && g.data.id === R.id && g.data.riderTripCount === 0, g);
  const g404 = await get(`/rides/${R.id}?t=malo`);
  check("ver viaje con token malo = 404", g404.status === 404);
  const gabc = await get(`/rides/abc?t=x`);
  check("ver viaje id raro = 404", gabc.status === 404, gabc);

  // Doble "aceptar" al mismo tiempo de dos choferes: solo uno gana.
  const [a1, a2] = await Promise.all([
    post(`/rides/${R.id}/accept`, { driverId: moto.id, pin: moto.pin }),
    post(`/rides/${R.id}/accept`, { driverId: moto2.id, pin: moto2.pin }),
  ]);
  check("dos aceptan a la vez: uno 200 y otro 409", [a1.status, a2.status].sort().join() === "200,409", [a1, a2]);
  const winner = a1.status === 200 ? moto : moto2;
  const loserWs = a1.status === 200 ? ws2 : ws1;
  const winnerWs = a1.status === 200 ? ws1 : ws2;
  check("respuesta de aceptar enmascara teléfono", (a1.status === 200 ? a1 : a2).data.rider_phone.startsWith("•••"));
  const acc = await waitFor(rws, "ride_accepted");
  check("pasajero recibe ride_accepted", acc && acc.payload.id === winner.id, acc);
  check("el otro chofer recibe ride_taken", !!(await waitFor(loserWs, "ride_taken")));

  // Mismo chofer no puede tener dos viajes activos.
  const ride2 = await post("/rides", { rider_phone: rider.phone, rider_pin: rider.pin, pickup_lat: pick.lat, pickup_lng: pick.lng, ride_type: "moto" });
  const dbl = await post(`/rides/${ride2.data.id}/accept`, { driverId: winner.id, pin: winner.pin });
  check("chofer ocupado no acepta otro = 409", dbl.status === 409, dbl);
  const c2 = await post(`/rides/${ride2.data.id}/cancel`, { riderPhone: rider.phone, riderPin: rider.pin, reason: "prueba" });
  check("pasajero cancela", c2.status === 200, c2);
  const c2again = await post(`/rides/${ride2.data.id}/cancel`, { riderPhone: rider.phone, riderPin: rider.pin });
  check("cancelar dos veces = 409", c2again.status === 409, c2again);

  const act = await post("/rides/active", { driverId: winner.id, pin: winner.pin });
  check("viaje activo del chofer", act.status === 200 && act.data && act.data.id === R.id, act);

  // Chat con número tapado
  winnerWs.send(JSON.stringify({ type: "chat", text: "mi cel 999 123 4567 ya voy" }));
  const chat = await waitFor(rws, "chat");
  check("chat tapa teléfonos", chat && chat.payload.text.includes("•••") && !chat.payload.text.includes("4567"), chat);
  rws.send(JSON.stringify({ type: "chat", text: "ok gracias" }));
  check("chat del pasajero llega al chofer", !!(await waitFor(winnerWs, "chat")));
  winnerWs.send(JSON.stringify({ type: "location", ...near(0.0015) }));
  check("ubicación llega al pasajero", !!(await waitFor(rws, "driver_location")));

  const arr = await post(`/rides/${R.id}/arrived`, { driverId: winner.id, pin: winner.pin });
  check("llegué", arr.status === 200 && typeof arr.data.arrivedAt === "number", arr);
  const st = await post(`/rides/${R.id}/start`, { driverId: winner.id, pin: winner.pin });
  check("iniciar", st.status === 200, st);
  const gst = await get(`/rides/${R.id}?t=${R.share_token}`);
  check("arrived_at_ms grande se guarda como número", gst.data.arrived_at_ms === arr.data.arrivedAt, [gst.data.arrived_at_ms, arr.data.arrivedAt]);
  const comp = await post(`/rides/${R.id}/complete`, { driverId: winner.id, pin: winner.pin });
  // Tarifa Tekax: 2 adultos × 15 (o 20 de noche / lejos) + niño 5 (10 de noche) + extra 5
  check("completar viaje", comp.status === 200 && comp.data.todayCount === 1 && comp.data.lifetimeTrips === 1, comp);
  check("ganancia de hoy es número > 0", typeof comp.data.todayEarned === "number" && comp.data.todayEarned > 0, comp.data);
  const compAgain = await post(`/rides/${R.id}/complete`, { driverId: winner.id, pin: winner.pin });
  check("completar dos veces = 409", compAgain.status === 409);
  const rate = await post(`/rides/${R.id}/rate`, { rating: 1, riderPhone: rider.phone, riderPin: rider.pin });
  check("calificar", rate.status === 200, rate);
  const rate2 = await post(`/rides/${R.id}/rate`, { rating: 0, riderPhone: rider.phone, riderPin: rider.pin });
  check("calificar dos veces = 409", rate2.status === 409);

  const prof = await post("/drivers/profile", { phone: winner.phone, pin: winner.pin });
  check("perfil del chofer", prof.status === 200, prof);
  const p = prof.data;
  check("perfil: viajes y ganancias", p.lifetimeTrips === 1 && p.tripsMonth === 1 && p.ratingPct === 100 && p.earnings.today.trips === 1 && p.earnings.today.total === comp.data.todayEarned, p);
  check("perfil: semana y mes", p.earnings.week.trips === 1 && p.earnings.month.trips === 1 && p.earnings.allTrips === 1, p.earnings);
  check("perfil: cuota pendiente $2", p.pendingRides === 1 && p.pendingRidesAmount === 2, [p.pendingRides, p.pendingRidesAmount]);
  check("perfil: código de invitación", /^[A-Z0-9]{6}$/.test(p.invite.code), p.invite);
  check("perfil: promo de invitación", p.invite.promo && typeof p.invite.promo.active === "boolean", p.invite.promo);

  const inv = await get(`/drivers/invite/${p.invite.code}`);
  check("link de invitación", inv.status === 200 && inv.data.name, inv);

  // ---------- Admin: cobro de cuotas ----------
  const pf = await post(`/admin/drivers/${winner.id}/pending-fees`, { adminPin: ADMIN });
  check("admin: cuotas pendientes", pf.status === 200 && pf.data.count === 1 && pf.data.amount === 2, pf);
  const [f1, f2] = await Promise.all([
    post(`/admin/drivers/${winner.id}/register-trip-fees`, { adminPin: ADMIN }),
    post(`/admin/drivers/${winner.id}/register-trip-fees`, { adminPin: ADMIN }),
  ]);
  const okCount = [f1, f2].filter((x) => x.status === 200).length;
  check("cobrar dos veces a la vez: solo uno cobra", okCount === 1, [f1, f2]);
  const pays = await post(`/admin/drivers/${winner.id}/payments`, { adminPin: ADMIN });
  check("un solo pago registrado", pays.status === 200 && pays.data.length === 1 && pays.data[0].amount === 2, pays.data);
  const act7 = await post(`/admin/drivers/${winner.id}/activity`, { adminPin: ADMIN });
  check("actividad del chofer", act7.status === 200 && act7.data.daysConnected7d >= 1, act7);

  const stats = await post("/admin/stats", { adminPin: ADMIN });
  check("admin: resumen", stats.status === 200 && typeof stats.data.ridesToday === "number" && stats.data.ridesToday >= 1, stats);
  check("admin: top choferes", Array.isArray(stats.data.topDrivers) && stats.data.topDrivers.length >= 1 && typeof stats.data.topDrivers[0].rides === "number", stats.data.topDrivers);
  const rep = await post("/admin/reports/cancelaciones", { adminPin: ADMIN });
  check("admin: reporte cancelaciones", rep.status === 200 && Array.isArray(rep.data.porChofer), rep);
  const rl = await post("/admin/rides/list", { adminPin: ADMIN });
  check("admin: lista de viajes", rl.status === 200 && rl.data.some((x) => x.id === R.id), rl.status);
  const rdl = await post("/admin/riders/list", { adminPin: ADMIN });
  check("admin: lista de pasajeros", rdl.status === 200 && rdl.data.some((x) => x.id === rider.id && x.trips === 1), rdl.status);
  const apps = await post("/admin/chofer-solicitudes/list", { adminPin: ADMIN });
  check("admin: solicitudes", apps.status === 200 && Array.isArray(apps.data), apps.status);
  const rank = await get("/drivers/ranking");
  check("ranking", rank.status === 200 && Array.isArray(rank.data), rank);

  // ---------- Cancelación del chofer: enfriamiento ----------
  const ride3 = await post("/rides", { rider_phone: rider.phone, rider_pin: rider.pin, pickup_lat: pick.lat, pickup_lng: pick.lng, ride_type: "moto" });
  const a3 = await post(`/rides/${ride3.data.id}/accept`, { driverId: winner.id, pin: winner.pin });
  check("aceptar viaje 3", a3.status === 200, a3);
  const c3 = await post(`/rides/${ride3.data.id}/cancel`, { driverId: winner.id, pin: winner.pin, reason: "El pasajero no llegó" });
  check("chofer cancela con enfriamiento", c3.status === 200 && /^\d{4}-\d\d-\d\d \d\d:\d\d:\d\d$/.test(c3.data.cooldownUntil), c3);
  const rdl2 = await post("/admin/riders/list", { adminPin: ADMIN });
  check("no-show contado al pasajero", rdl2.data.find((x) => x.id === rider.id).no_show_count === 1, rdl2.data.find((x) => x.id === rider.id));

  // ---------- Taxi con ofertas ----------
  const wsT = await driverSocket(taxi.id, taxi.pin);
  wsT.send(JSON.stringify({ type: "location", ...near(0.004) }));
  wsT.send(JSON.stringify({ type: "status", status: "disponible" }));
  await sleep(400);
  const sug = await get(`/taxi/suggest?plat=${TEKAX.lat}&plng=${TEKAX.lng}&dlat=20.3028&dlng=-89.4180`);
  check("precio sugerido taxi", sug.status === 200, sug);
  const tr = await post("/rides", {
    rider_phone: rider.phone, rider_pin: rider.pin, pickup_lat: pick.lat, pickup_lng: pick.lng,
    dest_lat: 20.3028, dest_lng: -89.4180, ride_type: "taxi", offer_price: 250,
  });
  check("pedir taxi con oferta", tr.status === 201 && tr.data.offer_price === 250, tr);
  check("taxista recibe el viaje", !!(await waitFor(wsT, "new_ride")));
  const trws = await riderSocket(tr.data.id, tr.data.share_token);
  const wrongPrice = await post(`/rides/${tr.data.id}/accept`, { driverId: taxi.id, pin: taxi.pin, agreedPrice: 300 });
  check("aceptar con otro precio = 400", wrongPrice.status === 400, wrongPrice);
  const off = await post(`/rides/${tr.data.id}/offer`, { driverId: taxi.id, pin: taxi.pin, price: 300 });
  check("contraoferta", off.status === 201 && off.data.price === 300, off);
  const on = await waitFor(trws, "offer_new");
  check("pasajero ve la contraoferta", on && on.payload.price === 300 && on.payload.expiresInSec > 100, on);
  const gt = await get(`/rides/${tr.data.id}?t=${tr.data.share_token}`);
  check("viaje trae ofertas abiertas", gt.data.offers && gt.data.offers.length === 1, gt.data.offers);
  const off2 = await post(`/rides/${tr.data.id}/offer`, { driverId: taxi.id, pin: taxi.pin, price: 280 });
  check("nueva contraoferta reemplaza", off2.status === 201, off2);
  check("pasajero ve que se quitó la anterior", !!(await waitFor(trws, "offer_removed")));
  const accOff = await post(`/rides/${tr.data.id}/offers/${off2.data.offerId}/accept`, { riderPhone: rider.phone, riderPin: rider.pin });
  check("pasajero acepta la contraoferta", accOff.status === 200 && accOff.data.agreedPrice === 280, accOff);
  check("taxista recibe offer_accepted", !!(await waitFor(wsT, "offer_accepted")));
  const ta = await post(`/rides/${tr.data.id}/arrived`, { driverId: taxi.id, pin: taxi.pin });
  const ts = await post(`/rides/${tr.data.id}/start`, { driverId: taxi.id, pin: taxi.pin });
  const tw = await post(`/rides/${tr.data.id}/wait`, { driverId: taxi.id, pin: taxi.pin, totalMs: 120000, runningForMs: 5000 });
  check("taxi llegué/iniciar/espera", ta.status === 200 && ts.status === 200 && tw.status === 200, [ta, ts, tw]);
  const tc = await post(`/rides/${tr.data.id}/complete`, { driverId: taxi.id, pin: taxi.pin, agreedPrice: 284 });
  check("completar taxi", tc.status === 200 && tc.data.todayEarned === Math.round((284 - 284 * 0.06) * 100) / 100, tc);
  const tpf = await post(`/admin/drivers/${taxi.id}/pending-fees`, { adminPin: ADMIN });
  check("comisión del taxi 6%", tpf.status === 200 && Math.abs(tpf.data.amount - 284 * 0.06) < 1e-9, tpf.data);
  const tl = await post("/admin/drivers/list", { adminPin: ADMIN });
  const tRow = tl.data.find((d) => d.id === taxi.id);
  check("lista admin: comisión pendiente del taxi", tRow && Math.abs(tRow.pending_fee_amount - 284 * 0.06) < 1e-9, tRow && tRow.pending_fee_amount);

  // ---------- Anticipo del taxi ----------
  const bank = await post("/drivers/bank-account", { phone: taxi.phone, pin: taxi.pin, bank: "BBVA", account: "012345678901234568", holder: "Taxi Prueba" });
  check("cuenta de anticipos", bank.status === 200, bank);
  const tr2 = await post("/rides", { rider_phone: rider.phone, rider_pin: rider.pin, pickup_lat: pick.lat, pickup_lng: pick.lng, dest_lat: 20.3028, dest_lng: -89.4180, ride_type: "taxi", offer_price: 300 });
  const tacc = await post(`/rides/${tr2.data.id}/accept`, { driverId: taxi.id, pin: taxi.pin, agreedPrice: 300, depositAmount: 150 });
  check("aceptar con anticipo", tacc.status === 200 && tacc.data.deposit_status === "pendiente", tacc);
  const rcp = await post(`/rides/${tr2.data.id}/deposit/receipt`, { riderPhone: rider.phone, riderPin: rider.pin, image: PNG.replace("png", "jpeg") });
  check("subir comprobante", rcp.status === 200, rcp);
  const view = await post(`/rides/${tr2.data.id}/deposit/receipt/view`, { driverId: taxi.id, pin: taxi.pin });
  check("chofer ve comprobante", view.status === 200 && view.data.image.startsWith("data:image"), view.status);
  const conf = await post(`/rides/${tr2.data.id}/deposit/confirm`, { driverId: taxi.id, pin: taxi.pin });
  check("confirmar anticipo", conf.status === 200 && conf.data.deposit.status === "confirmado", conf);
  const tp2 = await post("/drivers/profile", { phone: taxi.phone, pin: taxi.pin });
  check("perfil: anticipos confirmados", tp2.data.deposits.count === 1 && tp2.data.deposits.total === 150 && tp2.data.deposits.recent[0].riderName, tp2.data.deposits);
  const tcan = await post(`/rides/${tr2.data.id}/cancel`, { driverId: taxi.id, pin: taxi.pin, reason: "prueba" });
  check("cancelar taxi con anticipo", tcan.status === 200, tcan);

  // ---------- Push ----------
  const pk = await get("/push/public-key");
  check("llave pública push", pk.status === 200 && pk.data.publicKey && pk.data.publicKey.length > 80, pk);
  const sub = await post("/drivers/push/subscribe", { phone: moto.phone, pin: moto.pin, endpoint: "https://fcm.googleapis.com/fcm/send/prueba-" + stamp });
  check("suscribir push chofer", sub.status === 200, sub);

  // ---------- Negocios ----------
  const bizPhone = `97711${stamp}`.slice(0, 10);
  const breg = await post("/riders/register", { name: "Dueño Fonda", phone: bizPhone });
  const bsave = await post("/admin/businesses/save", { adminPin: ADMIN, name: `Fonda ${stamp}`, phone: bizPhone, lat: TEKAX.lat, lng: TEKAX.lng, address: "Centro" });
  check("alta de negocio", bsave.status === 200 && typeof bsave.data.id === "number", bsave);
  const bme = await post("/business/me", { phone: bizPhone, pin: breg.data.pin });
  check("negocio: me", bme.status === 200 && bme.data.business && bme.data.business.id === bsave.data.id, bme);
  const bprof = await post("/business/profile/save", { phone: bizPhone, pin: breg.data.pin, whatsapp: "9971234567", category: "Tacos", tagline: "Ricos" });
  check("negocio: guardar perfil", bprof.status === 200, bprof);
  const bmenu = await post("/business/menu/save", { phone: bizPhone, pin: breg.data.pin, name: "Taco", price: 15 });
  check("negocio: producto", bmenu.status === 200 && bmenu.data.menu.length === 1, bmenu);
  const bride = await post("/business/rides", { phone: bizPhone, pin: breg.data.pin, dest_lat: TEKAX.lat + 0.005, dest_lng: TEKAX.lng, client_name: "Cliente" });
  check("negocio: pedir envío", bride.status === 201 && bride.data.status === "buscando", bride);
  const blist = await post("/business/rides/list", { phone: bizPhone, pin: breg.data.pin });
  check("negocio: lista de envíos", blist.status === 200 && blist.data.rides.length === 1 && blist.data.rides[0].client_name === "Cliente", blist);
  await post(`/rides/${bride.data.id}/cancel`, { riderPhone: bizPhone, riderPin: breg.data.pin });
  const fe = await post("/admin/food/enabled", { adminPin: ADMIN, enabled: true });
  const fb = await get("/food/businesses?city=tekax");
  check("comida: lista con negocio", fe.status === 200 && fb.status === 200 && fb.data.businesses.some((b) => b.id === bsave.data.id), fb);
  await post("/admin/food/enabled", { adminPin: ADMIN, enabled: false });

  // ---------- Pedir para otra persona / aliados ----------
  const fam = await post("/admin/family-rides/enabled", { adminPin: ADMIN, enabled: true });
  const res2 = await get(`/cities/resolve?lat=${TEKAX.lat}&lng=${TEKAX.lng}`);
  check("resolve: familia prendida", fam.status === 200 && res2.data.familyRides === true && res2.data.zone === "in", res2);
  const forOther = await post("/rides", { rider_phone: rider.phone, rider_pin: rider.pin, pickup_lat: pick.lat, pickup_lng: pick.lng, ride_type: "moto", for_name: "Mi hijo", for_note: "gorra roja 9991234567" });
  check("viaje para otra persona", forOther.status === 201 && forOther.data.for_name === "Mi hijo" && !forOther.data.for_note.includes("1234567"), forOther.data);
  await post(`/rides/${forOther.data.id}/cancel`, { riderPhone: rider.phone, riderPin: rider.pin });
  await post("/admin/family-rides/enabled", { adminPin: ADMIN, enabled: false });
  const ads = await post("/admin/ally-ads/save", { adminPin: ADMIN, name: "Aliado", whatsapp: "9971112233", image: PNG });
  check("aliado: guardar", ads.status === 200, ads);
  const adl = await post("/admin/ally-ads/list", { adminPin: ADMIN });
  check("aliado: lista", adl.status === 200 && adl.data.ads.length >= 1 && typeof adl.data.ads[0].views7 === "number", adl);

  // ---------- Viaje fuera de zona ----------
  const far = await post("/rides", { rider_phone: rider.phone, rider_pin: rider.pin, pickup_lat: 19.4, pickup_lng: -99.1, ride_type: "moto" });
  check("fuera de zona = 400", far.status === 400, far);

  // ---------- Cambio de PIN y reseteo ----------
  const cp = await post(`/riders/${rider.id}/change-pin`, { phone: rider.phone, pin: rider.pin });
  check("cambiar PIN", cp.status === 200 && cp.data.pin !== rider.pin, cp);
  const rp = await post(`/admin/drivers/${moto2.id}/reset-pin`, { adminPin: ADMIN });
  check("admin resetea PIN chofer", rp.status === 200 && /^\d{4}$/.test(rp.data.pin), rp);

  // ---------- Borrar chofer (soft) ----------
  const del = await post(`/admin/drivers/${moto2.id}/delete`, { adminPin: ADMIN });
  check("borrar chofer", del.status === 200, del);

  for (const w of [ws1, ws2, wsT, rws, trws]) w.close();
  await sleep(300);
  console.log(`\n${fail ? "✗" : "✓"} ${pass} bien, ${fail} mal`);
  process.exit(fail ? 1 : 0);
}

main().catch((e) => {
  console.error("✗ La prueba se cayó:", e);
  process.exit(1);
});
