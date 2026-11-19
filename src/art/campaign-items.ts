// Campaign items and map-event people: salvage pickups (a scrap heap, a parts crate), the supply-drop crate under its
// parachute, a generator, a field radio, a sock on a stick (the marked minefield), the escort vehicles (a farm tractor,
// a rail handcar) and the people who start map events (villager, farmer, railwayman, fisherman, bell ringer, a tank
// crewman, a neighbour, a truck driver), each standing up in two frames: still and waving. Dark outlines keep them
// readable on any ground; events.ts gives the people a lantern light and a "!" bubble so they read at night.
import { type Atlas, PixelArt } from './atlas';

/** char -> [colour, height, spec, emissive] */
type Pal = Record<string, [number, number?, number?, number?]>;

const K = 0x1c1610;
const SKIN: Pal = { f: [0xe8b088], F: [0xbc8458], k: [0x2a1a10] };

/** Rows to a sprite; heights from the palette or `h`, a function of the row (people stand up: feet low, heads high). */
function art(rows: string[], pal: Pal, h: number | ((y: number) => number), spec = 0.2): PixelArt {
  const w = Math.max(...rows.map((r) => r.length));
  const a = new PixelArt(w, rows.length);
  rows.forEach((row, y) => {
    for (let x = 0; x < row.length; x++) {
      const p = row[x] === 'K' ? [K] as [number] : pal[row[x]];
      if (!p) continue;
      const hh = typeof h === 'number' ? h : h(y);
      a.set(x, y, p[0], p[1] ?? hh, p[2] ?? spec, 0, p[3] ?? 0);
    }
  });
  return a;
}

// ---------- salvage pickups ----------
/** A heap of bent steel plates, a rusty one, a bolt and a nut in front. */
const SCRAP = [
  '.....KK.....',
  '....KSsK....',
  '.KK.KSsdK...',
  'KSSKKSsdKKK.',
  'KSssKsdKUUuK',
  '.KsdKdKUuuuK',
  'KKKdKKUuuuK.',
  'KyKKnnKKuK..',
  '.K.KnnK.KK..',
  '....KK......',
];
const SCRAP_PAL: Pal = {
  S: [0xd4d8dc, undefined, 0.8, 0x101418], s: [0x9098a0, undefined, 0.7], d: [0x565c64, undefined, 0.5],
  U: [0xc86c30, undefined, 0.3], u: [0x8a4422, undefined, 0.2], y: [0xe0b848, undefined, 0.8, 0x1a1000], n: [0x40444a, undefined, 0.6],
};

/** A wooden crate of parts with a gear stencilled on the lid. */
const CRATE = [
  'KKKKKKKKKKK',
  'KWWWWWWWWWK',
  'KnwwwwwwwnK',
  'KwwwcwcwwwK',
  'KddcccccddK',
  'KWWccWccWWK',
  'KwwcccccwwK',
  'KwwwcwcwwwK',
  'KdddddddddK',
  'KnWWWWWWWnK',
  'KKKKKKKKKKK',
];
const CRATE_PAL: Pal = {
  W: [0xc08848], w: [0x9a6432], d: [0x5e3a1a], n: [0x2a2a2a, undefined, 0.6], c: [0xf0e0b0, undefined, 0.3, 0x141008],
};

/** A supply drop: the parachute lying crumpled behind an olive crate with a yellow cross, cords between. */
const DROP = [
  '...KKKKKKKKK....',
  '..KVVoVVVoVVK...',
  '.KVVvoVVvoVVvK..',
  '.KvVvovVvovVvK..',
  '..KKvKKvKKvKK...',
  '...l..l..l.l....',
  '....l.l.l.l.....',
  '....KKKKKKKK....',
  '....KGGGGGGK....',
  '....KggyyggK....',
  '....KgyyyygK....',
  '....KggyyggK....',
  '....KggggggK....',
  '....KKKKKKKK....',
];
const DROP_PAL: Pal = {
  V: [0xeae6d6, 0.34, 0.1, 0x101010], v: [0xb4b0a0, 0.3, 0.1], o: [0xe07030, 0.33, 0.1, 0x200800], l: [0x9a948a, 0.3],
  G: [0x7a8a4a, 0.45, 0.3], g: [0x56642e, 0.44, 0.25], y: [0xf0d860, 0.45, 0.3, 0x201800],
};

/** A generator on its frame: grey-blue box, grille, a red fuel tank, a hazard stripe. */
const GEN = [
  '.KKKKKKKKKKKK.',
  'KMMMMMMMKRRRRK',
  'KmgmgmgmKrRRrK',
  'KmgmgmgmKrrrrK',
  'KmgmgmgmKKKKKK',
  'KmmmmmmmmmmmmK',
  'KyKyKyKyKyKymK',
  'KmmmmmmmmmmmmK',
  'KKKKKKKKKKKKKK',
  '.KWK......KWK.',
];
const GEN_PAL: Pal = {
  M: [0x9aaab8, undefined, 0.6], m: [0x5e6e7c, undefined, 0.5], g: [0x22282e], R: [0xd03420, undefined, 0.5], r: [0x8a1c10],
  y: [0xe8c440, undefined, 0.3], W: [0x1a1a1a],
};

/** A field radio set: olive box, speaker grille, a dial and a red light, a whip aerial. */
const RADIO = [
  '.........a',
  '........a.',
  '.......a..',
  '.KKKKKKaK.',
  'KGGGGGGGGK',
  'KGkkGcGcGK',
  'KGkkGGGLGK',
  'KggggggggK',
  'KKKKKKKKKK',
];
const RADIO_PAL: Pal = {
  a: [0x2a2a26, 0.7], G: [0x6e7a48, undefined, 0.3], g: [0x4a5430], k: [0x1e2016], c: [0xf0e8c8, undefined, 0.3, 0x141008],
  L: [0xff4030, undefined, 0.5, 0xc02010],
};

/** A sock on a stick: how Baba Olha marks a mine (two frames: the sock swings). */
const SOCK = [
  ['.RR.', '.WW.', '.RR.', '.WWR', '..b.', '..b.', '..b.', '..b.', '.kbk'],
  ['.RR.', '.WW.', '.RR.', 'RWW.', '..b.', '..b.', '..b.', '..b.', '.kbk'],
];
const SOCK_PAL: Pal = { R: [0xe03030, 0.5, 0.1, 0x180000], W: [0xf0ece0, 0.5, 0.1, 0x101010], b: [0x8a6236, 0.4], k: [0x3a2a1a, 0.25] };

// ---------- escort vehicles, facing up (rotated by the escort's heading) ----------
/** Petro's tractor: red body and hood, big rear wheels, small front ones, Petro in his blue cap. */
const TRACTOR = [
  '......KKKK......',
  '.....KRRRRK.....',
  '..WW.KRggRK.WW..',
  '..WW.KRRRRK.WW..',
  '..WW.KRggRK.WW..',
  '.....KRRRRK.....',
  '.....KRRRRK.....',
  '....KKRxxRKK....',
  'WWWWKRRRRRRKWWWW',
  'WWWWKRRccRRKWWWW',
  'WWWWKRbccbRKWWWW',
  'WWWWKRbbbbRKWWWW',
  'WWWWKRRRRRRKWWWW',
  'WWWWKKKKKKKKWWWW',
  '......KhhK......',
  '.......hh.......',
];
const TRACTOR_PAL: Pal = {
  R: [0xc8321e, 0.5, 0.45], g: [0x2a1810, 0.48], x: [0x1a1a1a, 0.62, 0.3], c: [0x2a4a8a, 0.64, 0.2], b: [0x5a8ad0, 0.6, 0.2],
  h: [0x5a5a58, 0.36, 0.4], W: [0x1e1e20, 0.46, 0.2], w: [0x4a4a4c, 0.47, 0.2],
};

/** Ivan's rail handcar: a plank deck on four little wheels, the pump lever across it, Ivan in his orange vest. */
const HANDCAR = [
  '................',
  '...nn......nn...',
  '..KKKKKKKKKKKK..',
  '..KWWWWWWWWWWK..',
  '..KwwwwwwwwwwK..',
  '..KWWWWWmWWWWK..',
  '..KwwwwmmmwwwK..',
  '..KmmmmmmmmmmK..',
  '..KwwwwmmmwwwK..',
  '..KWWWoccoWWWK..',
  '..KwwwoooowwwK..',
  '..KWWWWWWWWWWK..',
  '..KKKKKKKKKKKK..',
  '...nn......nn...',
  '................',
  '................',
];
const HANDCAR_PAL: Pal = {
  W: [0x9a6a3a, 0.42, 0.1], w: [0x7a5028, 0.41, 0.1], m: [0x8a8e90, 0.56, 0.6], n: [0x2a2a2c, 0.38, 0.4],
  o: [0xf07820, 0.58, 0.2], c: [0x26304a, 0.64, 0.2],
};

// ---------- people (front view, standing; 7-9 px wide, 11 tall) ----------
const PEOPLE: Record<string, { rows: string[]; pal: Pal }> = {
  // Baba Olha: red headscarf with white dots, brown coat, apron
  OLHA: {
    rows: ['..KKK..', '.KRwRK.', 'KRfffRK', 'KRkfkRK', '.KRfRK.', 'KcRRRcK', 'KcaaacK', 'fcaaacf', 'KcaaacK', '.KcccK.', '.Kb.bK.'],
    pal: { R: [0xd02a2a], w: [0xf4ece0], c: [0x5e3c2a], a: [0xdccca4], b: [0x2a2420] },
  },
  // Petro: straw hat, grey moustache, red shirt, blue overalls
  PETRO: {
    rows: ['..KYK..', '.KYYYK.', 'YYyyyYY', '.KfffK.', '.KkfkK.', '.KmmmK.', 'KsooosK', 'fsooosf', 'KoooooK', '.KoKoK.', '.Kb.bK.'],
    pal: { Y: [0xe4c870], y: [0x8a6428], m: [0x9a948a], s: [0xc0402c], o: [0x3a5a8c], b: [0x2a2420] },
  },
  // Ivan: navy railway cap, orange vest with a reflective stripe
  IVAN: {
    rows: ['..KKK..', '.KcccK.', 'KcccccK', '.KkfkK.', '.KfffK.', 'KvvvvvK', 'KWWWWWK', 'fvvvvvf', 'KtttttK', '.KtKtK.', '.Kb.bK.'],
    pal: { c: [0x26304a], v: [0xf07820], W: [0xeeeee0, undefined, 0.6, 0x101010], t: [0x2a2e3a], b: [0x1e1e22] },
  },
  // Old Lev: bucket hat, grey beard, yellow oilskin, a fishing rod over his shoulder
  LEV: {
    rows: ['..KKK...l', '.KhhhK..l', 'KhhhhhK.l', '.KkfkK.l.', '.KgggK.l.', 'KyyyyyKl.', 'KyyyyyKl.', 'fyyyyyf..', 'KyyyyyK..', '.KtKtK...', '.Kb.bK...'],
    pal: { h: [0x6a7048], g: [0xc4c4bc], y: [0xe8c830], t: [0x3a3a40], b: [0x2a2420], l: [0x8a6a3a, 0.62] },
  },
  // Vasyl: grey hair and beard, a long black cassock, his broom
  VASYL: {
    rows: ['..KKK....', '.KgggK...', 'KgfffgKl.', 'KgkfkgKl.', '.KgggK.l.', 'KnnnnnKl.', 'KnnnnnKl.', 'fnnnnnfl.', 'KnnnnnKY.', 'KnnnnnYYY', '.KK.KKYYY'],
    pal: { g: [0xc8c8c0], n: [0x2a2a32], l: [0x8a6a3a], Y: [0xd8b860] },
  },
  // Dmytro: padded tanker's helmet, olive overalls, bandaged head and arm
  DMYTRO: {
    rows: ['..KKK..', '.KhhhK.', 'KhWWWhK', 'KhkfkhK', '.KfffK.', 'KoooooK', 'KWooooK', 'WoooooF', 'KoooooK', '.KoKoK.', '.Kb.bK.'],
    pal: { h: [0x2e2620], W: [0xf0f0e8, undefined, 0.3, 0x101010], o: [0x5e6a3a], b: [0x1e1e22] },
  },
  // Mila: long brown hair, green coat
  MILA: {
    rows: ['..KKK..', '.KHHHK.', 'KHfffHK', 'KHkfkHK', 'KHfffHK', 'KgggggK', 'KgggggK', 'fgggggf', 'KgggggK', '.KtKtK.', '.Kb.bK.'],
    pal: { H: [0x6a3a1a], g: [0x3a8060], t: [0x2e2e36], b: [0x2a2420] },
  },
  // Bohdan: flat cap, stubble, red check shirt, jeans
  BOHDAN: {
    rows: ['..KKK..', '.KcccK.', 'KcccccK', '.KkfkK.', '.KfFfK.', 'KRrRrRK', 'KrRrRrK', 'fRrRrRf', 'KjjjjjK', '.KjKjK.', '.Kb.bK.'],
    pal: { c: [0x6a5a48], R: [0xd03a2a], r: [0x7a1c14], j: [0x3a5070], b: [0x2a2420] },
  },
};

/** People stand up: feet near the ground, heads higher (their shadows fall like a standing figure's). */
const personH = (y: number) => 0.3 + ((10 - y) / 10) * 0.28;

/** The same person waving: the left arm goes up beside the head. */
function waving(rows: string[]): string[] {
  const out = rows.map((r) => r.split(''));
  const sleeve = out[6][1];
  out[7][0] = '.';
  out[5][0] = sleeve;
  out[4][0] = sleeve;
  out[3][0] = 'f';
  out[2][0] = 'f';
  return out.map((r) => r.join(''));
}

/** Atlas entries: itemScrap, itemCrate, evDrop, evGen, evRadio, evSock0/1, evTractor0/1, evHandcar,
 * person<NAME>0 (still) / person<NAME>1 (waving). */
export function addCampaignItemSprites(at: Atlas): void {
  at.add('itemScrap', art(SCRAP, SCRAP_PAL, 0.34, 0.7));
  at.add('itemCrate', art(CRATE, CRATE_PAL, 0.42, 0.2));
  at.add('evDrop', art(DROP, DROP_PAL, 0.4));
  at.add('evGen', art(GEN, GEN_PAL, 0.5, 0.4));
  at.add('evRadio', art(RADIO, RADIO_PAL, 0.42, 0.3));
  SOCK.forEach((rows, i) => at.add(`evSock${i}`, art(rows, SOCK_PAL, 0.45)));
  for (const f of [0, 1]) {
    // tyre treads: rows alternate dark and light, shifting a row per frame
    const rows = TRACTOR.map((r, y) => ((y + f) % 2 ? r : r.replace(/W/g, 'w')));
    at.add(`evTractor${f}`, art(rows, TRACTOR_PAL, 0.5));
  }
  at.add('evHandcar', art(HANDCAR, HANDCAR_PAL, 0.42));
  for (const [name, p] of Object.entries(PEOPLE)) {
    const pal = { ...SKIN, ...p.pal };
    at.add(`person${name}0`, art(p.rows, pal, personH, 0.15));
    at.add(`person${name}1`, art(waving(p.rows), pal, personH, 0.15));
  }
}

/** Civilians with a sprite (CIVILIANS in events.ts). */
export const PEOPLE_NAMES = Object.keys(PEOPLE);
