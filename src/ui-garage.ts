// Camp screen: the garage (fit, strip, repair, craft), the CREW roster (Phase 3) and the MAP (Phase 5, ui-campmap.ts); and the
// recruit card a freed town shows when someone wants to join (openRecruit).
// Built from the approved mockups (mockups/campaign-ui/src/garage.html, crew.html, briefing.html, common.css,
// common.js) on the same "UI pixel" grid as the campaign HUD (--u: 3 screen px at 1080p, 2 at 720p), drawn in the
// game's 5x7 font.
// The screen works on a copy of the run and hands it back through onClose; the run flow pauses the game while it
// is open (campOpen()) and applies the loadouts afterwards (parts.ts applyLoadout).
// While open it swallows key presses (capture phase) so the game underneath doesn't see them, and polls gamepads.
import { babusyaRGBA } from './art/campaign-tanks'; // campaign looks: the paper doll shows the fitted parts
import { FONT } from './art/font';
import {
  ABILITY_ICONS, ABILITY_NAMES, MAX_LV, SPANNER_PATCH_BONUS, aboard, allCrew, canLevel, craftCost, crewById, crewUnlocks, levelUp,
  meetLines, perkVal, repairCost, roster, starterCrew, xpNext, type CrewMember,
} from './game/crew';
import { BASE_ARMOUR, STAT_KEYS, STAT_NAMES, loadoutStats, partById, statDiff, statLines, tankNumbers } from './game/parts';
import type { Loadout, PartDef, PartStats, RunState, Slot } from './game/run';
import { PATCH_ARMOUR } from './game/world';
import { radioFace, uiPixel } from './ui-campaign';
import { campMapFromSpec, renderMapTab, type CampMap } from './ui-campmap'; // Phase 5 MAP tab
import { campaignRegion } from './game/save';
import './ui-garage.css';

export interface CampResult { run: RunState; armour: [number, number][] }
export interface CampOpts {
  run: RunState;
  /** 1 or 2: co-op shows the P1/P2 toggle */
  players: number;
  /** camp name in the header, e.g. "VYSHNEVE WORKSHOP" */
  place: string;
  /** per player [current, max] armour */
  armour: [number, number][];
  onClose: (result: CampResult) => void;
  /** the tab to open on (0 garage, 1 crew, 2 map) */
  tab?: number;
  /** Phase 5 MAP tab: the region being played (a workshop) or the next one (between regions); default: the run's */
  map?: CampMap | null;
}

/** Workshop prices before crew perks (crew.ts repairCost / craftCost): a repair is +REPAIR_STEP armour for
 * REPAIR_COST scrap; a patch charge costs PATCH_CRAFT_COST. */
export const REPAIR_COST = 15;
export const REPAIR_STEP = 3;
export const PATCH_CRAFT_COST = 20;

// ---------- pixel text (the masked-glyph approach of ui.ts PixelText) ----------
const CHARS = Object.keys(FONT);
const IDX = new Map(CHARS.map((c, i) => [c, i]));
const madeScales = new Set<number>();
let fontStyle: HTMLStyleElement | null = null;

function ensureScale(s: number): void {
  if (madeScales.has(s)) return;
  madeScales.add(s);
  if (!fontStyle) {
    fontStyle = document.createElement('style');
    document.head.appendChild(fontStyle);
  }
  const c = document.createElement('canvas');
  c.width = CHARS.length * 6 * s;
  c.height = 8 * s;
  const g = c.getContext('2d')!;
  g.fillStyle = '#fff';
  CHARS.forEach((ch, i) => FONT[ch].forEach((row, y) => row.forEach((on, x) => { if (on) g.fillRect((i * 6 + x) * s, y * s, s, s); })));
  const url = c.toDataURL();
  const size = `${c.width}px ${c.height}px`;
  fontStyle.textContent += `#gx .px.s${s} i{width:${6 * s}px;height:${8 * s}px;-webkit-mask-image:url(${url});mask-image:url(${url});`
    + `-webkit-mask-size:${size};mask-size:${size}}#gx .px.s${s} i.sp{width:${4 * s}px;background:none}\n`;
}

/** One line of pixel text at glyph scale s. */
export function T(text: string, s: number, cls = ''): string {
  ensureScale(s);
  let out = `<span class="px s${s} ${cls}">`;
  for (const c0 of text) {
    const c = c0 === 'x' ? c0 : c0.toUpperCase();
    const i = IDX.get(c);
    if (c === ' ' || i === undefined) out += '<i class="sp"></i>';
    else out += `<i style="-webkit-mask-position:-${i * 6 * s}px 0;mask-position:-${i * 6 * s}px 0"></i>`;
  }
  return `${out}</span>`;
}
/** Wrapped paragraph: one span per word, word gap = one space, line gap = 3 glyph px. */
export function P(text: string, s: number, cls = ''): string {
  return `<div class="gx-para" style="column-gap:${4 * s}px;row-gap:${3 * s}px">${text.split(' ').filter(Boolean).map((w) => T(w, s, cls)).join('')}</div>`;
}

// ---------- pixel art (ported from mockups/campaign-ui/src/common.js) ----------
export const PAL: Record<string, string> = {
  k: '#0b0c0e', w: '#f4efe2', l: '#c6ccd4', m: '#8a919b', d: '#4a4f58', y: '#2b2f36', z: '#1c1f24',
  g: '#f8b800', h: '#ffe08a', o: '#c87000', R: '#983000',
  r: '#f0482a', q: '#7a1a10', G: '#7cd83a', n: '#3a8a10', N: '#1f4a10',
  b: '#6c9cff', B: '#3050c0', c: '#a8e0ff',
};

export class Art {
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
/** The diagonal hazard stripes of plate headers: steel, and gold for the selected crew card. */
export function setHazards(el: HTMLElement): void {
  const stripe = ['yyzzzzyy', 'yzzzzyyy', 'zzzzyyyy', 'zzzyyyyz', 'zzyyyyzz', 'zyyyyzzz', 'yyyyzzzz', 'yyyzzzzy'];
  el.style.setProperty('--hazard', `url(${fromRows(stripe, { y: '#30343b', z: '#272a30' }).url()})`);
  el.style.setProperty('--hazard-gold', `url(${fromRows(stripe, { y: '#4a3810', z: '#3a2c08' }).url()})`);
}

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
  armour: [
    '................', '................', '..kkkkkkkkkkkk..', '.kwllllllllllmk.', '.kldllllllldmmk.', '.kllllllllllmmk.',
    '.klllllRRllllmk.', '.kllllllRllllmk.', '.kllllllllllmmk.', '.kllllllllllmmk.', '.kllllllllllmmk.', '.kldllllllldmmk.',
    '.klmmmmmmmmmmmk.', '..kkkkkkkkkkkk..', '................', '................'],
  engine: [
    '................', '....kkkkkkkk....', '....khhhgggk....', '....kkkkkkkk....', '....kllllllk....', '....kkkkkkkk....',
    '....kllllmmk....', '....kllllmmk....', '....kkkkkkkk....', '......kmmk......', '.....kmllmk.....', '......kmmk......',
    '......kmmk......', '.....kmmmmk.....', '....kmmkkmmk....', '....kkk..kkk....'],
  barrel: [
    '................', '................', '................', '................', '................', '...........kkkk.',
    'kkkk.......kwlk.', 'kmdkkkkkkkkklmk.', 'kmdkwwwwwwwklmk.', 'kmdkllllllllkkk.', 'kmdkmmmmmmmklmk.', 'kmdkkkkkkkkklmk.',
    'kkkk.......kmmk.', '...........kkkk.', '................', '................'],
  tracks: [
    '................', '................', '................', '................', '..kkkkkkkkkkkk..', '.kmdmdmdmdmdmdk.',
    'kdkkkkkkkkkkkkdk', 'kmkwlkkwlkkwlkmk', 'kdklmkklmkklmkdk', 'kmkkkkkkkkkkkkmk', '.kdmdmdmdmdmdmk.', '..kkkkkkkkkkkk..',
    '................', '................', '................', '................'],
  jammer: [
    '................', '......kkkk......', '.k....krrk....k.', 'kbk...kkkk...kbk', 'kbk.k..dm..k.kbk', 'kbkkbk.dm.kbkkbk',
    'kbkkbk.dm.kbkkbk', 'kbk.k..dm..k.kbk', '.k.....dm.....k.', '......kmmk......', '.....kmllmk.....', '....kkkkkkkk....',
    '....kllllllk....', '....kdlrGldk....', '....kmmmmmmk....', '....kkkkkkkk....'],
  plough: [
    '................', '................', '................', '.kkkkkkkkkkkkkk.', 'kwllllllllllllmk', 'kmmmmmmmmmmmmmmk',
    'kkkkkkkkkkkkkkkk', '.kmk.kmk.kmk.kmk', '.kmk.kmk.kmk.kmk', '.kmk.kmk.kmk.kmk', '..k...k...k...k.', '................',
    '................', '................', '................', '................'],
  lock: [
    '....kkkk....', '...kmllmk...', '..kmk..kmk..', '..kmk..kmk..', '.kkkkkkkkkk.', '.kgghggggok.',
    '.kghgkkgook.', '.kgggkkgook.', '.kgggkkgook.', '.kgoooooook.', '.kkkkkkkkkk.'],
  chev: ['....k....', '...khk...', '..khghk..', '.khgogok.', 'kgok.kogk', 'kok...kok', 'kk.....kk'],
  signal: ['......kkk', '......kgk', '...kkkkgk', '...kgkkgk', 'kkkkgkkgk', 'kgkkgkkgk', 'kgkkgkkgk', 'kkkkkkkkk'],
  // Phase 5 camp MAP tab (mockups/campaign-ui/src/common.js)
  town: [
    '................', '...........kkk..', '.......kk..kdk..', '......khgk.kdk..', '.....khggokkdk..', '....khggggokdk..',
    '...khggggggok...', '..khggggggggok..', '.kkkkkkkkkkkkkk.', '..kwllkwwkllmk..', '..kwbbkwlkbbmk..', '..kwbbkwlkbbmk..',
    '..kwllkwdkllmk..', '..kwllkwdkllmk..', '..kkkkkkkkkkkk..', '................'],
  depot: [
    '................', '................', '..kkkkk.........', '.kmllmmk.kkkkk..', '.kkkkkkkkmllmmk.', '.kmlwmmkkkkkkkk.',
    '.kmlwmmkkmlwmmk.', '.kkkkkkkkmlwmmk.', '.kmlwmmkkkkkkkk.', '.kmlwmmkkmlwmmk.', '.kkkkkkkkmlwmmk.', '.kmlwmmkkkkkkkk.',
    '.kmllmmkkmlwmmk.', '..kkkkk.kmllmmk.', '.........kkkkk..', '................'],
  tank16: [
    '.......ll.......', '.......lm.......', '.......lm.......', '.dmmd..lm..dmmd.', '.mddmgghhggmddm.', '.dmmdghhhhgdmmd.',
    '.mddmghhhhgmddm.', '.dmmdghhhhgdmmd.', '.mddmggggggmddm.', '.dmmdggggogdmmd.', '.mddmgggoogmddm.', '.dmmdgggggogdmmd',
    '.mddmggggggmddm.', '.dmmdoooooodmmd.', '.mddm......mddm.', '................'],
};

const PROC: Record<string, () => Art> = {
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
};

const iconCache = new Map<string, Art>();
export function iconArt(name: string, remap?: Record<string, string>): Art {
  const key = name + JSON.stringify(remap ?? {});
  let a = iconCache.get(key);
  if (!a) {
    a = ICON_SRC[name] ? fromRows(ICON_SRC[name], remap ? Object.fromEntries(Object.entries(remap).map(([k, v]) => [k, PAL[v] ?? v])) : {}) : PROC[name]();
    iconCache.set(key, a);
  }
  return a;
}
/** greyed-out icon (empty slot, locked) */
const GREY = { l: 'd', w: 'm', m: 'y', d: 'y', g: 'd', h: 'd', o: 'y', b: 'd', B: 'y', r: 'd', G: 'd', n: 'y', N: 'y', c: 'd', R: 'y', q: 'y' };
const CHEV_OFF = { g: 'd', h: 'm', o: 'y' };

/** 32x32 top-down tank with the fitted parts bolted on (gold = P1, green = P2). */
const tankCache = new Map<string, Art>();
export function tankArt(parts: Partial<Record<Slot, boolean>>, colour: 'gold' | 'green'): Art {
  const key = `${colour}|${Object.keys(parts).filter((k) => parts[k as Slot]).sort().join()}`;
  const hit = tankCache.get(key);
  if (hit) return hit;
  const C = colour === 'green' ? { b: PAL.G, h: '#c4f59a', s: PAL.n, d: PAL.N } : { b: PAL.g, h: PAL.h, s: PAL.o, d: PAL.R };
  const a = new Art(32, 32);
  const tw = parts.tracks ? 7 : 6;
  for (const sx of [9 - tw, 23]) {
    for (let y = 5; y <= 30; y++) {
      for (let x = sx; x < sx + tw; x++) {
        let c = y % 2 ? PAL.m : PAL.d;
        if (x === sx || x === sx + tw - 1) c = y % 2 ? PAL.d : PAL.y;
        if (y === 5 || y === 30) c = PAL.y;
        a.set(x, y, c);
      }
      if (parts.tracks && y % 3 === 0) { a.set(sx - 1, y, PAL.l); a.set(sx + tw, y, PAL.l); }
    }
  }
  for (let y = 8; y <= 28; y++) for (let x = 9; x <= 22; x++) {
    let c = C.b;
    if (y === 8 || x === 9) c = C.h;
    if (y === 28 || x === 22) c = C.s;
    a.set(x, y, c);
  }
  for (let y = 24; y <= 27; y++) for (let x = 11; x <= 20; x++) a.set(x, y, x % 2 ? C.s : C.d);
  if (parts.engine) {
    for (let y = 24; y <= 27; y++) for (let x = 11; x <= 20; x++) a.set(x, y, x % 2 ? PAL.m : PAL.y);
    a.rect(10, 28, 2, 3, PAL.l); a.set(10, 30, PAL.y); a.set(11, 30, PAL.y);
    a.rect(20, 28, 2, 3, PAL.l); a.set(20, 30, PAL.y); a.set(21, 30, PAL.y);
  }
  if (parts.armour) {
    a.rect(9, 8, 14, 3, PAL.l); a.rect(9, 10, 14, 1, PAL.m);
    for (const x of [10, 13, 18, 21]) a.set(x, 9, PAL.d);
    a.rect(9, 13, 2, 7, PAL.R); a.set(9, 14, PAL.d); a.set(9, 18, PAL.d);
    a.rect(21, 15, 2, 6, PAL.m); a.set(22, 16, PAL.d); a.set(22, 19, PAL.d);
  }
  a.ell(15.5, 17, 7, 6.6, PAL.k);
  a.ell(15.5, 17, 6, 5.6, C.b, (_x, _y, dx, dy) => (dx + dy < -0.6 ? C.h : dx + dy > 0.6 ? C.s : C.b));
  a.ell(18, 19.5, 1.7, 1.7, C.d); a.set(17, 19, C.s);
  if (parts.plough) {
    a.rect(3, 3, 26, 2, PAL.m); a.rect(3, 3, 26, 1, PAL.l);
    for (let x = 3; x <= 28; x += 3) { a.set(x, 1, PAL.m); a.set(x, 2, PAL.m); }
  }
  const top = parts.barrel ? 0 : 3;
  for (let y = top; y <= 12; y++) { a.set(15, y, PAL.l); a.set(16, y, PAL.m); }
  if (parts.barrel) { a.rect(14, 0, 4, 2, PAL.m); a.rect(14, 0, 4, 1, PAL.l); a.rect(14, 6, 4, 2, PAL.m); a.set(14, 6, PAL.l); }
  if (parts.jammer) {
    a.rect(19, 20, 3, 3, PAL.y); a.set(20, 21, PAL.r);
    a.line(21.5, 20.5, 26, 13, 0.4, PAL.k);
  }
  a.outline();
  tankCache.set(key, a);
  return a;
}

/** The tank as it drives (src/art/campaign-tanks.ts: hull, tracks, every fitted part, the flag, kill marks), doubled
 * to 32x32, for the garage's paper doll and the ready check. */
const dollCache = new Map<string, Art>();
export function babusyaDoll(loadout: Loadout, player: number, vet = 0): Art {
  const key = `${player}|${vet}|${Object.entries(loadout).filter(([, v]) => v).sort().join()}`;
  const hit = dollCache.get(key);
  if (hit) return hit;
  const px = babusyaRGBA(player, loadout as Partial<Record<string, string>>, vet);
  const hex = (i: number) => `#${[0, 1, 2].map((c) => px[i * 4 + c].toString(16).padStart(2, '0')).join('')}`;
  const a = new Art(32, 32);
  for (let y = 0; y < 16; y++) for (let x = 0; x < 16; x++) if (px[(y * 16 + x) * 4 + 3]) a.rect(x * 2, y * 2, 2, 2, hex(y * 16 + x));
  dollCache.set(key, a);
  return a;
}

/** Spanner, the mechanic (32x32, the same face as the HUD radio's). */
let spannerArt: Art | null = null;
function spanner(): Art {
  if (spannerArt) return spannerArt;
  const a = new Art(32, 32);
  const [sk, sm, sd] = ['#e8b088', '#c88a60', '#9a6040'];
  const hair = ['#5a3a1a', '#3a2410'];
  const cl = ['#3a5a8a', '#2a4066'];
  for (let y = 24; y < 32; y++) {
    const hw = Math.min(15, 8 + (y - 24) * 1.4);
    for (let x = 0; x < 32; x++) { const d = x + 0.5 - 16; if (Math.abs(d) <= hw) a.set(x, y, d > hw - 4 ? cl[1] : cl[0]); }
  }
  for (let y = 24; y < 29; y++) for (let x = 13; x <= 18; x++) if (Math.abs(x + 0.5 - 16) < (y - 23) * 0.8) a.set(x, y, '#c8b890');
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
  a.set(11, 14, '#ffffff'); a.set(12, 14, '#1a1410'); a.set(19, 14, '#1a1410'); a.set(20, 14, '#ffffff');
  a.set(11, 15, sm); a.set(12, 15, sm); a.set(19, 15, sm); a.set(20, 15, sm);
  a.rect(10, 12, 4, 1, hair[1]); a.rect(18, 12, 4, 1, hair[1]);
  a.set(16, 15, sm); a.set(16, 16, sm); a.set(15, 17, sd); a.set(16, 17, sd);
  a.rect(14, 19, 4, 1, '#8a3a2a');
  // knit beanie, stubble, grease smudge, overall straps
  for (let y = 2; y < 11; y++) for (let x = 7; x < 25; x++) {
    const dx = (x + 0.5 - 16) / 8.4;
    const dy = (y + 0.5 - 10) / 8;
    if (dx * dx + dy * dy <= 1) a.set(x, y, x % 2 ? '#c87000' : x < 13 ? '#f0a040' : '#983000');
  }
  a.rect(7, 9, 18, 3, '#983000'); a.rect(7, 9, 18, 1, '#c87000');
  a.rect(8, 12, 2, 3, hair[0]); a.rect(22, 12, 2, 3, hair[1]);
  for (let y = 17; y < 22; y++) for (let x = 9; x < 23; x++) if (a.get(x, y) && (x + y) % 2 === 0 && !(y === 19 && x >= 14 && x <= 17)) a.set(x, y, sd);
  a.set(20, 16, '#2b2f36'); a.set(21, 16, '#2b2f36'); a.set(20, 17, '#4a4f58');
  a.rect(11, 26, 2, 6, '#2a4066'); a.rect(19, 26, 2, 6, '#2a4066'); a.set(11, 27, '#c6ccd4'); a.set(20, 27, '#c6ccd4');
  a.outline();
  const out = new Art(32, 32);
  for (let y = 0; y < 32; y++) for (let x = 0; x < 32; x++) out.set(x, y, a.get(x, y) ?? (y < 22 ? '#3a2a20' : '#2c2018'));
  spannerArt = out;
  return out;
}

// ---------- garage data ----------
const TABS = ['GARAGE', 'CREW', 'MAP'];
const NAMES = ['BABUSYA', 'DIDO'];
const FLAVOUR = ['CAPTURED · NOW ON OUR SIDE', 'OLDER THAN MOST OF THE CREW'];
const LEFT: Slot[] = ['armour', 'tracks', 'engine'];
const RIGHT: Slot[] = ['barrel', 'jammer', 'plough'];
const SLOT_NAME: Record<Slot, string> = { armour: 'ARMOUR', engine: 'ENGINE', barrel: 'BARREL', tracks: 'TRACKS', jammer: 'DRONE JAMMER', plough: 'MINE PLOUGH' };
/** What a tank has in a slot with nothing fitted (jammer and plough have nothing). */
const STOCK: Partial<Record<Slot, [string, string]>> = {
  armour: ['BARE HULL', 'FACTORY STEEL. THIN, BUT IT IS OURS.'],
  engine: ['FACTORY DIESEL', 'STARTS ON THE THIRD TRY. EVERY TIME.'],
  barrel: ['OLD 100 MM', 'IT SHOOTS. THAT IS THE NICEST THING ANYONE HAS SAID ABOUT IT.'],
  tracks: ['FACTORY TRACKS', 'THE ORIGINAL TRACKS. SOME OF THE LINKS ARE ORIGINAL.'],
};
const FUTURE: Partial<Record<Slot, string>> = { jammer: 'WAITS FOR DRONES', plough: 'WAITS FOR MINES' };
/** where each slot's leader line lands on the 32x32 tank */
const AT: Record<Slot, [number, number]> = { armour: [8, 6], tracks: [3, 18], engine: [16, 27], barrel: [16, 3], jammer: [7, 22], plough: [27, 2] };
const CRAFT = [
  { icon: 'fpv', name: 'FPV DRONE', key: '1' },
  { icon: 'ambush', name: 'AMBUSH', key: '2' },
  { icon: 'recon', name: 'RECON', key: '3' },
  { icon: 'repair', name: 'PATCH', key: '4' },
];
/** Phase 3: what each craftable charge does (the summary panel while its button is focused). */
const CRAFT_INFO: [string, (cost: number, patch: number) => string][] = [
  ['CRAFTING AN FPV DRONE', (c) => `ABILITY 1: AIM, AND THE DRONE DIVES ON A TANK'S TOP ARMOUR. STRONG AGAINST ARMOURED TANKS. COSTS ${c} SCRAP HERE.`],
  ['CRAFTING AN AMBUSH', (c) => `ABILITY 2: AN ANTI-TANK SQUAD HIDES IN TREES OR RUINS AND FIRES WHEN ENEMIES PASS. COSTS ${c} SCRAP HERE.`],
  ['CRAFTING A RECON DRONE', (c) => `ABILITY 3: SHOWS HIDDEN ENEMIES, MINES AND AMBUSHES FOR A WHILE. COSTS ${c} SCRAP HERE.`],
  ['CRAFTING A PATCH CHARGE', (c, p) => `A PATCH KIT FOR THE ROAD: ABILITY 4 MENDS ${p} ARMOUR WITHOUT SPENDING SCRAP. COSTS ${c} SCRAP HERE.`],
];

const Q_HELLO = ['WHAT ARE WE BOLTING ON TODAY?', 'MIND THE OIL. AND THE CAT.', 'SHE HAS SEEN WORSE. SO HAVE I.'];
const Q_FIT = ['BOLTED ON. IF IT RATTLES, IT IS FINE.', 'ON IT GOES. THREE BOLTS AND A PRAYER.', 'FITS. MOSTLY. DO NOT TELL THE MAJOR.'];
const Q_OFF = ['OFF IT COMES. BACK IN THE BIN.', 'UNBOLTED. I WILL KEEP IT FOR LATER.'];
const Q_STRIP = ['GOOD STEEL. INTO THE SCRAP PILE.', 'CUT UP AND SORTED. WE EAT TONIGHT.', 'SCRAP IS SCRAP. I AM NOT CRYING.'];
const Q_REPAIR = ['WELDED SHUT. DO NOT KICK IT.', 'PATCHED. UGLIER, BUT STRONGER.', 'ANOTHER PLATE, ANOTHER PRAYER.'];
const Q_SHORT = 'WE ARE SHORT OF SCRAP. GO BREAK SOMETHING OF THEIRS.';
const Q_FULL = 'SHE IS AS PATCHED AS SHE GETS.';
const Q_CREW = [
  'NOBODY HERE CAN FLY ONE. FREE A FEW TOWNS: SOMEONE WILL TURN UP.',
  'AN AMBUSH NEEDS SOMEONE THE VOLUNTEERS LISTEN TO. THEY DO NOT LISTEN TO ME.',
  'NO SCOUT, NO RECON DRONE. I AM NOT CLIMBING A TREE.',
  'I FIX TANKS. FIND ME SOMEONE WHO KNOWS THAT TRICK.',
];
const Q_CRAFT = [
  'ONE FPV, HOT OFF THE GLUE GUN. WASP SAYS POINT IT AT SOMETHING RUDE.',
  'AUNTIE FOUND VOLUNTEERS. THEY BROUGHT SANDWICHES AND A ROCKET.',
  'ONE RECON DRONE. OWL HAS ALREADY NAMED IT. HE WILL NOT SAY WHAT.',
  'ONE PATCH KIT: TAPE, A PLATE AND STUBBORNNESS.',
];
const TANK_NAMES = ['BABUSYA', 'DIDO'];
const Q_NONE = 'NOTHING IN THE BIN FOR THAT. STRIP A FEW WRECKS.';

const clamp = (v: number, a: number, b: number) => Math.max(a, Math.min(b, v));
const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? '' : 'S'}`;

/** What a change of stats means in play (s = the change, after = the tank's stats with the part fitted). */
function effectText(part: PartDef, s: Required<PartStats>, after: Required<PartStats>): string {
  // firepower is the one with a rule behind it: say that alone
  if (s.firepower) return s.firepower > 0 ? (after.firepower >= 2 ? 'SHELLS GO THROUGH STEEL WALLS' : 'MORE DAMAGE TO ARMOURED TANKS') : after.firepower < 2 ? 'SHELLS STOP BREAKING STEEL' : 'WEAKER SHELLS';
  const out: string[] = [];
  if (s.armour) out.push(`${s.armour > 0 ? '+' : ''}${s.armour} MAX ARMOUR`);
  if (s.speed) out.push(`MOVES ${Math.abs(s.speed) * 8}% ${s.speed > 0 ? 'FASTER' : 'SLOWER'}`);
  if (s.reload) out.push(`RELOADS ${Math.abs(s.reload) * 10}% ${s.reload > 0 ? 'FASTER' : 'SLOWER'}`);
  if (out.length) return out.join(' · ');
  if (!Object.keys(part.stats).length) return part.slot === 'jammer' ? 'NO EFFECT UNTIL ENEMY DRONES ARRIVE' : part.slot === 'plough' ? 'NO EFFECT UNTIL MINEFIELDS ARRIVE' : 'NO CHANGE TO THE NUMBERS';
  return 'SAME AS WHAT IS FITTED NOW';
}

/** One sentence for a change of loadout: "HITS HARDER AND PUNCHES THROUGH STEEL, BUT RELOADS A LITTLE SLOWER." */
function changeText(a: Required<PartStats>, b: Required<PartStats>): string {
  const d = statDiff(a, b);
  const how = (n: number) => (Math.abs(n) === 1 ? 'A LITTLE ' : Math.abs(n) >= 3 ? 'MUCH ' : '');
  const gains: string[] = [];
  const losses: string[] = [];
  if (d.firepower > 0) gains.push(a.firepower < 2 && b.firepower >= 2 ? 'HITS HARDER AND PUNCHES THROUGH STEEL' : 'HITS HARDER');
  if (d.firepower < 0) losses.push(a.firepower >= 2 && b.firepower < 2 ? 'HITS SOFTER AND STOPS BREAKING STEEL' : 'HITS SOFTER');
  if (d.armour) (d.armour > 0 ? gains : losses).push(`TAKES ${Math.abs(d.armour)} ${d.armour > 0 ? 'MORE' : 'FEWER'} HIT${Math.abs(d.armour) === 1 ? '' : 'S'}`);
  if (d.speed) (d.speed > 0 ? gains : losses).push(`DRIVES ${how(d.speed)}${d.speed > 0 ? 'FASTER' : 'SLOWER'}`);
  if (d.reload) (d.reload > 0 ? gains : losses).push(`RELOADS ${how(d.reload)}${d.reload > 0 ? 'FASTER' : 'SLOWER'}`);
  if (gains.length && losses.length) return `${gains.join(' AND ')}, BUT ${losses.join(' AND ')}.`;
  if (gains.length || losses.length) return `${[...gains, ...losses].join(' AND ')}.`;
  return 'NO CHANGE TO THE NUMBERS.';
}

interface Group { id: string; n: number; part: PartDef }
type Pick = { kind: 'bin'; g: Group; n: number } | { kind: 'slot'; slot: Slot; part?: PartDef };

// ---------- the screen ----------
class Camp {
  root: HTMLElement;
  run: RunState;
  private n: number;
  private cur: number[];
  private p = 0;
  private tab = 0;
  /** keyboard / pad cursor: s:<slot>, b:<tile>, r (repair), c:3 (craft patch) */
  private focus: string;
  /** the last slot or bin tile chosen: what the detail panel shows and FIT / STRIP act on */
  private pick: string;
  private msg = { text: Q_HELLO[0], status: '', cls: 'c-green' };
  private quip = 0;
  private u = 3;
  private alive = true;
  private raf = 0;
  private padPrev: boolean[][] = [];
  private padDir = -1;
  private padT = 0;
  // ---------- Phase 3 crew tab state ----------
  /** selected card in the roster */
  private crewSel = 0;
  /** the last T TALK / level-up line, shown on that member's card */
  private talk: { id: string; text: string; gold?: boolean } | null = null;
  /** the CREW tab was looked at: NEW tags clear when the camp closes */
  private sawCrew = false;
  // ---------- Phase 5 MAP tab ----------
  private mapSel = 0;
  private mapInfo: CampMap | null = null;

  constructor(private opts: CampOpts) {
    const run = (this.run = structuredClone(opts.run));
    run.bin = Array.isArray(run.bin) ? run.bin : [];
    const f = Array.isArray(run.fitted) ? run.fitted : [];
    run.fitted = [f[0] ?? {}, f[1] ?? {}];
    run.charges = [0, 1, 2, 3].map((k) => run.charges?.[k] ?? 0);
    run.vet = [run.vet?.[0] ?? 0, run.vet?.[1] ?? 0];
    run.crew = Array.isArray(run.crew) ? run.crew : starterCrew(); // Phase 3
    // start on whoever can level up (else the first card)
    this.crewSel = Math.max(0, roster(run.crew).findIndex((m) => !m.waiting && canLevel(m)));
    this.tab = clamp(opts.tab ?? 0, 0, TABS.length - 1);
    // Phase 5 MAP tab: start on the nearest held town (else the first)
    const m = opts.map;
    if (m?.towns.length) {
      const me = m.players[0];
      let bd = Infinity;
      m.towns.forEach((t, i) => {
        const d = (t.freed ? 1e9 : 0) + (me ? (t.cx - me.cx) ** 2 + (t.cy - me.cy) ** 2 : i);
        if (d < bd) { bd = d; this.mapSel = i; }
      });
    }
    if (this.tab === 1) this.sawCrew = true;
    this.n = opts.players === 2 ? 2 : 1;
    // keep each tank's damage (max - current) when its max is recomputed from the loadout
    this.cur = [0, 1].map((i) => {
      const a = opts.armour[i];
      const max = this.maxArm(i);
      if (!a) return max;
      return clamp(max - Math.max(0, a[1] - a[0]), a[0] > 0 ? 1 : 0, max);
    });
    this.quip = Math.floor(Math.random() * Q_HELLO.length);
    this.msg.text = Q_HELLO[this.quip];
    this.focus = this.pick = this.groups().length ? 'b:0' : 's:barrel';
    this.root = document.createElement('div');
    this.root.id = 'gx';
    setHazards(this.root);
    document.body.appendChild(this.root);
    window.addEventListener('keydown', this.onKey, true);
    window.addEventListener('resize', this.onResize);
    this.root.addEventListener('click', this.onClick);
    this.root.addEventListener('dblclick', this.onDbl);
    // pads: buttons already held when the screen opens don't count as presses
    for (const gp of navigator.getGamepads?.() ?? []) if (gp) this.padPrev[gp.index] = gp.buttons.map((b) => b.pressed);
    this.raf = requestAnimationFrame(this.tick);
    this.render();
  }

  // ---------- state ----------
  private maxArm(i: number): number { return tankNumbers(this.run.fitted[i], this.run.vet[i]).armourMax; }
  private get L(): Loadout { return this.run.fitted[this.p]; }

  private groups(): Group[] {
    const out: Group[] = [];
    const m = new Map<string, Group>();
    for (const id of this.run.bin) {
      const part = partById(id);
      if (!part) continue;
      let g = m.get(id);
      if (!g) { g = { id, n: 0, part }; m.set(id, g); out.push(g); }
      g.n++;
    }
    return out;
  }

  private parsePick(key: string): Pick | null {
    if (key.startsWith('s:')) {
      const slot = key.slice(2) as Slot;
      const id = this.L[slot];
      return { kind: 'slot', slot, part: id ? partById(id) : undefined };
    }
    if (key.startsWith('b:')) {
      const n = Number(key.slice(2));
      const g = this.groups()[n];
      return g ? { kind: 'bin', g, n } : null;
    }
    return null;
  }

  /** The loadout the selected part would give (fit from the bin, or take off a fitted one). */
  private previewLoadout(): Loadout {
    const L = { ...this.L };
    if (this.focus !== this.pick) return L;
    const s = this.parsePick(this.pick);
    if (s?.kind === 'bin') L[s.g.part.slot] = s.g.id;
    else if (s?.kind === 'slot' && s.part) delete L[s.slot];
    return L;
  }

  /** Change the current tank's loadout keeping its damage: plates bolted on arrive intact, plates taken off take theirs. */
  private refit(f: () => void): void {
    const i = this.p;
    const before = this.maxArm(i);
    const dmg = before - this.cur[i];
    const alive = this.cur[i] > 0;
    f();
    const after = this.maxArm(i);
    this.cur[i] = clamp(after - dmg, alive ? 1 : 0, after);
  }

  private say(text: string | string[], status = '', cls = 'c-green'): void {
    this.msg = { text: Array.isArray(text) ? text[this.quip++ % text.length] : text, status, cls };
  }

  /** Keep the cursor on something that exists after the bin changed. */
  private fixFocus(fallback: string): void {
    const ok = (k: string) => !k.startsWith('b:') || Number(k.slice(2)) < this.groups().length;
    const clampBin = (k: string) => {
      if (ok(k)) return k;
      const n = this.groups().length;
      return n ? `b:${n - 1}` : fallback;
    };
    this.focus = clampBin(this.focus);
    this.pick = clampBin(this.pick);
  }

  // ---------- actions ----------
  private act(): void {
    if (this.tab === 2) { this.close(); return; } // Phase 5 MAP tab: SET OUT
    if (this.tab === 1) this.crewLevelUp();
    if (this.tab !== 0) return;
    if (this.focus === 'r') this.repair();
    else if (this.focus.startsWith('c:')) this.craft(Number(this.focus.slice(2)));
    else this.primary();
  }

  /** ENTER on the picked thing: fit a bin part, take a fitted part off, or jump to a spare for an empty slot. */
  private primary(): void {
    const s = this.parsePick(this.pick);
    if (!s) return;
    const L = this.L;
    if (s.kind === 'bin') {
      const slot = s.g.part.slot;
      const old = L[slot];
      this.refit(() => {
        this.run.bin.splice(this.run.bin.indexOf(s.g.id), 1);
        L[slot] = s.g.id;
        if (old) this.run.bin.push(old);
      });
      this.say(Q_FIT, `${s.g.part.name} ON ${NAMES[this.p]}`, 'c-green');
      this.fixFocus(`s:${slot}`);
    } else if (s.part) {
      this.refit(() => { delete L[s.slot]; });
      this.run.bin.push(s.part.id);
      this.say(Q_OFF, `${s.part.name} TO THE BIN`, 'c-dim');
    } else {
      const k = this.groups().findIndex((g) => g.part.slot === s.slot);
      if (k < 0) this.say(Q_NONE);
      else this.focus = this.pick = `b:${k}`;
    }
    this.render();
  }

  /** X: strip the picked part (bin or fitted) for its scrap. */
  private strip(): void {
    if (this.tab !== 0) return;
    const s = this.parsePick(this.pick);
    if (!s) return;
    let part: PartDef | undefined;
    if (s.kind === 'bin') {
      part = s.g.part;
      this.run.bin.splice(this.run.bin.indexOf(s.g.id), 1);
      this.fixFocus('s:barrel');
    } else if (s.part) {
      part = s.part;
      this.refit(() => { delete this.L[s.slot]; });
    }
    if (!part) return;
    this.run.scrap += part.scrap;
    this.say(Q_STRIP, `+${part.scrap} SCRAP`, 'c-green');
    this.render();
  }

  /** Phase 3: workshop prices after crew perks (BY THE BOOK, HOT GLUE), and which charges the crew can make. */
  private repairCost(): number { return repairCost(this.run.crew); }
  private craftCost(k: number): number { return craftCost(k, this.run.crew); }
  private canCraft(k: number): boolean { return crewUnlocks(this.run.crew)[k]; }
  /** armour a patch charge mends (SPANNER aboard: +1) */
  private patchArmour(): number { return PATCH_ARMOUR + (aboard(this.run.crew).some((m) => m.id === 'yurko') ? SPANNER_PATCH_BONUS : 0); }

  /** R: +REPAIR_STEP armour for the repair cost, up to max. */
  private repair(): void {
    if (this.tab !== 0) return;
    const max = this.maxArm(this.p);
    const cost = this.repairCost();
    if (this.cur[this.p] >= max) this.say(Q_FULL, `ARMOUR ${max}/${max}`, 'c-dim');
    else if (this.run.scrap < cost) this.say(Q_SHORT, `NEED ${cost} SCRAP`, 'c-red');
    else {
      const gain = Math.min(REPAIR_STEP, max - this.cur[this.p]);
      this.run.scrap -= cost;
      this.cur[this.p] += gain;
      this.say(Q_REPAIR, `+${gain} ARMOUR  -${cost} SCRAP`, 'c-green');
    }
    this.render();
  }

  /** 1-4: craft an ability charge; drone, ambush and recon need the crew member who unlocks them. */
  private craft(k: number): void {
    if (this.tab !== 0) return;
    const cost = this.craftCost(k);
    if (!this.canCraft(k)) this.say(Q_CREW[k] ?? Q_CREW[3], 'NO CREW YET', 'c-red');
    else if (this.run.scrap < cost) this.say(Q_SHORT, `NEED ${cost} SCRAP`, 'c-red');
    else {
      this.run.scrap -= cost;
      this.run.charges[k]++;
      this.say(Q_CRAFT[k], `+1 ${CRAFT[k].name}  -${cost} SCRAP`, 'c-green');
    }
    this.render();
  }

  private setTab(t: number): void {
    this.tab = (t + TABS.length) % TABS.length;
    if (this.tab === 1) this.sawCrew = true;
    this.render();
  }

  // ---------- Phase 3: crew tab actions ----------
  private crewList(): CrewMember[] { return roster(this.run.crew); }

  /** ENTER: spend the selected member's XP on a level. */
  private crewLevelUp(i = this.crewSel): void {
    const m = this.crewList()[i];
    if (!m) return;
    this.crewSel = i;
    const d = crewById(m.id)!;
    if (m.waiting) this.talk = { id: m.id, text: 'ASK ME AGAIN AT THE NEXT WORKSHOP. I WILL BE THERE.' };
    else if (levelUp(m)) this.talk = { id: m.id, text: `LV ${m.lv}! ${d.perk.name}: ${d.perk.short(perkVal(d, m.lv))}.`, gold: true };
    else if (m.lv >= MAX_LV) this.talk = { id: m.id, text: 'I AM AS GOOD AS I GET. WHICH IS VERY.' };
    else this.talk = { id: m.id, text: `NOT YET. ${xpNext(m.lv) - m.xp} MORE XP. FREE TOWNS, BREAK TANKS.` };
    this.render();
  }

  /** T: the selected member says something. */
  private crewTalk(i = this.crewSel): void {
    if (this.tab !== 1) return;
    const m = this.crewList()[i];
    const d = m && crewById(m.id);
    if (!d) return;
    this.crewSel = i;
    this.talk = { id: m.id, text: d.talk[this.quip++ % d.talk.length] };
    this.render();
  }

  private crewMove(dir: number): void {
    const n = this.crewList().length;
    const step = dir === 1 ? 1 : dir === 3 ? -1 : (this.root.classList.contains('tall') ? 2 : 1) * (dir === 2 ? 1 : -1);
    const next = clamp(this.crewSel + step, 0, n - 1);
    if (next === this.crewSel) return;
    this.crewSel = next;
    this.talk = null;
    this.render();
  }

  private switchTank(i = 1 - this.p): void {
    if (this.n < 2) return;
    this.p = i;
    this.fixFocus('s:barrel');
    this.render();
  }

  /** Arrow keys: move to the nearest focusable thing in that direction (0 up, 1 right, 2 down, 3 left). */
  private move(dir: number): void {
    if (this.tab === 1) {
      this.crewMove(dir);
      return;
    }
    if (this.tab === 2) {
      this.mapPick(this.mapSel + (dir === 1 || dir === 2 ? 1 : -1));
      return;
    }
    if (this.tab !== 0) return;
    const els = [...this.root.querySelectorAll<HTMLElement>('[data-f]')];
    const cur = els.find((e) => e.dataset.f === this.focus);
    if (!cur) {
      if (els[0]) this.setFocus(els[0].dataset.f!);
      return;
    }
    const a = cur.getBoundingClientRect();
    const ax = a.left + a.width / 2;
    const ay = a.top + a.height / 2;
    let best: HTMLElement | null = null;
    let bs = Infinity;
    for (const e of els) {
      if (e === cur) continue;
      const b = e.getBoundingClientRect();
      const dx = b.left + b.width / 2 - ax;
      const dy = b.top + b.height / 2 - ay;
      const main = dir === 1 ? dx : dir === 3 ? -dx : dir === 2 ? dy : -dy;
      if (main <= 2) continue;
      const side = dir % 2 ? Math.abs(dy) : Math.abs(dx);
      const overlap = dir % 2 ? b.top < a.bottom && b.bottom > a.top : b.left < a.right && b.right > a.left;
      if (!overlap && side > main) continue; // only within a 45 degree cone, so the edges stay edges
      const score = main + side * (overlap ? 0.3 : 2.5);
      if (score < bs) { bs = score; best = e; }
    }
    if (best) this.setFocus(best.dataset.f!);
  }

  private setFocus(k: string): void {
    this.focus = k;
    if (k.startsWith('s:') || k.startsWith('b:')) this.pick = k;
    this.render();
  }

  close(): void {
    if (!this.alive) return;
    this.alive = false;
    cancelAnimationFrame(this.raf);
    window.removeEventListener('keydown', this.onKey, true);
    window.removeEventListener('resize', this.onResize);
    this.root.remove();
    if (current === this) current = null;
    // Phase 3: the roster was seen, so the recruits are no longer NEW
    if (this.sawCrew) for (const m of (this.run.crew ?? []) as CrewMember[]) delete m.fresh;
    const armour = Array.from({ length: this.n }, (_, i) => [this.cur[i], this.maxArm(i)] as [number, number]);
    this.opts.onClose({ run: this.run, armour });
  }

  // ---------- input ----------
  private onKey = (e: KeyboardEvent): void => {
    // the game underneath must not see keys while the camp is open
    e.stopImmediatePropagation();
    const c = e.code;
    let used = true;
    // Phase 5 MAP tab: TAB / arrows pick a town, ENTER sets out
    if (this.tab === 2 && !e.repeat && (c === 'Tab' || c === 'Enter' || c === 'NumpadEnter' || c === 'Space')) {
      if (c === 'Tab') this.mapPick(this.mapSel + (e.shiftKey ? -1 : 1));
      else this.close();
      e.preventDefault();
      return;
    }
    if (c === 'ArrowUp' || c === 'KeyW') this.move(0);
    else if (c === 'ArrowRight' || c === 'KeyD') this.move(1);
    else if (c === 'ArrowDown' || c === 'KeyS') this.move(2);
    else if (c === 'ArrowLeft' || c === 'KeyA') this.move(3);
    else if (e.repeat) used = c === 'Enter' || c === 'Space' || c === 'Tab';
    else if (c === 'Enter' || c === 'NumpadEnter' || c === 'Space') this.act();
    else if (c === 'KeyX' || c === 'Delete') this.strip();
    else if (c === 'KeyR') this.repair();
    else if (c === 'KeyT') this.crewTalk();
    else if (c === 'KeyQ' || c === 'PageUp') this.setTab(this.tab - 1);
    else if (c === 'KeyE' || c === 'PageDown') this.setTab(this.tab + 1);
    else if (c === 'Tab') this.switchTank();
    else if (/^(Digit|Numpad)[1-4]$/.test(c)) this.craft(Number(c.slice(-1)) - 1);
    else if (c === 'Escape' || c === 'Backspace') this.close();
    else used = false;
    if (used) e.preventDefault();
  };

  private onResize = (): void => { if (this.alive) this.render(); };

  private onClick = (e: MouseEvent): void => {
    const t = e.target as HTMLElement;
    const a = t.closest<HTMLElement>('[data-act]')?.dataset.act;
    if (a) {
      const [k, v] = a.split(':');
      if (k === 'tab') this.setTab(Number(v));
      else if (k === 'tabstep') this.setTab(this.tab + Number(v));
      else if (k === 'p') this.switchTank(Number(v));
      else if (k === 'fit') this.primary();
      else if (k === 'strip') this.strip();
      else if (k === 'repair') { this.focus = 'r'; this.repair(); }
      else if (k === 'craft') { this.focus = `c:${v}`; this.craft(Number(v)); }
      else if (k === 'crew') { if (Number(v) !== this.crewSel) { this.crewSel = Number(v); this.talk = null; this.render(); } }
      else if (k === 'lvup') this.crewLevelUp(v === undefined ? this.crewSel : Number(v));
      else if (k === 'talk') this.crewTalk();
      else if (k === 'close') this.close();
      else if (k === 'town') this.mapPick(Number(v));
      return;
    }
    const f = t.closest<HTMLElement>('[data-f]')?.dataset.f;
    if (f && f !== this.focus) this.setFocus(f);
  };

  private onDbl = (e: MouseEvent): void => {
    const f = (e.target as HTMLElement).closest<HTMLElement>('[data-f]')?.dataset.f;
    if (f && (f.startsWith('b:') || f.startsWith('s:'))) {
      this.setFocus(f);
      this.primary();
    }
  };

  /** Gamepads: d-pad / stick move (with repeat), A fit, B back, X strip, Y repair, LB/RB tabs, Back switches tank. */
  private tick = (now: number): void => {
    if (!this.alive) return;
    let dir = -1;
    for (const gp of navigator.getGamepads?.() ?? []) {
      if (!gp || !gp.connected) continue;
      const b = (i: number) => !!gp.buttons[i]?.pressed;
      const prev = this.padPrev[gp.index] ?? [];
      const hit = (i: number) => b(i) && !prev[i];
      this.padPrev[gp.index] = gp.buttons.map((x) => x.pressed);
      if (hit(1)) { this.close(); return; }
      if (hit(0)) this.act();
      if (hit(2)) this.strip();
      if (hit(3)) { if (this.tab === 1) this.crewTalk(); else this.repair(); }
      if (hit(4)) this.setTab(this.tab - 1);
      if (hit(5)) this.setTab(this.tab + 1);
      if (hit(8)) this.switchTank();
      const ax = gp.axes[0] ?? 0;
      const ay = gp.axes[1] ?? 0;
      if (dir < 0) dir = b(12) || ay < -0.5 ? 0 : b(13) || ay > 0.5 ? 2 : b(14) || ax < -0.5 ? 3 : b(15) || ax > 0.5 ? 1 : -1;
    }
    if (!this.alive) return;
    if (dir !== this.padDir) {
      this.padDir = dir;
      if (dir >= 0) { this.move(dir); this.padT = now + 320; }
    } else if (dir >= 0 && now >= this.padT) {
      this.move(dir);
      this.padT = now + 110;
    }
    this.raf = requestAnimationFrame(this.tick);
  };

  // ---------- drawing ----------
  private px(n: number): string { return `${n * this.u}px`; }
  private img(a: Art, scale = this.u, cls = '', style = ''): string {
    return `<img class="${cls}" src="${a.url()}" style="width:${a.w * scale}px;height:${a.h * scale}px;${style}" draggable="false">`;
  }
  private icon(name: string, remap?: Record<string, string>, style = ''): string { return this.img(iconArt(name, remap), this.u, '', style); }
  private kc(k: string, cls = '', act = ''): string { return `<span class="gx-kc ${cls}" ${act ? `data-act="${act}"` : ''}>${T(k, 2)}</span>`; }
  private cursor(on: boolean): string { return on ? '<i class="gx-cur tl"></i><i class="gx-cur br"></i>' : ''; }
  private segs(n: number, on: number, w: number, h: number, mark: Record<number, string> = {}, cls = ''): string {
    let out = `<span class="gx-segs ${cls}">`;
    for (let i = 0; i < n; i++) out += `<i class="${i < on ? 'on' : ''} ${mark[i] ?? ''}" style="width:${this.px(w)};height:${this.px(h)}"></i>`;
    return `${out}</span>`;
  }
  private hdr(left: string, right = ''): string { return `<div class="gx-hdr">${left}${right}</div>`; }

  private render(): void {
    if (!this.alive) return;
    const W = innerWidth;
    const H = innerHeight;
    const u = (this.u = uiPixel(W, H));
    const tall = W / u < 600;
    const root = this.root;
    const scroll = root.scrollTop;
    root.className = `${tall ? 'tall' : ''} ${u < 3 ? 'tight' : ''}`;
    root.style.setProperty('--u', `${u}px`);
    const run = this.run;
    const md = u;
    const lg = u + 1;

    const header = `<div class="gx-row" style="justify-content:space-between;align-items:flex-start;flex-wrap:wrap;row-gap:${this.px(6)};${tall ? '' : `min-height:${this.px(28)}`}">
      <div class="gx-row" style="gap:${this.px(6)};flex-wrap:wrap;row-gap:${this.px(5)}">
        <div class="gx-col" style="gap:${this.px(2)};margin-right:${this.px(6)}">${T('CAMP', 2, 'c-mute')}<span class="gx-sh">${T(this.opts.place.toUpperCase(), lg, 'c-ink')}</span></div>
        <div class="gx-tabs">${this.kc('Q', '', 'tabstep:-1')}${TABS.map((t, i) => `<div class="gx-tab ${i === this.tab ? 'on' : ''}" data-act="tab:${i}">${T(t, md)}</div>`).join('')}${this.kc('E', '', 'tabstep:1')}</div>
      </div>
      <div class="gx-plate flat gx-row" style="gap:${this.px(8)};padding:${this.px(2)} ${this.px(5)}">
        <span class="gx-row" style="gap:${this.px(2)}">${this.icon('scrap')}${T(String(run.scrap), lg, 'c-ink')}</span>
        <span class="gx-row" style="gap:${this.px(2)}">${this.icon('parts')}${T(String(run.bin.length), lg, 'c-ink')}</span>
      </div></div>`;

    const hintList: [string[], string, string][] = this.tab === 0
      ? [[['↑', '↓', '←', '→'], 'SELECT', ''], [['ENTER'], 'FIT', 'fit'], [['X'], 'STRIP', 'strip'], [['R'], 'REPAIR', 'repair'],
        ...(this.n > 1 ? [[['TAB'], 'TANK', 'p:' + (1 - this.p)] as [string[], string, string]] : []), [['Q', 'E'], 'TABS', 'tabstep:1'], [['ESC'], 'BACK TO THE ROAD', 'close']]
      : this.tab === 1
        ? [[['←', '→'], 'SELECT', ''], [['ENTER'], 'LEVEL UP', 'lvup'], [['T'], 'TALK', 'talk'], [['Q', 'E'], 'TABS', 'tabstep:1'], [['ESC'], 'BACK TO THE ROAD', 'close']]
        : [[['TAB'], 'NEXT TOWN', `town:${this.mapSel + 1}`], [['ENTER'], this.map()?.ahead ? 'SET OUT' : 'BACK TO THE ROAD', 'close'], [['Q', 'E'], 'TABS', 'tabstep:1'], [['ESC'], 'BACK', 'close']];
    const hints = `<div class="gx-hints">${hintList.map(([keys, label, act]) => `<span ${act ? `data-act="${act}"` : ''}>${keys.map((k) => this.kc(k)).join('')}${T(label, 2)}</span>`).join('')}</div>`;

    const body = this.tab === 0 ? this.garage(tall) : this.tab === 1 ? this.crewTab(tall) : this.mapTab(tall);
    root.innerHTML = `<div class="gx-scan"></div><div class="gx-page" style="${tall ? '' : `position:absolute;inset:0;display:flex;flex-direction:column;gap:${this.px(8)};padding:${this.px(8)} ${this.px(8)} ${this.px(6)}`}">
      ${header}${body}<div style="display:flex;justify-content:center;margin-top:-${this.px(2)}">${hints}</div></div>`;
    if (this.tab === 0) this.drawLeads();
    // crew cards that still don't fit (small windows) drop their quip; the selected one keeps a T TALK line
    if (this.tab === 1) {
      for (const c of root.querySelectorAll<HTMLElement>('.gx-card')) {
        if (c.scrollHeight <= c.clientHeight + 1) continue;
        // a card that is talking drops its perk's next-level line instead
        c.classList.add(c.dataset.talk ? 'nonext' : 'noquip');
      }
    }
    root.scrollTop = scroll;
    if (tall) root.querySelector<HTMLElement>(this.tab === 1 ? '.gx-card.sel' : '.gx-f')?.scrollIntoView({ block: 'nearest' });
  }

  // ---------- Phase 3: the CREW tab (mockups/campaign-ui/src/crew.html) ----------
  /** Cards in a row of five (landscape; more than five slide with the selection) or two columns (portrait). */
  private crewTab(tall: boolean): string {
    const u = this.u;
    const list = this.crewList();
    if (!list.length) return this.soon('CREW');
    this.crewSel = clamp(this.crewSel, 0, list.length - 1);
    const cols = tall ? 2 : 5;
    const gap = 8;
    const W = Math.floor(innerWidth / u);
    const cw = Math.floor((W - 16 - gap * (cols - 1)) / cols);
    let from = 0;
    let shown = list;
    if (!tall && list.length > cols) {
      from = clamp(this.crewSel - 2, 0, list.length - cols);
      shown = list.slice(from, from + cols);
    }
    // co-op: the crew aboard split between the two tanks in roster order
    const ab = list.filter((m) => !m.waiting);
    const tankOf = (m: CrewMember) => (this.n > 1 ? ab.indexOf(m) % 2 : 0);
    const cards = shown.map((m, j) => this.crewCard(m, from + j, from + j === this.crewSel, tankOf(m), tall)).join('');
    const more = (side: 'l' | 'r', n: number) => n > 0
      ? `<div class="gx-more ${side}" data-act="crew:${side === 'l' ? from - 1 : from + cols}">${T(side === 'l' ? '◀' : '▶', 2, 'c-gold')}${T(String(n), 2, 'c-dim')}</div>` : '';
    return `<div class="gx-crew ${tall ? '' : 'wide'}" style="grid-template-columns:repeat(${tall ? cols : shown.length}, ${this.px(cw)});gap:${this.px(gap)}">
      ${cards}${tall ? '' : more('l', from) + more('r', list.length - from - shown.length)}</div>`;
  }

  private crewCard(m: CrewMember, i: number, sel: boolean, tank: number, tall: boolean): string {
    const d = crewById(m.id)!;
    const u = this.u;
    const md = u;
    const lg = u + 1;
    const next = xpNext(m.lv);
    const xpOn = next ? clamp(Math.floor((m.xp / next) * 10), 0, 10) : 10;
    const ready = !m.waiting && canLevel(m);
    // the next level's line: gold when it can be bought now
    const nextLine = m.lv < MAX_LV
      ? `<div class="gx-row gx-next" style="gap:${this.px(2)};margin-top:${this.px(1)};flex-wrap:wrap">${T(`LV ${m.lv + 1}:`, 2, ready ? 'c-gold' : 'c-mute')}${T(d.perk.short(perkVal(d, m.lv + 1)), 2, ready ? 'c-gold' : 'c-mute')}</div>` : '';
    const k = d.unlock;
    const unlocks = k >= 0
      ? `<div class="gx-row" style="gap:${this.px(3)}">${this.icon(ABILITY_ICONS[k])}${P(ABILITY_NAMES[k], 2, 'c-ink')}</div>${k === 3 ? P(d.unlockNote, 2, 'c-green') : ''}`
      : `<div class="gx-row" style="min-height:${this.px(16)}">${P(d.unlockNote, 2, 'c-mute')}</div>`;
    const talk = this.talk?.id === m.id ? this.talk : null;
    const line = talk ? P(`"${talk.text}"`, 2, talk.gold ? 'c-gold' : 'c-ink') : P(`"${d.quip}"`, 2, 'c-dim');
    const where = m.from ? ` · ${m.from}` : '';
    const tag = m.waiting
      ? `<span class="gx-tag off">${T(`WAITING${where}`, 2)}</span>`
      : m.fresh ? `<span class="gx-tag blue">${T(`NEW${where}`, 2)}</span>` : `<span class="gx-tag ${tank ? 'p2' : ''}">${T(TANK_NAMES[tank], 2)}</span>`;
    const lv = ready ? `<span class="gx-row" style="gap:${this.px(2)}" data-act="lvup:${i}">${this.kc('ENTER', 'gold')}${T('LEVEL UP', 2, 'c-gold gx-blink')}</span>` : '';
    // 3 UI px per portrait pixel (the mockup); 2-px UI pixels in landscape (720p) use 3 screen px to save height
    const fs = 32 * (u >= 3 || tall ? 3 * u : 3);
    const face = `<img src="${radioFace(d.call)}" style="width:${fs}px;height:${fs}px" draggable="false">`;
    return `<div class="gx-plate riv gx-card ${sel ? 'sel' : ''} ${m.waiting ? 'wait' : ''}" data-act="crew:${i}" ${talk ? 'data-talk="1"' : ''}>
      <div class="gx-hdr ${sel ? 'gold' : ''}">${T(d.role, 2, sel ? 'c-gold' : 'c-dim')}${T(`LV ${m.lv}`, 2, 'c-ink')}</div>
      <div class="gx-well gx-pframe">${face}</div>
      <div class="gx-col" style="align-items:center;gap:${this.px(2)}">${T(d.name, lg, 'c-ink')}${T(`"${d.call}"`, md, 'c-gold')}</div>
      <div class="gx-row" style="justify-content:center;gap:${this.px(3)}">${this.segs(10, xpOn, 4, 3, {}, 'blue')}${T(next ? `${m.xp}/${next}` : 'MAX', 2, 'c-dim')}</div>
      <div class="gx-box2 perk">${T('PERK', 2, 'c-mute')}${T(d.perk.name, md, 'c-green')}${P(d.perk.desc(perkVal(d, m.lv)), 2, 'c-dim')}${nextLine}</div>
      <div class="gx-box2">${T('UNLOCKS', 2, 'c-mute')}${unlocks}</div>
      <div class="gx-quip">${line}</div>
      <div class="gx-sp"></div>
      <div class="gx-row" style="justify-content:space-between;flex-wrap:wrap;row-gap:${this.px(2)}">${tag}${lv}</div>
    </div>`;
  }

  // ---------- Phase 5: the MAP tab (ui-campmap.ts) ----------
  /** The map the tab shows: the one handed in, else the run's current region from its seed (?camp=1 demo). */
  private map(): CampMap | null {
    if (this.opts.map) return this.opts.map;
    if (!this.mapInfo) {
      try { this.mapInfo = campMapFromSpec(campaignRegion(this.run), this.run.region); } catch { this.mapInfo = null; }
    }
    return this.mapInfo;
  }

  private mapPick(i: number): void {
    const n = this.map()?.towns.length ?? 0;
    if (!n) return;
    this.mapSel = ((i % n) + n) % n;
    this.render();
  }

  private mapTab(tall: boolean): string {
    const m = this.map();
    if (!m) return this.soon('MAP');
    const H = { u: this.u, px: (n: number) => this.px(n), kc: (k: string, cls = '', act = '') => this.kc(k, cls, act), segs: (n: number, on: number, w: number, h: number, mark: Record<number, string> = {}, cls = '') => this.segs(n, on, w, h, mark, cls) };
    const armour = Array.from({ length: this.n }, (_, i) => [this.cur[i], this.maxArm(i)] as [number, number]);
    return renderMapTab(H, this.run, m, this.mapSel, tall, armour, this.n);
  }

  /** CREW and MAP: placeholder plates until Phase 3. */
  private soon(name: string): string {
    const what = name === 'CREW' ? 'CREW ROSTER' : 'REGION MAP';
    const line = name === 'CREW' ? '"IT IS JUST ME FOR NOW. I TALK ENOUGH FOR FIVE."' : '"THE MAP IS IN THE MAJOR\'S HEAD. HE IS NOT SHARING."';
    return `<div class="gx-soon" style="flex:1;min-height:${this.px(120)}">
      <div class="gx-plate riv" style="width:${this.px(260)};max-width:100%">
        ${this.hdr(T(what, 2, 'c-gold'), T('LOCKED', 2, 'c-dim'))}
        <div class="gx-row" style="align-items:flex-start;gap:${this.px(5)}">
          <div class="gx-well">${this.img(spanner(), this.u)}</div>
          <div class="gx-col" style="gap:${this.px(4)};flex:1">${T('COMING IN THE NEXT UPDATE', this.u, 'c-gold')}
            ${P(line, 2, 'c-ink')}${T('SPANNER, MECHANIC', 2, 'c-dim')}</div>
        </div></div></div>`;
  }

  private garage(tall: boolean): string {
    const u = this.u;
    const run = this.run;
    const L = this.L;
    const groups = this.groups();
    const pick = this.parsePick(this.pick);
    const hiSlot: Slot | null = this.focus.startsWith('s:') ? (this.focus.slice(2) as Slot) : pick?.kind === 'bin' && this.focus === this.pick ? pick.g.part.slot : null;

    // ----- tank on its blueprint, slots with leader lines -----
    const vet = run.vet[this.p];
    const chev = [0, 1, 2].map((k) => this.icon('chev', k < vet ? undefined : CHEV_OFF)).join('');
    const tag = (i: number, on = true) => `<span class="gx-tag ${on ? (i ? 'p2' : '') : 'off'}" ${this.n > 1 ? `data-act="p:${i}" style="cursor:pointer"` : ''}>${T(i ? 'IIP' : 'IP', 2)}</span>`;
    const dollRight = this.n > 1
      ? `<span class="gx-row" style="gap:${this.px(3)}">${this.kc('TAB', '', `p:${1 - this.p}`)}${T('TANK', 2, 'c-dim')}${tag(0, this.p === 0)}${tag(1, this.p === 1)}</span>`
      : T(FLAVOUR[0], 2, 'c-dim');
    const slot = (s: Slot) => {
      const id = L[s];
      const part = id ? partById(id) : undefined;
      const stock = STOCK[s];
      const sel = hiSlot === s;
      const f = this.focus === `s:${s}`;
      const box = `<div class="box ${part || stock ? 'gx-well' : ''}">${this.icon(s, part || stock ? undefined : GREY)}</div>`;
      const name = part ? T(part.name, u, 'c-ink') : stock ? T(stock[0], u, 'c-ink') : T('EMPTY', u, 'c-mute');
      const lines = part ? statLines(part.stats) : [];
      const sub = part
        ? lines.length ? `<div class="gx-para" style="column-gap:8px;row-gap:${this.px(1)}">${lines.map((l) => T(l.text, 2, l.gain ? 'c-green' : 'c-red')).join('')}</div>` : T(FUTURE[s] ?? '', 2, 'c-mute')
        : stock ? T('STOCK', 2, 'c-mute') : T('LOOT A WRECK', 2, 'c-mute');
      return `<div class="gx-slot ${sel ? 'sel' : ''} ${part || stock ? '' : 'empty'} ${f ? 'gx-f' : ''}" data-f="s:${s}" data-slot="${s}">${box}
        <div class="gx-col txt" style="gap:${this.px(2)}">${T(SLOT_NAME[s], 2, sel ? 'c-gold' : 'c-dim')}${name}${sub}</div>${this.cursor(f)}</div>`;
    };
    const bp = `<div class="gx-blue" style="padding:${this.px(4)}" data-k="bp">${this.img(babusyaDoll(L, this.p, run.vet[this.p] ?? 0), 4 * u)}</div>`;

    // ----- stat bars with the pending change -----
    const curS = loadoutStats(L);
    const prevL = this.previewLoadout();
    const prevS = loadoutStats(prevL);
    const bars = STAT_KEYS.map((k) => {
      const v = clamp(5 + curS[k], 0, 10);
      const pv = clamp(5 + prevS[k], 0, 10);
      const mark: Record<number, string> = {};
      for (let i = v; i < pv; i++) mark[i] = 'gain';
      for (let i = pv; i < v; i++) mark[i] = 'loss';
      const d = prevS[k] - curS[k];
      return `<div class="gx-row" style="justify-content:space-between">${T(STAT_NAMES[k], 2, 'c-dim')}<span class="gx-row" style="gap:${this.px(3)}">${this.segs(10, Math.min(v, pv), 5, 4, mark)}
        <span style="width:${3 * 6 * 2}px">${d > 0 ? T(`+${d}`, 2, 'c-green') : d < 0 ? T(`${d}`, 2, 'c-red') : ''}</span></span></div>`;
    }).join('');
    const legend = `<div class="gx-row" style="gap:${this.px(3)}">${this.segs(1, 1, 4, 4, { 0: 'gain' })}${T('GAIN', 2, 'c-dim')}${this.segs(1, 1, 4, 4, { 0: 'loss' })}${T('LOSS', 2, 'c-dim')}</div>`;
    let sumTitle = '';
    let sumText = '';
    let showLegend = false;
    if (this.focus === 'r') {
      sumTitle = 'PATCHING THE ARMOUR';
      sumText = `EVERY PATCH ADDS ${REPAIR_STEP} ARMOUR FOR ${this.repairCost()} SCRAP, UP TO THE TANK'S MAX.`;
    } else if (this.focus.startsWith('c:')) {
      const k = clamp(Number(this.focus.slice(2)), 0, 3);
      sumTitle = CRAFT_INFO[k][0];
      sumText = CRAFT_INFO[k][1](this.craftCost(k), this.patchArmour());
    } else if (pick?.kind === 'bin') {
      sumTitle = `FITTING THE ${pick.g.part.name}`;
      sumText = changeText(curS, prevS);
      showLegend = true;
    } else if (pick?.kind === 'slot' && pick.part) {
      sumTitle = `TAKING OFF THE ${pick.part.name}`;
      sumText = changeText(curS, prevS);
      showLegend = true;
    } else if (pick?.kind === 'slot') {
      const spare = groups.filter((g) => g.part.slot === pick.slot).reduce((a, g) => a + g.n, 0);
      sumTitle = `${SLOT_NAME[pick.slot]}: ${STOCK[pick.slot]?.[0] ?? 'EMPTY'}`;
      sumText = spare ? `${plural(spare, 'SPARE')} IN THE BIN. ENTER PICKS ONE.` : 'NOTHING IN THE BIN FOR THIS SLOT. STRIP ENEMY WRECKS ON THE ROAD.';
    } else {
      sumTitle = `${NAMES[this.p]}'S LOADOUT`;
      sumText = 'PICK A PART IN THE BIN TO SEE WHAT IT CHANGES.';
    }
    const summary = `<div class="gx-col" style="gap:${this.px(3)}">${P(sumTitle, 2, 'c-gold')}${P(sumText, 2, 'c-dim')}${showLegend ? legend : ''}</div>`;

    const doll = `<div class="gx-plate riv" style="display:flex;flex-direction:column">
      ${this.hdr(`<span class="gx-row">${tag(this.p)}${T(NAMES[this.p], u, 'c-ink')}<span class="gx-row" style="gap:${u}px">${chev}</span></span>`, dollRight)}
      <div class="gx-dollrow" style="position:relative;display:flex;justify-content:space-between;align-items:center;gap:${this.px(6)}">
        <div class="gx-col" style="gap:${this.px(10)}">${LEFT.map(slot).join('')}</div>${bp}
        <div class="gx-col" style="gap:${this.px(10)}">${RIGHT.map(slot).join('')}</div>
        <div class="gx-leads"></div></div>
      <div class="gx-sep"></div>
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:${this.px(3)} ${this.px(12)};align-items:start">
        <div class="gx-col" style="gap:${this.px(4)}">${bars}</div>${summary}</div></div>`;

    // ----- parts bin + the selected part -----
    const cells = Math.max(18, Math.ceil(groups.length / 6) * 6);
    let tiles = '';
    for (let i = 0; i < cells; i++) {
      const g = groups[i];
      if (!g) { tiles += '<div class="gx-tile gx-well"></div>'; continue; }
      const f = this.focus === `b:${i}`;
      const picked = this.pick === `b:${i}` && !f;
      tiles += `<div class="gx-tile gx-well ${g.part.captured ? 'cap' : ''} ${f || picked ? 'gx-f' : ''}" data-f="b:${i}">${this.icon(g.part.slot)}${
        g.n > 1 ? `<span class="n gx-ol">${T(`x${g.n}`, 2, 'c-ink')}</span>` : ''}${this.cursor(f)}</div>`;
    }
    const detail = this.detail(pick, curS);
    const bin = `<div class="gx-plate riv" style="display:flex;flex-direction:column">
      ${this.hdr(T('PARTS BIN', 2, 'c-gold'), T(plural(run.bin.length, 'PART'), 2, 'c-dim'))}
      <div style="display:grid;grid-template-columns:repeat(6, ${this.px(26)});gap:${this.px(4)};justify-content:center">${tiles}</div>
      <div class="gx-sep"></div>
      <div class="gx-col" style="gap:${this.px(4)};flex:1">${detail}</div></div>`;

    // ----- repair, craft, mechanic -----
    const max = this.maxArm(this.p);
    const cur = this.cur[this.p];
    const gain = Math.min(REPAIR_STEP, max - cur);
    const rmark: Record<number, string> = {};
    for (let i = cur; i < cur + gain; i++) rmark[i] = 'gain';
    const low = cur <= Math.max(1, Math.floor(max * 0.3));
    const segW = clamp(Math.floor(120 / max) - 1, 2, 6);
    const rcost = this.repairCost();
    const canRepair = gain > 0 && run.scrap >= rcost;
    const rf = this.focus === 'r';
    const repairBtn = gain > 0
      ? `<span class="gx-btn ${rf ? 'gx-f' : ''}" data-f="r" data-act="repair">${this.kc('R')}${T(`PATCH +${gain}`, u, 'c-ink')}${this.icon('scrap')}${T(String(rcost), u, canRepair ? 'c-ink' : 'c-red')}${this.cursor(rf)}</span>`
      : `<span class="gx-btn off ${rf ? 'gx-f' : ''}" data-f="r">${this.kc('R')}${T('ARMOUR FULL', u, 'c-mute')}${this.cursor(rf)}</span>`;
    const repair = `<div class="gx-plate riv">
      ${this.hdr(T('REPAIR', 2, 'c-gold'), T(`ARMOUR ${cur}/${max}`, 2, low ? 'c-red' : 'c-dim'))}
      <div class="gx-col" style="gap:${this.px(5)};align-items:flex-start">${this.segs(max, cur, segW, 6, rmark, low ? 'warn' : '')}${repairBtn}</div></div>`;
    const craftItem = (c: typeof CRAFT[number], k: number) => {
      const locked = !this.canCraft(k); // Phase 3: the crew member who knows how is aboard
      const f = this.focus === `c:${k}`;
      const have = run.charges[k] ?? 0;
      const cost = this.craftCost(k);
      const btn = locked
        ? `<span class="gx-btn sm off">${T(u >= 3 ? 'NO CREW YET' : 'NO CREW', 2, 'c-mute')}</span>`
        : `<span class="gx-btn sm ${f ? 'gx-f' : ''}" data-f="c:${k}" data-act="craft:${k}">${this.kc(c.key)}${T(`${cost} SCRAP`, 2, run.scrap >= cost ? 'c-ink' : 'c-red')}${this.cursor(f)}</span>`;
      return `<div class="gx-craft ${locked ? 'locked' : ''}">
        <div class="gx-tile gx-well ${locked ? 'dim' : ''}" style="width:${this.px(22)};height:${this.px(22)}">${this.icon(c.icon, locked ? GREY : undefined)}<span class="n gx-ol">${T(`x${have}`, 2, locked && !have ? 'c-mute' : 'c-ink')}</span></div>
        ${T(c.name, 2, locked ? 'c-mute' : 'c-dim')}${btn}</div>`;
    };
    const craft = `<div class="gx-plate riv">
      ${this.hdr(T('CRAFT CHARGES', 2, 'c-gold'), T(this.n > 1 ? 'SHARED BY BOTH TANKS' : 'FOR THE ROAD', 2, 'c-dim'))}
      <div class="gx-row" style="justify-content:space-around;align-items:flex-start">${CRAFT.map(craftItem).join('')}</div></div>`;
    const mech = `<div class="gx-plate riv gx-mech">
      ${this.hdr(T('MECHANIC', 2, 'c-gold'), T('SPANNER', 2, 'c-dim'))}
      <div class="gx-row" style="align-items:flex-start;gap:${this.px(4)}">
        <div class="gx-well">${this.img(spanner(), u)}</div>
        <div class="gx-col" style="gap:${this.px(3)};flex:1">${P(`"${this.msg.text}"`, 2, 'c-ink')}${this.msg.status ? T(this.msg.status, 2, this.msg.cls) : ''}</div>
      </div></div>`;

    return `<div class="gx-main" style="${tall ? '' : 'flex:1;min-height:0;grid-template-columns:minmax(min-content, 1.45fr) 1fr'}">${doll}${bin}</div>
      <div class="gx-bottom">${repair}${craft}${mech}</div>`;
  }

  /** The selected part: name, tags, stat changes against what's fitted, what it does, flavour, actions. */
  private detail(pick: Pick | null, curS: Required<PartStats>): string {
    const u = this.u;
    const L = this.L;
    const tags = (slot: Slot, captured?: boolean, fitted?: boolean) => `<span class="gx-row" style="gap:${this.px(2)}">
      <span class="gx-tag steel">${T(SLOT_NAME[slot], 2)}</span>${captured ? `<span class="gx-tag">${T('CAPTURED', 2)}</span>` : ''}${fitted ? `<span class="gx-tag p2">${T('FITTED', 2)}</span>` : ''}</span>`;
    const titleRow = (name: string, tagHtml: string) => `<div class="gx-row" style="justify-content:space-between;flex-wrap:wrap;row-gap:${this.px(3)}">${T(name, u + 1, 'c-gold')}${tagHtml}</div>`;
    const statRow = (st: PartStats, none: string) => {
      const ls = statLines(st);
      return `<div class="gx-row" style="gap:${this.px(10)};flex-wrap:wrap;row-gap:${this.px(2)}">${ls.length ? ls.map((l) => T(l.text, u, l.gain ? 'c-green' : 'c-red')).join('') : T(none, u, 'c-dim')}</div>`;
    };
    const buttons = (fit: string, stripN: number | null, fitOn = true) => `<div class="gx-row" style="gap:${this.px(6)};flex-wrap:wrap;row-gap:${this.px(4)}">
      ${fit ? `<span class="gx-btn ${fitOn ? 'go' : 'off'}" data-act="fit">${this.kc('ENTER', fitOn ? 'gold' : '')}${T(fit, u, fitOn ? 'c-gold' : 'c-mute')}</span>` : ''}
      ${stripN !== null ? `<span class="gx-btn" data-act="strip">${this.kc('X')}${T('STRIP FOR', u, 'c-ink')}${this.icon('scrap')}${T(String(stripN), u, 'c-ink')}</span>` : ''}</div>`;
    if (!pick) {
      return `${T('THE BIN IS EMPTY', u + 1, 'c-gold')}${P('DESTROYED ENEMIES DROP PARTS. DRIVE OVER THE CRATES TO PICK THEM UP, THEN BOLT THEM ON HERE.', 2, 'c-dim')}`;
    }
    if (pick.kind === 'bin') {
      const p = pick.g.part;
      const oldId = L[p.slot];
      const old = oldId ? partById(oldId) : undefined;
      const after = loadoutStats({ ...L, [p.slot]: p.id });
      const replaces = old ? old.name : STOCK[p.slot] ? `${STOCK[p.slot]![0]} (STOCK)` : 'NOTHING: THE SLOT IS EMPTY';
      const diff = statDiff(old?.stats ?? {}, p.stats);
      return `${titleRow(p.name, tags(p.slot, p.captured))}
        ${statRow(diff, old ? 'SAME NUMBERS' : 'NO STATS')}
        ${P(effectText(p, diff, after), 2, 'c-ink')}${P(p.desc, 2, 'c-dim')}
        <div class="gx-row" style="gap:${this.px(3)}">${T('REPLACES', 2, 'c-mute')}${this.icon(p.slot, old || STOCK[p.slot] ? undefined : GREY)}${T(replaces, 2, 'c-dim')}</div>
        <div class="gx-sp"></div>${buttons('FIT', p.scrap)}`;
    }
    const s = pick.slot;
    if (pick.part) {
      const p = pick.part;
      return `${titleRow(p.name, tags(s, p.captured, true))}
        ${statRow(p.stats, 'NO STATS YET')}
        ${P(effectText(p, statDiff({}, p.stats), curS), 2, 'c-ink')}${P(p.desc, 2, 'c-dim')}
        <div class="gx-row" style="gap:${this.px(3)}">${T('ON', 2, 'c-mute')}${T(NAMES[this.p], 2, 'c-dim')}${T('· TAKE IT OFF TO KEEP IT IN THE BIN', 2, 'c-mute')}</div>
        <div class="gx-sp"></div>${buttons('TAKE OFF', p.scrap)}`;
    }
    const spare = this.groups().some((g) => g.part.slot === s);
    const stock = STOCK[s];
    return `${titleRow(stock ? stock[0] : 'EMPTY SLOT', tags(s))}
      ${T(stock ? 'STOCK PART' : 'NOTHING FITTED', u, 'c-dim')}
      ${P(stock ? stock[1] : s === 'jammer' ? 'A JAMMER WILL KEEP ENEMY DRONES OFF YOUR BACK ONCE THEY SHOW UP.' : 'A PLOUGH WILL CLEAR MINES IN FRONT OF THE TANK ONCE THEY SHOW UP.', 2, 'c-dim')}
      <div class="gx-sp"></div>${buttons(spare ? 'PICK ONE' : 'NONE SPARE', null, spare)}`;
  }

  /** Leader lines from each slot to where its part sits on the tank (elbow: across, down, across). */
  private drawLeads(): void {
    const host = this.root.querySelector<HTMLElement>('.gx-leads');
    const im = this.root.querySelector<HTMLElement>('[data-k="bp"] img');
    if (!host || !im) return;
    const u = this.u;
    const hr = host.parentElement!.getBoundingClientRect();
    const bp = im.getBoundingClientRect();
    const sc = 4 * u;
    const hiSlot = this.root.querySelector<HTMLElement>('.gx-slot.sel')?.dataset.slot;
    let h = '';
    for (const [side, list] of [['left', LEFT], ['right', RIGHT]] as const) {
      list.forEach((s, idx) => {
        const el = this.root.querySelector<HTMLElement>(`[data-slot="${s}"]`);
        if (!el) return;
        const r = el.getBoundingClientRect();
        const tx = Math.round(bp.left + (AT[s][0] + 0.5) * sc - hr.left);
        const ty = Math.round(bp.top + (AT[s][1] + 0.5) * sc - hr.top);
        const sx = Math.round(side === 'left' ? r.right - hr.left + u : r.left - hr.left - u);
        const sy = Math.round(r.top + r.height / 2 - hr.top);
        const mx = Math.round(side === 'left' ? bp.left - hr.left - 6 * u - (2 - idx) * 3 * u : bp.right - hr.left + 6 * u + idx * 3 * u);
        const cls = s === hiSlot ? 'sel' : '';
        const hl = (x0: number, x1: number, y: number) => `<i class="gx-lead ${cls}" style="left:${Math.min(x0, x1)}px;top:${y}px;width:${Math.abs(x1 - x0) + u}px;height:${u}px"></i>`;
        const vl = (x: number, y0: number, y1: number) => `<i class="gx-lead ${cls}" style="left:${x}px;top:${Math.min(y0, y1)}px;width:${u}px;height:${Math.abs(y1 - y0) + u}px"></i>`;
        const line = hl(sx, mx, sy) + vl(mx, sy, ty) + hl(mx, tx, ty) + `<i class="gx-dot ${cls}" style="left:${tx - u}px;top:${ty - u}px"></i>`;
        // the gold line goes on top
        h = cls ? h + line : line + h;
      });
    }
    host.innerHTML = h;
  }
}

let current: Camp | null = null;

/** Open the camp screen over the game (pause the game first). It works on a copy of the run and hands the result
 * to onClose when the player leaves (Esc / pad B) or closeCamp() is called. armour = per player [current, max]. */
export function openCamp(opts: CampOpts): void {
  current?.close();
  current = new Camp(opts);
}

/** Close the camp screen if it's open; the result still goes to its onClose. */
export function closeCamp(): void {
  current?.close();
}

export function campOpen(): boolean {
  return current !== null;
}

/** A run with parts in the bin and on the tank, for ?camp=1 screenshots (the garage and crew mockups' values;
 * &crew=all adds the three later recruits, &crew=start leaves only the two starters). */
export function demoCampRun(): RunState {
  const q = new URLSearchParams(location.search).get('crew');
  const crew: CrewMember[] = q === 'start' ? starterCrew() : [
    { id: 'mykola', lv: 4, xp: 340 }, { id: 'halyna', lv: 3, xp: 210 }, { id: 'yurko', lv: 5, xp: 620 },
    { id: 'sofia', lv: 2, xp: 300 }, { id: 'taras', lv: 1, xp: 40, from: 'VYSHNEVE', fresh: true },
  ];
  if (q === 'all') crew.push(...allCrew().filter((m) => !crew.some((c) => c.id === m.id)).map((m, i) => ({ ...m, xp: 60 * i, waiting: i === 2 ? true : undefined, from: i === 2 ? 'BRODNA' : undefined })));
  return {
    version: 1, seed: 1, region: 0, scrap: 245,
    bin: ['barrel-125', 'sandbags', 'sandbags', 'oven-jammer', 'racing-tracks', 'bus-engine', 'reactive', 'farm-harrow', 'long-100'],
    fitted: [{ armour: 'scrap-plates', tracks: 'wide-tracks', engine: 'tractor-diesel' }, { barrel: 'sewing-loader' }],
    charges: [2, 1, 1, 0], vet: [2, 1], vetXp: [0.6, 0.3], retreats: 0, crew,
  };
}

// ---------- Phase 3: the recruit card (briefing style, mockups/campaign-ui/src/briefing.html) ----------
export interface RecruitOpts {
  /** crew.ts id of the recruit */
  id: string;
  /** the freed town they come from */
  place: string;
  /** asked before and said "not now": shorter lines */
  again: boolean;
  /** true = WELCOME ABOARD, false = NOT NOW (they wait at the next workshop) */
  onClose: (join: boolean) => void;
}

/** Keys are ignored this long after the card appears, so a held fire key or a tap meant for the tank doesn't pick. */
const RECRUIT_ARM_MS = 600;

class Recruit {
  root: HTMLElement;
  private sel = 0;
  private u = 3;
  private alive = true;
  private raf = 0;
  private armed: number;
  private padPrev: boolean[][] = [];
  private padDir = -1;

  constructor(private opts: RecruitOpts) {
    this.root = document.createElement('div');
    this.root.id = 'gx';
    setHazards(this.root);
    document.body.appendChild(this.root);
    this.armed = performance.now() + RECRUIT_ARM_MS;
    window.addEventListener('keydown', this.onKey, true);
    window.addEventListener('resize', this.onResize);
    this.root.addEventListener('click', this.onClick);
    for (const gp of navigator.getGamepads?.() ?? []) if (gp) this.padPrev[gp.index] = gp.buttons.map((b) => b.pressed);
    this.raf = requestAnimationFrame(this.tick);
    this.render();
  }

  private px(n: number): string { return `${n * this.u}px`; }
  private kc(k: string, cls = ''): string { return `<span class="gx-kc ${cls}">${T(k, 2)}</span>`; }

  choose(join: boolean): void {
    if (!this.alive) return;
    this.alive = false;
    cancelAnimationFrame(this.raf);
    window.removeEventListener('keydown', this.onKey, true);
    window.removeEventListener('resize', this.onResize);
    this.root.remove();
    if (recruitCur === this) recruitCur = null;
    this.opts.onClose(join);
  }

  private pick(i: number): void {
    if (i === this.sel) return;
    this.sel = i;
    this.render();
  }

  private onKey = (e: KeyboardEvent): void => {
    e.stopImmediatePropagation();
    const c = e.code;
    const keys = ['ArrowUp', 'ArrowDown', 'KeyW', 'KeyS', 'Digit1', 'Digit2', 'Numpad1', 'Numpad2', 'Enter', 'NumpadEnter', 'Escape', 'Backspace'];
    if (keys.includes(c)) e.preventDefault();
    if (e.repeat || performance.now() < this.armed) return;
    if (c === 'ArrowUp' || c === 'KeyW' || c === 'ArrowDown' || c === 'KeyS') this.pick(1 - this.sel);
    else if (c === 'Digit1' || c === 'Numpad1') this.choose(true);
    else if (c === 'Digit2' || c === 'Numpad2') this.choose(false);
    else if (c === 'Enter' || c === 'NumpadEnter') this.choose(this.sel === 0);
    else if (c === 'Escape' || c === 'Backspace') this.choose(false);
  };

  private onResize = (): void => { if (this.alive) this.render(); };

  private onClick = (e: MouseEvent): void => {
    const a = (e.target as HTMLElement).closest<HTMLElement>('[data-act]')?.dataset.act;
    if (a === 'pick:0') this.choose(true);
    else if (a === 'pick:1') this.choose(false);
  };

  /** Pads: A picks the highlighted answer, B is NOT NOW, d-pad / stick up and down move. */
  private tick = (now: number): void => {
    if (!this.alive) return;
    let dir = -1;
    for (const gp of navigator.getGamepads?.() ?? []) {
      if (!gp || !gp.connected) continue;
      const b = (i: number) => !!gp.buttons[i]?.pressed;
      const prev = this.padPrev[gp.index] ?? [];
      const hit = (i: number) => b(i) && !prev[i] && now >= this.armed;
      this.padPrev[gp.index] = gp.buttons.map((x) => x.pressed);
      if (hit(0)) { this.choose(this.sel === 0); return; }
      if (hit(1)) { this.choose(false); return; }
      const ay = gp.axes[1] ?? 0;
      if (dir < 0) dir = b(12) || ay < -0.5 ? 0 : b(13) || ay > 0.5 ? 2 : -1;
    }
    if (dir !== this.padDir) {
      this.padDir = dir;
      if (dir >= 0 && now >= this.armed) this.pick(1 - this.sel);
    }
    this.raf = requestAnimationFrame(this.tick);
  };

  private render(): void {
    const W = innerWidth;
    const H = innerHeight;
    const u = (this.u = uiPixel(W, H));
    const tall = W / u < 600;
    const d = crewById(this.opts.id);
    if (!d) return;
    const md = u;
    const lg = u + 1;
    const root = this.root;
    root.className = `gx-rec ${tall ? 'tall' : ''} ${u < 3 ? 'tight' : ''}`;
    root.style.setProperty('--u', `${u}px`);
    const lines = meetLines(d, this.opts.place, this.opts.again);
    const whoW = 6 * 7 * md + 2 * u; // the widest call sign (7 letters) at md
    const line = ([who, text]: [string, string], i: number) => {
      const now = i === lines.length - 1;
      const col = who === d.call ? 'c-gold' : 'c-blue';
      return `<div class="gx-row" style="align-items:flex-start;gap:${this.px(4)}">
        <span style="width:${whoW}px;flex:none">${T(who, md, now ? col : 'c-mute')}</span>
        <div style="flex:1">${P(text, now && !tall ? lg : md, now ? 'c-ink' : 'c-dim')}</div></div>`;
    };
    const k = d.unlock;
    const gift = k >= 0 && k < 3
      ? `<span class="gx-row" style="gap:${this.px(2)}">${this.icon(ABILITY_ICONS[k])}${T(`${ABILITY_NAMES[k]} · +1`, 2, 'c-green')}</span>`
      : `<span class="gx-row" style="gap:${this.px(2)}">${T('PERK:', 2, 'c-mute')}${T(d.perk.name, 2, 'c-green')}</span>`;
    const choice = (i: number, key: string, text: string, sub: string) => `<div class="gx-choice ${this.sel === i ? 'on' : ''}" data-act="pick:${i}">
      ${this.kc(key, this.sel === i ? 'gold' : '')}<div class="gx-col" style="gap:${this.px(2)}">${P(text, 2, this.sel === i ? 'c-ink' : 'c-dim')}${sub}</div></div>`;
    const choices = `<div class="gx-col" style="gap:${this.px(4)};justify-content:flex-end">${T('YOUR ANSWER', 2, 'c-mute')}
      ${choice(0, '1', '"WELCOME ABOARD."', gift)}
      ${choice(1, '2', '"NOT NOW."', `<span>${T('WAITS AT THE NEXT WORKSHOP', 2, 'c-blue')}</span>`)}</div>`;
    const talk = `<div class="gx-col" style="gap:${this.px(5)};justify-content:flex-end">${lines.map(line).join('')}
      <span class="gx-blink" style="display:inline-block">${T('▶', md, 'c-gold')}</span></div>`;
    const PORT = (tall ? 3 : 4) * u;
    const face = (who: string, cls = '') => `<div class="gx-plate gx-pf ${cls}"><img src="${radioFace(who)}" style="width:${32 * PORT}px;height:${32 * PORT}px${cls ? ';transform:scaleX(-1)' : ''}" draggable="false"><div class="gx-static"></div></div>`;
    const title = `<div class="gx-col" style="gap:${this.px(3)}">
      <span class="gx-row" style="gap:${this.px(3)};flex-wrap:wrap">${this.opts.place ? `<span class="gx-tag ${this.opts.again ? 'blue' : ''}">${T(this.opts.again ? `FROM ${this.opts.place}` : `${this.opts.place} FREED`, 2)}</span>` : ''}${T(this.opts.again ? 'BACK AT THE WORKSHOP' : 'SOMEONE WANTS A WORD', 2, 'c-ink gx-sh')}</span>
      <span class="gx-sh">${T(`RECRUIT · ${d.name}`, tall ? lg + 1 : 2 * u, 'c-steel')}</span></div>`;
    const hint = `<div class="gx-hints gx-sh">${[['1', '2'], ['ESC']].map((ks, i) => `<span>${ks.map((x) => this.kc(x)).join('')}${T(i ? 'NOT NOW' : 'ANSWER', 2)}</span>`).join('')}</div>`;
    const plate = (side: 'l' | 'r', html: string) => `<div class="gx-nameplate ${side}">${html}</div>`;
    const nameL = plate('l', `${this.icon('signal')}${T(`${d.name} "${d.call}"`, md, 'c-gold')}${T(d.role, 2, 'c-dim')}`);
    const nameR = plate('r', T('YURKO "SPANNER"', md, 'c-mute'));
    const boxH = 108;
    if (tall) {
      root.innerHTML = `<div class="gx-scan"></div><div class="gx-page" style="justify-content:flex-end">
        <div class="gx-row" style="justify-content:space-between;align-items:flex-start">${title}</div>
        <div class="gx-sp"></div>
        <div class="gx-row" style="justify-content:space-between;align-items:flex-end">${face(d.call)}${face('SPANNER', 'dim')}</div>
        <div class="gx-plate riv gx-col" style="gap:${this.px(8)};padding:${this.px(6)};padding-top:${this.px(10)}">${nameL}${talk}</div>
        <div class="gx-plate riv" style="padding:${this.px(6)}">${choices}</div>
        <div style="display:flex;justify-content:center">${hint}</div></div>`;
      return;
    }
    root.innerHTML = `<div class="gx-scan"></div>
      <div class="gx-abs" style="left:${this.px(8)};top:${this.px(8)}">${title}</div>
      <div class="gx-abs" style="right:${this.px(8)};top:${this.px(10)}">${hint}</div>
      <div class="gx-abs" style="left:${this.px(16)};bottom:${this.px(boxH + 8)}">${face(d.call)}</div>
      <div class="gx-abs" style="right:${this.px(16)};bottom:${this.px(boxH + 8)}">${face('SPANNER', 'dim')}</div>
      <div class="gx-abs gx-plate riv" style="left:${this.px(8)};right:${this.px(8)};bottom:${this.px(8)};height:${this.px(boxH - 8)};display:grid;grid-template-columns:1fr ${this.px(200)};gap:${this.px(8)};padding:${this.px(6)}">
        ${nameL}${nameR}${talk}${choices}</div>`;
  }

  private icon(name: string): string {
    const a = iconArt(name);
    return `<img src="${a.url()}" style="width:${a.w * this.u}px;height:${a.h * this.u}px" draggable="false">`;
  }
}

let recruitCur: Recruit | null = null;

/** Show the recruit card over the paused game. onClose gets the answer (Esc / pad B = NOT NOW). */
export function openRecruit(opts: RecruitOpts): void {
  recruitCur?.choose(false);
  recruitCur = new Recruit(opts);
}

export function recruitOpen(): boolean {
  return recruitCur !== null;
}
/** Max armour of a tank in the demo run, for the armour argument. */
export function demoArmour(run: RunState, players: number): [number, number][] {
  return Array.from({ length: players }, (_, i) => {
    const max = tankNumbers(run.fitted[i], run.vet[i]).armourMax;
    return [Math.min(max, BASE_ARMOUR - 3 + i * 2), max] as [number, number];
  });
}
