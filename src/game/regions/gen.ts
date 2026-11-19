// Region generator internals shared by every campaign region: the tank-node road planner, towns, depots,
// exits, spawns, garrisons and the reachability checks. Region 1 (farmland) is the Farm class itself; the
// other regions subclass it (src/game/regions/*.ts).
import {
  BRICK, EMPTY, GK_CONCRETE, GK_CROPS, GK_NONE, GK_PLANKS, GK_SUNFLOWER, GK_TILES, GK_VERT, GK_WHEAT, GK_YARD, ROAD, STEEL, TREES, WATER,
} from '../constants';
import { DOOR, Plot, WALL, blowCorner, breach, building, shape, terrace } from './build';
import { GameMap } from '../map';
import { mulberry32, type EnvName } from '../stages';
import type { BossKind, Depot, RegionSpec, RoadGraph, Town } from '../region';

/** Node reachability for a non-hover tank: brick is passable (it can be shot away), steel and water are walls. */
export function regionReach(spec: RegionSpec): { ok: boolean; unreachable: [number, number][] } {
  const map = new GameMap(spec.w, spec.h);
  map.eagle = false;
  map.loadCells(spec.cells);
  const seen = floodNodes(map, spec.playerSpawns[0]);
  const nw = map.nodesX;
  const unreachable: [number, number][] = [];
  for (const sp of [...spec.playerSpawns, ...spec.enemySpawns]) {
    if (!seen[(sp[1] >> 3) * nw + (sp[0] >> 3)]) unreachable.push(sp);
  }
  return { ok: unreachable.length === 0, unreachable };
}

export function floodNodes(map: GameMap, from: [number, number]): Uint8Array {
  const nw = map.nodesX;
  const nh = map.nodesY;
  const seen = new Uint8Array(nw * nh);
  const stack = [(from[1] >> 3) * nw + (from[0] >> 3)];
  seen[stack[0]] = 1;
  while (stack.length) {
    const i = stack.pop()!;
    const x = i % nw;
    const y = (i / nw) | 0;
    for (let d = 0; d < 4; d++) {
      const nx = d === 0 ? x + 1 : d === 1 ? x - 1 : x;
      const ny = d === 2 ? y + 1 : d === 3 ? y - 1 : y;
      if (nx < 0 || ny < 0 || nx >= nw || ny >= nh) continue;
      const j = ny * nw + nx;
      if (seen[j] || !Number.isFinite(map.nodeCost(nx, ny))) continue;
      seen[j] = 1;
      stack.push(j);
    }
  }
  return seen;
}

/** Cheapest route (blocked nodes cost 12) from a point to the area the player can reach; clears the blocked nodes. */
export function carve(spec: RegionSpec, from: [number, number]): void {
  const map = new GameMap(spec.w, spec.h);
  map.eagle = false;
  map.loadCells(spec.cells);
  const nw = map.nodesX;
  const nh = map.nodesY;
  const reach = floodNodes(map, spec.playerSpawns[0]);
  const dist = new Float32Array(nw * nh).fill(Infinity);
  const prev = new Int32Array(nw * nh).fill(-1);
  const buckets: number[][] = [[]];
  const s = (from[1] >> 3) * nw + (from[0] >> 3);
  dist[s] = 0;
  buckets[0].push(s);
  let goal = -1;
  for (let d = 0; d < buckets.length && goal < 0; d++) {
    for (const i of buckets[d] ?? []) {
      if (dist[i] < d) continue;
      if (reach[i]) { goal = i; break; }
      const x = i % nw;
      const y = (i / nw) | 0;
      for (let k = 0; k < 4; k++) {
        const nx = k === 0 ? x + 1 : k === 1 ? x - 1 : x;
        const ny = k === 2 ? y + 1 : k === 3 ? y - 1 : y;
        if (nx < 0 || ny < 0 || nx >= nw || ny >= nh) continue;
        const j = ny * nw + nx;
        const nd = d + (Number.isFinite(map.nodeCost(nx, ny)) ? 1 : 12);
        if (nd < dist[j]) {
          dist[j] = nd;
          prev[j] = i;
          (buckets[nd] ??= []).push(j);
        }
      }
    }
  }
  for (let i = goal; i >= 0; i = prev[i]) {
    if (Number.isFinite(map.nodeCost(i % nw, (i / nw) | 0))) continue;
    const nx = i % nw;
    const ny = (i / nw) | 0;
    for (let cy = ny * 2; cy < ny * 2 + 4; cy++) for (let cx = nx * 2; cx < nx * 2 + 4; cx++) spec.cells[cy * spec.w + cx] = EMPTY;
  }
}

// ---------------------------------------------------------------------------------------------------------------
// Generator internals. Planning happens on the tank-node grid (node n covers cells 2n..2n+3, i.e. one 16 px tank
// lane), so a road is a chain of lane nodes and its cells are exactly one tank wide.

export const TOWN_NAMES = [
  'KOLOSOBRID', 'TYKHOVODY', 'MAKOPILLIA', 'ZHURAVOPIL', 'VYSHNEKUT', 'MEDOSTAVY', 'BILOKOLOS', 'KALYNOBRID',
  'DUBOVYI KUT', 'STARE ZHYTO', 'VERBOZERO', 'SYNIOKLYN', 'OVSIANYI KUT', 'POLYNOHIR', 'ZORIOPIL', 'LELEKOPIL',
];
export const DEPOT_KINDS = ['AMMO DUMP', 'FUEL DUMP', 'TANK PARK'];
export const NDX = [0, 1, 0, -1]; // N E S W
export const NDY = [-1, 0, 1, 0];

export interface Rect { x: number; y: number; w: number; h: number }

export interface TownPlan {
  name: string;
  /** centre cell (even) */
  tcx: number;
  tcy: number;
  /** ring road size in cells (16 or 20) */
  S: number;
  /** reach beyond the ring per side N E S W (cells); arms run the full reach */
  ext: number[];
  arms: boolean[];
  rect: Rect;
  site: number;
  gates: number[];
}

export interface DepotPlan { name: string; rect: Rect; side: number; site: number; yard: number; gate: number }

/** A street the town lots line up along: a 4-cell road band from (x0, y0) running `len` cells in `dir` (±1). */
export interface Street { horiz: boolean; x0: number; y0: number; dir: number; len: number; sides: number[] }

/** Smooth value noise in [0, 1) at (x, y) (lattice spacing 1), for forest and marsh masks. */
export function vnoise(x: number, y: number, seed: number): number {
  const h = (i: number, j: number) => {
    let n = (i * 374761393 + j * 668265263 + seed * 2246822519) | 0;
    n = Math.imul(n ^ (n >>> 13), 1274126177);
    return ((n ^ (n >>> 16)) >>> 0) / 4294967296;
  };
  const xi = Math.floor(x);
  const yi = Math.floor(y);
  const fx = x - xi;
  const fy = y - yi;
  const sx = fx * fx * (3 - 2 * fx);
  const sy = fy * fy * (3 - 2 * fy);
  const a = h(xi, yi) + (h(xi + 1, yi) - h(xi, yi)) * sx;
  const b = h(xi, yi + 1) + (h(xi + 1, yi + 1) - h(xi, yi + 1)) * sx;
  return a + (b - a) * sy;
}

export class Heap {
  private k: number[] = [];
  private v: number[] = [];
  get size(): number { return this.k.length; }
  push(key: number, val: number): void {
    const k = this.k;
    const v = this.v;
    let i = k.length;
    k.push(key);
    v.push(val);
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (k[p] <= key) break;
      k[i] = k[p]; v[i] = v[p];
      i = p;
    }
    k[i] = key; v[i] = val;
  }
  pop(): number {
    const k = this.k;
    const v = this.v;
    const top = v[0];
    const lk = k.pop()!;
    const lv = v.pop()!;
    const n = k.length;
    if (n) {
      let i = 0;
      for (;;) {
        let c = 2 * i + 1;
        if (c >= n) break;
        if (c + 1 < n && k[c + 1] < k[c]) c++;
        if (k[c] >= lk) break;
        k[i] = k[c]; v[i] = v[c];
        i = c;
      }
      k[i] = lk; v[i] = lv;
    }
    return top;
  }
}

/**
 * Region 1 "Farmland", and the base class of every other region generator. Subclasses override the hooks below
 * (terrain, crossings, dressing, names) and reuse the planner: entry road, towns, depots, exits, road routing,
 * town and depot building, spawns, garrisons, the road graph and the reachability carve.
 */
export class Farm {
  /** RegionSpec name / env / boss of this kind */
  regionName = 'FARMLAND';
  env: EnvName = 'day';
  boss: BossKind = 'grinder';
  /** town names to draw from */
  townNames: string[] = TOWN_NAMES;
  depotKinds: string[] = DEPOT_KINDS;
  /** chance of a ford across the river */
  fordChance = 0.6;
  /** if set, every town layout must include one town this accepts (e.g. the station town by the rail yard) */
  townPrefer: ((t: TownPlan) => boolean) | null = null;
  /** cells of dry land a town keeps between itself and water (barrier cells) */
  townWaterPad = 6;
  depotWaterPad = 6;
  /** areas towns and depots stay clear of (e.g. the winter lair, the rail yard) */
  reserved: Rect[] = [];
  reservedHit(r: Rect, gap: number): boolean {
    return this.reserved.some((o) => r.x - gap < o.x + o.w && r.x + r.w + gap > o.x && r.y - gap < o.y + o.h && r.y + r.h + gap > o.y);
  }
  readonly W: number;
  readonly H: number;
  readonly NX: number;
  readonly NY: number;
  readonly c: Uint8Array;
  /** ground kind of every cell (GK_*, constants.ts): floors, paving, crops. Visual only. */
  readonly k: Uint8Array;
  readonly rng: () => number;
  /** lane[n]: 1 if node n carries road */
  readonly lane: Uint8Array;
  /** links[n]: bit d set if the road continues from node n in direction d (N E S W) */
  readonly links: Uint8Array;
  /** site that first laid each lane node (-1 = none) */
  readonly owner: Int32Array;
  /** routing: 1 = roads may not be built here (water, built-up areas, map border) */
  readonly blocked: Uint8Array;
  /** cells kept clear of hedges, copses and other field clutter */
  readonly prot: Uint8Array;
  /** union-find over sites: roads join the sites they touch */
  readonly uf: number[] = [];
  /** site centre node (routing heuristic target) and kind */
  readonly siteNode: number[] = [];
  readonly siteKind: string[] = [];
  readonly siteSide: number[] = [];
  towns: TownPlan[] = [];
  depots: DepotPlan[] = [];
  exits: number[][] = [];
  bridges: number[][] = [];
  entry: number[] = [];
  // river (in u/v space: u runs along the river, v across)
  horiz = true;
  /** why build() gave up (for the error message) */
  fail = '';
  rTop = new Int32Array(0);
  rBot = new Int32Array(0);

  /** later attempts (small maps) settle for fewer towns and depots */
  readonly relaxed: boolean;
  /** min distance (cells) from the player start to a town / a depot, scaled down on small maps */
  readonly townGap: number;
  readonly depotGap: number;

  constructor(seed: number, attempt: number, sw: number, sh: number) {
    this.rng = mulberry32((seed * 2654435761 + attempt * 40503 + 977) | 0);
    this.relaxed = attempt >= 12;
    const diag = Math.hypot(52 * sw, 52 * sh);
    this.townGap = Math.min(70, diag * 0.21);
    this.depotGap = Math.min(80, diag * 0.24);
    this.W = 52 * sw;
    this.H = 52 * sh;
    this.NX = (this.W >> 1) - 1;
    this.NY = (this.H >> 1) - 1;
    this.c = new Uint8Array(this.W * this.H);
    this.k = new Uint8Array(this.W * this.H);
    const nn = this.NX * this.NY;
    this.lane = new Uint8Array(nn);
    this.links = new Uint8Array(nn);
    this.owner = new Int32Array(nn).fill(-1);
    this.blocked = new Uint8Array(nn);
    this.prot = new Uint8Array(this.W * this.H);
  }

  // ---------- small helpers ----------
  ri(a: number, b: number): number { return a + Math.floor(this.rng() * (b - a + 1)); }
  even(v: number): number { return Math.round(v / 2) * 2; }
  at(x: number, y: number): number { return x < 0 || y < 0 || x >= this.W || y >= this.H ? -1 : this.c[y * this.W + x]; }
  set(x: number, y: number, t: number): void { if (x >= 0 && y >= 0 && x < this.W && y < this.H) this.c[y * this.W + x] = t; }
  fill(x: number, y: number, w: number, h: number, t: number, only = -1): void {
    for (let yy = Math.max(0, y); yy < Math.min(this.H, y + h); yy++) {
      for (let xx = Math.max(0, x); xx < Math.min(this.W, x + w); xx++) {
        const i = yy * this.W + xx;
        if (only < 0 || this.c[i] === only) this.c[i] = t;
      }
    }
  }
  /** Lay a ground kind over a rect. soft = only on open, unprotected ground that has no kind yet (fields, gardens). */
  kind(x: number, y: number, w: number, h: number, v: number, soft = false): void {
    for (let yy = Math.max(0, y); yy < Math.min(this.H, y + h); yy++) {
      for (let xx = Math.max(0, x); xx < Math.min(this.W, x + w); xx++) {
        const i = yy * this.W + xx;
        if (!soft || (this.c[i] === EMPTY && !this.prot[i] && !this.k[i])) this.k[i] = v;
      }
    }
  }
  /** Lay a ground kind wherever the rect has none yet (paving round buildings that already have their floors). */
  kindFree(x: number, y: number, w: number, h: number, v: number): void {
    for (let yy = Math.max(0, y); yy < Math.min(this.H, y + h); yy++) {
      for (let xx = Math.max(0, x); xx < Math.min(this.W, x + w); xx++) if (!this.k[yy * this.W + xx]) this.k[yy * this.W + xx] = v;
    }
  }
  protect(x: number, y: number, w: number, h: number): void {
    for (let yy = Math.max(0, y); yy < Math.min(this.H, y + h); yy++) {
      for (let xx = Math.max(0, x); xx < Math.min(this.W, x + w); xx++) this.prot[yy * this.W + xx] = 1;
    }
  }
  /** True if every cell in the rect is inside the map, EMPTY and unprotected (when `prot`). */
  free(x: number, y: number, w: number, h: number, prot = true): boolean {
    if (x < 0 || y < 0 || x + w > this.W || y + h > this.H) return false;
    for (let yy = y; yy < y + h; yy++) {
      for (let xx = x; xx < x + w; xx++) {
        const i = yy * this.W + xx;
        if (this.c[i] !== EMPTY || (prot && this.prot[i])) return false;
      }
    }
    return true;
  }
  /** A cell in river (u/v) space: u along the river's axis, v across. */
  uv(u: number, v: number): [number, number] { return this.horiz ? [u, v] : [v, u]; }
  setUV(u: number, v: number, t: number): void { const [x, y] = this.uv(u, v); this.set(x, y, t); }
  atUV(u: number, v: number): number { const [x, y] = this.uv(u, v); return this.at(x, y); }
  /** Rect from (u0, v0) spanning lu x lv cells (negative = the other way) in world cells. */
  rectUV(u0: number, v0: number, lu: number, lv: number): Rect {
    const [x, y] = this.uv(Math.min(u0, u0 + lu), Math.min(v0, v0 + lv));
    const [w, h] = this.horiz ? [Math.abs(lu), Math.abs(lv)] : [Math.abs(lv), Math.abs(lu)];
    return { x, y, w, h };
  }
  freeUV(u0: number, v0: number, lu: number, lv: number): boolean { const r = this.rectUV(u0, v0, lu, lv); return this.free(r.x, r.y, r.w, r.h); }
  fillUV(u0: number, v0: number, lu: number, lv: number, t: number): void { const r = this.rectUV(u0, v0, lu, lv); this.fill(r.x, r.y, r.w, r.h, t); }
  protectUV(u0: number, v0: number, lu: number, lv: number): void { const r = this.rectUV(u0, v0, lu, lv); this.protect(r.x, r.y, r.w, r.h); }
  /** Brick (or another type) only on free, unprotected ground, like plant(). */
  put(x: number, y: number, t: number): void {
    if (x < 0 || y < 0 || x >= this.W || y >= this.H) return;
    const i = y * this.W + x;
    if (this.c[i] === EMPTY && !this.prot[i]) this.c[i] = t;
  }

  /** Protect the empty cells within d cells (square) of any cell of `type`, so dressing leaves them open. */
  protectNear(type: number, d: number): void {
    const { W, H } = this;
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        if (this.c[y * W + x] !== type) continue;
        for (let j = -d; j <= d; j++) for (let i = -d; i <= d; i++) {
          const xx = x + i;
          const yy = y + j;
          if (xx >= 0 && yy >= 0 && xx < W && yy < H && this.c[yy * W + xx] === EMPTY) this.prot[yy * W + xx] = 1;
        }
      }
    }
  }
  /** Field clutter (trees) goes only on free, unprotected ground. */
  plant(x: number, y: number): void {
    if (x < 0 || y < 0 || x >= this.W || y >= this.H) return;
    const i = y * this.W + x;
    if (this.c[i] === EMPTY && !this.prot[i]) this.c[i] = TREES;
  }
  /** Cells roads and buildings keep away from (water; rail too in the rail region). */
  barrier(t: number): boolean { return t === WATER; }
  nodeBarrier(n: number): boolean {
    const x0 = this.nx(n) * 2;
    const y0 = this.ny(n) * 2;
    for (let y = y0; y < y0 + 4; y++) for (let x = x0; x < x0 + 4; x++) if (this.barrier(this.at(x, y))) return true;
    return false;
  }
  node(nx: number, ny: number): number { return ny * this.NX + nx; }
  nx(n: number): number { return n % this.NX; }
  ny(n: number): number { return (n / this.NX) | 0; }
  inNodes(nx: number, ny: number): boolean { return nx >= 0 && ny >= 0 && nx < this.NX && ny < this.NY; }
  /** Node in river space: u along the river, v across. */
  uvNode(un: number, vn: number): number { return this.horiz ? this.node(un, vn) : this.node(vn, un); }
  nodeHas(n: number, t: number): boolean {
    const x0 = this.nx(n) * 2;
    const y0 = this.ny(n) * 2;
    for (let y = y0; y < y0 + 4; y++) for (let x = x0; x < x0 + 4; x++) if (this.at(x, y) === t) return true;
    return false;
  }
  nodeAll(n: number, t: number): boolean {
    const x0 = this.nx(n) * 2;
    const y0 = this.ny(n) * 2;
    for (let y = y0; y < y0 + 4; y++) for (let x = x0; x < x0 + 4; x++) if (this.at(x, y) !== t) return false;
    return true;
  }
  find(s: number): number {
    while (this.uf[s] !== s) s = this.uf[s] = this.uf[this.uf[s]];
    return s;
  }
  union(a: number, b: number): void { this.uf[this.find(a)] = this.find(b); }
  newSite(kind: string, n: number): number {
    const s = this.uf.length;
    this.uf.push(s);
    this.siteNode.push(n);
    this.siteKind.push(kind);
    this.siteSide.push(this.riverSide(n));
    return s;
  }
  /** 0 / 1 = which bank of the river a node is on, -1 = in or next to the river. */
  riverSide(n: number): number {
    const cx = this.nx(n) * 2 + 2;
    const cy = this.ny(n) * 2 + 2;
    const u = this.horiz ? cx : cy;
    const v = this.horiz ? cy : cx;
    if (v < this.rTop[u] - 2) return 0;
    if (v > this.rBot[u] + 2) return 1;
    return -1;
  }
  /** Lay road along consecutive nodes (each step 1 node apart), joining the sites it touches. */
  layPath(path: number[], site: number): void {
    for (let i = 0; i < path.length; i++) {
      const n = path[i];
      if (this.lane[n]) this.union(site, this.owner[n]);
      else {
        this.lane[n] = 1;
        this.owner[n] = site;
      }
      if (i > 0) {
        const m = path[i - 1];
        const d = this.dirTo(m, n);
        this.links[m] |= 1 << d;
        this.links[n] |= 1 << ((d + 2) & 3);
      }
    }
  }
  dirTo(a: number, b: number): number {
    const dx = this.nx(b) - this.nx(a);
    const dy = this.ny(b) - this.ny(a);
    return dy < 0 ? 0 : dx > 0 ? 1 : dy > 0 ? 2 : 3;
  }
  line(nx: number, ny: number, d: number, steps: number): number[] {
    const out: number[] = [];
    for (let k = 0; k <= steps; k++) out.push(this.node(nx + NDX[d] * k, ny + NDY[d] * k));
    return out;
  }

  // ---------- build ----------
  /** Terrain before any planning (Farm: the river). Must fill rTop/rBot (u space) for riverSide. */
  terrain(): void { this.makeRiver(); }
  /** Dressing after roads, depots and towns are built (Farm: fields, hedges, copses, pond, willows). */
  dress(): void { this.fieldDressing(); }
  /** Last touches on the finished spec before the reachability check (rail / river polylines, lair). */
  extra(_spec: RegionSpec): void {}

  build(): RegionSpec | null {
    this.terrain();
    for (let n = 0; n < this.NX * this.NY; n++) {
      const x = this.nx(n);
      const y = this.ny(n);
      // roads keep a cell of bank between them and the water, so only bridges have water right beside them
      if (x < 2 || y < 2 || x >= this.NX - 2 || y >= this.NY - 2 || this.rectHasWater({ x: x * 2, y: y * 2, w: 4, h: 4 }, 1)) this.blocked[n] = 1;
    }
    const steps: [string, () => boolean][] = [
      ['bridges', () => this.placeBridges()], ['entry', () => this.placeEntry()], ['towns', () => this.placeTowns()],
      ['depots', () => this.placeDepots()], ['exits', () => this.placeExits()], ['roads', () => this.connect()],
    ];
    for (const [name, step] of steps) {
      if (!step()) {
        this.fail = name;
        return null;
      }
    }
    this.fail = 'reach';
    // road cells
    for (let n = 0; n < this.NX * this.NY; n++) if (this.lane[n]) this.fill(this.nx(n) * 2, this.ny(n) * 2, 4, 4, ROAD);
    for (const d of this.depots) this.buildDepot(d);
    for (const t of this.towns) this.buildTown(t);
    this.dress();
    return this.finish();
  }

  // ---------- river ----------
  makeRiver(): void {
    const { W, H, rng } = this;
    this.horiz = W >= H ? rng() < 0.75 : rng() < 0.25;
    const U = this.horiz ? W : H;
    const V = this.horiz ? H : W;
    const base = V * (0.4 + rng() * 0.2);
    const a1 = V * (0.06 + rng() * 0.04);
    const a2 = V * (0.015 + rng() * 0.02);
    const f1 = ((0.8 + rng() * 0.8) * Math.PI * 2) / U;
    const f2 = ((2.5 + rng() * 2) * Math.PI * 2) / U;
    const f3 = ((2 + rng() * 2) * Math.PI * 2) / U;
    const p1 = rng() * 6.28;
    const p2 = rng() * 6.28;
    const p3 = rng() * 6.28;
    this.rTop = new Int32Array(U);
    this.rBot = new Int32Array(U);
    for (let u = 0; u < U; u++) {
      const vc = base + a1 * Math.sin(u * f1 + p1) + a2 * Math.sin(u * f2 + p2);
      const wid = Math.max(6, Math.min(10, this.even(8 + 2.4 * Math.sin(u * f3 + p3))));
      const v0 = Math.max(12, Math.min(V - 12 - wid, Math.round(vc - wid / 2)));
      this.rTop[u] = v0;
      this.rBot[u] = v0 + wid;
      for (let v = v0; v < v0 + wid; v++) {
        if (this.horiz) this.set(u, v, WATER);
        else this.set(v, u, WATER);
      }
    }
  }

  /** 2-3 straight road bridges across the river (plus sometimes a ford: a gravel bar a tank can drive over). */
  placeBridges(): boolean {
    const U = this.horiz ? this.W : this.H;
    const NU = (U >> 1) - 1;
    const nb = this.bridgeCount();
    const seg = NU / nb;
    const used: number[] = [];
    for (let k = 0; k < nb; k++) {
      const un = Math.max(8, Math.min(NU - 9, Math.round(seg * k + seg * (0.3 + this.rng() * 0.4))));
      let top = 1e9;
      let bot = -1e9;
      for (let u = un * 2; u < un * 2 + 4; u++) {
        top = Math.min(top, this.rTop[u]);
        bot = Math.max(bot, this.rBot[u]);
      }
      const va = Math.floor((top - 4) / 2) - 1;
      const vb = Math.ceil(bot / 2) + 1;
      const path: number[] = [];
      for (let vn = va; vn <= vb; vn++) path.push(this.uvNode(un, vn));
      const s = this.newSite('bridge', path[path.length >> 1]);
      this.siteSide[s] = -1;
      this.layPath(path, s);
      this.bridges.push(path);
      used.push(un);
      // keep the banks round a bridge clear of trees
      const [x0, y0] = this.horiz ? [un * 2 - 6, va * 2 - 4] : [va * 2 - 4, un * 2 - 6];
      const [w, h] = this.horiz ? [16, (vb - va) * 2 + 12] : [(vb - va) * 2 + 12, 16];
      this.protect(x0, y0, w, h);
    }
    if (this.rng() < this.fordChance) {
      // ford: a gravel bar well away from the bridges
      for (let tries = 0; tries < 30; tries++) {
        const un = this.ri(6, NU - 7);
        if (used.some((b) => Math.abs(b - un) < 16)) continue;
        for (let u = un * 2 - 1; u < un * 2 + 5; u++) {
          const inner = u >= un * 2 && u < un * 2 + 4;
          if (!inner && this.rng() < 0.5) continue;
          for (let v = this.rTop[u] - 1; v <= this.rBot[u]; v++) {
            if (this.horiz) this.set(u, v, EMPTY);
            else this.set(v, u, EMPTY);
          }
        }
        const [x0, y0] = this.horiz ? [un * 2 - 6, this.rTop[un * 2] - 6] : [this.rTop[un * 2] - 6, un * 2 - 6];
        const [w, h] = this.horiz ? [16, 22] : [22, 16];
        this.protect(x0, y0, w, h);
        break;
      }
    }
    return true;
  }

  bridgeCount(): number { return this.ri(2, 3); }

  /** The player drives in along a road from the edge parallel to the river. */
  placeEntry(): boolean {
    const edge = this.horiz ? (this.rng() < 0.5 ? 2 : 0) : this.rng() < 0.5 ? 1 : 3;
    const along = edge === 0 || edge === 2 ? this.NX : this.NY;
    for (let tries = 0; tries < 40; tries++) {
      const p = this.ri(Math.round(along * 0.2), Math.round(along * 0.8));
      const path = this.edgeLane(edge, p, 14);
      if (path.some((n) => this.nodeBarrier(n) || this.lane[n])) continue;
      const s = this.newSite('player', path[path.length - 1]);
      this.layPath(path, s);
      this.entry = path;
      const n = path[path.length - 1];
      this.protect(this.nx(n) * 2 - 16, this.ny(n) * 2 - 16, 36, 36);
      return true;
    }
    return false;
  }

  /** Lane from the map edge `edge` (N E S W) at position p, `len` nodes inward. First node touches the edge. */
  edgeLane(edge: number, p: number, len: number): number[] {
    const out: number[] = [];
    for (let k = 0; k <= len; k++) {
      if (edge === 0) out.push(this.node(p, k));
      else if (edge === 2) out.push(this.node(p, this.NY - 1 - k));
      else if (edge === 3) out.push(this.node(k, p));
      else out.push(this.node(this.NX - 1 - k, p));
    }
    return out;
  }

  playerNode(): number { return this.entry[this.entry.length - 1]; }

  distCells(n: number, x: number, y: number): number { return Math.hypot(this.nx(n) * 2 + 2 - x, this.ny(n) * 2 + 2 - y); }

  rectHasLane(r: Rect, pad: number): boolean {
    const nx0 = Math.max(0, ((r.x - pad) >> 1) - 1);
    const ny0 = Math.max(0, ((r.y - pad) >> 1) - 1);
    const nx1 = Math.min(this.NX - 1, (r.x + r.w + pad) >> 1);
    const ny1 = Math.min(this.NY - 1, (r.y + r.h + pad) >> 1);
    for (let y = ny0; y <= ny1; y++) {
      for (let x = nx0; x <= nx1; x++) {
        if (!this.lane[this.node(x, y)]) continue;
        if (x * 2 + 4 > r.x - pad && x * 2 < r.x + r.w + pad && y * 2 + 4 > r.y - pad && y * 2 < r.y + r.h + pad) return true;
      }
    }
    return false;
  }
  rectHasWater(r: Rect, pad: number): boolean {
    for (let y = Math.max(0, r.y - pad); y < Math.min(this.H, r.y + r.h + pad); y++) {
      for (let x = Math.max(0, r.x - pad); x < Math.min(this.W, r.x + r.w + pad); x++) if (this.barrier(this.c[y * this.W + x])) return true;
    }
    return false;
  }
  /**
   * Mark an area as off limits for new roads: nodes overlapping the rect inset by `inset` cells (towns: 2, so roads
   * may leave a street end; depots: -2, so no road runs along the walls).
   */
  blockRect(r: Rect, inset: number): void {
    const ix0 = r.x + inset;
    const iy0 = r.y + inset;
    const ix1 = r.x + r.w - inset;
    const iy1 = r.y + r.h - inset;
    for (let ny = Math.max(0, (iy0 >> 1) - 2); ny <= Math.min(this.NY - 1, iy1 >> 1); ny++) {
      for (let nx = Math.max(0, (ix0 >> 1) - 2); nx <= Math.min(this.NX - 1, ix1 >> 1); nx++) {
        if (nx * 2 + 4 > ix0 && nx * 2 < ix1 && ny * 2 + 4 > iy0 && ny * 2 < iy1) this.blocked[this.node(nx, ny)] = 1;
      }
    }
  }

  // ---------- towns ----------
  placeTowns(): boolean {
    const { W, H } = this;
    const fit = Math.max(2, Math.min(5, Math.round((W * H) / (52 * 52 * 4))));
    const want = this.townCount(fit);
    const pn = this.playerNode();
    const names = [...this.townNames];
    const cands: TownPlan[] = [];
    for (let tries = 0; tries < 3000 && cands.length < 500; tries++) {
      const S = this.rng() < 0.5 ? 16 : 20;
      const arms = [true, true, true, true];
      if (this.rng() < 0.55) arms[this.ri(0, 3)] = false;
      const hamlet = this.rng() < 0.3; // a small village: short streets
      const ext = arms.map((a) => (a ? 2 * (hamlet ? this.ri(6, 8) : this.ri(9, 12)) : 2 * this.ri(5, 6)));
      const tcx = this.even(this.ri(10 + S / 2 + ext[3], W - 10 - S / 2 - ext[1]));
      const tcy = this.even(this.ri(10 + S / 2 + ext[0], H - 10 - S / 2 - ext[2]));
      const rect = { x: tcx - S / 2 - ext[3], y: tcy - S / 2 - ext[0], w: S + ext[1] + ext[3], h: S + ext[0] + ext[2] };
      if (rect.x < 8 || rect.y < 8 || rect.x + rect.w > W - 8 || rect.y + rect.h > H - 8) continue;
      if (this.rectHasWater(rect, this.townWaterPad) || this.rectHasLane(rect, 4) || this.reservedHit(rect, 14)) continue;
      if (this.distCells(pn, tcx, tcy) < this.townGap) continue;
      cands.push({ name: '', tcx, tcy, S, ext, arms, rect, site: -1, gates: [] });
    }
    const overlaps = (a: Rect, b: Rect, gap: number) =>
      a.x - gap < b.x + b.w && a.x + a.w + gap > b.x && a.y - gap < b.y + b.h && a.y + a.h + gap > b.y;
    // random greedy layouts; keep the one with the most towns, then the most even spacing
    let best: TownPlan[] = [];
    let bestScore = -1;
    for (let trial = 0; trial < 60; trial++) {
      for (let i = cands.length - 1; i > 0; i--) {
        const j = Math.floor(this.rng() * (i + 1));
        [cands[i], cands[j]] = [cands[j], cands[i]];
      }
      const got: TownPlan[] = [];
      const pref = this.townPrefer;
      if (pref) {
        const first = cands.find(pref);
        if (first) got.push(first);
      }
      for (const t of cands) {
        if (got.length >= want) break;
        if (got.some((o) => overlaps(o.rect, t.rect, 18) || Math.hypot(o.tcx - t.tcx, o.tcy - t.tcy) < 70)) continue;
        got.push(t);
      }
      let dmin = 1e9;
      for (const a of got) {
        dmin = Math.min(dmin, this.distCells(pn, a.tcx, a.tcy));
        for (const b of got) if (a !== b) dmin = Math.min(dmin, Math.hypot(a.tcx - b.tcx, a.tcy - b.tcy));
      }
      const score = got.length * 1000 + Math.min(dmin, 999);
      if (score > bestScore) { bestScore = score; best = got; }
    }
    for (const t of best) {
      t.name = names.length ? names.splice(this.ri(0, names.length - 1), 1)[0] : `HAMLET ${this.towns.length + 1}`;
      this.towns.push(t);
    }
    if (this.towns.length < (this.relaxed ? 1 : this.minTowns(fit))) return false;
    for (const t of this.towns) this.planTownLanes(t);
    return true;
  }

  townCount(fit: number): number { return fit - (this.rng() < 0.5 ? 0 : 1); }
  minTowns(fit: number): number { return Math.max(2, fit - 1); }

  planTownLanes(t: TownPlan): void {
    const { tcx, tcy, S, ext, arms } = t;
    const x0 = (tcx - S / 2) >> 1;
    const y0 = (tcy - S / 2) >> 1;
    const x1 = (tcx + S / 2 - 4) >> 1;
    const y1 = (tcy + S / 2 - 4) >> 1;
    t.site = this.newSite('town', this.node(tcx >> 1, tcy >> 1));
    this.blockRect(t.rect, 2);
    // ring road round the green
    const ring: number[] = [];
    for (let x = x0; x <= x1; x++) ring.push(this.node(x, y0));
    for (let y = y0 + 1; y <= y1; y++) ring.push(this.node(x1, y));
    for (let x = x1 - 1; x >= x0; x--) ring.push(this.node(x, y1));
    for (let y = y1 - 1; y >= y0; y--) ring.push(this.node(x0, y));
    this.layPath(ring, t.site);
    // arms from the middle of each side out to the edge of the town
    const ax = (tcx - 2) >> 1;
    const ay = (tcy - 2) >> 1;
    for (let d = 0; d < 4; d++) {
      if (!arms[d]) continue;
      const steps = ext[d] >> 1;
      const start = d === 0 ? [ax, y0] : d === 1 ? [x1, ay] : d === 2 ? [ax, y1] : [x0, ay];
      const path = this.line(start[0], start[1], d, steps);
      this.layPath(path, t.site);
      t.gates.push(path[path.length - 1]);
    }
  }

  // ---------- depots ----------
  placeDepots(): boolean {
    const { W, H } = this;
    const want = W * H >= 52 * 52 * 12 ? this.ri(2, 3) : 2;
    const pn = this.playerNode();
    const cands: Rect[] = [];
    for (let tries = 0; tries < 700 && cands.length < 200; tries++) {
      const w = this.rng() < 0.5 ? 24 : 28;
      const h = this.rng() < 0.5 ? 24 : 28;
      const x = this.even(this.ri(14, W - 14 - w));
      const y = this.even(this.ri(14, H - 14 - h));
      const r = { x, y, w, h };
      if (this.rectHasWater(r, this.depotWaterPad) || this.rectHasLane(r, 6) || this.reservedHit(r, 14)) continue;
      if (this.towns.some((t) => r.x - 14 < t.rect.x + t.rect.w && r.x + r.w + 14 > t.rect.x && r.y - 14 < t.rect.y + t.rect.h && r.y + r.h + 14 > t.rect.y)) continue;
      if (this.distCells(pn, x + w / 2, y + h / 2) < this.depotGap) continue;
      cands.push(r);
    }
    const kinds = [...this.depotKinds];
    while (this.depots.length < want) {
      let best: Rect | null = null;
      let bd = -1;
      for (const r of cands) {
        const cx = r.x + r.w / 2;
        const cy = r.y + r.h / 2;
        if (this.depots.some((d) => Math.abs(d.rect.x + d.rect.w / 2 - cx) < (d.rect.w + r.w) / 2 + 30 && Math.abs(d.rect.y + d.rect.h / 2 - cy) < (d.rect.h + r.h) / 2 + 30)) continue;
        // deep in enemy country, spread apart, not hugging a town
        let sep = 1e9;
        for (const d of this.depots) sep = Math.min(sep, Math.hypot(d.rect.x - r.x, d.rect.y - r.y));
        let tsep = 1e9;
        for (const t of this.towns) tsep = Math.min(tsep, Math.hypot(t.tcx - cx, t.tcy - cy));
        const score = (this.distCells(pn, cx, cy) + Math.min(sep, 200) * 0.6 + Math.min(tsep, 60) * 0.5) * (0.85 + this.rng() * 0.3);
        if (score > bd) { bd = score; best = r; }
      }
      if (!best) break;
      // gate on the side facing the middle of the map
      const cx = best.x + best.w / 2;
      const cy = best.y + best.h / 2;
      const dx = W / 2 - cx;
      const dy = H / 2 - cy;
      const side = Math.abs(dx) * (W > H ? H / W : 1) > Math.abs(dy) ? (dx > 0 ? 1 : 3) : dy > 0 ? 2 : 0;
      const gx = (best.x + best.w / 2 - 2) >> 1;
      const gy = (best.y + best.h / 2 - 2) >> 1;
      // lane from inside the yard, through the gate, 3 nodes out
      let start: number[];
      let steps: number;
      if (side === 0) { start = [gx, (best.y >> 1) + 2]; steps = 5; }
      else if (side === 2) { start = [gx, ((best.y + best.h) >> 1) - 4]; steps = 5; }
      else if (side === 3) { start = [(best.x >> 1) + 2, gy]; steps = 5; }
      else { start = [((best.x + best.w) >> 1) - 4, gy]; steps = 5; }
      const path = this.line(start[0], start[1], side, steps);
      if (path.some((n) => !this.inNodes(this.nx(n), this.ny(n)) || this.lane[n] || this.nodeBarrier(n))) {
        cands.splice(cands.indexOf(best), 1);
        continue;
      }
      const kind = kinds.length ? kinds.splice(this.ri(0, kinds.length - 1), 1)[0] : 'DEPOT';
      const site = this.newSite('depot', path[path.length - 1]);
      this.layPath(path, site);
      this.blockRect(best, -2);
      this.depots.push({ name: `${kind} ${this.ri(2, 9)}`, rect: best, side, site, yard: path[0], gate: path[path.length - 1] });
    }
    return this.depots.length >= (this.relaxed ? 1 : 2);
  }

  // ---------- enemy road exits ----------
  placeExits(): boolean {
    const pe = this.horiz ? (this.ny(this.entry[0]) === 0 ? 0 : 2) : this.nx(this.entry[0]) === 0 ? 3 : 1;
    const far = (pe + 2) & 3;
    const edges = [far, far, (pe + 1) & 3, (pe + 3) & 3];
    const want = this.ri(2, 3);
    for (let tries = 0; tries < 80 && this.exits.length < want; tries++) {
      const edge = edges[this.exits.length === 0 ? 0 : this.ri(0, 3)];
      const along = edge === 0 || edge === 2 ? this.NX : this.NY;
      const p = this.ri(6, along - 7);
      const path = this.edgeLane(edge, p, 7);
      if (path.some((n) => this.nodeBarrier(n) || this.lane[n] || (this.blocked[n] && this.inside(n)))) continue;
      const end = path[path.length - 1];
      if (this.exits.some((e) => Math.abs(this.nx(e[e.length - 1]) - this.nx(end)) + Math.abs(this.ny(e[e.length - 1]) - this.ny(end)) < 30)) continue;
      if (Math.abs(this.nx(end) - this.nx(this.playerNode())) + Math.abs(this.ny(end) - this.ny(this.playerNode())) < 50) continue;
      const s = this.newSite('exit', end);
      this.layPath(path, s);
      this.exits.push(path);
      this.protect(this.nx(end) * 2 - 6, this.ny(end) * 2 - 6, 16, 16);
    }
    return this.exits.length >= 2;
  }
  /** Not in the map border band (where edge lanes are allowed). */
  inside(n: number): boolean {
    const x = this.nx(n);
    const y = this.ny(n);
    return x >= 2 && y >= 2 && x < this.NX - 2 && y < this.NY - 2;
  }

  // ---------- road routing ----------
  /**
   * A* over (node, heading) from any lane node whose site is in `from`'s group to one in `to`'s group. Straight
   * runs are cheap and turns cost extra, so roads come out as long straights with a few bends; existing roads are
   * cheap to reuse and running alongside one costs extra (no double-width roads).
   */
  route(sources: number[], isGoal: (n: number) => boolean, target: number, maxCost = Infinity, startDir = -1,
    avoid: readonly number[] = []): number[] | null {
    const { NX, NY } = this;
    const nn = NX * NY;
    const g = new Float32Array(nn * 4).fill(Infinity);
    const prev = new Int32Array(nn * 4).fill(-1);
    const heap = new Heap();
    const tx = this.nx(target);
    const ty = this.ny(target);
    const hz = (n: number) => (Math.abs(this.nx(n) - tx) + Math.abs(this.ny(n) - ty)) * 0.6;
    for (const s of sources) {
      for (let d = 0; d < 4; d++) {
        g[s * 4 + d] = 0;
        heap.push(hz(s), s * 4 + d);
      }
    }
    const TURN = 7;
    let goal = -1;
    let pops = 0;
    while (heap.size) {
      const st = heap.pop();
      const n = st >> 2;
      const din = st & 3;
      const gc = g[st];
      if (gc > maxCost) break;
      if (++pops > 400000) break;
      if (isGoal(n) && gc > 0) { goal = st; break; }
      const x = this.nx(n);
      const y = this.ny(n);
      for (let d = 0; d < 4; d++) {
        if (d === ((din + 2) & 3) && gc > 0) continue;
        if (gc === 0 && startDir >= 0 && d !== startDir) continue;
        const x2 = x + NDX[d];
        const y2 = y + NDY[d];
        if (x2 < 0 || y2 < 0 || x2 >= NX || y2 >= NY) continue;
        const m = this.node(x2, y2);
        const onLane = this.lane[m] === 1;
        if (!onLane && this.blocked[m]) continue;
        if (avoid.length && avoid.includes(m)) continue;
        let cost = onLane ? 0.35 : 1;
        if (onLane && this.lane[n] && !(this.links[n] & (1 << d))) cost = 3; // hopping between two parallel roads
        if (!onLane) {
          // alongside an existing road (not counting the one we come from)
          const p1 = (d + 1) & 3;
          const p2 = (d + 3) & 3;
          if (this.inNodes(x2 + NDX[p1], y2 + NDY[p1]) && this.lane[this.node(x2 + NDX[p1], y2 + NDY[p1])]) cost += 4;
          if (this.inNodes(x2 + NDX[p2], y2 + NDY[p2]) && this.lane[this.node(x2 + NDX[p2], y2 + NDY[p2])]) cost += 4;
          // hugging a town, depot or the river bank
          for (const p of [p1, p2]) {
            const hx = x2 + NDX[p] * 2;
            const hy = y2 + NDY[p] * 2;
            if (this.inNodes(hx, hy) && this.blocked[this.node(hx, hy)] && this.inside(this.node(hx, hy))) cost += 1.5;
          }
        }
        if (gc > 0 && d !== din) cost += TURN;
        const nd = gc + cost;
        const ms = m * 4 + d;
        if (nd < g[ms]) {
          g[ms] = nd;
          prev[ms] = st;
          heap.push(nd + hz(m), ms);
        }
      }
    }
    if (goal < 0) return null;
    const path: number[] = [];
    for (let s = goal; s >= 0; s = prev[s]) {
      const n = s >> 2;
      if (path[path.length - 1] !== n) path.push(n);
      if (g[s] === 0) break;
    }
    return path.reverse();
  }

  lanesOf(group: number): number[] {
    const out: number[] = [];
    for (let n = 0; n < this.NX * this.NY; n++) if (this.lane[n] && this.find(this.owner[n]) === group) out.push(n);
    return out;
  }

  /** Join every site into one network: shortest site pairs first (Kruskal), never straight across the river. */
  connect(): boolean {
    const ns = this.uf.length;
    const pairs: [number, number, number][] = [];
    for (let i = 0; i < ns; i++) {
      for (let j = i + 1; j < ns; j++) {
        const ki = this.siteKind[i];
        const kj = this.siteKind[j];
        if (ki === kj && ki !== 'town') continue; // exit-exit, bridge-bridge, depot-depot
        if ((ki === 'exit' && kj === 'player') || (kj === 'exit' && ki === 'player')) continue;
        if ((ki === 'depot' && kj === 'player') || (kj === 'depot' && ki === 'player')) continue;
        const si = this.siteSide[i];
        const sj = this.siteSide[j];
        if (si >= 0 && sj >= 0 && si !== sj) continue;
        const a = this.siteNode[i];
        const b = this.siteNode[j];
        let d = Math.hypot(this.nx(a) - this.nx(b), this.ny(a) - this.ny(b));
        if (ki === 'bridge' || kj === 'bridge') d *= 0.8;
        pairs.push([d, i, j]);
      }
    }
    pairs.sort((p, q) => p[0] - q[0]);
    for (const [, i, j] of pairs) {
      const gi = this.find(i);
      const gj = this.find(j);
      if (gi === gj) continue;
      const path = this.route(this.lanesOf(gi), (n) => this.lane[n] === 1 && this.find(this.owner[n]) === gj, this.siteNode[j]);
      if (!path) continue;
      this.layPath(path, i);
      this.union(i, j);
    }
    const g0 = this.find(0);
    for (let s = 1; s < ns; s++) if (this.find(s) !== g0) return false;
    // bridge ends that lead nowhere: run a road on to the nearest road on that bank
    for (const b of this.bridges) {
      for (const [end, inner] of [[b[0], b[1]], [b[b.length - 1], b[b.length - 2]]]) {
        const d = this.dirTo(inner, end);
        if (this.links[end] & ~(1 << ((d + 2) & 3))) continue;
        const path = this.route([end], (n) => this.lane[n] === 1 && !b.includes(n), end, 400, d, b);
        if (path) this.layPath(path, this.owner[end]);
      }
    }
    // town streets that still end at the town edge: run them on to the nearest road if it's close
    for (const t of this.towns) {
      for (const gate of t.gates) {
        const d = this.dirOut(t, gate);
        const nxt = this.node(this.nx(gate) + NDX[d], this.ny(gate) + NDY[d]);
        if (this.links[gate] & (1 << d)) continue;
        if (this.blocked[nxt] && !this.lane[nxt]) continue;
        const R = t.rect;
        const outside = (n: number) => {
          const x = this.nx(n) * 2;
          const y = this.ny(n) * 2;
          return x + 4 <= R.x || y + 4 <= R.y || x >= R.x + R.w || y >= R.y + R.h;
        };
        const own: number[] = [];
        for (let n = 0; n < this.NX * this.NY; n++) if (this.lane[n] && this.owner[n] === t.site && !outside(n) && n !== gate) own.push(n);
        const path = this.route([gate], (n) => this.lane[n] === 1 && outside(n), gate, 32, d, own);
        if (path) this.layPath(path, t.site);
      }
    }
    return true;
  }
  dirOut(t: TownPlan, gate: number): number {
    const dx = this.nx(gate) * 2 + 2 - t.tcx;
    const dy = this.ny(gate) * 2 + 2 - t.tcy;
    return Math.abs(dx) > Math.abs(dy) ? (dx > 0 ? 1 : 3) : dy > 0 ? 2 : 0;
  }

  // ---------- depot compound ----------
  /**
   * A walled compound on poured concrete: brick panels between steel posts with steel corner towers and gate posts,
   * a warehouse (two bays, a doorway each) built against the wall opposite the gate, fuel tanks down one side and
   * crate stacks down the other. The middle, where the target stands, stays open.
   */
  buildDepot(d: DepotPlan): void {
    const { x, y, w, h } = d.rect;
    this.kind(x, y, w, h, GK_CONCRETE);
    for (let yy = y; yy < y + h; yy++) {
      for (let xx = x; xx < x + w; xx++) {
        const edgeX = xx < x + 2 || xx >= x + w - 2;
        const edgeY = yy < y + 2 || yy >= y + h - 2;
        if (!edgeX && !edgeY) continue;
        if (this.at(xx, yy) === ROAD) continue;
        const corner = (xx < x + 4 || xx >= x + w - 4) && (yy < y + 4 || yy >= y + h - 4);
        const along = edgeY ? xx - x : yy - y;
        const post = along % 8 < 2;
        this.set(xx, yy, corner || post ? STEEL : BRICK);
      }
    }
    // gate posts
    const gx = this.nx(d.yard) * 2;
    const gy = this.ny(d.yard) * 2;
    if (d.side === 0 || d.side === 2) {
      const wy = d.side === 0 ? y : y + h - 2;
      this.fill(gx - 2, wy, 2, 2, STEEL);
      this.fill(gx + 4, wy, 2, 2, STEEL);
    } else {
      const wx = d.side === 3 ? x : x + w - 2;
      this.fill(wx, gy - 2, 2, 2, STEEL);
      this.fill(wx, gy + 4, 2, 2, STEEL);
    }
    const noRoad = (r: Rect) => {
      for (let yy = r.y - 1; yy < r.y + r.h + 1; yy++) for (let xx = r.x - 1; xx < r.x + r.w + 1; xx++) if (this.at(xx, yy) === ROAD) return false;
      return true;
    };
    const p = new Plot(x, y, w, h, d.side, this.rng() < 0.5);
    const F = p.F;
    const D = p.D;
    // warehouse across the back, between the corner towers
    let back = D - 2;
    if (D >= 24) {
      const la = F - 8;
      const wr = p.rect(4, D - 8, la, 8);
      if (noRoad(wr)) {
        building(this, wr, GK_CONCRETE, [], true);
        const mid = this.even(la / 2);
        const pr = p.rect(4 + mid, D - 8, WALL, 8);
        this.fill(pr.x, pr.y, pr.w, pr.h, BRICK);
        for (const at of [2, la - 6]) { const dr = p.doorRect(0, 4, D - 8, la, 8, at); this.fill(dr.x, dr.y, dr.w, dr.h, EMPTY); }
        back = D - 8;
      }
    }
    // fuel tanks (steel) down one side, crate stacks (brick) down the other, clear of the lane and the target
    for (let b = 4; b + 4 <= back - 2; b += 6) {
      for (const [a, t] of [[2, STEEL], [F - 6, BRICK]]) {
        const r = p.rect(a, b, 4, 4);
        if (noRoad(r) && this.free(r.x, r.y, r.w, r.h, false)) this.fill(r.x, r.y, r.w, r.h, t);
      }
    }
    this.protect(x - 4, y - 4, w + 8, h + 8);
  }

  // ---------- town buildings ----------
  /** chance that a street lot is a terraced row instead of a single house */
  terraceChance = 0.15;
  /** ground kind of the green round the flag (GK_NONE = grass) */
  greenKind = GK_NONE;

  buildTown(t: TownPlan): void {
    const { tcx, tcy, S, ext, arms } = t;
    const rx0 = tcx - S / 2;
    const ry0 = tcy - S / 2;
    const rx1 = tcx + S / 2;
    const ry1 = tcy + S / 2;
    // the green: open ground with the flag; lime trees in the corners when there is room
    if (S >= 20) for (const [gx, gy] of [[rx0 + 5, ry0 + 5], [rx1 - 7, ry0 + 5], [rx0 + 5, ry1 - 7], [rx1 - 7, ry1 - 7]]) this.fill(gx, gy, 2, 2, TREES);
    if (this.greenKind) this.kind(rx0 + 4, ry0 + 4, S - 8, S - 8, this.greenKind);
    this.protect(rx0, ry0, S, S);
    const used = new Uint8Array(this.W * this.H);
    const streets: Street[] = [];
    // arms first (both sides), then the outer side of the ring
    if (arms[0]) streets.push({ horiz: false, x0: tcx - 2, y0: ry0 - 1, dir: -1, len: ext[0], sides: [-1, 1] });
    if (arms[2]) streets.push({ horiz: false, x0: tcx - 2, y0: ry1, dir: 1, len: ext[2], sides: [-1, 1] });
    if (arms[1]) streets.push({ horiz: true, x0: rx1, y0: tcy - 2, dir: 1, len: ext[1], sides: [-1, 1] });
    if (arms[3]) streets.push({ horiz: true, x0: rx0 - 1, y0: tcy - 2, dir: -1, len: ext[3], sides: [-1, 1] });
    streets.push({ horiz: true, x0: rx0 - 4, y0: ry0, dir: 1, len: S + 8, sides: [-1] });
    streets.push({ horiz: true, x0: rx0 - 4, y0: ry1 - 4, dir: 1, len: S + 8, sides: [1] });
    streets.push({ horiz: false, x0: rx0, y0: ry0 - 4, dir: 1, len: S + 8, sides: [-1] });
    streets.push({ horiz: false, x0: rx1 - 4, y0: ry0 - 4, dir: 1, len: S + 8, sides: [1] });
    const R = t.rect;
    // the built-up area actually used: ring, streets and lots
    const bb = { x0: rx0, y0: ry0, x1: rx1, y1: ry1 };
    const grow = (r: Rect) => {
      bb.x0 = Math.min(bb.x0, r.x);
      bb.y0 = Math.min(bb.y0, r.y);
      bb.x1 = Math.max(bb.x1, r.x + r.w);
      bb.y1 = Math.max(bb.y1, r.y + r.h);
    };
    let bigLeft = 1; // one church or hall per village, facing the green
    for (const st of streets) {
      if (st.sides.length === 2) grow(this.localRect(st, 1, 0, st.len, -4, 4));
      for (const side of st.sides) {
        let a = 0;
        let big = st.sides.length === 1 && bigLeft > 0 && this.rng() < 0.6;
        while (a <= st.len - 10) {
          const room = (st.len - a) & ~1;
          const F = Math.min(big ? 2 * this.ri(8, 9) : this.rng() < this.terraceChance ? 18 + 8 * this.ri(0, 1) : 2 * this.ri(5, 7), room);
          // as deep as the town has room for (12 cells = a house with no yard)
          let r: Rect | null = null;
          for (let D = 2 * this.ri(7, 9); D >= 12 && !r; D -= 2) r = this.lot(st, side, a, F, D, R, used, big);
          if (r) {
            grow(r);
            if (big) bigLeft--;
            big = false;
            a += F + (this.rng() < 0.35 ? 4 : 0);
          } else a += 2;
        }
      }
    }
    t.rect = { x: bb.x0 - 2, y: bb.y0 - 2, w: bb.x1 - bb.x0 + 4, h: bb.y1 - bb.y0 + 4 };
    this.protect(R.x - 2, R.y - 2, R.w + 4, R.h + 4);
  }

  /** Map a street-local cell (a along the street, b out from the road edge on `side`) to a world cell. */
  local(st: Street, side: number, a: number, b: number): [number, number] {
    const along = st.horiz ? st.x0 + st.dir * a : st.y0 + st.dir * a;
    if (st.horiz) return [along, side > 0 ? st.y0 + 4 + b : st.y0 - 1 - b];
    return [side > 0 ? st.x0 + 4 + b : st.x0 - 1 - b, along];
  }
  /** World rect covering street-local a0..a0+la, b0..b0+lb. */
  localRect(st: Street, side: number, a0: number, la: number, b0: number, lb: number): Rect {
    const p = this.local(st, side, a0, b0);
    const q = this.local(st, side, a0 + la - 1, b0 + lb - 1);
    return { x: Math.min(p[0], q[0]), y: Math.min(p[1], q[1]), w: Math.abs(p[0] - q[0]) + 1, h: Math.abs(p[1] - q[1]) + 1 };
  }

  /**
   * One plot on a street, on the even cell grid: a building set back 2 cells from the road with its door to the
   * street, and a hedged yard behind it. Returns the plot rect, or null if it doesn't fit.
   */
  lot(st: Street, side: number, a0: number, F: number, D: number, town: Rect, used: Uint8Array, big: boolean): Rect | null {
    if (F < 10) return null;
    let r = this.localRect(st, side, a0, F, 0, D);
    const ex = r.x + (r.x & 1);
    const ey = r.y + (r.y & 1);
    r = { x: ex, y: ey, w: (r.x + r.w - ex) & ~1, h: (r.y + r.h - ey) & ~1 };
    if (r.x < town.x || r.y < town.y || r.x + r.w > town.x + town.w || r.y + r.h > town.y + town.h) return null;
    for (let y = r.y - 1; y < r.y + r.h + 1; y++) {
      for (let x = r.x - 1; x < r.x + r.w + 1; x++) {
        // a road may run along a plot's side or back (buildings stand clear of the plot's edges), never through it
        const inR = x >= r.x && y >= r.y && x < r.x + r.w && y < r.y + r.h;
        const t = this.at(x, y);
        if (inR && (t !== EMPTY || used[y * this.W + x] || this.prot[y * this.W + x])) return null;
      }
    }
    for (let y = r.y; y < r.y + r.h; y++) for (let x = r.x; x < r.x + r.w; x++) used[y * this.W + x] = 1;
    const f = st.horiz ? (side > 0 ? 0 : 2) : side > 0 ? 3 : 1;
    this.plotHouse(new Plot(r.x, r.y, r.w, r.h, f, this.rng() < 0.5), big);
    return r;
  }

  /**
   * The building of a street plot and its yard. Single houses are cottages (one room, 8 or 10 cells wide) or
   * L-shaped farmhouses; wide plots hold a terraced row; the big plot on the green is the church (nave and steel
   * tower) or the village hall (steel corner posts, doors front and back).
   */
  plotHouse(p: Plot, big: boolean): void {
    const F = p.F;
    const D = p.D;
    const SB = 2;
    const cut = (r: Rect) => this.fill(r.x, r.y, r.w, r.h, EMPTY);
    let yb = SB + 8; // where the yard starts
    if (big && F >= 16 && this.rng() < 0.55) {
      // church: nave with the door in the middle of the long side, a steel bell tower on one end
      const la = Math.min(14, (F - 6) & ~1);
      const a0 = this.even((F - la - 4) / 2);
      building(this, p.rect(a0, SB, la, 8), GK_TILES, []);
      cut(p.doorRect(0, a0, SB, la, 8, 2 * Math.floor((la - DOOR) / 4)));
      const tw = p.rect(a0 + la, SB + 2, 4, 4);
      this.fill(tw.x, tw.y, tw.w, tw.h, STEEL);
      this.kind(tw.x, tw.y, tw.w, tw.h, GK_TILES);
    } else if (big) {
      // village hall / school / shop
      const la = Math.min(16, (F - 2) & ~1);
      const a0 = this.even((F - la) / 2);
      building(this, p.rect(a0, SB, la, 10), GK_TILES, [], true);
      cut(p.doorRect(0, a0, SB, la, 10, 2 * Math.floor((la - DOOR) / 4)));
      cut(p.doorRect(2, a0, SB, la, 10, 2));
      yb = SB + 10;
    } else if (F >= 18) {
      // terraced row: units 8 cells apart sharing party walls
      const n = Math.floor((F - WALL) / 8);
      const la = n * 8 + WALL;
      const a0 = this.even((F - la) / 2);
      terrace(this, p.rect(a0, SB, la, 8), p.side(0));
    } else if (F >= 14 && D >= 16 && this.rng() < 0.3) {
      // L-shaped farmhouse: the wing runs back into the yard
      const a0 = F >= 16 ? 2 * this.ri(1, (F - 14) >> 1) : this.even((F - 12) / 2);
      shape(this, [p.rect(a0, SB, 12, 8), p.rect(a0, SB + 4, 8, 8)], GK_PLANKS);
      cut(p.doorRect(0, a0, SB, 12, 8, this.rng() < 0.5 ? 2 : 6));
      yb = SB + 12;
    } else {
      const la = F >= 14 && this.rng() < 0.5 ? 10 : 8;
      const a0 = 2 * this.ri(1, Math.max(1, (F - la - 2) >> 1));
      building(this, p.rect(a0, SB, la, 8), GK_PLANKS, []);
      cut(p.doorRect(0, a0, SB, la, 8, la === 10 && this.rng() < 0.5 ? 4 : 2));
    }
    // yard: a hedge round the back and sides; a vegetable patch, a fruit tree or a shed in it
    if (D - yb < 4) return;
    const hedge = (r: Rect) => this.fill(r.x, r.y, r.w, r.h, TREES, EMPTY);
    const gap = 2 * this.ri(1, (F - 4) >> 1);
    hedge(p.rect(0, D - 1, gap, 1));
    hedge(p.rect(gap + 2, D - 1, F - gap - 2, 1));
    hedge(p.rect(0, yb, 1, D - 1 - yb));
    hedge(p.rect(F - 1, yb, 1, D - 1 - yb));
    const roll = this.rng();
    if (roll < 0.4) {
      const v = p.rect(2, yb + 1, F - 4, D - yb - 3);
      this.kind(v.x, v.y, v.w, v.h, GK_CROPS | (this.rng() < 0.5 ? GK_VERT : 0), true);
    } else if (roll < 0.65) {
      const tr = p.rect(2 + 2 * this.ri(0, (F - 6) >> 1), yb + 1, 2, 2);
      this.fill(tr.x, tr.y, tr.w, tr.h, TREES, EMPTY);
    } else if (roll < 0.85 && D - yb >= 6) {
      // shed: a small solid outbuilding in the back corner
      const sh = p.rect(F - 6, D - 6, 4, 4);
      if (this.free(sh.x, sh.y, sh.w, sh.h, false)) {
        this.fill(sh.x, sh.y, sh.w, sh.h, BRICK);
        this.kind(sh.x, sh.y, sh.w, sh.h, GK_PLANKS);
      }
    }
  }
  /** True if (x, y) is on this street's own road band (a lot may front onto it). */
  frontOf(st: Street, _side: number, x: number, y: number): boolean {
    if (st.horiz) return y >= st.y0 && y < st.y0 + 4;
    return x >= st.x0 && x < st.x0 + 4;
  }

  // ---------- fields ----------
  fieldDressing(): void {
    const { W, H } = this;
    // verges: keep 1 cell of open ground beside every road outside towns (trees may line it beyond)
    const nearRoad = new Uint8Array(W * H);
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        if (this.c[y * W + x] !== ROAD) continue;
        for (let j = -1; j <= 1; j++) for (let i = -1; i <= 1; i++) {
          const xx = x + i;
          const yy = y + j;
          if (xx >= 0 && yy >= 0 && xx < W && yy < H) nearRoad[yy * W + xx] = 1;
        }
      }
    }
    for (let i = 0; i < W * H; i++) if (nearRoad[i] && this.c[i] === EMPTY) this.prot[i] = 1;
    // pond (open water) with reeds/willows round part of it
    for (let tries = 0; tries < 80; tries++) {
      const rx = this.ri(5, 8);
      const ry = this.ri(4, 6);
      const px = this.ri(rx + 10, W - rx - 10);
      const py = this.ri(ry + 10, H - ry - 10);
      if (!this.free(px - rx - 5, py - ry - 5, 2 * rx + 11, 2 * ry + 11)) continue;
      for (let y = -ry - 2; y <= ry + 2; y++) {
        for (let x = -rx - 2; x <= rx + 2; x++) {
          const e = (x * x) / (rx * rx) + (y * y) / (ry * ry);
          if (e <= 1) this.set(px + x, py + y, WATER);
          else if (e <= 1.7 && Math.sin(Math.atan2(y, x) * 3 + px) > 0.2) this.plant(px + x, py + y);
        }
      }
      this.protect(px - rx - 3, py - ry - 3, 2 * rx + 7, 2 * ry + 7);
      break;
    }
    // orchards beside some villages: rows of fruit trees
    for (const t of this.towns) {
      if (this.rng() < 0.4) continue;
      for (let tries = 0; tries < 20; tries++) {
        const ow = 2 * this.ri(8, 11);
        const oh = 2 * this.ri(7, 10);
        const R = t.rect;
        const side = this.ri(0, 3);
        const ox = side === 1 ? R.x + R.w + 4 : side === 3 ? R.x - 4 - ow : this.even(R.x + this.ri(0, Math.max(0, R.w - ow)));
        const oy = side === 2 ? R.y + R.h + 4 : side === 0 ? R.y - 4 - oh : this.even(R.y + this.ri(0, Math.max(0, R.h - oh)));
        if (!this.free(ox - 1, oy - 1, ow + 2, oh + 2)) continue;
        for (let y = oy; y + 2 <= oy + oh; y += 5) for (let x = ox; x + 2 <= ox + ow; x += 5) {
          if (this.rng() < 0.9) { this.plant(x, y); this.plant(x + 1, y); this.plant(x, y + 1); this.plant(x + 1, y + 1); }
        }
        this.protect(ox, oy, ow, oh);
        break;
      }
    }
    // shelterbelts: tree lines along some long straight roads, 2 cells off the road
    this.roadsideTrees();
    this.farmsteads();
    this.ruinedBarns();
    // hedgerows: split the land into fields (recursive), tree lines on the splits with gaps for tracks
    this.fields({ x: 0, y: 0, w: W, h: H }, 0);
    // copses
    const ncop = Math.round((W * H) / (52 * 52 * 1.4));
    for (let k = 0; k < ncop; k++) {
      const cx = this.ri(8, W - 9);
      const cy = this.ri(8, H - 9);
      const r0 = this.ri(3, 6);
      const blobs: [number, number, number][] = [[cx, cy, r0]];
      for (let b = 0; b < 2; b++) blobs.push([cx + this.ri(-r0, r0), cy + this.ri(-r0, r0), this.ri(2, r0)]);
      for (const [bx, by, br] of blobs) {
        for (let y = -br; y <= br; y++) for (let x = -br; x <= br; x++) if (x * x + y * y <= br * br + 1) this.plant(bx + x, by + y);
      }
    }
    // willows along the river banks
    const U = this.horiz ? W : H;
    for (let u = 4; u < U - 4; u++) {
      if (this.rng() > 0.05) continue;
      const len = this.ri(4, 12);
      const top = this.rng() < 0.5;
      for (let k = 0; k < len && u + k < U; k++) {
        const v = top ? this.rTop[u + k] - 1 : this.rBot[u + k];
        const th = this.ri(1, 3);
        for (let j = 0; j < th; j++) {
          const vv = top ? v - j : v + j;
          if (this.horiz) this.plant(u + k, vv);
          else this.plant(vv, u + k);
        }
      }
      u += len;
    }
  }

  roadsideTrees(): void {
    // straight runs of lane nodes along x and y
    const { NX, NY } = this;
    const runs: [boolean, number, number, number][] = []; // horiz, fixed, from, to (nodes)
    for (let y = 0; y < NY; y++) {
      let s = -1;
      for (let x = 0; x <= NX; x++) {
        const on = x < NX && this.lane[this.node(x, y)] && this.links[this.node(x, y)] & 0b1010;
        if (on && s < 0) s = x;
        if (!on && s >= 0) { if (x - s >= 14) runs.push([true, y, s, x - 1]); s = -1; }
      }
    }
    for (let x = 0; x < NX; x++) {
      let s = -1;
      for (let y = 0; y <= NY; y++) {
        const on = y < NY && this.lane[this.node(x, y)] && this.links[this.node(x, y)] & 0b0101;
        if (on && s < 0) s = y;
        if (!on && s >= 0) { if (y - s >= 14) runs.push([false, x, s, y - 1]); s = -1; }
      }
    }
    for (const [horiz, fixed, from, to] of runs) {
      if (this.rng() < 0.5) continue;
      const sides = this.rng() < 0.3 ? [-1, 1] : [this.rng() < 0.5 ? -1 : 1];
      for (const side of sides) {
        let a = from * 2 + this.ri(0, 6);
        const end = to * 2 + 4;
        while (a < end) {
          const run = this.ri(8, 22);
          for (let k = a; k < Math.min(end, a + run); k++) {
            for (let j = 0; j < 2; j++) {
              const off = side > 0 ? fixed * 2 + 4 + 2 + j : fixed * 2 - 3 - j;
              if (horiz) this.plant(k, off);
              else this.plant(off, k);
            }
          }
          a += run + this.ri(4, 8);
        }
      }
    }
  }

  fields(r: Rect, depth: number): void {
    const big = r.w > 64 || r.h > 56;
    if (!big && (depth > 3 || r.w < 40 || r.h < 34 || this.rng() < 0.35)) { this.cropField(r); return; }
    const vertical = r.w / r.h > 1.15 ? true : r.h / r.w > 1.15 ? false : this.rng() < 0.5;
    if (vertical) {
      const x = this.even(r.x + r.w * (0.35 + this.rng() * 0.3));
      this.hedge(true, x, r.y, r.h);
      this.fields({ x: r.x, y: r.y, w: x - r.x, h: r.h }, depth + 1);
      this.fields({ x: x + 2, y: r.y, w: r.x + r.w - x - 2, h: r.h }, depth + 1);
    } else {
      const y = this.even(r.y + r.h * (0.35 + this.rng() * 0.3));
      this.hedge(false, y, r.x, r.w);
      this.fields({ x: r.x, y: r.y, w: r.w, h: y - r.y }, depth + 1);
      this.fields({ x: r.x, y: y + 2, w: r.w, h: r.y + r.h - y - 2 }, depth + 1);
    }
  }

  /** What grows in a hedged field: nothing (pasture), beet rows, wheat or sunflowers; rows run either way. */
  cropField(r: Rect): void {
    const roll = this.rng();
    const kind = roll < 0.3 ? GK_NONE : roll < 0.58 ? GK_CROPS : roll < 0.82 ? GK_WHEAT : GK_SUNFLOWER;
    const v = this.rng() < 0.5 ? GK_VERT : 0;
    if (kind) this.kind(r.x + 3, r.y + 3, r.w - 6, r.h - 6, kind | v, true);
  }

  /**
   * Farmsteads beside the roads between the villages: a yard 28 x 22 cells behind a brick front wall with a steel-
   * posted gate onto the road, hedged on the other three sides, with an L-shaped farmhouse and a barn (steel corner
   * posts, doors to the yard) round a cobbled yard.
   */
  farmsteads(): void {
    const want = Math.max(2, Math.round((this.W * this.H) / (52 * 52 * 5)));
    const cands: number[] = [];
    for (let n = 0; n < this.NX * this.NY; n++) {
      const l = this.links[n];
      if (this.lane[n] && (l === 0b0101 || l === 0b1010) && this.nodeAll(n, ROAD)) cands.push(n);
    }
    for (let i = cands.length - 1; i > 0; i--) {
      const j = this.ri(0, i);
      [cands[i], cands[j]] = [cands[j], cands[i]];
    }
    const made: Rect[] = [];
    const F = 28;
    const D = 22;
    for (const n of cands) {
      if (made.length >= want) break;
      const ns = this.links[n] === 0b0101; // the road runs north-south here
      const far = this.rng() < 0.5;
      const cx = this.nx(n) * 2;
      const cy = this.ny(n) * 2;
      const r: Rect = ns
        ? { x: far ? cx + 6 : cx - 2 - D, y: this.even(cy + 2 - F / 2), w: D, h: F }
        : { x: this.even(cx + 2 - F / 2), y: far ? cy + 6 : cy - 2 - D, w: F, h: D };
      if (!this.free(r.x, r.y, r.w, r.h)) continue;
      if (made.some((o) => Math.hypot(o.x - r.x, o.y - r.y) < 60)) continue;
      this.farmstead(new Plot(r.x, r.y, r.w, r.h, ns ? (far ? 3 : 1) : far ? 0 : 2, this.rng() < 0.5));
      this.protect(r.x - 2, r.y - 2, r.w + 4, r.h + 4);
      made.push(r);
    }
  }

  farmstead(p: Plot): void {
    const F = p.F;
    const D = p.D;
    const put = (r: Rect, t: number) => this.fill(r.x, r.y, r.w, r.h, t);
    const whole = p.rect(0, 0, F, D);
    this.kind(whole.x, whole.y, whole.w, whole.h, GK_YARD);
    // front wall with the gate, hedges round the rest
    const g0 = this.even(F / 2) - 2;
    put(p.rect(0, 0, g0 - 2, WALL), BRICK);
    put(p.rect(g0 + DOOR + 2, 0, F - g0 - DOOR - 2, WALL), BRICK);
    put(p.rect(g0 - 2, 0, 2, WALL), STEEL);
    put(p.rect(g0 + DOOR, 0, 2, WALL), STEEL);
    put(p.rect(0, WALL, 2, D - WALL), TREES);
    put(p.rect(F - 2, WALL, 2, D - WALL), TREES);
    put(p.rect(2, D - 2, F - 4, 2), TREES);
    // farmhouse: an L in the back corner, its door on the wing facing the yard
    shape(this, [p.rect(2, D - 10, 12, 8), p.rect(2, D - 14, 8, 8)], GK_PLANKS);
    put(p.doorRect(0, 2, D - 14, 8, 8, 2), EMPTY);
    // barn: down the other side, doors to the yard and to the front
    building(this, p.rect(F - 12, 6, 10, 12), GK_PLANKS, [], true);
    put(p.doorRect(3, F - 12, 6, 10, 12, 4), EMPTY);
    put(p.doorRect(0, F - 12, 6, 10, 12, 2), EMPTY);
    // a fruit tree by the gate
    put(p.rect(2, 2, 2, 2), TREES);
  }

  /** One or two barns standing alone in the fields, shelled: a corner gone and a wall breached, the plan still clear. */
  ruinedBarns(): void {
    const want = this.ri(1, 2);
    let made = 0;
    for (let tries = 0; tries < 200 && made < want; tries++) {
      const horizB = this.rng() < 0.5;
      const w = horizB ? 14 : 10;
      const h = horizB ? 10 : 14;
      const x = this.even(this.ri(12, this.W - 12 - w));
      const y = this.even(this.ri(12, this.H - 12 - h));
      if (!this.free(x - 4, y - 4, w + 8, h + 8)) continue;
      const r = { x, y, w, h };
      building(this, r, GK_PLANKS, [{ side: horizB ? 3 : 0, at: 2 }], true);
      const set = (xx: number, yy: number, t: number) => this.set(xx, yy, t);
      blowCorner(this, r, this.ri(0, 3), this.ri(5, 7), set);
      const s = this.ri(0, 3);
      breach(this, r, s, 2 + 2 * this.ri(0, 1), 4, set);
      this.protect(x - 2, y - 2, w + 4, h + 4);
      made++;
    }
  }

  /** Hedgerow along a field border: 2 cells thick (sometimes a 3-cell shelterbelt), broken by gaps. */
  hedge(vertical: boolean, at: number, from: number, len: number): void {
    const thick = this.rng() < 0.25 ? 3 : 2;
    let pos = from + this.ri(0, 6);
    while (pos < from + len) {
      const run = this.ri(10, 34);
      if (this.rng() < 0.85) {
        for (let k = pos; k < Math.min(from + len, pos + run); k++) {
          for (let j = 0; j < thick; j++) {
            if (vertical) this.plant(at + j, k);
            else this.plant(k, at + j);
          }
        }
      }
      pos += run + this.ri(4, 8);
    }
  }

  // ---------- spawns, garrisons, checks ----------
  finish(): RegionSpec | null {
    const { W, H } = this;
    const px = (n: number): [number, number] => [this.nx(n) * 8, this.ny(n) * 8];
    const e = this.entry;
    const playerSpawns: [number, number][] = [px(e[e.length - 2]), px(e[e.length - 5])];
    const pn = this.playerNode();
    // enemy spawns: road exits, depot yards and gates, then road nodes spread over the far parts of the map
    const sp: number[] = [];
    for (const ex of this.exits) sp.push(ex[1]);
    for (const d of this.depots) sp.push(d.yard, d.gate);
    const free = (n: number) => this.nodeAll(n, ROAD) || this.nodeAll(n, EMPTY);
    const inTown = (n: number) => this.towns.some((t) => {
      const x = this.nx(n) * 2;
      const y = this.ny(n) * 2;
      return x + 4 > t.rect.x - 8 && x < t.rect.x + t.rect.w + 8 && y + 4 > t.rect.y - 8 && y < t.rect.y + t.rect.h + 8;
    });
    const cand: number[] = [];
    for (let n = 0; n < this.NX * this.NY; n++) {
      if (!this.lane[n] || !this.nodeAll(n, ROAD) || inTown(n)) continue;
      if (Math.abs(this.nx(n) - this.nx(pn)) + Math.abs(this.ny(n) - this.ny(pn)) < 40) continue;
      cand.push(n);
    }
    const want = Math.max(8, Math.min(12, Math.round((W * H) / (52 * 52 * 2))));
    while (sp.length < want && cand.length) {
      let bi = -1;
      let bd = -1;
      for (let i = 0; i < cand.length; i++) {
        let d = 1e9;
        for (const s of sp) d = Math.min(d, Math.abs(this.nx(s) - this.nx(cand[i])) + Math.abs(this.ny(s) - this.ny(cand[i])));
        d = Math.min(d, (Math.abs(this.nx(pn) - this.nx(cand[i])) + Math.abs(this.ny(pn) - this.ny(cand[i]))) * 0.6);
        if (d > bd) { bd = d; bi = i; }
      }
      if (bd < 10) break;
      sp.push(cand[bi]);
      cand.splice(bi, 1);
    }
    const enemySpawns = sp.filter(free).map(px);

    const towns: Town[] = this.towns.map((t) => ({
      name: t.name,
      rect: [t.rect.x * 4, t.rect.y * 4, t.rect.w * 4, t.rect.h * 4],
      cx: t.tcx * 4,
      cy: t.tcy * 4,
      garrison: this.garrison(t),
    }));
    const depots: Depot[] = this.depots.map((d) => ({
      name: d.name,
      rect: [d.rect.x * 4, d.rect.y * 4, d.rect.w * 4, d.rect.h * 4],
      cx: (d.rect.x + d.rect.w / 2) * 4,
      cy: (d.rect.y + d.rect.h / 2) * 4,
    }));
    const spec: RegionSpec = {
      name: this.regionName, env: this.env, boss: this.boss, w: W, h: H, cells: this.c, kinds: this.k, playerSpawns, enemySpawns,
      enemies: Math.round((W * H) / (52 * 52)) * 2, maxActive: 5,
      towns, depots, roads: this.graph(),
      exits: this.exits.map((ex) => px(ex[0])),
      bridges: this.bridges.map((b) => px(b[b.length >> 1])),
    };
    this.extra(spec);
    // everything that matters must be reachable for a tracked tank: carve a way through if not
    const points = (): [number, number][] => [
      ...spec.playerSpawns, ...spec.enemySpawns,
      ...towns.flatMap((t) => [[t.cx - 8, t.cy - 8] as [number, number], ...t.garrison]),
      ...depots.map((d) => [d.cx - 8, d.cy - 8] as [number, number]),
    ];
    for (let round = 0; round < 6; round++) {
      const map = new GameMap(W, H);
      map.eagle = false;
      map.loadCells(this.c);
      const seen = floodNodes(map, spec.playerSpawns[0]);
      const bad = points().filter(([x, y]) => !seen[(y >> 3) * map.nodesX + (x >> 3)]);
      if (!bad.length) return spec;
      if ((globalThis as { REGION_DEBUG?: boolean }).REGION_DEBUG) console.log(`  carve round ${round}: ${bad.length} unreachable ${JSON.stringify(bad.slice(0, 6))}`);
      for (const b of bad) carve(spec, b);
    }
    return regionReach(spec).ok ? spec : null;
  }

  /**
   * 4-8 dug-in spots per town: a clear 16x16 patch (open ground, off the road) with a wall corner, house or tree
   * line between it and the approach (the side facing out of the village), spread round the town.
   */
  garrison(t: TownPlan): [number, number][] {
    const R = t.rect;
    const cover = (x0: number, y0: number, d: number) => {
      let k = 0;
      for (let i = 0; i < 4; i++) {
        const x = d === 1 ? x0 + 4 : d === 3 ? x0 - 1 : x0 + i;
        const y = d === 2 ? y0 + 4 : d === 0 ? y0 - 1 : y0 + i;
        const c = this.at(x, y);
        if (c === BRICK || c === TREES) k++;
      }
      return k;
    };
    type Cand = { n: number; s: number; dir: number };
    const cands: Cand[] = [];
    const nx0 = Math.max(1, (R.x - 6) >> 1);
    const ny0 = Math.max(1, (R.y - 6) >> 1);
    const nx1 = Math.min(this.NX - 2, (R.x + R.w + 4) >> 1);
    const ny1 = Math.min(this.NY - 2, (R.y + R.h + 4) >> 1);
    const rad = Math.hypot(R.w, R.h) / 2;
    for (let ny = ny0; ny <= ny1; ny++) {
      for (let nx = nx0; nx <= nx1; nx++) {
        const n = this.node(nx, ny);
        if (!this.nodeAll(n, EMPTY)) continue;
        const x0 = nx * 2;
        const y0 = ny * 2;
        const dx = x0 + 2 - t.tcx;
        const dy = y0 + 2 - t.tcy;
        const r = Math.hypot(dx, dy) / rad;
        if (r < 0.3) continue; // not on the green
        const d1 = Math.abs(dx) > Math.abs(dy) ? (dx > 0 ? 1 : 3) : dy > 0 ? 2 : 0;
        const d2 = Math.abs(dx) > Math.abs(dy) ? (dy > 0 ? 2 : 0) : dx > 0 ? 1 : 3;
        const k1 = cover(x0, y0, d1);
        const k2 = cover(x0, y0, d2);
        let sides = 0;
        for (let d = 0; d < 4; d++) if (cover(x0, y0, d) >= 3) sides++;
        const sc = (k: number) => (k >= 1 && k <= 3 ? 3 : k === 4 ? 2 : 0);
        if (sides >= 3) continue; // inside a house
        let s = Math.max(sc(k1), sc(k2) * 0.7);
        // fallback spots (only used to reach 4): cover on another side, else open ground near the middle
        if (s === 0) s = cover(x0, y0, (d1 + 2) & 3) + cover(x0, y0, (d2 + 2) & 3) > 0 ? -2 : -3;
        else if (r > 0.45 && r < 1.05) s += 1;
        cands.push({ n, s: s + this.rng() * 0.6, dir: k1 ? d1 : d2 });
      }
    }
    cands.sort((a, b) => b.s - a.s);
    const target = Math.max(4, Math.min(8, t.arms.filter(Boolean).length * 2));
    const out: number[] = [];
    const perDir = [0, 0, 0, 0];
    for (const pass of [0, 1, 2]) {
      for (const c of cands) {
        if (out.length >= (pass === 2 ? 4 : target)) break;
        if (out.includes(c.n)) continue;
        if (pass < 2 && c.s < 0) continue;
        if (pass === 0 && perDir[c.dir] >= Math.ceil(target / 3)) continue;
        if (out.some((o) => Math.max(Math.abs(this.nx(o) - this.nx(c.n)), Math.abs(this.ny(o) - this.ny(c.n))) < (pass ? 4 : 6))) continue;
        out.push(c.n);
        perDir[c.dir]++;
      }
    }
    return out.map((n) => [this.nx(n) * 8, this.ny(n) * 8] as [number, number]);
  }

  /** Road graph: key nodes at junctions, bends and dead ends; edges along the straight runs between them. */
  graph(): RoadGraph {
    const { NX, NY } = this;
    const key = (n: number) => {
      const l = this.links[n];
      const deg = (l & 1) + ((l >> 1) & 1) + ((l >> 2) & 1) + ((l >> 3) & 1);
      return deg !== 2 || (l !== 0b0101 && l !== 0b1010);
    };
    const id = new Map<number, number>();
    const nodes: [number, number][] = [];
    const nid = (n: number) => {
      let i = id.get(n);
      if (i === undefined) {
        i = nodes.length;
        id.set(n, i);
        nodes.push([this.nx(n), this.ny(n)]);
      }
      return i;
    };
    const seen = new Set<string>();
    const edges: [number, number][] = [];
    for (let n = 0; n < NX * NY; n++) {
      if (!this.lane[n] || !key(n)) continue;
      nid(n);
      for (let d = 0; d < 4; d++) {
        if (!(this.links[n] & (1 << d))) continue;
        let cur = this.node(this.nx(n) + NDX[d], this.ny(n) + NDY[d]);
        while (!key(cur)) cur = this.node(this.nx(cur) + NDX[d], this.ny(cur) + NDY[d]);
        const a = nid(n);
        const b = nid(cur);
        const k = a < b ? `${a},${b},${d & 1}` : `${b},${a},${d & 1}`;
        if (a === b || seen.has(k)) continue;
        seen.add(k);
        edges.push([a, b]);
      }
    }
    return { nodes, edges };
  }
}
