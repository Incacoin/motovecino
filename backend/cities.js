const { haversineKm } = require("./geo");
const { SERVICE_FEE, MOTO_OFFER_MAX_UP } = require("./constants");

// Cada ciudad de la red. lat/lng es el centro aproximado del pueblo, usado
// solo para saber en qué ciudad está alguien según su GPS — el emparejamiento
// de viajes sigue siendo por distancia real (ver MAX_MATCH_DISTANCE_KM), esto
// es nada más para la marca/etiqueta que ve la persona en pantalla.
const CITIES = [
  // serviceRadiusKm: qué tan lejos del centro dejamos pedir viaje o darse de
  // alta como chofer — a diferencia de CITY_RADIUS_KM (que es solo para la
  // etiqueta que ve la persona), esto sí bloquea. 4.5km cubre Tekax pueblo
  // completo (la entrada-salida por carretera mide 7.2km) con margen para
  // colonias de orilla y el margen de error normal del GPS, sin llegar a
  // Akil (~9-10km, decisión de expansión pendiente y aparte).
  // serviceRadiusKmTaxi: el taxi sí hace viajes foráneos (Peto, Xul, ~50km a
  // la redonda) porque no tiene tarifa fija — el mototaxi se queda con el
  // radio normal de arriba, sin cambios.
  // offerOnly (9-oct-2026): en el sur (Tekax, Ticul, Oxkutzcab, Akil) ya no
  // hay Mototaxi Exprés de precio fijo, solo "Propón tu precio", igual que en
  // Flamboyanes. El precio sugerido ES el mínimo, y es lo que GANA el chofer:
  // minOffer por adulto (de noche minOfferNight) + minChild por niño (de
  // noche minChildNight); el pasajero ve eso + la cuota de la app ($15 + $2
  // = $17). La distancia la decide el chofer: ve el destino y acepta o pide
  // hasta MOTO_OFFER_MAX_UP más.
  { id: "tekax", label: "Tekax", lat: 20.2071, lng: -89.2809, serviceRadiusKm: 4.5, serviceRadiusKmTaxi: 50, offerOnly: true, minOffer: 15, minOfferNight: 20, minChild: 5, minChildNight: 10 },
  // Ticul y Oxkutzcab (6-oct-2026): cada uno con su cajón (sus viajes salen
  // en su propio selector del admin), pero signupClosed: todavía no se
  // registran choferes ahí. Ticul además sigue en espera por el gremio
  // (no abrir su registro sin que el usuario lo diga).
  // motoSoon (6-oct-2026): ya llegamos (la portada dice "MotoVecino Akil"),
  // pero sin choferes de ahí: el mototaxi sale como "Muy pronto" y solo se
  // pide taxi. Quitar motoSoon cuando haya mototaxis registrados en el lugar.
  // 13-oct-2026: REGISTRO ABIERTO en Ticul, Oxkutzcab y Akil (sin signupClosed): los choferes
  // se dan de alta en "Quiero ser chofer" y cada solicitud cae en el cajón de su municipio.
  // 11-oct-2026: PRUEBA TEMPORAL — mototaxi prendido en Ticul, Oxkutzcab y Akil (sin motoSoon)
  // para probar con choferes dados de alta en el admin. Para apagar: volver a poner motoSoon: true.
  // 14-oct-2026: Ticul vuelve a su tarifa por distancia (la acordada con el
  // gremio): viaje corto (hasta shortTripKm en línea recta) mínimo
  // minOfferShort de día; más largo, minOffer y el chofer pide más si quiere.
  // De noche, minOfferNight sin importar la distancia.
  // 25-nov-2026 (hoja oficial de la Dirección de Transporte de Ticul): de noche
  // el viaje corto tiene su propio mínimo (minOfferShortNight $15; el largo
  // sigue en minOfferNight $20). Mototaxi: máximo 3 adultos y 1 niño
  // (maxAdults / maxChildren; sin estos campos, 4 personas como sea).
  // De punta a punta (25-nov-2026, acordado con el líder de Alcones Alfa):
  // viaje de longTripKm (2.5 km en línea recta) o más, mínimo minOfferLong
  // ($25) de día y minOfferLongNight ($30) de noche. Ticul mide ~2.9 x 3.8 km.
  // 15-nov-2026 (hecho el 28-oct, subido hasta hoy): taxis de Ticul recogen en sus
  // comisarías (Pustunich, Yotholín…). labelRadiusKm 12 (antes 7): hasta 12 km el
  // viaje es del cajón de Ticul y no de Tekax. El alcance REAL es 12 km: más lejos el
  // punto ya no es Ticul y queda como antes (red de taxis de Tekax). serviceRadiusKmTaxi
  // queda en 20 solo por si un día sube labelRadiusKm; no pasar de 12 sin revisar,
  // porque más allá están otros municipios (Sacalum, Santa Elena, Chapab, Muna).
  // El mototaxi sigue en 6 km. Prueba: tools/test-comisarias.js.
  { id: "ticul", label: "Ticul", lat: 20.39528, lng: -89.53389, serviceRadiusKm: 6, serviceRadiusKmTaxi: 20, labelRadiusKm: 12, offerOnly: true, minOffer: 15, minOfferShort: 10, shortTripKm: 0.5, minOfferNight: 20, minOfferShortNight: 15, longTripKm: 2.5, minOfferLong: 25, minOfferLongNight: 30, minChild: 5, minChildNight: 10, maxAdults: 3, maxChildren: 1 },
  { id: "oxkutzcab", label: "Oxkutzcab", lat: 20.3028, lng: -89.4180, serviceRadiusKm: 7, labelRadiusKm: 7, offerOnly: true, minOffer: 15, minOfferNight: 20, minChild: 5, minChildNight: 10 },
  // Akil (6-oct-2026): municipio con cajón propio (su selector en el
  // admin). Registro de choferes cerrado por ahora (signupClosed) y el
  // mototaxi "Muy pronto", igual que Oxkutzcab y Ticul.
  // labelRadiusKm = serviceRadiusKm a propósito: fuera de los 4km el punto
  // vuelve a ser de Tekax y sigue teniendo taxi foráneo (radio de 50km).
  { id: "akil", label: "Akil", lat: 20.2656, lng: -89.3475, serviceRadiusKm: 4, labelRadiusKm: 4, offerOnly: true, minOffer: 15, minOfferNight: 20, minChild: 5, minChildNight: 10 },
  // Celestún (9-oct-2026): PRUEBA de unos días mientras el usuario está allá
  // (viaja 10-oct). Cajón propio (su selector en el admin); el registro
  // público queda cerrado (signupClosed): los mototaxistas que quieran
  // probar los da de alta el dueño desde el admin, eligiendo "Celestún".
  // Solo Propón tu precio con el mínimo del sur ($15 + $2) PROVISIONAL hasta
  // saber cuánto se cobra allá. 3.5 km cubre el pueblo, la playa y el
  // puente de la ría. Para apagarla: borrar esta línea y la de ADMIN_ZONES.
  { id: "celestun", label: "Celestún", lat: 20.8590, lng: -90.4000, serviceRadiusKm: 3.5, signupClosed: true, offerOnly: true, minOffer: 15, minOfferNight: 20, minChild: 5, minChildNight: 10 },
  // TEMPORAL (3-oct-2026): Mérida solo como zona de prueba para enseñar la
  // app en una reunión. Radio 12km = igual a CITY_RADIUS_KM, para que la
  // recogida sí se etiquete "merida" (si no, cae en Tekax y se bloquea).
  // testOnly: no abre el registro de choferes aquí. Quitar esta línea al terminar.
  // labelRadiusKm: radio propio para la etiqueta (si no, CITY_RADIUS_KM).
  // 22km: llega hasta la salida a Progreso.
  // APAGADO (5-oct-2026): para volver a prender Mérida y Progreso, quitar
  // los // de las dos líneas de abajo.
  // { id: "merida", label: "Mérida", lat: 20.9674, lng: -89.5926, serviceRadiusKm: 22, labelRadiusKm: 22, testOnly: true },
  // TEMPORAL (3-oct-2026): costa de Progreso de prueba — Chuburná, Chelem,
  // Progreso, Flamboyanes, Chicxulub. Quitar junto con Mérida.
  // { id: "progreso", label: "Progreso", lat: 21.27, lng: -89.71, serviceRadiusKm: 14, labelRadiusKm: 14, testOnly: true },
];

// Zona de Progreso (socio operador: Daniel). Solo motocarros, y cada uno se
// mueve SOLO dentro de su comisaría: el viaje empieza y termina en la misma, y
// solo le llegan choferes que están en ella. Progreso centro NO tiene viajes
// (ahí es solo publicidad). Todo el panel de Daniel es la ciudad "progreso".
// Dos opciones para el pasajero: Moto Exprés (precio fijo de abajo) y Propón
// tu precio (ofertas; el chofer puede pedir hasta OFFER_MAX_UP más). Una zona
// con offerOnly solo tiene Propón tu precio (así abrimos sin investigar tarifas).
// TARIFAS PROVISIONALES (5-oct-2026): Flamboyanes $7 la dijo el usuario; las
// otras $10 a falta de confirmar con Daniel. Cambiarlas AQUÍ: es el único
// lugar (las apps las leen de /api/cities/resolve).
// Círculos sacados de OpenStreetMap (centro de cada comisaría): confirmar con
// Daniel que cubren su zona de trabajo.
const PROGRESO = {
  id: "progreso",
  label: "Progreso",
  rideStyle: "comisarias",
  // La misma cuota de la app que en Tekax (la cobran también el admin y
  // fees.js con SERVICE_FEE): no cambiarla solo aquí.
  serviceFee: SERVICE_FEE,
  zones: [
    // open (7-oct-2026): se prende comisaría por comisaría. Empezamos por
    // Flamboyanes; en las cerradas la app dice "MotoVecino Chelem" pero el
    // motocarro sale "Muy pronto" y no se registran choferes por QR.
    // 8-oct-2026 (Daniel): Flamboyanes + El Paraíso + Rincón Paraíso son UNA
    // zona (se conectan por la 261). Centro entre los tres, 3.5 km: cubre las
    // orillas de Flamboyanes (~2.8 km) y Rincón Paraíso (~2.8 km); deja fuera
    // San Ignacio (~4.5 km) y Progreso centro (~9 km). El id se queda
    // "flamboyanes" porque ya está guardado en drivers.zone.
    // offerOnly: solo "Propón tu precio" (sin Moto Exprés); minOffer = lo
    // mínimo que GANA el chofer POR PERSONA (el pasajero ve $8 + $2 = $10).
    // fare queda para los viajes viejos de precio fijo (earnings.js).
    { id: "flamboyanes", label: "Flamboyanes y Paraíso", lat: 21.1990, lng: -89.6470, radiusKm: 3.5, fare: 8, minOffer: 8, offerOnly: true, open: true },
    { id: "chicxulub", label: "Chicxulub", lat: 21.2933, lng: -89.6068, radiusKm: 2.5, fare: 10, open: false },
    { id: "chelem", label: "Chelem", lat: 21.2687, lng: -89.7423, radiusKm: 2.5, fare: 10, open: false },
    { id: "chuburna", label: "Chuburná", lat: 21.2524, lng: -89.8158, radiusKm: 2, fare: 10, open: false },
  ],
};
// Zonas que puede ver el dueño en su admin (selector arriba): Tekax y las
// que tengan socio operador. Progreso aparece aunque esté apagada, para
// poder ver su panel antes de abrirla.
const ADMIN_ZONES = [
  { id: "tekax", label: "Tekax", enabled: true },
  { id: PROGRESO.id, label: PROGRESO.label, enabled: process.env.ENABLE_PROGRESO === "1" },
  { id: "akil", label: "Akil", enabled: true },
  { id: "oxkutzcab", label: "Oxkutzcab", enabled: true },
  { id: "ticul", label: "Ticul", enabled: true },
  { id: "celestun", label: "Celestún", enabled: true },
];

// Cuánto más puede pedir un chofer sobre la oferta del pasajero.
const OFFER_MAX_UP = MOTO_OFFER_MAX_UP;

// Apagada hasta que se abra de verdad (con choferes de Daniel registrados):
// ENABLE_PROGRESO=1 en Render la prende. Apagada, la app se porta igual que
// antes de existir esto.
if (process.env.ENABLE_PROGRESO === "1") {
  const z0 = PROGRESO.zones[0];
  CITIES.push({ ...PROGRESO, lat: z0.lat, lng: z0.lng });
}

const DEFAULT_CITY_ID = "tekax";

// Si nadie está a menos de esto de ningún centro conocido, no forzamos una
// ciudad — mejor mostrar la de casa (perfil) que adivinar mal.
const CITY_RADIUS_KM = 12;

// Comisaría (zona) de una ciudad con zonas en la que cae el punto, o null.
function zoneAt(cityId, lat, lng) {
  const city = getCityById(cityId);
  if (!city || !city.zones || lat == null || lng == null) return null;
  return city.zones.find((z) => haversineKm(lat, lng, z.lat, z.lng) <= z.radiusKm) || null;
}

// Como zoneAt, pero solo si esa comisaría ya está abierta (open).
function openZoneAt(cityId, lat, lng) {
  const z = zoneAt(cityId, lat, lng);
  return z && z.open !== false ? z : null;
}

// ¿Es una comisaría válida de esta ciudad? (para el alta de choferes)
function zoneById(cityId, zoneId) {
  const city = getCityById(cityId) || (cityId === PROGRESO.id ? PROGRESO : null);
  return (city && city.zones && city.zones.find((z) => z.id === zoneId)) || null;
}

// Distancia a la ciudad: a su centro, o a la comisaría más cercana si tiene
// zonas (sin zona propia, una ciudad con zonas no "atrapa" puntos de afuera).
function distanceToCity(city, lat, lng) {
  if (!city.zones) return haversineKm(lat, lng, city.lat, city.lng);
  const z = city.zones.find((zz) => haversineKm(lat, lng, zz.lat, zz.lng) <= zz.radiusKm);
  return z ? 0 : Infinity;
}

function resolveCity(lat, lng) {
  if (lat == null || lng == null) return null;
  let closest = null;
  let closestDist = Infinity;
  for (const city of CITIES) {
    const d = distanceToCity(city, lat, lng);
    if (d > (city.labelRadiusKm ?? CITY_RADIUS_KM)) continue;
    if (d < closestDist) {
      closestDist = d;
      closest = city;
    }
  }
  if (!closest) return null;
  return closest;
}

// ¿El chofer puede recibir un viaje que recoge en (pLat, pLng)?
// Solo cuenta en ciudades por comisarías. Si el chofer tiene comisaría fija
// (driverZone, la de su alta) manda esa, esté donde esté: un motocarro de
// Chelem no levanta en Flamboyanes. Sin comisaría fija (choferes de antes),
// la de donde está parado. En las demás ciudades siempre sí.
function sameComisaria(cityId, pLat, pLng, dLat, dLng, driverZone) {
  const city = getCityById(cityId);
  if (!city || !city.zones) return true;
  const a = zoneAt(cityId, pLat, pLng);
  if (driverZone) return !!(a && a.id === driverZone);
  const b = zoneAt(cityId, dLat, dLng);
  return !!(a && b && a.id === b.id);
}

// Cajón (ciudad) al que pertenece un viaje que recoge en este punto. Las
// zonas de prueba (testOnly, ej. Mérida) no tienen choferes ni admin
// propios, así que sus viajes son de la red de Tekax.
function rideCityAt(lat, lng) {
  const city = resolveCity(lat, lng);
  return city && !city.testOnly ? city.id : DEFAULT_CITY_ID;
}

// Mototaxi: cada municipio tiene su sitio y sus reglas, así que un mototaxi
// solo levanta viajes de su propio cajón. El taxi es de toda la región
// (viajes foráneos), así que a él no se le aplica.
function sameCityForRide(rideType, rideCity, driverCity) {
  if (rideType === "taxi") return true;
  return (driverCity || DEFAULT_CITY_ID) === (rideCity || DEFAULT_CITY_ID);
}

function getCityById(id) {
  return CITIES.find((c) => c.id === id) || null;
}

// A diferencia de resolveCity (que solo etiqueta), esto es el bloqueo real:
// si la ciudad tiene un radio de servicio definido y las coordenadas caen
// fuera de él, no se debe dejar pasar. Sin ciudad conocida, sin radio
// configurado (ciudad aún no restringida), o sin coordenadas, no bloquea —
// eso lo sigue decidiendo cada endpoint según sus propios datos requeridos.
// rideType "taxi" usa serviceRadiusKmTaxi si la ciudad lo define (viajes
// foráneos); cualquier otro valor usa el radio normal, sin cambios.
function isWithinServiceRadius(cityId, lat, lng, rideType) {
  const city = getCityById(cityId);
  if (!city) return true;
  if (city.zones) {
    if (lat == null || lng == null) return true;
    return !!openZoneAt(cityId, lat, lng);
  }
  const radius = rideType === "taxi" && city.serviceRadiusKmTaxi != null
    ? city.serviceRadiusKmTaxi
    : city.serviceRadiusKm;
  // Mototaxi "Muy pronto" (motoSoon): no se pide aquí aunque esté en radio.
  // Solo con rideType "moto" explícito — el registro de choferes llama sin
  // rideType y se maneja aparte (testOnly / signupClosed).
  if (rideType === "moto" && city.motoSoon) return false;
  if (radius == null) return true;
  if (lat == null || lng == null) return true;
  return haversineKm(lat, lng, city.lat, city.lng) <= radius;
}

// Hasta dónde llega el mototaxi de un municipio (17-nov-2026): el mismo radio
// en el que recoge (serviceRadiusKm desde el centro). Antes solo se revisaba
// la recogida y se podía pedir mototaxi de Ticul a Uxmal (30 km) por $17.
// null = sin límite (municipio sin radio, o por comisarías: esas ya revisan
// que el viaje termine en la misma comisaría).
// others: los demás municipios (centro y radio de etiqueta) para que la app
// sepa si el destino ya es de otro (Oxkutzcab y Akil se enciman: sus centros
// están a ~8.4 km y el radio de Oxkutzcab es 7).
function motoReach(cityId) {
  const city = getCityById(cityId);
  if (!city || city.zones || city.serviceRadiusKm == null) return null;
  const others = CITIES
    .filter((c) => c.id !== city.id && !c.zones && !c.testOnly)
    .map((c) => ({ lat: c.lat, lng: c.lng, km: c.labelRadiusKm ?? CITY_RADIUS_KM }));
  return { lat: city.lat, lng: city.lng, km: city.serviceRadiusKm, others };
}

// ¿El mototaxi de este municipio puede dejar al pasajero en (lat, lng)?
// Dentro de su radio Y sin que el punto sea de otro municipio (el que
// resolveCity da para ese punto: el centro más cercano).
function motoReachesDest(cityId, lat, lng) {
  const r = motoReach(cityId);
  if (!r || lat == null || lng == null) return true;
  lat = Number(lat);
  lng = Number(lng);
  if (haversineKm(lat, lng, r.lat, r.lng) > r.km) return false;
  const there = resolveCity(lat, lng);
  return !there || there.id === cityId || !!there.testOnly || !!there.zones;
}

// Reglas de "Propón tu precio" de un pueblo offerOnly (sin Exprés), para la
// app del pasajero (/api/cities/resolve). null si el pueblo tiene precio fijo.
function cityOfferRules(city) {
  if (!city || !city.offerOnly || city.zones) return null;
  const { minOffer, minOfferNight, minChild, minChildNight, minOfferShort, shortTripKm, minOfferShortNight, maxAdults, maxChildren, longTripKm, minOfferLong, minOfferLongNight } = city;
  return {
    minOffer, minOfferNight, minChild, minChildNight, serviceFee: SERVICE_FEE,
    ...(minOfferShort ? { minOfferShort, shortTripKm } : {}),
    ...(minOfferShort && minOfferShortNight ? { minOfferShortNight } : {}),
    ...(longTripKm && minOfferLong ? { longTripKm, minOfferLong, minOfferLongNight: minOfferLongNight || Math.max(minOfferLong, minOfferNight || 0) } : {}),
    ...(maxAdults ? { maxAdults } : {}),
    ...(maxChildren != null ? { maxChildren } : {}),
  };
}

// Lo mínimo que puede ofrecer el pasajero en un pueblo offerOnly (con la
// cuota de la app). El servidor usa siempre la tarifa de DÍA: el celular
// decide si ya es de noche con su propia hora, y no queremos rechazar un
// viaje pedido justo a las 10:00 p.m. por segundos de diferencia.
// tripKm (recogida→destino en línea recta): en pueblos con tarifa por
// distancia (Ticul), el viaje corto tiene su propio mínimo.
// opts.noLong: viaje agendado ya aceptado (al llegar su hora o al subirle el
// precio) — se agendó antes del mínimo de punta a punta y se respeta.
function cityMinOffer(city, adults, kids, tripKm, opts = {}) {
  if (!city || !city.offerOnly || city.zones) return 0;
  const short = city.minOfferShort && Number.isFinite(tripKm) && tripKm <= city.shortTripKm;
  const long = !opts.noLong && city.minOfferLong && Number.isFinite(tripKm) && tripKm >= city.longTripKm;
  const adult = short ? city.minOfferShort : long ? city.minOfferLong : city.minOffer;
  return adult * Math.max(1, adults || 1) + (city.minChild || 0) * Math.max(0, kids || 0) + SERVICE_FEE;
}

// Contorno aproximado del estado de Yucatán (lat, lng), para que la app sepa
// si alguien sin municipio cercano está en Yucatán ("MotoVecino Yucatán") o en
// otro estado/país (solo "MotoVecino"). 17-oct-2026. Por el norte se va al
// mar para no tener que dibujar la costa; las rayas con Campeche y Q. Roo son
// a ojo (Halachó/Uxmal/Peto/Chemax/El Cuyo dentro; Calkiní/Hopelchén/JM
// Morelos/Cobá fuera): justo en la raya puede salir el estado vecino.
const YUCATAN_OUTLINE = [
  [22.5, -90.6], [22.5, -87.5], [21.55, -87.53], [21.0, -87.54], [20.85, -87.58],
  [20.55, -87.8], [20.3, -88.4], [19.95, -88.8], [19.55, -89.15], [19.95, -89.55],
  [20.15, -89.65], [20.3, -89.8], [20.42, -90.15], [20.65, -90.35], [20.75, -90.42],
  [20.75, -90.6],
];

function isInYucatan(lat, lng) {
  if (lat == null || lng == null || Number.isNaN(lat) || Number.isNaN(lng)) return null;
  let inside = false;
  for (let i = 0, j = YUCATAN_OUTLINE.length - 1; i < YUCATAN_OUTLINE.length; j = i++) {
    const [yi, xi] = YUCATAN_OUTLINE[i];
    const [yj, xj] = YUCATAN_OUTLINE[j];
    if ((yi > lat) !== (yj > lat) && lng < ((xj - xi) * (lat - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

module.exports = {
  CITIES,
  isInYucatan,
  cityOfferRules,
  cityMinOffer,
  DEFAULT_CITY_ID,
  CITY_RADIUS_KM,
  resolveCity,
  getCityById,
  isWithinServiceRadius,
  motoReach,
  motoReachesDest,
  rideCityAt,
  sameCityForRide,
  zoneAt,
  openZoneAt,
  zoneById,
  PROGRESO_ZONES: PROGRESO.zones.map(({ id, label, open }) => ({ id, label, open: open !== false })),
  sameComisaria,
  OFFER_MAX_UP,
  ADMIN_ZONES,
};
