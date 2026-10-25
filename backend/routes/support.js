// Ayuda dentro de la app (24-oct-2026). El pasajero o el chofer escribe en
// ayuda.html; contesta el Asistente MotoVecino (supportBot.js) y, cuando no
// le toca o la persona lo pide, la conversación pasa al equipo, que contesta
// desde la pestaña Soporte del admin. El WhatsApp de soporte (9422) se queda
// solo para quien no puede entrar a la app.
const express = require("express");
const db = require("../db");
const bot = require("../supportBot");
const { isRateLimited, recordFailedAttempt, clearAttempts, RATE_LIMIT_MESSAGE } = require("../pinRateLimit");
const { checkAdminPin } = require("./admin");

const router = express.Router();

const numericParam = (req, res, next, value) => (/^\d{1,9}$/.test(value) ? next() : res.status(404).json({ error: "No encontrado" }));
router.param("id", numericParam);

const MSG_MAX = 500;
const USER_DAY_LIMIT = 40; // mensajes de una persona al día
const HISTORY_FOR_BOT = 20;
const clean = (t, max) => (typeof t === "string" ? t.trim().slice(0, max) : "");

// Quien escribe: pasajero o chofer, con el mismo teléfono + PIN guardado que
// usan sus apps para todo lo demás.
async function authUser(req, res) {
  if (isRateLimited(req.ip, req.body)) {
    res.status(429).json({ error: RATE_LIMIT_MESSAGE });
    return null;
  }
  const { as, phone, pin } = req.body || {};
  const type = as === "chofer" ? "chofer" : "pasajero";
  let user = null;
  if (phone && pin) {
    user = type === "chofer"
      ? await db.prepare("SELECT id, name, phone, city, vehicle_type FROM drivers WHERE phone = ? AND pin = ? AND deleted_at IS NULL").get(String(phone), String(pin))
      : await db.prepare("SELECT id, name, phone, city FROM riders WHERE phone = ? AND pin = ?").get(String(phone), String(pin));
  }
  if (!user) {
    recordFailedAttempt(req.ip, req.body);
    res.status(401).json({ error: "Vuelve a entrar a la app para usar Ayuda." });
    return null;
  }
  clearAttempts(req.ip);
  return { type, ...user };
}

async function threadFor(user) {
  await db.prepare("INSERT INTO support_threads (user_type, user_id) VALUES (?, ?) ON CONFLICT (user_type, user_id) DO NOTHING")
    .run(user.type, user.id);
  return db.prepare("SELECT * FROM support_threads WHERE user_type = ? AND user_id = ?").get(user.type, user.id);
}

async function messagesOf(threadId, limit = 80) {
  const rows = await db.prepare("SELECT id, sender, text, created_at FROM support_messages WHERE thread_id = ? ORDER BY id DESC LIMIT ?")
    .all(threadId, limit);
  return rows.reverse();
}

async function addMessage(threadId, sender, text) {
  await db.prepare("INSERT INTO support_messages (thread_id, sender, text) VALUES (?, ?, ?)").run(threadId, sender, text);
  await db.prepare("UPDATE support_threads SET updated_at = datetime('now') WHERE id = ?").run(threadId);
}

async function handOff(thread, reason) {
  await db.prepare("UPDATE support_threads SET mode = 'humano', needs_human = 1, handoff_reason = ? WHERE id = ?")
    .run(String(reason || "").slice(0, 200) || null, thread.id);
}

// Lo que el asistente puede saber de quien escribe: nombre, municipio y sus
// últimos viajes (para contestar "¿por qué me cobraron…?"). Nada de teléfonos.
async function userContext(user) {
  const col = user.type === "chofer" ? "driver_id" : "rider_id";
  const rides = await db.prepare(
    `SELECT id, ride_type, service_kind, status, agreed_price, offer_price, passengers, children, cancelled_by, created_at
     FROM rides WHERE ${col} = ? ORDER BY id DESC LIMIT 3`
  ).all(user.id);
  const lines = [
    `Es ${user.type === "chofer" ? `chofer (${user.vehicle_type === "taxi" ? "taxi" : user.vehicle_type || "mototaxi"})` : "pasajero"}.`,
    `Nombre: ${String(user.name || "").split(/\s+/)[0] || "sin nombre"}. Municipio: ${user.city || "tekax"}.`,
  ];
  if (rides.length) {
    lines.push("Últimos viajes (hora UTC):");
    for (const r of rides) {
      const price = r.agreed_price ?? r.offer_price;
      lines.push(`- #${r.id} ${r.created_at} · ${r.ride_type || "moto"}${r.service_kind && r.service_kind !== "pasaje" ? ` (${r.service_kind})` : ""} · ${r.status}${r.cancelled_by ? ` por ${r.cancelled_by}` : ""}${price != null ? ` · precio $${price}` : ""} · ${r.passengers || 1} adulto(s)${r.children ? `, ${r.children} niño(s)` : ""}`);
    }
  } else {
    lines.push("No tiene viajes todavía.");
  }
  return lines.join("\n");
}

function publicThread(thread, messages) {
  return { mode: thread.mode, waiting: !!thread.needs_human, bot: bot.enabled(), messages };
}

// Abrir Ayuda (sin text) o mandar un mensaje. Contesta con la conversación.
router.post("/support/chat", async (req, res) => {
  const user = await authUser(req, res);
  if (!user) return;
  let thread = await threadFor(user);
  const text = clean(req.body.text, MSG_MAX);
  if (text) {
    const day = await db.prepare(
      "SELECT COUNT(*) AS n FROM support_messages WHERE thread_id = ? AND sender = 'usuario' AND created_at >= datetime('now', '-1 days')"
    ).get(thread.id);
    if (Number(day.n) >= USER_DAY_LIMIT) return res.status(429).json({ error: "Ya mandaste muchos mensajes hoy. Te contestamos aquí en cuanto podamos." });
    await addMessage(thread.id, "usuario", text);
    if (thread.mode === "humano") {
      await db.prepare("UPDATE support_threads SET needs_human = 1 WHERE id = ?").run(thread.id);
    } else {
      const history = (await messagesOf(thread.id, HISTORY_FOR_BOT)).map((m) => ({ sender: m.sender, text: m.text }));
      const answer = await bot.reply(history, await userContext(user));
      await addMessage(thread.id, "asistente", answer.text);
      if (answer.handoff) await handOff(thread, answer.reason);
    }
    thread = await threadFor(user);
  }
  await db.prepare("UPDATE support_messages SET read_at = datetime('now') WHERE thread_id = ? AND sender = 'equipo' AND read_at IS NULL").run(thread.id);
  res.json(publicThread(thread, await messagesOf(thread.id)));
});

// "Hablar con una persona".
router.post("/support/human", async (req, res) => {
  const user = await authUser(req, res);
  if (!user) return;
  const thread = await threadFor(user);
  if (thread.mode !== "humano") {
    await addMessage(thread.id, "asistente", "Listo. Escribe aquí lo que necesitas y una persona del equipo de MotoVecino te contesta en cuanto pueda.");
    await handOff(thread, "Pidió hablar con una persona");
  }
  res.json(publicThread(await threadFor(user), await messagesOf(thread.id)));
});

// Puntito rojo en el menú: respuestas del equipo sin leer.
router.post("/support/unread", async (req, res) => {
  const user = await authUser(req, res);
  if (!user) return;
  const r = await db.prepare(
    `SELECT COUNT(*) AS n FROM support_messages m JOIN support_threads t ON t.id = m.thread_id
     WHERE t.user_type = ? AND t.user_id = ? AND m.sender = 'equipo' AND m.read_at IS NULL`
  ).get(user.type, user.id);
  res.json({ unread: Number(r && r.n) || 0 });
});

// ---------- Admin: pestaña Soporte (solo el dueño, PIN de Tekax) ----------
function ownerOnly(req, res, next) {
  if (req.adminRole !== "tekax") return res.status(403).json({ error: "Esto solo lo puede ver el dueño." });
  next();
}

async function userOf(thread) {
  const u = thread.user_type === "chofer"
    ? await db.prepare("SELECT name, phone, city FROM drivers WHERE id = ?").get(thread.user_id)
    : await db.prepare("SELECT name, phone, city FROM riders WHERE id = ?").get(thread.user_id);
  return { id: thread.user_id, type: thread.user_type, name: u ? u.name : "(cuenta borrada)", phone: u ? u.phone : null, city: u ? u.city : null };
}

router.post("/admin/support/list", checkAdminPin, ownerOnly, async (req, res) => {
  const threads = await db.prepare(
    `SELECT t.*, (SELECT COUNT(*) FROM support_messages m WHERE m.thread_id = t.id) AS total
     FROM support_threads t ORDER BY t.needs_human DESC, t.updated_at DESC LIMIT 60`
  ).all();
  const out = [];
  for (const t of threads) {
    if (!Number(t.total)) continue;
    const last = await db.prepare("SELECT sender, text, created_at FROM support_messages WHERE thread_id = ? ORDER BY id DESC LIMIT 1").get(t.id);
    out.push({
      id: t.id, mode: t.mode, waiting: !!t.needs_human, reason: t.handoff_reason, updated_at: t.updated_at,
      user: await userOf(t), last: last ? { sender: last.sender, text: last.text.slice(0, 100), created_at: last.created_at } : null,
    });
  }
  res.json({ bot: bot.enabled(), waiting: out.filter((t) => t.waiting).length, threads: out });
});

async function adminThread(id, res) {
  const t = await db.prepare("SELECT * FROM support_threads WHERE id = ?").get(id);
  if (!t) { res.status(404).json({ error: "Conversación no encontrada" }); return null; }
  return t;
}
async function adminView(t) {
  return { id: t.id, mode: t.mode, waiting: !!t.needs_human, reason: t.handoff_reason, user: await userOf(t), messages: await messagesOf(t.id, 200) };
}

router.post("/admin/support/:id", checkAdminPin, ownerOnly, async (req, res) => {
  const t = await adminThread(req.params.id, res);
  if (!t) return;
  await db.prepare("UPDATE support_messages SET read_at = datetime('now') WHERE thread_id = ? AND sender = 'usuario' AND read_at IS NULL").run(t.id);
  res.json(await adminView(t));
});

// Contestar como equipo: la conversación queda con el equipo (el asistente
// ya no se mete) hasta que se marque "Resuelto".
router.post("/admin/support/:id/reply", checkAdminPin, ownerOnly, async (req, res) => {
  const t = await adminThread(req.params.id, res);
  if (!t) return;
  const text = clean(req.body.text, 1000);
  if (!text) return res.status(400).json({ error: "Escribe la respuesta" });
  await addMessage(t.id, "equipo", text);
  await db.prepare("UPDATE support_threads SET mode = 'humano', needs_human = 0 WHERE id = ?").run(t.id);
  res.json(await adminView(await adminThread(t.id, res)));
});

// Resuelto: el asistente vuelve a contestar la próxima duda de esa persona.
router.post("/admin/support/:id/resolve", checkAdminPin, ownerOnly, async (req, res) => {
  const t = await adminThread(req.params.id, res);
  if (!t) return;
  await db.prepare("UPDATE support_threads SET mode = 'bot', needs_human = 0, handoff_reason = NULL WHERE id = ?").run(t.id);
  res.json(await adminView(await adminThread(t.id, res)));
});

module.exports = router;
