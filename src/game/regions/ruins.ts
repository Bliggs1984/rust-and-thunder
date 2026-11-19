// Region 4 "Ruined town": a shattered city filling the whole map. Streets on a loose grid (a road lane between
// two clear pavements: 8 cells, 32 px, kerb to kerb, so tanks never snag), some blocks merged where a street is
// gone; a canal along the long axis with quays on both banks and 3-4 bridges; blocks of damaged brick buildings
// (breached walls, collapsed shells, rubble = single brick cells) with alleys between them; a big central square for
// the helicopter fight (`lair`), 4-5 district squares with the flags (the "towns"), steel-framed factory ruins
// whose yards hold the depots, and parks.
import { BRICK, EMPTY, GK_CONCRETE, GK_PAVING, GK_PLANKS, GK_TILES, ROAD, STEEL, TREES, WATER } from '../constants';
import { blowCorner, breach } from './build';
import type { AmbientSpot, RegionSpec } from '../region';
import { mulberry32 } from '../stages';
import { Farm, vnoise, type DepotPlan, type Rect, type TownPlan } from './gen';

const DISTRICT_NAMES = [
  'OLD TOWN', 'STATION QUARTER', 'CANAL SIDE', 'HOSPITAL HILL', 'MARKET', 'TEXTILE MILLS', 'SCHOOL NO 3', 'CATHEDRAL',
  'TRAM DEPOT', 'RIVER GATE', 'POTTERS ROW', 'GARDEN CITY',
];

/** A city block: a connected patch of buildable cells between streets. */
interface Block { k: number; cells: number[]; bb: Rect; kind: 'ruin' | 'plaza' | 'square' | 'park' | 'factory'; edge: boolean }

export class Ruins extends Farm {
  override regionName = 'RUINED TOWN';
  override env = 'night' as const;
  override boss = 'heli' as const;
  override townNames = DISTRICT_NAMES;
  override depotKinds = ['TANK REPAIR SHOP', 'FUEL DUMP', 'AMMO DUMP'];
  /** street lines (node coords): columns (x) and rows (y) */
  cols: number[] = [];
  rows: number[] = [];
  /** canal: index of the street gap it runs in (between rows[k] and rows[k+1], or columns when !horiz) */
  canalK = -1;
  blocks: Block[] = [];
  plaza: Block | null = null;
  blockOf = new Int32Array(0);

  override riverSide(): number { return 0; }

  override build(): RegionSpec | null {
    const { W, H, NX, NY } = this;
    this.horiz = W >= H;
    this.rTop = new Int32Array(Math.max(W, H)).fill(1 << 20);
    this.rBot = new Int32Array(Math.max(W, H)).fill(1 << 20);
    // ---------- street grid ----------
    const lines = (n: number, canal: boolean) => {
      const out: number[] = [];
      let p = this.ri(7, 10);
      const k = canal ? this.ri(1, 2) : -1; // the canal runs between line k and k+1
      while (p < n - 7) {
        out.push(p);
        p += out.length - 1 === k ? 11 : this.ri(15, 19);
      }
      if (canal) this.canalK = k < out.length - 1 ? k : -1;
      return out;
    };
    this.cols = lines(NX, !this.horiz);
    this.rows = lines(NY, this.horiz);
    if (this.canalK < 0 || this.cols.length < 4 || this.rows.length < 4) { this.fail = 'grid'; return null; }
    const cols = this.cols;
    const rows = this.rows;
    // canal water + quays (cells) between the two streets of gap canalK
    const along = this.horiz ? rows : cols;
    const c0 = along[this.canalK] * 2 + 6; // first cell past the pavement
    for (let a = 0; a < (this.horiz ? W : H); a++) {
      for (let b = c0 + 3; b < c0 + 11; b++) {
        if (this.horiz) this.set(a, b, WATER);
        else this.set(b, a, WATER);
      }
    }
    if (this.horiz) this.protect(0, c0, W, 14);
    else this.protect(c0, 0, 14, H);
    // segments: horizontal (row j, cols i..i+1) and vertical (col i, rows j..j+1); a spanning tree first, then
    // most of the rest; across the canal only the bridges
    type Seg = { a: number; b: number; path: number[]; canal: boolean; quay: boolean };
    const nI = cols.length;
    const nJ = rows.length;
    const id = (i: number, j: number) => j * nI + i;
    const segs: Seg[] = [];
    for (let j = 0; j < nJ; j++) {
      for (let i = 0; i + 1 < nI; i++) {
        const path: number[] = [];
        for (let x = cols[i]; x <= cols[i + 1]; x++) path.push(this.node(x, rows[j]));
        const quay = this.horiz && (j === this.canalK || j === this.canalK + 1);
        segs.push({ a: id(i, j), b: id(i + 1, j), path, canal: !this.horiz && i === this.canalK, quay });
      }
    }
    for (let i = 0; i < nI; i++) {
      for (let j = 0; j + 1 < nJ; j++) {
        const path: number[] = [];
        for (let y = rows[j]; y <= rows[j + 1]; y++) path.push(this.node(cols[i], y));
        const quay = !this.horiz && (i === this.canalK || i === this.canalK + 1);
        segs.push({ a: id(i, j), b: id(i, j + 1), path, canal: this.horiz && j === this.canalK, quay });
      }
    }
    const canalSegs = segs.filter((s) => s.canal);
    const nb = Math.min(canalSegs.length, this.ri(3, 4));
    // bridges spread along the canal
    const bridgeSet = new Set<Seg>();
    for (let k = 0; k < nb; k++) bridgeSet.add(canalSegs[Math.min(canalSegs.length - 1, Math.round(((k + 0.5) * canalSegs.length) / nb - 0.5 + (this.rng() - 0.5)))]);
    const uf = Array.from({ length: nI * nJ }, (_, i) => i);
    const find = (x: number): number => (uf[x] === x ? x : (uf[x] = find(uf[x])));
    const keep = new Set<Seg>();
    const order = segs.filter((s) => !s.canal || bridgeSet.has(s)).map((s) => [this.rng() + (s.quay ? -1 : 0), s] as [number, Seg]);
    order.sort((p, q) => p[0] - q[0]);
    for (const [, s] of order) {
      const ra = find(s.a);
      const rb = find(s.b);
      if (ra !== rb || s.quay || bridgeSet.has(s) || this.rng() < 0.62) { keep.add(s); uf[ra] = rb; }
    }
    this.newSite('street', this.node(cols[0], rows[0]));
    for (const s of keep) {
      this.layPath(s.path, 0);
      if (s.canal) this.bridges.push(s.path);
    }
    // the player drives in from the edge parallel to the canal, up a street to the first junction
    const playerEdge = this.horiz ? (this.rng() < 0.5 ? 2 : 0) : this.rng() < 0.5 ? 1 : 3;
    const pick = (list: number[]) => list[this.ri(1, list.length - 2)];
    const stub = (edge: number, p: number) => {
      const path: number[] = [];
      if (edge === 0) for (let y = 0; y <= rows[0]; y++) path.push(this.node(p, y));
      else if (edge === 2) for (let y = NY - 1; y >= rows[nJ - 1]; y--) path.push(this.node(p, y));
      else if (edge === 3) for (let x = 0; x <= cols[0]; x++) path.push(this.node(x, p));
      else for (let x = NX - 1; x >= cols[nI - 1]; x--) path.push(this.node(x, p));
      return path;
    };
    const pLine = playerEdge === 0 || playerEdge === 2 ? pick(cols) : pick(rows);
    this.entry = stub(playerEdge, pLine);
    if (this.entry.length < 7) { this.fail = 'entry'; return null; }
    this.layPath(this.entry, 0);
    const pn = this.playerNode();
    // exits: 2-3 streets out of the other edges, away from the player
    const far = (playerEdge + 2) & 3;
    const exitEdges = [far, far, (playerEdge + 1) & 3, (playerEdge + 3) & 3];
    for (let tries = 0; tries < 30 && this.exits.length < 3; tries++) {
      const edge = exitEdges[this.exits.length === 0 ? 0 : this.ri(0, 3)];
      const lineList = edge === 0 || edge === 2 ? cols : rows;
      const p = lineList[this.ri(0, lineList.length - 1)];
      const path = stub(edge, p);
      const end = path[path.length - 1];
      if (path.some((n, k) => k < path.length - 1 && this.lane[n])) continue;
      if (path.some((n) => this.nodeHas(n, WATER))) continue;
      if (Math.abs(this.nx(end) - this.nx(pn)) + Math.abs(this.ny(end) - this.ny(pn)) < 40) continue;
      this.layPath(path, 0);
      this.exits.push(path);
    }
    if (this.exits.length < 2) { this.fail = 'exits'; return null; }
    // road cells, pavements (kept clear), quays
    for (let n = 0; n < NX * NY; n++) if (this.lane[n]) this.fill(this.nx(n) * 2, this.ny(n) * 2, 4, 4, ROAD);
    this.protectNear(ROAD, 2);
    // ---------- blocks ----------
    this.findBlocks();
    if (!this.assignBlocks(pn)) return null;
    // depots first (their gates join the streets), then everything else
    for (const d of this.depots) {
      this.layPath(this.depotPath(d), 0);
      for (const n of this.depotPath(d)) this.fill(this.nx(n) * 2, this.ny(n) * 2, 4, 4, ROAD);
      this.buildDepot(d);
      // the compound is no longer part of its factory block
      const R = d.rect;
      for (let y = R.y - 2; y < R.y + R.h + 2; y++) for (let x = R.x - 2; x < R.x + R.w + 2; x++) if (x >= 0 && y >= 0 && x < W && y < H) this.blockOf[y * W + x] = -1;
    }
    for (const b of this.blocks) this.buildBlock(b);
    // pavements, quays and the squares' edges: paving on every kept-clear cell that has no floor of its own
    for (let i = 0; i < W * H; i++) if (this.prot[i] && !this.k[i] && this.c[i] === EMPTY) this.k[i] = GK_PAVING;
    this.fail = 'reach';
    return this.finish();
  }

  /** Connected patches of free (unprotected, empty) cells: the blocks between the streets. */
  findBlocks(): void {
    const { W, H } = this;
    const lab = new Int32Array(W * H).fill(-1);
    const stack: number[] = [];
    for (let i = 0; i < W * H; i++) {
      if (lab[i] >= 0 || this.c[i] !== EMPTY || this.prot[i]) continue;
      const k = this.blocks.length;
      const b: Block = { k, cells: [], bb: { x: W, y: H, w: 0, h: 0 }, kind: 'ruin', edge: false };
      lab[i] = k;
      stack.push(i);
      let x1 = 0;
      let y1 = 0;
      while (stack.length) {
        const j = stack.pop()!;
        b.cells.push(j);
        const x = j % W;
        const y = (j / W) | 0;
        b.bb.x = Math.min(b.bb.x, x);
        b.bb.y = Math.min(b.bb.y, y);
        x1 = Math.max(x1, x);
        y1 = Math.max(y1, y);
        if (x === 0 || y === 0 || x === W - 1 || y === H - 1) b.edge = true;
        for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
          const xx = x + dx;
          const yy = y + dy;
          if (xx < 0 || yy < 0 || xx >= W || yy >= H) continue;
          const q = yy * W + xx;
          if (lab[q] >= 0 || this.c[q] !== EMPTY || this.prot[q]) continue;
          lab[q] = k;
          stack.push(q);
        }
      }
      b.bb.w = x1 - b.bb.x + 1;
      b.bb.h = y1 - b.bb.y + 1;
      this.blocks.push(b);
    }
    this.blockOf = lab;
  }

  /** Is the whole rect inside block b? */
  inBlock(b: Block, r: Rect): boolean {
    for (let y = r.y; y < r.y + r.h; y++) for (let x = r.x; x < r.x + r.w; x++) {
      if (x < 0 || y < 0 || x >= this.W || y >= this.H || this.blockOf[y * this.W + x] !== b.k) return false;
    }
    return true;
  }

  /** The central square, the district squares (towns), the factory district with the depots, parks. */
  assignBlocks(pn: number): boolean {
    const { W, H } = this;
    const inner = this.blocks.filter((b) => !b.edge && b.bb.w >= 18 && b.bb.h >= 16);
    if (inner.length < 8) { this.fail = 'blocks'; return false; }
    const ctr = (b: Block) => [b.bb.x + b.bb.w / 2, b.bb.y + b.bb.h / 2];
    const pdist = (b: Block) => { const [x, y] = ctr(b); return Math.hypot(x - this.nx(pn) * 2, y - this.ny(pn) * 2); };
    // central square: big, near the middle of the map
    let best: Block | null = null;
    let bs = -1e9;
    for (const b of inner) {
      const [x, y] = ctr(b);
      const s = b.bb.w * b.bb.h * 0.02 - Math.hypot(x - W / 2, y - H / 2) * 0.5;
      if (s > bs) { bs = s; best = b; }
    }
    this.plaza = best!;
    this.plaza.kind = 'plaza';
    // factory district: the inner blocks on the far side from the player; depots in the biggest of them
    const farBlocks = inner.filter((b) => b.kind === 'ruin' && pdist(b) > Math.hypot(W, H) * 0.36).sort((a, b) => b.bb.w * b.bb.h - a.bb.w * a.bb.h);
    const wantDepots = this.ri(2, 3);
    const kinds = [...this.depotKinds];
    for (const b of farBlocks) {
      if (this.depots.length >= wantDepots) break;
      if (this.depots.some((d) => Math.hypot(d.rect.x - b.bb.x, d.rect.y - b.bb.y) < 50)) continue;
      const plan = this.depotIn(b);
      if (!plan) continue;
      plan.name = `${kinds.length ? kinds.splice(this.ri(0, kinds.length - 1), 1)[0] : 'DEPOT'} ${this.ri(2, 9)}`;
      this.depots.push(plan);
      b.kind = 'factory';
    }
    if (this.depots.length < (this.relaxed ? 1 : 2)) { this.fail = 'depots'; return false; }
    // more factory blocks round the depots
    for (const b of inner) {
      if (b.kind !== 'ruin') continue;
      if (this.depots.some((d) => Math.hypot(d.rect.x + d.rect.w / 2 - ctr(b)[0], d.rect.y + d.rect.h / 2 - ctr(b)[1]) < 46) && this.rng() < 0.7) b.kind = 'factory';
    }
    // district squares: spread out, away from the player start, the plaza and the depots
    const want = this.ri(4, 5);
    const names = [...this.townNames];
    const squares: Block[] = [];
    const cand = inner.filter((b) => b.kind === 'ruin' && pdist(b) > 60);
    for (let k = 0; k < want; k++) {
      let pickB: Block | null = null;
      let ps = -1;
      for (const b of cand) {
        if (squares.includes(b)) continue;
        const [x, y] = ctr(b);
        let d = Math.hypot(x - ctr(this.plaza)[0], y - ctr(this.plaza)[1]);
        for (const s of squares) d = Math.min(d, Math.hypot(x - ctr(s)[0], y - ctr(s)[1]));
        for (const dp of this.depots) d = Math.min(d, Math.hypot(x - dp.rect.x - dp.rect.w / 2, y - dp.rect.y - dp.rect.h / 2) + 10);
        const s = Math.min(d, 90) + this.rng() * 10;
        if (d >= 48 && s > ps) { ps = s; pickB = b; }
      }
      if (!pickB) break;
      squares.push(pickB);
    }
    if (squares.length < (this.relaxed ? 2 : 4)) { this.fail = 'towns'; return false; }
    for (const b of squares) {
      b.kind = 'square';
      const tcx = this.even(b.bb.x + b.bb.w / 2);
      const tcy = this.even(b.bb.y + b.bb.h / 2);
      const pad = 10;
      const rect = { x: b.bb.x - pad, y: b.bb.y - pad, w: b.bb.w + 2 * pad, h: b.bb.h + 2 * pad };
      const t: TownPlan = {
        name: names.splice(this.ri(0, names.length - 1), 1)[0], tcx, tcy, S: 16, ext: [0, 0, 0, 0], arms: [true, true, true, true],
        rect, site: 0, gates: [],
      };
      this.towns.push(t);
    }
    // parks: 1-2 of the remaining inner blocks
    let parks = this.ri(1, 2);
    for (const b of inner) {
      if (parks <= 0) break;
      if (b.kind === 'ruin' && this.rng() < 0.18) { b.kind = 'park'; parks--; }
    }
    return true;
  }

  /** A walled depot compound filling most of factory block b, its gate facing the nearest street. */
  depotIn(b: Block): DepotPlan | null {
    for (const [w, h] of [[28, 24], [24, 20], [24, 24], [28, 20], [22, 20], [20, 22], [20, 20]]) {
      if (b.bb.w < w + 2 || b.bb.h < h + 2) continue;
      const x = this.even(b.bb.x + (b.bb.w - w) / 2);
      const y = this.even(b.bb.y + (b.bb.h - h) / 2);
      const r = { x, y, w, h };
      if (!this.inBlock(b, r)) continue;
      // gate side: the block side nearest a street (all are; pick the one towards the map centre)
      const dx = this.W / 2 - (x + w / 2);
      const dy = this.H / 2 - (y + h / 2);
      const side = Math.abs(dx) > Math.abs(dy) ? (dx > 0 ? 1 : 3) : dy > 0 ? 2 : 0;
      const gx = (x + w / 2 - 2) >> 1;
      const gy = (y + h / 2 - 2) >> 1;
      const start = side === 0 ? [gx, (y >> 1) + 2] : side === 2 ? [gx, ((y + h) >> 1) - 4] : side === 3 ? [(x >> 1) + 2, gy] : [((x + w) >> 1) - 4, gy];
      const yard = this.node(start[0], start[1]);
      // walk out until a street lane
      let n = yard;
      let gate = -1;
      for (let k = 0; k < 14; k++) {
        const nx = this.nx(n) + [0, 1, 0, -1][side];
        const ny = this.ny(n) + [-1, 0, 1, 0][side];
        if (!this.inNodes(nx, ny)) break;
        n = this.node(nx, ny);
        if (this.lane[n]) { gate = n; break; }
        if (this.nodeHas(n, WATER)) break;
      }
      if (gate < 0) continue;
      return { name: '', rect: r, side, site: 0, yard, gate };
    }
    return null;
  }
  /** Lane nodes from the depot yard out to the street (its gate). */
  depotPath(d: DepotPlan): number[] {
    const out = [d.yard];
    let n = d.yard;
    while (n !== d.gate && out.length < 16) {
      n = this.node(this.nx(n) + [0, 1, 0, -1][d.side], this.ny(n) + [-1, 0, 1, 0][d.side]);
      out.push(n);
    }
    return out;
  }

  // ---------- building the blocks ----------
  buildBlock(b: Block): void {
    if (b.kind === 'plaza') return this.buildPlaza(b);
    if (b.kind === 'square') return this.buildSquare(b);
    if (b.kind === 'park') return this.buildPark(b);
    if (b.kind === 'factory') return this.buildFactory(b);
    // ruins: lots split by alleys, a damaged building on each
    for (const lot of this.lots(b.bb, 0)) this.buildLot(b, lot);
  }

  /** Recursive lot split: big rects split along their long side, sometimes with a 4-cell alley. */
  lots(r: Rect, depth: number): Rect[] {
    const long = Math.max(r.w, r.h);
    if (long <= 16 || depth > 5 || (long <= 22 && this.rng() < 0.4)) return [r];
    const alley = this.rng() < 0.45 ? 4 : 0;
    if (r.w >= r.h) {
      const a = this.even(r.w * (0.35 + this.rng() * 0.3));
      if (a < 6 || r.w - a - alley < 6) return [r];
      return [...this.lots({ x: r.x, y: r.y, w: a, h: r.h }, depth + 1), ...this.lots({ x: r.x + a + alley, y: r.y, w: r.w - a - alley, h: r.h }, depth + 1)];
    }
    const a = this.even(r.h * (0.35 + this.rng() * 0.3));
    if (a < 6 || r.h - a - alley < 6) return [r];
    return [...this.lots({ x: r.x, y: r.y, w: r.w, h: a }, depth + 1), ...this.lots({ x: r.x, y: r.y + a + alley, w: r.w, h: r.h - a - alley }, depth + 1)];
  }

  /** Set a cell of block b (only cells that belong to it). */
  bset(b: Block, x: number, y: number, t: number): void {
    if (x < 0 || y < 0 || x >= this.W || y >= this.H) return;
    const i = y * this.W + x;
    if (this.blockOf[i] === b.k && this.c[i] === EMPTY) this.c[i] = t;
  }

  /** Lay a ground kind on the cells of block b inside a rect. */
  bkind(b: Block, r: Rect, kind: number): void {
    for (let y = Math.max(0, r.y); y < Math.min(this.H, r.y + r.h); y++) {
      for (let x = Math.max(0, r.x); x < Math.min(this.W, r.x + r.w); x++) if (this.blockOf[y * this.W + x] === b.k) this.k[y * this.W + x] = kind;
    }
  }

  /** Clear a cell of block b (battle damage). */
  bclear = (b: Block) => (x: number, y: number, t: number): void => {
    if (x < 0 || y < 0 || x >= this.W || y >= this.H) return;
    if (this.blockOf[y * this.W + x] === b.k) this.c[y * this.W + x] = t;
  };

  /**
   * One lot: a building that fills it (party walls with its neighbours), walls 2 cells thick on the tank grid, a
   * tiled or boarded floor, bigger ones split into rooms by partition walls with doorways. Then the damage, which
   * leaves the plan readable: one to three tank-wide breaches with ragged ends, sometimes a corner blown off, and a
   * few blocks of fallen masonry. One lot in twelve is an open paved yard with a tree.
   */
  buildLot(b: Block, r: Rect): void {
    const x0 = r.x + (r.x & 1);
    const y0 = r.y + (r.y & 1);
    const w = (r.x + r.w - x0) & ~1;
    const h = (r.y + r.h - y0) & ~1;
    const roll = this.rng();
    if (w < 8 || h < 8 || roll < 0.08) {
      // yard: paving, a tree, a little rubble
      this.bkind(b, r, GK_PAVING);
      if (w >= 6 && h >= 6) for (let j = 0; j < 2; j++) for (let i = 0; i < 2; i++) this.bset(b, x0 + 2 + i, y0 + 2 + j, TREES);
      this.debris(b, r, 1);
      return;
    }
    const lot = { x: x0, y: y0, w, h };
    this.bkind(b, lot, this.rng() < 0.5 ? GK_TILES : GK_PLANKS);
    for (let y = y0; y < y0 + h; y++) for (let x = x0; x < x0 + w; x++) {
      if (x < x0 + 2 || y < y0 + 2 || x >= x0 + w - 2 || y >= y0 + h - 2) this.bset(b, x, y, BRICK);
    }
    // rooms: a partition across each long side, a doorway in each
    if (w >= 16) {
      const ix = x0 + this.even(w / 2) + 2 * this.ri(-1, 0);
      const door = y0 + 2 + 2 * this.ri(0, (h - 8) >> 1);
      for (let y = y0 + 2; y < y0 + h - 2; y++) if (y < door || y >= door + 4) { this.bset(b, ix, y, BRICK); this.bset(b, ix + 1, y, BRICK); }
    }
    if (h >= 16) {
      const iy = y0 + this.even(h / 2) + 2 * this.ri(-1, 0);
      const door = x0 + 2 + 2 * this.ri(0, (w - 8) >> 1);
      for (let x = x0 + 2; x < x0 + w - 2; x++) if (x < door || x >= door + 4) { this.bset(b, x, iy, BRICK); this.bset(b, x, iy + 1, BRICK); }
    }
    const clear = this.bclear(b);
    // breaches: tank-wide holes blown through 1-3 walls
    const sides = [0, 1, 2, 3].filter(() => this.rng() < 0.5);
    if (!sides.length) sides.push(this.ri(0, 3));
    for (const s of sides) {
      const len = s === 0 || s === 2 ? w : h;
      const gl = len >= 12 && this.rng() < 0.4 ? 6 : 4;
      breach(this, lot, s, 2 + 2 * this.ri(0, Math.max(0, (len - 4 - gl) >> 1)), gl, clear);
    }
    // gutted: a corner of the building gone
    const gut = roll < 0.3;
    if (gut || this.rng() < 0.25) blowCorner(this, lot, this.ri(0, 3), gut ? this.ri(5, Math.max(5, Math.min(w, h) - 3)) : this.ri(3, 4), clear);
    this.debris(b, { x: x0 + 2, y: y0 + 2, w: w - 4, h: h - 4 }, gut ? 2 : 1);
  }

  /** Fallen masonry: up to n 2 x 2 blocks of brick on open cells of block b (never loose single cells). */
  debris(b: Block, r: Rect, n: number): void {
    for (let k = 0; k < n; k++) {
      if (this.rng() < 0.35 || r.w < 2 || r.h < 2) continue;
      const x = this.even(r.x + this.rng() * (r.w - 2));
      const y = this.even(r.y + this.rng() * (r.h - 2));
      let ok = true;
      for (let j = 0; j < 2; j++) for (let i = 0; i < 2; i++) {
        const q = (y + j) * this.W + x + i;
        if (x + i >= this.W || y + j >= this.H || this.blockOf[q] !== b.k || this.c[q] !== EMPTY) ok = false;
      }
      if (ok) for (let j = 0; j < 2; j++) for (let i = 0; i < 2; i++) this.bset(b, x + i, y + j, BRICK);
    }
  }

  /** The central square: open paving for the helicopter fight, lime trees round the edge, a statue on a plinth. */
  buildPlaza(b: Block): void {
    const r = b.bb;
    this.bkind(b, r, GK_PAVING);
    // lime trees all round the edge (every 6 cells, a few burnt away)
    for (let x = r.x + 2; x < r.x + r.w - 3; x += 6) {
      for (const y of [r.y + 2, r.y + r.h - 4]) {
        if (this.rng() < 0.85) for (let j = 0; j < 2; j++) for (let i = 0; i < 2; i++) this.bset(b, x + i, y + j, TREES);
      }
    }
    for (let y = r.y + 8; y < r.y + r.h - 9; y += 6) {
      for (const x of [r.x + 2, r.x + r.w - 4]) {
        if (this.rng() < 0.85) for (let j = 0; j < 2; j++) for (let i = 0; i < 2; i++) this.bset(b, x + i, y + j, TREES);
      }
    }
    // the monument: a statue (steel) on a brick plinth
    const cx = this.even(r.x + r.w / 2) - 1;
    const cy = this.even(r.y + r.h / 2) - 1;
    for (let j = -1; j < 3; j++) for (let i = -1; i < 3; i++) this.bset(b, cx + i, cy + j, i >= 0 && i < 2 && j >= 0 && j < 2 ? STEEL : BRICK);
    // burnt-out vehicles (steel) left where they stopped, near the edges
    for (let k = 0; k < 3; k++) {
      const horizV = this.rng() < 0.5;
      const lw = horizV ? 5 : 2;
      const lh = horizV ? 2 : 5;
      const x = r.x + 6 + this.ri(0, Math.max(0, r.w - 12 - lw));
      const y = this.rng() < 0.5 ? r.y + 5 + this.ri(0, 3) : r.y + r.h - 6 - lh - this.ri(0, 3);
      for (let j = 0; j < lh; j++) for (let i = 0; i < lw; i++) this.bset(b, x + i, y + j, STEEL);
    }
    this.protect(r.x, r.y, r.w, r.h);
  }

  /** A district square with the flag: paved, houses round it, lime trees in the corners, a barricade at each end. */
  buildSquare(b: Block): void {
    let r = b.bb;
    // shelled houses on every side deep enough; the open square (about 18 x 16 cells) is what's left in the middle
    const dx = Math.max(0, Math.min(10, this.even((r.w - 18) / 2)));
    const dy = Math.max(0, Math.min(10, this.even((r.h - 16) / 2)));
    const strips: Rect[] = [];
    if (dy >= 8) strips.push({ x: r.x, y: r.y, w: r.w, h: dy }, { x: r.x, y: r.y + r.h - dy, w: r.w, h: dy });
    if (dx >= 8) strips.push({ x: r.x, y: r.y + (dy >= 8 ? dy : 0), w: dx, h: r.h - (dy >= 8 ? 2 * dy : 0) }, { x: r.x + r.w - dx, y: r.y + (dy >= 8 ? dy : 0), w: dx, h: r.h - (dy >= 8 ? 2 * dy : 0) });
    for (const st of strips) for (const lot of this.lots(st, 3)) this.buildLot(b, lot);
    r = { x: r.x + (dx >= 8 ? dx : 0), y: r.y + (dy >= 8 ? dy : 0), w: r.w - (dx >= 8 ? 2 * dx : 0), h: r.h - (dy >= 8 ? 2 * dy : 0) };
    this.bkind(b, r, GK_PAVING);
    for (const [x, y] of [[r.x + 1, r.y + 1], [r.x + r.w - 3, r.y + 1], [r.x + 1, r.y + r.h - 3], [r.x + r.w - 3, r.y + r.h - 3]]) {
      for (let j = 0; j < 2; j++) for (let i = 0; i < 2; i++) this.bset(b, x + i, y + j, TREES);
    }
    // barricades: two short walls 2 cells thick across each end, a tank-wide way through the middle
    const my = this.even(r.y + r.h / 2);
    if (r.h >= 16 && r.w >= 16) {
      for (const x of [this.even(r.x + 2), this.even(r.x + r.w - 4)]) {
        for (const y of [my - 6, my + 2]) for (let j = 0; j < 4; j++) for (let i = 0; i < 2; i++) this.bset(b, x + i, y + j, BRICK);
      }
    }
  }

  /** Park: clumps of trees with open lawns and paths. */
  buildPark(b: Block): void {
    const r = b.bb;
    const seed = this.ri(0, 1 << 20);
    for (let y = r.y; y < r.y + r.h; y++) for (let x = r.x; x < r.x + r.w; x++) {
      if (this.blockOf[y * this.W + x] !== b.k) continue;
      const path = Math.abs(x - (r.x + r.w / 2)) < 2 || Math.abs(y - (r.y + r.h / 2)) < 2;
      if (path) this.k[y * this.W + x] = GK_PAVING;
      else if (vnoise(x / 5, y / 5, seed) > 0.42) this.bset(b, x, y, TREES);
    }
  }

  /**
   * Factory ruins: one big hall on a concrete floor: steel columns (2 x 2) on an 8-cell grid, brick wall panels
   * 2 cells thick between the columns round the outside (a third of them blown out, which leaves a 6-cell opening),
   * machinery (steel) in some of the inner bays.
   */
  buildFactory(b: Block): void {
    const r = b.bb;
    const x0 = r.x + (r.x & 1);
    const y0 = r.y + (r.y & 1);
    const nx = Math.floor((r.x + r.w - x0 - 2) / 8);
    const ny = Math.floor((r.y + r.h - y0 - 2) / 8);
    if (nx < 1 || ny < 1) return;
    this.bkind(b, { x: x0, y: y0, w: nx * 8 + 2, h: ny * 8 + 2 }, GK_CONCRETE);
    for (let j = 0; j <= ny; j++) for (let i = 0; i <= nx; i++) {
      const x = x0 + i * 8;
      const y = y0 + j * 8;
      for (let q = 0; q < 2; q++) for (let p = 0; p < 2; p++) this.bset(b, x + p, y + q, STEEL);
      // wall panels on the outer sides
      if ((j === 0 || j === ny) && i < nx && this.rng() < 0.65) for (let p = 2; p < 8; p++) for (let q = 0; q < 2; q++) this.bset(b, x + p, y + q, BRICK);
      if ((i === 0 || i === nx) && j < ny && this.rng() < 0.65) for (let q = 2; q < 8; q++) for (let p = 0; p < 2; p++) this.bset(b, x + p, y + q, BRICK);
      // machinery in some inner bays
      if (i < nx && j < ny && i > 0 && j > 0 && this.rng() < 0.3) for (let q = 4; q < 6; q++) for (let p = 2; p < 6; p++) this.bset(b, x + p, y + q, STEEL);
    }
    this.debris(b, r, 3);
  }

  override extra(spec: RegionSpec): void {
    if (this.plaza) {
      const r = this.plaza.bb;
      spec.lair = [(r.x + r.w / 2) * 4, (r.y + r.h / 2) * 4];
    }
    spec.ambient = this.ambientSpots(spec);
  }

  /**
   * The night's light sources (visual only, drawn by src/game/ambient.ts): burning buildings (open floor walled in on
   * three or more sides), street fires on the pavements (burning wrecks and barrels), and streetlamps along the kerbs,
   * about a third of them still working. Picked from the finished cells with their own hash-seeded random numbers, so
   * the map itself and the generator's random stream stay exactly as they were.
   */
  ambientSpots(spec: RegionSpec): AmbientSpot[] {
    const { W, H, c } = this;
    let hs = 2166136261;
    for (let i = 0; i < c.length; i += 5) hs = Math.imul(hs ^ c[i] ^ (i & 255), 16777619);
    const rnd = mulberry32(hs | 0);
    const at = (x: number, y: number) => (x < 0 || y < 0 || x >= W || y >= H ? STEEL : c[y * W + x]);
    const D = [[0, -1], [1, 0], [0, 1], [-1, 0]];
    const shuffle = <T>(a: T[]): T[] => {
      for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(rnd() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; }
      return a;
    };
    const out: AmbientSpot[] = [];
    // keep fires off the flags (the ring must stay readable) and the player's start
    const keepOff: [number, number, number][] = [
      ...(spec.towns ?? []).map((t) => [t.cx, t.cy, 40] as [number, number, number]),
      ...spec.playerSpawns.map((p) => [p[0] + 8, p[1] + 8, 48] as [number, number, number]),
    ];
    const clear = (x: number, y: number) => keepOff.every(([kx, ky, r]) => Math.hypot(kx - x, ky - y) >= r);
    const far = (x: number, y: number, d: number, kind?: number) => out.every((s) => (kind !== undefined && s.kind !== kind) || Math.hypot(s.x - x, s.y - y) >= d);
    // 1. burning buildings
    const inside: [number, number][] = [];
    for (let y = 3; y < H - 3; y += 2) {
      for (let x = 3; x < W - 3; x += 2) {
        if (c[y * W + x] !== EMPTY || this.prot[y * W + x]) continue;
        let walls = 0;
        for (const [dx, dy] of D) {
          for (let k = 1; k <= 7; k++) {
            const t = at(x + dx * k, y + dy * k);
            if (t === BRICK || t === STEEL) { walls++; break; }
            if (t === ROAD || t === WATER) break;
          }
        }
        if (walls >= 3) inside.push([x, y]);
      }
    }
    const wantFires = Math.round((W * H) / 1500);
    for (const [x, y] of shuffle(inside)) {
      if (out.length >= wantFires) break;
      const px = x * 4 + 2;
      const py = y * 4 + 2;
      if (!clear(px, py) || !far(px, py, 76)) continue;
      out.push({ x: px, y: py, kind: 0, size: 0.55 + rnd() * 0.45, seed: rnd(), dir: 0 });
    }
    // 2. street fires and 3. lamps, both on the pavements: lamps on the outer kerb line, arm out over the road
    const kerb: [number, number, number][] = [];
    const pave: [number, number][] = [];
    for (let y = 2; y < H - 2; y++) {
      for (let x = 2; x < W - 2; x++) {
        if (c[y * W + x] !== EMPTY) continue;
        for (let d = 0; d < 4; d++) {
          const [dx, dy] = D[d];
          if (at(x + dx * 2, y + dy * 2) === ROAD && at(x + dx, y + dy) === EMPTY && at(x - dx, y - dy) !== ROAD) { kerb.push([x, y, d]); break; }
          if (at(x + dx, y + dy) === ROAD && (x + y) % 3 === 0) { pave.push([x, y]); break; }
        }
      }
    }
    const wantStreet = Math.round((W * H) / 4500);
    let street = 0;
    for (const [x, y] of shuffle(pave)) {
      if (street >= wantStreet) break;
      const px = x * 4 + 2;
      const py = y * 4 + 2;
      if (!clear(px, py) || !far(px, py, 150, 1) || !far(px, py, 48)) continue;
      out.push({ x: px, y: py, kind: 1, size: 0.35 + rnd() * 0.35, seed: rnd(), dir: 0 });
      street++;
    }
    // the central square: two of its burnt-out vehicles still burning (light for the helicopter fight)
    if (this.plaza) {
      const r = this.plaza.bb;
      const wreck: [number, number][] = [];
      for (let y = r.y + 1; y < r.y + r.h - 1; y++) {
        for (let x = r.x + 1; x < r.x + r.w - 1; x++) if (c[y * W + x] === EMPTY && at(x, y - 1) === STEEL && at(x, y + 1) !== STEEL) wreck.push([x, y]);
      }
      const cx = (r.x + r.w / 2) * 4;
      const cy = (r.y + r.h / 2) * 4;
      let n = 0;
      for (const [x, y] of shuffle(wreck)) {
        if (n >= 2) break;
        const px = x * 4 + 2;
        const py = y * 4 + 1;
        if (Math.hypot(px - cx, py - cy) < 24 || !far(px, py, 70)) continue;
        out.push({ x: px, y: py, kind: 1, size: 0.6 + rnd() * 0.3, seed: rnd(), dir: 0 });
        n++;
      }
    }
    for (const [x, y, d] of shuffle(kerb)) {
      const px = x * 4 + 2;
      const py = y * 4 + 2;
      if (!far(px, py, 64, 2) || !far(px, py, 24)) continue;
      out.push({ x: px, y: py, kind: 2, size: 1, seed: rnd(), dir: d });
    }
    return out;
  }
}
