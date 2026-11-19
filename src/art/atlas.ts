export interface Spr {
  x: number;
  y: number;
  w: number;
  h: number;
}

/**
 * A small pixel-art canvas with three layers:
 * albedo (rgb + opacity), surface (height, spec, tint mask) and emissive.
 */
export class PixelArt {
  alb: Uint8Array;
  hs: Uint8Array;
  em: Uint8Array;

  constructor(public w: number, public h: number) {
    this.alb = new Uint8Array(w * h * 4);
    this.hs = new Uint8Array(w * h * 4);
    this.em = new Uint8Array(w * h * 4);
  }

  set(x: number, y: number, col: number, height: number, spec = 0.1, tint = 0, em = 0): void {
    if (x < 0 || y < 0 || x >= this.w || y >= this.h) return;
    const i = (y * this.w + x) * 4;
    this.alb[i] = (col >> 16) & 255;
    this.alb[i + 1] = (col >> 8) & 255;
    this.alb[i + 2] = col & 255;
    this.alb[i + 3] = 255;
    this.hs[i] = Math.round(Math.max(0, Math.min(1, height)) * 255);
    this.hs[i + 1] = Math.round(Math.max(0, Math.min(1, spec)) * 255);
    this.hs[i + 2] = Math.round(Math.max(0, Math.min(1, tint)) * 255);
    this.hs[i + 3] = 255;
    this.em[i] = (em >> 16) & 255;
    this.em[i + 1] = (em >> 8) & 255;
    this.em[i + 2] = em & 255;
    this.em[i + 3] = 255;
  }

  has(x: number, y: number): boolean {
    if (x < 0 || y < 0 || x >= this.w || y >= this.h) return false;
    return this.alb[(y * this.w + x) * 4 + 3] > 0;
  }

  rect(x: number, y: number, w: number, h: number, col: number, height: number, spec = 0.1, tint = 0, em = 0): void {
    for (let j = y; j < y + h; j++) for (let i = x; i < x + w; i++) this.set(i, j, col, height, spec, tint, em);
  }
}

export class Atlas {
  W = 512;
  H = 512;
  alb = new Uint8Array(this.W * this.H * 4);
  hs = new Uint8Array(this.W * this.H * 4);
  em = new Uint8Array(this.W * this.H * 4);
  S: Record<string, Spr> = {};
  private sx = 1;
  private sy = 1;
  private shelf = 0;

  add(name: string, a: PixelArt): Spr {
    if (this.sx + a.w + 1 > this.W) {
      this.sx = 1;
      this.sy += this.shelf + 1;
      this.shelf = 0;
    }
    if (this.sy + a.h + 1 > this.H) throw new Error('atlas full');
    const s: Spr = { x: this.sx, y: this.sy, w: a.w, h: a.h };
    for (let y = 0; y < a.h; y++) {
      const src = y * a.w * 4;
      const dst = ((s.y + y) * this.W + s.x) * 4;
      this.alb.set(a.alb.subarray(src, src + a.w * 4), dst);
      this.hs.set(a.hs.subarray(src, src + a.w * 4), dst);
      this.em.set(a.em.subarray(src, src + a.w * 4), dst);
    }
    this.sx += a.w + 1;
    this.shelf = Math.max(this.shelf, a.h);
    this.S[name] = s;
    return s;
  }
}
