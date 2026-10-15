// Pedidos a negocios dentro de la app (11-oct-2026). Cualquier negocio
// (comida, farmacia, abarrotes, papelería...), no solo comida.
//
// Flujo:
//   cliente pide (catálogo o "pedido especial" escrito) → el negocio lo ve en
//   "Mi negocio → Pedidos" → (especial: manda precio y el cliente lo acepta)
//   → el negocio acepta con tiempo de preparación → si fue transferencia,
//   confirma que le llegó → "Pedir chofer": sale un domicilio normal con
//   "Propón tu precio" (el envío que propuso el cliente) y clave de entrega.
//
// El dinero NUNCA pasa por MotoVecino: transferencia directa al negocio, o
// efectivo — el chofer le paga el pedido al negocio al recoger y se lo cobra
// al cliente al entregar (así no da dos vueltas).
const crypto = require("node:crypto");
const express = require("express");
const db = require("../db");
const realtime = require("../realtime");
const { getCityById } = require("../cities");
const { cityMinOffer } = require("../cities");
const { isRateLimited, recordFailedAttempt, clearAttempts, RATE_LIMIT_MESSAGE } = require("../pinRateLimit");

const router = express.Router();

const numericParam = (req, res, next, value) => (/^\d{1,9}$/.test(value) ? next() : res.status(404).json({ error: "No encontrado" }));
router.param("id", numericParam);

const clean = (t, max = 80) => (typeof t === "string" ? t.trim().slice(0, max) : "");
const MAX_RECEIPT_LENGTH = 900000;
const MAX_ITEMS = 40;
const READY_MINUTES = [5, 10, 15, 20, 30, 45, 60];
// Estados del pedido.
const S = {
  COTIZANDO: "cotizando",            // especial: esperando que el negocio mande precio
  POR_ACEPTAR: "por_aceptar_precio", // especial: el cliente decide si acepta el precio
  NUEVO: "nuevo",                    // listo para que el negocio lo acepte
  ACEPTADO: "aceptado",              // preparando
  ENVIADO: "enviado",                // ya se pidió chofer
  RECHAZADO: "rechazado",
  CANCELADO: "cancelado",
};
const OPEN_FOR_CLIENT_CANCEL = [S.COTIZANDO, S.POR_ACEPTAR, S.NUEVO];

async function foodEnabled(city) {
  const row = await db.prepare("SELECT enabled FROM food_settings WHERE city = ?").get(city);
  return !!(row && row.enabled);
}

async function authRider(req, res) {
  if (isRateLimited(req.ip)) {
    res.status(429).json({ error: RATE_LIMIT_MESSAGE });
    return null;
  }
  const { phone, pin } = req.body || {};
  const rider = phone && pin ? await db.prepare("SELECT id, name, phone FROM riders WHERE phone = ? AND pin = ?").get(phone, pin) : null;
  if (!rider) {
    recordFailedAttempt(req.ip);
    res.status(401).json({ error: "Teléfono o PIN incorrectos" });
    return null;
  }
  clearAttempts(req.ip);
  return rider;
}

async function authOwner(req, res) {
  const rider = await authRider(req, res);
  if (!rider) return null;
  const business = await db.prepare("SELECT * FROM businesses WHERE rider_id = ? AND active = 1").get(rider.id);
  if (!business) {
    res.status(403).json({ error: "Esta cuenta no es de un negocio" });
    return null;
  }
  return business;
}

// Lo mínimo de envío (con la cuota de la app), igual que "Propón tu precio".
function minDelivery(city) {
  return cityMinOffer(getCityById(city), 1, 0) || 10;
}

function canTransfer(b) {
  return !!(b.accepts_transfer && b.pay_account);
}

// Efectivo: si el negocio lo acepta, el pedido no pasa su tope y el cliente
// ya terminó al menos un viaje (cuenta con historial).
async function cashProblem(b, total, rider) {
  if (!b.accepts_cash) return "Este negocio no acepta efectivo";
  if (total != null && total > b.cash_cap) return `En efectivo, máximo $${b.cash_cap}. Paga por transferencia.`;
  const { n } = await db.prepare("SELECT COUNT(*) AS n FROM rides WHERE rider_id = ? AND status = 'completado'").get(rider.id);
  if (!n) return "El efectivo se activa después de tu primer viaje. Paga por transferencia.";
  return null;
}

function validReceipt(r) {
  return typeof r === "string" && /^data:image\/(jpeg|png|webp);base64,/.test(r) && r.length <= MAX_RECEIPT_LENGTH;
}

function parseItems(o) {
  try { return JSON.parse(o.items || "[]"); } catch { return []; }
}

function summary(o) {
  if (o.kind === "especial") return clean(o.special_text, 80).replace(/\s*\n\s*/g, ", ");
  return parseItems(o).map((i) => `${i.n} × ${i.name}`).join(", ").slice(0, 80);
}

// Lo que ven cliente y negocio de un pedido (sin el comprobante: es pesado y
// trae datos bancarios; se pide aparte).
async function publicOrder(o, viewer) {
  const b = await db.prepare("SELECT id, name, lat, lng, address, whatsapp, pay_bank, pay_account, pay_holder FROM businesses WHERE id = ?").get(o.business_id);
  const ride = o.ride_id ? await db.prepare("SELECT id, status, share_token, agreed_price, offer_price, driver_id FROM rides WHERE id = ?").get(o.ride_id) : null;
  const driver = ride && ride.driver_id ? await db.prepare("SELECT name, vehicle FROM drivers WHERE id = ?").get(ride.driver_id) : null;
  const client = await db.prepare("SELECT name, phone FROM riders WHERE id = ?").get(o.rider_id);
  const chatUnread = await unreadCount(o.business_id, o.rider_id, viewer === "business" ? "negocio" : "cliente");
  return {
    chat_unread: chatUnread,
    id: o.id,
    status: o.status,
    kind: o.kind,
    items: parseItems(o),
    special_text: o.special_text,
    big: !!o.big,
    total: o.total,
    business_note: o.business_note,
    pay_method: o.pay_method,
    has_receipt: !!o.receipt,
    paid_confirmed: !!o.paid_confirmed_at,
    payment_problem: !!o.payment_problem_at,
    delivery_offer: o.delivery_offer,
    dest_lat: o.dest_lat, dest_lng: o.dest_lng, dest_label: o.dest_label,
    ready_minutes: o.ready_minutes,
    accepted_at: o.accepted_at,
    // Cronómetro: a qué hora (ms) estará listo, y la hora del servidor para
    // que el celular corrija si su reloj va adelantado o atrasado.
    ready_at_ms: o.accepted_at && o.ready_minutes ? Date.parse(String(o.accepted_at).replace(" ", "T") + "Z") + o.ready_minutes * 60000 : null,
    server_now_ms: Date.now(),
    client_note: o.client_note || null,
    reject_reason: o.reject_reason,
    created_at: o.created_at,
    business: b ? { id: b.id, name: b.name, address: b.address, whatsapp: b.whatsapp } : null,
    // La cuenta solo se le enseña al cliente cuando ya puede pagar.
    pay_to: viewer === "client" && b && b.pay_account && [S.POR_ACEPTAR, S.NUEVO, S.ACEPTADO].includes(o.status)
      ? { bank: b.pay_bank, account: b.pay_account, holder: b.pay_holder } : null,
    client: viewer === "business" && client ? { id: o.rider_id, name: client.name } : undefined,
    ride: ride ? {
      id: ride.id, status: ride.status,
      // El token es solo del cliente (con él ve su clave de entrega).
      share_token: viewer === "client" ? ride.share_token : undefined,
      price: ride.agreed_price || ride.offer_price,
      driver: driver ? { name: driver.name, vehicle: driver.vehicle } : null,
    } : null,
  };
}

// ---------- Cliente ----------

// Lo que el cliente necesita para armar su pedido: formas de pago y envío mínimo.
router.get("/orders/options/:id", async (req, res) => {
  const b = await db.prepare("SELECT * FROM businesses WHERE id = ? AND active = 1").get(Number(req.params.id));
  if (!b || !await foodEnabled(b.city)) return res.status(404).json({ error: "Negocio no encontrado" });
  res.json({
    catalog: !!b.catalog_enabled,
    special: !!b.special_enabled,
    transfer: canTransfer(b),
    cash: !!b.accepts_cash,
    cash_cap: b.cash_cap,
    min_delivery: minDelivery(b.city),
    is_open: !!b.is_open,
  });
});

router.post("/orders", async (req, res) => {
  const rider = await authRider(req, res);
  if (!rider) return;
  const b = await db.prepare("SELECT * FROM businesses WHERE id = ? AND active = 1").get(Number(req.body.business_id));
  if (!b || !await foodEnabled(b.city)) return res.status(404).json({ error: "Negocio no encontrado" });
  if (!b.is_open) return res.status(409).json({ error: "El negocio está cerrado ahorita" });
  if (b.rider_id === rider.id) return res.status(400).json({ error: "No puedes pedirle a tu propio negocio" });

  const destLat = Number(req.body.dest_lat), destLng = Number(req.body.dest_lng);
  if (!Number.isFinite(destLat) || !Number.isFinite(destLng)) return res.status(400).json({ error: "Marca a dónde te lo llevamos" });
  const offer = Math.round(Number(req.body.delivery_offer));
  const min = minDelivery(b.city);
  if (!(offer >= min) || offer > 2000) return res.status(400).json({ error: `El envío mínimo es $${min}` });

  const { n: open } = await db.prepare(
    `SELECT COUNT(*) AS n FROM business_orders WHERE rider_id = ? AND status IN ('${S.COTIZANDO}', '${S.POR_ACEPTAR}', '${S.NUEVO}')`
  ).get(rider.id);
  if (open >= 3) return res.status(429).json({ error: "Ya tienes 3 pedidos esperando respuesta" });

  const kind = req.body.kind === "especial" ? "especial" : "catalogo";
  let items = null, total = null, special = null, status;
  if (kind === "catalogo") {
    if (!b.catalog_enabled) return res.status(400).json({ error: "Este negocio solo recibe pedidos especiales" });
    const wanted = (Array.isArray(req.body.items) ? req.body.items : []).slice(0, MAX_ITEMS);
    const lines = [];
    for (const w of wanted) {
      const qty = Math.round(Number(w && w.n));
      if (!(qty >= 1 && qty <= 50)) continue;
      // Precio y nombre salen de la base, nunca de lo que mande el celular.
      const item = await db.prepare("SELECT id, name, price FROM menu_items WHERE id = ? AND business_id = ? AND deleted_at IS NULL AND available = 1").get(Number(w.id), b.id);
      if (!item) return res.status(409).json({ error: "Uno de los productos ya no está disponible" });
      lines.push({ id: item.id, name: item.name, price: item.price, n: qty });
    }
    if (!lines.length) return res.status(400).json({ error: "Tu pedido está vacío" });
    items = JSON.stringify(lines);
    total = lines.reduce((a, l) => a + l.price * l.n, 0);
    status = S.NUEVO;
  } else {
    if (!b.special_enabled) return res.status(400).json({ error: "Este negocio no recibe pedidos especiales" });
    special = clean(req.body.special_text, 500);
    if (special.length < 3) return res.status(400).json({ error: "Escribe lo que necesitas" });
    status = S.COTIZANDO;
  }

  // Catálogo: el pago se elige al pedir. Especial: cuando el cliente acepta el precio.
  let payMethod = null, receipt = null;
  if (kind === "catalogo") {
    payMethod = req.body.pay_method === "efectivo" ? "efectivo" : "transferencia";
    if (payMethod === "efectivo") {
      const why = await cashProblem(b, total, rider);
      if (why) return res.status(400).json({ error: why });
    } else {
      if (!canTransfer(b)) return res.status(400).json({ error: "Este negocio no tiene cuenta para transferencia" });
      if (!validReceipt(req.body.receipt)) return res.status(400).json({ error: "Sube la foto de tu comprobante" });
      receipt = req.body.receipt;
    }
  }

  const r = await db.prepare(
    `INSERT INTO business_orders (business_id, rider_id, city, kind, items, special_text, big, total, pay_method, receipt, receipt_at,
       delivery_offer, dest_lat, dest_lng, dest_label, status, client_note)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    b.id, rider.id, b.city, kind, items, special, req.body.big ? 1 : 0, total, payMethod, receipt, receipt ? new Date().toISOString() : null,
    offer, destLat, destLng, clean(req.body.dest_label) || null, status, clean(req.body.client_note, 140) || null
  );
  const o = await db.prepare("SELECT * FROM business_orders WHERE id = ?").get(r.lastInsertRowid);
  res.status(201).json(await publicOrder(o, "client"));
});

router.post("/orders/mine", async (req, res) => {
  const rider = await authRider(req, res);
  if (!rider) return;
  const rows = await db.prepare(
    "SELECT * FROM business_orders WHERE rider_id = ? AND created_at >= datetime('now', '-2 days') ORDER BY id DESC LIMIT 20"
  ).all(rider.id);
  res.json(await Promise.all(rows.map((o) => publicOrder(o, "client"))));
});

async function clientOrder(req, res) {
  const rider = await authRider(req, res);
  if (!rider) return null;
  const o = await db.prepare("SELECT * FROM business_orders WHERE id = ? AND rider_id = ?").get(Number(req.params.id), rider.id);
  if (!o) { res.status(404).json({ error: "Pedido no encontrado" }); return null; }
  return { rider, o };
}

// Especial: el cliente acepta el precio y elige cómo paga.
router.post("/orders/:id/accept-price", async (req, res) => {
  const got = await clientOrder(req, res);
  if (!got) return;
  const { rider, o } = got;
  if (o.status !== S.POR_ACEPTAR) return res.status(409).json({ error: "Este pedido ya no está esperando tu respuesta" });
  const b = await db.prepare("SELECT * FROM businesses WHERE id = ?").get(o.business_id);
  const payMethod = req.body.pay_method === "efectivo" ? "efectivo" : "transferencia";
  let receipt = null;
  if (payMethod === "efectivo") {
    const why = await cashProblem(b, o.total, rider);
    if (why) return res.status(400).json({ error: why });
  } else {
    if (!canTransfer(b)) return res.status(400).json({ error: "Este negocio no tiene cuenta para transferencia" });
    if (!validReceipt(req.body.receipt)) return res.status(400).json({ error: "Sube la foto de tu comprobante" });
    receipt = req.body.receipt;
  }
  const r = await db.prepare(
    `UPDATE business_orders SET status = ?, pay_method = ?, receipt = ?, receipt_at = ?, updated_at = datetime('now') WHERE id = ? AND status = ?`
  ).run(S.NUEVO, payMethod, receipt, receipt ? new Date().toISOString() : null, o.id, S.POR_ACEPTAR);
  if (!r.changes) return res.status(409).json({ error: "Este pedido ya cambió" });
  res.json(await publicOrder(await db.prepare("SELECT * FROM business_orders WHERE id = ?").get(o.id), "client"));
});

// Cambiar el comprobante (p. ej. el negocio dijo "no me ha llegado").
router.post("/orders/:id/receipt", async (req, res) => {
  const got = await clientOrder(req, res);
  if (!got) return;
  const { o } = got;
  if (o.pay_method !== "transferencia" || ![S.NUEVO, S.ACEPTADO].includes(o.status) || o.paid_confirmed_at) {
    return res.status(409).json({ error: "Este pedido no necesita comprobante" });
  }
  if (!validReceipt(req.body.receipt)) return res.status(400).json({ error: "La foto no es válida" });
  await db.prepare("UPDATE business_orders SET receipt = ?, receipt_at = ?, payment_problem_at = NULL, updated_at = datetime('now') WHERE id = ?")
    .run(req.body.receipt, new Date().toISOString(), o.id);
  res.json(await publicOrder(await db.prepare("SELECT * FROM business_orders WHERE id = ?").get(o.id), "client"));
});

router.post("/orders/:id/cancel", async (req, res) => {
  const got = await clientOrder(req, res);
  if (!got) return;
  const { o } = got;
  const r = await db.prepare(
    `UPDATE business_orders SET status = ?, updated_at = datetime('now') WHERE id = ? AND status IN (${OPEN_FOR_CLIENT_CANCEL.map(() => "?").join(", ")})`
  ).run(S.CANCELADO, o.id, ...OPEN_FOR_CLIENT_CANCEL);
  if (!r.changes) return res.status(409).json({ error: "El negocio ya aceptó tu pedido: escríbele si necesitas cambiar algo" });
  res.json({ ok: true });
});

// ---------- Negocio ----------

router.post("/business/orders/list", async (req, res) => {
  const b = await authOwner(req, res);
  if (!b) return;
  const rows = await db.prepare(
    `SELECT * FROM business_orders WHERE business_id = ? AND (created_at >= datetime('now', '-1 days') OR status IN ('${S.COTIZANDO}', '${S.NUEVO}', '${S.ACEPTADO}'))
     ORDER BY CASE WHEN status IN ('${S.COTIZANDO}', '${S.NUEVO}') THEN 0 WHEN status = '${S.ACEPTADO}' THEN 1 ELSE 2 END, id DESC LIMIT 60`
  ).all(b.id);
  res.json(await Promise.all(rows.map((o) => publicOrder(o, "business"))));
});

async function ownerOrder(req, res) {
  const b = await authOwner(req, res);
  if (!b) return null;
  const o = await db.prepare("SELECT * FROM business_orders WHERE id = ? AND business_id = ?").get(Number(req.params.id), b.id);
  if (!o) { res.status(404).json({ error: "Pedido no encontrado" }); return null; }
  return { b, o };
}

async function moveOrder(o, from, sets, params) {
  const r = await db.prepare(`UPDATE business_orders SET ${sets}, updated_at = datetime('now') WHERE id = ? AND status = ?`).run(...params, o.id, from);
  return r.changes > 0;
}

router.post("/business/orders/:id/quote", async (req, res) => {
  const got = await ownerOrder(req, res);
  if (!got) return;
  const { o } = got;
  const total = Math.round(Number(req.body.total));
  if (!(total >= 1 && total <= 20000)) return res.status(400).json({ error: "Escribe el total" });
  if (!await moveOrder(o, S.COTIZANDO, "status = ?, total = ?, business_note = ?", [S.POR_ACEPTAR, total, clean(req.body.note, 140) || null])) {
    return res.status(409).json({ error: "Este pedido ya no espera precio" });
  }
  res.json(await publicOrder(await db.prepare("SELECT * FROM business_orders WHERE id = ?").get(o.id), "business"));
});

router.post("/business/orders/:id/accept", async (req, res) => {
  const got = await ownerOrder(req, res);
  if (!got) return;
  const { o } = got;
  const minutes = Number(req.body.minutes);
  if (!READY_MINUTES.includes(minutes)) return res.status(400).json({ error: "Escoge en cuánto está listo" });
  // Primero el pago: con transferencia no se acepta (ni arranca el
  // cronómetro) hasta que el negocio confirma que le llegó.
  if (o.pay_method === "transferencia" && !o.paid_confirmed_at) {
    return res.status(409).json({ error: "Primero revisa el pago: confirma que te llegó la transferencia" });
  }
  if (!await moveOrder(o, S.NUEVO, "status = ?, ready_minutes = ?, accepted_at = datetime('now')", [S.ACEPTADO, minutes])) {
    return res.status(409).json({ error: "Este pedido ya cambió" });
  }
  res.json(await publicOrder(await db.prepare("SELECT * FROM business_orders WHERE id = ?").get(o.id), "business"));
});

router.post("/business/orders/:id/reject", async (req, res) => {
  const got = await ownerOrder(req, res);
  if (!got) return;
  const { o } = got;
  const reason = clean(req.body.reason, 100) || "El negocio no puede atenderlo";
  const r = await db.prepare(
    `UPDATE business_orders SET status = ?, reject_reason = ?, updated_at = datetime('now') WHERE id = ? AND status IN (?, ?, ?)`
  ).run(S.RECHAZADO, reason, o.id, S.COTIZANDO, S.POR_ACEPTAR, S.NUEVO);
  if (!r.changes) return res.status(409).json({ error: "Este pedido ya cambió" });
  res.json({ ok: true });
});

// El comprobante, para que el negocio lo compare con su app del banco.
router.post("/business/orders/:id/receipt", async (req, res) => {
  const got = await ownerOrder(req, res);
  if (!got) return;
  if (!got.o.receipt) return res.status(404).json({ error: "Sin comprobante" });
  res.json({ receipt: got.o.receipt, at: got.o.receipt_at });
});

router.post("/business/orders/:id/payment", async (req, res) => {
  const got = await ownerOrder(req, res);
  if (!got) return;
  const { o } = got;
  if (o.pay_method !== "transferencia" || ![S.NUEVO, S.ACEPTADO].includes(o.status)) {
    return res.status(409).json({ error: "Este pedido no es por transferencia" });
  }
  if (req.body.received) {
    await db.prepare("UPDATE business_orders SET paid_confirmed_at = datetime('now'), payment_problem_at = NULL, updated_at = datetime('now') WHERE id = ?").run(o.id);
  } else {
    await db.prepare("UPDATE business_orders SET paid_confirmed_at = NULL, payment_problem_at = datetime('now'), updated_at = datetime('now') WHERE id = ?").run(o.id);
  }
  res.json(await publicOrder(await db.prepare("SELECT * FROM business_orders WHERE id = ?").get(o.id), "business"));
});

// "Pedir chofer": sale un domicilio normal a nombre del cliente (él ve el
// mapa, su clave y acepta o no las contraofertas del envío).
router.post("/business/orders/:id/request-driver", async (req, res) => {
  const got = await ownerOrder(req, res);
  if (!got) return;
  const { b, o } = got;
  let canRequest = o.status === S.ACEPTADO;
  if (o.status === S.ENVIADO && o.ride_id) {
    // Si nadie lo tomó (o se canceló el envío), se puede volver a pedir.
    const prev = await db.prepare("SELECT status FROM rides WHERE id = ?").get(o.ride_id);
    canRequest = !prev || prev.status === "cancelado";
  }
  if (!canRequest) return res.status(409).json({ error: "Primero acepta el pedido" });
  if (o.pay_method === "transferencia" && !o.paid_confirmed_at) {
    return res.status(409).json({ error: "Primero confirma que te llegó la transferencia" });
  }
  const client = await db.prepare("SELECT id, name, phone FROM riders WHERE id = ?").get(o.rider_id);
  const cash = o.pay_method === "efectivo" ? o.total : 0;
  const code = String(crypto.randomInt(1, 10000)).padStart(4, "0");
  const ins = await db.prepare(
    `INSERT INTO rides (rider_name, rider_phone, rider_id, pickup_lat, pickup_lng, pickup_label, dest_lat, dest_lng, dest_label,
       passengers, children, ride_type, city, service_kind, share_token, offer_price, extra, for_name, for_note, business_id,
       business_name, order_id, cash_to_business, order_big, delivery_code)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1, 0, 'moto', ?, 'domicilio', ?, ?, 0, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    client.name, client.phone, client.id, b.lat, b.lng, [b.name, b.address].filter(Boolean).join(" · "),
    o.dest_lat, o.dest_lng, o.dest_label, b.city, crypto.randomBytes(16).toString("base64url"), o.delivery_offer,
    client.name, summary(o) || null, b.id, b.name, o.id, cash, o.big, code
  );
  await db.prepare(`UPDATE business_orders SET status = ?, ride_id = ?, updated_at = datetime('now') WHERE id = ?`).run(S.ENVIADO, ins.lastInsertRowid, o.id);
  await db.prepare("UPDATE riders SET last_ride_at = datetime('now') WHERE id = ?").run(client.id);
  const ride = await db.prepare("SELECT * FROM rides WHERE id = ?").get(ins.lastInsertRowid);
  await realtime.broadcastNewRide(ride);
  realtime.startNoDriverTimer(ride.id, ride.ride_type, true);
  res.json(await publicOrder(await db.prepare("SELECT * FROM business_orders WHERE id = ?").get(o.id), "business"));
});

// Formas de pago y de pedido que acepta el negocio (su perfil).
router.post("/business/orders/settings", async (req, res) => {
  const b = await authOwner(req, res);
  if (!b) return;
  const cap = Math.round(Number(req.body.cash_cap));
  if (req.body.cash_cap != null && !(cap >= 50 && cap <= 2000)) return res.status(400).json({ error: "El tope en efectivo va de $50 a $2,000" });
  const catalog = req.body.catalog == null ? !!b.catalog_enabled : !!req.body.catalog;
  const special = req.body.special == null ? !!b.special_enabled : !!req.body.special;
  if (!catalog && !special) return res.status(400).json({ error: "Deja prendido al menos catálogo o pedido especial" });
  await db.prepare(
    `UPDATE businesses SET accepts_transfer = ?, accepts_cash = ?, cash_cap = ?, catalog_enabled = ?, special_enabled = ?, updated_at = datetime('now') WHERE id = ?`
  ).run(
    req.body.transfer == null ? b.accepts_transfer : (req.body.transfer ? 1 : 0),
    req.body.cash == null ? b.accepts_cash : (req.body.cash ? 1 : 0),
    req.body.cash_cap == null ? b.cash_cap : cap,
    catalog ? 1 : 0, special ? 1 : 0, b.id
  );
  const s = await db.prepare("SELECT accepts_transfer, accepts_cash, cash_cap, catalog_enabled, special_enabled, pay_account FROM businesses WHERE id = ?").get(b.id);
  res.json({ transfer: !!s.accepts_transfer, has_account: !!s.pay_account, cash: !!s.accepts_cash, cash_cap: s.cash_cap, catalog: !!s.catalog_enabled, special: !!s.special_enabled });
});

// ---------- Mensajes cliente <-> negocio (14-oct-2026) ----------
// Una conversación por par cliente-negocio. Nadie ve el teléfono del otro y
// queda guardada (sirve si luego hay una queja). Máx. 500 letras por mensaje
// y 60 mensajes al día por cada lado, para que nadie lo use para molestar.
const CHAT_MAX = 500, CHAT_DAY_LIMIT = 60;
async function unreadCount(businessId, riderId, viewerSender) {
  const r = await db.prepare("SELECT COUNT(*) AS n FROM business_chat WHERE business_id = ? AND rider_id = ? AND sender <> ? AND read_at IS NULL")
    .get(businessId, riderId, viewerSender);
  return Number(r && r.n) || 0;
}
async function chatThread(businessId, riderId) {
  const rows = await db.prepare("SELECT id, sender, text, created_at FROM business_chat WHERE business_id = ? AND rider_id = ? ORDER BY id DESC LIMIT 80")
    .all(businessId, riderId);
  return rows.reverse();
}
// Guarda el mensaje (si viene) y marca como leído lo que mandó el otro lado.
async function chatExchange(req, res, businessId, riderId, sender) {
  const text = clean(req.body.text, CHAT_MAX);
  if (text) {
    const day = await db.prepare("SELECT COUNT(*) AS n FROM business_chat WHERE business_id = ? AND rider_id = ? AND sender = ? AND created_at >= datetime('now', '-1 days')")
      .get(businessId, riderId, sender);
    if (Number(day.n) >= CHAT_DAY_LIMIT) { res.status(429).json({ error: "Ya mandaste muchos mensajes hoy. Intenta mañana." }); return null; }
    await db.prepare("INSERT INTO business_chat (business_id, rider_id, sender, text) VALUES (?, ?, ?, ?)").run(businessId, riderId, sender, text);
  }
  await db.prepare("UPDATE business_chat SET read_at = datetime('now') WHERE business_id = ? AND rider_id = ? AND sender <> ? AND read_at IS NULL")
    .run(businessId, riderId, sender);
  return chatThread(businessId, riderId);
}

// Cliente: conversación con un negocio (antes de pedir o de un pedido).
router.post("/orders/chat/:bid", async (req, res) => {
  const rider = await authRider(req, res);
  if (!rider) return;
  const b = await db.prepare("SELECT id, name, whatsapp FROM businesses WHERE id = ? AND active = 1").get(Number(req.params.bid) || 0);
  if (!b) return res.status(404).json({ error: "Negocio no encontrado" });
  const messages = await chatExchange(req, res, b.id, rider.id, "cliente");
  if (!messages) return;
  res.json({ business: { id: b.id, name: b.name, whatsapp: b.whatsapp || null }, messages });
});
// Cliente: sus conversaciones con mensajes nuevos (para el puntito rojo).
router.post("/orders/chats/mine", async (req, res) => {
  const rider = await authRider(req, res);
  if (!rider) return;
  const rows = await db.prepare(
    `SELECT c.business_id, b.name, MAX(c.id) AS last_id,
            SUM(CASE WHEN c.sender = 'negocio' AND c.read_at IS NULL THEN 1 ELSE 0 END) AS unread
     FROM business_chat c JOIN businesses b ON b.id = c.business_id
     WHERE c.rider_id = ? AND c.created_at >= datetime('now', '-3 days')
     GROUP BY c.business_id, b.name ORDER BY last_id DESC LIMIT 20`
  ).all(rider.id);
  res.json(rows.map((r) => ({ business_id: r.business_id, name: r.name, unread: Number(r.unread) || 0 })));
});
// Negocio: conversación con un cliente que ya le pidió o le escribió.
router.post("/business/chat/:rid", async (req, res) => {
  const b = await authOwner(req, res);
  if (!b) return;
  const riderId = Number(req.params.rid) || 0;
  const known = await db.prepare(
    "SELECT 1 AS ok FROM business_orders WHERE business_id = ? AND rider_id = ? UNION SELECT 1 AS ok FROM business_chat WHERE business_id = ? AND rider_id = ? AND sender = 'cliente'"
  ).get(b.id, riderId, b.id, riderId);
  if (!known) return res.status(404).json({ error: "Este cliente no te ha escrito ni pedido" });
  const client = await db.prepare("SELECT name FROM riders WHERE id = ?").get(riderId);
  const messages = await chatExchange(req, res, b.id, riderId, "negocio");
  if (!messages) return;
  res.json({ client: { id: riderId, name: client ? client.name : "Cliente" }, messages });
});
// Negocio: clientes que le escribieron estos días (aunque no hayan pedido).
router.post("/business/chats/list", async (req, res) => {
  const b = await authOwner(req, res);
  if (!b) return;
  const rows = await db.prepare(
    `SELECT c.rider_id, r.name, MAX(c.id) AS last_id,
            SUM(CASE WHEN c.sender = 'cliente' AND c.read_at IS NULL THEN 1 ELSE 0 END) AS unread
     FROM business_chat c JOIN riders r ON r.id = c.rider_id
     WHERE c.business_id = ? AND c.created_at >= datetime('now', '-3 days')
     GROUP BY c.rider_id, r.name ORDER BY last_id DESC LIMIT 30`
  ).all(b.id);
  const out = [];
  for (const r of rows) {
    const last = await db.prepare("SELECT sender, text FROM business_chat WHERE id = ?").get(r.last_id);
    out.push({ rider_id: r.rider_id, name: r.name, unread: Number(r.unread) || 0, last: last ? { sender: last.sender, text: last.text.slice(0, 80) } : null });
  }
  res.json(out);
});

module.exports = router;
module.exports.ORDER_STATUS = S;
