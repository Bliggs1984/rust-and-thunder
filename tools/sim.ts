// Headless balance check: runs the game logic without graphics.
// Build + run: npx vite build --ssr tools/sim.ts --outDir dist-sim && node dist-sim/sim.js [--preview]
import { regionBot } from '../src/game/bot';
import { BRICK, DOWN, EMPTY, STEEL, UP, WATER } from '../src/game/constants';
import {
  aboard, allCrew, craftCost, crewDebug, crewTick, crewUnlocks, ensureCrew, joinCrew, deferCrew, nightEyesRange, recruitOffer, repairCost, RECRUIT_ORDER, starterCrew,
  waitingRecruit, type CrewMember,
} from '../src/game/crew';
import { makeTestRegion, regionReach, type RegionSpec, type Town } from '../src/game/region';
import { newRun, type RunState } from '../src/game/run';
import { REGION_EASE, SAVE_KEY, bonusLives, easeFor, loadRun, regionName, regionProgress, regionWorld, retreatEase, saveRun, syncRun, validRun } from '../src/game/save';
import { Bullet, DEPOT_HP, DEPOT_SCRAP, FREE_SCRAP, Tank, World, newPState, type PInput } from '../src/game/world';
import {
  answerBriefing, briefingDue, briefingPages, completeCampaign, completeRows, debriefLine, effectiveReward, endingPages, introQuote,
  noteRegionClear, regionHint, storyState, STORY_REGIONS,
} from '../src/game/story'; // Phase 5 story
import { FONT } from '../src/art/font';
import { arenaSpec, type TricksArena } from '../src/game/arena';

function bot(w: World): PInput {
  const t = w.players[0];
  if (!t || t.spawn) return { dir: -1, fire: false };
  let best: { cx: number; cy: number } | null = null;
  let bd = Infinity;
  for (const e of w.enemies) {
    if (!e.alive || e.spawn) continue;
    const d = Math.abs(e.cx - t.cx) + Math.abs(e.cy - t.cy);
    if (d < bd) { bd = d; best = e; }
  }
  if (!best) return { dir: (w.frame >> 6) % 2 ? 1 : 3, fire: true };
  const dx = best.cx - t.cx;
  const dy = best.cy - t.cy;
  const wobble = (w.frame >> 5) % 5 === 0;
  let dir: number;
  if (Math.abs(dx) < 6) dir = dy < 0 ? 0 : 2;
  else if (Math.abs(dy) < 6) dir = dx < 0 ? 3 : 1;
  else dir = (Math.abs(dx) < Math.abs(dy)) !== wobble ? (dx < 0 ? 3 : 1) : dy < 0 ? 0 : 2;
  const f = t.dir;
  const hitsBase = w.hasBase && (f === 1 || f === 3 ? t.cy > 178 && (f === 1 ? t.cx < 120 : t.cx > 88) : t.cx > 82 && t.cx < 126 && f === 2);
  return { dir, fire: !hitsBase };
}

for (const mode of ['idle', 'bot'] as const) {
  const rows: string[] = [];
  for (let stage = 1; stage <= 10; stage++) {
    const runs: string[] = [];
    for (let run = 0; run < 4; run++) {
      const ps = [newPState(), newPState()];
      const w = new World(stage, ps, 1);
      let f = 0;
      while (!w.done && f < 60 * 300) {
        w.update([mode === 'bot' ? bot(w) : { dir: -1, fire: false }]);
        w.ev.length = 0;
        f++;
      }
      const why = w.done === 'clear' ? 'CLEAR' : w.done === 'over' ? (w.eagleAlive ? 'dead' : 'base') : 'timeout';
      const bk = w.baseKiller;
      runs.push(`${why}@${Math.round(f / 60)}s` + (bk ? `[p${bk.persona} d${bk.dist} ${'URDL'[bk.dir]} ${bk.bx},${bk.by}]` : ''));
    }
    rows.push(`stage ${String(stage).padStart(2)}: ${runs.join('  ')}`);
  }
  console.log(`--- ${mode} ---\n${rows.join('\n')}`);
}


// ---------- region mode (campaign region, no base) ----------
/** A region without towns (the Phase 0 test region) gets two, so the sim exercises freeing: the emptiest 64 px
 * squares far from the player spawn, cleared, with garrison spawns in two corners. Regions that bring towns are kept. */
function withTowns(spec: RegionSpec): RegionSpec {
  if (spec.towns?.length) return spec;
  const sx = spec.playerSpawns[0][0];
  const sy = spec.playerSpawns[0][1];
  const solid = (x: number, y: number, w: number, h: number) => {
    let n = 0;
    for (let cy = y >> 2; cy < (y + h) >> 2; cy++) {
      for (let cx = x >> 2; cx < (x + w) >> 2; cx++) {
        const c = spec.cells[cy * spec.w + cx];
        if (c === BRICK || c === STEEL || c === WATER) n++;
      }
    }
    return n;
  };
  const cands: { x: number; y: number; n: number }[] = [];
  for (let y = 32; y + 96 < spec.h * 4; y += 32) {
    for (let x = 32; x + 96 < spec.w * 4; x += 32) {
      if (Math.hypot(x - sx, y - sy) < 220) continue;
      cands.push({ x, y, n: solid(x, y, 64, 64) });
    }
  }
  cands.sort((a, b) => a.n - b.n);
  const picks: { x: number; y: number }[] = [];
  for (const c of cands) {
    if (picks.length < 2 && picks.every((p) => Math.hypot(p.x - c.x, p.y - c.y) > 260)) picks.push(c);
  }
  const names = ['TYKHE POLE', 'BRODNA'];
  const clear = (x: number, y: number, w: number, h: number) => {
    for (let yy = y >> 2; yy < (y + h) >> 2; yy++) for (let xx = x >> 2; xx < (x + w) >> 2; xx++) spec.cells[yy * spec.w + xx] = EMPTY;
  };
  const towns: Town[] = picks.map((p, i) => {
    const cx = p.x + 32;
    const cy = p.y + 32;
    clear(cx - 12, cy - 12, 24, 24);
    const garrison: [number, number][] = [[p.x + 4, p.y + 4], [p.x + 44, p.y + 4], [p.x + 4, p.y + 44], [p.x + 44, p.y + 44]];
    for (const g of garrison) clear(g[0], g[1], 16, 16);
    return { name: names[i], rect: [p.x, p.y, 64, 64], cx, cy, garrison };
  });
  spec.towns = towns;
  for (const t of towns) spec.enemySpawns.push(...t.garrison.slice(0, 2));
  return spec;
}

console.log('--- region (bot, 60*240 frames; towns added if the generator gives none) ---');
const preview = process.argv.includes('--preview');
const tot = { kills: 0, deaths: 0, hits: 0, scrap: 0, parts: 0, towns: 0, patches: 0, runs: 0 };
for (const seed of [1, 2, 3, 4, 5, 6]) {
  const tg0 = performance.now();
  const spec = withTowns(makeTestRegion(seed));
  const genMs = performance.now() - tg0;
  const reach = regionReach(spec);
  const ps = [newPState(), newPState()];
  ps[0].lives = 9;
  const w = new World(1, ps, 1, spec);
  w.map.takeDirty();
  let upd = 0;
  let updMax = 0;
  let f = 0;
  let firstFree = -1;
  const log: string[] = [];
  while (!w.done && f < 60 * 240) {
    const t0 = performance.now();
    w.update([regionBot(w)]);
    const dt = performance.now() - t0;
    upd += dt;
    updMax = Math.max(updMax, dt);
    if (firstFree < 0 && w.stats.townsFreed) firstFree = f;
    w.map.takeDirty();
    for (const m of w.radio) log.push(m.text);
    w.radio.length = 0;
    w.ev.length = 0;
    w.decals.length = 0;
    w.notes.length = 0;
    w.popups.length = 0;
    f++;
  }
  const s = w.stats;
  const kills = ps[0].kills.reduce((a, b) => a + b, 0);
  const why = w.done === 'clear' ? 'CLEAR' : w.done === 'over' ? 'dead' : 'timeout';
  console.log(
    `seed ${seed}: ${spec.w}x${spec.h} cells, gen ${genMs.toFixed(0)}ms, ${spec.towns?.length ?? 0} towns, reach ${reach.ok ? 'ok' : 'FAIL ' + reach.unreachable.length}` +
    ` | ${why}@${Math.round(f / 60)}s kills ${kills}/${spec.enemies} knockouts ${s.knockouts} hits ${s.hits}` +
    ` | scrap picked ${s.scrapPicked} (now ${w.scrap}) parts ${s.partsPicked} patches ${s.patches} towns freed ${s.townsFreed}/${w.towns.length}${firstFree >= 0 ? ` (first @${Math.round(firstFree / 60)}s)` : ''}` +
    ` vet ${ps[0].vet}+${ps[0].vetXp.toFixed(2)} | update avg ${(upd / f).toFixed(3)}ms max ${updMax.toFixed(2)}ms` +
    (w.boss ? ` | boss ${w.boss.state} parts lost ${w.boss.stats.partsLost} turret ${w.boss.turret.hp}` : ''),
  );
  if (seed === 1 && log.length) console.log(`  radio: ${log.join(' / ')}`);
  tot.kills += kills;
  tot.deaths += s.knockouts;
  tot.hits += s.hits;
  tot.scrap += s.scrapPicked;
  tot.parts += s.partsPicked;
  tot.towns += s.townsFreed;
  tot.patches += s.patches;
  tot.runs++;
  if (preview && seed === 1) {
    // one char per 2x2 cells: . ground  # brick  @ steel  ~ water  % trees  - ice
    const ch = ['.', '#', '@', '~', '%', '-'];
    const fresh = withTowns(makeTestRegion(seed));
    for (let y = 0; y < fresh.h; y += 2) {
      let line = '';
      for (let x = 0; x < fresh.w; x += 2) {
        const cnt = [0, 0, 0, 0, 0, 0, 0];
        for (const [ox, oy] of [[0, 0], [1, 0], [0, 1], [1, 1]]) cnt[fresh.cells[(y + oy) * fresh.w + x + ox]]++;
        let bi = 0;
        let bc = 1;
        for (const k of [2, 3, 5, 1, 4]) if (cnt[k] > bc) { bc = cnt[k]; bi = k; }
        line += ch[bi];
      }
      console.log(line);
    }
  }
}
console.log(`totals over ${tot.runs} runs: kills ${tot.kills}, knockouts ${tot.deaths}, hits ${tot.hits}, scrap ${tot.scrap}, parts ${tot.parts}, towns freed ${tot.towns}, patches ${tot.patches}`);

// ---------- ?arena=tricks: the test map's staged targets and tricks ----------
function arenaChecks(): void {
  console.log('--- arena (?arena=tricks) ---');
  const spec = arenaSpec('tricks')!;
  check(!!spec && arenaSpec('x') === null, 'arena: spec for tricks only');
  const run = newRun(11);
  run.crew = allCrew();
  run.charges = [9, 9, 9, 9];
  const ps = [newPState(), newPState()];
  const w = regionWorld(run, ps, 1, 0, spec);
  const a = w.arena as TricksArena | null;
  check(!!a && !w.boss && !w.events && !w.keepsProgress && w.tricks?.on === true, 'arena: hook on, no boss/events/progress, tricks on');
  check(w.unlocked.every(Boolean) && w.charges.every((c) => c === 9) && ps[0].lives === 9, `arena: all abilities, 9 charges, 9 lives (${w.charges} ${ps[0].lives})`);
  check(!!a?.wounded && a.wounded.hp === 1 && !!a.passing, 'arena: wounded (1 hp) and passing tanks');
  const x0 = a!.passing!.x;
  for (let i = 0; i < 300; i++) w.update([{ dir: -1, fire: false }]);
  const tr = w.tricks!;
  check(tr.mines.length === 4 && tr.mines.every((m) => m.alive && !m.shown), `arena: 4 hidden mines (${tr.mines.length})`);
  check(tr.teams.length === 1 && tr.teams[0].alive && !tr.teams[0].shown, 'arena: one hidden rocket team');
  check(a!.passing!.x > x0 + 20 && a!.wounded!.x === 256, `arena: the passing tank drives (${x0} -> ${a!.passing!.x}), the wounded one stays`);
  check(tr.drones.length >= 1, 'arena: an enemy drone flies in');
  // the artillery pad: a barrage when the tank is on it
  const p = w.players[0]!;
  p.x = 88;
  p.y = 240;
  w.update([{ dir: -1, fire: false }]);
  check(!!tr.barrage, 'arena: the pad calls a barrage');
  // the wounded tank dies to one hit and comes back
  w.killEnemy(a!.wounded!, 0);
  for (let i = 0; i < 400; i++) {
    const t = w.players[0];
    if (t) t.shield = 99;
    w.update([{ dir: -1, fire: false }]);
  }
  check(!!a!.wounded?.alive && a!.wounded.hp === 1, 'arena: the wounded tank comes back');
  check(!w.done && w.enemies.length <= 3, `arena: never clears, no other enemies (${w.done || 'running'}, ${w.enemies.length})`);
}

// ---------- region progress (play test fix): CONTINUE and retreats keep freed towns and destroyed depots ----------
function progressChecks(): void {
  console.log('--- region progress (CONTINUE / retreat keep freed towns) ---');
  let run = newRun(5151);
  ensureCrew(run);
  const ps = [newPState(), newPState()];
  let w = regionWorld(run, ps, 1);
  check(w.keepsProgress && w.towns.length >= 3 && w.depots.length >= 1, `progress: campaign map keeps progress (${w.towns.length} towns, ${w.depots.length} depots)`);
  const [a, b, c] = w.towns;
  const d = w.depots[0];
  w.freeTown(b);
  w.freeTown(a);
  w.destroyDepot(d, 0);
  syncRun(w, run);
  check(same(run.progress, { region: 0, towns: [b.name, a.name], depots: [d.name] }), `progress: freed towns in order, depot saved (${JSON.stringify(run.progress)})`);
  const scrap = run.scrap;
  run = roundTrip(run, 'progress');
  // CONTINUE: a fresh World from the loaded run
  w = regionWorld(run, ps, 1);
  check(a.name !== b.name && w.towns.filter((t) => t.freed).map((t) => t.name).sort().join() === [a.name, b.name].sort().join(), 'CONTINUE: freed towns are freed again');
  check(w.checkpoint?.name === a.name, `CONTINUE: checkpoint is the last town freed (${w.checkpoint?.name})`);
  check(w.depots.find((x) => x.name === d.name)?.destroyed === true && !w.depotBlocks(d.cx - 8, d.cy - 8), 'CONTINUE: destroyed depot stays destroyed');
  check(w.stats.townsFreed === 0 && w.stats.depots === 0 && w.scrap === scrap, 'CONTINUE: kept towns and depots are not paid twice');
  check(!w.boss || w.boss.state === 'hidden', `CONTINUE: the boss restarts (${w.boss?.state})`);
  const p0 = w.players[0]!;
  check(Math.hypot(p0.x - w.region!.playerSpawns[0][0], p0.y - w.region!.playerSpawns[0][1]) < 1, 'CONTINUE: the tank starts at the road');
  for (let i = 0; i < 240; i++) w.update([{ dir: -1, fire: false }]);
  syncRun(w, run);
  check(w.towns.filter((t) => t.freed).length === 2 && same(regionProgress(run)?.towns, [b.name, a.name]), 'CONTINUE: kept towns stay freed in play');
  check(!w.enemies.some((e) => e.alive && [a, b].some((t) => e.cx >= t.rect[0] && e.cx < t.rect[0] + t.rect[2] && e.cy >= t.rect[1] && e.cy < t.rect[1] + t.rect[3])), 'CONTINUE: no garrison appears in a kept town');
  // freeing another moves the checkpoint; a town the enemy retakes drops out
  const c2 = w.towns.find((t) => t.name === c.name)!;
  w.freeTown(c2);
  syncRun(w, run);
  check(same(run.progress?.towns, [b.name, a.name, c.name]), `progress: third town appended (${JSON.stringify(run.progress)} vs ${[a.name, b.name, c.name]})`);
  c2.freed = false;
  w.checkpoint = w.towns.find((t) => t.name === a.name)!;
  syncRun(w, run);
  check(same(run.progress?.towns, [b.name, a.name]), 'progress: a retaken town is dropped');
  // a retreat keeps them too
  run.regionRetreats = 1;
  w = regionWorld(run, ps, 1);
  check(w.towns.filter((t) => t.freed).length === 2 && w.checkpoint?.name === a.name, 'retreat: freed towns kept');
  // quick tests neither restore nor save it; progress of another region is ignored; region clear drops it
  const q = regionWorld(run, ps, 1, 7);
  check(!q.keepsProgress && !q.towns.some((t) => t.freed), 'quick test map: progress not applied');
  run.progress!.region = 1;
  w = regionWorld(run, ps, 1);
  check(!w.towns.some((t) => t.freed) && regionProgress(run) === null, 'progress of another region is ignored');
  // old saves without progress load; malformed progress is no save
  const old = JSON.parse(JSON.stringify(run)) as RunState;
  delete old.progress;
  check(validRun(old), 'save without progress is valid');
  check(!validRun({ ...old, progress: { region: -1, towns: [], depots: [] } }) && !validRun({ ...old, progress: { region: 0, towns: [1], depots: [] } })
    && !validRun({ ...old, progress: { region: 0, towns: [] } }) && !validRun({ ...old, progress: [] }), 'bad progress rejected');
  // retreat card: only the retreat bonus (Farmland has its own base ease on top)
  const r1 = newRun(1);
  r1.regionRetreats = 1;
  check(Math.round(retreatEase(r1) * 100) === 10 && Math.round(easeFor(r1) * 100) === Math.round((REGION_EASE[0] + 0.1) * 100), `retreat ease shows the bonus only (${retreatEase(r1)})`);
  r1.region = 2;
  r1.regionRetreats = 2;
  check(Math.round(retreatEase(r1) * 100) === 20, 'retreat ease: 10% per retreat');
}

// ---------- campaign run loop (Phase 2): two regions with the region bot, a retreat, region clears, depots, and
// save/load round trips through an in-memory localStorage ----------
console.log('--- run loop (2 regions, region bot, in-memory localStorage) ---');
const mem = new Map<string, string>();
(globalThis as { localStorage?: unknown }).localStorage = {
  getItem: (k: string) => mem.get(k) ?? null,
  setItem: (k: string, v: string) => void mem.set(k, String(v)),
  removeItem: (k: string) => void mem.delete(k),
  clear: () => mem.clear(),
  key: (i: number) => [...mem.keys()][i] ?? null,
  get length() { return mem.size; },
};
const fails: string[] = [];
const check = (ok: boolean, msg: string) => { if (!ok) fails.push(msg); };
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
/** Save, load back, and check nothing changed (and that the run survives a plain JSON round trip). */
const roundTrip = (run: RunState, label: string): RunState => {
  check(same(JSON.parse(JSON.stringify(run)), run) && validRun(JSON.parse(JSON.stringify(run))), `${label}: RunState JSON round trip`);
  saveRun(run);
  const back = loadRun();
  check(!!back && same(back, run), `${label}: save/load round trip`);
  return back ?? run;
};
const LIMIT = 60 * 180;
try {
  const run0 = newRun(4242);
  ensureCrew(run0);
  check(same(run0.crew!.map((m) => m.id), ['mykola', 'yurko']), 'a new run starts with TRACTOR and SPANNER');
  let run = roundTrip(run0, 'new run');
  let attempts = 0;
  let forcedRetreat = false;
  let forcedClears = 0;
  // ---------- Phase 3 crew: recruiting as the app does it (crew.ts); region 2's first offer is declined ----------
  let declined = '';
  const crewLog: string[] = [];
  const crewStep = (w: World) => {
    crewTick(w, run);
    // one recruit per region, once its 2nd town is freed (the app shows the card; the sim answers at once)
    {
      const d = recruitOffer(run, w.towns.reduce((n, t) => n + (t.freed ? 1 : 0), 0));
      if (d) {
        const town = w.checkpoint?.name ?? '';
        if (run.region === 1 && !declined) {
          declined = d.id;
          deferCrew(run, d.id, town);
          crewLog.push(`${d.call} NOT NOW`);
        } else {
          const before = w.charges[d.unlock] ?? 0;
          joinCrew(run, d.id, town, w);
          crewLog.push(`${d.call} joined @${town}`);
          if (d.unlock >= 0 && d.unlock < 3) check(w.unlocked[d.unlock] && w.charges[d.unlock] === before + 1, `${d.call}: unlocks ability ${d.unlock} with one charge`);
        }
      }
    }
  };
  while (run.region < 2 && attempts < 8) {
    attempts++;
    // Phase 5: the run flow shows the region's briefing first (once); the sim answers it like a player would
    if (briefingDue(run)) storyStep(run, attempts);
    else check(storyState(run).briefed.includes(run.region), `attempt ${attempts}: region ${run.region} briefed once`);
    const ps = [newPState(), newPState()];
    const w = regionWorld(run, ps, 1);
    const crewBefore = run.crew!.length;
    check(same(w.unlocked, crewUnlocks(run.crew)) && w.perks.size === aboard(run.crew).length, `attempt ${attempts}: crew applied to the world`);
    check(ps[0].lives === 2 + bonusLives(run) && w.ease === easeFor(run), `attempt ${attempts}: lives/ease from ${run.retreats} retreats`);
    check(w.scrap === run.scrap && same(w.charges, run.charges), `attempt ${attempts}: scrap and charges copied into the world`);
    check(w.def.name === regionName(run.region), `attempt ${attempts}: region name ${w.def.name}`); // Phase 4: FARMLAND, RAIL JUNCTION, ...
    if (attempts === 1 && w.depots.length >= 2) {
      // depots: a player shell takes one hit off, an enemy shell none; six hits destroy it and pay out
      const d = w.depots[0];
      const p = w.players[0]!;
      check(w.depotBlocks(d.cx - 8, d.cy - 8), 'a standing depot blocks tanks');
      w.bullets.push(new Bullet(d.cx, d.cy + 10, UP, 3, p, false, false, 0));
      w.bullets.push(new Bullet(d.cx + 2, d.cy + 10, UP, 3, foe(), false, false, 0));
      w.update([{ dir: -1, fire: false }]);
      check(d.hp === DEPOT_HP - 1, `player shell hits the depot (hp ${d.hp})`);
      const s0 = w.scrap;
      for (let i = 0; i < DEPOT_HP; i++) w.hitDepot(d, 0);
      check(d.destroyed && w.stats.depots === 1 && w.scrap === s0 + DEPOT_SCRAP, `depot destroyed after 6 hits, +${DEPOT_SCRAP} scrap`);
      check(!w.depotBlocks(d.cx - 8, d.cy - 8), 'a destroyed depot no longer blocks');
      check(w.radio.some((m) => m.text.includes(d.name)), 'depot radio line');
      // hulls the AI reports captured become part rolls, and the list is emptied
      const ai = w.ai as unknown as { capturedHulls?: { cx: number; cy: number }[] };
      const hadField = 'capturedHulls' in ai;
      const hulls = ai.capturedHulls ?? (ai.capturedHulls = []);
      hulls.push({ cx: p.cx + 30, cy: p.cy });
      const picked = w.stats.partsPicked;
      w.update([{ dir: -1, fire: false }]);
      check(hulls.length === 0 && w.stats.partsPicked === picked + 1, 'captured hull stripped for a part');
      if (!hadField) delete ai.capturedHulls;
    }
    let f = 0;
    let saves = 0;
    let seen = '';
    while (!w.done && f < LIMIT) {
      // the bot can lose region after region (ease stops at 0.3): from attempt 6 keep it alive, so the run still
      // reaches region 3 inside 8 attempts (by a clear or the forced clear below)
      const pt = w.players[0];
      if (attempts >= 6 && pt) pt.shield = Math.max(pt.shield, 2);
      w.update([regionBot(w)]);
      w.map.takeDirty();
      w.ev.length = 0;
      w.decals.length = 0;
      w.notes.length = 0;
      w.popups.length = 0;
      w.radio.length = 0;
      syncRun(w, run);
      crewStep(w);
      // the app autosaves when a town is freed or a depot destroyed
      const key = `${w.stats.townsFreed}|${w.stats.depots}`;
      if (key !== seen) {
        seen = key;
        saveRun(run);
        saves++;
        check(same(loadRun(), run), `autosave at ${key}`);
      }
      // the bot rarely loses all its lives: force one defeat in region 1 so the retreat path always runs
      if (!forcedRetreat && run.region === 0 && f === 60 * 30) {
        forcedRetreat = true;
        ps[0].lives = 0;
        const t = w.players[0];
        if (t) {
          t.shield = 0;
          t.hover = false;
          while (w.players[0]) w.hitPlayer(w.players[0], foe());
        } else ps[0].out = true;
      }
      f++;
    }
    let forced = '';
    if (!w.done) {
      // timeout: the bot is weak; free the rest so the run moves on (the sim checks the flow, not the bot)
      // (a counterattack already holding a flag can retake a town during the wait: free it again; and an idle
      // player can be knocked out meanwhile, so leave time for the game-over screen too: clear 200 + over 260)
      for (let i = 0; i < 700 && !w.done; i++) {
        for (const t of w.towns) if (!t.freed) w.freeTown(t);
        if (w.boss?.alive || w.boss?.state === 'hidden') w.boss.kill(); // Phase 4: region clear = the boss destroyed
        w.update([{ dir: -1, fire: false }]);
        syncRun(w, run);
        crewStep(w);
      }
      forced = ' (towns freed by the sim after a timeout)';
      forcedClears++;
    }
    syncRun(w, run);
    const outcome = w.done;
    if (outcome === 'over') run.retreats++;
    else if (outcome === 'clear') {
      // Phase 5: totals and the next briefing's kicker, as app.ts regionClear does
      noteRegionClear(run, { region: run.region, towns: w.towns.filter((t) => t.freed).length, depots: w.stats.depots, bosses: w.stats.boss, scrap: 0, parts: 0, kills: 0 });
      check(debriefLine(w.boss?.kind).text.length > 0, 'region clear has a debrief line');
      delete run.progress; // as app.ts regionClear: the next region starts fresh
      run.region++;
    }
    check(run.crew!.length >= crewBefore, `attempt ${attempts}: crew kept (${outcome})`);
    // the next workshop: a waiting recruit asks again and joins
    const wait = waitingRecruit(run);
    if (wait && outcome === 'clear') {
      joinCrew(run, wait.id, wait.from ?? '', null);
      crewLog.push(`${wait.id} joined at the camp`);
    }
    run = roundTrip(run, `after attempt ${attempts}`);
    console.log(`attempt ${attempts}: ${outcome === 'over' ? 'RETREAT' : outcome === 'clear' ? 'CLEAR' : 'stuck'}@${Math.round(f / 60)}s${forced}`
      + ` | towns ${w.stats.townsFreed}/${w.towns.length} depots ${w.stats.depots}/${w.depots.length} knockouts ${w.stats.knockouts}`
      + ` | boss ${w.boss?.state ?? '-'}${w.boss ? ` parts lost ${w.boss.stats.partsLost} hits ${w.boss.stats.shellHits}/${w.boss.stats.noPen} no-pen` : ''}`
      + ` | run: region ${run.region} scrap ${run.scrap} bin ${run.bin.length} charges ${run.charges.join(',')} vet ${run.vet[0]}+${run.vetXp[0].toFixed(2)} retreats ${run.retreats} | autosaves ${saves}`
      + ` | crew ${(run.crew as CrewMember[]).map((m) => `${m.id}${m.waiting ? '(waiting)' : ''} ${m.lv}/${m.xp}`).join(', ')}`);
    check(outcome === 'over' || outcome === 'clear', `attempt ${attempts} ended (${outcome || 'no end'})`);
  }
  check(run.region === 2, `reached region 3 (at ${run.region})`);
  check(run.retreats >= 1, 'at least one retreat');
  // ---------- Phase 3 crew checks ----------
  console.log(`crew: ${crewLog.join(' / ')}`);
  const ids = run.crew!.map((m) => m.id);
  // slower recruiting: one per region (WASP in region 1, AUNTIE in region 2), each only after the 2nd freed town
  check(ids.includes('sofia') && ids.includes('halyna') && ids.filter((id) => RECRUIT_ORDER.includes(id)).length === 2, `regions 1-2 recruited WASP then AUNTIE only (${ids.join(',')})`);
  check(declined === 'halyna', `region 2's recruit was AUNTIE (${declined})`);
  {
    const t = newRun(1);
    const at = (region: number, met: number) => { t.region = region; t.crew = [...starterCrew(), ...RECRUIT_ORDER.slice(0, met).map((id) => ({ id, lv: 1, xp: 0 }))]; };
    at(0, 0);
    check(!recruitOffer(t, 1) && recruitOffer(t, 2)?.id === 'sofia' && !recruitOffer(t, 3, true) && !recruitOffer(t, 0, true), 'region 1: WASP only after the 2nd town, never from a map event');
    at(0, 1);
    check(!recruitOffer(t, 4), 'region 1: nobody after WASP, however many towns');
    at(1, 1);
    check(!recruitOffer(t, 1) && recruitOffer(t, 2)?.id === 'halyna' && recruitOffer(t, 0, true)?.id === 'halyna', 'region 2: AUNTIE after 2 towns, or from a map event');
    at(1, 2);
    check(!recruitOffer(t, 5) && !recruitOffer(t, 0, true), 'region 2: one recruit only');
    const got: string[] = [];
    for (let r = 0; r < 5; r++) { at(r, got.length); const d = recruitOffer(t, 3); if (d) got.push(d.id); }
    check(got.join() === 'sofia,halyna,taras,oksana,danylo', `five regions bring five recruits (${got.join(',')})`);
  }
  check(!!declined && ids.includes(declined) && !(run.crew as CrewMember[]).find((m) => m.id === declined)?.waiting, `declined recruit ${declined} waited and joined at the next camp`);
  check(aboard(run.crew).some((m) => m.xp > 0 || m.lv > 1), 'crew earned XP');
  run = roundTrip(run, 'crew save');
  check(same(run.crew!.map((m) => m.id), ids), 'crew survives save/load');
  // a save from before Phase 3 (no crew) loads with the two starters; a broken crew list is no save
  const old = JSON.parse(JSON.stringify(run)) as RunState;
  delete old.crew;
  mem.set(SAVE_KEY, JSON.stringify({ v: 1, at: 0, run: old }));
  check(same(loadRun()?.crew?.map((m) => m.id), ['mykola', 'yurko']), 'old save without crew gets the starters');
  check(!validRun({ ...old, crew: [{ id: 'sofia', lv: 0, xp: 0 }] }) && !validRun({ ...old, crew: [{ id: 'sofia', lv: 1, xp: 0 }, { id: 'sofia', lv: 1, xp: 0 }] }), 'bad crew lists rejected');
  crewPerkChecks();
  // an incompatible or broken save is ignored and cleared
  mem.set(SAVE_KEY, JSON.stringify({ v: 0, run: {} }));
  check(loadRun() === null && !mem.has(SAVE_KEY), 'old-version save cleared');
  mem.set(SAVE_KEY, '{not json');
  check(loadRun() === null && !mem.has(SAVE_KEY), 'broken save cleared');
  storyChecks(run);
  progressChecks();
  arenaChecks();
  console.log(`run loop: ${attempts} attempts, ${forcedClears} forced clears`);
} catch (e) {
  fails.push(`exception: ${e instanceof Error ? e.stack : String(e)}`);
}
// ---------- Phase 5 story ----------
/** Answer the run's briefing as the run flow does (choice by attempt) and check the reward landed in the run. */
function storyStep(run: RunState, attempt: number): void {
  const pages = briefingPages(run);
  check(pages.length > 0 && !!pages[pages.length - 1].choices?.length, `region ${run.region}: briefing has answers`);
  if (run.region === 0) check(pages.length === 3 && !storyState(run).opened, 'a new campaign opens with the opening scene (2 pages) and the briefing');
  const last = pages[pages.length - 1];
  const i = attempt % last.choices!.length;
  const rw = effectiveReward(run, last.choices![i]);
  const scrap = run.scrap;
  const charges = [...run.charges];
  const reply = answerBriefing(run, i);
  if (rw.kind === 'scrap') check(run.scrap === scrap + rw.n, `briefing ${run.region}: +${rw.n} scrap`);
  else if (rw.kind === 'charge') check(run.charges[rw.k] === charges[rw.k] + rw.n, `briefing ${run.region}: +${rw.n} charge ${rw.k}`);
  else check(!!reply && regionHint(run)?.text === reply.text, `briefing ${run.region}: the hint is kept for the radio`);
  check(!briefingDue(run) && storyState(run).opened === true && storyState(run).answers[String(run.region)] === i, `briefing ${run.region}: answered and saved`);
  // answering twice gives nothing more
  const s2 = run.scrap;
  answerBriefing(run, 1);
  check(run.scrap === s2, `briefing ${run.region}: a second answer gives nothing`);
  console.log(`briefing ${run.region}: answer ${i + 1} (${rw.kind}${rw.kind === 'hint' ? '' : ` ${rw.n}`})`);
}

/** Story text uses only the pixel font's glyphs; the ending marks the save complete and the run goes on (LIBERATION). */
function storyChecks(run0: RunState): void {
  const glyphs = new Set(Object.keys(FONT));
  const bad = new Set<string>();
  const scan = (t: string) => { for (const c of t) if (c !== ' ' && !glyphs.has(c)) bad.add(c); };
  for (let r = 0; r < STORY_REGIONS; r++) {
    const run = JSON.parse(JSON.stringify(run0)) as RunState;
    run.region = r;
    run.story = { briefed: [], answers: {} };
    run.crew = allCrew();
    for (const p of briefingPages(run)) {
      scan(p.title); scan(p.tag); scan(p.sub);
      p.lines.forEach((l) => { scan(l.who); scan(l.text); });
      p.choices?.forEach((c) => { scan(c.text); if (c.reply) scan(c.reply.text); });
    }
    scan(introQuote(r).text);
    scan(introQuote(r + STORY_REGIONS, true).text);
  }
  for (const k of ['grinder', 'train', 'flagship', 'heli', 'final', null]) scan(debriefLine(k).text);
  check(debriefLine('ace').text.startsWith('GRINDER'), 'GRINDER (kind ace) gets its own debrief');
  // the end: the region-5 clear with the final boss down
  const run = JSON.parse(JSON.stringify(run0)) as RunState;
  run.region = 4;
  run.crew = allCrew();
  noteRegionClear(run, { region: 4, towns: 4, depots: 2, bosses: 1, scrap: 300, parts: 3, kills: 20 });
  const end = endingPages(run);
  end.forEach((p) => { scan(p.title); scan(p.sub); p.lines.forEach((l) => { scan(l.who); scan(l.text); }); });
  completeRows(run).forEach(([k, v]) => { scan(k); scan(v); });
  check(bad.size === 0, `story text only uses font glyphs (missing: ${[...bad].join(' ')})`);
  check(end.length === 3 && end.every((p) => p.lines.length >= 2 && !p.choices), 'ending: three pages of lines, no answers');
  run.region++;
  completeCampaign(run);
  saveRun(run);
  const back = loadRun();
  check(!!back && back.completed === true && back.region === 5 && !briefingDue(back), 'completed save loads, no more briefings');
  check(!!back && regionName(back.region) === 'FARMLAND II' && introQuote(back.region, true).text !== introQuote(0).text, 'liberation mode cycles the regions with its own lines');
  check(!!back?.totals && back.totals.regions >= 3 && back.totals.bosses >= 1, `totals kept (${JSON.stringify(back?.totals)})`);
  check(!validRun({ ...run, story: { briefed: 'x', answers: {} } }) && !validRun({ ...run, completed: 1 }), 'bad story state rejected');
  console.log(`story: answers ${JSON.stringify(run0.story?.answers)} · totals ${JSON.stringify(back?.totals)}`);
}

/** Each perk on a quiet test world with the whole catalogue aboard. */
function crewPerkChecks(): void {
  const run = newRun(99);
  run.crew = allCrew();
  const ps = [newPState(), newPState()];
  const w = regionWorld(run, ps, 1);
  check(w.unlocked.every(Boolean) && w.perks.has('night-eyes') && nightEyesRange(w) === 48, 'all crew: every ability unlocked, NIGHT EYES 3 tiles');
  w.freeze = 1e9;
  for (const e of w.enemies) e.alive = false;
  const idle = () => { w.update([{ dir: -1, fire: false }]); syncRun(w, run); crewTick(w, run); };
  for (let i = 0; i < 70; i++) idle();
  const p = w.players[0]!;
  p.shield = 0;
  // SCRAP SENSE: fresh wreck scrap +25%
  const pick = { x: p.cx + 200, y: p.cy + 200, kind: 'scrap' as const, amount: 20, t: 0 };
  w.pickups.push(pick);
  crewTick(w, run);
  check(pick.amount === 25, `SCRAP SENSE: 20 scrap became ${pick.amount}`);
  // PLOUGHMAN / QUICK HANDS: from the parts' numbers
  const cell = w.map.at(Math.floor(p.cx / 4), Math.floor(p.cy / 4));
  const field = cell === EMPTY || cell === 6;
  check(Math.abs(p.speedMul - (field ? 1.08 : 1)) < 1e-9 && Math.abs(p.reloadMul - 0.92) < 1e-9, `PLOUGHMAN ${p.speedMul.toFixed(2)} (field ${field}), QUICK HANDS ${p.reloadMul.toFixed(2)}`);
  // SPANNER: a patch mends 3 + 1
  p.armour = 4;
  w.charges[3] = 1;
  crewTick(w, run);
  w.update([{ dir: -1, fire: false, ability: 4 }]);
  crewTick(w, run);
  check(p.armour === 8, `SPANNER patch: 4 -> ${p.armour}`);
  // PEN PALS: a freed town sends 5 more scrap (level 1)
  const town = w.towns.find((t) => !t.freed);
  if (town) {
    const s0 = w.scrap;
    w.freeTown(town);
    crewTick(w, run);
    check(w.scrap === s0 + FREE_SCRAP + 5, `PEN PALS: +${w.scrap - s0} scrap for a town`);
  }
  // STEADY HAND: stand still 1 s, fire at an armoured tank: 1 + 1 damage
  p.dir = UP;
  for (let y = p.y - 60; y < p.y; y += 4) for (let x = p.x; x < p.x + 16; x += 4) w.map.set(Math.floor(x / 4), Math.floor(y / 4), EMPTY);
  const e = new Tank();
  e.etype = 3;
  e.hp = 4;
  e.x = p.x;
  e.y = p.y - 52;
  e.dir = DOWN;
  w.enemies.push(e);
  for (let i = 0; i < 65; i++) idle();
  w.update([{ dir: -1, fire: true }]);
  crewTick(w, run);
  for (let i = 0; i < 40 && w.bullets.some((b) => b.owner === p && b.alive); i++) idle();
  check(e.hp === 2 && crewDebug(w).steadyHits === 1, `STEADY HAND: armoured tank hp 4 -> ${e.hp} (steady hits ${crewDebug(w).steadyHits})`);
  // a moving shot gets no bonus (after the reload)
  for (let i = 0; i < 40; i++) idle();
  w.update([{ dir: UP, fire: true }]);
  crewTick(w, run);
  for (let i = 0; i < 40 && w.bullets.some((b) => b.owner === p && b.alive); i++) idle();
  check(crewDebug(w).steadyHits === 1 && e.hp === 1, `STEADY HAND: no bonus on the move (hp ${e.hp})`);
  // camp prices: HOT GLUE (drone 32 -> 26 at lv1, 21 at lv3), BY THE BOOK (repair 15 -> 12)
  const c3 = allCrew().map((m) => (m.id === 'sofia' ? { ...m, lv: 3 } : m));
  check(craftCost(0, run.crew) === 26 && craftCost(0, c3) === 21 && craftCost(1, run.crew) === 30 && craftCost(2, run.crew) === 20 && repairCost(run.crew) === 12,
    `camp prices: drone ${craftCost(0, run.crew)}/${craftCost(0, c3)} ambush ${craftCost(1, run.crew)} recon ${craftCost(2, run.crew)} repair ${repairCost(run.crew)}`);
  console.log(`crew perks: scrap ${pick.amount}, speed ${p.speedMul.toFixed(2)}, reload ${p.reloadMul.toFixed(2)}, steady hits ${crewDebug(w).steadyHits}`);
}

function foe(): Tank {
  const t = new Tank();
  t.etype = 3;
  return t;
}
if (fails.length) {
  console.log(`RUN LOOP FAILED (${fails.length}):\n  ${fails.join('\n  ')}`);
  process.exitCode = 1;
} else console.log('run loop: all checks pass');
