// "Pedir para otra persona": la mamá pide el viaje desde SU cuenta para su hijo
// (ver POST /rides). Solo se guarda el nombre de quien se sube y una seña para
// reconocerlo; nunca su teléfono — el chofer habla con quien lo pidió por el
// chat de la app, igual que en cualquier viaje. Se lanza APAGADO por pueblo y
// se prende desde el admin cuando haya choferes de noche.
const express = require("express");
const db = require("../db");
const { checkAdminPin } = require("./admin");

// Tabla family_settings y columnas rides.for_name/for_note: ver schema.sql.

async function isFamilyEnabled(city) {
  const row = await db.prepare("SELECT enabled FROM family_settings WHERE city = ?").get(city);
  return !!(row && row.enabled);
}

// Mismo tapado que el chat (realtime.js): la seña no sirve para pasar números.
function maskPhones(text) {
  return text.replace(/\+?\d(?:[\s.\-()]*\d){6,}/g, (m) => m.replace(/\d/g, "•"));
}

// Lo que se guarda en el viaje, o null si no es para otra persona (o está apagado).
async function cleanForOther(city, forName, forNote) {
  if (typeof forName !== "string" || !(await isFamilyEnabled(city))) return null;
  const name = maskPhones(forName.trim().replace(/\s+/g, " ")).slice(0, 40);
  if (!name) return null;
  const note = typeof forNote === "string" ? maskPhones(forNote.trim().replace(/\s+/g, " ")).slice(0, 100) : "";
  return { name, note: note || null };
}

const router = express.Router();

router.post("/admin/family-rides", checkAdminPin, async (req, res) => {
  res.json({ enabled: await isFamilyEnabled(req.adminCity) });
});

router.post("/admin/family-rides/enabled", checkAdminPin, async (req, res) => {
  const enabled = req.body.enabled ? 1 : 0;
  await db.prepare("INSERT INTO family_settings (city, enabled) VALUES (?, ?) ON CONFLICT(city) DO UPDATE SET enabled = excluded.enabled")
    .run(req.adminCity, enabled);
  res.json({ enabled: !!enabled });
});

module.exports = { router, isFamilyEnabled, cleanForOther };
