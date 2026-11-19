// Phase 4: region bosses (CAMPAIGN.md "A run", "Regions and bosses").
//
// Framework: World.boss exists on region maps with towns. It stays hidden until enough towns are freed
// (BOSS.reveal, or all of them when the region has fewer), then it appears at its lair with an escort: HQ radios
// where it is, a "BOSS LOCATED" toast, a marker on both maps and the boss line on the objectives plate. From then on
// the region is clear when the boss is destroyed (World.update asks `boss.cleared()`); freeing towns still pays.
// Nothing about a boss is saved: a run saves between regions only, so a reload or a retreat restarts the region and
// its boss with it.
//
// A boss is a 48 x 48 px body made of parts. Each weak point has its own hp and hit box, given in the hull's
// up-facing frame (`rect`, rotated with the hull), and changes the fight when it goes: the HUD bar shows one segment
// group per part. Player shells hit the part at the contact point; drone strikes hit the part under the reticle for
// BOSS.droneMul x the normal drone damage, from above, so they also reach the protected turret.
//
// Region 1 boss, "GRINDER" (invented callsign), a heavy tank ace: slow, drives along roads toward a player it can
// see, crushes brick, stops to fire. Main gun: a 1 s barrel glow with warning beeps, then a slow heavy shell
// (BOSS.gunDmg armour). Two machine-gun sponsons at the front corners: short bursts of small shells (1 armour,
// short range). Side armour skirts cover the treads. Weak points: the sponsons, the skirts, then the turret, which
// shells only hurt once a skirt is gone (the side is open) or from behind (the engine deck); drones always can, but
// a drone hit makes it fire its smoke dischargers: for BOSS.smokeHold frames it sits in a smoke cloud and the next
// drones lose it ("LOST IN SMOKE"). Shells still hit. World.ease slows its tells and reloads, like the other bosses.
// Losing a sponson makes it radio for a column; losing a skirt makes it angrier (faster reload). Escort: 3 tanks
// from the AI director (ai.bossEscort) that keep station ahead of it. Death: a chain of blasts, a final explosion
// with shockwaves, the turret thrown off; the wreck stays and burns; +BOSS.scrap, 2 captured parts, radio lines.
//
// Hooks (marked "Phase 4 boss hook"): world.ts (constructor, update, blockedAt, tankIn, bulletStep, clear rule,
// heavy/MG shells), ai.ts (bossEscort, bossColumn, escort groups), abilities.ts (drone strikes and rockets),
// draw.ts (draw, fluid sources, shells), ui-campaign.ts (boss bar, objectives line, map markers), app.ts (tally).
import type { Renderer } from '../gl/renderer';
import { BRICK, DOWN, DX, DY, EMPTY, LEFT, MAT_STD, RIGHT, ROAD, STEEL, TREES, UP, WATER } from './constants';
import { Tank, type Bullet, type RGB, type World } from './world';
import { FinalBoss } from './bosses/final'; // Phase 4 regions 4-5
import { EIGHTH, QUARTER, angOf, angOfDir, clearOf, dirOfAng, lineOff, shellAt, slewTo, snap8, tellLine, vecOf } from './bosses/aim';
import { HeliBoss } from './bosses/heli';
import type { BossLike, RegionBoss } from './bosses/types';
import { FlagshipBoss } from './bosses/flagship'; // Phase 4 regions 2-3
import { TrainBoss } from './bosses/train';

const rand = Math.random;
/** World.ease for reloads and gaps: -0.2 (the last regions, quicker) .. 0.3 (eased). Tells never go below 0. */
export const heat = (e: number) => (Number.isFinite(e) ? Math.max(-0.2, Math.min(0.5, e)) : 0);
const INF = 0x3fffffff;
const EPS = 1e-4;

/** Tuning, "easy". Distances in px, times in frames (60 per second). */
export const BOSS = {
  size: 48,
  /** towns freed before the boss shows itself (all of them if the region has fewer) */
  reveal: 3,
  speed: 0.3,
  /** frames to pivot the hull a quarter turn, and the turret */
  turnPause: 30,
  turretTurn: 34,
  /** sees a player this close (trees hide one beyond treeSight); in its lair it wakes at `wake` */
  sight: 210,
  treeSight: 64,
  wake: 170,
  /** holds position (a gun platform) when a player in its gun line is this close */
  standOff: 96,
  hp: { sponson: 4, skirt: 6, turret: 12 }, // turret was 14
  gunReload: 60 * 8, // was 60 * 5 before boss shells could fly at an angle (2026-10-16), then 60 * 6
  gunReloadMad: 330, // was 240, then 285
  gunGlow: 60,
  gunSpeed: 2.2,
  gunDmg: 3, // was 4 (2026-11-18: the opening region's boss did more damage than any later one)
  gunRange: 250,
  /** a player this far off the barrel's line (px) still counts as in line */
  gunSlack: 12,
  mgRange: 104,
  mgDmg: 1,
  mgBurst: 3, // was 4
  mgGap: 8,
  mgPause: 180, // was 110, then 150 (8-direction bursts)
  mgSpeed: 3.2,
  mgSlack: 9,
  /** FPV drone strikes do ABIL.fpvDmg x this to the part under the reticle */
  droneMul: 2,
  /** frames its smoke screen hides it from drones after a drone hit; it judges a drone this long before the hit */
  smokeHold: 60 * 7,
  smokeAt: 18,
  escort: [0], // was [2, 0, 0]: a power tank and two basics
  /** GRINDER's kill (ANVIL and MORAY pay TRAIN.scrap / FLAG.scrap); was 500, and 25 a weak point (2026-11-18 scrap economy: income cut to about a fifth, see SCRAP_DROP) */
  scrap: 100,
  partScrap: 6,
  captured: 2,
  pathEvery: 90,
  /** frames of the death sequence before the final blast */
  dieFrames: 130,
  /** a boss radio tell before the main gun at most this often */
  tellGap: 60 * 14,
};

export type PartKind = 'skirt' | 'sponson' | 'turret';

export interface BossPart {
  id: string;
  /** shown in toasts; `short` labels the HUD bar */
  name: string;
  short: string;
  kind: PartKind;
  /** hit box in the hull's up-facing frame (x, y, w, h), 0..48 */
  rect: [number, number, number, number];
  /** -1 left, 0 centre, 1 right (hull-relative) */
  side: number;
  hp: number;
  max: number;
  hitT: number;
}

export type BossState = 'hidden' | 'lair' | 'hunt' | 'dying' | 'dead';

const S = BOSS.size;
/** px from the boss's centre to the main gun's muzzle (the barrel reaches past the hull front) */
const MUZZLE = 31;

/** Rotate a point of the up-facing 48 px frame clockwise by `d` quarter turns. */
function rotPt(px: number, py: number, d: number): [number, number] {
  switch (d & 3) {
    case 1: return [S - py, px];
    case 2: return [S - px, S - py];
    case 3: return [py, S - px];
    default: return [px, py];
  }
}

const overlap = (ax: number, ay: number, aw: number, ah: number, bx: number, by: number, bw: number, bh: number) =>
  ax < bx + bw - EPS && ax + aw > bx + EPS && ay < by + bh - EPS && ay + ah > by + EPS;

/** Dominant axis direction of (dx, dy). */
function domDir(dx: number, dy: number): number {
  return Math.abs(dx) >= Math.abs(dy) ? (dx < 0 ? LEFT : RIGHT) : dy < 0 ? UP : DOWN;
}

const WHO = 'INTERCEPT';

export class Boss implements BossLike {
  readonly kind = 'ace';
  readonly name = 'GRINDER';
  readonly title = 'HEAVY TANK ACE';
  /** top-left in world px (on the 8 px grid between steps) */
  x = 0;
  y = 0;
  dir = DOWN;
  /** turret angle, radians clockwise from up: slews on its own toward the target; the main gun fires along it at any
   * angle (src/game/bosses/aim.ts) */
  ta = angOfDir(DOWN);
  /** the turret's nearest quarter direction (setting it points the turret straight that way) */
  get tdir(): number { return dirOfAng(this.ta); }
  set tdir(d: number) { this.ta = angOfDir(d); }
  state: BossState = 'hidden';
  revealed = false;
  lair: [number, number] = [0, 0];
  /** the town nearest the lair (for the radio) */
  lairNear = '';
  parts: BossPart[];
  /** frames of hit flash on the whole body */
  hitT = 0;
  /** distance driven (tread animation) */
  dist = 0;
  moving = false;
  /** main gun: frames until loaded; glow >= 0 while the barrel glows before the shot */
  reload = 90;
  glow = -1;
  recoil = 0;
  /** machine guns per sponson (left, right): shots left in the burst, frames to the next, burst angle (8 directions) */
  mg = [{ n: 0, t: 0, d: 0 }, { n: 0, t: 0, d: 0 }];
  /** player being hunted, and the frame it was last seen */
  target: Tank | null = null;
  lastSeen = -INF;
  lastAt: [number, number] | null = null;
  deathT = 0;
  deadT = 0;
  /** where the turret landed when it was blown off (px from its seat) */
  turretOff: [number, number] = [0, 0];
  killer = -1;
  /** owner of the boss's shells (never in w.enemies) */
  readonly proxy: Tank;
  /** per tank (the final fight's FROSTBITE is this class with heavier numbers): the heavy shell's damage, a factor on its reloads */
  gunDmg = BOSS.gunDmg;
  reloadMul = 1;
  /** w.frame until which its smoke screen is up (drones lose it) */
  smokeUntil = -INF;
  stats = {
    shellHits: 0, noPen: 0, droneHits: 0, rocketHits: 0, partsLost: 0, gunShots: 0, mgShots: 0, crushed: 0, columns: 0, smokes: 0, dronesLost: 0,
    escorts: 0, deaths: 0, steps: 0, paths: 0, pathMs: 0, ms: 0, msMax: 0, msSum: 0, n: 0,
  };
  log: string[] = [];

  /** in the lair: the angle of its slow look round */
  private sweepA = NaN;
  private turnT = 0;
  private nextDir = DOWN;
  private stepLeft = 0;
  private blockedT = 0;
  private lastTell = -INF;
  private lastPop = -INF;
  private hinted = false;
  private smokeTold = false;
  private judged = new WeakSet<object>();
  private brickSnd = 0;
  private sweepAt = 0;
  // path field: node (nx, ny) = boss top-left at (nx*8, ny*8)
  private nw = 0;
  private nh = 0;
  private cost = new Uint8Array(0);
  /** per node: the footprint has water in it (it wades) */
  private wet = new Uint8Array(0);
  private field = new Int32Array(0);
  private costVer = -1;
  private fieldAt = -INF;
  private fieldGoal = -1;

  constructor(private w: World) {
    this.parts = [
      { id: 'skL', name: 'LEFT SKIRT', short: 'SKIRT', kind: 'skirt', rect: [0, 7, 8, 34], side: -1, hp: 0, max: BOSS.hp.skirt, hitT: 0 },
      { id: 'spL', name: 'LEFT GUN', short: 'GUN', kind: 'sponson', rect: [9, 0, 9, 13], side: -1, hp: 0, max: BOSS.hp.sponson, hitT: 0 },
      { id: 'spR', name: 'RIGHT GUN', short: 'GUN', kind: 'sponson', rect: [30, 0, 9, 13], side: 1, hp: 0, max: BOSS.hp.sponson, hitT: 0 },
      { id: 'skR', name: 'RIGHT SKIRT', short: 'SKIRT', kind: 'skirt', rect: [40, 7, 8, 34], side: 1, hp: 0, max: BOSS.hp.skirt, hitT: 0 },
      { id: 'turret', name: 'TURRET', short: 'TURRET', kind: 'turret', rect: [13, 13, 22, 22], side: 0, hp: 0, max: BOSS.hp.turret, hitT: 0 },
    ];
    for (const p of this.parts) p.hp = p.max;
    const t = new Tank();
    t.player = -1;
    t.etype = 3;
    this.proxy = t;
    this.pickLair();
  }

  /** The boss for a region World by RegionSpec.boss, or null (regions without towns have none). Bosses not built yet
   * fall back to the heavy tank ace. */
  static forRegion(w: World): RegionBoss | null {
    if (!w.region || !w.towns.length) return null;
    switch (w.region.boss ?? 'grinder') {
      case 'heli': return new HeliBoss(w);
      case 'final': return new FinalBoss(w);
      case 'train': return new TrainBoss(w);
      case 'flagship': return new FlagshipBoss(w);
      default: return new Boss(w);
    }
  }

  get cx(): number { return this.x + S / 2; }
  get cy(): number { return this.y + S / 2; }
  get turret(): BossPart { return this.parts[4]; }
  /** On the map (revealed, alive or a wreck). */
  get present(): boolean { return this.state !== 'hidden'; }
  get alive(): boolean { return this.state === 'lair' || this.state === 'hunt'; }
  /** The turret takes shell hits: a skirt is gone (the side is open). */
  exposed(): boolean { return this.parts.some((p) => p.kind === 'skirt' && p.hp <= 0); }
  /** Region clear: destroyed, and the final blast has settled. */
  cleared(): boolean { return this.state === 'dead' && this.deadT > 90; }
  /** Towns still to free before the boss shows itself. */
  townsToReveal(): number {
    const need = Math.min(BOSS.reveal, this.w.towns.length);
    return Math.max(0, need - this.w.towns.filter((t) => t.freed).length);
  }
  /** Engaged or near a player: the HUD shows the boss bar. */
  hudShown(): boolean {
    if (!this.present) return false;
    if (this.state === 'dead') return this.deadT < 60 * 4;
    if (this.state === 'dying' || this.state === 'hunt') return true;
    return this.w.livePlayers().some((p) => Math.hypot(p.cx - this.cx, p.cy - this.cy) < 300);
  }

  // ---------- geometry ----------
  /** A part's world rect (x, y, w, h). */
  partRect(p: BossPart): [number, number, number, number] {
    const [lx, ly, pw, ph] = p.rect;
    const [ax, ay] = rotPt(lx, ly, this.dir);
    const [bx, by] = rotPt(lx + pw, ly + ph, this.dir);
    return [this.x + Math.min(ax, bx), this.y + Math.min(ay, by), Math.abs(bx - ax), Math.abs(by - ay)];
  }

  /** World px to the hull's up-facing frame. */
  toLocal(wx: number, wy: number): [number, number] {
    const qx = Math.max(0, Math.min(S - 0.01, wx - this.x));
    const qy = Math.max(0, Math.min(S - 0.01, wy - this.y));
    switch (this.dir & 3) {
      case 1: return [qy, S - qx];
      case 2: return [S - qx, S - qy];
      case 3: return [S - qy, qx];
      default: return [qx, qy];
    }
  }

  /** The hull's up-facing frame to world px. */
  toWorld(lx: number, ly: number): [number, number] {
    const [x, y] = rotPt(lx, ly, this.dir);
    return [this.x + x, this.y + y];
  }

  overlaps(x: number, y: number, w: number, h: number): boolean {
    return this.present && overlap(x, y, w, h, this.x, this.y, S, S);
  }

  /** World.blockedAt hook: a tank may not move into the boss (moving out of an overlap is allowed). */
  blocks(t: Tank, x: number, y: number): boolean {
    if (!this.present) return false;
    return overlap(x, y, 16, 16, this.x, this.y, S, S) && !overlap(t.x, t.y, 16, 16, this.x, this.y, S, S);
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
    if (this.recoil > 0) this.recoil--;
    for (const p of this.parts) if (p.hitT > 0) p.hitT--;
    this.proxy.x = this.cx - 8;
    this.proxy.y = this.cy - 8;
    this.moving = false;
    if (this.state === 'dying') this.updateDying();
    else if (this.state === 'dead') this.updateWreck();
    else {
      this.smoke();
      this.screen();
      this.perceive();
      if (w.freeze === 0 && !w.over) {
        this.aimTurret();
        this.gun();
        this.guns();
        this.drive();
      }
    }
    const ms = performance.now() - t0;
    const s = this.stats;
    s.ms = ms;
    s.msMax = Math.max(s.msMax, ms);
    s.msSum += ms;
    s.n++;
  }

  // ---------- reveal ----------
  private pickLair(): void {
    const w = this.w;
    this.buildCost();
    const sp = w.region!.playerSpawns[0];
    // reachable from the player's start (the boss must be able to come for you)
    this.computeField(this.nodeNear(sp[0] + 8 - S / 2, sp[1] + 8 - S / 2));
    let best = -1;
    let bs = -INF;
    for (let ny = 2; ny < this.nh - 2; ny++) {
      for (let nx = 2; nx < this.nw - 2; nx++) {
        const n = ny * this.nw + nx;
        if (!this.cost[n] || this.wet[n] || this.field[n] >= INF) continue;
        const x = nx * 8;
        const y = ny * 8;
        if (w.towns.some((t) => overlap(x - 40, y - 40, S + 80, S + 80, t.rect[0], t.rect[1], t.rect[2], t.rect[3]))) continue;
        if (w.depots.some((d) => Math.abs(d.cx - x - S / 2) < 90 && Math.abs(d.cy - y - S / 2) < 90)) continue;
        // far from the start, on or by a road, on open ground (little brick to crush)
        let s = Math.hypot(x - sp[0], y - sp[1]);
        if (this.cost[n] === 1) s += 160;
        if (this.cost[n] > 4) s -= 120;
        if (s > bs) { bs = s; best = n; }
      }
    }
    if (best < 0) best = this.nodeNear(w.pxW / 2 - S / 2, w.pxH / 2 - S / 2);
    this.lair = [(best % this.nw) * 8, Math.floor(best / this.nw) * 8];
    let bd = Infinity;
    for (const t of w.towns) {
      const d = Math.hypot(t.cx - this.lair[0] - S / 2, t.cy - this.lair[1] - S / 2);
      if (d < bd) { bd = d; this.lairNear = t.name; }
    }
  }

  /** Show the boss at its lair (a clear spot near it if a tank is parked there) with its escort; HQ radios it in. */
  reveal(): void {
    if (this.state !== 'hidden') return;
    const w = this.w;
    let [x, y] = this.lair;
    if (w.tankIn(x, y, S, S)) {
      const n0 = this.nodeNear(x, y);
      outer: for (let r = 1; r < 12; r++) {
        for (let j = -r; j <= r; j++) {
          for (const [dx, dy] of [[j, -r], [j, r], [-r, j], [r, j]]) {
            const nx = (n0 % this.nw) + dx;
            const ny = Math.floor(n0 / this.nw) + dy;
            if (nx < 0 || ny < 0 || nx >= this.nw || ny >= this.nh || !this.cost[ny * this.nw + nx]) continue;
            if (w.tankIn(nx * 8, ny * 8, S, S)) continue;
            x = nx * 8;
            y = ny * 8;
            break outer;
          }
        }
      }
    }
    this.x = x;
    this.y = y;
    const p = w.livePlayers()[0];
    this.dir = this.tdir = p ? domDir(p.cx - this.cx, p.cy - this.cy) : DOWN;
    this.revealed = true;
    this.state = 'lair';
    this.sweepAt = w.frame + 120;
    this.crush(true);
    const n = w.ai?.bossEscort(BOSS.escort, this.name, () => [this.cx, this.cy, this.dir]) ?? 0;
    this.stats.escorts += n;
    this.say('HQ', `SCOUTS FOUND THEIR ACE. CALLSIGN ${this.name}, A HEAVY TANK, DUG IN NEAR ${this.lairNear}. KILL IT AND THE REGION IS FREE.`);
    this.say(WHO, `${this.name}: SO THE FARMERS WANT A FIGHT. COME AND FIND ME.`);
    w.note('BOSS LOCATED', 'warn');
    w.snd('column', this.cx, 1);
    this.logEv(`revealed at ${x},${y} near ${this.lairNear}, escort ${n}`);
  }

  private wake(): void {
    if (this.state !== 'lair') return;
    this.state = 'hunt';
    this.say(WHO, `${this.name}: CONTACT. ROLLING OUT. STAY CLOSE, BOYS.`);
    this.w.snd('column', this.cx, 1);
    this.logEv('wakes');
  }

  // ---------- perception and the turret ----------
  private perceive(): void {
    const w = this.w;
    const range = this.state === 'lair' ? BOSS.wake : BOSS.sight;
    let best: Tank | null = null;
    let bd = Infinity;
    for (const p of w.livePlayers()) {
      const d = Math.hypot(p.cx - this.cx, p.cy - this.cy);
      if (d > range || d >= bd) continue;
      if (d > BOSS.treeSight && this.inTrees(p) && !(this.target === p && w.frame - this.lastSeen < 120)) continue;
      best = p;
      bd = d;
    }
    if (best) {
      this.target = best;
      this.lastSeen = w.frame;
      this.lastAt = [best.cx, best.cy];
      this.wake();
    } else if (this.target && (!this.target.alive || w.frame - this.lastSeen > 60 * 6)) {
      this.target = null;
    }
  }

  private inTrees(p: Tank): boolean {
    const m = this.w.map;
    const cx = Math.round(p.x / 4);
    const cy = Math.round(p.y / 4);
    let n = 0;
    for (let y = cy; y < cy + 4; y++) for (let x = cx; x < cx + 4; x++) if (m.at(x, y) === TREES) n++;
    return n >= 8;
  }

  private aimTurret(): void {
    const w = this.w;
    if (this.glow >= 0) return; // locked while the gun is about to fire
    let want = this.ta;
    const t = this.target;
    if (t) want = angOf(t.cx - this.cx, t.cy - this.cy);
    else if (this.state === 'hunt') want = angOfDir(this.dir);
    else {
      // in the lair: a slow look round
      if (w.frame >= this.sweepAt) {
        this.sweepAt = w.frame + 200 + Math.floor(rand() * 120);
        this.sweepA = this.ta + (rand() < 0.5 ? QUARTER : -QUARTER);
      }
      if (!Number.isNaN(this.sweepA)) want = this.sweepA;
    }
    // the old turn rate: a quarter turn in BOSS.turretTurn frames, smoothly
    this.ta = slewTo(this.ta, want, QUARTER / BOSS.turretTurn);
  }

  // ---------- main gun ----------
  private gun(): void {
    const w = this.w;
    if (this.reload > 0) this.reload--;
    if (this.glow >= 0) {
      this.glow++;
      if (this.glow % 15 === 1) w.snd('boss-charge', this.cx, 0.9);
      if (this.glow >= this.tell(BOSS.gunGlow)) {
        this.glow = -1;
        this.fireGun();
      }
      return;
    }
    const t = this.target;
    if (this.reload > 0 || !t || this.state !== 'hunt') return;
    const [ux, uy] = vecOf(this.ta);
    const [lat, along] = lineOff(this.cx, this.cy, ux, uy, t.cx, t.cy);
    if (lat > BOSS.gunSlack || along < 24 || along > BOSS.gunRange) return;
    // the barrel is on them: lock onto where they are now (the tell and the shell follow this exact line)
    const a = angOf(t.cx - this.cx, t.cy - this.cy);
    const [vx, vy] = vecOf(a);
    if (!clearOf(w.map, this.cx + vx * MUZZLE, this.cy + vy * MUZZLE, vx, vy, along - MUZZLE)) return;
    this.ta = a;
    this.glow = 0;
    if (w.frame - this.lastTell > BOSS.tellGap) {
      this.lastTell = w.frame;
      this.say(WHO, `${this.name}: LOADING HEAVY ROUND. HOLD STILL, LITTLE TRACTOR.`);
    }
  }

  private fireGun(): void {
    const w = this.w;
    const [dx, dy] = vecOf(this.ta);
    const mx = this.cx + dx * (MUZZLE + 1);
    const my = this.cy + dy * (MUZZLE + 1);
    const b = shellAt(mx, my, dx, dy, BOSS.gunSpeed, this.proxy, true);
    b.dmg = this.gunDmg;
    w.bullets.push(b);
    this.reload = this.gap(this.exposed() ? BOSS.gunReloadMad : BOSS.gunReload);
    this.recoil = 10;
    this.stats.gunShots++;
    w.flashes.push({ x: mx + dx * 3, y: my + dy * 3, t: 0, max: 12, r: 90, col: [1, 0.6, 0.3], z: 12, vx: dx, vy: dy });
    w.shake = Math.max(w.shake, 3);
    for (let i = 0; i < 7; i++) {
      w.parts.push({
        x: mx, y: my, z: 8, vx: dx * (0.4 + rand() * 0.8) + (rand() - 0.5) * 0.8, vy: dy * (0.4 + rand() * 0.8) + (rand() - 0.5) * 0.8, vz: 0.05,
        life: 0, max: 40 + Math.floor(rand() * 20), col: [0.5, 0.5, 0.52], kind: 2, r: 3 + rand() * 2,
      });
    }
    w.snd('boss-cannon', this.cx, 1);
    w.snd('explode', this.cx, 0.55);
  }

  // ---------- machine-gun sponsons ----------
  private guns(): void {
    const w = this.w;
    const t = this.target;
    for (let i = 0; i < 2; i++) {
      const sp = this.parts[i === 0 ? 1 : 2];
      const s = this.mg[i];
      if (sp.hp <= 0) {
        s.n = 0;
        continue;
      }
      if (s.t > 0) {
        s.t--;
        continue;
      }
      const [x, y, pw, ph] = this.partRect(sp);
      const sx = x + pw / 2;
      const sy = y + ph / 2;
      if (s.n > 0) {
        const [ux, uy] = vecOf(s.d);
        const b = shellAt(sx + ux * 7, sy + uy * 7, ux, uy, BOSS.mgSpeed, this.proxy, false);
        b.dmg = BOSS.mgDmg;
        b.mg = true;
        b.range = BOSS.mgRange + 12;
        w.bullets.push(b);
        w.flashes.push({ x: sx + ux * 8, y: sy + uy * 8, t: 0, max: 4, r: 22, col: [1, 0.8, 0.4], z: 9 });
        w.snd('eshoot', sx, 0.3);
        this.stats.mgShots++;
        s.n--;
        s.t = s.n ? BOSS.mgGap : this.gap(BOSS.mgPause);
        continue;
      }
      if (!t || this.state !== 'hunt') continue;
      // the sponson fires in the 8 directions over the front (both front diagonals) and its own side
      const a = snap8(t.cx - sx, t.cy - sy);
      const rel = ((Math.round((a - angOfDir(this.dir)) / EIGHTH) % 8) + 8) % 8; // 0 ahead, clockwise
      if (rel !== 0 && rel !== 1 && rel !== 7 && rel !== (sp.side < 0 ? 6 : 2)) continue;
      const [ux, uy] = vecOf(a);
      const [lat, along] = lineOff(sx, sy, ux, uy, t.cx, t.cy);
      if (lat > BOSS.mgSlack || along < 8 || along > BOSS.mgRange) continue;
      if (!clearOf(w.map, sx, sy, ux, uy, along)) continue;
      s.d = a;
      s.n = BOSS.mgBurst;
      s.t = 6; // a short wind-up
    }
  }

  // ---------- movement ----------
  private drive(): void {
    const w = this.w;
    if (this.state !== 'hunt') return;
    if (this.turnT > 0) {
      if (--this.turnT === 0) this.dir = this.nextDir;
      return;
    }
    if (this.stepLeft > 0) {
      this.advance();
      return;
    }
    if (this.glow >= 0) return; // it stops to fire: a readable tell
    const t = this.target;
    const at = t ? [t.cx, t.cy] : this.lastAt;
    if (!at) return;
    // a gun platform: holds when the target is close and in its gun line
    if (t) {
      const [ux, uy] = vecOf(this.ta);
      const [lat, along] = lineOff(this.cx, this.cy, ux, uy, t.cx, t.cy);
      if (along > 0 && along < BOSS.standOff && lat < BOSS.gunSlack) return;
    }
    const goal = this.nodeNear(at[0] - S / 2, at[1] - S / 2);
    if (w.frame - this.fieldAt >= BOSS.pathEvery || goal !== this.fieldGoal) {
      if (w.frame - this.fieldAt >= 20) this.computeField(goal);
    }
    const n = this.nodeNear(this.x, this.y);
    const nx = n % this.nw;
    const ny = Math.floor(n / this.nw);
    let best = -1;
    let bv = this.field[n];
    // keep going straight on ties: fewer slow pivots
    for (const d of [this.dir, (this.dir + 1) & 3, (this.dir + 3) & 3, (this.dir + 2) & 3]) {
      const mx = nx + DX[d];
      const my = ny + DY[d];
      if (mx < 0 || my < 0 || mx >= this.nw || my >= this.nh) continue;
      const v = this.field[my * this.nw + mx];
      if (v < bv) { bv = v; best = d; }
    }
    if (bv >= INF) {
      // no route (walled off by steel): edge straight toward the target over open nodes
      let bd = Math.hypot(at[0] - this.cx, at[1] - this.cy) - 4;
      for (let d = 0; d < 4; d++) {
        const mx = nx + DX[d];
        const my = ny + DY[d];
        if (mx < 0 || my < 0 || mx >= this.nw || my >= this.nh || !this.cost[my * this.nw + mx]) continue;
        const dd = Math.hypot(at[0] - (mx * 8 + S / 2), at[1] - (my * 8 + S / 2));
        if (dd < bd) { bd = dd; best = d; }
      }
    }
    if (best < 0) {
      if (!t) this.lastAt = null; // reached the last sighting
      return;
    }
    if (best !== this.dir) {
      this.nextDir = best;
      this.turnT = BOSS.turnPause;
      return;
    }
    this.stepLeft = 8;
    this.advance();
  }

  private advance(): void {
    const w = this.w;
    const step = Math.min(BOSS.speed, this.stepLeft);
    const nx = this.x + DX[this.dir] * step;
    const ny = this.y + DY[this.dir] * step;
    if (this.blockedBy(nx, ny, this.blockedT > 90)) {
      if (++this.blockedT > 300) {
        // give up the step: back to the node and think again
        this.x = Math.round(this.x / 8) * 8;
        this.y = Math.round(this.y / 8) * 8;
        this.stepLeft = 0;
        this.blockedT = 0;
        this.fieldAt = -INF;
      }
      return;
    }
    this.blockedT = 0;
    this.x = nx;
    this.y = ny;
    this.stepLeft -= step;
    if (this.stepLeft < EPS) {
      this.stepLeft = 0;
      this.x = Math.round(this.x / 8) * 8;
      this.y = Math.round(this.y / 8) * 8;
      this.stats.steps++;
    }
    this.moving = true;
    const before = Math.floor(this.dist / 3);
    this.dist += step;
    if (Math.floor(this.dist / 3) !== before) this.tracks();
    this.crush(false);
  }

  /** A tank or a standing depot in the way. Enemy tanks only block for a while (`push`: it shoves through them). */
  private blockedBy(x: number, y: number, push: boolean): boolean {
    const w = this.w;
    if (x < 0 || y < 0 || x > w.pxW - S || y > w.pxH - S) return true;
    for (const t of w.allTanks()) {
      if (!t.alive || t.spawn > 0) continue;
      if (push && !t.isPlayer) continue;
      if (overlap(x, y, S, S, t.x, t.y, 16, 16) && !overlap(this.x, this.y, S, S, t.x, t.y, 16, 16)) return true;
    }
    for (const d of w.depots) if (!d.destroyed && overlap(x, y, S, S, d.cx - 8, d.cy - 8, 16, 16)) return true;
    return false;
  }

  /** Flatten brick under the hull (debris, a crunch now and then). */
  private crush(silent: boolean): void {
    const w = this.w;
    const m = w.map;
    const x0 = Math.floor(this.x / 4);
    const y0 = Math.floor(this.y / 4);
    const x1 = Math.ceil((this.x + S) / 4);
    const y1 = Math.ceil((this.y + S) / 4);
    let n = 0;
    for (let cy = y0; cy < y1; cy++) {
      for (let cx = x0; cx < x1; cx++) {
        if (m.at(cx, cy) !== BRICK) continue;
        m.set(cx, cy, EMPTY);
        n++;
        if (!silent && rand() < 0.5) w.debris(cx * 4 + 2, cy * 4 + 2, this.dir);
      }
    }
    if (!n) return;
    this.stats.crushed += n;
    if (!silent && w.frame - this.brickSnd > 10) {
      this.brickSnd = w.frame;
      w.snd('brick', this.cx, 0.9);
      w.shake = Math.max(w.shake, 1.2);
    }
  }

  private tracks(): void {
    const w = this.w;
    const d = this.dir;
    const px = DY[d] !== 0 ? 1 : 0;
    const py = 1 - px;
    for (const s of [-19, -16, 16, 19]) {
      const x = this.cx + px * s - 1 - DX[d] * 20;
      const y = this.cy + py * s - 1 - DY[d] * 20;
      w.decals.push({ k: 0, x, y, w: 2, h: 2, col: [0.04, 0.04, 0.045], a: 0.2 });
    }
  }

  // ---------- path field (Dial's algorithm on the 8 px node grid, footprint 48 x 48) ----------
  private buildCost(): void {
    const m = this.w.map;
    if (m.version === this.costVer && this.cost.length) return;
    this.costVer = m.version;
    const W = m.w;
    const H = m.h;
    const W1 = W + 1;
    const hard = new Int32Array(W1 * (H + 1));
    const brick = new Int32Array(W1 * (H + 1));
    const road = new Int32Array(W1 * (H + 1));
    const water = new Int32Array(W1 * (H + 1));
    for (let y = 0; y < H; y++) {
      let rh = 0;
      let rb = 0;
      let rr = 0;
      let rw = 0;
      for (let x = 0; x < W; x++) {
        const c = m.c[y * W + x];
        if (c === STEEL) rh++;
        else if (c === WATER) rw++;
        else if (c === BRICK) rb++;
        else if (c === ROAD) rr++;
        const i = (y + 1) * W1 + x + 1;
        hard[i] = hard[i - W1] + rh;
        brick[i] = brick[i - W1] + rb;
        road[i] = road[i - W1] + rr;
        water[i] = water[i - W1] + rw;
      }
    }
    const sum = (a: Int32Array, x: number, y: number, w: number, h: number) =>
      a[(y + h) * W1 + x + w] - a[y * W1 + x + w] - a[(y + h) * W1 + x] + a[y * W1 + x];
    this.nw = Math.floor((this.w.pxW - S) / 8) + 1;
    this.nh = Math.floor((this.w.pxH - S) / 8) + 1;
    const n = this.nw * this.nh;
    if (this.cost.length !== n) {
      this.cost = new Uint8Array(n);
      this.wet = new Uint8Array(n);
      this.field = new Int32Array(n);
    }
    for (let ny = 0; ny < this.nh; ny++) {
      for (let nx = 0; nx < this.nw; nx++) {
        const cx = nx * 2;
        const cy = ny * 2;
        let c = 0;
        let wet = 0;
        if (cx + 12 <= W && cy + 12 <= H && sum(hard, cx, cy, 12, 12) === 0) {
          c = sum(road, cx + 3, cy + 3, 6, 6) >= 14 ? 1 : 3;
          if (sum(brick, cx, cy, 12, 12) > 0) c += 4;
          // it wades rivers (slowly, and only where it must: bridges are too narrow for it)
          if (sum(water, cx, cy, 12, 12) > 0) { c += 6; wet = 1; }
        }
        this.cost[ny * this.nw + nx] = c;
        this.wet[ny * this.nw + nx] = wet;
      }
    }
  }

  private computeField(goal: number): void {
    const t0 = performance.now();
    this.buildCost();
    const d = this.field;
    d.fill(INF);
    const nw = this.nw;
    const nh = this.nh;
    const buckets: number[][] = Array.from({ length: 16 }, () => []);
    let pending = 0;
    // seeds: open nodes round the goal (the goal itself may be in water or a wall)
    const gx = goal % nw;
    const gy = Math.floor(goal / nw);
    for (let r = 1; r <= 8 && !pending; r++) {
      for (let y = gy - r; y <= gy + r; y++) {
        for (let x = gx - r; x <= gx + r; x++) {
          if (x < 0 || y < 0 || x >= nw || y >= nh) continue;
          const n = y * nw + x;
          if (!this.cost[n] || d[n] === 0) continue;
          d[n] = 0;
          buckets[0].push(n);
          pending++;
        }
      }
    }
    let cur = 0;
    while (pending > 0) {
      const bk = buckets[cur & 15];
      while (bk.length) {
        const n = bk.pop()!;
        pending--;
        if (d[n] !== cur) continue;
        const x = n % nw;
        const y = (n - x) / nw;
        for (let k = 0; k < 4; k++) {
          const mx = x + DX[k];
          const my = y + DY[k];
          if (mx < 0 || my < 0 || mx >= nw || my >= nh) continue;
          const m = my * nw + mx;
          const c = this.cost[m];
          if (!c) continue;
          const v = cur + c;
          if (v < d[m]) {
            d[m] = v;
            buckets[v & 15].push(m);
            pending++;
          }
        }
      }
      cur++;
    }
    this.fieldAt = this.w.frame;
    this.fieldGoal = goal;
    this.stats.paths++;
    this.stats.pathMs += performance.now() - t0;
  }

  private nodeNear(x: number, y: number): number {
    const nx = Math.max(0, Math.min(this.nw - 1, Math.round(x / 8)));
    const ny = Math.max(0, Math.min(this.nh - 1, Math.round(y / 8)));
    return ny * this.nw + nx;
  }

  // ---------- damage ----------
  /** World.bulletStep hook: a shell meets the boss. Player shells hit a part; enemy shells pass (as through tanks). */
  bulletHit(b: Bullet): boolean {
    if (!this.present || b.owner === this.proxy || !b.owner.isPlayer) return false;
    if (!overlap(b.x - 2, b.y - 2, 4, 4, this.x, this.y, S, S)) return false;
    b.alive = false;
    const w = this.w;
    if (!this.alive) {
      w.impact(b, false, true); // the wreck (or a boss already going up)
      return true;
    }
    const owner = b.owner;
    const dmg = 1 + (owner.firepower >= 1 ? 1 : 0);
    this.stats.shellHits++;
    this.hitAt(b.x + DX[b.dir] * 2, b.y + DY[b.dir] * 2, b.dir, dmg, owner.player, 'shell');
    return true;
  }

  /** Abilities hook: an FPV drone hits (x, y) from above. True if the boss was under it. Then it pops smoke. */
  droneHit(x: number, y: number, dmg: number, pi: number): boolean {
    if (!this.alive || !overlap(x - 3, y - 3, 6, 6, this.x, this.y, S, S)) return false;
    this.stats.droneHits++;
    this.hitAt(x, y, -1, dmg * BOSS.droneMul, pi, 'drone');
    if (this.alive) this.popSmoke();
    return true;
  }

  /** A drone launched now would find it (no smoke screen up). */
  droneOpen(): boolean {
    return this.w.frame >= this.smokeUntil;
  }

  // ---------- eased timing (World.ease: the region's base ease plus retreats) ----------
  private get ease(): number {
    const e = this.w.ease;
    return Number.isFinite(e) ? Math.max(0, Math.min(0.5, e)) : 0;
  }
  private tell(n: number): number { return Math.round(n * (1 + this.ease)); }
  private gap(n: number): number { return Math.round(n * this.reloadMul * (1 + 2 * heat(this.w.ease))); }

  // ---------- smoke dischargers (its counter to FPV drones) ----------
  /** The dischargers fire: a ring of smoke round the hull that hides it from drones for BOSS.smokeHold frames. */
  private popSmoke(): void {
    const w = this.w;
    this.smokeUntil = w.frame + Math.round(BOSS.smokeHold * (1 - this.ease));
    this.stats.smokes++;
    for (let i = 0; i < 28; i++) {
      const a = (i / 28) * Math.PI * 2;
      const sp = i % 2 ? 0.5 : 1.1;
      w.parts.push({
        x: this.cx + Math.cos(a) * 14, y: this.cy + Math.sin(a) * 14, z: 8, vx: Math.cos(a) * (sp + rand() * 0.4), vy: Math.sin(a) * (sp + rand() * 0.4), vz: 0.04,
        life: 0, max: 130 + Math.floor(rand() * 60), col: [0.86, 0.86, 0.83], kind: 2, r: 7 + rand() * 4,
      });
    }
    w.flashes.push({ x: this.cx, y: this.cy, t: 0, max: 8, r: 60, col: [1, 0.9, 0.7], z: 14 });
    w.snd('trick-rocket', this.cx, 0.5);
    w.snd('thud', this.cx, 0.7);
    w.popups.push({ x: this.cx, y: this.cy - 30, text: 'SMOKE', t: 0, col: [0.85, 0.87, 0.9] });
    if (!this.smokeTold) {
      this.smokeTold = true;
      w.note(`${this.name} POPS SMOKE: DRONES LOSE IT FOR A WHILE`, 'warn');
    }
    this.logEv('smoke dischargers');
  }

  /** While the screen is up: the cloud keeps billowing, and a drone flying in loses the hull in it. */
  private screen(): void {
    const w = this.w;
    if (w.frame >= this.smokeUntil) return;
    if (w.frame % 3 === 0) {
      const a = rand() * Math.PI * 2;
      const d = 8 + rand() * 30;
      w.parts.push({
        x: this.cx + Math.cos(a) * d, y: this.cy + Math.sin(a) * d, z: 8 + rand() * 6, vx: Math.cos(a) * 0.15, vy: Math.sin(a) * 0.15 - 0.05, vz: 0.02,
        life: 0, max: 90 + Math.floor(rand() * 40), col: [0.84, 0.84, 0.81], kind: 2, r: 7 + rand() * 4,
      });
    }
    const ab = w.abil;
    if (!ab?.fpvs.length) return;
    for (const f of ab.fpvs) {
      if (this.judged.has(f)) continue;
      const left = ab.bossBound(f);
      if (left < 0 || left > BOSS.smokeAt || !overlap(f.tx - 3, f.ty - 3, 6, 6, this.x, this.y, S, S)) continue;
      this.judged.add(f);
      // it loses the hull and comes down beside it
      const a = Math.atan2(f.y - this.cy, f.x - this.cx) + (rand() < 0.5 ? 1 : -1) * (0.9 + rand() * 0.5);
      ab.divert(f, this.cx + Math.cos(a) * 40, this.cy + Math.sin(a) * 40, 'LOST IN SMOKE');
      this.stats.dronesLost++;
      this.say('WASP', 'I LOST HIM IN HIS OWN SMOKE. GIVE IT A FEW SECONDS TO CLEAR, THEN I SEND THE NEXT ONE.');
      this.logEv('a drone lost it in the smoke');
    }
  }

  /** Abilities hook: an ambush rocket (flying `dir`) at (x, y). True if it hit the boss. */
  rocketHit(x: number, y: number, dir: number, dmg: number, pi: number): boolean {
    if (!this.present || x < this.x || x >= this.x + S || y < this.y || y >= this.y + S) return false;
    if (this.alive) {
      this.stats.rocketHits++;
      this.hitAt(x, y, dir, dmg, pi, 'shell');
    }
    return true;
  }

  /** Where a strike from the drone should aim: the weakest live part's centre (tap launch). */
  aimPoint(): [number, number] {
    let best = this.turret;
    for (const p of this.parts) if (p.kind !== 'turret' && p.hp > 0 && (best.kind === 'turret' || p.hp < best.hp)) best = p;
    if (this.exposed() || best.kind === 'turret') best = this.turret;
    const [x, y, pw, ph] = this.partRect(best);
    return [x + pw / 2, y + ph / 2];
  }

  /** The part a hit at local (lx, ly) lands on. `margin` widens the weak points' boxes (generous, "easy"). */
  private partAt(lx: number, ly: number, margin: number): BossPart | null {
    for (const p of this.parts) {
      if (p.kind === 'turret' || p.hp <= 0) continue;
      const [x, y, pw, ph] = p.rect;
      if (lx >= x - margin && lx < x + pw + margin && ly >= y - margin && ly < y + ph + margin) return p;
    }
    return null;
  }

  private hitAt(wx: number, wy: number, dir: number, dmg: number, pi: number, kind: 'shell' | 'drone'): void {
    const w = this.w;
    const [lx, ly] = this.toLocal(wx, wy);
    let part = this.partAt(lx, ly, kind === 'drone' ? 4 : 2);
    if (!part) {
      // the turret: from above (drones), through an open side, or a shell into the engine deck from behind
      const rear = kind === 'shell' && dir === this.dir && ly >= 30;
      if (kind === 'drone' || this.exposed() || rear) part = this.turret;
    }
    this.wake();
    if (!part) {
      this.noPen(wx, wy);
      return;
    }
    part.hp = Math.max(0, part.hp - dmg);
    part.hitT = 10;
    this.hitT = 3;
    w.sparks(wx, wy, 6 + dmg * 2, [1, 0.8, 0.45]);
    w.flashes.push({ x: wx, y: wy, t: 0, max: 10, r: 40 + dmg * 6, col: [1, 0.6, 0.3], z: 12 });
    w.booms.push({ x: wx, y: wy, big: false, t: 0 });
    w.shake = Math.max(w.shake, 1 + dmg * 0.3);
    w.snd('armor', wx, 1);
    w.popups.push({ x: wx, y: wy - 8, text: `-${dmg}`, t: 0, col: [1, 0.6, 0.3] });
    this.logEv(`${kind} hit ${part.id} -${dmg} (${part.hp}/${part.max})`);
    if (part.hp <= 0) this.partLost(part, pi);
  }

  private noPen(wx: number, wy: number): void {
    const w = this.w;
    this.stats.noPen++;
    w.sparks(wx, wy, 7, [1, 0.95, 0.8]);
    w.flashes.push({ x: wx, y: wy, t: 0, max: 6, r: 26, col: [1, 0.9, 0.7], z: 10 });
    w.snd('steel', wx, 1);
    if (w.frame - this.lastPop > 90) {
      this.lastPop = w.frame;
      w.popups.push({ x: wx, y: wy - 8, text: 'NO PEN', t: 0, col: [0.75, 0.8, 0.88] });
    }
    if (!this.hinted) {
      this.hinted = true;
      w.note(this.exposed() ? 'HIT HIS OPEN SIDE' : 'HIT THE GUNS AND SKIRTS', 'info');
    }
  }

  private partLost(p: BossPart, pi: number): void {
    const w = this.w;
    const [x, y, pw, ph] = this.partRect(p);
    const cx = x + pw / 2;
    const cy = y + ph / 2;
    this.stats.partsLost++;
    if (p.kind === 'turret') {
      this.die(pi);
      return;
    }
    w.explode(cx, cy, p.kind === 'skirt');
    w.shocks.push({ x: cx, y: cy, t: 0, max: 26, size: 0.9 });
    w.shake = Math.max(w.shake, 4);
    w.snd('boss-part', cx, 0.8);
    for (let i = 0; i < 10; i++) {
      const a = rand() * Math.PI * 2;
      const s = 0.5 + rand() * 1.4;
      w.parts.push({
        x: cx, y: cy, z: 7, vx: Math.cos(a) * s, vy: Math.sin(a) * s, vz: 1 + rand() * 1.5,
        life: 0, max: 160, col: [0.36, 0.38, 0.32], kind: 0, r: 1,
      });
    }
    w.scrap += BOSS.partScrap;
    w.popups.push({ x: cx, y: cy - 14, text: `+${BOSS.partScrap} SCRAP`, t: 0, col: [1, 0.85, 0.4] });
    w.note(`${p.name} DESTROYED`, 'power');
    if (pi >= 0) w.addVetXp(pi, 0.25);
    this.hinted = false;
    if (p.kind === 'sponson') {
      this.say(WHO, `${this.name}: LOST A GUN. ALL UNITS, SEND ME A COLUMN. NOW.`);
      const at = this.target ?? w.livePlayers()[0];
      if (w.ai?.bossColumn(at ? at.x : this.cx - 8, at ? at.y : this.cy - 8)) this.stats.columns++;
    } else {
      this.say(WHO, `${this.name}: SKIRT IS GONE. NO MATTER. I AM STILL BIGGER THAN YOU.`);
      this.say('SPANNER', 'HIS SIDE IS OPEN. PUT ONE INTO THE TURRET RING AND WE ALL GO HOME.');
    }
    this.logEv(`${p.id} destroyed`);
  }

  /** Debug and sim: destroy the boss now (revealing it first if needed). */
  kill(pi = -1): void {
    if (this.state === 'hidden') this.reveal();
    if (!this.alive) return;
    this.turret.hp = 0;
    this.die(pi);
  }

  private die(pi: number): void {
    const w = this.w;
    if (!this.alive) return;
    this.state = 'dying';
    this.deathT = 0;
    this.glow = -1;
    this.killer = pi;
    this.stats.deaths++;
    this.say(WHO, `${this.name}: FIRE IN THE TURRET! GET OUT, GET OUT!`);
    w.note(`${this.name} IS BURNING`, 'power');
    w.shake = Math.max(w.shake, 5);
    this.logEv('dying');
  }

  // ---------- death sequence and the wreck ----------
  private updateDying(): void {
    const w = this.w;
    const t = ++this.deathT;
    this.hitT = (t >> 2) & 1 ? 3 : 0;
    const rx = () => this.x + 6 + rand() * (S - 12);
    const ry = () => this.y + 6 + rand() * (S - 12);
    if (t < BOSS.dieFrames && t % 8 === 0) {
      const x = rx();
      const y = ry();
      w.explode(x, y, false);
      w.sparks(x, y, 8, [1, 0.75, 0.35]);
      w.snd('explode', x, 0.7);
      w.shake = Math.max(w.shake, 2.5);
    }
    if (t === 35 || t === 70 || t === 100) {
      w.explode(rx(), ry(), true);
      w.snd('bigexplode', this.cx, 0.8);
    }
    if (t % 3 === 0) this.smokePuff(rx(), ry(), true);
    if (t >= BOSS.dieFrames) this.finale();
  }

  private finale(): void {
    const w = this.w;
    const x = this.cx;
    const y = this.cy;
    this.state = 'dead';
    this.deadT = 0;
    w.explode(x, y, true);
    w.explode(x - 12, y + 8, true);
    w.explode(x + 10, y - 9, true);
    w.flashes.push({ x, y, t: 0, max: 100, r: 240, col: [1, 0.55, 0.2], z: 30 });
    w.shocks.push({ x, y, t: 0, max: 60, size: 3.2 });
    w.shocks.push({ x, y, t: 0, max: 36, size: 1.6 });
    w.shake = 10;
    w.snd('bigexplode', x, 1);
    w.snd('explode', x, 1);
    const a = rand() * Math.PI * 2;
    this.turretOff = [Math.round(Math.cos(a) * 5), Math.round(Math.sin(a) * 5)];
    for (let i = 0; i < 30; i++) {
      const b = rand() * Math.PI * 2;
      const s = 0.6 + rand() * 2.2;
      w.parts.push({
        x, y, z: 10, vx: Math.cos(b) * s, vy: Math.sin(b) * s, vz: 1.5 + rand() * 2.5,
        life: 0, max: 220, col: rand() < 0.5 ? [0.36, 0.38, 0.32] : [0.2, 0.2, 0.2], kind: 0, r: 1,
      });
    }
    for (let i = 0; i < 12; i++) this.smokePuff(x + (rand() - 0.5) * 30, y + (rand() - 0.5) * 30, true);
    w.decals.push({ k: 1, x, y, r: 30, col: [0.02, 0.02, 0.02], a: 0.6 });
    // rewards: scrap, two parts stripped off the hull, radio
    w.stats.boss++;
    w.stats.bossScrap += BOSS.scrap;
    w.scrap += BOSS.scrap;
    w.popups.push({ x, y: y - 30, text: `+${BOSS.scrap} SCRAP`, t: 0, col: [1, 0.85, 0.4] });
    for (let i = 0; i < BOSS.captured; i++) {
      const id = w.rollFound(true);
      w.partsFound++;
      w.popups.push({ x, y: y - 20 + i * 8, text: id ? '+CAPTURED PART' : '+1 PART', t: 0, col: [0.6, 0.9, 1] });
    }
    w.snd('part', x, 0.9);
    w.note(`${this.name} DESTROYED`, 'power');
    if (this.killer >= 0) w.addVetXp(this.killer, 1);
    this.say('HQ', `${this.name} IS SCRAP. THE WHOLE VALLEY HEARD IT. THIS REGION IS OURS.`);
    this.say('SPANNER', 'I GOT TWO GOOD PARTS OFF HIS HULL. AND HIS KETTLE. MINE NOW.');
    this.logEv('destroyed');
  }

  private updateWreck(): void {
    const t = ++this.deadT;
    const every = t < 60 * 30 ? 4 : 14;
    if (this.w.frame % every === 0) this.smokePuff(this.cx + (rand() - 0.5) * 20, this.cy + (rand() - 0.5) * 16, t < 60 * 30);
  }

  /** Black smoke from destroyed parts while it fights. */
  private smoke(): void {
    const w = this.w;
    if (w.frame % 7 !== 0) return;
    for (const p of this.parts) {
      if (p.hp > 0 && p.hp > p.max / 2) continue;
      if (p.hp > 0 && w.frame % 21 !== 0) continue;
      const [x, y, pw, ph] = this.partRect(p);
      this.smokePuff(x + pw / 2, y + ph / 2, p.hp <= 0);
    }
  }

  private smokePuff(x: number, y: number, heavy: boolean): void {
    this.w.parts.push({
      x: x + (rand() - 0.5) * 4, y: y + (rand() - 0.5) * 4, z: 10,
      vx: (rand() - 0.5) * 0.2, vy: -0.2 - rand() * 0.2, vz: 0,
      life: 0, max: heavy ? 110 : 70, col: heavy ? [0.09, 0.085, 0.08] : [0.2, 0.19, 0.18], kind: 2, r: (heavy ? 4.5 : 3) + rand() * 3,
    });
  }

  // ---------- radio ----------
  private say(who: string, text: string): void {
    const r = this.w.radio;
    if (r.length && r[r.length - 1].text === text) return;
    r.push({ who, text });
    if (r.length > 20) r.shift();
    this.logEv(`RADIO ${who} ${text}`);
  }

  private logEv(s: string): void {
    this.log.push(`${String(this.w.frame).padStart(6)} ${s}`);
    if (this.log.length > 500) this.log.splice(0, 100);
  }

  // ---------- drawing (draw.ts hook; screen = world + ox/oy) ----------
  draw(r: Renderer, ox: number, oy: number, time: number, head: number): void {
    if (!this.present) return;
    const x = Math.round(ox + this.x);
    const y = Math.round(oy + this.y);
    if (x < -80 || y < -80 || x > r.nw + 80 || y > r.nh + 80) return;
    const A = r.atlas.S;
    const d = this.dir;
    const dead = this.state === 'dead';
    const dying = this.state === 'dying';
    const white: RGB = [1, 1, 1];
    const tint: RGB = dead ? [0.85, 0.8, 0.76] : white;
    const flash = this.hitT > 0 ? (dying ? 0.2 : 0.3) : 0;
    const hull = dead ? A.bossWreck : A[`bossHull${Math.floor(this.dist / 2) % 2 ? 'b' : 'a'}`];
    r.spr(hull, x, y, d, tint, MAT_STD, 0, 1, flash);
    // weak points (rotated with the hull)
    for (const p of this.parts) {
      if (p.kind === 'turret') continue;
      const [px, py] = this.partRect(p);
      const sx = Math.round(ox + px);
      const sy = Math.round(oy + py);
      const pf = p.hitT > 6 ? 0.65 : flash;
      if (p.kind === 'skirt') {
        if (p.hp > 0) r.spr(A[p.side < 0 ? 'bossSkirtL' : 'bossSkirtR'], sx, sy, d, tint, MAT_STD, 0, 1, pf);
        else {
          // torn off: a few charred stubs on the tread edge
          const [bx, by] = rotPt(p.side < 0 ? 1 : 45, 20, d);
          r.glow(x + bx, y + by, 2, [1, 0.45, 0.15], 0.5 + 0.3 * Math.sin(time * 13 + p.side));
        }
      } else {
        r.spr(A[p.hp > 0 ? 'bossSponson' : 'bossSponsonDead'], sx, sy, d, tint, MAT_STD, 0, 1, pf);
        if (p.hp <= 0 && !dead) {
          const [cx, cy] = rotPt(p.rect[0] + 4.5, p.rect[1] + 7, d);
          const fl = 0.6 + 0.4 * Math.sin(time * 17 + p.side * 3);
          r.glow(x + cx, y + cy, 2.5, [1, 0.5, 0.15], 0.9 * fl);
          r.light(x + cx, y + cy, 10, 26, 0.5 * fl, 0.22 * fl, 0.05 * fl, false);
        }
      }
    }
    // turret (its own direction; recoils after the main gun; thrown off when it dies)
    const rc = this.recoil > 4 ? 2 : this.recoil > 0 ? 1 : 0;
    // the turret sprite is 64 px, centred on the hull's centre
    // (drawn at its real angle: the main gun fires along it)
    const [tux, tuy] = vecOf(this.ta);
    const tx = Math.round(x + 24 - tux * rc + (dead ? this.turretOff[0] : 0));
    const ty = Math.round(y + 24 - tuy * rc + (dead ? this.turretOff[1] : 0));
    const tf = this.turret.hitT > 6 ? 0.65 : flash;
    r.sprRot(dead ? A.bossTurretDead : A.bossTurret, tx, ty, this.ta, tint, MAT_STD, 0, 1, tf);
    if (dead) {
      const fl = 0.6 + 0.4 * Math.sin(time * 11) * Math.sin(time * 4.3);
      const k = this.deadT < 60 * 30 ? 1 : 0.35;
      r.light(x + 24, y + 22, 16, 70 * k + 20, 1.0 * k * fl, 0.42 * k * fl, 0.1 * k * fl, true);
      r.glow(x + 22, y + 26, 3 * k + 1, [1, 0.5, 0.15], 0.8 * fl);
      r.glow(x + 29, y + 20, 2 * k + 1, [1, 0.65, 0.25], 0.6 * fl);
      return;
    }
    if (dying) {
      const fl = 0.5 + 0.5 * Math.sin(time * 23);
      r.light(x + 24, y + 24, 18, 90, 1.2 * fl, 0.5 * fl, 0.12 * fl, true);
      r.glow(x + 24, y + 24, 6 + 4 * fl, [1, 0.5, 0.15], 1.2);
      return;
    }
    // red running lights: two forward spots and the glow of the hull's lamps
    const k = Math.max(0.35, head);
    const fx = this.cx + DX[d] * 22;
    const fy = this.cy + DY[d] * 22;
    r.spot(ox + fx, oy + fy, 8, 130, 1.0 * k, 0.3 * k, 0.2 * k, true, DX[d], DY[d], 0.7, 0.93);
    // the main-gun tell: the barrel glows hotter for a second, beeping, before the shell
    if (this.glow >= 0) {
      const g = this.glow / this.tell(BOSS.gunGlow);
      const mx = ox + this.cx + tux * (MUZZLE - 2);
      const my = oy + this.cy + tuy * (MUZZLE - 2);
      const pulse = 0.75 + 0.25 * Math.sin(time * 30);
      r.glow(mx, my, 3 + g * 6, [1, 0.35, 0.12], (1.2 + g * 3.5) * pulse);
      for (let i = 1; i <= 3; i++) r.glow(mx - tux * i * 3, my - tuy * i * 3, 2 + g * 2, [1, 0.3, 0.1], (0.5 + g * 1.5) * pulse);
      r.light(mx, my, 14, 40 + g * 70, 1.2 * g * pulse, 0.3 * g * pulse, 0.1 * g * pulse, false);
      // a dotted warning line along the barrel's aim (the shell's exact line), blinking
      if ((this.glow >> 3) & 1) tellLine(r, mx, my, tux, tuy, 16, 120, 140);
    }
  }

  /** draw.ts fluid hook: exhaust and dust while it drives, fire and smoke from the wreck. */
  fluid(r: Renderer, ox: number, oy: number, f: number, time: number): void {
    if (!this.present) return;
    const x = ox + this.cx;
    const y = oy + this.cy;
    if (x < -80 || y < -80 || x > r.nw + 80 || y > r.nh + 80) return;
    if (this.state === 'dead') {
      const k = this.deadT < 60 * 30 ? 1 : 0.3;
      r.dyeSplat(x + Math.sin(time * 3) * 3, y - 2, 8, 0.6 * k * f, 0.4 * k * f, 0.12 * k * f);
      r.velSplat(x, y - 4, 7, 0, -10 * f);
      return;
    }
    if (this.state === 'dying') {
      r.dyeSplat(x + (Math.random() - 0.5) * 30, y + (Math.random() - 0.5) * 30, 7, 0.5 * f, 0.6 * f, 0.4 * f);
      return;
    }
    const d = this.dir;
    if (this.w.frame < this.smokeUntil) {
      // the smoke screen in the fluid: thick, drifting with the wind and the tank's own wake
      for (let i = 0; i < 2; i++) r.dyeSplat(x + (Math.random() - 0.5) * 44, y + (Math.random() - 0.5) * 44, 12, 0.55 * f, 0, 0);
    }
    if (this.moving) r.velSplat(x, y, 22, DX[d] * 300 * r.dt, DY[d] * 300 * r.dt);
    // exhaust at the back corners
    for (const s of [-12, 12]) {
      const ex = x - DX[d] * 24 + DY[d] * s;
      const ey = y - DY[d] * 24 + DX[d] * s;
      r.dyeSplat(ex, ey, 3, (this.moving ? 0.14 : 0.05) * f, 0.08 * f, 0);
    }
    for (const p of this.parts) {
      if (p.hp > 0) continue;
      const [px, py, pw, ph] = this.partRect(p);
      r.dyeSplat(ox + px + pw / 2, oy + py + ph / 2, 4, 0.3 * f, 0.2 * f, 0.08 * f);
    }
  }
}
