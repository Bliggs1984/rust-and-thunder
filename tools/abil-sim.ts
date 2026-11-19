// Headless checks for the player's crew abilities (src/game/abilities.ts): FPV drone strike, infantry ambush and
// recon drone, on a small hand-made region, plus a soak run on a generated region with random ability use.
// Run: npm run abilsim
import './ai-sim-seed';
import { ABIL, revealed } from '../src/game/abilities';
import { regionBot } from '../src/game/bot';
import { BRICK, EMPTY, TREES, UP } from '../src/game/constants';
import { makeFarmland, type RegionSpec } from '../src/game/region';
import { Tank, World, newPState, type PInput } from '../src/game/world';

let fails = 0;
let exceptions = 0;
let frames = 0;
function check(name: string, ok: boolean, detail: string): void {
  if (!ok) fails++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}: ${detail}`);
}

// ---------- a 320 x 320 px test field: a hedge ahead of the player, a brick tile, ruins to the west ----------
const W = 80;
const H = 80;
function field(): RegionSpec {
  const c = new Uint8Array(W * H);
  const fill = (x: number, y: number, w: number, h: number, v: number) => {
    for (let yy = y; yy < y + h; yy++) for (let xx = x; xx < x + w; xx++) c[yy * W + xx] = v;
  };
  fill(34, 50, 13, 9, TREES); // px 136..188 x 200..236, just ahead of the spawn
  fill(40, 40, 2, 2, BRICK); // one 8 px brick tile at px 160..168 x 160..168
  fill(8, 60, 2, 10, BRICK); // a broken wall (ruins) at px 32..40 x 240..280
  fill(8, 72, 2, 4, BRICK);
  return {
    name: 'ABIL TEST', env: 'day', w: W, h: H, cells: c,
    playerSpawns: [[152, 240]], enemySpawns: [[8, 8]], enemies: 0, maxActive: 4,
  };
}

const idle: PInput = { dir: -1, fire: false };
let notes: string[] = [];

function newWorld(spec = field()): World {
  const ps = [newPState(), newPState()];
  ps[0].lives = 99;
  const w = new World(1, ps, 1, spec);
  (w as unknown as { allAbilities: boolean }).allAbilities = true;
  w.charges = [3, 3, 3, 2];
  // enemies stand still unless a test moves them
  (w as unknown as { updateEnemy: () => void }).updateEnemy = () => {};
  run(w, 60);
  return w;
}

function step(w: World, inp: PInput = idle): void {
  const p = w.players[0];
  if (p) p.shield = Math.max(p.shield, 2);
  try {
    w.update([inp]);
  } catch (err) {
    exceptions++;
    if (exceptions < 4) console.log(err);
  }
  frames++;
  w.ev.length = 0;
  w.decals.length = 0;
  for (const n of w.notes) notes.push(n.text);
  w.notes.length = 0;
}

function run(w: World, n: number, inp: (i: number) => PInput = () => idle): void {
  for (let i = 0; i < n; i++) step(w, inp(i));
}

function enemy(w: World, cx: number, cy: number, etype = 0): Tank {
  const e = new Tank();
  e.x = cx - 8;
  e.y = cy - 8;
  e.etype = etype;
  e.hp = etype === 3 ? 4 : 1;
  e.dir = UP;
  e.aiFire = 1e9;
  w.enemies.push(e);
  return e;
}

const press = (k: number, dir = -1): PInput => ({ dir, fire: false, ability: k, abilityHeld: k <= 3 ? k : 0 });
const hold = (k: number, dir = -1): PInput => ({ dir, fire: false, abilityHeld: k });
const abil = (w: World) => w.abil!;

// ---------- FPV drone strike ----------
{
  // hold to aim, steer the reticle up onto a basic tank 60 px ahead, release: the drone locks on and kills it
  const w = newWorld();
  notes = [];
  const p = w.players[0]!;
  const e = enemy(w, p.cx, p.cy - 60);
  const x0 = p.x;
  const y0 = p.y;
  step(w, press(1));
  run(w, 5, () => hold(1, UP));
  run(w, 10, () => hold(1));
  const a = abil(w).aims[0];
  const still = p.x === x0 && p.y === y0;
  step(w, idle);
  const f = abil(w).fpvs[0];
  const charged = w.charges[0] === 2;
  let flight = 1; // the release update already flew the first frame
  while (abil(w).fpvs.length && flight < 120) {
    step(w);
    flight++;
  }
  check('fpv aim, lock and kill', !!a && still && !!f?.target && charged && !e.alive && abil(w).stats.fpvHits === 1,
    `reticle ${a ? `${Math.round(a.x)},${Math.round(a.y)}` : 'none'} (enemy at ${e.cx},${e.cy}), tank still ${still}, locked ${!!f?.target}, charges ${w.charges[0]}, flight ${(flight / 60).toFixed(2)} s, enemy alive ${e.alive}`);
  check('fpv flight time 0.6-1 s', flight >= 36 && flight <= 61, `${flight} frames`);
}
{
  // armoured tank: 3 damage, survives with 1
  const w = newWorld();
  const p = w.players[0]!;
  const e = enemy(w, p.cx, p.cy - 48, 3);
  step(w, press(1));
  run(w, 20, () => hold(1));
  step(w);
  run(w, 90);
  check('fpv vs armoured tank', e.alive && e.hp === 1, `hp ${e.hp} (from 4), alive ${e.alive}`);
}
{
  // tap: nearest visible enemy in front, even far from the default reticle
  const w = newWorld();
  const p = w.players[0]!;
  const e = enemy(w, p.cx + 30, p.cy - 120);
  enemy(w, p.cx + 60, p.cy + 40); // behind: ignored
  step(w, press(1));
  step(w, idle);
  run(w, 90);
  check('fpv tap auto-target', !e.alive && w.charges[0] === 2, `front enemy alive ${e.alive}, charges ${w.charges[0]}`);
}
{
  // tap with nothing in front: no launch, no charge spent
  const w = newWorld();
  notes = [];
  step(w, press(1));
  step(w, idle);
  run(w, 5);
  check('fpv tap without target', w.charges[0] === 3 && !abil(w).fpvs.length && notes.includes('NO TARGET IN FRONT'), `charges ${w.charges[0]}, notes ${notes.join(' / ')}`);
}
{
  // fire while aiming cancels and keeps the charge; the tank doesn't fire that update
  const w = newWorld();
  notes = [];
  step(w, press(1));
  run(w, 20, () => hold(1));
  const shells = w.bullets.length;
  step(w, { dir: -1, fire: true, abilityHeld: 1 });
  run(w, 5, () => ({ dir: -1, fire: false, abilityHeld: 1 }));
  run(w, 5);
  check('fpv cancel with fire', w.charges[0] === 3 && !abil(w).fpvs.length && !abil(w).aims[0] && w.bullets.length === shells,
    `charges ${w.charges[0]}, drones ${abil(w).fpvs.length}, notes ${notes.join(' / ')}`);
}
{
  // a brick tile under the reticle breaks
  const w = newWorld();
  const p = w.players[0]!;
  step(w, press(1)); // reticle at y = cy - 48 = 200
  run(w, 12, () => hold(1, UP)); // 36 px further up: 164, the brick tile's centre row
  step(w);
  run(w, 90);
  const m = w.map;
  const left = [m.at(40, 40), m.at(41, 40), m.at(40, 41), m.at(41, 41)].filter((c) => c === BRICK).length;
  check('fpv breaks a brick tile', left === 0, `brick cells left ${left} (player at ${p.cx},${p.cy})`);
}
{
  // locked type and empty charges refuse without spending
  const w = newWorld();
  notes = [];
  (w as unknown as { allAbilities: boolean }).allAbilities = false;
  step(w, press(1));
  run(w, 3);
  (w as unknown as { allAbilities: boolean }).allAbilities = true;
  w.charges[2] = 0;
  step(w, press(3));
  run(w, 3);
  check('locked / no charges refuse', notes.includes('FPV DRONE NEEDS CREW') && notes.includes('NO RECON DRONE CHARGES') && !abil(w).aims[0] && !abil(w).recon,
    notes.join(' / '));
}

// ---------- infantry ambush ----------
{
  // the hedge ahead: the squad goes into the trees and fires at a basic tank crossing its row
  const w = newWorld();
  notes = [];
  w.radio.length = 0;
  step(w, press(2));
  const s = abil(w).squads[0];
  const inTrees = !!s && w.map.at(s.x / 4 - 1, s.y / 4 - 1) === TREES;
  check('ambush placed in trees', !!s && inTrees && w.charges[1] === 2 && notes.includes('AMBUSH SET IN THE TREES'),
    `squad ${s ? `${s.x},${s.y}` : 'none'}, in trees ${inTrees}, charges ${w.charges[1]}`);
  if (s) {
    const e = enemy(w, s.x + 70, s.y + 2);
    e.dir = 3;
    let f = 0;
    while (e.alive && f < 300) {
      e.x -= 0.5; // drives west past the squad
      step(w);
      f++;
    }
    const radio = w.radio.some((m) => m.who === 'OWL');
    check('ambush fires on a passing tank', !e.alive && abil(w).stats.rocketsFired >= 1 && radio && notes.includes('AMBUSH!'),
      `enemy alive ${e.alive} after ${(f / 60).toFixed(1)} s, rockets ${abil(w).stats.rocketsFired}, hits ${abil(w).stats.rocketHits}, rockets left ${s.rockets}, radio ${radio}`);
    // an armoured tank sitting in its line takes 2 per rocket and is dead after two
    const a = enemy(w, s.x + 2, s.y - 50, 3);
    run(w, 400);
    check('ambush rockets: 2 damage each', !a.alive && s.rockets === 1 && abil(w).stats.rocketHits === 3,
      `armour alive ${a.alive} hp ${a.hp}, rockets left ${s.rockets}, hits ${abil(w).stats.rocketHits}`);
    const b = enemy(w, s.x - 60, s.y, 3);
    run(w, 400);
    check('ambush out of rockets withdraws', s.rockets === 0 && !abil(w).squads.includes(s) && notes.includes('AMBUSH SQUAD OUT OF ROCKETS'),
      `rockets ${s.rockets}, still out ${abil(w).squads.includes(s)}, third target hp ${b.hp}`);
  }
}
{
  // open ground: no cover, no charge spent
  const w = newWorld();
  notes = [];
  const p = w.players[0]!;
  p.x = 232;
  p.y = 120;
  step(w, press(2));
  check('ambush refuses without cover', !abil(w).squads.length && w.charges[1] === 3 && notes.includes('NO COVER AHEAD'), notes.join(' / '));
}
{
  // ruins: next to the broken wall
  const w = newWorld();
  notes = [];
  const p = w.players[0]!;
  p.x = 8;
  p.y = 248;
  p.dir = 1;
  step(w, press(2));
  const s = abil(w).squads[0];
  check('ambush in ruins', !!s && notes.includes('AMBUSH SET IN THE RUINS'), `squad ${s ? `${s.x},${s.y}` : 'none'}, ${notes.join(' / ')}`);
}
{
  // an enemy that comes within 24 px spots the squad, turns and shoots it: the squad pulls back
  const w = newWorld();
  notes = [];
  step(w, press(2));
  const s = abil(w).squads[0];
  let f = 0;
  if (s) {
    s.reload = 1e9; // holds its fire for this test
    enemy(w, s.x - 18, s.y, 3).dir = UP;
    while (!s.leaving && f < 240) {
      step(w);
      f++;
    }
  }
  check('enemy spots and hits the squad', !!s && s.leaving > 0 && notes.includes('SQUAD HIT, PULLING BACK'), `after ${(f / 60).toFixed(1)} s, leaving ${s?.leaving}`);
}

// ---------- recon drone ----------
{
  const w = newWorld();
  notes = [];
  step(w, press(3));
  const up = revealed(w);
  const f0 = w.frame;
  run(w, ABIL.reconFrames - 2);
  const still = revealed(w);
  const pos = abil(w).reconPos();
  run(w, 3);
  check('recon reveal and timing', up && still && !revealed(w) && w.charges[2] === 2 && !!pos && notes.includes('RECON DRONE RETURNING'),
    `up ${up}, at ${((w.frame - f0) / 60).toFixed(1)} s ${revealed(w)}, charges ${w.charges[2]}, radio ${w.radio.some((m) => m.who === 'WASP')}`);
  step(w, press(3));
  step(w, press(3));
  check('recon refuses a second drone', w.charges[2] === 1 && notes.includes('RECON DRONE ALREADY UP'), `charges ${w.charges[2]}`);
}
{
  // hidden things on w.tricks get recon marks (generic `hidden` flag)
  const w = newWorld();
  (w.tricks as unknown as { mines: object[] }).mines = [{ x: 40, y: 40, hidden: true }, { cx: 80, cy: 90, hidden: false }];
  const hid = (abil(w) as unknown as { hiddenThings(): [number, number][] }).hiddenThings();
  check('reveal API sees hidden tricks', hid.length === 1 && hid[0][0] === 40, JSON.stringify(hid));
}

// ---------- soak: a generated region, the autopilot, abilities used at random ----------
{
  const w = new World(1, [newPState(), newPState()], 1, makeFarmland(4242));
  w.ps[0].lives = 99;
  (w as unknown as { allAbilities: boolean }).allAbilities = true;
  let holdK = 0;
  let holdN = 0;
  for (let i = 0; i < 60 * 240; i++) {
    if (i % 600 === 0) w.charges = [3, 3, 3, w.charges[3]];
    let inp = regionBot(w);
    if (holdN > 0) {
      holdN--;
      inp = { ...inp, abilityHeld: holdK, dir: i % 20 < 10 ? 0 : 1 };
    } else if (i % 240 === 120) {
      const k = 1 + Math.floor(Math.random() * 3);
      holdK = k;
      holdN = k === 1 ? Math.floor(Math.random() * 40) : 0;
      inp = { ...inp, ability: k, abilityHeld: k };
    }
    step(w, inp);
  }
  const s = abil(w).stats;
  check('soak: 4 min region with random abilities, no exceptions', exceptions === 0,
    `exceptions ${exceptions}, fpv ${s.fpv} (hits ${s.fpvHits}), ambush ${s.ambush} (rockets ${s.rocketsFired}, hits ${s.rocketHits}), recon ${s.recon}, kills ${w.ps[0].kills.join('/')}`);
}

void EMPTY;
console.log(`\n${fails ? `${fails} FAILED` : 'all passed'} (${frames} frames simulated, ${exceptions} exceptions)`);
if (fails || exceptions) process.exitCode = 1;
