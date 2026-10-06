const db = require("./db");

const drivers = [
  { name: "Chofer 1", phone: "9990000001", vehicle: "Mototaxi rojo", pin: "1111", vehicle_type: "moto" },
  { name: "Chofer 2", phone: "9990000002", vehicle: "Mototaxi azul", pin: "2222", vehicle_type: "moto" },
  { name: "Chofer 3", phone: "9990000003", vehicle: "Mototaxi verde", pin: "3333", vehicle_type: "moto" },
  { name: "Chofer 4", phone: "9990000004", vehicle: "Taxi blanco", pin: "4444", vehicle_type: "taxi" },
];

(async () => {
  await db.init();
  const insert = db.prepare(
    "INSERT OR IGNORE INTO drivers (name, phone, vehicle, pin, vehicle_type) VALUES (?, ?, ?, ?, ?)"
  );
  for (const d of drivers) {
    await insert.run(d.name, d.phone, d.vehicle, d.pin, d.vehicle_type);
  }
  console.log("Choferes de prueba listos. PINs: 1111, 2222, 3333 (moto), 4444 (taxi)");
  await db.close();
})();
