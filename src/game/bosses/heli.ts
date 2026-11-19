// Phase 4: the Region 4 boss (Ruined Town, night storm), "VULTURE" (invented callsign), an attack helicopter.
//
// It flies: walls, water and trees mean nothing to it, it never blocks a tank and it is drawn above everything
// (r.top), with a spinning rotor, a shadow on the ground (r.shadeSpr) and, at night, a sweeping searchlight. Its
// height is `alt`, 0 (on its pad) .. 1 (cruising): the shadow slides further from the body and shrinks as it climbs.
// Player shells and ambush rockets only reach it at HELI.low or below (hovering to attack, or recovering after a
// run); higher up they pass beneath it ("TOO HIGH"). FPV drones hit hard (HELI.droneDmg), but it carries flares: flying high
// it decoys every drone (the flares burst off its flanks, the drone swerves into them: "DECOYED"), and down low one
// drone gets through per pass, after which it dumps flares until it has climbed away again. So a drone is a big hit
// in the same windows shells get, never a way to skip the fight.
//
// Patterns (each with a tell, "easy"):
// - Strafing run: it picks a line through the player along one axis and flies to its start, the line following the
//   player until it gets there; then the line is fixed, a blinking dotted line marks the run on the ground and the
//   rotor pitch rises (sound 'heli-pitch') for HELI.strafeTell frames while it drops low; then it runs the line, its
//   chin gun walking bullet strikes along it (1 armour each, about 4 on a tank that stays). With a pod gone it often
//   comes straight back round for a second run (a new line, a shorter tell).
// - Rocket salvo: it hovers low ~100 px off, warning marks blink on the player, ahead of the way the player is
//   driving and round about, then each live pod fires 2 rockets at the marks (3 armour within HELI.markR px, bricks
//   knocked down). Then the chasers: one more rocket per pod, each on a fresh mark that appears where the player is
//   at that moment, HELI.chaseWarn frames before it lands. Leave the marks and keep driving.
// - Pop-up: it hides low behind a building (shells hit the bricks first), then pops up out of shell reach, the pods
//   glow, and it lobs a rocket per live pod at marks on the player.
// After every attack it hangs low for HELI.recover frames: the window to shoot it.
//
// Weak points: two rocket pods (no more rockets once both are gone), the tail rotor, then the engine / cockpit (the
// kill), which only takes hits once the tail rotor is gone. Losing the tail rotor sends it spinning low for a few
// seconds, then it flies erratically and can't climb as high. Death: a smoking spiral down, a crash, a burning wreck;
// +HELI.scrap, 2 captured parts.
import type { Renderer } from '../../gl/renderer';
import { BRICK, DOWN, DX, DY, EMPTY, MAT_METAL, MAT_STD, STEEL, TREES } from '../constants';
import { Tank, type Bullet, type RGB, type World } from '../world';
import { clamp, debrisBurst, domDir, logTo, overlap, rand, rotPt, rotRect, say, smokePuff, toLocal } from './common';
import { OvPen, ring } from './marks';
import type { BossExtras, BossLike, BossPartLike, BossState } from './types';

/** Tuning, "easy". Distances in px, times in frames (60 per second). */
export const HELI = {
  size: 48,
  /** towns freed before it shows itself (all of them if the region has fewer) */
  reveal: 3,
  hp: { pod: 4, tail: 6, engine: 28 }, // engine was 18
  /** player shells and ambush rockets reach it at this height or lower */
  low: 0.4,
  altAttack: 0.24,
  altPop: 0.58,
  altCruise: 1,
  /** cruising height once the tail rotor is gone */
  altErratic: 0.62,
  /** height change per frame */
  climb: 1 / 80,
  dive: 1 / 34,
  cruise: 1.05,
  strafe: 1.55,
  hover: 0.45,
  accel: 0.05,
  /** a player this close wakes it on its pad; it sees players this far (trees hide one beyond treeSight) */
  wake: 200,
  sight: 330,
  treeSight: 72,
  /** with nobody seen for this long it takes a rough fix (within searchErr px) on the nearest player every searchEvery frames */
  searchAfter: 60 * 8,
  searchEvery: 240,
  searchErr: 40,
  /** frames a new heading must hold before the body turns */
  turnHold: 10,
  cruiseFrames: [70, 110], // was 110-170 (2026-11-18: the fight was a walkover)
  strafeTell: 60,
  /** half the strafing line's length */
  strafeHalf: 100,
  strafeGap: 4, // was 6
  strafeLead: 16,
  strafeR: 8,
  strafeDmg: 1,
  /** chance it comes straight back for a second strafing run, by live pods (none, one, both), and that run's tell */
  again: [0.85, 0.55, 0.25],
  againTell: 46,
  salvoTell: 75,
  salvoGap: 9,
  /** rockets per live pod in a salvo's opening pattern, and chasers after it (marks that appear on the player) */
  perPod: 2,
  chasers: 1,
  /** a chaser's mark shows this long before its rocket leaves, and this long (about) before it lands */
  chaseHold: 22,
  chaseWarn: 52,
  chaseGap: 24,
  /** a salvo's marks ahead of a driving player are this far apart */
  markLead: 24,
  markR: 11, // was 10
  rocketDmg: 3, // was 2
  rocketSpeed: 3.2,
  popHide: 80,
  popTell: 42,
  /** frames it hangs low after an attack */
  recover: 60, // was 70
  /** an FPV drone strike that gets through does this (a pod in one; was ABIL.fpvDmg x 2 = 6 at any height) */
  droneDmg: 4,
  /** it judges a drone this many frames before the hit: flares out, or too low and slow to use them */
  flareAt: 18,
  /** frames a flare burns, and the gap between bursts while it keeps dumping them after a hit */
  flareLife: 54,
  flareGap: 26,
  /** frames it spins after losing the tail rotor */
  spin: 150,
  dieFrames: 170,
  /** its ground team: tanks that wait by the pad and then follow it to whoever it hunts (it had none before 2026-11-18) */
  escort: [0, 1, 2],
  scrap: 50, // was 500, and 25 a pod (2026-11-18 scrap economy: income cut to about a fifth, see SCRAP_DROP)
  partScrap: 6,
  captured: 2,
};

type Mode = 'lair' | 'takeoff' | 'cruise' | 'strafeGo' | 'strafeTell' | 'strafe' | 'salvoGo' | 'salvoTell' | 'salvoFire'
  | 'hideGo' | 'hide' | 'popTell' | 'recover' | 'spin';

export interface HeliPart extends BossPartLike {
  kind: 'pod' | 'tail' | 'engine';
  /** hit box in the up-facing 48 px frame (x, y, w, h) */
  rect: [number, number, number, number];
  side: number;
}

interface Mark {
  x: number; y: number; t0: number; at: number; done: boolean;
  /** a chaser: hidden until frame `show`, then placed on the target; its rocket leaves at `fireAt` */
  show?: number;
  fireAt?: number;
}
interface HRocket { x: number; y: number; sx: number; sy: number; tx: number; ty: number; t: number; dur: number; mark: Mark }
interface Strafe { sx: number; sy: number; ex: number; ey: number; d: number; walked: number; again: boolean }
interface Flare { x: number; y: number; vx: number; vy: number; t: number }

const S = 48;
const WHO = 'INTERCEPT';
/** the body's collision boxes in the up-facing frame: fuselage, stub wings, tail boom */
const BODY: [number, number, number, number][] = [[17, 2, 14, 34], [3, 18, 42, 12], [21, 34, 8, 14]];
/** where each pod's rockets leave (local) */
const POD_MUZZLE: Record<string, [number, number]> = { podL: [7.5, 18], podR: [40.5, 18] };
/** the attack warnings' pixel pen (marks.ts) */
const HELI_PEN = new OvPen();
const SPARK: RGB = [1, 1, 0.8];

export class HeliBoss implements BossLike, BossExtras {
  readonly kind = 'heli';
  readonly name = 'VULTURE';
  readonly title = 'ATTACK HELICOPTER';
  readonly goal = 'FIND THEIR GUNSHIP · SHOOT IT DOWN';
  readonly hudKey = 'heli';
  /** top-left of the body's 48 px box (the body as drawn; the shadow is offset from it by the height) */
  x = 0;
  y = 0;
  dir = DOWN;
  state: BossState = 'hidden';
  revealed = false;
  lair: [number, number] = [0, 0];
  lairNear = '';
  parts: HeliPart[];
  /** height 0..1 */
  alt = 0;
  vx = 0;
  vy = 0;
  mode: Mode = 'lair';
  modeT = 0;
  /** the last attack pattern (it avoids running the same one twice) */
  lastAttack = '';
  target: Tank | null = null;
  lastSeen = -1e9;
  lastAt: [number, number] | null = null;
  strafe: Strafe | null = null;
  marks: Mark[] = [];
  rockets: HRocket[] = [];
  /** decoy flares in the air (drawn; a drone drawn off flies into them) */
  flares: Flare[] = [];
  /** a drone got through on this pass: it dumps flares until it is back at cruising height */
  flaring = false;
  /** the hide spot / hover point it is flying to */
  goalPt: [number, number] = [0, 0];
  /** the tail rotor is gone: it wobbles and can't climb as high */
  erratic = false;
  hitT = 0;
  deathT = 0;
  deadT = 0;
  killer = -1;
  /** searchlight angle (radians, screen space) */
  lightAng = Math.PI / 2;
  /** rotor phase (frames of spin) */
  rotor = 0;
  /** where the crash left the wreck (top-left of the 48 px box) and its facing */
  wreck: [number, number, number] = [0, 0, 0];
  /** owner of its bullets and rocket damage (never in w.enemies) */
  readonly proxy: Tank;
  stats = {
    shellHits: 0, shellsUnder: 0, noPen: 0, droneHits: 0, rocketHits: 0, partsLost: 0, strafes: 0, strafeShots: 0,
    strafeHits: 0, salvos: 0, pops: 0, rockets: 0, rocketsHit: 0, deaths: 0, crashes: 0, columns: 0, decoys: 0, escorts: 0,
    ms: 0, msMax: 0, msSum: 0, n: 0,
  };
  log: string[] = [];

  private turnT = 0;
  private wantDir = DOWN;
  private chopT = 0;
  private lastPop = -1e9;
  private hinted = false;
  private highHint = false;
  private spinT = 0;
  private told = { strafe: false, salvo: false, pop: false, flares: false, dump: false, again: false };
  private judged = new WeakSet<object>();
  private orbit = rand() * Math.PI * 2;
  private spiral: [number, number, number, number] = [0, 0, 0, 0];

  constructor(private w: World) {
    const P = HELI.hp;
    this.parts = [
      { id: 'podL', name: 'LEFT ROCKET POD', short: 'POD', kind: 'pod', rect: [4, 18, 7, 12], side: -1, hp: P.pod, max: P.pod, hitT: 0 },
      { id: 'podR', name: 'RIGHT ROCKET POD', short: 'POD', kind: 'pod', rect: [37, 18, 7, 12], side: 1, hp: P.pod, max: P.pod, hitT: 0 },
      { id: 'tail', name: 'TAIL ROTOR', short: 'TAIL', kind: 'tail', rect: [20, 36, 13, 12], side: 0, hp: P.tail, max: P.tail, hitT: 0 },
      { id: 'engine', name: 'ENGINE', short: 'ENGINE', kind: 'engine', rect: [17, 3, 14, 31], side: 0, hp: P.engine, max: P.engine, hitT: 0 },
    ];
    const t = new Tank();
    t.player = -1;
    t.etype = 3;
    this.proxy = t;
    this.pickLair();
  }

  get cx(): number { return this.x + S / 2; }
  get cy(): number { return this.y + S / 2; }
  get turret(): HeliPart { return this.parts[3]; }
  get present(): boolean { return this.state !== 'hidden'; }
  get alive(): boolean { return this.state === 'lair' || this.state === 'hunt'; }
  /** low enough for shells and ambush rockets */
  get low(): boolean { return this.alt <= HELI.low + 1e-6; }
  /** The engine takes hits once the tail rotor is gone. */
  exposed(): boolean { return this.parts[2].hp <= 0; }
  cleared(): boolean { return this.state === 'dead' && this.deadT > 90; }
  townsToReveal(): number {
    const need = Math.min(HELI.reveal, this.w.towns.length);
    return Math.max(0, need - this.w.towns.filter((t) => t.freed).length);
  }
  hudShown(): boolean {
    if (!this.present) return false;
    if (this.state === 'dead') return this.deadT < 60 * 4;
    if (this.state === 'dying' || this.state === 'hunt') return true;
    return this.w.livePlayers().some((p) => Math.hypot(p.cx - this.cx, p.cy - this.cy) < 300);
  }
  /** Ambush squads may fire at it while it is low. */
  squadTarget(): [number, number] | null {
    return this.state === 'hunt' && this.low ? [this.cx, this.cy] : null;
  }

  private get ease(): number {
    const e = this.w.ease;
    return Number.isFinite(e) ? clamp(e, 0, 0.5) : 0;
  }
  private tell(n: number): number { return Math.round(n * (1 + this.ease)); }
  private logEv(s: string): void { logTo(this.log, this.w.frame, s); }
  private say(who: string, text: string): void { say(this.w, who, text, (s) => this.logEv(s)); }

  // ---------- geometry ----------
  partRect(p: HeliPart): [number, number, number, number] {
    const [x, y, w, h] = rotRect(p.rect, this.dir, S);
    return [this.x + x, this.y + y, w, h];
  }

  /** (wx, wy) is on the body (fuselage, wings, tail boom), `m` px of slack. */
  private onBody(wx: number, wy: number, m: number): boolean {
    for (const r of BODY) {
      const [x, y, w, h] = rotRect(r, this.dir, S);
      if (wx >= this.x + x - m && wx < this.x + x + w + m && wy >= this.y + y - m && wy < this.y + y + h + m) return true;
    }
    return false;
  }

  /** The body's footprint (a 36 px box round the centre): drone aims lock onto it; it never blocks tanks. */
  overlaps(x: number, y: number, w: number, h: number): boolean {
    return this.alive && overlap(x, y, w, h, this.x + 6, this.y + 6, S - 12, S - 12);
  }

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
    for (const p of this.parts) if (p.hitT > 0) p.hitT--;
    this.proxy.x = this.cx - 8;
    this.proxy.y = this.cy - 8;
    if (this.state === 'dying') this.updateDying();
    else if (this.state === 'dead') this.updateWreck();
    else {
      this.rotor += this.mode === 'lair' ? 0.35 : this.mode === 'strafe' || this.mode === 'strafeTell' ? 1.6 : 1.2;
      this.smoke();
      this.perceive();
      if (w.freeze === 0 && !w.over) {
        this.think();
        this.fly();
        this.turn();
      } else {
        this.vx *= 0.9;
        this.vy *= 0.9;
      }
      this.wash();
      this.aimLight();
      this.guard();
    }
    this.updateFlares();
    this.updateRockets();
    this.chop();
    const ms = performance.now() - t0;
    const s = this.stats;
    s.ms = ms;
    s.msMax = Math.max(s.msMax, ms);
    s.msSum += ms;
    s.n++;
  }

  // ---------- reveal ----------
  /** A pad on open ground far from the player's start, out of the towns. */
  private pickLair(): void {
    const w = this.w;
    const sp = w.region?.playerSpawns[0] ?? [w.pxW / 2, w.pxH - 32];
    const m = w.map;
    let best: [number, number] | null = null;
    let bs = -Infinity;
    for (let y = 24; y <= w.pxH - S - 24; y += 8) {
      for (let x = 24; x <= w.pxW - S - 24; x += 8) {
        if (w.towns.some((t) => overlap(x - 24, y - 24, S + 48, S + 48, t.rect[0], t.rect[1], t.rect[2], t.rect[3]))) continue;
        if (w.depots.some((d) => Math.abs(d.cx - x - S / 2) < 80 && Math.abs(d.cy - y - S / 2) < 80)) continue;
        let solid = 0;
        for (let cy = y / 4; cy < (y + S) / 4; cy += 2) for (let cx = x / 4; cx < (x + S) / 4; cx += 2) if (m.at(cx, cy) !== EMPTY && m.at(cx, cy) !== 6) solid++;
        let s = Math.hypot(x + S / 2 - sp[0], y + S / 2 - sp[1]) - solid * 14;
        s -= Math.max(0, 90 - Math.min(x, y, w.pxW - S - x, w.pxH - S - y)) * 2; // not hard against the edge
        if (s > bs) { bs = s; best = [x, y]; }
      }
    }
    this.lair = best ?? [Math.round((w.pxW - S) / 2), 24];
    // the region generator's lair (RegionSpec.lair: the centre of the Ruined Town's square) wins when there is one
    const gl = (w.region as { lair?: [number, number] } | undefined)?.lair;
    if (gl) this.lair = [clamp(Math.round((gl[0] - S / 2) / 8) * 8, 0, w.pxW - S), clamp(Math.round((gl[1] - S / 2) / 8) * 8, 0, w.pxH - S)];
    let bd = Infinity;
    for (const t of w.towns) {
      const d = Math.hypot(t.cx - this.lair[0] - S / 2, t.cy - this.lair[1] - S / 2);
      if (d < bd) { bd = d; this.lairNear = t.name; }
    }
  }

  /** On its pad, rotor idling; HQ radios it in. */
  reveal(): void {
    if (this.state !== 'hidden') return;
    const w = this.w;
    [this.x, this.y] = this.lair;
    const p = w.livePlayers()[0];
    this.dir = this.wantDir = p ? domDir(p.cx - this.cx, p.cy - this.cy) : DOWN;
    this.revealed = true;
    this.state = 'lair';
    this.mode = 'lair';
    this.alt = 0;
    this.say('HQ', `THEIR GUNSHIP IS ON A PAD NEAR ${this.lairNear || 'THE RUINS'}. CALLSIGN ${this.name}. SHELLS AND DRONES ONLY REACH IT WHEN IT FLIES LOW. HIGH UP IT DROPS FLARES.`);
    this.say(WHO, `${this.name}: I SEE YOUR LITTLE LIGHTS DOWN THERE. GOOD HUNTING WEATHER.`);
    w.note('BOSS LOCATED', 'warn');
    w.snd('column', this.cx, 1);
    const n = w.ai?.bossEscort(HELI.escort, this.name, () => [this.cx, this.cy, this.dir]) ?? 0;
    this.stats.escorts = n;
    this.logEv(`revealed at ${this.x},${this.y} near ${this.lairNear}, ground team ${n}`);
  }

  private wake(): void {
    if (this.state !== 'lair') return;
    this.state = 'hunt';
    this.setMode('takeoff');
    this.say(WHO, `${this.name}: LIFTING OFF. WEAPONS HOT.`);
    this.w.snd('heli-pitch', this.cx, 0.8);
    this.logEv('wakes');
  }

  // ---------- perception ----------
  private perceive(): void {
    const w = this.w;
    const range = this.state === 'lair' ? HELI.wake : HELI.sight;
    let best: Tank | null = null;
    let bd = Infinity;
    for (const p of w.livePlayers()) {
      const d = Math.hypot(p.cx - this.cx, p.cy - this.cy);
      if (d > range || d >= bd) continue;
      if (d > HELI.treeSight && this.inTrees(p) && !(this.target === p && w.frame - this.lastSeen < 120)) continue;
      best = p;
      bd = d;
    }
    if (best) {
      this.target = best;
      this.lastSeen = w.frame;
      this.lastAt = [best.cx, best.cy];
      this.wake();
    } else if (this.target && (!this.target.alive || w.frame - this.lastSeen > 60 * 6)) {
      this.target = null;
    }
    // lost them for a while: it comes looking (it used to go on attacking the last place it saw anyone, for ever,
    // however far the player had driven). Every few seconds it takes a rough fix on the nearest player and flies there.
    if (!best && this.state === 'hunt' && w.frame - this.lastSeen > HELI.searchAfter && w.frame % HELI.searchEvery === 0) {
      let near: Tank | null = null;
      let nd = Infinity;
      for (const p of w.livePlayers()) {
        const d = Math.hypot(p.cx - this.cx, p.cy - this.cy);
        if (d < nd) { nd = d; near = p; }
      }
      if (near) {
        this.lastAt = [near.cx + (rand() - 0.5) * HELI.searchErr * 2, near.cy + (rand() - 0.5) * HELI.searchErr * 2];
        this.logEv(`searching near ${Math.round(this.lastAt[0])},${Math.round(this.lastAt[1])}`);
      }
    }
  }

  private inTrees(p: Tank): boolean {
    const m = this.w.map;
    const cx = Math.round(p.x / 4);
    const cy = Math.round(p.y / 4);
    let n = 0;
    for (let y = cy; y < cy + 4; y++) for (let x = cx; x < cx + 4; x++) if (m.at(x, y) === TREES) n++;
    return n >= 8;
  }

  // ---------- the pattern machine ----------
  private setMode(m: Mode): void {
    this.mode = m;
    this.modeT = 0;
    if (m === 'cruise') this.flaring = false; // climbed away: the dispenser is ready for the next pass
    this.logEv(`mode ${m}`);
  }

  /** Where to aim attacks: the target, else its last sighting. */
  private aimAt(): [number, number] | null {
    return this.target ? [this.target.cx, this.target.cy] : this.lastAt;
  }

  private livePods(): HeliPart[] {
    return this.parts.filter((p) => p.kind === 'pod' && p.hp > 0);
  }

  private think(): void {
    const w = this.w;
    this.modeT++;
    const cruiseAlt = this.erratic ? HELI.altErratic : HELI.altCruise;
    switch (this.mode) {
      case 'lair':
        this.altTo(0);
        break;
      case 'takeoff':
        this.altTo(cruiseAlt);
        if (this.alt >= cruiseAlt - 0.05) this.setMode('cruise');
        break;
      case 'cruise': {
        this.altTo(cruiseAlt);
        const at = this.aimAt();
        if (at) {
          // circle the target at a stand-off distance
          this.orbit += 0.006;
          this.goalPt = this.clampPt(at[0] + Math.cos(this.orbit) * 110, at[1] + Math.sin(this.orbit) * 80);
        } else {
          this.goalPt = [this.lair[0] + S / 2 + Math.cos(this.orbit) * 60, this.lair[1] + S / 2 + Math.sin(this.orbit) * 60];
          this.orbit += 0.004;
        }
        const span = HELI.cruiseFrames;
        if (at && this.modeT >= this.tell(span[0] + ((w.frame * 7) % (span[1] - span[0])))) this.pickAttack(at);
        break;
      }
      case 'strafeGo': {
        this.altTo(cruiseAlt);
        const s = this.strafe!;
        // the line follows the target until the tell starts (then it is fixed: that is what the player dodges)
        const now = this.aimAt();
        if (now) this.lineThrough(s, now);
        this.goalPt = [s.sx, s.sy];
        if (Math.hypot(s.sx - this.cx, s.sy - this.cy) < 10 || this.modeT > 60 * 5) {
          this.setMode('strafeTell');
          this.stats.strafes++;
          w.snd('heli-pitch', this.cx, 1);
          if (!this.told.strafe) {
            this.told.strafe = true;
            w.note('STRAFING RUN! GET OFF THE LINE', 'warn');
          }
        }
        break;
      }
      case 'strafeTell': {
        const s = this.strafe!;
        this.goalPt = [s.sx, s.sy];
        this.altTo(HELI.altAttack);
        if (this.modeT >= this.strafeTellFrames()) this.setMode('strafe');
        break;
      }
      case 'strafe': {
        const s = this.strafe!;
        this.altTo(HELI.altAttack);
        this.goalPt = [s.ex, s.ey];
        const along = (this.cx - s.sx) * DX[s.d] + (this.cy - s.sy) * DY[s.d];
        const len = Math.abs(s.ex - s.sx) + Math.abs(s.ey - s.sy);
        if (this.modeT % HELI.strafeGap === 0 && along < len - 8) this.strafeShot(s);
        s.walked = along;
        if (along >= len - 6 || this.modeT > 60 * 6) {
          const at = this.aimAt();
          const back = !s.again && at && !this.flaring && rand() < HELI.again[this.livePods().length] * (1 - this.ease);
          this.strafe = null;
          if (back) {
            // straight back round for a second run, on a new line through the target
            this.startStrafe(at, true);
            if (!this.told.again) {
              this.told.again = true;
              w.note('IT IS COMING BACK ROUND!', 'warn');
            }
          } else {
            this.setMode('recover');
          }
        }
        break;
      }
      case 'salvoGo': {
        this.altTo(cruiseAlt);
        if (Math.hypot(this.goalPt[0] - this.cx, this.goalPt[1] - this.cy) < 12 || this.modeT > 60 * 8) {
          const at = this.aimAt();
          if (!at || !this.livePods().length) { this.setMode('cruise'); break; }
          this.setMode('salvoTell');
          this.stats.salvos++;
          this.placeMarks(at, this.livePods().length * HELI.perPod, this.tell(HELI.salvoTell), this.livePods().length * HELI.chasers);
          this.say(WHO, `${this.name}: ROCKETS ARMED. MARKING THE TARGET.`);
          if (!this.told.salvo) {
            this.told.salvo = true;
            w.note('ROCKETS INCOMING! LEAVE THE MARKS', 'warn');
          }
          w.snd('boss-charge', this.cx, 0.6);
        }
        break;
      }
      case 'salvoTell':
        this.altTo(HELI.altAttack);
        if (this.modeT % 15 === 1) w.snd('boss-charge', this.cx, 0.6);
        if (this.modeT >= this.tell(HELI.salvoTell)) this.setMode('salvoFire');
        break;
      case 'salvoFire': {
        this.altTo(this.lastAttack === 'pop' ? HELI.altPop : HELI.altAttack); // a pop-up fires from out of shell reach
        this.placeChasers();
        const waiting = this.marks.filter((m) => !m.done && !this.rockets.some((r) => r.mark === m));
        const pending = waiting.filter((m) => m.show === undefined || (m.show < 0 && w.frame >= m.fireAt!));
        if (pending.length && this.modeT % HELI.salvoGap === 1) this.fireRocket(pending[0], this.stats.rockets);
        if (!waiting.length && !this.rockets.length) this.setMode('recover');
        break;
      }
      case 'hideGo':
        this.altTo(cruiseAlt);
        if (Math.hypot(this.goalPt[0] - this.cx, this.goalPt[1] - this.cy) < 10 || this.modeT > 60 * 8) {
          this.setMode('hide');
          this.stats.pops++;
        }
        break;
      case 'hide':
        this.altTo(HELI.altAttack);
        if (this.modeT >= this.tell(HELI.popHide)) {
          const at = this.aimAt();
          if (!at || !this.livePods().length) { this.setMode('recover'); break; }
          this.setMode('popTell');
          this.placeMarks(at, this.livePods().length, this.tell(HELI.popTell), this.livePods().length * HELI.chasers);
          w.snd('heli-pitch', this.cx, 0.8);
          if (!this.told.pop) {
            this.told.pop = true;
            this.say(WHO, `${this.name}: POPPING UP. SURPRISE.`);
          }
        }
        break;
      case 'popTell':
        this.altTo(HELI.altPop);
        if (this.modeT % 12 === 1) w.snd('boss-charge', this.cx, 0.6);
        if (this.modeT >= this.tell(HELI.popTell)) this.setMode('salvoFire');
        break;
      case 'recover':
        this.altTo(HELI.altAttack);
        if (this.modeT >= this.tell(HELI.recover)) this.setMode('cruise');
        break;
      case 'spin':
        this.altTo(HELI.altAttack);
        if (++this.spinT % 6 === 0) this.dir = this.wantDir = (this.dir + 1) & 3;
        if (this.modeT >= HELI.spin) {
          this.setMode('cruise');
          this.say(WHO, `${this.name}: SHE FLIES. BARELY. FINISH THEM.`);
        }
        break;
    }
  }

  /** Pick the next attack: a strafing run, a rocket salvo or a pop-up from cover (no rockets once the pods are gone). */
  private pickAttack(at: [number, number]): void {
    const pods = this.livePods().length;
    const opts: [string, number][] = [['strafe', 1], ['salvo', pods ? 1 : 0], ['pop', pods ? 0.8 : 0]];
    for (const o of opts) if (o[0] === this.lastAttack) o[1] *= 0.25;
    let sum = 0;
    for (const o of opts) sum += o[1];
    let r = rand() * sum;
    let pick = 'strafe';
    for (const o of opts) {
      r -= o[1];
      if (r <= 0 && o[1] > 0) { pick = o[0]; break; }
    }
    if (pick === 'pop' && !this.startPop(at)) pick = 'salvo';
    if (pick === 'salvo') {
      // hover point ~100 px off the target, on the side it is coming from
      const a = Math.atan2(this.cy - at[1], this.cx - at[0]);
      this.goalPt = this.clampPt(at[0] + Math.cos(a) * 100, at[1] + Math.sin(a) * 100);
      this.setMode('salvoGo');
    } else if (pick === 'strafe') {
      this.startStrafe(at);
    }
    this.lastAttack = pick;
  }

  /** A line through the target along the axis it is furthest off; it starts on its own side. */
  private startStrafe(at: [number, number], again = false): void {
    const d = domDir(at[0] - this.cx, at[1] - this.cy);
    this.strafe = { sx: 0, sy: 0, ex: 0, ey: 0, d, walked: 0, again };
    this.lineThrough(this.strafe, at);
    this.setMode('strafeGo');
  }

  /** Lay strafing line s (its direction kept) through `at`. */
  private lineThrough(s: Strafe, at: [number, number]): void {
    const w = this.w;
    const h = HELI.strafeHalf;
    const m = 20;
    s.sx = clamp(at[0] - DX[s.d] * h, m, w.pxW - m);
    s.sy = clamp(at[1] - DY[s.d] * h, m, w.pxH - m);
    s.ex = clamp(at[0] + DX[s.d] * h, m, w.pxW - m);
    s.ey = clamp(at[1] + DY[s.d] * h, m, w.pxH - m);
  }

  /** Frames the strafing line blinks before the run (shorter when it comes back round). */
  private strafeTellFrames(): number {
    return this.tell(this.strafe?.again ? HELI.againTell : HELI.strafeTell);
  }

  /** A spot 95-140 px from the target with brick or steel between: it hides there low, then pops up. */
  private startPop(at: [number, number]): boolean {
    let best: [number, number] | null = null;
    let bd = Infinity;
    for (const r of [100, 120, 140]) {
      for (let k = 0; k < 16; k++) {
        const a = (k / 16) * Math.PI * 2;
        const [px, py] = this.clampPt(at[0] + Math.cos(a) * r, at[1] + Math.sin(a) * r);
        if (Math.hypot(px - at[0], py - at[1]) < 80 || !this.covered(at[0], at[1], px, py)) continue;
        const d = Math.hypot(px - this.cx, py - this.cy);
        if (d < bd) { bd = d; best = [px, py]; }
      }
    }
    if (!best) return false;
    this.goalPt = best;
    this.setMode('hideGo');
    return true;
  }

  /** Brick or steel along the line, past the first 24 px (the target's own cover doesn't count). */
  private covered(x0: number, y0: number, x1: number, y1: number): boolean {
    const m = this.w.map;
    const d = Math.hypot(x1 - x0, y1 - y0);
    let n = 0;
    for (let s = 24; s < d - 20; s += 3) {
      const c = m.at(Math.floor((x0 + ((x1 - x0) * s) / d) / 4), Math.floor((y0 + ((y1 - y0) * s) / d) / 4));
      if (c === BRICK || c === STEEL) n++;
    }
    return n >= 3;
  }

  private clampPt(x: number, y: number): [number, number] {
    return [clamp(x, 28, this.w.pxW - 28), clamp(y, 28, this.w.pxH - 28)];
  }

  private altTo(a: number): void {
    if (this.alt < a) this.alt = Math.min(a, this.alt + HELI.climb);
    else this.alt = Math.max(a, this.alt - HELI.dive);
  }

  // ---------- flight ----------
  private fly(): void {
    const m = this.mode;
    if (m === 'lair') { this.vx = this.vy = 0; return; }
    const max = m === 'strafe' ? HELI.strafe
      : m === 'strafeTell' || m === 'salvoTell' || m === 'salvoFire' || m === 'hide' || m === 'popTell' || m === 'recover' || m === 'spin' ? HELI.hover
      : m === 'takeoff' ? 0.2 : HELI.cruise;
    let [tx, ty] = this.goalPt;
    if (m === 'recover' || m === 'spin') [tx, ty] = [this.cx + this.vx * 20, this.cy + this.vy * 20];
    const dx = tx - this.cx;
    const dy = ty - this.cy;
    const d = Math.hypot(dx, dy);
    const sp = m === 'strafe' ? max : Math.min(max, d / 24);
    let wx = d > 1e-3 ? (dx / d) * sp : 0;
    let wy = d > 1e-3 ? (dy / d) * sp : 0;
    if (m === 'strafe' && this.strafe) {
      // straight down the line
      wx = DX[this.strafe.d] * max;
      wy = DY[this.strafe.d] * max;
    }
    const acc = m === 'strafe' ? 0.12 : HELI.accel;
    this.vx += (wx - this.vx) * acc;
    this.vy += (wy - this.vy) * acc;
    if (this.erratic || m === 'spin') {
      const f = this.w.frame;
      const k = m === 'spin' ? 0.12 : 0.05;
      this.vx += Math.sin(f * 0.13 + 1.7) * k;
      this.vy += Math.cos(f * 0.11) * k;
    }
    if (m === 'strafe' && this.strafe) {
      // stay on the line across it
      const s = this.strafe;
      if (DX[s.d]) this.vy += (s.sy - this.cy) * 0.1 - this.vy * 0.5;
      else this.vx += (s.sx - this.cx) * 0.1 - this.vx * 0.5;
    }
    const w = this.w;
    this.x = clamp(this.x + this.vx, 4 - S / 2 + 20, w.pxW - S / 2 - 20);
    this.y = clamp(this.y + this.vy, 4 - S / 2 + 20, w.pxH - S / 2 - 20);
  }

  /** The body turns in quarter turns, toward its travel (or the target while hovering). */
  private turn(): void {
    if (this.mode === 'spin' || this.mode === 'lair') return;
    let want = this.wantDir;
    const sp = Math.hypot(this.vx, this.vy);
    const at = this.aimAt();
    if (this.mode === 'strafe' || this.mode === 'strafeTell') want = this.strafe ? this.strafe.d : want;
    else if (sp > 0.35 && this.mode !== 'salvoTell' && this.mode !== 'salvoFire' && this.mode !== 'popTell') want = domDir(this.vx, this.vy);
    else if (at) want = domDir(at[0] - this.cx, at[1] - this.cy);
    if (want !== this.wantDir) {
      this.wantDir = want;
      this.turnT = 0;
    }
    if (this.wantDir !== this.dir && ++this.turnT >= HELI.turnHold) this.dir = this.wantDir;
  }

  // ---------- weapons ----------
  /** One chin-gun strike on the strafing line just ahead of the body. */
  private strafeShot(s: Strafe): void {
    const w = this.w;
    const x = this.cx + DX[s.d] * HELI.strafeLead + (rand() - 0.5) * 3;
    const y = this.cy + DY[s.d] * HELI.strafeLead + (rand() - 0.5) * 3;
    this.stats.strafeShots++;
    w.sparks(x, y, 3, [1, 0.8, 0.45]);
    w.flashes.push({ x, y, t: 0, max: 5, r: 20, col: [1, 0.75, 0.4], z: 6 });
    w.flashes.push({ x: this.cx + DX[s.d] * 12, y: this.cy + DY[s.d] * 12, t: 0, max: 3, r: 26, col: [1, 0.85, 0.5], z: 14 });
    w.parts.push({ x, y, z: 3, vx: (rand() - 0.5) * 0.3, vy: -0.15, vz: 0.2, life: 0, max: 30, col: [0.42, 0.4, 0.38], kind: 2, r: 2.5 });
    w.decals.push({ k: 1, x, y, r: 1.5, col: [0.03, 0.03, 0.03], a: 0.35 });
    w.snd('eshoot', x, 0.3);
    for (const p of w.livePlayers()) {
      if (Math.abs(p.cx - x) <= HELI.strafeR && Math.abs(p.cy - y) <= HELI.strafeR) {
        w.hitPlayer(p, this.proxy, HELI.strafeDmg);
        this.stats.strafeHits++;
      }
    }
  }

  /** Warning marks round (at): one on it, one or two ahead of a driving target (the way it is heading), the rest 16-26 px out. */
  private placeMarks(at: [number, number], n: number, warn: number, chasers = 0): void {
    const f = this.w.frame;
    const pts: [number, number][] = [[at[0] + (rand() - 0.5) * 6, at[1] + (rand() - 0.5) * 6]];
    const t = this.target;
    if (t?.alive && t.moving && n >= 2) {
      for (let k = 1; k <= (n >= 6 ? 2 : 1); k++) pts.push([at[0] + DX[t.dir] * HELI.markLead * k, at[1] + DY[t.dir] * HELI.markLead * k]);
    }
    for (let tries = 0; pts.length < n && tries < 40; tries++) {
      const a = rand() * Math.PI * 2;
      const r = 16 + rand() * 10;
      const p: [number, number] = [at[0] + Math.cos(a) * r, at[1] + Math.sin(a) * r];
      if (pts.some(([px, py]) => Math.hypot(px - p[0], py - p[1]) < 14)) continue;
      pts.push(p);
    }
    this.marks = pts.map(([x, y], i) => ({ x: clamp(x, 4, this.w.pxW - 4), y: clamp(y, 4, this.w.pxH - 4), t0: f, at: f + warn + i * HELI.salvoGap + 30, done: false }));
    // the chasers: hidden for now, each appears on the target once the opening pattern has gone
    const first = f + warn + pts.length * HELI.salvoGap + 16;
    for (let k = 0; k < chasers; k++) {
      const show = first + k * this.tell(HELI.chaseGap);
      this.marks.push({ x: 0, y: 0, t0: show, at: show + this.tell(HELI.chaseWarn), done: false, show, fireAt: show + this.tell(HELI.chaseHold) });
    }
  }

  /** A chaser's mark appears where the target is now (a little ahead of one that is driving). */
  private placeChasers(): void {
    const w = this.w;
    for (const m of this.marks) {
      if (m.done || m.show === undefined || m.show < 0 || w.frame < m.show) continue;
      const at = this.aimAt();
      if (!at || !this.livePods().length) { m.done = true; continue; }
      const t = this.target;
      const lead = t?.alive && t.moving ? 8 : 0;
      m.x = clamp(at[0] + (t ? DX[t.dir] * lead : 0) + (rand() - 0.5) * 4, 4, w.pxW - 4);
      m.y = clamp(at[1] + (t ? DY[t.dir] * lead : 0) + (rand() - 0.5) * 4, 4, w.pxH - 4);
      m.t0 = w.frame;
      m.show = -1;
      w.snd('boss-charge', m.x, 0.6);
    }
  }

  private fireRocket(m: Mark, i: number): void {
    const w = this.w;
    const pods = this.livePods();
    if (!pods.length) { m.done = true; return; }
    const pod = pods[i % pods.length];
    const [lx, ly] = POD_MUZZLE[pod.id];
    const [px, py] = rotPt(lx, ly, this.dir, S);
    const sx = this.x + px;
    const sy = this.y + py;
    const d = Math.hypot(m.x - sx, m.y - sy);
    this.rockets.push({ x: sx, y: sy, sx, sy, tx: m.x, ty: m.y, t: 0, dur: Math.max(8, Math.round(d / HELI.rocketSpeed)), mark: m });
    this.stats.rockets++;
    w.snd('trick-rocket', sx, 0.9);
    w.flashes.push({ x: sx, y: sy, t: 0, max: 8, r: 34, col: [1, 0.7, 0.35], z: 14 });
    for (let k = 0; k < 3; k++) {
      w.parts.push({ x: sx, y: sy, z: 10, vx: (rand() - 0.5) * 0.4, vy: (rand() - 0.5) * 0.4, vz: 0, life: 0, max: 36, col: [0.6, 0.58, 0.55], kind: 2, r: 2.5 });
    }
  }

  private updateRockets(): void {
    if (!this.rockets.length) {
      if (this.marks.length && this.marks.every((m) => m.done)) this.marks = [];
      return;
    }
    const w = this.w;
    const keep: HRocket[] = [];
    for (const r of this.rockets) {
      r.t++;
      const k = Math.min(1, r.t / r.dur);
      r.x = r.sx + (r.tx - r.sx) * k;
      r.y = r.sy + (r.ty - r.sy) * k;
      if (w.frame % 2 === 0) w.parts.push({ x: r.x, y: r.y, z: 8, vx: (rand() - 0.5) * 0.1, vy: (rand() - 0.5) * 0.1, vz: 0, life: 0, max: 30, col: [0.62, 0.6, 0.56], kind: 2, r: 1.8 });
      if (k < 1) { keep.push(r); continue; }
      this.rocketImpact(r.tx, r.ty);
      r.mark.done = true;
    }
    this.rockets = keep;
  }

  private rocketImpact(x: number, y: number): void {
    const w = this.w;
    w.booms.push({ x, y, big: true, t: 0 });
    w.flashes.push({ x, y, t: 0, max: 26, r: 70, col: [1, 0.6, 0.25], z: 14 });
    w.decals.push({ k: 1, x, y, r: 7, col: [0.025, 0.022, 0.02], a: 0.6 });
    w.sparks(x, y, 9, [1, 0.7, 0.3]);
    for (let i = 0; i < 3; i++) smokePuff(w, x, y, false, 6);
    w.snd('explode', x, 0.9);
    w.shake = Math.max(w.shake, 2);
    for (const p of w.livePlayers()) {
      if (Math.hypot(p.cx - x, p.cy - y) <= HELI.markR) {
        w.hitPlayer(p, this.proxy, HELI.rocketDmg);
        this.stats.rocketsHit++;
      }
    }
    const m = w.map;
    for (let cy = Math.floor((y - 7) / 4); cy <= Math.floor((y + 7) / 4); cy++) {
      for (let cx = Math.floor((x - 7) / 4); cx <= Math.floor((x + 7) / 4); cx++) {
        if (m.at(cx, cy) !== BRICK || Math.hypot(cx * 4 + 2 - x, cy * 4 + 2 - y) > 7) continue;
        m.set(cx, cy, EMPTY);
        if (rand() < 0.5) w.debris(cx * 4 + 2, cy * 4 + 2, Math.floor(rand() * 4));
      }
    }
  }

  // ---------- sound, rotor wash, searchlight ----------
  private chop(): void {
    const w = this.w;
    if (this.state === 'dead' || this.state === 'hidden') return;
    const every = this.state === 'dying' ? 5 : this.mode === 'lair' ? 14 : this.mode === 'strafe' || this.mode === 'strafeTell' || this.mode === 'spin' ? 6 : 8;
    if (++this.chopT < every) return;
    this.chopT = 0;
    let d = Infinity;
    for (const p of w.livePlayers()) d = Math.min(d, Math.hypot(p.cx - this.cx, p.cy - this.cy));
    w.snd('heli-chop', this.cx, (this.mode === 'lair' ? 0.5 : 1) * (0.15 + 0.85 * clamp(1 - d / 420, 0, 1)));
  }

  /** Low over the ground the downdraft throws up spray and grit. */
  private wash(): void {
    const w = this.w;
    if (this.alt > 0.5 || this.mode === 'lair' || w.frame % 4) return;
    const a = rand() * Math.PI * 2;
    const r = 14 + rand() * 10;
    const k = 1 - this.alt * 1.6;
    w.parts.push({
      x: this.cx + Math.cos(a) * r, y: this.cy + Math.sin(a) * r, z: 2, vx: Math.cos(a) * 0.9 * k, vy: Math.sin(a) * 0.9 * k, vz: 0.05,
      life: 0, max: 28, col: [0.5, 0.52, 0.56], kind: 2, r: 2 + rand() * 2,
    });
  }

  private aimLight(): void {
    const at = this.aimAt();
    const f = this.w.frame;
    let want: number;
    if (at && this.target) want = Math.atan2(at[1] - this.cy, at[0] - this.cx) + Math.sin(f * 0.05) * 0.18;
    else want = Math.atan2(DY[this.dir], DX[this.dir]) + Math.sin(f * 0.02) * 0.7;
    let d = want - this.lightAng;
    while (d > Math.PI) d -= Math.PI * 2;
    while (d < -Math.PI) d += Math.PI * 2;
    this.lightAng += d * 0.06;
  }

  // ---------- damage ----------
  /** World.bulletHit hook: a player shell meets the body, if it is low enough; higher up it passes beneath. */
  bulletHit(b: Bullet): boolean {
    if (!this.alive || b.owner === this.proxy || !b.owner.isPlayer) return false;
    if (!this.onBody(b.x, b.y, 1)) return false;
    const w = this.w;
    if (!this.low) {
      this.stats.shellsUnder++;
      if (w.frame - this.lastPop > 90) {
        this.lastPop = w.frame;
        w.popups.push({ x: b.x, y: b.y - 8, text: 'TOO HIGH', t: 0, col: [0.75, 0.8, 0.88] });
      }
      if (!this.highHint) {
        this.highHint = true;
        w.note('TOO HIGH: WAIT TILL IT COMES DOWN', 'info');
      }
      return false;
    }
    b.alive = false;
    const dmg = 1 + (b.owner.firepower >= 1 ? 1 : 0);
    this.stats.shellHits++;
    this.hitAt(b.x, b.y, dmg, b.owner.player, 'shell');
    return true;
  }

  /** An FPV drone that got past the flares (guard() judged it on the way in): HELI.droneDmg, then it dumps flares. */
  droneHit(x: number, y: number, _dmg: number, pi: number): boolean {
    if (!this.alive || !this.onBody(x, y, 5)) return false;
    this.stats.droneHits++;
    this.hitAt(x, y, HELI.droneDmg, pi, 'drone');
    if (this.alive) {
      this.flaring = true;
      this.popFlares(6);
      if (!this.told.dump) {
        this.told.dump = true;
        this.w.note('IT DUMPS FLARES: ONE DRONE PER PASS', 'info');
      }
    }
    return true;
  }

  /** A drone launched now would get through: asleep on its pad, or low with its flares not yet dumped. */
  droneOpen(): boolean {
    return this.alive && (this.mode === 'lair' || (this.low && !this.flaring));
  }

  // ---------- flares ----------
  /**
   * Its counter to FPV drones: each one flying at it is judged once, HELI.flareAt frames before the hit. High up, or
   * still dumping flares after a hit on this pass, it decoys the drone (a burst of flares, the drone swerves into
   * them). Low and slow in an attack, the first drone gets through.
   */
  private guard(): void {
    const w = this.w;
    const ab = w.abil;
    if (ab?.fpvs.length) {
      for (const f of ab.fpvs) {
        if (this.judged.has(f)) continue;
        const left = ab.bossBound(f);
        if (left < 0 || left > HELI.flareAt) continue;
        this.judged.add(f);
        if (this.droneOpen()) continue;
        const [fx, fy] = this.popFlares(6, f.x, f.y);
        ab.divert(f, fx, fy, 'DECOYED');
        this.stats.decoys++;
        this.logEv(`flares decoy a drone (alt ${this.alt.toFixed(2)}${this.flaring ? ', dumping' : ''})`);
        if (!this.told.flares) {
          this.told.flares = true;
          w.note(this.low ? 'FLARES! ONE DRONE PER PASS' : 'FLARES! DRONES ONLY HIT IT DOWN LOW', 'warn');
          this.say('WASP', 'HE DROPPED FLARES AND MY BIRD CHASED THEM. SEND THE NEXT ONE WHEN HE COMES DOWN LOW TO SHOOT.');
        }
      }
    }
    // after a hit it keeps dumping them until it has climbed away
    if (this.flaring && this.modeT % HELI.flareGap === 0) this.popFlares(2);
  }

  /**
   * A burst of n flares off both flanks, falling behind it. Returns where a drone coming from (fromX, fromY) is drawn
   * to: the flank nearer the drone.
   */
  private popFlares(n: number, fromX?: number, fromY?: number): [number, number] {
    const w = this.w;
    const fx = DX[this.dir];
    const fy = DY[this.dir];
    // across the body
    const qx = -fy;
    const qy = fx;
    const side0 = fromX === undefined ? 1 : Math.sign((fromX - this.cx) * qx + (fromY! - this.cy) * qy) || 1;
    for (let i = 0; i < n; i++) {
      const side = i % 2 ? -side0 : side0;
      const sp = 0.9 + (i >> 1) * 0.35 + rand() * 0.25;
      const back = 0.25 + (i >> 1) * 0.3;
      this.flares.push({
        x: this.cx + qx * side * 10, y: this.cy + qy * side * 10,
        vx: qx * side * sp - fx * back + this.vx * 0.5 + (rand() - 0.5) * 0.2, vy: qy * side * sp - fy * back + this.vy * 0.5 + (rand() - 0.5) * 0.2, t: 0,
      });
    }
    w.flashes.push({ x: this.cx, y: this.cy, t: 0, max: 14, r: 90, col: [1, 0.85, 0.6], z: 20 });
    w.snd('trick-rocket', this.cx, 0.45);
    w.snd('ricochet', this.cx, 0.35);
    if (n > 2 && w.frame - this.lastPop > 60) {
      this.lastPop = w.frame;
      w.popups.push({ x: this.cx, y: this.cy - 30, text: 'FLARES', t: 0, col: [1, 0.85, 0.5] });
    }
    return [clamp(this.cx + qx * side0 * 38 - fx * 12, 4, w.pxW - 4), clamp(this.cy + qy * side0 * 38 - fy * 12, 4, w.pxH - 4)];
  }

  private updateFlares(): void {
    if (!this.flares.length) return;
    const w = this.w;
    const keep: Flare[] = [];
    for (const f of this.flares) {
      f.t++;
      f.x += f.vx;
      f.y += f.vy;
      f.vx *= 0.965;
      f.vy = f.vy * 0.965 + 0.012; // they sink as they burn
      if (f.t % 4 === 0) w.parts.push({ x: f.x, y: f.y, z: 14, vx: (rand() - 0.5) * 0.1, vy: -0.05, vz: 0, life: 0, max: 34, col: [0.78, 0.76, 0.72], kind: 2, r: 1.6 });
      if (f.t < HELI.flareLife) keep.push(f);
    }
    this.flares = keep;
  }

  /** Ambush rockets: only while it is low. */
  rocketHit(x: number, y: number, _dir: number, dmg: number, pi: number): boolean {
    if (!this.alive || !this.low || !this.onBody(x, y, 1)) return false;
    this.stats.rocketHits++;
    this.hitAt(x, y, dmg, pi, 'shell');
    return true;
  }

  /** Where a tap-launched drone should go: the weakest live pod or the tail, then the engine. */
  aimPoint(): [number, number] {
    let best: HeliPart | null = null;
    for (const p of this.parts) if (p.kind !== 'engine' && p.hp > 0 && (!best || p.hp < best.hp)) best = p;
    const q = this.exposed() || !best ? this.turret : best;
    const [x, y, w, h] = this.partRect(q);
    return [x + w / 2, y + h / 2];
  }

  private partAt(lx: number, ly: number, margin: number): HeliPart | null {
    for (const p of this.parts) {
      if (p.kind === 'engine' || p.hp <= 0) continue;
      const [x, y, w, h] = p.rect;
      if (lx >= x - margin && lx < x + w + margin && ly >= y - margin && ly < y + h + margin) return p;
    }
    return null;
  }

  private hitAt(wx: number, wy: number, dmg: number, pi: number, kind: 'shell' | 'drone'): void {
    const w = this.w;
    const [lx, ly] = toLocal(wx, wy, this.x, this.y, this.dir, S);
    let part = this.partAt(lx, ly, kind === 'drone' ? 4 : 2);
    if (!part && this.exposed()) part = this.turret;
    if (!part && kind === 'drone') {
      // a drone goes for the nearest weak point it can see
      let bd = Infinity;
      for (const p of this.parts) {
        if (p.kind === 'engine' || p.hp <= 0) continue;
        const d = Math.hypot(p.rect[0] + p.rect[2] / 2 - lx, p.rect[1] + p.rect[3] / 2 - ly);
        if (d < bd) { bd = d; part = p; }
      }
    }
    if (this.state === 'lair') this.wake();
    if (!part) {
      this.noPen(wx, wy);
      return;
    }
    part.hp = Math.max(0, part.hp - dmg);
    part.hitT = 10;
    this.hitT = 3;
    w.sparks(wx, wy, 6 + dmg * 2, [1, 0.8, 0.45]);
    w.flashes.push({ x: wx, y: wy, t: 0, max: 10, r: 40 + dmg * 6, col: [1, 0.6, 0.3], z: 14 });
    w.booms.push({ x: wx, y: wy, big: false, t: 0 });
    w.shake = Math.max(w.shake, 1 + dmg * 0.3);
    w.snd('armor', wx, 1);
    w.popups.push({ x: wx, y: wy - 8, text: `-${dmg}`, t: 0, col: [1, 0.6, 0.3] });
    this.logEv(`${kind} hit ${part.id} -${dmg} (${part.hp}/${part.max}) alt ${this.alt.toFixed(2)}`);
    if (part.hp <= 0) this.partLost(part, pi);
  }

  private noPen(wx: number, wy: number): void {
    const w = this.w;
    this.stats.noPen++;
    w.sparks(wx, wy, 7, [1, 0.95, 0.8]);
    w.flashes.push({ x: wx, y: wy, t: 0, max: 6, r: 26, col: [1, 0.9, 0.7], z: 12 });
    w.snd('steel', wx, 1);
    if (w.frame - this.lastPop > 90) {
      this.lastPop = w.frame;
      w.popups.push({ x: wx, y: wy - 8, text: 'NO PEN', t: 0, col: [0.75, 0.8, 0.88] });
    }
    if (!this.hinted) {
      this.hinted = true;
      w.note('ARMOURED TUB: HIT THE PODS AND THE TAIL', 'info');
    }
  }

  private partLost(p: HeliPart, pi: number): void {
    const w = this.w;
    const [x, y, pw, ph] = this.partRect(p);
    const cx = x + pw / 2;
    const cy = y + ph / 2;
    this.stats.partsLost++;
    if (p.kind === 'engine') {
      this.die(pi);
      return;
    }
    w.explode(cx, cy, true);
    w.shocks.push({ x: cx, y: cy, t: 0, max: 26, size: 0.9 });
    w.shake = Math.max(w.shake, 4);
    w.snd('boss-part', cx, 0.8);
    debrisBurst(w, cx, cy, 10, [[0.28, 0.3, 0.27], [0.16, 0.16, 0.16]], 1.4, 10);
    w.scrap += HELI.partScrap;
    w.popups.push({ x: cx, y: cy - 14, text: `+${HELI.partScrap} SCRAP`, t: 0, col: [1, 0.85, 0.4] });
    w.note(`${p.name} DESTROYED`, 'power');
    if (pi >= 0) w.addVetXp(pi, 0.25);
    this.hinted = false;
    this.logEv(`${p.id} destroyed`);
    if (p.kind === 'pod') {
      // the pod's rockets go too: drop marks it would have fired at
      if (!this.livePods().length) {
        this.say(WHO, `${this.name}: BOTH PODS GONE. GUN ONLY. CALLING GROUND UNITS.`);
        this.say('SPANNER', 'NO MORE ROCKETS. NOW THE TAIL ROTOR, THEN HIS ENGINE.');
        const at = this.target ?? w.livePlayers()[0];
        if (w.ai?.bossColumn(at ? at.x : this.cx - 8, at ? at.y : this.cy - 8)) this.stats.columns++;
      } else {
        this.say(WHO, `${this.name}: LOST A POD. STILL GOT TEETH. GROUND TEAM, MOVE UP.`);
        const at = this.target ?? w.livePlayers()[0];
        if (w.ai?.bossColumn(at ? at.x : this.cx - 8, at ? at.y : this.cy - 8)) this.stats.columns++;
      }
    } else {
      // tail rotor: it spins down low, then flies on erratically with the engine open
      this.erratic = true;
      this.strafe = null;
      this.spinT = 0;
      this.setMode('spin');
      this.say(WHO, `${this.name}: TAIL ROTOR GONE! I CANNOT HOLD HER!`);
      this.say('SPANNER', 'HIS TAIL IS GONE. THE ENGINE IS OPEN NOW. HIT THE MIDDLE.');
      w.note('ENGINE EXPOSED', 'info');
    }
  }

  /** Debug and sim: destroy it now (revealing it first if needed). */
  kill(pi = -1): void {
    if (this.state === 'hidden') this.reveal();
    if (!this.alive) return;
    this.turret.hp = 0;
    this.die(pi);
  }

  private die(pi: number): void {
    const w = this.w;
    if (!this.alive) return;
    this.state = 'dying';
    this.deathT = 0;
    this.killer = pi;
    this.strafe = null;
    this.stats.deaths++;
    // spiral down round a point beside it
    const a = rand() * Math.PI * 2;
    this.spiral = [this.cx - Math.cos(a) * 26, this.cy - Math.sin(a) * 26, a, Math.max(this.alt, 0.35)];
    this.say(WHO, `${this.name}: MAYDAY, MAYDAY! GOING DOWN!`);
    w.note(`${this.name} IS GOING DOWN`, 'power');
    w.shake = Math.max(w.shake, 5);
    w.explode(this.cx, this.cy, true);
    this.logEv('dying');
  }

  // ---------- death: a smoking spiral, the crash, the wreck ----------
  private updateDying(): void {
    const w = this.w;
    const t = ++this.deathT;
    const k = t / HELI.dieFrames;
    const [ox, oy, a0, alt0] = this.spiral;
    const a = a0 + t * 0.07 + t * t * 0.0002;
    const rad = 26 * (1 - k * 0.8);
    this.x = clamp(ox + Math.cos(a) * rad, 4, w.pxW - 4) - S / 2;
    this.y = clamp(oy + Math.sin(a) * rad, 4, w.pxH - 4) - S / 2;
    this.alt = alt0 * Math.pow(1 - k, 1.3);
    this.rotor += 0.9;
    if (t % Math.max(3, 9 - Math.floor(t / 25)) === 0) this.dir = (this.dir + 1) & 3;
    this.hitT = (t >> 2) & 1 ? 3 : 0;
    if (t % 2 === 0) smokePuff(w, this.cx + (rand() - 0.5) * 8, this.cy + (rand() - 0.5) * 8, true, 10 + this.alt * 20);
    if (t % 18 === 0) {
      const x = this.cx + (rand() - 0.5) * 24;
      const y = this.cy + (rand() - 0.5) * 24;
      w.explode(x, y, false);
      w.sparks(x, y, 8, [1, 0.75, 0.35]);
      w.snd('explode', x, 0.7);
    }
    if (t >= HELI.dieFrames) this.crash();
  }

  private crash(): void {
    const w = this.w;
    const x = this.cx;
    const y = this.cy;
    this.state = 'dead';
    this.deadT = 0;
    this.alt = 0;
    this.stats.crashes++;
    this.wreck = [this.x, this.y, this.dir];
    w.explode(x, y, true);
    w.explode(x - 12, y + 8, true);
    w.explode(x + 10, y - 9, true);
    w.flashes.push({ x, y, t: 0, max: 100, r: 240, col: [1, 0.55, 0.2], z: 30 });
    w.shocks.push({ x, y, t: 0, max: 60, size: 3 });
    w.shocks.push({ x, y, t: 0, max: 36, size: 1.5 });
    w.shake = 10;
    w.snd('bigexplode', x, 1);
    w.snd('explode', x, 1);
    debrisBurst(w, x, y, 30, [[0.28, 0.3, 0.27], [0.2, 0.2, 0.2], [0.5, 0.5, 0.52]], 2.4, 10);
    for (let i = 0; i < 12; i++) smokePuff(w, x + (rand() - 0.5) * 30, y + (rand() - 0.5) * 30, true);
    w.decals.push({ k: 1, x, y, r: 26, col: [0.02, 0.02, 0.02], a: 0.6 });
    // rotor blades flung out: scorch streaks
    for (let i = 0; i < 4; i++) {
      const a = rand() * Math.PI * 2;
      for (let s = 10; s < 30; s += 3) w.decals.push({ k: 0, x: x + Math.cos(a) * s, y: y + Math.sin(a) * s, w: 2, h: 2, col: [0.03, 0.03, 0.03], a: 0.5 });
    }
    // rewards
    w.stats.boss++;
    w.stats.bossScrap += HELI.scrap;
    w.scrap += HELI.scrap;
    w.popups.push({ x, y: y - 30, text: `+${HELI.scrap} SCRAP`, t: 0, col: [1, 0.85, 0.4] });
    for (let i = 0; i < HELI.captured; i++) {
      const id = w.rollFound(true);
      w.partsFound++;
      w.popups.push({ x, y: y - 20 + i * 8, text: id ? '+CAPTURED PART' : '+1 PART', t: 0, col: [0.6, 0.9, 1] });
    }
    w.snd('part', x, 0.9);
    w.note(`${this.name} SHOT DOWN`, 'power');
    if (this.killer >= 0) w.addVetXp(this.killer, 1);
    this.say('HQ', `${this.name} IS DOWN. NO MORE SEARCHLIGHTS OVER THE RUINS. THIS REGION IS OURS.`);
    this.say('SPANNER', 'I AM HAVING THAT ROTOR. DO NOT ASK WHAT FOR.');
    this.logEv('crashed');
  }

  private updateWreck(): void {
    const t = ++this.deadT;
    const every = t < 60 * 30 ? 4 : 14;
    if (this.w.frame % every === 0) smokePuff(this.w, this.cx + (rand() - 0.5) * 20, this.cy + (rand() - 0.5) * 16, t < 60 * 30);
  }

  /** Black smoke from destroyed parts while it flies. */
  private smoke(): void {
    const w = this.w;
    if (w.frame % 6 !== 0) return;
    for (const p of this.parts) {
      if (p.hp > 0 && p.hp > p.max / 2) continue;
      if (p.hp > 0 && w.frame % 18 !== 0) continue;
      const [x, y, pw, ph] = this.partRect(p);
      smokePuff(w, x + pw / 2, y + ph / 2, p.hp <= 0, 12 + this.alt * 18);
    }
  }

  // ---------- drawing (draw.ts hook; screen = world + ox/oy) ----------
  draw(r: Renderer, ox: number, oy: number, time: number, head: number): void {
    if (!this.present) return;
    const w = this.w;
    const A = r.atlas.S;
    const f = w.frame;
    const on = (sx: number, sy: number, m: number) => sx > -m && sy > -m && sx < r.nw + m && sy < r.nh + m;
    this.drawMarks(r, ox, oy, f);
    this.drawStrafe(r, ox, oy, f);
    this.drawFlares(r, ox, oy, time);
    for (const k of this.rockets) {
      const sx = ox + k.x;
      const sy = oy + k.y;
      if (!on(sx, sy, 20)) continue;
      r.glow(sx, sy, 3, [1, 0.75, 0.35], 2.6);
      r.glow(sx - (k.tx - k.sx) / k.dur * 1.5, sy - (k.ty - k.sy) / k.dur * 1.5, 2, [1, 0.5, 0.2], 1.4);
      r.light(sx, sy, 10, 40, 1.0, 0.6, 0.25, true);
    }
    const x = Math.round(ox + this.x);
    const y = Math.round(oy + this.y);
    if (x < -120 || y < -120 || x > r.nw + 120 || y > r.nh + 120) return;
    const white: RGB = [1, 1, 1];
    if (this.state === 'dead') {
      const [wx, wy, wd] = this.wreck;
      const sx = Math.round(ox + wx);
      const sy = Math.round(oy + wy);
      r.spr(A.heliWreck, sx, sy, wd, [0.85, 0.8, 0.76], MAT_STD, 0, 1);
      const fl = 0.6 + 0.4 * Math.sin(time * 11) * Math.sin(time * 4.3);
      const k = this.deadT < 60 * 30 ? 1 : 0.35;
      r.light(sx + 24, sy + 22, 16, 70 * k + 20, 1.0 * k * fl, 0.42 * k * fl, 0.1 * k * fl, true);
      r.glow(sx + 22, sy + 26, 3 * k + 1, [1, 0.5, 0.15], 0.8 * fl);
      r.glow(sx + 28, sy + 19, 2 * k + 1, [1, 0.65, 0.25], 0.6 * fl);
      return;
    }
    // the shadow: away from the sun, further and smaller the higher it flies
    const sd = r.env.sunDir;
    const sl = Math.hypot(sd[0], sd[1]) || 1;
    const off = 2 + this.alt * 26;
    const scale = 1 - this.alt * 0.22;
    const shx = ox + this.cx - (sd[0] / sl) * off;
    const shy = oy + this.cy - (sd[1] / sl) * off;
    const dk = 0.32 + this.alt * 0.18;
    const sh = A.heliShadow;
    const ssz = sh.w * scale;
    r.shadeSpr(sh, Math.round(shx - ssz / 2), Math.round(shy - ssz / 2), this.dir, dk, scale);
    const disc = A.heliDiscShadow;
    const dsz = disc.w * scale;
    r.shadeSpr(disc, Math.round(shx - dsz / 2), Math.round(shy - dsz / 2), 0, 0.82 + this.alt * 0.1, scale);

    r.top = true;
    // at night the airframe glows faintly (cockpit and instrument light, wet paint catching the town fires)
    const em = w.env === 'night' || w.env === 'dusk' ? 1 : 0;
    const flash = this.hitT > 0 ? 0.3 : 0;
    const dir = this.dir;
    const dying = this.state === 'dying';
    r.spr(A.heliBody, x, y, dir, white, MAT_STD, 0.05, em, flash);
    for (const p of this.parts) {
      if (p.kind === 'engine') continue;
      const [px, py] = this.partRect(p);
      const sx = Math.round(ox + px);
      const sy = Math.round(oy + py);
      const pf = p.hitT > 6 ? 0.65 : flash;
      if (p.kind === 'pod') {
        r.spr(A[p.hp > 0 ? 'heliPod' : 'heliPodDead'], sx, sy, dir, white, MAT_STD, 0.05, Math.max(em, p.hp > 0 ? 0 : 1), pf);
        if (p.hp <= 0) {
          const [cx, cy] = rotPt(p.rect[0] + 3.5, p.rect[1] + 6, dir, S);
          const fl = 0.6 + 0.4 * Math.sin(time * 17 + p.side * 3);
          r.glow(x + cx, y + cy, 2.5, [1, 0.5, 0.15], 0.9 * fl);
          r.light(x + cx, y + cy, 14, 26, 0.5 * fl, 0.22 * fl, 0.05 * fl, false);
        }
      } else if (p.hp > 0) {
        r.spr(A[`heliTail${Math.floor(this.rotor / 2) % 2}`], sx, sy, dir, white, MAT_STD, 0.05, em, pf);
      } else {
        r.spr(A.heliTailDead, sx, sy, dir, white, MAT_STD, 0.05, 1, pf);
        if ((f >> 2) & 1) {
          const [cx, cy] = rotPt(26, 44, dir, S);
          r.glow(x + cx, y + cy, 1.8, [1, 0.7, 0.3], 1.6);
        }
      }
    }
    // the rotor: six blade positions cycled fast read as a blur, over a faint disc
    const rf = Math.floor(this.rotor) % 6;
    const rs = A[`heliRotor${rf}`];
    r.spr(rs, x + 24 - rs.w / 2, y + 22 - rs.h / 2, 0, white, MAT_STD, 0.1, em, 0);
    r.smoke(ox + this.cx, oy + this.cy - 2, 22, [0.55, 0.58, 0.62], this.mode === 'lair' ? 0.03 : 0.07);
    r.top = false;

    // lights: a red beacon, wingtip navigation lights, the cockpit's glow
    const blink = f % 50 < 6 ? 1 : 0;
    const [bx, by] = rotPt(24, 30, dir, S);
    r.glow(x + bx, y + by, 2, [1, 0.12, 0.08], 0.4 + 2.6 * blink);
    if (blink) r.light(x + bx, y + by, 18, 50, 0.9, 0.05, 0.03, false);
    const [lx, ly] = rotPt(3, 23, dir, S);
    const [gx, gy] = rotPt(45, 23, dir, S);
    r.glow(x + lx, y + ly, 1.2, [1, 0.15, 0.1], 1.4);
    r.glow(x + gx, y + gy, 1.2, [0.2, 1, 0.3], 1.4);
    const [kx, ky] = rotPt(24, 8, dir, S);
    r.glow(x + kx, y + ky, 2, [0.5, 0.9, 0.7], 0.5);
    // its own floodlight from above: lights the airframe and the ground round its shadow (the height reads at night)
    const night = w.env === 'night' || w.env === 'dusk';
    if (night) r.light(shx, shy, 30, 46 + this.alt * 20, 0.22, 0.24, 0.3, false);
    if (dying) {
      const fl = 0.5 + 0.5 * Math.sin(time * 23);
      r.light(x + 24, y + 24, 18, 90, 1.2 * fl, 0.5 * fl, 0.12 * fl, true);
      r.glow(x + 24, y + 24, 5 + 3 * fl, [1, 0.5, 0.15], 1.2);
      return;
    }
    // the searchlight (night and dusk): a cone from the nose, sweeping, locked on once it has you
    if (night) {
      const [nx, ny] = rotPt(24, 2, dir, S);
      const lx2 = x + nx;
      const ly2 = y + ny;
      const ca = Math.cos(this.lightAng);
      const sa = Math.sin(this.lightAng);
      const k = (w.env === 'night' ? 1.9 : 1.2) * (this.mode === 'lair' ? 0.4 : 1);
      r.spot(lx2, ly2, 14 + this.alt * 30, 190, 1.0 * k, 0.95 * k, 0.82 * k, true, ca, sa, 0.9, 0.975);
      r.glow(lx2, ly2, 2.5, [1, 0.96, 0.85], 2.5 * k);
    } else {
      const k = Math.max(0.35, head);
      r.spot(x + 24, y + 24, 20 + this.alt * 20, 90, 0.6 * k, 0.6 * k, 0.55 * k, false, DX[dir], DY[dir], 0.8, 0.95);
    }
    // pods glow before a pop-up or a salvo
    if (this.mode === 'popTell' || this.mode === 'salvoTell') {
      const g = Math.min(1, this.modeT / this.tell(this.mode === 'popTell' ? HELI.popTell : HELI.salvoTell));
      const pulse = 0.7 + 0.3 * Math.sin(time * 30);
      for (const p of this.livePods()) {
        const [px, py] = rotPt(POD_MUZZLE[p.id][0], POD_MUZZLE[p.id][1], dir, S);
        r.glow(x + px, y + py, 2 + g * 3, [1, 0.35, 0.12], (0.8 + g * 2.5) * pulse);
      }
    }
  }

  /** Decoy flares: white-hot points with an orange halo that light the ground under them, fading as they burn out. */
  private drawFlares(r: Renderer, ox: number, oy: number, time: number): void {
    let lit = 0;
    for (let i = this.flares.length - 1; i >= 0; i--) {
      const fl = this.flares[i];
      const sx = ox + fl.x;
      const sy = oy + fl.y;
      if (sx < -20 || sy < -20 || sx > r.nw + 20 || sy > r.nh + 20) continue;
      const k = 1 - fl.t / HELI.flareLife;
      const fk = 0.75 + 0.25 * Math.sin(time * 40 + i * 2.1);
      r.glow(sx, sy, 3.2, [1, 0.6, 0.25], 1.6 * k * fk);
      r.glow(sx, sy, 1.4, [1, 0.97, 0.85], 4 * k * fk);
      // a few real lights are enough (cheap): the newest flares
      if (lit++ < 4) r.light(sx, sy, 16, 44, 1.1 * k, 0.75 * k, 0.4 * k, false);
    }
  }

  /**
   * The strafing line (top overlay with a dark rim, so it reads at night, in rain and under the searchlight): a
   * dotted centre line with chevrons pointing along the run, and the danger lane's edges (HELI.strafeR each side)
   * as dashes marching the way it will fly, pulsing. Blinks during the tell, solid on the run.
   */
  private drawStrafe(r: Renderer, ox: number, oy: number, f: number): void {
    const s = this.strafe;
    if (!s || (this.mode !== 'strafeTell' && this.mode !== 'strafe')) return;
    const len = Math.abs(s.ex - s.sx) + Math.abs(s.ey - s.sy);
    const tell = this.mode === 'strafeTell';
    const lit = !tell || ((this.modeT >> 3) & 1) === 0 || this.modeT > this.strafeTellFrames() - 16;
    const on = (sx: number, sy: number, m: number) => sx > -m && sy > -m && sx < r.nw + m && sy < r.nh + m;
    // solid colours (the overlay sits on the finished image): the blink and the pulse change brightness, not alpha
    const col: RGB = lit ? [1, 0.36, 0.16] : [0.62, 0.2, 0.1];
    const a = 1;
    const eb = (lit ? 0.85 : 0.6) + 0.15 * Math.sin(f * 0.3);
    const edge: RGB = [eb, 0.62 * eb, 0.22 * eb];
    const ea = 1;
    const dx = DX[s.d];
    const dy = DY[s.d];
    const qx = dy !== 0 ? 1 : 0; // across the run
    const qy = 1 - qx;
    const W = HELI.strafeR + 1;
    const march = (f >> 1) % 6;
    const d0 = Math.max(0, s.walked + 18);
    const pen = HELI_PEN;
    // the lane's edges: 3 px dashes every 6 px, sliding along the run
    for (let d = d0 + march; d < len; d += 6) {
      for (const side of [-1, 1]) {
        for (let k = 0; k < 3 && d + k < len; k++) {
          const px = Math.round(ox + s.sx + dx * (d + k) + qx * side * W);
          const py = Math.round(oy + s.sy + dy * (d + k) + qy * side * W);
          if (on(px, py, 2)) pen.dot(px, py, edge, ea);
        }
      }
    }
    // the centre line: 2 x 2 dots, a chevron every fifth
    for (let d = d0; d < len; d += 6) {
      const px = Math.round(ox + s.sx + dx * d);
      const py = Math.round(oy + s.sy + dy * d);
      if (!on(px, py, 4)) continue;
      if (Math.floor(d / 6) % 5 === 0) {
        for (let j = -3; j <= 3; j++) {
          const bx = px + qx * j - dx * Math.abs(j);
          const by = py + qy * j - dy * Math.abs(j);
          pen.dot(bx, by, col, a);
          pen.dot(bx - dx, by - dy, col, a);
        }
      } else {
        pen.rect(px - 1, py - 1, 2, 2, col, a);
      }
    }
    pen.flush(r, 0.95);
  }

  /**
   * Rocket warning marks (top overlay, dark rim): the blast circle (HELI.markR) pulsing, with a bright spark running
   * round it, and a centre cross. As the rocket nears the spark speeds up, the blink quickens and orange turns red.
   */
  private drawMarks(r: Renderer, ox: number, oy: number, f: number): void {
    const pen = HELI_PEN;
    const R = HELI.markR;
    for (const m of this.marks) {
      if (m.done || (m.show !== undefined && m.show >= 0)) continue; // (a chaser not yet placed)
      const sx = Math.round(ox + m.x);
      const sy = Math.round(oy + m.y);
      if (sx < -30 || sy < -30 || sx > r.nw + 30 || sy > r.nh + 30) continue;
      const k = clamp((f - m.t0) / Math.max(1, m.at - m.t0), 0, 1);
      const period = k < 0.5 ? 16 : k < 0.8 ? 8 : 4;
      const lit = (f - m.t0) % period < period / 2;
      // solid colours (the overlay sits on the finished image): the blink and the pulse change brightness
      const b = (lit ? 1 : 0.72) * (0.85 + 0.15 * Math.sin((f - m.t0) * 0.35));
      const col: RGB = [b, (0.24 + 0.3 * (1 - k)) * b, 0.1 * b];
      const a = 1;
      // the blast circle; a bright spark runs round it, faster as the rocket nears
      const rp = ring(R);
      const spark = Math.floor((f - m.t0) * (0.5 + k * 1.5)) % rp.length;
      for (let i = 0; i < rp.length; i++) {
        const near = (i - spark + rp.length) % rp.length < 4;
        pen.dot(sx + rp[i][0], sy + rp[i][1], near ? SPARK : col, a);
      }
      // the centre: a 5 px cross
      for (let j = -2; j <= 2; j++) {
        pen.dot(sx + j, sy, col, a);
        pen.dot(sx, sy + j, col, a);
      }
      r.glow(sx, sy, R, [1, 0.2, 0.1], 0.05 + 0.12 * k * (lit ? 1 : 0.5));
    }
    pen.flush(r, 0.95);
  }

  /** draw.ts fluid hook: rotor downdraft (spray, ripples), smoke from damage, the burning wreck. */
  fluid(r: Renderer, ox: number, oy: number, f: number, time: number): void {
    if (!this.present) return;
    if (this.state === 'dead') {
      const [wx, wy] = this.wreck;
      const k = this.deadT < 60 * 30 ? 1 : 0.3;
      r.dyeSplat(ox + wx + 24 + Math.sin(time * 3) * 3, oy + wy + 22, 8, 0.6 * k * f, 0.4 * k * f, 0.12 * k * f);
      r.velSplat(ox + wx + 24, oy + wy + 20, 7, 0, -10 * f);
      return;
    }
    const x = ox + this.cx;
    const y = oy + this.cy;
    if (x < -80 || y < -80 || x > r.nw + 80 || y > r.nh + 80) return;
    if (this.state === 'dying') {
      r.dyeSplat(x, y, 7, 0.7 * f, 0.5 * f, 0.3 * f);
      return;
    }
    // downdraft: pushes smoke and rain mist outward, ripples water, stronger the lower it is
    const k = clamp(1 - this.alt, 0, 1) * (this.mode === 'lair' ? 0.4 : 1);
    if (k > 0.05) {
      for (let i = 0; i < 4; i++) {
        const a = time * 3 + (i * Math.PI) / 2;
        r.velSplat(x + Math.cos(a) * 14, y + Math.sin(a) * 14, 12, Math.cos(a) * 520 * k * r.dt, Math.sin(a) * 520 * k * r.dt);
      }
      r.waveSplat(x, y, 18, 0.5 * k * f);
    }
    // exhaust heat behind the engine
    const [ex, ey] = rotPt(24, 32, this.dir, S);
    r.dyeSplat(ox + this.x + ex, oy + this.y + ey, 3, 0.04 * f, 0.12 * f, 0);
    for (const p of this.parts) {
      if (p.hp > 0) continue;
      const [px, py, pw, ph] = this.partRect(p);
      r.dyeSplat(ox + px + pw / 2, oy + py + ph / 2, 4, 0.3 * f, 0.2 * f, 0.08 * f);
    }
  }
}
