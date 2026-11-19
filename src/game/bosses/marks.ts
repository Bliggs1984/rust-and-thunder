// Boss readability overlays, shared by all five bosses. Everything here goes through r.topRect: unlit, laid over the
// finished image after bloom, tone mapping and grading, so night, rain, smoke, searchlights and blasts can't darken or
// wash it out (it still moves with the world and shakes with it). Shapes are 1 px pixel art with a dark 1 px rim
// under a bright core, so they read on snow and on black ground alike.
// - OvPen: collects core pixels, then draws the rim (every pixel next to a core pixel, once) and the core.
// - ring(): a crisp pixel circle (cached offsets).
// - drawWeakMarks(): small corner ticks round each weak point that can be hurt now, a tiny lock on the locked core
//   (the part the HUD boss bar shows with a lock), nothing on destroyed parts.
import type { Renderer } from '../../gl/renderer';
import type { RGB } from '../world';
import type { RegionBoss } from './types';

const INK: RGB = [0.02, 0.02, 0.03];
const key = (x: number, y: number) => (y + 2048) * 8192 + (x + 2048);

/** Pixel pen: core pixels with their colour and alpha; flush() draws a dark rim round them, then the core. */
export class OvPen {
  private px = new Map<number, [number, number, RGB, number]>();

  dot(x: number, y: number, col: RGB, a: number): void {
    const X = Math.round(x);
    const Y = Math.round(y);
    this.px.set(key(X, Y), [X, Y, col, a]);
  }

  rect(x: number, y: number, w: number, h: number, col: RGB, a: number): void {
    const X = Math.round(x);
    const Y = Math.round(y);
    for (let j = 0; j < h; j++) for (let i = 0; i < w; i++) this.px.set(key(X + i, Y + j), [X + i, Y + j, col, a]);
  }

  get size(): number { return this.px.size; }

  /** Rim alpha `edge` (0 = no rim), 8-connected so diagonals get a rim too. */
  flush(r: Renderer, edge: number): void {
    if (!this.px.size) return;
    if (edge > 0) {
      const rim = new Set<number>();
      for (const [x, y] of this.px.values()) {
        for (let j = -1; j <= 1; j++) {
          for (let i = -1; i <= 1; i++) {
            const k = key(x + i, y + j);
            if (this.px.has(k) || rim.has(k)) continue;
            rim.add(k);
            r.topRect(x + i, y + j, 1, 1, INK, edge);
          }
        }
      }
    }
    for (const [x, y, col, a] of this.px.values()) r.topRect(x, y, 1, 1, col, a);
    this.px.clear();
  }
}

const RINGS = new Map<number, [number, number][]>();
/** Integer offsets of a 1 px circle of radius `rad`, in order round the circle (no doubled pixels). */
export function ring(rad: number): [number, number][] {
  const R = Math.max(1, Math.round(rad));
  let pts = RINGS.get(R);
  if (pts) return pts;
  pts = [];
  const seen = new Set<number>();
  const n = Math.max(16, Math.ceil(R * 8));
  for (let i = 0; i < n; i++) {
    const t = (i / n) * Math.PI * 2;
    const x = Math.round(Math.cos(t) * R);
    const y = Math.round(Math.sin(t) * R);
    const k = key(x, y);
    if (seen.has(k)) continue;
    seen.add(k);
    pts.push([x, y]);
  }
  RINGS.set(R, pts);
  return pts;
}

/** The HUD boss bar's red (#f0482a) and its lock's gold. */
const MARK_RED: RGB = [0.94, 0.28, 0.17];
const MARK_HIT: RGB = [1, 0.85, 0.7];
const LOCK_GOLD: RGB = [0.95, 0.78, 0.3];
/** 5 x 6 padlock */
const LOCK = ['.###.', '.#.#.', '#####', '##.##', '##.##', '#####'];
const pen = new OvPen();

/**
 * Weak-point markers: ticks at the corners of every live part that can be hurt now, a small lock on the core while
 * it is locked (the HUD's rule: the turret part, until exposed()). Only while the boss is revealed and fighting
 * (its HUD bar would show), only for parts on screen. Bosses opt in with partRect().
 */
export function drawWeakMarks(r: Renderer, b: RegionBoss, ox: number, oy: number, f: number): void {
  if (!b.partRect || !b.revealed || !b.alive || !b.hudShown()) return;
  const locked = !b.exposed();
  const breathe = 0.46 + 0.1 * Math.sin(f * 0.08);
  for (const p of b.parts) {
    if (p.hp <= 0) continue;
    const rc = b.partRect(p);
    if (!rc) continue;
    const x = Math.round(ox + rc[0]);
    const y = Math.round(oy + rc[1]);
    const w = Math.max(2, Math.round(rc[2]));
    const h = Math.max(2, Math.round(rc[3]));
    if (x + w < -8 || y + h < -8 || x > r.nw + 8 || y > r.nh + 8) continue;
    if (p === b.turret && locked) {
      const lx = x + Math.floor(w / 2) - 2;
      const ly = y + Math.floor(h / 2) - 3;
      for (let j = 0; j < LOCK.length; j++) for (let i = 0; i < 5; i++) if (LOCK[j][i] === '#') pen.dot(lx + i, ly + j, LOCK_GOLD, 0.72);
      continue;
    }
    // corner ticks just outside the part's box: 2 px arms on small parts, 3 px on big ones; bright for a moment when hit
    const hit = p.hitT > 0;
    const col = hit ? MARK_HIT : MARK_RED;
    const a = hit ? 0.95 : breathe;
    const arm = Math.min(w, h) < 14 ? 2 : 3;
    const box = b.partBox?.(p);
    if (box) {
      // a turned part (the train's wagons on a curve): the same ticks just outside its turned corners
      const [bx, by, bw, bh, ang] = box;
      const X = Math.round(ox + bx);
      const Y = Math.round(oy + by);
      const fx = Math.sin(ang);
      const fy = -Math.cos(ang);
      const hw = bw / 2 + 0.5;
      const hh = bh / 2 + 0.5;
      for (const sx of [-1, 1]) {
        for (const sy of [-1, 1]) {
          // corner = centre + across (-fy, fx) * sx hw + back (-fx, -fy) * sy hh; arms run back along both edges
          const cx = X - fy * sx * hw - fx * sy * hh - 0.5;
          const cy = Y + fx * sx * hw - fy * sy * hh - 0.5;
          for (let k = 0; k < arm; k++) {
            pen.dot(cx + fy * sx * k, cy - fx * sx * k, col, a);
            pen.dot(cx + fx * sy * k, cy + fy * sy * k, col, a);
          }
        }
      }
      continue;
    }
    const x0 = x - 1;
    const y0 = y - 1;
    const x1 = x + w;
    const y1 = y + h;
    for (const [cx, sx] of [[x0, 1], [x1, -1]]) {
      for (const [cy, sy] of [[y0, 1], [y1, -1]]) {
        for (let k = 0; k < arm; k++) {
          pen.dot(cx + sx * k, cy, col, a);
          pen.dot(cx, cy + sy * k, col, a);
        }
      }
    }
  }
  pen.flush(r, 0.38);
}
