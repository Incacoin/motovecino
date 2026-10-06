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
  { id: "tekax", label: "Tekax", lat: 20.2071, lng: -89.2809, serviceRadiusKm: 4.5, serviceRadiusKmTaxi: 50 },
  // TEMPORAL (5-oct-2026): Ticul y Oxkutzcab como zonas de prueba para
  // enseñar la app. Al terminar: Ticul regresa a su línea original
  // `{ id: "ticul", label: "Ticul", lat: 20.39528, lng: -89.53389 },` y se
  // borra la de Oxkutzcab.
  { id: "ticul", label: "Ticul", lat: 20.39528, lng: -89.53389, serviceRadiusKm: 6, labelRadiusKm: 7, testOnly: true },
  { id: "oxkutzcab", label: "Oxkutzcab", lat: 20.3028, lng: -89.4180, serviceRadiusKm: 7, labelRadiusKm: 7, testOnly: true },
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
// tu precio (ofertas; el chofer puede pedir hasta OFFER_MAX_UP más).
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
    { id: "flamboyanes", label: "Flamboyanes", lat: 21.2102, lng: -89.6605, radiusKm: 1.5, fare: 7 },
    { id: "chicxulub", label: "Chicxulub", lat: 21.2933, lng: -89.6068, radiusKm: 2.5, fare: 10 },
    { id: "chelem", label: "Chelem", lat: 21.2687, lng: -89.7423, radiusKm: 2.5, fare: 10 },
    { id: "chuburna", label: "Chuburná", lat: 21.2524, lng: -89.8158, radiusKm: 2, fare: 10 },
  ],
};
// Zonas que puede ver el dueño en su admin (selector arriba): Tekax y las
// que tengan socio operador. Progreso aparece aunque esté apagada, para
// poder ver su panel antes de abrirla.
const ADMIN_ZONES = [
  { id: "tekax", label: "Tekax", enabled: true },
  { id: PROGRESO.id, label: PROGRESO.label, enabled: process.env.ENABLE_PROGRESO === "1" },
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

// ¿El chofer (dLat, dLng) puede recibir un viaje que recoge en (pLat, pLng)?
// Solo cuenta en ciudades por comisarías: los dos en la misma. En las demás
// siempre sí (ahí manda la distancia, como siempre).
function sameComisaria(cityId, pLat, pLng, dLat, dLng) {
  const city = getCityById(cityId);
  if (!city || !city.zones) return true;
  const a = zoneAt(cityId, pLat, pLng);
  const b = zoneAt(cityId, dLat, dLng);
  return !!(a && b && a.id === b.id);
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
    return !!zoneAt(cityId, lat, lng);
  }
  const radius = rideType === "taxi" && city.serviceRadiusKmTaxi != null
    ? city.serviceRadiusKmTaxi
    : city.serviceRadiusKm;
  if (radius == null) return true;
  if (lat == null || lng == null) return true;
  return haversineKm(lat, lng, city.lat, city.lng) <= radius;
}

module.exports = {
  CITIES,
  DEFAULT_CITY_ID,
  CITY_RADIUS_KM,
  resolveCity,
  getCityById,
  isWithinServiceRadius,
  zoneAt,
  sameComisaria,
  OFFER_MAX_UP,
  ADMIN_ZONES,
};
