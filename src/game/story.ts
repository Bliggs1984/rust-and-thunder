// Phase 5 story (CAMPAIGN.md "Story"): the campaign's plot as data, and the rules for the scenes that carry it.
// Two layers: one radio line on every mission card (introQuote, debriefLine; the retreat card has its own), and
// short scenes with portraits between regions: the opening (how the crew got BABUSYA), a briefing before each of the
// five regions with 1-3 answers that each give a small reward, and the ending after the final boss. The screens are
// drawn by src/ui-story.ts; the run flow (app.ts) decides when they show. No DOM here, so the sim can use it.
//
// Setting (all invented, CAMPAIGN.md "Setting rules"): the country ZORIANA, invaded by THE VORSK DOMINION. Enemies
// are machines and units; civilians are people to free and protect.
import { CRAFT_COST, aboard, crewById, crewUnlocks } from './crew';
import type { BossKind } from './region';
import type { RunState, StoryState } from './run';

export const COUNTRY = 'ZORIANA';
export const INVADER = 'THE VORSK DOMINION';
/** Campaign title (draft, CAMPAIGN.md "Still to decide"). */
export const CAMPAIGN_TITLE = "BABUSYA'S ROAD";
/** The story's regions: briefings, the ending and the region strip cover these five; later regions are LIBERATION. */
export const STORY_REGIONS = 5;
export const ROMAN = ['I', 'II', 'III', 'IV', 'V', 'VI', 'VII', 'VIII', 'IX', 'X'];

/** Pixel backdrop of a scene (ui-story.ts draws them): where the crew is when it is told. */
export type Backdrop = 'farm' | 'rail' | 'delta' | 'ruins' | 'winter' | 'spring';
export interface Line { who: string; text: string }
export type Reward = { kind: 'charge'; k: number; n: number } | { kind: 'scrap'; n: number } | { kind: 'hint' };
export interface Choice { text: string; reward: Reward; reply?: Line }
export interface Page {
  /** gold tag over the title, and the text after it */
  tag: string;
  sub: string;
  title: string;
  bg: Backdrop;
  lines: Line[];
  choices?: Choice[];
}
/** A line only some crews have: the first speaker aboard says it, else the fallback (a starter, always aboard). */
interface Opt { alts: Line[]; fallback?: Line }
type Script = (Line | Opt)[];

// ---------- the plot ----------
const OPENING: { title: string; lines: Line[] }[] = [
  {
    title: 'HOW WE GOT BABUSYA',
    lines: [
      { who: 'SPANNER', text: 'LET ME GET THIS RIGHT. A DOMINION TANK. IN YOUR BEET FIELD. ENGINE RUNNING. CREW GONE.' },
      { who: 'TRACTOR', text: 'THEY RAN WHEN THEY SAW MY COMBINE. I THINK THEY THOUGHT IT WAS A NEW WEAPON.' },
      { who: 'SPANNER', text: 'IT LEAKS, IT PULLS LEFT, AND IT IS OLDER THAN BOTH OF US.' },
      { who: 'TRACTOR', text: 'LIKE MY BABUSYA, GOD REST HER. THAT IS HER NAME NOW.' },
    ],
  },
  {
    title: 'HOW WE GOT BABUSYA',
    lines: [
      { who: 'KOVAL', text: 'TANK ON THE FARM ROAD, THIS IS MAJOR KOVAL, DISTRICT HQ. YOU ARE DRIVING ONE OF THEIRS WITH OUR FLAG ON THE AERIAL.' },
      { who: 'TRACTOR', text: 'IT WAS THE ONLY POLE WE HAD.' },
      { who: 'KOVAL', text: 'I HAVE NO TANKS AND NO TIME. YOU HAVE A TANK. CONGRATULATIONS: YOU ARE NOW A UNIT.' },
      { who: 'SPANNER', text: 'A UNIT. MY MOTHER WILL BE SO PROUD. AND SO WORRIED.' },
    ],
  },
];

interface Briefing { lines: Script; choices: Choice[] }
const BRIEFINGS: Briefing[] = [
  { // 0 FARMLAND: GRINDER, the heavy tank ace
    lines: [
      { who: 'KOVAL', text: 'THE DOMINION HOLDS THE FARM VILLAGES ALONG THE RIVER ROAD. PEOPLE ARE HIDING IN THEIR CELLARS. GET THEM OUT.' },
      { who: 'SPANNER', text: 'WITH ONE TANK?' },
      { who: 'KOVAL', text: 'WITH ONE TANK. THE FARMERS TALK ABOUT A HEAVY TANK THAT GOES THROUGH HEDGES LIKE THEY ARE NOT THERE. THEY CALL IT GRINDER.' },
    ],
    choices: [
      { text: '"WE\'LL MANAGE."', reward: { kind: 'charge', k: 3, n: 1 } },
      { text: '"WE NEED SPARES."', reward: { kind: 'scrap', n: 20 } },
      { text: '"WHO ELSE IS OUT THERE?"', reward: { kind: 'hint' },
        reply: { who: 'KOVAL', text: 'PEOPLE IN THE VILLAGES WANT TO HELP. A TEACHER. A GIRL WITH DRONES. WHEN THEY ASK, SAY YES.' } },
    ],
  },
  { // 1 RAIL JUNCTION: ANVIL, the armoured train (the approved mockup's lines)
    lines: [
      { who: 'KOVAL', text: 'GOOD WORK IN THE FIELDS. THE FARMERS SAY THANK YOU, AND PLEASE STOP DRIVING THROUGH THE SUNFLOWERS.' },
      { who: 'TRACTOR', text: 'TELL THEM THE SUNFLOWERS STARTED IT.' },
      { who: 'KOVAL', text: 'NEXT IS STARYI MLYN JUNCTION. THEY MOVE ARMOUR BY TRAIN, AT NIGHT, WITH THE LIGHTS ON. NOBODY HERE KNOWS WHY EITHER.' },
      { alts: [{ who: 'AUNTIE', text: 'THE RAILWAYMEN SAY ONE TRAIN IS ARMOURED. THEY CALL IT ANVIL. I CALL IT LATE.' }],
        fallback: { who: 'SPANNER', text: 'THE RAILWAYMEN SAY ONE TRAIN IS ARMOURED. THEY CALL IT ANVIL. I WANT ITS WHEELS.' } },
    ],
    choices: [
      { text: '"WE\'LL DERAIL IT FROM THE FOREST."', reward: { kind: 'charge', k: 1, n: 1 } },
      { text: '"SEND US DRONES. WE\'LL DO THE REST."', reward: { kind: 'charge', k: 0, n: 2 } },
      { text: '"IS THE STATION EMPTY?"', reward: { kind: 'hint' },
        reply: { who: 'KOVAL', text: 'THE STATION MASTER STAYED. TWO GUN CARS AND ONE ENGINE, HE SAYS. GUN CARS FIRST, THEN THE ENGINE IS OPEN.' } },
    ],
  },
  { // 2 RIVER DELTA: MORAY, the river flagship
    lines: [
      { who: 'KOVAL', text: 'THE JUNCTION IS OURS. THE RAILWAYMEN WANT THEIR TRAIN BACK. I TOLD THEM IT IS IN SEVERAL PLACES NOW.' },
      { who: 'SPANNER', text: 'SOME OF IT IS ON BABUSYA. THE GOOD BITS.' },
      { who: 'KOVAL', text: 'THE DOMINION IS FALLING BACK INTO THE SYNIA DELTA. A GUNBOAT SITS IN THE REEDS AND SHELLS ANYTHING ON THE BANKS. THE FISHERMEN CALL IT MORAY.' },
      { alts: [{ who: 'WASP', text: 'BOATS NEVER LOOK UP. I HAVE CHECKED.' }, { who: 'OWL', text: 'BOATS DO NOT LOOK UP.' }],
        fallback: { who: 'TRACTOR', text: 'BABUSYA CANNOT SWIM. NEITHER CAN I. WE STAY ON THE BRIDGES.' } },
    ],
    choices: [
      { text: '"WE\'LL HIT IT FROM THE BRIDGES."', reward: { kind: 'charge', k: 3, n: 1 } },
      { text: '"SEND THE RECON DRONES."', reward: { kind: 'charge', k: 2, n: 2 } },
      { text: '"WHAT DO THE FISHERMEN SAY?"', reward: { kind: 'hint' },
        reply: { who: 'KOVAL', text: 'SHELLS FALL SHORT OVER OPEN WATER. FIRE FROM THE BRIDGES AND BANKS. DRONES AND AMBUSH SQUADS DO NOT CARE ABOUT WATER.' } },
    ],
  },
  { // 3 RUINED TOWN: VULTURE, the attack helicopter
    lines: [
      { who: 'KOVAL', text: 'THE DELTA IS FREE. THE FISHERMEN SENT YOU A CARP. IT IS IN MY OFFICE. PLEASE COME AND GET IT.' },
      { who: 'TRACTOR', text: 'WE ARE A TANK, MAJOR. NOT A FRIDGE.' },
      { who: 'KOVAL', text: 'NEXT IS BILOHIR, OR WHAT IS LEFT OF IT. PEOPLE STILL LIVE IN THE CELLARS. AT NIGHT A GUNSHIP HUNTS THE STREETS WITH A SEARCHLIGHT. THEY CALL IT VULTURE.' },
      { alts: [{ who: 'AUNTIE', text: 'I TAUGHT HALF OF BILOHIR. THE OTHER HALF STILL OWES ME HOMEWORK. WE ARE GOING.' },
        { who: 'STITCH', text: 'THERE IS A CLINIC UNDER THE LIBRARY. I WANT IT STILL STANDING WHEN WE LEAVE.' }],
        fallback: { who: 'SPANNER', text: 'A SEARCHLIGHT. GOOD. THEN WE ALWAYS KNOW WHERE IT IS.' } },
    ],
    choices: [
      { text: '"DRONES FLY HIGHER THAN SHELLS."', reward: { kind: 'charge', k: 0, n: 2 } },
      { text: '"WHAT CAN THE TOWN SPARE?"', reward: { kind: 'scrap', n: 25 } },
      { text: '"WHERE DOES IT LAND?"', reward: { kind: 'hint' },
        reply: { who: 'KOVAL', text: 'ON A PAD NEAR THE OLD SQUARE. SHELLS AND DRONES ONLY REACH IT WHEN IT FLIES LOW. HIGH UP IT DROPS FLARES.' } },
    ],
  },
  { // 4 WINTER FRONT: BASTION, the command post
    lines: [
      { who: 'KOVAL', text: 'BILOHIR IS FREE. THE CELLARS ARE EMPTY, IN THE GOOD WAY.' },
      { who: 'SPANNER', text: 'BABUSYA HAS MORE OF THEIR PARTS THAN OURS NOW. SHE STILL PULLS LEFT.' },
      { who: 'KOVAL', text: 'THIS IS THE LAST LINE. THEIR COMMAND POST SITS IN THE SNOW ON THE HRAN RIDGE, BEHIND BUNKERS AND A HEAVY TANK. THEY CALL IT BASTION. TAKE IT AND THE DOMINION GOES HOME.' },
      { who: 'TRACTOR', text: 'GOOD. I HAVE BEETS TO PLANT.' },
    ],
    choices: [
      { text: '"KEEP THE ENGINE WARM. WE\'RE GOING."', reward: { kind: 'charge', k: 3, n: 2 } },
      { text: '"SEND EVERYTHING YOU HAVE."', reward: { kind: 'scrap', n: 30 } },
      { text: '"AND IF THEIR COMMANDER RUNS?"', reward: { kind: 'hint' },
        reply: { who: 'KOVAL', text: 'THERE IS ONE ROAD OUT, AND THE PARTISANS ARE ON IT. IF HE RUNS, CHASE THE CAR.' } },
    ],
  },
];

/** One line from HQ on each region's intro card (story regions, then LIBERATION laps by region kind). */
const QUOTES = [
  'FREE THE VILLAGES. AND MIND THE SUNFLOWERS.',
  'GUN CARS FIRST. THEN THE ENGINE. THEN THE TIMETABLE.',
  'STAY ON THE BRIDGES AND BANKS. LET THE WATER SLOW THEM DOWN.',
  'STREET BY STREET. THE CELLARS ARE FULL OF PEOPLE: MIND WHERE YOU SHOOT.',
  'LAST LINE. KEEP THE ENGINE WARM AND THE CREW WARMER.',
];
const LIB_QUOTES = [
  'THE DOMINION LEFT GARRISONS IN THE FIELDS. THE FARMERS WANT THEM GONE BY HARVEST.',
  'THEY ARE RUNNING TRAINS AGAIN. THE RAILWAYMEN ARE NOT AMUSED.',
  'MORE BOATS IN THE REEDS. THE FISHERMEN SEND THEIR REGARDS, AND A MAP.',
  'STRAGGLERS IN THE RUINS. PEOPLE ARE REBUILDING: KEEP THE STREETS CLEAR.',
  'THEY DUG IN ON THE RIDGE AGAIN. WE KNOW THE WAY.',
];

/** The region-clear card's debrief, by the boss that fell. */
const DEBRIEF: Record<BossKind, string> = {
  grinder: 'GRINDER IS SCRAP. THE FARMERS ARE COMING UP OUT OF THE CELLARS. ONE OF THEM WANTS ITS ENGINE FOR HIS MILL.',
  train: 'ANVIL IS OFF THE RAILS. THE RAILWAYMEN WOULD LIKE THEIR TIMETABLE BACK. AND THEIR STATION. AND THEIR TEA.',
  flagship: 'MORAY IS ON THE BOTTOM. THE FISHERMEN SAY IT SCARES THE FISH. THEY ARE WILLING TO LIVE WITH THAT.',
  heli: 'NO MORE SEARCHLIGHTS OVER BILOHIR. PEOPLE ARE COMING OUT OF THE CELLARS TO LOOK AT THE STARS INSTEAD.',
  final: 'BASTION IS DOWN AGAIN. THEY KEEP BUILDING THEM. WE KEEP TAKING THEM APART.',
};

/** The ending's crew quips: the first two recruits aboard (catalogue order) each say theirs. */
const ENDING_QUIPS: Record<string, string> = {
  AUNTIE: 'CLASS DISMISSED. WALK, DO NOT RUN.',
  WASP: 'TUESDAY CAN RETIRE. TUESDAY HAS EARNED IT.',
  OWL: '...GOOD.',
  STITCH: 'NOBODY NEEDS STITCHES TONIGHT. FIRST TIME IN A YEAR.',
  STATIC: 'EVERY CHANNEL IS SINGING. I AM NOT TURNING IT DOWN.',
  BOOKS: 'THE LEDGER IS CLOSED. NOTHING IS OVERDUE.',
};

const BACKDROPS: Backdrop[] = ['farm', 'rail', 'delta', 'ruins', 'winter'];

// ---------- state ----------
export function storyState(run: RunState): StoryState {
  if (!run.story || !Array.isArray(run.story.briefed)) run.story = { briefed: [], answers: {} };
  return run.story;
}

/** Call signs aboard (TRACTOR, SPANNER and the recruits who joined). */
export function callsAboard(run: RunState): Set<string> {
  return new Set(aboard(run.crew).map((m) => crewById(m.id)?.call ?? '').filter(Boolean));
}

/** True when the run's current region still has a briefing to show (story regions only, once each). */
export function briefingDue(run: RunState): boolean {
  if (run.completed || run.region >= STORY_REGIONS || run.region < 0) return false;
  return !storyState(run).briefed.includes(run.region);
}

function resolve(script: Script, run: RunState): Line[] {
  const on = callsAboard(run);
  const out: Line[] = [];
  for (const s of script) {
    if ('who' in s) out.push(s);
    else {
      const l = s.alts.find((a) => on.has(a.who)) ?? s.fallback;
      if (l) out.push(l);
    }
  }
  return out;
}

const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? '' : 'S'}`;

/** The kicker of a briefing: what the crew just did ("REGION I FREED" + "3 TOWNS · 2 DEPOTS · BOSS DOWN"). */
function kicker(run: RunState): { tag: string; sub: string } {
  const r = run.region;
  if (r === 0) return { tag: 'DAY ONE', sub: 'ONE TANK · TWO CREW · NO UNIT' };
  const last = storyState(run).last;
  const tag = `REGION ${ROMAN[r - 1]} FREED`;
  if (!last || last.region !== r - 1) return { tag, sub: '' };
  return { tag, sub: `${plural(last.towns, 'TOWN')} · ${plural(last.depots, 'DEPOT')}${last.boss ? ' · BOSS DOWN' : ''}` };
}

/** Region name as the story says it (lap 1 only). */
const REGION_NAMES = ['FARMLAND', 'RAIL JUNCTION', 'RIVER DELTA', 'RUINED TOWN', 'WINTER FRONT'];

/** The scene for the run's current region: the opening first on a new campaign, then the briefing. */
export function briefingPages(run: RunState): Page[] {
  const r = run.region;
  const b = BRIEFINGS[r];
  if (!b) return [];
  const pages: Page[] = [];
  if (r === 0 && !storyState(run).opened) {
    OPENING.forEach((p, i) => pages.push({
      tag: COUNTRY, sub: i ? 'DISTRICT HQ · CH 1' : 'SPRING · THE DOMINION CROSSED THE BORDER', title: p.title, bg: 'farm', lines: p.lines,
    }));
  }
  const k = kicker(run);
  // the briefing is given where the crew is: the region just freed (the farmland for region 1 and 2)
  pages.push({ tag: k.tag, sub: k.sub, title: `BRIEFING · ${REGION_NAMES[r]}`, bg: BACKDROPS[Math.max(0, r - 1)], lines: resolve(b.lines, run), choices: b.choices });
  return pages;
}

/** What an answer gives with this crew: a charge nobody aboard can use becomes its scrap price instead. */
export function effectiveReward(run: RunState, c: Choice): Reward {
  const rw = c.reward;
  if (rw.kind === 'charge' && rw.k < 3 && !crewUnlocks(run.crew)[rw.k]) return { kind: 'scrap', n: rw.n * (CRAFT_COST[rw.k] ?? 20) };
  return rw;
}

const CHARGE_LABEL = ['FPV', 'AMBUSH', 'RECON', 'PATCH'];
/** The answer's reward line: text, icon (ui-garage icon name) and colour class. */
export function rewardLabel(run: RunState, c: Choice): { text: string; icon: string; cls: string } {
  const rw = effectiveReward(run, c);
  if (rw.kind === 'charge') return { text: `+${rw.n} ${CHARGE_LABEL[rw.k]} CHARGE${rw.n === 1 ? '' : 'S'}`, icon: ['fpv', 'ambush', 'recon', 'repair'][rw.k], cls: 'c-green' };
  if (rw.kind === 'scrap') return { text: `+${rw.n} SCRAP`, icon: 'scrap', cls: 'c-green' };
  return { text: 'ASK FIRST · LAIR MARKED', icon: '', cls: 'c-blue' };
}

/**
 * Answer the current region's briefing with choice i: the reward goes into the run (charges, scrap; a hint is kept
 * for the radio), the answer is recorded and the region marked briefed (and the opening seen). Returns the reply
 * line (hints), if any. Safe to call twice: a briefed region gives nothing more.
 */
export function answerBriefing(run: RunState, i: number): Line | null {
  const st = storyState(run);
  const r = run.region;
  const b = BRIEFINGS[r];
  if (!b || st.briefed.includes(r)) return null;
  st.opened = true;
  const c = b.choices[Math.max(0, Math.min(b.choices.length - 1, i))];
  const rw = effectiveReward(run, c);
  if (rw.kind === 'charge') {
    run.charges = [0, 1, 2, 3].map((k) => run.charges?.[k] ?? 0);
    run.charges[rw.k] += rw.n;
  } else if (rw.kind === 'scrap') run.scrap += rw.n;
  else if (c.reply) st.hint = { region: r, who: c.reply.who, text: c.reply.text };
  st.answers[String(r)] = b.choices.indexOf(c);
  st.briefed.push(r);
  return c.reply ?? null;
}

/** ESC held through a briefing's answers: answer 1 and its reward (a skip used to give nothing). */
export function skipBriefing(run: RunState): void {
  answerBriefing(run, 0);
  const st = storyState(run);
  st.opened = true;
  if (!st.briefed.includes(run.region)) st.briefed.push(run.region);
}

/** The hint to repeat on the radio when region r starts (ASK FIRST), or null. */
export function regionHint(run: RunState): Line | null {
  const h = run.story?.hint;
  return h && h.region === run.region ? { who: h.who, text: h.text } : null;
}

/** HQ's line on the region intro card. */
export function introQuote(region: number, completed = false): Line {
  const i = ((region % STORY_REGIONS) + STORY_REGIONS) % STORY_REGIONS;
  return { who: 'KOVAL', text: region < STORY_REGIONS && !completed ? QUOTES[i] : LIB_QUOTES[i] };
}

/** HQ's debrief on the region-clear card. */
export function debriefLine(kind: BossKind | string | null | undefined): Line {
  const k = kind === 'ace' ? 'grinder' : kind; // GRINDER's class says 'ace'
  const t = k && k in DEBRIEF ? DEBRIEF[k as BossKind] : 'THE REGION IS FREE. GOOD WORK. GET SOME SLEEP, THEN GET BACK ON THE ROAD.';
  return { who: 'KOVAL', text: t };
}

/** A region was cleared: add it to the run's totals and note it for the next briefing's kicker. */
export function noteRegionClear(run: RunState, r: { region: number; towns: number; depots: number; bosses: number; scrap: number; parts: number; kills: number }): void {
  const t = run.totals ?? (run.totals = { regions: 0, towns: 0, depots: 0, bosses: 0, scrap: 0, parts: 0, kills: 0 });
  t.regions++;
  t.towns += r.towns;
  t.depots += r.depots;
  t.bosses += r.bosses;
  t.scrap += r.scrap;
  t.parts += r.parts;
  t.kills += r.kills;
  storyState(run).last = { region: r.region, towns: r.towns, depots: r.depots, boss: r.bosses > 0 };
}

/** The ending (after the final boss): the front holds, the roads home, spring. */
export function endingPages(run: RunState): Page[] {
  const on = callsAboard(run);
  const towns = run.totals?.towns ?? 0;
  const last = storyState(run).last;
  const sub = last ? `${plural(last.towns, 'TOWN')} · ${plural(last.depots, 'DEPOT')} · BOSS DOWN` : '';
  const quips = Object.keys(ENDING_QUIPS).filter((c) => on.has(c)).slice(0, 2).map((who) => ({ who, text: ENDING_QUIPS[who] }));
  return [
    {
      tag: 'REGION V FREED', sub, title: 'THE FRONT HOLDS', bg: 'winter',
      lines: [
        { who: 'KOVAL', text: 'ALL STATIONS, THIS IS KOVAL. THE COMMAND POST HAS FALLEN. THE DOMINION IS PULLING BACK ALL ALONG THE LINE. THE FRONT HOLDS.' },
        { who: 'TRACTOR', text: 'SHE STILL PULLS LEFT.' },
        { who: 'SPANNER', text: 'SHE PULLED US ALL THE WAY HERE. LET HER.' },
      ],
    },
    {
      tag: COUNTRY, sub: 'THE ROADS ARE OPEN', title: 'THE ROADS HOME', bg: 'winter',
      lines: [
        { who: 'KOVAL', text: `${towns > 0 ? `${plural(towns, 'TOWN')} ARE` : 'EVERY TOWN YOU FREED IS'} FLYING OUR FLAG TONIGHT. PEOPLE ARE COMING HOME ON EVERY ROAD YOU OPENED.` },
        ...(quips.length ? quips : [{ who: 'SPANNER', text: 'I WILL MISS THE NOISE. NOT MUCH. A LITTLE.' }]),
      ],
    },
    {
      tag: COUNTRY, sub: 'SPRING', title: 'BEETS FIRST', bg: 'spring',
      lines: [
        { who: 'KOVAL', text: 'BABUSYA, THIS IS HQ. YOU ARE RELIEVED. GO HOME AND PLANT SOMETHING.' },
        { who: 'TRACTOR', text: 'BEETS FIRST. THEN SUNFLOWERS. THEN WE SEE.' },
        { who: 'KOVAL', text: 'THE SNOW IS MELTING ON THE RIDGE. SPRING IS COMING, AND THIS TIME IT STAYS. KOVAL OUT.' },
      ],
    },
  ];
}

/** The final boss fell: the campaign is complete (the save keeps going as LIBERATION mode). */
export function completeCampaign(run: RunState): void {
  run.completed = true;
  storyState(run).opened = true;
}

/** Rows of the CAMPAIGN COMPLETE card. */
export function completeRows(run: RunState): [string, string][] {
  const t = run.totals ?? { regions: 0, towns: 0, depots: 0, bosses: 0, scrap: 0, parts: 0, kills: 0 };
  return [
    ['REGIONS FREED', String(t.regions)],
    ['TOWNS FREED', String(t.towns)],
    ['DEPOTS DESTROYED', String(t.depots)],
    ['BOSSES DESTROYED', String(t.bosses)],
    ['SCRAP EARNED', String(t.scrap)],
    ['PARTS FOUND', String(t.parts)],
    ['TANKS DESTROYED', String(t.kills)],
    ['RETREATS', String(run.retreats)],
  ];
}

