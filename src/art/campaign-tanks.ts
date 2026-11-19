// Campaign tank looks (arcade tanks are untouched; see sprites.ts tankArt).
// - BABUSYA (player 1) and DIDO (player 2): a captured Dominion tank patched up by farmers. Drawn as layers, all
//   16 x 16 facing up and rotated together: the hull (farm paint over the Dominion olive, rust, a tarp), the tracks
//   (stock, or the fitted ones), then one overlay per fitted part, the crooked aerial with our flag, and kill tallies
//   on the turret per veteran rank. Paint pixels carry the tint mask: draw.ts tints them farm yellow (P1) or green (P2).
//   Parts stay few-pixel, bold and in their own place, so a fully upgraded tank still reads as the yellow BABUSYA.
// - Dominion tanks: dark grey-olive with red bands and lamps, a different silhouette per type (basic medium tank,
//   fast wheeled car, power = long-gun tank with the turret at the back, armour = heavy tank with side skirts that
//   come off as it takes hits). Body pixels carry the tint mask so freeze, bonus flash and abandoned-hull tints work.
import { type Atlas, PixelArt } from './atlas';

/** char -> [colour, height, spec, tint mask, emissive] */
type Pal = Record<string, [number, number, number?, number?, number?]>;
/** [x0, y0, x1, y1, height added] (inclusive box), e.g. a turret standing above the hull */
type Zone = [number, number, number, number, number];

const R8 = (c: number) => (c >> 16) & 255;
const G8 = (c: number) => (c >> 8) & 255;
const B8 = (c: number) => c & 255;
const rgb = (r: number, g: number, b: number) =>
  (Math.max(0, Math.min(255, r | 0)) << 16) | (Math.max(0, Math.min(255, g | 0)) << 8) | Math.max(0, Math.min(255, b | 0));
const shade = (c: number, f: number) => rgb(R8(c) * f, G8(c) * f, B8(c) * f);

/** Rows of palette chars to a sprite ('.' or a char not in the palette = clear). mirror = flipped left-right. */
function rowsArt(rows: string[], pal: Pal, zones: Zone[] = [], mirror = false, w = 16, h0 = 16): PixelArt {
  const a = new PixelArt(w, Math.max(h0, rows.length));
  rows.forEach((row, y) => {
    for (let i = 0; i < row.length && i < w; i++) {
      const p = pal[row[i]];
      if (!p) continue;
      const x = mirror ? w - 1 - i : i;
      let h = p[1];
      for (const [x0, y0, x1, y1, dh] of zones) if (i >= x0 && i <= x1 && y >= y0 && y <= y1) h += dh;
      a.set(x, y, p[0], h, p[2] ?? 0.2, p[3] ?? 0, p[4] ?? 0);
    }
  });
  return a;
}

// ---------- BABUSYA ----------
// Paint is authored grey with the tint mask on; everything else is baked colour.
const PAINT: Pal = {
  P: [0xf4f4f0, 0.56, 0.25, 1],
  p: [0xc6c6c0, 0.55, 0.22, 1],
  q: [0x8c8c86, 0.54, 0.2, 1],
};
const HULL_PAL: Pal = {
  ...PAINT,
  O: [0x7c8266, 0.56, 0.2], // the Dominion's olive where the farm paint ran out
  o: [0x5c624a, 0.55, 0.18],
  d: [0x3e4434, 0.54, 0.15],
  u: [0x7a3c1a, 0.55, 0.06], // rust
  U: [0xa85a26, 0.56, 0.08],
  K: [0x18160f, 0.54, 0.1],
  m: [0x9a9c94, 0.6, 0.45],
  n: [0x3e403a, 0.58, 0.3],
  h: [0xdcdcd0, 0.58, 0.55], // a bolt head
  B: [0xa4a69c, 0.68, 0.55], // barrel, lit side
  b: [0x5c5e56, 0.68, 0.45],
  y: [0xd6c088, 0.66, 0.05], // tape on the barrel, rope on the tarp
  w: [0x6c6240, 0.62, 0.04], // the tarp bundle
  W: [0x938758, 0.65, 0.05],
};
// DIDO carries firewood instead of a tarp
const DIDO_PAL: Pal = { ...HULL_PAL, w: [0x5a3c22, 0.62, 0.04], W: [0x8c6236, 0.65, 0.05], y: [0xb89a64, 0.66, 0.05] };
const TURRET: Zone = [5, 6, 10, 12, 0.16];

/** Stock hull: half-painted, rust, an olive panel, a taped barrel, the turret only half yellow, a tarp on the back. */
const HULL = [
  '................',
  '.......nn.......',
  '...qPPPBbPPqq...',
  '...pPuUyyPPPq...',
  '...pOooBbPpPq...',
  '...poodBbPPPq...',
  '...pPPKmnKPPq...',
  '...pPKPPOoKPq...',
  '...qPKPpOdKUq...',
  '...pPKPnnoKuq...',
  '...oOKpnndKPq...',
  '...oOKqpodKpq...',
  '...pPPKKKKqPq...',
  '...pwWWyWwwoq...',
  '...qwwwywwdnq...',
  '................',
];

/** The crooked aerial from the turret's back corner and our flag (gold over green) flapping off it. */
const FLAG_PAL: Pal = {
  a: [0x2a2a26, 0.86, 0.3],
  g: [0xf2c42a, 0.82, 0.3, 0, 0x2a1c00],
  G: [0x2a8c3a, 0.8, 0.2],
};
const FLAG = [
  ['..........a.....', '...........a....', '...........a....', '............agg.', '.............GG.'],
  ['..........a.....', '...........a....', '...........a....', '............ag..', '.............gGG'],
];

/** Kill marks per veteran rank on the turret's olive side, crisp single pixels (barrel parts don't hide them):
 * rank 1 one white tally, rank 2 two, rank 3 the two in our flag's gold. */
const VET_PAL: Pal = { T: [0xf4f0e2, 0.74, 0.3, 0, 0x181818], G: [0xf2c42a, 0.74, 0.4, 0, 0x2a1c00] };
const VET = [1, 2, 3].map((n) => {
  const rows = Array.from({ length: 12 }, () => '................');
  const ch = n === 3 ? 'G' : 'T';
  rows[n === 1 ? 8 : 7] = `.........${ch}......`;
  if (n > 1) rows[9] = `.........${ch}......`;
  return rows;
});

// ---------- tracks (stock and fitted), with the fenders ----------
type TrackKind = 'stock' | 'wide-tracks' | 'racing-tracks' | 'army-tracks';

function trackArt(kind: TrackKind, frame: number): PixelArt {
  const a = new PixelArt(16, 16);
  const tw = kind === 'wide-tracks' ? 4 : 3;
  for (const side of [0, 1]) {
    const sx = side ? 16 - tw : 0;
    for (let y = 1; y <= 14; y++) {
      for (let x = sx; x < sx + tw; x++) {
        const outer = side ? x === 15 : x === 0;
        const edge = x === sx || x === sx + tw - 1;
        const link = ((y + frame) & 1) === 0;
        let c: number;
        let h = link ? 0.47 : 0.44;
        // links in soft contrast so the tracks read as one dark band round the yellow hull, not stripes
        if (kind === 'stock') {
          c = link ? 0x524e46 : 0x36342e;
          // mismatched links: a rusty pair off another tank on each side
          if ((side === 0 && (y === 4 || y === 5)) || (side === 1 && (y === 10 || y === 11))) c = link ? 0x7e4c2c : 0x54301a;
        } else if (kind === 'wide-tracks') {
          // snow-plough tracks: four links wide, a heavy cleat every third link
          const cleat = (y + frame) % 3 === 0;
          c = cleat ? 0x5e605a : 0x3a3c3a;
          h = cleat ? 0.48 : 0.44;
        } else if (kind === 'racing-tracks') {
          // bright steel links with one solid red racing stripe down the outside
          c = link ? 0x9a9ea2 : 0x74787c;
          if (outer) c = 0xc42a1a;
        } else {
          c = link ? 0x3c3c40 : 0x26262a;
        }
        if (edge && kind !== 'racing-tracks') c = shade(c, 0.74);
        if (y === 1 || y === 14) c = 0x1e1c18;
        a.set(x, y, c, h, kind === 'racing-tracks' ? 0.6 : 0.3, 0);
      }
    }
  }
  const P = (x: number, y: number, ch: 'P' | 'p' | 'q', h = 0.5) => { const p = PAINT[ch]; a.set(x, y, p[0], h, 0.25, 1); };
  if (kind === 'stock') {
    // the left front mudguard is bent up and out, the right one is still on
    a.set(0, 0, 0xa85a26, 0.52, 0.08);
    a.set(1, 0, 0x7a3c1a, 0.52, 0.06);
    a.set(1, 1, 0x7a3c1a, 0.5, 0.06);
    P(2, 1, 'q');
    P(13, 1, 'p');
    P(14, 1, 'P');
    P(15, 1, 'q');
  } else if (kind === 'wide-tracks') {
    for (let x = 0; x < 4; x++) { P(x, 1, x === 3 ? 'q' : 'P'); P(15 - x, 1, x === 3 ? 'q' : 'P'); }
  } else if (kind === 'army-tracks') {
    // proper side skirts: one solid olive plate over the outer links, lit along the front
    for (const sx of [0, 15]) for (let y = 1; y <= 13; y++) a.set(sx, y, y === 1 ? 0x868c70 : 0x60664c, 0.52, 0.25, 0);
    for (let x = 1; x < 3; x++) { a.set(x, 1, 0x868c70, 0.5, 0.25, 0); a.set(15 - x, 1, 0x868c70, 0.5, 0.25, 0); }
  }
  return a;
}

// ---------- fitted parts (overlays) ----------
// Each part is one bold shape in one or two colours (plus a darker edge), in its own place on the tank, so a fully
// upgraded BABUSYA still shows its yellow deck and turret: armour on the front glacis or the hull edges (or a frame
// round everything), engines across the back, barrels on the gun only, jammers and ploughs one small piece each.
const PARTS: Record<string, { pal: Pal; rows: string[] }> = {
  // armour: two bolted-on plates across the front (a steel one and a blue bus-stop sign), sandbags on the front,
  // granny's iron bed round the whole tank, reactive bricks down both hull edges
  'scrap-plates': {
    pal: { S: [0xa8acaa, 0.61, 0.5], s: [0x6a6e72, 0.6, 0.4], E: [0x4a7cc0, 0.61, 0.35], e: [0x2a5290, 0.6, 0.3] },
    rows: [
      '................',
      '................',
      '...SSSS..EEEE...',
      '...SSSS..EEEE...',
      '...ssss..eeee...',
    ],
  },
  sandbags: {
    pal: { A: [0xc4b89c, 0.62, 0.05], a: [0x8e8468, 0.6, 0.04], z: [0x4a4232, 0.57, 0.03] },
    rows: [
      '................',
      '................',
      '...aAAa..aAAa...',
      '...aAAa..aAAa...',
      '...zaaz..zaaz...',
    ],
  },
  'bed-cage': {
    pal: { I: [0x6e7278, 0.67, 0.65], g: [0xe8b838, 0.72, 0.8, 0, 0x201400] },
    rows: [
      'gIIIIIIIIIIIIIIg',
      ...Array.from({ length: 14 }, () => 'I..............I'),
      'gIIIIIIIIIIIIIIg',
    ],
  },
  reactive: {
    pal: { T: [0x9ca07c, 0.63, 0.12], t: [0x464a34, 0.62, 0.1] },
    rows: [
      '................',
      '................',
      '................',
      '...T........T...',
      '...t........t...',
      '...t........t...',
      '...T........T...',
      '...t........t...',
      '...t........t...',
      '...T........T...',
      '...t........t...',
      '...t........t...',
    ],
  },
  // engines, across the back: a tractor's red hood (its stack is the one dark pixel), a bus's cream back end with
  // its tail lights, their turbo deck with a chrome turbo and twin pipes
  'tractor-diesel': {
    pal: { X: [0x141414, 0.9, 0.2], R: [0xc4321c, 0.63, 0.35], r: [0x82200e, 0.61, 0.3] },
    rows: [
      '', '', '', '', '', '', '', '', '', '', '', '',
      '....X...........',
      '....RRRRRRRR....',
      '....rrrrrrrr....',
    ],
  },
  'bus-engine': {
    pal: { C: [0xe0d6b4, 0.63, 0.35], c: [0xa89c7c, 0.61, 0.3], L: [0xe03020, 0.62, 0.4, 0, 0x601008] },
    rows: [
      '', '', '', '', '', '', '', '', '', '', '', '', '',
      '....CCCCCCCC....',
      '....LccccccL....',
    ],
  },
  'turbo-diesel': {
    pal: { O: [0x6e7462, 0.63, 0.3], o: [0x4c5246, 0.61, 0.25], M: [0xa8aca8, 0.68, 0.6], X: [0x121212, 0.58, 0.15] },
    rows: [
      '', '', '', '', '', '', '', '', '', '', '', '', '',
      '....OOOOOMMO....',
      '....oooooMMo....',
      '.....X....X.....',
    ],
  },
  // barrels and loaders: the gun only, plus one block on the turret for the loaders
  'long-100': {
    pal: { B: [0xb4b6ae, 0.68, 0.6], b: [0x60625a, 0.68, 0.5], n: [0x2a2c28, 0.69, 0.3] },
    rows: ['.......nn.......', '.......Bb.......', '.......Bb.......', '.......Bb.......', '.......Bb.......', '.......Bb.......'],
  },
  'sewing-loader': {
    pal: {
      B: [0xb4b6ae, 0.68, 0.6], b: [0x60625a, 0.68, 0.5], n: [0x2a2c28, 0.69, 0.3],
      S: [0x1c1c22, 0.82, 0.6], g: [0xdcb040, 0.83, 0.6],
    },
    rows: [
      '', '.......nn.......', '.......Bb.......', '.......Bb.......', '.......Bb.......', '.......Bb.......',
      '', '', '', '',
      '......SSg.......',
      '......SSS.......',
    ],
  },
  'barrel-125': {
    pal: { B: [0x8e947e, 0.7, 0.5], b: [0x50564a, 0.7, 0.4], n: [0x1e201c, 0.71, 0.3] },
    rows: ['......nnnn......', '.......Bb.......', '.......Bb.......', '.......Bb.......', '.......Bb.......', '.......Bb.......'],
  },
  autoloader: {
    pal: {
      B: [0xb4b6ae, 0.68, 0.6], b: [0x60625a, 0.68, 0.5], n: [0x2a2c28, 0.69, 0.3],
      O: [0x9a9e90, 0.72, 0.4], o: [0x5c6058, 0.71, 0.3],
    },
    rows: [
      '', '.......nn.......', '.......Bb.......', '.......Bb.......', '.......Bb.......', '.......Bb.......',
      '', '', '', '', '',
      '......OOOO......',
      '......oooo......',
    ],
  },
  // drone jammers: a TV aerial over the left track, a microwave with a green light on the back deck
  'aerial-jammer': {
    pal: { a: [0x2a2a28, 0.9, 0.4], A: [0xb4b6b2, 0.92, 0.65] },
    rows: [
      '', '', '', '', '', '', '', '', '',
      '.A.A............',
      'aaaaa...........',
      '.A.A............',
    ],
  },
  'oven-jammer': {
    pal: { C: [0xece8dc, 0.72, 0.45], c: [0xb0aca0, 0.7, 0.35], w: [0x1c2428, 0.71, 0.7], L: [0x40ff50, 0.72, 0.5, 0, 0x10600c] },
    rows: [
      '', '', '', '', '', '', '', '', '', '',
      '...CCC..........',
      '...wwC..........',
      '...ccL..........',
    ],
  },
  // mine ploughs, out in front of the tracks: a red farm harrow with four teeth, a pair of steel rollers
  'farm-harrow': {
    pal: { R: [0xb83a22, 0.5, 0.3], r: [0x7a2414, 0.49, 0.25], t: [0xa0a2a2, 0.46, 0.55] },
    rows: ['.t..t......t..t.', 'rRRRRr....rRRRRr'],
  },
  'mine-roller': {
    pal: { D: [0x7a7c7e, 0.52, 0.55], d: [0x3a3c3e, 0.5, 0.4] },
    rows: ['DDDD........DDDD', 'dddd........dddd'],
  },
};

/** The stock barrel is short and taped; any barrel part replaces it. Slots in draw order (bottom to top). */
const SLOT_ORDER = ['armour', 'engine', 'plough', 'barrel', 'jammer'] as const;

// ---------- Dominion tanks ----------
const DOM: Pal = {
  H: [0xa2a698, 0.56, 0.3, 1], // the lit hull edge, light enough to stand off dark earth (T6)
  h: [0x585c52, 0.55, 0.25, 1],
  d: [0x3a3e36, 0.54, 0.2, 1],
  K: [0x121410, 0.54, 0.1, 1],
  // the Dominion's red bands and fangs: a dim red glow (G2) so a tank reads at night and in rain without lights
  R: [0xe23a20, 0.56, 0.3, 0.35, 0x901a0c],
  r: [0x82180e, 0.55, 0.25, 0.35, 0x480c06],
  L: [0xffd8c8, 0.57, 0.5, 0, 0xff3818], // lamps
  m: [0x8a8e86, 0.58, 0.5, 1],
  n: [0x3a3e38, 0.57, 0.3, 1],
  B: [0x989c92, 0.68, 0.55, 1],
  b: [0x585c54, 0.68, 0.45, 1],
  S: [0x6a705e, 0.53, 0.3, 1], // side skirts
  s: [0x464c3e, 0.52, 0.25, 1],
  x: [0x1a1a1a, 0.5, 0.05, 1], // scorch
};

interface DomDef { rows: string[]; tread: number; tracks: [number, number]; wheels?: boolean; zones: Zone[] }
const DOMS: DomDef[] = [
  // basic: a medium tank, round turret with the red band across it
  {
    tread: 3, tracks: [1, 14], zones: [[5, 6, 10, 12, 0.16]],
    rows: [
      '................',
      '.......Bb.......',
      '....LdHBbHdL....',
      '...dHHhBbhHHd...',
      '...dHhRBbRhhd...',
      '...dHhhBbhhhd...',
      '...dHhKmnKhhd...',
      '...dHKHHhhKhd...',
      '...dHKRRRrKhd...',
      '...dhKhnnhKhd...',
      '...dhKhnnhKhd...',
      '...dhKdhhdKhd...',
      '...dhhKKKKhhd...',
      '...dnhhnnhhnd...',
      '...dddddddddd...',
      '................',
    ],
  },
  // fast: a wheeled armoured car, pointed nose, a little turret with a thin autocannon
  {
    tread: 0, tracks: [0, 0], wheels: true, zones: [[6, 5, 9, 8, 0.12]],
    rows: [
      '.......nb.......',
      '......dnbd......',
      '.....LHnbHL.....',
      '....dHhnbhHd....',
      '....dHhnbhhd....',
      '....dHKKKKhd....',
      '....dHKRRKhd....',
      '....dHKhnKhd....',
      '....dHKKKKhd....',
      '....dHhhhhhd....',
      '....dHmhhmhd....',
      '....dHhRRhhd....',
      '....dHnnnnhd....',
      '....dHhhhhhd....',
      '....dddddddd....',
      '................',
    ],
  },
  // power: the turret set far back and a long gun with a muzzle brake past the nose
  {
    tread: 3, tracks: [2, 14], zones: [[4, 8, 11, 13, 0.16]],
    rows: [
      '......nBbn......',
      '......nBbn......',
      '.......Bb.......',
      '...LdHHBbHHdL...',
      '...dHhhBbhhHd...',
      '...dHhRBbRhhd...',
      '...dHhhBbhhhd...',
      '...dHhhBbhhhd...',
      '...dHKKmnKKhd...',
      '...dKHHhhhhKd...',
      '...dKHRRRRrKd...',
      '...dKhhnnhhKd...',
      '...dKhhnnhdKd...',
      '...ddKKKKKKdd...',
      '...dnnddddnndd..',
      '................',
    ],
  },
  // armour: a heavy tank, wide tracks under side skirts, a boxy turret with twin red stripes
  {
    tread: 4, tracks: [1, 14], zones: [[4, 5, 11, 12, 0.16]],
    rows: [
      '.......Bb.......',
      '.......Bb.......',
      '....LdHBbHdL....',
      '....dHhBbhHd....',
      '....dhhBbhhd....',
      '....KKmmnnKK....',
      '....KHHhhhhK....',
      '....KRHhhhRK....',
      '....KRhnnhRK....',
      '....KRhnnhRK....',
      '....KHhhhhdK....',
      '....KhhddhdK....',
      '....KKKKKKKK....',
      '....dnhhhhnd....',
      '....dddddddd....',
      '................',
    ],
  },
];

/** Skirt plates on the heavy tank: [side, plate] knocked off at each hp (4 = all on). Plates: 0 front, 1 middle, 2 rear. */
const SKIRTS_OFF: Record<number, [number, number][]> = {
  4: [],
  3: [[0, 1]],
  2: [[0, 1], [1, 0]],
  1: [[0, 1], [1, 0], [0, 2], [1, 2]],
};

function dominionArt(type: number, frame: number, hp = 4): PixelArt {
  const d = DOMS[type];
  const a = rowsArt(d.rows, DOM, d.zones);
  const put = (x: number, y: number, c: number, h: number, t = 1) => { if (!a.has(x, y)) a.set(x, y, c, h, 0.3, t); };
  if (d.wheels) {
    // three axles a side: dark tyres with a tread line that turns
    for (const sx of [1, 13]) {
      for (const wy of [3, 8, 12]) {
        for (let y = wy; y < wy + 3; y++) {
          for (let x = sx; x < sx + 2; x++) {
            const tread = (y + frame) % 2 === 0 && x === (sx === 1 ? sx : sx + 1);
            const hub = y === wy + 1 && x === (sx === 1 ? sx + 1 : sx);
            put(x, y, hub ? 0x8a8a84 : tread ? 0x4a4a4e : 0x1c1c1e, hub ? 0.48 : tread ? 0.47 : 0.45, 0);
          }
        }
      }
    }
  } else {
    for (const side of [0, 1]) {
      const sx = side ? 16 - d.tread : 0;
      for (let y = d.tracks[0]; y <= d.tracks[1]; y++) {
        for (let x = sx; x < sx + d.tread; x++) {
          const link = ((y + frame) & 1) === 0;
          let c = link ? 0x4a4a4c : 0x262628;
          if (x === sx || x === sx + d.tread - 1) c = shade(c, 0.7);
          if (y === d.tracks[0] || y === d.tracks[1]) c = 0x161618;
          put(x, y, c, link ? 0.47 : 0.44, 0);
        }
      }
    }
  }
  if (type === 3) {
    // side skirts over the outer three track columns, three plates a side; hits knock them off
    const off = SKIRTS_OFF[Math.max(1, Math.min(4, hp))];
    for (const side of [0, 1]) {
      for (let p = 0; p < 3; p++) {
        if (off.some(([s, q]) => s === side && q === p)) continue;
        const y0 = 2 + p * 4;
        for (let y = y0; y < y0 + 4; y++) {
          for (let k = 0; k < 3; k++) {
            const x = side ? 13 + k : k;
            let c = y === y0 ? 0x868c78 : k === (side ? 2 : 0) ? 0x3c4234 : 0x5e6452;
            if (p === 0 && y === y0 + 1) c = 0xd0321c; // red stripe on the front plates
            if (y === y0 + 2 && k === 1) c = 0xb0b4a4; // a rivet
            a.set(x, y, c, 0.53, 0.3, c === 0xd0321c ? 0.35 : 1);
          }
        }
      }
    }
    // scorch where the plates came off and on the hull
    if (hp <= 2) for (const [x, y] of [[5, 3], [10, 10], [6, 13], [9, 4]]) if (a.has(x, y)) a.set(x, y, 0x1a1a18, 0.55, 0.05, 1);
    if (hp <= 1) for (const [x, y] of [[7, 7], [10, 6], [4, 11], [5, 9]]) if (a.has(x, y)) a.set(x, y, 0x1a1a18, 0.6, 0.05, 1);
  }
  return a;
}

// ---------- atlas ----------
const TRACK_KINDS: TrackKind[] = ['stock', 'wide-tracks', 'racing-tracks', 'army-tracks'];

/** Every BABUSYA / DIDO layer by atlas name (built once; the garage composes the same layers on a canvas). */
let layers: Map<string, PixelArt> | null = null;
function babLayers(): Map<string, PixelArt> {
  if (layers) return layers;
  const m = new Map<string, PixelArt>();
  m.set('babHull0', rowsArt(HULL, HULL_PAL, [TURRET]));
  m.set('babHull1', rowsArt(HULL, DIDO_PAL, [TURRET], true));
  for (const k of TRACK_KINDS) for (const f of [0, 1]) m.set(`babTrk_${k}_${f}`, trackArt(k, f));
  for (const [id, p] of Object.entries(PARTS)) m.set(`babPart_${id}`, rowsArt(p.rows, p.pal));
  FLAG.forEach((rows, i) => m.set(`babFlag${i}`, rowsArt(['', '', '', '', '', '', '', '', '', '', '', ...rows], FLAG_PAL)));
  VET.forEach((rows, i) => m.set(`babVet${i + 1}`, rowsArt(rows, VET_PAL)));
  layers = m;
  return m;
}

/** Atlas entries: babHull0/1 (P1, P2), babTrk_<kind>_<frame>, babPart_<id>, babFlag0/1, babVet1-3, dom<type><a|b>
 * (dom3 per hp: dom3h<hp><a|b>). */
export function addCampaignTankSprites(at: Atlas): void {
  for (const [name, a] of babLayers()) at.add(name, a);
  for (let t = 0; t < 3; t++) for (const f of [0, 1]) at.add(`dom${t}${f ? 'b' : 'a'}`, dominionArt(t, f));
  for (let hp = 1; hp <= 4; hp++) for (const f of [0, 1]) at.add(`dom3h${hp}${f ? 'b' : 'a'}`, dominionArt(3, f, hp));
}

/** A player's tank flattened to 16 x 16 RGBA (paint tinted, facing up), for the garage and the HUD card. */
export function babusyaRGBA(player: number, fitted: Partial<Record<string, string>>, vet: number): Uint8ClampedArray {
  const out = new Uint8ClampedArray(16 * 16 * 4);
  const paint = BAB_PAINT[player ? 1 : 0];
  for (const name of babusyaLayers(player, fitted, vet, 0)) {
    const a = babLayers().get(name);
    if (!a) continue;
    for (let i = 0; i < 16 * 16; i++) {
      if (!a.alb[i * 4 + 3]) continue;
      const m = a.hs[i * 4 + 2] / 255;
      for (let c = 0; c < 3; c++) out[i * 4 + c] = a.alb[i * 4 + c] * (1 - m + m * paint[c]);
      out[i * 4 + 3] = 255;
    }
  }
  return out;
}

/** Sprite names for a player's campaign tank, bottom to top. fitted = part id per slot (Tank.fitted). */
export function babusyaLayers(player: number, fitted: Partial<Record<string, string>>, vet: number, frame: number, flagFrame = 0): string[] {
  const out = [`babHull${player ? 1 : 0}`];
  const tr = fitted.tracks;
  out.push(`babTrk_${tr && TRACK_KINDS.includes(tr as TrackKind) ? tr : 'stock'}_${frame ? 1 : 0}`);
  for (const slot of SLOT_ORDER) {
    const id = fitted[slot];
    if (id && PARTS[id]) out.push(`babPart_${id}`);
  }
  out.push(`babFlag${flagFrame ? 1 : 0}`);
  if (vet > 0) out.push(`babVet${Math.min(3, vet)}`);
  return out;
}

/** Atlas name of a Dominion tank (campaign enemy) for its type, hit points and track frame. */
export function dominionSprite(etype: number, hp: number, frame: number): string {
  const f = frame ? 'b' : 'a';
  if (etype === 3) return `dom3h${Math.max(1, Math.min(4, hp))}${f}`;
  return `dom${Math.max(0, Math.min(2, etype))}${f}`;
}

/** Farm paint per player: BABUSYA's yellow, DIDO's green (multiplies the grey paint pixels). */
export const BAB_PAINT: [number, number, number][] = [[1.0, 0.78, 0.26], [0.5, 0.84, 0.36]];
