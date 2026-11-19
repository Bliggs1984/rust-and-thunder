// Region 2 "Rail junction": pine forest cut by a railway. The main line (RAIL cells, 4 cells = 16 px wide) crosses
// the map along its long axis in long gentle curves; halfway along, a junction yard of parallel sidings (a ladder of
// turnouts) lies beside the station town. Roads cross the line only at level crossings (the road wins the cells).
// The rest is dense forest with clearings, logging tracks, a sawmill village and forest hamlets.
import { BRICK, EMPTY, GK_CONCRETE, GK_NONE, GK_PAVING, GK_PLANKS, GK_TILES, GK_YARD, RAIL, ROAD, STEEL, TREES, WATER } from '../constants';
import { DOOR, Plot, WALL, building } from './build';
import type { RegionSpec } from '../region';
import { Farm, vnoise, type Rect, type TownPlan } from './gen';

const STATION_NAMES = ['VUZLOVA', 'ZALIZNYCHNE', 'SEMAFORNE', 'PEREHON', 'SHPALNE'];
const SAWMILL_NAMES = ['TARTAKIV', 'SMOLIARNE', 'TYRSOVE', 'PYLOROBY'];
const FOREST_NAMES = ['SOSNIVKA', 'BOROVYTSIA', 'YALYNOVE', 'HLUSHYNA', 'DUBROVA', 'KHVOINE', 'LISNYCHE', 'ZAHAI', 'MOKHOVE', 'ZHYVYTSIA'];

/** One track: centre line (v, in cells, float) for u in [u0, u1]; a siding leaves and rejoins track `parent`. */
interface Track { u0: number; u1: number; c: Float32Array; parent?: number }

/** Cells along the track a turnout takes to swing a siding out to its own line, and the easing at each end of it. */
const TURNOUT = 18;
const TURNOUT_EASE = 6;
/** How far across (0..1) a siding has swung x cells into its turnout: eased in, straight, eased out. The slope
 * never passes 1 / (TURNOUT - TURNOUT_EASE), so the turnout is one smooth S instead of two kinks. */
function swing(x: number): number {
  if (x <= 0) return 0;
  if (x >= TURNOUT) return 1;
  const e = TURNOUT_EASE;
  const m = 1 / (TURNOUT - e);
  if (x < e) return (m * x * x) / (2 * e);
  if (x > TURNOUT - e) return 1 - (m * (TURNOUT - x) * (TURNOUT - x)) / (2 * e);
  return m * (x - e / 2);
}

export class Rail extends Farm {
  override regionName = 'RAIL JUNCTION';
  override env = 'dusk' as const;
  override boss = 'train' as const;
  override townNames = FOREST_NAMES;
  override fordChance = 0;
  // railway towns are streets of workers' terraces; the station town's square is paved
  override terraceChance = 0.4;
  override buildTown(t: TownPlan): void {
    this.greenKind = t === this.towns[0] ? GK_PAVING : GK_NONE;
    super.buildTown(t);
  }
  tracks: Track[] = [];
  /** the main line's centre (v, cells) for every u in [0, U] */
  main = new Float32Array(0);
  /** junction yard: u range, the side the sidings (and the station) are on, v band of the whole yard */
  yu0 = 0;
  yu1 = 0;
  yside = 1;
  yTop = 0;
  yBot = 0;

  override barrier(t: number): boolean { return t === WATER || t === RAIL; }

  // ---------- the railway ----------
  override terrain(): void {
    const { W, H, rng } = this;
    this.horiz = W >= H;
    const U = this.horiz ? W : H;
    const V = this.horiz ? H : W;
    // the main line: two sines, scaled so the steepest stretch climbs at most 0.3 cells per cell
    let a1 = V * (0.07 + rng() * 0.05);
    let a2 = V * (0.015 + rng() * 0.015);
    const f1 = ((0.45 + rng() * 0.4) * Math.PI * 2) / U;
    const f2 = ((1.3 + rng() * 0.9) * Math.PI * 2) / U;
    const p1 = rng() * 6.28;
    const p2 = rng() * 6.28;
    const base = V * (0.42 + rng() * 0.16);
    let smax = 0;
    for (let u = 0; u <= U; u++) smax = Math.max(smax, Math.abs(a1 * f1 * Math.cos(u * f1 + p1) + a2 * f2 * Math.cos(u * f2 + p2)));
    if (smax > 0.3) { a1 *= 0.3 / smax; a2 *= 0.3 / smax; }
    const raw = (u: number) => base + a1 * Math.sin(u * f1 + p1) + a2 * Math.sin(u * f2 + p2);
    // the yard sits where the line runs flattest, in the middle part of the map
    const L = this.ri(70, 86);
    let best = Math.round(U * 0.4);
    let bs = 1e9;
    for (let u = Math.round(U * 0.28); u + L < Math.round(U * 0.74); u += 2) {
      const s = Math.abs(raw(u + L) - raw(u)) + Math.abs(raw(u + L / 2) - (raw(u) + raw(u + L)) / 2) * 2 + this.rng() * 2;
      if (s < bs) { bs = s; best = u; }
    }
    this.yu0 = best;
    this.yu1 = best + L;
    const vy = Math.round(raw(best + L / 2));
    // flatten the line through the yard (level and on whole cells), easing in and out over 50 cells
    const ease = 50;
    const main = new Float32Array(U + 1);
    for (let u = 0; u <= U; u++) {
      const d = u < this.yu0 ? this.yu0 - u : u > this.yu1 ? u - this.yu1 : 0;
      const t = Math.min(1, d / ease);
      const w = 1 - t * t * (3 - 2 * t);
      main[u] = raw(u) * (1 - w) + vy * w;
    }
    this.main = main;
    this.tracks.push({ u0: 0, u1: U, c: main });
    // sidings: a ladder of 1-2 on the roomier side, sometimes one on the other; each leaves the track inside it
    // through a turnout (6 cells across over TURNOUT along, eased at both ends) and rejoins it the same way
    this.yside = vy < V / 2 ? 1 : -1;
    const R = 12;
    const ladder = this.ri(2, 3);
    const siding = (side: number, k: number, from: number, to: number) => {
      const c = new Float32Array(U + 1).fill(NaN);
      const parent = k > 1 ? this.tracks.length - 1 : 0;
      const pc = this.tracks[parent].c;
      for (let u = from; u <= to; u++) c[u] = pc[u] + side * 6 * swing(Math.min(u - from, to - u));
      this.tracks.push({ u0: from, u1: to, c, parent });
    };
    for (let k = 1; k <= ladder; k++) {
      const from = this.yu0 + (k - 1) * R + this.ri(0, 4);
      const to = this.yu1 - (k - 1) * R - this.ri(0, 4);
      if (to - from < 2 * TURNOUT + 10) break;
      siding(this.yside, k, from, to);
    }
    if (this.rng() < 0.6) siding(-this.yside, 1, this.yu0 + this.ri(4, 14), this.yu1 - this.ri(4, 14));
    // raster: cells whose centre is within 2 cells (measured square to the track) of a centre line
    this.rTop = new Int32Array(U).fill(1 << 20);
    this.rBot = new Int32Array(U).fill(-(1 << 20));
    for (const t of this.tracks) {
      for (let u = Math.max(0, t.u0); u < Math.min(U, t.u1 + 1); u++) {
        const cu = Number.isNaN(t.c[u + 1]) ? t.c[u] : (t.c[u] + t.c[u + 1]) / 2;
        if (Number.isNaN(cu)) continue;
        const slope = Number.isNaN(t.c[u + 1]) ? 0 : t.c[u + 1] - t.c[u];
        const half = 2 * Math.sqrt(1 + slope * slope);
        for (let v = Math.floor(cu - half - 1); v <= Math.ceil(cu + half + 1); v++) {
          if (Math.abs(v + 0.5 - cu) > half) continue;
          if (this.horiz) this.set(u, v, RAIL);
          else this.set(v, u, RAIL);
          this.rTop[u] = Math.min(this.rTop[u], v);
          this.rBot[u] = Math.max(this.rBot[u], v + 1);
        }
      }
    }
    let top = 1e9;
    let bot = -1e9;
    for (let u = this.yu0; u <= this.yu1; u++) { top = Math.min(top, this.rTop[u]); bot = Math.max(bot, this.rBot[u]); }
    this.yTop = top;
    this.yBot = bot;
    // the station town stands beside the yard, on the siding side
    this.townPrefer = (t: TownPlan) => {
      const u = this.horiz ? t.tcx : t.tcy;
      if (u < this.yu0 + 6 || u > this.yu1 - 6) return false;
      const lo = this.horiz ? t.rect.y : t.rect.x;
      const hi = lo + (this.horiz ? t.rect.h : t.rect.w);
      const gap = this.yside > 0 ? lo - this.yBot : this.yTop - hi;
      return gap >= 6 && gap <= 24;
    };
  }

  /** 3-4 level crossings spread along the line, clear of the yard and its turnouts. */
  override placeBridges(): boolean {
    const U = this.horiz ? this.W : this.H;
    const NU = (U >> 1) - 1;
    const nb = this.ri(3, 4);
    const seg = NU / nb;
    const lo = (this.yu0 - 16) >> 1;
    const hi = (this.yu1 + 14) >> 1;
    const used: number[] = [];
    for (let k = 0; k < nb; k++) {
      let un = Math.max(8, Math.min(NU - 9, Math.round(seg * k + seg * (0.3 + this.rng() * 0.4))));
      if (un >= lo && un <= hi) un = un - lo < hi - un ? lo - 1 : hi + 1;
      if (un < 8 || un > NU - 9 || used.some((b) => Math.abs(b - un) < 12)) continue;
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
      const [x0, y0] = this.horiz ? [un * 2 - 6, va * 2 - 4] : [va * 2 - 4, un * 2 - 6];
      const [w, h] = this.horiz ? [16, (vb - va) * 2 + 12] : [(vb - va) * 2 + 12, 16];
      this.protect(x0, y0, w, h);
    }
    return this.bridges.length >= 2;
  }

  override placeTowns(): boolean {
    if (!super.placeTowns()) return false;
    const pick = (list: string[]) => list[this.ri(0, list.length - 1)];
    this.towns[0].name = pick(STATION_NAMES);
    if (this.towns.length > 1) this.towns[1 + this.ri(0, this.towns.length - 2)].name = pick(SAWMILL_NAMES);
    return true;
  }
  override townCount(fit: number): number { return Math.min(4, fit); }
  override minTowns(fit: number): number { return Math.min(3, fit); }

  // ---------- dressing ----------
  override dress(): void {
    const { W, H } = this;
    this.protectNear(ROAD, 1);
    this.protectNear(RAIL, 2);
    this.yardDressing();
    this.sawmill();
    this.loggingTracks();
    // the forest: dense pines wherever the noise is high, open clearings and meadows where it is low, fields
    // round the villages
    const seed = (this.rng() * 1e9) | 0;
    const near = new Uint8Array(W * H);
    for (const t of this.towns) {
      const m = 5;
      for (let y = Math.max(0, t.rect.y - m); y < Math.min(H, t.rect.y + t.rect.h + m); y++) {
        for (let x = Math.max(0, t.rect.x - m); x < Math.min(W, t.rect.x + t.rect.w + m); x++) near[y * W + x] = 1;
      }
    }
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        const i = y * W + x;
        if (near[i] || this.c[i] !== EMPTY || this.prot[i]) continue;
        const n = vnoise(x / 26, y / 26, seed) * 0.62 + vnoise(x / 8, y / 8, seed + 7) * 0.28 + vnoise(x / 3, y / 3, seed + 3) * 0.1;
        if (n > 0.43) this.c[i] = TREES;
      }
    }
    // lone trees in the clearings
    for (let k = 0; k < (W * H) / 900; k++) {
      const x = this.ri(4, W - 6);
      const y = this.ri(4, H - 6);
      if (this.free(x - 1, y - 1, 4, 4)) this.fill(x, y, 2, 2, TREES);
    }
  }

  /**
   * The station beside the yard: a paved platform along the outer siding, the station hall behind it (steel corner
   * posts, tiled floor, two doors to the platform and one to the town), a steel water tower at one end, a goods shed
   * across the tracks, and wagons left standing on the sidings.
   */
  yardDressing(): void {
    const s = this.yside;
    const outer = s > 0 ? this.yBot : this.yTop; // yard edge on the station side
    // world side a building's wall faces when it looks across the tracks from side `k` of the yard
    const facing = (k: number, toTracks: boolean): number => {
      const down = k > 0 !== toTracks; // true = the wall faces +v
      return this.horiz ? (down ? 2 : 0) : down ? 1 : 3;
    };
    // platform: 4 cells of paving along the yard (kept clear), then the station hall
    const pu0 = this.even(this.yu0 + 14);
    const pu1 = this.even(this.yu1 - 14);
    const pe = s > 0 ? outer + (outer & 1) : outer - (outer & 1); // the platform's inner edge, on the even grid
    const pv = s > 0 ? pe : pe - 4;
    this.protectUV(pu0, pv, pu1 - pu0, 4);
    const bl = Math.min(28, (pu1 - pu0 - 8) & ~1);
    const bu = this.even(pu0 + (pu1 - pu0 - bl) / 2);
    const bv = s > 0 ? pe + 4 : pe - 4 - 8;
    const pave = this.rectUV(pu0, s > 0 ? pe : pe - 14, pu1 - pu0, 14);
    this.kindFree(pave.x, pave.y, pave.w, pave.h, GK_PAVING);
    if (bl >= 16 && this.freeUV(bu, bv, bl, 8)) {
      const r = this.rectUV(bu, bv, bl, 8);
      building(this, r, GK_TILES, [
        { side: facing(s, true), at: 4 }, { side: facing(s, true), at: bl - 8 }, { side: facing(s, false), at: this.even(bl / 2) - 2 },
      ], true);
      this.protect(r.x - 2, r.y - 2, r.w + 4, r.h + 4);
    }
    // water tower (steel) at one end of the platform
    const tu = this.even(this.yu0 + this.ri(2, 6));
    const tv = s > 0 ? pe + 4 : pe - 8;
    if (this.freeUV(tu, tv, 4, 4)) this.fillUV(tu, tv, 4, 4, STEEL);
    // goods shed across the tracks: concrete floor, a door to the tracks and one to the forest side
    const far = s > 0 ? this.yTop : this.yBot;
    const fe = s > 0 ? far - (far & 1) : far + (far & 1);
    const gu = this.even(this.yu0 + (this.yu1 - this.yu0) * (0.3 + this.rng() * 0.3));
    const gv = s > 0 ? fe - 4 - 8 : fe + 4;
    if (this.freeUV(gu - 2, gv - 2, 20, 12)) {
      const r = this.rectUV(gu, gv, 16, 8);
      building(this, r, GK_CONCRETE, [{ side: facing(-s, true), at: 6 }, { side: facing(-s, false), at: 2 }], true);
      const apron = this.rectUV(gu - 2, s > 0 ? gv + 8 : gv - 4, 20, 4);
      this.kindFree(apron.x, apron.y, apron.w, apron.h, GK_CONCRETE);
      this.protectUV(gu - 2, gv - 2, 20, 12);
    }
    // wagons (steel boxes) left standing on the outer sidings
    for (const t of this.tracks.slice(1)) {
      if (this.rng() < 0.35) continue;
      const len = 8 + 2 * this.ri(0, 1);
      const u = this.even(t.u0 + TURNOUT + 2 + this.rng() * Math.max(0, t.u1 - t.u0 - 2 * TURNOUT - 4 - len));
      const c = t.c[u + (len >> 1)];
      if (Number.isNaN(c)) continue;
      for (let k = 0; k < this.ri(1, 2); k++) {
        const uu = u + k * (len + 2);
        if (uu + len > t.u1 - TURNOUT) break;
        const v0 = Math.round(c - 1.5);
        for (let a = uu; a < uu + len; a++) for (let b = v0; b < v0 + 3; b++) if (this.atUV(a, b) === RAIL) this.setUV(a, b, STEEL);
      }
    }
  }

  /**
   * The sawmill beside its village: a yard behind a brick front wall with a steel-posted gate facing the village,
   * pines round the other sides, the saw hall (steel posts, wide doors) and a long drying shed inside.
   */
  sawmill(): void {
    const t = this.towns.find((tt) => SAWMILL_NAMES.includes(tt.name));
    if (!t) return;
    const R = t.rect;
    const F = 28;
    const D = 22;
    for (let tries = 0; tries < 40; tries++) {
      const side = this.ri(0, 3);
      const w = side === 1 || side === 3 ? D : F;
      const h = side === 1 || side === 3 ? F : D;
      const x = this.even(side === 1 ? R.x + R.w + 2 : side === 3 ? R.x - 2 - w : R.x + this.ri(0, Math.max(0, R.w - w)));
      const y = this.even(side === 2 ? R.y + R.h + 2 : side === 0 ? R.y - 2 - h : R.y + this.ri(0, Math.max(0, R.h - h)));
      if (!this.free(x, y, w, h)) continue;
      // the front faces the village
      const p = new Plot(x, y, w, h, side === 1 ? 3 : side === 3 ? 1 : side === 2 ? 0 : 2, this.rng() < 0.5);
      const put = (r: Rect, c: number) => this.fill(r.x, r.y, r.w, r.h, c);
      this.kind(x, y, w, h, GK_YARD);
      const g0 = this.even(F / 2) - 2;
      put(p.rect(0, 0, g0 - 2, WALL), BRICK);
      put(p.rect(g0 + DOOR + 2, 0, F - g0 - DOOR - 2, WALL), BRICK);
      put(p.rect(g0 - 2, 0, 2, WALL), STEEL);
      put(p.rect(g0 + DOOR, 0, 2, WALL), STEEL);
      put(p.rect(0, WALL, 2, D - WALL), TREES);
      put(p.rect(F - 2, WALL, 2, D - WALL), TREES);
      put(p.rect(2, D - 2, F - 4, 2), TREES);
      // saw hall
      building(this, p.rect(F - 14, 6, 12, 12), GK_PLANKS, [], true);
      put(p.doorRect(3, F - 14, 6, 12, 12, 4), EMPTY);
      put(p.doorRect(0, F - 14, 6, 12, 12, 4), EMPTY);
      // drying shed along the back
      building(this, p.rect(2, D - 10, 10, 8), GK_PLANKS, []);
      put(p.doorRect(0, 2, D - 10, 10, 8, 2), EMPTY);
      this.protect(x - 2, y - 2, w + 4, h + 4);
      break;
    }
  }

  /** Logging tracks: tank-wide rides leaving the roads into the forest, with the odd bend. */
  loggingTracks(): void {
    const { NX, NY } = this;
    const want = Math.round((this.W * this.H) / 6000);
    const roadNodes: number[] = [];
    for (let n = 0; n < NX * NY; n++) if (this.lane[n] && this.nodeAll(n, ROAD)) roadNodes.push(n);
    let made = 0;
    for (let tries = 0; tries < want * 8 && made < want && roadNodes.length; tries++) {
      const start = roadNodes[this.ri(0, roadNodes.length - 1)];
      const l = this.links[start];
      // leave square to the road
      const along = l & 0b0101 ? 0 : 1;
      let d = along === 0 ? (this.rng() < 0.5 ? 1 : 3) : this.rng() < 0.5 ? 0 : 2;
      let x = this.nx(start);
      let y = this.ny(start);
      const path: number[] = [];
      const len = this.ri(14, 34);
      for (let k = 0; k < len; k++) {
        x += [0, 1, 0, -1][d] * 1;
        y += [-1, 0, 1, 0][d] * 1;
        if (x < 2 || y < 2 || x >= NX - 2 || y >= NY - 2) break;
        const n = this.node(x, y);
        if (k > 1 && (this.lane[n] || this.blocked[n] || !this.nodeAll(n, EMPTY))) break;
        if (this.nodeBarrier(n) || this.nodeHas(n, BRICK) || this.nodeHas(n, STEEL)) break;
        path.push(n);
        if (k > 6 && this.rng() < 0.07) d = (d + (this.rng() < 0.5 ? 1 : 3)) & 3;
      }
      if (path.length < 10) continue;
      for (const n of path) this.protect(this.nx(n) * 2, this.ny(n) * 2, 4, 4);
      made++;
    }
  }

  override extra(spec: RegionSpec): void {
    const U = this.horiz ? this.W : this.H;
    const pts: [number, number][] = [];
    for (let u = 0; u <= U; u += 4) {
      const uu = Math.min(u, U);
      const v = this.main[uu] * 4;
      pts.push(this.horiz ? [uu * 4, Math.round(v * 10) / 10] : [Math.round(v * 10) / 10, uu * 4]);
      if (u < U && u + 4 > U) u = U - 4;
    }
    spec.rail = pts;
    // every track's exact centre line for the renderer. A siding's sleepers start in step with its parent's where
    // it leaves, and its spacing is stretched a hair (under 1%) so they are in step again where it rejoins.
    const arcs: Float32Array[] = [];
    spec.tracks = this.tracks.map((t) => {
      const line: [number, number][] = [];
      const arc = new Float32Array(U + 1);
      let len = 0;
      for (let u = t.u0; u <= t.u1; u++) {
        if (u > t.u0) len += 4 * Math.hypot(1, t.c[u] - t.c[u - 1]);
        arc[u] = len;
        line.push(this.horiz ? [u * 4, t.c[u] * 4] : [t.c[u] * 4, u * 4]);
      }
      let s0 = 0;
      let sk = 1;
      if (t.parent !== undefined && len > 0) {
        const pa = arcs[t.parent];
        const want = pa[t.u1] - pa[t.u0]; // the parent's sleeper count over the same stretch, kept in phase
        sk = (len + ((((want - len + 2) % 4) + 4) % 4) - 2) / len;
        s0 = pa[t.u0];
      }
      for (let u = t.u0; u <= t.u1; u++) arc[u] = s0 + sk * arc[u];
      arcs.push(arc);
      return { pts: line, s0, sk };
    });
  }
}
