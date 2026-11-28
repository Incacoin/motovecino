// "Invita a otro chofer": cada chofer tiene un código propio (ej. K7P2QX) que
// va en su link de invitación (quiero-ser-chofer.html?inv=K7P2QX). Es un
// código al azar y no el id del chofer para que nadie pueda ir cambiando el
// número del link y sacar los nombres de todos los choferes.
const crypto = require("node:crypto");

// Sin 0/O ni 1/I/L: se confunden si alguien lo dicta o lo copia a mano.
const ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
const CODE_LENGTH = 6;

function randomCode(len = CODE_LENGTH) {
  const bytes = crypto.randomBytes(len);
  let code = "";
  for (let i = 0; i < len; i++) code += ALPHABET[bytes[i] % ALPHABET.length];
  return code;
}

// "Invita a tu vecino" (25-nov-2026): el código del PASAJERO es de 7 letras
// (el del chofer, de 6) para saber de quién es con solo verlo.
const RIDER_CODE_LENGTH = 7;

// Devuelve el código del chofer, creándolo si todavía no tiene.
async function ensureInviteCode(db, driverId) {
  const row = await db.prepare("SELECT invite_code FROM drivers WHERE id = ?").get(driverId);
  if (!row) return null;
  if (row.invite_code) return row.invite_code;
  for (let i = 0; i < 10; i++) {
    const code = randomCode();
    try {
      await db.prepare("UPDATE drivers SET invite_code = ? WHERE id = ? AND invite_code IS NULL").run(code, driverId);
      return (await db.prepare("SELECT invite_code FROM drivers WHERE id = ?").get(driverId)).invite_code;
    } catch {
      // choque con el índice único (casi imposible) — se intenta otro
    }
  }
  return null;
}

function normalizeCode(code) {
  if (typeof code !== "string") return null;
  const clean = code.trim().toUpperCase();
  return /^[A-Z0-9]{4,12}$/.test(clean) ? clean : null;
}

async function findInviter(db, code) {
  const clean = normalizeCode(code);
  if (!clean) return null;
  return (await db
    .prepare("SELECT id, name, phone, city FROM drivers WHERE invite_code = ? AND deleted_at IS NULL")
    .get(clean)) || null;
}

// "Carlos Méndez Pérez" → "Carlos M." — solo para la lista de invitados que ve
// el propio chofer que invitó. El link público ya NO enseña el nombre de quien
// invita (23-nov-2026, ver /drivers/invite/:code): no volver a ponerlo.
function shortName(name) {
  const parts = String(name || "").trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return "";
  return parts.length > 1 ? `${parts[0]} ${parts[1][0].toUpperCase()}.` : parts[0];
}

// Código del pasajero (lo crea la primera vez que lo pide).
async function ensureRiderInviteCode(db, riderId) {
  const row = await db.prepare("SELECT invite_code FROM riders WHERE id = ?").get(riderId);
  if (!row) return null;
  if (row.invite_code) return row.invite_code;
  for (let i = 0; i < 10; i++) {
    const code = randomCode(RIDER_CODE_LENGTH);
    try {
      await db.prepare("UPDATE riders SET invite_code = ? WHERE id = ? AND invite_code IS NULL").run(code, riderId);
      return (await db.prepare("SELECT invite_code FROM riders WHERE id = ?").get(riderId)).invite_code;
    } catch (e) {
      // choque con el índice único (casi imposible) — se intenta otro.
      // Cualquier otro error se avisa: si no, la opción desaparece sin rastro.
      if (!db.isUniqueViolation(e)) throw e;
    }
  }
  console.error("[invita-vecino] no se pudo crear código para el pasajero", riderId);
  return null;
}

async function findRiderInviter(db, code) {
  const clean = normalizeCode(code);
  if (!clean || clean.length !== RIDER_CODE_LENGTH) return null;
  return (await db.prepare("SELECT id, phone FROM riders WHERE invite_code = ?").get(clean)) || null;
}

// Promotores (27-nov-2026): su código es de 5 letras (chofer 6, pasajero 7).
const PROMOTER_CODE_LENGTH = 5;

async function findPromoter(db, code) {
  const clean = normalizeCode(code);
  if (!clean || clean.length !== PROMOTER_CODE_LENGTH) return null;
  return (await db.prepare("SELECT id, phone, city FROM promoters WHERE code = ? AND active = 1").get(clean)) || null;
}

module.exports = { ensureInviteCode, findInviter, shortName, ensureRiderInviteCode, findRiderInviter, RIDER_CODE_LENGTH, randomCode, findPromoter, PROMOTER_CODE_LENGTH };
