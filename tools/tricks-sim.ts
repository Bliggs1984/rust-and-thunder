// Headless checks for the enemy's tricks (src/game/tricks.ts) on real farmland regions: drones, hidden AT teams,
// minefields, artillery and supply convoys, then a paced run with the autopilot.
// Run: npm run trickssim
import { reseed } from './ai-sim-seed';
import { regionBot } from '../src/game/bot';
import { BRICK, DX, DY, EMPTY, LEFT, RIGHT, ROAD, STEEL, UP, WATER } from '../src/game/constants';
import { newRun } from '../src/game/run';
import { regionWorld } from '../src/game/save';
import { TR, type Tricks } from '../src/game/tricks';
import { Bullet, newPState, type PInput, type PState, type Tank, type World } from '../src/game/world';

let fails = 0;
let exceptions = 0;
let frames = 0;
function check(name: string, ok: boolean, info: string): void {
  if (!ok) fails++;
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}: ${info}`);
}
const sec = (f: number) => `${(f / 60).toFixed(2)} s`;
const IDLE: PInput = { dir: -1, fire: false };

/** A fresh campaign world on region `region` (0 = Farmland) of run `seed`, with tricks on manual. */
function world(seed: number, region = 0): { w: World; tr: Tricks; p: Tank } {
  reseed(seed);
  const run = newRun(seed);
  run.region = region;
  const ps: PState[] = [newPState(), newPState()];
  const w = regionWorld(run, ps, 1);
  const tr = w.tricks!;
  tr.auto = false;
  tr.gentleOff = true;
  w.update([IDLE]); // init the tricks
  const p = w.players[0]!;
  p.spawn = 0;
  p.shield = 0;
  return { w, tr, p };
}

/** Run n updates; enemies other than convoy escorts are removed so the tricks are judged alone. Drains the queues the
 * app drains (sounds, toasts, radio) into the returned log. */
function run(w: World, n: number, inp: PInput | ((w: World) => PInput) = IDLE, until?: () => boolean, keepEnemies = false) {
  const ev: { f: number; n: string; x: number; v: number }[] = [];
  const notes: { f: number; text: string }[] = [];
  const radio: { f: number; text: string }[] = [];
  for (let i = 0; i < n; i++) {
    if (!keepEnemies) for (const e of w.enemies) if (!w.tricks!.owns(e)) e.alive = false;
    try {
      w.update([typeof inp === 'function' ? inp(w) : inp]);
    } catch (e) {
      exceptions++;
      console.log('EXCEPTION', e);
      break;
    }
    frames++;
    for (const e of w.ev) ev.push({ f: w.frame, ...e });
    for (const m of w.notes) notes.push({ f: w.frame, text: m.text });
    for (const m of w.radio) radio.push({ f: w.frame, text: m.text });
    w.ev.length = 0;
    w.notes.length = 0;
    w.radio.length = 0;
    w.popups.length = 0;
    if (until?.()) break;
  }
  return { ev, notes, radio };
}

/** An open stretch (nothing solid; trees allowed, but not under the tank) around a tank spot: `l`..`r` px either side of it and `u`..`d` above and
 * below, away from towns. */
function openSpot(w: World, l = 48, r = 120, u = 40, d = 40): [number, number] {
  const m = w.map;
  for (let y = 64; y < w.pxH - 64; y += 8) {
    for (let x = 64; x < w.pxW - 160; x += 8) {
      let ok = !w.towns.some((t) => Math.hypot(t.cx - x, t.cy - y) < 160);
      for (let cy = (y - u) >> 2; ok && cy < (y + 16 + d) >> 2; cy++) {
        for (let cx = (x - l) >> 2; cx < (x + 16 + r) >> 2; cx++) {
          const c = m.at(cx, cy);
          const under = cx >= x >> 2 && cx < (x + 16) >> 2 && cy >= y >> 2 && cy < (y + 16) >> 2;
          if (c === BRICK || c === STEEL || c === WATER || (under && c !== EMPTY && c !== ROAD)) { ok = false; break; }
        }
      }
      if (ok) return [x, y];
    }
  }
  throw new Error('no open spot');
}

function place(p: Tank, [x, y]: [number, number], dir = UP): void {
  p.x = x;
  p.y = y;
  p.dir = dir;
  p.spawn = 0;
  p.shield = 0;
}

function clearStatics(tr: Tricks): void {
  tr.teams.length = 0;
  tr.mines.length = 0;
}

// ---------------------------------------------------------------- 1. drones
{
  const { w, tr, p } = world(101);
  clearStatics(tr);
  place(p, openSpot(w));
  const a0 = p.armour;
  const d = tr.launchDrone(0, 'attack', [p.cx + 260, p.cy - 30])!;
  let hoverAt = -1;
  let dropAt = -1;
  let warnDist = -1;
  let minD = 1e9;
  const log = run(w, 30 * 60, IDLE, () => {
    const dist = Math.hypot(d.x - p.cx, d.y - p.cy);
    minD = Math.min(minD, dist);
    if (hoverAt < 0 && d.phase === 'hover') hoverAt = w.frame;
    if (dropAt < 0 && tr.stats.drops > 0) dropAt = w.frame;
    if (warnDist < 0 && tr.stats.warned > 0) warnDist = dist;
    return dropAt > 0 && tr.bombs.length === 0;
  });
  const buzz = log.ev.filter((e) => e.n === 'trick-drone');
  const firstV = buzz[0]?.v ?? 0;
  const lastV = buzz.length ? Math.max(...buzz.slice(-8).map((e) => e.v)) : 0;
  const warn = log.notes.find((n) => n.text === 'DRONE!');
  const firstBuzz = buzz[0]?.f ?? -1;
  check('d1 drone heard before seen', buzz.length > 10 && firstBuzz >= 0 && (!warn || firstBuzz < warn.f) && lastV > firstV + 0.4,
    `${buzz.length} buzz events from frame ${firstBuzz}, volume ${firstV.toFixed(2)} at 260 px -> ${lastV.toFixed(2)} overhead`);
  check('d2 "DRONE!" toast once within 160 px', !!warn && log.notes.filter((n) => n.text === 'DRONE!').length === 1 && warnDist <= TR.droneWarnR && warnDist > 100,
    `toast at frame ${warn?.f}, drone ${warnDist.toFixed(0)} px away`);
  check('d3 hovers 2 s then drops a grenade (2 armour)', hoverAt > 0 && dropAt - hoverAt >= TR.droneHover && p.armour === a0 - TR.droneBomb,
    `hover from ${sec(hoverAt)}, drop ${sec(dropAt - hoverAt)} later, armour ${a0} -> ${p.armour}, closest ${minD.toFixed(1)} px`);

  // driving away shakes a hovering drone off (it follows slower than a tank drives)
  const g = world(102);
  clearStatics(g.tr);
  place(g.p, openSpot(g.w, 48, 200));
  const d2 = g.tr.launchDrone(0, 'attack', [g.p.cx - 200, g.p.cy])!;
  run(g.w, 20 * 60, IDLE, () => d2.phase === 'hover' && d2.hold > 60);
  const holdBefore = d2.hold;
  run(g.w, 90, { dir: RIGHT, fire: false });
  const gapPx = Math.hypot(d2.x - g.p.cx, d2.y - g.p.cy);
  check('d4 driving off shakes a hovering drone', g.tr.stats.drops === 0 && holdBefore > 60 && d2.hold < holdBefore && gapPx > 10,
    `hold ${holdBefore} -> ${d2.hold} frames after 1.5 s of driving, ${gapPx.toFixed(0)} px behind, drops ${g.tr.stats.drops}`);
}

// shot down on the way in: the player faces it and fires
{
  const { w, tr, p } = world(103);
  clearStatics(tr);
  place(p, openSpot(w, 48, 200), RIGHT);
  const a0 = p.armour;
  tr.launchDrone(0, 'attack', [p.cx + 240, p.cy]);
  const log = run(w, 20 * 60, { dir: -1, fire: true }, () => tr.stats.dronesDown > 0);
  check('d5 drone shot down by a shell', tr.stats.dronesDown === 1 && tr.stats.drops === 0 && p.armour === a0 && w.pickups.some((k) => k.amount === 5),
    `down at ${sec(w.frame)}, drops ${tr.stats.drops}, armour ${a0} -> ${p.armour}, ${log.ev.filter((e) => e.n === 'explode').length} blast sound`);
  // a shell straight up from under a hovering drone misses (the gun can't elevate)
  const g = world(104);
  clearStatics(g.tr);
  place(g.p, openSpot(g.w), UP);
  const d = g.tr.launchDrone(0, 'attack', [g.p.cx, g.p.cy - 200])!;
  run(g.w, 20 * 60, IDLE, () => d.phase === 'hover' && d.hold > 40);
  let hit = false;
  const b = new Bullet(g.p.cx, g.p.cy - 8, UP, 3, g.p, false, false, 0);
  for (let i = 0; i < 40 && !hit; i++) {
    b.y = g.p.cy - 8 - i;
    hit = g.tr.bulletHit(b);
  }
  check('d6 own gun cannot hit a drone straight overhead', !hit && g.tr.stats.dronesDown === 0, `hover ${d.phase}, hit ${hit}`);
}

// jammer: a fitted jammer makes drones in range drift away and crash
{
  const { w, tr, p } = world(105);
  clearStatics(tr);
  place(p, openSpot(w));
  p.fitted = { jammer: 'aerial-jammer' };
  const a0 = p.armour;
  const d = tr.launchDrone(0, 'attack', [p.cx + 250, p.cy + 20])!;
  let minD = 1e9;
  run(w, 25 * 60, IDLE, () => {
    if (d.phase !== 'dead') minD = Math.min(minD, Math.hypot(d.x - p.cx, d.y - p.cy));
    return tr.stats.jamCrash > 0;
  });
  check('d7 jammer makes the drone fail', tr.stats.jammed === 1 && tr.stats.jamCrash === 1 && tr.stats.drops === 0 && p.armour === a0 && minD > 50,
    `jammed ${tr.stats.jammed}, crashed ${tr.stats.jamCrash} at ${sec(w.frame)}, closest ${minD.toFixed(0)} px (range ${TR.jamR['aerial-jammer']}), armour ${a0} -> ${p.armour}`);
}

// spotter: watches, reports to the director, artillery follows; shot first, nothing follows
{
  const { w, tr, p } = world(106);
  clearStatics(tr);
  place(p, openSpot(w));
  const d = tr.launchDrone(0, 'spot', [p.cx - 240, p.cy + 40])!;
  let reportAt = -1;
  const log = run(w, 40 * 60, IDLE, () => {
    if (reportAt < 0 && tr.stats.spotted > 0) reportAt = w.frame;
    return reportAt > 0;
  });
  const k = w.ai?.known;
  check('d8 spotter reports: director learns, barrage follows', tr.stats.spotted === 1 && !!tr.barrage && !!k && w.frame - k.t < 2 && Math.hypot(k.x - p.x, k.y - p.y) < 2
    && log.notes.some((n) => n.text === 'SPOTTER DRONE!') && log.radio.some((r) => r.text.includes('SENDING GRID')),
    `report at ${sec(reportAt)} (drone ${d.phase}), barrage ${tr.barrage ? tr.barrage.shells.length + ' circles' : 'none'}, ai.known ${k ? `${k.x},${k.y}` : 'none'}, radio: ${log.radio.map((r) => r.text).join(' | ')}`);
  const g = world(107);
  clearStatics(g.tr);
  place(g.p, openSpot(g.w, 48, 200), RIGHT);
  g.tr.launchDrone(0, 'spot', [g.p.cx + 220, g.p.cy]);
  run(g.w, 30 * 60, { dir: -1, fire: true }, () => g.tr.stats.dronesDown > 0 || g.tr.stats.spotted > 0);
  run(g.w, 120);
  check('d9 spotter shot first: no follow-up', g.tr.stats.dronesDown === 1 && g.tr.stats.spotted === 0 && !g.tr.barrage && g.tr.stats.barrages === 0,
    `down ${g.tr.stats.dronesDown}, spotted ${g.tr.stats.spotted}, barrages ${g.tr.stats.barrages}`);
}

// ---------------------------------------------------------------- 2. hidden AT teams
{
  const { w, tr, p } = world(201);
  clearStatics(tr);
  place(p, openSpot(w, 48, 120), UP);
  const a0 = p.armour;
  const team = { x: p.cx + 72, y: p.cy, dir: LEFT, alive: true, shown: false, tell: 0, reload: 0, aim: [0, 0] as [number, number], ruin: false, ammo: 2 };
  tr.teams.push(team);
  let tellAt = -1;
  let fireAt = -1;
  let hitAt = -1;
  let shownBefore = false;
  const log = run(w, 10 * 60, IDLE, () => {
    if (tellAt < 0 && team.tell > 0) { tellAt = w.frame; shownBefore = team.shown; }
    if (fireAt < 0 && tr.stats.rockets > 0) fireAt = w.frame;
    if (hitAt < 0 && tr.stats.rocketHits > 0) hitAt = w.frame;
    return hitAt > 0;
  });
  // ambush (was a 0.5 s glint): the rocket leaves within 3 frames of the team lining up, so there is no warning to dodge
  check('i1 AT team: ambush, rocket within 3 frames of lining up (2 armour)', tellAt > 0 && !shownBefore && fireAt - tellAt >= TR.teamTell && fireAt - tellAt <= 3 && hitAt > fireAt && p.armour === a0 - TR.teamDmg && team.shown
    && log.ev.some((e) => e.n === 'trick-rocket'),
    `lined up at ${sec(tellAt)} (hidden until then), rocket ${fireAt - tellAt} frames later, hit ${sec(hitAt - fireAt)} after launch, armour ${a0} -> ${p.armour}, shown after: ${team.shown}`);
  // reload 4 s, then the player turns and shoots them
  const r0 = tr.stats.rockets;
  run(w, TR.teamReload - 40);
  const reloadOk = tr.stats.rockets === r0;
  p.dir = RIGHT;
  run(w, 3 * 60, { dir: -1, fire: true }, () => !team.alive);
  check('i2 reload 4 s, dies to a shell, drops scrap', reloadOk && !team.alive && tr.stats.teamsKilled === 1 && w.pickups.some((k) => k.amount === TR.teamScrap),
    `no rocket during reload: ${reloadOk}, killed at ${sec(w.frame)}, pickups ${w.pickups.map((k) => k.amount).join(',')}`);
  // out of range: never fires; a tank driving over a team kills it
  const g = world(202);
  clearStatics(g.tr);
  place(g.p, openSpot(g.w, 48, 200), RIGHT);
  const far = { x: g.p.cx + 120, y: g.p.cy, dir: LEFT, alive: true, shown: false, tell: 0, reload: 0, aim: [0, 0] as [number, number], ruin: false, ammo: 2 };
  g.tr.teams.push(far);
  run(g.w, 3 * 60);
  const quiet = g.tr.stats.rockets === 0;
  far.reload = 1e6; // hold fire, then drive over them
  run(g.w, 6 * 60, { dir: RIGHT, fire: false }, () => !far.alive);
  check('i3 96 px range; a tank driving over kills them', quiet && !far.alive && g.tr.stats.teamsKilled === 1, `fired at 120 px: ${!quiet}, crushed: ${!far.alive}`);
}
{
  // the placed teams of a real region: in trees or ruins, near roads or towns, far from the start, spaced out
  const { w, tr } = world(203);
  const sp = w.region!.playerSpawns[0];
  const near = tr.teams.filter((t) => Math.hypot(t.x - sp[0] - 8, t.y - sp[1] - 8) < 240).length;
  check('i4 region 1 places a few AT teams', tr.teams.length >= 2 && tr.teams.length <= TR.teams[0] && near === 0,
    `${tr.teams.length} teams (${tr.teams.filter((t) => t.ruin).length} in ruins), ${near} near the start`);
}

// ---------------------------------------------------------------- 2b. gentle first minute (regions 1 and 5)
for (const region of [0, 4]) {
  const { w, tr, p } = world(250 + region, region);
  tr.gentleOff = false;
  tr.auto = true;
  clearStatics(tr);
  place(p, openSpot(w, 48, 120), UP);
  const team = { x: p.cx + 72, y: p.cy, dir: LEFT, alive: true, shown: false, tell: 0, reload: 0, aim: [0, 0] as [number, number], ruin: false, ammo: 2 };
  tr.teams.push(team);
  w.towns[0].freed = true; // unlocks drones, barrages and convoys; only the grace holds them back
  run(w, 55 * 60);
  const early = tr.stats.rockets + tr.stats.drones + tr.stats.barrages + tr.stats.convoys;
  run(w, 20 * 60, IDLE, () => tr.stats.rockets > 0);
  check(`g${region + 1} gentle start (region ${region + 1}): rocket team, drone, barrage and convoy wait 60 s`, early === 0 && tr.stats.rockets > 0,
    `by 55 s: ${early} launches; rocket after ${sec(w.frame)}`);
}

// ---------------------------------------------------------------- 3. mines
{
  const { w, tr, p } = world(301);
  clearStatics(tr);
  place(p, openSpot(w, 40, 40, 80, 20), UP);
  const a0 = p.armour;
  tr.mines.push({ x: p.cx, y: p.y - 24, alive: true, shown: false, decal: false, field: 0 }, { x: p.cx + 20, y: p.y - 30, alive: true, shown: false, decal: false, field: 0 });
  const log = run(w, 3 * 60, { dir: UP, fire: false }, () => tr.stats.minesHit > 0);
  check('m1 mine under a player tank: 3 armour + blast, field shown', tr.stats.minesHit === 1 && p.armour === a0 - TR.mineDmg && tr.mines[1].shown && log.notes.some((n) => n.text === 'MINEFIELD!'),
    `hit at ${sec(w.frame)}, armour ${a0} -> ${p.armour}, rest of the field shown: ${tr.mines[1].shown}`);
  const g = world(302);
  clearStatics(g.tr);
  place(g.p, openSpot(g.w, 40, 40, 80, 20), UP);
  g.p.fitted = { plough: 'farm-harrow' };
  const b0 = g.p.armour;
  g.tr.mines.push({ x: g.p.cx - 4, y: g.p.y - 24, alive: true, shown: false, decal: false, field: 0 }, { x: g.p.cx + 5, y: g.p.y - 40, alive: true, shown: false, decal: false, field: 0 });
  run(g.w, 3 * 60, { dir: UP, fire: false });
  check('m2 plough clears mines ahead safely', g.tr.stats.minesCleared === 2 && g.tr.stats.minesHit === 0 && g.p.armour === b0,
    `cleared ${g.tr.stats.minesCleared}, hit ${g.tr.stats.minesHit}, armour ${b0} -> ${g.p.armour}`);
  // enemy tanks know their own fields
  const e = g.w.players[0]!;
  const m = { x: 0, y: 0, alive: true, shown: false, decal: false, field: 1 };
  g.tr.mines.push(m);
  const enemy = Object.assign(Object.create(Object.getPrototypeOf(e)), { ...e, player: -1, x: 400, y: 400 }) as Tank;
  m.x = enemy.x + 8;
  m.y = enemy.y + 8;
  g.tr.moved(enemy);
  check('m3 enemy tanks do not set mines off', m.alive, `mine under an enemy tank still armed: ${m.alive}`);
}
{
  const { w, tr } = world(303);
  const sp = w.region!.playerSpawns[0];
  const inTown = tr.mines.filter((m) => w.towns.some((t) => m.x >= t.rect[0] && m.y >= t.rect[1] && m.x < t.rect[0] + t.rect[2] && m.y < t.rect[1] + t.rect[3])).length;
  const nearStart = tr.mines.filter((m) => Math.hypot(m.x - sp[0] - 8, m.y - sp[1] - 8) < 200).length;
  const onRoad = tr.mines.filter((m) => w.map.at(m.x >> 2, m.y >> 2) === ROAD).length;
  const fields = new Set(tr.mines.map((m) => m.field)).size;
  check('m4 region 1 minefields: on roads and fields, none in towns or near the start', fields >= 1 && fields <= TR.mineClusters[0] && inTown === 0 && nearStart === 0,
    `${tr.mines.length} mines in ${fields} fields (${onRoad} on roads), ${inTown} in towns, ${nearStart} near the start`);
}

// ---------------------------------------------------------------- 4. artillery
{
  const { w, tr, p } = world(401);
  clearStatics(tr);
  place(p, openSpot(w, 60, 60, 60, 60));
  const a0 = p.armour;
  tr.startBarrage(p.cx, p.cy, false);
  const b = tr.barrage!;
  // shell 0 right on the tank, the others well clear; a brick wall beside shell 1
  b.shells[0].x = p.cx;
  b.shells[0].y = p.cy;
  b.shells[1].x = p.cx + 40;
  b.shells[1].y = p.cy;
  for (let cy = (p.cy >> 2) - 1; cy <= (p.cy >> 2) + 1; cy++) w.map.set((p.cx + 46) >> 2, cy, BRICK);
  const appear = b.shells.map((s) => s.appear);
  const at = b.shells.map((s) => s.at);
  let firstDmg = -1;
  const log = run(w, 6 * 60, IDLE, () => {
    if (firstDmg < 0 && p.armour < a0) firstDmg = w.frame;
    return !tr.barrage;
  });
  const lead = Math.min(...at.map((t, i) => t - appear[i]));
  const whistles = log.ev.filter((e) => e.n === 'trick-whistle');
  check('a1 warning circles precede each impact by >= 1.5 s', lead >= 90 && firstDmg === at[0] && whistles.length === b.shells.length && whistles.every((wh, i) => at[i] - wh.f === TR.artWhistle),
    `${b.shells.length} circles, warning ${sec(lead)}, first damage at the first impact: ${firstDmg === at[0]}, whistles ${whistles.map((wh, i) => sec(at[i] - wh.f)).join(', ')} before impact`);
  check('a2 3 armour inside the radius only; brick knocked down', p.armour === a0 - TR.artDmg && tr.stats.artHits === 1 && tr.stats.bricks > 0,
    `armour ${a0} -> ${p.armour} (one shell on the tank, one 40 px off), ${tr.stats.bricks} brick cells down, radio: ${log.radio.map((r) => r.text).join(' | ')}`);
  // just outside the circle: untouched
  const g = world(402);
  clearStatics(g.tr);
  place(g.p, openSpot(g.w, 60, 60, 60, 60));
  const b0 = g.p.armour;
  g.tr.startBarrage(g.p.cx, g.p.cy, false);
  for (const s of g.tr.barrage!.shells) { s.x = g.p.cx + TR.artR + 1; s.y = g.p.cy; }
  run(g.w, 6 * 60, IDLE, () => !g.tr.barrage);
  check('a3 a tank just outside the circle is safe', g.p.armour === b0 && g.tr.stats.shells === g.tr.stats.barrages * (g.tr.tier >= 1 ? 3 : 2), `armour ${b0} -> ${g.p.armour} with every shell ${TR.artR + 1} px from the tank centre`);
  // never inside a town; one at a time
  const t = g.w.towns[0];
  const inTown = g.tr.startBarrage(t.cx, t.cy, false);
  g.tr.startBarrage(g.p.cx, g.p.cy, false);
  const second = g.tr.startBarrage(g.p.cx + 100, g.p.cy, false);
  check('a4 no barrage on a town, one at a time', !inTown && !second, `town barrage ${inTown}, second while one is up ${second}`);
}

// ---------------------------------------------------------------- 5. supply convoys
{
  const { w, tr, p } = world(501);
  clearStatics(tr);
  // park the player in a far corner so the convoy drives undisturbed
  place(p, [8, 8]);
  p.alive = true;
  const cv = tr.launchConvoy(true)!;
  let onRoad = 0;
  let samples = 0;
  let maxJump = 0;
  const pos = new Map<object, [number, number]>();
  const log = run(w, 3 * 60 * 60, IDLE, () => {
    for (const v of cv.vehicles) {
      if (!v.alive || !v.in) continue;
      const c = w.map.at((v.x + 8) >> 2, (v.y + 8) >> 2);
      samples++;
      if (c === ROAD) onRoad++;
      const q = pos.get(v);
      if (q) maxJump = Math.max(maxJump, Math.abs(q[0] - v.x) + Math.abs(q[1] - v.y));
      pos.set(v, [v.x, v.y]);
    }
    return !tr.convoy;
  });
  const esc = cv.vehicles[0];
  check('c1 convoy drives the roads from end to end', !!cv && tr.stats.convoysArrived === 1 && samples > 0 && onRoad / samples > 0.97 && maxJump <= TR.convoySpeed * 1.5 + 1e-6 && !!esc.tank
    && log.radio.some((r) => r.text.includes('SUPPLY RUN')),
    `${cv.from} -> ${cv.to}: ${cv.len} px, ${cv.vehicles.length - 1} trucks + escort (type ${esc.tank?.etype}), ${(100 * onRoad / Math.max(1, samples)).toFixed(1)}% of samples on road cells, arrived at ${sec(w.frame)}`);
  check('c2 escort was ours, gone at the end', !esc.tank!.alive && !tr.owns(esc.tank!) && !w.enemies.includes(esc.tank!), `escort alive ${esc.tank!.alive}`);
}
{
  const { w, tr, p } = world(502);
  clearStatics(tr);
  place(p, [8, 8]);
  const cv = tr.launchConvoy(true)!;
  run(w, 60 * 60, IDLE, () => cv.vehicles.every((v) => v.in));
  const scrap0 = w.pickups.filter((k) => k.kind === 'scrap' && k.amount === TR.truckScrap).length;
  let hits = 0;
  const notes: string[] = [];
  for (const v of cv.vehicles) {
    if (!v.truck) continue;
    const b = new Bullet(v.x + 8, v.y + 8, RIGHT, 3, p, false, false, 0);
    if (tr.bulletHit(b)) hits++;
    for (const n of w.notes) notes.push(n.text);
    w.notes.length = 0;
  }
  const scrap = w.pickups.filter((k) => k.kind === 'scrap' && k.amount === TR.truckScrap).length - scrap0;
  const parts = w.pickups.filter((k) => k.kind === 'part').length;
  const nTrucks = cv.vehicles.length - 1;
  check('c3 one hit per truck: +15 scrap each, maybe a part, CONVOY HIT once', hits === nTrucks && tr.stats.trucksKilled === nTrucks && scrap === nTrucks && notes.filter((n) => n === 'CONVOY HIT').length === 1,
    `${hits}/${nTrucks} trucks hit, ${scrap} scrap piles of ${TR.truckScrap}, ${parts} part crates, notes ${notes.join(',')}`);
  // the escort, alerted, turns on a player in its line
  const e = cv.vehicles[0].tank!;
  // a spot 48 px off in a direction with nothing solid in between
  let spot: [number, number] | null = null;
  for (let d = 0; d < 4 && !spot; d++) {
    const x = e.x + DX[d] * 48;
    const y = e.y + DY[d] * 48;
    if (w.map.solidForTank(x, y, false)) continue;
    let clear = true;
    for (let k = 4; k < 48; k += 2) {
      const c = w.map.at((e.cx + DX[d] * k) >> 2, (e.cy + DY[d] * k) >> 2);
      if (c === BRICK || c === STEEL) clear = false;
    }
    if (clear) spot = [x, y];
  }
  if (spot) place(p, spot);
  const shots0 = tr.stats.escortShots;
  run(w, 3 * 60, IDLE, () => tr.stats.escortShots > shots0 || !tr.convoy);
  check('c4 alerted escort fires on a player in line', tr.stats.escortShots > shots0 || !tr.convoy, `escort shots ${tr.stats.escortShots}, convoy ${tr.convoy ? 'on' : 'ended'}`);
}

// ---------------------------------------------------------------- 6. pacing over a played region
for (const seed of [601, 602, 603]) {
  const { w, tr } = world(seed);
  tr.auto = true;
  const bot = (ww: World) => regionBot(ww);
  // a minute before any town is freed: only teams and mines
  run(w, 60 * 60, bot, () => w.towns.some((t) => t.freed), true);
  const early = tr.stats.drones + tr.stats.barrages + tr.stats.convoys;
  if (!w.towns.some((t) => t.freed)) w.freeTown(w.towns[0]);
  const starts: number[] = [];
  const ends: number[] = [];
  let had = false;
  let maxAct = 0;
  const t0 = performance.now();
  const f0 = frames;
  run(w, 8 * 60 * 60, (ww) => {
    // keep the bot alive and in the fight so the tricks keep coming
    const pp = ww.players[0];
    if (pp && pp.armour < 4) pp.armour = pp.armourMax;
    for (const s of ww.ps) s.lives = 3;
    return bot(ww);
  }, () => {
    const up = !!tr.barrage;
    if (up && !had) starts.push(w.frame);
    if (!up && had) ends.push(w.frame);
    had = up;
    maxAct = Math.max(maxAct, tr.activeCount());
    return false;
  }, true);
  const ms = performance.now() - t0;
  const gaps = starts.slice(1).map((s, i) => s - ends[i]);
  const s = tr.stats;
  check(`p${seed - 600} pacing (region 1, 8 min after the first town)`, early === 0 && s.drones >= 2 && s.barrages >= 1 && s.convoys >= 1 && maxAct <= TR.maxActive && gaps.every((g) => g >= TR.artMinGap) && exceptions === 0,
    `before a town: ${early} launches | after: ${s.drones} drones (${s.spotters} spotters, ${s.drops} drops, ${s.bombHits} grenade hits, ${s.dronesDown} shot down, ${s.spotted} spotted), ` +
    `${s.barrages} barrages (gaps ${gaps.map((g) => sec(g)).join(', ') || '-'}; ${s.artHits} shell hits), ${s.convoys} convoys (${s.trucksKilled} trucks killed, ${s.convoysArrived} arrived), ` +
    `teams ${s.teams} (${s.rockets} rockets, ${s.rocketHits} hits, ${s.teamsKilled} killed), mines ${s.mines} (${s.minesHit} hit), most active at once ${maxAct} | ` +
    `tricks ${(s.msSum / s.n).toFixed(4)} ms/update avg, ${s.msMax.toFixed(2)} max, setup ${s.initMs.toFixed(1)} ms; world ${(ms / (frames - f0)).toFixed(3)} ms/update`);
}

// ---------------------------------------------------------------- 7. later regions and ease
{
  const { tr } = world(701, 3);
  const r4 = { teams: tr.teams.length, fields: new Set(tr.mines.map((m) => m.field)).size };
  const r1 = world(701, 0).tr;
  const g = world(702);
  g.w.ease = 0.3;
  clearStatics(g.tr);
  place(g.p, openSpot(g.w, 48, 120), UP);
  const team = { x: g.p.cx + 60, y: g.p.cy, dir: LEFT, alive: true, shown: false, tell: 0, reload: 0, aim: [0, 0] as [number, number], ruin: false, ammo: 2 };
  g.tr.teams.push(team);
  let tell = 0;
  run(g.w, 3 * 60, IDLE, () => { tell = Math.max(tell, team.tell); return tell > 0; });
  check('e1 later regions bring more; ease stretches the tells', r4.teams > r1.teams.length && tell === Math.round(TR.teamTell * 1.3) && tell <= 3,
    `region 4: ${r4.teams} teams, ${r4.fields} fields vs region 1: ${r1.teams.length}, ${new Set(r1.mines.map((m) => m.field)).size}; tell at ease 0.3: ${sec(tell)}`);
}

check('x no exceptions', exceptions === 0, `${exceptions} exceptions over ${frames} frames`);
console.log(`\n${fails ? `${fails} FAILED` : 'all passed'} (${frames} frames simulated)`);
if (fails) process.exitCode = 1;
