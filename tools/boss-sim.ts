// Headless checks for the Phase 4 boss framework and the Region 1 boss (src/game/boss.ts): reveal after 3 towns,
// weak points taking damage only as designed (turret protected until a skirt is down, or from behind; drones always),
// the column call, main gun and machine guns, the death sequence firing once, region clear, saves, perf, and the
// region bot fighting it.
// Run: npm run bosssim
import { reseed } from './ai-sim-seed';
import { regionBot } from '../src/game/bot';
import { BRICK, DX, DY, EMPTY, STEEL } from '../src/game/constants';
import { ABIL } from '../src/game/abilities';
import { BOSS, type Boss } from '../src/game/boss';
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

function world(seed: number, region = 0): { w: World; b: Boss; p: Tank } {
  reseed(seed);
  const run = newRun(seed);
  run.region = region;
  const ps: PState[] = [newPState(), newPState()];
  ps[0].lives = 9;
  const w = regionWorld(run, ps, 1);
  w.update([IDLE]);
  const p = w.players[0]!;
  p.spawn = 0;
  return { w, b: w.boss!, p };
}

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

/** Reveal by freeing towns the way play does (3 of them), escorts removed, everything frozen for exact shots. */
function revealed(seed: number): { w: World; b: Boss; p: Tank } {
  const r = world(seed);
  const { w, b } = r;
  for (const t of w.towns.slice(0, 3)) w.freeTown(t);
  step(w, 31, IDLE, () => b.state !== 'hidden');
  quiet(w, b, r.p);
  return r;
}

/** No enemies, frozen enemies and boss, the area round the boss cleared, the player parked 80 px from it. */
function quiet(w: World, b: Boss, p: Tank): void {
  for (const e of w.enemies) e.alive = false;
  w.enemies.length = 0;
  w.bullets.length = 0;
  if (w.ai) w.ai.update = () => {};
  if (w.tricks) w.tricks.update = () => {};
  w.freeze = 1e9;
  for (let cy = Math.floor((b.y - 24) / 4); cy < (b.y + 72) / 4; cy++) {
    for (let cx = Math.floor((b.x - 24) / 4); cx < (b.x + 72) / 4; cx++) if (w.map.at(cx, cy) !== STEEL) w.map.set(cx, cy, EMPTY);
  }
  p.x = Math.max(0, b.x - 96);
  p.y = Math.max(0, b.y - 96);
  p.shield = 1e9;
}

/** Fire a player shell at the boss's local point (lx, ly) travelling in local direction ld (0 = the hull's forward). */
function shoot(w: World, b: Boss, p: Tank, lx: number, ly: number, ld: number, owner: Tank = p): void {
  // start 8 px outside the hull, opposite to the travel direction
  const sx = lx - DX[ld] * (ld === 1 ? lx + 8 : ld === 3 ? 48 - lx + 8 : 0);
  const sy = ly - DY[ld] * (ld === 0 ? 48 - ly + 8 : ld === 2 ? ly + 8 : 0);
  const [x, y] = b.toWorld(sx, sy);
  const dir = (b.dir + ld) & 3;
  w.bullets.push(new Bullet(x, y, dir, 3, owner, false, false, 0));
  step(w, 30, IDLE, () => !w.bullets.length);
}

const part = (b: Boss, id: string) => b.parts.find((q) => q.id === id)!;

// ---------- 1. hidden until 3 towns are free ----------
console.log('--- reveal ---');
{
  const { w, b } = world(11);
  check('boss exists on a region with towns, hidden', !!b && b.state === 'hidden' && !b.revealed);
  check('lair inside the map', b.lair[0] >= 0 && b.lair[1] >= 0 && b.lair[0] <= w.pxW - 48 && b.lair[1] <= w.pxH - 48, `${b.lair} near ${b.lairNear}`);
  check('lair has a town name', b.lairNear.length > 0);
  check('lair footprint has no steel or water', !w.map.any(b.lair[0], b.lair[1], 48, 48, (c) => c === STEEL || c === 3));
  w.freeTown(w.towns[0]);
  w.freeTown(w.towns[1]);
  step(w, 60);
  check('2 towns freed: still hidden', b.state === 'hidden' && b.townsToReveal() === 1);
  radio.length = 0;
  notes.length = 0;
  w.freeTown(w.towns[2]);
  const n = step(w, 40, IDLE, () => b.state !== 'hidden');
  check('3rd town freed: revealed', b.revealed && b.state === 'lair', `after ${n} frames`);
  check('HQ radio line names it and the place', radio.some((r) => r.startsWith('HQ:') && r.includes(b.name) && r.includes(b.lairNear)), radio.find((r) => r.startsWith('HQ')) ?? '');
  check('BOSS LOCATED toast', notes.includes('BOSS LOCATED'));
  check(`escort of ${BOSS.escort.length}`, b.stats.escorts === BOSS.escort.length, `${b.stats.escorts}`);
  const esc = w.ai!.groups.filter((g) => g.escort);
  check('escort group with the director', esc.length === 1 && esc[0].members.length === b.stats.escorts);
  check('no tank inside the boss', !w.enemies.some((e) => e.alive && b.overlaps(e.x, e.y, 16, 16)));
  check('region not clear while the boss lives (all towns freed)', (() => { for (const t of w.towns) if (!t.freed) w.freeTown(t); step(w, 260); return !w.done; })());
  check('boss blocks tanks', w.blockedAt(w.players[0]!, b.x + 16, b.y - 15));
}

// ---------- 2. weak points ----------
console.log('--- weak points ---');
{
  const { w, b, p } = revealed(12);
  const T = b.turret;
  shoot(w, b, p, 24, 0, 2); // front centre: the glacis
  check('front centre shell: no pen, turret untouched', T.hp === T.max && b.stats.noPen === 1, `turret ${T.hp} noPen ${b.stats.noPen}`);
  shoot(w, b, p, 24, 24, 1); // into the left side mid: the skirt
  check('side shell hits the left skirt', part(b, 'skL').hp === BOSS.hp.skirt - 1 && T.hp === T.max);
  shoot(w, b, p, 13, 0, 2); // front left: the left sponson
  check('front-left shell hits the left gun', part(b, 'spL').hp === BOSS.hp.sponson - 1);
  shoot(w, b, p, 24, 47, 0); // rear deck from behind
  check('shell from behind hits the turret', T.hp === T.max - 1, `turret ${T.hp}`);
  shoot(w, b, p, 24, 24, 3); // right side
  check('right side shell hits the right skirt, not the turret', part(b, 'skR').hp === BOSS.hp.skirt - 1 && T.hp === T.max - 1);
  // enemy shells pass the boss
  const foe = w.players[0]!;
  const e = { ...foe, isPlayer: false, player: -1, etype: 0 } as unknown as Tank;
  const hp0 = b.parts.map((q) => q.hp).join();
  shoot(w, b, p, 13, 0, 2, e);
  check('enemy shell does nothing to the boss', b.parts.map((q) => q.hp).join() === hp0);
  // the left gun: 3 more hits destroy it, the machine gun stops, a column is called
  radio.length = 0;
  w.ai!.update = Object.getPrototypeOf(w.ai).update;
  w.ai!.gentleOff = true; // Farmland's gentle first minute sends no column; this check runs inside it
  for (let i = 0; i < 3; i++) shoot(w, b, p, 13, 0, 2);
  check('left gun destroyed after 4 hits', part(b, 'spL').hp === 0);
  check('it radios for a column', radio.some((r) => r.includes('SEND ME A COLUMN')));
  step(w, 2);
  check('the director launched a column', b.stats.columns === 1 && w.ai!.groups.some((g) => g.job === 'assault' && !g.escort), `columns ${b.stats.columns}`);
  check('front-left shell on a dead gun: no pen', (() => { const n = b.stats.noPen; shoot(w, b, p, 13, 0, 2); return b.stats.noPen === n + 1; })());
  w.ai!.update = () => {};
  for (const en of w.enemies) en.alive = false;
  // the left skirt: 5 more hits, then the turret is exposed and front hits reach it
  for (let i = 0; i < 5; i++) shoot(w, b, p, 24, 24, 1);
  check('left skirt destroyed after 6 hits', part(b, 'skL').hp === 0 && b.exposed());
  const t0 = T.hp;
  shoot(w, b, p, 24, 0, 2);
  check('exposed: front centre shell now hurts the turret', T.hp === t0 - 1);
  shoot(w, b, p, 24, 24, 1);
  check('exposed: the open side hurts the turret', T.hp === t0 - 2);
}

// ---------- 3. drones ----------
console.log('--- drone strikes ---');
{
  const { w, b, p } = revealed(13);
  const T = b.turret;
  const [cx, cy] = [b.cx, b.cy];
  check('drone on the protected turret: heavy damage', b.droneHit(cx, cy, ABIL.fpvDmg, 0) && T.hp === T.max - ABIL.fpvDmg * BOSS.droneMul, `turret ${T.hp}`);
  const sp = part(b, 'spR');
  const [x, y, pw, ph] = b.partRect(sp);
  b.droneHit(x + pw / 2, y + ph / 2, ABIL.fpvDmg, 0);
  check('drone on a sponson destroys it (6 >= 4)', sp.hp === 0);
  check('drone far from the boss misses it', !b.droneHit(b.x - 30, b.y - 30, ABIL.fpvDmg, 0));
  // the real FPV path: abilities.ts tap launch at the boss in front
  (w as unknown as { allAbilities: boolean }).allAbilities = true;
  w.unlocked = [true, true, true, true];
  w.charges = [3, 0, 0, 2];
  p.shield = 1e9;
  p.x = b.x + 16;
  p.y = Math.min(w.pxH - 16, b.y + 48 + 80);
  p.dir = 0;
  const hpSum = () => b.parts.reduce((a, q) => a + q.hp, 0);
  // (the drone hits above popped its smoke: let it clear first)
  check('a drone hit pops its smoke dischargers', b.stats.smokes >= 1 && !b.droneOpen(), `smokes ${b.stats.smokes}, open ${b.droneOpen()}`);
  b.smokeUntil = -1e9;
  const t1 = hpSum();
  const hits = b.stats.droneHits;
  step(w, 1, { dir: -1, fire: false, ability: 1 });
  step(w, 90, IDLE, () => b.stats.droneHits > hits);
  check('tap-launched FPV drone flies to the boss and hits it', b.stats.droneHits === hits + 1 && hpSum() === t1 - ABIL.fpvDmg * BOSS.droneMul || (b.stats.droneHits === hits + 1 && hpSum() < t1), `hp ${t1} -> ${hpSum()}, charges ${w.charges[0]}`);
  // smoke is up again after that hit: the next drone loses it and bursts beside the hull, no damage
  const t2 = hpSum();
  const lost0 = w.abil!.stats.fpvLost;
  check('smoke up: a drone launched now would not find it', !b.droneOpen());
  step(w, 1, { dir: -1, fire: false, ability: 1 });
  step(w, 200, IDLE, () => !w.abil!.fpvs.length);
  check('smoke up: the next drone is lost in it, no damage', b.stats.dronesLost === 1 && w.abil!.stats.fpvLost === lost0 + 1 && hpSum() === t2 && b.stats.droneHits === hits + 1, `lost ${b.stats.dronesLost}, hp ${t2} -> ${hpSum()}`);
  check('the drone operator says why', radio.some((r) => r.startsWith('WASP:') && r.includes('SMOKE')));
  // shells still hit through the smoke; once it clears a drone finds it again
  step(w, BOSS.smokeHold + 10);
  check(`smoke clears after ${BOSS.smokeHold / 60} s`, b.droneOpen());
  const t3 = hpSum();
  step(w, 1, { dir: -1, fire: false, ability: 1 });
  step(w, 200, IDLE, () => !w.abil!.fpvs.length);
  check('smoke gone: the next drone hits', b.stats.droneHits === hits + 2 && hpSum() < t3, `hp ${t3} -> ${hpSum()}`);
  b.smokeUntil = -1e9;
}

// ---------- 4. guns ----------
console.log('--- main gun and machine guns ---');
{
  const { w, b, p } = revealed(14);
  w.freeze = 0;
  b.state = 'hunt';
  // player straight ahead of the turret, 120 px out, armour full, no shield
  const d = b.tdir;
  p.x = b.cx - 8 + DX[d] * 120;
  p.y = b.cy - 8 + DY[d] * 120;
  p.shield = 0;
  p.armour = p.armourMax;
  for (let cy = Math.floor(Math.min(p.y, b.y) / 4) - 2; cy < Math.max(p.y + 16, b.y + 48) / 4 + 2; cy++) {
    for (let cx = Math.floor(Math.min(p.x, b.x) / 4) - 2; cx < Math.max(p.x + 16, b.x + 48) / 4 + 2; cx++) w.map.set(cx, cy, EMPTY);
  }
  b.reload = 0;
  const frozen = { dir: -1, fire: false };
  const stuck = { x: p.x, y: p.y };
  const keep = () => { p.x = stuck.x; p.y = stuck.y; };
  let glowAt = -1;
  let shotAt = -1;
  for (let i = 0; i < 200 && shotAt < 0; i++) {
    keep();
    step(w, 1, frozen);
    if (glowAt < 0 && b.glow >= 0) glowAt = w.frame;
    if (b.stats.gunShots) shotAt = w.frame;
  }
  check('main gun telegraphs with a 1 s barrel glow', glowAt > 0 && shotAt - glowAt >= BOSS.gunGlow - 1, `glow @${glowAt}, shot @${shotAt}`);
  check('it radios a tell before the first heavy round', radio.some((r) => r.includes('HEAVY ROUND')));
  const heavy = w.bullets.find((x) => x.dmg >= 3);
  check('heavy shell in flight', !!heavy && heavy.speed === BOSS.gunSpeed);
  const a0 = p.armour;
  step(w, 90, () => { keep(); return frozen; }, () => p.armour < a0 || !p.alive);
  check(`heavy shell takes ${BOSS.gunDmg} armour`, a0 - p.armour === BOSS.gunDmg || (!p.alive && a0 <= BOSS.gunDmg), `${a0} -> ${p.armour}`);
  // machine guns: player close in front of the left sponson
  p.armour = p.armourMax;
  b.reload = 999;
  const sp = part(b, 'spL');
  const [sx, sy, spw, sph] = b.partRect(sp);
  p.x = Math.round(sx + spw / 2 - 8 + DX[b.dir] * 70);
  p.y = Math.round(sy + sph / 2 - 8 + DY[b.dir] * 70);
  stuck.x = p.x;
  stuck.y = p.y;
  const mg0 = b.stats.mgShots;
  const a1 = p.armour;
  step(w, 150, () => { keep(); return frozen; });
  check('machine gun bursts at a close player', b.stats.mgShots - mg0 >= BOSS.mgBurst, `${b.stats.mgShots - mg0} rounds`);
  check('machine-gun rounds take 1 armour each', p.armour < a1 && p.armour >= a1 - (b.stats.mgShots - mg0), `${a1} -> ${p.armour}`);
  p.x = Math.round(sx + spw / 2 - 8 + DX[b.dir] * 160);
  p.y = Math.round(sy + sph / 2 - 8 + DY[b.dir] * 160);
  stuck.x = p.x;
  stuck.y = p.y;
  w.bullets.length = 0;
  const mg1 = b.stats.mgShots;
  step(w, 150, () => { keep(); return frozen; });
  check('no machine gun beyond its range', b.stats.mgShots === mg1 || w.bullets.filter((x) => x.mg).every((x) => x.range > 0), `${b.stats.mgShots - mg1}`);
}

// ---------- 4b. diagonals: no safe spot off the boss's axes (aim.ts) ----------
console.log('--- diagonal fire ---');
{
  const { w, b, p } = revealed(14);
  w.freeze = 0;
  b.state = 'hunt';
  p.shield = 0;
  p.armour = p.armourMax;
  // the player 45 degrees off the hull's front (toward the middle of the map), about 110 px out, still
  const fx = b.cx < w.pxW / 2 ? 1 : -1;
  const fy = b.cy < w.pxH / 2 ? 1 : -1;
  for (let d = 0; d < 4; d++) if (DX[d] + DX[(d + 1) & 3] === fx && DY[d] + DY[(d + 1) & 3] === fy) b.dir = d;
  p.x = Math.round(b.cx - 8 + fx * 78);
  p.y = Math.round(b.cy - 8 + fy * 78);
  // open ground 150 px round the boss (it may drive a little before it fires)
  for (let cy = Math.floor((b.cy - 150) / 4); cy < (b.cy + 150) / 4; cy++) {
    for (let cx = Math.floor((b.cx - 150) / 4); cx < (b.cx + 150) / 4; cx++) w.map.set(cx, cy, EMPTY);
  }
  b.reload = 0;
  b.mg[0].t = b.mg[1].t = 1e9; // main gun only
  const stuck = { x: p.x, y: p.y };
  const frozen = () => { p.x = stuck.x; p.y = stuck.y; return { dir: -1, fire: false }; };
  const shots0 = b.stats.gunShots;
  step(w, 300, frozen, () => b.stats.gunShots > shots0);
  const heavy = w.bullets.find((x) => x.dmg >= 3);
  check('main gun fires at a player 45 degrees off its axes', !!heavy && heavy.free, heavy ? `shell vector ${heavy.ux.toFixed(2)},${heavy.uy.toFixed(2)}` : `no shot, turret ${b.ta.toFixed(2)} rad, to player ${Math.atan2(p.cx - b.cx, b.cy - p.cy).toFixed(2)}, target ${!!b.target}, dir ${b.dir}, glow ${b.glow}, reload ${b.reload}, state ${b.state}, armour ${p.armour} alive ${p.alive}, dist ${Math.hypot(p.cx - b.cx, p.cy - b.cy).toFixed(0)}, steel ${(() => { let n = 0; for (let k = 0; k < 1; k += 0.02) if (w.map.at(Math.floor((b.cx + (p.cx - b.cx) * k) / 4), Math.floor((b.cy + (p.cy - b.cy) * k) / 4)) === STEEL) n++; return n; })()}`);
  const a0 = p.armour;
  step(w, 120, frozen, () => p.armour < a0 || !p.alive);
  check('the diagonal heavy shell hits a player who sits still', a0 - p.armour === BOSS.gunDmg || (!p.alive && a0 <= BOSS.gunDmg), `${a0} -> ${p.armour}`);
  // a sidestep during the tell dodges it
  p.armour = p.armourMax;
  b.reload = 0;
  w.bullets.length = 0;
  const g0 = b.stats.gunShots;
  step(w, 300, frozen, () => b.glow >= 0);
  stuck.x -= fy * 16; // ~23 px square across the diagonal line
  stuck.y += fx * 16;
  const a1 = p.armour;
  step(w, 200, frozen, () => b.stats.gunShots > g0 && !w.bullets.some((x) => x.dmg >= 4));
  check('moving off the line during the tell dodges it', b.stats.gunShots > g0 && p.armour === a1, `${a1} -> ${p.armour}`);
  // a sponson bursts along the front diagonal at a close player
  b.reload = 1e9;
  b.glow = -1;
  const sp = part(b, 'spR');
  const [sx, sy, spw, sph] = b.partRect(sp);
  stuck.x = Math.round(sx + spw / 2 - 8 + fx * 40);
  stuck.y = Math.round(sy + sph / 2 - 8 + fy * 40);
  b.mg[0].t = b.mg[1].t = 0;
  w.bullets.length = 0;
  let diagMg = 0;
  step(w, 120, (ww) => { for (const x of ww.bullets) if (x.mg && x.free) diagMg++; return frozen(); });
  check('a sponson bursts along the diagonal', diagMg > 0, `${diagMg} frames with diagonal rounds`);
}

// ---------- 4c. a diagonal shell on brick and steel ----------
console.log('--- diagonal shell vs walls ---');
{
  const { w, b } = revealed(15);
  // a brick block well away from the boss
  const x0 = b.x > w.pxW / 2 ? 16 : w.pxW - 80;
  const y0 = b.y > w.pxH / 2 ? 16 : w.pxH - 80;
  const C = (v: number) => Math.floor(v / 4);
  for (let cy = C(y0) - 6; cy < C(y0) + 16; cy++) for (let cx = C(x0) - 6; cx < C(x0) + 16; cx++) w.map.set(cx, cy, cx >= C(x0) + 6 ? BRICK : EMPTY); // a flat wall, struck at 45 degrees
  const bricks = () => { let n = 0; for (let cy = C(y0); cy < C(y0) + 16; cy++) for (let cx = C(x0); cx < C(x0) + 16; cx++) if (w.map.at(cx, cy) === BRICK) n++; return n; };
  const n0 = bricks();
  const s = new Bullet(x0 + 6, y0 + 6, 0, 2.2, b.proxy, true, false, 0).aim(1, 1);
  s.dmg = BOSS.gunDmg;
  w.bullets.push(s);
  step(w, 60, IDLE, () => !s.alive);
  const n1 = bricks();
  check('a diagonal power shell bites a flat brick wall like a tank shell (16 px of its face, 8 px deep)', !s.alive && n0 - n1 >= 4 && n0 - n1 <= 14, `${n0 - n1} cells`);
  const s2 = new Bullet(x0 + 6, y0 + 6, 0, 2.2, b.proxy, false, false, 0).aim(1, 1);
  w.bullets.push(s2);
  step(w, 60, IDLE, () => !s2.alive);
  check('a second diagonal shell digs on along the same line', !s2.alive && bricks() < n1, `${n1 - bricks()} cells`);
}

// ---------- 5. death ----------
console.log('--- death sequence ---');
{
  const { w, b, p } = revealed(15);
  const scrap0 = w.scrap;
  const found0 = w.found.length;
  radio.length = 0;
  for (let i = 0; i < 3; i++) b.droneHit(b.cx, b.cy, ABIL.fpvDmg, 0);
  check('turret at 0: dying', b.state === 'dying', `${b.state} turret ${b.turret.hp}`);
  step(w, BOSS.dieFrames + 5);
  check('final blast: dead, wreck stays', b.state === 'dead' && b.present);
  check('death fired once', b.stats.deaths === 1 && w.stats.boss === 1);
  check(`+${BOSS.scrap} scrap`, w.scrap - scrap0 === BOSS.scrap, `${w.scrap - scrap0}`);
  check('2 captured parts', w.found.length - found0 === BOSS.captured, `${w.found.length - found0}`);
  check('radio lines: HQ and the mechanic', radio.some((r) => r.startsWith('HQ:') && r.includes('SCRAP')) && radio.some((r) => r.startsWith('SPANNER:')));
  b.droneHit(b.cx, b.cy, ABIL.fpvDmg, 0);
  shoot(w, b, p, 24, 24, 1);
  b.kill();
  step(w, 30);
  check('hits on the wreck do nothing more', b.stats.deaths === 1 && w.stats.boss === 1 && w.scrap - scrap0 === BOSS.scrap);
  check('the wreck still blocks tanks', w.blockedAt(w.players[0]!, b.x + 16, b.y - 15));
  const n = step(w, 600, IDLE, () => !!w.done);
  check('region clear follows', w.done === 'clear', `after ${n} frames (towns freed ${w.towns.filter((t) => t.freed).length}/${w.towns.length})`);
}

// ---------- 6. saves: a fresh world for the same region has a fresh boss ----------
console.log('--- restart ---');
{
  const a = world(16);
  a.b.kill();
  const c = world(16);
  check('same region again: boss hidden, full hp, same lair', c.b.state === 'hidden' && c.b.parts.every((q) => q.hp === q.max) && c.b.lair.join() === a.b.lair.join());
}

// ---------- 7. it drives at the player along roads, crushing brick ----------
console.log('--- movement ---');
{
  const { w, b, p } = world(17);
  for (const t of w.towns.slice(0, 3)) w.freeTown(t);
  step(w, 31, IDLE, () => b.state !== 'hidden');
  for (const e of w.enemies) e.alive = false;
  if (w.ai) w.ai.update = () => {};
  if (w.tricks) w.tricks.update = () => {};
  p.shield = 1e9;
  // park the player 130-168 px from it (inside its wake range) on open ground
  let spot: [number, number] | null = null;
  for (let r = 130; r < 168 && !spot; r += 6) {
    for (let a = 0; a < 16 && !spot; a++) {
      const x = Math.round((b.cx + Math.cos(a / 16 * Math.PI * 2) * r - 8) / 8) * 8;
      const y = Math.round((b.cy + Math.sin(a / 16 * Math.PI * 2) * r - 8) / 8) * 8;
      if (x >= 0 && y >= 0 && x <= w.pxW - 16 && y <= w.pxH - 16 && !w.map.solidForTank(x, y, false) && !w.tankIn(x, y, 16, 16)) spot = [x, y];
    }
  }
  if (spot) [p.x, p.y] = spot;
  const d0 = Math.hypot(p.cx - b.cx, p.cy - b.cy);
  const t0 = performance.now();
  step(w, 60 * 25, () => { p.x = spot![0]; p.y = spot![1]; return IDLE; });
  const d1 = Math.hypot(p.cx - b.cx, p.cy - b.cy);
  check('wakes and closes in on the player', b.state === 'hunt' && d1 < d0 - 30, `${Math.round(d0)} -> ${Math.round(d1)} px, steps ${b.stats.steps}, paths ${b.stats.paths}`);
  check('never on steel', !w.map.any(b.x, b.y, 48, 48, (c) => c === STEEL));
  check('boss update cost', b.stats.msSum / b.stats.n < 0.2 && b.stats.msMax < 8, `avg ${(b.stats.msSum / b.stats.n).toFixed(3)} ms, max ${b.stats.msMax.toFixed(2)} ms, path avg ${(b.stats.pathMs / Math.max(1, b.stats.paths)).toFixed(2)} ms, ${((performance.now() - t0) / 1500).toFixed(3)} ms per world update`);
}

// ---------- 8. the region bot against the boss ----------
console.log('--- region bot vs the boss (towns 1-3 freed for it, 2 drone charges, 6 min) ---');
{
  let wins = 0;
  const seeds = [21, 22, 23, 24, 25, 26];
  for (const seed of seeds) {
    const { w, b } = world(seed);
    w.unlocked = [true, false, false, true];
    w.charges = [2, 0, 0, 3];
    w.ps[0].lives = 4;
    for (const t of w.towns.slice(0, 3)) w.freeTown(t);
    let upd = 0;
    let updMax = 0;
    let f = 0;
    let killedAt = -1;
    while (!w.done && f < 60 * 360) {
      const t0 = performance.now();
      step(w, 1, (ww) => regionBot(ww));
      const dt = performance.now() - t0;
      upd += dt;
      updMax = Math.max(updMax, dt);
      if (killedAt < 0 && b.stats.deaths) killedAt = f;
      f++;
    }
    if (b.stats.deaths) wins++;
    console.log(`seed ${seed}: ${w.done || 'timeout'}@${Math.round(f / 60)}s boss ${b.state}${killedAt >= 0 ? ` killed @${Math.round(killedAt / 60)}s` : ''}`
      + ` parts lost ${b.stats.partsLost} turret ${b.turret.hp}/${b.turret.max} | shells ${b.stats.shellHits} (no pen ${b.stats.noPen}) drones ${b.stats.droneHits}`
      + ` | boss fired ${b.stats.gunShots} heavy, ${b.stats.mgShots} mg; knockouts ${w.stats.knockouts} | update avg ${(upd / f).toFixed(3)} ms max ${updMax.toFixed(1)} ms`);
  }
  check('the region bot beats the boss sometimes', wins >= 1, `${wins}/${seeds.length}`);
}

check('no exceptions', exceptions === 0, String(exceptions));
console.log(fails ? `boss sim: ${fails} FAILED` : 'boss sim: all checks pass');
process.exit(fails ? 1 : 0);
