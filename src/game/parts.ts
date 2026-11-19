// Tank parts: the catalogue, rolling a random part for a pickup, and applying a loadout's stats to a tank.
// Each stat step is small (PartStats in run.ts): +1 armour = one more hit, +1 speed = 8% faster, +1 reload = 10%
// shorter reload, firepower 1 = extra damage to armoured tanks, 2 = shells break steel. About a third of the parts
// are captured (stripped from enemy wrecks): stronger, usually with a catch. Names stay within 14 characters so
// they fit a garage slot; all text is pixel-font safe (tools/parts-check.ts checks both).
import type { Loadout, PartDef, PartStats, Slot } from './run';
import type { Tank } from './world';

/** Max armour of a bare tank (world.ts ARMOUR_MAX); veterancy and armour parts add to it. */
export const BASE_ARMOUR = 10;

export const PARTS: PartDef[] = [
  // armour plates
  { id: 'scrap-plates', slot: 'armour', name: 'SCRAP PLATES', stats: { armour: 2 }, scrap: 10,
    desc: 'MOSTLY AN OLD BUS STOP. THE TIMETABLE IS STILL ON ONE.' },
  { id: 'sandbags', slot: 'armour', name: 'SANDBAG SKIRT', stats: { armour: 3, speed: -1 }, scrap: 8,
    desc: 'SAND IS FREE. DRAGGING IT AROUND IS NOT.' },
  { id: 'bed-cage', slot: 'armour', name: 'BED-FRAME CAGE', stats: { armour: 1 }, scrap: 5,
    desc: 'WELDED FROM GRANNY\'S SPARE BED. SHE SAYS SHE WANTS IT BACK.' },
  { id: 'reactive', slot: 'armour', name: 'REACTIVE TILES', stats: { armour: 4, speed: -1 }, scrap: 20, captured: true,
    desc: 'EXPLOSIVE BRICKS. PLEASE DO NOT LEAN ON THE TANK.' },
  // engines
  { id: 'tractor-diesel', slot: 'engine', name: 'TRACTOR DIESEL', stats: { speed: 1 }, scrap: 8,
    desc: 'PULLED BEETS FOR 20 YEARS. NOW IT PULLS A TANK.' },
  { id: 'bus-engine', slot: 'engine', name: 'BUS ENGINE', stats: { speed: 2, reload: -1 }, scrap: 11,
    desc: 'THE TURRET RUNS OFF THE SAME BELT. DRIVE OR AIM, NOT BOTH.' },
  { id: 'turbo-diesel', slot: 'engine', name: 'TURBO DIESEL', stats: { speed: 3, armour: -1 }, scrap: 19, captured: true,
    desc: 'FASTER THAN OURS AND TWICE AS LOUD. THEY WILL HEAR YOU COMING.' },
  // barrels and loaders
  { id: 'long-100', slot: 'barrel', name: 'LONG 100 MM', stats: { firepower: 1 }, scrap: 9,
    desc: 'SAME GUN, MORE PIPE. SPANNER SAYS THAT COUNTS.' },
  { id: 'sewing-loader', slot: 'barrel', name: 'SEWING LOADER', stats: { reload: 2 }, scrap: 12,
    desc: 'BUILT FROM A SEWING MACHINE. LOADS FASTER THAN THE GUNNER, MOANS LESS.' },
  { id: 'barrel-125', slot: 'barrel', name: '125 MM BARREL', stats: { firepower: 2, reload: -1 }, scrap: 15, captured: true,
    desc: 'STILL HAS THEIR SERIAL NUMBER ON IT. SPANNER FILED IT OFF. MOSTLY.' },
  { id: 'autoloader', slot: 'barrel', name: 'AUTOLOADER', stats: { reload: 3, armour: -1 }, scrap: 18, captured: true,
    desc: 'THE SHELLS RIDE IN A RING UNDER YOUR SEAT. TRY NOT TO THINK ABOUT IT.' },
  // tracks
  { id: 'wide-tracks', slot: 'tracks', name: 'WIDE TRACKS', stats: { speed: 1 }, scrap: 8,
    desc: 'BORROWED FROM A SNOW PLOUGH. NOBODY ASKED THE SNOW PLOUGH.' },
  { id: 'racing-tracks', slot: 'tracks', name: 'RACING TRACKS', stats: { speed: 2, armour: -1 }, scrap: 10,
    desc: 'LIGHTER LINKS, FEWER SKIRTS. FAST, AND A LITTLE NAKED.' },
  { id: 'army-tracks', slot: 'tracks', name: 'ARMY TRACKS', stats: { speed: 2, armour: 1 }, scrap: 17, captured: true,
    desc: 'NEWER THAN OURS. THE MANUAL WAS IN THEIR LANGUAGE, SO WE BURNED IT.' },
  // drone jammers (Phase 3: enemy drones)
  { id: 'aerial-jammer', slot: 'jammer', name: 'AERIAL JAMMER', stats: {}, scrap: 6,
    desc: 'A TV AERIAL AND A CAR BATTERY. WORKS ONCE DRONES SHOW UP.' },
  { id: 'oven-jammer', slot: 'jammer', name: 'OVEN JAMMER', stats: {}, scrap: 7,
    desc: 'MADE FROM A MICROWAVE. STILL BEEPS WHEN IT IS DONE. WORKS ONCE DRONES SHOW UP.' },
  // mine ploughs (Phase 3: minefields)
  { id: 'farm-harrow', slot: 'plough', name: 'FARM HARROW', stats: {}, scrap: 5,
    desc: 'CLEARS MINES. ALSO TURNIPS. WORKS ONCE MINES SHOW UP.' },
  { id: 'mine-roller', slot: 'plough', name: 'MINE ROLLER', stats: { armour: 1, speed: -1 }, scrap: 14, captured: true,
    desc: 'A PROPER ONE, HEAVY AS A CHURCH BELL. ROLLS MINES FLAT ONCE MINES SHOW UP.' },
];

const BY_ID = new Map(PARTS.map((p) => [p.id, p]));

export function partById(id: string): PartDef | undefined {
  return BY_ID.get(id);
}

/** A random part for a pickup or a reward (rng returns 0..1). captured = stripped from an enemy wreck. */
export function rollPart(rng: () => number, captured = false): string | null {
  const pool = PARTS.filter((p) => !!p.captured === captured);
  return pool.length ? pool[Math.min(pool.length - 1, Math.floor(rng() * pool.length))].id : null;
}

export const STAT_KEYS = ['armour', 'speed', 'firepower', 'reload'] as const;
export type StatKey = (typeof STAT_KEYS)[number];
export const STAT_NAMES: Record<StatKey, string> = { armour: 'ARMOUR', speed: 'SPEED', firepower: 'FIREPOWER', reload: 'RELOAD' };

/** Sum of every fitted part's stat steps (unknown ids are ignored). */
export function loadoutStats(loadout: Loadout): Required<PartStats> {
  const s = { armour: 0, speed: 0, firepower: 0, reload: 0 };
  for (const id of Object.values(loadout)) {
    const p = id ? partById(id) : undefined;
    if (!p) continue;
    for (const k of STAT_KEYS) s[k] += p.stats[k] ?? 0;
  }
  return s;
}

/** The numbers applyLoadout gives a tank with this veterancy and loadout. */
export function tankNumbers(loadout: Loadout, vet = 0): { armourMax: number; speedMul: number; firepower: number; reloadMul: number } {
  const s = loadoutStats(loadout);
  return {
    armourMax: Math.max(1, BASE_ARMOUR + vet + s.armour),
    speedMul: Math.max(0.76, 1 + 0.08 * s.speed),
    firepower: Math.max(0, s.firepower),
    reloadMul: Math.max(0.5, 1 - 0.1 * s.reload),
  };
}

/** Sets the tank's campaign stats from its fitted parts: armourMax bonus, speedMul, firepower, reloadMul. */
export function applyLoadout(t: Tank, loadout: Loadout): void {
  const n = tankNumbers(loadout, t.vet);
  t.armourMax = n.armourMax;
  t.armour = Math.max(0, Math.min(t.armour, t.armourMax));
  t.speedMul = n.speedMul;
  t.firepower = n.firepower;
  t.reloadMul = n.reloadMul;
}

/** b - a per stat (what changes going from a to b). */
export function statDiff(a: PartStats, b: PartStats): Required<PartStats> {
  const d = { armour: 0, speed: 0, firepower: 0, reload: 0 };
  for (const k of STAT_KEYS) d[k] = (b[k] ?? 0) - (a[k] ?? 0);
  return d;
}

/** "+2 FIREPOWER", "-1 RELOAD": one line per non-zero stat, gains first, for labels and the parts panel. */
export function statLines(stats: PartStats): { text: string; gain: boolean; key: StatKey; n: number }[] {
  const out: { text: string; gain: boolean; key: StatKey; n: number }[] = [];
  for (const k of STAT_KEYS) {
    const n = stats[k] ?? 0;
    if (n) out.push({ text: `${n > 0 ? '+' : ''}${n} ${STAT_NAMES[k]}`, gain: n > 0, key: k, n });
  }
  return out.sort((a, b) => Number(b.gain) - Number(a.gain));
}

/** Stats in one short label, e.g. "+2 FIREPOWER -1 RELOAD"; "" when the part has none. */
export function statLabel(stats: PartStats): string {
  return statLines(stats).map((l) => l.text).join(' ');
}
