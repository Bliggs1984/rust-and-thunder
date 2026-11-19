// Campaign enemy AI (region mode): a director that owns enemy groups with jobs. See CAMPAIGN.md "Enemy AI".
//
// Roles (Phase 1):
// - Garrison: holds a town from its dug-in spots and faces the approaches. It shifts a little to get a line of
//   fire on a player it can see, but never leaves the town rect + 32 px. When a member is hit, or a player drives
//   into the town, it radios for help, which sends an assault group.
// - Assault group: 2-4 tanks enter one by one at a road exit, drive in column along the roads (leader first,
//   followers on the leader's trail ~28 px apart), deploy into a line abreast ~120 px from the target (or on first
//   contact) and advance in line, firing when they have a clear line. With nothing found they join the town's
//   garrison, or drive home.
// - Retreat: an armour tank down to 1 hp, or an assault group that lost half its tanks, drives back to its exit
//   along the roads and leaves the map; its tank type goes back into the reinforcement queue.
// Perception: sight 160 px along a straight line that brick and steel block; a player in trees, or behind a
// hedgerow, is only seen within 48 px. A player's shot reveals the shooter to groups within 200 px for 3 s.
// Easy tuning: a 0.4-0.8 s reaction before the first shot, fire only along a clear line, at most 6 tanks engaging.
// Tells: radio intercepts (w.radio) for help calls, columns setting off, deploying and retreating; a distant
// rumble (w.ev) when a column sets off and again when it nears the player.
//
// Roles (Phase 2):
// - Counterattack: 60-120 s after a town is freed (never while a player is inside it), an assault column of 2-4
//   (more towns freed = bigger) drives along the roads to retake it. Tells: "<CALL>: MOVING TO RETAKE <TOWN>." and
//   the column rumble. If it holds the flag area (40 px) for 10 s with no player in the town, the town flips back
//   (freed = false, progress 0; our radio: "<TOWN> IS THEIRS AGAIN...") and up to 2 of its tanks stay as the new
//   garrison. One counterattack at a time, at most 2 per town, 90 s apart.
// - Overwatch: after the first town is freed, now and then a single tank (a power tank when the queue has one)
//   drives to a firing spot 144-200 px from the player, in line with them along a straight, open line (no brick or
//   steel, no thick foliage), preferring open fields, tree-line edges and nearer spots. It glints and radios
//   "<CALL>: OVERWATCH ON THE <DIR> RIDGE." when it settles, glints again before it fires, fires 2-3 shots (sight
//   210 px, same tree rules), then shoots and scoots to another spot 48+ px away. It also moves if the player gets
//   within 96 px or stays out of its line for 6 s. After 4 moves it drives home. 60-90 s between overwatch tanks.
// - Morale: an armour tank down to 2 hp may (60%) pull back to the nearest standing depot, at 1 hp it always does
//   (no depot: it leaves the map as in Phase 1). A group that lost half falls back to a depot too when there is
//   one. At the depot it "repairs" for 20 s (full hp), then returns to duty: its old group if that still fights,
//   else the nearest held town's garrison, else it drives home.
// - Abandoned tanks: when an enemy drops to 1 hp, 20% of crews bail. The tank stops where it is, its lights go out
//   and it stays as a hull for 60 s (blocks movement, never fires; player shells still wreck it for scrap). A player
//   driving into it captures it: `capturedHulls` gets an entry (see CapturedHull), "+CAPTURED" pops up. Unclaimed
//   hulls are scuttled after 60 s.
// - Difficulty: `w.ease` (0..0.3, set by the run flow after retreats) slows reactions (x1 to x1.6) and lowers the
//   engagement cap (6 to 4).
//
// Hooks in world.ts (marked "campaign AI hook"): the director exists only on region maps; `active` is true when
// the region has towns. Then it spawns all enemies itself (spawnEnemies returns early), runs once per update, and
// steers and fires every tank it owns (updateEnemy hands them over). Regions without towns keep the old hunters.
// Abandoned hulls stay in w.enemies (so they block tanks and take shells) but don't hold a town (updateTowns hook)
// and are drawn dark with their lights out (draw.ts hook): both ask `w.ai?.isHull(t)`.
import { BRICK, DOWN, DX, DY, EMPTY, ENEMY, LEFT, RIGHT, ROAD, STEEL, TREES, UP, WATER } from './constants';
import type { Depot, Town } from './region';
import { Tank, type Bullet, type TownState, type World } from './world';

const rand = Math.random;
const randInt = (n: number) => Math.floor(rand() * n);
const INF = 0x3fffffff;
const EPS = 1e-4;

/** Tuning, "easy". Distances in px, times in frames (60 per second). */
export const AI = {
  maxAlive: 12,
  maxEngaging: 6,
  sight: 160,
  sightTrees: 48,
  revealR: 200,
  revealT: 180,
  reactMin: 24,
  reactMax: 48,
  garrisonSize: 3,
  /** a town's garrison by region (stage - 1; garrisonSize past the list): smaller in the first two, while the tank
   * is bare and there is little scrap to patch with, larger later (2026-11-18 difficulty curve). Winter's is smaller
   * than Ruined Town's: its final fight brings escorts of its own (it was 6 before the field patch's cooldown). */
  garrisonByRegion: [2, 2, 3, 5, 4],
  /** a town's garrison appears when a player comes this close (the 2 towns nearest the start are manned at once) */
  activateR: 320,
  startTowns: 2,
  leash: 32,
  spacing: 28,
  deployR: 120,
  helpDelay: 60 * 5,
  helpCooldown: 60 * 40,
  /** a column is sent at the player's last known position this often while no assault is under way */
  pressureEvery: 60 * 50,
  spawnMinDist: 220,
  quietJoin: 60 * 10,
  // ---- Phase 2 ----
  /** counterattack on a freed town: due this long after it was freed (random in between) */
  counterMin: 60 * 60,
  counterMax: 60 * 120,
  /** the column must hold the flag area this long with no player in the town */
  counterHold: 60 * 10,
  /** tank centre within this of the flag = holding the flag area */
  flagR: 40,
  /** gap after a counterattack ends before the next one may set off */
  counterGap: 60 * 90,
  counterPerTown: 2,
  /** tanks that stay as the retaken town's garrison (the rest drive home) */
  retakeKeep: 2,
  /** overwatch: first one this long after the first town is freed, then this long after the last one is gone */
  owFirstMin: 60 * 20,
  owFirstMax: 60 * 40,
  owGapMin: 60 * 60,
  owGapMax: 60 * 90,
  owSight: 210,
  owNear: 144,
  owFar: 200,
  /** a player closer than this makes the overwatch move */
  owTooClose: 96,
  owMoves: 4,
  /** frames between the glint and the shot (the overwatch's reaction) */
  owReactMin: 40,
  owReactMax: 64,
  /** morale: armour tanks at this hp or less may pull back to a depot */
  moraleHp: 2,
  depotChance: 0.6,
  repairT: 60 * 20,
  /** chance a crew bails when its tank drops to 1 hp */
  bailChance: 0.2,
  hullT: 60 * 60,
  /** gentle start: in these regions (stage - 1: Farmland, Winter Front) no column or overwatch is sent for this long, and
   * garrisons man only spots this far from every player spawn */
  gentleRegions: [0, 4],
  gentleT: 60 * 60,
  gentleSpawnR: 200,
};

/** A hull a player drove into: the run flow turns each into a captured part (see AiDirector.capturedHulls). */
export interface CapturedHull {
  kind: 'captured';
  /** tank top-left in px where it was captured */
  x: number;
  y: number;
  /** enemy type of the hull (0 basic, 1 fast, 2 power, 3 armour) */
  etype: number;
  /** player index (0/1) who took it */
  player: number;
  /** w.frame of the capture */
  frame: number;
}

/** An abandoned tank: still in w.enemies (blocks tanks, takes player shells) but no longer driven. */
export interface Hull { t: Tank; until: number; call: string }

interface Overwatch {
  spot: number;
  /** the spot faces this way (toward the player's line) */
  face: number;
  shots: number;
  want: number;
  moves: number;
  arrivedAt: number;
  pickedAt: number;
  lastShot: number;
  /** frame the current aim started (glint), -1 = not aiming */
  aimAt: number;
  outOfLine: number;
  told: boolean;
  history: number[];
}

interface DepotAI { def: Depot; node: number; spots: number[] }

/** Sound for the "column on the move" tell: a distant enemy column rumble (audio.ts on main), at the column's x. */
export const TELL_SFX = 'column';

const GARRISON_CALLS = ['KETTLE', 'BIRCH', 'MAGPIE', 'FLINT', 'SORREL', 'TALLOW', 'WICKER', 'PEWTER'];
const ASSAULT_CALLS = ['TROWEL', 'GRANITE', 'BADGER', 'HAMMER', 'BRAMBLE', 'CINDER', 'GRAVEL', 'MORTAR'];
const OW_CALLS = ['KESTREL', 'LANTERN', 'STEEPLE', 'HERON', 'SPYGLASS', 'MAGNET'];
const OFFS = [0, -1, 1, -2, 2, -3, 3];
/** Our side when a counterattack retakes a town ({T} = its name). */
const RETAKEN = [
  '{T} IS THEIRS AGAIN. THE MAYOR IS NOT HAPPY.',
  'WE LOST {T}. THE BAKERY HAS CLOSED AGAIN. GO AND OPEN IT.',
  '{T} FELL BACK INTO THEIR HANDS. I AM PUTTING IT BACK ON THE LIST.',
];

// move orders
const HOLD = 0;
const TRAIL = 1;
const GROUP = 2;
const GOAL = 3;
const EXIT = 4;
/** cross-country (or road-biased) route on a shared whole-map field: overwatch spots, depots */
const ROUTE = 5;
const ORDER_NAMES = ['hold', 'trail', 'group', 'goal', 'exit', 'route'];

const DIR_NAMES = ['NORTH', 'EAST', 'SOUTH', 'WEST'];
/** Our side's radio voice (world.ts RADIO_WHO). */
const OUR_WHO = 'SPANNER';

export type Job = 'garrison' | 'assault' | 'overwatch';
export type Phase = 'hold' | 'column' | 'deploy' | 'advance' | 'retreat' | 'leave' | 'move' | 'set';

interface Known { x: number; y: number; t: number }

/** Distance field over tank nodes (Dial's algorithm). Bounded fields reset only the nodes they touched. */
class NodeField {
  d: Int32Array;
  touched: number[] = [];
  full = true;
  at = -1;
  ver = -1;
  goal = -1;
  constructor(n: number) {
    this.d = new Int32Array(n).fill(INF);
  }
}

export interface TownAI {
  def: Town;
  call: string;
  garrison: Group | null;
  activated: boolean;
  /** garrison wiped out or withdrawn: not manned again (Phase 2: counterattacks) */
  spent: boolean;
  helpAt: number;
  /** leash rect in px: x0, y0, x1, y1 (tank rect must stay inside) */
  leash: [number, number, number, number];
  /** garrison spots as node indices */
  spots: number[];
  /** the world's state for this town (freed flag, capture progress) */
  state: TownState | null;
  /** frame the director saw it freed, -1 while held */
  freedAt: number;
  /** frame its counterattack is due */
  counterAt: number;
  counters: number;
}

export interface Unit {
  id: number;
  t: Tank;
  g: Group;
  /** spawn order inside the group: column position and line slot */
  idx: number;
  spot: number;
  goal: number;
  exitNode: number;
  field: NodeField | null;
  fieldGoal: number;
  order: number;
  face: number;
  want: number;
  trailIdx: number;
  sees: boolean;
  aware: boolean;
  tp: Tank | null;
  seenT: number;
  react: number;
  lastAware: number;
  lastHp: number;
  engaged: boolean;
  retreat: boolean;
  gone: boolean;
  wantsMove: boolean;
  speedCap: number;
  waitT: number;
  detourUntil: number;
  still: number;
  maxStill: number;
  /** morale: 0 on duty, 1 driving to a depot, 2 repairing there */
  mor: number;
  depot: number;
  depotSpot: number;
  repairUntil: number;
  moraleRolled: boolean;
  bailRolled: boolean;
}

export interface Group {
  id: number;
  job: Job;
  call: string;
  town: TownAI | null;
  members: Unit[];
  pending: { etype: number; spot: number }[];
  size: number;
  spawnedN: number;
  lost: number;
  phase: Phase;
  phaseAt: number;
  /** target tank position (px top-left) and its node */
  target: [number, number];
  targetNode: number;
  entry: [number, number];
  exitNode: number;
  trail: number[];
  leaderId: number;
  adir: number;
  deployBase: number;
  retargetAt: number;
  lastContact: number;
  toldNear: boolean;
  known: Known | null;
  revealUntil: number;
  speed: number;
  /** Phase 2: an assault sent to retake a freed town */
  counter: boolean;
  /** frames the counterattack has held the flag area with no player in the town */
  holdT: number;
  ow: Overwatch | null;
  /** Phase 4 boss hook: an escort group keeps station ahead of its boss (centre x, y and facing) */
  escort: (() => [number, number, number]) | null;
}

export class AiDirector {
  /** True when the region has towns: the director spawns and drives every enemy. */
  readonly active: boolean;
  towns: TownAI[] = [];
  groups: Group[] = [];
  units = new Map<Tank, Unit>();
  /** most recent player position any group learned (sighting or shot) */
  known: Known | null = null;
  /** event log for the sim (frame-stamped) */
  log: string[] = [];
  stats = {
    ms: 0, msMax: 0, msSum: 0, n: 0, fields: 0, fieldMs: 0, driveMs: 0, maxEngaged: 0, killed: 0, escaped: 0, spawned: 0, assaults: 0, shots: 0,
    counters: 0, retakes: 0, overwatches: 0, owShots: 0, owMoves: 0, glints: 0, toDepot: 0, repaired: 0, bails: 0, captured: 0, scuttled: 0,
  };
  /**
   * Hulls players captured, oldest first. The run flow consumes it: each entry becomes one captured part, then it
   * empties the array (`ai.capturedHulls.length = 0`). The director only ever pushes.
   */
  capturedHulls: CapturedHull[] = [];
  /** abandoned tanks on the map */
  hulls = new Map<Tank, Hull>();
  depots: DepotAI[] = [];
  /** the counterattack under way, if any */
  counter: Group | null = null;
  /** the overwatch group on the map, if any */
  overwatch: Group | null = null;
  nw = 0;
  nh = 0;
  /** per node: 1 brick, 2 blocked (steel/water, abandoned hulls, standing depot targets) */
  flags = new Uint8Array(0);
  /** per node: road cells under a tank there (0-16); 16 on the road graph */
  road = new Uint8Array(0);
  exits: { x: number; y: number; road: boolean }[] = [];
  private gridVer = -1;
  private gridAt = -1000;
  /** standing run-flow depot targets when the grid was last built (a destroyed one stops blocking) */
  private depotsUp = 0;
  private graph = new Uint8Array(0);
  private fields = new Map<number, NodeField>();
  private buckets: number[][] = [];
  private shots = new WeakSet<Bullet>();
  private due: { town: TownAI; at: number }[] = [];
  private inited = false;
  private nextId = 1;
  private lastPressure = 0;
  private callN = 0;
  private counterNext = 0;
  /** frame the next overwatch may set off; -1 until the first town is freed */
  private owNext = -1;
  private owField: NodeField | null = null;

  constructor(private w: World) {
    this.active = !!w.region?.towns?.length;
  }

  /** Difficulty ease from the run flow (World.ease: up to 0.3 after retreats, below 0 in the last regions, where the
   * enemy is quicker; save.ts easeFor sets it). */
  get ease(): number {
    const e = this.w.ease;
    return Number.isFinite(e) ? Math.max(-0.2, Math.min(0.5, e)) : 0;
  }

  /** How many tanks may fight at once: 6, down to 4 at full ease. */
  engageCap(): number {
    return Math.max(2, Math.round(AI.maxEngaging * (1 - this.ease)));
  }

  /** Reaction delay in frames before the first shot at a newly seen player (x1.6 at full ease). */
  reaction(min = AI.reactMin, max = AI.reactMax): number {
    return Math.round((min + randInt(max - min + 1)) * (1 + 2 * this.ease));
  }

  /**
   * Phase 3 tricks hook: a spotter drone reported a player at (x, y) (tank top-left). Groups with a tank within
   * 360 px learn where the player is (as if they had seen a shot), and a column is sent at the spot within ~8 s if
   * none is under way (the usual pressure rule, brought forward).
   */
  spotted(x: number, y: number): void {
    if (!this.active) return;
    const f = this.w.frame;
    this.known = { x, y, t: f };
    for (const g of this.groups) {
      if (!g.members.some((m) => !m.gone && Math.hypot(m.t.x - x, m.t.y - y) < 360)) continue;
      g.revealUntil = f + AI.revealT * 2;
      g.known = { x, y, t: f };
    }
    this.lastPressure = Math.min(this.lastPressure, f - AI.pressureEvery + 60 * 8);
    this.logEv(`spotted by drone at ${Math.round(x)},${Math.round(y)}`);
  }

  /** True for an abandoned tank (crew bailed): not hostile, lights out, doesn't hold a town. */
  isHull(t: Tank): boolean {
    return this.hulls.has(t);
  }

  // ---------- per update ----------
  update(): void {
    if (!this.active) return;
    const t0 = performance.now();
    const w = this.w;
    const f = w.frame;
    if (!this.inited) this.init();
    if (w.map.version !== this.gridVer && f - this.gridAt >= 60) this.buildGrid();
    if (this.standingDepots() !== this.depotsUp) this.markHulls(true); // a depot target went up: open its nodes
    this.scanShots();
    this.prune();
    if (f % 30 === 0 || f <= 1) {
      this.checkTowns();
      this.checkFreed();
      this.counterattacks();
    }
    this.dueAssaults();
    if (f % 60 === 0) this.pressure();
    if (f % 60 === 30) this.overwatchTick();
    if (this.hulls.size) this.updateHulls();
    for (const g of this.groups) this.spawnPending(g);
    for (const g of this.groups) if ((f + g.id) % 6 === 0) this.updateGroup(g);
    for (const u of this.units.values()) if ((f + u.id) % 6 === 0 && !u.gone) this.think(u);
    if (f % 6 === 0) this.allocate();
    const ms = performance.now() - t0;
    const s = this.stats;
    s.ms = ms;
    s.msSum += ms;
    s.n++;
    s.msMax = Math.max(s.msMax, ms);
  }

  /** Steer, move and fire one of the director's tanks. False = not ours (world runs its own logic). */
  drive(e: Tank): boolean {
    if (this.hulls.has(e)) return true; // abandoned: sits still, never fires
    if (this.w.tricks?.owns(e)) return true; // Phase 3 tricks hook: convoy escorts are driven by tricks.ts
    const u = this.units.get(e);
    if (!u || u.gone) return false;
    const t0 = performance.now();
    this.driveUnit(u);
    this.stats.driveMs += performance.now() - t0;
    return true;
  }

  private driveUnit(u: Unit): void {
    const e = u.t;
    const w = this.w;
    const E = ENEMY[e.etype];
    const atNode = Math.abs(e.x - Math.round(e.x / 8) * 8) < EPS && Math.abs(e.y - Math.round(e.y / 8) * 8) < EPS;
    // a player in this tank's line: stop on the node and turn to face (fires after the reaction delay)
    let aim = -1;
    const owMoving = !!u.g.ow && u.g.phase !== 'set';
    if (u.engaged && u.tp && !u.retreat && u.mor !== 1 && !owMoving && atNode) aim = this.lineTo(e, u.tp, this.sightOf(u));
    if (aim >= 0) {
      w.turn(e, aim);
      u.want = -1;
      u.wantsMove = false;
    } else if (atNode || e.blocked || (u.want < 0 && (w.frame + u.id) % 6 === 0)) {
      const d = this.steer(u);
      if (u.gone) return;
      u.want = d;
      if (d >= 0) w.turn(e, d);
      else if (u.face >= 0 && atNode) w.turn(e, u.face);
    }
    let moved = false;
    if (u.want >= 0) {
      const vertical = e.dir === UP || e.dir === DOWN;
      const along = vertical ? e.y : e.x;
      const sgn = e.dir === RIGHT || e.dir === DOWN ? 1 : -1;
      const next = sgn > 0 ? Math.floor(along / 8 + 1e-6) * 8 + 8 : Math.ceil(along / 8 - 1e-6) * 8 - 8;
      moved = w.move(e, Math.min(E.speed, u.speedCap, Math.abs(next - along)));
      e.blocked = !moved;
      e.stuck = moved ? 0 : e.stuck + 1;
    } else {
      e.blocked = false;
      e.stuck = 0;
    }
    const g = u.g;
    if (moved && g.phase === 'column' && g.leaderId === u.id) {
      const n = this.nodeOf(e);
      if (g.trail[g.trail.length - 1] !== n) g.trail.push(n);
    }
    u.still = u.wantsMove && !moved ? u.still + 1 : 0;
    if (u.still > u.maxStill) u.maxStill = u.still;
    if (e.aiFire > 0) e.aiFire--;
    else if (this.wantsFire(u) && w.fire(e)) {
      e.aiFire = (24 + rand() * 50) / E.fire;
      this.stats.shots++;
      const ow = g.ow;
      if (ow) {
        // deliberate shots: one per aim, a second apart at least
        ow.shots++;
        ow.lastShot = w.frame;
        ow.aimAt = -1;
        e.aiFire = 60;
        this.stats.owShots++;
      }
    }
  }

  private sightOf(u: Unit): number {
    return u.g.job === 'overwatch' ? AI.owSight : AI.sight;
  }

  // ---------- setup ----------
  private init(): void {
    this.inited = true;
    const w = this.w;
    const r = w.region!;
    this.nw = w.map.nodesX;
    this.nh = w.map.nodesY;
    this.graph = new Uint8Array(this.nw * this.nh);
    const roads = r.roads;
    const deg = new Map<number, number>();
    if (roads) {
      for (const [a, b] of roads.edges) {
        const A = roads.nodes[a];
        const B = roads.nodes[b];
        if (!A || !B) continue;
        deg.set(a, (deg.get(a) ?? 0) + 1);
        deg.set(b, (deg.get(b) ?? 0) + 1);
        // straight runs; a diagonal pair is drawn as an L (x first)
        let [x, y] = A;
        this.markGraph(x, y);
        while (x !== B[0]) { x += Math.sign(B[0] - x); this.markGraph(x, y); }
        while (y !== B[1]) { y += Math.sign(B[1] - y); this.markGraph(x, y); }
      }
      // road exits: dead ends near the map border
      roads.nodes.forEach(([nx, ny], i) => {
        if ((deg.get(i) ?? 0) > 1) return;
        if (nx > 3 && ny > 3 && nx < this.nw - 4 && ny < this.nh - 4) return;
        this.exits.push({ x: Math.min(nx, this.nw - 1) * 8, y: Math.min(ny, this.nh - 1) * 8, road: true });
      });
    }
    for (const [x, y] of r.enemySpawns) {
      if (!this.exits.some((q) => Math.abs(q.x - x) < 16 && Math.abs(q.y - y) < 16)) this.exits.push({ x, y, road: false });
    }
    this.buildGrid();
    (r.towns ?? []).forEach((t, i) => {
      const [x, y, tw, th] = t.rect;
      const L = AI.leash;
      const town: TownAI = {
        def: t, call: GARRISON_CALLS[i % GARRISON_CALLS.length] + (i >= GARRISON_CALLS.length ? String(i) : ''),
        garrison: null, activated: false, spent: false, helpAt: -INF,
        leash: [x - L, y - L, x + tw + L, y + th + L], spots: [],
        state: w.towns.find((s) => s.name === t.name) ?? w.towns[i] ?? null, freedAt: -1, counterAt: INF, counters: 0,
      };
      for (const [sx, sy] of t.garrison ?? []) {
        const n = this.nodeAt(sx, sy);
        if (!(this.flags[n] & 2) && !town.spots.includes(n)) town.spots.push(n);
      }
      if (town.spots.length < 2) town.spots.push(...this.fallbackSpots(town, 3 - town.spots.length));
      this.towns.push(town);
    });
    for (const d of r.depots ?? []) {
      // repair spots: open nodes inside the depot walls, nearest the middle first, 24 px apart
      const [x, y, dw, dh] = d.rect;
      const cand: { i: number; s: number }[] = [];
      for (let ny = Math.ceil(y / 8); ny * 8 + 16 <= y + dh; ny++) {
        for (let nx = Math.ceil(x / 8); nx * 8 + 16 <= x + dw; nx++) {
          if (nx >= this.nw || ny >= this.nh) continue;
          const i = ny * this.nw + nx;
          if (this.flags[i]) continue;
          cand.push({ i, s: Math.hypot(nx * 8 + 8 - d.cx, ny * 8 + 8 - d.cy) });
        }
      }
      cand.sort((a, b) => a.s - b.s);
      const spots: number[] = [];
      for (const c of cand) {
        if (spots.length >= 4) break;
        if (spots.some((o) => this.nodeDist(o, c.i) < 3)) continue;
        spots.push(c.i);
      }
      if (!spots.length) spots.push(this.nearestOpen(Math.round((d.cx - 8) / 8), Math.round((d.cy - 8) / 8)));
      this.depots.push({ def: d, node: spots[0], spots });
    }
  }

  private markGraph(nx: number, ny: number): void {
    if (nx < 0 || ny < 0 || nx >= this.nw || ny >= this.nh) return;
    this.graph[ny * this.nw + nx] = 1;
  }

  /** Node classes from the cell map: brick / blocked flags and road cover (2x2-cell blocks, 4 per node). */
  private buildGrid(): void {
    const m = this.w.map;
    const W = m.w;
    const bw = m.w >> 1;
    const bh = m.h >> 1;
    const bf = new Uint8Array(bw * bh);
    const br = new Uint8Array(bw * bh);
    const c = m.c;
    for (let by = 0; by < bh; by++) {
      for (let bx = 0; bx < bw; bx++) {
        let fl = 0;
        let rd = 0;
        for (let oy = 0; oy < 2; oy++) {
          const row = (by * 2 + oy) * W + bx * 2;
          for (let ox = 0; ox < 2; ox++) {
            const t = c[row + ox];
            if (t === ROAD) rd++;
            else if (t === BRICK) fl |= 1;
            else if (t === STEEL || t === WATER) fl |= 2;
          }
        }
        bf[by * bw + bx] = fl;
        br[by * bw + bx] = rd;
      }
    }
    const nw = this.nw;
    const nh = this.nh;
    if (this.flags.length !== nw * nh) {
      this.flags = new Uint8Array(nw * nh);
      this.road = new Uint8Array(nw * nh);
    }
    for (let ny = 0; ny < nh; ny++) {
      for (let nx = 0; nx < nw; nx++) {
        const a = ny * bw + nx;
        const i = ny * nw + nx;
        this.flags[i] = bf[a] | bf[a + 1] | bf[a + bw] | bf[a + bw + 1];
        this.road[i] = this.graph[i] ? 16 : br[a] + br[a + 1] + br[a + bw] + br[a + bw + 1];
      }
    }
    this.gridVer = m.version;
    this.gridAt = this.w.frame;
    if (this.hulls.size) this.markHulls(false);
    this.markDepots();
  }

  /** Block the nodes a 16 px box at (x, y) overlaps (flag 2, like steel). */
  private markBox(x: number, y: number): void {
    for (let ny = Math.ceil((y - 16) / 8 + EPS); ny * 8 < y + 16 - EPS; ny++) {
      for (let nx = Math.ceil((x - 16) / 8 + EPS); nx * 8 < x + 16 - EPS; nx++) {
        if (nx >= 0 && ny >= 0 && nx < this.nw && ny < this.nh) this.flags[ny * this.nw + nx] |= 2;
      }
    }
  }

  private standingDepots(): number {
    let n = 0;
    for (const d of this.w.depots) if (!d.destroyed) n++;
    return n;
  }

  /**
   * The run flow's depot targets (World.depots, 16 x 16 at the depot centre) block tanks (World.depotBlocks), so
   * routes and repair spots go round them while they stand.
   */
  private markDepots(): void {
    for (const d of this.w.depots) if (!d.destroyed) this.markBox(d.cx - 8, d.cy - 8);
    this.depotsUp = this.standingDepots();
  }

  /**
   * Abandoned hulls block the nodes they overlap (flag 2, like steel), so routes and column trails go round them.
   * `fresh`: the hull set changed, so drop the cached fields that may run through (or round) a hull.
   */
  private markHulls(fresh: boolean): void {
    if (fresh) {
      // rebuild flags from the cell map (clears hulls that are gone), then mark the live ones
      this.buildGrid();
      for (const fd of this.fields.values()) { fd.at = -INF; fd.ver = -1; }
      for (const u of this.units.values()) if (u.field) u.field.at = -INF;
      return;
    }
    for (const h of this.hulls.values()) this.markBox(h.t.x, h.t.y);
  }

  /** Up to n open nodes inside the town, preferring ones next to brick (behind walls), 32 px apart. */
  private fallbackSpots(town: TownAI, n: number): number[] {
    const [x, y, tw, th] = town.def.rect;
    const cand: { i: number; s: number }[] = [];
    for (let ny = Math.ceil(y / 8); ny * 8 + 16 <= y + th; ny++) {
      for (let nx = Math.ceil(x / 8); nx * 8 + 16 <= x + tw; nx++) {
        if (nx >= this.nw || ny >= this.nh) continue;
        const i = ny * this.nw + nx;
        if (this.flags[i] || this.road[i] >= 12) continue;
        let s = 0;
        for (let d = 0; d < 4; d++) if (this.flags[(ny + DY[d] * 2) * this.nw + nx + DX[d] * 2] & 1) s += 2;
        cand.push({ i, s: s + rand() });
      }
    }
    cand.sort((a, b) => b.s - a.s);
    const out: number[] = [...town.spots];
    for (const c of cand) {
      if (out.length >= town.spots.length + n) break;
      if (out.some((o) => Math.abs((o % this.nw) - (c.i % this.nw)) + Math.abs(((o / this.nw) | 0) - ((c.i / this.nw) | 0)) < 4)) continue;
      out.push(c.i);
    }
    return out.slice(town.spots.length);
  }

  // ---------- towns, help calls, assaults ----------
  private checkTowns(): void {
    const w = this.w;
    const pl = w.livePlayers();
    if (!this.towns.some((t) => t.activated) && w.region) {
      // man the towns nearest the start right away so the first fights are ready
      const [sx, sy] = w.region.playerSpawns[0];
      const near = [...this.towns].sort((a, b) => Math.hypot(a.def.cx - sx, a.def.cy - sy) - Math.hypot(b.def.cx - sx, b.def.cy - sy));
      for (const t of near.slice(0, AI.startTowns)) this.activate(t);
    }
    for (const t of this.towns) {
      if (!t.activated && !t.spent && pl.some((p) => Math.hypot(p.cx - t.def.cx, p.cy - t.def.cy) < AI.activateR)) this.activate(t);
      const g = t.garrison;
      if (g && g.members.length && pl.some((p) => this.inRect(p.cx, p.cy, t.def.rect))) this.callHelp(t, 'entered');
    }
  }

  /** tests: switch the gentle start off */
  gentleOff = false;

  /** The first minute of Farmland and Winter Front: nothing is sent at the player yet. */
  private gentle(): boolean {
    return !this.gentleOff && this.w.frame < AI.gentleT && AI.gentleRegions.includes(this.w.stage - 1);
  }

  private activate(t: TownAI): void {
    if (t.activated || t.spent) return;
    if (this.w.towns.some((s) => s.name === t.def.name && s.freed)) {
      t.spent = true;
      return;
    }
    // gentle start: keep the garrison out of sight of the start road (spots 200+ px from every player spawn)
    let usable = t.spots.map((_, i) => i);
    if (this.gentle() && this.w.region) {
      const sp = this.w.region.playerSpawns;
      usable = usable.filter((i) => {
        const x = (t.spots[i] % this.nw) * 8 + 8;
        const y = ((t.spots[i] / this.nw) | 0) * 8 + 8;
        return sp.every(([sx, sy]) => Math.hypot(sx + 8 - x, sy + 8 - y) >= AI.gentleSpawnR);
      });
    }
    const n = Math.min(AI.garrisonByRegion[this.w.stage - 1] ?? AI.garrisonSize, usable.length, this.budget());
    if (n < 1) return; // try again on a later check
    t.activated = true;
    const g = this.newGroup('garrison', t.call, t);
    g.phase = 'hold';
    // spread the members over the spots (random pick)
    const spots = usable.sort(() => rand() - 0.5).slice(0, n);
    for (const s of spots) g.pending.push({ etype: this.w.queue.shift()!, spot: s });
    g.size = n;
    g.target = [t.def.cx - 8, t.def.cy - 8];
    g.targetNode = this.nodeAt(g.target[0], g.target[1]);
    t.garrison = g;
    this.logEv(`garrison ${g.call} x${n} at ${t.def.name}`);
  }

  private callHelp(t: TownAI, why: 'hit' | 'entered'): void {
    const f = this.w.frame;
    if (f - t.helpAt < AI.helpCooldown) return;
    if (this.due.some((d) => d.town === t)) return;
    if (this.groups.some((g) => g.job === 'assault' && g.town === t && g.phase !== 'retreat' && g.phase !== 'leave')) return;
    t.helpAt = f;
    this.radio(`${t.call}: ${why === 'hit' ? 'TAKING FIRE AT' : 'ENEMY TANK IN'} ${t.def.name}. SEND HELP.`);
    this.due.push({ town: t, at: f + AI.helpDelay });
  }

  private dueAssaults(): void {
    const f = this.w.frame;
    for (let i = this.due.length - 1; i >= 0; i--) {
      const d = this.due[i];
      if (f < d.at) continue;
      if (this.launchAssault(d.town.def.cx - 8, d.town.def.cy - 8, d.town)) this.due.splice(i, 1);
      else d.at = f + 120;
    }
  }

  /** Keep the region alive: send a column at the last place the player was seen. */
  private pressure(): void {
    const f = this.w.frame;
    // (eased regions and attempts space the columns out: x1.5 at 25% ease)
    if (f - this.lastPressure < AI.pressureEvery * (1 + 2 * this.ease) || !this.known || f - this.known.t > 60 * 20) return;
    if (this.groups.some((g) => g.job === 'assault') || this.due.length) return;
    if (this.launchAssault(this.known.x, this.known.y, null)) this.lastPressure = f;
  }

  /** Send a road column at (tx, ty). counterN > 0: a counterattack of that many tanks to retake `town`. */
  private launchAssault(tx: number, ty: number, town: TownAI | null, counterN = 0): Group | null {
    const w = this.w;
    if (this.gentle()) return null;
    let n = counterN || 2 + (rand() < 0.5 ? 1 : 0) + (rand() < 0.15 ? 1 : 0);
    n = Math.min(n, this.budget());
    if (n < 2) return null;
    const tn = this.nodeAt(tx, ty);
    const entry = this.pickEntry(tn);
    if (!entry) return null;
    const call = ASSAULT_CALLS[this.callN % ASSAULT_CALLS.length] + (this.callN >= ASSAULT_CALLS.length ? String(this.callN) : '');
    this.callN++;
    const g = this.newGroup('assault', call, town);
    g.phase = 'column';
    g.target = [tx, ty];
    g.targetNode = tn;
    g.entry = entry;
    g.exitNode = this.nodeAt(entry[0], entry[1]);
    g.trail = [g.exitNode];
    for (let i = 0; i < n; i++) g.pending.push({ etype: w.queue.shift()!, spot: -1 });
    g.size = n;
    g.speed = Math.min(...g.pending.map((p) => ENEMY[p.etype].speed));
    this.stats.assaults++;
    if (counterN && town) {
      g.counter = true;
      this.stats.counters++;
      this.radio(`${call}: MOVING TO RETAKE ${town.def.name}.`);
    } else {
      this.radio(`${call}: COLUMN MOVING ON ${town ? town.def.name : 'LAST CONTACT'}.`);
    }
    this.rumble(entry[0], entry[1]);
    this.logEv(`${g.counter ? 'counterattack' : 'assault'} ${call} x${n} from ${entry} to ${town?.def.name ?? `${tx},${ty}`}`);
    return g;
  }

  /** Entry point for a column: an exit at least 220 px from every player, shortest road route to the target. */
  private pickEntry(targetNode: number): [number, number] | null {
    const w = this.w;
    const pl = w.livePlayers();
    const fd = this.field(targetNode, true);
    let best: [number, number] | null = null;
    let bs = INF;
    let far: [number, number] | null = null;
    let fdist = -1;
    for (const q of this.exits) {
      if (w.tankIn(q.x, q.y, 16, 16)) continue;
      let dmin = INF;
      for (const p of pl) dmin = Math.min(dmin, Math.hypot(q.x - p.x, q.y - p.y));
      const dn = fd.d[this.nodeAt(q.x, q.y)];
      if (dn >= INF) continue;
      if (dmin > fdist) { fdist = dmin; far = [q.x, q.y]; }
      if (dmin < AI.spawnMinDist) continue;
      const s = dn + (q.road ? 0 : 20);
      if (s < bs) { bs = s; best = [q.x, q.y]; }
    }
    return best ?? far;
  }

  private budget(): number {
    const w = this.w;
    let pend = 0;
    for (const g of this.groups) pend += g.pending.length;
    // abandoned hulls don't count against the cap
    const alive = w.enemies.filter((e) => e.alive).length - this.hulls.size;
    return Math.max(0, Math.min(AI.maxAlive - alive - pend, w.queue.length));
  }

  private newGroup(job: Job, call: string, town: TownAI | null): Group {
    const g: Group = {
      id: this.nextId++, job, call, town, members: [], pending: [], size: 0, spawnedN: 0, lost: 0,
      phase: 'hold', phaseAt: this.w.frame, target: [0, 0], targetNode: 0, entry: [0, 0], exitNode: 0, trail: [],
      leaderId: -1, adir: DOWN, deployBase: 0, retargetAt: 0, lastContact: -INF, toldNear: false, known: null,
      revealUntil: 0, speed: 9, counter: false, holdT: 0, ow: null, escort: null,
    };
    this.groups.push(g);
    return g;
  }

  private spawnPending(g: Group): void {
    if (!g.pending.length) return;
    const w = this.w;
    if (g.job === 'garrison') {
      for (let i = g.pending.length - 1; i >= 0; i--) {
        const p = g.pending[i];
        const n = g.town!.spots[p.spot];
        const x = (n % this.nw) * 8;
        const y = ((n / this.nw) | 0) * 8;
        if (w.tankIn(x, y, 16, 16)) continue;
        const u = this.spawnTank(g, p.etype, x, y, this.outward(g.town!, n));
        u.spot = n;
        g.pending.splice(i, 1);
      }
      return;
    }
    // assault: one at a time through the entry, each once the one before is a column gap away
    const [x, y] = g.entry;
    if (w.tankIn(x, y, 16, 16)) return;
    const last = g.members[g.members.length - 1];
    if (last && !last.gone && last.t.alive && Math.hypot(last.t.x - x, last.t.y - y) < AI.spacing) return;
    const p = g.pending.shift()!;
    const fd = this.field(g.targetNode, true);
    const n = this.nodeAt(x, y);
    const d0 = this.downhill(fd, n, DOWN);
    const u = this.spawnTank(g, p.etype, x, y, d0 >= 0 ? d0 : DOWN);
    u.trailIdx = 0;
    u.exitNode = g.exitNode;
    if (g.leaderId < 0) g.leaderId = u.id;
  }

  private spawnTank(g: Group, etype: number, x: number, y: number, dir: number): Unit {
    const w = this.w;
    const e = new Tank();
    e.x = x;
    e.y = y;
    e.dir = dir;
    e.etype = etype;
    e.hp = ENEMY[etype].hp;
    e.spawn = 60;
    e.persona = 2;
    w.spawned++;
    e.bonus = !w.region && (w.spawned === 4 || w.spawned === 11 || w.spawned === 18); // arcade only
    w.enemies.push(e);
    const u: Unit = {
      id: this.nextId++, t: e, g, idx: g.spawnedN++, spot: -1, goal: -1, exitNode: g.exitNode, field: null, fieldGoal: -1,
      order: HOLD, face: dir, want: -1, trailIdx: 0, sees: false, aware: false, tp: null, seenT: 0, react: AI.reactMax,
      lastAware: -INF, lastHp: e.hp, engaged: false, retreat: false, gone: false, wantsMove: false, speedCap: 99,
      waitT: 0, detourUntil: 0, still: 0, maxStill: 0,
      mor: 0, depot: -1, depotSpot: -1, repairUntil: 0, moraleRolled: false, bailRolled: false,
    };
    this.units.set(e, u);
    g.members.push(u);
    this.stats.spawned++;
    return u;
  }

  /** Drop dead or departed tanks; a killed garrison member radios for help. */
  private prune(): void {
    for (const [t, u] of this.units) {
      if (t.alive) continue;
      this.units.delete(t);
      const g = u.g;
      g.members.splice(g.members.indexOf(u), 1);
      if (!u.gone) {
        if (!u.retreat && !u.mor) g.lost++; // a retreating (or depot-bound) tank was already counted as lost
        this.stats.killed++;
        this.logEv(`${g.call}-${u.idx + 1} destroyed`);
        if (g.job === 'garrison' && g.town) this.callHelp(g.town, 'hit');
      }
    }
    for (let i = this.groups.length - 1; i >= 0; i--) {
      const g = this.groups[i];
      if (g.members.length || g.pending.length) continue;
      this.groups.splice(i, 1);
      if (g.town && g.town.garrison === g) {
        g.town.garrison = null;
        g.town.spent = true;
      }
      if (g === this.counter) this.endCounter(g, false);
      if (g === this.overwatch) this.endOverwatch();
    }
  }

  // ---------- groups ----------
  private setPhase(g: Group, p: Phase): void {
    g.phase = p;
    g.phaseAt = this.w.frame;
    this.logEv(`${g.call} ${p}`);
  }

  private leader(g: Group): Unit | null {
    for (const m of g.members) if (this.onDuty(m)) return m;
    return null;
  }

  /** In the fight: alive, not pulling back, not off to a depot. */
  private onDuty(m: Unit): boolean {
    return !m.gone && m.t.alive && !m.retreat && !m.mor;
  }

  private updateGroup(g: Group): void {
    const w = this.w;
    const f = w.frame;
    if (g.job === 'overwatch') {
      this.updateOverwatch(g);
      return;
    }
    if (g.job !== 'assault') return;
    if (g.escort) {
      this.updateEscort(g); // Phase 4 boss hook
      return;
    }
    const live = g.members.filter((m) => !m.gone && m.t.alive);
    if (!live.length) return;
    if (g.phase !== 'retreat' && g.phase !== 'leave' && g.size >= 2 && g.lost * 2 >= g.size) {
      this.setPhase(g, 'retreat');
      g.pending.length = 0;
      // morale: with a depot standing, the survivors fall back there to repair instead of leaving the map
      let dep = -1;
      for (const m of live) {
        if (m.retreat || m.mor) continue;
        const d = this.pickDepot(m.t);
        if (d >= 0) {
          dep = d;
          this.toDepot(m, d);
        }
      }
      this.radio(`${g.call}: TOO HOT. FALLING BACK${dep >= 0 ? ` TO ${this.depots[dep].def.name}` : ''}.`);
      if (g === this.counter) this.endCounter(g, false);
      return;
    }
    const L = this.leader(g);
    if (!L) return;
    if (g.phase === 'column') {
      if (g.leaderId !== L.id) {
        // a new leader: the trail continues from where it is
        g.leaderId = L.id;
        g.trail.length = Math.min(g.trail.length, L.trailIdx + 1);
        const n = this.nodeOf(L.t);
        if (g.trail[g.trail.length - 1] !== n) g.trail.push(n);
      }
      const contact = live.find((m) => m.sees);
      if (contact && g.known) {
        g.target = [g.known.x, g.known.y];
        g.targetNode = this.nodeAt(g.known.x, g.known.y);
        this.deploy(g, L);
      } else if (L.t.spawn === 0 && Math.hypot(L.t.x - g.target[0], L.t.y - g.target[1]) <= AI.deployR) {
        this.deploy(g, L);
      } else if (!g.toldNear && L.t.spawn === 0) {
        const p = this.nearestPlayer(L.t);
        if (p && Math.hypot(p.cx - L.t.cx, p.cy - L.t.cy) < 260) {
          g.toldNear = true;
          this.rumble(L.t.x, L.t.y);
        }
      }
    } else if (g.phase === 'deploy') {
      const ready = live.every((m) => m.t.spawn === 0 && (m.goal < 0 || this.nodeOf(m.t) === m.goal || m.retreat || m.mor));
      if (ready || f - g.phaseAt > 240) {
        this.setPhase(g, 'advance');
        g.retargetAt = f;
      }
    } else if (g.phase === 'advance' && g.counter && g.town) {
      this.updateCounter(g, L, live);
    } else if (g.phase === 'advance') {
      const k = g.known;
      if (k && f - k.t < 240 && f - g.retargetAt > 90 && Math.hypot(k.x - g.target[0], k.y - g.target[1]) > 40) {
        g.target = [k.x, k.y];
        g.targetNode = this.nodeAt(k.x, k.y);
        g.retargetAt = f;
        const dx = k.x - L.t.x;
        const dy = k.y - L.t.y;
        if (Math.max(Math.abs(dx), Math.abs(dy)) > 24) g.adir = this.domDir(dx, dy);
      }
      if (f - Math.max(g.lastContact, g.phaseAt) > AI.quietJoin) {
        if (g.town && !g.town.spent) this.joinGarrison(g);
        else this.setPhase(g, 'leave');
      }
    }
  }

  private deploy(g: Group, L: Unit): void {
    g.adir = this.domDir(g.target[0] - L.t.x, g.target[1] - L.t.y);
    g.deployBase = this.nodeOf(L.t);
    g.pending.length = 0; // stragglers that never entered stay home
    this.setPhase(g, 'deploy');
    this.radio(`${g.call}: CONTACT. DEPLOYING IN LINE.`);
  }

  /** An assault that found nothing settles into the town it came to hold. */
  private joinGarrison(g: Group): void {
    const t = g.town!;
    const into = t.garrison && t.garrison !== g && t.garrison.members.length ? t.garrison : g;
    this.logEv(`${g.call} joins garrison at ${t.def.name}`);
    if (into === g) {
      g.job = 'garrison';
      this.setPhase(g, 'hold');
      t.garrison = g;
      t.activated = true;
    }
    for (const u of [...g.members]) {
      if (into !== g) {
        g.members.splice(g.members.indexOf(u), 1);
        u.g = into;
        into.members.push(u);
        into.size++;
      }
      const taken = into.members.filter((m) => m !== u).map((m) => m.spot);
      const free = t.spots.find((s) => !taken.includes(s));
      u.spot = free ?? this.nodeOf(u.t);
    }
    if (into !== g) this.groups.splice(this.groups.indexOf(g), 1);
  }

  /** Move a unit into another group (the old one is pruned once empty). */
  private moveUnit(u: Unit, to: Group): void {
    const from = u.g;
    if (from === to) return;
    const i = from.members.indexOf(u);
    if (i >= 0) from.members.splice(i, 1);
    u.g = to;
    to.members.push(u);
    to.size++;
  }

  /** A free garrison spot in town t for unit u (else the open node nearest the flag). */
  private assignSpot(u: Unit, t: TownAI, g: Group): void {
    const taken = g.members.filter((m) => m !== u).map((m) => m.spot);
    const free = t.spots.find((s) => !taken.includes(s));
    u.spot = free ?? this.nearestOpen(Math.round((t.def.cx - 8) / 8), Math.round((t.def.cy - 8) / 8));
  }

  private playerInTown(t: TownAI): boolean {
    return this.w.livePlayers().some((p) => this.inRect(p.cx, p.cy, t.def.rect));
  }

  // ---------- Phase 2: counterattacks on freed towns ----------
  /** Notice towns the players freed (and ones flipped back), and schedule their counterattacks. */
  private checkFreed(): void {
    const f = this.w.frame;
    for (const t of this.towns) {
      const s = t.state;
      if (!s) continue;
      if (s.freed && t.freedAt < 0) {
        t.freedAt = f;
        t.counterAt = f + AI.counterMin + randInt(AI.counterMax - AI.counterMin + 1);
        if (this.owNext < 0) this.owNext = f + AI.owFirstMin + randInt(AI.owFirstMax - AI.owFirstMin + 1);
        this.logEv(`${t.def.name} freed; counterattack due in ${((t.counterAt - f) / 60).toFixed(0)} s`);
      } else if (!s.freed && t.freedAt >= 0) {
        t.freedAt = -1;
        t.counterAt = INF;
      }
    }
  }

  /** One counterattack at a time, on the town that has waited longest, never while a player is inside it. */
  private counterattacks(): void {
    const f = this.w.frame;
    if (this.counter || f < this.counterNext) return;
    let best: TownAI | null = null;
    for (const t of this.towns) {
      if (t.freedAt < 0 || f < t.counterAt || t.counters >= AI.counterPerTown) continue;
      if (this.playerInTown(t)) continue;
      if (!best || t.counterAt < best.counterAt) best = t;
    }
    if (!best) return;
    const freedN = this.towns.filter((t) => t.freedAt >= 0).length;
    const n = Math.max(2, Math.min(4, 1 + freedN));
    const g = this.launchAssault(best.def.cx - 8, best.def.cy - 8, best, n);
    if (!g) {
      best.counterAt = f + 60 * 5; // no tanks to spare (or no way in): try again shortly
      return;
    }
    best.counters++;
    this.counter = g;
  }

  /** A counterattack advancing on its town: fight what it sees, otherwise take and hold the flag. */
  private updateCounter(g: Group, L: Unit, live: Unit[]): void {
    const t = g.town!;
    const f = this.w.frame;
    if (t.state && !t.state.freed) {
      // the town is held again already: just stay as its garrison
      this.retake(g);
      return;
    }
    const k = g.known;
    if (k && f - k.t < 240) {
      if (f - g.retargetAt > 90 && Math.hypot(k.x - g.target[0], k.y - g.target[1]) > 40) {
        g.target = [k.x, k.y];
        g.targetNode = this.nodeAt(k.x, k.y);
        g.retargetAt = f;
        const dx = k.x - L.t.x;
        const dy = k.y - L.t.y;
        if (Math.max(Math.abs(dx), Math.abs(dy)) > 24) g.adir = this.domDir(dx, dy);
      }
    } else {
      const fx = t.def.cx - 8;
      const fy = t.def.cy - 8;
      const fn = this.nodeAt(fx, fy);
      if (g.targetNode !== fn && f - g.retargetAt > 90) {
        g.target = [fx, fy];
        g.targetNode = fn;
        g.retargetAt = f;
        const dx = fx - L.t.x;
        const dy = fy - L.t.y;
        if (Math.max(Math.abs(dx), Math.abs(dy)) > 24) g.adir = this.domDir(dx, dy);
      }
    }
    const atFlag = live.some((m) => this.onDuty(m) && m.t.spawn === 0 && Math.hypot(m.t.cx - t.def.cx, m.t.cy - t.def.cy) <= AI.flagR);
    if (atFlag && !this.playerInTown(t)) g.holdT += 6;
    else g.holdT = 0;
    if (g.holdT >= AI.counterHold) {
      this.retake(g);
      return;
    }
    if (f - g.phaseAt > 60 * 120 && f - g.lastContact > 60 * 20) {
      // never got there: give up and drive home
      this.setPhase(g, 'leave');
      this.endCounter(g, false);
    }
  }

  /** The counterattack held the flag: the town is theirs again and a small garrison stays. */
  private retake(g: Group): void {
    const t = g.town!;
    const s = t.state;
    const w = this.w;
    const f = w.frame;
    if (s && s.freed) {
      s.freed = false;
      s.progress = 0;
      if (w.checkpoint === s) {
        // respawn at the most recently freed town still ours (else the start)
        let cp: TownAI | null = null;
        for (const o of this.towns) if (o !== t && o.freedAt >= 0 && o.state?.freed && (!cp || o.freedAt > cp.freedAt)) cp = o;
        w.checkpoint = cp?.state ?? null;
      }
      // the first time the line from the design, later any of them
      this.say(RETAKEN[this.stats.retakes === 0 ? 0 : randInt(RETAKEN.length)].replace('{T}', t.def.name));
      w.note(`${t.def.name} LOST`, 'warn');
      this.stats.retakes++;
      this.logEv(`${g.call} retook ${t.def.name}`);
    }
    t.freedAt = -1;
    t.counterAt = INF;
    t.spent = false;
    t.activated = true;
    t.helpAt = f;
    // the tanks nearest the flag stay as the garrison; the rest drive home
    const duty = g.members.filter((m) => this.onDuty(m)).sort((a, b) =>
      Math.hypot(a.t.cx - t.def.cx, a.t.cy - t.def.cy) - Math.hypot(b.t.cx - t.def.cx, b.t.cy - t.def.cy));
    const rest = duty.slice(AI.retakeKeep);
    if (rest.length) {
      const lg = this.newGroup('assault', g.call, null);
      lg.phase = 'leave';
      lg.exitNode = g.exitNode;
      for (const m of rest) this.moveUnit(m, lg);
    }
    g.pending.length = 0;
    const into = t.garrison && t.garrison !== g && t.garrison.members.length ? t.garrison : g;
    if (into === g) {
      g.job = 'garrison';
      g.size = g.members.length;
      this.setPhase(g, 'hold');
      t.garrison = g;
    }
    for (const m of [...g.members]) {
      if (into !== g) this.moveUnit(m, into);
      this.assignSpot(m, t, into);
    }
    this.endCounter(g, true);
  }

  /** The counterattack is over (retaken, beaten back or gone home). */
  private endCounter(g: Group, retaken: boolean): void {
    if (this.counter !== g) return;
    const f = this.w.frame;
    this.counter = null;
    g.counter = false;
    this.counterNext = f + AI.counterGap;
    const t = g.town;
    if (!retaken && t && t.state?.freed) {
      this.say(`${t.def.name} HELD. THEY WILL BE BACK. PROBABLY.`);
      t.counterAt = f + AI.counterMin + randInt(AI.counterMax - AI.counterMin + 1);
      this.logEv(`counterattack on ${t.def.name} beaten`);
    }
  }

  // ---------- Phase 2: overwatch ----------
  private overwatchTick(): void {
    const w = this.w;
    const f = w.frame;
    if (this.owNext < 0 || this.overwatch || f < this.owNext || this.gentle()) return;
    const pl = w.livePlayers();
    if (!pl.length) return;
    if (this.budget() < 1) {
      this.owNext = f + 300;
      return;
    }
    const p = pl[randInt(pl.length)];
    const sp = this.pickSpot(p, -1, []);
    const entry = sp ? this.owEntry(sp.node) : null;
    if (!sp || !entry) {
      this.owNext = f + 600;
      return;
    }
    const call = OW_CALLS[this.stats.overwatches % OW_CALLS.length];
    const g = this.newGroup('overwatch', call, null);
    g.phase = 'move';
    g.entry = entry;
    g.exitNode = this.nodeAt(entry[0], entry[1]);
    g.targetNode = sp.node;
    g.target = [(sp.node % this.nw) * 8, ((sp.node / this.nw) | 0) * 8];
    // a power tank (fast shells) when the queue has one
    const qi = w.queue.indexOf(2);
    const etype = qi >= 0 ? w.queue.splice(qi, 1)[0] : w.queue.shift()!;
    g.pending.push({ etype, spot: -1 });
    g.size = 1;
    g.speed = ENEMY[etype].speed;
    g.ow = {
      spot: sp.node, face: sp.face, shots: 0, want: 2, moves: 0, arrivedAt: -1, pickedAt: f, lastShot: -INF, aimAt: -1,
      outOfLine: 0, told: false, history: [sp.node],
    };
    this.overwatch = g;
    this.stats.overwatches++;
    this.logEv(`overwatch ${call} from ${entry} to spot ${g.target} (player at ${Math.round(p.x)},${Math.round(p.y)})`);
  }

  /** Where the overwatch drives in: an exit 220+ px from every player, nearest (by route) to its spot. */
  private owEntry(spot: number): [number, number] | null {
    const w = this.w;
    const pl = w.livePlayers();
    const fd = this.field(spot, false);
    let best: [number, number] | null = null;
    let bs = INF;
    for (const q of this.exits) {
      if (w.tankIn(q.x, q.y, 16, 16)) continue;
      let dmin = INF;
      for (const p of pl) dmin = Math.min(dmin, Math.hypot(q.x - p.x, q.y - p.y));
      if (dmin < AI.spawnMinDist) continue;
      const d = fd.d[this.nodeAt(q.x, q.y)];
      if (d < bs) { bs = d; best = [q.x, q.y]; }
    }
    return best;
  }

  /**
   * A firing spot 144-200 px from player p along one of its four lines: open footprint, outside towns, a straight
   * line to the player with no brick or steel and at most a thin screen of leaves. Prefers open fields along the
   * line (the far side of a field), tree-line edges and, from `from` (node, -1 = anywhere), shorter drives.
   * Skips spots within 48 px of `avoid`.
   */
  pickSpot(p: Tank, from: number, avoid: number[]): { node: number; face: number } | null {
    const nw = this.nw;
    const pnx = Math.round(p.x / 8);
    const pny = Math.round(p.y / 8);
    let src: NodeField | null = null;
    if (from >= 0) {
      src = this.owField ??= new NodeField(nw * this.nh);
      this.compute(src, from, false, INF);
    }
    let best: { node: number; face: number } | null = null;
    let bs = -INF;
    for (let d = 0; d < 4; d++) {
      for (let k = Math.ceil(AI.owNear / 8); k <= Math.floor(AI.owFar / 8); k++) {
        const nx = pnx + DX[d] * k;
        const ny = pny + DY[d] * k;
        if (nx < 0 || ny < 0 || nx >= nw || ny >= this.nh) continue;
        const n = ny * nw + nx;
        if (this.flags[n]) continue;
        if (avoid.some((a) => this.nodeDist(a, n) < 6)) continue;
        const x = nx * 8;
        const y = ny * 8;
        if (x > this.w.pxW - 16 || y > this.w.pxH - 16) continue;
        if (this.towns.some((t) => this.rectNear(x, y, t.def.rect, 8))) continue;
        if (n !== from && this.w.tankIn(x, y, 16, 16)) continue;
        const open = this.lineQuality(x + 8, y + 8, pnx * 8 + 8, pny * 8 + 8);
        if (open < 0) continue;
        const route = src ? src.d[n] : 0;
        if (route >= INF) continue;
        let s = open * 40 - Math.abs(k * 8 - 172) * 0.2 - route * 0.12 + rand() * 6;
        if (this.treeEdge(nx, ny)) s += 8;
        if (s > bs) { bs = s; best = { node: n, face: (d + 2) % 4 }; }
      }
    }
    return best;
  }

  /** Straight line from (x0, y0) to (x1, y1): -1 if brick/steel or a hedgerow blocks it, else the open fraction. */
  private lineQuality(x0: number, y0: number, x1: number, y1: number): number {
    const m = this.w.map;
    const d = Math.hypot(x1 - x0, y1 - y0);
    const n = Math.max(1, Math.ceil(d / 4));
    let leaves = 0;
    let open = 0;
    for (let i = 1; i < n; i++) {
      const c = m.at(Math.floor((x0 + ((x1 - x0) * i) / n) / 4), Math.floor((y0 + ((y1 - y0) * i) / n) / 4));
      if (c === BRICK || c === STEEL) return -1;
      if (c === TREES) {
        if (i * 4 > 10) leaves++;
      } else if (c === EMPTY || c === ROAD || c === WATER) {
        open++;
      }
    }
    return leaves > 3 ? -1 : open / Math.max(1, n - 1);
  }

  /** Foliage right beside the node's footprint (a tree-line edge to sit against). */
  private treeEdge(nx: number, ny: number): boolean {
    const m = this.w.map;
    let n = 0;
    for (let y = ny * 2 - 1; y <= ny * 2 + 4; y++) {
      for (let x = nx * 2 - 1; x <= nx * 2 + 4; x++) {
        if (x >= nx * 2 && x < nx * 2 + 4 && y >= ny * 2 && y < ny * 2 + 4) continue;
        if (m.at(x, y) === TREES) n++;
      }
    }
    return n >= 3;
  }

  private ridgeWord(n: number): string {
    if (this.road[n] >= 12) return 'ROAD';
    return this.treeEdge(n % this.nw, (n / this.nw) | 0) ? 'TREE LINE' : 'RIDGE';
  }

  private updateOverwatch(g: Group): void {
    const ow = g.ow;
    const u = g.members[0];
    if (!ow || !u || u.gone || !u.t.alive || u.t.spawn || u.retreat || u.mor || g.phase === 'leave') return;
    const f = this.w.frame;
    const e = u.t;
    const n = this.nodeOf(e);
    const p = u.tp?.alive ? u.tp : this.nearestPlayer(e);
    if (g.phase === 'move') {
      if (n === ow.spot) {
        this.setPhase(g, 'set');
        ow.arrivedAt = f;
        ow.shots = 0;
        ow.want = 2 + (rand() < 0.5 ? 1 : 0);
        ow.aimAt = -1;
        ow.outOfLine = 0;
        this.glint(e, 0.7);
        if (!ow.told && p) {
          ow.told = true;
          this.radio(`${g.call}: OVERWATCH ON THE ${DIR_NAMES[this.domDir(e.x - p.x, e.y - p.y)]} ${this.ridgeWord(n)}.`);
        }
        return;
      }
      if (p && f - ow.pickedAt > 180) {
        // the player moved on (or the drive drags on): find a spot that fits where they are now
        const sx = (ow.spot % this.nw) * 8 + 8;
        const sy = ((ow.spot / this.nw) | 0) * 8 + 8;
        const d = Math.hypot(p.cx - sx, p.cy - sy);
        const aligned = Math.abs(p.cx - sx) < 12 || Math.abs(p.cy - sy) < 12;
        if (d < AI.owTooClose + 16 || d > AI.owFar + 60 || !aligned || f - ow.pickedAt > 60 * 45) this.relocate(g, u, p, 0.5);
      }
      return;
    }
    // set: shoot and scoot
    const d = p ? Math.hypot(p.cx - e.cx, p.cy - e.cy) : INF;
    const inLine = !!p && u.sees && this.lineTo(e, p, AI.owSight) >= 0;
    ow.outOfLine = inLine ? 0 : ow.outOfLine + 6;
    if (ow.shots >= ow.want && f - ow.lastShot > 40) this.relocate(g, u, p, 1);
    else if (d < AI.owTooClose) this.relocate(g, u, p, 1);
    else if (ow.outOfLine > 360 && f - ow.arrivedAt > 360) this.relocate(g, u, p, ow.shots ? 1 : 0.5);
    else if ((f - ow.arrivedAt) % 180 < 6 && f > ow.arrivedAt + 60) this.glint(e, 0.4); // the odd glint while it waits
  }

  /** Shoot and scoot: on to another spot 48+ px from the recent ones, or home after enough moves. */
  private relocate(g: Group, u: Unit, p: Tank | null, cost: number): void {
    const ow = g.ow!;
    const f = this.w.frame;
    ow.moves += cost;
    this.stats.owMoves++;
    const sp = p && ow.moves <= AI.owMoves ? this.pickSpot(p, this.nodeOf(u.t), ow.history) : null;
    if (!sp) {
      this.setPhase(g, 'leave');
      g.exitNode = this.exitAway(u.t);
      this.logEv(`${g.call} overwatch pulls out after ${ow.moves} moves`);
      return;
    }
    ow.spot = sp.node;
    ow.face = sp.face;
    ow.history.push(sp.node);
    if (ow.history.length > 6) ow.history.shift();
    ow.pickedAt = f;
    ow.aimAt = -1;
    g.targetNode = sp.node;
    g.target = [(sp.node % this.nw) * 8, ((sp.node / this.nw) | 0) * 8];
    this.setPhase(g, 'move');
  }

  private endOverwatch(): void {
    this.overwatch = null;
    this.owNext = this.w.frame + AI.owGapMin + randInt(AI.owGapMax - AI.owGapMin + 1);
  }

  /** A glint off the optics: a brief bright point at the gun (the overwatch tell). */
  private glint(e: Tank, k: number): void {
    const w = this.w;
    const x = e.cx + DX[e.dir] * 6;
    const y = e.cy + DY[e.dir] * 6;
    w.flashes.push({ x, y, t: 0, max: Math.round(8 + 10 * k), r: 14 + 22 * k, col: [1, 0.97, 0.85], z: 14 });
    w.parts.push({ x, y, z: 10, vx: 0, vy: 0, vz: 0, life: 0, max: Math.round(6 + 6 * k), col: [1, 1, 0.92], kind: 1, r: 1 });
    this.stats.glints++;
  }

  // ---------- Phase 2: morale (depots) ----------
  /** False once the run flow has destroyed the depot (w.depots[i].destroyed / alive false / hp <= 0, by name). */
  private depotAlive(i: number): boolean {
    const list = (this.w as unknown as { depots?: unknown }).depots;
    if (!Array.isArray(list)) return true;
    const name = this.depots[i].def.name;
    const d = (list.find((x) => (x as { name?: string })?.name === name) ?? list[i]) as
      { destroyed?: boolean; dead?: boolean; alive?: boolean; hp?: number } | undefined;
    if (!d || typeof d !== 'object') return true;
    return !(d.destroyed || d.dead || d.alive === false || (typeof d.hp === 'number' && d.hp <= 0));
  }

  /** The standing depot with the shortest road route from tank e, -1 if none. */
  private pickDepot(e: Tank): number {
    let best = -1;
    let bd = INF;
    const n = this.nodeOf(e);
    for (let i = 0; i < this.depots.length; i++) {
      if (!this.depotAlive(i)) continue;
      const d = this.field(this.depots[i].node, true).d[n];
      if (d < bd) { bd = d; best = i; }
    }
    return best;
  }

  private toDepot(u: Unit, dep: number): void {
    const D = this.depots[dep];
    u.mor = 1;
    u.depot = dep;
    u.repairUntil = this.w.frame; // (while driving: when it set off)
    const taken = new Set<number>();
    for (const o of this.units.values()) if (o !== u && o.mor && o.depot === dep) taken.add(o.depotSpot);
    u.depotSpot = D.spots.find((s) => !taken.has(s)) ?? D.spots[0];
    u.goal = u.depotSpot;
    this.stats.toDepot++;
    this.logEv(`${u.g.call}-${u.idx + 1} pulls back to ${D.def.name}`);
  }

  /** Plan for a tank off to (or at) a depot. False = back on duty, plan as usual. */
  private planMorale(u: Unit): boolean {
    const e = u.t;
    const f = this.w.frame;
    const n = this.nodeOf(e);
    if (!this.depotAlive(u.depot)) {
      // the depot went up in smoke: try another, else leave the map
      const d = this.pickDepot(e);
      if (d >= 0) this.toDepot(u, d);
      else {
        u.mor = 0;
        u.retreat = true;
        u.exitNode = this.exitAway(e);
        return false;
      }
    }
    if (u.mor === 1) {
      const near = this.nodeDist(n, u.depotSpot);
      if (near === 0 || (near <= 3 && e.stuck > 30) || f - u.repairUntil > 60 * 60) {
        u.mor = 2;
        u.repairUntil = f + AI.repairT;
        this.logEv(`${u.g.call}-${u.idx + 1} repairing at ${this.depots[u.depot].def.name}`);
      } else {
        u.order = ROUTE;
        u.goal = u.depotSpot;
        u.face = -1;
        return true;
      }
    }
    if (f >= u.repairUntil) {
      this.returnToDuty(u);
      return false;
    }
    u.order = HOLD;
    u.face = u.aware && u.tp ? this.dirToward(e, u.tp) : u.face;
    return true;
  }

  /** Repaired: back to its own group if that still fights, else the nearest held town's garrison, else home. */
  private returnToDuty(u: Unit): void {
    const e = u.t;
    e.hp = ENEMY[e.etype].hp;
    u.lastHp = e.hp;
    u.mor = 0;
    u.moraleRolled = false;
    u.bailRolled = false;
    this.stats.repaired++;
    const g = u.g;
    const who = `${g.call}-${u.idx + 1}`;
    const live = this.groups.includes(g);
    if (live && g.job === 'assault' && g.phase !== 'retreat' && g.phase !== 'leave') {
      if (g.lost > 0) g.lost--;
      this.radio(`${who}: REPAIRED. REJOINING ${g.call}.`);
      this.logEv(`${who} back on duty with ${g.call}`);
      return;
    }
    if (live && g.job === 'overwatch' && g.ow && g.phase !== 'leave') {
      g.ow.aimAt = -1;
      this.setPhase(g, 'move');
      return;
    }
    let best: TownAI | null = null;
    let bd = INF;
    for (const t of this.towns) {
      if (t.state?.freed) continue;
      const gg = t.garrison;
      if (!gg || (gg !== g && !gg.members.some((m) => m !== u && this.onDuty(m)))) continue;
      if (gg.members.length > AI.garrisonSize) continue;
      const d = Math.hypot(t.def.cx - e.cx, t.def.cy - e.cy);
      if (d < bd) { bd = d; best = t; }
    }
    if (best && best.garrison) {
      if (live && g.job === 'garrison' && g.town === best) {
        // its own town still holds
      } else {
        this.moveUnit(u, best.garrison);
      }
      this.assignSpot(u, best, best.garrison);
      this.radio(`${who}: REPAIRED. RETURNING TO ${best.def.name}.`);
      this.logEv(`${who} back on duty at ${best.def.name}`);
      return;
    }
    u.retreat = true;
    u.exitNode = this.exitAway(e);
    this.logEv(`${who} repaired, nothing to return to: heads home`);
  }

  // ---------- Phase 2: abandoned tanks ----------
  /** The crew bails: the tank stays where it is as a hull for 60 s. */
  private bail(u: Unit): void {
    const e = u.t;
    const g = u.g;
    const w = this.w;
    const i = g.members.indexOf(u);
    if (i >= 0) g.members.splice(i, 1);
    if (!u.retreat && !u.mor) g.lost++;
    this.units.delete(e);
    u.gone = true;
    e.blocked = false;
    e.stuck = 0;
    const call = `${g.call}-${u.idx + 1}`;
    this.hulls.set(e, { t: e, until: w.frame + AI.hullT, call });
    this.markHulls(true);
    this.stats.bails++;
    for (let k = 0; k < 4; k++) {
      w.parts.push({
        x: e.cx + (rand() - 0.5) * 8, y: e.cy + (rand() - 0.5) * 8, z: 8, vx: (rand() - 0.5) * 0.3, vy: -0.2 - rand() * 0.2, vz: 0.05,
        life: 0, max: 60 + randInt(40), col: [0.3, 0.3, 0.3], kind: 2, r: 3 + rand() * 2,
      });
    }
    this.radio(`${call}: CREW BAILING OUT.`);
    this.say("CREW BAILED. SHE'S YOURS IF YOU WANT HER.");
    this.logEv(`${call} crew bailed: hull at ${Math.round(e.x)},${Math.round(e.y)}`);
  }

  private updateHulls(): void {
    const w = this.w;
    const f = w.frame;
    const n0 = this.hulls.size;
    for (const [t, h] of this.hulls) {
      if (!t.alive) {
        this.hulls.delete(t); // a player wrecked it (world dropped the scrap)
        this.logEv(`${h.call} hull wrecked`);
        continue;
      }
      if (f >= h.until) {
        // nobody came for it: the crew scuttles it from a distance
        t.alive = false;
        w.explode(t.cx, t.cy, false);
        w.snd('explode', t.cx, 0.6);
        this.hulls.delete(t);
        this.stats.scuttled++;
        this.logEv(`${h.call} hull scuttled`);
        continue;
      }
      for (const p of w.livePlayers()) {
        if (this.drivesInto(p, t)) {
          this.capture(h, p);
          break;
        }
      }
    }
    if (this.hulls.size !== n0) this.markHulls(true);
  }

  /** Player p is pushing against tank t: touching it on the side it is driving toward. */
  private drivesInto(p: Tank, t: Tank): boolean {
    if (!p.moving) return false;
    const ax = p.x + DX[p.dir] * 2;
    const ay = p.y + DY[p.dir] * 2;
    const ox = Math.min(ax + 16, t.x + 16) - Math.max(ax, t.x);
    const oy = Math.min(ay + 16, t.y + 16) - Math.max(ay, t.y);
    if (ox <= 0 || oy <= 0) return false;
    // real side contact, not a corner graze
    return DX[p.dir] !== 0 ? oy >= 6 : ox >= 6;
  }

  private capture(h: Hull, p: Tank): void {
    const w = this.w;
    const t = h.t;
    t.alive = false;
    this.hulls.delete(t);
    this.capturedHulls.push({ kind: 'captured', x: Math.round(t.x), y: Math.round(t.y), etype: t.etype, player: p.player, frame: w.frame });
    w.popups.push({ x: t.cx, y: t.cy - 6, text: '+CAPTURED', t: 0, col: [0.55, 1, 0.55] });
    w.snd('part', t.cx, 1);
    w.sparks(t.cx, t.cy, 8, [0.6, 1, 0.6]);
    w.note('TANK CAPTURED', 'power');
    this.say('GOT HER. THE CREW LEFT THEIR LUNCH IN THE TURRET. I AM NOT SHARING.');
    this.stats.captured++;
    this.logEv(`${h.call} hull captured by P${p.player + 1}`);
  }

  // ---------- units ----------
  private think(u: Unit): void {
    const e = u.t;
    const g = u.g;
    const w = this.w;
    const f = w.frame;
    if (e.spawn > 0) return;
    if (e.hp < u.lastHp) {
      const was = u.lastHp;
      u.lastHp = e.hp;
      if (g.job === 'garrison' && g.town) this.callHelp(g.town, 'hit');
      // down to 1 hp: some crews bail out and leave the tank behind
      if (e.hp === 1 && was > 1 && !u.bailRolled) {
        u.bailRolled = true;
        if (rand() < AI.bailChance) {
          this.bail(u);
          return;
        }
      }
    }
    if (!u.retreat && !u.mor && ENEMY[e.etype].hp > 1 && e.hp <= AI.moraleHp) {
      // morale: at 1 hp always pull back; at 2 hp maybe, and only to a depot
      let pull = e.hp <= 1;
      let dep = -1;
      if (!pull && !u.moraleRolled) {
        u.moraleRolled = true;
        if (rand() < AI.depotChance) {
          dep = this.pickDepot(e);
          pull = dep >= 0;
        }
      } else if (pull) {
        dep = this.pickDepot(e);
      }
      if (pull) {
        g.lost++; // out of the fight: counts toward the group falling back
        if (dep >= 0) {
          this.toDepot(u, dep);
          this.radio(`${g.call}-${u.idx + 1}: HIT BAD. PULLING BACK TO ${this.depots[dep].def.name}.`);
        } else {
          u.retreat = true;
          u.exitNode = g.job === 'assault' ? g.exitNode : this.exitAway(e);
          this.radio(`${g.call}-${u.idx + 1}: HIT BAD. PULLING BACK.`);
          this.logEv(`${g.call}-${u.idx + 1} retreats`);
        }
      }
    }
    // perception
    let best: Tank | null = null;
    let bd = INF;
    let sees = false;
    const sight = this.sightOf(u);
    for (const p of w.livePlayers()) {
      const d = Math.hypot(p.cx - e.cx, p.cy - e.cy);
      if (d < bd && this.perceives(e, p, d, sight)) { best = p; bd = d; sees = true; }
    }
    if (!sees && g.revealUntil > f) {
      for (const p of w.livePlayers()) {
        const d = Math.hypot(p.cx - e.cx, p.cy - e.cy);
        if (d < AI.revealR && d < bd) { best = p; bd = d; }
      }
    }
    u.sees = sees;
    if (best) {
      if (!u.aware) {
        u.react = this.reaction();
        u.seenT = 0;
      }
      u.seenT += 6;
      u.lastAware = f;
      u.tp = best;
      u.aware = true;
    } else if (f - u.lastAware > 60 || !u.tp?.alive) {
      u.aware = false;
      u.seenT = 0;
      u.tp = null;
    }
    if (sees && best) {
      g.known = { x: best.x, y: best.y, t: f };
      g.lastContact = f;
      this.known = g.known;
    }
    const ow = g.ow;
    if (ow && g.phase === 'set') {
      // overwatch: a glint as it lines up on a player, then the shot after its (slow) reaction
      const ln = sees && !!best && this.lineTo(e, best, AI.owSight) >= 0;
      if (ln && ow.aimAt < 0) {
        ow.aimAt = f;
        u.seenT = 0;
        u.react = this.reaction(AI.owReactMin, AI.owReactMax);
        this.glint(e, 1);
      } else if (!ln && ow.aimAt >= 0 && f - ow.aimAt > 90) {
        ow.aimAt = -1;
      }
    }
    this.plan(u);
  }

  /** Choose the unit's move order and facing from its group's job and phase. */
  private plan(u: Unit): void {
    const g = u.g;
    const e = u.t;
    const f = this.w.frame;
    if (u.mor && this.planMorale(u)) return;
    if (u.retreat || g.phase === 'retreat' || g.phase === 'leave') {
      if (!u.retreat) u.exitNode = g.exitNode;
      u.order = EXIT;
      u.face = -1;
      return;
    }
    if (g.job === 'overwatch' && g.ow) {
      const ow = g.ow;
      u.goal = ow.spot;
      if (g.phase === 'move') {
        u.order = ROUTE;
        u.face = -1;
        return;
      }
      u.order = this.nodeOf(e) === ow.spot ? HOLD : GOAL;
      u.face = u.aware && u.tp ? this.dirToward(e, u.tp) : ow.face;
      return;
    }
    if (g.job === 'garrison') {
      const t = g.town!;
      const n = this.nodeOf(e);
      if (n !== u.spot && this.nodeDist(n, u.spot) > 24 && !u.aware) {
        // far from its spot (back from a depot, or a newcomer): drive there on the roads
        u.goal = u.spot;
        u.order = ROUTE;
        u.face = -1;
        return;
      }
      if (u.engaged && u.sees && u.tp) {
        // shift (inside the leash) to get a straight line of fire
        const pn = this.nodeOf(u.tp);
        const nx = n % this.nw;
        const ny = (n / this.nw) | 0;
        const px = pn % this.nw;
        const py = (pn / this.nw) | 0;
        const opts = Math.abs(px - nx) < Math.abs(py - ny) ? [[px, ny], [nx, py]] : [[nx, py], [px, ny]];
        for (const [ox, oy] of opts) {
          const c = oy * this.nw + ox;
          if (this.flags[c] || !this.inLeash(t, ox * 8, oy * 8)) continue;
          if (Math.abs(ox - nx) + Math.abs(oy - ny) > 8) continue;
          u.goal = c;
          u.order = GOAL;
          u.face = this.dirToward(e, u.tp);
          return;
        }
        u.order = HOLD;
        u.face = this.dirToward(e, u.tp);
        return;
      }
      if (u.aware && u.tp) {
        u.order = HOLD;
        u.face = this.dirToward(e, u.tp);
        return;
      }
      if (n !== u.spot && f - u.lastAware > 180) {
        u.goal = u.spot;
        u.order = GOAL;
        u.face = -1;
        return;
      }
      u.order = HOLD;
      const k = g.known;
      if (k && f - k.t < 60 * 20) u.face = this.domDir(k.x - e.x, k.y - e.y);
      else u.face = n === u.spot ? this.outward(t, n) : u.face;
      return;
    }
    // assault
    if (g.phase === 'column') {
      u.order = g.leaderId === u.id ? GROUP : TRAIL;
      u.face = -1;
    } else if (g.phase === 'deploy') {
      u.goal = this.lineGoal(g, u.idx, g.deployBase);
      u.order = GOAL;
      u.face = g.adir;
    } else if (g.phase === 'advance') {
      u.goal = this.lineGoal(g, u.idx, g.targetNode);
      u.order = GOAL;
      u.face = u.tp ? this.dirToward(e, u.tp) : g.adir;
    } else {
      u.order = HOLD;
    }
  }

  /** Movement direction at a node, -1 = stay. */
  private steer(u: Unit): number {
    const e = u.t;
    const g = u.g;
    u.wantsMove = false;
    u.speedCap = 99;
    const n = this.nodeOf(e);
    switch (u.order) {
      case TRAIL: return this.steerTrail(u, n);
      case GROUP: {
        u.speedCap = g.speed;
        if (this.straggler(u)) return -1;
        return this.follow(u, n, this.field(g.targetNode, true), g.targetNode);
      }
      case GOAL: {
        if (n === u.goal || u.goal < 0) return -1;
        if (g.phase === 'advance' && this.aheadOfLine(u)) return -1;
        return this.follow(u, n, this.unitField(u), u.goal);
      }
      case EXIT: {
        if (this.nodeDist(n, u.exitNode) <= 1) {
          this.despawn(u);
          return -1;
        }
        return this.follow(u, n, this.field(u.exitNode, true), u.exitNode);
      }
      case ROUTE: {
        if (n === u.goal || u.goal < 0) return -1;
        // overwatch goes cross-country; depot runs and garrison returns keep to the roads
        return this.follow(u, n, this.field(u.goal, g.job !== 'overwatch' || u.mor > 0), u.goal);
      }
      default: return -1;
    }
  }

  /** Column: wait for the tank behind (even while it is still materialising) so the column holds together. */
  private straggler(u: Unit): boolean {
    const g = u.g;
    const e = u.t;
    const i = g.members.indexOf(u);
    let nx: Unit | null = null;
    for (let k = i + 1; k < g.members.length; k++) {
      const m = g.members[k];
      if (this.onDuty(m)) { nx = m; break; }
    }
    const gap = nx ? Math.hypot(nx.t.x - e.x, nx.t.y - e.y) : 0;
    if (nx && gap > AI.spacing + 8 && u.waitT < 300) {
      u.waitT += 6;
      return true;
    }
    if (!nx || gap <= AI.spacing + 4) u.waitT = 0;
    return false;
  }

  private steerTrail(u: Unit, n: number): number {
    const g = u.g;
    const e = u.t;
    const i = g.members.indexOf(u);
    let ahead: Unit | null = null;
    for (let k = i - 1; k >= 0; k--) {
      const m = g.members[k];
      if (this.onDuty(m)) { ahead = m; break; }
    }
    if (ahead && Math.hypot(ahead.t.x - e.x, ahead.t.y - e.y) < AI.spacing) return -1;
    if (this.straggler(u)) return -1;
    const tr = g.trail;
    // where am I on the trail?
    if (tr[u.trailIdx] !== n) {
      for (let k = u.trailIdx; k < Math.min(tr.length, u.trailIdx + 24); k++) {
        if (tr[k] === n) { u.trailIdx = k; break; }
      }
    }
    // a hull blocks the trail ahead: drive round it to the first clear trail node beyond, then carry on
    const nb = tr[u.trailIdx + 1];
    if (nb !== undefined && this.flags[nb] & 2 && this.hulls.size) {
      let k = u.trailIdx + 1;
      while (k < tr.length && this.flags[tr[k]] & 2) k++;
      if (k < tr.length) {
        u.wantsMove = true;
        u.speedCap = 99;
        const goal = tr[k];
        if (this.nodeDist(n, goal) <= 0) { u.trailIdx = k; return -1; }
        const d = this.follow(u, n, this.field(goal, false), goal);
        if (this.nodeOf(u.t) === goal) u.trailIdx = k;
        return d;
      }
    }
    if (tr[u.trailIdx] !== n && this.hulls.size) {
      // back on the trail after a detour round a hull
      for (let k = u.trailIdx; k < Math.min(tr.length, u.trailIdx + 48); k++) {
        if (tr[k] === n) { u.trailIdx = k; break; }
      }
    }
    if (tr[u.trailIdx] === n) {
      if (u.trailIdx + 1 >= tr.length) return -1;
      // never step onto the node the tank ahead is on or going to
      if (ahead && this.nodeDist(tr[u.trailIdx + 1], this.nodeOf(ahead.t)) < 2) return -1;
      u.trailIdx++;
    }
    u.speedCap = 99;
    const tgt = tr[u.trailIdx];
    u.wantsMove = true;
    if (e.stuck > 40 && !this.brickAhead(e)) {
      e.stuck = 0;
      const s = this.sidestep(e, n, e.dir);
      if (s >= 0) return s;
    }
    const d = this.adjDir(n, tgt);
    return d >= 0 ? d : this.greedy(n, tgt, e.dir);
  }

  private follow(u: Unit, n: number, fd: NodeField, goal: number): number {
    const e = u.t;
    u.wantsMove = true;
    if (e.stuck > 40 && !this.brickAhead(e)) {
      e.stuck = 0;
      // long routes (overwatch, depot runs) and line slots: plan round a tank parked in the way (a line-mate
      // holding to fire can sit in the lane another one needs)
      const b = u.order === ROUTE || u.order === GOAL ? this.tankAhead(e) : null;
      if (b) {
        this.detourField(u, goal, b);
        u.detourUntil = this.w.frame + 180;
      } else if (this.w.boss?.overlaps(e.x + DX[e.dir] * 4, e.y + DY[e.dir] * 4, 16, 16)) {
        // Phase 4 boss hook: the boss's hull is in the way: plan round it
        this.detourField(u, goal, null);
        u.detourUntil = this.w.frame + 240;
      }
      const s = this.sidestep(e, n, e.dir);
      if (s >= 0) {
        // for 2 s ignore the road bias, so it drives on beside the blocker instead of back behind it
        if (!b) u.detourUntil = this.w.frame + 120;
        return s;
      }
    }
    if (this.w.frame < u.detourUntil) {
      if ((u.order === ROUTE || u.order === GOAL) && u.fieldGoal === -2 && u.field) fd = u.field;
      else if (u.order !== GOAL) fd = this.field(goal, false);
    }
    const d = this.downhill(fd, n, e.dir);
    return d >= 0 ? d : this.greedy(n, goal, e.dir);
  }

  /** Another tank right in front of e (blocking it), or null. */
  private tankAhead(e: Tank): Tank | null {
    const ax = e.x + DX[e.dir] * 4;
    const ay = e.y + DY[e.dir] * 4;
    for (const o of this.w.allTanks()) {
      if (o === e || !o.alive || o.spawn) continue;
      if (Math.abs(o.x - ax) < 16 && Math.abs(o.y - ay) < 16) return o;
    }
    return null;
  }

  /**
   * The unit's own field to `goal` with the nodes of tank b, and of any other tank right beside it, blocked
   * (u.fieldGoal = -2 marks it as a detour). Blocking only b lets a tank boxed in by two flip between them.
   */
  private detourField(u: Unit, goal: number, b: Tank | null): void {
    if (!u.field) u.field = new NodeField(this.nw * this.nh);
    const e = u.t;
    const own = this.nodeOf(e);
    const saved: [number, number][] = [];
    const boss = this.w.boss; // Phase 4 boss hook: the boss's hull is blocked too
    if (boss?.present) {
      for (let ny = Math.ceil((boss.y - 16) / 8 + EPS); ny * 8 < boss.y + 48 - EPS; ny++) {
        for (let nx = Math.ceil((boss.x - 16) / 8 + EPS); nx * 8 < boss.x + 48 - EPS; nx++) {
          if (nx < 0 || ny < 0 || nx >= this.nw || ny >= this.nh) continue;
          const i = ny * this.nw + nx;
          if (i === own) continue;
          saved.push([i, this.flags[i]]);
          this.flags[i] |= 2;
        }
      }
    }
    for (const o of this.w.allTanks()) {
      if (o === e || !o.alive || o.spawn) continue;
      if (o !== b && (Math.abs(o.x - e.x) >= 32 || Math.abs(o.y - e.y) >= 32)) continue;
      for (let ny = Math.ceil((o.y - 16) / 8 + EPS); ny * 8 < o.y + 16 - EPS; ny++) {
        for (let nx = Math.ceil((o.x - 16) / 8 + EPS); nx * 8 < o.x + 16 - EPS; nx++) {
          if (nx < 0 || ny < 0 || nx >= this.nw || ny >= this.nh) continue;
          const i = ny * this.nw + nx;
          if (i === own) continue;
          saved.push([i, this.flags[i]]);
          this.flags[i] |= 2;
        }
      }
    }
    this.compute(u.field, goal, false, INF);
    for (let k = saved.length - 1; k >= 0; k--) this.flags[saved[k][0]] = saved[k][1];
    u.fieldGoal = -2;
  }

  /**
   * In a line advance, a tank more than 24 px ahead of the slowest one waits for the line (at most 3 s, and never
   * for a tank in its own lane: that one may be stuck behind it).
   */
  private aheadOfLine(u: Unit): boolean {
    const g = u.g;
    const a = g.adir;
    const mine = u.t.cx * DX[a] + u.t.cy * DY[a];
    const lane = u.t.cx * DY[a] - u.t.cy * DX[a];
    let min = mine;
    for (const m of g.members) {
      if (m === u || m.gone || !m.t.alive || m.retreat || m.mor || m.t.spawn) continue;
      if (m.goal >= 0 && this.nodeOf(m.t) === m.goal) continue;
      if (Math.abs(m.t.cx * DY[a] - m.t.cy * DX[a] - lane) < 16) continue;
      min = Math.min(min, m.t.cx * DX[a] + m.t.cy * DY[a]);
    }
    if (mine - min <= 24) {
      u.waitT = 0;
      return false;
    }
    u.waitT += 6;
    return u.waitT < 180;
  }

  private wantsFire(u: Unit): boolean {
    const e = u.t;
    const p = u.tp;
    const ow = u.g.ow;
    if (ow && (u.g.phase !== 'set' || ow.aimAt < 0)) {
      // overwatch fires only from its spot, after the glint
    } else if (!u.retreat && u.mor !== 1 && u.engaged && p && p.alive && p.spawn === 0 && u.seenT >= u.react) {
      if (this.w.inLine(e, p.x, p.y, 16, 16) && Math.hypot(p.cx - e.cx, p.cy - e.cy) <= this.sightOf(u) && this.w.clearShot(e, p.cx, p.cy)) {
        return ow ? true : rand() < 0.25;
      }
    }
    if (u.want >= 0 && e.blocked && e.stuck > 8 && this.brickAhead(e)) return rand() < 0.15;
    return false;
  }

  /** Engagement cap: only the nearest few aware tanks may fight at once. */
  private allocate(): void {
    const list: { u: Unit; d: number }[] = [];
    for (const u of this.units.values()) {
      u.engaged = false;
      if (u.gone || u.retreat || u.mor === 1 || !u.aware || !u.tp) continue;
      if (u.g.job === 'overwatch') {
        u.engaged = true; // the lone overwatch is outside the cap: it fires a few aimed shots and moves
        continue;
      }
      list.push({ u, d: Math.hypot(u.tp.cx - u.t.cx, u.tp.cy - u.t.cy) });
    }
    list.sort((a, b) => a.d - b.d);
    const cap = this.engageCap();
    for (let i = 0; i < list.length && i < cap; i++) list[i].u.engaged = true;
    this.stats.maxEngaged = Math.max(this.stats.maxEngaged, Math.min(list.length, cap));
  }

  private despawn(u: Unit): void {
    u.gone = true;
    u.t.alive = false;
    this.w.queue.push(u.t.etype);
    this.stats.escaped++;
    this.logEv(`${u.g.call}-${u.idx + 1} left the map`);
  }

  // ---------- perception ----------
  /** Can tank e see player p (d = centre distance)? Brick and steel block the line; trees hide within 48 px. */
  perceives(e: Tank, p: Tank, d = Math.hypot(p.cx - e.cx, p.cy - e.cy), sight = AI.sight): boolean {
    if (d > sight) return false;
    if (d > AI.sightTrees && this.inTrees(p)) return false;
    const m = this.w.map;
    const n = Math.ceil(d / 4);
    let leaves = 0;
    for (let i = 1; i < n; i++) {
      const x = e.cx + ((p.cx - e.cx) * i) / n;
      const y = e.cy + ((p.cy - e.cy) * i) / n;
      const c = m.at(Math.floor(x / 4), Math.floor(y / 4));
      if (c === BRICK || c === STEEL) return false;
      if (c === TREES && i * 4 > 10) leaves++;
    }
    // a hedgerow (more than 12 px of foliage on the line) screens the view
    return leaves <= 3 || d <= AI.sightTrees;
  }

  /** Half or more of the tank's footprint is under trees. */
  inTrees(p: Tank): boolean {
    const m = this.w.map;
    const cx = Math.round(p.x / 4);
    const cy = Math.round(p.y / 4);
    let n = 0;
    for (let y = cy; y < cy + 4; y++) for (let x = cx; x < cx + 4; x++) if (m.at(x, y) === TREES) n++;
    return n >= 8;
  }

  private scanShots(): void {
    for (const b of this.w.bullets) {
      if (!b.owner.isPlayer || this.shots.has(b)) continue;
      this.shots.add(b);
      const p = b.owner;
      const f = this.w.frame;
      for (const g of this.groups) {
        if (!g.members.some((m) => !m.gone && Math.hypot(m.t.cx - p.cx, m.t.cy - p.cy) < AI.revealR)) continue;
        g.revealUntil = f + AI.revealT;
        g.known = { x: p.x, y: p.y, t: f };
        this.known = g.known;
      }
    }
  }

  // ---------- fields and node helpers ----------
  private cost(j: number, bias: boolean): number {
    const fl = this.flags[j];
    if (fl & 2) return INF;
    if (fl & 1) return bias ? 12 : 6;
    if (!bias) return 1;
    const r = this.road[j];
    return r >= 12 ? 1 : r > 0 ? 2 : 3;
  }

  private compute(fd: NodeField, goal: number, bias: boolean, maxDist: number): void {
    const t0 = performance.now();
    const d = fd.d;
    if (fd.full) d.fill(INF);
    else for (const i of fd.touched) d[i] = INF;
    fd.touched.length = 0;
    fd.full = maxDist >= INF;
    const track = !fd.full;
    const B = this.buckets;
    for (const b of B) if (b) b.length = 0;
    const nw = this.nw;
    const nh = this.nh;
    d[goal] = 0;
    if (track) fd.touched.push(goal);
    (B[0] ??= []).push(goal);
    for (let dist = 0; dist < B.length && dist <= maxDist; dist++) {
      const b = B[dist];
      if (!b) continue;
      for (let k = 0; k < b.length; k++) {
        const i = b[k];
        if (d[i] < dist) continue;
        const x = i % nw;
        const y = (i / nw) | 0;
        for (let dir = 0; dir < 4; dir++) {
          const nx = x + DX[dir];
          const ny = y + DY[dir];
          if (nx < 0 || ny < 0 || nx >= nw || ny >= nh) continue;
          const j = ny * nw + nx;
          const c = this.cost(j, bias);
          if (c >= INF) continue;
          const nd = dist + c;
          if (nd < d[j] && nd <= maxDist) {
            if (track && d[j] === INF) fd.touched.push(j);
            d[j] = nd;
            (B[nd] ??= []).push(j);
          }
        }
      }
    }
    fd.at = this.w.frame;
    fd.ver = this.gridVer;
    fd.goal = goal;
    this.stats.fields++;
    this.stats.fieldMs += performance.now() - t0;
  }

  /** Shared whole-map field toward a node (road-biased for columns and retreats), cached and refreshed slowly. */
  private field(goal: number, bias: boolean): NodeField {
    const key = goal * 2 + (bias ? 1 : 0);
    let fd = this.fields.get(key);
    if (fd && (fd.ver === this.gridVer || this.w.frame - fd.at < 600)) return fd;
    if (!fd) {
      if (this.fields.size >= 24) {
        let ok = -1;
        let oa = INF;
        for (const [k, v] of this.fields) if (v.at < oa) { oa = v.at; ok = k; }
        fd = this.fields.get(ok)!;
        this.fields.delete(ok);
      } else {
        fd = new NodeField(this.nw * this.nh);
      }
      this.fields.set(key, fd);
    }
    this.compute(fd, goal, bias, INF);
    return fd;
  }

  /** The unit's own small field toward its goal (line slots, garrison spots). */
  private unitField(u: Unit): NodeField {
    if (!u.field) u.field = new NodeField(this.nw * this.nh);
    if (u.fieldGoal === -2 && this.w.frame < u.detourUntil) return u.field; // driving round a parked tank
    if (u.fieldGoal !== u.goal || this.w.frame - u.field.at > 300) {
      this.compute(u.field, u.goal, false, 160);
      u.fieldGoal = u.goal;
    }
    return u.field;
  }

  private downhill(fd: NodeField, n: number, cur: number): number {
    const d = fd.d;
    const cv = d[n];
    const x = n % this.nw;
    const y = (n / this.nw) | 0;
    let best = -1;
    // on a node that has no value (e.g. one a fresh hull blocked): step to the best neighbour that has one
    let bv = cv;
    for (let k = 0; k < 4; k++) {
      const dir = (cur + k) % 4;
      const nx = x + DX[dir];
      const ny = y + DY[dir];
      if (nx < 0 || ny < 0 || nx >= this.nw || ny >= this.nh) continue;
      const v = d[ny * this.nw + nx];
      if (v < bv) { bv = v; best = dir; }
    }
    return best;
  }

  /** Step that shortens the straight distance to the goal, avoiding steel and water. */
  private greedy(n: number, goal: number, cur: number): number {
    const x = n % this.nw;
    const y = (n / this.nw) | 0;
    const gx = goal % this.nw;
    const gy = (goal / this.nw) | 0;
    const d0 = Math.abs(gx - x) + Math.abs(gy - y);
    let best = -1;
    let bv = d0;
    for (let k = 0; k < 4; k++) {
      const dir = (cur + k) % 4;
      const nx = x + DX[dir];
      const ny = y + DY[dir];
      if (nx < 0 || ny < 0 || nx >= this.nw || ny >= this.nh || this.flags[ny * this.nw + nx] & 2) continue;
      const v = Math.abs(gx - nx) + Math.abs(gy - ny);
      if (v < bv) { bv = v; best = dir; }
    }
    return best;
  }

  /** A free neighbour node to the side (or behind) to get round a tank in the way. */
  private sidestep(e: Tank, n: number, cur: number): number {
    const x = n % this.nw;
    const y = (n / this.nw) | 0;
    const opts = rand() < 0.5 ? [(cur + 1) % 4, (cur + 3) % 4, (cur + 2) % 4] : [(cur + 3) % 4, (cur + 1) % 4, (cur + 2) % 4];
    for (const dir of opts) {
      const nx = x + DX[dir];
      const ny = y + DY[dir];
      if (nx < 0 || ny < 0 || nx >= this.nw || ny >= this.nh || this.flags[ny * this.nw + nx]) continue;
      if (this.w.blockedAt(e, nx * 8, ny * 8)) continue;
      return dir;
    }
    return -1;
  }

  private adjDir(a: number, b: number): number {
    const dx = (b % this.nw) - (a % this.nw);
    const dy = ((b / this.nw) | 0) - ((a / this.nw) | 0);
    if (Math.abs(dx) + Math.abs(dy) !== 1) return -1;
    return dx > 0 ? RIGHT : dx < 0 ? LEFT : dy > 0 ? DOWN : UP;
  }

  private brickAhead(e: Tank): boolean {
    const ax = e.cx + DX[e.dir] * 12;
    const ay = e.cy + DY[e.dir] * 12;
    return this.w.map.any(ax - 6, ay - 6, 12, 12, (c) => c === BRICK);
  }

  /** Line-abreast slot `idx` around base node, perpendicular to the advance, 24 px apart. */
  private lineGoal(g: Group, idx: number, base: number): number {
    const off = (OFFS[idx] ?? 0) * 3;
    const vert = g.adir === UP || g.adir === DOWN;
    const bx = (base % this.nw) + (vert ? off : 0);
    const by = ((base / this.nw) | 0) + (vert ? 0 : off);
    return this.nearestOpen(bx, by);
  }

  private nearestOpen(x: number, y: number): number {
    x = Math.max(0, Math.min(this.nw - 1, x));
    y = Math.max(0, Math.min(this.nh - 1, y));
    // Phase 4 boss hook: never a spot under the boss's hull (it may be 3 nodes off)
    const boss = this.w.boss?.present ? this.w.boss : null;
    const open = (nx: number, ny: number) => !this.flags[ny * this.nw + nx] && !boss?.overlaps(nx * 8, ny * 8, 16, 16);
    if (open(x, y)) return y * this.nw + x;
    for (let r = 1; r <= (boss ? 6 : 3); r++) {
      for (let j = -r; j <= r; j++) {
        for (const [nx, ny] of [[x + j, y - r], [x + j, y + r], [x - r, y + j], [x + r, y + j]]) {
          if (nx < 0 || ny < 0 || nx >= this.nw || ny >= this.nh) continue;
          if (open(nx, ny)) return ny * this.nw + nx;
        }
      }
    }
    return y * this.nw + x;
  }

  /** Nearest exit on the far side from the players (for a damaged garrison tank). */
  private exitAway(e: Tank): number {
    const p = this.nearestPlayer(e);
    let best = this.exits[0];
    let bs = INF;
    for (const q of this.exits) {
      const de = Math.hypot(q.x - e.x, q.y - e.y);
      const dp = p ? Math.hypot(q.x - p.x, q.y - p.y) : INF;
      const s = de + (dp < de ? 400 : 0);
      if (s < bs) { bs = s; best = q; }
    }
    return best ? this.nodeAt(best.x, best.y) : this.nodeOf(e);
  }

  nodeOf(t: Tank): number {
    return this.nodeAt(t.x, t.y);
  }

  nodeAt(x: number, y: number): number {
    const nx = Math.max(0, Math.min(this.nw - 1, Math.round(x / 8)));
    const ny = Math.max(0, Math.min(this.nh - 1, Math.round(y / 8)));
    return ny * this.nw + nx;
  }

  private nodeDist(a: number, b: number): number {
    return Math.abs((a % this.nw) - (b % this.nw)) + Math.abs(((a / this.nw) | 0) - ((b / this.nw) | 0));
  }

  /** Direction from e straight at p when p is in one of e's four lines (within 7 px), else -1. */
  private lineTo(e: Tank, p: Tank, sight = AI.sight): number {
    if (!p.alive || p.spawn) return -1;
    const dx = p.cx - e.cx;
    const dy = p.cy - e.cy;
    if (Math.hypot(dx, dy) > sight) return -1;
    if (Math.abs(dx) < 7) return dy < 0 ? UP : DOWN;
    if (Math.abs(dy) < 7) return dx < 0 ? LEFT : RIGHT;
    return -1;
  }

  private dirToward(e: Tank, p: Tank): number {
    return this.domDir(p.cx - e.cx, p.cy - e.cy);
  }

  private domDir(dx: number, dy: number): number {
    return Math.abs(dx) > Math.abs(dy) ? (dx > 0 ? RIGHT : LEFT) : dy > 0 ? DOWN : UP;
  }

  /** Facing for a garrison spot: away from the town centre (toward the approaches). */
  private outward(t: TownAI, n: number): number {
    const x = (n % this.nw) * 8 + 8;
    const y = ((n / this.nw) | 0) * 8 + 8;
    const dx = x - t.def.cx;
    const dy = y - t.def.cy;
    if (Math.abs(dx) < 4 && Math.abs(dy) < 4) return DOWN;
    return this.domDir(dx, dy);
  }

  private inLeash(t: TownAI, x: number, y: number): boolean {
    const [x0, y0, x1, y1] = t.leash;
    return x >= x0 && y >= y0 && x + 16 <= x1 && y + 16 <= y1;
  }

  private inRect(x: number, y: number, r: [number, number, number, number]): boolean {
    return x >= r[0] && y >= r[1] && x < r[0] + r[2] && y < r[1] + r[3];
  }

  /** A 16 px tank at (x, y) overlaps rect r grown by m. */
  private rectNear(x: number, y: number, r: [number, number, number, number], m: number): boolean {
    return x + 16 > r[0] - m && y + 16 > r[1] - m && x < r[0] + r[2] + m && y < r[1] + r[3] + m;
  }

  private nearestPlayer(e: Tank): Tank | null {
    let best: Tank | null = null;
    let bd = INF;
    for (const p of this.w.livePlayers()) {
      const d = Math.hypot(p.cx - e.cx, p.cy - e.cy);
      if (d < bd) { bd = d; best = p; }
    }
    return best;
  }

  // ---------- Phase 4 boss hook ----------
  /**
   * A boss's escort: an assault group of `types` spawned round the boss (`at()` = its centre and facing), already in
   * its advance phase. With no contact it keeps station ~40 px ahead of the boss in a line abreast; with a player
   * seen in the last 4 s near the boss it advances on them like any assault. It never settles in a town or drives
   * home (members may still pull back on morale). Returns the number of tanks spawned.
   */
  bossEscort(types: number[], call: string, at: () => [number, number, number]): number {
    if (!this.active) return 0;
    if (!this.inited) this.init();
    const w = this.w;
    const [cx, cy, dir] = at();
    const g = this.newGroup('assault', call, null);
    g.escort = at;
    g.phase = 'advance';
    g.adir = dir;
    const home = this.nodeAt(cx - 8, cy - 8);
    const ex = this.pickEntry(home);
    g.exitNode = ex ? this.nodeAt(ex[0], ex[1]) : home;
    let n = 0;
    for (const et of types) {
      const s = w.freeSpotNear(cx - 8 + DX[dir] * 40, cy - 8 + DY[dir] * 40);
      if (!s) continue;
      this.spawnTank(g, et, s[0], s[1], dir);
      n++;
    }
    g.size = n;
    this.escortTarget(g, true);
    if (!n) this.groups.splice(this.groups.indexOf(g), 1);
    this.logEv(`boss escort ${call} x${n}`);
    return n;
  }

  /** A boss lost a weak point: send a road column at (tx, ty) (the queue is topped up if it ran dry). */
  bossColumn(tx: number, ty: number): boolean {
    if (!this.active) return false;
    if (this.groups.some((g) => g.job === 'assault' && !g.escort && g.phase === 'column')) return false;
    while (this.w.queue.length < 4) this.w.queue.push(rand() < 0.6 ? 0 : 1);
    return !!this.launchAssault(tx, ty, null);
  }

  private escortTarget(g: Group, force: boolean): void {
    const f = this.w.frame;
    if (!force && f - g.retargetAt < 60) return;
    const [cx, cy, dir] = g.escort!();
    const k = g.known;
    let tx = cx - 8 + DX[dir] * 40;
    let ty = cy - 8 + DY[dir] * 40;
    let adir = dir;
    if (k && f - k.t < 240 && Math.hypot(k.x + 8 - cx, k.y + 8 - cy) < 240) {
      tx = k.x;
      ty = k.y;
      adir = this.domDir(k.x + 8 - cx, k.y + 8 - cy);
    }
    g.target = [tx, ty];
    g.targetNode = this.nearestOpen(Math.round(tx / 8), Math.round(ty / 8));
    g.adir = adir;
    g.retargetAt = f;
  }

  private updateEscort(g: Group): void {
    if (!g.members.some((m) => !m.gone && m.t.alive)) return;
    if (g.phase !== 'advance') this.setPhase(g, 'advance');
    g.phaseAt = this.w.frame; // never "quiet": it stays with its boss
    this.escortTarget(g, false);
  }

  // ---------- tells ----------
  private radio(text: string): void {
    const r = this.w.radio;
    if (r.length && r[r.length - 1].text === text) return;
    r.push({ who: 'INTERCEPT', text, amb: true });
    this.logEv(`RADIO ${text}`);
  }

  /** A line from our side of the radio (the mechanic). */
  private say(text: string): void {
    const r = this.w.radio;
    if (r.length && r[r.length - 1].text === text) return;
    r.push({ who: OUR_WHO, text });
    this.logEv(`RADIO ${OUR_WHO} ${text}`);
  }

  /** Distant engines: the 'column' rumble at the column's world x (quiet and far by design). */
  private rumble(x: number, y: number): void {
    this.w.snd(TELL_SFX, x + 8, 1);
    this.logEv(`SFX ${TELL_SFX} (column at ${Math.round(x)},${Math.round(y)})`);
  }

  private logEv(s: string): void {
    this.log.push(`${String(this.w.frame).padStart(6)} ${s}`);
    if (this.log.length > 2000) this.log.splice(0, 500);
  }

  /** For tools: a unit's move order as text. */
  orderName(u: Unit): string {
    return ORDER_NAMES[u.order];
  }
}
