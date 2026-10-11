// Clave de entrega en domicilios (10-oct-2026). Solo en localhost:
//   BASE=http://localhost:3093 ADMIN_PIN=... node tools/test-clave.js
// Pasajero pide domicilio → ve su clave; el chofer nunca la ve (ni el token);
// sin clave no se termina; clave mal cuenta intentos (5 y se bloquea); clave
// bien termina; sin clave con foto también; el admin lo ve. Pasaje normal no
// pide clave.
const path = require("node:path");
const WebSocket = require("ws");
try { process.loadEnvFile(path.join(__dirname, "..", ".env")); } catch {}

const BASE = process.env.BASE || "http://localhost:3077";
if (!/^https?:\/\/(localhost|127\.0\.0\.1)[:/]/.test(BASE)) throw new Error("Esto solo se corre en localhost: " + BASE);
const ADMIN = process.env.ADMIN_PIN;
const TEKAX = { lat: 20.2071, lng: -89.2809 };

let pass = 0, fail = 0;
function check(label, cond, extra) {
  if (cond) pass++;
  else { fail++; console.log("✗", label, extra !== undefined ? JSON.stringify(extra).slice(0, 300) : ""); }
}
async function post(url, body) {
  const res = await fetch(BASE + "/api" + url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  let data = null; try { data = await res.json(); } catch {}
  return { status: res.status, data };
}
async function get(url) {
  const res = await fetch(BASE + "/api" + url);
  let data = null; try { data = await res.json(); } catch {}
  return { status: res.status, data };
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function driverSocket(id, pin) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`${BASE.replace("http", "ws")}/ws?role=driver&driverId=${id}&pin=${pin}`);
    ws.msgs = [];
    ws.on("message", (raw) => ws.msgs.push(JSON.parse(raw.toString())));
    ws.on("open", () => resolve(ws));
    ws.on("error", reject);
  });
}
const JPG = "data:image/jpeg;base64,/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/wAALCAABAAEBAREA/8QAFAABAAAAAAAAAAAAAAAAAAAACf/EABQQAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQEAAD8AKp//2Q==";
const stamp = String(Date.now()).slice(-6);

async function main() {
  const mk = await post("/admin/drivers", { adminPin: ADMIN, name: `Clave Moto ${stamp}`, phone: `99944${stamp}`.slice(0, 10), vehicle: "Prueba", acceptedLegal: true, vehicleType: "moto" });
  check("alta chofer", mk.status === 201, mk);
  const drv = mk.data;
  const ws = await driverSocket(drv.id, drv.pin);
  ws.send(JSON.stringify({ type: "location", lat: TEKAX.lat + 0.002, lng: TEKAX.lng }));
  ws.send(JSON.stringify({ type: "status", status: "disponible" }));
  await sleep(400);

  const reg = await post("/riders/register", { name: "Cliente Clave", phone: `98844${stamp}`.slice(0, 10) });
  check("registro cliente", reg.status === 201, reg);
  const rider = reg.data;

  const doRide = async (kind) => {
    const r = await post("/rides", { rider_phone: rider.phone, rider_pin: rider.pin, pickup_lat: TEKAX.lat, pickup_lng: TEKAX.lng, dest_lat: TEKAX.lat + 0.01, dest_lng: TEKAX.lng, ride_type: "moto", service_kind: kind, offer_price: 17 });
    check(`pedir ${kind}`, r.status === 201, r);
    return r.data;
  };
  const toEnCurso = async (R) => {
    const a = await post(`/rides/${R.id}/accept`, { driverId: drv.id, pin: drv.pin });
    check("aceptar", a.status === 200, a);
    await post(`/rides/${R.id}/arrived`, { driverId: drv.id, pin: drv.pin });
    const s = await post(`/rides/${R.id}/start`, { driverId: drv.id, pin: drv.pin });
    check("iniciar", s.status === 200, s);
    return a.data;
  };
  const complete = (R, extra) => post(`/rides/${R.id}/complete`, { driverId: drv.id, pin: drv.pin, ...extra });

  // ---------- 1) Domicilio con clave ----------
  ws.msgs = [];
  const R = await doRide("domicilio");
  check("el cliente recibe su clave (4 números)", /^\d{4}$/.test(R.delivery_code) && R.delivery_code !== "0000", R.delivery_code);
  const g = await get(`/rides/${R.id}?t=${R.share_token}`);
  check("el cliente ve la clave al volver a abrir", g.data && g.data.delivery_code === R.delivery_code, g.data && g.data.delivery_code);
  await sleep(500);
  const nr = ws.msgs.find((m) => m.type === "new_ride" && m.payload.id === R.id);
  check("al chofer le llega la solicitud", !!nr, ws.msgs.map((m) => m.type));
  check("la solicitud NO trae la clave ni el token", nr && !("delivery_code" in nr.payload) && !("share_token" in nr.payload), nr && Object.keys(nr.payload));
  check("la solicitud dice que pide clave", nr && nr.payload.delivery_code_required === true);
  const acc = await toEnCurso(R);
  check("aceptar NO trae la clave ni el token", !("delivery_code" in acc) && !("share_token" in acc) && acc.delivery_code_required === true, Object.keys(acc));
  const act = await post("/rides/active", { driverId: drv.id, pin: drv.pin });
  check("viaje activo NO trae la clave", act.data && !("delivery_code" in act.data) && !("share_token" in act.data) && act.data.delivery_code_required === true, act.data && Object.keys(act.data));

  const none = await complete(R, {});
  check("sin clave no se termina", none.status === 400 && none.data.needsDeliveryCode, none);
  const wrong = R.delivery_code === "1234" ? "4321" : "1234";
  const w1 = await complete(R, { deliveryCode: wrong });
  check("clave mal = rechazada, quedan 4", w1.status === 400 && w1.data.wrongCode && w1.data.attemptsLeft === 4, w1);
  const ok = await complete(R, { deliveryCode: R.delivery_code });
  check("clave bien = entregado", ok.status === 200 && ok.data.ok, ok);
  const g2 = await get(`/rides/${R.id}?t=${R.share_token}`);
  check("queda completado y confirmado con clave", g2.data.status === "completado" && g2.data.delivery_confirmed === "clave", g2.data && [g2.data.status, g2.data.delivery_confirmed]);

  // ---------- 2) Domicilio: 5 claves mal → solo con foto ----------
  const R2 = await doRide("domicilio");
  await toEnCurso(R2);
  const wrong2 = R2.delivery_code === "1111" ? "2222" : "1111";
  let last;
  for (let i = 0; i < 5; i++) last = await complete(R2, { deliveryCode: wrong2 });
  check("5ª clave mal = bloqueado", last.status === 400 && last.data.deliveryLocked && last.data.attemptsLeft === 0, last);
  const sixth = await complete(R2, { deliveryCode: R2.delivery_code });
  check("bloqueado: ni la clave buena entra (423)", sixth.status === 423, sixth);
  const badPhoto = await complete(R2, { deliveryPhoto: "no-es-foto" });
  check("foto inválida = 400", badPhoto.status === 400, badPhoto);
  const ph = await complete(R2, { deliveryPhoto: JPG });
  check("sin clave con foto = entregado", ph.status === 200, ph);
  const g3 = await get(`/rides/${R2.id}?t=${R2.share_token}`);
  check("queda 'sin_clave' y la foto no sale al cliente", g3.data.delivery_confirmed === "sin_clave" && !("delivery_photo" in g3.data), g3.data && Object.keys(g3.data));

  // ---------- 3) Pasaje normal: sin clave ----------
  const R3 = await doRide("pasaje");
  check("pasaje no tiene clave", R3.delivery_code == null, R3.delivery_code);
  await toEnCurso(R3);
  const c3 = await complete(R3, {});
  check("pasaje se termina igual que siempre", c3.status === 200, c3);

  // ---------- 4) Admin ----------
  const list = await post("/admin/rides/list", { adminPin: ADMIN });
  const a1 = list.data.find((r) => r.id === R.id), a2 = list.data.find((r) => r.id === R2.id);
  check("admin: confirmado con clave", a1 && a1.delivery_confirmed === "clave", a1);
  check("admin: sin clave con foto y 5 intentos", a2 && a2.delivery_confirmed === "sin_clave" && a2.has_delivery_photo && a2.delivery_code_attempts === 5, a2);
  check("admin: la lista no trae la clave", a1 && !("delivery_code" in a1));
  const f = await post(`/admin/rides/${R2.id}/delivery-photo`, { adminPin: ADMIN });
  check("admin: ver foto de la entrega", f.status === 200 && f.data.photo === JPG, f.status);
  const f1 = await post(`/admin/rides/${R.id}/delivery-photo`, { adminPin: ADMIN });
  check("admin: entrega con clave no tiene foto (404)", f1.status === 404, f1.status);

  ws.close();
  console.log(`\n${fail ? "✗" : "✓"} ${pass} bien, ${fail} mal`);
  process.exit(fail ? 1 : 0);
}
main().catch((e) => { console.error(e); process.exit(1); });
