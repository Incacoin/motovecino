// Avisos de errores del servidor (23-oct-2026). UptimeRobot ya avisa por
// correo si la app se cae completa (/api/health) o si falla el respaldo
// (/api/backup-health); esto cubre lo que faltaba: errores con la app
// arriba (una ruta que truena, una tarea de fondo que falla).
//   - Cada error queda en Movimientos del admin (Tekax), máximo uno igual
//     cada 10 min para no llenarlo si algo truena en cada petición.
//   - /api/errors-health responde 500 si hubo 3 o más en 15 min: un monitor
//     de UptimeRobot apuntado ahí manda el correo de siempre.
// Todo en memoria (reiniciar el server limpia la cuenta, igual que
// pinRateLimit.js); el detalle completo sigue en los logs de Render.
const db = require("./db");

const WINDOW_MS = 15 * 60 * 1000;
const ALERT_AT = 3;
const SAME_ERROR_MS = 10 * 60 * 1000;

// Errores de Postgres por un dato que no cabe o no es del tipo (ej. un
// driverId de 14 dígitos): es basura que mandó alguien, no una falla de la
// app — no cuenta (si no, cualquiera podía disparar alarmas falsas).
const BAD_INPUT_PG_CODES = new Set(["22003", "22P02", "22007", "22008", "22001"]);
function isBadInput(err) {
  return !!(err && BAD_INPUT_PG_CODES.has(err.code));
}

let recent = []; // ms de cada error
const lastLogged = new Map(); // firma -> ms

function recordError(where, err) {
  if (isBadInput(err)) return;
  const now = Date.now();
  recent.push(now);
  if (recent.length > 500) recent = recent.slice(-500);

  const message = String((err && err.message) || err || "error").replace(/\s+/g, " ").slice(0, 160);
  const signature = `${where}|${message.slice(0, 80)}`;
  if (now - (lastLogged.get(signature) || 0) < SAME_ERROR_MS) return;
  if (lastLogged.size > 1000) lastLogged.clear();
  lastLogged.set(signature, now);
  db.prepare("INSERT INTO admin_audit (role, zone, action, target_id, detail, ip, ok) VALUES (?, ?, ?, ?, ?, ?, ?)")
    .run(null, null, "error_servidor", null, `${where} · ${message}`.slice(0, 400), null, 0)
    .catch((e) => console.error("[errorAlerts] no se pudo anotar:", e.message));
}

function recentErrorCount() {
  const since = Date.now() - WINDOW_MS;
  recent = recent.filter((t) => t >= since);
  return recent.length;
}

function errorsHealth() {
  const count = recentErrorCount();
  return { alert: count >= ALERT_AT, count };
}

module.exports = { recordError, errorsHealth, isBadInput };
