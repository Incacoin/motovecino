const fs = require("node:fs");
const path = require("node:path");

const DATA_DIR = path.join(__dirname, "data");
const BACKUP_REPO = process.env.BACKUP_GITHUB_REPO;
const BACKUP_TOKEN = process.env.BACKUP_GITHUB_TOKEN;
const APP_NAME = process.env.BACKUP_APP_NAME || "motoyatekax";

const SKIP_SUFFIXES = [".db-journal", ".db-wal", ".db-shm"];

let lastSuccessAt = null;
let lastAttemptAt = null;
let lastError = null;

function listFilesRecursive(dir, base = dir) {
  let out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      out = out.concat(listFilesRecursive(full, base));
    } else if (entry.isFile() && !SKIP_SUFFIXES.some((s) => entry.name.endsWith(s))) {
      out.push(path.relative(base, full).split(path.sep).join("/"));
    }
  }
  return out;
}

async function putFile(relPath, content, weekday) {
  const target = `${APP_NAME}/backup-${weekday}/${relPath}`;
  const apiUrl = `https://api.github.com/repos/${BACKUP_REPO}/contents/${target}`;
  const headers = {
    Authorization: `Bearer ${BACKUP_TOKEN}`,
    "User-Agent": "motoya-backup",
  };

  let sha;
  const existing = await fetch(apiUrl, { headers });
  if (existing.ok) {
    sha = (await existing.json()).sha;
  }

  const res = await fetch(apiUrl, {
    method: "PUT",
    headers: { ...headers, "Content-Type": "application/json" },
    body: JSON.stringify({
      message: `Respaldo automático ${APP_NAME} — ${weekday} ${new Date().toISOString()}`,
      content,
      sha,
    }),
  });

  if (!res.ok) {
    throw new Error(`${target}: ${res.status} ${await res.text()}`);
  }
}

// Sube un archivo solo si no está ya en el respaldo (fotos del menú).
async function putOnce(relPath) {
  const target = `${APP_NAME}/${relPath}`;
  const apiUrl = `https://api.github.com/repos/${BACKUP_REPO}/contents/${target}`;
  const headers = { Authorization: `Bearer ${BACKUP_TOKEN}`, "User-Agent": "motoya-backup" };
  if ((await fetch(apiUrl, { headers })).ok) return;
  const res = await fetch(apiUrl, {
    method: "PUT",
    headers: { ...headers, "Content-Type": "application/json" },
    body: JSON.stringify({
      message: `Foto del menú ${APP_NAME}`,
      content: fs.readFileSync(path.join(DATA_DIR, relPath)).toString("base64"),
    }),
  });
  if (!res.ok) throw new Error(`${target}: ${res.status} ${await res.text()}`);
}

// Fotos de choferes y pasajeros (data/img/, ver imageStore.js): una carpeta
// fija en GitHub que se deja IGUAL al disco — sube las nuevas y borra las que
// ya no están (alguien cambió su foto o se borró la cuenta), para que una foto
// quitada no se quede guardada para siempre en el respaldo. Devuelve cuántas
// operaciones fallaron.
async function syncImages() {
  const imgDir = path.join(DATA_DIR, "img");
  const local = fs.existsSync(imgDir)
    ? fs.readdirSync(imgDir).filter((n) => /^[a-f0-9]{32}\.(jpg|png|webp)$/.test(n))
    : [];
  const headers = { Authorization: `Bearer ${BACKUP_TOKEN}`, "User-Agent": "motoya-backup" };
  const api = `https://api.github.com/repos/${BACKUP_REPO}`;

  const repo = await fetch(api, { headers });
  if (!repo.ok) throw new Error(`repo: ${repo.status}`);
  const branch = (await repo.json()).default_branch;
  const treeRes = await fetch(`${api}/git/trees/${branch}?recursive=1`, { headers });
  if (!treeRes.ok) throw new Error(`tree: ${treeRes.status}`);
  const tree = await treeRes.json();
  const prefix = `${APP_NAME}/img/`;
  const remote = new Map(
    tree.tree.filter((e) => e.type === "blob" && e.path.startsWith(prefix)).map((e) => [e.path.slice(prefix.length), e.sha])
  );

  let failed = 0;
  for (const name of local) {
    if (remote.has(name)) continue;
    try {
      const res = await fetch(`${api}/contents/${prefix}${name}`, {
        method: "PUT",
        headers: { ...headers, "Content-Type": "application/json" },
        body: JSON.stringify({ message: `Foto ${APP_NAME}`, content: fs.readFileSync(path.join(imgDir, name)).toString("base64") }),
      });
      if (!res.ok) throw new Error(`${res.status} ${await res.text()}`);
    } catch (err) {
      failed++;
      console.error(`[backup] fallo al subir img/${name}:`, err.message);
    }
  }
  // Si GitHub cortó la lista (repo enorme) no se borra nada: mejor sobrar que
  // borrar una foto que sí existe.
  if (!tree.truncated) {
    const localSet = new Set(local);
    for (const [name, sha] of remote) {
      if (localSet.has(name)) continue;
      try {
        const res = await fetch(`${api}/contents/${prefix}${name}`, {
          method: "DELETE",
          headers: { ...headers, "Content-Type": "application/json" },
          body: JSON.stringify({ message: `Foto quitada ${APP_NAME}`, sha }),
        });
        if (!res.ok) throw new Error(`${res.status} ${await res.text()}`);
      } catch (err) {
        failed++;
        console.error(`[backup] fallo al quitar img/${name}:`, err.message);
      }
    }
  }
  return failed;
}

async function backupOnce() {
  if (!BACKUP_REPO || !BACKUP_TOKEN) {
    console.warn("[backup] BACKUP_GITHUB_REPO/BACKUP_GITHUB_TOKEN no configurados — respaldo desactivado");
    return;
  }
  if (!fs.existsSync(DATA_DIR)) return;

  lastAttemptAt = new Date().toISOString();

  const weekday = new Date()
    .toLocaleDateString("en-US", { weekday: "short", timeZone: "America/Merida" })
    .toLowerCase();
  // data/img/ va aparte (syncImages), no en las copias por día.
  const files = listFilesRecursive(DATA_DIR).filter((f) => !f.startsWith("img/"));

  let ok = 0;
  let firstError = null;
  let imgFailed = 0;
  try {
    imgFailed = await syncImages();
  } catch (err) {
    imgFailed = 1;
    console.error("[backup] fallo en fotos (img/):", err.message);
  }
  if (imgFailed) firstError = "fotos img/";
  for (const relPath of files) {
    try {
      // Fotos del menú (data/menu/): su nombre sale de su contenido y nunca
      // cambian, así que se respaldan UNA vez en una carpeta fija en vez de
      // volver a subir cada foto 4 veces al día en cada copia por día.
      if (relPath.startsWith("menu/")) {
        await putOnce(relPath);
        ok++;
        continue;
      }
      const content = fs.readFileSync(path.join(DATA_DIR, relPath)).toString("base64");
      await putFile(relPath, content, weekday);
      ok++;
    } catch (err) {
      firstError = err.message;
      console.error(`[backup] fallo en ${relPath}:`, err.message);
    }
  }
  console.log(`[backup] respaldo "${weekday}" completado (${ok}/${files.length} archivo(s))`);

  if (files.length > 0 && ok === files.length && !imgFailed) {
    lastSuccessAt = new Date().toISOString();
    lastError = null;
  } else {
    lastError = firstError || "sin archivos que respaldar";
  }
}

function startBackupSchedule(intervalHours = 6) {
  backupOnce();
  setInterval(backupOnce, intervalHours * 60 * 60 * 1000);
}

// No incluye lastError a propósito: trae rutas de archivo internas y
// respuestas crudas de la API de GitHub, y el único consumidor es el
// endpoint público /api/backup-health (sin auth, lo pega UptimeRobot).
// El detalle completo del error ya queda en los logs del servidor
// (console.error arriba, en backupOnce).
function getBackupStatus() {
  return {
    configured: Boolean(BACKUP_REPO && BACKUP_TOKEN),
    lastSuccessAt,
    lastAttemptAt,
  };
}

module.exports = { startBackupSchedule, backupOnce, getBackupStatus };
