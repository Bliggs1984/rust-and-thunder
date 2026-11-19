// Building blocks for the region generators: every structure is a closed outline with walls 2 cells (8 px) thick on
// the even cell grid, so interiors and doorways line up with the tank grid (a tank covers 4 x 4 cells from an even
// cell) and a wall is one whole steel tile or two brick courses thick. Doorways are 4 cells wide. Floors go into the
// generator's ground-kind layer (Farm.k), under the walls too, so a wall shot away leaves floor, not field.
import { BRICK, EMPTY, GK_PLANKS, STEEL } from '../constants';
import type { Farm, Rect } from './gen';

/** Wall thickness in cells. */
export const WALL = 2;
/** Doorway width in cells (one tank). */
export const DOOR = 4;

/** A doorway: world side of the building (0 N, 1 E, 2 S, 3 W), offset along that side from the building's top/left
 * corner (even cells, at least WALL), width (default DOOR). */
export interface Door { side: number; at: number; len?: number }

/**
 * A plot with a front: local `a` runs along the frontage and `b` back from it, whichever way the plot faces.
 * f = the world side the front is on (0 N, 1 E, 2 S, 3 W); flip mirrors `a`.
 */
export class Plot {
  constructor(readonly x: number, readonly y: number, readonly w: number, readonly h: number, readonly f: number, readonly flip = false) {}
  /** frontage and depth in cells */
  get F(): number { return this.f === 0 || this.f === 2 ? this.w : this.h; }
  get D(): number { return this.f === 0 || this.f === 2 ? this.h : this.w; }
  /** World rect of the local rect (a, b) + (la, lb). */
  rect(a: number, b: number, la: number, lb: number): Rect {
    if (this.flip) a = this.F - a - la;
    switch (this.f) {
      case 0: return { x: this.x + a, y: this.y + b, w: la, h: lb };
      case 2: return { x: this.x + a, y: this.y + this.h - b - lb, w: la, h: lb };
      case 3: return { x: this.x + b, y: this.y + a, w: lb, h: la };
      default: return { x: this.x + this.w - b - lb, y: this.y + a, w: lb, h: la };
    }
  }
  /**
   * World rect of a doorway through a wall of the local building (a, b, la, lb). local = which wall: 0 front, 1 the
   * far end of `a`, 2 back, 3 the near end of `a`; `at` = cells along that wall from its low-a (or front) end.
   */
  doorRect(local: number, a: number, b: number, la: number, lb: number, at: number, len = DOOR): Rect {
    if (local === 0) return this.rect(a + at, b, len, WALL);
    if (local === 2) return this.rect(a + at, b + lb - WALL, len, WALL);
    if (local === 3) return this.rect(a, b + at, WALL, len);
    return this.rect(a + la - WALL, b + at, WALL, len);
  }
  /** The world side (0 N, 1 E, 2 S, 3 W) a local wall faces. */
  side(local: number): number {
    if (this.flip && (local === 1 || local === 3)) local = 4 - local;
    const t = this.f === 0 ? [0, 1, 2, 3] : this.f === 2 ? [2, 1, 0, 3] : this.f === 3 ? [3, 2, 1, 0] : [1, 2, 3, 0];
    return t[local];
  }
}

/** Fill a world rect of cells, whatever is there. */
function fill(g: Farm, r: Rect, t: number): void { g.fill(r.x, r.y, r.w, r.h, t); }

/** Cut a doorway (or a breach) through a building's wall. */
export function cutDoor(g: Farm, r: Rect, d: Door): void {
  const len = d.len ?? DOOR;
  if (d.side === 0) g.fill(r.x + d.at, r.y, len, WALL, EMPTY);
  else if (d.side === 2) g.fill(r.x + d.at, r.y + r.h - WALL, len, WALL, EMPTY);
  else if (d.side === 3) g.fill(r.x, r.y + d.at, WALL, len, EMPTY);
  else g.fill(r.x + r.w - WALL, r.y + d.at, WALL, len, EMPTY);
}

/**
 * A rectangular building: brick walls WALL thick round an open floor, doorways cut through, the floor kind laid over
 * the whole footprint. posts = steel corner pillars (barns, halls, stations, anything big).
 */
export function building(g: Farm, r: Rect, floor: number, doors: Door[], posts = false): void {
  fill(g, r, BRICK);
  g.fill(r.x + WALL, r.y + WALL, r.w - 2 * WALL, r.h - 2 * WALL, EMPTY);
  g.kind(r.x, r.y, r.w, r.h, floor);
  if (posts) {
    for (const [px, py] of [[r.x, r.y], [r.x + r.w - WALL, r.y], [r.x, r.y + r.h - WALL], [r.x + r.w - WALL, r.y + r.h - WALL]]) g.fill(px, py, WALL, WALL, STEEL);
  }
  for (const d of doors) cutDoor(g, r, d);
}

/**
 * A building whose footprint is the union of several rects (L and T shapes, a nave with a porch): the outline is
 * walled WALL thick, the inside is one open floor.
 */
export function shape(g: Farm, rects: Rect[], floor: number): void {
  const inside = (x: number, y: number) => rects.some((r) => x >= r.x && y >= r.y && x < r.x + r.w && y < r.y + r.h);
  for (const r of rects) {
    for (let y = r.y; y < r.y + r.h; y++) {
      for (let x = r.x; x < r.x + r.w; x++) {
        let wall = false;
        for (let j = -WALL; j <= WALL && !wall; j++) for (let i = -WALL; i <= WALL; i++) if (!inside(x + i, y + j)) { wall = true; break; }
        g.set(x, y, wall ? BRICK : EMPTY);
      }
    }
    g.kind(r.x, r.y, r.w, r.h, floor);
  }
}

/** A row of terraced houses along a wall line: units share party walls, each with its own doorway on `side`. */
export function terrace(g: Farm, r: Rect, side: number, floor = GK_PLANKS): void {
  const horiz = side === 0 || side === 2;
  const len = horiz ? r.w : r.h;
  const n = Math.max(1, Math.floor((len - WALL) / 8));
  building(g, r, floor, []);
  for (let k = 0; k < n; k++) {
    const at = k * 8;
    // party wall (not before the first unit), then the unit's doorway
    if (k > 0) {
      if (horiz) g.fill(r.x + at, r.y, WALL, r.h, BRICK);
      else g.fill(r.x, r.y + at, r.w, WALL, BRICK);
    }
    const last = k === n - 1;
    const room = (last ? len - WALL : at + 8) - (at + WALL);
    cutDoor(g, r, { side, at: at + WALL + (room >= 6 && g.rng() < 0.5 ? 2 : 0) });
  }
}

/** Battle damage that leaves the plan readable: a breach in a wall with ragged ends and a little rubble thrown out. */
export function breach(g: Farm, r: Rect, side: number, at: number, len: number, set: (x: number, y: number, t: number) => void): void {
  for (let k = 0; k < len; k++) {
    for (let d = 0; d < WALL; d++) {
      const x = side === 1 ? r.x + r.w - 1 - d : side === 3 ? r.x + d : r.x + at + k;
      const y = side === 0 ? r.y + d : side === 2 ? r.y + r.h - 1 - d : r.y + at + k;
      // ragged ends: the outer course survives a cell further in on one end, the inner on the other
      if ((k === 0 && d === 0 && g.rng() < 0.5) || (k === len - 1 && d === 1 && g.rng() < 0.5)) continue;
      set(x, y, EMPTY);
    }
  }
}

/** A corner blown off a building: the walls inside a quarter circle are gone. corner: 0 NW, 1 NE, 2 SE, 3 SW. */
export function blowCorner(g: Farm, r: Rect, corner: number, rad: number, set: (x: number, y: number, t: number) => void): void {
  const cx = corner === 0 || corner === 3 ? r.x : r.x + r.w;
  const cy = corner === 0 || corner === 1 ? r.y : r.y + r.h;
  // whole 2 x 2 blocks go, so what's left of the walls ends in clean steps, not loose cells
  for (let y = r.y; y < r.y + r.h; y += 2) {
    for (let x = r.x; x < r.x + r.w; x += 2) {
      if (Math.hypot(x + 1 - cx, y + 1 - cy) >= rad + (g.rng() - 0.5) * 1.5) continue;
      for (let j = 0; j < 2; j++) for (let i = 0; i < 2; i++) set(x + i, y + j, EMPTY);
    }
  }
}
