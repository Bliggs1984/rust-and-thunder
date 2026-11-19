// Region 3 "River delta": a wide river runs the length of the map and splits into channels round islands on its way
// to the far edge: one branch leaves the main channel and reaches the map edge on its own (cutting off a tongue of
// land), another splits off and rejoins it (an island). Marsh pools (open water tanks can't cross, hover can) with
// reed beds, reeds along the banks, 3-5 road bridges and a ford or two, fishing villages on the banks and islands.
// `river` = the main channel's centre line, edge to edge, at least 48 px of open water across.
import { EMPTY, GK_PLANKS, GK_YARD, ROAD, TREES, WATER } from '../constants';
import { building } from './build';
import type { RegionSpec } from '../region';
import { Farm, vnoise, type TownPlan } from './gen';

const VILLAGE_NAMES = [
  'RYBATSKE', 'OCHERETIANE', 'PLAVNI', 'KOSA', 'ZATOKA', 'VERBOVYI OSTRIV', 'LYMANSKE', 'CHAPLYNE', 'SOMOVE', 'KARASIVKA',
  'KACHKAROVE', 'PRYSTAN', 'BILYI PISOK', 'HIRLO', 'KAMYSHI',
];

/** One channel: centre (v, cells) and width (cells) for u in [u0, u1]; NaN outside. */
interface Channel { u0: number; u1: number; c: Float32Array; w: Float32Array; main: boolean }

export class Delta extends Farm {
  override regionName = 'RIVER DELTA';
  override env = 'rain' as const;
  override boss = 'flagship' as const;
  override townNames = VILLAGE_NAMES;
  override depotKinds = ['FUEL DUMP', 'AMMO DUMP', 'BOAT YARD'];
  override townWaterPad = 3;
  override depotWaterPad = 4;
  // fishing villages: single cottages round a cobbled square
  override terraceChance = 0.08;
  override greenKind = GK_YARD;
  channels: Channel[] = [];
  /** land component of every cell (-1 = water), before the fords */
  label = new Int32Array(0);
  /** labels of the two outer banks (the land the player may start on) */
  banks: number[] = [];

  // ---------- water ----------
  override terrain(): void {
    const { W, H, rng } = this;
    this.horiz = W >= H;
    const U = this.horiz ? W : H;
    const V = this.horiz ? H : W;
    // main channel: gentle curves, 13-16 cells wide
    let a1 = V * (0.03 + rng() * 0.025);
    let a2 = V * (0.01 + rng() * 0.012);
    const f1 = ((0.5 + rng() * 0.5) * Math.PI * 2) / U;
    const f2 = ((1.5 + rng() * 1.2) * Math.PI * 2) / U;
    const fw = ((1.2 + rng()) * Math.PI * 2) / U;
    const p1 = rng() * 6.28;
    const p2 = rng() * 6.28;
    const pw = rng() * 6.28;
    let smax = 0;
    for (let u = 0; u <= U; u++) smax = Math.max(smax, Math.abs(a1 * f1 * Math.cos(u * f1 + p1) + a2 * f2 * Math.cos(u * f2 + p2)));
    if (smax > 0.35) { a1 *= 0.35 / smax; a2 *= 0.35 / smax; }
    const base = V * (0.46 + rng() * 0.08);
    const cm = new Float32Array(U + 1);
    const wm = new Float32Array(U + 1);
    let cmin = 1e9;
    let cmax = -1e9;
    for (let u = 0; u <= U; u++) {
      cm[u] = base + a1 * Math.sin(u * f1 + p1) + a2 * Math.sin(u * f2 + p2);
      wm[u] = 14.5 + 1.5 * Math.sin(u * fw + pw);
      cmin = Math.min(cmin, cm[u]);
      cmax = Math.max(cmax, cm[u]);
    }
    this.channels.push({ u0: 0, u1: U, c: cm, w: wm, main: true });
    // branches: one to the far edge, one that rejoins (an island); on opposite sides of the main channel
    const sideA = rng() < 0.5 ? -1 : 1;
    const smooth = (t: number) => { const x = Math.max(0, Math.min(1, t)); return x * x * (3 - 2 * x); };
    const branch = (side: number, us: number, ue: number, rejoin: boolean) => {
      const room = side < 0 ? cmin - 14 : V - 14 - cmax;
      const D = Math.min(this.ri(70, 80), room);
      if (D < 40) return;
      const Lr = this.ri(46, 60);
      const wb = 7 + rng() * 2;
      const fq = ((3 + rng() * 2) * Math.PI * 2) / U;
      const ph = rng() * 6.28;
      const c = new Float32Array(U + 1).fill(NaN);
      const w = new Float32Array(U + 1).fill(NaN);
      for (let u = us; u <= ue; u++) {
        let e = smooth((u - us) / Lr);
        if (rejoin) e = Math.min(e, smooth((ue - u) / Lr));
        c[u] = cm[u] + side * (D * e + 3 * Math.sin(u * fq + ph) * e);
        w[u] = wb + Math.sin(u * fq * 1.7 + ph) * 1.2;
      }
      this.channels.push({ u0: us, u1: ue, c, w, main: false });
    };
    const usA = Math.round(U * (0.14 + rng() * 0.16));
    branch(sideA, usA, U, false);
    const usB = Math.round(U * (0.1 + rng() * 0.14));
    const ueB = Math.min(U - 16, usB + Math.round(U * (0.5 + rng() * 0.2)));
    branch(-sideA, usB, ueB, true);
    // raster: square to each centre line
    for (const ch of this.channels) {
      for (let u = Math.max(0, ch.u0); u < Math.min(U, ch.u1 + 1); u++) {
        const c0 = ch.c[u];
        if (Number.isNaN(c0)) continue;
        const c1 = Number.isNaN(ch.c[u + 1]) ? c0 : ch.c[u + 1];
        const cu = (c0 + c1) / 2;
        const half = (ch.w[u] / 2) * Math.sqrt(1 + (c1 - c0) * (c1 - c0));
        for (let v = Math.floor(cu - half - 1); v <= Math.ceil(cu + half + 1); v++) {
          if (Math.abs(v + 0.5 - cu) > half) continue;
          if (this.horiz) this.set(u, v, WATER);
          else this.set(v, u, WATER);
        }
      }
    }
    this.labelLand();
    const [x0, y0] = this.horiz ? [2, 2] : [2, 2];
    const [x1, y1] = this.horiz ? [2, H - 3] : [W - 3, 2];
    this.banks = [this.label[y0 * W + x0], this.label[y1 * W + x1]];
    // at least one village on an island (or the tongue of land between the branches)
    this.townPrefer = (t: TownPlan) => {
      const l = this.label[t.tcy * W + t.tcx];
      return l >= 0 && !this.banks.includes(l);
    };
  }

  /** Flood-fill land components (4-connected, non-water cells). */
  labelLand(): void {
    const { W, H } = this;
    const lab = new Int32Array(W * H).fill(-2);
    let next = 0;
    const stack: number[] = [];
    for (let i = 0; i < W * H; i++) {
      if (this.c[i] === WATER) { lab[i] = -1; continue; }
      if (lab[i] !== -2) continue;
      lab[i] = next;
      stack.push(i);
      while (stack.length) {
        const j = stack.pop()!;
        const x = j % W;
        const y = (j / W) | 0;
        for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
          const xx = x + dx;
          const yy = y + dy;
          if (xx < 0 || yy < 0 || xx >= W || yy >= H) continue;
          const k = yy * W + xx;
          if (lab[k] !== -2 || this.c[k] === WATER) continue;
          lab[k] = next;
          stack.push(k);
        }
      }
      next++;
    }
    this.label = lab;
  }

  /** Which piece of land a node is on (-1 = in or right beside water). */
  override riverSide(n: number): number {
    const x0 = this.nx(n) * 2;
    const y0 = this.ny(n) * 2;
    for (let y = y0 - 2; y < y0 + 6; y++) for (let x = x0 - 2; x < x0 + 6; x++) if (this.at(x, y) === WATER) return -1;
    return this.label[y0 * this.W + x0];
  }

  /** Cells (v range) of channel ch's water at node column un; null where it doesn't run. */
  span(ch: Channel, un: number): [number, number] | null {
    let top = 1e9;
    let bot = -1e9;
    for (let u = un * 2; u < un * 2 + 4; u++) {
      const c = ch.c[u];
      if (Number.isNaN(c)) return null;
      const half = ch.w[u] / 2 + 1;
      top = Math.min(top, Math.floor(c - half));
      bot = Math.max(bot, Math.ceil(c + half));
    }
    return [top, bot];
  }

  /** 2 bridges over the main channel, one over each branch where it runs on its own, plus 1-2 fords on branches. */
  override placeBridges(): boolean {
    const U = this.horiz ? this.W : this.H;
    const NU = (U >> 1) - 1;
    const cellUV = (u: number, v: number) => (this.horiz ? this.at(u, v) : this.at(v, u));
    const labUV = (u: number, v: number) => {
      const [x, y] = this.horiz ? [u, v] : [v, u];
      return x < 0 || y < 0 || x >= this.W || y >= this.H ? -1 : this.label[y * this.W + x];
    };
    const used: number[] = [];
    const tryCross = (ch: Channel, un: number): number[] | null => {
      const sp = this.span(ch, un);
      if (!sp) return null;
      const va = Math.floor((sp[0] - 4) / 2) - 1;
      const vb = Math.ceil(sp[1] / 2) + 1;
      if (va < 3 || vb * 2 + 4 > (this.horiz ? this.H : this.W) - 3) return null;
      // only this channel's water under the lane, dry land at both ends, different land on the two sides
      for (let v = va * 2; v < vb * 2 + 4; v++) {
        for (let u = un * 2; u < un * 2 + 4; u++) {
          const wet = cellUV(u, v) === WATER;
          const inside = v >= sp[0] && v < sp[1];
          if (wet && !inside) return null;
          if (!wet && v >= sp[0] + 2 && v < sp[1] - 2) return null; // an islet in the way
        }
      }
      const la = labUV(un * 2 + 1, va * 2 - 1);
      const lb = labUV(un * 2 + 1, vb * 2 + 4);
      if (la < 0 || lb < 0 || la === lb) return null;
      const path: number[] = [];
      for (let vn = va; vn <= vb; vn++) path.push(this.uvNode(un, vn));
      if (path.some((n) => this.lane[n])) return null;
      return path;
    };
    const lay = (path: number[], un: number) => {
      const s = this.newSite('bridge', path[path.length >> 1]);
      this.siteSide[s] = -1;
      this.layPath(path, s);
      this.bridges.push(path);
      used.push(un);
      const va = this.horiz ? this.ny(path[0]) : this.nx(path[0]);
      const vb = this.horiz ? this.ny(path[path.length - 1]) : this.nx(path[path.length - 1]);
      const [x0, y0] = this.horiz ? [un * 2 - 6, va * 2 - 4] : [va * 2 - 4, un * 2 - 6];
      const [w, h] = this.horiz ? [16, (vb - va) * 2 + 12] : [(vb - va) * 2 + 12, 16];
      this.protect(x0, y0, w, h);
    };
    for (const ch of this.channels) {
      const want = ch.main ? 2 : 1;
      const lo = Math.max(8, (ch.u0 >> 1) + (ch.main ? 0 : 32));
      const hi = Math.min(NU - 9, (ch.u1 >> 1) - (ch.main || ch.u1 >= U - 2 ? 0 : 32));
      if (hi <= lo) continue;
      for (let k = 0; k < want; k++) {
        // spread along the channel, away from the other crossings
        let best: number[] | null = null;
        let bu = 0;
        let bs = -1;
        for (let tries = 0; tries < 40; tries++) {
          const un = this.ri(lo, hi);
          const path = tryCross(ch, un);
          if (!path) continue;
          let s = Math.min(60, ...used.map((b) => Math.abs(b - un)), 60) + this.rng() * 8;
          if (ch.main) s += Math.min(un - lo, hi - un) * 0.2;
          if (s > bs) { bs = s; best = path; bu = un; }
        }
        if (best && bs > 14) lay(best, bu);
      }
    }
    // fords on the branches: a gravel bar a tank can drive over, away from the bridges
    for (const ch of this.channels) {
      if (ch.main || this.rng() < 0.3) continue;
      for (let tries = 0; tries < 30; tries++) {
        const un = this.ri((ch.u0 >> 1) + 30, Math.min(NU - 8, (ch.u1 >> 1) - 10));
        if (used.some((b) => Math.abs(b - un) < 14) || !this.span(ch, un)) continue;
        const sp = this.span(ch, un)!;
        for (let u = un * 2 - 1; u < un * 2 + 5; u++) {
          const inner = u >= un * 2 && u < un * 2 + 4;
          if (!inner && this.rng() < 0.5) continue;
          for (let v = sp[0] - 1; v <= sp[1]; v++) {
            if (cellUV(u, v) !== WATER) continue;
            if (this.horiz) this.set(u, v, EMPTY);
            else this.set(v, u, EMPTY);
          }
        }
        const [x0, y0] = this.horiz ? [un * 2 - 6, sp[0] - 6] : [sp[0] - 6, un * 2 - 6];
        const [w, h] = this.horiz ? [16, sp[1] - sp[0] + 12] : [sp[1] - sp[0] + 12, 16];
        this.protect(x0, y0, w, h);
        used.push(un);
        break;
      }
    }
    return this.bridges.length >= 3;
  }

  override townCount(fit: number): number { return Math.min(this.rng() < 0.5 ? 3 : 4, fit); }
  override minTowns(fit: number): number { return Math.min(3, fit); }

  // ---------- dressing ----------
  override dress(): void {
    const { W, H } = this;
    this.protectNear(ROAD, 1);
    const seed = (this.rng() * 1e9) | 0;
    // distance (cells, capped) from the channels
    const dist = new Uint8Array(W * H).fill(255);
    const q: number[] = [];
    for (let i = 0; i < W * H; i++) if (this.c[i] === WATER) { dist[i] = 0; q.push(i); }
    for (let h = 0; h < q.length; h++) {
      const i = q[h];
      const d = dist[i];
      if (d >= 24) continue;
      const x = i % W;
      const y = (i / W) | 0;
      for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const xx = x + dx;
        const yy = y + dy;
        if (xx < 0 || yy < 0 || xx >= W || yy >= H) continue;
        const k = yy * W + xx;
        if (dist[k] <= d + 1) continue;
        dist[k] = d + 1;
        q.push(k);
      }
    }
    // marsh: pools of open water in the low land near the channels, ringed by reeds
    const want = Math.round((W * H) / 3600);
    let made = 0;
    for (let tries = 0; tries < want * 30 && made < want; tries++) {
      const px = this.ri(8, W - 9);
      const py = this.ri(8, H - 9);
      const d = dist[py * W + px];
      if (d < 5 || d > 20) continue;
      const rx = this.ri(3, 7);
      const ry = this.ri(2, 5);
      if (!this.free(px - rx - 3, py - ry - 3, 2 * rx + 7, 2 * ry + 7)) continue;
      for (let y = -ry - 3; y <= ry + 3; y++) {
        for (let x = -rx - 3; x <= rx + 3; x++) {
          const e = (x * x) / (rx * rx) + (y * y) / (ry * ry) + (vnoise((px + x) / 3, (py + y) / 3, seed) - 0.5) * 0.9;
          const i = (py + y) * W + px + x;
          if (this.c[i] !== EMPTY || this.prot[i]) continue;
          if (e <= 1) this.c[i] = WATER;
          else if (e <= 2.1 && vnoise((px + x) / 2.5, (py + y) / 2.5, seed + 5) > 0.35) this.c[i] = TREES;
        }
      }
      this.protect(px - rx - 2, py - ry - 2, 2 * rx + 5, 2 * ry + 5);
      made++;
    }
    // reed beds along the banks: clumps 1-3 cells deep where the noise says so
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        const i = y * W + x;
        const d = dist[i];
        if (d < 1 || d > 4) continue;
        const n = vnoise(x / 6, y / 6, seed + 11) * 0.8 + vnoise(x / 2, y / 2, seed + 12) * 0.2;
        if (n > 0.36 + d * 0.05) this.plant(x, y);
      }
    }
    // willow copses and scrub on the wet meadows, a few hedges on the drier land
    const ncop = Math.round((W * H) / (52 * 52 * 1.2));
    for (let k = 0; k < ncop; k++) {
      const cx = this.ri(6, W - 7);
      const cy = this.ri(6, H - 7);
      const r0 = this.ri(2, 5);
      for (let y = -r0; y <= r0; y++) for (let x = -r0; x <= r0; x++) {
        if (x * x + y * y <= r0 * r0 + 1 && vnoise((cx + x) / 2, (cy + y) / 2, seed + 13) > 0.3) this.plant(cx + x, cy + y);
      }
    }
    // a few hedge fragments between the meadows
    for (let k = 0; k < Math.round((W * H) / 5000); k++) {
      const vertical = this.rng() < 0.5;
      const x = this.ri(8, W - 30);
      const y = this.ri(8, H - 30);
      for (let a = 0; a < this.ri(8, 22); a++) for (let j = 0; j < 2; j++) this.plant(vertical ? x + j : x + a, vertical ? y + a : y + j);
    }
    // fishing jetties: a plank pier (road deck over water) from the bank near each village into a side channel
    for (const t of this.towns) this.jetty(t, dist);
  }

  /** A short timber pier from the bank into the water near a village (not into the main channel). */
  jetty(t: TownPlan, dist: Uint8Array): void {
    const { W, H } = this;
    const main = this.channels[0];
    const U = this.horiz ? W : H;
    const R = t.rect;
    const spots: [number, number][] = [];
    for (let y = Math.max(4, R.y - 20); y < Math.min(H - 8, R.y + R.h + 16); y += 2) {
      for (let x = Math.max(4, R.x - 20); x < Math.min(W - 8, R.x + R.w + 16); x += 2) if (dist[y * W + x] >= 1 && dist[y * W + x] <= 3) spots.push([x, y]);
    }
    for (let i = spots.length - 1; i > 0; i--) {
      const j = this.ri(0, i);
      [spots[i], spots[j]] = [spots[j], spots[i]];
    }
    for (const [x, y] of spots) {
      // a bank cell (water within 3 cells): find the water direction
      for (let d = 0; d < 4; d++) {
        const dx = [0, 1, 0, -1][d];
        const dy = [-1, 0, 1, 0][d];
        // 4 wide pier: dry land (open or reeds) under its root, mostly water under its 6-cell length
        let ok = true;
        for (let j = 0; j < 4 && ok; j++) for (let i = 0; i < 4 && ok; i++) { const c = this.at(x + i, y + j); if (c !== EMPTY && c !== TREES) ok = false; }
        if (!ok) continue;
        let wet = 0;
        for (let k = 1; k <= 6 && ok; k++) {
          for (let j = 0; j < 4; j++) {
            const xx = dx ? x + (dx > 0 ? 3 + k : -k) : x + j;
            const yy = dy ? y + (dy > 0 ? 3 + k : -k) : y + j;
            const c = this.at(xx, yy);
            if (c !== WATER) { if (k > 2) ok = false; } else wet++;
          }
        }
        if (!ok || wet < 16) continue;
        // not in the main channel (the flagship's route), not right by a bridge
        const u = this.horiz ? x : y;
        const v = this.horiz ? y : x;
        const mc = main.c[Math.min(U, Math.max(0, u))];
        if (Math.abs(v - mc) < main.w[Math.min(U, Math.max(0, u))] / 2 + 10) continue;
        for (let k = 0; k <= 6; k++) {
          for (let j = 0; j < 4; j++) {
            const xx = dx ? x + (dx > 0 ? 3 + k : -k) : x + j;
            const yy = dy ? y + (dy > 0 ? 3 + k : -k) : y + j;
            this.set(xx, yy, ROAD);
          }
        }
        // a boathouse beside the pier's root, its door onto the planks
        const huts: [number, number, number][] = dx ? [[x - 2, y - 8, 2], [x - 2, y + 4, 0]] : [[x - 8, y - 2, 1], [x + 4, y - 2, 3]];
        for (const [hx, hy, door] of huts) {
          let clear = hx >= 2 && hy >= 2 && hx + 8 <= W - 2 && hy + 8 <= H - 2;
          for (let j = -1; j < 9 && clear; j++) for (let i = -1; i < 9 && clear; i++) {
            const c = this.at(hx + i, hy + j);
            const edge = i < 0 || j < 0 || i > 7 || j > 7;
            if (c === WATER || (!edge && c !== EMPTY && c !== TREES) || (!edge && this.prot[(hy + j) * W + hx + i])) clear = false;
          }
          if (!clear) continue;
          building(this, { x: hx, y: hy, w: 8, h: 8 }, GK_PLANKS, [{ side: door, at: 2 }]);
          break;
        }
        return;
      }
    }
  }

  override extra(spec: RegionSpec): void {
    const U = this.horiz ? this.W : this.H;
    const c = this.channels[0].c;
    const pts: [number, number][] = [];
    for (let u = 0; u <= U; u += 4) {
      const v = Math.round(c[u] * 40) / 10;
      pts.push(this.horiz ? [u * 4, v] : [v, u * 4]);
      if (u < U && u + 4 > U) u = U - 4;
    }
    spec.river = pts;
  }
}
