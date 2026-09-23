const { haversineKm } = require("./geo");
const { getCityById } = require("./cities");

// Precio SUGERIDO para un viaje de taxi (estilo inDrive): es el punto de
// partida que ve el pasajero, no un precio fijo — él lo puede subir o bajar,
// y el chofer lo acepta o manda una contraoferta.
//
// 1) Tabla por destino: lo que de verdad cobran hoy los taxistas de Tekax
//    (dato del dueño, 2026-09-23). Los precios no siguen solo los km — Xul
//    sale caro para su distancia (camino malo, regreso vacío) y Oxkutzcab
//    barato (ruta grande) — por eso los pueblos conocidos van por tabla.
// 2) Fórmula para cualquier otro lugar: mínimo hasta 10 km + $/km extra.
//
// Para actualizar precios: cambiar esta tabla / estas constantes.
const TAXI_FARE_TABLE = [
  { name: "Kancab", lat: 20.1957, lng: -89.3454, price: 150 },
  { name: "Akil", lat: 20.2601, lng: -89.3437, price: 150 },
  { name: "Xul", lat: 20.1007, lng: -89.4628, price: 450 },
  { name: "Oxkutzcab", lat: 20.1394, lng: -89.5505, price: 300 },
  { name: "Peto", lat: 20.0517, lng: -88.8287, price: 600 },
];
// Qué tan cerca del centro de ese pueblo cuenta como "ir a ese pueblo".
const TABLE_MATCH_KM = 2.5;

const FORMULA_MIN_PRICE = 150; // cubre hasta FORMULA_MIN_KM
const FORMULA_MIN_KM = 10;
const FORMULA_PER_KM = 8;
// Distancia en línea recta × esto ≈ distancia real por carretera (medido con
// las rutas reales de Kancab/Akil/Xul: 1.2-1.3).
const ROAD_FACTOR = 1.3;

// Los precios de la tabla son desde/hacia el pueblo base (Tekax).
const HOME_CITY_ID = "tekax";

function roundTo10(n) {
  return Math.max(10, Math.round(n / 10) * 10);
}

function nearestTablePlace(lat, lng) {
  let best = null;
  for (const place of TAXI_FARE_TABLE) {
    const d = haversineKm(lat, lng, place.lat, place.lng);
    if (d <= TABLE_MATCH_KM && (!best || d < best.d)) best = { place, d };
  }
  return best ? best.place : null;
}

function inHomeTown(lat, lng) {
  const city = getCityById(HOME_CITY_ID);
  return !!city && haversineKm(lat, lng, city.lat, city.lng) <= (city.serviceRadiusKm || 4.5);
}

// -> { price, km, source: "tabla" | "formula", place }
function suggestTaxiFare(pickupLat, pickupLng, destLat, destLng) {
  const km = haversineKm(pickupLat, pickupLng, destLat, destLng) * ROAD_FACTOR;

  // Tekax -> pueblo de la tabla, o de regreso (pueblo -> Tekax): mismo precio.
  const destPlace = nearestTablePlace(destLat, destLng);
  if (destPlace && inHomeTown(pickupLat, pickupLng)) {
    return { price: destPlace.price, km: Math.round(km * 10) / 10, source: "tabla", place: destPlace.name };
  }
  const pickupPlace = nearestTablePlace(pickupLat, pickupLng);
  if (pickupPlace && inHomeTown(destLat, destLng)) {
    return { price: pickupPlace.price, km: Math.round(km * 10) / 10, source: "tabla", place: pickupPlace.name };
  }

  const price = km <= FORMULA_MIN_KM
    ? FORMULA_MIN_PRICE
    : FORMULA_MIN_PRICE + (km - FORMULA_MIN_KM) * FORMULA_PER_KM;
  return { price: roundTo10(price), km: Math.round(km * 10) / 10, source: "formula", place: null };
}

module.exports = { suggestTaxiFare, TAXI_FARE_TABLE };
