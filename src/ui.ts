import './ui.css';
import type { Atlas } from './art/atlas';
import { FONT } from './art/font';
import { EAGLE_X, EAGLE_Y, ENEMY, FS, FX, FY } from './game/constants';
import type { Camera } from './game/camera';
import type { RadioMsg, World } from './game/world';
import { CampaignHud, radioFace } from './ui-campaign';

export interface MenuItem {
  label: string;
  value?: string;
  meter?: number; // 0..10
  adjustable?: boolean;
  /** small lines under the label (campaign menu: what CONTINUE resumes) */
  note?: string[];
  /** label colour: 'warn' = red (a confirm step) */
  tone?: 'warn';
}

/** A line of radio on a mission card (Phase 5 story). */
export interface Quote { who: string; text: string }

export type Screen =
  | { kind: 'none' }
  | { kind: 'title'; items: string[]; sel: number; hi: number }
  | { kind: 'intro'; stage: number; name: string; env: string; goal: string; canSelect: boolean; out: boolean; kicker?: string; extra?: string; kept?: string; quote?: Quote }
  | { kind: 'menu'; kicker: string; title: string; items: MenuItem[]; sel: number }
  | { kind: 'tally'; stage: number; win: boolean; shown: number; counts: number[][]; scores: number[]; two: boolean; done: boolean }
  | { kind: 'over'; score: number; hi: number; record: boolean; items: string[]; sel: number }
  // campaign (Phase 2 run loop)
  | { kind: 'regionclear'; region: number; name: string; rows: [string, string][]; shown: number; foot: string; done: boolean; quote?: Quote }
  | { kind: 'retreat'; region: number; name: string; who: string; line: string; kept: string; next: string; ready: boolean };

export interface UIHandlers {
  hover(i: number): void;
  click(i: number, adj: number): void;
}

const fmt = (n: number) => Math.round(n).toLocaleString('en-US');
const pad2 = (n: number) => String(n).padStart(2, '0');
const ENEMY_NAMES = ['LIGHT', 'RAIDER', 'HEAVY GUN', 'ARMOR'];

/** Bakes an atlas sprite to a PNG data URL (tinting the tint-masked pixels). */
function spriteURL(atlas: Atlas, name: string, tint = [1, 1, 1]): string {
  const s = atlas.S[name];
  const c = document.createElement('canvas');
  c.width = s.w;
  c.height = s.h;
  const ctx = c.getContext('2d')!;
  const img = ctx.createImageData(s.w, s.h);
  for (let y = 0; y < s.h; y++) {
    for (let x = 0; x < s.w; x++) {
      const i = ((s.y + y) * atlas.W + s.x + x) * 4;
      const o = (y * s.w + x) * 4;
      const m = atlas.hs[i + 2] / 255;
      for (let ch = 0; ch < 3; ch++) img.data[o + ch] = atlas.alb[i + ch] * (1 - m + m * tint[ch]);
      img.data[o + 3] = atlas.alb[i + 3];
    }
  }
  ctx.putImageData(img, 0, 0);
  return c.toDataURL();
}

/**
 * The game's 5x7 font as DOM text: one masked <i> per glyph from a white glyph sheet, so text
 * takes any CSS colour or gradient and stays pixel-crisp at integer scales.
 */
class PixelText {
  private idx = new Map<string, number>();
  private chars = Object.keys(FONT);
  private made = new Set<number>();
  private style = document.createElement('style');

  constructor() {
    this.chars.forEach((c, i) => this.idx.set(c, i));
    document.head.appendChild(this.style);
  }

  private ensure(s: number): void {
    if (this.made.has(s)) return;
    this.made.add(s);
    const c = document.createElement('canvas');
    c.width = this.chars.length * 6 * s;
    c.height = 8 * s;
    const g = c.getContext('2d')!;
    g.fillStyle = '#fff';
    this.chars.forEach((ch, i) => FONT[ch].forEach((row, y) => row.forEach((on, x) => {
      if (on) g.fillRect((i * 6 + x) * s, y * s, s, s);
    })));
    const url = c.toDataURL();
    const size = `${c.width}px ${c.height}px`;
    this.style.textContent += `.px.s${s} i{width:${6 * s}px;height:${8 * s}px;-webkit-mask-image:url(${url});mask-image:url(${url});`
      + `-webkit-mask-size:${size};mask-size:${size}}.px.s${s} i.sp{width:${4 * s}px;background:none}\n`;
  }

  html(text: string, s: number, cls = ''): string {
    this.ensure(s);
    let out = `<span class="px s${s} ${cls}">`;
    for (const c0 of text) {
      const c = c0 === 'x' ? c0 : c0.toUpperCase();
      const i = this.idx.get(c);
      if (c === ' ' || i === undefined) out += '<i class="sp"></i>';
      else out += `<i style="-webkit-mask-position:-${i * 6 * s}px 0;mask-position:-${i * 6 * s}px 0"></i>`;
    }
    return `${out}</span>`;
  }
}

export class UI {
  root: HTMLElement;
  private scr: HTMLElement;
  private hudEl: HTMLElement;
  private hudL: HTMLElement;
  private hudR: HTMLElement;
  /** campaign (region mode): the floating HUD over the full-window map */
  private camp: CampaignHud;
  private toastPos = '';
  private frame: HTMLElement;
  private toasts: HTMLElement;
  private pops: HTMLElement;
  private fpsEl: HTMLElement;
  private muteEl: HTMLElement;
  private promptEl: HTMLElement;
  private lastKey = '';
  private lastKind = '';
  private lastShown = -1;
  private hudKey = '';
  private timerKey = '';
  private layoutKey = '';
  private field = [0, 0, 1, 1]; // css px x, y, size, scale
  /** title logo: CSS px per font pixel (set by layout) */
  private logoS = 20;
  private logoEl: HTMLElement | null = null;
  private strikeV = 0;
  private pt = new PixelText();
  icons: { enemy: string[]; life: string[]; power: string[]; eagle: string; cursor: string };
  private el: Record<string, HTMLElement> = {};

  constructor(atlas: Atlas, private handlers: UIHandlers) {
    this.root = document.createElement('div');
    this.root.id = 'ui';
    this.root.innerHTML = `
      <div id="frame" class="hidden"></div>
      <div id="hud" class="off"><div id="hudL" class="col"></div><div id="hudR" class="col"></div></div>
      <div id="pops"></div>
      <div id="prompt"></div>
      <div id="toasts"></div>
      <div id="screen"></div>
      <div id="fps"></div>
      <div id="mute"></div>`;
    document.body.appendChild(this.root);
    const $ = (id: string) => this.root.querySelector<HTMLElement>(`#${id}`)!;
    this.scr = $('screen');
    this.hudEl = $('hud');
    this.hudL = $('hudL');
    this.hudR = $('hudR');
    this.frame = $('frame');
    this.toasts = $('toasts');
    this.pops = $('pops');
    this.fpsEl = $('fps');
    this.muteEl = $('mute');
    this.promptEl = $('prompt');
    const silver = [0.84, 0.88, 0.98];
    this.icons = {
      enemy: [0, 1, 2, 3].map((i) => spriteURL(atlas, `e${i}a`, i === 3 ? [0.55, 0.92, 0.55] : silver)),
      life: [spriteURL(atlas, 'p0a', [1, 0.76, 0.2]), spriteURL(atlas, 'p0a', [0.38, 0.92, 0.42])],
      power: Array.from({ length: 10 }, (_, i) => spriteURL(atlas, `pw${i}`)),
      eagle: spriteURL(atlas, 'eagle'),
      cursor: spriteURL(atlas, 'p1a', [1, 0.76, 0.2]),
    };
    const sprites = new Map<string, string>();
    this.camp = new CampaignHud($('pops'), (t, s, c = '') => this.T(t, s, c), (name, tint) => {
      const key = `${name}|${tint.join()}`;
      if (!sprites.has(key)) sprites.set(key, spriteURL(atlas, name, tint));
      return sprites.get(key)!;
    });
    this.root.addEventListener('mouseover', (e) => {
      const it = (e.target as HTMLElement).closest<HTMLElement>('[data-i]');
      if (it) this.handlers.hover(Number(it.dataset.i));
    });
    this.root.addEventListener('click', (e) => {
      const t = e.target as HTMLElement;
      const it = t.closest<HTMLElement>('[data-i]');
      if (!it) return;
      const adj = t.closest<HTMLElement>('[data-adj]');
      this.handlers.click(Number(it.dataset.i), adj ? Number(adj.dataset.adj) : 0);
    });
  }

  private T(text: string, s: number, cls = ''): string {
    return this.pt.html(text, s, cls);
  }

  /** Set pixel text on an element only when it changed. */
  private setT(el: HTMLElement, text: string, s: number, cls = ''): void {
    const key = `${text}|${s}|${cls}`;
    if (el.dataset.t === key) return;
    el.dataset.t = key;
    el.innerHTML = this.T(text, s, cls);
  }

  // ---------- layout ----------
  /** rect = the play view in native px (arcade: the 208 px field; campaign: the whole screen). */
  layout(vx: number, vy: number, s: number, rect: readonly number[] = [FX, FY, FS, FS]): void {
    const W = window.innerWidth;
    const H = window.innerHeight;
    const key = `${vx}|${vy}|${s}|${W}|${H}|${rect.join()}`;
    if (key === this.layoutKey) return;
    this.layoutKey = key;
    const st = this.root.style;
    st.setProperty('--vx', `${vx}px`);
    st.setProperty('--vy', `${vy}px`);
    st.setProperty('--vs', `${s}px`);
    const fx = vx + rect[0] * s;
    const fy = vy + rect[1] * s;
    const fs = rect[2] * s;
    const fh = rect[3] * s;
    this.field = [fx, fy, fs, s];
    Object.assign(this.frame.style, { left: `${fx}px`, top: `${fy}px`, width: `${fs}px`, height: `${fh}px` });
    const leftSpace = fx;
    const rightSpace = W - fx - fs;
    const side = W / H >= 1.45 && Math.min(leftSpace, rightSpace) >= 220;
    this.hudEl.classList.toggle('stack', !side);
    if (side) {
      const lw = Math.min(250, leftSpace - 48);
      Object.assign(this.hudL.style, { left: `${fx - 30 - lw}px`, top: `${fy}px`, width: `${lw}px`, bottom: '' });
      Object.assign(this.hudR.style, { left: `${fx + fs + 30}px`, top: `${fy}px`, width: `${Math.min(250, rightSpace - 48)}px`, bottom: '' });
    } else {
      Object.assign(this.hudL.style, { left: `${fx}px`, width: `${fs}px`, top: '', bottom: `${H - fy + 18}px` });
      Object.assign(this.hudR.style, { left: `${fx}px`, width: `${fs}px`, top: `${fy + fh + 18}px`, bottom: '' });
    }
    Object.assign(this.toasts.style, { left: `${fx + fs / 2}px`, top: `${fy + 24}px` });
    // title logo: 5 native px per font pixel, rounded to whole CSS px so the glyphs stay crisp
    const ls = Math.max(3, Math.round(s * 5));
    if (ls !== this.logoS) {
      this.logoS = ls;
      this.lastKey = '';
    }
  }

  /** Lightning on the title: lights the logo up with the strike's flash (0..1). */
  strike(f: number): void {
    const v = Math.round(f * 20) / 20;
    if (v === this.strikeV && this.logoEl?.isConnected) return;
    this.strikeV = v;
    this.logoEl = this.scr.querySelector<HTMLElement>('.logo');
    if (this.logoEl) this.logoEl.style.filter = v > 0 ? `brightness(${(1 + v * 1.4).toFixed(2)})` : '';
  }

  // ---------- screens ----------
  screen(sc: Screen): void {
    this.scr.classList.toggle('out', 'out' in sc && sc.out);
    const key = JSON.stringify({ ...sc, out: undefined });
    if (key === this.lastKey) return;
    this.lastKey = key;
    // updates to an already-open screen must not replay its entrance animation
    const sameKind = sc.kind === this.lastKind && (sc.kind !== 'menu' || this.scr.dataset.title === (sc as { title: string }).title);
    this.scr.classList.toggle('still', sameKind);
    this.lastKind = sc.kind;
    this.scr.dataset.title = sc.kind === 'menu' ? sc.title : '';
    this.scr.innerHTML = this.render(sc);
    if (sc.kind === 'tally') {
      const rows = this.scr.querySelectorAll('.rgrid .show');
      if (sc.shown !== this.lastShown) rows.forEach((r, i) => i >= (sc.shown - 1) * 2 && r.classList.add('fresh'));
      this.lastShown = sc.shown;
    }
  }

  private menuHtml(items: (string | MenuItem)[], sel: number): string {
    return `<div class="menu">${items.map((it, i) => {
      const m = typeof it === 'string' ? { label: it } : it;
      let val = '';
      if (m.meter !== undefined) {
        val = `<span class="val"><span class="adj" data-adj="-1">${this.T('◀', 2)}</span><span class="meter">${
          Array.from({ length: 10 }, (_, k) => `<i class="${k < m.meter! ? 'on' : ''}"></i>`).join('')
        }</span><span class="adj" data-adj="1">${this.T('▶', 2)}</span></span>`;
      } else if (m.value !== undefined) {
        val = `<span class="val ${m.value === 'OFF' ? 'off' : ''}"><span class="adj" data-adj="-1">${this.T('◀', 2)}</span>${
          this.T(m.value, 3)}<span class="adj" data-adj="1">${this.T('▶', 2)}</span></span>`;
      }
      const label = this.T(m.label, 3, m.tone === 'warn' ? 'c-red' : '');
      const head = m.note?.length
        ? `<span class="lbl">${label}${m.note.map((n) => `<span class="note">${this.T(n, 2, 'c-dim')}</span>`).join('')}</span>` : label;
      return `<div class="it ${i === sel ? 'on' : ''}" data-i="${i}"><img class="cur" src="${this.icons.cursor}">${head}${val}</div>`;
    }).join('')}</div>`;
  }

  private hints(list: [string[], string][]): string {
    return list.map(([keys, label]) => `<span>${keys.map((k) => `<span class="kc">${this.T(k, 2)}</span>`).join('')}${this.T(label, 2)}</span>`).join('');
  }

  /** Phase 5: one line of radio on a mission card (HQ's quote on the intro card, the debrief on region clear). */
  private radioLine(q: Quote, small: boolean): string {
    const who = q.who === 'KOVAL' ? 'MAJOR KOVAL · HQ' : q.who;
    return `<div class="radio-line ${small ? 'small' : ''}"><img class="face" src="${radioFace(q.who)}">
      <div class="words">${this.T(who, 2, q.who === 'KOVAL' ? 'c-blue' : 'c-gold')}<div class="para">${q.text.split(' ').map((w) => this.T(w, 2, 'c-ink')).join('')}</div></div></div>`;
  }

  private render(sc: Screen): string {
    const T = (t: string, s: number, c = '') => this.T(t, s, c);
    switch (sc.kind) {
      case 'none':
        return '';
      case 'title':
        return `
          <div class="logo" style="top: calc(var(--vy) + 36 * var(--vs)); --u: ${Math.max(2, Math.round(this.logoS / 2))}px">
            <div class="ll ll-rust">${T('RUST &', this.logoS, 'rust')}</div>
            <div class="ll ll-thunder">${T('THUNDER', this.logoS, 'thunder')}</div>
          </div>
          <div class="title-block" style="top: calc(var(--vy) + 150 * var(--vs))">
            <div class="plate">${this.menuHtml(sc.items, sc.sel)}</div>
          </div>
          <div class="badge">${T('HI-SCORE', 2, 'c-dim')}<span class="drop2">${T(fmt(sc.hi), 4, 'c-gold')}</span></div>
          <div class="hints">${this.hints([[['↑', '↓'], 'SELECT'], [['ENTER'], 'START'], [['R'], 'RTX'], [['M'], 'MUTE'], [['F'], 'FULLSCREEN']])}</div>`;
      case 'intro':
        return `
          <div class="veil"></div>
          <div class="card plate">
            <div class="hdr">${T(sc.kicker ?? 'STAGE', 2, 'c-gold')}</div>
            <div class="stack-c">
              <div class="drop6">${T(pad2(sc.stage), 16, 'grad')}</div>
              <div class="drop2">${T(sc.name, 4, 'c-ink')}</div>
              <div class="chip">${T(sc.env, 2, 'c-dim')}</div>
              <div>${T(sc.goal, 2, 'c-dim')}</div>
              ${sc.extra ? `<div>${T(sc.extra, 2, 'c-green')}</div>` : ''}
              ${sc.kept ? `<div>${T(sc.kept, 2, 'c-gold')}</div>` : ''}
              ${sc.quote ? this.radioLine(sc.quote, true) : ''}
              ${sc.canSelect ? `<div class="hints" style="position: static; transform: none; margin-top: 8px">
                ${this.hints([[['◀', '▶'], 'CHOOSE STAGE'], [['ENTER'], 'DEPLOY']])}</div>` : ''}
            </div>
          </div>`;
      case 'menu':
        return `
          <div class="veil"></div>
          <div class="card plate">
            <div class="hdr">${T(sc.kicker, 2, 'c-gold')}</div>
            <div class="stack-c">
              <div class="drop4" style="margin-bottom: 10px">${T(sc.title, 6, 'steel')}</div>
              ${this.menuHtml(sc.items, sc.sel)}
              <div class="hints" style="position: static; transform: none; margin-top: 14px">
                ${this.hints([[['↑', '↓'], 'SELECT'], ...(sc.items.some((m) => m.value !== undefined || m.meter !== undefined)
                  ? [[['←', '→'], 'CHANGE'] as [string[], string]] : []), [['ENTER'], 'OK'], [['ESC'], 'BACK']])}
              </div>
            </div>
          </div>`;
      case 'tally': {
        const rows = [0, 1, 2, 3].map((i) => {
          const show = i < sc.shown ? 'show' : 'hide';
          const c0 = sc.counts[0][i];
          const c1 = sc.counts[1]?.[i] ?? 0;
          return `
            <div class="cell l ${show}">${T(`${fmt(c0 * ENEMY[i].pts)} PTS`, 2, 'c-mute')}${T(String(c0), 3, 'c-ink')}</div>
            <div class="mid"><img src="${this.icons.enemy[i]}">${T(ENEMY_NAMES[i], 2, 'c-dim')}</div>
            <div class="cell ${show}">${sc.two ? `${T(String(c1), 3, 'c-ink')}${T(`${fmt(c1 * ENEMY[i].pts)} PTS`, 2, 'c-mute')}` : ''}</div>`;
        }).join('');
        const tot = (p: number) => sc.counts[p]?.reduce((a, b) => a + b, 0) ?? 0;
        return `
          <div class="veil"></div>
          <div class="card plate results">
            <div class="hdr">${T(`STAGE ${pad2(sc.stage)} REPORT`, 2, 'c-gold')}</div>
            <div class="drop4" style="margin-bottom: 22px">${T(sc.win ? 'STAGE CLEAR' : 'MISSION FAILED', 6, sc.win ? 'grad' : 'redg')}</div>
            <div class="rgrid">${rows}</div>
            <div class="rtotal">
              <div class="p" style="align-items: flex-end">${T(`IP · ${tot(0)} KILLS`, 2, 'c-dim')}<span class="drop2">${T(fmt(sc.scores[0]), 4, 'c-gold')}</span></div>
              <div class="p" style="align-items: flex-start">${sc.two ? `${T(`IIP · ${tot(1)} KILLS`, 2, 'c-dim')}<span class="drop2">${T(fmt(sc.scores[1]), 4, 'c-green')}</span>` : ''}</div>
            </div>
            <div class="press" style="margin-top: 22px; visibility: ${sc.done ? 'visible' : 'hidden'}">${T('PRESS ENTER', 2, 'c-ink')}</div>
          </div>`;
      }
      case 'regionclear': {
        const rows = sc.rows.map(([k, v], i) => {
          const show = i < sc.shown ? 'show' : 'hide';
          return `<div class="k ${show}">${T(k, 2, 'c-dim')}</div><div class="v ${show}">${T(v, 3, 'c-ink')}</div>`;
        }).join('');
        return `
          <div class="veil"></div>
          <div class="card plate results camp-card">
            <div class="hdr">${T(`REGION ${pad2(sc.region)} · ${sc.name}`, 2, 'c-gold')}</div>
            <div class="drop4" style="margin-bottom: 22px">${T('REGION CLEAR', 6, 'grad')}</div>
            <div class="kv">${rows}</div>
            <div class="rtotal one">${T(sc.foot, 2, 'c-gold')}</div>
            ${sc.quote ? `<div class="quote-slot ${sc.done ? '' : 'hide'}">${this.radioLine(sc.quote, false)}</div>` : ''}
            <div class="press" style="margin-top: 22px; visibility: ${sc.done ? 'visible' : 'hidden'}">${T('PRESS ENTER · TO THE WORKSHOP', 2, 'c-ink')}</div>
          </div>`;
      }
      case 'retreat':
        return `
          <div class="veil"></div>
          <div class="card plate camp-card retreat">
            <div class="hdr">${T(`REGION ${pad2(sc.region)} · ${sc.name}`, 2, 'c-gold')}</div>
            <div class="drop4" style="margin-bottom: 20px">${T('RETREAT', 6, 'redg')}</div>
            <div class="radio-line">
              <img class="face" src="${radioFace(sc.who)}">
              <div class="words">${T(sc.who, 2, 'c-gold')}<div class="para">${sc.line.split(' ').map((w) => T(w, 2, 'c-ink')).join('')}</div></div>
            </div>
            <div class="kept">${T(sc.kept, 2, 'c-dim')}</div>
            <div>${T(sc.next, 2, 'c-green')}</div>
            <div class="press" style="margin-top: 20px; visibility: ${sc.ready ? 'visible' : 'hidden'}">${T('PRESS ENTER · BACK TO THE ROAD', 2, 'c-ink')}</div>
          </div>`;
      case 'over':
        return `
          <div class="over-block" style="top: calc(var(--vy) + 146 * var(--vs))">
            ${T('FINAL SCORE', 2, 'c-dim')}
            <div class="drop4">${T(fmt(sc.score), 8, 'grad')}</div>
            ${sc.record ? `<div class="record">${T('NEW RECORD', 3, 'c-gold')}</div>` : T(`BEST ${fmt(sc.hi)}`, 2, 'c-mute')}
            <div class="plate" style="margin-top: 6px">${this.menuHtml(sc.items, sc.sel)}</div>
          </div>`;
    }
  }

  // ---------- HUD ----------
  /** cam = region mode (the map fills the window): the floating campaign HUD instead of the side panels and arena frame. */
  hud(w: World | null, hi: number, show: boolean, cam: Camera | null = null): void {
    const campaign = !!cam;
    this.hudEl.classList.toggle('off', !show || !w || campaign);
    this.hudEl.style.display = campaign ? 'none' : '';
    this.frame.classList.toggle('hidden', !show || !w || campaign);
    this.root.classList.toggle('camp', campaign && !!w);
    if (!w || !campaign) this.camp.root.classList.add('off');
    if (!w) return;
    if (campaign) {
      this.camp.update(w, cam, show);
      // toasts sit clear of the top plates
      const pos = `${Math.round(window.innerWidth / 2)}|${this.camp.toastTop}`;
      if (pos !== this.toastPos) {
        this.toastPos = pos;
        Object.assign(this.toasts.style, { left: `${Math.round(window.innerWidth / 2)}px`, top: `${this.camp.toastTop}px` });
      }
      return;
    }
    this.toastPos = '';
    const key = `${w.stage}|${w.nPlayers}`;
    if (key !== this.hudKey) {
      this.hudKey = key;
      this.timerKey = '';
      this.buildHud(w);
    }
    const E = this.el;
    const left = w.queue.length + w.enemies.filter((e) => e.alive).length;
    this.setT(E.left, String(left), 2, 'c-ink');
    const spawned = w.order.length - w.queue.length;
    E.pips.querySelectorAll<HTMLElement>('.pip').forEach((p, i) => p.classList.toggle('used', i < spawned));
    E.base.style.display = w.hasBase ? '' : 'none';
    const baseState = !w.eagleAlive ? 'lost' : w.baseShield > 0 ? 'ok' : 'down';
    if (w.hasBase && E.base.dataset.s !== baseState) {
      E.base.dataset.s = baseState;
      E.base.className = `base ${baseState}`;
      this.setT(E.baseTxt, baseState === 'lost' ? 'DESTROYED' : baseState === 'ok' ? 'SHIELD ON' : 'SHIELD DOWN', 2,
        baseState === 'ok' ? 'c-green' : 'c-red');
    }
    const timers: [string, number, string][] = [];
    if (w.freeze > 0) timers.push(['FREEZE', w.freeze / 600, '']);
    if (w.shovel > 0) timers.push(['FORTRESS', w.shovel / 1200, 'amber']);
    const tk = timers.map((t) => t[0]).join();
    if (tk !== this.timerKey) {
      this.timerKey = tk;
      E.timers.innerHTML = timers.map(([n, , c]) => `<div>${this.T(n, 2, 'c-dim')}<div class="seg ${c}">${'<i></i>'.repeat(12)}</div></div>`).join('');
    }
    E.timers.querySelectorAll<HTMLElement>('.seg').forEach((s, i) => this.segs(s, timers[i][1]));
    const danger = w.hasBase && w.eagleAlive && w.enemies.some((e) => e.alive && !e.spawn && Math.abs(e.cx - EAGLE_X - 8) + Math.abs(e.cy - EAGLE_Y - 8) < 52);
    this.frame.classList.toggle('danger', danger);

    for (let i = 0; i < w.nPlayers; i++) {
      const ps = w.ps[i];
      const t = w.players[i];
      this.setT(E[`s${i}`], fmt(ps.score), 4, 'c-ink');
      const lives = ps.out ? 0 : ps.lives;
      const L = E[`l${i}`];
      if (L.dataset.v !== String(lives)) {
        L.dataset.v = String(lives);
        L.innerHTML = Array.from({ length: Math.min(4, lives) }, () => `<img src="${this.icons.life[i]}">`).join('')
          + (lives > 4 ? `<span class="more">${this.T(`+${lives - 4}`, 2, 'c-dim')}</span>` : lives === 0 ? this.T('LAST', 2, 'c-red') : '');
      }
      const lvl = t ? t.level : ps.level;
      E[`p${i}`].querySelectorAll('img').forEach((s, k) => s.classList.toggle('off', k >= lvl));
      const mods = [ps.hover, ps.ricochet, ps.gun];
      E[`m${i}`].querySelectorAll('img').forEach((b, k) => b.classList.toggle('off', !mods[k]));
      const sh = t && t.shield > 0 && t.spawn === 0 ? t.shield : 0;
      const T = E[`t${i}`];
      T.style.display = sh ? '' : 'none';
      if (sh) this.segs(T.querySelector('.seg')!, Math.min(1, sh / 600));
      E[`c${i}`].classList.toggle('out', ps.out && !t);
    }
    this.setT(E.hi, fmt(hi), 3, 'c-gold');
  }

  private segs(s: Element, f: number): void {
    const n = Math.ceil(f * 12);
    s.querySelectorAll('i').forEach((seg, k) => seg.classList.toggle('on', k < n));
  }

  private buildHud(w: World): void {
    const T = (t: string, s: number, c = '') => this.T(t, s, c);
    const bonus = new Set([3, 10, 17]);
    this.hudL.innerHTML = `
      <div class="plate">
        <div class="hdr">${T('STAGE', 2, 'c-gold')}${T(w.envLabel.split(' · ')[0], 2, 'c-dim')}</div>
        <div class="sec">
          <div class="drop4">${T(pad2(w.stage), 8, 'grad')}</div>
          <div style="margin-top: 10px">${T(w.def.name, 2, 'c-ink')}</div>
          <div class="chip">${T(w.envLabel, 2, 'c-dim')}</div>
        </div>
        <div class="sep"></div>
        <div class="sec">
          <div class="row" style="margin-top: 0">${T('TANKS LEFT', 2, 'c-dim')}<span data-k="left"></span></div>
          <div class="pips" data-k="pips">${w.order.map((t, i) =>
            `<i class="pip ${bonus.has(i) ? 'bonus' : ''}" style="background-image:url(${this.icons.enemy[t]})"></i>`).join('')}</div>
        </div>
        <div class="sep"></div>
        <div class="sec">
          ${T('BASE', 2, 'c-dim')}
          <div class="base" data-k="base"><img src="${this.icons.eagle}"><span data-k="baseTxt"></span></div>
          <div class="timers" data-k="timers"></div>
        </div>
      </div>`;
    const P = this.icons.power;
    const cards = Array.from({ length: w.nPlayers }, (_, i) => `
      <div class="plate pcard" data-k="c${i}">
        <div class="hdr"><span class="tag ${i ? 'p2' : ''}">${T(i ? 'IIP' : 'IP', 2)}</span>${T('SCORE', 2, 'c-dim')}</div>
        <div class="score drop2" data-k="s${i}"></div>
        <div class="row">${T('LIVES', 2, 'c-dim')}<span class="icons" data-k="l${i}"></span></div>
        <div class="row">${T('POWER', 2, 'c-dim')}<span class="icons" data-k="p${i}"><img src="${P[3]}"><img src="${P[3]}"><img src="${P[3]}"></span></div>
        <div class="row">${T('GEAR', 2, 'c-dim')}<span class="icons" data-k="m${i}"><img src="${P[7]}" title="Hover"><img src="${P[9]}" title="Ricochet"><img src="${P[6]}" title="Max gun"></span></div>
        <div data-k="t${i}" style="display: none; margin-top: 12px">${T('SHIELD', 2, 'c-blue')}<div class="seg">${'<i></i>'.repeat(12)}</div></div>
      </div>`).join('');
    this.hudR.innerHTML = `${cards}<div class="plate hi"><div class="hdr">${T('HI-SCORE', 2, 'c-gold')}</div><span class="drop2" data-k="hi"></span></div>`;
    this.el = {};
    this.hudEl.querySelectorAll<HTMLElement>('[data-k]').forEach((e) => { this.el[e.dataset.k!] = e; });
  }

  // ---------- campaign ----------
  /** A line of radio chatter for the campaign HUD's radio panel. */
  radio(m: RadioMsg): void {
    this.camp.radio(m);
  }

  /** Called when the radio panel starts a new line. */
  set onRadio(f: () => void) {
    this.camp.onLine = f;
  }

  /** The big map overlay (TAB): toggle, or close it (pause, leaving the region). */
  toggleMap(): void {
    this.camp.toggleMap();
  }

  closeMap(): void {
    this.camp.closeMap();
  }

  /**
   * Campaign workshop prompt over a freed town's flag ("ENTER · WORKSHOP"); null hides it. (x, y) = the flag top in
   * play-view px, like popup(); key = the key-cap text; ok = false greys it out with the reason instead.
   */
  prompt(p: { x: number; y: number; key: string; text: string; ok: boolean } | null): void {
    const el = this.promptEl;
    if (!p) {
      if (el.dataset.k) {
        el.dataset.k = '';
        el.classList.remove('on');
      }
      return;
    }
    const [fx, fy, , s] = this.field;
    const k = `${p.key}|${p.text}|${p.ok}`;
    if (el.dataset.k !== k) {
      el.dataset.k = k;
      el.innerHTML = p.ok ? `<span class="kc">${this.T(p.key, 2)}</span>${this.T(p.text, 2, 'c-gold')}` : this.T(p.text, 2, 'c-dim');
      el.classList.add('on');
    }
    el.style.left = `${Math.round(fx + p.x * s)}px`;
    el.style.top = `${Math.round(fy + p.y * s)}px`;
  }

  // ---------- transient ----------
  toast(text: string, kind: 'power' | 'warn' | 'info', icon = -1, ms = 0): void {
    // at most two at once (G3): a newer toast pushes the oldest off, but a long-lived one (a drone warning) goes last
    while (this.toasts.children.length > 1) {
      // plain news goes before a warning (BOSS LOCATED), a warning before a long-lived one
      const all = Array.from(this.toasts.children) as HTMLElement[];
      const gone = all.find((c) => !c.dataset.long && !c.classList.contains('warn')) ?? all.find((c) => !c.dataset.long) ?? all[0];
      gone.remove();
    }
    const d = document.createElement('div');
    d.className = `toast ${kind}`;
    if (ms > 2200) {
      d.dataset.long = '1';
      d.style.animationDelay = `0s, ${(ms - 400) / 1000}s`;
    }
    const cls = kind === 'warn' ? 'c-red' : kind === 'power' ? 'grad' : 'c-ink';
    d.innerHTML = `${icon >= 0 ? `<img src="${this.icons.power[icon]}">` : ''}<span class="drop2">${this.T(text, 3, cls)}</span>`;
    this.toasts.appendChild(d);
    setTimeout(() => d.remove(), ms || 2200);
  }

  popup(x: number, y: number, text: string): void {
    const [fx, fy, , s] = this.field;
    const d = document.createElement('div');
    d.className = 'pop outline';
    d.innerHTML = this.T(text, 2, 'c-ink');
    d.style.left = `${fx + x * s}px`;
    d.style.top = `${fy + y * s}px`;
    d.addEventListener('animationend', () => d.remove());
    this.pops.appendChild(d);
  }

  fps(v: number | null): void {
    this.setT(this.fpsEl, v === null ? '' : `${v} FPS`, 2, 'c-dim');
  }

  muted(m: boolean): void {
    this.setT(this.muteEl, m ? 'MUTED' : '', 2, 'c-mute');
  }
}
