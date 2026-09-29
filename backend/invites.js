// "Invita a otro chofer": cada chofer tiene un código propio (ej. K7P2QX) que
// va en su link de invitación (quiero-ser-chofer.html?inv=K7P2QX). Es un
// código al azar y no el id del chofer para que nadie pueda ir cambiando el
// número del link y sacar los nombres de todos los choferes.
const crypto = require("node:crypto");

// Sin 0/O ni 1/I/L: se confunden si alguien lo dicta o lo copia a mano.
const ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
const CODE_LENGTH = 6;

function randomCode() {
  const bytes = crypto.randomBytes(CODE_LENGTH);
  let code = "";
  for (let i = 0; i < CODE_LENGTH; i++) code += ALPHABET[bytes[i] % ALPHABET.length];
  return code;
}

// Devuelve el código del chofer, creándolo si todavía no tiene.
function ensureInviteCode(db, driverId) {
  const row = db.prepare("SELECT invite_code FROM drivers WHERE id = ?").get(driverId);
  if (!row) return null;
  if (row.invite_code) return row.invite_code;
  for (let i = 0; i < 10; i++) {
    const code = randomCode();
    try {
      db.prepare("UPDATE drivers SET invite_code = ? WHERE id = ? AND invite_code IS NULL").run(code, driverId);
      return db.prepare("SELECT invite_code FROM drivers WHERE id = ?").get(driverId).invite_code;
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

function findInviter(db, code) {
  const clean = normalizeCode(code);
  if (!clean) return null;
  return db
    .prepare("SELECT id, name, phone, city FROM drivers WHERE invite_code = ? AND deleted_at IS NULL")
    .get(clean) || null;
}

// "Carlos Méndez Pérez" → "Carlos M." — lo que ve cualquiera que abra el
// link, así que no se enseña el nombre completo.
function shortName(name) {
  const parts = String(name || "").trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return "";
  return parts.length > 1 ? `${parts[0]} ${parts[1][0].toUpperCase()}.` : parts[0];
}

module.exports = { ensureInviteCode, findInviter, shortName };
