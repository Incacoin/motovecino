// "Invita pasajeros" (23-nov-2026): el chofer enseña su QR (o dicta su código)
// y el pasajero que se registra con él queda ligado a ese chofer.
// Reglas acordadas con el dueño:
//  - Cuenta solo el pasajero NUEVO que ya COMPLETÓ RIDES_REQUIRED viajes (con
//    cualquier chofer). Registrarse no basta: así no se pueden inflar con
//    cuentas de familia, y cada pasajero que cuenta ya dejó sus cuotas → el
//    premio se paga solo (5 × 3 viajes ≈ $30 de cuota por $20 de premio).
//    Cambiado el 24-nov-2026 a pedido del dueño (antes 20 con 1 viaje = $40)
//    y el 26-nov-2026 de 10 a 5 pasajeros por premio (el chofer gana $4 por
//    invitado, más que el pasajero en "Invita a tu vecino").
//  - No cuentan pasajeros de prueba ni el teléfono del propio chofer.
//  - Por cada PER_BATCH que cuentan, el chofer gana AMOUNT de saldo a favor
//    (se resta de su cuota, igual que "Invita a otro chofer"; no es efectivo).
//  - Promoción hasta PROMO_END (hora de Yucatán): después ya no se ligan
//    pasajeros nuevos ni se dan premios.
const { LOCAL_OFFSET } = require("./earnings");
const { SERVICE_FEE, TAXI_COMMISSION_RATE } = require("./constants");
const { findInviter, findRiderInviter, ensureRiderInviteCode, RIDER_CODE_LENGTH, findPromoter, PROMOTER_CODE_LENGTH } = require("./invites");

const RIDER_REFERRAL_RIDES = 3;
const RIDER_REFERRAL = {
  PER_BATCH: 5,
  AMOUNT: 20,
  RIDES_REQUIRED: RIDER_REFERRAL_RIDES,
  PROMO_END: "2027-03-31",
};

// Los viajes que cuentan: completados, de pasaje (no un envío de negocio) y
// que dejaron al menos la cuota de un mototaxi. Así un taxi de $1 no cuenta y
// el premio siempre se paga solo (revisión 24-nov-2026). El pasajero cuenta
// cuando junta RIDES_REQUIRED de esos viajes. El viaje cortesía ("Invita a tu
// vecino", lo paga MotoVecino) NO cuenta para ningún premio, ni de vecino ni
// de chofer: un regalo no ayuda a ganar otro (decidido con el dueño 26-nov-2026).
// `x` = alias de rides, `r` = alias de riders. Lo usa también el admin.
const RIDES_COUNT_SQL = `(SELECT COUNT(*) FROM rides x WHERE x.rider_phone = r.phone AND x.status = 'completado'
  AND x.business_id IS NULL AND x.courtesy_max IS NULL
  AND (COALESCE(x.ride_type, 'moto') <> 'taxi' OR COALESCE(x.agreed_price, 0) * ${Number(TAXI_COMMISSION_RATE)} >= ${Number(SERVICE_FEE)}))`;
const QUALIFYING_RIDE_SQL = `${RIDES_COUNT_SQL} >= ${Number(RIDER_REFERRAL_RIDES)}`;

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

// ---- "Invita a tu vecino" (25-nov-2026): pasajero invita pasajero ----
// Reglas acordadas con el dueño: cuenta el vecino NUEVO que ya completó
// RIDES_REQUIRED viajes que dejan cuota (mismo filtro que arriba). Por cada
// PER_BATCH vecinos que cuentan, el pasajero gana un viaje cortesía de hasta
// COURTESY_MAX. 5 vecinos × 3 viajes × cuota ≈ $30 que entran por $15 de premio.
// Se ganan hasta PROMO_END; las ya ganadas se pueden usar hasta USE_END (un
// mes de gracia). Al chofer se le paga en la oficina (ver payCourtesy).
const RIDER_FRIEND = {
  PER_BATCH: 5,
  RIDES_REQUIRED: RIDER_REFERRAL_RIDES,
  COURTESY_MAX: 15,
  PROMO_END: RIDER_REFERRAL.PROMO_END,
  USE_END: "2027-04-30",
};

async function courtesyUseOpen(db) {
  return (await db.prepare(`SELECT date('now', '${LOCAL_OFFSET}') <= ? AS ok`).get(RIDER_FRIEND.USE_END)).ok === 1;
}

// Código del QR → quién invitó: { driverId }, { riderId } o { promoterId } (o null).
// El de promotor (5 letras) no depende de la fecha de fin de las promociones
// de invitar: sirve mientras el promotor esté activo en el admin.
async function inviterFromCode(db, code, riderPhone) {
  if (!code) return null;
  const clean = String(code).trim().toUpperCase();
  if (clean.length === PROMOTER_CODE_LENGTH) {
    const p = await findPromoter(db, clean);
    return p && (!p.phone || p.phone !== riderPhone) ? { promoterId: p.id } : null;
  }
  if (!(await riderPromoActive(db))) return null;
  if (clean.length === RIDER_CODE_LENGTH) {
    const r = await findRiderInviter(db, clean);
    return r && r.phone !== riderPhone ? { riderId: r.id } : null;
  }
  const driverId = await riderInviterId(db, clean, riderPhone);
  return driverId ? { driverId } : null;
}

async function friendCounts(db, rider) {
  const row = await db
    .prepare(
      `SELECT COUNT(*) AS registered,
              SUM(CASE WHEN t.n >= ${Number(RIDER_FRIEND.RIDES_REQUIRED)} THEN 1 ELSE 0 END) AS qualified,
              SUM(CASE WHEN t.n >= 1 AND t.n < ${Number(RIDER_FRIEND.RIDES_REQUIRED)} THEN 1 ELSE 0 END) AS started
       FROM (SELECT ${RIDES_COUNT_SQL} AS n FROM riders r
             WHERE r.referred_by_rider_id = ? AND COALESCE(r.es_prueba, 0) = 0 AND r.phone <> ?) t`
    )
    .get(rider.id, rider.phone || "");
  return { registered: Number(row.registered) || 0, qualified: Number(row.qualified) || 0, started: Number(row.started) || 0 };
}

// Apunta las tandas nuevas (idempotente: UNIQUE por tanda). Solo mientras
// dura la promoción; lo ya ganado se puede usar después.
async function checkRiderFriendReward(db, riderId) {
  const rider = await db.prepare("SELECT id, phone, es_prueba FROM riders WHERE id = ?").get(riderId);
  if (!rider || rider.es_prueba) return 0;
  if (!(await riderPromoActive(db))) return 0;
  const { qualified } = await friendCounts(db, rider);
  const batches = Math.floor(qualified / RIDER_FRIEND.PER_BATCH);
  const have = Number((await db.prepare("SELECT COUNT(*) AS n FROM rider_friend_rewards WHERE rider_id = ?").get(rider.id)).n) || 0;
  let added = 0;
  for (let n = have + 1; n <= batches; n++) {
    try {
      await db.prepare("INSERT INTO rider_friend_rewards (rider_id, batch_no) VALUES (?, ?)").run(rider.id, n);
      added++;
    } catch (e) {
      if (!db.isUniqueViolation(e)) throw e;
    }
  }
  return added;
}

// Al completar un viaje: si el pasajero vino invitado por otro pasajero.
async function checkRiderFriendForRide(db, riderPhone) {
  if (!riderPhone) return 0;
  const r = await db.prepare("SELECT referred_by_rider_id FROM riders WHERE phone = ?").get(riderPhone);
  if (!r || !r.referred_by_rider_id) return 0;
  return checkRiderFriendReward(db, r.referred_by_rider_id);
}

// Una cortesía está libre si no se ha usado o si su viaje se canceló ANTES de
// empezar (si ya iba en camino, el viaje pasó: no se regresa).
const CANCELLED_BEFORE_START = `u.status = 'cancelado' AND u.started_at_ms IS NULL`;
const FREE_REWARD_SQL = `(f.used_ride_id IS NULL OR EXISTS (SELECT 1 FROM rides u WHERE u.id = f.used_ride_id AND ${CANCELLED_BEFORE_START}))`;

async function courtesiesAvailable(db, riderId) {
  if (!(await courtesyUseOpen(db))) return 0;
  return Number((await db.prepare(`SELECT COUNT(*) AS n FROM rider_friend_rewards f WHERE f.rider_id = ? AND ${FREE_REWARD_SQL}`).get(riderId)).n) || 0;
}

// Aparta una cortesía para este viaje. La condición se repite en el UPDATE
// para que dos pedidos al mismo tiempo no usen la misma. true = quedó apartada.
async function claimCourtesy(db, riderId, rideId) {
  if (!(await courtesyUseOpen(db))) return false;
  const r = await db
    .prepare(
      `UPDATE rider_friend_rewards SET used_ride_id = ?
       WHERE id = (SELECT f.id FROM rider_friend_rewards f WHERE f.rider_id = ? AND ${FREE_REWARD_SQL} ORDER BY f.batch_no LIMIT 1)
         AND (used_ride_id IS NULL OR EXISTS (SELECT 1 FROM rides u WHERE u.id = rider_friend_rewards.used_ride_id AND ${CANCELLED_BEFORE_START}))`
    )
    .run(rideId, riderId);
  if (!r.changes) return false;
  await db.prepare("UPDATE rides SET courtesy_max = ? WHERE id = ?").run(RIDER_FRIEND.COURTESY_MAX, rideId);
  return true;
}

// Al terminar un viaje con cortesía: se anota lo que MotoVecino le debe al
// chofer (hasta COURTESY_MAX). No se paga aquí: queda «por pagar» en el admin
// (ver settleCourtesy). Solo la primera vez cuenta.
// Lo que MotoVecino cubre de un viaje cortesía: hasta courtesy_max, nunca más
// que el precio. null si no es viaje cortesía.
function courtesyAmountFor(ride) {
  if (!ride || !ride.courtesy_max) return null;
  const price = Number(ride.agreed_price ?? ride.offer_price) || 0;
  const amount = Math.min(Number(ride.courtesy_max), Math.max(0, price));
  return amount > 0 ? amount : null;
}

// Respaldo: /complete ya lo anota en el mismo UPDATE que cierra el viaje.
async function payCourtesy(db, rideId) {
  const ride = await db.prepare("SELECT id, driver_id, status, agreed_price, offer_price, courtesy_max FROM rides WHERE id = ?").get(rideId);
  if (!ride || !ride.courtesy_max || ride.status !== "completado" || !ride.driver_id) return 0;
  const amount = courtesyAmountFor(ride);
  if (!amount) return 0;
  const r = await db.prepare("UPDATE rides SET courtesy_amount = ? WHERE id = ? AND courtesy_amount IS NULL").run(amount, ride.id);
  return r.changes ? amount : 0;
}

// En la oficina: «efectivo» (caja chica) o «saldo» (se le resta de su cuota).
// Una sola vez por viaje: la condición va en el UPDATE y el saldo tiene UNIQUE.
async function settleCourtesy(db, rideId, how) {
  if (how !== "efectivo" && how !== "saldo") return { error: "Forma de pago no válida" };
  return db.tx(async () => {
    const r = await db
      .prepare("UPDATE rides SET courtesy_paid_how = ?, courtesy_paid_at = datetime('now') WHERE id = ? AND courtesy_amount > 0 AND courtesy_paid_how IS NULL AND status = 'completado'")
      .run(how, rideId);
    if (!r.changes) return { error: "Ya estaba pagado o no es un viaje cortesía" };
    if (how === "saldo") {
      const ride = await db.prepare("SELECT driver_id, courtesy_amount FROM rides WHERE id = ?").get(rideId);
      await db.prepare("INSERT INTO driver_credits (driver_id, amount, reason, courtesy_ride_id) VALUES (?, ?, 'cortesia', ?)").run(ride.driver_id, ride.courtesy_amount, rideId);
    }
    return { ok: true };
  });
}

// El chofer elige al terminar (o después) cómo quiere lo de su viaje
// cortesía. «saldo»: se le pone al instante (settleCourtesy). «efectivo»: se
// anota y queda por pagar en la oficina. Solo viajes suyos y sin pagar.
async function pendingCourtesiesForDriver(db, driverId) {
  return db
    .prepare(
      `SELECT id, courtesy_amount AS amount, completed_at AS completedAt FROM rides
       WHERE driver_id = ? AND status = 'completado' AND courtesy_amount > 0
         AND courtesy_paid_how IS NULL AND courtesy_choice IS NULL
       ORDER BY completed_at LIMIT 20`
    )
    .all(driverId);
}

async function chooseCourtesy(db, driverId, rideId, how) {
  if (how !== "efectivo" && how !== "saldo") return { error: "Forma de pago no válida" };
  const ride = await db
    .prepare("SELECT id FROM rides WHERE id = ? AND driver_id = ? AND status = 'completado' AND courtesy_amount > 0 AND courtesy_paid_how IS NULL AND courtesy_choice IS NULL")
    .get(rideId, driverId);
  if (!ride) return { error: "Este viaje ya está resuelto" };
  if (how === "saldo") {
    const r = await settleCourtesy(db, rideId, "saldo");
    if (r.error) return r;
    await db.prepare("UPDATE rides SET courtesy_choice = 'saldo' WHERE id = ?").run(rideId);
    return { ok: true };
  }
  const r = await db
    .prepare("UPDATE rides SET courtesy_choice = 'efectivo' WHERE id = ? AND driver_id = ? AND courtesy_paid_how IS NULL AND courtesy_choice IS NULL")
    .run(rideId, driverId);
  return r.changes ? { ok: true } : { error: "Este viaje ya está resuelto" };
}

// Para la ventanita "Invita a tu vecino" del pasajero.
async function friendStatus(db, rider) {
  const code = await ensureRiderInviteCode(db, rider.id);
  try { await checkRiderFriendReward(db, rider.id); } catch (e) { console.error("[invita-vecino]", e.message); }
  const c = await friendCounts(db, rider);
  return {
    available: await courtesiesAvailable(db, rider.id),
    useEnd: RIDER_FRIEND.USE_END,
    active: await riderPromoActive(db),
    code,
    perBatch: RIDER_FRIEND.PER_BATCH,
    ridesRequired: RIDER_FRIEND.RIDES_REQUIRED,
    courtesyMax: RIDER_FRIEND.COURTESY_MAX,
    end: RIDER_FRIEND.PROMO_END,
    registered: c.registered,
    started: c.started,
    qualified: c.qualified,
    inBatch: c.qualified % RIDER_FRIEND.PER_BATCH,
    courtesiesEarned: Math.floor(c.qualified / RIDER_FRIEND.PER_BATCH),
  };
}

async function riderCounts(db, driver) {
  const row = await db
    .prepare(
      `SELECT COUNT(*) AS registered,
              SUM(CASE WHEN t.n >= ${Number(RIDER_REFERRAL_RIDES)} THEN 1 ELSE 0 END) AS qualified,
              SUM(CASE WHEN t.n >= 1 AND t.n < ${Number(RIDER_REFERRAL_RIDES)} THEN 1 ELSE 0 END) AS started
       FROM (SELECT ${RIDES_COUNT_SQL} AS n FROM riders r
             WHERE r.referred_by_driver_id = ? AND COALESCE(r.es_prueba, 0) = 0 AND r.phone <> ?) t`
    )
    .get(driver.id, driver.phone || "");
  return { registered: Number(row.registered) || 0, qualified: Number(row.qualified) || 0, started: Number(row.started) || 0 };
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
    ridesRequired: RIDER_REFERRAL.RIDES_REQUIRED,
    amount: RIDER_REFERRAL.AMOUNT,
    end: RIDER_REFERRAL.PROMO_END,
    registered: counts.registered,
    qualified: counts.qualified,
    started: counts.started,
    inBatch: counts.qualified % RIDER_REFERRAL.PER_BATCH,
    rewards: Number(earned.n) || 0,
    earnedTotal: Number(earned.total) || 0,
  };
}

module.exports = { RIDES_COUNT_SQL, courtesyAmountFor, RIDER_FRIEND, inviterFromCode, friendStatus, checkRiderFriendReward, checkRiderFriendForRide, courtesiesAvailable, claimCourtesy, payCourtesy, settleCourtesy, pendingCourtesiesForDriver, chooseCourtesy, RIDER_REFERRAL, QUALIFYING_RIDE_SQL, riderInviterId, checkRiderReferralReward, checkRiderReferralForRide, riderReferralStatus };
