# MotoVecino — mapa del proyecto

App de mototaxis y taxis para municipios de Yucatán (lista en `cities.js`: Tekax, Ticul, Oxkutzcab, Akil, Celestún con registro cerrado y otros; Progreso apagado salvo `ENABLE_PROGRESO=1`).
Pasajero pide viaje → choferes cercanos lo ven → uno acepta → llega → viaje → completado. Además, envíos para negocios.
En línea: https://motovecinoapp.com (Render, servicio `motoyatekax`). Código: GitHub `Incacoin/motovecino`, rama `main`.

**Responder siempre en español, en palabras simples.** El dueño no es programador: explicar qué se va a hacer antes de hacerlo.

## Cómo está armado

- `backend/` — Node + Express + Postgres. Arranca en `server.js`.
  - `routes/rides.js` viajes (lo más delicado) · `drivers.js` choferes · `riders.js` pasajeros · `admin.js` panel
  · `orders.js` + `business.js` envíos de negocios · `support.js` ayuda · `passkeys.js` huella · `familyRides.js`
  - `realtime.js` WebSocket (avisos en vivo a choferes/pasajeros) · `livePos.js` ubicación en vivo · `push.js` notificaciones
  - `cities.js` municipios, zonas y radios · `constants.js` cuotas y fechas (SERVICE_FEE $2, comisión taxi 6 %, etc.) · `taxiFares.js`
  - `whatsappOtp.js` código por WhatsApp (Twilio) · `whatsappSupport.js` + `supportBot.js` bot de ayuda (Claude Haiku)
  - `db.js` conexión a Postgres que imita la forma de SQLite (ver reglas) · `schema.sql` tablas
  - `backup.js` respaldo cada pocas horas a GitHub `Incacoin/motoya-backup` · `tools/restore-backup.js` lo regresa
  - `pinRateLimit.js` límites contra fuerza bruta · `retention.js` anonimiza datos de más de 1 año · `errorAlerts.js` avisos de errores
- `frontend/` — HTML/JS plano, sin framework. `pasajero.html`, `chofer.html`, `admin.html`, `negocio.html`, `comida.html`. `sw.js` = app instalable (PWA).
- La app de Play Store es la misma web envuelta (TWA). Si se cambia `sw.js` o el manifest, revisar que siga instalando.

## Reglas que ya nos costaron errores

- **Toda consulta a la base lleva `await`** (`db.prepare(sql).get/all/run` regresa promesa).
- **Tabla nueva sin columna `id`** → agregarla a `NO_ID_TABLES` en `db.js`, si no el INSERT falla con error 500 en producción.
- SQL se escribe estilo SQLite (`?`, `datetime('now')`); `db.js` lo traduce a Postgres. Probar siempre contra Postgres.
- **Panel admin:** toda ruta nueva usa `checkAdminPin` y, si toca datos de un municipio, `assertOwnCity` (un admin de Ticul no debe ver Tekax).
- Nunca regresar al público el teléfono, PIN o ubicación exacta de otra persona (mapa de choferes = ubicación aproximada ~100 m).
- Cambio en el TEXTO del aviso legal o contrato → subir `AVISO_LEGAL_VERSION` en `constants.js`.
- El mototaxi ya es "Propón tu precio": crear viaje moto pide `dest_lat/dest_lng` y `offer_price`.
- Nunca poner claves en el código ni en `frontend/`. Van en variables de Render. `backend/.env` está en `.gitignore`.

## Cómo probar (SIEMPRE en copia, nunca contra producción)

1. Postgres local (embedded-postgres), base vacía, `ENCODING UTF8`.
2. `backend/.env` de prueba: `DATABASE_URL=postgres://...localhost.../mv_test`, `RESTORE_URL=...localhost.../mv_restore`, `ADMIN_PIN=prueba-...`, `PORT=3077`. Sin claves de Twilio (así no manda WhatsApp de verdad).
3. `node --env-file=.env server.js`, luego `node --env-file=.env seed.js`.
4. `npm test` (en `backend/`) corre todas las pruebas y dice "Todo bien" o "NO subir".
   - Correrlo UNA vez por arranque: si se repite muchas veces, los límites de seguridad responden 429.
   - `test-progreso` se salta si no hay `ADMIN_PIN_PROGRESO`; hoy está desactualizada (la zona cambió).
5. Para cambios visuales: copia en el puerto 3055 y el dueño la prueba en su celular antes de subir.
6. Apagar la copia y Postgres al terminar (la computadora tiene 8 GB de RAM).

## Antes de subir a producción (obligatorio)

1. `npm test` → "Todo bien".
2. `/code-review` sobre los cambios.
3. `/security-review` si se tocó dinero, PIN, login, admin, datos personales o fotos.
4. `npm audit --omit=dev` → sin fallas "high".
5. El dueño aprueba. Él mismo sube con `!` (git push / deploy en Render).
6. Después: revisar https://motovecinoapp.com/api/backup-health y que no lleguen avisos de error.

## Forma de trabajar

- Cada tarea en su propia rama y copia (`git worktree`, carpetas `Documents/MotoVecino-<tema>`). No tocar la carpeta principal si otra sesión trabaja ahí.
- Subir ramas terminadas pronto: las ramas que esperan semanas se vuelven difíciles de juntar.
- Cada función nueva que mueva dinero o viajes lleva su prueba en `backend/tools/test-*.js` y se agrega a `tools/test-todo.js`.
