// Radiance cascades: noise-free 2D global illumination. A "scene" texture holds what each native
// pixel emits and how much it blocks (walls opaque, trees and smoke partly, open ground barely).
// Cascade i has probes every 2^i px and 4^(i+1) ray directions covering a distance band 4x longer than
// the one below; cascades are merged from the top down, so every pixel gathers light from every glowing
// or lit thing around it with correct soft shadows, in one frame and without random sampling.
import { Program, Target, type GL, type TexSpec } from './glutil';
import { FULL_VS, HEAD, HIST } from './shaders';

export const CASCADES = 5;

const SCENE_FS = `${HEAD}
uniform sampler2D uHDR; uniform sampler2D uGA; uniform sampler2D uGX; uniform sampler2D uGlow;
uniform sampler2D uDye; uniform sampler2D uPrev;
uniform vec2 uNative; uniform float uK; uniform float uBounce;
${HIST}
layout(location=0) out vec4 oA; // rgb = radiance of this pixel, a = extinction per px
layout(location=1) out vec4 oB; // rgb = light emitted into the air per px (glows, fire)
void main(){
  ivec2 ip = ivec2(gl_FragCoord.xy);
  vec2 c = (vec2(ip) + 0.5) / uNative;
  vec2 tx = 1.0 / (uNative * uK);
  float q = uK * 0.25;
  vec3 rad = (texture(uHDR, c + tx * vec2(-q, -q)).rgb + texture(uHDR, c + tx * vec2(q, -q)).rgb
            + texture(uHDR, c + tx * vec2(-q, q)).rgb + texture(uHDR, c + tx * vec2(q, q)).rgb) * 0.25;
  vec4 X = texelFetch(uGX, ip, 0);
  int m = int(X.g * 255.0 + 0.5);
  vec3 alb = pow(texelFetch(uGA, ip, 0).rgb, vec3(2.2));
  ivec2 hp;
  if (histAt(ip, hp)) rad += alb * texelFetch(uPrev, hp, 0).rgb * uBounce;
  float h = X.r * 10.0;
  float sigma = 0.0;
  if (m == 5) { sigma = 60.0; rad = vec3(0.0); }
  else if (m == 6) { sigma = 0.55; rad *= 0.5; }
  else if (h > 2.2 && m != 0 && m != 3 && m != 4) sigma = 60.0;
  vec4 d = texture(uDye, c);
  sigma += d.r * 1.4;
  vec3 glow = texelFetch(uGlow, ip, 0).rgb * 0.45 + vec3(1.0, 0.45, 0.12) * d.b * 1.6;
  oA = vec4(min(rad, vec3(16.0)), sigma);
  oB = vec4(glow, 1.0);
}`;

const CASCADE_FS = `${HEAD}
uniform sampler2D uA; uniform sampler2D uB; uniform sampler2D uUpper;
uniform vec2 uNative; uniform int uI; uniform int uCount;
out vec4 o;
void main(){
  int i = uI;
  ivec2 tx = ivec2(gl_FragCoord.xy);
  ivec2 tile = ivec2(uNative) >> i;
  int d = 1 << (i + 1);
  ivec2 cell = tx / tile;
  ivec2 probe = tx - cell * tile;
  int dirIdx = cell.x + cell.y * d;
  float s = exp2(float(i));
  float ang = (float(dirIdx) + 0.5) * 6.2831853 / float(d * d);
  vec2 dir = vec2(cos(ang), sin(ang));
  vec2 origin = (vec2(probe) + 0.5) * s;
  float p4 = exp2(2.0 * float(i));
  float t0 = (p4 - 1.0) / 3.0;
  float t1 = (p4 * 4.0 - 1.0) / 3.0;
  int lod = max(0, i - 2);
  float stp = max(1.0, s * 0.5);
  vec3 L = vec3(0.0);
  float T = 1.0;
  for (int k = 0; k < 40; k++) {
    float t = t0 + stp * (float(k) + 0.5);
    if (t > t1) break;
    vec2 p = origin + dir * t;
    if (p.x < 0.0 || p.y < 0.0 || p.x >= uNative.x || p.y >= uNative.y) { T = 0.0; break; }
    ivec2 ip = ivec2(p) >> lod;
    vec4 A = texelFetch(uA, ip, lod);
    vec3 G = texelFetch(uB, ip, lod).rgb;
    float a = 1.0 - exp(-A.a * stp);
    L += T * (A.rgb * a + G * stp);
    T *= 1.0 - a;
    if (T < 0.01) { T = 0.0; break; }
  }
  if (i < uCount - 1 && T > 0.0) {
    ivec2 tileU = ivec2(uNative) >> (i + 1);
    int dU = d * 2;
    vec2 u = clamp(origin / (2.0 * s), vec2(0.5), vec2(tileU) - 0.5);
    vec2 texU = vec2(textureSize(uUpper, 0));
    vec3 acc = vec3(0.0);
    for (int k = 0; k < 4; k++) {
      int j = dirIdx * 4 + k;
      ivec2 cu = ivec2(j % dU, j / dU);
      acc += texture(uUpper, (vec2(cu * tileU) + u) / texU).rgb;
    }
    L += T * acc * 0.25;
  }
  o = vec4(L, T);
}`;

// Average cascade 0's four directions. Opaque pixels (wall tops) take the light around them.
const FLUENCE_FS = `${HEAD}
uniform sampler2D uC0; uniform sampler2D uA; uniform vec2 uNative;
out vec4 o;
vec3 F(ivec2 p){
  ivec2 t = ivec2(uNative);
  p = clamp(p, ivec2(0), t - 1);
  return (texelFetch(uC0, p, 0).rgb + texelFetch(uC0, p + ivec2(t.x, 0), 0).rgb
        + texelFetch(uC0, p + ivec2(0, t.y), 0).rgb + texelFetch(uC0, p + t, 0).rgb) * 0.25;
}
bool opaque(ivec2 p){ return texelFetch(uA, clamp(p, ivec2(0), ivec2(uNative) - 1), 0).a > 10.0; }
void main(){
  ivec2 p = ivec2(gl_FragCoord.xy);
  if (!opaque(p)) { o = vec4(F(p), 1.0); return; }
  vec3 acc = vec3(0.0);
  float n = 0.0;
  for (int r = 1; r <= 3; r++) {
    for (int k = 0; k < 4; k++) {
      ivec2 q = p + ivec2(k == 0 ? r : k == 1 ? -r : 0, k == 2 ? r : k == 3 ? -r : 0);
      if (!opaque(q)) { acc += F(q); n += 1.0; }
    }
    if (n > 0.0) break;
  }
  o = vec4(n > 0.0 ? acc / n : vec3(0.0), 1.0);
}`;

export class Cascades {
  scene!: Target;
  fluence!: Target;
  /** Where last frame's fluence (the bounce feedback) sits relative to this frame, and its lit field. */
  histOff: [number, number] = [0, 0];
  histRect: number[] = [0, 0, 0, 0];
  private cas: Target[] = [];
  private pScene: Program;
  private pCascade: Program;
  private pFluence: Program;
  private emptyVao: WebGLVertexArrayObject;

  /** W and H: the native screen plus its guard, both multiples of 4 so mip levels 1-2 stay exact 2x2 averages. */
  constructor(private gl: GL, private W: number, private H: number, private spec: TexSpec) {
    this.alloc();
    this.pScene = new Program(gl, FULL_VS, SCENE_FS, 'rc-scene');
    this.pCascade = new Program(gl, FULL_VS, CASCADE_FS, 'rc-cascade');
    this.pFluence = new Program(gl, FULL_VS, FLUENCE_FS, 'rc-fluence');
    this.emptyVao = gl.createVertexArray()!;
  }

  private alloc(): void {
    const gl = this.gl;
    const { W, H, spec } = this;
    const mip: TexSpec = { ...spec, filter: gl.NEAREST_MIPMAP_NEAREST };
    this.scene = new Target(gl, W, H, [mip, mip]);
    for (const t of this.scene.tex) {
      gl.bindTexture(gl.TEXTURE_2D, t);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
      gl.generateMipmap(gl.TEXTURE_2D);
    }
    this.cas = [];
    for (let i = 0; i < CASCADES; i++) this.cas.push(new Target(gl, W * 2, H * 2, [spec]));
    this.fluence = new Target(gl, W, H, [spec]);
  }

  /** New screen size: reallocate everything (the bounce history starts dark). */
  resize(W: number, H: number): void {
    if (W === this.W && H === this.H) return;
    for (const t of [this.scene, ...this.cas, this.fluence]) t.dispose();
    this.W = W;
    this.H = H;
    this.alloc();
    this.clear();
  }

  private tex(unit: number, t: WebGLTexture): void {
    this.gl.activeTexture(this.gl.TEXTURE0 + unit);
    this.gl.bindTexture(this.gl.TEXTURE_2D, t);
  }

  private draw(): void {
    this.gl.bindVertexArray(this.emptyVao);
    this.gl.drawArrays(this.gl.TRIANGLES, 0, 3);
  }

  clear(): void {
    const gl = this.gl;
    this.fluence.bind();
    gl.clearColor(0, 0, 0, 1);
    gl.clear(gl.COLOR_BUFFER_BIT);
  }

  update(hdr: WebGLTexture, k: number, ga: WebGLTexture, gx: WebGLTexture, glow: WebGLTexture, dye: WebGLTexture): void {
    const gl = this.gl;
    gl.disable(gl.BLEND);
    this.scene.bind();
    this.pScene.use().i('uHDR', 0).i('uGA', 1).i('uGX', 2).i('uGlow', 3).i('uDye', 4).i('uPrev', 5)
      .v2('uNative', this.W, this.H).f('uK', k).f('uBounce', 0.55)
      .v2('uHistOff', this.histOff[0], this.histOff[1]).v4('uHistRect', this.histRect[0], this.histRect[1], this.histRect[2], this.histRect[3]);
    [hdr, ga, gx, glow, dye, this.fluence.tex[0]].forEach((t, i) => this.tex(i, t));
    this.draw();
    for (const t of this.scene.tex) {
      gl.bindTexture(gl.TEXTURE_2D, t);
      gl.generateMipmap(gl.TEXTURE_2D);
    }
    this.pCascade.use().i('uA', 0).i('uB', 1).i('uUpper', 2).v2('uNative', this.W, this.H).i('uCount', CASCADES);
    this.tex(0, this.scene.tex[0]);
    this.tex(1, this.scene.tex[1]);
    for (let i = CASCADES - 1; i >= 0; i--) {
      this.cas[i].bind();
      this.pCascade.i('uI', i);
      this.tex(2, (this.cas[i + 1] ?? this.cas[0]).tex[0]);
      this.draw();
    }
    this.fluence.bind();
    this.pFluence.use().i('uC0', 0).i('uA', 1).v2('uNative', this.W, this.H);
    this.tex(0, this.cas[0].tex[0]);
    this.tex(1, this.scene.tex[0]);
    this.draw();
    gl.bindVertexArray(null);
  }
}
