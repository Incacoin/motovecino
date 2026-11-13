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
const { isWithinServiceRadius, resolveCity } = require("../cities");
const { isRateLimited, recordFailedAttempt, clearAttempts, RATE_LIMIT_MESSAGE } = require("../pinRateLimit");
const { checkAdminPin } = require("./admin");
const { saveImage, imageUrl } = require("../menuImages");
const { BUSINESS_FOUNDER_UNTIL, BUSINESS_MIN_PRODUCTS, BUSINESS_RULES_FROM, BUSINESS_GRACE_UNTIL } = require("../constants");
const push = require("../push");

const router = express.Router();

// Los ids son números: algo como /x/abc/... se contesta "no encontrado" (como
// antes con SQLite) en vez de un error de Postgres por el tipo de dato.
const numericParam = (req, res, next, value) => (/^\d{1,9}$/.test(value) ? next() : res.status(404).json({ error: "No encontrado" }));
router.param("id", numericParam);

const MAX_TEXT = 80;
const clean = (t, max = MAX_TEXT) => (typeof t === "string" ? t.trim().slice(0, max) : "");

// Dueño autenticado con su teléfono y PIN de pasajero + su negocio activo.
// Responde el error y devuelve null si algo no cuadra.
async function authBusiness(req, res) {
  if (isRateLimited(req.ip, req.body)) {
    res.status(429).json({ error: RATE_LIMIT_MESSAGE });
    return null;
  }
  const { phone, pin } = req.body || {};
  const rider = phone && pin ? await db.prepare("SELECT id, name, phone FROM riders WHERE phone = ? AND pin = ?").get(phone, pin) : null;
  if (!rider) {
    recordFailedAttempt(req.ip, req.body);
    res.status(401).json({ error: "Teléfono o PIN incorrectos" });
    return null;
  }
  clearAttempts(req.ip);
  const business = await db.prepare("SELECT * FROM businesses WHERE rider_id = ? AND active = 1").get(rider.id);
  return { rider, business };
}

function isFounderBusiness(b) {
  return !!b.created_at && b.created_at < BUSINESS_FOUNDER_UNTIL;
}

function publicBusiness(b) {
  return b
    ? {
        id: b.id, name: b.name, lat: b.lat, lng: b.lng, address: b.address, city: b.city,
        tagline: b.tagline, category: b.category, hours: b.hours, whatsapp: b.whatsapp, is_open: !!b.is_open,
        catalog: !!b.catalog_enabled, special: !!b.special_enabled,
        logo: imageUrl(b.logo), cover: imageUrl(b.cover),
        es_fundador: isFounderBusiness(b),
      }
    : null;
}

// Cuenta donde el cliente le transfiere la comida al negocio. No va en la
// lista de negocios: solo sale cuando el cliente abre el negocio para pedir.
function payInfo(b) {
  return { pay_bank: b.pay_bank || null, pay_account: b.pay_account || null, pay_holder: b.pay_holder || null };
}

// Cómo recibe pedidos y cómo le pagan (pedidos en la app, 11-oct-2026).
function orderSettings(b) {
  return { accepts_transfer: !!b.accepts_transfer, accepts_cash: !!b.accepts_cash, cash_cap: b.cash_cap };
}

// 11-oct-2026: no solo comida — cualquier negocio del municipio.
const BUSINESS_CATEGORIES = ["Antojitos", "Comida", "Tacos", "Pizzas", "Hamburguesas", "Mariscos", "Pollos", "Panadería", "Postres", "Bebidas", "Farmacia", "Abarrotes", "Tienda", "Papelería", "Ferretería", "Ropa y zapatos", "Regalos", "Otro"];

function menuItem(i) {
  return {
    id: i.id, category: i.category, name: i.name, description: i.description,
    price: i.price, available: !!i.available, photo: imageUrl(i.photo),
  };
}
async function menuOf(businessId, onlyAvailable) {
  return (await db
    .prepare(`SELECT * FROM menu_items WHERE business_id = ? AND deleted_at IS NULL ${onlyAvailable ? "AND available = 1" : ""} ORDER BY position, id`)
    .all(businessId))
    .map(menuItem);
}

// ¿Esta cuenta es de un negocio? La app del pasajero lo pregunta al entrar
// para mostrar "Mi negocio" en el menú.
router.post("/business/me", async (req, res) => {
  const auth = await authBusiness(req, res);
  if (!auth) return;
  if (auth.business) return res.json({ business: publicBusiness(auth.business) });
  // Sin negocio activo: ¿mandó una solicitud? (pendiente, rechazada o en pausa)
  const b = await db.prepare("SELECT * FROM businesses WHERE rider_id = ?").get(auth.rider.id);
  res.json({ business: null, application: b ? applicationInfo(b) : null, categories: BUSINESS_CATEGORIES });
});

// Lo que ve el dueño de su solicitud. "pausado" = aprobado pero el admin lo apagó.
function applicationInfo(b) {
  return {
    status: b.status === "aprobado" ? "pausado" : b.status,
    name: b.name, category: b.category, address: b.address, lat: b.lat, lng: b.lng,
    reject_reason: b.status === "rechazado" ? b.reject_reason || null : null,
    has_facade: !!b.facade,
  };
}

// --- Registro de negocios por su cuenta (8-nov-2026) ---
// El dueño (ya con cuenta de pasajero) manda nombre, categoría, ubicación y foto
// de la fachada. Queda "pendiente" y APAGADO (active = 0): no sale en la lista,
// no recibe pedidos ni pide choferes hasta que el admin de su municipio lo
// apruebe. Si lo rechazan, puede corregir y mandar otra vez.
router.post("/business/apply", async (req, res) => {
  const auth = await authBusiness(req, res);
  if (!auth) return;
  if (auth.business) return res.status(409).json({ error: "Tu cuenta ya es de un negocio" });
  const name = clean(req.body.name, 50);
  if (!name) return res.status(400).json({ error: "Escribe el nombre de tu negocio" });
  const category = BUSINESS_CATEGORIES.includes(req.body.category) ? req.body.category : null;
  if (!category) return res.status(400).json({ error: "Elige qué vende tu negocio" });
  const lat = Number(req.body.lat), lng = Number(req.body.lng);
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return res.status(400).json({ error: "Marca dónde está tu negocio en el mapa" });
  const city = resolveCity(lat, lng);
  if (!city || city.testOnly || city.signupClosed) {
    return res.status(400).json({ error: "Por ahora solo registramos negocios de los municipios donde está MotoVecino" });
  }
  const existing = await db.prepare("SELECT * FROM businesses WHERE rider_id = ?").get(auth.rider.id);
  if (existing && existing.status === "aprobado") {
    return res.status(409).json({ error: "Tu negocio está en pausa. Escríbenos al 997 973 9422." });
  }
  let facade = existing ? existing.facade : null;
  if (req.body.facade) {
    facade = saveImage(req.body.facade);
    if (!facade) return res.status(400).json({ error: "No se pudo guardar la foto. Prueba con otra." });
  }
  if (!facade) return res.status(400).json({ error: "Toma una foto de la fachada o del mostrador de tu negocio" });
  const address = clean(req.body.address) || null;
  if (existing) {
    await db.prepare(
      `UPDATE businesses SET name = ?, category = ?, lat = ?, lng = ?, address = ?, city = ?, facade = ?,
         status = 'pendiente', reject_reason = NULL, active = 0, updated_at = datetime('now') WHERE id = ?`
    ).run(name, category, lat, lng, address, city.id, facade, existing.id);
  } else {
    await db.prepare(
      `INSERT INTO businesses (rider_id, city, name, lat, lng, address, category, facade, status, active)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pendiente', 0)`
    ).run(auth.rider.id, city.id, name, lat, lng, address, category, facade);
  }
  push.notifySupport("admin", 0, {
    kind: "admin", tag: `negocio-${auth.rider.id}`, url: "/admin.html",
    title: `🏪 Negocio por aprobar en ${city.label}`, body: `${name} · ${category}`,
  }).catch((e) => console.warn("[negocios] aviso al dueño:", e.message));
  const saved = await db.prepare("SELECT * FROM businesses WHERE rider_id = ?").get(auth.rider.id);
  res.json({ application: applicationInfo(saved) });
});

router.post("/business/rides", async (req, res) => {
  const auth = await authBusiness(req, res);
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

  const ride = await insertBusinessRide(business, rider, {
    dest_lat: destLat, dest_lng: destLng, dest_label: clean(req.body.dest_label) || null,
    client_name: clientName, order_note: clean(req.body.order_note) || null,
  });
  await realtime.broadcastNewRide(ride);
  realtime.startNoDriverTimer(ride.id, ride.ride_type);
  res.status(201).json(await listItem(ride));
});

// Crea el envío de un pedido que llegó por WhatsApp o teléfono. No lo
// anuncia: eso lo decide quien llama (ahora, o routes/bookings.js cuando un
// chofer lo aseguró desde antes).
async function insertBusinessRide(business, rider, f) {
  await db.prepare("UPDATE riders SET last_ride_at = datetime('now') WHERE id = ?").run(rider.id);
  const result = await db
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
      f.dest_lat,
      f.dest_lng,
      f.dest_label,
      business.city,
      crypto.randomBytes(16).toString("base64url"),
      f.client_name,
      f.order_note,
      business.id
    );
  return db.prepare("SELECT * FROM rides WHERE id = ?").get(result.lastInsertRowid);
}

// Lo que ve el negocio de cada envío. El teléfono del chofer va enmascarado,
// igual que en la app del pasajero.
async function listItem(r) {
  const driver = r.driver_id ? await db.prepare("SELECT name, vehicle, phone FROM drivers WHERE id = ?").get(r.driver_id) : null;
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
router.post("/business/rides/list", async (req, res) => {
  const auth = await authBusiness(req, res);
  if (!auth) return;
  if (!auth.business) return res.status(403).json({ error: "Esta cuenta no es de un negocio" });
  const rows = await db
    .prepare(
      `SELECT * FROM rides WHERE business_id = ? AND created_at >= datetime('now', '-24 hours')
       ORDER BY CASE WHEN status IN ('completado', 'cancelado') THEN 1 ELSE 0 END, id DESC LIMIT 50`
    )
    .all(auth.business.id);
  res.json({ business: publicBusiness(auth.business), rides: await Promise.all(rows.map(listItem)) });
});

// --- Perfil y menú del negocio (Comida y negocios, Paso A, 2-oct) ---
// Lo edita el dueño desde "Mi negocio". Las fotos llegan ya comprimidas por el
// navegador y se guardan como archivo (menuImages.js).

async function needBusiness(req, res) {
  const auth = await authBusiness(req, res);
  if (!auth) return null;
  if (!auth.business) {
    res.status(403).json({ error: "Esta cuenta no es de un negocio" });
    return null;
  }
  return auth.business;
}

router.post("/business/profile", async (req, res) => {
  const b = await needBusiness(req, res);
  if (!b) return;
  res.json({ business: { ...publicBusiness(b), ...payInfo(b), ...orderSettings(b) }, menu: await menuOf(b.id, false), categories: BUSINESS_CATEGORIES, listing: await listingInfo(b) });
});

router.post("/business/profile/save", async (req, res) => {
  const b = await needBusiness(req, res);
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
  await db.prepare(
    `UPDATE businesses SET tagline = ?, category = ?, hours = ?, whatsapp = ?, logo = ?, cover = ?,
       pay_bank = ?, pay_account = ?, pay_holder = ?, updated_at = datetime('now') WHERE id = ?`
  ).run(
    clean(req.body.tagline, 70) || null, category, clean(req.body.hours, 60) || null, whatsapp || null, logo, cover,
    clean(req.body.pay_bank, 40) || null, account || null, clean(req.body.pay_holder, 60) || null, b.id
  );
  const saved = await db.prepare("SELECT * FROM businesses WHERE id = ?").get(b.id);
  res.json({ business: { ...publicBusiness(saved), ...payInfo(saved) }, listing: await listingInfo(saved) });
});

// Abierto / cerrado: los clientes solo pueden pedir cuando está abierto.
router.post("/business/open", async (req, res) => {
  const b = await needBusiness(req, res);
  if (!b) return;
  await db.prepare("UPDATE businesses SET is_open = ?, updated_at = datetime('now') WHERE id = ?").run(req.body.open ? 1 : 0, b.id);
  res.json({ is_open: !!req.body.open });
});

const MAX_MENU_ITEMS = 150;

router.post("/business/menu/save", async (req, res) => {
  const b = await needBusiness(req, res);
  if (!b) return;
  const name = clean(req.body.name, 50);
  const price = Math.round(Number(req.body.price));
  if (!name) return res.status(400).json({ error: "Escribe el nombre del producto" });
  if (!(price >= 1 && price <= 20000)) return res.status(400).json({ error: "Revisa el precio" });
  const id = Number(req.body.id) || null;
  const current = id ? await db.prepare("SELECT * FROM menu_items WHERE id = ? AND business_id = ? AND deleted_at IS NULL").get(id, b.id) : null;
  if (id && !current) return res.status(404).json({ error: "Producto no encontrado" });
  let photo = current ? current.photo : null;
  if (req.body.removePhoto) photo = null;
  if (req.body.photo) {
    photo = saveImage(req.body.photo);
    if (!photo) return res.status(400).json({ error: "No se pudo guardar la foto. Prueba con otra." });
  }
  const fields = [clean(req.body.category, 30) || null, name, clean(req.body.description, 140) || null, price, photo];
  if (current) {
    await db.prepare("UPDATE menu_items SET category = ?, name = ?, description = ?, price = ?, photo = ?, updated_at = datetime('now') WHERE id = ?")
      .run(...fields, current.id);
  } else {
    const { n } = await db.prepare("SELECT COUNT(*) AS n FROM menu_items WHERE business_id = ? AND deleted_at IS NULL").get(b.id);
    if (n >= MAX_MENU_ITEMS) return res.status(400).json({ error: `Máximo ${MAX_MENU_ITEMS} productos` });
    await db.prepare("INSERT INTO menu_items (business_id, category, name, description, price, photo, position) VALUES (?, ?, ?, ?, ?, ?, ?)")
      .run(b.id, ...fields, n);
  }
  res.json({ menu: await menuOf(b.id, false), listing: await listingInfo(b) });
});

router.post("/business/menu/:id/available", async (req, res) => {
  const b = await needBusiness(req, res);
  if (!b) return;
  await db.prepare("UPDATE menu_items SET available = ?, updated_at = datetime('now') WHERE id = ? AND business_id = ?")
    .run(req.body.available ? 1 : 0, Number(req.params.id), b.id);
  res.json({ menu: await menuOf(b.id, false), listing: await listingInfo(b) });
});

router.post("/business/menu/:id/delete", async (req, res) => {
  const b = await needBusiness(req, res);
  if (!b) return;
  await db.prepare("UPDATE menu_items SET deleted_at = datetime('now') WHERE id = ? AND business_id = ?").run(Number(req.params.id), b.id);
  res.json({ menu: await menuOf(b.id, false), listing: await listingInfo(b) });
});

// --- Comida y negocios: lo que ven los clientes (público) ---
// Solo si el admin ya prendió la sección en esa ciudad, y solo negocios activos
// con WhatsApp y al menos un producto disponible. El pedido se manda directo
// al WhatsApp del negocio (la app no toca el dinero de la comida).

async function foodEnabled(city) {
  const row = await db.prepare("SELECT enabled FROM food_settings WHERE city = ?").get(city);
  return !!(row && row.enabled);
}

// Sale en la lista (8-nov-2026): aprobado, activo y completo = logo + portada +
// BUSINESS_MIN_PRODUCTS productos disponibles con foto. Los de antes de
// BUSINESS_RULES_FROM siguen con la regla vieja (algo que pedir: un producto o
// "pedido especial") hasta BUSINESS_GRACE_UNTIL. Las fechas vienen de
// constants.js (no del usuario), por eso van dentro del texto.
const PHOTO_ITEMS = `(SELECT COUNT(*) FROM menu_items m WHERE m.business_id = b.id AND m.deleted_at IS NULL AND m.available = 1 AND m.photo IS NOT NULL)`;
const COMPLETE = `b.logo IS NOT NULL AND b.cover IS NOT NULL AND ${PHOTO_ITEMS} >= ${Number(BUSINESS_MIN_PRODUCTS)}`;
const OLD_RULE = `(b.special_enabled = 1 OR EXISTS (SELECT 1 FROM menu_items m WHERE m.business_id = b.id AND m.deleted_at IS NULL AND m.available = 1))`;
const GRACE = `b.created_at < '${BUSINESS_RULES_FROM}' AND b.reviewed_at IS NULL AND datetime('now') < '${BUSINESS_GRACE_UNTIL}' AND ${OLD_RULE}`;
const LISTED = `b.active = 1 AND b.status = 'aprobado' AND ((${COMPLETE}) OR (${GRACE}))`;

// Lo que ve el dueño en "Mi negocio": si ya sale en la lista y qué le falta.
async function listingInfo(b) {
  const row = await db.prepare(`SELECT ${PHOTO_ITEMS} AS photos, CASE WHEN ${COMPLETE} THEN 1 ELSE 0 END AS complete, CASE WHEN ${LISTED} THEN 1 ELSE 0 END AS listed FROM businesses b WHERE b.id = ?`).get(b.id);
  const photos = Number(row && row.photos) || 0;
  const falta = BUSINESS_MIN_PRODUCTS - photos;
  const missing = [];
  if (!b.logo) missing.push("logo");
  if (!b.cover) missing.push("portada");
  if (falta > 0) missing.push(`${falta} producto${falta === 1 ? "" : "s"} con foto`);
  return {
    listed: !!(row && Number(row.listed)), complete: !!(row && Number(row.complete)), missing,
    photos, min_products: BUSINESS_MIN_PRODUCTS,
    grace_until: b.created_at < BUSINESS_RULES_FROM && !b.reviewed_at ? BUSINESS_GRACE_UNTIL : null,
  };
}

// Abierto/cerrado y "agotado" cambian a cada rato: que el navegador nunca los guarde.
router.use("/food", (req, res, next) => {
  res.set("Cache-Control", "no-store");
  next();
});

router.get("/food/businesses", async (req, res) => {
  const city = String(req.query.city || "tekax");
  if (!await foodEnabled(city)) return res.json({ enabled: false, businesses: [] });
  const rows = await db.prepare(`SELECT b.* FROM businesses b WHERE b.city = ? AND ${LISTED} ORDER BY b.is_open DESC, (b.created_at < ?) DESC, b.name`).all(city, BUSINESS_FOUNDER_UNTIL);
  // Nombres de productos, para que el buscador encuentre "pizza" aunque no esté en el nombre del negocio.
  const items = await db.prepare("SELECT business_id, name, category FROM menu_items WHERE deleted_at IS NULL AND available = 1").all();
  res.json({
    enabled: true,
    businesses: rows.map((b) => ({
      ...publicBusiness(b),
      search: items.filter((i) => i.business_id === b.id).map((i) => `${i.name} ${i.category || ""}`).join(" ").slice(0, 2000),
    })),
  });
});

router.get("/food/business/:id", async (req, res) => {
  const b = await db.prepare("SELECT * FROM businesses b WHERE b.id = ? AND " + LISTED).get(Number(req.params.id));
  if (!b || !await foodEnabled(b.city)) return res.status(404).json({ error: "Negocio no encontrado" });
  res.json({ business: { ...publicBusiness(b), ...payInfo(b) }, menu: await menuOf(b.id, true) });
});

router.post("/admin/food/status", checkAdminPin, async (req, res) => {
  res.json({ enabled: await foodEnabled(req.adminCity) });
});

router.post("/admin/food/enabled", checkAdminPin, async (req, res) => {
  await db.prepare("INSERT INTO food_settings (city, enabled) VALUES (?, ?) ON CONFLICT(city) DO UPDATE SET enabled = excluded.enabled")
    .run(req.adminCity, req.body.enabled ? 1 : 0);
  res.json({ enabled: await foodEnabled(req.adminCity) });
});

// --- Admin: dar de alta negocios (solo los de su ciudad) ---

router.post("/admin/businesses/list", checkAdminPin, async (req, res) => {
  const rows = await db
    .prepare(
      `SELECT b.*, r.phone, r.name AS owner_name,
         (SELECT COUNT(*) FROM rides WHERE business_id = b.id AND status = 'completado') AS deliveries,
         (SELECT COUNT(*) FROM business_orders WHERE business_id = b.id) AS orders
       FROM businesses b JOIN riders r ON r.id = b.rider_id WHERE b.city = ? ORDER BY CASE WHEN b.status = 'pendiente' THEN 0 ELSE 1 END, b.id DESC`
    )
    .all(req.adminCity);
  res.json(rows.map((b) => ({ ...b, es_fundador: isFounderBusiness(b), facade: imageUrl(b.facade), logo: imageUrl(b.logo), cover: imageUrl(b.cover) })));
});

// El dueño ya debe estar registrado como pasajero con ese teléfono.
router.post("/admin/businesses/save", checkAdminPin, async (req, res) => {
  const name = clean(req.body.name, 50);
  const address = clean(req.body.address) || null;
  const phone = String(req.body.phone || "").replace(/\D/g, "");
  const lat = Number(req.body.lat);
  const lng = Number(req.body.lng);
  if (!name) return res.status(400).json({ error: "Falta el nombre del negocio" });
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return res.status(400).json({ error: "Marca la ubicación del negocio en el mapa" });
  const rider = await db.prepare("SELECT id FROM riders WHERE phone = ?").get(phone);
  if (!rider) {
    return res.status(404).json({ error: "Ese teléfono no está registrado. Primero el dueño se registra como pasajero en la app." });
  }
  const existing = await db.prepare("SELECT id, city FROM businesses WHERE rider_id = ?").get(rider.id);
  if (existing && existing.city !== req.adminCity) return res.status(409).json({ error: "Esa cuenta ya es negocio en otra ciudad" });
  if (existing) {
    await db.prepare("UPDATE businesses SET name = ?, lat = ?, lng = ?, address = ?, active = 1, status = 'aprobado', reject_reason = NULL, updated_at = datetime('now') WHERE id = ?")
      .run(name, lat, lng, address, existing.id);
    return res.json({ ok: true, id: existing.id });
  }
  const r = await db.prepare("INSERT INTO businesses (rider_id, city, name, lat, lng, address) VALUES (?, ?, ?, ?, ?, ?)")
    .run(rider.id, req.adminCity, name, lat, lng, address);
  res.json({ ok: true, id: Number(r.lastInsertRowid) });
});

router.post("/admin/businesses/:id/active", checkAdminPin, async (req, res) => {
  const b = await db.prepare("SELECT id, city, status FROM businesses WHERE id = ?").get(req.params.id);
  if (!b || b.city !== req.adminCity) return res.status(404).json({ error: "No encontrado" });
  if (req.body.active && b.status !== "aprobado") return res.status(409).json({ error: "Primero aprueba el negocio" });
  await db.prepare("UPDATE businesses SET active = ?, updated_at = datetime('now') WHERE id = ?").run(req.body.active ? 1 : 0, b.id);
  res.json({ ok: true });
});

// Aprobar / rechazar una solicitud (solo las de su municipio).
router.post("/admin/businesses/:id/approve", checkAdminPin, async (req, res) => {
  const b = await db.prepare("SELECT id, city, status FROM businesses WHERE id = ?").get(req.params.id);
  if (!b || b.city !== req.adminCity) return res.status(404).json({ error: "No encontrado" });
  if (b.status !== "pendiente") return res.status(409).json({ error: "Este negocio no está esperando aprobación" });
  // El dueño puede corregir mientras espera: se aprueba solo la versión que vio el admin.
  const r = await db.prepare("UPDATE businesses SET status = 'aprobado', active = 1, reject_reason = NULL, reviewed_at = datetime('now'), updated_at = datetime('now') WHERE id = ? AND status = 'pendiente' AND updated_at = ?")
    .run(b.id, String(req.body.seen || ""));
  if (!r.changes) return res.status(409).json({ error: "El negocio cambió sus datos. Revísalo otra vez." });
  res.json({ ok: true });
});

router.post("/admin/businesses/:id/reject", checkAdminPin, async (req, res) => {
  const b = await db.prepare("SELECT id, city, status FROM businesses WHERE id = ?").get(req.params.id);
  if (!b || b.city !== req.adminCity) return res.status(404).json({ error: "No encontrado" });
  if (b.status !== "pendiente") return res.status(409).json({ error: "Este negocio no está esperando aprobación" });
  await db.prepare("UPDATE businesses SET status = 'rechazado', active = 0, reject_reason = ?, reviewed_at = datetime('now'), updated_at = datetime('now') WHERE id = ?")
    .run(clean(req.body.reason, 140) || null, b.id);
  res.json({ ok: true });
});

// Eliminar un negocio (8-nov-2026): para borrar negocios de prueba y que ese
// teléfono pueda registrarse otra vez. Solo el dueño de MotoVecino, y solo si
// el negocio nunca recibió pedidos de clientes (esos se conservan; para esos
// está "Pausar"). La cuenta de pasajero del dueño NO se borra. Los viajes que
// pidió como negocio se quedan en el historial.
router.post("/admin/businesses/:id/delete", checkAdminPin, async (req, res) => {
  if (req.adminRole !== "tekax") return res.status(403).json({ error: "Esto solo lo puede hacer el dueño." });
  const b = await db.prepare("SELECT id, city FROM businesses WHERE id = ?").get(req.params.id);
  if (!b || b.city !== req.adminCity) return res.status(404).json({ error: "No encontrado" });
  const o = await db.prepare("SELECT COUNT(*) AS n FROM business_orders WHERE business_id = ?").get(b.id);
  if (Number(o.n) > 0) return res.status(409).json({ error: "Este negocio ya tiene pedidos de clientes. Mejor usa Pausar." });
  await db.prepare("DELETE FROM business_push_subs WHERE business_id = ?").run(b.id);
  await db.prepare("DELETE FROM business_chat WHERE business_id = ?").run(b.id);
  await db.prepare("DELETE FROM menu_items WHERE business_id = ?").run(b.id);
  await db.prepare("DELETE FROM businesses WHERE id = ?").run(b.id);
  res.json({ ok: true });
});

module.exports = router;
module.exports.insertBusinessRide = insertBusinessRide;
