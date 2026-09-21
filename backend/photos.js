// Fotos de perfil servidas como archivo aparte, en vez de pegadas (en base64,
// ~130 KB cada una) dentro de cada mensaje de viaje.
//
// Privacidad: la URL lleva un código sacado del contenido de la propia foto.
// Solo lo conoce quien lo recibió dentro de un viaje o un login, y no se puede
// adivinar probando ids — así no se reabre lo que cerró el arreglo de
// privacidad de choferes (la lista pública "disponibles" sigue sin fotos).
// El código también cambia cuando la persona sube otra foto, por eso la URL
// se puede guardar en caché "para siempre".
const crypto = require("node:crypto");
const express = require("express");
const db = require("./db");

const TABLES = { d: "drivers", r: "riders" };
const MAX_THUMB_LENGTH = 100000;
const DATA_URL_RE = /^data:(image\/(?:jpeg|png|webp));base64,/;

function hashOf(photo) {
  return crypto.createHash("sha256").update(photo).digest("hex").slice(0, 16);
}

// kind: "d" (chofer) | "r" (pasajero). Devuelve URLs (o null si no hay foto):
// `photo` = miniatura (avatares, tarjetas, perfil), `photoFull` = foto grande.
function photoUrls(kind, id, photo) {
  if (!photo) return { photo: null, photoFull: null };
  const base = `/api/photo/${kind}/${id}/${hashOf(photo)}`;
  return { photo: `${base}/t`, photoFull: `${base}/f` };
}

// La miniatura es opcional: si no viene o no es válida, se ignora (la foto
// grande sirve de respaldo) en vez de rechazar la subida completa.
function cleanThumb(thumb) {
  if (typeof thumb !== "string" || thumb.length > MAX_THUMB_LENGTH || !DATA_URL_RE.test(thumb)) return null;
  return thumb;
}

const router = express.Router();

router.get("/photo/:kind/:id/:hash/:size", (req, res) => {
  const table = TABLES[req.params.kind];
  const { size, hash } = req.params;
  if (!table || (size !== "t" && size !== "f")) return res.status(404).end();

  const row = db.prepare(`SELECT photo, photo_thumb FROM ${table} WHERE id = ?`).get(Number(req.params.id));
  if (!row || !row.photo || hashOf(row.photo) !== hash) return res.status(404).end();

  const dataUrl = size === "t" && row.photo_thumb ? row.photo_thumb : row.photo;
  const match = DATA_URL_RE.exec(dataUrl);
  if (!match) return res.status(404).end();

  res.set({
    "Content-Type": match[1],
    "Cache-Control": "private, max-age=31536000, immutable",
  });
  res.send(Buffer.from(dataUrl.slice(match[0].length), "base64"));
});

module.exports = { router, photoUrls, cleanThumb };
