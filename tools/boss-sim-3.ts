// Headless checks for the Region 4 and 5 bosses (src/game/bosses/heli.ts, final.ts) on the hand-made test maps
// (src/game/bosses/testmaps.ts): the helicopter flies over walls, shells only reach it low, pods / tail / engine
// damage order, its tells come before its attacks, the crash fires once; the final fight's stages run in order,
// the victory flag is set once, the region clears; no exceptions; update cost.
// Run: npm run bosssim3
import { reseed } from './ai-sim-seed';
import { ABIL } from '../src/game/abilities';
import { BRICK, DX, DY, STEEL } from '../src/game/constants';
import { Flow } from '../src/game/map';
import { HELI, type HeliBoss } from '../src/game/bosses/heli';
import { FINAL, type FinalBoss } from '../src/game/bosses/final';
import { finalTestRegion, heliTestRegion } from '../src/game/bosses/testmaps';
import { regionReach } from '../src/game/region';
import { Bullet, World, newPState, type PInput, type Tank } from '../src/game/world';
import { BOSS } from '../src/game/boss';

let fails = 0;
let exceptions = 0;
function check(name: string, ok: boolean, info = ''): void {
  if (!ok) fails++;
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${info ? `: ${info}` : ''}`);
}
const IDLE: PInput = { dir: -1, fire: false };
const radio: string[] = [];
const notes: string[] = [];

function step(w: World, n: number, inp: PInput | ((w: World) => PInput) = IDLE, until?: () => boolean): number {
  let i = 0;
  for (; i < n; i++) {
    try {
      w.update([typeof inp === 'function' ? inp(w) : inp]);
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

function world(kind: 'heli' | 'final', seed: number): { w: World; p: Tank } {
  reseed(seed);
  const ps = [newPState(), newPState()];
  ps[0].lives = 9;
  const w = new World(kind === 'heli' ? 4 : 5, ps, 1, kind === 'heli' ? heliTestRegion() : finalTestRegion());
  w.update([IDLE]);
  const p = w.players[0]!;
  p.spawn = 0;
  return { w, p };
}

/** Free the first three towns and step until the boss shows itself. */
function reveal(w: World): void {
  for (const t of w.towns.slice(0, 3)) w.freeTown(t);
  step(w, 40, IDLE, () => w.boss!.state !== 'hidden');
}

/** No enemies or tricks, the player shielded. */
function quiet(w: World, p: Tank): void {
  for (const e of w.enemies) e.alive = false;
  w.enemies.length = 0;
  w.bullets.length = 0;
  if (w.ai) w.ai.update = () => {};
  if (w.tricks) w.tricks.update = () => {};
  p.shield = 1e9;
}

/** A player shell fired from 10 px outside (x, y), travelling d. */
function shell(w: World, owner: Tank, x: number, y: number, d: number): void {
  w.bullets.push(new Bullet(x - DX[d] * 10, y - DY[d] * 10, d, 3, owner, false, false, 0));
}

// =============================================================================================================
console.log('--- test maps ---');
{
  for (const [n, spec] of [['heli', heliTestRegion()], ['final', finalTestRegion()]] as const) {
    const r = regionReach(spec);
    check(`${n} test map: spawns reachable`, r.ok, JSON.stringify(r.unreachable));
  }
}

console.log('--- helicopter: reveal ---');
{
  const { w } = world('heli', 31);
  const h = w.boss as unknown as HeliBoss;
  check('a heli on the heli map, hidden', h.kind === 'heli' && h.state === 'hidden');
  w.freeTown(w.towns[0]);
  w.freeTown(w.towns[1]);
  step(w, 60);
  check('2 towns: still hidden', h.state === 'hidden' && h.townsToReveal() === 1);
  radio.length = 0;
  notes.length = 0;
  w.freeTown(w.towns[2]);
  step(w, 40, IDLE, () => h.state !== 'hidden');
  check('3rd town: on its pad', h.state === 'lair' && h.alt === 0 && h.revealed);
  check('HQ radios it in and explains the rule', radio.some((r) => r.startsWith('HQ:') && r.includes('VULTURE') && r.includes('LOW')), radio[0] ?? '');
  check('BOSS LOCATED toast', notes.includes('BOSS LOCATED'));
  check('pad far from the start', Math.hypot(h.cx - w.players[0]!.cx, h.cy - w.players[0]!.cy) > 200, `${Math.round(h.cx)},${Math.round(h.cy)}`);
}

console.log('--- helicopter: flight over walls ---');
{
  const { w, p } = world('heli', 32);
  const h = w.boss as unknown as HeliBoss;
  reveal(w);
  quiet(w, p);
  h.reveal();
  // wake it with the player close, then make it cruise across the whole map
  p.x = Math.round((h.cx - 8 - 120) / 8) * 8;
  p.y = Math.round((h.cy - 8) / 8) * 8;
  let overWall = 0;
  let over = 0;
  let minAlt = 1;
  const t0 = performance.now();
  step(w, 60 * 40, () => {
    // the player hops round the map so it chases across the ruins
    if (w.frame % 600 === 0) {
      const sp = w.freeSpotNear((w.frame * 97) % (w.pxW - 32), (w.frame * 61) % (w.pxH - 32));
      if (sp) [p.x, p.y] = sp;
    }
    if (w.map.any(h.cx - 4, h.cy - 4, 8, 8, (c) => c === BRICK || c === STEEL || c === 3)) overWall++;
    over++;
    minAlt = Math.min(minAlt, h.alt);
    return IDLE;
  });
  check('woke and hunts', h.state === 'hunt', h.mode);
  check('flew over walls and water', overWall > 30, `${overWall}/${over} frames over brick/steel/water`);
  check('blocks() is always false', !h.blocks(p, h.x + 16, h.y + 16));
  check('it came down low to attack', minAlt <= HELI.low, `min alt ${minAlt.toFixed(2)}`);
  check('it attacked (strafes / salvos / pop-ups)', h.stats.strafes + h.stats.salvos + h.stats.pops >= 3, `strafes ${h.stats.strafes} salvos ${h.stats.salvos} pops ${h.stats.pops} rockets ${h.stats.rockets}`);
  check('heli update cost', h.stats.msSum / h.stats.n < 0.1 && h.stats.msMax < 4, `avg ${(h.stats.msSum / h.stats.n).toFixed(4)} ms, max ${h.stats.msMax.toFixed(2)} ms, ${((performance.now() - t0) / (60 * 40)).toFixed(3)} ms per world update`);
}

console.log('--- helicopter: shells only when low; damage order ---');
{
  const { w, p } = world('heli', 33);
  const h = w.boss as unknown as HeliBoss;
  reveal(w);
  quiet(w, p);
  w.freeze = 1e9; // it holds still (the clock): exact shots
  h.state = 'hunt';
  h.dir = 0;
  const part = (id: string) => h.parts.find((q) => q.id === id)!;
  const at = (id: string) => { const [x, y, ww, hh] = h.partRect(part(id)); return [x + ww / 2, y + hh / 2]; };
  const fire = (x: number, y: number, d: number) => { shell(w, p, x, y, d); step(w, 12, IDLE, () => !w.bullets.length); w.bullets.length = 0; };
  // high: a shell aimed at the left pod passes under it
  h.alt = 1;
  let [x, y] = at('podL');
  fire(x, y, 1);
  check('high: shell passes beneath', part('podL').hp === HELI.hp.pod && h.stats.shellsUnder >= 1, `under ${h.stats.shellsUnder}`);
  h.alt = HELI.altAttack;
  fire(x, y, 1);
  check('low: shell hits the left pod', part('podL').hp === HELI.hp.pod - 1);
  // the engine before the tail is gone: no pen
  [x, y] = at('engine');
  const e0 = part('engine').hp;
  fire(x, y + 4, 0);
  check('engine protected while the tail rotor turns', part('engine').hp === e0 && h.stats.noPen >= 1, `noPen ${h.stats.noPen}`);
  // ambush rockets: only when low
  h.alt = 1;
  const r0 = part('podR').hp;
  [x, y] = at('podR');
  check('ambush rocket misses it high', !h.rocketHit(x, y, 1, ABIL.rocketDmg, 0) && part('podR').hp === r0);
  h.alt = HELI.altAttack;
  check('ambush rocket hits it low', h.rocketHit(x, y, 1, ABIL.rocketDmg, 0) && part('podR').hp === r0 - ABIL.rocketDmg);
  // a drone that got past the flares (droneHit itself; the flares judge it on the way in, see the flares block)
  h.alt = 1;
  const p1 = part('podR').hp;
  check('a drone that gets through does HELI.droneDmg', h.droneHit(x, y, ABIL.fpvDmg, 0) && part('podR').hp === Math.max(0, p1 - HELI.droneDmg), `${p1} -> ${part('podR').hp}`);
  check('right pod destroyed', part('podR').hp === 0);
  // finish the left pod: no rockets left, attacks are strafes only
  h.alt = HELI.altAttack;
  [x, y] = at('podL');
  for (let i = 0; i < 3; i++) fire(x, y, 1);
  check('left pod destroyed (4 shells)', part('podL').hp === 0);
  const picks = new Set<string>();
  for (let i = 0; i < 20; i++) {
    h.mode = 'cruise';
    (h as unknown as { pickAttack(a: [number, number]): void }).pickAttack([p.cx, p.cy]);
    picks.add(h.mode);
  }
  check('no pods: it only strafes', picks.size === 1 && picks.has('strafeGo'), [...picks].join());
  // the tail rotor: 6 shells; then it spins and the engine is open
  h.mode = 'recover';
  h.strafe = null;
  [x, y] = at('tail');
  for (let i = 0; i < 6; i++) fire(x, y, 3);
  check('tail rotor destroyed', part('tail').hp === 0, `${part('tail').hp}`);
  check('tail gone: spinning, erratic, engine exposed', h.mode === 'spin' && h.erratic && h.exposed());
  [x, y] = at('engine');
  fire(x, y, 0);
  check('engine takes shells now', part('engine').hp === HELI.hp.engine - 1, `${part('engine').hp}`);
  check('HUD order: pods, tail, then the engine as the core', h.parts.map((q) => q.short).join() === 'POD,POD,TAIL,ENGINE' && h.turret.id === 'engine');
}

console.log('--- helicopter: flares against FPV drones ---');
{
  const { w, p } = world('heli', 36);
  const h = w.boss as unknown as HeliBoss;
  reveal(w);
  quiet(w, p);
  w.freeze = 1e9; // it holds still (the clock)
  h.state = 'hunt';
  h.dir = 0;
  (w as unknown as { allAbilities: boolean }).allAbilities = true;
  w.charges[0] = 6;
  // the player 90 px below it, facing it: a tap sends the drone at its weakest part
  p.x = Math.round((h.cx - 8) / 8) * 8;
  p.y = Math.round((h.cy + 90) / 8) * 8;
  p.dir = 0;
  const ab = w.abil!;
  const hp = () => h.parts.reduce((a, q) => a + q.hp, 0);
  const tap = () => {
    step(w, 1, { dir: -1, fire: false, ability: 1 });
    step(w, 200, IDLE, () => !ab.fpvs.length);
  };
  radio.length = 0;
  notes.length = 0;
  // high (cruising): decoyed
  h.mode = 'cruise';
  h.alt = 1;
  let hp0 = hp();
  check('high: a drone launched now would not get through', !h.droneOpen());
  tap();
  check('high: flares decoy the drone, no damage', h.stats.decoys === 1 && ab.stats.fpvLost === 1 && hp() === hp0 && h.stats.droneHits === 0, `decoys ${h.stats.decoys}, lost ${ab.stats.fpvLost}, hp ${hp0} -> ${hp()}`);
  check('the charge is spent', w.charges[0] === 5, `${w.charges[0]}`);
  check('the player is told why: toast and the drone operator', notes.some((n) => n.includes('FLARES')) && radio.some((r) => r.startsWith('WASP:') && r.includes('FLARES')), notes.filter((n) => n.includes('FLARE')).join(' | '));
  check('flares in the air', h.flares.length > 0 || h.stats.decoys === 1);
  // low (hanging after an attack): the first drone gets through, double damage, and it starts dumping flares
  h.mode = 'recover';
  h.alt = HELI.altAttack;
  hp0 = hp();
  check('low: a drone launched now gets through', h.droneOpen());
  tap();
  check('low: the drone hits (a pod in one)', h.stats.droneHits === 1 && hp() === hp0 - Math.min(HELI.hp.pod, HELI.droneDmg), `hp ${hp0} -> ${hp()}`);
  check('after the hit it dumps flares', h.flaring && !h.droneOpen() && notes.some((n) => n.includes('ONE DRONE PER PASS')));
  // a second drone on the same pass: decoyed
  hp0 = hp();
  tap();
  check('same pass: the second drone is decoyed', h.stats.decoys === 2 && h.stats.droneHits === 1 && hp() === hp0, `decoys ${h.stats.decoys}, hits ${h.stats.droneHits}`);
  // it climbs away (cruise), comes down for the next pass: open again
  (h as unknown as { setMode(m: string): void }).setMode('cruise');
  check('back at cruise: the dispenser is reset', !h.flaring);
  h.mode = 'recover';
  h.alt = HELI.altAttack;
  hp0 = hp();
  tap();
  check('next pass: a drone gets through again', h.stats.droneHits === 2 && hp() < hp0, `hits ${h.stats.droneHits}, hp ${hp0} -> ${hp()}`);
  // asleep on its pad: a free first hit
  const { w: w2, p: p2 } = world('heli', 37);
  const h2 = w2.boss as unknown as HeliBoss;
  reveal(w2);
  quiet(w2, p2);
  check('on its pad: open to a drone', h2.state === 'lair' && h2.droneOpen());
}

console.log('--- helicopter: tells before attacks ---');
{
  const { w, p } = world('heli', 34);
  const h = w.boss as unknown as HeliBoss;
  reveal(w);
  quiet(w, p);
  h.state = 'hunt';
  h.mode = 'cruise';
  h.alt = 1;
  // strafing run: the dotted line (strafe set, mode strafeTell) shows >= 60 frames before the first bullet strike
  p.x = Math.round((h.cx - 8) / 8) * 8;
  p.y = Math.round((h.cy - 8 + 100) / 8) * 8;
  const keep = { x: p.x, y: p.y };
  (h as unknown as { startStrafe(a: [number, number]): void }).startStrafe([p.cx, p.cy]);
  let tellAt = -1;
  let shotAt = -1;
  p.shield = 0;
  p.armour = p.armourMax;
  const a0 = p.armour;
  step(w, 60 * 12, () => { p.x = keep.x; p.y = keep.y; if (p.armour < 3) p.armour = p.armourMax; return IDLE; }, () => {
    if (tellAt < 0 && h.mode === 'strafeTell') tellAt = w.frame;
    if (shotAt < 0 && h.stats.strafeShots > 0) shotAt = w.frame;
    return h.mode === 'recover';
  });
  check('strafe: line shown before the run', tellAt > 0 && shotAt - tellAt >= HELI.strafeTell, `tell @${tellAt}, first strike @${shotAt}`);
  check('strafe: low during the run', h.alt <= HELI.low);
  check('strafe: a player left on the line is hit', h.stats.strafeHits >= 1, `hits ${h.stats.strafeHits}, armour ${a0} -> ${p.armour}`);
  // salvo: marks blink >= 75 frames before the first rocket lands
  h.mode = 'cruise';
  (h as unknown as { pickAttack(a: [number, number]): void }).lastAttack = '';
  h.goalPt = [h.cx, h.cy];
  h.mode = 'salvoGo';
  let marksAt = -1;
  let boomAt = -1;
  const hits0 = h.stats.rocketsHit;
  step(w, 60 * 10, () => { p.x = keep.x; p.y = keep.y; if (p.armour < 3) p.armour = p.armourMax; return IDLE; }, () => {
    if (marksAt < 0 && h.marks.length) marksAt = w.frame;
    if (boomAt < 0 && h.marks.some((m) => m.done)) boomAt = w.frame;
    return h.mode === 'recover';
  });
  check('salvo: marks before the rockets land', marksAt > 0 && boomAt - marksAt >= HELI.salvoTell, `marks @${marksAt}, first impact @${boomAt}`);
  check('salvo: 4 rockets with both pods', h.stats.rockets >= 4, `${h.stats.rockets}`);
  check('salvo: the player sitting on a mark is hit', h.stats.rocketsHit > hits0, `${h.stats.rocketsHit - hits0}`);
  // pop-up from cover: hides low behind brick, then rises above shell reach to fire
  const ok = (h as unknown as { startPop(a: [number, number]): boolean }).startPop([p.cx, p.cy]);
  let hidLow = false;
  let poppedHigh = false;
  if (ok) {
    step(w, 60 * 14, () => { p.x = keep.x; p.y = keep.y; if (p.armour < 3) p.armour = p.armourMax; return IDLE; }, () => {
      if (h.mode === 'hide' && h.alt <= HELI.low) hidLow = true;
      if (h.mode === 'salvoFire' && h.alt > HELI.low) poppedHigh = true;
      return h.mode === 'recover';
    });
  }
  check('pop-up: hides low, fires from out of shell reach', ok && hidLow && poppedHigh, `found cover ${ok}, low ${hidLow}, high ${poppedHigh}`);
}

console.log('--- helicopter: the crash ---');
{
  const { w, p } = world('heli', 35);
  const h = w.boss as unknown as HeliBoss;
  reveal(w);
  quiet(w, p);
  h.state = 'hunt';
  h.mode = 'cruise';
  h.alt = 0.9;
  const scrap0 = w.scrap;
  radio.length = 0;
  h.kill(0);
  check('dying: spirals down', h.state === 'dying');
  const n = step(w, HELI.dieFrames + 10, IDLE, () => h.state === 'dead');
  check('crashed after the spiral', h.state === 'dead' && h.stats.crashes === 1 && h.alt === 0, `after ${n} frames`);
  check(`death fired once: boss stat, +${HELI.scrap} scrap, 2 parts`, w.stats.boss === 1 && w.scrap - scrap0 === HELI.scrap && w.partsFound >= HELI.captured, `scrap +${w.scrap - scrap0}`);
  check('radio: HQ and the mechanic', radio.some((r) => r.startsWith('HQ:') && r.includes('DOWN')) && radio.some((r) => r.startsWith('SPANNER:')));
  h.kill(0);
  h.droneHit(h.cx, h.cy, 3, 0);
  step(w, 30);
  check('nothing more after the crash', w.stats.boss === 1 && h.stats.crashes === 1 && h.stats.deaths === 1);
  const m = step(w, 700, IDLE, () => !!w.done);
  check('region clear follows', w.done === 'clear', `after ${m} frames`);
}

// =============================================================================================================
console.log('--- final: the post ---');
{
  const { w } = world('final', 41);
  const f = w.boss as unknown as FinalBoss;
  check('the final fight on the final map, hidden', f.kind === 'final' && f.state === 'hidden' && f.phase === 0);
  const steelIn = (r: number[]) => w.map.any(r[0], r[1], r[2], r[3], (c) => c === STEEL);
  check('three steel gun bunkers built', f.guns.length === 3 && f.guns.every((g) => steelIn(g.rect)));
  const sp = w.region!.playerSpawns[0];
  check('site far from the start', Math.hypot(f.site[0] + 80 - sp[0], f.site[1] + 80 - sp[1]) > 200, `${f.site} face ${f.face}`);
  const fl = new Flow();
  fl.compute(w.map, [[sp[0] / 8, sp[1] / 8]]);
  const ft = f.toWorld([56, 8, 48, 48]);
  check('front lane reachable from the start', Number.isFinite(fl.at(Math.round((ft[0] + 16) / 8), Math.round((ft[1] + 16) / 8))));
  check('heavy tank hidden until the reveal', !f.tank.present && f.tank.name === 'FROSTBITE');
}

console.log('--- RegionSpec.lair (the region generators lair centre) ---');
{
  reseed(45);
  const fs = finalTestRegion();
  (fs as { lair?: [number, number] }).lair = [440, 380];
  const wf = new World(5, [newPState(), newPState()], 1, fs);
  const f = wf.boss as unknown as FinalBoss;
  check('final: the post is centred on the lair', Math.abs(f.site[0] + 80 - 440) <= 8 && Math.abs(f.site[1] + 80 - 380) <= 8, `site ${f.site}`);
  const hs = heliTestRegion();
  (hs as { lair?: [number, number] }).lair = [224, 180];
  const wh = new World(4, [newPState(), newPState()], 1, hs);
  const h = wh.boss as unknown as HeliBoss;
  check('heli: the pad is on the lair', Math.abs(h.lair[0] + 24 - 224) <= 8 && Math.abs(h.lair[1] + 24 - 180) <= 8, `pad ${h.lair}`);
}

console.log('--- final: the stages in order ---');
{
  const { w, p } = world('final', 42);
  const f = w.boss as unknown as FinalBoss;
  radio.length = 0;
  notes.length = 0;
  reveal(w);
  check('revealed: stage 1, the winter tank at the gate', f.state === 'lair' && f.phase === 1 && f.tank.present && f.tank.state === 'lair');
  check('HQ: the command post', radio.some((r) => r.startsWith('HQ:') && r.includes('BASTION')), radio.find((r) => r.startsWith('HQ')) ?? '');
  check(`escort of ${FINAL.tankEscort.length}`, w.ai!.groups.some((g) => g.escort && g.members.length === FINAL.tankEscort.length));
  check('HUD: the tank\'s weak points, turret last', f.parts === f.tank.parts && f.turret === f.tank.turret && f.hudKey === 'final1');
  quiet(w, p);
  // stage 1: bunkers locked (shutters), the door locked
  const g0 = f.guns[0];
  shell(w, p, g0.rect[0] + 8, g0.rect[1] + 8, 1);
  step(w, 10, IDLE, () => !w.bullets.length);
  check('stage 1: gun bunkers take no damage', g0.hp === FINAL.gunHp && f.stats.noPen >= 1);
  // the tank dies (drones on the turret), its own death sequence, then the hand-over
  const scrap0 = w.scrap;
  for (let i = 0; i < 3; i++) f.tank.droneHit(f.tank.cx, f.tank.cy, ABIL.fpvDmg, 0);
  check('tank dying', f.tank.state === 'dying');
  step(w, BOSS.dieFrames + 5);
  check('tank wreck; no boss reward, no victory', f.tank.state === 'dead' && w.stats.boss === 0 && !f.victory && w.scrap - scrap0 < 100, `scrap +${w.scrap - scrap0}`);
  check('still stage 1 during the pause', f.phase === 1);
  step(w, FINAL.phaseGap + 5);
  check('stage 2: guns and the door', f.phase === 2 && f.parts.length === 4 && f.turret.id === 'door' && f.hudKey === 'final2');
  // the guns fire at a player in range, after a glow
  w.freeze = 0;
  p.shield = 0;
  const g1 = f.guns[1];
  const gx = g1.rect[0] + 8;
  const gy = g1.rect[1] + 8;
  let spot: [number, number] | null = null;
  for (let d = 0; d < 4 && !spot; d++) {
    for (let r = 60; r < 150 && !spot; r += 8) {
      const x = Math.round((gx - 8 + DX[d] * r) / 8) * 8;
      const y = Math.round((gy - 8 + DY[d] * r) / 8) * 8;
      if (x < 0 || y < 0 || x > w.pxW - 16 || y > w.pxH - 16 || w.map.solidForTank(x, y, false)) continue;
      let clear = true;
      for (let s = 12; s < r; s += 4) if (w.map.at(Math.floor((gx + DX[d] * s) / 4), Math.floor((gy + DY[d] * s) / 4)) === STEEL) clear = false;
      if (clear) spot = [x, y];
    }
  }
  if (spot) [p.x, p.y] = spot;
  let glowAt = -1;
  const shots0 = f.stats.gunShots;
  step(w, 60 * 8, () => { if (spot) [p.x, p.y] = spot; p.armour = p.armourMax; return IDLE; }, () => {
    if (glowAt < 0 && f.guns.some((g) => g.glow >= 0)) glowAt = w.frame;
    return f.stats.gunShots > shots0;
  });
  check('stage 2: a gun glows, then fires', glowAt > 0 && f.stats.gunShots > shots0, `spot ${spot}, glow @${glowAt}, shots ${f.stats.gunShots}`);
  // the door is locked until the guns are down
  w.bullets.length = 0;
  const dr = (f as unknown as { doorRect(): number[] }).doorRect();
  const fwd = f.face;
  const doorShot = () => { shell(w, p, dr[0] + dr[2] / 2 - DX[fwd] * 0, dr[1] + dr[3] / 2, (fwd + 2) & 3); step(w, 8, IDLE, () => !w.bullets.some((b) => b.owner === p)); };
  w.freeze = 1e9;
  doorShot();
  check('stage 2: door locked while guns stand', f.door.hp === FINAL.doorHp);
  // balance pass: a shell from the right or from below must count too (the hit margin used to be 1 px, and a shell's
  // 4 px box met the steel face first from those sides). Fired from a clear cell just outside the bunker.
  {
    let tried = '';
    for (const g of f.guns) {
      for (const d of [1, 2]) {
        const sx = g.rect[0] + 8 + DX[d] * 14;
        const sy = g.rect[1] + 8 + DY[d] * 14;
        let blocked = false;
        for (let k = 9; k <= 28; k++) {
          for (const o of [-2, 0, 2]) {
            const c = w.map.at(Math.floor((g.rect[0] + 8 + DX[d] * k + DY[d] * o) / 4), Math.floor((g.rect[1] + 8 + DY[d] * k + DX[d] * o) / 4));
            if (c === BRICK || c === STEEL) blocked = true;
          }
        }
        if (tried || blocked) continue;
        const hp0 = g.hp;
        shell(w, p, sx, sy, (d + 2) & 3);
        step(w, 20, IDLE, () => !w.bullets.some((b) => b.owner === p));
        tried = `${g.id} from ${d === 1 ? 'the right' : 'below'}: ${hp0} -> ${g.hp}`;
        check('a shell from the right or below hits a bunker gun', g.hp < hp0, tried);
      }
    }
    if (!tried) console.log('  (no clear cell right of or below a gun on this map)');
  }
  for (const g of f.guns) {
    for (let i = 0; i < FINAL.gunHp && g.hp > 0; i++) { shell(w, p, g.rect[0] + 8, g.rect[1] + 8, 1); step(w, 8, IDLE, () => !w.bullets.some((b) => b.owner === p)); }
  }
  check(`three guns destroyed by shells (${FINAL.gunHp} each)`, f.guns.every((g) => g.hp === 0) && f.exposed());
  for (let i = 0; i < FINAL.doorHp && f.phase === 2; i++) doorShot();
  check('door down: stage 3, the car is out', f.phase === 3 && !!f.car && f.turret.id === 'car' && f.hudKey === 'final3');
  check('stage times in order', f.stats.phase1At < f.stats.phase2At && f.stats.phase2At < f.stats.phase3At);
  // the car runs for its exit
  w.freeze = 0;
  p.shield = 1e9;
  p.x = 8;
  p.y = 8;
  for (const e of w.enemies) e.alive = false;
  const ex = f.exit!;
  const d0 = Math.abs(f.car!.x - ex[0]) + Math.abs(f.car!.y - ex[1]);
  const n = step(w, 60 * 60, () => { p.x = 8; p.y = 8; return IDLE; }, () => f.stats.escapes > 0);
  const c = f.car!;
  check('the car drives to the road out', f.stats.escapes === 1, `from ${d0} px, ${n} frames, at ${Math.round(c.x)},${Math.round(c.y)} exit ${ex}`);
  step(w, FINAL.carWait + 5);
  check('road blown: it turns for another exit', f.exit!.join() !== ex.join() && f.alive, `${ex} -> ${f.exit}`);
  // stop it: shells from behind
  w.freeze = 1e9;
  for (let i = 0; i < FINAL.carHp && f.alive; i++) { shell(w, p, c.cx, c.cy, c.cy > 40 ? 2 : 0); step(w, 8, IDLE, () => !w.bullets.some((b) => b.owner === p)); }
  check('car hit to 0: the end begins', f.state === 'dying' && f.stats.deaths === 1, f.state);
  w.freeze = 0;
  const scrap1 = w.scrap;
  radio.length = 0;
  notes.length = 0;
  step(w, FINAL.dieFrames + 5);
  check('VICTORY: flag set, boss stat, rewards', f.victory && f.state === 'dead' && w.stats.boss === 1 && w.scrap - scrap1 === FINAL.scrap, `scrap +${w.scrap - scrap1}`);
  check('victory toast and radio', notes.includes('VICTORY!') && radio.some((r) => r.startsWith('HQ:')));
  f.kill(0);
  f.droneHit(c.cx, c.cy, 3, 0);
  step(w, 60);
  check('victory fired once', f.stats.victories === 1 && w.stats.boss === 1);
  const m = step(w, 60 * 10, IDLE, () => !!w.done);
  check('region clear after the celebration', w.done === 'clear', `after ${m} frames`);
}

console.log('--- final: debug kill from hidden; the real fight runs a while ---');
{
  const { w } = world('final', 43);
  const f = w.boss as unknown as FinalBoss;
  f.kill(0);
  step(w, FINAL.dieFrames + 10);
  check('kill() from hidden: victory', f.victory && f.state === 'dead' && f.stats.victories === 1 && w.stats.boss === 1);
  const { w: w2, p: p2 } = world('final', 44);
  const f2 = w2.boss as unknown as FinalBoss;
  reveal(w2);
  p2.shield = 1e9;
  const t0 = performance.now();
  // the player parks in front of the gate; the tank and escort come, stage 1 plays out with everything on
  const front = f2.toWorld([64, 0, 16, 16]);
  const s = w2.freeSpotNear(front[0] + DX[f2.face] * -60, front[1] + DY[f2.face] * -60);
  if (s) [p2.x, p2.y] = s;
  step(w2, 60 * 60, IDLE);
  check('full world with the final boss: no exceptions over 60 s', exceptions === 0 && f2.tank.state !== 'hidden', `tank ${f2.tank.state}, phase ${f2.phase}`);
  check('final update cost', f2.stats.msSum / f2.stats.n < 0.25 && f2.stats.msMax < 10, `avg ${(f2.stats.msSum / f2.stats.n).toFixed(4)} ms, max ${f2.stats.msMax.toFixed(2)} ms, ${((performance.now() - t0) / 3600).toFixed(3)} ms per world update`);
}

console.log('--- ease ---');
{
  const { w, p } = world('heli', 36);
  const h = w.boss as unknown as HeliBoss;
  reveal(w);
  quiet(w, p);
  w.ease = 0.3;
  h.state = 'hunt';
  h.alt = 1;
  p.x = Math.round((h.cx - 8) / 8) * 8;
  p.y = Math.round((h.cy - 8 + 100) / 8) * 8;
  (h as unknown as { startStrafe(a: [number, number]): void }).startStrafe([p.cx, p.cy]);
  let tellAt = -1;
  let runAt = -1;
  step(w, 60 * 12, IDLE, () => {
    if (tellAt < 0 && h.mode === 'strafeTell') tellAt = w.frame;
    if (runAt < 0 && h.mode === 'strafe') runAt = w.frame;
    return runAt > 0;
  });
  check('eased attempt: longer tells', runAt - tellAt >= Math.round(HELI.strafeTell * 1.3), `${runAt - tellAt} frames`);
}

check('no exceptions', exceptions === 0, String(exceptions));
console.log(fails ? `boss sim 3: ${fails} FAILED` : 'boss sim 3: all checks pass');
process.exit(fails ? 1 : 0);
