// Aviso de saldo bajo en Twilio (twilioSaldo.js). Usa un Twilio de mentira:
// nunca habla con Twilio de verdad ni necesita claves reales.
//   1) Saldo arriba del mínimo → "ok"; abajo → "bajo" (+ una sola anotación
//      en Movimientos); Twilio no contesta → no truena y guarda el último saldo.
//   2) La copia corriendo (sin claves de Twilio) responde /api/twilio-health
//      200 sin enseñar la cantidad.
//   DATABASE_URL=... BASE=http://localhost:3077 node tools/test-twilio-saldo.js
const path = require("node:path");
const fs = require("node:fs");
const envFile = path.join(__dirname, "..", ".env");
if (fs.existsSync(envFile)) process.loadEnvFile(envFile);
const BASE = process.env.BASE || "http://localhost:3077";
if (!/^https?:\/\/(localhost|127\.0\.0\.1)[:/]/.test(BASE)) throw new Error("Esto solo se corre en localhost: " + BASE);
if (!/localhost|127\.0\.0\.1/.test(process.env.DATABASE_URL || "")) throw new Error("DATABASE_URL tiene que ser local");

// Claves de mentira (solo dentro de esta prueba).
process.env.TWILIO_ACCOUNT_SID = "ACprueba";
process.env.TWILIO_AUTH_TOKEN = "token-prueba";
delete process.env.TWILIO_API_KEY;
delete process.env.TWILIO_SALDO_MINIMO;

const db = require("../db");
const saldo = require("../twilioSaldo");

let pass = 0;
let fail = 0;
function check(label, cond, extra) {
  if (cond) pass++;
  else {
    fail++;
    console.log("✗", label, extra !== undefined ? JSON.stringify(extra).slice(0, 300) : "");
  }
}

let calls = [];
function fakeTwilio(balance, status = 200) {
  return async (url, opts) => {
    calls.push({ url, auth: opts && opts.headers && opts.headers.Authorization });
    return { ok: status === 200, status, json: async () => (balance === null ? {} : { balance: String(balance), currency: "USD" }) };
  };
}
const offline = async () => { throw new Error("sin red"); };

async function avisos(desde) {
  return db.prepare("SELECT detail FROM admin_audit WHERE action = 'twilio_saldo_bajo' AND id > ? ORDER BY id").all(desde);
}

async function main() {
  const start = (await db.prepare("SELECT COALESCE(MAX(id), 0) AS m FROM admin_audit").get()).m;

  check("mínimo por defecto $6", saldo.minimo() === 6, saldo.minimo());

  // Twilio no contesta antes de tener saldo → sin_dato, sin alarma.
  saldo._reset();
  let s = await saldo.checkNow(offline);
  check("sin red al inicio: sin_dato", s.status === "sin_dato", s);
  check("sin red: no alarma", saldo.twilioHealth().alert === false);

  // Saldo bueno.
  s = await saldo.checkNow(fakeTwilio("11.80"));
  check("$11.80 → ok", s.status === "ok" && s.balance === 11.8, s);
  check("ok: sin alarma", saldo.twilioHealth().alert === false);
  check("pregunta a la cuenta correcta", calls.at(-1).url === "https://api.twilio.com/2010-04-01/Accounts/ACprueba/Balance.json", calls.at(-1));
  check("manda la clave", calls.at(-1).auth === "Basic " + Buffer.from("ACprueba:token-prueba").toString("base64"));

  // Justo $6 no es bajo; $5.99 sí.
  s = await saldo.checkNow(fakeTwilio("6.00"));
  check("$6.00 → ok", s.status === "ok", s);
  s = await saldo.checkNow(fakeTwilio("5.99"));
  check("$5.99 → bajo", s.status === "bajo", s);
  check("bajo: alarma", saldo.twilioHealth().alert === true);
  let a = await avisos(start);
  check("una anotación en Movimientos", a.length === 1 && /\$5\.99 USD/.test(a[0].detail) && /mínimo \$6/.test(a[0].detail), a);

  // Sigue bajo: no se repite la anotación.
  await saldo.checkNow(fakeTwilio("4.10"));
  a = await avisos(start);
  check("sigue bajo: no repite anotación", a.length === 1, a);

  // Twilio falla estando bajo: se queda en bajo (no apaga la alarma).
  s = await saldo.checkNow(offline);
  check("falla estando bajo: sigue bajo", s.status === "bajo" && s.balance === 4.1, s);
  s = await saldo.checkNow(fakeTwilio(null, 401));
  check("clave sin permiso: sigue bajo", s.status === "bajo", s);

  // Recargó: vuelve a ok; si baja otra vez, otra anotación.
  s = await saldo.checkNow(fakeTwilio("26.00"));
  check("recargó → ok", s.status === "ok" && saldo.twilioHealth().alert === false, s);
  await saldo.checkNow(fakeTwilio("3.00"));
  a = await avisos(start);
  check("bajó otra vez: segunda anotación", a.length === 2, a);

  // Mínimo cambiado desde Render.
  process.env.TWILIO_SALDO_MINIMO = "10";
  s = await saldo.checkNow(fakeTwilio("8.00"));
  check("mínimo $10: $8 es bajo", s.status === "bajo", s);
  process.env.TWILIO_SALDO_MINIMO = "abc";
  check("mínimo inválido → $6", saldo.minimo() === 6);

  // Sin claves: sin_configurar, sin alarma, no llama a Twilio.
  delete process.env.TWILIO_ACCOUNT_SID;
  const before = calls.length;
  s = await saldo.checkNow(fakeTwilio("1.00"));
  check("sin claves: sin_configurar", s.status === "sin_configurar" && calls.length === before, s);
  check("sin claves: sin alarma", saldo.twilioHealth().alert === false);

  // La copia corriendo: 200 y sin la cantidad.
  const res = await fetch(BASE + "/api/twilio-health");
  const body = await res.json().catch(() => null);
  check("copia: /api/twilio-health 200", res.status === 200, { status: res.status, body });
  check("copia: no enseña la cantidad", body && !("balance" in body) && Object.keys(body).join() === "status", body);

  // Limpia lo que creó la prueba (las anotaciones de error se escriben sin esperar).
  await new Promise((r) => setTimeout(r, 500));
  await db.prepare("DELETE FROM admin_audit WHERE action = 'twilio_saldo_bajo' AND id > ?").run(start);
  await db.prepare("DELETE FROM admin_audit WHERE action = 'error_servidor' AND detail LIKE 'twilioSaldo%' AND id > ?").run(start);

  console.log(fail ? `\n✗ ${fail} mal, ${pass} bien` : `\n✓ ${pass} bien`);
  process.exit(fail ? 1 : 0);
}

main().catch((e) => {
  console.error("Error:", e);
  process.exit(1);
});
