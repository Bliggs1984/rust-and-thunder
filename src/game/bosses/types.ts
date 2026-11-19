// Phase 4: the boss interface. World.boss is any region boss; the callers (world.ts, ai.ts, abilities.ts, draw.ts,
// bot.ts, ui-campaign.ts, app.ts) only use the members below. BossLike is the subset of GRINDER's public API
// (src/game/boss.ts) that those callers use; every boss class implements it.
import type { Renderer } from '../../gl/renderer';
import type { Bullet, Tank } from '../world';

export type BossState = 'hidden' | 'lair' | 'hunt' | 'dying' | 'dead';

/** One weak point as the HUD sees it (the boss bar draws one segment group per part). */
export interface BossPartLike {
  id: string;
  name: string;
  short: string;
  kind: string;
  hp: number;
  max: number;
  hitT: number;
}

export interface BossLike {
  readonly kind: string;
  readonly name: string;
  readonly title: string;
  /** top-left of its 48 x 48 px box in world px (ai.ts detours round it; drone locks ride on it) */
  x: number;
  y: number;
  dir: number;
  readonly cx: number;
  readonly cy: number;
  state: BossState;
  revealed: boolean;
  parts: BossPartLike[];
  /** the part that kills it (the HUD's last row, with a lock while shells can't reach it) */
  readonly turret: BossPartLike;
  readonly present: boolean;
  readonly alive: boolean;
  exposed(): boolean;
  cleared(): boolean;
  townsToReveal(): number;
  hudShown(): boolean;
  overlaps(x: number, y: number, w: number, h: number): boolean;
  blocks(t: Tank, x: number, y: number): boolean;
  update(): void;
  reveal(): void;
  kill(pi?: number): void;
  bulletHit(b: Bullet): boolean;
  droneHit(x: number, y: number, dmg: number, pi: number): boolean;
  rocketHit(x: number, y: number, dir: number, dmg: number, pi: number): boolean;
  aimPoint(): [number, number];
  draw(r: Renderer, ox: number, oy: number, time: number, head: number): void;
  fluid(r: Renderer, ox: number, oy: number, f: number, time: number): void;
}

/**
 * Optional extras (heli / final branch). Callers check for them; GRINDER has none.
 * - hudKey: the HUD rebuilds the boss bar when it changes (a staged boss swaps its parts between phases).
 * - squadTarget: where ambush squads may aim a rocket at it now (null = out of reach, e.g. a helicopter flying high).
 * - goal: the region intro card's boss line ("FREE 3 VILLAGES TO ..."), after the village count.
 * - victory: true once the campaign's final boss is destroyed (the run flow can show the ending).
 * - partRect: a part's world box (x, y, w, h), or null when it isn't on the map now; the in-world weak-point
 *   markers (marks.ts drawWeakMarks) use it.
 */
export interface BossExtras {
  readonly hudKey?: string;
  squadTarget?(): [number, number] | null;
  readonly goal?: string;
  victory?: boolean;
  partRect?(p: BossPartLike): [number, number, number, number] | null;
  /** a drone launched now would get through its countermeasures (flares, smoke); absent = always (the bot asks) */
  droneOpen?(): boolean;
  /** a part's turned box (centre x, y, width, length, angle clockwise from up); the markers' ticks follow it */
  partBox?(p: BossPartLike): [number, number, number, number, number] | null;
}

export type RegionBoss = BossLike & BossExtras;
