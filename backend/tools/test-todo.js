// Corre TODAS las pruebas, una tras otra, contra una copia local (nunca producción).
//   npm test        (desde backend/, con la copia corriendo en BASE)
// Lee BASE, DATABASE_URL, RESTORE_URL y ADMIN_PIN_PROGRESO del ambiente o de backend/.env.
// Las que necesitan algo que falta se marcan "SALTADA" (no cuentan como bien).
const path = require("node:path");
const fs = require("node:fs");
const { spawnSync } = require("node:child_process");

const envFile = path.join(__dirname, "..", ".env");
if (fs.existsSync(envFile)) process.loadEnvFile(envFile);
process.env.BASE = process.env.BASE || "http://localhost:3077";
if (!/^https?:\/\/(localhost|127\.0\.0\.1)[:/]/.test(process.env.BASE)) {
  console.error("Esto solo se corre en localhost: " + process.env.BASE);
  process.exit(1);
}

const TESTS = [
  ["fechas", ["DATABASE_URL"]],
  ["flujo", []],
  ["propon", []],
  ["motivo", []],
  ["pedidos", []],
  ["registro-negocio", []],
  ["municipio-una-vez", []],
  ["sesion", []],
  ["clave", []],
  ["celestun", []],
  ["agendar", ["DATABASE_URL"]],
  ["agendar-oferta", ["DATABASE_URL"]],
  ["envio-asegurado", ["DATABASE_URL"]],
  ["mantenimiento", ["DATABASE_URL", "RESTORE_URL"]],
  ["progreso", ["ADMIN_PIN_PROGRESO"]],
];

const results = [];
for (const [name, needs] of TESTS) {
  const missing = needs.filter((v) => !process.env[v]);
  if (missing.length) {
    results.push([name, "SALTADA", "falta " + missing.join(", ")]);
    continue;
  }
  process.stdout.write(`… ${name} `);
  const r = spawnSync(process.execPath, [path.join(__dirname, `test-${name}.js`)], { encoding: "utf8", env: process.env, timeout: 300_000 });
  const out = (r.stdout || "") + (r.stderr || "");
  const last = out.trim().split("\n").filter((l) => /bien|iguales|✗|Error/.test(l)).pop() || "(sin resumen)";
  results.push([name, r.status === 0 ? "BIEN" : "MAL", last.trim()]);
  console.log(r.status === 0 ? "✓" : "✗");
  if (r.status !== 0) console.log(out.split("\n").filter((l) => l.startsWith("✗")).slice(0, 5).join("\n"));
}

console.log("\nResumen:");
for (const [n, s, d] of results) console.log(`  ${s.padEnd(7)} ${n.padEnd(14)} ${d}`);
const bad = results.filter((r) => r[1] === "MAL").length;
console.log(bad ? `\n✗ ${bad} prueba(s) fallaron — NO subir.` : "\n✓ Todo bien.");
process.exit(bad ? 1 : 0);
