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
  return b ? { id: b.id, name: b.name, lat: b.lat, lng: b.lng, address: b.address, city: b.city } : null;
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
