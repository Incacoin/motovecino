const { haversineKm } = require("./geo");
const { TAXI_COMMISSION_RATE, TAXI_COMMISSION_CAP } = require("./constants");

// Yucatán está fijo en UTC-6 (México quitó el horario de verano en 2022).
// SQLite guarda datetime('now') en UTC: sin este ajuste "hoy" se reiniciaba a
// las 6 pm y un viaje de noche contaba como del día siguiente.
const LOCAL_OFFSET = "-6 hours";
// Para usar en SQL: fecha local de cuándo se completó el viaje. Los viajes de
// antes de guardar completed_at caen a updated_at.
const LOCAL_DONE_DATE = `date(COALESCE(completed_at, updated_at), '${LOCAL_OFFSET}')`;
const LOCAL_TODAY = `date('now', '${LOCAL_OFFSET}')`;

// Tarifas de mototaxi — las MISMAS que estimateFare() en chofer.html y
// pasajero.html. Si cambias una tarifa allá, cámbiala aquí también, o
// "Mis ganancias" no va a cuadrar con lo que el chofer vio al aceptar.
const MOTO_FARES = {
  tekax: { shortKm: null, short: null, thresholdKm: 2.5, normal: 15, far: 20, night: 20, childDay: 5, childNight: 10 },
  ticul: { shortKm: 0.5, short: 10, thresholdKm: 1.5, normal: 15, far: null, night: 20, childDay: 5, childNight: 10 },
};

// Noche = 10 pm a 6 am hora de Yucatán, tomada de cuándo se PIDIÓ el viaje
// (que es cuando el pasajero y el chofer vieron el precio).
function isNightAt(createdAtUtc) {
  const d = new Date(String(createdAtUtc).replace(" ", "T") + "Z");
  if (isNaN(d)) return false;
  const h = (d.getUTCHours() + 24 - 6) % 24;
  return h >= 22 || h < 6;
}

// Lo que le queda al chofer de un viaje completado, o null si la app no sabe
// el precio (ej. viaje largo en Ticul que se acordó por fuera).
// - Mototaxi: tarifa × pasajeros + niños + extra. Los $2 de servicio los pone
//   el pasajero aparte, no salen de aquí.
// - Taxi: lo que el chofer reportó al completar (ya trae la espera sumada)
//   menos la comisión.
function driverEarnings(ride) {
  if (ride.ride_type === "taxi") {
    const price = Number(ride.agreed_price);
    if (!(price > 0)) return null;
    const commission = Math.min(price * TAXI_COMMISSION_RATE, TAXI_COMMISSION_CAP);
    return Math.round((price - commission) * 100) / 100;
  }
  const f = MOTO_FARES[ride.city] || MOTO_FARES.tekax;
  const night = isNightAt(ride.created_at);
  let perPerson = night ? f.night : f.normal;
  if (ride.dest_lat != null && ride.dest_lng != null) {
    const km = haversineKm(ride.pickup_lat, ride.pickup_lng, ride.dest_lat, ride.dest_lng);
    if (f.far == null && km > f.thresholdKm) return null;
    if (!night) {
      if (f.far != null && km > f.thresholdKm) perPerson = f.far;
      else if (f.shortKm != null && km <= f.shortKm) perPerson = f.short;
    }
  }
  const passengers = ride.passengers || 1;
  const children = ride.children || 0;
  return perPerson * passengers + (night ? f.childNight : f.childDay) * children + (ride.extra || 0);
}

// Resumen para "Mis ganancias": hoy, semana (lunes a domingo) y mes, más los
// últimos viajes. Solo cuenta viajes con ganancia guardada — los de antes de
// esta función no tienen, y mezclarlos daría números incompletos.
async function earningsSummary(db, driverId) {
  const sums = await db
    .prepare(
      `SELECT
         COALESCE(SUM(CASE WHEN ${LOCAL_DONE_DATE} = ${LOCAL_TODAY} THEN driver_earnings END), 0) AS todayTotal,
         SUM(CASE WHEN ${LOCAL_DONE_DATE} = ${LOCAL_TODAY} THEN 1 ELSE 0 END) AS todayTrips,
         COALESCE(SUM(CASE WHEN ${LOCAL_DONE_DATE} >= date('now', '${LOCAL_OFFSET}', 'weekday 0', '-6 days') THEN driver_earnings END), 0) AS weekTotal,
         SUM(CASE WHEN ${LOCAL_DONE_DATE} >= date('now', '${LOCAL_OFFSET}', 'weekday 0', '-6 days') THEN 1 ELSE 0 END) AS weekTrips,
         COALESCE(SUM(CASE WHEN ${LOCAL_DONE_DATE} >= date('now', '${LOCAL_OFFSET}', 'start of month') THEN driver_earnings END), 0) AS monthTotal,
         SUM(CASE WHEN ${LOCAL_DONE_DATE} >= date('now', '${LOCAL_OFFSET}', 'start of month') THEN 1 ELSE 0 END) AS monthTrips,
         COUNT(*) AS allTrips
       FROM rides WHERE driver_id = ? AND status = 'completado' AND driver_earnings IS NOT NULL`
    )
    .get(driverId);
  const recent = await db
    .prepare(
      `SELECT completed_at AS completedAt, ride_type AS rideType, driver_earnings AS earnings, dest_label AS destLabel
       FROM rides WHERE driver_id = ? AND status = 'completado' AND driver_earnings IS NOT NULL
       ORDER BY completed_at DESC, id DESC LIMIT 10`
    )
    .all(driverId);
  return {
    today: { total: sums.todayTotal, trips: sums.todayTrips || 0 },
    week: { total: sums.weekTotal, trips: sums.weekTrips || 0 },
    month: { total: sums.monthTotal, trips: sums.monthTrips || 0 },
    allTrips: sums.allTrips || 0,
    recent,
  };
}

module.exports = { driverEarnings, earningsSummary, LOCAL_DONE_DATE, LOCAL_TODAY, LOCAL_OFFSET };
