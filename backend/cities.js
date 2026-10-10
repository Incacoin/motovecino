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
  { id: "ticul", label: "Ticul", lat: 20.39528, lng: -89.53389, serviceRadiusKm: 6, labelRadiusKm: 7, signupClosed: true, motoSoon: true, offerOnly: true, minOffer: 15, minOfferNight: 20, minChild: 5, minChildNight: 10 },
  { id: "oxkutzcab", label: "Oxkutzcab", lat: 20.3028, lng: -89.4180, serviceRadiusKm: 7, labelRadiusKm: 7, signupClosed: true, motoSoon: true, offerOnly: true, minOffer: 15, minOfferNight: 20, minChild: 5, minChildNight: 10 },
  // Akil (6-oct-2026): municipio con cajón propio (su selector en el
  // admin). Registro de choferes cerrado por ahora (signupClosed) y el
  // mototaxi "Muy pronto", igual que Oxkutzcab y Ticul.
  // labelRadiusKm = serviceRadiusKm a propósito: fuera de los 4km el punto
  // vuelve a ser de Tekax y sigue teniendo taxi foráneo (radio de 50km).
  { id: "akil", label: "Akil", lat: 20.2656, lng: -89.3475, serviceRadiusKm: 4, labelRadiusKm: 4, signupClosed: true, motoSoon: true, offerOnly: true, minOffer: 15, minOfferNight: 20, minChild: 5, minChildNight: 10 },
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

// Reglas de "Propón tu precio" de un pueblo offerOnly (sin Exprés), para la
// app del pasajero (/api/cities/resolve). null si el pueblo tiene precio fijo.
function cityOfferRules(city) {
  if (!city || !city.offerOnly || city.zones) return null;
  const { minOffer, minOfferNight, minChild, minChildNight } = city;
  return { minOffer, minOfferNight, minChild, minChildNight, serviceFee: SERVICE_FEE };
}

// Lo mínimo que puede ofrecer el pasajero en un pueblo offerOnly (con la
// cuota de la app). El servidor usa siempre la tarifa de DÍA: el celular
// decide si ya es de noche con su propia hora, y no queremos rechazar un
// viaje pedido justo a las 10:00 p.m. por segundos de diferencia.
function cityMinOffer(city, adults, kids) {
  if (!city || !city.offerOnly || city.zones) return 0;
  return city.minOffer * Math.max(1, adults || 1) + (city.minChild || 0) * Math.max(0, kids || 0) + SERVICE_FEE;
}

module.exports = {
  CITIES,
  cityOfferRules,
  cityMinOffer,
  DEFAULT_CITY_ID,
  CITY_RADIUS_KM,
  resolveCity,
  getCityById,
  isWithinServiceRadius,
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
