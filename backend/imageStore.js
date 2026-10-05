// Fotos de choferes y pasajeros (cara, miniatura, moto/placa, firma) como
// archivos en data/img/ — el disco persistente de Render — en vez de base64
// dentro de la base (paso 1 antes de Postgres, ver la auditoría del 28-sep).
// En la columna queda solo una referencia "img:<archivo>".
//
// El nombre del archivo es el sha256 del data URL completo: así
// photos.js saca el mismo código de la URL que antes (los primeros 16 hex
// del sha256 del data URL) sin volver a leer la foto, y los links que ya
// tienen guardados los celulares siguen funcionando.
//
// Las apps no cambian: lo que antes devolvía un data URL (admin) lo sigue
// devolviendo, armado desde el archivo con toDataUrl().
//
// Los comprobantes de anticipo NO pasan por aquí a propósito: se borran a los
// 90 días (retention.js) y no deben quedarse en el respaldo de GitHub.
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

const IMG_DIR = path.join(__dirname, "data", "img");
const DATA_URL_RE = /^data:image\/(jpeg|png|webp);base64,/;
const REF_RE = /^img:([a-f0-9]{32}\.(jpg|png|webp))$/;
const EXT = { jpeg: "jpg", png: "png", webp: "webp" };
const MIME = { jpg: "image/jpeg", png: "image/png", webp: "image/webp" };

// Columnas con fotos. Si se agrega una columna de foto nueva, va aquí.
const IMAGE_COLUMNS = {
  drivers: ["photo", "photo_thumb", "photo_placa", "signature"],
  riders: ["photo", "photo_thumb"],
  driver_applications: ["photo", "photo_placa", "signature"],
};

function isRef(value) {
  return typeof value === "string" && REF_RE.test(value);
}

// Para el código de la URL de photos.js: el mismo que daba el data URL.
function refHash(ref) {
  return REF_RE.exec(ref)[1].slice(0, 16);
}

// Data URL → archivo en disco + referencia. null/vacío → null. Lo que ya es
// referencia (o algo que no es imagen) se regresa tal cual.
function toStored(value) {
  if (value == null || value === "") return null;
  if (typeof value !== "string") return value;
  const m = DATA_URL_RE.exec(value);
  if (!m) return value;
  const name = crypto.createHash("sha256").update(value).digest("hex").slice(0, 32) + "." + EXT[m[1]];
  const file = path.join(IMG_DIR, name);
  if (!fs.existsSync(file)) {
    fs.mkdirSync(IMG_DIR, { recursive: true });
    // Primero a un temporal y luego renombrar: si el servidor se apaga a
    // media escritura no queda un archivo cortado con el nombre bueno.
    const tmp = file + ".tmp";
    fs.writeFileSync(tmp, Buffer.from(value.slice(m[0].length), "base64"));
    fs.renameSync(tmp, file);
  }
  return "img:" + name;
}

// { type, buffer } de una foto guardada (referencia o data URL viejo).
function readImage(value) {
  if (typeof value !== "string") return null;
  const m = DATA_URL_RE.exec(value);
  if (m) return { type: `image/${m[1]}`, buffer: Buffer.from(value.slice(m[0].length), "base64") };
  const r = REF_RE.exec(value);
  if (!r) return null;
  try {
    return { type: MIME[r[2]], buffer: fs.readFileSync(path.join(IMG_DIR, r[1])) };
  } catch {
    return null;
  }
}

// Referencia → data URL, para las respuestas que siempre mandaron la foto
// completa (admin). Lo que no es referencia se regresa tal cual.
function toDataUrl(value) {
  if (!isRef(value)) return value;
  const img = readImage(value);
  return img ? `data:${img.type};base64,${img.buffer.toString("base64")}` : null;
}

// Devuelve una copia de la fila con sus columnas de foto como data URL.
function inflateRow(row, cols) {
  if (!row) return row;
  const out = { ...row };
  for (const c of cols) if (c in out) out[c] = toDataUrl(out[c]);
  return out;
}

// Una sola vez por foto: pasa los data URL que sigan en la base a archivos.
// Corre al arrancar; si ya no queda ninguno no hace nada. Al final compacta la
// base (VACUUM) para que el archivo de verdad se haga chico.
function migrateImagesToFiles(db) {
  let moved = 0;
  for (const [table, cols] of Object.entries(IMAGE_COLUMNS)) {
    for (const col of cols) {
      const rows = db.prepare(`SELECT id, ${col} AS v FROM ${table} WHERE ${col} LIKE 'data:%'`).all();
      const update = db.prepare(`UPDATE ${table} SET ${col} = ? WHERE id = ? AND ${col} = ?`);
      for (const row of rows) {
        const ref = toStored(row.v);
        if (ref === row.v) continue; // data URL raro que no es imagen: se queda
        // Se revisa que el archivo quedó bien antes de soltar la foto de la base.
        const back = readImage(ref);
        if (!back || back.buffer.toString("base64") !== row.v.slice(row.v.indexOf(",") + 1)) {
          console.error(`[img] no se pudo verificar ${table}.${col} id=${row.id}; se deja en la base`);
          continue;
        }
        moved += update.run(ref, row.id, row.v).changes;
      }
    }
  }
  if (moved) {
    console.log(`[img] ${moved} foto(s) pasadas de la base a data/img/`);
    db.exec("VACUUM");
  }
  return moved;
}

// Borra archivos de data/img/ que ya ninguna fila usa (alguien cambió su foto
// o se borró un pasajero). Solo los de más de 1 hora, para no pisar una foto
// que se acaba de guardar y cuya fila todavía no se escribe.
function pruneUnusedImages(db) {
  if (!fs.existsSync(IMG_DIR)) return 0;
  const used = new Set();
  for (const [table, cols] of Object.entries(IMAGE_COLUMNS)) {
    for (const col of cols) {
      for (const { v } of db.prepare(`SELECT ${col} AS v FROM ${table} WHERE ${col} LIKE 'img:%'`).all()) {
        used.add(v.slice(4));
      }
    }
  }
  const cutoff = Date.now() - 60 * 60 * 1000;
  let removed = 0;
  for (const name of fs.readdirSync(IMG_DIR)) {
    const full = path.join(IMG_DIR, name);
    if (used.has(name) || fs.statSync(full).mtimeMs > cutoff) continue;
    fs.unlinkSync(full);
    removed++;
  }
  if (removed) console.log(`[img] ${removed} foto(s) sin usar borradas`);
  return removed;
}

module.exports = {
  IMG_DIR, IMAGE_COLUMNS, isRef, refHash, toStored, readImage, toDataUrl, inflateRow,
  migrateImagesToFiles, pruneUnusedImages,
};
