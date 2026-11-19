// Campaign regions: big scrolling maps with no base. The generators live in src/game/regions/: gen.ts (shared
// planner + Region 1 farmland), rail.ts, delta.ts, ruins.ts, winter.ts.
import type { EnvName } from './stages';
import { Farm } from './regions/gen';
import { Rail } from './regions/rail';
import type { RailTrack } from './railgeo';
import { Delta } from './regions/delta';
import { Ruins } from './regions/ruins';
import { Winter } from './regions/winter';

export { regionReach } from './regions/gen';

/** A town to free: its built-up area and the dug-in spots its garrison holds. All in px. */
export interface Town {
  name: string;
  /** built-up area: x, y, w, h */
  rect: [number, number, number, number];
  /** centre (the flag the player captures) */
  cx: number;
  cy: number;
  /** tank top-left spots (8 px grid) where defenders dig in: behind walls, in tree lines */
  garrison: [number, number][];
}

/** Enemy supply depot (an objective to destroy, later a convoy end point). */
export interface Depot {
  name: string;
  rect: [number, number, number, number];
  cx: number;
  cy: number;
}

/**
 * The road network as a graph of 8 px tank nodes: nodes[i] = [nx, ny] (tank top-left = n * 8), edges = pairs of
 * node indices joined by a drivable road. Assault groups and convoys route along it. Road cells are also marked
 * ROAD in `cells`.
 */
export interface RoadGraph {
  nodes: [number, number][];
  edges: [number, number][];
}

export interface RegionSpec {
  name: string;
  env: EnvName;
  /** Size in 4 px cells. */
  w: number;
  h: number;
  /** w*h cell types (row-major), see constants.ts. */
  cells: Uint8Array;
  /** w*h ground kinds (GK_* in constants.ts): house floors, paving, crop rows. Visual only: the ground material
   * draws them, the rules never read them. */
  kinds?: Uint8Array;
  /** which generator made the map: picks the region's brick and foliage colours (draw.ts LOOKS) */
  kind?: RegionKind;
  /** Tank top-left in px, on the 8 px grid. One per player. */
  playerSpawns: [number, number][];
  enemySpawns: [number, number][];
  /** Total enemies in the queue. */
  enemies: number;
  /** Enemies alive at once. */
  maxActive: number;
  /** Phase 1: towns, depots and roads (optional so the Phase 0 test region still type-checks). */
  towns?: Town[];
  depots?: Depot[];
  roads?: RoadGraph;
  /** Tank top-left (px) where each road leaves the map: where enemy assault groups drive in. */
  exits?: [number, number][];
  /** Tank top-left (px) in the middle of each road bridge. */
  bridges?: [number, number][];
  /** Phase 4: which boss guards this region (default 'grinder'). */
  boss?: BossKind;
  /** Phase 4: railway line as a polyline of px points (centre of the track), for the armoured train; cells under it
   * are RAIL. */
  rail?: [number, number][];
  /** Every track's exact centre line (the main line first, then sidings), for drawing the rails (railgeo.ts).
   * Visual only. Without it the track is drawn along `rail`. */
  tracks?: RailTrack[];
  /** Phase 4: centre line of the main river channel as a polyline of px points (the flagship's patrol route). */
  river?: [number, number][];
  /** Phase 4 (optional hint): centre in px of an open area built for the boss fight (Winter Front's fortified lair,
   * Ruined Town's central square). */
  lair?: [number, number];
  /** Ambient light sources fixed in the map (Ruined Town: burning buildings, street fires, working streetlamps),
   * drawn by src/game/ambient.ts. Visual only. */
  ambient?: AmbientSpot[];
  /** ?arena= test map (src/game/arena.ts): no towns, boss or events; tricks staged by hand; never clears. */
  arena?: 'tricks';
}

/** A fixed ambient light source. x, y = world px; kind: 0 burning building, 1 street fire, 2 streetlamp
 * (dir = the side its arm reaches out over the street: 0 up, 1 right, 2 down, 3 left); size 0..1; seed 0..1. */
export interface AmbientSpot { x: number; y: number; kind: 0 | 1 | 2; size: number; seed: number; dir: number }

/** The five campaign bosses (CAMPAIGN.md "Regions and bosses"). */
export type BossKind = 'grinder' | 'train' | 'flagship' | 'heli' | 'final';

/** The generator of each region kind. */
export type RegionKind = 'farm' | 'rail' | 'delta' | 'ruins' | 'winter';
export const REGION_KINDS: RegionKind[] = ['farm', 'rail', 'delta', 'ruins', 'winter'];

/** Run a generator class until one attempt gives a valid layout (later attempts relax the town / depot counts). */
function generate(kind: RegionKind, seed: number, sw: number, sh: number): RegionSpec {
  const why: string[] = [];
  for (let attempt = 0; attempt < 24; attempt++) {
    const g = kind === 'rail' ? new Rail(seed, attempt, sw, sh) : kind === 'delta' ? new Delta(seed, attempt, sw, sh)
      : kind === 'ruins' ? new Ruins(seed, attempt, sw, sh) : kind === 'winter' ? new Winter(seed, attempt, sw, sh)
        : new Farm(seed, attempt, sw, sh);
    const spec = g.build();
    why.push(g.fail);
    if (spec) {
      spec.kind = kind;
      if ((globalThis as { REGION_DEBUG?: boolean }).REGION_DEBUG) console.log(`  ${kind}(${seed}) attempts: ${why.join(', ')}`);
      return spec;
    }
  }
  throw new Error(`make region ${kind}(${seed}): no layout found (${why.join(', ')})`);
}

/** A region of the given kind. */
export function makeRegion(kind: RegionKind, seed: number, screensW = 5, screensH = 4): RegionSpec {
  return generate(kind, seed, screensW, screensH);
}

/** The campaign test region (?region=N and the CAMPAIGN TEST menu): Region 1, farmland. */
export function makeTestRegion(seed: number, screensW = 5, screensH = 4): RegionSpec {
  return makeFarmland(seed, screensW, screensH);
}

/**
 * Region 2 "Rail junction": pine forest with clearings and logging tracks, a railway line (RAIL, 16 px wide, long
 * gentle curves) right across the map with a junction yard of parallel sidings beside the station town, level
 * crossings where roads meet it, a sawmill village and forest hamlets. `rail` = the main line, edge to edge.
 */
export function makeRailJunction(seed: number, screensW = 5, screensH = 4): RegionSpec {
  return generate('rail', seed, screensW, screensH);
}

/**
 * Region 3 "River delta": a wide river splitting into channels round islands, marsh pools and reed beds, 3-4 road
 * bridges and fords, fishing villages on the banks and islands. `river` = the main channel's centre line, edge to
 * edge, at least 48 px of open water wide (bridges cross it).
 */
export function makeRiverDelta(seed: number, screensW = 5, screensH = 4): RegionSpec {
  return generate('delta', seed, screensW, screensH);
}

/**
 * Region 4 "Ruined town": a shattered city filling the map: blocks of damaged brick buildings and rubble on a grid
 * of streets (a road lane between clear pavements, 32 px kerb to kerb), a central square, steel-framed factory
 * ruins with the depots in their yards, parks and a canal with bridges. Districts are the towns to free.
 */
export function makeRuinedTown(seed: number, screensW = 5, screensH = 4): RegionSpec {
  return generate('ruins', seed, screensW, screensH);
}

/**
 * Region 5 "Winter front": snowy fields, a frozen river (ice with open holes) and frozen ponds, trench lines of
 * broken brick, forests, dug-in positions, villages and depots, a long front road edge to edge, and a fortified
 * open lair near the far edge for the final fight (`lair`).
 */
export function makeWinterFront(seed: number, screensW = 5, screensH = 4): RegionSpec {
  return generate('winter', seed, screensW, screensH);
}

/**
 * Region 1 "Farmland": a district of hedged fields crossed by dirt roads. Villages sit on the roads (a ring road
 * round a green with the flag, streets of brick houses with hedged yards), enemy supply depots are walled
 * compounds with a gate onto a road, one river has 2-3 road bridges (and sometimes a ford), and a few roads leave
 * the map edges where enemy assault groups drive in. The player starts on a road near one edge, away from the
 * towns. Deterministic per seed; everything a tank needs is reachable from the player start.
 */
export function makeFarmland(seed: number, screensW = 5, screensH = 4): RegionSpec {
  return generate('farm', seed, screensW, screensH);
}
