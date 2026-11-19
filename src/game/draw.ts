import { WHITE, type Env, type Renderer } from '../gl/renderer';
import type { Spr } from '../art/atlas';
import {
  BRICK, DX, DY, EAGLE_X, EAGLE_Y, FS, FX, FY, ICE, MAT_BRICK, MAT_FOLIAGE, MAT_GROUND, MAT_ICE, MAT_METAL, MAT_STD, MAT_STEEL,
  MAT_WATER, PW_COLORS, STEEL, TREES, WATER, RAIL, MAT_RAIL,
} from './constants';
import { BAB_PAINT, babusyaLayers, dominionSprite } from '../art/campaign-tanks';
import { drawAmbient } from './ambient';
import { drawWeakMarks } from './bosses/marks';
import type { Camera } from './camera';
import type { EnvName } from './stages';
import type { RegionKind } from './region';
import { railGeoFor } from './railgeo';
import { FREE_RADIUS, World, type DepotState, type Tank } from './world';

type V3 = [number, number, number];
export type WeatherKind = 'clear' | 'dust' | 'rain' | 'snow';

export interface EnvPreset extends Env {
  head: number;
  weather: WeatherKind;
  label: string;
}

export const ENVS: Record<EnvName, EnvPreset> = {
  day: {
    ambient: [0.2, 0.22, 0.27], sunCol: [0.85, 0.78, 0.66], sunDir: [-0.6, -0.75, 0.85], fog: 0.04, wet: 0, snow: 0, clouds: 1,
    sky: [0.1, 0.14, 0.22], gradeLo: [0.96, 1.0, 1.05], gradeHi: [1.04, 1.0, 0.95], sat: 1.06, backdrop: [0.022, 0.022, 0.024], ground: [0.34, 0.31, 0.26], grass: 1,
    leafOlive: 0.15, head: 0.7, weather: 'clear', label: 'DAY · CLEAR',
  },
  dusk: {
    ambient: [0.13, 0.11, 0.19], sunCol: [1.15, 0.55, 0.3], sunDir: [-0.9, -0.35, 0.62], fog: 0.16, wet: 0, snow: 0, clouds: 0.35,
    sky: [0.16, 0.09, 0.08], gradeLo: [0.86, 0.96, 1.14], gradeHi: [1.12, 0.98, 0.86], sat: 1.12, backdrop: [0.024, 0.018, 0.018], ground: [0.25, 0.21, 0.18], grass: 0.7,
    head: 1.3, weather: 'dust', label: 'DUSK · HAZE',
  },
  night: {
    ambient: [0.045, 0.055, 0.1], sunCol: [0.13, 0.17, 0.3], sunDir: [0.4, -0.6, 1.0], fog: 0.3, wet: 1, snow: 0, clouds: 0,
    sky: [0.004, 0.006, 0.013], gradeLo: [0.86, 0.96, 1.2], gradeHi: [1.05, 1.0, 0.95], sat: 1.0, backdrop: [0.012, 0.013, 0.017], ground: [0.13, 0.13, 0.135], grass: 0.35,
    water: 0.5, head: 2.0, weather: 'rain', label: 'NIGHT · STORM',
  },
  snow: {
    ambient: [0.15, 0.17, 0.23], sunCol: [0.55, 0.6, 0.74], sunDir: [-0.4, -0.7, 1.0], fog: 0.16, wet: 0, snow: 0.45, clouds: 0.5,
    sky: [0.26, 0.29, 0.36], gradeLo: [0.92, 0.98, 1.1], gradeHi: [1.0, 1.0, 1.02], sat: 0.9, backdrop: [0.022, 0.024, 0.028], ground: [0.2, 0.2, 0.22], grass: 0.3,
    head: 1.0, weather: 'snow', label: 'WINTER · SNOW',
  },
  // Phase 4 (River Delta): grey daylight under low cloud, steady rain, puddles and ripples on the water
  rain: {
    ambient: [0.16, 0.18, 0.22], sunCol: [0.45, 0.48, 0.54], sunDir: [-0.3, -0.55, 1.0], fog: 0.2, wet: 0.8, snow: 0, clouds: 0.8,
    sky: [0.12, 0.14, 0.17], gradeLo: [0.94, 1.0, 1.06], gradeHi: [1.0, 1.0, 0.99], sat: 0.95, backdrop: [0.016, 0.018, 0.02], ground: [0.23, 0.23, 0.17], grass: 1,
    head: 1.2, weather: 'rain', label: 'RAIN · OVERCAST',
  },
};

// ---------- weather (visual only; lightning also triggers thunder) ----------
interface Drop { x: number; y: number; v: number; life: number; s: number }

export class Weather {
  kind: WeatherKind = 'clear';
  drops: Drop[] = [];
  splashes: { x: number; y: number; t: number }[] = [];
  flash = 0;
  boltDir: V3 = [0.3, -0.5, 0.8];
  private nextBolt = 400;
  private strikeT = -1;
  events: { thunder: number }[] = [];
  rect = [FX, FY, FS, FS];

  dense = 1;
  /** false = no random strikes; the caller times them with strike() (the title screen) */
  auto = true;

  set(kind: WeatherKind, rect = [FX, FY, FS, FS]): void {
    if (kind === this.kind && rect.every((v, i) => v === this.rect[i])) return;
    this.kind = kind;
    this.rect = rect;
    this.drops = [];
    this.splashes = [];
    // same density as the 256 x 224 screen on a campaign view widened to the window (arcade: unchanged)
    const area = Math.max(1, (rect[2] * rect[3]) / (256 * 224));
    const n = Math.round((kind === 'rain' ? 170 : kind === 'snow' ? 150 : kind === 'dust' ? 45 : 0) * this.dense * area);
    for (let i = 0; i < n; i++) this.drops.push(this.spawn(true));
    this.nextBolt = 200 + Math.random() * 400;
  }

  private spawn(anywhere: boolean): Drop {
    const [x, y, w, h] = this.rect;
    const k = this.kind;
    return {
      x: x + Math.random() * w,
      y: anywhere ? y + Math.random() * h : y - 6,
      v: k === 'rain' ? 4 + Math.random() * 2 : k === 'snow' ? 0.25 + Math.random() * 0.35 : 0.1 + Math.random() * 0.15,
      life: k === 'rain' ? 6 + Math.random() * 40 : 9999,
      s: Math.random(),
    };
  }

  update(frame: number): void {
    const [x, y, w, h] = this.rect;
    for (let i = 0; i < this.drops.length; i++) {
      const d = this.drops[i];
      if (this.kind === 'rain') {
        d.x -= d.v * 0.25;
        d.y += d.v;
        if (--d.life <= 0 || d.y > y + h) {
          if (d.y < y + h) this.splashes.push({ x: d.x, y: d.y, t: 0 });
          this.drops[i] = this.spawn(false);
          this.drops[i].y = y + Math.random() * h * 0.6 - 10;
        }
      } else if (this.kind === 'snow') {
        d.y += d.v;
        d.x += Math.sin(frame * 0.03 + d.s * 20) * 0.25 + 0.08;
        if (d.y > y + h + 4) this.drops[i] = this.spawn(false);
      } else {
        d.y -= d.v * 0.4;
        d.x += Math.sin(frame * 0.01 + d.s * 30) * 0.15 + d.v;
        if (d.x > x + w || d.y < y) this.drops[i] = { ...this.spawn(true), x: x + Math.random() * w * 0.3 };
      }
    }
    for (const s of this.splashes) s.t++;
    this.splashes = this.splashes.filter((s) => s.t < 7);
    if (this.kind === 'rain') {
      if (this.auto && --this.nextBolt <= 0) this.strike(20 + Math.random() * 70);
      if (this.strikeT >= 0) {
        const t = this.strikeT++;
        this.flash = t < 3 ? 1 : t < 6 ? 0.15 : t < 9 ? 0.8 : Math.max(0, 0.6 - (t - 9) * 0.05);
        if (t > 22) {
          this.strikeT = -1;
          this.flash = 0;
        }
      }
    } else {
      this.flash = 0;
    }
  }

  /** A lightning strike now (flash flicker, sun from the bolt); thunder follows after `thunder` frames. */
  strike(thunder: number, dir?: V3): void {
    this.strikeT = 0;
    this.nextBolt = 480 + Math.random() * 900;
    const a = Math.random() * Math.PI * 2;
    this.boltDir = dir ?? [Math.cos(a) * 0.7, Math.sin(a) * 0.7, 0.7];
    this.events.push({ thunder });
  }

  draw(r: Renderer): void {
    if (this.kind === 'rain') {
      for (const d of this.drops) r.fxRect(Math.round(d.x), Math.round(d.y), 1, 3 + Math.round(d.s * 3), [0.55, 0.65, 0.85], (0.22 + this.flash * 0.6) * this.dense);
      for (const s of this.splashes) r.glow(s.x, s.y, 1.2 + s.t * 0.35, [0.6, 0.7, 0.9], 0.5 * (1 - s.t / 7));
    } else if (this.kind === 'snow') {
      for (const d of this.drops) r.smoke(d.x, d.y, 0.7 + d.s * 0.8, [0.92, 0.95, 1], 0.75);
    } else if (this.kind === 'dust') {
      for (const d of this.drops) r.glow(d.x, d.y, 1.2, [1, 0.75, 0.5], 0.25 + 0.2 * Math.sin(d.s * 40 + d.x * 0.1));
    }
  }
}

/**
 * What each campaign region is built of, on top of its weather: brick colour (the three NES shades keep their steps)
 * and foliage colour. Farmland: warm red village brick, leaves a touch olive. Rail Junction: sooty engine-shed brick,
 * dark blue-green pines. River Delta: whitewashed walls, yellow-green reeds and willows. Ruined Town: soot-grey
 * masonry, dusty leaves. Winter Front: cold dull brick (the snow caps do the rest).
 */
export const LOOKS: Record<RegionKind, Pick<Env, 'brickTint' | 'brickWash' | 'leaf' | 'leafWash' | 'leafOlive'>> = {
  farm: { brickTint: [1.02, 0.86, 0.84], brickWash: [0.62, 0.3, 0.22, 0.3], leaf: [0.97, 0.97, 0.95], leafOlive: 0.15 },
  rail: { brickTint: [0.9, 0.84, 0.86], brickWash: [0.42, 0.26, 0.22, 0.45], leaf: [0.8, 0.86, 0.92], leafWash: [0.18, 0.46, 0.4, 0.7], leafOlive: 0 },
  delta: { brickTint: [1.0, 1.0, 1.0], brickWash: [0.84, 0.82, 0.74, 0.72], leaf: [1.0, 0.92, 0.66], leafOlive: 0.2 },
  ruins: { brickTint: [0.9, 0.9, 0.94], brickWash: [0.47, 0.45, 0.45, 0.8], leaf: [0.82, 0.86, 0.8], leafWash: [0.36, 0.44, 0.3, 0.35], leafOlive: 0.1 },
  winter: { brickTint: [0.94, 0.94, 1.0], brickWash: [0.5, 0.36, 0.32, 0.35], leaf: [1, 1, 1], leafOlive: 0 },
};

export function setEnv(r: Renderer, name: EnvName, weather?: Weather, look?: RegionKind): number {
  const e = ENVS[name];
  const env: Env = { ...e, ...(look ? LOOKS[look] : null) };
  const f = weather?.flash ?? 0;
  if (f > 0) {
    const mix = (a: V3, b: V3, t: number): V3 => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
    env.sunCol = mix(e.sunCol, [3.2, 3.4, 4.2], f);
    env.sunDir = weather!.boltDir;
    env.ambient = mix(e.ambient, [0.35, 0.38, 0.5], f * 0.6);
    env.backdrop = mix(e.backdrop, [0.12, 0.14, 0.2], f * 0.5);
  }
  r.env = env;
  return e.head;
}

// ---------- terrain ----------
// Terrain is drawn by the gbuffer shader from world position; cells just mark where each material is.
const CELL_MAT: Record<number, number> = {
  [BRICK]: MAT_BRICK, [STEEL]: MAT_STEEL, [WATER]: MAT_WATER, [TREES]: MAT_FOLIAGE, [ICE]: MAT_ICE, [6 /* ROAD */]: 9 /* MAT_ROAD */,
  [RAIL]: MAT_RAIL,
};

function cellQuad(r: Renderer, type: number, x: number, y: number, size: number): void {
  const m = CELL_MAT[type];
  if (type === TREES) r.canopyRect(x, y, size, size, m);
  else if (m !== undefined) r.rectG(x, y, size, size, m);
}

/** pass 0 = everything under tanks, pass 1 = tree canopy. range = [cx0, cy0, cx1, cy1) in cells, to skip
 * what is off screen on big maps. */
export function drawCells(r: Renderer, c: Uint8Array, W: number, H: number, ox: number, oy: number, pass: number,
  range: readonly number[] = [0, 0, W, H]): void {
  const want = (t: number) => (pass === 1 ? t === TREES : t !== 0 && t !== TREES);
  const tx0 = Math.max(0, range[0] >> 1);
  const ty0 = Math.max(0, range[1] >> 1);
  const tx1 = Math.min(W >> 1, (range[2] + 1) >> 1);
  const ty1 = Math.min(H >> 1, (range[3] + 1) >> 1);
  for (let ty = ty0; ty < ty1; ty++) {
    for (let tx = tx0; tx < tx1; tx++) {
      const cx = tx * 2;
      const cy = ty * 2;
      const i = cy * W + cx;
      const a = c[i];
      if (a === c[i + 1] && a === c[i + W] && a === c[i + W + 1]) {
        if (want(a)) cellQuad(r, a, ox + cx * 4, oy + cy * 4, 8);
        continue;
      }
      for (let j = 0; j < 2; j++) for (let k = 0; k < 2; k++) {
        const t = c[i + j * W + k];
        if (want(t)) cellQuad(r, t, ox + (cx + k) * 4, oy + (cy + j) * 4, 4);
      }
    }
  }
}

// ---------- view ----------
/** Where the world sits on screen this frame: screen = world + (ox, oy); rect = the visible play area. */
export const view = { ox: FX, oy: FY, rect: [FX, FY, FS, FS] as number[] };

/** True if a screen-px point is within m px of the visible play area. */
function onView(sx: number, sy: number, m: number): boolean {
  const [x, y, w, h] = view.rect;
  return sx > x - m && sy > y - m && sx < x + w + m && sy < y + h + m;
}

// ---------- tanks ----------
export const P_TINT: V3[] = [[1.0, 0.76, 0.2], [0.38, 0.92, 0.42]];
const ARMOR_TINT: V3[] = [[0.75, 0.76, 0.82], [0.92, 0.92, 0.98], [1.0, 0.85, 0.42], [0.55, 0.92, 0.55]];
export const ENEMY_TINT: V3 = [0.84, 0.88, 0.98];
const HULL_TINT: V3 = [0.42, 0.4, 0.37]; // campaign AI hook: abandoned hulls are dark and dead

function tankTint(t: Tank, w: World): V3 {
  let c: V3;
  if (w.ai?.isHull(t)) return HULL_TINT; // campaign AI hook: abandoned hull (crew bailed)
  if (t.isPlayer) c = P_TINT[t.player];
  else if (t.bonus && (w.frame >> 3) & 1) c = [1.0, 0.28, 0.22];
  else if (t.etype === 3) c = ARMOR_TINT[Math.max(0, Math.min(3, t.hp - 1))];
  else c = ENEMY_TINT;
  if (!t.isPlayer && (w.freeze > 0 || t.stun > 0)) c = [c[0] * 0.6, c[1] * 0.75, Math.min(1, c[2] * 1.1)];
  return c;
}

export function tankSprite(r: Renderer, key: string, frame: number): Spr {
  return r.atlas.S[`${key}${frame ? 'b' : 'a'}`];
}

function drawTank(r: Renderer, w: World, t: Tank, head: number, time: number): void {
  const { ox, oy } = view;
  if (!onView(ox + t.cx, oy + t.cy, 110)) return;
  if (t.spawn > 0) {
    const seq = [0, 1, 2, 3, 2, 1];
    const f = seq[(t.spawn >> 2) % 6];
    r.fxSpr(r.atlas.S[`spawn${f}`], ox + t.x, oy + t.y, [0.75, 0.88, 1], 2.4);
    r.light(ox + t.cx, oy + t.cy, 14, 44, 0.5 + f * 0.25, 0.6 + f * 0.3, 1.0 + f * 0.3, false);
    return;
  }
  if (t.frozen > 0 && (w.frame >> 2) & 1) return;
  const frame = Math.floor(t.dist / 2) % 2;
  const rec = t.recoil > 2 ? 1 : 0;
  const x = Math.round(ox + t.x - DX[t.dir] * rec);
  const y = Math.round(oy + t.y - DY[t.dir] * rec);
  if (t.hover) r.glow(x + 8, y + 8, 13, [0.3, 0.6, 1.0], 0.5 + 0.2 * Math.sin(time * 9));
  if (w.region) drawCampaignTank(r, w, t, x, y, frame, time); // campaign looks: BABUSYA/DIDO layers, Dominion tanks
  else r.spr(tankSprite(r, t.isPlayer ? `p${t.level}` : `e${t.etype}`, frame), x, y, t.dir, tankTint(t, w), MAT_STD, t.hover ? 0.12 : 0, 1, t.flash > 0 ? 0.7 : 0);
  if (w.region && !t.isPlayer && BRACKET_ENVS.has(w.env) && !w.ai?.isHull(t)) drawEnemyBracket(r, x, y);
  const lightsOn = t.isPlayer || (w.freeze === 0 && t.stun === 0 && !w.ai?.isHull(t)); // campaign AI hook: hulls go dark
  if (lightsOn) {
    const c = t.isPlayer ? [1.0, 0.86, 0.62] : [1.0, 0.32, 0.22];
    const k = head * (t.isPlayer ? 1 : 0.8);
    r.spot(ox + t.cx + DX[t.dir] * 7, oy + t.cy + DY[t.dir] * 7, 6, 96, c[0] * k, c[1] * k, c[2] * k, true, DX[t.dir], DY[t.dir], 0.76, 0.95);
    r.light(ox + t.cx, oy + t.cy, 16, 26, 0.12 * head, 0.12 * head, 0.13 * head, false);
  } else if (t.stun > 0 && (w.frame & 7) < 2) {
    r.glow(x + 8, y + 8, 10, [0.4, 0.6, 1], 1.2);
  }
  if (t.shield > 0) {
    const s = r.atlas.S[`shield${(w.frame >> 1) & 1}`];
    r.fxSpr(s, x, y, [0.55, 0.9, 1], 1.6);
    r.light(x + 8, y + 8, 14, 30, 0.2, 0.45, 0.6, false);
  }
  if (w.region && t.isPlayer && t.armourMax > 0) drawArmourBar(r, t, x, y, w.frame, w.loaded(t));
}

// G2: at night and in rain a Dominion tank gets four dim red corner ticks just outside its 16 px box, unlit (laid over
// the finished image like the boss marks), so a dark hull out of every light still reads. A few pixels, no glow.
const BRACKET_ENVS = new Set<EnvName>(['night', 'rain']);
const BRACKET_COL: V3 = [0.78, 0.2, 0.12];
function drawEnemyBracket(r: Renderer, x: number, y: number): void {
  for (const [cx, cy, dx, dy] of [[x - 1, y - 1, 1, 1], [x + 16, y - 1, -1, 1], [x - 1, y + 16, 1, -1], [x + 16, y + 16, -1, -1]]) {
    r.topRect(cx, cy, 1, 1, BRACKET_COL, 0.7);
    r.topRect(cx + dx, cy, 1, 1, BRACKET_COL, 0.45);
    r.topRect(cx, cy + dy, 1, 1, BRACKET_COL, 0.45);
  }
}

// ---------- campaign tank looks (src/art/campaign-tanks.ts) ----------
/** BABUSYA / DIDO as layers (hull, tracks, one overlay per fitted part, the flag, kill rings), tinted with the
 * player's farm paint; a Dominion tank per type (the heavy one loses its skirts as it takes hits). */
function drawCampaignTank(r: Renderer, w: World, t: Tank, x: number, y: number, frame: number, time: number): void {
  const S = r.atlas.S;
  const wh = t.flash > 0 ? 0.7 : 0;
  const hb = t.hover ? 0.12 : 0;
  if (t.isPlayer) {
    const paint = BAB_PAINT[t.player] ?? BAB_PAINT[0];
    for (const n of babusyaLayers(t.player, t.fitted, t.vet, frame, Math.floor(time * 3 + t.player * 0.5) & 1)) {
      const s = S[n];
      if (s) r.spr(s, x, y, t.dir, paint, MAT_STD, hb, 1, wh);
    }
    return;
  }
  const hull = !!w.ai?.isHull(t);
  let c: V3 = hull ? HULL_TINT : t.bonus && (w.frame >> 3) & 1 ? [1.0, 0.3, 0.24] : [1, 1, 1];
  if (!hull && (w.freeze > 0 || t.stun > 0)) c = [c[0] * 0.6, c[1] * 0.75, Math.min(1, c[2] * 1.1)];
  r.spr(S[dominionSprite(t.etype, t.hp, frame)], x, y, t.dir, c, MAT_STD, hb, 1, wh);
}

/** A point on a tank sprite (px from its centre, facing up) turned to the tank's facing: [dx, dy] in the world. */
function onTank(dir: number, sx: number, sy: number): [number, number] {
  let x = sx;
  let y = sy;
  for (let i = 0; i < dir; i++) [x, y] = [-y, x];
  return [x, y];
}

/** Exhaust per engine, for a moving campaign player: [pipe points on the sprite, frames between puffs, smoke]. */
const EXHAUST: Record<string, [[number, number][], number, number]> = {
  '': [[[3.5, 6.5]], 46, 1.1], // the stock engine coughs black smoke now and then
  'tractor-diesel': [[[-4, 4.5]], 14, 0.45],
  'bus-engine': [[[-3.5, 7.5], [3.5, 7.5]], 18, 0.35],
  'turbo-diesel': [[[-3, 7.5], [3, 7.5]], 6, 0.22],
};

// ---------- campaign (region mode): armour bar, pickups, town flags ----------
/** Armour pips above a player tank: one 1 px pip per armour point on a dark strip, unlit. (x, y) = the tank's screen top-left. */
function drawArmourBar(r: Renderer, t: Tank, x: number, y: number, frame: number, loaded = 1): void {
  const n = t.armourMax;
  const bw = n * 2 - 1;
  const bx = x + 8 - Math.ceil(bw / 2);
  const by = y - 6;
  const frac = t.armour / n;
  const low = frac <= 0.3;
  const col: V3 = frac > 0.5 ? [1.0, 0.8, 0.25] : frac > 0.3 ? [1.0, 0.55, 0.15] : [1.0, 0.22, 0.14];
  r.ovRect(bx - 1, by - 1, bw + 2, 4, [0.02, 0.02, 0.03], 0.82);
  for (let i = 0; i < n; i++) {
    if (i < t.armour) {
      const blink = low && (frame >> 3) & 1;
      r.ovRect(bx + i * 2, by, 1, 2, blink ? [1, 0.7, 0.6] : col, 1);
    } else {
      r.ovRect(bx + i * 2, by, 1, 2, [0.28, 0.27, 0.3], 1);
    }
  }
  // reload: a thin line under the pips that grows back while the gun reloads (hidden when ready)
  if (loaded < 1) {
    r.ovRect(bx - 1, by + 3, bw + 2, 2, [0.02, 0.02, 0.03], 0.82);
    r.ovRect(bx, by + 3, Math.max(1, Math.round(bw * loaded)), 1, [0.75, 0.8, 0.88], 1);
  }
}

const RING_DOTS = 60;

/** A town's flag: the invader's red one while held, a ring that fills as it is freed, our gold one afterwards. */
function drawTownFlag(r: Renderer, town: World['towns'][number], time: number, head: number): void {
  const { ox, oy } = view;
  const fx = ox + town.cx;
  const fy = oy + town.cy;
  if (!onView(fx, fy, FREE_RADIUS + 20)) return;
  const S = r.atlas.S;
  const wave = Math.floor(time * 3) & 1;
  r.spr(S[`${town.freed ? 'flagMine' : 'flagEnemy'}${wave}`], Math.round(fx) - 3, Math.round(fy) - 14, 0, WHITE, MAT_STD, 0, 1);
  const k = Math.max(0.5, head);
  if (town.freed) {
    r.light(fx + 4, fy - 8, 12, 30, 0.45 * k, 0.32 * k, 0.1 * k, false);
    return;
  }
  r.light(fx + 4, fy - 8, 12, 26, 0.3 * k, 0.05 * k, 0.04 * k, false);
  const fill = town.progress * RING_DOTS;
  const pulse = 0.8 + 0.2 * Math.sin(time * 8);
  for (let i = 0; i < RING_DOTS; i++) {
    const a = -Math.PI / 2 + (i / RING_DOTS) * Math.PI * 2;
    const px = Math.round(fx + Math.cos(a) * FREE_RADIUS) - 1;
    const py = Math.round(fy + Math.sin(a) * FREE_RADIUS) - 1;
    if (i < fill) r.fxRect(px, py, 2, 2, [1.0, 0.7, 0.2], 0.95 * pulse);
    else r.fxRect(px, py, 2, 2, [1.0, 0.4, 0.3], 0.22);
  }
  if (town.progress > 0) r.glow(fx, fy, 10, [1.0, 0.8, 0.3], 0.25 * town.progress * pulse);
}

// ---------- campaign Phase 2: depot targets ----------
/** Damage stage of a depot target's sprite: 0 intact, 1 holed, 2 burning, 3 wreck. */
function depotStage(d: DepotState): number {
  return d.destroyed ? 3 : d.hp <= 2 ? 2 : d.hp <= d.max / 2 + 1 ? 1 : 0;
}

/** Hit flash, a fire glow while it burns, and a flickering light that throws shadows. */
function drawDepot(r: Renderer, d: DepotState, time: number): void {
  const { ox, oy } = view;
  const x = ox + d.cx;
  const y = oy + d.cy;
  if (!onView(x, y, 60)) return;
  const st = depotStage(d);
  const s = r.atlas.S[`${d.kind === 'fuel' ? 'depotFuel' : 'depotAmmo'}${st}`];
  r.spr(s, Math.round(x) - 8, Math.round(y) - 8, 0, WHITE, st === 3 ? MAT_STD : MAT_METAL, st === 3 ? 0 : 0.05, 1, d.hitT > 0 ? 0.6 * (d.hitT / 8) : 0);
  const burning = d.destroyed ? d.burnT < 60 * 25 : st >= 1;
  const fl = 0.65 + 0.35 * Math.sin(time * 19 + d.cx) * Math.sin(time * 7.3 + d.cy);
  if (burning) {
    // small licks of flame on the sprite, a modest flickering light around it: the sprite must stay readable
    const k = d.destroyed ? 1 : st === 2 ? 0.7 : 0.3;
    r.light(x, y - 2, 14, 50 + 30 * k, 0.55 * k * fl, 0.24 * k * fl, 0.06 * k * fl, true);
    if (st >= 2) {
      const flick = (time * 9 + d.cx) % 3;
      r.glow(x - 3 + (flick > 1 ? 1 : 0), y - 1, 1.6 + k, [1, 0.55, 0.15], 0.55 * fl);
      r.glow(x + 4, y + 3 - (flick > 2 ? 1 : 0), 1.2 + k, [1, 0.7, 0.25], 0.45 * fl);
    }
  } else if (d.destroyed) {
    r.glow(x, y, 4, [1, 0.4, 0.1], 0.35 * fl); // smouldering
  }
}

function drawPickup(r: Renderer, p: World['pickups'][number], time: number): void {
  const { ox, oy } = view;
  const sx = ox + p.x;
  const sy = oy + p.y;
  if (!onView(sx, sy, 20) || !World.pickupVisible(p)) return;
  // the item itself (a heap of scrap, a wooden parts crate: src/art/campaign-items.ts), no ring or halo round it;
  // a glint runs over it now and then, and a faint light keeps it visible at night
  const part = p.kind === 'part';
  const s = r.atlas.S[part ? 'itemCrate' : 'itemScrap'];
  const x0 = Math.round(sx - s.w / 2);
  const y0 = Math.round(sy - s.h / 2);
  r.spr(s, x0, y0, 0, WHITE, MAT_STD, 0.05, 1);
  const c: V3 = part ? [1.0, 0.85, 0.45] : [0.85, 0.9, 1.0];
  r.light(sx, sy - 3, 10, part ? 18 : 15, c[0] * 0.22, c[1] * 0.22, c[2] * 0.22, false);
  const cyc = (time * 0.8 + (p.x * 0.013 + p.y * 0.029)) % 1;
  if (cyc < 0.14) {
    const k = Math.sin((cyc / 0.14) * Math.PI);
    const gx = x0 + (part ? 2 : 5);
    const gy = y0 + (part ? 1 : 1);
    r.fxRect(gx, gy, 1, 1, [1, 1, 0.9], 3 * k);
    r.fxRect(gx - 1, gy, 3, 1, [1, 1, 0.9], 1.2 * k);
    r.fxRect(gx, gy - 1, 1, 3, [1, 1, 0.9], 1.2 * k);
  }
}

// ---------- world ----------
export function drawWorld(r: Renderer, w: World, time: number, weather: Weather, cam: Camera | null = null): void {
  const head = setEnv(r, w.env, weather, w.region?.kind);
  const S = r.atlas.S;
  const map = w.map;
  let cells: number[];
  if (cam) {
    // big map: the camera picks the visible part; the renderer glides it by the sub-pixel remainder
    const s = cam.split();
    view.ox = -s.ix;
    view.oy = -s.iy;
    const { nw, nh } = r; // the whole native screen, sized to the window
    view.rect = [0, 0, nw, nh];
    r.scroll = [s.ix, s.iy];
    r.subpx = [s.fx, s.fy];
    r.setTerrainSize(w.pxW, w.pxH);
    cells = [Math.floor(s.ix / 4) - 1, Math.floor(s.iy / 4) - 1, Math.ceil((s.ix + nw) / 4) + 2, Math.ceil((s.iy + nh) / 4) + 2];
  } else {
    view.ox = FX;
    view.oy = FY;
    view.rect = [FX, FY, FS, FS];
    cells = [0, 0, map.w, map.h];
  }
  r.litRect = [...view.rect];
  const { ox, oy } = view;

  // one px past the view on the right and bottom, for the sub-pixel glide
  if (cam) r.rectG(0, 0, r.nw + 1, r.nh + 1, MAT_GROUND);
  else r.rectG(ox, oy, FS, FS, MAT_GROUND);
  drawCells(r, map.c, map.w, map.h, ox, oy, 0, cells);

  if (!w.hasBase) {
    // no eagle in region mode
  } else if (w.eagleAlive) {
    r.spr(S.eagle, ox + EAGLE_X, oy + EAGLE_Y, 0, WHITE, MAT_METAL, 0, 1);
    r.light(ox + EAGLE_X + 8, oy + EAGLE_Y + 6, 18, 30, 0.35 * head, 0.25 * head, 0.1 * head, false);
    if (w.baseShield > 0 || w.baseShieldHit > 0) {
      const breaking = w.baseShieldHit > 0;
      const k = breaking ? w.baseShieldHit / 40 : 0.55 + 0.15 * Math.sin(time * 3);
      if (!breaking || (w.frame & 2)) r.fxSpr(S.dome, ox + EAGLE_X - 2, oy + EAGLE_Y - 2, [0.45, 0.8, 1], (breaking ? 2.5 : 0.9) * k);
      r.light(ox + EAGLE_X + 8, oy + EAGLE_Y + 8, 14, 34, 0.15 * k, 0.35 * k, 0.6 * k, false);
    }
  } else {
    r.spr(S.eagleDead, ox + EAGLE_X, oy + EAGLE_Y, 0, WHITE, MAT_STD, 0, 0);
    const fl = 0.7 + 0.3 * Math.sin(time * 23) * Math.sin(time * 7);
    r.light(ox + EAGLE_X + 8, oy + EAGLE_Y + 10, 10, 60, 1.4 * fl, 0.55 * fl, 0.15 * fl, true);
    r.glow(ox + EAGLE_X + 8, oy + EAGLE_Y + 11, 7, [1, 0.5, 0.15], 1.2 * fl);
  }

  for (const d of w.depots) drawDepot(r, d, time);
  drawAmbient(r, w, ox, oy, time); // ambient hook: fires and streetlamps fixed in the map (src/game/ambient.ts)
  if (w.boss) drawWeakMarks(r, w.boss, ox, oy, w.frame); // weak-point ticks and the core's lock (unlit; under the boss's own warnings)
  w.boss?.draw(r, ox, oy, time, head); // Phase 4 boss hook
  for (const town of w.towns) drawTownFlag(r, town, time, head);
  for (const p of w.players) if (p) drawTank(r, w, p, head, time);
  for (const e of w.enemies) drawTank(r, w, e, head, time);
  w.abil?.draw(r, ox, oy, time); // Phase 3 hook (under the canopy; use r.top for things above it)
  w.tricks?.draw(r, ox, oy, time); // Phase 3 hook
  w.events?.draw(r, ox, oy, time); // Phase 5 events hook (markers and objectives, unlit overlay)
  w.arena?.draw(r, ox, oy, time); // ?arena= labels and the artillery pad (unlit overlay)

  for (const b of w.bullets) {
    const bx = ox + b.x;
    const by = oy + b.y;
    if (!onView(bx, by, 50)) continue;
    // flight vector: DX/DY of dir for tank shells; boss shells can fly at any angle (Bullet.aim)
    const ux = b.ux;
    const uy = b.uy;
    if (b.mg) {
      // Phase 4 boss hook: machine-gun tracer, a small hot dash (pixel by pixel when it flies at an angle)
      if (b.free) for (let i = -1; i <= 1; i++) r.fxRect(Math.round(bx - 0.5 + ux * i), Math.round(by - 0.5 + uy * i), 1, 1, [1, 0.75, 0.35], 3);
      else r.fxRect(Math.round(bx - 1 - DX[b.dir]), Math.round(by - 1 - DY[b.dir]), DX[b.dir] ? 3 : 2, DY[b.dir] ? 3 : 2, [1, 0.75, 0.35], 3);
      r.glow(bx, by, 3, [1, 0.6, 0.3], 1.2);
      continue;
    }
    // the shell sprite, turned to its flight angle when it flies off the 4 directions
    const shell = (tint: V3, whiten: number) => {
      if (b.free) r.sprRot(S.bullet, Math.round(bx), Math.round(by), Math.atan2(ux, -uy), tint, MAT_STD, 0.12, 1, whiten);
      else r.spr(S.bullet, Math.round(bx - 2), Math.round(by - 2), b.dir, tint, MAT_STD, 0.12, 1, whiten);
    };
    if (b.dmg >= 3) {
      // Phase 4 boss hook: the heavy shell, big and hot with a long trail
      shell([1, 0.7, 0.5], 0.6);
      r.glow(bx, by, 9, [1, 0.4, 0.15], 3);
      for (let i = 1; i <= 6; i++) r.glow(bx - ux * i * 3, by - uy * i * 3, 5 - i * 0.6, [1, 0.35, 0.12], 1.8 - i * 0.25);
      r.light(bx, by, 12, 70, 1.6, 0.6, 0.25, true);
      continue;
    }
    shell(WHITE, 0);
    const c: V3 = b.owner.isPlayer ? [1.0, 0.85, 0.5] : [1.0, 0.4, 0.25];
    r.glow(bx, by, 5, c, 2.2);
    for (let i = 1; i <= 3; i++) r.glow(bx - ux * i * 3, by - uy * i * 3, 3.5 - i * 0.6, c, 1.2 - i * 0.3);
    r.light(bx, by, 12, 40, c[0] * 1.3, c[1] * 1.3, c[2] * 1.3, true);
  }

  for (const p of w.parts) {
    const k = 1 - p.life / p.max;
    if (!onView(ox + p.x, oy + p.y, 20)) continue;
    if (p.kind === 0 || p.kind === 3) {
      r.rectG(Math.round(ox + p.x), Math.round(oy + p.y - p.z * 0.3), 1, 1, MAT_STD, p.col, Math.min(1, p.z / 10 + 0.1));
    } else if (p.kind === 1) {
      r.glow(ox + p.x, oy + p.y - p.z * 0.3, 1.8, p.col, 3.5 * k);
    } else if (!r.hasFluid) {
      r.smoke(ox + p.x, oy + p.y, p.r, p.col, 0.45 * k * Math.min(1, p.life / 4));
    }
  }

  drawCells(r, map.c, map.w, map.h, ox, oy, 1, cells);

  r.top = true;
  for (const p of w.pickups) drawPickup(r, p, time);
  const pw = w.power;
  if (pw) {
    const left = 60 * 25 - pw.t;
    const vis = left < 180 ? (pw.t >> 2) & 1 : (pw.t >> 3) % 4 !== 0;
    const col = PW_COLORS[pw.type];
    const pulse = 0.7 + 0.3 * Math.sin(time * 6);
    if (vis) r.spr(S[`pw${pw.type}`], ox + pw.x, oy + pw.y, 0, WHITE, MAT_STD, 0.05, 1);
    r.glow(ox + pw.x + 8, oy + pw.y + 8, 14, col, 0.5 * pulse);
    r.light(ox + pw.x + 8, oy + pw.y + 8, 16, 48, col[0] * pulse, col[1] * pulse, col[2] * pulse, false);
  }
  r.top = false;

  for (const b of w.booms) {
    if (!b.big || b.t < 9) {
      const f = Math.min(2, Math.floor(b.t / (b.big ? 3 : 4)));
      r.fxSpr(S[`boom${f}`], Math.round(ox + b.x - 8), Math.round(oy + b.y - 8), WHITE, 2.2);
    } else {
      const f = Math.min(1, Math.floor((b.t - 9) / 10));
      r.fxSpr(S[`bigboom${f}`], Math.round(ox + b.x - 16), Math.round(oy + b.y - 16), WHITE, 2.6, 0, 1 - Math.max(0, b.t - 22) / 8);
    }
  }
  for (const f of w.flashes) {
    const k = (1 - f.t / f.max) ** 2 * 3;
    r.light(ox + f.x, oy + f.y, f.z, f.r, f.col[0] * k, f.col[1] * k, f.col[2] * k, true);
  }

  for (const d of w.decals) {
    if (d.k === 0) r.decalRect(ox + d.x, oy + d.y, d.w, d.h, d.col, d.a);
    else r.decalCircle(ox + d.x, oy + d.y, d.r, d.col, d.a);
  }
  w.decals.length = 0;

  weather.draw(r);
  fluidSources(r, w, weather, time);
  if (cam) {
    r.setCellMap(map.c, map.w, map.h, map.version, 0, 0, map.takeDirty());
    r.setKindMap(w.region?.kinds ?? null, map.w, map.h);
    r.setRailMap(railGeoFor(w.region), map.w, map.h);
  } else {
    r.setCells(map.c, map.version);
    r.setKindMap(null);
    r.setRailMap(null);
  }

  r.shocks = w.shocks.map((s) => ({
    x: ox + s.x, y: oy + s.y, r: (s.t / s.max) * 70 * s.size, s: 2.6 * s.size * (1 - s.t / s.max),
  }));
  r.shake = [(Math.random() - 0.5) * w.shake * 2, (Math.random() - 0.5) * w.shake * 2];
  r.aberr = 0.35 + Math.min(2, w.shake * 0.4);
  r.flash = [weather.flash * 0.05, weather.flash * 0.06, weather.flash * 0.09];
}

const WIND: Record<EnvName, [number, number]> = { day: [5, 2], dusk: [9, -3], night: [-20, 13], snow: [7, 6], rain: [-12, 8] };

/** Feed the smoke / heat / fire fluid and the water ripples from what happened this frame. */
function fluidSources(r: Renderer, w: World, weather: Weather, time: number): void {
  if (!r.hasFluid) return;
  const { ox, oy } = view;
  const dt = Math.min(1 / 30, r.dt);
  const f = dt * 60; // continuous sources are tuned per 60 fps frame
  for (const b of w.booms) {
    if (b.fx) continue;
    b.fx = true;
    const x = ox + b.x;
    const y = oy + b.y;
    const n = b.big ? 8 : 4;
    const sp = b.big ? 230 : 90;
    for (let i = 0; i < n; i++) {
      const a = (i / n) * Math.PI * 2;
      r.velSplat(x + Math.cos(a) * (b.big ? 6 : 3), y + Math.sin(a) * (b.big ? 6 : 3), b.big ? 7 : 4, Math.cos(a) * sp, Math.sin(a) * sp);
    }
    if (b.big) {
      r.dyeSplat(x, y, 14, 1.6, 1.4, 1.8);
      r.waveSplat(x, y, 16, 3.0);
    } else {
      r.dyeSplat(x, y, 5, 0.35, 0.5, 0.7);
      r.waveSplat(x, y, 6, 1.6);
    }
  }
  for (const fl of w.flashes) {
    if (fl.fx) continue;
    fl.fx = true;
    if (fl.vx === undefined || fl.vy === undefined) continue;
    r.velSplat(ox + fl.x, oy + fl.y, 5, fl.vx * 170, fl.vy * 170);
    r.dyeSplat(ox + fl.x, oy + fl.y, 4, 0.3, 0.35, 0.25);
  }
  for (const p of w.parts) {
    if (p.kind !== 2 || p.fx) continue;
    p.fx = true;
    r.dyeSplat(ox + p.x, oy + p.y, p.r * 1.3, Math.min(0.8, p.r * 0.07), 0.05, 0);
    r.velSplat(ox + p.x, oy + p.y, p.r, p.vx * 60, p.vy * 60);
  }
  for (const t of [...w.players, ...w.enemies]) {
    if (!t || !t.alive || t.spawn) continue;
    const moving = t.isPlayer ? t.moving : !t.blocked && w.freeze === 0 && t.stun === 0;
    if (!moving) continue;
    r.velSplat(ox + t.cx, oy + t.cy, 10, DX[t.dir] * 420 * dt, DY[t.dir] * 420 * dt);
    r.waveSplat(ox + t.cx + DX[t.dir] * 7, oy + t.cy + DY[t.dir] * 7, t.hover ? 10 : 7, (t.hover ? 1.2 : 0.6) * f);
    // campaign: BABUSYA's exhaust, by the engine fitted (src/art/campaign-tanks.ts draws the pipes)
    const ex = w.region && t.isPlayer ? EXHAUST[t.fitted.engine ?? ''] ?? EXHAUST[''] : null;
    if (ex && (w.frame + t.player * 7) % ex[1] === 0) {
      for (const [px, py] of ex[0]) {
        const [dx, dy] = onTank(t.dir, px, py);
        r.dyeSplat(ox + t.cx + dx, oy + t.cy + dy, 2.5, ex[2], 0.08, 0);
        r.velSplat(ox + t.cx + dx, oy + t.cy + dy, 3, -DX[t.dir] * 20, -DY[t.dir] * 20);
      }
    }
  }
  for (const b of w.bullets) {
    r.velSplat(ox + b.x, oy + b.y, 4, b.ux * 1500 * dt, b.uy * 1500 * dt);
    r.waveSplat(ox + b.x, oy + b.y, 4, 0.4 * f);
  }
  if (w.hasBase && !w.eagleAlive) {
    r.dyeSplat(ox + EAGLE_X + 8 + Math.sin(time * 3) * 2, oy + EAGLE_Y + 7, 6, 0.25 * f, 0.5 * f, 0.4 * f);
  }
  // campaign depots: a damaged target smokes, a destroyed one burns (fire + heat haze), then smoulders
  for (const d of w.depots) {
    const st = depotStage(d);
    if (st === 0 || !onView(ox + d.cx, oy + d.cy, 80)) continue;
    const x = ox + d.cx + Math.sin(time * 3 + d.cx) * 2;
    const y = oy + d.cy - 2;
    if (d.destroyed && d.burnT < 60 * 25) r.dyeSplat(x, y, 6, 0.55 * f, 0.3 * f, 0.07 * f);
    else if (d.destroyed) r.dyeSplat(x, y, 4, 0.18 * f, 0.06 * f, 0);
    else r.dyeSplat(x, y, st === 2 ? 5 : 4, (st === 2 ? 0.4 : 0.22) * f, (st === 2 ? 0.18 : 0.06) * f, st === 2 ? 0.04 * f : 0);
    r.velSplat(x, y - 3, 5, 0, -8 * f); // a rising column
  }
  w.boss?.fluid(r, ox, oy, f, time); // Phase 4 boss hook
  if (weather.kind === 'rain') {
    const [vx, vy, vw, vh] = view.rect;
    for (let i = 0; i < Math.max(1, Math.round(3 * f)); i++) r.waveSplat(vx + Math.random() * vw, vy + Math.random() * vh, 2, 0.9);
  }
  const wb = WIND[w.env];
  r.wind = [wb[0] * (1 + 0.4 * Math.sin(time * 0.37)), wb[1] * (1 + 0.4 * Math.cos(time * 0.29))];
}
