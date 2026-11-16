// "Conoce tu municipio" (16-nov-2026): la regla de qué vehículo usar cuando el
// pasajero elige un lugar con "Llévame aquí". Vive aparte para que la prueba
// (backend/tools/test-turismo.js) revise la misma regla que usa pasajero.html.
(function (root) {
  function km(a, b) {
    const R = 6371;
    const dLat = ((b.lat - a.lat) * Math.PI) / 180;
    const dLng = ((b.lng - a.lng) * Math.PI) / 180;
    const h = Math.sin(dLat / 2) ** 2 + Math.cos((a.lat * Math.PI) / 180) * Math.cos((b.lat * Math.PI) / 180) * Math.sin(dLng / 2) ** 2;
    return R * 2 * Math.atan2(Math.sqrt(h), Math.sqrt(1 - h));
  }

  // from: dónde pasan por él (o dónde está, si aún no marca partida).
  // Regresa "taxi" (cambiar a taxi), "moto" (regresar a mototaxi porque el taxi
  // lo puso esta sección y ya no hace falta) o null (no tocar lo que eligió).
  // Solo regresa a mototaxi si la recogida está en la zona del mototaxi.
  function vehicleFor(o) {
    if (!o.from || !o.to) return null;
    const far = km(o.from, o.to) > (o.motoKm || 6);
    if (far) return o.serviceType === "taxi" ? null : "taxi";
    if (o.tourForcedTaxi && o.serviceType === "taxi" && o.serviceZone === "in") return "moto";
    return null;
  }

  const api = { km, vehicleFor };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.MVTurismo = api;
})(this);
