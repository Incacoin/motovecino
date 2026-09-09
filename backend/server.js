const path = require("node:path");
const http = require("node:http");
const fs = require("node:fs");
const express = require("express");

if (fs.existsSync(path.join(__dirname, ".env"))) {
  process.loadEnvFile(path.join(__dirname, ".env"));
}

const db = require("./db");
const driverRoutes = require("./routes/drivers");
const riderRoutes = require("./routes/riders");
const rideRoutes = require("./routes/rides");
const adminRoutes = require("./routes/admin");
const realtime = require("./realtime");
const { startBackupSchedule, getBackupStatus } = require("./backup");
const { CITIES, resolveCity } = require("./cities");

const app = express();
// Render (y cualquier proxy delante del server) reenvía la IP real del
// cliente en X-Forwarded-For — sin esto, req.ip siempre sería la IP interna
// del proxy y el límite de intentos de PIN no distinguiría a nadie.
app.set("trust proxy", true);
app.use(express.json({ limit: "5mb" }));

app.use(express.static(path.join(__dirname, "..", "frontend")));

app.get("/api/health", (req, res) => {
  try {
    db.prepare("SELECT 1").get();
    res.json({ status: "ok" });
  } catch (err) {
    res.status(500).json({ status: "error" });
  }
});

app.get("/api/backup-health", (req, res) => {
  const status = getBackupStatus();
  if (!status.configured) {
    return res.json({ status: "disabled" });
  }
  const STALE_MS = 13 * 60 * 60 * 1000; // respaldo corre cada 6h; 13h da margen a un ciclo perdido
  const isStale = !status.lastSuccessAt || Date.now() - new Date(status.lastSuccessAt).getTime() > STALE_MS;
  // lastError trae rutas de archivo internas y respuestas crudas de la API de
  // GitHub — no exponerlo público (este endpoint no tiene auth, lo pega
  // UptimeRobot). El detalle completo ya queda en los logs del servidor.
  res.status(isStale ? 500 : 200).json({
    status: isStale ? "stale" : "ok",
    configured: status.configured,
    lastSuccessAt: status.lastSuccessAt,
    lastAttemptAt: status.lastAttemptAt,
  });
});

app.get("/api/cities", (req, res) => {
  res.json(CITIES);
});

// A qué ciudad de la red pertenece esta coordenada (o null si está fuera de
// todas). El frontend lo usa para mostrar "Estás en Ticul" en vez de tener
// el nombre de una sola ciudad escrito a mano en toda la app.
app.get("/api/cities/resolve", (req, res) => {
  const lat = parseFloat(req.query.lat);
  const lng = parseFloat(req.query.lng);
  const city = resolveCity(lat, lng);
  res.json(city ? { city: city.id, label: city.label } : { city: null, label: null });
});

app.use("/api", driverRoutes);
app.use("/api", riderRoutes);
app.use("/api", rideRoutes);
app.use("/api", adminRoutes);

startBackupSchedule(6);

const server = http.createServer(app);
realtime.attach(server);

const PORT = process.env.PORT || 3003;
server.listen(PORT, () => {
  console.log(`MotoVecino backend escuchando en http://localhost:${PORT}`);
});
