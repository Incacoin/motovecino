const express = require("express");
const db = require("../db");
const { isRateLimited, recordFailedAttempt, clearAttempts, RATE_LIMIT_MESSAGE } = require("../pinRateLimit");
const { photoUrls } = require("../photos");
const { driverLoginPayload } = require("./drivers");
const {
  generateRegistrationOptions, verifyRegistrationResponse,
  generateAuthenticationOptions, verifyAuthenticationResponse,
} = require("@simplewebauthn/server");

// ---- Entrar con huella para pasajeros y choferes (14-oct-2026) ----
// Mismo sistema que la huella del admin (routes/admin.js): ya dentro, la
// persona activa la huella; el celular crea un par de llaves, guarda la
// privada protegida con la huella y nos manda solo la pública. Para entrar,
// el servidor manda un reto, el celular lo firma al poner la huella y aquí se
// comprueba. La llave queda en la cuenta de Google del celular, así que sigue
// sirviendo aunque se borren los datos de la app — por eso se pide "residente"
// (el celular la encuentra sin que le digamos cuál) y se entra sin escribir
// el teléfono. El código por WhatsApp y el PIN siguen de respaldo.
const router = express.Router();

const KINDS = { rider: "pasajero", driver: "chofer" };
const CHALLENGE_TTL_MS = 5 * 60 * 1000;
const challenges = new Map();

function rpId(req) {
  const host = req.hostname;
  if (host === "motovecinoapp.com" || host.endsWith(".motovecinoapp.com")) return "motovecinoapp.com";
  return host.replace(/^(admin|www)\./, "");
}
const origin = (req) => `${req.protocol}://${req.get("host")}`;

function rememberChallenge(challenge, data) {
  const now = Date.now();
  for (const [c, d] of challenges) if (d.exp < now) challenges.delete(c);
  if (challenges.size > 2000) challenges.clear();
  challenges.set(challenge, { ...data, exp: now + CHALLENGE_TTL_MS });
}
// Un reto sirve una sola vez, para lo que se pidió y antes de vencer.
function takeChallenge(match) {
  return (c) => {
    const d = challenges.get(c);
    challenges.delete(c);
    return !!d && d.exp > Date.now() && Object.keys(match).every((k) => d[k] === match[k]);
  };
}

function deviceLabel(req) {
  const ua = String(req.get("user-agent") || "");
  if (/iPhone|iPad/.test(ua)) return "iPhone";
  if (/Android/.test(ua)) return "Celular Android";
  if (/Windows/.test(ua)) return "Computadora Windows";
  if (/Macintosh/.test(ua)) return "Mac";
  return "Otro aparato";
}

const isCredId = (v) => typeof v === "string" && /^[A-Za-z0-9_-]{16,1400}$/.test(v);
const splitTransports = (t) => (t ? t.split(",") : undefined);
const kindOf = (req) => (Object.hasOwn(KINDS, req.body.kind) ? req.body.kind : null);

// Quién es, con teléfono + PIN (lo que el celular ya tiene guardado).
async function findUser(kind, phone, pin) {
  if (!phone || !pin) return null;
  if (kind === "rider") {
    return db.prepare("SELECT id, name, phone FROM riders WHERE phone = ? AND pin = ?").get(String(phone), String(pin));
  }
  return db.prepare("SELECT id, name, phone FROM drivers WHERE phone = ? AND pin = ? AND deleted_at IS NULL").get(String(phone), String(pin));
}

// Lo mismo que regresa entrar con PIN o con código (PIN incluido, para que el
// celular lo guarde y lo siga usando por dentro).
async function loginPayload(kind, userId) {
  if (kind === "rider") {
    const r = await db
      .prepare(
        "SELECT id, name, phone, pin, photo, home_lat, home_lng, home_label, emergency_contact_name, emergency_contact_phone FROM riders WHERE id = ?"
      )
      .get(userId);
    return r && r.pin ? { ...r, ...photoUrls("r", r.id, r.photo) } : null;
  }
  const d = await db
    .prepare(
      "SELECT id, name, phone, pin, vehicle, vehicle_type, status, cooldown_until, deposit_account FROM drivers WHERE id = ? AND deleted_at IS NULL"
    )
    .get(userId);
  return d ? driverLoginPayload(d) : null;
}

// Activar, paso 1: el servidor manda las opciones (con el reto).
router.post("/passkey/register-options", async (req, res) => {
  if (isRateLimited(req.ip)) return res.status(429).json({ error: RATE_LIMIT_MESSAGE });
  const kind = kindOf(req);
  const user = kind && (await findUser(kind, req.body.phone, req.body.pin));
  if (!user) {
    recordFailedAttempt(req.ip);
    return res.status(401).json({ error: "Vuelve a entrar para activar la huella." });
  }
  const existing = await db.prepare("SELECT credential_id, transports FROM user_passkeys WHERE kind = ? AND user_id = ?").all(kind, user.id);
  const options = await generateRegistrationOptions({
    rpName: "MotoVecino",
    rpID: rpId(req),
    // Lo que ve la persona al elegir su llave (puede tener de pasajero y de chofer).
    userName: `${user.phone} (${KINDS[kind]})`,
    userDisplayName: `${user.name} · ${KINDS[kind]}`,
    userID: new TextEncoder().encode(`motovecino-${kind}-${user.id}`),
    attestationType: "none",
    // No volver a activar en un celular que ya tiene la suya.
    excludeCredentials: existing.map((r) => ({ id: r.credential_id, transports: splitTransports(r.transports) })),
    authenticatorSelection: { authenticatorAttachment: "platform", residentKey: "required", userVerification: "required" },
  });
  rememberChallenge(options.challenge, { purpose: "register", kind, userId: user.id });
  res.json(options);
});

// Activar, paso 2: el celular manda su llave pública firmada.
router.post("/passkey/register", async (req, res) => {
  if (isRateLimited(req.ip)) return res.status(429).json({ error: RATE_LIMIT_MESSAGE });
  const kind = kindOf(req);
  const user = kind && (await findUser(kind, req.body.phone, req.body.pin));
  if (!user) {
    recordFailedAttempt(req.ip);
    return res.status(401).json({ error: "Vuelve a entrar para activar la huella." });
  }
  const failMsg = "No se pudo activar la huella. Inténtalo otra vez.";
  let v;
  try {
    v = await verifyRegistrationResponse({
      response: req.body.response,
      expectedChallenge: takeChallenge({ purpose: "register", kind, userId: user.id }),
      expectedOrigin: origin(req),
      expectedRPID: rpId(req),
      requireUserVerification: true,
    });
  } catch (e) {
    console.warn("[huella] registro rechazado:", e.message);
    return res.status(400).json({ error: failMsg });
  }
  if (!v.verified) return res.status(400).json({ error: failMsg });
  const c = v.registrationInfo.credential;
  await db.prepare(
    "INSERT INTO user_passkeys (kind, user_id, credential_id, public_key, counter, transports, label, created_ms) VALUES (?, ?, ?, ?, ?, ?, ?, ?)"
  ).run(kind, user.id, c.id, Buffer.from(c.publicKey).toString("base64url"), c.counter || 0, (c.transports || []).join(",") || null, deviceLabel(req), Date.now());
  res.json({ ok: true, credentialId: c.id });
});

// Quitar la huella de este celular (con teléfono + PIN de la cuenta).
router.post("/passkey/remove", async (req, res) => {
  if (isRateLimited(req.ip)) return res.status(429).json({ error: RATE_LIMIT_MESSAGE });
  const kind = kindOf(req);
  const user = kind && (await findUser(kind, req.body.phone, req.body.pin));
  if (!user || !isCredId(req.body.credentialId)) {
    recordFailedAttempt(req.ip);
    return res.status(401).json({ error: "No autorizado" });
  }
  await db.prepare("DELETE FROM user_passkeys WHERE kind = ? AND user_id = ? AND credential_id = ?").run(kind, user.id, req.body.credentialId);
  res.json({ ok: true });
});

// Entrar, paso 1 (sin sesión): reto para firmar. Si el celular recuerda su
// llave se pide esa; si no (se borraron los datos), el celular ofrece las que
// tenga guardadas en la cuenta de Google.
router.post("/passkey/login-options", async (req, res) => {
  if (isRateLimited(req.ip)) return res.status(429).json({ error: RATE_LIMIT_MESSAGE });
  const kind = kindOf(req);
  if (!kind) return res.status(400).json({ error: "No se pudo entrar" });
  let allow;
  if (isCredId(req.body.credentialId)) {
    const row = await db.prepare("SELECT credential_id, transports FROM user_passkeys WHERE kind = ? AND credential_id = ?").get(kind, req.body.credentialId);
    if (row) allow = [{ id: row.credential_id, transports: splitTransports(row.transports) }];
  }
  const options = await generateAuthenticationOptions({ rpID: rpId(req), allowCredentials: allow, userVerification: "required" });
  rememberChallenge(options.challenge, { purpose: "login", kind });
  res.json(options);
});

// Entrar, paso 2: se comprueba la firma y se regresa la cuenta igual que con PIN.
router.post("/passkey/login", async (req, res) => {
  if (isRateLimited(req.ip)) return res.status(429).json({ error: RATE_LIMIT_MESSAGE });
  const kind = kindOf(req);
  const response = req.body.response;
  const fail = (msg, status = 401) => {
    recordFailedAttempt(req.ip);
    return res.status(status).json({ error: msg });
  };
  if (!kind || !response || !isCredId(response.id)) return fail("No se pudo entrar con la huella.");
  const row = await db.prepare("SELECT * FROM user_passkeys WHERE credential_id = ?").get(response.id);
  if (!row) return fail("La huella de este celular ya no está activada. Entra con el código por WhatsApp.");
  if (row.kind !== kind) {
    return fail(`Esa huella es de tu cuenta de ${KINDS[row.kind]}. Elige la de ${KINDS[kind]} o entra con el código.`);
  }
  let v;
  try {
    v = await verifyAuthenticationResponse({
      response,
      expectedChallenge: takeChallenge({ purpose: "login", kind }),
      expectedOrigin: origin(req),
      expectedRPID: rpId(req),
      credential: {
        id: row.credential_id,
        publicKey: new Uint8Array(Buffer.from(row.public_key, "base64url")),
        counter: Number(row.counter) || 0,
        transports: splitTransports(row.transports),
      },
      requireUserVerification: true,
    });
  } catch (e) {
    console.warn("[huella] entrada rechazada:", e.message);
    return fail("No se pudo entrar con la huella.");
  }
  if (!v.verified) return fail("No se pudo entrar con la huella.");
  const payload = await loginPayload(kind, row.user_id);
  if (!payload) return fail("Esta cuenta ya no está activa.");
  clearAttempts(req.ip);
  await db.prepare("UPDATE user_passkeys SET counter = ?, last_used_ms = ? WHERE id = ?").run(v.authenticationInfo.newCounter || 0, Date.now(), row.id);
  res.json({ ...payload, credentialId: row.credential_id });
});

module.exports = router;
