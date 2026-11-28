// Promotores (27-nov-2026): personas que salen a la calle (mercado, escuelas,
// centro) a instalarle la app a la gente, con su propio código/QR de 5 letras.
// Reglas acordadas con el dueño:
//  - Cuenta solo el pasajero NUEVO registrado con el código del promotor que ya
//    completó 3 viajes que dejan cuota (mismo filtro que "Invita pasajeros":
//    RIDES_COUNT_SQL). Instalar o registrarse no basta: así no se llena el
//    sistema de cuentas que nunca piden viaje.
//  - No cuentan pasajeros de prueba ni el teléfono del propio promotor.
//  - Se paga en EFECTIVO (no hay saldo): el admin le da «Pagar» y quedan
//    marcados esos pasajeros para no pagarlos dos veces. Pago por pasajero
//    `pay_per_rider` ($10 por defecto, editable por promotor).
//  - Pago fijo por jornada (las primeras semanas): se anota a mano en el admin.
//  - El promotor no entra a la app ni ve teléfonos: el dueño le dice sus números.
const { randomCode, PROMOTER_CODE_LENGTH } = require("./invites");
const { RIDES_COUNT_SQL, RIDER_FRIEND } = require("./riderReferrals");

const RIDES_REQUIRED = RIDER_FRIEND.RIDES_REQUIRED; // 3, igual que las otras invitaciones
const DEFAULT_PAY = 10;
const MAX_PAY_PER_RIDER = 100;
const MAX_JORNADA = 2000;

// Pasajeros que sí le cuentan a un promotor (`p` = alias de promoters).
const COUNTED_RIDERS = `r.referred_by_promoter_id = p.id AND COALESCE(r.es_prueba, 0) = 0
  AND (p.phone IS NULL OR r.phone <> p.phone)`;

function cleanName(v) {
  const s = typeof v === "string" ? v.trim().replace(/\s+/g, " ") : "";
  return s.length >= 2 && s.length <= 60 ? s : null;
}

// Teléfono opcional: 10 dígitos (México). "" o null = sin teléfono.
function cleanPhone(v) {
  if (v == null || v === "") return { ok: true, phone: null };
  const s = String(v).replace(/\D/g, "");
  return /^\d{10}$/.test(s) ? { ok: true, phone: s } : { ok: false };
}

function cleanPay(v) {
  const n = Number(v);
  return Number.isInteger(n) && n >= 0 && n <= MAX_PAY_PER_RIDER ? n : null;
}

async function createPromoter(db, city, body) {
  const name = cleanName(body.name);
  if (!name) return { error: "Escribe el nombre del promotor" };
  const ph = cleanPhone(body.phone);
  if (!ph.ok) return { error: "El teléfono debe tener 10 dígitos (o déjalo vacío)" };
  const pay = body.payPerRider == null || body.payPerRider === "" ? DEFAULT_PAY : cleanPay(body.payPerRider);
  if (pay == null) return { error: `El pago por pasajero va de $0 a $${MAX_PAY_PER_RIDER}` };
  for (let i = 0; i < 10; i++) {
    const code = randomCode(PROMOTER_CODE_LENGTH);
    try {
      const r = await db
        .prepare("INSERT INTO promoters (city, name, phone, code, pay_per_rider) VALUES (?, ?, ?, ?, ?)")
        .run(city, name, ph.phone, code, pay);
      return { ok: true, id: r.lastInsertRowid, code };
    } catch (e) {
      if (!db.isUniqueViolation(e)) throw e; // choque de código (casi imposible): otro
    }
  }
  return { error: "No se pudo crear el código, intenta de nuevo" };
}

async function updatePromoter(db, id, body) {
  const p = await db.prepare("SELECT * FROM promoters WHERE id = ?").get(id);
  if (!p) return { error: "No encontrado" };
  const name = body.name === undefined ? p.name : cleanName(body.name);
  if (!name) return { error: "Escribe el nombre del promotor" };
  let phone = p.phone;
  if (body.phone !== undefined) {
    const ph = cleanPhone(body.phone);
    if (!ph.ok) return { error: "El teléfono debe tener 10 dígitos (o déjalo vacío)" };
    phone = ph.phone;
  }
  const pay = body.payPerRider === undefined ? p.pay_per_rider : cleanPay(body.payPerRider);
  if (pay == null) return { error: `El pago por pasajero va de $0 a $${MAX_PAY_PER_RIDER}` };
  const active = body.active === undefined ? p.active : (body.active ? 1 : 0);
  await db.prepare("UPDATE promoters SET name = ?, phone = ?, pay_per_rider = ?, active = ? WHERE id = ?").run(name, phone, pay, active, id);
  return { ok: true };
}

// Lista del municipio con sus números.
async function listPromoters(db, city) {
  const rows = await db
    .prepare(
      `SELECT p.id, p.name, p.phone, p.code, p.pay_per_rider, p.active, p.created_at,
              (SELECT COUNT(*) FROM riders r WHERE ${COUNTED_RIDERS}) AS registered,
              (SELECT COUNT(*) FROM riders r WHERE ${COUNTED_RIDERS} AND ${RIDES_COUNT_SQL} BETWEEN 1 AND ${RIDES_REQUIRED - 1}) AS started,
              (SELECT COUNT(*) FROM riders r WHERE ${COUNTED_RIDERS} AND ${RIDES_COUNT_SQL} >= ${RIDES_REQUIRED}) AS qualified,
              (SELECT COUNT(*) FROM riders r WHERE ${COUNTED_RIDERS} AND r.promoter_paid_at IS NULL AND ${RIDES_COUNT_SQL} >= ${RIDES_REQUIRED}) AS to_pay,
              (SELECT COALESCE(SUM(amount), 0) FROM promoter_payouts o WHERE o.promoter_id = p.id) AS paid_total
       FROM promoters p WHERE p.city = ? ORDER BY p.active DESC, p.created_at DESC`
    )
    .all(city);
  return rows.map((p) => ({
    id: p.id,
    name: p.name,
    phone: p.phone,
    code: p.code,
    payPerRider: Number(p.pay_per_rider),
    active: !!p.active,
    createdAt: p.created_at,
    registered: Number(p.registered) || 0,
    started: Number(p.started) || 0,
    qualified: Number(p.qualified) || 0,
    toPay: Number(p.to_pay) || 0,
    owed: (Number(p.to_pay) || 0) * Number(p.pay_per_rider),
    paidTotal: Number(p.paid_total) || 0,
  }));
}

// Detalle de un promotor: sus pasajeros (solo nombre, sin teléfono) y pagos.
async function promoterDetail(db, id) {
  const riders = await db
    .prepare(
      `SELECT r.name, r.created_at, r.promoter_paid_at, ${RIDES_COUNT_SQL} AS n
       FROM riders r JOIN promoters p ON p.id = r.referred_by_promoter_id
       WHERE p.id = ? AND ${COUNTED_RIDERS}
       ORDER BY r.created_at DESC LIMIT 300`
    )
    .all(id);
  const payouts = await db
    .prepare("SELECT kind, riders_count, amount, note, created_at FROM promoter_payouts WHERE promoter_id = ? ORDER BY created_at DESC, id DESC LIMIT 100")
    .all(id);
  return {
    ridesRequired: RIDES_REQUIRED,
    riders: riders.map((r) => ({
      name: r.name || "",
      createdAt: r.created_at,
      rides: Math.min(Number(r.n) || 0, RIDES_REQUIRED),
      qualified: (Number(r.n) || 0) >= RIDES_REQUIRED,
      paidAt: r.promoter_paid_at || null,
    })),
    payouts: payouts.map((o) => ({ kind: o.kind, ridersCount: Number(o.riders_count) || 0, amount: Number(o.amount) || 0, note: o.note || "", createdAt: o.created_at })),
  };
}

// «Pagar»: marca como pagados TODOS los pasajeros que ya cuentan y no se han
// pagado, y anota el pago. La condición va en el UPDATE: dos clics al mismo
// tiempo no pagan doble (el segundo ya no encuentra pasajeros sin pagar).
class NothingToPay extends Error {}
async function payRiders(db, id) {
  try {
    return await db.tx(async () => {
      const p = await db.prepare("SELECT id, pay_per_rider FROM promoters WHERE id = ?").get(id);
      if (!p) return { error: "No encontrado" };
      const o = await db.prepare("INSERT INTO promoter_payouts (promoter_id, kind, riders_count, amount) VALUES (?, 'pasajeros', 0, 0)").run(id);
      const u = await db
        .prepare(
          `UPDATE riders SET promoter_paid_at = datetime('now'), promoter_payout_id = ?
           WHERE id IN (SELECT r.id FROM riders r JOIN promoters p ON p.id = r.referred_by_promoter_id
                        WHERE p.id = ? AND ${COUNTED_RIDERS} AND r.promoter_paid_at IS NULL AND ${RIDES_COUNT_SQL} >= ${RIDES_REQUIRED})
             AND promoter_paid_at IS NULL`
        )
        .run(o.lastInsertRowid, id);
      if (!u.changes) throw new NothingToPay();
      const amount = u.changes * Number(p.pay_per_rider);
      await db.prepare("UPDATE promoter_payouts SET riders_count = ?, amount = ? WHERE id = ?").run(u.changes, amount, o.lastInsertRowid);
      return { ok: true, riders: u.changes, amount };
    });
  } catch (e) {
    if (e instanceof NothingToPay) return { error: "No hay pasajeros por pagar" };
    throw e;
  }
}

// Pago fijo por jornada (o cualquier otro pago en efectivo): solo se anota.
async function addJornada(db, id, body) {
  const amount = Number(body.amount);
  if (!Number.isInteger(amount) || amount < 1 || amount > MAX_JORNADA) return { error: `La cantidad va de $1 a $${MAX_JORNADA}` };
  const note = typeof body.note === "string" ? body.note.trim().slice(0, 120) : "";
  await db.prepare("INSERT INTO promoter_payouts (promoter_id, kind, riders_count, amount, note) VALUES (?, 'jornada', 0, ?, ?)").run(id, amount, note || null);
  return { ok: true };
}

module.exports = { createPromoter, updatePromoter, listPromoters, promoterDetail, payRiders, addJornada, DEFAULT_PAY, RIDES_REQUIRED };
