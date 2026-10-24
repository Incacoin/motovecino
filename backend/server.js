const path = require("node:path");
const http = require("node:http");
const fs = require("node:fs");
const express = require("express");
require("./asyncRoutes");

if (fs.existsSync(path.join(__dirname, ".env"))) {
  process.loadEnvFile(path.join(__dirname, ".env"));
}

const db = require("./db");
const { setOnAccountLocked } = require("./pinRateLimit");
const { recordError, errorsHealth, isBadInput } = require("./errorAlerts");
const driverRoutes = require("./routes/drivers");
const riderRoutes = require("./routes/riders");
const rideRoutes = require("./routes/rides");
const adminRoutes = require("./routes/admin");
const allyAdRoutes = require("./routes/allyAds");
const businessRoutes = require("./routes/business");
const orderRoutes = require("./routes/orders");
const passkeyRoutes = require("./routes/passkeys");
const menuImages = require("./menuImages");
const familyRides = require("./routes/familyRides");
const { router: photoRoutes } = require("./photos");
const realtime = require("./realtime");
const livePos = require("./livePos");
const { startBackupSchedule, getBackupStatus } = require("./backup");
const { startRetentionSchedule } = require("./retention");
const { migrateImagesToFiles } = require("./imageStore");
const { CITIES, resolveCity, isWithinServiceRadius, getCityById, DEFAULT_CITY_ID, zoneAt, OFFER_MAX_UP, cityOfferRules, isInYucatan } = require("./cities");

const app = express();
app.disable("x-powered-by");
// Render (y cualquier proxy delante del server) reenvía la IP real del
// cliente en X-Forwarded-For — sin esto, req.ip siempre sería la IP interna
// del proxy y el límite de intentos de PIN no distinguiría a nadie.
// Medido en producción 16-oct: X-Forwarded-For llega como
// "<lo que mande el cel>, <IP real>, <IP de Cloudflare>" y el socket es una
// IP interna 10.x de Render. Con `true` Express tomaba el primer valor, que
// el cel puede inventar y así saltarse los límites de intentos. Solo se
// confía en la red interna y en los rangos publicados de Cloudflare
// (cloudflare.com/ips), así req.ip es la primera IP fuera de ellos (la real)
// sin depender de cuántos saltos haya.
const CLOUDFLARE_IPS = [
  "173.245.48.0/20", "103.21.244.0/22", "103.22.200.0/22", "103.31.4.0/22",
  "141.101.64.0/18", "108.162.192.0/18", "190.93.240.0/20", "188.114.96.0/20",
  "197.234.240.0/22", "198.41.128.0/17", "162.158.0.0/15", "104.16.0.0/13",
  "104.24.0.0/14", "172.64.0.0/13", "131.0.72.0/22",
  "2400:cb00::/32", "2606:4700::/32", "2803:f800::/32", "2405:b500::/32",
  "2405:8100::/32", "2a06:98c0::/29", "2c0f:f248::/32",
];
app.set("trust proxy", ["loopback", "linklocal", "uniquelocal", ...CLOUDFLARE_IPS]);

// Cabeceras de seguridad del lado del navegador. El CSP no puede ir más
// estricto que 'unsafe-inline' en script/style porque toda la app (admin,
// chofer, pasajero) es HTML con <script> y style="" inline, sin build step —
// aun así bloquea cosas como <base> hijacking, <object>/<embed>, cargar un
// script de un dominio ajeno, y que cualquier página se abra dentro de un
// iframe de otro sitio (clickjacking).
const CSP = [
  "default-src 'self'",
  "script-src 'self' 'unsafe-inline' https://unpkg.com",
  "style-src 'self' 'unsafe-inline' https://unpkg.com https://fonts.googleapis.com",
  "font-src 'self' https://fonts.gstatic.com",
  // blob: = la foto que la persona elige en su propio celular/compu, para
  // achicarla antes de subirla (logo y productos de "Mi negocio", comprobante
  // del pedido, foto de "Entregar sin clave"). Sin esto la foto no carga.
  "img-src 'self' data: blob: https://*.tile.openstreetmap.org https://api.qrserver.com",
  "connect-src 'self' ws: wss: https://router.project-osrm.org",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  // 'self' (no 'none'): el registro de choferes abre el Aviso Legal, el de
  // Privacidad y el Contrato en un iframe de la misma página. Otro sitio
  // sigue sin poder meter la app en un iframe.
  "frame-ancestors 'self'",
].join("; ");

app.use((req, res, next) => {
  res.set({
    "X-Content-Type-Options": "nosniff",
    "X-Frame-Options": "SAMEORIGIN",
    "Strict-Transport-Security": "max-age=15552000; includeSubDomains",
    "Content-Security-Policy": CSP,
  });
  next();
});

app.use(express.json({ limit: "5mb" }));

// admin.motovecinoapp.com: el admin en su propio subdominio. En el dominio
// principal la app de pasajero/chofer (scope "/") cubre también /admin.html,
// y Chrome no dejaba instalar el admin aparte: te mandaba a la app de
// pasajero. Otro subdominio = otro origen, así cada app se instala sola.
app.use((req, res, next) => {
  if (req.hostname.startsWith("admin.") && req.path === "/") return res.redirect("/admin.html");
  next();
});

// Dominio oficial para Google. Los dominios viejos (motomayaapp.com,
// motoyaapp.com, tekax.*, motoyatekax.onrender.com) siguen sirviendo la app
// para no romper QRs impresos ni apps ya instaladas, pero Google los estaba
// mostrando en los resultados (ej. el Aviso Legal con motomayaapp.com).
// - Las páginas públicas se mandan con 301 a la MISMA ruta en el dominio
//   oficial (conserva ruta y ?query, así los QRs siguen cayendo donde deben).
// - Las pantallas de la app NO se redirigen (otro origen = sesión perdida
//   para quien la instaló desde el dominio viejo): solo se les pide a Google
//   que no las muestre.
const CANONICAL_HOST = "motovecinoapp.com";
const PUBLIC_PAGES = new Set([
  "/aviso-legal.html",
  "/aviso-privacidad.html",
  "/contrato-prestacion-servicios.html",
  "/quiero-ser-chofer.html",
  "/quiero-ser-chofer",
  "/quiero-ser-chofer/",
]);
// Pantallas internas que no deben salir en Google en ningún dominio.
const NOINDEX_PATHS = new Set(["/admin.html", "/seguir.html", "/contrato-prestacion-servicios.html"]);
const isLocalHost = (h) => h === "localhost" || h === "127.0.0.1" || h === "::1";

app.use((req, res, next) => {
  const host = req.hostname || "";
  const isAdminHost = host.startsWith("admin.");
  const isOldHost = !isLocalHost(host) && !isAdminHost && host !== CANONICAL_HOST;
  if (isOldHost && req.method === "GET" && PUBLIC_PAGES.has(req.path)) {
    return res.redirect(301, `https://${CANONICAL_HOST}${req.originalUrl}`);
  }
  if (isOldHost || isAdminHost || NOINDEX_PATHS.has(req.path)) {
    res.set("X-Robots-Tag", "noindex");
  }
  next();
});

// Dirección corta del registro de choferes: el tríptico impreso dice
// "motovecinoapp.com/quiero-ser-chofer" (sin .html) y daba 404.
app.get(["/quiero-ser-chofer", "/quiero-ser-chofer/"], (req, res) => {
  const qs = req.originalUrl.includes("?") ? req.originalUrl.slice(req.originalUrl.indexOf("?")) : "";
  res.redirect("/quiero-ser-chofer.html" + qs);
});

app.use(express.static(path.join(__dirname, "..", "frontend")));

// App de Android en Google Play (com.motovecino.app): este archivo le prueba
// a Android que la app y motovecinoapp.com son del mismo dueño, para que abra
// a pantalla completa sin barra del navegador. express.static ignora las
// carpetas que empiezan con punto, por eso va aparte.
app.get("/.well-known/assetlinks.json", (req, res) => {
  res.type("application/json").sendFile(path.join(__dirname, "..", "frontend", ".well-known", "assetlinks.json"));
});

app.get("/api/health", async (req, res) => {
  try {
    await db.prepare("SELECT 1").get();
    res.json({ status: "ok" });
  } catch (err) {
    res.status(500).json({ status: "error" });
  }
});

// Para UptimeRobot: 500 si hubo 3+ errores del servidor en 15 min (ver
// errorAlerts.js). Solo el número; el detalle está en Movimientos del admin.
app.get("/api/errors-health", (req, res) => {
  const { alert, count } = errorsHealth();
  res.status(alert ? 500 : 200).json({ status: alert ? "errores" : "ok", count });
});

app.get("/api/backup-health", (req, res) => {
  const status = getBackupStatus();
  if (!status.configured) {
    return res.json({ status: "disabled" });
  }
  const STALE_MS = 13 * 60 * 60 * 1000; // respaldo corre cada 6h; 13h da margen a un ciclo perdido
  const isStale = !status.lastSuccessAt || Date.now() - new Date(status.lastSuccessAt).getTime() > STALE_MS;
  res.status(isStale ? 500 : 200).json({ status: isStale ? "stale" : "ok", ...status });
});

app.get("/api/cities", (req, res) => {
  res.json(CITIES);
});

// A qué ciudad de la red pertenece esta coordenada (o null si está fuera de
// todas). El frontend lo usa para mostrar "Estás en Ticul" en vez de tener
// el nombre de una sola ciudad escrito a mano en toda la app.
app.get("/api/cities/resolve", async (req, res) => {
  const lat = parseFloat(req.query.lat);
  const lng = parseFloat(req.query.lng);
  const city = resolveCity(lat, lng);
  // inService distingue "está cerca de este pueblo para la etiqueta" de "está
  // dentro del radio real donde sí dejamos pedir/registrarse" — el frontend
  // lo usa para no anunciar una ciudad a la que luego el backend le va a
  // negar el registro o el viaje.
  // testOnly (Mérida de prueba): sí deja pedir viaje, pero no abre el
  // registro de choferes ahí (quiero-ser-chofer usa inService).
  // signupClosed (Oxkutzcab, Ticul): igual, su cajón existe pero sin registro.
  const inService = city && !city.testOnly && !city.signupClosed ? isWithinServiceRadius(city.id, lat, lng) : false;
  // zone: qué se puede pedir en este punto, con la misma regla que POST
  // /rides (sin pueblo cercano cae en DEFAULT_CITY_ID): "in" = mototaxi y
  // taxi, "taxi" = solo taxi (comisarías, pueblos vecinos), "out" = nada.
  const zoneCityId = city ? city.id : DEFAULT_CITY_ID;
  const zone = isWithinServiceRadius(zoneCityId, lat, lng, "moto")
    ? "in"
    : isWithinServiceRadius(zoneCityId, lat, lng, "taxi") ? "taxi" : "out";
  let zoneLabel = getCityById(zoneCityId)?.label || null;
  // Ciudad por comisarías (Progreso): de qué comisaría es el punto, su
  // tarifa y las reglas de las ofertas. La app del pasajero arma con esto
  // "Moto Exprés" / "Propón tu precio" en vez de Mototaxi / Taxi.
  let comisaria = null;
  let zoneClosed = false;
  if (city && city.zones) {
    const z = zoneAt(city.id, lat, lng);
    if (z) {
      // Comisaría todavía cerrada: se nombra igual, pero motocarro "Muy pronto".
      zoneClosed = z.open === false;
      zoneLabel = z.label;
      comisaria = { id: z.id, label: z.label, fare: z.fare, serviceFee: city.serviceFee, offerMaxUp: OFFER_MAX_UP, offerOnly: !!z.offerOnly, minOffer: z.minOffer || 5, lat: z.lat, lng: z.lng, radiusKm: z.radiusKm };
    }
  }
  // Si en este pueblo ya está prendido "Pedir para otra persona" (ver familyRides.js).
  const familyOn = await familyRides.isFamilyEnabled(zoneCityId);
  // motoSoon: llegamos al lugar pero el mototaxi todavía no (ver cities.js);
  // zone ya viene como "taxi" y la app enseña el mototaxi como "Muy pronto".
  const motoSoon = !!(city && city.motoSoon) || zoneClosed;
  // cityOffer: pueblo solo con "Propón tu precio" (Tekax y el sur): mínimo
  // de día/noche por adulto y niño. null = hay Mototaxi Exprés.
  const cityOffer = comisaria ? null : cityOfferRules(getCityById(zoneCityId));
  // inYucatan: sin municipio cercano, ¿sigue en Yucatán o ya es otro
  // estado/país? Fuera de Yucatán la app dice solo "MotoVecino" (17-oct-2026).
  const inYucatan = isInYucatan(lat, lng) !== false;
  res.json(city
    ? { city: city.id, label: comisaria ? comisaria.label : city.label, inService, zone, zoneLabel, familyRides: familyOn, rideStyle: city.rideStyle || null, comisaria, motoSoon, cityOffer, inYucatan }
    : { city: null, label: null, inService: false, zone, zoneLabel, familyRides: familyOn, rideStyle: null, comisaria: null, motoSoon: false, cityOffer, inYucatan });
});

app.use("/api", driverRoutes);
app.use("/api", riderRoutes);
app.use("/api", rideRoutes);
app.use("/api", adminRoutes);
app.use("/api", allyAdRoutes);
app.use("/api", businessRoutes);
app.use("/api", orderRoutes);
app.use("/api", menuImages.router);
app.use("/api", familyRides.router);
app.use("/api", photoRoutes);
app.use("/api", passkeyRoutes);

// Última red de seguridad: si algo revienta sin que la ruta lo haya
// atrapado (un tipo de dato inesperado, un error de la base, etc.), esto
// evita que Express regrese su página de error por defecto — que en modo
// desarrollo manda la ruta completa del archivo y el stack trace. Hoy
// Render pone NODE_ENV=production y por eso ya sale genérico, pero eso es
// un comportamiento de la plataforma, no algo que garantice el código; esto
// lo deja garantizado pase lo que pase.
app.use((err, req, res, next) => {
  console.error("[error]", err);
  // Dato basura (ver isBadInput en errorAlerts.js): 400, no es falla de la app.
  if (isBadInput(err)) {
    return res.status(400).json({ error: "Datos no válidos" });
  }
  // Un JSON mal formado o una foto demasiado grande (4xx) es culpa de quien
  // lo mandó, no un error de la app: no cuenta para los avisos.
  if (!(err && err.status >= 400 && err.status < 500)) {
    recordError(`${req.method} ${req.path.replace(/\/\d+/g, "/:id")}`, err);
  }
  res.status(500).json({ error: "Algo salió mal, intenta de nuevo" });
});

// Un error en algo que corre "por su cuenta" (un aviso, un barrido) se anota
// en el registro en vez de tumbar el servidor completo.
process.on("unhandledRejection", (err) => {
  console.error("[sin atrapar]", err);
  recordError("tarea de fondo", err);
});

async function start() {
  // Primero la base: tablas al día y arreglos de datos. Si Postgres no
  // contesta, mejor no abrir la app a medias (Render reintenta el arranque).
  await db.init();

  // Pasa a data/img/ las fotos que sigan dentro de la base (ya no debería
  // quedar ninguna). Si falla, la app sigue igual.
  try {
    await migrateImagesToFiles(db);
  } catch (err) {
    console.error("[img] error al pasar fotos a archivos:", err);
  }

  startBackupSchedule(6);
  startRetentionSchedule();
  livePos.start();

  // Render manda SIGTERM antes de apagar (cada deploy): que las últimas
  // ubicaciones del pizarrón lleguen a la base antes de salir.
  process.once("SIGTERM", () => {
    livePos.flush()
      .catch((err) => console.error("[livePos] al apagar:", err))
      .finally(() => process.exit(0));
  });

  // Cuenta bloqueada por PINs equivocados: queda en el registro del admin
  // (Tekax) para que el dueño se entere — ver pinRateLimit.js.
  setOnAccountLocked(({ account, ip }) => {
    db.prepare("INSERT INTO admin_audit (role, zone, action, target_id, detail, ip, ok) VALUES (?, ?, ?, ?, ?, ?, ?)")
      .run(null, null, "cuenta_bloqueada", null, account.replace(/^tel:/, "Teléfono ").replace(/^chofer:/, "Chofer #"), ip || null, 0)
      .catch((err) => console.error("[cuenta_bloqueada]", err));
  });

  const server = http.createServer(app);
  realtime.attach(server, app.get("trust proxy fn"));

  const PORT = process.env.PORT || 3003;
  server.listen(PORT, () => {
    console.log(`MotoVecino backend escuchando en http://localhost:${PORT}`);
  });
}

start().catch((err) => {
  console.error("[arranque] no se pudo iniciar:", err);
  process.exit(1);
});
