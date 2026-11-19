// Ambient light sources fixed in a region's map (RegionSpec.ambient, picked by the generator): Ruined Town's burning
// buildings, street fires and streetlamps. Visual only: nothing here touches the game state. One hook in draw.ts
// (drawWorld) calls drawAmbient every frame after the env is set.
// Cheap on purpose (it has to run on ordinary PCs): only spots on screen draw, each fire is one shadowed light, a glow,
// a handful of 1 px flame and ember rects and one smoke/heat splat; a lamp is three gbuffer rects and one light.
// The ruins' night is also lifted a little here (RUINS_NIGHT) so walls read as silhouettes against the fire glow,
// with a faint warm glow of distant fires along the top edge of the screen (Env.horizon).
import type { Renderer } from '../gl/renderer';
import { DX, DY, MAT_METAL } from './constants';
import type { AmbientSpot } from './region';
import type { World } from './world';

type V3 = [number, number, number];

/** Ruined Town at night: brighter ambient and moonlight, thicker fog (so the fire light shows in the air), and the
 * horizon glow. Applied over ENVS.night only on maps with ambient spots. */
export const RUINS_NIGHT = {
  ambient: [0.07, 0.072, 0.115] as V3,
  sunCol: [0.17, 0.2, 0.34] as V3,
  fog: 0.36,
  horizon: [0.11, 0.035, 0.008] as V3,
};

/** Tuning. Radii in native px; light colours are linear HDR. */
const FIRE = { light: [1.0, 0.42, 0.12] as V3, k: [1.2, 0.75], r: [66, 46], z: 12 };
/** lamps light without shadows (cheap: the fires carry the shadows) */
const LAMP = { light: [0.95, 0.62, 0.3] as V3, cool: [0.5, 0.66, 0.9] as V3, k: 0.5, r: 58, z: 20, arm: 5, working: 0.38, coolBelow: 0.07 };

const FLAME_OUT: V3 = [1, 0.36, 0.08];
const FLAME_IN: V3 = [1, 0.72, 0.28];
const EMBER: V3 = [1, 0.5, 0.16];
const POST: V3 = [0.3, 0.31, 0.34];

/** The spots on this world's map (none outside the regions that have them). */
export function ambientSpots(w: World): readonly AmbientSpot[] {
  return w.region?.ambient ?? [];
}

/** Draw every ambient spot near the view, feed the fluid, and lift the env for the ruins at night. (ox, oy) = world to
 * screen offset; called after setEnv. */
export function drawAmbient(r: Renderer, w: World, ox: number, oy: number, time: number): void {
  const spots = ambientSpots(w);
  if (!spots.length) return;
  if (w.env === 'night') {
    r.env.ambient = RUINS_NIGHT.ambient.map((v, i) => Math.max(v, r.env.ambient[i])) as V3;
    r.env.sunCol = RUINS_NIGHT.sunCol.map((v, i) => Math.max(v, r.env.sunCol[i])) as V3;
    r.env.fog = RUINS_NIGHT.fog;
    r.env.horizon = RUINS_NIGHT.horizon;
  }
  // the fire glow and lamps matter at night; by day the fires still burn (smaller lights), lamps are off
  const night = w.env === 'night' ? 1 : w.env === 'dusk' || w.env === 'rain' ? 0.7 : 0.35;
  const [vx, vy, vw, vh] = [0, 0, r.nw, r.nh];
  const f = Math.min(1 / 30, r.dt) * 60;
  for (const s of spots) {
    const x = ox + s.x;
    const y = oy + s.y;
    const m = s.kind === 2 ? 70 : 90; // lights reach in from off screen
    if (x < vx - m || y < vy - m || x > vx + vw + m || y > vy + vh + m) continue;
    if (s.kind === 2) lamp(r, s, x, y, time, night);
    else fire(r, s, x, y, time, night, f, x > vx - 12 && y > vy - 12 && x < vx + vw + 12 && y < vy + vh + 30);
  }
}

/** A burning building (kind 0) or a street fire (kind 1): pixel flames, embers, a flickering shadowed light, smoke. */
function fire(r: Renderer, s: AmbientSpot, x: number, y: number, t: number, night: number, f: number, onScreen: boolean): void {
  const big = s.kind === 0;
  const sz = s.size;
  const fl = 0.78 + 0.22 * Math.sin(t * 13 + s.seed * 50) * Math.sin(t * 5.3 + s.seed * 20);
  const k = FIRE.k[big ? 0 : 1] * (0.65 + 0.35 * sz) * fl * (0.4 + 0.6 * night);
  const L = FIRE.light;
  r.light(x, y - 3, FIRE.z, FIRE.r[big ? 0 : 1] * (0.75 + 0.35 * sz), L[0] * k, L[1] * k, L[2] * k, true);
  if (!onScreen) return;
  r.glow(x, y - 2, (big ? 6 : 4) + 3 * sz, [1, 0.5, 0.15], 0.22 * fl);
  // flame tongues: 1 px columns, tallest in the middle, each with its own beat
  const n = big ? 4 + Math.round(sz * 4) : 3 + Math.round(sz * 2);
  const spread = (big ? 5 : 3) + sz * 4;
  const top = (big ? 4 : 2.5) + sz * 4;
  const bx = Math.round(x);
  const by = Math.round(y);
  for (let i = 0; i < n; i++) {
    const u = n === 1 ? 0 : (i / (n - 1) - 0.5) * spread;
    const ph = s.seed * 40 + i * 2.3;
    const hgt = top * (1 - (Math.abs(u) / (spread * 0.5 + 1)) * 0.7) * (0.55 + 0.45 * Math.sin(t * (6.5 + i * 0.9) + ph));
    const h = Math.max(1, Math.round(hgt));
    const fx = bx + Math.round(u);
    r.fxRect(fx, by - h, 1, h, FLAME_OUT, 0.8 * fl);
    if (h > 2) r.fxRect(fx, by - Math.ceil(h * 0.45), 1, Math.ceil(h * 0.45), FLAME_IN, 0.7 * fl);
  }
  r.fxRect(bx - Math.round(spread * 0.35), by, Math.max(2, Math.round(spread * 0.7)), 1, [1, 0.8, 0.45], 0.9 * fl); // the glowing bed
  // embers drifting up and downwind
  const ne = big ? 3 + Math.round(sz * 2) : 2;
  for (let j = 0; j < ne; j++) {
    const p = (t * (0.22 + 0.07 * j) + s.seed * 7.3 + j * 0.37) % 1;
    const ex = x + Math.sin((p + j) * 6 + s.seed * 10) * 2.5 + r.wind[0] * p * 0.5;
    const ey = y - 2 - p * (16 + 12 * sz) + r.wind[1] * p * 0.3;
    r.fxRect(Math.round(ex), Math.round(ey), 1, 1, EMBER, 1.8 * (1 - p));
  }
  if (r.hasFluid) {
    // a thin rising column: smoke, heat haze over the flames, a little fire colour at the base
    r.dyeSplat(x + Math.sin(t * 2 + s.seed * 9) * 1.5, y - 4, (big ? 3 : 2) + 2 * sz, (big ? 0.1 : 0.06) * sz * f, 0.1 * f, 0.03 * sz * f);
    r.velSplat(x, y - 7, 4, 0, -9 * f);
  }
}

/** A streetlamp on the kerb: a post with its arm out over the street; the working ones light a pool round them. */
function lamp(r: Renderer, s: AmbientSpot, x: number, y: number, t: number, night: number): void {
  const dx = DX[s.dir];
  const dy = DY[s.dir];
  const bx = Math.round(x);
  const by = Math.round(y);
  r.rectG(bx - 1, by - 1, 2, 2, MAT_METAL, POST, 0.85);
  for (let i = 1; i < LAMP.arm; i++) r.rectG(bx + dx * i, by + dy * i, 1, 1, MAT_METAL, POST, 0.9);
  const hx = bx + dx * LAMP.arm;
  const hy = by + dy * LAMP.arm;
  const working = s.seed < LAMP.working;
  r.rectG(hx - (dy ? 1 : 0), hy - (dx ? 1 : 0), dy ? 2 : 1, dx ? 2 : 1, MAT_METAL, working ? [0.9, 0.85, 0.7] : POST, 0.9);
  if (!working || night < 0.5) return;
  // a few buzz and blink
  const buzz = s.seed > LAMP.working - 0.05 ? (Math.sin(t * 31 + s.seed * 99) > 0.6 && Math.sin(t * 1.7 + s.seed * 40) > 0 ? 0.15 : 1) : 1;
  const c = s.seed < LAMP.coolBelow ? LAMP.cool : LAMP.light;
  const k = LAMP.k * buzz * night;
  r.light(hx, hy, LAMP.z, LAMP.r, c[0] * k, c[1] * k, c[2] * k, false);
  r.glow(hx, hy, 3, c, 0.3 * buzz);
  r.fxRect(hx - (dy ? 1 : 0), hy - (dx ? 1 : 0), dy ? 2 : 1, dx ? 2 : 1, c, 1.1 * buzz);
}
