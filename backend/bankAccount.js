// Validación de la cuenta a donde el pasajero deposita el anticipo del taxi.
// Un dígito mal escrito manda el dinero de un pasajero a quién sabe dónde (o
// el banco lo rechaza y nadie entiende por qué), así que se revisa el dígito
// verificador en vez de solo contar dígitos.

// CLABE: 18 dígitos, el último es verificador (pesos 3-7-1, estándar de Banxico).
function isValidClabe(digits) {
  if (!/^\d{18}$/.test(digits)) return false;
  const weights = [3, 7, 1];
  let sum = 0;
  for (let i = 0; i < 17; i++) {
    sum += (Number(digits[i]) * weights[i % 3]) % 10;
  }
  return (10 - (sum % 10)) % 10 === Number(digits[17]);
}

// Tarjeta de débito: 16 dígitos con algoritmo de Luhn. En los pueblos es muy
// común depositar en OXXO directo al número de tarjeta, sin CLABE.
function isValidCard(digits) {
  if (!/^\d{16}$/.test(digits)) return false;
  let sum = 0;
  for (let i = 0; i < 16; i++) {
    let d = Number(digits[15 - i]);
    if (i % 2 === 1) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
  }
  return sum % 10 === 0;
}

// Devuelve { account, kind } con solo dígitos, o { error } con un mensaje
// que el chofer entienda.
function normalizeAccount(raw) {
  const digits = String(raw ?? "").replace(/\D/g, "");
  if (digits.length === 18) {
    return isValidClabe(digits)
      ? { account: digits, kind: "clabe" }
      : { error: "Esa CLABE no es válida, revisa los 18 dígitos" };
  }
  if (digits.length === 16) {
    return isValidCard(digits)
      ? { account: digits, kind: "tarjeta" }
      : { error: "Ese número de tarjeta no es válido, revisa los 16 dígitos" };
  }
  return { error: "Escribe tu CLABE (18 dígitos) o tu número de tarjeta (16 dígitos)" };
}

module.exports = { normalizeAccount, isValidClabe, isValidCard };
