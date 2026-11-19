// Phase 2 contract (CAMPAIGN.md "A run", "Your tank"): the state of a campaign run that survives between
// regions, retreats and browser sessions (saved to localStorage), plus the tank part types the garage fits.
// Owners: parts.ts (catalogue, stats, rolls) and ui-garage.ts build on PartDef/Loadout; the run flow (app.ts,
// save/load, retreat) owns RunState.

/** Part slots on the tank, as drawn in the garage mockup. */
export type Slot = 'armour' | 'engine' | 'barrel' | 'tracks' | 'jammer' | 'plough';
export const SLOTS: Slot[] = ['armour', 'engine', 'barrel', 'tracks', 'jammer', 'plough'];

/** Stat changes a part gives; each is a small integer step (the garage shows them as +1 / -1 pips). */
export interface PartStats {
  armour?: number; // +1 = +1 max armour
  speed?: number; // +1 = +8% move speed
  firepower?: number; // +1 = shells break steel at +2; +1 more damage to armoured tanks at +1
  reload?: number; // +1 = -10% reload time
}

export interface PartDef {
  id: string;
  slot: Slot;
  name: string; // uppercase, pixel font safe
  stats: PartStats;
  /** one line of flavour, dry humour, uppercase */
  desc: string;
  /** stripped from an enemy tank */
  captured?: boolean;
  /** scrap paid when stripping it back down (halved 2026-11-18 with the rest of the scrap economy) */
  scrap: number;
}

/** What is bolted on: part id per slot. */
export type Loadout = Partial<Record<Slot, string>>;

export interface RunState {
  version: 1;
  /** seed of the run: region seeds derive from it */
  seed: number;
  /** index of the region being played (0 = Farmland) */
  region: number;
  scrap: number;
  /** part ids in the parts bin (not fitted) */
  bin: string[];
  /** per player (0, 1) */
  fitted: [Loadout, Loadout];
  /** ability charges, shared: drone, ambush, recon, patch */
  charges: number[];
  vet: [number, number];
  vetXp: [number, number];
  /** retreats so far in the whole run (defeats) */
  retreats: number;
  /** retreats in the current region: each makes the next attempt a little easier; back to 0 when a region is cleared */
  regionRetreats?: number;
  /** Phase 3: crew recruited so far (see crew.ts); optional so older saves still load */
  crew?: CrewState[];
  /** Phase 5 story (story.ts): scenes seen, answers given; optional so older saves still load */
  story?: StoryState;
  /** Phase 5: totals over the whole run, added at every region clear (the CAMPAIGN COMPLETE card) */
  totals?: RunTotals;
  /** Phase 5: the final boss fell and the ending was shown; the run carries on as endless LIBERATION mode */
  completed?: boolean;
  /** Phase 5 events hook: map events seen / resolved per region index ("0", "1", ...); see events.ts */
  events?: Record<string, { seen: string[]; done: string[] }>;
  /** The region in progress: towns freed (in the order freed) and depots destroyed, kept by CONTINUE and retreats
   * (the boss restarts). Ignored unless `region` matches RunState.region; cleared when a region is cleared. Optional
   * so older saves still load. */
  progress?: RegionProgress;
}

/** What stays done in a region between attempts and sessions (save.ts restoreProgress / syncRun). */
export interface RegionProgress {
  region: number;
  /** freed town names, oldest first (the last one is the checkpoint) */
  towns: string[];
  /** destroyed depot names */
  depots: string[];
}

/** Phase 5 story progress. */
export interface StoryState {
  /** the opening scene (how the crew got BABUSYA) was shown */
  opened?: boolean;
  /** regions whose briefing was answered (index = region) */
  briefed: number[];
  /** answer picked per briefed region ("0".."4" -> choice index) */
  answers: Record<string, number>;
  /** the last ASK FIRST hint, repeated on the radio when its region starts */
  hint?: { region: number; who: string; text: string };
  /** the region cleared last, for the next briefing's kicker ("REGION I FREED · 3 TOWNS · 2 DEPOTS · BOSS DOWN") */
  last?: { region: number; towns: number; depots: number; boss: boolean };
}

export interface RunTotals {
  regions: number;
  towns: number;
  depots: number;
  bosses: number;
  scrap: number;
  parts: number;
  kills: number;
}

/** A recruited crew member: id from the crew catalogue (crew.ts), level and XP toward the next. */
export interface CrewState {
  id: string;
  lv: number;
  xp: number;
}

export function newRun(seed: number): RunState {
  return {
    version: 1, seed, region: 0, scrap: 0, bin: [], fitted: [{}, {}], charges: [0, 0, 0, 2],
    vet: [0, 0], vetXp: [0, 0], retreats: 0,
  };
}
