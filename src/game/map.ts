import { BRICK, EMPTY, ICE, NC, STEEL, TREES, WATER, EAGLE_X, EAGLE_Y } from './constants';

const EPS = 1e-4;

/** Dirty tracking works on chunks of this many cells per side. */
export const CHUNK = 16;

// Fortress tiles (8px) around the base.
const FORT_TILES: [number, number][] = [[11, 23], [11, 24], [11, 25], [12, 23], [13, 23], [14, 23], [14, 24], [14, 25]];
export const FORT_CELLS: [number, number][] = FORT_TILES.flatMap(([tx, ty]) => [
  [tx * 2, ty * 2], [tx * 2 + 1, ty * 2], [tx * 2, ty * 2 + 1], [tx * 2 + 1, ty * 2 + 1],
] as [number, number][]);

const CHAR: Record<string, number> = { '#': BRICK, '@': STEEL, '~': WATER, '%': TREES, '-': ICE };

export class GameMap {
  /** Size in cells (4 px each). */
  readonly w: number;
  readonly h: number;
  /** Size in pixels. */
  readonly pxW: number;
  readonly pxH: number;
  /** Cells. Writes through `set()` are tracked for the renderer; after any direct write call `touchAll()`. */
  c: Uint8Array;
  version = 0;
  /** Blocks the tank node under the arcade eagle in `nodeCost` (switched off for base-less regions). */
  eagle = true;
  private full = true;
  private readonly chunksX: number;
  private readonly chunksY: number;
  private readonly dirtyFlag: Uint8Array;
  private dirtyList: number[] = [];

  constructor(w = NC, h = NC) {
    this.w = w;
    this.h = h;
    this.pxW = w * 4;
    this.pxH = h * 4;
    this.c = new Uint8Array(w * h);
    this.chunksX = Math.ceil(w / CHUNK);
    this.chunksY = Math.ceil(h / CHUNK);
    this.dirtyFlag = new Uint8Array(this.chunksX * this.chunksY);
  }

  /** Tank-node grid size (8 px nodes; a tank at node n covers cells 2n..2n+3). 52 cells -> 25 nodes. */
  get nodesX(): number { return (this.w >> 1) - 1; }
  get nodesY(): number { return (this.h >> 1) - 1; }

  at(cx: number, cy: number): number {
    if (cx < 0 || cy < 0 || cx >= this.w || cy >= this.h) return STEEL;
    return this.c[cy * this.w + cx];
  }

  set(cx: number, cy: number, v: number): void {
    if (cx < 0 || cy < 0 || cx >= this.w || cy >= this.h) return;
    const i = cy * this.w + cx;
    if (this.c[i] !== v) {
      this.c[i] = v;
      this.version++;
      if (!this.full) {
        const k = (cy >> 4) * this.chunksX + (cx >> 4);
        if (!this.dirtyFlag[k]) {
          this.dirtyFlag[k] = 1;
          this.dirtyList.push(k);
        }
      }
    }
  }

  /** Call after writing `c` directly: the next takeDirty() asks for a full re-upload. */
  touchAll(): void {
    this.full = true;
    this.version++;
  }

  /**
   * Cell rects [cx, cy, cw, ch] changed through set() since the last call, one per 16x16-cell chunk (clipped to the
   * map), or null when everything must be re-uploaded (first call, or after load/loadCells/clearRect/touchAll).
   */
  takeDirty(): number[][] | null {
    if (this.full) {
      this.full = false;
      this.dirtyFlag.fill(0);
      this.dirtyList.length = 0;
      return null;
    }
    const out: number[][] = [];
    for (const k of this.dirtyList) {
      this.dirtyFlag[k] = 0;
      const cx = (k % this.chunksX) * CHUNK;
      const cy = Math.floor(k / this.chunksX) * CHUNK;
      out.push([cx, cy, Math.min(CHUNK, this.w - cx), Math.min(CHUNK, this.h - cy)]);
    }
    this.dirtyList.length = 0;
    return out;
  }

  /** Copy a whole cell array (w*h cells) in, e.g. a generated region. */
  loadCells(cells: ArrayLike<number>): void {
    this.c.set(cells);
    this.touchAll();
  }

  /** Arcade stage: 13x13 blocks of 4x4 cells on a 52x52 map, plus spawn areas, eagle and fortress. */
  load(rows: string[]): void {
    const W = this.w;
    this.c.fill(EMPTY);
    for (let by = 0; by < 13; by++) {
      for (let bx = 0; bx < 13; bx++) {
        const ch = rows[by]?.[bx] ?? '.';
        let type = CHAR[ch] ?? EMPTY;
        let part = (_qx: number, _qy: number) => true;
        const lower = ch.toLowerCase();
        if ('lrtb'.includes(lower) && ch !== '.') {
          type = ch === lower ? BRICK : STEEL;
          if (lower === 'l') part = (qx) => qx < 2;
          if (lower === 'r') part = (qx) => qx >= 2;
          if (lower === 't') part = (_qx, qy) => qy < 2;
          if (lower === 'b') part = (_qx, qy) => qy >= 2;
        }
        if (type === EMPTY) continue;
        for (let qy = 0; qy < 4; qy++) for (let qx = 0; qx < 4; qx++) {
          if (part(qx, qy)) this.c[(by * 4 + qy) * W + bx * 4 + qx] = type;
        }
      }
    }
    this.clearRect(0, 0, 16, 16);
    this.clearRect(96, 0, 16, 16);
    this.clearRect(192, 0, 16, 16);
    this.clearRect(64, 192, 16, 16);
    this.clearRect(128, 192, 16, 16);
    this.clearRect(EAGLE_X, EAGLE_Y, 16, 16);
    for (const [cx, cy] of FORT_CELLS) this.c[cy * W + cx] = BRICK;
    this.touchAll();
  }

  /** Clear a pixel rect to EMPTY. Setup helper: forces a full re-upload. */
  clearRect(x: number, y: number, w: number, h: number): void {
    for (let cy = Math.max(0, y >> 2); cy < Math.min(this.h, (y + h) >> 2); cy++) {
      for (let cx = Math.max(0, x >> 2); cx < Math.min(this.w, (x + w) >> 2); cx++) this.c[cy * this.w + cx] = EMPTY;
    }
    this.touchAll();
  }

  /** True if any cell overlapping the pixel rect passes the test. */
  any(x: number, y: number, w: number, h: number, test: (t: number) => boolean): boolean {
    const cx0 = Math.floor((x + EPS) / 4);
    const cy0 = Math.floor((y + EPS) / 4);
    const cx1 = Math.floor((x + w - EPS) / 4);
    const cy1 = Math.floor((y + h - EPS) / 4);
    for (let cy = cy0; cy <= cy1; cy++) for (let cx = cx0; cx <= cx1; cx++) if (test(this.at(cx, cy))) return true;
    return false;
  }

  solidForTank(x: number, y: number, hover: boolean): boolean {
    return this.any(x, y, 16, 16, (t) => t === BRICK || t === STEEL || (t === WATER && !hover));
  }

  /** Movement cost of a tank sitting at 8px node (nx, ny). Infinity = can't get there. */
  nodeCost(nx: number, ny: number): number {
    let brick = false;
    for (let cy = ny * 2; cy < ny * 2 + 4; cy++) {
      for (let cx = nx * 2; cx < nx * 2 + 4; cx++) {
        const t = this.at(cx, cy);
        if (t === STEEL || t === WATER) return Infinity;
        if (t === BRICK) brick = true;
      }
    }
    if (this.eagle) {
      const x = nx * 8;
      const y = ny * 8;
      if (x < EAGLE_X + 16 && x + 16 > EAGLE_X && y < EAGLE_Y + 16 && y + 16 > EAGLE_Y) return Infinity;
    }
    return brick ? 6 : 1;
  }
}

/**
 * Distance field over tank nodes toward a set of targets (Dial's algorithm; costs are small ints).
 * Enemies walk downhill on it, shooting through bricks on the way.
 * Size follows the map (nodes = cells/2 - 1 per axis). The per-node cost grid is cached per map version.
 */
export class Flow {
  d = new Float32Array(0);
  nw = 0;
  nh = 0;
  private cost = new Float32Array(0);
  private costMap: GameMap | null = null;
  private costVersion = -1;
  private buckets: number[][] = [];

  /**
   * `maxDist`: stop expanding past this distance (nodes beyond stay Infinity). `avoid`: a px rect (x, y, w, h) no
   * tank may stand in (a boss's wreck, which the cell map knows nothing about).
   */
  compute(map: GameMap, targets: [number, number][], maxDist = Infinity, avoid?: readonly number[] | null): void {
    const nw = map.nodesX;
    const nh = map.nodesY;
    if (nw !== this.nw || nh !== this.nh) {
      this.nw = nw;
      this.nh = nh;
      this.d = new Float32Array(nw * nh);
      this.cost = new Float32Array(nw * nh);
      this.costVersion = -1;
    }
    const d = this.d;
    const cost = this.cost;
    if (this.costMap !== map || this.costVersion !== map.version) {
      for (let ny = 0; ny < nh; ny++) for (let nx = 0; nx < nw; nx++) cost[ny * nw + nx] = map.nodeCost(nx, ny);
      this.costMap = map;
      this.costVersion = map.version;
    }
    d.fill(Infinity);
    const buckets = this.buckets;
    for (const b of buckets) if (b) b.length = 0;
    if (!buckets[0]) buckets[0] = [];
    for (const [x, y] of targets) {
      const i = Math.max(0, Math.min(nh - 1, y)) * nw + Math.max(0, Math.min(nw - 1, x));
      d[i] = 0;
      buckets[0].push(i);
    }
    for (let dist = 0; dist < buckets.length && dist <= maxDist; dist++) {
      const b = buckets[dist];
      if (!b) continue;
      for (let k = 0; k < b.length; k++) {
        const i = b[k];
        if (d[i] < dist) continue;
        const x = i % nw;
        const y = (i / nw) | 0;
        const nd = dist + (Number.isFinite(cost[i]) ? cost[i] : 6);
        for (let dir = 0; dir < 4; dir++) {
          const nx = dir === 0 ? x + 1 : dir === 1 ? x - 1 : x;
          const ny = dir === 2 ? y + 1 : dir === 3 ? y - 1 : y;
          if (nx < 0 || ny < 0 || nx >= nw || ny >= nh) continue;
          const j = ny * nw + nx;
          if (!Number.isFinite(cost[j])) continue;
          if (avoid && nx * 8 < avoid[0] + avoid[2] && nx * 8 + 16 > avoid[0] && ny * 8 < avoid[1] + avoid[3] && ny * 8 + 16 > avoid[1]) continue;
          if (nd < d[j]) {
            d[j] = nd;
            (buckets[nd] ??= []).push(j);
          }
        }
      }
    }
  }

  at(nx: number, ny: number): number {
    if (nx < 0 || ny < 0 || nx >= this.nw || ny >= this.nh) return Infinity;
    return this.d[ny * this.nw + nx];
  }
}
