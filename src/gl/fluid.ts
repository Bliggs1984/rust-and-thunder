// Screen-sized Navier-Stokes fluid (stable-fluids style) for smoke / heat / fire, plus a wave
// equation for water ripples. Everything runs at native resolution on the GPU. Walls come from the
// gbuffer heights, so smoke flows around bricks and through trees.
import { Batch } from './batch';
import { Program, Target, type GL, type TexSpec } from './glutil';
import { FULL_VS, HEAD, SPRITE_VS } from './shaders';

const NATIVE = `
uniform vec2 uSize;
uniform sampler2D uGX;
bool solid(ivec2 p){
  if (p.x < 0 || p.y < 0 || p.x >= int(uSize.x) || p.y >= int(uSize.y)) return true;
  vec4 X = texelFetch(uGX, p, 0);
  int m = int(X.g * 255.0 + 0.5);
  if (m == 5) return true;
  return X.r * 10.0 > 2.2 && m != 0 && m != 3 && m != 4 && m != 6;
}
`;

const SPLAT_FS = `${HEAD}
in vec2 vUV; in vec4 vColor; in vec4 vParam; in vec2 vWorld;
out vec4 o;
void main(){
  float r2 = dot(vUV, vUV);
  if (r2 > 1.0) discard;
  o = vColor * exp(-r2 * 3.0) * (1.0 - r2);
}`;

const ADVECT_FS = `${HEAD}${NATIVE}
uniform sampler2D uVel; uniform sampler2D uSrc;
uniform float uDt; uniform vec4 uDecay; uniform vec2 uWind; uniform float uWindMix;
out vec4 o;
void main(){
  vec2 p = gl_FragCoord.xy;
  if (solid(ivec2(p))) { o = vec4(0.0); return; }
  vec2 v = texture(uVel, p / uSize).xy;
  vec4 s = texture(uSrc, (p - uDt * v) / uSize) * uDecay;
  if (uWindMix > 0.0) s.xy = mix(s.xy, uWind, uWindMix);
  o = s;
}`;

// Camera moved: carry the field along with the world. New texel p = old texel p + uOff; what
// scrolls in from beyond the edge starts empty.
const SHIFT_FS = `${HEAD}
uniform sampler2D uSrc; uniform vec2 uSize; uniform vec2 uOff;
out vec4 o;
void main(){
  ivec2 q = ivec2(gl_FragCoord.xy) + ivec2(uOff);
  o = q.x < 0 || q.y < 0 || q.x >= int(uSize.x) || q.y >= int(uSize.y) ? vec4(0.0) : texelFetch(uSrc, q, 0);
}`;

const CURL_FS =`${HEAD}${NATIVE}
uniform sampler2D uVel;
out vec4 o;
vec2 V(ivec2 p){ return texelFetch(uVel, clamp(p, ivec2(0), ivec2(uSize) - 1), 0).xy; }
void main(){
  ivec2 p = ivec2(gl_FragCoord.xy);
  float c = (V(p + ivec2(1, 0)).y - V(p - ivec2(1, 0)).y) - (V(p + ivec2(0, 1)).x - V(p - ivec2(0, 1)).x);
  o = vec4(0.5 * c, 0.0, 0.0, 1.0);
}`;

const VORT_FS = `${HEAD}${NATIVE}
uniform sampler2D uVel; uniform sampler2D uCurl; uniform float uDt; uniform float uAmount;
out vec4 o;
float C(ivec2 p){ return texelFetch(uCurl, clamp(p, ivec2(0), ivec2(uSize) - 1), 0).x; }
void main(){
  ivec2 p = ivec2(gl_FragCoord.xy);
  vec2 v = texelFetch(uVel, p, 0).xy;
  vec2 f = 0.5 * vec2(abs(C(p + ivec2(0, 1))) - abs(C(p - ivec2(0, 1))), abs(C(p + ivec2(1, 0))) - abs(C(p - ivec2(1, 0))));
  f /= length(f) + 1e-4;
  f *= uAmount * C(p) * vec2(1.0, -1.0);
  o = vec4(v + f * uDt, 0.0, 1.0);
}`;

const DIV_FS = `${HEAD}${NATIVE}
uniform sampler2D uVel;
out vec4 o;
void main(){
  ivec2 p = ivec2(gl_FragCoord.xy);
  vec2 c = texelFetch(uVel, p, 0).xy;
  float L = solid(p - ivec2(1, 0)) ? -c.x : texelFetch(uVel, p - ivec2(1, 0), 0).x;
  float R = solid(p + ivec2(1, 0)) ? -c.x : texelFetch(uVel, p + ivec2(1, 0), 0).x;
  float B = solid(p - ivec2(0, 1)) ? -c.y : texelFetch(uVel, p - ivec2(0, 1), 0).y;
  float T = solid(p + ivec2(0, 1)) ? -c.y : texelFetch(uVel, p + ivec2(0, 1), 0).y;
  o = vec4(0.5 * (R - L + T - B), 0.0, 0.0, 1.0);
}`;

const PRESSURE_FS = `${HEAD}${NATIVE}
uniform sampler2D uP; uniform sampler2D uDiv;
out vec4 o;
float P(ivec2 q, float c){ return solid(q) ? c : texelFetch(uP, q, 0).x; }
void main(){
  ivec2 p = ivec2(gl_FragCoord.xy);
  float c = texelFetch(uP, p, 0).x;
  float s = P(p - ivec2(1, 0), c) + P(p + ivec2(1, 0), c) + P(p - ivec2(0, 1), c) + P(p + ivec2(0, 1), c);
  o = vec4((s - texelFetch(uDiv, p, 0).x) * 0.25, 0.0, 0.0, 1.0);
}`;

const GRAD_FS = `${HEAD}${NATIVE}
uniform sampler2D uP; uniform sampler2D uVel;
out vec4 o;
float P(ivec2 q, float c){ return solid(q) ? c : texelFetch(uP, q, 0).x; }
void main(){
  ivec2 p = ivec2(gl_FragCoord.xy);
  if (solid(p)) { o = vec4(0.0); return; }
  float c = texelFetch(uP, p, 0).x;
  vec2 g = 0.5 * vec2(P(p + ivec2(1, 0), c) - P(p - ivec2(1, 0), c), P(p + ivec2(0, 1), c) - P(p - ivec2(0, 1), c));
  o = vec4(texelFetch(uVel, p, 0).xy - g, 0.0, 1.0);
}`;

const WAVE_FS = `${HEAD}${NATIVE}
uniform sampler2D uW;
out vec4 o;
float W(ivec2 q){ return texelFetch(uW, clamp(q, ivec2(0), ivec2(uSize) - 1), 0).x; }
void main(){
  ivec2 p = ivec2(gl_FragCoord.xy);
  vec4 X = texelFetch(uGX, p, 0);
  if (int(X.g * 255.0 + 0.5) != 3) { o = vec4(0.0); return; }
  vec2 hw = texelFetch(uW, p, 0).xy;
  // 9-point Laplacian: rings spread round instead of as a diamond
  float edge = W(p + ivec2(1, 0)) + W(p - ivec2(1, 0)) + W(p + ivec2(0, 1)) + W(p - ivec2(0, 1));
  float diag = W(p + ivec2(1, 1)) + W(p - ivec2(1, 1)) + W(p + ivec2(1, -1)) + W(p - ivec2(1, -1));
  float lap = (4.0 * edge + diag - 20.0 * hw.x) / 6.0;
  float n = (2.0 * hw.x - hw.y + 0.22 * lap) * 0.993;
  o = vec4(clamp(n, -2.0, 2.0), hw.x, 0.0, 1.0);
}`;

export class Fluid {
  velSplats: Batch;
  dyeSplats: Batch;
  waveSplats: Batch;
  wind: [number, number] = [0, 0];
  private vel: Target[] = [];
  private dye: Target[] = [];
  private prs: Target[] = [];
  private wave: Target[] = [];
  private div!: Target;
  private curl!: Target;
  private pSplat: Program;
  private pAdvect: Program;
  private pCurl: Program;
  private pVort: Program;
  private pDiv: Program;
  private pPress: Program;
  private pGrad: Program;
  private pWave: Program;
  private pShift: Program;
  private emptyVao: WebGLVertexArrayObject;

  constructor(private gl: GL, private W: number, private H: number, private spec: TexSpec) {
    this.alloc();
    this.velSplats = new Batch(gl);
    this.dyeSplats = new Batch(gl);
    this.waveSplats = new Batch(gl);
    this.pSplat = new Program(gl, SPRITE_VS, SPLAT_FS, 'splat');
    this.pAdvect = new Program(gl, FULL_VS, ADVECT_FS, 'advect');
    this.pCurl = new Program(gl, FULL_VS, CURL_FS, 'curl');
    this.pVort = new Program(gl, FULL_VS, VORT_FS, 'vorticity');
    this.pDiv = new Program(gl, FULL_VS, DIV_FS, 'divergence');
    this.pPress = new Program(gl, FULL_VS, PRESSURE_FS, 'pressure');
    this.pGrad = new Program(gl, FULL_VS, GRAD_FS, 'gradient');
    this.pWave = new Program(gl, FULL_VS, WAVE_FS, 'wave');
    this.pShift = new Program(gl, FULL_VS, SHIFT_FS, 'fluid-shift');
    this.emptyVao = gl.createVertexArray()!;
    this.reset();
  }

  private alloc(): void {
    const T = () => new Target(this.gl, this.W, this.H, [this.spec]);
    this.vel = [T(), T()];
    this.dye = [T(), T()];
    this.prs = [T(), T()];
    this.wave = [T(), T()];
    this.div = T();
    this.curl = T();
  }

  /** New field size (the native screen changed): all fields start empty. */
  resize(W: number, H: number): void {
    if (W === this.W && H === this.H) return;
    for (const t of [...this.vel, ...this.dye, ...this.prs, ...this.wave, this.div, this.curl]) t.dispose();
    this.W = W;
    this.H = H;
    this.alloc();
    this.reset();
  }

  /** Current dye: r = smoke, g = heat, b = fire. */
  get dyeTex(): WebGLTexture { return this.dye[0].tex[0]; }
  /** Current water height (r). */
  get waveTex(): WebGLTexture { return this.wave[0].tex[0]; }

  /** Debug: read one texel (r, g, b, a) of the dye or wave field. */
  probe(which: 'dye' | 'wave' | 'vel', x: number, y: number): number[] {
    const gl = this.gl;
    const t = which === 'dye' ? this.dye[0] : which === 'wave' ? this.wave[0] : this.vel[0];
    gl.bindFramebuffer(gl.FRAMEBUFFER, t.fbo);
    const out = new Float32Array(4);
    gl.readPixels(Math.floor(x), Math.floor(y), 1, 1, gl.RGBA, gl.FLOAT, out);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    return [...out].map((v) => +v.toFixed(3));
  }

  reset(): void {
    const gl = this.gl;
    for (const t of [...this.vel, ...this.dye, ...this.prs, ...this.wave, this.div, this.curl]) {
      t.bind();
      gl.clearColor(0, 0, 0, 0);
      gl.clear(gl.COLOR_BUFFER_BIT);
    }
  }

  velSplat(x: number, y: number, r: number, vx: number, vy: number): void {
    this.velSplats.quad(x - r, y - r, x + r, y + r, -1, -1, 1, 1, 0, vx, vy, 0, 0, 0, 0, 0, 0);
  }

  dyeSplat(x: number, y: number, r: number, smoke: number, heat: number, fire: number): void {
    this.dyeSplats.quad(x - r, y - r, x + r, y + r, -1, -1, 1, 1, 0, smoke, heat, fire, 0, 0, 0, 0, 0);
  }

  waveSplat(x: number, y: number, r: number, amount: number): void {
    this.waveSplats.quad(x - r, y - r, x + r, y + r, -1, -1, 1, 1, 0, amount, 0, 0, 0, 0, 0, 0, 0);
  }

  private swap(a: Target[]): void {
    const t = a[0];
    a[0] = a[1];
    a[1] = t;
  }

  private run(p: Program, out: Target, tex: [string, WebGLTexture][]): void {
    const gl = this.gl;
    out.bind();
    p.use();
    tex.forEach(([name, t], i) => {
      gl.activeTexture(gl.TEXTURE0 + i);
      gl.bindTexture(gl.TEXTURE_2D, t);
      p.i(name, i);
    });
    gl.bindVertexArray(this.emptyVao);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
  }

  private splats(b: Batch, into: Target): void {
    if (!b.count) return;
    const gl = this.gl;
    into.bind();
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.ONE, gl.ONE);
    this.pSplat.use().v2('uNative', this.W, this.H);
    b.flush();
    gl.disable(gl.BLEND);
  }

  /**
   * The camera scrolled by (dx, dy) native px since the last step: move velocity, pressure, dye and
   * both wave layers so they stay on their spot in the world. Call before the splats of the new frame.
   */
  shift(dx: number, dy: number): void {
    if (!dx && !dy) return;
    const gl = this.gl;
    gl.disable(gl.BLEND);
    this.pShift.use().v2('uSize', this.W, this.H).v2('uOff', dx, dy);
    for (const a of [this.vel, this.dye, this.prs, this.wave]) {
      this.run(this.pShift, a[1], [['uSrc', a[0].tex[0]]]);
      this.swap(a);
    }
    gl.bindVertexArray(null);
  }

  /** One simulation step. gx = gbuffer aux texture (heights + materials) for walls and water. */
  step(dt: number, gx: WebGLTexture): void {
    const gl = this.gl;
    gl.disable(gl.BLEND);
    const size = (p: Program) => p.use().v2('uSize', this.W, this.H);
    [this.pAdvect, this.pCurl, this.pVort, this.pDiv, this.pPress, this.pGrad, this.pWave].forEach(size);

    this.splats(this.velSplats, this.vel[0]);
    this.run(this.pCurl, this.curl, [['uVel', this.vel[0].tex[0]], ['uGX', gx]]);
    this.pVort.use().f('uDt', dt).f('uAmount', 22);
    this.run(this.pVort, this.vel[1], [['uVel', this.vel[0].tex[0]], ['uCurl', this.curl.tex[0]], ['uGX', gx]]);
    this.swap(this.vel);
    this.run(this.pDiv, this.div, [['uVel', this.vel[0].tex[0]], ['uGX', gx]]);
    for (let i = 0; i < 18; i++) {
      this.run(this.pPress, this.prs[1], [['uP', this.prs[0].tex[0]], ['uDiv', this.div.tex[0]], ['uGX', gx]]);
      this.swap(this.prs);
    }
    this.run(this.pGrad, this.vel[1], [['uP', this.prs[0].tex[0]], ['uVel', this.vel[0].tex[0]], ['uGX', gx]]);
    this.swap(this.vel);
    const vd = Math.exp(-0.6 * dt);
    this.pAdvect.use().f('uDt', dt).v4('uDecay', vd, vd, 1, 1).v2('uWind', this.wind[0], this.wind[1]).f('uWindMix', Math.min(1, dt * 0.8));
    this.run(this.pAdvect, this.vel[1], [['uVel', this.vel[0].tex[0]], ['uSrc', this.vel[0].tex[0]], ['uGX', gx]]);
    this.swap(this.vel);

    this.splats(this.dyeSplats, this.dye[0]);
    this.pAdvect.use().f('uDt', dt).v4('uDecay', Math.exp(-0.32 * dt), Math.exp(-1.1 * dt), Math.exp(-3.2 * dt), 1).f('uWindMix', 0);
    this.run(this.pAdvect, this.dye[1], [['uVel', this.vel[0].tex[0]], ['uSrc', this.dye[0].tex[0]], ['uGX', gx]]);
    this.swap(this.dye);

    this.splats(this.waveSplats, this.wave[0]);
    const n = Math.max(1, Math.min(4, Math.round(dt * 120)));
    for (let i = 0; i < n; i++) {
      this.run(this.pWave, this.wave[1], [['uW', this.wave[0].tex[0]], ['uGX', gx]]);
      this.swap(this.wave);
    }
    gl.bindVertexArray(null);
  }
}
