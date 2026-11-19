// Phase 5: the camp's MAP tab (approved mockup mockups/campaign-ui/region-map-1080.png, src/map.html): the strip of the
// campaign's five regions (freed / current / ahead), the current region's real cells drawn small with its towns
// (held / freed), depots (standing / destroyed), the boss (once revealed) and the tank; the selected town's card; and
// the liberation, boss and ready-check plates. Built from the live World at a workshop, or from the next region's
// map (RegionSpec) in the camp between regions. ui-garage.ts calls renderMapTab from its Camp screen.
import { BRICK, ICE, RAIL, ROAD, STEEL, TREES, WATER } from './game/constants';
import { ABILITY_ICONS, aboard, crewUnlocks, repairCost } from './game/crew';
import type { RegionSpec } from './game/region';
import type { RunState } from './game/run';
import { REGION_TABLE } from './game/save';
import { ENV_LABEL } from './game/stages';
import { ROMAN, STORY_REGIONS } from './game/story';
import { FREE_SCRAP, type World } from './game/world';
import { radioFace } from './ui-campaign';
import { Art, P, T, babusyaDoll, iconArt } from './ui-garage'; // campaign looks: babusyaDoll

export interface CampMapTown { name: string; cx: number; cy: number; freed: boolean; garrison: number | null }
export interface CampMap {
  /** run region index of the map */
  region: number;
  name: string;
  env: string;
  w: number;
  h: number;
  cells: Uint8Array;
  /** bumps when the cells change (destroyed walls), for the terrain cache */
  version: number;
  towns: CampMapTown[];
  depots: { name: string; cx: number; cy: number; destroyed: boolean }[];
  boss: { name: string; title: string; known: boolean; dead: boolean; cx: number; cy: number; need: number; near: string } | null;
  /** the players' tanks (world px), when in the region */
  players: { cx: number; cy: number }[];
  /** the next region, not entered yet (the camp between regions) */
  ahead: boolean;
}

/** Enemies within this many px of a town's flag count as its garrison on the map. */
const GARRISON_R = 72;

export function campMapFromWorld(w: World, region: number): CampMap {
  const b = w.boss;
  const known = !!b && b.state !== 'hidden';
  let near = '';
  if (b) {
    let bd = Infinity;
    for (const t of w.towns) { const d = (t.cx - b.cx) ** 2 + (t.cy - b.cy) ** 2; if (d < bd) { bd = d; near = t.name; } }
  }
  return {
    region, name: w.def.name, env: w.envLabel, w: w.map.w, h: w.map.h, cells: w.map.c, version: w.map.version,
    towns: w.towns.map((t) => ({
      name: t.name, cx: t.cx, cy: t.cy, freed: t.freed,
      garrison: t.freed ? 0 : w.enemies.filter((e) => e.alive && Math.hypot(e.cx - t.cx, e.cy - t.cy) < GARRISON_R).length,
    })),
    depots: (w.depots.length ? w.depots : (w.region?.depots ?? []).map((d) => ({ ...d, destroyed: false }))).map((d) => ({ name: d.name, cx: d.cx, cy: d.cy, destroyed: d.destroyed })),
    boss: b ? { name: b.name, title: b.title, known, dead: b.state === 'dead' || b.state === 'dying', cx: b.cx, cy: b.cy, need: b.townsToReveal(), near } : null,
    players: w.players.filter((p) => !!p && p.alive).map((p) => ({ cx: p!.cx, cy: p!.cy })),
    ahead: false,
  };
}

export function campMapFromSpec(spec: RegionSpec, region: number): CampMap {
  return {
    region, name: spec.name, env: ENV_LABEL[spec.env] ?? '', w: spec.w, h: spec.h, cells: spec.cells, version: -1,
    towns: (spec.towns ?? []).map((t) => ({ name: t.name, cx: t.cx, cy: t.cy, freed: false, garrison: t.garrison.length })),
    depots: (spec.depots ?? []).map((d) => ({ name: d.name, cx: d.cx, cy: d.cy, destroyed: false })),
    boss: { name: '', title: '', known: false, dead: false, cx: 0, cy: 0, need: Math.min(3, spec.towns?.length ?? 3), near: '' },
    players: [], ahead: true,
  };
}

// ---------- the terrain picture ----------
type RGB = [number, number, number];
const hex = (h: string): RGB => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16)) as RGB;
const TER: RGB[] = [];
TER[0] = hex('#4a5a30');
TER[BRICK] = hex('#a0704a');
TER[STEEL] = hex('#8a919b');
TER[WATER] = hex('#2e5488');
TER[TREES] = hex('#2a3e1e');
TER[ICE] = hex('#a8c4d0');
TER[ROAD] = hex('#7a6c4c');
TER[RAIL] = hex('#4e4640');
const mix = (a: RGB, b: RGB, t: number): RGB => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
const RED = hex('#f0482a');
const GOLD = hex('#f8b800');

let terrainKey = '';
let terrainUrl = '';
/** n x m pixels, each the main cell type of a k x k block of cells, tinted by the nearest town (gold freed, red held). */
function terrain(m: CampMap, k: number, n: number, mh: number): string {
  const key = `${m.region}|${m.name}|${m.version}|${k}|${m.towns.map((t) => +t.freed).join('')}|${m.ahead}`;
  if (key === terrainKey) return terrainUrl;
  const cv = document.createElement('canvas');
  cv.width = n;
  cv.height = mh;
  const g = cv.getContext('2d')!;
  const img = g.createImageData(n, mh);
  const D = img.data;
  const sec = new Int16Array(n * mh);
  const cnt = new Float32Array(8);
  for (let y = 0; y < mh; y++) for (let x = 0; x < n; x++) {
    const wx = (x + 0.5) * k * 4;
    const wy = (y + 0.5) * k * 4;
    let bi = -1;
    let bd = Infinity;
    m.towns.forEach((t, i) => { const d = (t.cx - wx) ** 2 + (t.cy - wy) ** 2; if (d < bd) { bd = d; bi = i; } });
    sec[y * n + x] = bi;
  }
  for (let y = 0; y < mh; y++) {
    const y0 = Math.floor(y * k);
    const y1 = Math.max(y0 + 1, Math.min(m.h, Math.floor((y + 1) * k)));
    for (let x = 0; x < n; x++) {
      const x0 = Math.floor(x * k);
      const x1 = Math.max(x0 + 1, Math.min(m.w, Math.floor((x + 1) * k)));
      cnt.fill(0);
      for (let yy = y0; yy < y1; yy++) for (let xx = x0; xx < x1; xx++) cnt[m.cells[yy * m.w + xx] & 7] += 1;
      cnt[0] *= 0.5;
      let t = 0;
      let bv = -1;
      for (let q = 0; q < 8; q++) if (cnt[q] > bv && TER[q]) { bv = cnt[q]; t = q; }
      let col = TER[t] ?? TER[0];
      if (t === 0 && y % 4 === 0) col = mix(col, [0, 0, 0], 0.12); // crop rows
      const s = sec[y * n + x];
      if (s >= 0) {
        col = m.towns[s].freed ? mix(col, GOLD, 0.14) : mix(col, RED, 0.16);
        const edge = (x + 1 < n && sec[y * n + x + 1] !== s) || (y + 1 < mh && sec[(y + 1) * n + x] !== s);
        if (edge && (x + y) % 3 !== 0) col = hex('#d8d0b8');
      }
      const o = (y * n + x) * 4;
      D[o] = col[0];
      D[o + 1] = col[1];
      D[o + 2] = col[2];
      D[o + 3] = 255;
    }
  }
  g.putImageData(img, 0, 0);
  terrainKey = key;
  terrainUrl = cv.toDataURL();
  return terrainUrl;
}

// ---------- the tab ----------
export interface MapHelpers {
  u: number;
  px(n: number): string;
  kc(k: string, cls?: string, act?: string): string;
  segs(n: number, on: number, w: number, h: number, mark?: Record<number, string>, cls?: string): string;
}

const HELD = { g: 'r', h: '#ffb09a', o: 'q' };
const DEPOT_UP = { l: 'r', w: '#ffb09a', m: 'q' };
const DEPOT_DOWN = { l: 'd', m: 'y', w: 'd' };
const RED_TANK = { g: 'r', h: '#ffb09a', o: 'q' };
const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? '' : 'S'}`;
const DIRS = ['EAST', 'SOUTH-EAST', 'SOUTH', 'SOUTH-WEST', 'WEST', 'NORTH-WEST', 'NORTH', 'NORTH-EAST'];

/** The boss marker: a crosshair ring, red while it stands, grey once it is a wreck. */
const crossCache = new Map<boolean, Art>();
function crosshair(dead: boolean): Art {
  let a = crossCache.get(dead);
  if (a) return a;
  a = new Art(13, 13);
  const c = dead ? '#8a919b' : '#f0482a';
  for (let i = 0; i < 24; i++) { const t = (i / 24) * Math.PI * 2; a.set(Math.round(6 + Math.cos(t) * 4.6), Math.round(6 + Math.sin(t) * 4.6), c); }
  for (let i = 0; i < 13; i++) if (i < 4 || i > 8) { a.set(i, 6, c); a.set(6, i, c); }
  a.set(6, 6, dead ? '#c6ccd4' : '#ffe08a');
  crossCache.set(dead, a.outline());
  return a;
}

function img(a: Art, s: number, style = ''): string {
  return `<img src="${a.url()}" style="width:${a.w * s}px;height:${a.h * s}px;${style}" draggable="false">`;
}
function icon(name: string, s: number, remap?: Record<string, string>, style = ''): string {
  return img(iconArt(name, remap), s, style);
}

/** The five regions of the current lap: freed, here, ahead. */
function strip(H: MapHelpers, run: RunState, m: CampMap): string {
  const lap = Math.floor(m.region / STORY_REGIONS);
  const freed = m.towns.filter((t) => t.freed).length;
  const out: string[] = [];
  for (let i = 0; i < STORY_REGIONS; i++) {
    const idx = lap * STORY_REGIONS + i;
    const st = idx < m.region ? 'done' : idx === m.region ? 'on' : 'off';
    const name = REGION_TABLE[i].name;
    const sub = st === 'on'
      ? T(m.ahead ? 'NEXT' : `${freed}/${m.towns.length} TOWNS`, 2, 'c-gold')
      : st === 'done' ? T('FREED', 2, 'c-green')
        : `<span class="gx-row" style="gap:${H.px(2)}">${icon('lock', 2)}${T('LOCKED', 2, 'c-mute')}</span>`;
    if (i) out.push(`<div class="gx-dash ${st === 'off' ? '' : 'done'}"></div>`);
    out.push(`<div class="gx-plate flat gx-reg ${st}">${T(ROMAN[i], 2 * H.u, st === 'on' ? 'c-gold' : st === 'done' ? 'c-green' : 'c-steel')}
      <div class="gx-col" style="gap:${H.px(2)}">${T(name, 2, st === 'off' ? 'c-dim' : 'c-ink')}${sub}</div></div>`);
  }
  void run;
  return `<div class="gx-strip">${out.join('')}</div>`;
}

/**
 * The MAP tab's body. sel = the selected town (TAB cycles). maxW / maxH = room for the map picture in UI px.
 */
export function renderMapTab(H: MapHelpers, run: RunState, m: CampMap, sel: number, tall: boolean, armour: [number, number][], players: number): string {
  const u = H.u;
  const md = u;
  const W = Math.floor(innerWidth / u);
  const Hh = Math.floor(innerHeight / u);
  const maxW = tall ? W - 30 : Math.floor((W - 16) * 0.36);
  const maxH = tall ? Math.floor(Hh * 0.45) : Hh - 128;
  // cells per map pixel: whole quarters, so the picture fits its box
  const k = Math.max(1, Math.ceil(Math.max(m.w / maxW, m.h / maxH) * 4) / 4);
  const n = Math.ceil(m.w / k);
  const mh = Math.ceil(m.h / k);
  const pos = (cx: number, cy: number) => `left:${H.px(cx / (4 * k))};top:${H.px(cy / (4 * k))}`;
  const towns = m.towns;
  const sel0 = towns.length ? ((sel % towns.length) + towns.length) % towns.length : -1;
  const T0 = sel0 >= 0 ? towns[sel0] : null;

  // ----- the map -----
  let marks = '';
  m.depots.forEach((d) => { marks += `<div class="gx-mk" style="${pos(d.cx, d.cy)}">${icon('depot', u, d.destroyed ? DEPOT_DOWN : DEPOT_UP, d.destroyed ? 'opacity:.7' : '')}</div>`; });
  towns.forEach((t, i) => {
    const on = i === sel0;
    // keep the name label inside the map: half the label's width (screen px) from either edge
    const half = (t.name.length * 12 + 4 * u) / 2;
    const x0 = (t.cx / (4 * k)) * u;
    const dx = Math.max(half, Math.min(n * u - half, x0)) - x0;
    marks += `<div class="gx-mk town ${on ? 'sel' : ''}" data-act="town:${i}" style="${pos(t.cx, t.cy)}">${icon('town', u, t.freed ? undefined : HELD)}
      <span class="lbl" style="transform:translateX(${Math.round(dx)}px)">${T(t.name, 2, on ? '' : t.freed ? 'c-gold' : 'c-red')}</span></div>`;
  });
  const b = m.boss;
  if (b?.known) {
    marks += `<div class="gx-mk" style="${pos(b.cx, b.cy)}">${img(crosshair(b.dead), u)}</div>`;
  }
  m.players.forEach((p, i) => { marks += `<div class="gx-mk" style="${pos(p.cx, p.cy)}">${icon('tank16', u, i ? { g: 'G', h: '#c4f59a', o: 'n' } : undefined)}</div>`; });
  if (T0) {
    const x = T0.cx / (4 * k);
    const y = T0.cy / (4 * k);
    marks += `<div class="gx-abs gx-blink" style="left:${H.px(x - 14)};top:${H.px(y - 12)};width:${H.px(28)};height:${H.px(24)};
      background:linear-gradient(var(--gold-hi),var(--gold-hi)) left top/${H.px(5)} ${H.px(1)} no-repeat,linear-gradient(var(--gold-hi),var(--gold-hi)) left top/${H.px(1)} ${H.px(5)} no-repeat,
      linear-gradient(var(--gold-hi),var(--gold-hi)) right top/${H.px(5)} ${H.px(1)} no-repeat,linear-gradient(var(--gold-hi),var(--gold-hi)) right top/${H.px(1)} ${H.px(5)} no-repeat"></div>`;
  }
  const legend: [string, string, Record<string, string> | undefined][] = [['town', 'FREED', undefined], ['town', 'HELD', HELD], ['depot', 'DEPOT', DEPOT_UP], ['boss', 'BOSS', undefined], ['tank16', 'YOU', undefined]];
  const rnum = ROMAN[m.region % STORY_REGIONS] + (m.region >= STORY_REGIONS ? '+' : '');
  const mapPlate = `<div class="gx-plate riv" style="padding:${H.px(3)};align-self:start">
    <div class="gx-hdr" style="margin:${H.px(-3)} ${H.px(-3)} ${H.px(3)};padding:${H.px(2)} ${H.px(3)}">${T(`REGION ${rnum} · ${m.name}`, 2, 'c-gold')}${T(m.env, 2, 'c-dim')}</div>
    <div class="gx-well gx-mapbox" style="width:${H.px(n)};height:${H.px(mh)}"><img src="${terrain(m, k, n, mh)}" style="position:absolute;left:0;top:0;width:${H.px(n)};height:${H.px(mh)}" draggable="false">${marks}</div>
    <div class="gx-row" style="justify-content:space-between;margin-top:${H.px(3)};gap:${H.px(4)}">${legend.map(([i, l, r]) => `<span class="gx-row" style="gap:${H.px(1)}">${i === 'boss' ? img(crosshair(false), 2) : icon(i, 2, r)}${T(l, 2, 'c-dim')}</span>`).join('')}</div>
  </div>`;

  // ----- the selected town -----
  let townCard = '';
  if (T0) {
    const me = m.players[0];
    let where = m.ahead ? 'NOT YET REACHED' : '';
    if (me) {
      const dx = T0.cx - me.cx;
      const dy = T0.cy - me.cy;
      const d = Math.hypot(dx, dy);
      where = d < 48 ? 'YOU ARE HERE' : `${(d * 0.004).toFixed(1)} KM ${DIRS[((Math.round(Math.atan2(dy, dx) / (Math.PI / 4)) % 8) + 8) % 8]}`;
    }
    const gar = T0.garrison;
    const threat = gar === null ? 0 : Math.min(5, Math.ceil(gar / 1.5));
    const tanks = (c: number) => Array.from({ length: Math.min(6, c) }, () => icon('tank16', u, RED_TANK)).join('');
    const garrison = T0.freed
      ? `${T('GARRISON', 2, 'c-mute')}${P('NONE. THE FLAG IS OURS AND THE WORKSHOP IS OPEN.', 2, 'c-green')}`
      : gar === null ? `${T('GARRISON', 2, 'c-mute')}${T('NOT SCOUTED', md, 'c-dim')}`
        : `${T(m.ahead ? 'DUG-IN SPOTS' : 'GARRISON', 2, 'c-mute')}
          <div class="gx-row" style="gap:${H.px(2)};flex-wrap:wrap">${tanks(gar)}<span style="margin-left:${H.px(3)}">${T(m.ahead ? plural(gar, 'SPOT') : plural(gar, 'TANK'), md, 'c-ink')}</span></div>
          <div class="gx-row" style="gap:${H.px(3)}">${T('THREAT', 2, 'c-mute')}${H.segs(5, 0, 6, 3, Object.fromEntries(Array.from({ length: threat }, (_, i) => [i, 'warn'])))}${T(threat >= 4 ? 'TOUGH' : threat >= 2 ? 'DUG IN' : threat ? 'LIGHT' : 'QUIET', 2, threat >= 2 ? 'c-red' : 'c-dim')}</div>`;
    const reward = T0.freed
      ? `${T('AT THE WORKSHOP', 2, 'c-mute')}<div class="gx-row" style="gap:${H.px(8)};flex-wrap:wrap">
          <span class="gx-row" style="gap:${H.px(2)}">${icon('repair', u)}${T('REPAIRS', md, 'c-ink')}</span><span class="gx-row" style="gap:${H.px(2)}">${icon('parts', u)}${T('PARTS', md, 'c-ink')}</span></div>`
      : `${T('FREE IT FOR', 2, 'c-mute')}<div class="gx-row" style="gap:${H.px(8)};flex-wrap:wrap">
          <span class="gx-row" style="gap:${H.px(2)}">${icon('repair', u)}${T('WORKSHOP', md, 'c-ink')}</span>
          <span class="gx-row" style="gap:${H.px(2)}">${icon('scrap', u)}${T(String(FREE_SCRAP), md, 'c-ink')}</span>
          <span class="gx-row" style="gap:${H.px(2)}">${T('+ CREW XP', 2, 'c-green')}</span></div>`;
    const calls = new Set(aboard(run.crew).map((c) => c.id));
    const who = calls.has('taras') ? 'OWL' : 'SPANNER';
    const bossNear = b?.known && !b.dead && b.near === T0.name;
    const say = bossNear ? `${b!.name} IS NEAR ${T0.name}. FREE IT LAST, OR BRING DRONES.`
      : T0.freed ? (who === 'OWL' ? 'QUIET HERE NOW. PEOPLE ARE ON THE STREET. SOMEONE BROUGHT US BREAD.' : 'GOOD PLACE FOR A WORKSHOP. THE BAKERY STILL HAS A ROOF.')
        : m.ahead ? (who === 'OWL' ? 'I HAVE NOT SEEN IT YET. NOBODY HAS. THAT IS WHY WE GO.' : 'NEW ROADS. SAME TANK. SAME PULL TO THE LEFT.')
          : who === 'OWL' ? 'THEY DUG IN BEHIND THE WALLS. COME IN THROUGH THE FIELDS, NOT THE MAIN ROAD.' : 'PEOPLE ARE IN THE CELLARS THERE. GET THE TANKS OUT AND THEY CAN COME UP.';
    townCard = `<div class="gx-plate riv gx-panel">
      <div class="gx-hdr">${T0.freed ? `<span class="gx-tag">${T('FREED TOWN', 2)}</span>` : `<span class="gx-tag red">${T('HELD TOWN', 2)}</span>`}${T(where, 2, 'c-dim')}</div>
      <div class="gx-row" style="gap:${H.px(5)}">${icon('town', 2 * u, T0.freed ? undefined : HELD)}<div class="gx-col" style="gap:${H.px(3)};min-width:0">${T(T0.name, tall ? u + 1 : 2 * u, 'c-gold')}
        ${P(T0.freed ? 'FLAG UP · PEOPLE BACK ON THE STREETS' : 'PEOPLE SHELTERING IN CELLARS', 2, 'c-dim')}</div></div>
      <div class="gx-box2">${garrison}</div>
      <div class="gx-box2">${reward}</div>
      <div class="gx-row" style="align-items:flex-start;gap:${H.px(4)}"><div class="gx-well"><img src="${radioFace(who)}" style="width:${H.px(32)};height:${H.px(32)}" draggable="false"></div>
        <div class="gx-col" style="gap:${H.px(3)};flex:1;min-width:0">${T(who, md, 'c-gold')}${P(`"${say}"`, 2, 'c-ink')}</div></div>
      <div class="gx-sp"></div>
      <div class="gx-row" style="gap:${H.px(6)};flex-wrap:wrap"><span class="gx-btn go" data-act="close">${H.kc('ENTER', 'gold')}${T(m.ahead ? 'SET OUT' : 'TO THE ROAD', md, 'c-gold')}</span>
        <span class="gx-btn" data-act="town:${sel0 + 1}">${H.kc('TAB')}${T('NEXT TOWN', md, 'c-ink')}</span></div>
    </div>`;
  } else townCard = `<div class="gx-plate riv gx-panel">${T('NO TOWNS IN THIS REGION', md, 'c-dim')}</div>`;

  // ----- liberation, boss, ready check -----
  const freed = towns.filter((t) => t.freed).length;
  const pct = towns.length ? freed / towns.length : 0;
  const dep = m.depots.filter((d) => d.destroyed).length;
  const kv = (k: string, v: string, cls = 'c-ink') => `<div class="gx-row" style="justify-content:space-between">${T(k, 2, 'c-dim')}${T(v, md, cls)}</div>`;
  const lib = `<div class="gx-plate riv">
    <div class="gx-hdr">${T('LIBERATION', 2, 'c-gold')}${T(`${Math.round(pct * 100)}%`, 2, 'c-ink')}</div>
    <div class="gx-col" style="gap:${H.px(4)}">${H.segs(10, Math.round(pct * 10), 13, 5)}
      ${kv('TOWNS', `${freed} / ${towns.length}`)}${kv('DEPOTS', `${dep} / ${m.depots.length}`)}
      ${kv('BOSS', !b ? '-' : b.dead ? 'DOWN' : b.known ? 'FOUND' : 'HIDDEN', b?.dead ? 'c-green' : b?.known ? 'c-red' : 'c-blue')}</div></div>`;
  const bossBody = !b ? P('NO BOSS IN THIS REGION.', 2, 'c-mute')
    : b.known
      ? `<div class="gx-row" style="gap:${H.px(4)};align-items:center"><div class="gx-well" style="width:${H.px(32)};height:${H.px(32)};display:flex;align-items:center;justify-content:center">${img(crosshair(b.dead), 2 * u)}</div>
          <div class="gx-col" style="gap:${H.px(3)};flex:1;min-width:0">${T(b.name, md, b.dead ? 'c-mute' : 'c-red')}${P(b.dead ? `${b.title}. A WRECK NOW.` : `${b.title}${b.near ? `, NEAR ${b.near}` : ''}.`, 2, 'c-dim')}</div></div>`
      : `<div class="gx-row" style="gap:${H.px(4)};align-items:center"><div class="gx-well" style="width:${H.px(32)};height:${H.px(32)};display:flex;align-items:center;justify-content:center">${T('?', 3 * u, 'c-mute')}</div>
          <div class="gx-col" style="gap:${H.px(3)};flex:1;min-width:0">${T('UNKNOWN', md, 'c-dim')}${P(`FREE ${plural(Math.max(1, b.need), m.ahead ? 'TOWN' : 'MORE TOWN')} AND SOMEONE WILL TALK.`, 2, 'c-dim')}</div></div>`;
  const boss = `<div class="gx-plate riv"><div class="gx-hdr">${T('REGION BOSS', 2, 'c-red')}${b?.known ? '' : icon('lock', u)}</div>${bossBody}</div>`;
  const un = crewUnlocks(run.crew);
  const charges = [0, 1, 2, 3].filter((i) => un[i]).map((i) => `<span class="gx-row" style="gap:${H.px(1)}">${icon(ABILITY_ICONS[i], u)}${T(`x${run.charges[i] ?? 0}`, 2, 'c-ink')}</span>`).join('');
  const ready = Array.from({ length: players }, (_, i) => {
    const [cur, max] = armour[i] ?? [0, 0];
    const fitted = run.fitted[i] ?? {};
    const dmg = max - cur;
    // wrapped (P), so a long scrap number or a narrow panel can't push it past the plate's edge
    const fix = dmg > 0 ? P(`PATCH UP FIRST? ${Math.ceil(dmg / 3) * repairCost(run.crew)} SCRAP IN THE GARAGE`, 2, 'c-gold') : P('ARMOUR FULL. GOOD TO GO.', 2, 'c-green');
    return `<div class="gx-row" style="gap:${H.px(4)};align-items:center">${img(babusyaDoll(fitted, i, run.vet?.[i] ?? 0), u)}
      <div class="gx-col" style="gap:${H.px(3)};flex:1;min-width:0"><div class="gx-row" style="gap:${H.px(3)}">${T('ARMOUR', 2, 'c-dim')}${H.segs(max, cur, 4, 4, {}, cur <= 3 ? '' : '')}</div>
      ${i === 0 ? `<div class="gx-row" style="gap:${H.px(5)};flex-wrap:wrap">${charges}</div>` : ''}${fix}</div></div>`;
  }).join('');
  const readyPlate = `<div class="gx-plate riv"><div class="gx-hdr">${T('READY CHECK', 2, 'c-gold')}<span class="gx-tag">${T(players > 1 ? 'IP · IIP' : 'IP', 2)}</span></div>
    <div class="gx-col" style="gap:${H.px(5)}">${ready}</div></div>`;
  const right = `<div class="gx-col" style="gap:${H.px(8)};min-width:0">${lib}${boss}${readyPlate}</div>`;

  return `<div class="gx-col" style="gap:${H.px(8)};flex:1;min-height:0">${strip(H, run, m)}
    <div class="gx-mapgrid">${mapPlate}${townCard}${right}</div></div>`;
}
