// Pasajeros que piden y no salen (26-nov-2026). Ticul: un pasajero nuevo pidió
// varias veces ofreciendo de más, nunca salió y no contestó. Cada viaje falso
// le cuesta gasolina y tiempo al chofer.
//
// Dos frenos, los dos por NÚMERO de teléfono (el registro exige código por
// WhatsApp, así que detrás hay un número real):
//  1) Bloqueo a mano desde el panel (tabla blocked_phones). Sigue aunque se
//     borre la cuenta y se registre otra vez con el mismo número.
//  2) Pausa automática: AUTO_LIMIT veces «El pasajero no llegó» en AUTO_DAYS
//     días, de al menos AUTO_MIN_DRIVERS choferes distintos (un solo chofer
//     no puede pausar a nadie). Solo cuentan viajes donde el chofer ya había
//     marcado «Llegué» (arrived_at_ms): cancelar desde lejos con ese motivo
//     no cuenta. Se quita con «Desbloquear» en el panel, que
//     pone riders.no_show_reset_at y desde ahí se vuelve a contar.
// Ninguno de los dos toca viajes ya en curso: solo impide pedir nuevos.
const db = require("./db");

const NO_SHOW_REASON = "El pasajero no llegó"; // texto exacto del botón en chofer.html
const AUTO_LIMIT = 3;
const AUTO_DAYS = 7;
const AUTO_MIN_DRIVERS = 2;

const MSG_MANUAL = "Tu cuenta está pausada. Escríbenos desde «Ayuda» para saber más.";
const MSG_AUTO = "Tu cuenta está pausada porque varios choferes reportaron que no llegaste al punto de encuentro. Escríbenos desde «Ayuda» para reactivarla.";

// Faltas recientes (después del último «Desbloquear»).
async function recentNoShows(riderId) {
  const row = await db.prepare(
    `SELECT COUNT(*) AS n, COUNT(DISTINCT r.driver_id) AS choferes
     FROM rides r JOIN riders p ON p.id = r.rider_id
     WHERE r.rider_id = ? AND r.status = 'cancelado' AND r.cancelled_by = 'driver'
       AND r.cancel_reason = ? AND r.arrived_at_ms IS NOT NULL
       AND r.updated_at >= datetime('now', '-${AUTO_DAYS} days')
       AND (p.no_show_reset_at IS NULL OR r.updated_at > p.no_show_reset_at)`
  ).get(riderId, NO_SHOW_REASON);
  return { n: Number(row?.n) || 0, choferes: Number(row?.choferes) || 0 };
}

// null si puede pedir; si no, { manual, message }.
async function riderBlock(rider) {
  if (!rider) return null;
  const manual = await db.prepare("SELECT phone FROM blocked_phones WHERE phone = ?").get(rider.phone);
  if (manual) return { manual: true, message: MSG_MANUAL };
  const { n, choferes } = await recentNoShows(rider.id);
  if (n >= AUTO_LIMIT && choferes >= AUTO_MIN_DRIVERS) return { manual: false, message: MSG_AUTO };
  return null;
}

// Para las rutas: responde 403 y regresa true si está pausado.
async function rejectIfBlocked(rider, res) {
  const b = await riderBlock(rider);
  if (!b) return false;
  res.status(403).json({ error: b.message, blocked: true });
  return true;
}

module.exports = { riderBlock, rejectIfBlocked, recentNoShows, NO_SHOW_REASON, AUTO_LIMIT, AUTO_DAYS, AUTO_MIN_DRIVERS };
