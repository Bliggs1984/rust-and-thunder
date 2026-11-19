// ?arena=tricks: a small hand-made test map for focused ability and enemy-trick tests (play tests by AI agents and
// people who have a few minutes). Everything worth testing sits within a short drive of the start and comes back
// after it is used up, so a check can be repeated:
// - a WOUNDED enemy tank (armour tank on 1 hp) parked in the open east of the start: drone strike, ambush, shells
// - a PASSING enemy tank driving back and forth along the cross road north of the start (it never fires)
// - a tree belt west of the start road: face it to place an AMBUSH squad
// - a small hidden MINEFIELD on the cross road, west of the junction (label "MINES"): recon, plough, NIGHT EYES
// - a hidden ROCKET TEAM in the trees north-east of the junction (label "ROCKETS")
// - an ARTILLERY pad (hazard square, label "ARTY") west of the trees: drive onto it and a barrage comes down on it
// - an enemy attack DRONE flies in from the north every 10 s or so while none is up
// No towns, no boss, no map events, no enemy spawns; the arena never clears. app.ts starts it with every crew member
// aboard, 9 charges of each ability and 9 lives (tools: README "Dev").
import type { Renderer } from '../gl/renderer';
import { BRICK, DOWN, ENEMY, LEFT, RIGHT, ROAD, STEEL, TREES } from './constants';
import type { RegionSpec } from './region';
import { TR } from './tricks';
import { Tank, type World } from './world';

/** What World asks of an arena each update (world.ts arena hook). */
export interface ArenaHook {
  update(): void;
  /** true = the arena steers this enemy (the world's own logic and the AI skip it) */
  drive(e: Tank): boolean;
  draw(r: Renderer, ox: number, oy: number, time: number): void;
}

const W = 100; // cells (4 px)
const H = 100; // tall enough that the camera can centre the start (not under the HUD)
/** the cross road (tank top-left y) and the passing tank's turning points (tank top-left x) */
const LANE_Y = 176;
const LANE_X: [number, number] = [24, 360];
const WOUNDED: [number, number] = [256, 232];
const PAD = { x: 84, y: 236, s: 24 };
const MINES: [number, number][] = [[70, 181], [84, 186], [98, 182], [112, 187]];
const TEAM: [number, number] = [300, 164];
const AGAIN = 60 * 5; // frames before a used-up target comes back
const DRONE_GAP = 60 * 10;

/** ?arena=tricks (null for anything else). */
export function arenaSpec(kind: string | null): RegionSpec | null {
  if (kind !== 'tricks') return null;
  const c = new Uint8Array(W * H);
  const rect = (x: number, y: number, w: number, h: number, v: number) => {
    for (let j = y; j < y + h; j++) for (let i = x; i < x + w; i++) if (i >= 0 && j >= 0 && i < W && j < H) c[j * W + i] = v;
  };
  rect(0, LANE_Y / 4, W, 4, ROAD); // the cross road
  rect(46, LANE_Y / 4, 4, H - LANE_Y / 4, ROAD); // the start road up to it
  rect(34, 52, 10, 20, TREES); // ambush cover beside the start road
  rect(72, 30, 13, 12, TREES); // the rocket team's wood (its edge faces the junction)
  // a little scenery to the north: a ruined farm and an old bunker, and trees round the edge
  for (const [x, y, w, h] of [[10, 10, 14, 2], [10, 10, 2, 10], [22, 10, 2, 6], [10, 22, 8, 2]]) rect(x, y, w, h, BRICK);
  rect(44, 12, 4, 4, STEEL);
  rect(56, 6, 10, 8, TREES);
  rect(86, 54, 12, 10, TREES);
  rect(4, 58, 6, 14, TREES);
  rect(60, 84, 14, 8, TREES); // south of the start, beside the road
  rect(20, 86, 10, 6, TREES);
  return {
    name: 'TRICKS ARENA', env: 'day', w: W, h: H, cells: c,
    playerSpawns: [[184, 272], [208, 272]],
    enemySpawns: [[LANE_X[0], LANE_Y]],
    enemies: 0, maxActive: 4, towns: [], depots: [],
    exits: [[0, LANE_Y], [(W - 4) * 4, LANE_Y]],
    arena: 'tricks',
  };
}

/** Builds the arena's moving parts on a World made from arenaSpec. */
export class TricksArena implements ArenaHook {
  passing: Tank | null = null;
  wounded: Tank | null = null;
  private passingT = 0;
  private woundedT = 0;
  private padArmed = true;
  private minesT = 0;
  private teamT = 0;
  private nextDrone = 60 * 4;
  private droneUp = false;
  private placed = false;

  constructor(public w: World) {
    if (w.tricks) w.tricks.auto = false; // only what the arena stages
    w.boss = null;
    w.events = null;
    this.passing = this.spawn(LANE_X[0], LANE_Y, 0, RIGHT, ENEMY[0].hp);
    this.wounded = this.spawn(WOUNDED[0], WOUNDED[1], 3, LEFT, 1);
  }

  private spawn(x: number, y: number, etype: number, dir: number, hp: number): Tank | null {
    const w = this.w;
    if (w.tankIn(x, y, 16, 16)) return null;
    const e = new Tank();
    e.x = x;
    e.y = y;
    e.dir = dir;
    e.etype = etype;
    e.hp = hp;
    e.spawn = 60;
    e.persona = 0;
    w.enemies.push(e);
    return e;
  }

  /** Hidden mines and the rocket team, put in by hand (tricks.ts places its own on its first update). */
  private place(): void {
    const tr = this.w.tricks;
    if (!tr) return;
    tr.mines.length = 0;
    for (const [x, y] of MINES) tr.mines.push({ x, y, alive: true, shown: false, decal: false, field: 0 });
    tr.teams.length = 0;
    tr.teams.push({ x: TEAM[0], y: TEAM[1], dir: DOWN, alive: true, shown: false, tell: 0, reload: 0, aim: [TEAM[0], TEAM[1]], ruin: false, ammo: TR.teamAmmo });
    this.placed = true;
  }

  update(): void {
    const w = this.w;
    const tr = w.tricks;
    if (!this.placed) this.place();
    // targets come back a few seconds after they are destroyed
    if (!this.passing?.alive && ++this.passingT > AGAIN) {
      this.passing = this.spawn(LANE_X[0], LANE_Y, 0, RIGHT, ENEMY[0].hp);
      this.passingT = 0;
    }
    if (!this.wounded?.alive && ++this.woundedT > AGAIN) {
      this.wounded = this.spawn(WOUNDED[0], WOUNDED[1], 3, LEFT, 1);
      this.woundedT = 0;
    }
    if (!tr) return;
    // the minefield is laid again once every mine is gone; the rocket team comes back (or reloads)
    if (tr.mines.every((m) => !m.alive)) {
      if (++this.minesT > AGAIN * 2) {
        for (const m of tr.mines) Object.assign(m, { alive: true, shown: false, decal: false });
        this.minesT = 0;
      }
    } else this.minesT = 0;
    const team = tr.teams[0];
    if (team && (!team.alive || team.ammo <= 0)) {
      if (++this.teamT > AGAIN * 2) {
        Object.assign(team, { alive: true, shown: false, tell: 0, reload: 0, ammo: TR.teamAmmo });
        this.teamT = 0;
      }
    } else this.teamT = 0;
    // an attack drone from the north edge, a while after the last one is gone
    const up = tr.drones.some((d) => d.phase !== 'dead');
    if (this.droneUp && !up) this.nextDrone = w.frame + DRONE_GAP;
    this.droneUp = up;
    const p0 = w.players[0];
    if (!up && w.frame >= this.nextDrone && p0?.alive && !p0.spawn) {
      if (tr.launchDrone(0, 'attack', [Math.max(8, Math.min(w.pxW - 8, p0.cx + 40)), 6])) this.droneUp = true;
      this.nextDrone = w.frame + DRONE_GAP;
    }
    // artillery: a barrage on the pad when a tank drives onto it; armed again once the pad is empty
    const on = w.livePlayers().some((p) => p.cx >= PAD.x && p.cx < PAD.x + PAD.s && p.cy >= PAD.y && p.cy < PAD.y + PAD.s);
    if (on && this.padArmed && !tr.barrage && tr.startBarrage(PAD.x + PAD.s / 2, PAD.y + PAD.s / 2, false)) {
      this.padArmed = false; // (the barrage radios and toasts INCOMING! itself)
    } else if (!on && !tr.barrage) this.padArmed = true;
  }

  drive(e: Tank): boolean {
    if (e === this.wounded) return true; // parked, never fires
    if (e !== this.passing) return false;
    // back and forth along the cross road; it never fires
    if ((e.dir === RIGHT && e.x >= LANE_X[1]) || (e.dir === LEFT && e.x <= LANE_X[0])) this.w.turn(e, e.dir === RIGHT ? LEFT : RIGHT);
    else if (e.dir !== LEFT && e.dir !== RIGHT) this.w.turn(e, RIGHT);
    const moved = this.w.move(e, ENEMY[e.etype].speed);
    e.blocked = !moved;
    if (!moved && this.w.frame % 90 === 0) this.w.turn(e, e.dir === RIGHT ? LEFT : RIGHT); // a tank in the way
    return true;
  }

  /** Unlit labels and the artillery pad's hazard square (pixel font from the atlas). */
  draw(r: Renderer, ox: number, oy: number, time: number): void {
    const S = r.atlas.S;
    const GOLD = [1, 0.8, 0.3];
    const RED = [1, 0.35, 0.25];
    const label = (text: string, x: number, y: number, col: number[], a = 0.85) => {
      let px = Math.round(ox + x - (text.length * 6 - 1) / 2);
      const py = Math.round(oy + y);
      r.ovRect(px - 2, py - 2, text.length * 6 + 3, 11, [0.02, 0.02, 0.03], 0.55 * a);
      for (const ch of text) {
        const s = S[`ch_${ch}`];
        if (s) r.ovSpr(s, px, py, col, a);
        px += 6;
      }
    };
    // the pad: yellow and black hazard border, blinking while a barrage is coming down
    const x = Math.round(ox + PAD.x);
    const y = Math.round(oy + PAD.y);
    const n = PAD.s;
    const live = !!this.w.tricks?.barrage;
    const a = live ? (Math.floor(time * 6) % 2 ? 1 : 0.4) : 0.75;
    for (let i = 0; i < n; i += 4) {
      const col = (i / 4) % 2 ? [0.06, 0.05, 0.03] : [1, 0.82, 0.2];
      r.ovRect(x + i, y, 4, 2, col, a);
      r.ovRect(x + n - 4 - i, y + n - 2, 4, 2, col, a);
      r.ovRect(x, y + n - 4 - i, 2, 4, col, a);
      r.ovRect(x + n - 2, y + i, 2, 4, col, a);
    }
    label('ARTY', PAD.x + n / 2, PAD.y + n + 3, live ? RED : GOLD);
    label('MINES', (MINES[0][0] + MINES[MINES.length - 1][0]) / 2, LANE_Y + 19, GOLD, 0.7);
    label('ROCKETS', TEAM[0] + 4, 108, GOLD, 0.7);
    if (this.wounded?.alive && !this.wounded.spawn) label('1 HP', WOUNDED[0] + 8, WOUNDED[1] + 19, RED, 0.7);
  }
}

/** Puts the arena on a World built from arenaSpec (save.ts regionWorld): every ability with 9 charges, 9 lives. */
export function attachArena(w: World): TricksArena {
  const a = new TricksArena(w);
  w.arena = a;
  w.charges = [9, 9, 9, 9];
  for (let i = 0; i < w.nPlayers; i++) w.ps[i].lives = 9;
  return a;
}
