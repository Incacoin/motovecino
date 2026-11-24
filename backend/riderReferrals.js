// "Invita pasajeros" (23-nov-2026): el chofer enseña su QR (o dicta su código)
// y el pasajero que se registra con él queda ligado a ese chofer.
// Reglas acordadas con el dueño:
//  - Cuenta solo el pasajero NUEVO que ya COMPLETÓ al menos un viaje (con
//    cualquier chofer). Registrarse no basta: así no se pueden inflar con
//    cuentas de familia, y cada pasajero que cuenta ya dejó su cuota → el
//    premio se paga solo.
//  - No cuentan pasajeros de prueba ni el teléfono del propio chofer.
//  - Por cada PER_BATCH que cuentan, el chofer gana AMOUNT de saldo a favor
//    (se resta de su cuota, igual que "Invita a otro chofer"; no es efectivo).
//  - Promoción hasta PROMO_END (hora de Yucatán): después ya no se ligan
//    pasajeros nuevos ni se dan premios.
const { LOCAL_OFFSET } = require("./earnings");
const { SERVICE_FEE, TAXI_COMMISSION_RATE } = require("./constants");
const { findInviter } = require("./invites");

const RIDER_REFERRAL = {
  PER_BATCH: 20,
  AMOUNT: 40,
  PROMO_END: "2026-12-31",
};

// El viaje que hace "contar" al pasajero: completado, de pasaje (no un envío
// de negocio) y que dejó al menos la cuota de un mototaxi. Así un taxi de $1
// no cuenta y el premio siempre se paga solo (revisión 24-nov-2026).
// `x` = alias de rides, `r` = alias de riders. Lo usa también el admin.
const QUALIFYING_RIDE_SQL = `EXISTS (SELECT 1 FROM rides x WHERE x.rider_phone = r.phone AND x.status = 'completado'
  AND x.business_id IS NULL
  AND (COALESCE(x.ride_type, 'moto') <> 'taxi' OR COALESCE(x.agreed_price, 0) * ${Number(TAXI_COMMISSION_RATE)} >= ${Number(SERVICE_FEE)}))`;

async function riderPromoActive(db) {
  return (await db.prepare(`SELECT date('now', '${LOCAL_OFFSET}') <= ? AS ok`).get(RIDER_REFERRAL.PROMO_END)).ok === 1;
}

// Código del chofer que invitó → id del chofer, o null si no aplica.
async function riderInviterId(db, code, riderPhone) {
  if (!code || !(await riderPromoActive(db))) return null;
  const inviter = await findInviter(db, code);
  if (!inviter || inviter.phone === riderPhone) return null;
  return inviter.id;
}

async function riderCounts(db, driver) {
  const row = await db
    .prepare(
      `SELECT COUNT(*) AS registered,
              SUM(CASE WHEN ${QUALIFYING_RIDE_SQL} THEN 1 ELSE 0 END) AS qualified
       FROM riders r
       WHERE r.referred_by_driver_id = ? AND COALESCE(r.es_prueba, 0) = 0 AND r.phone <> ?`
    )
    .get(driver.id, driver.phone || "");
  return { registered: Number(row.registered) || 0, qualified: Number(row.qualified) || 0 };
}

// Se llama al completar un viaje de un pasajero invitado y al abrir el perfil
// del chofer. Idempotente: cada tanda (1, 2, 3…) solo se paga una vez (UNIQUE).
async function checkRiderReferralReward(db, driverId) {
  const driver = await db.prepare("SELECT id, phone, es_prueba, deleted_at FROM drivers WHERE id = ?").get(driverId);
  if (!driver || driver.es_prueba || driver.deleted_at) return 0;
  if (!(await riderPromoActive(db))) return 0;
  const { qualified } = await riderCounts(db, driver);
  const batches = Math.floor(qualified / RIDER_REFERRAL.PER_BATCH);
  const paid = Number((await db.prepare("SELECT COUNT(*) AS n FROM rider_referral_rewards WHERE driver_id = ?").get(driver.id)).n) || 0;
  let added = 0;
  for (let n = paid + 1; n <= batches; n++) {
    try {
      await db.tx(async () => {
        const r = await db
          .prepare("INSERT INTO rider_referral_rewards (driver_id, batch_no, amount) VALUES (?, ?, ?)")
          .run(driver.id, n, RIDER_REFERRAL.AMOUNT);
        await db
          .prepare("INSERT INTO driver_credits (driver_id, amount, reason, rider_reward_id) VALUES (?, ?, 'pasajeros', ?)")
          .run(driver.id, RIDER_REFERRAL.AMOUNT, r.lastInsertRowid);
      });
      added++;
    } catch (e) {
      if (!db.isUniqueViolation(e)) throw e; // otro proceso ya pagó esa tanda
    }
  }
  return added;
}

// Al completar un viaje: si el pasajero vino invitado, revisar a su chofer.
async function checkRiderReferralForRide(db, riderPhone) {
  if (!riderPhone) return 0;
  const rider = await db.prepare("SELECT referred_by_driver_id FROM riders WHERE phone = ?").get(riderPhone);
  if (!rider || !rider.referred_by_driver_id) return 0;
  return checkRiderReferralReward(db, rider.referred_by_driver_id);
}

// Para la tarjeta "Invita pasajeros" del chofer.
async function riderReferralStatus(db, driver) {
  const counts = await riderCounts(db, driver);
  const earned = await db
    .prepare("SELECT COUNT(*) AS n, COALESCE(SUM(amount), 0) AS total FROM rider_referral_rewards WHERE driver_id = ?")
    .get(driver.id);
  return {
    active: await riderPromoActive(db),
    perBatch: RIDER_REFERRAL.PER_BATCH,
    amount: RIDER_REFERRAL.AMOUNT,
    end: RIDER_REFERRAL.PROMO_END,
    registered: counts.registered,
    qualified: counts.qualified,
    inBatch: counts.qualified % RIDER_REFERRAL.PER_BATCH,
    rewards: Number(earned.n) || 0,
    earnedTotal: Number(earned.total) || 0,
  };
}

module.exports = { RIDER_REFERRAL, QUALIFYING_RIDE_SQL, riderInviterId, checkRiderReferralReward, checkRiderReferralForRide, riderReferralStatus };
