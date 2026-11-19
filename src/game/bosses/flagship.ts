// Phase 4: the Region 3 boss, "MORAY" (invented callsign), a river flagship (CAMPAIGN.md "Regions and bosses":
// shells the banks; drones and ambushes are the counters).
//
// A 48 x 24 px gunboat on the main channel (RegionSpec.river). It waits at its berth until a player comes near (or
// FLAG.wakeAfter passes), then patrols up and down the river, turning round at each end. When it sees a player on a
// bank within FLAG.shellRange it drops anchor and shells them: a red warning ring on the ground for every round,
// FLAG.shellWarn frames (1.8 s, longer when eased) before it lands, the first on the player, the rest scattered
// round them (or round where they were last seen); 3 armour inside a ring. A deck machine gun on the bridge roof
// bursts at a close player in line.
// Weak points: two deck guns (fore and aft), the bridge (losing it blinds the shelling: no round on the player and a
// wider spread) with the deck MG on its roof, and the engine room at the stern: armoured until a deck gun is gone,
// and its loss sinks the boat. Shells fall short across the water: a player shell only reaches it from within
// FLAG.reach px (bridges, near banks). FPV drones hit any part from above for BOSS.droneMul x damage, the engine room
// included; ambush squads on the banks fire rockets at it (abilities.ts squads target bosses) and a rocket that
// finds no weak point bursts on the nearest one. Smoke from hits, a wake while it moves, a sinking death.
import type { Renderer } from '../../gl/renderer';
import { BOSS } from '../boss';
import { DX, DY, MAT_STD, ROAD, WATER } from '../constants';
import { type Bullet, type RGB, type Tank, type World } from '../world';
import {
  BossBase, Barrage, EPS, INF, Poly, WHO, boxSize, clamp, domDir, frameRect, gapT, overlap, rand, rotFrame, tellT,
  unrotFrame, type Incoming,
} from './route';
import { QUARTER, angOf, angOfDir, clearOf, dirOfAng, lineOff, shellAt, slewTo, snap8, vecOf } from './aim';
import type { BossPartLike } from './types';

/** Tuning, "easy". Distances in px, times in frames (60 per second). */
export const FLAG = {
  /** scrap for the kill (was BOSS.scrap, 500; 2026-11-18 scrap economy) */
  scrap: 50,
  /** the hull frame: width across, length bow to stern */
  W: 24,
  H: 48,
  speed: 0.32,
  acc: 0.005,
  /** frames per quarter turn when it turns round */
  turnPause: 40,
  margin: 8,
  sight: 250,
  wake: 220,
  wakeAfter: 60 * 25,
  hp: { gun: 6, bridge: 8, mg: 3, engine: 16 }, // gun was 8, engine 20: the fight ran 7 minutes for the sim's bot
  /** player shells from further away than this splash short */
  reach: 120,
  // shelling
  shellRange: 250,
  shellGap: 60 * 10, // was 7 s, then 8 (2026-11-18: with the patch cooldown)
  shellWarn: 110,
  shellStagger: 16,
  shellR: 12,
  shellDmg: 2, // was 3
  perGun: 2,
  spread: [16, 26],
  blindSpread: [22, 42],
  /** frames at anchor before the first round, and after the last before it moves on */
  settle: 40,
  after: 100,
  gunTurn: 28,
  // deck MG
  mgRange: 110,
  mgDmg: 1,
  mgBurst: 4, // was 5
  mgGap: 7,
  mgPause: 150, // was 110 (8-direction bursts, 2026-10-16)
  mgSpeed: 3.2,
  mgSlack: 9,
  /** chance the deck MG brings down an FPV drone diving on the ship while it lives (the train's AA car does 0.35);
   * it used to have no answer to drones, and four of them sank it */
  aaChance: 0.5,
  escort: [0], // was [0, 1]
  dieFrames: 170,
  tellGap: 60 * 10,
};

type FKind = 'gun' | 'bridge' | 'mg' | 'turret';
interface FPart extends BossPartLike {
  kind: FKind;
  /** hit box in the up-facing 24 x 48 frame */
  rect: [number, number, number, number];
  /** turning gun / mount: facing (nearest quarter of ta), turn timer, recoil */
  tdir: number;
  /** its angle as drawn, radians clockwise from up: deck guns slew toward their aim, the MG points its burst */
  ta: number;
  turnT: number;
  recoil: number;
}

export class FlagshipBoss extends BossBase {
  readonly kind = 'flagship';
  protected readonly scrapReward = FLAG.scrap;
  readonly name = 'MORAY';
  readonly title = 'RIVER FLAGSHIP';
  readonly goal = 'FIND THEIR RIVER FLAGSHIP · SINK IT';
  poly: Poly;
  /** arc length of the hull's centre on the river line */
  S = 0;
  sMin = 0;
  sMax = 0;
  dirS = 1;
  v = 0;
  mode: 'berth' | 'patrol' | 'anchor' | 'turn' = 'berth';
  modeT = 0;
  moving = false;
  revealAt = 0;
  reload = 120;
  barrage: Barrage;
  mg = { n: 0, t: 0, d: 0 };
  /** short shells and wake splashes for the fluid pass */
  splashes: { x: number; y: number; r: number; a: number }[] = [];
  stats = {
    shellHits: 0, short: 0, noPen: 0, droneHits: 0, rocketHits: 0, partsLost: 0, salvos: 0, shellsFired: 0, mgShots: 0,
    columns: 0, escorts: 0, deaths: 0, turns: 0, anchors: 0, offWater: 0, aaKills: 0, ms: 0, msMax: 0, msSum: 0, n: 0,
  };
  private fparts: FPart[];
  private hitOrder: FPart[];
  private lastTell = -INF;
  private bank: [number, number, number] = [0, 0, 0];
  private bankAt = -INF;

  constructor(w: World) {
    super(w);
    const river = w.region?.river;
    this.poly = new Poly(river && river.length >= 2 ? river : [[w.pxW * 0.1, w.pxH / 2], [w.pxW * 0.9, w.pxH / 2]]);
    const mk = (id: string, name: string, short: string, kind: FKind, rect: [number, number, number, number], hp: number, tdir = 0): FPart =>
      ({ id, name, short, kind, rect, hp, max: hp, hitT: 0, tdir, ta: 0, turnT: 0, recoil: 0 });
    // HUD order: fore to aft, the engine room (the core) at parts[4]
    this.fparts = [
      mk('fwd', 'FORWARD GUN', 'GUN', 'gun', [6, 5, 12, 12], FLAG.hp.gun),
      mk('bridge', 'BRIDGE', 'BRIDGE', 'bridge', [5, 18, 14, 11], FLAG.hp.bridge),
      mk('mg', 'DECK MG', 'MG', 'mg', [9, 20, 6, 6], FLAG.hp.mg),
      mk('aft', 'AFT GUN', 'GUN', 'gun', [6, 30, 12, 10], FLAG.hp.gun, 2),
      mk('engine', 'ENGINE ROOM', 'ENGINE', 'turret', [3, 40, 18, 8], FLAG.hp.engine),
    ];
    this.parts = this.fparts;
    const f = this.fparts;
    this.hitOrder = [f[2], f[0], f[3], f[1], f[4]];
    this.sMin = Math.min(this.poly.len / 2, FLAG.H / 2 + FLAG.margin);
    this.sMax = Math.max(this.sMin, this.poly.len - FLAG.H / 2 - FLAG.margin);
    this.barrage = new Barrage(w, this.proxy);
    // the berth: the stretch of river furthest from where the player starts
    const sp = w.region?.playerSpawns[0] ?? [0, 0];
    let bs = this.sMin;
    let bd = -1;
    for (let s = this.sMin; s <= this.sMax; s += 8) {
      const [x, y] = this.poly.at(s);
      const d = Math.hypot(x - sp[0], y - sp[1]);
      if (d > bd) { bd = d; bs = s; }
    }
    this.S = bs;
    this.dirS = bs > this.poly.len / 2 ? -1 : 1;
    this.dir = this.wantDir();
    for (const p of this.fparts) { p.tdir = (this.dir + p.tdir) & 3; p.ta = angOfDir(p.tdir); } // guns start fore and aft
    this.place();
    this.lairNear = this.townNear(this.cx, this.cy);
  }

  get cx(): number { return this.x + 24; }
  get cy(): number { return this.y + 24; }
  get turret(): BossPartLike { return this.fparts[4]; }
  get engine(): FPart { return this.fparts[4]; }
  /** The engine room is open to shells and rockets: a deck gun is gone. */
  exposed(): boolean { return this.fparts.some((p) => p.kind === 'gun' && p.hp <= 0); }
  get bridgeUp(): boolean { return this.fparts[1].hp > 0; }

  // ---------- geometry ----------
  /** top-left of the hull's box */
  get bx(): number { const [bw] = boxSize(FLAG.W, FLAG.H, this.dir); return this.cx - bw / 2; }
  get by(): number { const [, bh] = boxSize(FLAG.W, FLAG.H, this.dir); return this.cy - bh / 2; }
  get bw(): number { return boxSize(FLAG.W, FLAG.H, this.dir)[0]; }
  get bh(): number { return boxSize(FLAG.W, FLAG.H, this.dir)[1]; }

  private place(): void {
    const [x, y] = this.poly.at(this.S);
    this.x = x - 24;
    this.y = y - 24;
    this.proxy.x = x - 8;
    this.proxy.y = y - 8;
  }

  /** Facing for the current heading: the route's dominant axis, kept while the route is near 45 degrees. */
  private wantDir(): number {
    const [tx, ty] = this.poly.tangent(this.S);
    const vx = tx * this.dirS;
    const vy = ty * this.dirS;
    const d = domDir(vx, vy);
    const cur = this.dir;
    if (d === cur) return d;
    const along = (q: number) => vx * DX[q] + vy * DY[q];
    return along(cur) > 0 && along(d) < along(cur) + 0.2 ? cur : d;
  }

  partRect(p: BossPartLike): [number, number, number, number] {
    return frameRect(this.bx, this.by, FLAG.W, FLAG.H, this.dir, (p as FPart).rect);
  }

  toLocal(wx: number, wy: number): [number, number] {
    return unrotFrame(wx - this.bx, wy - this.by, FLAG.W, FLAG.H, this.dir);
  }

  toWorld(lx: number, ly: number): [number, number] {
    const [qx, qy] = rotFrame(lx, ly, FLAG.W, FLAG.H, this.dir);
    return [this.bx + qx, this.by + qy];
  }

  private inHull(x: number, y: number, w: number, h: number): boolean {
    return overlap(x, y, w, h, this.bx, this.by, this.bw, this.bh);
  }

  distTo(x: number, y: number): number {
    const dx = Math.max(this.bx - x, 0, x - (this.bx + this.bw));
    const dy = Math.max(this.by - y, 0, y - (this.by + this.bh));
    return Math.hypot(dx, dy);
  }

  overlaps(x: number, y: number, w: number, h: number): boolean {
    return this.present && this.state !== 'dead' && this.inHull(x, y, w, h);
  }

  /** It never blocks a tank: tanks can't drive on water, and it passes under the bridges. */
  blocks(_t: Tank, _x: number, _y: number): boolean {
    return false;
  }

  // ---------- per update ----------
  update(): void {
    const w = this.w;
    const t0 = performance.now();
    if (this.state === 'hidden') {
      if (w.frame % 30 === 0 && this.townsToReveal() === 0) this.reveal();
      return;
    }
    if (this.hitT > 0) this.hitT--;
    for (const p of this.fparts) {
      if (p.hitT > 0) p.hitT--;
      if (p.recoil > 0) p.recoil--;
    }
    this.moving = false;
    if (this.state === 'dying') this.updateDying();
    else if (this.state === 'dead') this.updateWreck();
    else {
      this.perceive(this.state === 'lair' ? FLAG.wake : FLAG.sight);
      if (this.state === 'lair' && (this.target || w.frame - this.revealAt > FLAG.wakeAfter)) this.wake();
      if (w.freeze === 0 && !w.over) {
        this.aimGuns();
        this.deckMg();
        this.sail();
      }
      this.smoke();
      if (w.frame - this.bankAt > 60) this.findBank();
    }
    this.barrage.update((s) => this.gunFired(s));
    if (this.splashes.length > 40) this.splashes.splice(0, this.splashes.length - 40); // drawn (and emptied) by fluid()
    const under = w.map.at(Math.floor(this.cx / 4), Math.floor(this.cy / 4));
    if (under !== WATER && under !== ROAD) this.stats.offWater++; // (a road over the river is a bridge it passes under)
    const ms = performance.now() - t0;
    const s = this.stats;
    s.ms = ms;
    s.msMax = Math.max(s.msMax, ms);
    s.msSum += ms;
    s.n++;
  }

  // ---------- reveal ----------
  reveal(): void {
    if (this.state !== 'hidden') return;
    const w = this.w;
    this.place();
    this.revealed = true;
    this.state = 'lair';
    this.mode = 'berth';
    this.revealAt = w.frame;
    this.lairNear = this.townNear(this.cx, this.cy);
    this.findBank();
    const n = w.ai?.bossEscort(FLAG.escort, this.name, () => this.bank) ?? 0;
    this.stats.escorts += n;
    this.say('HQ', `THEIR RIVER FLAGSHIP, CALLSIGN ${this.name}, IS MOORED NEAR ${this.lairNear}. OUR SHELLS FALL SHORT ACROSS THE WATER: HIT IT FROM THE BRIDGES AND BANKS, OR SEND DRONES AND AMBUSH SQUADS.`);
    this.say(WHO, `${this.name}: ALL GUNS MANNED. ANYTHING ON THE BANKS IS A TARGET.`);
    w.note('BOSS LOCATED', 'warn');
    w.snd('column', this.cx, 1);
    this.logEv(`revealed at S ${Math.round(this.S)} of ${Math.round(this.poly.len)} near ${this.lairNear}, escort ${n}`);
  }

  private wake(): void {
    if (this.state !== 'lair') return;
    this.state = 'hunt';
    this.mode = 'patrol';
    this.modeT = 0;
    this.say(WHO, `${this.name}: WEIGHING ANCHOR. GUNS, FIND ME THAT TANK.`);
    this.w.snd('boss-horn', this.cx, 0.6);
    this.logEv('wakes');
  }

  /** A spot on the nearer bank beside it, for the escort to hold (ai.bossEscort keeps station 40 px ahead of it). */
  private findBank(): void {
    const w = this.w;
    this.bankAt = w.frame;
    const [tx, ty] = this.poly.tangent(this.S);
    let best: [number, number, number] | null = null;
    let bd = Infinity;
    for (const s of [1, -1]) {
      const nx = -ty * s;
      const ny = tx * s;
      for (let r = 16; r < 160; r += 4) {
        const x = this.cx + nx * r;
        const y = this.cy + ny * r;
        if (x < 8 || y < 8 || x > w.pxW - 8 || y > w.pxH - 8) break;
        if (w.map.solidForTank(x - 8, y - 8, false)) continue;
        if (r < bd) {
          bd = r;
          const d = domDir(nx, ny);
          best = [x - DX[d] * 40, y - DY[d] * 40, d];
        }
        break;
      }
    }
    this.bank = best ?? [this.cx, this.cy, this.dir];
  }

  // ---------- sailing ----------
  private sail(): void {
    const w = this.w;
    if (this.state !== 'hunt') return;
    this.modeT++;
    if (this.mode === 'turn') {
      this.v = 0;
      if (this.modeT < FLAG.turnPause) return;
      this.modeT = 0;
      const want = this.wantDir();
      if (want === this.dir) {
        this.mode = 'patrol';
        return;
      }
      this.dir = ((want - this.dir + 4) & 3) === 3 ? (this.dir + 3) & 3 : (this.dir + 1) & 3;
      this.stats.turns++;
      return;
    }
    if (this.mode === 'anchor') {
      this.v = Math.max(0, this.v - FLAG.acc * 2);
      if (this.v > 0) this.move(this.v);
      const shells = this.liveGuns().length * FLAG.perGun;
      if (this.modeT === FLAG.settle) this.salvo();
      if (this.modeT >= FLAG.settle + shells * FLAG.shellStagger + FLAG.after) {
        this.mode = 'patrol';
        this.modeT = 0;
      }
      return;
    }
    // patrol: stop to shell a player it can see on the banks
    if (this.reload > 0) this.reload--;
    const at = this.aimAt();
    if (this.reload <= 0 && at && this.liveGuns().length && Math.hypot(at[0] - this.cx, at[1] - this.cy) <= FLAG.shellRange) {
      this.mode = 'anchor';
      this.modeT = 0;
      this.stats.anchors++;
      this.logEv('drops anchor to shell');
      return;
    }
    const end = this.dirS > 0 ? this.sMax : this.sMin;
    const dist = Math.abs(end - this.S);
    const want = Math.min(FLAG.speed, Math.sqrt(2 * FLAG.acc * dist) + 0.02);
    this.v = this.v < want ? Math.min(want, this.v + FLAG.acc) : want;
    this.move(Math.min(this.v, dist));
    if (dist - this.v < 0.01) {
      this.S = end;
      this.place();
      this.v = 0;
      this.dirS = -this.dirS;
      this.mode = 'turn';
      this.modeT = 0;
      this.logEv('turns round');
      return;
    }
    const d = this.wantDir();
    if (d !== this.dir) {
      // a bend in the river: it swings round (a quarter turn while it keeps moving)
      this.dir = ((d - this.dir + 4) & 3) === 2 ? (this.dir + 1) & 3 : d;
      this.stats.turns++;
    }
  }

  private move(ds: number): void {
    if (ds <= EPS) return;
    this.S = clamp(this.S + ds * this.dirS, this.sMin, this.sMax);
    this.place();
    this.moving = true;
    // a bow wave now and then
    if (this.w.frame % 4 === 0) {
      const [bx, by] = this.toWorld(12, 1);
      this.splashes.push({ x: bx, y: by, r: 3, a: 0.5 });
    }
  }

  /** The point it shells: the target if seen, else where it was last seen (for 8 s). */
  private aimAt(): [number, number] | null {
    const t = this.target;
    if (t && this.w.frame - this.lastSeen < 10) return [t.cx, t.cy];
    if (this.lastAt && this.w.frame - this.lastSeen < 60 * 8) return this.lastAt;
    return null;
  }

  private liveGuns(): FPart[] {
    return this.fparts.filter((p) => p.kind === 'gun' && p.hp > 0);
  }

  /** Deck guns slew toward the target at their real angle, the old quarter-turn pace (the aft gun faces astern with
   * nothing to shoot). */
  private aimGuns(): void {
    const at = this.aimAt();
    for (const p of this.fparts) {
      if (p.kind !== 'gun' || p.hp <= 0) continue;
      const [x, y, pw, ph] = this.partRect(p);
      const want = at ? angOf(at[0] - (x + pw / 2), at[1] - (y + ph / 2)) : angOfDir(p.id === 'aft' ? (this.dir + 2) & 3 : this.dir);
      p.ta = slewTo(p.ta, want, QUARTER / FLAG.gunTurn);
      p.tdir = dirOfAng(p.ta);
    }
  }

  /** A salvo: FLAG.perGun rounds per live deck gun, warning rings first. */
  private salvo(): void {
    const w = this.w;
    const at = this.aimAt();
    const guns = this.liveGuns();
    if (!at || !guns.length) return;
    const n = guns.length * FLAG.perGun;
    const blind = !this.bridgeUp;
    const [s0, s1] = blind ? FLAG.blindSpread : FLAG.spread;
    const pts: [number, number][] = blind ? [] : [[at[0], at[1]]];
    for (let k = 0; pts.length < n && k < 60; k++) {
      const a = rand() * Math.PI * 2;
      const r = s0 + rand() * (s1 - s0);
      const p: [number, number] = [at[0] + Math.cos(a) * r, at[1] + Math.sin(a) * r];
      if (pts.some(([x, y]) => Math.hypot(x - p[0], y - p[1]) < 14)) continue;
      // never on the river itself: it shells the banks
      if (w.map.at(Math.floor(p[0] / 4), Math.floor(p[1] / 4)) === WATER && k < 50) continue;
      pts.push(p);
    }
    const warn = tellT(w, FLAG.shellWarn);
    pts.forEach(([x, y], i) => {
      const g = guns[i % guns.length];
      const [gx, gy, gw, gh] = this.partRect(g);
      this.barrage.add(x, y, gx + gw / 2, gy + gh / 2, w.frame + i * FLAG.shellStagger, warn, warn, 0, FLAG.shellR, FLAG.shellDmg);
    });
    this.reload = gapT(w, FLAG.shellGap);
    this.stats.salvos++;
    if (this.target && Math.hypot(this.target.cx - at[0], this.target.cy - at[1]) < 90) w.note('INCOMING!', 'warn');
    if (w.frame - this.lastTell > FLAG.tellGap) {
      this.lastTell = w.frame;
      this.say(WHO, blind
        ? `${this.name}: BRIDGE IS GONE. FIRE BY EYE, ANYWHERE ON THAT BANK.`
        : `${this.name}: BANK TARGET, GRID ${Math.floor(at[0] / 64)}-${Math.floor(at[1] / 64)}. ${n} ROUNDS, FIRE FOR EFFECT.`);
    }
    this.logEv(`salvo x${n} at ${Math.round(at[0])},${Math.round(at[1])}${blind ? ' (blind)' : ''}`);
  }

  /** A deck gun fires the round it was given (muzzle flash, smoke, recoil). */
  private gunFired(s: Incoming): void {
    const w = this.w;
    this.stats.shellsFired++;
    let gun: FPart | null = null;
    let bd = Infinity;
    for (const p of this.liveGuns()) {
      const [x, y, pw, ph] = this.partRect(p);
      const d = Math.hypot(x + pw / 2 - s.fx, y + ph / 2 - s.fy);
      if (d < bd) { bd = d; gun = p; }
    }
    if (!gun) return;
    const [x, y, pw, ph] = this.partRect(gun);
    // it fires at the round's mark: the barrel points there
    gun.ta = angOf(s.x - (x + pw / 2), s.y - (y + ph / 2));
    gun.tdir = dirOfAng(gun.ta);
    const [ux, uy] = vecOf(gun.ta);
    const mx = x + pw / 2 + ux * 8;
    const my = y + ph / 2 + uy * 8;
    gun.recoil = 8;
    w.flashes.push({ x: mx, y: my, t: 0, max: 12, r: 70, col: [1, 0.6, 0.3], z: 12, vx: ux, vy: uy });
    for (let i = 0; i < 4; i++) this.smokePuff(mx + ux * 3, my + uy * 3, false, 8);
    w.snd('boss-cannon', mx, 0.9);
    w.snd('explode', mx, 0.35);
    w.shake = Math.max(w.shake, 1.2);
  }

  // ---------- deck machine gun ----------
  private aaJudged = new WeakSet<object>();

  private deckMg(): void {
    const w = this.w;
    const p = this.fparts[2];
    const s = this.mg;
    if (p.hp <= 0) { s.n = 0; return; }
    const [mx, my] = this.toWorld(12, 23);
    // FPV drones diving on the ship: one judgement per drone, a burst of tracer at it, hit or miss
    const ab = w.abil;
    if (ab?.fpvs.length && this.state === 'hunt') {
      for (const f of [...ab.fpvs]) {
        // (its own hull test: overlaps() is always false for a ship, which blocks no tank)
        if (this.aaJudged.has(f) || f.t < f.dur * 0.45 || f.lost || f.target || !(f.bossLock || this.inHull(f.tx - 3, f.ty - 3, 6, 6))) continue;
        this.aaJudged.add(f);
        p.ta = angOf(f.x - mx, f.y - my);
        for (let k = 0; k < 3; k++) w.flashes.push({ x: mx, y: my, t: -k * 4, max: 4, r: 22, col: [1, 0.8, 0.4], z: 9 });
        w.snd('eshoot', mx, 0.35);
        if (rand() >= FLAG.aaChance * (1 - w.ease)) continue;
        ab.fpvs.splice(ab.fpvs.indexOf(f), 1);
        this.stats.aaKills++;
        w.explode(f.x, f.y, false);
        w.sparks(f.x, f.y, 10, [1, 0.8, 0.4]);
        w.popups.push({ x: f.x, y: f.y - 8, text: 'SHOT DOWN', t: 0, col: [0.75, 0.8, 0.88] });
        w.note('DRONE SHOT DOWN', 'warn');
        this.say('WASP', 'HER DECK GUN SWATTED MY BIRD. KNOCK OUT THAT MG ON THE BRIDGE AND THE SKY IS OURS.');
        this.logEv('deck MG shot down a drone');
      }
    }
    if (s.t > 0) { s.t--; return; }
    if (s.n > 0) {
      const [ux, uy] = vecOf(s.d);
      const b = shellAt(mx + ux * 5, my + uy * 5, ux, uy, FLAG.mgSpeed, this.proxy, false);
      b.dmg = FLAG.mgDmg;
      b.mg = true;
      b.range = FLAG.mgRange + 12;
      w.bullets.push(b);
      w.flashes.push({ x: mx + ux * 6, y: my + uy * 6, t: 0, max: 4, r: 22, col: [1, 0.8, 0.4], z: 9 });
      w.snd('eshoot', mx, 0.3);
      this.stats.mgShots++;
      s.n--;
      s.t = s.n ? FLAG.mgGap : gapT(w, FLAG.mgPause);
      return;
    }
    const t = this.target;
    if (!t || this.state !== 'hunt') return;
    // the nearest of the 8 directions (s.d is the burst's angle)
    const a = snap8(t.cx - mx, t.cy - my);
    const [ux, uy] = vecOf(a);
    const [lat, along] = lineOff(mx, my, ux, uy, t.cx, t.cy);
    if (lat > FLAG.mgSlack || along < 8 || along > FLAG.mgRange) return;
    if (!clearOf(w.map, mx, my, ux, uy, along)) return;
    s.d = p.ta = a;
    p.tdir = dirOfAng(a);
    s.n = FLAG.mgBurst;
    s.t = tellT(w, 8);
  }

  // ---------- damage ----------
  /** The first live part along a round's path across the hull from (wx, wy); 'armour' if it meets the closed
   * engine room first; null if it crosses only bare hull. */
  private along(wx: number, wy: number, dir: number): FPart | 'armour' | null {
    let inside = false;
    for (let k = 0; k <= 60; k += 2) {
      const x = wx + DX[dir] * k;
      const y = wy + DY[dir] * k;
      if (!this.inHull(x - 0.5, y - 0.5, 1, 1)) {
        if (inside) break;
        continue;
      }
      inside = true;
      const [lx, ly] = this.toLocal(x, y);
      for (const p of this.hitOrder) {
        if (p.hp <= 0) continue;
        const [rx, ry, rw, rh] = p.rect;
        if (lx < rx - 1 || lx >= rx + rw + 1 || ly < ry - 1 || ly >= ry + rh + 1) continue;
        if (p.kind === 'turret' && !this.exposed()) return 'armour';
        return p;
      }
    }
    return null;
  }

  bulletHit(b: Bullet): boolean {
    if (!this.present || this.state === 'dead' || b.owner === this.proxy || !b.owner.isPlayer) return false;
    if (!this.inHull(b.x - 2, b.y - 2, 4, 4)) return false;
    b.alive = false;
    const w = this.w;
    if (!this.alive) {
      w.impact(b, false, true);
      return true;
    }
    const o = b.owner;
    if (Math.hypot(o.cx - this.cx, o.cy - this.cy) > FLAG.reach) {
      // across open water the shell falls short: a splash beside the hull
      this.stats.short++;
      const sx = b.x - DX[b.dir] * 6;
      const sy = b.y - DY[b.dir] * 6;
      this.splashes.push({ x: sx, y: sy, r: 4, a: 2.5 });
      w.sparks(sx, sy, 5, [0.75, 0.85, 0.95]);
      w.snd('thud', sx, 0.6);
      this.noPenFx(sx, sy, 'TOO FAR: SHOOT FROM A BRIDGE OR THE BANK', 'TOO FAR');
      return true;
    }
    this.stats.shellHits++;
    this.wake();
    const p = this.along(b.x - DX[b.dir] * 2, b.y - DY[b.dir] * 2, b.dir);
    if (!p || p === 'armour') {
      this.stats.noPen++;
      this.noPenFx(b.x, b.y, p === 'armour' ? 'ENGINE ROOM ARMOURED: KNOCK OUT A DECK GUN' : 'HIT THE GUNS AND THE BRIDGE');
      return true;
    }
    this.damage(p, b.x, b.y, this.shellDmg(o), o.player, 'shell');
    return true;
  }

  droneHit(x: number, y: number, dmg: number, pi: number): boolean {
    if (!this.alive || !this.inHull(x - 3, y - 3, 6, 6)) return false;
    this.stats.droneHits++;
    this.wake();
    const [lx, ly] = this.toLocal(x, y);
    let part: FPart = this.engine;
    for (const p of this.hitOrder) {
      if (p.hp <= 0) continue;
      const [rx, ry, rw, rh] = p.rect;
      if (lx >= rx - 4 && lx < rx + rw + 4 && ly >= ry - 4 && ly < ry + rh + 4) { part = p; break; }
    }
    // through the thin deck: drones always reach the engine room
    this.damage(part, x, y, dmg * BOSS.droneMul, pi, 'drone');
    return true;
  }

  rocketHit(x: number, y: number, dir: number, dmg: number, pi: number): boolean {
    if (!this.present || this.state === 'dead' || !this.inHull(x - 0.5, y - 0.5, 1, 1)) return false;
    if (!this.alive) return true;
    this.stats.rocketHits++;
    this.wake();
    let p = this.along(x, y, dir);
    if (!p || p === 'armour') {
      // an anti-tank rocket bursts on the nearest weak point it can hurt
      let bd = Infinity;
      p = null;
      for (const q of this.fparts) {
        if (q.hp <= 0 || (q.kind === 'turret' && !this.exposed())) continue;
        const [rx, ry, rw, rh] = this.partRect(q);
        const d = Math.hypot(rx + rw / 2 - x, ry + rh / 2 - y);
        if (d < bd) { bd = d; p = q; }
      }
    }
    if (p) this.damage(p, x, y, dmg, pi, 'rocket');
    return true;
  }

  /** The engine room once open, else the weakest deck gun, else the bridge. */
  aimPoint(): [number, number] {
    let best: FPart | null = null;
    if (this.exposed()) best = this.engine;
    else for (const p of this.liveGuns()) if (!best || p.hp < best.hp) best = p;
    best ??= this.bridgeUp ? this.fparts[1] : this.engine;
    const [x, y, pw, ph] = this.partRect(best);
    return [x + pw / 2, y + ph / 2];
  }

  private damage(p: FPart, wx: number, wy: number, dmg: number, pi: number, how: string): void {
    p.hp = Math.max(0, p.hp - dmg);
    p.hitT = 10;
    this.hitFx(wx, wy, dmg);
    this.logEv(`${how} hit ${p.id} -${dmg} (${p.hp}/${p.max})`);
    if (p.hp <= 0) this.partLost(p, pi);
  }

  private partLost(p: FPart, pi: number): void {
    const w = this.w;
    this.stats.partsLost++;
    if (p.kind === 'turret') {
      this.die(pi);
      return;
    }
    const [x, y, pw, ph] = this.partRect(p);
    this.partBlast(x + pw / 2, y + ph / 2, p.name, pi);
    this.splashes.push({ x: x + pw / 2, y: y + ph / 2, r: 10, a: 3 });
    if (p.kind === 'gun') {
      const first = this.fparts.filter((q) => q.kind === 'gun' && q.hp <= 0).length === 1;
      this.say(WHO, `${this.name}: ${p.name} IS GONE. FIRE IN THE MAGAZINE, FLOOD IT!`);
      if (first) {
        w.note('ENGINE ROOM EXPOSED', 'power');
        this.say('SPANNER', 'THAT BLAST OPENED HER DECK. THE ENGINE ROOM AT THE STERN IS BARE NOW.');
      }
      const at = this.target ?? w.livePlayers()[0];
      if (w.ai?.bossColumn(at ? at.x : this.cx - 8, at ? at.y : this.cy - 8)) this.stats.columns++;
    } else if (p.kind === 'bridge') {
      this.fparts[2].hp = 0; // the MG on its roof goes with it
      this.say(WHO, `${this.name}: BRIDGE HIT! NO RANGEFINDER, NO RADIO MAST. FIRE BY EYE!`);
      this.say('OWL', 'THEIR BRIDGE IS BURNING. THEY ARE SHOOTING BLIND NOW.');
    } else {
      this.say(WHO, `${this.name}: DECK GUNNER DOWN.`);
    }
    this.logEv(`${p.id} destroyed`);
  }

  kill(pi = -1): void {
    if (this.state === 'hidden') this.reveal();
    if (!this.alive) return;
    this.engine.hp = 0;
    this.die(pi);
  }

  private die(pi: number): void {
    const w = this.w;
    if (!this.alive) return;
    this.state = 'dying';
    this.deathT = 0;
    this.killer = pi;
    this.stats.deaths++;
    this.barrage.list = this.barrage.list.filter((s) => s.fired);
    this.say(WHO, `${this.name}: ENGINE ROOM FLOODING! ABANDON SHIP!`);
    w.note(`${this.name} IS SINKING`, 'power');
    w.shake = Math.max(w.shake, 5);
    this.logEv('dying');
  }

  // ---------- sinking and the wreck ----------
  /** 0..1 how far down it is while it sinks */
  get sink(): number {
    if (this.state === 'dead') return 1;
    if (this.state !== 'dying') return 0;
    return clamp((this.deathT - 50) / (FLAG.dieFrames - 50), 0, 1);
  }

  private updateDying(): void {
    const w = this.w;
    const t = ++this.deathT;
    this.hitT = (t >> 2) & 1 ? 3 : 0;
    this.v = Math.max(0, this.v - 0.01);
    if (this.v > 0) this.move(this.v);
    const rx = () => this.bx + 3 + rand() * (this.bw - 6);
    const ry = () => this.by + 3 + rand() * (this.bh - 6);
    if (t < 110 && t % 8 === 0) {
      const x = rx();
      const y = ry();
      w.explode(x, y, false);
      w.sparks(x, y, 8, [1, 0.75, 0.35]);
      w.snd('explode', x, 0.7);
      w.shake = Math.max(w.shake, 2.5);
    }
    if (t === 30 || t === 70) {
      w.explode(rx(), ry(), true);
      w.snd('bigexplode', this.cx, 0.8);
    }
    if (t > 50 && t % 3 === 0) this.splashes.push({ x: rx(), y: ry(), r: 3 + rand() * 4, a: 1.5 + rand() });
    if (t % 3 === 0) this.smokePuff(rx(), ry(), true);
    if (t >= FLAG.dieFrames) this.finale();
  }

  private finale(): void {
    const w = this.w;
    const x = this.cx;
    const y = this.cy;
    this.state = 'dead';
    this.deadT = 0;
    for (const p of this.fparts) p.hp = 0;
    w.explode(x, y, true);
    w.explode(x - 10, y + 6, true);
    w.flashes.push({ x, y, t: 0, max: 90, r: 220, col: [1, 0.55, 0.2], z: 30 });
    w.shocks.push({ x, y, t: 0, max: 60, size: 3 });
    w.shake = 9;
    w.snd('bigexplode', x, 1);
    w.snd('thunder', x, 0.3);
    this.splashes.push({ x, y, r: 22, a: 6 });
    this.splashes.push({ x: x + 14, y: y - 8, r: 12, a: 4 });
    for (let i = 0; i < 24; i++) {
      const b = rand() * Math.PI * 2;
      const s = 0.5 + rand() * 2;
      w.parts.push({
        x, y, z: 10, vx: Math.cos(b) * s, vy: Math.sin(b) * s, vz: 1.5 + rand() * 2.5,
        life: 0, max: 200, col: rand() < 0.5 ? [0.3, 0.34, 0.36] : [0.2, 0.2, 0.2], kind: 0, r: 1,
      });
    }
    for (let i = 0; i < 10; i++) this.smokePuff(x + (rand() - 0.5) * 30, y + (rand() - 0.5) * 30, true);
    w.decals.push({ k: 1, x, y, r: 24, col: [0.02, 0.02, 0.025], a: 0.35 }); // an oil slick
    this.payout(x, y);
    this.say('HQ', `${this.name} IS ON THE BOTTOM OF THE RIVER. THE DELTA IS OURS.`);
    this.say('SPANNER', 'I CAN SEE HER MAST FROM HERE. I WILL SWIM FOR THE PARTS. JOKING. MOSTLY.');
    this.logEv('sunk');
  }

  private updateWreck(): void {
    const t = ++this.deadT;
    if (t < 60 * 30 && this.w.frame % 6 === 0) this.smokePuff(this.cx + (rand() - 0.5) * 10, this.cy + (rand() - 0.5) * 8, true);
    if (t % 40 === 0) this.splashes.push({ x: this.cx + (rand() - 0.5) * 20, y: this.cy + (rand() - 0.5) * 20, r: 2, a: 0.8 });
  }

  /** Smoke from damaged parts and the funnel's exhaust as particles. */
  private smoke(): void {
    const w = this.w;
    if (w.frame % 7 !== 0) return;
    for (const p of this.fparts) {
      if (p.hp > 0 && p.hp > p.max / 2) continue;
      if (p.hp > 0 && w.frame % 21 !== 0) continue;
      const [x, y, pw, ph] = this.partRect(p);
      this.smokePuff(x + pw / 2, y + ph / 2, p.hp <= 0);
    }
  }

  // ---------- drawing ----------
  draw(r: Renderer, ox: number, oy: number, time: number, head: number): void {
    if (!this.present) return;
    this.barrage.draw(r, ox, oy);
    const bx = Math.round(ox + this.bx);
    const by = Math.round(oy + this.by);
    if (bx < -80 || by < -80 || bx > r.nw + 80 || by > r.nh + 80) return;
    const A = r.atlas.S;
    const d = this.dir;
    const dead = this.state === 'dead';
    const dying = this.state === 'dying';
    const sink = this.sink;
    const flash = this.hitT > 0 ? (dying ? 0.2 : 0.3) : 0;
    const water: RGB = [0.2, 0.3, 0.36];
    const mix = (k: number): RGB => [1 + (water[0] - 1) * k, 1 + (water[1] - 1) * k, 1 + (water[2] - 1) * k];
    if (dead) {
      // the wreck: the hull a dark shape under the water, the bridge and mast sticking out, burning for a while
      r.spr(A.flagHullWreck, bx, by, d, [0.1, 0.14, 0.17], MAT_STD, -0.4, 0, 0);
      const [qx, qy, qw, qh] = frameRect(bx, by, FLAG.W, FLAG.H, d, this.fparts[1].rect);
      r.spr(A.flagBridge, qx, qy, d, [0.3, 0.29, 0.29], MAT_STD, -0.2, 0, 0);
      if (this.deadT < 60 * 30) {
        const fl = 0.6 + 0.4 * Math.sin(time * 11) * Math.sin(time * 4.3);
        r.glow(qx + qw / 2, qy + qh / 2, 3, [1, 0.5, 0.15], 0.9 * fl);
        r.light(qx + qw / 2, qy + qh / 2, 12, 60, 1.0 * fl, 0.42 * fl, 0.1 * fl, true);
      }
      return;
    }
    const tint = mix(sink * 0.85);
    const hb = -0.2 * sink;
    r.spr(A.flagHull, bx, by, d, tint, MAT_STD, hb, 1, flash);
    // parts: the bridge (its MG on the roof), the deck guns
    for (const p of this.fparts) {
      if (p.kind === 'turret') continue;
      const gone = p.hp <= 0;
      const pf = p.hitT > 6 ? 0.65 : flash;
      const pt: RGB = gone ? [0.3 * tint[0], 0.27 * tint[1], 0.26 * tint[2]] : tint;
      if (p.kind === 'bridge') {
        const [qx, qy] = frameRect(bx, by, FLAG.W, FLAG.H, d, p.rect);
        r.spr(A.flagBridge, qx, qy, d, pt, MAT_STD, hb, 1, pf);
      } else if (p.kind === 'mg') {
        if (gone) continue;
        const [mx, my] = rotFrame(12, 23, FLAG.W, FLAG.H, d);
        r.sprRot(A.flagMG, Math.round(bx + mx), Math.round(by + my), p.ta, pt, MAT_STD, hb, 1, pf);
      } else {
        const [gx, gy] = rotFrame(12, p.id === 'fwd' ? 11 : 35, FLAG.W, FLAG.H, d);
        const rc = p.recoil > 4 ? 2 : p.recoil > 0 ? 1 : 0;
        const ga = gone ? angOfDir(d) : p.ta;
        r.sprRot(A.flagGun, Math.round(bx + gx - Math.sin(ga) * rc), Math.round(by + gy + Math.cos(ga) * rc), ga, pt, MAT_STD, hb, 1, pf);
      }
      if (gone && !dying) {
        const [x, y, pw, ph] = this.partRect(p);
        const fl = 0.6 + 0.4 * Math.sin(time * 17 + pw);
        r.glow(ox + x + pw / 2, oy + y + ph / 2, 2.5, [1, 0.5, 0.15], 0.9 * fl);
        r.light(ox + x + pw / 2, oy + y + ph / 2, 10, 30, 0.6 * fl, 0.26 * fl, 0.06 * fl, false);
      }
    }
    if (dying) {
      const fl = 0.5 + 0.5 * Math.sin(time * 23);
      const k = 1 - sink * 0.7;
      r.light(ox + this.cx, oy + this.cy, 16, 90, 1.2 * fl * k, 0.5 * fl * k, 0.12 * fl * k, true);
      r.glow(ox + this.cx, oy + this.cy, 5 + 4 * fl, [1, 0.5, 0.15], 1.1 * k);
      return;
    }
    // running lights, and the bridge searchlight on its target (a tell, and the menace at night)
    const k = Math.max(0.35, head);
    if (this.bridgeUp) {
      const [sx, sy] = this.toWorld(12, 20);
      const at = this.aimAt();
      if (at) {
        const dx = at[0] - sx;
        const dy = at[1] - sy;
        const l = Math.hypot(dx, dy) || 1;
        r.spot(ox + sx, oy + sy, 12, Math.min(260, l + 60), 1.3 * k, 1.2 * k, 1.0 * k, true, dx / l, dy / l, 0.95, 0.985);
        r.glow(ox + sx, oy + sy, 2.5, [1, 1, 0.9], 0.5 + 0.5 * head);
      } else {
        r.spot(ox + sx, oy + sy, 10, 110, 0.8 * k, 0.75 * k, 0.6 * k, true, DX[d], DY[d], 0.8, 0.94);
      }
    }
    // the anchor tell: the deck guns' breeches glow while it settles to fire
    if (this.mode === 'anchor' && this.modeT < FLAG.settle + 4) {
      const g = this.modeT / FLAG.settle;
      for (const p of this.liveGuns()) {
        const [x, y, pw, ph] = this.partRect(p);
        r.glow(ox + x + pw / 2, oy + y + ph / 2, 3 + 2 * g, [1, 0.4, 0.15], (0.6 + 1.6 * g) * (0.75 + 0.25 * Math.sin(time * 30)));
      }
    }
  }

  /** Wake, bow wave, splashes, funnel smoke, fires. */
  fluid(r: Renderer, ox: number, oy: number, f: number, time: number): void {
    if (!this.present) return;
    for (const s of this.splashes) r.waveSplat(ox + s.x, oy + s.y, s.r, s.a);
    this.splashes.length = 0;
    const x = ox + this.cx;
    const y = oy + this.cy;
    if (x < -100 || y < -100 || x > r.nw + 100 || y > r.nh + 100) return;
    const d = this.dir;
    if (this.state === 'dead') {
      if (this.deadT < 60 * 30) r.dyeSplat(x + Math.sin(time * 3) * 3, y - 2, 6, 0.5 * f, 0.3 * f, 0.1 * f);
      return;
    }
    if (this.state === 'dying') {
      r.dyeSplat(x + (Math.random() - 0.5) * 30, y + (Math.random() - 0.5) * 16, 7, 0.5 * f, 0.5 * f, 0.3 * f * (1 - this.sink));
      if (this.sink > 0) r.dyeSplat(x, y, 10, 0.2 * f, 0.4 * f, 0); // steam
      return;
    }
    // the wake: two arms off the stern while it moves, the water pushed aside
    if (this.moving) {
      const [sx, sy] = this.toWorld(12, 47);
      for (const s of [-1, 1]) {
        const px = ox + sx + DY[d] * s * 9 * -1;
        const py = oy + sy + DX[d] * s * 9;
        r.waveSplat(px, py, 2.5, 0.35 * f);
      }
      r.velSplat(x, y, 18, DX[d] * 120 * r.dt, DY[d] * 120 * r.dt);
    } else if (this.w.frame % 30 === 0) {
      r.waveSplat(x, y, 6, 0.25);
    }
    // funnel smoke (heavier when the engine room is hurt)
    const [fx, fy] = this.toWorld(12, 43.5);
    const hurt = 1 - this.engine.hp / this.engine.max;
    r.dyeSplat(ox + fx, oy + fy, 3, (0.1 + 0.25 * hurt + (this.moving ? 0.08 : 0)) * f, 0.08 * f, 0.04 * f * hurt);
    for (const p of this.fparts) {
      if (p.hp > 0) continue;
      const [px, py, pw, ph] = this.partRect(p);
      r.dyeSplat(ox + px + pw / 2, oy + py + ph / 2, 4, 0.3 * f, 0.2 * f, 0.08 * f);
    }
  }
}
