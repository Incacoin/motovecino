// Color del vehículo del chofer (18-nov-2026). En Ticul cada chofer elige el
// color de su mototaxi, así que al pasajero le ayuda a reconocerla en la calle
// ("Mototaxi · Rojo"). Lista fija (no texto libre) para que el padrón no salga
// revuelto. Se guarda el `nombre` en drivers.vehicle_color.
const COLORES_VEHICULO = [
  { nombre: "Rojo", hex: "#dc2626" },
  { nombre: "Guinda", hex: "#7f1d1d" },
  { nombre: "Naranja", hex: "#f97316" },
  { nombre: "Amarillo", hex: "#facc15" },
  { nombre: "Verde", hex: "#16a34a" },
  { nombre: "Azul", hex: "#2563eb" },
  { nombre: "Morado", hex: "#7c3aed" },
  { nombre: "Rosa", hex: "#ec4899" },
  { nombre: "Blanco", hex: "#ffffff" },
  { nombre: "Gris", hex: "#9ca3af" },
  { nombre: "Negro", hex: "#111111" },
  { nombre: "Otro", hex: null },
];

// El nombre a guardar si es un color de la lista; null si no.
function colorValido(valor) {
  if (typeof valor !== "string") return null;
  const c = COLORES_VEHICULO.find((x) => x.nombre === valor.trim());
  return c ? c.nombre : null;
}

// Lo que ve el pasajero: "Otro" no le dice nada, así que no se manda.
function colorParaPasajero(nombre) {
  const c = COLORES_VEHICULO.find((x) => x.nombre === nombre);
  return c && c.hex ? { vehicle_color: c.nombre, vehicle_color_hex: c.hex } : { vehicle_color: null, vehicle_color_hex: null };
}

module.exports = { COLORES_VEHICULO, colorValido, colorParaPasajero };
