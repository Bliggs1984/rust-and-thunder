// Phase 4: the Region 2 boss, "ANVIL" (invented callsign), an armoured train (CAMPAIGN.md "Regions and bosses":
// runs along tracks, turret cars destroyed one by one).
//
// An armoured engine pulling five wagons (each 16 x 40 px, couplings 4 px apart) along RegionSpec.rail. It runs back
// and forth at a steady pace, stops in the junction yard (the middle of the line) and at each end, and sounds its
// horn whenever it sets off. Wagons, front to back: a gun car, the AA car, the rocket car, a second gun car, the
// supply car. Every wagon is a weak point with its own hp: a destroyed wagon blows up, burns and rides on as a wreck
// while the rest keep going. The engine is armoured: no shell, rocket or drone hurts it until both gun cars are
// gone, then it has TRAIN.hp.engine hp and its loss ends the fight.
// - Gun cars: a turret turns a quarter at a time toward a player it sees; a 1.1 s barrel glow with beeps (and now
//   and then a radio intercept) before a heavy shell (TRAIN.gunDmg armour). Two turrets never glow at once.
// - AA car: machine-gun bursts at a close player in line, and it fires at FPV drones diving near it (TRAIN.aaChance
//   to bring one down). Kill it first and the sky is safe.
// - Rocket car: a salvo of 3 rockets on a player in range: orange bracket marks on the ground at least 1.6 s before
//   each lands (the rockets arc in over the last 0.75 s), 3 armour inside the mark.
// - Supply car: unarmed; destroying it spills scrap and a part beside the track.
// - Tanks on the rails: the headlight flashes and the horn blows when a player sits on the track ahead; a train
//   that reaches a tank shoves it off the track (TRAIN.pushDmg armour to a player) or waits if there is no room.
// - On a curve every wagon lies at the track's own angle (the chord between its ends, snapped to TRAIN.angSteps),
//   drawn turned (Renderer.sprRot); hits, shoves, lamps, smoke, the headlight and the weak-point ticks use the turned
//   box. Boss shells fly at any angle (aim.ts): a gun turret slews to the player and fires along its real angle;
//   the AA mount bursts in the 8 directions.
// Drones do BOSS.droneMul x damage, as on GRINDER. Escort: tanks patrolling the yard (ai.bossEscort). Losing a gun
// car calls a column (ai.bossColumn); losing both makes it angry (faster). World.ease slows its tells and reloads.
import type { Renderer } from '../../gl/renderer';
import { BOSS } from '../boss';
import { MAT_METAL, MAT_STD, RAIL } from '../constants';
import { Bullet, type RGB, type Tank, type World } from '../world';
import { BossBase, Barrage, EPS, INF, Poly, WHO, clamp, domDir, gapT, overlap, rand, tellT } from './route';
import { angOf, clearOf, dirOfAng, lineOff, shellAt, slewTo, snap8, tellLine, vecOf } from './aim';
import type { BossPartLike } from './types';

/** Tuning, "easy". Distances in px, times in frames (60 per second). */
export const TRAIN = {
  speed: 0.42,
  /** once both gun cars are gone */
  speedMad: 0.6,
  acc: 0.006,
  /** waits at each end of the line and in the yard */
  endWait: 150,
  yardWait: 300,
  /** px kept clear of the map edge at the ends of the line */
  margin: 8,
  /** sees a player this close to any wagon; in the yard it wakes at `wake`, or by itself after wakeAfter */
  sight: 230,
  wake: 200,
  wakeAfter: 60 * 20,
  width: 16,
  engineLen: 44,
  carLen: 40,
  gap: 4,
  /** wagons are drawn at the track's angle snapped to 1/angSteps of a turn (0 = free), so the nearest-pixel image
   * only changes now and then on a curve instead of crawling every frame */
  angSteps: 128,
  hp: { gun: 6, aa: 6, rockets: 6, supply: 4, engine: 10 }, // gun was 8, engine 12
  // gun cars
  turretTurn: 30,
  gunReload: 60 * 11, // was 60 * 6 before the turrets fired at any angle (2026-10-16), then 60 * 7, then 60 * 9
  gunGlow: 66,
  /** frames between two turret shots (the tells never overlap) */
  gunGap: 120,
  gunSpeed: 2.2,
  gunDmg: 3, // was 4 (2026-11-18)
  gunRange: 210, // was 230
  gunSlack: 12,
  muzzle: 10,
  // AA car
  mgRange: 104,
  mgDmg: 1,
  mgBurst: 4, // was 5
  mgGap: 7,
  mgPause: 220, // was 100, then 140 (8-direction bursts), then 180
  mgSpeed: 3.2,
  mgSlack: 9,
  /** chance it brings down an FPV drone diving within aaReach px of it */
  aaChance: 0.35,
  aaReach: 64,
  // rocket car
  rocketReload: 60 * 14, // was 10 s
  rocketWarn: 100,
  rocketFlight: 45,
  rocketStagger: 14,
  rocketR: 12,
  rocketDmg: 2, // was 3
  rocketMin: 48,
  rocketRange: 250,
  // supply car
  supplyScrap: [6, 6, 6], // was 20 each (2026-11-18 scrap economy: income cut to about a fifth, see SCRAP_DROP)
  /** scrap for the kill (was BOSS.scrap, 500) */
  scrap: 50,
  // the track
  pushDmg: 2,
  pushGap: 180,
  hornAhead: 88,
  hornGap: 150,
  escort: [0], // was [2, 0, 0]
  dieFrames: 150,
  tellGap: 60 * 12,
};

type UnitKind = 'engine' | 'gun' | 'aa' | 'rockets' | 'supply';

interface TrainPart extends BossPartLike {
  /** index into units */
  unit: number;
}

interface Unit {
  kind: UnitKind;
  len: number;
  /** arc length from the train's head to this unit's front */
  off: number;
  part: TrainPart;
  // placed every update
  /** the wagon's front as a quarter turn (logic that works in the 4 directions: turret aim, shoves) */
  d: number;
  /** its angle along the track (radians clockwise from up, snapped) and the unit vector of its front */
  ang: number;
  fx: number;
  fy: number;
  cx: number;
  cy: number;
  /** world rect: the bounding box of the turned wagon (hits test the turned box itself) */
  rx: number;
  ry: number;
  rw: number;
  rh: number;
  // weapons
  tdir: number;
  /** the turret / AA mount as drawn: slews toward aimA (or lies along the wagon at rest) */
  tang: number;
  /** the world angle it aims or fires along (gun: the player, locked during the tell; AA: the burst's 8 direction);
   * tdir is its nearest quarter */
  aimA: number;
  turnT: number;
  reload: number;
  glow: number;
  recoil: number;
  mg: { n: number; t: number; d: number };
  /** frames since it was destroyed */
  deadT: number;
}

const ORDER: UnitKind[] = ['engine', 'gun', 'aa', 'rockets', 'gun', 'supply'];
const NAMES: Record<UnitKind, [string, string]> = {
  engine: ['ENGINE', 'ENGINE'], gun: ['GUN CAR', 'GUN'], aa: ['AA CAR', 'AA'], rockets: ['ROCKET CAR', 'ROCKETS'], supply: ['SUPPLY CAR', 'SUPPLY'],
};

export class TrainBoss extends BossBase {
  readonly kind = 'train';
  protected readonly scrapReward = TRAIN.scrap;
  readonly name = 'ANVIL';
  readonly title = 'ARMOURED TRAIN';
  readonly goal = 'FIND THEIR ARMOURED TRAIN · STOP IT';
  units: Unit[] = [];
  poly: Poly;
  /** arc length of the head (the engine's front); the train runs H in [hMin, hMax] */
  H = 0;
  hMin = 0;
  hMax = 0;
  /** the yard stop (head position) */
  hYard = 0;
  /** +1 = engine first, -1 = backing (the supply car leads) */
  dirS = 1;
  v = 0;
  /** frames left of a stop */
  waitT = 0;
  moving = false;
  /** stopped by a tank it can't shove aside */
  blockedT = 0;
  /** high beam flashing (the horn tell) */
  beamT = 0;
  hornT = -INF;
  revealAt = 0;
  /** stopped in the yard on this pass already */
  yardStopped = false;
  /** frame the last turret glow began */
  gunClock = -INF;
  rocketReload = 120;
  barrage: Barrage;
  stats = {
    shellHits: 0, noPen: 0, droneHits: 0, rocketHits: 0, partsLost: 0, gunShots: 0, mgShots: 0, salvos: 0, rocketsFired: 0,
    aaKills: 0, pushes: 0, pushDmg: 0, horns: 0, reversals: 0, yardStops: 0, columns: 0, escorts: 0, deaths: 0, blockedFrames: 0,
    offRail: 0, ms: 0, msMax: 0, msSum: 0, n: 0,
  };
  private parts_: TrainPart[] = [];
  private lastTell = -INF;
  private lastRocketTell = -INF;
  private pushT = new Map<Tank, number>();
  private aaJudged = new WeakSet<object>();
  private engineOpen = false;
  private escortAt: [number, number, number] = [0, 0, 0];

  constructor(w: World) {
    super(w);
    const rail = w.region?.rail;
    this.poly = new Poly(rail && rail.length >= 2 ? rail : [[w.pxW * 0.1, w.pxH / 2], [w.pxW * 0.9, w.pxH / 2]]);
    let off = 0;
    // HUD order: the wagons front to back, the engine (the core) at parts[4]
    const hudOrder = [1, 2, 3, 4, 0, 5];
    const parts: TrainPart[] = [];
    ORDER.forEach((kind, i) => {
      const len = kind === 'engine' ? TRAIN.engineLen : TRAIN.carLen;
      const hp = TRAIN.hp[kind === 'gun' ? 'gun' : kind];
      const gunNo = kind === 'gun' ? ORDER.slice(0, i).filter((k) => k === 'gun').length + 1 : 0;
      const part: TrainPart = {
        id: kind === 'gun' ? `gun${gunNo}` : kind, name: kind === 'gun' ? `GUN CAR ${gunNo}` : NAMES[kind][0], short: NAMES[kind][1],
        kind: kind === 'engine' ? 'turret' : kind, hp, max: hp, hitT: 0, unit: i,
      };
      parts.push(part);
      this.units.push({
        kind, len, off, part, d: 0, ang: 0, fx: 0, fy: -1, cx: 0, cy: 0, rx: 0, ry: 0, rw: 0, rh: 0,
        tdir: 0, tang: 0, aimA: 0, turnT: 0, reload: 90 + i * 40, glow: -1, recoil: 0, mg: { n: 0, t: 0, d: 0 }, deadT: 0,
      });
      off += len + TRAIN.gap;
    });
    this.parts_ = hudOrder.map((k) => parts[k]);
    this.parts = this.parts_;
    const total = off - TRAIN.gap;
    this.hMin = Math.min(this.poly.len, total + TRAIN.margin);
    this.hMax = Math.max(this.hMin, this.poly.len - TRAIN.margin);
    this.hYard = clamp(this.yardAt() + total / 2, this.hMin, this.hMax);
    this.H = this.hYard;
    this.barrage = new Barrage(w, this.proxy);
    this.place();
    for (const u of this.units) { u.tdir = u.d; u.tang = u.aimA = u.ang; }
    this.lairNear = this.townNear(this.units[3].cx, this.units[3].cy);
  }

  get length(): number { return this.units[this.units.length - 1].off + TRAIN.carLen; }
  get engine(): Unit { return this.units[0]; }
  get turret(): BossPartLike { return this.engine.part; }
  get cx(): number { return this.engine.cx; }
  get cy(): number { return this.engine.cy; }
  /** The engine takes damage: both gun cars are gone. */
  exposed(): boolean { return this.units.every((u) => u.kind !== 'gun' || u.part.hp <= 0); }

  /** Arc length of the junction yard: where the most siding track (RAIL cells off the main line) lies beside it;
   * the middle of the line if there are no sidings (test maps). */
  private yardAt(): number {
    const m = this.w.map;
    const P = this.poly;
    let best = P.len / 2;
    let bn = 12;
    for (let s = 0; s <= P.len; s += 16) {
      const [x, y] = P.at(s);
      let n = 0;
      for (let cy = Math.floor((y - 28) / 4); cy <= Math.floor((y + 28) / 4); cy++) {
        for (let cx = Math.floor((x - 40) / 4); cx <= Math.floor((x + 40) / 4); cx++) {
          if (m.at(cx, cy) !== RAIL) continue;
          if (P.nearest(cx * 4 + 2, cy * 4 + 2)[1] > 9) n++;
        }
      }
      if (n > bn) { bn = n; best = s; }
    }
    return best;
  }

  // ---------- geometry ----------
  /** Lay the wagons along the line from the head position: each centred on the track halfway along it, turned to
   * the chord from its back to its front end (so on a curve the cars follow it one after another). */
  private place(): void {
    const P = this.poly;
    const step = TRAIN.angSteps > 0 ? (Math.PI * 2) / TRAIN.angSteps : 0;
    for (const u of this.units) {
      const sF = this.H - u.off;
      const sB = sF - u.len;
      const [fx, fy] = P.at(sF);
      const [bx, by] = P.at(sB);
      const [mx, my] = P.at((sF + sB) / 2);
      u.d = domDir(fx - bx, fy - by);
      let ang = Math.atan2(fx - bx, by - fy);
      if (step) ang = Math.round(ang / step) * step;
      u.ang = ang;
      u.fx = Math.sin(ang);
      u.fy = -Math.cos(ang);
      // bounding box of the turned wagon
      const hl = u.len / 2;
      const hw = TRAIN.width / 2;
      const ex = Math.abs(u.fx) * hl + Math.abs(u.fy) * hw;
      const ey = Math.abs(u.fy) * hl + Math.abs(u.fx) * hw;
      u.cx = mx;
      u.cy = my;
      u.rx = mx - ex;
      u.ry = my - ey;
      u.rw = ex * 2;
      u.rh = ey * 2;
    }
    const e = this.engine;
    this.dir = e.d;
    this.x = e.cx - 24;
    this.y = e.cy - 24;
    this.proxy.x = e.cx - 8;
    this.proxy.y = e.cy - 8;
  }

  /** The first wagon whose turned box overlaps the axis-aligned rect (separating axes: the bounding box covers the
   * map's axes, then the wagon's own two). */
  private unitAt(x: number, y: number, w: number, h: number): Unit | null {
    const hx = w / 2;
    const hy = h / 2;
    for (const u of this.units) {
      if (!overlap(x, y, w, h, u.rx, u.ry, u.rw, u.rh)) continue;
      const qx = x + hx - u.cx;
      const qy = y + hy - u.cy;
      const ax = Math.abs(u.fx);
      const ay = Math.abs(u.fy);
      if (Math.abs(qx * u.fx + qy * u.fy) >= u.len / 2 + hx * ax + hy * ay - EPS) continue;
      if (Math.abs(qy * u.fx - qx * u.fy) >= TRAIN.width / 2 + hx * ay + hy * ax - EPS) continue;
      return u;
    }
    return null;
  }

  distTo(x: number, y: number): number {
    let bd = Infinity;
    for (const u of this.units) {
      const qx = x - u.cx;
      const qy = y - u.cy;
      const a = Math.max(0, Math.abs(qx * u.fx + qy * u.fy) - u.len / 2);
      const c = Math.max(0, Math.abs(qy * u.fx - qx * u.fy) - TRAIN.width / 2);
      bd = Math.min(bd, Math.hypot(a, c));
    }
    return bd;
  }

  overlaps(x: number, y: number, w: number, h: number): boolean {
    return this.present && !!this.unitAt(x, y, w, h);
  }

  blocks(t: Tank, x: number, y: number): boolean {
    if (!this.present) return false;
    return !!this.unitAt(x, y, 16, 16) && !this.unitAt(t.x, t.y, 16, 16);
  }

  // ---------- per update ----------
  update(): void {
    const w = this.w;
    const t0 = performance.now();
    if (this.state === 'hidden') {
      if (w.frame % 30 === 0 && this.townsToReveal() === 0) this.reveal();
      return;
    }
    if (this.hitT > 0) this.hitT--;
    if (this.beamT > 0) this.beamT--;
    for (const p of this.parts_) if (p.hitT > 0) p.hitT--;
    for (const u of this.units) {
      if (u.recoil > 0) u.recoil--;
      if (u.part.hp <= 0) u.deadT++;
      else this.slew(u);
    }
    this.moving = false;
    if (this.state === 'dying') this.updateDying();
    else if (this.state === 'dead') this.updateWreck();
    else {
      this.perceive(this.state === 'lair' ? TRAIN.wake : TRAIN.sight);
      if (this.state === 'lair' && (this.target || w.frame - this.revealAt > TRAIN.wakeAfter)) this.wake();
      if (w.freeze === 0 && !w.over) {
        this.guns();
        this.aa();
        this.rockets();
        this.drive();
      }
      this.smoke();
    }
    this.barrage.update((s) => {
      w.snd('trick-rocket', s.fx, 0.9);
      w.flashes.push({ x: s.fx, y: s.fy, t: 0, max: 8, r: 40, col: [1, 0.6, 0.3], z: 10 });
      this.stats.rocketsFired++;
    });
    const ms = performance.now() - t0;
    const s = this.stats;
    s.ms = ms;
    s.msMax = Math.max(s.msMax, ms);
    s.msSum += ms;
    s.n++;
  }

  // ---------- reveal ----------
  reveal(): void {
    if (this.state !== 'hidden') return;
    const w = this.w;
    this.H = this.hYard;
    this.place();
    // it will set off toward the player's side of the yard
    const p = w.livePlayers()[0];
    if (p) this.dirS = this.poly.nearest(p.cx, p.cy)[0] > this.H - this.length / 2 ? 1 : -1;
    for (const u of this.units) { u.tdir = u.d; u.tang = u.aimA = u.ang; }
    this.revealed = true;
    this.state = 'lair';
    this.revealAt = w.frame;
    this.waitT = 0;
    this.yardStopped = true;
    this.clearTrack();
    const mid = this.units[3];
    this.lairNear = this.townNear(mid.cx, mid.cy);
    this.escortAt = [mid.cx, mid.cy, (mid.d + 1) & 3];
    const n = w.ai?.bossEscort(TRAIN.escort, this.name, () => this.escortAt) ?? 0;
    this.stats.escorts += n;
    this.say('HQ', `SCOUTS FOUND THEIR ARMOURED TRAIN. CALLSIGN ${this.name}, IN THE JUNCTION YARD NEAR ${this.lairNear}. TAKE OUT BOTH GUN CARS AND ITS ENGINE IS OPEN.`);
    this.say(WHO, `${this.name}: BOILERS HOT. LET THEM COME TO THE LINE.`);
    w.note('BOSS LOCATED', 'warn');
    w.snd('column', mid.cx, 1);
    this.horn();
    this.logEv(`revealed at H ${Math.round(this.H)} of ${Math.round(this.poly.len)} near ${this.lairNear}, escort ${n}`);
  }

  private wake(): void {
    if (this.state !== 'lair') return;
    this.state = 'hunt';
    this.waitT = 50;
    this.say(WHO, `${this.name}: CONTACT. DEPARTING THE YARD. CLEAR THE LINE OR BE FLATTENED.`);
    this.logEv('wakes');
  }

  /** Shove any tank caught under the wagons off the track (at the reveal). */
  private clearTrack(): void {
    for (const t of this.w.allTanks()) {
      if (!t.alive || !this.unitAt(t.x, t.y, 16, 16)) continue;
      if (!this.shove(t, false)) {
        const s = this.w.freeSpotNear(t.x, t.y);
        if (s) { t.x = s[0]; t.y = s[1]; }
      }
    }
  }

  // ---------- driving ----------
  private horn(): void {
    const w = this.w;
    if (w.frame - this.hornT < 40) return;
    this.hornT = w.frame;
    this.beamT = 50;
    this.stats.horns++;
    const lead = this.dirS > 0 ? this.engine : this.units[this.units.length - 1];
    w.snd('boss-horn', lead.cx, 1);
  }

  private drive(): void {
    const w = this.w;
    if (this.state !== 'hunt') return;
    if (this.waitT > 0) {
      this.waitT--;
      this.v = 0;
      if (this.waitT === 40) this.horn(); // the horn before it pulls out
      return;
    }
    // next stop ahead: the yard (once per pass) or the end of the line
    const end = this.dirS > 0 ? this.hMax : this.hMin;
    const yardAhead = !this.yardStopped && (this.hYard - this.H) * this.dirS > 0.005;
    const stopAt = yardAhead ? this.hYard : end;
    const dist = Math.abs(stopAt - this.H);
    const vmax = this.exposed() ? TRAIN.speedMad : TRAIN.speed;
    const want = Math.min(vmax, Math.sqrt(2 * TRAIN.acc * dist) + 0.02);
    this.v = this.v < want ? Math.min(want, this.v + TRAIN.acc) : want;
    const step = Math.min(this.v, dist);
    if (step > EPS && !this.advance(step * this.dirS)) {
      this.v = 0;
      this.stats.blockedFrames++;
      if (++this.blockedT % 90 === 1) this.horn();
      return;
    }
    this.blockedT = 0;
    this.watchTrack();
    if (dist - step < 0.01) {
      this.H = stopAt;
      this.place();
      this.v = 0;
      if (yardAhead) {
        this.yardStopped = true;
        this.waitT = TRAIN.yardWait;
        this.stats.yardStops++;
        this.logEv('yard stop');
      } else {
        this.dirS = -this.dirS;
        this.yardStopped = false;
        this.waitT = TRAIN.endWait;
        this.stats.reversals++;
        this.logEv(`end of the line, reversing (${this.dirS > 0 ? 'engine first' : 'backing'})`);
      }
    }
  }

  /** Move the head by ds along the line; tanks in the way are shoved aside. False (and no move) if one can't be. */
  private advance(ds: number): boolean {
    const H0 = this.H;
    this.H = clamp(this.H + ds, this.hMin, this.hMax);
    this.place();
    for (const t of this.w.allTanks()) {
      if (!t.alive || t.spawn > 0 || !this.unitAt(t.x, t.y, 16, 16)) continue;
      if (!this.shove(t, true)) {
        this.H = H0;
        this.place();
        return false;
      }
    }
    this.moving = true;
    return true;
  }

  /** Tank t off the track, to the nearest clear spot beside the wagon it is under. A player loses TRAIN.pushDmg. */
  private shove(t: Tank, hurt: boolean): boolean {
    const w = this.w;
    const u = this.unitAt(t.x, t.y, 16, 16);
    if (!u) return true;
    const across = u.d & 1 ? 'y' : 'x';
    const side = (across === 'x' ? t.cx - u.cx : t.cy - u.cy) >= 0 ? 1 : -1;
    for (const s of [side, -side]) {
      for (let k = 0; k < 8; k++) {
        let nx = t.x;
        let ny = t.y;
        if (across === 'x') nx = s > 0 ? Math.ceil((u.rx + u.rw) / 4) * 4 + k * 4 : Math.floor((u.rx - 16) / 4) * 4 - k * 4;
        else ny = s > 0 ? Math.ceil((u.ry + u.rh) / 4) * 4 + k * 4 : Math.floor((u.ry - 16) / 4) * 4 - k * 4;
        if (!this.clearFor(t, nx, ny)) continue;
        t.x = nx;
        t.y = ny;
        this.stats.pushes++;
        w.sparks(t.cx, t.cy, 6, [1, 0.8, 0.45]);
        w.snd('armor', t.cx, 0.8);
        w.shake = Math.max(w.shake, 1.5);
        if (hurt && t.isPlayer && w.frame - (this.pushT.get(t) ?? -INF) > TRAIN.pushGap) {
          this.pushT.set(t, w.frame);
          this.stats.pushDmg += TRAIN.pushDmg;
          w.hitPlayer(t, this.proxy, TRAIN.pushDmg);
          this.logEv(`shoved P${t.player + 1} off the track`);
        }
        return true;
      }
    }
    return false;
  }

  private clearFor(t: Tank, x: number, y: number): boolean {
    const w = this.w;
    if (x < 0 || y < 0 || x > w.pxW - 16 || y > w.pxH - 16) return false;
    if (w.map.solidForTank(x, y, t.hover) || w.depotBlocks(x, y) || this.unitAt(x, y, 16, 16)) return false;
    for (const o of w.allTanks()) if (o !== t && o.alive && overlap(x, y, 16, 16, o.x, o.y, 16, 16)) return false;
    return true;
  }

  /** The tell: horn and high beam when a player sits on the track ahead. */
  private watchTrack(): void {
    const w = this.w;
    const lead = this.dirS > 0 ? this.H : this.H - this.length;
    for (const p of w.livePlayers()) {
      const [s, d] = this.poly.nearest(p.cx, p.cy);
      if (d > 16) continue;
      const ahead = (s - lead) * this.dirS;
      if (ahead > 0 && ahead < TRAIN.hornAhead && w.frame - this.hornT > TRAIN.hornGap) this.horn();
    }
  }

  /** Turn the turret / AA mount toward its aim: the world angle it fires along while it has a target (a gun turret
   * at its real angle, which is the gun's), else lying along its wagon (at the wagon's angle on a curve). */
  private slew(u: Unit): void {
    if (u.kind !== 'gun' && u.kind !== 'aa') return;
    const Q = Math.PI / 2;
    const rest = !this.target && u.glow < 0 && u.recoil === 0 && u.mg.n === 0;
    const want = rest ? u.ang + ((u.tdir - u.d + 4) & 3) * Q : u.aimA;
    u.tang = slewTo(u.tang, want, u.kind === 'aa' ? Q / 8 : Q / TRAIN.turretTurn);
  }

  // ---------- gun cars ----------
  private guns(): void {
    const w = this.w;
    const t = this.target;
    for (const u of this.units) {
      if (u.kind !== 'gun' || u.part.hp <= 0) continue;
      if (u.reload > 0) u.reload--;
      if (u.glow >= 0) {
        u.glow++;
        if (u.glow % 15 === 1) w.snd('boss-charge', u.cx, 0.9);
        if (u.glow >= tellT(w, TRAIN.gunGlow)) {
          u.glow = -1;
          this.fireGun(u);
        }
        continue;
      }
      // the turret slews toward the target (slew()), or lies along the wagon
      if (t) u.aimA = angOf(t.cx - u.cx, t.cy - u.cy);
      u.tdir = t ? dirOfAng(u.aimA) : u.d;
      if (u.reload > 0 || !t || this.state !== 'hunt' || w.frame - this.gunClock < TRAIN.gunGap) continue;
      const [lat, along] = lineOff(u.cx, u.cy, Math.sin(u.tang), -Math.cos(u.tang), t.cx, t.cy);
      if (lat > TRAIN.gunSlack || along < 20 || along > TRAIN.gunRange) continue;
      // the barrel is on them: lock onto where they are now (the tell and the shell follow this exact line)
      const [vx, vy] = vecOf(u.aimA);
      if (!clearOf(w.map, u.cx + vx * TRAIN.muzzle, u.cy + vy * TRAIN.muzzle, vx, vy, along - TRAIN.muzzle)) continue;
      u.tang = u.aimA;
      u.glow = 0;
      this.gunClock = w.frame;
      if (w.frame - this.lastTell > TRAIN.tellGap) {
        this.lastTell = w.frame;
        this.say(WHO, `${this.name}: ${u.part.name}, TRAVERSE AND FIRE ON MY MARK.`);
      }
    }
  }

  private fireGun(u: Unit): void {
    const w = this.w;
    const [dx, dy] = vecOf(u.aimA);
    const mx = u.cx + dx * (TRAIN.muzzle + 1);
    const my = u.cy + dy * (TRAIN.muzzle + 1);
    const b = shellAt(mx, my, dx, dy, TRAIN.gunSpeed, this.proxy, true);
    b.dmg = TRAIN.gunDmg;
    w.bullets.push(b);
    u.reload = gapT(w, TRAIN.gunReload);
    u.recoil = 10;
    this.stats.gunShots++;
    w.flashes.push({ x: mx + dx * 3, y: my + dy * 3, t: 0, max: 12, r: 80, col: [1, 0.6, 0.3], z: 12, vx: dx, vy: dy });
    w.shake = Math.max(w.shake, 2.5);
    for (let i = 0; i < 6; i++) {
      w.parts.push({
        x: mx, y: my, z: 8, vx: dx * (0.4 + rand() * 0.8) + (rand() - 0.5) * 0.8, vy: dy * (0.4 + rand() * 0.8) + (rand() - 0.5) * 0.8, vz: 0.05,
        life: 0, max: 40 + Math.floor(rand() * 20), col: [0.5, 0.5, 0.52], kind: 2, r: 3 + rand() * 2,
      });
    }
    w.snd('boss-cannon', u.cx, 1);
    w.snd('explode', u.cx, 0.5);
  }

  // ---------- AA car ----------
  private aa(): void {
    const w = this.w;
    const u = this.units.find((q) => q.kind === 'aa')!;
    if (u.part.hp <= 0) return;
    const s = u.mg;
    // FPV drones diving in near it: one judgement per drone
    for (const f of w.abil?.fpvs ?? []) {
      if (this.aaJudged.has(f) || f.t < f.dur * 0.45 || Math.hypot(f.tx - u.cx, f.ty - u.cy) > TRAIN.aaReach) continue;
      this.aaJudged.add(f);
      // the AA burst at the drone, hit or miss
      for (let k = 0; k < 3; k++) w.flashes.push({ x: u.cx, y: u.cy, t: -k * 4, max: 4, r: 22, col: [1, 0.8, 0.4], z: 9 });
      w.snd('eshoot', u.cx, 0.35);
      if (rand() >= TRAIN.aaChance * (1 - w.ease)) continue;
      w.abil!.fpvs.splice(w.abil!.fpvs.indexOf(f), 1);
      this.stats.aaKills++;
      w.explode(f.x, f.y, false);
      w.sparks(f.x, f.y, 10, [1, 0.8, 0.4]);
      w.note('DRONE SHOT DOWN', 'warn');
      this.say('WASP', 'THEIR AA CAR ATE MY BIRD. KILL THE AA CAR AND THE SKY IS OURS.');
      this.logEv('AA shot down a drone');
    }
    if (s.t > 0) {
      s.t--;
      return;
    }
    if (s.n > 0) {
      const [ux, uy] = vecOf(s.d);
      const b = shellAt(u.cx + ux * 7, u.cy + uy * 7, ux, uy, TRAIN.mgSpeed, this.proxy, false);
      b.dmg = TRAIN.mgDmg;
      b.mg = true;
      b.range = TRAIN.mgRange + 12;
      w.bullets.push(b);
      w.flashes.push({ x: u.cx + ux * 8, y: u.cy + uy * 8, t: 0, max: 4, r: 22, col: [1, 0.8, 0.4], z: 9 });
      w.snd('eshoot', u.cx, 0.3);
      this.stats.mgShots++;
      s.n--;
      s.t = s.n ? TRAIN.mgGap : gapT(w, TRAIN.mgPause);
      return;
    }
    const t = this.target;
    if (!t || this.state !== 'hunt') return;
    // the nearest of the 8 directions (s.d is the burst's angle)
    const a = snap8(t.cx - u.cx, t.cy - u.cy);
    const [ux, uy] = vecOf(a);
    const [lat, along] = lineOff(u.cx, u.cy, ux, uy, t.cx, t.cy);
    if (lat > TRAIN.mgSlack || along < 8 || along > TRAIN.mgRange || !clearOf(this.w.map, u.cx, u.cy, ux, uy, along)) return;
    s.d = u.aimA = a;
    u.tdir = dirOfAng(a);
    s.n = TRAIN.mgBurst;
    s.t = tellT(w, 8);
  }

  // ---------- rocket car ----------
  private rockets(): void {
    const w = this.w;
    const u = this.units.find((q) => q.kind === 'rockets')!;
    if (this.rocketReload > 0) this.rocketReload--;
    if (u.part.hp <= 0 || this.rocketReload > 0 || this.barrage.busy || this.state !== 'hunt') return;
    const t = this.target;
    if (!t || w.frame - this.lastSeen > 30) return;
    const d = Math.hypot(t.cx - u.cx, t.cy - u.cy);
    if (d < TRAIN.rocketMin || d > TRAIN.rocketRange) return;
    const warn = tellT(w, TRAIN.rocketWarn);
    const pts: [number, number][] = [[t.cx, t.cy]];
    for (let k = 0; pts.length < 3 && k < 30; k++) {
      const a = rand() * Math.PI * 2;
      const r = 16 + rand() * 10;
      const p: [number, number] = [t.cx + Math.cos(a) * r, t.cy + Math.sin(a) * r];
      if (pts.some(([x, y]) => Math.hypot(x - p[0], y - p[1]) < 16)) continue;
      pts.push(p);
    }
    pts.forEach(([x, y], i) => this.barrage.add(x, y, u.cx, u.cy, w.frame + i * TRAIN.rocketStagger, warn, TRAIN.rocketFlight, 1, TRAIN.rocketR, TRAIN.rocketDmg));
    this.rocketReload = gapT(w, TRAIN.rocketReload);
    this.stats.salvos++;
    w.snd('boss-charge', u.cx, 0.6);
    if (Math.hypot(t.cx - u.cx, t.cy - u.cy) < 260) w.note('ROCKETS INCOMING!', 'warn');
    if (w.frame - this.lastRocketTell > TRAIN.tellGap) {
      this.lastRocketTell = w.frame;
      this.say(WHO, `${this.name}: ROCKET CAR, THREE ROUNDS, GRID ${Math.floor(t.cx / 64)}-${Math.floor(t.cy / 64)}. FIRE.`);
    }
    this.logEv(`rocket salvo at ${Math.round(t.cx)},${Math.round(t.cy)}`);
  }

  // ---------- damage ----------
  bulletHit(b: Bullet): boolean {
    if (!this.present || b.owner === this.proxy || !b.owner.isPlayer) return false;
    const u = this.unitAt(b.x - 2, b.y - 2, 4, 4);
    if (!u) return false;
    b.alive = false;
    const w = this.w;
    if (!this.alive || u.part.hp <= 0) {
      w.impact(b, false, true); // a wreck (or the train already going up)
      return true;
    }
    this.stats.shellHits++;
    this.hit(u, b.x, b.y, this.shellDmg(b.owner), b.owner.player, false);
    return true;
  }

  droneHit(x: number, y: number, dmg: number, pi: number): boolean {
    if (!this.alive) return false;
    const u = this.unitAt(x - 3, y - 3, 6, 6);
    if (!u) return false;
    this.stats.droneHits++;
    if (u.part.hp > 0) this.hit(u, x, y, dmg * BOSS.droneMul, pi, true);
    return true;
  }

  rocketHit(x: number, y: number, _dir: number, dmg: number, pi: number): boolean {
    if (!this.present) return false;
    const u = this.unitAt(x - 0.5, y - 0.5, 1, 1);
    if (!u) return false;
    if (this.alive && u.part.hp > 0) {
      this.stats.rocketHits++;
      this.hit(u, x, y, dmg, pi, false);
    }
    return true;
  }

  /** The engine once it is open, else the weakest gun car, else any wagon still standing. */
  aimPoint(): [number, number] {
    let best: Unit | null = null;
    if (this.exposed()) best = this.engine;
    else for (const u of this.units) if (u.kind === 'gun' && u.part.hp > 0 && (!best || u.part.hp < best.part.hp)) best = u;
    best ??= this.units.find((u) => u.part.hp > 0 && u.kind !== 'engine') ?? this.engine;
    return [best.cx, best.cy];
  }

  private hit(u: Unit, wx: number, wy: number, dmg: number, pi: number, drone: boolean): void {
    const w = this.w;
    this.wake();
    if (u.kind === 'engine' && !this.exposed()) {
      this.stats.noPen++;
      this.noPenFx(wx, wy, 'ENGINE ARMOURED: KILL THE GUN CARS', drone ? 'ARMOURED' : 'NO PEN');
      return;
    }
    const p = u.part;
    p.hp = Math.max(0, p.hp - dmg);
    p.hitT = 10;
    this.hitFx(wx, wy, dmg);
    this.logEv(`${drone ? 'drone' : 'hit'} ${p.id} -${dmg} (${p.hp}/${p.max})`);
    if (p.hp <= 0) this.partLost(u, pi);
  }

  private partLost(u: Unit, pi: number): void {
    const w = this.w;
    this.stats.partsLost++;
    if (u.kind === 'engine') {
      this.die(pi);
      return;
    }
    u.glow = -1;
    u.mg.n = 0;
    u.deadT = 0;
    this.partBlast(u.cx, u.cy, u.part.name, pi);
    for (let i = 0; i < 4; i++) this.smokePuff(u.cx + (rand() - 0.5) * 10, u.cy + (rand() - 0.5) * 10, true);
    switch (u.kind) {
      case 'gun': {
        this.say(WHO, `${this.name}: ${u.part.name} IS BURNING. ALL UNITS TO THE LINE, NOW.`);
        const at = this.target ?? w.livePlayers()[0];
        if (w.ai?.bossColumn(at ? at.x : u.cx - 8, at ? at.y : u.cy - 8)) this.stats.columns++;
        if (this.exposed() && !this.engineOpen) {
          this.engineOpen = true;
          w.note('ENGINE EXPOSED', 'power');
          this.say('SPANNER', 'BOTH GUN CARS ARE SCRAP. ITS ENGINE IS NAKED NOW. HIT THE LOCOMOTIVE.');
          this.say(WHO, `${this.name}: GUN CARS LOST. FULL STEAM. RUN THEM DOWN.`);
        }
        break;
      }
      case 'aa':
        this.say(WHO, `${this.name}: AA CAR IS GONE. WATCH THE SKY.`);
        this.say('WASP', 'NO MORE FLAK. MY BIRDS CAN GO IN NOW.');
        break;
      case 'rockets':
        this.barrage.list = this.barrage.list.filter((s) => s.fired);
        this.say(WHO, `${this.name}: ROCKET CAR HIT. RACK IS ON FIRE.`);
        break;
      case 'supply': {
        // the load spills both sides of the track (square to the wagon, spread along it)
        const [ax, ay] = [-u.fy, u.fx];
        TRAIN.supplyScrap.forEach((amount, i) => {
          const s = i % 2 ? 1 : -1;
          const along = (i - 1) * 12;
          w.pickups.push({ x: u.cx + ax * s * 18 + u.fx * along, y: u.cy + ay * s * 18 + u.fy * along, kind: 'scrap', amount, t: 0 });
        });
        w.pickups.push({ x: u.cx + ax * 22, y: u.cy + ay * 22, kind: 'part', amount: 1, t: 0 });
        this.say('SPANNER', 'THE SUPPLY CAR SPILLED ITS GUTS BESIDE THE TRACK. GO AND PICK THEM UP.');
        break;
      }
    }
    this.logEv(`${u.part.id} destroyed`);
  }

  kill(pi = -1): void {
    if (this.state === 'hidden') this.reveal();
    if (!this.alive) return;
    this.engine.part.hp = 0;
    this.die(pi);
  }

  private die(pi: number): void {
    const w = this.w;
    if (!this.alive) return;
    this.state = 'dying';
    this.deathT = 0;
    this.killer = pi;
    this.stats.deaths++;
    for (const u of this.units) u.glow = -1;
    this.barrage.list = this.barrage.list.filter((s) => s.fired);
    this.say(WHO, `${this.name}: BOILER BREACH! ABANDON THE TRAIN!`);
    w.note(`${this.name} IS BURNING`, 'power');
    w.shake = Math.max(w.shake, 5);
    this.logEv('dying');
  }

  // ---------- death sequence and the wreck ----------
  private updateDying(): void {
    const w = this.w;
    const t = ++this.deathT;
    this.hitT = (t >> 2) & 1 ? 3 : 0;
    // it rolls to a stop
    this.v = Math.max(0, this.v - 0.01);
    if (this.v > 0) this.advance(this.v * this.dirS);
    const u = this.units[Math.floor(rand() * this.units.length)];
    const spot = () => this.local(u, 3 + rand() * (TRAIN.width - 6), 3 + rand() * (u.len - 6));
    if (t < TRAIN.dieFrames && t % 7 === 0) {
      const [x, y] = spot();
      w.explode(x, y, false);
      w.sparks(x, y, 8, [1, 0.75, 0.35]);
      w.snd('explode', x, 0.7);
      w.shake = Math.max(w.shake, 2.5);
    }
    if (t === 40 || t === 80 || t === 120) {
      w.explode(...spot(), true);
      w.snd('bigexplode', u.cx, 0.8);
    }
    if (t % 3 === 0) this.smokePuff(...spot(), true);
    if (t >= TRAIN.dieFrames) this.finale();
  }

  private finale(): void {
    const w = this.w;
    const e = this.engine;
    this.state = 'dead';
    this.deadT = 0;
    for (const u of this.units) {
      u.part.hp = 0;
      w.explode(u.cx, u.cy, true);
    }
    w.flashes.push({ x: e.cx, y: e.cy, t: 0, max: 100, r: 240, col: [1, 0.55, 0.2], z: 30 });
    w.shocks.push({ x: e.cx, y: e.cy, t: 0, max: 60, size: 3.2 });
    w.shocks.push({ x: e.cx, y: e.cy, t: 0, max: 36, size: 1.6 });
    w.shake = 10;
    w.snd('bigexplode', e.cx, 1);
    w.snd('explode', e.cx, 1);
    for (let i = 0; i < 30; i++) {
      const b = rand() * Math.PI * 2;
      const s = 0.6 + rand() * 2.2;
      w.parts.push({
        x: e.cx, y: e.cy, z: 10, vx: Math.cos(b) * s, vy: Math.sin(b) * s, vz: 1.5 + rand() * 2.5,
        life: 0, max: 220, col: rand() < 0.5 ? [0.36, 0.38, 0.32] : [0.2, 0.2, 0.2], kind: 0, r: 1,
      });
    }
    for (let i = 0; i < 12; i++) this.smokePuff(e.cx + (rand() - 0.5) * 20, e.cy + (rand() - 0.5) * 20, true);
    this.payout(e.cx, e.cy);
    this.say('HQ', `${this.name} IS OFF THE RAILS FOR GOOD. THE JUNCTION IS OURS.`);
    this.say('SPANNER', 'TWO GOOD PARTS OFF THAT LOCOMOTIVE. THE KETTLE IN THE CAB WAS STILL WARM.');
    this.logEv('destroyed');
  }

  private updateWreck(): void {
    const t = ++this.deadT;
    const every = t < 60 * 30 ? 5 : 16;
    if (this.w.frame % every !== 0) return;
    const u = this.units[Math.floor(rand() * this.units.length)];
    this.smokePuff(u.cx + (rand() - 0.5) * 10, u.cy + (rand() - 0.5) * 10, t < 60 * 30);
  }

  /** Smoke from wrecked wagons, and from the stack while it runs. */
  private smoke(): void {
    const w = this.w;
    if (w.frame % 6 !== 0) return;
    for (const u of this.units) {
      if (u.part.hp > 0 && u.part.hp > u.part.max / 2) continue;
      if (u.part.hp > 0 && w.frame % 18 !== 0) continue;
      this.smokePuff(u.cx + (rand() - 0.5) * 8, u.cy + (rand() - 0.5) * 8, u.part.hp <= 0);
    }
  }

  // ---------- drawing ----------
  draw(r: Renderer, ox: number, oy: number, time: number, head: number): void {
    if (!this.present) return;
    this.barrage.draw(r, ox, oy); // warning marks and rockets in flight (overlay, unlit)
    const A = r.atlas.S;
    const dead = this.state === 'dead';
    const dying = this.state === 'dying';
    const flash = this.hitT > 0 ? (dying ? 0.2 : 0.3) : 0;
    const view = (u: Unit) => ox + u.rx > -60 && oy + u.ry > -60 && ox + u.rx < r.nw + 60 && oy + u.ry < r.nh + 60;
    // couplings between the wagons
    for (let i = 0; i + 1 < this.units.length; i++) {
      const [x, y] = this.poly.at(this.H - this.units[i + 1].off + TRAIN.gap / 2);
      if (ox + x < -20 || oy + y < -20 || ox + x > r.nw + 20 || oy + y > r.nh + 20) continue;
      r.rectG(Math.round(ox + x) - 1, Math.round(oy + y) - 1, 3, 3, MAT_METAL, [0.1, 0.1, 0.1], 0.1);
    }
    for (const u of this.units) {
      if (!view(u)) continue;
      const gone = u.part.hp <= 0 || dead;
      const pf = u.part.hitT > 6 ? 0.65 : flash;
      const base = u.kind === 'engine' ? (gone ? A.trainEngineWreck : A.trainEngine) : gone ? A.trainCarWreck : A.trainCar;
      const ccx = ox + u.cx;
      const ccy = oy + u.cy;
      // whole-pixel centres (all the train's sprites are even-sized), so the turned image holds still at rest
      const X = Math.round(ccx);
      const Y = Math.round(ccy);
      r.sprRot(base, X, Y, u.ang, [1, 1, 1], MAT_STD, 0, 1, pf);
      const dk: RGB = [0.32, 0.28, 0.26];
      const tint: RGB = gone ? dk : [1, 1, 1];
      // the wagon's load, centred and turned with it (turrets turn on their own)
      if (u.kind === 'gun') {
        const rc = u.recoil > 4 ? 2 : u.recoil > 0 ? 1 : 0;
        r.sprRot(A.trainTurret, Math.round(ccx - Math.sin(u.tang) * rc), Math.round(ccy + Math.cos(u.tang) * rc), u.tang, tint, MAT_STD, 0, 1, pf);
      } else if (u.kind === 'aa') {
        r.sprRot(A.trainAA, X, Y, u.tang, tint, MAT_STD, 0, 1, pf);
      } else if (u.kind === 'rockets') {
        r.sprRot(A.trainRack, X, Y, u.ang, tint, MAT_STD, 0, 1, pf);
        // the rack's warning lamp blinks while a salvo is under way
        if (!gone && this.barrage.busy) {
          const [lx, ly] = this.local(u, 8, 11);
          const on = (this.w.frame >> 3) & 1;
          r.glow(ox + lx, oy + ly, 2.5, [1, 0.45, 0.1], on ? 2.4 : 0.6);
          if (on) r.light(ox + lx, oy + ly, 10, 30, 0.8, 0.35, 0.05, false);
        }
      } else if (u.kind === 'supply') {
        r.sprRot(A.trainCrates, X, Y, u.ang, tint, MAT_STD, 0, 1, pf);
      }
      // a burning wagon
      if (gone) {
        const k = dead && this.deadT > 60 * 30 ? 0.35 : 1;
        const fl = 0.6 + 0.4 * Math.sin(time * 11 + u.off) * Math.sin(time * 4.3 + u.off * 0.3);
        r.glow(ccx + Math.sin(u.off) * 3, ccy, 3 * k + 1, [1, 0.5, 0.15], 0.9 * fl);
        r.light(ccx, ccy, 14, 50 * k + 16, 0.9 * k * fl, 0.38 * k * fl, 0.08 * k * fl, true);
      }
    }
    if (dead) return;
    if (dying) {
      const e = this.engine;
      const fl = 0.5 + 0.5 * Math.sin(time * 23);
      r.light(ox + e.cx, oy + e.cy, 18, 90, 1.2 * fl, 0.5 * fl, 0.12 * fl, true);
      r.glow(ox + e.cx, oy + e.cy, 6 + 4 * fl, [1, 0.5, 0.15], 1.2);
      return;
    }
    // at night every wagon shows dim amber lamps at its corners, so the train reads in the dark
    if (head > 1) {
      const lk = 0.25 * (head - 1);
      for (const u of this.units) {
        if (u.part.hp <= 0) continue;
        for (const [lx, ly] of [[1.5, 2.5], [TRAIN.width - 1.5, u.len - 2.5]]) {
          const [px, py] = this.local(u, lx, ly);
          r.glow(ox + px, oy + py, 1.6, [1, 0.62, 0.25], 1.2 * lk + 0.3);
        }
        r.light(ox + u.cx, oy + u.cy, 16, 34, 0.35 * lk, 0.25 * lk, 0.12 * lk, false);
      }
    }
    // the headlight at the leading end (a high beam flashing with the horn), red tail lamps at the other
    const lead = this.dirS > 0 ? this.engine : this.units[this.units.length - 1];
    const ldx = this.dirS * lead.fx;
    const ldy = this.dirS * lead.fy;
    const lx = ox + lead.cx + ldx * (lead.len / 2);
    const ly = oy + lead.cy + ldy * (lead.len / 2);
    const beam = this.beamT > 0 && (this.beamT >> 3) & 1 ? 1.8 : 1;
    const k = Math.max(0.45, head) * beam;
    r.spot(lx + ldx * 2, ly + ldy * 2, 8, 150 * Math.min(1.4, beam), 1.2 * k, 1.05 * k, 0.75 * k, true, ldx, ldy, 0.8, 0.95);
    r.glow(lx, ly, 2.5 + beam, [1, 0.95, 0.75], 1.4 * beam);
    // the gun cars' tell: the barrel glows hotter, beeping, with a dotted line along its aim
    for (const u of this.units) {
      if (u.kind !== 'gun' || u.glow < 0 || u.part.hp <= 0) continue;
      const g = u.glow / tellT(this.w, TRAIN.gunGlow);
      // the glow at the barrel's tip, the dots along the shell's path (the turret is locked on it)
      const [ux, uy] = vecOf(u.aimA);
      const mx = ox + u.cx + Math.sin(u.tang) * (TRAIN.muzzle - 1);
      const my = oy + u.cy - Math.cos(u.tang) * (TRAIN.muzzle - 1);
      const pulse = 0.75 + 0.25 * Math.sin(time * 30);
      r.glow(mx, my, 3 + g * 5, [1, 0.35, 0.12], (1.2 + g * 3.5) * pulse);
      r.glow(ox + u.cx, oy + u.cy, 4, [1, 0.3, 0.1], (0.4 + g) * pulse);
      r.light(mx, my, 14, 40 + g * 60, 1.2 * g * pulse, 0.3 * g * pulse, 0.1 * g * pulse, false);
      if ((u.glow >> 3) & 1) tellLine(r, mx, my, ux, uy, 14, 120, 140);
    }
  }

  /** Local point of a wagon's frame (x across, y back from its front) to world. */
  private local(u: Unit, lx: number, ly: number): [number, number] {
    // across = right of the front (-fy, fx), down the frame = back (-fx, -fy)
    const ax = lx - TRAIN.width / 2;
    const ay = ly - u.len / 2;
    return [u.cx - ax * u.fy - ay * u.fx, u.cy + ax * u.fx - ay * u.fy];
  }

  /** Smoke from the stack, wake of air as it runs, fire and smoke from wrecked wagons. */
  fluid(r: Renderer, ox: number, oy: number, f: number, time: number): void {
    if (!this.present) return;
    const e = this.engine;
    const on = (x: number, y: number) => x > -80 && y > -80 && x < r.nw + 80 && y < r.nh + 80;
    if (this.state === 'dead') {
      const k = this.deadT < 60 * 30 ? 1 : 0.3;
      for (const u of this.units) {
        if (!on(ox + u.cx, oy + u.cy)) continue;
        r.dyeSplat(ox + u.cx + Math.sin(time * 3 + u.off) * 3, oy + u.cy - 2, 6, 0.5 * k * f, 0.35 * k * f, 0.1 * k * f);
        r.velSplat(ox + u.cx, oy + u.cy - 4, 6, 0, -9 * f);
      }
      return;
    }
    if (this.state === 'dying') {
      const u = this.units[Math.floor(Math.random() * this.units.length)];
      r.dyeSplat(ox + u.cx + (Math.random() - 0.5) * 12, oy + u.cy + (Math.random() - 0.5) * 12, 7, 0.5 * f, 0.6 * f, 0.4 * f);
      return;
    }
    // the stack: puffs harder when it pulls away
    const [sx, sy] = this.local(e, 8, 27);
    const px = ox + sx;
    const py = oy + sy;
    if (on(px, py)) {
      const puff = this.moving ? 0.22 + this.v * 0.4 : 0.07;
      r.dyeSplat(px, py, 3, puff * f, 0.1 * f, 0);
      if (this.moving) r.velSplat(px, py, 6, -e.fx * this.dirS * 120 * r.dt, -e.fy * this.dirS * 120 * r.dt - 20 * r.dt);
    }
    for (const u of this.units) {
      if (u.part.hp > 0 || !on(ox + u.cx, oy + u.cy)) continue;
      r.dyeSplat(ox + u.cx, oy + u.cy, 4, 0.32 * f, 0.22 * f, 0.1 * f);
    }
    if (this.moving) {
      for (const u of [this.units[0], this.units[this.units.length - 1]]) if (on(ox + u.cx, oy + u.cy)) r.velSplat(ox + u.cx, oy + u.cy, 14, u.fx * this.dirS * 160 * r.dt, u.fy * this.dirS * 160 * r.dt);
    }
  }

  /** For tools: where the wagons are (centre, facing) and how far from the rail line each centre sits. */
  offRail(): number {
    let worst = 0;
    for (const u of this.units) worst = Math.max(worst, this.poly.nearest(u.cx, u.cy)[1]);
    return worst;
  }

  /** For tools: a wagon's world rect by part id. */
  unitRect(id: string): [number, number, number, number] | null {
    const u = this.units.find((q) => q.part.id === id);
    return u ? [u.rx, u.ry, u.rw, u.rh] : null;
  }

  /** For tools: the local frame of a wagon (front = 0) back to world. */
  unitPoint(id: string, lx: number, ly: number): [number, number] | null {
    const u = this.units.find((q) => q.part.id === id);
    return u ? this.local(u, lx, ly) : null;
  }

  /** For tools: world px to a wagon's local frame. */
  unitLocal(id: string, wx: number, wy: number): [number, number] | null {
    const u = this.units.find((q) => q.part.id === id);
    if (!u) return null;
    const qx = wx - u.cx;
    const qy = wy - u.cy;
    return [qy * u.fx - qx * u.fy + TRAIN.width / 2, u.len / 2 - (qx * u.fx + qy * u.fy)];
  }

  /** A part's wagon as a turned box (centre, size across x along, angle): the weak-point markers follow it. */
  partBox(p: BossPartLike): [number, number, number, number, number] {
    const u = this.units.find((q) => q.part === p) ?? this.engine;
    return [u.cx, u.cy, TRAIN.width, u.len, u.ang];
  }

  /** A part's world rect (its whole wagon): tools and the weak-point markers. */
  partRect(p: BossPartLike): [number, number, number, number] {
    const u = this.units.find((q) => q.part === p) ?? this.engine;
    return [u.rx, u.ry, u.rw, u.rh];
  }
}
