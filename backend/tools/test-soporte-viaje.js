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
  const drv = await db.prepare("SELECT id, name FROM drivers WHERE deleted_at IS NULL ORDER BY id LIMIT 1").get();
  const ride = await db.prepare(
    "INSERT INTO rides (rider_name, rider_phone, pickup_lat, pickup_lng, dest_lat, dest_lng, city, status, driver_id, created_at, updated_at) VALUES (?, ?, 20.39528, -89.53389, 20.40, -89.53, 'ticul', 'completado', ?, datetime('now'), datetime('now'))"
  ).run("Pasajera Queja", riderPhone, drv ? drv.id : null);
  const rideId = ride.lastInsertRowid;

  // 1) Escribe el mismo pasajero del viaje: se ve la tarjeta completa.
  const t1 = await waThread(riderPhone, "Pasajera", `Hola, quiero dejar una queja o sugerencia sobre mi viaje en MotoVecino Ticul (viaje #${rideId}): llegó tarde`);
  const v1 = await post(`/admin/support/${t1}`, { adminPin: ADMIN });
  const r1 = v1.data && v1.data.ride;
  check("panel abre la plática", v1.status === 200, v1);
  check("tarjeta: viaje correcto y es de este número", r1 && r1.id === Number(rideId) && r1.found && r1.mine, r1);
  check("tarjeta: municipio del VIAJE (Ticul)", r1 && r1.city === "Ticul", r1);
  check("tarjeta: pasajero, estado y vehículo", r1 && r1.rider === "Pasajera Queja" && r1.status === "Completado" && r1.vehicle === "mototaxi", r1);
  check("tarjeta: chofer", r1 && (drv ? r1.driver === drv.name : r1.driver === null), r1);
  check("tarjeta: sin teléfonos ni ubicación", r1 && !JSON.stringify(r1).includes(riderPhone) && !("pickup_lat" in r1) && !("rider_phone" in r1), r1);

  // 2) Otro número dice el mismo viaje: NO se enseñan datos.
  const t2 = await waThread(otherPhone, "Otro", `queja del viaje #${rideId}`);
  const r2 = (await post(`/admin/support/${t2}`, { adminPin: ADMIN })).data.ride;
  check("otro número: avisa que no es suyo", r2 && r2.found && r2.mine === false, r2);
  check("otro número: sin datos del viaje", r2 && !r2.rider && !r2.driver && !r2.city, r2);

  // 3) Viaje que no existe y plática sin número de viaje.
  const t3 = await waThread(`96655${stamp}`.slice(0, 10), "X", "viaje #999999999");
  const r3 = (await post(`/admin/support/${t3}`, { adminPin: ADMIN })).data.ride;
  check("viaje inexistente: found false", r3 && r3.found === false, r3);
  const t4 = await waThread(`96666${stamp}`.slice(0, 10), "Y", "hola, ¿cuánto cuesta?");
  const r4 = (await post(`/admin/support/${t4}`, { adminPin: ADMIN })).data.ride;
  check("sin número de viaje: sin tarjeta", r4 === null, r4);

  // 4) Sin PIN de admin no se abre.
  const sinPin = await post(`/admin/support/${t1}`, {});
  check("sin PIN de admin: rechazado", sinPin.status === 401 || sinPin.status === 403, sinPin.status);

  console.log(`\n${fail ? "✗" : "✓"} ${pass} bien, ${fail} mal`);
  process.exit(fail ? 1 : 0);
}
main().catch((e) => { console.error("Error:", e); process.exit(1); });
