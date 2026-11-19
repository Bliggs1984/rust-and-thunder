// Phase 3: the enemy's tricks in campaign regions (CAMPAIGN.md "Enemy tricks" and Enemy AI "recon and spotting",
// "artillery prep", "supply convoys"). Tuned "easy": every trick has a tell the attentive player can read first.
//
// - Drones: small quadcopters fly in from enemy-held places (unfreed towns, standing depots, road exits). Heard
//   before seen: a buzz (sound 'trick-drone') every 0.25 s, louder as it nears; a "DRONE!" toast once it is within
//   160 px (3.6 s, with a red bracket or edge arrow on it; hover shows a blinking ring round the tank). An attack drone hovers over its target (shadow on the ground, fast red blink, red dot on the tank) and
//   drops a grenade after 2 s of hovering within 10 px (2 armour, 9 px blast). It follows at 0.55 px/frame while
//   hovering, so a tank that drives off (1 px/frame) shakes it, then can turn and shoot it. A player shell that has
//   flown 10+ px and passes within 6 px of the drone (its sprite down to its shadow) brings it down (your gun
//   can't hit one straight overhead; a partner can). Spotter drones (white strobe) circle at ~72 px for 2.5 s, then radio the grid: the
//   AI director learns where the player is (ai.spotted: nearby groups become aware, a column comes) and an
//   artillery barrage follows. Shoot the spotter first and nothing follows. A fitted jammer (aerial 64 px, oven
//   76 px; any player's jammer covers the partner too) makes a drone in range lose its link: it drifts away
//   throwing sparks for 1.3 s, then falls and crashes harmlessly.
// - Hidden AT teams: two-man rocket teams in tree cover and ruins near roads and towns. Not drawn until they fire
//   (or recon reveals them, or a tank comes within 20 px). An ambush: the rocket leaves 2 frames after a tank
//   enters their line (only a muzzle puff, no glint); it flies straight at where the tank was then (2 armour,
//   3.2 px/frame, 100 px reach, brick stops it).
//   Reload 4 s, 2 rockets (3 from region 3), then they hold their fire. A shell or a tank driving over them
//   kills them (+6 scrap).
// - Minefields: clusters of 3-4 mines on roads and in open fields, never in towns, nowhere near the start. Hidden;
//   a faint patch of disturbed earth marks each one. A player tank that drives onto one takes 3 armour; the rest of
//   that field then shows. Hover tanks float over them. Enemy tanks never set them off: they laid them and drive
//   the marked lanes. Recon shows all; the scout perk 'night-eyes' shows mines within 48 px; a shown mine can be
//   shot. A fitted plough (farm harrow 8 px, mine roller 12 px) sets off mines just ahead of the tank harmlessly.
// - Artillery: 2-3 warning circles (radius 12) on the ground round the player's last known position, growing and
//   blinking faster, an intercepted fire order on the radio and an "INCOMING!" toast; each shell lands 1.8 s after
//   its circle appears (whistle 0.9 s before): big blast, crater, 3 armour to a tank whose centre is inside the
//   circle, brick knocked down within 10 px. Never inside a town, one barrage at a time, 30+ s apart.
// - Supply convoys: an escort tank leading 2-4 soft trucks along the road graph between depots and road exits
//   (radio intercept as they set off). One hit (or a ram) wrecks a truck: +15 scrap pickup, 25% a part pickup,
//   "CONVOY HIT" toast. The escort turns and fires at a player in line once the convoy is alerted.
// Pacing: mines and teams exist from the start; drones, artillery and convoys begin after the first town is
// freed, at most 2 of them active at once. Region 1 is gentlest (1 drone at a time, 2 circles, fewer teams and
// fields); each region shortens the gaps by 10 s. w.ease (retreats) stretches gaps (x1 + 2*ease) and tells
// (x1 + ease). The clock power-up (w.freeze) holds drones, teams and convoys.
// Hooks outside this file: world.ts calls update / moved / bulletHit, draw.ts calls draw; ai.ts drive() hands
// convoy escorts to owns(); ai.ts spotted() takes spotter reports; save.ts fitTank sets Tank.fitted.
import type { Renderer } from '../gl/renderer';
import * as Abil from './abilities';
import { BRICK, DOWN, DX, DY, EMPTY, ENEMY, LEFT, MAT_METAL, MAT_STD, RIGHT, ROAD, STEEL, TREES, UP, WATER } from './constants';
import { OvPen, ring } from './bosses/marks';
import { mulberry32 } from './stages';
import { ENEMY_DMG, Tank, type Bullet, type World } from './world';

type V3 = [number, number, number];
const WHITE: V3 = [1, 1, 1];
const rand = Math.random;
const S = 60;
const clamp = (v: number, a: number, b: number) => Math.max(a, Math.min(b, v));
/** abilities.ts export read while the player's recon drone is up (looked up by name until that module has it) */
let REVEALED = 'revealed';
const HEAD: Record<string, number> = { day: 0.7, dusk: 1.3, night: 2.0, snow: 1.0 };

/** Tuning ("easy"). Distances in px, times in frames (60 per second). */
export const TR = {
  /** drones in flight + barrage + convoy at once */
  maxActive: 2,
  // ---- drones ----
  droneSpeed: 0.75,
  droneHoverSpeed: 0.55,
  droneHover: 2 * S,
  /** the "DRONE!" toast and the red marker start this far from the tank it is flying at */
  droneWarnR: 160,
  droneHitR: 6,
  /** a shell must have flown this far before it can hit a drone (your own gun can't hit one overhead) */
  droneMinTravel: 10,
  droneBomb: 2,
  droneBombR: 9,
  droneFall: 20,
  /** sprite drawn this far above its ground point (the shadow) */
  droneLift: 9,
  droneLife: 45 * S,
  jamR: { 'aerial-jammer': 64, 'oven-jammer': 76 } as Record<string, number>,
  jamDrift: 80,
  spotR: 72,
  spotWatch: 150,
  spotterChance: 0.35,
  droneFirst: [25 * S, 40 * S],
  droneGap: [80 * S, 110 * S],
  // ---- hidden AT teams ----
  teams: [3, 2],
  teamMax: 10,
  teamRange: 96,
  /** an ambush: only a 2-frame muzzle puff before the rocket leaves (was a 30-frame glint) */
  teamTell: 2,
  /** how often (frames) a waiting team looks for a tank in its line (was 6) */
  teamLook: 2,
  teamReload: 4 * S,
  /** rockets a team carries (one more from region 3); then it holds its fire */
  teamAmmo: 2,
  teamDmg: 2,
  teamRevealR: 20,
  teamScrap: 3, // was 6 (2026-11-18 scrap economy)
  rocketSpeed: 3.2,
  rocketReach: 100,
  rocketHitR: 8,
  // ---- mines ----
  mineClusters: [2, 1],
  mineClusterMax: 6,
  minesPer: 3,
  mineDmg: 3,
  plough: { 'farm-harrow': 8, 'mine-roller': 12 } as Record<string, number>,
  nightEyesR: 48,
  // ---- artillery ----
  artR: 12,
  artDmg: 3,
  artWarn: 108,
  artStagger: 18,
  artWhistle: 54,
  artBrickR: 10,
  artMinGap: 30 * S,
  artFirst: [45 * S, 60 * S],
  artGap: [100 * S, 130 * S],
  // ---- convoys ----
  convoySpeed: 0.5,
  convoySpacing: 24,
  truckScrap: 15,
  truckPart: 0.25,
  convoyFirst: [30 * S, 50 * S],
  convoyGap: [120 * S, 160 * S],
  /** each region after the first takes this off every gap */
  gapPerRegion: 10 * S,
  /** how many gapPerRegion steps each region's gaps lose (by tier; was the tier itself: 0-4). River Delta keeps Rail's
   * pace and Winter Ruined Town's (2026-11-18 curve, after the field patch's cooldown); what each region fields is still
   * by tier */
  gapCut: [0, 1, 1, 3, 3],
  /** gentle start: in these regions (tier: Farmland, Winter Front) no drone, barrage, convoy or rocket team fires this long */
  gentleTiers: [0, 4],
  gentleT: 60 * S,
};

export type DronePhase = 'in' | 'hover' | 'out' | 'jam' | 'fall' | 'dead';
export interface Drone {
  id: number;
  kind: 'attack' | 'spot';
  phase: DronePhase;
  /** ground point (the shadow); the sprite is drawn TR.droneLift px higher */
  x: number;
  y: number;
  z: number;
  vx: number;
  vy: number;
  hx: number;
  hy: number;
  pi: number;
  t: number;
  hold: number;
  watch: number;
  warned: boolean;
  buzz: number;
  orbit: number;
}
export interface Bomb { x: number; y: number; t: number }
export interface Team { x: number; y: number; dir: number; alive: boolean; shown: boolean; tell: number; reload: number; aim: [number, number]; ruin: boolean; ammo: number }
export interface Mine { x: number; y: number; alive: boolean; shown: boolean; decal: boolean; field: number }
export interface Rocket { x: number; y: number; vx: number; vy: number; d: number }
export interface ArtShell { x: number; y: number; appear: number; at: number; done: boolean }
export interface Barrage { call: string; shells: ArtShell[]; spotted: boolean }
export interface Vehicle { truck: boolean; off: number; x: number; y: number; dir: number; alive: boolean; in: boolean; tank: Tank | null; anim: number }
export interface Convoy {
  call: string;
  from: string;
  to: string;
  pts: [number, number][];
  cum: number[];
  len: number;
  s: number;
  vehicles: Vehicle[];
  hit: boolean;
  stall: number;
  alert: number;
  react: number;
}
interface Wreck { x: number; y: number; dir: number; t: number }
interface End { name: string; node: number; depot: boolean }

const DRONE_CALLS = ['HORNET', 'GADFLY', 'MIDGE', 'BOTFLY'];
const ART_CALLS = ['BASALT', 'QUARRY', 'BELLOWS', 'KILN'];
const CONVOY_CALLS = ['PACKMULE', 'OXCART', 'BARROW', 'HANDCART'];

export class Tricks {
  /** campaign maps with towns only (the AI director runs them) */
  readonly on: boolean;
  /** false = no automatic launches (tests and screenshot scenes stage them by hand) */
  auto = true;
  /** true = drones, artillery and convoys allowed before the first town is freed */
  force = false;
  /** true = everything hidden is shown (scenes); recon from abilities.ts does the same while it is up */
  reveal = false;
  tier = 0;
  drones: Drone[] = [];
  bombs: Bomb[] = [];
  teams: Team[] = [];
  mines: Mine[] = [];
  rockets: Rocket[] = [];
  barrage: Barrage | null = null;
  convoy: Convoy | null = null;
  wrecks: Wreck[] = [];
  /** event log for the sim (frame-stamped) */
  log: string[] = [];
  stats = {
    ms: 0, msMax: 0, msSum: 0, n: 0, initMs: 0,
    drones: 0, spotters: 0, warned: 0, drops: 0, bombHits: 0, dronesDown: 0, jammed: 0, jamCrash: 0, spotted: 0,
    teams: 0, rockets: 0, rocketHits: 0, teamsKilled: 0,
    mines: 0, minesHit: 0, minesCleared: 0,
    barrages: 0, shells: 0, artHits: 0, bricks: 0,
    convoys: 0, trucksKilled: 0, convoysArrived: 0, escortShots: 0,
    maxActive: 0,
  };
  private inited = false;
  private unlocked = false;
  private nextDrone = 0;
  private nextBarrage = 0;
  private nextConvoy = 0;
  private lastBarrageEnd = -1e9;
  private pendingSpot: { x: number; y: number; f: number } | null = null;
  private nextId = 1;
  private callN = 0;
  private owned = new Set<Tank>();
  private b0 = new WeakMap<Bullet, [number, number]>();
  private fakes = new Map<number, Tank>();
  private nodes: [number, number][] = [];
  private adj: [number, number][][] = [];
  private mineWarned = false;

  constructor(public w: World) {
    this.on = !!w.region && (w.towns.length > 0 || !!w.region.arena); // ?arena= stages tricks without towns
  }

  // ---------- small helpers ----------
  private get ease(): number {
    const e = this.w.ease;
    return Number.isFinite(e) ? clamp(e, -0.2, 0.5) : 0;
  }

  /** frames for a gap [a, b], shortened by region and stretched by ease */
  private gap(r: number[], min = 20 * S): number {
    const base = r[0] + rand() * (r[1] - r[0]) - (TR.gapCut[this.tier] ?? this.tier) * TR.gapPerRegion;
    return Math.round(Math.max(min, base) * (1 + 2 * this.ease));
  }

  private tell(n: number): number {
    return Math.round(n * (1 + Math.max(0, this.ease))); // (a warning never gets shorter than designed)
  }

  private logEv(s: string): void {
    this.log.push(`${this.w.frame} ${s}`);
    if (this.log.length > 400) this.log.splice(0, 100);
  }

  private radio(text: string): void {
    const r = this.w.radio;
    if (r.length && r[r.length - 1].text === text) return;
    r.push({ who: 'INTERCEPT', text, amb: true });
    if (r.length > 20) r.shift();
    this.logEv(`RADIO ${text}`);
  }

  private call(list: string[]): string {
    return list[this.callN++ % list.length];
  }

  /** recon drone up (abilities.ts revealed(w), once merged) or a scene asked for it */
  revealAll(): boolean {
    if (this.reveal) return true;
    const f = (Abil as unknown as Record<string, unknown>)[REVEALED];
    if (typeof f !== 'function') return false;
    try {
      return !!f(this.w);
    } catch {
      return false;
    }
  }

  /** A fake enemy whose shell does n armour (hitPlayer takes damage by enemy type). */
  private fake(n: number): Tank {
    let t = this.fakes.get(n);
    if (!t) {
      t = new Tank();
      const e = ENEMY_DMG.indexOf(n);
      t.etype = e >= 0 ? e : 0;
      this.fakes.set(n, t);
    }
    return t;
  }

  private damage(p: Tank, n: number): void {
    this.w.hitPlayer(p, this.fake(n));
  }

  private live(): Tank[] {
    return this.w.livePlayers();
  }

  private nearestPlayer(x: number, y: number): { p: Tank | null; d: number } {
    let p: Tank | null = null;
    let d = Infinity;
    for (const t of this.live()) {
      const dd = Math.hypot(t.cx - x, t.cy - y);
      if (dd < d) { d = dd; p = t; }
    }
    return { p, d };
  }

  private inTown(x: number, y: number, m = 0): boolean {
    return this.w.towns.some((t) => x >= t.rect[0] - m && y >= t.rect[1] - m && x < t.rect[0] + t.rect[2] + m && y < t.rect[1] + t.rect[3] + m);
  }

  private inTrees(p: Tank): boolean {
    const m = this.w.map;
    const cx = Math.round(p.x / 4);
    const cy = Math.round(p.y / 4);
    let n = 0;
    for (let y = cy; y < cy + 4; y++) for (let x = cx; x < cx + 4; x++) if (m.at(x, y) === TREES) n++;
    return n >= 8;
  }

  /** brick or steel on the straight line between two points (skipping `skip` px at the start) */
  private blockedLine(x0: number, y0: number, x1: number, y1: number, skip = 0): boolean {
    const d = Math.hypot(x1 - x0, y1 - y0);
    const n = Math.ceil(d / 3);
    const m = this.w.map;
    for (let i = 1; i < n; i++) {
      if ((i * d) / n < skip) continue;
      const c = m.at(Math.floor((x0 + ((x1 - x0) * i) / n) / 4), Math.floor((y0 + ((y1 - y0) * i) / n) / 4));
      if (c === BRICK || c === STEEL) return true;
    }
    return false;
  }

  /** drones still on their way in or hovering, plus a barrage and a convoy */
  activeCount(): number {
    let n = 0;
    for (const d of this.drones) if (d.phase === 'in' || d.phase === 'hover') n++;
    if (this.barrage) n++;
    if (this.convoy) n++;
    return n;
  }

  private maxDrones(): number {
    return this.tier >= 2 ? 2 : 1;
  }

  /** a blast: booms, light, crater decal, sparks, smoke; shake scaled by how close a player is */
  private blast(x: number, y: number, size: 0 | 1 | 2): void {
    const w = this.w;
    w.booms.push({ x, y, big: size >= 1, t: 0 });
    w.flashes.push({ x, y, t: 0, max: [12, 26, 40][size], r: [40, 70, 110][size], col: [1, 0.6, 0.25], z: 14 });
    w.decals.push({ k: 1, x, y, r: [4, 7, 10][size], col: [0.025, 0.022, 0.02], a: [0.4, 0.6, 0.75][size] });
    if (size === 2) w.decals.push({ k: 1, x, y, r: 15, col: [0.05, 0.045, 0.04], a: 0.28 });
    w.sparks(x, y, [5, 9, 14][size], [1, 0.7, 0.3]);
    for (let i = 0; i < size * 3; i++) {
      w.parts.push({
        x: x + (rand() - 0.5) * 8, y: y + (rand() - 0.5) * 8, z: 8, vx: (rand() - 0.5) * 0.5, vy: (rand() - 0.5) * 0.5 - 0.15, vz: 0.1,
        life: 0, max: 70 + Math.floor(rand() * 40), col: [0.2, 0.18, 0.16], kind: 2, r: 4 + rand() * 4,
      });
    }
    for (let i = 0; i < size * 4; i++) {
      const a = rand() * Math.PI * 2;
      const s = 0.5 + rand() * 1.2;
      w.parts.push({ x, y, z: 6, vx: Math.cos(a) * s, vy: Math.sin(a) * s, vz: 0.8 + rand() * 1.2, life: 0, max: 200, col: [0.3, 0.24, 0.16], kind: 0, r: 1 });
    }
    if (size >= 1) {
      const { d } = this.nearestPlayer(x, y);
      const k = d < 60 ? 1 : d < 180 ? 0.5 : 0.15;
      w.shake = Math.max(w.shake, (size === 2 ? 4 : 2.5) * k);
      if (size === 2) w.shocks.push({ x, y, t: 0, max: 30, size: 0.8 });
    }
  }

  // ---------- per update ----------
  update(): void {
    if (!this.on) return;
    const w = this.w;
    if (!this.inited) {
      const ti = performance.now();
      this.init();
      this.stats.initMs = performance.now() - ti;
    }
    const t0 = performance.now();
    if (!w.over) {
      if (!this.unlocked && (this.force || w.towns.some((t) => t.freed))) this.unlock();
      if (this.auto && this.unlocked) this.schedule();
      const held = w.freeze > 0;
      if (!held) this.updateDrones();
      this.updateBombs();
      if (!held) this.updateTeams();
      this.updateRockets();
      this.updateMines();
      this.updateBarrage();
      if (this.convoy) this.updateConvoy(held);
      this.updateWrecks();
      this.stats.maxActive = Math.max(this.stats.maxActive, this.activeCount());
    }
    const ms = performance.now() - t0;
    const s = this.stats;
    s.ms = ms;
    s.msSum += ms;
    s.n++;
    s.msMax = Math.max(s.msMax, ms);
  }

  /** A tank moved one step (world.move): mines under it, and a fitted plough sweeping ahead of it. */
  moved(t: Tank): void {
    if (!this.on || !this.mines.length || !t.isPlayer) return;
    this.mineCheck(t);
  }

  /** A shell step: a player shell that meets a drone, a truck or an AT team is spent on it. */
  bulletHit(b: Bullet): boolean {
    if (!this.on || !this.inited || !b.owner.isPlayer) return false;
    let o = this.b0.get(b);
    if (!o) {
      o = [b.x, b.y];
      this.b0.set(b, o);
    }
    const pi = b.owner.player;
    const travelled = Math.abs(b.x - o[0]) + Math.abs(b.y - o[1]);
    for (const d of this.drones) {
      if (d.phase === 'dead' || d.phase === 'fall' || travelled < TR.droneMinTravel) continue;
      // the drone's column, from its sprite (lift px up) down to its shadow
      const dy = b.y - d.y;
      if (Math.abs(b.x - d.x) <= TR.droneHitR && dy >= -TR.droneLift - TR.droneHitR && dy <= 5) {
        this.downDrone(d, pi);
        return true;
      }
    }
    const cv = this.convoy;
    if (cv) {
      for (const v of cv.vehicles) {
        if (!v.truck || !v.alive || !v.in) continue;
        const along = v.dir === UP || v.dir === DOWN;
        if (Math.abs(b.x - (v.x + 8)) <= (along ? 7 : 10) && Math.abs(b.y - (v.y + 8)) <= (along ? 10 : 7)) {
          this.killTruck(cv, v, pi);
          return true;
        }
      }
    }
    for (const t of this.teams) {
      if (t.alive && Math.abs(b.x - t.x) <= 5 && Math.abs(b.y - t.y) <= 5) {
        this.killTeam(t, pi);
        return true;
      }
    }
    for (const m of this.mines) {
      if (m.alive && (m.shown || this.revealAll()) && Math.abs(b.x - m.x) <= 3 && Math.abs(b.y - m.y) <= 3) {
        this.clearMine(m, 'SHOT');
        return true;
      }
    }
    return false;
  }

  /** A convoy escort: the director leaves it to us (ai.ts drive hook). */
  owns(e: Tank): boolean {
    return this.owned.has(e);
  }

  // ---------- setup ----------
  private init(): void {
    this.inited = true;
    const w = this.w;
    const reg = w.region!;
    this.tier = clamp(w.stage - 1, 0, 4);
    let seed = (reg.w * 73856093) ^ (reg.h * 19349663) ^ (w.stage * 83492791);
    for (const t of w.towns) seed = (Math.imul(seed, 31) + t.cx * 7 + t.cy) | 0;
    const rng = mulberry32(seed);
    this.placeTeams(rng);
    this.placeMines(rng);
    this.buildGraph();
    this.logEv(`init tier ${this.tier}: ${this.teams.length} teams, ${this.mines.length} mines, ${this.nodes.length} road nodes`);
  }

  private unlock(): void {
    this.unlocked = true;
    const f = this.w.frame;
    const first = (r: number[]) => Math.round((r[0] + rand() * (r[1] - r[0])) * (1 + 2 * this.ease));
    this.nextDrone = f + first(TR.droneFirst);
    this.nextBarrage = f + first(TR.artFirst);
    this.nextConvoy = f + first(TR.convoyFirst);
    this.logEv('unlocked');
  }

  /** tests: switch the gentle start off */
  gentleOff = false;

  /** The first minute of Farmland and Winter Front: nothing is aimed at the player yet. */
  private gentle(): boolean {
    return !this.force && !this.gentleOff && this.w.frame < TR.gentleT && TR.gentleTiers.includes(this.tier);
  }

  private nearSpawn(x: number, y: number, r: number): boolean {
    for (const [sx, sy] of this.w.region!.playerSpawns) if (Math.hypot(x - sx - 8, y - sy - 8) < r) return true;
    return false;
  }

  private nearDepot(x: number, y: number, m: number): boolean {
    return this.w.depots.some((d) => x >= d.rect[0] - m && y >= d.rect[1] - m && x < d.rect[0] + d.rect[2] + m && y < d.rect[1] + d.rect[3] + m);
  }

  /** per 8 px block: 1 if any of its cells is road */
  private roadBlocks(): { rb: Uint8Array; bw: number; bh: number } {
    const m = this.w.map;
    const bw = m.w >> 1;
    const bh = m.h >> 1;
    const rb = new Uint8Array(bw * bh);
    for (let cy = 0; cy < m.h; cy++) for (let cx = 0; cx < m.w; cx++) if (m.c[cy * m.w + cx] === ROAD) rb[(cy >> 1) * bw + (cx >> 1)] = 1;
    return { rb, bw, bh };
  }

  private placeTeams(rng: () => number): void {
    const w = this.w;
    const m = w.map;
    const want = Math.min(TR.teamMax, TR.teams[0] + TR.teams[1] * this.tier);
    const { rb, bw, bh } = this.roadBlocks();
    const roadNear = (bx: number, by: number, r: number) => {
      for (let y = by - r; y <= by + r; y++) for (let x = bx - r; x <= bx + r; x++) if (x >= 0 && y >= 0 && x < bw && y < bh && rb[y * bw + x]) return true;
      return false;
    };
    const cands: [number, number, boolean][] = [];
    for (let by = 1; by < bh - 1; by++) {
      for (let bx = 1; bx < bw - 1; bx++) {
        const cx = bx * 2;
        const cy = by * 2;
        let trees = 0;
        let empty = 0;
        for (const [i, j] of [[0, 0], [1, 0], [0, 1], [1, 1]]) {
          const c = m.at(cx + i, cy + j);
          if (c === TREES) trees++;
          else if (c === EMPTY) empty++;
        }
        const x = bx * 8 + 4;
        const y = by * 8 + 4;
        let ruin = false;
        if (trees >= 3) {
          // at the edge of the cover, so they can see out
          let open = 0;
          for (let i = -1; i <= 2; i++) for (const j of [-1, 2]) if (m.at(cx + i, cy + j) !== TREES) open++;
          for (let j = 0; j <= 1; j++) for (const i of [-1, 2]) if (m.at(cx + i, cy + j) !== TREES) open++;
          if (open < 3) continue;
        } else if (empty === 4 && this.inTown(x, y, 24)) {
          let bricks = 0;
          for (let i = -1; i <= 2; i++) for (const j of [-1, 2]) if (m.at(cx + i, cy + j) === BRICK) bricks++;
          for (let j = 0; j <= 1; j++) for (const i of [-1, 2]) if (m.at(cx + i, cy + j) === BRICK) bricks++;
          if (bricks < 3) continue;
          ruin = true;
        } else {
          continue;
        }
        if (!roadNear(bx, by, 5) && !this.inTown(x, y, 32)) continue;
        if (this.nearSpawn(x, y, 240) || this.nearDepot(x, y, 16)) continue;
        if (w.towns.some((t) => Math.hypot(t.cx - x, t.cy - y) < 40)) continue;
        cands.push([x, y, ruin]);
      }
    }
    for (let i = cands.length - 1; i > 0; i--) {
      const j = Math.floor(rng() * (i + 1));
      [cands[i], cands[j]] = [cands[j], cands[i]];
    }
    for (const [x, y, ruin] of cands) {
      if (this.teams.length >= want) break;
      if (this.teams.some((t) => Math.hypot(t.x - x, t.y - y) < 140)) continue;
      this.teams.push({ x, y, dir: DOWN, alive: true, shown: false, tell: 0, reload: 0, aim: [x, y], ruin, ammo: TR.teamAmmo + (this.tier >= 2 ? 1 : 0) });
    }
    this.stats.teams = this.teams.length;
  }

  private placeMines(rng: () => number): void {
    const w = this.w;
    const m = w.map;
    const want = Math.min(TR.mineClusterMax, TR.mineClusters[0] + TR.mineClusters[1] * this.tier);
    const per = TR.minesPer + (this.tier >= 2 ? 1 : 0);
    const bw = m.w >> 1;
    const bh = m.h >> 1;
    const roads: [number, number][] = [];
    const fields: [number, number][] = [];
    const ok = (c: number) => c === EMPTY || c === ROAD;
    for (let by = 2; by < bh - 2; by++) {
      for (let bx = 2; bx < bw - 2; bx++) {
        const cx = bx * 2;
        const cy = by * 2;
        const x = bx * 8 + 4;
        const y = by * 8 + 4;
        if (this.inTown(x, y, 24) || this.nearSpawn(x, y, 220) || this.nearDepot(x, y, 24)) continue;
        let road = 0;
        let empty = 0;
        let bad = false;
        for (let j = -3; j <= 4 && !bad; j++) {
          for (let i = -3; i <= 4; i++) {
            const c = m.at(cx + i, cy + j);
            if (c === WATER || c === STEEL) bad = true;
            if (i >= 0 && i <= 1 && j >= 0 && j <= 1) {
              if (c === ROAD) road++;
              else if (c === EMPTY) empty++;
            } else if (c === BRICK || c === TREES) {
              if (Math.abs(i - 0.5) <= 2.5 && Math.abs(j - 0.5) <= 2.5) bad = true;
            }
          }
        }
        if (bad) continue;
        if (road === 4) roads.push([x, y]);
        else if (empty === 4) fields.push([x, y]);
      }
    }
    const pick = (list: [number, number][]) => list[Math.floor(rng() * list.length)];
    for (let k = 0, tries = 0; k < want && tries < 400; tries++) {
      const useRoad = roads.length && (rng() < 0.6 || !fields.length);
      const list = useRoad ? roads : fields;
      if (!list.length) break;
      const [x, y] = pick(list);
      if (this.mines.some((mm) => Math.hypot(mm.x - x, mm.y - y) < 220)) continue;
      // a road field runs along the road; an open one is a loose patch
      const horiz = useRoad && m.at((x >> 2) - 3, y >> 2) === ROAD && m.at((x >> 2) + 3, y >> 2) === ROAD;
      const vert = useRoad && m.at(x >> 2, (y >> 2) - 3) === ROAD && m.at(x >> 2, (y >> 2) + 3) === ROAD;
      const placed: [number, number][] = [];
      for (let t = 0; t < 40 && placed.length < per; t++) {
        let mx: number;
        let my: number;
        if (horiz && !vert) { mx = x + (rng() - 0.5) * 30; my = y + (rng() - 0.5) * 8; }
        else if (vert && !horiz) { mx = x + (rng() - 0.5) * 8; my = y + (rng() - 0.5) * 30; }
        else { mx = x + (rng() - 0.5) * 24; my = y + (rng() - 0.5) * 24; }
        mx = Math.round(mx);
        my = Math.round(my);
        if (!ok(m.at(mx >> 2, my >> 2)) || placed.some(([px, py]) => Math.hypot(px - mx, py - my) < 7)) continue;
        placed.push([mx, my]);
      }
      if (placed.length < 2) continue;
      for (const [mx, my] of placed) this.mines.push({ x: mx, y: my, alive: true, shown: false, decal: false, field: k });
      k++;
    }
    this.stats.mines = this.mines.length;
  }

  private buildGraph(): void {
    const g = this.w.region?.roads;
    if (!g) return;
    this.nodes = g.nodes.map(([nx, ny]) => [nx * 8, ny * 8] as [number, number]);
    this.adj = this.nodes.map(() => []);
    for (const [a, b] of g.edges) {
      const [ax, ay] = this.nodes[a];
      const [bx, by] = this.nodes[b];
      const len = Math.abs(ax - bx) + Math.abs(ay - by);
      this.adj[a].push([b, len]);
      this.adj[b].push([a, len]);
    }
  }

  // ---------- scheduling ----------
  private schedule(): void {
    const w = this.w;
    const f = w.frame;
    if (!this.live().length || w.freeze > 0 || this.gentle()) return;
    if (f >= this.nextDrone) {
      const flying = this.drones.filter((d) => d.phase === 'in' || d.phase === 'hover').length;
      if (this.activeCount() < TR.maxActive && flying < this.maxDrones() && this.launchDrone()) this.nextDrone = f + this.gap(TR.droneGap, 35 * S);
      else this.nextDrone = f + 5 * S;
    }
    if (this.pendingSpot && f - this.pendingSpot.f > 20 * S) this.pendingSpot = null;
    const artReady = !this.barrage && f - this.lastBarrageEnd >= TR.artMinGap;
    if (artReady && this.pendingSpot && this.activeCount() < TR.maxActive) {
      const s = this.pendingSpot;
      this.pendingSpot = null;
      if (this.startBarrage(s.x, s.y, true)) this.nextBarrage = Math.max(this.nextBarrage, f + this.gap(TR.artGap, TR.artMinGap));
    } else if (artReady && f >= this.nextBarrage) {
      if (this.activeCount() < TR.maxActive && this.autoBarrage()) this.nextBarrage = f + this.gap(TR.artGap, TR.artMinGap);
      else this.nextBarrage = f + 6 * S;
    }
    if (!this.convoy && f >= this.nextConvoy) {
      if (this.activeCount() < TR.maxActive && this.launchConvoy()) this.nextConvoy = f + this.gap(TR.convoyGap, 60 * S);
      else this.nextConvoy = f + 10 * S;
    }
  }

  // ---------- drones ----------
  /** Where a drone comes from: an enemy-held place 200-520 px from the player, else a point 320 px off. */
  private droneSource(p: Tank): [number, number] {
    const w = this.w;
    const src: [number, number][] = [];
    for (const t of w.towns) if (!t.freed) src.push([t.cx, t.cy]);
    for (const d of w.depots) if (!d.destroyed) src.push([d.cx, d.cy]);
    for (const e of w.region?.exits ?? []) src.push([e[0] + 8, e[1] + 8]);
    const band = src.filter(([x, y]) => {
      const d = Math.hypot(x - p.cx, y - p.cy);
      return d >= 200 && d <= 520;
    });
    if (band.length) return band[Math.floor(rand() * band.length)];
    const a = rand() * Math.PI * 2;
    return [clamp(p.cx + Math.cos(a) * 320, 4, w.pxW - 4), clamp(p.cy + Math.sin(a) * 320, 4, w.pxH - 4)];
  }

  /** Launch a drone at player pi (default: a random live one). Returns it, or null with nobody to fly at. */
  launchDrone(pi = -1, kind: 'attack' | 'spot' | null = null, from: [number, number] | null = null): Drone | null {
    const pl = this.live();
    if (!pl.length) return null;
    const p = pi >= 0 && this.w.players[pi]?.alive ? this.w.players[pi]! : pl[Math.floor(rand() * pl.length)];
    const k = kind ?? (rand() < TR.spotterChance ? 'spot' : 'attack');
    const [x, y] = from ?? this.droneSource(p);
    const d: Drone = {
      id: this.nextId++, kind: k, phase: 'in', x, y, z: 16, vx: 0, vy: 0, hx: x, hy: y, pi: p.player, t: 0, hold: 0, watch: 0,
      warned: false, buzz: 0, orbit: rand() < 0.5 ? 1 : -1,
    };
    this.drones.push(d);
    this.stats.drones++;
    if (k === 'spot') {
      this.stats.spotters++;
      this.radio(`${this.call(DRONE_CALLS)}: BIRD IS UP. LOOKING FOR THEIR TANK.`);
    }
    this.logEv(`drone ${d.id} ${k} from ${Math.round(x)},${Math.round(y)} at P${p.player + 1}`);
    return d;
  }

  private steer(d: Drone, tx: number, ty: number, speed: number): number {
    const dx = tx - d.x;
    const dy = ty - d.y;
    const dist = Math.hypot(dx, dy);
    const s = Math.min(speed, dist);
    if (dist > 1e-6) {
      // a little inertia, so it swings in rather than snapping
      d.vx += ((dx / dist) * s - d.vx) * 0.2;
      d.vy += ((dy / dist) * s - d.vy) * 0.2;
    }
    d.x += d.vx;
    d.y += d.vy;
    return dist;
  }

  private jammerRange(p: Tank): number {
    const id = p.fitted?.jammer;
    return id ? TR.jamR[id] ?? 64 : 0;
  }

  private updateDrones(): void {
    const w = this.w;
    if (!this.drones.length) return;
    const pl = this.live();
    for (const d of this.drones) {
      d.t++;
      if (d.phase === 'dead') continue;
      // buzz: heard before seen, louder as it nears the closest player
      if (--d.buzz <= 0 && d.phase !== 'fall') {
        d.buzz = 15;
        const { d: dist } = this.nearestPlayer(d.x, d.y);
        w.snd('trick-drone', d.x, 0.12 + 0.88 * clamp(1 - dist / 380, 0, 1));
      }
      // jammers: any player's jammer in range breaks the link
      if (d.phase === 'in' || d.phase === 'hover' || d.phase === 'out') {
        for (const p of pl) {
          const r = this.jammerRange(p);
          if (r && Math.hypot(p.cx - d.x, p.cy - d.y) < r) {
            d.phase = 'jam';
            d.t = 0;
            const dist = Math.max(1, Math.hypot(d.x - p.cx, d.y - p.cy));
            d.vx = ((d.x - p.cx) / dist) * 0.6;
            d.vy = ((d.y - p.cy) / dist) * 0.6;
            this.stats.jammed++;
            w.popups.push({ x: d.x, y: d.y - 14, text: 'JAMMED', t: 0, col: [0.6, 0.9, 1] });
            w.sparks(d.x, d.y - TR.droneLift, 8, [0.6, 0.85, 1]);
            this.logEv(`drone ${d.id} jammed by P${p.player + 1}`);
            break;
          }
        }
      }
      let p = w.players[d.pi];
      if ((!p || !p.alive || p.spawn > 0) && (d.phase === 'in' || d.phase === 'hover')) {
        const n = this.nearestPlayer(d.x, d.y).p;
        if (n) d.pi = n.player;
        else { d.phase = 'out'; d.t = 0; }
        p = n;
      }
      switch (d.phase) {
        case 'in': {
          if (!p) break;
          const dist = Math.hypot(p.cx - d.x, p.cy - d.y);
          if (!d.warned && dist <= TR.droneWarnR) {
            d.warned = true;
            this.stats.warned++;
            w.note(d.kind === 'spot' ? 'SPOTTER DRONE!' : 'DRONE!', 'warn', -1, 3600);
          }
          if (d.kind === 'attack') {
            this.steer(d, p.cx, p.cy, TR.droneSpeed);
            if (dist < 10) { d.phase = 'hover'; d.hold = 0; }
          } else {
            // circle the tank at a stand-off distance and watch it
            if (dist > TR.spotR + 8) {
              this.steer(d, p.cx, p.cy, TR.droneSpeed * 1.15);
            } else {
              const a = Math.atan2(d.y - p.cy, d.x - p.cx) + d.orbit * 0.012;
              this.steer(d, p.cx + Math.cos(a) * TR.spotR, p.cy + Math.sin(a) * TR.spotR, TR.droneSpeed);
              if (!this.inTrees(p) || dist < 32) d.watch++;
              if (d.watch >= this.tell(TR.spotWatch)) this.report(d, p);
            }
          }
          if (d.t > TR.droneLife) { d.phase = 'out'; d.t = 0; }
          break;
        }
        case 'hover': {
          if (!p) break;
          const dist = this.steer(d, p.cx, p.cy, TR.droneHoverSpeed);
          if (dist < 10) d.hold++;
          else d.hold = Math.max(0, d.hold - 2);
          if (dist > 40) { d.phase = 'in'; d.hold = 0; break; }
          if (d.hold > 0 && d.hold % 20 === 1) w.snd('tick', d.x, 0.5);
          if (d.hold >= this.tell(TR.droneHover)) {
            this.bombs.push({ x: d.x, y: d.y, t: 0 });
            this.stats.drops++;
            d.phase = 'out';
            d.t = 0;
            this.logEv(`drone ${d.id} dropped at ${Math.round(d.x)},${Math.round(d.y)}`);
          }
          break;
        }
        case 'out': {
          this.steer(d, d.hx, d.hy, TR.droneSpeed * 1.1);
          const { d: dist } = this.nearestPlayer(d.x, d.y);
          if ((dist > 360 || !pl.length) && d.t > 60) d.phase = 'dead';
          if (Math.hypot(d.hx - d.x, d.hy - d.y) < 4 && dist > 220) d.phase = 'dead';
          break;
        }
        case 'jam': {
          // link lost: drifts away wobbling and throwing sparks, then drops out of the sky
          d.x += d.vx + Math.sin(d.t * 0.4) * 0.5;
          d.y += d.vy + Math.cos(d.t * 0.33) * 0.5;
          if (d.t % 6 === 0) w.sparks(d.x, d.y - TR.droneLift, 2, [0.6, 0.85, 1]);
          if (d.t >= TR.jamDrift) { d.phase = 'fall'; d.t = 0; }
          break;
        }
        case 'fall': {
          d.z -= 0.6;
          d.x += d.vx * 0.5;
          d.y += d.vy * 0.5;
          if (d.z <= 0) {
            d.phase = 'dead';
            this.stats.jamCrash++;
            this.blast(d.x, d.y, 0);
            w.snd('thud', d.x, 0.6);
          }
          break;
        }
      }
      d.x = clamp(d.x, 0, w.pxW);
      d.y = clamp(d.y, 0, w.pxH);
    }
    this.drones = this.drones.filter((d) => d.phase !== 'dead');
  }

  private downDrone(d: Drone, pi: number): void {
    const w = this.w;
    d.phase = 'dead';
    this.stats.dronesDown++;
    const y = d.y - TR.droneLift;
    w.booms.push({ x: d.x, y, big: false, t: 0 });
    w.flashes.push({ x: d.x, y, t: 0, max: 12, r: 44, col: [1, 0.7, 0.35], z: 16 });
    w.sparks(d.x, y, 10, [1, 0.8, 0.4]);
    for (let i = 0; i < 6; i++) {
      w.parts.push({
        x: d.x, y, z: 10, vx: (rand() - 0.5) * 1.4, vy: (rand() - 0.5) * 1.4, vz: 0.4 + rand(),
        life: 0, max: 200, col: i & 1 ? [0.22, 0.24, 0.26] : [0.36, 0.4, 0.24], kind: 0, r: 1,
      });
    }
    w.snd('explode', d.x, 0.6);
    w.popups.push({ x: d.x, y: y - 8, text: d.kind === 'spot' ? 'SPOTTER DOWN' : 'DRONE DOWN', t: 0, col: [0.6, 0.9, 1] });
    w.pickups.push({ x: d.x, y: d.y, kind: 'scrap', amount: 5, t: 0 });
    if (pi >= 0) w.addVetXp(pi, 0.15);
    this.logEv(`drone ${d.id} shot down by P${pi + 1}`);
  }

  /** A spotter saw the player long enough: the director learns, artillery follows. */
  private report(d: Drone, p: Tank): void {
    const w = this.w;
    this.stats.spotted++;
    d.phase = 'out';
    d.t = 0;
    this.radio(`${this.call(DRONE_CALLS)}: EYES ON THEIR TANK. SENDING GRID.`);
    w.ai?.spotted(p.x, p.y);
    this.logEv(`drone ${d.id} spotted P${p.player + 1}`);
    const f = w.frame;
    if (!this.barrage && f - this.lastBarrageEnd >= TR.artMinGap && this.activeCount() < TR.maxActive && this.startBarrage(p.cx, p.cy, true)) return;
    this.pendingSpot = { x: p.cx, y: p.cy, f };
  }

  private updateBombs(): void {
    if (!this.bombs.length) return;
    const w = this.w;
    for (const b of this.bombs) {
      if (++b.t < TR.droneFall) continue;
      this.blast(b.x, b.y, 0);
      w.snd('explode', b.x, 0.8);
      for (const p of this.live()) {
        if (Math.abs(p.cx - b.x) <= TR.droneBombR && Math.abs(p.cy - b.y) <= TR.droneBombR) {
          this.damage(p, TR.droneBomb);
          this.stats.bombHits++;
          this.logEv(`grenade hit P${p.player + 1}`);
        }
      }
    }
    this.bombs = this.bombs.filter((b) => b.t < TR.droneFall);
  }

  // ---------- hidden AT teams ----------
  private updateTeams(): void {
    const w = this.w;
    const f = w.frame;
    const pl = this.live();
    for (let i = 0; i < this.teams.length; i++) {
      const t = this.teams[i];
      if (!t.alive) continue;
      // a tank driving over them
      for (const p of pl) {
        if (Math.abs(p.cx - t.x) <= 9 && Math.abs(p.cy - t.y) <= 9) {
          this.killTeam(t, p.player);
          break;
        }
      }
      if (!t.alive) continue;
      if (t.tell > 0) {
        if (--t.tell === 0) this.fireRocket(t);
        continue;
      }
      if (t.reload > 0) {
        t.reload--;
        continue;
      }
      if (t.ammo <= 0 || (f + i) % TR.teamLook || this.gentle()) continue;
      let best: Tank | null = null;
      let bd = TR.teamRange;
      for (const p of pl) {
        const d = Math.hypot(p.cx - t.x, p.cy - t.y);
        if (d > bd || this.blockedLine(t.x, t.y, p.cx, p.cy, t.ruin ? 6 : 0)) continue;
        bd = d;
        best = p;
      }
      if (!best) continue;
      t.tell = this.tell(TR.teamTell);
      t.aim = [best.cx, best.cy];
      const dx = best.cx - t.x;
      const dy = best.cy - t.y;
      t.dir = Math.abs(dx) > Math.abs(dy) ? (dx > 0 ? RIGHT : LEFT) : dy > 0 ? DOWN : UP;
      // no real tell: a puff of dust as they shoulder the launcher (the rocket leaves TR.teamTell frames later)
      w.parts.push({ x: t.x, y: t.y, z: 3, vx: (rand() - 0.5) * 0.2, vy: -0.1, vz: 0, life: 0, max: 30, col: [0.55, 0.5, 0.42], kind: 2, r: 2.5 });
      this.logEv(`team at ${t.x},${t.y} lines up on P${best.player + 1}`);
    }
  }

  private fireRocket(t: Team): void {
    const w = this.w;
    const dx = t.aim[0] - t.x;
    const dy = t.aim[1] - t.y;
    const d = Math.max(1, Math.hypot(dx, dy));
    this.rockets.push({ x: t.x, y: t.y, vx: (dx / d) * TR.rocketSpeed, vy: (dy / d) * TR.rocketSpeed, d: 0 });
    if (!t.shown) w.popups.push({ x: t.x, y: t.y - 10, text: 'AMBUSH', t: 0, col: [1, 0.5, 0.35] });
    t.shown = true;
    t.ammo--;
    t.reload = this.tell(TR.teamReload);
    this.stats.rockets++;
    w.snd('trick-rocket', t.x, 0.9);
    // back-blast
    for (let i = 0; i < 4; i++) {
      w.parts.push({ x: t.x - (dx / d) * 4, y: t.y - (dy / d) * 4, z: 4, vx: -(dx / d) * (0.4 + rand() * 0.4) + (rand() - 0.5) * 0.3, vy: -(dy / d) * (0.4 + rand() * 0.4) + (rand() - 0.5) * 0.3, vz: 0.05, life: 0, max: 40, col: [0.6, 0.56, 0.5], kind: 2, r: 2.5 });
    }
    w.flashes.push({ x: t.x, y: t.y, t: 0, max: 8, r: 30, col: [1, 0.75, 0.4], z: 6 });
  }

  private updateRockets(): void {
    if (!this.rockets.length) return;
    const w = this.w;
    const pl = this.live();
    for (const r of this.rockets) {
      if (r.d < 0) continue;
      for (let s = 0; s < 3 && r.d >= 0; s++) {
        r.x += r.vx / 3;
        r.y += r.vy / 3;
        r.d += TR.rocketSpeed / 3;
        const hitP = pl.find((p) => Math.abs(p.cx - r.x) <= TR.rocketHitR && Math.abs(p.cy - r.y) <= TR.rocketHitR);
        if (hitP) {
          this.damage(hitP, TR.teamDmg);
          this.stats.rocketHits++;
          this.blast(r.x, r.y, 0);
          w.snd('explode', r.x, 0.8);
          this.logEv(`rocket hit P${hitP.player + 1}`);
          r.d = -1;
          break;
        }
        const cx = Math.floor(r.x / 4);
        const cy = Math.floor(r.y / 4);
        const c = w.map.at(cx, cy);
        if (c === BRICK || c === STEEL) {
          if (c === BRICK) {
            w.map.set(cx, cy, EMPTY);
            w.debris(cx * 4 + 2, cy * 4 + 2, Math.abs(r.vx) > Math.abs(r.vy) ? (r.vx > 0 ? RIGHT : LEFT) : r.vy > 0 ? DOWN : UP);
          }
          this.blast(r.x, r.y, 0);
          w.snd(c === BRICK ? 'brick' : 'steel', r.x, 0.7);
          r.d = -1;
          break;
        }
        if (r.d >= TR.rocketReach) {
          w.parts.push({ x: r.x, y: r.y, z: 3, vx: 0, vy: -0.1, vz: 0, life: 0, max: 40, col: [0.5, 0.48, 0.45], kind: 2, r: 3 });
          w.decals.push({ k: 1, x: r.x, y: r.y, r: 3, col: [0.03, 0.03, 0.03], a: 0.3 });
          r.d = -1;
        }
      }
      if (r.d >= 0 && w.frame % 2 === 0) {
        w.parts.push({ x: r.x - r.vx * 2, y: r.y - r.vy * 2, z: 4, vx: (rand() - 0.5) * 0.1, vy: (rand() - 0.5) * 0.1, vz: 0, life: 0, max: 26, col: [0.62, 0.6, 0.56], kind: 2, r: 1.6 });
      }
    }
    this.rockets = this.rockets.filter((r) => r.d >= 0);
  }

  private killTeam(t: Team, pi: number): void {
    const w = this.w;
    t.alive = false;
    this.stats.teamsKilled++;
    w.booms.push({ x: t.x, y: t.y, big: false, t: 0 });
    w.sparks(t.x, t.y, 5, [1, 0.8, 0.5]);
    w.parts.push({ x: t.x, y: t.y, z: 3, vx: 0, vy: -0.1, vz: 0, life: 0, max: 50, col: [0.5, 0.46, 0.4], kind: 2, r: 4 });
    w.snd('thud', t.x, 0.8);
    w.popups.push({ x: t.x, y: t.y - 10, text: 'AT TEAM OUT', t: 0, col: [1, 0.85, 0.4] });
    w.pickups.push({ x: t.x, y: t.y, kind: 'scrap', amount: TR.teamScrap, t: 0 });
    if (pi >= 0) w.addVetXp(pi, 0.15);
    this.logEv(`team at ${t.x},${t.y} killed by P${pi + 1}`);
  }

  // ---------- mines ----------
  private updateMines(): void {
    if (!this.mines.length) return;
    for (const p of this.live()) this.mineCheck(p);
  }

  private mineCheck(t: Tank): void {
    if (!t.alive || t.spawn > 0 || t.hover) return;
    const reach = TR.plough[t.fitted?.plough ?? ''] ?? 0;
    for (const m of this.mines) {
      if (!m.alive || Math.abs(m.x - t.cx) > 30 || Math.abs(m.y - t.cy) > 30) continue;
      if (reach) {
        // the plough sweeps a tank-wide strip just ahead of the hull
        let hit: boolean;
        switch (t.dir) {
          case UP: hit = m.x >= t.x && m.x <= t.x + 16 && m.y >= t.y - reach && m.y <= t.y + 3; break;
          case DOWN: hit = m.x >= t.x && m.x <= t.x + 16 && m.y >= t.y + 13 && m.y <= t.y + 16 + reach; break;
          case LEFT: hit = m.y >= t.y && m.y <= t.y + 16 && m.x >= t.x - reach && m.x <= t.x + 3; break;
          default: hit = m.y >= t.y && m.y <= t.y + 16 && m.x >= t.x + 13 && m.x <= t.x + 16 + reach;
        }
        if (hit) {
          this.clearMine(m, 'PLOUGH');
          continue;
        }
      }
      if (m.x > t.x + 2 && m.x < t.x + 14 && m.y > t.y + 2 && m.y < t.y + 14) this.triggerMine(m, t);
    }
  }

  private showField(m: Mine): void {
    for (const o of this.mines) if (o.field === m.field) o.shown = true;
  }

  private triggerMine(m: Mine, t: Tank): void {
    const w = this.w;
    m.alive = false;
    this.stats.minesHit++;
    this.blast(m.x, m.y, 1);
    w.snd('bigexplode', m.x, 0.9);
    this.damage(t, TR.mineDmg);
    w.popups.push({ x: m.x, y: m.y - 12, text: 'MINE', t: 0, col: [1, 0.4, 0.3] });
    if (!this.mineWarned) {
      this.mineWarned = true;
      w.note('MINEFIELD!', 'warn');
    }
    this.showField(m);
    this.logEv(`mine at ${m.x},${m.y} hit P${t.player + 1}`);
  }

  /** set off harmlessly: a plough ahead of a tank, or a shell on a shown mine */
  private clearMine(m: Mine, how: 'PLOUGH' | 'SHOT'): void {
    const w = this.w;
    m.alive = false;
    this.stats.minesCleared++;
    this.blast(m.x, m.y, 0);
    w.snd('explode', m.x, 0.7);
    w.popups.push({ x: m.x, y: m.y - 10, text: 'MINE CLEARED', t: 0, col: [0.6, 1, 0.6] });
    this.showField(m);
    this.logEv(`mine at ${m.x},${m.y} cleared (${how})`);
  }

  // ---------- artillery ----------
  /** An unprompted barrage on a player: the director's last sighting if fresh, else roughly where they are. */
  private autoBarrage(): boolean {
    const w = this.w;
    const pl = this.live();
    if (!pl.length) return false;
    const k = w.ai?.known;
    if (k && w.frame - k.t < 8 * S) return this.startBarrage(k.x + 8, k.y + 8, false);
    const p = pl[Math.floor(rand() * pl.length)];
    const a = rand() * Math.PI * 2;
    const r = 8 + rand() * 16;
    return this.startBarrage(p.cx + Math.cos(a) * r, p.cy + Math.sin(a) * r, false);
  }

  /** Warning circles round (x, y), then the shells. False if one is under way or the spot is in a town. */
  startBarrage(x: number, y: number, spotted: boolean): boolean {
    const w = this.w;
    if (this.barrage || this.inTown(x, y, 8)) return false;
    const n = this.tier >= 1 ? 3 : 2;
    const pts: [number, number][] = [[x + (rand() - 0.5) * 8, y + (rand() - 0.5) * 8]];
    for (let tries = 0; pts.length < n && tries < 40; tries++) {
      const a = rand() * Math.PI * 2;
      const r = (spotted ? 14 : 18) + rand() * 12;
      const p: [number, number] = [x + Math.cos(a) * r, y + Math.sin(a) * r];
      if (pts.some(([px, py]) => Math.hypot(px - p[0], py - p[1]) < 16) || this.inTown(p[0], p[1], 8)) continue;
      pts.push(p);
    }
    const f = w.frame;
    const warn = this.tell(TR.artWarn);
    const call = this.call(ART_CALLS);
    this.barrage = {
      call, spotted,
      shells: pts.map(([px, py], i) => ({
        x: clamp(px, 4, w.pxW - 4), y: clamp(py, 4, w.pxH - 4), appear: f + i * TR.artStagger, at: f + i * TR.artStagger + warn, done: false,
      })),
    };
    this.stats.barrages++;
    this.radio(`${call}: FIRE MISSION, GRID ${Math.floor(x / 64)}-${Math.floor(y / 64)}. SHOT OUT.`);
    if (this.nearestPlayer(x, y).d < 90) w.note('INCOMING!', 'warn');
    this.logEv(`barrage ${call} x${pts.length} at ${Math.round(x)},${Math.round(y)}${spotted ? ' (spotted)' : ''}`);
    return true;
  }

  private updateBarrage(): void {
    const b = this.barrage;
    if (!b) return;
    const w = this.w;
    const f = w.frame;
    for (const s of b.shells) {
      if (s.done) continue;
      if (f === s.at - TR.artWhistle) w.snd('trick-whistle', s.x, 1);
      if (f >= s.at) {
        s.done = true;
        this.impact(s.x, s.y);
      }
    }
    if (b.shells.every((s) => s.done)) {
      this.barrage = null;
      this.lastBarrageEnd = f;
    }
  }

  private impact(x: number, y: number): void {
    const w = this.w;
    this.stats.shells++;
    this.blast(x, y, 2);
    w.snd('bigexplode', x, 1);
    for (const p of this.live()) {
      if (Math.hypot(p.cx - x, p.cy - y) <= TR.artR) {
        this.damage(p, TR.artDmg);
        this.stats.artHits++;
        this.logEv(`shell hit P${p.player + 1}`);
      }
    }
    const m = w.map;
    const r = TR.artBrickR;
    for (let cy = Math.floor((y - r) / 4); cy <= Math.floor((y + r) / 4); cy++) {
      for (let cx = Math.floor((x - r) / 4); cx <= Math.floor((x + r) / 4); cx++) {
        if (m.at(cx, cy) !== BRICK || Math.hypot(cx * 4 + 2 - x, cy * 4 + 2 - y) > r) continue;
        m.set(cx, cy, EMPTY);
        this.stats.bricks++;
        if (rand() < 0.5) w.debris(cx * 4 + 2, cy * 4 + 2, Math.floor(rand() * 4));
      }
    }
    for (const t of this.teams) if (t.alive && Math.hypot(t.x - x, t.y - y) <= TR.artR) this.killTeam(t, -1);
    for (const mm of this.mines) if (mm.alive && Math.hypot(mm.x - x, mm.y - y) <= TR.artR) { mm.alive = false; this.blast(mm.x, mm.y, 0); }
  }

  // ---------- convoys ----------
  private nearestNode(x: number, y: number, max: number): number {
    let best = -1;
    let bd = max;
    this.nodes.forEach(([nx, ny], i) => {
      const d = Math.hypot(nx - x, ny - y);
      if (d < bd) { bd = d; best = i; }
    });
    return best;
  }

  private ends(): End[] {
    const w = this.w;
    const out: End[] = [];
    for (const d of w.depots) {
      if (d.destroyed) continue;
      const n = this.nearestNode(d.cx - 8, d.cy - 8, 96);
      if (n >= 0) out.push({ name: d.name, node: n, depot: true });
    }
    for (const e of w.region?.exits ?? []) {
      const n = this.nearestNode(e[0], e[1], 32);
      if (n < 0) continue;
      const name = e[0] <= 16 ? 'WEST ROAD' : e[1] <= 16 ? 'NORTH ROAD' : e[0] >= w.pxW - 32 ? 'EAST ROAD' : 'SOUTH ROAD';
      out.push({ name, node: n, depot: false });
    }
    return out;
  }

  /** Shortest road distances from graph node a to every node (Dijkstra; the graph has a few hundred nodes). */
  private tree(a: number): { dist: Float64Array; prev: Int32Array } {
    const n = this.nodes.length;
    const dist = new Float64Array(n).fill(Infinity);
    const prev = new Int32Array(n).fill(-1);
    const done = new Uint8Array(n);
    dist[a] = 0;
    for (;;) {
      let u = -1;
      let bd = Infinity;
      for (let i = 0; i < n; i++) if (!done[i] && dist[i] < bd) { bd = dist[i]; u = i; }
      if (u < 0) break;
      done[u] = 1;
      for (const [v, len] of this.adj[u]) {
        if (dist[u] + len < dist[v]) { dist[v] = dist[u] + len; prev[v] = u; }
      }
    }
    return { dist, prev };
  }

  /** Shortest road route between two graph nodes, as tank top-left px points (axis-aligned legs). */
  route(a: number, b: number, t = this.tree(a)): [number, number][] | null {
    const { dist, prev } = t;
    if (!Number.isFinite(dist[b])) return null;
    const ids: number[] = [];
    for (let i = b; i >= 0; i = prev[i]) ids.push(i);
    ids.reverse();
    const pts: [number, number][] = [];
    for (const i of ids) {
      const p = this.nodes[i];
      const q = pts[pts.length - 1];
      if (q && q[0] !== p[0] && q[1] !== p[1]) pts.push([p[0], q[1]]); // never happens on a real graph: keep legs straight
      pts.push([p[0], p[1]]);
    }
    return pts;
  }

  /** Start a supply convoy between two road ends (depots, exits) out of the players' sight. */
  launchConvoy(force = false): Convoy | null {
    const w = this.w;
    if (this.convoy || this.nodes.length < 2) return null;
    const ends = this.ends();
    const pl = this.live();
    type Opt = { a: End; b: End; pts: [number, number][]; len: number; near: number };
    const opts: Opt[] = [];
    for (const a of ends) {
      const [ax, ay] = this.nodes[a.node];
      const da = pl.length ? Math.min(...pl.map((p) => Math.hypot(p.x - ax, p.y - ay))) : 1e9;
      if (da < 220 && !force) continue;
      const tree = this.tree(a.node);
      for (const b of ends) {
        if (a === b || a.node === b.node || (!a.depot && !b.depot && rand() < 0.5)) continue;
        const pts = this.route(a.node, b.node, tree);
        if (!pts || pts.length < 2) continue;
        let len = 0;
        let near = 1e9;
        for (let i = 1; i < pts.length; i++) len += Math.abs(pts[i][0] - pts[i - 1][0]) + Math.abs(pts[i][1] - pts[i - 1][1]);
        for (const [x, y] of pts) for (const p of pl) near = Math.min(near, Math.hypot(p.x - x, p.y - y));
        if (len >= 320) opts.push({ a, b, pts, len, near });
      }
    }
    if (!opts.length) return null;
    const close = opts.filter((o) => o.near < 320);
    const pool = close.length ? close : opts;
    const o = pool[Math.floor(rand() * pool.length)];
    return this.startConvoy(o.pts, o.a.name, o.b.name);
  }

  /** A convoy along the given points (tank top-left px, axis-aligned legs). */
  startConvoy(pts: [number, number][], from: string, to: string): Convoy {
    const cum = [0];
    for (let i = 1; i < pts.length; i++) cum.push(cum[i - 1] + Math.abs(pts[i][0] - pts[i - 1][0]) + Math.abs(pts[i][1] - pts[i - 1][1]));
    const nTrucks = this.tier === 0 ? 2 + (rand() < 0.5 ? 1 : 0) : 3 + (rand() < 0.5 ? 1 : 0);
    const vehicles: Vehicle[] = [];
    vehicles.push({ truck: false, off: 0, x: pts[0][0], y: pts[0][1], dir: UP, alive: true, in: false, tank: null, anim: 0 });
    for (let i = 0; i < nTrucks; i++) vehicles.push({ truck: true, off: (i + 1) * TR.convoySpacing, x: pts[0][0], y: pts[0][1], dir: UP, alive: true, in: false, tank: null, anim: 0 });
    const call = this.call(CONVOY_CALLS);
    const cv: Convoy = { call, from, to, pts, cum, len: cum[cum.length - 1], s: 0, vehicles, hit: false, stall: 0, alert: 0, react: 0 };
    this.convoy = cv;
    this.stats.convoys++;
    this.radio(`${call}: SUPPLY RUN LEAVING ${from} FOR ${to}. ${nTrucks} TRUCKS.`);
    this.w.snd('column', pts[0][0] + 8, 0.6);
    this.logEv(`convoy ${call} ${from} -> ${to}, ${nTrucks} trucks, ${cv.len} px`);
    return cv;
  }

  posAt(cv: Convoy, s: number): [number, number, number] {
    s = clamp(s, 0, cv.len);
    let i = 0;
    while (i < cv.cum.length - 2 && cv.cum[i + 1] < s) i++;
    const a = cv.pts[i];
    const b = cv.pts[i + 1] ?? a;
    const seg = cv.cum[i + 1] - cv.cum[i] || 1;
    const k = (s - cv.cum[i]) / seg;
    const dir = b[0] > a[0] ? RIGHT : b[0] < a[0] ? LEFT : b[1] > a[1] ? DOWN : UP;
    return [a[0] + (b[0] - a[0]) * k, a[1] + (b[1] - a[1]) * k, dir];
  }

  private escortType(): number {
    if (this.tier >= 3 && rand() < 0.5) return 3;
    if (this.tier >= 1 && rand() < 0.5) return 2;
    return 0;
  }

  /** The direction from the escort to a player in its line within 150 px (clear of steel and brick), or -1. */
  private escortAim(e: Tank): number {
    for (const p of this.live()) {
      const dx = p.cx - e.cx;
      const dy = p.cy - e.cy;
      if (Math.abs(dx) + Math.abs(dy) > 150) continue;
      let d = -1;
      if (Math.abs(dx) < 7) d = dy < 0 ? UP : DOWN;
      else if (Math.abs(dy) < 7) d = dx < 0 ? LEFT : RIGHT;
      if (d < 0 || this.blockedLine(e.cx + DX[d] * 8, e.cy + DY[d] * 8, p.cx, p.cy)) continue;
      return d;
    }
    return -1;
  }

  private updateConvoy(held: boolean): void {
    const cv = this.convoy!;
    const w = this.w;
    const pl = this.live();
    if (cv.alert > 0) cv.alert--;
    for (const v of cv.vehicles) {
      if (!v.alive || !v.in) continue;
      if (pl.some((p) => Math.hypot(p.cx - v.x - 8, p.cy - v.y - 8) < 100)) cv.alert = Math.max(cv.alert, 120);
    }
    let halt = held;
    const esc = cv.vehicles.find((v) => !v.truck);
    let aimDir = -1;
    if (esc?.tank && esc.alive) {
      const e = esc.tank;
      if (!e.alive) {
        esc.alive = false;
        this.owned.delete(e);
        cv.alert = 240;
        this.radio(`${cv.call}: ESCORT IS DOWN. KEEP DRIVING.`);
        this.logEv(`convoy ${cv.call} escort destroyed`);
      } else if (!held && cv.alert > 0 && e.stun === 0) {
        aimDir = this.escortAim(e);
        if (aimDir >= 0) {
          halt = true;
          e.dir = aimDir;
          if (cv.react > 0) cv.react--;
          else if (w.fire(e)) this.stats.escortShots++;
        } else {
          cv.react = this.tell(30);
        }
      }
    }
    const escAlive = !!esc?.alive;
    const step = TR.convoySpeed * (escAlive ? 1 : cv.alert > 0 ? 1.4 : 1);
    if (!halt) {
      for (const v of cv.vehicles) {
        if (!v.alive) continue;
        const s = cv.s + step - v.off;
        if (s < 0) continue;
        const [nx, ny] = this.posAt(cv, s);
        const m = v.truck ? 3 : 0;
        for (const t of w.allTanks()) {
          if (!t.alive || t.spawn > 0 || t === v.tank || this.owned.has(t)) continue;
          if (!t.isPlayer && cv.stall > 3 * S) continue; // a parked tank of theirs: squeeze past after 3 s
          const ov = (ax: number, ay: number) => ax + m < t.x + 16 && ax + 16 - m > t.x && ay + m < t.y + 16 && ay + 16 - m > t.y;
          // never drive into a player (a tank of theirs already overlapping is left to sort itself out)
          if (ov(nx, ny) && (t.isPlayer || !ov(v.x, v.y))) { halt = true; break; }
        }
        if (halt) break;
      }
    }
    if (halt) cv.stall++;
    else {
      cv.s += step;
      cv.stall = 0;
    }
    for (const v of cv.vehicles) {
      if (!v.alive) continue;
      const s = cv.s - v.off;
      if (s < 0) continue;
      const [x, y, dir] = this.posAt(cv, s);
      if (!v.in) {
        v.in = true;
        if (!v.truck) {
          const e = new Tank();
          e.etype = this.escortType();
          e.hp = ENEMY[e.etype].hp;
          e.spawn = 0;
          e.x = x;
          e.y = y;
          e.dir = dir;
          e.persona = 0;
          w.enemies.push(e);
          this.owned.add(e);
          v.tank = e;
        }
      }
      const moved = Math.abs(x - v.x) + Math.abs(y - v.y);
      v.x = x;
      v.y = y;
      v.anim += moved;
      if (v.tank) {
        const e = v.tank;
        e.x = x;
        e.y = y;
        if (aimDir < 0) e.dir = dir;
        e.dist += moved;
        e.blocked = moved === 0;
        if (moved > 0) w.tracks(e, moved);
      } else {
        v.dir = dir;
      }
    }
    // a player tank ramming a truck wrecks it
    for (const v of cv.vehicles) {
      if (!v.truck || !v.alive || !v.in) continue;
      const p = pl.find((t) => Math.abs(t.cx - v.x - 8) < 12 && Math.abs(t.cy - v.y - 8) < 12);
      if (p) this.killTruck(cv, v, p.player);
    }
    const last = cv.vehicles[cv.vehicles.length - 1].off;
    const gone = cv.vehicles.every((v) => !v.alive);
    if (cv.s - last >= cv.len || gone || cv.stall > 40 * S) this.endConvoy(cv, !gone && cv.s - last >= cv.len);
  }

  private endConvoy(cv: Convoy, arrived: boolean): void {
    for (const v of cv.vehicles) {
      if (v.tank) {
        if (v.tank.alive) v.tank.alive = false; // drives into the depot / off the map
        this.owned.delete(v.tank);
      }
      v.alive = false;
    }
    if (arrived) {
      this.stats.convoysArrived++;
      this.radio(`${cv.call}: DELIVERED TO ${cv.to}.`);
    }
    this.logEv(`convoy ${cv.call} ${arrived ? 'arrived' : 'ended'}`);
    this.convoy = null;
  }

  private killTruck(cv: Convoy, v: Vehicle, pi: number): void {
    const w = this.w;
    v.alive = false;
    this.stats.trucksKilled++;
    const x = v.x + 8;
    const y = v.y + 8;
    this.blast(x, y, 1);
    w.snd('explode', x, 1);
    this.wrecks.push({ x: v.x, y: v.y, dir: v.dir, t: 0 });
    w.pickups.push({ x: x + 6, y, kind: 'scrap', amount: TR.truckScrap, t: 0 });
    if (rand() < TR.truckPart) w.pickups.push({ x: x - 6, y: y + 4, kind: 'part', amount: 1, t: 0 });
    if (!cv.hit) {
      cv.hit = true;
      w.note('CONVOY HIT', 'power');
      this.radio(`${cv.call}: CONVOY UNDER FIRE. TRUCK BURNING.`);
    }
    cv.alert = 240;
    if (pi >= 0) w.addVetXp(pi, 0.2);
    this.logEv(`truck of ${cv.call} destroyed by P${pi + 1}`);
  }

  private updateWrecks(): void {
    if (!this.wrecks.length) return;
    const w = this.w;
    for (const k of this.wrecks) {
      k.t++;
      if (k.t < 8 * S && w.frame % 7 === 0) {
        w.parts.push({
          x: k.x + 8 + (rand() - 0.5) * 8, y: k.y + 8 + (rand() - 0.5) * 6, z: 8, vx: (rand() - 0.5) * 0.2, vy: -0.22 - rand() * 0.2, vz: 0,
          life: 0, max: 90, col: [0.12, 0.11, 0.1], kind: 2, r: 3.5 + rand() * 2,
        });
      }
      if (k.t === 60 * S) w.decals.push({ k: 1, x: k.x + 8, y: k.y + 8, r: 7, col: [0.03, 0.028, 0.025], a: 0.6 });
    }
    this.wrecks = this.wrecks.filter((k) => k.t <= 60 * S);
  }

  // ---------- drawing ----------
  /**
   * Attack-drone warnings, unlit on the top layer (r.topRect, after grading) so night, rain and smoke can't hide them.
   * Approaching within droneWarnR: a red bracket round it, or a pulsing arrow at the screen edge if it is off screen.
   * Hovering to drop: a blinking ring on the ground round the tank (blinks faster as it fills), with an inner ring
   * closing in on the tank until the drop.
   */
  private drawDroneWarn(r: Renderer, ox: number, oy: number): void {
    const w = this.w;
    const f = w.frame;
    const pen = new OvPen();
    const RED: V3 = [1, 0.22, 0.14];
    const HOT: V3 = [1, 0.8, 0.45];
    let rim = 0.85;
    for (const d of this.drones) {
      if (d.kind !== 'attack') continue;
      const p = w.players[d.pi];
      if (!p || !p.alive) continue;
      if (d.phase === 'in') {
        const dist = Math.hypot(p.cx - d.x, p.cy - d.y);
        if (dist > TR.droneWarnR) continue;
        const pulse = (f >> 3) & 1;
        const a = pulse ? 1 : 0.55;
        const sx = ox + d.x;
        const sy = oy + d.y - TR.droneLift * Math.max(0, d.z / 16);
        if (sx >= -2 && sy >= -2 && sx <= r.nw + 2 && sy <= r.nh + 2) {
          // corner brackets that breathe in and out
          const h = 10 + pulse;
          const x0 = Math.round(sx) - h;
          const y0 = Math.round(sy) - h;
          const x1 = Math.round(sx) + h;
          const y1 = Math.round(sy) + h;
          for (let i = 0; i < 4; i++) {
            pen.dot(x0 + i, y0, RED, a); pen.dot(x0, y0 + i, RED, a);
            pen.dot(x1 - i, y0, RED, a); pen.dot(x1, y0 + i, RED, a);
            pen.dot(x0 + i, y1, RED, a); pen.dot(x0, y1 - i, RED, a);
            pen.dot(x1 - i, y1, RED, a); pen.dot(x1, y1 - i, RED, a);
          }
        } else {
          // an arrow on the screen edge, pointing at it, bigger the closer it is
          const cx = r.nw / 2;
          const cy = r.nh / 2;
          const dx = sx - cx;
          const dy = sy - cy;
          const inset = 14;
          const k = Math.min((cx - inset) / Math.max(1e-3, Math.abs(dx)), (cy - inset) / Math.max(1e-3, Math.abs(dy)));
          const ex = cx + dx * k;
          const ey = cy + dy * k;
          const len = Math.hypot(dx, dy) || 1;
          const ux = dx / len;
          const uy = dy / len;
          // a filled triangle, tip at the edge, rasterised at any angle; its rim pixels are bright
          const len2 = 9 + (dist < 100 ? 2 : 0) + pulse;
          const tx = ex;
          const ty = ey;
          for (let j = -len2 - 1; j <= len2 + 1; j++) {
            for (let i = -len2 - 1; i <= len2 + 1; i++) {
              const px = Math.round(tx) + i;
              const py = Math.round(ty) + j;
              const along = -((px - tx) * ux + (py - ty) * uy);
              const across = Math.abs(-(px - tx) * uy + (py - ty) * ux);
              const wd = along * 0.55 + 0.4;
              if (along < -0.5 || along > len2 || across > wd) continue;
              pen.dot(px, py, along < 1.5 || across > wd - 0.9 ? HOT : RED, a);
            }
          }
        }
      } else if (d.phase === 'hover') {
        const k = clamp(d.hold / Math.max(1, this.tell(TR.droneHover)), 0, 1);
        const period = k < 0.4 ? 12 : k < 0.75 ? 8 : 4;
        const lit = f % period < period / 2;
        const a = lit ? 1 : 0.3;
        const cx = ox + p.cx;
        const cy = oy + p.cy;
        for (const [qx, qy] of ring(15)) pen.dot(cx + qx, cy + qy, RED, a);
        // the inner ring closes in as the drop nears
        const inner = Math.round(15 - 10 * k);
        for (const [qx, qy] of ring(inner)) pen.dot(cx + qx, cy + qy, lit ? HOT : RED, a);
        // crosshair ticks outside the ring
        for (const [qx, qy, qw, qh] of [[-19, 0, 3, 1], [17, 0, 3, 1], [0, -19, 1, 3], [0, 17, 1, 3]]) pen.rect(cx + qx, cy + qy, qw, qh, RED, a);
        rim = 0.9;
      }
    }
    pen.flush(r, rim);
  }

  draw(r: Renderer, ox: number, oy: number, time: number): void {
    if (!this.on || !this.inited) return;
    const w = this.w;
    const S2 = r.atlas.S;
    const f = w.frame;
    const head = HEAD[w.env] ?? 1;
    const rev = this.revealAll();
    const on = (sx: number, sy: number, m: number) => sx > -m && sy > -m && sx < r.nw + m && sy < r.nh + m;
    const pl = this.live();
    const nightEyes = w.perks.has('night-eyes');

    // disturbed earth over every mine (persistent ground decals; again if the renderer cleared them)
    if (r.clearDecals) for (const m of this.mines) m.decal = false;
    for (const m of this.mines) {
      if (m.decal || !m.alive) continue;
      m.decal = true;
      const sx = ox + m.x;
      const sy = oy + m.y;
      // a patch of freshly turned soil, darker than the field, with a couple of pale clods of spoil beside it
      const D: V3 = [0.085, 0.06, 0.04];
      r.decalRect(sx - 2, sy - 1, 5, 3, D, 0.4);
      r.decalRect(sx - 1, sy - 2, 3, 1, D, 0.3);
      r.decalRect(sx - 1, sy + 2, 3, 1, D, 0.3);
      const h = (m.x * 31 + m.y * 17) % 4;
      const L: V3 = [0.46, 0.38, 0.27];
      r.decalRect(sx + (h & 1 ? 3 : -4), sy + (h & 2 ? 1 : -2), 1, 1, L, 0.5);
      r.decalRect(sx + (h & 1 ? -3 : 3), sy + (h & 2 ? -2 : 2), 1, 1, L, 0.4);
    }
    for (const m of this.mines) {
      if (!m.alive) continue;
      const sx = ox + m.x;
      const sy = oy + m.y;
      if (!on(sx, sy, 8)) continue;
      const near = nightEyes && pl.some((p) => Math.hypot(p.cx - m.x, p.cy - m.y) <= TR.nightEyesR);
      if (!(rev || m.shown || near)) continue;
      r.spr(S2.trkMine, Math.round(sx) - 3, Math.round(sy) - 3, 0, WHITE, MAT_METAL, 0, 1);
      const blink = (f >> 4) & 1;
      r.glow(sx, sy, 1.6, [1, 0.2, 0.12], blink ? 2.2 : 0.7);
      // an unlit warning diamond round it, so a marked mine reads at night too
      const mx = Math.round(sx);
      const my = Math.round(sy);
      const ma = blink ? 0.85 : 0.45;
      const mc: V3 = [1, 0.3, 0.2];
      for (const [qx, qy] of [[0, -5], [5, 0], [0, 5], [-5, 0], [-3, -3], [3, -3], [3, 3], [-3, 3]]) r.ovRect(mx + qx, my + qy, 1, 1, mc, ma);
    }

    // burnt-out trucks
    for (const k of this.wrecks) {
      const sx = ox + k.x;
      const sy = oy + k.y;
      if (!on(sx, sy, 24)) continue;
      r.spr(S2.trkWreck, Math.round(sx), Math.round(sy), k.dir, WHITE, MAT_STD, 0, 1);
      if (k.t < 8 * S) {
        const fl = 0.65 + 0.35 * Math.sin(time * 17 + k.x) * Math.sin(time * 6.1 + k.y);
        const kk = 1 - k.t / (8 * S);
        r.light(sx + 8, sy + 7, 12, 50, 0.55 * fl * kk, 0.25 * fl * kk, 0.06 * fl * kk, true);
        r.glow(sx + 8, sy + 8, 2.2, [1, 0.55, 0.15], 0.8 * fl * kk);
      }
    }

    // convoy trucks
    const cv = this.convoy;
    if (cv) {
      for (const v of cv.vehicles) {
        if (!v.truck || !v.alive || !v.in) continue;
        const sx = Math.round(ox + v.x);
        const sy = Math.round(oy + v.y);
        if (!on(sx, sy, 110)) continue;
        r.spr(S2[`trkTruck${Math.floor(v.anim / 3) & 1}`], sx, sy, v.dir, WHITE, MAT_STD, 0, 1);
        const k = head * 0.6;
        r.spot(sx + 8 + DX[v.dir] * 8, sy + 8 + DY[v.dir] * 8, 5, 70, 1.0 * k, 0.85 * k, 0.6 * k, true, DX[v.dir], DY[v.dir], 0.8, 0.95);
      }
    }

    // AT teams: hidden until they fire, recon shows them, or a tank is right on top of them; the glint is the tell
    r.top = true;
    for (const t of this.teams) {
      if (!t.alive) continue;
      const sx = ox + t.x;
      const sy = oy + t.y;
      if (!on(sx, sy, 20)) continue;
      const near = pl.some((p) => Math.hypot(p.cx - t.x, p.cy - t.y) <= TR.teamRevealR);
      if (rev || t.shown || near) {
        r.spr(S2.trkTeam, Math.round(sx) - 5, Math.round(sy) - 5, t.dir, WHITE, MAT_STD, 0, 1);
        if (rev && !t.shown) {
          // recon marker: red corner brackets
          const c: V3 = [1, 0.3, 0.2];
          const x0 = Math.round(sx) - 7;
          const y0 = Math.round(sy) - 7;
          for (const [bx, by, bw, bh] of [[0, 0, 3, 1], [0, 0, 1, 3], [12, 0, 3, 1], [14, 0, 1, 3], [0, 14, 3, 1], [0, 12, 1, 3], [12, 14, 3, 1], [14, 12, 1, 3]]) {
            r.ovRect(x0 + bx, y0 + by, bw, bh, c, 0.85);
          }
        }
      }
      if (t.tell > 0) {
        const k = 1 - t.tell / Math.max(1, this.tell(TR.teamTell));
        const fl = (f >> 1) & 1 ? 1 : 0.55;
        const gx = sx + DX[t.dir] * 2;
        const gy = sy + DY[t.dir] * 2 - 1;
        r.fxRect(Math.round(gx) - 2, Math.round(gy), 5, 1, [1, 1, 0.85], 2.2 * fl);
        r.fxRect(Math.round(gx), Math.round(gy) - 2, 1, 5, [1, 1, 0.85], 2.2 * fl);
        r.glow(gx, gy, 3 + k * 2, [1, 0.95, 0.8], 1.6 * fl);
        r.light(gx, gy, 6, 26, 0.5 * fl, 0.48 * fl, 0.4 * fl, false);
      }
    }

    // drones, their shadows and their lights
    for (const d of this.drones) {
      const sx = ox + d.x;
      const sy = oy + d.y;
      if (!on(sx, sy, 30)) continue;
      const lift = TR.droneLift * Math.max(0, d.z / 16) + Math.sin(time * 6 + d.id) * 0.7;
      const hover = d.phase === 'hover' ? d.hold / Math.max(1, this.tell(TR.droneHover)) : 0;
      // a crisp pixel shadow on the ground (over a tank too): body and four rotors, darker as it settles to drop
      const sa = (0.6 + 0.3 * hover) * Math.min(1, d.z / 8);
      const hx = Math.round(sx);
      const hy = Math.round(sy) + 1;
      r.ovRect(hx - 1, hy - 1, 3, 3, [0, 0, 0], sa);
      for (const [qx, qy] of [[-4, -4], [2, -4], [-4, 2], [2, 2]]) r.ovRect(hx + qx, hy + qy, 3, 3, [0, 0, 0], sa * 0.8);
      const fr = d.phase === 'fall' ? (f >> 3) & 1 : (f >> 1) & 1;
      r.spr(S2[`trkDrone${fr}`], Math.round(sx - 6.5), Math.round(sy - lift - 6.5), 0, WHITE, MAT_METAL, 0.3, 1);
      const ly = sy - lift - 2.5;
      if (d.phase === 'jam' || d.phase === 'fall') {
        if ((f >> 2) & 1) r.glow(sx, ly, 2, [0.6, 0.85, 1], 1.4);
      } else if (d.kind === 'spot') {
        const strobe = f % 40 < 4 ? 1 : 0;
        r.glow(sx, ly, 2.5, [0.9, 0.95, 1], 0.5 + 2.5 * strobe);
        r.light(sx, ly, 14, 30, 0.6 * strobe, 0.65 * strobe, 0.7 * strobe, false);
      } else {
        const period = d.phase === 'hover' ? 6 : 24;
        const on2 = f % period < period / 2 ? 1 : 0.25;
        r.glow(sx, ly, 1.6, [1, 0.15, 0.1], 2.0 * on2);
        r.light(sx, ly, 14, 30, 0.9 * on2, 0.08 * on2, 0.05 * on2, false);
        if (d.phase === 'hover') {
          // the aim: a red dot on the target under the drone
          r.glow(sx, sy, 2.5 + hover * 2, [1, 0.12, 0.08], 0.8 + hover * 1.6);
        }
      }
    }
    this.drawDroneWarn(r, ox, oy);
    for (const b of this.bombs) {
      const sx = ox + b.x;
      const sy = oy + b.y;
      if (!on(sx, sy, 20)) continue;
      const k = b.t / TR.droneFall;
      r.smoke(sx, sy, 1.5, [0, 0, 0], 0.4);
      r.rectG(Math.round(sx) - 1, Math.round(sy - TR.droneLift * (1 - k)) - 1, 2, 2, MAT_METAL, [0.3, 0.34, 0.24], 0.2);
    }
    r.top = false;

    // rockets
    for (const rk of this.rockets) {
      const sx = ox + rk.x;
      const sy = oy + rk.y;
      if (!on(sx, sy, 20)) continue;
      r.glow(sx, sy, 3, [1, 0.75, 0.35], 2.6);
      r.glow(sx - rk.vx * 1.5, sy - rk.vy * 1.5, 2, [1, 0.5, 0.2], 1.4);
      r.light(sx, sy, 8, 34, 1.0, 0.6, 0.25, true);
    }

    // artillery warning circles: grow to the danger radius, blink faster as the shell nears; unlit so they read at night
    const b = this.barrage;
    if (b) {
      for (const s of b.shells) {
        if (s.done || f < s.appear) continue;
        const k = clamp((f - s.appear) / Math.max(1, s.at - s.appear), 0, 1);
        const sx = ox + s.x;
        const sy = oy + s.y;
        if (!on(sx, sy, 20)) continue;
        const rad = 5 + (TR.artR - 5) * Math.min(1, k * 1.6);
        const period = k < 0.5 ? 16 : k < 0.8 ? 8 : 4;
        const lit = (f - s.appear) % period < period / 2;
        const col: V3 = [1, 0.25 + 0.2 * (1 - k), 0.12];
        const a = lit ? 0.95 : 0.4;
        const n = 32;
        for (let i = 0; i < n; i++) {
          if (!lit && i & 1) continue;
          const ang = (i / n) * Math.PI * 2 + k * 0.6;
          r.ovRect(Math.round(sx + Math.cos(ang) * rad), Math.round(sy + Math.sin(ang) * rad), 1, 1, col, a);
        }
        r.ovRect(Math.round(sx) - 2, Math.round(sy), 5, 1, col, a * 0.8);
        r.ovRect(Math.round(sx), Math.round(sy) - 2, 1, 5, col, a * 0.8);
        r.glow(sx, sy, rad, [1, 0.2, 0.1], 0.05 + 0.12 * k * (lit ? 1 : 0.5));
      }
    }
  }
}
