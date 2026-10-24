// Límite de intentos fallidos de PIN (chofer y admin) por IP. Sin esto,
// alguien podría probar los ~9,000 PIN de 4 dígitos posibles con un script
// y "entrar" como cualquier chofer al azar — nada se lo impedía.
//
// Solo cuenta intentos FALLIDOS (PIN equivocado): un chofer que reintenta
// varias veces con el PIN correcto (o el admin, que reenvía su PIN en cada
// acción) nunca se bloquea. En memoria nomás — reiniciar el server limpia
// los contadores, y eso está bien para este caso de uso.

const WINDOW_MS = 15 * 60 * 1000; // 15 minutos
const MAX_FAILED_ATTEMPTS = 15;

const failedAttempts = new Map(); // ip -> { count, resetAt }

// Límite por CUENTA (23-oct-2026), además del de IP: quien cambia de IP
// (datos móviles, varias conexiones) ya no puede probar PINs sin tope contra
// el mismo teléfono o chofer. Suave a propósito, porque un bloqueo también
// frena a la persona real: 10 PINs distintos equivocados en 1 hora bloquean
// esa cuenta 30 minutos, y queda anotado en el registro del admin.
// "Cuenta" = el teléfono que venga en el body (phone / riderPhone /
// rider_phone, pasajero o chofer) y/o el driverId. El mismo PIN equivocado
// repetido (una app vieja reintentando) cuenta una sola vez.
// No se usa en el admin ni en entrar con código o huella (no son PIN).
const ACCOUNT_WINDOW_MS = 60 * 60 * 1000;
const ACCOUNT_MAX_FAILED = 10;
const ACCOUNT_LOCK_MS = 30 * 60 * 1000;
const accountFails = new Map(); // cuenta -> { pins: Map(pin -> ms), lockedUntil }
let onAccountLocked = null;

function accountKeys(body) {
  const keys = [];
  if (!body || typeof body !== "object") return keys;
  const phone = body.phone ?? body.riderPhone ?? body.rider_phone;
  const digits = phone != null ? String(phone).replace(/\D/g, "") : "";
  if (digits.length >= 8) keys.push("tel:" + digits);
  const driverId = Number(body.driverId);
  if (Number.isInteger(driverId) && driverId > 0) keys.push("chofer:" + driverId);
  return keys;
}

function accountLocked(key, now) {
  const entry = accountFails.get(key);
  return !!(entry && entry.lockedUntil > now);
}

function recordAccountFailure(key, pin, ip, now) {
  let entry = accountFails.get(key);
  if (!entry) {
    if (accountFails.size > 20000) {
      for (const [k, e] of accountFails) {
        if (e.lockedUntil <= now && ![...e.pins.values()].some((t) => now - t < ACCOUNT_WINDOW_MS)) accountFails.delete(k);
      }
    }
    entry = { pins: new Map(), lockedUntil: 0 };
    accountFails.set(key, entry);
  }
  for (const [p, t] of entry.pins) if (now - t >= ACCOUNT_WINDOW_MS) entry.pins.delete(p);
  entry.pins.set(String(pin ?? ""), now);
  if (entry.pins.size >= ACCOUNT_MAX_FAILED && entry.lockedUntil <= now) {
    entry.lockedUntil = now + ACCOUNT_LOCK_MS;
    entry.pins.clear();
    if (onAccountLocked) {
      try { onAccountLocked({ account: key, ip }); } catch {}
    }
  }
}

// body (opcional): el req.body de la ruta, para el límite por cuenta.
function isRateLimited(ip, body) {
  const now = Date.now();
  if (accountKeys(body).some((k) => accountLocked(k, now))) return true;
  const entry = failedAttempts.get(ip);
  if (!entry || now > entry.resetAt) return false;
  return entry.count >= MAX_FAILED_ATTEMPTS;
}

function recordFailedAttempt(ip, body) {
  const now = Date.now();
  let entry = failedAttempts.get(ip);
  if (!entry || now > entry.resetAt) {
    entry = { count: 0, resetAt: now + WINDOW_MS };
    failedAttempts.set(ip, entry);
  }
  entry.count++;
  const pin = body && (body.pin ?? body.riderPin ?? body.rider_pin);
  for (const key of accountKeys(body)) recordAccountFailure(key, pin, ip, now);
}

// Entró con código por WhatsApp o con huella: ya probó que el número es
// suyo, así que su cuenta se desbloquea (si no, la app — que usa el PIN por
// dentro — seguía frenada hasta 30 min).
function clearAccount(body) {
  for (const key of accountKeys(body)) accountFails.delete(key);
}

// Para el aviso en el registro del admin (lo conecta server.js).
function setOnAccountLocked(fn) {
  onAccountLocked = fn;
}

function clearAttempts(ip) {
  failedAttempts.delete(ip);
}

const RATE_LIMIT_MESSAGE = "Demasiados intentos. Espera unos minutos e intenta de nuevo.";

// Límite aparte (no comparte contador con lo de arriba) para formularios
// públicos sin PIN, como /chofer-solicitudes: ahí no hay "intento fallido"
// que contar, pero sin ningún tope alguien podría mandar cientos de
// solicitudes con fotos pesadas y llenar el disco del servidor. Mezclarlo
// con el limitador de PIN bloquearía de paso el login real de choferes o
// admin desde esa misma IP.
// Generoso a propósito: los celulares en México suelen compartir IP pública
// por el NAT de su operador, así que varias personas reales registrándose
// el mismo día (ej. una tanda de reclutamiento) pueden verse como "la misma
// IP" — esto solo busca frenar un script, no gente real coincidiendo.
const SUBMISSION_WINDOW_MS = 60 * 60 * 1000; // 1 hora
const MAX_SUBMISSIONS = 20;
const submissions = new Map(); // ip -> { count, resetAt }

function isSubmissionRateLimited(ip) {
  const entry = submissions.get(ip);
  if (!entry || Date.now() > entry.resetAt) return false;
  return entry.count >= MAX_SUBMISSIONS;
}

function recordSubmission(ip) {
  const now = Date.now();
  let entry = submissions.get(ip);
  if (!entry || now > entry.resetAt) {
    entry = { count: 0, resetAt: now + SUBMISSION_WINDOW_MS };
    submissions.set(ip, entry);
  }
  entry.count++;
}

module.exports = {
  isRateLimited, recordFailedAttempt, clearAttempts, RATE_LIMIT_MESSAGE,
  isSubmissionRateLimited, recordSubmission, setOnAccountLocked, clearAccount,
};
