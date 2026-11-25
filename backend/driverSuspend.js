// Suspender chofer (26-nov-2026): para quien debe papeles (ej. dice ser de una
// agrupación y no los manda), no se reporta o no muestra interés. A diferencia
// de «Eliminar», se deshace con «Reactivar» y no pierde nada (historial,
// saldo, lugar de fundador). Mientras está suspendido:
//  - no puede ponerse «Disponible» ni le llegan solicitudes (realtime, push),
//  - no puede aceptar viajes ni agendados (rides.js, bookings.js),
//  - no cuenta como chofer en el panel ni sale en el padrón de su agrupación.
// drivers.suspended_at / suspended_reason / suspended_note.
const db = require("./db");

const SUSPEND_REASONS = {
  documentos: "Faltan documentos",
  reporte: "No se ha reportado",
  otro: "Otro motivo",
};

function suspendPayload(d) {
  return { reason: SUSPEND_REASONS[d.suspended_reason] || SUSPEND_REASONS.otro, note: d.suspended_note || null };
}

// Mensaje para el chofer si está suspendido; null si no.
async function driverSuspension(driverId) {
  const d = await db.prepare("SELECT suspended_at, suspended_reason, suspended_note FROM drivers WHERE id = ?").get(driverId);
  if (!d || !d.suspended_at) return null;
  return suspendPayload(d);
}

function suspendedText(p) {
  return `Tu cuenta está suspendida (${p.reason}). Comunícate con MotoVecino para reactivarla.`;
}

// Para las rutas de aceptar viajes: responde 403 y regresa true si está suspendido.
async function rejectIfSuspended(driverId, res) {
  const p = await driverSuspension(driverId);
  if (!p) return false;
  res.status(403).json({ error: suspendedText(p), suspended: true });
  return true;
}

module.exports = { SUSPEND_REASONS, suspendPayload, driverSuspension, suspendedText, rejectIfSuspended };
