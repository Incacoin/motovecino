const crypto = require("node:crypto");
const express = require("express");
const db = require("../db");
const { AVISO_LEGAL_VERSION, SERVICE_FEE, TAXI_COMMISSION_RATE, TAXI_COMMISSION_CAP, LAUNCH_DATE, TRIAL_END_DATE, DRIVER_STALE_SECONDS } = require("../constants");
const { recomputeFounders } = require("../founders");
const { isRateLimited, recordFailedAttempt, clearAttempts, RATE_LIMIT_MESSAGE } = require("../pinRateLimit");
const { getCityById, ADMIN_ZONES } = require("../cities");
const { rideFee } = require("../fees");
const { generateRiderPin } = require("./riders");
const { ensureInviteCode } = require("../invites");
const { creditBalance } = require("../referrals");
const { toStored, inflateRow } = require("../imageStore");
const {
  generateRegistrationOptions, verifyRegistrationResponse,
  generateAuthenticationOptions, verifyAuthenticationResponse,
} = require("@simplewebauthn/server");

// El admin siempre recibió las fotos completas (data URL); ahora viven en
// data/img/ y se arman al responder.
const DRIVER_IMG_COLS = ["photo", "photo_placa", "signature"];

const router = express.Router();

// Los ids son números: algo como /x/abc/... se contesta "no encontrado" (como
// antes con SQLite) en vez de un error de Postgres por el tipo de dato.
const numericParam = (req, res, next, value) => (/^\d{1,9}$/.test(value) ? next() : res.status(404).json({ error: "No encontrado" }));
router.param("id", numericParam);

// Un PIN de admin por ciudad — cada quien solo entra a la suya. Es la misma
// separación que ya existía al tener Tekax y Ticul como apps y bases de datos
// totalmente aparte; ahora que comparten base de datos, esto es lo que
// mantiene esa frontera. ADMIN_PIN (sin sufijo) queda como alias de Tekax
// para no invalidar el PIN que ya se venía usando.
const ADMIN_PINS = {
  tekax: process.env.ADMIN_PIN_TEKAX || process.env.ADMIN_PIN,
  ticul: process.env.ADMIN_PIN_TICUL,
  // Daniel (socio operador de Progreso): solo ve sus 4 comisarías.
  progreso: process.env.ADMIN_PIN_PROGRESO,
};

// ---- Sesiones (6-oct-2026) ----
// Se entra una vez con el PIN y el servidor da un pase (token) que viaja en
// la cabecera Authorization; el PIN ya no va en cada clic. El pase se cierra
// solo tras SESSION_IDLE_MS sin usarse, y como máximo dura SESSION_MAX_MS.
// En la base solo queda el sha256 del pase.
const SESSION_IDLE_MS = 12 * 60 * 60 * 1000;
const SESSION_MAX_MS = 7 * 24 * 60 * 60 * 1000;
const hashToken = (t) => crypto.createHash("sha256").update(t).digest("hex");

async function sessionFromReq(req) {
  const m = /^Bearer\s+([A-Za-z0-9_-]{30,100})$/.exec(req.get("authorization") || "");
  if (!m) return null;
  const s = await db.prepare("SELECT * FROM admin_sessions WHERE token_hash = ? AND revoked_at IS NULL").get(hashToken(m[1]));
  const now = Date.now();
  if (!s || now - s.last_seen_ms > SESSION_IDLE_MS || now > s.expires_ms) return null;
  // Que un rol cuyo PIN ya no existe (ej. se quitó el de Daniel) no siga entrando.
  if (!ADMIN_PINS[s.role]) return null;
  if (now - s.last_seen_ms > 60 * 1000) {
    await db.prepare("UPDATE admin_sessions SET last_seen_ms = ? WHERE id = ?").run(now, s.id);
  }
  return s;
}

async function createSession(role, req) {
  const token = crypto.randomBytes(32).toString("base64url");
  const now = Date.now();
  await db.prepare(
    "INSERT INTO admin_sessions (token_hash, role, created_ms, last_seen_ms, expires_ms, ip, user_agent) VALUES (?, ?, ?, ?, ?, ?, ?)"
  ).run(hashToken(token), role, now, now, now + SESSION_MAX_MS, req.ip || null, String(req.get("user-agent") || "").slice(0, 200));
  return token;
}

// ---- Registro de movimientos ----
// Lo que solo consulta no se anota (listas, resumen, reportes...).
const READ_ONLY_ACTION = /\/(list|stats|status|reports|payments|activity|pending-fees|session|audit|register-options)(\/|$)|^\/admin\/family-rides$/;
// Campos que nunca se guardan en el detalle (PINs, fotos, firmas).
const SECRET_FIELDS = new Set(["adminPin", "adminZone", "photo", "photoPlaca", "signature", "image", "logo", "cover", "pin"]);

async function audit({ role, zone, action, targetId, detail, ip, ok = 1 }) {
  await db.prepare(
    "INSERT INTO admin_audit (role, zone, action, target_id, detail, ip, ok) VALUES (?, ?, ?, ?, ?, ?, ?)"
  ).run(role || null, zone || null, action, targetId ?? null, detail || null, ip || null, ok ? 1 : 0);
}

function auditDetail(body) {
  const out = {};
  for (const [k, v] of Object.entries(body || {})) {
    if (SECRET_FIELDS.has(k) || v == null || typeof v === "object") continue;
    out[k] = String(v).slice(0, 80);
  }
  const txt = JSON.stringify(out);
  return txt === "{}" ? null : txt.slice(0, 400);
}

async function checkAdminPin(req, res, next) {
  if (isRateLimited(req.ip)) {
    return res.status(429).json({ error: RATE_LIMIT_MESSAGE });
  }
  let city;
  const session = await sessionFromReq(req);
  if (session) {
    city = session.role;
    req.adminSession = session;
  } else if (req.get("authorization")) {
    return res.status(401).json({ error: "Tu sesión se cerró. Vuelve a entrar con tu PIN.", sessionExpired: true });
  } else {
    city = Object.keys(ADMIN_PINS).find(
      (c) => ADMIN_PINS[c] && req.body.adminPin === ADMIN_PINS[c]
    );
  }
  if (!city) {
    recordFailedAttempt(req.ip);
    audit({ action: "login_fallido", ip: req.ip, ok: 0 }).catch(() => {});
    return res.status(401).json({ error: "PIN de admin incorrecto" });
  }
  clearAttempts(req.ip);
  // El PIN del dueño (Tekax) puede ver todas las zonas de ADMIN_ZONES con el
  // selector del admin, que manda adminZone en cada petición. Cualquier otro
  // PIN (Daniel, Ticul) solo ve la suya, mande lo que mande.
  const zones = city === "tekax" ? ADMIN_ZONES.map((z) => z.id) : [city];
  req.adminZones = zones;
  req.adminCity = zones.includes(req.body.adminZone) ? req.body.adminZone : zones[0];
  req.adminRole = city;
  // Al terminar, si fue una acción que cambia algo y salió bien, se anota.
  res.on("finish", () => {
    const action = req.route ? req.route.path : req.path;
    if (res.statusCode >= 400 || READ_ONLY_ACTION.test(action) || action === "/admin/login") return;
    audit({
      role: city, zone: req.adminCity, action,
      targetId: req.params.id != null ? Number(req.params.id) : null,
      detail: auditDetail(req.body), ip: req.ip,
    }).catch((e) => console.error("[audit]", e.message));
  });
  next();
}

function zoneInfo(id) {
  const z = ADMIN_ZONES.find((x) => x.id === id);
  return { id, label: z ? z.label : getCityById(id)?.label || id, enabled: z ? z.enabled : true };
}

// Confirma que el chofer/solicitud sobre el que se va a actuar es de la
// ciudad de este admin — sin esto, un admin de Tekax podría tocar a un
// chofer de Ticul con solo adivinar/probar su id.
async function assertOwnCity(table, req, res) {
  const row = await db.prepare(`SELECT city FROM ${table} WHERE id = ?`).get(req.params.id);
  if (!row || row.city !== req.adminCity) {
    res.status(404).json({ error: "No encontrado" });
    return false;
  }
  return true;
}

async function generateDriverPin() {
  let pin;
  do {
    pin = String(Math.floor(1000 + Math.random() * 9000));
  } while (await db.prepare("SELECT id FROM drivers WHERE pin = ?").get(pin));
  return pin;
}

// Entrar: con el PIN crea una sesión nueva y regresa su pase (token); con un
// pase vigente (la app se reabrió) solo confirma quién es.
router.post("/admin/login", checkAdminPin, async (req, res) => {
  let token;
  if (!req.adminSession) {
    token = await createSession(req.adminRole, req);
    await audit({ role: req.adminRole, zone: req.adminCity, action: "/admin/login", ip: req.ip });
  }
  res.json({
    ok: true,
    ...(token ? { token } : {}),
    role: req.adminRole,
    city: req.adminCity,
    cityLabel: zoneInfo(req.adminCity).label,
    // Más de una = el selector de zona del dueño.
    zones: req.adminZones.map(zoneInfo),
  });
});

router.post("/admin/drivers", checkAdminPin, async (req, res) => {
  const {
    name, phone, vehicle, tipo, acceptedLegal, photo, photoPlaca, signature, vehicleType, grupo,
    emergencyContactName, emergencyContactPhone, referredBy, referredByDriverId,
  } = req.body;
  if (!name || !phone) {
    return res.status(400).json({ error: "Falta nombre o teléfono" });
  }
  for (const img of [photo, photoPlaca, signature]) {
    if (img && (typeof img !== "string" || !/^data:image\/(jpeg|png|webp);base64,/.test(img))) {
      return res.status(400).json({ error: "Una de las fotos no es válida" });
    }
  }
  // La ciudad la decide el PIN con el que entró el admin, no un campo que
  // mande el navegador — así nadie puede darse de alta "en otra ciudad".
  const cityId = req.adminCity;
  if (!acceptedLegal) {
    return res.status(400).json({ error: "Confirma que el chofer aceptó el aviso legal" });
  }

  const existingPhone = await db
    .prepare("SELECT id, name FROM drivers WHERE phone = ? AND deleted_at IS NULL")
    .get(phone);
  if (existingPhone) {
    return res.status(409).json({
      error: `Ese teléfono ya está registrado con el chofer "${existingPhone.name}"`,
    });
  }

  const existingName = await db
    .prepare("SELECT id FROM drivers WHERE lower(trim(name)) = lower(trim(?)) AND deleted_at IS NULL")
    .get(name);
  if (existingName) {
    return res.status(409).json({
      error: `Ya hay un chofer registrado con el nombre "${name}"`,
    });
  }

  const pin = await generateDriverPin();

  // Viene de una solicitud que llegó con el link "Invita a otro chofer": el
  // que invitó tiene que ser un chofer real de esta misma ciudad.
  const inviterId = Number.isInteger(referredByDriverId)
    ? (await db.prepare("SELECT id FROM drivers WHERE id = ? AND city = ? AND deleted_at IS NULL").get(referredByDriverId, cityId))?.id ?? null
    : null;

  const result = await db
    .prepare(
      "INSERT INTO drivers (name, phone, vehicle, pin, tipo, accepted_legal_at, accepted_legal_version, photo, photo_placa, signature, vehicle_type, grupo, city, emergency_contact_name, emergency_contact_phone, referred_by, referred_by_driver_id, es_fundador) VALUES (?, ?, ?, ?, ?, datetime('now'), ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"
    )
    .run(
      name, phone, vehicle || null, pin, tipo === "formal" ? "formal" : "informal", AVISO_LEGAL_VERSION, toStored(photo), toStored(photoPlaca), toStored(signature), vehicleType === "taxi" ? "taxi" : "moto", grupo || null, cityId,
      emergencyContactName || null, emergencyContactPhone || null, referredBy || null, inviterId, 0
    );
  await ensureInviteCode(db, result.lastInsertRowid);
  // Insignia de "chofer fundador" (simbólica, por haberse sumado temprano):
  // la decide recomputeFounders, que no cuenta las cuentas de prueba.
  await recomputeFounders(db);

  const driver = await db
    .prepare("SELECT id, name, phone, vehicle, pin, status, tipo, photo, photo_placa, signature, vehicle_type, grupo, city, emergency_contact_name, emergency_contact_phone, referred_by, es_fundador FROM drivers WHERE id = ?")
    .get(result.lastInsertRowid);

  res.status(201).json(inflateRow(driver, DRIVER_IMG_COLS));
});

router.post("/admin/drivers/list", checkAdminPin, async (req, res) => {
  const drivers = await db
    .prepare(
      `SELECT d.id, d.name, d.phone, d.vehicle, d.pin, d.status, d.last_seen, d.paid_until, d.vouched_by, d.vouched_at,
              d.tipo, d.photo, d.photo_placa, d.signature, d.vehicle_type, d.cancel_count, d.cooldown_until, d.grupo, d.city, d.created_at,
              d.emergency_contact_name, d.emergency_contact_phone, d.referred_by, d.es_fundador, d.es_prueba,
              (SELECT name FROM drivers WHERE id = d.referred_by_driver_id) AS inviter_name,
              (SELECT COUNT(*) FROM drivers x WHERE x.referred_by_driver_id = d.id AND x.deleted_at IS NULL) AS invited_count,
              GREATEST(0, (SELECT COALESCE(SUM(amount), 0) FROM driver_credits WHERE driver_id = d.id)
                   - (SELECT COALESCE(SUM(credit_applied), 0) FROM driver_payments WHERE driver_id = d.id)) AS credit_balance,
              (SELECT amount FROM driver_payments WHERE driver_id = d.id ORDER BY paid_at DESC LIMIT 1) AS last_payment_amount,
              (SELECT paid_at FROM driver_payments WHERE driver_id = d.id ORDER BY paid_at DESC LIMIT 1) AS last_payment_at,
              (SELECT COUNT(*) FROM rides WHERE driver_id = d.id AND status = 'completado' AND fee_settled_at IS NULL) AS pending_rides,
              (SELECT COALESCE(SUM(
                 CASE WHEN ride_type = 'taxi' THEN LEAST(COALESCE(agreed_price, 0) * CAST(? AS double precision), CAST(? AS double precision)) ELSE CAST(? AS double precision) END
               ), 0) FROM rides WHERE driver_id = d.id AND status = 'completado' AND fee_settled_at IS NULL) AS pending_fee_amount,
              (SELECT MAX(connected_at) FROM driver_activity_log WHERE driver_id = d.id) AS last_connected_at
       FROM drivers d
       WHERE d.deleted_at IS NULL AND d.city = ?
       ORDER BY d.created_at DESC`
    )
    .all(TAXI_COMMISSION_RATE, TAXI_COMMISSION_CAP, SERVICE_FEE, req.adminCity);
  res.json(drivers.map((d) => inflateRow(d, DRIVER_IMG_COLS)));
});

router.post("/admin/drivers/:id/paid-until", checkAdminPin, async (req, res) => {
  if (!await assertOwnCity("drivers", req, res)) return;
  const { paidUntil } = req.body;
  await db.prepare("UPDATE drivers SET paid_until = ? WHERE id = ?").run(
    paidUntil || null,
    req.params.id
  );
  res.json({ ok: true });
});

router.post("/admin/drivers/:id/register-payment", checkAdminPin, async (req, res) => {
  if (!await assertOwnCity("drivers", req, res)) return;
  const driver = await db.prepare("SELECT id, paid_until FROM drivers WHERE id = ?").get(req.params.id);
  if (!driver) {
    return res.status(404).json({ error: "Chofer no encontrado" });
  }

  const amount = Number(req.body.amount);
  if (!amount || amount <= 0) {
    return res.status(400).json({ error: "Monto inválido" });
  }

  const today = new Date().toISOString().slice(0, 10);
  const base = driver.paid_until && driver.paid_until > today ? driver.paid_until : today;
  const periodEnd = new Date(base);
  periodEnd.setDate(periodEnd.getDate() + 30);
  const periodEndStr = periodEnd.toISOString().slice(0, 10);

  await db.prepare(
    "INSERT INTO driver_payments (driver_id, amount, period_start, period_end, concept) VALUES (?, ?, ?, ?, 'mensual')"
  ).run(req.params.id, amount, base, periodEndStr);
  await db.prepare("UPDATE drivers SET paid_until = ? WHERE id = ?").run(periodEndStr, req.params.id);

  res.json({ ok: true, paidUntil: periodEndStr });
});

router.post("/admin/drivers/:id/pending-fees", checkAdminPin, async (req, res) => {
  if (!await assertOwnCity("drivers", req, res)) return;
  const rides = await db
    .prepare(
      "SELECT ride_type, agreed_price FROM rides WHERE driver_id = ? AND status = 'completado' AND fee_settled_at IS NULL"
    )
    .all(req.params.id);
  const amount = rides.reduce((sum, r) => sum + rideFee(r), 0);
  const credit = await creditBalance(db, req.params.id);
  res.json({ count: rides.length, amount, credit, net: Math.max(0, amount - credit), feePerRide: SERVICE_FEE });
});

router.post("/admin/drivers/:id/register-trip-fees", checkAdminPin, async (req, res) => {
  if (!await assertOwnCity("drivers", req, res)) return;
  const pendingRides = await db
    .prepare(
      "SELECT id, ride_type, agreed_price FROM rides WHERE driver_id = ? AND status = 'completado' AND fee_settled_at IS NULL"
    )
    .all(req.params.id);

  if (pendingRides.length === 0) {
    return res.status(400).json({ error: "No hay viajes pendientes de cobrar" });
  }

  // Liquida exactamente los viajes que se contaron arriba (por id), no lo
  // que la misma condición devuelva en este instante: si un chofer entrega
  // otro viaje justo entre el SELECT y el UPDATE, ese viaje nuevo no debe
  // colarse como "ya cobrado" sin haberse sumado al monto ni al pago.
  const ids = pendingRides.map((r) => r.id);
  const placeholders = ids.map(() => "?").join(",");
  const gross = pendingRides.reduce((sum, r) => sum + rideFee(r), 0);
  // Saldo a favor por invitaciones (referrals.js): se resta de lo que el
  // chofer entrega. `amount` queda como lo que de verdad pagó.
  const creditApplied = Math.min(await creditBalance(db, req.params.id), gross);
  const amount = Math.round((gross - creditApplied) * 100) / 100;
  // Marcar los viajes y anotar el pago van juntos (todo o nada). Si otro
  // clic de "Cobrar" ya marcó alguno de estos viajes, no se cobra dos veces.
  const STALE = new Error("ya cobrado");
  try {
    await db.tx(async () => {
      const settled = await db.prepare(
        `UPDATE rides SET fee_settled_at = datetime('now') WHERE id IN (${placeholders}) AND fee_settled_at IS NULL`
      ).run(...ids);
      if (settled.changes !== ids.length) throw STALE;
      await db.prepare(
        "INSERT INTO driver_payments (driver_id, amount, concept, ride_count, credit_applied) VALUES (?, ?, 'viajes', ?, ?)"
      ).run(req.params.id, amount, ids.length, creditApplied);
    });
  } catch (err) {
    if (err === STALE) return res.status(409).json({ error: "Estos viajes ya se habían cobrado. Actualiza la pantalla." });
    throw err;
  }

  res.json({ ok: true, count: ids.length, amount, gross, creditApplied });
});

router.post("/admin/drivers/:id/payments", checkAdminPin, async (req, res) => {
  if (!await assertOwnCity("drivers", req, res)) return;
  const payments = await db
    .prepare(
      "SELECT id, amount, period_start, period_end, paid_at, concept, ride_count, credit_applied FROM driver_payments WHERE driver_id = ? ORDER BY paid_at DESC"
    )
    .all(req.params.id);
  res.json(payments);
});

// Minutos conectado hoy y en cuántos días distintos se conectó en la última
// semana — se calcula en JS a partir de las sesiones crudas en vez de una
// consulta SQL gigante, porque a esta escala (pocos choferes) es más simple
// y menos propenso a errores que hacerlo todo en SQLite.
router.post("/admin/drivers/:id/activity", checkAdminPin, async (req, res) => {
  if (!await assertOwnCity("drivers", req, res)) return;
  const sessions = await db
    .prepare(
      `SELECT connected_at, disconnected_at FROM driver_activity_log
       WHERE driver_id = ? AND connected_at >= datetime('now', '-7 days')
       ORDER BY connected_at ASC`
    )
    .all(req.params.id);

  const now = Date.now();
  const todayStart = new Date(`${new Date().toISOString().slice(0, 10)}T00:00:00Z`).getTime();
  const todayEnd = todayStart + 24 * 60 * 60 * 1000;
  const daysConnected = new Set();
  let connectedTodayMs = 0;

  for (const s of sessions) {
    const start = new Date(`${s.connected_at.replace(" ", "T")}Z`).getTime();
    const end = s.disconnected_at ? new Date(`${s.disconnected_at.replace(" ", "T")}Z`).getTime() : now;
    daysConnected.add(s.connected_at.slice(0, 10));
    if (s.disconnected_at) daysConnected.add(s.disconnected_at.slice(0, 10));

    const overlapStart = Math.max(start, todayStart);
    const overlapEnd = Math.min(end, todayEnd);
    if (overlapEnd > overlapStart) connectedTodayMs += overlapEnd - overlapStart;
  }

  res.json({
    connectedTodayMinutes: Math.round(connectedTodayMs / 60000),
    daysConnected7d: daysConnected.size,
  });
});

// Igual que el de pasajero: si un chofer pierde su PIN, esto le da uno nuevo
// SIN tocar su fila (mismo id) — así conserva su historial de viajes, su
// lugar en el ranking y todo lo demás. Borrarlo y volver a darlo de alta
// perdería todo eso.
router.post("/admin/drivers/:id/reset-pin", checkAdminPin, async (req, res) => {
  if (!await assertOwnCity("drivers", req, res)) return;
  const pin = await generateDriverPin();
  await db.prepare("UPDATE drivers SET pin = ? WHERE id = ?").run(pin, req.params.id);
  res.json({ ok: true, pin });
});

router.post("/admin/drivers/:id/vouch", checkAdminPin, async (req, res) => {
  if (!await assertOwnCity("drivers", req, res)) return;
  const { vouchedBy } = req.body;
  const vouchedAt = vouchedBy ? new Date().toISOString().slice(0, 10) : null;
  await db.prepare("UPDATE drivers SET vouched_by = ?, vouched_at = ? WHERE id = ?").run(
    vouchedBy || null,
    vouchedAt,
    req.params.id
  );
  res.json({ ok: true });
});

router.post("/admin/drivers/:id/update", checkAdminPin, async (req, res) => {
  if (!await assertOwnCity("drivers", req, res)) return;
  const { name, phone, vehicle, tipo, vehicleType, grupo } = req.body;
  if (!name || !phone) {
    return res.status(400).json({ error: "Falta nombre o teléfono" });
  }
  // La ciudad no se toca desde aquí: ya se validó que el chofer es de la
  // ciudad de este admin, y no puede "mudarlo" a otra a la que no tiene acceso.
  const cityId = req.adminCity;

  const existingPhone = await db
    .prepare("SELECT id, name FROM drivers WHERE phone = ? AND deleted_at IS NULL AND id != ?")
    .get(phone, req.params.id);
  if (existingPhone) {
    return res.status(409).json({
      error: `Ese teléfono ya está registrado con el chofer "${existingPhone.name}"`,
    });
  }

  const existingName = await db
    .prepare("SELECT id FROM drivers WHERE lower(trim(name)) = lower(trim(?)) AND deleted_at IS NULL AND id != ?")
    .get(name, req.params.id);
  if (existingName) {
    return res.status(409).json({
      error: `Ya hay un chofer registrado con el nombre "${name}"`,
    });
  }

  await db.prepare(
    "UPDATE drivers SET name = ?, phone = ?, vehicle = ?, tipo = ?, vehicle_type = ?, grupo = ?, city = ? WHERE id = ?"
  ).run(name, phone, vehicle || null, tipo === "formal" ? "formal" : "informal", vehicleType === "taxi" ? "taxi" : "moto", grupo || null, cityId, req.params.id);

  const driver = await db
    .prepare(
      "SELECT id, name, phone, vehicle, pin, status, last_seen, paid_until, tipo, vehicle_type, grupo, city, created_at FROM drivers WHERE id = ?"
    )
    .get(req.params.id);
  res.json(driver);
});

router.post("/admin/drivers/:id/delete", checkAdminPin, async (req, res) => {
  if (!await assertOwnCity("drivers", req, res)) return;
  const activeRide = await db
    .prepare("SELECT id FROM rides WHERE driver_id = ? AND status IN ('aceptado', 'llegue', 'en_curso')")
    .get(req.params.id);
  if (activeRide) {
    return res.status(409).json({ error: "Este chofer tiene un viaje activo en este momento, no se puede eliminar todavía" });
  }
  // Soft delete: conserva la fila (y su nombre en el historial de viajes),
  // solo lo saca de la lista de choferes activos y le cierra el acceso.
  await db.prepare("UPDATE drivers SET deleted_at = datetime('now'), status = 'offline' WHERE id = ?").run(req.params.id);
  // Si era fundador, su lugar pasa al siguiente chofer real.
  await recomputeFounders(db);
  res.json({ ok: true });
});

// Marca/desmarca una cuenta como de prueba: no ocupa lugar de fundador ni
// entra al ranking de Top chofer.
router.post("/admin/drivers/:id/test-account", checkAdminPin, async (req, res) => {
  if (!await assertOwnCity("drivers", req, res)) return;
  await db.prepare("UPDATE drivers SET es_prueba = ? WHERE id = ?").run(req.body.esPrueba ? 1 : 0, req.params.id);
  await recomputeFounders(db);
  res.json({ ok: true });
});

router.post("/admin/chofer-solicitudes/list", checkAdminPin, async (req, res) => {
  const apps = await db
    .prepare(
      "SELECT a.id, a.name, a.phone, a.photo, a.photo_placa, a.signature, a.status, a.created_at, a.accepted_legal_at, a.accepted_legal_version, a.vehicle_type, a.grupo, a.tipo, a.city, a.emergency_contact_name, a.emergency_contact_phone, a.referred_by, a.referred_by_driver_id, a.phone_verified, inv.name AS inviter_name FROM driver_applications a LEFT JOIN drivers inv ON inv.id = a.referred_by_driver_id AND inv.deleted_at IS NULL WHERE a.status = 'pendiente' AND a.city = ? ORDER BY a.created_at DESC"
    )
    .all(req.adminCity);
  res.json(apps.map((a) => inflateRow(a, DRIVER_IMG_COLS)));
});

router.post("/admin/chofer-solicitudes/:id/dismiss", checkAdminPin, async (req, res) => {
  if (!await assertOwnCity("driver_applications", req, res)) return;
  await db.prepare("UPDATE driver_applications SET status = 'descartada' WHERE id = ?").run(
    req.params.id
  );
  res.json({ ok: true });
});

// "Rechazar con amabilidad": el admin ya le mandó el mensaje por su WhatsApp;
// aquí solo queda anotado que se le contestó y por qué.
const REJECT_REASONS = ["vehiculo", "zona", "otro"];
router.post("/admin/chofer-solicitudes/:id/reject", checkAdminPin, async (req, res) => {
  if (!await assertOwnCity("driver_applications", req, res)) return;
  const reason = REJECT_REASONS.includes(req.body.reason) ? req.body.reason : "otro";
  await db.prepare("UPDATE driver_applications SET status = 'rechazada', reject_reason = ? WHERE id = ?").run(
    reason, req.params.id
  );
  res.json({ ok: true });
});

router.post("/admin/riders/list", checkAdminPin, async (req, res) => {
  const riders = await db
    .prepare(
      `SELECT r.id, r.name, r.phone, r.created_at, r.last_ride_at, r.no_show_count, r.es_prueba,
              (SELECT COUNT(*) FROM rides WHERE rider_id = r.id AND status = 'completado') AS trips
       FROM riders r
       WHERE r.city = ?
       ORDER BY r.created_at DESC`
    )
    .all(req.adminCity);
  res.json(riders);
});

// Marca/desmarca un pasajero como cuenta de prueba: sus viajes dejan de
// contar en el resumen del admin (/admin/stats). No borra nada.
router.post("/admin/riders/:id/test-account", checkAdminPin, async (req, res) => {
  if (!await assertOwnCity("riders", req, res)) return;
  await db.prepare("UPDATE riders SET es_prueba = ? WHERE id = ?").run(req.body.esPrueba ? 1 : 0, req.params.id);
  res.json({ ok: true });
});

// Único recurso de soporte hoy: si un pasajero pierde su PIN (o cambia de
// celular sin haberlo apuntado), no hay forma de recuperarlo solo — el admin
// le genera uno nuevo y se lo pasa por su cuenta (llamada, WhatsApp, etc.).
router.post("/admin/riders/:id/reset-pin", checkAdminPin, async (req, res) => {
  if (!await assertOwnCity("riders", req, res)) return;
  const pin = await generateRiderPin();
  await db.prepare("UPDATE riders SET pin = ? WHERE id = ?").run(pin, req.params.id);
  res.json({ ok: true, pin });
});

// A diferencia de los choferes (que se "esconden" con deleted_at porque su
// nombre debe seguir viéndose en el historial de viajes ya cobrado), un
// pasajero sin viajes completados no deja ningún historial que proteger —
// se borra la fila de verdad, para limpiar cuentas de prueba/basura.
// Con viajes completados, no se deja borrar aquí (evita perder ese
// historial sin querer); si de verdad hay que quitarlo, es un caso especial
// que se atiende aparte, no desde este botón.
router.post("/admin/riders/:id/delete", checkAdminPin, async (req, res) => {
  if (!await assertOwnCity("riders", req, res)) return;
  const { trips } = await db
    .prepare("SELECT COUNT(*) AS trips FROM rides WHERE rider_id = ? AND status = 'completado'")
    .get(req.params.id);
  // Escotilla para casos de excepción (una cuenta de prueba propia con viajes
  // también de prueba): nunca la manda el botón del admin, solo una llamada
  // directa con este flag explícito. Sin él, el bloqueo de arriba se aplica
  // igual que siempre — esto no debilita la protección para nadie más.
  if (trips > 0 && !(req.body.forceDeleteConfirmedTestTrips === trips)) {
    return res.status(409).json({ error: `Tiene ${trips} viaje(s) completado(s) — no se puede eliminar` });
  }
  // rides.rider_id tiene una llave foránea hacia riders(id) — el motor de
  // SQLite que usa este proyecto la exige por defecto. Un viaje cancelado o
  // abandonado (no es historial real, no lo protege el conteo de arriba)
  // igual apunta al pasajero y bloquea el DELETE si no se limpia primero.
  // Las ofertas de taxi (ride_offers) también apuntan al viaje: van primero.
  // Todo o nada: si algo falla a medias, el pasajero queda como estaba.
  await db.tx(async () => {
    await db.prepare(
      trips > 0
        ? "DELETE FROM ride_offers WHERE ride_id IN (SELECT id FROM rides WHERE rider_id = ?)"
        : "DELETE FROM ride_offers WHERE ride_id IN (SELECT id FROM rides WHERE rider_id = ? AND status != 'completado')"
    ).run(req.params.id);
    await db.prepare("DELETE FROM rides WHERE rider_id = ? AND status != 'completado'").run(req.params.id);
    if (trips > 0) {
      await db.prepare("DELETE FROM rides WHERE rider_id = ? AND status = 'completado'").run(req.params.id);
    }
    await db.prepare("DELETE FROM riders WHERE id = ?").run(req.params.id);
  });
  res.json({ ok: true, deletedTrips: trips });
});

router.post("/admin/rides/list", checkAdminPin, async (req, res) => {
  const rides = await db
    .prepare(
      `SELECT r.id, r.rider_name, r.rider_phone, r.pickup_label, r.dest_label,
              r.passengers, r.children, r.status, r.created_at, r.updated_at, r.driver_disconnected_at, r.rating, r.ride_type,
              r.cancelled_by, r.cancel_reason, r.agreed_price, r.deposit_amount, r.deposit_status, r.extra,
              d.name AS driver_name
       FROM rides r
       LEFT JOIN drivers d ON d.id = r.driver_id
       WHERE r.city = ?
       ORDER BY r.updated_at DESC
       LIMIT 50`
    )
    .all(req.adminCity);
  res.json(rides);
});

router.post("/admin/rides/reset", checkAdminPin, async (req, res) => {
  await db.tx(async () => {
    await db.prepare("DELETE FROM ride_offers WHERE ride_id IN (SELECT id FROM rides WHERE city = ?)").run(req.adminCity);
    await db.prepare("DELETE FROM rides WHERE city = ?").run(req.adminCity);
  });
  res.json({ ok: true });
});

// Viaje "real" para el resumen: ni el chofer ni el pasajero son cuenta de
// prueba (es_prueba, se marca en el admin). Espera el viaje con alias `r`.
const REAL_RIDE = `NOT EXISTS (SELECT 1 FROM drivers td WHERE td.id = r.driver_id AND td.es_prueba = 1)
         AND NOT EXISTS (SELECT 1 FROM riders tr WHERE tr.id = r.rider_id AND tr.es_prueba = 1)`;

router.post("/admin/stats", checkAdminPin, async (req, res) => {
  const city = req.adminCity;
  const ridesToday = (await db
    .prepare(`SELECT COUNT(*) AS n FROM rides r WHERE r.status = 'completado' AND date(r.updated_at, '-6 hours') = date('now', '-6 hours') AND r.city = ? AND ${REAL_RIDE}`)
    .get(city)).n;
  const ridesWeek = (await db
    .prepare(`SELECT COUNT(*) AS n FROM rides r WHERE r.status = 'completado' AND date(r.updated_at, '-6 hours') >= date('now', '-6 hours', '-6 days') AND r.city = ? AND ${REAL_RIDE}`)
    .get(city)).n;
  const cancelledToday = (await db
    .prepare(`SELECT COUNT(*) AS n FROM rides r WHERE r.status = 'cancelado' AND date(r.updated_at, '-6 hours') = date('now', '-6 hours') AND r.city = ? AND ${REAL_RIDE}`)
    .get(city)).n;
  const driversOnline = (await db
    .prepare(
      `SELECT COUNT(*) AS n FROM drivers
       WHERE deleted_at IS NULL AND es_prueba = 0 AND city = ?
         AND (status = 'en_viaje' OR (status = 'disponible' AND last_seen >= datetime('now', '-${DRIVER_STALE_SECONDS} seconds')))`
    )
    .get(city)).n;
  const topDrivers = await db
    .prepare(
      `SELECT d.name, COUNT(*) AS rides
       FROM rides r JOIN drivers d ON d.id = r.driver_id
       WHERE r.status = 'completado' AND date(r.updated_at, '-6 hours') >= date('now', '-6 hours', '-6 days') AND r.city = ? AND ${REAL_RIDE}
       GROUP BY d.id
       ORDER BY rides DESC, d.id
       LIMIT 5`
    )
    .all(city);
  const ratings = await db
    .prepare(
      `SELECT COUNT(*) AS total, SUM(r.rating) AS good
       FROM rides r
       WHERE r.rating IS NOT NULL AND date(r.updated_at, '-6 hours') >= date('now', '-6 hours', '-6 days') AND r.city = ? AND ${REAL_RIDE}`
    )
    .get(city);
  const satisfactionPct = ratings.total > 0 ? Math.round((ratings.good / ratings.total) * 100) : null;
  // Viajes completados por día (hora de Yucatán), para la gráfica del Resumen.
  const ridesByDay = await db
    .prepare(
      `SELECT date(r.updated_at, '-6 hours') AS dia, COUNT(*) AS n
       FROM rides r
       WHERE r.status = 'completado' AND date(r.updated_at, '-6 hours') >= date('now', '-6 hours', '-6 days') AND r.city = ? AND ${REAL_RIDE}
       GROUP BY dia`
    )
    .all(city);
  const collectedWeek = (await db
    .prepare(
      `SELECT COALESCE(SUM(p.amount), 0) AS total FROM driver_payments p
       JOIN drivers d ON d.id = p.driver_id
       WHERE date(p.paid_at) >= date('now', '-6 days') AND d.city = ? AND d.es_prueba = 0`
    )
    .get(city)).total;
  const collectedMonth = (await db
    .prepare(
      `SELECT COALESCE(SUM(p.amount), 0) AS total FROM driver_payments p
       JOIN drivers d ON d.id = p.driver_id
       WHERE date(p.paid_at) >= date('now', '-29 days') AND d.city = ? AND d.es_prueba = 0`
    )
    .get(city)).total;
  const launchRanking = await db
    .prepare(
      `SELECT d.id, d.name, COUNT(*) AS rides
       FROM rides r JOIN drivers d ON d.id = r.driver_id
       WHERE r.status = 'completado' AND date(r.updated_at) >= date(?) AND (r.rating IS NULL OR r.rating = 1) AND r.city = ? AND ${REAL_RIDE}
       GROUP BY d.id
       ORDER BY rides DESC, d.id
       LIMIT 5`
    )
    .all(LAUNCH_DATE, city);

  res.json({
    ridesToday, ridesWeek, cancelledToday, driversOnline, topDrivers, satisfactionPct, ratedCount: ratings.total,
    collectedWeek, collectedMonth, launchRanking, ridesByDay, trialEndDate: TRIAL_END_DATE,
  });
});

// Detecta el patrón de "cancela y te llevo por fuera": un chofer acepta un
// viaje, se pone de acuerdo con el pasajero por chat para que este cancele en
// la app, y el viaje se completa en efectivo sin que nunca llegue a
// "completado" — así nunca se acumula la cuota de $2/viaje. No hay forma de
// probarlo con certeza desde los datos (una cancelación real de pasajero se
// ve idéntica), así que esto es una señal para que el admin revise con el
// líder del gremio, no una acusación automática.
router.post("/admin/reports/cancelaciones", checkAdminPin, async (req, res) => {
  const porChofer = (await db
    .prepare(
      `SELECT d.id, d.name, d.grupo,
              COUNT(*) AS total_asignados,
              SUM(CASE WHEN r.status = 'cancelado' AND r.cancelled_by = 'rider' THEN 1 ELSE 0 END) AS cancelados_pasajero
       FROM rides r
       JOIN drivers d ON d.id = r.driver_id
       WHERE d.city = ?
       GROUP BY d.id
       HAVING COUNT(*) >= 3 AND SUM(CASE WHEN r.status = 'cancelado' AND r.cancelled_by = 'rider' THEN 1 ELSE 0 END) > 0
       ORDER BY (1.0 * SUM(CASE WHEN r.status = 'cancelado' AND r.cancelled_by = 'rider' THEN 1 ELSE 0 END) / COUNT(*)) DESC, d.id
       LIMIT 20`
    )
    .all(req.adminCity))
    .map((row) => ({ ...row, pct: Math.round((row.cancelados_pasajero / row.total_asignados) * 100) }));

  // La señal más fuerte: el mismo pasajero cancelando repetido justo con el
  // mismo chofer. Una cancelación real y aislada es normal; que se repita con
  // la misma pareja chofer-pasajero casi no pasa por accidente.
  const paresRepetidos = await db
    .prepare(
      `SELECT r.driver_id, MAX(d.name) AS driver_name, r.rider_phone, MAX(r.rider_name) AS rider_name,
              COUNT(*) AS veces, MAX(r.updated_at) AS ultima_vez
       FROM rides r
       JOIN drivers d ON d.id = r.driver_id
       WHERE r.status = 'cancelado' AND r.cancelled_by = 'rider' AND d.city = ?
       GROUP BY r.driver_id, r.rider_phone
       HAVING COUNT(*) >= 2
       ORDER BY veces DESC, ultima_vez DESC
       LIMIT 20`
    )
    .all(req.adminCity);

  // Pasajeros que ya acumularon varias veces "El pasajero no llegó" (ver
  // no_show_count en riders/rides.js). No se bloquean solos — es para que el
  // admin decida si contacta o restringe, porque un "no llegó" también puede
  // ser el chofer equivocándose de ubicación.
  const NO_SHOW_ALERT_THRESHOLD = 2;
  const inasistencias = await db
    .prepare(
      `SELECT id, name, phone, no_show_count
       FROM riders
       WHERE city = ? AND no_show_count >= ?
       ORDER BY no_show_count DESC`
    )
    .all(req.adminCity, NO_SHOW_ALERT_THRESHOLD);

  res.json({ porChofer, paresRepetidos, inasistencias });
});

// Salir: el pase deja de servir en ese mismo momento.
router.post("/admin/logout", checkAdminPin, async (req, res) => {
  if (req.adminSession) {
    await db.prepare("UPDATE admin_sessions SET revoked_at = datetime('now') WHERE id = ?").run(req.adminSession.id);
  }
  res.json({ ok: true });
});

// Cerrar TODAS las sesiones de este PIN (ej. perdiste el celular).
router.post("/admin/logout-all", checkAdminPin, async (req, res) => {
  const r = await db
    .prepare("UPDATE admin_sessions SET revoked_at = datetime('now') WHERE role = ? AND revoked_at IS NULL")
    .run(req.adminRole);
  res.json({ ok: true, closed: r.changes });
});

// Movimientos de la zona que se está viendo (los últimos 200).
router.post("/admin/audit/list", checkAdminPin, async (req, res) => {
  const rows = await db
    .prepare(
      `SELECT id, at, role, action, target_id, detail, ok FROM admin_audit
       WHERE zone = ? OR (zone IS NULL AND ? = 'tekax')
       ORDER BY id DESC LIMIT 200`
    )
    .all(req.adminCity, req.adminRole);
  res.json(rows);
});

// ---- Entrar con huella (passkey / WebAuthn, 6-oct-2026) ----
// Ya dentro (con el PIN), el admin activa la huella en ese celular: el
// celular crea un par de llaves, guarda la privada protegida con la huella y
// nos manda solo la pública. Para entrar después, el servidor manda un reto,
// el celular lo firma al poner la huella y aquí se comprueba la firma. Ni la
// huella ni la llave privada salen nunca del teléfono. El PIN sigue
// sirviendo de respaldo (celular perdido o cambiado).
const PASSKEY_ROLE_NAMES = { tekax: "Dueño MotoVecino", progreso: "Daniel (Progreso)", ticul: "Admin Ticul" };
const CHALLENGE_TTL_MS = 5 * 60 * 1000;
// Retos pendientes (uno por intento; se borran al usarse o a los 5 min).
const passkeyChallenges = new Map();

// La llave queda atada al dominio principal, así sirve igual en
// admin.motovecinoapp.com que en motovecinoapp.com/admin.html.
function passkeyRpId(req) {
  const host = req.hostname;
  if (host === "motovecinoapp.com" || host.endsWith(".motovecinoapp.com")) return "motovecinoapp.com";
  return host.replace(/^(admin|www)\./, "");
}
const passkeyOrigin = (req) => `${req.protocol}://${req.get("host")}`;

function rememberChallenge(challenge, data) {
  const now = Date.now();
  for (const [c, d] of passkeyChallenges) if (d.exp < now) passkeyChallenges.delete(c);
  if (passkeyChallenges.size > 500) passkeyChallenges.clear();
  passkeyChallenges.set(challenge, { ...data, exp: now + CHALLENGE_TTL_MS });
}
// Un reto sirve una sola vez, para lo que se pidió y antes de vencer.
function takeChallenge(kind, role) {
  return (c) => {
    const d = passkeyChallenges.get(c);
    passkeyChallenges.delete(c);
    return !!d && d.kind === kind && d.exp > Date.now() && (role == null || d.role === role);
  };
}

function deviceLabel(req) {
  const ua = String(req.get("user-agent") || "");
  if (/iPhone|iPad/.test(ua)) return "iPhone";
  if (/Android/.test(ua)) return "Celular Android";
  if (/Windows/.test(ua)) return "Computadora Windows";
  if (/Macintosh/.test(ua)) return "Mac";
  return "Otro aparato";
}

const isCredId = (v) => typeof v === "string" && /^[A-Za-z0-9_-]{16,1400}$/.test(v);
const splitTransports = (t) => (t ? t.split(",") : undefined);

// Activar, paso 1: el servidor manda las opciones (con el reto).
router.post("/admin/passkey/register-options", checkAdminPin, async (req, res) => {
  if (!req.adminSession) return res.status(403).json({ error: "Primero entra con tu PIN." });
  const role = req.adminRole;
  const existing = await db.prepare("SELECT credential_id, transports FROM admin_passkeys WHERE role = ?").all(role);
  const options = await generateRegistrationOptions({
    rpName: "MotoVecino Admin",
    rpID: passkeyRpId(req),
    userName: PASSKEY_ROLE_NAMES[role] || role,
    userID: new TextEncoder().encode("motovecino-admin-" + role),
    attestationType: "none",
    // No volver a activar en un celular que ya tiene la suya.
    excludeCredentials: existing.map((r) => ({ id: r.credential_id, transports: splitTransports(r.transports) })),
    authenticatorSelection: { authenticatorAttachment: "platform", residentKey: "preferred", userVerification: "required" },
  });
  rememberChallenge(options.challenge, { kind: "register", role });
  res.json(options);
});

// Activar, paso 2: el celular manda su llave pública firmada.
router.post("/admin/passkey/register", checkAdminPin, async (req, res) => {
  if (!req.adminSession) return res.status(403).json({ error: "Primero entra con tu PIN." });
  const role = req.adminRole;
  const failMsg = "No se pudo activar la huella. Inténtalo otra vez.";
  let v;
  try {
    v = await verifyRegistrationResponse({
      response: req.body.response,
      expectedChallenge: takeChallenge("register", role),
      expectedOrigin: passkeyOrigin(req),
      expectedRPID: passkeyRpId(req),
      requireUserVerification: true,
    });
  } catch (e) {
    console.warn("[passkey] registro rechazado:", e.message);
    return res.status(400).json({ error: failMsg });
  }
  if (!v.verified) return res.status(400).json({ error: failMsg });
  const c = v.registrationInfo.credential;
  await db.prepare(
    "INSERT INTO admin_passkeys (role, credential_id, public_key, counter, transports, label, created_ms) VALUES (?, ?, ?, ?, ?, ?, ?)"
  ).run(role, c.id, Buffer.from(c.publicKey).toString("base64url"), c.counter || 0, (c.transports || []).join(",") || null, deviceLabel(req), Date.now());
  res.json({ ok: true, credentialId: c.id });
});

router.post("/admin/passkey/list", checkAdminPin, async (req, res) => {
  const rows = await db
    .prepare("SELECT id, credential_id, label, created_ms, last_used_ms FROM admin_passkeys WHERE role = ? ORDER BY id DESC")
    .all(req.adminRole);
  res.json(rows);
});

// Quitar la huella de un celular (perdido, cambiado...).
router.post("/admin/passkey/:id/delete", checkAdminPin, async (req, res) => {
  const r = await db.prepare("DELETE FROM admin_passkeys WHERE id = ? AND role = ?").run(req.params.id, req.adminRole);
  if (!r.changes) return res.status(404).json({ error: "No encontrado" });
  res.json({ ok: true });
});

// Entrar, paso 1 (todavía sin sesión): el servidor manda un reto para firmar.
router.post("/admin/passkey/login-options", async (req, res) => {
  if (isRateLimited(req.ip)) return res.status(429).json({ error: RATE_LIMIT_MESSAGE });
  // Si este celular recuerda cuál es su llave, se pide esa directamente.
  let allow;
  if (isCredId(req.body.credentialId)) {
    const row = await db.prepare("SELECT credential_id, transports FROM admin_passkeys WHERE credential_id = ?").get(req.body.credentialId);
    if (row) allow = [{ id: row.credential_id, transports: splitTransports(row.transports) }];
  }
  const options = await generateAuthenticationOptions({
    rpID: passkeyRpId(req),
    allowCredentials: allow,
    userVerification: "required",
  });
  rememberChallenge(options.challenge, { kind: "login" });
  res.json(options);
});

// Entrar, paso 2: se comprueba la firma y se da un pase igual que con el PIN.
router.post("/admin/passkey/login", async (req, res) => {
  if (isRateLimited(req.ip)) return res.status(429).json({ error: RATE_LIMIT_MESSAGE });
  const response = req.body.response;
  const fail = (msg) => {
    recordFailedAttempt(req.ip);
    audit({ action: "passkey_fallida", ip: req.ip, ok: 0 }).catch(() => {});
    return res.status(401).json({ error: msg });
  };
  if (!response || !isCredId(response.id)) return fail("No se pudo entrar con la huella.");
  const row = await db.prepare("SELECT * FROM admin_passkeys WHERE credential_id = ?").get(response.id);
  if (!row) return fail("La huella de este celular ya no está activada. Entra con tu PIN.");
  // Un rol cuyo PIN se quitó (ej. Daniel) tampoco entra con huella.
  if (!ADMIN_PINS[row.role]) return fail("Este acceso ya no está activo.");
  let v;
  try {
    v = await verifyAuthenticationResponse({
      response,
      expectedChallenge: takeChallenge("login"),
      expectedOrigin: passkeyOrigin(req),
      expectedRPID: passkeyRpId(req),
      credential: {
        id: row.credential_id,
        publicKey: new Uint8Array(Buffer.from(row.public_key, "base64url")),
        counter: Number(row.counter) || 0,
        transports: splitTransports(row.transports),
      },
      requireUserVerification: true,
    });
  } catch (e) {
    console.warn("[passkey] entrada rechazada:", e.message);
    return fail("No se pudo entrar con la huella.");
  }
  if (!v.verified) return fail("No se pudo entrar con la huella.");
  clearAttempts(req.ip);
  await db.prepare("UPDATE admin_passkeys SET counter = ?, last_used_ms = ? WHERE id = ?").run(v.authenticationInfo.newCounter || 0, Date.now(), row.id);
  const token = await createSession(row.role, req);
  await audit({ role: row.role, zone: row.role, action: "passkey_login", detail: JSON.stringify({ device: row.label }), ip: req.ip });
  res.json({ ok: true, token });
});

module.exports = router;

// Lo usan otras rutas de admin (p. ej. routes/allyAds.js).
module.exports.checkAdminPin = checkAdminPin;
