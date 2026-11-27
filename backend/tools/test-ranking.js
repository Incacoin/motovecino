// Prueba del Ranking de choferes (27-nov-2026, ver ranking.js): programar,
// contar solo pasajeros nuevos dentro de las fechas y del municipio, empate
// (gana quien llegó primero), quitar a un chofer, apagar, pagar solo al
// ganador y lo que ve el chofer en su perfil (nunca nombres de otros).
//   BASE=http://localhost:3077 node tools/test-ranking.js
const path = require("node:path");
process.loadEnvFile(path.join(__dirname, "..", ".env"));
const BASE = process.env.BASE || "http://localhost:3077";
if (!/^https?:\/\/(localhost|127\.0\.0\.1)[:/]/.test(BASE)) throw new Error("Esto solo se corre en localhost: " + BASE);
const ADMIN = process.env.ADMIN_PIN;
const db = require("../db");
const { localToUtc } = require("../ranking");

let pass = 0;
let fail = 0;
function check(label, cond, extra) {
  if (cond) pass++;
  else {
    fail++;
    console.log("✗", label, extra !== undefined ? JSON.stringify(extra).slice(0, 300) : "");
  }
}
async function post(url, body) {
  // IP propia: no gasta los límites que comparten las demás pruebas.
  const res = await fetch(BASE + "/api" + url, { method: "POST", headers: { "Content-Type": "application/json", "X-Forwarded-For": "10.77.0.28" }, body: JSON.stringify(body) });
  let data = null;
  try { data = await res.json(); } catch {}
  return { status: res.status, data };
}
const stamp = String(Date.now()).slice(-6);
const TI = { adminPin: ADMIN, adminZone: "ticul" };
const TK = { adminPin: ADMIN, adminZone: "tekax" };
// Fecha "yyyy-mm-ddThh:mm" en hora de Yucatán (UTC-6), a X horas de ahora.
const local = (hours) => new Date(Date.now() + hours * 3600e3 - 6 * 3600e3).toISOString().slice(0, 16);
// Fecha UTC como la guarda riders.referred_at, a X minutos de ahora.
const utc = (min) => new Date(Date.now() + min * 60e3).toISOString().slice(0, 19).replace("T", " ");
const drivers = [];
const riderPhones = [];
const campaigns = [];
let n = 0;
async function rider(driverId, minutes, extra = {}) {
  const phone = extra.phone || `95${stamp}${String(++n).padStart(2, "0")}`;
  riderPhones.push(phone);
  await db.prepare("INSERT INTO riders (phone, name, city, referred_by_driver_id, referred_at, es_prueba) VALUES (?, ?, 'ticul', ?, ?, ?)")
    .run(phone, "Invitado", driverId, utc(minutes), extra.prueba ? 1 : 0);
  return phone;
}

async function main() {
  // Fechas.
  check("localToUtc: 12 a.m. de Yucatán = 6 a.m. UTC", localToUtc("2026-11-28T00:00") === "2026-11-28 06:00:00", localToUtc("2026-11-28T00:00"));
  check("localToUtc: 31 de febrero no existe", localToUtc("2026-02-31T00:00") === null);
  check("localToUtc: texto raro → null", localToUtc("mañana") === null && localToUtc("") === null);

  // Tres choferes: dos de Ticul y uno de Tekax.
  for (const [name, zona, tel] of [["Ana Ranking Uno", TI, "9781"], ["Beto Ranking Dos", TI, "9782"], ["Caro Ranking Tekax", TK, "9783"]]) {
    const r = await post("/admin/drivers", { ...zona, name: `${name} ${stamp}`, phone: `${tel}${stamp}`, acceptedLegal: true, vehicleType: "moto", grupo: "Por su cuenta" });
    check(`alta de ${name}`, r.status === 201, r);
    drivers.push(r.data);
  }
  const [A, B, C] = drivers;
  if (!A?.id || !B?.id || !C?.id) return;

  // Programar: errores.
  const base = { ...TI, startsLocal: local(-2), endsLocal: local(48), prize: 300, minCount: 3 };
  check("sin fechas → 400", (await post("/admin/ranking/create", { ...base, startsLocal: "" })).status === 400);
  check("fin antes del inicio → 400", (await post("/admin/ranking/create", { ...base, endsLocal: local(-3) })).status === 400);
  check("fin que ya pasó → 400", (await post("/admin/ranking/create", { ...base, startsLocal: local(-10), endsLocal: local(-1) })).status === 400);
  check("más de 31 días → 400", (await post("/admin/ranking/create", { ...base, endsLocal: local(24 * 40) })).status === 400);
  check("premio 0 → 400", (await post("/admin/ranking/create", { ...base, prize: 0 })).status === 400);
  check("premio con centavos → 400", (await post("/admin/ranking/create", { ...base, prize: 300.5 })).status === 400);
  check("mínimo 0 → 400", (await post("/admin/ranking/create", { ...base, minCount: 0 })).status === 400);
  check("sin PIN → 401", (await post("/admin/ranking/create", { ...base, adminPin: "" })).status === 401);

  const cr = await post("/admin/ranking/create", base);
  check("programar el ranking de Ticul", cr.status === 201 && cr.data?.id, cr);
  const id = cr.data?.id;
  if (!id) return;
  campaigns.push(id);
  check("otro que se encima → 400", (await post("/admin/ranking/create", { ...base, startsLocal: local(24), endsLocal: local(60) })).status === 400);
  const tk = await post("/admin/ranking/create", { ...base, ...TK });
  check("Tekax sí puede tener el suyo en las mismas fechas", tk.status === 201, tk);
  if (tk.data?.id) campaigns.push(tk.data.id);

  const lista = (await post("/admin/ranking/list", TI)).data || [];
  check("la lista de Ticul trae el suyo en curso", lista.some((c) => c.id === id && c.status === "en_curso") && !lista.some((c) => c.id === tk.data?.id), lista);

  // Pasajeros. Ana: 3 dentro (el último hace 30 min). Beto: 3 dentro (el
  // último hace 5 min → empata pero llegó después). Fuera de fechas, de
  // prueba, el teléfono del chofer y Tekax no cuentan.
  const a1 = await rider(A.id, -100);
  await rider(A.id, -60);
  await rider(A.id, -30);
  await rider(A.id, -20, { prueba: true });
  await rider(A.id, -15, { phone: A.phone });
  await rider(B.id, -90);
  await rider(B.id, -50);
  await rider(B.id, -5);
  await rider(B.id, -60 * 5); // antes de que empezara
  await rider(C.id, -10); // chofer de Tekax
  await db.prepare("INSERT INTO rides (rider_name, rider_phone, pickup_lat, pickup_lng, status, city, ride_type, offer_price, agreed_price, completed_at) VALUES ('Invitado', ?, 20.39, -89.53, 'completado', 'ticul', 'moto', 20, 20, datetime('now'))").run(a1);

  let bd = (await post(`/admin/ranking/${id}/list`, TI)).data;
  const rowA = bd?.rows?.find((r) => r.id === A.id);
  const rowB = bd?.rows?.find((r) => r.id === B.id);
  check("Ana: 3 pasajeros (sin prueba ni su propio teléfono), 1 con viaje", rowA?.count === 3 && rowA?.withRide === 1, rowA);
  check("Beto: 3 pasajeros (el de antes no cuenta)", rowB?.count === 3, rowB);
  check("empate: gana Ana porque llegó primero", rowA?.place === 1 && rowB?.place === 2, bd?.rows);
  check("Caro (Tekax) no sale en Ticul", !bd?.rows?.some((r) => r.id === C.id));
  check("va ganando Ana (llegó al mínimo)", bd?.leaderId === A.id, bd);
  check("la lista del admin no trae teléfonos", !JSON.stringify(bd).includes(A.phone) && !JSON.stringify(bd).includes(B.phone));
  check("Tekax no ve el ranking de Ticul", (await post(`/admin/ranking/${id}/list`, TK)).status === 404);
  const bdTk = (await post(`/admin/ranking/${tk.data?.id}/list`, TK)).data;
  check("en el de Tekax sale Caro con 1", bdTk?.rows?.length === 1 && bdTk.rows[0].id === C.id && bdTk.rows[0].count === 1, bdTk);

  // Lo que ve el chofer.
  const pA = (await post("/drivers/profile", { phone: A.phone, pin: A.pin })).data;
  check("perfil de Ana: lugar 1 con 3, premio y mínimo", pA?.ranking?.status === "en_curso" && pA.ranking.place === 1 && pA.ranking.count === 3 && pA.ranking.prize === 300 && pA.ranking.minCount === 3, pA?.ranking);
  check("el perfil no trae nombres de otros choferes", !JSON.stringify(pA?.ranking || {}).includes("Beto"));
  const pB = (await post("/drivers/profile", { phone: B.phone, pin: B.pin })).data;
  check("perfil de Beto: lugar 2, el primero lleva 3", pB?.ranking?.place === 2 && pB.ranking.leaderCount === 3, pB?.ranking);

  // Quitar a Ana.
  check("quitar con datos raros → 400", (await post(`/admin/ranking/${id}/exclude`, { ...TI, driverId: A.id, excluded: "si" })).status === 400);
  check("quitar a un chofer de Tekax → 400", (await post(`/admin/ranking/${id}/exclude`, { ...TI, driverId: C.id, excluded: true })).status === 400);
  check("quitar a Ana", (await post(`/admin/ranking/${id}/exclude`, { ...TI, driverId: A.id, excluded: true })).status === 200);
  bd = (await post(`/admin/ranking/${id}/list`, TI)).data;
  check("sin Ana, Beto pasa al lugar 1", bd?.rows?.find((r) => r.id === B.id)?.place === 1 && bd.rows.find((r) => r.id === A.id)?.excluded === true && bd.leaderId === B.id, bd?.rows);
  check("Ana quitada ya no ve el ranking", (await post("/drivers/profile", { phone: A.phone, pin: A.pin })).data?.ranking === null);
  check("regresar a Ana", (await post(`/admin/ranking/${id}/exclude`, { ...TI, driverId: A.id, excluded: false })).status === 200);

  // Pagar: no mientras va.
  check("pagar mientras va → 400", (await post(`/admin/ranking/${id}/paid`, { ...TI, driverId: A.id })).status === 400);
  // Apagar.
  check("Tekax no puede apagar el de Ticul", (await post(`/admin/ranking/${id}/stop`, TK)).status === 404);
  check("apagar", (await post(`/admin/ranking/${id}/stop`, TI)).status === 200);
  await rider(B.id, 1); // después de apagado (hora futura) no cuenta
  bd = (await post(`/admin/ranking/${id}/list`, TI)).data;
  check("apagado: estado «apagado» y Beto sigue con 3", bd?.campaign?.status === "apagado" && bd.rows.find((r) => r.id === B.id)?.count === 3, bd?.campaign);
  check("apagar otra vez → 400", (await post(`/admin/ranking/${id}/stop`, TI)).status === 400);
  check("el chofer ya no ve el ranking apagado", (await post("/drivers/profile", { phone: B.phone, pin: B.pin })).data?.ranking === null);
  check("pagar a Beto (no ganó) → 400", (await post(`/admin/ranking/${id}/paid`, { ...TI, driverId: B.id })).status === 400);
  const paid = await post(`/admin/ranking/${id}/paid`, { ...TI, driverId: A.id });
  check("pagar a Ana", paid.status === 200, paid);
  check("pagar otra vez → 400", (await post(`/admin/ranking/${id}/paid`, { ...TI, driverId: A.id })).status === 400);
  check("quitar después de pagar → 400", (await post(`/admin/ranking/${id}/exclude`, { ...TI, driverId: A.id, excluded: true })).status === 400);
  bd = (await post(`/admin/ranking/${id}/list`, TI)).data;
  check("queda pagado a Ana", bd?.campaign?.winnerDriverId === A.id && !!bd.campaign.paidAt, bd?.campaign);

  // Programado a futuro y cancelado.
  const fut = await post("/admin/ranking/create", { ...TI, startsLocal: local(72), endsLocal: local(72 + 24 * 7), prize: 300, minCount: 10 });
  check("programar uno para dentro de 3 días", fut.status === 201, fut);
  if (fut.data?.id) {
    campaigns.push(fut.data.id);
    const pf = (await post("/drivers/profile", { phone: B.phone, pin: B.pin })).data?.ranking;
    check("el chofer ve el aviso del que viene", pf?.status === "programado" && pf.minCount === 10 && pf.place === null, pf);
    check("cancelarlo", (await post(`/admin/ranking/${fut.data.id}/stop`, TI)).status === 200);
    const l2 = (await post("/admin/ranking/list", TI)).data || [];
    check("queda «cancelado»", l2.find((c) => c.id === fut.data.id)?.status === "cancelado", l2);
    check("ya no le sale al chofer", (await post("/drivers/profile", { phone: B.phone, pin: B.pin })).data?.ranking === null);
    const otra = await post("/admin/ranking/create", { ...TI, startsLocal: local(80), endsLocal: local(100), prize: 300, minCount: 10 });
    check("uno cancelado no estorba para programar otro en esas fechas", otra.status === 201, otra);
    if (otra.data?.id) campaigns.push(otra.data.id);
  }

  // Movimientos: los cambios sí, las consultas no.
  const mov = await db.prepare("SELECT action, COUNT(*) AS n FROM admin_audit WHERE action LIKE '/admin/ranking%' AND at >= datetime('now', '-10 minutes') GROUP BY action").all();
  const has = (a) => mov.some((m) => m.action === a);
  check("en Movimientos: programar, apagar, quitar y pagar", has("/admin/ranking/create") && has("/admin/ranking/:id/stop") && has("/admin/ranking/:id/exclude") && has("/admin/ranking/:id/paid"), mov);
  check("las consultas no van a Movimientos", !has("/admin/ranking/list") && !has("/admin/ranking/:id/list"), mov);

  console.log(fail ? `NO: ${fail} fallaron, ${pass} bien` : `Todo bien (${pass})`);
}

main()
  .catch((e) => { fail++; console.error("✗ Error:", e); })
  .finally(async () => {
    try {
      if (campaigns.length) await db.prepare(`DELETE FROM ranking_campaigns WHERE id IN (${campaigns.map(() => "?").join(",")})`).run(...campaigns);
      if (riderPhones.length) {
        await db.prepare(`DELETE FROM rides WHERE rider_phone IN (${riderPhones.map(() => "?").join(",")})`).run(...riderPhones);
        await db.prepare(`DELETE FROM riders WHERE phone IN (${riderPhones.map(() => "?").join(",")})`).run(...riderPhones);
      }
      for (const d of drivers) if (d?.id) await db.prepare("UPDATE drivers SET deleted_at = datetime('now') WHERE id = ?").run(d.id);
    } catch (e) { console.error("limpieza:", e.message); }
    process.exit(fail ? 1 : 0);
  });
