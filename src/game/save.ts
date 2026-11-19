// Campaign run lifecycle (CAMPAIGN.md "A run"): saving the RunState between sessions, building a region's World
// from the run, and copying the run's state into the World and back out while it plays.
// Saves hold the run only: a region in progress restarts at its start (no mid-region map saves in Phase 2).
import { MAX_LV, applyCrew, ensureCrew, noteBase } from './crew'; // Phase 3 crew
import { attachArena } from './arena'; // ?arena= test map
import { MapEvents } from './events'; // Phase 5 events hook
import { applyLoadout } from './parts';
import { makeRegion, type BossKind, type RegionKind, type RegionSpec } from './region';
import { SLOTS, newRun, type Loadout, type RegionProgress, type RunState } from './run';
import type { EnvName } from './stages';
import { ARMOUR_MAX, DEPOT_BURN, World, newPState, type PState, type Tank } from './world';

// ---------- save / load ----------
/** Keeps the game's old name (Tank 1990 NEO): renaming it would lose players' saved runs. */
export const SAVE_KEY = 'tank1990neo.run';
/** Bump when the save layout changes; older saves are then ignored and cleared. */
export const SAVE_VERSION = 1;

interface SaveFile {
  v: number;
  /** ms since 1970, for "saved ..." hints later */
  at: number;
  run: RunState;
}

/** The browser's localStorage, or null (private mode, the sim without a shim). */
function store(): Storage | null {
  try {
    return (globalThis as { localStorage?: Storage }).localStorage ?? null;
  } catch {
    return null;
  }
}

const isInt = (n: unknown): n is number => typeof n === 'number' && Number.isFinite(n) && Math.floor(n) === n;
const isNum = (n: unknown): n is number => typeof n === 'number' && Number.isFinite(n);
const isLoadout = (l: unknown): l is Loadout =>
  !!l && typeof l === 'object' && Object.entries(l as object).every(([k, v]) => (SLOTS as string[]).includes(k) && typeof v === 'string');

/** True if x has the full RunState shape of this version (anything else is treated as no save). */
export function validRun(x: unknown): x is RunState {
  const r = x as RunState;
  return !!r && typeof r === 'object' && r.version === 1
    && isInt(r.seed) && isInt(r.region) && r.region >= 0 && isNum(r.scrap) && r.scrap >= 0
    && Array.isArray(r.bin) && r.bin.every((p) => typeof p === 'string')
    && Array.isArray(r.fitted) && r.fitted.length === 2 && r.fitted.every(isLoadout)
    && Array.isArray(r.charges) && r.charges.length === 4 && r.charges.every((c) => isInt(c) && c >= 0)
    && Array.isArray(r.vet) && r.vet.length === 2 && r.vet.every(isInt)
    && Array.isArray(r.vetXp) && r.vetXp.length === 2 && r.vetXp.every(isNum)
    && isInt(r.retreats) && r.retreats >= 0
    && (r.crew === undefined || validCrew(r.crew))
    && (r.story === undefined || validStory(r.story))
    && (r.totals === undefined || (!!r.totals && typeof r.totals === 'object' && Object.values(r.totals).every(isNum)))
    && (r.completed === undefined || typeof r.completed === 'boolean')
    && (r.events === undefined || validEvents(r.events)) // Phase 5 events hook
    && (r.progress === undefined || validProgress(r.progress));
}

/** The region in progress: { region, towns: [names], depots: [names] }. */
function validProgress(p: unknown): boolean {
  const x = p as { region?: unknown; towns?: unknown; depots?: unknown };
  const strs = (a: unknown) => Array.isArray(a) && a.length <= 64 && a.every((s) => typeof s === 'string');
  return !!x && typeof x === 'object' && !Array.isArray(x) && isInt(x.region) && x.region >= 0 && strs(x.towns) && strs(x.depots);
}

/** Phase 5 events hook: { "0": { seen: [ids], done: [ids] }, ... }. */
function validEvents(e: unknown): boolean {
  const strs = (a: unknown) => Array.isArray(a) && a.every((s) => typeof s === 'string');
  return !!e && typeof e === 'object' && !Array.isArray(e) && Object.values(e as object).every((v) => {
    const x = v as { seen?: unknown; done?: unknown };
    return !!x && typeof x === 'object' && strs(x.seen) && strs(x.done);
  });
}

/** Phase 5 story state: briefed regions, answers, and the optional hint / last-region notes. */
function validStory(s: unknown): boolean {
  const x = s as { briefed?: unknown; answers?: unknown; opened?: unknown };
  return !!x && typeof x === 'object' && Array.isArray(x.briefed) && x.briefed.every(isInt)
    && !!x.answers && typeof x.answers === 'object' && Object.values(x.answers as object).every(isInt)
    && (x.opened === undefined || typeof x.opened === 'boolean');
}

// ---------- Phase 3 crew: RunState.crew (optional; saves without it get the two starters on load) ----------
/** Each entry: id, level 1..MAX_LV, XP >= 0, and the optional crew.ts flags (from, fresh, waiting). */
function validCrew(c: unknown): boolean {
  return Array.isArray(c) && c.every((m) => {
    const x = m as { id?: unknown; lv?: unknown; xp?: unknown; from?: unknown; fresh?: unknown; waiting?: unknown };
    return !!x && typeof x === 'object' && typeof x.id === 'string' && isInt(x.lv) && x.lv >= 1 && x.lv <= MAX_LV && isNum(x.xp) && x.xp >= 0
      && (x.from === undefined || typeof x.from === 'string') && (x.fresh === undefined || typeof x.fresh === 'boolean')
      && (x.waiting === undefined || typeof x.waiting === 'boolean');
  }) && new Set(c.map((m: { id: string }) => m.id)).size === c.length;
}
// ---------- end Phase 3 crew block ----------

/** The saved run, or null. An unreadable or incompatible save is cleared. */
export function loadRun(): RunState | null {
  const s = store();
  const raw = s?.getItem(SAVE_KEY);
  if (!s || !raw) return null;
  try {
    const f = JSON.parse(raw) as SaveFile;
    if (f && f.v === SAVE_VERSION && validRun(f.run)) {
      ensureCrew(f.run); // Phase 3: saves from before crew get the two starters
      return f.run;
    }
  } catch {
    // fall through: not JSON
  }
  s.removeItem(SAVE_KEY);
  return null;
}

export function saveRun(run: RunState): void {
  const f: SaveFile = { v: SAVE_VERSION, at: Date.now(), run };
  try {
    store()?.setItem(SAVE_KEY, JSON.stringify(f));
  } catch {
    // storage full or blocked: the run goes on unsaved
  }
}

export function clearRun(): void {
  store()?.removeItem(SAVE_KEY);
}

/** Scrap a new campaign starts with: the first workshop (Farmland's first freed village) comes before much salvage,
 * so it still buys a charge or two and a repair (2026-11-18 scrap economy; it was 0 when scrap flowed freely). */
export const START_SCRAP = 50;

/** A fresh run with a random seed. */
export function freshRun(): RunState {
  const run = newRun(1 + Math.floor(Math.random() * 999983));
  run.scrap = START_SCRAP;
  ensureCrew(run); // Phase 3: TRACTOR and SPANNER
  return run;
}

// ---------- regions of a run ----------
/** The five regions in run order (CAMPAIGN.md "Regions and bosses"). After the fifth the cycle repeats ("RAIL
 * JUNCTION II" ...); difficulty keeps rising with the region number (World stage = region + 1). */
export const REGION_TABLE: { kind: RegionKind; name: string; env: EnvName; boss: BossKind }[] = [
  { kind: 'farm', name: 'FARMLAND', env: 'day', boss: 'grinder' },
  { kind: 'rail', name: 'RAIL JUNCTION', env: 'dusk', boss: 'train' },
  { kind: 'delta', name: 'RIVER DELTA', env: 'rain', boss: 'flagship' },
  { kind: 'ruins', name: 'RUINED TOWN', env: 'night', boss: 'heli' },
  { kind: 'winter', name: 'WINTER FRONT', env: 'snow', boss: 'final' },
];
const ROMAN = ['', 'II', 'III', 'IV', 'V', 'VI', 'VII', 'VIII', 'IX', 'X'];

function regionRow(i: number) {
  return REGION_TABLE[((i % REGION_TABLE.length) + REGION_TABLE.length) % REGION_TABLE.length];
}

export function regionName(i: number): string {
  const lap = Math.floor(i / REGION_TABLE.length);
  return lap === 0 ? regionRow(i).name : `${regionRow(i).name} ${ROMAN[lap] ?? String(lap + 1)}`;
}

export function regionEnv(i: number): EnvName {
  return regionRow(i).env;
}

export function regionKind(i: number): RegionKind {
  return regionRow(i).kind;
}

/** Region i's map from a map seed, with the run's name, look and boss for that region. */
export function regionSpecFor(i: number, mapSeed: number): RegionSpec {
  const row = regionRow(i);
  const spec = makeRegion(row.kind, mapSeed);
  spec.name = regionName(i);
  spec.env = row.env;
  spec.boss = row.boss;
  return spec;
}

/** The region the run is on. Same seed every attempt, so a retreat replays the same map. */
export function campaignRegion(run: RunState): RegionSpec {
  return regionSpecFor(run.region, run.seed * 31 + run.region);
}

/** Base ease of the first lap's regions (balance pass, npm run balance:many). Targets: about 0.3, 0.5, 0.8, 1.0, 1.2
 * retreats per clear for the sim's bot. Below 0 the enemy reacts quicker, sends columns sooner and reloads faster
 * (tells stay as long as designed). Kept at 0.3 or less so a retreat still adds its full 10-20% (the cap is 50%).
 * (2026-11-18, after the bot stopped sticking to steel gate posts and the field patch got its 15 s cooldown: the
 * cooldown is what makes a region dangerous now, so the bases went up again; the earlier pass had 0.2, 0.1, 0.25,
 * -0.1, -0.2 against a bot that could patch every quarter second.) */
export const REGION_EASE = [0.3, 0.2, 0.3, 0, 0.3];

/** Retreat bonuses: +1 starting life per retreat (max +2), enemies 10% slower to react per retreat (max 30%, on top of
 * REGION_EASE; 50% in all, which is where the AI, the tricks and the bosses stop reading it). */
export function bonusLives(run: RunState): number {
  return Math.min(2, run.regionRetreats ?? 0);
}

export function easeFor(run: RunState): number {
  return Math.min(0.5, baseEase(run) + Math.min(0.3, (run.regionRetreats ?? 0) * 0.1));
}

/** The region's own starting ease (REGION_EASE), which the player never sees as a retreat bonus. */
export function baseEase(run: RunState): number {
  return run.region < REGION_EASE.length ? REGION_EASE[run.region] : 0;
}

/** The part of easeFor that retreats added (what the retreat card and the intro show): 10% per retreat up to 30%,
 * less where the 50% cap cuts in (River Delta's third retreat: 25% + 25%). */
export function retreatEase(run: RunState): number {
  return Math.max(0, easeFor(run) - baseEase(run));
}

/** Sets a campaign tank's stats from its parts: base values first, so fitting again after the garage is safe. */
export function fitTank(t: Tank, loadout: Loadout): void {
  const full = t.armour >= t.armourMax;
  t.armourMax = ARMOUR_MAX + t.vet;
  t.speedMul = 1;
  t.firepower = 0;
  t.reloadMul = 1;
  applyLoadout(t, loadout);
  t.fitted = { ...loadout }; // Phase 3: tricks.ts reads the jammer and plough slots
  t.armour = full ? t.armourMax : Math.min(t.armour, t.armourMax);
  noteBase(t); // Phase 3 crew: speed / reload perks scale from the parts' numbers
}

/**
 * A World for the run's current region. ps is refilled in place (fresh per attempt: lives with the retreat bonus,
 * veterancy from the run). testSeed = a ?region=N quick-test map instead of the run's own; testSpec = a given map
 * (Phase 4 ?bosstest=).
 */
export function regionWorld(run: RunState, ps: PState[], nPlayers: number, testSeed = 0, testSpec?: RegionSpec): World {
  for (let i = 0; i < 2; i++) {
    const p = newPState();
    p.lives = 2 + bonusLives(run);
    p.vet = run.vet[i];
    p.vetXp = run.vetXp[i];
    ps[i] = p;
  }
  // ?region=N quick tests use test seed N; &stage=K picks region K-1 (2 = rail junction ... 5 = winter front);
  // ?bosstest= hand-made boss maps (Phase 4)
  const spec = testSpec ?? (testSeed ? regionSpecFor(run.region, testSeed + run.region) : campaignRegion(run));
  const w = new World(run.region + 1, ps, nPlayers, spec);
  w.ease = easeFor(run);
  w.scrap = run.scrap;
  w.charges = [...run.charges];
  w.partsFound = run.bin.length;
  w.onSpawn = (t) => fitTank(t, run.fitted[t.player] ?? {});
  for (const t of w.players) if (t) fitTank(t, run.fitted[t.player] ?? {});
  applyCrew(w, ensureCrew(run)); // Phase 3: unlocked abilities and perks
  // Phase 5 events hook: the region's map events (resolved ones stay resolved; a retreat brings the rest back)
  if (w.towns.length) w.events = new MapEvents(w, testSpec ? 'farm' : regionKind(run.region), run.region, run.events?.[String(run.region)]);
  if (testSpec?.arena) attachArena(w); // ?arena=tricks: staged targets and tricks, 9 charges, 9 lives
  // the run's own map (not a quick test): towns freed and depots destroyed on an earlier attempt stay done
  if (!testSeed && !testSpec) {
    w.keepsProgress = true;
    restoreProgress(w, run);
  }
  return w;
}

/** The run's region progress, if it belongs to the region being played. */
export function regionProgress(run: RunState): RegionProgress | null {
  const p = run.progress;
  return p && p.region === run.region ? p : null;
}

/**
 * Towns freed and depots destroyed on an earlier attempt (CONTINUE or a retreat) are done again: freed towns fly
 * their flag (workshop, no garrison; the AI may still counterattack them), the last one freed is the checkpoint,
 * destroyed depots only smoulder. Nothing is paid twice. The boss is not part of it: it restarts at full strength.
 */
export function restoreProgress(w: World, run: RunState): void {
  const p = regionProgress(run);
  if (!p) return;
  for (const name of p.towns) {
    const t = w.towns.find((x) => x.name === name);
    if (!t) continue;
    t.freed = true;
    t.progress = 1;
    w.checkpoint = t;
  }
  for (const name of p.depots) {
    const d = w.depots.find((x) => x.name === name);
    if (!d || d.destroyed) continue;
    d.destroyed = true;
    d.hp = 0;
    d.burnT = DEPOT_BURN;
  }
}

/** Copy the world's freed towns (oldest first, the checkpoint last) and destroyed depots into run.progress. */
function syncProgress(w: World, run: RunState): void {
  if (!w.keepsProgress) return;
  let p = regionProgress(run);
  const freed = w.towns.filter((t) => t.freed);
  const gone = w.depots.filter((d) => d.destroyed);
  if (p && p.towns.length === freed.length && p.depots.length === gone.length
    && freed.every((t) => p!.towns.includes(t.name)) && p.towns[p.towns.length - 1] === (w.checkpoint?.name ?? p.towns[p.towns.length - 1])) return;
  if (!p) p = run.progress = { region: run.region, towns: [], depots: [] };
  const names = freed.map((t) => t.name);
  const towns = p.towns.filter((n) => names.includes(n));
  for (const n of names) if (!towns.includes(n)) towns.push(n);
  // the checkpoint (the town knocked-out tanks return to) goes last
  const cp = w.checkpoint?.freed ? w.checkpoint.name : null;
  if (cp && towns.includes(cp)) towns.push(...towns.splice(towns.indexOf(cp), 1));
  p.towns = towns;
  p.depots = gone.map((d) => d.name);
}

/** Copy what the World changed back into the run (scrap, charges, veterancy, parts found). Call every update. */
export function syncRun(w: World, run: RunState): void {
  run.scrap = w.scrap;
  run.charges = [...w.charges];
  for (let i = 0; i < w.nPlayers; i++) {
    run.vet[i] = w.ps[i].vet;
    run.vetXp[i] = w.ps[i].vetXp;
  }
  if (w.found.length) run.bin.push(...w.found.splice(0));
  w.events?.save(run); // Phase 5 events hook
  syncProgress(w, run);
}

/** After the garage: the run's scrap, charges and loadouts go back into the World and its live tanks. */
export function applyRunToWorld(w: World, run: RunState, armour?: [number, number][]): void {
  w.scrap = run.scrap;
  w.charges = [...run.charges];
  w.partsFound = run.bin.length;
  w.onSpawn = (t) => fitTank(t, run.fitted[t.player] ?? {});
  w.players.forEach((t, i) => {
    if (!t || !t.alive) return;
    fitTank(t, run.fitted[i] ?? {});
    const a = armour?.[i];
    if (a && a[0] > 0) t.armour = Math.max(1, Math.min(t.armourMax, Math.round(a[0])));
  });
  applyCrew(w, run.crew); // Phase 3: levels may have changed in the camp
}
