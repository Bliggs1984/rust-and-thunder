// Phase 4: the Region 5 boss (Winter Front, snow), the campaign's final fight: "BASTION" (invented callsign), the
// invader's fortified command post. A staged fight that mixes the earlier bosses' ideas, ~4-6 minutes:
//
// The post is stamped into the map when the region is built (a 160 px site far from the start, its gate facing the
// player's start): a brick-walled yard, three steel gun bunkers (two on the front corners, one on the back wall) and
// a steel command bunker in the middle with a garage door. It shows on the map from the start; the fight begins once
// enough towns are free (FINAL.reveal), like GRINDER.
//
// 1. "FROSTBITE", a heavy tank: GRINDER himself (src/game/boss.ts, same weak points and tells) in winter white-wash,
//    rolling out of the gate with two escorts. The bunker guns keep their shutters closed ("SHUTTERS CLOSED").
// 2. Bunker guns: the shutters open. Each gun turns a quarter at a time, glows and beeps for FINAL.gunGlow frames,
//    then fires a 2-armour shell; meanwhile artillery barrages (warning circles, tricks.ts) and attack drones come in.
//    With the three guns down the command bunker's door can be hit (a lock on the HUD until then).
// 3. The door blows and the command car runs for the nearest road out of the region (a red marker blinks there) with
//    two fast escorts, its roof gun firing at anyone lined up close. Shells, drones and ambush squads stop it; tanks
//    can block it. If it reaches the exit the partisans have blown the road: it turns and runs for another one.
// Destroying the car wins the campaign: `victory` turns true (the run flow can show the ending), fireworks over the
// players and the freed towns, everyone on the radio; +FINAL.scrap, 2 captured parts; the region clears.
import type { Renderer } from '../../gl/renderer';
import { Boss, heat, type BossPart } from '../boss';
import { BRICK, DX, DY, EMPTY, MAT_METAL, MAT_STD, ROAD, STEEL, UP, WATER } from '../constants';
import { Flow } from '../map';
import { Tank, type Bullet, type RGB, type World } from '../world';
import { WINTER_KEYS } from '../../art/boss4-sprites';
import { clamp, debrisBurst, domDir, logTo, overlap, rand, rotRect, say, smokePuff } from './common';
import { EIGHTH, angDiff, angOfDir, clearOf, lineOff, shellAt, snap8, tellLine, vecOf } from './aim';
import type { BossExtras, BossLike, BossPartLike, BossState } from './types';

/** Tuning, "easy". Distances in px, times in frames (60 per second). */
export const FINAL = {
  /** towns freed before the fight starts (all of them if the region has fewer) */
  reveal: 3,
  /** the post's site: a square frame, px (40 cells) */
  site: 160,
  tankEscort: [2, 2, 3, 0], // was [2, 0]
  /** FROSTBITE is GRINDER with these: his heavy shell's damage, a factor on his reloads */
  tankGunDmg: 5,
  tankReload: 0.8, // was 0.65 (2026-11-18: with the patch cooldown his 5-armour shells came too often)
  tankTurret: 18,
  gunHp: 10, // was 8
  doorHp: 8, // was 6
  gunRange: 220, // was 190
  gunSlack: 9,
  /** frames per quarter turn of a gun */
  gunTurn: 28,
  gunGlow: 48,
  gunReload: 180, // was 210 before the guns could fire diagonally (2026-10-16), then 250, then 150
  gunSpeed: 2.4,
  gunDmg: 3, // was 2
  /** phase 2: an artillery barrage and an attack drone this often */
  barrageEvery: 60 * 7, // was 15 s
  droneEvery: 60 * 13, // was 24 s
  carHp: 16, // was 10
  carSpeed: 0.72,
  carEscort: [1, 1, 2, 2], // was [1, 1]
  carMgRange: 96,
  carMgBurst: 4, // was 3
  carMgGap: 8,
  carMgPause: 150, // was 110 (8-direction bursts)
  carMgWind: 14,
  /** frames it sits at a blown road before it turns back */
  carWait: 110,
  droneMul: 2,
  /** frames between one stage ending and the next starting */
  phaseGap: 120,
  dieFrames: 110,
  /** frames of fireworks after the final blast */
  celebrate: 60 * 9,
  scrap: 25, // was 500, and 25 a part: the campaign ends here, so it is mostly leftover (2026-11-18 scrap economy: income cut to about a fifth, see SCRAP_DROP)
  partScrap: 6,
  captured: 2,
};

const S = 48;
const WHO = 'INTERCEPT';

/** The post's layout in its up-facing frame (px; front = top = toward the player's start). */
const L = {
  tank: [56, 8, 48, 48],
  guns: [[8, 48, 16, 16], [136, 48, 16, 16], [72, 136, 16, 16]],
  bunker: [60, 88, 40, 32],
  door: [72, 88, 16, 8],
  garage: [72, 88, 16, 32],
  car: [72, 96, 16, 16],
  yard: [8, 48, 144, 104],
  beacon: [94, 114],
};

interface Gun extends BossPartLike {
  kind: 'gun';
  /** world px of its 16 px bunker */
  rect: [number, number, number, number];
  /** the gun's angle (radians clockwise from up; one of the 8 directions) */
  ta: number;
  turnT: number;
  glow: number;
  reload: number;
}

interface Firework { x: number; y: number; h: number; vh: number; t: number; burst: number; col: RGB; sparks: { x: number; y: number; vx: number; vy: number }[] }

export class FinalBoss implements BossLike, BossExtras {
  readonly kind = 'final';
  readonly name = 'BASTION';
  readonly goal = 'FIND THEIR COMMAND POST · END THE WAR';
  x = 0;
  y = 0;
  dir = UP;
  state: BossState = 'hidden';
  revealed = false;
  /** 0 hidden, 1 the heavy tank, 2 the bunker guns and the door, 3 the command car */
  phase = 0;
  parts: BossPartLike[];
  /** the campaign's last boss is destroyed: the run flow can show the ending */
  victory = false;
  /** the post's frame: top-left (px) and the way its front faces */
  site: [number, number] = [0, 0];
  face = UP;
  lairNear = '';
  /** phase 1: GRINDER in winter paint */
  tank: Boss;
  guns: Gun[];
  door: BossPartLike;
  car: Tank | null = null;
  carPart: BossPartLike;
  /** where the car is running to (px, the exit's tank top-left) */
  exit: [number, number] | null = null;
  deathT = 0;
  deadT = 0;
  killer = -1;
  readonly proxy: Tank;
  stats = {
    phase1At: -1, phase2At: -1, phase3At: -1, gunShots: 0, gunHits: 0, barrages: 0, drones: 0, noPen: 0, shellHits: 0,
    droneHits: 0, rocketHits: 0, carShots: 0, escapes: 0, rams: 0, deaths: 0, victories: 0, columns: 0,
    ms: 0, msMax: 0, msSum: 0, n: 0,
  };
  log: string[] = [];

  private nextPhaseAt = -1;
  private nextBarrage = 0;
  private nextDrone = 0;
  private lastPop = -1e9;
  private hinted = '';
  private doorAnnounced = false;
  private carMg = { n: 0, t: 0, d: 0, wind: 0 };
  private carWait = 0;
  private carBlocked = 0;
  private flow = new Flow();
  private flowAt = -1e9;
  private usedExits: string[] = [];
  private fireworks: Firework[] = [];
  private garageOpen = false;
  /** px the tank's wreck still has to slide (the final blast throws it clear of the door's line) */
  private shove: [number, number] = [0, 0];

  constructor(private w: World) {
    const t = new Tank();
    t.player = -1;
    t.etype = 3;
    this.proxy = t;
    this.pickSite();
    this.stamp();
    // phase 1 is GRINDER himself, renamed and repainted; his death hands over to phase 2 instead of paying out
    const tank = new Boss(w);
    const rw = tank as unknown as { name: string; title: string; finale: () => void };
    if (typeof rw.finale !== 'function') throw new Error('final.ts: Boss.finale not found (the final fight takes over the tank death)');
    // heavier than the Farmland original: the old 4-armour shell, a faster loader
    tank.gunDmg = FINAL.tankGunDmg;
    tank.reloadMul = FINAL.tankReload;
    tank.turret.hp = tank.turret.max = FINAL.tankTurret;
    rw.name = 'FROSTBITE';
    rw.title = 'HEAVY TANK';
    rw.finale = () => this.tankDown();
    this.tank = tank;
    const R = (r: number[]) => this.toWorld(r);
    this.guns = L.guns.map((g, i) => ({
      id: `gun${i}`, name: ['LEFT GUN BUNKER', 'RIGHT GUN BUNKER', 'REAR GUN BUNKER'][i], short: 'GUN', kind: 'gun' as const,
      hp: FINAL.gunHp, max: FINAL.gunHp, hitT: 0, rect: R(g), ta: angOfDir(this.face), turnT: 0, glow: -1, reload: 60 + i * 50,
    }));
    this.door = { id: 'door', name: 'COMMAND BUNKER DOOR', short: 'DOOR', kind: 'door', hp: FINAL.doorHp, max: FINAL.doorHp, hitT: 0 };
    this.carPart = { id: 'car', name: 'COMMAND CAR', short: 'CAR', kind: 'car', hp: FINAL.carHp, max: FINAL.carHp, hitT: 0 };
    this.parts = tank.parts;
    this.syncPos();
  }

  get title(): string {
    return this.phase <= 1 ? 'COMMAND POST · 1/3 HEAVY TANK' : this.phase === 2 ? 'COMMAND POST · 2/3 BUNKER GUNS' : 'COMMAND POST · 3/3 STOP THE CAR';
  }
  get hudKey(): string { return `final${Math.max(1, this.phase)}`; }
  get cx(): number { return this.x + S / 2; }
  get cy(): number { return this.y + S / 2; }
  get turret(): BossPartLike { return this.phase <= 1 ? this.tank.turret : this.phase === 2 ? this.door : this.carPart; }
  get present(): boolean { return this.state !== 'hidden'; }
  get alive(): boolean { return this.state === 'lair' || this.state === 'hunt'; }
  exposed(): boolean {
    return this.phase <= 1 ? this.tank.exposed() : this.phase === 2 ? this.guns.every((g) => g.hp <= 0) : true;
  }
  cleared(): boolean { return this.state === 'dead' && this.deadT > 60 * 5; }
  townsToReveal(): number {
    const need = Math.min(FINAL.reveal, this.w.towns.length);
    return Math.max(0, need - this.w.towns.filter((t) => t.freed).length);
  }
  hudShown(): boolean {
    if (!this.present) return false;
    if (this.state === 'dead') return this.deadT < 60 * 4;
    if (this.state === 'dying' || this.state === 'hunt') return true;
    return this.w.livePlayers().some((p) => Math.hypot(p.cx - this.cx, p.cy - this.cy) < 300);
  }
  /** A drone launched now would get through: the heavy tank's smoke screen is the only counter here. */
  droneOpen(): boolean {
    return this.phase > 1 || !this.tank.alive || this.tank.droneOpen();
  }
  /** Ambush squads may fire at the fleeing car. */
  squadTarget(): [number, number] | null {
    return this.phase === 3 && this.alive && this.car ? [this.car.cx, this.car.cy] : null;
  }

  private get ease(): number {
    const e = this.w.ease;
    return Number.isFinite(e) ? clamp(e, 0, 0.5) : 0;
  }
  private tell(n: number): number { return Math.round(n * (1 + this.ease)); }
  private gap(n: number): number { return Math.round(n * (1 + 2 * heat(this.w.ease))); }
  private logEv(s: string): void { logTo(this.log, this.w.frame, s); }
  private say(who: string, text: string): void { say(this.w, who, text, (s) => this.logEv(s)); }

  // ---------- the site ----------
  /** A rect of the post's frame in world px. */
  toWorld(r: readonly number[]): [number, number, number, number] {
    const [x, y, w, h] = rotRect(r, this.face, FINAL.site);
    return [this.site[0] + x, this.site[1] + y, w, h];
  }

  /** The site: open ground (no water or steel) far from the start, clear of towns and depots, reachable from it. */
  private pickSite(): void {
    const w = this.w;
    const m = w.map;
    const F = FINAL.site;
    const sp = w.region?.playerSpawns[0] ?? [w.pxW / 2, w.pxH - 32];
    const W1 = m.w + 1;
    const bad = new Int32Array(W1 * (m.h + 1));
    for (let y = 0; y < m.h; y++) {
      let row = 0;
      for (let x = 0; x < m.w; x++) {
        const c = m.c[y * m.w + x];
        if (c === WATER || c === STEEL) row++;
        bad[(y + 1) * W1 + x + 1] = bad[y * W1 + x + 1] + row;
      }
    }
    const sum = (x: number, y: number, ww: number, hh: number) => bad[(y + hh) * W1 + x + ww] - bad[y * W1 + x + ww] - bad[(y + hh) * W1 + x] + bad[y * W1 + x];
    const cand: [number, number, number][] = [];
    for (let y = 16; y + F + 16 <= w.pxH; y += 16) {
      for (let x = 16; x + F + 16 <= w.pxW; x += 16) {
        if (sum(x / 4, y / 4, F / 4, F / 4)) continue;
        if (w.towns.some((t) => overlap(x - 16, y - 16, F + 32, F + 32, t.rect[0], t.rect[1], t.rect[2], t.rect[3]))) continue;
        if (w.depots.some((d) => overlap(x - 16, y - 16, F + 32, F + 32, d.rect[0], d.rect[1], d.rect[2], d.rect[3]))) continue;
        const d = Math.hypot(x + F / 2 - sp[0] - 8, y + F / 2 - sp[1] - 8);
        if (d < 200) continue;
        const edge = Math.min(x, y, w.pxW - F - x, w.pxH - F - y);
        cand.push([x, y, Math.min(d, 1100) - Math.max(0, 64 - edge) * 3]);
      }
    }
    cand.sort((a, b) => b[2] - a[2]);
    // the region generator's lair (RegionSpec.lair, its centre in px) comes first when it fits on the map
    const lair = (w.region as { lair?: [number, number] } | undefined)?.lair;
    if (lair) {
      const lx = clamp(Math.round((lair[0] - F / 2) / 8) * 8, 0, Math.floor((w.pxW - F) / 8) * 8);
      const ly = clamp(Math.round((lair[1] - F / 2) / 8) * 8, 0, Math.floor((w.pxH - F) / 8) * 8);
      cand.unshift([lx, ly, Infinity]);
    }
    const flow = new Flow();
    flow.compute(m, [[Math.round(sp[0] / 8), Math.round(sp[1] / 8)]]);
    for (const [x, y] of cand.slice(0, 40)) {
      const face = domDir(sp[0] + 8 - (x + F / 2), sp[1] + 8 - (y + F / 2));
      this.site = [x, y];
      this.face = face;
      // the front lane (where the tank starts and the car drives out) must connect to the start
      const [tx, ty] = this.toWorld(L.tank);
      if (Number.isFinite(flow.at(Math.round((tx + 16) / 8), Math.round((ty + 16) / 8)))) return;
    }
    // nothing fits (a tiny test map): the middle of the map, cleared
    this.site = [Math.round((w.pxW - F) / 16) * 8, Math.round((w.pxH - F) / 16) * 8];
    this.face = domDir(sp[0] - w.pxW / 2, sp[1] - w.pxH / 2);
  }

  /** Build the post into the map: clear the site, walls, gate, bunkers, the command bunker; a track out of the gate. */
  private stamp(): void {
    const m = this.w.map;
    const fill = (r: readonly number[], c: number) => {
      const [x, y, w, h] = this.toWorld(r);
      for (let cy = y / 4; cy < (y + h) / 4; cy++) for (let cx = x / 4; cx < (x + w) / 4; cx++) m.set(cx, cy, c);
    };
    fill([0, 0, 160, 160], EMPTY);
    // the yard's brick walls, two cells thick, with a 32 px gate in the front
    fill([16, 56, 128, 8], BRICK);
    fill([64, 56, 32, 8], EMPTY);
    fill([16, 56, 8, 96], BRICK);
    fill([136, 56, 8, 96], BRICK);
    fill([16, 144, 128, 8], BRICK);
    // a track from the front lane through the gate to the door
    fill([64, 0, 32, 88], ROAD);
    fill([64, 56, 32, 8], ROAD);
    for (const g of L.guns) fill(g, STEEL);
    fill(L.bunker, STEEL);
    let bd = Infinity;
    const [sx, sy] = this.site;
    for (const t of this.w.towns) {
      const d = Math.hypot(t.cx - sx - 80, t.cy - sy - 80);
      if (d < bd) { bd = d; this.lairNear = t.name; }
    }
  }

  private openGarage(): void {
    if (this.garageOpen) return;
    this.garageOpen = true;
    const m = this.w.map;
    const [x, y, w, h] = this.toWorld(L.garage);
    for (let cy = y / 4; cy < (y + h) / 4; cy++) for (let cx = x / 4; cx < (x + w) / 4; cx++) m.set(cx, cy, EMPTY);
  }

  /** x, y, dir follow whatever is fighting now (drone locks ride on them; the HUD marker sits on the centre). */
  private syncPos(): void {
    if (this.phase === 3 && this.car) {
      this.x = this.car.cx - S / 2;
      this.y = this.car.cy - S / 2;
      this.dir = this.car.dir;
    } else if (this.phase === 2 || (this.phase === 0 && !this.tank.present)) {
      const [bx, by, bw, bh] = this.toWorld(L.bunker);
      this.x = bx + bw / 2 - S / 2;
      this.y = by + bh / 2 - S / 2;
      this.dir = this.face;
    } else {
      this.x = this.tank.x;
      this.y = this.tank.y;
      this.dir = this.tank.dir;
    }
  }

  // ---------- geometry for tanks ----------
  overlaps(x: number, y: number, w: number, h: number): boolean {
    if (this.tank.overlaps(x, y, w, h)) return true;
    const c = this.car;
    return !!c && overlap(x, y, w, h, c.x, c.y, 16, 16);
  }

  blocks(t: Tank, x: number, y: number): boolean {
    const c = this.car;
    // the car squeezes past the tank's wreck (it may have died in the gateway)
    if (t !== c && this.tank.blocks(t, x, y)) return true;
    return !!c && t !== c && overlap(x, y, 16, 16, c.x, c.y, 16, 16) && !overlap(t.x, t.y, 16, 16, c.x, c.y, 16, 16);
  }

  // ---------- per update ----------
  update(): void {
    const w = this.w;
    const t0 = performance.now();
    if (this.state === 'hidden') {
      if (w.frame % 30 === 0 && this.townsToReveal() === 0) this.reveal();
    } else {
      for (const p of [...this.guns, this.door, this.carPart]) if (p.hitT > 0) p.hitT--;
      this.proxy.x = this.cx - 8;
      this.proxy.y = this.cy - 8;
      if (this.tank.present) this.tank.update();
      this.slideWreck();
      if (this.state === 'lair' && this.tank.state === 'hunt') this.state = 'hunt';
      if (this.state === 'dying') this.updateDying();
      else if (this.state === 'dead') this.updateDead();
      else if (w.freeze === 0 && !w.over) {
        if (this.phase === 1 && this.nextPhaseAt >= 0 && w.frame >= this.nextPhaseAt) this.startPhase2();
        else if (this.phase === 2) this.updatePhase2();
        else if (this.phase === 3) this.updateCar();
      }
      this.smoke();
    }
    this.syncPos();
    const ms = performance.now() - t0;
    const s = this.stats;
    s.ms = ms;
    s.msMax = Math.max(s.msMax, ms);
    s.msSum += ms;
    s.n++;
  }

  // ---------- reveal and phase 1 ----------
  reveal(): void {
    if (this.state !== 'hidden') return;
    const w = this.w;
    const tk = this.tank;
    const [tx, ty] = this.toWorld(L.tank);
    tk.x = tx;
    tk.y = ty;
    tk.dir = tk.tdir = this.face;
    tk.revealed = true;
    tk.state = 'lair';
    this.state = 'lair';
    this.revealed = true;
    this.phase = 1;
    this.parts = tk.parts;
    this.stats.phase1At = w.frame;
    const n = w.ai?.bossEscort(FINAL.tankEscort, 'FROSTBITE', () => [tk.cx, tk.cy, tk.dir]) ?? 0;
    this.say('HQ', `THIS IS IT. THEIR COMMAND POST, CALLSIGN ${this.name}, IS DUG IN NEAR ${this.lairNear || 'THE FRONT'}. TAKE IT AND THE WAR IS OVER.`);
    this.say(WHO, `${this.name}: FROSTBITE, ROLL OUT. NOBODY REACHES THIS GATE.`);
    w.note('BOSS LOCATED', 'warn');
    w.snd('column', this.cx, 1);
    this.logEv(`revealed: site ${this.site} facing ${this.face}, escort ${n}`);
  }

  /** The heavy tank's death sequence ended (GRINDER's finale, without his rewards): phase 2 follows. */
  private tankDown(): void {
    const w = this.w;
    const tk = this.tank;
    const x = tk.cx;
    const y = tk.cy;
    tk.state = 'dead';
    tk.deadT = 0;
    w.explode(x, y, true);
    w.explode(x - 12, y + 8, true);
    w.flashes.push({ x, y, t: 0, max: 80, r: 200, col: [1, 0.55, 0.2], z: 30 });
    w.shocks.push({ x, y, t: 0, max: 50, size: 2.6 });
    w.shake = 8;
    w.snd('bigexplode', x, 1);
    const a = rand() * Math.PI * 2;
    tk.turretOff = [Math.round(Math.cos(a) * 5), Math.round(Math.sin(a) * 5)];
    debrisBurst(w, x, y, 24, [[0.7, 0.72, 0.75], [0.2, 0.2, 0.2]], 2.2, 10);
    for (let i = 0; i < 10; i++) smokePuff(w, x + (rand() - 0.5) * 30, y + (rand() - 0.5) * 30, true);
    w.decals.push({ k: 1, x, y, r: 30, col: [0.02, 0.02, 0.02], a: 0.6 });
    w.scrap += FINAL.partScrap * 2;
    w.popups.push({ x, y: y - 24, text: `+${FINAL.partScrap * 2} SCRAP`, t: 0, col: [1, 0.85, 0.4] });
    w.note('FROSTBITE DESTROYED', 'power');
    if (tk.killer >= 0) w.addVetXp(tk.killer, 0.5);
    this.say(WHO, `${this.name}: FROSTBITE IS GONE. ALL GUNS, OPEN THE SHUTTERS. BATTERY, STAND BY.`);
    this.nextPhaseAt = w.frame + FINAL.phaseGap;
    this.logEv('phase 1 done: the tank is scrap');
    this.clearDoorLine();
  }

  /**
   * The door only takes shells from straight in front. A wreck left on that line (the tank usually dies on the track
   * outside the gate) would seal it: every shell hits the hulk, and a crew without drones could never open the door.
   * So the final blast throws the hulk sideways, clear of the door's 16 px column (slideWreck moves it).
   */
  private clearDoorLine(): void {
    const tk = this.tank;
    const d = this.doorRect();
    const vert = this.face === UP || this.face === 2;
    // across the door's line: world x for a post facing up or down, world y otherwise
    const lat = vert ? tk.x : tk.y;
    const dl = vert ? d[0] : d[1];
    const dw = vert ? d[2] : d[3];
    if (lat + S <= dl || lat >= dl + dw) return;
    // only in front of the door (behind the bunker it is in nobody's way)
    const front = (tk.cx - (d[0] + d[2] / 2)) * DX[this.face] + (tk.cy - (d[1] + d[3] / 2)) * DY[this.face];
    if (front < 0) return;
    const toLow = dl - S - lat;
    const toHigh = dl + dw - lat;
    const by = -toLow <= toHigh ? toLow : toHigh;
    this.shove = vert ? [by, 0] : [0, by];
    this.logEv(`wreck on the door's line: thrown ${by} px aside`);
  }

  private slideWreck(): void {
    const sh = this.shove;
    if (!sh[0] && !sh[1]) return;
    const w = this.w;
    const tk = this.tank;
    for (let k = 0; k < 2; k++) {
      const st = clamp(sh[k], -1.5, 1.5);
      sh[k] -= st;
      if (k === 0) tk.x = clamp(tk.x + st, 0, w.pxW - S);
      else tk.y = clamp(tk.y + st, 0, w.pxH - S);
    }
    if (w.frame % 3 === 0) {
      w.sparks(tk.cx + (rand() - 0.5) * 40, tk.cy + (rand() - 0.5) * 40, 3, [1, 0.8, 0.45]);
      smokePuff(w, tk.cx + (rand() - 0.5) * 30, tk.cy + (rand() - 0.5) * 30, true);
    }
    if (!sh[0] && !sh[1]) {
      // it comes to rest on whole pixels, crushing any wall under it
      tk.x = Math.round(tk.x);
      tk.y = Math.round(tk.y);
      const m = w.map;
      for (let cy = Math.floor(tk.y / 4); cy < Math.ceil((tk.y + S) / 4); cy++) {
        for (let cx = Math.floor(tk.x / 4); cx < Math.ceil((tk.x + S) / 4); cx++) {
          if (m.at(cx, cy) !== BRICK) continue;
          m.set(cx, cy, EMPTY);
          if (rand() < 0.3) w.debris(cx * 4 + 2, cy * 4 + 2, Math.floor(rand() * 4));
        }
      }
      w.shake = Math.max(w.shake, 3);
      w.snd('thud', tk.cx, 0.9);
    }
  }

  // ---------- phase 2: the bunker guns, artillery and drones ----------
  private startPhase2(): void {
    const w = this.w;
    this.phase = 2;
    this.state = 'hunt';
    this.parts = [...this.guns, this.door];
    this.nextPhaseAt = -1;
    this.stats.phase2At = w.frame;
    this.nextBarrage = w.frame + this.gap(60 * 6);
    this.nextDrone = w.frame + this.gap(60 * 12);
    this.say('SPANNER', 'THREE GUN BUNKERS ON THAT POST. KNOCK THEM OUT, THEN HIS FRONT DOOR. WATCH THE SKY.');
    w.note('PHASE 2: BUNKER GUNS', 'warn');
    w.snd('column', this.cx, 0.8);
    this.callColumn();
    this.logEv('phase 2');
  }

  /** Each new stage brings a road column at the players. */
  private callColumn(): void {
    const w = this.w;
    const at = w.livePlayers()[0];
    if (w.ai?.bossColumn(at ? at.x : this.cx - 8, at ? at.y : this.cy - 8)) this.stats.columns++;
  }

  private updatePhase2(): void {
    const w = this.w;
    for (const g of this.guns) this.updateGun(g);
    const pl = w.livePlayers();
    const near = pl.filter((p) => Math.hypot(p.cx - this.cx, p.cy - this.cy) < 420);
    const tr = w.tricks;
    if (near.length && tr?.on) {
      if (w.frame >= this.nextBarrage) {
        this.nextBarrage = w.frame + this.gap(FINAL.barrageEvery);
        const p = near[Math.floor(rand() * near.length)];
        if (!tr.barrage && tr.startBarrage(p.cx + (rand() - 0.5) * 20, p.cy + (rand() - 0.5) * 20, false)) this.stats.barrages++;
      }
      if (w.frame >= this.nextDrone) {
        this.nextDrone = w.frame + this.gap(FINAL.droneEvery);
        if (tr.drones.filter((d) => d.phase === 'in' || d.phase === 'hover').length < 1 && tr.launchDrone(near[0].player, 'attack', [this.cx, this.cy])) this.stats.drones++;
      }
    }
    if (!this.doorAnnounced && this.exposed()) {
      this.doorAnnounced = true;
      this.say('SPANNER', 'THE GUNS ARE QUIET. NOW KNOCK ON HIS FRONT DOOR.');
      w.note('THE DOOR IS OPEN TO FIRE', 'info');
    }
  }

  private updateGun(g: Gun): void {
    const w = this.w;
    if (g.hp <= 0) return;
    const [gx, gy] = [g.rect[0] + 8, g.rect[1] + 8];
    if (g.reload > 0) g.reload--;
    if (g.glow >= 0) {
      g.glow++;
      if (g.glow % 12 === 1) w.snd('boss-charge', gx, 0.8);
      if (g.glow >= this.tell(FINAL.gunGlow)) {
        g.glow = -1;
        this.fireGun(g);
      }
      return;
    }
    let best: Tank | null = null;
    let bd = FINAL.gunRange;
    for (const p of w.livePlayers()) {
      const d = Math.hypot(p.cx - gx, p.cy - gy);
      if (d < bd) { bd = d; best = p; }
    }
    if (!best) return;
    // the 8 directions, an eighth turn at a time (the old quarter-turn pace)
    const want = snap8(best.cx - gx, best.cy - gy);
    const dl = angDiff(g.ta, want);
    if (Math.abs(dl) > 1e-3) {
      if (++g.turnT >= this.tell(FINAL.gunTurn / 2)) {
        g.turnT = 0;
        g.ta = Math.round((g.ta + Math.sign(dl) * EIGHTH) / EIGHTH) * EIGHTH;
      }
      return;
    }
    g.turnT = 0;
    g.ta = want;
    if (g.reload > 0) return;
    const [ux, uy] = vecOf(g.ta);
    const [lat, along] = lineOff(gx, gy, ux, uy, best.cx, best.cy);
    if (along < 12 || lat > FINAL.gunSlack) return;
    // no steel in the way (its own bunker excepted)
    if (!clearOf(w.map, gx + ux * 12, gy + uy * 12, ux, uy, along - 12)) return;
    g.glow = 0;
  }

  private fireGun(g: Gun): void {
    const w = this.w;
    const [dx, dy] = vecOf(g.ta);
    const mx = g.rect[0] + 8 + dx * 10;
    const my = g.rect[1] + 8 + dy * 10;
    const b = shellAt(mx, my, dx, dy, FINAL.gunSpeed, this.proxy, false);
    b.dmg = FINAL.gunDmg;
    w.bullets.push(b);
    g.reload = this.gap(FINAL.gunReload);
    this.stats.gunShots++;
    w.flashes.push({ x: mx, y: my, t: 0, max: 8, r: 50, col: [1, 0.65, 0.3], z: 12, vx: dx, vy: dy });
    for (let i = 0; i < 4; i++) {
      w.parts.push({ x: mx, y: my, z: 8, vx: dx * (0.4 + rand() * 0.6) + (rand() - 0.5) * 0.6, vy: dy * (0.4 + rand() * 0.6) + (rand() - 0.5) * 0.6, vz: 0.05, life: 0, max: 36, col: [0.6, 0.6, 0.62], kind: 2, r: 2.5 });
    }
    w.snd('boss-cannon', mx, 0.9);
  }

  // ---------- phase 3: the command car runs ----------
  private startPhase3(): void {
    const w = this.w;
    this.phase = 3;
    this.parts = [this.carPart];
    this.stats.phase3At = w.frame;
    this.openGarage();
    const c = new Tank();
    c.player = -1;
    c.etype = 1;
    c.spawn = 0;
    const [x, y] = this.toWorld(L.car);
    c.x = x;
    c.y = y;
    c.dir = this.face;
    this.car = c;
    this.pickExit();
    const n = w.ai?.bossEscort(FINAL.carEscort, this.name, () => [c.cx, c.cy, c.dir]) ?? 0;
    this.say(WHO, `${this.name}: THE POST IS LOST. I AM LEAVING. COVER THE CAR.`);
    this.say('HQ', 'THE COMMANDER IS RUNNING FOR THE ROAD OUT. STOP THAT CAR AND IT IS OVER.');
    w.note('STOP THE COMMAND CAR!', 'warn');
    w.snd('column', c.cx, 1);
    this.callColumn();
    this.logEv(`phase 3: car out, escort ${n}, running for ${this.exit}`);
  }

  /** The road out it runs for: the exit furthest from the players that it can reach (another one after a blown road). */
  private pickExit(): void {
    const w = this.w;
    const c = this.car!;
    const pts: [number, number][] = [...(w.region?.exits ?? [])];
    if (!pts.length) {
      for (const [x, y] of [[w.pxW / 2, 0], [w.pxW / 2, w.pxH - 16], [0, w.pxH / 2], [w.pxW - 16, w.pxH / 2]]) {
        const s = w.freeSpotNear(x, y);
        if (s) pts.push(s);
      }
    }
    const pl = w.livePlayers();
    let best: [number, number] | null = null;
    let bs = -Infinity;
    const flow = this.flow;
    for (const p of pts) {
      if (this.usedExits.includes(p.join())) continue;
      flow.compute(w.map, [[Math.round(p[0] / 8), Math.round(p[1] / 8)]]);
      const dc = flow.at(Math.round(c.x / 8), Math.round(c.y / 8));
      if (!Number.isFinite(dc)) continue;
      let dp = Infinity;
      for (const q of pl) dp = Math.min(dp, Math.hypot(q.cx - p[0] - 8, q.cy - p[1] - 8));
      // far from the players, not hopelessly far for the car
      const s = Math.min(dp, 400) - dc * 0.6;
      if (s > bs) { bs = s; best = p; }
    }
    if (!best) {
      this.usedExits = [];
      best = pts[Math.floor(rand() * pts.length)] ?? [0, 0];
    }
    this.exit = [best[0], best[1]];
    this.flowAt = -1e9;
    this.logEv(`car runs for ${best}`);
  }

  private updateCar(): void {
    const w = this.w;
    const c = this.car;
    if (!c || !this.exit) return;
    this.carGun();
    if (this.carWait > 0) {
      if (--this.carWait === 0) {
        this.usedExits.push(this.exit.join());
        this.pickExit();
        this.say(WHO, `${this.name}: ROAD IS BLOWN! TURN AROUND, TAKE THE OTHER ONE!`);
      }
      return;
    }
    const [ex, ey] = this.exit;
    if (Math.abs(c.x - ex) + Math.abs(c.y - ey) < 10) {
      // the partisans blew this road: it has to turn back
      this.stats.escapes++;
      this.carWait = this.tell(FINAL.carWait);
      this.say('HQ', 'HE MADE THE ROAD... AND THE PARTISANS JUST BLEW IT UNDER HIM. HE IS TURNING BACK. GET HIM.');
      w.note('ROAD BLOWN: HE IS TURNING BACK', 'info');
      w.explode(ex + 8 + DX[c.dir] * 18, ey + 8 + DY[c.dir] * 18, true);
      w.snd('bigexplode', ex, 0.8);
      this.logEv('car reached the exit: road blown');
      return;
    }
    if (w.frame - this.flowAt > 120) {
      this.flowAt = w.frame;
      this.flow.compute(w.map, [[Math.round(ex / 8), Math.round(ey / 8)]]);
    }
    const nx = Math.round(c.x / 8);
    const ny = Math.round(c.y / 8);
    const atNode = Math.abs(c.x - nx * 8) < 1e-3 && Math.abs(c.y - ny * 8) < 1e-3;
    if (atNode) {
      let best = -1;
      let bv = this.flow.at(nx, ny);
      for (const d of [c.dir, (c.dir + 1) & 3, (c.dir + 3) & 3, (c.dir + 2) & 3]) {
        const v = this.flow.at(nx + DX[d], ny + DY[d]);
        if (v < bv) { bv = v; best = d; }
      }
      if (this.carBlocked > 90) {
        // a tank sits in its way: try a side step
        const side = rand() < 0.5 ? (c.dir + 1) & 3 : (c.dir + 3) & 3;
        if (!w.blockedAt(c, c.x + DX[side] * 8, c.y + DY[side] * 8)) best = side;
        this.carBlocked = 0;
      }
      if (best < 0) return;
      w.turn(c, best);
    }
    const along = c.dir === UP || c.dir === 2 ? c.y : c.x;
    const sgn = c.dir === 1 || c.dir === 2 ? 1 : -1;
    const next = sgn > 0 ? Math.floor(along / 8 + 1e-6) * 8 + 8 : Math.ceil(along / 8 - 1e-6) * 8 - 8;
    const step = Math.min(FINAL.carSpeed, Math.abs(next - along));
    const moved = w.move(c, step);
    c.moving = moved;
    if (moved) {
      this.carBlocked = 0;
      c.dist += step;
      return;
    }
    // rams through brick (the post's own walls, garden walls), else waits for whatever blocks it
    const [ax, ay, aw, ah] = c.dir === UP ? [c.x, c.y - 4, 16, 4] : c.dir === 2 ? [c.x, c.y + 16, 16, 4] : c.dir === 1 ? [c.x + 16, c.y, 4, 16] : [c.x - 4, c.y, 4, 16];
    let n = 0;
    for (let cy = Math.floor(ay / 4); cy < Math.ceil((ay + ah) / 4); cy++) {
      for (let cx = Math.floor(ax / 4); cx < Math.ceil((ax + aw) / 4); cx++) {
        if (w.map.at(cx, cy) !== BRICK) continue;
        w.map.set(cx, cy, EMPTY);
        w.debris(cx * 4 + 2, cy * 4 + 2, c.dir);
        n++;
      }
    }
    if (n) {
      this.stats.rams++;
      w.snd('brick', c.cx, 0.8);
    } else {
      this.carBlocked++;
    }
  }

  /** The car's roof gun: short bursts at a player lined up close by, after a glint. */
  private carGun(): void {
    const w = this.w;
    const c = this.car!;
    const g = this.carMg;
    if (g.t > 0) { g.t--; return; }
    if (g.wind > 0) {
      if (--g.wind === 0) g.n = FINAL.carMgBurst;
      return;
    }
    if (g.n > 0) {
      const [ux, uy] = vecOf(g.d);
      const b = shellAt(c.cx + ux * 9, c.cy + uy * 9, ux, uy, 3.2, this.proxy, false);
      b.dmg = 1;
      b.mg = true;
      b.range = FINAL.carMgRange + 12;
      w.bullets.push(b);
      w.flashes.push({ x: c.cx + ux * 9, y: c.cy + uy * 9, t: 0, max: 4, r: 22, col: [1, 0.8, 0.4], z: 10 });
      w.snd('eshoot', c.cx, 0.3);
      this.stats.carShots++;
      g.n--;
      g.t = g.n ? FINAL.carMgGap : this.tell(FINAL.carMgPause);
      return;
    }
    for (const p of w.livePlayers()) {
      // the nearest of the 8 directions (g.d is the burst's angle)
      const a = snap8(p.cx - c.cx, p.cy - c.cy);
      const [ux, uy] = vecOf(a);
      const [lat, along] = lineOff(c.cx, c.cy, ux, uy, p.cx, p.cy);
      if (along < 10 || along > FINAL.carMgRange || lat > 8) continue;
      g.d = a;
      g.wind = this.tell(FINAL.carMgWind);
      return;
    }
  }

  // ---------- damage ----------
  private inRect(x: number, y: number, r: readonly number[], m = 0): boolean {
    return x >= r[0] - m && x < r[0] + r[2] + m && y >= r[1] - m && y < r[1] + r[3] + m;
  }

  private doorRect(): [number, number, number, number] {
    return this.toWorld(L.door);
  }

  /** The current stage's part boxes (the weak-point markers): the tank's, a bunker, the door, the car. */
  partRect(p: BossPartLike): [number, number, number, number] | null {
    if (this.phase <= 1) return this.tank.present && this.tank.parts.includes(p as BossPart) ? this.tank.partRect(p as BossPart) : null;
    if (p === this.door) return this.doorRect();
    if (p === this.carPart) return this.car ? [this.car.x, this.car.y, 16, 16] : null;
    const g = this.guns.find((q) => q === p);
    return g ? [g.rect[0], g.rect[1], g.rect[2], g.rect[3]] : null;
  }

  /** The part under (x, y), and whether it can be hurt now. */
  private partAt(x: number, y: number, m: number): { p: BossPartLike; open: boolean; cx: number; cy: number } | null {
    for (const g of this.guns) {
      if (g.hp > 0 && this.inRect(x, y, g.rect, m)) return { p: g, open: this.phase >= 2, cx: g.rect[0] + 8, cy: g.rect[1] + 8 };
    }
    const dr = this.doorRect();
    if (this.door.hp > 0 && this.inRect(x, y, dr, m)) return { p: this.door, open: this.phase === 2 && this.exposed(), cx: dr[0] + dr[2] / 2, cy: dr[1] + dr[3] / 2 };
    const c = this.car;
    if (c && this.carPart.hp > 0 && this.inRect(x, y, [c.x, c.y, 16, 16], m)) return { p: this.carPart, open: this.phase === 3, cx: c.cx, cy: c.cy };
    return null;
  }

  bulletHit(b: Bullet): boolean {
    if (this.tank.bulletHit(b)) return true;
    if (b.owner === this.proxy || !b.owner.isPlayer) return false;
    const c = this.car;
    if (c && this.carPart.hp <= 0 && this.inRect(b.x, b.y, [c.x, c.y, 16, 16], 1)) {
      b.alive = false;
      this.w.impact(b, false, true); // the burning car
      return true;
    }
    // margin 3: the shell's 4 px box meets the bunker's steel 2 px before its centre does (with 1, shells from the
    // right or below died on the steel face and never counted)
    const hit = this.partAt(b.x, b.y, 3);
    if (!hit) return false;
    b.alive = false;
    const dmg = 1 + (b.owner.firepower >= 1 ? 1 : 0);
    this.stats.shellHits++;
    this.hitPart(hit, b.x, b.y, dmg, b.owner.player);
    return true;
  }

  droneHit(x: number, y: number, dmg: number, pi: number): boolean {
    if (this.tank.alive && this.tank.droneHit(x, y, dmg, pi)) return true;
    const hit = this.partAt(x, y, 5);
    if (!hit || !this.alive) return false;
    this.stats.droneHits++;
    this.hitPart(hit, x, y, dmg * FINAL.droneMul, pi);
    return true;
  }

  rocketHit(x: number, y: number, dir: number, dmg: number, pi: number): boolean {
    if (this.tank.rocketHit(x, y, dir, dmg, pi)) return true;
    const hit = this.partAt(x, y, 0);
    if (!hit || !this.alive) return false;
    this.stats.rocketHits++;
    this.hitPart(hit, x, y, dmg, pi);
    return true;
  }

  aimPoint(): [number, number] {
    if (this.phase <= 1) return this.tank.aimPoint();
    if (this.phase === 3 && this.car) return [this.car.cx, this.car.cy];
    let best: Gun | null = null;
    for (const g of this.guns) if (g.hp > 0 && (!best || g.hp < best.hp)) best = g;
    if (best) return [best.rect[0] + 8, best.rect[1] + 8];
    const d = this.doorRect();
    return [d[0] + d[2] / 2, d[1] + d[3] / 2];
  }

  private hitPart(h: { p: BossPartLike; open: boolean; cx: number; cy: number }, wx: number, wy: number, dmg: number, pi: number): void {
    const w = this.w;
    if (!h.open) {
      this.noPen(wx, wy, h.p.kind === 'gun' ? 'SHUTTERS CLOSED' : 'GUNS FIRST');
      return;
    }
    const p = h.p;
    p.hp = Math.max(0, p.hp - dmg);
    p.hitT = 10;
    w.sparks(wx, wy, 6 + dmg * 2, [1, 0.8, 0.45]);
    w.flashes.push({ x: wx, y: wy, t: 0, max: 10, r: 40 + dmg * 6, col: [1, 0.6, 0.3], z: 12 });
    w.booms.push({ x: wx, y: wy, big: false, t: 0 });
    w.shake = Math.max(w.shake, 1 + dmg * 0.3);
    w.snd('armor', wx, 1);
    w.popups.push({ x: wx, y: wy - 8, text: `-${dmg}`, t: 0, col: [1, 0.6, 0.3] });
    this.logEv(`hit ${p.id} -${dmg} (${p.hp}/${p.max})`);
    if (p.hp > 0) return;
    if (p.kind === 'car') {
      this.die(pi);
      return;
    }
    w.explode(h.cx, h.cy, true);
    w.shocks.push({ x: h.cx, y: h.cy, t: 0, max: 26, size: 1 });
    w.shake = Math.max(w.shake, 4);
    w.snd('boss-part', h.cx, 0.9);
    debrisBurst(w, h.cx, h.cy, 12, [[0.75, 0.78, 0.8], [0.25, 0.25, 0.26]], 1.6, 10);
    w.scrap += FINAL.partScrap;
    w.popups.push({ x: h.cx, y: h.cy - 14, text: `+${FINAL.partScrap} SCRAP`, t: 0, col: [1, 0.85, 0.4] });
    w.note(`${p.name} DESTROYED`, 'power');
    if (pi >= 0) w.addVetXp(pi, 0.25);
    this.hinted = '';
    if (p.kind === 'gun') {
      const left = this.guns.filter((g) => g.hp > 0).length;
      this.say(WHO, left ? `${this.name}: GUN BUNKER DOWN. ${left} LEFT. HOLD THEM.` : `${this.name}: ALL GUNS ARE SILENT. SEAL THE DOOR.`);
      if (left === 1) {
        const at = w.livePlayers()[0];
        if (w.ai?.bossColumn(at ? at.x : this.cx - 8, at ? at.y : this.cy - 8)) this.stats.columns++;
      }
    } else {
      // the door: blown in, the car comes out
      this.startPhase3();
    }
  }

  private noPen(wx: number, wy: number, why: string): void {
    const w = this.w;
    this.stats.noPen++;
    w.sparks(wx, wy, 7, [1, 0.95, 0.8]);
    w.flashes.push({ x: wx, y: wy, t: 0, max: 6, r: 26, col: [1, 0.9, 0.7], z: 10 });
    w.snd('steel', wx, 1);
    if (w.frame - this.lastPop > 90) {
      this.lastPop = w.frame;
      w.popups.push({ x: wx, y: wy - 8, text: why, t: 0, col: [0.75, 0.8, 0.88] });
    }
    if (this.hinted !== why) {
      this.hinted = why;
      w.note(why === 'GUNS FIRST' ? 'KNOCK OUT THE GUN BUNKERS FIRST' : 'BEAT THE TANK FIRST', 'info');
    }
  }

  /** Debug and sim: skip to the end (each stage settled at once) and destroy the car. */
  kill(pi = -1): void {
    if (this.state === 'hidden') this.reveal();
    if (!this.alive) return;
    const w = this.w;
    if (this.phase === 1) {
      const tk = this.tank;
      if (tk.alive || tk.state === 'dying') {
        tk.turret.hp = 0;
        tk.state = 'dead';
        tk.deadT = 0;
      }
      this.startPhase2();
    }
    if (this.phase === 2) {
      for (const g of this.guns) g.hp = 0;
      this.door.hp = 0;
      this.startPhase3();
    }
    this.carPart.hp = 0;
    this.die(pi);
    this.logEv(`killed (debug) at ${w.frame}`);
  }

  private die(pi: number): void {
    const w = this.w;
    if (!this.alive) return;
    this.state = 'dying';
    this.deathT = 0;
    this.killer = pi;
    this.stats.deaths++;
    this.say(WHO, `${this.name}: CAR IS HIT! I... ALL UNITS, LAY DOWN YOUR ARMS.`);
    w.note('THE COMMAND CAR IS BURNING', 'power');
    w.shake = Math.max(w.shake, 5);
    this.logEv('dying');
  }

  // ---------- the end ----------
  private updateDying(): void {
    const w = this.w;
    const t = ++this.deathT;
    const c = this.car;
    const x = c ? c.cx : this.cx;
    const y = c ? c.cy : this.cy;
    if (t % 10 === 0) {
      const ex = x + (rand() - 0.5) * 16;
      const ey = y + (rand() - 0.5) * 16;
      w.explode(ex, ey, false);
      w.sparks(ex, ey, 8, [1, 0.75, 0.35]);
      w.snd('explode', ex, 0.7);
    }
    if (t % 3 === 0) smokePuff(w, x, y, true);
    if (t >= FINAL.dieFrames) this.finale();
  }

  private finale(): void {
    const w = this.w;
    const c = this.car;
    const x = c ? c.cx : this.cx;
    const y = c ? c.cy : this.cy;
    this.state = 'dead';
    this.deadT = 0;
    this.victory = true;
    this.stats.victories++;
    w.explode(x, y, true);
    w.explode(x - 10, y + 6, true);
    w.explode(x + 8, y - 8, true);
    w.flashes.push({ x, y, t: 0, max: 120, r: 260, col: [1, 0.6, 0.25], z: 30 });
    w.shocks.push({ x, y, t: 0, max: 60, size: 3.4 });
    w.shocks.push({ x, y, t: 0, max: 36, size: 1.6 });
    w.shake = 10;
    w.snd('bigexplode', x, 1);
    debrisBurst(w, x, y, 26, [[0.75, 0.78, 0.8], [0.2, 0.2, 0.2]], 2.4, 10);
    w.decals.push({ k: 1, x, y, r: 18, col: [0.02, 0.02, 0.02], a: 0.6 });
    // rewards
    w.stats.boss++;
    w.stats.bossScrap += FINAL.scrap;
    w.scrap += FINAL.scrap;
    w.popups.push({ x, y: y - 30, text: `+${FINAL.scrap} SCRAP`, t: 0, col: [1, 0.85, 0.4] });
    for (let i = 0; i < FINAL.captured; i++) {
      const id = w.rollFound(true);
      w.partsFound++;
      w.popups.push({ x, y: y - 20 + i * 8, text: id ? '+CAPTURED PART' : '+1 PART', t: 0, col: [0.6, 0.9, 1] });
    }
    w.snd('part', x, 0.9);
    w.snd('clear', x, 1);
    w.note('VICTORY!', 'power');
    w.note('THE WAR IS OVER', 'power');
    if (this.killer >= 0) w.addVetXp(this.killer, 1);
    // the enemy surrenders: tanks stop where they are, drones turn for home, the guns fall silent
    w.freeze = Math.max(w.freeze, FINAL.celebrate + 60 * 10);
    if (w.tricks) {
      w.tricks.barrage = null;
      for (const d of w.tricks.drones) if (d.phase === 'in' || d.phase === 'hover') d.phase = 'out';
    }
    for (const b of w.bullets) if (!b.owner.isPlayer) b.alive = false;
    this.say('HQ', 'THE COMMAND POST HAS FALLEN. THEIR ARMY IS SURRENDERING ALL ALONG THE FRONT. YOU DID IT. YOU ALL DID IT.');
    this.say('SPANNER', 'I WILL PUT THE KETTLE ON. A REAL ONE. NOT DIESEL.');
    this.say('WASP', 'EVERY BELL IN EVERY VILLAGE IS RINGING. CAN YOU HEAR IT?');
    this.logEv('VICTORY');
  }

  private updateDead(): void {
    const w = this.w;
    const t = ++this.deadT;
    const c = this.car;
    if (c && w.frame % 5 === 0) smokePuff(w, c.cx + (rand() - 0.5) * 8, c.cy + (rand() - 0.5) * 8, t < 60 * 20);
    // fireworks over the players and the freed towns
    if (t < FINAL.celebrate && t % 8 === 0) {
      const from: [number, number][] = [];
      for (const p of w.livePlayers()) from.push([p.cx, p.cy]);
      for (const tw of w.towns) if (tw.freed) from.push([tw.cx, tw.cy]);
      if (c) from.push([c.cx, c.cy]);
      const [fx, fy] = from[Math.floor(rand() * from.length)] ?? [this.cx, this.cy];
      const cols: RGB[] = [[1, 0.85, 0.3], [0.4, 0.75, 1], [1, 0.35, 0.3], [0.5, 1, 0.5], [1, 1, 1]];
      this.fireworks.push({
        x: fx + (rand() - 0.5) * 120, y: fy + (rand() - 0.5) * 80, h: 0, vh: 2.2 + rand() * 0.8, t: 0, burst: 30 + Math.floor(rand() * 14),
        col: cols[Math.floor(rand() * cols.length)], sparks: [],
      });
    }
    const keep: Firework[] = [];
    for (const f of this.fireworks) {
      f.t++;
      if (f.t < f.burst) {
        f.h += f.vh;
        f.vh *= 0.97;
      } else if (f.t === f.burst) {
        for (let i = 0; i < 30; i++) {
          const a = (i / 30) * Math.PI * 2 + rand() * 0.2;
          const s = 0.9 + rand() * 0.6;
          f.sparks.push({ x: 0, y: 0, vx: Math.cos(a) * s, vy: Math.sin(a) * s });
        }
        w.snd('firework', f.x, 0.7);
      } else {
        for (const s of f.sparks) {
          s.x += s.vx;
          s.y += s.vy;
          s.vx *= 0.96;
          s.vy = s.vy * 0.96 + 0.02;
        }
      }
      if (f.t < f.burst + 60) keep.push(f);
    }
    this.fireworks = keep;
  }

  /** Smoke from wrecked bunkers and the blown door. */
  private smoke(): void {
    const w = this.w;
    if (w.frame % 9 !== 0) return;
    for (const g of this.guns) if (g.hp <= 0 && this.phase >= 2) smokePuff(w, g.rect[0] + 8, g.rect[1] + 8, true);
    if (this.door.hp <= 0) {
      const d = this.doorRect();
      smokePuff(w, d[0] + d[2] / 2, d[1] + d[3] / 2, false);
    }
  }

  // ---------- drawing ----------
  draw(r: Renderer, ox: number, oy: number, time: number, head: number): void {
    const w = this.w;
    const A = r.atlas.S;
    const f = w.frame;
    const white: RGB = [1, 1, 1];
    const on = (sx: number, sy: number, m: number) => sx > -m && sy > -m && sx < r.nw + m && sy < r.nh + m;
    // the post (always there: a landmark before the fight)
    for (const g of this.guns) {
      const sx = Math.round(ox + g.rect[0]);
      const sy = Math.round(oy + g.rect[1]);
      if (!on(sx, sy, 24)) continue;
      const dead = g.hp <= 0;
      const spr = dead ? A.finGunDead : this.phase >= 2 ? A.finGun : A.finGunShut;
      const flash = g.hitT > 6 ? 0.65 : 0;
      r.sprRot(spr, sx + 8, sy + 8, dead || this.phase < 2 ? angOfDir(this.face) : g.ta, white, MAT_METAL, 0, 1, flash);
      if (dead) {
        const fl = 0.6 + 0.4 * Math.sin(time * 13 + g.rect[0]);
        r.glow(sx + 8, sy + 9, 2.2, [1, 0.5, 0.15], 0.9 * fl);
        r.light(sx + 8, sy + 8, 14, 40, 0.6 * fl, 0.26 * fl, 0.06 * fl, true);
      } else if (g.glow >= 0) {
        const k = g.glow / this.tell(FINAL.gunGlow);
        const pulse = 0.75 + 0.25 * Math.sin(time * 30);
        const [ux, uy] = vecOf(g.ta);
        const mx = sx + 8 + ux * 8;
        const my = sy + 8 + uy * 8;
        r.glow(mx, my, 2 + k * 4, [1, 0.35, 0.12], (1 + k * 3) * pulse);
        r.light(mx, my, 12, 30 + k * 50, 1.1 * k * pulse, 0.3 * k * pulse, 0.1 * k * pulse, false);
        if ((g.glow >> 3) & 1) tellLine(r, mx, my, ux, uy, 14, 90, 110, true);
      } else if (this.phase >= 2) {
        r.glow(sx + 8, sy + 9, 1, [1, 0.2, 0.1], f % 40 < 20 ? 1.2 : 0.3);
      }
    }
    const dr = this.doorRect();
    const dsx = Math.round(ox + dr[0]);
    const dsy = Math.round(oy + dr[1]);
    if (on(dsx, dsy, 24)) {
      // the door sprite is 16 x 6, on the bunker's face (the 8 px door rect's outer edge)
      const df = this.door.hitT > 6 ? 0.65 : 0;
      const [qx, qy] = rotRect([72, 88, 16, 6], this.face, FINAL.site);
      r.spr(this.door.hp > 0 ? A.finDoor : A.finDoorDead, Math.round(ox + this.site[0] + qx), Math.round(oy + this.site[1] + qy), this.face, white, MAT_METAL, 0, 1, df);
      if (this.phase === 2 && this.exposed() && this.door.hp > 0) r.glow(dsx + dr[2] / 2, dsy + dr[3] / 2, 3, [1, 0.8, 0.3], f % 30 < 15 ? 1.4 : 0.4);
    }
    // the command bunker's beacon: red, blinking while the post fights
    const [bx, by] = rotRect([L.beacon[0], L.beacon[1], 0, 0], this.face, FINAL.site);
    if (this.phase < 3 && this.state !== 'dead') {
      const lit = f % 60 < 8;
      r.glow(ox + this.site[0] + bx, oy + this.site[1] + by, 1.6, [1, 0.12, 0.08], lit ? 2.6 : 0.5);
      if (lit) r.light(ox + this.site[0] + bx, oy + this.site[1] + by, 20, 60, 0.8, 0.05, 0.03, false);
    }
    // phase 1: the heavy tank, in winter paint
    if (this.tank.present) {
      const saved = WINTER_KEYS.map((k) => A[k]);
      for (const k of WINTER_KEYS) if (A[`win_${k}`]) A[k] = A[`win_${k}`];
      try {
        this.tank.draw(r, ox, oy, time, head);
      } finally {
        WINTER_KEYS.forEach((k, i) => { A[k] = saved[i]; });
      }
    }
    // phase 3: the command car and the road it runs for
    const c = this.car;
    if (c) {
      const sx = Math.round(ox + c.x);
      const sy = Math.round(oy + c.y);
      const dead = this.carPart.hp <= 0;
      if (on(sx, sy, 40)) {
        const flash = this.carPart.hitT > 6 ? 0.65 : this.state === 'dying' && (f >> 2) & 1 ? 0.25 : 0;
        r.spr(dead && this.state === 'dead' ? A.finCarDead : A[`finCar${Math.floor(c.dist / 2) % 2}`], sx, sy, c.dir, white, MAT_METAL, 0, 1, flash);
        if (!dead) {
          const k = Math.max(0.4, head);
          r.spot(sx + 8 + DX[c.dir] * 8, sy + 8 + DY[c.dir] * 8, 5, 80, 1.0 * k, 0.9 * k, 0.7 * k, true, DX[c.dir], DY[c.dir], 0.8, 0.95);
          const amber = f % 24 < 12;
          r.glow(sx + 8, sy + 9, 1.4, [1, 0.6, 0.1], amber ? 2.4 : 0.4);
          if (amber) r.light(sx + 8, sy + 9, 16, 40, 0.8, 0.45, 0.05, false);
          if (this.carMg.wind > 0) r.glow(sx + 8 + Math.sin(this.carMg.d) * 6, sy + 8 - Math.cos(this.carMg.d) * 6, 2, [1, 0.95, 0.8], (f >> 1) & 1 ? 2.2 : 0.8);
        } else {
          const fl = 0.6 + 0.4 * Math.sin(time * 17);
          r.light(sx + 8, sy + 8, 14, 60, 1.1 * fl, 0.5 * fl, 0.12 * fl, true);
          r.glow(sx + 8, sy + 8, 3 + 2 * fl, [1, 0.5, 0.15], 1.1);
        }
      }
      if (this.exit && this.alive) {
        // the road out: a blinking red box and arrows pointing off the map
        const ex = Math.round(ox + this.exit[0]);
        const ey = Math.round(oy + this.exit[1]);
        if (on(ex, ey, 20)) {
          const lit = (f >> 3) & 1;
          const col: RGB = [1, 0.3, 0.15];
          const a = lit ? 0.95 : 0.4;
          r.ovRect(ex - 2, ey - 2, 20, 1, col, a);
          r.ovRect(ex - 2, ey + 17, 20, 1, col, a);
          r.ovRect(ex - 2, ey - 2, 1, 20, col, a);
          r.ovRect(ex + 17, ey - 2, 1, 20, col, a);
          r.glow(ex + 8, ey + 8, 6, [1, 0.25, 0.1], lit ? 0.6 : 0.2);
        }
      }
    }
    // fireworks: a rising spark, then a burst of coloured sparks that drift down and fade
    for (const fw of this.fireworks) {
      const sx = ox + fw.x;
      const sy = oy + fw.y - fw.h;
      if (!on(sx, sy, 80)) continue;
      if (fw.t < fw.burst) {
        r.glow(sx, sy, 1.5, [1, 0.9, 0.6], 2.5);
        continue;
      }
      const k = 1 - (fw.t - fw.burst) / 60;
      if (fw.t - fw.burst < 8) r.light(sx, sy, 40, 160, fw.col[0] * 1.6 * k, fw.col[1] * 1.6 * k, fw.col[2] * 1.6 * k, false);
      if (fw.t - fw.burst < 4) r.glow(sx, sy, 8, [1, 1, 0.9], 3);
      for (const s of fw.sparks) {
        const px = Math.round(sx + s.x * 1.4);
        const py = Math.round(sy + s.y * 1.4);
        r.fxRect(px, py, 2, 2, fw.col, 4 * k);
        r.glow(px + 1, py + 1, 2.2, fw.col, 1.2 * k);
      }
    }
  }

  fluid(r: Renderer, ox: number, oy: number, f: number, time: number): void {
    if (this.tank.present) this.tank.fluid(r, ox, oy, f, time);
    for (const g of this.guns) {
      if (g.hp > 0 || this.phase < 2) continue;
      r.dyeSplat(ox + g.rect[0] + 8 + Math.sin(time * 3 + g.rect[0]) * 2, oy + g.rect[1] + 6, 5, 0.4 * f, 0.25 * f, 0.06 * f);
      r.velSplat(ox + g.rect[0] + 8, oy + g.rect[1] + 4, 5, 0, -8 * f);
    }
    const c = this.car;
    if (!c) return;
    const x = ox + c.cx;
    const y = oy + c.cy;
    if (x < -80 || y < -80 || x > r.nw + 80 || y > r.nh + 80) return;
    if (this.carPart.hp <= 0) {
      const k = this.state === 'dead' && this.deadT > 60 * 20 ? 0.3 : 1;
      r.dyeSplat(x + Math.sin(time * 3) * 2, y - 2, 6, 0.55 * k * f, 0.4 * k * f, 0.14 * k * f);
      r.velSplat(x, y - 4, 6, 0, -10 * f);
      return;
    }
    r.dyeSplat(x - DX[c.dir] * 9, y - DY[c.dir] * 9, 2.5, (c.moving ? 0.12 : 0.04) * f, 0.08 * f, 0);
    if (c.moving) r.velSplat(x, y, 10, DX[c.dir] * 300 * r.dt, DY[c.dir] * 300 * r.dt);
  }
}
