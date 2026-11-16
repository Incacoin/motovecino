// Maqueta 3D del municipio para la página de inicio.
// Centro inspirado en Ticul: iglesia de San Antonio, parque con palmeras y letras de
// colores, casas coloniales con molduras blancas y balcones, y mototaxis de verdad.
// Al bajar con el dedo el mototaxi recorre 6 paradas: Muévete, Pide, Agenda, Aliados, Vende y Conoce (Uxmal).
// Todo se dibuja con figuras propias (sin modelos ni fotos de terceros).
// La página le pasa el avance (0 a 7) con getP(); aquí solo se dibuja.
import * as THREE from "three";

const C = {
  noche: 0x0a0c10, calle: 0x1a1d22, banqueta: 0x3a3f47, raya: 0x3a414c,
  verde: 0x22c55e, verdeClaro: 0x4ade80, crema: 0xf1e7d0, moldura: 0xf4efe4,
  terracota: 0xb8432f, amarillo: 0xe8c547, pasto: 0x1f4a2c, luz: 0xffcf7a,
};
// Colores de las casas del centro (terracota, salmón, amarillo, crema, azul, menta, rosa, naranja, blanco)
const CASAS = [0xc4493b, 0xd98a7c, 0xe2b54e, 0xe8d8b4, 0x7fb3c6, 0x8fc09d, 0xd59bb2, 0xe0894c, 0xf0ece2, 0xb85c8a];
const CALLES = [-40, -24, -8, 8, 24, 40];
const MANZANAS = [-32, -16, 0, 16, 32];

// Lugares importantes (puerta = punto en la calle donde se para el mototaxi)
export const LUGARES = {
  parada: { pos: [-21.6, 0, -30], puerta: [-24, -36] },
  casa: { pos: [-12.2, 0, 16], puerta: [-8, 16] },
  paisa: { pos: [12.1, 0, -16], puerta: [8, -16] },
  aliado: { pos: [16, 0, 12.1], puerta: [16, 8] },
};
// Recorridos del mototaxi por capítulo (1 Muévete, 2 Pide, 3 Agenda, 4 Aliados, 5 Vende, 6 Conoce: de El Paisa a Uxmal)
const RUTAS = {
  1: [[-24, -36], [-24, -8], [-8, -8], [-8, 16]],
  2: [[-8, 16], [-8, -8], [8, -8], [8, -16]],
  3: [[8, -16], [8, -8], [-8, -8], [-8, 16]],
  4: [[-8, 16], [-8, 8], [16, 8]],
  5: [[16, 8], [8, 8], [8, -16]],
  6: [[8, -16], [8, -24], [-34.5, -24], [-34.5, -27.4]],
};

function rng(seed) { return () => { seed |= 0; seed = (seed + 0x6d2b79f5) | 0; let t = Math.imul(seed ^ (seed >>> 15), 1 | seed); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const suave = (t) => t * t * (3 - 2 * t);

function letrero(texto, sub, fondo, color, w = 512, h = 160) {
  const c = document.createElement("canvas"); c.width = w; c.height = h;
  const x = c.getContext("2d");
  x.fillStyle = fondo; x.fillRect(0, 0, w, h);
  x.strokeStyle = color; x.lineWidth = 8; x.strokeRect(10, 10, w - 20, h - 20);
  x.fillStyle = color; x.textAlign = "center"; x.textBaseline = "middle";
  x.font = `800 ${sub ? 64 : 72}px Inter, Arial, sans-serif`; x.fillText(texto, w / 2, sub ? h / 2 + 18 : h / 2);
  if (sub) { x.font = "600 30px Inter, Arial, sans-serif"; x.fillText(sub, w / 2, 42); }
  const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace; t.anisotropy = 4; return t;
}
function rayas(a, b, n = 8) {
  const c = document.createElement("canvas"); c.width = 256; c.height = 64;
  const x = c.getContext("2d");
  for (let i = 0; i < n; i++) { x.fillStyle = i % 2 ? b : a; x.fillRect((i * 256) / n, 0, 256 / n + 1, 64); }
  const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace; return t;
}
function brilloTex() {
  const c = document.createElement("canvas"); c.width = c.height = 128;
  const x = c.getContext("2d"); const g = x.createRadialGradient(64, 64, 0, 64, 64, 64);
  g.addColorStop(0, "rgba(255,255,255,1)"); g.addColorStop(0.25, "rgba(255,255,255,.45)"); g.addColorStop(1, "rgba(255,255,255,0)");
  x.fillStyle = g; x.fillRect(0, 0, 128, 128); return new THREE.CanvasTexture(c);
}
// Haz de luz del faro sobre la calle (degradado alargado)
function hazTex() {
  const c = document.createElement("canvas"); c.width = 256; c.height = 128;
  const x = c.getContext("2d"); const g = x.createLinearGradient(0, 0, 256, 0);
  g.addColorStop(0, "rgba(255,244,210,.75)"); g.addColorStop(1, "rgba(255,244,210,0)");
  x.fillStyle = g; x.beginPath(); x.moveTo(0, 54); x.lineTo(256, 0); x.lineTo(256, 128); x.lineTo(0, 74); x.closePath(); x.fill();
  return new THREE.CanvasTexture(c);
}

// Junta varias figuras en una sola (menos llamadas de dibujo = más rápido en celulares sencillos)
function fusionar(partes) {
  let n = 0; const listas = [];
  for (const [g, m] of partes) { const q = (g.index ? g.toNonIndexed() : g.clone()); q.applyMatrix4(m); listas.push(q); n += q.attributes.position.count; }
  const pos = new Float32Array(n * 3), nor = new Float32Array(n * 3); let o = 0;
  for (const q of listas) { pos.set(q.attributes.position.array, o * 3); nor.set(q.attributes.normal.array, o * 3); o += q.attributes.position.count; q.dispose(); }
  const r = new THREE.BufferGeometry();
  r.setAttribute("position", new THREE.BufferAttribute(pos, 3)); r.setAttribute("normal", new THREE.BufferAttribute(nor, 3));
  return r;
}
// Arma un objeto por piezas agrupadas por material; al final cada material es una sola figura
class Armador {
  constructor() { this.p = new Map(); this.m = new THREE.Matrix4(); this.q = new THREE.Quaternion(); this.e = new THREE.Euler(); }
  add(mat, geo, x, y, z, rx = 0, ry = 0, rz = 0, sx = 1, sy = 1, sz = 1) {
    this.e.set(rx, ry, rz); this.q.setFromEuler(this.e);
    this.m.compose(new THREE.Vector3(x, y, z), this.q, new THREE.Vector3(sx, sy, sz));
    if (!this.p.has(mat)) this.p.set(mat, []);
    this.p.get(mat).push([geo, this.m.clone()]);
  }
  box(mat, sx, sy, sz, x, y, z, rx = 0, ry = 0, rz = 0) { this.add(mat, CAJA, x, y, z, rx, ry, rz, sx, sy, sz); }
  grupo(sombra = true) {
    const g = new THREE.Group();
    for (const [mat, ps] of this.p) { const me = new THREE.Mesh(fusionar(ps), mat); me.castShadow = sombra; me.receiveShadow = true; g.add(me); }
    return g;
  }
}
const CAJA = new THREE.BoxGeometry(1, 1, 1);

// Varias cajas en una sola llamada de dibujo
class Cajas {
  constructor(max, mat, sombra = true) {
    this.m = new THREE.InstancedMesh(CAJA, mat, max);
    this.m.castShadow = sombra; this.m.receiveShadow = true; this.n = 0; this.max = max;
    this.o = new THREE.Object3D(); this.c = new THREE.Color();
  }
  add(x, y, z, sx, sy, sz, color, ry = 0) {
    if (this.off || this.n >= this.max) return;
    const o = this.o; o.position.set(x, y + sy / 2, z); o.scale.set(sx, sy, sz); o.rotation.set(0, ry, 0); o.updateMatrix();
    this.m.setMatrixAt(this.n, o.matrix); if (color != null) this.m.setColorAt(this.n, this.c.set(color)); this.n++;
  }
  fin() { this.m.count = this.n; this.m.instanceMatrix.needsUpdate = true; if (this.m.instanceColor) this.m.instanceColor.needsUpdate = true; return this.m; }
}

// ---------- Mototaxi tipo cabina (como los que circulan en el centro) ----------
// Mira hacia +x. Largo ~3.1, ancho ~1.5, alto ~2.3.
function mototaxi(color, conLuz) {
  const A = new Armador();
  const S = (c, o = {}) => new THREE.MeshStandardMaterial({ color: c, roughness: 0.5, ...o });
  const cuerpo = S(color, { roughness: 0.32, metalness: 0.15 });
  const lona = S(0x15171b, { roughness: 0.85 }), gris = S(0x3a3f47, { roughness: 0.7 });
  const cromo = S(0xd4d9df, { roughness: 0.25, metalness: 0.8 }), llanta = S(0x101114, { roughness: 0.9 });
  const vidrio = S(0x1d3348, { roughness: 0.08, metalness: 0.6, transparent: true, opacity: 0.6 });
  const blanco = S(0xf4f6f8, { roughness: 0.4 });
  const faro = new THREE.MeshBasicMaterial({ color: 0xfff4d0 }), ambar = new THREE.MeshBasicMaterial({ color: 0xffa630 }), rojo = new THREE.MeshBasicMaterial({ color: 0xff2d3d });

  // Carrocería: perfil de lado (trompa redondeada, cabina baja atrás) estirado a lo ancho
  const W = 1.34, sh = new THREE.Shape();
  sh.moveTo(-1.5, 0.42); sh.lineTo(0.95, 0.42); sh.quadraticCurveTo(1.46, 0.44, 1.54, 0.86);
  sh.lineTo(1.56, 1.3); sh.lineTo(1.4, 1.43); sh.lineTo(1.06, 1.43); sh.lineTo(1.0, 1.0);
  sh.lineTo(-1.12, 1.0); sh.quadraticCurveTo(-1.46, 1.0, -1.5, 1.22); sh.closePath();
  const tina = new THREE.ExtrudeGeometry(sh, { depth: W, bevelEnabled: true, bevelSize: 0.05, bevelThickness: 0.05, bevelSegments: 2, curveSegments: 10 });
  tina.translate(0, 0, -W / 2);
  A.add(cuerpo, tina, 0, 0, 0);
  // Salpicaderas traseras y delantera
  const arco = new THREE.CylinderGeometry(0.42, 0.42, 0.28, 16, 1, true, -Math.PI / 2, Math.PI);
  for (const z of [0.72, -0.72]) A.add(cuerpo, arco, -0.85, 0.36, z, -Math.PI / 2, 0, 0);
  A.add(cuerpo, new THREE.CylinderGeometry(0.38, 0.38, 0.22, 14, 1, true, -Math.PI / 2, Math.PI * 0.85), 1.62, 0.32, 0, -Math.PI / 2, 0, 0.35);
  // Franja blanca de lado
  for (const z of [W / 2 + 0.056, -W / 2 - 0.056]) { A.box(blanco, 1.7, 0.06, 0.01, -0.25, 0.86, z); A.box(blanco, 0.9, 0.035, 0.01, -0.6, 0.76, z); }
  // Parabrisas con marco del color del cuerpo
  A.box(cuerpo, 0.05, 0.8, 1.38, 1.29, 1.79, 0, 0, 0, 0.22);
  A.box(vidrio, 0.03, 0.66, 1.18, 1.32, 1.79, 0, 0, 0, 0.22);
  A.box(lona, 0.02, 0.5, 0.03, 1.36, 1.72, 0.18, 0.9, 0, 0.22);
  // Techo de lona negra con visera del color del cuerpo
  A.box(lona, 2.9, 0.1, 1.52, -0.1, 2.18, 0);
  A.box(cuerpo, 2.8, 0.06, 1.42, -0.1, 2.26, 0);
  A.box(blanco, 2.6, 0.02, 0.22, -0.1, 2.3, 0);
  A.box(cuerpo, 0.32, 0.13, 1.52, 1.2, 2.17, 0);
  // Lona de atrás y costados traseros
  A.box(lona, 0.06, 1.18, 1.44, -1.5, 1.6, 0);
  for (const z of [0.71, -0.71]) A.box(lona, 0.5, 1.18, 0.03, -1.27, 1.6, z);
  // Postes
  const poste = new THREE.CylinderGeometry(0.03, 0.03, 0.78, 6);
  for (const z of [0.69, -0.69]) { A.add(lona, poste, 0.92, 1.8, z); A.add(lona, poste, -0.15, 1.8, z); }
  A.box(lona, 0.04, 0.04, 1.36, 0.3, 1.65, 0);
  // Asientos
  A.box(gris, 0.55, 0.18, 0.6, 0.6, 1.1, 0); A.box(gris, 0.12, 0.38, 0.52, 0.32, 1.36, 0);
  A.box(gris, 0.62, 0.2, 1.22, -0.85, 1.1, 0); A.box(gris, 0.16, 0.62, 1.22, -1.36, 1.5, 0);
  // Frente: faros, direccionales, espejos
  A.box(lona, 0.06, 0.3, 0.74, 1.575, 1.06, 0);
  for (const z of [0.18, -0.18]) A.box(faro, 0.04, 0.16, 0.24, 1.6, 1.08, z);
  for (const z of [0.56, -0.56]) { A.box(ambar, 0.05, 0.08, 0.14, 1.55, 1.26, z); A.box(rojo, 0.05, 0.14, 0.12, -1.53, 0.8, z); }
  for (const z of [0.82, -0.82]) { A.box(lona, 0.04, 0.04, 0.2, 1.22, 1.62, z * 0.93); A.box(lona, 0.05, 0.16, 0.1, 1.22, 1.72, z); }
  // Llantas con rin plateado
  const rueda = new THREE.CylinderGeometry(0.32, 0.32, 0.2, 18), rin = new THREE.CylinderGeometry(0.16, 0.16, 0.21, 12);
  for (const [x, z] of [[-0.85, 0.74], [-0.85, -0.74], [1.62, 0]]) { A.add(llanta, rueda, x, 0.32, z, Math.PI / 2); A.add(cromo, rin, x, 0.32, z, Math.PI / 2); }
  A.add(cromo, new THREE.CylinderGeometry(0.035, 0.035, 0.7, 6), 1.58, 0.62, 0.13, 0, 0, 0.3);
  A.add(cromo, new THREE.CylinderGeometry(0.035, 0.035, 0.7, 6), 1.58, 0.62, -0.13, 0, 0, 0.3);

  const g = A.grupo(true);
  if (conLuz) {
    const luz = new THREE.PointLight(C.verdeClaro, 3, 7, 2); luz.position.set(0, 2.9, 0); g.add(luz);
    const haz = new THREE.Mesh(new THREE.PlaneGeometry(6, 3), new THREE.MeshBasicMaterial({ map: hazTex(), transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, opacity: 0.55 }));
    haz.rotation.x = -Math.PI / 2; haz.position.set(4.6, 0.06, 0); g.add(haz);
  }
  return g;
}

// ---------- Motocarro de cajón (cajón con toldo adelante, moto atrás) ----------
function motocarro(colorCajon, colorToldo) {
  const A = new Armador();
  const S = (c, o = {}) => new THREE.MeshStandardMaterial({ color: c, roughness: 0.55, ...o });
  const caj = S(colorCajon, { roughness: 0.35, metalness: 0.1 }), toldo = S(colorToldo, { roughness: 0.8, side: THREE.DoubleSide });
  const negro = S(0x121316, { roughness: 0.85 }), gris = S(0x8a9099, { metalness: 0.6, roughness: 0.35 }), asiento = S(0x2b2f36);
  const rueda = new THREE.CylinderGeometry(0.3, 0.3, 0.16, 16);
  // Cajón con banca
  A.box(caj, 1.35, 0.55, 1.36, 0.55, 0.62, 0);
  A.box(asiento, 0.5, 0.16, 1.2, 0.35, 0.98, 0); A.box(asiento, 0.12, 0.45, 1.2, 0.1, 1.2, 0);
  for (const z of [0.72, -0.72]) A.add(negro, rueda, 0.6, 0.3, z, Math.PI / 2);
  // Toldo con postes y faldón
  for (const [x, z] of [[1.15, 0.64], [1.15, -0.64], [-0.05, 0.64], [-0.05, -0.64]]) A.add(gris, new THREE.CylinderGeometry(0.025, 0.025, 1.25, 6), x, 1.5, z);
  A.box(toldo, 1.45, 0.06, 1.5, 0.55, 2.14, 0);
  for (const z of [0.75, -0.75]) A.box(toldo, 1.45, 0.16, 0.02, 0.55, 2.04, z);
  A.box(toldo, 0.02, 0.16, 1.5, 1.27, 2.04, 0);
  // Moto atrás
  A.box(caj, 0.9, 0.3, 0.28, -0.55, 0.78, 0); A.box(asiento, 0.6, 0.12, 0.3, -0.62, 1.0, 0);
  A.box(negro, 0.08, 0.08, 0.8, -0.08, 1.2, 0); A.add(gris, new THREE.CylinderGeometry(0.03, 0.03, 0.75, 6), -0.15, 0.85, 0, 0, 0, -0.3);
  A.add(negro, rueda, -1.15, 0.3, 0, Math.PI / 2);
  A.box(new THREE.MeshBasicMaterial({ color: 0xff2d3d }), 0.04, 0.08, 0.16, -1.42, 0.82, 0);
  return A.grupo(true);
}

// ---------- Palmera (tronco curvo + penacho), juntas en una sola figura ----------
function geoPalmera() {
  const tr = [], co = [], m = new THREE.Matrix4(), q = new THREE.Quaternion(), e = new THREE.Euler();
  const pon = (lista, geo, x, y, z, rx, ry, rz, sx = 1, sy = 1, sz = 1) => { e.set(rx, ry, rz); q.setFromEuler(e); m.compose(new THREE.Vector3(x, y, z), q, new THREE.Vector3(sx, sy, sz)); lista.push([geo, m.clone()]); };
  let x = 0, y = 0, ang = 0;
  for (let i = 0; i < 6; i++) {
    const L = 1.15, rr = 0.2 - i * 0.015; ang += 0.045;
    pon(tr, new THREE.CylinderGeometry(rr * 0.92, rr, L, 7), x + Math.sin(ang) * L / 2, y + Math.cos(ang) * L / 2, 0, 0, 0, -ang);
    x += Math.sin(ang) * L; y += Math.cos(ang) * L;
  }
  const hoja = new THREE.BoxGeometry(2.2, 0.03, 0.3);
  hoja.translate(1.15, 0, 0);
  for (let i = 0; i < 11; i++) {
    const a = (i / 11) * Math.PI * 2 + 0.3, caida = -0.38 - (i % 3) * 0.2;
    pon(co, hoja, x, y, 0, 0, a, caida);
    pon(co, hoja, x, y + 0.05, 0, 0, a + 0.35, caida - 0.5, 0.72, 1, 0.9);
  }
  pon(co, new THREE.SphereGeometry(0.28, 8, 6), x, y - 0.15, 0, 0, 0, 0);
  return { tronco: fusionar(tr), copa: fusionar(co) };
}

// ---------- Letras de colores ----------
function letrasTicul() {
  const H = 1.3, s = 0.32, formas = [];
  const T = new THREE.Shape(); T.moveTo(0, H); T.lineTo(0.92, H); T.lineTo(0.92, H - s); T.lineTo(0.62, H - s); T.lineTo(0.62, 0); T.lineTo(0.3, 0); T.lineTo(0.3, H - s); T.lineTo(0, H - s); T.closePath();
  const I = new THREE.Shape(); I.moveTo(0, 0); I.lineTo(0.34, 0); I.lineTo(0.34, H); I.lineTo(0, H); I.closePath();
  const Cc = new THREE.Shape(); const cx = 0.62, cy = H / 2, R = 0.65, r = R - s, ab = 0.72;
  Cc.absarc(cx, cy, R, ab, Math.PI * 2 - ab, false); Cc.absarc(cx, cy, r, Math.PI * 2 - ab, ab, true); Cc.closePath();
  const U = new THREE.Shape(); U.moveTo(0, H); U.lineTo(0, 0.46); U.absarc(0.46, 0.46, 0.46, Math.PI, Math.PI * 2, false); U.lineTo(0.92, H); U.lineTo(0.6, H); U.lineTo(0.6, 0.46); U.absarc(0.46, 0.46, 0.14, Math.PI * 2, Math.PI, true); U.lineTo(0.32, H); U.closePath();
  const L = new THREE.Shape(); L.moveTo(0, 0); L.lineTo(0.88, 0); L.lineTo(0.88, s); L.lineTo(s, s); L.lineTo(s, H); L.lineTo(0, H); L.closePath();
  const lista = [[T, 0.92, 0xe0453a], [I, 0.34, 0xf2c230], [Cc, 1.2, 0x3fb56a], [U, 0.92, 0xf08a2c], [L, 0.88, 0xe8709a]];
  const g = new THREE.Group(); let x = 0;
  for (const [f, w, col] of lista) {
    const geo = new THREE.ExtrudeGeometry(f, { depth: 0.38, bevelEnabled: true, bevelSize: 0.035, bevelThickness: 0.035, bevelSegments: 2, curveSegments: 14 });
    const me = new THREE.Mesh(geo, new THREE.MeshStandardMaterial({ color: col, roughness: 0.4, emissive: col, emissiveIntensity: 0.22 }));
    me.position.x = x; me.castShadow = true; g.add(me); formas.push(me); x += w + 0.14;
  }
  g.userData.ancho = x - 0.14;
  return g;
}

export function iniciar(cont, getP) {
  const pruebaCanvas = document.createElement("canvas");
  if (!(pruebaCanvas.getContext("webgl2") || pruebaCanvas.getContext("webgl"))) return null;
  const sencillo = (navigator.deviceMemory && navigator.deviceMemory <= 2) || (navigator.hardwareConcurrency && navigator.hardwareConcurrency <= 4);

  const renderer = new THREE.WebGLRenderer({ antialias: !sencillo, alpha: true, powerPreference: "high-performance" });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, sencillo ? 1 : 1.6));
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping; renderer.toneMappingExposure = 1.12;
  renderer.shadowMap.enabled = !sencillo; renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  renderer.domElement.className = "lienzo3d";
  cont.appendChild(renderer.domElement);

  const scene = new THREE.Scene();
  scene.fog = new THREE.Fog(C.noche, 72, 150);
  const camera = new THREE.PerspectiveCamera(40, 1, 0.5, 320);

  // Atardecer yucateco: cielo azul profundo, sol bajo y anaranjado
  scene.add(new THREE.HemisphereLight(0x9ab8ff, 0x1a120c, 0.9));
  const sol = new THREE.DirectionalLight(0xffc48a, 1.75);
  sol.position.set(34, 40, 26); sol.castShadow = !sencillo;
  Object.assign(sol.shadow.camera, { left: -48, right: 48, top: 48, bottom: -48, near: 1, far: 150 });
  sol.shadow.mapSize.set(window.innerWidth < 700 ? 1024 : 2048, window.innerWidth < 700 ? 1024 : 2048); sol.shadow.bias = -0.0008;
  scene.add(sol);
  const relleno = new THREE.DirectionalLight(0x6f8cff, 0.4); relleno.position.set(-30, 22, -24); scene.add(relleno);

  const r = rng(29);
  const M = (c, o = {}) => new THREE.MeshStandardMaterial({ color: c, roughness: 0.8, ...o });
  const pieza = (geo, mat, x, y, z, sombra = true) => { const m = new THREE.Mesh(geo, mat); m.position.set(x, y, z); m.castShadow = sombra; m.receiveShadow = true; scene.add(m); return m; };

  // ---------- Suelo, banquetas y orillas pintadas ----------
  const suelo = new THREE.Mesh(new THREE.PlaneGeometry(280, 280), new THREE.MeshStandardMaterial({ color: C.calle, roughness: 0.95 }));
  suelo.rotation.x = -Math.PI / 2; suelo.receiveShadow = true; scene.add(suelo);
  const IGLESIA = [0, -16], PARQUE = [0, 0];
  const esBloque = (b, x, z) => b[0] === x && b[1] === z;
  // Las afueras: Uxmal en una esquina y una hacienda henequenera en la otra
  const UXMAL = [-32, -32], HACIENDA = [32, -32];
  const afuera = (x, z) => esBloque(UXMAL, x, z) || esBloque(HACIENDA, x, z);
  const losas = new Cajas(30, new THREE.MeshStandardMaterial({ roughness: 0.92 }), false);
  for (const x of MANZANAS) for (const z of MANZANAS) losas.add(x, 0, z, 11, 0.3, 11, esBloque(PARQUE, x, z) ? C.pasto : esBloque(IGLESIA, x, z) ? 0x6d5a4a : esBloque(UXMAL, x, z) ? 0x24311d : esBloque(HACIENDA, x, z) ? 0x3a3424 : C.banqueta);
  scene.add(losas.fin());
  const orillas = new Cajas(120, new THREE.MeshStandardMaterial({ roughness: 0.6 }), false);
  for (const x of MANZANAS) for (const z of MANZANAS) {
    const col = (esBloque(PARQUE, x, z) || esBloque(IGLESIA, x, z) || (Math.abs(x) <= 16 && Math.abs(z) <= 16 && r() < 0.5)) ? C.amarillo : 0x6b7280;
    if (afuera(x, z)) continue;
    orillas.add(x, 0, z + 5.45, 11.1, 0.34, 0.2, col); orillas.add(x, 0, z - 5.45, 11.1, 0.34, 0.2, col);
    orillas.add(x + 5.45, 0, z, 0.2, 0.34, 11.1, col); orillas.add(x - 5.45, 0, z, 0.2, 0.34, 11.1, col);
  }
  scene.add(orillas.fin());
  // Pasos peatonales cerca del parque
  const cebras = new Cajas(120, new THREE.MeshBasicMaterial({ color: 0xc9ced6 }), false);
  for (const k of [-8, 8]) for (let i = -2; i <= 2; i++) { cebras.add(k + i * 0.75, 0.005, 6.4, 0.42, 0.02, 1.6); cebras.add(k + i * 0.75, 0.005, -6.4, 0.42, 0.02, 1.6); cebras.add(6.4, 0.005, k + i * 0.75, 1.6, 0.02, 0.42); cebras.add(-6.4, 0.005, k + i * 0.75, 1.6, 0.02, 0.42); }
  scene.add(cebras.fin());

  // ---------- Casas coloniales: corridas, con zócalo, pilastras y cornisa blancas ----------
  const MAT = () => new THREE.MeshStandardMaterial({ roughness: 0.85 });
  const cuerpos = new Cajas(320, MAT());
  const molduras = new Cajas(2400, MAT(), false);
  const madera = new Cajas(400, new THREE.MeshStandardMaterial({ color: 0x3a2618, roughness: 0.85 }), false);
  const ventanas = new Cajas(700, new THREE.MeshBasicMaterial({ toneMapped: false }), false);
  const herreria = new Cajas(4500, new THREE.MeshStandardMaterial({ color: 0x14161a, roughness: 0.6 }), false);
  const tinacos = [];
  const ocupado = (x, z) => Object.values(LUGARES).some((l) => Math.hypot(l.pos[0] - x, l.pos[2] - z) < 2.4);
  const eje = new THREE.Vector3(0, 1, 0);
  // Coloca algo en la fachada: u = a lo largo, y = altura, s = hacia la calle
  const fachada = (x, z, ry, d) => {
    const n = new THREE.Vector3(0, 0, 1).applyAxisAngle(eje, ry), t = new THREE.Vector3(1, 0, 0).applyAxisAngle(eje, ry);
    return (u, s) => [x + t.x * u + n.x * (d / 2 + s), z + t.z * u + n.z * (d / 2 + s)];
  };
  function ventana(F, u, y, ry, alta, enc) {
    const [mx, mz] = F(u, 0.03); molduras.add(mx, y - 0.12, mz, 0.98, alta + 0.3, 0.07, C.moldura, ry);
    const [vx, vz] = F(u, 0.07); ventanas.add(vx, y, vz, 0.7, alta, 0.04, enc ? C.luz : 0x1b2635, ry);
    const [hx, hz] = F(u, 0.1);
    for (const k of [-0.22, 0, 0.22]) { const [bx, bz] = F(u + k, 0.1); herreria.add(bx, y, bz, 0.035, alta, 0.035, null, ry); }
    herreria.add(hx, y + alta * 0.5, hz, 0.72, 0.04, 0.04, null, ry);
  }
  function casa(x, z, frente, w, esquina) {
    if (ocupado(x, z)) return;
    const d = 3.4, dos = esquina && r() < 0.75, h = dos ? 5.0 + r() * 0.4 : 2.8 + r() * 0.9;
    const col = CASAS[Math.floor(r() * CASAS.length)];
    const ry = { S: 0, N: Math.PI, E: Math.PI / 2, W: -Math.PI / 2 }[frente];
    const F = fachada(x, z, ry, d), mold = col === 0xf0ece2 || col === 0xe8d8b4 ? C.terracota : C.moldura;
    cuerpos.add(x, 0.3, z, w, h, d, col, ry);
    // Cornisa y pretil
    molduras.add(x, 0.3 + h - 0.32, z, w + 0.1, 0.18, d + 0.1, mold, ry);
    const techo = [0xa8463a, 0xa8463a, 0xd9d6cf, 0xd9d6cf, 0x8e8c88][Math.floor(r() * 5)];
    molduras.add(x, 0.3 + h, z, w + 0.04, 0.22, d + 0.04, techo, ry);
    if (r() < 0.5) { const [tx, tz] = F((r() - 0.5) * 1.8, -1.6 - r() * 0.6); tinacos.push([tx, 0.3 + h + 0.22, tz]); }
    // Zócalo más oscuro
    const [zx, zz] = F(0, 0.02); molduras.add(zx, 0.3, zz, w, 0.55, 0.06, new THREE.Color(col).multiplyScalar(0.7).getHex(), ry);
    // Pilastras en las orillas
    for (const u of [-w / 2 + 0.12, w / 2 - 0.12]) { const [px2, pz2] = F(u, 0.04); molduras.add(px2, 0.3, pz2, 0.24, h - 0.3, 0.08, mold, ry); }
    // Puerta alta de madera con marco
    const up = (r() - 0.5) * 0.4;
    const [mx, mz] = F(up, 0.03); molduras.add(mx, 0.3, mz, 1.22, 2.25, 0.07, mold, ry);
    const [dx, dz] = F(up, 0.07); madera.add(dx, 0.3, dz, 0.92, 2.0, 0.05, null, ry);
    // Ventanas con herrería (planta baja)
    const uv = up > 0 ? up - 1.25 : up + 1.25;
    ventana(F, uv, 1.05, ry, 1.25, r() < 0.55);
    // Planta alta con balcones
    if (dos) {
      for (const u of [-w / 4, w / 4]) {
        ventana(F, u, 3.5, ry, 1.15, r() < 0.6);
        const [bx, bz] = F(u, 0.28); molduras.add(bx, 0.3 + 3.05, bz, 1.25, 0.1, 0.55, mold, ry);
        const [rx2, rz2] = F(u, 0.53); herreria.add(rx2, 3.45, rz2, 1.2, 0.05, 0.04, null, ry); herreria.add(rx2, 4.0, rz2, 1.2, 0.05, 0.04, null, ry);
        for (const k of [-0.5, -0.25, 0, 0.25, 0.5]) { const [qx2, qz2] = F(u + k, 0.53); herreria.add(qx2, 3.45, qz2, 0.03, 0.58, 0.03, null, ry); }
      }
      const [fx, fz] = F(0, 0.03); molduras.add(fx, 0.3 + 2.95, fz, w, 0.12, 0.08, mold, ry);
    }
  }
  for (const bx of MANZANAS) for (const bz of MANZANAS) {
    if (esBloque(PARQUE, bx, bz) || esBloque(IGLESIA, bx, bz)) continue;
    // En las afueras no se dibujan casas (se sigue el mismo sorteo para que el resto quede igual)
    const fuera = afuera(bx, bz), nT = tinacos.length;
    for (const c of [cuerpos, molduras, madera, ventanas, herreria]) c.off = fuera;
    for (const o of [-3.6, 0, 3.6]) { casa(bx + o, bz + 3.75, "S", 3.6, o !== 0); casa(bx + o, bz - 3.75, "N", 3.6, o !== 0); }
    casa(bx + 3.75, bz, "E", 3.6, false); casa(bx - 3.75, bz, "W", 3.6, false);
    if (fuera) tinacos.length = nT;
  }
  for (const c of [cuerpos, molduras, madera, ventanas, herreria]) c.off = false;
  scene.add(cuerpos.fin(), molduras.fin(), madera.fin(), ventanas.fin(), herreria.fin());
  // Tinacos negros en las azoteas
  const tin = new THREE.InstancedMesh(new THREE.CylinderGeometry(0.42, 0.42, 0.75, 12), new THREE.MeshStandardMaterial({ color: 0x1c1d20, roughness: 0.6 }), tinacos.length);
  tin.castShadow = true; const ot = new THREE.Object3D();
  tinacos.forEach(([x, y, z], i) => { ot.position.set(x, y + 0.375, z); ot.updateMatrix(); tin.setMatrixAt(i, ot.matrix); });
  scene.add(tin);

  // ---------- Iglesia de San Antonio (terracota con espadaña y cúpula) ----------
  const [ix, iz] = IGLESIA, fz = iz + 3.1; // fz = frente de la fachada
  const roja = M(C.terracota, { roughness: 0.75 }), blancaM = M(C.moldura, { roughness: 0.6 }), oscuroM = M(0x24160f, { roughness: 0.9 });
  const IG = new Armador();
  IG.box(roja, 4.6, 6.0, 7.6, ix, 3.3, iz - 0.7);                 // nave
  for (const k of [-2.4, -0.4, 1.6]) for (const sx of [-2.45, 2.45]) IG.box(roja, 0.45, 4.6, 0.7, ix + sx, 2.6, iz + k); // contrafuertes
  IG.box(roja, 6.4, 7.4, 0.8, ix, 4.0, fz);                        // fachada
  IG.box(blancaM, 6.6, 0.28, 0.95, ix, 7.75, fz);                   // cornisa
  for (const sx of [-3.05, 3.05, -1.25, 1.25]) IG.box(blancaM, 0.3, 7.1, 0.9, ix + sx, 4.0, fz); // pilastras
  // Espadaña: remate central escalonado con campana
  IG.box(roja, 3.2, 1.6, 0.7, ix, 8.7, fz); IG.box(roja, 1.8, 1.1, 0.7, ix, 10.0, fz);
  IG.box(blancaM, 3.4, 0.16, 0.8, ix, 9.55, fz); IG.box(blancaM, 2.0, 0.16, 0.8, ix, 10.6, fz);
  IG.box(oscuroM, 0.7, 0.85, 0.75, ix, 8.75, fz + 0.02); IG.box(oscuroM, 0.5, 0.6, 0.75, ix, 10.0, fz + 0.02);
  IG.add(M(0xd4a640, { metalness: 0.7, roughness: 0.3 }), new THREE.SphereGeometry(0.22, 10, 8, 0, Math.PI * 2, 0, Math.PI / 1.6), ix, 8.85, fz + 0.1);
  IG.add(blancaM, new THREE.CylinderGeometry(0.06, 0.06, 0.7, 6), ix, 11.0, fz); IG.box(blancaM, 0.45, 0.07, 0.07, ix, 11.1, fz);
  // Campanarios en las esquinas
  for (const sx of [-2.75, 2.75]) {
    IG.box(roja, 0.95, 1.5, 0.95, ix + sx, 8.6, fz); IG.box(oscuroM, 0.5, 0.75, 1.0, ix + sx, 8.7, fz);
    IG.box(blancaM, 1.1, 0.14, 1.1, ix + sx, 9.4, fz);
    IG.add(roja, new THREE.ConeGeometry(0.6, 0.9, 4), ix + sx, 9.9, fz, 0, Math.PI / 4, 0);
    IG.add(blancaM, new THREE.SphereGeometry(0.13, 8, 6), ix + sx, 10.42, fz);
  }
  // Portón en arco, rosetón y marcos blancos
  const arcoSh = new THREE.Shape(); arcoSh.moveTo(-0.85, 0); arcoSh.lineTo(0.85, 0); arcoSh.lineTo(0.85, 2.3); arcoSh.absarc(0, 2.3, 0.85, 0, Math.PI, false); arcoSh.closePath();
  const arcoG = new THREE.ExtrudeGeometry(arcoSh, { depth: 0.1, bevelEnabled: false, curveSegments: 16 });
  IG.add(blancaM, arcoG, ix, 0.3, fz + 0.38, 0, 0, 0, 1.25, 1.12, 1);
  IG.add(new THREE.MeshStandardMaterial({ color: 0x4a2c18, roughness: 0.8 }), arcoG, ix, 0.3, fz + 0.45);
  IG.add(blancaM, new THREE.TorusGeometry(0.62, 0.11, 8, 24), ix, 5.5, fz + 0.42);
  IG.add(oscuroM, new THREE.CircleGeometry(0.55, 24), ix, 5.5, fz + 0.41);
  for (const sx of [-2.15, 2.15]) { IG.box(blancaM, 0.7, 1.3, 0.1, ix + sx, 5.0, fz + 0.42); IG.box(oscuroM, 0.5, 1.05, 0.1, ix + sx, 5.0, fz + 0.45); }
  // Cúpula blanca con linternilla
  IG.add(roja, new THREE.CylinderGeometry(1.75, 1.75, 0.9, 20), ix, 6.75, iz - 3.0);
  IG.add(blancaM, new THREE.SphereGeometry(1.75, 22, 12, 0, Math.PI * 2, 0, Math.PI / 2), ix, 7.2, iz - 3.0);
  IG.add(blancaM, new THREE.CylinderGeometry(0.35, 0.35, 0.6, 10), ix, 9.2, iz - 3.0);
  IG.add(roja, new THREE.ConeGeometry(0.45, 0.6, 10), ix, 9.8, iz - 3.0);
  // Ex convento a un lado: portal de arcos
  IG.box(roja, 2.6, 4.0, 6.0, ix + 4.0, 2.3, iz - 1.6);
  IG.box(blancaM, 2.7, 0.22, 6.1, ix + 4.0, 4.32, iz - 1.6);
  for (let k = 0; k < 4; k++) IG.box(oscuroM, 0.12, 1.6, 0.9, ix + 5.31, 1.5, iz - 3.9 + k * 1.5);
  // Atrio con barda de pilares rojos y blancos
  for (let k = -5.1; k <= 5.15; k += 0.85) {
    if (Math.abs(k) < 1.3) continue;
    IG.box(roja, 0.32, 1.25, 0.32, ix + k, 0.92, iz + 5.25); IG.box(blancaM, 0.4, 0.12, 0.4, ix + k, 1.6, iz + 5.25);
  }
  IG.box(blancaM, 3.95, 0.45, 0.2, ix - 3.15, 0.52, iz + 5.25); IG.box(blancaM, 3.95, 0.45, 0.2, ix + 3.15, 0.52, iz + 5.25);
  for (const sx of [-5.25, 5.25]) for (let k = 3.5; k > 1.6; k -= 0.85) { IG.box(roja, 0.32, 1.25, 0.32, ix + sx, 0.92, iz + k); IG.box(blancaM, 0.4, 0.12, 0.4, ix + sx, 1.6, iz + k); }
  scene.add(IG.grupo(true));
  // Luz cálida que ilumina la fachada
  const luzIglesia = new THREE.PointLight(0xffb36b, 30, 16, 1.6); luzIglesia.position.set(ix, 3.5, fz + 5.5); scene.add(luzIglesia);

  // ---------- Parque principal: caminos, kiosco, letras, palmeras y arbolitos en bola ----------
  const [kx, kz] = PARQUE;
  const PQ = new Armador();
  const crema = M(0xd9ccae, { roughness: 0.85 });
  PQ.box(crema, 11, 0.04, 1.5, kx, 0.32, kz); PQ.box(crema, 1.5, 0.04, 11, kx, 0.32, kz);
  PQ.box(crema, 11, 0.04, 0.9, kx, 0.32, kz + 4.95); PQ.box(crema, 11, 0.04, 0.9, kx, 0.32, kz - 4.95);
  PQ.box(crema, 0.9, 0.04, 11, kx + 4.95, 0.32, kz); PQ.box(crema, 0.9, 0.04, 11, kx - 4.95, 0.32, kz);
  PQ.add(crema, new THREE.CylinderGeometry(2.7, 2.7, 0.05, 32), kx, 0.33, kz + 0.6);
  // Kiosco: base, columnas blancas, techo verde con remate
  PQ.add(M(0xcfc3a8), new THREE.CylinderGeometry(1.75, 1.85, 0.45, 8), kx, 0.55, kz + 0.6);
  for (let i = 0; i < 8; i++) { const a = (i / 8) * Math.PI * 2; PQ.add(blancaM, new THREE.CylinderGeometry(0.08, 0.08, 1.9, 8), kx + Math.cos(a) * 1.5, 1.7, kz + 0.6 + Math.sin(a) * 1.5); }
  PQ.add(blancaM, new THREE.CylinderGeometry(1.95, 1.95, 0.18, 8), kx, 2.7, kz + 0.6);
  PQ.add(M(0x2f8f5b, { roughness: 0.5 }), new THREE.ConeGeometry(2.05, 1.1, 8), kx, 3.35, kz + 0.6);
  PQ.add(blancaM, new THREE.SphereGeometry(0.2, 8, 6), kx, 4.0, kz + 0.6);
  // Bancas
  for (const [bx, bz, ry] of [[-2.6, 3.9, 0], [2.6, 3.9, 0], [3.9, -2.4, Math.PI / 2], [-3.9, -2.4, Math.PI / 2], [3.9, 2.6, Math.PI / 2], [-3.9, 2.6, Math.PI / 2]]) {
    PQ.box(M(0xe9e1cf), 1.4, 0.1, 0.45, kx + bx, 0.75, kz + bz, 0, ry); PQ.box(M(0xe9e1cf), 1.4, 0.4, 0.1, kx + bx + (ry ? 0.2 : 0), 1.0, kz + bz + (ry ? 0 : 0.2), 0, ry);
  }
  scene.add(PQ.grupo(true));
  // Letras TICUL frente a la iglesia
  const letras = letrasTicul();
  letras.scale.setScalar(1.45); letras.position.set(kx - letras.userData.ancho * 1.45 / 2, 0.62, kz - 4.35); scene.add(letras);
  pieza(new THREE.BoxGeometry(7.6, 0.3, 1.0), blancaM, kx, 0.47, kz - 4.1);
  // Gente paseando
  const gente = new THREE.CapsuleGeometry(0.22, 0.55, 4, 8);
  for (const [gx, gz, c] of [[-1.7, -3.1, 0xd9826f], [-1.1, -3.2, 0x7da3c9], [2.3, 2.5, 0xe2b54e], [-2.9, 0.2, 0xb85c8a], [1.0, 3.0, 0x8fc09d], [3.3, -0.8, 0xf0ece2]]) pieza(gente, M(c), kx + gx, 0.95, kz + gz);

  // Palmeras (parque, atrio y calles) en una sola figura
  const PAL = geoPalmera();
  const sitiosPalma = [[-4.3, -4.3], [4.3, -4.3], [-4.3, 4.3], [4.3, 4.3], [-4.4, 0.6], [4.4, 1.6], [-1.5, 4.4], [ix - 4.3, iz + 4.2], [ix + 4.4, iz + 4.3]];
  for (let i = 0; i < 10; i++) { const a = MANZANAS[Math.floor(r() * 5)], b = MANZANAS[Math.floor(r() * 5)]; if ((a || b) && !(a === 0 && b === -16) && !afuera(a, b)) sitiosPalma.push([a + (r() < 0.5 ? -1.2 : 1.2), b + (r() < 0.5 ? -1.2 : 1.2)]); }
  const palT = new THREE.InstancedMesh(PAL.tronco, M(0x8a7560, { roughness: 0.95 }), sitiosPalma.length);
  const palC = new THREE.InstancedMesh(PAL.copa, new THREE.MeshStandardMaterial({ color: 0x3f9550, roughness: 0.75, flatShading: true, side: THREE.DoubleSide }), sitiosPalma.length);
  palT.castShadow = palC.castShadow = true;
  const o3 = new THREE.Object3D();
  sitiosPalma.forEach(([x, z], i) => { o3.position.set(x, 0.3, z); o3.rotation.set(0, r() * 6.28, 0); o3.scale.setScalar(0.95 + r() * 0.3); o3.updateMatrix(); palT.setMatrixAt(i, o3.matrix); palC.setMatrixAt(i, o3.matrix); });
  scene.add(palT, palC);

  // Árboles frondosos en los patios de las casas y arbolitos en bola en el parque
  const troncos = new Cajas(60, M(0x4a3426), true);
  const copaGeo = new THREE.IcosahedronGeometry(1, 1);
  const copas = new THREE.InstancedMesh(copaGeo, new THREE.MeshStandardMaterial({ roughness: 0.9, flatShading: true }), 140); copas.castShadow = true;
  let nc = 0; const col3 = new THREE.Color();
  const copa = (x, y, z, s, c) => { o3.position.set(x, y, z); o3.scale.set(s, s * 0.9, s); o3.rotation.set(r(), r(), r()); o3.updateMatrix(); copas.setMatrixAt(nc, o3.matrix); copas.setColorAt(nc, col3.set(c)); nc++; };
  for (const bx of MANZANAS) for (const bz of MANZANAS) {
    if (esBloque(PARQUE, bx, bz) || esBloque(IGLESIA, bx, bz) || r() < 0.25) continue;
    const x = bx + (r() - 0.5) * 1.4, z = bz + (r() - 0.5) * 1.4;
    if (afuera(bx, bz)) { for (let k = 0; k < 6; k++) r(); continue; }
    troncos.add(x, 0.3, z, 0.3, 3.2, 0.3, null);
    copa(x, 4.6, z, 1.7, [0x2f7d4a, 0x3e9b5a, 0x2a6b42][nc % 3]); copa(x + 0.8, 4.1, z - 0.5, 1.15, 0x2a6b42);
  }
  const macetas = new Cajas(60, M(C.moldura), false);
  const bolas = [];
  for (let k = -3.0; k <= 3.01; k += 1.5) bolas.push([k, 5.15], [k, -5.15], [5.15, k], [-5.15, k]);
  for (const [bx2, bz2] of bolas) { if (Math.abs(bx2) < 1 || Math.abs(bz2) < 1) continue; macetas.add(kx + bx2, 0.3, kz + bz2, 0.42, 0.42, 0.42, null); copa(kx + bx2, 1.15, kz + bz2, 0.48, 0x3b8f4c); }
  for (const sx of [-0.95, 0.95]) { macetas.add(ix + sx, 0.3, iz + 4.7, 0.42, 0.42, 0.42, null); copa(ix + sx, 1.15, iz + 4.7, 0.48, 0x3b8f4c); }
  copas.count = nc; copas.instanceMatrix.needsUpdate = true; copas.instanceColor.needsUpdate = true;
  scene.add(troncos.fin(), copas, macetas.fin());

  // ---------- Afueras: Pirámide del Adivino (Uxmal) entre el monte ----------
  const ra = rng(77), brillo2 = brilloTex();
  const resplandor = (x, y, z, c, esc, op) => { const s = new THREE.Sprite(new THREE.SpriteMaterial({ map: brillo2, color: c, transparent: true, opacity: op, depthWrite: false, blending: THREE.AdditiveBlending })); s.position.set(x, y, z); s.scale.setScalar(esc); scene.add(s); return s; };
  const parche = (x, z, w, c) => { const m = new THREE.Mesh(new THREE.PlaneGeometry(w, w), new THREE.MeshStandardMaterial({ color: c, roughness: 1 })); m.rotation.x = -Math.PI / 2; m.position.set(x, 0.02, z); m.receiveShadow = true; scene.add(m); };
  const [ux, uz] = [-34.5, -35];
  parche(-40, -40, 28, 0x1f2b19);
  const piedra = M(0xc4b08a, { roughness: 0.95, emissive: 0x3a2610, emissiveIntensity: 0.35 }), piedra2 = M(0xa99673, { roughness: 0.95, emissive: 0x3a2610, emissiveIntensity: 0.3 });
  const PY = new Armador(); let yp = 0.3;
  for (let i = 0; i < 6; i++) { const h = 1.45, rB = 4.5 - i * 0.52, rT = rB - 0.32; PY.add(i % 2 ? piedra2 : piedra, new THREE.CylinderGeometry(rT, rB, h, 32), ux, yp + h / 2, uz, 0, 0, 0, 1.5, 1, 1); yp += h; }
  // Templo de arriba con su puerta y crestería
  PY.box(piedra, 3.4, 1.9, 2.0, ux, yp + 0.95, uz); PY.box(piedra2, 3.7, 0.35, 2.25, ux, yp + 1.75, uz);
  PY.box(oscuroM, 0.75, 1.15, 0.1, ux, yp + 0.6, uz + 1.02);
  for (const k of [-1.2, -0.4, 0.4, 1.2]) PY.box(piedra2, 0.35, 0.5, 0.35, ux + k, yp + 2.15, uz);
  // Escalinata empinada hacia el frente
  const altoP = yp - 0.3, z0 = uz + 6.3, z1 = uz + 1.3, dzE = z0 - z1, Lr = Math.hypot(altoP, dzE), th = -Math.atan2(dzE, altoP);
  PY.box(piedra2, 2.3, Lr, 0.6, ux, 0.3 + altoP / 2, (z0 + z1) / 2 - 0.25, th);
  for (const sx of [-1.25, 1.25]) PY.box(piedra, 0.35, Lr, 0.8, ux + sx, 0.3 + altoP / 2, (z0 + z1) / 2 - 0.2, th);
  for (let i = 0; i < 24; i++) { const t = (i + 0.5) / 24; PY.box(piedra, 2.1, altoP / 24, 0.28, ux, 0.3 + t * altoP - altoP / 48, z0 - t * dzE + 0.08); }
  scene.add(PY.grupo(true));
  // Sacbé (camino blanco) de la calle a la escalinata, por donde llega el mototaxi
  { const sb = new THREE.Mesh(new THREE.PlaneGeometry(3.2, 5.2), new THREE.MeshStandardMaterial({ color: 0xd9ceb4, roughness: 1 })); sb.rotation.x = -Math.PI / 2; sb.position.set(ux, 0.32, uz + 8.9); sb.receiveShadow = true; scene.add(sb); }
  for (const [dx, dz] of [[-6, 5], [6, 5], [0, 7.2], [-7.5, -1], [7.5, -1]]) resplandor(ux + dx, 0.9, uz + dz, 0xffb066, 6, 0.55);
  resplandor(ux, yp + 1, uz + 1.5, 0xffc27a, 9, 0.25);
  // Monte bajo alrededor
  const monte = new THREE.InstancedMesh(new THREE.IcosahedronGeometry(1, 0), new THREE.MeshStandardMaterial({ roughness: 0.95, flatShading: true }), 220);
  monte.castShadow = true; let nm = 0; const om = new THREE.Object3D();
  const arbusto = (x, z, s, c) => { if (nm >= 220) return; om.position.set(x, 0.3 + s * 0.6, z); om.scale.set(s, s * 0.8, s); om.rotation.set(ra(), ra(), ra()); om.updateMatrix(); monte.setMatrixAt(nm, om.matrix); monte.setColorAt(nm, col3.set(c)); nm++; };
  for (let i = 0; i < 260; i++) {
    const x = -54 + ra() * 27.5, z = -54 + ra() * 27.5;
    if (((x - ux) / 8.2) ** 2 + ((z - uz - 1) / 8.6) ** 2 < 1) continue;
    arbusto(x, z, 0.7 + ra() * 1.1, [0x23502f, 0x2f6b3c, 0x1d4428, 0x3a7a3f][Math.floor(ra() * 4)]);
  }

  // ---------- Afueras: hacienda henequenera (casa con arcos, chimenea y plantíos) ----------
  const [hx, hz] = [33.5, -34];
  parche(40, -40, 28, 0x3b3424);
  const almagre = M(0xb9573a, { roughness: 0.8 }), ocreH = M(0xe0a93e, { roughness: 0.75 }), ladrillo = M(0x8f4630, { roughness: 0.9 });
  const HA = new Armador();
  HA.box(almagre, 9.6, 4.2, 4.0, hx, 2.4, hz - 0.6);
  HA.box(blancaM, 9.8, 0.25, 4.2, hx, 4.55, hz - 0.6);
  // Portal de arcos al frente
  const fzH = hz + 2.6;
  for (let k = 0; k <= 5; k++) HA.box(blancaM, 0.5, 2.55, 0.5, hx - 4.2 + k * 1.68, 1.58, fzH);
  const enjuta = new THREE.Shape(); enjuta.moveTo(-0.84, 0); enjuta.lineTo(-0.59, 0); enjuta.absarc(0, 0, 0.59, Math.PI, 0, true); enjuta.lineTo(0.84, 0); enjuta.lineTo(0.84, 0.75); enjuta.lineTo(-0.84, 0.75); enjuta.closePath();
  const enjutaG = new THREE.ExtrudeGeometry(enjuta, { depth: 0.5, bevelEnabled: false, curveSegments: 12 });
  for (let k = 0; k < 5; k++) HA.add(almagre, enjutaG, hx - 4.2 + 0.84 + k * 1.68, 2.15, fzH - 0.25);
  HA.box(almagre, 9.6, 0.7, 0.5, hx, 3.25, fzH); HA.box(blancaM, 9.8, 0.18, 2.9, hx, 3.65, hz + 1.35);
  for (let k = 0; k < 5; k++) HA.box(madera.m.material, 0.8, 1.9, 0.08, hx - 4.2 + 0.84 + k * 1.68, 1.3, hz + 1.42);
  // Casa de máquinas con su chimenea de ladrillo
  HA.box(M(0xdcc79e), 4.2, 3.2, 3.6, hx + 2.6, 1.9, hz - 5.6); HA.box(blancaM, 4.3, 0.2, 3.7, hx + 2.6, 3.5, hz - 5.6);
  HA.add(ladrillo, new THREE.CylinderGeometry(0.42, 0.75, 11, 14), hx + 5.4, 5.8, hz - 6.2);
  HA.add(M(0x5a2a1c), new THREE.CylinderGeometry(0.55, 0.5, 0.45, 14), hx + 5.4, 11.4, hz - 6.2);
  // Arco de entrada amarillo con remate escalonado
  const gz = hz + 7.0;
  for (const sx of [-1.7, 1.7]) HA.box(ocreH, 0.9, 3.3, 0.9, hx + sx, 1.95, gz);
  HA.box(ocreH, 4.3, 1.0, 0.9, hx, 4.1, gz); HA.box(ocreH, 2.6, 0.7, 0.9, hx, 4.95, gz); HA.box(ocreH, 1.2, 0.5, 0.9, hx, 5.55, gz);
  HA.box(blancaM, 4.5, 0.15, 1.0, hx, 4.6, gz); HA.box(blancaM, 2.8, 0.15, 1.0, hx, 5.3, gz);
  for (const sx of [-1, 1]) { HA.box(almagre, 3.3, 1.0, 0.35, hx + sx * 3.85, 0.8, gz); HA.box(blancaM, 3.3, 0.1, 0.45, hx + sx * 3.85, 1.35, gz); }
  scene.add(HA.grupo(true));
  resplandor(hx, 2.2, fzH + 1.2, 0xffc27a, 10, 0.3); resplandor(hx, 3.0, gz + 0.8, 0xffc27a, 6, 0.35);
  // Plantíos de henequén en hileras
  const pencas = [], mp = new THREE.Matrix4(), qp = new THREE.Quaternion(), ep = new THREE.Euler();
  const penca = new THREE.BoxGeometry(0.1, 1.15, 0.24); penca.translate(0, 0.55, 0);
  for (let i = 0; i < 8; i++) { ep.set(0.55 + (i % 2) * 0.25, (i / 8) * Math.PI * 2, 0, "YXZ"); qp.setFromEuler(ep); mp.compose(new THREE.Vector3(), qp, new THREE.Vector3(1, 1, 1)); pencas.push([penca, mp.clone()]); }
  ep.set(0, 0, 0); qp.setFromEuler(ep); mp.compose(new THREE.Vector3(), qp, new THREE.Vector3(1, 1.2, 1)); pencas.push([penca, mp.clone()]);
  const sitiosH = [];
  for (let x = 27; x <= 52; x += 1.6) for (let z = -53; z <= -41.5; z += 1.7) sitiosH.push([x, z]);
  for (let x = 41.5; x <= 52; x += 1.6) for (let z = -39.5; z <= -27; z += 1.7) sitiosH.push([x, z]);
  const hene = new THREE.InstancedMesh(fusionar(pencas), new THREE.MeshStandardMaterial({ color: 0x6f9f8a, roughness: 0.7 }), sitiosH.length);
  sitiosH.forEach(([x, z], i) => { om.position.set(x + (ra() - 0.5) * 0.3, 0.05, z); om.rotation.set(0, ra() * 6.28, 0); om.scale.setScalar(0.8 + ra() * 0.35); om.updateMatrix(); hene.setMatrixAt(i, om.matrix); });
  scene.add(hene);
  for (let i = 0; i < 40; i++) { const x = 26 + ra() * 26, z = -54 + ra() * 27; if (x < 41 && z > -41) continue; if (x > 40.5 && z > -41 && ra() < 0.7) continue; arbusto(x, z, 0.8 + ra() * 0.9, [0x23502f, 0x2f6b3c][Math.floor(ra() * 2)]); }
  monte.count = nm; monte.instanceMatrix.needsUpdate = true; monte.instanceColor.needsUpdate = true; scene.add(monte);

  // ---------- Faroles coloniales ----------
  const tex = brilloTex();
  const postes = new Cajas(80, M(0x16181c), false), linternas = new Cajas(80, new THREE.MeshBasicMaterial({ color: 0xffe0a3, toneMapped: false }), false);
  const focos = [];
  const farol = (x, z) => {
    postes.add(x, 0.3, z, 0.13, 3.0, 0.13, null); postes.add(x, 3.25, z, 0.38, 0.08, 0.38, null); postes.add(x, 3.85, z, 0.3, 0.1, 0.3, null);
    linternas.add(x, 3.33, z, 0.28, 0.52, 0.28, null);
    const s = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, color: C.luz, transparent: true, opacity: 0.85, depthWrite: false, blending: THREE.AdditiveBlending }));
    s.position.set(x, 3.6, z); s.scale.setScalar(2.6); scene.add(s); focos.push(s);
  };
  for (const [x, z] of [[-5.1, -5.1], [5.1, -5.1], [-5.1, 5.1], [5.1, 5.1], [-5.1, 0], [5.1, 0], [0, 5.1], [ix - 4.6, iz + 4.6], [ix + 4.6, iz + 4.6]]) farol(x, z);
  for (const x of [-24, -8, 8, 24]) for (const z of [-24, -8, 8, 24]) if (r() < 0.6) farol(x + 2.9, z + 2.9);
  scene.add(postes.fin(), linternas.fin());

  // ---------- Coches estacionados ----------
  const carros = new Cajas(40, M(0xffffff, { roughness: 0.35, metalness: 0.3 })), cabinas = new Cajas(40, M(0x1a2230, { roughness: 0.15, metalness: 0.6 }));
  const libres = (x, z) => Object.values(LUGARES).every((l) => Math.hypot(l.puerta[0] - x, l.puerta[1] - z) > 5) && [[-22.2, -23.4], [-6.2, -2.5], [6.2, 2.8], [-2.6, -9.85]].every(([a, b]) => Math.hypot(x - a, z - b) > 4.5);
  for (let i = 0; i < 18; i++) {
    const vert = r() < 0.5, k = CALLES[1 + Math.floor(r() * 4)], tt = MANZANAS[Math.floor(r() * 5)] + (r() - 0.5) * 5, lado = r() < 0.5 ? -1.85 : 1.85;
    const x = vert ? k + lado : tt, z = vert ? tt : k + lado;
    if (!libres(x, z)) continue;
    const ry = vert ? Math.PI / 2 : 0, c = [0xd9d9d9, 0x9aa3af, 0x2f4f7f, 0x8b1e1e, 0xf2f2f2, 0x1f2937][Math.floor(r() * 6)];
    carros.add(x, 0.25, z, 3.4, 0.75, 1.55, c, ry); cabinas.add(x + (vert ? 0 : -0.15), 1.0, z + (vert ? -0.15 : 0), vert ? 1.4 : 1.9, 0.55, vert ? 1.9 : 1.4, null);
  }
  scene.add(carros.fin(), cabinas.fin());

  // ---------- Casa de Rosa (destino del viaje) ----------
  const [cx, , cz] = LUGARES.casa.pos;
  const CR = new Armador();
  CR.box(M(0xf2b8a8), 3.4, 3.3, 3.6, cx, 1.95, cz);
  CR.box(M(C.moldura), 3.5, 0.2, 3.7, cx, 3.4, cz); CR.box(M(0xd88f7c), 3.45, 0.24, 3.65, cx, 3.62, cz);
  CR.box(M(C.moldura), 0.1, 2.3, 1.25, cx + 1.73, 1.45, cz);
  CR.box(M(C.verde, { emissive: C.verde, emissiveIntensity: 0.25 }), 0.08, 2.0, 0.95, cx + 1.76, 1.3, cz);
  CR.box(M(C.moldura), 0.1, 1.5, 1.0, cx + 1.73, 1.95, cz + 1.15);
  CR.box(new THREE.MeshBasicMaterial({ color: C.luz, toneMapped: false }), 0.06, 1.2, 0.72, cx + 1.77, 1.95, cz + 1.15);
  CR.box(M(0x8a5a3c), 0.08, 0.25, 0.8, cx + 1.85, 0.42, cz + 1.15);
  scene.add(CR.grupo(true));
  const anillo = new THREE.Mesh(new THREE.RingGeometry(2.2, 2.55, 48), new THREE.MeshBasicMaterial({ color: C.verdeClaro, transparent: true, opacity: 0.8, side: THREE.DoubleSide, depthWrite: false }));
  anillo.rotation.x = -Math.PI / 2; anillo.position.set(LUGARES.casa.puerta[0], 0.05, LUGARES.casa.puerta[1]); scene.add(anillo);

  // ---------- Coctelería El Paisa (negocio fundador) ----------
  const [px, , pz] = LUGARES.paisa.pos;
  const EP = new Armador();
  EP.box(M(0xe7c24f), 3.8, 3.9, 4.4, px, 2.25, pz);
  EP.box(M(C.moldura), 3.95, 0.22, 4.55, px, 4.05, pz); EP.box(M(0xc9a03a), 3.9, 0.26, 4.5, px, 4.3, pz);
  for (const dz of [-2.08, 2.08]) EP.box(M(C.moldura), 0.1, 3.6, 0.24, px - 1.93, 2.1, pz + dz);
  scene.add(EP.grupo(true));
  const toldo = pieza(new THREE.PlaneGeometry(4.2, 1.4), new THREE.MeshStandardMaterial({ map: rayas("#e2742c", "#fbe3b0"), side: THREE.DoubleSide, roughness: 0.8 }), px - 2.45, 2.75, pz, false);
  toldo.rotation.set(0, -Math.PI / 2, 0); toldo.rotateX(-0.75);
  const rot = pieza(new THREE.PlaneGeometry(3.4, 1.05), new THREE.MeshBasicMaterial({ map: letrero("EL PAISA", "Coctelería", "#5a3417", "#ffd34d"), toneMapped: false }), px - 1.93, 3.6, pz, false);
  rot.rotation.y = -Math.PI / 2;
  pieza(new THREE.BoxGeometry(0.08, 1.6, 2.6), new THREE.MeshBasicMaterial({ color: C.luz, toneMapped: false }), px - 1.92, 1.25, pz, false);
  for (const dz of [-1.6, 1.6]) {
    pieza(new THREE.CylinderGeometry(0.5, 0.5, 0.08, 12), M(0xf1f5f9), px - 3.3, 1.0, pz + dz);
    pieza(new THREE.CylinderGeometry(0.05, 0.05, 1.9, 6), M(0x9aa3af), px - 3.3, 1.3, pz + dz);
    pieza(new THREE.ConeGeometry(1.0, 0.45, 8), M(dz < 0 ? 0xe2742c : 0x22c55e), px - 3.3, 2.35, pz + dz);
  }

  // ---------- Negocio aliado ----------
  const [ax, , az] = LUGARES.aliado.pos;
  const NA = new Armador();
  NA.box(M(0x7fb3c6), 4.0, 3.4, 3.6, ax, 2.0, az);
  NA.box(M(C.moldura), 4.15, 0.22, 3.75, ax, 3.6, az); NA.box(M(0x6597ab), 4.1, 0.26, 3.7, ax, 3.85, az);
  for (const dx of [-1.9, 1.9]) NA.box(M(C.moldura), 0.24, 3.1, 0.1, ax + dx, 1.85, az - 1.83);
  scene.add(NA.grupo(true));
  const toldo2 = pieza(new THREE.PlaneGeometry(4.2, 1.2), new THREE.MeshStandardMaterial({ map: rayas("#e46b97", "#ffffff"), side: THREE.DoubleSide }), ax, 2.6, az - 2.3, false);
  toldo2.rotation.set(Math.PI + 0.75, 0, 0);
  const rot2 = pieza(new THREE.PlaneGeometry(3.4, 0.9), new THREE.MeshBasicMaterial({ map: letrero("MJ AZARCOYA", "Calzado · Aliado", "#2a0f1c", "#ff9cc2", 600, 160), toneMapped: false }), ax, 3.25, az - 1.85, false);
  rot2.rotation.y = Math.PI;
  pieza(new THREE.BoxGeometry(2.4, 1.5, 0.08), new THREE.MeshBasicMaterial({ color: C.luz, toneMapped: false }), ax, 1.1, az - 1.84, false);

  // ---------- La parada (lejos de la casa), con motocarros esperando ----------
  const [qx, , qz] = LUGARES.parada.pos;
  pieza(new THREE.BoxGeometry(1.6, 0.12, 3.4), M(0x9aa3af), qx, 2.55, qz);
  for (const dz of [-1.5, 1.5]) pieza(new THREE.CylinderGeometry(0.07, 0.07, 2.3, 6), M(0x9aa3af), qx + 0.6, 1.4, qz + dz);
  pieza(new THREE.BoxGeometry(0.5, 0.15, 2.6), M(0x5b6370), qx + 0.3, 0.85, qz);
  for (const [dz, c] of [[-0.6, 0x7da3c9], [0.5, 0xd9826f]]) pieza(gente, M(c), qx - 0.4, 0.95, qz + dz);
  const estacionados = [
    [motocarro(0x2563eb, 0x1d4ed8), -22.2, -25.2, -Math.PI / 2],
    [motocarro(0xf4f4f5, 0xdc2626), -22.2, -21.6, -Math.PI / 2],
    [mototaxi(0xd42a2a, false), -6.2, -2.5, -Math.PI / 2],
    [mototaxi(0xeef0f2, false), 6.2, 2.8, Math.PI / 2],
    [motocarro(0xf59e0b, 0x16a34a), -2.6, -9.85, 0],
  ];
  for (const [g, x, z, ry] of estacionados) { g.position.set(x, 0, z); g.rotation.y = ry; scene.add(g); }

  // ---------- Reloj de "Agenda" ----------
  const reloj = new THREE.Group();
  reloj.add(new THREE.Mesh(new THREE.CircleGeometry(1.15, 40), new THREE.MeshBasicMaterial({ color: 0x0d1015, transparent: true, opacity: 0.88 })));
  const aro = new THREE.Mesh(new THREE.TorusGeometry(1.2, 0.1, 10, 48), new THREE.MeshBasicMaterial({ color: C.verdeClaro, toneMapped: false })); reloj.add(aro);
  for (let i = 0; i < 12; i++) { const m = new THREE.Mesh(new THREE.BoxGeometry(0.06, i % 3 ? 0.12 : 0.22, 0.02), new THREE.MeshBasicMaterial({ color: 0xc9ced6 })); const a = (i / 12) * Math.PI * 2; m.position.set(Math.sin(a) * 0.95, Math.cos(a) * 0.95, 0.02); m.rotation.z = -a; reloj.add(m); }
  const manecilla = (l, w, c) => { const g = new THREE.Group(); const m = new THREE.Mesh(new THREE.BoxGeometry(w, l, 0.03), new THREE.MeshBasicMaterial({ color: c })); m.position.y = l / 2; g.add(m); g.position.z = 0.04; reloj.add(g); return g; };
  const horas = manecilla(0.55, 0.09, 0xffffff), minutos = manecilla(0.82, 0.06, C.verdeClaro);
  reloj.position.set(cx, 6.6, cz); reloj.scale.setScalar(0.001); scene.add(reloj);
  const brilloReloj = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, color: C.verde, transparent: true, opacity: 0, depthWrite: false, blending: THREE.AdditiveBlending }));
  brilloReloj.position.copy(reloj.position); brilloReloj.scale.setScalar(6); scene.add(brilloReloj);

  // ---------- Rutas verdes que se van dibujando ----------
  const rutas = {};
  for (const [k, pts] of Object.entries(RUTAS)) {
    const segs = []; let largo = 0;
    for (let i = 0; i < pts.length - 1; i++) {
      const [x1, z1] = pts[i], [x2, z2] = pts[i + 1], L = Math.hypot(x2 - x1, z2 - z1);
      const mk = (w, op, add) => {
        const m = new THREE.Mesh(new THREE.BoxGeometry(1, 0.04, w), new THREE.MeshBasicMaterial({ color: C.verdeClaro, transparent: true, opacity: op, depthWrite: false, blending: add ? THREE.AdditiveBlending : THREE.NormalBlending, toneMapped: false }));
        m.rotation.y = -Math.atan2(z2 - z1, x2 - x1); m.position.y = 0.06 + (add ? 0.01 : 0); scene.add(m); return m;
      };
      segs.push({ x1, z1, x2, z2, L, ini: largo, linea: mk(0.42, 0.95, false), halo: mk(1.6, 0.22, true) });
      largo += L;
    }
    rutas[k] = { segs, largo };
  }
  function dibujaRuta(k, f, fuerza) {
    const R = rutas[k]; const hasta = f * R.largo;
    for (const s of R.segs) {
      const v = clamp((hasta - s.ini) / s.L, 0, 1);
      for (const m of [s.linea, s.halo]) {
        m.visible = v > 0.001;
        m.scale.x = Math.max(v * s.L, 0.001);
        m.position.x = s.x1 + (s.x2 - s.x1) * v * 0.5; m.position.z = s.z1 + (s.z2 - s.z1) * v * 0.5;
      }
      s.linea.material.opacity = 0.95 * fuerza; s.halo.material.opacity = 0.22 * fuerza;
    }
  }
  function enRuta(k, f) {
    const R = rutas[k]; let d = clamp(f, 0, 1) * R.largo;
    for (const s of R.segs) { if (d <= s.L || s === R.segs[R.segs.length - 1]) { const v = clamp(d / s.L, 0, 1); return { x: s.x1 + (s.x2 - s.x1) * v, z: s.z1 + (s.z2 - s.z1) * v, ang: Math.atan2(s.z2 - s.z1, s.x2 - s.x1) }; } d -= s.L; }
  }

  const moto = mototaxi(C.verde, true); scene.add(moto);
  const sombraMoto = new THREE.Mesh(new THREE.CircleGeometry(1.8, 24), new THREE.MeshBasicMaterial({ color: 0x000000, transparent: true, opacity: 0.35, depthWrite: false }));
  sombraMoto.rotation.x = -Math.PI / 2; sombraMoto.scale.set(1.2, 0.75, 1); scene.add(sombraMoto);

  // ---------- Etiquetas (HTML encima del dibujo) ----------
  const capa = document.createElement("div"); capa.className = "etiquetas3d"; cont.appendChild(capa);
  const etiqueta = (clase, html, pos) => { const d = document.createElement("div"); d.className = "et3 " + clase; d.innerHTML = html; capa.appendChild(d); return { d, p: new THREE.Vector3(...pos) }; };
  const ets = {
    casa: etiqueta("lugar", "<b>Tu casa</b><small>Aquí pasan por ti</small>", [cx, 5.4, cz]),
    parada: etiqueta("lugar gris", "<b>La parada</b><small>A varias cuadras</small>", [qx, 4.4, qz]),
    paisa: etiqueta("lugar", "<b>Coctelería El Paisa</b><small>Negocio fundador</small>", [px, 6.0, pz]),
    aliado: etiqueta("lugar", "<b>MJ Azarcoya</b><small>Negocio aliado de Ticul</small>", [ax, 5.4, az]),
    llego: etiqueta("evento", "<b>Tu chofer llegó a tu puerta</b>", [LUGARES.casa.puerta[0], 4.4, LUGARES.casa.puerta[1]]),
    pedido: etiqueta("evento", "<b>Pedido en camino</b><small>De El Paisa a tu casa</small>", [8, 4.6, -8]),
    agenda: etiqueta("evento", "<b>Mañana, 6:00 a.m.</b><small>Un chofer confirmó tu viaje</small>", [cx, 9.2, cz]),
    nuevo: etiqueta("evento", "<b>Pedido nuevo</b><small>2 × Ceviche · El Paisa</small>", [px, 6.0, pz]),
    uxmal: etiqueta("lugar gris", "<b>Uxmal</b><small>Zona arqueológica maya</small>", [ux, 13.2, uz]),
    hacienda: etiqueta("lugar gris", "<b>Hacienda henequenera</b><small>Herencia de Yucatán</small>", [hx, 7.0, hz]),
    llegaUx: etiqueta("evento", "<b>Llegaste a Uxmal</b><small>Pirámide del Adivino</small>", [ux, 3.4, uz + 7.6]),
  };

  // ---------- Cámara: un punto de vista por capítulo (0 inicio … 6 final) ----------
  const v3 = (x, y, z) => new THREE.Vector3(x, y, z);
  const tmpM = new THREE.Vector3();
  // Tomas de inicio y final: la cámara se mece despacio de un lado al otro para que se
  // vean las dos orillas (Uxmal y la hacienda) aunque la pantalla sea angosta
  const orbita = (radio, altura, adelanto) => {
    const cel = ancho < 700, a = 1.66 - 0.8 * Math.cos(t * 0.15), lejos = radio * (cel ? 1.05 : 1), ad = adelanto * (cel ? 3.2 : 1);
    return { pos: v3(-1 + Math.cos(a) * lejos, altura * (cel ? 1.55 : 1), -6 + Math.sin(a) * lejos), tgt: v3(-1 - Math.cos(a) * ad, 0, -6 - Math.sin(a) * ad) };
  };
  const vistas = [
    () => orbita(62, 32, 12),
    () => ({ pos: tmpM.clone().add(v3(7, 25, 10)), tgt: tmpM.clone().add(v3(0, 1, 0)) }),
    () => ({ pos: tmpM.clone().add(v3(9, 25, 8)), tgt: tmpM.clone().add(v3(0, 1, 0)) }),
    () => ({ pos: v3(cx + 10, 21, cz + 12), tgt: v3(cx - 1, 3, cz) }),
    () => ({ pos: tmpM.clone().add(v3(5, 24, -9)), tgt: tmpM.clone().add(v3(0, 1, 1)) }),
    () => ({ pos: v3(px - 11, 21, pz - 8), tgt: v3(px - 3, 1.5, pz) }),
    // 6 Conoce: cámara baja frente a la Pirámide del Adivino, con el mototaxi chiquito enfrente
    () => ({ pos: v3(ux + 6 + Math.sin(t * 0.25) * 2, ancho < 700 ? 15 : 13, uz + 29), tgt: v3(ux - 1, ancho < 700 ? 5 : 5.5, uz + 2) }),
    () => orbita(66, 44, 12),
  ];

  function estadoMoto(P) {
    // Cada recorrido va del capítulo k-0.7 a k (llega justo cuando sale su texto)
    let pos = { x: RUTAS[1][0][0], z: RUTAS[1][0][1], ang: Math.PI / 2 };
    for (const k of [1, 2, 3, 4, 5, 6]) {
      const f = clamp((P - (k - 0.7)) / 0.62, 0, 1);
      if (P >= k - 0.7) pos = enRuta(k, suave(f));
    }
    return pos;
  }

  let ancho = 1, alto = 1, mx = 0, my = 0, Ps = getP();
  function medir() {
    ancho = cont.clientWidth; alto = cont.clientHeight;
    for (const e of Object.values(ets)) e.w = 0;
    renderer.setSize(ancho, alto, false);
    camera.aspect = ancho / alto; camera.fov = ancho < 700 ? 52 : 38;
    if (ancho >= 900) camera.setViewOffset(ancho, alto, -ancho * 0.18, 0, ancho, alto);
    else camera.setViewOffset(ancho, alto, 0, alto * 0.2, ancho, alto);
    camera.updateProjectionMatrix();
  }
  medir();
  new ResizeObserver(medir).observe(cont);
  window.addEventListener("pointermove", (e) => { mx = e.clientX / window.innerWidth - 0.5; my = e.clientY / window.innerHeight - 0.5; }, { passive: true });

  const camPos = v3(40, 30, 44), camTgt = v3(-1, 1, -6), proy = new THREE.Vector3();
  let activo = true, ultimo = performance.now(), t = 0, pedido = 0, angMoto = Math.PI / 2;
  // Un solo ciclo de dibujo a la vez: si ya hay un cuadro pedido no se pide otro.
  const pedir = () => { if (!pedido) pedido = requestAnimationFrame(cuadro); };
  new IntersectionObserver((e) => { activo = e[0].isIntersecting; if (activo) { ultimo = performance.now(); pedir(); } }, { rootMargin: "100px" }).observe(cont);
  document.addEventListener("visibilitychange", () => { if (!document.hidden && activo) { ultimo = performance.now(); pedir(); } });

  function cuadro(ahora) {
    pedido = 0;
    if (!activo || document.hidden) return;
    const dt = Math.min((ahora - ultimo) / 1000, 0.05); ultimo = ahora; t += dt;
    Ps += (getP() - Ps) * Math.min(1, dt * 5);
    const P = Ps;

    // Mototaxi (gira suave en las esquinas)
    const m = estadoMoto(P);
    let dA = m.ang - angMoto; dA = Math.atan2(Math.sin(dA), Math.cos(dA)); angMoto += dA * Math.min(1, dt * 8);
    moto.position.set(m.x, Math.sin(t * 12) * 0.02, m.z); moto.rotation.y = -angMoto;
    sombraMoto.position.set(m.x, 0.03, m.z); sombraMoto.rotation.z = -angMoto;
    tmpM.set(m.x, 0, m.z);

    // Rutas
    for (const k of [1, 2, 3, 4, 5, 6]) {
      const f = clamp((P - (k - 0.7)) / 0.62, 0, 1);
      const fuerza = P > 6.6 ? 1 : (Math.abs(P - k) < 0.6 ? 1 : 0.3);
      dibujaRuta(k, suave(f), fuerza);
    }

    // Cámara entre los dos capítulos más cercanos
    const i = clamp(Math.floor(P), 0, 6), f = suave(clamp(P - i, 0, 1));
    const a = vistas[i](), b = vistas[i + 1]();
    const objPos = a.pos.lerp(b.pos, f), objTgt = a.tgt.lerp(b.tgt, f);
    // De El Paisa a Uxmal (y de regreso a la vista final) la cámara vuela por arriba de las casas
    if (i === 5 || i === 6) objPos.y += Math.sin(f * Math.PI) * 16;
    objPos.x += mx * 3; objPos.y -= my * 2;
    camPos.lerp(objPos, Math.min(1, dt * 4)); camTgt.lerp(objTgt, Math.min(1, dt * 4));
    camera.position.copy(camPos); camera.lookAt(camTgt);

    // Detalles vivos
    anillo.scale.setScalar(1 + Math.sin(t * 3) * 0.08); anillo.material.opacity = 0.55 + Math.sin(t * 3) * 0.25;
    const vr = suave(clamp(1 - Math.abs(P - 3) / 0.7, 0, 1));
    reloj.scale.setScalar(Math.max(vr * 1.6, 0.001)); reloj.quaternion.copy(camera.quaternion);
    reloj.position.y = 6.6 + Math.sin(t * 2) * 0.15; brilloReloj.position.copy(reloj.position); brilloReloj.material.opacity = vr * 0.5;
    minutos.rotation.z = -t * 2.4; horas.rotation.z = -t * 0.2;
    for (const s of focos) s.material.opacity = 0.75 + Math.sin(t * 2 + s.position.x) * 0.08;

    // Etiquetas
    const mostrar = {
      llego: P > 0.9 && P < 1.4, pedido: P > 1.7 && P < 2.45, agenda: P > 2.7 && P < 3.35, nuevo: P > 4.7 && P < 5.45,
      parada: P < 1.6 || P > 6.6, aliado: P > 2.5, uxmal: P < 0.6 || P > 6.6, hacienda: P < 0.6 || P > 6.6,
      llegaUx: P > 5.75 && P < 6.45,
    };
    // Si sale un aviso encima de un lugar, se esconde la etiqueta del lugar para que no se encimen
    mostrar.casa = !mostrar.llego && !mostrar.agenda;
    mostrar.paisa = !mostrar.nuevo;
    const foco = { casa: [1, 3], paisa: [2, 5], aliado: [4], parada: [1] };
    for (const [k, e] of Object.entries(ets)) {
      proy.copy(e.p).project(camera);
      const vis = mostrar[k] && proy.z < 1 && Math.abs(proy.x) < 1.1 && Math.abs(proy.y) < 0.95;
      e.d.classList.toggle("ve", !!vis);
      e.d.classList.toggle("foco", (foco[k] || []).some((c) => Math.abs(P - c) < 0.5));
      if (vis) {
        // Que la etiqueta no se salga por los lados: se recorre y la flechita sigue apuntando al lugar
        if (!e.w) { e.w = e.d.offsetWidth; e.h = e.d.offsetHeight; }
        const x = ((proy.x + 1) / 2) * ancho, mitad = e.w / 2 + 10;
        const xc = Math.min(Math.max(x, mitad), Math.max(mitad, ancho - mitad));
        e.d.style.setProperty("--dx", `${Math.max(-e.w / 2 + 14, Math.min(e.w / 2 - 14, x - xc))}px`);
        // ...y que no quede escondida debajo de la barra de arriba (logo y "Abrir app")
        const y = Math.max(((1 - proy.y) / 2) * alto, e.h + 84);
        e.d.style.transform = `translate(${xc}px, ${y}px) translate(-50%, -100%)`;
      }
    }

    renderer.render(scene, camera);
    pedir();
  }
  pedir();
  return { renderer };
}
