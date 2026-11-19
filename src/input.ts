const PREVENT = new Set(['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Space', 'Enter', 'Tab']);

export interface PadState {
  dir: number;
  fire: boolean;
  start: boolean;
  startPressed: boolean;
  firePressed: boolean;
  dirPressed: number;
  /** campaign (abilityPad on): LB or RB held + d-pad up/left/right/down pressed = ability 1/2/3/4, else 0 */
  ability: number;
  /** Back / View / Select pressed this poll (campaign: opens the big map) */
  selectPressed: boolean;
}

/** d-pad direction (0 up, 1 right, 2 down, 3 left) to ability 1-4: up drone, left ambush, right recon, down patch */
const PAD_ABILITY = [1, 3, 4, 2];

export class Input {
  down = new Set<string>();
  pressed = new Set<string>();
  private stamp = new Map<string, number>();
  private n = 0;
  pads: PadState[] = [];
  /** Campaign: while a shoulder button is held the d-pad picks abilities instead of driving (the stick still drives). */
  abilityPad = false;
  private prevPad: { fire: boolean; start: boolean; dir: number; adir: number; select: boolean }[] = [];

  constructor() {
    window.addEventListener('keydown', (e) => {
      if (!e.repeat) {
        this.pressed.add(e.code);
        this.stamp.set(e.code, ++this.n);
      }
      this.down.add(e.code);
      if (PREVENT.has(e.code)) e.preventDefault();
    });
    // keyup runs in the capture phase, ahead of the modal cards (ui-story / ui-garage), which swallow key events
    // with stopImmediatePropagation: a key released while a card was open used to stay "held" for ever
    window.addEventListener('keyup', (e) => this.down.delete(e.code), true);
    window.addEventListener('blur', () => this.releaseAll());
    document.addEventListener('visibilitychange', () => { if (document.hidden) this.releaseAll(); });
  }

  /** Forget every held key and pad edge (a modal card opened or closed, or the window lost focus). */
  releaseAll(): void {
    this.down.clear();
    this.pressed.clear();
  }

  poll(): void {
    const pads = navigator.getGamepads ? navigator.getGamepads() : [];
    this.pads = [];
    let k = 0;
    for (const gp of pads) {
      if (!gp || !gp.connected) continue;
      const b = (i: number) => !!gp.buttons[i]?.pressed;
      const ax = gp.axes[0] ?? 0;
      const ay = gp.axes[1] ?? 0;
      let dir = -1;
      if (b(12) || ay < -0.5) dir = 0;
      else if (b(13) || ay > 0.5) dir = 2;
      else if (b(14) || ax < -0.5) dir = 3;
      else if (b(15) || ax > 0.5) dir = 1;
      if ((b(12) || b(13)) && (b(14) || b(15))) dir = b(12) ? 0 : 2;
      const fire = b(0) || b(1) || b(2) || b(3) || b(7);
      const start = b(9);
      const select = b(8);
      const prev = this.prevPad[k] ?? { fire: false, start: false, dir: -1, adir: -1, select: false };
      // shoulder + d-pad = ability (campaign only); the d-pad then doesn't drive, the stick still does
      let adir = -1;
      if (this.abilityPad && (b(4) || b(5))) {
        adir = b(12) ? 0 : b(15) ? 1 : b(13) ? 2 : b(14) ? 3 : -1;
        dir = ay < -0.5 ? 0 : ay > 0.5 ? 2 : ax < -0.5 ? 3 : ax > 0.5 ? 1 : -1;
      }
      const ability = adir >= 0 && adir !== prev.adir ? PAD_ABILITY[adir] : 0;
      this.pads.push({
        dir, fire, start, startPressed: start && !prev.start, firePressed: fire && !prev.fire, dirPressed: dir !== prev.dir ? dir : -1,
        ability, selectPressed: select && !prev.select,
      });
      this.prevPad[k] = { fire, start, dir, adir, select };
      k++;
    }
  }

  endFrame(): void {
    this.pressed.clear();
  }

  hit(...codes: string[]): boolean {
    return codes.some((c) => this.pressed.has(c));
  }

  held(...codes: string[]): boolean {
    return codes.some((c) => this.down.has(c));
  }

  /** Most recently pressed of the held direction keys. codes = [up, right, down, left] lists. */
  dir(map: string[][]): number {
    let best = -1;
    let bestStamp = -1;
    map.forEach((codes, d) => {
      for (const c of codes) {
        if (this.down.has(c)) {
          const s = this.stamp.get(c) ?? 0;
          if (s > bestStamp) {
            bestStamp = s;
            best = d;
          }
        }
      }
    });
    return best;
  }

  anyPad(): PadState | null {
    return this.pads[0] ?? null;
  }

  /** Menu navigation from keyboard or any pad: 0 up, 1 right, 2 down, 3 left, -1 none. */
  navDir(): number {
    if (this.hit('ArrowUp', 'KeyW')) return 0;
    if (this.hit('ArrowRight', 'KeyD')) return 1;
    if (this.hit('ArrowDown', 'KeyS', 'Tab')) return 2;
    if (this.hit('ArrowLeft', 'KeyA')) return 3;
    for (const p of this.pads) if (p.dirPressed >= 0) return p.dirPressed;
    return -1;
  }

  ok(): boolean {
    return this.hit('Enter', 'Space', 'NumpadEnter') || this.pads.some((p) => p.firePressed || p.startPressed);
  }

  back(): boolean {
    return this.hit('Escape', 'Backspace');
  }
}
