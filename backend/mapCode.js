const crypto = require("node:crypto");

// Código del chofer en el mapa público de choferes libres. En vez del número
// de chofer va este código, que cambia cada día (y si se reinicia el server),
// solo para que el mapa sepa qué motito mover.
//
// Antes el mapa del chofer mandaba &me=<su número> para no verse a sí mismo,
// pero eso dejaba averiguar qué número era cada moto (probando me=1, 2, 3… y
// viendo qué código desaparecía). Revisión de seguridad del 19-nov-2026. Ahora
// el chofer recibe SU código por su conexión en vivo (con PIN) y se esconde
// él solo en su celular.
const mapCodeKey = crypto.randomBytes(32);
const LOCAL_OFFSET_MS = -6 * 60 * 60 * 1000; // día de Yucatán (igual que LOCAL_OFFSET)

function mapCode(driverId) {
  const day = new Date(Date.now() + LOCAL_OFFSET_MS).toISOString().slice(0, 10);
  return crypto.createHmac("sha256", mapCodeKey).update(`${day}|${driverId}`).digest("base64url").slice(0, 12);
}

module.exports = { mapCode };
