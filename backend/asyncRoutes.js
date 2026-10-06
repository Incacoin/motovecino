// Express 4 no atrapa los errores de las rutas `async`: si una consulta a la
// base falla dentro de una, la petición se queda colgada sin respuesta. Esto
// hace que ese error llegue al manejador de errores de server.js (responde
// "Algo salió mal") igual que un error normal. Es lo mismo que hace el
// paquete express-async-errors. Se carga una vez, al inicio de server.js.
const Layer = require("express/lib/router/layer");

Layer.prototype.handle_request = function handle(req, res, next) {
  const fn = this.handle;
  if (fn.length > 3) return next(); // no es una ruta normal
  try {
    const result = fn(req, res, next);
    if (result && typeof result.then === "function") result.then(null, next);
  } catch (err) {
    next(err);
  }
};
