const { haversineKm } = require("./geo");

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
  { id: "ticul", label: "Ticul", lat: 20.39528, lng: -89.53389 },
  // TEMPORAL (3-oct-2026): Mérida solo como zona de prueba para enseñar la
  // app en una reunión. Radio 12km = igual a CITY_RADIUS_KM, para que la
  // recogida sí se etiquete "merida" (si no, cae en Tekax y se bloquea).
  // testOnly: no abre el registro de choferes aquí. Quitar esta línea al terminar.
  // labelRadiusKm: radio propio para la etiqueta (si no, CITY_RADIUS_KM).
  // 22km: llega hasta la salida a Progreso.
  { id: "merida", label: "Mérida", lat: 20.9674, lng: -89.5926, serviceRadiusKm: 22, labelRadiusKm: 22, testOnly: true },
  // TEMPORAL (3-oct-2026): costa de Progreso de prueba — Chuburná, Chelem,
  // Progreso, Flamboyanes, Chicxulub. Quitar junto con Mérida.
  { id: "progreso", label: "Progreso", lat: 21.27, lng: -89.71, serviceRadiusKm: 14, labelRadiusKm: 14, testOnly: true },
];

const DEFAULT_CITY_ID = "tekax";

// Si nadie está a menos de esto de ningún centro conocido, no forzamos una
// ciudad — mejor mostrar la de casa (perfil) que adivinar mal.
const CITY_RADIUS_KM = 12;

function resolveCity(lat, lng) {
  if (lat == null || lng == null) return null;
  let closest = null;
  let closestDist = Infinity;
  for (const city of CITIES) {
    const d = haversineKm(lat, lng, city.lat, city.lng);
    if (d > (city.labelRadiusKm ?? CITY_RADIUS_KM)) continue;
    if (d < closestDist) {
      closestDist = d;
      closest = city;
    }
  }
  if (!closest) return null;
  return closest;
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
};
