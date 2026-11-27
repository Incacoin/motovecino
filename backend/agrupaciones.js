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
    { nombre: "Alcones Alfa", lider: "Abraham Zavala" },
  ],
};

// Valor guardado de "Otra agrupación" (19-nov se cambió solo el texto que se
// ve; el valor guardado sigue igual para no tocar filas viejas).
const POR_SU_CUENTA = "Por su cuenta";

// Nombre que se VE para esa opción (26-nov-2026). En Ticul es el grupo de
// choferes sin líder que maneja MotoVecino. El valor guardado no cambia.
const NOMBRE_OTRA = { ticul: "MotoVecino Ticul Choferes" };
function nombreOtra(cityId) {
  return Object.hasOwn(NOMBRE_OTRA, cityId) ? NOMBRE_OTRA[cityId] : "Otra agrupación";
}

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

// «¿Cuál agrupación?» (24-nov-2026): quien elige «Otra agrupación» escribe el
// nombre real de la suya (ej. «Los Halcones»). Se guarda en grupo_otro, solo
// para el padrón interno del admin. Espacios juntos, hasta 60 letras. null si
// queda vacío o con menos de 2 letras.
function grupoOtroValido(valor) {
  if (typeof valor !== "string") return null;
  const v = valor.replace(/\s+/g, " ").trim().slice(0, 60).trim();
  return v.length >= 2 ? v : null;
}

// ¿Al chofer le falta decir su agrupación? Solo en municipios con lista: sin
// elegir o con un valor que ya no está en la lista. Desde el 26-nov-2026
// «¿De qué agrupación vienes?» es opcional: «Otra» sin decir cuál ya no falta.
// Es lo que hace salir la ventanita en su app. Si ya contestó Jaguar/Alcones y
// espera que el admin lo confirme (porConfirmar), ya no le falta.
function faltaAgrupacion(cityId, grupo, grupoOtro, porConfirmar) {
  if (!agrupacionesDe(cityId).length) return false;
  const pc = grupoValido(cityId, porConfirmar);
  if (pc && pc !== POR_SU_CUENTA) return false;
  return !grupoValido(cityId, grupo);
}

// Número del mototaxi en su agrupación (23-nov-2026): solo números, hasta 4
// cifras, sin ceros a la izquierda ("007" → "7"). null si no es válido.
function numeroValido(valor) {
  const v = typeof valor === "number" ? String(valor) : typeof valor === "string" ? valor.trim() : "";
  if (!/^\d{1,4}$/.test(v)) return null;
  const n = String(parseInt(v, 10));
  return n === "0" ? null : n;
}

module.exports = { AGRUPACIONES, POR_SU_CUENTA, NOMBRE_OTRA, nombreOtra, agrupacionesDe, grupoValido, grupoOtroValido, faltaAgrupacion, grupoParaPasajero, numeroValido };
