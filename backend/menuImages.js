// Fotos del menú y del perfil de los negocios (Comida y negocios, 2-oct).
// A diferencia de las fotos de perfil (photos.js), estas NO van dentro de la
// base: un negocio puede subir decenas de platillos y la base se volvería
// pesada (ver la auditoría de Postgres del 28-sep). Se guardan como archivo en
// data/menu/ — el disco persistente de Render — con el nombre sacado de su
// contenido, así una URL nunca cambia de imagen y se puede guardar en caché
// para siempre. El navegador ya las manda recortadas y comprimidas.
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const express = require("express");

const MENU_DIR = path.join(__dirname, "data", "menu");
const MAX_DATA_URL = 700000; // ~500 KB de imagen
const DATA_URL_RE = /^data:image\/(jpeg|png|webp);base64,/;
const FILE_RE = /^[a-f0-9]{20}\.(jpg|png|webp)$/;
const EXT = { jpeg: "jpg", png: "png", webp: "webp" };

// Guarda la imagen y devuelve su nombre de archivo, o null si no es válida.
function saveImage(dataUrl) {
  if (typeof dataUrl !== "string" || dataUrl.length > MAX_DATA_URL) return null;
  const m = DATA_URL_RE.exec(dataUrl);
  if (!m) return null;
  const buf = Buffer.from(dataUrl.slice(m[0].length), "base64");
  if (!buf.length) return null;
  const name = crypto.createHash("sha256").update(buf).digest("hex").slice(0, 20) + "." + EXT[m[1]];
  fs.mkdirSync(MENU_DIR, { recursive: true });
  const file = path.join(MENU_DIR, name);
  if (!fs.existsSync(file)) fs.writeFileSync(file, buf);
  return name;
}

function imageUrl(name) {
  return name ? `/api/menu-img/${name}` : null;
}

const router = express.Router();

// El menú es público (lo ve cualquier cliente), así que las fotos también.
router.get("/menu-img/:file", (req, res) => {
  const { file } = req.params;
  if (!FILE_RE.test(file)) return res.status(404).end();
  const full = path.join(MENU_DIR, file);
  if (!fs.existsSync(full)) return res.status(404).end();
  res.set("Cache-Control", "public, max-age=31536000, immutable");
  res.sendFile(full);
});

module.exports = { router, saveImage, imageUrl, MENU_DIR };
