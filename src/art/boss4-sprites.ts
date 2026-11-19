// Phase 4 bosses, regions 4 and 5 (src/game/bosses/heli.ts, final.ts): all facing up.
// - Helicopter "VULTURE": 48 x 48 body, 9 x 14 rocket pods, 13 x 12 tail rotor, six 46 px main-rotor frames, a wreck,
//   and white silhouettes (tint mask on) for its shadow (Renderer.shadeSpr darkens the ground to the tint).
// - Final fight: the heavy tank ace's sprites repainted in winter white-wash (copied out of the atlas and recoloured:
//   the olive paint turns white, the dark camo blotches stay as worn olive showing through), 16 px bunker gun turrets,
//   the command bunker's door and the fleeing command car.
import { Atlas, PixelArt } from './atlas';

const rgb = (r: number, g: number, b: number) =>
  (Math.max(0, Math.min(255, r | 0)) << 16) | (Math.max(0, Math.min(255, g | 0)) << 8) | Math.max(0, Math.min(255, b | 0));
const R = (c: number) => (c >> 16) & 255;
const G = (c: number) => (c >> 8) & 255;
const B = (c: number) => c & 255;
const shade = (c: number, f: number) => rgb(R(c) * f, G(c) * f, B(c) * f);

function hash(x: number, y: number, s = 0): number {
  let h = Math.imul(x | 0, 374761393) + Math.imul(y | 0, 668265263) + Math.imul(s | 0, 982451653);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}

const EMBER = 0xff7a1e;
const SOOT = 0x1c1a18;
const SCORCH = 0x3a3430;

/** Colour + height + emission + spec per pixel; `art` bevels edges against lower neighbours (light from the top left). */
class Layer {
  c: Int32Array;
  h: Float32Array;
  e: Int32Array;
  s: Float32Array;
  /** every pixel also glows at this fraction of its colour (drawn with em 0 by day: night readability) */
  selfGlow = 0;
  constructor(public w: number, public hgt: number) {
    this.c = new Int32Array(w * hgt).fill(-1);
    this.h = new Float32Array(w * hgt);
    this.e = new Int32Array(w * hgt);
    this.s = new Float32Array(w * hgt);
  }
  put(x: number, y: number, col: number, h: number, em = 0, spec = -1): void {
    x = Math.round(x);
    y = Math.round(y);
    if (x < 0 || y < 0 || x >= this.w || y >= this.hgt) return;
    const i = y * this.w + x;
    this.c[i] = col;
    this.h[i] = h;
    this.e[i] = em;
    this.s[i] = spec;
  }
  get(x: number, y: number): number {
    if (x < 0 || y < 0 || x >= this.w || y >= this.hgt) return -1;
    return this.c[y * this.w + x];
  }
  rect(x: number, y: number, w: number, h: number, col: number, ht: number, spec = -1): void {
    for (let j = y; j < y + h; j++) for (let i = x; i < x + w; i++) this.put(i, j, col, ht, 0, spec);
  }
  disc(cx: number, cy: number, r: number, col: number, ht: number): void {
    for (let y = Math.floor(cy - r); y <= cy + r; y++) for (let x = Math.floor(cx - r); x <= cx + r; x++) {
      if ((x + 0.5 - cx) ** 2 + (y + 0.5 - cy) ** 2 <= r * r) this.put(x, y, col, ht);
    }
  }
  line(x0: number, y0: number, x1: number, y1: number, col: number, ht: number): void {
    const n = Math.max(Math.abs(x1 - x0), Math.abs(y1 - y0), 1);
    for (let i = 0; i <= n; i++) this.put(x0 + ((x1 - x0) * i) / n, y0 + ((y1 - y0) * i) / n, col, ht);
  }
  outline(col: number, ht: number): void {
    const add: [number, number][] = [];
    for (let y = 0; y < this.hgt; y++) for (let x = 0; x < this.w; x++) {
      if (this.get(x, y) >= 0) continue;
      if (this.get(x - 1, y) >= 0 || this.get(x + 1, y) >= 0 || this.get(x, y - 1) >= 0 || this.get(x, y + 1) >= 0) add.push([x, y]);
    }
    for (const [x, y] of add) this.put(x, y, col, ht);
  }
  burn(seed: number, k = 0.5): void {
    for (let y = 0; y < this.hgt; y++) for (let x = 0; x < this.w; x++) {
      const i = y * this.w + x;
      const c = this.c[i];
      if (c < 0) continue;
      const r = hash(x, y, seed);
      if (r < 0.1) { this.c[i] = SOOT; this.e[i] = 0; } else if (r < 0.12) { this.c[i] = EMBER; this.e[i] = 0x803010; } else this.c[i] = shade(c, k + hash(x, y, seed + 1) * 0.2);
    }
  }
  art(spec: number): PixelArt {
    const a = new PixelArt(this.w, this.hgt);
    for (let y = 0; y < this.hgt; y++) for (let x = 0; x < this.w; x++) {
      const i = y * this.w + x;
      const c = this.c[i];
      if (c < 0) continue;
      const hh = this.h[i];
      const lower = (nx: number, ny: number) => this.get(nx, ny) < 0 || this.h[ny * this.w + nx] < hh - 0.05;
      let f = 1;
      if (lower(x, y - 1)) f += 0.2;
      if (lower(x - 1, y)) f += 0.1;
      if (lower(x, y + 1)) f -= 0.22;
      if (lower(x + 1, y)) f -= 0.12;
      const col = this.e[i] ? c : shade(c, f);
      a.set(x, y, col, hh, this.s[i] >= 0 ? this.s[i] : spec, 1, this.e[i] || (this.selfGlow ? shade(col, this.selfGlow) : 0));
    }
    return a;
  }
  /** White, tint mask on: a shadow shape for Renderer.shadeSpr. */
  silhouette(): PixelArt {
    const a = new PixelArt(this.w, this.hgt);
    for (let y = 0; y < this.hgt; y++) for (let x = 0; x < this.w; x++) if (this.get(x, y) >= 0) a.set(x, y, 0xffffff, 0, 0, 1);
    return a;
  }
}

// ---------- the helicopter ----------
const H_BODY = 0x5e6858;
const H_HI = 0x8c977f;
const H_LO = 0x414a3a;
const H_DK = 0x101310;
const H_GLASS = 0x2c5864;
const H_GLARE = 0x9fd0d8;
const H_RED = 0xc8321c;
const H_BLADE = 0x8e928a;
const H_TIP = 0xd8dccf;

/** The airframe without pods, tail rotor or main rotor (those are separate sprites). */
function heliFrame(L: Layer): void {
  // stub wings (under the pods' inner edge) and the horizontal stabiliser
  for (let x = 9; x < 39; x++) for (let y = 20; y < 26; y++) L.put(x, y, y === 20 ? H_HI : y === 25 ? H_LO : H_BODY, 0.55);
  for (const x of [13, 34]) L.rect(x, 21, 2, 4, H_LO, 0.56); // hardpoints
  L.rect(17, 40, 14, 2, H_BODY, 0.52);
  L.rect(17, 40, 14, 1, H_HI, 0.53);
  // tail boom, tapering, and the fin
  for (let y = 31; y < 46; y++) {
    const half = y < 38 ? 2 : 1;
    for (let x = 24 - half; x < 24 + half; x++) L.put(x, y, x === 24 - half ? H_HI : H_BODY, 0.6);
  }
  L.rect(23, 44, 2, 4, H_LO, 0.66);
  // fuselage: a narrow tandem body with a rounded nose
  for (let y = 3; y < 34; y++) {
    const half = y < 5 ? 2 : y < 7 ? 3 : y > 30 ? 3 : 4;
    for (let x = 24 - half; x < 24 + half; x++) {
      let c = H_BODY;
      if (x === 24 - half) c = H_HI;
      if (x === 24 + half - 1) c = H_LO;
      L.put(x, y, c, 0.7);
    }
  }
  // engine nacelles with dark intakes and sooty exhausts
  for (const ex of [18, 28]) {
    for (let y = 16; y < 30; y++) for (let x = ex; x < ex + 2; x++) L.put(x, y, x === ex ? H_HI : H_LO, 0.74);
    L.rect(ex, 16, 2, 2, 0x0c0e0c, 0.72);
    L.rect(ex, 28, 2, 2, 0x22201c, 0.72);
  }
  // tandem canopy: two glazed bays, a frame between, glare on the top-left panes
  for (let y = 7; y < 20; y++) {
    if (y === 13) continue;
    for (let x = 21; x < 27; x++) L.put(x, y, H_GLASS, 0.82, 0, 0.9);
  }
  for (let x = 21; x < 27; x++) L.put(x, 13, H_LO, 0.84);
  L.put(21, 8, H_GLARE, 0.83, 0, 1);
  L.put(22, 7, H_GLARE, 0.83, 0, 1);
  L.put(21, 15, H_GLARE, 0.83, 0, 1);
  L.put(22, 14, H_GLARE, 0.83, 0, 1);
  // chin gun under the nose
  L.rect(23, 1, 2, 3, 0x2a2c2a, 0.6);
  L.put(23, 0, 0x8a8a84, 0.6);
  // the fang mark on the boom (same invented unit sign as GRINDER) and a hull number stripe
  for (const [x, y] of [[22, 34], [23, 35], [24, 35], [25, 34]]) L.put(x, y, H_RED, 0.62);
  L.rect(20, 28, 8, 1, H_RED, 0.72);
  L.outline(H_DK, 0.5);
  // rotor mast hub
  L.disc(24, 22, 2.2, 0x2a2c2a, 0.9);
  L.put(24, 22, 0x6a6c66, 0.92);
}

function heliBodyArt(): PixelArt {
  const L = new Layer(48, 48);
  L.selfGlow = 0.13;
  heliFrame(L);
  return L.art(0.1);
}

function heliWreckArt(): PixelArt {
  const L = new Layer(48, 48);
  heliFrame(L);
  // the tail boom broken and bent, the nose crushed, rotor stubs flung across
  for (let y = 38; y < 48; y++) for (let x = 16; x < 32; x++) L.c[y * 48 + x] = -1;
  for (let i = 0; i < 8; i++) L.put(26 + i, 38 + i * 0.6, H_LO, 0.5);
  for (let y = 0; y < 5; y++) for (let x = 18; x < 30; x++) L.c[y * 48 + x] = -1;
  L.line(10, 6, 21, 18, H_BLADE, 0.6);
  L.line(36, 34, 28, 26, H_BLADE, 0.6);
  L.line(38, 12, 30, 19, H_BLADE, 0.6);
  for (const [hx, hy] of [[22, 10], [25, 24], [15, 22]]) { L.rect(hx - 1, hy - 1, 3, 3, SCORCH, 0.5); L.put(hx, hy, 0x080808, 0.4); }
  L.burn(61, 0.5);
  return L.art(0.12);
}

/** A rocket pod, 7 x 12: a 5 px tube cluster under the wing tip, open tubes at the front. */
function heliPodArt(dead: boolean): PixelArt {
  const L = new Layer(7, 12);
  L.selfGlow = dead ? 0 : 0.13;
  for (let y = 1; y < 11; y++) for (let x = 1; x < 6; x++) L.put(x, y, x === 1 ? 0x6e7468 : x === 5 ? 0x34382e : 0x4c5246, 0.62);
  L.rect(1, 1, 5, 1, 0x6e7468, 0.63);
  if (!dead) {
    for (const [x, y] of [[2, 2], [4, 2], [3, 3]]) L.put(x, y, 0x0a0a0a, 0.6);
    L.rect(1, 8, 5, 1, H_RED, 0.62);
  } else {
    for (let y = 1; y < 5; y++) for (let x = 1; x < 6; x++) if (hash(x, y, 9) < 0.5) L.c[y * 7 + x] = -1;
  }
  L.outline(H_DK, 0.55);
  if (dead) {
    L.burn(41, 0.45);
    L.put(3, 6, EMBER, 0.6, 0x903810);
  }
  return L.art(0.08);
}

/** The tail rotor seen from above: a blur line beside the fin; frame 1 = the blades edge-on. */
function heliTailArt(frame: number, dead: boolean): PixelArt {
  const L = new Layer(13, 12);
  L.selfGlow = 0.13;
  // gearbox on the fin
  L.rect(5, 6, 3, 4, H_LO, 0.68);
  L.rect(5, 6, 3, 1, H_HI, 0.69);
  if (!dead) {
    const half = frame ? 2 : 5;
    for (let y = 8 - half; y < 8 + half; y++) L.put(9, y, H_BLADE, 0.7);
    L.put(9, 8 - half, 0x8a8c86, 0.7);
    L.put(8, 8, 0x3a3c38, 0.7);
  } else {
    L.put(9, 8, 0x2a2a2a, 0.6);
    L.put(10, 9, 0x2a2a2a, 0.6);
  }
  if (dead) L.burn(17, 0.5);
  return L.art(0.3);
}

/** Main rotor frame k (0..5): two blades at k * 30 degrees through the hub at (23, 23). */
function heliRotorArt(k: number): PixelArt {
  const L = new Layer(46, 46);
  L.selfGlow = 0.12;
  const a = (k * Math.PI) / 6;
  const c = Math.cos(a);
  const s = Math.sin(a);
  for (let t = -22; t <= 22; t++) {
    if (Math.abs(t) < 2) continue;
    const x = 23 + c * t;
    const y = 23 + s * t;
    L.put(x, y, Math.abs(t) > 18 ? H_TIP : H_BLADE, 0.98);
    // a second pixel row so the blade survives every angle
    L.put(x - s * 0.7, y + c * 0.7, H_BLADE, 0.98);
  }
  L.disc(23, 23, 1.6, 0x3a3c38, 1);
  return L.art(0.3);
}

function heliShadowArt(): PixelArt {
  const L = new Layer(48, 48);
  heliFrame(L);
  // pods and the tail rotor's gearbox belong to the outline too
  for (const x0 of [4, 37]) for (let y = 18; y < 30; y++) for (let x = x0; x < x0 + 7; x++) L.put(x, y, 1, 0);
  return L.silhouette();
}

function heliDiscShadowArt(): PixelArt {
  const L = new Layer(44, 44);
  L.disc(22, 22, 21.5, 1, 0);
  return L.silhouette();
}

// ---------- the final fight ----------
/** Winter white-wash over a copy of the atlas sprite `src`: olive paint turns white, dark blotches stay olive. */
function winterize(at: Atlas, src: string): PixelArt {
  const s = at.S[src];
  const a = new PixelArt(s.w, s.h);
  for (let y = 0; y < s.h; y++) {
    for (let x = 0; x < s.w; x++) {
      const i = ((s.y + y) * at.W + s.x + x) * 4;
      const j = (y * s.w + x) * 4;
      for (let k = 0; k < 4; k++) {
        a.alb[j + k] = at.alb[i + k];
        a.hs[j + k] = at.hs[i + k];
        a.em[j + k] = at.em[i + k];
      }
      if (!a.alb[j + 3]) continue;
      const r = a.alb[j];
      const g = a.alb[j + 1];
      const b = a.alb[j + 2];
      const lum = 0.3 * r + 0.59 * g + 0.11 * b;
      const painted = g - b > 14 && r < g + 30 && !(r > g * 1.6);
      if (!painted) continue;
      let c: number;
      if (lum > 62) {
        // white-wash, keeping the bevel's light and dark
        const f = Math.min(1.2, Math.sqrt(lum / 84));
        c = rgb(196 * f, 203 * f, 210 * f);
        if (hash(x, y, 77) < 0.06) c = rgb(150, 156, 150); // scuffs
      } else {
        // the old olive showing through, greyed
        c = rgb(r * 0.7 + 30, g * 0.7 + 30, b * 0.7 + 34);
      }
      a.alb[j] = R(c);
      a.alb[j + 1] = G(c);
      a.alb[j + 2] = B(c);
    }
  }
  return a;
}

const W_PAINT = 0xc4cad2;
const W_HI = 0xe8ecf0;
const W_LO = 0x8a9098;
const W_DK = 0x161a1e;
const W_RED = 0xc8321c;

/** A bunker gun: a domed turret with a stubby gun (to the top edge); shut = shutters closed, the gun pulled in. */
function finGunArt(mode: 'open' | 'shut' | 'dead'): PixelArt {
  const L = new Layer(16, 16);
  L.disc(8, 9, 5.6, W_PAINT, 0.95);
  L.disc(7.3, 8.3, 3, W_HI, 0.97);
  L.disc(8, 9, 1.6, W_LO, 0.98);
  for (let x = 4; x < 12; x++) L.put(x, 13, W_RED, 0.94);
  if (mode === 'open') {
    for (let y = 0; y < 5; y++) { L.put(7, y, 0x8a8e88, 0.9); L.put(8, y, 0x3a3e38, 0.9); }
    L.rect(6, 4, 4, 2, W_LO, 0.93);
    L.put(7, 0, 0x101010, 0.9);
  } else if (mode === 'shut') {
    L.rect(5, 4, 6, 2, 0x5a6066, 0.96);
    L.rect(6, 4, 4, 1, 0x101214, 0.96);
  } else {
    L.put(9, 2, 0x3a3e38, 0.85);
    L.put(9, 3, 0x3a3e38, 0.85);
    L.put(10, 4, 0x3a3e38, 0.85);
  }
  L.outline(W_DK, 0.9);
  if (mode === 'dead') {
    L.burn(29, 0.45);
    L.disc(8, 9, 1.4, EMBER, 0.9);
    L.e[9 * 16 + 8] = 0x903810;
  }
  return L.art(mode === 'dead' ? 0.12 : 0.35);
}

/** The command bunker's door, 16 x 6: a steel shutter in hazard stripes; dead = a blown-in black hole. */
function finDoorArt(dead: boolean): PixelArt {
  const L = new Layer(16, 6);
  for (let y = 0; y < 6; y++) for (let x = 0; x < 16; x++) {
    let c = ((x + y) >> 1) % 2 ? 0x1c1c1c : 0xd8b030;
    if (y === 0) c = 0x5a6066;
    if (x === 0 || x === 15) c = 0x3a3e44;
    L.put(x, y, c, 0.5);
  }
  for (let x = 6; x < 10; x++) L.put(x, 2, W_RED, 0.52);
  if (dead) {
    for (let y = 0; y < 6; y++) for (let x = 1; x < 15; x++) L.put(x, y, hash(x, y, 5) < 0.15 ? EMBER : 0x0a0a0a, 0.1, hash(x, y, 5) < 0.15 ? 0x702808 : 0);
  }
  return L.art(dead ? 0.05 : 0.3);
}

/** The command car: a six-wheeled armoured car with a radio box and whip aerials, white-wash; f = wheel frame. */
function finCarArt(f: number, dead: boolean): PixelArt {
  const L = new Layer(16, 16);
  for (const wx of [1, 13]) for (const wy of [2, 7, 12]) {
    L.rect(wx, wy, 2, 3, 0x1a1a1c, 0.35);
    L.put(wx, wy + ((f + wy) % 3), 0x4a4a4c, 0.36);
  }
  for (let y = 1; y < 16; y++) for (let x = 3; x < 13; x++) {
    let c = W_PAINT;
    if (y < 4) c = W_HI; // sloped glacis
    if (x === 3) c = W_HI;
    if (x === 12) c = W_LO;
    L.put(x, y, c, y < 4 ? 0.5 : 0.6);
  }
  L.rect(5, 2, 6, 1, 0x1c2c34, 0.55); // vision slits
  L.rect(5, 6, 6, 6, 0x9aa0a8, 0.72); // radio box on the roof
  L.rect(5, 6, 6, 1, W_HI, 0.73);
  L.rect(7, 8, 2, 2, W_RED, 0.74); // the command pennant's red square
  L.rect(5, 14, 6, 1, 0x222428, 0.62); // rear door
  L.outline(W_DK, 0.4);
  // whip aerials, after the outline
  L.line(4, 13, 1, 4, 0x101010, 0.9);
  L.line(11, 13, 14, 5, 0x101010, 0.9);
  L.put(1, 4, W_RED, 0.9);
  if (dead) L.burn(53, 0.45);
  return L.art(dead ? 0.12 : 0.3);
}

/** Call after the GRINDER sprites are in the atlas (the winter copies read them). */
export function addBoss4Sprites(at: Atlas): void {
  at.add('heliBody', heliBodyArt());
  at.add('heliWreck', heliWreckArt());
  at.add('heliPod', heliPodArt(false));
  at.add('heliPodDead', heliPodArt(true));
  at.add('heliTail0', heliTailArt(0, false));
  at.add('heliTail1', heliTailArt(1, false));
  at.add('heliTailDead', heliTailArt(0, true));
  for (let k = 0; k < 6; k++) at.add(`heliRotor${k}`, heliRotorArt(k));
  at.add('heliShadow', heliShadowArt());
  at.add('heliDiscShadow', heliDiscShadowArt());
  for (const k of WINTER_KEYS) if (at.S[k]) at.add(`win_${k}`, winterize(at, k));
  at.add('finGun', finGunArt('open'));
  at.add('finGunShut', finGunArt('shut'));
  at.add('finGunDead', finGunArt('dead'));
  at.add('finDoor', finDoorArt(false));
  at.add('finDoorDead', finDoorArt(true));
  at.add('finCar0', finCarArt(0, false));
  at.add('finCar1', finCarArt(1, false));
  at.add('finCarDead', finCarArt(0, true));
}

/** GRINDER's sprites that the final fight's heavy tank wears in winter paint (atlas name `win_<key>`). */
export const WINTER_KEYS = ['bossHulla', 'bossHullb', 'bossWreck', 'bossTurret', 'bossTurretDead', 'bossSponson', 'bossSponsonDead', 'bossSkirtL', 'bossSkirtR'];
