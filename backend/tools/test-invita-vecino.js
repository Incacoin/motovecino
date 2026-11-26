// Prueba de "Invita a tu vecino" (25-nov-2026), 1ª parte: cada pasajero tiene
// su código de 7 letras; el vecino que se registra con él queda ligado al
// pasajero (no a un chofer); cuenta cuando completa 3 viajes que dejan cuota;
// cada 5 que cuentan = 1 viaje cortesía. 2ª parte: el pasajero lo usa al pedir
// mototaxi (use_courtesy), se aparta una sola vez (si cancela, vuelve), y al
// terminar el chofer recibe hasta $15 de saldo a favor, una sola vez.
//   BASE=http://localhost:3077 node tools/test-invita-vecino.js
const path = require("node:path");
process.loadEnvFile(path.join(__dirname, "..", ".env"));
const BASE = process.env.BASE || "http://localhost:3077";
if (!/^https?:\/\/(localhost|127\.0\.0\.1)[:/]/.test(BASE)) throw new Error("Esto solo se corre en localhost: " + BASE);
const db = require("../db");
const { RIDER_FRIEND, payCourtesy } = require("../riderReferrals");
const TICUL = { lat: 20.39528, lng: -89.53389 };

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
  const res = await fetch(BASE + "/api" + url, { method: "POST", headers: { "Content-Type": "application/json", "X-Forwarded-For": ip || `10.79.0.${ipN++}` }, body: JSON.stringify(body) });
  let data = null;
  try { data = await res.json(); } catch {}
  return { status: res.status, data };
}
const stamp = String(Date.now()).slice(-6);
const tel = (p) => `${p}${stamp}`;

async function main() {
  const phones = [];
  const driverIds = [];
  let meId = null;
  try {
    // La que invita.
    const a = await post("/riders/register", { name: "Vecina Invita", phone: tel("9630") });
    phones.push(tel("9630"));
    check("alta de la que invita", a.status === 201, a);
    const me = a.data;
    meId = me.id;
    const st0 = await post(`/riders/${me.id}/invite-status`, { phone: me.phone, pin: me.pin });
    const code = st0.data?.code;
    check("estado trae código de 7 letras", st0.status === 200 && /^[A-Z0-9]{7}$/.test(code || ""), st0);
    check("reglas: 5 vecinos × 3 viajes, cortesía hasta $15, activa", st0.data?.perBatch === 5 && st0.data.ridesRequired === 3 && st0.data.courtesyMax === 15 && st0.data.active === true, st0.data);
    const st0b = await post(`/riders/${me.id}/invite-status`, { phone: me.phone, pin: me.pin });
    check("el código no cambia al volver a pedirlo", st0b.data?.code === code, st0b.data);
    check("PIN malo → 404", (await post(`/riders/${me.id}/invite-status`, { phone: me.phone, pin: "000000" })).status === 404);
    check("/riders/invite reconoce su código", (await fetch(`${BASE}/api/riders/invite/${code}`)).status === 200);
    check("/drivers/invite NO acepta código de vecino", (await fetch(`${BASE}/api/drivers/invite/${code}`)).status === 404);
    check("/riders/invite con código raro: 404", (await fetch(`${BASE}/api/riders/invite/ZZZZZZZ`)).status === 404);
    const qr = await fetch(`${BASE}/api/qr/invita/${code}.svg`);
    check("su QR sale", qr.status === 200 && (await qr.text()).includes("<svg"), qr.status);

    // Vecino que se registra con el código (minúsculas y espacios sirven).
    const v1 = await post("/riders/register", { name: "Vecino Uno", phone: tel("9640"), ref: ` ${code.toLowerCase()} ` });
    phones.push(tel("9640"));
    check("registro con código de pasajero", v1.status === 201, v1);
    let row = await db.prepare("SELECT referred_by_rider_id, referred_by_driver_id, referred_at FROM riders WHERE phone = ?").get(tel("9640"));
    check("queda ligado a la vecina (no a un chofer)", row?.referred_by_rider_id === me.id && row.referred_by_driver_id == null && !!row.referred_at, row);

    // Ella misma no se invita.
    const self = await db.prepare("SELECT phone FROM riders WHERE id = ?").get(me.id);
    check("el teléfono es el suyo", self.phone === me.phone);
    const r409 = await post("/riders/register", { name: "Otra", phone: me.phone, ref: code });
    check("cuenta que ya existe: 409", r409.status === 409, r409);

    // Código de 7 que no existe: se registra igual, sin nadie.
    const v2 = await post("/riders/register", { name: "Vecino Dos", phone: tel("9641"), ref: "ZZZZZZZ" });
    phones.push(tel("9641"));
    row = await db.prepare("SELECT referred_by_rider_id, referred_by_driver_id FROM riders WHERE phone = ?").get(tel("9641"));
    check("código inexistente: sin ligar", v2.status === 201 && row?.referred_by_rider_id == null && row.referred_by_driver_id == null, row);

    // 4 más ligados directo + uno de prueba + uno con 2 viajes.
    const vecinos = [tel("9640")];
    for (let i = 0; i < 4; i++) {
      const ph = tel(String(9650 + i));
      phones.push(ph);
      vecinos.push(ph);
      await db.prepare("INSERT INTO riders (phone, name, city, referred_by_rider_id, referred_at) VALUES (?, ?, 'ticul', ?, datetime('now'))").run(ph, `Vecino ${i}`, me.id);
    }
    const prueba = tel("9660");
    const aMedias = tel("9661");
    phones.push(prueba, aMedias);
    await db.prepare("INSERT INTO riders (phone, name, city, referred_by_rider_id, referred_at, es_prueba) VALUES (?, 'Prueba', 'ticul', ?, datetime('now'), 1)").run(prueba, me.id);
    await db.prepare("INSERT INTO riders (phone, name, city, referred_by_rider_id, referred_at) VALUES (?, 'A medias', 'ticul', ?, datetime('now'))").run(aMedias, me.id);

    const ride = (ph, tipo = "moto", precio = null) =>
      db.prepare("INSERT INTO rides (rider_name, rider_phone, pickup_lat, pickup_lng, dest_lat, dest_lng, city, status, ride_type, agreed_price, created_at, updated_at) VALUES ('x', ?, 20.39528, -89.53389, 20.40, -89.53, 'ticul', 'completado', ?, ?, datetime('now'), datetime('now'))").run(ph, tipo, precio);
    const tres = async (ph) => { for (let k = 0; k < 3; k++) await ride(ph); };
    for (const ph of vecinos.slice(0, 4)) await tres(ph);
    await tres(prueba);
    await ride(aMedias);
    await ride(aMedias);

    let st = (await post(`/riders/${me.id}/invite-status`, { phone: me.phone, pin: me.pin })).data;
    check("4 de 5, 1 a medio camino, sin cortesía", st?.qualified === 4 && st.inBatch === 4 && st.started === 1 && st.courtesiesEarned === 0, st);
    check("registrados no cuenta al de prueba", st?.registered === 6, st);

    await tres(vecinos[4]);
    st = (await post(`/riders/${me.id}/invite-status`, { phone: me.phone, pin: me.pin })).data;
    check("con 5 gana 1 viaje cortesía y el contador regresa a 0", st?.qualified === 5 && st.inBatch === 0 && st.courtesiesEarned === 1, st);
    // El viaje cortesía (lo paga MotoVecino) no cuenta como viaje para premios.
    const v5 = vecinos[4];
    await db.prepare("UPDATE rides SET courtesy_max = 15 WHERE id = (SELECT id FROM rides WHERE rider_phone = ? ORDER BY id DESC LIMIT 1)").run(v5);
    let stc = (await post(`/riders/${me.id}/invite-status`, { phone: me.phone, pin: me.pin })).data;
    check("viaje cortesía no cuenta: vuelve a 4 de 5", stc?.qualified === 4, stc);
    await db.prepare("UPDATE rides SET courtesy_max = NULL WHERE rider_phone = ?").run(v5);

    check("constante del premio", RIDER_FRIEND.COURTESY_MAX === 15 && RIDER_FRIEND.PER_BATCH === 5);
    check("tiene 1 viaje cortesía libre", st?.available === 1, st);
    const st1b = (await post(`/riders/${me.id}/invite-status`, { phone: me.phone, pin: me.pin })).data;
    check("volver a ver no da otra cortesía", st1b?.available === 1 && Number((await db.prepare("SELECT COUNT(*) AS n FROM rider_friend_rewards WHERE rider_id = ?").get(me.id)).n) === 1, st1b);

    // ---- Usar el viaje cortesía ----
    const R = { rider_phone: me.phone, rider_pin: me.pin };
    const pedir = (extra) => post("/rides", { ...R, pickup_lat: TICUL.lat, pickup_lng: TICUL.lng, dest_lat: TICUL.lat + 0.008, dest_lng: TICUL.lng, ride_type: "moto", offer_price: 25, ...extra });
    const cancelar = (id) => post(`/rides/${id}/cancel`, { riderPhone: me.phone, riderPin: me.pin });
    const sin = await pedir({});
    check("pedir sin marcar: sin cortesía", sin.status === 201 && sin.data?.courtesy_max == null, sin);
    await cancelar(sin.data?.id);
    const c1 = await pedir({ use_courtesy: true });
    check("pedir con cortesía: queda apartada ($15)", c1.status === 201 && c1.data?.courtesy_max === 15, c1);
    st = (await post(`/riders/${me.id}/invite-status`, { phone: me.phone, pin: me.pin })).data;
    check("ya no le queda libre", st?.available === 0, st);
    await cancelar(c1.data?.id);
    st = (await post(`/riders/${me.id}/invite-status`, { phone: me.phone, pin: me.pin })).data;
    check("si cancela, la cortesía regresa", st?.available === 1, st);
    // Si el viaje ya había empezado y se cancela, la cortesía NO regresa.
    const cm = await pedir({ use_courtesy: true });
    check("apartada otra vez", cm.data?.courtesy_max === 15, cm);
    await db.prepare("UPDATE rides SET status = 'cancelado', started_at_ms = ? WHERE id = ?").run(Date.now(), cm.data?.id);
    st = (await post(`/riders/${me.id}/invite-status`, { phone: me.phone, pin: me.pin })).data;
    check("cancelado a medio viaje: no regresa", st?.available === 0, st);
    // Le damos otra para seguir la prueba.
    await db.prepare("INSERT INTO rider_friend_rewards (rider_id, batch_no) VALUES (?, 2)").run(me.id);
    const c2 = await pedir({ use_courtesy: true });
    check("la vuelve a usar", c2.status === 201 && c2.data?.courtesy_max === 15, c2);
    const otra = await post("/rides", { rider_phone: tel("9640"), rider_pin: v1.data?.pin, pickup_lat: TICUL.lat, pickup_lng: TICUL.lng, dest_lat: TICUL.lat + 0.008, dest_lng: TICUL.lng, ride_type: "moto", offer_price: 25, use_courtesy: true });
    check("otro pasajero sin cortesía: sale normal", otra.status === 201 && otra.data?.courtesy_max == null, otra);
    if (otra.data?.id) await post(`/rides/${otra.data.id}/cancel`, { riderPhone: tel("9640"), riderPin: v1.data?.pin });

    // El chofer la lleva y termina.
    const d = await post("/admin/drivers", { adminPin: process.env.ADMIN_PIN, adminZone: "ticul", name: `Chofer Cortesia ${stamp}`, phone: tel("9670"), acceptedLegal: true, vehicleType: "moto", grupo: "Por su cuenta" });
    check("alta chofer", d.status === 201, d);
    driverIds.push(d.data?.id);
    await db.prepare("UPDATE rides SET driver_id = ?, status = 'en_curso', agreed_price = 25 WHERE id = ?").run(d.data?.id, c2.data?.id);
    const fin = await post(`/rides/${c2.data?.id}/complete`, { driverId: d.data?.id, pin: d.data?.pin });
    check("termina el viaje", fin.status === 200, fin);
    let cred = await db.prepare("SELECT amount, reason, courtesy_ride_id FROM driver_credits WHERE driver_id = ?").all(d.data?.id);
    check("al terminar NO se paga solo (queda por pagar)", cred.length === 0, cred);
    const rideRow = await db.prepare("SELECT courtesy_amount FROM rides WHERE id = ?").get(c2.data?.id);
    check("el viaje anota lo cubierto", rideRow?.courtesy_amount === 15, rideRow);
    check("terminar otra vez: 409", (await post(`/rides/${c2.data?.id}/complete`, { driverId: d.data?.id, pin: d.data?.pin })).status === 409);
    check("anotar otra vez no cambia nada", (await payCourtesy(db, c2.data?.id)) === 0);
    const myTrips0 = Number((await db.prepare("SELECT COUNT(*) AS n FROM rides WHERE rider_id = ? AND status = 'completado'").get(me.id)).n);
    const delPend = await post(`/admin/riders/${me.id}/delete`, { adminPin: process.env.ADMIN_PIN, adminZone: "ticul", forceDeleteConfirmedTestTrips: myTrips0 });
    check("no se borra pasajera con cortesía sin pagar al chofer", delPend.status === 409 && /cortesía/.test(delPend.data?.error || ""), delPend);

    // ---- El chofer elige al terminar: efectivo ----
    const D = { driverId: d.data?.id, pin: d.data?.pin };
    check("pendientes con PIN malo: 401", (await post("/courtesy/pending", { ...D, pin: "0000" })).status === 401);
    let pend = (await post("/courtesy/pending", D)).data;
    check("al chofer le sale para elegir ($15)", pend?.rides?.length === 1 && pend.rides[0].id === c2.data?.id && pend.rides[0].amount === 15, pend);
    const d2 = await post("/admin/drivers", { adminPin: process.env.ADMIN_PIN, adminZone: "ticul", name: `Chofer Otro ${stamp}`, phone: tel("9671"), acceptedLegal: true, vehicleType: "moto", grupo: "Por su cuenta" });
    driverIds.push(d2.data?.id);
    check("otro chofer no ve ese viaje", ((await post("/courtesy/pending", { driverId: d2.data?.id, pin: d2.data?.pin })).data?.rides || []).length === 0);
    check("otro chofer no lo puede elegir", (await post(`/courtesy/${c2.data?.id}/choose`, { driverId: d2.data?.id, pin: d2.data?.pin, how: "saldo" })).status === 409);
    check("elección rara: no", (await post(`/courtesy/${c2.data?.id}/choose`, { ...D, how: "regalo" })).status === 409);
    check("elige efectivo", (await post(`/courtesy/${c2.data?.id}/choose`, { ...D, how: "efectivo" })).status === 200);
    check("ya no le vuelve a preguntar", ((await post("/courtesy/pending", D)).data?.rides || []).length === 0);
    check("después ya no lo cambia a saldo", (await post(`/courtesy/${c2.data?.id}/choose`, { ...D, how: "saldo" })).status === 409);
    check("efectivo: sin saldo todavía", Number((await db.prepare("SELECT COUNT(*) AS n FROM driver_credits WHERE driver_id = ?").get(d.data?.id)).n) === 0);

    // ---- Oficina: lista y pago ----
    const A = { adminPin: process.env.ADMIN_PIN, adminZone: "ticul" };
    let lista = (await post("/admin/courtesies/list", A)).data;
    let fila = Array.isArray(lista) && lista.find((x) => x.id === c2.data?.id);
    check("sale en «por pagar» del admin con $15 y el chofer", fila && fila.courtesy_amount === 15 && !fila.courtesy_paid_how && /Cortesia/.test(fila.driver_name || ""), lista);
    check("el admin ve que pidió efectivo", fila?.courtesy_choice === "efectivo", fila);
    check("admin de otra zona no lo ve", !((await post("/admin/courtesies/list", { ...A, adminZone: "tekax" })).data || []).some((x) => x.id === c2.data?.id));
    check("admin de otra zona no lo paga", (await post(`/admin/courtesies/${c2.data?.id}/pay`, { ...A, adminZone: "tekax", how: "efectivo" })).status === 404);
    check("forma de pago rara: no", (await post(`/admin/courtesies/${c2.data?.id}/pay`, { ...A, how: "regalo" })).status === 409);
    check("pagar en efectivo", (await post(`/admin/courtesies/${c2.data?.id}/pay`, { ...A, how: "efectivo" })).status === 200);
    check("no se paga dos veces", (await post(`/admin/courtesies/${c2.data?.id}/pay`, { ...A, how: "saldo" })).status === 409);
    cred = await db.prepare("SELECT COUNT(*) AS n FROM driver_credits WHERE driver_id = ?").get(d.data?.id);
    check("efectivo: no le pone saldo", Number(cred.n) === 0, cred);
    lista = (await post("/admin/courtesies/list", A)).data;
    fila = lista.find((x) => x.id === c2.data?.id);
    check("queda «Pagado en efectivo»", fila?.courtesy_paid_how === "efectivo" && !!fila.courtesy_paid_at, fila);
    check("fecha límite de uso", RIDER_FRIEND.USE_END === "2027-04-30" && st?.useEnd === "2027-04-30", st);
    st = (await post(`/riders/${me.id}/invite-status`, { phone: me.phone, pin: me.pin })).data;
    check("ya usada: 0 libres", st?.available === 0, st);
    const c3 = await pedir({ use_courtesy: true });
    check("sin cortesía libre: el viaje sale normal", c3.status === 201 && c3.data?.courtesy_max == null, c3);
    if (c3.data?.id) await cancelar(c3.data.id);

    // Viaje barato ($12): cubre solo $12.
    await db.prepare("INSERT INTO rides (rider_name, rider_phone, pickup_lat, pickup_lng, city, status, ride_type, agreed_price, courtesy_max, driver_id, created_at, updated_at) VALUES ('x', ?, 20.39, -89.53, 'ticul', 'completado', 'moto', 12, 15, ?, datetime('now'), datetime('now'))").run(me.phone, d.data?.id);
    const barato = await db.prepare("SELECT id FROM rides WHERE rider_phone = ? AND agreed_price = 12").get(me.phone);
    check("viaje de $12: cubre $12", (await payCourtesy(db, barato.id)) === 12);
    check("pasar a su saldo", (await post(`/admin/courtesies/${barato.id}/pay`, { ...A, how: "saldo" })).status === 200);
    cred = await db.prepare("SELECT amount, reason, courtesy_ride_id FROM driver_credits WHERE driver_id = ?").all(d.data?.id);
    check("saldo: le pone $12 de saldo a favor", cred.length === 1 && cred[0].amount === 12 && cred[0].reason === "cortesia" && cred[0].courtesy_ride_id === barato.id, cred);
    check("saldo: no se paga dos veces", (await post(`/admin/courtesies/${barato.id}/pay`, { ...A, how: "efectivo" })).status === 409);
    check("ya pagado por el admin: al chofer no le pregunta", ((await post("/courtesy/pending", D)).data?.rides || []).length === 0);

    // ---- El chofer elige saldo: se le pone al instante ----
    await db.prepare("INSERT INTO rides (rider_name, rider_phone, pickup_lat, pickup_lng, city, status, ride_type, agreed_price, courtesy_max, driver_id, created_at, updated_at) VALUES ('x', ?, 20.39, -89.53, 'ticul', 'completado', 'moto', 18, 15, ?, datetime('now'), datetime('now'))").run(me.phone, d.data?.id);
    const r18 = await db.prepare("SELECT id FROM rides WHERE rider_phone = ? AND agreed_price = 18").get(me.phone);
    check("viaje de $18: cubre $15", (await payCourtesy(db, r18.id)) === 15);
    check("elige saldo", (await post(`/courtesy/${r18.id}/choose`, { ...D, how: "saldo" })).status === 200);
    cred = await db.prepare("SELECT amount FROM driver_credits WHERE driver_id = ? AND courtesy_ride_id = ?").all(d.data?.id, r18.id);
    check("saldo al instante: $15", cred.length === 1 && cred[0].amount === 15, cred);
    check("elegir otra vez: 409", (await post(`/courtesy/${r18.id}/choose`, { ...D, how: "saldo" })).status === 409);
    check("el admin ya no lo puede pagar en efectivo", (await post(`/admin/courtesies/${r18.id}/pay`, { ...A, how: "efectivo" })).status === 409);
    fila = (await post("/admin/courtesies/list", A)).data.find((x) => x.id === r18.id);
    check("admin lo ve como «el chofer lo pasó a su saldo»", fila?.courtesy_paid_how === "saldo" && fila.courtesy_choice === "saldo", fila);

    // El admin puede borrar a una pasajera que ya ganó cortesías (no truena).
    const myTrips = Number((await db.prepare("SELECT COUNT(*) AS n FROM rides WHERE rider_id = ? AND status = 'completado'").get(me.id)).n);
    const del = await post(`/admin/riders/${me.id}/delete`, { adminPin: process.env.ADMIN_PIN, adminZone: "ticul", forceDeleteConfirmedTestTrips: myTrips });
    check("admin borra pasajera con cortesías", del.status === 200, del);
    const huerf = await db.prepare("SELECT COUNT(*) AS n FROM riders WHERE referred_by_rider_id = ?").get(me.id);
    check("sus invitados quedan sin lazo", Number(huerf.n) === 0, huerf);

    // Los vecinos invitados por pasajero NO le cuentan a ningún chofer.
    const anyDriver = await db.prepare("SELECT COUNT(*) AS n FROM riders WHERE referred_by_rider_id = ? AND referred_by_driver_id IS NOT NULL").get(me.id);
    check("ninguno quedó ligado también a un chofer", Number(anyDriver.n) === 0, anyDriver);
  } finally {
    for (const id of driverIds) if (id) await db.prepare("DELETE FROM driver_credits WHERE driver_id = ?").run(id);
    if (meId) await db.prepare("DELETE FROM rider_friend_rewards WHERE rider_id = ?").run(meId);
    for (const ph of phones) {
      await db.prepare("DELETE FROM rides WHERE rider_phone = ?").run(ph);
      await db.prepare("DELETE FROM riders WHERE phone = ?").run(ph);
    }
  }
  for (const id of driverIds) if (id) await post(`/admin/drivers/${id}/delete`, { adminPin: process.env.ADMIN_PIN, adminZone: "ticul" });
  console.log(`invita-vecino: ${pass} bien, ${fail} mal`);
  process.exit(fail ? 1 : 0);
}
main().catch((e) => { console.error(e); process.exit(1); });
