// Phase 5 story screens: the briefing scene (approved mockup mockups/campaign-ui/briefing-1080.png, src/briefing.html)
// used for the opening, the five region briefings and the ending; and the THE END / CAMPAIGN COMPLETE card.
// Same "UI pixel" grid, plates and masked 5x7 glyphs as the camp and the recruit card (ui-garage.ts / .css): a pixel
// backdrop of where the crew is (drawn at 2 UI px per pixel), portraits left and right with name plates, typed
// dialogue, and the answers with their rewards. The story itself is data in src/game/story.ts.
// Keys: ENTER / SPACE / click = finish the line, next line; 1-3 or ↑↓ + ENTER = answer; ESC held = skip.
// Pads: A next / answer, d-pad up/down, B held = skip. While open it swallows key presses (capture phase).
import { CREW } from './game/crew';
import type { Backdrop, Choice, Line, Page } from './game/story';
import { radioFace, uiPixel } from './ui-campaign';
import { Art, P, T, iconArt, setHazards } from './ui-garage';

export interface StoryOpts {
  pages: Page[];
  /** the reward line under an answer (Phase 5 events: and a red risk line) */
  label: (c: Choice) => { text: string; icon: string; cls: string; risk?: string };
  /** an answer was picked (choice index): apply it; returns the reply to type out (ASK FIRST hints) */
  onAnswer: (i: number) => Line | null;
  /** a new line starts typing (the app plays the radio blip) */
  onLine?: (who: string) => void;
  /** the scene is over; skipped = ESC held before an answer was given */
  onClose: (skipped: boolean) => void;
  /** ESC held at the answers takes answer 1 (briefings): the hold hint says so */
  skipTakesFirst?: boolean;
}

/** Characters typed per second, how long ESC must be held to skip, and the key guard after the scene opens. */
const CPS = 55;
const SKIP_MS = 700;
const ARM_MS = 450;

// ---------- pixel backdrops ----------
const hash = (x: number) => {
  let h = Math.imul(x | 0, 374761393);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
};

/** Sky in hard bands from the top colour to the horizon colour, a one-row dither at each seam. */
function sky(a: Art, hz: number, bands: string[], pow = 1.6): void {
  for (let y = 0; y < hz; y++) {
    const b = Math.min(bands.length - 1, Math.floor((y / hz) ** pow * bands.length));
    const prev = Math.floor((Math.max(0, y - 1) / hz) ** pow * bands.length);
    for (let x = 0; x < a.w; x++) a.set(x, y, b > 0 && prev < b && x % 2 ? bands[b - 1] : bands[b]);
  }
}
/** Stars, kept off the title (top left) and the skip hint (top right) so they don't read as accents on letters. */
function stars(a: Art, hz: number, n: number, dim = '#6a6f99', hi = '#f4efe2'): void {
  const top = Math.min(30, a.h * 0.1);
  for (let i = 0; i < n; i++) {
    const x = Math.floor(hash(i * 3 + 1) * a.w);
    const y = Math.floor(hash(i * 7 + 2) * hz);
    if (y < top && (x < a.w * 0.62 || x > a.w * 0.8)) continue;
    a.set(x, y, i % 5 ? dim : hi);
  }
}
/** Ground in hard bands from the horizon down, with speckles. */
function ground(a: Art, y0: number, cols: string[], speck: string, mul = 1.3): void {
  for (let y = y0; y < a.h; y++) {
    const b = Math.min(cols.length - 1, Math.floor(((y - y0) / Math.max(1, a.h - y0)) * cols.length * mul));
    for (let x = 0; x < a.w; x++) {
      let c = cols[b];
      if ((x * 7 + y * 3) % 11 === 0) c = cols[Math.min(cols.length - 1, b + 1)];
      if ((x * 5 + y * 13) % 17 === 0) c = speck;
      a.set(x, y, c);
    }
  }
}
/** Rolling silhouette line (tree line, hills) from y = base - height up. */
function ridge(a: Art, base: number, h0: number, amp: number, col: string, seed = 0, f = 0.21): void {
  for (let x = 0; x < a.w; x++) {
    const h = h0 + Math.round(amp * Math.sin(x * f + seed) + (amp * 0.6) * Math.sin(x * f * 2.5 + 1 + seed) + hash(x + seed * 99) * 2);
    for (let y = base - h; y < base + 2; y++) a.set(x, y, col);
  }
}
/** BABUSYA side-on, crew sitting on the turret, facing right; (tx, ty) = hull top left. */
function tank(a: Art, tx: number, ty: number, K = '#120e16', K2 = '#221a22', crew = 2): void {
  a.rect(tx, ty, 44, 6, K); a.rect(tx + 2, ty + 6, 40, 4, K);
  for (let i = 0; i < 7; i++) a.ell(tx + 5 + i * 5.6, ty + 8, 2.2, 2.2, K2);
  a.rect(tx + 12, ty - 6, 18, 6, K); a.rect(tx + 14, ty - 8, 12, 2, K);
  a.rect(tx + 30, ty - 5, 24, 2, K); a.rect(tx + 52, ty - 6, 3, 4, K);
  a.rect(tx + 8, ty - 3, 6, 3, K); a.rect(tx + 4, ty - 2, 3, 2, K);
  if (crew > 0) { a.rect(tx + 18, ty - 14, 3, 6, K); a.ell(tx + 19.5, ty - 16, 2, 2, K); }
  if (crew > 1) { a.rect(tx + 24, ty - 13, 3, 5, K); a.ell(tx + 25.5, ty - 15, 2, 2, K); }
  a.rect(tx + 15, ty - 19, 1, 6, K);
  a.rect(tx + 16, ty - 19, 4, 2, '#f8b800'); a.rect(tx + 16, ty - 18, 4, 1, '#3a8a10'); // ZORIANA's flag (sunflower gold over green) on the aerial
}
function sunflower(a: Art, x: number, y: number, stem = '#2a4a1a'): void {
  a.rect(x, y, 1, a.h - y, stem); a.rect(x - 2, y + 5, 2, 1, '#3a6a24');
  a.ell(x + 0.5, y, 3.2, 3.2, '#f8b800', (_x, _y, dx, dy) => (dx * dx + dy * dy < 0.25 ? '#5a3a1c' : dx + dy < -0.5 ? '#ffe08a' : '#f8b800'));
}
function pine(a: Art, x: number, base: number, h: number, col: string): void {
  for (let j = 0; j < h; j++) {
    const w = Math.round((j / h) * h * 0.32 + ((j % 4) === 3 ? -1 : 0));
    a.rect(x - w, base - h + j, 2 * w + 1, 1, col);
  }
  a.rect(x, base, 1, 2, col);
}

function drawFarm(a: Art, hz: number, spring: boolean): void {
  const SW = a.w;
  const SH = a.h;
  if (spring) sky(a, hz, ['#3a6ac8', '#4a7ad8', '#5a8ae0', '#6c9cff', '#8ab4ff', '#a8c8ff', '#c8dcff'], 1.2);
  else {
    sky(a, hz, ['#141a33', '#1d2342', '#2b2a4e', '#4a3358', '#7a3f55', '#b0524a', '#d8763c', '#f0a040']);
    stars(a, Math.round(hz * 0.4), 70);
  }
  if (spring) {
    a.ell(SW * 0.78, hz * 0.3, 9, 9, '#ffe08a', (_x, _y, dx, dy) => (dx * dx + dy * dy > 0.7 ? '#f8d060' : '#fff4c8'));
    for (const [cx, cy, w] of [[0.2, 0.25, 18], [0.5, 0.15, 24], [0.62, 0.42, 14]]) {
      a.ell(SW * cx, hz * cy, w, 3.5, '#e8f0ff'); a.ell(SW * cx + w * 0.4, hz * cy - 2, w * 0.5, 3, '#f4f8ff');
    }
  } else {
    a.ell(SW * 0.72, hz - 1, 13, 13, '#ffe08a', (_x, _y, _dx, dy) => (dy < -0.55 ? '#ffe08a' : dy < -0.2 ? '#f8d060' : '#f8b800'));
    // distant smoke columns: the war is still on the horizon
    for (const sx of [0.18, 0.86]) for (let y = hz - 30; y < hz; y++) {
      const w = 2 + (hz - y) * 0.18;
      const x0 = SW * sx + Math.sin(y * 0.25) * 2 + (hz - y) * 0.3;
      for (let x = Math.floor(x0 - w); x < x0 + w; x++) a.set(x, y, (x + y) % 3 ? '#3a2c3c' : '#4a3a48');
    }
  }
  ridge(a, hz, 4, 3, spring ? '#2a4a22' : '#1a1626');
  const em = spring ? ['#5a5048', '#6a5e54', '#8a7a6a'] : ['#2a2230', '#3a2e36', '#5a4a50'];
  for (let x = 0; x < SW; x++) { a.set(x, hz + 2, em[0]); a.set(x, hz + 3, em[1]); a.set(x, hz + 4, x % 3 ? em[0] : em[2]); a.set(x, hz + 5, em[0]); }
  const P1 = spring ? '#3a3a3a' : '#14111c';
  a.rect(Math.round(SW * 0.6), hz - 22, 1, 24, P1);
  a.rect(Math.round(SW * 0.6) - 1, hz - 24, 3, 4, P1); a.set(Math.round(SW * 0.6), hz - 23, spring ? '#7cd83a' : '#f0482a');
  for (const px of [0.08, 0.34, 0.92]) { const x = Math.round(SW * px); a.rect(x, hz - 18, 1, 20, P1); a.rect(x - 3, hz - 17, 7, 1, P1); }
  for (let x = 0; x < SW; x++) a.set(x, hz - 16 + Math.round(Math.abs(((x / SW) * 4 % 1) - 0.5) * 3), P1);
  if (spring) ground(a, hz + 6, ['#3a6a24', '#4a7a2a', '#5a8a30', '#6a9a34', '#7aaa3a'], '#2a4a1a');
  else ground(a, hz + 6, ['#5a3a1c', '#7a4e20', '#9a6a28', '#b88a34', '#c89a3c'], '#3a2410');
  const tx = Math.round(SW * 0.43);
  const ty = hz + 18;
  tank(a, tx, ty, spring ? '#1e2a16' : '#120e16', spring ? '#2e3a22' : '#221a22');
  const flowers = spring ? [[0.06, 0.8], [0.1, 0.84], [0.16, 0.9], [0.22, 0.82], [0.27, 0.95], [0.76, 0.84], [0.83, 0.86], [0.9, 0.93], [0.95, 0.82]] : [[0.1, 0.84], [0.16, 0.9], [0.83, 0.86], [0.9, 0.93], [0.27, 0.95]];
  for (const [fx, fy] of flowers) sunflower(a, Math.round(SW * fx), Math.round(SH * fy));
}

function drawRail(a: Art, hz: number): void {
  const SW = a.w;
  sky(a, hz, ['#0e1226', '#151a33', '#1e2240', '#2e2a4e', '#4a3458', '#6a3e58', '#8a4a50']);
  stars(a, Math.round(hz * 0.6), 90);
  a.ell(SW * 0.62, hz * 0.3, 5, 5, '#e8e2d0');
  a.ell(SW * 0.62 + 2.5, hz * 0.3 - 1, 4.4, 4.4, '#151a33'); // a crescent
  // far forest, then near firs
  for (let x = -4; x < SW + 4; x += 5) pine(a, x, hz, 10 + Math.round(hash(x) * 8), '#1a1a30');
  for (let x = -6; x < SW + 6; x += 9) pine(a, x + Math.round(hash(x + 5) * 4), hz + 4, 18 + Math.round(hash(x * 3) * 12), '#10121e');
  ground(a, hz + 4, ['#1a2018', '#222a1e', '#2a3424', '#323e2a'], '#141812');
  // the embankment and the track in front
  const ry = hz + 14;
  for (let x = 0; x < SW; x++) {
    a.set(x, ry, '#3a3440'); a.set(x, ry + 1, '#4e4640'); a.set(x, ry + 2, x % 4 === 0 ? '#6a5a48' : '#2a2228'); a.set(x, ry + 3, '#3a3036');
    for (let y = ry + 4; y < ry + 8; y++) a.set(x, y, (x + y) % 3 ? '#2a2620' : '#3a342a');
  }
  // a water tower and a derailed wagon (the line is ours now)
  const wx = Math.round(SW * 0.68);
  a.rect(wx - 6, ry - 30, 13, 9, '#14121c'); a.rect(wx - 5, ry - 31, 11, 1, '#14121c');
  for (const dx of [-5, 5]) a.rect(wx + dx, ry - 21, 1, 21, '#14121c');
  a.line(wx - 5, ry - 21, wx + 5, ry - 6, 0.4, '#14121c'); a.line(wx + 5, ry - 21, wx - 5, ry - 6, 0.4, '#14121c');
  const cx = Math.round(SW * 0.26);
  for (let j = 0; j < 12; j++) a.rect(cx + Math.round(j * 0.6), ry - 10 + j, 26, 1, '#1a1622');
  a.ell(cx + 6, ry + 2, 2.5, 2.5, '#221c26'); a.ell(cx + 24, ry + 2, 2.5, 2.5, '#221c26');
  // signal lamp, green now
  const sx = Math.round(SW * 0.62);
  a.rect(sx, ry - 24, 1, 24, '#14111c'); a.rect(sx - 1, ry - 26, 3, 4, '#14111c'); a.set(sx, ry - 25, '#7cd83a');
  tank(a, Math.round(SW * 0.4), ry - 10, '#0c0a10', '#1a1620');
}

function drawDelta(a: Art, hz: number): void {
  const SW = a.w;
  const SH = a.h;
  sky(a, hz, ['#2a3038', '#323a44', '#3a444e', '#46505a', '#545e66', '#626a70'], 1.1);
  // low clouds
  for (let i = 0; i < 8; i++) a.ell(hash(i + 40) * SW, hash(i + 50) * hz * 0.6, 20 + hash(i) * 20, 3 + hash(i + 9) * 3, '#3e4650');
  // far bank: fishermen's huts with warm windows
  ridge(a, hz, 2, 1, '#2a3230', 3, 0.1);
  for (const hx of [0.1, 0.18, 0.66, 0.74, 0.9]) {
    const x = Math.round(SW * hx);
    a.rect(x, hz - 7, 9, 7, '#20262a'); for (let j = 0; j < 4; j++) a.rect(x - 1 + j, hz - 8 - j, 11 - 2 * j, 1, '#20262a');
    a.set(x + 3, hz - 4, '#f8b800'); a.set(x + 4, hz - 4, '#c87000');
  }
  // the river: bands with ripple lines
  const rb = hz + Math.round((SH - hz) * 0.2);
  for (let y = hz; y < rb; y++) for (let x = 0; x < SW; x++) {
    let c = y < hz + 3 ? '#4a5a68' : (y - hz) % 5 === 2 && (x + y * 3) % 13 < 6 ? '#6a7a88' : '#3a4a58';
    if ((x * 3 + y * 7) % 23 === 0) c = '#7a8a98';
    a.set(x, y, c);
  }
  // a fishing boat
  const bx = Math.round(SW * 0.56);
  a.rect(bx, hz + 6, 16, 2, '#1a1e22'); a.rect(bx + 2, hz + 8, 12, 1, '#1a1e22'); a.rect(bx + 6, hz + 2, 1, 4, '#1a1e22'); a.rect(bx + 9, hz + 3, 3, 3, '#1a1e22');
  // near bank: mud and grass
  ground(a, rb, ['#2a3220', '#323a24', '#3a4228', '#424a2c'], '#1e2418', 1.6);
  tank(a, Math.round(SW * 0.36), rb + 1, '#0e1210', '#1c201c');
  // reeds in the foreground
  for (let i = 0; i < SW; i += 2) {
    if (hash(i + 7) < 0.45) continue;
    const x = i + Math.round(hash(i) * 2);
    const h = 8 + Math.round(hash(i + 3) * 18);
    const lean = hash(i + 11) < 0.5 ? -1 : 1;
    const root = Math.min(SH - 1, rb + 12 + Math.round(hash(i + 17) * 6));
    for (let j = 0; j < h; j++) a.set(x + (j > h * 0.6 ? lean : 0), root - j, j > h - 4 && hash(i + 13) < 0.4 ? '#6a4a2a' : j % 3 ? '#2a3a1e' : '#3a4a26');
  }
  // rain
  for (let i = 0; i < SW * SH * 0.0035; i++) {
    const x = Math.floor(hash(i * 5 + 1) * SW);
    const y = Math.floor(hash(i * 5 + 2) * SH);
    for (let j = 0; j < 3; j++) a.set(x - j, y + j * 2, '#8090a0');
  }
}

function drawRuins(a: Art, hz: number): void {
  const SW = a.w;
  sky(a, hz, ['#06070e', '#0a0c18', '#0e1222', '#141a2e', '#1c2238', '#262c42']);
  stars(a, hz - 10, 140, '#4a5078', '#f4efe2');
  a.ell(SW * 0.82, hz * 0.22, 6, 6, '#f4efe2', (_x, _y, dx, dy) => (dx + dy < -0.5 ? '#ffffff' : dx * dx + dy * dy < 0.15 ? '#c8ccd4' : '#e8e4d8'));
  // the skyline: blocks with jagged broken tops, a few windows lit (people are home again)
  let x = -2;
  let i = 0;
  while (x < SW) {
    const w = 10 + Math.round(hash(i * 3) * 18);
    const h = 16 + Math.round(hash(i * 3 + 1) * 34);
    const col = i % 2 ? '#0c0e16' : '#10121c';
    for (let dx = 0; dx < w; dx++) {
      const broken = hash(i * 7 + 2) < 0.6 ? Math.round(Math.abs(Math.sin(dx * 0.9 + i)) * (hash(i + 5) * 10)) : 0;
      for (let y = hz - h + broken; y < hz + 2; y++) a.set(x + dx, y, col);
    }
    for (let wy = hz - h + 6; wy < hz - 3; wy += 5) for (let wx = x + 2; wx < x + w - 2; wx += 4) {
      const r = hash(wx * 13 + wy * 7);
      if (r < 0.1) { a.rect(wx, wy, 2, 2, '#f8b800'); a.set(wx + 1, wy + 1, '#c87000'); } else if (r < 0.5) a.rect(wx, wy, 2, 2, '#06070c');
    }
    x += w + Math.round(hash(i * 3 + 2) * 4);
    i++;
  }
  ground(a, hz + 2, ['#1a1a20', '#22222a', '#2a2a32', '#323038'], '#101016', 1.4);
  // rubble heaps and a lamp post
  for (const [rx, rw] of [[0.08, 30], [0.7, 40]]) for (let dx = 0; dx < rw; dx++) {
    const h = Math.round(Math.sin((dx / rw) * Math.PI) * 9 + hash(dx + rx * 99) * 3);
    for (let y = 0; y < h; y++) a.set(Math.round(SW * rx) + dx, hz + 22 - y, (dx + y) % 4 ? '#1a1820' : '#2a2630');
  }
  const lx = Math.round(SW * 0.62);
  a.rect(lx, hz - 4, 1, 30, '#0a0a10'); a.rect(lx, hz - 4, 6, 1, '#0a0a10'); a.rect(lx + 5, hz - 3, 2, 2, '#ffe08a');
  a.ell(lx + 6, hz + 2, 6, 3, '#2a2620');
  tank(a, Math.round(SW * 0.34), hz + 24, '#08080c', '#16141c');
}

function drawWinter(a: Art, hz: number): void {
  const SW = a.w;
  const SH = a.h;
  sky(a, hz, ['#3a4a6a', '#4a5a7a', '#5e6c88', '#7a86a0', '#9aa2b4', '#c8b8b0', '#e8c8a8'], 1.3);
  a.ell(SW * 0.3, hz - 2, 10, 10, '#ffe8c8', (_x, _y, _dx, dy) => (dy < -0.4 ? '#fff4e0' : '#ffe0b8'));
  ridge(a, hz, 10, 4, '#8a94a8', 2, 0.05);
  ridge(a, hz, 4, 2, '#a8b0c0', 5, 0.11);
  // bunkers on the ridge (empty now) and anti-tank hedgehogs
  for (const bx of [0.58, 0.76]) {
    const x = Math.round(SW * bx);
    a.rect(x, hz - 6, 14, 6, '#4a5060'); a.rect(x + 1, hz - 7, 12, 1, '#e8eef4'); a.rect(x + 4, hz - 4, 6, 1, '#1a1c24');
  }
  ground(a, hz + 1, ['#c8d4e0', '#d8e2ec', '#e4ecf4', '#eef4f8'], '#b0bccc', 1.2);
  for (const hx of [0.08, 0.16, 0.86, 0.94]) {
    const x = Math.round(SW * hx);
    const y = hz + 16 + Math.round(hash(x) * 6);
    a.line(x - 4, y - 4, x + 4, y + 4, 0.5, '#3a3e4a'); a.line(x + 4, y - 4, x - 4, y + 4, 0.5, '#3a3e4a'); a.rect(x - 1, y - 6, 1, 10, '#3a3e4a');
  }
  // bare trees
  for (const tx of [0.04, 0.22, 0.68, 0.98]) {
    const x = Math.round(SW * tx);
    const h = 26 + Math.round(hash(x + 1) * 12);
    a.rect(x, hz - h + 6, 1, h, '#2a2e3a');
    for (let j = 0; j < 5; j++) { const y = hz - h + 8 + j * 5; a.line(x, y, x + (j % 2 ? 6 : -6), y - 4, 0.3, '#2a2e3a'); }
  }
  // tank tracks in the snow
  for (let x = 0; x < SW; x++) { const y = hz + 30 + Math.round(Math.sin(x * 0.03) * 2); if (x % 3) { a.set(x, y, '#b0bccc'); a.set(x, y + 4, '#b0bccc'); } }
  tank(a, Math.round(SW * 0.42), hz + 22, '#1a1c26', '#2a2c38');
  // snow on BABUSYA
  a.rect(Math.round(SW * 0.42) + 12, hz + 22 - 8, 14, 1, '#f4f8fc');
  // falling snow
  for (let i = 0; i < SW * SH * 0.008; i++) a.set(Math.floor(hash(i * 3 + 7) * SW), Math.floor(hash(i * 3 + 8) * SH), i % 3 ? '#f4f8fc' : '#c8d4e0');
}

const bgCache = new Map<string, Art>();
/** The backdrop at sw x sh pixels (tall = portrait: the horizon higher, the dialogue covers less of it). */
export function backdropArt(kind: Backdrop, sw: number, sh: number, tall: boolean): Art {
  const key = `${kind}|${sw}|${sh}|${tall}`;
  let a = bgCache.get(key);
  if (a) return a;
  a = new Art(sw, sh);
  const hz = Math.round(sh * (tall ? 0.36 : 0.56));
  if (kind === 'farm' || kind === 'spring') drawFarm(a, hz, kind === 'spring');
  else if (kind === 'rail') drawRail(a, hz);
  else if (kind === 'delta') drawDelta(a, hz);
  else if (kind === 'ruins') drawRuins(a, hz);
  else drawWinter(a, hz);
  if (bgCache.size > 8) bgCache.clear();
  bgCache.set(key, a);
  return a;
}

// ---------- shared bits ----------
const CALLS = new Map(CREW.map((c) => [c.call, c]));
/** Phase 5 events hook: name plates of speakers who are not crew (ui-events.ts fills it). */
export const PLATES = new Map<string, { name: string; sub: string }>();
function plateName(who: string): { name: string; sub: string; koval: boolean } {
  if (who === 'KOVAL' || who === 'HQ') return { name: 'MAJOR KOVAL', sub: 'HQ · CH 1', koval: true };
  const pl = PLATES.get(who);
  if (pl) return { ...pl, koval: false };
  const d = CALLS.get(who);
  return d ? { name: `${d.name} "${d.call}"`, sub: d.role, koval: false } : { name: who, sub: '', koval: false };
}

abstract class Overlay {
  root: HTMLElement;
  protected u = 3;
  protected alive = true;
  protected raf = 0;
  protected armed: number;
  protected padPrev: boolean[][] = [];

  constructor(cls: string) {
    this.root = document.createElement('div');
    this.root.id = 'gx';
    this.root.className = cls;
    setHazards(this.root);
    document.body.appendChild(this.root);
    this.armed = performance.now() + ARM_MS;
    window.addEventListener('keydown', this.kd, true);
    window.addEventListener('keyup', this.ku, true);
    window.addEventListener('resize', this.onResize);
    this.root.addEventListener('click', (e) => this.click(e));
    for (const gp of navigator.getGamepads?.() ?? []) if (gp) this.padPrev[gp.index] = gp.buttons.map((b) => b.pressed);
  }
  protected px(n: number): string { return `${n * this.u}px`; }
  protected kc(k: string, cls = ''): string { return `<span class="gx-kc ${cls}">${T(k, 2)}</span>`; }
  protected icon(name: string, s = this.u): string {
    const a = iconArt(name);
    return `<img src="${a.url()}" style="width:${a.w * s}px;height:${a.h * s}px" draggable="false">`;
  }
  protected backdrop(kind: Backdrop, tall: boolean): string {
    const ps = 2 * this.u;
    const a = backdropArt(kind, Math.ceil(innerWidth / ps), Math.ceil(innerHeight / ps), tall);
    return `<img class="gx-bg" src="${a.url()}" style="width:${a.w * ps}px;height:${a.h * ps}px" draggable="false">`;
  }
  protected dispose(): void {
    this.alive = false;
    cancelAnimationFrame(this.raf);
    window.removeEventListener('keydown', this.kd, true);
    window.removeEventListener('keyup', this.ku, true);
    window.removeEventListener('resize', this.onResize);
    this.root.remove();
  }
  // (listeners are fields of the base class, so they exist before the subclass constructor runs)
  private kd = (e: KeyboardEvent): void => { e.stopImmediatePropagation(); this.keyDown(e); };
  private ku = (e: KeyboardEvent): void => { e.stopImmediatePropagation(); this.keyUp(e.code); };
  protected onResize = (): void => { if (this.alive) this.render(); };
  protected abstract keyDown(e: KeyboardEvent): void;
  protected keyUp(_code: string): void {}
  protected abstract click(e: MouseEvent): void;
  abstract render(): void;
}

// ---------- the briefing scene ----------
class Scene extends Overlay {
  private page = 0;
  /** lines shown on this page (the last one is typing or typed) */
  private lines: Line[] = [];
  private shown = 0;
  private typed = 0;
  private lineStart = 0;
  private sel = 0;
  private chosen = -1;
  private escAt = 0;
  private padHold = 0;
  private typeEls: HTMLElement[] = [];
  private padDir = -1;

  constructor(private opts: StoryOpts) {
    super('gx-story');
    this.startPage(0);
    this.raf = requestAnimationFrame(this.tick);
  }

  private get pg(): Page { return this.opts.pages[this.page]; }
  private get typing(): boolean { return this.typed < this.cur.text.length; }
  private get cur(): Line { return this.lines[this.shown - 1]; }
  /** every line of the page is out (answers can be picked) */
  private get talked(): boolean { return this.shown >= this.lines.length && !this.typing; }

  private startPage(i: number): void {
    this.page = i;
    this.lines = [...this.pg.lines];
    this.shown = 0;
    this.chosen = -1;
    this.sel = 0;
    this.nextLine();
  }

  private nextLine(): void {
    this.shown++;
    this.typed = 0;
    this.lineStart = performance.now();
    this.opts.onLine?.(this.cur.who);
    this.render();
  }

  close(skipped: boolean): void {
    if (!this.alive) return;
    this.dispose();
    if (sceneCur === this) sceneCur = null;
    this.opts.onClose(skipped);
  }

  /** ENTER / A / click: finish the line, the next line, the answer, the next page. */
  private advance(): void {
    if (this.typing) {
      this.typed = this.cur.text.length;
      this.render();
      return;
    }
    if (this.shown < this.lines.length) { this.nextLine(); return; }
    const ch = this.pg.choices;
    if (ch?.length && this.chosen < 0) { this.answer(this.sel); return; }
    if (this.page + 1 < this.opts.pages.length) this.startPage(this.page + 1);
    else this.close(false);
  }

  private answer(i: number): void {
    const ch = this.pg.choices;
    if (!ch || this.chosen >= 0 || i < 0 || i >= ch.length) return;
    // answering early (1-3 while the lines still type) lets the whole page out first
    this.shown = this.lines.length;
    this.typed = this.cur.text.length;
    this.chosen = this.sel = i;
    const reply = this.opts.onAnswer(i);
    if (reply) {
      this.lines.push(reply);
      this.nextLine();
    } else if (this.page + 1 < this.opts.pages.length) this.startPage(this.page + 1);
    else this.close(false);
  }

  /** ESC held: the dialogue jumps to the answers; held again there (or on pages without answers) the scene ends. */
  private skip(): void {
    const last = this.opts.pages.length - 1;
    const ch = this.opts.pages[last].choices;
    if (ch?.length && this.chosen < 0 && !(this.page === last && this.talked)) {
      this.page = last;
      this.lines = [...this.pg.lines];
      this.shown = this.lines.length;
      this.typed = this.cur.text.length;
      this.render();
      return;
    }
    this.close(this.chosen < 0 && !!ch?.length);
  }

  private pickMove(d: number): void {
    const n = this.pg.choices?.length ?? 0;
    if (!n || this.chosen >= 0) return;
    this.sel = (this.sel + d + n) % n;
    this.render();
  }

  protected keyDown(e: KeyboardEvent): void {
    const c = e.code;
    const keys = ['ArrowUp', 'ArrowDown', 'KeyW', 'KeyS', 'Enter', 'NumpadEnter', 'Space', 'Escape', 'Backspace', 'Tab'];
    if (keys.includes(c) || /^(Digit|Numpad)[1-3]$/.test(c)) e.preventDefault();
    if (c === 'Escape' || c === 'Backspace') {
      if (!this.escAt && !e.repeat) this.escAt = performance.now();
      return;
    }
    if (e.repeat || performance.now() < this.armed) return;
    if (c === 'ArrowUp' || c === 'KeyW') this.pickMove(-1);
    else if (c === 'ArrowDown' || c === 'KeyS') this.pickMove(1);
    else if (c === 'Enter' || c === 'NumpadEnter' || c === 'Space') this.advance();
    else if (/^(Digit|Numpad)[1-3]$/.test(c)) this.answer(Number(c.slice(-1)) - 1);
  }

  protected keyUp(code: string): void {
    if (code === 'Escape' || code === 'Backspace') { this.escAt = 0; this.drawHold(0); }
  }

  protected click(e: MouseEvent): void {
    if (performance.now() < this.armed) return;
    const a = (e.target as HTMLElement).closest<HTMLElement>('[data-act]')?.dataset.act;
    if (a?.startsWith('pick:')) this.answer(Number(a.slice(5)));
    else if (a === 'skip') this.skip();
    else this.advance();
  }

  private tick = (now: number): void => {
    if (!this.alive) return;
    // typing
    if (this.typing) {
      this.typed = Math.min(this.cur.text.length, Math.floor(((now - this.lineStart) / 1000) * CPS));
      this.showTyped();
      if (!this.typing) this.render();
    }
    // pads: A advances / answers, B held skips, d-pad picks
    let dir = -1;
    let hold = false;
    for (const gp of navigator.getGamepads?.() ?? []) {
      if (!gp || !gp.connected) continue;
      const b = (i: number) => !!gp.buttons[i]?.pressed;
      const prev = this.padPrev[gp.index] ?? [];
      const hit = (i: number) => b(i) && !prev[i] && now >= this.armed;
      this.padPrev[gp.index] = gp.buttons.map((x) => x.pressed);
      if (hit(0)) this.advance();
      if (!this.alive) return;
      hold ||= b(1);
      const ay = gp.axes[1] ?? 0;
      if (dir < 0) dir = b(12) || ay < -0.5 ? 0 : b(13) || ay > 0.5 ? 2 : -1;
    }
    if (dir !== this.padDir) {
      this.padDir = dir;
      if (dir >= 0 && now >= this.armed) this.pickMove(dir === 0 ? -1 : 1);
    }
    if (hold && !this.padHold) this.padHold = now;
    if (!hold) this.padHold = 0;
    const since = Math.max(this.escAt ? now - this.escAt : 0, this.padHold ? now - this.padHold : 0);
    this.drawHold(Math.min(1, since / SKIP_MS));
    if (since >= SKIP_MS) {
      this.escAt = this.escAt ? now : 0;
      this.padHold = this.padHold ? now : 0;
      this.skip();
      if (!this.alive) return;
    }
    this.raf = requestAnimationFrame(this.tick);
  };

  private drawHold(f: number): void {
    const bar = this.root.querySelector<HTMLElement>('.gx-hold i');
    if (bar) bar.style.width = `${Math.round(f * 100)}%`;
  }

  /** Reveal the typed glyphs of the current line (the line's whole text is laid out from the start). */
  private showTyped(): void {
    let n = 0;
    const text = this.cur.text;
    for (let i = 0; i < this.typed && i < text.length; i++) if (text[i] !== ' ') n++;
    this.typeEls.forEach((el, i) => { el.style.visibility = i < n ? '' : 'hidden'; });
  }

  /** Left portrait: KOVAL when he is on the page, else the first speaker; right: the latest other speaker. */
  private speakers(): { left: string; right: string; now: string } {
    const seen = this.lines.slice(0, this.shown);
    const all = this.lines;
    const left = all.some((l) => l.who === 'KOVAL') ? 'KOVAL' : all[0].who;
    const others = (ls: Line[]) => ls.filter((l) => l.who !== left).map((l) => l.who);
    const right = others(seen).pop() ?? others(all)[0] ?? (left === 'KOVAL' ? 'TRACTOR' : 'SPANNER');
    return { left, right, now: this.cur.who };
  }

  render(): void {
    if (!this.alive) return;
    const W = innerWidth;
    const H = innerHeight;
    const u = (this.u = uiPixel(W, H));
    const tall = W / u < 600;
    const md = u;
    const lg = u + 1;
    const pg = this.pg;
    const root = this.root;
    root.className = `gx-story ${tall ? 'tall' : ''} ${u < 3 ? 'tight' : ''}`;
    root.style.setProperty('--u', `${u}px`);
    const { left, right, now } = this.speakers();

    // dialogue: the last three lines out, the current one big and typing
    const whoW = 6 * 7 * md + 2 * u;
    const out = this.lines.slice(0, this.shown).map((l, i) => ({ l, i })).slice(tall ? -2 : -3);
    const line = ({ l, i }: { l: Line; i: number }) => {
      const cur = i === this.shown - 1;
      const col = l.who === 'KOVAL' ? 'c-blue' : 'c-gold';
      const done = cur && !this.typing;
      return `<div class="gx-row" style="align-items:flex-start;gap:${this.px(4)}">
        <span style="width:${whoW}px;flex:none">${T(l.who, md, cur ? col : 'c-mute')}</span>
        <div style="flex:1"><div class="${cur ? 'gx-typing' : ''}">${P(l.text, cur && !tall ? lg : md, cur ? 'c-ink' : 'c-mute')}</div>
        ${done ? `<span class="gx-blink" style="display:inline-block;margin-top:${this.px(2)}">${T('▶', md, 'c-gold')}</span>` : ''}</div></div>`;
    };
    const talk = `<div class="gx-col gx-talk" style="gap:${this.px(5)};justify-content:flex-end">${out.map(line).join('')}</div>`;

    // answers (or CONTINUE on pages without them)
    const ch = pg.choices ?? [];
    const ready = this.talked || this.chosen >= 0;
    const choice = (c: Choice, i: number) => {
      const on = this.chosen >= 0 ? i === this.chosen : i === this.sel;
      const lab = this.opts.label(c);
      const off = this.chosen >= 0 && i !== this.chosen;
      return `<div class="gx-choice ${on ? 'on' : ''} ${off ? 'off' : ''}" data-act="pick:${i}">
        ${this.kc(String(i + 1), on ? 'gold' : '')}<div class="gx-col" style="gap:${this.px(2)}">${P(c.text, 2, on ? 'c-ink' : 'c-dim')}
        <span class="gx-row" style="gap:${this.px(2)}">${lab.icon ? this.icon(lab.icon, 2) : ''}${T(lab.text, 2, lab.cls)}</span>${lab.risk ? T(lab.risk, 2, 'c-red') : ''}</div></div>`;
    };
    const last = this.page === this.opts.pages.length - 1;
    const cont = `<div class="gx-choice ${ready ? 'on' : ''}" data-act="next">${this.kc('ENTER', ready ? 'gold' : '')}<div class="gx-col" style="gap:${this.px(2)}">
      ${T(last ? 'FINISH' : 'CONTINUE', 2, ready ? 'c-ink' : 'c-dim')}${T(`${this.page + 1} / ${this.opts.pages.length}`, 2, 'c-mute')}</div></div>`;
    const answers = `<div class="gx-col" style="gap:${this.px(4)};justify-content:flex-end">
      ${T(ch.length ? (this.chosen >= 0 ? 'YOU SAID' : 'YOUR ANSWER') : 'RADIO', 2, 'c-mute')}${ch.length ? ch.map(choice).join('') : cont}</div>`;

    // portraits and name plates
    // 2-px UI pixels (720p): the fixed-size small text is relatively bigger, so the box grows and the faces shrink
    const tight = u < 3;
    const PORT = (tall || tight ? 3 : 4) * u;
    const face = (who: string, lit: boolean, flip: boolean) => `<div class="gx-plate gx-pf ${lit ? '' : 'dim'}"><img src="${radioFace(who)}" style="width:${32 * PORT}px;height:${32 * PORT}px${flip ? ';transform:scaleX(-1)' : ''}" draggable="false">${lit ? '<div class="gx-static"></div>' : ''}</div>`;
    const plate = (side: 'l' | 'r', who: string) => {
      const p = plateName(who);
      const lit = who === now;
      return `<div class="gx-nameplate ${side}">${p.koval ? this.icon('signal') : ''}${T(p.name, md, lit ? (p.koval ? 'c-blue' : 'c-gold') : 'c-mute')}${p.sub && (lit || p.koval) ? T(p.sub, 2, 'c-dim') : ''}</div>`;
    };
    const title = `<div class="gx-col" style="gap:${this.px(3)}">
      <span class="gx-row" style="gap:${this.px(3)};flex-wrap:wrap">${pg.tag ? `<span class="gx-tag">${T(pg.tag, 2)}</span>` : ''}${pg.sub ? T(pg.sub, 2, 'c-ink gx-sh') : ''}</span>
      <span class="gx-sh">${T(pg.title, tall ? lg + 1 : 2 * u, 'c-steel')}</span></div>`;
    const atAnswers = !!this.opts.skipTakesFirst && !!pg.choices?.length && this.chosen < 0 && this.talked;
    const hint = `<div class="gx-hints gx-sh" data-act="skip"><span>${this.kc('ESC')}${T(atAnswers ? 'HOLD FOR ANSWER 1' : 'HOLD TO SKIP', 2)}</span><span class="gx-hold"><i></i></span></div>`;
    const bg = this.backdrop(pg.bg, tall);
    const boxH = tight ? 150 : 108;
    const colW = tight ? 250 : 200;
    if (tall) {
      root.innerHTML = `${bg}<div class="gx-scan"></div><div class="gx-page" style="justify-content:flex-end">
        <div class="gx-row" style="justify-content:space-between;align-items:flex-start;flex-wrap:wrap;row-gap:${this.px(4)}">${title}${hint}</div>
        <div class="gx-sp"></div>
        <div class="gx-row" style="justify-content:space-between;align-items:flex-end">${face(left, now === left, false)}${face(right, now === right, true)}</div>
        <div class="gx-plate riv gx-col" style="gap:${this.px(8)};padding:${this.px(6)};padding-top:${this.px(10)}">${plate('l', now === right ? right : left)}${talk}</div>
        <div class="gx-plate riv" style="padding:${this.px(6)}">${answers}</div></div>`;
    } else {
      root.innerHTML = `${bg}<div class="gx-scan"></div>
        <div class="gx-abs" style="left:${this.px(8)};top:${this.px(8)}">${title}</div>
        <div class="gx-abs" style="right:${this.px(8)};top:${this.px(10)}">${hint}</div>
        <div class="gx-abs" style="left:${this.px(16)};bottom:${this.px(boxH + 8)}">${face(left, now === left, false)}</div>
        <div class="gx-abs" style="right:${this.px(16)};bottom:${this.px(boxH + 8)}">${face(right, now === right, true)}</div>
        <div class="gx-abs gx-plate riv" style="left:${this.px(8)};right:${this.px(8)};bottom:${this.px(8)};height:${this.px(boxH - 8)};display:grid;grid-template-columns:1fr ${this.px(colW)};gap:${this.px(8)};padding:${this.px(6)}">
          ${plate('l', left)}${plate('r', right)}${talk}${answers}</div>`;
    }
    this.typeEls = [...root.querySelectorAll<HTMLElement>('.gx-typing .px i:not(.sp)')];
    this.showTyped();
  }
}

let sceneCur: Scene | null = null;

/** Show a story scene (opening, briefing, ending) over everything. */
export function openStory(opts: StoryOpts): void {
  sceneCur?.close(true);
  sceneCur = new Scene(opts);
}
export function storyOpen(): boolean {
  return sceneCur !== null || completeCur !== null;
}

// ---------- THE END / CAMPAIGN COMPLETE ----------
export interface CompleteOpts {
  rows: [string, string][];
  /** call signs aboard, in roster order */
  crew: string[];
  title: string;
  onClose: () => void;
}

class Complete extends Overlay {
  private t0 = performance.now();
  constructor(private opts: CompleteOpts) {
    super('gx-story gx-end');
    this.render();
    this.raf = requestAnimationFrame(this.tick);
  }
  close(): void {
    if (!this.alive) return;
    this.dispose();
    if (completeCur === this) completeCur = null;
    this.opts.onClose();
  }
  /** the rows count up one by one; ENTER first shows them all, then closes */
  private shownRows(): number { return Math.floor((performance.now() - this.t0 - 500) / 160); }
  private go(): void {
    if (this.shownRows() < this.opts.rows.length) { this.t0 = -1e9; this.render(); return; }
    this.close();
  }
  protected keyDown(e: KeyboardEvent): void {
    if (['Enter', 'NumpadEnter', 'Space', 'Escape'].includes(e.code)) e.preventDefault();
    if (e.repeat || performance.now() < this.armed) return;
    if (['Enter', 'NumpadEnter', 'Space', 'Escape'].includes(e.code)) this.go();
  }
  protected click(): void { if (performance.now() >= this.armed) this.go(); }
  private last = -2;
  private tick = (now: number): void => {
    if (!this.alive) return;
    for (const gp of navigator.getGamepads?.() ?? []) {
      if (!gp || !gp.connected) continue;
      const prev = this.padPrev[gp.index] ?? [];
      const hit = (i: number) => !!gp.buttons[i]?.pressed && !prev[i] && now >= this.armed;
      this.padPrev[gp.index] = gp.buttons.map((x) => x.pressed);
      if (hit(0) || hit(1) || hit(9)) { this.go(); if (!this.alive) return; }
    }
    const n = Math.min(this.opts.rows.length, this.shownRows());
    if (n !== this.last) { this.last = n; this.render(); }
    this.raf = requestAnimationFrame(this.tick);
  };
  render(): void {
    if (!this.alive) return;
    const W = innerWidth;
    const H = innerHeight;
    const u = (this.u = uiPixel(W, H));
    const tall = W / u < 600;
    this.root.className = `gx-story gx-end ${tall ? 'tall' : ''} ${u < 3 ? 'tight' : ''}`;
    this.root.style.setProperty('--u', `${u}px`);
    const n = this.shownRows();
    const rows = this.opts.rows.map(([k, v], i) => `<div class="k" style="visibility:${i < n ? 'visible' : 'hidden'}">${T(k, 2, 'c-dim')}</div>
      <div class="v" style="visibility:${i < n ? 'visible' : 'hidden'}">${T(v, u, 'c-ink')}</div>`).join('');
    const done = n >= this.opts.rows.length;
    const FS = 2 * u;
    const crew = this.opts.crew.map((c) => `<div class="gx-col" style="align-items:center;gap:${this.px(2)}"><div class="gx-well" style="padding:${this.px(1)}"><img src="${radioFace(c)}" style="width:${32 * FS / 2}px;height:${32 * FS / 2}px" draggable="false"></div>${T(c, 2, 'c-gold')}</div>`).join('');
    this.root.innerHTML = `${this.backdrop('spring', tall)}<div class="gx-veil"></div><div class="gx-scan"></div>
      <div class="gx-endwrap"><div class="gx-plate riv gx-col gx-endcard" style="align-items:center;gap:${this.px(6)};padding:${this.px(8)} ${this.px(12)}">
        <div class="gx-hdr" style="align-self:stretch">${T(this.opts.title, 2, 'c-gold')}${T('CAMPAIGN COMPLETE', 2, 'c-green')}</div>
        <span class="gx-sh">${T('THE END', 3 * u, 'c-steel')}</span>
        ${T('THE FRONT HOLDS · THE ROADS ARE OPEN', 2, 'c-gold')}
        <div class="gx-kv">${rows}</div>
        <div class="gx-row" style="gap:${this.px(5)};flex-wrap:wrap;justify-content:center;align-items:flex-start">${crew}</div>
        ${P('LIBERATION MODE IS OPEN: CONTINUE FROM THE CAMPAIGN MENU TO KEEP FREEING REGIONS.', 2, 'c-blue')}
        <div class="gx-hints" style="visibility:${done ? 'visible' : 'hidden'}"><span>${this.kc('ENTER', 'gold')}${T('BACK TO THE TITLE', 2, 'c-ink')}</span></div>
      </div></div>`;
  }
}

let completeCur: Complete | null = null;
/** The THE END / CAMPAIGN COMPLETE card with the run's totals and the crew. */
export function openComplete(opts: CompleteOpts): void {
  completeCur?.close();
  completeCur = new Complete(opts);
}
