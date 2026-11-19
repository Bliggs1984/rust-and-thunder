// Headless checks for the Phase 5 map events (src/game/events.ts): font-safe text, placement on all five region kinds
// for several seeds, every answer of every event applied (objectives driven to the end), autoplay answering, and the
// run's seen / resolved events through save and load and a retreat.
// Run: npm run eventssim
import { reseed } from './ai-sim-seed';
import { regionBot } from '../src/game/bot';
import { WATER } from '../src/game/constants';
import { CREW, allCrew } from '../src/game/crew';
import { CIVILIANS, EV, EVENTS, fontSafe, type EventDef, type MapEvents, type Out, type Placed } from '../src/game/events';
import { newRun, type RunState } from '../src/game/run';
import { SAVE_KEY, loadRun, regionKind, regionWorld, saveRun, syncRun, validRun } from '../src/game/save';
import { newPState, type PInput, type PState, type World } from '../src/game/world';

// localStorage for save / load
const mem = new Map<string, string>();
(globalThis as { localStorage?: unknown }).localStorage = {
  getItem: (k: string) => mem.get(k) ?? null,
  setItem: (k: string, v: string) => { mem.set(k, String(v)); },
  removeItem: (k: string) => { mem.delete(k); },
};

let fails = 0;
let exceptions = 0;
function check(name: string, ok: boolean, info: string): void {
  if (!ok) fails++;
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}: ${info}`);
}
const IDLE: PInput = { dir: -1, fire: false };
const KINDS = ['farm', 'rail', 'delta', 'ruins', 'winter'];

function makeRun(seed: number, region: number, crew = true): RunState {
  const run = newRun(seed);
  run.region = region;
  run.crew = crew ? allCrew() : undefined;
  return run;
}
function world(run: RunState): World {
  reseed(run.seed + run.region * 13);
  const ps: PState[] = [newPState(), newPState()];
  const w = regionWorld(run, ps, 1);
  const p = w.players[0]!;
  p.spawn = 0;
  p.shield = 0;
  return w;
}
function step(w: World, n: number, inp: PInput | ((w: World) => PInput) = IDLE, each?: () => void): void {
  for (let i = 0; i < n; i++) {
    each?.();
    try {
      w.update([typeof inp === 'function' ? inp(w) : inp]);
    } catch (e) {
      exceptions++;
      console.log('EXCEPTION', e);
      return;
    }
    w.ev.length = 0;
    w.notes.length = 0;
    w.radio.length = 0;
    w.popups.length = 0;
  }
}
/** Park player 1 on (x, y) (centre px). */
function park(w: World, x: number, y: number): void {
  const p = w.players[0]!;
  p.x = Math.round(x - 8);
  p.y = Math.round(y - 8);
  p.spawn = 0;
  p.shield = 0;
}
const calm = (w: World) => () => {
  for (const e of w.enemies) e.alive = false;
  for (const b of w.bullets) b.alive = false;
  const p = w.players[0];
  if (p) { p.armour = p.armourMax; p.shield = 60; }
};

// ---------------------------------------------------------------- 1. text
{
  const speakers = new Set(['KOVAL', ...CREW.map((c) => c.call), ...Object.keys(CIVILIANS)]);
  const bad: string[] = [];
  const badWho: string[] = [];
  const fill = (s: string) => s.replace(/\{[TDN]\}/g, 'STARYI MLYN 40');
  const line = (id: string, [who, text]: [string, string]) => {
    if (!fontSafe(fill(text))) bad.push(`${id}: ${text}`);
    for (const w of who.split('|')) if (!speakers.has(w)) badWho.push(`${id}: ${w}`);
  };
  for (const e of EVENTS) {
    if (!fontSafe(e.title)) bad.push(`${e.id} title`);
    e.lines.forEach((l) => line(e.id, l));
    for (const c of e.choices) {
      if (!fontSafe(fill(c.text))) bad.push(`${e.id} choice ${c.text}`);
      if (c.reply) line(e.id, c.reply);
    }
    if (e.thanks) line(e.id, e.thanks);
    if (e.fail) line(e.id, e.fail);
    if (e.vehicle && !fontSafe(e.vehicle)) bad.push(`${e.id} vehicle`);
  }
  for (const c of Object.values(CIVILIANS)) if (!fontSafe(c.name) || !fontSafe(c.role)) bad.push(`civilian ${c.name}`);
  check('text: every line, answer and name is font-safe', bad.length === 0, bad.length ? bad.join(' | ') : `${EVENTS.length} events`);
  check('text: every speaker has a portrait and plate', badWho.length === 0, badWho.join(', ') || `${speakers.size} speakers`);
  check('data: 15-20 events, 2-3 lines and 2-3 answers each', EVENTS.length >= 15 && EVENTS.length <= 20
    && EVENTS.every((e) => e.lines.length >= 2 && e.lines.length <= 3 && e.choices.length >= 2 && e.choices.length <= 3),
  `${EVENTS.length} events`);
  const kinds = new Set(EVENTS.map((e) => e.kind));
  check('data: regional events for every region kind', KINDS.every((k) => kinds.has(k as EventDef['kind'])), [...kinds].join(', '));
  check('data: ids unique', new Set(EVENTS.map((e) => e.id)).size === EVENTS.length, '');
  // labels with every ability unlocked and with none
  const w = world(makeRun(5, 0));
  const ev = w.events!;
  const labs: string[] = [];
  for (const unlocked of [[true, true, true, true], [false, false, false, true]]) {
    w.unlocked.splice(0, 4, ...unlocked);
    for (const e of EVENTS) for (const c of e.choices) {
      const l = ev.label(c);
      labs.push(l.text, l.risk ?? '');
    }
  }
  const badLab = labs.filter((t) => !fontSafe(t) || t.length > 40);
  check('text: answer labels font-safe and at most 40 characters', badLab.length === 0, badLab.join(' | ') || `${labs.length / 2} labels, longest ${Math.max(...labs.map((t) => t.length))}`);
}

// ---------------------------------------------------------------- 2. placement
{
  const seeds = [1, 2, 3, 7, 11, 23];
  const counts: Record<string, number> = {};
  const regional: Record<string, number> = {};
  let worlds = 0;
  let few = 0;
  let badSpot = 0;
  let wrongKind = 0;
  let tooClose = 0;
  let nearStart = 0;
  let total = 0;
  let minSpawn = Infinity;
  let ms = 0;
  let msMax = 0;
  const why: string[] = [];
  for (let region = 0; region < 5; region++) {
    for (const seed of seeds) {
      const run = makeRun(seed, region);
      const w = world(run);
      const ev = w.events!;
      worlds++;
      ms += ev.stats.placeMs;
      msMax = Math.max(msMax, ev.stats.placeMs);
      const kind = regionKind(region);
      if (ev.placed.length < EV.minPerRegion || ev.placed.length > EV.maxPerRegion) { few++; why.push(`${kind}(${seed}) ${ev.placed.length}`); }
      for (const p of ev.placed) {
        counts[p.def.id] = (counts[p.def.id] ?? 0) + 1;
        if (p.def.kind !== 'any') regional[kind] = (regional[kind] ?? 0) + 1;
        if (p.def.kind !== 'any' && p.def.kind !== kind) wrongKind++;
        const tx = Math.round((p.x - 8) / 8) * 8;
        const ty = Math.round((p.y - 8) / 8) * 8;
        if (!ev.reachable(tx, ty) || w.map.solidForTank(tx, ty, false)) { badSpot++; why.push(`${kind}(${seed}) ${p.def.id} at ${p.x},${p.y}`); }
        if (w.region!.playerSpawns.some(([sx, sy]) => Math.hypot(sx + 8 - p.x, sy + 8 - p.y) < EV.fromSpawn - 8)) tooClose++;
        const sd = Math.min(...w.region!.playerSpawns.map(([sx, sy]) => Math.hypot(sx + 8 - p.x, sy + 8 - p.y)));
        minSpawn = Math.min(minSpawn, sd);
        total++;
        if (sd < EV.fromSpawnFar[0] - 8) nearStart++;
        if (ev.placed.some((q) => q !== p && Math.hypot(q.x - p.x, q.y - p.y) < EV.spacing - 1)) tooClose++;
      }
    }
  }
  check('placement: 3-5 events in every region kind and seed', few === 0, `${worlds} regions${few ? `; ${why.join(', ')}` : ''}`);
  check('placement: every spot reachable and clear for a tank', badSpot === 0, badSpot ? why.join(', ') : 'all');
  check('placement: regional events only in their region', wrongKind === 0, JSON.stringify(regional));
  check('placement: every kind gets regional events', KINDS.every((k) => (regional[k] ?? 0) > 0), JSON.stringify(regional));
  check('placement: spacing from the start and between events', tooClose === 0, `${tooClose} too close`);
  check('placement: no event within ~240 px of a spawn (small maps may fall back)', nearStart === 0, `${nearStart} of ${total} events nearer; closest ${minSpawn.toFixed(0)} px`);
  check('placement: cost per region', ms / worlds < 120, `avg ${(ms / worlds).toFixed(1)} ms, max ${msMax.toFixed(1)} ms`);
  const unused = EVENTS.filter((e) => !counts[e.id]).map((e) => e.id);
  console.log(`     placed per event: ${Object.entries(counts).map(([k, v]) => `${k} ${v}`).join(', ')}${unused.length ? `; never: ${unused.join(', ')}` : ''}`);
  // determinism: the same region places the same events in the same spots
  const a = world(makeRun(7, 2)).events!.placed.map((p) => `${p.def.id}@${p.x},${p.y}`).join(' ');
  const b = world(makeRun(7, 2)).events!.placed.map((p) => `${p.def.id}@${p.x},${p.y}`).join(' ');
  check('placement: deterministic per map', a === b, a);
}

// ---------------------------------------------------------------- 3. every answer of every event
/** A world whose region kind suits the event, with it placed. */
function eventWorld(def: EventDef, seedBase: number): { w: World; ev: MapEvents; p: Placed } | null {
  // an answer that is a recruit only exists from region 2 on (crew.ts: no event recruits in region 1)
  const recruits = def.choices.some((c) => c.outs.some((o) => o.k === 'recruit'));
  const regions = def.kind === 'any' ? (recruits ? [2, 3, 1, 4] : [0, 2, 3, 1, 4]) : [KINDS.indexOf(def.kind)];
  for (const region of regions) {
    for (const seed of [seedBase, seedBase + 1, seedBase + 2, seedBase + 5]) {
      const w = world(makeRun(seed, region));
      const ev = w.events!;
      const p = ev.debugPlace(def.id);
      if (p && p.state === 'idle') return { w, ev, p };
    }
  }
  return null;
}

function drive(w: World, ev: MapEvents, p: Placed): string {
  // finish whatever objective the answer started (enemies and shells removed, so only the objective is judged)
  const ob = ev.objs.find((o) => o.ev === p);
  if (!ob) return 'none';
  const keep = calm(w);
  if (ob.kind === 'mines') {
    for (const m of ob.mines!) m.alive = false;
    step(w, 2, IDLE, keep);
  } else if (ob.kind === 'hunt') {
    step(w, 70);
    for (const t of ob.tanks!) w.killEnemy(t, 0);
    step(w, 2, IDLE, keep);
  } else if (ob.kind === 'fetch') {
    const f = ob.fetch!;
    park(w, f.x, f.y);
    step(w, (f.hold || 0) + 10, IDLE, () => { keep(); park(w, f.x, f.y); });
  } else {
    const e = ob.escort!;
    const frames = Math.ceil(e.len / EV.escortSpeed) + 60;
    step(w, frames, IDLE, () => { keep(); park(w, e.x + 20, e.y); });
  }
  return ob.kind;
}

{
  let n = 0;
  const missing: string[] = [];
  const problems: string[] = [];
  const kinds = new Set<string>();
  let objectivesDone = 0;
  let objectives = 0;
  for (const def of EVENTS) {
    def.choices.forEach((c, ci) => {
      const got = eventWorld(def, 31 + ci * 3);
      if (!got) { missing.push(def.id); return; }
      const { w, ev, p } = got;
      n++;
      if (p.town >= 0) w.freeTown(w.towns[p.town]);
      step(w, 1, IDLE, calm(w));
      w.scrap = 200;
      const pl = w.players[0]!;
      pl.armour = 3;
      park(w, p.x, p.y);
      step(w, 3, IDLE, () => { calm(w)(); pl.armour = 3; });
      if (ev.pending !== p) { problems.push(`${def.id}: no trigger`); return; }
      const before = {
        scrap: w.scrap, charges: [...w.charges], found: w.found.length, enemies: w.enemies.length, drones: w.tricks?.drones.length ?? 0,
        squads: w.abil?.squads.length ?? 0, recon: w.abil?.reconUntil ?? 0, water: w.map.c.reduce((a, v) => a + (v === WATER ? 1 : 0), 0), mines: w.tricks?.mines.length ?? 0,
      };
      pl.armour = 3;
      let res;
      try {
        res = ev.answer(ci);
      } catch (e) {
        exceptions++;
        problems.push(`${def.id}/${ci}: ${e}`);
        return;
      }
      const all: Out[] = c.outs.flatMap((o) => ('then' in o ? [o, ...o.then] : [o]));
      const has = (k: Out['k']) => all.some((o) => o.k === k);
      const obj = c.outs.find((o) => 'then' in o);
      if (obj) objectives++;
      // immediate effects
      const errs: string[] = [];
      if (has('later')) { if (res.resolved || p.state !== 'idle') errs.push('later resolved it'); }
      else if (!res.resolved) errs.push('not resolved');
      if (c.outs.some((o) => o.k === 'patrol') && w.enemies.length <= before.enemies) errs.push('no patrol');
      if (c.outs.some((o) => o.k === 'drone' || o.k === 'spotter') && (w.tricks?.drones.length ?? 0) <= before.drones) errs.push('no drone');
      if (c.outs.some((o) => o.k === 'militia') && (w.abil?.squads.length ?? 0) <= before.squads) errs.push('no militia');
      if (c.outs.some((o) => o.k === 'listen') && (w.abil?.reconUntil ?? 0) <= w.frame) errs.push('no listening');
      if (c.outs.some((o) => o.k === 'quiet') && ev.quietUntil <= w.frame) errs.push('no quiet');
      if (c.outs.some((o) => o.k === 'armour') && pl.armour <= 3) errs.push('no armour');
      if (c.outs.some((o) => o.k === 'bridge') && w.map.c.reduce((a, v) => a + (v === WATER ? 1 : 0), 0) >= before.water) errs.push('no bridge');
      if (c.outs.some((o) => o.k === 'recruit') && !res.recruit) errs.push('no recruit');
      if (obj?.k === 'mines' && (w.tricks?.mines.length ?? 0) <= before.mines) errs.push('no minefield');
      if (obj && p.state !== 'active') errs.push(`objective not started (${p.state})`);
      if (!res.reply) errs.push('no reply');
      else if (!fontSafe(res.reply.text)) errs.push(`reply not font-safe: ${res.reply.text}`);
      // the objective to its end
      const pay = c.outs.reduce((a, o) => a + (o.k === 'pay' ? o.n : 0), 0);
      const s0 = w.scrap;
      const kind = drive(w, ev, p);
      kinds.add(kind);
      if (obj) {
        if (p.state === 'done') objectivesDone++;
        else errs.push(`objective ${kind} ended ${p.state}`);
      }
      // rewards: something was paid for every answer that resolves
      const then = obj ? (obj as { then: Out[] }).then : [];
      const gained = w.scrap > (obj ? s0 : before.scrap - pay) || w.charges.some((v, k) => v > before.charges[k]) || w.found.length > before.found
        || ev.recruitDue !== null || res.recruit;
      const pays = [...c.outs, ...then].some((o) => ['scrap', 'charge', 'part', 'recruit'].includes(o.k));
      if (pays && !gained) errs.push('no reward');
      if (has('part') && w.found.length <= before.found) errs.push('no part');
      if (errs.length) problems.push(`${def.id}/${ci}: ${errs.join(', ')}`);
    });
  }
  check('outcomes: every event placeable somewhere', missing.length === 0, missing.join(', ') || `${EVENTS.length} events`);
  check('outcomes: every answer applies (trigger, effects, rewards)', problems.length === 0, problems.length ? problems.join(' | ') : `${n} answers`);
  check('outcomes: objectives run to the end and pay', objectivesDone === objectives, `${objectivesDone}/${objectives} (${[...kinds].join(', ')})`);
}

// a price the crew can't pay; walking away; a failed escort
{
  const got = eventWorld(EVENTS.find((e) => e.id === 'bridge')!, 3);
  if (got) {
    const { w, ev, p } = got;
    park(w, p.x, p.y);
    w.scrap = 5;
    step(w, 3, IDLE, calm(w));
    const res = ev.answer(0);
    check('pay: not enough scrap leaves the event', !res.resolved && p.state === 'idle' && w.scrap === 5, res.reply?.text ?? '');
    step(w, 3, IDLE, calm(w));
    check('pay: it asks again only after the players leave', ev.pending === null, '');
    park(w, p.x + 80, p.y);
    step(w, 2, IDLE, calm(w));
    park(w, p.x, p.y);
    step(w, 2, IDLE, calm(w));
    check('pay: back again, it asks again', ev.pending === p, '');
    ev.walkAway();
    step(w, 3, IDLE, calm(w));
    check('walk away: no card while they stay', ev.pending === null && p.state === 'idle', '');
  } else check('pay: bridge placeable', false, 'no crossing found');
  const tr = eventWorld(EVENTS.find((e) => e.id === 'tractor')!, 5);
  if (tr) {
    const { w, ev, p } = tr;
    w.freeTown(w.towns[p.town]);
    park(w, p.x, p.y);
    step(w, 3, IDLE, calm(w));
    ev.answer(0);
    const ob = ev.objs[0];
    const e = ob.escort!;
    // no player near: it waits
    park(w, e.x + 200, e.y + 200);
    const s0 = e.s;
    step(w, 60, IDLE, calm(w));
    check('escort: waits without a player near', e.s === s0, `s ${e.s}`);
    park(w, e.x + 20, e.y);
    step(w, 60, IDLE, () => { calm(w)(); park(w, e.x + 20, e.y); });
    check('escort: moves with a player near', e.s > s0 + 20, `s ${e.s.toFixed(1)} of ${e.len}`);
    e.hp = 1;
    // an enemy shell on it
    step(w, 1, IDLE, () => {
      for (const t of w.enemies) t.alive = false;
      const b = { x: e.x, y: e.y, alive: true, owner: { isPlayer: false } } as unknown as World['bullets'][number];
      w.bullets.push(b);
    });
    check('escort: enemy shells break it down; it fails and stays unresolved', p.state === 'failed' && !ev.done.has(p.def.id), p.state);
  }
}

// ---------------------------------------------------------------- 4. autoplay answers
{
  let answered = 0;
  let triggered = 0;
  let stuck = 0;
  const stuckIds: string[] = [];
  for (let region = 0; region < 5; region++) {
    const w = world(makeRun(3, region));
    const ev = w.events!;
    for (const p of [...ev.placed]) {
      // an objective's drive can cross another event's spot and raise its card early: walk away from that card (it
      // asks again when the players come back, which is this loop reaching it)
      if (ev.pending && ev.pending !== p) ev.walkAway();
      p.armed = true;
      // enough scrap for any paid answer (which events a map gets, and in what order, depends on the map; what
      // happens with too little scrap is checked above under "pay")
      w.scrap = Math.max(w.scrap, 100);
      if (p.town >= 0) w.freeTown(w.towns[p.town]);
      park(w, p.x, p.y);
      step(w, 3, IDLE, calm(w));
      if (ev.pending !== p) { stuck++; stuckIds.push(`${p.def.id} (region ${region + 1}, pending ${ev.pending?.def.id ?? 'none'}, state ${p.state}, armed ${p.armed})`); continue; }
      triggered++;
      const res = ev.answer(ev.autoChoice());
      if (res.resolved && (p.state === 'done' || p.state === 'active')) answered++;
      else stuckIds.push(`${p.def.id} unresolved (region ${region + 1}, state ${p.state}, scrap ${w.scrap}, reply ${res.reply?.text ?? '-'})`);
      drive(w, ev, p);
    }
  }
  check('autoplay: the demo answer resolves every event', answered === triggered && stuck === 0, `${answered}/${triggered} answered, ${stuck} did not trigger${stuckIds.length ? `: ${stuckIds.join('; ')}` : ''}`);
  // a paced run with the region bot, answering like the app does in demos
  let botAnswers = 0;
  let pendingFrames = 0;
  for (let region = 0; region < 5; region++) {
    const w = world(makeRun(17, region));
    const ev = w.events!;
    step(w, 60 * 150, (ww) => regionBot(ww), () => {
      if (ev.pending) {
        pendingFrames++;
        ev.answer(ev.autoChoice());
        botAnswers++;
      }
      if (ev.recruitDue) ev.recruitDue = null;
    });
  }
  check('autoplay: the region bot plays with events on (no exceptions)', exceptions === 0, `${botAnswers} events answered in 5 x 150 s`);
  check('autoplay: no card left waiting', pendingFrames === botAnswers, `${pendingFrames} pending frames`);
}

// ---------------------------------------------------------------- 5. save / load / retreat
{
  mem.clear();
  const run = makeRun(41, 0);
  const w = world(run);
  const ev = w.events!;
  // answer one at once (resolved) and start one objective (seen, not resolved)
  const quick = ev.placed.find((p) => p.def.choices.some((c) => !c.outs.some((o) => 'then' in o || o.k === 'later' || o.k === 'pay')));
  const longer = ev.placed.find((p) => p !== quick && p.def.choices[0].outs.some((o) => 'then' in o));
  const ids: string[] = [];
  for (const p of [quick, longer]) {
    if (!p) continue;
    if (p.town >= 0) w.freeTown(w.towns[p.town]);
    park(w, p.x, p.y);
    step(w, 3, IDLE, calm(w));
    const ci = p === quick ? p.def.choices.findIndex((c) => !c.outs.some((o) => 'then' in o || o.k === 'later' || o.k === 'pay')) : 0;
    ev.answer(ci);
    ids.push(p.def.id);
    park(w, p.x + 100, p.y);
  }
  syncRun(w, run);
  const st = run.events?.['0'];
  check('save: seen and resolved events go into the run', !!st && st.seen.length === ids.length && st.done.includes(quick?.def.id ?? '?') && (!longer || !st.done.includes(longer.def.id)),
    JSON.stringify(st));
  saveRun(run);
  const back = loadRun();
  check('save: round trip through localStorage', !!back && validRun(back) && JSON.stringify(back.events) === JSON.stringify(run.events), JSON.stringify(back?.events));
  // a retreat: the same region again from the loaded run
  const w2 = world(back!);
  const ev2 = w2.events!;
  const q2 = ev2.placed.find((p) => p.def.id === quick?.def.id);
  const l2 = ev2.placed.find((p) => p.def.id === longer?.def.id);
  check('retreat: resolved events stay resolved', !quick || (q2?.state === 'done' && !ev2.available(q2)), q2?.state ?? 'missing');
  check('retreat: unresolved events come back in the same spot', !longer || (l2?.state === 'idle' && l2.x === longer.x && l2.y === longer.y), `${l2?.state} ${l2?.x},${l2?.y}`);
  check('retreat: seen list kept', ev2.seen.size === ids.length, [...ev2.seen].join(', '));
  // bad shapes are refused
  const bad = JSON.parse(JSON.stringify(run)) as RunState;
  (bad as unknown as { events: unknown }).events = { 0: { seen: 'x', done: [] } };
  check('save: a broken events entry is refused', !validRun(bad), '');
  mem.set(SAVE_KEY, '{}');
  check('save: an unreadable save loads as no save', loadRun() === null, '');
  // the next region keeps its own list
  const run2 = JSON.parse(JSON.stringify(back)) as RunState;
  run2.region = 1;
  const w3 = world(run2);
  check('save: a new region starts with nothing seen', w3.events!.seen.size === 0 && w3.events!.placed.every((p) => p.state === 'idle'), `${w3.events!.placed.length} events`);
}


console.log(`\n${fails ? `${fails} FAILED` : 'all passed'}${exceptions ? `, ${exceptions} exceptions` : ''}`);
if (fails || exceptions) process.exit(1);
