// Headless screenshot test. Loads dist/index.html (run `npm run build` first), plays scripted
// scenes, saves PNGs to shots/ and exits non-zero on page errors. tools/browser.mjs decides where
// scenes run (this PC's GPU, or a remote GPU PC through the optional test link);
// tools/scene-runner.mjs defines the step format.
// Usage: node tools/shot.mjs [scene ...]
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { openRunner } from './browser.mjs';

const root = resolve(import.meta.dirname, '..');
const outDir = resolve(root, 'shots');
mkdirSync(outDir, { recursive: true });

const play = 'autostart=1&autoplay=1';

// Camera scrolling test (the arcade game doesn't scroll): replaces the app's draw with a synthetic
// 128x128-cell map drawn through the renderer's scroll API. window.__cam = camera in world px (the
// world px at the top left of litRect), vx/vy in px/s; full = litRect is the whole screen (campaign)
// or the arcade 208 field; burst = drop smoke + a splash once. Lights, a smoke chimney, ripples,
// decals and a tank sit at fixed world points, so they should ride along with the terrain.
const SCROLL_SETUP = `eval:{
const a = window.__app, r = a.r, N = 128, c = new Uint8Array(N * N);
const h2 = (x, y) => { const s = Math.sin(x * 127.1 + y * 311.7) * 43758.5453; return s - Math.floor(s); };
for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) {
  let t = 0;
  const v = h2(x >> 2, y >> 2);
  if ((x - 60) ** 2 + (y - 40) ** 2 < 150) t = 3;
  else if (y >= 72 && y < 78 && x > 8 && x < 118) t = 3;
  else if (x >= 36 && x < 60 && y >= 52 && y < 70) t = 0;
  else if (v < 0.1) t = 1; else if (v < 0.15) t = 2; else if (v < 0.27) t = 4; else if (v < 0.31) t = 5;
  if (x === 0 || y === 0 || x === N - 1 || y === N - 1) t = 2;
  c[y * N + x] = t;
}
const MAT = [0, 7, 8, 3, 6, 4];
const cam = window.__cam = { x: 120, y: 120, vx: 0, vy: 0, full: true, last: 0, burst: 0, decal: 1, rip: -1, ver: 1, dirty: null };
window.__cells = c;
a.update = () => {};
for (const el of document.body.children) if (el.tagName !== 'CANVAS' && el.id !== 'err') el.style.visibility = 'hidden';
r.wind = [0, 0];
r.resetHistory = true;
r.clearDecals = true;
a.draw = (time) => {
  r.dt = cam.last ? Math.min(0.1, Math.max(0.0005, time - cam.last)) : 1 / 60;
  if (cam.last) { cam.x += cam.vx * r.dt; cam.y += cam.vy * r.dt; }
  cam.last = time;
  const lr = cam.full ? [0, 0, 256, 224] : [24, 8, 208, 208];
  r.reserve = [0, 0, 0, 0];
  r.feather = 0;
  r.litRect = lr;
  const fx = Math.floor(cam.x), fy = Math.floor(cam.y);
  r.scroll = [fx - lr[0], fy - lr[1]];
  r.subpx = [cam.x - fx, cam.y - fy];
  r.setTerrainSize(N * 4, N * 4);
  r.setCellMap(c, N, N, cam.ver, 0, 0, cam.dirty);
  cam.dirty = null;
  const ox = -r.scroll[0], oy = -r.scroll[1];
  r.rectG(lr[0], lr[1], lr[2] + 1, lr[3] + 1, 0);
  const x0 = Math.max(0, Math.floor((lr[0] - ox) / 4)), y0 = Math.max(0, Math.floor((lr[1] - oy) / 4));
  const x1 = Math.min(N, Math.ceil((lr[0] + lr[2] + 1 - ox) / 4)), y1 = Math.min(N, Math.ceil((lr[1] + lr[3] + 1 - oy) / 4));
  for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) {
    const t = c[y * N + x];
    if (t === 4) r.canopyRect(ox + x * 4, oy + y * 4, 4, 4, 6);
    else if (t) r.rectG(ox + x * 4, oy + y * 4, 4, 4, MAT[t]);
  }
  const P = (wx, wy) => [ox + wx, oy + wy];
  let q = P(150, 214);
  if (r.atlas.S.p0a) r.spr(r.atlas.S.p0a, q[0], q[1], 1, [1, 0.76, 0.2], 1, 0, 1, 0);
  q = P(180, 240); r.light(q[0], q[1], 16, 80, 1.4, 1.0, 0.55, true); r.glow(q[0], q[1], 5, [1.4, 1.0, 0.55], 2);
  q = P(330, 230); r.light(q[0], q[1], 16, 70, 0.4, 0.7, 1.4, true); r.glow(q[0], q[1], 5, [0.4, 0.7, 1.4], 2);
  q = P(250, 100); r.light(q[0], q[1], 16, 70, 1.3, 0.45, 0.2, true); r.glow(q[0], q[1], 5, [1.3, 0.45, 0.2], 2);
  const f = r.dt * 60;
  q = P(215, 262); r.dyeSplat(q[0], q[1], 4, 0.08 * f, 0.06 * f, 0.02 * f);
  if (cam.burst) {
    cam.burst = 0;
    q = P(190, 225); r.dyeSplat(q[0], q[1], 12, 2.0, 1.0, 0.8); r.velSplat(q[0], q[1], 10, 0, -30);
    q = P(240, 160); r.waveSplat(q[0], q[1], 6, 3);
  }
  const ri = Math.floor(time * 2.5);
  if (ri !== cam.rip) { cam.rip = ri; q = P(228, 150); r.waveSplat(q[0], q[1], 4, 2.2); }
  if (cam.decal) {
    cam.decal = 0;
    q = P(168, 252); r.decalCircle(q[0], q[1], 9, [0.05, 0.04, 0.03], 0.85);
    q = P(150, 270); r.decalRect(q[0], q[1], 60, 3, [0.08, 0.06, 0.04], 0.75);
  }
  r.shocks = [];
  r.shake = [0, 0];
  r.flash = [0, 0, 0];
};
}`;
const CAM = 'eval:({ x: window.__cam.x, y: window.__cam.y, scroll: window.__app.r.scroll, subpx: window.__app.r.subpx, view: window.__app.r.view, fps: window.__app.fpsValue })';
const scrollSteps = (pre) => [
  3000, SCROLL_SETUP, 1500, CAM, `shot:${pre}-still0`,
  'eval:Object.assign(window.__cam, { burst: 1, vx: 37.3, vy: 14.6 })', 700, CAM, `shot:${pre}-pan1`, 700, CAM, `shot:${pre}-pan2`,
  'eval:Object.assign(window.__cam, { vx: 0, vy: 0 })', CAM, `shot:${pre}-stop1`,
  'eval:Object.assign(window.__cam, { vx: -29.1, vy: 21.7 })', 700, CAM, `shot:${pre}-pan3`,
  'eval:Object.assign(window.__cam, { vx: 0, vy: 0 })', CAM, `shot:${pre}-stop2`, 1500, CAM, `shot:${pre}-stop2b`,
  // dig a pool through a dirty-rect upload: it should get banks and foam like the other water
  'eval:{ const c = window.__cells; for (let y = 78; y < 86; y++) for (let x = 70; x < 84; x++) c[y * 128 + x] = 3; window.__cam.ver++; window.__cam.dirty = [[70, 78, 14, 8]]; }',
  700, `shot:${pre}-dig`,
  'eval:Object.assign(window.__cam, { full: false, vx: 33.3, vy: -11.1 })', 700, CAM, `shot:${pre}-arcaderect`,
  'eval:Object.assign(window.__cam, { full: true, vx: 0, vy: 0, x: -14.5, y: 300.25 })', 500, CAM, `shot:${pre}-edge`,
];
// Same render time and a frozen game every frame: for before/after comparisons of the arcade look.
const STILL = 'eval:{ const a = window.__app; const r = a.r; const w = a.world; a.update = () => {}; Math.random = () => 0.5;'
  + ' if (w && a.mode !== "title") { for (const k of ["enemies", "bullets", "booms", "parts", "flashes", "shocks", "decals"]) if (Array.isArray(w[k])) w[k].length = 0;'
  + ' w.power = null; w.shake = 0; for (const p of w.players) if (p) { p.x = 64; p.y = 192; p.dir = 0; p.spawn = 0; p.shield = 0; p.moving = false; p.recoil = 0; p.dist = 0; } }'
  + ' a.weather.drops.forEach((d, i) => { d.x = 24 + (i * 37) % 208; d.y = 8 + (i * 53) % 208; }); a.weather.flash = 0;'
  + ' r.clearDecals = true; r.resetHistory = true;'
  + ' const ren = r.render.bind(r); r.render = () => { r.dt = 1 / 60; ren(100); }; }';
// Campaign HUD: fills in the campaign fields the rules / generator agents own (armour, vet, scrap, charges, towns,
// depots, radio) with the mockup's values. Enemies freeze and the players get a long shield-free stay, so the
// shots are steady. Argument: 'full' = 5 towns (2 freed) + 3 depots, 'none' = old region without towns, low armour.
const hudSetup = (kind) => `eval:{
const a = window.__app, w = a.world, p0 = w.players[0];
w.freeze = 1e9; for (const p of w.players) if (p) { p.shield = 0; p.spawn = 0; }
w.scrap = ${kind === 'none' ? 20 : 245}; w.partsFound = ${kind === 'none' ? 0 : 3}; w.charges = ${kind === 'none' ? '[0, 0, 0, 0]' : '[2, 1, 0, 0]'};
w.players.forEach((p, i) => { if (!p) return; p.armourMax = 10; p.armour = ${kind === 'none' ? 2 : '[7, 3][i]'}; p.vet = [2, 1][i]; p.vetXp = [0.6, 0.35][i]; });
if (${kind === 'full'}) {
  const T = (name, cx, cy, freed, progress) => ({ name, rect: [cx - 60, cy - 60, 120, 120], cx, cy, freed, progress });
  w.towns.push(T('TYKHE POLE', Math.round(p0.cx + 40), Math.round(p0.cy - 70), false, 0.6), T('ZOLOTA BALKA', 520, 200, false, 0),
    T('STARI SADY', 660, 440, false, 0), T('VYSHNEVE', 176, 580, true, 1), T('KALYNIVKA', 448, 700, true, 1));
  w.towns[0].rect = [p0.cx - 200, p0.cy - 200, 400, 400];
  w.region.depots = [{ name: 'WEST', rect: [100, 430, 40, 40], cx: 120, cy: 450 }, { name: 'MILL', rect: [292, 432, 40, 40], cx: 312, cy: 452 }, { name: 'RAIL', rect: [712, 728, 40, 40], cx: 732, cy: 748 }];
  w.radio.push({ who: 'SPANNER', text: 'WEST DEPOT IS FULL OF DIESEL. ONE SHELL AND BOOM.' });
} else w.radio.push({ who: 'SIGNALS', text: 'NO TOWNS ON THIS MAP. CLEAR THE AREA.' });
}`;
const HUDINFO = "eval:(() => { const r = (k) => { const e = document.querySelector(`#chud [data-k=\"${k}\"]`); if (!e) return null; const b = e.getBoundingClientRect(); return [b.x, b.y, b.width, b.height].map(Math.round); }; return { u: getComputedStyle(document.getElementById('chud')).getPropertyValue('--u'), obj: r('obj'), res: r('res'), mm: r('mmp'), cl: r('cl'), rd: r('rd') }; })()";
const hudSteps = (name, kind = 'full', map = false) => [4500, hudSetup(kind), 2600, HUDINFO, `shot:${name}`,
  ...(map ? ['key:Tab', 500, `shot:${name}-map`, 'key:Tab'] : [])];
const NATIVE = 'eval:({ native: [window.__app.r.nw, window.__app.r.nh], view: window.__app.r.view.map(Math.round), k: window.__app.r.k, cam: window.__app.cam && [window.__app.cam.viewW, window.__app.cam.viewH], fps: window.__app.fpsValue })';
// Campaign rules, an exact situation: the world is frozen (the UI keeps running, so toasts and pop-ups show) and a
// scrap pile, a parts crate, a town flag at 50% capture and a freed town are put around the player, who has
// `armour` armour left and takes one hit from an enemy of type `hitType` (2 = power: 3 damage).
const camp = (armour, hitType, env) => `eval:{ const a = window.__app, w = a.world; w.update = () => {}; const p = w.players[0]; p.armour = ${armour}; p.spawn = 0;`
  + ` w.env = '${env}'; const px = p.cx, py = p.cy;`
  + ` w.pickups.push({ x: px + 34, y: py + 4, kind: 'scrap', amount: 12, t: 0 }, { x: px - 30, y: py + 14, kind: 'part', amount: 1, t: 0 }, { x: px + 20, y: py + 30, kind: 'scrap', amount: 25, t: 0 });`
  + ` w.towns = [{ name: 'TYKHE POLE', rect: [px + 40, py - 110, 64, 64], cx: px + 72, cy: py - 78, freed: false, progress: 0.5 },`
  + ` { name: 'BRODNA', rect: [px - 120, py - 110, 64, 64], cx: px - 88, cy: py - 78, freed: true, progress: 1 }];`
  + ` w.hitPlayer(p, { etype: ${hitType} }); w.shake = 0; ({ armour: p.armour, max: p.armourMax }); }`;
// Teleport the region player to a spot (an expression over w = world), freezing enemies.
const TP = (spot) => `eval:{ const w = window.__app.world; w.freeze = 1e6; const p = w.players[0]; const s = ${spot};`
  + ' p.x = s[0]; p.y = s[1]; p.dir = 0; p.shield = 0; JSON.stringify(s); }';
const TOWN = '[w.region.towns[0].cx - 8, w.region.towns[0].cy + 8]';
const BRIDGE = 'w.region.bridges[0]';
const regionSpots = (tag = '') => [
  6500, TP(TOWN), 2000, `shot:region-town${tag}`, TP(BRIDGE), 2000, `shot:region-bridge${tag}`,
  "eval:window.__app.world.env = 'night'", TP(TOWN), 3000, `shot:region-town-night${tag}`, TP(BRIDGE), 2000, `shot:region-bridge-night${tag}`,
  "eval:window.__app.world.env = 'snow'", 2500, `shot:region-bridge-snow${tag}`,
];
// Camp screen layout check: plates whose contents spill out, and overlaps between the main row, bottom row and hints.
const GXFIT = "eval:(() => { const g = document.getElementById('gx'); if (!g) return 'no camp'; const r = (s) => g.querySelector(s)?.getBoundingClientRect(); const m = r('.gx-main'), b = r('.gx-bottom'), h = r('.gx-hints'); return { u: getComputedStyle(g).getPropertyValue('--u'), cls: g.className, spill: [...g.querySelectorAll('.gx-plate')].filter((p) => p.scrollHeight > p.clientHeight + 1 || p.scrollWidth > p.clientWidth + 1).length, gapMainBottom: b && m && Math.round(b.top - m.bottom), gapBottomHints: h && b && Math.round(h.top - b.bottom), hintsBottom: h && Math.round(innerHeight - h.bottom), scroll: g.scrollHeight - g.clientHeight }; })()";
// ---------- campaign run loop (Phase 2) ----------
// A saved run (region 2, 245 scrap, 3 parts, one retreat) for the CAMPAIGN submenu's CONTINUE.
const SAVE_RUN = `eval:localStorage.setItem('tank1990neo.run', JSON.stringify({ v: 1, at: Date.now(), run: { version: 1, seed: 777, region: 1, scrap: 245,
  bin: ['a', 'b', 'c'], fitted: [{}, {}], charges: [0, 0, 0, 2], vet: [1, 0], vetXp: [0.4, 0], retreats: 1 } }))`;
const SAVED = "eval:JSON.parse(localStorage.getItem('tank1990neo.run') ?? 'null')";
// Region test map, enemies frozen and the director stopped, player parked next to depot 0 / on town 0's freed flag.
const QUIET = 'const a = window.__app, w = a.world; w.freeze = 1e9; if (w.ai) w.ai.update = () => {}; for (const e of w.enemies) e.alive = false; const p = w.players[0]; p.shield = 0; p.spawn = 0;';
const AT_DEPOT = `eval:{ ${QUIET} const d = w.depots[0]; const s = w.freeSpotNear(d.cx - 8, d.cy + 36); p.x = s[0]; p.y = s[1]; p.dir = 0; ({ depot: d.name, kind: d.kind, at: [d.cx, d.cy], player: s }); }`;
const HIT_DEPOT = (n) => `eval:{ const w = window.__app.world, d = w.depots[0]; for (let i = 0; i < ${n}; i++) w.hitDepot(d, 0, d.cx + (i % 3) * 4 - 4, d.cy + 6); ({ hp: d.hp, destroyed: d.destroyed, scrap: w.scrap }); }`;
const AT_FLAG = `eval:{ ${QUIET} const t = w.towns[0]; w.freeTown(t); const s = w.map.solidForTank(t.cx - 8, t.cy - 8, false) ? w.freeSpotNear(t.cx - 8, t.cy - 8) : [t.cx - 8, t.cy - 8];
  p.x = s[0]; p.y = s[1]; p.dir = 0; ({ town: t.name, at: s }); }`;
const KNOCKOUT = 'eval:{ const a = window.__app, w = a.world; w.ps[0].lives = 0; const p = w.players[0]; p.spawn = 0; p.shield = 0; p.hover = false; while (w.players[0]) w.hitPlayer(w.players[0], { etype: 3 }); ({ out: w.ps[0].out }); }';
const FREE_ALL = 'eval:{ const w = window.__app.world; w.freeze = 1e9; for (const t of w.towns) if (!t.freed) w.freeTown(t); const d = w.depots[0]; for (let i = 0; i < 6; i++) w.hitDepot(d, 0); ({ towns: w.towns.length, depots: w.stats.depots }); }';
const RUNINFO = 'eval:({ mode: window.__app.mode, run: window.__app.run, lives: window.__app.ps[0].lives, ease: window.__app.world?.ease })';
// Phase 3: crew cards whose contents spill (px past the card's bottom), and the run's crew and the world's
// unlocked abilities, perks and charges
const WAIT_RECRUIT = "eval:new Promise((ok) => { const t0 = Date.now(); const id = setInterval(() => { if (window.__app.mode === 'recruit' || Date.now() - t0 > 15000) { clearInterval(id); ok({ mode: window.__app.mode, frame: window.__app.world?.frame }); } }, 50); })";
const CREWFIT ="eval:[...document.querySelectorAll('#gx .gx-card')].map((c) => c.scrollHeight - c.clientHeight)";
const CREWINFO = 'eval:({ mode: window.__app.mode, crew: window.__app.run?.crew, unlocked: window.__app.world?.unlocked, perks: [...(window.__app.world?.perks ?? [])], charges: window.__app.world?.charges })';

// ---------- Phase 5 story: briefings, the ending, the camp MAP tab ----------
// A saved run on region N (1 = RAIL JUNCTION) with WASP and AUNTIE aboard and region I's clear noted for the kicker.
const STORY_SAVE = (region, extra = '') => `eval:localStorage.setItem('tank1990neo.run', JSON.stringify({ v: 1, at: Date.now(), run: { version: 1, seed: 777, region: ${region}, scrap: 245,
  bin: ['barrel-125', 'sandbags'], fitted: [{ armour: 'scrap-plates' }, {}], charges: [1, 1, 0, 2], vet: [1, 0], vetXp: [0.4, 0], retreats: 1,
  crew: [{ id: 'mykola', lv: 2, xp: 0 }, { id: 'yurko', lv: 2, xp: 0 }, { id: 'sofia', lv: 1, xp: 0 }, { id: 'halyna', lv: 1, xp: 0 }],
  story: { opened: true, briefed: [0], answers: { 0: 0 }, last: { region: ${region} - 1, towns: 3, depots: 3, boss: true } },
  totals: { regions: ${region}, towns: 14, depots: 9, bosses: ${region}, scrap: 2380, parts: 17, kills: 112 } ${extra} } }))`;
const NO_SAVE = "eval:localStorage.removeItem('tank1990neo.run')";
const TO_CAMPMENU = [1500, 'eval:{ const a = window.__app; a.titleY = 0; a.openCampMenu(); a.menuSel = 0; a.mode; }', 600];
const STORYINFO = "eval:({ mode: window.__app.mode, story: window.__app.run?.story, charges: window.__app.run?.charges, scrap: window.__app.run?.scrap, completed: window.__app.run?.completed })";
// lines: ENTER finishes a typing line or shows the next one
const NEXT = (n, ms = 1600) => Array.from({ length: n }, () => ['key:Enter', ms]).flat();
const BOSS_DOWN = "eval:{ const w = window.__app.world; w.freeze = 1e9; for (const t of w.towns) if (!t.freed) w.freeTown(t); const b = w.boss; for (let i = 0; i < 8 && b.state !== 'dying' && b.state !== 'dead'; i++) b.kill(0); ({ boss: b.name, state: b.state }); }";
const ESC_DOWN = "eval:window.dispatchEvent(new KeyboardEvent('keydown', { code: 'Escape' }))";
const ESC_UP = "eval:window.dispatchEvent(new KeyboardEvent('keyup', { code: 'Escape' }))";
const WAIT_MODE = (m) => `eval:new Promise((ok) => { const t0 = Date.now(); const id = setInterval(() => { if (window.__app.mode === '${m}' || Date.now() - t0 > 30000) { clearInterval(id); ok({ mode: window.__app.mode, waited: Date.now() - t0 }); } }, 50); })`;
// ---------- 2026-11-18 UI fixes ----------
// one radio line shown straight away and fully typed (the world frozen so nothing else talks); RADIOFIT measures
// whether the panel's text spills past the panel or the window
const RADIO_SHOW = (who, text) => `eval:{ const a = window.__app, w = a.world, c = a.ui.camp; w.freeze = 1e9; if (w.ai) w.ai.update = () => {}; w.radio.length = 0;
  for (const p of w.players) if (p) { p.shield = 0; p.spawn = 0; }
  c.radioQ.length = 0; c.showRadio({ who: ${JSON.stringify(who)}, text: ${JSON.stringify(text)} }, 0); c.radioT = c.radioLen / 40 + 0.05; c.radioLen; }`;
const RADIOFIT = "eval:(() => { const rd = document.querySelector('#chud [data-k=\"rd\"]'); const pl = rd.firstElementChild.getBoundingClientRect(); const spill = [...rd.querySelectorAll('i')].filter((g) => { const b = g.getBoundingClientRect(); return b.width && (b.right > pl.right + 1 || b.bottom > pl.bottom + 1 || b.right > innerWidth); }).length; return { plate: [pl.x, pl.y, pl.width, pl.height].map(Math.round), spill }; })()";
const RADIO_LINES = [
  ['INTERCEPT', 'KETTLE: ENEMY TANK IN HOSPITAL HILL. SEND HELP.'],
  ['INTERCEPT', 'GRINDER: SKIRT IS GONE. NO MATTER. I AM STILL BIGGER THAN YOU.'],
  ['SPANNER', 'ZOLOTA BALKA IS BACK. PATCH KIT IS ON ITS WAY. TRY TO RETURN THE TANK WITH THE SAME NUMBER OF HOLES.'],
  ['KOVAL', 'SHELLS FALL SHORT OVER OPEN WATER. FIRE FROM THE BRIDGES AND BANKS. DRONES AND AMBUSH SQUADS DO NOT CARE ABOUT WATER.'],
];
const RADIO_FIT = (pre) => [WAIT_MODE('play'), 1500, ...RADIO_LINES.flatMap(([who, text], i) => [RADIO_SHOW(who, text), 900, RADIOFIT, `shot:${pre}-${i}`])];
// toasts: every text sent since TOASTLOG, and how many are on screen now
const TOASTLOG = "eval:{ const u = window.__app.ui, f = u.toast.bind(u); window.__toasts = []; u.toast = (t, ...a) => { window.__toasts.push(t); return f(t, ...a); }; 1 }";
const TOASTINFO = "eval:({ sent: window.__toasts, shown: document.querySelectorAll('#toasts .toast').length })";
// hit-stop probe: do `what` (none / kill an enemy as player 1 / break a boss part), then sample w.frame for 250 ms;
// returns the frames seen and the longest run of samples (in ms) the frame stood still
const HITSTOP_PROBE = (what) => `eval:new Promise((ok) => { const w = window.__app.world; w.players[0].shield = 600;
  if ('${what}' === 'kill') { const e = w.enemies.find((x) => x.alive && x.spawn === 0) ?? w.enemies[0]; w.killEnemy(e, 0); }
  if ('${what}' === 'part') { const p = w.boss.parts.find((q) => q.hp > 0); p.hp = 0; }
  const t0 = performance.now(), seen = []; let last = w.frame, at = t0, held = 0;
  const id = setInterval(() => { const now = performance.now(); if (w.frame !== last) { held = Math.max(held, now - at); last = w.frame; at = now; seen.push(w.frame); }
    if (now - t0 > 250) { clearInterval(id); ok({ what: '${what}', frames: seen.length, held: Math.round(held), hitStop: w.hitStop }); } }, 2); })`;
// four enemies (types 0-3) parked 72 px either side of the player, facing away (out of every headlight); frozen
const ENEMY_RING = `eval:{ const w = window.__app.world; w.freeze = 1e9; if (w.ai) w.ai.update = () => {}; if (w.tricks) w.tricks.update = () => {};
  const p = w.players[0]; p.shield = 0; p.spawn = 0; w.bullets.length = 0;
  const es = w.enemies.filter((e) => e.alive).slice(0, 4); for (const e of w.enemies) if (!es.includes(e)) e.alive = false;
  const D = [[-72, -24, 3], [72, -24, 1], [-72, 40, 2], [72, 40, 2]];
  es.forEach((e, i) => { const s = w.freeSpotNear(p.x + D[i][0], p.y + D[i][1]); e.x = s[0]; e.y = s[1]; e.dir = D[i][2]; e.etype = i; e.hp = i === 3 ? 4 : 1; e.spawn = 0; e.stun = 0; e.bonus = false; e.flash = 0; });
  w.freeze = 0; w.update = () => {}; es.length; }`;
const RAIL_BRIEF = [NO_SAVE, STORY_SAVE(1), ...TO_CAMPMENU, 'key:Enter', 3200, 'key:Enter', 1500, 'key:Enter', 3600];

// ---------- 2026-10-15 play test fixes ----------
const ARENAINFO = "eval:(() => { const w = window.__app.world, t = w.tricks; return { mode: window.__app.mode, charges: w.charges, lives: w.ps[0].lives, enemies: w.enemies.map((e) => [e.etype, e.hp, Math.round(e.x), Math.round(e.y)]), mines: t.mines.length, teams: t.teams.length, drones: t.drones.map((d) => d.phase), barrage: !!t.barrage }; })()";
const FRAMEINFO = "eval:(() => { const a = window.__app, w = a.world, p = w?.players[0]; return { mode: a.mode, frame: w?.frame, armour: p?.armour, bullets: w?.bullets.length, enemies: w?.enemies.filter((e) => e.alive).map((e) => [Math.round(e.x), Math.round(e.y)]).slice(0, 4) }; })()";
// a map event put down with the player on it and a live enemy tank parked 24 px away facing the player (no freeze)
const EV_NEAR_ENEMY = (id) => `eval:{ const a = window.__app, w = a.world; const e = w.events.debugPlace('${id}'); if (!e) throw new Error('no spot for ${id}');
  if (e.town >= 0) w.freeTown(w.towns[e.town]);
  const p = w.players[0]; p.spawn = 0; p.shield = 0;
  let s = [Math.round((e.x - 8) / 8) * 8, Math.round((e.y - 8) / 8) * 8];
  if (w.map.solidForTank(s[0], s[1], false)) s = w.freeSpotNear(s[0], s[1]);
  p.x = s[0]; p.y = s[1]; p.dir = 1;
  const t = w.enemies.find((x) => x.alive) ?? null; const q = w.freeSpotNear(s[0] + 24, s[1]); if (t && q) { t.x = q[0]; t.y = q[1]; t.dir = 3; t.spawn = 0; }
  ({ id: e.def.id, at: [e.x, e.y], player: s, enemy: t && [t.x, t.y] }); }`;

// ---------- Phase 5 map events ----------
// Region test map, enemies frozen and the director stopped; event `id` put down (its town freed first) and the player
// parked `off` px left of it (0 = on it, so its card opens).
const EV_AT = (id, off = 0) => `eval:{ ${QUIET} const e = w.events.debugPlace('${id}'); if (!e) throw new Error('no spot for ${id}');
  if (e.town >= 0) w.freeTown(w.towns[e.town]);
  let s = [Math.round((e.x - 8 - ${off}) / 8) * 8, Math.round((e.y - 8) / 8) * 8];
  if (w.map.solidForTank(s[0], s[1], false)) s = w.freeSpotNear(s[0], s[1]);
  p.x = s[0]; p.y = s[1]; p.dir = 1; ({ id: e.def.id, at: [e.x, e.y], town: e.town, player: s }); }`;
// ESC held a moment: every line out and the answers up (held longer would walk away)
const EV_ANSWERS = [900, ESC_DOWN, 1000, ESC_UP, 600];
// the reply finishes typing, then the card closes
const EV_CLOSE = [2200, 'key:Enter', 400, 'key:Enter', 600];
// the escort half way along its road (drone and patrol sent), the player riding alongside every update
const ESCORT_HALF = `eval:{ const w = window.__app.world, o = w.events.objs[0]; if (!o || !o.escort) throw new Error('no escort'); const e = o.escort; e.s = e.len * 0.46; e.drone = e.patrol = true; w.events.updateObjective(o); e.drone = e.patrol = false;
  const up = w.update; w.update = function (inp) { const p = this.players[0]; if (p) { p.x = Math.round(e.x - 8 - 22 * [0, 1, 0, -1][e.dir]); p.y = Math.round(e.y - 8 - 22 * [-1, 0, 1, 0][e.dir]); p.dir = e.dir; p.shield = 0; } return up.call(this, inp); };
  ({ len: e.len, s: e.s, dest: o.ev.dest }); }`;
// the player 40 px short of the fetch target (its guard patrol comes)
const NEAR_CRATE = `eval:{ const w = window.__app.world, o = w.events.objs[0]; if (!o || !o.fetch) throw new Error('no crate'); const f = o.fetch, p = w.players[0];
  let s = [Math.round((f.x - 8 - 40) / 8) * 8, Math.round((f.y - 8) / 8) * 8]; if (w.map.solidForTank(s[0], s[1], false)) s = w.freeSpotNear(s[0], s[1]);
  p.x = s[0]; p.y = s[1]; p.dir = 1; ({ crate: [f.x, f.y], look: f.look, player: s }); }`;
const EVINFO = "eval:({ mode: window.__app.mode, placed: window.__app.world?.events?.placed.map((p) => [p.def.id, p.state, p.x, p.y]), objs: window.__app.world?.events?.objs.map((o) => o.kind), scrap: window.__app.world?.scrap, enemies: window.__app.world?.enemies.length })";

// ---------- Phase 3 crew abilities ----------
// Region test map, director and enemies stopped, every ability unlocked with charges; the player parked on open
// ground with a tree clump just north (ambush cover) and open ground east of it (targets). The world's own update is
// switched off and the scene steps it by hand (window.__step(n, input)), so each shot lands on an exact frame; the
// app keeps drawing, following the camera and showing toasts. __E(cx, cy, type, dir) adds a still enemy tank.
// (needs w and p in scope)
// The field patch's 15 s cooldown on the HUD: a real patch, a press while it cools (the toast), then the wipe set to
// half and nearly done, then ready again. The AI is held so nothing interrupts.
const PATCH_CD = (n) => [14000,
  `eval:{ const w = window.__app.world, p = w.players[0]; if (w.ai) w.ai.update = () => {}; w.updateEnemy = () => {}; p.armour = 4; w.patch(p);
    window.__k = (t, c) => window.dispatchEvent(new KeyboardEvent(t, { code: c })); ({ armour: p.armour, wait: w.patchWait(0), wait2: w.patchWait(1), charges: [...w.charges] }); }`,
  400, `shot:${n}-start`,
  "eval:{ const p = window.__app.world.players[0]; p.armour = 4; window.__k('keydown', 'Digit4'); window.__k('keyup', 'Digit4'); 1; }", 300, `shot:${n}-press`,
  'eval:{ const w = window.__app.world; w.patchReady[0] = w.frame + 450; w.patchWait(0); }', 300, `shot:${n}-half`,
  'eval:{ const w = window.__app.world; w.patchReady[0] = w.frame + 90; w.patchWait(0); }', 300, `shot:${n}-end`,
  'eval:{ const w = window.__app.world; w.patchReady[0] = 0; w.patchWait(0); }', 400, `shot:${n}-ready`];
const ABIL_SPOT = `const open = (x, y) => !w.map.solidForTank(x, y, false) && !w.map.any(x, y, 16, 16, (c) => c === 4);
let spot = null, best = 0;
for (let y = 96; y < w.pxH - 96; y += 8) for (let x = 96; x < w.pxW - 160; x += 8) {
  if (!open(x, y)) continue;
  let n = 0;
  for (let cy = y / 4 - 6; cy < y / 4 - 1; cy++) for (let cx = x / 4; cx < x / 4 + 4; cx++) if (w.map.at(cx, cy) === 4) n++;
  if (n < 12) continue;
  let e = 0;
  for (let k = 3; k < 12; k++) if (open(x + k * 8, y - 16)) e++;
  const s = Math.min(n, 16) * 2 + e;
  if (s > best) { best = s; spot = [x, y]; }
}
if (spot) { p.x = spot[0]; p.y = spot[1]; p.dir = 0; }`;
const ABIL_SETUP = (env) => `eval:{
const a = window.__app, w = a.world, p = w.players[0], up = Object.getPrototypeOf(w).update;
if (w.ai) w.ai.update = () => {};
w.updateEnemy = () => {};
for (const e of w.enemies) e.alive = false;
w.enemies.length = 0; w.bullets.length = 0;
w.allAbilities = true; w.charges = [3, 3, 3, 2]; w.env = '${env}';
p.shield = 0; p.spawn = 0; p.dir = 0;
${ABIL_SPOT}
window.__step = (n, inp = {}) => { const i = { dir: -1, fire: false, ...inp }; for (let k = 0; k < n; k++) up.call(w, [i, { dir: -1, fire: false }]); };
window.__E = (cx, cy, type = 0, dir = 2) => { const e = new p.constructor(); e.x = Math.round(cx - 8); e.y = Math.round(cy - 8); e.etype = type; e.hp = type === 3 ? 4 : 1; e.dir = dir; e.aiFire = 1e9; w.enemies.push(e); return e; };
window.__freeNear = (cx, cy) => { for (let r = 0; r < 48; r += 4) for (const [dx, dy] of [[0, 0], [r, 0], [-r, 0], [0, r], [0, -r], [r, r], [-r, -r], [r, -r], [-r, r]]) { const x = Math.round((cx + dx - 8) / 4) * 4, y = Math.round((cy + dy - 8) / 4) * 4; if (open(x, y) && !w.tankIn(x - 4, y - 4, 24, 24)) return [x + 8, y + 8]; } return null; };
w.update = () => {};
({ spot, best });
}`;
// hold 1 (reticle 48 px ahead), steer it onto a tank to the north-east (lock), release, the drone in flight, the dive
const abilFpv = (tag, type) => [
  'eval:{ window.__step(1, { ability: 1, abilityHeld: 1 }); window.__step(20, { abilityHeld: 1 }); const a = window.__app.world.abil.aims[0]; [a.x, a.y]; }',
  400, `shot:abil-aim-${tag}`,
  `eval:{ const w = window.__app.world, p = w.players[0]; const s = window.__freeNear(p.cx + 72, p.cy - 40); const e = window.__E(s[0], s[1], ${type}); window.__t1 = e;
    const a = w.abil.aims[0]; a.x = e.cx + 1; a.y = e.cy - 1; window.__step(2, { abilityHeld: 1 }); [e.cx, e.cy]; }`,
  300, `shot:abil-aim-lock-${tag}`,
  'eval:{ window.__step(1); window.__step(20); window.__app.world.abil.fpvs.map((f) => [Math.round(f.x), Math.round(f.y), Math.round(f.z), f.t, f.dur]); }',
  250, `shot:abil-fpv-flight-${tag}`,
  'eval:{ const ab = window.__app.world.abil; let n = 0; while (ab.fpvs.length && n < 80) { window.__step(1); n++; } window.__step(3); ({ n, hp: window.__t1.hp, alive: window.__t1.alive }); }',
  120, `shot:abil-fpv-impact-${tag}`,
  'eval:window.__step(16)', 400, `shot:abil-fpv-after-${tag}`,
];
// press 2: the squad goes into the trees; an armoured tank in line with it; the rocket leaves, then hits
const abilAmbush = (tag) => [
  'eval:{ const w = window.__app.world; for (const e of w.enemies) e.alive = false; w.enemies.length = 0; window.__step(1, { ability: 2, abilityHeld: 2 }); window.__step(30); const s = w.abil.squads[0]; s ? [s.x, s.y] : "no squad"; }',
  400, `shot:abil-ambush-hidden-${tag}`,
  `eval:{ const w = window.__app.world, s = w.abil.squads[0]; let pos = null, dir = 0;
    for (const [dx, dy] of [[56, 0], [-56, 0], [0, -56], [48, 0], [-48, 0], [0, -48], [64, 0], [0, 56]]) {
      const x = s.x + dx, y = s.y + dy, d = dx > 0 ? 1 : dx < 0 ? 3 : dy < 0 ? 0 : 2;
      if (!w.map.solidForTank(x - 8, y - 8, false) && !w.tankIn(x - 8, y - 8, 16, 16) && w.abil.clearLine(s.x, s.y, d, Math.abs(dx + dy) - 8)) { pos = [x, y]; dir = d; break; }
    }
    if (pos) { window.__t2 = window.__E(pos[0], pos[1], 3, (dir + 1) % 4); s.reload = 1; window.__step(1); }
    ({ pos, rockets: w.abil.rockets.length }); }`,
  300, `shot:abil-ambush-fire-${tag}`,
  'eval:{ const ab = window.__app.world.abil; let n = 0; while (ab.rockets.length && n < 30) { window.__step(1); n++; } window.__step(2); ({ n, hp: window.__t2 && window.__t2.hp }); }',
  200, `shot:abil-ambush-hit-${tag}`,
];
// an enemy under trees and a (stand-in) hidden mine: before, then with the recon drone up
const abilRecon = (tag) => [
  `eval:{ const w = window.__app.world, p = w.players[0]; for (const e of w.enemies) e.alive = false; w.enemies.length = 0;
    let hid = null;
    for (let y = Math.round(p.y / 4) * 4 - 72; y < p.y + 72 && !hid; y += 4) for (let x = Math.round(p.x / 4) * 4 - 152; x < p.x + 152 && !hid; x += 4) {
      if (Math.abs(x - p.x) < 28 && Math.abs(y - p.y) < 28) continue;
      if (w.map.solidForTank(x, y, false) || w.tankIn(x - 4, y - 4, 24, 24)) continue;
      let n = 0; for (let cy = y / 4; cy < y / 4 + 4; cy++) for (let cx = x / 4; cx < x / 4 + 4; cx++) if (w.map.at(cx, cy) === 4) n++;
      if (n >= 12) hid = [x + 8, y + 8];
    }
    if (hid) window.__E(hid[0], hid[1], 1);
    w.tricks.__demo = [{ x: p.cx - 56, y: p.cy + 34, hidden: true }];
    window.__step(2); ({ hid }); }`,
  400, `shot:abil-recon-before-${tag}`,
  'eval:{ window.__step(1, { ability: 3, abilityHeld: 3 }); window.__step(100); const ab = window.__app.world.abil; ({ pos: ab.reconPos(), until: ab.reconUntil, frame: window.__app.world.frame }); }',
  500, `shot:abil-recon-${tag}`,
];
const abilSteps = (env, tag, type) => [6500, ABIL_SETUP(env), 600, ...abilFpv(tag, type), ...abilAmbush(tag), ...abilRecon(tag)];

// ---------- Phase 3 enemy tricks (src/game/tricks.ts) ----------
// Puts the player on an open spot away from towns (trees allowed round it, none under the tank), tricks on manual,
// the director's tanks near the player removed and the rest held, the player's armour topped up so the scene
// runs on. env = 'day' | 'night'.
const TRK_SETUP = (env) => `eval:{
const a = window.__app, w = a.world, tr = w.tricks, p = w.players[0];
w.env = '${env}'; tr.auto = false; tr.teams.length = 0; tr.mines.length = 0;
p.spawn = 0; p.shield = 0; p.armour = p.armourMax;
const up = w.update.bind(w);
w.update = (inp) => {
  for (const e of w.enemies) if (!tr.owns(e)) { if (Math.hypot(e.cx - p.cx, e.cy - p.cy) < 300) e.alive = false; else e.stun = Math.max(e.stun, 2); }
  const q = w.players[0]; if (q) { q.shield = 0; if (q.armour < 4) q.armour = q.armourMax; }
  const h = window.__hold;
  if (h) { if (h.at < 0 && h.cond()) h.at = w.frame; if (h.at >= 0 && w.frame >= h.at + h.n) return; }
  up(inp);
};
const m = w.map; let spot = null;
for (let y = 96; y < w.pxH - 96 && !spot; y += 8) for (let x = 96; x < w.pxW - 96 && !spot; x += 8) {
  if (w.towns.some((t) => Math.hypot(t.cx - x, t.cy - y) < 170)) continue;
  let ok = true;
  for (let cy = (y - 48) >> 2; ok && cy < (y + 64) >> 2; cy++) for (let cx = (x - 72) >> 2; cx < (x + 88) >> 2; cx++) {
    const c = m.at(cx, cy), under = cx >= x >> 2 && cx < (x + 16) >> 2 && cy >= y >> 2 && cy < (y + 16) >> 2;
    if (!(c === 0 || c === 6 || (c === 4 && !under))) { ok = false; break; }
  }
  if (ok) spot = [x, y];
}
p.x = spot[0]; p.y = spot[1]; p.dir = 0;
({ spot, env: w.env }); }`;
const TRK_INFO = "eval:{ const tr = window.__app.world.tricks, p = window.__app.world.players[0]; ({ drones: tr.drones.map((d) => [d.phase, d.hold, Math.round(Math.hypot(d.x - p.cx, d.y - p.cy))]), bombs: tr.bombs.length, rockets: tr.rockets.length, barrage: tr.barrage && tr.barrage.shells.map((s) => [s.done, s.at - window.__app.world.frame]), convoy: tr.convoy && tr.convoy.vehicles.map((v) => [v.truck ? 'T' : 'E', v.alive, Math.round(v.x), Math.round(v.y)]), armour: p.armour, stats: tr.stats }); }";
// Hold the world (it stops updating; drawing goes on) once a condition over w / tr / p has held for n updates, so a
// shot catches an exact moment however fast the headless browser runs the game. GO lets it run again.
const HOLD = (cond, n = 0) => `eval:{ window.__hold = { cond: () => { const w = window.__app.world, tr = w.tricks, p = w.players[0]; return !!(${cond}); }, n: ${n}, at: -1 }; 1; }`;
const GO = 'eval:window.__hold = null';
// a drone flies in from up and right, hovers (shadow, red blink, red dot on the tank), then drops its grenade
// a drone coming from far above the screen: the red arrow on the screen edge (before it is in view)
const trkDroneEdge = (env) => [6500, TRK_SETUP(env), 600,
  'eval:{ const w = window.__app.world, p = w.players[0]; w.tricks.launchDrone(0, "attack", [p.cx + 40, p.cy - 150]); 1; }',
  HOLD("tr.drones[0] && Math.hypot(tr.drones[0].x - p.cx, tr.drones[0].y - p.cy) < 150"), 1500, TRK_INFO, `shot:trick-drone-edge-${env}`, GO];
const trkDrone = (env) => [6500, TRK_SETUP(env), 600,
  'eval:{ const w = window.__app.world, p = w.players[0]; w.tricks.launchDrone(0, "attack", [p.cx + 110, p.cy - 70]); 1; }',
  HOLD("tr.drones[0] && Math.hypot(tr.drones[0].x - p.cx, tr.drones[0].y - p.cy) < 120"), 1500, TRK_INFO, `shot:trick-drone-warn-${env}`, GO,
  HOLD("tr.drones[0] && Math.hypot(tr.drones[0].x - p.cx, tr.drones[0].y - p.cy) < 60"), 2500, TRK_INFO, `shot:trick-drone-approach-${env}`,
  GO, HOLD("tr.drones[0] && tr.drones[0].hold > 80"), 3000, TRK_INFO, `shot:trick-drone-hover-${env}`,
  GO, HOLD('tr.stats.bombHits > 0', 2), 3000, TRK_INFO, `shot:trick-drone-drop-${env}`, GO];
// an AT team in a copse 64 px off: the glint tell, the rocket in flight, then the team shown
const TRK_TEAM = `eval:{ const w = window.__app.world, tr = w.tricks, p = w.players[0];
const x = Math.round(p.cx + 64), y = Math.round(p.cy - 4);
for (let cy = (y >> 2) - 3; cy <= (y >> 2) + 3; cy++) for (let cx = (x >> 2) - 2; cx <= (x >> 2) + 4; cx++) w.map.set(cx, cy, 4);
tr.teams.push({ x, y, dir: 3, alive: true, shown: false, tell: 40, reload: 0, aim: [p.cx, p.cy], ruin: false, ammo: 1 }); ({ x, y }); }`;
const trkTeam = (env) => [6500, TRK_SETUP(env), 800, HOLD('tr.teams[0] && tr.teams[0].tell > 0 && tr.teams[0].tell < 22'), TRK_TEAM, 2000, TRK_INFO, `shot:trick-team-tell-${env}`,
  GO, HOLD('tr.rockets[0] && tr.rockets[0].d > 26'), 2000, TRK_INFO, `shot:trick-team-rocket-${env}`, GO, 2500, `shot:trick-team-shown-${env}`];
// a minefield 30 px ahead: hidden (disturbed earth only), shown by recon, then the tank drives onto one
const TRK_MINES = `eval:{ const w = window.__app.world, tr = w.tricks, p = w.players[0];
for (const [dx, dy] of [[0, -30], [14, -38], [-12, -44]]) tr.mines.push({ x: Math.round(p.cx + dx), y: Math.round(p.cy + dy), alive: true, shown: false, decal: false, field: 0 });
tr.mines.length; }`;
const trkMine = (env) => [6500, TRK_SETUP(env), 800, TRK_MINES, 1200, `shot:trick-mine-hidden-${env}`, 'eval:window.__app.world.tricks.reveal = true', 600, `shot:trick-mine-recon-${env}`,
  HOLD('tr.stats.minesHit > 0', 3), 'eval:{ const w = window.__app.world, tr = w.tricks, p = w.players[0]; tr.reveal = false; p.x = tr.mines[0].x - 8; p.y = tr.mines[0].y - 9; 1; }',
  2000, TRK_INFO, `shot:trick-mine-blast-${env}`, GO, 3000, `shot:trick-mine-crater-${env}`];
// a barrage: the warning circles grow and blink faster, the first shell lands 1.8 s after its circle, craters
const trkArt = (env) => [6500, TRK_SETUP(env), 800,
  HOLD('tr.barrage && w.frame >= tr.barrage.shells[0].appear + 40'),
  'eval:{ const w = window.__app.world, p = w.players[0]; w.tricks.startBarrage(p.cx + 30, p.cy - 26, false); w.tricks.barrage.shells.length; }',
  2000, TRK_INFO, `shot:trick-art-warn-${env}`, GO, HOLD('tr.barrage && w.frame >= tr.barrage.shells[0].at - 10'), 2000, TRK_INFO, `shot:trick-art-warn2-${env}`,
  GO, HOLD('tr.stats.shells >= 1', 3), 2000, TRK_INFO, `shot:trick-art-impact-${env}`, GO, 3500, `shot:trick-art-craters-${env}`];
// a convoy on the road, the player parked beside it, then a truck hit
const TRK_CONVOY = `eval:{ const w = window.__app.world, tr = w.tricks, p = w.players[0];
const cv = tr.launchConvoy(true); cv.s = Math.min(cv.len - 80, 260);
const [tx, ty, d] = tr.posAt(cv, cv.s - 48);
const offRoute = (x, y) => { for (let q = 0; q <= cv.len; q += 8) { const [rx, ry] = tr.posAt(cv, q); if (Math.abs(rx - x) < 20 && Math.abs(ry - y) < 20) return false; } return true; };
let s = null;
for (const o of [40, -40, 56, -56, 72, -72]) { const x = Math.round((tx + (d & 1 ? 0 : o)) / 8) * 8, y = Math.round((ty + (d & 1 ? o : 0)) / 8) * 8; if (!w.map.solidForTank(x, y, false) && offRoute(x, y)) { s = [x, y]; break; } }
s ??= w.freeSpotNear(tx + 48, ty + 48);
p.x = s[0]; p.y = s[1]; ({ from: cv.from, to: cv.to, len: cv.len, at: [tx, ty], player: s }); }`;
const TRK_HIT = 'eval:{ const w = window.__app.world, tr = w.tricks, p = w.players[0]; const v = tr.convoy.vehicles.find((v) => v.truck && v.alive && v.in); tr.bulletHit({ x: v.x + 8, y: v.y + 8, owner: p }); ({ hit: !v.alive, pickups: w.pickups.length }); }';
const trkConvoy = (env) => [6500, TRK_SETUP(env), 600, TRK_CONVOY, 700, TRK_INFO, `shot:trick-convoy-${env}`,
  HOLD('tr.stats.trucksKilled > 0', 3), TRK_HIT, 1500, `shot:trick-convoy-hit-${env}`, GO, 3000, `shot:trick-convoy-wreck-${env}`];

// steps: number = wait ms, 'shot' / 'shot:name' = screenshot, 'key:Code' = press a key
// ---------- Phase 4 bosses (src/game/boss.ts) ----------
// Region test map: three towns freed (the boss reveals at its lair with its escort), the director and tricks
// stopped, the player parked ~110 px from the boss's side facing it, the boss turned toward the player. The world's
// own update is off and the scene steps it (window.__step), so each shot lands on an exact frame.
const BOSS_SETUP = (env, escort = true) => `eval:{
const a = window.__app, w = a.world, p = w.players[0], b = w.boss, up = Object.getPrototypeOf(w).update;
a.opts.autoplay = true; // recruits join without the card (the world's update is ours, so no autopilot)
w.env = '${env}';
for (const t of w.towns.slice(0, 3)) w.freeTown(t);
b.reveal();
if (w.ai) w.ai.update = () => {};
if (w.tricks) w.tricks.update = () => {};
for (const e of w.enemies) if (${escort ? 'Math.hypot(e.cx - b.cx, e.cy - b.cy) > 120' : 'true'}) e.alive = false;
w.enemies = w.enemies.filter((e) => e.alive);
for (const e of w.enemies) { e.spawn = 0; e.aiFire = 1e9; }
w.bullets.length = 0;
p.spawn = 0; p.shield = 0; p.armour = p.armourMax;
const s = w.freeSpotNear(b.cx - 8 - 110, b.cy - 8) || w.freeSpotNear(b.cx - 8 + 110, b.cy - 8);
p.x = s[0]; p.y = s[1];
p.dir = p.cx < b.cx ? 1 : 3;
b.dir = b.tdir = p.cx < b.cx ? 0 : 0;
window.__step = (n, inp = {}) => { const i = { dir: -1, fire: false, ...inp }; for (let k = 0; k < n; k++) { const q = w.players[0]; if (q) { q.shield = 0; if (q.armour < 4) q.armour = q.armourMax; } up.call(w, [i, { dir: -1, fire: false }]); } };
window.__freezeBoss = () => { b.reload = 1e9; b.mg[0].t = b.mg[1].t = 1e9; };
w.update = () => {};
b.drive = () => {}; // parked, for steady shots
window.__freezeBoss();
window.__step(2);
({ boss: [b.x, b.y, b.dir, b.state], player: [p.x, p.y], lair: b.lairNear, escort: w.enemies.length });
}`;
const BOSSINFO = 'eval:{ const b = window.__app.world.boss; ({ state: b.state, glow: b.glow, parts: b.parts.map((q) => q.id + ":" + q.hp), turret: b.tdir, dir: b.dir }); }';
// the main-gun tell: turret on the player, the barrel glowing 40 frames in
const BOSS_TELL = [
  `eval:{ const w = window.__app.world, b = w.boss, p = w.players[0]; b.state = 'hunt'; b.reload = 0; b.tdir = p.cx < b.cx ? 3 : 1; p.y = b.cy - 8; let n = 0; while (b.glow < 40 && n < 200) { window.__step(1); n++; b.stepLeft = 0; } ({ n, glow: b.glow }); }`,
  400, BOSSINFO, 'shot:boss-tell',
  'eval:{ const b = window.__app.world.boss; let n = 0; while (b.glow >= 0 && n < 40) { window.__step(1); n++; } window.__step(14); window.__freezeBoss(); ({ n, shells: window.__app.world.bullets.map((x) => x.dmg) }); }',
  300, 'shot:boss-shell',
];
// diagonal fire (bosses/aim.ts): the player parked ~100 px off the boss on a diagonal, a brick patch on the line
// between; the turret slews onto them, the tell (glow + dotted line along the real angle), the shell in flight, its
// hit on the brick and the bite it leaves
const BOSS_DIAG = (tag) => [
  `eval:{ const w = window.__app.world, b = w.boss, p = w.players[0], m = w.map;
  let best = null;
  for (const [dx, dy] of [[-1, -1], [1, -1], [-1, 1], [1, 1]]) {
    const s = w.freeSpotNear(b.cx - 8 + dx * 72, b.cy - 8 + dy * 72);
    if (!s) continue;
    const d = Math.hypot(s[0] + 8 - b.cx, s[1] + 8 - b.cy), a = Math.abs(Math.abs(s[0] + 8 - b.cx) - Math.abs(s[1] + 8 - b.cy));
    if (d > 80 && d < 140 && (!best || a < best[1])) best = [s, a];
  }
  const s = best[0]; p.x = s[0]; p.y = s[1]; p.dir = 0;
  // open ground on the line, a 5 x 5 cell brick patch 62% of the way out
  const ux = p.cx - b.cx, uy = p.cy - b.cy;
  for (let k = 0.3; k < 1; k += 0.01) { const cx = Math.floor((b.cx + ux * k) / 4), cy = Math.floor((b.cy + uy * k) / 4); for (let j = -3; j <= 3; j++) for (let i = -3; i <= 3; i++) m.set(cx + i, cy + j, 0); }
  const bx = Math.floor((b.cx + ux * 0.62) / 4), by = Math.floor((b.cy + uy * 0.62) / 4);
  for (let j = -2; j <= 2; j++) for (let i = -2; i <= 2; i++) m.set(bx + i, by + j, 1);
  b.state = 'hunt'; b.reload = 0; b.glow = -1; b.target = p;
  let n = 0; while (b.glow < 40 && n < 300) { window.__step(1); n++; b.stepLeft = 0; b.mg[0].t = b.mg[1].t = 1e9; }
  ({ n, glow: b.glow, turret: b.ta.toFixed(2), toPlayer: Math.atan2(ux, -uy).toFixed(2) }); }`,
  400, `shot:bossdiag-tell${tag}`,
  'eval:{ const w = window.__app.world, b = w.boss; let n = 0; while (b.glow >= 0 && n < 40) { window.__step(1); n++; } window.__step(10); b.reload = 1e9; const s = w.bullets.find((x) => x.dmg >= 3); ({ n, shell: s ? [s.ux.toFixed(2), s.uy.toFixed(2), s.free] : null }); }',
  300, `shot:bossdiag-shell${tag}`,
  'eval:{ const w = window.__app.world; let n = 0; while (w.bullets.some((x) => x.dmg >= 3) && n < 120) { window.__step(1); n++; } window.__step(2); ({ n }); }',
  250, `shot:bossdiag-brick${tag}`,
  'eval:{ window.__step(50); 1; }', 300, `shot:bossdiag-bite${tag}`,
];
// weak points: the left gun destroyed by a drone (the blast), then the skirt shot off (smoke, exposed tread)
const BOSS_WEAK = [
  `eval:{ const w = window.__app.world, b = w.boss; window.__step(80); window.__freezeBoss(); b.popSmoke = () => {}; const q = b.parts[1]; const r = b.partRect(q); b.droneHit(r[0] + r[2] / 2, r[1] + r[3] / 2, 3, 0); window.__step(4); ({ parts: b.parts.map((x) => x.id + ":" + x.hp) }); }`,
  300, 'shot:boss-weak-blast',
  `eval:{ const w = window.__app.world, b = w.boss; const q = b.parts[0]; const r = b.partRect(q); for (let i = 0; i < 2; i++) b.droneHit(r[0] + r[2] / 2, r[1] + r[3] / 2, 3, 0); window.__step(90); window.__freezeBoss(); ({ parts: b.parts.map((x) => x.id + ":" + x.hp), exposed: b.exposed() }); }`,
  400, 'shot:boss-weak-after',
];
// death: the blast chain, the final explosion, the wreck
const BOSS_DEATH = [
  'eval:{ const b = window.__app.world.boss; b.kill(0); window.__step(60); ({ state: b.state }); }', 250, 'shot:boss-dying',
  'eval:{ const b = window.__app.world.boss; let n = 0; while (b.state === "dying" && n < 200) { window.__step(1); n++; } window.__step(6); ({ state: b.state, n }); }', 250, 'shot:boss-final',
  'eval:{ window.__step(240); const w = window.__app.world; ({ state: w.boss.state, scrap: w.scrap, found: w.found }); }', 500, 'shot:boss-wreck',
];

// ---------- Phase 4 regions (src/game/regions/*.ts) ----------
// ?region=N&stage=K plays region K-1 of a throwaway run on map seed N: 2 rail junction, 3 river delta, 4 ruined
// town, 5 winter front. Spots are expressions over w = world giving a tank top-left; ENV switches the look.
const ENV = (e) => `eval:window.__app.world.env = '${e}'`;
const RAILPT = (f) => `(() => { const r = w.region.rail; const q = r[Math.round((r.length - 1) * ${f})]; return [Math.round(q[0] / 8) * 8, Math.round(q[1] / 8) * 8 + 16]; })()`;
const RAILYARD = `(() => { const t = w.region.towns[0], r = w.region.rail; let b = r[0]; for (const q of r) if (Math.hypot(q[0] - t.cx, q[1] - t.cy) < Math.hypot(b[0] - t.cx, b[1] - t.cy)) b = q; return [Math.round(b[0] / 8) * 8, Math.round(b[1] / 8) * 8 + 24]; })()`;
const XING = '[w.region.bridges[0][0], w.region.bridges[0][1] + 40]';
const RIVERPT = (f) => `(() => { const r = w.region.river; const q = r[Math.round((r.length - 1) * ${f})]; const m = w.map; let y = Math.round(q[1] / 8) * 8; while (y < w.pxH - 16 && m.solidForTank(q[0], y, false)) y += 8; return [Math.round(q[0] / 8) * 8, y + 8]; })()`;
const TOWNN = (i) => `[w.region.towns[${i}].cx - 8, w.region.towns[${i}].cy + 8]`;
const LAIR = '[w.region.lair[0] - 8, w.region.lair[1] + 24]';
// ambient.ts: the map's fires and lamps, and how many sit in the current view
const AMBINFO = "eval:(() => { const a = window.__app.world.region.ambient ?? []; return { fires: a.filter((s) => s.kind === 0).length, street: a.filter((s) => s.kind === 1).length, lamps: a.filter((s) => s.kind === 2).length, working: a.filter((s) => s.kind === 2 && s.seed < 0.38).length }; })()";
const AMBVIEW = "eval:(() => { const a = window.__app, c = a.cam, w = a.world; const v = (w.region.ambient ?? []).filter((s) => s.x > c.x - 60 && s.y > c.y - 60 && s.x < c.x + c.viewW + 60 && s.y < c.y + c.viewH + 60); return { view: [Math.round(c.viewW), Math.round(c.viewH)], fires: v.filter((s) => s.kind < 2).length, lamps: v.filter((s) => s.kind === 2 && s.seed < 0.38).length }; })()";
// the k-th block of 4 x 4 tree cells nearest town 0, with the tank parked 40 px below it
const TREESPOT = (k) => `(() => { const m = w.map, t = w.region.towns[0], c = []; for (let y = 2; y < m.h - 6; y += 2) for (let x = 2; x < m.w - 6; x += 2) { let n = 0; for (let j = 0; j < 4; j++) for (let i = 0; i < 4; i++) if (m.c[(y + j) * m.w + x + i] === 4) n++; if (n === 16) c.push([Math.hypot(x * 4 - t.cx, y * 4 - t.cy), x, y]); } c.sort((a, b) => a[0] - b[0]); const b = c[Math.min(${k} * 12, c.length - 1)]; return [Math.round(b[1] / 2) * 8, Math.round(b[2] / 2) * 8 + 40]; })()`;
const BRIDGEN = (i) => `w.region.bridges[${i}]`;
// Structures round: spots and helpers for the struct* scenes
const STRUCT_VP = { width: 1920, height: 1080 };
const STRUCT_HUD = "eval:{ for (const el of document.body.children) if (el.tagName !== 'CANVAS' && el.id !== 'err') el.style.visibility = 'hidden'; 1; }";
const DEPOTN = (i) => `(() => { const d = w.region.depots[Math.min(${i}, w.region.depots.length - 1)]; return [Math.round((d.cx - 8) / 8) * 8, Math.round((d.cy - 8) / 8) * 8]; })()`;
// the k-th open tank spot (16 clear cells) whose ground kind is `kind` (RegionSpec.kinds), spread out; the map centre
// if the region has none
const KINDSPOT = (kind, k) => `(() => { const m = w.map, kd = w.region.kinds, c = []; if (kd) for (let y = 4; y < m.h - 8; y += 4) for (let x = 4; x < m.w - 8; x += 4) { let n = 0; for (let j = 0; j < 4; j++) for (let i = 0; i < 4; i++) if (m.c[(y + j) * m.w + x + i] === 0 && (kd[(y + j) * m.w + x + i] & 15) === ${kind}) n++; if (n === 16) c.push([x, y]); } if (!c.length) return [Math.round(m.w / 4) * 8, Math.round(m.h / 4) * 8]; const b = c[Math.min(c.length - 1, Math.floor(c.length / 2) + ${k} * 7)]; return [b[0] * 4, b[1] * 4]; })()`;
// an open tank spot outside the towns with the most brick within 12 cells (the winter line's trenches and bunkers)
const BRICKSPOT = `(() => { const m = w.map, W = m.w; let best = [Math.round(m.w / 4) * 8, Math.round(m.h / 4) * 8], bs = -1; for (let y = 16; y < m.h - 20; y += 4) for (let x = 16; x < W - 20; x += 4) { if (w.region.towns.some((t) => x * 4 > t.rect[0] - 80 && x * 4 < t.rect[0] + t.rect[2] + 80 && y * 4 > t.rect[1] - 80 && y * 4 < t.rect[1] + t.rect[3] + 80)) continue; if (w.region.depots.some((d) => Math.hypot(d.cx - x * 4, d.cy - y * 4) < 140)) continue; if (w.region.lair && Math.hypot(w.region.lair[0] - x * 4, w.region.lair[1] - y * 4) < 200) continue; let ok = true; for (let j = 0; j < 4 && ok; j++) for (let i = 0; i < 4; i++) if (m.c[(y + j) * W + x + i] !== 0) ok = false; if (!ok) continue; let n = 0; for (let j = -12; j < 16; j++) for (let i = -12; i < 16; i++) if (m.c[(y + j) * W + x + i] === 1) n++; if (n > bs) { bs = n; best = [x * 4, y * 4]; } } return best; })()`;
// the station: the open paved tank spot (platform) with the most tiled floor (the station hall) within 14 cells
const STATIONSPOT = `(() => { const m = w.map, W = m.w, kd = w.region.kinds; let best = [Math.round(m.w / 4) * 8, Math.round(m.h / 4) * 8], bs = -1; if (kd) for (let y = 16; y < m.h - 20; y += 2) for (let x = 16; x < W - 20; x += 2) { let ok = true; for (let j = 0; j < 4 && ok; j++) for (let i = 0; i < 4; i++) if (m.c[(y + j) * W + x + i] !== 0 || (kd[(y + j) * W + x + i] & 15) !== 2) { ok = false; break; } if (!ok) continue; let n = 0; for (let j = -14; j < 18; j++) for (let i = -14; i < 18; i++) { const q = (y + j) * W + x + i; if ((kd[q] & 15) === 8) n++; if (m.c[q] === 7) n += 0.5; } if (n > bs) { bs = n; best = [x * 4, y * 4]; } } return best; })()`;
const structSpots = (tag, spots) => spots.flatMap(([name, spot]) => [TP(spot), 2500, `shot:struct-${tag}-${name}`]);
// A straight east-west road (cell type 6, 4 cells wide, 26+ cells long) with the most trees beside it to the west:
// returns the tank's top-left in px at the road's east end.
const ROADSPOT = `(() => { const m = w.map, c = m.c, W = m.w; let best = null, bs = -1;
  for (let y = 8; y < m.h - 12; y += 2) for (let x = 40; x < W - 8; x += 2) {
    let ok = true;
    for (let j = 0; j < 4 && ok; j++) for (let i = -24; i < 4; i++) if (c[(y + j) * W + x + i] !== 6) { ok = false; break; }
    if (!ok) continue;
    let s = 0;
    for (let j = -14; j < 18; j++) for (let i = -36; i < 4; i++) if (c[(y + j) * W + x + i] === 4) s++;
    if (s > bs) { bs = s; best = [x, y]; }
  }
  return [Math.round(best[0] * 4 / 8) * 8, Math.round(best[1] * 4 / 8) * 8]; })()`;
const HEADLEFT = 'eval:{ const p = window.__app.world.players[0]; p.dir = 3; [p.x, p.y]; }';
// scale the scene's fog (the headlight's air glow): FOGK(0) shows the light on the ground only
const FOGK = (k) => `eval:{ const r = window.__app.r; if (!r.__fogK) { const d = r.render.bind(r); r.__fogK = 1; r.render = (t) => { r.env.fog *= r.__fogK; d(t); }; } r.__fogK = ${k}; 1; }`;
// Rails round: the steepest stretch of the main line, and the turnouts at either end of the junction yard (where
// the band of RAIL cells across the line first / last widens past one track); the tank parks beside the track
const RAILHZ = 'Math.abs(r[r.length - 1][0] - r[0][0]) > Math.abs(r[r.length - 1][1] - r[0][1])';
const RAILSTEEP = `(() => { const r = w.region.rail, hz = ${RAILHZ}; let b = 1, bs = -1; for (let i = 1; i < r.length; i++) { const dx = Math.abs(r[i][0] - r[i - 1][0]), dy = Math.abs(r[i][1] - r[i - 1][1]); const s = hz ? dy / dx : dx / dy; if (s > bs && i > 8 && i < r.length - 8) { bs = s; b = i; } } const q = r[b]; return [Math.round(q[0] / 8) * 8 + (hz ? 0 : 24), Math.round(q[1] / 8) * 8 + (hz ? 24 : 0)]; })()`;
const RAILSWITCH = (end, off = 3) => `(() => { const r = w.region.rail, m = w.map, hz = ${RAILHZ}, wide = []; r.forEach((q, i) => { let n = 0; for (let k = -14; k <= 14; k++) { const x = (q[0] >> 2) + (hz ? 0 : k), y = (q[1] >> 2) + (hz ? k : 0); if (x >= 0 && y >= 0 && x < m.w && y < m.h && m.c[y * m.w + x] === 7) n++; } if (n >= 7) wide.push(i); }); const i = ${end} ? wide[wide.length - 1] - ${off} : wide[0] + ${off}; const q = r[Math.max(0, Math.min(r.length - 1, i))]; return [Math.round(q[0] / 8) * 8 + (hz ? 0 : 40), Math.round(q[1] / 8) * 8 + (hz ? 40 : 0)]; })()`;
// the point of the main line where it turns most over 6 points (the test map's corners), tank parked 32 px off it
const RAILBEND = `(() => { const r = w.region.rail; let b = 3, bs = -1; for (let i = 3; i < r.length - 3; i++) { const ax = r[i][0] - r[i - 3][0], ay = r[i][1] - r[i - 3][1], bx = r[i + 3][0] - r[i][0], by = r[i + 3][1] - r[i][1]; const s = Math.abs(ax * by - ay * bx) / (Math.hypot(ax, ay) * Math.hypot(bx, by)); if (s > bs) { bs = s; b = i; } } const q = r[b]; return [Math.round(q[0] / 8) * 8 - 40, Math.round(q[1] / 8) * 8 - 40]; })()`;
// the train moved 250 px on along its line and held there, so the track it stood on shows
const TRAIN_AWAY = 'eval:{ const b = window.__app.world.boss; b.H = Math.min(b.hMax, b.H + 250); b.place(); b.waitT = 1e9; b.v = 0; ({ H: Math.round(b.H), off: b.offRail() }); }';
const REGIONINFO = 'eval:({ name: window.__app.world.region.name, env: window.__app.world.env, boss: window.__app.world.region.boss, size: [window.__app.world.region.w, window.__app.world.region.h], towns: window.__app.world.region.towns.map((t) => t.name), rail: window.__app.world.region.rail?.length, river: window.__app.world.region.river?.length, lair: window.__app.world.region.lair })';

// ---------- Phase 4 bosses, regions 4-5 (src/game/bosses/heli.ts, final.ts) on the ?bosstest= maps ----------
// The world's own update is off and the scene steps it (window.__step); the director is off, no enemy tanks. The
// boss's own update keeps running inside __step. window.__until(cond, max) steps one frame at a time until cond.
const B4_SETUP = (keep = false) => `eval:{
const a = window.__app, w = a.world, p = w.players[0], b = w.boss, up = Object.getPrototypeOf(w).update;
a.opts.autoplay = true;
for (const t of w.towns.slice(0, 3)) w.freeTown(t);
b.reveal();
if (w.ai) w.ai.update = () => {};
if (w.tricks) w.tricks.auto = false;
for (const e of w.enemies) if (!${keep} || Math.hypot(e.cx - b.cx, e.cy - b.cy) > 150) e.alive = false;
w.enemies = w.enemies.filter((e) => e.alive);
for (const e of w.enemies) { e.spawn = 0; e.aiFire = 1e9; }
w.bullets.length = 0;
p.spawn = 0; p.shield = 0; p.armour = p.armourMax;
window.__step = (n, inp = {}) => { const i = { dir: -1, fire: false, ...inp }; for (let k = 0; k < n; k++) { const q = w.players[0]; if (q) { q.shield = 0; if (q.armour < 4) q.armour = q.armourMax; } up.call(w, [i, { dir: -1, fire: false }]); for (const e of w.enemies) e.aiFire = 1e9; } };
window.__until = (f, max = 900) => { let n = 0; while (!f() && n < max) { window.__step(1); n++; } return n; };
w.update = () => {};
window.__step(2);
({ boss: b.kind, at: [Math.round(b.x), Math.round(b.y)], player: [p.x, p.y] });
}`;
// helicopter: hovering high over the ruins near the player, the searchlight on him, rain
const HELI_POSE = `eval:{
const w = window.__app.world, p = w.players[0], h = w.boss;
const s = w.freeSpotNear(h.cx - 8 - 70, h.cy - 8 + 60) || w.freeSpotNear(h.cx - 8, h.cy - 8 + 80);
p.x = s[0]; p.y = s[1]; p.dir = 1;
h.state = 'hunt'; h.mode = 'cruise'; h.alt = 1; h.dir = 3; h.target = p; h.lastSeen = w.frame; h.lastAt = [p.cx, p.cy];
h.lightAng = Math.atan2(p.cy - h.cy, p.cx - h.cx);
h.think = () => { h.modeT++; }; h.fly = () => {}; h.turn = () => {};
window.__step(40);
({ heli: [Math.round(h.x), Math.round(h.y), h.alt], player: [p.x, p.y] });
}`;
const HELI_LOW = `eval:{ const w = window.__app.world, h = w.boss; h.alt = 0.24; h.x -= 20; h.y += 6; window.__step(20); ({ alt: h.alt }); }`;
const HELI_FREE = `eval:{ const h = window.__app.world.boss; delete h.think; delete h.fly; delete h.turn; 1; }`;
const HELI_STRAFE = `eval:{
const w = window.__app.world, p = w.players[0], h = w.boss;
const ps = w.freeSpotNear(Math.round((h.cx - 8 + 120) / 8) * 8, Math.round((h.cy - 8) / 8) * 8); p.x = ps[0]; p.y = ps[1];
h.alt = 1; h.startStrafe([p.cx, p.cy]);
const n = window.__until(() => h.mode === 'strafeTell' && h.modeT >= 34, 900);
({ n, mode: h.mode, strafe: h.strafe, alt: h.alt.toFixed(2) });
}`;
const HELI_RUN = `eval:{ const w = window.__app.world, h = w.boss; const n = window.__until(() => h.mode === 'strafe' && h.modeT >= 46, 400); ({ n, mode: h.mode, shots: h.stats.strafeShots, hits: h.stats.strafeHits }); }`;
const HELI_SALVO = `eval:{
const w = window.__app.world, p = w.players[0], h = w.boss;
window.__until(() => h.mode === 'cruise' || h.mode === 'recover', 300);
const ps = w.freeSpotNear(Math.round((h.cx - 8 - 100) / 8) * 8, Math.round((h.cy - 8) / 8) * 8); p.x = ps[0]; p.y = ps[1];
h.goalPt = [h.cx, h.cy]; h.mode = 'salvoGo'; h.modeT = 0;
const n = window.__until(() => h.mode === 'salvoTell' && h.modeT >= 40, 900);
({ n, mode: h.mode, marks: h.marks.length });
}`;
const HELI_ROCKETS = `eval:{ const w = window.__app.world, h = w.boss; const n = window.__until(() => h.mode === 'salvoFire' && h.rockets.length >= 2, 300); ({ n, rockets: h.rockets.length }); }`;
// clutter for the readability shots: shell blasts and drifting black smoke on the warnings (the strafing line or the
// rocket marks), then 4 frames on so the flashes are lit
const STORM_FN = `eval:{
window.__storm = () => {
  const w = window.__app.world, h = w.boss, p = w.players[0], pts = [];
  if (h.marks.some((m) => !m.done)) for (const m of h.marks) pts.push([m.x, m.y]);
  else if (h.strafe) { const s = h.strafe, L = Math.abs(s.ex - s.sx) + Math.abs(s.ey - s.sy); for (const f of [0.35, 0.6, 0.85]) pts.push([s.sx + [0, 1, 0, -1][s.d] * L * f, s.sy + [-1, 0, 1, 0][s.d] * L * f]); }
  else pts.push([p.cx + 20, p.cy]);
  // blasts close by (not on top: a rocket only lands once its mark is done), smoke drifting over the warnings
  pts.forEach(([x, y], i) => w.explode(x + (i % 2 ? -22 : 20), y + (i % 2 ? 16 : -20), i % 2 === 0));
  for (let i = 0; i < 24; i++) { const [x, y] = pts[i % pts.length]; w.parts.push({ x: x + (Math.random() - 0.5) * 24, y: y + (Math.random() - 0.5) * 16, z: 10, vx: 0, vy: -0.1, vz: 0, life: 0, max: 140, col: [0.09, 0.085, 0.08], kind: 2, r: 6 + Math.random() * 3 }); }
  window.__step(4);
  w.shake = 0; // the world update that settles it is off
  return pts.length;
};
1;
}`;
const STORM = () => 'eval:window.__storm()';
const HELI_POD = `eval:{
const w = window.__app.world, h = w.boss;
window.__until(() => h.mode === 'recover', 400);
const p = w.players[0]; const ps = w.freeSpotNear(Math.round((h.cx - 8 - 90) / 8) * 8, Math.round((h.cy - 8 + 10) / 8) * 8); p.x = ps[0]; p.y = ps[1];
const q = h.parts[0]; const r = h.partRect(q);
h.think = () => { h.modeT++; }; h.fly = () => {};
h.droneHit(r[0] + r[2] / 2, r[1] + r[3] / 2, 3, 0);
window.__step(14);
({ parts: h.parts.map((x) => x.id + ':' + x.hp), alt: h.alt.toFixed(2) });
}`;
const HELI_POD_AFTER = `eval:{ window.__step(80); const h = window.__app.world.boss; ({ parts: h.parts.map((x) => x.id + ':' + x.hp) }); }`;
const HELI_DIE = `eval:{ const w = window.__app.world, h = w.boss; delete h.think; delete h.fly; h.alt = 0.9; h.kill(0); window.__step(70); ({ state: h.state, alt: h.alt.toFixed(2) }); }`;
const HELI_CRASH = `eval:{ const w = window.__app.world, h = w.boss; const n = window.__until(() => h.state === 'dead', 300); window.__step(5); ({ n, state: h.state }); }`;
const HELI_WRECK = `eval:{ window.__step(240); const w = window.__app.world; ({ state: w.boss.state, scrap: w.scrap }); }`;

// ---------- drone countermeasures (2026-11-18): VULTURE's flares, GRINDER's smoke ----------
// window.__drone() launches an FPV drone from the player at the boss's weak point, locked on, as a tap does.
const DRONE_FN = `eval:{
window.__drone = () => { const w = window.__app.world, p = w.players[0], b = w.boss, ab = w.abil; w.allAbilities = true; w.charges[0] = 9;
  const [x, y] = b.aimPoint(); ab.launchFpv(0, p, x, y, null); const f = ab.fpvs[ab.fpvs.length - 1]; f.bossLock = [x - b.x, y - b.y]; return f; };
1;
}`;
// high (cruising): the flares burst out and the drone swerves after them, then pops ("DECOYED")
const FLARE_HIGH = `eval:{ const w = window.__app.world, h = w.boss; const f = window.__drone();
const n = window.__until(() => !!f.lost && f.t >= 7, 200); ({ n, lost: f.lost, decoys: h.stats.decoys, alt: h.alt, flares: h.flares.length }); }`;
const FLARE_POP = `eval:{ const w = window.__app.world, h = w.boss; const n = window.__until(() => !w.abil.fpvs.length, 200); window.__step(5);
({ n, decoys: h.stats.decoys, hp: h.parts.map((q) => q.id + ':' + q.hp) }); }`;
// low (hanging after an attack): the first drone gets through (-4 on the pod), and it starts dumping flares
const FLARE_LOW = `eval:{ const w = window.__app.world, h = w.boss; window.__step(80); h.alt = 0.24; h.mode = 'recover'; h.flaring = false; window.__step(20); window.__drone();
const n = window.__until(() => h.stats.droneHits > 0, 200); window.__step(7); ({ n, hits: h.stats.droneHits, flaring: h.flaring, hp: h.parts.map((q) => q.id + ':' + q.hp) }); }`;
// the same pass: the second drone is decoyed
const FLARE_SECOND = `eval:{ const w = window.__app.world, h = w.boss; window.__step(50); const f = window.__drone();
const n = window.__until(() => !!f.lost && f.t >= 9, 200); ({ n, lost: f.lost, decoys: h.stats.decoys, hits: h.stats.droneHits }); }`;
// GRINDER: the player below it; a drone hits the turret side, the smoke dischargers fire; the next drone loses it
const SMOKE_HIT = `eval:{ const w = window.__app.world, b = w.boss, p = w.players[0]; window.__step(80); window.__freezeBoss();
const s = w.freeSpotNear(b.cx - 8 - 30, b.cy - 8 + 110) || w.freeSpotNear(b.cx - 8, b.cy - 8 + 120); p.x = s[0]; p.y = s[1]; p.dir = 0; window.__drone();
let n = 0; while (!b.stats.droneHits && n < 200) { window.__step(1); n++; } window.__step(26); ({ n, smokes: b.stats.smokes, open: b.droneOpen(), hp: b.parts.map((q) => q.id + ':' + q.hp) }); }`;
const SMOKE_LOST = `eval:{ const w = window.__app.world, b = w.boss; window.__step(40); const f = window.__drone();
let n = 0; while (!(f.lost && f.t >= 8) && n < 200) { window.__step(1); n++; } ({ n, lost: f.lost, dronesLost: b.stats.dronesLost }); }`;
const SMOKE_POP = `eval:{ const w = window.__app.world, b = w.boss; let n = 0; while (w.abil.fpvs.length && n < 200) { window.__step(1); n++; } window.__step(5); ({ n, hp: b.parts.map((q) => q.id + ':' + q.hp) }); }`;

// the final fight: the winter tank at the gate; the bunker guns' tell; a barrage and a drone; the car's run; victory
const FIN_POSE = `eval:{
const w = window.__app.world, p = w.players[0], f = w.boss, t = f.tank;
const fx = [0, 1, 0, -1][f.face], fy = [-1, 0, 1, 0][f.face];
const s = w.freeSpotNear(t.cx - 8 + fx * 100, t.cy - 8 + fy * 100);
p.x = s[0]; p.y = s[1]; p.dir = (f.face + 2) & 3;
t.reload = 1e9; t.mg[0].t = t.mg[1].t = 1e9; t.drive = () => {};
window.__step(30);
({ site: f.site, face: f.face, tank: [t.x, t.y, t.state], player: [p.x, p.y], escort: w.enemies.length });
}`;
const FIN_P2 = `eval:{
const w = window.__app.world, p = w.players[0], f = w.boss, t = f.tank;
for (const e of w.enemies) e.alive = false;
t.kill(0);
const n = window.__until(() => f.phase === 2, 600);
const g = f.guns[0], gx = g.rect[0] + 8, gy = g.rect[1] + 8;
const fx = [0, 1, 0, -1][f.face], fy = [-1, 0, 1, 0][f.face];
p.x = gx - 8 + fx * 96; p.y = gy - 8 + fy * 96; p.dir = (f.face + 2) & 3;
for (let cy = p.y / 4; cy < p.y / 4 + 4; cy++) for (let cx = p.x / 4; cx < p.x / 4 + 4; cx++) w.map.set(cx, cy, 0);
for (const q of f.guns) q.reload = q === g ? 0 : 1e9;
const m = window.__until(() => g.glow >= 30, 600);
({ n, m, phase: f.phase, glow: g.glow, tdir: g.tdir, player: [p.x, p.y], gun: [gx, gy] });
}`;
const FIN_BARRAGE = `eval:{
const w = window.__app.world, p = w.players[0], f = w.boss;
window.__until(() => f.guns[0].glow < 0, 120);
window.__step(30);
w.tricks.startBarrage(p.cx + 34, p.cy - 18, false);
w.tricks.launchDrone(0, 'attack', [p.cx + 60, p.cy - 60]);
window.__step(70);
({ barrage: !!w.tricks.barrage, drones: w.tricks.drones.length, bullets: w.bullets.length });
}`;
const FIN_P3 = `eval:{
const w = window.__app.world, p = w.players[0], f = w.boss;
w.tricks.barrage = null; w.tricks.drones.length = 0; w.bullets.length = 0;
for (const g of f.guns) f.droneHit(g.rect[0] + 8, g.rect[1] + 8, 3, 0);
window.__step(30);
const d = f.doorRect(); f.droneHit(d[0] + d[2] / 2, d[1] + d[3] / 2, 3, 0);
for (const e of w.enemies) e.alive = false;
const c = f.car;
const n = window.__until(() => Math.hypot(c.x - f.site[0] - 80, c.y - f.site[1] - 80) > 70, 600);
const fx = [0, 1, 0, -1][f.face], fy = [-1, 0, 1, 0][f.face];
const s = w.freeSpotNear(c.x + fx * 50, c.y + fy * 50);
p.x = s[0]; p.y = s[1];
window.__step(20);
({ n, phase: f.phase, car: [Math.round(c.x), Math.round(c.y), c.dir], exit: f.exit, player: [p.x, p.y] });
}`;
const FIN_WIN = `eval:{
const w = window.__app.world, p = w.players[0], f = w.boss, c = f.car;
f.carPart.hp = 1; f.droneHit(c.cx, c.cy, 3, 0);
const n = window.__until(() => f.state === 'dead', 300);
window.__step(70);
({ n, state: f.state, victory: f.victory, fireworks: f.fireworks.length });
}`;
const FIN_WIN2 = `eval:{ window.__step(50); const f = window.__app.world.boss; ({ fireworks: f.fireworks.length, victory: f.victory }); }`;
const B4_HUD = 'eval:{ const b = window.__app.world.boss; ({ name: b.name, title: b.title, parts: b.parts.map((q) => q.short + ":" + q.hp + "/" + q.max), core: b.turret.short }); }';

// ---------- Phase 4: the armoured train and the river flagship (src/game/bosses/), on ?bosstest= test maps ----------
// Same pattern as the GRINDER scenes: towns freed, the boss revealed, director and tricks stopped, the world's own
// update off and stepped by the scene (window.__step), the boss parked for steady shots.
const STEP_FN = `window.__step = (n, inp = {}) => { const i = { dir: -1, fire: false, ...inp }; for (let k = 0; k < n; k++) { const q = w.players[0]; if (q) { q.shield = 0; if (q.armour < 4) q.armour = q.armourMax; } up.call(w, [i, { dir: -1, fire: false }]); } };`;
const BOSS_COMMON = (env) => `const a = window.__app, w = a.world, p = w.players[0], b = w.boss, up = Object.getPrototypeOf(w).update;
const DX = [0, 1, 0, -1], DY = [-1, 0, 1, 0];
a.opts.autoplay = true;
w.env = '${env}';
for (const t of w.towns.slice(0, 3)) w.freeTown(t);
b.reveal();
if (w.ai) w.ai.update = () => {};
if (w.tricks) w.tricks.update = () => {};
w.bullets.length = 0;
p.spawn = 0; p.shield = 0; p.armour = p.armourMax;
${STEP_FN}
w.update = () => {};
// the camera frames the player and the boss part nearest them (window.__focus), a little below the HUD's top plates
a.camTargets = () => { const q = w.players[0]; const f = window.__focus ? window.__focus() : [q.cx, q.cy]; return [{ cx: (q.cx + f[0]) / 2, cy: (q.cy + f[1]) / 2 - 10, dir: 0, moving: false }]; };`;
const TRAIN_SETUP = (env) => `eval:{
${BOSS_COMMON(env)}
const mid = b.units[3];
for (const e of w.enemies) if (Math.hypot(e.cx - mid.cx, e.cy - mid.cy) > 150) e.alive = false;
w.enemies = w.enemies.filter((e) => e.alive);
for (const e of w.enemies) { e.spawn = 0; e.aiFire = 1e9; }
b.state = 'hunt'; b.waitT = 1e9; b.rocketReload = 1e9;
for (const u of b.units) u.reload = 1e9;
const u = b.units[2], side = (u.d + 1) & 3;
const s = w.freeSpotNear(u.cx - 8 + DX[side] * 84, u.cy - 8 + DY[side] * 84) || w.freeSpotNear(u.cx - 8 - DX[side] * 84, u.cy - 8 - DY[side] * 84);
p.x = s[0]; p.y = s[1];
p.dir = Math.abs(u.cx - p.cx) > Math.abs(u.cy - p.cy) ? (u.cx < p.cx ? 3 : 1) : (u.cy < p.cy ? 0 : 2);
window.__focus = () => { let best = b.units[0], bd = 1e9; for (const u of b.units) { const d = Math.hypot(u.cx - p.cx, u.cy - p.cy); if (d < bd) { bd = d; best = u; } } return [best.cx, best.cy]; };
window.__step(70);
w.notes.length = 0;
({ H: Math.round(b.H), len: Math.round(b.poly.len), units: b.units.map((q) => [Math.round(q.cx), Math.round(q.cy), q.d, q.tdir]), player: [p.x, p.y], escort: w.enemies.length });
}`;
// the train parked on the most curved stretch of its line (cars at an angle to the map grid), player beside it
const TRAIN_CURVE = `eval:{ const w = window.__app.world, b = w.boss, p = w.players[0];
const DX = [0, 1, 0, -1], DY = [-1, 0, 1, 0];
let best = b.H, bs = -1;
for (let H = b.hMin; H <= b.hMax; H += 4) {
  let s = 0;
  for (const u of b.units) { const [tx, ty] = b.poly.tangent(H - u.off - u.len / 2); s += Math.min(Math.abs(tx), Math.abs(ty)); }
  const [t0x, t0y] = b.poly.tangent(H - 20), [t1x, t1y] = b.poly.tangent(H - b.length + 20);
  s += 2 * Math.abs(t0x * t1y - t0y * t1x);
  if (s > bs) { bs = s; best = H; }
}
b.H = best; b.place(); b.waitT = 1e9; b.v = 0;
for (const u of b.units) u.tdir = u.d;
const u = b.units[2], side = (u.d + 1) & 3;
const s = w.freeSpotNear(u.cx - 8 + DX[side] * 60, u.cy - 8 + DY[side] * 60) || w.freeSpotNear(u.cx - 8 - DX[side] * 60, u.cy - 8 - DY[side] * 60);
p.x = s[0]; p.y = s[1];
window.__focus = () => [b.units[2].cx, b.units[2].cy];
window.__step(30);
({ H: Math.round(b.H), score: bs.toFixed(2), units: b.units.map((q) => [Math.round(q.cx), Math.round(q.cy), q.d, q.ang === undefined ? null : +q.ang.toFixed(3)]) }); }`;
// the gbuffer's albedo at native resolution (no lighting or upscale) as a PNG data URL: { gbuf } for pixel checks
const GBUF_DUMP = `eval:{ const r = window.__app.r, gl = r.gl, gb = r.gb, W = gb.w, H = gb.h;
gl.bindFramebuffer(gl.READ_FRAMEBUFFER, gb.fbo); gl.readBuffer(gl.COLOR_ATTACHMENT0);
const px = new Uint8Array(W * H * 4); gl.readPixels(0, 0, W, H, gl.RGBA, gl.UNSIGNED_BYTE, px); gl.bindFramebuffer(gl.READ_FRAMEBUFFER, null);
const c = document.createElement('canvas'); c.width = W; c.height = H; const x = c.getContext('2d'), im = x.createImageData(W, H);
for (let y = 0; y < H; y++) for (let i = 0; i < W * 4; i++) im.data[y * W * 4 + i] = (i & 3) === 3 ? 255 : px[y * W * 4 + i];
x.putImageData(im, 0, 0); ({ gbuf: c.toDataURL('image/png') }); }`;
const TRAININFO = 'eval:{ const b = window.__app.world.boss; ({ state: b.state, H: Math.round(b.H), v: b.v, parts: b.parts.map((q) => q.id + ":" + q.hp), marks: b.barrage.list.length, beam: b.beamT }); }';
// a gun car's tell: the player in line beside gun car 1, the turret turns, the barrel glows 40 frames in; then the shell
const TRAIN_TELL = (tag = '') => [
  `eval:{ const w = window.__app.world, b = w.boss, p = w.players[0]; const DX = [0, 1, 0, -1], DY = [-1, 0, 1, 0]; const g = b.units[1], side = (g.d + 1) & 3;
p.x = Math.round(g.cx - 8 + DX[side] * 60); p.y = Math.round(g.cy - 8 + DY[side] * 60); p.dir = (side + 2) & 3;
g.reload = 0; b.gunClock = -1e9; let n = 0; while (g.glow < 40 && n < 300) { window.__step(1); n++; } ({ n, glow: g.glow, tdir: g.tdir }); }`,
  400, TRAININFO, `shot:train-tell${tag}`,
  'eval:{ const b = window.__app.world.boss, g = b.units[1]; let n = 0; while (g.glow >= 0 && n < 90) { window.__step(1); n++; } window.__step(14); g.reload = 1e9; ({ n, shells: window.__app.world.bullets.map((x) => x.dmg) }); }',
  300, `shot:train-shell${tag}`,
];
// a gun car firing at an angle (bosses/aim.ts): the player ~75 px off gun car 1 on a diagonal; the turret slews onto
// them at its real angle, the tell's dotted line along it, then the shell in flight
const TRAIN_DIAG = (tag = '') => [
  `eval:{ const w = window.__app.world, b = w.boss, p = w.players[0], g = b.units[1];
let s = null;
for (const [dx, dy] of [[1, -1], [-1, -1], [1, 1], [-1, 1]]) { s = w.freeSpotNear(g.cx - 8 + dx * 54, g.cy - 8 + dy * 54); if (s && Math.abs(Math.abs(s[0] + 8 - g.cx) - Math.abs(s[1] + 8 - g.cy)) < 12) break; }
p.x = s[0]; p.y = s[1]; p.dir = 0; window.__focus = () => [(g.cx + p.cx) / 2, (g.cy + p.cy) / 2];
g.reload = 0; b.gunClock = -1e9; let n = 0; while (g.glow < 40 && n < 300) { window.__step(1); n++; } ({ n, glow: g.glow, tang: g.tang.toFixed(2), aim: g.aimA.toFixed(2) }); }`,
  400, `shot:traindiag-tell${tag}`,
  'eval:{ const b = window.__app.world.boss, g = b.units[1]; let n = 0; while (g.glow >= 0 && n < 90) { window.__step(1); n++; } window.__step(12); g.reload = 1e9; const s = window.__app.world.bullets.find((x) => x.dmg >= 3); ({ n, shell: s ? [s.ux.toFixed(2), s.uy.toFixed(2)] : null }); }',
  300, `shot:traindiag-shell${tag}`,
];
// the rocket car: three bracket marks round the player, the rockets arcing in, the impacts
const TRAIN_ROCKETS = [
  'eval:{ const b = window.__app.world.boss; b.rocketReload = 0; let n = 0; while (!b.barrage.list.length && n < 90) { window.__step(1); n++; } window.__step(50); ({ n, marks: b.barrage.list.length }); }',
  300, 'shot:train-rockets',
  'eval:{ const b = window.__app.world.boss; window.__step(40); ({ fired: b.barrage.list.map((s) => s.fired) }); }', 300, 'shot:train-rockets-flight',
  'eval:{ const b = window.__app.world.boss; window.__step(36); b.rocketReload = 1e9; ({ left: b.barrage.list.length }); }', 300, 'shot:train-rockets-impact',
];
// a wagon destroyed (gun car 1, two drone hits), burning; then the departure horn (high beam) and the train running on
const TRAIN_CAR = [
  'eval:{ const b = window.__app.world.boss; window.__step(80); const g = b.units[1]; for (let i = 0; i < 2; i++) b.droneHit(g.cx, g.cy, 3, 0); window.__step(4); ({ hp: g.part.hp }); }',
  250, 'shot:train-car-blast',
  'eval:{ window.__step(100); 1; }', 400, 'shot:train-car-burning',
  'eval:{ const b = window.__app.world.boss; b.waitT = 46; window.__step(10); ({ beam: b.beamT, horns: b.stats.horns }); }', 250, 'shot:train-horn',
  'eval:{ const b = window.__app.world.boss; window.__step(200); ({ H: Math.round(b.H), v: b.v }); }', 400, 'shot:train-moving',
];
const TRAIN_DEATH = [
  'eval:{ const b = window.__app.world.boss; b.kill(0); window.__step(60); ({ state: b.state }); }', 250, 'shot:train-dying',
  'eval:{ const b = window.__app.world.boss; let n = 0; while (b.state === "dying" && n < 250) { window.__step(1); n++; } window.__step(6); ({ state: b.state, n }); }', 250, 'shot:train-final',
  'eval:{ window.__step(240); const w = window.__app.world; ({ state: w.boss.state, scrap: w.scrap }); }', 500, 'shot:train-wreck',
];

const FLAG_SETUP = (env) => `eval:{
${BOSS_COMMON(env)}
b.S = Math.round(b.poly.len * 0.45); b.dir = b.wantDir(); b.place();
for (const e of w.enemies) if (Math.hypot(e.cx - b.cx, e.cy - b.cy) > 170) e.alive = false;
w.enemies = w.enemies.filter((e) => e.alive);
for (const e of w.enemies) { e.spawn = 0; e.aiFire = 1e9; }
b.state = 'hunt'; b.mode = 'patrol'; b.reload = 1e9; b.mg.t = 1e9;
window.__sail = Object.getPrototypeOf(b).sail;
b.sail = () => {};
const [tx, ty] = b.poly.tangent(b.S);
let s = null;
for (const sg of [1, -1]) {
  for (let r = 56; r < 140 && !s; r += 4) {
    const x = Math.round((b.cx - ty * sg * r - 8) / 4) * 4, y = Math.round((b.cy + tx * sg * r - 8) / 4) * 4;
    if (!w.map.any(x, y, 16, 16, (c) => c === 1 || c === 2 || c === 3)) s = [x, y];
  }
  if (s) break;
}
p.x = s[0]; p.y = s[1];
p.dir = Math.abs(b.cx - p.cx) > Math.abs(b.cy - p.cy) ? (b.cx < p.cx ? 3 : 1) : (b.cy < p.cy ? 0 : 2);
window.__focus = () => [b.cx, b.cy];
window.__step(40);
w.notes.length = 0;
({ S: Math.round(b.S), len: Math.round(b.poly.len), boat: [Math.round(b.cx), Math.round(b.cy), b.dir], player: [p.x, p.y], escort: w.enemies.length });
}`;
const FLAGINFO = 'eval:{ const b = window.__app.world.boss; ({ state: b.state, mode: b.mode, S: Math.round(b.S), parts: b.parts.map((q) => q.id + ":" + q.hp), marks: b.barrage.list.length, exposed: b.exposed() }); }';
// shelling: it anchors (breeches glow), the warning rings round the player, the rounds in flight, the impacts
const FLAG_SHELL = (tag = '') => [
  'eval:{ const b = window.__app.world.boss; b.sail = window.__sail; b.reload = 0; let n = 0; while (b.mode !== "anchor" && n < 60) { window.__step(1); n++; } window.__step(30); ({ n, mode: b.mode }); }',
  250, `shot:flag-anchor${tag}`,
  'eval:{ const b = window.__app.world.boss; let n = 0; while (b.barrage.list.length < 3 && n < 120) { window.__step(1); n++; } window.__step(30); ({ n, marks: b.barrage.list.length }); }',
  300, FLAGINFO, `shot:flag-shelling${tag}`,
  'eval:{ window.__step(50); const b = window.__app.world.boss; ({ marks: b.barrage.list.length }); }', 300, `shot:flag-shells-flight${tag}`,
  'eval:{ const b = window.__app.world.boss; let n = 0; while (b.barrage.stats.landed < 1 && n < 120) { window.__step(1); n++; } window.__step(3); b.reload = 1e9; ({ n, landed: b.barrage.stats.landed }); }', 300, `shot:flag-shells-impact${tag}`,
];
// a deck gun destroyed (two drone hits), burning, the engine room open; then under way with its wake
const FLAG_PART = (tag = '') => [
  'eval:{ const b = window.__app.world.boss; window.__step(150); b.sail = () => {}; const q = b.parts[0]; const r = b.partRect(q); for (let i = 0; i < 2; i++) b.droneHit(r[0] + r[2] / 2, r[1] + r[3] / 2, 3, 0); window.__step(4); ({ hp: q.hp, exposed: b.exposed() }); }',
  250, `shot:flag-gun-blast${tag}`,
  'eval:{ window.__step(100); 1; }', 400, FLAGINFO, `shot:flag-gun-burning${tag}`,
  'eval:{ const b = window.__app.world.boss; b.sail = window.__sail; b.mode = "patrol"; b.reload = 1e9; window.__step(180); ({ S: Math.round(b.S), v: b.v, mode: b.mode }); }', 400, `shot:flag-wake${tag}`,
];
const FLAG_DEATH = [
  'eval:{ const b = window.__app.world.boss; b.kill(0); window.__step(100); ({ state: b.state, sink: b.sink }); }', 250, 'shot:flag-sinking',
  'eval:{ const b = window.__app.world.boss; let n = 0; while (b.state === "dying" && n < 250) { window.__step(1); n++; } window.__step(6); ({ state: b.state, n }); }', 250, 'shot:flag-sunk',
  'eval:{ window.__step(240); const w = window.__app.world; ({ state: w.boss.state, scrap: w.scrap }); }', 500, 'shot:flag-wreck',
];
// waits (up to 20 s) for the intro card to give way to play
const WAIT_PLAY = 'eval:new Promise((r) => { const t0 = Date.now(); const t = setInterval(() => { if (window.__app?.mode === "play" || Date.now() - t0 > 20000) { clearInterval(t); r(window.__app?.mode); } }, 100); })';
const TRAIN_Q = 'autostart=1&region=1&bosstest=train';
const FLAG_Q = 'autostart=1&region=1&bosstest=flagship';

// ---------- campaign tank looks, pickups and event people (sprite gallery) ----------
// The world stops updating; an open 448 x 224 patch in the middle of the region map holds tanks, pickups and event
// markers put down by hand (gallery px: 0..447 x 0..223). vp 1792 x 896 = a 448 x 224 native screen at exactly 4x,
// so crops enlarge cleanly. Body helpers: mk(x, y, dir, props) a copy of player 1's tank (props: player, fitted,
// vet, etype + isEnemy, dist for the track frame); pk(x, y, kind) a pickup; ev(id, x, y, who?) an event marker (who =
// a made-up event whose first speaker is who, for events this region can't place); ob(kind, x, y, extra) an objective.
const GAL_VP = { width: 1792, height: 896 };
const GAL = (env, body) => `eval:{ const a = window.__app, w = a.world; a.update = () => {}; w.freeze = 0; if (w.ai) w.ai.update = () => {};
  for (const el of document.body.children) if (el.tagName !== 'CANVAS' && el.id !== 'err') el.style.visibility = 'hidden';
  w.env = '${env}'; a.weather.set('clear');
  const gx = Math.round((w.pxW / 2 - 224) / 8) * 8, gy = Math.round((w.pxH / 2 - 112) / 8) * 8;
  w.map.clearRect(gx - 32, gy - 32, 512, 288); w.towns = []; w.depots = []; w.pickups = []; w.boss = null;
  if (w.tricks) { w.tricks.mines = []; w.tricks.teams = []; w.tricks.drones = []; }
  const ev0 = w.events; ev0.placed = []; ev0.objs = [];
  const p = w.players[0]; p.spawn = 0; p.shield = 0; p.hover = false; p.x = gx - 200; p.y = gy - 200; w.players = [p];
  w.enemies = [];
  const mk = (x, y, dir, props = {}) => { const t = Object.assign(Object.create(Object.getPrototypeOf(p)), p, { fitted: {}, vet: 0, armourMax: 0, dist: 0, flash: 0, recoil: 0 }, props, { x: gx + x, y: gy + y, dir });
    if (props.isEnemy) { t.player = -1; t.etype = props.etype ?? 0; t.hp = props.hp ?? 1; }
    w.enemies.push(t); return t; };
  const pk = (x, y, kind) => w.pickups.push({ x: gx + x, y: gy + y, kind, amount: 10, t: 0 });
  const ev = (id, x, y, who, wave) => { let e = who ? null : ev0.debugPlace(id);
    if (!e) e = { def: { id, kind: 'any', where: [], title: '', lines: [[who ?? 'PETRO', '']], choices: wave ? [{ text: '', outs: [{ k: 'recruit' }] }] : [] }, x: 0, y: 0, town: -1, state: 'idle', armed: true, place: '' };
    if (!ev0.placed.includes(e)) ev0.placed.push(e); e.x = gx + x; e.y = gy + y; e.town = -1; e.state = 'idle'; return e; };
  const ob = (o) => { ev0.objs.push(o); return o; };
  ${body}
  a.cam.snap([{ cx: gx + 224, cy: gy + 112, dir: 0, moving: false }]);
  ({ gx, gy, cam: [a.cam.x, a.cam.y], native: [a.r.nw, a.r.nh], k: a.r.k, enemies: w.enemies.length }); }`;
// Player 1's tank (BABUSYA) stock, row by row: 4 directions x 2 track frames; P2 (DIDO) below
const GAL_STOCK = `for (let d = 0; d < 4; d++) { mk(40 + d * 40, 40, d); mk(40 + d * 40, 80, d, { dist: 2 }); mk(240 + d * 40, 40, d, { player: 1 }); mk(240 + d * 40, 80, d, { player: 1, dist: 2 }); }
  const F1 = { armour: 'scrap-plates', engine: 'tractor-diesel', barrel: 'long-100', tracks: 'wide-tracks' };
  const F2 = { armour: 'reactive', engine: 'turbo-diesel', barrel: 'barrel-125', tracks: 'army-tracks', jammer: 'oven-jammer', plough: 'mine-roller' };
  for (let d = 0; d < 4; d++) { mk(40 + d * 40, 130, d, { fitted: F1, vet: 1 }); mk(40 + d * 40, 170, d, { fitted: F2, vet: 3 }); mk(240 + d * 40, 130, d, { player: 1, fitted: F1, vet: 2 }); mk(240 + d * 40, 170, d, { player: 1, fitted: F2, vet: 3 }); }`;
// every part on its own, so each overlay can be judged: armour x4, engine x3, barrel x4, tracks x3, jammer x2, plough x2, vet 0-3
const GAL_PARTS = `const P = [['armour', 'scrap-plates'], ['armour', 'sandbags'], ['armour', 'bed-cage'], ['armour', 'reactive'], ['engine', 'tractor-diesel'], ['engine', 'bus-engine'], ['engine', 'turbo-diesel'],
    ['barrel', 'long-100'], ['barrel', 'sewing-loader'], ['barrel', 'barrel-125'], ['barrel', 'autoloader'], ['tracks', 'wide-tracks'], ['tracks', 'racing-tracks'], ['tracks', 'army-tracks'],
    ['jammer', 'aerial-jammer'], ['jammer', 'oven-jammer'], ['plough', 'farm-harrow'], ['plough', 'mine-roller']];
  P.forEach(([s, id], i) => { mk(24 + (i % 9) * 48, 40 + Math.floor(i / 9) * 48, 0, { fitted: { [s]: id } }); });
  for (let v = 0; v < 4; v++) mk(24 + v * 48, 150, 0, { vet: v });
  for (let v = 0; v < 4; v++) mk(232 + v * 48, 150, 1, { vet: v, player: 1 });`;
// Dominion tanks (campaign enemies): basic, fast, power, armour, 4 directions; a bonus one and an abandoned hull
const GAL_ENEMY = `for (let e = 0; e < 4; e++) for (let d = 0; d < 4; d++) mk(40 + d * 40, 30 + e * 40, d, { isEnemy: true, etype: e, hp: e === 3 ? 4 : 1 });
  for (let e = 0; e < 4; e++) mk(240 + e * 40, 30, 2, { isEnemy: true, etype: e, hp: e === 3 ? 4 : 1, dist: 2 });
  mk(240, 90, 1, { isEnemy: true, etype: 3, hp: 2 }); mk(280, 90, 1, { isEnemy: true, etype: 3, hp: 3 }); mk(320, 90, 1, { isEnemy: true, etype: 0, bonus: true });`;
// pickups and map events: scrap, parts crates, every event person, objective objects
const GAL_ITEMS = `pk(40, 40, 'scrap'); pk(70, 40, 'part'); pk(100, 40, 'scrap'); pk(130, 40, 'part');
  ev('minefield', 40, 110, 'OLHA', true); ev('tractor', 90, 110, 'PETRO'); ev('handcar', 140, 110, 'IVAN'); ev('nets', 190, 110, 'LEV'); ev('cache', 240, 110); ev('wounded', 290, 110, 'DMYTRO', true); ev('cellar', 340, 110, 'MILA'); ev('snowdrift', 390, 110, 'BOHDAN');
  ev('drop', 40, 180); ev('salvage', 90, 180); ev('intercept', 140, 180); ev('bell', 190, 180);
  ob({ ev: ev0.placed[0], kind: 'fetch', then: [], t: 0, fetch: { x: gx + 250, y: gy + 176, look: 'crate', hold: 0, prog: 0, guarded: false } });
  ob({ ev: ev0.placed[0], kind: 'fetch', then: [], t: 0, fetch: { x: gx + 320, y: gy + 176, look: 'generator', hold: 0, prog: 0, guarded: false } });
  ob({ ev: ev0.placed[0], kind: 'fetch', then: [], t: 0, fetch: { x: gx + 390, y: gy + 176, look: 'hull', hold: 0, prog: 0, guarded: false } });`;
// quest objectives: the marked minefield (socks on sticks), the tractor and the handcar being escorted, a pickup pile
const GAL_QUEST = `const e0 = ev('minefield', 30, 30, 'OLHA', true); e0.state = 'done';
  ob({ ev: e0, kind: 'mines', then: [], t: 0, mines: [[60, 60], [84, 52], [100, 74], [72, 90], [118, 96]].map(([x, y]) => ({ x: gx + x, y: gy + y, alive: true })) });
  const esc = (veh, x, y, dir) => { const e = ev(veh === 'TRACTOR' ? 'tractor' : 'handcar', 0, 0, 'PETRO'); e.state = 'done'; e.def.vehicle = veh;
    ob({ ev: e, kind: 'escort', then: [], t: 0, escort: { pts: [[gx + x, gy + y], [gx + x + 120, gy + y]], cum: [0, 120], len: 120, s: 0, hp: 3, x: gx + x, y: gy + y, dir, drone: false, patrol: false, anim: 0 } }); };
  esc('TRACTOR', 200, 70, 1); esc('HANDCAR', 200, 150, 1);
  mk(160, 100, 1, { fitted: { plough: 'farm-harrow' } });
  pk(340, 60, 'scrap'); pk(356, 66, 'scrap'); pk(372, 58, 'part'); pk(350, 150, 'part');`;
const GAL_SHOTS = (name, body) => ({
  q: 'autostart=1&region=1&crew=all', vp: GAL_VP,
  steps: [WAIT_MODE('play'), 1200, GAL('day', body), 900, `shot:${name}-day`, ENV('night'), 900, `shot:${name}-night`, ENV('dusk'), 700, `shot:${name}-dusk`, ENV('snow'), 700, `shot:${name}-snow`],
});

const SCENES = {
  galstock: GAL_SHOTS('gal-stock', GAL_STOCK),
  galparts: GAL_SHOTS('gal-parts', GAL_PARTS),
  galenemy: GAL_SHOTS('gal-enemy', GAL_ENEMY),
  galitems: GAL_SHOTS('gal-items', GAL_ITEMS),
  galquest: GAL_SHOTS('gal-quest', GAL_QUEST),
  bosstestquick: { q: 'bosstest=heli', vp: { width: 1600, height: 900 }, steps: [7000, 'eval:({ mode: window.__app.mode, boss: window.__app.world?.boss?.state })', 'shot:bosstest-quick'] },
  // Phase 4: the armoured train (?bosstest=train): by day, at dusk (region 2's look), at night in the rain
  traindusk: { q: TRAIN_Q, vp: { width: 1920, height: 1080 }, steps: [3000, WAIT_PLAY, 600, TRAIN_SETUP('dusk'), 800, 'shot:train-dusk'] },
  trainday: { q: TRAIN_Q, vp: { width: 1920, height: 1080 }, steps: [3000, WAIT_PLAY, 600, TRAIN_SETUP('day'), 800, TRAININFO, 'shot:train-day', ...TRAIN_TELL(), ...TRAIN_ROCKETS, ...TRAIN_CAR, ...TRAIN_DEATH] },
  trainnight: { q: TRAIN_Q, vp: { width: 1920, height: 1080 }, steps: [3000, WAIT_PLAY, 600, TRAIN_SETUP('night'), 800, 'shot:train-night', ...TRAIN_TELL('-night'), ...TRAIN_CAR.slice(0, 6)] },
  // Phase 4: the river flagship (?bosstest=flagship): by day, and at night in the rain (region 3's look)
  flagday: { q: FLAG_Q, vp: { width: 1920, height: 1080 }, steps: [3000, WAIT_PLAY, 600, FLAG_SETUP('day'), 800, FLAGINFO, 'shot:flag-day', ...FLAG_SHELL(), ...FLAG_PART(), ...FLAG_DEATH] },
  // the same bosses on the real generated regions: Rail Junction (stage 2, dusk) and River Delta (stage 3, rain)
  // the train on the most curved stretch of the real Rail Junction line: cars follow the track's angle
  traincurve: { q: 'autostart=1&region=1&stage=2', vp: { width: 1920, height: 1080 }, steps: [3000, WAIT_PLAY, 600, TRAIN_SETUP('dusk'), 300, TRAIN_CURVE, 800, 'shot:train-curve-dusk', ENV('day'), 600, 'shot:train-curve-day', 'eval:{ const b = window.__app.world.boss; b.waitT = 0; window.__step(150); ({ H: Math.round(b.H), v: b.v }); }', 500, 'shot:train-curve-moving', 'eval:{ const b = window.__app.world.boss, g = b.units[1]; for (let i = 0; i < 2; i++) b.droneHit(g.cx, g.cy, 3, 0); window.__step(100); 1; }', 500, 'shot:train-curve-wreck'] },
  // the test map's square dog-leg (?bosstest=train): wagons pivot round the corner
  traindiag: { q: 'autostart=1&region=1&stage=2', vp: { width: 1920, height: 1080 }, steps: [3000, WAIT_PLAY, 600, TRAIN_SETUP('day'), 300, TRAIN_CURVE, 600, ...TRAIN_DIAG(), ENV('night'), 'eval:{ const b = window.__app.world.boss; b.units[1].reload = 0; b.gunClock = -1e9; 1; }', ...TRAIN_DIAG('-night')] },
  traincorner: { q: TRAIN_Q, vp: { width: 1920, height: 1080 }, steps: [3000, WAIT_PLAY, 600, TRAIN_SETUP('day'), 300, TRAIN_CURVE, 800, 'shot:train-corner-day', ENV('night'), 600, 'shot:train-corner-night'] },
  // the same, the gbuffer albedo at native resolution (pixel detail of the turned wagons; save with the value)
  traincurvegb: { q: 'autostart=1&region=1&stage=2', vp: { width: 1920, height: 1080 }, steps: [3000, WAIT_PLAY, 600, TRAIN_SETUP('day'), 300, TRAIN_CURVE, 800, GBUF_DUMP] },
  trainreal: { q: 'autostart=1&region=1&stage=2', vp: { width: 1920, height: 1080 }, steps: [3000, WAIT_PLAY, 600, TRAIN_SETUP('dusk'), 800, TRAININFO, 'shot:train-real-dusk', ...TRAIN_TELL('-real'), ...TRAIN_ROCKETS.map((s) => (typeof s === 'string' && s.startsWith('shot:') ? `${s}-real` : s))] },
  flagreal: { q: 'autostart=1&region=1&stage=3', vp: { width: 1920, height: 1080 }, steps: [3000, WAIT_PLAY, 600, FLAG_SETUP('rain'), 800, FLAGINFO, 'shot:flag-real-rain', ...FLAG_SHELL('-real'), ...FLAG_PART('-real')] },
  flagnight: { q: FLAG_Q, vp: { width: 1920, height: 1080 }, steps: [3000, WAIT_PLAY, 600, FLAG_SETUP('night'), 800, 'shot:flag-night', ...FLAG_SHELL('-night'), ...FLAG_PART('-night')] },
  // Phase 4 regions: the rail track close up (dusk = the region's own look, then day), the yard, a curve and a level
  // crossing; the delta's channels in the rain; the ruined town at night; the winter front
  rail: {
    q: 'autostart=1&region=1&stage=2', vp: { width: 1920, height: 1080 },
    steps: [8500, REGIONINFO, TP(RAILYARD), 2500, 'shot:rail-yard-dusk', TP(RAILPT(0.12)), 2000, 'shot:rail-curve-dusk', TP(XING), 2000, 'shot:rail-xing-dusk',
      ENV('day'), TP(RAILYARD), 2500, 'shot:rail-yard-day', TP(RAILPT(0.12)), 2000, 'shot:rail-curve-day', TP(XING), 2000, 'shot:rail-xing-day',
      ENV('night'), TP(RAILYARD), 2500, 'shot:rail-yard-night', ENV('snow'), 2500, 'shot:rail-yard-snow'],
  },
  // Rails round: smooth track. HUD hidden; the steepest curve, both ends of the yard (turnouts), the yard and a
  // level crossing by day, then the curve and a turnout at dusk, at night and in snow
  rails: {
    q: 'autostart=1&region=1&stage=2', vp: { width: 1920, height: 1080 },
    steps: [WAIT_MODE('play'), 2500, STRUCT_HUD, ENV('day'), TP(RAILSTEEP), 2500, 'shot:rails-curve-day', TP(RAILSWITCH(0)), 2000, 'shot:rails-turnout-a-day',
      TP(RAILSWITCH(1)), 2000, 'shot:rails-turnout-b-day', TP(RAILYARD), 2000, 'shot:rails-yard-day', TP(XING), 2000, 'shot:rails-xing-day',
      ENV('dusk'), TP(RAILSTEEP), 2500, 'shot:rails-curve-dusk', TP(RAILSWITCH(0)), 2000, 'shot:rails-turnout-a-dusk',
      ENV('night'), 2500, 'shot:rails-turnout-a-night', TP(XING), 2000, 'shot:rails-xing-night',
      ENV('snow'), 2500, 'shot:rails-xing-snow', TP(RAILSWITCH(0)), 2000, 'shot:rails-turnout-a-snow', TP(RAILSTEEP), 2000, 'shot:rails-curve-snow'],
  },
  // the boss test map's dog-leg (?bosstest=train): the rounded corner with the train away, then the train on it
  railcorner: { q: TRAIN_Q, vp: { width: 1920, height: 1080 }, steps: [3000, WAIT_PLAY, 600, TRAIN_SETUP('day'), 300, STRUCT_HUD, TRAIN_CURVE, 800, 'shot:rails-corner-train', TRAIN_AWAY, 800, 'shot:rails-corner-day'] },
  // the same on other map seeds (a north-south line among them)
  rails2: { q: 'autostart=1&region=2&stage=2', vp: { width: 1920, height: 1080 }, steps: [WAIT_MODE('play'), 2500, STRUCT_HUD, ENV('day'), TP(RAILSTEEP), 2500, 'shot:rails2-curve-day', TP(RAILSWITCH(0)), 2000, 'shot:rails2-turnout-a-day', TP(RAILSWITCH(1)), 2000, 'shot:rails2-turnout-b-day'] },
  rails3: { q: 'autostart=1&region=3&stage=2', vp: { width: 1920, height: 1080 }, steps: [WAIT_MODE('play'), 2500, STRUCT_HUD, ENV('day'), TP(RAILSTEEP), 2500, 'shot:rails3-curve-day', TP(RAILSWITCH(0)), 2000, 'shot:rails3-turnout-a-day', TP(RAILSWITCH(1)), 2000, 'shot:rails3-turnout-b-day'] },
  // the player's headlight on a straight road beside trees, facing left (Rail Junction on map seed 7): dusk (the
  // region's own look), night, day; then dusk with fog off (surface light only)
  headlight: {
    q: 'autostart=1&region=7&stage=2', vp: { width: 1920, height: 1080 },
    steps: [WAIT_MODE('play'), 2500, TP(ROADSPOT), HEADLEFT, 2500, 'shot:headlight-dusk', ENV('night'), 1500, 'shot:headlight-night',
      ENV('day'), 1500, 'shot:headlight-day', ENV('dusk'), 1200, FOGK(0), 300, 'shot:headlight-dusk-nofog', FOGK(1), 300,
      // the 125 mm gun's muzzle brake sits right over the lamp
      "eval:{ const p = window.__app.world.players[0]; p.fitted = { barrel: 'barrel-125', armour: 'sandbags' }; 1; }", 600, 'shot:headlight-125-dusk',
      ENV('night'), 1500, 'shot:headlight-125-night'],
  },
  // arcade night (stage 3): the player's headlight up from its spawn, and to the right, enemies frozen
  headlightarcade: {
    q: 'autostart=1&stage=3', vp: { width: 1920, height: 1080 },
    steps: [WAIT_PLAY, 2500, `eval:{ const a = window.__app, w = a.world, m = w.map; a.weather.auto = false; a.weather.flash = 0; w.freeze = 1e6;
      const p = w.players[0]; let s = [p.x, p.y];
      // the open spot nearest the field's lower middle with 48 px clear ahead (up)
      let bd = 1e9; for (let y = 64; y <= 176; y += 8) for (let x = 16; x <= 176; x += 8) {
        let ok = true; for (let k = 0; k <= 48 && ok; k += 8) if (m.solidForTank(x, y - k, false)) ok = false;
        const dd = Math.hypot(x - 96, y - 150); if (ok && dd < bd) { bd = dd; s = [x, y]; } }
      p.x = s[0]; p.y = s[1]; p.dir = 0; p.shield = 0; s; }`, 1200, 'shot:headlight-arcade-up',
      "eval:{ const p = window.__app.world.players[0]; p.dir = 1; 1; }", 800, 'shot:headlight-arcade-right'],
  },
  railforest: {
    q: 'autostart=1&region=2&stage=2', vp: { width: 1920, height: 1080 },
    steps: [8500, REGIONINFO, TP(TOWNN(1)), 2500, 'shot:rail-town-dusk', TP(RAILPT(0.85)), 2500, 'shot:rail-forest-dusk'],
  },
  delta: {
    q: 'autostart=1&region=1&stage=3', vp: { width: 1920, height: 1080 },
    steps: [8500, REGIONINFO, TP(RIVERPT(0.3)), 2500, 'shot:delta-river-rain', TP(BRIDGEN(0)), 2500, 'shot:delta-bridge-rain', TP(TOWNN(0)), 2500, 'shot:delta-town-rain',
      TP(RIVERPT(0.7)), 2500, 'shot:delta-river2-rain', ENV('day'), 2500, 'shot:delta-river2-day'],
  },
  ruins: {
    q: 'autostart=1&region=1&stage=4', vp: { width: 1920, height: 1080 },
    steps: [8500, REGIONINFO, TP(TOWNN(0)), 3000, 'shot:ruins-district-night', TP(LAIR), 3000, 'shot:ruins-square-night', TP(BRIDGEN(0)), 3000, 'shot:ruins-canal-night',
      ENV('day'), TP(TOWNN(1)), 2500, 'shot:ruins-district-day', TP(LAIR), 2500, 'shot:ruins-square-day'],
  },
  // the ruins' fires and streetlamps (src/game/ambient.ts) at night, and how many are on screen
  ruinsfire: {
    q: 'autostart=1&region=1&stage=4', vp: { width: 1920, height: 1080 },
    steps: [8500, AMBINFO, TP(TOWNN(0)), 3000, 'shot:ruins-fire-district', AMBVIEW, TP(TOWNN(1)), 3000, 'shot:ruins-fire-district2', AMBVIEW,
      TP(LAIR), 3000, 'shot:ruins-fire-square', AMBVIEW, TP(BRIDGEN(0)), 3000, 'shot:ruins-fire-canal', AMBVIEW, TP(BRIDGEN(1)), 3000, 'shot:ruins-fire-canal2'],
  },
  // winter trees close up (snow caps), the frozen river and the trenches
  wintertrees: {
    q: 'autostart=1&region=1&stage=5', vp: { width: 1920, height: 1080 },
    steps: [8500, TP(TREESPOT(0)), 3000, 'shot:winter-trees', TP(TREESPOT(2)), 3000, 'shot:winter-trees2', ENV('day'), 2500, 'shot:winter-trees2-dayenv'],
  },
  winter: {
    q: 'autostart=1&region=1&stage=5', vp: { width: 1920, height: 1080 },
    steps: [8500, REGIONINFO, TP(TOWNN(0)), 3000, 'shot:winter-village-snow', TP(LAIR), 3000, 'shot:winter-lair-snow', TP(BRIDGEN(0)), 3000, 'shot:winter-river-snow',
      TP('[w.region.exits[0][0], w.region.exits[0][1]]'), 2500, 'shot:winter-road-snow'],
  },
  // Phase 4 regions 4-5: the helicopter at night (searchlight, rain, height via the shadow), its strafing tell, the
  // rocket marks, a pod shot off, the spiral and crash; the final fight's three stages in snow and the victory
  heli: {
    q: 'autostart=1&bosstest=heli', vp: { width: 1920, height: 1080 },
    steps: [6500, B4_SETUP(), 300, HELI_POSE, 900, B4_HUD, 'shot:heli-night', HELI_LOW, 600, 'shot:heli-low', HELI_FREE, HELI_STRAFE, 700, 'shot:heli-strafe-tell',
      HELI_RUN, 500, 'shot:heli-strafe-run', HELI_SALVO, 600, 'shot:heli-salvo-marks', HELI_ROCKETS, 300, 'shot:heli-rockets', HELI_POD, 400, 'shot:heli-pod-blast',
      HELI_POD_AFTER, 500, B4_HUD, 'shot:heli-pod-down', HELI_DIE, 500, 'shot:heli-spiral', HELI_CRASH, 400, 'shot:heli-crash', HELI_WRECK, 600, 'shot:heli-wreck'],
  },
  // VULTURE's flares against FPV drones: decoyed high up (the burst, the swerve, the pop), the one hit down low, then
  // the second drone of the same pass decoyed; by night (the real fight) and by day
  heliflares: {
    q: 'autostart=1&bosstest=heli', vp: { width: 1920, height: 1080 },
    steps: [6500, B4_SETUP(), WAIT_PLAY, 300, HELI_POSE, 600, DRONE_FN, FLARE_HIGH, 300, 'shot:heli-flares-decoy', FLARE_POP, 300, 'shot:heli-flares-decoyed',
      FLARE_LOW, 300, 'shot:heli-flares-low-hit', FLARE_SECOND, 300, 'shot:heli-flares-second', FLARE_POP, 300, 'shot:heli-flares-second-pop'],
  },
  heliflaresday: {
    q: 'autostart=1&bosstest=heli', vp: { width: 1920, height: 1080 },
    steps: [6500, B4_SETUP(), WAIT_PLAY, "eval:window.__app.world.env = 'day'", 300, HELI_POSE, 600, DRONE_FN, FLARE_HIGH, 300, 'shot:heli-flares-day-decoy', FLARE_POP, 300, 'shot:heli-flares-day-decoyed',
      FLARE_LOW, 300, 'shot:heli-flares-day-low-hit'],
  },
  // GRINDER's smoke dischargers: a drone hits, the smoke goes up, the next drone loses it and comes down beside the hull
  grindersmoke: {
    q: 'autostart=1&region=1', vp: { width: 1920, height: 1080 },
    steps: [6500, WAIT_PLAY, 500, BOSS_SETUP('day'), 800, DRONE_FN, SMOKE_HIT, 400, 'shot:grinder-smoke-pop', SMOKE_LOST, 300, 'shot:grinder-smoke-lost-flight', SMOKE_POP, 300, 'shot:grinder-smoke-lost'],
  },
  heliday: { q: 'autostart=1&bosstest=heli', vp: { width: 1920, height: 1080 }, steps: [6500, B4_SETUP(), "eval:window.__app.world.env = 'day'", 300, HELI_POSE, 900, 'shot:heli-day', HELI_LOW, 600, 'shot:heli-day-low'] },
  // readability: the strafing line (lit and dim blink) and the rocket marks at night in the storm, with shell blasts,
  // smoke and the searchlight on top of them; the heli's weak-point ticks and its engine's lock show too
  helistorm: {
    q: 'autostart=1&bosstest=heli', vp: { width: 1920, height: 1080 },
    steps: [6500, B4_SETUP(), 300, HELI_POSE, 600, HELI_LOW, WAIT_PLAY, 300, HELI_FREE, STORM_FN, HELI_STRAFE, STORM(), 500, 'shot:helistorm-strafe-lit',
      'eval:{ window.__step(8); window.__app.world.boss.modeT; }', 400, 'shot:helistorm-strafe-dim', HELI_RUN, STORM(), 500, 'shot:helistorm-strafe-run',
      HELI_SALVO, STORM(), 500, 'shot:helistorm-marks', 'eval:{ window.__step(30); window.__app.world.boss.mode; }', STORM(), 500, 'shot:helistorm-marks-late'],
  },
  // weak-point markers: corner ticks on parts that can be hurt now, a lock on the locked core, none on wrecked parts
  weakgrinder: {
    q: 'autostart=1&region=1', vp: { width: 1920, height: 1080 },
    steps: [6500, BOSS_SETUP('night'), 800, 'shot:weak-grinder-night', ENV('day'), 300, 'shot:weak-grinder-day',
      ...BOSS_WEAK.map((s) => (s === 'shot:boss-weak-blast' ? 'shot:weak-grinder-hit' : s === 'shot:boss-weak-after' ? 'shot:weak-grinder-open' : s))],
  },
  weaktrain: { q: TRAIN_Q, vp: { width: 1920, height: 1080 }, steps: [3000, WAIT_PLAY, 600, TRAIN_SETUP('night'), 800, 'shot:weak-train-night', ENV('day'), 300, 'shot:weak-train-day'] },
  weakflag: { q: FLAG_Q, vp: { width: 1920, height: 1080 }, steps: [3000, WAIT_PLAY, 600, FLAG_SETUP('rain'), 800, 'shot:weak-flag-rain'] },
  weakfinal: {
    q: 'autostart=1&bosstest=final', vp: { width: 1920, height: 1080 },
    steps: [6500, B4_SETUP(true), 300, FIN_POSE, 900, 'shot:weak-final-p1', FIN_P2, 600, 'shot:weak-final-p2',
      'eval:{ const f = window.__app.world.boss; for (const g of f.guns) f.droneHit(g.rect[0] + 8, g.rect[1] + 8, 3, 0); window.__step(30); ({ open: f.exposed() }); }', 500, 'shot:weak-final-p2-open',
      FIN_P3, 600, 'shot:weak-final-p3'],
  },
  final: {
    q: 'autostart=1&bosstest=final', vp: { width: 1920, height: 1080 },
    steps: [6500, B4_SETUP(true), 300, FIN_POSE, 900, B4_HUD, 'shot:final-p1', FIN_P2, 600, B4_HUD, 'shot:final-p2-guns', FIN_BARRAGE, 600, 'shot:final-p2-barrage',
      FIN_P3, 600, B4_HUD, 'shot:final-p3-car', FIN_WIN, 500, 'shot:final-victory', FIN_WIN2, 400, 'shot:final-victory2'],
  },
  // Phase 4: the Region 1 boss by day (with escort, HUD bar), its main-gun tell, weak points, death; and at night
  bossday: { q: 'autostart=1&region=1', vp: { width: 1920, height: 1080 }, steps: [6500, BOSS_SETUP('day'), 800, BOSSINFO, 'shot:boss-day', ...BOSS_TELL, ...BOSS_WEAK, ...BOSS_DEATH] },
  bossdiag: { q: 'autostart=1&region=1', vp: { width: 1920, height: 1080 }, steps: [9000, BOSS_SETUP('day'), 800, ...BOSS_DIAG('')] },
  bossdiagnight: { q: 'autostart=1&region=1', vp: { width: 1920, height: 1080 }, steps: [6500, BOSS_SETUP('night'), 800, ...BOSS_DIAG('-night')] },
  bossnight: { q: 'autostart=1&region=1', vp: { width: 1920, height: 1080 }, steps: [6500, BOSS_SETUP('night'), 800, 'shot:boss-night', ...BOSS_TELL.map((s) => (s === 'shot:boss-tell' ? 'shot:boss-tell-night' : s === 'shot:boss-shell' ? 'shot:boss-shell-night' : s))] },
  // the boss line before the reveal (locked), then BOSS LOCATED with the map marker (TAB map open)
  bossreveal: {
    q: 'autostart=1&region=1', vp: { width: 1920, height: 1080 },
    steps: [6500, 'eval:{ const w = window.__app.world; window.__app.opts.autoplay = true; w.freeTown(w.towns[0]); 1; }', 600, 'shot:boss-locked',
      'eval:{ const w = window.__app.world; w.freeTown(w.towns[1]); w.freeTown(w.towns[2]); 1; }', 1200, 'key:Tab', 600, 'shot:boss-located-map'],
  },
  // Phase 3 crew abilities: drone reticle, lock, flight and dive; ambush squad hidden and firing; recon drone marks
  abilday: { q: 'autostart=1&region=1', vp: { width: 1920, height: 1080 }, steps: abilSteps('day', 'day', 2) },
  abilnight: { q: 'autostart=1&region=1', vp: { width: 1920, height: 1080 }, steps: abilSteps('night', 'night', 3) },
  // the real keyboard path with ?abil=1: hold 1 and steer with an arrow key, release (launch), tap 2 and 3
  abilkeys: {
    q: 'autostart=1&region=1&abil=1', vp: { width: 1280, height: 720 },
    steps: [8000, `eval:{ const w = window.__app.world, p = w.players[0]; if (w.ai) w.ai.update = () => {}; w.updateEnemy = () => {}; ${ABIL_SPOT}
      window.__k = (t, c) => window.dispatchEvent(new KeyboardEvent(t, { code: c })); window.__k('keydown', 'Digit1'); ({ charges: [...w.charges], spawn: p.spawn, frame: w.frame }); }`,
      300, "eval:window.__k('keydown', 'ArrowRight')", 300, "eval:window.__k('keyup', 'ArrowRight')", 100,
      'eval:{ const w = window.__app.world, a = w.abil.aims[0], p = w.players[0]; ({ aim: a && [Math.round(a.x - p.cx), Math.round(a.y - p.cy)], tank: [p.x, p.y] }); }', 'shot:abil-keys-aim',
      "eval:window.__k('keyup', 'Digit1')", 1200, "eval:{ window.__k('keydown', 'Digit3'); window.__k('keyup', 'Digit3'); }", 200, "eval:{ window.__k('keydown', 'Digit2'); window.__k('keyup', 'Digit2'); }", 600,
      'eval:{ const w = window.__app.world; ({ charges: [...w.charges], stats: w.abil.stats, recon: w.frame < w.abil.reconUntil, squads: w.abil.squads.length }); }', 'shot:abil-keys-after'],
  },
  // field patch cooldown (15 s per player): the PATCH slot's dark wipe and seconds left, solo then co-op (P2 still ready)
  patchcd: { q: 'autostart=1&region=1', vp: { width: 1280, height: 720 }, steps: PATCH_CD('patch-cd') },
  patchcd2p: { q: 'autostart=1&players=2&region=1', vp: { width: 1280, height: 720 }, steps: PATCH_CD('patch-cd-2p') },
  // Phase 3 enemy tricks, by day and at night (region 1, 1080p)
  trkdrone: { q: 'autostart=1&region=1', vp: { width: 1920, height: 1080 }, steps: trkDrone('day') },
  trkdroneedge: { q: 'autostart=1&region=1', vp: { width: 1920, height: 1080 }, steps: trkDroneEdge('day') },
  trkdroneedgenight: { q: 'autostart=1&region=1', vp: { width: 1920, height: 1080 }, steps: trkDroneEdge('night') },
  trkdronenight: { q: 'autostart=1&region=1', vp: { width: 1920, height: 1080 }, steps: trkDrone('night') },
  trkteam: { q: 'autostart=1&region=1', vp: { width: 1920, height: 1080 }, steps: trkTeam('day') },
  trkteamnight: { q: 'autostart=1&region=1', vp: { width: 1920, height: 1080 }, steps: trkTeam('night') },
  trkmine: { q: 'autostart=1&region=1', vp: { width: 1920, height: 1080 }, steps: trkMine('day') },
  trkminenight: { q: 'autostart=1&region=1', vp: { width: 1920, height: 1080 }, steps: trkMine('night') },
  trkart: { q: 'autostart=1&region=1', vp: { width: 1920, height: 1080 }, steps: trkArt('day') },
  trkartnight: { q: 'autostart=1&region=1', vp: { width: 1920, height: 1080 }, steps: trkArt('night') },
  trkconvoy: { q: 'autostart=1&region=1', vp: { width: 1920, height: 1080 }, steps: trkConvoy('day') },
  trkconvoynight: { q: 'autostart=1&region=1', vp: { width: 1920, height: 1080 }, steps: trkConvoy('night') },
  // CAMPAIGN submenu: no save (NEW CAMPAIGN, CREW, BACK), then with a save (CONTINUE + its notes), the overwrite
  // confirm, and CONTINUE starting the saved region with the retreat bonus
  campmenu: {
    q: '', vp: { width: 1600, height: 900 },
    steps: [1500, 'key:Enter', 600, 'key:ArrowDown', 150, 'key:ArrowDown', 150, 'key:Enter', 700, 'shot:campmenu-nosave', 'key:Escape', 300,
      SAVE_RUN, 'key:Enter', 700, 'shot:campmenu-save', 'key:ArrowDown', 150, 'key:Enter', 400, 'shot:campmenu-confirm', 'key:ArrowUp',
      150, 'key:Enter', 1500, 'shot:campmenu-continue', RUNINFO, SAVED],
  },
  // depot target: damaged (smoking), burning, the blast and shockwave, then the burning wreck
  depot: {
    q: 'autostart=1&region=1', vp: { width: 1920, height: 1080 },
    steps: [6500, AT_DEPOT, 800, HIT_DEPOT(2), 1800, 'shot:depot-damaged', HIT_DEPOT(2), 1800, 'shot:depot-burning',
      HIT_DEPOT(2), 90, 'shot:depot-blast', 250, 'shot:depot-shock', 2500, 'shot:depot-after', 5000, 'shot:depot-wreck'],
  },
  depotnight: {
    q: 'autostart=1&region=1', vp: { width: 1920, height: 1080 },
    steps: [6500, "eval:window.__app.world.env = 'night'", AT_DEPOT, 800, HIT_DEPOT(5), 1800, 'shot:depot-night-burning', HIT_DEPOT(1), 2500, 'shot:depot-night-after'],
  },
  // workshop prompt at a freed flag, Enter opens the camp, Escape closes it (crew=all: no recruit card in between)
  workshop: {
    q: 'autostart=1&region=1&crew=all', vp: { width: 1920, height: 1080 },
    steps: [6500, AT_FLAG, 1500, 'shot:workshop-prompt', 'key:Enter', 700, 'shot:workshop-camp', RUNINFO, 'key:Escape', 600, 'shot:workshop-closed', RUNINFO],
  },
  // out of lives in campaign: the RETREAT screen, then the same region again with the bonus
  retreat: {
    q: 'autostart=1&region=1', vp: { width: 1920, height: 1080 },
    steps: [6500, KNOCKOUT, 6500, 'shot:retreat', RUNINFO, 'key:Enter', 1500, 'shot:retreat-intro', RUNINFO],
  },
  // all towns freed and the boss down (Phase 4: a boss region clears when it falls): the region-clear tally, the camp between regions, the next region's intro (crew=all: no recruit)
  regionclear: {
    q: 'autostart=1&region=1&crew=all', vp: { width: 1920, height: 1080 },
    steps: [6500, FREE_ALL, BOSS_DOWN, WAIT_MODE('regionclear'), 4500, 'shot:region-clear', RUNINFO, 'key:Enter', 700, 'shot:region-clear-camp', 'key:Escape', 1500, 'shot:region-next-intro', RUNINFO],
  },
  // live campaign, nothing staged: the autopilot plays region 1 with the real rules and HUD
  livecamp: { q: `${play}&region=1`, vp: { width: 1920, height: 1080 }, steps: [15000, 'shot:live-a', 20000, 'shot:live-b', 25000, 'shot:live-c'] },
  reloadbar: { q: 'autostart=1&region=1', vp: { width: 1920, height: 1080 }, steps: [12000, 'eval:{ const w = window.__app.world; w.freeze = 1e6; w.fire(w.players[0]); }', 250, 'shot:reload-bar'] },
  campday: { q: `${play}&region=1`, vp: { width: 1920, height: 1080 }, steps: [9000, camp(7, 2, 'day'), 600, NATIVE, 'shot:camp-day'] },
  campnight: { q: `${play}&region=1`, vp: { width: 1920, height: 1080 }, steps: [9000, camp(7, 2, 'night'), 600, NATIVE, 'shot:camp-night'] },
  camplow: { q: `${play}&region=1`, vp: { width: 1920, height: 1080 }, steps: [9000, camp(5, 0, 'day'), 150, 'shot:camp-low'] },
  // Phase 5 story: a new campaign's opening and region I briefing (ASK FIRST), the intro card with HQ's quote
  storyopen: {
    q: '', vp: { width: 1920, height: 1080 },
    steps: [NO_SAVE, ...TO_CAMPMENU, 'key:Enter', 3200, 'shot:story-opening-1', ...NEXT(3, 2200), 'shot:story-opening-1b', 'key:Enter', 3200, 'shot:story-opening-2',
      ...NEXT(3, 2600), 'key:Enter', 3200, ...NEXT(2, 3400), 'shot:story-briefing-1', 'key:Digit3', 3200, 'shot:story-briefing-1-hint', STORYINFO, 'key:Enter', 2600,
      'shot:story-intro-1', STORYINFO],
  },
  // the region II (RAIL JUNCTION) briefing as in the approved mockup, then line 4, then an answer and the intro card
  storyrail: {
    q: '', vp: { width: 1920, height: 1080 },
    steps: [...RAIL_BRIEF, 'shot:story-briefing-rail', 'key:Enter', 3000, 'shot:story-briefing-rail-4', STORYINFO, 'key:Digit2', 2600, 'shot:story-briefing-rail-intro', STORYINFO],
  },
  storyrail720: { q: '', vp: { width: 1280, height: 720 }, steps: [...RAIL_BRIEF, 'shot:story-briefing-rail-720', 'key:Enter', 3000, 'shot:story-briefing-rail-720-4'] },
  storyrailtall: { q: '', vp: { width: 1080, height: 1920 }, steps: [...RAIL_BRIEF, 'shot:story-briefing-rail-tall', 'key:Enter', 3000, 'shot:story-briefing-rail-tall-4'] },
  // the other briefings' backdrops: region III (told in the rail forest), IV (the delta in the rain), V (the ruins at night)
  storybg3: { q: '', vp: { width: 1920, height: 1080 }, steps: [NO_SAVE, STORY_SAVE(2), ...TO_CAMPMENU, 'key:Enter', 3200, ...NEXT(3, 3000), 'shot:story-briefing-3'] },
  storybg4: { q: '', vp: { width: 1920, height: 1080 }, steps: [NO_SAVE, STORY_SAVE(3), ...TO_CAMPMENU, 'key:Enter', 3200, ...NEXT(3, 3000), 'shot:story-briefing-4'] },
  storybg5: { q: '', vp: { width: 1920, height: 1080 }, steps: [NO_SAVE, STORY_SAVE(4), ...TO_CAMPMENU, 'key:Enter', 3200, ...NEXT(3, 3000), 'shot:story-briefing-5'] },
  // a boss down: the region-clear card with HQ's debrief, then the camp between regions on the MAP tab (the next region)
  storydebrief: {
    q: 'autostart=1&region=1&crew=all', vp: { width: 1920, height: 1080 },
    steps: [6500, BOSS_DOWN, WAIT_MODE('regionclear'), 4500, 'shot:story-debrief', RUNINFO, 'key:Enter', 900, 'key:KeyE', 300, 'key:KeyE', 900, 'shot:story-camp-map-ahead'],
  },
  // the final boss down: the ending's three pages, THE END card, back to the title
  storyending: {
    q: 'autostart=1&bosstest=final&crew=all', vp: { width: 1920, height: 1080 },
    steps: [6500, BOSS_DOWN, WAIT_MODE('story'), 3500, STORYINFO, 'shot:story-ending-1', ...NEXT(2, 2600), 'shot:story-ending-1c', 'key:Enter', 3500, ...NEXT(2, 2600),
      'shot:story-ending-2', 'key:Enter', 3500, ...NEXT(2, 3600), 'shot:story-ending-3', 'key:Enter', 3500, 'shot:story-complete', 'key:Enter', 1500, 'shot:story-after-title', STORYINFO],
  },
  storyendingtall: {
    q: 'autostart=1&bosstest=final&crew=all', vp: { width: 1080, height: 1920 },
    steps: [6500, BOSS_DOWN, WAIT_MODE('story'), 3500, 'shot:story-ending-tall', ESC_DOWN, 1000, ESC_UP, 300, 'shot:story-complete-tall-a', 3500, 'shot:story-complete-tall'],
  },
  // CAMPAIGN menu with a completed save: LIBERATION MODE
  storycomplete: { q: '', vp: { width: 1600, height: 900 }, steps: [NO_SAVE, STORY_SAVE(5, ", completed: true"), ...TO_CAMPMENU, 'shot:story-campmenu-complete', 'key:Enter', 2000, 'shot:story-liberation-intro', STORYINFO] },
  // the camp MAP tab at a workshop in the region (boss revealed), 1080p, 720p and portrait
  storymap: {
    q: 'autostart=1&region=1&crew=all', vp: { width: 1920, height: 1080 },
    steps: [6500, AT_FLAG, 'eval:window.__app.world.boss.reveal()', 1500, 'key:Enter', 700, 'key:KeyE', 300, 'key:KeyE', 900, 'shot:story-camp-map', 'key:Tab', 400, 'shot:story-camp-map-next'],
  },
  storymap720: { q: 'autostart=1&region=1&crew=all', vp: { width: 1280, height: 720 }, steps: [6500, AT_FLAG, 2500, 'key:Enter', 900, 'key:KeyE', 300, 'key:KeyE', 900, 'shot:story-camp-map-720'] },
  storymaptall: { q: 'autostart=1&region=1&crew=all', vp: { width: 1080, height: 1920 }, steps: [6500, AT_FLAG, 2500, 'key:Enter', 900, 'key:KeyE', 300, 'key:KeyE', 900, 'shot:story-camp-map-tall'] },
  stage1: { q: `${play}&stage=1`, steps: [7000, 'shot'] },
  dusk: { q: `${play}&stage=2`, steps: [11000, 'shot'] },
  night: { q: `${play}&stage=3`, steps: [11000, 'shot'] },
  ice: { q: `${play}&stage=6`, steps: [13000, 'shot'] },
  crt: { q: `${play}&stage=4&crt=1`, steps: [9000, 'shot'] },
  gen: { q: `${play}&stage=12`, steps: [9000, 'shot'] },
  two: { q: 'autostart=1&players=2&stage=7', steps: [5000, 'shot'] },
  tally: { q: `${play}&stage=1&debug=1`, steps: [9000, 'key:KeyK', 1500, 'key:KeyN', 6000, 'shot'] },
  flow: {
    q: `${play}&stage=1&debug=1`,
    steps: [5000, 'key:Digit9', 'key:Digit4', 1500, 'shot:flow-power', 'key:KeyN', 5000, 'shot:flow-tally', 'key:Enter', 9000, 'shot:flow-next'],
  },
  portrait: { q: `${play}&stage=3`, vp: { width: 900, height: 1400 }, steps: [7000, 'shot'] },
  forest: { q: `${play}&stage=4`, steps: [9000, 'shot'] },
  fxnight: { q: `${play}&stage=3&debug=1`, steps: [5500, 'key:KeyK', 350, 'shot:fx-boom', 1600, 'shot:fx-smoke', 2500, 'shot:fx-after'] },
  fxday: { q: `${play}&stage=7&debug=1`, steps: [5500, 'key:KeyK', 1200, 'shot:fx-day'] },
  pixel: { q: `${play}&stage=2&pixel=1`, steps: [6000, 'shot'] },
  rtxon: { q: `${play}&stage=4`, steps: [6000, 'shot'] },
  rtxoff: { q: `${play}&stage=4&rtx=0`, steps: [6000, 'shot'] },
  ripple: { q: `${play}&stage=7`, steps: [5000, 'eval:window.__rip = setInterval(() => { const r = window.__app.r; r.waveSplat(48, 32, 4, 2.2); r.waveSplat(112, 80, 4, 2.2); r.waveSplat(150, 118, 4, 2.2); r.dyeSplat(120, 136, 10, 1.2, 0.8, 0.6); r.velSplat(120, 136, 8, 60, -30); }, 700)', 1500, 'shot', 'eval:clearInterval(window.__rip)', 450, 'shot:ripple2'] },
  splash: { q: `${play}&stage=7`, steps: [5000, 'eval:{ const r = window.__app.r; r.waveSplat(48, 34, 6, 3); r.waveSplat(112, 82, 6, 3); }', 130, 'shot:splash1', 250, 'shot:splash2'] },
  beam: { q: 'autostart=1&stage=2&debug=1', steps: [5000, 'eval:{ const w = window.__app.world; w.freeze = 1e6; const p = w.players[0]; p.x = 27; p.y = 64; p.dir = 0; window.__f = setInterval(() => w.fire(p), 220); }', 3500, 'shot'] },
  smokebeam: { q: 'autostart=1&stage=2&debug=1', steps: [5000, 'eval:{ const a = window.__app; const w = a.world; w.freeze = 1e6; const p = w.players[0]; p.x = 27; p.y = 64; p.dir = 0; window.__f = setInterval(() => { w.fire(p); for (let y = 20; y < 70; y += 8) a.r.dyeSplat(58 + Math.random() * 10, y, 7, 0.5, 0, 0); }, 200); }', 3500, 'shot'] },
  canopy: { q: 'autostart=1&stage=4&debug=1', steps: [5000, 'eval:{ const w = window.__app.world; w.freeze = 1e6; const p = w.players[0]; p.x = 40; p.y = 4; p.dir = 1; w.power = { x: 72, y: 8, type: 3, t: 0 }; }', 1500, 'eval:window.__app.world.players[0].shield = 0', 300, 'shot'] },
  pause: { q: `${play}&stage=3`, steps: [6000, 'key:Escape', 900, 'shot'] },
  settings: { q: '', steps: [600, 'key:Enter', 400, 'key:ArrowDown', 'key:ArrowDown', 'key:ArrowDown', 'key:Enter', 900, 'shot'] },
  settingsshift: { q: '', steps: [600, 'key:Enter', 2600, 'key:ArrowDown', 150, 'key:ArrowDown', 150, 'key:ArrowDown', 150, 'key:Enter', 800, 'key:ArrowDown', 300, 'shot:set-a', 'key:ArrowRight', 400, 'shot:set-b', 'key:ArrowRight', 300] },
  campaignmenu: { q: '', steps: [600, 'key:Enter', 400, 'key:ArrowDown', 'key:ArrowDown', 300, 'shot:campaign-menu', 'key:Enter', 6000, 'shot:campaign-start'] },
  over: { q: `${play}&stage=1&debug=1`, steps: [9000, 'key:KeyO', 3000, 'shot:over-play', 6000, 'key:Enter', 4000, 'shot:over'] },
  menu: { q: '', steps: [500, 'key:Enter', 'key:Enter', 2600, 'shot:menu-intro', 'key:ArrowUp', 'key:ArrowUp', 300, 'shot:menu-select', 'key:Enter', 3500, 'shot:menu-play'] },
  still: { q: 'autostart=1&stage=7', steps: [4000, STILL, 3000, 'shot:still-day'] },
  stillnight: { q: 'autostart=1&stage=3', steps: [4000, STILL, 3000, 'shot:still-night'] },
  stilltitle: { q: '', steps: [3000, STILL, 3000, 'shot:still-title'] },
  // RUST & THUNDER logo on the title, between strikes and mid-strike (bolt drawn, logo lit)
  'title-logo': { q: '', steps: [600, 'eval:window.__app.titleY = 0', 2500, 'eval:window.__app.nextTitleBolt = 99999', 2000, 'shot:title-logo',
    'eval:window.__app.nextTitleBolt = 0', 50, 'shot:title-flash-a', 120, 'shot:title-flash-b', 1500, 'shot:title-after'] },
  // campaign test region (?region=N): big scrolling map, camera follows the autopilot
  region: { q: `${play}&region=1`, steps: [6000, 'shot:region-a', 5000, 'shot:region-b', 5000, 'shot:region-c'] },
  regionnight: { q: `${play}&region=2`, steps: [3000, "eval:window.__app.world.env = 'night'", 5000, 'shot:region-night'] },
  region2p: { q: 'autostart=1&players=2&region=3', steps: [5000, 'shot:region-2p'] },
  // farmland close-ups: park the player (enemies frozen) on a town green and on a road bridge, by day, at night
  // in the rain and in snow; the camera follows
  regiontown: { q: 'autostart=1&region=1', vp: { width: 1920, height: 1080 }, steps: regionSpots() },
  regiontown2: { q: 'autostart=1&region=2', vp: { width: 1920, height: 1080 }, steps: regionSpots('-r2') },
  // the campaign view takes the window's shape (16:9, 21:9 clamps at 480 wide, 720p, portrait)
  regionwide: { q: `${play}&region=1`, vp: { width: 1920, height: 1080 }, steps: [6000, NATIVE, 'shot:region-169'] },
  region21: { q: `${play}&region=1`, vp: { width: 2560, height: 1080 }, steps: [6000, NATIVE, 'shot:region-219'] },
  region720: { q: `${play}&region=2`, vp: { width: 1280, height: 720 }, steps: [3000, "eval:window.__app.world.env = 'night'", 4000, NATIVE, 'shot:region-720'] },
  regiontall: { q: `${play}&region=1`, vp: { width: 900, height: 1400 }, steps: [6000, NATIVE, 'shot:region-portrait'] },
  // the auto-resolution fallback (maxK) on the widened view
  regionlowk: { q: `${play}&region=1`, vp: { width: 1920, height: 1080 }, steps: [5000, 'eval:window.__app.r.maxK = 2', 1000, NATIVE, 'shot:region-lowk'] },
  // sub-pixel glide: freeze the game and step the camera by 0.5 native px between shots
  regionpan: {
    q: `${play}&region=1`, vp: { width: 1920, height: 1080 },
    steps: [5000, "eval:{ const a = window.__app; a.update = () => {}; a.cam.x = Math.floor(a.cam.x) + 0.0; }", 400, NATIVE, 'shot:region-pan0',
      'eval:window.__app.cam.x += 0.5', 400, 'shot:region-pan1', 'eval:window.__app.cam.x += 0.5', 400, 'shot:region-pan2'],
  },
  // live window change: the canvas shrinks to a square-ish box mid-game, then back
  regionresize: {
    q: `${play}&region=1`, vp: { width: 1600, height: 900 },
    steps: [5000, "eval:{ const c = document.getElementById('c'); c.style.width = '1000px'; c.style.height = '900px'; }", 1500, NATIVE, 'shot:region-resize1',
      "eval:{ const c = document.getElementById('c'); c.style.width = ''; c.style.height = ''; }", 1500, NATIVE, 'shot:region-resize2'],
  },
  // campaign HUD at the mockups' sizes (compare with mockups/campaign-ui/hud-*.png)
  hud1080: { q: 'autostart=1&region=1', vp: { width: 1920, height: 1080 }, steps: hudSteps('hud-1p-1080', 'full', true) },
  hud2p: { q: 'autostart=1&players=2&region=3', vp: { width: 1920, height: 1080 }, steps: hudSteps('hud-2p-1080') },
  hud720: { q: 'autostart=1&region=1', vp: { width: 1280, height: 720 }, steps: hudSteps('hud-1p-720', 'full', true) },
  hud2p720: { q: 'autostart=1&players=2&region=3', vp: { width: 1280, height: 720 }, steps: hudSteps('hud-2p-720') },
  hudtall: { q: 'autostart=1&region=1', vp: { width: 900, height: 1400 }, steps: hudSteps('hud-1p-portrait', 'full', true) },
  hudtall1080: { q: 'autostart=1&region=1', vp: { width: 1080, height: 1920 }, steps: hudSteps('hud-1p-portrait1080') },
  // ability keys reach PInput.ability: logs [player, ability] for every update that carried one
  hudkeys: {
    q: 'autostart=1&players=2&region=1&debug=1', vp: { width: 1280, height: 720 },
    steps: [6500, 'eval:{ const w = window.__app.world; window.__ab = []; const up = w.update.bind(w); w.update = (inp) => { inp.forEach((p, i) => p.ability && window.__ab.push([i, p.ability])); up(inp); }; }',
      'key:Digit1', 'key:Digit4', 'key:Numpad2', 'key:Digit9',
      // debug: Shift + digit is a power-up in region mode, not an ability
      "eval:window.__app.input.down.add('ShiftLeft')", 'key:Digit3', "eval:window.__app.input.down.delete('ShiftLeft')", 300, 'eval:({ ab: window.__ab, mode: window.__app.mode, frame: window.__app.world.frame })'],
  },
  hudexplore: { q: 'autostart=1&region=2', vp: { width: 1920, height: 1080 }, steps: hudSteps('hud-explore', 'none') },
  // camp / garage screen over the title with a demo run (?camp=1; compare with mockups/campaign-ui/garage-1080.png)
  garage1080: { q: 'camp=1', vp: { width: 1920, height: 1080 }, steps: [2500, GXFIT, 'shot:garage-1080'] },
  garage720: { q: 'camp=1', vp: { width: 1280, height: 720 }, steps: [2500, GXFIT, 'shot:garage-720'] },
  garagetall: { q: 'camp=1', vp: { width: 900, height: 1400 }, steps: [2500, GXFIT, 'shot:garage-portrait'] },
  garage1600: { q: 'camp=1&players=2', vp: { width: 1600, height: 900 }, steps: [2500, GXFIT, 'shot:garage-1600'] },
  // keys: move into the slots, fit from the bin, take off, strip, repair, craft a patch, the placeholder tabs, close
  garagenav: {
    q: 'camp=1', vp: { width: 1920, height: 1080 },
    steps: [2500, 'key:ArrowRight', 'key:ArrowDown', 300, 'shot:garage-nav-move', 'key:ArrowLeft', 'key:ArrowLeft', 'key:ArrowUp', 'key:ArrowUp', 300, 'shot:garage-nav-slot',
      'key:ArrowRight', 'key:ArrowRight', 'key:Enter', 300, 'shot:garage-nav-fit', 'key:KeyX', 300, 'shot:garage-nav-strip',
      'key:KeyR', 'key:KeyR', 300, 'shot:garage-nav-repair', 'key:Digit4', 'key:Digit1', 300, 'shot:garage-nav-craft',
      'key:KeyE', 300, 'shot:garage-nav-crew', 'key:KeyE', 300, 'shot:garage-nav-map', 'key:KeyE', 'key:Escape', 300,
      'eval:({ open: window.__camp.isOpen(), mode: window.__app.mode, result: window.__campResult && { scrap: window.__campResult.run.scrap, bin: window.__campResult.run.bin, fitted: window.__campResult.run.fitted, charges: window.__campResult.run.charges, armour: window.__campResult.armour } })'],
  },
  // co-op: Tab switches the tank being fitted (both share the bin and scrap)
  garage2p: {
    q: 'camp=1&players=2', vp: { width: 1920, height: 1080 },
    steps: [2500, 'shot:garage-2p-p1', 'key:Tab', 300, 'shot:garage-2p-p2', 'key:Enter', 300, 'shot:garage-2p-fit', 'key:Tab', 'key:ArrowRight', 300, 'shot:garage-2p-back',
      'key:Escape', 300, 'eval:({ fitted: window.__campResult.run.fitted, armour: window.__campResult.armour })'],
  },
  garage2p720: { q: 'camp=1&players=2', vp: { width: 1280, height: 720 }, steps: [2500, 'key:Tab', 300, 'shot:garage-2p-720'] },
  // ---------- Phase 3 crew (compare with mockups/campaign-ui/crew-1080.png) ----------
  // the CREW tab of the demo run (the mockup's five; SOFIA can level up), at 1080p / 720p / portrait
  crew1080: { q: 'camp=1', vp: { width: 1920, height: 1080 }, steps: [2500, 'key:KeyE', 400, GXFIT, CREWFIT, 'shot:crew-1080'] },
  crew720: { q: 'camp=1', vp: { width: 1280, height: 720 }, steps: [2500, 'key:KeyE', 400, GXFIT, CREWFIT, 'shot:crew-720'] },
  crewtall: { q: 'camp=1', vp: { width: 900, height: 1400 }, steps: [2500, 'key:KeyE', 400, GXFIT, 'shot:crew-portrait'] },
  // co-op: crew split between BABUSYA and DIDO; ENTER levels SOFIA up, T makes the next card talk
  crew2p: {
    q: 'camp=1&players=2', vp: { width: 1920, height: 1080 },
    steps: [2500, 'key:KeyE', 300, 'key:Enter', 300, 'shot:crew-2p-levelup', 'key:ArrowRight', 'key:KeyT', 300, 'shot:crew-2p-talk',
      'key:Escape', 300, 'eval:({ crew: window.__campResult && window.__campResult.run.crew })'],
  },
  // all eight (one waiting): more than five slide with the selection
  crewall: { q: 'camp=1&crew=all', vp: { width: 1920, height: 1080 }, steps: [2500, 'key:KeyE', 300, 'key:ArrowRight', 'key:ArrowRight', 'key:ArrowRight', 'key:ArrowRight', 'key:ArrowRight', 300, GXFIT, 'shot:crew-all'] },
  crewstart: { q: 'camp=1&crew=start', vp: { width: 1920, height: 1080 }, steps: [2500, 'key:KeyE', 300, 'shot:crew-start'] },
  // garage crafting with crew aboard: drone (HOT GLUE price), ambush, recon enabled; then a drone crafted
  garagecraft: {
    q: 'camp=1', vp: { width: 1920, height: 1080 },
    steps: [2500, "eval:document.querySelector('#gx [data-f=\"c:0\"]').click()", 300, 'shot:garage-craft',
      'key:Digit2', 300, 'shot:garage-craft-ambush'],
  },
  garagecraftstart: { q: 'camp=1&crew=start', vp: { width: 1920, height: 1080 }, steps: [2500, 'shot:garage-craft-start'] },
  // freeing a town in region 1 offers WASP (the card pauses the game), WELCOME ABOARD: toast + her radio line
  recruit: {
    q: 'autostart=1&region=1', vp: { width: 1920, height: 1080 },
    steps: [6500, AT_FLAG, WAIT_RECRUIT, 1000, 'shot:recruit-card', 'key:Digit1', 700, 'shot:recruit-joined', 2600, 'shot:recruit-radio', CREWINFO],
  },
  recruit720: { q: 'autostart=1&region=1', vp: { width: 1280, height: 720 }, steps: [6500, AT_FLAG, WAIT_RECRUIT, 1000, 'shot:recruit-720'] },
  recruittall: { q: 'autostart=1&region=1', vp: { width: 900, height: 1400 }, steps: [6500, AT_FLAG, WAIT_RECRUIT, 1000, 'shot:recruit-portrait'] },
  // NOT NOW: she waits; Enter at the flag's workshop: she asks again, then the camp opens with the drone craftable
  recruitwait: {
    q: 'autostart=1&region=1', vp: { width: 1920, height: 1080 },
    steps: [6500, AT_FLAG, WAIT_RECRUIT, 1000, 'key:Digit2', 800, CREWINFO, 'key:Enter', WAIT_RECRUIT, 1000, 'shot:recruit-again', 'key:Digit1', 800, 'shot:recruit-camp', CREWINFO],
  },
  // ---------- Phase 5 map events (src/game/events.ts): marker, cards, an escort and a supply drop ----------
  evmarker: { q: 'autostart=1&region=1&crew=all', vp: { width: 1920, height: 1080 }, steps: [6500, WAIT_MODE('play'), EV_AT('tip', 72), 1500, 'shot:ev-marker', 'key:Tab', 700, 'shot:ev-marker-map', EVINFO] },
  evmarker720: { q: 'autostart=1&region=1&crew=all', vp: { width: 1280, height: 720 }, steps: [6500, WAIT_MODE('play'), EV_AT('tip', 72), 1500, 'shot:ev-marker-720', 'key:Tab', 700, 'shot:ev-marker-map-720'] },
  evtractor: {
    q: 'autostart=1&region=1&crew=all', vp: { width: 1920, height: 1080 },
    steps: [6500, WAIT_MODE('play'), EV_AT('tractor'), WAIT_MODE('event'), ...EV_ANSWERS, 'shot:ev-card-tractor', 'key:Digit1', 2600, 'shot:ev-card-tractor-reply', ...EV_CLOSE,
      ESCORT_HALF, 2500, 'shot:ev-escort', EVINFO],
  },
  evtractor720: {
    q: 'autostart=1&region=1&crew=all', vp: { width: 1280, height: 720 },
    steps: [6500, WAIT_MODE('play'), EV_AT('tractor'), WAIT_MODE('event'), ...EV_ANSWERS, 'shot:ev-card-tractor-720', 'key:Digit1', 600, ...EV_CLOSE, ESCORT_HALF, 2500, 'shot:ev-escort-720'],
  },
  evdrop: {
    q: 'autostart=1&region=1&crew=all', vp: { width: 1920, height: 1080 },
    steps: [6500, WAIT_MODE('play'), EV_AT('drop'), WAIT_MODE('event'), ...EV_ANSWERS, 'shot:ev-card-drop', 'key:Digit1', 600, ...EV_CLOSE, 1000, 'shot:ev-drop-arrow',
      NEAR_CRATE, 2500, 'shot:ev-drop-crate', EVINFO],
  },
  evdrop720: {
    q: 'autostart=1&region=1&crew=all', vp: { width: 1280, height: 720 },
    steps: [6500, WAIT_MODE('play'), EV_AT('drop'), WAIT_MODE('event'), ...EV_ANSWERS, 'shot:ev-card-drop-720', 'key:Digit1', 600, ...EV_CLOSE, 1000, 'shot:ev-drop-arrow-720', NEAR_CRATE, 2500, 'shot:ev-drop-crate-720'],
  },
  // regional: the rail junction's handcar (IVAN, a new civilian portrait)
  evhandcar: { q: 'autostart=1&region=1&stage=2&crew=all', vp: { width: 1920, height: 1080 }, steps: [6500, WAIT_MODE('play'), EV_AT('handcar'), WAIT_MODE('event'), ...EV_ANSWERS, 'shot:ev-card-handcar', EVINFO] },
  evhandcar720: { q: 'autostart=1&region=1&stage=2&crew=all', vp: { width: 1280, height: 720 }, steps: [6500, WAIT_MODE('play'), EV_AT('handcar'), WAIT_MODE('event'), ...EV_ANSWERS, 'shot:ev-card-handcar-720'] },
  evminefield: {
    q: 'autostart=1&region=1&crew=all', vp: { width: 1920, height: 1080 },
    steps: [6500, WAIT_MODE('play'), EV_AT('minefield'), WAIT_MODE('event'), ...EV_ANSWERS, 'shot:ev-card-minefield', 'key:Digit1', 600, ...EV_CLOSE, 1500, 'shot:ev-minefield', EVINFO],
  },
  // ---------- 2026-10-15 play test fixes ----------
  // ?arena=tricks: start, everything hidden shown (recon view), the artillery pad's barrage
  arena: {
    q: 'arena=tricks', vp: { width: 1920, height: 1080 },
    steps: [WAIT_MODE('play'), 2500, 'shot:arena-start', ARENAINFO, 'eval:{ window.__app.world.tricks.reveal = true; }', 700, 'shot:arena-revealed',
      'eval:{ const w = window.__app.world, p = w.players[0]; p.x = 88; p.y = 240; p.dir = 0; p.shield = 600; }', 1200, 'shot:arena-barrage', ARENAINFO],
  },
  // CONTINUE keeps freed towns: a saved region-1 run, two towns freed and a depot blown, back to the menu, CONTINUE
  fixcontinue: {
    q: '', vp: { width: 1600, height: 900 },
    steps: [NO_SAVE, STORY_SAVE(0), ...TO_CAMPMENU, 'key:Enter', 2500, 'key:Enter', WAIT_MODE('play'), 800,
      'eval:{ const a = window.__app, w = a.world; w.freeze = 1e9; w.freeTown(w.towns[1]); w.freeTown(w.towns[0]); const d = w.depots[0]; for (let i = 0; i < 6; i++) w.hitDepot(d, 0); a.campaignTick(w); ({ progress: a.run.progress }); }',
      600, 'eval:{ const a = window.__app; a.run = null; a.world = null; a.titleY = 0; a.openCampMenu(); a.menuSel = 0; ({ save: a.campSave?.progress }); }', 700,
      'shot:fix-continue-menu', 'key:Enter', 2500, 'shot:fix-continue-intro', 'key:Enter', WAIT_MODE('play'), 1200,
      'eval:{ const w = window.__app.world; ({ freed: w.towns.filter((t) => t.freed).map((t) => t.name), checkpoint: w.checkpoint?.name, depots: w.depots.map((d) => d.destroyed), boss: w.boss?.state }); }',
      'key:Tab', 600, 'shot:fix-continue-map'],
  },
  // the world stays frozen behind a recruit card, the workshop camp and a map event card (w.frame must not move)
  fixfreeze: {
    q: 'autostart=1&region=1', vp: { width: 1600, height: 900 },
    steps: [6500, AT_FLAG, WAIT_RECRUIT, FRAMEINFO, 3000, FRAMEINFO, 'key:Digit1', 800, 'key:Enter', 900, FRAMEINFO, 3000, FRAMEINFO, 'shot:fix-freeze-camp'],
  },
  fixfreezeevent: {
    q: 'autostart=1&region=1&stage=5&crew=all', vp: { width: 1600, height: 900 },
    steps: [6500, WAIT_MODE('play'), EV_NEAR_ENEMY('tractor'), WAIT_MODE('event'), FRAMEINFO, 5000, FRAMEINFO, 'shot:fix-freeze-event'],
  },
  // camp MAP tab with a damaged tank and a big scrap pile: the READY CHECK patch line wraps inside its plate
  fixcampmap: {
    q: 'autostart=1&region=1&crew=all', vp: { width: 1920, height: 1080 },
    steps: [WAIT_MODE('play'), 1000, AT_FLAG, 'eval:{ const w = window.__app.world; w.players[0].armour = 1; w.scrap = 12345; }', 1500, 'key:Enter', 700, 'key:KeyE', 300, 'key:KeyE', 900, GXFIT, 'shot:fix-camp-map'],
  },
  fixcampmap720: {
    q: 'autostart=1&region=1&crew=all', vp: { width: 1280, height: 720 },
    steps: [6500, AT_FLAG, 'eval:{ const w = window.__app.world; w.players[0].armour = 1; w.scrap = 12345; }', 1500, 'key:Enter', 700, 'key:KeyE', 300, 'key:KeyE', 900, GXFIT, 'shot:fix-camp-map-720'],
  },
  // Region 4 big map open when the boss is located: the toast must clear the map's title bar
  fixbossmap: {
    q: 'autostart=1&region=1&stage=4', vp: { width: 1600, height: 900 },
    steps: [WAIT_MODE('play'), 1500, 'key:Tab', 500, 'eval:{ const w = window.__app.world; w.boss.reveal(); const p = w.players[0]; p.shield = 600; }', 350, 'shot:fix-boss-map-r4'],
  },
  // HUD while the tank is knocked out on its last life (the retreat fade): armour keeps its maximum
  fixretreat: {
    q: 'autostart=1&region=1', vp: { width: 1600, height: 900 },
    steps: [6500, KNOCKOUT, 1500, 'shot:fix-retreat-hud', 5500, 'shot:fix-retreat-card', 'key:Enter', 1500, 'shot:fix-retreat-intro', RUNINFO],
  },
  // Structures round (2026-11-18): the buildings of every region in its own weather: towns, a depot, and each
  // region's set pieces (farmstead and crop fields, station yard, waterside village, city blocks, the fortified line)
  structfarm: {
    q: 'autostart=1&region=1&stage=1', vp: STRUCT_VP,
    steps: [WAIT_MODE('play'), 2500, STRUCT_HUD, REGIONINFO, ...structSpots('farm', [['town0', TOWNN(0)], ['town1', TOWNN(1)], ['town2', TOWNN(2)], ['depot', DEPOTN(0)],
      ['farmstead', KINDSPOT(7, 0)], ['sunflowers', KINDSPOT(5, 0)], ['crops', KINDSPOT(3, 0)]])],
  },
  structrail: {
    q: 'autostart=1&region=1&stage=2', vp: STRUCT_VP,
    steps: [WAIT_MODE('play'), 2500, STRUCT_HUD, REGIONINFO, ...structSpots('rail', [['station', STATIONSPOT], ['town0', TOWNN(0)], ['town1', TOWNN(1)], ['town2', TOWNN(2)], ['depot', DEPOTN(0)]])],
  },
  structdelta: {
    q: 'autostart=1&region=1&stage=3', vp: STRUCT_VP,
    steps: [WAIT_MODE('play'), 2500, STRUCT_HUD, REGIONINFO, ...structSpots('delta', [['town0', TOWNN(0)], ['town1', TOWNN(1)], ['town2', TOWNN(2)], ['depot', DEPOTN(0)]])],
  },
  structruins: {
    q: 'autostart=1&region=1&stage=4', vp: STRUCT_VP,
    steps: [WAIT_MODE('play'), 2500, STRUCT_HUD, REGIONINFO, ...structSpots('ruins', [['town0', TOWNN(0)], ['town1', TOWNN(1)], ['square', LAIR], ['depot', DEPOTN(0)]]),
      ENV('day'), ...structSpots('ruins-day', [['town0', TOWNN(0)], ['town1', TOWNN(1)], ['depot', DEPOTN(0)]])],
  },
  structwinter: {
    q: 'autostart=1&region=1&stage=5', vp: STRUCT_VP,
    steps: [WAIT_MODE('play'), 2500, STRUCT_HUD, REGIONINFO, ...structSpots('winter', [['town0', TOWNN(0)], ['town1', TOWNN(1)], ['lair', LAIR], ['depot', DEPOTN(0)], ['line', BRICKSPOT]])],
  },
  scrolltest: { q: `${play}&stage=1`, steps: scrollSteps('scroll') },
  // A held direction key must not stay "held" when a modal card opens and the key is released under it (the story
  // cards swallowed key events before Input saw the keyup). Hold ArrowRight, walk onto a map event so its card opens,
  // release the key while the card is up (dispatched on body, like a real key), answer the card, and check the tank
  // stays put afterwards. Key events go to body so they travel the capture phase like real ones.
  keystuck: {
    q: 'autostart=1&region=1',
    steps: [6500, 'key:Enter', 4000,
      "eval:(() => { const w = window.__app.world; document.body.dispatchEvent(new KeyboardEvent('keydown', { code: 'ArrowRight', bubbles: true })); const p = w.players[0]; const ev = w.events.placed[0]; p.x = Math.round(ev.x / 8) * 8 - 24; p.y = Math.round(ev.y / 8) * 8; return { eventCard: ev.def.id }; })()",
      600,
      "eval:(() => { const a = window.__app; document.body.dispatchEvent(new KeyboardEvent('keyup', { code: 'ArrowRight', bubbles: true })); return { modeWhileCard: a.mode, heldAfterKeyup: [...a.input.down] }; })()",
      2500, 'key:Enter', 1200, 'key:Enter', 1200, 'key:Enter', 1200, 'key:Digit1', 2500, 'key:Enter', 1200, 'key:Enter', 1500,
      "eval:(() => { const a = window.__app; const p = a.world.players[0]; window.__kp = [p.x, p.y]; return { mode: a.mode, held: [...a.input.down] }; })()",
      1500,
      "eval:(() => { const a = window.__app; const p = a.world.players[0]; return { movedAfterCard: [p.x - window.__kp[0], p.y - window.__kp[1]], mode: a.mode }; })()"],
  },
  // ---------- 2026-11-18 UI fixes (G1 radio fit) ----------
  // the longest speaker (INTERCEPT) and the longest lines, fully typed, at 16:9 / 720p / portrait
  radiofit: { q: 'autostart=1&region=1', vp: { width: 1920, height: 1080 }, steps: RADIO_FIT('radiofit') },
  radiofit720: { q: 'autostart=1&region=1', vp: { width: 1280, height: 720 }, steps: RADIO_FIT('radiofit-720') },
  radiofitp: { q: 'autostart=1&region=1', vp: { width: 1080, height: 1920 }, steps: RADIO_FIT('radiofit-portrait') },
  // S4 radio priority: a burst of intercepts with HQ, boss and crew lines mixed in. Expected: the first intercept
  // plays, then HQ, the boss and SPANNER in order, then the newest two intercepts; nothing important dropped.
  radioprio: {
    q: 'autostart=1&region=1', vp: { width: 1600, height: 900 },
    steps: [WAIT_MODE('play'), 1500, RADIO_SHOW('SPANNER', 'TEST.'), `eval:{ const a = window.__app, c = a.ui.camp; c.radioQ.length = 0; c.radioT = -1; c.radioCur = null;
      const L = [['INTERCEPT', 'KETTLE: CONTACT. DEPLOYING IN LINE.', 1], ['INTERCEPT', 'BIRCH: COLUMN MOVING ON ZOLOTA BALKA.', 1], ['KOVAL', 'HQ: THE BRIDGE IS MINED.', 0],
        ['INTERCEPT', 'MAGPIE: TOO HOT. FALLING BACK.', 1], ['INTERCEPT', 'GRINDER: SO THE FARMERS WANT A FIGHT.', 0], ['INTERCEPT', 'FLINT: OVERWATCH ON THE RIDGE.', 1],
        ['SPANNER', 'HIS SIDE IS OPEN.', 0], ['INTERCEPT', 'SORREL: CREW BAILING OUT.', 1]];
      for (const [who, text, amb] of L) a.ui.radio(amb ? { who, text, amb: true } : { who, text });
      ({ now: c.radioCur.text, queue: c.radioQ.map((m) => m.text) }); }`, 300, 'shot:radio-prio'],
  },
  // S2: ESC held at the rail briefing jumps to the answers (hint: HOLD FOR ANSWER 1); held again takes answer 1 and
  // its reward (the save starts with charges [1, 1, 0, 2] and 245 scrap)
  briefskip: {
    q: '', vp: { width: 1600, height: 900 },
    steps: [...RAIL_BRIEF, STORYINFO, ESC_DOWN, 1000, ESC_UP, 900, 'shot:brief-skip-answers', ESC_DOWN, 1000, ESC_UP, 800, STORYINFO, 'shot:brief-skip-after'],
  },
  // S1: ASK FIRST at the rail briefing: the reply, then the region starts with the lair marked on the big map
  briefask: {
    q: '', vp: { width: 1600, height: 900 },
    steps: [...RAIL_BRIEF, 'key:Enter', 3000, 'shot:brief-ask-choices', 'key:Digit3', 4500, 'shot:brief-ask-reply', STORYINFO,
      'key:Enter', 1500, 'key:Enter', 1500, 'key:Enter', 1500, 'key:Enter', WAIT_MODE('play'), 2500,
      "eval:{ const w = window.__app.world; w.freeze = 1e9; ({ mode: window.__app.mode, lairKnown: w.lairKnown, boss: w.boss?.state }); }", 'shot:brief-ask-play', 'key:Tab', 700, 'shot:brief-ask-map'],
  },
  // the lair mark on every boss's map (forced on): Farmland, Rail, Delta, Ruined Town, Winter
  ...Object.fromEntries([1, 2, 3, 4, 5].map((st) => [`lairmark${st}`, {
    q: `autostart=1&region=1&stage=${st}`, vp: { width: 1600, height: 900 },
    steps: [WAIT_MODE('play'), 1500, "eval:{ const w = window.__app.world; w.freeze = 1e9; w.lairKnown = true; w.boss?.state; }", 'key:Tab', 900, `shot:lair-mark-${st}`],
  }])),
  // G3: three towns freed at once, a recruit and the boss reveal: at most two toasts, the recruit's on one line
  toastcrowd: {
    q: 'autostart=1&region=1', vp: { width: 1920, height: 1080 },
    steps: [WAIT_MODE('play'), 1000, TOASTLOG, BOSS_SETUP('day'), 700, TOASTINFO, 'shot:toast-crowd', 1000, TOASTINFO, 'shot:toast-crowd-2'],
  },
  // G5 hit-stop: the world's frame counter over ~250 ms after a player's kill and after a boss part breaks; the
  // longest gap between frame steps should be about 3 updates (kill) and 5 (boss part) instead of 1
  hitstop: {
    q: 'autostart=1&region=1', vp: { width: 1280, height: 720 },
    steps: [WAIT_MODE('play'), 1500, HITSTOP_PROBE('none'), HITSTOP_PROBE('kill'), "eval:{ const w = window.__app.world; w.boss.reveal(); w.boss.state }", 600, HITSTOP_PROBE('part')],
  },
  // M5 first-play prompts on a fresh browser: move/fire, then driving into a held town, armour under half, and the
  // map prompt (frame pushed to 25 s); then the seen list in localStorage
  tips: {
    q: 'autostart=1&region=1', vp: { width: 1600, height: 900 },
    steps: [WAIT_MODE('play'), TOASTLOG, 2200, 'shot:tip-move', 3000,
      "eval:{ const w = window.__app.world; w.freeze = 1e9; const t = w.towns.find((x) => !x.freed); const p = w.players[0]; const s = w.freeSpotNear(t.cx - 8, t.cy + 16); p.x = s[0]; p.y = s[1]; p.shield = 600; t.name }",
      700, 'shot:tip-flag', 3800, "eval:{ const p = window.__app.world.players[0]; p.armour = Math.floor(p.armourMax / 2) - 1; p.armour }", 700, 'shot:tip-patch', 3800,
      'eval:{ window.__app.world.frame = 60 * 26; 1 }', 700, 'shot:tip-map', TOASTINFO, "eval:localStorage.getItem('tank1990neo.tips')"],
  },
  // G2 / T6: the four Dominion tank types parked round the player, in each light (Ruined Town map, frozen)
  enemylook: {
    q: 'autostart=1&region=1&stage=4', vp: { width: 1600, height: 900 },
    steps: [WAIT_MODE('play'), 2000, TP(TOWNN(0)), ENEMY_RING, ...['night', 'rain', 'day', 'dusk', 'snow'].flatMap((e) => [ENV(e), 2500, `shot:enemy-look-${e}`])],
  },
  // the same on Farmland's dark earth by day (GRINDER's escorts in the review)
  enemylookfarm: {
    q: 'autostart=1&region=1&stage=1', vp: { width: 1600, height: 900 },
    steps: [WAIT_MODE('play'), 2000, ENEMY_RING, ENV('day'), 2500, 'shot:enemy-look-farm-day', ENV('night'), 2500, 'shot:enemy-look-farm-night'],
  },
  scrollnight: { q: `${play}&stage=3`, steps: scrollSteps('scrolln') },
  scrollperf: {
    q: `${play}&stage=3`, vp: { width: 1920, height: 1080 },
    steps: [3000, SCROLL_SETUP, 1000, 'eval:Object.assign(window.__cam, { vx: 37.3, vy: 14.6 })',
      ...Array.from({ length: 5 }, () => [1000, CAM]).flat(), 'eval:Object.assign(window.__cam, { vx: 0, vy: 0 })',
      ...Array.from({ length: 4 }, () => [1000, CAM]).flat(), 'shot:scroll-perf'],
  },
};

const want = process.argv.slice(2).length ? process.argv.slice(2) : ['title', 'stage1', 'night'];
const runner = await openRunner();
console.log(`browser: ${runner.where}`);
let failed = false;
for (const name of want) {
  const sc = SCENES[name];
  if (!sc) {
    console.log(`unknown scene ${name}`);
    continue;
  }
  const r = await runner.run({ name, q: `?mute=1&${sc.q}`, vp: sc.vp, steps: sc.steps });
  for (const shot of r.shots) {
    writeFileSync(resolve(outDir, `${shot.name}.png`), Buffer.from(shot.png, 'base64'));
    console.log(shot.name, JSON.stringify(shot.info));
  }
  for (const v of r.values) if (v !== undefined && v !== null) console.log(`  value ${JSON.stringify(v)}`);
  for (const e of r.errors) console.log(`  ${e.slice(0, 500)}`);
  failed ||= r.failed;
}
await runner.close();
process.exit(failed ? 1 : 0);
