// Headless checks for the Region 2 and 3 bosses on hand-made test maps (src/game/bosses/testspec.ts: a farmland map
// with a railway, or with a wide river and two bridges), so they run before the real region generators exist:
// the armoured train (bosses/train.ts) and the river flagship (bosses/flagship.ts). Reveal, weak points and their
// rules, the train on its rails (reversing, the yard, shoving tanks), the flagship in its channel, warning times,
// the death firing once, region clear, perf, no exceptions.
// Run: npm run bosssim2
import { reseed } from './ai-sim-seed';
import { ABIL } from '../src/game/abilities';
import { regionBot as regionBotFn } from '../src/game/bot';
import { BOSS } from '../src/game/boss';
import { FLAG, type FlagshipBoss } from '../src/game/bosses/flagship';
import { railRiverTestSpec as bossTestSpec } from '../src/game/bosses/testspec';
import { TRAIN, type TrainBoss } from '../src/game/bosses/train';
import { DX, DY, EMPTY, RAIL, STEEL, WATER } from '../src/game/constants';
import { newRun } from '../src/game/run';
import { regionWorld } from '../src/game/save';
import { Bullet, newPState, type PInput, type PState, type Tank, type World } from '../src/game/world';

let fails = 0;
let exceptions = 0;
function check(name: string, ok: boolean, info = ''): void {
  if (!ok) fails++;
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${info ? `: ${info}` : ''}`);
}
const IDLE: PInput = { dir: -1, fire: false };

function world<B>(kind: 'train' | 'flagship', seed: number): { w: World; b: B; p: Tank } {
  reseed(seed);
  const run = newRun(seed);
  run.region = kind === 'train' ? 1 : 2;
  const ps: PState[] = [newPState(), newPState()];
  const w = regionWorld(run, ps, 1, 0, bossTestSpec(kind, seed + run.region));
  ps[0].lives = 9;
  w.update([IDLE]);
  const p = w.players[0]!;
  p.spawn = 0;
  return { w, b: w.boss as unknown as B, p };
}

const radio: string[] = [];
const notes: string[] = [];
function step(w: World, n: number, inp: PInput | ((w: World) => PInput) = IDLE, until?: () => boolean, each?: () => void): number {
  let i = 0;
  for (; i < n; i++) {
    try {
      w.update([typeof inp === 'function' ? inp(w) : inp]);
      each?.();
    } catch (e) {
      exceptions++;
      console.log('EXCEPTION', e);
      break;
    }
    for (const m of w.radio) radio.push(`${m.who}: ${m.text}`);
    for (const m of w.notes) notes.push(m.text);
    w.radio.length = 0;
    w.notes.length = 0;
    w.ev.length = 0;
    w.popups.length = 0;
    w.decals.length = 0;
    w.map.takeDirty();
    if (until?.()) break;
  }
  return i;
}

/** Director, tricks and every enemy off; the player shielded unless a test wants hits. */
function quiet(w: World, p: Tank): void {
  for (const e of w.enemies) e.alive = false;
  w.enemies.length = 0;
  w.bullets.length = 0;
  if (w.ai) w.ai.update = () => {};
  if (w.tricks) w.tricks.update = () => {};
  p.shield = 1e9;
}

function reveal(w: World, b: { state: string }): void {
  for (const t of w.towns.slice(0, 3)) w.freeTown(t);
  step(w, 31, IDLE, () => b.state !== 'hidden');
}

/** A player shell flying `dir` that starts 10 px before the point (x, y). */
function shell(w: World, owner: Tank, x: number, y: number, dir: number, n = 40): void {
  w.bullets.push(new Bullet(x - DX[dir] * 10, y - DY[dir] * 10, dir, 3, owner, false, false, 0));
  step(w, n, IDLE, () => !w.bullets.some((q) => q.owner === owner));
}

/** Clear brick/trees/steel round a rect (shots and lines of fire in the tests). */
function clearAround(w: World, x: number, y: number, ww: number, hh: number): void {
  for (let cy = Math.floor(y / 4); cy < (y + hh) / 4; cy++) {
    for (let cx = Math.floor(x / 4); cx < (x + ww) / 4; cx++) {
      const c = w.map.at(cx, cy);
      if (c !== WATER && c !== RAIL && c !== STEEL) w.map.set(cx, cy, EMPTY);
    }
  }
}

// =====================================================================================================
console.log('=== ARMOURED TRAIN ===');
console.log('--- test map and reveal ---');
{
  const spec = bossTestSpec('train', 41);
  const rail = spec.rail!;
  let onRail = 0;
  let n = 0;
  for (let k = 0; k + 1 < rail.length; k++) {
    const [ax, ay] = rail[k];
    const [bx, by] = rail[k + 1];
    const len = Math.hypot(bx - ax, by - ay);
    for (let s = 0; s <= len; s += 4) {
      const x = ax + ((bx - ax) * s) / len;
      const y = ay + ((by - ay) * s) / len;
      n++;
      if (spec.cells[Math.floor(y / 4) * spec.w + Math.floor(x / 4)] === RAIL) onRail++;
    }
  }
  check('test map: RAIL cells under the rail line', onRail === n, `${onRail}/${n}, ${rail.length} points`);
  const { w, b } = world<TrainBoss>('train', 41);
  check('region boss is the train, hidden', b.kind === 'train' && b.state === 'hidden' && !b.revealed);
  w.freeTown(w.towns[0]);
  w.freeTown(w.towns[1]);
  step(w, 60);
  check('2 towns freed: still hidden', b.state === 'hidden' && b.townsToReveal() === 1);
  radio.length = 0;
  notes.length = 0;
  w.freeTown(w.towns[2]);
  step(w, 40, IDLE, () => b.state !== 'hidden');
  check('3rd town freed: revealed in the yard', b.revealed && b.state === 'lair' && Math.abs(b.H - b.hYard) < 0.01);
  check('HQ names it and the place', radio.some((r) => r.startsWith('HQ:') && r.includes(b.name) && r.includes(b.lairNear)), radio.find((r) => r.startsWith('HQ')) ?? '');
  check('BOSS LOCATED toast, horn', notes.includes('BOSS LOCATED') && b.stats.horns >= 1);
  check(`yard escort of ${TRAIN.escort.length}`, b.stats.escorts === TRAIN.escort.length, `${b.stats.escorts}`);
  check('no tank under the train', !w.allTanks().some((t) => t.alive && b.overlaps(t.x, t.y, 16, 16)));
  check('wagons sit on the rail line', b.offRail() < 1, `${b.offRail().toFixed(2)} px`);
  check('the HUD core is the engine at parts[4], 5 wagons on the bar', b.parts[4] === b.turret && b.turret.short === 'ENGINE' && b.parts.length === 6);
  check('the train blocks tanks', (() => { const u = b.unitRect('aa')!; return w.blockedAt(w.players[0]!, u[0] + u[2] / 2 - 8, u[1] + u[3] / 2 - 8); })());
}

console.log('--- weak points ---');
{
  const { w, b, p } = world<TrainBoss>('train', 42);
  quiet(w, p);
  reveal(w, b);
  quiet(w, p);
  w.freeze = 1e9; // frozen: exact shots
  const part = (id: string) => b.parts.find((q) => q.id === id)!;
  const centre = (id: string) => { const r = b.unitRect(id)!; return [r[0] + r[2] / 2, r[1] + r[3] / 2]; };
  // shells across the wagon (perpendicular to the track)
  const across = (id: string) => { const u = b.units.find((q) => q.part.id === id)!; return u.d & 1 ? 2 : 1; };
  const hitCar = (id: string) => { const [x, y] = centre(id); const d = across(id); shell(w, p, x - DX[d] * 10, y - DY[d] * 10, d); };
  const E = b.turret;
  hitCar('engine');
  check('engine before the gun cars go: no pen', E.hp === E.max && b.stats.noPen === 1, `engine ${E.hp}/${E.max}`);
  b.droneHit(centre('engine')[0], centre('engine')[1], ABIL.fpvDmg, 0);
  check('a drone on the armoured engine: no damage', E.hp === E.max && b.stats.noPen === 2);
  hitCar('gun1');
  check('shell on gun car 1: -1', part('gun1').hp === TRAIN.hp.gun - 1);
  b.droneHit(centre('gun1')[0], centre('gun1')[1], ABIL.fpvDmg, 0);
  check('drone on gun car 1: double damage', part('gun1').hp === Math.max(0, TRAIN.hp.gun - 1 - ABIL.fpvDmg * BOSS.droneMul), `${part('gun1').hp}`);
  radio.length = 0;
  w.ai!.update = Object.getPrototypeOf(w.ai).update;
  hitCar('gun1');
  check('gun car 1 destroyed', part('gun1').hp === 0 && b.stats.partsLost === 1);
  check('it radios, a column is called', radio.some((r) => r.includes('GUN CAR 1 IS BURNING')) && b.stats.columns === 1, `columns ${b.stats.columns}`);
  w.ai!.update = () => {};
  for (const e of w.enemies) e.alive = false;
  hitCar('gun1');
  check('a wreck soaks shells, no damage anywhere', b.parts.reduce((a, q) => a + q.hp, 0) === TRAIN.hp.gun + TRAIN.hp.aa + TRAIN.hp.rockets + TRAIN.hp.supply + TRAIN.hp.engine);
  check('engine still locked with one gun car left', !b.exposed());
  for (let i = 0; i < 3; i++) b.droneHit(centre('gun2')[0], centre('gun2')[1], ABIL.fpvDmg, 0);
  check('gun car 2 destroyed: engine exposed', part('gun2').hp === 0 && b.exposed() && w.notes.some((n) => n.text === 'ENGINE EXPOSED'));
  hitCar('engine');
  check('exposed engine takes a shell', E.hp === E.max - 1);
  // supply car: scrap and a part beside the track
  const pk0 = w.pickups.length;
  for (let i = 0; i < TRAIN.hp.supply; i++) hitCar('supply');
  const spilled = w.pickups.slice(pk0);
  check('supply car spills 3 scrap and a part', part('supply').hp === 0 && spilled.filter((q) => q.kind === 'scrap').length === 3 && spilled.filter((q) => q.kind === 'part').length === 1);
  check('the spill lies off the track', spilled.every((q) => !b.overlaps(q.x - 4, q.y - 4, 8, 8)));
  // rockets from an ambush hit wagons too
  const rh = b.stats.rocketHits;
  const [ax, ay] = centre('aa');
  b.rocketHit(ax, ay, 1, ABIL.rocketDmg, 0);
  check('an ambush rocket damages the wagon it hits', b.stats.rocketHits === rh + 1 && part('aa').hp === TRAIN.hp.aa - ABIL.rocketDmg);
}

console.log('--- on the rails: yard, ends, horn, speed ---');
{
  const { w, b, p } = world<TrainBoss>('train', 43);
  quiet(w, p);
  reveal(w, b);
  quiet(w, p);
  p.x = 0; p.y = 0; // far away: it wakes by itself
  let worst = 0;
  let outside = 0;
  let minH = Infinity;
  let maxH = -Infinity;
  const t0 = performance.now();
  const frames = 60 * 60 * 4;
  step(w, frames, IDLE, undefined, () => {
    if (b.state === 'hunt') { worst = Math.max(worst, b.offRail()); minH = Math.min(minH, b.H); maxH = Math.max(maxH, b.H); }
    for (const u of b.units) if (u.rx < 0 || u.ry < 0 || u.rx + u.rw > w.pxW || u.ry + u.rh > w.pxH) outside++;
    p.x = 0; p.y = 0;
  });
  const per = (performance.now() - t0) / frames;
  check('wakes by itself after a while', b.state === 'hunt');
  check('follows the rail (wagon centres on the line)', worst < 1, `worst ${worst.toFixed(2)} px`);
  check('stays on the map', outside === 0, `${outside}`);
  check('runs the whole line', minH <= b.hMin + 0.5 && maxH >= b.hMax - 0.5, `H ${Math.round(minH)}..${Math.round(maxH)} of ${Math.round(b.hMin)}..${Math.round(b.hMax)}`);
  check('reverses at the ends', b.stats.reversals >= 2, `${b.stats.reversals}`);
  check('stops in the yard', b.stats.yardStops >= 2, `${b.stats.yardStops}`);
  check('horn when it sets off', b.stats.horns >= b.stats.reversals + b.stats.yardStops, `${b.stats.horns} horns, ${b.stats.reversals + b.stats.yardStops} departures`);
  check('perf: train update cost', b.stats.msSum / b.stats.n < 0.1 && b.stats.msMax < 4, `avg ${(b.stats.msSum / b.stats.n).toFixed(4)} ms, max ${b.stats.msMax.toFixed(2)} ms, ${per.toFixed(3)} ms per world update`);
}

console.log('--- a tank on the track ---');
{
  const { w, b, p } = world<TrainBoss>('train', 44);
  quiet(w, p);
  reveal(w, b);
  quiet(w, p);
  b.state = 'hunt';
  b.waitT = 0;
  for (const u of b.units) u.reload = 1e9;
  b.rocketReload = 1e9;
  // the player parked on the rail 60 px ahead of the engine
  const s = Math.min(b.H + 60, b.poly.len - 8);
  const [x, y] = b.poly.at(s);
  p.x = Math.round((x - 8) / 4) * 4;
  p.y = Math.round((y - 8) / 4) * 4;
  clearAround(w, p.x - 40, p.y - 40, 96, 96);
  p.shield = 0;
  p.armour = p.armourMax;
  b.dirS = 1;
  b.yardStopped = true;
  const horns = b.stats.horns;
  const a0 = p.armour;
  let under = 0;
  step(w, 60 * 12, IDLE, () => b.stats.pushes > 0 && b.H > s + 20, () => { if (b.overlaps(p.x + 1, p.y + 1, 14, 14)) under++; });
  check('horn and high beam when a player sits on the track ahead', b.stats.horns > horns, `${b.stats.horns - horns}`);
  check('the train shoves the tank off the track', b.stats.pushes >= 1 && !b.overlaps(p.x, p.y, 16, 16), `pushes ${b.stats.pushes}, H ${Math.round(b.H)} vs ${Math.round(s)}`);
  check(`shoving takes ${TRAIN.pushDmg} armour (once per ${TRAIN.pushGap} frames)`, a0 - p.armour === TRAIN.pushDmg, `${a0} -> ${p.armour}`);
  check('the tank is never left under a wagon', under === 0, `${under}`);
}

console.log('--- gun cars, AA and rockets ---');
{
  const { w, b, p } = world<TrainBoss>('train', 45);
  quiet(w, p);
  reveal(w, b);
  quiet(w, p);
  b.state = 'hunt';
  b.waitT = 1e9; // parked for exact shots
  b.rocketReload = 1e9;
  const g = b.units.find((u) => u.part.id === 'gun1')!;
  const side = (g.d + 1) & 3;
  p.x = Math.round(g.cx - 8 + DX[side] * 110);
  p.y = Math.round(g.cy - 8 + DY[side] * 110);
  clearAround(w, Math.min(p.x, g.rx) - 20, Math.min(p.y, g.ry) - 20, Math.abs(p.x - g.cx) + 60, Math.abs(p.y - g.cy) + 60);
  p.shield = 0;
  p.armour = p.armourMax;
  const stuck = [p.x, p.y];
  const keep = () => { p.x = stuck[0]; p.y = stuck[1]; if (p.armour < 5) p.armour = p.armourMax; };
  let glowAt = -1;
  let shotAt = -1;
  g.reload = 0;
  for (const u of b.units) if (u !== g) u.reload = 1e9;
  for (let i = 0; i < 400 && shotAt < 0; i++) {
    step(w, 1, IDLE, undefined, keep);
    if (glowAt < 0 && g.glow >= 0) glowAt = w.frame;
    if (b.stats.gunShots) shotAt = w.frame;
  }
  check('turret turns to the player and glows >= 1 s before the shot', glowAt > 0 && shotAt - glowAt >= TRAIN.gunGlow - 1, `glow @${glowAt}, shot @${shotAt}, tdir ${g.tdir} side ${side}`);
  check('radio intercept before the gun car fires', radio.some((r) => r.includes('TRAVERSE AND FIRE')));
  check('heavy shell in flight', w.bullets.some((q) => q.dmg === TRAIN.gunDmg));
  const a0 = p.armour;
  step(w, 100, IDLE, () => p.armour < a0, () => { p.x = stuck[0]; p.y = stuck[1]; });
  check(`gun car shell takes ${TRAIN.gunDmg} armour`, a0 - p.armour === TRAIN.gunDmg, `${a0} -> ${p.armour}`);
  // eased attempt: a longer tell
  w.ease = 0.3;
  g.reload = 0;
  b.gunClock = -1e9;
  glowAt = shotAt = -1;
  const shots = b.stats.gunShots;
  for (let i = 0; i < 400 && shotAt < 0; i++) {
    step(w, 1, IDLE, undefined, keep);
    if (glowAt < 0 && g.glow >= 0) glowAt = w.frame;
    if (b.stats.gunShots > shots) shotAt = w.frame;
  }
  check('ease 0.3: the tell is 30% longer', shotAt - glowAt >= Math.round(TRAIN.gunGlow * 1.3) - 1, `${shotAt - glowAt} frames`);
  w.ease = 0;
  // rocket salvo: warning marks >= 1.5 s before each lands
  for (const u of b.units) u.reload = 1e9;
  w.bullets.length = 0;
  b.rocketReload = 0;
  const r = b.units.find((u) => u.part.id === 'rockets')!;
  p.x = Math.round(r.cx - 8 + DX[side] * 120);
  p.y = Math.round(r.cy - 8 + DY[side] * 120);
  stuck[0] = p.x;
  stuck[1] = p.y;
  p.armour = p.armourMax;
  const appear: number[] = [];
  const landed: number[] = [];
  const seen = new Set<object>();
  step(w, 400, IDLE, () => b.barrage.stats.landed >= 3, () => {
    keep();
    for (const s of b.barrage.list) if (!seen.has(s)) { seen.add(s); appear.push(s.appear); landed.push(s.at); }
  });
  const minWarn = Math.min(...landed.map((t, i) => t - appear[i]));
  check('rocket salvo of 3', b.stats.salvos === 1 && appear.length === 3 && b.barrage.stats.landed === 3, `salvos ${b.stats.salvos}, ${appear.length} marks`);
  check('rocket marks show >= 1.5 s before impact', minWarn >= 90, `${minWarn} frames`);
  check('a rocket lands on the player who stays put', b.barrage.stats.hits >= 1, `${b.barrage.stats.hits} hits`);
  // AA: certain kill while the AA car stands, none once it is gone
  w.unlocked = [true, true, true, true];
  w.charges = [5, 0, 0, 2];
  const aa = b.units.find((u) => u.part.id === 'aa')!;
  const chance = TRAIN.aaChance;
  TRAIN.aaChance = 1;
  w.ease = 0; // (an eased region lowers the chance)
  w.abil!.fpvs.push({ pi: 0, sx: aa.cx + 80, sy: aa.cy, x: aa.cx + 80, y: aa.cy, z: 0, tx: aa.cx, ty: aa.cy, target: null, t: 0, dur: 50, dived: false });
  const hp0 = b.parts.reduce((a, q) => a + q.hp, 0);
  step(w, 70, IDLE, undefined, keep);
  check('the AA car shoots down a drone diving near it', b.stats.aaKills === 1 && b.parts.reduce((a, q) => a + q.hp, 0) === hp0, `kills ${b.stats.aaKills}`);
  b.droneHit(aa.cx, aa.cy, ABIL.fpvDmg, 0);
  check('AA car destroyed by a drone (6 >= 6)', aa.part.hp === 0);
  w.abil!.fpvs.push({ pi: 0, sx: aa.cx + 80, sy: aa.cy, x: aa.cx + 80, y: aa.cy, z: 0, tx: aa.cx, ty: aa.cy, target: null, t: 0, dur: 50, dived: false });
  step(w, 70, IDLE, undefined, keep);
  check('no AA once the AA car is gone', b.stats.aaKills === 1 && b.stats.droneHits >= 2);
  TRAIN.aaChance = chance;
}

console.log('--- death ---');
{
  const { w, b, p } = world<TrainBoss>('train', 46);
  quiet(w, p);
  reveal(w, b);
  quiet(w, p);
  const scrap0 = w.scrap;
  const found0 = w.found.length;
  radio.length = 0;
  for (const u of b.units) if (u.kind === 'gun') { u.part.hp = 1; b.droneHit(u.cx, u.cy, ABIL.fpvDmg, 0); }
  const e = b.engine;
  for (let i = 0; i < 2; i++) b.droneHit(e.cx, e.cy, ABIL.fpvDmg, 0);
  check('engine at 0 after the gun cars: dying', b.state === 'dying', `${b.state} engine ${e.part.hp}`);
  step(w, TRAIN.dieFrames + 5);
  check('final blast: dead, wrecks stay on the line', b.state === 'dead' && b.present && b.units.every((u) => u.part.hp === 0));
  check('death fired once', b.stats.deaths === 1 && w.stats.boss === 1);
  check('+scrap for the kill (and the gun cars)', w.scrap - scrap0 === TRAIN.scrap + 2 * BOSS.partScrap, `${w.scrap - scrap0}`);
  check('2 captured parts', w.found.length - found0 === BOSS.captured, `${w.found.length - found0}`);
  check('radio: HQ and the mechanic', radio.some((r) => r.startsWith('HQ:')) && radio.some((r) => r.startsWith('SPANNER:')));
  b.droneHit(e.cx, e.cy, ABIL.fpvDmg, 0);
  b.kill();
  step(w, 30);
  check('hits on the wreck do nothing more', b.stats.deaths === 1 && w.stats.boss === 1);
  const n = step(w, 600, IDLE, () => !!w.done);
  check('region clear follows', w.done === 'clear', `after ${n} frames`);
}

// =====================================================================================================
console.log('=== RIVER FLAGSHIP ===');
console.log('--- test map and reveal ---');
{
  const spec = bossTestSpec('flagship', 51);
  const river = spec.river!;
  let wet = 0;
  let n = 0;
  for (let k = 0; k + 1 < river.length; k++) {
    const [ax, ay] = river[k];
    const [bx, by] = river[k + 1];
    const len = Math.hypot(bx - ax, by - ay);
    for (let s = 0; s <= len; s += 4) {
      const x = Math.min(spec.w * 4 - 1, ax + ((bx - ax) * s) / len);
      const y = ay + ((by - ay) * s) / len;
      n++;
      const c = spec.cells[Math.floor(y / 4) * spec.w + Math.floor(x / 4)];
      if (c === WATER || c === 6) wet++;
    }
  }
  check('test map: water (or a bridge) under the river line', wet === n, `${wet}/${n}`);
  const { w, b } = world<FlagshipBoss>('flagship', 51);
  check('region boss is the flagship, hidden', b.kind === 'flagship' && b.state === 'hidden');
  radio.length = 0;
  notes.length = 0;
  reveal(w, b);
  check('3 towns freed: revealed at its berth', b.revealed && b.state === 'lair');
  check('HQ names it, says how to fight it', radio.some((r) => r.startsWith('HQ:') && r.includes(b.name) && r.includes('DRONES')));
  check('escort on the bank', b.stats.escorts >= 1, `${b.stats.escorts}`);
  check('the HUD core is the engine room at parts[4]', b.parts[4] === b.turret && b.turret.short === 'ENGINE');
  check('it does not block tanks (it passes under bridges)', !b.blocks(w.players[0]!, b.cx - 8, b.cy - 8));
}

/** The flagship revealed and quiet, the player parked on the bank `dist` px from its side. */
function flagSetup(seed: number, dist: number): { w: World; b: FlagshipBoss; p: Tank } {
  const r = world<FlagshipBoss>('flagship', seed);
  const { w, b, p } = r;
  quiet(w, p);
  reveal(w, b);
  quiet(w, p);
  // mid-river, away from the map edges
  const bb = b as unknown as { place: () => void; wantDir: () => number };
  b.S = Math.round(b.poly.len / 2);
  b.dir = bb.wantDir();
  bb.place();
  parkBank(w, b, p, dist);
  return r;
}

/** The player on dry land straight across from the flagship's centre, at least `dist` px away. */
function parkBank(w: World, b: FlagshipBoss, p: Tank, dist: number): boolean {
  const [tx, ty] = b.poly.tangent(b.S);
  for (const s of [1, -1]) {
    const nx = Math.round(-ty * s);
    const ny = Math.round(tx * s);
    for (let r = dist; r < dist + 80; r += 4) {
      const x = Math.round((b.cx + nx * r - 8) / 4) * 4;
      const y = Math.round((b.cy + ny * r - 8) / 4) * 4;
      if (x < 0 || y < 0 || x > w.pxW - 16 || y > w.pxH - 16) break;
      if (w.map.any(x, y, 16, 16, (c) => c === WATER)) continue;
      clearAround(w, x - 4, y - 4, 24, 24);
      p.x = x;
      p.y = y;
      p.dir = domDirOf(b.cx - p.cx, b.cy - p.cy);
      return true;
    }
  }
  return false;
}
const domDirOf = (dx: number, dy: number) => (Math.abs(dx) >= Math.abs(dy) ? (dx < 0 ? 3 : 1) : dy < 0 ? 0 : 2);

console.log('--- weak points and reach ---');
{
  const { w, b, p } = flagSetup(52, 40);
  w.freeze = 1e9;
  const part = (id: string) => b.parts.find((q) => q.id === id)!;
  const ctr = (id: string) => { const r = b.partRect(part(id)); return [r[0] + r[2] / 2, r[1] + r[3] / 2]; };
  const sideDir = domDirOf(b.cx - p.cx, b.cy - p.cy);
  /** a shell from the player's side of the river into part `id`, fired by `owner` standing `from` px away */
  const into = (id: string, from: number) => {
    const [x, y] = ctr(id);
    const save = [p.x, p.y];
    p.x = Math.round(x - 8 - DX[sideDir] * from);
    p.y = Math.round(y - 8 - DY[sideDir] * from);
    const [bx, by] = [b.bx, b.by];
    const ex = sideDir === 1 ? bx : sideDir === 3 ? bx + b.bw : x;
    const ey = sideDir === 2 ? by : sideDir === 0 ? by + b.bh : y;
    shell(w, p, ex, ey, sideDir);
    [p.x, p.y] = save;
  };
  const sum = () => b.parts.reduce((a, q) => a + q.hp, 0);
  const s0 = sum();
  into('fwd', 200);
  check('a shell from 200 px across the water falls short', b.stats.short === 1 && sum() === s0, `short ${b.stats.short}`);
  into('fwd', 60);
  check('from the near bank it hits the forward gun', part('fwd').hp === FLAG.hp.gun - 1, `${part('fwd').hp}`);
  // the engine room from astern while closed: the deck gun is fine, so it is armoured
  const E = b.turret;
  const [ex, ey] = ctr('engine');
  const astern = (b.dir + 2) & 3;
  const back = (b.dir) & 3; // a shell flying forward hits the stern first
  const [sx, sy] = b.toWorld(12, 47.5);
  p.x = Math.round(sx - 8 - DX[back] * 60);
  p.y = Math.round(sy - 8 - DY[back] * 60);
  shell(w, p, sx - DX[back] * 2, sy - DY[back] * 2, back);
  check('engine room from astern before a deck gun goes: no pen', E.hp === E.max && b.stats.noPen >= 1, `engine ${E.hp}, noPen ${b.stats.noPen}, astern ${astern}`);
  b.droneHit(ex, ey, ABIL.fpvDmg, 0);
  check('a drone reaches the engine room through the deck (double damage)', E.hp === E.max - ABIL.fpvDmg * BOSS.droneMul, `${E.hp}`);
  // knock out the forward gun: the engine room opens
  radio.length = 0;
  w.ai!.update = Object.getPrototypeOf(w.ai).update;
  for (let i = 0; i < 12 && part('fwd').hp > 0; i++) into('fwd', 60);
  check('forward gun destroyed: engine room exposed, column called', part('fwd').hp === 0 && b.exposed() && b.stats.columns === 1);
  w.ai!.update = () => {};
  for (const e of w.enemies) e.alive = false;
  const e0 = E.hp;
  p.x = Math.round(sx - 8 - DX[back] * 60);
  p.y = Math.round(sy - 8 - DY[back] * 60);
  shell(w, p, sx - DX[back] * 2, sy - DY[back] * 2, back);
  check('exposed engine room takes a shell from astern', E.hp === e0 - 1, `${e0} -> ${E.hp}`);
  // the bridge: its loss takes the MG with it
  for (let i = 0; i < 3; i++) b.droneHit(ctr('bridge')[0], ctr('bridge')[1] + 0, ABIL.fpvDmg, 0);
  check('drones on the bridge: MG first (on its roof), then the bridge', part('mg').hp === 0, `mg ${part('mg').hp} bridge ${part('bridge').hp}`);
  for (let i = 0; i < 2; i++) b.droneHit(ctr('bridge')[0], ctr('bridge')[1] + 0, ABIL.fpvDmg, 0);
  check('bridge destroyed', part('bridge').hp === 0 && !b.bridgeUp);
}

console.log('--- deck MG against FPV drones ---');
{
  const { w, b } = flagSetup(57, 60);
  b.state = 'hunt';
  b.sail = () => {};
  const chance = FLAG.aaChance;
  FLAG.aaChance = 1;
  const E = b.turret;
  const mg = b.parts.find((q) => q.id === 'mg')!;
  const dive = () => {
    const r = b.partRect(E);
    const [tx, ty] = [r[0] + r[2] / 2, r[1] + r[3] / 2];
    w.abil!.fpvs.push({ pi: 0, sx: tx + 80, sy: ty, x: tx + 80, y: ty, z: 0, tx, ty, target: null, t: 0, dur: 50, dived: false });
    step(w, 70);
  };
  const hp0 = b.parts.reduce((a, q) => a + q.hp, 0);
  radio.length = 0;
  w.ease = 0; // (an eased region lowers the chance)
  dive();
  check('the deck MG shoots down a drone diving on the ship', b.stats.aaKills === 1 && b.parts.reduce((a, q) => a + q.hp, 0) === hp0, `kills ${b.stats.aaKills}`);
  check('the drone operator says to kill the MG', radio.some((r) => r.startsWith('WASP:') && r.includes('MG')));
  mg.hp = 0;
  dive();
  check('no AA once the deck MG is gone: the drone hits', b.stats.aaKills === 1 && b.stats.droneHits === 1 && b.parts.reduce((a, q) => a + q.hp, 0) < hp0, `engine ${E.hp}/${E.max}`);
  FLAG.aaChance = chance;
}

console.log('--- shelling the banks ---');
{
  const { w, b, p } = flagSetup(53, 70);
  b.state = 'hunt';
  b.mode = 'patrol';
  b.reload = 0;
  p.shield = 0;
  p.armour = p.armourMax;
  const stuck = [p.x, p.y];
  const keep = () => { p.x = stuck[0]; p.y = stuck[1]; if (p.armour < 4) p.armour = p.armourMax; };
  const seen = new Map<object, [number, number, number, number]>();
  step(w, 60 * 8, IDLE, () => b.barrage.stats.landed >= 4, () => {
    keep();
    for (const s of b.barrage.list) if (!seen.has(s)) seen.set(s, [s.appear, s.at, s.x, s.y]);
    b.mg.t = 1e9; // the MG would shred the test's still player
  });
  const marks = [...seen.values()];
  const warn = Math.min(...marks.map(([a, t]) => t - a));
  const first = marks[0];
  check('it anchors to shell a player on the bank', b.stats.anchors >= 1 && b.stats.salvos === 1, `anchors ${b.stats.anchors}`);
  check(`${FLAG.perGun * 2} rounds, one per mark`, marks.length === FLAG.perGun * 2 && b.barrage.stats.landed === marks.length, `${marks.length} marks, ${b.barrage.stats.landed} landed`);
  check('warning rings >= 1.5 s before impact', warn >= 90, `${warn} frames`);
  check('the first round is aimed at the player', !!first && Math.hypot(first[2] - p.cx, first[3] - p.cy) < 2, first ? `${Math.round(first[2] - p.cx)},${Math.round(first[3] - p.cy)}` : '');
  check(`a round that lands on the player takes ${FLAG.shellDmg} armour`, b.barrage.stats.hits >= 1, `${b.barrage.stats.hits} hits`);
  check('it moves on after the salvo', (() => { step(w, FLAG.after + 120, IDLE, () => b.mode === 'patrol', keep); return b.mode === 'patrol'; })());
  // blind: no round on the player once the bridge is gone
  for (const q of b.parts) if (q.id === 'mg') q.hp = 0;
  for (const q of b.parts) if (q.id === 'bridge') { q.hp = 1; b.droneHit(...(() => { const r = b.partRect(q); return [r[0] + r[2] / 2, r[1] + r[3] / 2] as [number, number]; })(), ABIL.fpvDmg, 0); }
  b.reload = 0;
  b.mode = 'patrol';
  seen.clear();
  const l0 = b.barrage.stats.landed;
  step(w, 60 * 8, IDLE, () => b.barrage.stats.landed >= l0 + 2, () => { keep(); for (const s of b.barrage.list) if (!seen.has(s)) seen.set(s, [s.appear, s.at, s.x, s.y]); });
  const blind = [...seen.values()];
  check('bridge gone: the shelling is blind (no round on the player)', !b.bridgeUp && blind.length > 0 && blind.every(([, , x, y]) => Math.hypot(x - p.cx, y - p.cy) >= FLAG.blindSpread[0] - 1), `${blind.length} rounds`);
}

console.log('--- ambush squads on the bank ---');
{
  const { w, b, p } = flagSetup(54, 40);
  w.freeze = 1e9;
  const sideDir = domDirOf(b.cx - p.cx, b.cy - p.cy);
  // a squad on the bank in line with the hull's middle
  const sx = Math.round(sideDir & 1 ? p.cx : b.cx);
  const sy = Math.round(sideDir & 1 ? b.cy : p.cy);
  w.abil!.squads.push({ pi: 0, x: sx, y: sy, dir: sideDir, rockets: ABIL.rockets, reload: 0, t: 0, leaving: 0, sprung: false, spot: 0, fired: 999 });
  p.x = 0; p.y = 0;
  const sum = () => b.parts.reduce((a, q) => a + q.hp, 0);
  const s0 = sum();
  w.freeze = 0;
  b.mode = 'berth';
  b.state = 'lair';
  b.v = 0;
  (b as unknown as { sail: () => void }).sail = () => {}; // hold still in the squad's line
  step(w, 200, IDLE, () => b.stats.rocketHits >= 2);
  check('an ambush squad on the bank fires at the flagship', w.abil!.stats.rocketsFired >= 1, `${w.abil!.stats.rocketsFired} rockets, squad at ${sx},${sy} dir ${sideDir}`);
  check('its rockets hurt the flagship', b.stats.rocketHits >= 1 && sum() < s0, `hits ${b.stats.rocketHits}, hp ${s0} -> ${sum()}`);
}

console.log('--- patrol: stays in its channel ---');
{
  const { w, b, p } = flagSetup(55, 60);
  p.x = 0; p.y = 0;
  b.state = 'hunt';
  b.mode = 'patrol';
  let minS = Infinity;
  let maxS = -Infinity;
  const t0 = performance.now();
  const frames = 60 * 60 * 3;
  step(w, frames, IDLE, undefined, () => { minS = Math.min(minS, b.S); maxS = Math.max(maxS, b.S); p.x = 0; p.y = 0; });
  const per = (performance.now() - t0) / frames;
  check('never off the water', b.stats.offWater === 0, `${b.stats.offWater} frames`);
  check('patrols the whole river, turning round at the ends', minS <= b.sMin + 0.5 && maxS >= b.sMax - 0.5 && b.stats.turns >= 2, `S ${Math.round(minS)}..${Math.round(maxS)} of ${Math.round(b.sMin)}..${Math.round(b.sMax)}, turns ${b.stats.turns}`);
  check('perf: flagship update cost', b.stats.msSum / b.stats.n < 0.1 && b.stats.msMax < 4, `avg ${(b.stats.msSum / b.stats.n).toFixed(4)} ms, max ${b.stats.msMax.toFixed(2)} ms, ${per.toFixed(3)} ms per world update`);
}

console.log('--- sinking ---');
{
  const { w, b, p } = flagSetup(56, 60);
  const scrap0 = w.scrap;
  const found0 = w.found.length;
  radio.length = 0;
  notes.length = 0;
  for (let i = 0; i < 8 && b.alive; i++) b.droneHit(...(() => { const r = b.partRect(b.turret); return [r[0] + r[2] / 2, r[1] + r[3] / 2] as [number, number]; })(), ABIL.fpvDmg, 0);
  check('engine room at 0: sinking', b.state === 'dying' && w.notes.some((n) => n.text.includes('SINKING')), `${b.state} ${b.turret.hp}`);
  step(w, FLAG.dieFrames + 5);
  check('sunk: a wreck, no longer in the way', b.state === 'dead' && b.present && !b.overlaps(b.cx - 2, b.cy - 2, 4, 4));
  check('death fired once', b.stats.deaths === 1 && w.stats.boss === 1);
  check(`+${FLAG.scrap} scrap, 2 captured parts`, w.scrap - scrap0 === FLAG.scrap && w.found.length - found0 === BOSS.captured, `${w.scrap - scrap0}, ${w.found.length - found0}`);
  b.kill();
  b.droneHit(b.cx, b.cy, ABIL.fpvDmg, 0);
  step(w, 30);
  check('nothing more after death', b.stats.deaths === 1 && w.stats.boss === 1);
  const n = step(w, 600, IDLE, () => !!w.done);
  check('region clear follows', w.done === 'clear', `after ${n} frames`);
  void p;
}

console.log('--- the real regions (save.ts regionWorld: Rail Junction and River Delta), 4 min each ---');
for (const seed of [71, 72, 73]) {
  for (const region of [1, 2]) {
    reseed(seed);
    const run = newRun(seed);
    run.region = region;
    const ps: PState[] = [newPState(), newPState()];
    const w = regionWorld(run, ps, 1);
    ps[0].lives = 9;
    w.update([IDLE]);
    const p = w.players[0]!;
    p.spawn = 0;
    const b = w.boss!;
    const kind = region === 1 ? 'train' : 'flagship';
    check(`${kind} ${seed}: the region's boss is the ${kind}`, b.kind === kind && !!(region === 1 ? w.region!.rail : w.region!.river), `${b.kind}`);
    quiet(w, p);
    reveal(w, b);
    p.x = 0; p.y = 0;
    (b as { state: string }).state = 'hunt';
    let worst = 0;
    step(w, 60 * 240, IDLE, undefined, () => {
      p.x = 0; p.y = 0;
      if (kind === 'train') worst = Math.max(worst, (b as unknown as TrainBoss).offRail());
    });
    if (kind === 'train') {
      const t = b as unknown as TrainBoss;
      const [yx, yy] = t.poly.at(t.hYard - t.length / 2);
      check(`train ${seed}: on the rail, runs and reverses, yard by the sidings`, worst < 1 && t.stats.reversals >= 1 && t.stats.yardStops >= 1,
        `off ${worst.toFixed(2)} px, reversals ${t.stats.reversals}, yard stops ${t.stats.yardStops}, yard at ${Math.round(yx)},${Math.round(yy)} (line ${Math.round(t.poly.len)} px), blocked ${t.stats.blockedFrames} frames`);
    } else {
      const f = b as unknown as FlagshipBoss;
      check(`flagship ${seed}: stays on the water and patrols`, f.stats.offWater === 0 && f.stats.turns >= 1, `off water ${f.stats.offWater}, turns ${f.stats.turns}, S ${Math.round(f.S)} of ${Math.round(f.poly.len)}`);
    }
    check(`${kind} ${seed}: no exceptions`, exceptions === 0);
  }
}

console.log('--- region bot on both test maps (towns 1-3 freed, 2 drones, 6 min) ---');
for (const kind of ['train', 'flagship'] as const) {
  for (const seed of [61, 62]) {
    const { w, b } = world<TrainBoss | FlagshipBoss>(kind, seed);
    w.unlocked = [true, false, false, true];
    w.charges = [2, 0, 0, 3];
    w.ps[0].lives = 4;
    for (const t of w.towns.slice(0, 3)) w.freeTown(t);
    let upd = 0;
    let updMax = 0;
    let f = 0;
    const bot = (ww: World) => regionBotFn(ww);
    while (!w.done && f < 60 * 360) {
      const t0 = performance.now();
      step(w, 1, bot);
      const dt = performance.now() - t0;
      upd += dt;
      updMax = Math.max(updMax, dt);
      f++;
    }
    const lost = b.parts.filter((q) => q.hp <= 0).length;
    console.log(`${kind} seed ${seed}: ${w.done || 'timeout'}@${Math.round(f / 60)}s boss ${b.state} parts lost ${lost}/${b.parts.length}`
      + ` | shells ${b.stats.shellHits} (no pen ${b.stats.noPen}) drones ${b.stats.droneHits} | boss fired: guns ${'gunShots' in b.stats ? b.stats.gunShots : b.stats.shellsFired}`
      + ` mg ${b.stats.mgShots} salvos ${b.stats.salvos} (${b.barrage.stats.hits} hits)${'pushes' in b.stats ? ` pushes ${b.stats.pushes}` : ''}`
      + ` | player hits ${w.stats.hits} knockouts ${w.stats.knockouts} enemies alive ${w.enemies.length} | update avg ${(upd / f).toFixed(3)} ms max ${updMax.toFixed(1)} ms`);
    check(`${kind} ${seed}: no exceptions with the region bot`, exceptions === 0);
  }
}

check('no exceptions', exceptions === 0, String(exceptions));
console.log(fails ? `boss sim 2: ${fails} FAILED` : 'boss sim 2: all checks pass');
process.exit(fails ? 1 : 0);
