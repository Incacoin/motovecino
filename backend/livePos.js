// "Pizarrón": la última ubicación de cada chofer vive en memoria del servidor.
//
// Antes cada ubicación (cada 1-3 s por chofer) era un UPDATE en la base; la
// prueba de carga del 12-oct mostró que eso satura la base con ~100-300 motos
// conectadas. Ahora la ubicación se apunta aquí al instante y se pasa a la
// base en lote cada FLUSH_MS (una sola consulta para todos). Quien necesite
// la posición al momento (mapa, avisos de viaje) la lee de aquí con overlay();
// la base queda a lo mucho FLUSH_MS atrás, muy por debajo de
// DRIVER_STALE_SECONDS (90 s), así que los filtros por last_seen siguen igual.
const db = require("./db");

const FLUSH_MS = 10000;
const CHUNK = 500;

// driverId -> { lat, lng, at (ms) }
const live = new Map();
const dirty = new Set();

function set(driverId, lat, lng) {
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return;
  live.set(driverId, { lat, lng, at: Date.now() });
  dirty.add(driverId);
}

// Pone encima de una fila de la base la ubicación más nueva del pizarrón.
function overlay(row, driverId = row?.id) {
  if (!row) return row;
  const p = live.get(driverId);
  if (p) {
    row.lat = p.lat;
    row.lng = p.lng;
  }
  return row;
}

// Mismo formato que datetime('now') de SQLite (texto UTC), que es como la
// app guarda last_seen.
function sqlTime(ms) {
  return new Date(ms).toISOString().replace("T", " ").slice(0, 19);
}

let flushing = null;
async function flush() {
  if (flushing) return flushing;
  if (!dirty.size) return;
  const ids = [...dirty];
  dirty.clear();
  flushing = (async () => {
    for (let i = 0; i < ids.length; i += CHUNK) {
      const chunk = ids.slice(i, i + CHUNK).filter((id) => live.has(id));
      if (!chunk.length) continue;
      const values = [];
      const params = [];
      for (const id of chunk) {
        const p = live.get(id);
        values.push("(?::int, ?::double precision, ?::double precision, ?::text)");
        params.push(id, p.lat, p.lng, sqlTime(p.at));
      }
      try {
        await db
          .prepare(
            `UPDATE drivers AS d SET lat = v.lat, lng = v.lng, last_seen = v.seen
             FROM (VALUES ${values.join(", ")}) AS v(id, lat, lng, seen) WHERE d.id = v.id`
          )
          .run(...params);
      } catch (err) {
        // Se reintentan en la siguiente vuelta; la memoria sigue al día.
        for (const id of chunk) dirty.add(id);
        console.error("[livePos] no se pudo guardar ubicaciones:", err.message);
      }
    }
  })();
  try {
    await flushing;
  } finally {
    flushing = null;
  }
}

let timer = null;
function start() {
  if (timer) return;
  timer = setInterval(() => {
    flush().catch((err) => console.error("[livePos] error:", err));
  }, FLUSH_MS);
}

module.exports = { set, overlay, flush, start, FLUSH_MS };
