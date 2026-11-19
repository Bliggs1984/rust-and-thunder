// Campaign HUD (region mode): compact plates floating over the full-window map, built from the approved mockups
// (mockups/campaign-ui: hud.html, common.css, common.js). Everything sits on one "UI pixel" grid (--u: 3 screen px
// at 1080p, 2 at 720p, 4 at 1440p) so edges and the 5x7 font stay hard at every size.
// The DOM is built once per layout (window size, player count, towns); per update only changed text, classes and
// the two small minimap canvases are touched.
import { babusyaRGBA } from './art/campaign-tanks'; // campaign looks: the player card's tank
import type { Atlas } from './art/atlas';
import { BRICK, ICE, RAIL, ROAD, STEEL, TREES, WATER } from './game/constants';
import type { Camera } from './game/camera';
import { PATCH_COOLDOWN, type RadioMsg, type Tank, type TownState, type World } from './game/world';

type TextFn = (text: string, s: number, cls?: string) => string;
type SpriteFn = (name: string, tint: number[]) => string;

// ---------- pixel art (ported from mockups/campaign-ui/src/common.js) ----------
const PAL: Record<string, string> = {
  k: '#0b0c0e', w: '#f4efe2', l: '#c6ccd4', m: '#8a919b', d: '#4a4f58', y: '#2b2f36', z: '#1c1f24',
  g: '#f8b800', h: '#ffe08a', o: '#c87000', R: '#983000',
  r: '#f0482a', q: '#7a1a10', G: '#7cd83a', n: '#3a8a10', N: '#1f4a10',
  b: '#6c9cff', B: '#3050c0', c: '#a8e0ff', t: '#8a5a2a', T: '#5a3a1a', e: '#e8d8a8',
};

class Art {
  p: (string | null)[];
  private cached = '';
  constructor(public w: number, public h: number) { this.p = new Array(w * h).fill(null); }
  get(x: number, y: number): string | null { return x < 0 || y < 0 || x >= this.w || y >= this.h ? null : this.p[y * this.w + x]; }
  set(x: number, y: number, c: string | null): void { if (x >= 0 && y >= 0 && x < this.w && y < this.h) this.p[y * this.w + x] = c; }
  rect(x: number, y: number, w: number, h: number, c: string): void { for (let j = y; j < y + h; j++) for (let i = x; i < x + w; i++) this.set(i, j, c); }
  ell(cx: number, cy: number, rx: number, ry: number, c: string, f?: (x: number, y: number, dx: number, dy: number) => string): void {
    for (let y = Math.floor(cy - ry - 1); y <= cy + ry + 1; y++) for (let x = Math.floor(cx - rx - 1); x <= cx + rx + 1; x++) {
      const dx = (x + 0.5 - cx) / rx;
      const dy = (y + 0.5 - cy) / ry;
      if (dx * dx + dy * dy <= 1) this.set(x, y, f ? f(x, y, dx, dy) : c);
    }
  }
  line(x0: number, y0: number, x1: number, y1: number, r: number, c: string): void {
    const n = Math.ceil(Math.hypot(x1 - x0, y1 - y0) * 2) + 1;
    for (let i = 0; i <= n; i++) this.ell(x0 + ((x1 - x0) * i) / n, y0 + ((y1 - y0) * i) / n, r, r, c);
  }
  rows(x: number, y: number, rows: string[], map: Record<string, string> = {}): void {
    rows.forEach((r, j) => [...r].forEach((ch, i) => { if (ch !== '.') this.set(x + i, y + j, map[ch] ?? PAL[ch] ?? ch); }));
  }
  /** 1 px outline (4-neighbour) around everything filled */
  outline(c = PAL.k): this {
    const add: [number, number][] = [];
    for (let y = 0; y < this.h; y++) for (let x = 0; x < this.w; x++) {
      if (this.get(x, y) !== null) continue;
      if ([[1, 0], [-1, 0], [0, 1], [0, -1]].some(([dx, dy]) => { const v = this.get(x + dx, y + dy); return v !== null && v !== c; })) add.push([x, y]);
    }
    for (const [x, y] of add) this.set(x, y, c);
    return this;
  }
  url(): string {
    if (this.cached) return this.cached;
    const cv = document.createElement('canvas');
    cv.width = this.w;
    cv.height = this.h;
    const g = cv.getContext('2d')!;
    for (let y = 0; y < this.h; y++) for (let x = 0; x < this.w; x++) {
      const v = this.p[y * this.w + x];
      if (v) { g.fillStyle = v; g.fillRect(x, y, 1, 1); }
    }
    this.cached = cv.toDataURL();
    return this.cached;
  }
}
const fromRows = (rows: string[], map: Record<string, string> = {}) => { const a = new Art(rows[0].length, rows.length); a.rows(0, 0, rows, map); return a; };

const ICON_SRC: Record<string, string[]> = {
  fpv: [
    '................', '.kkk........kkk.', 'kmllk......kllmk', 'klwlk......klwlk', 'kmllkk....kkllmk', '.kkkdmk..kmdkkk.',
    '....kdmkkmdk....', '.....kdrrdk.....', '.....kqrrqk.....', '....kdmkkmdk....', '.kkkdmk..kmdkkk.', 'kmllkk....kkllmk',
    'klwlk......klwlk', 'kmllk......kllmk', '.kkk........kkk.', '................'],
  ambush: [
    '................', '................', '.....k...k......', '....kGk.kGk..k..', '.....kGkGk..kGk.', '....kkkGkkkkGk..',
    '..kknnnGnnnnkk..', '.knnGnnnnnnnnnk.', '.knGnnnnnnnnnnk.', 'knGnnnnnnnnnnnnk', 'knnnnnnnnnnnnnnk', 'kkkkkkkkkkkkkkkk',
    'kNNNNNNNNNNNNNNk', '.kkkkkkkkkkkkkk.', '................', '................'],
  recon: [
    '................', '.......kk.......', '......kcbk......', '......kbbk......', '......kbbk......', '.kkkkkkbbkkkkkk.',
    'kbbbbbbbbbbbbbbk', 'kBBBBBBbbBBBBBBk', '.kkkkkkbbkkkkkk.', '......kbbk......', '......kbbk......', '......kbbk......',
    '....kkkbbkkk....', '....kBBBBBBk....', '.....kkkkkk.....', '................'],
  lock: [
    '....kkkk....', '...kmllmk...', '..kmk..kmk..', '..kmk..kmk..', '.kkkkkkkkkk.', '.kgghggggok.',
    '.kghgkkgook.', '.kgggkkgook.', '.kgggkkgook.', '.kgoooooook.', '.kkkkkkkkkk.'],
  chev: ['....k....', '...khk...', '..khghk..', '.khgogok.', 'kgok.kogk', 'kok...kok', 'kk.....kk'],
  diamond: ['....k....', '...khk...', '..khgok..', '.khgggok.', 'khgggggok', '.kggggok.', '..kgook..', '...kok...', '....k....'],
  house: ['....k....', '...kgk...', '..kgggk..', '.kgggggk.', 'kkkkkkkkk', '.kwwkwwk.', '.kwwkwwk.', '.kkkkkkk.'],
  signal: ['......kkk', '......kgk', '...kkkkgk', '...kgkkgk', 'kkkkgkkgk', 'kgkkgkkgk', 'kgkkgkkgk', 'kkkkkkkkk'],
  // Phase 4 bosses: the boss line and the boss bar
  skull: ['..kkkkk..', '.kwwwwwk.', 'kwwwwwwwk', 'kwkkwkkwk', 'kwkkwkkwk', 'kwwwkwwwk', '.kwwwwwk.', '..kwkwk..', '..kkkkk..'],
};

const PROC: Record<string, (remap?: Record<string, string>) => Art> = {
  scrap() { // hex nut
    const a = new Art(16, 16);
    for (let y = 0; y < 16; y++) for (let x = 0; x < 16; x++) {
      const px = x + 0.5 - 8;
      const py = y + 0.5 - 8;
      const hex = Math.max(Math.abs(py) * 1.15, Math.abs(px) * 0.58 + Math.abs(py) * 0.58);
      if (hex > 6.6) continue;
      const r = Math.hypot(px, py);
      if (r < 2.4) continue;
      let c = PAL.l;
      if (r < 3.5) c = px + py > 0 ? PAL.w : PAL.d;
      else if (px + py < -6) c = PAL.w;
      else if (px + py > 4) c = PAL.m;
      if (hex > 5.6 && px + py > 2) c = PAL.d;
      a.set(x, y, c);
    }
    return a.outline();
  },
  parts() { // cog
    const a = new Art(16, 16);
    for (let y = 0; y < 16; y++) for (let x = 0; x < 16; x++) {
      const px = x + 0.5 - 8;
      const py = y + 0.5 - 8;
      const r = Math.hypot(px, py);
      const tooth = Math.cos(Math.atan2(py, px) * 8) > 0.25;
      if (r > (tooth ? 7 : 5.2) || r < 2) continue;
      let c = PAL.g;
      if (r < 3) c = px + py > 0 ? PAL.h : PAL.R;
      else if (px + py < -4) c = PAL.h;
      else if (px + py > 3.5) c = PAL.o;
      a.set(x, y, c);
    }
    return a.outline();
  },
  repair() { // spanner
    const a = new Art(16, 16);
    a.line(3.5, 12.5, 10, 6, 1.3, PAL.l);
    a.ell(11, 5, 3.6, 3.6, PAL.l);
    a.ell(3, 13, 2, 2, PAL.l);
    for (let y = 0; y < 16; y++) for (let x = 0; x < 16; x++) {
      const px = x + 0.5 - 11;
      const py = y + 0.5 - 5;
      if (Math.hypot(px, py) < 2) a.set(x, y, null);
      if (px - py > 1 && px + py < 3 && px + py > -3 && px > 0) a.set(x, y, null);
    }
    for (let y = 0; y < 16; y++) for (let x = 0; x < 16; x++) if (a.get(x, y)) {
      if (!a.get(x + 1, y + 1) || !a.get(x, y + 1)) a.set(x, y, PAL.m);
      if (!a.get(x - 1, y - 1) && a.get(x, y) === PAL.l) a.set(x, y, PAL.w);
    }
    return a.outline();
  },
  dpad(remap) { // 11x11, remap.dir = up/left/right/down lights one arm
    const a = new Art(11, 11);
    const hi = remap?.color === 'green' ? PAL.G : PAL.g;
    a.rect(4, 1, 3, 9, PAL.d);
    a.rect(1, 4, 9, 3, PAL.d);
    const arms: Record<string, number[]> = { up: [4, 1, 3, 3], down: [4, 7, 3, 3], left: [1, 4, 3, 3], right: [7, 4, 3, 3] };
    if (remap?.dir) { const [x, y, w, h] = arms[remap.dir]; a.rect(x, y, w, h, hi); }
    a.set(5, 5, PAL.y);
    return a.outline();
  },
};

const iconCache = new Map<string, Art>();
function iconArt(name: string, remap?: Record<string, string>): Art {
  const key = name + JSON.stringify(remap ?? {});
  let a = iconCache.get(key);
  if (!a) {
    a = ICON_SRC[name]
      ? fromRows(ICON_SRC[name], remap ? Object.fromEntries(Object.entries(remap).map(([k, v]) => [k, PAL[v] ?? v])) : {})
      : PROC[name](remap);
    iconCache.set(key, a);
  }
  return a;
}

/** n x n ring of 16 blocks, the first round(frac * 16) lit */
const ringCache = new Map<string, Art>();
function ringArt(n: number, frac: number): Art {
  const lit = Math.max(0, Math.min(16, Math.round(frac * 16)));
  const key = `${n}|${lit}`;
  let a = ringCache.get(key);
  if (a) return a;
  a = new Art(n, n);
  for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) {
    const dx = x + 0.5 - n / 2;
    const dy = y + 0.5 - n / 2;
    const r = Math.hypot(dx, dy);
    if (r > n / 2 - 0.2 || r < n / 2 - 2.6) continue;
    const ang = (Math.atan2(dx, -dy) / (Math.PI * 2) + 1) % 1;
    if ((ang * 16) % 1 < 0.14) continue;
    a.set(x, y, Math.floor(ang * 16) < lit ? PAL.g : PAL.y);
  }
  a.outline();
  ringCache.set(key, a);
  return a;
}

// ---------- portraits (32x32, shared layers so the cast looks like one family) ----------
interface Face {
  skin?: 'light' | 'mid' | 'tan';
  hair?: string[];
  brow?: string;
  clothes?: string[];
  collar?: string;
  bg?: string[];
  frown?: boolean;
  smile?: boolean;
  wrinkles?: boolean;
  freckles?: boolean;
  extra?: (a: Art, c: { sk: string; sm: string; sd: string; hair: string[] }) => void;
}
const SKIN = { light: ['#f4c8a0', '#e0a878', '#b07850'], mid: ['#e8b088', '#c88a60', '#9a6040'], tan: ['#d8a070', '#b47c50', '#845434'] };

function portraitArt(p: Face): Art {
  const a = new Art(32, 32);
  const [sk, sm, sd] = SKIN[p.skin ?? 'mid'];
  const hair = p.hair ?? ['#5a3a1a', '#3a2410'];
  const cl = p.clothes ?? ['#5a6a3a', '#3e4a28'];
  for (let y = 24; y < 32; y++) {
    const hw = Math.min(15, 8 + (y - 24) * 1.4);
    for (let x = 0; x < 32; x++) {
      const d = x + 0.5 - 16;
      if (Math.abs(d) <= hw) a.set(x, y, d > hw - 4 ? cl[1] : cl[0]);
    }
  }
  if (p.collar) for (let y = 24; y < 29; y++) for (let x = 13; x <= 18; x++) if (Math.abs(x + 0.5 - 16) < (y - 23) * 0.8) a.set(x, y, p.collar);
  a.rect(13, 20, 6, 5, sm);
  a.rect(13, 23, 6, 1, sd);
  for (let y = 4; y < 23; y++) for (let x = 6; x < 26; x++) {
    const dx = (x + 0.5 - 16) / 6.7;
    const dy = (y + 0.5 - 13.5) / 8.2;
    const jaw = y > 17 ? 1 + (y - 17) * 0.09 : 1;
    if ((dx * jaw) ** 2 + dy * dy > 1) continue;
    a.set(x, y, dx > 0.62 || dx < -0.7 || y >= 20 ? sm : sk);
  }
  a.rect(8, 13, 2, 3, sm); a.set(8, 14, sd);
  a.rect(23, 13, 2, 3, sm); a.set(24, 14, sd);
  const ey = 14;
  a.set(11, ey, '#ffffff'); a.set(12, ey, '#1a1410'); a.set(19, ey, '#1a1410'); a.set(20, ey, '#ffffff');
  a.set(11, ey + 1, sm); a.set(12, ey + 1, sm); a.set(19, ey + 1, sm); a.set(20, ey + 1, sm);
  const brow = p.brow ?? hair[1];
  a.rect(10, ey - 2, 4, 1, brow); a.rect(18, ey - 2, 4, 1, brow);
  if (p.frown) { a.set(13, ey - 1, brow); a.set(18, ey - 1, brow); }
  a.set(16, 15, sm); a.set(16, 16, sm); a.set(15, 17, sd); a.set(16, 17, sd);
  const lip = '#8a3a2a';
  a.rect(14, 19, 4, 1, lip);
  if (p.smile) { a.set(13, 18, lip); a.set(18, 18, lip); }
  if (p.freckles) for (const [x, y] of [[11, 16], [13, 17], [19, 16], [21, 17]]) a.set(x, y, sd);
  if (p.wrinkles) { a.set(10, 15, sd); a.set(21, 15, sd); a.set(13, 20, sd); a.set(18, 20, sd); }
  p.extra?.(a, { sk, sm, sd, hair });
  a.outline();
  const out = new Art(32, 32);
  const bg = p.bg ?? ['#2b2f36', '#22252b'];
  for (let y = 0; y < 32; y++) for (let x = 0; x < 32; x++) out.set(x, y, a.get(x, y) ?? (y < 22 ? bg[0] : bg[1]));
  return out;
}

/** Radio speakers by call sign or name (placeholders from the mockups); anyone else gets the radio operator. */
const FACES: Record<string, Face> = {
  yurko: { // SPANNER, mechanic: knit beanie, stubble, grease smudge, overall straps
    skin: 'mid', clothes: ['#3a5a8a', '#2a4066'], collar: '#c8b890', bg: ['#3a2a20', '#2c2018'],
    extra(a, c) {
      for (let y = 2; y < 11; y++) for (let x = 7; x < 25; x++) {
        const dx = (x + 0.5 - 16) / 8.4;
        const dy = (y + 0.5 - 10) / 8;
        if (dx * dx + dy * dy <= 1) a.set(x, y, x % 2 ? '#c87000' : x < 13 ? '#f0a040' : '#983000');
      }
      a.rect(7, 9, 18, 3, '#983000'); a.rect(7, 9, 18, 1, '#c87000');
      a.rect(8, 12, 2, 3, c.hair[0]); a.rect(22, 12, 2, 3, c.hair[1]);
      for (let y = 17; y < 22; y++) for (let x = 9; x < 23; x++) if (a.get(x, y) && (x + y) % 2 === 0 && !(y === 19 && x >= 14 && x <= 17)) a.set(x, y, c.sd);
      a.set(20, 16, '#2b2f36'); a.set(21, 16, '#2b2f36'); a.set(20, 17, '#4a4f58');
      a.rect(11, 26, 2, 6, '#2a4066'); a.rect(19, 26, 2, 6, '#2a4066'); a.set(11, 27, '#c6ccd4'); a.set(20, 27, '#c6ccd4');
    },
  },
  koval: { // HQ: field cap with badge, radio handset, gold collar tabs
    skin: 'light', hair: ['#2a1c14', '#1a100a'], clothes: ['#4a5634', '#343d24'], collar: '#c8b890', frown: true, bg: ['#1c2838', '#16202c'],
    extra(a, c) {
      a.rect(8, 11, 2, 6, c.hair[0]); a.rect(22, 11, 2, 6, c.hair[1]);
      for (let y = 2; y < 10; y++) for (let x = 7; x < 25; x++) if (Math.abs(x + 0.5 - 16) <= 8 - (y < 4 ? 4 - y : 0)) a.set(x, y, x < 11 ? '#6a7448' : x > 21 ? '#3a4226' : '#56603a');
      a.rect(7, 9, 18, 2, '#3a4226'); a.rect(9, 11, 14, 1, '#1a1410');
      a.rect(15, 5, 2, 2, '#f8b800'); a.set(15, 5, '#ffe08a');
      a.rect(23, 12, 3, 9, '#1c1f24'); a.rect(24, 13, 1, 7, '#4a4f58'); a.rect(22, 20, 3, 2, '#1c1f24');
      a.rect(10, 26, 2, 2, '#f8b800'); a.rect(20, 26, 2, 2, '#f8b800');
    },
  },
  mykola: { // TRACTOR, driver: padded tanker helmet, goggles, big moustache
    skin: 'tan', hair: ['#9aa0a8', '#6a707a'], brow: '#c6ccd4', clothes: ['#4a5634', '#343d24'], collar: '#2a2418', wrinkles: true, bg: ['#3a3220', '#2c2618'],
    extra(a) {
      for (let y = 3; y < 13; y++) for (let x = 7; x < 25; x++) {
        const dx = (x + 0.5 - 16) / 8.6;
        const dy = (y + 0.5 - 12) / 8.6;
        if (dx * dx + dy * dy <= 1) a.set(x, y, x === 12 || x === 16 || x === 20 ? '#2e1c12' : x < 12 ? '#6a4630' : '#4a3020');
      }
      a.rect(7, 11, 3, 8, '#4a3020'); a.rect(22, 11, 3, 8, '#2e1c12'); a.rect(7, 18, 3, 1, '#2e1c12'); a.rect(22, 18, 3, 1, '#2e1c12');
      a.rect(9, 9, 14, 1, '#1a1410');
      for (const x of [10, 17]) { a.rect(x, 8, 5, 3, '#8a919b'); a.rect(x + 1, 9, 3, 1, '#6c9cff'); a.set(x + 1, 9, '#a8e0ff'); }
      a.rect(12, 18, 8, 1, '#c6ccd4'); a.rect(11, 19, 3, 1, '#9aa0a8'); a.rect(18, 19, 3, 1, '#9aa0a8'); a.rect(14, 18, 4, 1, '#f4efe2');
    },
  },
  halyna: { // AUNTIE, gunner: grey bob, round glasses, earring
    skin: 'light', hair: ['#c6ccd4', '#8a919b'], clothes: ['#5a6a3a', '#3e4a28'], collar: '#c8b890', smile: true, wrinkles: true, bg: ['#2a3428', '#20281e'],
    extra(a, c) {
      const [H, Hd] = c.hair;
      for (let y = 3; y < 13; y++) for (let x = 7; x < 25; x++) {
        const dx = (x + 0.5 - 16) / 8.3;
        const dy = (y + 0.5 - 12) / 8.3;
        if (dx * dx + dy * dy <= 1) a.set(x, y, x > 19 ? Hd : H);
      }
      a.rect(7, 11, 3, 8, H); a.rect(22, 11, 3, 8, Hd); a.rect(7, 18, 2, 1, Hd); a.rect(23, 18, 2, 1, Hd);
      a.rect(10, 10, 6, 1, Hd); a.set(15, 11, H);
      for (const x of [10, 18]) { a.rect(x, 13, 4, 1, '#4a4f58'); a.rect(x, 15, 4, 1, '#4a4f58'); a.set(x, 14, '#4a4f58'); a.set(x + 3, 14, '#4a4f58'); }
      a.set(11, 14, '#ffffff'); a.set(12, 14, '#1a1410'); a.set(19, 14, '#1a1410'); a.set(20, 14, '#ffffff');
      a.rect(14, 14, 4, 1, '#4a4f58');
      a.set(23, 17, '#f8b800');
    },
  },
  sofia: { // WASP, drone operator: bun, fringe, headset with mic
    skin: 'light', hair: ['#3a2418', '#22140c'], clothes: ['#4a6a4a', '#344a34'], collar: '#2b2f36', freckles: true, bg: ['#203040', '#182430'],
    extra(a, c) {
      const [H, Hd] = c.hair;
      a.ell(16, 3.5, 3.5, 2.6, Hd);
      for (let y = 4; y < 13; y++) for (let x = 7; x < 25; x++) {
        const dx = (x + 0.5 - 16) / 8.2;
        const dy = (y + 0.5 - 12.5) / 8.2;
        if (dx * dx + dy * dy <= 1) a.set(x, y, x > 18 ? Hd : H);
      }
      a.rect(9, 11, 6, 1, H); a.rect(8, 11, 2, 6, H); a.rect(22, 11, 2, 6, Hd);
      a.rect(7, 5, 18, 1, '#4a4f58'); a.set(7, 6, '#4a4f58'); a.set(24, 6, '#4a4f58');
      a.rect(6, 7, 1, 5, '#4a4f58'); a.rect(25, 7, 1, 5, '#4a4f58');
      a.rect(5, 11, 4, 6, '#1c1f24'); a.rect(5, 12, 1, 4, '#4a4f58');
      a.rect(23, 11, 4, 6, '#1c1f24'); a.rect(26, 12, 1, 4, '#4a4f58');
      a.line(7, 16.5, 12, 19.5, 0.3, '#4a4f58'); a.set(12, 19, '#f0482a');
    },
  },
  taras: { // OWL, scout: boonie hat, beard, face paint, camo
    skin: 'mid', clothes: ['#56603a', '#3a4226'], collar: '#3a4226', bg: ['#26302a', '#1c2420'],
    extra(a, c) {
      a.ell(16, 7.5, 7.5, 5, '#56603a', (_x, _y, dx) => (dx < -0.4 ? '#6a7448' : dx > 0.5 ? '#3a4226' : '#56603a'));
      a.rect(4, 9, 24, 2, '#3a4226'); a.rect(4, 9, 24, 1, '#56603a');
      a.rect(8, 7, 16, 1, '#3a4226');
      for (let y = 16; y < 23; y++) for (let x = 8; x < 24; x++) {
        const dx = (x + 0.5 - 16) / 7.4;
        const dy = (y + 0.5 - 15) / 8;
        if (dx * dx + dy * dy <= 1 && !(y === 19 && x >= 14 && x <= 17) && !(y < 18 && x > 12 && x < 19)) a.set(x, y, (x + y) % 3 ? c.hair[0] : c.hair[1]);
      }
      a.rect(13, 18, 6, 1, c.hair[0]);
      a.rect(9, 16, 4, 1, '#3a4226'); a.rect(19, 16, 4, 1, '#3a4226');
      for (const [x, y] of [[4, 27], [9, 29], [22, 26], [26, 29], [15, 30], [12, 26]]) { a.set(x, y, '#2a3018'); a.set(x + 1, y, '#2a3018'); }
    },
  },
  // ---------- Phase 3 crew recruits (crew.ts) ----------
  oksana: { // STITCH, loader (a nurse for twenty years): auburn hair, headband, braid over the shoulder, cheek plaster
    skin: 'light', hair: ['#9a4a20', '#6a2c12'], clothes: ['#5a6a3a', '#3e4a28'], collar: '#e8d8a8', bg: ['#34283a', '#28202e'],
    extra(a, c) {
      const [H, Hd] = c.hair;
      for (let y = 3; y < 13; y++) for (let x = 7; x < 25; x++) {
        const dx = (x + 0.5 - 16) / 8.3;
        const dy = (y + 0.5 - 12) / 8.3;
        if (dx * dx + dy * dy <= 1) a.set(x, y, x > 19 ? Hd : H);
      }
      a.rect(16, 4, 1, 7, Hd);
      a.rect(7, 11, 2, 6, H); a.rect(23, 11, 2, 6, Hd);
      a.rect(9, 8, 14, 1, '#e8d8a8'); a.rect(8, 9, 16, 1, '#b8a878');
      for (let y = 16; y < 30; y++) a.rect(23 + (y % 2), y, 2, 1, y % 3 ? H : Hd);
      a.rect(10, 17, 2, 1, '#e8d8a8'); a.set(10, 16, '#e8d8a8');
    },
  },
  danylo: { // STATIC, radio operator: spiky black hair, hoodie, headphones round the neck, a whip antenna
    skin: 'mid', hair: ['#1c1610', '#0e0a08'], clothes: ['#3a4a6a', '#2a344c'], collar: '#2a344c', bg: ['#1c2c2a', '#16221f'],
    extra(a, c) {
      const [H, Hd] = c.hair;
      for (let y = 3; y < 12; y++) for (let x = 7; x < 25; x++) {
        const dx = (x + 0.5 - 16) / 8.4;
        const dy = (y + 0.5 - 11.5) / 7.6;
        if (dx * dx + dy * dy <= 1) a.set(x, y, x > 19 ? Hd : H);
      }
      for (const [x, h] of [[9, 2], [12, 3], [15, 2], [18, 3], [21, 2]]) a.rect(x, 4 - h, 2, h, H);
      a.rect(8, 11, 2, 4, H); a.rect(22, 11, 2, 4, Hd);
      a.rect(14, 18, 4, 1, c.sd);
      a.line(25.5, 31, 29, 13, 0.3, '#8a919b'); a.set(29, 12, '#f0482a');
      a.rect(4, 25, 4, 7, '#2a344c'); a.rect(24, 25, 4, 7, '#2a344c');
      a.rect(11, 24, 10, 1, '#4a4f58');
      a.rect(8, 22, 3, 4, '#f0482a'); a.rect(8, 22, 1, 4, '#7a1a10');
      a.rect(21, 22, 3, 4, '#f0482a'); a.rect(23, 22, 1, 4, '#7a1a10');
    },
  },
  roman: { // BOOKS, quartermaster (ran the district library): bald with a grey fringe, square glasses, beard, pencil
    skin: 'tan', hair: ['#9aa0a8', '#6a707a'], brow: '#c6ccd4', clothes: ['#6a4630', '#4a3020'], collar: '#c8b890', wrinkles: true, bg: ['#2c2a1c', '#222016'],
    extra(a, c) {
      const [H, Hd] = c.hair;
      a.rect(7, 9, 3, 7, H); a.rect(22, 9, 3, 7, Hd); a.rect(8, 8, 2, 1, H); a.rect(22, 8, 2, 1, Hd);
      a.set(12, 6, '#ecc090'); a.set(13, 6, '#ecc090'); a.set(12, 7, '#ecc090');
      for (let y = 17; y < 23; y++) for (let x = 9; x < 23; x++) {
        const dx = (x + 0.5 - 16) / 7;
        const dy = (y + 0.5 - 16) / 7;
        if (dx * dx + dy * dy <= 1 && !(y === 19 && x >= 14 && x <= 17) && !(y < 18 && x > 12 && x < 19)) a.set(x, y, (x + y) % 3 ? H : Hd);
      }
      a.rect(13, 18, 6, 1, H);
      for (const x of [9, 17]) { a.rect(x, 12, 6, 2, '#1a1410'); a.rect(x, 16, 6, 1, '#1a1410'); a.rect(x, 14, 1, 2, '#1a1410'); a.rect(x + 5, 14, 1, 2, '#1a1410'); }
      a.rect(15, 14, 2, 1, '#1a1410');
      a.line(22.5, 11.5, 27, 7, 0.45, '#f8b800'); a.set(27, 7, '#2b2f36'); a.set(22, 12, '#e8d8a8');
      a.set(16, 27, '#e8d8a8'); a.set(16, 30, '#e8d8a8');
    },
  },
  radio: { // anyone else: a radio operator in a side cap with a headset
    skin: 'mid', hair: ['#4a3020', '#2e1c12'], clothes: ['#4a5634', '#343d24'], collar: '#343d24', bg: ['#1c2a30', '#162026'],
    extra(a, c) {
      for (let y = 4; y < 12; y++) for (let x = 7; x < 25; x++) {
        const dx = (x + 0.5 - 16) / 8.2;
        const dy = (y + 0.5 - 12) / 8;
        if (dx * dx + dy * dy <= 1) a.set(x, y, x > 19 ? c.hair[1] : c.hair[0]);
      }
      a.rect(9, 5, 14, 3, '#56603a'); a.rect(9, 5, 14, 1, '#6a7448'); a.rect(9, 7, 14, 1, '#3a4226');
      a.rect(7, 6, 1, 7, '#1c1f24'); a.rect(24, 6, 1, 7, '#1c1f24'); a.rect(8, 5, 16, 1, '#1c1f24');
      a.rect(5, 11, 4, 6, '#1c1f24'); a.rect(5, 12, 1, 4, '#4a4f58');
      a.rect(23, 11, 4, 6, '#1c1f24'); a.rect(26, 12, 1, 4, '#4a4f58');
      a.line(25, 16.5, 19, 19.5, 0.3, '#4a4f58'); a.set(19, 19, '#7cd83a');
    },
  },
};
const WHO: Record<string, string> = {
  SPANNER: 'yurko', YURKO: 'yurko', MECHANIC: 'yurko',
  HQ: 'koval', KOVAL: 'koval', 'MAJOR KOVAL': 'koval', COMMAND: 'koval',
  TRACTOR: 'mykola', MYKOLA: 'mykola', DRIVER: 'mykola',
  AUNTIE: 'halyna', HALYNA: 'halyna', GUNNER: 'halyna',
  WASP: 'sofia', SOFIA: 'sofia',
  OWL: 'taras', TARAS: 'taras', SCOUT: 'taras',
  STITCH: 'oksana', OKSANA: 'oksana', LOADER: 'oksana', // Phase 3 crew recruits
  STATIC: 'danylo', DANYLO: 'danylo',
  BOOKS: 'roman', ROMAN: 'roman', QUARTERMASTER: 'roman',
};
const faceCache = new Map<string, Art>();
function faceArt(who: string): Art {
  const id = WHO[who.toUpperCase()] ?? 'radio';
  let a = faceCache.get(id);
  if (!a) faceCache.set(id, (a = portraitArt(FACES[id])));
  return a;
}

/** A radio speaker's 32x32 portrait as a data URL (the retreat screen shows it). */
export function radioFace(who: string): string {
  return faceArt(who).url();
}

// Phase 5 events hook: map events add civilian portraits (src/ui-events.ts) in the same family style
export type PortraitDef = Face;
export function addPortrait(id: string, f: Face, names: string[]): void {
  FACES[id] = f;
  for (const n of names) WHO[n.toUpperCase()] = id;
  faceCache.delete(id);
}

// ---------- minimap colours ----------
type RGB3 = [number, number, number];
const hex = (h: string): RGB3 => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16)) as RGB3;
const TER: RGB3[] = [];
TER[0] = hex('#3e4c2a'); // ground
TER[BRICK] = hex('#9a6a44');
TER[STEEL] = hex('#8a919b');
TER[WATER] = hex('#2a4a7a');
TER[TREES] = hex('#26361c');
TER[ICE] = hex('#9ab8c8');
TER[ROAD] = hex('#7a6c4c');
TER[RAIL] = hex('#4e4640'); // Phase 4 rail
const TINT_HELD = hex('#f0482a');
const TINT_FREE = hex('#f8b800');
const mixc = (a: RGB3, b: RGB3, t: number): RGB3 => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];

/** Enemies further than this (px) from every live player stay off the maps: they show what your crews can see. */
const SIGHT = 200;
/** Radio: characters typed per second, and how long a finished line stays up (s). */
const TYPE_CPS = 40;
const RADIO_HOLD = 8;
/** Radio: ambient lines (enemy intercepts) kept waiting at most; HQ, boss and crew lines are never dropped. */
const RADIO_AMB_KEEP = 2;
const PATCH_COST = 15;

const ABIL = [
  { icon: 'fpv', label: 'DRONE', pad: 'up' },
  { icon: 'ambush', label: 'AMBUSH', pad: 'left' },
  { icon: 'recon', label: 'RECON', pad: 'right' },
  { icon: 'repair', label: 'PATCH', pad: 'down' },
];
const NAMES = ['BABUSYA', 'DIDO'];
/** Show the depot objective line (Phase 2: depots can be destroyed) and the boss line (Phase 4 bosses). */
const SHOW_DEPOT_GOAL = true;
const SHOW_BOSS_GOAL = true;

interface MapView { base: HTMLCanvasElement; over: HTMLCanvasElement; k: number; sector: Int16Array | null; key: string; dots: number[] }

/** The UI-pixel size for a window (same rule as the mockups): 3 at 1080p, 2 at 720p, 4 at 1440p. */
export function uiPixel(W: number, H: number): number {
  return Math.max(2, Math.min(4, Math.floor(Math.min(W / (W / H < 1.2 ? 360 : 600), H / 340))));
}

export class CampaignHud {
  root: HTMLElement;
  /** top of the toast column (css px), clear of the top plates */
  toastTop = 24;
  /** toast top without / with the boss bar showing (css px) */
  private toastBase = 24;
  private bossToast = 24;
  /** called when a new radio line starts (the app plays the radio blip) */
  onLine: (() => void) | null = null;
  private u = 3;
  private buildKey = '';
  private placeKey = '';
  private world: World | null = null;
  private el: Record<string, HTMLElement> = {};
  private mini: MapView | null = null;
  private big: MapView | null = null;
  private mapOpen = false;
  private frame = 0;
  private target: TownState | null = null;
  private radioQ: RadioMsg[] = [];
  private radioCur: RadioMsg | null = null;
  private radioT = -1; // seconds since the current line started, -1 = none
  private radioGlyphs: HTMLElement[] = [];
  private radioShown = 0;
  private radioLen = 0;
  private lastTime = 0;

  constructor(before: Element, private T: TextFn, private sprite: SpriteFn) {
    this.root = document.createElement('div');
    this.root.id = 'chud';
    this.root.className = 'off';
    before.before(this.root);
    const pat = (rows: string[], map: Record<string, string>) => `url(${fromRows(rows, map).url()})`;
    const stripe = ['yyzzzzyy', 'yzzzzyyy', 'zzzzyyyy', 'zzzyyyyz', 'zzyyyyzz', 'zyyyyzzz', 'yyyyzzzz', 'yyyzzzzy'];
    this.root.style.setProperty('--hazard', pat(stripe, { y: '#30343b', z: '#272a30' }));
  }

  // ---------- small builders (sizes in UI pixels) ----------
  private px(n: number): string { return `${n * this.u}px`; }
  private img(a: Art, cls = '', style = ''): string {
    return `<img class="${cls}" src="${a.url()}" style="width:${a.w * this.u}px;height:${a.h * this.u}px;${style}">`;
  }
  private icon(name: string, cls = '', remap?: Record<string, string>, style = ''): string { return this.img(iconArt(name, remap), cls, style); }
  private kc(k: string): string { return `<span class="cp-kc">${this.T(k, 2)}</span>`; }
  private segs(n: number, w: number, h: number, cls: string, key: string): string {
    return `<span class="cp-segs ${cls}" data-k="${key}">${`<i style="width:${this.px(w)};height:${this.px(h)}"></i>`.repeat(n)}</span>`;
  }
  /** wrapped pixel-text paragraph: one span per word, word gap = one space, line gap = 3 glyph px */
  private para(text: string, s: number, cls: string): string {
    return `<div class="cp-para" style="column-gap:${4 * s}px;row-gap:${3 * s}px">${text.split(' ').filter(Boolean).map((w) => this.T(w, s, cls)).join('')}</div>`;
  }
  private setT(el: HTMLElement | undefined, text: string, s: number, cls = ''): void {
    if (!el) return;
    const key = `${text}|${s}|${cls}`;
    if (el.dataset.t === key) return;
    el.dataset.t = key;
    el.innerHTML = this.T(text, s, cls);
  }
  private setSrc(el: HTMLElement | undefined, a: Art): void {
    if (!el) return;
    const url = a.url();
    const im = el as HTMLImageElement;
    if (im.getAttribute('src') !== url) {
      im.src = url;
      im.style.width = this.px(a.w);
      im.style.height = this.px(a.h);
    }
  }
  private cls(el: HTMLElement | undefined, name: string, on: boolean): void {
    if (el && el.classList.contains(name) !== on) el.classList.toggle(name, on);
  }

  // ---------- build ----------
  private build(w: World): void {
    const u = this.u;
    const T = this.T;
    const two = w.nPlayers === 2;
    const towns = w.towns.length;
    const depots = w.depots.length || (w.region?.depots?.length ?? 0);
    const sm = 2;
    const md = u;
    const objectives = `<div class="cp-plate glass" style="padding:${this.px(3)} ${this.px(4)}">
      <div class="cp-hdr" style="margin:-${this.px(3)} -${this.px(4)} ${this.px(3)};padding:${this.px(2)} ${this.px(4)}">${T('OBJECTIVES', sm, 'c-gold')}<span class="cp-row" style="gap:${u}px" data-k="pips"></span></div>
      <div class="cp-col" style="gap:${this.px(3)}">
        <div class="cp-row" style="align-items:flex-start;gap:${this.px(3)}">${this.icon('diamond', 'cp-blink')}<div class="cp-col" style="gap:${this.px(2)}">
          <span data-k="goal"></span>
          <div class="cp-row" style="gap:${this.px(2)}"><img data-k="ring" src="${ringArt(9, 0).url()}" style="width:${this.px(9)};height:${this.px(9)}"><span data-k="goalSub"></span></div></div></div>
        ${SHOW_DEPOT_GOAL && depots ? `<div class="cp-row" style="gap:${this.px(3)}"><img data-k="depIc" src="${iconArt('diamond', { g: 'm', h: 'l', o: 'd' }).url()}" style="width:${this.px(9)};height:${this.px(9)}"><span data-k="dep"></span></div>` : ''}
        ${SHOW_BOSS_GOAL && towns && w.boss ? `<div class="cp-row" style="gap:${this.px(3)}"><img data-k="bossIc" src="${iconArt('lock').url()}" style="width:${this.px(12)};height:${this.px(11)};opacity:.6"><span data-k="boss"></span></div>` : ''}
      </div></div>`;
    // Phase 4: the boss bar (top centre while the boss is near or fighting): name, a segment group per weak point
    // in the order they sit on the hull (left skirt, left gun, right gun, right skirt), then the turret with a lock
    // while shells can't hurt it
    const bossBar = w.boss ? `<div class="cp-plate glass" style="padding:${this.px(3)} ${this.px(5)}">
      <div class="cp-row" style="gap:${this.px(3)};justify-content:center">${this.icon('skull')}${T(w.boss.name, md, 'c-red')}${T(w.boss.title, sm, 'c-dim')}</div>
      <div class="cp-row" style="gap:${this.px(5)};margin-top:${this.px(3)};justify-content:center;align-items:flex-end">${w.boss.parts.filter((p) => p !== w.boss!.turret).map((p) => {
        const k = w.boss!.parts.indexOf(p);
        return `<div class="cp-col" style="gap:${this.px(2)};align-items:center" data-k="bp${k}">${T(p.short, sm, 'c-dim')}${this.segs(p.max, 3, 3, 'red', `bs${k}`)}</div>`;
      }).join('')}</div>
      <div class="cp-row" style="gap:${this.px(3)};margin-top:${this.px(3)};justify-content:center"><img data-k="bLock" src="${iconArt('lock').url()}" style="width:${this.px(12)};height:${this.px(11)}">${T(w.boss.turret.short, sm, 'c-ink')}${this.segs(w.boss.turret.max, 4, 4, 'red', `bs${w.boss.parts.indexOf(w.boss.turret)}`)}</div></div>` : '';
    const resources = `<div class="cp-plate flat glass cp-row" style="gap:${this.px(6)};padding:${this.px(2)} ${this.px(4)}">
      <span class="cp-row" style="gap:${this.px(2)}">${this.icon('scrap')}${T('SCRAP', sm, 'c-dim')}<span data-k="scrap"></span></span>
      <span class="cp-row" style="gap:${this.px(2)}">${this.icon('parts')}${T('PARTS', sm, 'c-dim')}<span data-k="parts"></span></span>
      <i class="cp-vsep"></i><span class="cp-row" style="gap:${this.px(2)}">${this.kc('ESC')}${T('PAUSE', sm, 'c-dim')}</span></div>`;
    const regionName = (w.region?.name ?? w.def.name).toUpperCase();
    const minimap = `<div class="cp-plate glass" style="padding:${this.px(3)}">
      <div class="cp-hdr" style="margin:-${this.px(3)} -${this.px(3)} ${this.px(3)};padding:${this.px(2)} ${this.px(3)}">${T(regionName, sm, 'c-gold')}<span class="cp-row" style="gap:${this.px(2)}">${this.kc('TAB')}${u < 3 ? '' : T('MAP', sm, 'c-dim')}</span></div>
      <div class="cp-well cp-mapbox" data-k="mm"></div></div>`;
    // tank card: sprite, tag + name + veterancy, armour, XP. Co-op drops the words and mirrors player 2's card.
    const card = (i: number) => {
      const mirror = two && i === 1;
      const rev = mirror ? 'flex-direction:row-reverse;' : '';
      const words = !two;
      const chev = [0, 1, 2].map((k) => `<img data-k="chev${i}${k}" src="${iconArt('chev').url()}" style="width:${this.px(9)};height:${this.px(7)}">`).join('');
      return `<div class="cp-row" data-k="card${i}" style="gap:${this.px(4)};${rev}">
        <div class="cp-plate ${i ? 'own2' : 'own1'}" style="padding:${this.px(2)}"><img data-k="tank${i}" style="width:${this.px(32)};height:${this.px(32)}"></div>
        <div class="cp-col" style="gap:${this.px(3)};align-items:${mirror ? 'flex-end' : 'flex-start'}">
          <div class="cp-row" style="gap:${this.px(3)};${rev}"><span class="cp-tag ${i ? 'p2' : ''}">${T(i ? 'IIP' : 'IP', sm)}</span>${T(NAMES[i], md, 'c-ink')}<span class="cp-row" style="gap:${u}px">${chev}</span><span data-k="lives${i}"></span></div>
          <div class="cp-row" style="gap:${this.px(3)};${rev}">${words ? T('ARMOUR', sm, 'c-dim') : ''}<span data-k="arm${i}"></span><span data-k="armN${i}" style="display:inline-flex;justify-content:${mirror ? 'flex-start' : 'flex-end'}"></span></div>
          <div class="cp-row" style="gap:${this.px(3)};${rev}">${words ? T('VET', sm, 'c-dim') : ''}${this.segs(12, 3, 2, 'blue', `xp${i}`)}</div>
        </div></div>`;
    };
    const labels = !(two && u < 3);
    const btn = (a: typeof ABIL[number], k: number) => `<div class="cp-ab" data-k="ab${k}">
      <div class="cp-btn cp-well" data-k="btn${k}">${this.icon(a.icon, 'ic')}<span class="key">${this.kc(String(k + 1))}</span>${
        two ? `<span class="key2">${this.icon('dpad', '', { dir: a.pad, color: 'green' })}</span>` : ''}${
        // the patch cooldown: a dark wipe over the well that drains as it recharges (one per player in co-op)
        k === 3 ? [0, 1].slice(0, two ? 2 : 1).map((p) => `<span class="cp-cd${two ? ` half p${p}` : ''}" data-k="cd${p}" style="display:none"></span>`).join('') : ''
      }<span class="cnt cp-ol" data-k="cnt${k}"></span></div>
      ${labels ? `<span data-k="lab${k}"></span>` : ''}</div>`;
    const abilities = `<div class="cp-row" style="gap:${this.px(two ? 6 : 5)};align-items:flex-start;padding-top:${u}px">${ABIL.map(btn).join('')}</div>`;
    const cluster = `<div class="cp-plate glass cp-row" style="gap:${this.px(5)};padding:${this.px(3)} ${this.px(4)}">
      ${card(0)}<i class="cp-vsep"></i>${abilities}${two ? `<i class="cp-vsep"></i>${card(1)}` : ''}</div>`;
    const radio = `<div class="cp-plate glass" style="width:${Math.max(112 * u, 300)}px;padding:${this.px(3)}">
      <div class="cp-row" style="align-items:flex-start;gap:${this.px(3)}">
        <div class="cp-well"><img data-k="face" src="${faceArt('').url()}" style="width:${this.px(32)};height:${this.px(32)}"></div>
        <div class="cp-col" style="gap:${this.px(3)};flex:1;min-width:0">
          <div class="cp-row" data-k="whoRow" style="justify-content:space-between"><span data-k="who"></span><span class="cp-row" style="gap:${this.px(2)}"><span data-k="ch">${T('CH 4', sm, 'c-mute')}</span>${this.icon('signal')}</span></div>
          <div data-k="msg"></div></div></div></div>`;
    const bigmap = `<div class="cp-plate glass" style="padding:${this.px(3)}">
      <div class="cp-hdr" style="margin:-${this.px(3)} -${this.px(3)} ${this.px(3)};padding:${this.px(2)} ${this.px(4)}">${T(regionName, md, 'c-gold')}<span class="cp-row" style="gap:${this.px(2)}">${this.kc('TAB')}${T('CLOSE', sm, 'c-dim')}</span></div>
      <div class="cp-well cp-mapbox" data-k="bm"><div class="cp-labels" data-k="bml"></div></div></div>`;
    this.root.style.setProperty('--u', `${u}px`);
    this.root.innerHTML = `
      <div class="cp-abs" data-k="obj">${objectives}</div>
      <div class="cp-abs" data-k="res">${resources}</div>
      <div class="cp-abs" data-k="mmp">${minimap}</div>
      <div class="cp-abs" data-k="cl">${cluster}</div>
      <div class="cp-abs cp-radio gone" data-k="rd">${radio}</div>
      ${bossBar ? `<div class="cp-abs cp-boss gone" data-k="bb">${bossBar}</div>` : ''}
      <div class="cp-bigmap ${this.mapOpen ? '' : 'off'}" data-k="map">${bigmap}</div>`;
    this.el = {};
    this.root.querySelectorAll<HTMLElement>('[data-k]').forEach((e) => { this.el[e.dataset.k!] = e; });
    // town pips: one house per town, gold once freed
    this.el.pips.innerHTML = w.towns.map((_, k) => `<img data-k="pip${k}" src="${iconArt('house', { g: 'd', w: 'y' }).url()}" style="width:${this.px(9)};height:${this.px(8)}">`).join('');
    this.el.pips.querySelectorAll<HTMLElement>('[data-k]').forEach((e) => { this.el[e.dataset.k!] = e; });
    // minimap: 80 px on the long side; the big map: one px per cell, scaled up by whole numbers
    this.mini = this.makeMap(this.el.mm, w, Math.max(w.map.w, w.map.h) / 80);
    this.big = this.makeMap(this.el.bm, w, 1);
    this.townLabels(w);
    this.placeKey = '';
    // the radio panel survives a rebuild mid-line
    if (this.radioT >= 0 && this.radioCur) this.showRadio(this.radioCur, this.radioT);
  }

  private makeMap(box: HTMLElement, w: World, k: number): MapView {
    const n = Math.ceil(w.map.w / k);
    const m = Math.ceil(w.map.h / k);
    const mk = () => {
      const c = document.createElement('canvas');
      c.width = n;
      c.height = m;
      return c;
    };
    const base = mk();
    const over = mk();
    over.className = 'over';
    box.prepend(base, over);
    return { base, over, k, sector: null, key: '', dots: [] };
  }

  /** whole-number display scale of the big map for this window */
  private bigScale(w: World): number {
    const u = this.u;
    return Math.max(1, Math.floor(Math.min((innerWidth - 24 * u) / w.map.w, (innerHeight - 40 * u) / w.map.h)));
  }

  private townLabels(w: World): void {
    const box = this.el.bml;
    if (!box) return;
    box.innerHTML = w.towns.map((t, k) => `<span class="cp-ol" data-k="tl${k}">${this.T(t.name, 2, t.freed ? 'c-gold' : 'c-ink')}</span>`).join('');
    box.querySelectorAll<HTMLElement>('[data-k]').forEach((e) => { this.el[e.dataset.k!] = e; });
  }

  // ---------- placement ----------
  private place(w: World): void {
    const W = innerWidth;
    const M = 4 * this.u;
    const E = this.el;
    // map canvases first (whole-number scales), so the plates measure right
    const z = this.bigScale(w);
    const b = this.big!;
    for (const c of [b.base, b.over]) Object.assign(c.style, { width: `${c.width * z}px`, height: `${c.height * z}px` });
    const mm = this.mini!;
    for (const c of [mm.base, mm.over]) Object.assign(c.style, { width: `${c.width * this.u}px`, height: `${c.height * this.u}px` });
    Object.assign(E.obj.style, { left: `${M}px`, top: `${M}px` });
    Object.assign(E.res.style, { right: `${M}px`, top: `${M}px` });
    Object.assign(E.mmp.style, { left: `${M}px`, bottom: `${M}px` });
    Object.assign(E.rd.style, { right: `${M}px`, bottom: `${M}px` });
    const cl = E.cl;
    cl.style.bottom = `${M}px`;
    const cw = cl.offsetWidth;
    const cx = Math.round((W - cw) / 2);
    cl.style.left = `${cx}px`;
    // minimap and radio sit beside the cluster; where there isn't room they sit on top of it instead
    const up = `${M + cl.offsetHeight + 4 * this.u}px`;
    if (M + E.mmp.offsetWidth + 4 * this.u > cx) E.mmp.style.bottom = up;
    if (W - M - E.rd.offsetWidth < cx + cw + 4 * this.u) E.rd.style.bottom = up;
    // the fps / muted readouts tuck in under the resource strip (ui.css #ui.camp), clear of the toasts
    this.root.parentElement?.style.setProperty('--cp-under-res', `${M + E.res.offsetHeight + 3 * this.u}px`);
    this.root.parentElement?.style.setProperty('--cp-m', `${M}px`);
    // toasts: top centre if they fit between the top plates, else just below them
    const gap = W - E.obj.offsetWidth - E.res.offsetWidth - 4 * M;
    this.toastBase = this.toastTop = gap >= 120 * this.u ? M : M + Math.max(E.obj.offsetHeight, E.res.offsetHeight) + 6 * this.u;
    // Phase 4: the boss bar sits top centre between the plates (or under them when it doesn't fit); toasts go below it
    if (E.bb) {
      const bw = E.bb.offsetWidth;
      const fits = W - E.obj.offsetWidth - E.res.offsetWidth - 4 * M >= bw + 8 * this.u;
      Object.assign(E.bb.style, { left: `${Math.round((W - bw) / 2)}px`, top: `${fits ? M : M + Math.max(E.obj.offsetHeight, E.res.offsetHeight) + 4 * this.u}px` });
      this.bossToast = (fits ? M : M + Math.max(E.obj.offsetHeight, E.res.offsetHeight) + 4 * this.u) + E.bb.offsetHeight + 6 * this.u;
    }
    // town names under their markers, on whole pixels (measured, so only while the big map is open)
    if (this.mapOpen) {
      w.towns.forEach((t, k) => {
        const l = E[`tl${k}`];
        if (l) Object.assign(l.style, { left: `${Math.round((t.cx / 4) * z - l.offsetWidth / 2)}px`, top: `${Math.round((t.cy / 4 + 5) * z)}px` });
      });
    }
  }

  // ---------- per update ----------
  /** Called every game update. Only changed text/classes are written; the minimap overlay redraws every 3rd update. */
  update(w: World, cam: Camera | null, show: boolean): void {
    this.cls(this.root, 'off', !show);
    if (w !== this.world) {
      this.world = w;
      this.buildKey = '';
      this.target = null;
      this.radioQ = [];
      this.radioT = -1;
      this.radioCur = null;
      this.mapOpen = false;
    }
    if (!show) return;
    this.frame++;
    const W = innerWidth;
    const H = innerHeight;
    this.u = uiPixel(W, H);
    const bk = `${this.u}|${w.nPlayers}|${w.towns.length}|${w.region?.depots?.length ?? 0}|${w.towns.map((t) => t.name).join()}|${w.boss?.hudKey ?? ''}`; // Phase 4: a staged boss swaps its bar
    if (bk !== this.buildKey) {
      this.buildKey = bk;
      this.build(w);
    }
    this.updateObjectives(w, cam);
    this.updateResources(w);
    for (let i = 0; i < w.nPlayers; i++) this.updateCard(w, i);
    this.updateAbilities(w);
    const pk = `${W}|${H}`;
    if (pk !== this.placeKey) {
      this.placeKey = pk;
      this.place(w);
    }
    this.updateRadio();
    this.updateBoss(w);
    if (this.mapOpen) this.toastTop = this.toastClearOfMap(this.toastTop);
    this.drawMaps(w, cam);
  }

  /** With the big map open, toasts ("BOSS LOCATED") must not sit on its title bar: above the map panel if they fit
   * there, else below it, else just inside it under the title bar. */
  private toastClearOfMap(top: number): number {
    const plate = this.el.map?.firstElementChild as HTMLElement | null;
    const hdr = plate?.querySelector<HTMLElement>('.cp-hdr');
    if (!plate || !hdr) return top;
    const r = plate.getBoundingClientRect();
    const th = 40; // one toast: 3x font plus padding and border, in CSS px
    if (top + th <= r.top) return top;
    const below = Math.round(r.bottom + 3 * this.u);
    const cl = this.el.cl?.getBoundingClientRect();
    if (cl && below + th <= cl.top) return below;
    return Math.round(hdr.getBoundingClientRect().bottom + 3 * this.u);
  }

  /** Phase 4: the boss bar: shown while the boss is near or fighting; one lit segment per hp left. */
  private updateBoss(w: World): void {
    const b = w.boss;
    const E = this.el;
    if (!b || !E.bb) return;
    const show = b.hudShown();
    this.cls(E.bb, 'gone', !show);
    this.toastTop = show ? Math.max(this.toastBase, this.bossToast) : this.toastBase;
    if (!show) return;
    b.parts.forEach((p, k) => {
      const segs = E[`bs${k}`];
      if (!segs) return;
      const low = p.hp > 0 && p.hp <= Math.ceil(p.max / 3);
      const hit = p.hitT > 0 && (this.frame & 2) > 0;
      segs.querySelectorAll('i').forEach((s, i) => {
        const c = i < p.hp ? (hit ? 'on flash' : low ? 'on warn' : 'on') : '';
        if (s.className !== c) s.className = c;
      });
      this.cls(E[`bp${k}`], 'cp-dead', p.hp <= 0);
    });
    // the lock goes once the turret can be hurt by shells (a skirt is down)
    if (E.bLock) E.bLock.style.visibility = b.exposed() || b.turret.hp <= 0 ? 'hidden' : 'visible';
  }

  private nearestTown(w: World, cam: Camera | null): TownState | null {
    const p = w.players.find((t) => t && t.alive);
    const x = p ? p.cx : cam ? cam.x + cam.viewW / 2 : w.pxW / 2;
    const y = p ? p.cy : cam ? cam.y + cam.viewH / 2 : w.pxH / 2;
    let best: TownState | null = null;
    let bd = Infinity;
    for (const t of w.towns) {
      if (t.freed) continue;
      const d = Math.hypot(t.cx - x, t.cy - y);
      if (d < bd) { bd = d; best = t; }
    }
    // stick with the current target until it's freed: driving past another village doesn't steal it, only driving
    // into one does (the player chose to go there)
    const cur = this.target;
    if (cur && !cur.freed && w.towns.includes(cur)) {
      const inside = w.towns.find((t) => !t.freed && t !== cur && x >= t.rect[0] && y >= t.rect[1] && x < t.rect[0] + t.rect[2] && y < t.rect[1] + t.rect[3]);
      return inside ?? cur;
    }
    return best;
  }

  private updateObjectives(w: World, cam: Camera | null): void {
    const E = this.el;
    const sm = 2;
    const md = this.u;
    const live = (e: Tank) => e.alive;
    if (!w.towns.length) {
      // old test region without towns: explore and clear it
      const left = w.queue.length + w.enemies.filter(live).length;
      this.setT(E.goal, w.arena ? 'TRICKS ARENA' : 'EXPLORE', md, 'c-gold');
      this.setT(E.goalSub, w.arena ? 'TRY ABILITIES 1-4' : `${left} TANK${left === 1 ? '' : 'S'} LEFT`, sm, 'c-ink');
      this.cls(E.ring, 'cp-none', true);
    } else {
      // pips: freed towns first (gold), then the ones still held (grey)
      const freed = w.towns.filter((t) => t.freed).length;
      w.towns.forEach((_, k) => this.setSrc(E[`pip${k}`], iconArt('house', k < freed ? undefined : { g: 'd', w: 'y' })));
      const t = (this.target = this.nearestTown(w, cam));
      const boss = w.boss;
      if (boss?.alive && (!t || boss.state === 'hunt')) {
        // Phase 4: every town free (or the boss is on the move): the boss is the objective
        this.setT(E.goal, `DESTROY ${boss.name}`, md, 'c-red');
        this.setT(E.goalSub, `${boss.title} · ${boss.turret.short} ${boss.turret.hp}/${boss.turret.max}`, sm, 'c-ink');
        this.cls(E.ring, 'cp-none', false);
        this.setSrc(E.ring, ringArt(9, 1 - boss.turret.hp / boss.turret.max));
      } else if (t) {
        const [rx, ry, rw, rh] = t.rect;
        let n = 0;
        for (const e of w.enemies) if (e.alive && e.cx >= rx && e.cx < rx + rw && e.cy >= ry && e.cy < ry + rh) n++;
        const pct = Math.max(0, Math.min(100, Math.round(t.progress * 100)));
        this.setT(E.goal, `FREE ${t.name}`, md, 'c-gold');
        this.setT(E.goalSub, `${pct}% · ${n} TANK${n === 1 ? '' : 'S'} LEFT`, sm, 'c-ink');
        this.cls(E.ring, 'cp-none', false);
        this.setSrc(E.ring, ringArt(9, pct / 100));
      } else {
        this.setT(E.goal, 'ALL TOWNS FREE', md, 'c-gold');
        this.setT(E.goalSub, boss && boss.state !== 'dead' ? `${boss.name} IS BURNING` : 'REGION CLEAR', sm, 'c-ink');
        this.cls(E.ring, 'cp-none', true);
      }
      // Phase 4: the boss line: locked until enough towns are free, then its name (red), then gold once destroyed
      if (boss && E.boss) {
        const left = boss.townsToReveal();
        const dead = boss.state === 'dying' || boss.state === 'dead';
        const text = !boss.revealed ? `BOSS · FREE ${left} MORE TOWN${left === 1 ? '' : 'S'}` : dead ? `BOSS · ${boss.name} DESTROYED` : `BOSS · ${boss.name}`;
        this.setT(E.boss, text, sm, !boss.revealed ? 'c-dim' : dead ? 'c-gold' : 'c-red');
        const ic = !boss.revealed ? iconArt('lock') : iconArt('skull');
        this.setSrc(E.bossIc, ic);
        E.bossIc.style.opacity = boss.revealed ? '1' : '.6';
      }
      // depots: optional targets, gold once all are down
      const nd = w.depots.length || (w.region?.depots?.length ?? 0);
      if (nd) {
        const down = w.depots.filter((d) => d.destroyed).length;
        this.setT(E.dep, `DEPOTS ${down}/${nd}`, sm, down >= nd ? 'c-gold' : 'c-ink');
        this.setSrc(E.depIc, iconArt('diamond', down >= nd ? undefined : { g: 'm', h: 'l', o: 'd' }));
      }
      // big-map labels follow the towns' colours
      w.towns.forEach((tw, k) => this.setT(E[`tl${k}`], tw.name, 2, tw.freed ? 'c-gold' : 'c-ink'));
    }
  }

  private updateResources(w: World): void {
    const lg = this.u + 1;
    this.setT(this.el.scrap, String(w.scrap), lg, 'c-ink');
    this.setT(this.el.parts, String(w.partsFound), lg, 'c-ink');
  }

  /** the last armour maximum seen per player (shown while the tank is knocked out) */
  private lastMax = [0, 0];

  private updateCard(w: World, i: number): void {
    const E = this.el;
    const t = w.players[i];
    const ps = w.ps[i];
    const out = !t || !t.alive;
    this.cls(E[`card${i}`], 'cp-out', out);
    const tank = E[`tank${i}`] as HTMLImageElement;
    // campaign looks: the card shows BABUSYA / DIDO with the parts fitted (src/art/campaign-tanks.ts)
    const tk = t ? `${JSON.stringify(t.fitted)}|${t.vet}` : tank.dataset.v ?? '';
    if (tank.dataset.v !== tk || !tank.src) {
      tank.dataset.v = tk;
      tank.src = babusyaURL(i, t?.fitted ?? {}, t?.vet ?? ps.vet ?? 0);
    }
    // knocked out (no tank, e.g. through the retreat fade): keep the last maximum instead of showing 0/0
    const max = t?.armourMax || this.lastMax[i] || 0;
    if (t?.armourMax) this.lastMax[i] = t.armourMax;
    const arm = t ? t.armour : 0;
    // segments: one per point of armour (10 while the rules don't set a maximum yet)
    const n = max || 10;
    const segs = E[`arm${i}`];
    if (segs.dataset.n !== String(n)) {
      segs.dataset.n = String(n);
      segs.innerHTML = this.segs(n, n > 12 ? 3 : 4, 5, i ? 'green' : '', '');
      segs.dataset.on = '';
      this.placeKey = ''; // the cluster changed width: re-centre it
    }
    const low = max > 0 && arm <= Math.max(1, Math.floor(max * 0.3));
    const on = `${arm}|${low}`;
    if (segs.dataset.on !== on) {
      segs.dataset.on = on;
      segs.querySelectorAll('i').forEach((s, k) => { s.className = k < arm ? (low ? 'on warn' : 'on') : ''; });
    }
    const armT = `${arm}/${max}`;
    const armN = E[`armN${i}`];
    // a different number of digits changes the cluster's width: re-centre it (rare)
    if (armN.dataset.t?.split('|')[0].length !== armT.length) this.placeKey = '';
    this.setT(armN, armT, this.u, low ? 'c-red' : 'c-ink');
    const vet = t ? t.vet : 0;
    for (let k = 0; k < 3; k++) this.setSrc(E[`chev${i}${k}`], iconArt('chev', k < vet ? undefined : { g: 'd', h: 'm', o: 'y' }));
    // spare lives: knocked out with none left ends the run, so say so plainly
    const lives = w.ps[i]?.out ? 0 : (w.ps[i]?.lives ?? 0);
    this.setT(E[`lives${i}`], lives > 0 ? `LIVES ${lives}` : 'LAST LIFE', 2, lives > 0 ? 'c-dim' : 'c-red');
    const xp = Math.round(Math.max(0, Math.min(1, t ? t.vetXp : 0)) * 12);
    const xs = E[`xp${i}`];
    if (xs && xs.dataset.on !== String(xp)) {
      xs.dataset.on = String(xp);
      xs.querySelectorAll('i').forEach((s, k) => { s.className = k < xp ? 'on' : ''; });
    }
  }

  private updateAbilities(w: World): void {
    const E = this.el;
    const two = w.nPlayers === 2;
    // patch cooldown (per player): wipe height in HUD pixels of the 24 inside the well, and whole seconds left
    const wipe: number[] = [];
    const waitS = Math.ceil(w.patchWait(0) / 60);
    for (let p = 0; p < (two ? 2 : 1); p++) {
      wipe.push(Math.ceil((w.patchWait(p) / PATCH_COOLDOWN) * 24));
      const cd = E[`cd${p}`];
      if (cd && cd.dataset.h !== String(wipe[p])) {
        cd.dataset.h = String(wipe[p]);
        cd.style.height = this.px(wipe[p]);
        cd.style.display = wipe[p] > 0 ? '' : 'none';
      }
    }
    // the slot greys while no player who is on the field can patch yet
    const cooling = wipe.length > 0 && wipe.every((h, p) => h > 0 || !w.players[p]) && wipe.some((h) => h > 0);
    for (let k = 0; k < 4; k++) {
      const n = w.charges[k] ?? 0;
      const patchCost = k === 3 && n <= 0 && w.scrap >= PATCH_COST;
      const wait = k === 3 && cooling && !two;
      const ready = (n > 0 || patchCost) && !(k === 3 && cooling);
      const st = `${n}|${patchCost}|${ready}|${wait ? waitS : ''}`;
      const ab = E[`ab${k}`];
      if (ab.dataset.s === st) continue;
      ab.dataset.s = st;
      this.cls(ab, 'dim', !ready);
      this.cls(E[`btn${k}`], two ? 'ready0' : 'ready1', ready);
      // solo, cooling: seconds until the next patch; else the charges, or the scrap a patch costs without one
      if (wait) this.setT(E[`cnt${k}`], `${waitS}S`, 2, 'c-dim');
      else this.setT(E[`cnt${k}`], patchCost ? `-${PATCH_COST}` : `x${n}`, 2, n > 0 || patchCost ? 'c-ink' : 'c-red');
      this.setT(E[`lab${k}`], ABIL[k].label, 2, ready ? 'c-ink' : 'c-dim');
    }
  }

  // ---------- radio ----------
  /**
   * Queue a line of radio chatter; each is typed out, then fades after RADIO_HOLD s. HQ, boss and crew lines are never
   * dropped and go ahead of ambient chatter (m.amb: enemy intercepts), which keeps only its newest RADIO_AMB_KEEP lines.
   */
  radio(m: RadioMsg): void {
    const q = this.radioQ;
    if (m.amb) {
      q.push(m);
      let n = q.filter((x) => x.amb).length;
      for (; n > RADIO_AMB_KEEP; n--) q.splice(q.findIndex((x) => x.amb), 1);
    } else {
      const i = q.findIndex((x) => x.amb);
      q.splice(i < 0 ? q.length : i, 0, m);
    }
    if (this.radioT < 0 || this.radioT > this.typed() + this.radioGap()) this.nextRadio();
  }

  private typed(): number { return this.radioLen / TYPE_CPS; }
  /** pause after a typed line before the next: short when an ambient line holds up an important one */
  private radioGap(): number { return this.radioCur?.amb && this.radioQ.length && !this.radioQ[0].amb ? 0.6 : 2.5; }

  private nextRadio(): void {
    const m = this.radioQ.shift();
    if (!m) return;
    this.showRadio(m, 0);
    this.onLine?.();
  }

  private showRadio(m: RadioMsg, t: number): void {
    const E = this.el;
    this.radioCur = m;
    this.radioT = t;
    this.lastTime = performance.now();
    if (!E.rd) return;
    const who = m.who.toUpperCase();
    this.setSrc(E.face, faceArt(who));
    // a long name (INTERCEPT) drops the channel tag so the header fits the panel; a longer one drops a font size
    const fits = () => !E.whoRow || E.whoRow.scrollWidth <= E.whoRow.clientWidth;
    this.cls(E.ch, 'cp-none', false);
    this.setT(E.who, who, this.u, 'c-gold');
    if (!fits()) this.cls(E.ch, 'cp-none', true);
    if (!fits()) this.setT(E.who, who, 2, 'c-gold');
    E.msg.innerHTML = this.para(m.text.toUpperCase(), 2, 'c-ink');
    E.msg.classList.add('cp-typing');
    this.radioGlyphs = [...E.msg.querySelectorAll<HTMLElement>('i')];
    this.radioLen = this.radioGlyphs.length;
    this.radioShown = 0;
    this.cls(E.rd, 'gone', false);
  }

  private updateRadio(): void {
    if (this.radioT < 0) return;
    const now = performance.now();
    this.radioT += Math.min(0.1, (now - this.lastTime) / 1000);
    this.lastTime = now;
    const n = Math.min(this.radioLen, Math.floor(this.radioT * TYPE_CPS));
    while (this.radioShown < n) this.radioGlyphs[this.radioShown++].classList.add('on');
    const done = this.typed();
    if (this.radioQ.length && this.radioT > done + this.radioGap()) this.nextRadio();
    else if (this.radioT > done + RADIO_HOLD) {
      this.radioT = -1;
      this.radioCur = null;
      this.cls(this.el.rd, 'gone', true);
    }
  }

  // ---------- maps ----------
  toggleMap(): void {
    this.mapOpen = !this.mapOpen;
    this.cls(this.el.map, 'off', !this.mapOpen);
    if (this.big) this.big.key = '';
    this.placeKey = '';
  }

  closeMap(): void {
    if (this.mapOpen) this.toggleMap();
  }

  get mapIsOpen(): boolean { return this.mapOpen; }

  private drawMaps(w: World, cam: Camera | null): void {
    const views = this.mapOpen ? [this.mini!, this.big!] : [this.mini!];
    for (const v of views) {
      // terrain: only when the map or a town's owner changed, and at most every 10 updates
      const key = `${w.map.version}|${w.towns.map((t) => (t.freed ? 1 : 0)).join('')}`;
      if (v.key !== key && (v.key === '' || this.frame % 10 === 0)) {
        v.key = key;
        this.drawTerrain(v, w);
      }
      if (this.frame % 3 === 0 || v.dots.length === 0) this.drawDots(v, w, cam, v === this.big);
    }
  }

  private drawTerrain(v: MapView, w: World): void {
    const { base, k } = v;
    const n = base.width;
    const m = base.height;
    const map = w.map;
    // sectors: each map pixel belongs to its nearest town (tinted red while held, gold once freed)
    if (w.towns.length && (!v.sector || v.sector.length !== n * m)) {
      v.sector = new Int16Array(n * m);
      for (let y = 0; y < m; y++) for (let x = 0; x < n; x++) {
        const cx = (x + 0.5) * k * 4;
        const cy = (y + 0.5) * k * 4;
        let bi = 0;
        let bd = Infinity;
        w.towns.forEach((t, i) => { const d = (t.cx - cx) ** 2 + (t.cy - cy) ** 2; if (d < bd) { bd = d; bi = i; } });
        v.sector[y * n + x] = bi;
      }
    }
    const g = base.getContext('2d')!;
    const img = g.createImageData(n, m);
    const D = img.data;
    const cnt = new Float32Array(8);
    for (let y = 0; y < m; y++) {
      const y0 = Math.floor(y * k);
      const y1 = Math.max(y0 + 1, Math.min(map.h, Math.floor((y + 1) * k)));
      for (let x = 0; x < n; x++) {
        const x0 = Math.floor(x * k);
        const x1 = Math.max(x0 + 1, Math.min(map.w, Math.floor((x + 1) * k)));
        let t = 0;
        if (k <= 1) t = map.c[y0 * map.w + x0];
        else {
          // the block's main type; open ground counts half so thin hedges and walls still show
          cnt.fill(0);
          for (let yy = y0; yy < y1; yy++) for (let xx = x0; xx < x1; xx++) cnt[map.c[yy * map.w + xx] & 7] += 1;
          cnt[0] *= 0.5;
          let bv = -1;
          for (let q = 0; q < 8; q++) if (cnt[q] > bv && TER[q]) { bv = cnt[q]; t = q; }
        }
        let col = TER[t] ?? TER[0];
        if (v.sector) {
          const tw = w.towns[v.sector[y * n + x]];
          col = tw.freed ? mixc(col, TINT_FREE, 0.16) : mixc(col, TINT_HELD, 0.14);
          // dotted sector borders
          const s = v.sector[y * n + x];
          const edge = (x + 1 < n && v.sector[y * n + x + 1] !== s) || (y + 1 < m && v.sector[(y + 1) * n + x] !== s);
          if (edge && (x + y) % 2 === 0) col = [198, 204, 212];
        }
        const o = (y * n + x) * 4;
        D[o] = col[0];
        D[o + 1] = col[1];
        D[o + 2] = col[2];
        D[o + 3] = 255;
      }
    }
    g.putImageData(img, 0, 0);
  }

  private drawDots(v: MapView, w: World, cam: Camera | null, big: boolean): void {
    const g = v.over.getContext('2d')!;
    const s = 1 / (4 * v.k); // world px -> map px
    const dots: number[] = [];
    g.clearRect(0, 0, v.over.width, v.over.height);
    const mark = (wx: number, wy: number, size: number, col: string, ring = true) => {
      const x = Math.round(wx * s);
      const y = Math.round(wy * s);
      const h = size >> 1;
      if (ring) {
        g.fillStyle = '#0b0c0e';
        g.fillRect(x - h - 1, y - h - 1, size + 2, size + 2);
      }
      g.fillStyle = col;
      g.fillRect(x - h, y - h, size, size);
      dots.push(x, y);
    };
    for (const t of w.towns) mark(t.cx, t.cy, big ? 7 : 3, t.freed ? '#f8b800' : '#f0482a');
    const depotMarks = w.depots.length ? w.depots : (w.region?.depots ?? []).map((d) => ({ ...d, destroyed: false }));
    for (const d of depotMarks) {
      // depots: a red X while standing, a dark one once destroyed
      const x = Math.round(d.cx * s);
      const y = Math.round(d.cy * s);
      const r = big ? 3 : 2;
      g.fillStyle = d.destroyed ? '#4a4f58' : '#f0482a';
      for (let i = -r; i <= r; i++) { g.fillRect(x + i, y + i, 1, 1); g.fillRect(x + i, y - i, 1, 1); }
    }
    const boss = w.boss;
    if (boss && !boss.present && w.lairKnown) {
      // the briefing's ASK FIRST answer: the lair as a dashed red ring with a "?" (big map) before the boss shows
      const L = (boss as { lair?: [number, number] }).lair;
      const x = Math.round((L ? L[0] + 24 : boss.cx) * s);
      const y = Math.round((L ? L[1] + 24 : boss.cy) * s);
      const r = big ? 9 : 4;
      const n = big ? 64 : 28;
      const pts: number[] = [];
      for (let a = 0; a < n; a++) {
        if ((a >> 2) % 2) continue; // dashes
        const t = (a / n) * Math.PI * 2;
        pts.push(Math.round(x + Math.cos(t) * r), Math.round(y + Math.sin(t) * r));
      }
      g.fillStyle = '#0b0c0e';
      for (let i = 0; i < pts.length; i += 2) g.fillRect(pts[i] - 1, pts[i + 1] - 1, 3, 3);
      g.fillStyle = '#f0482a';
      for (let i = 0; i < pts.length; i += 2) g.fillRect(pts[i], pts[i + 1], 1, 1);
      if (big) {
        // a 3x5 "?"
        const Q = ['111', '001', '011', '000', '010'];
        g.fillStyle = '#0b0c0e';
        g.fillRect(x - 2, y - 3, 5, 7);
        g.fillStyle = '#ffe08a';
        Q.forEach((row, j) => { for (let i = 0; i < 3; i++) if (row[i] === '1') g.fillRect(x - 1 + i, y - 2 + j, 1, 1); });
      }
      dots.push(x, y);
    }
    if (boss?.present) {
      // Phase 4: the boss: a red crosshair ring (blinking while it hunts), dark once it is a wreck
      const x = Math.round(boss.cx * s);
      const y = Math.round(boss.cy * s);
      const r = big ? 6 : 3;
      const dead = boss.state === 'dead';
      const on = dead || boss.state !== 'hunt' || (this.frame >> 3) % 3 !== 0;
      if (on) {
        g.fillStyle = '#0b0c0e';
        g.fillRect(x - r - 1, y - 1, 2 * r + 3, 3);
        g.fillRect(x - 1, y - r - 1, 3, 2 * r + 3);
        g.fillStyle = dead ? '#4a4f58' : '#f0482a';
        for (let i = -r; i <= r; i++) {
          if (Math.abs(i) < 2) continue;
          g.fillRect(x + i, y, 1, 1);
          g.fillRect(x, y + i, 1, 1);
        }
        for (let a = 0; a < 24; a++) {
          const t = (a / 24) * Math.PI * 2;
          g.fillRect(Math.round(x + Math.cos(t) * (r - 1)), Math.round(y + Math.sin(t) * (r - 1)), 1, 1);
        }
        g.fillStyle = dead ? '#8a919b' : '#ffe08a';
        g.fillRect(x, y, 1, 1);
      }
      dots.push(x, y);
    }
    w.events?.drawMap(g, s, big, this.frame); // Phase 5 events hook: "!" markers, objective targets, revealed tanks
    const pl = w.livePlayers();
    const recon = (w.abil?.reconUntil ?? 0) > w.frame; // Phase 3: a recon drone up shows every enemy
    for (const e of w.enemies) {
      if (!e.alive || e.spawn > 0) continue;
      const seen = recon || pl.some((p) => Math.hypot(p.cx - e.cx, p.cy - e.cy) < SIGHT) || (cam ? cam.sees(e.x, e.y, 16, 16, 0) : false);
      if (seen) mark(e.cx, e.cy, big ? 3 : 2, '#f0482a', big);
    }
    if (cam) {
      // the camera view
      const x = Math.round(cam.x * s);
      const y = Math.round(cam.y * s);
      const rw = Math.round(cam.viewW * s);
      const rh = Math.round(cam.viewH * s);
      g.fillStyle = '#f4efe2';
      g.fillRect(x, y, rw + 1, 1);
      g.fillRect(x, y + rh, rw + 1, 1);
      g.fillRect(x, y, 1, rh + 1);
      g.fillRect(x + rw, y, 1, rh + 1);
    }
    w.players.forEach((p, i) => { if (p && p.alive) mark(p.cx, p.cy, big ? 4 : 2, i ? '#7cd83a' : '#ffe08a'); });
    v.dots = dots.length ? dots : [0];
  }
}

/** A player's campaign tank (16 x 16, fitted parts on) as an image URL, cached by its looks. */
const babURLs = new Map<string, string>();
function babusyaURL(player: number, fitted: Partial<Record<string, string>>, vet: number): string {
  const key = `${player}|${JSON.stringify(fitted)}|${vet}`;
  let url = babURLs.get(key);
  if (!url) {
    const c = document.createElement('canvas');
    c.width = 16;
    c.height = 16;
    const g = c.getContext('2d')!;
    const img = g.createImageData(16, 16);
    img.data.set(babusyaRGBA(player, fitted, vet));
    g.putImageData(img, 0, 0);
    url = c.toDataURL();
    babURLs.set(key, url);
  }
  return url;
}
