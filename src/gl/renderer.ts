import { Batch } from './batch';
import { Cascades } from './cascades';
import { Fluid } from './fluid';
import { Program, Target, makeTex, type GL, type TexSpec } from './glutil';
import * as S from './shaders';
import type { Atlas, Spr } from '../art/atlas';

/** Default (arcade) native screen. Campaign widens or heightens it to the window's shape: r.setNative. */
export const NW = 256;
export const NH = 224;
/**
 * Screen-space buffers carry a guard on the right/bottom: when the camera sits between native pixels
 * the final pass slides the image by up to 1 px, so the world is lit 1 px past litRect, also when
 * litRect is the whole screen. Screen px (x, y) is buffer texel (x, y) in every buffer. The guard is
 * 4-7 px (only 1 is used): buffer sizes are multiples of 4 so the cascades' mip levels stay exact 2x2
 * averages of the screen pixels. 256 x 224 -> 260 x 228.
 */
const guarded = (n: number) => (n + 4 + 3) & ~3;
/** A camera jump larger than this (native px) is a cut: histories reset instead of shifting. */
const CUT = 64;
const MAX_LIGHTS = 256;
/** fill mode may crop up to this many native px (split over both edges) to cover the window */
const FILL_CROP = 2;
const LF = 12; // floats per light
/** Tree canopy opacity: tanks and ground show through at 1 - this. */
const CANOPY_ALPHA = 0.8;

export interface Env {
  ambient: [number, number, number];
  sunCol: [number, number, number];
  sunDir: [number, number, number];
  fog: number;
  wet: number;
  snow: number;
  clouds: number;
  sky: [number, number, number];
  gradeLo: [number, number, number];
  gradeHi: [number, number, number];
  sat: number;
  backdrop: [number, number, number];
  ground: [number, number, number];
  grass: number;
  /** warm glow of distant fires along the top edge of the screen (linear HDR; unset = none). Ruined Town at night. */
  horizon?: [number, number, number];
  /** water colour scale (unset = 1): night water darker so the canal doesn't outshine the fires */
  water?: number;
  /** brick colour of the place: a multiplier, and a wash (rgb + amount) the three brick shades are pulled toward
   * (whitewash, soot); unset = the classic orange */
  brickTint?: [number, number, number];
  brickWash?: [number, number, number, number];
  /** foliage colour multiplier of the place (unset = 1), and how far the two brightest leaf shades are pulled
   * toward olive (unset = 0) */
  leaf?: [number, number, number];
  /** foliage wash (rgb + amount): the five leaf shades are pulled toward this colour, keeping their steps */
  leafWash?: [number, number, number, number];
  leafOlive?: number;
}

const ONE3: [number, number, number] = [1, 1, 1];
const ZERO4: [number, number, number, number] = [0, 0, 0, 0];

export const DEFAULT_ENV: Env = {
  ambient: [0.3, 0.3, 0.35], sunCol: [0.8, 0.75, 0.7], sunDir: [-0.45, -0.6, 1.0], fog: 0.05, wet: 0, snow: 0, clouds: 0,
  sky: [0.3, 0.35, 0.45], gradeLo: [1, 1, 1], gradeHi: [1, 1, 1], sat: 1, backdrop: [0.012, 0.016, 0.026], ground: [0.105, 0.102, 0.1], grass: 0,
};

export interface Shock {
  x: number;
  y: number;
  r: number;
  s: number;
}

export class Renderer {
  gl: GL;
  k = 0;
  /** native screen size (NW x NH in arcade); change it with setNative */
  nw = NW;
  nh = NH;
  /** screen-space buffer size: the native screen plus the guard */
  private bw = guarded(NW);
  private bh = guarded(NH);
  /** native size the HDR / bloom chain was made for */
  private hdrSize = [0, 0];
  /**
   * Fill the window: scale so the native screen covers it when that crops at most FILL_CROP native
   * px (the app sized the native screen to the window's shape), instead of fitting inside it.
   */
  fill = false;
  view = [0, 0, NW, NH];
  hdrOK: boolean;

  g: Batch; // lit world -> gbuffer
  canopy: Batch; // tree canopy, blended over g
  gTop: Batch; // lit sprites above the canopy (power-ups)
  /** Phase 4 bosses: shadows of things in the air, multiplied into the colour of what's under them (shadeSpr) */
  shade: Batch;
  /** route spr / rectG into gTop */
  top = false;
  fxAdd: Batch; // additive glow into HDR (and into the glow buffer the cascades read)
  fxAlpha: Batch; // snow etc
  overlay: Batch; // unlit sprites/text, drawn last
  /** unlit, composited in the final pass after bloom and grading: boss attack warnings that nothing may wash out */
  overlayTop: Batch;
  decal: Batch; // persistent ground decals (native res)

  env: Env = { ...DEFAULT_ENV };
  /** The on-screen view rect that gets lit (the scrolling viewport). */
  litRect = [24, 8, 208, 208];
  /**
   * Camera scroll in whole native px: terrain space = screen px + scroll. Terrain noise, the cell map
   * and decals live in terrain space; everything else (sprites, lights, splats) is given in screen px.
   */
  scroll: [number, number] = [0, 0];
  /** Sub-pixel part of the camera, [0, 1): the final pass slides the lit field by this much. */
  subpx: [number, number] = [0, 0];
  shake = [0, 0];
  shocks: Shock[] = [];
  flash = [0, 0, 0];
  aberr = 0.35;
  crt = false;
  rtx = true;
  /** Animal Well-style lighting: lit per native pixel and stepped into bands. */
  pixel = false;
  exposure = 1.0;
  bloomStr = 0.9;
  emGain = 3.0;
  giStr = 0.9;
  haze = 0.9;
  /** seconds since the last frame (set by the app) */
  dt = 1 / 60;
  wind: [number, number] = [0, 0];
  /** CSS px kept free around the game view for the HUD: top, right, bottom, left. */
  reserve = [0, 0, 0, 0];
  clearDecals = true;
  resetHistory = true;
  frame = 0;
  feather = 0;
  maxK = 6;
  /** the playfield cell map is uploaded (enables foam along banks) */
  hasCells = false;

  private fluid: Fluid | null = null;
  private rc: Cascades | null = null;
  private lights = new Float32Array(MAX_LIGHTS * LF);
  private nLights = 0;
  private gb!: Target;
  private decalT: Target;
  private glowT!: Target;
  private gi!: Target[];
  private refl!: Target[];
  /** overlayTop drawn at native res (premultiplied, linear), composited by the final pass */
  private ovTop!: Target;
  private hdr!: Target; // [scene, light reaching the air (for smoke)]
  private hdrSolo: WebGLFramebuffer | null = null; // same scene texture, single attachment
  private bloom: Target[] = [];
  private pG: Program;
  private pBase: Program;
  private pLight: Program;
  private pFx: Program;
  private pGI: Program;
  private pRefl: Program;
  private pComp: Program;
  private pSmoke: Program;
  private pPre: Program;
  private pDown: Program;
  private pUp: Program;
  private pFinal: Program;
  private atlasTex: WebGLTexture[];
  private black: WebGLTexture;
  private cells: WebGLTexture;
  private cellsVersion = -1;
  /** ground kinds (campaign): one byte per cell, the size of the cell map; null = none */
  private kinds: WebGLTexture;
  private kindsSrc: Uint8Array | null = null;
  /** railway geometry (campaign, railgeo.ts): two RGBA float texels per cell, side by side; null = none */
  private railT: WebGLTexture;
  private railSrc: Float32Array | null = null;
  private cellsSrc: Uint8Array | null = null;
  private cellW = 52;
  private cellH = 52;
  /** terrain px of cell (0, 0); null = the top-left of litRect (arcade setCells) */
  private cellOrigin: [number, number] | null = null;
  private terrainW = NW;
  private terrainH = NH;
  /** scroll the fluid fields were last stepped at */
  private fluidScroll: [number, number] = [0, 0];
  /** scroll and lit field the GI / reflection / bounce histories were last written at */
  private histScroll: [number, number] = [0, 0];
  private histRect = [24, 8, 208, 208];
  private lightVao: WebGLVertexArrayObject;
  private lightVbo: WebGLBuffer;
  private emptyVao: WebGLVertexArrayObject;
  private hdrSpec: TexSpec;
  private shockArr = new Float32Array(32);

  constructor(public canvas: HTMLCanvasElement, public atlas: Atlas) {
    const gl = canvas.getContext('webgl2', { antialias: false, alpha: false, premultipliedAlpha: false, preserveDrawingBuffer: true });
    if (!gl) throw new Error('WebGL2 is not available in this browser.');
    this.gl = gl;
    this.hdrOK = !!gl.getExtension('EXT_color_buffer_float');
    this.hdrSpec = this.hdrOK
      ? { internal: gl.RGBA16F, format: gl.RGBA, type: gl.HALF_FLOAT, filter: gl.LINEAR }
      : { internal: gl.RGBA8, format: gl.RGBA, type: gl.UNSIGNED_BYTE, filter: gl.LINEAR };

    this.g = new Batch(gl);
    this.canopy = new Batch(gl);
    this.gTop = new Batch(gl);
    this.shade = new Batch(gl);
    this.fxAdd = new Batch(gl);
    this.fxAlpha = new Batch(gl);
    this.overlay = new Batch(gl);
    this.overlayTop = new Batch(gl);
    this.decal = new Batch(gl);

    this.pG = new Program(gl, S.SPRITE_VS, S.GBUFFER_FS, 'gbuffer');
    this.pBase = new Program(gl, S.FULL_VS, S.BASE_FS, 'base');
    this.pLight = new Program(gl, S.LIGHT_VS, S.LIGHT_FS, 'light');
    this.pFx = new Program(gl, S.SPRITE_VS, S.FX_FS, 'fx');
    this.pGI = new Program(gl, S.FULL_VS, S.GI_FS, 'ao');
    this.pRefl = new Program(gl, S.FULL_VS, S.REFL_FS, 'reflections');
    this.pComp = new Program(gl, S.FULL_VS, S.COMPOSITE_FS, 'composite');
    this.pSmoke = new Program(gl, S.FULL_VS, S.SMOKE_FS, 'smoke');
    this.pPre = new Program(gl, S.FULL_VS, S.PREFILTER_FS, 'prefilter');
    this.pDown = new Program(gl, S.FULL_VS, S.DOWN_FS, 'down');
    this.pUp = new Program(gl, S.FULL_VS, S.UP_FS, 'up');
    this.pFinal = new Program(gl, S.FULL_VS, S.FINAL_FS, 'final');

    const rgba8n: TexSpec = { internal: gl.RGBA8, format: gl.RGBA, type: gl.UNSIGNED_BYTE, filter: gl.NEAREST };
    this.decalT = new Target(gl, NW, NH, [rgba8n]);
    this.allocScreen();
    this.atlasTex = [atlas.alb, atlas.hs, atlas.em].map((d) => makeTex(gl, atlas.W, atlas.H, rgba8n, d));
    this.black = makeTex(gl, 1, 1, rgba8n, new Uint8Array(4));
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    this.cells = makeTex(gl, 52, 52, { internal: gl.R8, format: gl.RED, type: gl.UNSIGNED_BYTE, filter: gl.NEAREST }, new Uint8Array(52 * 52));
    this.kinds = makeTex(gl, 1, 1, { internal: gl.R8, format: gl.RED, type: gl.UNSIGNED_BYTE, filter: gl.NEAREST }, new Uint8Array(1));
    this.railT = makeTex(gl, 1, 1, { internal: gl.RGBA32F, format: gl.RGBA, type: gl.FLOAT, filter: gl.NEAREST }, new Float32Array(4));
    if (this.hdrOK) {
      this.fluid = new Fluid(gl, this.bw, this.bh, this.hdrSpec);
      this.rc = new Cascades(gl, this.bw, this.bh, this.hdrSpec);
    } else {
      this.rtx = false;
    }

    this.lightVao = gl.createVertexArray()!;
    gl.bindVertexArray(this.lightVao);
    const corner = gl.createBuffer()!;
    gl.bindBuffer(gl.ARRAY_BUFFER, corner);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
    this.lightVbo = gl.createBuffer()!;
    gl.bindBuffer(gl.ARRAY_BUFFER, this.lightVbo);
    gl.bufferData(gl.ARRAY_BUFFER, this.lights.byteLength, gl.DYNAMIC_DRAW);
    for (let i = 0; i < 3; i++) {
      gl.enableVertexAttribArray(1 + i);
      gl.vertexAttribPointer(1 + i, 4, gl.FLOAT, false, LF * 4, i * 16);
      gl.vertexAttribDivisor(1 + i, 1);
    }
    gl.bindVertexArray(null);
    this.emptyVao = gl.createVertexArray()!;

    this.resize();
  }

  /** Native-res screen targets: gbuffer, glow, GI and reflection histories. */
  private allocScreen(): void {
    const gl = this.gl;
    const rgba8n: TexSpec = { internal: gl.RGBA8, format: gl.RGBA, type: gl.UNSIGNED_BYTE, filter: gl.NEAREST };
    const [w, h] = [this.bw, this.bh];
    this.gb = new Target(gl, w, h, [rgba8n, rgba8n, rgba8n]);
    this.glowT = new Target(gl, w, h, [this.hdrSpec]);
    this.gi = [new Target(gl, w, h, [this.hdrSpec]), new Target(gl, w, h, [this.hdrSpec])];
    this.refl = [new Target(gl, w, h, [this.hdrSpec]), new Target(gl, w, h, [this.hdrSpec])];
    this.ovTop = new Target(gl, w, h, [rgba8n]);
  }

  /**
   * Native screen size in px (arcade NW x NH; campaign follows the window's shape). Reallocates every
   * screen-sized buffer and the HDR / bloom chain, and resets the histories, only when it changes.
   */
  setNative(w: number, h: number): void {
    w = Math.max(16, Math.round(w));
    h = Math.max(16, Math.round(h));
    if (w === this.nw && h === this.nh) return;
    this.nw = w;
    this.nh = h;
    const bw = guarded(w);
    const bh = guarded(h);
    if (bw !== this.bw || bh !== this.bh) {
      this.bw = bw;
      this.bh = bh;
      for (const t of [this.gb, this.glowT, ...this.gi, ...this.refl, this.ovTop]) t.dispose();
      this.allocScreen();
      this.fluid?.resize(bw, bh);
      this.rc?.resize(bw, bh);
    }
    this.resetHistory = true;
    this.resize();
  }

  /** CSS-pixel rect of the native screen inside the window: [x, y, scale]. */
  cssView(): [number, number, number] {
    const dpr = this.canvas.width / Math.max(1, this.canvas.clientWidth);
    return [this.view[0] / dpr, this.view[1] / dpr, this.view[2] / this.nw / dpr];
  }

  resize(): void {
    const gl = this.gl;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const cw = Math.max(1, Math.floor(this.canvas.clientWidth * dpr));
    const ch = Math.max(1, Math.floor(this.canvas.clientHeight * dpr));
    if (this.canvas.width !== cw || this.canvas.height !== ch) {
      this.canvas.width = cw;
      this.canvas.height = ch;
    }
    const [rt, rr, rb, rl] = this.reserve.map((v) => v * dpr);
    const aw = Math.max(64, cw - rl - rr);
    const ah = Math.max(64, ch - rt - rb);
    const { nw, nh } = this;
    let s = Math.min(aw / nw, ah / nh);
    // fill: cover the window instead, if that crops no more than a sliver (rounding of the native size)
    const cover = Math.max(aw / nw, ah / nh);
    if (this.fill && Math.max(nw - aw / cover, nh - ah / cover) <= FILL_CROP) s = cover;
    const k = Math.max(2, Math.min(this.maxK, Math.ceil(s)));
    const vw = nw * s;
    const vh = nh * s;
    this.view = [Math.round(rl + (aw - vw) / 2), Math.round(rt + (ah - vh) / 2), vw, vh];
    if (k === this.k && nw === this.hdrSize[0] && nh === this.hdrSize[1]) return;
    this.k = k;
    this.hdrSize = [nw, nh];
    this.hdr?.dispose();
    if (this.hdrSolo) gl.deleteFramebuffer(this.hdrSolo);
    this.bloom.forEach((b) => b.dispose());
    this.hdr = new Target(gl, this.bw * k, this.bh * k, [this.hdrSpec, this.hdrSpec]);
    this.hdrSolo = gl.createFramebuffer()!;
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.hdrSolo);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, this.hdr.tex[0], 0);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    this.bloom = [];
    // bloom covers the screen part of the HDR only (same chain of sizes as without the guard)
    let w = (nw * k) >> 1;
    let h = (nh * k) >> 1;
    for (let i = 0; i < 6 && w >= 4 && h >= 4; i++) {
      this.bloom.push(new Target(gl, w, h, [this.hdrSpec]));
      w >>= 1;
      h >>= 1;
    }
  }

  // ---------- drawing helpers (native pixel coords) ----------

  /** Lit sprite into the gbuffer. */
  spr(s: Spr, x: number, y: number, rot = 0, tint = WHITE, mat = 1, hBias = 0, em = 1, whiten = 0): void {
    const w = rot & 1 ? s.h : s.w;
    const h = rot & 1 ? s.w : s.h;
    (this.top ? this.gTop : this.g).quad(x, y, x + w, y + h, s.x, s.y, s.x + s.w, s.y + s.h, rot, tint[0], tint[1], tint[2], 1, mat, hBias, em, whiten);
  }

  /**
   * Lit sprite into the gbuffer, centred on (cx, cy) and turned `ang` radians clockwise (any angle; 0 = as authored,
   * facing up). Height, tint mask and emissive turn with it, so shadows and lights stay right. Pass a whole-pixel
   * centre (half-pixel for odd sizes) so the nearest-texel pattern holds still while it moves.
   */
  sprRot(s: Spr, cx: number, cy: number, ang: number, tint = WHITE, mat = 1, hBias = 0, em = 1, whiten = 0): void {
    // off the quarter turns the gbuffer shader picks texels RotSprite-style (alpha 2 flags it); on them, plain texels
    const q = ang / (Math.PI / 2);
    const turned = Math.abs(q - Math.round(q)) > 1e-4;
    (this.top ? this.gTop : this.g).quadRot(cx, cy, s.w, s.h, ang, s.x, s.y, s.x + s.w, s.y + s.h, tint[0], tint[1], tint[2], turned ? 2 : 1, mat, hBias, em, whiten);
  }

  /** Sub-rectangle of a sprite into the gbuffer (used for tiled terrain). */
  sprPart(s: Spr, sx: number, sy: number, w: number, h: number, x: number, y: number, mat: number, tint = WHITE, hBias = 0, em = 0): void {
    this.g.quad(x, y, x + w, y + h, s.x + sx, s.y + sy, s.x + sx + w, s.y + sy + h, 0, tint[0], tint[1], tint[2], 1, mat, hBias, em, 0);
  }

  /** Solid block into gbuffer using the white texel. */
  rectG(x: number, y: number, w: number, h: number, mat: number, tint = WHITE, hBias = 0, em = 0): void {
    const s = this.atlas.S.white;
    (this.top ? this.gTop : this.g).quad(x, y, x + w, y + h, s.x, s.y, s.x + 1, s.y + 1, 0, tint[0], tint[1], tint[2], 1, mat, hBias, em, 0);
  }

  /**
   * Phase 4 bosses: a shadow cast from the air. The sprite's shape (author it white with the tint mask on) darkens
   * the colour of the ground, tanks and canopy under it to `k` (0 black .. 1 untouched); heights stay, so it never
   * changes the lighting's own shadows. `scale` draws it bigger or smaller (nearest-pixel).
   */
  shadeSpr(s: Spr, x: number, y: number, rot: number, k: number, scale = 1): void {
    const w = (rot & 1 ? s.h : s.w) * scale;
    const h = (rot & 1 ? s.w : s.h) * scale;
    this.shade.quad(x, y, x + w, y + h, s.x, s.y, s.x + s.w, s.y + s.h, rot, k, k, k, 1, 1, 0, 0, 0);
  }

  /** Tree canopy cell (foliage material), drawn see-through over whatever is beneath it. */
  canopyRect(x: number, y: number, w: number, h: number, mat: number): void {
    const s = this.atlas.S.white;
    this.canopy.quad(x, y, x + w, y + h, s.x, s.y, s.x + 1, s.y + 1, 0, 1, 1, 1, 1, mat, 0, 0, 0);
  }

  /** Additive sprite (HDR). */
  fxSpr(s: Spr, x: number, y: number, col: ArrayLike<number>, intensity: number, rot = 0, a = 1): void {
    const w = rot & 1 ? s.h : s.w;
    const h = rot & 1 ? s.w : s.h;
    this.fxAdd.quad(x, y, x + w, y + h, s.x, s.y, s.x + s.w, s.y + s.h, rot, col[0], col[1], col[2], a, 0, intensity, 0, 0);
  }

  /** Additive solid streak (rain etc). */
  fxRect(x: number, y: number, w: number, h: number, col: ArrayLike<number>, intensity: number): void {
    const s = this.atlas.S.white;
    this.fxAdd.quad(x, y, x + w, y + h, s.x, s.y, s.x + 1, s.y + 1, 0, col[0], col[1], col[2], 1, 0, intensity, 0, 0);
  }

  glow(x: number, y: number, r: number, col: ArrayLike<number>, intensity: number): void {
    this.fxAdd.quad(x - r, y - r, x + r, y + r, -1, -1, 1, 1, 0, col[0], col[1], col[2], 1, 1, intensity, 0, 0);
  }

  smoke(x: number, y: number, r: number, col: ArrayLike<number>, a: number): void {
    this.fxAlpha.quad(x - r, y - r, x + r, y + r, -1, -1, 1, 1, 0, col[0], col[1], col[2], a, 2, 1, 0, 0);
  }

  probe(which: 'dye' | 'wave' | 'vel', x: number, y: number): number[] {
    return this.fluid ? this.fluid.probe(which, x, y) : [];
  }

  get hasFluid(): boolean {
    return !!this.fluid;
  }

  /** Push the smoke fluid (native px, px/s). */
  velSplat(x: number, y: number, r: number, vx: number, vy: number): void {
    this.fluid?.velSplat(x, y, r, vx, vy);
  }

  /** Add smoke / heat (haze) / fire to the fluid. */
  dyeSplat(x: number, y: number, r: number, smoke: number, heat: number, fire: number): void {
    this.fluid?.dyeSplat(x, y, r, smoke, heat, fire);
  }

  /** Disturb water (only water pixels respond). */
  waveSplat(x: number, y: number, r: number, amount: number): void {
    this.fluid?.waveSplat(x, y, r, amount);
  }

  /** Upload the 52x52 arcade cell map (raw cell types), drawn at the top left of litRect. Call every frame. */
  setCells(c: Uint8Array, version: number): void {
    this.uploadCells(c, 52, 52, version, null);
    this.cellOrigin = null;
  }

  /**
   * Upload a cell map of any size (4 px cells; 0 empty, 1 brick, 2 steel, 3 water, 4 trees, 5 ice) so
   * terrain knows its banks, canopy edges and broken walls. Cell (0, 0) sits at terrain px (ox, oy).
   * Uploads only when `version` changes (or the array or size does); `dirty` = [cx, cy, cw, ch] cell
   * rects changed since the last upload, else everything goes up. Call every frame.
   */
  setCellMap(c: Uint8Array, w: number, h: number, version: number, ox: number, oy: number, dirty: number[][] | null = null): void {
    this.uploadCells(c, w, h, version, dirty);
    this.cellOrigin = [ox, oy];
  }

  /**
   * The ground kinds that go with the cell map (same size, one byte per cell: GK_* in constants.ts), or null for
   * none. They never change during play, so the texture is uploaded once per array.
   */
  setKindMap(k: Uint8Array | null, w = 0, h = 0): void {
    if (k === this.kindsSrc) return;
    this.kindsSrc = k;
    if (!k) return;
    const gl = this.gl;
    gl.bindTexture(gl.TEXTURE_2D, this.kinds);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.R8, w, h, 0, gl.RED, gl.UNSIGNED_BYTE, k);
  }

  /**
   * The railway geometry that goes with the cell map (bakeRailGeo: w*2 x h texels of 4 floats), or null for none.
   * It never changes during play, so the texture is uploaded once per array.
   */
  setRailMap(g: Float32Array | null, w = 0, h = 0): void {
    if (g === this.railSrc) return;
    this.railSrc = g;
    if (!g) return;
    const gl = this.gl;
    gl.bindTexture(gl.TEXTURE_2D, this.railT);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA32F, w * 2, h, 0, gl.RGBA, gl.FLOAT, g);
  }

  private uploadCells(c: Uint8Array, w: number, h: number, version: number, dirty: number[][] | null): void {
    this.hasCells = true;
    const resized = w !== this.cellW || h !== this.cellH;
    if (!resized && version === this.cellsVersion && c === this.cellsSrc) return;
    const gl = this.gl;
    gl.bindTexture(gl.TEXTURE_2D, this.cells);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    if (resized) {
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.R8, w, h, 0, gl.RED, gl.UNSIGNED_BYTE, c);
      this.cellW = w;
      this.cellH = h;
    } else if (dirty && dirty.length && c === this.cellsSrc) {
      gl.pixelStorei(gl.UNPACK_ROW_LENGTH, w);
      for (const [rx, ry, rw, rh] of dirty) {
        const x0 = Math.max(0, Math.floor(rx));
        const y0 = Math.max(0, Math.floor(ry));
        const x1 = Math.min(w, Math.ceil(rx + rw));
        const y1 = Math.min(h, Math.ceil(ry + rh));
        if (x1 <= x0 || y1 <= y0) continue;
        gl.pixelStorei(gl.UNPACK_SKIP_PIXELS, x0);
        gl.pixelStorei(gl.UNPACK_SKIP_ROWS, y0);
        gl.texSubImage2D(gl.TEXTURE_2D, 0, x0, y0, x1 - x0, y1 - y0, gl.RED, gl.UNSIGNED_BYTE, c);
      }
      gl.pixelStorei(gl.UNPACK_ROW_LENGTH, 0);
      gl.pixelStorei(gl.UNPACK_SKIP_PIXELS, 0);
      gl.pixelStorei(gl.UNPACK_SKIP_ROWS, 0);
    } else {
      gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, w, h, gl.RED, gl.UNSIGNED_BYTE, c);
    }
    this.cellsVersion = version;
    this.cellsSrc = c;
  }

  /**
   * Terrain-space area [0, w) x [0, h) that keeps persistent decals (scorch marks, tracks). Default
   * NW x NH (arcade). Changing it clears the decals.
   */
  setTerrainSize(w: number, h: number): void {
    const max = this.gl.getParameter(this.gl.MAX_TEXTURE_SIZE) as number;
    w = Math.max(1, Math.min(max, Math.ceil(w)));
    h = Math.max(1, Math.min(max, Math.ceil(h)));
    if (w === this.terrainW && h === this.terrainH) return;
    this.terrainW = w;
    this.terrainH = h;
    this.decalT.dispose();
    const rgba8n: TexSpec = { internal: this.gl.RGBA8, format: this.gl.RGBA, type: this.gl.UNSIGNED_BYTE, filter: this.gl.NEAREST };
    this.decalT = new Target(this.gl, w, h, [rgba8n]);
    this.clearDecals = true;
  }

  /** Unlit sprite. */
  ovSpr(s: Spr, x: number, y: number, col: ArrayLike<number> = WHITE, a = 1, scale = 1, rot = 0): void {
    const w = (rot & 1 ? s.h : s.w) * scale;
    const h = (rot & 1 ? s.w : s.h) * scale;
    this.overlay.quad(x, y, x + w, y + h, s.x, s.y, s.x + s.w, s.y + s.h, rot, col[0], col[1], col[2], a, 4, 1, 0, 0);
  }

  ovRect(x: number, y: number, w: number, h: number, col: ArrayLike<number>, a = 1): void {
    this.overlay.quad(x, y, x + w, y + h, 0, 0, 1, 1, 0, col[0], col[1], col[2], a, 3, 1, 0, 0);
  }

  /** Unlit rect on top of the finished image (after bloom, tone mapping and grading): shown in exactly its colour. */
  topRect(x: number, y: number, w: number, h: number, col: ArrayLike<number>, a = 1): void {
    this.overlayTop.quad(x, y, x + w, y + h, 0, 0, 1, 1, 0, col[0], col[1], col[2], a, 3, 1, 0, 0);
  }

  decalRect(x: number, y: number, w: number, h: number, col: ArrayLike<number>, a: number): void {
    this.decal.quad(x, y, x + w, y + h, 0, 0, 1, 1, 0, col[0], col[1], col[2], a, 3, 1, 0, 0);
  }

  decalCircle(x: number, y: number, r: number, col: ArrayLike<number>, a: number): void {
    this.decal.quad(x - r, y - r, x + r, y + r, -1, -1, 1, 1, 0, col[0], col[1], col[2], a, 2, 1, 0, 0);
  }

  /** Omni light. z = height in native px. */
  light(x: number, y: number, z: number, radius: number, r: number, g: number, b: number, shadow = true): void {
    this.spot(x, y, z, radius, r, g, b, shadow, 0, 0, -2, -1);
  }

  spot(x: number, y: number, z: number, radius: number, r: number, g: number, b: number, shadow: boolean,
    dx: number, dy: number, cosOuter: number, cosInner: number): void {
    if (this.nLights >= MAX_LIGHTS) return;
    const o = this.nLights++ * LF;
    const L = this.lights;
    L[o] = x; L[o + 1] = y; L[o + 2] = z; L[o + 3] = radius;
    L[o + 4] = r; L[o + 5] = g; L[o + 6] = b; L[o + 7] = shadow ? 1 : 0;
    L[o + 8] = dx; L[o + 9] = dy; L[o + 10] = cosOuter; L[o + 11] = cosInner;
  }

  // ---------- frame ----------

  private fullscreen(): void {
    this.gl.bindVertexArray(this.emptyVao);
    this.gl.drawArrays(this.gl.TRIANGLES, 0, 3);
  }

  private tex(unit: number, t: WebGLTexture): void {
    this.gl.activeTexture(this.gl.TEXTURE0 + unit);
    this.gl.bindTexture(this.gl.TEXTURE_2D, t);
  }

  private bindSolo(): void {
    this.gl.bindFramebuffer(this.gl.FRAMEBUFFER, this.hdrSolo);
    this.gl.viewport(0, 0, this.hdr.w, this.hdr.h);
  }

  render(time: number): void {
    const gl = this.gl;
    this.resize();
    this.frame++;
    const env = this.env;
    const [aw, ah] = [this.atlas.W, this.atlas.H];
    const bindAtlas = () => this.atlasTex.forEach((t, i) => this.tex(i, t));
    const dt = Math.min(1 / 30, Math.max(1 / 500, this.dt));
    const pix = this.pixel ? 1 : 0;
    const rtx = this.rtx && !!this.rc;
    const k = this.k;
    const [lx, ly, lw, lh] = this.litRect;
    const field = [lx, ly, lw, lh] as const;
    // camera: whole-px scroll, and the sub-pixel rest snapped to whole HDR texels (1/k native px)
    const sx = Math.round(this.scroll[0]);
    const sy = Math.round(this.scroll[1]);
    const subx = Math.min(1, Math.max(0, Math.round(this.subpx[0] * k) / k));
    const suby = Math.min(1, Math.max(0, Math.round(this.subpx[1] * k) / k));
    // while sliding sub-pixel the final pass shows up to 1 px past the field: light 1 px more right/bottom
    const grow = subx || suby ? 1 : 0;
    const lit = [lx, ly, lw + grow, lh + grow] as const;
    const { nw, nh, bw, bh } = this;
    const limit = [nw + grow, nh + grow] as const;
    const scissorField = () => {
      gl.enable(gl.SCISSOR_TEST);
      gl.scissor(lit[0] * k, lit[1] * k, lit[2] * k, lit[3] * k);
    };
    if (Math.abs(sx - this.fluidScroll[0]) > CUT || Math.abs(sy - this.fluidScroll[1]) > CUT
      || Math.abs(sx - this.histScroll[0]) > CUT || Math.abs(sy - this.histScroll[1]) > CUT) this.resetHistory = true;

    // 0. decals (terrain space: screen px + scroll) and history resets
    this.decalT.bind();
    if (this.clearDecals) {
      gl.clearColor(0, 0, 0, 0);
      gl.clear(gl.COLOR_BUFFER_BIT);
      this.clearDecals = false;
    }
    if (this.decal.count) {
      gl.enable(gl.BLEND);
      gl.blendFuncSeparate(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA, gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
      this.pFx.use().v2('uNative', this.terrainW, this.terrainH).v2('uOffset', sx, sy).v2('uAtlas', aw, ah).f('uLin', 0).i('uAlb', 0);
      bindAtlas();
      this.decal.flush();
      gl.disable(gl.BLEND);
    }
    if (this.resetHistory) {
      for (const t of [...this.gi, ...this.refl]) {
        t.bind();
        gl.clearColor(0, 0, 0, 1);
        gl.clear(gl.COLOR_BUFFER_BIT);
      }
      this.fluid?.reset();
      this.rc?.clear();
      this.resetHistory = false;
      this.fluidScroll = [sx, sy];
      this.histScroll = [sx, sy];
      this.histRect = [...lit];
    }

    // 1. gbuffer
    this.gb.bind();
    gl.disable(gl.BLEND);
    gl.clearBufferfv(gl.COLOR, 0, [0, 0, 0, 0]);
    gl.clearBufferfv(gl.COLOR, 1, [0, 5 / 255, 0, 0]);
    gl.clearBufferfv(gl.COLOR, 2, [0, 0, 0, 0]);
    const co = this.cellOrigin ?? [lx + sx, ly + sy];
    this.pG.use().v2('uNative', bw, bh).v2('uAtlas', aw, ah).f('uTime', time).f('uWet', env.wet).f('uSnow', env.snow).f('uWaterK', env.water ?? 1)
      .v3('uGround', env.ground).f('uGrass', env.grass)
      .v2('uCellOrigin', co[0], co[1]).f('uHasCells', this.hasCells ? 1 : 0).v2('uCellSize', this.cellW, this.cellH)
      .v2('uScroll', sx, sy).v2('uTerrain', this.terrainW, this.terrainH)
      .i('uAlb', 0).i('uHS', 1).i('uEm', 2).i('uDecal', 3).i('uWave', 4).i('uCells', 5).i('uKinds', 6).i('uRail', 7)
      .f('uHasKinds', this.kindsSrc && this.hasCells ? 1 : 0).f('uHasRail', this.railSrc && this.hasCells ? 1 : 0)
      .v3('uBrickTint', env.brickTint ?? ONE3).v4('uBrickWash', ...(env.brickWash ?? ZERO4)).v3('uLeaf', env.leaf ?? ONE3).v4('uLeafWash', ...(env.leafWash ?? ZERO4)).f('uLeafOlive', env.leafOlive ?? 0);
    bindAtlas();
    this.tex(3, this.decalT.tex[0]);
    this.tex(4, this.fluid ? this.fluid.waveTex : this.black);
    this.tex(5, this.cells);
    this.tex(6, this.kinds);
    this.tex(7, this.railT);
    this.g.flush();
    // canopy: colour and glow blended over what's beneath; height and material written solid
    if (this.canopy.count) {
      gl.enable(gl.BLEND);
      gl.blendColor(0, 0, 0, CANOPY_ALPHA);
      gl.blendFunc(gl.CONSTANT_ALPHA, gl.ONE_MINUS_CONSTANT_ALPHA);
      gl.drawBuffers([gl.COLOR_ATTACHMENT0, gl.NONE, gl.COLOR_ATTACHMENT2]);
      this.canopy.flush(true);
      gl.disable(gl.BLEND);
      gl.drawBuffers([gl.NONE, gl.COLOR_ATTACHMENT1, gl.NONE]);
      this.canopy.flush();
      gl.drawBuffers([gl.COLOR_ATTACHMENT0, gl.COLOR_ATTACHMENT1, gl.COLOR_ATTACHMENT2]);
    }
    // Phase 4 bosses: shadows from the air multiply the albedo only (height, material and glow stay)
    if (this.shade.count) {
      gl.enable(gl.BLEND);
      gl.blendFuncSeparate(gl.DST_COLOR, gl.ZERO, gl.ZERO, gl.ONE);
      gl.drawBuffers([gl.COLOR_ATTACHMENT0, gl.NONE, gl.NONE]);
      this.shade.flush();
      gl.disable(gl.BLEND);
      gl.drawBuffers([gl.COLOR_ATTACHMENT0, gl.COLOR_ATTACHMENT1, gl.COLOR_ATTACHMENT2]);
    }
    this.gTop.flush();

    // 2. fluid: smoke, heat, fire and water ripples
    if (this.fluid) {
      // carry last frame's fields along with the camera before this frame's splats go in
      this.fluid.shift(sx - this.fluidScroll[0], sy - this.fluidScroll[1]);
      this.fluidScroll = [sx, sy];
      this.fluid.wind = this.wind;
      this.fluid.step(dt, this.gb.tex[1]);
    }
    const dye = this.fluid ? this.fluid.dyeTex : this.black;

    // 3. direct lighting into HDR
    const bindG = (p: Program) => {
      p.i('uGA', 0).i('uGX', 1).i('uGE', 2).v2('uNative', bw, bh).v2('uLimit', limit[0], limit[1]).f('uK', k).f('uPixel', pix)
        .v2('uScroll', sx, sy);
      this.gb.tex.forEach((t, i) => this.tex(i, t));
    };
    this.hdr.bind();
    gl.clearBufferfv(gl.COLOR, 0, [0, 0, 0, 1]);
    gl.clearBufferfv(gl.COLOR, 1, [0, 0, 0, 0]);
    this.bindSolo();
    this.pBase.use();
    bindG(this.pBase);
    this.pBase.f('uTime', time).v3('uSunCol', env.sunCol).v3('uSunDir', env.sunDir).f('uEmGain', this.emGain).f('uClouds', env.clouds).i('uDye', 3);
    this.tex(3, dye);
    this.fullscreen();

    scissorField();
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.ONE, gl.ONE);
    if (this.nLights) {
      this.hdr.bind();
      this.pLight.use();
      bindG(this.pLight);
      this.pLight.f('uFog', rtx ? env.fog : 0);
      gl.bindVertexArray(this.lightVao);
      gl.bindBuffer(gl.ARRAY_BUFFER, this.lightVbo);
      gl.bufferSubData(gl.ARRAY_BUFFER, 0, this.lights, 0, this.nLights * LF);
      gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, this.nLights);
      gl.bindVertexArray(null);
      this.bindSolo();
    }
    this.nLights = 0;
    this.pFx.use().v2('uNative', bw, bh).v2('uOffset', 0, 0).v2('uAtlas', aw, ah).f('uLin', 1).i('uAlb', 0);
    bindAtlas();
    this.fxAdd.flush(true);
    gl.disable(gl.SCISSOR_TEST);

    // glows at native res, for the cascades
    this.glowT.bind();
    gl.clearColor(0, 0, 0, 1);
    gl.clear(gl.COLOR_BUFFER_BIT);
    this.fxAdd.flush();
    gl.disable(gl.BLEND);

    // 4. radiance cascades (bounce light), ray-traced AO and reflections, all native res
    const cur = this.frame & 1;
    const prev = cur ^ 1;
    if (rtx && this.rc) {
      // last frame's GI / reflections / bounce sit (dx, dy) px further along if the camera moved
      const hx = sx - this.histScroll[0];
      const hy = sy - this.histScroll[1];
      const hr = this.histRect;
      this.rc.histOff = [hx, hy];
      this.rc.histRect = hr;
      this.rc.update(this.hdr.tex[0], k, this.gb.tex[0], this.gb.tex[1], this.glowT.tex[0], dye);

      this.gi[cur].bind();
      this.pGI.use();
      bindG(this.pGI);
      this.pGI.i('uHist', 3).f('uFrame', this.frame).f('uBlend', 0.15).v4('uField', ...lit)
        .v2('uHistOff', hx, hy).v4('uHistRect', hr[0], hr[1], hr[2], hr[3]);
      this.tex(3, this.gi[prev].tex[0]);
      this.fullscreen();

      this.refl[cur].bind();
      this.pRefl.use();
      bindG(this.pRefl);
      this.pRefl.i('uRad', 3).i('uHist', 4).f('uFrame', this.frame).f('uBlend', 0.3).v3('uSky', env.sky).v4('uField', ...lit)
        .v2('uHistOff', hx, hy).v4('uHistRect', hr[0], hr[1], hr[2], hr[3]);
      this.tex(3, this.rc.scene.tex[0]);
      this.tex(4, this.refl[prev].tex[0]);
      this.fullscreen();
      this.histScroll = [sx, sy];
      this.histRect = [...lit];
    }

    // 5. ambient + bounce + reflections
    this.bindSolo();
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.ONE, gl.ONE);
    this.pComp.use();
    bindG(this.pComp);
    this.pComp.i('uGI', 3).i('uRefl', 4).i('uRC', 5).v3('uAmbient', env.ambient).f('uGIStr', this.giStr).f('uRTX', rtx ? 1 : 0);
    this.tex(3, this.gi[cur].tex[0]);
    this.tex(4, this.refl[cur].tex[0]);
    this.tex(5, this.rc ? this.rc.fluence.tex[0] : this.black);
    this.fullscreen();

    // 6. fluid smoke, lit
    scissorField();
    if (this.fluid) {
      gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
      this.pSmoke.use().i('uDye', 0).i('uSmokeL', 1).v2('uNative', bw, bh).f('uK', k).f('uPixel', pix)
        .v3('uAmbient', env.ambient).v3('uSunCol', env.sunCol);
      this.tex(0, dye);
      this.tex(1, this.hdr.tex[1]);
      this.fullscreen();
    }
    this.pFx.use().v2('uNative', bw, bh).v2('uOffset', 0, 0).v2('uAtlas', aw, ah).f('uLin', 1).i('uAlb', 0);
    bindAtlas();
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
    this.fxAlpha.flush();
    gl.disable(gl.SCISSOR_TEST);
    this.overlay.flush();
    gl.disable(gl.BLEND);

    // 7. bloom
    const b = this.bloom;
    b[0].bind();
    this.pPre.use().i('uSrc', 0).v2('uTexel', 1 / this.hdr.w, 1 / this.hdr.h).f('uThreshold', 1.0).v2('uScale', nw / bw, nh / bh);
    this.tex(0, this.hdr.tex[0]);
    this.fullscreen();
    this.pDown.use().i('uSrc', 0);
    for (let i = 1; i < b.length; i++) {
      b[i].bind();
      this.pDown.v2('uTexel', 1 / b[i - 1].w, 1 / b[i - 1].h);
      this.tex(0, b[i - 1].tex[0]);
      this.fullscreen();
    }
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.ONE, gl.ONE);
    this.pUp.use().i('uSrc', 0);
    for (let i = b.length - 2; i >= 0; i--) {
      b[i].bind();
      this.pUp.v2('uTexel', 1 / b[i + 1].w, 1 / b[i + 1].h);
      this.tex(0, b[i + 1].tex[0]);
      this.fullscreen();
    }
    gl.disable(gl.BLEND);

    // 7b. the top overlay (premultiplied, linear) at native res, composited after grading by the final pass
    const ovTop = this.overlayTop.count > 0;
    if (ovTop) {
      this.ovTop.bind();
      gl.clearColor(0, 0, 0, 0);
      gl.clear(gl.COLOR_BUFFER_BIT);
      gl.enable(gl.BLEND);
      gl.blendFuncSeparate(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA, gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
      this.pFx.use().v2('uNative', bw, bh).v2('uOffset', 0, 0).v2('uAtlas', aw, ah).f('uLin', 1).i('uAlb', 0);
      bindAtlas();
      this.overlayTop.flush();
      gl.disable(gl.BLEND);
    }

    // 8. final
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, this.canvas.width, this.canvas.height);
    const n = Math.min(8, this.shocks.length);
    for (let i = 0; i < n; i++) {
      const s = this.shocks[i];
      this.shockArr.set([s.x, s.y, s.r, s.s], i * 4);
    }
    this.pFinal.use()
      .i('uHDR', 0).i('uBloom', 1).i('uGlow', 2).i('uDye', 3).i('uOv', 4)
      .v2('uCanvas', this.canvas.width, this.canvas.height)
      .v4('uView', this.view[0], this.view[1], this.view[2], this.view[3])
      .v4('uField', ...field)
      .v2('uNative', nw, nh).v2('uBuf', bw, bh).v2('uLitMax', limit[0] - 0.5 / k, limit[1] - 0.5 / k).v2('uSub', subx, suby).v2('uScroll', sx, sy).f('uTime', time).f('uBloomStr', this.bloomStr).f('uExposure', this.exposure)
      .f('uCRT', this.crt ? 1 : 0).f('uAberr', this.aberr).v3('uFlash', this.flash).v2('uShake', this.shake[0], this.shake[1])
      .f('uFeather', this.feather).v3('uGradeLo', env.gradeLo).v3('uGradeHi', env.gradeHi).f('uSat', env.sat).v3('uBackdrop', env.backdrop)
      .f('uPixel', pix).f('uHaze', this.haze).v3('uHorizon', env.horizon ?? [0, 0, 0])
      .v4a('uShock', this.shockArr).i('uShockN', n);
    this.tex(0, this.hdr.tex[0]);
    this.tex(1, b[0].tex[0]);
    this.tex(2, b[Math.min(3, b.length - 1)].tex[0]);
    this.tex(3, dye);
    this.tex(4, ovTop ? this.ovTop.tex[0] : this.black);
    this.fullscreen();
    gl.bindVertexArray(null);

    this.g.clear();
    this.canopy.clear();
    this.gTop.clear();
    this.shade.clear();
    this.top = false;
    this.fxAdd.clear();
    this.fxAlpha.clear();
    this.overlay.clear();
    this.overlayTop.clear();
    this.decal.clear();
    this.hasCells = false;
  }
}

export const WHITE: [number, number, number] = [1, 1, 1];
