import {
  BRICK, DOWN, DX, DY, E_SPAWN, EAGLE_X, EAGLE_Y, EMPTY, ENEMY, ICE, LEFT, NN, P_SPAWN, PLAYER_SPEED, PW, RIGHT,
  STEEL, TREES, UP, WATER, PW_NAMES,
} from './constants';
import { AiDirector } from './ai';
import { Abilities } from './abilities';
import { Tricks } from './tricks'; // campaign AI hook
import { Boss } from './boss'; // Phase 4 boss hook
import type { RegionBoss } from './bosses/types'; // Phase 4 boss hook
import type { MapEvents } from './events'; // Phase 5 events hook
import type { ArenaHook } from './arena'; // ?arena= test map
import { FORT_CELLS, Flow, GameMap } from './map';
import { partById, rollPart } from './parts'; // Phase 2 run loop: part pickups and depot rewards
import type { Depot, RegionSpec } from './region';
import { ENV_LABEL, enemyQueue, envFor, stageDef, type EnvName, type StageDef } from './stages';

export type { RegionSpec } from './region';

const EPS = 1e-4;
const rand = Math.random;
const randInt = (n: number) => Math.floor(rand() * n);
const overlap = (ax: number, ay: number, aw: number, ah: number, bx: number, by: number, bw: number, bh: number) =>
  ax < bx + bw - EPS && ax + aw > bx + EPS && ay < by + bh - EPS && ay + ah > by + EPS;

export type RGB = [number, number, number];

export interface PState {
  lives: number;
  score: number;
  level: number;
  hover: boolean;
  gun: boolean;
  ricochet: boolean;
  kills: number[];
  nextLife: number;
  out: boolean;
  /** campaign: veterancy kept across respawns (0-3 chevrons, progress 0..1 to the next) */
  vet: number;
  vetXp: number;
}

export function newPState(): PState {
  return { lives: 2, score: 0, level: 0, hover: false, gun: false, ricochet: false, kills: [0, 0, 0, 0], nextLife: 20000, out: false, vet: 0, vetXp: 0 };
}

// ---------- campaign tuning (region mode) ----------
export const ARMOUR_MAX = 10;
/** Armour lost per enemy shell, by enemy type (basic, fast, power, armor): ~4 average hits to knock a tank out. */
export const ENEMY_DMG = [2, 2, 3, 3];
// (2026-11-18 scrap economy, a playtest ended the campaign with thousands: wreck scrap was 10, 12, 15, 25; towns 40, depots
// 60, bosses 500, boss weak points 25. Income is about a fifth of that now, so a run that repairs and crafts charges as
// it goes ends with a few hundred, and cannot buy every charge it would like.)
/** Scrap dropped by a destroyed enemy, by type (before +-20% randomness). */
const SCRAP_DROP = [2, 2, 3, 4];
/** Campaign enemy mix by region (stage - 1; the last row past the list): shares of armour, power and fast tanks, the
 * rest basic. The first regions are mostly basic tanks while BABUSYA is bare (2026-11-18 curve; all were 0.15, 0.2, 0.2). */
const REGION_MIX: [number, number, number][] = [[0.05, 0.1, 0.2], [0.05, 0.12, 0.2], [0.08, 0.12, 0.2], [0.15, 0.2, 0.2]];
const PART_CHANCE = 0.1;
const PICKUP_LIFE = 60 * 30;
const PICKUP_BLINK = 60 * 5;
const VET_XP = [0.25, 0.3, 0.4, 0.5];
export const FREE_RADIUS = 24;
const FREE_FRAMES = 60 * 6;
const FREE_DECAY = 1 / (60 * 20);
export const FREE_SCRAP = 10; // was 40 (the town's patch charge stays)
export const PATCH_SCRAP = 15;
export const PATCH_ARMOUR = 3;
/** Frames after a field patch before that player can patch again (2026-11-18: 15 s; per player in co-op). */
export const PATCH_COOLDOWN = 60 * 15;
const LOW_ARMOUR = 3;

const RADIO_WHO = 'SPANNER';
/** Radio lines after a town is freed ({T} = the town's name). Uppercase, only characters the pixel font has. */
const RADIO_FREED = [
  '{T} IS OURS. THE MAYOR WANTS TO SHAKE YOUR HAND. I TOLD HIM YOU ARE BUSY.',
  '{T} REPORTS IN. THEY BAKED SOMETHING. DO NOT ASK WHAT IS IN IT.',
  'FLAG IS UP AT {T}. THE OLD LADY ON THE CORNER SAYS YOU ARE LATE.',
  '{T} IS CLEAR. I HAVE LOGGED IT UNDER GOOD NEWS. IT IS A SHORT FILE.',
  'NICE DRIVING. {T} HAS FOUND A KETTLE AND IS OFFERING TEA. IT IS DIESEL TEA.',
  '{T} FREE. THEY WANT TO NAME A STREET AFTER YOU. I SUGGESTED A POTHOLE.',
  'ONE MORE ON THE MAP. {T} SENDS THANKS AND A BOX OF WRENCHES. I KEPT THE BEST ONE.',
  '{T} IS BACK. PATCH KIT IS ON ITS WAY. TRY TO RETURN THE TANK WITH THE SAME NUMBER OF HOLES.',
];

// ---------- Phase 2 run loop (campaign): depot targets, workshops ----------
/** Hits (player shells) to destroy a depot's target, and its rewards. */
export const DEPOT_HP = 6;
export const DEPOT_SCRAP = 30; // was 60
/** A workshop opens at a freed town's flag only with no enemy this close (px). */
export const WORKSHOP_CLEAR = 160;
/** Frames a destroyed depot burns with flames before it only smoulders. */
export const DEPOT_BURN = 60 * 25;
/** Radio lines after a depot goes up ({D} = the depot's name). */
const RADIO_DEPOT = [
  '{D} IS GONE. THEIR TANKS WILL BE WALKING TO THE FRONT NOW. GOOD EXERCISE.',
  'THAT WAS {D}. I FOUND A SPARE PART IN THE ASHES. IT IS ONLY A LITTLE ON FIRE.',
  '{D} BURNS NICELY. SOMEONE OVER THERE IS WRITING A VERY LONG REPORT.',
  'SCRATCH {D}. HQ CAN SEE THE SMOKE. THEY SAY THANK YOU AND STOP SHOWING OFF.',
  '{D} IS NOW A CRATER. I HAVE MARKED IT ON THE MAP AS A NEW LAKE.',
];

/** A region depot's target at play time: fuel tanks or an ammo stack, 16 x 16 px at the depot's centre. */
export interface DepotState {
  name: string;
  rect: [number, number, number, number];
  cx: number;
  cy: number;
  kind: 'fuel' | 'ammo';
  hp: number;
  max: number;
  destroyed: boolean;
  /** frames since it was destroyed (-1 while standing) */
  burnT: number;
  /** frames of hit flash left */
  hitT: number;
}

function newDepot(d: Depot): DepotState {
  return {
    name: d.name, rect: [d.rect[0], d.rect[1], d.rect[2], d.rect[3]], cx: d.cx, cy: d.cy,
    kind: d.name.startsWith('AMMO') ? 'ammo' : 'fuel', hp: DEPOT_HP, max: DEPOT_HP, destroyed: false, burnT: -1, hitT: 0,
  };
}
// ---------- end Phase 2 run loop block ----------

export interface PInput {
  dir: number; // -1 = none
  fire: boolean;
  /** campaign: ability key pressed this update (1-4 = drone, ambush, recon, patch), 0 = none */
  ability?: number;
  /** campaign: ability key held this update (1-3), 0 = none (aiming the drone etc.) */
  abilityHeld?: number;
}

// ---------- campaign (region mode) state; see CAMPAIGN.md ----------
/** Something to drive over and collect. */
export interface Pickup { x: number; y: number; kind: 'scrap' | 'part'; amount: number; t: number }
/** A region town at play time. */
export interface TownState { name: string; rect: [number, number, number, number]; cx: number; cy: number; freed: boolean; progress: number }
/** Hit-stop frames (60 per second): a tank kill by a player, a boss part breaking (app.ts watches the parts). */
export const HITSTOP_KILL = 2;
export const HITSTOP_BOSS = 4;
/**
 * A line of radio chatter for the HUD's radio panel. amb = ambient enemy chatter (garrison and column intercepts,
 * patrols, convoys): the HUD may drop it when the queue fills, and HQ, boss and crew lines jump ahead of it.
 */
export interface RadioMsg { who: string; text: string; amb?: boolean }

export class Tank {
  x = 0;
  y = 0;
  dir = UP;
  player = -1;
  etype = 0;
  hp = 1;
  bonus = false;
  alive = true;
  spawn = 0;
  shield = 0;
  frozen = 0;
  stun = 0;
  cooldown = 0;
  /** campaign: frame when the gun is loaded again (shots are limited by reload time, not shells in flight) */
  readyAt = 0;
  /** campaign: reload time multiplier from upgrades (barrel/autoloader parts, gunner perk); lower = faster */
  reloadMul = 1;
  /** campaign: move speed multiplier from parts (engine, tracks) */
  speedMul = 1;
  /** campaign: barrel firepower from parts: 1+ = an extra point of damage to armoured tanks, 2+ = shells break steel */
  firepower = 0;
  /** campaign: part id per slot fitted by the run (save.ts fitTank); tricks.ts reads the jammer and plough */
  fitted: Partial<Record<string, string>> = {};
  dist = 0;
  trackAcc = 0;
  level = 0;
  hover = false;
  gun = false;
  ricochet = false;
  slide = 0;
  moving = false;
  blocked = false;
  stuck = 0;
  aiFire = 40;
  persona = 0; // 0 wanderer, 1 raider (base), 2 hunter (players)
  flash = 0;
  recoil = 0;
  /** campaign players: hits left before the tank is knocked out (arcade: unused, one hit kills) */
  armour = 0;
  armourMax = 0;
  /** campaign players: veterancy 0-3 chevrons and progress to the next (0..1) */
  vet = 0;
  vetXp = 0;
  get cx(): number { return this.x + 8; }
  get cy(): number { return this.y + 8; }
  get isPlayer(): boolean { return this.player >= 0; }
}

export class Bullet {
  alive = true;
  /** flight direction, a unit vector: DX/DY of `dir` for every tank shell; boss guns can set any angle with aim() */
  ux: number;
  uy: number;
  /** a free-angle (boss) shell: flies along (ux, uy); `dir` is then the nearest quarter (debris, hit sides) */
  free = false;
  constructor(
    public x: number, public y: number, public dir: number, public speed: number,
    public owner: Tank, public power: boolean, public trees: boolean, public bounces: number,
  ) {
    this.ux = DX[dir];
    this.uy = DY[dir];
  }

  /** Point the shell along (vx, vy), any angle (boss guns). */
  aim(vx: number, vy: number): this {
    const l = Math.hypot(vx, vy) || 1;
    this.ux = vx / l;
    this.uy = vy / l;
    this.dir = Math.abs(this.ux) >= Math.abs(this.uy) ? (this.ux < 0 ? LEFT : RIGHT) : this.uy < 0 ? UP : DOWN;
    this.free = Math.abs(this.ux) > 1e-6 && Math.abs(this.uy) > 1e-6;
    if (!this.free) {
      this.ux = DX[this.dir];
      this.uy = DY[this.dir];
    }
    return this;
  }
  /** Phase 4 boss hook: armour this shell takes off a campaign player (0 = by the owner's type); 4+ = heavy shell */
  dmg = 0;
  /** Phase 4 boss hook: a machine-gun round (bursts on brick without breaking it) */
  mg = false;
  /** Phase 4 boss hook: px left before it falls short (0 = unlimited) */
  range = 0;
}

export interface PowerUp { x: number; y: number; type: number; t: number }
export interface Boom { x: number; y: number; big: boolean; t: number; fx?: boolean }
export interface Part {
  x: number; y: number; z: number; vx: number; vy: number; vz: number;
  life: number; max: number; col: RGB; kind: number; // 0 debris, 1 spark, 2 smoke, 3 leaf
  r: number;
  fx?: boolean;
}
export interface Popup { x: number; y: number; text: string; t: number; col: RGB }
export interface Flash { x: number; y: number; t: number; max: number; r: number; col: RGB; z: number; vx?: number; vy?: number; fx?: boolean }
export type Decal =
  | { k: 0; x: number; y: number; w: number; h: number; col: RGB; a: number }
  | { k: 1; x: number; y: number; r: number; col: RGB; a: number };

const BRICK_COLS: RGB[] = [[0.78, 0.44, 0.0], [0.6, 0.19, 0.0], [0.91, 0.54, 0.16], [0.55, 0.55, 0.55]];

export class World {
  map: GameMap;
  def: StageDef;
  env: EnvName;
  envLabel: string;
  order: number[];
  players: (Tank | null)[] = [null, null];
  enemies: Tank[] = [];
  bullets: Bullet[] = [];
  power: PowerUp | null = null;
  booms: Boom[] = [];
  parts: Part[] = [];
  popups: Popup[] = [];
  flashes: Flash[] = [];
  decals: Decal[] = [];
  shocks: { x: number; y: number; t: number; max: number; size: number }[] = [];
  ev: { n: string; x: number; v: number }[] = [];
  notes: { text: string; kind: 'power' | 'warn' | 'info'; icon: number; ms: number }[] = [];
  queue: number[];
  spawned = 0;
  spawnTimer = 20;
  spawnIdx = 0;
  maxActive: number;
  spawnInterval: number;
  respawn = [0, 0];
  freeze = 0;
  shovel = 0;
  /** False in region mode: no eagle, fortress, base shield or base game over. */
  hasBase = true;
  /** Co-op on a scrolling map: the furthest apart (px, centre to centre) the players may drive, so the shared
   * camera can always show both. Null = no limit. */
  leash: { w: number; h: number } | null = null;
  /** campaign: shared salvage and ability charges (index 0-3 = drone, ambush, recon, patch uses) */
  scrap = 0;
  partsFound = 0;
  charges = [0, 0, 0, 0];
  pickups: Pickup[] = [];
  towns: TownState[] = [];
  radio: RadioMsg[] = [];
  /** campaign: the last town freed; knocked-out players respawn at its flag (null = at their spawn) */
  checkpoint: TownState | null = null;
  /** campaign: the briefing's ASK FIRST answer was taken: the maps mark the boss's lair before it is revealed */
  lairKnown = false;
  /**
   * Hit-stop (G5): updates the app holds the picture for, set on a player's kill (the app also sets it when a boss
   * part breaks). Only the app's play loop reads and counts it down; the rules never do, so sims run unchanged.
   */
  hitStop = 0;
  /** campaign: per-player "LOW ARMOUR" toast already shown for this dip */
  lowWarned = [false, false];
  /** campaign: per-player w.frame from which the field patch (ability 4) can be used again */
  patchReady = [0, 0];
  /** campaign run totals, for the sim and the end-of-region summary */
  stats = { hits: 0, knockouts: 0, scrapPicked: 0, partsPicked: 0, patches: 0, townsFreed: 0, scrapSpent: 0, depots: 0, boss: 0, bossScrap: 0 };
  /** Arcade: false once the base is destroyed. Region mode: stays true (check hasBase before drawing the base). */
  eagleAlive = true;
  /** Arcade: 1 while the base shield is up. Region mode: 0. */
  baseShield = 1;
  baseShieldHit = 0;
  frame = 0;
  over = false;
  overT = 0;
  clearT = 0;
  done: '' | 'clear' | 'over' = '';
  shake = 0;
  flowE = new Flow();
  flowP = new Flow();
  hasWater: boolean;
  baseKiller: { persona: number; dist: number; player: boolean; dir: number; bx: number; by: number } | null = null;
  /** Playfield size in px (208x208 in arcade, the region's size otherwise). */
  readonly pxW: number;
  readonly pxH: number;
  /** ms spent in the last flow recompute (for the sim / perf checks). */
  flowMs = 0;
  /** campaign AI hook: enemy group director (src/game/ai.ts); region maps only, null in arcade */
  ai: AiDirector | null = null;
  /** Phase 3: the player's crew abilities and the enemy's tricks (region mode only) */
  abil: Abilities | null = null;
  tricks: Tricks | null = null;
  /** Phase 4 boss hook: the region's boss (src/game/boss.ts); null in arcade and in regions without towns */
  boss: RegionBoss | null = null;
  /** Phase 5 events hook: the region's map events (src/game/events.ts; save.ts regionWorld builds them); null in arcade */
  events: MapEvents | null = null;
  /** Phase 3: ability types unlocked by crew (drone, ambush, recon, patch); patch is always available */
  unlocked = [false, false, false, true];
  /** Phase 3: active crew perk ids (see crew.ts) */
  perks = new Set<string>();
  // ---------- Phase 2 run loop fields (campaign) ----------
  /** -0.2..0.5: enemies react this much slower on an eased attempt (10% per retreat on the region's base, which is below 0 in the last regions; save.ts easeFor). The AI reads it. */
  ease = 0;
  /** depot targets (region maps) */
  depots: DepotState[] = [];
  /** part ids found since the run last collected them (save.ts syncRun moves them into RunState.bin) */
  found: string[] = [];
  /** ?arena= test map (src/game/arena.ts): stages targets and tricks; null everywhere else */
  arena: ArenaHook | null = null;
  /** campaign: the run's own map (not a quick test): freed towns and destroyed depots are saved in RunState.progress */
  keepsProgress = false;
  /** called after every player spawn and respawn (the run fits the tank's parts) */
  onSpawn: ((t: Tank) => void) | null = null;
  // ---------- end Phase 2 run loop fields ----------

  constructor(public stage: number, public ps: PState[], public nPlayers: number, public region?: RegionSpec) {
    if (region) {
      this.hasBase = false;
      this.baseShield = 0;
      this.map = new GameMap(region.w, region.h);
      this.map.eagle = false;
      this.map.loadCells(region.cells);
      const n = region.enemies;
      const [ma, mp, mf] = REGION_MIX[stage - 1] ?? REGION_MIX[REGION_MIX.length - 1];
      const armor = Math.floor(n * ma);
      const power = Math.floor(n * mp);
      const fast = Math.floor(n * mf);
      this.def = { name: region.name, rows: [], enemies: [n - armor - power - fast, fast, power, armor] };
      this.env = region.env;
      this.queue = enemyQueue(this.def, stage);
      this.maxActive = region.maxActive;
      this.spawnInterval = Math.max(70, 150 - (nPlayers - 1) * 30);
      this.towns = (region.towns ?? []).map((t) => ({ name: t.name, rect: [t.rect[0], t.rect[1], t.rect[2], t.rect[3]], cx: t.cx, cy: t.cy, freed: false, progress: 0 }));
      this.charges = [0, 0, 0, 2];
      this.depots = (region.depots ?? []).map(newDepot); // Phase 2 run loop
      this.ai = new AiDirector(this); // campaign AI hook (after towns: it reads w.towns)
      this.abil = new Abilities(this); // Phase 3 hook
      this.tricks = new Tricks(this); // Phase 3 hook
    } else {
      this.map = new GameMap();
      this.def = stageDef(stage);
      this.env = envFor(stage);
      this.map.load(this.def.rows);
      this.queue = enemyQueue(this.def, stage);
      this.maxActive = nPlayers === 2 ? 6 : 4;
      this.spawnInterval = Math.max(70, 180 - stage * 4 - (nPlayers - 1) * 30);
    }
    this.pxW = this.map.pxW;
    this.pxH = this.map.pxH;
    this.boss = Boss.forRegion(this); // Phase 4 boss hook (after towns, depots and the size: it picks its lair from them)
    this.order = [...this.queue];
    this.envLabel = ENV_LABEL[this.env];
    this.hasWater = this.map.c.includes(WATER);
    for (let i = 0; i < nPlayers; i++) {
      ps[i].kills = [0, 0, 0, 0];
      if (!ps[i].out) this.spawnPlayer(i);
    }
    this.updateFlow();
  }

  // ---------- helpers ----------
  allTanks(): Tank[] {
    const out: Tank[] = [];
    for (const p of this.players) if (p) out.push(p);
    for (const e of this.enemies) out.push(e);
    return out;
  }

  livePlayers(): Tank[] {
    return this.players.filter((p): p is Tank => !!p && p.alive && p.spawn === 0);
  }

  tankIn(x: number, y: number, w: number, h: number): boolean {
    if (this.boss?.overlaps(x, y, w, h)) return true; // Phase 4 boss hook
    return this.allTanks().some((t) => t.alive && overlap(x, y, w, h, t.x, t.y, 16, 16));
  }

  onIce(t: Tank): boolean {
    return this.map.any(t.x + 4, t.y + 4, 8, 8, (c) => c === ICE);
  }

  onWater(t: Tank): boolean {
    return this.map.any(t.x, t.y, 16, 16, (c) => c === WATER);
  }

  blockedAt(t: Tank, x: number, y: number): boolean {
    if (x < -EPS || y < -EPS || x > this.pxW - 16 + EPS || y > this.pxH - 16 + EPS) return true;
    if (this.map.solidForTank(x, y, t.hover)) return true;
    if (this.hasBase && overlap(x, y, 16, 16, EAGLE_X, EAGLE_Y, 16, 16)) return true;
    if (this.depots.length && this.depotBlocks(x, y)) return true; // Phase 2 run loop
    if (this.boss?.blocks(t, x, y)) return true; // Phase 4 boss hook
    if (this.leash && t.isPlayer) {
      // moving further from the partner is blocked past the leash; moving back is always allowed
      for (const o of this.players) {
        if (!o || o === t || !o.alive) continue;
        const dx = Math.abs(x + 8 - o.cx);
        const dy = Math.abs(y + 8 - o.cy);
        if (dx > this.leash.w && dx > Math.abs(t.cx - o.cx) + EPS) return true;
        if (dy > this.leash.h && dy > Math.abs(t.cy - o.cy) + EPS) return true;
      }
    }
    for (const o of this.allTanks()) {
      if (o === t || !o.alive || o.spawn > 0) continue;
      if (overlap(x, y, 16, 16, o.x, o.y, 16, 16) && !overlap(t.x, t.y, 16, 16, o.x, o.y, 16, 16)) return true;
    }
    return false;
  }

  turn(t: Tank, dir: number): void {
    if (dir === t.dir) return;
    if ((dir & 1) !== (t.dir & 1)) {
      const axis = dir === UP || dir === DOWN ? 'x' : 'y';
      const v = t[axis];
      for (const grid of [8, 4]) {
        const r = Math.round(v / grid) * grid;
        if (Math.abs(r - v) < EPS) break;
        t[axis] = r;
        if (!this.blockedAt(t, t.x, t.y)) break;
        t[axis] = v;
      }
    }
    t.dir = dir;
  }

  move(t: Tank, speed: number): boolean {
    let remaining = speed;
    let movedAny = false;
    const dx = DX[t.dir];
    const dy = DY[t.dir];
    while (remaining > EPS) {
      const step = Math.min(1, remaining);
      remaining -= step;
      const nx = Math.round((t.x + dx * step) * 256) / 256;
      const ny = Math.round((t.y + dy * step) * 256) / 256;
      if (!this.blockedAt(t, nx, ny)) {
        t.x = nx;
        t.y = ny;
        movedAny = true;
        this.tracks(t, step);
        this.tricks?.moved(t); // Phase 3 hook (mines)
        continue;
      }
      const fx = dx > 0 ? Math.floor(nx) : dx < 0 ? Math.ceil(nx) : nx;
      const fy = dy > 0 ? Math.floor(ny) : dy < 0 ? Math.ceil(ny) : ny;
      if ((fx !== t.x || fy !== t.y) && !this.blockedAt(t, fx, fy)) {
        this.tracks(t, Math.abs(fx - t.x) + Math.abs(fy - t.y));
        t.x = fx;
        t.y = fy;
        movedAny = true;
      } else if (!movedAny && this.region && t.isPlayer && this.cornerSlide(t, step)) {
        movedAny = true;
      }
      break;
    }
    return movedAny;
  }

  /**
   * Campaign corner assist: a player blocked by a wall corner within 6 px of an open lane slides sideways toward
   * it, so narrow village streets don't snag the tank. Returns true if it slid.
   */
  cornerSlide(t: Tank, step: number): boolean {
    const dx = DX[t.dir];
    const dy = DY[t.dir];
    for (let s = 1; s <= 6; s++) {
      for (const side of [-1, 1]) {
        const ox = dy !== 0 ? side * s : 0;
        const oy = dx !== 0 ? side * s : 0;
        // the shifted spot must be free and let the tank move on from there
        if (this.blockedAt(t, t.x + ox, t.y + oy) || this.blockedAt(t, t.x + ox + dx, t.y + oy + dy)) continue;
        const nx = t.x + Math.sign(ox) * Math.min(step, s);
        const ny = t.y + Math.sign(oy) * Math.min(step, s);
        if (this.blockedAt(t, nx, ny)) continue;
        t.x = nx;
        t.y = ny;
        this.tracks(t, step);
        return true;
      }
    }
    return false;
  }

  tracks(t: Tank, step: number): void {
    t.dist += step;
    t.trackAcc += step;
    if (t.trackAcc < 3) return;
    t.trackAcc = 0;
    if (this.onWater(t)) return;
    const px = DY[t.dir] !== 0 ? 1 : 0;
    const py = 1 - px;
    for (const s of [-5, 5]) {
      const x = t.cx + px * s - 1 - DX[t.dir] * 4;
      const y = t.cy + py * s - 1 - DY[t.dir] * 4;
      this.decals.push({ k: 0, x, y, w: 2, h: 2, col: [0.04, 0.04, 0.045], a: 0.16 });
    }
  }

  // ---------- spawning ----------
  spawnPlayer(i: number): void {
    const t = new Tank();
    t.player = i;
    if (this.region) {
      const sp = this.region.playerSpawns;
      [t.x, t.y] = sp[i] ?? sp[sp.length - 1];
      // after a knock-out: back at the last freed town's flag (nearest clear spot)
      if (this.checkpoint) {
        const cp = this.freeSpotNear(this.checkpoint.cx - 8, this.checkpoint.cy - 8);
        if (cp) [t.x, t.y] = cp;
      }
      // co-op: rejoin next to a partner who has moved on, so both stay on the shared screen
      const mate = this.players.find((o) => o && o !== this.players[i] && o.alive);
      if (mate && this.leash && (Math.abs(t.x - mate.x) > this.leash.w || Math.abs(t.y - mate.y) > this.leash.h)) {
        const near = this.freeSpotNear(mate.x, mate.y);
        if (near) [t.x, t.y] = near;
      }
    } else {
      [t.x, t.y] = P_SPAWN[i];
    }
    t.spawn = 50;
    const s = this.ps[i];
    t.level = s.level;
    t.hover = s.hover;
    t.gun = s.gun;
    t.ricochet = s.ricochet;
    if (this.region) {
      t.vet = s.vet;
      t.vetXp = s.vetXp;
      t.armourMax = ARMOUR_MAX + t.vet;
      t.armour = t.armourMax;
      this.lowWarned[i] = false;
    }
    this.players[i] = t;
    this.onSpawn?.(t); // Phase 2 run loop: fit the run's parts
  }

  /** The nearest clear 16 px spot on the 8 px grid around (x, y), searched in growing rings; null if none. */
  freeSpotNear(x: number, y: number): [number, number] | null {
    const gx = Math.round(x / 8);
    const gy = Math.round(y / 8);
    for (let r = 2; r <= 10; r++) {
      for (let j = -r; j <= r; j++) {
        for (const [nx, ny] of [[gx + j, gy - r], [gx + j, gy + r], [gx - r, gy + j], [gx + r, gy + j]]) {
          const px = nx * 8;
          const py = ny * 8;
          if (px < 0 || py < 0 || px > this.pxW - 16 || py > this.pxH - 16) continue;
          if (this.map.solidForTank(px, py, false) || this.tankIn(px, py, 16, 16)) continue;
          return [px, py];
        }
      }
    }
    return null;
  }

  spawnEnemies(): void {
    if (this.ai?.active) return; // campaign AI hook: the director spawns region enemies in groups
    if (!this.queue.length || this.over) return;
    if (this.enemies.length >= this.maxActive) return;
    if (this.spawnTimer > 0) {
      this.spawnTimer--;
      return;
    }
    let sx: number;
    let sy: number;
    if (this.region) {
      const sp = this.pickRegionSpawn();
      if (!sp) return;
      [sx, sy] = sp;
    } else {
      [sx, sy] = E_SPAWN[this.spawnIdx % 3];
      this.spawnIdx++;
      if (this.tankIn(sx, sy, 16, 16)) return;
    }
    const e = new Tank();
    e.x = sx;
    e.y = sy;
    e.dir = DOWN;
    e.etype = this.queue.shift()!;
    e.hp = ENEMY[e.etype].hp;
    e.spawn = 60;
    this.spawned++;
    e.bonus = !this.region && (this.spawned === 4 || this.spawned === 11 || this.spawned === 18); // arcade only: no flashing tanks in the campaign
    const r = rand();
    if (this.region) {
      // no base to raid: raiders become hunters
      e.persona = r < (e.etype === 2 ? 0.7 : 0.45) ? 2 : 0;
    } else {
      const raid = Math.min(0.5, 0.05 + this.stage * 0.04);
      const hunt = e.etype === 2 ? 0.45 : 0.12;
      e.persona = r < hunt ? 2 : r < hunt + raid ? 1 : 0;
    }
    this.enemies.push(e);
    this.spawnTimer = this.spawnInterval;
  }

  /**
   * Region spawn: a free enemy spawn 120-300 px from every live player (random among those), else the nearest one
   * that is at least 120 px away, else the farthest. Null when nobody is alive to spawn near.
   */
  pickRegionSpawn(): [number, number] | null {
    const pl = this.livePlayers();
    if (!pl.length) return null;
    const band: [number, number][] = [];
    let near: [number, number] | null = null;
    let nearD = Infinity;
    let far: [number, number] | null = null;
    let farD = -1;
    for (const sp of this.region!.enemySpawns) {
      if (this.tankIn(sp[0], sp[1], 16, 16)) continue;
      let dmin = Infinity;
      for (const p of pl) dmin = Math.min(dmin, Math.hypot(sp[0] - p.x, sp[1] - p.y));
      if (dmin >= 120 && dmin <= 300) band.push(sp);
      if (dmin >= 120 && dmin < nearD) { nearD = dmin; near = sp; }
      if (dmin > farD) { farD = dmin; far = sp; }
    }
    if (band.length) return band[randInt(band.length)];
    return near ?? far;
  }

  // ---------- update ----------
  update(inp: PInput[]): void {
    this.frame++;
    if (this.freeze > 0) this.freeze--;
    if (this.baseShieldHit > 0) this.baseShieldHit--;
    if (this.hasBase && this.shovel > 0) {
      this.shovel--;
      if (this.shovel === 0) this.setFortress(BRICK);
      else if (this.shovel < 200 && this.shovel % 16 === 0) this.setFortress((this.shovel / 16) % 2 ? BRICK : STEEL);
    }
    for (let i = 0; i < this.nPlayers; i++) this.updatePlayer(i, inp[i] ?? { dir: -1, fire: false });
    this.spawnEnemies();
    this.ai?.update(); // campaign AI hook
    for (const e of this.enemies) this.updateEnemy(e);
    this.abil?.update(); // Phase 3 hook
    this.tricks?.update(); // Phase 3 hook
    this.boss?.update(); // Phase 4 boss hook
    this.events?.update(); // Phase 5 events hook
    this.arena?.update(); // ?arena= test map (after tricks: it replaces their mines and teams once they exist)
    this.updateBullets();
    this.updatePower();
    if (this.region) {
      this.updatePickups();
      this.updateTowns();
      this.updateDepots(); // Phase 2 run loop
      this.collectHulls(); // Phase 2 run loop: hulls the AI reports captured
    }
    this.updateFx();
    if (this.frame % 15 === 0) this.updateFlow();
    this.enemies = this.enemies.filter((e) => e.alive);

    if (!this.over) {
      // arcade: every tank destroyed; region with towns: every town freed (enemies retreat and come back, so
      // the queue may never empty there)
      // Phase 4 boss hook: a region with a boss is clear once the boss is destroyed (towns still pay when freed)
      const cleared = this.arena ? false : this.boss ? this.boss.cleared()
        : this.towns.length ? this.towns.every((t) => t.freed) : !this.queue.length && !this.enemies.length;
      if (cleared) {
        if (++this.clearT > 200) this.done = 'clear';
      }
      const anyLeft = this.ps.slice(0, this.nPlayers).some((p) => !p.out) || this.players.some((p) => p?.alive);
      if (!anyLeft) this.gameOver();
    } else if (++this.overT > 260) {
      this.done = 'over';
    }
  }

  /** Queue a sound; x = playfield px (for stereo), v = volume. */
  snd(n: string, x = this.pxW / 2, v = 1): void {
    this.ev.push({ n, x, v });
  }

  /** ms = how long the toast stays (default 2200; longer ones are the last to be pushed off by newer toasts) */
  note(text: string, kind: 'power' | 'warn' | 'info', icon = -1, ms = 0): void {
    this.notes.push({ text, kind, icon, ms });
  }

  gameOver(): void {
    if (this.over) return;
    this.over = true;
    this.overT = 0;
    this.snd('gameover');
  }

  updatePlayer(i: number, inp: PInput): void {
    const t = this.players[i];
    const st = this.ps[i];
    if (!t) {
      if (!st.out && this.respawn[i] > 0 && --this.respawn[i] === 0) this.spawnPlayer(i);
      return;
    }
    if (t.spawn > 0) {
      if (--t.spawn === 0) t.shield = 180;
      return;
    }
    if (t.shield > 0) t.shield--;
    if (t.cooldown > 0) t.cooldown--;
    if (t.recoil > 0) t.recoil--;
    if (t.flash > 0) t.flash--;
    t.moving = false;
    if (this.over) return;
    if (this.region && inp.ability === 4) this.patch(t);
    if (this.abil?.input(i, t, inp)) return; // Phase 3 hook: abilities may take over the tank (aiming)
    if (t.frozen > 0) {
      t.frozen--;
      return;
    }
    if (inp.dir >= 0) {
      this.turn(t, inp.dir);
      this.move(t, PLAYER_SPEED * t.speedMul);
      t.moving = true;
      t.slide = this.onIce(t) ? 28 : 0;
    } else if (t.slide > 0) {
      t.slide--;
      if (!this.onIce(t) || !this.move(t, PLAYER_SPEED * t.speedMul)) t.slide = 0;
    }
    if (inp.fire && t.cooldown === 0) this.fire(t);
  }

  updateEnemy(e: Tank): void {
    if (e.spawn > 0) {
      e.spawn--;
      return;
    }
    if (e.flash > 0) e.flash--;
    if (e.recoil > 0) e.recoil--;
    if (e.stun > 0) {
      e.stun--;
      return;
    }
    if (this.freeze > 0) return;
    if (this.arena?.drive(e)) return; // ?arena=: its staged targets
    if (this.ai?.drive(e)) return; // campaign AI hook: the director steers and fires its own tanks
    const E = ENEMY[e.etype];
    const atNode = Math.abs(e.x - Math.round(e.x / 8) * 8) < EPS && Math.abs(e.y - Math.round(e.y / 8) * 8) < EPS;
    if (e.blocked || (atNode && rand() < 0.25)) this.turn(e, this.chooseDir(e));
    const vertical = e.dir === UP || e.dir === DOWN;
    const along = vertical ? e.y : e.x;
    const sgn = e.dir === RIGHT || e.dir === DOWN ? 1 : -1;
    const next = sgn > 0 ? Math.floor(along / 8 + 1e-6) * 8 + 8 : Math.ceil(along / 8 - 1e-6) * 8 - 8;
    const moved = this.move(e, Math.min(E.speed, Math.abs(next - along)));
    e.blocked = !moved;
    e.stuck = moved ? 0 : e.stuck + 1;
    if (e.aiFire > 0) e.aiFire--;
    else if (this.enemyWantsFire(e) && this.fire(e)) e.aiFire = ((18 + rand() * 45) / E.fire) * (1 + this.ease); // Phase 2: eased attempts
  }

  chooseDir(e: Tank): number {
    if (e.stuck > 45) {
      e.stuck = 0;
      return (e.dir + 1 + randInt(3)) % 4;
    }
    const follow = [0.15, 0.5, 0.55][e.persona];
    if (rand() < follow) {
      // region mode has no base, so every persona that follows a field follows the players
      const field = this.region ? this.flowP : e.persona === 2 && this.livePlayers().length ? this.flowP : this.flowE;
      const nx = Math.round(e.x / 8);
      const ny = Math.round(e.y / 8);
      let best = -1;
      let bv = field.at(nx, ny);
      for (const d of [0, 1, 2, 3].sort(() => rand() - 0.5)) {
        const v = field.at(nx + DX[d], ny + DY[d]);
        if (v < bv) {
          bv = v;
          best = d;
        }
      }
      if (best >= 0) return best;
    }
    if (!e.blocked && rand() < 0.4) return e.dir;
    const r = rand();
    return r < 0.29 ? DOWN : r < 0.53 ? LEFT : r < 0.77 ? RIGHT : UP;
  }

  inLine(e: Tank, x: number, y: number, w: number, h: number): boolean {
    const cx = x + w / 2;
    const cy = y + h / 2;
    switch (e.dir) {
      case UP: return Math.abs(cx - e.cx) < 7 && cy < e.cy;
      case DOWN: return Math.abs(cx - e.cx) < 7 && cy > e.cy;
      case LEFT: return Math.abs(cy - e.cy) < 7 && cx < e.cx;
      default: return Math.abs(cy - e.cy) < 7 && cx > e.cx;
    }
  }

  /** No steel on the straight line from the tank's muzzle to (tx, ty). */
  clearShot(e: Tank, tx: number, ty: number): boolean {
    let x = e.cx;
    let y = e.cy;
    for (let i = 0; i < 60; i++) {
      x += DX[e.dir] * 4;
      y += DY[e.dir] * 4;
      if (Math.abs(x - tx) < 4 && Math.abs(y - ty) < 4) return true;
      if (x < 0 || y < 0 || x >= this.pxW || y >= this.pxH) return false;
      if (this.map.at(Math.floor(x / 4), Math.floor(y / 4)) === STEEL) return false;
      if (DX[e.dir] === 0 ? Math.abs(y - ty) < 4 : Math.abs(x - tx) < 4) return true;
    }
    return false;
  }

  enemyWantsFire(e: Tank): boolean {
    for (const p of this.livePlayers()) {
      if (this.inLine(e, p.x, p.y, 16, 16) && this.clearShot(e, p.cx, p.cy)) return rand() < 0.3;
    }
    if (this.hasBase && this.eagleAlive && this.inLine(e, EAGLE_X, EAGLE_Y, 16, 16)) {
      const near = Math.abs(e.cx - EAGLE_X - 8) + Math.abs(e.cy - EAGLE_Y - 8) < 90;
      if (near && this.clearShot(e, EAGLE_X + 8, EAGLE_Y + 8)) return e.persona === 1 && rand() < 0.1;
    }
    if (e.persona > 0) {
      const ax = e.cx + DX[e.dir] * 12;
      const ay = e.cy + DY[e.dir] * 12;
      if (this.map.any(ax - 4, ay - 4, 8, 8, (c) => c === BRICK)) return rand() < 0.12;
    }
    return rand() < 0.014 * ENEMY[e.etype].fire;
  }

  /** Campaign reload time in frames: player stars and upgrades (reloadMul) shorten it; enemies by type. */
  reloadFrames(t: Tank): number {
    if (!t.isPlayer) return [50, 45, 40, 60][t.etype] ?? 50;
    return Math.round((t.level >= 2 ? 26 : 36) * t.reloadMul);
  }

  /** 0..1, how loaded the gun is (campaign; 1 in arcade). */
  loaded(t: Tank): number {
    if (!this.region || t.readyAt <= this.frame) return 1;
    return 1 - (t.readyAt - this.frame) / this.reloadFrames(t);
  }

  fire(t: Tank): boolean {
    if (this.region) {
      // campaign: one shot per reload, however far the last shell flew
      if (this.frame < t.readyAt) return false;
      t.readyAt = this.frame + this.reloadFrames(t);
    } else {
      // arcade, as the original: a new shot only once your last shell has hit something
      const maxB = t.isPlayer && t.level >= 2 ? 2 : 1;
      let active = 0;
      for (const b of this.bullets) if (b.alive && b.owner === t) active++;
      if (active >= maxB) return false;
    }
    const speed = t.isPlayer ? (t.level >= 1 ? 5 : 3.2) : ENEMY[t.etype].bullet;
    const bx = t.cx + DX[t.dir] * 8;
    const by = t.cy + DY[t.dir] * 8;
    this.bullets.push(new Bullet(bx, by, t.dir, speed, t, t.isPlayer && (t.level >= 3 || t.firepower >= 2), t.isPlayer && t.gun, t.ricochet ? 2 : 0));
    t.cooldown = t.isPlayer ? (t.level >= 2 ? 7 : 10) : 0;
    t.recoil = 4;
    this.flashes.push({ x: bx + DX[t.dir] * 2, y: by + DY[t.dir] * 2, t: 0, max: 5, r: 34, col: [1.0, 0.75, 0.4], z: 9, vx: DX[t.dir], vy: DY[t.dir] });
    for (let i = 0; i < 3; i++) {
      this.parts.push({
        x: bx, y: by, z: 6, vx: DX[t.dir] * 0.6 + (rand() - 0.5) * 0.4, vy: DY[t.dir] * 0.6 + (rand() - 0.5) * 0.4, vz: 0.05,
        life: 0, max: 22 + randInt(12), col: [0.55, 0.55, 0.58], kind: 2, r: 2.5,
      });
    }
    this.snd(t.isPlayer ? 'shoot' : 'eshoot', t.cx, t.isPlayer ? 1 : 0.55);
    return true;
  }

  // ---------- bullets ----------
  updateBullets(): void {
    for (const b of this.bullets) {
      if (!b.alive) continue;
      const steps = Math.ceil(b.speed);
      const st = b.speed / steps;
      for (let s = 0; s < steps && b.alive; s++) {
        b.x += b.ux * st;
        b.y += b.uy * st;
        this.bulletStep(b);
        // Phase 4 boss hook: machine-gun rounds fall short
        if (b.range > 0 && b.alive && (b.range -= st) <= 0) {
          b.alive = false;
          this.sparks(b.x, b.y, 2, [1, 0.8, 0.4]);
        }
      }
    }
    const bs = this.bullets;
    for (let i = 0; i < bs.length; i++) {
      for (let j = i + 1; j < bs.length; j++) {
        const a = bs[i];
        const c = bs[j];
        if (!a.alive || !c.alive) continue;
        if (!a.owner.isPlayer && !c.owner.isPlayer) continue;
        if (Math.abs(a.x - c.x) < 4 && Math.abs(a.y - c.y) < 4) {
          // Phase 4 boss hook: a heavy shell shrugs off the shell that meets it
          if (a.dmg >= 3 || c.dmg >= 3) { // (a heavy boss shell: 3 armour or more)
            (a.dmg >= 3 ? c : a).alive = false;
            this.sparks((a.x + c.x) / 2, (a.y + c.y) / 2, 6, [1, 0.9, 0.6]);
            continue;
          }
          a.alive = c.alive = false;
          this.sparks((a.x + c.x) / 2, (a.y + c.y) / 2, 6, [1, 0.9, 0.6]);
          this.flashes.push({ x: a.x, y: a.y, t: 0, max: 6, r: 26, col: [1, 0.9, 0.7], z: 10 });
        }
      }
    }
    this.bullets = bs.filter((b) => b.alive);
  }

  bulletStep(b: Bullet): void {
    const x0 = b.x - 2;
    const y0 = b.y - 2;
    if (x0 < 0 || y0 < 0 || x0 + 4 > this.pxW || y0 + 4 > this.pxH) {
      if (this.bounce(b)) return;
      b.alive = false;
      this.impact(b, false, true);
      return;
    }
    if (this.depots.length && this.bulletDepot(b)) return; // Phase 2 run loop
    if (this.boss?.bulletHit(b)) return; // Phase 4 boss hook
    if (this.tricks?.bulletHit(b) || this.abil?.bulletHit(b)) { // Phase 3 hook
      b.alive = false;
      return;
    }
    if (this.bulletWalls(b)) return;
    if (this.hasBase && this.eagleAlive && overlap(x0, y0, 4, 4, EAGLE_X, EAGLE_Y, 16, 16)) {
      b.alive = false;
      if (this.baseShield > 0) {
        this.baseShield--;
        this.baseShieldHit = 40;
        this.sparks(b.x, b.y, 16, [0.5, 0.85, 1]);
        this.shocks.push({ x: EAGLE_X + 8, y: EAGLE_Y + 8, t: 0, max: 24, size: 0.6 });
        this.flashes.push({ x: EAGLE_X + 8, y: EAGLE_Y + 6, t: 0, max: 24, r: 70, col: [0.4, 0.75, 1], z: 16 });
        this.shake = Math.max(this.shake, 2.5);
        this.note('BASE SHIELD DOWN', 'warn');
        this.snd('shieldbreak', EAGLE_X + 8);
        return;
      }
      const o = b.owner;
      this.baseKiller = { persona: o.persona, dist: Math.round(Math.abs(o.cx - EAGLE_X - 8) + Math.abs(o.cy - EAGLE_Y - 8)), player: o.isPlayer, dir: b.dir, bx: Math.round(o.x), by: Math.round(o.y) };
      this.destroyEagle();
      return;
    }
    for (const t of this.allTanks()) {
      if (t === b.owner || !t.alive || t.spawn > 0) continue;
      if (!overlap(x0, y0, 4, 4, t.x, t.y, 16, 16)) continue;
      if (b.owner.isPlayer && !t.isPlayer) {
        b.alive = false;
        this.hitEnemy(t, b.owner.player);
        return;
      }
      if (!b.owner.isPlayer && t.isPlayer) {
        b.alive = false;
        this.hitPlayer(t, b.owner, b.dmg || undefined); // Phase 4 boss hook: boss shells carry their own damage
        return;
      }
      if (b.owner.isPlayer && t.isPlayer) {
        b.alive = false;
        if (t.shield <= 0) t.frozen = 180;
        this.impact(b, false, false);
        return;
      }
    }
  }

  /** Ricochet rounds turn 90 degrees toward the most promising enemy. */
  bounce(b: Bullet): boolean {
    if (b.bounces <= 0) return false;
    b.bounces--;
    b.x -= DX[b.dir] * 2;
    b.y -= DY[b.dir] * 2;
    const opts = [(b.dir + 1) % 4, (b.dir + 3) % 4];
    const score = (d: number) => {
      let s = rand() * 0.1;
      for (const e of this.enemies) {
        if (!e.alive || e.spawn) continue;
        const along = (e.cx - b.x) * DX[d] + (e.cy - b.y) * DY[d];
        const lat = Math.abs((e.cx - b.x) * DY[d] - (e.cy - b.y) * DX[d]);
        if (along > 0) s = Math.max(s, 1 / (1 + lat / 12));
      }
      const nx = b.x + DX[d] * 4;
      const ny = b.y + DY[d] * 4;
      if (nx < 2 || ny < 2 || nx > this.pxW - 2 || ny > this.pxH - 2) s -= 1;
      return s;
    };
    b.dir = score(opts[0]) >= score(opts[1]) ? opts[0] : opts[1];
    b.ux = DX[b.dir];
    b.uy = DY[b.dir];
    if (DX[b.dir] === 0) b.x = Math.round(b.x / 4) * 4;
    else b.y = Math.round(b.y / 4) * 4;
    this.sparks(b.x, b.y, 5, [1, 0.8, 0.4]);
    this.flashes.push({ x: b.x, y: b.y, t: 0, max: 6, r: 24, col: [1, 0.8, 0.5], z: 8 });
    this.snd('ricochet', b.x);
    return true;
  }

  bulletWalls(b: Bullet): boolean {
    const x0 = b.x - 2;
    const y0 = b.y - 2;
    const hits = (t: number) => t === BRICK || t === STEEL || (t === TREES && b.trees);
    if (!this.map.any(x0, y0, 4, 4, hits)) return false;
    if (b.mg) { // Phase 4 boss hook: machine-gun rounds burst on walls
      b.alive = false;
      this.impact(b, false, false);
      return true;
    }
    const depth = b.power ? 2 : 1;
    let bricks = 0;
    let steelHit = false;
    let steelGone = false;
    const visit = (cx: number, cy: number) => {
      const t = this.map.at(cx, cy);
      if (cx < 0 || cy < 0 || cx >= this.map.w || cy >= this.map.h) return;
      if (t === BRICK) {
        this.map.set(cx, cy, EMPTY);
        bricks++;
        this.debris(cx * 4 + 2, cy * 4 + 2, b.dir);
      } else if (t === STEEL) {
        if (b.power) {
          const tx = cx & ~1;
          const ty = cy & ~1;
          for (let j = 0; j < 2; j++) for (let i = 0; i < 2; i++) if (this.map.at(tx + i, ty + j) === STEEL) this.map.set(tx + i, ty + j, EMPTY);
          steelGone = true;
          this.sparks(cx * 4 + 2, cy * 4 + 2, 6, [0.9, 0.95, 1]);
        } else {
          steelHit = true;
        }
      } else if (t === TREES && b.trees) {
        this.map.set(cx, cy, EMPTY);
        for (let i = 0; i < 3; i++) {
          this.parts.push({
            x: cx * 4 + 2, y: cy * 4 + 2, z: 8, vx: (rand() - 0.5) * 1.4, vy: (rand() - 0.5) * 1.4, vz: 0.6 + rand(),
            life: 0, max: 50, col: [0.4, 0.75, 0.1], kind: 3, r: 1,
          });
        }
      }
    };
    /** The 16 px strip of cells a shell flying `d` bites, `k` cells deep past its leading edge. */
    const strip = (d: number, k: number, f: (cx: number, cy: number) => void) => {
      if (d === UP || d === DOWN) {
        const sx0 = Math.floor((b.x - 8 + EPS) / 4);
        const sx1 = Math.floor((b.x + 8 - EPS) / 4);
        const lead = d === UP ? Math.floor((y0 + EPS) / 4) : Math.floor((y0 + 4 - EPS) / 4);
        for (let cx = sx0; cx <= sx1; cx++) f(cx, lead + (d === UP ? -k : k));
      } else {
        const sy0 = Math.floor((b.y - 8 + EPS) / 4);
        const sy1 = Math.floor((b.y + 8 - EPS) / 4);
        const lead = d === LEFT ? Math.floor((x0 + EPS) / 4) : Math.floor((x0 + 4 - EPS) / 4);
        for (let cy = sy0; cy <= sy1; cy++) f(lead + (d === LEFT ? -k : k), cy);
      }
    };
    let dir = b.dir;
    if (b.free) {
      // a free-angle (boss) shell bites the face it struck as a tank shell would: the side it meets more wall on
      // (a flat wall hit at a slant), else its main direction (a corner)
      const hd = b.ux < 0 ? LEFT : RIGHT;
      const vd = b.uy < 0 ? UP : DOWN;
      let nh = 0;
      let nv = 0;
      strip(hd, 0, (cx, cy) => { if (hits(this.map.at(cx, cy))) nh++; });
      strip(vd, 0, (cx, cy) => { if (hits(this.map.at(cx, cy))) nv++; });
      dir = nh > nv ? hd : nv > nh ? vd : b.dir;
    }
    for (let k = 0; k < depth; k++) strip(dir, k, visit);
    if (!bricks && !steelGone && steelHit && this.bounce(b)) return true;
    b.alive = false;
    this.impact(b, bricks > 0 || steelGone, steelHit && !bricks && !steelGone);
    return true;
  }

  impact(b: Bullet, broke: boolean, steel: boolean): void {
    if (b.dmg >= 3) { // Phase 4 boss hook: a heavy shell goes off like a tank
      this.explode(b.x, b.y, true);
      this.snd('explode', b.x, 0.8);
      return;
    }
    if (b.mg) {
      this.sparks(b.x, b.y, 3, [1, 0.85, 0.5]);
      this.flashes.push({ x: b.x, y: b.y, t: 0, max: 5, r: 18, col: [1, 0.75, 0.4], z: 8 });
      return;
    }
    this.booms.push({ x: b.x, y: b.y, big: false, t: 0 });
    this.flashes.push({ x: b.x, y: b.y, t: 0, max: 10, r: 40, col: [1, 0.65, 0.3], z: 10 });
    this.decals.push({ k: 1, x: b.x, y: b.y, r: 4, col: [0.03, 0.03, 0.03], a: 0.35 });
    if (steel) this.sparks(b.x, b.y, 7, [1, 0.95, 0.8]);
    this.snd(broke ? 'brick' : steel ? 'steel' : 'thud', b.x, b.owner.isPlayer ? 1 : 0.45);
  }

  debris(x: number, y: number, dir: number): void {
    for (let i = 0; i < 2; i++) {
      this.parts.push({
        x, y, z: 6,
        vx: -DX[dir] * (0.3 + rand() * 0.9) + (rand() - 0.5) * 1.2,
        vy: -DY[dir] * (0.3 + rand() * 0.9) + (rand() - 0.5) * 1.2,
        vz: 0.8 + rand() * 1.2,
        life: 0, max: 200, col: BRICK_COLS[randInt(4)], kind: 0, r: 1,
      });
    }
    this.parts.push({ x, y, z: 5, vx: (rand() - 0.5) * 0.3, vy: (rand() - 0.5) * 0.3, vz: 0.1, life: 0, max: 40, col: [0.5, 0.42, 0.36], kind: 2, r: 3 });
  }

  sparks(x: number, y: number, n: number, col: RGB): void {
    for (let i = 0; i < n; i++) {
      const a = rand() * Math.PI * 2;
      const s = 0.8 + rand() * 1.8;
      this.parts.push({ x, y, z: 6, vx: Math.cos(a) * s, vy: Math.sin(a) * s, vz: rand(), life: 0, max: 10 + randInt(12), col, kind: 1, r: 1 });
    }
  }

  explode(x: number, y: number, big: boolean): void {
    this.booms.push({ x, y, big, t: 0 });
    this.flashes.push({ x, y, t: 0, max: big ? 40 : 16, r: big ? 100 : 50, col: [1, 0.6, 0.25], z: 16 });
    this.decals.push({ k: 1, x, y, r: big ? 13 : 5, col: [0.02, 0.02, 0.02], a: big ? 0.7 : 0.4 });
    if (big) {
      this.shocks.push({ x, y, t: 0, max: 30, size: 1 });
      this.shake = Math.max(this.shake, 3.5);
      this.sparks(x, y, 14, [1, 0.7, 0.3]);
      for (let i = 0; i < 6; i++) {
        this.parts.push({
          x: x + (rand() - 0.5) * 8, y: y + (rand() - 0.5) * 8, z: 8, vx: (rand() - 0.5) * 0.5, vy: (rand() - 0.5) * 0.5 - 0.15, vz: 0.1,
          life: 0, max: 70 + randInt(40), col: [0.18, 0.17, 0.17], kind: 2, r: 5 + rand() * 4,
        });
      }
    }
  }

  hitEnemy(t: Tank, pi: number): void {
    if (t.bonus) {
      t.bonus = false;
      this.spawnPower();
    }
    const owner = this.players[pi];
    t.hp -= 1 + (owner && owner.firepower >= 1 && t.hp > 1 ? 1 : 0);
    if (t.hp > 0) {
      t.flash = 8;
      this.sparks(t.cx, t.cy, 6, [0.9, 0.95, 1]);
      this.snd('armor', t.cx);
      return;
    }
    this.killEnemy(t, pi);
  }

  killEnemy(t: Tank, pi: number): void {
    t.alive = false;
    this.explode(t.cx, t.cy, true);
    this.snd('explode', t.cx);
    if (this.region) this.dropLoot(t);
    if (pi < 0) return;
    this.hitStop = Math.max(this.hitStop, HITSTOP_KILL);
    const pts = ENEMY[t.etype].pts;
    const st = this.ps[pi];
    st.kills[t.etype]++;
    this.addScore(pi, pts);
    this.popups.push({ x: t.cx, y: t.cy, text: String(pts), t: 0, col: [1, 1, 1] });
    if (this.region) this.addVetXp(pi, VET_XP[t.etype]);
  }

  // ---------- campaign: salvage, veterancy, patching, towns (region mode only) ----------
  /** A wreck leaves scrap, and now and then a part. */
  dropLoot(t: Tank): void {
    const amount = Math.round(SCRAP_DROP[t.etype] * (0.8 + rand() * 0.4));
    this.pickups.push({ x: t.cx, y: t.cy, kind: 'scrap', amount, t: 0 });
    if (rand() < PART_CHANCE) {
      const a = rand() * Math.PI * 2;
      this.pickups.push({ x: t.cx + Math.cos(a) * 7, y: t.cy + Math.sin(a) * 7, kind: 'part', amount: 1, t: 0 });
    }
    if (this.pickups.length > 60) this.pickups.splice(0, this.pickups.length - 60);
  }

  updatePickups(): void {
    if (!this.pickups.length) return;
    const pl = this.livePlayers();
    const keep: Pickup[] = [];
    for (const p of this.pickups) {
      if (++p.t > PICKUP_LIFE) continue;
      let taken = false;
      for (const t of pl) {
        if (Math.abs(t.cx - p.x) < 10 && Math.abs(t.cy - p.y) < 10) {
          taken = true;
          if (p.kind === 'scrap') {
            this.scrap += p.amount;
            this.stats.scrapPicked += p.amount;
            this.popups.push({ x: p.x, y: p.y - 4, text: `+${p.amount} SCRAP`, t: 0, col: [1, 0.85, 0.4] });
          } else {
            this.partsFound += p.amount;
            this.stats.partsPicked += p.amount;
            const id = this.rollFound(true); // Phase 2 run loop: stripped from the wreck
            const name = id ? partById(id)?.name : undefined;
            this.popups.push({ x: p.x, y: p.y - 4, text: name ? `+${name}` : '+1 PART', t: 0, col: [0.6, 0.9, 1] });
          }
          this.snd(p.kind === 'part' ? 'part' : 'scrap', p.x, 0.8);
          break;
        }
      }
      if (!taken) keep.push(p);
    }
    this.pickups = keep;
  }

  /** True while a pickup should be drawn (it blinks for its last 5 s). */
  static pickupVisible(p: Pickup): boolean {
    return p.t < PICKUP_LIFE - PICKUP_BLINK || ((p.t >> 2) & 1) === 0;
  }

  addVetXp(pi: number, xp: number): void {
    const t = this.players[pi];
    const st = this.ps[pi];
    if (!t || !t.alive || t.vet >= 3) return;
    // each rank takes longer: about 8, 16, then 24 basic kills (rank 3 after roughly a region and a half)
    t.vetXp += xp / ((t.vet + 1) * 2);
    if (t.vetXp >= 1) {
      t.vet++;
      t.vetXp = t.vet >= 3 ? 0 : t.vetXp - 1;
      t.armourMax++;
      t.armour++;
      this.note(`VETERAN RANK ${t.vet}`, 'power');
      this.snd('life', t.cx, 0.7);
      this.sparks(t.cx, t.cy, 8, [1, 0.85, 0.3]);
    }
    st.vet = t.vet;
    st.vetXp = t.vetXp;
  }

  /** Ability 4: spend a patch charge (else PATCH_SCRAP scrap) to mend PATCH_ARMOUR armour. */
  patch(t: Tank): void {
    if (t.armour >= t.armourMax) return;
    const wait = this.patchWait(t.player);
    if (wait > 0) {
      this.note(`PATCH READY IN ${Math.ceil(wait / 60)}`, 'warn');
      return;
    }
    if (this.charges[3] > 0) {
      this.charges[3]--;
    } else if (this.scrap >= PATCH_SCRAP) {
      this.scrap -= PATCH_SCRAP;
      this.stats.scrapSpent += PATCH_SCRAP;
    } else {
      this.note('NEED 15 SCRAP', 'warn');
      return;
    }
    const gain = Math.min(PATCH_ARMOUR, t.armourMax - t.armour);
    t.armour += gain;
    this.patchReady[t.player] = this.frame + PATCH_COOLDOWN;
    this.stats.patches++;
    if (t.armour > LOW_ARMOUR) this.lowWarned[t.player] = false;
    this.note(`PATCHED +${gain}`, 'info');
    this.snd('patch', t.cx, 0.9);
    this.sparks(t.cx, t.cy, 8, [1, 0.8, 0.4]);
    this.popups.push({ x: t.cx, y: t.cy - 10, text: `+${gain}`, t: 0, col: [0.5, 1, 0.5] });
  }

  /** Frames until player i may use the field patch again (0 = now). */
  patchWait(i: number): number {
    return Math.max(0, (this.patchReady[i] ?? 0) - this.frame);
  }

  updateTowns(): void {
    if (!this.towns.length) return;
    const pl = this.livePlayers();
    for (const town of this.towns) {
      if (town.freed) continue;
      const [rx, ry, rw, rh] = town.rect;
      const near = pl.some((p) => Math.hypot(p.cx - town.cx, p.cy - town.cy) <= FREE_RADIUS);
      const held = this.enemies.some((e) => e.alive && !this.ai?.isHull(e) && e.cx >= rx && e.cx < rx + rw && e.cy >= ry && e.cy < ry + rh); // campaign AI hook: abandoned hulls don't hold a town
      if (near && !held) {
        town.progress = Math.min(1, town.progress + 1 / FREE_FRAMES);
        if (this.frame % 30 === 0 && town.progress < 1) this.snd('capture-tick', town.cx, 0.6);
      } else {
        town.progress = Math.max(0, town.progress - FREE_DECAY);
      }
      if (town.progress >= 1) this.freeTown(town);
    }
  }

  freeTown(town: TownState): void {
    town.freed = true;
    town.progress = 1;
    this.checkpoint = town;
    this.stats.townsFreed++;
    this.scrap += FREE_SCRAP;
    this.charges[3]++;
    this.note(`${town.name} FREED`, 'power');
    this.snd('town-freed', town.cx, 1);
    this.popups.push({ x: town.cx, y: town.cy - 14, text: `+${FREE_SCRAP} SCRAP`, t: 0, col: [1, 0.85, 0.4] });
    this.flashes.push({ x: town.cx, y: town.cy, t: 0, max: 40, r: 110, col: [1, 0.8, 0.3], z: 18 });
    this.sparks(town.cx, town.cy - 6, 16, [1, 0.85, 0.35]);
    const line = RADIO_FREED[randInt(RADIO_FREED.length)].replace('{T}', town.name);
    this.radio.push({ who: RADIO_WHO, text: line });
    if (this.radio.length > 20) this.radio.shift();
  }

  // ---------- Phase 2 run loop methods (campaign): parts, depots, workshops ----------
  /** Roll a part into `found` (the run collects it). captured = stripped from a wreck; falls back to the other pool. */
  rollFound(captured: boolean): string | null {
    const id = rollPart(rand, captured) ?? rollPart(rand, !captured);
    if (id) this.found.push(id);
    return id;
  }

  /** True if a tank at (x, y) would overlap a standing depot target. */
  depotBlocks(x: number, y: number): boolean {
    for (const d of this.depots) if (!d.destroyed && overlap(x, y, 16, 16, d.cx - 8, d.cy - 8, 16, 16)) return true;
    return false;
  }

  /** A shell meets a standing depot target: player shells damage it, enemy shells just burst on it. */
  bulletDepot(b: Bullet): boolean {
    for (const d of this.depots) {
      if (d.destroyed || !overlap(b.x - 2, b.y - 2, 4, 4, d.cx - 8, d.cy - 8, 16, 16)) continue;
      b.alive = false;
      if (!b.owner.isPlayer) {
        this.impact(b, false, true);
        return true;
      }
      this.hitDepot(d, b.owner.player, b.x, b.y);
      return true;
    }
    return false;
  }

  hitDepot(d: DepotState, pi: number, x = d.cx, y = d.cy): void {
    if (d.destroyed) return;
    d.hp = Math.max(0, d.hp - 1);
    d.hitT = 8;
    this.booms.push({ x, y, big: false, t: 0 });
    this.flashes.push({ x, y, t: 0, max: 10, r: 44, col: [1, 0.65, 0.3], z: 10 });
    this.sparks(x, y, 8, [1, 0.85, 0.5]);
    this.shake = Math.max(this.shake, 1.2);
    if (d.hp <= 0) {
      this.destroyDepot(d, pi);
      return;
    }
    this.snd(d.hp <= d.max / 2 ? 'explode' : 'armor', d.cx, 0.9);
    if (d.hp === Math.floor(d.max / 2)) this.note(`${d.name} IS BURNING`, 'info');
  }

  destroyDepot(d: DepotState, pi: number): void {
    d.destroyed = true;
    d.hp = 0;
    d.burnT = 0;
    this.explode(d.cx, d.cy, true);
    this.flashes.push({ x: d.cx, y: d.cy, t: 0, max: 80, r: 190, col: [1, 0.55, 0.2], z: 26 });
    this.shocks.push({ x: d.cx, y: d.cy, t: 0, max: 46, size: 2.4 });
    this.shake = 8;
    this.snd('bigexplode', d.cx);
    for (let i = 0; i < 18; i++) {
      const a = rand() * Math.PI * 2;
      const s = 0.6 + rand() * 1.8;
      this.parts.push({
        x: d.cx, y: d.cy, z: 8, vx: Math.cos(a) * s, vy: Math.sin(a) * s, vz: 1 + rand() * 2,
        life: 0, max: 200, col: d.kind === 'fuel' ? [0.32, 0.36, 0.24] : [0.42, 0.3, 0.16], kind: 0, r: 1,
      });
    }
    // rewards: scrap, a part for the bin, a radio line; the run autosaves when it sees stats.depots change
    this.stats.depots++;
    this.scrap += DEPOT_SCRAP;
    this.popups.push({ x: d.cx, y: d.cy - 14, text: `+${DEPOT_SCRAP} SCRAP`, t: 0, col: [1, 0.85, 0.4] });
    const id = this.rollFound(false);
    this.partsFound++;
    const name = id ? partById(id)?.name : undefined;
    this.popups.push({ x: d.cx, y: d.cy - 4, text: name ? `+${name}` : '+1 PART', t: 0, col: [0.6, 0.9, 1] });
    this.note(`${d.name} DESTROYED`, 'power');
    this.radio.push({ who: RADIO_WHO, text: RADIO_DEPOT[randInt(RADIO_DEPOT.length)].replace('{D}', d.name) });
    if (this.radio.length > 20) this.radio.shift();
    if (pi >= 0) this.addVetXp(pi, 0.5);
  }

  /** Hit flashes, secondary blasts after a depot goes up, then flames and smoke (smoke reaches the fluid). */
  updateDepots(): void {
    for (const d of this.depots) {
      if (d.hitT > 0) d.hitT--;
      let every = 0;
      if (d.destroyed) {
        const t = ++d.burnT;
        if (t === 9 || t === 22 || t === 40) {
          const a = rand() * Math.PI * 2;
          this.explode(d.cx + Math.cos(a) * 9, d.cy + Math.sin(a) * 9, t !== 22);
          this.snd(t === 22 ? 'explode' : 'bigexplode', d.cx, 0.7);
        }
        every = t < DEPOT_BURN ? 4 : 16;
      } else if (d.hp <= d.max / 2) {
        every = d.hp <= 2 ? 5 : 9;
      }
      if (!every || this.frame % every !== 0) continue;
      const heavy = d.destroyed && d.burnT < DEPOT_BURN;
      this.parts.push({
        x: d.cx + (rand() - 0.5) * (heavy ? 12 : 8), y: d.cy + (rand() - 0.5) * 6, z: 8,
        vx: (rand() - 0.5) * 0.2, vy: -0.22 - rand() * 0.2, vz: 0,
        life: 0, max: heavy ? 110 : 80, col: heavy ? [0.1, 0.09, 0.09] : [0.16, 0.15, 0.15], kind: 2, r: (heavy ? 5 : 3.5) + rand() * 3,
      });
    }
  }

  /**
   * Abandoned enemy hulls the player captured (the AI agent's `ai.capturedHulls`): each is stripped for a captured
   * part roll into the bin. The array is cleared after reading. Optional: older ai.ts has no such field.
   */
  collectHulls(): void {
    const hulls = (this.ai as { capturedHulls?: { cx?: number; cy?: number; x?: number; y?: number }[] } | null)?.capturedHulls;
    if (!hulls?.length) return;
    for (const h of hulls) {
      const id = this.rollFound(true);
      this.partsFound++;
      this.stats.partsPicked++;
      const x = h?.cx ?? (h?.x ?? 0) + 8;
      const y = h?.cy ?? (h?.y ?? 0) + 8;
      const name = id ? partById(id)?.name : undefined;
      if (h) this.popups.push({ x, y: y - 6, text: name ? `+${name}` : '+1 PART', t: 0, col: [0.6, 0.9, 1] });
      this.snd('part', x, 0.8);
    }
    this.note(hulls.length > 1 ? `${hulls.length} HULLS STRIPPED` : 'HULL STRIPPED', 'info');
    hulls.length = 0;
  }

  /** The freed town whose flag player i is standing at (its workshop), and whether it's quiet enough to open. */
  workshopAt(i: number): { town: TownState; safe: boolean } | null {
    const t = this.players[i];
    if (!t || !t.alive || t.spawn > 0 || this.over) return null;
    const town = this.towns.find((tw) => tw.freed && Math.hypot(t.cx - tw.cx, t.cy - tw.cy) <= FREE_RADIUS);
    if (!town) return null;
    const safe = !this.enemies.some((e) => e.alive && e.spawn === 0 && Math.hypot(e.cx - t.cx, e.cy - t.cy) < WORKSHOP_CLEAR);
    return { town, safe };
  }
  // ---------- end Phase 2 run loop methods ----------

  addScore(pi: number, pts: number): void {
    const st = this.ps[pi];
    st.score += pts;
    if (st.score >= st.nextLife) {
      st.nextLife += 20000;
      st.lives++;
      this.snd('life');
      this.note('EXTRA LIFE', 'power', 5);
    }
  }

  hitPlayer(t: Tank, by?: Tank, dmgOverride?: number): void {
    if (t.shield > 0) {
      this.sparks(t.cx, t.cy, 5, [0.5, 0.9, 1]);
      return;
    }
    const st = this.ps[t.player];
    if (t.hover && !this.onWater(t)) {
      t.hover = st.hover = false;
      t.shield = 60;
      this.sparks(t.cx, t.cy, 10, [0.4, 0.7, 1]);
      this.snd('armor', t.cx);
      this.note('HOVER LOST', 'info', 7);
      return;
    }
    if (this.region) {
      // campaign: the shell chips armour; only an empty bar knocks the tank out
      const dmg = dmgOverride ?? ENEMY_DMG[by?.etype ?? 0];
      this.stats.hits++;
      t.armour = Math.max(0, t.armour - dmg);
      if (t.armour > 0) {
        t.flash = 10;
        this.sparks(t.cx, t.cy, 4 + dmg * 3, [1, 0.78, 0.4]);
        this.flashes.push({ x: t.cx, y: t.cy, t: 0, max: 8, r: 36 + dmg * 6, col: [1, 0.6, 0.3], z: 10 });
        this.shake = Math.max(this.shake, 0.8 + dmg * 0.9);
        this.snd('armour-hit', t.cx);
        this.popups.push({ x: t.cx, y: t.cy - 10, text: `-${dmg}`, t: 0, col: [1, 0.4, 0.3] });
        if (t.armour <= LOW_ARMOUR && !this.lowWarned[t.player]) {
          this.lowWarned[t.player] = true;
          this.note(this.nPlayers > 1 ? `P${t.player + 1} LOW ARMOUR` : 'LOW ARMOUR', 'warn');
          this.snd('armour-low', t.cx);
        }
        return;
      }
      this.stats.knockouts++;
    }
    t.alive = false;
    this.players[t.player] = null;
    this.explode(t.cx, t.cy, true);
    this.flashes.push({ x: t.cx, y: t.cy, t: 0, max: 50, r: 130, col: [1, 0.5, 0.2], z: 20 });
    this.shake = 5;
    this.snd('bigexplode', t.cx);
    st.level = 0;
    st.hover = st.gun = st.ricochet = false;
    if (st.lives > 0) {
      st.lives--;
      this.respawn[t.player] = 90;
    } else {
      st.out = true;
    }
  }

  destroyEagle(): void {
    if (!this.hasBase || !this.eagleAlive) return;
    this.eagleAlive = false;
    this.explode(EAGLE_X + 8, EAGLE_Y + 8, true);
    this.flashes.push({ x: EAGLE_X + 8, y: EAGLE_Y + 8, t: 0, max: 90, r: 160, col: [1, 0.45, 0.15], z: 24 });
    this.shake = 7;
    this.snd('bigexplode', EAGLE_X + 8);
    this.note('BASE DESTROYED', 'warn');
    this.gameOver();
  }

  setFortress(type: number): void {
    if (!this.hasBase) return;
    for (const [cx, cy] of FORT_CELLS) {
      if (this.tankIn(cx * 4, cy * 4, 4, 4)) continue;
      this.map.set(cx, cy, type);
    }
  }

  // ---------- power-ups ----------
  spawnPower(): void {
    if (this.region) return; // arcade only: the campaign has no star/shield/clock/... pickups (loot, scrap and parts instead)
    const w =[1, 1, this.hasBase ? 1 : 0, 2.2, 1, 0.8, 0.5, this.hasWater ? 0.9 : 0.15, 0.9, 0.9];
    let r = rand() * w.reduce((a, b) => a + b, 0);
    let type = 0;
    for (; type < w.length - 1; type++) {
      if (r < w[type]) break;
      r -= w[type];
    }
    const pl = this.region ? this.livePlayers() : [];
    if (this.region && !pl.length) return;
    for (let i = 0; i < 40; i++) {
      let x: number;
      let y: number;
      if (this.region) {
        // near a live player, on the 8 px grid, inside the map and reachable for a tank
        const p = pl[randInt(pl.length)];
        const a = rand() * Math.PI * 2;
        const r = 40 + rand() * 110;
        x = Math.round((p.x + Math.cos(a) * r) / 8) * 8;
        y = Math.round((p.y + Math.sin(a) * r) / 8) * 8;
        if (x < 0 || y < 0 || x > this.pxW - 16 || y > this.pxH - 16) continue;
        if (this.map.any(x, y, 16, 16, (c) => c === STEEL || c === WATER || c === BRICK)) continue;
        if (this.flowP.nw && !Number.isFinite(this.flowP.at(x >> 3, y >> 3))) continue;
      } else {
        x = randInt(25) * 8;
        y = randInt(23) * 8;
        if (overlap(x, y, 16, 16, 80, 176, 48, 32)) continue;
      }
      if (this.map.any(x + 4, y + 4, 8, 8, (c) => c === STEEL || c === WATER)) continue;
      this.power = { x, y, type, t: 0 };
      this.snd('powerup', x + 8);
      return;
    }
  }

  updatePower(): void {
    const p = this.power;
    if (!p) return;
    if (++p.t > 60 * 25) {
      this.power = null;
      return;
    }
    for (const t of this.livePlayers()) {
      if (!overlap(t.x, t.y, 16, 16, p.x, p.y, 16, 16)) continue;
      this.applyPower(t, p.type);
      this.power = null;
      return;
    }
  }

  applyPower(t: Tank, type: number): void {
    const st = this.ps[t.player];
    switch (type) {
      case PW.HELMET: t.shield = 600; break;
      case PW.CLOCK: this.freeze = 600; break;
      case PW.SHOVEL:
        if (this.hasBase) {
          this.shovel = 1200;
          this.setFortress(STEEL);
        } else {
          t.shield = Math.max(t.shield, 600);
        }
        break;
      case PW.STAR: t.level = st.level = Math.min(3, t.level + 1); break;
      case PW.GRENADE:
        for (const e of this.enemies) if (e.alive && e.spawn === 0) this.killEnemy(e, -1);
        this.shake = 6;
        break;
      case PW.TANK: st.lives++; break;
      case PW.GUN: t.level = st.level = 3; t.gun = st.gun = true; break;
      case PW.SHIP: t.hover = st.hover = true; break;
      case PW.EMP:
        for (const e of this.enemies) {
          if (e.alive && Math.hypot(e.cx - t.cx, e.cy - t.cy) < 110) e.stun = 360;
        }
        for (const b of this.bullets) if (!b.owner.isPlayer && Math.hypot(b.x - t.cx, b.y - t.cy) < 110) b.alive = false;
        this.shocks.push({ x: t.cx, y: t.cy, t: 0, max: 40, size: 1.8 });
        this.flashes.push({ x: t.cx, y: t.cy, t: 0, max: 30, r: 140, col: [0.4, 0.6, 1.0], z: 20 });
        break;
      case PW.RICOCHET: t.ricochet = st.ricochet = true; break;
    }
    this.addScore(t.player, 500);
    this.popups.push({ x: t.cx, y: t.cy, text: '500', t: 0, col: [1, 1, 1] });
    this.note(PW_NAMES[type], 'power', type);
    this.snd(type === PW.TANK ? 'life' : type === PW.EMP ? 'emp' : type === PW.GRENADE ? 'grenade' : 'pickup', t.cx);
  }

  // ---------- fx ----------
  updateFx(): void {
    for (const b of this.booms) b.t++;
    this.booms = this.booms.filter((b) => b.t < (b.big ? 30 : 12));
    for (const f of this.flashes) f.t++;
    this.flashes = this.flashes.filter((f) => f.t < f.max);
    for (const s of this.shocks) s.t++;
    this.shocks = this.shocks.filter((s) => s.t < s.max);
    const out: Part[] = [];
    for (const p of this.parts) {
      p.life++;
      p.x += p.vx;
      p.y += p.vy;
      if (p.kind === 0 || p.kind === 3) {
        p.vz -= 0.12;
        p.z += p.vz;
        p.vx *= 0.96;
        p.vy *= 0.96;
        if (p.z <= 0) {
          if (p.x >= 0 && p.y >= 0 && p.x < this.pxW && p.y < this.pxH && !this.map.any(p.x, p.y, 1, 1, (c) => c === WATER)) {
            this.decals.push({ k: 0, x: Math.floor(p.x), y: Math.floor(p.y), w: 1, h: 1, col: p.col, a: 0.85 });
          }
          continue;
        }
      } else if (p.kind === 1) {
        p.vx *= 0.9;
        p.vy *= 0.9;
      } else {
        p.vx *= 0.97;
        p.vy *= 0.97;
        p.r += 0.06;
      }
      if (p.life < p.max) out.push(p);
    }
    if (this.hasBase && !this.eagleAlive && this.frame % 5 === 0) {
      out.push({
        x: EAGLE_X + 8 + (rand() - 0.5) * 8, y: EAGLE_Y + 8, z: 8, vx: (rand() - 0.5) * 0.2, vy: -0.25 - rand() * 0.2, vz: 0,
        life: 0, max: 90, col: [0.12, 0.11, 0.11], kind: 2, r: 4 + rand() * 3,
      });
    }
    this.parts = out.length > 1500 ? out.slice(out.length - 1500) : out;
    this.shake *= 0.86;
  }

  updateFlow(): void {
    const t0 = performance.now();
    const pl = this.livePlayers();
    if (this.region) {
      if (pl.length) this.flowP.compute(this.map, pl.map((p) => [Math.round(p.x / 8), Math.round(p.y / 8)] as [number, number]));
    } else {
      this.flowE.compute(this.map, [[12, 22], [10, 24], [14, 24]]);
      if (pl.length) this.flowP.compute(this.map, pl.map((p) => [Math.round(p.x / 8), Math.round(p.y / 8)] as [number, number]));
    }
    this.flowMs = performance.now() - t0;
  }
}

export const NODES = NN;
