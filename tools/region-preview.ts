// Draws a campaign region to a PNG at 1 px per game px, with towns, depots, roads, garrison spots, spawns and
// flags marked (plus the rail line, the river route and the lair hint of Phase 4 regions), so the layout can be
// eyeballed.
// Build + run: npx vite build --ssr tools/region-preview.ts --outDir dist-sim && node dist-sim/region-preview.js [seed ...]
//   [kind] = farm | rail | delta | ruins | winter (default farm), or 'all' for every kind.
// Writes shots/<kind>-<seed>.png for each seed (default 1 2 3).
import { deflateSync } from 'node:zlib';
import { mkdirSync, writeFileSync } from 'node:fs';
import { REGION_KINDS, makeRegion, type RegionKind } from '../src/game/region';
import { FONT } from '../src/art/font';

type C3 = [number, number, number];
const COL: C3[] = [
  [118, 150, 74], // ground
  [190, 96, 40], // brick
  [150, 156, 166], // steel
  [40, 90, 170], // water
  [36, 98, 40], // trees
  [190, 225, 240], // ice
  [184, 150, 100], // road
  [70, 62, 58], // rail
];

// ground kinds (GK_* in constants.ts) on open ground
const KCOL: C3[] = [
  [118, 150, 74], [176, 138, 92], [150, 150, 146], [96, 132, 60], [196, 170, 92], [214, 190, 50], [128, 130, 132], [150, 128, 100], [188, 176, 160], [92, 80, 66],
];

function render(kind: RegionKind, seed: number): void {
  const t0 = performance.now();
  const spec = makeRegion(kind, seed);
  const ms = performance.now() - t0;
  const S = 4;
  const W = spec.w * S;
  const H = spec.h * S;
  const px = new Uint8Array(W * H * 3);
  const put = (x: number, y: number, c: C3, a = 1) => {
    x = Math.round(x);
    y = Math.round(y);
    if (x < 0 || y < 0 || x >= W || y >= H) return;
    const i = (y * W + x) * 3;
    for (let k = 0; k < 3; k++) px[i + k] = Math.round(px[i + k] * (1 - a) + c[k] * a);
  };
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const t = spec.cells[((y / S) | 0) * spec.w + ((x / S) | 0)];
      const gk = t === 0 ? (spec.kinds?.[((y / S) | 0) * spec.w + ((x / S) | 0)] ?? 0) & 15 : 0;
      const c = gk ? KCOL[gk] ?? [255, 0, 255] : COL[t] ?? [255, 0, 255];
      // faint 8 px checker so the tank grid can be read
      const k = ((x >> 3) + (y >> 3)) & 1 ? 1 : 0.94;
      put(x, y, [c[0] * k, c[1] * k, c[2] * k]);
    }
  }
  const rect = (x: number, y: number, w: number, h: number, c: C3, a = 1) => {
    for (let i = 0; i < w; i++) { put(x + i, y, c, a); put(x + i, y + h - 1, c, a); }
    for (let j = 0; j < h; j++) { put(x, y + j, c, a); put(x + w - 1, y + j, c, a); }
  };
  const box = (x: number, y: number, w: number, h: number, c: C3, a = 1) => {
    for (let j = 0; j < h; j++) for (let i = 0; i < w; i++) put(x + i, y + j, c, a);
  };
  const line = (x0: number, y0: number, x1: number, y1: number, c: C3, a = 1) => {
    const n = Math.max(Math.abs(x1 - x0), Math.abs(y1 - y0));
    for (let i = 0; i <= n; i++) put(x0 + ((x1 - x0) * i) / Math.max(1, n), y0 + ((y1 - y0) * i) / Math.max(1, n), c, a);
  };
  const text = (s: string, x: number, y: number, c: C3) => {
    const draw = (ox: number, oy: number, col: C3) => {
      let cx = x;
      for (const ch of s) {
        const g = FONT[ch];
        if (g) for (let j = 0; j < g.length; j++) for (let i = 0; i < g[j].length; i++) if (g[j][i]) put(cx + i + ox, y + j + oy, col);
        cx += 6;
      }
    };
    for (const [ox, oy] of [[-1, 0], [1, 0], [0, -1], [0, 1], [1, 1]]) draw(ox, oy, [0, 0, 0]);
    draw(0, 0, c);
  };

  // road graph: edges as thin lines down the lane centres, key nodes as dots
  const g = spec.roads!;
  // sanity: edges straight and on road cells all the way, graph connected
  let bad = 0;
  const badAt: [number, number][] = [];
  for (const [a, b] of g.edges) {
    const [ax, ay] = g.nodes[a];
    const [bx, by] = g.nodes[b];
    if (ax !== bx && ay !== by) bad++;
    const n = Math.max(Math.abs(bx - ax), Math.abs(by - ay));
    for (let i = 0; i <= n; i++) {
      const nx = ax + Math.sign(bx - ax) * i;
      const ny = ay + Math.sign(by - ay) * i;
      for (let j = 0; j < 4; j++) for (let k = 0; k < 4; k++) if (spec.cells[(ny * 2 + j) * spec.w + nx * 2 + k] !== 6) {
        if (!bad && process.env.REGION_DEBUG) console.log(`  first bad edge ${ax},${ay} -> ${bx},${by} at node ${nx},${ny}`);
        bad++;
        badAt.push([(nx * 2 + k) * 4, (ny * 2 + j) * 4]);
      }
    }
  }
  if (badAt.length && process.env.REGION_DEBUG) console.log('  bad cells (px, type):', badAt.slice(0, 8).map(([x, y]) => `${x},${y}:${spec.cells[(y >> 2) * spec.w + (x >> 2)]}`).join(' '));
  const comp = g.nodes.map((_, i) => i);
  const find = (i: number): number => (comp[i] === i ? i : (comp[i] = find(comp[i])));
  for (const [a, b] of g.edges) comp[find(a)] = find(b);
  const parts = new Set(g.nodes.map((_, i) => find(i))).size;
  for (const [a, b] of g.edges) {
    const [ax, ay] = g.nodes[a];
    const [bx, by] = g.nodes[b];
    line(ax * 8 + 8, ay * 8 + 8, bx * 8 + 8, by * 8 + 8, [90, 60, 30], 0.6);
  }
  for (const [nx, ny] of g.nodes) box(nx * 8 + 7, ny * 8 + 7, 3, 3, [60, 30, 10]);
  for (const t of spec.towns ?? []) {
    rect(t.rect[0], t.rect[1], t.rect[2], t.rect[3], [255, 255, 255], 0.7);
    for (const [x, y] of t.garrison) rect(x, y, 16, 16, [255, 150, 0]);
    // flag
    line(t.cx, t.cy - 10, t.cx, t.cy + 4, [30, 30, 30]);
    box(t.cx + 1, t.cy - 10, 7, 5, [70, 140, 255]);
    text(t.name, t.cx - t.name.length * 3, t.rect[1] - 10, [255, 255, 255]);
  }
  for (const d of spec.depots ?? []) {
    rect(d.rect[0] - 2, d.rect[1] - 2, d.rect[2] + 4, d.rect[3] + 4, [255, 60, 60]);
    box(d.cx - 3, d.cy - 3, 6, 6, [255, 60, 60]);
    text(d.name, d.cx - d.name.length * 3, d.rect[1] - 12, [255, 140, 140]);
  }
  for (const [x, y] of spec.enemySpawns) { box(x + 4, y + 4, 8, 8, [230, 40, 40]); rect(x, y, 16, 16, [120, 0, 0]); }
  for (const [x, y] of spec.exits ?? []) rect(x - 2, y - 2, 20, 20, [255, 0, 255]);
  for (const [x, y] of spec.bridges ?? []) rect(x - 2, y - 2, 20, 20, [0, 255, 255]);
  for (const [x, y] of spec.playerSpawns) { box(x, y, 16, 16, [250, 230, 60]); rect(x, y, 16, 16, [0, 0, 0]); }
  // Phase 4: rail line (yellow), river route (cyan) with its width checked, lair hint (white ring)
  const poly = (pts: [number, number][], c: C3) => {
    for (let i = 1; i < pts.length; i++) line(pts[i - 1][0], pts[i - 1][1], pts[i][0], pts[i][1], c);
    for (const [x, y] of pts) box(x - 1, y - 1, 3, 3, c);
  };
  if (spec.rail) poly(spec.rail, [255, 220, 40]);
  let narrow = 0;
  if (spec.river) {
    poly(spec.river, [60, 255, 255]);
    // open water across the route: px of water square to the route at each point (bridges count as water here)
    for (let i = 0; i < spec.river.length; i++) {
      const [x, y] = spec.river[i];
      const [x2, y2] = spec.river[Math.min(spec.river.length - 1, i + 1)];
      const [x1, y1] = spec.river[Math.max(0, i - 1)];
      const len = Math.hypot(x2 - x1, y2 - y1) || 1;
      const nx = -(y2 - y1) / len;
      const ny = (x2 - x1) / len;
      let wid = 0;
      for (let s2 = -40; s2 <= 40; s2++) {
        const cx = Math.floor((x + nx * s2) / 4);
        const cy = Math.floor((y + ny * s2) / 4);
        const t = cx < 0 || cy < 0 || cx >= spec.w || cy >= spec.h ? 3 : spec.cells[cy * spec.w + cx];
        if (t === 3 || t === 6) wid++;
      }
      if (wid < 44) { narrow++; rect(x - 4, y - 4, 9, 9, [255, 0, 0]); }
    }
  }
  if (spec.lair) { rect(spec.lair[0] - 40, spec.lair[1] - 40, 80, 80, [255, 255, 255]); rect(spec.lair[0] - 41, spec.lair[1] - 41, 82, 82, [0, 0, 0]); }
  for (const [x, y] of badAt) box(x, y, 4, 4, [255, 0, 255]);
  text(`${spec.name} ${seed}`, 6, 6, [255, 255, 255]);

  const raw = Buffer.alloc((W * 3 + 1) * H);
  for (let y = 0; y < H; y++) {
    raw[y * (W * 3 + 1)] = 0;
    Buffer.from(px.buffer, y * W * 3, W * 3).copy(raw, y * (W * 3 + 1) + 1);
  }
  const crcT = new Uint32Array(256).map((_, n) => {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    return c >>> 0;
  });
  const crc = (b: Buffer) => {
    let c = 0xffffffff;
    for (const v of b) c = crcT[(c ^ v) & 255] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  };
  const chunk = (type: string, data: Buffer) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type), data]);
    const c = Buffer.alloc(4);
    c.writeUInt32BE(crc(td));
    return Buffer.concat([len, td, c]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(W, 0);
  ihdr.writeUInt32BE(H, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  const png = Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
  mkdirSync('shots', { recursive: true });
  const out = `shots/${kind}-${seed}.png`;
  writeFileSync(out, png);
  const towns = (spec.towns ?? []).map((t) => `${t.name}(${t.garrison.length})`).join(' ');
  console.log(`wrote ${out} (${W}x${H}) gen ${ms.toFixed(1)} ms | towns ${towns} | depots ${(spec.depots ?? []).map((d) => d.name).join(', ')}`
    + ` | road graph ${g.nodes.length} nodes ${g.edges.length} edges, ${parts} part(s), ${bad} bad cells | spawns ${spec.enemySpawns.length} | bridges ${spec.bridges?.length} | exits ${spec.exits?.length}`
    + `${spec.rail ? ` | rail ${spec.rail.length} pts` : ''}${spec.river ? ` | river ${spec.river.length} pts, ${narrow} narrow` : ''}${spec.lair ? ` | lair ${spec.lair}` : ''} | boss ${spec.boss} env ${spec.env}`);
}

(globalThis as { REGION_DEBUG?: boolean }).REGION_DEBUG = !!process.env.REGION_DEBUG;
const args = process.argv.slice(2);
const kinds: RegionKind[] = args[0] === 'all' ? REGION_KINDS : REGION_KINDS.includes(args[0] as RegionKind) ? [args[0] as RegionKind] : ['farm'];
const seeds = args.map(Number).filter((n) => Number.isFinite(n));
for (const k of kinds) for (const s of seeds.length ? seeds : [1, 2, 3]) render(k, s);
