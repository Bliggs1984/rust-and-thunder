// Phase 4 boss tests on a known map: a farmland test map with a hand-made railway (for the armoured train) or a wide
// river channel with bridges (for the flagship) laid over it, and RegionSpec.boss set. Used by tools/boss-sim-2.ts
// and by ?bosstest=train|flagship (testmaps.ts bossTestSpec).
import { BRICK, EMPTY, RAIL, ROAD, STEEL, TREES, WATER } from '../constants';
import { makeTestRegion, type BossKind, type RegionSpec } from '../region';
import { roundCorners } from '../railgeo';

type R4 = [number, number, number, number];

/** Overlap area of rect a with the rects in `rs` (each grown by `pad`). */
function clash(a: R4, rs: R4[], pad: number): number {
  let s = 0;
  for (const r of rs) {
    const w = Math.min(a[0] + a[2], r[0] + r[2] + pad) - Math.max(a[0], r[0] - pad);
    const h = Math.min(a[1] + a[3], r[1] + r[3] + pad) - Math.max(a[1], r[1] - pad);
    if (w > 0 && h > 0) s += w * h;
  }
  return s;
}

function obstacles(spec: RegionSpec): R4[] {
  const out: R4[] = [];
  for (const t of spec.towns ?? []) out.push([...t.rect]);
  for (const d of spec.depots ?? []) out.push([...d.rect]);
  const sp = spec.playerSpawns[0];
  out.push([sp[0] - 24, sp[1] - 24, 64, 64]);
  return out;
}

/** Visit every 4 px cell whose centre is within `half` px of the polyline (centre line). */
function band(spec: RegionSpec, pts: [number, number][], half: number, fn: (i: number, d: number) => void): void {
  const seen = new Map<number, number>();
  for (let k = 0; k + 1 < pts.length; k++) {
    const [ax, ay] = pts[k];
    const [bx, by] = pts[k + 1];
    const len = Math.hypot(bx - ax, by - ay);
    for (let s = 0; s <= len; s += 1) {
      const x = ax + ((bx - ax) * s) / len;
      const y = ay + ((by - ay) * s) / len;
      for (let cy = Math.floor((y - half) / 4); cy <= Math.floor((y + half) / 4); cy++) {
        for (let cx = Math.floor((x - half) / 4); cx <= Math.floor((x + half) / 4); cx++) {
          if (cx < 0 || cy < 0 || cx >= spec.w || cy >= spec.h) continue;
          const d = Math.hypot(cx * 4 + 2 - x, cy * 4 + 2 - y);
          if (d > half) continue;
          const i = cy * spec.w + cx;
          const o = seen.get(i);
          if (o === undefined || d < o) seen.set(i, d);
        }
      }
    }
  }
  for (const [i, d] of seen) fn(i, d);
}

/** A railway across the map: in from the west, a dog-leg south, out to the east, placed clear of the towns. */
function addRail(spec: RegionSpec): void {
  const W = spec.w * 4;
  const H = spec.h * 4;
  const obs = obstacles(spec);
  const row = (y: number, x0: number, x1: number) => clash([x0, y - 16, x1 - x0, 32], obs, 8);
  const col = (x: number, y0: number, y1: number) => clash([x - 16, Math.min(y0, y1), 32, Math.abs(y1 - y0)], obs, 8);
  let best: [number, number][] = [];
  let bs = Infinity;
  for (let yA = 50; yA < H * 0.45; yA += 8) {
    for (let yB = Math.ceil(H * 0.55); yB < H - 50; yB += 8) {
      for (let xm = Math.round(W * 0.35); xm < W * 0.65; xm += 16) {
        const a = Math.round(yA / 4) * 4 + 2;
        const b = Math.round(yB / 4) * 4 + 2;
        const m = Math.round(xm / 4) * 4 + 2;
        const s = row(a, 0, m) + col(m, a, b) + row(b, m, W);
        if (s < bs) { bs = s; best = [[6, a], [m, a], [m, b], [W - 6, b]]; }
      }
    }
  }
  // the dog-leg's corners are curves (the train and the drawn track both follow them)
  best = roundCorners(best, 40).map(([x, y]) => [Math.round(x * 10) / 10, Math.round(y * 10) / 10]);
  spec.rail = best;
  const c = spec.cells;
  // clear a 28 px corridor; water under it becomes a rail bridge
  band(spec, best, 14, (i) => {
    if (c[i] === BRICK || c[i] === STEEL || c[i] === TREES) c[i] = EMPTY;
    if (c[i] === WATER) c[i] = RAIL;
  });
  band(spec, best, 6, (i) => { c[i] = RAIL; });
}

/** A wide river across the map (gentle bends), tree-lined banks, two road bridges; tanks stay off its channel. */
function addRiver(spec: RegionSpec): void {
  const W = spec.w * 4;
  const H = spec.h * 4;
  const obs = obstacles(spec);
  const half = 40;
  let bestY = H / 2;
  let bs = Infinity;
  for (let y = 90; y < H - 90; y += 8) {
    const s = clash([0, y - half - 30, W, 2 * half + 60], obs, 8);
    if (s < bs) { bs = s; bestY = y; }
  }
  const pts: [number, number][] = [];
  for (let k = 0; k <= 5; k++) pts.push([Math.round((W * k) / 5), Math.round(bestY + (k % 2 ? 22 : -14))]);
  spec.river = pts;
  const c = spec.cells;
  const seed = pts[1][1] * 7 + W;
  band(spec, pts, half + 12, (i, d) => {
    if (d <= half) c[i] = WATER;
    else if (c[i] !== ROAD) c[i] = ((i * 2654435761 + seed) >>> 0) % 100 < 55 ? TREES : EMPTY;
  });
  // two bridges, 24 px wide, square across the channel
  for (const fx of [0.3, 0.72]) {
    const bx = Math.round((W * fx) / 8) * 8;
    let by = bestY;
    for (let k = 0; k + 1 < pts.length; k++) {
      if (bx < pts[k][0] || bx > pts[k + 1][0]) continue;
      by = pts[k][1] + ((pts[k + 1][1] - pts[k][1]) * (bx - pts[k][0])) / (pts[k + 1][0] - pts[k][0]);
    }
    for (let cy = Math.floor((by - half - 16) / 4); cy <= Math.floor((by + half + 16) / 4); cy++) {
      for (let cx = bx / 4; cx < bx / 4 + 6; cx++) if (cx >= 0 && cy >= 0 && cx < spec.w && cy < spec.h) c[cy * spec.w + cx] = ROAD;
    }
    (spec.bridges ??= []).push([bx + 4, Math.round(by / 8) * 8]);
  }
}

/** The farmland test map `seed` with a rail line or a river channel for `kind`, and that boss. */
export function railRiverTestSpec(kind: BossKind, seed: number): RegionSpec {
  const spec = makeTestRegion(seed);
  spec.boss = kind;
  if (kind === 'train') addRail(spec);
  if (kind === 'flagship') addRiver(spec);
  spec.name = kind === 'train' ? 'RAIL JUNCTION (TEST)' : kind === 'flagship' ? 'RIVER DELTA (TEST)' : spec.name;
  return spec;
}
