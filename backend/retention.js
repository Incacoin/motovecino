const db = require("./db");

// El Aviso de Privacidad (frontend/aviso-privacidad.html, sección 6) promete
// que el detalle de los viajes no se guarda más de 1 año. Este barrido es lo
// que cumple esa promesa: si se cambia el plazo aquí, hay que cambiarlo allá.
const RETENTION_DAYS = 365;

// Una vez al día basta — el plazo se mide en días, no en minutos.
const PURGE_INTERVAL_MS = 24 * 60 * 60 * 1000;

// No se borra el viaje en sí: fecha, tarifa, chofer, estado y el conteo de
// viajes del pasajero (insignia VIP) siguen sirviendo para cobros y
// contabilidad. Lo que se quita es lo que dice DÓNDE estuvo la persona:
// las referencias escritas se borran y las coordenadas se redondean a 2
// decimales (~1 km), que ya no señala una casa pero sí deja ver en qué zona
// del pueblo hubo viajes. pickup_lat/lng son NOT NULL, por eso se redondean
// en vez de dejarlos en NULL. share_token se borra para que la liga pública
// de seguimiento de ese viaje deje de funcionar.
function purgeOldPersonalData() {
  try {
    const rides = db
      .prepare(
        `UPDATE rides
         SET pickup_label = NULL,
             dest_label = NULL,
             pickup_lat = ROUND(pickup_lat, 2),
             pickup_lng = ROUND(pickup_lng, 2),
             dest_lat = ROUND(dest_lat, 2),
             dest_lng = ROUND(dest_lng, 2),
             share_token = NULL
         WHERE julianday('now') - julianday(created_at) > ?
           AND (pickup_label IS NOT NULL OR dest_label IS NOT NULL OR share_token IS NOT NULL
                OR pickup_lat != ROUND(pickup_lat, 2) OR pickup_lng != ROUND(pickup_lng, 2)
                OR dest_lat != ROUND(dest_lat, 2) OR dest_lng != ROUND(dest_lng, 2))`
      )
      .run(RETENTION_DAYS);

    const activity = db
      .prepare("DELETE FROM driver_activity_log WHERE julianday('now') - julianday(connected_at) > ?")
      .run(RETENTION_DAYS);

    if (rides.changes || activity.changes) {
      console.log(`[retention] ${rides.changes} viajes anonimizados, ${activity.changes} registros de conexión borrados`);
    }
    return { rides: rides.changes, activity: activity.changes };
  } catch (err) {
    // Igual que sweepStaleRides: un error aquí no debe tumbar el servidor.
    console.error("[retention] error:", err);
    return null;
  }
}

function startRetentionSchedule() {
  purgeOldPersonalData();
  setInterval(purgeOldPersonalData, PURGE_INTERVAL_MS);
}

module.exports = { startRetentionSchedule, purgeOldPersonalData, RETENTION_DAYS };
