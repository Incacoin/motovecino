// Prueba de la tarjeta del viaje en admin → Soporte (21-nov-2026): si en la
// plática de WhatsApp dicen "viaje #N", el panel enseña ese viaje SOLO si el
// teléfono que escribe es el del pasajero; si no, no enseña datos.
// Necesita la app corriendo en BASE y DATABASE_URL de esa misma base.
const path = require("node:path");
process.loadEnvFile(path.join(__dirname, "..", ".env"));
const BASE = process.env.BASE || "http://localhost:3077";
for (const u of [BASE, process.env.DATABASE_URL]) {
  if (!/^(https?|postgres):\/\/([^@/]*@)?(localhost|127\.0\.0\.1)[:/]/.test(String(u))) throw new Error("Esto solo se corre en localhost: " + u);
}
const db = require("../db");
const ADMIN = process.env.ADMIN_PIN;

let pass = 0;
let fail = 0;
function check(label, cond, extra) {
  if (cond) pass++;
  else {
    fail++;
    console.log("✗", label, extra !== undefined ? JSON.stringify(extra).slice(0, 300) : "");
  }
}
const post = async (u, b) => {
  const r = await fetch(BASE + "/api" + u, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(b) });
  return { status: r.status, data: await r.json().catch(() => null) };
};

async function waThread(phone, name, text) {
  const c = await db.prepare("INSERT INTO whatsapp_contacts (wa_from, phone, profile_name, last_inbound_at) VALUES (?, ?, ?, datetime('now'))")
    .run(`whatsapp:+521${phone}`, phone, name);
  const t = await db.prepare("INSERT INTO support_threads (user_type, user_id, mode, needs_human) VALUES ('whatsapp', ?, 'bot', 1)").run(c.lastInsertRowid);
  await db.prepare("INSERT INTO support_messages (thread_id, sender, text) VALUES (?, 'usuario', ?)").run(t.lastInsertRowid, text);
  return t.lastInsertRowid;
}

async function main() {
  const stamp = String(Date.now()).slice(-6);
  const riderPhone = `96633${stamp}`.slice(0, 10);
  const otherPhone = `96644${stamp}`.slice(0, 10);
  // Chofer propio con número de unidad y color (23-nov), para ver la tarjeta completa.
  const drvPhone = `96611${stamp}`.slice(0, 10);
  const dIns = await db.prepare("INSERT INTO drivers (name, phone, pin, city, numero_unidad, vehicle_color, grupo) VALUES (?, ?, ?, 'ticul', '45', 'Rojo', 'Alcones Alfa')")
    .run(`Chofer Queja ${stamp}`, drvPhone, `7${stamp}1`);
  const drv = { id: dIns.lastInsertRowid, name: `Chofer Queja ${stamp}` };
  const pidioMs = Date.now() - 40 * 60000;
  const ride = await db.prepare(
    "INSERT INTO rides (rider_name, rider_phone, pickup_lat, pickup_lng, dest_lat, dest_lng, city, status, driver_id, created_at, updated_at, arrived_at_ms, started_at_ms, completed_at, agreed_price) VALUES (?, ?, 20.39528, -89.53389, 20.40, -89.53, 'ticul', 'completado', ?, datetime('now', '-40 minutes'), datetime('now'), ?, ?, datetime('now', '-5 minutes'), 25)"
  ).run("Pasajera Queja", riderPhone, drv.id, pidioMs + 14 * 60000, pidioMs + 16 * 60000);
  const rideId = ride.lastInsertRowid;

  // 1) Escribe el mismo pasajero del viaje: se ve la tarjeta completa.
  const t1 = await waThread(riderPhone, "Pasajera", `Hola, quiero dejar una queja o sugerencia sobre mi viaje en MotoVecino Ticul (viaje #${rideId}). Motivo: Llegó tarde. Lo que pasó: se tardó mucho`);
  const v1 = await post(`/admin/support/${t1}`, { adminPin: ADMIN });
  const r1 = v1.data && v1.data.ride;
  check("panel abre la plática", v1.status === 200, v1);
  check("tarjeta: viaje correcto y es de este número", r1 && r1.id === Number(rideId) && r1.found && r1.mine, r1);
  check("tarjeta: municipio del VIAJE (Ticul)", r1 && r1.city === "Ticul", r1);
  check("tarjeta: pasajero, estado y vehículo", r1 && r1.rider === "Pasajera Queja" && r1.status === "Completado" && r1.vehicle === "mototaxi", r1);
  check("tarjeta: chofer", r1 && (drv ? r1.driver === drv.name : r1.driver === null), r1);
  check("tarjeta: sin teléfono del pasajero ni ubicación", r1 && !JSON.stringify(r1).includes(riderPhone) && !("pickup_lat" in r1) && !("rider_phone" in r1), r1);
  // Datos para resolver la queja (23-nov).
  check("tarjeta: motivo que tocó el pasajero", r1 && r1.motivo === "Llegó tarde", r1);
  check("tarjeta: número, color y agrupación de la unidad", r1 && r1.numero === "45" && r1.color === "Rojo" && r1.grupo === "Alcones Alfa", r1);
  check("tarjeta: teléfono del chofer (solo panel del dueño)", r1 && r1.driverPhone === drvPhone, r1);
  check("tarjeta: horas del viaje", r1 && r1.arrivedMs === pidioMs + 14 * 60000 && r1.startedMs === pidioMs + 16 * 60000 && !!r1.completed_at && r1.canceled_at === null, r1);
  check("tarjeta: precio", r1 && r1.price === 25, r1);

  // 1b) Motivo inventado (no está en la lista de la app): no se enseña.
  const t6 = await waThread(`96688${stamp}`.slice(0, 10), "Pasajera", "x");
  await db.prepare("UPDATE whatsapp_contacts SET phone = ? WHERE id = (SELECT user_id FROM support_threads WHERE id = ?)").run(riderPhone, t6);
  await db.prepare("INSERT INTO support_messages (thread_id, sender, text) VALUES (?, 'usuario', ?)").run(t6, `viaje #${rideId}. Motivo: <b>hola</b>`);
  const r6 = (await post(`/admin/support/${t6}`, { adminPin: ADMIN })).data.ride;
  check("motivo fuera de la lista: no sale", r6 && r6.mine && r6.motivo === null, r6);

  // 2) Otro número dice el mismo viaje: NO se enseñan datos.
  const t2 = await waThread(otherPhone, "Otro", `queja del viaje #${rideId}`);
  const r2 = (await post(`/admin/support/${t2}`, { adminPin: ADMIN })).data.ride;
  check("otro número: avisa que no es suyo", r2 && r2.found && r2.mine === false, r2);
  check("otro número: sin datos del viaje", r2 && !r2.rider && !r2.driver && !r2.city && !r2.driverPhone && !r2.numero, r2);

  // 3) Viaje que no existe y plática sin número de viaje.
  const t3 = await waThread(`96655${stamp}`.slice(0, 10), "X", "viaje #999999999");
  const r3 = (await post(`/admin/support/${t3}`, { adminPin: ADMIN })).data.ride;
  check("viaje inexistente: found false", r3 && r3.found === false, r3);
  const t4 = await waThread(`96666${stamp}`.slice(0, 10), "Y", "hola, ¿cuánto cuesta?");
  const r4 = (await post(`/admin/support/${t4}`, { adminPin: ADMIN })).data.ride;
  check("sin número de viaje: sin tarjeta", r4 === null, r4);

  // 4) Queja vieja (más de 3 días): ya no sale la tarjeta.
  const t5 = await waThread(`96677${stamp}`.slice(0, 10), "Z", "hola de nuevo");
  await db.prepare("INSERT INTO support_messages (thread_id, sender, text, created_at) VALUES (?, 'usuario', ?, datetime('now', '-5 days'))").run(t5, `viaje #${rideId}`);
  const r5 = (await post(`/admin/support/${t5}`, { adminPin: ADMIN })).data.ride;
  check("queja de hace 5 días: sin tarjeta", r5 === null, r5);

  // 5) Sin PIN de admin no se abre.
  const sinPin = await post(`/admin/support/${t1}`, {});
  check("sin PIN de admin: rechazado", sinPin.status === 401 || sinPin.status === 403, sinPin.status);

  // Limpieza: que no queden pláticas "esperando" ni viajes de más en la copia.
  for (const t of [t1, t2, t3, t4, t5, t6]) {
    const th = await db.prepare("SELECT user_id FROM support_threads WHERE id = ?").get(t);
    await db.prepare("DELETE FROM support_messages WHERE thread_id = ?").run(t);
    await db.prepare("DELETE FROM support_threads WHERE id = ?").run(t);
    if (th) await db.prepare("DELETE FROM whatsapp_contacts WHERE id = ?").run(th.user_id);
  }
  await db.prepare("DELETE FROM rides WHERE id = ?").run(rideId);
  await db.prepare("DELETE FROM drivers WHERE id = ?").run(drv.id);

  console.log(`\n${fail ? "✗" : "✓"} ${pass} bien, ${fail} mal`);
  process.exit(fail ? 1 : 0);
}
main().catch((e) => { console.error("Error:", e); process.exit(1); });
