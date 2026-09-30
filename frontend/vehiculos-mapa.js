// Vehículos del mapa (30-sep-2026): motocarro y taxi vistos desde arriba, que
// giran hacia donde va el chofer, y los dibujos de lado para las tarjetas. Los
// usan pasajero.html y chofer.html. Dibujos propios (sin marca), hechos a partir
// de los motocarros de pasaje que se usan en Tekax.
(function () {
  let uid = 0;
  const dark = () => document.documentElement.dataset.theme === "dark";
  // Verde esmeralda de MotoVecino: más claro de noche, más oscuro de día (se lee al sol).
  const motoColors = () => (dark() ? { body: "#34d399", bodyDark: "#047857" } : { body: "#10b981", bodyDark: "#047857" });

  // Motocarro desde arriba: toldo negro grande y la cabina pintada con nariz
  // redondeada, parabrisas, espejos y faro. El frente apunta hacia abajo (+y).
  function motoTop({ body, bodyDark, roof = "#1f1f23", light = "#fde68a" }) {
    const u = "vm" + ++uid;
    return `<defs><linearGradient id="${u}c" x1="0" y1="0" x2="1" y2="0"><stop offset="0" stop-color="#0d0d10"/><stop offset=".5" stop-color="${roof}"/><stop offset="1" stop-color="#0d0d10"/></linearGradient>
<linearGradient id="${u}b" x1="0" y1="0" x2="1" y2="0"><stop offset="0" stop-color="${bodyDark}"/><stop offset=".5" stop-color="${body}"/><stop offset="1" stop-color="${bodyDark}"/></linearGradient>
<linearGradient id="${u}g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#6b7684"/><stop offset=".5" stop-color="#1a222d"/><stop offset="1" stop-color="#0b1016"/></linearGradient>
<filter id="${u}f" x="-50%" y="-50%" width="200%" height="200%"><feGaussianBlur stdDeviation="2.2"/></filter></defs>
<ellipse cx="1" cy="2" rx="14" ry="24" fill="rgba(0,0,0,.35)" filter="url(#${u}f)"/>
<rect x="-14.5" y="-19" width="4" height="10" rx="2" fill="#0b0b0d"/><rect x="10.5" y="-19" width="4" height="10" rx="2" fill="#0b0b0d"/>
<rect x="-2" y="18" width="4" height="7" rx="2" fill="#0b0b0d"/>
<path d="M-12 -21 Q-12 -23 -10 -23 L10 -23 Q12 -23 12 -21 L12 6 Q12 17 5 21.5 Q0 24 -5 21.5 Q-12 17 -12 6 Z" fill="url(#${u}b)"/>
<path d="M-10.8 -22 L10.8 -22 L10.8 4 Q0 6.2 -10.8 4 Z" fill="url(#${u}c)"/>
<path d="M-4 -21 V3.5 M4 -21 V3.5" stroke="rgba(255,255,255,.07)" stroke-width="1"/>
<path d="M-9.5 -21 H9.5" stroke="rgba(255,255,255,.22)" stroke-width="1.2" stroke-linecap="round"/>
<path d="M-9.6 6 Q0 8.2 9.6 6 L8.4 11.5 Q0 13 -8.4 11.5 Z" fill="url(#${u}g)"/>
<path d="M-6 8 Q-2 9 1 8.6" stroke="rgba(255,255,255,.45)" stroke-width="1" fill="none" stroke-linecap="round"/>
<path d="M-11.5 7 L-14 5.5 M11.5 7 L14 5.5" stroke="#111" stroke-width="1.2"/><circle cx="-14.4" cy="5.2" r="1.7" fill="#111"/><circle cx="14.4" cy="5.2" r="1.7" fill="#111"/>
<circle cx="0" cy="20.6" r="1.8" fill="${light}"/><circle cx="0" cy="20.6" r="4.2" fill="${light}" opacity=".22"/>`;
  }

  // Taxi desde arriba: parabrisas, vidrio trasero, letrero en el techo, faros y calaveras.
  function taxiTop({ body = "#f8fafc", bodyDark = "#cbd0d6", sign = "#10b981", glass = "#111820" }) {
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
<path d="M20 80 L224 72" stroke="#10b981" stroke-width="5"/>
<path d="M18 76 Q20 70 30 68 L32 76 Z" fill="#fef3c7"/><path d="M220 70 L226 70 L226 78 L218 78 Z" fill="#ef4444"/>
<path d="M112 26 L146 25 L148 34 L110 35 Z" fill="#10b981"/><text x="129" y="33" text-anchor="middle" style="font:800 8px Arial" fill="#fff">TAXI</text>
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

  // Mueve el marcador y lo gira hacia donde avanzó. Con movimientos de menos de
  // ~6 m no cambia el giro (el GPS tiembla aunque el vehículo esté parado).
  function moveVeh(marker, lat, lng) {
    const prev = marker.getLatLng();
    const dy = lat - prev.lat;
    const dx = (lng - prev.lng) * Math.cos((lat * Math.PI) / 180);
    const meters = Math.sqrt(dx * dx + dy * dy) * 111320;
    if (meters > 6) {
      const bearing = (Math.atan2(dx, dy) * 180) / Math.PI; // 0 = norte, 90 = este
      marker._vehRot = bearing + 180; // el dibujo mira hacia el sur
      const el = marker.getElement && marker.getElement();
      const veh = el && el.querySelector(".veh");
      if (veh) veh.style.transform = `rotate(${marker._vehRot}deg)`;
    }
    marker.setLatLng([lat, lng]);
  }

  window.MVVeh = { vehIcon, moveVeh, motoSide, taxiSide };
})();
