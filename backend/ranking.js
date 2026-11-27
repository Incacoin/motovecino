// Ranking de choferes (27-nov-2026): el chofer que más pasajeros nuevos invite
// con su QR (el de «Invita pasajeros») en una semana gana un premio en
// efectivo. Reglas acordadas con el dueño:
//  - Cuenta el pasajero NUEVO que se registró con el código del chofer dentro
//    de las fechas (riders.referred_at, que ya guarda la hora del registro; por
//    eso el conteo sale bien aunque el ranking se suba días después).
//    El registro ya pide el código de WhatsApp, así que es un número real.
//  - No cuentan pasajeros de prueba, el teléfono del propio chofer ni choferes
//    de prueba o borrados. El admin puede QUITAR del ranking a un chofer si ve
//    registros falsos (columna «con viaje» para revisar).
//  - Gana el primer lugar si llega al mínimo. Empate: gana quien llegó primero
//    a esa cantidad (su último pasajero que cuenta se registró antes).
//  - El premio se paga en efectivo en la oficina; el admin lo marca pagado.
//  - Se programa con fecha de inicio y fin (hora de Yucatán) y se puede apagar
//    antes. Un municipio no puede tener dos rankings que se encimen.
const { LOCAL_OFFSET } = require("./earnings");
const { SERVICE_FEE, TAXI_COMMISSION_RATE } = require("./constants");

const OFFSET_HOURS = Number(String(LOCAL_OFFSET).match(/-?\d+/)[0]); // -6
const MAX_DAYS = 31;

// Viajes de pasaje completados que dejaron cuota (mismo filtro que «Invita
// pasajeros»): solo para que el admin vea quién de verdad usa la app.
const RIDES_SQL = `(SELECT COUNT(*) FROM rides x WHERE x.rider_phone = r.phone AND x.status = 'completado'
  AND x.business_id IS NULL AND x.courtesy_max IS NULL
  AND (COALESCE(x.ride_type, 'moto') <> 'taxi' OR COALESCE(x.agreed_price, 0) * ${Number(TAXI_COMMISSION_RATE)} >= ${Number(SERVICE_FEE)}))`;

// "2026-11-28T00:00" (hora de Yucatán) → "2026-11-28 06:00:00" (UTC, igual
// que riders.referred_at). null si no es una fecha válida.
function localToUtc(s) {
  const m = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})$/.exec(String(s || "").trim());
  if (!m) return null;
  const [y, mo, d, h, mi] = m.slice(1).map(Number);
  const ms = Date.UTC(y, mo - 1, d, h, mi) - OFFSET_HOURS * 3600e3;
  const dt = new Date(ms);
  // Rechaza 31-feb y similares (Date.UTC los "acomoda" al mes siguiente).
  const back = new Date(ms + OFFSET_HOURS * 3600e3);
  if (back.getUTCFullYear() !== y || back.getUTCMonth() !== mo - 1 || back.getUTCDate() !== d || back.getUTCHours() !== h || back.getUTCMinutes() !== mi) return null;
  return dt.toISOString().slice(0, 19).replace("T", " ");
}

function nowUtc() {
  return new Date().toISOString().slice(0, 19).replace("T", " ");
}

// Hasta cuándo cuenta: el fin, o antes si lo apagaron.
function effectiveEnd(c) {
  return c.stopped_at && c.stopped_at < c.ends_at ? c.stopped_at : c.ends_at;
}

function statusOf(c, now = nowUtc()) {
  if (c.stopped_at && c.stopped_at <= c.starts_at) return "cancelado";
  if (now < c.starts_at) return "programado";
  if (now >= effectiveEnd(c)) return c.stopped_at && c.stopped_at < c.ends_at ? "apagado" : "terminado";
  return "en_curso";
}

function excludedIds(c) {
  try {
    const a = JSON.parse(c.excluded || "[]");
    return Array.isArray(a) ? a.map(Number).filter(Number.isInteger) : [];
  } catch {
    return [];
  }
}

// La lista: choferes del municipio con al menos un pasajero que cuenta.
async function board(db, c) {
  const end = effectiveEnd(c);
  const now = nowUtc();
  const until = now < end ? now : end;
  const rows = await db
    .prepare(
      `SELECT d.id, d.name, d.grupo, d.numero_unidad, d.vehicle_type, d.suspended_at,
              COUNT(*) AS n,
              SUM(CASE WHEN t.rides >= 1 THEN 1 ELSE 0 END) AS with_ride,
              MAX(t.referred_at) AS last_at
       FROM (SELECT r.referred_by_driver_id AS did, r.phone, r.referred_at, ${RIDES_SQL} AS rides
             FROM riders r
             WHERE r.referred_by_driver_id IS NOT NULL AND COALESCE(r.es_prueba, 0) = 0
               AND r.referred_at >= ? AND r.referred_at < ? AND r.referred_at <= ?) t
       JOIN drivers d ON d.id = t.did
       WHERE d.city = ? AND d.deleted_at IS NULL AND COALESCE(d.es_prueba, 0) = 0
         AND t.phone <> d.phone
       GROUP BY d.id, d.name, d.grupo, d.numero_unidad, d.vehicle_type, d.suspended_at
       ORDER BY n DESC, last_at ASC, d.id ASC`
    )
    .all(c.starts_at, end, until, c.city);
  const excluded = new Set(excludedIds(c));
  let place = 0;
  return rows.map((r) => {
    const out = {
      id: r.id,
      name: r.name,
      grupo: r.grupo,
      numeroUnidad: r.numero_unidad,
      vehicleType: r.vehicle_type,
      suspended: !!r.suspended_at,
      count: Number(r.n) || 0,
      withRide: Number(r.with_ride) || 0,
      lastAt: r.last_at,
      excluded: excluded.has(r.id),
      place: null,
    };
    if (!out.excluded) out.place = ++place;
    return out;
  });
}

// Quién gana (o va ganando): el primer lugar, si llegó al mínimo.
function leaderOf(c, rows) {
  const first = rows.find((r) => !r.excluded);
  return first && first.count >= c.min_count ? first : null;
}

function publicCampaign(c) {
  return {
    id: c.id,
    startsAt: c.starts_at,
    endsAt: c.ends_at,
    stoppedAt: c.stopped_at,
    prize: c.prize,
    minCount: c.min_count,
    status: statusOf(c),
    winnerDriverId: c.winner_driver_id,
    paidAt: c.paid_at,
  };
}

async function listCampaigns(db, city) {
  const rows = await db.prepare("SELECT * FROM ranking_campaigns WHERE city = ? ORDER BY starts_at DESC, id DESC LIMIT 30").all(city);
  return rows.map(publicCampaign);
}

async function createCampaign(db, city, body) {
  const startsAt = localToUtc(body.startsLocal);
  const endsAt = localToUtc(body.endsLocal);
  const prize = Number(body.prize);
  const minCount = Number(body.minCount);
  if (!startsAt || !endsAt) return { error: "Revisa las fechas" };
  if (endsAt <= startsAt) return { error: "La fecha de fin debe ser después del inicio" };
  if (endsAt <= nowUtc()) return { error: "La fecha de fin ya pasó" };
  const days = (Date.parse(endsAt.replace(" ", "T") + "Z") - Date.parse(startsAt.replace(" ", "T") + "Z")) / 86400e3;
  if (days > MAX_DAYS) return { error: `Un ranking dura máximo ${MAX_DAYS} días` };
  if (!Number.isInteger(prize) || prize < 1 || prize > 10000) return { error: "El premio debe ser de $1 a $10,000" };
  if (!Number.isInteger(minCount) || minCount < 1 || minCount > 1000) return { error: "El mínimo debe ser de 1 a 1000 pasajeros" };
  // No se enciman: un pasajero solo puede contar en un ranking a la vez.
  const all = await db.prepare("SELECT * FROM ranking_campaigns WHERE city = ?").all(city);
  const clash = all.find((c) => statusOf(c) !== "cancelado" && startsAt < effectiveEnd(c) && c.starts_at < endsAt);
  if (clash) return { error: "Ya hay un ranking en esas fechas. Apágalo o elige otras fechas." };
  const r = await db
    .prepare("INSERT INTO ranking_campaigns (city, starts_at, ends_at, prize, min_count) VALUES (?, ?, ?, ?, ?)")
    .run(city, startsAt, endsAt, prize, minCount);
  return { ok: true, id: r.lastInsertRowid };
}

async function getCampaign(db, id) {
  return db.prepare("SELECT * FROM ranking_campaigns WHERE id = ?").get(id);
}

// Apagar antes de tiempo (o cancelar uno programado). Lo que ya contó se queda.
async function stopCampaign(db, id) {
  const c = await getCampaign(db, id);
  if (!c) return { error: "No encontrado" };
  const st = statusOf(c);
  if (st !== "en_curso" && st !== "programado") return { error: "Este ranking ya terminó" };
  const now = nowUtc();
  // Uno programado se cancela del todo (stopped_at = su inicio).
  await db.prepare("UPDATE ranking_campaigns SET stopped_at = ? WHERE id = ? AND stopped_at IS NULL").run(st === "programado" ? c.starts_at : now, id);
  return { ok: true };
}

async function setExcluded(db, id, driverId, excluded) {
  const c = await getCampaign(db, id);
  if (!c) return { error: "No encontrado" };
  if (c.paid_at) return { error: "Este ranking ya se pagó" };
  const d = Number(driverId);
  if (!Number.isInteger(d) || d <= 0 || typeof excluded !== "boolean") return { error: "Datos no válidos" };
  const driver = await db.prepare("SELECT id FROM drivers WHERE id = ? AND city = ?").get(d, c.city);
  if (!driver) return { error: "Ese chofer no es de este municipio" };
  const set = new Set(excludedIds(c));
  if (excluded) set.add(d);
  else set.delete(d);
  await db.prepare("UPDATE ranking_campaigns SET excluded = ? WHERE id = ?").run(JSON.stringify([...set]), id);
  return { ok: true };
}

// Marcar pagado: solo cuando ya terminó y solo al que ganó según la lista.
async function markPaid(db, id, driverId) {
  const c = await getCampaign(db, id);
  if (!c) return { error: "No encontrado" };
  const st = statusOf(c);
  if (st !== "terminado" && st !== "apagado") return { error: "El ranking todavía no termina" };
  if (c.paid_at) return { error: "Ya estaba pagado" };
  const winner = leaderOf(c, await board(db, c));
  if (!winner) return { error: `Nadie llegó al mínimo de ${c.min_count} pasajeros` };
  if (winner.id !== Number(driverId)) return { error: "Ese chofer no es el ganador" };
  const r = await db
    .prepare("UPDATE ranking_campaigns SET winner_driver_id = ?, paid_at = datetime('now') WHERE id = ? AND paid_at IS NULL")
    .run(winner.id, id);
  return r.changes ? { ok: true } : { error: "Ya estaba pagado" };
}

// Para la app del chofer: el ranking de su municipio que va (o el que viene),
// su lugar y cuántos lleva. Nunca nombres ni datos de otros choferes, solo
// cuántos lleva el primero. Un chofer quitado del ranking no lo ve.
async function driverRanking(db, driver) {
  if (!driver || driver.es_prueba) return null;
  const now = nowUtc();
  const rows = await db
    .prepare("SELECT * FROM ranking_campaigns WHERE city = ? AND ends_at > ? ORDER BY starts_at LIMIT 5")
    .all(driver.city, now);
  const c = rows.find((x) => ["en_curso", "programado"].includes(statusOf(x, now)));
  if (!c || excludedIds(c).includes(driver.id)) return null;
  const status = statusOf(c, now);
  const out = { status, startsAt: c.starts_at, endsAt: effectiveEnd(c), prize: c.prize, minCount: c.min_count, count: 0, place: null, leaderCount: 0, participants: 0 };
  if (status === "en_curso") {
    const list = (await board(db, c)).filter((r) => !r.excluded);
    const me = list.find((r) => r.id === driver.id);
    out.count = me ? me.count : 0;
    out.place = me ? me.place : null;
    out.leaderCount = list.length ? list[0].count : 0;
    out.participants = list.length;
  }
  return out;
}

module.exports = {
  localToUtc, statusOf, effectiveEnd, board, leaderOf, publicCampaign, listCampaigns, createCampaign,
  getCampaign, stopCampaign, setExcluded, markPaid, driverRanking,
};
