const { FOUNDER_SLOTS } = require("./constants");

// Insignia de "chofer fundador": los primeros FOUNDER_SLOTS choferes de cada
// ciudad por fecha de alta, sin contar cuentas de prueba (es_prueba) ni
// choferes borrados. Se recalcula completo (no solo se agrega) para que al
// marcar una cuenta como prueba, su lugar pase al siguiente chofer real.
// Idempotente: correrlo varias veces siempre da el mismo resultado.
function recomputeFounders(db) {
  db.prepare(
    `UPDATE drivers SET es_fundador = CASE WHEN id IN (
       SELECT id FROM (
         SELECT id, ROW_NUMBER() OVER (PARTITION BY city ORDER BY created_at ASC, id ASC) AS rn
         FROM drivers WHERE deleted_at IS NULL AND es_prueba = 0
       ) WHERE rn <= ?
     ) THEN 1 ELSE 0 END`
  ).run(FOUNDER_SLOTS);
}

module.exports = { recomputeFounders };
