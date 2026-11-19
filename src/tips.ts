// First-play prompts (M5): four one-time hints in the toast style, each shown the first time it applies in a
// campaign region, then never again on this browser. Seen ids live in their own localStorage key, so saves and
// settings are untouched. The app calls step() once per play update (not under ?autoplay, never in the sims).
import type { World } from './game/world';

export const TIPS_KEY = 'tank1990neo.tips';
/** Updates between two prompts, so they never stack. */
const GAP = 60 * 4;
/** How long a prompt stays up (ms). */
const SHOW_MS = 4200;

type TipId = 'move' | 'flag' | 'patch' | 'map';
type Toast = (text: string, kind: 'power' | 'warn' | 'info', icon?: number, ms?: number) => void;

function load(): Set<string> {
  try {
    const v = JSON.parse(localStorage.getItem(TIPS_KEY) ?? '[]');
    return new Set(Array.isArray(v) ? v.filter((x) => typeof x === 'string') : []);
  } catch {
    return new Set();
  }
}

export class Tips {
  private seen = load();
  private last = -GAP;
  private world: World | null = null;

  constructor(private toast: Toast) {}

  /** One play update of a campaign region. pad = a gamepad is in use (the move, patch and map texts name its buttons). */
  step(w: World, pad: boolean): void {
    if (w !== this.world) {
      this.world = w; // frames count from 0 in each region
      this.last = -GAP;
    }
    if (this.seen.size >= 4 || w.frame - this.last < GAP) return;
    const ps = w.livePlayers();
    if (!ps.length) return;
    // 1: straight away (once the region is under way)
    if (w.frame >= 90 && this.show(w, 'move', pad ? 'STICK MOVES · A FIRES' : 'ARROWS MOVE · SPACE FIRES')) return;
    if (!this.seen.has('move')) return;
    // 2: the first time a tank drives into a town the enemy holds
    const inTown = w.towns.some((t) => !t.freed && ps.some((p) => p.cx >= t.rect[0] && p.cx < t.rect[0] + t.rect[2] && p.cy >= t.rect[1] && p.cy < t.rect[1] + t.rect[3]));
    if (inTown && this.show(w, 'flag', 'PARK AT THE FLAG TO FREE THE VILLAGE')) return;
    // 3: the first time a tank's armour drops below half (while its patch is ready: it has a 15 s cooldown)
    if (ps.some((p) => p.armourMax > 0 && p.armour < p.armourMax / 2 && w.patchWait(p.player) === 0) && this.show(w, 'patch', pad ? 'LB + DOWN PATCHES ARMOUR' : '4 PATCHES ARMOUR')) return;
    // 4: a while in, once the player knows the ground
    if (w.frame >= 60 * 25) this.show(w, 'map', pad ? 'VIEW: MAP' : 'TAB: MAP');
  }

  private show(w: World, id: TipId, text: string): boolean {
    if (this.seen.has(id)) return false;
    this.seen.add(id);
    this.last = w.frame;
    this.toast(text, 'info', -1, SHOW_MS);
    try {
      localStorage.setItem(TIPS_KEY, JSON.stringify([...this.seen]));
    } catch {
      // private mode: the prompts just come back next time
    }
    return true;
  }
}
