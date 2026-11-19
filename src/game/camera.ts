// Camera for maps bigger than the screen. Follows the live players (their midpoint in co-op) with a
// short look-ahead in the direction they face, eases toward it, and stays inside the map.
// The renderer gets the integer part as `scroll` and the fraction as `subpx`, so the world is drawn on
// whole native pixels and the final pass glides the image by the remainder.
import { DX, DY } from './constants';

export interface CamTarget {
  cx: number;
  cy: number;
  dir: number;
  moving: boolean;
}

const LOOK = 22; // px of look-ahead in the facing direction
const EASE = 4.5; // 1/s; higher = tighter follow
const SNAP = 0.02; // px; closer than this counts as arrived (stops sub-pixel creep)
/** px from a tank's centre to the view edge that the camera keeps clear */
export const EDGE = 24;

export class Camera {
  /** top-left of the view in world px */
  x = 0;
  y = 0;
  private look = [0, 0];
  /** px from a tank's centre to the left/right and top/bottom view edges that the camera keeps clear; co-op uses
   * larger ones so neither tank ends up under the HUD's corner plates or command cluster */
  edgeX = EDGE;
  edgeY = EDGE;

  constructor(public viewW: number, public viewH: number, public mapW: number, public mapH: number) {}

  private clamp(x: number, y: number): [number, number] {
    const cx = this.mapW <= this.viewW ? (this.mapW - this.viewW) / 2 : Math.max(0, Math.min(this.mapW - this.viewW, x));
    const cy = this.mapH <= this.viewH ? (this.mapH - this.viewH) / 2 : Math.max(0, Math.min(this.mapH - this.viewH, y));
    return [cx, cy];
  }

  private goal(ts: CamTarget[], dt: number): [number, number] | null {
    if (!ts.length) return null;
    let mx = 0;
    let my = 0;
    let lx = 0;
    let ly = 0;
    for (const t of ts) {
      mx += t.cx;
      my += t.cy;
      if (t.moving) {
        lx += DX[t.dir] * LOOK;
        ly += DY[t.dir] * LOOK;
      }
    }
    const n = ts.length;
    // the look-ahead itself eases, so turning doesn't jerk the view
    const k = 1 - Math.exp(-2.5 * dt);
    this.look[0] += (lx / n - this.look[0]) * k;
    this.look[1] += (ly / n - this.look[1]) * k;
    let x = mx / n + this.look[0] - this.viewW / 2;
    let y = my / n + this.look[1] - this.viewH / 2;
    // every tank stays at least EDGE px inside the view (co-op: the look-ahead may not push a partner off)
    x = this.fit(x, ts.map((t) => t.cx), this.viewW, this.edgeX);
    y = this.fit(y, ts.map((t) => t.cy), this.viewH, this.edgeY);
    return this.clamp(x, y);
  }

  private fit(v: number, cs: number[], size: number, edge: number): number {
    const lo = Math.max(...cs) + edge - size;
    const hi = Math.min(...cs) - edge;
    return lo > hi ? (lo + hi) / 2 : Math.max(lo, Math.min(hi, v));
  }

  /** The view changed size (window resized): keep its centre and stay inside the map. */
  setView(w: number, h: number): void {
    if (w === this.viewW && h === this.viewH) return;
    const cx = this.x + this.viewW / 2;
    const cy = this.y + this.viewH / 2;
    this.viewW = w;
    this.viewH = h;
    [this.x, this.y] = this.clamp(cx - w / 2, cy - h / 2);
  }

  /** Jump straight to the targets (stage start, respawn far away). */
  snap(ts: CamTarget[]): void {
    this.look = [0, 0];
    const g = this.goal(ts, 0);
    if (g) [this.x, this.y] = g;
  }

  update(ts: CamTarget[], dt: number): void {
    const g = this.goal(ts, dt);
    if (!g) return;
    const k = 1 - Math.exp(-EASE * dt);
    this.x += (g[0] - this.x) * k;
    this.y += (g[1] - this.y) * k;
    if (Math.abs(g[0] - this.x) < SNAP) this.x = g[0];
    if (Math.abs(g[1] - this.y) < SNAP) this.y = g[1];
  }

  /** Integer scroll and the sub-pixel remainder for the renderer. */
  split(): { ix: number; iy: number; fx: number; fy: number } {
    const ix = Math.floor(this.x);
    const iy = Math.floor(this.y);
    return { ix, iy, fx: this.x - ix, fy: this.y - iy };
  }

  /** True if a world-px rect overlaps the view (plus a margin). */
  sees(x: number, y: number, w: number, h: number, margin = 16): boolean {
    return x + w > this.x - margin && y + h > this.y - margin && x < this.x + this.viewW + margin && y < this.y + this.viewH + margin;
  }
}
