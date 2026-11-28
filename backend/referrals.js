// Premio de "Invita a otro chofer" (parte 2). Reglas acordadas 29-sep-2026 y
// cambiadas el 28-nov-2026 a pedido del dueño (antes: 20 viajes con 10
// pasajeros distintos y ganaban LOS DOS $20; casi nadie llegaba):
//  - Cuando el invitado completa REQUIRED_TRIPS viajes, SOLO EL QUE INVITÓ
//    gana REWARD_AMOUNT de saldo a favor (INVITEE_AMOUNT = 0). Ya no se paga
//    solo (3 viajes dejan ~$6 de cuota): es lo que cuesta conseguir un chofer.
//  - Los viajes deben ser con al menos REQUIRED_RIDERS pasajeros distintos
//    (que no se inventen viajes entre amigos). Solo cuentan pasajeros
//    registrados de verdad (no de prueba) y nunca el teléfono de un chofer.
//  - Un chofer suspendido o borrado no gana por invitar.
//  - Solo invitados aprobados en el admin (tienen fila en drivers) y que no
//    sean cuenta de prueba.
//  - El que invita cobra máximo MONTHLY_CAP premios por mes; pasado eso ese
//    invitado queda marcado como completado pero no paga nada.
//  - Promoción hasta PROMO_END (hora de Yucatán).
// El saldo a favor NO es dinero: se resta de la cuota que el chofer entrega
// (ver register-trip-fees en routes/admin.js). Lo que no alcance a usarse se
// queda para la siguiente vez.
const { LOCAL_OFFSET } = require("./earnings");

const REFERRAL = {
  REWARD_AMOUNT: 20,   // para el que invita
  INVITEE_AMOUNT: 0,   // el invitado ya no gana (28-nov-2026)...
  // ...salvo los que entraron cuando el mensaje decía «los dos ganamos $20»:
  // aprobados antes de este día (hora de Yucatán) se les respeta su $20.
  LEGACY_INVITEE_AMOUNT: 20,
  LEGACY_BEFORE: "2026-12-01",
  REQUIRED_TRIPS: 3,
  REQUIRED_RIDERS: 3,
  MONTHLY_CAP: 5,
  PROMO_END: "2027-03-31",
};

async function promoActive(db) {
  return (await db.prepare(`SELECT date('now', '${LOCAL_OFFSET}') <= ? AS ok`).get(REFERRAL.PROMO_END)).ok === 1;
}

// Viajes que cuentan para el premio del invitado.
async function qualifyingProgress(db, invitee, inviterPhone) {
  const row = await db
    .prepare(
      `SELECT COUNT(*) AS trips, COUNT(DISTINCT r.rider_phone) AS riders
       FROM rides r
       JOIN riders rd ON rd.phone = r.rider_phone
       WHERE r.driver_id = ? AND r.status = 'completado'
         AND COALESCE(rd.es_prueba, 0) = 0
         AND r.rider_phone NOT IN (?, ?)
         AND NOT EXISTS (SELECT 1 FROM drivers dx WHERE dx.phone = r.rider_phone)`
    )
    .get(invitee.id, invitee.phone, inviterPhone || "");
  return { trips: row.trips || 0, riders: row.riders || 0 };
}

// Se llama al completar cada viaje del invitado (y al abrir el perfil, por si
// acaso). Es idempotente: un invitado solo puede generar un premio (UNIQUE).
async function checkReferralReward(db, inviteeId) {
  const invitee = await db
    .prepare("SELECT id, phone, referred_by_driver_id, es_prueba, deleted_at, created_at FROM drivers WHERE id = ?")
    .get(inviteeId);
  if (!invitee || !invitee.referred_by_driver_id || invitee.es_prueba || invitee.deleted_at) return null;
  if (await db.prepare("SELECT 1 FROM referral_rewards WHERE invitee_id = ?").get(invitee.id)) return null;
  if (!(await promoActive(db))) return null;
  const inviter = await db
    .prepare("SELECT id, phone, es_prueba, deleted_at, suspended_at FROM drivers WHERE id = ?")
    .get(invitee.referred_by_driver_id);
  if (!inviter || inviter.es_prueba || inviter.deleted_at || inviter.suspended_at) return null;

  const p = await qualifyingProgress(db, invitee, inviter.phone);
  if (p.trips < REFERRAL.REQUIRED_TRIPS || p.riders < REFERRAL.REQUIRED_RIDERS) return null;

  const inviterThisMonth = (await db
    .prepare(
      `SELECT COUNT(*) AS n FROM referral_rewards
       WHERE inviter_id = ? AND inviter_amount > 0
         AND date(earned_at, '${LOCAL_OFFSET}') >= date('now', '${LOCAL_OFFSET}', 'start of month')`
    )
    .get(inviter.id)).n;
  const inviterAmount = inviterThisMonth < REFERRAL.MONTHLY_CAP ? REFERRAL.REWARD_AMOUNT : 0;
  const legacy = (await db
    .prepare(`SELECT date(?, '${LOCAL_OFFSET}') < ? AS ok`)
    .get(invitee.created_at, REFERRAL.LEGACY_BEFORE)).ok === 1;
  const inviteeAmount = legacy ? REFERRAL.LEGACY_INVITEE_AMOUNT : REFERRAL.INVITEE_AMOUNT;
  // Nadie cobraría (el que invita ya llegó a su tope del mes): no se anota,
  // así este invitado cuenta el mes que viene.
  if (!inviterAmount && !inviteeAmount) return null;

  try {
    await db.tx(async () => {
      const r = await db
        .prepare("INSERT INTO referral_rewards (inviter_id, invitee_id, inviter_amount, invitee_amount) VALUES (?, ?, ?, ?)")
        .run(inviter.id, invitee.id, inviterAmount, inviteeAmount);
      const addCredit = db.prepare("INSERT INTO driver_credits (driver_id, amount, reason, reward_id) VALUES (?, ?, ?, ?)");
      if (inviteeAmount) await addCredit.run(invitee.id, inviteeAmount, "invitado", r.lastInsertRowid);
      if (inviterAmount) await addCredit.run(inviter.id, inviterAmount, "invito", r.lastInsertRowid);
    });
    return { inviterId: inviter.id, inviterAmount, inviteeAmount };
  } catch (e) {
    if (!db.isUniqueViolation(e)) throw e;
    return null; // otro proceso ya lo registró (UNIQUE) — no pasa nada
  }
}

// Saldo a favor que le queda al chofer (ganado − ya usado al liquidar).
async function creditBalance(db, driverId) {
  const earned = (await db.prepare("SELECT COALESCE(SUM(amount), 0) AS s FROM driver_credits WHERE driver_id = ?").get(driverId)).s;
  const used = (await db.prepare("SELECT COALESCE(SUM(credit_applied), 0) AS s FROM driver_payments WHERE driver_id = ?").get(driverId)).s;
  return Math.max(0, Math.round((earned - used) * 100) / 100);
}

// Para la tarjeta del chofer: sus invitados y cuántos premios lleva.
async function referralStatus(db, driver, shortName) {
  const active = await promoActive(db);
  const status = {
    promo: { active, amount: REFERRAL.REWARD_AMOUNT, trips: REFERRAL.REQUIRED_TRIPS, riders: REFERRAL.REQUIRED_RIDERS, cap: REFERRAL.MONTHLY_CAP, end: REFERRAL.PROMO_END },
    earned: 0,
    invitees: [],
  };
  // Premios que ya le pagaron por invitar (todos, no solo los 20 de la lista).
  status.earned = (await db
    .prepare("SELECT COUNT(*) AS n FROM referral_rewards WHERE inviter_id = ? AND inviter_amount > 0")
    .get(driver.id)).n;
  const invitees = await db
    .prepare("SELECT id, name, phone FROM drivers WHERE referred_by_driver_id = ? AND deleted_at IS NULL ORDER BY created_at DESC LIMIT 20")
    .all(driver.id);
  for (const d of invitees) {
    const rw = await db.prepare("SELECT inviter_amount FROM referral_rewards WHERE invitee_id = ?").get(d.id);
    status.invitees.push({ name: shortName(d.name), rewarded: !!rw, myAmount: rw ? rw.inviter_amount : 0, ...(await qualifyingProgress(db, d, driver.phone)) });
  }
  return status;
}

module.exports = { REFERRAL, checkReferralReward, creditBalance, referralStatus };
