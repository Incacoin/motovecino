// Prueba de "Invita pasajeros" (23-nov-2026): el pasajero nuevo que se
// registra con el código de un chofer queda ligado a él; por cada 5 que
// completan 3 viajes, el chofer gana $20 de saldo a favor (una sola vez
// por tanda; reglas del 24-nov-2026). No cuentan pasajeros de prueba, ni sin viaje, ni el propio chofer.
//   BASE=http://localhost:3077 node tools/test-invita-pasajeros.js
const path = require("node:path");
process.loadEnvFile(path.join(__dirname, "..", ".env"));
const BASE = process.env.BASE || "http://localhost:3077";
if (!/^https?:\/\/(localhost|127\.0\.0\.1)[:/]/.test(BASE)) throw new Error("Esto solo se corre en localhost: " + BASE);
const ADMIN = process.env.ADMIN_PIN;
const db = require("../db");
const { checkRiderReferralReward, RIDER_REFERRAL } = require("../riderReferrals");

let pass = 0;
let fail = 0;
function check(label, cond, extra) {
  if (cond) pass++;
  else {
    fail++;
    console.log("✗", label, extra !== undefined ? JSON.stringify(extra).slice(0, 300) : "");
  }
}
let ipN = 1;
async function post(url, body, ip) {
  const res = await fetch(BASE + "/api" + url, { method: "POST", headers: { "Content-Type": "application/json", "X-Forwarded-For": ip || `10.78.0.${ipN++}` }, body: JSON.stringify(body) });
  let data = null;
  try { data = await res.json(); } catch {}
  return { status: res.status, data };
}
const stamp = String(Date.now()).slice(-6);
const tel = (p) => `${p}${stamp}`; // prefijo de 4 + stamp de 6 = 10
const A = { adminPin: ADMIN, adminZone: "ticul" };

async function main() {
  const driverIds = [];
  const phones = [];
  try {
    const d = await post("/admin/drivers", { ...A, name: `Chofer QR ${stamp}`, phone: tel("9610"), acceptedLegal: true, vehicleType: "moto", grupo: "Por su cuenta" });
    check("alta del chofer", d.status === 201, d);
    const driver = d.data;
    driverIds.push(driver.id);
    // El perfil le crea su código.
    const prof0 = await post("/drivers/profile", { phone: driver.phone, pin: driver.pin });
    const code = prof0.data?.invite?.code;
    check("el perfil trae código y estado de pasajeros", !!code && prof0.data?.invite?.riders?.perBatch === 5 && prof0.data.invite.riders.amount === 20, prof0.data?.invite);
    check("promoción activa", prof0.data?.invite?.riders?.active === true, prof0.data?.invite?.riders);

    // QR y página.
    const qr = await fetch(`${BASE}/api/qr/invita/${code}.svg`);
    const svg = await qr.text();
    check("QR sale en SVG", qr.status === 200 && /image\/svg\+xml/.test(qr.headers.get("content-type")) && svg.includes("<svg"), qr.status);
    check("QR con código raro → 400", (await fetch(`${BASE}/api/qr/invita/${encodeURIComponent("<x>")}.svg`)).status === 400);
    const pag = await fetch(`${BASE}/invita?c=${code}`, { redirect: "manual" });
    check("/invita lleva a invita.html con el código", pag.status === 302 && pag.headers.get("location") === `/invita.html?c=${code}`, pag.headers.get("location"));

    // Registro con código (minúsculas y espacios también sirven).
    const r1 = await post("/riders/register", { name: "Pasajero Uno", phone: tel("9620"), ref: ` ${code.toLowerCase()} ` });
    phones.push(tel("9620"));
    check("registro con código", r1.status === 201, r1);
    let row = await db.prepare("SELECT referred_by_driver_id, referred_at FROM riders WHERE phone = ?").get(tel("9620"));
    check("queda ligado al chofer", row?.referred_by_driver_id === driver.id && !!row.referred_at, row);

    const r2 = await post("/riders/register", { name: "Pasajero Dos", phone: tel("9621"), ref: "ZZZZZZ" });
    phones.push(tel("9621"));
    row = await db.prepare("SELECT referred_by_driver_id FROM riders WHERE phone = ?").get(tel("9621"));
    check("código que no existe: se registra igual, sin chofer", r2.status === 201 && row?.referred_by_driver_id == null, { r2, row });

    const r3 = await post("/riders/register", { name: "El Mismo", phone: driver.phone, ref: code });
    phones.push(driver.phone);
    row = await db.prepare("SELECT referred_by_driver_id FROM riders WHERE phone = ?").get(driver.phone);
    check("el chofer no se invita a sí mismo", r3.status === 201 && row?.referred_by_driver_id == null, { r3, row });

    const r4 = await post("/riders/register", { name: "Otra Vez", phone: tel("9620"), ref: code });
    check("teléfono que ya tiene cuenta: 409 (no se re-liga)", r4.status === 409, r4);

    // 9 más ligados directo en la base (el registro por HTTP ya se probó arriba).
    for (let i = 0; i < 9; i++) {
      const ph = tel(String(9700 + i));
      phones.push(ph);
      await db.prepare("INSERT INTO riders (phone, name, city, referred_by_driver_id, referred_at) VALUES (?, ?, 'ticul', ?, datetime('now'))").run(ph, `Invitado ${i}`, driver.id);
    }
    // Uno de prueba y uno sin viaje: no cuentan.
    const prueba = tel("9750");
    const sinViaje = tel("9751");
    const taxiBarato = tel("9752");
    const negocio = tel("9753");
    phones.push(prueba, sinViaje, taxiBarato, negocio);
    for (const ph of [taxiBarato, negocio]) {
      await db.prepare("INSERT INTO riders (phone, name, city, referred_by_driver_id, referred_at) VALUES (?, 'No cuenta', 'ticul', ?, datetime('now'))").run(ph, driver.id);
    }
    await db.prepare("INSERT INTO riders (phone, name, city, referred_by_driver_id, referred_at, es_prueba) VALUES (?, 'Prueba', 'ticul', ?, datetime('now'), 1)").run(prueba, driver.id);
    await db.prepare("INSERT INTO riders (phone, name, city, referred_by_driver_id, referred_at) VALUES (?, 'Sin viaje', 'ticul', ?, datetime('now'))").run(sinViaje, driver.id);

    const ride = (ph, status = "completado", tipo = "moto", precio = null, negocioId = null) =>
      db.prepare("INSERT INTO rides (rider_name, rider_phone, pickup_lat, pickup_lng, dest_lat, dest_lng, city, status, ride_type, agreed_price, business_id, created_at, updated_at) VALUES ('x', ?, 20.39528, -89.53389, 20.40, -89.53, 'ticul', ?, ?, ?, ?, datetime('now'), datetime('now'))").run(ph, status, tipo, precio, negocioId);
    const tres = async (ph, ...args) => { for (let k = 0; k < 3; k++) await ride(ph, ...args); };
    // 9 con sus 3 viajes (el de prueba también, pero no cuenta).
    for (const ph of [tel("9620"), ...phones.filter((p) => /^970\d/.test(p)).slice(0, 8), prueba]) await tres(ph);
    // El último invitado lleva 2 viajes: va «a medio camino», todavía no cuenta.
    await ride(tel("9708"));
    await ride(tel("9708"));
    await ride(sinViaje, "cancelado");
    // Taxi de $10 deja $0.60 de comisión (< $2): no cuenta. Envío de negocio tampoco.
    await tres(taxiBarato, "completado", "taxi", 10);
    await tres(negocio, "completado", "moto", null, 999999);

    check("con 9 ya ganó 1 tanda (cada 5)", (await checkRiderReferralReward(db, driver.id)) === 1);
    let prof = (await post("/drivers/profile", { phone: driver.phone, pin: driver.pin })).data;
    check("perfil: 9 → 4 de 5 y 1 a medio camino", prof?.invite?.riders?.qualified === 9 && prof.invite.riders.inBatch === 4 && prof.invite.riders.started === 1 && prof.invite.riders.rewards === 1 && prof.invite.riders.ridesRequired === 3, prof?.invite?.riders);
    check("perfil: registrados no cuenta al de prueba", prof?.invite?.riders?.registered === 13, prof?.invite?.riders);

    // El tercer viaje del último: un taxi de $40 deja $2.40 de comisión, ese sí cuenta.
    await ride(tel("9708"), "completado", "taxi", 40);
    await ride(tel("9708")); // un cuarto viaje no lo cuenta doble
    check("con 10 gana la 2ª tanda", (await checkRiderReferralReward(db, driver.id)) === 1);
    check("revisar otra vez no paga doble", (await checkRiderReferralReward(db, driver.id)) === 0);
    const credits = await db.prepare("SELECT amount, reason FROM driver_credits WHERE driver_id = ?").all(driver.id);
    check("saldo a favor: 2 × $20", credits.length === 2 && credits.every((c) => c.amount === 20 && c.reason === "pasajeros") && RIDER_REFERRAL.AMOUNT === 20 && RIDER_REFERRAL.PER_BATCH === 5, credits);
    prof = (await post("/drivers/profile", { phone: driver.phone, pin: driver.pin })).data;
    check("perfil: saldo $40 y contador regresa a 0", prof?.creditBalance === 40 && prof.invite.riders.inBatch === 0 && prof.invite.riders.rewards === 2 && prof.invite.riders.earnedTotal === 40, { c: prof?.creditBalance, r: prof?.invite?.riders });

    // Chofer de prueba no gana.
    await db.prepare("UPDATE drivers SET es_prueba = 1 WHERE id = ?").run(driver.id);
    await db.prepare("DELETE FROM driver_credits WHERE driver_id = ?").run(driver.id);
    await db.prepare("DELETE FROM rider_referral_rewards WHERE driver_id = ?").run(driver.id);
    check("chofer de prueba no gana", (await checkRiderReferralReward(db, driver.id)) === 0);
  } finally {
    for (const id of driverIds) {
      await db.prepare("DELETE FROM driver_credits WHERE driver_id = ?").run(id);
      await db.prepare("DELETE FROM rider_referral_rewards WHERE driver_id = ?").run(id);
    }
    for (const ph of phones) {
      await db.prepare("DELETE FROM rides WHERE rider_phone = ?").run(ph);
      await db.prepare("DELETE FROM riders WHERE phone = ?").run(ph);
    }
    for (const id of driverIds) await post(`/admin/drivers/${id}/delete`, A);
  }
  console.log(`invita-pasajeros: ${pass} bien, ${fail} mal`);
  process.exit(fail ? 1 : 0);
}
main().catch((e) => { console.error(e); process.exit(1); });
