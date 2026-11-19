export type GL = WebGL2RenderingContext;

function numbered(src: string): string {
  return src
    .split('\n')
    .map((l, i) => `${String(i + 1).padStart(3)}: ${l}`)
    .join('\n');
}

export class Program {
  prog: WebGLProgram;
  u: Record<string, WebGLUniformLocation> = {};

  constructor(public gl: GL, vs: string, fs: string, name: string) {
    const mk = (type: number, src: string) => {
      const s = gl.createShader(type)!;
      gl.shaderSource(s, src);
      gl.compileShader(s);
      if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) {
        const kind = type === gl.VERTEX_SHADER ? 'vertex' : 'fragment';
        throw new Error(`${name} ${kind} shader failed:\n${gl.getShaderInfoLog(s)}\n${numbered(src)}`);
      }
      return s;
    };
    const p = gl.createProgram()!;
    gl.attachShader(p, mk(gl.VERTEX_SHADER, vs));
    gl.attachShader(p, mk(gl.FRAGMENT_SHADER, fs));
    gl.linkProgram(p);
    if (!gl.getProgramParameter(p, gl.LINK_STATUS)) {
      throw new Error(`${name} link failed: ${gl.getProgramInfoLog(p)}`);
    }
    this.prog = p;
    const n = gl.getProgramParameter(p, gl.ACTIVE_UNIFORMS) as number;
    for (let i = 0; i < n; i++) {
      const info = gl.getActiveUniform(p, i)!;
      this.u[info.name.replace(/\[0\]$/, '')] = gl.getUniformLocation(p, info.name)!;
    }
  }

  use(): this {
    this.gl.useProgram(this.prog);
    return this;
  }
  i(n: string, v: number): this {
    const l = this.u[n];
    if (l) this.gl.uniform1i(l, v);
    return this;
  }
  f(n: string, v: number): this {
    const l = this.u[n];
    if (l) this.gl.uniform1f(l, v);
    return this;
  }
  v2(n: string, x: number, y: number): this {
    const l = this.u[n];
    if (l) this.gl.uniform2f(l, x, y);
    return this;
  }
  v3(n: string, v: ArrayLike<number>): this {
    const l = this.u[n];
    if (l) this.gl.uniform3f(l, v[0], v[1], v[2]);
    return this;
  }
  v4(n: string, x: number, y: number, z: number, w: number): this {
    const l = this.u[n];
    if (l) this.gl.uniform4f(l, x, y, z, w);
    return this;
  }
  v4a(n: string, arr: Float32Array): this {
    const l = this.u[n];
    if (l) this.gl.uniform4fv(l, arr);
    return this;
  }
}

export interface TexSpec {
  internal: number;
  format: number;
  type: number;
  filter: number;
}

export function makeTex(gl: GL, w: number, h: number, s: TexSpec, data: ArrayBufferView | null = null): WebGLTexture {
  const t = gl.createTexture()!;
  gl.bindTexture(gl.TEXTURE_2D, t);
  gl.texImage2D(gl.TEXTURE_2D, 0, s.internal, w, h, 0, s.format, s.type, data);
  const linear = s.filter === gl.LINEAR || s.filter === gl.LINEAR_MIPMAP_LINEAR || s.filter === gl.LINEAR_MIPMAP_NEAREST;
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, s.filter);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, linear ? gl.LINEAR : gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  return t;
}

/** A framebuffer with one or more colour attachments. */
export class Target {
  fbo: WebGLFramebuffer;
  tex: WebGLTexture[] = [];

  constructor(public gl: GL, public w: number, public h: number, specs: TexSpec[]) {
    this.fbo = gl.createFramebuffer()!;
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.fbo);
    const bufs: number[] = [];
    specs.forEach((s, i) => {
      const t = makeTex(gl, w, h, s);
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0 + i, gl.TEXTURE_2D, t, 0);
      this.tex.push(t);
      bufs.push(gl.COLOR_ATTACHMENT0 + i);
    });
    gl.drawBuffers(bufs);
    const st = gl.checkFramebufferStatus(gl.FRAMEBUFFER);
    if (st !== gl.FRAMEBUFFER_COMPLETE) throw new Error(`Framebuffer incomplete (${st.toString(16)})`);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  }

  bind(): void {
    this.gl.bindFramebuffer(this.gl.FRAMEBUFFER, this.fbo);
    this.gl.viewport(0, 0, this.w, this.h);
  }

  dispose(): void {
    this.tex.forEach((t) => this.gl.deleteTexture(t));
    this.gl.deleteFramebuffer(this.fbo);
  }
}
