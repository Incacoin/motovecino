// Aviso de saldo bajo en Twilio (twilioSaldo.js). Usa un Twilio de mentira:
// nunca habla con Twilio de verdad ni necesita claves reales.
//   1) Saldo arriba del mínimo → "ok"; abajo → "bajo" (una anotación por día,
//      aunque haya deploy); 2 fallas seguidas (clave mala) → "sin_dato" con alarma.
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

async function avisos(action = "twilio_saldo_bajo") {
  return db.prepare("SELECT detail FROM admin_audit WHERE action = ? ORDER BY id").all(action);
}
async function limpiar() {
  await db.prepare("DELETE FROM admin_audit WHERE action IN ('twilio_saldo_bajo', 'twilio_saldo_sin_dato')").run();
  await db.prepare("DELETE FROM admin_audit WHERE action = 'error_servidor' AND detail LIKE 'twilioSaldo%'").run();
}

async function main() {
  await limpiar();
  check("mínimo por defecto 6", saldo.minimo() === 6, saldo.minimo());

  // Twilio no contesta al arrancar: una falla suelta no es alarma.
  saldo._reset();
  let s = await saldo.checkNow(offline);
  check("1a falla al inicio: pendiente, sin alarma", s.status === "pendiente" && saldo.twilioHealth().alert === false, s);

  // Saldo bueno.
  s = await saldo.checkNow(fakeTwilio("11.80"));
  check("$11.80 → ok", s.status === "ok" && s.balance === 11.8, s);
  check("ok: sin alarma", saldo.twilioHealth().alert === false);
  check("pregunta a la cuenta correcta", calls.at(-1).url === "https://api.twilio.com/2010-04-01/Accounts/ACprueba/Balance.json", calls.at(-1));
  check("manda la clave", calls.at(-1).auth === "Basic " + Buffer.from("ACprueba:token-prueba").toString("base64"));

  // La clave deja de servir: 1 falla sigue ok; 2 seguidas → alarma + anotación.
  s = await saldo.checkNow(fakeTwilio(null, 401));
  check("clave mala 1 vez: sigue ok", s.status === "ok" && saldo.twilioHealth().alert === false, s);
  s = await saldo.checkNow(fakeTwilio(null, 401));
  check("clave mala 2 veces: sin_dato con alarma", s.status === "sin_dato" && saldo.twilioHealth().alert === true, s);
  let sd = await avisos("twilio_saldo_sin_dato");
  check("anota que no se pudo leer", sd.length === 1 && /401/.test(sd[0].detail), sd);
  await saldo.checkNow(offline);
  sd = await avisos("twilio_saldo_sin_dato");
  check("sigue fallando: no repite anotación", sd.length === 1, sd);

  // Vuelve a leer: se apaga la alarma.
  s = await saldo.checkNow(fakeTwilio("6.00"));
  check("$6.00 (justo el mínimo) → ok", s.status === "ok" && saldo.twilioHealth().alert === false, s);

  // $5.99 sí es bajo.
  s = await saldo.checkNow(fakeTwilio("5.99"));
  check("$5.99 → bajo con alarma", s.status === "bajo" && saldo.twilioHealth().alert === true, s);
  let a = await avisos();
  check("una anotación en Movimientos", a.length === 1 && /5\.99 USD/.test(a[0].detail) && /mínimo 6\)/.test(a[0].detail), a);

  // Sigue bajo: no se repite.
  await saldo.checkNow(fakeTwilio("4.10"));
  check("sigue bajo: no repite anotación", (await avisos()).length === 1);

  // Deploy/reinicio con el saldo bajo: tampoco se repite (ya hay una de hoy).
  saldo._reset();
  s = await saldo.checkNow(fakeTwilio("4.00"));
  a = await avisos();
  check("reinicio con saldo bajo: sigue bajo sin repetir", s.status === "bajo" && a.length === 1, a);

  // Una falla suelta estando bajo no apaga la alarma.
  s = await saldo.checkNow(offline);
  check("falla estando bajo: sigue bajo", s.status === "bajo" && s.balance === 4 && saldo.twilioHealth().alert === true, s);

  // Recargó: vuelve a ok.
  s = await saldo.checkNow(fakeTwilio("26.00"));
  check("recargó → ok", s.status === "ok" && saldo.twilioHealth().alert === false, s);

  // Mínimo cambiado desde Render.
  process.env.TWILIO_SALDO_MINIMO = "10";
  s = await saldo.checkNow(fakeTwilio("8.00"));
  check("mínimo 10: $8 es bajo", s.status === "bajo", s);
  process.env.TWILIO_SALDO_MINIMO = "abc";
  check("mínimo inválido → 6", saldo.minimo() === 6);

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

  // Limpia lo que creó la prueba. Las anotaciones de error se escriben sin
  // esperar: se espera a que aparezca la de esta prueba (máx. 10 s).
  for (let i = 0; i < 50; i++) {
    const e = await db.prepare("SELECT 1 FROM admin_audit WHERE action = 'error_servidor' AND detail LIKE 'twilioSaldo%' LIMIT 1").get();
    if (e) break;
    await new Promise((r) => setTimeout(r, 200));
  }
  await limpiar();

  console.log(fail ? `\n✗ ${fail} mal, ${pass} bien` : `\n✓ ${pass} bien`);
  process.exit(fail ? 1 : 0);
}

main().catch((e) => {
  console.error("Error:", e);
  process.exit(1);
});
