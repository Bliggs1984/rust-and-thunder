// Headless checks for the campaign enemy AI (src/game/ai.ts) on hand-made regions with towns and roads.
// Run: npm run aisim   (writes shots/ai-*.png top-down frames)
import { reseed } from './ai-sim-seed';
import { mkdirSync, writeFileSync } from 'node:fs';
import { deflateSync } from 'node:zlib';
import { AI, type Group, type Unit } from '../src/game/ai';
import { regionBot } from '../src/game/bot';
import { BRICK, DX, DY, EMPTY, ICE, ROAD, STEEL, TREES, WATER } from '../src/game/constants';
import { Flow } from '../src/game/map';
import type { RegionSpec, Town } from '../src/game/region';
import { mulberry32 } from '../src/game/stages';
// these checks were written for (and seeded round) the standard garrison of 3; Farmland's own is 2 since 2026-11-18
AI.garrisonByRegion[0] = AI.garrisonSize;
import { Tank, World, newPState, type PInput } from '../src/game/world';

// ---------------------------------------------------------------- region builder
interface Layout {
  name: string;
  W: number;
  H: number;
  /** polylines in 8 px node coords (straight segments) */
  roads: [number, number][][];
  towns: { name: string; rect: [number, number, number, number] }[];
  /** tree rects in cells */
  hedges: [number, number, number, number][];
  /** tree circles in cells: cx, cy, r */
  clumps: [number, number, number][];
  player: [number, number];
  seed: number;
  /** walled supply depots (px rects, 8 px aligned) with a gate in the middle of the bottom wall */
  depots?: { name: string; rect: [number, number, number, number] }[];
}

function build(L: Layout): RegionSpec {
  const { W, H } = L;
  const c = new Uint8Array(W * H);
  const rng = mulberry32(L.seed);
  const fill = (x: number, y: number, w: number, h: number, v: number) => {
    for (let yy = Math.max(0, y); yy < Math.min(H, y + h); yy++) for (let xx = Math.max(0, x); xx < Math.min(W, x + w); xx++) c[yy * W + xx] = v;
  };
  for (const [x, y, w, h] of L.hedges) fill(x, y, w, h, TREES);
  for (const [cx, cy, r] of L.clumps) {
    for (let y = -r; y <= r; y++) for (let x = -r; x <= r; x++) if (x * x + y * y <= r * r) fill(cx + x, cy + y, 1, 1, TREES);
  }
  const roadCell = new Uint8Array(W * H);
  const nodes: [number, number][] = [];
  const edges: [number, number][] = [];
  const nodeId = (p: [number, number]) => {
    const k = nodes.findIndex((q) => q[0] === p[0] && q[1] === p[1]);
    if (k >= 0) return k;
    nodes.push([p[0], p[1]]);
    return nodes.length - 1;
  };
  const paint = (nx: number, ny: number) => {
    for (let y = ny * 2; y < ny * 2 + 4; y++) for (let x = nx * 2; x < nx * 2 + 4; x++) if (x < W && y < H) roadCell[y * W + x] = 1;
  };
  for (const line of L.roads) {
    for (let i = 0; i + 1 < line.length; i++) {
      const a = line[i];
      const b = line[i + 1];
      edges.push([nodeId(a), nodeId(b)]);
      let [x, y] = a;
      paint(x, y);
      while (x !== b[0]) { x += Math.sign(b[0] - x); paint(x, y); }
      while (y !== b[1]) { y += Math.sign(b[1] - y); paint(x, y); }
    }
  }
  const roadNear = (x: number, y: number, w: number, h: number) => {
    for (let yy = Math.max(0, y); yy < Math.min(H, y + h); yy++) for (let xx = Math.max(0, x); xx < Math.min(W, x + w); xx++) if (roadCell[yy * W + xx]) return true;
    return false;
  };
  for (const t of L.towns) {
    const [px, py, pw, ph] = t.rect;
    const x0 = px / 4;
    const y0 = py / 4;
    const cw = pw / 4;
    const ch = ph / 4;
    fill(x0, y0, cw, ch, EMPTY);
    for (let sy = y0 + 2; sy + 8 <= y0 + ch - 2; sy += 12) {
      for (let sx = x0 + 2; sx + 8 <= x0 + cw - 2; sx += 12) {
        if (rng() < 0.25 || roadNear(sx - 4, sy - 4, 16, 16)) continue;
        fill(sx, sy, 8, 8, BRICK);
        if (rng() < 0.6) {
          fill(sx + 2, sy + 2, 4, 4, EMPTY);
          const side = Math.floor(rng() * 4);
          if (side === 0) fill(sx + 2, sy, 4, 2, EMPTY);
          else if (side === 1) fill(sx + 2, sy + 6, 4, 2, EMPTY);
          else if (side === 2) fill(sx, sy + 2, 2, 4, EMPTY);
          else fill(sx + 6, sy + 2, 2, 4, EMPTY);
        }
      }
    }
  }
  for (const d of L.depots ?? []) {
    const [px, py, pw, ph] = d.rect.map((v) => v / 4);
    fill(px, py, pw, ph, BRICK);
    fill(px + 2, py + 2, pw - 4, ph - 4, EMPTY);
    fill(px + pw / 2 - 3, py + ph - 2, 6, 2, EMPTY); // gate
  }
  for (let i = 0; i < W * H; i++) if (roadCell[i]) c[i] = ROAD;
  const [pxs, pys] = L.player;
  fill(pxs / 4 - 2, pys / 4 - 2, 16, 8, EMPTY);
  const playerSpawns: [number, number][] = [[pxs, pys], [pxs + 24, pys]];
  // exits: road dead ends at the border
  const deg = new Array(nodes.length).fill(0);
  for (const [a, b] of edges) { deg[a]++; deg[b]++; }
  const nw = W / 2 - 1;
  const nh = H / 2 - 1;
  const enemySpawns: [number, number][] = [];
  nodes.forEach(([x, y], i) => {
    if (deg[i] === 1 && (x <= 0 || y <= 0 || x >= nw - 1 || y >= nh - 1)) enemySpawns.push([Math.min(x, nw - 1) * 8, Math.min(y, nh - 1) * 8]);
  });
  const towns: Town[] = L.towns.map((t) => ({
    name: t.name, rect: t.rect, cx: t.rect[0] + t.rect[2] / 2, cy: t.rect[1] + t.rect[3] / 2, garrison: spotsFor(c, W, t.rect),
  }));
  return {
    name: L.name, env: 'day', w: W, h: H, cells: c, playerSpawns, enemySpawns, enemies: 80, maxActive: 12,
    towns, roads: { nodes, edges },
    depots: (L.depots ?? []).map((d) => ({ name: d.name, rect: d.rect, cx: d.rect[0] + d.rect[2] / 2, cy: d.rect[1] + d.rect[3] / 2 })),
  };
}

/** Dug-in spots: open, off the road, inside the town, next to (not inside) a house; 32 px apart. */
function spotsFor(c: Uint8Array, W: number, rect: [number, number, number, number]): [number, number][] {
  const [x, y, w, h] = rect;
  const cand: { x: number; y: number; s: number }[] = [];
  for (let py = y; py + 16 <= y + h; py += 8) {
    for (let px = x; px + 16 <= x + w; px += 8) {
      let bad = false;
      let s = 0;
      for (let cy = py / 4 - 2; cy < py / 4 + 6; cy++) {
        for (let cx = px / 4 - 2; cx < px / 4 + 6; cx++) {
          const t = c[cy * W + cx];
          const inside = cx >= px / 4 && cx < px / 4 + 4 && cy >= py / 4 && cy < py / 4 + 4;
          if (inside && t !== EMPTY && t !== TREES) bad = true;
          if (!inside && t === BRICK) s++;
        }
      }
      if (!bad && s >= 4 && s <= 20) cand.push({ x: px, y: py, s });
    }
  }
  cand.sort((a, b) => b.s - a.s);
  const out: [number, number][] = [];
  for (const k of cand) {
    if (out.length >= 4) break;
    if (out.some(([ox, oy]) => Math.abs(ox - k.x) + Math.abs(oy - k.y) < 32)) continue;
    out.push([k.x, k.y]);
  }
  return out;
}

// 156x156 cells (624 px): crossroads town BRODKA in the middle, ZELENKO up a branch road in the north-east.
const SMALL: Layout = {
  name: 'AI TEST', W: 156, H: 156, seed: 5,
  roads: [
    [[0, 38], [38, 38], [76, 38]],
    [[38, 0], [38, 38], [38, 76]],
    [[38, 14], [64, 14]],
  ],
  towns: [
    { name: 'BRODKA', rect: [232, 232, 160, 160] },
    { name: 'ZELENKO', rect: [448, 64, 144, 112] },
  ],
  hedges: [
    [0, 110, 70, 4], [86, 110, 70, 4],
    [40, 0, 2, 40], [40, 50, 2, 26], [40, 84, 2, 20], [40, 120, 2, 36],
    [118, 60, 2, 50],
  ],
  clumps: [[100, 44, 6], [20, 130, 7], [128, 128, 5], [70, 20, 4]],
  player: [552, 552],
};

// 260x208 cells (1040x832 px) for perf: five towns on a road net.
const BIG: Layout = {
  name: 'AI PERF', W: 260, H: 208, seed: 9,
  roads: [
    [[0, 50], [24, 50], [64, 50], [110, 50], [128, 50]],
    [[64, 0], [64, 20], [64, 50], [64, 102]],
    [[24, 50], [24, 102]],
    [[64, 20], [100, 20], [128, 20]],
  ],
  towns: [
    { name: 'BRODKA', rect: [440, 320, 160, 160] },
    { name: 'ZELENKO', rect: [120, 560, 128, 128] },
    { name: 'OSTRIV', rect: [720, 96, 160, 128] },
    { name: 'HAIVKA', rect: [800, 336, 144, 128] },
    { name: 'LUKIVTSI', rect: [128, 336, 144, 128] },
  ],
  hedges: [[0, 150, 120, 4], [140, 150, 120, 4], [90, 0, 2, 90], [180, 100, 2, 100], [0, 70, 100, 2]],
  clumps: [[200, 40, 8], [40, 180, 7], [150, 180, 6], [230, 170, 9], [100, 130, 6]],
  player: [880, 760],
  seed: 9,
} as Layout;

// ---------------------------------------------------------------- harness
const G = { exceptions: 0, maxStill: 0, stillWho: '', frames: 0 };
let fails = 0;
const lines: string[] = [];
function check(name: string, ok: boolean, detail: string): void {
  if (!ok) fails++;
  lines.push(`${ok ? 'PASS' : 'FAIL'}  ${name}: ${detail}`);
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}: ${detail}`);
}

function newWorld(spec: RegionSpec): World {
  const ps = [newPState(), newPState()];
  ps[0].lives = 99;
  groupCol.clear();
  const w = new World(1, ps, 1, spec);
  w.ai!.gentleOff = true;
  if (w.tricks) w.tricks.gentleOff = true;
  return w;
}

type Hist = { x: number; y: number; c: [number, number, number] }[];
const anchors = new WeakMap<Unit, { x: number; y: number; f: number }>();
function step(w: World, inp: PInput, hist?: Hist): void {
  const p = w.players[0];
  if (p) p.shield = Math.max(p.shield, 2);
  try {
    w.update([inp]);
  } catch (err) {
    G.exceptions++;
    if (G.exceptions < 4) console.log(err);
  }
  G.frames++;
  w.ev.length = 0;
  w.decals.length = 0;
  w.notes.length = 0;
  // stuck = wants to move but has not got 12 px from where it was, for this many frames
  for (const u of w.ai!.units.values()) {
    let a = anchors.get(u);
    // a tank held up by a player tank right beside it (the bot parks on its goal) is not an AI stall
    const byPlayer = w.livePlayers().some((p) => Math.abs(p.x - u.t.x) < 20 && Math.abs(p.y - u.t.y) < 20);
    if (!a || !u.wantsMove || u.t.spawn || byPlayer || Math.hypot(u.t.x - a.x, u.t.y - a.y) > 12) {
      a = { x: u.t.x, y: u.t.y, f: w.frame };
      anchors.set(u, a);
    }
    const still = w.frame - a.f;
    if (still > G.maxStill) {
      if (process.env.TRACE && still > 300 && still % 60 === 0) {
        const ai = w.ai!;
        console.log(`STALL ${u.g.call}-${u.idx + 1} at ${u.t.x},${u.t.y} dir ${u.t.dir} want ${u.want} goal ${u.goal % ai.nw * 8},${((u.goal / ai.nw) | 0) * 8} blocked ${u.t.blocked} stuck ${u.t.stuck} tanks near goal ${w.allTanks().filter((o) => o !== u.t && o.alive && Math.abs(o.x - (u.goal % ai.nw) * 8) < 24 && Math.abs(o.y - ((u.goal / ai.nw) | 0) * 8) < 24).map((o) => `${o.x},${o.y}`).join(' ')} flags ${ai.flags[ai.nodeOf(u.t)]} beside ${w.allTanks().filter((o) => o !== u.t && o.alive && Math.abs(o.x - u.t.x) < 24 && Math.abs(o.y - u.t.y) < 24).map((o) => `${o.isPlayer ? 'P' : w.ai!.units.get(o)?.g.call + '-' + w.ai!.units.get(o)?.idx + ' ' + w.ai!.orderName(w.ai!.units.get(o)!) + ' want ' + w.ai!.units.get(o)?.want}@${o.x},${o.y}`).join(' ')}`);
      }
      G.maxStill = still;
      G.stillWho = `${u.g.call}-${u.idx + 1} ${u.g.job}/${u.g.phase} order ${w.ai!.orderName(u)} at ${u.t.x},${u.t.y}`;
    }
  }
  if (hist && w.frame % 10 === 0) {
    for (const u of w.ai!.units.values()) if (!u.t.spawn) hist.push({ x: u.t.cx, y: u.t.cy, c: colOf(u.g) });
    if (p) hist.push({ x: p.cx, y: p.cy, c: [255, 240, 80] });
  }
}

const idle: PInput = { dir: -1, fire: false };
const pf = new Flow();
let pfKey = -1;
let pfAt = 0;
function pilot(w: World, tx: number, ty: number, fire = false): PInput {
  const p = w.players[0];
  if (!p || p.spawn) return idle;
  const gx = Math.round(tx / 8);
  const gy = Math.round(ty / 8);
  const key = gy * 10000 + gx;
  if (key !== pfKey || w.frame - pfAt > 30) {
    pf.compute(w.map, [[gx, gy]]);
    pfKey = key;
    pfAt = w.frame;
  }
  const nx = Math.round(p.x / 8);
  const ny = Math.round(p.y / 8);
  let dir = -1;
  let bv = pf.at(nx, ny);
  for (let d = 0; d < 4; d++) {
    const v = pf.at(nx + DX[d], ny + DY[d]);
    if (v < bv) { bv = v; dir = d; }
  }
  return { dir, fire };
}

function teleport(w: World, x: number, y: number): void {
  const p = w.players[0]!;
  if (!w.blockedAt(p, x, y)) { p.x = x; p.y = y; return; }
  const s = w.freeSpotNear(x, y);
  if (s) [p.x, p.y] = s;
}

const run = (w: World, n: number, inp: (w: World) => PInput = () => idle, hist?: Hist, each?: () => boolean | void) => {
  for (let i = 0; i < n; i++) {
    step(w, inp(w), hist);
    if (each && each()) return i + 1;
  }
  return n;
};

const garrison = (w: World, town: string): Group | undefined => w.ai!.groups.find((g) => g.job === 'garrison' && g.town?.def.name === town);
const assaults = (w: World) => w.ai!.groups.filter((g) => g.job === 'assault');
const radioHas = (w: World, s: string) => w.radio.some((m) => m.text.includes(s));
const live = (g: Group) => g.members.filter((m) => !m.gone && m.t.alive && m.t.spawn === 0);
const sec = (f: number) => `${(f / 60).toFixed(1)}s`;

// ---------------------------------------------------------------- PNG frames
// garrisons in cool colours, assault groups in warm ones
const PAL_G: [number, number, number][] = [[80, 160, 255], [60, 210, 200], [150, 130, 255]];
const PAL_A: [number, number, number][] = [[240, 140, 40], [230, 70, 60], [250, 110, 190], [200, 90, 230]];
const groupCol = new Map<number, [number, number, number]>();
function colOf(g: Group): [number, number, number] {
  let c = groupCol.get(g.id);
  if (!c) {
    const n = [...groupCol.keys()].length;
    c = g.job === 'overwatch' ? [255, 60, 255] : g.job === 'garrison' ? PAL_G[n % PAL_G.length] : PAL_A[n % PAL_A.length];
    groupCol.set(g.id, c);
  }
  return c;
}
function snap(w: World, file: string, hist: Hist = [], note = ''): void {
  const W = w.pxW;
  const H = w.pxH;
  const img = new Uint8Array(W * H * 3);
  const put = (x: number, y: number, col: [number, number, number], a = 1) => {
    x = Math.round(x);
    y = Math.round(y);
    if (x < 0 || y < 0 || x >= W || y >= H) return;
    const i = (y * W + x) * 3;
    for (let k = 0; k < 3; k++) img[i + k] = Math.round(img[i + k] * (1 - a) + col[k] * a);
  };
  const rect = (x: number, y: number, w2: number, h2: number, col: [number, number, number], a = 1) => {
    for (let yy = 0; yy < h2; yy++) for (let xx = 0; xx < w2; xx++) put(x + xx, y + yy, col, a);
  };
  const outline = (x: number, y: number, w2: number, h2: number, col: [number, number, number], a = 1) => {
    for (let k = 0; k < w2; k++) { put(x + k, y, col, a); put(x + k, y + h2 - 1, col, a); }
    for (let k = 0; k < h2; k++) { put(x, y + k, col, a); put(x + w2 - 1, y + k, col, a); }
  };
  const CC: Record<number, [number, number, number]> = {
    [EMPTY]: [52, 64, 40], [BRICK]: [170, 90, 40], [STEEL]: [150, 150, 160], [WATER]: [40, 70, 150], [TREES]: [30, 110, 40],
    [ICE]: [170, 200, 230], [ROAD]: [120, 105, 80],
  };
  for (let cy = 0; cy < w.map.h; cy++) for (let cx = 0; cx < w.map.w; cx++) rect(cx * 4, cy * 4, 4, 4, CC[w.map.at(cx, cy)] ?? [255, 0, 255]);
  const ai = w.ai!;
  for (const t of ai.towns) {
    outline(t.def.rect[0], t.def.rect[1], t.def.rect[2], t.def.rect[3], [235, 235, 235], 0.8);
    outline(t.leash[0], t.leash[1], t.leash[2] - t.leash[0], t.leash[3] - t.leash[1], [235, 235, 235], 0.3);
    for (const s of t.spots) outline((s % ai.nw) * 8, ((s / ai.nw) | 0) * 8, 16, 16, [255, 255, 255], 0.35);
  }
  for (const h of hist) rect(h.x - 1, h.y - 1, 2, 2, h.c, 0.55);
  for (const g of ai.groups) for (const n of g.trail) rect((n % ai.nw) * 8 + 7, ((n / ai.nw) | 0) * 8 + 7, 2, 2, [255, 255, 255], 0.6);
  const tank = (t: Tank, col: [number, number, number]) => {
    rect(t.x + 1, t.y + 1, 14, 14, [10, 10, 10]);
    rect(t.x + 2, t.y + 2, 12, 12, col);
    for (let k = 0; k < 7; k++) rect(t.cx - 1 + DX[t.dir] * (3 + k), t.cy - 1 + DY[t.dir] * (3 + k), 2, 2, [15, 15, 15]);
  };
  // Phase 2: depots (orange outline), overwatch spots (magenta squares) with the firing line, hulls (dark, X)
  for (const d of ai.depots) {
    outline(d.def.rect[0] - 1, d.def.rect[1] - 1, d.def.rect[2] + 2, d.def.rect[3] + 2, [255, 170, 40], 0.9);
    for (const s of d.spots) outline((s % ai.nw) * 8, ((s / ai.nw) | 0) * 8, 16, 16, [255, 170, 40], 0.4);
  }
  const ow = ai.overwatch?.ow;
  if (ow) {
    for (const s of ow.history) outline((s % ai.nw) * 8 + 2, ((s / ai.nw) | 0) * 8 + 2, 12, 12, [255, 60, 255], 0.9);
    const p = w.players[0];
    const sx = (ow.spot % ai.nw) * 8 + 8;
    const sy = ((ow.spot / ai.nw) | 0) * 8 + 8;
    if (p && (Math.abs(p.cx - sx) < 8 || Math.abs(p.cy - sy) < 8)) {
      const n = Math.ceil(Math.hypot(p.cx - sx, p.cy - sy) / 3);
      for (let i = 0; i <= n; i += 2) put(sx + ((p.cx - sx) * i) / n, sy + ((p.cy - sy) * i) / n, [255, 60, 255], 0.8);
    }
  }
  for (const h of ai.hulls.values()) {
    tank(h.t, [70, 64, 58]);
    for (let k = 2; k < 14; k++) { put(h.t.x + k, h.t.y + k, [230, 60, 40]); put(h.t.x + 15 - k, h.t.y + k, [230, 60, 40]); }
  }
  for (const u of ai.units.values()) {
    if (!u.t.alive) continue;
    tank(u.t, u.mor ? [200, 255, 90] : u.retreat || u.g.phase === 'retreat' ? [140, 140, 140] : colOf(u.g));
  }
  for (const p of w.players) if (p?.alive) tank(p, [255, 240, 80]);
  for (const b of w.bullets) rect(b.x - 1, b.y - 1, 3, 3, [255, 255, 255]);
  // png
  const raw = Buffer.alloc((W * 3 + 1) * H);
  for (let y = 0; y < H; y++) {
    raw[y * (W * 3 + 1)] = 0;
    Buffer.from(img.buffer, y * W * 3, W * 3).copy(raw, y * (W * 3 + 1) + 1);
  }
  const chunk = (type: string, data: Buffer) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(td));
    return Buffer.concat([len, td, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(W, 0);
  ihdr.writeUInt32BE(H, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  mkdirSync('shots', { recursive: true });
  writeFileSync(file, Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]));
  console.log(`      wrote ${file}${note ? ` (${note})` : ''}`);
}
const CRC = new Uint32Array(256).map((_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
function crc32(b: Buffer): number {
  let c = 0xffffffff;
  for (const x of b) c = CRC[(c ^ x) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

// ---------------------------------------------------------------- scenarios
const small = build(SMALL);
console.log(`map ${small.w}x${small.h} cells, exits ${JSON.stringify(small.enemySpawns)}, spots ${small.towns!.map((t) => `${t.name}:${t.garrison.length}`).join(' ')}`);

/** Enemy bullets fired by members of group g (counted once each). */
function shotCounter(w: World, g: () => Group | undefined) {
  const seen = new WeakSet<object>();
  let n = 0;
  let first = -1;
  return {
    tick() {
      const gg = g();
      if (!gg) return;
      for (const b of w.bullets) {
        if (seen.has(b) || b.owner.isPlayer) continue;
        seen.add(b);
        if (gg.members.some((m) => m.t === b.owner)) { n++; if (first < 0) first = w.frame; }
      }
    },
    get n() { return n; },
    get first() { return first; },
  };
}

// (a) garrison holds
{
  reseed(11);
  const w = newWorld(small);
  const hist: Hist = [];
  run(w, 90);
  const ga = garrison(w, 'BRODKA');
  const gb = garrison(w, 'ZELENKO');
  const atSpots = (g?: Group) => !!g && g.members.length > 0 && g.members.every((u) => w.ai!.nodeOf(u.t) === u.spot);
  check('a1 garrisons manned at start', !!ga && !!gb && atSpots(ga) && atSpots(gb),
    `BRODKA ${ga?.members.length ?? 0} tanks, ZELENKO ${gb?.members.length ?? 0} tanks, all on their spots: ${atSpots(ga) && atSpots(gb)}`);
  const ring: [number, number][] = [[176, 176], [456, 176], [456, 440], [176, 440], [176, 176], [456, 176], [456, 440], [176, 440]];
  let leashBad = 0;
  let maxOut = 0;
  const shots = shotCounter(w, () => garrison(w, 'BRODKA'));
  let moved = 0;
  const pos0 = new Map(ga!.members.map((u) => [u, u.t.x * 10000 + u.t.y]));
  for (const [tx, ty] of ring) {
    run(w, 900, (ww) => pilot(ww, tx, ty), hist, () => {
      shots.tick();
      for (const g of [garrison(w, 'BRODKA'), garrison(w, 'ZELENKO')]) {
        if (!g) continue;
        const t = g.town!;
        for (const u of g.members) {
          const [x0, y0, x1, y1] = t.leash;
          if (u.t.x < x0 - 0.5 || u.t.y < y0 - 0.5 || u.t.x + 16 > x1 + 0.5 || u.t.y + 16 > y1 + 0.5) leashBad++;
          const [rx, ry, rw, rh] = t.def.rect;
          maxOut = Math.max(maxOut, rx - u.t.x, ry - u.t.y, u.t.x + 16 - rx - rw, u.t.y + 16 - ry - rh);
          if (pos0.has(u) && pos0.get(u) !== u.t.x * 10000 + u.t.y) moved++;
        }
      }
      const p = w.players[0];
      return !!p && Math.abs(p.x - tx) < 10 && Math.abs(p.y - ty) < 10;
    });
  }
  check('a2 garrison stays in town (+32 px leash)', leashBad === 0, `${leashBad} frames outside the leash; furthest past the town edge ${Math.max(0, maxOut).toFixed(0)} px`);
  check('a3 garrison engages a passing player', shots.n > 0, `${shots.n} shots by BRODKA while the player circled at ~60-80 px; repositioning frames ${moved}; help calls: ${w.radio.length}`);
  snap(w, 'shots/ai-garrison.png', hist, 'player (yellow) circling BRODKA; garrison dots stay inside the town');
  teleport(w, 552, 552);
  const back = run(w, 60 * 20, () => idle, undefined, () => atSpots(garrison(w, 'BRODKA')) && atSpots(garrison(w, 'ZELENKO')));
  check('a4 garrison returns to its spots', atSpots(garrison(w, 'BRODKA')), `back on spots ${sec(back)} after the player left`);
}

// (b) radio for help, column along the road
let columnSpec: { entry: [number, number] } | null = null;
{
  reseed(22);
  const w = newWorld(small);
  const hist: Hist = [];
  run(w, 90);
  const ga = garrison(w, 'BRODKA')!;
  // find a firing position in line with a garrison member
  let target: Unit | null = null;
  let spot: [number, number, number] | null = null;
  const p = w.players[0]!;
  outer: for (const u of ga.members) {
    for (let d = 0; d < 4; d++) {
      for (let dist = 64; dist <= 128; dist += 8) {
        const x = u.t.x - DX[d] * dist;
        const y = u.t.y - DY[d] * dist;
        if (x < 0 || y < 0 || x > w.pxW - 16 || y > w.pxH - 16 || w.blockedAt(p, x, y)) continue;
        let bricks = 0;
        let steel = false;
        for (let k = 8; k < dist; k += 4) {
          const c = w.map.at(Math.floor((x + 8 + DX[d] * k) / 4), Math.floor((y + 8 + DY[d] * k) / 4));
          if (c === BRICK) bricks++;
          if (c === STEEL) steel = true;
        }
        if (!steel && bricks === 0) { target = u; spot = [x, y, d]; break outer; }
      }
    }
  }
  let hitHow = 'shot';
  const f0 = w.frame;
  if (target && spot) {
    teleport(w, spot[0], spot[1]);
    p.dir = spot[2];
    const hp0 = target.t.hp;
    const n = run(w, 600, () => ({ dir: -1, fire: true }), hist, () => !target!.t.alive || target!.t.hp < hp0);
    if (n >= 600) { w.hitEnemy(target.t, 0); hitHow = 'forced'; }
  } else {
    w.hitEnemy(ga.members[0].t, 0);
    hitHow = 'forced (no clear firing spot)';
  }
  const fHit = w.frame;
  teleport(w, 552, 552);
  let g: Group | undefined;
  const fSpawn = run(w, 60 * 12, () => idle, hist, () => !!(g = assaults(w)[0])) + fHit;
  check('b1 shooting a garrison tank radios for help', radioHas(w, 'SEND HELP') && !!g,
    `hit by ${hitHow} after ${sec(fHit - f0)}; radio "${w.radio.find((m) => m.text.includes('SEND HELP'))?.text}"; assault ${g?.call} x${g?.size} entered at ${g?.entry} ${sec(fSpawn - fHit)} after the call`);
  check('b2 column tell on the radio', !!g && radioHas(w, `${g.call}: COLUMN MOVING ON BRODKA`), w.radio.map((m) => m.text).join(' | '));
  if (g) {
    columnSpec = { entry: g.entry };
    const gaps: number[] = [];
    let onRoad = 0;
    let samples = 0;
    let snapped = false;
    const t0 = w.frame;
    const n = run(w, 60 * 60, () => idle, hist, () => {
      if (g!.phase !== 'column') return true;
      if (w.frame % 30 === 0) {
        const L = live(g!);
        for (let i = 1; i < L.length; i++) gaps.push(Math.hypot(L[i].t.x - L[i - 1].t.x, L[i].t.y - L[i - 1].t.y));
        if (L[0]) {
          samples++;
          if (w.ai!.road[w.ai!.nodeOf(L[0].t)] >= 8) onRoad++;
        }
        if (!snapped && L.length >= Math.min(3, g!.size) && Math.hypot(L[0].t.x - g!.target[0], L[0].t.y - g!.target[1]) < 200) {
          snapped = true;
          snap(w, 'shots/ai-column.png', hist, `${g!.call} in column on the road, gaps ${gaps.slice(-3).map((x) => x.toFixed(0)).join('/')} px`);
        }
      }
    });
    const lead = live(g)[0];
    const dist = lead ? Math.hypot(lead.t.x - g.target[0], lead.t.y - g.target[1]) : -1;
    const mn = Math.min(...gaps);
    const avg = gaps.reduce((a, b) => a + b, 0) / Math.max(1, gaps.length);
    check('b3 column reaches the town along the road', g.phase !== 'column' && dist <= AI.deployR + 8 && onRoad / Math.max(1, samples) >= 0.8,
      `phase ${g.phase} after ${sec(n)} (from spawn ${sec(w.frame - t0)}), leader ${dist.toFixed(0)} px from the town centre, leader on road ${onRoad}/${samples} samples`);
    check('b4 column spacing', gaps.length > 0 && mn >= 20 && avg >= 24 && avg <= 44,
      `${gaps.length} gap samples: min ${mn.toFixed(0)} avg ${avg.toFixed(1)} max ${Math.max(...gaps).toFixed(0)} px (target 28)`);
  }
}

// (c) deploy into a line and engage
{
  reseed(33);
  const w = newWorld(small);
  const hist: Hist = [];
  run(w, 90);
  const ta = w.ai!.towns.find((t) => t.def.name === 'BRODKA')!;
  teleport(w, ta.def.cx - 8, ta.def.cy - 40);
  run(w, 40);
  const entered = radioHas(w, 'ENEMY TANK IN BRODKA');
  teleport(w, 552, 552);
  let g: Group | undefined;
  run(w, 60 * 12, () => idle, hist, () => !!(g = assaults(w)[0]));
  check('c1 player entering the town radios for help', entered && !!g, `radio "${w.radio[0]?.text}", assault ${g?.call} x${g?.size} from ${g?.entry}`);
  if (g) {
    // wait in the open on the column's road, ~150 px out from the town, 40 px off the road
    run(w, 150, () => idle, hist);
    const [ex, ey] = g.entry;
    const vx = Math.sign(ex - (ta.def.cx - 8));
    const vy = Math.sign(ey - (ta.def.cy - 8));
    const wx = ta.def.cx - 8 + vx * 150 + (vx === 0 ? 40 : 0);
    const wy = ta.def.cy - 8 + vy * 150 + (vy === 0 ? 40 : 0);
    teleport(w, wx, wy);
    const shots = shotCounter(w, () => g);
    let firstSee = -1;
    let formation = '';
    let lineOk = false;
    let advAt = -1;
    run(w, 60 * 30, () => idle, hist, () => {
      shots.tick();
      if (firstSee < 0 && g!.members.some((m) => m.sees)) firstSee = w.frame;
      if (advAt < 0 && g!.phase === 'advance') {
        advAt = w.frame;
        const L = live(g!);
        const vert = g!.adir === 0 || g!.adir === 2;
        const perp = L.map((m) => (vert ? m.t.x : m.t.y)).sort((a, b) => a - b);
        const along = L.map((m) => (vert ? m.t.y : m.t.x));
        const gaps = perp.slice(1).map((v, i) => v - perp[i]);
        lineOk = L.length >= 2 && gaps.every((x) => x >= 16) && Math.max(...along) - Math.min(...along) <= 40;
        formation = `${L.length} tanks, advancing ${'URDL'[g!.adir]}, side gaps ${gaps.map((x) => x.toFixed(0)).join('/')} px, depth ${(Math.max(...along) - Math.min(...along)).toFixed(0)} px`;
      }
      if (advAt > 0 && w.frame === advAt + 90) snap(w, 'shots/ai-deploy.png', hist, `${g!.call} in line abreast`);
      return advAt > 0 && w.frame > advAt + 60 * 8 && shots.n > 0;
    });
    check('c2 column deploys into a line abreast', lineOk, formation || `never advanced (phase ${g.phase})`);
    check('c3 line engages with a reaction delay', shots.n > 0 && firstSee > 0 && shots.first - firstSee >= AI.reactMin,
      `first shot ${shots.first - firstSee} frames after the first sighting (reaction ${AI.reactMin}-${AI.reactMax}), ${shots.n} shots; radio: ${w.radio.slice(-2).map((m) => m.text).join(' | ')}`);
  }
}

// (d) retreat when damaged / half the group lost
{
  let done = false;
  for (let seed = 44; seed < 70 && !done; seed++) {
    reseed(seed);
    const w = newWorld(small);
    const hist: Hist = [];
    run(w, 90);
    w.queue.unshift(3, 1, 0, 2);
    const ta = w.ai!.towns.find((t) => t.def.name === 'BRODKA')!;
    teleport(w, ta.def.cx - 8, ta.def.cy - 40);
    run(w, 40);
    teleport(w, 552, 552);
    let g: Group | undefined;
    run(w, 60 * 12, () => idle, hist, () => !!(g = assaults(w)[0]));
    if (!g || g.size < 3) continue;
    done = true;
    run(w, 60 * 60, () => idle, hist, () => live(g!).length >= 3 && g!.members.every((m) => m.t.spawn === 0));
    const armour = g.members.find((m) => m.t.etype === 3)!;
    const exitPx = [(g.exitNode % w.ai!.nw) * 8, ((g.exitNode / w.ai!.nw) | 0) * 8];
    // (the crew may bail at 1 hp, AI.bailChance: that has its own check below, so not here, whatever the dice say)
    const bail0 = AI.bailChance;
    AI.bailChance = 0;
    for (let i = 0; i < 3; i++) w.hitEnemy(armour.t, 0);
    run(w, 12, () => idle, hist);
    AI.bailChance = bail0;
    const d0 = Math.hypot(armour.t.x - exitPx[0], armour.t.y - exitPx[1]);
    check('d1 armour at 1 hp pulls back', armour.retreat && radioHas(w, 'PULLING BACK'), `${g.call}-${armour.idx + 1} hp ${armour.t.hp}, retreat ${armour.retreat}, ${d0.toFixed(0)} px from its exit; radio "${w.radio[w.radio.length - 1]?.text}"`);
    const esc0 = w.ai!.stats.escaped;
    const q0 = w.queue.length;
    const n1 = run(w, 60 * 40, () => idle, hist, () => armour.gone);
    const st = armour.gone ? '' : ` [at ${armour.t.x},${armour.t.y} order ${w.ai!.orderName(armour)} want ${armour.want} exit node ${armour.exitNode % w.ai!.nw},${(armour.exitNode / w.ai!.nw) | 0} alive ${armour.t.alive} stun ${armour.t.stun} spawn ${armour.t.spawn} phase ${g.phase}]`;
    check('d2 damaged tank drives off the map', armour.gone, `left after ${sec(n1)}${st}; escaped ${w.ai!.stats.escaped - esc0}, queue ${q0} -> ${w.queue.length}`);
    // kill half the group: the rest falls back
    const rest = live(g).filter((m) => !m.retreat);
    let k = 0;
    // (losses are counted on the next update, so count the kills here)
    while ((g.lost + k) * 2 < g.size && k < rest.length) w.killEnemy(rest[k++].t, 0);
    const left = live(g).filter((m) => !m.gone && m.t.alive);
    run(w, 12, () => idle, hist);
    let snapped = false;
    const n2 = run(w, 60 * 60, () => idle, hist, () => {
      if (!snapped && w.frame % 60 === 0 && g!.phase === 'retreat') { snapped = true; snap(w, 'shots/ai-retreat.png', hist, `${g!.call} falling back (grey)`); }
      return left.every((m) => m.gone);
    });
    check('d3 group that lost half falls back', g.phase === 'retreat' && radioHas(w, 'FALLING BACK') && left.every((m) => m.gone),
      `size ${g.size}, lost ${g.lost}, ${left.length} survivor(s) ${left.every((m) => m.gone) ? `left the map after ${sec(n2)}` : 'still on the map'}`);
  }
  if (!done) check('d retreat', false, 'no seed gave a 3+ tank group');
}

// (e) trees hide the player
{
  reseed(55);
  const w = newWorld(small);
  run(w, 90);
  const ai = w.ai!;
  const probe = (x: number, y: number) => {
    const t = new Tank();
    t.x = x;
    t.y = y;
    return t;
  };
  const pl = probe(392, 168); // in the clump at cells (100,44)
  const res: string[] = [];
  let ok = ai.inTrees(pl);
  for (const d of [32, 40, 56, 80, 120, 150]) {
    const seen = ai.perceives(probe(392 - d, 168), pl);
    res.push(`${d}px:${seen ? 'seen' : 'hidden'}`);
    if (seen !== d <= AI.sightTrees) ok = false;
  }
  const open = probe(392, 216);
  const res2: string[] = [];
  for (const d of [56, 120, 150, 170]) {
    const seen = ai.perceives(probe(392 - d, 216), open);
    res2.push(`${d}px:${seen ? 'seen' : 'hidden'}`);
    if (seen !== d <= AI.sight) ok = false;
  }
  const hedge = ai.perceives(probe(240, 380), probe(240, 470));
  check('e1 sight: trees hide beyond 48 px, open ground 160 px, thick hedgerow screens', ok && !hedge,
    `in trees ${res.join(' ')} | in the open ${res2.join(' ')} | across a 16 px hedgerow at 90 px: ${hedge ? 'seen' : 'hidden'}`);
  // live: hide in the clump next to ZELENKO, then step out
  teleport(w, 392, 168);
  const s0 = ai.stats.shots;
  let seenFrames = 0;
  let nearest = Infinity;
  run(w, 600, () => idle, undefined, () => {
    for (const u of ai.units.values()) {
      if (u.sees) seenFrames++;
      nearest = Math.min(nearest, Math.hypot(u.t.cx - 400, u.t.cy - 176));
    }
  });
  check('e2 hidden in trees: not seen, not shot at', seenFrames === 0 && ai.stats.shots === s0,
    `10 s in the trees, nearest garrison tank ${nearest.toFixed(0)} px, frames seen ${seenFrames}, shots ${ai.stats.shots - s0}`);
  // step out into the open where some ZELENKO tank has a line
  const gb = garrison(w, 'ZELENKO')!;
  const p = w.players[0]!;
  let out: [number, number] | null = null;
  for (let y = 64; y <= 240 && !out; y += 8) {
    for (let x = 344; x <= 440 && !out; x += 8) {
      if (w.blockedAt(p, x, y) || ai.inTrees(probe(x, y))) continue;
      if (gb.members.some((u) => { const d = Math.hypot(u.t.x - x, u.t.y - y); return d > 64 && ai.perceives(u.t, probe(x, y)); })) out = [x, y];
    }
  }
  if (out) {
    teleport(w, out[0], out[1]);
    const n = run(w, 120, () => idle, undefined, () => gb.members.some((u) => u.sees));
    check('e3 stepping out of the trees is seen', n < 120, `seen ${sec(n)} after stepping out at ${out}`);
  } else {
    check('e3 stepping out of the trees is seen', false, 'no open spot with a line to ZELENKO');
  }
}

// (f) free play: bot fights for 3 minutes; no stuck tanks, no exceptions
{
  reseed(66);
  const w = newWorld(small);
  const hist: Hist = [];
  run(w, 60 * 180, (ww) => regionBot(ww), hist);
  const s = w.ai!.stats;
  check('f1 free play runs clean', G.exceptions === 0,
    `3 min bot vs AI: spawned ${s.spawned}, killed ${s.killed}, escaped ${s.escaped}, assaults ${s.assaults}, enemy shots ${s.shots}, max engaging ${s.maxEngaged}, radio lines ${w.radio.length}`);
  snap(w, 'shots/ai-freeplay.png', hist.slice(-3000), 'last ~50 s of a bot free-play run');
}

// ================================================================ Phase 2
/** Tunables a scenario changes, put back after it. */
function withAI<T>(over: Partial<typeof AI>, fn: () => T): T {
  const old: Record<string, unknown> = {};
  for (const k of Object.keys(over)) old[k] = (AI as Record<string, unknown>)[k];
  Object.assign(AI, over);
  try {
    return fn();
  } finally {
    Object.assign(AI, old);
  }
}
const NEVER = 1e9;
/** Remove a group's tanks without a fight (no help calls, no losses counted). */
function quietKill(g?: Group): void {
  if (!g) return;
  for (const u of [...g.members]) { u.gone = true; u.t.alive = false; }
}
/** Clear a town's garrison quietly, then sit on the flag until it is freed. Returns frames taken. */
function freeByFlag(w: World, name: string): number {
  const ts = w.towns.find((t) => t.name === name)!;
  quietKill(garrison(w, name));
  run(w, 12);
  teleport(w, ts.cx - 8, ts.cy - 8);
  return run(w, 60 * 15, () => idle, undefined, () => ts.freed);
}
/** Trigger a column on BRODKA (player drives into the town, then leaves) and wait for all its tanks. */
function columnOnBrodka(w: World, hist?: Hist): Group | undefined {
  const ta = w.ai!.towns.find((t) => t.def.name === 'BRODKA')!;
  teleport(w, ta.def.cx - 8, ta.def.cy - 40);
  run(w, 40);
  teleport(w, 552, 552);
  let g: Group | undefined;
  run(w, 60 * 12, () => idle, hist, () => !!(g = assaults(w)[0]));
  if (g) run(w, 60 * 40, () => idle, hist, () => !g!.pending.length && live(g!).length === g!.size);
  return g;
}
const DEPOT_LAYOUT: Layout = { ...SMALL, name: 'AI DEPOT', depots: [{ name: 'FUEL DUMP 7', rect: [48, 184, 64, 64] }] };
const depotMap = build(DEPOT_LAYOUT);

// (h) counterattack: not while the player is in the town; sets off when they leave; retakes the empty town
withAI({ owFirstMin: NEVER, owFirstMax: NEVER }, () => {
  reseed(88);
  const w = newWorld(small);
  const hist: Hist = [];
  run(w, 90);
  const A = w.ai!;
  const tb = A.towns.find((t) => t.def.name === 'BRODKA')!;
  const ts = tb.state!;
  const nFree = freeByFlag(w, 'BRODKA');
  const f0 = w.frame;
  let inside = false;
  run(w, AI.counterMax + 60 * 10, () => idle, hist, () => { if (A.counter) inside = true; });
  check('h1 no counterattack while the player is in the town', ts.freed && !inside && w.frame > tb.counterAt,
    `freed in ${sec(nFree)}; due ${sec(tb.counterAt - f0)} after freeing; waited ${sec(w.frame - f0)} on the flag: ${inside ? 'LAUNCHED' : 'none launched'}`);
  teleport(w, 552, 552);
  const log0 = A.log.length;
  let g: Group | null = null;
  const nL = run(w, 60 * 10, () => idle, hist, () => !!(g = A.counter));
  const ev = A.log.slice(log0);
  const gg = g as Group | null;
  check('h2 counterattack sets off once the player leaves, with tells', !!gg && radioHas(w, `${gg.call}: MOVING TO RETAKE BRODKA`) && ev.some((l) => l.includes('SFX column')),
    `${sec(nL)} after leaving: ${gg ? `${gg.call} x${gg.size} (1 town freed) from ${gg.entry}` : 'none'}; radio "${w.radio.find((m) => m.text.includes('RETAKE'))?.text}"; ${ev.filter((l) => l.includes('SFX')).length} rumble(s)`);
  if (gg) {
    let snapped = false;
    const t0 = w.frame;
    const nR = run(w, 60 * 120, () => idle, hist, () => {
      if (!snapped && gg.holdT >= 300) { snapped = true; snap(w, 'shots/ai-counter.png', hist, `${gg.call} holding the BRODKA flag (${gg.holdT} frames)`); }
      return !ts.freed;
    });
    const gar = garrison(w, 'BRODKA');
    check('h3 counterattack holds the flag 10 s and retakes the empty town', !ts.freed && ts.progress === 0 && radioHas(w, 'BRODKA IS THEIRS AGAIN') && !!gar && gar.members.length >= 1 && gar.members.length <= AI.retakeKeep,
      `retaken ${sec(nR)} after setting off (size ${gg.size}); new garrison ${gar?.call} x${gar?.members.length}; radio "${w.radio.find((m) => m.who === 'SPANNER' && m.text.includes('AGAIN'))?.text}"`);
    check('h4 counter size scales with towns freed', gg.size === 2, `1 town freed -> ${gg.size} tanks (2-4)`);
    run(w, 60 * 15, () => idle, hist);
    snap(w, 'shots/ai-retake.png', hist.filter((_, i) => i > hist.length - 2500), 'BRODKA retaken: new garrison on its spots');
    const gar2 = garrison(w, 'BRODKA');
    check('h5 retaken town is held again', !!gar2 && gar2.members.every((u) => w.ai!.nodeOf(u.t) === u.spot || u.aware) && w.frame - t0 > 0,
      `garrison ${gar2?.members.map((u) => `${u.t.x},${u.t.y}`).join(' ')} on spots`);
  }
});

// (i) the player defending inside the town stops the flip
withAI({ owFirstMin: NEVER, owFirstMax: NEVER }, () => {
  reseed(99);
  const w = newWorld(small);
  const hist: Hist = [];
  run(w, 90);
  const A = w.ai!;
  freeByFlag(w, 'ZELENKO');
  freeByFlag(w, 'BRODKA');
  teleport(w, 552, 552);
  let g: Group | null = null;
  run(w, AI.counterMax + 60 * 20, () => idle, hist, () => !!(g = A.counter));
  const gg = g as Group | null;
  if (!gg) { check('i1 defending the town stops the flip', false, 'no counterattack'); return; }
  const t = gg.town!;
  // back on the flag as the column arrives, and stay
  teleport(w, t.def.cx - 8, t.def.cy - 8);
  const shots = shotCounter(w, () => gg);
  let maxHold = 0;
  let near = 0;
  run(w, 60 * 90, () => idle, hist, () => {
    shots.tick();
    maxHold = Math.max(maxHold, gg.holdT);
    if (live(gg).some((m) => Math.hypot(m.t.cx - t.def.cx, m.t.cy - t.def.cy) < 120)) near++;
  });
  check('i1 defending the town stops the flip', !!t.state?.freed && maxHold === 0 && near > 0 && !radioHas(w, 'THEIRS AGAIN'),
    `${gg.call} x${gg.size} on ${t.def.name} (2 towns freed); 90 s with the player on the flag: frames within 120 px ${near}, shots ${shots.n}, flag hold ${maxHold}, town freed ${t.state?.freed}`);
  check('i2 counter size scales with towns freed', gg.size === 3, `2 towns freed -> ${gg.size} tanks`);
  snap(w, 'shots/ai-defend.png', hist.slice(-3000), `${gg.call} fighting the player on the ${t.def.name} flag`);
});

// (j) overwatch: long-range spot, glint + radio, 2-3 shots, then moves to another spot
withAI({ counterMin: NEVER, counterMax: NEVER }, () => {
  reseed(111);
  const w = newWorld(small);
  const hist: Hist = [];
  run(w, 90);
  const A = w.ai!;
  freeByFlag(w, 'BRODKA');
  const P: [number, number] = [88, 120];
  teleport(w, P[0], P[1]);
  const p = w.players[0]!;
  let g: Group | null = null;
  const n0 = run(w, 60 * 60, () => idle, hist, () => !!(g = A.overwatch));
  const gg = g as Group | null;
  if (!gg || !gg.ow) { check('j1 overwatch picks a long-range spot', false, 'no overwatch'); return; }
  const ow = gg.ow;
  const spotPx = (n: number): [number, number] => [(n % A.nw) * 8, ((n / A.nw) | 0) * 8];
  const s1 = ow.spot;
  const [sx, sy] = spotPx(s1);
  const d1 = Math.hypot(sx + 8 - p.cx, sy + 8 - p.cy);
  const aligned = Math.abs(sx + 8 - p.cx) < 8 || Math.abs(sy + 8 - p.cy) < 8;
  check('j1 overwatch picks a long-range spot in line with the player', d1 >= 140 && d1 <= 204 && aligned,
    `${gg.call} set off ${sec(n0)} after BRODKA was freed: spot ${sx},${sy}, ${d1.toFixed(0)} px from the player, in line ${aligned}`);
  const shots = shotCounter(w, () => gg);
  const glint0 = A.stats.glints;
  let arrived = -1;
  let firstAim = -1;
  const atSpot1: number[] = [];
  let snapped = false;
  run(w, 60 * 60, () => idle, hist, () => {
    const before = shots.n;
    shots.tick();
    const u = gg.members[0];
    if (arrived < 0 && gg.phase === 'set') arrived = w.frame;
    if (firstAim < 0 && ow.aimAt >= 0) firstAim = ow.aimAt;
    if (shots.n > before && u && A.nodeOf(u.t) === s1) atSpot1.push(w.frame);
    if (!snapped && atSpot1.length >= 2) { snapped = true; snap(w, 'shots/ai-overwatch.png', hist, `${gg.call} firing from its spot (magenta line)`); }
    return ow.spot !== s1 || gg.phase === 'leave';
  });
  check('j2 radio + glint tell, then 2-3 aimed shots from the spot', arrived > 0 && radioHas(w, `${gg.call}: OVERWATCH ON THE`) && A.stats.glints > glint0 && atSpot1.length >= 2 && atSpot1.length <= 3 && atSpot1[0] - firstAim >= AI.owReactMin,
    `settled ${arrived > 0 ? sec(arrived - n0) : '-'}; radio "${w.radio.find((m) => m.text.includes('OVERWATCH'))?.text}"; glints ${A.stats.glints - glint0}; ${atSpot1.length} shots from the spot, first ${atSpot1[0] - firstAim} frames after the aim glint`);
  const s2 = ow.spot;
  const [x2, y2] = spotPx(s2);
  const moved = Math.hypot(x2 - sx, y2 - sy);
  const shotsBefore = shots.n;
  const n2 = run(w, 60 * 40, () => idle, hist, () => { shots.tick(); return gg.phase === 'set' && shots.n > shotsBefore; });
  check('j3 shoot and scoot: moves 48+ px to a new spot and fires again', s2 !== s1 && moved >= 48 && gg.phase === 'set' && shots.n > shotsBefore,
    `new spot ${x2},${y2} (${moved.toFixed(0)} px from the first, ${Math.hypot(x2 + 8 - p.cx, y2 + 8 - p.cy).toFixed(0)} px from the player), firing again after ${sec(n2)}; moves ${ow.moves}`);
  snap(w, 'shots/ai-overwatch-move.png', hist, `${gg.call} at its second spot`);
});

// (k) morale: a damaged tank pulls back to the depot, repairs ~20 s, returns to duty; a beaten group falls back there
withAI({ depotChance: 1, bailChance: 0, owFirstMin: NEVER, owFirstMax: NEVER }, () => {
  reseed(122);
  const w = newWorld(depotMap);
  const hist: Hist = [];
  run(w, 90);
  const A = w.ai!;
  w.queue.unshift(3, 0, 1);
  const g = columnOnBrodka(w, hist);
  const arm = g?.members.find((m) => m.t.etype === 3);
  if (!g || !arm) { check('k1 damaged armour pulls back to the depot', false, 'no group with an armour tank'); return; }
  const D = A.depots[0];
  const [rx, ry, rw, rh] = D.def.rect;
  w.hitEnemy(arm.t, 0);
  w.hitEnemy(arm.t, 0);
  run(w, 12, () => idle, hist);
  check('k1 damaged armour (2 hp) pulls back to the depot', arm.mor === 1 && radioHas(w, 'PULLING BACK TO FUEL DUMP 7'),
    `${g.call}-${arm.idx + 1} hp ${arm.t.hp}, morale ${arm.mor}; radio "${w.radio[w.radio.length - 1]?.text}"`);
  const nA = run(w, 60 * 60, () => idle, hist, () => arm.mor === 2);
  const inside = arm.t.x >= rx && arm.t.y >= ry && arm.t.x + 16 <= rx + rw && arm.t.y + 16 <= ry + rh;
  snap(w, 'shots/ai-morale.png', hist, `${g.call}-${arm.idx + 1} repairing inside FUEL DUMP 7 (lime)`);
  const r0 = w.frame;
  const nR = run(w, 60 * 40, () => idle, hist, () => arm.mor === 0);
  check('k2 it repairs inside the depot for ~20 s', inside && Math.abs(nR - AI.repairT) <= 12 && arm.t.hp === 4,
    `reached the depot after ${sec(nA)} (inside walls: ${inside}), repaired for ${sec(w.frame - r0)}, hp ${arm.t.hp}`);
  run(w, 60 * 20, () => idle, hist);
  const away = Math.hypot(arm.t.cx - D.def.cx, arm.t.cy - D.def.cy);
  check('k3 then returns to duty', arm.t.alive && !arm.retreat && !arm.mor && away > 48 && radioHas(w, 'REPAIRED'),
    `20 s later ${away.toFixed(0)} px from the depot, group ${arm.g.call} ${arm.g.job}/${arm.g.phase}; radio "${w.radio.filter((m) => m.text.includes('REPAIRED')).pop()?.text}"`);
  // a fresh column that loses half: the survivors fall back to the depot, not off the map
  const g2 = (A as unknown as { launchAssault(x: number, y: number, t: unknown, n: number): Group | null }).launchAssault(304, 304, null, 3);
  if (!g2) { check('k4 beaten group falls back to the depot', false, 'no second column'); return; }
  run(w, 60 * 40, () => idle, hist, () => !g2.pending.length && live(g2).length === g2.size);
  w.killEnemy(live(g2)[0].t, 0);
  w.killEnemy(live(g2)[1].t, 0);
  run(w, 30, () => idle, hist);
  const surv = live(g2);
  check('k4 a group that lost half falls back to the depot', g2.phase === 'retreat' && surv.length === 1 && surv[0].mor === 1 && radioHas(w, `${g2.call}: TOO HOT. FALLING BACK TO FUEL DUMP 7`),
    `${g2.call} lost 2/3, survivor morale ${surv[0]?.mor} (1 = to depot); radio "${w.radio.filter((m) => m.text.includes('TOO HOT')).pop()?.text}"`);
});

// (l) abandoned tank: crew bails at 1 hp, the hull sits dark for 60 s; driving into it captures it
withAI({ bailChance: 1, depotChance: 0, owFirstMin: NEVER, owFirstMax: NEVER }, () => {
  reseed(133);
  const w = newWorld(small);
  const hist: Hist = [];
  run(w, 90);
  const A = w.ai!;
  w.queue.unshift(3, 0);
  const g = columnOnBrodka(w, hist);
  const arm = g?.members.find((m) => m.t.etype === 3);
  if (!g || !arm) { check('l1 crew bails', false, 'no armour tank'); return; }
  const t = arm.t;
  for (let i = 0; i < 3; i++) w.hitEnemy(t, 0);
  run(w, 12, () => idle, hist);
  const hx = t.x;
  const hy = t.y;
  const hullShots = shotCounter(w, () => ({ members: [{ t }] }) as unknown as Group);
  run(w, 180, () => idle, hist, () => { hullShots.tick(); });
  check('l1 crew bails at 1 hp: hull stops, not hostile', A.isHull(t) && !A.units.has(t) && t.alive && t.x === hx && t.y === hy && hullShots.n === 0 && radioHas(w, "CREW BAILED. SHE'S YOURS IF YOU WANT HER."),
    `hp ${t.hp}, hull ${A.isHull(t)}, still at ${t.x},${t.y} after 3 s, shots ${hullShots.n}; radio "${w.radio.filter((m) => m.who === 'SPANNER').pop()?.text}"`);
  const p = w.players[0]!;
  const blocks = w.blockedAt(p, hx + 8, hy) && w.blockedAt(p, hx, hy + 8);
  snap(w, 'shots/ai-hull.png', hist, 'abandoned hull (dark with a red X) on the road');
  // drive into it
  const pick0 = w.pickups.length;
  // the run flow (world.collectHulls) empties ai.capturedHulls in the same update it is filled, so record what the
  // director pushes and also read the durable counters: ai.stats.captured and the world's found parts
  const pushed: (typeof A.capturedHulls)[number][] = [];
  A.capturedHulls.push = (...items) => { pushed.push(...items); return Array.prototype.push.apply(A.capturedHulls, items); };
  const cap0 = A.stats.captured;
  const found0 = w.found.length;
  const parts0 = w.partsFound;
  // pull up beside it (the rest of the column is still about), then drive into its side
  teleport(w, Math.round(hx / 8) * 8 + 32, Math.round(hy / 8) * 8);
  const nC = run(w, 60 * 40, (ww) => ({ dir: ww.players[0] && ww.players[0].cx > t.cx ? 3 : 1, fire: false }), hist, () => A.stats.captured > cap0);
  const c = pushed[0];
  const stripped = w.partsFound === parts0 + 1 && w.found.length === found0 + 1 && A.capturedHulls.length === 0;
  check('l2 hull blocks tanks; driving into it captures it (event recorded)', blocks && A.stats.captured === cap0 + 1 && pushed.length === 1 && !!c && c.kind === 'captured' && c.etype === 3 && c.player === 0 && stripped && !t.alive && !A.isHull(t) && w.popups.some((q) => q.text === '+CAPTURED') && w.pickups.length === pick0,
    `blocks movement ${blocks}; captured after ${sec(nC)}: ${JSON.stringify(c)}; stats.captured ${A.stats.captured - cap0}, stripped into the bin ${stripped} (${w.found.slice(found0).join(',')}); hull removed ${!t.alive}, no wreck loot ${w.pickups.length === pick0}` +
    (c ? '' : ` [player ${w.players[0]?.x},${w.players[0]?.y} dir ${w.players[0]?.dir} moving ${w.players[0]?.moving}, hull ${hx},${hy}]`));
  // a second hull nobody touches is scuttled after 60 s
  w.queue.unshift(3);
  const g2 = (A as unknown as { launchAssault(x: number, y: number, t: unknown, n: number): Group | null }).launchAssault(304, 304, null, 2);
  run(w, 60 * 40, () => idle, hist, () => !!g2 && !g2.pending.length && live(g2).some((m) => m.t.etype === 3));
  const arm2 = g2 && live(g2).find((m) => m.t.etype === 3);
  if (!arm2) { check('l3 untouched hull is scuttled after 60 s', false, 'no second armour tank'); return; }
  teleport(w, 552, 552);
  for (let i = 0; i < 3; i++) w.hitEnemy(arm2.t, 0);
  run(w, 12, () => idle, hist);
  const sc0 = A.stats.scuttled;
  const capS = A.stats.captured;
  const pushS = pushed.length;
  const nS = run(w, AI.hullT + 120, () => idle, hist, () => !arm2.t.alive);
  check('l3 untouched hull is scuttled after 60 s', A.stats.scuttled === sc0 + 1 && A.stats.captured === capS && pushed.length === pushS && Math.abs(nS - AI.hullT) < 20,
    `gone after ${sec(nS)}; captures meanwhile ${A.stats.captured - capS} (events ${pushed.length - pushS})`);
});

// (m) ease (w.ease after retreats) slows reactions and lowers the engagement cap
{
  const play = (ease: number) => {
    reseed(144);
    const w = newWorld(small);
    w.ease = ease;
    const last = new Map<Unit, number>();
    const reacts: number[] = [];
    run(w, 60 * 180, (ww) => regionBot(ww), undefined, () => {
      for (const u of w.ai!.units.values()) {
        if (!u.aware || u.g.job === 'overwatch') continue;
        if (last.get(u) !== u.react || !last.has(u)) { reacts.push(u.react); last.set(u, u.react); }
      }
    });
    const mean = reacts.reduce((a, b) => a + b, 0) / Math.max(1, reacts.length);
    return { mean, n: reacts.length, cap: w.ai!.engageCap(), maxEng: w.ai!.stats.maxEngaged };
  };
  const e0 = play(0);
  const e3 = play(0.3);
  check('m1 ease slows reactions and lowers the engage cap', e0.n > 5 && e3.n > 5 && e3.mean >= e0.mean * 1.4 && e0.cap === 6 && e3.cap === 4 && e3.maxEng <= 4,
    `ease 0: reaction avg ${e0.mean.toFixed(1)} frames (${e0.n} samples), cap ${e0.cap}, max engaged ${e0.maxEng} | ease 0.3: ${e3.mean.toFixed(1)} frames (${e3.n}), cap ${e3.cap}, max engaged ${e3.maxEng}`);
}

// (g) perf on a 260x208-cell region with ~12 enemies
const big = build(BIG);
const bigDepot = build({ ...BIG, depots: [{ name: 'TANK PARK 2', rect: [752, 488, 64, 64] }] });
for (const mode of ['wander', 'bot', 'phase2'] as const) {
  // wander: the player drives a loop past every town without firing, so ~12 enemies stay alive and engage;
  // bot: the autopilot fights (kills, help calls, assaults, retreats)
  // phase2: two towns already freed, quick counterattacks and overwatch, a depot, crews that bail more often
  reseed(77);
  const old = { startTowns: AI.startTowns, counterMin: AI.counterMin, counterMax: AI.counterMax, counterGap: AI.counterGap, owFirstMin: AI.owFirstMin, owFirstMax: AI.owFirstMax, owGapMin: AI.owGapMin, owGapMax: AI.owGapMax, bailChance: AI.bailChance };
  AI.startTowns = 9;
  if (mode === 'phase2') Object.assign(AI, { counterMin: 600, counterMax: 900, counterGap: 900, owFirstMin: 300, owFirstMax: 300, owGapMin: 600, owGapMax: 600, bailChance: 0.5 });
  const w = newWorld(mode === 'phase2' ? bigDepot : big);
  if (mode === 'phase2') {
    run(w, 30);
    for (const name of ['ZELENKO', 'LUKIVTSI']) {
      quietKill(garrison(w, name));
      w.freeTown(w.towns.find((t) => t.name === name)!);
    }
  }
  let upd = 0;
  let updMax = 0;
  let aliveSum = 0;
  let aliveMax = 0;
  const N = 60 * 120;
  const hist: Hist = [];
  const loop: [number, number][] = [[880, 560], [640, 280], [560, 120], [360, 260], [200, 520], [520, 720], [880, 560]];
  let wp = 0;
  for (let i = 0; i < N; i++) {
    let inp: PInput;
    if (mode !== 'wander') inp = regionBot(w);
    else {
      const p = w.players[0];
      if (p && Math.hypot(p.x - loop[wp][0], p.y - loop[wp][1]) < 12) wp = (wp + 1) % loop.length;
      inp = pilot(w, loop[wp][0], loop[wp][1]);
    }
    const t0 = performance.now();
    step(w, inp, hist);
    const dt = performance.now() - t0;
    if (i > 60) { upd += dt; updMax = Math.max(updMax, dt); }
    aliveSum += w.enemies.length;
    aliveMax = Math.max(aliveMax, w.enemies.length);
  }
  Object.assign(AI, old);
  const s = w.ai!.stats;
  const n = N - 61;
  const p2 = mode === 'phase2' ? ` | counters ${s.counters} retakes ${s.retakes} overwatch ${s.overwatches} (${s.owShots} shots, ${s.owMoves} moves) to depot ${s.toDepot} repaired ${s.repaired} bails ${s.bails} captured ${s.captured} scuttled ${s.scuttled}` : '';
  check(`g ${mode} perf 260x208 cells`, (s.msSum + s.driveMs) / s.n < 0.5 && (mode !== 'phase2' || (s.counters > 0 && s.overwatches > 0)),
    `${p2 ? `${p2.slice(3)} | ` : ''}enemies avg ${(aliveSum / N).toFixed(1)} max ${aliveMax}, max engaging ${s.maxEngaged}, shots ${s.shots}, kills ${s.killed} | world.update avg ${(upd / n).toFixed(3)} ms max ${updMax.toFixed(2)} ms | ` +
    `AI avg ${((s.msSum + s.driveMs) / s.n).toFixed(3)} ms/update (director ${(s.msSum / s.n).toFixed(3)}, steering ${(s.driveMs / s.n).toFixed(3)}), director max ${s.msMax.toFixed(2)} ms | ` +
    `${s.fields} field computes avg ${(s.fieldMs / Math.max(1, s.fields)).toFixed(2)} ms | flowP ${w.flowMs.toFixed(2)} ms`);
  snap(w, `shots/ai-perf-${mode}.png`, hist.slice(-4000), `perf region (${mode}), last ~40 s`);
}

// (n) gentle start (Farmland, Winter Front): no column in the first 60 s, garrison spots 200+ px from the spawn
{
  reseed(33);
  const w = newWorld(small);
  w.ai!.gentleOff = false;
  run(w, 90);
  const ta = w.ai!.towns.find((t) => t.def.name === 'BRODKA')!;
  teleport(w, ta.def.cx - 8, ta.def.cy - 40);
  run(w, 40);
  const called = radioHas(w, 'ENEMY TANK IN BRODKA');
  teleport(w, 552, 552);
  run(w, 60 * 40);
  const early = w.ai!.stats.assaults;
  const fEarly = w.frame;
  const sp = w.region!.playerSpawns;
  const near = w.enemies.filter((e) => sp.some(([sx, sy]) => Math.hypot(sx - e.x, sy - e.y) < AI.gentleSpawnR)).length;
  run(w, 60 * 40);
  check('n1 gentle start: help called but no column before 60 s, one comes after', called && early === 0 && w.ai!.stats.assaults > 0,
    `called ${called}, assaults at ${sec(fEarly)}: ${early}, at ${sec(w.frame)}: ${w.ai!.stats.assaults}; enemies within ${AI.gentleSpawnR} px of a spawn at 40 s: ${near}`);
}

// 6 s limit: short back-and-forth jostling (one tank at 5.3 s after the 2026-10-16 diagonal boss shells changed the timeline) isn't a stuck tank
check('f2 no stuck tanks (all scenarios)', G.maxStill <= 360 && G.exceptions === 0, `longest time wanting to move without getting 12 px further: ${sec(G.maxStill)} (${G.stillWho || 'none'}); exceptions ${G.exceptions}`);

console.log(`\n${fails ? `${fails} FAILED` : 'all passed'} (${G.frames} frames simulated)`);
if (fails) process.exitCode = 1;
