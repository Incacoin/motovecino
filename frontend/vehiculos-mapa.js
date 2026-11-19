// Vehículos del mapa (30-sep-2026): motocarro y taxi vistos desde arriba, que
// giran hacia donde va el chofer, y los dibujos de lado para las tarjetas. Los
// usan pasajero.html y chofer.html. Dibujos propios (sin marca), hechos a partir
// de los motocarros de pasaje que se usan en Tekax.
(function () {
  let uid = 0;
  const dark = () => document.documentElement.dataset.theme === "dark";
  // Verde esmeralda de MotoVecino: más claro de noche, más oscuro de día (se lee al sol).
  const motoColors = () => (dark() ? { body: "#4ade80", bodyDark: "#16a34a" } : { body: "#22c55e", bodyDark: "#15803d" });

  // Motocarro desde arriba (pulido 19-nov-2026, estilo Uber): la misma forma de
  // antes (toldo negro y nariz pintada) pero más limpia: orilla blanca fina para
  // que resalte en el mapa oscuro o claro, sin espejitos (en chico parecían
  // manchas), sombra suave y el haz del faro hacia adelante. El frente apunta hacia abajo (+y).
  function motoTop({ body, bodyDark }) {
    const u = "vm" + ++uid;
    return `<defs>
<linearGradient id="${u}b" x1="0" y1="0" x2="1" y2="0"><stop offset="0" stop-color="${bodyDark}"/><stop offset=".5" stop-color="${body}"/><stop offset="1" stop-color="${bodyDark}"/></linearGradient>
<linearGradient id="${u}r" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#2a2d33"/><stop offset="1" stop-color="#111316"/></linearGradient>
<radialGradient id="${u}l" cx=".5" cy="0" r="1"><stop offset="0" stop-color="rgba(254,240,170,.55)"/><stop offset="1" stop-color="rgba(254,240,170,0)"/></radialGradient>
<filter id="${u}f" x="-60%" y="-60%" width="220%" height="220%"><feGaussianBlur stdDeviation="3"/></filter></defs>
<path d="M-7 23 L7 23 L13 40 L-13 40 Z" fill="url(#${u}l)"/>
<ellipse cx="0" cy="3" rx="15" ry="25" fill="rgba(0,0,0,.28)" filter="url(#${u}f)"/>
<path d="M-12.5 -21.5 Q-12.5 -24 -10 -24 L10 -24 Q12.5 -24 12.5 -21.5 L12.5 6 Q12.5 17.5 5 22 Q0 24.6 -5 22 Q-12.5 17.5 -12.5 6 Z" fill="#fff"/>
<path d="M-11 -21 Q-11 -22.6 -9.4 -22.6 L9.4 -22.6 Q11 -22.6 11 -21 L11 6 Q11 16.6 4.4 20.6 Q0 22.8 -4.4 20.6 Q-11 16.6 -11 6 Z" fill="url(#${u}b)"/>
<rect x="-9.6" y="-21.2" width="19.2" height="25" rx="3.5" fill="url(#${u}r)"/>
<path d="M-7.5 -19.5 H7.5" stroke="rgba(255,255,255,.18)" stroke-width="1.4" stroke-linecap="round"/>
<path d="M-8.4 7 Q0 9 8.4 7 L7.4 11.6 Q0 12.8 -7.4 11.6 Z" fill="#0f172a"/>
<path d="M-5 8.6 Q-1.5 9.4 1.5 9" stroke="rgba(255,255,255,.5)" stroke-width="1" fill="none" stroke-linecap="round"/>
<circle cx="0" cy="19.4" r="1.9" fill="#fef3c7"/>`;
  }

  // Taxi desde arriba: parabrisas, vidrio trasero, letrero en el techo, faros y calaveras.
  function taxiTop({ body = "#f8fafc", bodyDark = "#cbd0d6", sign = "#22c55e", glass = "#111820" }) {
    const u = "vt" + ++uid;
    return `<defs><linearGradient id="${u}b" x1="0" y1="0" x2="1" y2="0"><stop offset="0" stop-color="${bodyDark}"/><stop offset=".5" stop-color="${body}"/><stop offset="1" stop-color="${bodyDark}"/></linearGradient>
<filter id="${u}f" x="-50%" y="-50%" width="200%" height="200%"><feGaussianBlur stdDeviation="2.2"/></filter></defs>
<ellipse cx="1" cy="3" rx="11" ry="22" fill="rgba(0,0,0,.35)" filter="url(#${u}f)"/>
<rect x="-12" y="-16" width="3.5" height="8" rx="1.7" fill="#0b0b0d"/><rect x="8.5" y="-16" width="3.5" height="8" rx="1.7" fill="#0b0b0d"/>
<rect x="-12" y="9" width="3.5" height="8" rx="1.7" fill="#0b0b0d"/><rect x="8.5" y="9" width="3.5" height="8" rx="1.7" fill="#0b0b0d"/>
<rect x="-10" y="-21" width="20" height="42" rx="7" fill="url(#${u}b)"/>
<path d="M-8 6 L8 6 L7 11 L-7 11 Z" fill="${glass}"/>
<path d="M-7 -12 L7 -12 L8 -8 L-8 -8 Z" fill="${glass}"/>
<rect x="-7.5" y="-8" width="15" height="14" rx="3" fill="${body}"/>
<rect x="-3.5" y="-2.5" width="7" height="3.5" rx="1" fill="${sign}"/>
<circle cx="-6" cy="19" r="1.6" fill="#fde68a"/><circle cx="6" cy="19" r="1.6" fill="#fde68a"/>
<rect x="-8" y="-20.5" width="4" height="1.6" rx=".8" fill="#ef4444"/><rect x="4" y="-20.5" width="4" height="1.6" rx=".8" fill="#ef4444"/>`;
  }

  // Motocarro de lado (tarjeta del chofer): cabina con parabrisas grande, faro al
  // centro, una rueda adelante, puerta abierta con asiento y toldo de lona. Mira a la izquierda.
  function motoSide(w = 110) {
    const { body, bodyDark } = motoColors();
    const u = "vs" + ++uid;
    const W = `url(#${u}w)`;
    return `<svg width="${w}" viewBox="0 0 240 160" aria-hidden="true"><defs>
<linearGradient id="${u}s" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${body}"/><stop offset=".55" stop-color="${body}"/><stop offset="1" stop-color="${bodyDark}"/></linearGradient>
<linearGradient id="${u}c" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#3a3a40"/><stop offset=".35" stop-color="#1d1d22"/><stop offset="1" stop-color="#0b0b0d"/></linearGradient>
<linearGradient id="${u}gl" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#5b6675"/><stop offset=".45" stop-color="#18202b"/><stop offset="1" stop-color="#0a0e14"/></linearGradient>
<radialGradient id="${u}w" cx=".5" cy=".5" r=".5"><stop offset=".48" stop-color="#d1d5db"/><stop offset=".56" stop-color="#4b5563"/><stop offset=".68" stop-color="#111"/><stop offset="1" stop-color="#030303"/></radialGradient>
<radialGradient id="${u}sh" cx=".5" cy=".5" r=".5"><stop offset="0" stop-color="rgba(0,0,0,.5)"/><stop offset="1" stop-color="rgba(0,0,0,0)"/></radialGradient></defs>
<ellipse cx="128" cy="147" rx="104" ry="10" fill="url(#${u}sh)"/>
<path d="M58 31 Q60 20 73 20 L212 18 Q223 18 224 30 L224 82 L197 84 L197 33 L96 34 Z" fill="url(#${u}c)"/>
<path d="M100 36 L197 34 L197 118 L100 118 Z" fill="#0c0f14"/>
<path d="M162 58 L178 57 L178 100 L162 101 Z" fill="#2c2c31"/><path d="M122 96 L180 94 L180 106 L122 108 Z" fill="#35353b"/>
<path d="M150 124 L150 84 L228 80 Q232 80 232 88 L232 116 Q232 125 223 125 Z" fill="url(#${u}s)"/>
<ellipse cx="184" cy="126" rx="21" ry="15" fill="${bodyDark}"/>
<rect x="98" y="116" width="54" height="10" rx="2" fill="url(#${u}s)"/><rect x="148" y="33" width="4" height="52" fill="#141417"/>
<path d="M34 108 Q28 90 35 70 L46 40 Q50 30 63 28 L98 27 L102 108 Z" fill="url(#${u}s)"/>
<path d="M48 45 Q52 35 63 34 L90 33 L92 66 L42 70 Z" fill="url(#${u}gl)"/>
<path d="M52 44 Q56 38 64 37" stroke="rgba(255,255,255,.45)" stroke-width="2.5" fill="none" stroke-linecap="round"/>
<path d="M52 36 L42 26" stroke="#141417" stroke-width="2.5" stroke-linecap="round"/><rect x="34" y="16" width="10" height="12" rx="3" fill="#141417"/>
<rect x="29" y="78" width="28" height="15" rx="7" fill="#101012"/><ellipse cx="43" cy="85.5" rx="8" ry="5" fill="#fef3c7"/>
<path d="M36 99 L230 94" stroke="#e5e7eb" stroke-width="2.6" stroke-linecap="round" opacity=".85"/>
<ellipse cx="44" cy="134" rx="13" ry="15" fill="${W}"/><path d="M28 124 Q30 110 44 110 Q58 110 60 124 Z" fill="url(#${u}s)"/>
<ellipse cx="184" cy="130" rx="15" ry="17" fill="${W}"/><rect x="228" y="88" width="5" height="10" rx="2" fill="#ef4444"/></svg>`;
  }

  // Taxi de lado (tarjeta del chofer).
  function taxiSide(w = 118) {
    const u = "vx" + ++uid;
    return `<svg width="${w}" viewBox="0 0 240 130" aria-hidden="true"><defs>
<linearGradient id="${u}s" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#f8fafc"/><stop offset=".55" stop-color="#c7ccd3"/><stop offset="1" stop-color="#8b929b"/></linearGradient>
<linearGradient id="${u}gl" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#3b4452"/><stop offset=".45" stop-color="#11161d"/><stop offset="1" stop-color="#0a0d12"/></linearGradient>
<radialGradient id="${u}w" cx=".5" cy=".5" r=".5"><stop offset=".5" stop-color="#d1d5db"/><stop offset=".58" stop-color="#374151"/><stop offset=".7" stop-color="#111"/><stop offset="1" stop-color="#030303"/></radialGradient>
<radialGradient id="${u}sh" cx=".5" cy=".5" r=".5"><stop offset="0" stop-color="rgba(0,0,0,.5)"/><stop offset="1" stop-color="rgba(0,0,0,0)"/></radialGradient></defs>
<ellipse cx="122" cy="114" rx="108" ry="13" fill="url(#${u}sh)"/>
<path d="M16 82 Q14 66 34 62 L64 58 Q84 36 108 34 L160 32 Q178 32 192 48 L206 58 Q224 62 226 76 L226 90 Q226 96 218 96 L24 104 Q16 104 16 96 Z" fill="url(#${u}s)"/>
<path d="M80 58 Q94 44 110 42 L130 41 L130 58 Z" fill="url(#${u}gl)"/><path d="M136 41 L156 40 Q170 40 180 52 L136 57 Z" fill="url(#${u}gl)"/>
<path d="M20 80 L224 72" stroke="#22c55e" stroke-width="5"/>
<path d="M18 76 Q20 70 30 68 L32 76 Z" fill="#fef3c7"/><path d="M220 70 L226 70 L226 78 L218 78 Z" fill="#ef4444"/>
<path d="M112 26 L146 25 L148 34 L110 35 Z" fill="#22c55e"/><text x="129" y="33" text-anchor="middle" style="font:800 8px Arial" fill="#fff">TAXI</text>
<ellipse cx="58" cy="102" rx="15" ry="18" fill="url(#${u}w)"/><ellipse cx="190" cy="98" rx="15" ry="18" fill="url(#${u}w)"/></svg>`;
  }

  // Ícono de Leaflet con el vehículo visto desde arriba. El giro vive en el
  // <div class="veh"> de adentro (Leaflet usa el transform de afuera para ubicarlo).
  function vehIcon(kind) {
    const inner = kind === "taxi" ? taxiTop({}) : motoTop(motoColors());
    return L.divIcon({
      className: "veh-icon",
      html: `<div class="veh"><svg width="46" height="46" viewBox="-32 -32 64 64" style="overflow:visible">${inner}</svg></div>`,
      iconSize: [46, 46],
      iconAnchor: [23, 23],
    });
  }

  // --- Deslizado suave (19-nov-2026) ---
  // Antes la moto brincaba de punto en punto cada vez que llegaba el GPS y,
  // si el siguiente tardaba, se veía la pausa y luego el salto ("no inspira
  // confianza"). Ahora se desliza a velocidad pareja hasta el punto nuevo en
  // el mismo tiempo que tardó en llegar ese punto (como Uber): va ~1 s atrás
  // de la posición real en el viaje y ~4 s en el mapa de motos libres.
  const GLIDE_MIN_MS = 300;
  const GLIDE_MAX_MS = 4500;
  const JUMP_M = 400; // más que esto = se reconectó o cambió mucho: se pone directo
  const JITTER_M = 2; // temblor del GPS con la moto parada: no se mueve
  const gliding = new Set();
  let frame = 0;
  const metersBetween = (a, b) => {
    const dy = b.lat - a.lat;
    const dx = (b.lng - a.lng) * Math.cos((a.lat * Math.PI) / 180);
    return Math.sqrt(dx * dx + dy * dy) * 111320;
  };
  function tick(now) {
    frame = 0;
    for (const m of gliding) {
      const g = m._vehGlide;
      if (!m._map) { gliding.delete(m); continue; }
      // Mientras el mapa hace zoom Leaflet acomoda los marcadores solo.
      if (m._map._animatingZoom) continue;
      const t = Math.min(1, (now - g.start) / g.ms);
      m.setLatLng([g.from.lat + (g.to.lat - g.from.lat) * t, g.from.lng + (g.to.lng - g.from.lng) * t]);
      applyRot(m);
      if (t >= 1) gliding.delete(m);
    }
    if (gliding.size) frame = requestAnimationFrame(tick);
  }
  function glideTo(marker, lat, lng) {
    const now = performance.now();
    const gap = marker._vehAt ? now - marker._vehAt : 1000;
    marker._vehAt = now;
    const from = marker.getLatLng();
    const dist = metersBetween(from, { lat, lng });
    if (dist < JITTER_M && !gliding.has(marker)) return;
    if (document.hidden || dist > JUMP_M || !marker._map) {
      gliding.delete(marker);
      marker.setLatLng([lat, lng]);
      return;
    }
    marker._vehGlide = { from: { lat: from.lat, lng: from.lng }, to: { lat, lng }, start: now, ms: Math.max(GLIDE_MIN_MS, Math.min(GLIDE_MAX_MS, gap)) };
    gliding.add(marker);
    if (!frame) frame = requestAnimationFrame(tick);
  }
  function applyRot(marker) {
    // Leaflet puede volver a crear el ícono: el giro se aplica siempre.
    const el = marker.getElement && marker.getElement();
    const veh = el && el.querySelector(".veh");
    if (veh && marker._vehRot != null) veh.style.transform = `rotate(${marker._vehRot}deg)`;
  }

  // Mueve el marcador y lo gira hacia donde avanza. El rumbo se mide desde el
  // último punto donde giró (no desde el punto anterior): el GPS llega cada
  // segundo y un mototaxi avanza ~5 m por segundo, así que comparando punto
  // contra punto nunca pasaba del umbral y no giraba. Con menos de ~8 m desde
  // ese punto no cambia (el GPS tiembla aunque el vehículo esté parado).
  function moveVeh(marker, lat, lng) {
    const anchor = marker._vehAnchor || marker.getLatLng();
    const dy = lat - anchor.lat;
    const dx = (lng - anchor.lng) * Math.cos((lat * Math.PI) / 180);
    const meters = Math.sqrt(dx * dx + dy * dy) * 111320;
    if (!marker._vehAnchor) marker._vehAnchor = { lat: anchor.lat, lng: anchor.lng };
    if (meters > 8) {
      const bearing = (Math.atan2(dx, dy) * 180) / Math.PI; // 0 = norte, 90 = este
      // El dibujo mira hacia el sur. Se gira por el lado más corto (sin dar la vuelta completa).
      let rot = bearing + 180;
      if (marker._vehRot != null) {
        while (rot - marker._vehRot > 180) rot -= 360;
        while (rot - marker._vehRot < -180) rot += 360;
      }
      marker._vehRot = rot;
      marker._vehAnchor = { lat, lng };
    }
    glideTo(marker, lat, lng);
    applyRot(marker);
  }

  window.MVVeh = { vehIcon, moveVeh, motoSide, taxiSide };
})();
