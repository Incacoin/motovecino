// Negocios aliados: anuncios dentro de la app del pasajero (ver ally_ads en
// db.js). Un solo anuncio por viaje, solo mientras busca chofer o lo espera.
// Al negocio se le reportan conteos, nunca datos de pasajeros.
const crypto = require("node:crypto");
const express = require("express");
const db = require("../db");
const { checkAdminPin } = require("./admin");

const router = express.Router();

const IMAGE_RE = /^data:(image\/(?:jpeg|png|webp));base64,/;
const MAX_IMAGE_LENGTH = 400000;
const AD_STATUSES = ["buscando", "aceptado", "llegue"];

function imageHash(image) {
  return crypto.createHash("sha256").update(image).digest("hex").slice(0, 16);
}
function imageUrl(ad) {
  return ad.image ? `/api/ally-ads/${ad.id}/img/${imageHash(ad.image)}` : null;
}
function isEnabled(city) {
  const row = db.prepare("SELECT enabled FROM ally_settings WHERE city = ?").get(city);
  return !!(row && row.enabled);
}
// Anuncios vigentes hoy (fecha local de Yucatán, UTC-6), sobre el alias "a".
const LIVE_WHERE = `a.city = ? AND a.deleted_at IS NULL AND a.active = 1
  AND (a.starts_on IS NULL OR a.starts_on <= date('now', '-6 hours'))
  AND (a.ends_on IS NULL OR a.ends_on >= date('now', '-6 hours'))`;

// Solo quien tiene el token del viaje puede pedir su anuncio.
function rideFromToken(req) {
  const id = Number(req.query.ride || req.body?.ride);
  const t = req.query.t || req.body?.t;
  const ride = id ? db.prepare("SELECT id, city, status, share_token FROM rides WHERE id = ?").get(id) : null;
  return ride && t && ride.share_token === t ? ride : null;
}

// El anuncio del viaje: el mismo si ya se le mostró uno (reabrir la app no
// cambia de negocio ni cuenta doble); si no, el que menos vistas lleva en la
// semana, para que todos los aliados salgan parejo.
router.get("/ally-ad", (req, res) => {
  const ride = rideFromToken(req);
  if (!ride) return res.status(404).json({ error: "Viaje no encontrado" });
  if (!AD_STATUSES.includes(ride.status) || !isEnabled(ride.city)) return res.json({ ad: null });

  let ad = db
    .prepare(`SELECT a.* FROM ally_ad_events e JOIN ally_ads a ON a.id = e.ad_id
              WHERE e.ride_id = ? AND e.kind = 'view' AND ${LIVE_WHERE}`)
    .get(ride.id, ride.city);
  if (!ad) {
    ad = db
      .prepare(`SELECT a.*, (SELECT COUNT(*) FROM ally_ad_events e WHERE e.ad_id = a.id AND e.kind = 'view'
                  AND e.created_at >= datetime('now', '-7 days')) AS views7
                FROM ally_ads a WHERE ${LIVE_WHERE} ORDER BY views7 ASC, RANDOM() LIMIT 1`)
      .get(ride.city);
    if (!ad) return res.json({ ad: null });
    db.prepare("INSERT OR IGNORE INTO ally_ad_events (ad_id, ride_id, kind) VALUES (?, ?, 'view')").run(ad.id, ride.id);
  }
  res.json({ ad: { id: ad.id, name: ad.name, tagline: ad.tagline, whatsapp: ad.whatsapp, image: imageUrl(ad) } });
});

// Toque en "Escribir por WhatsApp": se cuenta una vez por viaje.
router.post("/ally-ads/:id/tap", (req, res) => {
  const ride = rideFromToken(req);
  const ad = db.prepare("SELECT id, city FROM ally_ads WHERE id = ? AND deleted_at IS NULL").get(Number(req.params.id));
  if (!ride || !ad || ad.city !== ride.city) return res.status(404).json({ error: "No encontrado" });
  db.prepare("INSERT OR IGNORE INTO ally_ad_events (ad_id, ride_id, kind) VALUES (?, ?, 'tap')").run(ad.id, ride.id);
  res.json({ ok: true });
});

// Logo del negocio (la URL lleva un código del contenido: caché larga).
router.get("/ally-ads/:id/img/:hash", (req, res) => {
  const ad = db.prepare("SELECT image FROM ally_ads WHERE id = ?").get(Number(req.params.id));
  if (!ad || !ad.image || imageHash(ad.image) !== req.params.hash) return res.status(404).end();
  const m = IMAGE_RE.exec(ad.image);
  if (!m) return res.status(404).end();
  res.set({ "Content-Type": m[1], "Cache-Control": "public, max-age=31536000, immutable" });
  res.send(Buffer.from(ad.image.slice(m[0].length), "base64"));
});

// ---------------- Admin ----------------

router.post("/admin/ally-ads/list", checkAdminPin, (req, res) => {
  const ads = db
    .prepare(`SELECT a.id, a.name, a.tagline, a.whatsapp, a.image, a.tier, a.active, a.starts_on, a.ends_on, a.created_at,
                (SELECT COUNT(*) FROM ally_ad_events e WHERE e.ad_id = a.id AND e.kind = 'view') AS views,
                (SELECT COUNT(*) FROM ally_ad_events e WHERE e.ad_id = a.id AND e.kind = 'view' AND e.created_at >= datetime('now', '-7 days')) AS views7,
                (SELECT COUNT(*) FROM ally_ad_events e WHERE e.ad_id = a.id AND e.kind = 'tap') AS taps,
                (SELECT COUNT(*) FROM ally_ad_events e WHERE e.ad_id = a.id AND e.kind = 'tap' AND e.created_at >= datetime('now', '-7 days')) AS taps7
              FROM ally_ads a WHERE a.city = ? AND a.deleted_at IS NULL ORDER BY a.created_at DESC`)
    .all(req.adminCity)
    .map((a) => ({ ...a, image: imageUrl(a), active: !!a.active }));
  res.json({ enabled: isEnabled(req.adminCity), ads });
});

router.post("/admin/ally-ads/enabled", checkAdminPin, (req, res) => {
  const enabled = req.body.enabled ? 1 : 0;
  db.prepare("INSERT INTO ally_settings (city, enabled) VALUES (?, ?) ON CONFLICT(city) DO UPDATE SET enabled = excluded.enabled")
    .run(req.adminCity, enabled);
  res.json({ enabled: !!enabled });
});

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
router.post("/admin/ally-ads/save", checkAdminPin, (req, res) => {
  const { id, name, tagline, whatsapp, image, tier, active, startsOn, endsOn } = req.body;
  const cleanName = String(name || "").trim().slice(0, 40);
  const cleanTag = String(tagline || "").trim().slice(0, 60);
  const phone = String(whatsapp || "").replace(/\D/g, "");
  if (!cleanName) return res.status(400).json({ error: "Falta el nombre del negocio" });
  if (phone.length !== 10) return res.status(400).json({ error: "El WhatsApp del negocio debe tener 10 dígitos" });
  if (image != null && (typeof image !== "string" || image.length > MAX_IMAGE_LENGTH || !IMAGE_RE.test(image))) {
    return res.status(400).json({ error: "El logo no es válido o es muy pesado" });
  }
  for (const d of [startsOn, endsOn]) if (d && !DATE_RE.test(d)) return res.status(400).json({ error: "Fecha no válida" });
  if (startsOn && endsOn && endsOn < startsOn) return res.status(400).json({ error: "La fecha final es antes que la inicial" });
  const cleanTier = tier === "pagado" ? "pagado" : "aliado";

  if (id) {
    const row = db.prepare("SELECT city FROM ally_ads WHERE id = ? AND deleted_at IS NULL").get(Number(id));
    if (!row || row.city !== req.adminCity) return res.status(404).json({ error: "No encontrado" });
    db.prepare(`UPDATE ally_ads SET name = ?, tagline = ?, whatsapp = ?, tier = ?, active = ?, starts_on = ?, ends_on = ?,
                  image = COALESCE(?, image), updated_at = datetime('now') WHERE id = ?`)
      .run(cleanName, cleanTag, phone, cleanTier, active === false ? 0 : 1, startsOn || null, endsOn || null, image || null, Number(id));
    return res.json({ ok: true, id: Number(id) });
  }
  const info = db
    .prepare("INSERT INTO ally_ads (city, name, tagline, whatsapp, image, tier, active, starts_on, ends_on) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)")
    .run(req.adminCity, cleanName, cleanTag, phone, image || null, cleanTier, active === false ? 0 : 1, startsOn || null, endsOn || null);
  res.json({ ok: true, id: Number(info.lastInsertRowid) });
});

router.post("/admin/ally-ads/:id/active", checkAdminPin, (req, res) => {
  const row = db.prepare("SELECT city FROM ally_ads WHERE id = ? AND deleted_at IS NULL").get(Number(req.params.id));
  if (!row || row.city !== req.adminCity) return res.status(404).json({ error: "No encontrado" });
  db.prepare("UPDATE ally_ads SET active = ?, updated_at = datetime('now') WHERE id = ?").run(req.body.active ? 1 : 0, Number(req.params.id));
  res.json({ ok: true });
});

router.post("/admin/ally-ads/:id/delete", checkAdminPin, (req, res) => {
  const row = db.prepare("SELECT city FROM ally_ads WHERE id = ? AND deleted_at IS NULL").get(Number(req.params.id));
  if (!row || row.city !== req.adminCity) return res.status(404).json({ error: "No encontrado" });
  db.prepare("UPDATE ally_ads SET deleted_at = datetime('now'), active = 0 WHERE id = ?").run(Number(req.params.id));
  res.json({ ok: true });
});

module.exports = router;
