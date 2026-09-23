module.exports = {
  // Sube esta fecha cada vez que cambie el TEXTO del aviso legal o el
  // contrato (no por cambios de marca/cosméticos) — es lo que queda grabado
  // como "versión que aceptó" cada chofer al registrarse.
  AVISO_LEGAL_VERSION: "2026-09-23",
  LAUNCH_DATE: "2026-08-14",
  // Cuota mensual descontinuada 2026-09-08: ya no se cobra, solo queda el
  // cobro por viaje (SERVICE_FEE). En 0 para que las pantallas de chofer y
  // admin dejen de mostrar/pedir mensualidad — mismo patrón que ya se usaba
  // para desactivar SERVICE_FEE en un pueblo que todavía no cobra por viaje.
  MONTHLY_FEE: 0,
  // Cuota de la app por viaje, la misma en todos los pueblos: es el cobro de
  // la plataforma, no la tarifa del gremio (esa sí cambia de pueblo a pueblo).
  SERVICE_FEE: 2,
  // Desde cuándo aplica esa cuota en Tekax. Los viajes anteriores a esta
  // fecha se marcan como ya liquidados: no se le puede cobrar a un chofer
  // por viajes que hizo cuando la cuota todavía no existía aquí.
  SERVICE_FEE_START_DATE: "2026-08-27",
  // Los viajes de taxi no tienen tarifa fija (se negocian directo con el
  // pasajero), así que en vez de SERVICE_FEE fijo se cobra un % de lo que
  // el chofer reporta al completar el viaje, con tope para que un viaje muy
  // caro no pague una cuota desproporcionada.
  TAXI_COMMISSION_RATE: 0.06,
  TAXI_COMMISSION_CAP: 100,
  // Cobro de espera del taxi (ej. lo hacen esperar en el destino mientras el
  // pasajero hace algo) — $100/hora que ya cobraban por su cuenta, pasado a
  // por minuto. Se le suma al precio acordado antes de calcular la comisión
  // de arriba, no es aparte — el chofer lo activa/detiene desde la app
  // (ver chofer.html) y el total se agrega solo al precio final.
  TAXI_WAIT_RATE_PER_MIN: 2,
  // null = prueba gratis indefinida, sin fecha de corte automática.
  TRIAL_END_DATE: null,
  // Un chofer "disponible" a más de esto de quien está mirando el mapa no es
  // realista que llegue por él, ya sea un pasajero viendo el mapa o un chofer
  // viendo a sus compañeros. Mismo radio que usa el matcheo de viajes nuevos.
  MAX_MATCH_DISTANCE_KM: 8,
  // El taxi sí hace viajes foráneos (a Peto, Xul, etc. — ~50 km a la redonda
  // de Tekax) porque no tiene tarifa fija, cobra comisión sobre lo acordado
  // con el pasajero — un mototaxi no. Este radio más amplio de emparejamiento
  // solo aplica a viajes tipo taxi (ver rides.js/drivers.js/realtime.js);
  // moto se queda con el de arriba, sin cambios.
  MAX_MATCH_DISTANCE_KM_TAXI: 60,
  // Anticipo sugerido para taxi foráneo (recogida fuera del radio normal del
  // pueblo, ej. una comisaría): % del precio acordado que la app le propone
  // al chofer al aceptar. Él lo puede cambiar o quitar — es una sugerencia,
  // no una regla. Cubre la ida en vacío si el pasajero no aparece.
  DEPOSIT_SUGGESTED_RATE: 0.5,
  // Un viaje foráneo de taxi puede tardar más de una hora solo en llegar a
  // recoger (50 km + esperar el anticipo) — con el límite normal de moto se
  // cancelaba solo a medio camino.
  ABANDONED_AFTER_MIN_TAXI: 180,
  // Si un chofer no manda su ubicación en este tiempo probablemente cerró la
  // app o se quedó sin señal — no debería seguir apareciendo como disponible.
  DRIVER_STALE_SECONDS: 90,
  // Cuántos choferes por ciudad reciben la insignia de "fundador" (los
  // primeros en darse de alta, automático, sin depender de viajes).
  FOUNDER_SLOTS: 10,
};
