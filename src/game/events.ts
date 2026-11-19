// Phase 5 map events (CAMPAIGN.md "Map events"): text events found on the map, each with a choice and a reward or
// a risk. 3-5 per region at spots picked from the RegionSpec (freed towns, roads, fields, ruins, river banks, the
// railway, a broken crossing), marked with a pulsing "!" in the world and on the maps. Driving within 20 px of one
// opens its card (the app pauses the world: src/ui-events.ts draws it with the briefing scene); the answer pays at
// once or starts a small objective (clear a marked minefield, escort a tractor, fetch a crate, capture a hull, beat a
// patrol) that pays when done. Risky answers bring an enemy patrol or a drone.
// Persistence: the run keeps which events were seen and resolved per region (RunState.events); a retreat rebuilds
// the region and brings back every event not resolved yet. Placement is deterministic per map.
// No DOM here, so the sims can run it (tools/events-sim.ts).
import type { Renderer } from '../gl/renderer';
import { FONT } from '../art/font';
import { ABIL } from './abilities';
import { BRICK, DOWN, DX, DY, EMPTY, ENEMY, GK_SUNFLOWER, LEFT, MAT_STD, RAIL, RIGHT, ROAD, STEEL, TREES, UP, WATER } from './constants';
import { ABILITY_SHORT, CRAFT_COST } from './crew';
import { partById } from './parts';
import type { RegionKind } from './region';
import type { RunState } from './run';
import { mulberry32 } from './stages';
import type { Mine } from './tricks';
import { Tank, type World } from './world';

const rand = Math.random;
const S = 60;
type V3 = [number, number, number];

/** Tuning (frames, px). */
export const EV = {
  /** a player this close (centre to centre) opens the card */
  triggerR: 20,
  /** after walking away (ESC) the event waits until every player is this far */
  rearmR: 44,
  minPerRegion: 3,
  maxPerRegion: 5,
  /** spacing between events, and from the player start, depots and the boss lair */
  spacing: 150,
  fromSpawn: 110,
  /** preferred distance from every player spawn (about 30 s of driving); smaller maps fall back toward fromSpawn */
  fromSpawnFar: [240, 180, 140],
  fromDepot: 48,
  fromLair: 110,
  /** escort: px per frame, how close a player must be for it to move, hits it takes */
  escortSpeed: 0.42,
  escortNear: 80,
  escortHp: 4,
  /** fetch: reach to grab it, distance band of the target from the event, the guard's trigger range */
  fetchR: 12,
  fetchMin: 100,
  fetchMax: 200,
  guardR: 110,
  /** enemy patrols spawn this far from where they are sent, and at least this far from every player */
  patrolMin: 140,
  patrolMax: 260,
  patrolFromPlayer: 180,
  /** reveals: how far round the event, and how long tanks stay on the minimap */
  revealR: 320,
  revealFrames: 40 * S,
};

// ---------- data ----------
/** Where an event can sit. */
export type Where = 'town' | 'road' | 'field' | 'ruin' | 'river' | 'rail' | 'bridge';

/** One outcome of an answer. Objectives (mines, escort, fetch, hunt) pay `then` when done. */
export type Out =
  | { k: 'scrap'; n: number }
  | { k: 'pay'; n: number }
  | { k: 'charge'; a: number; n: number }
  | { k: 'part'; id?: string; captured?: boolean }
  | { k: 'armour'; n: number }
  | { k: 'recruit' }
  | { k: 'reveal'; all?: boolean }
  | { k: 'listen'; s: number }
  | { k: 'quiet'; s: number }
  | { k: 'militia'; n: number }
  | { k: 'patrol'; n: number }
  | { k: 'drone' }
  | { k: 'spotter' }
  | { k: 'bridge' }
  | { k: 'later' }
  | { k: 'mines'; n: number; then: Out[] }
  | { k: 'escort'; rail?: boolean; then: Out[] }
  | { k: 'fetch'; look: FetchLook; hold?: number; guard?: 'patrol' | 'drone'; near?: 'rail' | 'water'; then: Out[] }
  | { k: 'hunt'; n: number; then: Out[] };
export type FetchLook = 'crate' | 'hull' | 'wagon' | 'boat' | 'generator';

/** [speaker, text]; a speaker 'A|B' is the first of them aboard (the last is a starter, always aboard). */
export type EvLine = [string, string];
export interface EvChoice {
  text: string;
  outs: Out[];
  /** what the speaker says once it is picked */
  reply?: EvLine;
}
export interface EventDef {
  id: string;
  /** 'any' = every region kind */
  kind: RegionKind | 'any';
  /** spots it can use, in order of preference */
  where: Where[];
  title: string;
  lines: EvLine[];
  choices: EvChoice[];
  /** said on the radio when its objective is done / failed */
  thanks?: EvLine;
  fail?: EvLine;
  /** what the escorted vehicle is called (HUD label) */
  vehicle?: string;
}

/** Speakers who are not crew: plate name and role (ui-events.ts gives them portraits). */
export const CIVILIANS: Record<string, { name: string; role: string }> = {
  OLHA: { name: 'BABA OLHA', role: 'VILLAGER' },
  PETRO: { name: 'PETRO', role: 'FARMER' },
  IVAN: { name: 'IVAN', role: 'RAILWAYMAN' },
  LEV: { name: 'OLD LEV', role: 'FISHERMAN' },
  VASYL: { name: 'VASYL', role: 'BELL RINGER' },
  DMYTRO: { name: 'DMYTRO', role: 'TANK CREW, CUT OFF' },
  MILA: { name: 'MILA', role: 'NEIGHBOUR' },
  BOHDAN: { name: 'BOHDAN', role: 'TRUCK DRIVER' },
};

// Placeholders: {T} = the nearest town, {D} = an escort's destination, {N} = the price (a 'pay' outcome).
export const EVENTS: EventDef[] = [
  // ---------- any region ----------
  {
    id: 'minefield', kind: 'any', where: ['town'], title: 'SOCKS ON STICKS',
    lines: [
      ['OLHA', 'THE DOMINION LEFT MINES IN OUR POTATO FIELD ON THE WAY OUT. THE POTATOES ARE FURIOUS.'],
      ['OLHA', 'WE MARKED EVERY ONE WITH A SOCK ON A STICK. DO NOT ASK WHOSE SOCKS.'],
      ['AUNTIE|SPANNER', 'MARKED MINES. SOMEBODY HERE KNOWS HOW TO DO HOMEWORK.'],
    ],
    choices: [
      { text: '"WE\'LL CLEAR THEM. STAND BACK."', outs: [{ k: 'mines', n: 5, then: [{ k: 'scrap', n: 20 }, { k: 'recruit' }] }],
        reply: ['OLHA', 'SHOOT THE MINES, NOT THE SOCKS. THE SOCKS ARE INNOCENT.'] },
      { text: '"WE\'LL PUT THEM ON OUR MAP."', outs: [{ k: 'reveal' }, { k: 'scrap', n: 5 }],
        reply: ['OLHA', 'TAKE THIS FOR YOUR TROUBLE. IT IS SCRAP. AND A JAR OF PICKLES.'] },
    ],
    thanks: ['OLHA', 'THE FIELD IS CLEAR! THE POTATOES THANK YOU. AND SOMEONE FROM {T} WANTS A WORD.'],
  },
  {
    id: 'tractor', kind: 'any', where: ['town'], title: 'SEED GRAIN', vehicle: 'TRACTOR',
    lines: [
      ['PETRO', 'MY TRACTOR HAS THE SEED GRAIN FOR {D} ON IT. THEY NEED IT BEFORE THE RAIN.'],
      ['PETRO', 'THE ROAD IS NOT SAFE. THE TRACTOR IS NOT FAST. I AM NOT YOUNG.'],
      ['TRACTOR', 'A TRACTOR. FINALLY, A VEHICLE I RESPECT.'],
    ],
    choices: [
      { text: '"WE\'LL RIDE WITH YOU."', outs: [{ k: 'escort', then: [{ k: 'scrap', n: 25 }, { k: 'part' }] }],
        reply: ['PETRO', 'STAY CLOSE. SHE ONLY MOVES WHEN SHE FEELS SAFE. LIKE ME.'] },
      { text: '"TAKE THE FIELDS. THEY WATCH THE ROAD."', outs: [{ k: 'charge', a: 3, n: 1 }],
        reply: ['PETRO', 'THE FIELDS. YES. HERE, A CAN OF DIESEL FOR YOUR TROUBLE.'] },
    ],
    thanks: ['PETRO', 'THE GRAIN IS IN {D}. NEXT YEAR THERE WILL BE BREAD. COME AND EAT SOME.'],
    fail: ['PETRO', 'SHE IS STUCK IN THE DITCH. I AM FINE. I WILL WALK BACK FOR HER LATER.'],
  },
  {
    id: 'drop', kind: 'any', where: ['field', 'road'], title: 'SPECIAL DELIVERY',
    lines: [
      ['KOVAL', 'BABUSYA, HQ. OUR SUPPLY DROP WENT WIDE. THE CRATE LANDED IN THE OPEN AND THE DOMINION HAS NOTICED.'],
      ['SPANNER', 'WHAT IS IN IT?'],
      ['KOVAL', 'GOOD THINGS. AND A LETTER FROM YOUR MOTHER.'],
    ],
    choices: [
      { text: '"WE\'LL GO AND GET IT."', outs: [{ k: 'fetch', look: 'crate', guard: 'patrol', then: [{ k: 'charge', a: 0, n: 1 }, { k: 'charge', a: 1, n: 1 }, { k: 'scrap', n: 15 }] }],
        reply: ['KOVAL', 'MOVE FAST. THEY ARE SENDING A PATROL FOR IT TOO.'] },
      { text: '"SEND A TRUCK FOR IT."', outs: [{ k: 'charge', a: 3, n: 1 }],
        reply: ['KOVAL', 'A TRUCK IT IS. HAVE A REPAIR KIT IN THE MEANTIME. THE LETTER WILL WAIT.'] },
    ],
    thanks: ['SPANNER', 'GOT IT. DRONES, A ROCKET TUBE, SOME SCRAP. MOTHER SAYS WEAR A HAT.'],
  },
  {
    id: 'salvage', kind: 'any', where: ['field', 'road'], title: 'A WARM DRONE',
    lines: [
      ['WASP|SPANNER', 'A DOMINION DRONE CAME DOWN IN THE BEETS. STILL WARM. STILL SMUG.'],
      ['TRACTOR', 'THEY WILL WANT IT BACK. THEY ALWAYS WANT THINGS BACK.'],
    ],
    choices: [
      { text: '"STRIP IT. QUICKLY."', outs: [{ k: 'part', captured: true }, { k: 'patrol', n: 2 }],
        reply: ['WASP|SPANNER', 'GOT THE MOTOR, THE CAMERA AND ITS DIGNITY. TANKS COMING!'] },
      { text: '"TAKE ITS RADIO."', outs: [{ k: 'charge', a: 0, n: 1 }, { k: 'drone' }],
        reply: ['WASP|SPANNER', 'ITS RADIO IS OURS. ITS FRIENDS ARE COMING TO ASK ABOUT IT.'] },
      { text: '"BLOW IT IN PLACE."', outs: [{ k: 'scrap', n: 8 }],
        reply: ['TRACTOR', 'BOOM. GOOD. NOW NOBODY GETS IT.'] },
    ],
  },
  {
    id: 'barn', kind: 'any', where: ['field', 'ruin', 'road'], title: 'A TANK IN THE BARN',
    lines: [
      ['PETRO', 'THERE IS A DOMINION TANK IN MY BARN. THE CREW RAN OFF. IT IS EATING MY HAY.'],
      ['SPANNER', 'TANKS DO NOT EAT HAY.'],
      ['PETRO', 'THEN WHERE IS MY HAY?'],
    ],
    choices: [
      { text: '"WE\'LL TAKE IT. PARTS AND ALL."', outs: [{ k: 'fetch', look: 'hull', hold: 150, guard: 'patrol', then: [{ k: 'part', captured: true }, { k: 'scrap', n: 15 }] }],
        reply: ['PETRO', 'GO ON. ITS CREW IS STILL OUT THERE SOMEWHERE. ANGRY. HUNGRY.'] },
      { text: '"BURN IT WHERE IT STANDS."', outs: [{ k: 'scrap', n: 10 }],
        reply: ['PETRO', 'THE BARN WAS OLD. THE INSURANCE IS NEW. TAKE THIS SCRAP.'] },
    ],
    thanks: ['SPANNER', 'IT IS OURS. I TOOK EVERYTHING THAT UNSCREWS, AND TWO THINGS THAT DID NOT.'],
  },
  {
    id: 'cache', kind: 'any', where: ['ruin', 'town'], title: 'UNDER THE STEPS',
    lines: [
      ['VASYL', 'UNDER THE CHURCH STEPS THERE IS A CACHE. THE DOMINION SAT ON IT FOR A MONTH AND NEVER LOOKED DOWN.'],
      ['SPANNER', 'HOW DO YOU KNOW IT IS THERE?'],
      ['VASYL', 'I SWEEP THE STEPS. I SWEPT AROUND IT.'],
    ],
    choices: [
      { text: '"WE\'LL TAKE ALL OF IT."', outs: [{ k: 'charge', a: 0, n: 1 }, { k: 'charge', a: 1, n: 1 }, { k: 'charge', a: 2, n: 1 }, { k: 'spotter' }],
        reply: ['VASYL', 'LOAD QUICKLY. A DRONE IS CIRCLING THE BELL TOWER.'] },
      { text: '"JUST WHAT WE NEED."', outs: [{ k: 'charge', a: 3, n: 1 }, { k: 'scrap', n: 8 }],
        reply: ['VASYL', 'SENSIBLE. THE REST STAYS UNDER THE STEPS FOR THE NEXT ONES.'] },
    ],
  },
  {
    id: 'bridge', kind: 'any', where: ['bridge'], title: 'THE OLD FOOTBRIDGE',
    lines: [
      ['LEV', 'THE FOOTBRIDGE WENT DOWN IN THE SPRING FLOOD. THE DOMINION SAYS IT WAS THEM. IT WAS THE FLOOD.'],
      ['LEV', 'GIVE ME {N} SCRAP AND MY NEPHEWS WILL MAKE IT CARRY A TANK BY LUNCH.'],
      ['SPANNER', 'A SHORTCUT. I LIKE SHORTCUTS. THEY ARE LIKE ROADS, BUT SMUG.'],
    ],
    choices: [
      { text: '"BUILD IT. ({N} SCRAP)"', outs: [{ k: 'pay', n: 40 }, { k: 'bridge' }, { k: 'charge', a: 3, n: 1 }],
        reply: ['LEV', 'LUNCH IT IS. MY NEPHEWS EAT A LOT. THE BRIDGE IS WORTH IT.'] },
      { text: '"LATER, LEV."', outs: [{ k: 'later' }],
        reply: ['LEV', 'THE RIVER IS NOT GOING ANYWHERE. NEITHER AM I.'] },
    ],
  },
  {
    id: 'wounded', kind: 'any', where: ['road', 'field'], title: 'CUT OFF',
    lines: [
      ['DMYTRO', 'OUR TANK BURNED BY THE CROSSROADS. MY CREW GOT OUT. I GOT OUT SLOWER.'],
      ['DMYTRO', 'A FAMILY IN {T} HID US IN THEIR CELLAR. ONE OF THEM WANTS TO FIGHT.'],
      ['STITCH|SPANNER', 'CLIMB ON THE BACK. MIND THE EXHAUST, IT BITES.'],
    ],
    choices: [
      { text: '"TAKE US TO THEM."', outs: [{ k: 'recruit' }],
        reply: ['DMYTRO', 'THANK YOU. I WILL RIDE ON THE BACK AND POINT.'] },
      { text: '"RIDE WITH US TO THE MEDICS."', outs: [{ k: 'charge', a: 3, n: 1 }, { k: 'scrap', n: 10 }],
        reply: ['DMYTRO', 'TAKE OUR TOOLBOX. WE WILL NOT NEED IT. WE NEED A NEW TANK.'] },
    ],
  },
  {
    id: 'tip', kind: 'any', where: ['road', 'field'], title: "A FARMER'S TIP",
    lines: [
      ['PETRO', 'I SAW THEM DIGGING BY THE ROAD LAST NIGHT. EITHER MINES OR THE WORST POTATOES IN ZORIANA.'],
      ['OWL|SPANNER', 'MY MONEY IS ON MINES.'],
    ],
    choices: [
      { text: '"SHOW US ON THE MAP."', outs: [{ k: 'reveal' }],
        reply: ['PETRO', 'HERE, HERE AND THERE. AND THEIR ROCKET MEN BEHIND THE HEDGE.'] },
      { text: '"WALK US THROUGH ALL OF IT."', outs: [{ k: 'reveal', all: true }, { k: 'spotter' }],
        reply: ['PETRO', 'ALL OF IT? FINE. BUT WE HAVE STOOD HERE TOO LONG. LOOK UP.'] },
    ],
  },
  {
    id: 'bell', kind: 'any', where: ['town'], title: 'THE BELL',
    lines: [
      ['VASYL', 'THE BELL HAS NOT RUNG SINCE THEY CAME. IF IT RINGS, EVERY FARMER WITH A RIFLE KNOWS WE ARE BACK.'],
      ['TRACTOR', 'AND THE DOMINION?'],
      ['VASYL', 'THE DOMINION WILL ALSO KNOW. THAT IS THE OTHER HALF OF THE POINT.'],
    ],
    choices: [
      { text: '"RING IT."', outs: [{ k: 'militia', n: 2 }, { k: 'drone' }],
        reply: ['VASYL', 'LISTEN TO THAT. THEY ARE COMING OUT OF EVERY CELLAR WITH A RIFLE.'] },
      { text: '"RING IT WHEN WE HAVE WON."', outs: [{ k: 'scrap', n: 10 }],
        reply: ['VASYL', 'THEN I WILL OIL IT. AND THE VILLAGE PASSES THE HAT FOR YOU.'] },
    ],
  },
  {
    id: 'intercept', kind: 'any', where: ['road', 'field', 'rail'], title: 'OPEN CHANNEL',
    lines: [
      ['STATIC|SPANNER', 'THEIR ARTILLERY SPOTTER IS ON AN OPEN CHANNEL. HE SPELLS GRID WITH THREE R\'S.'],
      ['TRACTOR', 'CAN WE TALK BACK?'],
    ],
    choices: [
      { text: '"FEED HIM WRONG NUMBERS."', outs: [{ k: 'quiet', s: 180 }],
        reply: ['STATIC|SPANNER', 'GRID 4-4. NO, 9-9. NO, THE LAKE. HE IS NOW SHELLING THE LAKE.'] },
      { text: '"JUST LISTEN."', outs: [{ k: 'listen', s: 40 }],
        reply: ['STATIC|SPANNER', 'LISTENING. EVERY TANK THAT TALKS, I CAN PUT ON YOUR MAP.'] },
    ],
  },
  // ---------- one region kind ----------
  {
    id: 'sunflowers', kind: 'farm', where: ['field', 'road'], title: 'THE SUNFLOWERS',
    lines: [
      ['PETRO', 'YOU DROVE THROUGH MY SUNFLOWERS. ALL OF THEM. I AM NOT ANGRY. I AM KEEPING A LIST.'],
      ['TRACTOR', 'WE ARE SORRY. THEY STARTED IT.'],
    ],
    choices: [
      { text: '"SORRY. {N} SCRAP FOR NEW SEED."', outs: [{ k: 'pay', n: 10 }, { k: 'part', id: 'farm-harrow' }],
        reply: ['PETRO', 'APOLOGY ACCEPTED. TAKE MY OLD HARROW. PLOUGH THEIR MINES, NOT MY FIELD.'] },
      { text: '"WE\'LL DRIVE ROUND NEXT TIME."', outs: [{ k: 'reveal' }],
        reply: ['PETRO', 'YOU WILL NOT. BUT THANK YOU. THERE ARE TANKS BEHIND THE BARN, BY THE WAY.'] },
    ],
  },
  {
    id: 'handcar', kind: 'rail', where: ['rail'], title: 'THE HANDCAR', vehicle: 'HANDCAR',
    lines: [
      ['IVAN', 'MY HANDCAR IS LOADED WITH TOOLS FOR THE STATION. THE DOMINION SHOOTS AT ANYTHING ON THE LINE.'],
      ['IVAN', 'ANYTHING THAT IS NOT A TANK. YOU ARE A TANK.'],
      ['SPANNER', 'WE ARE MOSTLY A TANK.'],
    ],
    choices: [
      { text: '"WE\'LL RIDE ALONGSIDE."', outs: [{ k: 'escort', rail: true, then: [{ k: 'part' }, { k: 'scrap', n: 15 }] }],
        reply: ['IVAN', 'I PUMP, YOU SHOOT. STAY CLOSE: I STOP WHEN I AM ALONE.'] },
      { text: '"WAIT FOR DARK, IVAN."', outs: [{ k: 'scrap', n: 8 }],
        reply: ['IVAN', 'DARK, THEN. TAKE THESE BOLTS. THEY FELL OFF A TRAIN. A DOMINION TRAIN.'] },
    ],
    thanks: ['IVAN', 'THE TOOLS ARE AT THE STATION. THE STATION MASTER CRIED. HE SAYS HE DID NOT.'],
    fail: ['IVAN', 'THE HANDCAR IS IN PIECES. I AM IN ONE PIECE. I WILL WALK, I KNOW THE WAY.'],
  },
  {
    id: 'signalbox', kind: 'rail', where: ['rail'], title: 'THE SIGNAL BOX',
    lines: [
      ['IVAN', 'I STILL HAVE THE KEY TO THE SIGNAL BOX. THEIR SUPPLY WAGON SITS IN A SIDING UP THE LINE.'],
      ['IVAN', 'IT IS GUARDED BY TWO TANKS AND A VERY BORED MAN.'],
    ],
    choices: [
      { text: '"WE\'LL CRACK THE WAGON."', outs: [{ k: 'fetch', look: 'wagon', near: 'rail', guard: 'patrol', then: [{ k: 'part', captured: true }, { k: 'scrap', n: 20 }] }],
        reply: ['IVAN', 'THE BORED MAN IS ABOUT TO BE LESS BORED. GO.'] },
      { text: '"SEND THEIR SHELLS DOWN THE WRONG LINE."', outs: [{ k: 'quiet', s: 120 }],
        reply: ['IVAN', 'DONE. THEIR SHELLS ARE GOING SOUTH. THEIR GUNS ARE NORTH. ENJOY THE QUIET.'] },
    ],
    thanks: ['SPANNER', 'THE WAGON WAS FULL OF SPARES. AND ONE CONFUSED MAN. HE SURRENDERED TO TRACTOR.'],
  },
  {
    id: 'nets', kind: 'delta', where: ['river'], title: 'WHAT THE NETS CAUGHT',
    lines: [
      ['LEV', 'THE DOMINION SANK MY BOAT. SO NOW I FISH THEIR AMMUNITION OUT OF THE RIVER INSTEAD.'],
      ['LEV', 'IT IS A BETTER CATCH THAN CARP. IT DOES NOT SMELL AS BAD.'],
    ],
    choices: [
      { text: '"WE\'LL TAKE IT, THANK YOU."', outs: [{ k: 'charge', a: 1, n: 1 }, { k: 'charge', a: 3, n: 1 }],
        reply: ['LEV', 'CAREFUL. SOME OF IT IS STILL WET.'] },
      { text: '"WHERE DO THEIR BOATS TIE UP?"', outs: [{ k: 'fetch', look: 'boat', near: 'water', guard: 'drone', then: [{ k: 'part', captured: true }, { k: 'scrap', n: 20 }] }],
        reply: ['LEV', 'DOWN THE BANK. A SUPPLY BOAT, TIED UP AND FULL OF THINGS. WATCH THE SKY.'] },
    ],
    thanks: ['LEV', 'YOU EMPTIED THEIR BOAT. I WILL HAVE THE BOAT. A FISHERMAN NEEDS A BOAT.'],
  },
  {
    id: 'cellar', kind: 'ruins', where: ['ruin', 'town'], title: 'THE CELLAR',
    lines: [
      ['MILA', 'THERE ARE FOURTEEN OF US IN THIS CELLAR, A CAT, AND ONE TIN OF PEACHES.'],
      ['MILA', 'A DOMINION PATROL PARKS AT THE END OF OUR STREET EVERY NIGHT. WE WOULD LIKE OUR STREET BACK.'],
    ],
    choices: [
      { text: '"WE\'LL CLEAR THE STREET."', outs: [{ k: 'hunt', n: 2, then: [{ k: 'scrap', n: 20 }, { k: 'recruit' }] }],
        reply: ['MILA', 'HERE THEY COME NOW. RIGHT ON TIME. THEY ARE VERY PUNCTUAL.'] },
      { text: '"STAY DOWN. {N} SCRAP, FOR THE CAT."', outs: [{ k: 'pay', n: 10 }, { k: 'reveal' }],
        reply: ['MILA', 'THE CAT THANKS YOU. HERE IS OUR MAP OF THE STREETS: WE DREW IN WHERE THEY HIDE.'] },
    ],
    thanks: ['MILA', 'THE STREET IS OURS. WE ARE OPENING THE PEACHES. SOMEONE HERE WANTS TO COME WITH YOU.'],
  },
  {
    id: 'generator', kind: 'ruins', where: ['ruin', 'town'], title: 'THE GENERATOR',
    lines: [
      ['VASYL', 'THE CLINIC GENERATOR IS DEAD. I KEEP THE LIGHTS ON WITH A BICYCLE. MY LEGS ARE ALSO DEAD.'],
      ['VASYL', 'THERE IS A GOOD GENERATOR IN THE FACTORY YARD. THE DOMINION LIVES THERE NOW.'],
    ],
    choices: [
      { text: '"WE\'LL BRING YOU THEIRS."', outs: [{ k: 'fetch', look: 'generator', guard: 'drone', then: [{ k: 'charge', a: 3, n: 2 }, { k: 'part' }] }],
        reply: ['VASYL', 'I WILL KEEP PEDALLING. PLEASE HURRY.'] },
      { text: '"TAKE OUR SPARE. ({N} SCRAP)"', outs: [{ k: 'pay', n: 30 }, { k: 'part' }],
        reply: ['VASYL', 'IT RUNS! THE CLINIC GIVES YOU THIS. IT WAS ON A DOMINION TRUCK. NOW IT IS YOURS.'] },
    ],
    thanks: ['VASYL', 'LIGHTS! THE NURSES SAY THANK YOU. TAKE THESE PATCH KITS, AND THIS, WHATEVER IT IS.'],
  },
  {
    id: 'stove', kind: 'winter', where: ['town'], title: 'SOUP',
    lines: [
      ['OLHA', 'COME IN, COME IN. THE STOVE IS HOT AND THE SOUP IS MOSTLY BEETS.'],
      ['TRACTOR', 'MOSTLY BEETS IS MY FAVOURITE KIND OF SOUP.'],
    ],
    choices: [
      { text: '"TEN MINUTES. THEN WE GO."', outs: [{ k: 'armour', n: 4 }, { k: 'spotter' }],
        reply: ['OLHA', 'EAT. WARM UP. THE SMOKE FROM MY CHIMNEY IS VERY TALL, I AM AFRAID.'] },
      { text: '"WE\'LL TAKE SOME FOR THE ROAD."', outs: [{ k: 'charge', a: 3, n: 2 }],
        reply: ['OLHA', 'A JAR EACH. AND SOCKS. DO NOT ARGUE ABOUT THE SOCKS.'] },
    ],
  },
  {
    id: 'snowdrift', kind: 'winter', where: ['road'], title: 'STUCK', vehicle: 'TRUCK',
    lines: [
      ['BOHDAN', 'OUR SUPPLY TRUCK IS STUCK IN A SNOWDRIFT. IT HAS EVERYTHING EXCEPT TRACTION.'],
      ['BOHDAN', '{D} IS WAITING FOR IT. SO IS THE DOMINION, I THINK.'],
    ],
    choices: [
      { text: '"WE\'LL TOW YOU TO {D}."', outs: [{ k: 'escort', then: [{ k: 'charge', a: 3, n: 2 }, { k: 'scrap', n: 20 }] }],
        reply: ['BOHDAN', 'HOOK US UP. I STEER, YOU PULL, NOBODY SHOOTS US.'] },
      { text: '"TAKE WHAT YOU CAN CARRY."', outs: [{ k: 'scrap', n: 10 }],
        reply: ['BOHDAN', 'SCRAP AND A THERMOS. THE THERMOS IS NOT SCRAP. I WANT IT BACK.'] },
    ],
    thanks: ['BOHDAN', 'WE ARE IN {D}. THE THERMOS IS STILL WARM. THE TEA IS FOR YOU.'],
    fail: ['BOHDAN', 'THE TRUCK IS DONE FOR. WE ARE ALL RIGHT. WE WILL WALK, IT IS ONLY SNOW.'],
  },
];
export const EVENT_BY_ID = new Map(EVENTS.map((e) => [e.id, e]));

// ---------- state ----------
/** What a village sends when an event's recruit does not come (region 1, or no recruit due / left). */
const NO_RECRUIT_SCRAP = 15; // was 30 (2026-11-18 scrap economy: event and briefing scrap halved too)

/** Saved per region in RunState.events: events whose card was seen, and events resolved (they don't come back). */
export interface EventsSeen { seen: string[]; done: string[] }

export interface Placed {
  def: EventDef;
  /** centre in px */
  x: number;
  y: number;
  /** a town event belongs to this town (shown once it is freed); -1 = none */
  town: number;
  /** idle = waiting for a player; active = its objective is running; done = resolved; failed = lost this attempt */
  state: 'idle' | 'active' | 'done' | 'failed';
  /** false after walking away from the card, until the players have left */
  armed: boolean;
  /** the nearest town's name ({T}) */
  place: string;
  /** an escort's destination name ({D}) and route (centre px points) */
  dest?: string;
  route?: [number, number][];
  /** a crossing's water cells (index into map.c) for the bridge */
  crossing?: number[];
}

interface Escort { pts: [number, number][]; cum: number[]; len: number; s: number; hp: number; x: number; y: number; dir: number; drone: boolean; patrol: boolean; anim: number }
interface Fetch { x: number; y: number; look: FetchLook; hold: number; prog: number; guard?: 'patrol' | 'drone'; guarded: boolean }
export interface Objective {
  ev: Placed;
  kind: 'mines' | 'escort' | 'fetch' | 'hunt';
  then: Out[];
  mines?: Mine[];
  escort?: Escort;
  fetch?: Fetch;
  tanks?: Tank[];
  t: number;
}

export interface Answer {
  /** the speaker's line after the answer (shown on the card) */
  reply: { who: string; text: string } | null;
  /** a recruit asks to join now (the app opens the recruit card) */
  recruit: boolean;
  /** false: nothing happened (couldn't pay, or LATER); the event stays */
  resolved: boolean;
}

/** A choice's line under its answer on the card. */
export interface ChoiceLabel { text: string; icon: string; cls: string; risk?: string }
export interface EventCard {
  title: string;
  place: string;
  kind: RegionKind;
  lines: { who: string; text: string }[];
  choices: { text: string; label: ChoiceLabel }[];
}

const CHARGE_ICONS = ['fpv', 'ambush', 'recon', 'repair'];
const FETCH_NAMES: Record<FetchLook, string> = { crate: 'SUPPLY CRATE', hull: 'CAPTURE THE TANK', wagon: 'SUPPLY WAGON', boat: 'SUPPLY BOAT', generator: 'GENERATOR' };

/** Characters the 5x7 font can draw (letters, digits, punctuation it has). */
export function fontSafe(s: string): boolean {
  for (const ch of s) if (ch !== ' ' && !FONT[ch]) return false;
  return true;
}

/** First speaker of 'A|B|C' who is aboard, else the last (a starter). */
export function pickWho(who: string, aboard: Set<string>): string {
  const alts = who.split('|');
  return alts.find((a) => aboard.has(a)) ?? alts[alts.length - 1];
}

const objKinds = new Set(['mines', 'escort', 'fetch', 'hunt']);
function isObjective(o: Out): o is Extract<Out, { then: Out[] }> {
  return objKinds.has(o.k);
}

// ---------- the module ----------
export class MapEvents {
  placed: Placed[] = [];
  /** the event a player just reached (the app opens its card) */
  pending: Placed | null = null;
  objs: Objective[] = [];
  /** a finished objective's recruit, for the app (the place they come from) */
  recruitDue: string | null = null;
  seen = new Set<string>();
  done = new Set<string>();
  stats = { triggered: 0, answered: 0, done: 0, failed: 0, patrols: 0, drones: 0, placeMs: 0 };
  /** enemies a reveal put on the minimap, until frame */
  shown: Tank[] = [];
  shownUntil = 0;
  /** no artillery until this frame (the intercept) */
  quietUntil = 0;
  private dirty = true;
  private reach: Uint8Array = new Uint8Array(0);
  private nw = 0;
  private nh = 0;
  private quietSaid = false;
  /** the spawn clearance placement settled on */
  private spawnR: number = EV.fromSpawn;
  /** road graph (node centres, adjacency) for escort routes */
  private gNodes: [number, number][] = [];
  private gAdj: [number, number][][] = [];

  constructor(public w: World, public kind: RegionKind, public region: number, saved?: EventsSeen | null) {
    for (const id of saved?.seen ?? []) this.seen.add(id);
    for (const id of saved?.done ?? []) this.done.add(id);
    if (!w.region) return;
    const t0 = typeof performance !== 'undefined' ? performance.now() : 0;
    this.buildReach();
    this.buildGraph();
    this.place();
    this.stats.placeMs = (typeof performance !== 'undefined' ? performance.now() : 0) - t0;
  }

  // ---------- placement ----------
  /** 8 px tank nodes a tank can drive to from the player start (no shooting through walls). */
  private buildReach(): void {
    const w = this.w;
    const m = w.map;
    const nw = (this.nw = Math.floor((w.pxW - 16) / 8) + 1);
    const nh = (this.nh = Math.floor((w.pxH - 16) / 8) + 1);
    const open = new Uint8Array(nw * nh);
    for (let ny = 0; ny < nh; ny++) for (let nx = 0; nx < nw; nx++) open[ny * nw + nx] = m.solidForTank(nx * 8, ny * 8, false) ? 0 : 1;
    const reach = (this.reach = new Uint8Array(nw * nh));
    const q: number[] = [];
    for (const [sx, sy] of w.region!.playerSpawns) {
      const i = Math.round(sy / 8) * nw + Math.round(sx / 8);
      if (open[i] && !reach[i]) { reach[i] = 1; q.push(i); }
    }
    for (let h = 0; h < q.length; h++) {
      const i = q[h];
      const x = i % nw;
      const y = (i / nw) | 0;
      for (let d = 0; d < 4; d++) {
        const nx = x + DX[d];
        const ny = y + DY[d];
        if (nx < 0 || ny < 0 || nx >= nw || ny >= nh) continue;
        const j = ny * nw + nx;
        if (open[j] && !reach[j]) { reach[j] = 1; q.push(j); }
      }
    }
  }

  /** True if a tank can drive to top-left (x, y) (8 px grid). */
  reachable(x: number, y: number): boolean {
    const nx = Math.round(x / 8);
    const ny = Math.round(y / 8);
    return nx >= 0 && ny >= 0 && nx < this.nw && ny < this.nh && this.reach[ny * this.nw + nx] === 1;
  }

  private buildGraph(): void {
    const g = this.w.region?.roads;
    if (!g) return;
    this.gNodes = g.nodes.map(([nx, ny]) => [nx * 8 + 8, ny * 8 + 8] as [number, number]);
    this.gAdj = this.gNodes.map(() => []);
    for (const [a, b] of g.edges) {
      const A = this.gNodes[a];
      const B = this.gNodes[b];
      if (!A || !B) continue;
      const len = Math.abs(A[0] - B[0]) + Math.abs(A[1] - B[1]);
      this.gAdj[a].push([b, len]);
      this.gAdj[b].push([a, len]);
    }
  }

  private nearestNode(x: number, y: number, max: number): number {
    let best = -1;
    let bd = max;
    this.gNodes.forEach(([nx, ny], i) => {
      const d = Math.hypot(nx - x, ny - y);
      if (d < bd) { bd = d; best = i; }
    });
    return best;
  }

  /** Road distances from node a (Dijkstra). */
  private tree(a: number): { dist: Float64Array; prev: Int32Array } {
    const n = this.gNodes.length;
    const dist = new Float64Array(n).fill(Infinity);
    const prev = new Int32Array(n).fill(-1);
    const done = new Uint8Array(n);
    dist[a] = 0;
    // binary heap of [dist, node]
    const heap: [number, number][] = [[0, a]];
    const push = (e: [number, number]) => {
      heap.push(e);
      let i = heap.length - 1;
      while (i > 0) {
        const p = (i - 1) >> 1;
        if (heap[p][0] <= heap[i][0]) break;
        [heap[p], heap[i]] = [heap[i], heap[p]];
        i = p;
      }
    };
    const pop = (): [number, number] => {
      const top = heap[0];
      const last = heap.pop()!;
      if (heap.length) {
        heap[0] = last;
        let i = 0;
        for (;;) {
          const l = i * 2 + 1;
          const r = l + 1;
          let s = i;
          if (l < heap.length && heap[l][0] < heap[s][0]) s = l;
          if (r < heap.length && heap[r][0] < heap[s][0]) s = r;
          if (s === i) break;
          [heap[s], heap[i]] = [heap[i], heap[s]];
          i = s;
        }
      }
      return top;
    };
    while (heap.length) {
      const [d, u] = pop();
      if (done[u]) continue;
      done[u] = 1;
      for (const [v, len] of this.gAdj[u]) {
        if (d + len < dist[v]) {
          dist[v] = d + len;
          prev[v] = u;
          push([dist[v], v]);
        }
      }
    }
    return { dist, prev };
  }

  private routeTo(t: { prev: Int32Array }, b: number): [number, number][] {
    const ids: number[] = [];
    for (let i = b; i >= 0; i = t.prev[i]) ids.push(i);
    ids.reverse();
    const pts: [number, number][] = [];
    for (const i of ids) {
      const p = this.gNodes[i];
      const q = pts[pts.length - 1];
      if (q && q[0] !== p[0] && q[1] !== p[1]) pts.push([p[0], q[1]]); // keep legs straight
      pts.push([p[0], p[1]]);
    }
    return pts;
  }

  /** A road route from near (x, y) to a town at least `min` px away by road (nearest such), or null. */
  private roadRoute(x: number, y: number, min: number, skipTown: number): { pts: [number, number][]; dest: string } | null {
    if (!this.gNodes.length) return null;
    const a = this.nearestNode(x, y, 56);
    if (a < 0) return null;
    const t = this.tree(a);
    let best: { d: number; node: number; name: string } | null = null;
    this.w.towns.forEach((town, i) => {
      if (i === skipTown) return;
      const b = this.nearestNode(town.cx, town.cy, 72);
      if (b < 0) return;
      const d = t.dist[b];
      if (!Number.isFinite(d) || d < min || d > 1400) return;
      if (!best || d < best.d) best = { d, node: b, name: town.name };
    });
    if (!best) return null;
    const b = best as { d: number; node: number; name: string };
    const pts = this.routeTo(t, b.node);
    return pts.length >= 2 ? { pts, dest: b.name } : null;
  }

  /** A stretch of the railway from near (x, y), at least 300 px long, or null. */
  private railRoute(x: number, y: number): [number, number][] | null {
    const rail = this.w.region?.rail;
    if (!rail || rail.length < 2) return null;
    let bi = -1;
    let bd = 48;
    rail.forEach(([px, py], i) => {
      const d = Math.hypot(px - x, py - y);
      if (d < bd) { bd = d; bi = i; }
    });
    if (bi < 0) return null;
    const walk = (step: number) => {
      const out: [number, number][] = [[rail[bi][0], rail[bi][1]]];
      let len = 0;
      for (let i = bi + step; i >= 0 && i < rail.length && len < 340; i += step) {
        const p = rail[i];
        const q = out[out.length - 1];
        len += Math.hypot(p[0] - q[0], p[1] - q[1]);
        out.push([p[0], p[1]]);
      }
      return { out, len };
    };
    const f = walk(1);
    const b = walk(-1);
    const best = f.len >= b.len ? f : b;
    return best.len >= 200 ? best.out : null;
  }

  /** Water cells of a straight crossing (4 cells wide, 3-16 long, dry land at both ends) near (x, y), or null. */
  private findCrossing(x: number, y: number): { cells: number[]; bank: [number, number] } | null {
    const m = this.w.map;
    const land = (c: number) => c !== WATER && c !== BRICK && c !== STEEL;
    const cx0 = Math.floor(x / 4);
    const cy0 = Math.floor(y / 4);
    const bridges = this.w.region?.bridges ?? [];
    let best: { cells: number[]; bank: [number, number]; d: number } | null = null;
    for (let cy = cy0 - 8; cy <= cy0 + 8; cy++) {
      for (let cx = cx0 - 8; cx <= cx0 + 8; cx++) {
        for (let d = 0; d < 4; d++) {
          const px = DY[d] !== 0 ? 1 : 0; // across the strip
          const py = 1 - px;
          // the strip's 4 bank cells must be land, the next cells along d water
          let ok = true;
          for (let o = 0; o < 4 && ok; o++) if (!land(m.at(cx + px * o, cy + py * o)) || m.at(cx + px * o + DX[d], cy + py * o + DY[d]) !== WATER) ok = false;
          if (!ok) continue;
          let L = 1;
          for (; L <= 17; L++) {
            let water = 0;
            for (let o = 0; o < 4; o++) if (m.at(cx + px * o + DX[d] * L, cy + py * o + DY[d] * L) === WATER) water++;
            if (water === 0) break;
            if (water < 4) { L = 99; break; }
          }
          const n = L - 1;
          if (n < 3 || n > 16) continue;
          // dry land a tank can stand on at the far end, and behind the near end
          for (let k = 0; k < 4 && ok; k++) {
            for (let o = 0; o < 4 && ok; o++) {
              if (!land(m.at(cx + px * o + DX[d] * (L + k), cy + py * o + DY[d] * (L + k)))) ok = false;
              if (!land(m.at(cx + px * o - DX[d] * k, cy + py * o - DY[d] * k))) ok = false;
            }
          }
          if (!ok) continue;
          const mx = (cx + px * 2 + DX[d] * (L / 2)) * 4;
          const my = (cy + py * 2 + DY[d] * (L / 2)) * 4;
          if (bridges.some(([bx, by]) => Math.hypot(bx + 8 - mx, by + 8 - my) < 72)) continue;
          // the bank spot: a tank-sized clear patch centred on the strip, about 14 px back from the water
          const ncx = (cx + px * 2) * 4 + (DX[d] < 0 ? 4 : 0) - DX[d] * 14;
          const ncy = (cy + py * 2) * 4 + (DY[d] < 0 ? 4 : 0) - DY[d] * 14;
          const sx = Math.round((ncx - 8) / 8) * 8;
          const sy = Math.round((ncy - 8) / 8) * 8;
          if (!this.reachable(sx, sy) || m.solidForTank(sx, sy, false)) continue;
          if (this.w.region!.playerSpawns.some(([qx, qy]) => Math.hypot(qx - sx, qy - sy) < this.spawnR)) continue;
          const cells: number[] = [];
          for (let k = 1; k < L; k++) for (let o = 0; o < 4; o++) cells.push((cy + py * o + DY[d] * k) * m.w + cx + px * o + DX[d] * k);
          const dist = Math.hypot(sx + 8 - x, sy + 8 - y) + n;
          if (!best || dist < best.d) best = { cells, bank: [sx + 8, sy + 8], d: dist };
        }
      }
    }
    return best ? { cells: best.cells, bank: best.bank } : null;
  }

  private count(x: number, y: number, w: number, h: number, f: (c: number) => boolean): number {
    const m = this.w.map;
    let n = 0;
    for (let cy = Math.floor(y / 4); cy < Math.ceil((y + h) / 4); cy++) for (let cx = Math.floor(x / 4); cx < Math.ceil((x + w) / 4); cx++) if (f(m.at(cx, cy))) n++;
    return n;
  }

  private nearestTown(x: number, y: number): number {
    let bi = -1;
    let bd = Infinity;
    this.w.towns.forEach((t, i) => {
      const d = Math.hypot(t.cx - x, t.cy - y);
      if (d < bd) { bd = d; bi = i; }
    });
    return bi;
  }

  private inTown(x: number, y: number, m: number): boolean {
    return this.w.towns.some((t) => x >= t.rect[0] - m && y >= t.rect[1] - m && x < t.rect[0] + t.rect[2] + m && y < t.rect[1] + t.rect[3] + m);
  }

  /** Candidate centres (px) for a kind of spot; town spots carry their town. */
  private candidates(where: Where): { x: number; y: number; town: number }[] {
    const w = this.w;
    const out: { x: number; y: number; town: number }[] = [];
    const spec = w.region!;
    for (let ny = 1; ny < this.nh - 1; ny += 2) {
      for (let nx = 1; nx < this.nw - 1; nx += 2) {
        if (!this.reach[ny * this.nw + nx]) continue;
        const x = nx * 8;
        const y = ny * 8;
        const cx = x + 8;
        const cy = y + 8;
        if (spec.playerSpawns.some(([sx, sy]) => Math.hypot(sx + 8 - cx, sy + 8 - cy) < this.spawnR)) continue;
        if (w.depots.some((d) => Math.hypot(d.cx - cx, d.cy - cy) < EV.fromDepot || (cx >= d.rect[0] - 8 && cy >= d.rect[1] - 8 && cx < d.rect[0] + d.rect[2] + 8 && cy < d.rect[1] + d.rect[3] + 8))) continue;
        if (spec.lair && Math.hypot(spec.lair[0] - cx, spec.lair[1] - cy) < EV.fromLair) continue;
        const flagD = Math.min(...w.towns.map((t) => Math.hypot(t.cx - cx, t.cy - cy)), Infinity);
        if (where === 'town') {
          const ti = this.nearestTown(cx, cy);
          if (ti < 0 || flagD < 40 || flagD > 72) continue;
          if (this.count(x, y, 16, 16, (c) => c !== EMPTY && c !== ROAD) > 2) continue;
          out.push({ x: cx, y: cy, town: ti });
          continue;
        }
        if (flagD < 56) continue;
        if (where === 'road') {
          if (this.inTown(cx, cy, 24)) continue;
          if (this.count(x, y, 16, 16, (c) => c === ROAD) < 6) continue;
        } else if (where === 'field') {
          if (this.inTown(cx, cy, 16)) continue;
          if (this.count(x - 8, y - 8, 32, 32, (c) => c !== EMPTY) > 0) continue;
          if (this.count(x - 48, y - 48, 112, 112, (c) => c === ROAD) === 0) continue;
        } else if (where === 'ruin') {
          if (this.count(x, y, 16, 16, (c) => c !== EMPTY && c !== ROAD) > 2) continue;
          if (this.count(x - 16, y - 16, 48, 48, (c) => c === BRICK) < 12) continue;
        } else if (where === 'river' || where === 'bridge') {
          if (this.inTown(cx, cy, 8)) continue;
          if (this.count(x, y, 16, 16, (c) => c !== EMPTY && c !== ROAD && c !== TREES) > 0) continue;
          if (this.count(x - 12, y - 12, 40, 40, (c) => c === WATER) < 4) continue;
        } else if (where === 'rail') {
          if (this.inTown(cx, cy, 8)) continue;
          if (this.count(x - 12, y - 12, 40, 40, (c) => c === RAIL) < 4) continue;
          if (this.count(x, y, 16, 16, (c) => c !== EMPTY && c !== ROAD && c !== RAIL) > 1) continue;
        }
        out.push({ x: cx, y: cy, town: -1 });
      }
    }
    return out;
  }

  /** Deterministic per map: the same region (a retreat replays it) gets the same events in the same spots. */
  private seed(): number {
    const spec = this.w.region!;
    let h = (spec.w * 73856093) ^ (spec.h * 19349663) ^ ((this.region + 1) * 83492791);
    for (const t of this.w.towns) h = (Math.imul(h, 31) + t.cx * 7 + t.cy) | 0;
    for (let i = 0; i < spec.cells.length; i += 97) h = (Math.imul(h, 33) ^ spec.cells[i]) | 0;
    return h >>> 0;
  }

  /** Try to put one event down; returns it, or null when no spot fits. */
  private placeOne(def: EventDef, rng: () => number, cache: Map<Where, { x: number; y: number; town: number }[]>, spacing = EV.spacing): Placed | null {
    for (const where of def.where) {
      if (where === 'rail' && !this.w.region?.rail) continue;
      let list = cache.get(where === 'bridge' ? 'river' : where);
      if (!list) {
        list = this.candidates(where === 'bridge' ? 'river' : where);
        cache.set(where === 'bridge' ? 'river' : where, list);
      }
      let free = list.filter((c) => !this.placed.some((p) => Math.hypot(p.x - c.x, p.y - c.y) < spacing));
      // Petro's sunflowers: in a sunflower field when the map has one (RegionSpec.kinds)
      const reg = this.w.region;
      if (def.id === 'sunflowers' && reg?.kinds) {
        const sun = free.filter((c) => (reg.kinds![(c.y >> 2) * reg.w + (c.x >> 2)] & 15) === GK_SUNFLOWER);
        if (sun.length) free = sun;
      }
      // a few random tries, each must pass the event's own needs (an escort route, a crossing)
      for (let tries = 0; tries < Math.min(24, free.length); tries++) {
        const c = free[Math.floor(rng() * free.length)];
        const p: Placed = { def, x: c.x, y: c.y, town: c.town, state: 'idle', armed: true, place: '' };
        if (!this.fits(p, where)) continue;
        if (this.placed.some((q) => Math.hypot(q.x - p.x, q.y - p.y) < spacing)) continue;
        const ti = this.nearestTown(p.x, p.y);
        p.place = ti >= 0 ? this.w.towns[ti].name : 'THE ROADSIDE';
        return p;
      }
    }
    return null;
  }

  /** The event's own needs at a spot: escorts need a route, the bridge a crossing. */
  private fits(p: Placed, where: Where): boolean {
    const esc = p.def.choices.flatMap((c) => c.outs).find((o) => o.k === 'escort') as Extract<Out, { k: 'escort' }> | undefined;
    if (esc) {
      if (esc.rail) {
        const r = this.railRoute(p.x, p.y);
        if (!r) return false;
        p.route = r;
        p.dest = 'THE STATION';
      } else {
        const r = this.roadRoute(p.x, p.y, 220, p.town);
        if (!r) return false;
        p.route = r.pts;
        p.dest = r.dest;
      }
    }
    if (where === 'bridge') {
      const c = this.findCrossing(p.x, p.y);
      if (!c) return false;
      p.crossing = c.cells;
      [p.x, p.y] = c.bank;
    }
    return true;
  }

  private place(): void {
    const rng = mulberry32(this.seed());
    const n = EV.minPerRegion + Math.floor(rng() * (EV.maxPerRegion - EV.minPerRegion + 1));
    const shuffle = <T>(a: T[]): T[] => {
      for (let i = a.length - 1; i > 0; i--) {
        const j = Math.floor(rng() * (i + 1));
        [a[i], a[j]] = [a[j], a[i]];
      }
      return a;
    };
    // region 1 has no recruits (crew.ts recruitOffer): events whose answer is only a recruit stay out of it
    const usable = (e: EventDef) => this.region >= 1 || !e.choices.some((c) => c.outs.some((o) => o.k === 'recruit'));
    const regional = shuffle(EVENTS.filter((e) => e.kind === this.kind && usable(e)));
    const generic = shuffle(EVENTS.filter((e) => e.kind === 'any' && usable(e)));
    const order = [...regional.slice(0, 2), ...generic, ...regional.slice(2)];
    let all: Placed[] = [];
    // no event within ~240 px of a player spawn; small maps relax the clearance step by step until 3 fit
    for (const R of [...EV.fromSpawnFar, EV.fromSpawn]) {
      this.spawnR = R;
      this.placed = [];
      all = [];
      const cache = new Map<Where, { x: number; y: number; town: number }[]>();
      for (const def of order) {
        if (all.length >= n) break;
        const p = this.placeOne(def, rng, cache);
        if (p) {
          all.push(p);
          this.placed.push(p);
        }
      }
      if (all.length >= EV.minPerRegion) break;
    }
    // resolved events stay resolved (placement above is the same either way, so spots never move)
    for (const p of all) if (this.done.has(p.def.id)) p.state = 'done';
  }

  /** Tests and screenshot scenes: put event `id` down now (spacing relaxed), or null. */
  debugPlace(id: string): Placed | null {
    const def = EVENT_BY_ID.get(id);
    if (!def || !this.w.region) return null;
    const old = this.placed.find((p) => p.def.id === id);
    if (old) return old;
    const p = this.placeOne(def, mulberry32(this.seed() ^ 0x5bd1e995), new Map(), 40);
    if (p) this.placed.push(p);
    return p;
  }

  // ---------- per update ----------
  /** Events a player can trigger now (town events once their town is free). */
  available(p: Placed): boolean {
    return p.state === 'idle' && (p.town < 0 || !!this.w.towns[p.town]?.freed);
  }

  update(): void {
    const w = this.w;
    if (!w.region || w.over) return;
    const pl = w.livePlayers();
    for (const p of this.placed) {
      if (!this.available(p)) continue;
      const d = Math.min(...pl.map((t) => Math.hypot(t.cx - p.x, t.cy - p.y)), Infinity);
      if (!p.armed) {
        if (d > EV.rearmR) p.armed = true;
        continue;
      }
      if (!this.pending && d <= EV.triggerR) {
        this.pending = p;
        this.stats.triggered++;
        if (!this.seen.has(p.def.id)) {
          this.seen.add(p.def.id);
          this.dirty = true;
        }
      }
    }
    for (const o of [...this.objs]) this.updateObjective(o);
    if (this.shownUntil && w.frame >= this.shownUntil) { this.shownUntil = 0; this.shown = []; }
    // the intercept: any barrage while it holds is called off
    const tr = w.tricks;
    if (tr && w.frame < this.quietUntil && tr.barrage) {
      tr.barrage = null;
      if (!this.quietSaid) {
        this.quietSaid = true;
        this.radio('INTERCEPT', 'FIRE MISSION CANCELLED. SAY AGAIN YOUR GRID? SAY AGAIN? ...WHAT LAKE?');
      }
    }
  }

  // ---------- answering ----------
  /** The card for the pending event: lines with speakers resolved for the crew aboard and labels for the answers. */
  card(aboard: Set<string>, p = this.pending): EventCard | null {
    if (!p) return null;
    return {
      title: p.def.title,
      place: p.town >= 0 ? `${p.place}` : `NEAR ${p.place}`,
      kind: this.kind,
      lines: p.def.lines.map(([who, text]) => ({ who: pickWho(who, aboard), text: this.fill(text, p) })),
      choices: p.def.choices.map((c) => ({ text: this.fill(c.text, p, c), label: this.label(c) })),
    };
  }

  /** {T} town, {D} destination, {N} price. */
  fill(text: string, p: Placed, choice?: EvChoice): string {
    const pay = (choice ?? p.def.choices.find((c) => c.outs.some((o) => o.k === 'pay')))?.outs.find((o) => o.k === 'pay') as { n: number } | undefined;
    return text.replace(/\{T\}/g, p.place).replace(/\{D\}/g, p.dest ?? p.place).replace(/\{N\}/g, String(pay?.n ?? 0));
  }

  /** The reward / risk line under an answer. */
  label(c: EvChoice): ChoiceLabel {
    const risks: string[] = [];
    const sum = (outs: Out[]): { parts: string[]; icon: string } => {
      let scrap = 0;
      let icon = '';
      const parts: string[] = [];
      for (const o of outs) {
        switch (o.k) {
          case 'scrap': scrap += o.n; icon ||= 'scrap'; break;
          case 'charge':
            if (o.a < 3 && !this.w.unlocked[o.a]) { scrap += o.n * (CRAFT_COST[o.a] ?? 20); icon ||= 'scrap'; } else { parts.push(`+${o.n} ${ABILITY_SHORT[o.a]}`); icon ||= CHARGE_ICONS[o.a]; }
            break;
          case 'part': parts.push(o.id ? `+${partById(o.id)?.name ?? 'PART'}` : '+1 PART'); icon ||= 'parts'; break;
          case 'armour': parts.push(`+${o.n} ARMOUR`); icon ||= 'repair'; break;
          case 'recruit':
            // no recruits from map events in region 1 (crew.ts recruitOffer): the village sends scrap instead
            if (this.region < 1) { scrap += NO_RECRUIT_SCRAP; icon ||= 'scrap'; } else { parts.push('A RECRUIT'); icon ||= 'chev'; }
            break;
          case 'reveal': parts.push(o.all ? 'EVERY MINE SHOWN' : 'MINES SHOWN'); icon ||= 'recon'; break;
          case 'listen': parts.push(`ENEMIES ON MAP ${o.s} S`); icon ||= 'recon'; break;
          case 'quiet': parts.push(`NO SHELLING ${Math.round(o.s / 60)} MIN`); icon ||= 'signal'; break;
          case 'militia': parts.push(`MILITIA X${o.n}`); icon ||= 'ambush'; break;
          case 'bridge': parts.push('NEW BRIDGE'); icon ||= 'town'; break;
          case 'pay': parts.unshift(`-${o.n} SCRAP`); icon ||= 'scrap'; break;
          case 'later': parts.push('NOTHING YET'); break;
          case 'patrol': risks.push(o.n > 1 ? `${o.n} TANKS` : 'A TANK'); break;
          case 'drone': risks.push('DRONE'); break;
          case 'spotter': risks.push('SPOTTER DRONE'); break;
          default: break;
        }
      }
      if (scrap) parts.push(`+${scrap} SCRAP`);
      return { parts, icon };
    };
    const obj = c.outs.find(isObjective);
    if (obj) {
      const r = sum(obj.then);
      const head = obj.k === 'mines' ? `CLEAR ${obj.n} MINES` : obj.k === 'escort' ? 'ESCORT' : obj.k === 'hunt' ? `BEAT ${obj.n} TANKS`
        : obj.look === 'hull' ? 'CAPTURE' : 'FETCH';
      if (obj.k === 'escort') risks.push('DRONE, TANKS');
      if (obj.k === 'fetch' && obj.guard) risks.push(obj.guard === 'patrol' ? '2 TANKS' : 'DRONE');
      const rest = sum(c.outs.filter((o) => o !== obj));
      return { text: `${head}: ${[...r.parts, ...rest.parts].join(', ')}`, icon: r.icon, cls: 'c-gold', risk: risks.length ? `RISK: ${risks.join(', ')}` : undefined };
    }
    const r = sum(c.outs);
    return { text: r.parts.join(', ') || 'NOTHING', icon: r.icon, cls: risks.length ? 'c-gold' : 'c-green', risk: risks.length ? `RISK: ${risks.join(', ')}` : undefined };
  }

  /** The answer demos (autoplay) give: the first one they can pay for that does something. */
  autoChoice(p = this.pending): number {
    if (!p) return 0;
    const i = p.def.choices.findIndex((c) => !c.outs.some((o) => o.k === 'later') && this.payable(c));
    return i >= 0 ? i : 0;
  }

  private payable(c: EvChoice): boolean {
    const n = c.outs.reduce((a, o) => a + (o.k === 'pay' ? o.n : 0), 0);
    return this.w.scrap >= n;
  }

  /** Walked away from the card (ESC): the event stays and asks again once the players have left and come back. */
  walkAway(): void {
    if (this.pending) this.pending.armed = false;
    this.pending = null;
  }

  /** Answer the pending event with choice i: pay, give, risk, or start the objective. */
  answer(i: number): Answer {
    const p = this.pending;
    const res: Answer = { reply: null, recruit: false, resolved: false };
    if (!p) return res;
    this.pending = null;
    const c = p.def.choices[Math.max(0, Math.min(p.def.choices.length - 1, i))];
    this.stats.answered++;
    const say = (l?: EvLine) => (l ? { who: pickWho(l[0], this.aboard()), text: this.fill(l[1], p, c) } : null);
    const cost = c.outs.reduce((a, o) => a + (o.k === 'pay' ? o.n : 0), 0);
    if (cost > this.w.scrap) {
      p.armed = false;
      res.reply = { who: 'SPANNER', text: `WE HAVE ${this.w.scrap} SCRAP AND IT COSTS ${cost}. IT WILL HAVE TO WAIT.` };
      return res;
    }
    if (c.outs.some((o) => o.k === 'later')) {
      p.armed = false;
      res.reply = say(c.reply);
      return res;
    }
    res.reply = say(c.reply);
    const obj = c.outs.find(isObjective);
    const now = c.outs.filter((o) => o !== obj);
    res.recruit = this.give(now, p);
    if (obj && this.start(p, obj)) {
      p.state = 'active';
    } else {
      // no objective (or it could not start: its reward is paid at once instead)
      if (obj) res.recruit = this.give(obj.then, p) || res.recruit;
      this.resolve(p);
    }
    res.resolved = true;
    return res;
  }

  private resolve(p: Placed): void {
    p.state = 'done';
    this.done.add(p.def.id);
    this.dirty = true;
  }

  /** Call signs aboard, from the world's perks (the World doesn't hold the run; crew.ts applyCrew sets perks). */
  private aboard(): Set<string> {
    const w = this.w;
    const s = new Set(['TRACTOR', 'SPANNER']);
    const by: Record<string, string> = { 'steady-hand': 'AUNTIE', 'hot-glue': 'WASP', 'night-eyes': 'OWL', 'quick-hands': 'STITCH', 'pen-pals': 'STATIC', 'by-the-book': 'BOOKS' };
    for (const [k, v] of Object.entries(by)) if (w.perks.has(k)) s.add(v);
    return s;
  }

  /** The app found nobody left to recruit: the village sends scrap instead. */
  noRecruit(): void {
    this.give([{ k: 'scrap', n: NO_RECRUIT_SCRAP }], null);
    this.w.note(`NO ONE NEW TO JOIN · +${NO_RECRUIT_SCRAP} SCRAP`, 'info');
  }

  /** Pay out outcomes now; returns true if one of them is a recruit (the app opens the card). */
  give(outs: Out[], p: Placed | null): boolean {
    const w = this.w;
    const pl = w.livePlayers();
    const at = pl[0] ?? (p ? { cx: p.x, cy: p.y } : { cx: w.pxW / 2, cy: w.pxH / 2 });
    let recruit = false;
    let dy = 0;
    const pop = (text: string, col: V3) => {
      w.popups.push({ x: at.cx, y: at.cy - 12 - dy, text, t: 0, col });
      dy += 8;
    };
    for (const o of outs) {
      switch (o.k) {
        case 'scrap':
          w.scrap += o.n;
          w.stats.scrapPicked += o.n;
          pop(`+${o.n} SCRAP`, [1, 0.85, 0.4]);
          w.snd('scrap', at.cx, 0.8);
          break;
        case 'pay':
          w.scrap = Math.max(0, w.scrap - o.n);
          w.stats.scrapSpent += o.n;
          pop(`-${o.n} SCRAP`, [1, 0.6, 0.4]);
          break;
        case 'charge':
          if (o.a < 3 && !w.unlocked[o.a]) {
            const n = o.n * (CRAFT_COST[o.a] ?? 20);
            w.scrap += n;
            w.stats.scrapPicked += n;
            pop(`+${n} SCRAP`, [1, 0.85, 0.4]);
          } else {
            w.charges[o.a] = (w.charges[o.a] ?? 0) + o.n;
            w.note(`${ABILITY_SHORT[o.a]} CHARGE +${o.n}`, 'power');
          }
          break;
        case 'part': {
          let id: string | null = o.id ?? null;
          if (id) w.found.push(id);
          else id = w.rollFound(!!o.captured);
          w.partsFound++;
          w.stats.partsPicked++;
          pop(`+${(id && partById(id)?.name) || 'PART'}`, [0.6, 0.9, 1]);
          w.snd('part', at.cx, 0.8);
          break;
        }
        case 'armour':
          for (const t of pl) {
            const g = Math.min(o.n, t.armourMax - t.armour);
            if (g > 0) {
              t.armour += g;
              w.popups.push({ x: t.cx, y: t.cy - 10, text: `+${g}`, t: 0, col: [0.5, 1, 0.5] });
            }
          }
          w.snd('patch', at.cx, 0.8);
          break;
        case 'recruit':
          if (this.region < 1) this.noRecruit(); // region 1 has no event recruits
          else recruit = true;
          break;
        case 'reveal': this.reveal(p, !!o.all); break;
        case 'listen':
          if (w.abil) w.abil.reconUntil = Math.max(w.abil.reconUntil, w.frame + o.s * S);
          w.note('LISTENING IN: ENEMIES ON THE MAP', 'info');
          break;
        case 'quiet': {
          this.quietUntil = Math.max(this.quietUntil, w.frame + o.s * S);
          this.quietSaid = false;
          const tr = w.tricks as unknown as { barrage: unknown; nextBarrage?: number } | null;
          if (tr) {
            tr.barrage = null;
            // tricks.ts keeps its schedule private; push the next barrage past the quiet (Phase 5 events hook)
            if (typeof tr.nextBarrage === 'number') tr.nextBarrage = Math.max(tr.nextBarrage, this.quietUntil);
          }
          w.note(`NO SHELLING FOR ${Math.round(o.s / 60)} MIN`, 'power');
          break;
        }
        case 'militia': this.militia(o.n, p); break;
        case 'patrol': this.patrol(o.n, p ? p.x : at.cx, p ? p.y : at.cy); break;
        case 'drone': this.drone('attack'); break;
        case 'spotter': this.drone('spot'); break;
        case 'bridge': if (p) this.buildBridge(p); break;
        default: break;
      }
    }
    return recruit;
  }

  private radio(who: string, text: string, amb = false): void {
    const r = this.w.radio;
    r.push(amb ? { who, text, amb } : { who, text });
    if (r.length > 20) r.shift();
  }

  private say(l: EvLine | undefined, p: Placed): void {
    if (l) this.radio(pickWho(l[0], this.aboard()), this.fill(l[1], p));
  }

  /** Shows the minefields, AT teams and tanks round the event (or every mine and team on the map). */
  private reveal(p: Placed | null, all: boolean): void {
    const w = this.w;
    const x = p?.x ?? w.pxW / 2;
    const y = p?.y ?? w.pxH / 2;
    const tr = w.tricks;
    let mines = 0;
    let teams = 0;
    if (tr) {
      const fields = new Set<number>();
      for (const m of tr.mines) if (m.alive && (all || Math.hypot(m.x - x, m.y - y) <= EV.revealR)) fields.add(m.field);
      for (const m of tr.mines) if (m.alive && fields.has(m.field) && !m.shown) { m.shown = true; mines++; }
      for (const t of tr.teams) if (t.alive && !t.shown && (all || Math.hypot(t.x - x, t.y - y) <= EV.revealR)) { t.shown = true; teams++; }
    }
    this.shown = w.enemies.filter((e) => e.alive && Math.hypot(e.cx - x, e.cy - y) <= EV.revealR * 1.2);
    this.shownUntil = w.frame + EV.revealFrames;
    const bits = [mines ? `${mines} MINE${mines > 1 ? 'S' : ''}` : '', teams ? `${teams} ROCKET TEAM${teams > 1 ? 'S' : ''}` : '', this.shown.length ? `${this.shown.length} TANK${this.shown.length > 1 ? 'S' : ''}` : ''].filter(Boolean);
    w.note(bits.length ? `MARKED: ${bits.join(', ')}` : 'NOTHING NEARBY. FOR NOW.', 'info');
  }

  /** Friendly squads (the ambush ability's) dig in round the event. */
  private militia(n: number, p: Placed | null): void {
    const w = this.w;
    const ab = w.abil;
    if (!ab) return;
    const x0 = p?.x ?? w.livePlayers()[0]?.cx ?? 0;
    const y0 = p?.y ?? w.livePlayers()[0]?.cy ?? 0;
    const m = w.map;
    const spots: [number, number, number][] = [];
    for (let r = 16; r <= 72; r += 4) {
      for (let a = 0; a < 24; a++) {
        const x = Math.round((x0 + Math.cos((a / 24) * Math.PI * 2) * r) / 4) * 4;
        const y = Math.round((y0 + Math.sin((a / 24) * Math.PI * 2) * r) / 4) * 4;
        let bad = false;
        for (let j = -1; j <= 0 && !bad; j++) for (let i = -1; i <= 0; i++) { const c = m.at(x / 4 + i, y / 4 + j); if (c === BRICK || c === STEEL || c === WATER) bad = true; }
        if (bad) continue;
        let cover = 0;
        for (let j = -2; j <= 1; j++) for (let i = -2; i <= 1; i++) { const c = m.at(x / 4 + i, y / 4 + j); if (c === BRICK || c === TREES) cover++; }
        spots.push([x, y, cover * 4 - r * 0.2]);
      }
    }
    spots.sort((a, b) => b[2] - a[2]);
    let placed = 0;
    for (const [x, y] of spots) {
      if (placed >= n) break;
      if (ab.squads.some((q) => Math.abs(q.x - x) < 24 && Math.abs(q.y - y) < 24)) continue;
      ab.squads.push({ pi: 0, x, y, dir: DOWN, rockets: ABIL.rockets, reload: ABIL.firstReload, t: 0, leaving: 0, sprung: false, spot: 0, fired: 999 });
      placed++;
    }
    if (placed) w.note(`MILITIA X${placed} DUG IN`, 'power');
  }

  /** Enemy tanks (hunters) from out of sight, sent at (ax, ay). Returns them. */
  patrol(n: number, ax: number, ay: number): Tank[] {
    const w = this.w;
    const pl = w.livePlayers();
    const ok = (x: number, y: number, lo: number, hi: number) => {
      const d = Math.hypot(x + 8 - ax, y + 8 - ay);
      if (d < lo || d > hi || !this.reachable(x, y)) return false;
      if (pl.some((p) => Math.hypot(p.cx - x - 8, p.cy - y - 8) < EV.patrolFromPlayer)) return false;
      return !w.map.solidForTank(x, y, false) && !w.tankIn(x, y, 16, 16);
    };
    let cands: [number, number][] = [];
    for (const [lo, hi] of [[EV.patrolMin, EV.patrolMax], [100, 360], [60, 600]]) {
      for (let ny = 0; ny < this.nh; ny += 2) for (let nx = 0; nx < this.nw; nx += 2) if (ok(nx * 8, ny * 8, lo, hi)) cands.push([nx * 8, ny * 8]);
      if (cands.length) break;
    }
    if (!cands.length) return [];
    // roads first: patrols drive in on them
    const road = cands.filter(([x, y]) => this.count(x, y, 16, 16, (c) => c === ROAD) >= 6);
    if (road.length) cands = road;
    const [bx, by] = cands[Math.floor(rand() * cands.length)];
    const tier = Math.max(0, Math.min(4, w.stage - 1));
    const types = tier >= 2 ? [0, 2, 3] : tier >= 1 ? [0, 1, 2] : [0, 0, 1];
    const out: Tank[] = [];
    for (let k = 0; k < n; k++) {
      const s = k === 0 && !w.tankIn(bx, by, 16, 16) ? [bx, by] as [number, number] : w.freeSpotNear(bx, by);
      if (!s) break;
      const e = new Tank();
      e.x = s[0];
      e.y = s[1];
      e.dir = Math.abs(ax - bx) > Math.abs(ay - by) ? (ax > bx ? RIGHT : LEFT) : (ay > by ? DOWN : UP);
      e.etype = types[Math.floor(rand() * types.length)];
      e.hp = ENEMY[e.etype].hp;
      e.spawn = 60;
      e.persona = 2;
      w.enemies.push(e);
      out.push(e);
    }
    if (out.length) {
      this.stats.patrols++;
      this.radio('INTERCEPT', `PATROL, MOVE TO GRID ${Math.floor(ax / 64)}-${Math.floor(ay / 64)}. ${out.length} TANKS. CHECK THE NOISE.`, true);
      w.note(`${out.length} ENEMY TANK${out.length > 1 ? 'S' : ''} COMING`, 'warn');
    }
    return out;
  }

  private drone(kind: 'attack' | 'spot'): void {
    const tr = this.w.tricks;
    if (!tr?.on) return;
    if (tr.launchDrone(-1, kind)) {
      this.stats.drones++;
      this.w.note(kind === 'spot' ? 'SPOTTER DRONE UP' : 'DRONE INCOMING', 'warn');
    }
  }

  private buildBridge(p: Placed): void {
    const w = this.w;
    const m = w.map;
    if (!p.crossing?.length) return;
    let xs = 0;
    let ys = 0;
    for (const i of p.crossing) {
      const cx = i % m.w;
      const cy = (i / m.w) | 0;
      if (m.at(cx, cy) === WATER) m.set(cx, cy, ROAD);
      xs += cx * 4 + 2;
      ys += cy * 4 + 2;
    }
    const n = p.crossing.length;
    w.flashes.push({ x: xs / n, y: ys / n, t: 0, max: 30, r: 60, col: [1, 0.85, 0.5], z: 12 });
    w.sparks(xs / n, ys / n, 10, [1, 0.85, 0.4]);
    w.note('NEW BRIDGE OVER THE RIVER', 'power');
    w.snd('patch', xs / n, 1);
  }

  // ---------- objectives ----------
  private start(p: Placed, o: Extract<Out, { then: Out[] }>): boolean {
    const w = this.w;
    const ob: Objective = { ev: p, kind: o.k as Objective['kind'], then: o.then, t: 0 };
    if (o.k === 'mines') {
      const tr = w.tricks;
      if (!tr?.on) return false;
      const spot = this.mineSpot(p);
      if (!spot) return false;
      const field = 1000 + this.placed.indexOf(p);
      const mines: Mine[] = [];
      for (let t = 0; t < 60 && mines.length < o.n; t++) {
        const mx = Math.round(spot[0] + (rand() - 0.5) * 36);
        const my = Math.round(spot[1] + (rand() - 0.5) * 36);
        const c = w.map.at(mx >> 2, my >> 2);
        if ((c !== EMPTY && c !== ROAD) || mines.some((q) => Math.hypot(q.x - mx, q.y - my) < 9)) continue;
        mines.push({ x: mx, y: my, alive: true, shown: true, decal: false, field });
      }
      if (mines.length < 2) return false;
      tr.mines.push(...mines);
      ob.mines = mines;
      w.note(`CLEAR THE MINES: SHOOT THEM, OR PLOUGH THEM`, 'info');
    } else if (o.k === 'escort') {
      const pts = p.route;
      if (!pts || pts.length < 2) return false;
      const cum = [0];
      for (let i = 1; i < pts.length; i++) cum.push(cum[i - 1] + Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]));
      ob.escort = { pts, cum, len: cum[cum.length - 1], s: 0, hp: EV.escortHp, x: pts[0][0], y: pts[0][1], dir: UP, drone: false, patrol: false, anim: 0 };
      w.note(`ESCORT THE ${p.def.vehicle ?? 'TRACTOR'} TO ${p.dest ?? p.place}`, 'info');
    } else if (o.k === 'fetch') {
      const spot = this.fetchSpot(p, o.near);
      if (!spot) return false;
      ob.fetch = { x: spot[0], y: spot[1], look: o.look, hold: o.hold ?? 0, prog: 0, guard: o.guard, guarded: false };
      w.note(`${FETCH_NAMES[o.look]}: FOLLOW THE ARROW`, 'info');
    } else if (o.k === 'hunt') {
      const tanks = this.patrol(o.n, p.x, p.y);
      if (!tanks.length) return false;
      ob.tanks = tanks;
    }
    this.objs.push(ob);
    return true;
  }

  /** An open patch 40-100 px from the event for a minefield. */
  private mineSpot(p: Placed): [number, number] | null {
    let best: [number, number] | null = null;
    let bs = -Infinity;
    for (let r = 40; r <= 100; r += 8) {
      for (let a = 0; a < 16; a++) {
        const x = Math.round(p.x + Math.cos((a / 16) * Math.PI * 2) * r);
        const y = Math.round(p.y + Math.sin((a / 16) * Math.PI * 2) * r);
        if (!this.reachable(x - 8, y - 8)) continue;
        if (this.w.depots.some((d) => x >= d.rect[0] - 28 && y >= d.rect[1] - 28 && x < d.rect[0] + d.rect[2] + 28 && y < d.rect[1] + d.rect[3] + 28)) continue;
        const open =this.count(x - 20, y - 20, 40, 40, (c) => c === EMPTY || c === ROAD);
        if (open < 80) continue;
        const sc = open - r * 0.3 - (this.inTown(x, y, 0) ? 40 : 0);
        if (sc > bs) { bs = sc; best = [x, y]; }
      }
    }
    return best;
  }

  /** A reachable spot fetchMin-fetchMax px from the event (by the rail / the water when asked). */
  private fetchSpot(p: Placed, near?: 'rail' | 'water'): [number, number] | null {
    const w = this.w;
    const cands: [number, number][] = [];
    for (const [lo, hi] of [[EV.fetchMin, EV.fetchMax], [60, 320]]) {
      for (let ny = 1; ny < this.nh - 1; ny++) {
        for (let nx = 1; nx < this.nw - 1; nx++) {
          if (!this.reach[ny * this.nw + nx]) continue;
          const x = nx * 8;
          const y = ny * 8;
          const d = Math.hypot(x + 8 - p.x, y + 8 - p.y);
          if (d < lo || d > hi) continue;
          if (this.inTown(x + 8, y + 8, 0) || this.placed.some((q) => q !== p && Math.hypot(q.x - x - 8, q.y - y - 8) < 48) || w.depots.some((dp) => Math.hypot(dp.cx - x - 8, dp.cy - y - 8) < 40)) continue;
          if (near === 'rail' && this.count(x - 8, y - 8, 32, 32, (c) => c === RAIL) < 4) continue;
          if (near === 'water' && this.count(x - 8, y - 8, 32, 32, (c) => c === WATER) < 4) continue;
          cands.push([x + 8, y + 8]);
        }
      }
      if (cands.length) break;
    }
    if (!cands.length) return null;
    return cands[Math.floor(rand() * cands.length)];
  }

  private finish(o: Objective, ok: boolean): void {
    const w = this.w;
    this.objs.splice(this.objs.indexOf(o), 1);
    const p = o.ev;
    if (ok) {
      this.stats.done++;
      this.resolve(p);
      w.note(`${p.def.title} · DONE`, 'power');
      w.snd('town-freed', p.x, 0.6);
      this.say(p.def.thanks, p);
      if (this.give(o.then, p)) this.recruitDue = p.place;
    } else {
      this.stats.failed++;
      p.state = 'failed';
      w.note(`${p.def.title} · FAILED`, 'warn');
      this.say(p.def.fail, p);
    }
  }

  private updateObjective(o: Objective): void {
    const w = this.w;
    o.t++;
    const pl = w.livePlayers();
    if (o.kind === 'mines') {
      if (o.mines!.every((m) => !m.alive)) this.finish(o, true);
    } else if (o.kind === 'hunt') {
      if (o.tanks!.every((t) => !t.alive)) this.finish(o, true);
    } else if (o.kind === 'fetch') {
      const f = o.fetch!;
      const d = Math.min(...pl.map((t) => Math.hypot(t.cx - f.x, t.cy - f.y)), Infinity);
      if (f.guard && !f.guarded && d < EV.guardR) {
        f.guarded = true;
        if (f.guard === 'patrol') this.patrol(2, f.x, f.y);
        else this.drone('attack');
      }
      if (d <= EV.fetchR) {
        if (f.hold > 0) {
          f.prog++;
          if (f.prog % 30 === 0 && f.prog < f.hold) w.snd('capture-tick', f.x, 0.6);
          if (f.prog >= f.hold) this.finish(o, true);
        } else this.finish(o, true);
      } else if (f.prog > 0) f.prog = Math.max(0, f.prog - 1);
    } else {
      const e = o.escort!;
      const near = pl.some((t) => Math.hypot(t.cx - e.x, t.cy - e.y) <= EV.escortNear);
      if (near && e.s < e.len) {
        e.s = Math.min(e.len, e.s + EV.escortSpeed);
        e.anim++;
      }
      let i = 0;
      while (i < e.cum.length - 2 && e.cum[i + 1] < e.s) i++;
      const a = e.pts[i];
      const b = e.pts[i + 1] ?? a;
      const k = (e.s - e.cum[i]) / (e.cum[i + 1] - e.cum[i] || 1);
      e.x = a[0] + (b[0] - a[0]) * k;
      e.y = a[1] + (b[1] - a[1]) * k;
      const ddx = b[0] - a[0];
      const ddy = b[1] - a[1];
      if (ddx || ddy) e.dir = Math.abs(ddx) > Math.abs(ddy) ? (ddx > 0 ? RIGHT : LEFT) : (ddy > 0 ? DOWN : UP);
      // trouble on the way: a drone a quarter of the way, a patrol ahead at half way
      if (!e.drone && e.s > e.len * 0.25) {
        e.drone = true;
        this.drone('attack');
      }
      if (!e.patrol && e.s > e.len * 0.45) {
        e.patrol = true;
        const s = Math.min(e.len, e.s + e.len * 0.4);
        let j = 0;
        while (j < e.cum.length - 2 && e.cum[j + 1] < s) j++;
        this.patrol(2, e.pts[j + 1]?.[0] ?? e.x, e.pts[j + 1]?.[1] ?? e.y);
      }
      // enemy shells hit it (ours pass: the driver ducks)
      for (const bl of w.bullets) {
        if (!bl.alive || bl.owner.isPlayer) continue;
        if (Math.abs(bl.x - e.x) < 7 && Math.abs(bl.y - e.y) < 7) {
          bl.alive = false;
          e.hp--;
          w.booms.push({ x: bl.x, y: bl.y, big: false, t: 0 });
          w.sparks(bl.x, bl.y, 6, [1, 0.7, 0.3]);
          w.snd('armor', e.x, 0.8);
          w.popups.push({ x: e.x, y: e.y - 12, text: e.hp > 0 ? `${o.ev.def.vehicle ?? 'TRACTOR'} HIT` : 'BROKEN DOWN', t: 0, col: [1, 0.5, 0.35] });
        }
      }
      if (e.hp <= 0) this.finish(o, false);
      else if (e.s >= e.len) this.finish(o, true);
    }
  }

  // ---------- saving ----------
  /** Copy seen / resolved events into the run (save.ts syncRun). */
  save(run: RunState): void {
    if (!this.dirty) return;
    this.dirty = false;
    const all = run.events ?? (run.events = {});
    all[String(this.region)] = { seen: [...this.seen], done: [...this.done] };
  }

  /** Where the HUD should point: active objectives' targets (centre px) with a short label. */
  targets(): { x: number; y: number; label: string }[] {
    const out: { x: number; y: number; label: string }[] = [];
    for (const o of this.objs) {
      if (o.kind === 'escort') out.push({ x: o.escort!.x, y: o.escort!.y, label: o.ev.def.vehicle ?? 'ESCORT' });
      else if (o.kind === 'fetch') out.push({ x: o.fetch!.x, y: o.fetch!.y, label: FETCH_NAMES[o.fetch!.look] });
      else if (o.kind === 'mines') {
        const live = o.mines!.filter((m) => m.alive);
        if (live.length) out.push({ x: live[0].x, y: live[0].y, label: `MINES ${o.mines!.length - live.length}/${o.mines!.length}` });
      } else {
        const live = o.tanks!.filter((t) => t.alive && t.spawn === 0);
        if (live.length) out.push({ x: live[0].cx, y: live[0].cy, label: `PATROL ${o.tanks!.length - o.tanks!.filter((t) => t.alive).length}/${o.tanks!.length}` });
      }
    }
    return out;
  }

  // ---------- drawing ----------
  /** In-world markers and objectives (screen = world + ox/oy). Unlit overlay so they read at night. */
  draw(r: Renderer, ox: number, oy: number, time: number): void {
    const w = this.w;
    if (!w.region) return;
    const on = (sx: number, sy: number, m: number) => sx > -m && sy > -m && sx < r.nw + m && sy < r.nh + m;
    const f = w.frame;
    const GOLD: V3 = [1, 0.78, 0.18];
    // the markers: whoever the event is about stands there (src/art/campaign-items.ts), waving if they bring a
    // recruit, with a "!" bubble over them (unlit, so it reads at night) and a lantern's light on them
    const S1 = r.atlas.S;
    for (const p of this.placed) {
      if (!this.available(p)) continue;
      const sx = Math.round(ox + p.x);
      const sy = Math.round(oy + p.y);
      if (!on(sx, sy, 24)) continue;
      const pulse = 0.5 + 0.5 * Math.sin(time * 5 + p.x);
      const bob = Math.round(Math.sin(time * 3 + p.y) * 1);
      const look = markerLook(p.def);
      let top = sy - 8;
      if (look.person) {
        const s = S1[`person${look.person}${look.wave && Math.floor(time * 2.5 + p.x) & 1 ? 1 : 0}`];
        if (s) {
          top = sy + 4 - s.h;
          r.spr(s, sx - (s.w >> 1) + (s.w > 7 ? 1 : 0), top, 0, WHITE3, MAT_STD, 0, 1);
        }
      } else if (look.thing) {
        const s = S1[look.thing];
        if (s) {
          const w = look.rot & 1 ? s.h : s.w;
          const h = look.rot & 1 ? s.w : s.h;
          top = sy - (h >> 1);
          r.spr(s, sx - (w >> 1), top, look.rot, look.tint ?? WHITE3, MAT_STD, 0, 1);
        }
      }
      r.light(sx, sy - 6, 12, 26, 0.36 * pulse + 0.2, 0.28 * pulse + 0.15, 0.1, false);
      bubble(r, sx - 3, top - 12 + bob, pulse);
    }
    // objectives
    for (const o of this.objs) {
      if (o.kind === 'escort') {
        const e = o.escort!;
        const sx = Math.round(ox + e.x);
        const sy = Math.round(oy + e.y);
        // the road ahead, dotted, to the destination
        let shown = 0;
        for (let s = e.s + 12; s < e.len && shown < 40; s += 8, shown++) {
          let i = 0;
          while (i < e.cum.length - 2 && e.cum[i + 1] < s) i++;
          const a = e.pts[i];
          const b = e.pts[i + 1] ?? a;
          const k = (s - e.cum[i]) / (e.cum[i + 1] - e.cum[i] || 1);
          const px = Math.round(ox + a[0] + (b[0] - a[0]) * k);
          const py = Math.round(oy + a[1] + (b[1] - a[1]) * k);
          if (on(px, py, 4)) r.ovRect(px - 1, py - 1, 2, 2, GOLD, 0.25 + 0.3 * (1 - shown / 40));
        }
        const end = e.pts[e.pts.length - 1];
        const ex = Math.round(ox + end[0]);
        const ey = Math.round(oy + end[1]);
        if (on(ex, ey, 20)) glyph(r, '!', ex - 2, ey - 10, 1, GOLD, 0.9);
        if (!on(sx, sy, 40)) continue;
        // Petro's tractor and Ivan's handcar have their own sprites; anything else rides in a truck
        const veh = o.ev.def.vehicle;
        const spr = veh === 'TRACTOR' ? r.atlas.S[`evTractor${(e.anim >> 3) & 1}`] : veh === 'HANDCAR' ? r.atlas.S.evHandcar
          : r.atlas.S[`trkTruck${(e.anim >> 3) & 1}`];
        const tint: V3 = veh === 'TRACTOR' || veh === 'HANDCAR' ? WHITE3 : veh === 'TRUCK' ? [0.55, 0.7, 0.45] : [1, 0.78, 0.35];
        if (spr) r.spr(spr, sx - 8, sy - 8, e.dir, tint, MAT_STD, 0, 1);
        const head = 0.8;
        r.spot(sx + DX[e.dir] * 8, sy + DY[e.dir] * 8, 5, 60, head, head * 0.85, head * 0.6, true, DX[e.dir], DY[e.dir], 0.8, 0.95);
        // label and hit pips over it
        const lab = o.ev.def.vehicle ?? 'ESCORT';
        text(r, lab, sx - lab.length * 3 + 1, sy - 21, LABEL);
        const pw = EV.escortHp * 3 - 1;
        r.ovRect(sx - Math.ceil(pw / 2) - 1, sy - 13, pw + 2, 4, [0.02, 0.02, 0.03], 0.82);
        for (let i = 0; i < EV.escortHp; i++) r.ovRect(sx - Math.ceil(pw / 2) + i * 3, sy - 12, 2, 2, i < e.hp ? [0.5, 1, 0.4] : [0.3, 0.28, 0.3], 1);
        const moving = w.livePlayers().some((t) => Math.hypot(t.cx - e.x, t.cy - e.y) <= EV.escortNear);
        if (!moving && (f >> 4) & 1) text(r, 'WAITING', sx - 20, sy + 11, [1, 0.6, 0.4]);
      } else if (o.kind === 'fetch') {
        const fe = o.fetch!;
        const sx = Math.round(ox + fe.x);
        const sy = Math.round(oy + fe.y);
        if (!on(sx, sy, 30)) continue;
        const S2 = r.atlas.S;
        if (fe.look === 'hull') {
          const s = S2.dom0a ?? S2.e0a; // the Dominion's basic tank, abandoned
          if (s) r.spr(s, sx - 8, sy - 8, DOWN, [0.62, 0.6, 0.56], MAT_STD, 0, 1);
        } else if (fe.look === 'wagon' || fe.look === 'boat') {
          const s = S2.trkWreck ?? S2.trkTruck0;
          if (s) r.spr(s, sx - 8, sy - 8, fe.look === 'boat' ? RIGHT : UP, fe.look === 'boat' ? [0.7, 0.6, 0.5] : [0.75, 0.7, 0.62], MAT_STD, 0, 1);
        } else {
          // the supply drop under its parachute, or the generator (src/art/campaign-items.ts)
          const s = S2[fe.look === 'generator' ? 'evGen' : 'evDrop'];
          if (s) r.spr(s, sx - (s.w >> 1), sy - (s.h >> 1) - (fe.look === 'generator' ? 0 : 3), 0, WHITE3, MAT_STD, 0, 1);
          else crate(r, sx, sy, fe.look === 'generator');
        }
        const pulse = 0.6 + 0.4 * Math.sin(time * 6);
        r.glow(sx, sy, 14, GOLD, 0.1 * pulse);
        r.light(sx, sy - 4, 12, 26, 0.18 * pulse, 0.14 * pulse, 0.05, false);
        if (fe.hold > 0) {
          const fill = (fe.prog / fe.hold) * 40;
          for (let i = 0; i < 40; i++) {
            const a = -Math.PI / 2 + (i / 40) * Math.PI * 2;
            r.fxRect(Math.round(sx + Math.cos(a) * 14) - 1, Math.round(sy + Math.sin(a) * 14) - 1, 2, 2, i < fill ? [1, 0.7, 0.2] : [1, 0.4, 0.3], i < fill ? 0.95 : 0.22);
          }
        }
        const lab = FETCH_NAMES[fe.look];
        text(r, lab, sx - lab.length * 3 + 1, sy - 20, LABEL);
      } else if (o.kind === 'mines') {
        // Baba Olha's socks on sticks beside every mine still in the field
        for (const m of o.mines!) {
          if (!m.alive) continue;
          const mx = Math.round(ox + m.x);
          const my = Math.round(oy + m.y);
          if (!on(mx, my, 16)) continue;
          const s = r.atlas.S[`evSock${Math.floor(time * 2 + m.x * 0.37) & 1}`];
          if (s) r.spr(s, mx + 3, my - 9, 0, WHITE3, MAT_STD, 0, 1);
        }
      } else if (o.kind === 'hunt') {
        for (const t of o.tanks!) {
          if (!t.alive || t.spawn > 0) continue;
          const sx = Math.round(ox + t.x);
          const sy = Math.round(oy + t.y);
          if (!on(sx, sy, 20)) continue;
          const c: V3 = [1, 0.3, 0.2];
          for (const [bx, by, bw, bh] of [[-2, -2, 4, 1], [-2, -2, 1, 4], [15, -2, 4, 1], [18, -2, 1, 4], [-2, 18, 4, 1], [-2, 15, 1, 4], [15, 18, 4, 1], [18, 15, 1, 4]]) r.ovRect(sx + bx, sy + by, bw, bh, c, (f >> 3) & 1 ? 0.95 : 0.5);
        }
      }
    }
    // an arrow circling the player toward each objective out of view (clear of the HUD plates at the screen edges)
    const me = w.livePlayers()[0];
    const hx = me ? ox + me.cx : r.nw / 2;
    const hy = me ? oy + me.cy : r.nh / 2;
    for (const t of this.targets()) {
      const sx = ox + t.x;
      const sy = oy + t.y;
      if (on(sx, sy, -32)) continue; // near the edges the HUD plates may hide it: point there too
      const dx = sx - hx;
      const dy = sy - hy;
      const n = Math.hypot(dx, dy) || 1;
      const ux = dx / n;
      const uy = dy / n;
      const ax = Math.round(hx + ux * 30);
      const ay = Math.round(hy + uy * 26);
      const blink = (f >> 4) & 1 ? 1 : 0.65;
      // a pixel arrow in one of 8 directions, dark-edged
      const oct = ((Math.round(Math.atan2(dy, dx) / (Math.PI / 4)) % 8) + 8) % 8;
      const pts = arrowPixels(oct);
      for (const [px, py] of pts) r.ovRect(ax - 4 + px, ay - 4 + py, 3, 3, [0.02, 0.02, 0.03], 0.7);
      for (const [px, py] of pts) r.ovRect(ax - 3 + px, ay - 3 + py, 1, 1, LABEL, blink);
      const lab = `${t.label} ${Math.round(n / 16)}`;
      const lx = Math.round(ax + ux * 8 - (lab.length * 6) / 2 + (ux > 0.3 ? lab.length * 3 : ux < -0.3 ? -lab.length * 3 : 0));
      const ly = Math.round(ay + uy * 8 - 3);
      text(r, lab, lx, ly, LABEL);
    }
  }

  /** Markers on the minimap / big map (s = map px per world px). */
  drawMap(g: CanvasRenderingContext2D, s: number, big: boolean, frame: number): void {
    const blink = (frame >> 3) % 4 !== 0;
    // a "!" (1 px wide on the minimap, 2 on the big map) in a dark outline
    const mark = (wx: number, wy: number, col: string) => {
      const x = Math.round(wx * s);
      const y = Math.round(wy * s);
      const k = big ? 2 : 1;
      g.fillStyle = '#0b0c0e';
      g.fillRect(x - 1, y - 3 * k - 1, k + 2, 4 * k + 2);
      g.fillStyle = col;
      g.fillRect(x, y - 3 * k, k, 2 * k);
      g.fillRect(x, y, k, k);
    };
    for (const p of this.placed) if (this.available(p) && blink) mark(p.x, p.y, '#f8b800');
    for (const t of this.targets()) mark(t.x, t.y, (frame >> 3) & 1 ? '#ffe08a' : '#f8b800');
    if (this.shownUntil) {
      g.fillStyle = '#f0482a';
      for (const e of this.shown) if (e.alive) g.fillRect(Math.round(e.cx * s) - 1, Math.round(e.cy * s) - 1, big ? 3 : 2, big ? 3 : 2);
    }
  }
}

/** Draw one font glyph with a dark outline, scale k (unlit overlay). */
function glyph(r: Renderer, ch: string, x: number, y: number, k: number, col: V3, a: number): void {
  const g = FONT[ch];
  if (!g) return;
  for (let gy = 0; gy < 7; gy++) for (let gx = 0; gx < 5; gx++) if (g[gy][gx]) r.ovRect(x + gx * k - 1, y + gy * k - 1, k + 2, k + 2, [0.03, 0.02, 0.02], 0.9 * a);
  for (let gy = 0; gy < 7; gy++) for (let gx = 0; gx < 5; gx++) if (g[gy][gx]) r.ovRect(x + gx * k, y + gy * k, k, k, col, a);
}

/** 7x7 arrows: pointing right, and down-right; the other six are these turned. */
const ARROW_STRAIGHT = ['X......', 'XXX....', 'XXXXX..', 'XXXXXXX', 'XXXXX..', 'XXX....', 'X......'];
const ARROW_DIAG = ['.......', '.....X.', '....XX.', '...XXX.', '..XXXX.', '.XXXXX.', '.......'];
const arrowCache = new Map<number, [number, number][]>();
/** Pixels of the arrow for octant o (0 = right, 1 = down-right, ... clockwise). */
function arrowPixels(o: number): [number, number][] {
  let a = arrowCache.get(o);
  if (a) return a;
  const src = o % 2 ? ARROW_DIAG : ARROW_STRAIGHT;
  a = [];
  for (let y = 0; y < 7; y++) for (let x = 0; x < 7; x++) {
    if (src[y][x] !== 'X') continue;
    let px = x;
    let py = y;
    for (let k = 0; k < o >> 1; k++) [px, py] = [6 - py, px]; // a quarter turn clockwise
    a.push([px, py]);
  }
  arrowCache.set(o, a);
  return a;
}

const WHITE3: V3 = [1, 1, 1];

/** Map-event marker art: a person sprite (personNAME0/1 in src/art/campaign-items.ts) or a thing. */
interface MarkerLook { person?: string; wave: boolean; thing?: string; rot: number; tint?: V3 }
const PEOPLE_DRAWN = new Set(['OLHA', 'PETRO', 'IVAN', 'LEV', 'VASYL', 'DMYTRO', 'MILA', 'BOHDAN']);
/** Things that stand in for events nobody local is in (HQ's drop, a downed drone, an open radio channel). */
const MARKER_THINGS: Record<string, Omit<MarkerLook, 'wave'>> = {
  drop: { thing: 'evDrop', rot: 0 },
  salvage: { thing: 'trkDrone1', rot: 1, tint: [0.55, 0.5, 0.46] },
  intercept: { thing: 'evRadio', rot: 0 },
};
const lookCache = new Map<string, MarkerLook>();
/** Who stands at an event: the first local who speaks in it (waving when an answer brings a recruit), else a thing. */
function markerLook(def: EventDef): MarkerLook {
  let l = lookCache.get(def.id);
  if (l) return l;
  const brings = (outs: Out[]): boolean => outs.some((o) => o.k === 'recruit' || ('then' in o && brings(o.then)));
  const wave = def.choices.some((c) => brings(c.outs));
  const who = def.lines.flatMap(([w]) => w.split('|')).find((w) => PEOPLE_DRAWN.has(w));
  const thing = MARKER_THINGS[def.id];
  l = thing ? { ...thing, wave: false } : { person: who ?? 'PETRO', wave, rot: 0 };
  lookCache.set(def.id, l);
  return l;
}

/** The "!" speech bubble over an event (unlit overlay): x, y = its top-left; 8 x 8 with a tail down-left. */
function bubble(r: Renderer, x: number, y: number, pulse: number): void {
  const D: V3 = [0.03, 0.02, 0.02];
  const fill: V3 = pulse > 0.5 ? [1, 0.88, 0.42] : [1, 0.78, 0.18];
  const ink: V3 = [0.42, 0.1, 0.04];
  r.ovRect(x - 1, y, 10, 8, D, 0.9);
  r.ovRect(x, y - 1, 8, 10, D, 0.9);
  r.ovRect(x, y + 9, 3, 2, D, 0.9);
  r.ovRect(x, y, 8, 8, fill, 1);
  r.ovRect(x + 1, y + 8, 2, 1, fill, 1);
  r.ovRect(x + 1, y + 9, 1, 1, fill, 1);
  r.ovRect(x + 3, y + 1, 2, 4, ink, 1);
  r.ovRect(x + 3, y + 6, 2, 1, ink, 1);
}

/** HUD labels in the world: muted gold, so they read without blooming. */
const LABEL: V3 = [0.92, 0.74, 0.3];

/** A short line of the 5x7 font on a dark plate (unlit overlay). */
function text(r: Renderer, s: string, x: number, y: number, col: V3): void {
  r.ovRect(x - 2, y - 2, s.length * 6 + 3, 11, [0.03, 0.03, 0.04], 0.72);
  for (let i = 0; i < s.length; i++) {
    const g = FONT[s[i]];
    if (!g) continue;
    for (let gy = 0; gy < 7; gy++) for (let gx = 0; gx < 5; gx++) if (g[gy][gx]) r.ovRect(x + i * 6 + gx, y + gy, 1, 1, col, 1);
  }
}

/** A wooden supply crate with its parachute beside it, or a generator (lit, in the gbuffer). (x, y) = centre. */
function crate(r: Renderer, x: number, y: number, gen: boolean): void {
  const R = (ax: number, ay: number, w: number, h: number, c: V3, hb = 0.06) => r.rectG(x + ax, y + ay, w, h, MAT_STD, c, hb);
  if (gen) {
    R(-6, -5, 12, 10, [0.24, 0.26, 0.28]);
    R(-5, -4, 10, 8, [0.42, 0.45, 0.48]);
    for (let i = 0; i < 4; i++) R(-4 + i * 2, -3, 1, 4, [0.16, 0.17, 0.18]);
    R(-5, 2, 10, 1, [0.85, 0.65, 0.15]);
    R(3, -3, 2, 2, [0.75, 0.2, 0.15]);
    return;
  }
  // the parachute lying on the grass behind it, cords running to the crate
  const W: V3 = [0.86, 0.85, 0.8];
  const D: V3 = [0.62, 0.6, 0.56];
  for (const [ax, ay, w] of [[4, -12, 10], [3, -11, 12], [3, -10, 12], [4, -9, 10]] as const) R(ax, ay, w, 1, ay === -10 ? D : W, 0.01);
  for (let i = 0; i < 4; i++) R(3 - i, -8 + i, 1, 1, [0.5, 0.48, 0.44], 0.01);
  R(-6, -5, 12, 10, [0.3, 0.19, 0.09]);
  R(-5, -4, 10, 8, [0.6, 0.42, 0.22]);
  R(-5, -1, 10, 1, [0.38, 0.25, 0.12]);
  R(-1, -4, 1, 8, [0.38, 0.25, 0.12]);
  R(1, 1, 3, 2, [0.85, 0.7, 0.2]);
}
