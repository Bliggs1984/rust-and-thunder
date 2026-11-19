// ---------- Phase 4 bosses: the armoured train (bosses/train.ts) and the river flagship (bosses/flagship.ts) ----------
// All facing up (the front at y = 0). Colours baked in, drawn with a white tint (a dark tint for wrecks), a dark rim
// so the shapes read at 1x. The train wears the invader's olive and camo with the red fang; the gunboat is naval
// blue-grey with a red boot line. Heights: wheels 0.3, wagon sides 0.5, deck 0.46, engine 0.6 / cab 0.72, turrets
// 0.85; boat deck 0.36, deck guns 0.6, bridge 0.62-0.8.
import { Atlas, PixelArt } from './atlas';
import { hash } from './sprites';

const rgb = (r: number, g: number, b: number) =>
  (Math.max(0, Math.min(255, r | 0)) << 16) | (Math.max(0, Math.min(255, g | 0)) << 8) | Math.max(0, Math.min(255, b | 0));
const shade = (c: number, f: number) => rgb(((c >> 16) & 255) * f, ((c >> 8) & 255) * f, (c & 255) * f);

// the invader's olive (as GRINDER), steel, the gunboat's greys
const OL = 0x4f5a38;
const OL_HI = 0x75825a;
const OL_LO = 0x353d25;
const OL_DK = 0x14170e;
const CAMO = 0x2c321e;
const SAND = 0x7c7650;
const RIVET = 0xb4b89a;
const RED = 0xc8321c;
const RED_DK = 0x801c10;
const WHEEL = 0x232325;
const WHEEL_HI = 0x55555a;
const GUN = 0x6e7656;
const GUN_DK = 0x30361f;
const LAMP = 0xfff0c8;
const N_HULL = 0x4a545c;
const N_HI = 0x76828a;
const N_LO = 0x2f373d;
const N_DK = 0x0f1418;
const N_DECK = 0x5d6559;
const N_BOOT = 0x7a2c1e;
const SOOT = 0x1c1a18;
const EMBER = 0xff7a1e;

/** Colour + height + emission, bevelled when turned into art (light from the top left). */
class Layer {
  c: Int32Array;
  h: Float32Array;
  e: Int32Array;
  constructor(public w: number, public hgt: number) {
    this.c = new Int32Array(w * hgt).fill(-1);
    this.h = new Float32Array(w * hgt);
    this.e = new Int32Array(w * hgt);
  }
  put(x: number, y: number, col: number, h: number, em = 0): void {
    x = Math.round(x);
    y = Math.round(y);
    if (x < 0 || y < 0 || x >= this.w || y >= this.hgt) return;
    const i = y * this.w + x;
    this.c[i] = col;
    this.h[i] = h;
    this.e[i] = em;
  }
  get(x: number, y: number): number {
    if (x < 0 || y < 0 || x >= this.w || y >= this.hgt) return -1;
    return this.c[y * this.w + x];
  }
  rect(x: number, y: number, w: number, h: number, col: number, ht: number): void {
    for (let j = y; j < y + h; j++) for (let i = x; i < x + w; i++) this.put(i, j, col, ht);
  }
  disc(cx: number, cy: number, r: number, col: number, ht: number): void {
    for (let y = Math.floor(cy - r); y <= cy + r; y++) for (let x = Math.floor(cx - r); x <= cx + r; x++) {
      if ((x + 0.5 - cx) ** 2 + (y + 0.5 - cy) ** 2 <= r * r) this.put(x, y, col, ht);
    }
  }
  /** Blotches of camo over pixels of colour `base` inside (x0, y0, w, h). */
  camo(base: number, x0: number, y0: number, w: number, h: number, seed: number, n = 6): void {
    for (let k = 0; k < n; k++) {
      const cx = x0 + hash(k, 1, seed) * w;
      const cy = y0 + hash(k, 2, seed) * h;
      const r = 1.2 + hash(k, 3, seed) * 1.8;
      const col = k % 3 === 2 ? SAND : CAMO;
      for (let y = Math.floor(cy - r); y <= cy + r; y++) for (let x = Math.floor(cx - r); x <= cx + r; x++) {
        if ((x + 0.5 - cx) ** 2 + ((y + 0.5 - cy) * 0.8) ** 2 > r * r || this.get(x, y) !== base) continue;
        this.c[y * this.w + x] = col;
      }
    }
  }
  /** A 1 px rim round everything drawn so far. */
  outline(col: number, ht: number): void {
    const add: [number, number][] = [];
    for (let y = 0; y < this.hgt; y++) for (let x = 0; x < this.w; x++) {
      if (this.get(x, y) >= 0) continue;
      if (this.get(x - 1, y) >= 0 || this.get(x + 1, y) >= 0 || this.get(x, y - 1) >= 0 || this.get(x, y + 1) >= 0) add.push([x, y]);
    }
    for (const [x, y] of add) this.put(x, y, col, ht);
  }
  /** Char it: darken, soot, the odd ember. */
  burn(seed: number, k = 0.5): void {
    for (let y = 0; y < this.hgt; y++) for (let x = 0; x < this.w; x++) {
      const i = y * this.w + x;
      const c = this.c[i];
      if (c < 0) continue;
      const r = hash(x, y, seed);
      if (r < 0.12) { this.c[i] = SOOT; this.e[i] = 0; } else if (r < 0.14) { this.c[i] = EMBER; this.e[i] = 0x803010; } else this.c[i] = shade(c, k + hash(x, y, seed + 1) * 0.2);
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
      a.set(x, y, this.e[i] ? c : shade(c, f), hh, spec, 1, this.e[i]);
    }
    return a;
  }
}

// ---------- the armoured train ----------
/** Bogie wheels poking out both sides at rows y0..y0+5. */
function bogie(L: Layer, y0: number, W: number): void {
  for (let y = y0; y < y0 + 6; y++) {
    const c = y === y0 + 2 || y === y0 + 3 ? WHEEL_HI : WHEEL;
    L.put(0, y, c, 0.3);
    L.put(W - 1, y, c, 0.3);
  }
}

/** An armoured wagon, 16 x 40: bogies, armoured sides with plate seams and rivets, a sunken deck, buffers. */
function trainCarArt(wreck: boolean): PixelArt {
  const W = 16;
  const H = 40;
  const L = new Layer(W, H);
  bogie(L, 3, W);
  bogie(L, 31, W);
  for (let y = 1; y < H - 1; y++) for (let x = 1; x < W - 1; x++) {
    const side = x <= 2 || x >= W - 3 || y <= 2 || y >= H - 3;
    L.put(x, y, side ? OL : 0x48503a, side ? 0.5 : 0.44);
  }
  for (let y = 2; y < H - 2; y++) { L.put(2, y, 0x8a9868, 0.53); L.put(W - 3, y, OL_LO, 0.5); } // top edge of the side armour
  for (let x = 2; x < W - 2; x++) { L.put(x, 2, 0x8a9868, 0.53); L.put(x, H - 3, OL_LO, 0.5); }
  for (let y = 1; y < H - 1; y++) { L.put(1, y, OL_DK, 0.48); L.put(W - 2, y, OL_DK, 0.48); } // the dark rim
  L.camo(OL, 1, 1, W - 2, H - 2, 31, 7);
  for (const y of [11, 20, 29]) for (const x of [1, 2, W - 3, W - 2]) L.put(x, y, OL_DK, 0.49); // plate seams
  for (let y = 4; y < H - 3; y += 4) { L.put(2, y, RIVET, 0.54); L.put(W - 3, y, RIVET, 0.52); }
  for (let y = 5; y < H - 5; y += 3) for (let x = 4; x < W - 4; x++) if (hash(x, y, 5) < 0.5) L.put(x, y, 0x3a4130, 0.44); // deck planks
  for (const y of [5, H - 6]) { L.put(4, y, RED, 0.45); L.put(5, y, RED, 0.45); L.put(W - 6, y, RED, 0.45); L.put(W - 5, y, RED, 0.45); } // tactical marks
  for (const x of [3, 4, W - 5, W - 4]) { L.put(x, 0, 0x1a1a1a, 0.4); L.put(x, H - 1, 0x1a1a1a, 0.4); } // buffers
  L.put(7, H - 2, RED, 0.5); L.put(8, H - 2, RED, 0.5); // a red tail mark
  if (wreck) L.burn(41, 0.5);
  return L.art(wreck ? 0.12 : 0.3);
}

/** The armoured locomotive, 16 x 44: a sloped nose with a plough and the headlamp, louvred engine hood, the
 * exhaust stack, a raised cab with vision slits at the back. */
function trainEngineArt(wreck: boolean): PixelArt {
  const W = 16;
  const H = 44;
  const L = new Layer(W, H);
  bogie(L, 5, W);
  bogie(L, 18, W);
  bogie(L, 34, W);
  for (let y = 0; y < H - 1; y++) {
    const inset = y === 0 ? 4 : y === 1 ? 3 : y === 2 ? 2 : 1;
    for (let x = inset; x < W - inset; x++) {
      let c = OL;
      let h = y < 6 ? 0.5 + y * 0.02 : 0.6;
      if (y < 2) { c = (x >> 1) & 1 ? RED : 0x1a1a1a; h = 0.42; } // the plough's hazard stripes
      L.put(x, y, c, h);
    }
  }
  for (let y = 3; y < H - 1; y++) { L.put(1, y, OL_HI, 0.62); L.put(W - 2, y, OL_LO, 0.6); } // side rails
  L.camo(OL, 2, 6, W - 4, 24, 13, 6);
  for (let y = 9; y <= 23; y += 2) for (let x = 4; x < W - 4; x++) L.put(x, y, 0x262b1c, 0.57); // louvres
  L.disc(8, 27, 2.2, 0x111112, 0.74); // exhaust stack
  L.disc(8, 27, 1.1, 0x050505, 0.7);
  // cab: raised, lighter, slits and a hatch
  for (let y = 31; y < 42; y++) for (let x = 2; x < W - 2; x++) L.put(x, y, y === 31 ? 0x8a9670 : OL_HI, 0.74);
  for (const x of [4, 5, 6, 9, 10, 11]) L.put(x, 32, 0x0c1014, 0.72);
  L.disc(8, 37.5, 2, OL_LO, 0.77);
  L.disc(8, 37.5, 1, OL_DK, 0.78);
  for (let x = 2; x < W - 2; x++) L.put(x, 42, OL_DK, 0.6);
  // the fang on the nose, the headlamp (lit), marker lamps
  for (const [x, y] of [[5, 4], [6, 5], [7, 4], [8, 4], [9, 5], [10, 4]]) L.put(x, y, RED, 0.54);
  L.put(7, 2, LAMP, 0.56, 0xffe8b0);
  L.put(8, 2, LAMP, 0.56, 0xffe8b0);
  L.put(2, 41, 0xff4020, 0.62, 0xff3010);
  L.put(W - 3, 41, 0xff4020, 0.62, 0xff3010);
  L.outline(OL_DK, 0.35);
  if (wreck) L.burn(53, 0.5);
  return L.art(wreck ? 0.12 : 0.32);
}

/** A gun turret, 20 x 20 centred on (10, 10): a cast dome, mantlet and a 2 px gun reaching the top edge. */
function trainTurretArt(): PixelArt {
  const L = new Layer(20, 20);
  const T = 0x6a7850;
  L.disc(10, 11.5, 6, T, 0.85);
  L.camo(T, 5, 6, 10, 11, 61, 4);
  L.disc(8.5, 9.5, 2.2, 0x8c9a6c, 0.87); // the lit shoulder of the dome
  L.rect(8, 4, 4, 3, OL_LO, 0.86);
  L.rect(8, 4, 4, 1, OL_HI, 0.87);
  for (let y = 0; y < 5; y++) { L.put(9, y, y === 0 ? 0x101010 : 0xa8ac98, 0.88); L.put(10, y, y === 0 ? 0x101010 : 0x5e6450, 0.88); }
  L.disc(12.5, 14, 1.8, OL_LO, 0.9);
  L.put(12, 13, OL_HI, 0.91);
  for (let x = 6; x < 14; x++) if (L.get(x, 16) >= 0) L.put(x, 16, RED, 0.86);
  L.outline(OL_DK, 0.8);
  return L.art(0.35);
}

/** The AA / machine-gun mount, 12 x 12 centred on (6, 6): an armoured tub with twin guns. */
function trainAAArt(): PixelArt {
  const L = new Layer(12, 12);
  L.rect(1, 2, 10, 9, 0x6a7850, 0.66);
  L.rect(3, 4, 6, 5, 0x1c2016, 0.6);
  L.rect(4, 5, 4, 3, 0x8c9a6c, 0.7);
  for (let y = 0; y < 7; y++) { L.put(4, y, y === 0 ? 0x101010 : 0xa0a496, 0.76); L.put(7, y, y === 0 ? 0x101010 : 0xa0a496, 0.76); }
  for (const x of [2, 9]) L.put(x, 10, RED, 0.67);
  L.put(1, 2, RIVET, 0.67);
  L.put(10, 2, RIVET, 0.67);
  L.outline(OL_DK, 0.55);
  return L.art(0.3);
}

/** The rocket launcher, 12 x 24: a frame of 3 x 4 tubes, red warheads showing. */
function trainRackArt(): PixelArt {
  const L = new Layer(12, 24);
  L.rect(0, 1, 12, 22, OL_LO, 0.6);
  for (let r = 0; r < 4; r++) for (let c = 0; c < 3; c++) {
    const cx = 2.4 + c * 3.6;
    const cy = 4 + r * 5;
    L.disc(cx, cy, 1.7, 0x5a6046, 0.7);
    L.disc(cx, cy, 1.05, 0x0a0a0a, 0.66);
    L.put(cx, cy, 0x9a2a1a, 0.67);
  }
  for (let x = 0; x < 12; x++) L.put(x, 22, OL_DK, 0.58);
  L.outline(OL_DK, 0.5);
  return L.art(0.3);
}

/** The supply load, 12 x 30: crates, a tarp over a stack, fuel drums. */
function trainCratesArt(): PixelArt {
  const L = new Layer(12, 30);
  const crate = (x: number, y: number) => {
    L.rect(x, y, 5, 5, 0x6a5030, 0.62);
    for (let i = 0; i < 5; i++) { L.put(x + i, y + i, 0x4a3820, 0.63); L.put(x, y + i, 0x3a2a18, 0.62); L.put(x + i, y, 0x8a6a40, 0.63); }
  };
  crate(0, 0);
  crate(6, 1);
  L.rect(0, 7, 12, 11, 0x3c4a2c, 0.7);
  for (let y = 7; y < 18; y++) if (hash(3, y, 9) < 0.5) L.put(1 + (y % 3), y, 0x2c3820, 0.7);
  for (const y of [9, 15]) for (let x = 0; x < 12; x++) L.put(x, y, 0x9a8a60, 0.72); // ropes
  for (const [x, y] of [[2.5, 21.5], [6, 21.5], [9.5, 21.5], [2.5, 25.5], [6, 25.5]]) {
    L.disc(x, y, 1.7, 0x6a2418, 0.64);
    L.put(x, y, 0x9a4a30, 0.65);
  }
  crate(7, 24);
  L.outline(0x1a140c, 0.5);
  return L.art(0.2);
}

// ---------- the river flagship ----------
/** Half width of the hull at row y (bow at y = 0). */
function hullHalf(y: number): number {
  if (y < 16) return 1.5 + 10.5 * Math.sqrt(y / 16);
  if (y >= 46) return 10.5;
  return 12;
}

/** The gunboat's hull, 24 x 48: pointed bow, steel deck with seams, railings, rafts, the engine housing and its
 * funnel at the stern, the red boot line along the waterline. */
function flagHullArt(wreck: boolean): PixelArt {
  const W = 24;
  const H = 48;
  const L = new Layer(W, H);
  for (let y = 0; y < H; y++) {
    const hw = hullHalf(y);
    for (let x = 0; x < W; x++) {
      const d = Math.abs(x + 0.5 - 12);
      if (d > hw) continue;
      const rim = d > hw - 1 || y === H - 1;
      const side = !rim && (d > hw - 2.2 || y === H - 2);
      L.put(x, y, rim ? N_BOOT : side ? N_HULL : N_DECK, rim ? 0.28 : side ? 0.34 : 0.36);
    }
  }
  // railings on the side strip, weld seams across the deck
  for (let y = 3; y < H - 2; y += 2) {
    const hw = hullHalf(y);
    L.put(Math.round(12 - hw + 1.2), y, 0xb4b8a8, 0.4);
    L.put(Math.round(12 + hw - 2.2), y, 0xb4b8a8, 0.4);
  }
  for (const y of [17, 29, 39]) for (let x = 4; x < 20; x++) if (L.get(x, y) === N_DECK) L.put(x, y, 0x4c5449, 0.36);
  // the bow: windlass, chain, a red chevron
  L.rect(10, 3, 4, 2, 0x1c2024, 0.42);
  for (let y = 5; y < 9; y++) L.put(y & 1 ? 11 : 12, y, 0x2a2e30, 0.38);
  for (const [x, y] of [[9, 7], [10, 8], [13, 8], [14, 7], [11, 9], [12, 9]]) L.put(x, y, RED, 0.37);
  // life rafts amidships
  for (const x of [3, 19]) { L.rect(x, 31, 2, 5, 0xc0701c, 0.44); L.put(x, 31, 0xe09040, 0.45); }
  // engine housing with vents, the funnel
  for (let y = 40; y < 47; y++) for (let x = 5; x < 19; x++) L.put(x, y, y === 40 ? N_HI : N_LO, 0.5);
  for (const x of [6, 8, 15, 17]) for (let y = 42; y < 46; y++) L.put(x, y, 0x161a1d, 0.48);
  L.disc(12, 43.5, 2.6, 0x2a2e30, 0.64);
  L.disc(12, 43.5, 1.5, 0x08090a, 0.6);
  for (let x = 9; x < 15; x++) L.put(x, 41, RED_DK, 0.66);
  if (wreck) L.burn(77, 0.45);
  return L.art(wreck ? 0.1 : 0.4);
}

/** A deck gun, 14 x 14 centred on (7, 7): a gun house with a 2 px barrel to the top edge. */
function flagGunArt(): PixelArt {
  const L = new Layer(14, 14);
  for (let y = 4; y < 12; y++) for (let x = 3; x < 11; x++) {
    if ((x === 3 || x === 10) && (y === 4 || y === 11)) continue;
    L.put(x, y, y === 4 ? N_HI : N_HULL, 0.6);
  }
  L.rect(5, 8, 4, 2, N_LO, 0.62);
  for (let y = 0; y < 5; y++) { L.put(6, y, y === 0 ? 0x101418 : 0x8a9090, 0.66); L.put(7, y, y === 0 ? 0x101418 : 0x5a6060, 0.66); }
  L.put(4, 10, RED, 0.61);
  L.put(9, 10, RED, 0.61);
  L.outline(N_DK, 0.5);
  return L.art(0.45);
}

/** The bridge, 14 x 11: wheelhouse windows facing forward, roof, a mast with the radar bar at the back. */
function flagBridgeArt(): PixelArt {
  const L = new Layer(14, 11);
  for (let y = 0; y < 11; y++) for (let x = 0; x < 14; x++) {
    if ((x === 0 || x === 13) && y === 0) continue;
    L.put(x, y, y === 0 ? N_HI : 0x7e8a90, y === 0 ? 0.62 : 0.66);
  }
  for (let x = 2; x < 12; x++) L.put(x, 1, (x & 1) ? 0x101820 : 0x1c2a34, 0.63, x === 4 || x === 9 ? 0x403020 : 0);
  for (let x = 1; x < 13; x++) L.put(x, 10, N_LO, 0.64);
  for (let x = 3; x < 11; x++) L.put(x, 9, 0x2a3036, 0.8); // radar bar
  L.put(7, 9, 0x101418, 0.84);
  L.put(6, 9, 0x101418, 0.84);
  L.put(1, 7, 0xff4020, 0.68, 0xff3010);
  L.put(12, 7, 0x30ff60, 0.68, 0x10c030);
  L.outline(N_DK, 0.5);
  return L.art(0.4);
}

/** The deck machine gun, 8 x 8 centred on (4, 4): a shielded ring mount. */
function flagMGArt(): PixelArt {
  const L = new Layer(8, 8);
  L.disc(4, 4.6, 2.6, N_LO, 0.74);
  L.rect(2, 2, 4, 1, N_HI, 0.78);
  for (let y = 0; y < 4; y++) L.put(4, y, y === 0 ? 0x101010 : 0x2c2c2c, 0.8);
  L.outline(N_DK, 0.6);
  return L.art(0.35);
}

export function addRailRiverSprites(at: Atlas): void {
  at.add('trainCar', trainCarArt(false));
  at.add('trainCarWreck', trainCarArt(true));
  at.add('trainEngine', trainEngineArt(false));
  at.add('trainEngineWreck', trainEngineArt(true));
  at.add('trainTurret', trainTurretArt());
  at.add('trainAA', trainAAArt());
  at.add('trainRack', trainRackArt());
  at.add('trainCrates', trainCratesArt());
  at.add('flagHull', flagHullArt(false));
  at.add('flagHullWreck', flagHullArt(true));
  at.add('flagGun', flagGunArt());
  at.add('flagBridge', flagBridgeArt());
  at.add('flagMG', flagMGArt());
}
// ---------- end Phase 4 train + flagship ----------
