// Soporte por WhatsApp en el 997 140 7972 (4-nov-2026). Ese número ya es el
// "sender" de Twilio que manda los códigos y la bienvenida; desde hoy, cuando
// alguien le contesta, Twilio llama a POST /api/whatsapp/incoming y aquí lo
// atiende el mismo Asistente MotoVecino de Ayuda (supportBot.js). Si hace
// falta una persona, la plática sale en admin → Soporte (etiqueta WhatsApp),
// al dueño le llega el aviso y su respuesta se manda por WhatsApp.
//
// En Twilio: Messaging → Senders → WhatsApp senders → 7972 → "Webhook URL for
// incoming messages" = https://motovecinoapp.com/api/whatsapp/incoming (POST).
//
// Variables en Render:
//   TWILIO_AUTH_TOKEN   — obligatoria aquí: con ella se revisa que el mensaje
//                         de verdad venga de Twilio (firma X-Twilio-Signature).
//                         Sin ella el webhook no acepta nada.
//   WHATSAPP_BOT=off    — apaga solo el WhatsApp automático (Ayuda sigue).
//   WHATSAPP_WEBHOOK_URL — solo si la dirección puesta en Twilio no es la de
//                         arriba (la firma se calcula con la dirección exacta).
const crypto = require("node:crypto");
const express = require("express");
const db = require("./db");
const bot = require("./supportBot");
const push = require("./push");

const WEBHOOK_PATH = "/api/whatsapp/incoming";
const DEFAULT_WEBHOOK_URL = "https://motovecinoapp.com" + WEBHOOK_PATH;
const MSG_MAX = 1000;
const USER_DAY_LIMIT = 40; // mensajes de un número al día que se atienden
const HISTORY_FOR_BOT = 20;
// La gente manda "hola" / "una pregunta" / "cuánto cuesta" en 3 mensajes:
// se espera un momento a que termine y se contesta todo junto.
const QUIET_MS = Number(process.env.WHATSAPP_QUIET_MS) || 6000;

function waEnabled() {
  return process.env.WHATSAPP_BOT !== "off";
}

// ---------- Twilio ----------
function twilioAuth() {
  const user = process.env.TWILIO_API_KEY || process.env.TWILIO_ACCOUNT_SID;
  const pass = process.env.TWILIO_API_KEY ? process.env.TWILIO_API_SECRET : process.env.TWILIO_AUTH_TOKEN;
  if (!user || !pass) throw new Error("Faltan variables de Twilio");
  return "Basic " + Buffer.from(`${user}:${pass}`).toString("base64");
}

// Firma de Twilio: HMAC-SHA1 (con el Auth Token) de la dirección + cada
// parámetro ordenado por nombre (nombre y valor pegados), en base64.
function signatureFor(token, url, params) {
  const data = url + Object.keys(params).sort().map((k) => k + params[k]).join("");
  return crypto.createHmac("sha1", token).update(Buffer.from(data, "utf8")).digest("base64");
}

function validSignature(req) {
  const token = process.env.TWILIO_AUTH_TOKEN;
  const given = req.get("X-Twilio-Signature");
  if (!token || !given) return false;
  const url = process.env.WHATSAPP_WEBHOOK_URL || DEFAULT_WEBHOOK_URL;
  const expected = Buffer.from(signatureFor(token, url, req.body || {}));
  const got = Buffer.from(given);
  return expected.length === got.length && crypto.timingSafeEqual(expected, got);
}

// Otra dirección solo en pruebas locales (Twilio falso).
function twilioBase() {
  return process.env.TWILIO_API_BASE || "https://api.twilio.com";
}

// Texto libre por WhatsApp (solo sirve dentro de las 24 h desde el último
// mensaje de la persona; fuera de eso Twilio contesta error 63016).
async function sendText(waTo, body) {
  const sid = process.env.TWILIO_ACCOUNT_SID;
  const from = process.env.TWILIO_WHATSAPP_FROM;
  if (!sid || !from) throw new Error("Faltan variables de Twilio");
  const res = await fetch(`${twilioBase()}/2010-04-01/Accounts/${sid}/Messages.json`, {
    method: "POST",
    headers: { Authorization: twilioAuth(), "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ From: `whatsapp:${from}`, To: waTo, Body: body.slice(0, 1500) }),
  });
  if (!res.ok) {
    const text = await res.text();
    let code = null;
    try { code = JSON.parse(text).code; } catch {}
    const err = new Error(`Twilio ${res.status}: ${text.slice(0, 300)}`);
    err.twilioCode = code;
    throw err;
  }
}

// ---------- Contactos ----------
// "whatsapp:+5219971234567" → "9971234567" (México, como en riders/drivers;
// WhatsApp a veces manda el "1" viejo de celular) o "+51987654321" (otro país).
function phoneFromWa(waFrom) {
  const m = /^whatsapp:\+(\d{8,15})$/.exec(String(waFrom || ""));
  if (!m) return null;
  const d = m[1];
  if (/^521\d{10}$/.test(d)) return d.slice(3);
  if (/^52\d{10}$/.test(d)) return d.slice(2);
  return "+" + d;
}

async function contactFor(waFrom, phone, profileName) {
  const name = String(profileName || "").replace(/[\u0000-\u001f]+/g, " ").trim().slice(0, 60) || null;
  await db.prepare(
    `INSERT INTO whatsapp_contacts (wa_from, phone, profile_name, last_inbound_at) VALUES (?, ?, ?, datetime('now'))
     ON CONFLICT (wa_from) DO UPDATE SET last_inbound_at = excluded.last_inbound_at,
       profile_name = COALESCE(excluded.profile_name, whatsapp_contacts.profile_name)`
  ).run(waFrom, phone, name);
  return db.prepare("SELECT * FROM whatsapp_contacts WHERE wa_from = ?").get(waFrom);
}

// ¿Este número tiene cuenta en la app? (chofer primero: es quien más escribe)
async function accountOf(phone) {
  const driver = await db.prepare("SELECT id, name, phone, city, vehicle_type, status FROM drivers WHERE phone = ? AND deleted_at IS NULL").get(phone);
  if (driver) return { type: "chofer", ...driver };
  const rider = await db.prepare("SELECT id, name, phone, city FROM riders WHERE phone = ?").get(phone);
  if (rider) return { type: "pasajero", ...rider };
  return null;
}

// Lo que se recibe además del texto (audio, foto, ubicación…).
function describeMedia(body) {
  const n = Number(body.NumMedia) || 0;
  if (body.Latitude && body.Longitude) {
    const lat = Number(body.Latitude), lng = Number(body.Longitude);
    if (Number.isFinite(lat) && Number.isFinite(lng)) return `[Mandó una ubicación: https://maps.google.com/?q=${lat},${lng}]`;
    return "[Mandó una ubicación]";
  }
  if (!n) return "";
  const type = String(body.MediaContentType0 || "");
  if (type.startsWith("audio/")) return "[Mandó un audio]";
  if (type.startsWith("image/")) return "[Mandó una foto]";
  if (type.startsWith("video/")) return "[Mandó un video]";
  return "[Mandó un archivo]";
}

// La primera foto/audio/video del mensaje (WhatsApp manda uno por mensaje).
// Solo direcciones de Twilio: el servidor las abre con la clave.
const MEDIA_TYPES = /^(image|audio|video)\//;
function mediaOf(body) {
  if (!(Number(body.NumMedia) > 0)) return null;
  const url = String(body.MediaUrl0 || "");
  const type = String(body.MediaContentType0 || "").split(";")[0].trim().toLowerCase();
  const path = url.startsWith(twilioBase()) ? url.slice(twilioBase().length) : "";
  if (!/^\/2010-04-01\/Accounts\/AC[0-9a-f]{32}\/Messages\/MM[0-9a-f]{32}\/Media\/ME[0-9a-f]{32}$/i.test(path)) return null;
  if (!MEDIA_TYPES.test(type)) return null;
  return { url, type };
}

const MEDIA_MAX_BYTES = 16 * 1024 * 1024; // lo máximo que deja WhatsApp
async function fetchMedia(url) {
  if (!url.startsWith(twilioBase() + "/2010-04-01/")) return null;
  try {
    // Twilio pide la clave y luego redirige a su almacén (ahí ya no se manda).
    const r = await fetch(url, { headers: { Authorization: twilioAuth() } });
    if (!r.ok) { console.warn("[whatsapp] archivo:", r.status); return null; }
    const buffer = Buffer.from(await r.arrayBuffer());
    if (buffer.length > MEDIA_MAX_BYTES) return null;
    return { buffer, type: r.headers.get("content-type") || "application/octet-stream" };
  } catch (e) {
    console.warn("[whatsapp] archivo:", e.message);
    return null;
  }
}

// ---------- Plática ----------
// `support` = las piezas de routes/support.js (threads, mensajes, contexto),
// para no repetir nada: la plática de WhatsApp es una más de Soporte.
function createRouter(support) {
  const router = express.Router();
  const seen = new Set(); // MessageSid ya atendidos (Twilio reintenta si tardamos)
  const pending = new Map(); // threadId → { timer, running, again }

  function remember(sid) {
    if (!sid) return true;
    if (seen.has(sid)) return false;
    seen.add(sid);
    if (seen.size > 2000) seen.delete(seen.values().next().value);
    return true;
  }

  async function contextFor(contact, account) {
    const lines = [`Escribe por WhatsApp. Nombre en WhatsApp: ${contact.profile_name || "no lo dice"}.`];
    if (account) {
      lines.push(`Tiene cuenta en la app con este número:`);
      lines.push(await support.userContext(account));
    } else {
      lines.push("No tiene cuenta en la app con este número (puede usar otro número, o ser alguien nuevo). Municipio: no se sabe.");
    }
    return lines.join("\n");
  }

  function notifyOwner(contact, thread, text) {
    const who = contact.profile_name || contact.phone;
    push.notifySupport("admin", 0, {
      kind: "admin", tag: `ayuda-${thread.id}`, url: "/admin.html#soporte",
      title: `💬 ${who} te escribió por WhatsApp`, body: text.slice(0, 140),
    }).catch((e) => console.warn("[whatsapp] aviso al dueño:", e.message));
  }

  async function answer(threadId, contact) {
    const thread = await db.prepare("SELECT * FROM support_threads WHERE id = ?").get(threadId);
    if (!thread || thread.mode === "humano") return;
    const history = (await support.messagesOf(thread.id, HISTORY_FOR_BOT)).map((m) => ({ sender: m.sender, text: m.text }));
    if (!history.length || history[history.length - 1].sender !== "usuario") return; // ya se contestó
    const account = await accountOf(contact.phone);
    const res = await bot.reply(history, await contextFor(contact, account), { channel: "whatsapp" });
    try {
      await sendText(contact.wa_from, res.text);
    } catch (e) {
      console.error("[whatsapp] no se pudo contestar:", e.message);
      await support.handOff(thread, "No se pudo contestar por WhatsApp");
      notifyOwner(contact, thread, history[history.length - 1].text);
      return;
    }
    await support.addMessage(thread.id, "asistente", res.text);
    if (res.handoff) {
      await support.handOff(thread, res.reason);
      notifyOwner(contact, thread, history[history.length - 1].text);
    }
  }

  // Espera a que la persona termine de escribir; si escribe mientras el
  // asistente piensa, se vuelve a contestar al terminar.
  function schedule(threadId, contact) {
    let p = pending.get(threadId);
    if (!p) { p = { timer: null, running: false, again: false, contact }; pending.set(threadId, p); }
    p.contact = contact;
    if (p.running) { p.again = true; return; }
    clearTimeout(p.timer);
    p.timer = setTimeout(async () => {
      p.running = true;
      try { await answer(threadId, p.contact); } catch (e) { console.error("[whatsapp] error al contestar:", e.message); }
      p.running = false;
      if (p.again) { p.again = false; schedule(threadId, p.contact); return; }
      pending.delete(threadId);
    }, QUIET_MS);
  }

  router.post("/whatsapp/incoming", express.urlencoded({ extended: false, limit: "64kb" }), async (req, res) => {
    if (!validSignature(req)) {
      if (!process.env.TWILIO_AUTH_TOKEN) console.warn("[whatsapp] falta TWILIO_AUTH_TOKEN: no se aceptan mensajes");
      return res.status(403).send("Firma no válida");
    }
    // Se le contesta a Twilio de inmediato (vacío); la respuesta a la persona
    // sale aparte, cuando el asistente termina.
    res.type("text/xml").send("<Response></Response>");

    try {
      const b = req.body || {};
      if (!waEnabled() || !remember(b.MessageSid)) return;
      const waFrom = String(b.From || "");
      const phone = phoneFromWa(waFrom);
      if (!phone) return;
      const text = [String(b.Body || "").trim(), describeMedia(b)].filter(Boolean).join(" ").slice(0, MSG_MAX);
      if (!text) return;

      const contact = await contactFor(waFrom, phone, b.ProfileName);
      const thread = await support.threadFor({ type: "whatsapp", id: contact.id });
      const day = await db.prepare(
        "SELECT COUNT(*) AS n FROM support_messages WHERE thread_id = ? AND sender = 'usuario' AND created_at >= datetime('now', '-1 days')"
      ).get(thread.id);
      if (Number(day.n) >= USER_DAY_LIMIT) return; // ya no se guarda ni se contesta (cuesta)
      await support.addMessage(thread.id, "usuario", text, mediaOf(b));

      if (thread.mode === "humano") {
        await db.prepare("UPDATE support_threads SET needs_human = 1 WHERE id = ?").run(thread.id);
        notifyOwner(contact, thread, text);
      } else if (!bot.enabled()) {
        // Sin asistente: se avisa una vez que contesta una persona.
        await support.handOff(thread, "Asistente apagado");
        await sendText(waFrom, bot.HANDOFF_TEXT_WA).then(
          () => support.addMessage(thread.id, "asistente", bot.HANDOFF_TEXT_WA),
          (e) => console.error("[whatsapp] no se pudo contestar:", e.message)
        );
        notifyOwner(contact, thread, text);
      } else {
        schedule(thread.id, contact);
      }
    } catch (e) {
      console.error("[whatsapp] error con un mensaje:", e.message);
    }
  });

  return router;
}

// Para la respuesta del dueño desde admin → Soporte.
async function replyFromTeam(contactId, text) {
  const c = await db.prepare(
    "SELECT *, CASE WHEN last_inbound_at >= datetime('now', '-23 hours', '-50 minutes') THEN 1 ELSE 0 END AS open_window FROM whatsapp_contacts WHERE id = ?"
  ).get(contactId);
  if (!c) return { error: "Ese contacto de WhatsApp ya no existe." };
  if (!Number(c.open_window)) {
    return { error: "Ya pasaron 24 horas desde su último mensaje y WhatsApp no deja escribirle primero. Espera a que te vuelva a escribir, o márcale/escríbele desde el 9422." };
  }
  try {
    await sendText(c.wa_from, text);
  } catch (e) {
    console.error("[whatsapp] respuesta del equipo:", e.message);
    if (e.twilioCode === 63016) return { error: "WhatsApp ya no deja escribirle (pasaron 24 h). Escríbele desde el 9422." };
    return { error: "No se pudo mandar por WhatsApp. Intenta otra vez." };
  }
  return { ok: true };
}

async function contactInfo(contactId) {
  const c = await db.prepare("SELECT id, phone, profile_name FROM whatsapp_contacts WHERE id = ?").get(contactId);
  if (!c) return null;
  return { ...c, account: await accountOf(c.phone) };
}

module.exports = { createRouter, replyFromTeam, contactInfo, fetchMedia, mediaOf, phoneFromWa, signatureFor, WEBHOOK_PATH };
