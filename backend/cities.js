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
  { id: "tekax", label: "Tekax", lat: 20.2071, lng: -89.2809, serviceRadiusKm: 4.5 },
  { id: "ticul", label: "Ticul", lat: 20.39528, lng: -89.53389 },
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
    if (d < closestDist) {
      closestDist = d;
      closest = city;
    }
  }
  if (!closest || closestDist > CITY_RADIUS_KM) return null;
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
function isWithinServiceRadius(cityId, lat, lng) {
  const city = getCityById(cityId);
  if (!city || city.serviceRadiusKm == null) return true;
  if (lat == null || lng == null) return true;
  return haversineKm(lat, lng, city.lat, city.lng) <= city.serviceRadiusKm;
}

module.exports = {
  CITIES,
  DEFAULT_CITY_ID,
  CITY_RADIUS_KM,
  resolveCity,
  getCityById,
  isWithinServiceRadius,
};
