// Agrupaciones de choferes por municipio (padrón, 18-nov-2026).
// En el registro el chofer elige la suya —junto al nombre del líder, para que
// los líderes vean que la app les suma— o "Otra agrupación". Con eso el
// admin saca el padrón de cada agrupación para su líder y para la Dirección de
// Transporte. Municipio sin lista aquí = no se pregunta nada.
//
// En drivers.grupo / driver_applications.grupo se guarda el `nombre` tal cual
// (o POR_SU_CUENTA = la opción «Otra agrupación»). Si se renombra una agrupación, actualizar también las
// filas viejas, o el padrón las va a mostrar como "Sin elegir".
const AGRUPACIONES = {
  ticul: [
    { nombre: "Jaguar", lider: "Saúl Segura" },
    { nombre: "Alcones Alfa", lider: "Abraham Zavaleta" },
  ],
};

// Valor guardado de "Otra agrupación" (19-nov se cambió solo el texto que se
// ve; el valor guardado sigue igual para no tocar filas viejas).
const POR_SU_CUENTA = "Por su cuenta";

function agrupacionesDe(cityId) {
  return Object.hasOwn(AGRUPACIONES, cityId) ? AGRUPACIONES[cityId] : [];
}

// El texto a guardar si `valor` es una opción válida de ese municipio; null si no.
function grupoValido(cityId, valor) {
  if (typeof valor !== "string") return null;
  const v = valor.trim();
  if (v === POR_SU_CUENTA) return POR_SU_CUENTA;
  const a = agrupacionesDe(cityId).find((x) => x.nombre === v);
  return a ? a.nombre : null;
}

// Al pasajero solo le sirve saber la agrupación; "Por su cuenta" no se le enseña.
function grupoParaPasajero(grupo) {
  return grupo === POR_SU_CUENTA ? null : grupo;
}

// Número del mototaxi en su agrupación (23-nov-2026): solo números, hasta 4
// cifras, sin ceros a la izquierda ("007" → "7"). null si no es válido.
function numeroValido(valor) {
  const v = typeof valor === "number" ? String(valor) : typeof valor === "string" ? valor.trim() : "";
  if (!/^\d{1,4}$/.test(v)) return null;
  const n = String(parseInt(v, 10));
  return n === "0" ? null : n;
}

module.exports = { AGRUPACIONES, POR_SU_CUENTA, agrupacionesDe, grupoValido, grupoParaPasajero, numeroValido };
