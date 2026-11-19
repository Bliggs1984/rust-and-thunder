// Phase 4: small hand-made regions for the helicopter and the final fight, so they can be tested (tools/boss-sim-3.ts,
// ?bosstest=heli|final screenshot scenes) without the region generators. Deterministic.
import { BRICK, EMPTY, ROAD, STEEL, TREES, WATER } from '../constants';
import type { RegionSpec, Town } from '../region';
import { mulberry32 } from '../stages';
import { railRiverTestSpec } from './testspec';

class Cells {
  c: Uint8Array;
  constructor(public w: number, public h: number) {
    this.c = new Uint8Array(w * h);
  }
  set(x: number, y: number, v: number): void {
    if (x >= 0 && y >= 0 && x < this.w && y < this.h) this.c[y * this.w + x] = v;
  }
  at(x: number, y: number): number {
    return x >= 0 && y >= 0 && x < this.w && y < this.h ? this.c[y * this.w + x] : -1;
  }
  rect(x: number, y: number, w: number, h: number, v: number): void {
    for (let j = y; j < y + h; j++) for (let i = x; i < x + w; i++) this.set(i, j, v);
  }
}

/** A town over cell rect (x, y, w, h) with its flag at the centre and two garrison spots on open nodes. */
function town(c: Cells, name: string, x: number, y: number, w: number, h: number): Town {
  const cx = (x + w / 2) * 4;
  const cy = (y + h / 2) * 4;
  const garrison: [number, number][] = [];
  for (let r = 3; r < 10 && garrison.length < 2; r++) {
    for (const [dx, dy] of [[-r, 0], [r, 0], [0, -r], [0, r]]) {
      const nx = Math.round((cx - 8) / 8) + dx;
      const ny = Math.round((cy - 8) / 8) + dy;
      let open = true;
      for (let j = ny * 2; j < ny * 2 + 4; j++) for (let i = nx * 2; i < nx * 2 + 4; i++) if (c.at(i, j) !== EMPTY && c.at(i, j) !== ROAD) open = false;
      if (open && garrison.length < 2 && !garrison.some(([gx, gy]) => gx === nx * 8 && gy === ny * 8)) garrison.push([nx * 8, ny * 8]);
    }
  }
  return { name, rect: [x * 4, y * 4, w * 4, h * 4], cx, cy, garrison };
}

/**
 * "RUINED BLOCK" (night storm, 448 x 384 px): a street grid of burnt-out brick blocks, a canal with three road
 * bridges, steel stubs in the ruins, three towns; the helicopter pad ends up in the far corner.
 */
export function heliTestRegion(): RegionSpec {
  const W = 112;
  const H = 96;
  const c = new Cells(W, H);
  const rng = mulberry32(4041);
  const rows = [10, 46, 82];
  const cols = [8, 46, 88];
  // ruined blocks between the streets: brick shells with broken walls, rubble inside, the odd steel stub
  for (let by = 0; by < 4; by++) {
    for (let bx = 0; bx < 4; bx++) {
      const x0 = bx === 0 ? 0 : cols[bx - 1] + 4;
      const x1 = bx === 3 ? W : cols[bx];
      const y0 = by === 0 ? 0 : rows[by - 1] + 4;
      const y1 = by === 3 ? H : rows[by];
      for (let k = 0; k < 3; k++) {
        const bw = 8 + Math.floor(rng() * 8);
        const bh = 6 + Math.floor(rng() * 6);
        const x = x0 + 2 + Math.floor(rng() * Math.max(1, x1 - x0 - bw - 4));
        const y = y0 + 2 + Math.floor(rng() * Math.max(1, y1 - y0 - bh - 4));
        if (x + bw > x1 - 1 || y + bh > y1 - 1) continue;
        for (let j = y; j < y + bh; j++) {
          for (let i = x; i < x + bw; i++) {
            const edge = i < x + 2 || i >= x + bw - 2 || j < y + 2 || j >= y + bh - 2;
            if (edge && rng() > 0.18) c.set(i, j, BRICK);
            else if (!edge && rng() < 0.12) c.set(i, j, BRICK);
          }
        }
        if (rng() < 0.5) c.rect(x + 2, y, 2, 2, STEEL);
      }
    }
  }
  // the canal across the middle of the second band
  c.rect(0, 64, W, 6, WATER);
  // streets (bridges where they cross the canal)
  for (const y of rows) c.rect(0, y, W, 4, ROAD);
  for (const x of cols) c.rect(x, 0, 4, H, ROAD);
  // trees in a park and along the canal
  c.rect(60, 50, 10, 6, TREES);
  for (let x = 2; x < W; x += 9) c.rect(x, 61, 3, 2, TREES);
  const towns = [
    town(c, 'STARE MISTO', 50, 16, 34, 26),
    town(c, 'ZAVODSKA', 12, 50, 30, 12),
    town(c, 'NOVYI KVARTAL', 50, 72, 36, 10),
  ];
  // clear the flag areas so they can be captured
  for (const t of towns) c.rect(Math.floor(t.cx / 4) - 4, Math.floor(t.cy / 4) - 4, 8, 8, EMPTY);
  return {
    name: 'RUINED BLOCK', env: 'night', w: W, h: H, cells: c.c,
    playerSpawns: [[cols[0] * 4, (H - 6) * 4], [cols[0] * 4, (H - 10) * 4]],
    enemySpawns: [[cols[2] * 4, 0], [(W - 4) * 4, rows[0] * 4], [cols[1] * 4, 0]],
    enemies: 12, maxActive: 4, towns, depots: [],
    exits: [[cols[2] * 4, 0], [(W - 4) * 4, rows[0] * 4], [cols[1] * 4, 0], [(W - 4) * 4, rows[2] * 4]],
    boss: 'heli',
  };
}

/**
 * "WINTER FRONT" test (snow, 600 x 480 px): a frozen road across the top with exits at both ends and a road out to
 * the north, a road up from the start, tree belts, a few old steel bunkers, three villages near the start; the
 * command post is built far from the start by the boss itself.
 */
export function finalTestRegion(): RegionSpec {
  const W = 150;
  const H = 120;
  const c = new Cells(W, H);
  const rng = mulberry32(5051);
  for (let k = 0; k < 14; k++) {
    const x = Math.floor(rng() * (W - 12));
    const y = Math.floor(rng() * (H - 10));
    c.rect(x, y, 6 + Math.floor(rng() * 8), 3 + Math.floor(rng() * 4), TREES);
  }
  // old steel bunkers (scenery)
  for (const [x, y] of [[20, 20], [70, 44], [120, 96], [96, 70], [40, 86]]) c.rect(x, y, 4, 4, STEEL);
  // roads: across the top, up from the start, north out of the map
  c.rect(0, 30, W, 4, ROAD);
  c.rect(16, 30, 4, H - 30, ROAD);
  c.rect(124, 0, 4, 34, ROAD);
  c.rect(16, 84, 80, 4, ROAD);
  // villages: brick houses round a green
  const towns: Town[] = [];
  const spots: [string, number, number][] = [['ZIMOVE', 26, 92], ['KRYZHANE', 54, 62], ['SNIHURIVKA', 70, 98]];
  for (const [name, x, y] of spots) {
    for (const [hx, hy] of [[0, 0], [16, 0], [0, 12], [16, 12]]) c.rect(x + hx, y + hy, 6, 4, BRICK);
    towns.push(town(c, name, x, y, 22, 16));
  }
  return {
    name: 'WINTER FRONT', env: 'snow', w: W, h: H, cells: c.c,
    playerSpawns: [[64, (H - 6) * 4], [64, (H - 10) * 4]],
    enemySpawns: [[0, 120], [(W - 4) * 4, 120], [496, 0]],
    enemies: 12, maxActive: 4, towns, depots: [],
    exits: [[0, 120], [(W - 4) * 4, 120], [496, 0]],
    boss: 'final',
  };
}

/** ?bosstest=heli|final (null for anything else). */
export function bossTestSpec(kind: string | null): RegionSpec | null {
  if (kind === 'train' || kind === 'flagship') return railRiverTestSpec(kind, 1); // bosses/testspec.ts
  return kind === 'heli' ? heliTestRegion() : kind === 'final' ? finalTestRegion() : null;
}
