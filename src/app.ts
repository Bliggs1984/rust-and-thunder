import { NH, NW, type Renderer } from './gl/renderer';
import type { Input } from './input';
import { REGION_THEMES, type MusicMode, type Sound } from './audio';
import { FONT } from './art/font';
import { BRICK, MAT_GROUND } from './game/constants';
import { regionBot } from './game/bot';
import { Camera } from './game/camera';
import { BOSS } from './game/boss'; // Phase 4 bosses
import { bossTestSpec } from './game/bosses/testmaps'; // Phase 4 ?bosstest=
import { arenaSpec } from './game/arena'; // ?arena=tricks
import { ENVS, Weather, drawCells, drawWorld, setEnv, view } from './game/draw';
import { newRun, type RunState } from './game/run';
import {
  applyRunToWorld, bonusLives, campaignRegion, freshRun, loadRun, regionKind, regionName, regionProgress, regionSpecFor, regionWorld, retreatEase, saveRun, syncRun,
} from './game/save';
import {
  CAMPAIGN_TITLE, STORY_REGIONS, answerBriefing, briefingDue, briefingPages, callsAboard, completeCampaign, completeRows, debriefLine,
  endingPages, introQuote, noteRegionClear, regionHint, rewardLabel, skipBriefing,
} from './game/story'; // Phase 5 story
import { openComplete, openStory } from './ui-story'; // Phase 5 story
import { Tips } from './tips'; // M5 first-play prompts
import { campMapFromSpec, campMapFromWorld } from './ui-campmap'; // Phase 5 camp MAP tab
import { DEPOT_SCRAP, FREE_SCRAP, HITSTOP_BOSS, World, newPState, type PInput, type PState, type RegionSpec, type TownState } from './game/world';
import { UI, type MenuItem, type Screen } from './ui';
import { openCamp, openRecruit, type CampResult } from './ui-garage';
import { XP, allCrew, crewById, crewTick, crewXp, deferCrew, ensureCrew, joinCrew, recruitOffer, waitingRecruit } from './game/crew'; // Phase 3 crew
import { openEventCard } from './ui-events'; // Phase 5 events hook

/** campmenu = the CAMPAIGN submenu on the title; retreat / regionclear / camp = the campaign run loop's screens;
 * recruit = the Phase 3 recruit card (the game is paused under it); event = a Phase 5 map event card (paused too) */
type Mode = 'title' | 'campmenu' | 'intro' | 'play' | 'tally' | 'gameover' | 'retreat' | 'regionclear' | 'camp' | 'recruit' | 'story' | 'event';

const GW = 64; // full-screen cell grid for brick lettering
const GH = 56;
/** the OS asks for less motion: title lightning flashes are toned down */
const REDUCED_MOTION = typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;
const TITLE_ITEMS = ['1 PLAYER', '2 PLAYERS', 'CAMPAIGN', 'SETTINGS'];
const PAUSE_ITEMS = ['RESUME', 'SETTINGS', 'RESTART STAGE', 'QUIT TO TITLE'];
const OVER_ITEMS = ['CONTINUE', 'MAIN MENU'];
/** Who speaks on the retreat screen, and what. */
const RETREAT_WHO = 'SPANNER';
const RETREAT_LINE = "WE FALL BACK TO THE ROAD. THE TANK IS DENTED, THE CREW IS ANGRY, NOTHING IS LOST THAT A WRENCH CAN'T FIX.";
const VET_NAMES = ['', 'I', 'II', 'III'];

type CampItem = { id: 'continue' | 'new' | 'players' | 'back'; item: MenuItem };

/**
 * Campaign native screen for a window of w x h: the arcade 256 x 224 widened (landscape) or
 * heightened (portrait) to the window's shape, so the map fills the window at the same pixel scale.
 * Landscape: 224 tall, width = aspect x 224 rounded to even, 256-480. Narrower than 8:7: 256 wide,
 * height to match, 224-448. Beyond the clamps the renderer letterboxes (dark bars).
 */
export function campaignNative(w: number, h: number): [number, number] {
  const even = (v: number) => 2 * Math.round(v / 2);
  w = Math.max(1, w);
  h = Math.max(1, h);
  if (w * NH >= h * NW) return [Math.max(NW, Math.min(480, even((NH * w) / h))), NH];
  return [NW, Math.max(NH, Math.min(448, even((NW * h) / w)))];
}

function brickText(cells: Uint8Array, s: string, cx: number, cy: number, scale: number, type = BRICK): void {
  for (let i = 0; i < s.length; i++) {
    const g = FONT[s[i]];
    if (!g) continue;
    for (let gy = 0; gy < 7; gy++) for (let gx = 0; gx < 5; gx++) {
      if (!g[gy][gx]) continue;
      for (let sy = 0; sy < scale; sy++) for (let sx = 0; sx < scale; sx++) {
        const x = cx + i * 6 * scale + gx * scale + sx;
        const y = cy + gy * scale + sy;
        if (x >= 0 && y >= 0 && x < GW && y < GH) cells[y * GW + x] = type;
      }
    }
  }
}

export interface AppOpts {
  autoplay: boolean;
  debug: boolean;
  autostart: boolean;
  stage: number;
  players: number;
  /** seed of the campaign test region (?region=N); 0 = arcade */
  region: number;
}

interface Settings {
  rtx: boolean;
  pixel: boolean;
  crt: boolean;
  music: number; // 0..10
  sfx: number;
  fps: boolean;
}

/**
 * Toasts from one update that belong together share a line (G3): two plain notes of the same kind in a row
 * ("VICTORY!" + "THE WAR IS OVER") become "A · B" while the line stays short. Icon and long-lived notes stay alone.
 */
const MERGE_MAX = 34;
export function mergeNotes(notes: World['notes']): World['notes'] {
  const out: World['notes'] = [];
  for (const n of notes) {
    const last = out[out.length - 1];
    const plain = (m: typeof n) => m.icon < 0 && !m.ms;
    if (last && last.kind === n.kind && plain(last) && plain(n) && !last.text.includes(' · ') && last.text.length + n.text.length + 3 <= MERGE_MAX) {
      out[out.length - 1] = { ...last, text: `${last.text} · ${n.text}` };
    } else out.push(n);
  }
  return out;
}

export class App {
  mode: Mode = 'title';
  t = 0;
  nPlayers = 1;
  ps: PState[] = [];
  stage = 1;
  world: World | null = null;
  /** follows the players on maps bigger than the screen (region mode); null in arcade */
  cam: Camera | null = null;
  paused = false;
  hi: number;
  sel = 0;
  menuSel = 0;
  /** pause-menu item waiting for a second press (restart / quit), -1 = none */
  confirmSel = -1;
  settingsOpen = false;
  settingsSel = 0;
  canSelect = false;
  deployT = -1;
  nextAfterTally: 'intro' | 'gameover' = 'intro';
  titleCells = new Uint8Array(GW * GH);
  overCells = new Uint8Array(GW * GH);
  titleY = NH;
  /** title lightning: frames to the next strike (counts once the logo is up), and the bolt being drawn */
  nextTitleBolt = 24;
  titleBolt: { main: number[][]; branch: number[][]; x: number; y: number } | null = null;
  weather = new Weather();
  thunder: { f: number; near: number }[] = [];
  ui: UI;
  fpsValue = 0;
  settings: Settings;
  tallyCounts: number[][] = [[0, 0, 0, 0], [0, 0, 0, 0]];
  record = false;
  // ---------- campaign run loop (Phase 2) ----------
  /** the campaign run being played (also a throwaway one for ?region=N quick tests); null in arcade */
  run: RunState | null = null;
  /** false for ?region=N quick tests: nothing is saved */
  runSaves = false;
  /** ?region=N: the quick-test map seed (0 = the run's own regions) */
  testSeed = 0;
  /** Phase 4: ?bosstest= map (a fresh copy each attempt) */
  bossSpec: RegionSpec | null = null;
  /** players for a campaign started from the menu (CREW row) */
  campPlayers = 1;
  /** the save shown in the CAMPAIGN submenu (read when it opens) */
  campSave: RunState | null = null;
  /** freed towns / destroyed depots (counts on the map) already autosaved for */
  private seenTowns = 0;
  private seenDepots = 0;
  /** what happens when the camp closes: back to the region, or on to the next one */
  private campThen: 'play' | 'region' = 'play';
  /** the workshop the player is standing at (for the prompt) */
  private workshop: { town: TownState; safe: boolean } | null = null;
  private clearScreen: { region: number; name: string; rows: [string, string][]; foot: string; quote?: { who: string; text: string } } | null = null;
  private retreatScreen: { region: number; name: string; kept: string; next: string } | null = null;
  private slow = 0;
  private lastDraw = 0;
  // ---------- Phase 3 crew: recruiting ----------
  /** a freed town's recruit, shown after a short delay (frames) so the FREED moment plays first */
  private offer: { id: string; place: string; t: number } | null = null;
  // ---------- end Phase 3 crew fields ----------

  constructor(public r: Renderer, public input: Input, public sfx: Sound, public opts: AppOpts) {
    // storage keys keep the old name (Tank 1990 NEO): renaming them would wipe players' hi-scores and settings
    this.hi = Number(localStorage.getItem('tank1990neo.hi')) || 20000;
    const saved = JSON.parse(localStorage.getItem('tank1990neo.settings') ?? '{}') as Partial<Settings>;
    this.settings = { rtx: true, pixel: false, crt: false, music: 5, sfx: 8, fps: false, ...saved };
    if (r.crt) this.settings.crt = true;
    this.applySettings();
    brickText(this.overCells, 'GAME', 9, 4, 2);
    brickText(this.overCells, 'OVER', 9, 21, 2);
    this.ui = new UI(r.atlas, {
      hover: (i) => this.menuHover(i),
      click: (i, adj) => this.menuClick(i, adj),
    });
    // squelch + blip as each radio line comes up (a no-op until audio.ts has the 'radio' sound)
    this.ui.onRadio = () => this.sfx.play('radio');
    if (opts.autostart) this.startGame(opts.players, opts.stage, false);
  }

  // ---------- settings ----------
  applySettings(): void {
    const s = this.settings;
    this.r.rtx = s.rtx;
    this.r.pixel = s.pixel;
    this.r.crt = s.crt;
    this.sfx.setVolumes(s.sfx / 10, s.music / 10);
    localStorage.setItem('tank1990neo.settings', JSON.stringify(s));
  }

  settingsItems(): MenuItem[] {
    const s = this.settings;
    const on = (b: boolean) => (b ? 'ON' : 'OFF');
    return [
      { label: 'RTX LIGHTING', value: on(s.rtx) },
      { label: 'LIGHT STYLE', value: s.pixel ? 'PIXEL' : 'SMOOTH' },
      { label: 'CRT FILTER', value: on(s.crt) },
      { label: 'MUSIC', meter: s.music, adjustable: true },
      { label: 'SOUND FX', meter: s.sfx, adjustable: true },
      { label: 'FULLSCREEN', value: on(!!document.fullscreenElement) },
      { label: 'SHOW FPS', value: on(s.fps) },
      { label: 'BACK' },
    ];
  }

  changeSetting(i: number, d: number): void {
    const s = this.settings;
    switch (i) {
      case 0: s.rtx = !s.rtx; break;
      case 1: s.pixel = !s.pixel; break;
      case 2: s.crt = !s.crt; break;
      case 3: s.music = Math.max(0, Math.min(10, s.music + (d || 1))); if (!d && s.music === 10) s.music = 0; break;
      case 4: s.sfx = Math.max(0, Math.min(10, s.sfx + (d || 1))); if (!d && s.sfx === 10) s.sfx = 0; break;
      case 5: this.toggleFullscreen(); break;
      case 6: s.fps = !s.fps; break;
      case 7: this.settingsOpen = false; this.sfx.play('ui-back'); return;
    }
    this.applySettings();
    this.sfx.play(i === 4 ? 'tick' : 'ui-move');
  }

  toggleFullscreen(): void {
    if (document.fullscreenElement) void document.exitFullscreen();
    else void document.documentElement.requestFullscreen?.();
  }

  // ---------- mouse ----------
  menuHover(i: number): void {
    if (this.settingsOpen) {
      if (i !== this.settingsSel) { this.settingsSel = i; this.sfx.play('ui-move'); }
    } else if (this.mode === 'title' || this.mode === 'campmenu' || (this.mode === 'play' && this.paused) || this.mode === 'gameover') {
      if (i !== this.menuSel) { this.menuSel = i; this.confirmSel = -1; this.sfx.play('ui-move'); }
    }
  }

  menuClick(i: number, adj: number): void {
    if (this.settingsOpen) {
      this.settingsSel = i;
      this.changeSetting(i, adj);
      return;
    }
    this.menuSel = i;
    this.activate();
  }

  // ---------- flow ----------
  setMode(m: Mode): void {
    if (m === 'title' && this.mode !== 'title') this.nextTitleBolt = 24;
    // a modal card (recruit, event, briefing, camp) opening or closing: drop held keys, so a key that was down
    // when it opened (and whose release the card may have swallowed) cannot keep driving the tank afterwards
    const modal = (x: Mode) => x === 'camp' || x === 'recruit' || x === 'story' || x === 'event';
    if (modal(m) !== modal(this.mode)) this.input.releaseAll();
    this.mode = m;
    this.t = 0;
    this.menuSel = 0;
  }

  startGame(players: number, stage = 1, select = true): void {
    // Phase 4: ?bosstest=heli|final: a throwaway run on a small hand-made map for that boss (src/game/bosses/testmaps.ts)
    const bt = bossTestSpec(new URLSearchParams(location.search).get('bosstest'));
    // ?arena=tricks: a throwaway run on a small test map for abilities and enemy tricks (src/game/arena.ts)
    const arena = arenaSpec(new URLSearchParams(location.search).get('arena'));
    if (arena) {
      const run = newRun(11);
      run.crew = allCrew();
      run.charges = [9, 9, 9, 9];
      this.bossSpec = arena;
      this.startCampaign(run, false, players, 0);
      return;
    }
    if (bt) {
      const run = newRun(7);
      run.region = bt.boss === 'final' ? 4 : bt.boss === 'heli' ? 3 : bt.boss === 'flagship' ? 2 : bt.boss === 'train' ? 1 : 3;
      run.crew = new URLSearchParams(location.search).get('crew') === 'all' ? allCrew() : undefined;
      this.bossSpec = bt;
      this.startCampaign(run, false, players, 0);
      return;
    }
    this.bossSpec = null;
    if (this.opts.region) {
      // ?region=N quick test: a throwaway run on test map N (stage = region number), never saved
      const run = newRun(this.opts.region);
      run.region = stage - 1;
      // Phase 3: ?crew=all puts the whole catalogue aboard (ability tests); otherwise the two starters
      run.crew = new URLSearchParams(location.search).get('crew') === 'all' ? allCrew() : undefined;
      this.startCampaign(run, false, players, this.opts.region);
      return;
    }
    this.run = null;
    this.nPlayers = players;
    this.ps = [newPState(), newPState()];
    this.stage = stage;
    this.canSelect = select;
    this.beginStage();
  }

  /** Start (or continue) a campaign run at its current region. saves = autosave to localStorage. */
  startCampaign(run: RunState, saves: boolean, players = this.campPlayers, testSeed = 0): void {
    this.run = run;
    ensureCrew(run); // Phase 3: runs from before crew get TRACTOR and SPANNER
    this.runSaves = saves;
    this.testSeed = testSeed;
    this.nPlayers = players;
    this.ps = [newPState(), newPState()];
    this.canSelect = false;
    if (saves) saveRun(run);
    this.beginStage();
  }

  beginStage(): void {
    // Phase 5 story: a story region's briefing (the opening first, on a new campaign) comes before its intro card;
    // demos (autoplay) answer it at once with the first answer; quick tests (?region=N) have none
    if (this.run && this.runSaves && briefingDue(this.run)) {
      if (this.opts.autoplay) answerBriefing(this.run, 0);
      else {
        this.showBriefing();
        return;
      }
    }
    this.world = this.newWorld();
    this.r.clearDecals = true;
    this.r.resetHistory = true;
    this.paused = false;
    this.deployT = -1;
    this.seenTowns = this.world.towns.filter((t) => t.freed).length; // kept from an earlier attempt
    this.seenDepots = this.world.depots.filter((d) => d.destroyed).length;
    this.workshop = null;
    this.offer = null; // Phase 3
    this.setMode('intro');
  }

  newWorld(): World {
    // campaign: the run's region (refills this.ps: lives with the retreat bonus, veterancy); arcade: the stage
    const run = this.run;
    if (run) this.stage = run.region + 1;
    const w = run ? regionWorld(run, this.ps, this.nPlayers, this.testSeed, this.bossSpec ?? undefined) : new World(this.stage, this.ps, this.nPlayers);
    // Phase 5: an ASK FIRST answer is repeated on the radio once the region starts
    const hint = run && regionHint(run);
    if (hint) {
      w.radio.push(hint);
      w.lairKnown = true; // and the maps mark the boss's lair from the start
    }
    // ?bosstest=: short boss tests start with the boss already revealed (no towns to free first)
    if (this.bossSpec) w.boss?.reveal();
    const [vw, vh] = this.campaignSize();
    this.cam = w.region ? new Camera(vw, vh, w.pxW, w.pxH) : null;
    this.fitView(w, vw, vh);
    this.cam?.snap(this.camTargets(w));
    return w;
  }

  /** The campaign native screen for the current window. */
  campaignSize(): [number, number] {
    const c = this.r.canvas;
    return campaignNative(c.clientWidth || window.innerWidth, c.clientHeight || window.innerHeight);
  }

  /** Camera and co-op leash follow the native screen size (it changes with the window in campaign). */
  fitView(w: World, vw = this.r.nw, vh = this.r.nh): void {
    if (!this.cam) return;
    this.cam.setView(vw, vh);
    // co-op on one shared screen: the players can't drive further apart than the camera can show
    if (this.nPlayers === 2) {
      // co-op: wider margins keep both tanks clear of the HUD plates (corners) and the command cluster (bottom)
      this.cam.edgeX = 40;
      this.cam.edgeY = 52;
      w.leash = { w: this.cam.viewW - 2 * this.cam.edgeX, h: this.cam.viewH - 2 * this.cam.edgeY };
    }
  }

  camTargets(w: World): { cx: number; cy: number; dir: number; moving: boolean }[] {
    return w.players.filter((p) => !!p && p.alive).map((p) => ({ cx: p!.cx, cy: p!.cy, dir: p!.dir, moving: p!.moving }));
  }

  saveHi(): void {
    const best = Math.max(...this.ps.map((p) => p.score));
    if (best > this.hi) {
      this.hi = best;
      this.record = true;
      localStorage.setItem('tank1990neo.hi', String(best));
    }
  }

  playerInput(i: number): PInput {
    const inp = this.input;
    const two = this.nPlayers === 2;
    let dir: number;
    let fire: boolean;
    if (i === 0) {
      dir = inp.dir(two
        ? [['KeyW'], ['KeyD'], ['KeyS'], ['KeyA']]
        : [['ArrowUp', 'KeyW'], ['ArrowRight', 'KeyD'], ['ArrowDown', 'KeyS'], ['ArrowLeft', 'KeyA']]);
      // held, or pressed since the last update: a tap shorter than one tick still counts (shots, drone cancel)
      const p1 = two ? ['Space', 'KeyE', 'KeyG'] : ['Space', 'KeyJ', 'KeyZ', 'KeyK', 'KeyX'];
      fire = inp.held(...p1) || inp.hit(...p1);
    } else {
      dir = inp.dir([['ArrowUp'], ['ArrowRight'], ['ArrowDown'], ['ArrowLeft']]);
      const p2 = ['Enter', 'NumpadEnter', 'Numpad0', 'ShiftRight', 'ControlRight', 'Slash'];
      fire = inp.held(...p2) || inp.hit(...p2);
    }
    const pad = inp.pads[two ? i : 0];
    if (pad) {
      if (pad.dir >= 0) dir = pad.dir;
      fire ||= pad.fire;
    }
    return { dir, fire, ability: this.cam ? this.abilityKey(i, pad?.ability ?? 0) : 0, abilityHeld: this.cam ? this.abilityHeldKey(i) : 0 };
  }

  /**
   * Campaign ability pressed this update (1-4 = drone, ambush, recon, patch; 0 = none). Solo: 1-4 on the top row or
   * the numpad. Co-op: player 1 the top row, player 2 the numpad, or 7-0 on keyboards without one. Pads: LB/RB + d-pad.
   */
  abilityKey(i: number, pad: number): number {
    const inp = this.input;
    const keys = this.nPlayers === 2
      ? i === 0 ? [['Digit1'], ['Digit2'], ['Digit3'], ['Digit4']] : [['Numpad1', 'Digit7'], ['Numpad2', 'Digit8'], ['Numpad3', 'Digit9'], ['Numpad4', 'Digit0']]
      : [['Digit1', 'Numpad1'], ['Digit2', 'Numpad2'], ['Digit3', 'Numpad3'], ['Digit4', 'Numpad4']];
    // debug power-ups move to Shift + digit in region mode, so the digits stay free for abilities
    if (this.opts.debug && inp.held('ShiftLeft', 'ShiftRight')) return 0;
    const k = keys.findIndex((codes) => inp.hit(...codes));
    return k >= 0 ? k + 1 : pad;
  }

  /** Campaign ability key held (1-3) for aiming; same keys as abilityKey. Pads: not yet (Phase 3 abilities agent). */
  abilityHeldKey(i: number): number {
    const inp = this.input;
    if (this.opts.debug && inp.held('ShiftLeft', 'ShiftRight')) return 0;
    const keys = this.nPlayers === 2
      ? i === 0 ? [['Digit1'], ['Digit2'], ['Digit3']] : [['Numpad1', 'Digit7'], ['Numpad2', 'Digit8'], ['Numpad3', 'Digit9']]
      : [['Digit1', 'Numpad1'], ['Digit2', 'Numpad2'], ['Digit3', 'Numpad3']];
    const k = keys.findIndex((codes) => inp.held(...codes));
    return k >= 0 ? k + 1 : 0;
  }

  /** Simple autopilot for P1 (?autoplay=1), used for demos and screenshot tests. */
  botInput(w: World): PInput {
    const t = w.players[0];
    if (!t || t.spawn) return { dir: -1, fire: false };
    let best = null as null | { cx: number; cy: number };
    let bd = Infinity;
    for (const e of w.enemies) {
      if (!e.alive || e.spawn) continue;
      const d = Math.abs(e.cx - t.cx) + Math.abs(e.cy - t.cy);
      if (d < bd) {
        bd = d;
        best = e;
      }
    }
    if (w.power) {
      const p = { cx: w.power.x + 8, cy: w.power.y + 8 };
      if (Math.abs(p.cx - t.cx) + Math.abs(p.cy - t.cy) < bd * 1.3) best = p;
    }
    if (!best) return { dir: (w.frame >> 6) % 2 ? 1 : 3, fire: t.cy < 170 };
    const dx = best.cx - t.cx;
    const dy = best.cy - t.cy;
    const wobble = (w.frame >> 5) % 5 === 0;
    let dir: number;
    if (Math.abs(dx) < 6) dir = dy < 0 ? 0 : 2;
    else if (Math.abs(dy) < 6) dir = dx < 0 ? 3 : 1;
    else dir = (Math.abs(dx) < Math.abs(dy)) !== wobble ? (dx < 0 ? 3 : 1) : dy < 0 ? 0 : 2;
    const f = t.dir;
    const hitsBase = f === 1 || f === 3 ? t.cy > 178 && (f === 1 ? t.cx < 120 : t.cx > 88) : t.cx > 82 && t.cx < 126 && f === 2;
    return { dir, fire: !hitsBase };
  }

  // ---------- update ----------
  update(): void {
    // campaign: shoulder + d-pad picks abilities (read in poll)
    this.input.abilityPad = !!this.cam && this.mode === 'play';
    this.input.poll();
    const inp = this.input;
    // the camp / garage screen owns the keyboard while it is open (its keys may overlap the hotkeys below)
    if (this.mode === 'camp' || this.mode === 'recruit' || this.mode === 'story' || this.mode === 'event') { // Phase 5 events hook
      this.t++;
      this.updateWeather();
      this.updateAudio();
      this.updateUI();
      return;
    }
    if (inp.hit('KeyM')) {
      this.sfx.setMuted(!this.sfx.muted);
    }
    if (inp.hit('KeyC')) {
      this.settings.crt = !this.settings.crt;
      this.applySettings();
    }
    if (inp.hit('KeyR')) {
      this.settings.rtx = !this.settings.rtx;
      this.applySettings();
      this.ui.toast(this.settings.rtx ? 'RTX LIGHTING ON' : 'RTX LIGHTING OFF', 'info');
      this.sfx.play('ui-ok');
    }
    if (inp.hit('KeyF')) this.toggleFullscreen();
    if (inp.hit('Backquote')) {
      this.settings.fps = !this.settings.fps;
      this.applySettings();
    }
    this.t++;
    if (this.settingsOpen) this.updateSettings();
    else {
      switch (this.mode) {
        case 'title': this.updateTitle(); break;
        case 'campmenu': this.updateCampMenu(); break;
        case 'intro': this.updateIntro(); break;
        case 'play': this.updatePlay(); break;
        case 'tally': this.updateTally(); break;
        case 'gameover': this.updateGameOver(); break;
        case 'retreat': this.updateRetreat(); break;
        case 'regionclear': this.updateRegionClear(); break;
      }
    }
    this.updateWeather();
    this.updateAudio();
    this.updateUI();
  }

  updateSettings(): void {
    const inp = this.input;
    const d = inp.navDir();
    const n = this.settingsItems().length;
    if (d === 0 || d === 2) {
      this.settingsSel = (this.settingsSel + (d === 2 ? 1 : n - 1)) % n;
      this.sfx.play('ui-move');
    } else if (d === 1 || d === 3) {
      if (this.settingsSel !== 7) this.changeSetting(this.settingsSel, d === 1 ? 1 : -1);
    } else if (inp.ok()) {
      this.changeSetting(this.settingsSel, 0);
    } else if (inp.back()) {
      this.settingsOpen = false;
      this.sfx.play('ui-back');
    }
  }

  /** Up/down through a menu. Returns true if the selection moved this update. */
  navMenu(n: number): boolean {
    const d = this.input.navDir();
    if (d === 0 || d === 2) {
      this.menuSel = (this.menuSel + (d === 2 ? 1 : n - 1)) % n;
      this.confirmSel = -1;
      this.sfx.play('ui-move');
      return true;
    }
    return false;
  }

  /** Confirm the highlighted item of the current menu. */
  activate(): void {
    const i = this.menuSel;
    if (this.mode === 'title') {
      this.sfx.play('ui-ok');
      if (i < 2) {
        this.opts.region = 0;
        this.startGame(i + 1);
      } else if (i === 2) {
        this.openCampMenu();
      } else this.openSettings();
    } else if (this.mode === 'campmenu') {
      this.activateCampMenu(i);
    } else if (this.mode === 'play' && this.paused) {
      // restart and quit throw the run away, so they ask twice
      if ((i === 2 || i === 3) && this.confirmSel !== i) {
        this.confirmSel = i;
        this.sfx.play('ui-move');
        return;
      }
      this.confirmSel = -1;
      this.sfx.play('ui-ok');
      if (i === 0) this.paused = false;
      else if (i === 1) this.openSettings();
      else if (i === 2) {
        for (const p of this.ps) p.out = false;
        this.canSelect = false;
        this.beginStage();
      } else {
        // campaign: the run is kept (the region restarts at its start when continued)
        if (this.run && this.world) {
          syncRun(this.world, this.run);
          this.autosave();
        }
        this.run = null;
        this.world = null;
        this.setMode('title');
      }
    } else if (this.mode === 'gameover') {
      this.sfx.play('ui-ok');
      if (i === 0) {
        this.ps = [newPState(), newPState()];
        this.canSelect = false;
        this.beginStage();
      } else {
        this.world = null;
        this.titleY = 0;
        this.setMode('title');
      }
    }
  }

  openSettings(): void {
    this.settingsOpen = true;
    this.settingsSel = 0;
  }

  // ---------- campaign submenu (title → CAMPAIGN) ----------
  openCampMenu(): void {
    this.campSave = loadRun();
    this.setMode('campmenu');
    this.confirmSel = -1;
  }

  /** CONTINUE (only with a save), NEW CAMPAIGN (asks first if it would overwrite a save), CREW, BACK. */
  campMenuItems(): CampItem[] {
    const s = this.campSave;
    const out: CampItem[] = [];
    if (s?.completed) {
      // Phase 5: the campaign is done; the save carries on as endless LIBERATION mode
      out.push({ id: 'continue', item: { label: 'LIBERATION MODE', note: [
        'CAMPAIGN COMPLETE · KEEP FREEING REGIONS',
        `REGION ${s.region + 1} · ${regionName(s.region)} · ${s.scrap} SCRAP`,
      ] } });
    } else if (s) {
      const rt = s.retreats ? ` · ${s.retreats} RETREAT${s.retreats > 1 ? 'S' : ''}` : '';
      const kept = regionProgress(s)?.towns.length ?? 0;
      out.push({ id: 'continue', item: { label: 'CONTINUE', note: [
        `REGION ${s.region + 1} · ${regionName(s.region)} · ${kept ? `${kept} TOWN${kept > 1 ? 'S' : ''} KEPT · ` : ''}RESTARTS AT THE ROAD`,
        `${s.scrap} SCRAP · ${s.bin.length} PART${s.bin.length === 1 ? '' : 'S'}${rt}`,
      ] } });
    }
    const confirm = this.confirmSel === out.length;
    out.push({ id: 'new', item: confirm
      ? { label: 'REALLY START OVER?', tone: 'warn', note: ['THE SAVED CAMPAIGN WILL BE LOST'] }
      : { label: 'NEW CAMPAIGN' } });
    out.push({ id: 'players', item: { label: 'CREW', value: this.campPlayers === 2 ? '2 TANKS' : '1 TANK' } });
    out.push({ id: 'back', item: { label: 'BACK' } });
    return out;
  }

  activateCampMenu(i: number): void {
    const id = this.campMenuItems()[i]?.id;
    if (id === 'new' && this.campSave && this.confirmSel !== i) {
      this.confirmSel = i;
      this.sfx.play('ui-move');
      return;
    }
    this.confirmSel = -1;
    if (id === 'continue' && this.campSave) {
      this.sfx.play('ui-ok');
      this.startCampaign(this.campSave, true);
    } else if (id === 'new') {
      this.sfx.play('ui-ok');
      this.startCampaign(freshRun(), true);
    } else if (id === 'players') {
      this.campPlayers = this.campPlayers === 2 ? 1 : 2;
      this.sfx.play('ui-move');
    } else if (id === 'back') {
      this.campMenuBack();
    }
  }

  /** Back to the title with the cursor still on CAMPAIGN. */
  campMenuBack(): void {
    this.sfx.play('ui-back');
    this.setMode('title');
    this.menuSel = TITLE_ITEMS.indexOf('CAMPAIGN');
  }

  updateCampMenu(): void {
    const inp = this.input;
    const items = this.campMenuItems();
    const d = inp.navDir();
    if ((d === 1 || d === 3) && items[this.menuSel]?.id === 'players') {
      this.activateCampMenu(this.menuSel);
      return;
    }
    if (this.navMenu(items.length)) return;
    if (inp.back()) this.campMenuBack();
    else if (inp.ok()) this.activateCampMenu(this.menuSel);
  }

  // ---------- campaign run loop: autosave, workshop, region clear, retreat ----------
  autosave(): void {
    if (this.run && this.runSaves) saveRun(this.run);
  }

  /** Every play update: copy the world into the run; autosave when a town is freed or a depot destroyed. */
  campaignTick(w: World): void {
    const run = this.run!;
    syncRun(w, run);
    this.crewStep(w, run); // Phase 3
    // freed towns kept from an earlier attempt count from the start; a town the enemy retakes saves too
    const towns = w.towns.reduce((n, t) => n + (t.freed ? 1 : 0), 0);
    const depots = w.depots.reduce((n, d) => n + (d.destroyed ? 1 : 0), 0);
    if (towns !== this.seenTowns || depots !== this.seenDepots) {
      this.seenTowns = towns;
      this.seenDepots = depots;
      this.autosave();
    }
  }

  /**
   * The workshop prompt at a freed town's flag, and its key: Enter (co-op: H), Start or A while standing still
   * (pad). Only with no enemy close. Returns true if the camp opened.
   */
  workshopInput(w: World): boolean {
    this.workshop = null;
    for (let i = 0; i < this.nPlayers && !this.workshop; i++) this.workshop = w.workshopAt(i);
    const at = this.workshop;
    if (!at || !at.safe) return false;
    const inp = this.input;
    const still = w.players.every((p) => !p || !p.moving);
    // co-op: Enter is player 2's fire key, so the workshop uses H there
    const kb = this.nPlayers === 2 ? inp.hit('KeyH') : inp.hit('Enter', 'NumpadEnter');
    const key = kb || inp.pads.some((p) => p.startPressed || (p.firePressed && p.dir < 0 && still));
    if (!key) return false;
    this.openWorkshop(at.town);
    return true;
  }

  armourOf(w: World | null): [number, number][] {
    return Array.from({ length: this.nPlayers }, (_, i) => {
      const t = w?.players[i];
      return t ? [t.armour, t.armourMax] as [number, number] : [0, 0] as [number, number];
    });
  }

  openWorkshop(town: TownState): void {
    const w = this.world!;
    syncRun(w, this.run!);
    this.ui.closeMap();
    this.campThen = 'play';
    this.campAfterRecruit(town.name); // Phase 3: a recruit who said "not now" asks again first
  }

  // ---------- Phase 3 crew: recruiting, crew perks and XP (crew.ts) ----------
  /** Every play update: crew perks and XP, and the recruit a freed town offers (shown a moment later). */
  crewStep(w: World, run: RunState): void {
    crewTick(w, run);
    // crew.ts recruitOffer: one recruit per region, once enough of its towns are freed (the 2nd); a recruit still
    // about to ask blocks a second one
    if (!this.offer && !w.over && !w.done) {
      const d = recruitOffer(run, w.towns.reduce((n, t) => n + (t.freed ? 1 : 0), 0));
      if (d) this.offer = { id: d.id, place: w.checkpoint?.name ?? '', t: 75 };
    }
    if (this.offer && --this.offer.t <= 0 && !w.over && !w.done) {
      const o = this.offer;
      this.offer = null;
      this.showRecruit(o.id, o.place, false, null);
    }
  }

  /** The recruit card; then (join or not) back to play, or on to `then` (a workshop's camp). */
  showRecruit(id: string, place: string, again: boolean, then: (() => void) | null): void {
    // demos and screenshot tests (autoplay) take every recruit without stopping on the card
    if (this.opts.autoplay) {
      this.recruitClosed(id, place, true, then);
      return;
    }
    this.workshop = null;
    this.ui.closeMap();
    this.setMode('recruit');
    this.sfx.play('radio');
    openRecruit({ id, place, again, onClose: (join) => this.recruitClosed(id, place, join, then) });
  }

  recruitClosed(id: string, place: string, join: boolean, then: (() => void) | null): void {
    const run = this.run!;
    // in a region (play or its workshop) the crew applies to the world at once; between regions only to the run
    const w = this.campThen === 'play' || !then ? this.world : null;
    if (join) {
      joinCrew(run, id, place, w);
      this.sfx.play('ui-ok');
    } else {
      deferCrew(run, id, place);
      this.sfx.play('ui-back');
    }
    // the key that answered must not act in the game too
    this.input.pressed.clear();
    this.autosave();
    if (then) then();
    else this.setMode('play');
  }

  /** Open a camp, first letting a waiting recruit ask again. */
  campAfterRecruit(place: string): void {
    const wait = this.run && waitingRecruit(this.run);
    if (wait && crewById(wait.id)) this.showRecruit(wait.id, wait.from ?? place, true, () => this.openCampScreen(place));
    else this.openCampScreen(place);
  }

  /** A region ends (clear or retreat) with a recruit still about to ask: they wait at the next workshop. */
  deferOffer(run: RunState): void {
    if (this.offer) deferCrew(run, this.offer.id, this.offer.place);
    this.offer = null;
  }
  // ---------- end Phase 3 crew block ----------

  // ---------- Phase 5 events hook: map event cards (src/game/events.ts, src/ui-events.ts) ----------
  /** After a play update: a player reached a map event (its card opens, the world pauses) or a finished objective
   * brings a recruit. Demos (autoplay) answer at once. Returns true if the game left play mode. */
  eventStep(w: World): boolean {
    const ev = w.events;
    if (!ev || w.over || w.done) return false;
    if (this.mode !== 'play') return true; // a recruit card opened this update: the event waits for the next one
    if (ev.recruitDue !== null) {
      const place = ev.recruitDue;
      ev.recruitDue = null;
      this.eventRecruit(w, place);
      return this.mode !== 'play';
    }
    const p = ev.pending;
    if (!p) return false;
    const run = this.run!;
    if (this.opts.autoplay) {
      const res = ev.answer(ev.autoChoice());
      if (res.recruit) this.eventRecruit(w, p.place);
      return this.mode !== 'play';
    }
    const card = ev.card(callsAboard(run));
    if (!card) return false;
    this.workshop = null;
    this.ui.closeMap();
    this.setMode('event');
    this.sfx.play('radio');
    let recruit = false;
    openEventCard({
      card,
      onAnswer: (i) => {
        const res = ev.answer(i);
        recruit = res.recruit;
        this.sfx.play(res.resolved ? 'ui-ok' : 'ui-back');
        return res.reply;
      },
      onLine: () => this.sfx.play('ui-move'),
      onClose: (skipped) => {
        if (skipped) ev.walkAway();
        // the key that answered must not act in the game too
        this.input.pressed.clear();
        this.setMode('play');
        syncRun(w, run);
        this.autosave();
        if (recruit) this.eventRecruit(w, p.place);
      },
    });
    return true;
  }

  /** An event's recruit: the next crew member not met yet asks to join; with nobody left the village sends scrap. */
  eventRecruit(w: World, place: string): void {
    const d = this.run && !this.offer && recruitOffer(this.run, 0, true); // a town's recruit about to ask comes first
    if (d) this.showRecruit(d.id, place, false, null);
    else w.events?.noRecruit();
  }
  // ---------- end Phase 5 events block ----------

  openCampScreen(place: string): void {
    this.workshop = null;
    this.setMode('camp');
    this.sfx.play('ui-ok');
    openCamp({
      run: this.run!, players: this.nPlayers, place, armour: this.armourOf(this.world),
      map: this.campMap(), // Phase 5 MAP tab
      onClose: (res) => this.campClosed(res),
    });
  }

  campClosed(res: CampResult): void {
    this.run = res.run;
    // the key that closed the camp must not act in the game too (Enter would reopen the workshop)
    this.input.pressed.clear();
    if (this.campThen === 'play' && this.world) {
      applyRunToWorld(this.world, this.run, res.armour);
      this.setMode('play');
    } else {
      this.beginStage();
    }
    this.autosave();
  }

  /** All towns freed: tally, autosave on the next region, then the camp, then the next region. */
  regionClear(w: World): void {
    const run = this.run!;
    syncRun(w, run);
    const kills = this.ps.slice(0, this.nPlayers).reduce((a, p) => a + p.kills.reduce((x, y) => x + y, 0), 0);
    const s = w.stats;
    const earned = s.scrapPicked + s.townsFreed * FREE_SCRAP + s.depots * DEPOT_SCRAP + s.bossScrap; // Phase 4 boss
    // Phase 3: a region clear is worth crew XP; a recruit still about to ask waits at the camp
    this.deferOffer(run);
    crewXp(run, 'region');
    // Phase 5: the run's totals (the CAMPAIGN COMPLETE card) and the next briefing's kicker
    const parts = s.partsPicked + s.depots + s.boss * BOSS.captured;
    const depotsDown = w.depots.filter((d) => d.destroyed).length; // with any kept from an earlier attempt
    noteRegionClear(run, { region: run.region, towns: w.towns.filter((t) => t.freed).length, depots: depotsDown, bosses: s.boss, scrap: earned, parts, kills });
    delete run.progress; // the next region starts fresh
    // Phase 5: the final boss fell: the ending, THE END, then the title (demos mark it and carry on)
    if (w.boss?.victory && !run.completed) {
      completeCampaign(run);
      if (!this.opts.autoplay) {
        run.region++;
        run.regionRetreats = 0;
        this.autosave();
        this.showEnding();
        return;
      }
    }
    this.clearScreen = {
      region: run.region + 1,
      name: w.def.name,
      rows: [
        ...(w.boss ? [['BOSS', `${w.boss.name} DESTROYED`] as [string, string]] : []), // Phase 4 boss
        ['TOWNS FREED', `${w.towns.filter((t) => t.freed).length}/${w.towns.length}`],
        ['DEPOTS DESTROYED', `${depotsDown}/${w.depots.length}`],
        ['SCRAP EARNED', `+${earned}`],
        ['PARTS FOUND', String(s.partsPicked + s.depots + s.boss * BOSS.captured)],
        ['TANKS DESTROYED', String(kills)],
        ['CREW XP', `+${crewXpOf(w)} EACH`], // Phase 3
      ],
      foot: `IN THE TRUCK: ${run.scrap} SCRAP · ${run.bin.length} PART${run.bin.length === 1 ? '' : 'S'}`,
      quote: debriefLine(w.boss?.kind), // Phase 5: HQ's debrief
    };
    run.region++;
    run.regionRetreats = 0;
    this.autosave();
    this.sfx.play('clear');
    this.setMode('regionclear');
  }

  updateRegionClear(): void {
    const rows = this.clearScreen?.rows.length ?? 0;
    const shown = this.clearShown();
    if (this.t >= 20 && (this.t - 20) % 20 === 0 && shown <= rows) this.sfx.play('tick');
    const done = shown > rows;
    // the autopilot (demos) skips the camp
    if (this.opts.autoplay && this.t > 60 * 8) this.beginStage();
    else if (done && this.input.ok()) {
      this.campThen = 'region';
      this.campAfterRecruit('FIELD CAMP'); // Phase 3
    }
  }

  clearShown(): number {
    return Math.max(0, Math.floor((this.t - 20) / 20) + 1);
  }

  // ---------- Phase 5 story: briefings, the ending, the camp's MAP ----------
  /** The current region's briefing (the opening first on a new campaign); answering it applies its reward. */
  showBriefing(): void {
    const run = this.run!;
    this.ui.closeMap();
    this.setMode('story');
    this.sfx.play('radio');
    openStory({
      pages: briefingPages(run),
      label: (c) => rewardLabel(run, c),
      onAnswer: (i) => {
        const reply = answerBriefing(run, i);
        this.sfx.play('ui-ok');
        this.autosave();
        return reply;
      },
      onLine: () => this.sfx.play('ui-move'),
      skipTakesFirst: true,
      onClose: () => {
        // ESC held through the answers takes answer 1 and its reward
        if (briefingDue(run)) skipBriefing(run);
        this.input.pressed.clear();
        this.autosave();
        this.beginStage();
      },
    });
  }

  /** The final boss fell: the ending scene, then THE END / CAMPAIGN COMPLETE, then the title. */
  showEnding(): void {
    const run = this.run!;
    this.ui.closeMap();
    this.setMode('story');
    this.sfx.play('clear');
    openStory({
      pages: endingPages(run),
      label: () => ({ text: '', icon: '', cls: '' }),
      onAnswer: () => null,
      onLine: () => this.sfx.play('ui-move'),
      onClose: () => {
        this.sfx.play('ui-ok');
        openComplete({
          rows: completeRows(run), crew: [...callsAboard(run)], title: CAMPAIGN_TITLE,
          onClose: () => {
            this.sfx.play('ui-ok');
            this.input.pressed.clear();
            this.run = null;
            this.world = null;
            this.titleY = 0;
            this.setMode('title');
            this.menuSel = TITLE_ITEMS.indexOf('CAMPAIGN');
          },
        });
      },
    });
  }

  /** The MAP tab's map: the region in play at a workshop; between regions the next one (not entered yet). */
  campMap() {
    const run = this.run!;
    try {
      if (this.campThen === 'play' && this.world?.region) return campMapFromWorld(this.world, run.region);
      const spec = this.bossSpec ?? (this.testSeed ? regionSpecFor(run.region, this.testSeed + run.region) : campaignRegion(run));
      return campMapFromSpec(spec, run.region);
    } catch {
      return null;
    }
  }

  /** Out of lives: fall back, keep everything, try the same region again a little easier. */
  retreat(w: World): void {
    const run = this.run!;
    syncRun(w, run);
    this.deferOffer(run); // Phase 3
    run.retreats++;
    run.regionRetreats = (run.regionRetreats ?? 0) + 1;
    this.autosave();
    const vet = Math.max(...run.vet.slice(0, this.nPlayers));
    const lives = bonusLives(run);
    const towns = w.keepsProgress ? w.towns.filter((t) => t.freed).length : 0; // freed towns stay freed (save.ts restoreProgress)
    this.retreatScreen = {
      region: run.region + 1,
      name: w.def.name,
      kept: `KEPT: ${run.scrap} SCRAP · ${run.bin.length} PART${run.bin.length === 1 ? '' : 'S'}${vet ? ` · VETERAN ${VET_NAMES[vet]}` : ''}${towns ? ` · ${towns} TOWN${towns === 1 ? '' : 'S'}` : ''}`,
      next: `NEXT ATTEMPT: +${lives} ${lives === 1 ? 'LIFE' : 'LIVES'} · ENEMIES ${Math.round(retreatEase(run) * 100)}% SLOWER`,
    };
    this.setMode('retreat');
  }

  updateRetreat(): void {
    if ((this.t > 60 && this.input.ok()) || (this.opts.autoplay && this.t > 60 * 6)) {
      this.sfx.play('ui-ok');
      this.beginStage();
    }
  }

  updateTitle(): void {
    if (this.titleY > 0) {
      this.titleY = Math.max(0, this.titleY - 2.4);
      if (this.input.pressed.size || this.input.ok()) this.titleY = 0;
      return;
    }
    this.navMenu(TITLE_ITEMS.length);
    if (this.input.ok()) this.activate();
  }

  updateIntro(): void {
    const inp = this.input;
    if (this.deployT >= 0) {
      if (++this.deployT > 62) this.setMode('play');
      return;
    }
    if (this.canSelect) {
      const d = inp.navDir();
      if (d >= 0) {
        this.stage = Math.max(1, Math.min(99, this.stage + (d === 0 || d === 1 ? 1 : -1)));
        this.world = this.newWorld();
        this.r.clearDecals = true;
        this.r.resetHistory = true;
        this.sfx.play('ui-move');
      }
      if (inp.ok() || this.t > 60 * 15) this.deploy();
      return;
    }
    // Phase 5: a campaign intro card carries HQ's line, so it stays up a little longer (not in ?region= quick tests)
    if (this.t > (this.run && this.runSaves ? 220 : 100) || (this.t > 20 && inp.ok())) this.deploy();
  }

  deploy(): void {
    this.canSelect = false;
    this.deployT = 0;
    this.sfx.play('start');
  }

  /** M5: one-time first-play prompts (src/tips.ts) */
  private tips = new Tips((t, k, i, ms) => this.ui.toast(t, k, i, ms));
  /** G5: a boss part that broke this update (hp from above 0 to 0) asks for the longer hit-stop. */
  private partHp = new WeakMap<object, number>();
  private watchBossParts(w: World): void {
    const b = w.boss;
    if (!b?.present) return;
    for (const p of b.parts) {
      const was = this.partHp.get(p);
      if (was !== undefined && was > 0 && p.hp <= 0) w.hitStop = Math.max(w.hitStop, HITSTOP_BOSS);
      this.partHp.set(p, p.hp);
    }
  }

  updatePlay(): void {
    const w = this.world!;
    const inp = this.input;
    const pad = inp.anyPad();
    if (this.paused) {
      // a move and a confirm in the same update (Up + fire held together) must not pick an item
      const moved = this.navMenu(PAUSE_ITEMS.length);
      if (!moved && inp.ok()) this.activate();
      else if (inp.back() || inp.hit('KeyP') || pad?.startPressed) {
        this.paused = false;
        this.sfx.play('ui-back');
      }
      return;
    }
    // campaign: at a freed town's flag Enter (pad: Start, or A standing still) opens the workshop
    if (this.run && this.workshopInput(w)) return;
    if ((inp.hit('Escape', 'KeyP') || pad?.startPressed) && !w.over) {
      this.paused = true;
      this.menuSel = 0;
      this.confirmSel = -1;
      this.ui.closeMap();
      this.sfx.play('pause');
      return;
    }
    // campaign: TAB (or a pad's Back / View button) opens and closes the big map
    if (this.cam && (inp.hit('Tab') || inp.pads.some((p) => p.selectPressed))) {
      this.ui.toggleMap();
      this.sfx.play('ui-move');
    }
    if (this.opts.debug) this.debugKeys(w);
    const bot = (ww: World) => (w.hasBase ? this.botInput(ww) : regionBot(ww));
    const inputs = [0, 1].map((i) => (i === 0 && this.opts.autoplay ? bot(w) : this.playerInput(i)));
    // G5 hit-stop: a kill (or a boss part breaking) holds the whole world a few updates, both players alike; the
    // picture, HUD, sound and camera keep running. Only this loop counts it down, so the sims never see it.
    if (w.hitStop > 0 && !this.opts.autoplay) w.hitStop--;
    else {
      w.hitStop = 0;
      w.update(inputs);
      this.watchBossParts(w);
    }
    if (this.run && !this.opts.autoplay) this.tips.step(w, !!pad); // M5 first-play prompts
    const cam = this.cam;
    if (cam) {
      const ts = this.camTargets(w);
      // a respawn far from the view jumps there instead of a long pan
      const far = ts.length && ts.every((t) => !cam.sees(t.cx - 8, t.cy - 8, 16, 16, 64));
      if (far) cam.snap(ts);
      else cam.update(ts, 1 / 60);
    }
    for (const e of w.ev) {
      if (!cam) {
        this.sfx.play(e.n, e.x, e.v);
        continue;
      }
      // pan across the screen; sounds beyond it fade out over 240 px
      const sx = e.x - cam.x;
      const vw = cam.viewW;
      const off = Math.max(0, -sx, sx - vw);
      const v = e.v * Math.max(0, 1 - off / 240);
      if (v > 0.02) this.sfx.play(e.n, (Math.max(0, Math.min(vw, sx)) / vw) * 208, v);
    }
    w.ev.length = 0;
    for (const n of mergeNotes(w.notes)) this.ui.toast(n.text, n.kind, n.icon, n.ms);
    w.notes.length = 0;
    for (const p of w.popups) this.ui.popup(p.x + view.ox - view.rect[0], p.y + view.oy - view.rect[1], p.text);
    w.popups.length = 0;
    for (const m of w.radio) this.ui.radio(m);
    w.radio.length = 0;
    this.saveHi();
    if (this.run) {
      this.campaignTick(w);
      if (this.eventStep(w)) return; // Phase 5 events hook: a map event card or its recruit
      // campaign: no game over; out of lives is a retreat, all towns freed moves the run on
      if (w.done === 'clear') this.regionClear(w);
      else if (w.done === 'over') this.retreat(w);
      return;
    }
    if (w.done) {
      this.nextAfterTally = w.done === 'clear' ? 'intro' : 'gameover';
      this.tallyCounts = [[0, 0, 0, 0], [0, 0, 0, 0]];
      if (w.done === 'clear') this.sfx.play('clear');
      this.setMode('tally');
    }
  }

  debugKeys(w: World): void {
    const inp = this.input;
    if (inp.hit('KeyN')) w.done = 'clear';
    if (inp.hit('KeyK')) for (const e of w.enemies) w.killEnemy(e, 0);
    // Phase 4: B reveals the region's boss, a second B destroys it
    if (inp.hit('KeyB') && w.boss) {
      if (w.boss.state === 'hidden') w.boss.reveal();
      else w.boss.kill(0);
    }
    const p = w.players[0];
    // power-ups on the digit keys; in region mode the digits are abilities, so hold Shift there
    const powerKeys = !this.cam || inp.held('ShiftLeft', 'ShiftRight');
    ['Digit1', 'Digit2', 'Digit3', 'Digit4', 'Digit5', 'Digit6', 'Digit7', 'Digit8', 'Digit9', 'Digit0'].forEach((code, i) => {
      if (powerKeys && inp.hit(code) && p) w.applyPower(p, i);
    });
    if (inp.hit('KeyB')) w.spawnPower();
    if (inp.hit('KeyL')) this.weather.flash = 1;
    if (inp.hit('KeyO')) w.destroyEagle();
  }

  updateTally(): void {
    const shown = Math.max(0, Math.floor((this.t - 20) / 26) + 1);
    const done = shown > 4;
    for (let i = 0; i < Math.min(4, shown); i++) {
      for (let p = 0; p < 2; p++) {
        const target = this.ps[p].kills[i];
        if (this.tallyCounts[p][i] < target && this.t % 3 === 0) {
          this.tallyCounts[p][i]++;
          if (p === 0) this.sfx.play('tick');
        }
      }
    }
    if (done && this.input.ok()) this.finishTally();
    else if (this.t > 60 * 12) this.finishTally();
  }

  finishTally(): void {
    this.saveHi();
    if (this.nextAfterTally === 'intro') {
      this.stage++;
      this.canSelect = false;
      this.beginStage();
    } else {
      this.setMode('gameover');
      this.sfx.play('gameover');
    }
  }

  updateGameOver(): void {
    if (this.t < 30) return;
    if (!this.navMenu(OVER_ITEMS.length) && this.input.ok()) this.activate();
  }

  updateWeather(): void {
    const W = this.weather;
    const titleBg = this.mode === 'title' || this.mode === 'campmenu';
    W.dense = titleBg ? 0.6 : 1;
    if (titleBg) W.set('rain', [0, 0, NW, NH]);
    // the title times its own strikes (one soon after the logo appears, then every 6-12 s) and draws the bolt
    W.auto = this.mode !== 'title';
    if (this.mode === 'title' && this.titleY === 0 && --this.nextTitleBolt <= 0) this.titleStrike();
    else if (this.mode === 'gameover') W.set('dust', [0, 0, NW, NH]);
    else if (this.world) W.set(ENVS[this.world.env].weather, this.cam ? [0, 0, this.r.nw, this.r.nh] : undefined);
    const frozen = (this.mode === 'play' && this.paused) || this.mode === 'camp' || this.mode === 'recruit' || this.mode === 'story' || this.mode === 'event'; // Phase 5 events hook
    if (!frozen) W.update(this.t);
    if (W.flash <= 0 || this.mode !== 'title') this.titleBolt = null;
    for (const e of W.events) this.thunder.push({ f: e.thunder, near: Math.max(0, Math.min(1, 1 - (e.thunder - 20) / 70)) });
    W.events.length = 0;
    this.thunder = this.thunder.filter((th) => {
      if (--th.f > 0) return true;
      this.sfx.play('thunder', Math.random() * 208, th.near);
      return false;
    });
  }

  /** Boss music: from when the boss hunts or a player comes near its lair (its HUD bar shows) until it
   *  starts dying. Latched per boss, so circling at the edge of its lair doesn't flip the music. */
  private bossMusicFor: object | null = null;
  bossFight(): boolean {
    const b = this.world?.boss;
    if (!b || !b.alive) return false;
    if (this.bossMusicFor !== b && (b.state === 'hunt' || b.hudShown())) this.bossMusicFor = b;
    return this.bossMusicFor === b;
  }

  /** Region music: the drums and bass play while an enemy is within about a screen of the view, and for 4 s
   *  after the last one leaves it. */
  private fightUntil = 0;
  regionFight(w: World): boolean {
    const cam = this.cam;
    if (this.fightUntil > w.frame + 240) this.fightUntil = 0; // a new world restarted the frame count
    if (cam && w.enemies.some((e) => e.alive && !e.spawn && cam.sees(e.x, e.y, 16, 16, 48))) this.fightUntil = w.frame + 240;
    return w.frame < this.fightUntil;
  }

  updateAudio(): void {
    const w = this.world;
    let music: MusicMode = 'off';
    if (this.mode === 'title' || this.mode === 'campmenu') music = 'menu';
    else if (this.mode === 'intro' || this.mode === 'tally' || this.mode === 'retreat' || this.mode === 'regionclear' || this.mode === 'camp' || this.mode === 'recruit' || this.mode === 'story' || this.mode === 'event' || this.paused) music = 'calm'; // Phase 5 events hook: event
    else if (this.mode === 'play') music = w?.over ? 'calm' : this.bossFight() ? 'boss' : this.cam ? 'region' : 'play';
    // campaign: the region's own theme (arcade keeps 'play')
    if (this.run && w && this.cam) this.sfx.setRegionMusic(REGION_THEMES.indexOf(regionKind(this.run.region)), this.regionFight(w));
    this.sfx.setMusic(music);
    this.sfx.ambience(this.mode === 'gameover' ? 'none' : this.weather.kind);
    let eng = 0;
    if (this.mode === 'play' && w && !this.paused && !w.over) {
      const live = w.players.filter((p) => p && !p.spawn);
      if (live.length) eng = live.some((p) => p!.moving) ? 2 : 1;
    }
    this.sfx.engine(eng);
  }

  /** Drop internal resolution if a weaker GPU can't hold ~40 fps (never in automated tests). */
  autoQuality(): void {
    if (navigator.webdriver || this.mode !== 'play' || this.paused || this.t % 30 !== 0) return;
    this.slow = this.fpsValue > 0 && this.fpsValue < 40 ? this.slow + 1 : 0;
    if (this.slow >= 6 && this.r.k > 2) {
      this.r.maxK = this.r.k - 1;
      this.slow = 0;
      this.ui.toast('RESOLUTION LOWERED FOR SPEED', 'info');
    }
  }

  updateUI(): void {
    this.autoQuality();
    const ui = this.ui;
    const w = this.world;
    let sc: Screen = { kind: 'none' };
    if (this.settingsOpen) {
      sc = { kind: 'menu', kicker: 'OPTIONS', title: 'SETTINGS', items: this.settingsItems(), sel: this.settingsSel };
    } else if (this.mode === 'title') {
      sc = this.titleY > 0 ? { kind: 'none' } : { kind: 'title', items: TITLE_ITEMS, sel: this.menuSel, hi: this.hi };
    } else if (this.mode === 'campmenu') {
      sc = { kind: 'menu', kicker: 'CAMPAIGN', title: 'CAMPAIGN', items: this.campMenuItems().map((c) => c.item), sel: this.menuSel };
    } else if (this.mode === 'intro' && w) {
      const depots = w.depots.length ? ` · ${w.depots.length} DEPOTS TO BURN` : '';
      const goal = w.arena ? 'TEST RANGE · ABILITIES 1-4 · TRICKS NEAR THE START'
        : w.hasBase ? `DESTROY ${w.order.length} TANKS · DEFEND THE BASE`
        : w.boss ? `FREE ${Math.min(BOSS.reveal, w.towns.length)} VILLAGES TO ${w.boss.goal ?? 'FIND THEIR ACE · DESTROY HIM'}${depots}` // Phase 4 boss
        : w.towns.length ? `FREE ${w.towns.length} VILLAGES · HOLD EACH FLAG${depots}` : `DESTROY ${w.order.length} TANKS · EXPLORE THE REGION`;
      const run = this.run;
      const extra = run?.regionRetreats
        ? `EASIER ATTEMPT: +${bonusLives(run)} ${bonusLives(run) === 1 ? 'LIFE' : 'LIVES'} · ENEMIES ${Math.round(retreatEase(run) * 100)}% SLOWER` : undefined;
      // freed towns and destroyed depots kept from an earlier attempt (CONTINUE, retreat)
      const keptT = w.keepsProgress ? w.towns.filter((t) => t.freed).length : 0;
      const keptD = w.keepsProgress ? w.depots.filter((d) => d.destroyed).length : 0;
      const keptL = [keptT ? `${keptT} TOWN${keptT === 1 ? '' : 'S'} FREE` : '', keptD ? `${keptD} DEPOT${keptD === 1 ? '' : 'S'} DOWN` : ''].filter(Boolean);
      const kept = keptL.length ? `KEPT: ${keptL.join(' · ')}` : undefined;
      sc = {
        kind: 'intro', stage: this.stage, name: w.def.name, env: w.envLabel, goal, canSelect: this.canSelect, out: this.deployT >= 0,
        kicker: run ? (run.region >= STORY_REGIONS ? 'LIBERATION' : 'REGION') : undefined, extra, kept,
        quote: run ? introQuote(run.region, run.completed) : undefined, // Phase 5: HQ's line
      };
    } else if (this.mode === 'play' && this.paused) {
      const kicker = this.run ? `REGION ${String(this.stage).padStart(2, '0')}` : `STAGE ${String(this.stage).padStart(2, '0')}`;
      const items = PAUSE_ITEMS.map((label, i) => ({
        label: i === this.confirmSel ? (i === 2 ? 'REALLY RESTART?' : 'REALLY QUIT?') : i === 2 && this.run ? 'RESTART REGION' : label,
      }));
      sc = { kind: 'menu', kicker, title: 'PAUSED', items, sel: this.menuSel };
    } else if (this.mode === 'regionclear' && this.clearScreen) {
      const c = this.clearScreen;
      const shown = this.clearShown();
      sc = { kind: 'regionclear', region: c.region, name: c.name, rows: c.rows, shown, foot: c.foot, done: shown > c.rows.length, quote: c.quote };
    } else if (this.mode === 'retreat' && this.retreatScreen) {
      const rs = this.retreatScreen;
      sc = { kind: 'retreat', region: rs.region, name: rs.name, who: RETREAT_WHO, line: RETREAT_LINE, kept: rs.kept, next: rs.next, ready: this.t > 60 };
    } else if (this.mode === 'tally' && w) {
      sc = {
        kind: 'tally', stage: w.stage, win: this.nextAfterTally === 'intro', shown: Math.max(0, Math.floor((this.t - 20) / 26) + 1),
        counts: this.tallyCounts.map((c) => [...c]), scores: this.ps.map((p) => p.score), two: this.nPlayers === 2,
        done: Math.floor((this.t - 20) / 26) + 1 > 4,
      };
    } else if (this.mode === 'gameover') {
      sc = this.t < 30 ? { kind: 'none' } : {
        kind: 'over', score: Math.max(...this.ps.map((p) => p.score)), hi: this.hi, record: this.record, items: OVER_ITEMS, sel: this.menuSel,
      };
    }
    ui.screen(sc);
    const hudOn = (this.mode === 'play' || (this.mode === 'intro' && this.deployT >= 0)) && !this.paused && !this.settingsOpen;
    ui.hud(w && (this.mode === 'play' || this.mode === 'intro' || this.mode === 'tally') ? w : null, this.hi, hudOn, this.cam);
    // campaign workshop prompt over the flag of the freed town the player is parked at
    const ws = hudOn && this.mode === 'play' ? this.workshop : null;
    ui.prompt(ws ? {
      x: ws.town.cx + view.ox - view.rect[0], y: ws.town.cy - 17 + view.oy - view.rect[1],
      key: this.input.pads.length ? 'START' : this.nPlayers === 2 ? 'H' : 'ENTER', text: ws.safe ? 'WORKSHOP' : 'WORKSHOP · ENEMIES NEAR', ok: ws.safe,
    } : null);
    ui.fps(this.settings.fps ? this.fpsValue : null);
    ui.muted(this.sfx.muted);
    if (this.mode === 'title' && this.t === 1) this.record = false;
  }

  // ---------- draw ----------
  draw(time: number): void {
    this.r.dt = this.lastDraw ? Math.min(0.1, Math.max(0, time - this.lastDraw)) : 1 / 60;
    this.lastDraw = time;
    const narrow = window.innerWidth / window.innerHeight < 1.45;
    const hud = this.mode === 'play' || this.mode === 'intro' || this.mode === 'tally';
    const inWorld = this.mode !== 'title' && this.mode !== 'campmenu' && this.mode !== 'gameover' && !!this.world;
    // campaign: the native screen takes the window's shape and covers it; the HUD floats over the map
    const campaign = inWorld && !!this.cam;
    this.r.reserve = narrow && hud && !campaign ? [104, 0, 156, 0] : [0, 0, 0, 0];
    this.r.fill = campaign;
    if (campaign) {
      this.r.setNative(...this.campaignSize());
      this.fitView(this.world!);
    } else {
      this.r.setNative(NW, NH);
    }
    this.r.feather = this.mode === 'title' || this.mode === 'campmenu' || this.mode === 'gameover' ? 26 : 0;
    this.r.resize();
    const [vx, vy, s] = this.r.cssView();
    if (!inWorld || !this.cam) {
      this.r.scroll = [0, 0];
      this.r.subpx = [0, 0];
      this.r.setTerrainSize(NW, NH);
    }
    switch (this.mode) {
      case 'title':
      case 'campmenu': this.drawTitle(time); break;
      case 'gameover': this.drawGameOver(time); break;
      default:
        if (this.world) drawWorld(this.r, this.world, time, this.weather, this.cam);
    }
    this.ui.layout(vx, vy, s, inWorld ? view.rect : undefined);
  }

  drawTitle(time: number): void {
    const r = this.r;
    setEnv(r, 'night', this.weather);
    r.env.ambient = [0.08, 0.08, 0.13];
    r.litRect = [0, 0, NW, NH];
    const oy = Math.round(this.titleY);
    r.rectG(0, 0, NW, NH, MAT_GROUND);
    drawCells(r, this.titleCells, GW, GH, 0, oy, 0);
    r.env.fog = 0.07;
    const s = Math.sin(time * 0.5);
    r.light(128 + 100 * s, 64 + oy, 44, 160, 2.0, 1.45, 0.95, true);
    r.light(40, 20 + oy, 50, 170, 0.25, 0.35, 0.7, true);
    r.light(128, 200, 26, 110, 0.22, 0.2, 0.32, false);
    this.weather.draw(r);
    r.shocks = [];
    r.shake = [0, 0];
    // the title's own strikes flash the whole screen white and light the logo (gentler with reduced motion)
    const f = this.weather.flash * (this.mode === 'title' ? (REDUCED_MOTION ? 0.35 : 1) : 0);
    const b = this.titleBolt;
    if (b && f > 0) {
      const path = (pts: number[][], w: number, k: number) => {
        for (let i = 1; i < pts.length; i++) {
          const [x0, y0] = pts[i - 1];
          const [x1, y1] = pts[i];
          const n = Math.max(Math.abs(x1 - x0), Math.abs(y1 - y0), 1);
          for (let j = 0; j < n; j++) {
            r.fxRect(Math.round(x0 + ((x1 - x0) * j) / n), Math.round(y0 + ((y1 - y0) * j) / n), w, w, [0.85, 0.92, 1], k);
          }
          r.glow(x0, y0, 6, [0.45, 0.6, 1], 0.3 * k);
        }
      };
      path(b.main, 2, 3 * f);
      path(b.branch, 1, 2 * f);
      r.glow(b.x, b.y, 16, [0.7, 0.8, 1], 1.6 * f);
      r.light(b.x, b.y, 30, 150, 3 * f, 3.2 * f, 4 * f, true);
    }
    this.ui.strike(f);
    const ff = Math.max(this.weather.flash * 0.05, f * 0.3);
    r.flash = [ff, ff * 1.1, ff * 1.35];
  }

  /** A lightning strike on the title: a jagged pixel bolt into the ground beside the menu, then thunder. */
  titleStrike(): void {
    this.nextTitleBolt = 360 + Math.random() * 360; // 6-12 s
    const left = Math.random() < 0.5;
    const x = Math.round(left ? 28 + Math.random() * 40 : 188 + Math.random() * 40);
    const y = Math.round(160 + Math.random() * 40);
    const x0 = x + (left ? 1 : -1) * (8 + Math.random() * 30);
    const main: number[][] = [];
    const n = 12;
    for (let i = 0; i <= n; i++) {
      const k = i / n;
      const mid = i > 0 && i < n;
      main.push([Math.round(x0 + (x - x0) * k + (mid ? (Math.random() - 0.5) * 14 : 0)), Math.round(-4 + (y + 4) * k + (mid ? (Math.random() - 0.5) * 6 : 0))]);
    }
    const branch: number[][] = [main[4 + Math.floor(Math.random() * 3)]];
    const out = Math.random() < 0.5 ? -1 : 1;
    for (let i = 0; i < 4; i++) {
      const [px, py] = branch[branch.length - 1];
      branch.push([Math.round(px + out * (3 + Math.random() * 7)), Math.round(py + 5 + Math.random() * 8)]);
    }
    this.titleBolt = { main, branch, x, y };
    // light comes from the bolt's side; thunder about half a second later (fairly close, not deafening)
    this.weather.strike(30 + Math.random() * 12, [left ? -0.6 : 0.6, -0.3, 0.75]);
  }

  drawGameOver(time: number): void {
    const r = this.r;
    setEnv(r, 'night');
    r.env.ambient = [0.05, 0.04, 0.05];
    r.env.fog = 0.1;
    r.litRect = [0, 0, NW, NH];
    r.rectG(0, 0, NW, NH, MAT_GROUND);
    drawCells(r, this.overCells, GW, GH, 0, 0, 0);
    const f = 0.75 + 0.25 * Math.sin(time * 17) * Math.sin(time * 5.3);
    r.light(128, 90, 60, 190, 2.2 * f, 0.75 * f, 0.22 * f, true);
    r.light(70 + 40 * Math.sin(time * 0.6), 30, 50, 130, 0.35, 0.18, 0.12, true);
    for (let i = 0; i < 4; i++) r.glow(80 + i * 32, 214 + 2 * Math.sin(time * 9 + i), 8, [1, 0.45, 0.12], 1.1 * f);
    this.weather.draw(r);
    r.shocks = [];
    r.shake = [0, 0];
    r.flash = [0, 0, 0];
  }
}

/** Phase 3: crew XP this region earned (kills by type, towns, depots, the clear), for the region-clear tally. */
function crewXpOf(w: World): number {
  let n = XP.region + w.stats.townsFreed * XP.town + w.stats.depots * XP.depot;
  for (let i = 0; i < w.nPlayers; i++) w.ps[i].kills.forEach((k, e) => { n += k * (XP.kill[e] ?? 0); });
  return n;
}
