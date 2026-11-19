// Campaign balance sweep (npm run balance): the region bot plays every region kind on several map seeds, the way a
// run reaches it (crew, veterancy, a few parts and charges from the earlier regions), retreating and trying again
// with the retreat bonuses until it clears or runs out of attempts. Prints one row per region and seed, then a
// summary per region: clears, retreats, knockouts, minutes to free the towns and to kill the boss, scrap, parts.
// The bot is weaker than a player (no dodging tells, few abilities): aim for most regions cleared in 0-3 retreats.
// Usage: npm run balance [-- --regions 0,1,2 --seeds 8 --seed0 1 --attempts 4 --limit 30]
// Debug one run: node dist-sim/balance/balance.js --regions 4 --seeds 1 --attempts 1 --trace [--every 10] [--bullets]
// (--trace prints the bot, towns and boss every N seconds; --bullets where the player's shells died).
// Timeouts are the bot stuck, not the player losing; they still count as a retreat for the next attempt.
import { regionBot } from '../src/game/bot';
import { RECRUIT_ORDER, crewTick, ensureCrew } from '../src/game/crew';
import { newRun, type Loadout, type RunState } from '../src/game/run';
import { regionName, regionWorld, syncRun } from '../src/game/save';
import { newPState, type World } from '../src/game/world';

const arg = (k: string, d: string) => {
  const i = process.argv.indexOf(`--${k}`);
  return i >= 0 ? process.argv[i + 1] : d;
};
const REGIONS = arg('regions', '0,1,2,3,4').split(',').map(Number);
const SEEDS = Number(arg('seeds', '8'));
const ATTEMPTS = Number(arg('attempts', '4'));
const LIMIT = Number(arg('limit', '30')) * 60 * 60; // frames per attempt
const SEED0 = Number(arg('seed0', '1'));
const TRACE = process.argv.includes('--trace');
const TRACE_S = Number(arg('every', '20'));
const BULLETS = process.argv.includes('--bullets');
const DEATHS = new Map<string, number>();
/** armour lost by source, per region */
let DMG: Record<string, number> = {};
/** knockouts by the source of the last hit, per region */
let KO: Record<string, number> = {};
/** scrap gained (+) and spent (-) by the code that changed it, per region */
let SCRAP: Record<string, number> = {};

/** What a run typically carries into region i: recruits from the regions before it (one each), veterancy, cheap parts, charges. */
function runAt(i: number, seed: number): RunState {
  const run = newRun(seed);
  run.region = i;
  const crew = ensureCrew(run);
  for (const id of RECRUIT_ORDER.slice(0, Math.min(RECRUIT_ORDER.length, i))) crew.push({ id, lv: 1 + (i >= 3 ? 1 : 0), xp: 0 });
  for (const m of crew) if (i >= 2) m.lv = Math.max(m.lv, 2);
  run.vet = [Math.min(3, i), 0];
  const kit: Loadout = {};
  if (i >= 1) kit.armour = 'scrap-plates';
  if (i >= 2) kit.barrel = 'long-100';
  if (i >= 3) { kit.tracks = 'wide-tracks'; kit.jammer = 'aerial-jammer'; }
  run.fitted = [kit, {}];
  run.charges = [i >= 1 ? 1 : 0, i >= 1 ? 1 : 0, i >= 2 ? 1 : 0, 2];
  run.scrap = 60 * i;
  return run;
}

interface Attempt {
  outcome: string;
  secs: number;
  knockouts: number;
  towns: string;
  /** seconds to the boss reveal / all towns freed / the boss kill (-1 = never) */
  reveal: number;
  allTowns: number;
  bossKill: number;
  scrap: number;
  parts: number;
  boss: string;
}

function play(run: RunState): Attempt {
  const ps = [newPState(), newPState()];
  const w: World = regionWorld(run, ps, 1);
  const scrap0 = w.scrap;
  // where the scrap came from and went: the method that changed w.scrap (World.freeTown, a boss's die, ...)
  let scrapV = w.scrap;
  const caller = () => (new Error().stack?.split('\n')[3] ?? '').trim().replace(/^at (?:Object\.)?([\w$.<>]+).*$/, '$1');
  Object.defineProperty(w, 'scrap', {
    configurable: true,
    get: () => scrapV,
    set: (v: number) => {
      if (v !== scrapV) { const k = `${v > scrapV ? '+' : '-'}${caller()}`; SCRAP[k] = (SCRAP[k] ?? 0) + Math.abs(v - scrapV); }
      scrapV = v;
    },
  });
  // where the armour went: enemy tanks by type, the boss, tricks (drones, artillery, mines, AT teams)
  const hp = w.hitPlayer.bind(w);
  w.hitPlayer = (t, by, dmg) => {
    const before = t.armour;
    hp(t, by, dmg);
    const lost = Math.max(0, before - t.armour) || (t.alive ? 0 : before);
    const k = by && w.enemies.includes(by) ? `tank${by.etype}` : dmg !== undefined ? 'boss' : 'trick';
    DMG[k] = (DMG[k] ?? 0) + lost;
    if (before > 0 && (t.armour <= 0 || !t.alive)) KO[k] = (KO[k] ?? 0) + 1; // the hit that knocked it out
  };
  let f = 0;
  let reveal = -1;
  let allTowns = -1;
  let bossKill = -1;
  let scrapIn = 0;
  let last = w.scrap;
  while (!w.done && f < LIMIT) {
    const mine = BULLETS ? w.bullets.filter((b) => b.owner.isPlayer) : [];
    w.update([regionBot(w)]);
    if (BULLETS) for (const b of mine) if (!b.alive) { const k = `${Math.round(b.x / 8) * 8},${Math.round(b.y / 8) * 8}`; DEATHS.set(k, (DEATHS.get(k) ?? 0) + 1); }
    if (BULLETS && f % (60 * TRACE_S) === 0 && DEATHS.size) { console.log('  shells died at', [...DEATHS].sort((a, b) => b[1] - a[1]).slice(0, 8).map(([k, v]) => `${k}x${v}`).join(' ')); DEATHS.clear(); }
    w.map.takeDirty();
    w.ev.length = 0;
    w.decals.length = 0;
    w.notes.length = 0;
    w.popups.length = 0;
    w.radio.length = 0;
    crewTick(w, run);
    if (w.scrap > last) scrapIn += w.scrap - last;
    last = w.scrap;
    syncRun(w, run);
    if (reveal < 0 && w.boss?.revealed) reveal = f;
    if (allTowns < 0 && w.towns.length && w.towns.every((t) => t.freed)) allTowns = f;
    if (bossKill < 0 && w.boss && (w.boss.state === 'dead' || w.boss.state === 'dying')) bossKill = f;
    if (TRACE && f % (60 * TRACE_S) === 0) {
      const p = w.players[0];
      const near = w.enemies.filter((e) => e.alive && p && Math.abs(e.cx - p.cx) + Math.abs(e.cy - p.cy) < 130).length;
      console.log(`  t ${(f / 60).toFixed(0)}s p ${p ? `${Math.round(p.cx)},${Math.round(p.cy)} a${p.armour}` : '-'} enemies ${w.enemies.length} near ${near} towns ${w.towns.map((t) => (t.freed ? 'F' : t.progress.toFixed(1))).join(' ')} boss ${w.boss?.state} ${w.boss ? `${Math.round(w.boss.cx)},${Math.round(w.boss.cy)} aim ${w.boss.aimPoint().map(Math.round)} parts ${w.boss.parts.map((q) => `${q.short}${q.hp}`).join(' ')} exposed ${w.boss.exposed()} dir ${p?.dir} stats ${JSON.stringify((w.boss as unknown as { stats: object }).stats).slice(0, 260)}` : ''}`);
    }
    f++;
  }
  syncRun(w, run);
  const ts = w.tricks?.stats;
  if (ts) for (const k of ['bombHits', 'rocketHits', 'minesHit', 'artHits'] as const) DMG[`#${k}`] = (DMG[`#${k}`] ?? 0) + ts[k];
  const s = w.stats;
  const b = w.boss;
  const bossTxt = b ? `${b.kind} ${b.state} ${b.parts.filter((p) => p.hp <= 0).length}/${b.parts.length}` : '-';
  void scrap0;
  return {
    outcome: w.done === 'clear' ? 'CLEAR' : w.done === 'over' ? 'RETREAT' : 'TIMEOUT',
    secs: f / 60, knockouts: s.knockouts, towns: `${w.towns.filter((t) => t.freed).length}/${w.towns.length}`,
    reveal: reveal / 60, allTowns: allTowns / 60, bossKill: bossKill / 60, scrap: scrapIn, parts: s.partsPicked + s.depots + s.boss,
    boss: bossTxt,
  };
}

const m = (s: number) => (s < 0 ? '  -  ' : (s / 60).toFixed(1).padStart(5));
const summary: string[] = [];
const t0 = performance.now();
for (const ri of REGIONS) {
  const rows: { clear: boolean; stuck: number; retreats: number; mins: number; ko: number; towns: number[]; boss: number[]; scrap: number; parts: number }[] = [];
  console.log(`--- region ${ri + 1} ${regionName(ri)} ---`);
  DMG = {};
  KO = {};
  SCRAP = {};
  for (let k = 0; k < SEEDS; k++) {
    const seed = SEED0 + k;
    const run = runAt(ri, seed * 7919);
    const log: string[] = [];
    let clear = false;
    let mins = 0;
    let ko = 0;
    let scrap = 0;
    let parts = 0;
    const towns: number[] = [];
    const boss: number[] = [];
    let retreats = 0;
    let stuck = 0;
    for (let a = 0; a < ATTEMPTS && !clear; a++) {
      const r = play(run);
      mins += r.secs / 60;
      ko += r.knockouts;
      scrap += r.scrap;
      parts += r.parts;
      if (r.allTowns >= 0) towns.push(r.allTowns);
      if (r.bossKill >= 0) boss.push(r.bossKill);
      log.push(`${r.outcome}@${m(r.secs).trim()}m ko ${r.knockouts} towns ${r.towns} (reveal ${m(r.reveal).trim()}, all ${m(r.allTowns).trim()}) boss ${r.boss} kill ${m(r.bossKill).trim()}`);
      if (r.outcome === 'TIMEOUT') stuck++;
      if (r.outcome === 'CLEAR') clear = true;
      else {
        // a timeout counts as a retreat too: the player would have lost the map eventually or given up
        retreats++;
        run.retreats++;
        run.regionRetreats = (run.regionRetreats ?? 0) + 1;
      }
    }
    rows.push({ clear, stuck, retreats, mins, ko, towns, boss, scrap, parts });
    console.log(`seed ${seed}: ${clear ? 'CLEARED' : 'FAILED '} retreats ${retreats} total ${mins.toFixed(1)}m ko ${ko} scrap +${scrap} parts ${parts}\n    ${log.join('\n    ')}`);
  }
  const n = rows.length;
  const avg = (f: (r: (typeof rows)[number]) => number) => (rows.reduce((s, r) => s + f(r), 0) / n);
  const flat = (k: 'towns' | 'boss') => rows.flatMap((r) => r[k]);
  const mean = (a: number[]) => (a.length ? a.reduce((s, x) => s + x, 0) / a.length : -1);
  summary.push(`${String(ri + 1).padStart(2)} ${regionName(ri).padEnd(14)} cleared ${rows.filter((r) => r.clear).length}/${n}`
    + `  retreats ${avg((r) => r.retreats).toFixed(1)} (max ${Math.max(...rows.map((r) => r.retreats))}, ${rows.reduce((s, r) => s + r.stuck, 0)} of them bot timeouts)  minutes ${avg((r) => r.mins).toFixed(1)}`
    + `  knockouts ${avg((r) => r.ko).toFixed(1)}  towns free @${m(mean(flat('towns'))).trim()}m  boss dead @${m(mean(flat('boss'))).trim()}m`
    + `  scrap +${Math.round(avg((r) => r.scrap))}  parts ${avg((r) => r.parts).toFixed(1)}`
    + `
     armour lost per seed (#: trick hits): ${Object.entries(DMG).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k} ${(v / n).toFixed(0)}`).join(', ')}`
    + `
     knockouts per seed by last hit: ${Object.entries(KO).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k} ${(v / n).toFixed(2)}`).join(', ') || '-'}`
    + `
     scrap per seed by source: ${Object.entries(SCRAP).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k} ${(v / n).toFixed(0)}`).join(', ') || '-'}`);
}
console.log(`--- summary (bot, ${SEEDS} seeds, up to ${ATTEMPTS} attempts of ${LIMIT / 3600} min; ${((performance.now() - t0) / 1000).toFixed(0)} s) ---`);
console.log(summary.join('\n'));
