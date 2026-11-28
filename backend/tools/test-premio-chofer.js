// Prueba de "Invita a otro chofer" con las reglas del 28-nov-2026: cuando el
// chofer invitado completa 3 viajes con 3 pasajeros distintos, SOLO el que
// invitó gana $20 de saldo a favor (el invitado ya no gana). No cuentan los
// viajes pedidos desde el teléfono del que invitó ni se paga dos veces.
//   BASE=http://localhost:3077 node tools/test-premio-chofer.js
const path = require("node:path");
process.loadEnvFile(path.join(__dirname, "..", ".env"));
const BASE = process.env.BASE || "http://localhost:3077";
if (!/^https?:\/\/(localhost|127\.0\.0\.1)[:/]/.test(BASE)) throw new Error("Esto solo se corre en localhost: " + BASE);
const ADMIN = process.env.ADMIN_PIN;
const db = require("../db");
const { checkReferralReward, REFERRAL } = require("../referrals");

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
async function post(url, body) {
  const res = await fetch(BASE + "/api" + url, { method: "POST", headers: { "Content-Type": "application/json", "X-Forwarded-For": `10.79.0.${ipN++}` }, body: JSON.stringify(body) });
  let data = null;
  try { data = await res.json(); } catch {}
  return { status: res.status, data };
}
const stamp = String(Date.now()).slice(-6);
const tel = (p) => `${p}${stamp}`;
const A = { adminPin: ADMIN, adminZone: "ticul" };

async function main() {
  const driverIds = [];
  const riderPhones = [];
  try {
    check("reglas: 3 viajes, 3 pasajeros, $20 solo al que invita",
      REFERRAL.REQUIRED_TRIPS === 3 && REFERRAL.REQUIRED_RIDERS === 3 && REFERRAL.REWARD_AMOUNT === 20 && REFERRAL.INVITEE_AMOUNT === 0, REFERRAL);

    const inv = await post("/admin/drivers", { ...A, name: `Invita ${stamp}`, phone: tel("9530"), acceptedLegal: true, vehicleType: "moto", grupo: "Por su cuenta" });
    check("alta del que invita", inv.status === 201, inv);
    const inviter = inv.data;
    driverIds.push(inviter.id);
    const d = await post("/admin/drivers", { ...A, name: `Nuevo ${stamp}`, phone: tel("9531"), acceptedLegal: true, vehicleType: "moto", grupo: "Por su cuenta", referredByDriverId: inviter.id });
    check("alta del invitado", d.status === 201, d);
    const invitee = d.data;
    driverIds.push(invitee.id);
    const row = await db.prepare("SELECT referred_by_driver_id FROM drivers WHERE id = ?").get(invitee.id);
    check("invitado ligado al que invita", row?.referred_by_driver_id === inviter.id, row);

    const ride = (ph) =>
      db.prepare("INSERT INTO rides (rider_name, rider_phone, pickup_lat, pickup_lng, dest_lat, dest_lng, city, status, ride_type, driver_id, created_at, updated_at) VALUES ('x', ?, 20.39528, -89.53389, 20.40, -89.53, 'ticul', 'completado', 'moto', ?, datetime('now'), datetime('now'))").run(ph, invitee.id);
    const p1 = tel("9540"), p2 = tel("9541"), p3 = tel("9542");
    riderPhones.push(p1, p2, p3, inviter.phone);

    await ride(p1);
    await ride(p2);
    check("2 viajes: todavía no gana", (await checkReferralReward(db, invitee.id)) === null);
    await ride(p2);
    check("3 viajes pero solo 2 pasajeros distintos: no gana", (await checkReferralReward(db, invitee.id)) === null);
    await ride(inviter.phone);
    check("viaje pedido desde el teléfono del que invita no cuenta", (await checkReferralReward(db, invitee.id)) === null);

    let prof = (await post("/drivers/profile", { phone: inviter.phone, pin: inviter.pin })).data;
    const promo = prof?.invite?.promo;
    check("perfil: promoción con 3 viajes y 3 pasajeros", promo?.active === true && promo.trips === 3 && promo.riders === 3 && promo.amount === 20, promo);
    const mio = (prof?.invite?.invitees || [])[0];
    check("perfil: el invitado va en 3 viajes y 2 pasajeros", mio && mio.trips === 3 && mio.riders === 2 && !mio.rewarded, mio);

    await ride(p3);
    const r = await checkReferralReward(db, invitee.id);
    check("3er pasajero distinto: gana el que invita", r && r.inviterId === inviter.id && r.inviterAmount === 20, r);
    check("revisar otra vez no paga doble", (await checkReferralReward(db, invitee.id)) === null);

    const cInviter = await db.prepare("SELECT amount, reason FROM driver_credits WHERE driver_id = ?").all(inviter.id);
    const cInvitee = await db.prepare("SELECT amount FROM driver_credits WHERE driver_id = ?").all(invitee.id);
    check("saldo a favor: $20 al que invita", cInviter.length === 1 && cInviter[0].amount === 20 && cInviter[0].reason === "invito", cInviter);
    check("el invitado ya no recibe saldo", cInvitee.length === 0, cInvitee);
    const rw = await db.prepare("SELECT inviter_amount, invitee_amount FROM referral_rewards WHERE invitee_id = ?").get(invitee.id);
    check("premio anotado: 20 y 0", rw?.inviter_amount === 20 && rw.invitee_amount === 0, rw);

    prof = (await post("/drivers/profile", { phone: inviter.phone, pin: inviter.pin })).data;
    const mio2 = (prof?.invite?.invitees || [])[0];
    check("perfil del que invita: saldo $20 y su invitado marcado", prof?.creditBalance === 20 && mio2?.rewarded === true && mio2.myAmount === 20, { c: prof?.creditBalance, mio2 });
    const prof2 = (await post("/drivers/profile", { phone: invitee.phone, pin: invitee.pin })).data;
    check("perfil del invitado: sin saldo", (prof2?.creditBalance || 0) === 0, prof2?.creditBalance);
  } finally {
    for (const id of driverIds) {
      await db.prepare("DELETE FROM driver_credits WHERE driver_id = ?").run(id);
      await db.prepare("DELETE FROM referral_rewards WHERE inviter_id = ? OR invitee_id = ?").run(id, id);
      await db.prepare("DELETE FROM rides WHERE driver_id = ?").run(id);
    }
    for (const id of driverIds.slice().reverse()) await post(`/admin/drivers/${id}/delete`, A);
  }
  console.log(`premio-chofer: ${pass} bien, ${fail} mal`);
  process.exit(fail ? 1 : 0);
}
main().catch((e) => { console.error(e); process.exit(1); });
