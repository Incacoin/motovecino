// Premio de "Invita a otro chofer" (parte 2). Reglas acordadas 29-sep-2026,
// pensadas para que el premio se pague solo y nunca salga efectivo:
//  - Cuando el invitado completa REQUIRED_TRIPS viajes (esos ya dejaron al
//    menos $40 de cuota), los DOS ganan REWARD_AMOUNT de saldo a favor.
//  - Los viajes deben ser con al menos REQUIRED_RIDERS pasajeros distintos
//    (que no se inventen viajes entre amigos). No cuentan pasajeros de
//    prueba, ni viajes pedidos desde el teléfono del invitado o del que
//    invitó.
//  - Solo invitados aprobados en el admin (tienen fila en drivers) y que no
//    sean cuenta de prueba.
//  - El que invita cobra máximo MONTHLY_CAP premios por mes; pasado eso el
//    invitado sí recibe el suyo, el que invita no.
//  - Promoción hasta PROMO_END (hora de Yucatán).
// El saldo a favor NO es dinero: se resta de la cuota que el chofer entrega
// (ver register-trip-fees en routes/admin.js). Lo que no alcance a usarse se
// queda para la siguiente vez.
const { LOCAL_OFFSET } = require("./earnings");

const REFERRAL = {
  REWARD_AMOUNT: 20,
  REQUIRED_TRIPS: 20,
  REQUIRED_RIDERS: 10,
  MONTHLY_CAP: 5,
  PROMO_END: "2026-12-31",
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
       LEFT JOIN riders rd ON rd.phone = r.rider_phone
       WHERE r.driver_id = ? AND r.status = 'completado'
         AND COALESCE(rd.es_prueba, 0) = 0
         AND r.rider_phone NOT IN (?, ?)`
    )
    .get(invitee.id, invitee.phone, inviterPhone || "");
  return { trips: row.trips || 0, riders: row.riders || 0 };
}

// Se llama al completar cada viaje del invitado (y al abrir el perfil, por si
// acaso). Es idempotente: un invitado solo puede generar un premio (UNIQUE).
async function checkReferralReward(db, inviteeId) {
  const invitee = await db
    .prepare("SELECT id, phone, referred_by_driver_id, es_prueba, deleted_at FROM drivers WHERE id = ?")
    .get(inviteeId);
  if (!invitee || !invitee.referred_by_driver_id || invitee.es_prueba || invitee.deleted_at) return null;
  if (await db.prepare("SELECT 1 FROM referral_rewards WHERE invitee_id = ?").get(invitee.id)) return null;
  if (!(await promoActive(db))) return null;
  const inviter = await db
    .prepare("SELECT id, phone, es_prueba, deleted_at FROM drivers WHERE id = ?")
    .get(invitee.referred_by_driver_id);
  if (!inviter || inviter.es_prueba || inviter.deleted_at) return null;

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

  try {
    await db.tx(async () => {
      const r = await db
        .prepare("INSERT INTO referral_rewards (inviter_id, invitee_id, inviter_amount, invitee_amount) VALUES (?, ?, ?, ?)")
        .run(inviter.id, invitee.id, inviterAmount, REFERRAL.REWARD_AMOUNT);
      const addCredit = db.prepare("INSERT INTO driver_credits (driver_id, amount, reason, reward_id) VALUES (?, ?, ?, ?)");
      await addCredit.run(invitee.id, REFERRAL.REWARD_AMOUNT, "invitado", r.lastInsertRowid);
      if (inviterAmount) await addCredit.run(inviter.id, inviterAmount, "invito", r.lastInsertRowid);
    });
    return { inviterId: inviter.id, inviterAmount };
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

// Para la tarjeta del chofer: cómo va él (si lo invitaron) y sus invitados.
async function referralStatus(db, driver, shortName) {
  const active = await promoActive(db);
  const status = {
    promo: { active, amount: REFERRAL.REWARD_AMOUNT, trips: REFERRAL.REQUIRED_TRIPS, riders: REFERRAL.REQUIRED_RIDERS, end: REFERRAL.PROMO_END },
    mine: null,
    invitees: [],
  };
  const me = await db.prepare("SELECT id, phone, referred_by_driver_id FROM drivers WHERE id = ?").get(driver.id);
  if (me && me.referred_by_driver_id) {
    const inviter = await db.prepare("SELECT name, phone FROM drivers WHERE id = ?").get(me.referred_by_driver_id);
    const rewarded = !!await db.prepare("SELECT 1 FROM referral_rewards WHERE invitee_id = ?").get(me.id);
    status.mine = { inviterName: shortName(inviter?.name), rewarded, ...(await qualifyingProgress(db, me, inviter?.phone)) };
  }
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
