// Phase 3 crew (CAMPAIGN.md "Crew"): the named people riding in the two tanks. Each has one perk (levelled up at a
// workshop with crew XP) and some unlock an ability type (w.unlocked; the abilities module checks it). A run starts
// with TRACTOR (driver) and SPANNER (mechanic); freed towns offer the others (recruitOffer), and a "NOT NOW" recruit
// waits at the next workshop. All in-game perk effects are applied from here, around World.update, without hooks in
// world.ts: crewTick(w, run) runs once after every campaign update (app.ts campaignTick, tools/sim.ts).
// Portraits are drawn by ui-campaign.ts (radioFace(call)); the camp CREW tab and the recruit card are in ui-garage.ts.
import { EMPTY, ROAD } from './constants';
import type { CrewState, RunState } from './run';
import type { Bullet, Pickup, Tank, World } from './world';

// ---------- catalogue ----------
/** Ability types a crew member can unlock, in w.unlocked / w.charges order (keys 1-4). */
export const ABILITY_NAMES = ['FPV DRONE STRIKE', 'INFANTRY AMBUSH', 'RECON DRONE', 'FIELD PATCH'];
export const ABILITY_SHORT = ['FPV', 'AMBUSH', 'RECON', 'PATCH'];
export const ABILITY_ICONS = ['fpv', 'ambush', 'recon', 'repair'];
/** Scrap to craft one charge at a workshop (drone, ambush, recon, patch), before HOT GLUE. */
export const CRAFT_COST = [32, 30, 20, 20];
/** Workshop repair: +3 armour for this much scrap, before BY THE BOOK. */
export const REPAIR_BASE = 15;

/** Crew level cap, and XP to go from level n to n + 1 (index n). */
export const MAX_LV = 6;
export const XP_NEXT = [0, 200, 300, 400, 500, 700];
/** XP every crew member aboard gets: per kill by enemy type (basic, fast, power, armor), per town, depot, region. */
export const XP = { kill: [5, 6, 7, 12], town: 40, depot: 30, region: 100 };

export interface PerkDef {
  id: string;
  name: string;
  /** the perk's number at level 1..MAX_LV */
  val: number[];
  /** the full line on the crew card */
  desc: (v: number) => string;
  /** the short "LV 3: ..." line */
  short: (v: number) => string;
}

export interface CrewDef {
  id: string;
  name: string;
  /** call sign: radio speaker name and portrait key (ui-campaign.ts WHO) */
  call: string;
  role: string;
  perk: PerkDef;
  /** ability type index it unlocks (0 drone, 1 ambush, 2 recon, 3 patch), -1 = none */
  unlock: number;
  /** what the UNLOCKS box says instead of / under the ability */
  unlockNote: string;
  quip: string;
  /** T TALK lines */
  talk: string[];
  /** starter (aboard from the first region) */
  starter?: boolean;
  /** recruits: the earliest region index that offers them */
  minRegion: number;
  /** recruit card lines ({T} = the town); [speaker call sign, text] */
  meet: [string, string][];
  /** recruit card when they waited at the workshop */
  again: [string, string][];
  /** radio line when they join */
  joined: string;
  /** radio line the first time their perk does something in a region */
  perkLine?: string;
}

const pct = (v: number) => `${v}%`;
const secs = (f: number) => String(Math.round((f / 60) * 10) / 10);

export const PERKS: Record<string, PerkDef> = {
  ploughman: {
    id: 'ploughman', name: 'PLOUGHMAN', val: [8, 9, 10, 11, 12, 14],
    desc: (v) => `THE TANKS DRIVE ${pct(v)} FASTER ON FIELDS AND ROADS.`, short: (v) => `${pct(v)} FASTER`,
  },
  'steady-hand': {
    id: 'steady-hand', name: 'STEADY HAND', val: [60, 48, 42, 36, 30, 24],
    desc: (v) => `FIRST SHOT AFTER STANDING STILL ${secs(v)} S HITS ARMOURED TANKS FOR +1.`, short: (v) => `STILL FOR ${secs(v)} S`,
  },
  'scrap-sense': {
    id: 'scrap-sense', name: 'SCRAP SENSE', val: [25, 30, 35, 40, 45, 50],
    desc: (v) => `WRECKS DROP ${pct(v)} MORE SCRAP.`, short: (v) => `${pct(v)} MORE SCRAP`,
  },
  'hot-glue': {
    id: 'hot-glue', name: 'HOT GLUE', val: [20, 25, 35, 40, 45, 50],
    desc: (v) => `FPV CHARGES COST ${pct(v)} LESS SCRAP TO CRAFT.`, short: (v) => `${pct(v)} LESS SCRAP`,
  },
  'night-eyes': {
    id: 'night-eyes', name: 'NIGHT EYES', val: [3, 3.5, 4, 4.5, 5, 6],
    desc: (v) => `MINES WITHIN ${v} TILES SHOW UP ON THEIR OWN.`, short: (v) => `${v} TILES`,
  },
  'quick-hands': {
    id: 'quick-hands', name: 'QUICK HANDS', val: [8, 10, 12, 14, 16, 18],
    desc: (v) => `THE GUNS RELOAD ${pct(v)} FASTER.`, short: (v) => `${pct(v)} FASTER`,
  },
  'pen-pals': {
    id: 'pen-pals', name: 'PEN PALS', val: [5, 8, 10, 13, 15, 18], // was 10-35 (2026-11-18 scrap economy: a town gives 10)
    desc: (v) => `EVERY FREED TOWN SENDS ${v} EXTRA SCRAP.`, short: (v) => `+${v} SCRAP`,
  },
  'by-the-book': {
    id: 'by-the-book', name: 'BY THE BOOK', val: [20, 25, 30, 35, 40, 45],
    desc: (v) => `WORKSHOP REPAIRS COST ${pct(v)} LESS SCRAP.`, short: (v) => `${pct(v)} LESS`,
  },
};

/** NIGHT EYES radius per tile (a tile = one tank, 16 px). The tricks module: nightEyesRange(w). */
export const TILE_PX = 16;
/** SPANNER's patch bonus: every PATCH (ability 4) mends this much more armour. */
export const SPANNER_PATCH_BONUS = 1;

export const CREW: CrewDef[] = [
  {
    id: 'mykola', name: 'MYKOLA', call: 'TRACTOR', role: 'DRIVER', perk: PERKS.ploughman, unlock: -1, starter: true, minRegion: 0,
    unlockNote: 'NO ABILITY. HE IS THE ONE DRIVING.',
    quip: 'DROVE A COMBINE FOR 30 YEARS. THIS ONE SHOOTS BACK.',
    talk: ['SHE PULLS LEFT. SO DID MY COMBINE. SO DID MY WIFE.', 'MUD IS JUST A ROAD THAT HAS NOT DECIDED YET.', 'I DO NOT DRIVE FAST. I ARRIVE EARLY.'],
    meet: [], again: [], joined: 'TRACTOR HERE. ENGINE WARM, SEAT COLD. AS USUAL.',
  },
  {
    id: 'halyna', name: 'HALYNA', call: 'AUNTIE', role: 'GUNNER', perk: PERKS['steady-hand'], unlock: 1, minRegion: 1,
    unlockNote: 'HER OLD STUDENTS DIG IN WHERE YOU SAY.',
    quip: 'TAUGHT MATHS FOR 25 YEARS. NOW SHE TEACHES BALLISTICS.',
    talk: ['ANGLE, DISTANCE, PATIENCE. THE REST IS HOMEWORK.', 'I HAVE MARKED WORSE TANKS THAN THAT. IN RED.', 'THE BOYS IN THE TREE LINE CALL ME AUNTIE. THEY ALSO DO WHAT I SAY.'],
    meet: [
      ['SPANNER', 'A TEACHER FROM {T} HAS BEEN CORRECTING OUR AIM FROM THE BUS STOP.'],
      ['AUNTIE', 'YOU MISSED THREE TIMES. I COUNTED. MY OLD STUDENTS HAVE RIFLES AND NOTHING TO DO.'],
      ['AUNTIE', 'GIVE ME THE GUNNER\'S SEAT. I BRING MY OWN RULER.'],
    ],
    again: [['AUNTIE', 'THE BUS STILL HAS NOT COME. IS THE GUNNER\'S SEAT FREE NOW?']],
    joined: 'AUNTIE HERE. SIT UP STRAIGHT AND AIM FOR THE TRACKS.',
    perkLine: 'SEE? STOP, BREATHE, THEN SHOOT. LIKE MARKING HOMEWORK.',
  },
  {
    id: 'yurko', name: 'YURKO', call: 'SPANNER', role: 'MECHANIC', perk: PERKS['scrap-sense'], unlock: 3, starter: true, minRegion: 0,
    unlockNote: `EVERY PATCH MENDS +${SPANNER_PATCH_BONUS} MORE ARMOUR.`,
    quip: 'IF IT RATTLES, IT IS FINE. IF IT STOPS RATTLING, RUN.',
    talk: ['I HAVE NAMED EVERY BOLT. SOME OF THEM ARE NOT TALKING TO ME.', 'SCRAP IS JUST A TANK THAT CHANGED ITS MIND.', 'BRING BACK THE WHEELS. I CAN DO WITHOUT THE REST.'],
    meet: [], again: [], joined: 'SPANNER HERE. WRENCH IN ONE HAND, TEA IN THE OTHER.',
  },
  {
    id: 'sofia', name: 'SOFIA', call: 'WASP', role: 'DRONE OP', perk: PERKS['hot-glue'], unlock: 0, minRegion: 0,
    unlockNote: 'SHE FLIES. YOU POINT.',
    quip: 'BUILT HER FIRST DRONE OUT OF A VACUUM CLEANER. IT STILL SUCKS. LITERALLY.',
    talk: ['EVERY DRONE HAS A NAME. THIS ONE IS CALLED TUESDAY.', 'HOT GLUE FIXES EVERYTHING EXCEPT HOT GLUE.', 'I CAN PARK IT ON A CHIMNEY. I HAVE NOT TOLD THE CHIMNEY.'],
    meet: [
      ['SPANNER', 'SOMEONE IN {T} HAS A BAG OF PROPELLERS AND IS LOOKING AT OUR TANK LIKE IT OWES HER MONEY.'],
      ['WASP', 'MY WORKSHOP WAS THE SCHOOL GARAGE. YOU NEED EYES IN THE SKY, AND SOMETHING THAT STINGS.'],
      ['WASP', 'I BRING MY OWN GLUE.'],
    ],
    again: [['WASP', 'I BUILT TWO MORE WHILE I WAITED. STILL NEED A DRONE OPERATOR?']],
    joined: 'WASP ONLINE. IF YOU HEAR BUZZING, THAT IS ME. PROBABLY.',
  },
  {
    id: 'taras', name: 'TARAS', call: 'OWL', role: 'SCOUT', perk: PERKS['night-eyes'], unlock: 2, minRegion: 2,
    unlockNote: 'HIS DRONE SEES WHAT HE SEES.',
    quip: 'SAYS LITTLE. SEES EVERYTHING. NOBODY KNOWS WHERE HE SLEEPS.',
    talk: ['...', 'THREE TANKS BEHIND THE BARN. ONE IS A COW.', 'I SLEEP WITH ONE EYE OPEN. THE OTHER ONE IS ON THE DRONE.'],
    meet: [
      ['SPANNER', 'A MAN HAS BEEN WATCHING US FROM THE TREES SINCE {T}. HE WAVED. ONCE.'],
      ['OWL', 'MINES ON THE NORTH ROAD. TWO TANKS IN THE ORCHARD. I HAVE A DRONE.'],
      ['OWL', 'I DO NOT TALK MUCH.'],
    ],
    again: [['OWL', 'STILL WATCHING.']],
    joined: 'OWL. IN POSITION.',
    perkLine: 'MINE. LEFT OF THE ROAD. YOU ARE WELCOME.',
  },
  {
    id: 'oksana', name: 'OKSANA', call: 'STITCH', role: 'LOADER', perk: PERKS['quick-hands'], unlock: -1, minRegion: 3,
    unlockNote: 'NO ABILITY. HER HANDS ARE BUSY.',
    quip: 'TWENTY YEARS A NURSE. LOADS SHELLS LIKE SHE CHANGES BANDAGES: FAST, AND WITHOUT ASKING.',
    talk: ['HOLD STILL. NO, NOT YOU. THE TANK.', 'I HAVE SEEN WORSE. IN A CANTEEN.', 'DO NOT THANK ME. JUST STOP GETTING HIT.'],
    meet: [
      ['SPANNER', 'THE NURSE FROM {T} HAS PATCHED UP HALF THE VILLAGE. NOW SHE IS LOOKING AT OUR GUN.'],
      ['STITCH', 'YOUR LOADER IS TOO SLOW. YOU HAVE NO LOADER? THAT EXPLAINS IT.'],
      ['STITCH', 'I LOAD, YOU AIM. AND WASH YOUR HANDS.'],
    ],
    again: [['STITCH', 'MY SHIFT AT THE CLINIC IS OVER. THE OFFER IS NOT.']],
    joined: 'STITCH HERE. THE GUN IS FED. SO ARE YOU: THERE IS SOUP.',
  },
  {
    id: 'danylo', name: 'DANYLO', call: 'STATIC', role: 'RADIO OP', perk: PERKS['pen-pals'], unlock: -1, minRegion: 4,
    unlockNote: 'NO ABILITY. HE IS ON THE RADIO. ALWAYS.',
    quip: 'TALKS TO STRANGERS ON THE SHORTWAVE EVERY NIGHT. NOW THE STRANGERS SEND SCRAP.',
    talk: ['CQ, CQ, THIS IS... SORRY. HABIT.', 'I KNOW A MAN IN EVERY VILLAGE. I HAVE MET NONE OF THEM.', 'THE ANTENNA IS A COAT HANGER. A VERY GOOD COAT HANGER.'],
    meet: [
      ['SPANNER', 'A LAD IN {T} HAS AN ANTENNA ON HIS BICYCLE AND OPINIONS ABOUT OUR RADIO.'],
      ['STATIC', 'YOUR RADIO IS FROM A MUSEUM. I CAN FIX IT. AND I HAVE FRIENDS ON EVERY FREQUENCY.'],
      ['STATIC', 'THEY SEND THINGS. USEFUL THINGS. MOSTLY.'],
    ],
    again: [['STATIC', 'I FOUND YOU ON CHANNEL 4. STILL NEED A RADIO OPERATOR?']],
    joined: 'STATIC ON CHANNEL 4. LOUD AND CLEAR. TOO LOUD? SORRY.',
    perkLine: 'MY PEN PALS IN {T} SENT SCRAP. AND A JAR OF PICKLES.',
  },
  {
    id: 'roman', name: 'ROMAN', call: 'BOOKS', role: 'QUARTERMASTER', perk: PERKS['by-the-book'], unlock: -1, minRegion: 5,
    unlockNote: 'NO ABILITY. HE KEEPS THE LEDGER.',
    quip: 'RAN THE DISTRICT LIBRARY. NOW HE RUNS THE SCRAP PILE. BOTH ARE ALPHABETICAL.',
    talk: ['EVERY BOLT IS SIGNED OUT. EVERY BOLT COMES BACK.', 'LATE FEES APPLY TO TANKS AS WELL.', 'QUIET IN THE WORKSHOP, PLEASE.'],
    meet: [
      ['SPANNER', 'THE LIBRARIAN OF {T} SAYS OUR SCRAP PILE IS A DISGRACE. HE IS NOT WRONG.'],
      ['BOOKS', 'I CATALOGUED FORTY THOUSAND BOOKS. I CAN CATALOGUE YOUR BOLTS.'],
      ['BOOKS', 'REPAIRS WILL BE CHEAPER. AND QUIETER.'],
    ],
    again: [['BOOKS', 'I KEPT YOUR PLACE. WITH A BOOKMARK.']],
    joined: 'BOOKS HERE. THE LEDGER IS OPEN. PLEASE SIGN FOR THE TANK.',
  },
];

const BY_ID = new Map(CREW.map((c) => [c.id, c]));
export function crewById(id: string): CrewDef | undefined {
  return BY_ID.get(id);
}
/** The order towns offer recruits in (each from its minRegion on). */
export const RECRUIT_ORDER = ['sofia', 'halyna', 'taras', 'oksana', 'danylo', 'roman'];

// ---------- run state ----------
/** A crew member as saved in RunState.crew: CrewState plus where they joined, a NEW flag until the CREW tab was
 * seen, and `waiting` for a recruit who heard "NOT NOW" (no perk, no unlock; asks again at the next workshop). */
export interface CrewMember extends CrewState {
  from?: string;
  fresh?: boolean;
  waiting?: boolean;
}

export function starterCrew(): CrewMember[] {
  return CREW.filter((c) => c.starter).map((c) => ({ id: c.id, lv: 1, xp: 0 }));
}

/** Give a run without crew (new runs, saves from before Phase 3) the two starters. */
export function ensureCrew(run: RunState): CrewMember[] {
  if (!Array.isArray(run.crew)) run.crew = starterCrew();
  return run.crew as CrewMember[];
}

/** Everyone in the catalogue aboard (?crew=all test runs). */
export function allCrew(): CrewMember[] {
  return CREW.map((c) => ({ id: c.id, lv: 1, xp: 0 }));
}

/** Crew members aboard (not waiting, known ids), in catalogue order. */
export function aboard(crew: CrewState[] | undefined): CrewMember[] {
  const list = (crew ?? []) as CrewMember[];
  return CREW.map((d) => list.find((m) => m.id === d.id && !m.waiting)).filter((m): m is CrewMember => !!m);
}

/** Roster for the CREW tab: aboard first (catalogue order), then anyone waiting. */
export function roster(crew: CrewState[] | undefined): CrewMember[] {
  const list = (crew ?? []) as CrewMember[];
  const known = (m: CrewMember) => BY_ID.has(m.id);
  const order = (m: CrewMember) => CREW.findIndex((d) => d.id === m.id);
  return [...list.filter((m) => known(m) && !m.waiting), ...list.filter((m) => known(m) && m.waiting)].sort((a, b) => Number(!!a.waiting) - Number(!!b.waiting) || order(a) - order(b));
}

/** The first waiting recruit (asks again at a workshop), or null. */
export function waitingRecruit(run: RunState): CrewMember | null {
  return ((run.crew ?? []) as CrewMember[]).find((m) => m.waiting && BY_ID.has(m.id)) ?? null;
}

/** XP needed for the next level (0 at the cap). */
export function xpNext(lv: number): number {
  return lv >= MAX_LV ? 0 : XP_NEXT[lv] ?? 0;
}
export function canLevel(m: CrewState): boolean {
  return m.lv < MAX_LV && m.xp >= xpNext(m.lv);
}
/** Spend XP on a level (the camp's ENTER LEVEL UP). Returns true if it levelled. */
export function levelUp(m: CrewState): boolean {
  if (!canLevel(m)) return false;
  m.xp -= xpNext(m.lv);
  m.lv++;
  if (m.lv >= MAX_LV) m.xp = 0;
  return true;
}

/** The perk's number for a member at their level. */
export function perkVal(def: CrewDef, lv: number): number {
  return def.perk.val[Math.max(0, Math.min(def.perk.val.length - 1, lv - 1))];
}

/** A perk's number from a crew list (0 when nobody aboard has it). */
export function crewPerk(crew: CrewState[] | undefined, perk: string): number {
  for (const m of aboard(crew)) {
    const d = BY_ID.get(m.id)!;
    if (d.perk.id === perk) return perkVal(d, m.lv);
  }
  return 0;
}

/** Ability types this crew unlocks (patch is always available). */
export function crewUnlocks(crew: CrewState[] | undefined): boolean[] {
  const out = [false, false, false, true];
  for (const m of aboard(crew)) {
    const k = BY_ID.get(m.id)!.unlock;
    if (k >= 0) out[k] = true;
  }
  return out;
}

/** Workshop price of one charge of ability k (HOT GLUE cuts the drone). */
export function craftCost(k: number, crew: CrewState[] | undefined): number {
  const base = CRAFT_COST[k] ?? 20;
  if (k !== 0) return base;
  return Math.round(base * (1 - crewPerk(crew, 'hot-glue') / 100));
}

/** Workshop price of a +3 armour repair (BY THE BOOK cuts it). */
export function repairCost(crew: CrewState[] | undefined): number {
  return Math.max(1, Math.round(REPAIR_BASE * (1 - crewPerk(crew, 'by-the-book') / 100)));
}

/**
 * When recruits come (slower than before: 5 recruits over the 5 regions, one each; it was up to 2 per region):
 * - at most one new crew member per region, counted over the whole run: by region index r (0 = region 1) the run
 *   may have met r + 1 recruits (a "NOT NOW" recruit counts as met),
 * - a freed town offers one only once RECRUIT_TOWNS[r] towns of the region are freed (the 2nd, in every region),
 * - a map event may bring the recruit instead from region 2 on, never in region 1,
 * - who comes is the next of RECRUIT_ORDER not yet met whose minRegion has come:
 *   region 1 WASP (drone), 2 AUNTIE (ambush), 3 OWL (recon), 4 STITCH, 5 STATIC; BOOKS is never offered (roster only).
 */
export const RECRUIT_TOWNS = [2, 2, 2, 2, 2];
/** Recruits a run may have met by region index r. */
export function recruitCap(region: number): number {
  return Math.max(0, region) + 1;
}

/**
 * Who a freed town (or a map event, `viaEvent`) offers now. `freedTowns` = towns of this region freed so far
 * (kept ones count). Null when it is too early, this region's recruit has come, or nobody is left.
 */
export function recruitOffer(run: RunState, freedTowns: number, viaEvent = false): CrewDef | null {
  const region = run.region;
  if (viaEvent ? region < 1 : freedTowns < (RECRUIT_TOWNS[region] ?? RECRUIT_TOWNS[RECRUIT_TOWNS.length - 1])) return null;
  const met = new Set((run.crew ?? []).map((m) => m.id));
  if (RECRUIT_ORDER.filter((id) => met.has(id)).length >= recruitCap(region)) return null;
  for (const id of RECRUIT_ORDER) {
    const d = BY_ID.get(id)!;
    if (!met.has(id) && d.minRegion <= region) return d;
  }
  return null;
}

/** "NOT NOW": the recruit waits at the next workshop. */
export function deferCrew(run: RunState, id: string, from: string): void {
  const crew = ensureCrew(run);
  if (crew.some((m) => m.id === id)) return;
  crew.push({ id, lv: 1, xp: 0, from, waiting: true });
}

/**
 * "WELCOME ABOARD": the recruit joins the run (NEW until the CREW tab is seen), with one charge of the ability they
 * unlock. With a world (in play or a workshop), the crew is applied to it at once, with a toast and a radio line.
 */
export function joinCrew(run: RunState, id: string, from: string, w?: World | null): CrewDef | null {
  const d = BY_ID.get(id);
  if (!d) return null;
  const crew = ensureCrew(run);
  let m = crew.find((c) => c.id === id);
  if (!m) crew.push((m = { id, lv: 1, xp: 0 }));
  delete m.waiting;
  m.fresh = true;
  m.from = from;
  const k = d.unlock;
  const charge = k >= 0 && k < 3;
  if (charge) run.charges[k] = (run.charges[k] ?? 0) + 1;
  if (w) {
    applyCrew(w, crew);
    if (charge) w.charges[k] = (w.charges[k] ?? 0) + 1;
    w.note(charge ? `${d.call} JOINS THE CREW · ${ABILITY_SHORT[k]} +1` : `${d.call} JOINS THE CREW`, 'power');
    w.radio.push({ who: d.call, text: d.joined });
    if (w.radio.length > 20) w.radio.shift();
  }
  return d;
}

/** The recruit card's lines with the town filled in. */
export function meetLines(d: CrewDef, town: string, again: boolean): [string, string][] {
  return (again && d.again.length ? d.again : d.meet).map(([who, t]) => [who, t.replace('{T}', town)]);
}

/**
 * Crew XP for a run event, to everyone aboard. kill: n = enemy type. Returns the members who just became able to
 * level up (for a toast).
 */
export function crewXp(run: RunState, ev: 'kill' | 'town' | 'depot' | 'region', n = 0): CrewMember[] {
  const gain = ev === 'kill' ? XP.kill[n] ?? XP.kill[0] : XP[ev];
  const ready: CrewMember[] = [];
  for (const m of aboard(run.crew)) {
    if (m.lv >= MAX_LV) continue;
    const was = canLevel(m);
    m.xp += gain;
    if (!was && canLevel(m)) ready.push(m);
  }
  return ready;
}

// ---------- applying the crew to a World ----------
/** perk id -> level, per world (applyCrew). */
const LEVELS = new WeakMap<World, Map<string, number>>();

/**
 * Sets w.unlocked (ability types) and w.perks (perk ids) from the crew aboard; the perks' numbers come from their
 * levels (perkLevel / nightEyesRange). Call at region start, after recruiting and after the camp.
 */
export function applyCrew(w: World, crew: CrewState[] | undefined): void {
  const un = crewUnlocks(crew);
  for (let k = 0; k < 4; k++) w.unlocked[k] = un[k];
  w.perks.clear();
  const lv = new Map<string, number>();
  for (const m of aboard(crew)) {
    const d = BY_ID.get(m.id)!;
    w.perks.add(d.perk.id);
    lv.set(d.perk.id, Math.max(1, Math.min(MAX_LV, m.lv)));
  }
  LEVELS.set(w, lv);
}

/** Level 1-6 of an active perk in this world, 0 if nobody aboard has it. */
export function perkLevel(w: World, perk: string): number {
  return w.perks.has(perk) ? LEVELS.get(w)?.get(perk) ?? 1 : 0;
}

/** An active perk's number in this world (0 if off). */
export function worldPerk(w: World, perk: string): number {
  const lv = perkLevel(w, perk);
  return lv ? PERKS[perk]?.val[lv - 1] ?? 0 : 0;
}

/** NIGHT EYES: px around each player within which mines show on their own (0 = perk off). For tricks.ts. */
export function nightEyesRange(w: World): number {
  return worldPerk(w, 'night-eyes') * TILE_PX;
}

/** Each campaign tank's speed / reload multipliers from its parts (save.ts fitTank notes them after fitting). */
const BASE = new WeakMap<Tank, { speed: number; reload: number }>();
export function noteBase(t: Tank): void {
  BASE.set(t, { speed: t.speedMul, reload: t.reloadMul });
}

interface TickState {
  kills: number[];
  towns: number;
  depots: number;
  patches: number;
  armour: number[];
  still: number[];
  seenB: WeakSet<Bullet>;
  steady: Set<Bullet>;
  seenP: WeakSet<Pickup>;
  said: Set<string>;
  steadyHits: number;
}
const TICK = new WeakMap<World, TickState>();

function tickState(w: World): TickState {
  let s = TICK.get(w);
  if (!s) {
    s = {
      kills: killCount(w), towns: w.stats.townsFreed, depots: w.stats.depots, patches: w.stats.patches,
      armour: w.players.map((t) => t?.armour ?? 0), still: [0, 0], seenB: new WeakSet(), steady: new Set(), seenP: new WeakSet(),
      said: new Set(), steadyHits: 0,
    };
    for (const p of w.pickups) s.seenP.add(p);
    for (const b of w.bullets) s.seenB.add(b);
    TICK.set(w, s);
  }
  return s;
}

/** Kills so far in this world by enemy type (both players). */
function killCount(w: World): number[] {
  const n = [0, 0, 0, 0];
  for (let i = 0; i < w.nPlayers; i++) (w.ps[i]?.kills ?? []).forEach((k, e) => { n[e] += k; });
  return n;
}

/** A perk's radio line, once per world. */
function sayOnce(w: World, s: TickState, d: CrewDef, town = ''): void {
  if (!d.perkLine || s.said.has(d.id)) return;
  s.said.add(d.id);
  w.radio.push({ who: d.call, text: d.perkLine.replace('{T}', town) });
  if (w.radio.length > 20) w.radio.shift();
}

/** Counts for the sim and screenshots: STEADY HAND shells fired / landed in this world. */
export function crewDebug(w: World): { steadyShells: number; steadyHits: number } {
  const s = TICK.get(w);
  return { steadyShells: s ? s.steady.size : 0, steadyHits: s?.steadyHits ?? 0 };
}

/**
 * Once after every campaign World.update: crew XP from kills, towns and depots, and the in-game perks:
 * PLOUGHMAN (speed on fields and roads), QUICK HANDS (reload), STEADY HAND (+1 damage to an armoured tank from the
 * first shell after standing still), SCRAP SENSE (fresh wreck scrap), SPANNER's patch bonus, PEN PALS (scrap per
 * freed town). Toasts and radio lines go into w.notes / w.radio like the world's own.
 */
export function crewTick(w: World, run: RunState): void {
  if (!w.region) return;
  const s = tickState(w);
  const crew = run.crew;
  // ----- XP -----
  const ready: CrewMember[] = [];
  const kills = killCount(w);
  kills.forEach((k, e) => { for (let n = s.kills[e]; n < k; n++) ready.push(...crewXp(run, 'kill', e)); });
  s.kills = kills;
  const towns = w.stats.townsFreed;
  if (towns > s.towns) {
    for (let n = s.towns; n < towns; n++) ready.push(...crewXp(run, 'town'));
    const pals = worldPerk(w, 'pen-pals');
    if (pals) {
      const t = w.checkpoint;
      w.scrap += pals * (towns - s.towns);
      if (t) w.popups.push({ x: t.cx, y: t.cy - 24, text: `+${pals} PEN PALS`, t: 0, col: [0.6, 0.9, 1] });
      const d = CREW.find((c) => c.perk.id === 'pen-pals');
      if (d) sayOnce(w, s, d, t?.name ?? '');
    }
  }
  s.towns = towns;
  if (w.stats.depots > s.depots) for (let n = s.depots; n < w.stats.depots; n++) ready.push(...crewXp(run, 'depot'));
  s.depots = w.stats.depots;
  for (const m of ready) {
    const d = BY_ID.get(m.id);
    if (d) w.note(`${d.call} CAN LEVEL UP AT A WORKSHOP`, 'info');
  }

  // ----- SPANNER: patches mend +1 more -----
  const spanner = aboard(crew).some((m) => m.id === 'yurko');
  if (w.stats.patches > s.patches && spanner) {
    w.players.forEach((t, i) => {
      if (!t || !t.alive) return;
      if (t.armour > (s.armour[i] ?? 0) && t.armour < t.armourMax) {
        const add = Math.min(SPANNER_PATCH_BONUS, t.armourMax - t.armour);
        t.armour += add;
        w.popups.push({ x: t.cx + 8, y: t.cy - 10, text: `+${add} SPANNER`, t: 0, col: [0.5, 1, 0.5] });
      }
    });
  }
  s.patches = w.stats.patches;

  // ----- SCRAP SENSE: wreck scrap dropped this update -----
  const sense = worldPerk(w, 'scrap-sense');
  for (const p of w.pickups) {
    if (s.seenP.has(p)) continue;
    s.seenP.add(p);
    if (sense && p.kind === 'scrap' && p.t <= 2) p.amount = Math.round(p.amount * (1 + sense / 100));
  }

  // ----- tanks: PLOUGHMAN, QUICK HANDS, STEADY HAND -----
  const plough = worldPerk(w, 'ploughman');
  const quick = worldPerk(w, 'quick-hands');
  const need = worldPerk(w, 'steady-hand');
  for (let i = 0; i < w.nPlayers; i++) {
    const t = w.players[i];
    if (!t || !t.alive) {
      s.still[i] = 0;
      continue;
    }
    let base = BASE.get(t);
    if (!base) {
      noteBase(t);
      base = BASE.get(t)!;
    }
    const cell = w.map.at(Math.floor(t.cx / 4), Math.floor(t.cy / 4));
    const field = cell === EMPTY || cell === ROAD;
    t.speedMul = base.speed * (plough && field ? 1 + plough / 100 : 1);
    t.reloadMul = base.reload * (quick ? 1 - quick / 100 : 1);
    let fired = false;
    for (const b of w.bullets) {
      if (b.owner !== t || s.seenB.has(b)) continue;
      s.seenB.add(b);
      fired = true;
      if (need && !t.moving && s.still[i] >= need) s.steady.add(b);
    }
    s.still[i] = fired || t.moving || t.spawn > 0 ? 0 : s.still[i] + 1;
  }
  // a STEADY HAND shell that just hit an armoured tank (it survived the hit: World.hitEnemy flashed it) does +1
  for (const b of s.steady) {
    if (b.alive) continue;
    s.steady.delete(b);
    const e = w.enemies.find((t) => t.alive && t.flash === 8 && t.hp > 0 && Math.abs(t.cx - b.x) < 13 && Math.abs(t.cy - b.y) < 13);
    if (!e) continue;
    e.hp -= 1;
    s.steadyHits++;
    w.popups.push({ x: e.cx, y: e.cy - 12, text: '+1 STEADY', t: 0, col: [1, 0.85, 0.4] });
    const d = CREW.find((c) => c.perk.id === 'steady-hand');
    if (d) sayOnce(w, s, d);
    if (e.hp <= 0) w.killEnemy(e, b.owner.player);
  }
  s.armour = w.players.map((t) => t?.armour ?? 0);
}
