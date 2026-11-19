import type { GL } from './glutil';

const FPV = 12; // floats per vertex: pos2 uv2 color4 param4
const MAX_QUADS = 16000;

let sharedIbo: WebGLBuffer | null = null;

function indexBuffer(gl: GL): WebGLBuffer {
  if (sharedIbo) return sharedIbo;
  const idx = new Uint16Array(MAX_QUADS * 6);
  for (let i = 0; i < MAX_QUADS; i++) {
    const v = i * 4;
    idx.set([v, v + 1, v + 2, v, v + 2, v + 3], i * 6);
  }
  sharedIbo = gl.createBuffer()!;
  gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, sharedIbo);
  gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, idx, gl.STATIC_DRAW);
  return sharedIbo;
}

/**
 * Collects textured quads in native screen pixels and draws them in one call.
 * `param` meaning depends on the shader: gbuffer = (material, heightBias, emissive, whiten),
 * fx = (mode, intensity, -, -).
 */
export class Batch {
  data = new Float32Array(MAX_QUADS * 4 * FPV);
  count = 0;
  vao: WebGLVertexArrayObject;
  vbo: WebGLBuffer;

  constructor(private gl: GL) {
    this.vao = gl.createVertexArray()!;
    gl.bindVertexArray(this.vao);
    this.vbo = gl.createBuffer()!;
    gl.bindBuffer(gl.ARRAY_BUFFER, this.vbo);
    gl.bufferData(gl.ARRAY_BUFFER, this.data.byteLength, gl.DYNAMIC_DRAW);
    const stride = FPV * 4;
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, stride, 0);
    gl.enableVertexAttribArray(1);
    gl.vertexAttribPointer(1, 2, gl.FLOAT, false, stride, 8);
    gl.enableVertexAttribArray(2);
    gl.vertexAttribPointer(2, 4, gl.FLOAT, false, stride, 16);
    gl.enableVertexAttribArray(3);
    gl.vertexAttribPointer(3, 4, gl.FLOAT, false, stride, 32);
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, indexBuffer(gl));
    gl.bindVertexArray(null);
  }

  /**
   * Screen rect (x0,y0)-(x1,y1), atlas rect (u0,v0)-(u1,v1). `rot` = quarter turns clockwise,
   * applied to the image (sprites are authored facing up).
   */
  quad(
    x0: number, y0: number, x1: number, y1: number,
    u0: number, v0: number, u1: number, v1: number,
    rot: number,
    r: number, g: number, b: number, a: number,
    p0: number, p1: number, p2: number, p3: number,
  ): void {
    if (this.count >= MAX_QUADS) return;
    const d = this.data;
    let o = this.count * 4 * FPV;
    const us = [u0, u1, u1, u0];
    const vs = [v0, v0, v1, v1];
    const xs = [x0, x1, x1, x0];
    const ys = [y0, y0, y1, y1];
    for (let i = 0; i < 4; i++) {
      const k = (i - rot + 8) & 3;
      d[o++] = xs[i];
      d[o++] = ys[i];
      d[o++] = us[k];
      d[o++] = vs[k];
      d[o++] = r;
      d[o++] = g;
      d[o++] = b;
      d[o++] = a;
      d[o++] = p0;
      d[o++] = p1;
      d[o++] = p2;
      d[o++] = p3;
    }
    this.count++;
  }

  /**
   * A w x h quad centred on (cx, cy), turned `ang` radians clockwise (screen y down), atlas rect (u0,v0)-(u1,v1)
   * authored facing up. Every target samples the atlas with NEAREST, so the turned image stays hard-edged pixels
   * at native resolution; the height/emissive layers share the uv, so they turn with it.
   */
  quadRot(
    cx: number, cy: number, w: number, h: number, ang: number,
    u0: number, v0: number, u1: number, v1: number,
    r: number, g: number, b: number, a: number,
    p0: number, p1: number, p2: number, p3: number,
  ): void {
    if (this.count >= MAX_QUADS) return;
    const d = this.data;
    let o = this.count * 4 * FPV;
    const c = Math.cos(ang);
    const s = Math.sin(ang);
    const hw = w / 2;
    const hh = h / 2;
    for (let i = 0; i < 4; i++) {
      const lx = i === 0 || i === 3 ? -hw : hw;
      const ly = i < 2 ? -hh : hh;
      d[o++] = cx + lx * c - ly * s;
      d[o++] = cy + lx * s + ly * c;
      d[o++] = i === 0 || i === 3 ? u0 : u1;
      d[o++] = i < 2 ? v0 : v1;
      d[o++] = r;
      d[o++] = g;
      d[o++] = b;
      d[o++] = a;
      d[o++] = p0;
      d[o++] = p1;
      d[o++] = p2;
      d[o++] = p3;
    }
    this.count++;
  }

  /** Draw everything queued; keep = leave the quads queued for another target. */
  flush(keep = false): void {
    if (!this.count) return;
    const gl = this.gl;
    gl.bindVertexArray(this.vao);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.vbo);
    gl.bufferSubData(gl.ARRAY_BUFFER, 0, this.data, 0, this.count * 4 * FPV);
    gl.drawElements(gl.TRIANGLES, this.count * 6, gl.UNSIGNED_SHORT, 0);
    gl.bindVertexArray(null);
    if (!keep) this.count = 0;
  }

  clear(): void {
    this.count = 0;
  }
}
