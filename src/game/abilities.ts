// Phase 3: the player's crew abilities in campaign regions (CAMPAIGN.md "Abilities"). Charges live in
// w.charges[0..2] and are shared in co-op; crew unlock each ability type (w.unlocked[k]; `(w as any).allAbilities`
// unlocks all three for tests). A charge is spent only when the ability actually fires.
//
// 1 FPV drone strike: hold the key to aim. The tank stops and a reticle appears ABIL.aimAhead px ahead; the direction
//   keys move it (clamped to the screen). Release to launch: the drone flies out, climbs, then dives onto the reticle
//   in 0.6-1 s. A tank under it takes a top-armour hit (basic, fast and power tanks die, armoured ones lose
//   ABIL.fpvDmg), with a small blast, smoke, a shockwave and one brick tile broken. A reticle on a tank locks the
//   drone onto it, so it follows the tank. A tap (released within ABIL.tapFrames) launches straight at the nearest
//   visible enemy in front. Pressing fire while aiming cancels the strike and keeps the charge. Pads have no held
//   signal, so a pad press is always a tap.
// 2 Infantry ambush: an anti-tank squad goes into the nearest cover within ABIL.ambushReach px ahead (trees, or next
//   to brick and ruins); "NO COVER AHEAD" otherwise. Hidden under the canopy, it fires a rocket (2 damage, 80 px) at
//   an enemy passing in a straight line, up to 4 rockets with a reload between, then withdraws. An enemy that comes
//   within ABIL.spotR px spots it and shoots; one hit and the squad pulls back.
// 3 Recon drone: circles above the player for 20 s, drawn above the canopy. Enemies under trees get red brackets,
//   the minimap shows every enemy, and revealed(w) is true, so the enemy-tricks module shows its hidden things.
//
// Shared reveal API (tricks.ts reads it, nothing else is shared): `revealed(w)` is true while a recon drone is up.
// Any object in an array on w.tricks with a truthy `hidden` flag and numeric cx/cy (or x/y) also gets a recon mark
// drawn here while it is true.
import type { Renderer } from '../gl/renderer';
import { BRICK, DOWN, DX, DY, EMPTY, LEFT, MAT_METAL, MAT_STD, RIGHT, STEEL, TREES, UP, WATER } from './constants';
import type { Bullet, PInput, RGB, Tank, World } from './world';

/** Tuning (frames are 1/60 s, distances in px). */
export const ABIL = {
  // FPV drone strike
  aimAhead: 48,
  aimSpeed: 3,
  tapFrames: 12,
  tapRange: 176,
  fpvSpeed: 4.5,
  fpvMin: 36,
  fpvMax: 60,
  fpvAlt: 16,
  fpvDmg: 3,
  // infantry ambush
  ambushReach: 36,
  rockets: 4,
  reload: 120,
  firstReload: 30,
  rocketSpeed: 5,
  rocketRange: 80,
  rocketDmg: 2,
  spotR: 24,
  spotDelay: 20,
  ambushLife: 60 * 90,
  maxSquads: 3,
  // recon drone
  reconFrames: 60 * 20,
  reconR: 26,
  reconPeriod: 240,
};

const NAMES = ['FPV DRONE', 'AMBUSH', 'RECON DRONE'];
const WHITE3: RGB = [1, 1, 1];
const P_COL: RGB[] = [[1, 0.84, 0.32], [0.5, 1, 0.55]];
const LOCK_COL: RGB = [1, 0.3, 0.2];
const rand = Math.random;
const pick = <T>(a: T[]): T => a[Math.floor(rand() * a.length)];

// radio voices match the HUD portraits in ui-campaign.ts (WASP = drone operator, OWL = scout)
const RADIO_FPV = [
  'GOOD HIT. THE ROOF WAS THINNER THAN THEIR EXCUSES.',
  'SPLASH ONE. SENDING THE NEXT BIRD TO THE SAME ADDRESS.',
  'TOP ARMOUR SAYS HELLO. THEY DID NOT ANSWER.',
  'BIRD ON TARGET. I WILL MISS THAT ONE. NOT REALLY.',
];
const RADIO_AMBUSH = [
  'CONTACT. THEY DROVE RIGHT PAST US. SOME PEOPLE NEVER LOOK IN HEDGES.',
  'ROCKET AWAY. WE ARE THE BUSH NOW.',
  'WE ARE IN THE TREES. DO NOT SHOOT THE TREES.',
  'THEY CAME DOWN OUR STREET. THAT WAS A MISTAKE.',
];
const RADIO_RECON = [
  'BIRD IS UP. I CAN SEE THEIR BREAKFAST FROM HERE.',
  'RECON UP. MARKING EVERYTHING THAT HIDES BADLY.',
  'EYES IN THE SKY. TWENTY SECONDS OF BATTERY, USE THEM.',
];

/** True while a recon drone is up: hidden enemies, mines and ambushes should be drawn (tricks.ts reads this). */
export function revealed(w: World): boolean {
  return !!w.abil && w.abil.reconUntil > w.frame;
}

interface Aim { x: number; y: number; t: number }
export interface Fpv {
  pi: number; sx: number; sy: number; x: number; y: number; z: number;
  tx: number; ty: number; target: Tank | null; t: number; dur: number; dived: boolean;
  /** Phase 4 boss hook: locked onto the boss at this offset from its top-left */
  bossLock?: [number, number];
  /** a boss's countermeasure drew it off (flares, smoke): it flies to (tx, ty) and bursts there harmlessly; the popup's text */
  lost?: string;
  /** its height when it was drawn off */
  z0?: number;
}
interface Squad {
  pi: number; x: number; y: number; dir: number; rockets: number; reload: number; t: number;
  /** frames since it started to withdraw (0 = in position) */
  leaving: number;
  sprung: boolean;
  /** frames an enemy has been close enough to spot it */
  spot: number;
  /** frames since the last rocket */
  fired: number;
}
interface Rocket { x: number; y: number; dir: number; dist: number; pi: number }
interface Recon { pi: number; x: number; y: number; ang: number; t: number }

export class Abilities {
  /** per player: the drone reticle while aiming (world px), else null */
  aims: (Aim | null)[] = [null, null];
  fpvs: Fpv[] = [];
  squads: Squad[] = [];
  rockets: Rocket[] = [];
  recon: Recon | null = null;
  /** w.frame until which the recon drone is up (the HUD shows every enemy on the minimap while w.frame < this) */
  reconUntil = 0;
  /** world px rect on screen at the last draw [x, y, w, h] (the reticle stays inside it); null until drawn */
  view: [number, number, number, number] | null = null;
  /** totals for the sims */
  stats = { fpv: 0, fpvHits: 0, fpvLost: 0, ambush: 0, rocketsFired: 0, rocketHits: 0, recon: 0 };
  private prevFire = [false, false];
  private splats: { x: number; y: number }[] = [];
  private last = new Map<Tank, [number, number]>();
  private vel = new Map<Tank, [number, number]>();
  private aimHint = false;
  private flagChecked = false;

  constructor(public w: World) {}

  /**
   * Player i's input this update, before movement. ability 1-3 = pressed this update, abilityHeld 1-3 = held (for
   * aiming). Return true to take over the tank this update (e.g. while aiming the drone it stands still).
   */
  input(i: number, t: Tank, inp: PInput): boolean {
    const fireHit = inp.fire && !this.prevFire[i];
    this.prevFire[i] = inp.fire;
    const aim = this.aims[i];
    if (aim) {
      aim.t++;
      if (fireHit) {
        this.aims[i] = null;
        this.w.note('DRONE STRIKE CANCELLED', 'info');
        this.w.snd('ui-back', t.cx, 0.6);
        return true;
      }
      if (inp.abilityHeld === 1) {
        if (inp.dir >= 0) {
          aim.x += DX[inp.dir] * ABIL.aimSpeed;
          aim.y += DY[inp.dir] * ABIL.aimSpeed;
          this.clampAim(aim, t);
        }
        return true;
      }
      this.aims[i] = null;
      this.release(i, t, aim);
      return true;
    }
    if (inp.ability === 1) {
      if (!this.usable(0)) return false;
      const a: Aim = { x: t.cx + DX[t.dir] * ABIL.aimAhead, y: t.cy + DY[t.dir] * ABIL.aimAhead, t: 0 };
      this.clampAim(a, t);
      // pads report no held key, so their press is a tap
      if (inp.abilityHeld !== 1) {
        this.release(i, t, a);
        return true;
      }
      this.aims[i] = a;
      this.w.snd('ui-move', t.cx, 0.5);
      if (!this.aimHint) {
        this.aimHint = true;
        this.w.note('AIM, RELEASE TO LAUNCH, FIRE CANCELS', 'info');
      }
      return true;
    }
    if (inp.ability === 2) this.placeAmbush(i, t);
    else if (inp.ability === 3) this.launchRecon(i, t);
    return false;
  }

  /** Once per update, after the enemies moved. */
  update(): void {
    const w = this.w;
    if (!this.flagChecked) {
      // ?abil=1 (testing): every ability unlocked with 9 charges, applied on the first update so the run's own
      // charges (set after the world is built) don't overwrite it
      this.flagChecked = true;
      if (typeof location !== 'undefined' && /[?&]abil=1(&|$)/.test(location.search)) {
        (w as unknown as { allAbilities: boolean }).allAbilities = true;
        for (let k = 0; k < 3; k++) w.charges[k] = Math.max(w.charges[k] ?? 0, 9);
      }
    }
    for (let i = 0; i < 2; i++) {
      const p = w.players[i];
      if (this.aims[i] && (!p || !p.alive || w.over)) this.aims[i] = null;
    }
    // enemy movement this update, for the squad's rocket leads
    const now = new Map<Tank, [number, number]>();
    this.vel.clear();
    for (const e of w.enemies) {
      const l = this.last.get(e);
      if (l) this.vel.set(e, [e.x - l[0], e.y - l[1]]);
      now.set(e, [e.x, e.y]);
    }
    this.last = now;
    this.updateFpvs();
    this.updateSquads();
    this.updateRockets();
    this.updateRecon();
    if (this.splats.length > 16) this.splats.splice(0, this.splats.length - 16);
  }

  /** A shell step: return true if it hit something of ours (it is then spent). Enemy shells can hit a squad. */
  bulletHit(b: Bullet): boolean {
    if (b.owner.isPlayer || !this.squads.length) return false;
    const w = this.w;
    for (const s of this.squads) {
      if (s.leaving || Math.abs(b.x - s.x) >= 7 || Math.abs(b.y - s.y) >= 6) continue;
      s.leaving = 1;
      w.booms.push({ x: b.x, y: b.y, big: false, t: 0 });
      w.flashes.push({ x: b.x, y: b.y, t: 0, max: 10, r: 40, col: [1, 0.65, 0.3], z: 8 });
      w.sparks(b.x, b.y, 6, [1, 0.8, 0.4]);
      w.snd('thud', s.x, 0.8);
      w.note('SQUAD HIT, PULLING BACK', 'warn');
      return true;
    }
    return false;
  }

  // ---------- boss countermeasures (flares, smoke) ----------
  /** Frames until drone f hits, if it is flying at the boss (locked on it, or its reticle on the hull); else -1. */
  bossBound(f: Fpv): number {
    const b = this.w.boss;
    if (!b?.alive || f.lost || f.target) return -1;
    if (!f.bossLock && !b.overlaps(f.tx - 3, f.ty - 3, 6, 6)) return -1;
    return f.dur - f.t;
  }

  /** A boss draws drone f off to (x, y): it swerves there and bursts harmlessly, with `text` over it. */
  divert(f: Fpv, x: number, y: number, text: string): void {
    f.lost = text;
    f.bossLock = undefined;
    f.target = null;
    f.sx = f.x;
    f.sy = f.y;
    f.tx = x;
    f.ty = y;
    f.z0 = f.z;
    f.t = 0;
    f.dur = Math.max(12, Math.round(Math.hypot(x - f.x, y - f.y) / 3));
    this.stats.fpvLost++;
  }

  // ---------- FPV drone strike ----------
  private usable(k: number): boolean {
    const w = this.w;
    if (!(w.unlocked[k] || (w as unknown as { allAbilities?: boolean }).allAbilities)) {
      w.note(`${NAMES[k]} NEEDS CREW`, 'warn');
      w.snd('ui-back', undefined, 0.6);
      return false;
    }
    if ((w.charges[k] ?? 0) <= 0) {
      w.note(`NO ${NAMES[k]} CHARGES`, 'warn');
      w.snd('ui-back', undefined, 0.6);
      return false;
    }
    return true;
  }

  private clampAim(a: Aim, t: Tank): void {
    const v = this.view ?? [t.cx - 200, t.cy - 112, 400, 224];
    const m = 6;
    a.x = Math.max(v[0] + m, Math.min(v[0] + v[2] - m, a.x));
    a.y = Math.max(v[1] + m, Math.min(v[1] + v[3] - m, a.y));
    a.x = Math.max(2, Math.min(this.w.pxW - 2, a.x));
    a.y = Math.max(2, Math.min(this.w.pxH - 2, a.y));
  }

  private release(i: number, t: Tank, aim: Aim): void {
    const boss = this.w.boss; // Phase 4 boss hook
    if (aim.t <= ABIL.tapFrames) {
      const e = this.autoTarget(t);
      if (boss?.alive && this.bossInFront(t, e)) {
        const [bx, by] = boss.aimPoint();
        this.launchFpv(i, t, bx, by, null);
        this.fpvs[this.fpvs.length - 1].bossLock = [bx - boss.x, by - boss.y];
        return;
      }
      if (!e) {
        this.w.note('NO TARGET IN FRONT', 'warn');
        this.w.snd('ui-back', t.cx, 0.6);
        return;
      }
      this.launchFpv(i, t, e.cx, e.cy, e);
      return;
    }
    const lock = this.tankAt(aim.x, aim.y);
    this.launchFpv(i, t, aim.x, aim.y, lock);
    if (!lock && boss?.alive && boss.overlaps(aim.x - 3, aim.y - 3, 6, 6)) this.fpvs[this.fpvs.length - 1].bossLock = [aim.x - boss.x, aim.y - boss.y];
  }

  /** Phase 4 boss hook: a tap launch goes for the boss when it is in front and nearer than the tank target `e`. */
  private bossInFront(t: Tank, e: Tank | null): boolean {
    const b = this.w.boss!;
    const vx = b.cx - t.cx;
    const vy = b.cy - t.cy;
    const along = vx * DX[t.dir] + vy * DY[t.dir];
    const lat = Math.abs(vx * DY[t.dir] - vy * DX[t.dir]);
    const d = Math.hypot(vx, vy);
    if (along < 8 || lat > along * 0.75 + 30 || d > ABIL.tapRange + 24 || !this.inView(b.cx, b.cy)) return false;
    return !e || d < Math.hypot(e.cx - t.cx, e.cy - t.cy);
  }

  /** An enemy that can be hit (not spawning, not an abandoned hull). */
  private hostile(e: Tank): boolean {
    return e.alive && e.spawn === 0 && !this.w.ai?.isHull(e);
  }

  /** The enemy whose body is under (x, y), nearest first. */
  private tankAt(x: number, y: number): Tank | null {
    let best: Tank | null = null;
    let bd = Infinity;
    for (const e of this.w.enemies) {
      if (!this.hostile(e) || Math.abs(e.cx - x) > 10 || Math.abs(e.cy - y) > 10) continue;
      const d = Math.hypot(e.cx - x, e.cy - y);
      if (d < bd) {
        bd = d;
        best = e;
      }
    }
    return best;
  }

  /** Nearest visible enemy in a cone in front of the tank (tap launch). */
  private autoTarget(t: Tank): Tank | null {
    const fx = DX[t.dir];
    const fy = DY[t.dir];
    let best: Tank | null = null;
    let bs = Infinity;
    for (const e of this.w.enemies) {
      if (!this.hostile(e)) continue;
      const vx = e.cx - t.cx;
      const vy = e.cy - t.cy;
      const along = vx * fx + vy * fy;
      const lat = Math.abs(vx * fy - vy * fx);
      const d = Math.hypot(vx, vy);
      if (along < 8 || lat > along * 0.75 + 12 || d > ABIL.tapRange) continue;
      if (!this.inView(e.cx, e.cy)) continue;
      if (d > 48 && !revealed(this.w) && this.inTrees(e)) continue;
      if (d + lat < bs) {
        bs = d + lat;
        best = e;
      }
    }
    return best;
  }

  private inView(x: number, y: number): boolean {
    const v = this.view;
    return !v || (x >= v[0] && y >= v[1] && x < v[0] + v[2] && y < v[1] + v[3]);
  }

  /** Half or more of the tank's footprint under trees (same test as the enemy AI's). */
  private inTrees(t: Tank): boolean {
    const m = this.w.map;
    const cx = Math.round(t.x / 4);
    const cy = Math.round(t.y / 4);
    let n = 0;
    for (let y = cy; y < cy + 4; y++) for (let x = cx; x < cx + 4; x++) if (m.at(x, y) === TREES) n++;
    return n >= 8;
  }

  private launchFpv(i: number, t: Tank, x: number, y: number, target: Tank | null): void {
    const w = this.w;
    w.charges[0]--;
    this.stats.fpv++;
    const d = Math.hypot(x - t.cx, y - t.cy);
    const dur = Math.round(Math.max(ABIL.fpvMin, Math.min(ABIL.fpvMax, d / ABIL.fpvSpeed)));
    this.fpvs.push({ pi: i, sx: t.cx, sy: t.cy, x: t.cx, y: t.cy, z: 0, tx: x, ty: y, target, t: 0, dur, dived: false });
    w.note(target ? 'FPV DRONE AWAY, TARGET LOCKED' : 'FPV DRONE AWAY', 'info');
    w.snd('ui-ok', t.cx, 0.5);
    w.snd('capture-tick', t.cx, 0.5);
  }

  private updateFpvs(): void {
    if (!this.fpvs.length) return;
    const w = this.w;
    const keep: Fpv[] = [];
    for (const f of this.fpvs) {
      f.t++;
      if (f.target) {
        if (f.target.alive) {
          f.tx = f.target.cx;
          f.ty = f.target.cy;
        } else {
          f.target = null;
        }
      }
      const boss = this.w.boss; // Phase 4 boss hook: a drone locked on the boss follows it
      if (f.bossLock && boss?.alive) {
        f.tx = boss.x + f.bossLock[0];
        f.ty = boss.y + f.bossLock[1];
      }
      const s = Math.min(1, f.t / f.dur);
      if (f.lost) {
        // drawn off: a wobbling swerve to where it bursts
        const wob = Math.sin(s * Math.PI) * Math.sin(f.t * 0.9) * 3;
        const l = Math.hypot(f.tx - f.sx, f.ty - f.sy) || 1;
        f.x = f.sx + (f.tx - f.sx) * s - ((f.ty - f.sy) / l) * wob;
        f.y = f.sy + (f.ty - f.sy) * s + ((f.tx - f.sx) / l) * wob;
        f.z = (f.z0 ?? 0) * (1 - s * 0.5);
        if (f.t % 3 === 0) w.snd('capture-tick', f.x, 0.32);
        if (f.t >= f.dur) this.fpvLost(f);
        else keep.push(f);
        continue;
      }
      const e = Math.pow(s, 1.15); // speeds up a little into the dive
      f.x = f.sx + (f.tx - f.sx) * e;
      f.y = f.sy + (f.ty - f.sy) * e;
      f.z = s < 0.2 ? ABIL.fpvAlt * (s / 0.2) : s < 0.75 ? ABIL.fpvAlt : ABIL.fpvAlt * (1 - (s - 0.75) / 0.25);
      // the buzz: quick positional ticks, then the whine of the dive
      if (f.t % 3 === 0) w.snd('capture-tick', f.x, 0.32);
      if (!f.dived && s >= 0.75) {
        f.dived = true;
        w.snd('ricochet', f.x, 0.45);
      }
      if (f.t >= f.dur) {
        this.fpvImpact(f);
        continue;
      }
      keep.push(f);
    }
    this.fpvs = keep;
  }

  /** A drawn-off drone bursts in the air: a small pop, no damage, the reason over it. */
  private fpvLost(f: Fpv): void {
    const w = this.w;
    w.booms.push({ x: f.x, y: f.y, big: false, t: 0 });
    w.sparks(f.x, f.y, 8, [1, 0.8, 0.4]);
    w.flashes.push({ x: f.x, y: f.y, t: 0, max: 8, r: 30, col: [1, 0.7, 0.35], z: 12 });
    w.popups.push({ x: f.x, y: f.y - 8, text: f.lost!, t: 0, col: [0.75, 0.8, 0.88] });
    w.snd('explode', f.x, 0.45);
  }

  private fpvImpact(f: Fpv): void {
    const w = this.w;
    const x = f.tx;
    const y = f.ty;
    let hit: Tank | null = f.target && f.target.alive ? f.target : null;
    if (!hit && !(f.bossLock && w.boss?.alive)) {
      let bd = Infinity;
      for (const e of w.enemies) {
        if (!e.alive || e.spawn > 0 || Math.abs(e.cx - x) > 10 || Math.abs(e.cy - y) > 10) continue;
        const d = Math.hypot(e.cx - x, e.cy - y);
        if (d < bd) {
          bd = d;
          hit = e;
        }
      }
    }
    w.explode(x, y, false);
    w.shocks.push({ x, y, t: 0, max: 24, size: 0.8 });
    w.shake = Math.max(w.shake, 2.2);
    w.sparks(x, y, 10, [1, 0.75, 0.35]);
    for (let k = 0; k < 5; k++) {
      w.parts.push({
        x: x + (rand() - 0.5) * 6, y: y + (rand() - 0.5) * 6, z: 6, vx: (rand() - 0.5) * 0.4, vy: (rand() - 0.5) * 0.4 - 0.1, vz: 0.1,
        life: 0, max: 60 + Math.floor(rand() * 40), col: [0.2, 0.19, 0.18], kind: 2, r: 3 + rand() * 3,
      });
    }
    this.splats.push({ x, y });
    w.snd('explode', x, 0.8);
    this.breakBrick(x, y);
    if (hit) {
      this.stats.fpvHits++;
      if (this.damage(hit, ABIL.fpvDmg, f.pi) && rand() < 0.5) this.radio('WASP', pick(RADIO_FPV));
    } else if (w.boss?.droneHit(x, y, ABIL.fpvDmg, f.pi)) {
      // Phase 4 boss hook: top armour is thin, so drones hit bosses hard (boss.ts BOSS.droneMul)
      this.stats.fpvHits++;
      if (rand() < 0.5) this.radio('WASP', pick(RADIO_FPV));
    }
  }

  /** Break the 8 px brick tile at (x, y). */
  private breakBrick(x: number, y: number): void {
    const w = this.w;
    const tx = Math.floor(x / 8) * 2;
    const ty = Math.floor(y / 8) * 2;
    let n = 0;
    for (let j = 0; j < 2; j++) {
      for (let i = 0; i < 2; i++) {
        if (tx + i >= w.map.w || ty + j >= w.map.h || w.map.at(tx + i, ty + j) !== BRICK) continue;
        w.map.set(tx + i, ty + j, EMPTY);
        w.debris((tx + i) * 4 + 2, (ty + j) * 4 + 2, (i + j * 2) % 4);
        n++;
      }
    }
    if (n) w.snd('brick', x, 0.8);
  }

  /**
   * Drone and rocket damage: basic, fast and power tanks die outright, armoured ones lose `dmg` hp. Returns true if
   * it died. Bosses have their own rule: Boss.droneHit / Boss.rocketHit (Phase 4 boss hook in fpvImpact and
   * rocketStep).
   */
  private damage(e: Tank, dmg: number, pi: number): boolean {
    const w = this.w;
    if (e.bonus) {
      e.bonus = false;
      w.spawnPower();
    }
    e.hp -= e.etype === 3 ? dmg : e.hp;
    if (e.hp > 0) {
      e.flash = 10;
      w.sparks(e.cx, e.cy, 8, [0.9, 0.95, 1]);
      w.snd('armor', e.cx);
      w.popups.push({ x: e.cx, y: e.cy - 10, text: `-${dmg}`, t: 0, col: [1, 0.6, 0.3] });
      return false;
    }
    w.killEnemy(e, pi);
    return true;
  }

  private radio(who: string, text: string): void {
    const w = this.w;
    w.radio.push({ who, text });
    if (w.radio.length > 20) w.radio.shift();
  }

  // ---------- infantry ambush ----------
  private placeAmbush(i: number, t: Tank): void {
    const w = this.w;
    if (!this.usable(1)) return;
    if (this.squads.filter((s) => !s.leaving).length >= ABIL.maxSquads) {
      w.note('ALL SQUADS ARE OUT', 'warn');
      return;
    }
    const spot = this.coverSpot(t);
    if (!spot) {
      w.note('NO COVER AHEAD', 'warn');
      w.snd('ui-back', t.cx, 0.6);
      return;
    }
    w.charges[1]--;
    this.stats.ambush++;
    this.squads.push({
      pi: i, x: spot.x, y: spot.y, dir: t.dir, rockets: ABIL.rockets, reload: ABIL.firstReload, t: 0, leaving: 0, sprung: false, spot: 0, fired: 999,
    });
    w.note(spot.kind === 'trees' ? 'AMBUSH SET IN THE TREES' : 'AMBUSH SET IN THE RUINS', 'info');
    w.snd('ui-ok', spot.x, 0.5);
  }

  /** The nearest cover within reach ahead of the tank for a squad (centre on the 4 px grid), or null. */
  private coverSpot(t: Tank): { x: number; y: number; kind: 'trees' | 'ruins' } | null {
    const D = t.dir;
    const px = DY[D] !== 0 ? 1 : 0;
    const py = 1 - px;
    let best: { x: number; y: number; kind: 'trees' | 'ruins' } | null = null;
    let bs = Infinity;
    for (let d = 20; d <= ABIL.ambushReach; d += 4) {
      for (let s = -12; s <= 12; s += 4) {
        const x = Math.round((t.cx + DX[D] * d + px * s) / 4) * 4;
        const y = Math.round((t.cy + DY[D] * d + py * s) / 4) * 4;
        const kind = this.cover(x, y);
        if (!kind) continue;
        if (this.w.allTanks().some((o) => o.alive && Math.abs(o.cx - x) < 13 && Math.abs(o.cy - y) < 13)) continue;
        if (this.squads.some((q) => !q.leaving && Math.abs(q.x - x) < 10 && Math.abs(q.y - y) < 10)) continue;
        // nearest first, but a spot fully under the canopy beats the edge of it
        const sc = d + Math.abs(s) * 0.7 - (kind === 'trees' && this.treeCells(x, y) === 4 ? 6 : 0);
        if (sc < bs) {
          bs = sc;
          best = { x, y, kind };
        }
      }
    }
    return best;
  }

  private treeCells(x: number, y: number): number {
    const m = this.w.map;
    let n = 0;
    for (let j = 0; j < 2; j++) for (let i = 0; i < 2; i++) if (m.at(x / 4 - 1 + i, y / 4 - 1 + j) === TREES) n++;
    return n;
  }

  /** Cover for a squad centred at (x, y): its 2x2 cells open, mostly trees, or next to brick (ruins). */
  private cover(x: number, y: number): 'trees' | 'ruins' | null {
    const m = this.w.map;
    const c0 = x / 4 - 1;
    const r0 = y / 4 - 1;
    if (c0 < 0 || r0 < 0 || c0 + 2 > m.w || r0 + 2 > m.h) return null;
    let trees = 0;
    for (let j = 0; j < 2; j++) {
      for (let i = 0; i < 2; i++) {
        const c = m.at(c0 + i, r0 + j);
        if (c === BRICK || c === STEEL || c === WATER) return null;
        if (c === TREES) trees++;
      }
    }
    if (trees >= 3) return 'trees';
    let brick = 0;
    for (let j = -1; j <= 2; j++) for (let i = -1; i <= 2; i++) if ((i < 0 || i > 1 || j < 0 || j > 1) && m.at(c0 + i, r0 + j) === BRICK) brick++;
    return brick >= 2 ? 'ruins' : null;
  }

  private updateSquads(): void {
    if (!this.squads.length) return;
    const keep: Squad[] = [];
    for (const s of this.squads) {
      s.t++;
      s.fired++;
      if (s.leaving) {
        if (++s.leaving < 50) keep.push(s);
        continue;
      }
      if (s.reload > 0) s.reload--;
      this.spotted(s);
      if (s.t > ABIL.ambushLife) this.withdraw(s, 'AMBUSH SQUAD PULLING BACK');
      else if (s.reload <= 0 && s.rockets <= 0) this.withdraw(s, 'AMBUSH SQUAD OUT OF ROCKETS');
      else if (s.reload <= 0) this.squadFire(s);
      keep.push(s);
    }
    this.squads = keep;
  }

  private withdraw(s: Squad, why: string): void {
    s.leaving = 1;
    this.w.note(why, 'info');
  }

  /** An enemy within spotR spots the squad and, once lined up, turns and fires at it. */
  private spotted(s: Squad): void {
    const w = this.w;
    let spotter: Tank | null = null;
    for (const e of w.enemies) {
      if (this.hostile(e) && Math.hypot(e.cx - s.x, e.cy - s.y) <= ABIL.spotR) {
        spotter = e;
        break;
      }
    }
    if (!spotter) {
      s.spot = Math.max(0, s.spot - 1);
      return;
    }
    if (++s.spot < ABIL.spotDelay || w.freeze > 0 || spotter.stun > 0) return;
    const dx = s.x - spotter.cx;
    const dy = s.y - spotter.cy;
    let dir: number;
    if (Math.abs(dx) <= 6) dir = dy < 0 ? UP : DOWN;
    else if (Math.abs(dy) <= 5) dir = dx < 0 ? LEFT : RIGHT;
    else return;
    if (w.frame < spotter.readyAt) return;
    w.turn(spotter, dir);
    w.fire(spotter);
  }

  private squadFire(s: Squad): void {
    const w = this.w;
    let best: { dir: number; d: number } | null = null;
    for (const e of w.enemies) {
      if (!this.hostile(e)) continue;
      const v = this.vel.get(e) ?? [0, 0];
      const ex = e.cx - s.x;
      const ey = e.cy - s.y;
      for (let dir = 0; dir < 4; dir++) {
        const along = ex * DX[dir] + ey * DY[dir];
        if (along < 8 || along > ABIL.rocketRange) continue;
        const lat = ex * DY[dir] - ey * DX[dir];
        const vlat = v[0] * DY[dir] - v[1] * DX[dir];
        // lead the target: where it will be when the rocket gets there
        if (Math.abs(lat) > 16 || Math.abs(lat + vlat * (along / ABIL.rocketSpeed)) > 7) continue;
        if (!this.clearLine(s.x, s.y, dir, along - 8)) continue;
        if (!best || along < best.d) best = { dir, d: along };
      }
    }
    const bt = w.boss?.squadTarget?.(); // Phase 4 boss hook: a low helicopter, the fleeing command car
    if (bt) {
      const ex = bt[0] - s.x;
      const ey = bt[1] - s.y;
      for (let dir = 0; dir < 4; dir++) {
        const along = ex * DX[dir] + ey * DY[dir];
        if (along < 8 || along > ABIL.rocketRange || Math.abs(ex * DY[dir] - ey * DX[dir]) > 12) continue;
        if (!this.clearLine(s.x, s.y, dir, along - 8)) continue;
        if (!best || along < best.d) best = { dir, d: along };
      }
    }
    const boss = w.boss; // Phase 4 boss hook: a boss without squadTarget (train, flagship, GRINDER) crossing a squad's line
    if (!best && boss?.alive && !boss.squadTarget) {
      for (let dir = 0; dir < 4; dir++) {
        for (let along = 8; along <= ABIL.rocketRange; along += 3) {
          if (!boss.overlaps(s.x + DX[dir] * along - 1, s.y + DY[dir] * along - 1, 2, 2)) continue;
          if (this.clearLine(s.x, s.y, dir, along - 8) && (!best || along < best.d)) best = { dir, d: along };
          break;
        }
      }
    }
    if (!best) return;
    const D = best.dir;
    s.rockets--;
    s.reload = ABIL.reload;
    s.dir = D;
    s.fired = 0;
    this.stats.rocketsFired++;
    this.rockets.push({ x: s.x + DX[D] * 5, y: s.y + DY[D] * 5, dir: D, dist: 0, pi: s.pi });
    // backblast: smoke and a push of air behind the squad
    for (let k = 0; k < 4; k++) {
      w.parts.push({
        x: s.x - DX[D] * 6, y: s.y - DY[D] * 6, z: 4,
        vx: -DX[D] * (0.5 + rand() * 0.6) + (rand() - 0.5) * 0.6, vy: -DY[D] * (0.5 + rand() * 0.6) + (rand() - 0.5) * 0.6, vz: 0.05,
        life: 0, max: 40 + k * 8, col: [0.62, 0.6, 0.56], kind: 2, r: 2.5,
      });
    }
    w.flashes.push({ x: s.x - DX[D] * 4, y: s.y - DY[D] * 4, t: 0, max: 8, r: 44, col: [1, 0.7, 0.35], z: 6, vx: -DX[D], vy: -DY[D] });
    w.snd('eshoot', s.x, 0.7);
    if (!s.sprung) {
      s.sprung = true;
      w.note('AMBUSH!', 'power');
      this.radio('OWL', pick(RADIO_AMBUSH));
    }
  }

  /** No brick or steel along the line from (x, y) for len px. */
  private clearLine(x: number, y: number, dir: number, len: number): boolean {
    const m = this.w.map;
    for (let d = 6; d <= len; d += 2) {
      const c = m.at(Math.floor((x + DX[dir] * d) / 4), Math.floor((y + DY[dir] * d) / 4));
      if (c === BRICK || c === STEEL) return false;
    }
    return true;
  }

  private updateRockets(): void {
    if (!this.rockets.length) return;
    const w = this.w;
    const keep: Rocket[] = [];
    for (const r of this.rockets) {
      let alive = true;
      for (let k = 0; k < ABIL.rocketSpeed && alive; k++) {
        r.x += DX[r.dir];
        r.y += DY[r.dir];
        r.dist++;
        alive = this.rocketStep(r);
      }
      if (!alive) continue;
      if (w.frame % 2 === 0) {
        w.parts.push({
          x: r.x - DX[r.dir] * 3, y: r.y - DY[r.dir] * 3, z: 4, vx: (rand() - 0.5) * 0.2, vy: (rand() - 0.5) * 0.2, vz: 0,
          life: 0, max: 24, col: [0.7, 0.68, 0.64], kind: 2, r: 1.5,
        });
      }
      keep.push(r);
    }
    this.rockets = keep;
  }

  /** One px of rocket flight: false once it is spent. */
  private rocketStep(r: Rocket): boolean {
    const w = this.w;
    if (r.dist > ABIL.rocketRange || r.x < 0 || r.y < 0 || r.x >= w.pxW || r.y >= w.pxH) {
      w.sparks(r.x, r.y, 3, [1, 0.7, 0.4]);
      return false;
    }
    for (const e of w.enemies) {
      if (!e.alive || e.spawn > 0 || r.x < e.x || r.x >= e.x + 16 || r.y < e.y || r.y >= e.y + 16) continue;
      w.explode(r.x, r.y, false);
      w.snd('explode', r.x, 0.6);
      this.stats.rocketHits++;
      this.damage(e, ABIL.rocketDmg, r.pi);
      return false;
    }
    if (w.boss?.rocketHit(r.x, r.y, r.dir, ABIL.rocketDmg, r.pi)) { // Phase 4 boss hook
      w.explode(r.x, r.y, false);
      w.snd('explode', r.x, 0.6);
      this.stats.rocketHits++;
      return false;
    }
    const cx = Math.floor(r.x / 4);
    const cy = Math.floor(r.y / 4);
    const c = w.map.at(cx, cy);
    if (c !== BRICK && c !== STEEL) return true;
    if (c === BRICK) {
      // blows a 2-cell gap across its path: the cell it hit and the nearer neighbour beside it
      const vert = !(r.dir & 1);
      const side = (vert ? r.x : r.y) % 4 >= 2 ? 1 : -1;
      for (const [bx, by] of [[cx, cy], vert ? [cx + side, cy] : [cx, cy + side]]) {
        if (w.map.at(bx, by) === BRICK) {
          w.map.set(bx, by, EMPTY);
          w.debris(bx * 4 + 2, by * 4 + 2, r.dir);
        }
      }
    }
    w.explode(r.x, r.y, false);
    w.snd(c === BRICK ? 'brick' : 'steel', r.x, 0.7);
    return false;
  }

  // ---------- recon drone ----------
  private launchRecon(i: number, t: Tank): void {
    const w = this.w;
    if (!this.usable(2)) return;
    if (this.recon) {
      w.note('RECON DRONE ALREADY UP', 'info');
      return;
    }
    w.charges[2]--;
    this.stats.recon++;
    this.reconUntil = w.frame + ABIL.reconFrames;
    this.recon = { pi: i, x: t.cx, y: t.cy, ang: rand() * Math.PI * 2, t: 0 };
    w.note('RECON DRONE UP', 'power');
    w.snd('ui-ok', t.cx, 0.6);
    this.radio('WASP', pick(RADIO_RECON));
  }

  private updateRecon(): void {
    const r = this.recon;
    if (!r) return;
    const w = this.w;
    r.t++;
    const p = w.players[r.pi]?.alive ? w.players[r.pi] : w.livePlayers()[0];
    if (p) {
      r.x += (p.cx - r.x) * 0.06;
      r.y += (p.cy - r.y) * 0.06;
    }
    r.ang += (Math.PI * 2) / ABIL.reconPeriod;
    if (w.frame >= this.reconUntil) {
      this.recon = null;
      w.note('RECON DRONE RETURNING', 'info');
    }
  }

  /** Recon drone position in world px (circling the player), or null. */
  reconPos(): [number, number] | null {
    const r = this.recon;
    if (!r) return null;
    const R = ABIL.reconR * Math.min(1, r.t / 60);
    return [r.x + Math.cos(r.ang) * R, r.y + Math.sin(r.ang) * R * 0.8];
  }

  /** Hidden things in the tricks module (array items with a truthy `hidden` and a position), for recon marks. */
  private hiddenThings(): [number, number][] {
    const tr = this.w.tricks as unknown as Record<string, unknown> | null;
    const out: [number, number][] = [];
    if (!tr) return out;
    for (const k of Object.keys(tr)) {
      const v = tr[k];
      if (k === 'w' || !Array.isArray(v)) continue;
      for (const o of v as Record<string, unknown>[]) {
        if (!o || typeof o !== 'object' || !o.hidden) continue;
        const x = typeof o.cx === 'number' ? o.cx : o.x;
        const y = typeof o.cy === 'number' ? o.cy : o.y;
        if (typeof x === 'number' && typeof y === 'number') out.push([x, y]);
      }
    }
    return out;
  }

  // ---------- drawing ----------
  /** Draw reticles, drones, squads (screen = world + ox/oy). Called under the canopy; r.top for things above it. */
  draw(r: Renderer, ox: number, oy: number, time: number): void {
    const w = this.w;
    const S = r.atlas.S;
    this.view = [-ox, -oy, r.nw, r.nh];
    const on = (x: number, y: number, m: number) => x > -m && y > -m && x < r.nw + m && y < r.nh + m;
    for (const s of this.splats) {
      r.dyeSplat(ox + s.x, oy + s.y, 10, 1.2, 0.9, 0.9);
      r.dyeSplat(ox + s.x, oy + s.y, 14, 0.9, 0.2, 0);
    }
    this.splats.length = 0;

    // ambush squads: lit, under the canopy (barely seen through the trees); our own chevron marks them
    for (const s of this.squads) {
      const sx = ox + s.x;
      const sy = oy + s.y;
      if (!on(sx, sy, 20)) continue;
      if (s.leaving && (s.leaving >> 2) & 1) continue;
      const spr = S.abSquad;
      const rw = s.dir & 1 ? spr.h : spr.w;
      const rh = s.dir & 1 ? spr.w : spr.h;
      r.spr(spr, Math.round(sx - rw / 2), Math.round(sy - rh / 2), s.dir, WHITE3, MAT_STD, 0, 1);
      if (s.fired < 8) {
        const k = 1 - s.fired / 8;
        r.glow(sx + DX[s.dir] * 7, sy + DY[s.dir] * 7, 4, [1, 0.75, 0.35], 2.5 * k);
        r.glow(sx - DX[s.dir] * 8, sy - DY[s.dir] * 8, 6, [1, 0.6, 0.3], 1.6 * k);
      }
      if (!s.leaving) {
        const bx = Math.round(sx);
        const by = Math.round(sy);
        r.ovSpr(S.abChevron, bx - 2, by - 12, [0.55, 1, 0.6], 0.7);
        for (let k = 0; k < s.rockets; k++) r.ovRect(bx - 4 + k * 2, by - 8, 1, 1, [1, 0.85, 0.4], 0.85);
      }
    }

    // rockets, above the canopy so they read as they leave the trees
    r.top = true;
    for (const k of this.rockets) {
      const x = ox + k.x;
      const y = oy + k.y;
      if (!on(x, y, 10)) continue;
      r.spr(S.abRocket, Math.round(x - (k.dir & 1 ? 2.5 : 1)), Math.round(y - (k.dir & 1 ? 1 : 2.5)), k.dir, WHITE3, MAT_STD, 0.2, 1);
      r.glow(x - DX[k.dir] * 3, y - DY[k.dir] * 3, 3.5, [1, 0.65, 0.3], 2.2);
      r.light(x, y, 8, 32, 0.9, 0.5, 0.2, false);
    }
    r.top = false;

    // FPV drones in flight: a ground shadow, the drone above the canopy, a blinking LED, the lock box
    for (const f of this.fpvs) {
      const gx = ox + f.x;
      const gy = oy + f.y;
      if (!on(gx, gy, 20)) continue;
      const x = gx;
      const y = gy - f.z * 0.35;
      r.smoke(gx + f.z * 0.25, gy + f.z * 0.4, 2.6, [0, 0, 0], 0.4);
      const dx = f.tx - f.sx;
      const dy = f.ty - f.sy;
      const rot = Math.abs(dx) > Math.abs(dy) ? (dx > 0 ? RIGHT : LEFT) : dy > 0 ? DOWN : UP;
      r.top = true;
      r.spr(S[`abFpv${Math.floor(time * 30) & 1}`], Math.round(x) - 4, Math.round(y) - 4, rot, WHITE3, MAT_METAL, 0.1, 1);
      r.top = false;
      if ((w.frame >> 2) & 1) r.glow(x, y, 2.5, [1, 0.2, 0.1], 2);
      r.light(x, y, 10 + f.z, 22, 0.25, 0.06, 0.03, false);
      if (f.target && f.target.alive) {
        const a = (w.frame >> 2) & 1 ? 1 : 0.45;
        r.ovSpr(S.abBox, Math.round(ox + f.target.x) - 1, Math.round(oy + f.target.y) - 1, LOCK_COL, a);
      }
    }

    // reticles (unlit overlay, readable by day and night): a dotted line from the tank, a drop shadow, the lock box
    for (let i = 0; i < 2; i++) {
      const a = this.aims[i];
      const p = w.players[i];
      if (!a || !p) continue;
      const lock = this.tankAt(a.x, a.y);
      const col = lock ? LOCK_COL : P_COL[i];
      const dx = a.x - p.cx;
      const dy = a.y - p.cy;
      const n = Math.floor(Math.hypot(dx, dy) / 5);
      for (let k = 2; k < n - 1; k++) r.ovRect(Math.round(ox + p.cx + (dx * k) / n), Math.round(oy + p.cy + (dy * k) / n), 1, 1, col, 0.5);
      const rx = Math.round(ox + a.x) - 6;
      const ry = Math.round(oy + a.y) - 6;
      r.ovSpr(S.abReticle, rx + 1, ry + 1, [0, 0, 0], 0.6);
      r.ovSpr(S.abReticle, rx, ry, col, 0.95);
      if (lock) r.ovSpr(S.abBox, Math.round(ox + lock.x) - 1, Math.round(oy + lock.y) - 1, LOCK_COL, 0.6 + 0.4 * Math.sin(time * 14));
    }

    // recon drone: circling above the canopy, with marks on what hides under the trees
    const rp = this.reconPos();
    if (rp) {
      const x = ox + rp[0];
      const y = oy + rp[1] - 6;
      r.smoke(ox + rp[0] + 4, oy + rp[1] + 6, 3.5, [0, 0, 0], 0.3);
      r.top = true;
      r.spr(S[`abRecon${Math.floor(time * 24) & 1}`], Math.round(x) - 5, Math.round(y) - 5, 0, WHITE3, MAT_METAL, 0.05, 1);
      r.top = false;
      const left = this.reconUntil - w.frame;
      if ((w.frame >> 3) & 1 || left < 180) r.glow(x, y - 2, 2.5, [0.3, 0.6, 1], left < 180 && (w.frame >> 2) & 1 ? 0.6 : 2);
      r.light(x, y, 18, 30, 0.08, 0.14, 0.3, false);
      const pulse = 0.6 + 0.35 * Math.sin(time * 6);
      for (const e of w.enemies) {
        if (!this.hostile(e) || !on(ox + e.cx, oy + e.cy, 10)) continue;
        if (!this.inTrees(e) && !(e as unknown as { hidden?: boolean }).hidden) continue;
        r.ovSpr(S.abBox, Math.round(ox + e.x) - 1, Math.round(oy + e.y) - 1, [1, 0.35, 0.2], pulse);
      }
      for (const [hx, hy] of this.hiddenThings()) {
        if (on(ox + hx, oy + hy, 6)) r.ovSpr(S.abDiamond, Math.round(ox + hx) - 3, Math.round(oy + hy) - 3, [1, 0.8, 0.25], pulse);
      }
    }
  }
}
