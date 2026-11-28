// Prueba de Promotores (27-nov-2026): el admin da de alta un promotor (código
// de 5 letras), el pasajero nuevo que se registra con ese código queda ligado
// a él, y cuenta cuando completa 3 viajes que dejan cuota. «Pagar» marca a
// esos pasajeros una sola vez (dos clics no pagan doble). Un admin de otro
// municipio no ve ni toca al promotor. Pausado, su código ya no liga a nadie.
//   BASE=http://localhost:3077 node tools/test-promotores.js
const path = require("node:path");
process.loadEnvFile(path.join(__dirname, "..", ".env"));
const BASE = process.env.BASE || "http://localhost:3077";
if (!/^https?:\/\/(localhost|127\.0\.0\.1)[:/]/.test(BASE)) throw new Error("Esto solo se corre en localhost: " + BASE);
const ADMIN = process.env.ADMIN_PIN;
const db = require("../db");

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
const TI = { adminPin: ADMIN, adminZone: "ticul" };
const TK = { adminPin: ADMIN, adminZone: "tekax" };

async function main() {
  const promoterIds = [];
  const phones = [];
  try {
    // Alta: validaciones.
    check("sin PIN → 401", (await post("/admin/promoters/create", { name: "X" })).status === 401);
    check("sin nombre → 400", (await post("/admin/promoters/create", { ...TI, name: " " })).status === 400);
    check("teléfono raro → 400", (await post("/admin/promoters/create", { ...TI, name: "Ana", phone: "123" })).status === 400);
    check("pago fuera de rango → 400", (await post("/admin/promoters/create", { ...TI, name: "Ana", payPerRider: 500 })).status === 400);

    const promPhone = tel("9630");
    const c = await post("/admin/promoters/create", { ...TI, name: `Promotora ${stamp}`, phone: promPhone });
    check("alta del promotor", c.status === 201 && /^[A-Z0-9]{5}$/.test(c.data?.code || ""), c);
    const pid = c.data.id;
    const code = c.data.code;
    promoterIds.push(pid);

    let list = (await post("/admin/promoters/list", TI)).data;
    let me = list?.promoters?.find((p) => p.id === pid);
    check("sale en la lista de Ticul con $10 por pasajero", me && me.payPerRider === 10 && me.active && me.registered === 0 && list.ridesRequired === 3, me);
    const tk = (await post("/admin/promoters/list", TK)).data;
    check("no sale en la lista de Tekax", !tk.promoters.some((p) => p.id === pid));
    check("Tekax no ve su detalle", (await post(`/admin/promoters/${pid}/list`, TK)).status === 404);
    check("Tekax no lo puede pagar", (await post(`/admin/promoters/${pid}/pay`, TK)).status === 404);
    check("Tekax no lo puede editar", (await post(`/admin/promoters/${pid}/update`, { ...TK, name: "Hack" })).status === 404);

    // La página de invitación y el QR sirven con el código del promotor.
    const chk = await fetch(`${BASE}/api/riders/invite/${code}`);
    check("el código del promotor se reconoce", chk.status === 200);
    check("código de 5 que no existe → 404", (await fetch(`${BASE}/api/riders/invite/ZZZZZ`)).status === 404);
    const qr = await fetch(`${BASE}/api/qr/invita/${code}.svg`);
    check("su QR sale", qr.status === 200 && (await qr.text()).includes("<svg"));

    // Registro con su código (minúsculas y espacios sirven).
    const r1 = await post("/riders/register", { name: "Vecina Uno", phone: tel("9640"), ref: ` ${code.toLowerCase()} ` });
    phones.push(tel("9640"));
    check("registro con código de promotor", r1.status === 201, r1);
    let row = await db.prepare("SELECT referred_by_promoter_id, referred_by_driver_id, referred_by_rider_id, referred_at FROM riders WHERE phone = ?").get(tel("9640"));
    check("queda ligado al promotor (y a nadie más)", row?.referred_by_promoter_id === pid && row.referred_by_driver_id == null && row.referred_by_rider_id == null && !!row.referred_at, row);

    const r2 = await post("/riders/register", { name: "La Misma", phone: promPhone, ref: code });
    phones.push(promPhone);
    row = await db.prepare("SELECT referred_by_promoter_id FROM riders WHERE phone = ?").get(promPhone);
    check("el promotor no se cuenta a sí mismo", r2.status === 201 && row?.referred_by_promoter_id == null, row);

    // Más pasajeros directo en la base: 3 con sus 3 viajes, 1 a medio camino,
    // 1 de prueba (no cuenta), 1 con taxi barato (no cuenta).
    const ride = (ph, tipo = "moto", precio = null) =>
      db.prepare("INSERT INTO rides (rider_name, rider_phone, pickup_lat, pickup_lng, dest_lat, dest_lng, city, status, ride_type, agreed_price, created_at, updated_at) VALUES ('x', ?, 20.39528, -89.53389, 20.40, -89.53, 'ticul', 'completado', ?, ?, datetime('now'), datetime('now'))").run(ph, tipo, precio);
    const tres = async (ph, ...a) => { for (let k = 0; k < 3; k++) await ride(ph, ...a); };
    const ok = [tel("9641"), tel("9642")];
    const medio = tel("9643"), prueba = tel("9644"), taxi = tel("9645");
    phones.push(...ok, medio, prueba, taxi);
    for (const ph of [...ok, medio, taxi]) await db.prepare("INSERT INTO riders (phone, name, city, referred_by_promoter_id, referred_at) VALUES (?, 'Invitado', 'ticul', ?, datetime('now'))").run(ph, pid);
    await db.prepare("INSERT INTO riders (phone, name, city, referred_by_promoter_id, referred_at, es_prueba) VALUES (?, 'Prueba', 'ticul', ?, datetime('now'), 1)").run(prueba, pid);
    for (const ph of [tel("9640"), ...ok, prueba]) await tres(ph);
    await ride(medio);
    await tres(taxi, "taxi", 10);

    list = (await post("/admin/promoters/list", TI)).data;
    me = list.promoters.find((p) => p.id === pid);
    check("cuenta: 5 registrados, 3 con 3 viajes, 1 a medio camino", me.registered === 5 && me.qualified === 3 && me.started === 1, me);
    check("por pagar: 3 × $10 = $30", me.toPay === 3 && me.owed === 30 && me.paidTotal === 0, me);

    const det = (await post(`/admin/promoters/${pid}/list`, TI)).data;
    check("detalle: sus pasajeros sin teléfono", det.riders.length === 5 && det.riders.every((r) => !("phone" in r)) && det.riders.filter((r) => r.qualified).length === 3, det.riders);

    // Pagar con números viejos (vio 2, hay 3): no anota nada.
    const stale = await post(`/admin/promoters/${pid}/pay`, { ...TI, riders: 2, amount: 20 });
    check("números viejos: 409 y no paga nada", stale.status === 409 && !(await db.prepare("SELECT 1 FROM promoter_payouts WHERE promoter_id = ?").get(pid)), stale);
    check("sin números: 400", (await post(`/admin/promoters/${pid}/pay`, TI)).status === 400);
    const sinPagar = await db.prepare("SELECT COUNT(*) AS n FROM riders WHERE referred_by_promoter_id = ? AND promoter_paid_at IS NOT NULL").get(pid);
    check("nadie quedó marcado pagado", Number(sinPagar.n) === 0, sinPagar);
    // Editar con el pago vacío no lo pone en $0; active de texto: 400.
    const ed = await post(`/admin/promoters/${pid}/update`, { ...TI, payPerRider: "" });
    check("pago vacío al editar = no cambia", ed.status === 200 && (await db.prepare("SELECT pay_per_rider FROM promoters WHERE id = ?").get(pid)).pay_per_rider === 10, ed);
    check("active de texto: 400", (await post(`/admin/promoters/${pid}/update`, { ...TI, active: "false" })).status === 400);
    // Pagar: dos al mismo tiempo, solo uno paga.
    const PAY = { ...TI, riders: 3, amount: 30 };
    const [p1, p2] = await Promise.all([post(`/admin/promoters/${pid}/pay`, PAY), post(`/admin/promoters/${pid}/pay`, PAY)]);
    const goods = [p1, p2].filter((p) => p.status === 200);
    check("dos «Pagar» a la vez: solo uno paga", goods.length === 1 && goods[0].data.amount === 30 && goods[0].data.riders === 3, [p1, p2]);
    check("pagar otra vez: no hay pendientes", (await post(`/admin/promoters/${pid}/pay`, PAY)).status === 400);
    list = (await post("/admin/promoters/list", TI)).data;
    me = list.promoters.find((p) => p.id === pid);
    check("después de pagar: $0 por pagar, $30 pagado", me.toPay === 0 && me.owed === 0 && me.paidTotal === 30, me);
    const payouts = await db.prepare("SELECT kind, riders_count, amount FROM promoter_payouts WHERE promoter_id = ?").all(pid);
    check("un solo pago anotado (el que falló no dejó basura)", payouts.length === 1 && payouts[0].amount === 30 && payouts[0].riders_count === 3, payouts);

    // El de a medio camino completa: ahora con $15 por pasajero.
    check("cambiar a $15", (await post(`/admin/promoters/${pid}/update`, { ...TI, payPerRider: 15 })).status === 200);
    await ride(medio); await ride(medio);
    me = (await post("/admin/promoters/list", TI)).data.promoters.find((p) => p.id === pid);
    check("el nuevo cuenta a $15", me.toPay === 1 && me.owed === 15 && me.qualified === 4, me);
    const p3 = await post(`/admin/promoters/${pid}/pay`, { ...TI, riders: 1, amount: 15 });
    check("pagar $15", p3.status === 200 && p3.data.amount === 15, p3);

    // Jornada.
    check("jornada $0 → 400", (await post(`/admin/promoters/${pid}/jornada`, { ...TI, amount: 0 })).status === 400);
    check("jornada $5000 → 400", (await post(`/admin/promoters/${pid}/jornada`, { ...TI, amount: 5000 })).status === 400);
    check("jornada $100", (await post(`/admin/promoters/${pid}/jornada`, { ...TI, amount: 100, note: "sábado mercado" })).status === 200);
    me = (await post("/admin/promoters/list", TI)).data.promoters.find((p) => p.id === pid);
    check("total pagado $145", me.paidTotal === 145, me);

    // Movimientos: crear y pagar quedan anotados; ver la lista no.
    await new Promise((r) => setTimeout(r, 300)); // se anota al terminar la respuesta
    const audit = await db.prepare("SELECT action FROM admin_audit WHERE action LIKE '/admin/promoters%' AND at >= datetime('now', '-10 minutes')").all();
    check("pagar queda en Movimientos", audit.some((a) => a.action === "/admin/promoters/:id/pay"), audit);
    check("ver la lista no llena Movimientos", !audit.some((a) => /list$/.test(a.action)), audit);

    // Pausado: su código ya no liga a nadie.
    check("pausar", (await post(`/admin/promoters/${pid}/update`, { ...TI, active: false })).status === 200);
    check("pausado: su código ya no se reconoce", (await fetch(`${BASE}/api/riders/invite/${code}`)).status === 404);
    const r3 = await post("/riders/register", { name: "Tarde", phone: tel("9646"), ref: code });
    phones.push(tel("9646"));
    row = await db.prepare("SELECT referred_by_promoter_id FROM riders WHERE phone = ?").get(tel("9646"));
    check("pausado: se registra igual, sin promotor", r3.status === 201 && row?.referred_by_promoter_id == null, row);
  } finally {
    for (const ph of phones) {
      await db.prepare("DELETE FROM rides WHERE rider_phone = ?").run(ph);
      await db.prepare("DELETE FROM riders WHERE phone = ?").run(ph);
    }
    for (const id of promoterIds) {
      await db.prepare("DELETE FROM promoter_payouts WHERE promoter_id = ?").run(id);
      await db.prepare("DELETE FROM promoters WHERE id = ?").run(id);
    }
  }
  console.log(`promotores: ${pass} bien, ${fail} mal`);
  process.exit(fail ? 1 : 0);
}
main().catch((e) => { console.error(e); process.exit(1); });
