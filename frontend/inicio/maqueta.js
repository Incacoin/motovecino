// Maqueta 3D del municipio para la página de inicio (15-nov-2026).
// Al bajar con el dedo el mototaxi recorre 5 paradas: Muévete, Pide, Agenda,
// Aliados y Vende. Todo se dibuja con figuras simples (sin modelos de terceros).
// La página le pasa el avance (0 a 6) con getP(); aquí solo se dibuja.
import * as THREE from "three";

const C = {
  noche: 0x0a0c10, calle: 0x13171d, banqueta: 0x222833, plaza: 0x2a2620, raya: 0x3a414c,
  verde: 0x22c55e, verdeClaro: 0x4ade80, crema: 0xeadfc6, ocre: 0xd6a85a, oscuro: 0x15181d,
  luz: 0xffcf7a,
};
const CASAS = [0xe3b35b, 0xd9826f, 0x6fb3a8, 0xe8dcc0, 0xc790a8, 0x88b06e, 0xe0c27a, 0x7da3c9, 0xd8a48f];
const CALLES = [-40, -24, -8, 8, 24, 40];
const MANZANAS = [-32, -16, 0, 16, 32];

// Lugares importantes (puerta = punto en la calle donde se para el mototaxi)
export const LUGARES = {
  parada: { pos: [-21.6, 0, -30], puerta: [-24, -36] },
  casa: { pos: [-12.2, 0, 16], puerta: [-8, 16] },
  paisa: { pos: [12.1, 0, -16], puerta: [8, -16] },
  aliado: { pos: [16, 0, 12.1], puerta: [16, 8] },
};
// Recorridos del mototaxi por capítulo (1 Muévete, 2 Pide, 4 Aliados, 5 Vende)
const RUTAS = {
  1: [[-24, -36], [-24, -8], [-8, -8], [-8, 16]],
  2: [[-8, 16], [-8, -8], [8, -8], [8, -16]],
  4: [[8, -16], [8, 8], [16, 8]],
  5: [[16, 8], [8, 8], [8, -16]],
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

// Varias cajas en una sola llamada de dibujo (rápido en celulares sencillos)
class Cajas {
  constructor(max, mat, sombra = true) {
    this.m = new THREE.InstancedMesh(new THREE.BoxGeometry(1, 1, 1), mat, max);
    this.m.castShadow = sombra; this.m.receiveShadow = true; this.n = 0;
    this.o = new THREE.Object3D(); this.c = new THREE.Color();
  }
  add(x, y, z, sx, sy, sz, color, ry = 0) {
    const o = this.o; o.position.set(x, y + sy / 2, z); o.scale.set(sx, sy, sz); o.rotation.set(0, ry, 0); o.updateMatrix();
    this.m.setMatrixAt(this.n, o.matrix); if (color != null) this.m.setColorAt(this.n, this.c.set(color)); this.n++;
  }
  fin() { this.m.count = this.n; this.m.instanceMatrix.needsUpdate = true; if (this.m.instanceColor) this.m.instanceColor.needsUpdate = true; return this.m; }
}

function mototaxi() {
  const g = new THREE.Group();
  const M = (c, o = {}) => new THREE.MeshStandardMaterial({ color: c, roughness: 0.5, metalness: 0.1, ...o });
  const verde = M(C.verde, { roughness: 0.35 }), blanco = M(0xf1f5f9), negro = M(0x111418, { roughness: 0.8 }), asiento = M(0x3b2a20);
  const caja = (sx, sy, sz, mat, x, y, z) => { const m = new THREE.Mesh(new THREE.BoxGeometry(sx, sy, sz), mat); m.position.set(x, y, z); m.castShadow = true; g.add(m); return m; };
  caja(1.5, 0.75, 1.55, verde, -0.45, 0.78, 0);
  caja(0.85, 0.2, 1.35, asiento, -0.65, 1.22, 0);
  caja(0.16, 0.75, 1.35, asiento, -1.1, 1.5, 0);
  caja(2.5, 0.1, 1.8, verde, -0.25, 2.2, 0);
  caja(2.52, 0.05, 0.55, blanco, -0.25, 2.27, 0);
  for (const [x, z] of [[0.8, 0.82], [0.8, -0.82], [-1.15, 0.82], [-1.15, -0.82]]) {
    const p = new THREE.Mesh(new THREE.CylinderGeometry(0.045, 0.045, 1.1, 6), negro); p.position.set(x, 1.65, z); g.add(p);
  }
  caja(1.05, 0.32, 0.36, blanco, 0.85, 0.78, 0);
  caja(0.5, 0.26, 0.32, verde, 0.92, 1.05, 0);
  const horq = new THREE.Mesh(new THREE.CylinderGeometry(0.06, 0.06, 1.05, 6), negro); horq.position.set(1.38, 0.82, 0); horq.rotation.z = 0.35; g.add(horq);
  caja(0.08, 0.08, 0.95, negro, 1.25, 1.33, 0);
  const faro = new THREE.Mesh(new THREE.SphereGeometry(0.13, 12, 8), new THREE.MeshBasicMaterial({ color: 0xfff3c4 })); faro.position.set(1.5, 1.15, 0); g.add(faro);
  const rueda = new THREE.CylinderGeometry(0.34, 0.34, 0.2, 14);
  for (const [x, z] of [[-0.55, 0.85], [-0.55, -0.85], [1.55, 0]]) {
    const r = new THREE.Mesh(rueda, negro); r.rotation.x = Math.PI / 2; r.position.set(x, 0.34, z); r.castShadow = true; g.add(r);
  }
  const luz = new THREE.PointLight(C.verdeClaro, 7, 8, 2); luz.position.set(0, 2.8, 0); g.add(luz);
  return g;
}

export function iniciar(cont, getP) {
  const pruebaCanvas = document.createElement("canvas");
  if (!(pruebaCanvas.getContext("webgl2") || pruebaCanvas.getContext("webgl"))) return null;
  const sencillo = (navigator.deviceMemory && navigator.deviceMemory <= 2) || (navigator.hardwareConcurrency && navigator.hardwareConcurrency <= 4);

  const renderer = new THREE.WebGLRenderer({ antialias: !sencillo, alpha: true, powerPreference: "high-performance" });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, sencillo ? 1 : 1.6));
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping; renderer.toneMappingExposure = 1.05;
  renderer.shadowMap.enabled = !sencillo; renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  renderer.domElement.className = "lienzo3d";
  cont.appendChild(renderer.domElement);

  const scene = new THREE.Scene();
  scene.fog = new THREE.Fog(C.noche, 62, 128);
  const camera = new THREE.PerspectiveCamera(40, 1, 0.5, 300);

  scene.add(new THREE.HemisphereLight(0x8fb6ff, 0x0b0d10, 0.75));
  const sol = new THREE.DirectionalLight(0xffd6a0, 1.5);
  sol.position.set(30, 44, 22); sol.castShadow = !sencillo;
  Object.assign(sol.shadow.camera, { left: -46, right: 46, top: 46, bottom: -46, near: 1, far: 140 });
  sol.shadow.mapSize.set(window.innerWidth < 700 ? 1024 : 2048, window.innerWidth < 700 ? 1024 : 2048); sol.shadow.bias = -0.0008;
  scene.add(sol);
  const relleno = new THREE.DirectionalLight(0x5fd9a0, 0.35); relleno.position.set(-30, 20, -20); scene.add(relleno);

  // Suelo, calles y banquetas
  const suelo = new THREE.Mesh(new THREE.PlaneGeometry(260, 260), new THREE.MeshStandardMaterial({ color: C.calle, roughness: 0.95 }));
  suelo.rotation.x = -Math.PI / 2; suelo.receiveShadow = true; scene.add(suelo);
  const lisa = new THREE.MeshStandardMaterial({ roughness: 0.9 });
  const losas = new Cajas(30, lisa, false);
  for (const x of MANZANAS) for (const z of MANZANAS) losas.add(x, 0, z, 11, 0.3, 11, x === 0 && z === 0 ? C.plaza : C.banqueta);
  scene.add(losas.fin());
  const rayasCalle = new Cajas(400, new THREE.MeshBasicMaterial({ color: C.raya }), false);
  for (const k of CALLES) for (let t = -46; t <= 46; t += 3.2) { rayasCalle.add(k, 0.01, t, 0.22, 0.02, 1.3); rayasCalle.add(t, 0.01, k, 1.3, 0.02, 0.22); }
  scene.add(rayasCalle.fin());

  // Casitas de colores, techos planos con pretil, puertas y ventanas encendidas
  const r = rng(29);
  const cuerpos = new Cajas(260, new THREE.MeshStandardMaterial({ roughness: 0.85 }));
  const pretiles = new Cajas(260, new THREE.MeshStandardMaterial({ roughness: 0.85 }));
  const puertas = new Cajas(260, new THREE.MeshStandardMaterial({ color: 0x2a1e16, roughness: 0.9 }), false);
  const ventanas = new Cajas(520, new THREE.MeshBasicMaterial({ toneMapped: false }), false);
  const ocupado = (x, z) => Object.values(LUGARES).some((l) => Math.hypot(l.pos[0] - x, l.pos[2] - z) < 2.4);
  function casita(x, z, frente) {
    if (ocupado(x, z)) return;
    const w = 3.1 + r() * 0.5, d = 3.4, h = 2.2 + r() * 1.5, col = CASAS[Math.floor(r() * CASAS.length)];
    const ry = { S: 0, N: Math.PI, E: Math.PI / 2, W: -Math.PI / 2 }[frente];
    cuerpos.add(x, 0.3, z, w, h, d, col, ry);
    const c2 = new THREE.Color(col).multiplyScalar(0.8).getHex();
    pretiles.add(x, 0.3 + h, z, w + 0.12, 0.28, d + 0.12, c2, ry);
    const n = new THREE.Vector3(0, 0, 1).applyAxisAngle(new THREE.Vector3(0, 1, 0), ry);
    const t = new THREE.Vector3(1, 0, 0).applyAxisAngle(new THREE.Vector3(0, 1, 0), ry);
    const f = new THREE.Vector3(x, 0, z).addScaledVector(n, d / 2 + 0.03);
    const dx = (r() - 0.5) * 0.8;
    puertas.add(f.x + t.x * dx, 0.3, f.z + t.z * dx, 0.85, 1.55, 0.08, null, ry);
    const vx = dx > 0 ? -0.95 : 0.95, enc = r() < 0.6;
    ventanas.add(f.x + t.x * vx, 1.15, f.z + t.z * vx, 0.75, 0.75, 0.06, enc ? C.luz : 0x1e2a3a, ry);
    if (h > 3.3) ventanas.add(f.x + t.x * vx, 2.6, f.z + t.z * vx, 0.75, 0.6, 0.06, r() < 0.5 ? C.luz : 0x1e2a3a, ry);
  }
  for (const bx of MANZANAS) for (const bz of MANZANAS) {
    if (bx === 0 && bz === 0) continue;
    for (const o of [-3.6, 0, 3.6]) { casita(bx + o, bz + 3.75, "S"); casita(bx + o, bz - 3.75, "N"); }
    casita(bx + 3.75, bz, "E"); casita(bx - 3.75, bz, "W");
  }
  scene.add(cuerpos.fin(), pretiles.fin(), puertas.fin(), ventanas.fin());

  // Plaza: iglesia, kiosko, árboles y faroles
  const M = (c, o = {}) => new THREE.MeshStandardMaterial({ color: c, roughness: 0.8, ...o });
  const pieza = (geo, mat, x, y, z, sombra = true) => { const m = new THREE.Mesh(geo, mat); m.position.set(x, y, z); m.castShadow = sombra; m.receiveShadow = true; scene.add(m); return m; };
  const crema = M(C.crema), ocre = M(C.ocre), oscuro = M(0x1d1712);
  pieza(new THREE.BoxGeometry(5, 4.6, 5.4), crema, 0, 2.6, -2.5);
  pieza(new THREE.BoxGeometry(5.8, 6.2, 0.7), crema, 0, 3.4, 0.35);
  pieza(new THREE.BoxGeometry(2.4, 1.7, 0.7), crema, 0, 7.35, 0.35);
  pieza(new THREE.BoxGeometry(5.9, 0.25, 0.8), ocre, 0, 6.5, 0.35);
  for (const x of [-0.55, 0.55]) pieza(new THREE.BoxGeometry(0.5, 0.75, 0.75), oscuro, x, 7.35, 0.38, false);
  pieza(new THREE.BoxGeometry(1.3, 2.3, 0.75), oscuro, 0, 1.45, 0.4, false);
  for (const x of [-3.05, 3.05]) {
    pieza(new THREE.BoxGeometry(1.3, 7.6, 1.3), crema, x, 4.1, 0.3);
    pieza(new THREE.SphereGeometry(0.75, 14, 8, 0, Math.PI * 2, 0, Math.PI / 2), ocre, x, 7.9, 0.3);
  }
  pieza(new THREE.CylinderGeometry(1.7, 1.8, 0.45, 8), M(0xcfc3a8), 0, 0.5, 3.3);
  for (let i = 0; i < 8; i++) { const a = (i / 8) * Math.PI * 2; pieza(new THREE.CylinderGeometry(0.07, 0.07, 1.8, 6), M(0xf1f5f9), Math.cos(a) * 1.45, 1.6, 3.3 + Math.sin(a) * 1.45); }
  pieza(new THREE.ConeGeometry(2.1, 1.2, 8), M(0x2f8f5b), 0, 3.1, 3.3);

  const troncos = new Cajas(80, M(0x4a3426), true), copas = [];
  const copaGeo = new THREE.IcosahedronGeometry(1, 0);
  const copaMat = new THREE.MeshStandardMaterial({ roughness: 0.9, flatShading: true });
  const arboles = new THREE.InstancedMesh(copaGeo, copaMat, 80); arboles.castShadow = true;
  let na = 0; const o3 = new THREE.Object3D(), col3 = new THREE.Color();
  const arbol = (x, z, s = 1) => {
    troncos.add(x, 0.3, z, 0.25, 1.4 * s, 0.25, null);
    o3.position.set(x, 0.3 + 1.4 * s + 0.9 * s, z); o3.scale.setScalar(1.25 * s); o3.rotation.set(r(), r(), r()); o3.updateMatrix();
    arboles.setMatrixAt(na, o3.matrix); arboles.setColorAt(na, col3.set([0x2f7d4a, 0x3e9b5a, 0x2a6b42][na % 3])); na++;
  };
  for (const [x, z] of [[-4.3, -4.6], [4.3, -4.6], [-4.4, 1.6], [4.4, 1.6], [-4.4, 4.6], [4.4, 4.6], [-2.2, 5], [2.2, 5]]) arbol(x, z, 1);
  for (const bx of MANZANAS) for (const bz of MANZANAS) if ((bx || bz) && r() < 0.45) arbol(bx + (r() < 0.5 ? -5 : 5), bz + (r() - 0.5) * 6, 0.8);
  arboles.count = na; arboles.instanceMatrix.needsUpdate = true; arboles.instanceColor.needsUpdate = true;
  scene.add(troncos.fin(), arboles);

  const tex = brilloTex();
  const postes = new Cajas(60, M(0x22262d), false);
  const focos = [];
  const farol = (x, z) => {
    postes.add(x, 0.3, z, 0.12, 3.1, 0.12, null);
    const s = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, color: C.luz, transparent: true, opacity: 0.85, depthWrite: false, blending: THREE.AdditiveBlending }));
    s.position.set(x, 3.5, z); s.scale.setScalar(2.4); scene.add(s); focos.push(s);
    pieza(new THREE.SphereGeometry(0.16, 8, 6), new THREE.MeshBasicMaterial({ color: 0xffe3a8 }), x, 3.45, z, false);
  };
  for (const [x, z] of [[-5.3, -5.3], [5.3, -5.3], [-5.3, 5.3], [5.3, 5.3]]) farol(x, z);
  for (const x of [-24, -8, 8, 24]) for (const z of [-24, -8, 8, 24]) if (r() < 0.55) farol(x + 2.9, z + 2.9);
  scene.add(postes.fin());

  // Casa de Rosa (destino del viaje)
  const [cx, , cz] = LUGARES.casa.pos;
  pieza(new THREE.BoxGeometry(3.4, 3.2, 3.6), M(0xf3ead6), cx, 1.9, cz);
  pieza(new THREE.BoxGeometry(3.55, 0.3, 3.75), M(0xd9ccb0), cx, 3.6, cz);
  pieza(new THREE.BoxGeometry(0.08, 1.7, 0.95), M(C.verde, { emissive: C.verde, emissiveIntensity: 0.25 }), cx + 1.74, 1.15, cz, false);
  pieza(new THREE.BoxGeometry(0.06, 0.8, 0.8), new THREE.MeshBasicMaterial({ color: C.luz, toneMapped: false }), cx + 1.73, 1.6, cz + 1.05, false);
  const anillo = new THREE.Mesh(new THREE.RingGeometry(2.2, 2.55, 48), new THREE.MeshBasicMaterial({ color: C.verdeClaro, transparent: true, opacity: 0.8, side: THREE.DoubleSide, depthWrite: false }));
  anillo.rotation.x = -Math.PI / 2; anillo.position.set(LUGARES.casa.puerta[0], 0.05, LUGARES.casa.puerta[1]); scene.add(anillo);

  // Coctelería El Paisa (negocio fundador)
  const [px, , pz] = LUGARES.paisa.pos;
  pieza(new THREE.BoxGeometry(3.8, 3.7, 4.4), M(0xf2e6c9), px, 2.15, pz);
  pieza(new THREE.BoxGeometry(3.95, 0.3, 4.55), M(0xc9a46a), px, 4.1, pz);
  const toldo = pieza(new THREE.PlaneGeometry(4.2, 1.4), new THREE.MeshStandardMaterial({ map: rayas("#e2742c", "#fbe3b0"), side: THREE.DoubleSide, roughness: 0.8 }), px - 2.45, 2.75, pz, false);
  toldo.rotation.set(0, -Math.PI / 2, 0); toldo.rotateX(-0.75);
  const rot = pieza(new THREE.PlaneGeometry(3.4, 1.05), new THREE.MeshBasicMaterial({ map: letrero("EL PAISA", "Coctelería", "#5a3417", "#ffd34d"), toneMapped: false }), px - 1.92, 3.6, pz, false);
  rot.rotation.y = -Math.PI / 2;
  pieza(new THREE.BoxGeometry(0.08, 1.6, 2.6), new THREE.MeshBasicMaterial({ color: C.luz, toneMapped: false }), px - 1.91, 1.25, pz, false);
  for (const dz of [-1.6, 1.6]) {
    pieza(new THREE.CylinderGeometry(0.5, 0.5, 0.08, 12), M(0xf1f5f9), px - 3.3, 1.0, pz + dz);
    pieza(new THREE.CylinderGeometry(0.05, 0.05, 1.9, 6), M(0x9aa3af), px - 3.3, 1.3, pz + dz);
    pieza(new THREE.ConeGeometry(1.0, 0.45, 8), M(dz < 0 ? 0xe2742c : 0x22c55e), px - 3.3, 2.35, pz + dz);
  }

  // Negocio aliado
  const [ax, , az] = LUGARES.aliado.pos;
  pieza(new THREE.BoxGeometry(4.0, 3.3, 3.6), M(0xf3d3dc), ax, 1.95, az);
  pieza(new THREE.BoxGeometry(4.15, 0.3, 3.75), M(0xd9a9b8), ax, 3.75, az);
  const toldo2 = pieza(new THREE.PlaneGeometry(4.2, 1.2), new THREE.MeshStandardMaterial({ map: rayas("#e46b97", "#ffffff"), side: THREE.DoubleSide }), ax, 2.6, az - 2.3, false);
  toldo2.rotation.set(Math.PI + 0.75, 0, 0);
  const rot2 = pieza(new THREE.PlaneGeometry(3.4, 0.9), new THREE.MeshBasicMaterial({ map: letrero("ALIADO", "Negocio", "#2a0f1c", "#ff9cc2"), toneMapped: false }), ax, 3.25, az - 1.82, false);
  rot2.rotation.y = Math.PI;
  pieza(new THREE.BoxGeometry(2.4, 1.5, 0.08), new THREE.MeshBasicMaterial({ color: C.luz, toneMapped: false }), ax, 1.1, az - 1.81, false);

  // La parada (lejos de la casa)
  const [qx, , qz] = LUGARES.parada.pos;
  pieza(new THREE.BoxGeometry(1.6, 0.12, 3.4), M(0x9aa3af), qx, 2.55, qz);
  for (const dz of [-1.5, 1.5]) pieza(new THREE.CylinderGeometry(0.07, 0.07, 2.3, 6), M(0x9aa3af), qx + 0.6, 1.4, qz + dz);
  pieza(new THREE.BoxGeometry(0.5, 0.15, 2.6), M(0x5b6370), qx + 0.3, 0.85, qz);
  const gente = new THREE.CapsuleGeometry(0.24, 0.55, 4, 8);
  for (const [dz, c] of [[-0.6, 0x7da3c9], [0.5, 0xd9826f]]) pieza(gente, M(c), qx - 0.4, 0.95, qz + dz);

  // Reloj de "Agenda"
  const reloj = new THREE.Group();
  reloj.add(new THREE.Mesh(new THREE.CircleGeometry(1.15, 40), new THREE.MeshBasicMaterial({ color: 0x0d1015, transparent: true, opacity: 0.88 })));
  const aro = new THREE.Mesh(new THREE.TorusGeometry(1.2, 0.1, 10, 48), new THREE.MeshBasicMaterial({ color: C.verdeClaro, toneMapped: false })); reloj.add(aro);
  for (let i = 0; i < 12; i++) { const m = new THREE.Mesh(new THREE.BoxGeometry(0.06, i % 3 ? 0.12 : 0.22, 0.02), new THREE.MeshBasicMaterial({ color: 0xc9ced6 })); const a = (i / 12) * Math.PI * 2; m.position.set(Math.sin(a) * 0.95, Math.cos(a) * 0.95, 0.02); m.rotation.z = -a; reloj.add(m); }
  const manecilla = (l, w, c) => { const g = new THREE.Group(); const m = new THREE.Mesh(new THREE.BoxGeometry(w, l, 0.03), new THREE.MeshBasicMaterial({ color: c })); m.position.y = l / 2; g.add(m); g.position.z = 0.04; reloj.add(g); return g; };
  const horas = manecilla(0.55, 0.09, 0xffffff), minutos = manecilla(0.82, 0.06, C.verdeClaro);
  reloj.position.set(cx, 6.6, cz); reloj.scale.setScalar(0.001); scene.add(reloj);
  const brilloReloj = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, color: C.verde, transparent: true, opacity: 0, depthWrite: false, blending: THREE.AdditiveBlending }));
  brilloReloj.position.copy(reloj.position); brilloReloj.scale.setScalar(6); scene.add(brilloReloj);

  // Rutas verdes que se van dibujando
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

  const moto = mototaxi(); scene.add(moto);
  const sombraMoto = new THREE.Mesh(new THREE.CircleGeometry(1.7, 24), new THREE.MeshBasicMaterial({ color: 0x000000, transparent: true, opacity: 0.35, depthWrite: false }));
  sombraMoto.rotation.x = -Math.PI / 2; scene.add(sombraMoto);

  // Etiquetas (HTML encima del dibujo)
  const capa = document.createElement("div"); capa.className = "etiquetas3d"; cont.appendChild(capa);
  const etiqueta = (clase, html, pos) => { const d = document.createElement("div"); d.className = "et3 " + clase; d.innerHTML = html; capa.appendChild(d); return { d, p: new THREE.Vector3(...pos) }; };
  const ets = {
    casa: etiqueta("lugar", "<b>Tu casa</b><small>Aquí te recogen</small>", [cx, 5.2, cz]),
    parada: etiqueta("lugar gris", "<b>La parada</b><small>A varias cuadras</small>", [qx, 4.4, qz]),
    paisa: etiqueta("lugar", "<b>Coctelería El Paisa</b><small>Negocio fundador</small>", [px, 5.8, pz]),
    aliado: etiqueta("lugar", "<b>Negocio aliado</b><small>De tu municipio</small>", [ax, 5.4, az]),
    llego: etiqueta("evento", "<b>Tu chofer llegó a tu puerta</b>", [LUGARES.casa.puerta[0], 4.4, LUGARES.casa.puerta[1]]),
    pedido: etiqueta("evento", "<b>Pedido en camino</b><small>De El Paisa a tu casa</small>", [8, 4.6, -8]),
    agenda: etiqueta("evento", "<b>Mañana, 6:00 a.m.</b><small>Un chofer confirmó tu viaje</small>", [cx, 9.2, cz]),
    nuevo: etiqueta("evento", "<b>Pedido nuevo</b><small>2 × Ceviche</small>", [px, 7.4, pz]),
  };

  // Cámara: un punto de vista por capítulo (0 inicio … 6 final)
  const v3 = (x, y, z) => new THREE.Vector3(x, y, z);
  const tmpM = new THREE.Vector3();
  const vistas = [
    () => ({ pos: v3(50, 44, 54), tgt: v3(0, 0, 0) }),
    () => ({ pos: tmpM.clone().add(v3(11, 25, 17)), tgt: tmpM.clone().add(v3(0, 1, 0)) }),
    () => ({ pos: tmpM.clone().add(v3(14, 25, 14)), tgt: tmpM.clone().add(v3(0, 1, 0)) }),
    () => ({ pos: v3(cx + 16, 20, cz + 19), tgt: v3(cx - 1, 4.5, cz) }),
    () => ({ pos: tmpM.clone().add(v3(5, 23, -15)), tgt: tmpM.clone().add(v3(0, 1, 2)) }),
    () => ({ pos: v3(px - 13, 22, pz - 13), tgt: v3(px - 2.5, 2, pz) }),
    () => ({ pos: v3(42, 60, 46), tgt: v3(0, 0, 0) }),
  ];

  function estadoMoto(P) {
    // Cada recorrido va del capítulo k-0.7 a k (llega justo cuando sale su texto)
    let pos = { x: RUTAS[1][0][0], z: RUTAS[1][0][1], ang: Math.PI / 2 };
    for (const k of [1, 2, 4, 5]) {
      const f = clamp((P - (k - 0.7)) / 0.62, 0, 1);
      if (P >= k - 0.7) pos = enRuta(k, suave(f));
    }
    return pos;
  }

  let ancho = 1, alto = 1, mx = 0, my = 0, Ps = getP();
  function medir() {
    ancho = cont.clientWidth; alto = cont.clientHeight;
    renderer.setSize(ancho, alto, false);
    camera.aspect = ancho / alto; camera.fov = ancho < 700 ? 52 : 38;
    if (ancho >= 900) camera.setViewOffset(ancho, alto, -ancho * 0.18, 0, ancho, alto);
    else camera.setViewOffset(ancho, alto, 0, alto * 0.2, ancho, alto);
    camera.updateProjectionMatrix();
  }
  medir();
  new ResizeObserver(medir).observe(cont);
  window.addEventListener("pointermove", (e) => { mx = e.clientX / window.innerWidth - 0.5; my = e.clientY / window.innerHeight - 0.5; }, { passive: true });

  const camPos = v3(50, 44, 54), camTgt = v3(0, 0, 0), proy = new THREE.Vector3();
  let activo = true, ultimo = performance.now(), t = 0, pedido = 0;
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

    // Mototaxi
    const m = estadoMoto(P);
    moto.position.set(m.x, 0, m.z); moto.rotation.y = -m.ang; moto.position.y = Math.sin(t * 12) * 0.025;
    sombraMoto.position.set(m.x, 0.03, m.z);
    tmpM.set(m.x, 0, m.z);

    // Rutas
    for (const k of [1, 2, 4, 5]) {
      const f = clamp((P - (k - 0.7)) / 0.62, 0, 1);
      const fuerza = P > 5.6 ? 1 : (Math.abs(P - k) < 0.6 ? 1 : 0.3);
      dibujaRuta(k, suave(f), fuerza);
    }

    // Cámara entre los dos capítulos más cercanos
    const i = clamp(Math.floor(P), 0, 5), f = suave(clamp(P - i, 0, 1));
    const a = vistas[i](), b = vistas[i + 1]();
    const objPos = a.pos.lerp(b.pos, f), objTgt = a.tgt.lerp(b.tgt, f);
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
      casa: true, parada: P < 1.6 || P > 5.6, paisa: true, aliado: P > 2.5,
      llego: P > 0.9 && P < 1.4, pedido: P > 1.7 && P < 2.45, agenda: P > 2.7 && P < 3.35, nuevo: P > 4.7 && P < 5.45,
    };
    const foco = { casa: [1, 3], paisa: [2, 5], aliado: [4], parada: [1] };
    for (const [k, e] of Object.entries(ets)) {
      proy.copy(e.p).project(camera);
      const vis = mostrar[k] && proy.z < 1 && Math.abs(proy.x) < 0.88 && Math.abs(proy.y) < 0.95;
      e.d.classList.toggle("ve", !!vis);
      e.d.classList.toggle("foco", (foco[k] || []).some((c) => Math.abs(P - c) < 0.5));
      if (vis) e.d.style.transform = `translate(${((proy.x + 1) / 2) * ancho}px, ${((1 - proy.y) / 2) * alto}px) translate(-50%, -100%)`;
    }

    renderer.render(scene, camera);
    pedir();
  }
  pedir();
  return { renderer };
}
