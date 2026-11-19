// Small helpers shared by the helicopter and the final fight (src/game/bosses/heli.ts, final.ts).
import { DOWN, LEFT, RIGHT, UP } from '../constants';
import type { RGB, World } from '../world';

export const EPS = 1e-4;
export const rand = Math.random;
export const clamp = (v: number, a: number, b: number) => Math.max(a, Math.min(b, v));

export const overlap = (ax: number, ay: number, aw: number, ah: number, bx: number, by: number, bw: number, bh: number) =>
  ax < bx + bw - EPS && ax + aw > bx + EPS && ay < by + bh - EPS && ay + ah > by + EPS;

/** Dominant axis direction of (dx, dy). */
export function domDir(dx: number, dy: number): number {
  return Math.abs(dx) >= Math.abs(dy) ? (dx < 0 ? LEFT : RIGHT) : dy < 0 ? UP : DOWN;
}

/** Rotate a point of an up-facing S x S frame clockwise by `d` quarter turns. */
export function rotPt(px: number, py: number, d: number, S: number): [number, number] {
  switch (d & 3) {
    case 1: return [S - py, px];
    case 2: return [S - px, S - py];
    case 3: return [py, S - px];
    default: return [px, py];
  }
}

/** A rect of an up-facing S x S frame, rotated by `d` quarter turns (x, y, w, h). */
export function rotRect(r: readonly number[], d: number, S: number): [number, number, number, number] {
  const [ax, ay] = rotPt(r[0], r[1], d, S);
  const [bx, by] = rotPt(r[0] + r[2], r[1] + r[3], d, S);
  return [Math.min(ax, bx), Math.min(ay, by), Math.abs(bx - ax), Math.abs(by - ay)];
}

/** World px to an up-facing S x S frame whose top-left is (ox, oy). */
export function toLocal(wx: number, wy: number, ox: number, oy: number, d: number, S: number): [number, number] {
  const qx = clamp(wx - ox, 0, S - 0.01);
  const qy = clamp(wy - oy, 0, S - 0.01);
  switch (d & 3) {
    case 1: return [qy, S - qx];
    case 2: return [S - qx, S - qy];
    case 3: return [S - qy, qx];
    default: return [qx, qy];
  }
}

/** A radio line (skips an exact repeat of the last one). */
export function say(w: World, who: string, text: string, log?: (s: string) => void): void {
  const r = w.radio;
  if (r.length && r[r.length - 1].text === text) return;
  r.push({ who, text });
  if (r.length > 20) r.shift();
  log?.(`RADIO ${who} ${text}`);
}

/** A rising puff of smoke (black when heavy). */
export function smokePuff(w: World, x: number, y: number, heavy: boolean, z = 10): void {
  w.parts.push({
    x: x + (rand() - 0.5) * 4, y: y + (rand() - 0.5) * 4, z,
    vx: (rand() - 0.5) * 0.2, vy: -0.2 - rand() * 0.2, vz: 0,
    life: 0, max: heavy ? 110 : 70, col: heavy ? [0.09, 0.085, 0.08] : [0.2, 0.19, 0.18], kind: 2, r: (heavy ? 4.5 : 3) + rand() * 3,
  });
}

/** Flying debris (kind 0) from (x, y). */
export function debrisBurst(w: World, x: number, y: number, n: number, cols: RGB[], speed = 1.6, z = 8): void {
  for (let i = 0; i < n; i++) {
    const a = rand() * Math.PI * 2;
    const s = 0.4 + rand() * speed;
    w.parts.push({
      x, y, z, vx: Math.cos(a) * s, vy: Math.sin(a) * s, vz: 1 + rand() * 2,
      life: 0, max: 160 + Math.floor(rand() * 60), col: cols[i % cols.length], kind: 0, r: 1,
    });
  }
}

/** Frame-stamped event log for the sims. */
export function logTo(log: string[], frame: number, s: string): void {
  log.push(`${String(frame).padStart(6)} ${s}`);
  if (log.length > 500) log.splice(0, 100);
}
