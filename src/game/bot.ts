// Autopilot for region maps (demos, screenshot tests and the sim). It follows a distance field to the
// nearest enemy, because walking straight at it gets stuck on a big map, and shoots all the way. With no enemy
// close it drives to the nearest town still to free and waits on its flag; it patches when armour runs low.
import { DX, DY, STEEL } from './constants';
import { Flow } from './map';
import { TR } from './tricks';
import type { PInput, Tank, World } from './world';

const flowBot = new Flow();
/** Phase 4: its own field for the boss fight (the town/enemy field above keeps its state) */
const flowBoss = new Flow();
/** An enemy closer than this (Manhattan px) is hunted; otherwise the bot heads for a town flag. */
const HUNT_RANGE = 130;
/** progress check for the unstick rule (per world) */
const stuck = {
  w: null as World | null, x: 0, y: 0, f: 0, freed: 0, hp: 0, until: 0, alt: 0, progress: 0, lastFreed: 0, lastHp: 0, skip: new Set<string>(),
};
/** frames each enemy has been the bot's nearest without losing hp, and enemies it has given up on until a frame */
const chased = new WeakMap<Tank, { hp: number; n: number }>();
const gaveUp = new WeakMap<Tank, number>();
/** hit points left on the boss's parts (progress for the unstick rule) */
const bossHp = (w: World) => (w.boss ? w.boss.parts.reduce((a, q) => a + Math.max(0, q.hp), 0) : 0);
/** pressing a direction without moving (per world): since when, and a sidestep under way */
const wedge = { w: null as World | null, x: 0, y: 0, n: 0, side: 0, until: 0, flip: 0 };
/**
 * The bot's input for this update. On top of what it decides: a tank that pushes one way for 45 frames without
 * moving is wedged on something its own shell passes (a brick stub at a track's corner), so it sidesteps a third of
 * a second, to alternate sides, as a person would. (It sat on one such stub for 30 minutes on some Ruined Town maps.)
 */
export function regionBot(w: World): PInput {
  const inp = decide(w);
  const t = w.players[0];
  if (!t) return inp;
  if (wedge.w !== w) Object.assign(wedge, { w, x: t.x, y: t.y, n: 0, until: 0, flip: 0 });
  if (w.frame < wedge.until) return { ...inp, dir: wedge.side };
  if (inp.dir >= 0 && t.x === wedge.x && t.y === wedge.y) wedge.n++;
  else Object.assign(wedge, { x: t.x, y: t.y, n: 0 });
  if (wedge.n > 45) {
    wedge.n = 0;
    wedge.side = (inp.dir + (wedge.flip++ & 1 ? 1 : 3)) & 3;
    wedge.until = w.frame + 20;
  }
  return inp;
}

function decide(w: World): PInput {
  const t = w.players[0];
  if (!t || t.spawn) return { dir: -1, fire: false };
  let best: Tank | null = null;
  let bd = Infinity;
  for (const e of w.enemies) {
    if (!e.alive || e.spawn || (gaveUp.get(e) ?? 0) > w.frame) continue;
    const d = Math.abs(e.cx - t.cx) + Math.abs(e.cy - t.cy);
    if (d < bd) { bd = d; best = e; }
  }
  // the same nearest enemy for 25 s without hurting it (walled in, across water, behind the ruins): leave it be for a
  // minute. (On some Ruined Town maps the bot sat by one such tank for the whole 30 minutes and freed no town.)
  if (best) {
    const c = chased.get(best);
    if (!c || best.hp < c.hp) chased.set(best, { hp: best.hp, n: 0 });
    else if (++c.n > 60 * 25) {
      gaveUp.set(best, w.frame + 60 * 60);
      chased.delete(best);
      best = null;
      bd = Infinity;
    }
  }
  const ability = patchKey(w, t);
  // a player steps out of a marked artillery circle (tricks.ts barrage warning) instead of sitting in it
  const dodge = dodgeShells(w, t);
  if (dodge >= 0) return { dir: dodge, fire: true, ability };
  // and sidesteps a boss's heavy shell (the glow and beeps gave it away) coming down its line
  const side = dodgeHeavy(w, t);
  if (side >= 0) return { dir: side, fire: false, ability };

  // a town that 90 s of trying hasn't freed (a flag it can't reach or hold) is left for later
  if (stuck.w === w) {
    const hp = bossHp(w);
    if (w.stats.townsFreed !== stuck.lastFreed || hp < stuck.lastHp) {
      stuck.lastFreed = w.stats.townsFreed;
      stuck.progress = w.frame;
      if (hp >= stuck.lastHp) stuck.skip.clear();
    }
    stuck.lastHp = hp;
  }

  // nearest unfreed town flag (straight-line), used when no enemy is close
  let town: { cx: number; cy: number; name: string } | null = null;
  let td = Infinity;
  for (const tw of w.towns) {
    if (tw.freed || stuck.skip.has(tw.name)) continue;
    const d = Math.abs(tw.cx - t.cx) + Math.abs(tw.cy - t.cy);
    if (d < td) { td = d; town = tw; }
  }

  // unstick: no headway for 15 s (wedged on a wall, waiting on a flag that can't fill, a boss goal it can't reach):
  // drive to another objective for 8 s
  if (stuck.w !== w) {
    Object.assign(stuck, { w, x: t.x, y: t.y, f: w.frame, freed: w.stats.townsFreed, hp: bossHp(w), until: 0, alt: 0 });
    Object.assign(stuck, { progress: w.frame, lastFreed: w.stats.townsFreed, lastHp: bossHp(w), skip: new Set<string>() });
  }
  if (town && w.frame - stuck.progress > 60 * 90) {
    stuck.skip.add(town.name);
    stuck.progress = w.frame;
  }
  if (w.frame - stuck.f >= 60 * 15) {
    const hp = bossHp(w);
    const fighting = !!w.boss?.alive && hp < stuck.hp;
    if (Math.abs(t.x - stuck.x) + Math.abs(t.y - stuck.y) < 24 && w.stats.townsFreed === stuck.freed && !fighting) {
      stuck.until = w.frame + 60 * 8;
      stuck.alt++;
    }
    Object.assign(stuck, { x: t.x, y: t.y, f: w.frame, freed: w.stats.townsFreed, hp });
  }
  if (w.frame < stuck.until) {
    const open = w.towns.filter((tw) => !tw.freed);
    // with the towns done: try another side of the boss's weak point, 64 px out
    const side = (d: number) => { const [ax, ay] = w.boss!.aimPoint(); return { cx: ax + DX[d] * 64, cy: ay + DY[d] * 64 }; };
    const goal = open.length ? open[stuck.alt % open.length] : w.boss?.alive ? side(stuck.alt & 3) : w.towns[stuck.alt % Math.max(1, w.towns.length)];
    if (goal) {
      if (w.frame % 10 === 0 || flowBot.nw === 0) flowBot.compute(w.map, [[Math.round((goal.cx - 8) / 8), Math.round((goal.cy - 8) / 8)]]);
      return { dir: descend(t), fire: true, ability };
    }
  }

  // Phase 4: the region's boss, once it is out and every town is free (or it is close): flank it and shoot its side
  const boss = w.boss;
  // (the boss is the region's goal: once it is out, go for it even if a town is still held)
  const out = boss?.alive && w.towns.filter((tw) => tw.freed).length >= Math.min(3, w.towns.length);
  if (boss?.alive && (!town || out || Math.abs(boss.cx - t.cx) + Math.abs(boss.cy - t.cy) < 220) && (!best || bd > 60)) {
    return bossAttack(w, t, ability);
  }

  if (town && (!best || bd > HUNT_RANGE)) {
    if (td < 14) return { dir: -1, fire: !!best && bd < 200, ability }; // on the flag: hold still while it fills
    if (w.frame % 10 === 0 || flowBot.nw === 0) flowBot.compute(w.map, [[Math.round((town.cx - 8) / 8), Math.round((town.cy - 8) / 8)]]);
    return { dir: descend(t), fire: true, ability };
  }
  if (!best) return { dir: (w.frame >> 5) % 4, fire: true, ability };
  if (w.frame % 10 === 0 || flowBot.nw === 0) flowBot.compute(w.map, [[Math.round(best.x / 8), Math.round(best.y / 8)]]);
  let dir = descend(t);
  const dx = best.cx - t.cx;
  const dy = best.cy - t.cy;
  // in line with it: face it. Only where the tank would still be in line after the turn snaps it to the 8 px grid;
  // otherwise it turns, snaps back out of line, drives in again and never gets its gun round (seen beside a steel
  // gate post, with a dug-in tank just past it).
  const inX = Math.abs(dx) < 6 && Math.abs(best.cx - (Math.round(t.x / 8) * 8 + 8)) < 6;
  const inY = Math.abs(dy) < 6 && Math.abs(best.cy - (Math.round(t.y / 8) * 8 + 8)) < 6;
  if (inX || inY) dir = inX ? (dy < 0 ? 0 : 2) : dx < 0 ? 3 : 1;
  return { dir: dir < 0 ? t.dir : dir, fire: true, ability };
}

/** when the bot's armour went low, and its last patch (per world) */
const patching = { w: null as World | null, low: -1, last: -1e9 };
/** frames a person takes to notice low armour, and between two presses of the patch key */
const PATCH_REACT = 30;
const PATCH_PRESS = 15;
/**
 * The patch key (ability 4) the way a person uses it: half a second after the armour drops low, then a press every
 * quarter second while it stays low. (It used to press on the very frame, every frame, which no burst could beat: with
 * a few hundred scrap the bot could not be knocked out, so the later, richer regions measured far too easy.)
 */
function patchKey(w: World, t: Tank): number {
  if (patching.w !== w) Object.assign(patching, { w, low: -1, last: -1e9 });
  const low = t.armour <= 4 && t.armour < t.armourMax;
  if (!low) { patching.low = -1; return 0; }
  if (patching.low < 0) patching.low = w.frame;
  if (w.frame - patching.low < PATCH_REACT || w.frame - patching.last < PATCH_PRESS) return 0;
  if (w.charges[3] <= 0 && w.scrap < 15) return 0;
  // the 15 s cooldown: a person watches the slot fill and presses within a quarter second of it lighting up
  if (w.frame - (w.patchReady[t.player] ?? 0) < PATCH_PRESS) return 0;
  patching.last = w.frame;
  return 4;
}

let bossGoal: [number, number] | null = null;
const nudge = { x: 0, y: 0, f: 0 };
let bossWorld: World | null = null;
/**
 * Boss fight: drive to a spot 72 px off one of the sides (or the back) of the boss's current weak point (aimPoint), nearest
 * first, then face it and fire.
 * Drones go in whenever there is a charge and it is in front.
 */
function bossAttack(w: World, t: Tank, ability: number): PInput {
  const b = w.boss!;
  // aim at the weak point that takes damage now (the train's engine is locked until both gun cars are gone)
  let [ax, ay] = b.aimPoint();
  // the heavy tank (GRINDER, the final fight's FROSTBITE): shells only count on a skirt from its side, then on the
  // turret through the open side or from behind. (aimPoint is the drone's pick, a sponson first, which shells from the
  // side mostly bounce off: the bot used to waste two shells in three as NO PEN.)
  let sides = [1, 3, 2];
  const hv = heavyTank(b);
  if (hv) {
    const mid = (q: HeavyPart): [number, number] => { const r = hv.partRect(q); return [r[0] + r[2] / 2, r[1] + r[3] / 2]; };
    const skirts = hv.parts.filter((q) => q.kind === 'skirt');
    const live = skirts.filter((q) => q.hp > 0);
    if (live.length === skirts.length && live.length) {
      let bd = Infinity;
      for (const q of live) {
        const [qx, qy] = mid(q);
        const d = Math.abs(qx - t.cx) + Math.abs(qy - t.cy);
        if (d < bd) { bd = d; [ax, ay] = [qx, qy]; sides = [q.side < 0 ? 3 : 1]; }
      }
    } else {
      [ax, ay] = mid(hv.turret);
      sides = [...skirts.filter((q) => q.hp <= 0).map((q) => (q.side < 0 ? 3 : 1)), 2];
    }
  }
  const dx = ax - t.cx;
  const dy = ay - t.cy;
  const facing = Math.abs(dx) >= Math.abs(dy) ? (dx < 0 ? 3 : 1) : dy < 0 ? 0 : 2;
  const fort = b.kind === 'final' && !b.parts.some((q) => q.kind === 'skirt');
  const slack = fort ? 6 : 9; // within a weak point (a skirt is 8 px deep, a bunker gun 16 px wide)
  const aligned = Math.abs(dx) < slack || Math.abs(dy) < slack;
  // (a player holds the drone while the boss's flares or smoke are up)
  const open = (b as { droneOpen?: () => boolean }).droneOpen?.() ?? true;
  if (!ability && open && w.charges[0] > 0 && w.unlocked[0] && aligned && t.dir === facing && Math.hypot(dx, dy) < 150) ability = 1;
  if (bossWorld !== w) {
    bossWorld = w;
    bossGoal = null;
  }
  // the final fight's heavy tank leaves a wreck that blocks tanks and shells: stand and drive clear of it
  const hulk = (b as unknown as { tank?: { x: number; y: number; state: string } }).tank;
  const wreck = fort && hulk && hulk.state === 'dead' ? [hulk.x, hulk.y, 48, 48] : null;
  if (w.frame % 30 === 0 || !bossGoal) {
    let bs = Infinity;
    bossGoal = null;
    // the final fight's bunker guns and door sit in steel: any side with a clear line (no steel between), 48-104 px out
    for (const k of fort ? [0, 1, 2, 3] : sides) {
      const d = (b.dir + k) & 3;
      for (const dist of fort ? [48, 64, 80, 104] : [72]) {
        const gx = Math.round((ax + DX[d] * dist - 8) / 8) * 8;
        const gy = Math.round((ay + DY[d] * dist - 8) / 8) * 8;
        if (gx < 0 || gy < 0 || gx > w.pxW - 16 || gy > w.pxH - 16 || w.map.solidForTank(gx, gy, false)) continue;
        if (fort && !clearLine(w, gx + 8, gy + 8, ax, ay)) continue;
        if (wreck && (hitsRect(gx, gy, 16, 16, wreck) || crossesRect(gx + 8, gy + 8, ax, ay, wreck))) continue;
        const s = Math.abs(gx - t.x) + Math.abs(gy - t.y);
        if (s < bs) { bs = s; bossGoal = [gx, gy]; }
      }
    }
    if (bossGoal) flowBoss.compute(w.map, [[bossGoal[0] / 8, bossGoal[1] / 8]], Infinity, wreck);
  }
  const there = bossGoal && Math.abs(bossGoal[0] - t.x) + Math.abs(bossGoal[1] - t.y) < (fort ? 2 : 10);
  if (fort && bossGoal && !there) return { dir: descend(t, flowBoss), fire: aligned && t.dir === facing, ability };
  if (there || (aligned && Math.hypot(dx, dy) < 110)) {
    if (t.dir !== facing) return { dir: facing, fire: false, ability };
    // nudge into line, then hold and fire; a nudge that gets nowhere (pressed against the hull) backs off instead
    if (!aligned) {
      if (t.x !== nudge.x || t.y !== nudge.y || w.frame - nudge.f > 120) Object.assign(nudge, { x: t.x, y: t.y, f: w.frame });
      if (w.frame - nudge.f > 45) return { dir: (facing + 2) & 3, fire: false, ability };
      return { dir: Math.abs(dx) < Math.abs(dy) ? (dx < 0 ? 3 : 1) : dy < 0 ? 0 : 2, fire: false, ability };
    }
    return { dir: -1, fire: true, ability };
  }
  return { dir: bossGoal ? descend(t, flowBoss) : facing, fire: aligned && t.dir === facing, ability };
}

interface HeavyPart { kind: string; side: number; hp: number }
interface Heavy { parts: HeavyPart[]; turret: HeavyPart; alive: boolean; partRect(p: HeavyPart): [number, number, number, number] }
/** The heavy tank the bot is fighting, if the boss is one: GRINDER, or the final fight in its first stage. */
function heavyTank(b: NonNullable<World['boss']>): Heavy | null {
  if (b.kind === 'ace') return b as unknown as Heavy;
  const tk = (b as unknown as { tank?: Heavy }).tank;
  return b.kind === 'final' && tk?.alive ? tk : null;
}

/** Direction of the steepest descent of the bot's distance field from the tank's node, -1 if none. */
function descend(t: Tank, fl = flowBot): number {
  const nx = Math.round(t.x / 8);
  const ny = Math.round(t.y / 8);
  let dir = -1;
  let bv = fl.at(nx, ny);
  for (let d = 0; d < 4; d++) {
    const v = fl.at(nx + DX[d], ny + DY[d]);
    if (v < bv) { bv = v; dir = d; }
  }
  return dir < 0 ? t.dir : dir;
}

/** Direction out of the nearest marked artillery circle the tank is in or next to, -1 if none. */
function dodgeShells(w: World, t: Tank): number {
  const shells = w.tricks?.barrage?.shells;
  if (!shells) return -1;
  let near: { x: number; y: number } | null = null;
  let nd = TR.artR + 12;
  for (const s of shells) {
    if (s.done || w.frame < s.appear) continue;
    const d = Math.hypot(s.x - t.cx, s.y - t.cy);
    if (d < nd) { nd = d; near = s; }
  }
  if (!near) return -1;
  let best = -1;
  let bd = nd;
  for (let d = 0; d < 4; d++) {
    const nx = t.x + DX[d] * 8;
    const ny = t.y + DY[d] * 8;
    if (nx < 0 || ny < 0 || nx > w.pxW - 16 || ny > w.pxH - 16 || w.map.solidForTank(nx, ny, false)) continue;
    const dd = Math.hypot(near.x - nx - 8, near.y - ny - 8);
    if (dd > bd) { bd = dd; best = d; }
  }
  return best;
}

const hitsRect = (x: number, y: number, w: number, h: number, r: number[]) => x < r[0] + r[2] && x + w > r[0] && y < r[1] + r[3] && y + h > r[1];
/** The straight line from (x0, y0) to (x1, y1) passes through rect r. */
function crossesRect(x0: number, y0: number, x1: number, y1: number, r: number[]): boolean {
  const n = Math.ceil(Math.hypot(x1 - x0, y1 - y0) / 4);
  for (let i = 0; i <= n; i++) if (hitsRect(x0 + ((x1 - x0) * i) / n - 2, y0 + ((y1 - y0) * i) / n - 2, 4, 4, r)) return true;
  return false;
}

/** No steel cell on the straight line from (x0, y0) to within 10 px of (x1, y1) (brick is fine: shells clear it). */
function clearLine(w: World, x0: number, y0: number, x1: number, y1: number): boolean {
  const n = Math.ceil(Math.hypot(x1 - x0, y1 - y0) / 2);
  for (let i = 0; i <= n; i++) {
    const x = x0 + ((x1 - x0) * i) / n;
    const y = y0 + ((y1 - y0) * i) / n;
    if (Math.hypot(x1 - x, y1 - y) < 10) return true;
    if (w.map.at(Math.floor(x / 4), Math.floor(y / 4)) === STEEL) return false;
  }
  return true;
}

/** A sidestep out of the line of a heavy boss shell (dmg >= 3) flying at the tank from within 140 px, -1 if none. */
function dodgeHeavy(w: World, t: Tank): number {
  for (const b of w.bullets) {
    if (!b.alive || b.dmg < 3 || b.owner.isPlayer) continue;
    const along = (t.cx - b.x) * b.ux + (t.cy - b.y) * b.uy;
    const side = (t.cx - b.x) * b.uy - (t.cy - b.y) * b.ux;
    if (along < 0 || along > 140 || Math.abs(side) > 12) continue;
    // sideways out of its line (boss shells can fly at an angle): the side the tank already leans to first
    const away = (d: number) => (DX[d] * b.uy - DY[d] * b.ux) * (side >= 0 ? 1 : -1);
    const dirs = [0, 1, 2, 3].filter((d) => Math.abs(away(d)) > 0.3).sort((p, q) => away(q) - away(p));
    for (const d of dirs) {
      const nx = t.x + DX[d] * 8;
      const ny = t.y + DY[d] * 8;
      if (nx >= 0 && ny >= 0 && nx <= w.pxW - 16 && ny <= w.pxH - 16 && !w.map.solidForTank(nx, ny, false)) return d;
    }
  }
  return -1;
}
