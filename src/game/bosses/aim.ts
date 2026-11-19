// Boss guns that aim off the 4 grid directions (design call 2026-10-16: "bosses shoot diagonally, harder to cheese").
// Tank shells fly in the 4 directions; boss shells carry a unit vector (Bullet.aim, world.ts) so they can fly at any
// angle. Angles here are radians clockwise from up (screen y down): the vector is (sin a, -cos a), the same as
// Renderer.sprRot, which draws the turrets at their real angle.
// - Main guns (GRINDER / FROSTBITE, the train's gun cars): the turret slews smoothly toward the player at its old
//   turn rate; once its barrel line passes within the gun's slack of the player it locks, glows and beeps for the
//   usual tell with the dotted warning line along the locked angle, then fires along it. No lead: a player who keeps
//   moving across the line during the tell is missed; one who sits still is hit wherever they are.
// - Machine guns and bunker guns: the 8 directions (the nearest one to the player), so bursts read as the old ones.
import type { Renderer } from '../../gl/renderer';
import { DX, DY, STEEL } from '../constants';
import type { GameMap } from '../map';
import { Bullet, type Tank } from '../world';

export const QUARTER = Math.PI / 2;
export const EIGHTH = Math.PI / 4;

/** Angle (radians clockwise from up) of the direction (dx, dy). */
export const angOf = (dx: number, dy: number): number => Math.atan2(dx, -dy);

/** Unit vector of angle a; exact on the quarter turns, so a shell fired straight behaves like a tank shell. */
export function vecOf(a: number): [number, number] {
  const q = a / QUARTER;
  if (Math.abs(q - Math.round(q)) < 1e-6) {
    const d = ((Math.round(q) % 4) + 4) % 4;
    return [DX[d], DY[d]];
  }
  return [Math.sin(a), -Math.cos(a)];
}

/** Angle of quarter direction d (UP 0, RIGHT 1, DOWN 2, LEFT 3). */
export const angOfDir = (d: number): number => (d & 3) * QUARTER;

/** The nearest quarter direction to angle a. */
export const dirOfAng = (a: number): number => ((Math.round(a / QUARTER) % 4) + 4) % 4;

/** The nearest of the 8 directions to (dx, dy), as an angle. */
export const snap8 = (dx: number, dy: number): number => Math.round(angOf(dx, dy) / EIGHTH) * EIGHTH;

/** Signed shortest turn from angle a to angle b, in (-PI, PI]. */
export function angDiff(a: number, b: number): number {
  let d = (b - a) % (Math.PI * 2);
  if (d > Math.PI) d -= Math.PI * 2;
  else if (d <= -Math.PI) d += Math.PI * 2;
  return d;
}

/** Angle a turned toward b by at most `max`. */
export const slewTo = (a: number, b: number, max: number): number => {
  const d = angDiff(a, b);
  return Math.abs(d) <= max ? b : a + Math.sign(d) * max;
};

/** Lateral offset of (x, y) from the line out of (ox, oy) along unit (ux, uy), and the distance along it. */
export function lineOff(ox: number, oy: number, ux: number, uy: number, x: number, y: number): [number, number] {
  return [Math.abs((x - ox) * uy - (y - oy) * ux), (x - ox) * ux + (y - oy) * uy];
}

/** No steel on the line out of (ox, oy) along (ux, uy) for len px. */
export function clearOf(m: GameMap, ox: number, oy: number, ux: number, uy: number, len: number): boolean {
  for (let s = 0; s < len; s += 4) if (m.at(Math.floor((ox + ux * s) / 4), Math.floor((oy + uy * s) / 4)) === STEEL) return false;
  return true;
}

/** A boss shell flying along (ux, uy). */
export function shellAt(x: number, y: number, ux: number, uy: number, speed: number, owner: Tank, power: boolean): Bullet {
  return new Bullet(x, y, 0, speed, owner, power, false, 0).aim(ux, uy);
}

/** The main-gun tell's blinking dotted line from (mx, my) along (ux, uy), screen px, from px `a` to `b` out. */
export function tellLine(r: Renderer, mx: number, my: number, ux: number, uy: number, a: number, b: number, fade: number, top = false): void {
  for (let s = a; s < b; s += 8) {
    const x = Math.round(mx + ux * s) - 1;
    const y = Math.round(my + uy * s) - 1;
    if (top) r.ovRect(x, y, 2, 2, [1, 0.3, 0.15], 0.85 * (1 - s / fade));
    else r.fxRect(x, y, 2, 2, [1, 0.3, 0.15], 0.9 * (1 - s / fade));
  }
}
