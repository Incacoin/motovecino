// Teléfonos de pasajeros con país. México se guarda como siempre (10 dígitos,
// sin "+52") para no tocar las cuentas que ya existen; cualquier otro país se
// guarda con su código ("+51987654321") para que nunca se confunda con uno
// mexicano. El frontend manda el teléfono ya armado en ese mismo formato.
const COUNTRIES = [
  { code: "MX", dial: "52", digits: 10, name: "México" },
  { code: "PE", dial: "51", digits: 9, name: "Perú" },
  { code: "US", dial: "1", digits: 10, name: "Estados Unidos y Canadá" }, // mismo +1
];

// Regresa { phone, e164, country } o null si no es válido.
function parseRiderPhone(raw) {
  if (typeof raw !== "string") return null;
  const value = raw.trim();
  if (/^\d{10}$/.test(value)) {
    return { phone: value, e164: "+52" + value, country: "MX" };
  }
  const m = /^\+(\d+)$/.exec(value);
  if (!m) return null;
  for (const c of COUNTRIES) {
    if (c.code === "MX") continue; // México va sin "+52" (ver arriba)
    if (m[1].startsWith(c.dial) && m[1].length === c.dial.length + c.digits) {
      return { phone: value, e164: value, country: c.code };
    }
  }
  return null;
}

module.exports = { COUNTRIES, parseRiderPhone };
