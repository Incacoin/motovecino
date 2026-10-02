// Mi negocio (2-oct): el negocio pide chofer para entregar sus pedidos. La
// cuenta es la de pasajero de su dueño (mismo teléfono y PIN), marcada como
// negocio por el admin (tabla businesses en db.js). El envío sale como un
// viaje de domicilio normal: recoge en el negocio, entrega en la casa del
// cliente, y el chofer cobra solo el envío — la comida ya la pagó el cliente
// al negocio por transferencia, fuera de la app.
const crypto = require("node:crypto");
const express = require("express");
const db = require("../db");
const realtime = require("../realtime");
const { isWithinServiceRadius } = require("../cities");
const { isRateLimited, recordFailedAttempt, clearAttempts, RATE_LIMIT_MESSAGE } = require("../pinRateLimit");
const { checkAdminPin } = require("./admin");
const { saveImage, imageUrl } = require("../menuImages");

const router = express.Router();

const MAX_TEXT = 80;
const clean = (t, max = MAX_TEXT) => (typeof t === "string" ? t.trim().slice(0, max) : "");

// Dueño autenticado con su teléfono y PIN de pasajero + su negocio activo.
// Responde el error y devuelve null si algo no cuadra.
function authBusiness(req, res) {
  if (isRateLimited(req.ip)) {
    res.status(429).json({ error: RATE_LIMIT_MESSAGE });
    return null;
  }
  const { phone, pin } = req.body || {};
  const rider = phone && pin ? db.prepare("SELECT id, name, phone FROM riders WHERE phone = ? AND pin = ?").get(phone, pin) : null;
  if (!rider) {
    recordFailedAttempt(req.ip);
    res.status(401).json({ error: "Teléfono o PIN incorrectos" });
    return null;
  }
  clearAttempts(req.ip);
  const business = db.prepare("SELECT * FROM businesses WHERE rider_id = ? AND active = 1").get(rider.id);
  return { rider, business };
}

function publicBusiness(b) {
  return b
    ? {
        id: b.id, name: b.name, lat: b.lat, lng: b.lng, address: b.address, city: b.city,
        tagline: b.tagline, category: b.category, hours: b.hours, whatsapp: b.whatsapp, is_open: !!b.is_open,
        logo: imageUrl(b.logo), cover: imageUrl(b.cover),
      }
    : null;
}

// Cuenta donde el cliente le transfiere la comida al negocio. No va en la
// lista de negocios: solo sale cuando el cliente abre el negocio para pedir.
function payInfo(b) {
  return { pay_bank: b.pay_bank || null, pay_account: b.pay_account || null, pay_holder: b.pay_holder || null };
}

const BUSINESS_CATEGORIES = ["Antojitos", "Comida", "Tacos", "Pizzas", "Hamburguesas", "Mariscos", "Pollos", "Panadería", "Postres", "Bebidas", "Tienda", "Otro"];

function menuItem(i) {
  return {
    id: i.id, category: i.category, name: i.name, description: i.description,
    price: i.price, available: !!i.available, photo: imageUrl(i.photo),
  };
}
function menuOf(businessId, onlyAvailable) {
  return db
    .prepare(`SELECT * FROM menu_items WHERE business_id = ? AND deleted_at IS NULL ${onlyAvailable ? "AND available = 1" : ""} ORDER BY position, id`)
    .all(businessId)
    .map(menuItem);
}

// ¿Esta cuenta es de un negocio? La app del pasajero lo pregunta al entrar
// para mostrar "Mi negocio" en el menú.
router.post("/business/me", (req, res) => {
  const auth = authBusiness(req, res);
  if (!auth) return;
  res.json({ business: publicBusiness(auth.business) });
});

router.post("/business/rides", (req, res) => {
  const auth = authBusiness(req, res);
  if (!auth) return;
  const { rider, business } = auth;
  if (!business) return res.status(403).json({ error: "Esta cuenta no es de un negocio" });

  const destLat = Number(req.body.dest_lat);
  const destLng = Number(req.body.dest_lng);
  if (!Number.isFinite(destLat) || !Number.isFinite(destLng)) {
    return res.status(400).json({ error: "Marca a dónde va el pedido" });
  }
  const clientName = clean(req.body.client_name, 40);
  if (!clientName) return res.status(400).json({ error: "Escribe el nombre del cliente" });
  if (!isWithinServiceRadius(business.city, business.lat, business.lng, "moto")) {
    return res.status(400).json({ error: "MotoVecino todavía no está disponible en tu zona." });
  }

  db.prepare("UPDATE riders SET last_ride_at = datetime('now') WHERE id = ?").run(rider.id);
  const result = db
    .prepare(
      `INSERT INTO rides (rider_name, rider_phone, rider_id, pickup_lat, pickup_lng, pickup_label, dest_lat, dest_lng, dest_label,
         passengers, children, ride_type, city, service_kind, share_token, extra, for_name, for_note, business_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1, 0, 'moto', ?, 'domicilio', ?, 0, ?, ?, ?)`
    )
    .run(
      business.name,
      rider.phone,
      rider.id,
      business.lat,
      business.lng,
      [business.name, business.address].filter(Boolean).join(" · "),
      destLat,
      destLng,
      clean(req.body.dest_label) || null,
      business.city,
      crypto.randomBytes(16).toString("base64url"),
      clientName,
      clean(req.body.order_note) || null,
      business.id
    );
  const ride = db.prepare("SELECT * FROM rides WHERE id = ?").get(result.lastInsertRowid);
  realtime.broadcastNewRide(ride);
  realtime.startNoDriverTimer(ride.id, ride.ride_type);
  res.status(201).json(listItem(ride));
});

// Lo que ve el negocio de cada envío. El teléfono del chofer va enmascarado,
// igual que en la app del pasajero.
function listItem(r) {
  const driver = r.driver_id ? db.prepare("SELECT name, vehicle, phone FROM drivers WHERE id = ?").get(r.driver_id) : null;
  return {
    id: r.id,
    status: r.status,
    share_token: r.share_token,
    client_name: r.for_name,
    order_note: r.for_note,
    dest_label: r.dest_label,
    dest_lat: r.dest_lat,
    dest_lng: r.dest_lng,
    created_at: r.created_at,
    driver: driver ? { name: driver.name, vehicle: driver.vehicle, phone_tail: String(driver.phone || "").replace(/\D/g, "").slice(-4) } : null,
  };
}

// Envíos de las últimas 24 h: los activos arriba, luego los terminados.
router.post("/business/rides/list", (req, res) => {
  const auth = authBusiness(req, res);
  if (!auth) return;
  if (!auth.business) return res.status(403).json({ error: "Esta cuenta no es de un negocio" });
  const rows = db
    .prepare(
      `SELECT * FROM rides WHERE business_id = ? AND created_at >= datetime('now', '-24 hours')
       ORDER BY CASE WHEN status IN ('completado', 'cancelado') THEN 1 ELSE 0 END, id DESC LIMIT 50`
    )
    .all(auth.business.id);
  res.json({ business: publicBusiness(auth.business), rides: rows.map(listItem) });
});

// --- Perfil y menú del negocio (Comida y negocios, Paso A, 2-oct) ---
// Lo edita el dueño desde "Mi negocio". Las fotos llegan ya comprimidas por el
// navegador y se guardan como archivo (menuImages.js).

function needBusiness(req, res) {
  const auth = authBusiness(req, res);
  if (!auth) return null;
  if (!auth.business) {
    res.status(403).json({ error: "Esta cuenta no es de un negocio" });
    return null;
  }
  return auth.business;
}

router.post("/business/profile", (req, res) => {
  const b = needBusiness(req, res);
  if (!b) return;
  res.json({ business: { ...publicBusiness(b), ...payInfo(b) }, menu: menuOf(b.id, false), categories: BUSINESS_CATEGORIES });
});

router.post("/business/profile/save", (req, res) => {
  const b = needBusiness(req, res);
  if (!b) return;
  const whatsapp = String(req.body.whatsapp || "").replace(/\D/g, "");
  if (whatsapp && whatsapp.length !== 10) return res.status(400).json({ error: "El WhatsApp debe tener 10 dígitos" });
  const category = BUSINESS_CATEGORIES.includes(req.body.category) ? req.body.category : null;
  let logo = b.logo, cover = b.cover;
  if (req.body.logo) {
    logo = saveImage(req.body.logo);
    if (!logo) return res.status(400).json({ error: "No se pudo guardar el logo. Prueba con otra foto." });
  }
  if (req.body.cover) {
    cover = saveImage(req.body.cover);
    if (!cover) return res.status(400).json({ error: "No se pudo guardar la portada. Prueba con otra foto." });
  }
  // CLABE (18 dígitos) o tarjeta (16); se guarda solo con números.
  const account = String(req.body.pay_account || "").replace(/\D/g, "");
  if (account && ![16, 18].includes(account.length)) {
    return res.status(400).json({ error: "La CLABE debe tener 18 dígitos (o la tarjeta 16)" });
  }
  db.prepare(
    `UPDATE businesses SET tagline = ?, category = ?, hours = ?, whatsapp = ?, logo = ?, cover = ?,
       pay_bank = ?, pay_account = ?, pay_holder = ?, updated_at = datetime('now') WHERE id = ?`
  ).run(
    clean(req.body.tagline, 70) || null, category, clean(req.body.hours, 60) || null, whatsapp || null, logo, cover,
    clean(req.body.pay_bank, 40) || null, account || null, clean(req.body.pay_holder, 60) || null, b.id
  );
  const saved = db.prepare("SELECT * FROM businesses WHERE id = ?").get(b.id);
  res.json({ business: { ...publicBusiness(saved), ...payInfo(saved) } });
});

// Abierto / cerrado: los clientes solo pueden pedir cuando está abierto.
router.post("/business/open", (req, res) => {
  const b = needBusiness(req, res);
  if (!b) return;
  db.prepare("UPDATE businesses SET is_open = ?, updated_at = datetime('now') WHERE id = ?").run(req.body.open ? 1 : 0, b.id);
  res.json({ is_open: !!req.body.open });
});

const MAX_MENU_ITEMS = 150;

router.post("/business/menu/save", (req, res) => {
  const b = needBusiness(req, res);
  if (!b) return;
  const name = clean(req.body.name, 50);
  const price = Math.round(Number(req.body.price));
  if (!name) return res.status(400).json({ error: "Escribe el nombre del producto" });
  if (!(price >= 1 && price <= 20000)) return res.status(400).json({ error: "Revisa el precio" });
  const id = Number(req.body.id) || null;
  const current = id ? db.prepare("SELECT * FROM menu_items WHERE id = ? AND business_id = ? AND deleted_at IS NULL").get(id, b.id) : null;
  if (id && !current) return res.status(404).json({ error: "Producto no encontrado" });
  let photo = current ? current.photo : null;
  if (req.body.removePhoto) photo = null;
  if (req.body.photo) {
    photo = saveImage(req.body.photo);
    if (!photo) return res.status(400).json({ error: "No se pudo guardar la foto. Prueba con otra." });
  }
  const fields = [clean(req.body.category, 30) || null, name, clean(req.body.description, 140) || null, price, photo];
  if (current) {
    db.prepare("UPDATE menu_items SET category = ?, name = ?, description = ?, price = ?, photo = ?, updated_at = datetime('now') WHERE id = ?")
      .run(...fields, current.id);
  } else {
    const { n } = db.prepare("SELECT COUNT(*) AS n FROM menu_items WHERE business_id = ? AND deleted_at IS NULL").get(b.id);
    if (n >= MAX_MENU_ITEMS) return res.status(400).json({ error: `Máximo ${MAX_MENU_ITEMS} productos` });
    db.prepare("INSERT INTO menu_items (business_id, category, name, description, price, photo, position) VALUES (?, ?, ?, ?, ?, ?, ?)")
      .run(b.id, ...fields, n);
  }
  res.json({ menu: menuOf(b.id, false) });
});

router.post("/business/menu/:id/available", (req, res) => {
  const b = needBusiness(req, res);
  if (!b) return;
  db.prepare("UPDATE menu_items SET available = ?, updated_at = datetime('now') WHERE id = ? AND business_id = ?")
    .run(req.body.available ? 1 : 0, Number(req.params.id), b.id);
  res.json({ menu: menuOf(b.id, false) });
});

router.post("/business/menu/:id/delete", (req, res) => {
  const b = needBusiness(req, res);
  if (!b) return;
  db.prepare("UPDATE menu_items SET deleted_at = datetime('now') WHERE id = ? AND business_id = ?").run(Number(req.params.id), b.id);
  res.json({ menu: menuOf(b.id, false) });
});

// --- Comida y negocios: lo que ven los clientes (público) ---
// Solo si el admin ya prendió la sección en esa ciudad, y solo negocios activos
// con WhatsApp y al menos un producto disponible. El pedido se manda directo
// al WhatsApp del negocio (la app no toca el dinero de la comida).

function foodEnabled(city) {
  const row = db.prepare("SELECT enabled FROM food_settings WHERE city = ?").get(city);
  return !!(row && row.enabled);
}

const LISTED = `b.active = 1 AND b.whatsapp IS NOT NULL AND EXISTS (SELECT 1 FROM menu_items m WHERE m.business_id = b.id AND m.deleted_at IS NULL AND m.available = 1)`;

// Abierto/cerrado y "agotado" cambian a cada rato: que el navegador nunca los guarde.
router.use("/food", (req, res, next) => {
  res.set("Cache-Control", "no-store");
  next();
});

router.get("/food/businesses", (req, res) => {
  const city = String(req.query.city || "tekax");
  if (!foodEnabled(city)) return res.json({ enabled: false, businesses: [] });
  const rows = db.prepare(`SELECT b.* FROM businesses b WHERE b.city = ? AND ${LISTED} ORDER BY b.is_open DESC, b.name`).all(city);
  // Nombres de productos, para que el buscador encuentre "pizza" aunque no esté en el nombre del negocio.
  const items = db.prepare("SELECT business_id, name, category FROM menu_items WHERE deleted_at IS NULL AND available = 1").all();
  res.json({
    enabled: true,
    businesses: rows.map((b) => ({
      ...publicBusiness(b),
      search: items.filter((i) => i.business_id === b.id).map((i) => `${i.name} ${i.category || ""}`).join(" ").slice(0, 2000),
    })),
  });
});

router.get("/food/business/:id", (req, res) => {
  const b = db.prepare("SELECT * FROM businesses b WHERE b.id = ? AND " + LISTED).get(Number(req.params.id));
  if (!b || !foodEnabled(b.city)) return res.status(404).json({ error: "Negocio no encontrado" });
  res.json({ business: { ...publicBusiness(b), ...payInfo(b) }, menu: menuOf(b.id, true) });
});

router.post("/admin/food/status", checkAdminPin, (req, res) => {
  res.json({ enabled: foodEnabled(req.adminCity) });
});

router.post("/admin/food/enabled", checkAdminPin, (req, res) => {
  db.prepare("INSERT INTO food_settings (city, enabled) VALUES (?, ?) ON CONFLICT(city) DO UPDATE SET enabled = excluded.enabled")
    .run(req.adminCity, req.body.enabled ? 1 : 0);
  res.json({ enabled: foodEnabled(req.adminCity) });
});

// --- Admin: dar de alta negocios (solo los de su ciudad) ---

router.post("/admin/businesses/list", checkAdminPin, (req, res) => {
  const rows = db
    .prepare(
      `SELECT b.*, r.phone, r.name AS owner_name,
         (SELECT COUNT(*) FROM rides WHERE business_id = b.id AND status = 'completado') AS deliveries
       FROM businesses b JOIN riders r ON r.id = b.rider_id WHERE b.city = ? ORDER BY b.id DESC`
    )
    .all(req.adminCity);
  res.json(rows);
});

// El dueño ya debe estar registrado como pasajero con ese teléfono.
router.post("/admin/businesses/save", checkAdminPin, (req, res) => {
  const name = clean(req.body.name, 50);
  const address = clean(req.body.address) || null;
  const phone = String(req.body.phone || "").replace(/\D/g, "");
  const lat = Number(req.body.lat);
  const lng = Number(req.body.lng);
  if (!name) return res.status(400).json({ error: "Falta el nombre del negocio" });
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return res.status(400).json({ error: "Marca la ubicación del negocio en el mapa" });
  const rider = db.prepare("SELECT id FROM riders WHERE phone = ?").get(phone);
  if (!rider) {
    return res.status(404).json({ error: "Ese teléfono no está registrado. Primero el dueño se registra como pasajero en la app." });
  }
  const existing = db.prepare("SELECT id, city FROM businesses WHERE rider_id = ?").get(rider.id);
  if (existing && existing.city !== req.adminCity) return res.status(409).json({ error: "Esa cuenta ya es negocio en otra ciudad" });
  if (existing) {
    db.prepare("UPDATE businesses SET name = ?, lat = ?, lng = ?, address = ?, active = 1, updated_at = datetime('now') WHERE id = ?")
      .run(name, lat, lng, address, existing.id);
    return res.json({ ok: true, id: existing.id });
  }
  const r = db.prepare("INSERT INTO businesses (rider_id, city, name, lat, lng, address) VALUES (?, ?, ?, ?, ?, ?)")
    .run(rider.id, req.adminCity, name, lat, lng, address);
  res.json({ ok: true, id: Number(r.lastInsertRowid) });
});

router.post("/admin/businesses/:id/active", checkAdminPin, (req, res) => {
  const b = db.prepare("SELECT id, city FROM businesses WHERE id = ?").get(req.params.id);
  if (!b || b.city !== req.adminCity) return res.status(404).json({ error: "No encontrado" });
  db.prepare("UPDATE businesses SET active = ?, updated_at = datetime('now') WHERE id = ?").run(req.body.active ? 1 : 0, b.id);
  res.json({ ok: true });
});

module.exports = router;
