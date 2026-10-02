// Buscador de calles y lugares (2-oct). Lo usan la app del pasajero y "Mi
// negocio". Entiende cómo se dan las direcciones aquí: "50 x 47" (cruce),
// "50 x 47 y 49" (la 50 entre la 47 y la 49), "50" (los cruces de la 50) y
// lugares por nombre ("mercado", "Kancab"). Los datos son un archivo por
// pueblo en /lugares/ (ver backend/tools/gen-lugares.js), sin servicios de pago.
(function () {
let placeData = null, placeDataCity = null, placeDataLoading = null;

function normText(t) {
  return (t || "").toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/\s+/g, " ").trim();
}

function load(city) {
  if (placeData && placeDataCity === city) return Promise.resolve(placeData);
  if (placeDataLoading) return placeDataLoading;
  placeDataLoading = fetch("/lugares/" + city + ".json")
    .then((r) => (r.ok ? r.json() : Promise.reject()))
    .catch(() => ({ cruces: {}, lugares: [] }))
    .then((data) => {
      const cruces = {};
      for (const [k, p] of Object.entries(data.cruces || {})) {
        const [a, b] = k.split("x");
        (cruces[a] = cruces[a] || {})[b] = p;
        (cruces[b] = cruces[b] || {})[a] = p;
      }
      const lugares = (data.lugares || []).map((l) => ({ ...l, k: normText(l.n) }));
      placeData = { cruces, lugares };
      placeDataCity = city;
      placeDataLoading = null;
      return placeData;
    });
  return placeDataLoading;
}

const PS_ICONS = {
  cruce: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M12 3v18M3 12h18"/></svg>',
  lugar: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 21s-7-6.5-7-12a7 7 0 0 1 14 0c0 5.5-7 12-7 12z"/><circle cx="12" cy="9" r="2.5"/></svg>',
  pueblo: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 21h18M5 21V10l7-5 7 5v11M10 21v-5h4v5"/></svg>',
};

function placeMatches(query, data) {
  const q = normText(query);
  if (!q) return [];
  const out = [];
  // Números: "50 x 47", "50 por 47", "esquina 50 y 47", "calle 50 x 47 y 49", "50", "50 x 4"
  const nq = q.replace(/\bc\.|\besq\b\.?|\b(calle|calles|esquina|entre|cruce|cruzamiento)\b/g, " ").replace(/[x×*,#]/g, " x ").replace(/\b(por|con)\b/g, " x ");
  const m = /^\s*(\d{1,3})\s*(?:x\s*)?(?:(?:y\s*)?(\d{1,3}))?\s*(?:(?:x|y|e)\s*(\d{1,3}))?\s*(x)?\s*$/.exec(nq);
  if (m) {
    const [, a, b, c] = m;
    const row = data.cruces[a] || {};
    if (b && c && row[b] && row[c]) {
      const p1 = row[b], p2 = row[c];
      out.push({ label: `Calle ${a} entre ${b} y ${c}`, sub: "A media cuadra", t: "cruce", p: [(p1[0] + p2[0]) / 2, (p1[1] + p2[1]) / 2] });
    }
    if (b && row[b]) out.push({ label: `Calle ${a} x ${b}`, sub: "Esquina", t: "cruce", p: row[b] });
    if (!c) {
      const others = Object.keys(row).filter((o) => o !== b && (!b || o.startsWith(b))).sort((x, y) => x - y);
      for (const o of others.slice(0, 8)) out.push({ label: `Calle ${a} x ${o}`, sub: "Esquina", t: "cruce", p: row[o] });
    }
  }
  // Lugares por nombre: todas las palabras deben aparecer; primero los que empiezan igual.
  if (q.length >= 2 && !/^\d+$/.test(q)) {
    const words = q.split(" ");
    const hits = data.lugares.filter((l) => words.every((w) => l.k.includes(w)));
    hits.sort((x, y) => (y.k.startsWith(q) - x.k.startsWith(q)) || x.n.length - y.n.length);
    for (const l of hits.slice(0, 8)) {
      out.push({ label: l.n, sub: l.t === "pueblo" ? "Comisaría o pueblo cercano" : l.t === "colonia" ? "Colonia" : "Lugar", t: l.t === "pueblo" ? "pueblo" : "lugar", p: l.p });
    }
  }
  return out.slice(0, 10);
}


window.MVBuscador = { load, matches: placeMatches, normText, ICONS: PS_ICONS };
})();
