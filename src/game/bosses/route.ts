// Phase 4: shared pieces of the route-bound bosses (bosses/train.ts, bosses/flagship.ts): a polyline route, parts in
// a rotated W x H frame, a barrage of incoming rounds with warning marks on the ground, and a base class with the
// reveal / HUD / radio / reward rules they share with GRINDER (boss.ts). The small helpers live in common.ts.
import type { Renderer } from '../../gl/renderer';
import { BOSS } from '../boss';
import { BRICK, DOWN, EMPTY, TREES } from '../constants';
import { Tank, type Bullet, type RGB, type World } from '../world';
import { EPS, clamp, domDir, overlap, rand } from './common';
import type { BossExtras, BossLike, BossPartLike, BossState } from './types';

export { EPS, clamp, domDir, overlap, rand };
export const INF = 0x3fffffff;

// ---------- a W x H part frame (up-facing: front at y = 0), turned by quarter turns ----------
/** Local (lx, ly) of an up-facing W x H frame to the top-left of its box turned `d` quarter turns clockwise. */
export function rotFrame(lx: number, ly: number, W: number, H: number, d: number): [number, number] {
  switch (d & 3) {
    case 1: return [H - ly, lx];
    case 2: return [W - lx, H - ly];
    case 3: return [ly, W - lx];
    default: return [lx, ly];
  }
}

/** Inverse of rotFrame: a point in the turned box (relative to its top-left) to the up-facing frame. */
export function unrotFrame(qx: number, qy: number, W: number, H: number, d: number): [number, number] {
  switch (d & 3) {
    case 1: return [qy, H - qx];
    case 2: return [W - qx, H - qy];
    case 3: return [W - qy, qx];
    default: return [qx, qy];
  }
}

/** Size of the turned box. */
export const boxSize = (W: number, H: number, d: number): [number, number] => (d & 1 ? [H, W] : [W, H]);

/** A local rect of the frame to world (x, y, w, h), given the turned box's top-left (bx, by). */
export function frameRect(bx: number, by: number, W: number, H: number, d: number, r: [number, number, number, number]): [number, number, number, number] {
  const [ax, ay] = rotFrame(r[0], r[1], W, H, d);
  const [cx, cy] = rotFrame(r[0] + r[2], r[1] + r[3], W, H, d);
  return [bx + Math.min(ax, cx), by + Math.min(ay, cy), Math.abs(cx - ax), Math.abs(cy - ay)];
}

// ---------- a route along a px polyline ----------
export class Poly {
  pts: [number, number][];
  /** arc length at each point */
  cum: number[];
  len: number;

  constructor(pts: [number, number][]) {
    this.pts = [];
    for (const p of pts) {
      const q = this.pts[this.pts.length - 1];
      if (!q || Math.hypot(p[0] - q[0], p[1] - q[1]) > 0.5) this.pts.push([p[0], p[1]]);
    }
    if (this.pts.length < 2) this.pts.push([this.pts[0][0] + 1, this.pts[0][1]]);
    this.cum = [0];
    for (let i = 1; i < this.pts.length; i++) {
      const a = this.pts[i - 1];
      const b = this.pts[i];
      this.cum.push(this.cum[i - 1] + Math.hypot(b[0] - a[0], b[1] - a[1]));
    }
    this.len = this.cum[this.cum.length - 1];
  }

  /** Segment index holding arc length s. */
  seg(s: number): number {
    const c = this.cum;
    let lo = 0;
    let hi = c.length - 2;
    while (lo < hi) {
      const m = (lo + hi + 1) >> 1;
      if (c[m] <= s) lo = m;
      else hi = m - 1;
    }
    return lo;
  }

  /** Point at arc length s (clamped to the ends). */
  at(s: number): [number, number] {
    s = clamp(s, 0, this.len);
    const i = this.seg(s);
    const a = this.pts[i];
    const b = this.pts[i + 1];
    const l = this.cum[i + 1] - this.cum[i];
    const k = l > 0 ? (s - this.cum[i]) / l : 0;
    return [a[0] + (b[0] - a[0]) * k, a[1] + (b[1] - a[1]) * k];
  }

  /** Unit direction of the route at s. */
  tangent(s: number): [number, number] {
    const i = this.seg(clamp(s, 0, this.len));
    const a = this.pts[i];
    const b = this.pts[i + 1];
    const l = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1;
    return [(b[0] - a[0]) / l, (b[1] - a[1]) / l];
  }

  /** Arc length of the route point nearest (x, y), and the distance to it. */
  nearest(x: number, y: number): [number, number] {
    let bs = 0;
    let bd = Infinity;
    for (let i = 0; i < this.pts.length - 1; i++) {
      const a = this.pts[i];
      const b = this.pts[i + 1];
      const vx = b[0] - a[0];
      const vy = b[1] - a[1];
      const l2 = vx * vx + vy * vy || 1;
      const k = clamp(((x - a[0]) * vx + (y - a[1]) * vy) / l2, 0, 1);
      const d = Math.hypot(a[0] + vx * k - x, a[1] + vy * k - y);
      if (d < bd) { bd = d; bs = this.cum[i] + k * Math.sqrt(l2); }
    }
    return [bs, bd];
  }
}

// ---------- incoming rounds with warning marks (deck-gun shells, rocket salvos) ----------
export interface Incoming {
  /** target on the ground */
  x: number;
  y: number;
  /** where it was fired from */
  fx: number;
  fy: number;
  /** frame the warning mark appears / it leaves the launcher / it lands */
  appear: number;
  launch: number;
  at: number;
  /** 0 = shell (high arc, red ring), 1 = rocket (low arc, orange brackets, smoke trail) */
  kind: number;
  /** danger radius and armour it takes off a player inside it */
  r: number;
  dmg: number;
  done: boolean;
  fired: boolean;
}

export class Barrage {
  list: Incoming[] = [];
  stats = { fired: 0, landed: 0, hits: 0, minWarn: Infinity };

  constructor(private w: World, private proxy: Tank) {}

  add(x: number, y: number, fx: number, fy: number, appear: number, warn: number, flight: number, kind: number, r: number, dmg: number): void {
    const w = this.w;
    this.list.push({
      x: clamp(x, 4, w.pxW - 4), y: clamp(y, 4, w.pxH - 4), fx, fy, appear, launch: appear + Math.max(0, warn - flight), at: appear + warn,
      kind, r, dmg, done: false, fired: false,
    });
    this.stats.minWarn = Math.min(this.stats.minWarn, warn);
  }

  get busy(): boolean {
    return this.list.length > 0;
  }

  /** Launch and land what is due; `onLaunch` is told when a round leaves its launcher. */
  update(onLaunch?: (s: Incoming) => void): void {
    if (!this.list.length) return;
    const w = this.w;
    const f = w.frame;
    for (const s of this.list) {
      if (s.done) continue;
      if (!s.fired && f >= s.launch) {
        s.fired = true;
        this.stats.fired++;
        onLaunch?.(s);
      }
      if (s.kind === 0 && f === s.at - 54) w.snd('trick-whistle', s.x, 1);
      if (s.kind === 1 && s.fired && f < s.at && (f - s.launch) % 3 === 0) {
        const [px, py] = this.pos(s, f);
        w.parts.push({ x: px, y: py, z: 10, vx: (rand() - 0.5) * 0.2, vy: (rand() - 0.5) * 0.2, vz: 0, life: 0, max: 30, col: [0.62, 0.6, 0.56], kind: 2, r: 2 });
      }
      if (f >= s.at) {
        s.done = true;
        this.land(s);
      }
    }
    this.list = this.list.filter((s) => !s.done);
  }

  /** Ground position of a round in flight (frame f). */
  pos(s: Incoming, f: number): [number, number] {
    const k = clamp((f - s.launch) / Math.max(1, s.at - s.launch), 0, 1);
    return [s.fx + (s.x - s.fx) * k, s.fy + (s.y - s.fy) * k];
  }

  private land(s: Incoming): void {
    const w = this.w;
    this.stats.landed++;
    const { x, y } = s;
    w.explode(x, y, true);
    w.decals.push({ k: 1, x, y, r: s.r * 0.8, col: [0.03, 0.025, 0.02], a: 0.55 });
    w.snd('bigexplode', x, 0.9);
    for (const p of w.livePlayers()) {
      if (Math.hypot(p.cx - x, p.cy - y) > s.r) continue;
      w.hitPlayer(p, this.proxy, s.dmg);
      this.stats.hits++;
    }
    const m = w.map;
    const rr = 10;
    for (let cy = Math.floor((y - rr) / 4); cy <= Math.floor((y + rr) / 4); cy++) {
      for (let cx = Math.floor((x - rr) / 4); cx <= Math.floor((x + rr) / 4); cx++) {
        const c = m.at(cx, cy);
        if ((c !== BRICK && c !== TREES) || Math.hypot(cx * 4 + 2 - x, cy * 4 + 2 - y) > rr) continue;
        if (c === TREES && rand() < 0.6) continue;
        m.set(cx, cy, EMPTY);
        if (rand() < 0.5) w.debris(cx * 4 + 2, cy * 4 + 2, Math.floor(rand() * 4));
      }
    }
  }

  /** Warning marks (unlit, so they read at night) and the rounds in flight. */
  draw(r: Renderer, ox: number, oy: number): void {
    const f = this.w.frame;
    for (const s of this.list) {
      if (f < s.appear) continue;
      const k = clamp((f - s.appear) / Math.max(1, s.at - s.appear), 0, 1);
      const sx = ox + s.x;
      const sy = oy + s.y;
      const on = sx > -30 && sy > -30 && sx < r.nw + 30 && sy < r.nh + 30;
      const period = k < 0.5 ? 16 : k < 0.8 ? 8 : 4;
      const lit = (f - s.appear) % period < period / 2;
      const a = lit ? 0.95 : 0.4;
      if (on && s.kind === 0) {
        // a red ring growing to the danger radius, a cross in the middle
        const col: RGB = [1, 0.22 + 0.2 * (1 - k), 0.12];
        const rad = 5 + (s.r - 5) * Math.min(1, k * 1.6);
        const n = 32;
        for (let i = 0; i < n; i++) {
          if (!lit && i & 1) continue;
          const ang = (i / n) * Math.PI * 2 + k * 0.6;
          r.ovRect(Math.round(sx + Math.cos(ang) * rad), Math.round(sy + Math.sin(ang) * rad), 1, 1, col, a);
        }
        r.ovRect(Math.round(sx) - 2, Math.round(sy), 5, 1, col, a * 0.8);
        r.ovRect(Math.round(sx), Math.round(sy) - 2, 1, 5, col, a * 0.8);
        r.glow(sx, sy, rad, [1, 0.2, 0.1], 0.05 + 0.12 * k * (lit ? 1 : 0.5));
      } else if (on) {
        // rockets: four orange corner brackets closing in on the spot, an X in the middle
        const col: RGB = [1, 0.55 + 0.25 * (1 - k), 0.1];
        const h = Math.round(s.r + 4 - 4 * k);
        const X = Math.round(sx);
        const Y = Math.round(sy);
        for (const [dx, dy] of [[-1, -1], [1, -1], [-1, 1], [1, 1]]) {
          const cx = X + dx * h;
          const cy = Y + dy * h;
          r.ovRect(dx < 0 ? cx : cx - 3, cy, 4, 1, col, a);
          r.ovRect(cx, dy < 0 ? cy : cy - 3, 1, 4, col, a);
        }
        for (let i = -2; i <= 2; i++) {
          r.ovRect(X + i, Y + i, 1, 1, col, a * 0.85);
          r.ovRect(X + i, Y - i, 1, 1, col, a * 0.85);
        }
        r.glow(sx, sy, s.r, [1, 0.4, 0.1], 0.05 + 0.12 * k * (lit ? 1 : 0.5));
      }
      // the round in flight: a hot dot on an arc, its shadow on the ground
      if (!s.fired || f >= s.at) continue;
      const t = clamp((f - s.launch) / Math.max(1, s.at - s.launch), 0, 1);
      const [gx, gy] = this.pos(s, f);
      const dist = Math.hypot(s.x - s.fx, s.y - s.fy);
      const z = Math.sin(Math.PI * t) * Math.min(s.kind === 0 ? 70 : 28, dist * (s.kind === 0 ? 0.45 : 0.25));
      const px = ox + gx;
      const py = oy + gy - z;
      if (px < -40 || py < -60 || px > r.nw + 40 || py > r.nh + 40) continue;
      r.ovRect(Math.round(ox + gx) - 1, Math.round(oy + gy), 3, 1, [0, 0, 0], 0.35);
      if (s.kind === 0) {
        r.glow(px, py, 3, [1, 0.7, 0.4], 2.4);
        r.fxRect(Math.round(px) - 1, Math.round(py) - 1, 2, 2, [1, 0.85, 0.6], 3);
      } else {
        r.glow(px, py, 4, [1, 0.6, 0.25], 2.8);
        r.fxRect(Math.round(px) - 1, Math.round(py) - 1, 2, 2, [1, 0.9, 0.6], 3);
        r.light(px, py, 10, 34, 1.0, 0.55, 0.2, false);
      }
    }
  }
}

// ---------- the shared rules ----------
export const WHO = 'INTERCEPT';

/** Tells and reloads respect World.ease (retreats): tells x (1 + ease), gaps x (1 + 2 ease), as tricks.ts does. A
 * region below 0 ease only shortens the gaps (to -0.2): a tell never gets shorter than designed. */
export const tellT = (w: World, n: number) => Math.round(n * (1 + clamp(Number.isFinite(w.ease) ? w.ease : 0, 0, 0.5)));
export const gapT = (w: World, n: number) => Math.round(n * (1 + 2 * clamp(Number.isFinite(w.ease) ? w.ease : 0, -0.2, 0.5)));

export abstract class BossBase implements BossLike, BossExtras {
  abstract readonly kind: string;
  abstract readonly name: string;
  abstract readonly title: string;
  x = 0;
  y = 0;
  dir = DOWN;
  state: BossState = 'hidden';
  revealed = false;
  parts: BossPartLike[] = [];
  /** the region intro card's boss line, after "FREE 3 VILLAGES TO " */
  abstract readonly goal: string;
  hitT = 0;
  /** scrap for the kill (TRAIN.scrap, FLAG.scrap) */
  protected abstract readonly scrapReward: number;
  /** the town nearest it at the reveal (for the radio) */
  lairNear = '';
  target: Tank | null = null;
  lastSeen = -INF;
  lastAt: [number, number] | null = null;
  deathT = 0;
  deadT = 0;
  killer = -1;
  /** owner of the boss's rounds (never in w.enemies) */
  readonly proxy: Tank;
  log: string[] = [];
  protected lastPop = -INF;
  protected hinted = false;

  constructor(protected w: World) {
    const t = new Tank();
    t.player = -1;
    t.etype = 3;
    this.proxy = t;
  }

  abstract get cx(): number;
  abstract get cy(): number;
  abstract get turret(): BossPartLike;
  abstract exposed(): boolean;
  abstract overlaps(x: number, y: number, w: number, h: number): boolean;
  abstract blocks(t: Tank, x: number, y: number): boolean;
  abstract update(): void;
  abstract reveal(): void;
  abstract kill(pi?: number): void;
  abstract bulletHit(b: Bullet): boolean;
  abstract droneHit(x: number, y: number, dmg: number, pi: number): boolean;
  abstract rocketHit(x: number, y: number, dir: number, dmg: number, pi: number): boolean;
  abstract aimPoint(): [number, number];
  abstract draw(r: Renderer, ox: number, oy: number, time: number, head: number): void;
  abstract fluid(r: Renderer, ox: number, oy: number, f: number, time: number): void;
  /** px from (x, y) to the nearest bit of the boss */
  abstract distTo(x: number, y: number): number;

  get present(): boolean { return this.state !== 'hidden'; }
  get alive(): boolean { return this.state === 'lair' || this.state === 'hunt'; }
  cleared(): boolean { return this.state === 'dead' && this.deadT > 90; }

  townsToReveal(): number {
    const need = Math.min(BOSS.reveal, this.w.towns.length);
    return Math.max(0, need - this.w.towns.filter((t) => t.freed).length);
  }

  hudShown(): boolean {
    if (!this.present) return false;
    if (this.state === 'dead') return this.deadT < 60 * 4;
    if (this.state === 'dying' || this.state === 'hunt') return true;
    return this.w.livePlayers().some((p) => this.distTo(p.cx, p.cy) < 300);
  }

  /** The town nearest (x, y). */
  protected townNear(x: number, y: number): string {
    let bd = Infinity;
    let name = '';
    for (const t of this.w.towns) {
      const d = Math.hypot(t.cx - x, t.cy - y);
      if (d < bd) { bd = d; name = t.name; }
    }
    return name;
  }

  /** Sees the nearest player within `range` of it (trees hide one beyond BOSS.treeSight). */
  protected perceive(range: number): void {
    const w = this.w;
    let best: Tank | null = null;
    let bd = Infinity;
    for (const p of w.livePlayers()) {
      const d = this.distTo(p.cx, p.cy);
      if (d > range || d >= bd) continue;
      if (d > BOSS.treeSight && this.inTrees(p) && !(this.target === p && w.frame - this.lastSeen < 120)) continue;
      best = p;
      bd = d;
    }
    if (best) {
      this.target = best;
      this.lastSeen = w.frame;
      this.lastAt = [best.cx, best.cy];
    } else if (this.target && (!this.target.alive || w.frame - this.lastSeen > 60 * 6)) {
      this.target = null;
    }
  }

  protected inTrees(p: Tank): boolean {
    const m = this.w.map;
    const cx = Math.round(p.x / 4);
    const cy = Math.round(p.y / 4);
    let n = 0;
    for (let y = cy; y < cy + 4; y++) for (let x = cx; x < cx + 4; x++) if (m.at(x, y) === TREES) n++;
    return n >= 8;
  }

  /** Damage of a player's shell (the same rule as GRINDER). */
  protected shellDmg(owner: Tank): number {
    return 1 + (owner.firepower >= 1 ? 1 : 0);
  }

  /** A hit on a part: sparks, flash, popup, the part's and the body's flash. */
  protected hitFx(wx: number, wy: number, dmg: number): void {
    const w = this.w;
    this.hitT = 3;
    w.sparks(wx, wy, 6 + dmg * 2, [1, 0.8, 0.45]);
    w.flashes.push({ x: wx, y: wy, t: 0, max: 10, r: 40 + dmg * 6, col: [1, 0.6, 0.3], z: 12 });
    w.booms.push({ x: wx, y: wy, big: false, t: 0 });
    w.shake = Math.max(w.shake, 1 + dmg * 0.3);
    w.snd('armor', wx, 1);
    w.popups.push({ x: wx, y: wy - 8, text: `-${dmg}`, t: 0, col: [1, 0.6, 0.3] });
  }

  /** A shell that can't get through: sparks, a ricochet sound, the odd NO PEN popup and a hint once. */
  protected noPenFx(wx: number, wy: number, hint: string, text = 'NO PEN'): void {
    const w = this.w;
    w.sparks(wx, wy, 7, [1, 0.95, 0.8]);
    w.flashes.push({ x: wx, y: wy, t: 0, max: 6, r: 26, col: [1, 0.9, 0.7], z: 10 });
    w.snd('steel', wx, 1);
    if (w.frame - this.lastPop > 90) {
      this.lastPop = w.frame;
      w.popups.push({ x: wx, y: wy - 8, text, t: 0, col: [0.75, 0.8, 0.88] });
    }
    if (!this.hinted) {
      this.hinted = true;
      w.note(hint, 'info');
    }
  }

  /** A weak point gone: blast, debris, +BOSS.partScrap, a toast, veterancy. */
  protected partBlast(cx: number, cy: number, name: string, pi: number): void {
    const w = this.w;
    w.explode(cx, cy, true);
    w.shocks.push({ x: cx, y: cy, t: 0, max: 26, size: 0.9 });
    w.shake = Math.max(w.shake, 4);
    w.snd('boss-part', cx, 0.8);
    for (let i = 0; i < 10; i++) {
      const a = rand() * Math.PI * 2;
      const s = 0.5 + rand() * 1.4;
      w.parts.push({
        x: cx, y: cy, z: 7, vx: Math.cos(a) * s, vy: Math.sin(a) * s, vz: 1 + rand() * 1.5,
        life: 0, max: 160, col: [0.36, 0.38, 0.32], kind: 0, r: 1,
      });
    }
    w.scrap += BOSS.partScrap;
    w.popups.push({ x: cx, y: cy - 14, text: `+${BOSS.partScrap} SCRAP`, t: 0, col: [1, 0.85, 0.4] });
    w.note(`${name} DESTROYED`, 'power');
    if (pi >= 0) w.addVetXp(pi, 0.25);
    this.hinted = false;
  }

  /** The kill: +scrapReward, BOSS.captured parts, the toast, veterancy (stats.bossScrap for app.ts's tally). */
  protected payout(x: number, y: number): void {
    const w = this.w;
    w.stats.boss++;
    w.stats.bossScrap += this.scrapReward;
    w.scrap += this.scrapReward;
    w.popups.push({ x, y: y - 30, text: `+${this.scrapReward} SCRAP`, t: 0, col: [1, 0.85, 0.4] });
    for (let i = 0; i < BOSS.captured; i++) {
      const id = w.rollFound(true);
      w.partsFound++;
      w.popups.push({ x, y: y - 20 + i * 8, text: id ? '+CAPTURED PART' : '+1 PART', t: 0, col: [0.6, 0.9, 1] });
    }
    w.snd('part', x, 0.9);
    w.note(`${this.name} DESTROYED`, 'power');
    if (this.killer >= 0) w.addVetXp(this.killer, 1);
  }

  protected smokePuff(x: number, y: number, heavy: boolean, z = 10): void {
    this.w.parts.push({
      x: x + (rand() - 0.5) * 4, y: y + (rand() - 0.5) * 4, z,
      vx: (rand() - 0.5) * 0.2, vy: -0.2 - rand() * 0.2, vz: 0,
      life: 0, max: heavy ? 110 : 70, col: heavy ? [0.09, 0.085, 0.08] : [0.2, 0.19, 0.18], kind: 2, r: (heavy ? 4.5 : 3) + rand() * 3,
    });
  }

  protected say(who: string, text: string): void {
    const r = this.w.radio;
    if (r.length && r[r.length - 1].text === text) return;
    r.push({ who, text });
    if (r.length > 20) r.shift();
    this.logEv(`RADIO ${who} ${text}`);
  }

  protected logEv(s: string): void {
    this.log.push(`${String(this.w.frame).padStart(6)} ${s}`);
    if (this.log.length > 500) this.log.splice(0, 100);
  }
}
