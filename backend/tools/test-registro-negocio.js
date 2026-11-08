// Registro de negocios por su cuenta + aprobación del admin + mínimo para salir
// en la lista (8-nov-2026). Solo en localhost:
//   BASE=http://localhost:3077 ADMIN_PIN=... node tools/test-registro-negocio.js
const path = require("node:path");
try { process.loadEnvFile(path.join(__dirname, "..", ".env")); } catch {}

const BASE = process.env.BASE || "http://localhost:3077";
if (!/^https?:\/\/(localhost|127\.0\.0\.1)[:/]/.test(BASE)) throw new Error("Esto solo se corre en localhost: " + BASE);
const ADMIN = process.env.ADMIN_PIN;
const TEKAX = { lat: 20.2071, lng: -89.2809 };
const PNG = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

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
const stamp = String(Date.now()).slice(-6);
const phone = (p) => (p + stamp).slice(0, 10);

async function main() {
  const owner = (await post("/riders/register", { name: "Dueña Marquesitas", phone: phone("9961") })).data;
  const O = { phone: owner.phone, pin: owner.pin };
  const here = { lat: TEKAX.lat + 0.002, lng: TEKAX.lng + 0.001 };
  const good = { ...O, name: `Marquesitas ${stamp}`, category: "Postres", address: "Calle 50", ...here, facade: PNG };

  // ---------- Sin negocio todavía ----------
  const me0 = await post("/business/me", O);
  check("me: sin negocio ni solicitud, con categorías", me0.status === 200 && me0.data.business === null && me0.data.application === null && me0.data.categories.includes("Postres"), me0);
  check("PIN malo = 401", (await post("/business/apply", { ...good, pin: "0000" })).status === 401);
  check("sin nombre = 400", (await post("/business/apply", { ...good, name: " " })).status === 400);
  check("categoría inventada = 400", (await post("/business/apply", { ...good, category: "Armas" })).status === 400);
  check("sin ubicación = 400", (await post("/business/apply", { ...good, lat: "x" })).status === 400);
  check("fuera de los municipios (Cancún) = 400", (await post("/business/apply", { ...good, lat: 21.16, lng: -86.85 })).status === 400);
  check("sin foto de fachada = 400", (await post("/business/apply", { ...good, facade: undefined })).status === 400);
  check("foto que no es imagen = 400", (await post("/business/apply", { ...good, facade: "data:text/html;base64,PGI+" })).status === 400);

  // ---------- Solicitud ----------
  const ap = await post("/business/apply", good);
  check("solicitud mandada = pendiente", ap.status === 200 && ap.data.application.status === "pendiente" && ap.data.application.has_facade, ap);
  const me1 = await post("/business/me", O);
  check("me: muestra la solicitud pendiente, sin negocio", me1.data.business === null && me1.data.application.status === "pendiente", me1);

  // En revisión NO puede operar
  check("pendiente: no entra a su perfil (403)", (await post("/business/profile", O)).status === 403);
  check("pendiente: no sube productos (403)", (await post("/business/menu/save", { ...O, name: "Nutella", price: 40 })).status === 403);
  check("pendiente: no pide chofer (403)", (await post("/business/rides", { ...O, dest_lat: TEKAX.lat, dest_lng: TEKAX.lng, client_name: "X" })).status === 403);

  const list1 = await post("/admin/businesses/list", { adminPin: ADMIN });
  const row = list1.data.find((b) => b.rider_id === owner.id || b.phone === owner.phone);
  check("admin: la solicitud sale primero, con foto", row && list1.data[0].id === row.id && row.status === "pendiente" && /^\/api\//.test(row.facade || "") && row.active === 0, row);
  const bizId = row && row.id;
  check("pendiente: no recibe pedidos (opciones 404)", (await get(`/orders/options/${bizId}`)).status === 404);
  check("pendiente: no se puede ver su página", (await get(`/food/business/${bizId}`)).status === 404);
  check("admin: 'Activar' no se salta la aprobación (409)", (await post(`/admin/businesses/${bizId}/active`, { adminPin: ADMIN, active: 1 })).status === 409);
  check("aprobar sin PIN de admin = 401/403", [401, 403].includes((await post(`/admin/businesses/${bizId}/approve`, { adminPin: "mal" })).status));

  // ---------- Rechazo y corrección ----------
  const rej = await post(`/admin/businesses/${bizId}/reject`, { adminPin: ADMIN, reason: "La foto no se ve bien" });
  check("rechazar", rej.status === 200, rej);
  const me2 = await post("/business/me", O);
  check("me: rechazada con motivo", me2.data.application.status === "rechazado" && me2.data.application.reject_reason === "La foto no se ve bien", me2);
  check("no se aprueba una rechazada (409)", (await post(`/admin/businesses/${bizId}/approve`, { adminPin: ADMIN })).status === 409);
  const again = await post("/business/apply", { ...good, facade: undefined, name: `Marquesitas Doña ${stamp}` });
  check("corrige y manda otra vez (usa la foto de antes)", again.status === 200 && again.data.application.status === "pendiente" && again.data.application.reject_reason === null, again);

  // ---------- Aprobación ----------
  const seen0 = (await post("/admin/businesses/list", { adminPin: ADMIN })).data.find((b) => b.id === bizId).updated_at;
  check("aprobar una versión vieja (el dueño corrigió después) = 409", (await post(`/admin/businesses/${bizId}/approve`, { adminPin: ADMIN, seen: "2000-01-01 00:00:00" })).status === 409);
  const ok = await post(`/admin/businesses/${bizId}/approve`, { adminPin: ADMIN, seen: seen0 });
  check("aprobar", ok.status === 200, ok);
  check("aprobado por solicitud: sin periodo de gracia", (await post("/business/profile", O)).data.listing.grace_until === null);
  check("aprobar dos veces = 409", (await post(`/admin/businesses/${bizId}/approve`, { adminPin: ADMIN })).status === 409);
  const me3 = await post("/business/me", O);
  check("me: ya es negocio, con su nombre corregido", me3.data.business && me3.data.business.id === bizId && me3.data.business.name === `Marquesitas Doña ${stamp}`, me3);
  check("ya aprobado: no puede mandar otra solicitud (409)", (await post("/business/apply", good)).status === 409);

  // ---------- Lista de tareas para salir en Negocios ----------
  const p0 = await post("/business/profile", O);
  const L0 = p0.data.listing;
  check("tareas: faltan logo, portada y 3 productos con foto", L0 && !L0.complete && L0.missing.includes("logo") && L0.missing.includes("portada") && L0.missing.includes("3 productos con foto") && L0.min_products === 3, L0);
  const s1 = await post("/business/profile/save", { ...O, category: "Postres", logo: PNG, cover: PNG });
  check("con logo y portada, faltan los productos", s1.data.listing && s1.data.listing.missing.length === 1 && !s1.data.listing.complete, s1.data.listing);
  await post("/business/menu/save", { ...O, name: "Marquesita de queso", price: 35, photo: PNG });
  await post("/business/menu/save", { ...O, name: "Marquesita de Nutella", price: 45, photo: PNG });
  const m3 = await post("/business/menu/save", { ...O, name: "Agua", price: 15 });
  check("un producto sin foto no cuenta (2 de 3)", m3.data.listing && m3.data.listing.photos === 2 && m3.data.listing.missing[0] === "1 producto con foto" && !m3.data.listing.complete, m3.data.listing);
  const m4 = await post("/business/menu/save", { ...O, name: "Marquesita de cajeta", price: 40, photo: PNG });
  check("completo: ya sale en la lista", m4.data.listing && m4.data.listing.complete && m4.data.listing.listed && m4.data.listing.missing.length === 0, m4.data.listing);

  await post("/admin/food/enabled", { adminPin: ADMIN, enabled: true });
  const pub = await get("/food/businesses?city=tekax");
  check("el cliente lo ve en Negocios", pub.data.businesses.some((b) => b.id === bizId), pub.data.businesses.map((b) => b.name));
  check("la lista pública no trae la foto de fachada", pub.data.businesses.every((b) => !("facade" in b)), pub.data.businesses[0]);
  const item = m4.data.menu.find((i) => i.name === "Marquesita de cajeta");
  const off = await post(`/business/menu/${item.id}/available`, { ...O, available: 0 });
  const pub2 = await get("/food/businesses?city=tekax");
  const shown = pub2.data.businesses.some((b) => b.id === bizId);
  // Negocio creado antes de BUSINESS_RULES_FROM: sigue con la regla vieja hasta
  // BUSINESS_GRACE_UNTIL (grace_until viene lleno). Después, sin gracia.
  const L = off.data.listing;
  check("si se agota uno y quedan 2 con foto: ya no está completo", L && !L.complete, L);
  check(L && L.grace_until && new Date() < new Date(L.grace_until.replace(" ", "T") + "Z")
    ? "en periodo de gracia: sigue en la lista"
    : "sin gracia: sale de la lista", L && (L.grace_until && new Date() < new Date(L.grace_until.replace(" ", "T") + "Z") ? shown : !shown), { shown, L });
  await post(`/business/menu/${item.id}/available`, { ...O, available: 1 });
  await post(`/admin/businesses/${bizId}/active`, { adminPin: ADMIN, active: 0 });
  const meP = await post("/business/me", O);
  check("pausado por el admin: el dueño lo ve en pausa", meP.data.business === null && meP.data.application.status === "pausado", meP);
  check("pausado: no sale en la lista", !(await get("/food/businesses?city=tekax")).data.businesses.some((b) => b.id === bizId));
  const back = await post(`/admin/businesses/${bizId}/active`, { adminPin: ADMIN, active: 1 });
  check("admin: 'Activar' a un negocio aprobado y pausado sí funciona", back.status === 200, back);
  check("reactivado: vuelve a la lista", (await get("/food/businesses?city=tekax")).data.businesses.some((b) => b.id === bizId));
  await post("/admin/food/enabled", { adminPin: ADMIN, enabled: false });

  console.log(`\n${fail ? "✗" : "✓"} ${pass} bien, ${fail} mal`);
  process.exit(fail ? 1 : 0);
}
main().catch((e) => { console.error("Error:", e); process.exit(1); });
