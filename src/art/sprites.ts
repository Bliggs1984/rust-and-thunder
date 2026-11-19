import { Atlas, PixelArt } from './atlas';
import { FONT } from './font';
import { addRailRiverSprites } from './sprites-rail-river'; // Phase 4 bosses: train + flagship
import { addBoss4Sprites } from './boss4-sprites'; // Phase 4 bosses, regions 4-5
import { addCampaignItemSprites } from './campaign-items'; // campaign pickups, event people and objects
import { addCampaignTankSprites } from './campaign-tanks'; // campaign looks: BABUSYA/DIDO layers, Dominion tanks

// ---------- colour helpers ----------
const rgb = (r: number, g: number, b: number) =>
  (Math.max(0, Math.min(255, r | 0)) << 16) | (Math.max(0, Math.min(255, g | 0)) << 8) | Math.max(0, Math.min(255, b | 0));
const R = (c: number) => (c >> 16) & 255;
const Gc = (c: number) => (c >> 8) & 255;
const B = (c: number) => c & 255;
const shade = (c: number, f: number) => rgb(R(c) * f, Gc(c) * f, B(c) * f);

export function hash(x: number, y: number, s = 0): number {
  let h = Math.imul(x | 0, 374761393) + Math.imul(y | 0, 668265263) + Math.imul(s | 0, 982451653);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}

// ---------- tanks ----------
interface TankDef {
  tread: number;
  inset: number;
  hy0: number;
  hy1: number;
  tr: number;
  ty: number;
  by0: number;
  dbl?: boolean;
  plates?: boolean;
  brake?: boolean;
  enemy?: boolean;
}

function tankArt(d: TankDef, frame: number): PixelArt {
  const a = new PixelArt(16, 16);
  const tw = d.tread;
  for (const sx of [0, 16 - tw]) {
    for (let y = 1; y <= 14; y++) {
      for (let x = sx; x < sx + tw; x++) {
        const link = ((y + frame) & 1) === 0;
        let col = link ? 0x8c8c90 : 0x3a3a3e;
        if (x === sx || x === sx + tw - 1) col = shade(col, 0.72);
        if (y === 1 || y === 14) col = 0x26262a;
        a.set(x, y, col, link ? 0.47 : 0.42, 0.25, 0);
      }
    }
  }
  const hx0 = tw - 1 + d.inset;
  const hx1 = 16 - tw + 1 - d.inset;
  for (let y = d.hy0; y <= d.hy1; y++) {
    for (let x = hx0; x < hx1; x++) {
      const edge = x === hx0 || x === hx1 - 1 || y === d.hy0 || y === d.hy1;
      let col = edge ? 0x8e8e8e : 0xcfcfcf;
      if (!edge && y === d.hy0 + 1) col = 0xeeeeee;
      if (!edge && y === d.hy1 - 1) col = 0xa8a8a8;
      if (d.plates && !edge && (y === d.hy0 + 3 || y === d.hy1 - 3)) col = 0x9a9a9a;
      a.set(x, y, col, edge ? 0.52 : 0.57, 0.35, 1);
    }
  }
  const bxs = d.dbl ? [6, 9] : [7];
  const bw = d.dbl ? 1 : 2;
  for (const bx of bxs) {
    for (let y = d.by0; y < d.ty; y++) {
      for (let x = bx; x < bx + bw; x++) {
        let col = bw === 1 ? 0xd4d4d4 : x === bx ? 0xe4e4e4 : 0x9a9a9a;
        if (y === d.by0) col = 0xffffff;
        a.set(x, y, col, 0.66, 0.6, 0.55);
      }
    }
  }
  if (d.brake) for (let x = 6; x < 10; x++) a.set(x, d.by0 + 1, 0xbcbcbc, 0.67, 0.6, 0.55);
  const r = d.tr;
  for (let y = 0; y < 16; y++) {
    for (let x = 0; x < 16; x++) {
      const dx = Math.abs(x + 0.5 - 8);
      const dy = Math.abs(y + 0.5 - d.ty);
      if (dx <= r && dy <= r && dx + dy <= r * 1.55) {
        const edge = dx > r - 1 || dy > r - 1 || dx + dy > r * 1.55 - 1;
        a.set(x, y, edge ? 0xa4a4a4 : 0xf4f4f4, edge ? 0.68 : 0.74, 0.45, 1);
      }
    }
  }
  if (r >= 3) {
    for (const [x, y] of [[7, d.ty - 1], [8, d.ty - 1], [7, d.ty], [8, d.ty]]) a.set(x, y, 0x5a5a5e, 0.77, 0.3, 0.3);
  }
  const lc = d.enemy ? 0xff3818 : 0xfff0b8;
  a.set(hx0 + 1, d.hy0, 0xffffff, 0.58, 0.5, 0, lc);
  a.set(hx1 - 2, d.hy0, 0xffffff, 0.58, 0.5, 0, lc);
  return a;
}

const TANKS: Record<string, TankDef> = {
  p0: { tread: 3, inset: 1, hy0: 3, hy1: 13, tr: 3, ty: 9, by0: 2 },
  p1: { tread: 3, inset: 1, hy0: 3, hy1: 13, tr: 3, ty: 9, by0: 0 },
  p2: { tread: 4, inset: 0, hy0: 2, hy1: 14, tr: 3.5, ty: 9, by0: 0, plates: true },
  p3: { tread: 4, inset: 0, hy0: 2, hy1: 14, tr: 4, ty: 9, by0: 0, dbl: true, plates: true },
  e0: { tread: 3, inset: 1, hy0: 4, hy1: 13, tr: 2.5, ty: 9, by0: 2, enemy: true },
  e1: { tread: 2, inset: 2, hy0: 2, hy1: 14, tr: 2.5, ty: 10, by0: 1, enemy: true },
  e2: { tread: 3, inset: 0, hy0: 3, hy1: 13, tr: 3.5, ty: 9, by0: 0, brake: true, enemy: true },
  e3: { tread: 4, inset: 0, hy0: 2, hy1: 14, tr: 4, ty: 9, by0: 1, plates: true, enemy: true },
};

// ---------- string art ----------
function fromRows(rows: string[], pal: Record<string, [number, number, number, number?, number?]>): PixelArt {
  const h = rows.length;
  const w = Math.max(...rows.map((r) => r.length));
  const a = new PixelArt(w, h);
  rows.forEach((row, y) => {
    for (let x = 0; x < row.length; x++) {
      const p = pal[row[x]];
      if (p) a.set(x, y, p[0], p[1], p[2], p[3] ?? 0, p[4] ?? 0);
    }
  });
  return a;
}

const EAGLE = [
  '................',
  '.a............a.',
  '.ab....cc....ba.',
  '.abb..caac..bba.',
  '.abbb.cewc.bbba.',
  '..abbbcaacbbba..',
  '..abbbbaabbbba..',
  '...abbbaabbba...',
  '....abbaabba....',
  '.....abaaba.....',
  '......caac......',
  '.....cacaca.....',
  '....ca.cc.ac....',
  '......cccc......',
  '....dddddddd....',
  '...dddddddddd...',
];

const EAGLE_DEAD = [
  '................',
  '......p.........',
  '......pffff.....',
  '......pfffff....',
  '......pffff.....',
  '......p.........',
  '......p.........',
  '......p.........',
  '....g.p..g......',
  '...ggggpgggg....',
  '..gdggdgggdgg...',
  '.gggdggggdgggg..',
  '.gdgggdggggdgg..',
  'gggggggggggggggg',
  '.gdggggdgggggdg.',
  '................',
];

// ---------- icons via a mask ----------
class Mask {
  c: (number | null)[];
  constructor(public w: number, public h: number) {
    this.c = new Array(w * h).fill(null);
  }
  set(x: number, y: number, col: number): void {
    x = Math.round(x);
    y = Math.round(y);
    if (x >= 0 && y >= 0 && x < this.w && y < this.h) this.c[y * this.w + x] = col;
  }
  get(x: number, y: number): number | null {
    if (x < 0 || y < 0 || x >= this.w || y >= this.h) return null;
    return this.c[y * this.w + x];
  }
  rect(x: number, y: number, w: number, h: number, col: number): void {
    for (let j = y; j < y + h; j++) for (let i = x; i < x + w; i++) this.set(i, j, col);
  }
  disc(cx: number, cy: number, r: number, col: number, pred?: (x: number, y: number) => boolean): void {
    for (let y = 0; y < this.h; y++) for (let x = 0; x < this.w; x++) {
      const dx = x + 0.5 - cx;
      const dy = y + 0.5 - cy;
      if (dx * dx + dy * dy <= r * r && (!pred || pred(x, y))) this.set(x, y, col);
    }
  }
  line(x0: number, y0: number, x1: number, y1: number, col: number, th = 1): void {
    const n = Math.ceil(Math.max(Math.abs(x1 - x0), Math.abs(y1 - y0)) * 2) + 1;
    for (let i = 0; i <= n; i++) {
      const t = i / n;
      const x = x0 + (x1 - x0) * t;
      const y = y0 + (y1 - y0) * t;
      for (let a = 0; a < th; a++) for (let b = 0; b < th; b++) this.set(Math.floor(x) + a, Math.floor(y) + b, col);
    }
  }
}

function maskArt(m: Mask, height: number, emis: number): PixelArt {
  const a = new PixelArt(m.w, m.h);
  for (let y = 0; y < m.h; y++) {
    for (let x = 0; x < m.w; x++) {
      const c = m.get(x, y);
      if (c !== null) {
        a.set(x, y, c, height, 0.4, 0, shade(c, emis));
      } else {
        let near = false;
        for (let j = -1; j <= 1; j++) for (let i = -1; i <= 1; i++) if (m.get(x + i, y + j) !== null) near = true;
        if (near) a.set(x, y, 0x101018, height - 0.05, 0.1);
      }
    }
  }
  return a;
}

function powerIcon(type: number): PixelArt {
  const m = new Mask(16, 16);
  const W = 0xf0f0f4;
  const L = 0xb8b8c4;
  switch (type) {
    case 0: // helmet
      m.disc(8, 10, 6, W, (_x, y) => y <= 9);
      m.disc(8, 10, 6, 0xffffff, (x, y) => y <= 6 && x <= 6);
      m.rect(1, 10, 14, 2, L);
      m.rect(5, 8, 6, 1, 0x707080);
      break;
    case 1: // clock
      m.disc(8, 8.5, 6.5, W);
      m.line(8, 8, 8, 3.5, 0x303040);
      m.line(8, 8, 11.5, 8, 0x303040);
      for (const [x, y] of [[8, 2], [14, 8], [8, 14], [2, 8]]) m.set(x, y, 0x6060a0);
      m.rect(7, 0, 3, 1, L);
      break;
    case 2: // shovel
      m.line(2, 2, 9, 9, 0xa87040, 2);
      m.rect(1, 1, 3, 2, 0xc89060);
      m.disc(11.5, 11.5, 3.6, W);
      m.disc(11.5, 11.5, 2, L);
      break;
    case 3: { // star
      const pts: [number, number][] = [];
      for (let i = 0; i < 10; i++) {
        const ang = -Math.PI / 2 + (i * Math.PI) / 5;
        const rr = i % 2 === 0 ? 7.6 : 3.1;
        pts.push([8 + Math.cos(ang) * rr, 8.8 + Math.sin(ang) * rr]);
      }
      for (let y = 0; y < 16; y++) for (let x = 0; x < 16; x++) {
        const px = x + 0.5;
        const py = y + 0.5;
        let inside = false;
        for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
          const [xi, yi] = pts[i];
          const [xj, yj] = pts[j];
          if (yi > py !== yj > py && px < ((xj - xi) * (py - yi)) / (yj - yi) + xi) inside = !inside;
        }
        if (inside) m.set(x, y, Math.hypot(px - 8, py - 8.8) < 3 ? 0xfff8b0 : 0xffd820);
      }
      break;
    }
    case 4: // grenade
      m.disc(8, 10, 5, 0x6a8a3a);
      for (let y = 6; y < 16; y += 3) for (let x = 3; x < 14; x++) if (m.get(x, y) !== null) m.set(x, y, 0x48602a);
      for (let x = 5; x < 12; x += 3) for (let y = 5; y < 16; y++) if (m.get(x, y) !== null) m.set(x, y, 0x48602a);
      m.rect(6, 3, 4, 2, L);
      m.line(10, 3, 13, 1, W);
      break;
    case 5: // extra tank
      m.rect(2, 4, 3, 11, 0x707078);
      m.rect(11, 4, 3, 11, 0x707078);
      m.rect(5, 5, 6, 9, 0xffd040);
      m.rect(6, 7, 4, 4, 0xffe890);
      m.rect(7, 1, 2, 6, W);
      break;
    case 6: // gun
      m.rect(1, 4, 13, 3, L);
      m.rect(1, 4, 13, 1, W);
      m.rect(9, 7, 4, 7, 0x9a6a3a);
      m.rect(10, 13, 4, 2, 0x9a6a3a);
      m.line(6, 7, 6, 10, L);
      m.line(6, 10, 9, 10, L);
      break;
    case 7: // ship
      for (let y = 9; y <= 12; y++) for (let x = 1 + (y - 9); x <= 14 - (y - 9); x++) m.set(x, y, L);
      m.rect(1, 9, 14, 1, W);
      m.rect(5, 6, 6, 3, W);
      m.rect(7, 2, 1, 4, 0xa0a0a0);
      m.rect(8, 2, 3, 2, 0xe03020);
      for (let x = 2; x < 15; x += 3) m.set(x, 14, 0x60a0ff);
      break;
    case 8: // EMP (new)
      m.disc(8, 8, 6.5, 0x3a6ae0);
      m.disc(8, 8, 4.5, 0x90c0ff);
      m.line(9, 2, 6, 8, 0xffffff, 2);
      m.line(6, 8, 10, 8, 0xffffff, 2);
      m.line(10, 8, 7, 14, 0xffffff, 2);
      break;
    case 9: // ricochet (new)
      m.line(2, 13, 7, 3, 0xff9030, 2);
      m.line(7, 3, 13, 13, 0xff9030, 2);
      m.disc(13, 13, 2.2, 0xfff0a0);
      m.rect(1, 14, 14, 1, W);
      break;
  }
  return maskArt(m, 0.95, 0.5);
}

// ---------- fx ----------
function explosionArt(size: number, radius: number, seed: number): PixelArt {
  const a = new PixelArt(size, size);
  const c = size / 2;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const dx = x + 0.5 - c;
      const dy = y + 0.5 - c;
      const d = Math.sqrt(dx * dx + dy * dy);
      const ang = Math.atan2(dy, dx);
      const spike = 0.78 + 0.2 * Math.sin(ang * 7 + seed) + 0.12 * Math.sin(ang * 13 + seed * 2.3);
      const rr = radius * spike * (0.88 + 0.24 * hash(x, y, seed));
      if (d < rr) {
        const t = d / rr;
        if (t > 0.55 && hash(x, y, seed + 9) < 0.1) continue;
        const col = t < 0.3 ? 0xffffff : t < 0.55 ? 0xffe060 : t < 0.8 ? 0xff7a20 : 0xb02818;
        a.set(x, y, col, 0.5);
      }
    }
  }
  return a;
}

function spawnArt(s: number): PixelArt {
  const a = new PixelArt(16, 16);
  for (let y = 0; y < 16; y++) {
    for (let x = 0; x < 16; x++) {
      const dx = Math.abs(x + 0.5 - 8);
      const dy = Math.abs(y + 0.5 - 8);
      const d = Math.sqrt(dx * dx + dy * dy);
      const ray = (dx <= 0.6 && dy <= 7.5 * s) || (dy <= 0.6 && dx <= 7.5 * s);
      const diag = Math.abs(dx - dy) < 0.8 && dx <= 4 * s;
      if (ray || diag || d < 2.2 * s) a.set(x, y, d < 2.2 * s ? 0xffffff : 0xa0d0ff, 0.5);
    }
  }
  return a;
}

function shieldArt(f: number): PixelArt {
  const a = new PixelArt(16, 16);
  for (let y = 0; y < 16; y++) {
    for (let x = 0; x < 16; x++) {
      const e = Math.min(x, y, 15 - x, 15 - y);
      if (e > 1) continue;
      if (((x + y + f * 2) & 3) < 2) a.set(x, y, e === 0 ? 0xffffff : 0x80e0ff, 0.6);
    }
  }
  return a;
}

function domeArt(): PixelArt {
  const a = new PixelArt(20, 20);
  for (let y = 0; y < 20; y++) {
    for (let x = 0; x < 20; x++) {
      const dx = x + 0.5 - 10;
      const dy = y + 0.5 - 10;
      const d = Math.sqrt(dx * dx + dy * dy);
      if (d > 10) continue;
      const rim = d > 8.6;
      const hex = ((x + (y >> 1)) % 4 === 0 || y % 4 === 0) && d < 8.6;
      if (rim) a.set(x, y, 0xffffff, 0.5);
      else if (hex) a.set(x, y, 0x5070a0, 0.5);
    }
  }
  return a;
}

function smallTankIcon(col: number, accent: number): PixelArt {
  const a = new PixelArt(8, 8);
  for (let y = 1; y < 8; y++) {
    a.set(0, y, col, 0.5);
    a.set(1, y, (y & 1) ? accent : col, 0.5);
    a.set(6, y, (y & 1) ? accent : col, 0.5);
    a.set(7, y, col, 0.5);
  }
  for (let y = 2; y < 7; y++) for (let x = 2; x < 6; x++) a.set(x, y, col, 0.5);
  a.set(3, 4, accent, 0.5);
  a.set(4, 4, accent, 0.5);
  for (let y = 0; y < 3; y++) { a.set(3, y, col, 0.5); a.set(4, y, col, 0.5); }
  return a;
}

function flagArt(): PixelArt {
  const a = new PixelArt(16, 16);
  for (let y = 1; y < 15; y++) a.set(2, y, 0x101010, 0.5);
  for (let y = 2; y < 9; y++) {
    const w = 12 - Math.abs(y - 5) * 2;
    for (let x = 3; x < 3 + w; x++) a.set(x, y, y === 8 ? 0x983000 : 0xc87000, 0.5);
  }
  for (let x = 0; x < 6; x++) a.set(x, 15, 0x101010, 0.5);
  return a;
}

// ---------- campaign: town flags (salvage pickups: campaign-items.ts) ----------
/** Mask to lit sprite with top-left lighting baked in: edges facing up are lightened, edges facing down darkened. */
function litMask(m: Mask, height: number, spec: number, emisOf?: (c: number) => number, inner = true): PixelArt {
  const a = new PixelArt(m.w, m.h);
  for (let y = 0; y < m.h; y++) {
    for (let x = 0; x < m.w; x++) {
      const c = m.get(x, y);
      if (c === null) continue;
      let f = 1;
      const diff = (o: number | null) => (inner ? o !== c : o === null);
      if (diff(m.get(x, y - 1))) f += 0.28;
      if (diff(m.get(x - 1, y))) f += 0.1;
      if (diff(m.get(x, y + 1))) f -= 0.3;
      if (diff(m.get(x + 1, y))) f -= 0.12;
      const edge = m.get(x, y - 1) === null || m.get(x, y + 1) === null || m.get(x - 1, y) === null || m.get(x + 1, y) === null;
      a.set(x, y, shade(c, f), edge ? height * 0.7 : height, spec, 0, emisOf ? emisOf(c) : 0);
    }
  }
  return a;
}

/** Town flag: a pole with a pennant waving in two frames (base at the bottom, pole at column 3). */
function townFlagArt(held: boolean, frame: number): PixelArt {
  const a = new PixelArt(16, 16);
  for (let y = 1; y < 15; y++) a.set(3, y, y & 1 ? 0x9aa0aa : 0x7c828c, 0.8, 0.5);
  a.set(3, 0, held ? 0xd0d0d8 : 0xffe9a0, 0.84, 0.8);
  for (let x = 1; x < 7; x++) a.set(x, 15, 0x5c5c64, 0.32, 0.2);
  for (let x = 2; x < 5; x++) a.set(x, 14, 0x84848c, 0.4, 0.3);
  const hi = held ? 0xe84030 : 0xffd02a;
  const mid = held ? 0xb81c18 : 0xe09a10;
  const lo = held ? 0x741010 : 0x9a5c08;
  for (let x = 4; x < 14; x++) {
    const wave = (x + frame * 3) % 8 < 4 ? 0 : 1;
    const y0 = 1 + wave;
    for (let y = y0; y <= y0 + 6; y++) {
      let col = y === y0 ? hi : y >= y0 + 5 ? lo : mid;
      if (held && (y === y0 + 3 || y === y0 + 4)) col = 0x2a0a0a; // dark stripe across the invader's flag
      if (!held && x <= 6 && y >= y0 + 1 && y <= y0 + 3) col = 0x3a78d8; // blue patch on ours
      a.set(x, y, col, 0.62 + wave * 0.03, 0.2, 0, held ? 0 : 0x3a2400);
    }
  }
  return a;
}

// ---------- campaign Phase 2: depot targets (fuel tanks, ammo stack), four damage stages ----------
const EMBER = 0xff7a1e;
const EMBER_HI = 0xffd060;
const SOOT = 0x1c1a18;
const SCORCH = 0x3a3430;

/** Two silver fuel tanks lying side by side (round shading, dark end rims), red hazard bands, valves and a walkway. */
function fuelTanksMask(): Mask {
  const m = new Mask(16, 16);
  const ROWS = [0xe4e8ec, 0xc8ced4, 0xb0b6be, 0x9aa0a8, 0x7c838c, 0x5a6068];
  for (const y0 of [1, 9]) {
    for (let y = y0; y < y0 + 6; y++) {
      const row = y - y0;
      for (let x = 1; x < 15; x++) m.set(x, y, ROWS[row]);
      m.set(1, y, 0x4a4f58); // end rims
      m.set(14, y, 0x4a4f58);
      if (row > 0 && row < 5) { m.set(0, y, 0x34383e); m.set(15, y, 0x34383e); } // rounded end caps
    }
    for (const x of [0, 1, 14, 15]) { m.c[y0 * 16 + x] = null; m.c[(y0 + 5) * 16 + x] = null; }
    for (let y = y0; y < y0 + 6; y++) { m.set(9, y, 0xe8482a); m.set(10, y, y === y0 ? 0xff7050 : 0xb02a18); }
    m.set(4, y0 + 1, 0x2b2f36); m.set(5, y0 + 1, 0x2b2f36); m.set(4, y0, 0xf8b800); // hatch and valve wheel
    m.set(12, y0 + 2, 0x2b2f36); // filler cap
  }
  for (let x = 2; x < 14; x += 2) m.set(x, 7, 0x5a5a5e); // walkway grating
  m.rect(1, 8, 14, 1, 0x34363a);
  return m;
}

/** Four crates of shells (one open, brass tips showing) with rope and stencil marks. */
function ammoStackMask(): Mask {
  const m = new Mask(16, 16);
  const crate = (x0: number, y0: number, open: boolean) => {
    m.rect(x0, y0, 7, 7, 0x7a5a2a);
    m.rect(x0, y0, 7, 1, 0x9a7438);
    m.rect(x0, y0 + 6, 7, 1, 0x4e3818);
    m.rect(x0, y0 + 3, 7, 1, 0x5e4420); // plank seam
    if (open) {
      m.rect(x0 + 1, y0 + 1, 5, 5, 0x2a1e10);
      for (let i = 0; i < 3; i++) for (let j = 0; j < 2; j++) { m.set(x0 + 1 + i * 2, y0 + 2 + j * 2, 0xe8c050); m.set(x0 + 1 + i * 2, y0 + 3 + j * 2, 0x9a7a30); }
    } else {
      m.set(x0 + 2, y0 + 2, 0xd8d0b0); m.set(x0 + 3, y0 + 2, 0xd8d0b0); m.set(x0 + 4, y0 + 2, 0xd8d0b0); // stencil
    }
  };
  crate(1, 1, false);
  crate(8, 1, true);
  crate(1, 8, true);
  crate(8, 8, false);
  for (let y = 1; y < 15; y++) m.set(7, y, 0x34363a); // gap between stacks
  m.rect(1, 7, 14, 1, 0x34363a);
  return m;
}

/** stage 0 intact, 1 holed and scorched, 2 burning (a breach with embers), 3 burnt-out wreck. */
function depotArt(kind: 'fuel' | 'ammo', stage: number): PixelArt {
  const m = kind === 'fuel' ? fuelTanksMask() : ammoStackMask();
  const seed = kind === 'fuel' ? 11 : 23;
  if (stage >= 1) {
    // dents and shell holes, soot around them
    for (let y = 0; y < 16; y++) for (let x = 0; x < 16; x++) {
      if (m.get(x, y) === null) continue;
      const h = hash(x, y, seed);
      if (h < 0.07) m.set(x, y, SOOT);
      else if (h < 0.16 + stage * 0.08) m.set(x, y, shade(m.get(x, y)!, 0.6));
    }
    // two shell holes with scorched rims
    for (const [hx, hy] of kind === 'fuel' ? [[12, 3], [4, 12]] : [[4, 4], [11, 11]]) {
      for (const [dx, dy] of [[-1, 0], [1, 0], [0, -1], [0, 1], [1, 1]]) m.set(hx + dx, hy + dy, SCORCH);
      m.set(hx, hy, 0x0a0a0a);
    }
  }
  if (stage >= 2) {
    // a breach: a burst drum / a crate blown open, glowing inside
    const [bx, by] = kind === 'fuel' ? [6, 11] : [11, 4];
    m.disc(bx, by, 3.4, SCORCH);
    m.disc(bx, by, 2.2, SOOT);
    for (const [x, y] of [[bx - 1, by], [bx, by - 1], [bx + 1, by + 1], [bx, by]]) m.set(x, y, hash(x, y, 3) < 0.5 ? EMBER : EMBER_HI);
  }
  if (stage >= 3) {
    // burnt out: mostly soot, twisted shards sticking up, a few embers left
    const w = new Mask(16, 16);
    for (let y = 0; y < 16; y++) for (let x = 0; x < 16; x++) {
      const dx = x + 0.5 - 8;
      const dy = y + 0.5 - 8;
      const r = Math.hypot(dx, dy) * (0.85 + 0.3 * hash(x, y, seed + 5));
      if (r > 7.6) continue;
      const orig = m.get(x, y);
      let c = r < 3 ? SOOT : hash(x, y, seed + 7) < 0.35 && orig !== null ? shade(orig, 0.45) : SCORCH;
      if (hash(x, y, seed + 9) < 0.05) c = EMBER;
      w.set(x, y, c);
    }
    for (const [x0, y0, x1, y1] of kind === 'fuel' ? [[2, 3, 6, 6], [10, 12, 13, 9], [12, 2, 9, 5]] : [[2, 12, 5, 9], [12, 3, 9, 6], [3, 3, 5, 6]]) {
      w.line(x0, y0, x1, y1, kind === 'fuel' ? 0x8a9098 : 0x5a4220);
    }
    return litMask(w, 0.22, 0.25, (c) => (c === EMBER ? 0x803010 : 0), false);
  }
  return litMask(m, kind === 'fuel' ? 0.5 : 0.46, kind === 'fuel' ? 0.55 : 0.2,
    (c) => (c === EMBER ? 0x903810 : c === EMBER_HI ? 0xa06020 : 0), true);
}
// ---------- end Phase 2 depot block ----------

// ---------- Phase 3 enemy tricks block (tricks.ts): drone, mine, AT team, supply truck ----------
/** Enemy quadcopter seen from above: X frame, olive body with a slung grenade, four rotors (two blur frames), red LED. */
function trickDroneArt(frame: number): PixelArt {
  const m = new Mask(13, 13);
  const DISC = 0x6e747c;
  const BLADE = 0xd4d8de;
  const hubs = [[2, 2], [10, 2], [2, 10], [10, 10]];
  // rotor blur discs, then the arms, then a blade streak per rotor (two frames)
  for (const [x, y] of hubs) m.disc(x + 0.5, y + 0.5, 2.6, DISC);
  m.line(3, 3, 9, 9, 0x2a2c30, 1);
  m.line(9, 3, 3, 9, 0x2a2c30, 1);
  for (const [x, y] of hubs) {
    if ((frame + x + y) & 1) m.line(x - 2, y, x + 2, y, BLADE);
    else m.line(x, y - 2, x, y + 2, BLADE);
    m.set(x, y, 0x1a1c1e);
  }
  m.rect(4, 4, 5, 5, 0x4e5a34); // body
  m.rect(5, 4, 3, 1, 0x6e7c4a);
  m.rect(5, 7, 3, 1, 0x343c22); // the grenade slung underneath shows at the back
  m.set(6, 8, 0x8a8c80);
  const LED = 0xff3020;
  m.set(6, 4, LED);
  return litMask(m, 0.6, 0.5, (c) => (c === LED ? 0xff2010 : 0), false);
}

/** Anti-tank mine: a squat drab disc with a pressure plate. */
function trickMineArt(): PixelArt {
  const m = new Mask(6, 6);
  m.disc(3, 3, 3, 0x4a5038);
  m.disc(3, 3, 1.6, 0x6c705c);
  m.set(2, 2, 0x8a8c7a);
  m.set(3, 3, 0x2a2c22);
  return litMask(m, 0.14, 0.35, undefined, false);
}

/** Two-man anti-tank team in camouflage, seen from above, launcher on the shoulder pointing up (rotated by facing). */
function trickTeamArt(): PixelArt {
  const m = new Mask(10, 10);
  const BODY = 0x5e6e3c;
  const HELMET = 0xa49a62;
  // gunner (left) with the launcher, loader (right) a step behind; khaki helmets so they read against foliage
  m.disc(3, 5.5, 2.4, BODY);
  m.disc(3, 5.2, 1.3, HELMET);
  m.disc(7.5, 7, 2.1, BODY);
  m.disc(7.5, 6.8, 1.1, HELMET);
  m.line(4, 0, 4, 6, 0x2a2a24); // launcher tube
  m.set(4, 0, 0xc8b070); // warhead
  m.set(4, 1, 0xc8b070);
  m.set(8, 4, 0xc8b070); // a spare rocket
  return maskArt(m, 0.3, 0);
}

/** Supply truck facing up: cab with windscreen and headlights, canvas-covered bed with ribs and a white tactical square. */
function trickTruckArt(frame: number, wreck: boolean): PixelArt {
  const m = new Mask(16, 16);
  const CAB = wreck ? 0x2c2a26 : 0x5a6438;
  const TARP = wreck ? 0x242220 : 0x6c6a48;
  const RIB = wreck ? 0x3a3430 : 0x50503a;
  m.rect(3, 6, 10, 10, TARP); // bed
  for (let y = 8; y < 16; y += 3) m.rect(3, y, 10, 1, RIB);
  m.rect(4, 1, 8, 5, CAB); // cab
  m.rect(5, 2, 6, 1, wreck ? 0x101010 : 0x2a3440); // windscreen
  m.rect(4, 5, 8, 1, shade(CAB, 0.7));
  if (!wreck) {
    m.set(5, 0, 0xfff0b0); // headlights
    m.set(10, 0, 0xfff0b0);
    m.rect(7, 10, 2, 2, 0xe8e8e0); // tactical marking
  } else {
    for (let y = 0; y < 16; y++) for (let x = 0; x < 16; x++) if (m.get(x, y) !== null && hash(x, y, 41) < 0.12) m.set(x, y, EMBER);
    m.line(4, 7, 11, 13, 0x5a5650);
  }
  const W = 0x16161a;
  for (const y of [2, 9, 13]) {
    const o = frame && !wreck ? 1 : 0;
    m.set(2, y + o, W); m.set(2, y + 1 + o, W);
    m.set(13, y + o, W); m.set(13, y + 1 + o, W);
  }
  return litMask(m, wreck ? 0.3 : 0.48, wreck ? 0.15 : 0.3, (c) => (c === 0xfff0b0 ? 0xc0a060 : c === EMBER ? 0x803010 : 0), true);
}

/** Atlas entries for tricks.ts: trkDrone0/1, trkMine, trkTeam, trkTruck0/1, trkWreck. */
function addTrickSprites(at: Atlas): void {
  at.add('trkDrone0', trickDroneArt(0));
  at.add('trkDrone1', trickDroneArt(1));
  at.add('trkMine', trickMineArt());
  at.add('trkTeam', trickTeamArt());
  at.add('trkTruck0', trickTruckArt(0, false));
  at.add('trkTruck1', trickTruckArt(1, false));
  at.add('trkWreck', trickTruckArt(0, true));
}
// ---------- end Phase 3 enemy tricks block ----------

export interface Art {
  atlas: Atlas;
}

export function buildAtlas(): Atlas {
  const at = new Atlas();
  const white = new PixelArt(2, 2);
  white.rect(0, 0, 2, 2, 0xffffff, 0, 0.1, 1);
  at.add('white', white);
  for (const [name, def] of Object.entries(TANKS)) {
    at.add(`${name}a`, tankArt(def, 0));
    at.add(`${name}b`, tankArt(def, 1));
  }
  const bullet = new PixelArt(4, 4);
  ['.##.', '####', '####', '#..#'].forEach((row, y) => {
    for (let x = 0; x < 4; x++) if (row[x] === '#') bullet.set(x, y, y === 0 ? 0xffffff : 0xd8d8d8, 0.7, 0.6, 0, y < 2 ? 0xffd080 : 0x806040);
  });
  at.add('bullet', bullet);
  at.add('eagle', fromRows(EAGLE, {
    a: [0xffe9a0, 0.72, 0.8],
    b: [0xd9a83a, 0.66, 0.8],
    c: [0x8a5a1a, 0.62, 0.6],
    e: [0xff3020, 0.72, 0.5, 0, 0xff2010],
    w: [0xffffff, 0.72, 0.6],
    d: [0x6a6a70, 0.5, 0.3],
  }));
  at.add('eagleDead', fromRows(EAGLE_DEAD, {
    p: [0x707070, 0.75, 0.3],
    f: [0xf0f0f0, 0.7, 0.1],
    g: [0x5a5a5e, 0.4, 0.1],
    d: [0x2a2a2e, 0.35, 0.05],
  }));
  for (let i = 0; i < 10; i++) at.add(`pw${i}`, powerIcon(i));
  [3.5, 6, 7.6].forEach((r, i) => at.add(`boom${i}`, explosionArt(16, r, i * 3 + 1)));
  [11, 15.5].forEach((r, i) => at.add(`bigboom${i}`, explosionArt(32, r, i * 5 + 2)));
  [0.35, 0.6, 0.85, 1].forEach((s, i) => at.add(`spawn${i}`, spawnArt(s)));
  at.add('dome', domeArt());
  at.add('shield0', shieldArt(0));
  at.add('shield1', shieldArt(1));
  at.add('enemyIcon', smallTankIcon(0x141414, 0x6a1a14));
  at.add('lifeIcon', smallTankIcon(0xc87000, 0xf0a040));
  at.add('flag', flagArt());
  addRailRiverSprites(at); // Phase 4 bosses: armoured train + river flagship (sprites-rail-river.ts)
  for (const f of [0, 1]) {
    at.add(`flagEnemy${f}`, townFlagArt(true, f));
    at.add(`flagMine${f}`, townFlagArt(false, f));
  }
  for (let s = 0; s < 4; s++) {
    at.add(`depotFuel${s}`, depotArt('fuel', s));
    at.add(`depotAmmo${s}`, depotArt('ammo', s));
  }
  addAbilitySprites(at); // Phase 3 abilities block (end of file)
  addTrickSprites(at); // Phase 3 enemy tricks
  addBossSprites(at); // Phase 4 bosses (end of file)
  addBoss4Sprites(at); // Phase 4 bosses, regions 4-5 (boss4-sprites.ts; after GRINDER's: it copies them)
  addCampaignTankSprites(at); // campaign tank looks (campaign-tanks.ts)
  addCampaignItemSprites(at); // campaign pickups, event people and objects (campaign-items.ts)
  for (const [ch, rows] of Object.entries(FONT)) {
    const g = new PixelArt(5, 7);
    rows.forEach((r, y) => r.forEach((on, x) => on && g.set(x, y, 0xffffff, 0.5)));
    at.add(`ch_${ch}`, g);
  }
  return at;
}

// ---------- Phase 3 abilities (abilities agent): reticle, FPV drone, recon drone, ambush squad, rocket, marks ----------
// Overlay marks are white (tinted when drawn with ovSpr); the drones and the squad are lit sprites facing up.
const ABIL_W = 0xffffff;

/** Drone-strike reticle, 13 x 13: corner brackets, crosshair ticks and a centre dot. */
function abilReticleArt(): PixelArt {
  const a = new PixelArt(13, 13);
  const px: [number, number][] = [
    [0, 0], [1, 0], [2, 0], [0, 1], [0, 2], [10, 0], [11, 0], [12, 0], [12, 1], [12, 2],
    [0, 10], [0, 11], [0, 12], [1, 12], [2, 12], [12, 10], [12, 11], [12, 12], [11, 12], [10, 12],
    [6, 3], [6, 4], [6, 8], [6, 9], [3, 6], [4, 6], [8, 6], [9, 6], [6, 6],
  ];
  for (const [x, y] of px) a.set(x, y, ABIL_W, 0);
  return a;
}

/** Corner brackets around a 16 px tank, 18 x 18 (drone lock, recon marks). */
function abilBoxArt(): PixelArt {
  const a = new PixelArt(18, 18);
  for (let i = 0; i < 4; i++) {
    for (const [x, y] of [[i, 0], [0, i], [17 - i, 0], [17, i], [i, 17], [0, 17 - i], [17 - i, 17], [17, 17 - i]]) a.set(x, y, ABIL_W, 0);
  }
  return a;
}

/** Small diamond with a centre dot, 7 x 7 (recon marks on hidden mines, infantry and the like). */
function abilDiamondArt(): PixelArt {
  const a = new PixelArt(7, 7);
  for (let i = 0; i < 4; i++) {
    a.set(3 + i, i, ABIL_W, 0);
    a.set(3 - i, i, ABIL_W, 0);
    a.set(3 + i, 6 - i, ABIL_W, 0);
    a.set(3 - i, 6 - i, ABIL_W, 0);
  }
  a.set(3, 3, ABIL_W, 0);
  return a;
}

/** Down-pointing chevron, 5 x 3 (marks our own squad for the player). */
function abilChevronArt(): PixelArt {
  const a = new PixelArt(5, 3);
  for (const [x, y] of [[0, 0], [4, 0], [1, 1], [3, 1], [2, 2]]) a.set(x, y, ABIL_W, 0);
  return a;
}

/** FPV strike drone, 8 x 8: an X frame, blurred rotors (two frames), olive body with a warhead nose and a red LED. */
function abilFpvArt(frame: number): PixelArt {
  const m = new Mask(8, 8);
  const ARM = 0x3a3e36;
  const BODY = 0x5a6640;
  const WAR = 0x2a2e22;
  const LED = 0xff3020;
  const ROT = frame ? 0x8a9096 : 0x646a70;
  m.line(1, 1, 6, 6, ARM);
  m.line(6, 1, 1, 6, ARM);
  for (const [x, y] of [[0, 0], [6, 0], [0, 6], [6, 6]]) {
    m.rect(x, y, 2, 2, ROT);
    m.set(x + (frame ? 1 : 0), y + (frame ? 0 : 1), 0xc8ccd0);
  }
  m.rect(3, 2, 2, 4, BODY);
  m.rect(3, 1, 2, 1, WAR);
  m.set(4, 5, LED);
  return litMask(m, 0.85, 0.5, (c) => (c === LED ? 0xff2010 : 0), true);
}

/** Recon drone, 11 x 11: a bigger pale quad with a dark camera ball and a blue LED. */
function abilReconArt(frame: number): PixelArt {
  const m = new Mask(11, 11);
  const ARM = 0x5a6068;
  const BODY = 0xb4bac2;
  const CAM = 0x181c22;
  const LED = 0x40a0ff;
  const ROT = frame ? 0x9aa2aa : 0x6e767e;
  m.line(1, 1, 9, 9, ARM);
  m.line(9, 1, 1, 9, ARM);
  for (const [cx, cy] of [[1.5, 1.5], [9.5, 1.5], [1.5, 9.5], [9.5, 9.5]]) {
    m.disc(cx, cy, 1.7, ROT);
    m.set(Math.floor(cx) + (frame ? 1 : -1), Math.floor(cy), 0xd0d6dc);
  }
  m.rect(4, 3, 3, 5, BODY);
  m.set(5, 6, CAM);
  m.set(5, 7, CAM);
  m.set(5, 3, LED);
  return litMask(m, 0.95, 0.6, (c) => (c === LED ? 0x2070ff : 0), true);
}

/** Anti-tank squad from above, 10 x 8, facing up: a rifleman, the gunner with the launcher, a loader. */
function abilSquadArt(): PixelArt {
  const m = new Mask(10, 8);
  const HEL = 0x56643a;
  const KIT = 0x3c4628;
  const TUBE = 0x262a20;
  const TIP = 0x7a7458;
  m.rect(0, 3, 2, 2, HEL);
  m.rect(0, 5, 3, 1, KIT);
  m.set(1, 6, KIT);
  m.rect(4, 1, 2, 2, HEL);
  m.rect(3, 3, 4, 1, KIT);
  m.rect(4, 4, 2, 1, KIT);
  m.rect(6, 0, 1, 6, TUBE);
  m.set(6, 0, TIP);
  m.rect(8, 3, 2, 2, HEL);
  m.rect(7, 5, 3, 1, KIT);
  m.set(8, 6, KIT);
  m.set(9, 6, TIP);
  return litMask(m, 0.22, 0.15, undefined, true);
}

/** Anti-tank rocket in flight, 2 x 5, nose up, glowing motor at the tail. */
function abilRocketArt(): PixelArt {
  const a = new PixelArt(2, 5);
  a.rect(0, 0, 2, 1, 0xd8d0b0, 0.7, 0.6);
  a.rect(0, 1, 2, 3, 0x6a6e5a, 0.65, 0.4);
  a.rect(0, 4, 2, 1, 0xffb050, 0.6, 0, 0, 0xffa040);
  return a;
}

function addAbilitySprites(at: Atlas): void {
  at.add('abReticle', abilReticleArt());
  at.add('abBox', abilBoxArt());
  at.add('abDiamond', abilDiamondArt());
  at.add('abChevron', abilChevronArt());
  for (const f of [0, 1]) {
    at.add(`abFpv${f}`, abilFpvArt(f));
    at.add(`abRecon${f}`, abilReconArt(f));
  }
  at.add('abSquad', abilSquadArt());
  at.add('abRocket', abilRocketArt());
}
// ---------- end Phase 3 abilities block ----------

// ---------- Phase 4 bosses (boss.ts): the heavy tank ace, all facing up: 48 x 48 hull, 64 x 64 turret ----------
// Colours are baked in (drawn with a white tint, dark tint for the wreck): dark olive with blotchy camo, a black
// outline round hull and turret so the shapes read at 1x, red markings. Heights: treads 0.42, hull 0.6, skirts
// 0.55, sponsons 0.74, turret 0.95: the tallest thing on the map, so it throws the longest shadow.
const BH = 0x4f5a38;
const BH_HI = 0x75825a;
const BH_LO = 0x353d25;
const BH_DK = 0x14170e;
const B_CAMO = 0x2c321e;
const B_SAND = 0x7c7650;
const BS_HI = 0xb4b89a; // bolts, worn edges
const B_RED = 0xc8321c;
const B_RED_DK = 0x801c10;
const B_LAMP = 0xffd8c8;
const B_TREAD = 0x2a2a2c;
const B_LINK = 0x4c4c4c;

/** Colour + height + emission layer; `art` bevels the outline (light from the top left). */
class BossLayer {
  m: Mask;
  h: Float32Array;
  e: Int32Array;
  constructor(public w: number, public hgt: number) {
    this.m = new Mask(w, hgt);
    this.h = new Float32Array(w * hgt);
    this.e = new Int32Array(w * hgt);
  }
  put(x: number, y: number, col: number, h: number, em = 0): void {
    x = Math.round(x);
    y = Math.round(y);
    if (x < 0 || y < 0 || x >= this.w || y >= this.hgt) return;
    this.m.set(x, y, col);
    this.h[y * this.w + x] = h;
    this.e[y * this.w + x] = em;
  }
  rect(x: number, y: number, w: number, h: number, col: number, ht: number): void {
    for (let j = y; j < y + h; j++) for (let i = x; i < x + w; i++) this.put(i, j, col, ht);
  }
  disc(cx: number, cy: number, r: number, col: number, ht: number, only?: number): void {
    for (let y = Math.floor(cy - r); y <= cy + r; y++) for (let x = Math.floor(cx - r); x <= cx + r; x++) {
      if ((x + 0.5 - cx) ** 2 + (y + 0.5 - cy) ** 2 > r * r) continue;
      if (only !== undefined && this.m.get(x, y) !== only) continue;
      this.put(x, y, col, only !== undefined ? this.h[y * this.w + x] : ht);
    }
  }
  col(x: number, y: number): number | null {
    return this.m.get(x, y);
  }
  /** Camo: blotches of dark olive and sand over pixels of colour `base` inside (x0, y0, w, h). */
  camo(base: number, x0: number, y0: number, w: number, h: number, seed: number): void {
    for (let k = 0; k < 9; k++) {
      const cx = x0 + hash(k, 1, seed) * w;
      const cy = y0 + hash(k, 2, seed) * h;
      const r = 1.6 + hash(k, 3, seed) * 2.4;
      this.disc(cx, cy, r, k % 3 === 2 ? B_SAND : B_CAMO, 0, base);
      this.disc(cx + r * 0.8, cy + r * 0.5, r * 0.7, k % 3 === 2 ? B_SAND : B_CAMO, 0, base);
    }
  }
  /** A 1 px dark rim round everything drawn so far (the pixel-art outline that separates turret from hull). */
  outline(col: number, ht: number): void {
    const add: [number, number][] = [];
    for (let y = 0; y < this.hgt; y++) for (let x = 0; x < this.w; x++) {
      if (this.m.get(x, y) !== null) continue;
      if (this.m.get(x - 1, y) !== null || this.m.get(x + 1, y) !== null || this.m.get(x, y - 1) !== null || this.m.get(x, y + 1) !== null) add.push([x, y]);
    }
    for (const [x, y] of add) this.put(x, y, col, ht);
  }
  /** Char it: darken, soot, the odd ember (a wreck). */
  burn(seed: number, k = 0.5): void {
    for (let y = 0; y < this.hgt; y++) for (let x = 0; x < this.w; x++) {
      const c = this.m.get(x, y);
      if (c === null) continue;
      const r = hash(x, y, seed);
      const i = y * this.w + x;
      if (r < 0.1) { this.m.set(x, y, SOOT); this.e[i] = 0; } else if (r < 0.115) { this.m.set(x, y, EMBER); this.e[i] = 0x803010; } else this.m.set(x, y, shade(c, k + hash(x, y, seed + 1) * 0.2));
    }
  }
  art(spec: number): PixelArt {
    const a = new PixelArt(this.w, this.hgt);
    for (let y = 0; y < this.hgt; y++) for (let x = 0; x < this.w; x++) {
      const c = this.m.get(x, y);
      if (c === null) continue;
      const i = y * this.w + x;
      // bevel against lower neighbours: light on the top/left edges of raised shapes, dark on the bottom/right
      const hh = this.h[i];
      const lower = (nx: number, ny: number) => this.m.get(nx, ny) === null || this.h[ny * this.w + nx] < hh - 0.05;
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

/** Treads, hull, glacis with spare track links, engine deck, lamps and the red fang. frame = tread animation. */
function bossHullArt(frame: number, wreck: boolean): PixelArt {
  const L = new BossLayer(48, 48);
  for (const sx of [1, 39]) {
    for (let y = 1; y < 47; y++) for (let x = sx; x < sx + 8; x++) {
      const bar = (y + frame) % 3 === 0;
      let c = bar ? B_LINK : B_TREAD;
      if (x === sx || x === sx + 7) c = shade(c, 0.6);
      if ((y === 1 || y === 46) && x > sx && x < sx + 7) c = 0x161618;
      L.put(x, y, c, bar ? 0.44 : 0.4);
    }
    for (let k = 0; k < 6; k++) L.rect(sx + 3, 5 + k * 7 + (frame ? 1 : 0), 2, 2, 0x6a6a64, 0.45); // road wheel hubs
  }
  // hull body
  for (let y = 3; y < 46; y++) for (let x = 9; x < 39; x++) {
    let c = BH;
    let h = 0.6;
    if (y < 11) { c = y < 5 ? BH_HI : BH; h = 0.5 + (y - 3) * 0.013; } // the glacis slopes up
    if (y === 10) c = BH_LO; // weld seam
    if (x === 10 || x === 37) c = BH_HI; // side rails
    L.put(x, y, c, h);
  }
  L.camo(BH, 11, 11, 26, 33, 7);
  for (let y = 37; y <= 43; y += 2) for (let x = 13; x < 35; x++) if (x !== 23 && x !== 24) L.put(x, y, 0x23271a, 0.58); // engine grille
  for (let x = 9; x < 39; x++) { L.put(x, 3, BH_DK, 0.5); L.put(x, 45, BH_DK, 0.6); }
  for (let y = 3; y < 46; y++) { L.put(9, y, BH_DK, 0.6); L.put(38, y, BH_DK, 0.6); }
  for (let y = 13; y < 44; y += 5) { L.put(11, y, BS_HI, 0.63); L.put(36, y, BS_HI, 0.63); } // rivets
  // spare track links across the glacis
  for (let x = 19; x < 29; x++) { L.put(x, 8, (x & 1) ? B_LINK : B_TREAD, 0.56); L.put(x, 9, B_TREAD, 0.56); }
  // stowage boxes beside the turret ring, a tow cable
  for (const bx of [11, 34]) { L.rect(bx, 16, 3, 13, BH_LO, 0.64); L.rect(bx, 16, 3, 1, BH_HI, 0.65); L.put(bx + 1, 22, BS_HI, 0.65); }
  for (let y = 30; y < 36; y++) L.put(y & 1 ? 12 : 13, y, 0x1c1c18, 0.62);
  // exhausts (sooty) at the back corners
  for (const ex of [12, 33]) { L.rect(ex, 42, 3, 3, 0x111112, 0.62); L.put(ex + 1, 43, 0x3a2a20, 0.62); }
  // the fang mark (invented unit sign) and the lamps
  for (const [x, y] of [[19, 6], [20, 5], [21, 6], [22, 7], [25, 7], [26, 6], [27, 5], [28, 6], [23, 6], [24, 6]]) L.put(x, y, B_RED, 0.54);
  for (const x of [19, 28]) L.put(x, 3, B_LAMP, 0.55, 0xff3818);
  if (wreck) {
    L.burn(71, 0.55);
    for (const [hx, hy] of [[15, 26], [31, 14], [26, 40]]) { L.rect(hx - 1, hy - 1, 3, 3, SCORCH, 0.5); L.put(hx, hy, 0x080808, 0.4); }
  }
  return L.art(wreck ? 0.12 : 0.3);
}

/** The turret, 64 x 64 centred on (32, 32): a cast turret, mantlet, a long gun with a muzzle brake past the hull
 * front, hatches, stowage, an aerial; outlined in black. dead = burnt, the gun bent and broken off. */
function bossTurretArt(dead: boolean): PixelArt {
  const L = new BossLayer(64, 64);
  const T = 0x5a6640;
  // body: 20 x 22 with cut corners (x 22..41, y 22..43)
  for (let y = 22; y < 44; y++) for (let x = 22; x < 42; x++) {
    const dx = Math.min(x - 22, 41 - x);
    const dy = Math.min(y - 22, 43 - y);
    if (dx + dy < 3) continue;
    L.put(x, y, T, 0.95 - (dx + dy < 5 ? 0.04 : 0));
  }
  L.camo(T, 24, 25, 16, 16, 19);
  L.rect(27, 20, 10, 4, BH_LO, 0.93); // mantlet
  L.rect(27, 20, 10, 1, BH_HI, 0.94);
  // stowage basket at the back
  L.rect(24, 43, 16, 4, 0x4a4430, 0.86);
  for (let x = 24; x < 40; x += 3) L.put(x, 44, 0x2a261a, 0.86);
  L.rect(24, 46, 16, 1, 0x2a261a, 0.85);
  // hatches, periscopes, kill tallies, red band
  L.disc(36.5, 35.5, 3.2, BH_LO, 0.97);
  L.disc(36.5, 35.5, 2.1, dead ? 0x080808 : BH_HI, 0.98);
  L.disc(27, 37.5, 2.2, BH_LO, 0.97);
  for (const [x, y] of [[25, 26], [38, 26], [32, 25]]) L.put(x, y, 0x0c1014, 0.97);
  for (const y of [30, 32, 34]) { L.put(24, y, B_RED, 0.96); L.put(25, y, B_RED, 0.96); }
  for (let x = 26; x < 38; x++) L.put(x, 41, B_RED_DK, 0.95);
  // the gun: 4 px wide, from the mantlet to 1 px short of the top edge
  const g0 = dead ? 12 : 3;
  for (let y = g0; y < 21; y++) {
    const kink = dead && y < 16 ? 1 : 0;
    L.put(30 + kink, y, 0x949a7a, 0.88);
    L.put(31 + kink, y, 0x6e7656, 0.89);
    L.put(32 + kink, y, 0x535b3c, 0.89);
    L.put(33 + kink, y, 0x30361f, 0.88);
  }
  if (!dead) {
    L.rect(29, 11, 6, 3, BH_LO, 0.9); // bore evacuator
    L.rect(29, 11, 6, 1, BH_HI, 0.9);
    L.rect(29, 1, 6, 4, 0x2c3022, 0.9); // muzzle brake with ports
    L.put(29, 2, 0x0c0c0c, 0.9);
    L.put(34, 2, 0x0c0c0c, 0.9);
    L.rect(31, 1, 2, 1, 0x060606, 0.88); // bore
  }
  L.outline(BH_DK, 0.8);
  // aerial whip (after the outline: a thin line)
  for (let i = 0; i < 9; i++) L.put(40 + i * 0.7, 44 + i * 1.3, 0x101010, 0.97);
  if (dead) {
    L.burn(83, 0.55);
    L.disc(36.5, 35.5, 1.6, EMBER, 0.9);
    L.e[35 * 64 + 36] = 0x903810;
  }
  return L.art(dead ? 0.12 : 0.35);
}

/** Machine-gun sponson, 9 x 13: a boxy mount with a ball mantlet and the gun poking forward. */
function bossSponsonArt(dead: boolean): PixelArt {
  const L = new BossLayer(9, 13);
  for (let y = 3; y < 13; y++) for (let x = 0; x < 9; x++) {
    if ((x === 0 || x === 8) && (y === 3 || y === 12)) continue;
    const edge = x === 0 || x === 8 || y === 3 || y === 12;
    L.put(x, y, edge ? BH_DK : 0x56623c, 0.74);
  }
  L.disc(4.5, 6.5, 2.6, BS_HI, 0.76);
  L.disc(4.5, 6.5, 1.6, dead ? 0x080808 : BH_LO, 0.77);
  L.put(1, 11, B_RED, 0.75);
  L.put(7, 11, B_RED, 0.75);
  if (!dead) {
    for (let y = 0; y < 6; y++) L.put(4, y, y === 0 ? 0x9a9a92 : 0x1e1e1e, 0.78);
  } else {
    L.burn(97, 0.45);
    L.put(4, 6, EMBER, 0.6, 0x903810);
  }
  return L.art(0.3);
}

/** Side armour skirt, 8 x 34: four bolted plates, worn outer edge, mud. side -1 = left (outer edge x 0). */
function bossSkirtArt(side: number): PixelArt {
  const L = new BossLayer(8, 34);
  const C = 0x56603c;
  for (let y = 0; y < 34; y++) for (let x = 0; x < 8; x++) {
    const ox = side < 0 ? x : 7 - x; // 0 = outer edge
    if (ox === 0 && (y === 0 || y === 33)) continue;
    let c = C;
    if (ox === 1) c = BH_HI;
    if (ox === 0 || ox === 7 || y === 0 || y === 33) c = BH_DK;
    if (y === 8 || y === 17 || y === 25) c = BH_DK; // plate seams
    else if (ox > 0 && ox < 4 && hash(x, y, 51 + side) < 0.2) c = 0x4a3c24; // mud
    L.put(x, y, c, 0.55);
  }
  for (const y0 of [0, 9, 18, 26]) for (const ox of [2, 6]) L.put(side < 0 ? ox : 7 - ox, y0 + 3, BS_HI, 0.57);
  return L.art(0.25);
}

function addBossSprites(at: Atlas): void {
  at.add('bossHulla', bossHullArt(0, false));
  at.add('bossHullb', bossHullArt(1, false));
  at.add('bossWreck', bossHullArt(0, true));
  at.add('bossTurret', bossTurretArt(false));
  at.add('bossTurretDead', bossTurretArt(true));
  at.add('bossSponson', bossSponsonArt(false));
  at.add('bossSponsonDead', bossSponsonArt(true));
  at.add('bossSkirtL', bossSkirtArt(-1));
  at.add('bossSkirtR', bossSkirtArt(1));
}
// ---------- end Phase 4 bosses ----------
