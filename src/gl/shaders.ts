// All GLSL lives here. Offscreen passes use a y-down convention: screen pixel (x, y) maps to
// framebuffer texel (x, y), so gl_FragCoord.xy / k is the native screen position. Only the final
// pass flips to the canvas.
//
// Frame: gbuffer (native) -> sun + spot/omni lights with soft shadows and volumetric fog (k-res HDR)
// -> additive fx -> radiance downsample (native) -> GI + ray-traced AO and reflections (native,
// temporally accumulated) -> composite ambient/GI/reflections into HDR -> smoke, overlay -> bloom -> post.

export const HEAD = `#version 300 es
precision highp float;
precision highp int;
`;

const COMMON = `
const float HPX = 10.0;           // height 1.0 = 10 native pixels tall
uniform vec2 uNative;
float hash12(vec2 p){ vec3 p3 = fract(vec3(p.xyx) * 0.1031); p3 += dot(p3, p3.yzx + 33.33); return fract((p3.x + p3.y) * p3.z); }
float vnoise(vec2 p){ vec2 i = floor(p); vec2 f = fract(p); f = f*f*(3.0-2.0*f);
  return mix(mix(hash12(i), hash12(i+vec2(1,0)), f.x), mix(hash12(i+vec2(0,1)), hash12(i+vec2(1,1)), f.x), f.y); }
`;

const GBUF_READ = `
uniform sampler2D uGA; // albedo rgb (srgb), a = spec
uniform sampler2D uGX; // r = height, g = material/255, b = reflectivity, a = roughness
uniform sampler2D uGE; // emissive
uniform vec2 uLimit;   // size of the valid screen area (the screen, plus the guard px while scrolling sub-pixel)
float H(vec2 p){ ivec2 ip = clamp(ivec2(floor(p)), ivec2(0), ivec2(uLimit) - 1); return texelFetch(uGX, ip, 0).r * HPX; }
vec3 nrm(ivec2 ip){
  vec2 p = vec2(ip) + 0.5;
  float l = H(p - vec2(1,0)), r = H(p + vec2(1,0)), u = H(p - vec2(0,1)), d = H(p + vec2(0,1));
  return normalize(vec3((l - r) * 0.5, (u - d) * 0.5, 1.0));
}
int matAt(vec4 X){ return int(X.g * 255.0 + 0.5); }
vec4 GX(vec2 p){ return texelFetch(uGX, clamp(ivec2(floor(p)), ivec2(0), ivec2(uLimit) - 1), 0); }
bool isMetal(int m){ return m == 2 || m == 8; }
const vec3 LEAF = vec3(0.55, 0.8, 0.3);
float ggx(vec3 N, vec3 L, float rough){
  vec3 Hh = normalize(L + vec3(0.0, 0.0, 1.0));
  float a = max(rough * rough, 0.004);
  float a2 = a * a;
  float nh = max(dot(N, Hh), 0.0);
  float d = nh * nh * (a2 - 1.0) + 1.0;
  return min(a2 / (3.14159 * d * d), 24.0);
}
`;

// Camera scrolling: terrain space = screen native px + uScroll (whole px). Screen-space buffers
// (gbuffer, fluid, GI) stay screen sized; terrain noise, the cell map and decals use terrain space.

// History that follows the camera: last frame's texel for screen pixel ip sits at ip + uHistOff.
// It only counts if it was inside last frame's lit field (uHistRect); otherwise take this frame fully.
export const HIST = `
uniform vec2 uHistOff; uniform vec4 uHistRect;
bool histAt(ivec2 ip, out ivec2 hp){
  hp = ip + ivec2(uHistOff);
  if (hp.x < 0 || hp.y < 0 || hp.x >= int(uNative.x) || hp.y >= int(uNative.y)) return false;
  if (uHistOff.x == 0.0 && uHistOff.y == 0.0) return true;
  vec2 q = vec2(hp) + 0.5;
  return q.x > uHistRect.x && q.y > uHistRect.y && q.x < uHistRect.x + uHistRect.z && q.y < uHistRect.y + uHistRect.w;
}
`;

// uOffset moves the quads (decals: screen px -> terrain px); 0 everywhere else.
export const SPRITE_VS = `${HEAD}
layout(location=0) in vec2 aPos;
layout(location=1) in vec2 aUV;
layout(location=2) in vec4 aColor;
layout(location=3) in vec4 aParam;
uniform vec2 uNative; uniform vec2 uOffset;
out vec2 vUV; out vec4 vColor; out vec4 vParam; out vec2 vWorld;
void main(){
  vUV = aUV; vColor = aColor; vParam = aParam; vWorld = aPos + uOffset;
  gl_Position = vec4(vWorld / uNative * 2.0 - 1.0, 0.0, 1.0);
}`;

// Materials: 0 ground, 1 standard, 2 metal, 3 water, 4 ice, 5 unlit, 6 foliage, 7 brick, 8 steel, 9 road, 10 rail
// Terrain (ground, water, ice, foliage, brick, steel, road) is generated here per pixel from world position
// and the live cell map, so nothing repeats on a grid; sprites come from the atlas.
export const GBUFFER_FS = `${HEAD}${COMMON}
uniform sampler2D uAlb; uniform sampler2D uHS; uniform sampler2D uEm; uniform sampler2D uDecal;
uniform vec2 uAtlas; uniform float uTime; uniform float uWet; uniform float uSnow; uniform float uWaterK;
uniform vec3 uGround; uniform float uGrass;
uniform sampler2D uKinds; uniform float uHasKinds;
uniform sampler2D uRail; uniform float uHasRail;
uniform vec3 uBrickTint; uniform vec4 uBrickWash; uniform vec3 uLeaf; uniform vec4 uLeafWash; uniform float uLeafOlive;
uniform sampler2D uWave; uniform sampler2D uCells; uniform vec2 uCellOrigin; uniform float uHasCells;
uniform vec2 uCellSize; uniform vec2 uScroll; uniform vec2 uTerrain;
in vec2 vUV; in vec4 vColor; in vec4 vParam; in vec2 vWorld;
layout(location=0) out vec4 oAlb;
layout(location=1) out vec4 oAux;
layout(location=2) out vec4 oEm;

// Voronoi: x = distance to nearest point, y = gap to the second nearest (thin = cell edge), z = cell id
vec3 voro(vec2 p){
  vec2 i = floor(p);
  vec2 f = fract(p);
  float d1 = 8.0;
  float d2 = 8.0;
  float id = 0.0;
  for (int y = -1; y <= 1; y++) for (int x = -1; x <= 1; x++) {
    vec2 g = vec2(float(x), float(y));
    vec2 o = vec2(hash12(i + g), hash12(i + g + 17.3));
    float d = length(g + o - f);
    if (d < d1) { d2 = d1; d1 = d; id = hash12(i + g + 5.1); }
    else if (d < d2) d2 = d;
  }
  return vec3(d1, d2 - d1, id);
}

// Turned sprites (RotSprite-style): plain nearest sampling of a turned sprite doubles some texels and drops others,
// which breaks 1 px rims and rivets. Instead the texel under the sample point is taken from the sprite as if
// scaled up 4x by Scale2x (EPX) twice: a quarter of a texel takes its neighbours' colour where they form a diagonal
// edge, so turned edges and lines step cleanly. Returns the atlas texel whose albedo/height/emissive to use.
// Sprites sit 1 px apart in the atlas; reaching 2 texels out can only ever pick a transparent texel from the gap.
bool sameTexel(vec4 a, vec4 b){
  if (a.a < 0.5 || b.a < 0.5) return a.a < 0.5 && b.a < 0.5;
  return all(lessThan(abs(a.rgb - b.rgb), vec3(0.04)));
}
// EPX: quarter q of texel t takes the colour of its two neighbours on that side when they match each other and
// neither matches the neighbour across from the other
ivec2 epxPick(ivec2 t, ivec2 q){
  ivec2 hx = ivec2(q.x == 0 ? -1 : 1, 0);
  ivec2 vy = ivec2(0, q.y == 0 ? -1 : 1);
  vec4 H = texelFetch(uAlb, t + hx, 0);
  vec4 V = texelFetch(uAlb, t + vy, 0);
  if (!sameTexel(H, V)) return t;
  if (sameTexel(H, texelFetch(uAlb, t - vy, 0)) || sameTexel(V, texelFetch(uAlb, t - hx, 0))) return t;
  return t + vy;
}
ivec2 rotPick(vec2 uv){
  ivec2 s4 = ivec2(floor(uv * 4.0));
  ivec2 s2 = s4 >> 1;
  ivec2 q = s4 & 1;
  ivec2 hx = ivec2(q.x == 0 ? -1 : 1, 0);
  ivec2 vy = ivec2(0, q.y == 0 ? -1 : 1);
  ivec2 tH = epxPick((s2 + hx) >> 1, (s2 + hx) & 1);
  ivec2 tV = epxPick((s2 + vy) >> 1, (s2 + vy) & 1);
  ivec2 tP = epxPick(s2 >> 1, s2 & 1);
  vec4 H = texelFetch(uAlb, tH, 0);
  vec4 V = texelFetch(uAlb, tV, 0);
  if (!sameTexel(H, V)) return tP;
  ivec2 tHo = epxPick((s2 - hx) >> 1, (s2 - hx) & 1);
  ivec2 tVo = epxPick((s2 - vy) >> 1, (s2 - vy) & 1);
  if (sameTexel(H, texelFetch(uAlb, tVo, 0)) || sameTexel(V, texelFetch(uAlb, tHo, 0))) return tP;
  return tV;
}

// Map cell type: 0 empty, 1 brick, 2 steel, 3 water, 4 trees, 5 ice, 6 road, 7 rail; -1 outside the map
int cellType(ivec2 c){
  if (c.x < 0 || c.y < 0 || c.x >= int(uCellSize.x) || c.y >= int(uCellSize.y)) return -1;
  return int(texelFetch(uCells, c, 0).r * 255.0 + 0.5);
}

// Distance in px from p to the nearest map cell (within 2 cells) that is not 'type'. 99 = none / no map.
float edgeDist(vec2 p, int type){
  if (uHasCells < 0.5) return 99.0;
  vec2 lp = p - uCellOrigin;
  ivec2 c0 = ivec2(floor(lp / 4.0));
  float best = 99.0;
  for (int y = -2; y <= 2; y++) for (int x = -2; x <= 2; x++) {
    ivec2 c = c0 + ivec2(x, y);
    if (cellType(c) == type) continue;
    vec2 d = max(abs(lp - (vec2(c) * 4.0 + 2.0)) - 2.0, 0.0);
    best = min(best, length(d));
  }
  return best;
}

// The railway at a point (lp = px from the cell map's origin), from the geometry baked per cell by railgeo.ts:
// two texels per cell, the nearest track and the second nearest (slot 0 / 1; turnouts have two). Returns
// x = px square to that track's centre line (signed; 99 = no track), y = px along the track (arc length),
// z = what turns a distance square to the track into one along the screen axis nearest to square (a rail drawn
// with it is exactly one pixel in every column, or row on steep track). The centre line is nudged half a pixel
// so that both rails of a track lying on the cell grid fall on pixel centres.
vec3 railAt(vec2 lp, int slot){
  ivec2 c = ivec2(floor(lp / 4.0));
  if (c.x < 0 || c.y < 0 || c.x >= int(uCellSize.x) || c.y >= int(uCellSize.y)) return vec3(99.0, 0.0, 1.0);
  vec4 g = texelFetch(uRail, ivec2(c.x + slot * int(uCellSize.x), c.y), 0);
  if (abs(g.z) > 999.0) return vec3(99.0, 0.0, 1.0);
  vec2 rel = lp - (vec2(c) * 4.0 + 2.0);
  return vec3(g.z + dot(rel, vec2(-g.y, g.x)) - 0.5, g.w + dot(rel, g.xy), 1.0 / max(abs(g.x), abs(g.y)));
}

// Ballast bed: grey-brown crushed stone, single bright stones, darker and lower on the shoulders (av = px from the
// nearest track's centre line).
vec3 ballast(vec2 px, float av, out float h){
  float n = hash12(px);
  float st = step(0.82, hash12(floor(px * 0.5) * 2.3 + 1.0));
  vec3 bal = vec3(0.4, 0.37, 0.33) * (0.72 + 0.4 * n) * (0.9 + 0.2 * vnoise(px * 0.21));
  bal = mix(bal, vec3(0.62, 0.6, 0.56) * (0.85 + 0.3 * n), st * 0.6);
  h = 0.13 + n * 0.015 + st * 0.012;
  if (av > 6.0) { float sh = clamp((av - 6.0) / 2.5, 0.0, 1.0); h -= sh * 0.035; bal *= 1.0 - sh * 0.2; }
  return bal;
}

// Snow lying on a wall (brick or steel) in winter: a 1-2 px cap along the top edge and a thinner drift down the left
// edge where the next cell is not wall (the same sides the trees carry theirs), plus a light dusting on top.
float wallSnow(vec2 p, vec2 px){
  float cap = hash12(px * 2.9 + 1.0) > 0.93 ? 0.7 : 0.0;
  if (uHasCells < 0.5) return cap;
  ivec2 cc = ivec2(floor((p - uCellOrigin) / 4.0));
  vec2 cf = mod(p - uCellOrigin, 4.0);
  int up = cellType(cc - ivec2(0, 1));
  int lf = cellType(cc - ivec2(1, 0));
  if (up != 1 && up != 2 && cf.y < 1.0 + step(0.4, hash12(vec2(floor(px.x / 2.0), float(cc.y)) + 4.0))) cap = 1.0;
  if (lf != 1 && lf != 2 && cf.x < 1.0 && hash12(px * 3.7) > 0.3) cap = 1.0;
  return cap;
}

float ripple(vec2 px){
  vec2 cell = floor(px / 11.0);
  float acc = 0.0;
  for (int j = 0; j < 2; j++) {
    vec2 c = cell + vec2(float(j), 0.0);
    float ph = fract(uTime * 0.9 + hash12(c) * 7.0);
    vec2 ctr = (c + vec2(hash12(c + 3.1), hash12(c + 5.7))) * 11.0;
    float d = length(px - ctr);
    float r = ph * 7.0;
    acc += exp(-(d - r) * (d - r) * 1.5) * (1.0 - ph);
  }
  return acc;
}

void main(){
  int mat = int(vParam.x + 0.5);
  ivec2 sx = ivec2(floor(vWorld)); // screen px (the wave field lives on screen)
  vec2 px = floor(vWorld) + uScroll; // terrain px
  vec2 p = px + 0.5;
  vec3 alb; float h; float spec; vec3 em = vec3(0.0);
  float refl = 0.0; float rough = 0.55;
  // railway (campaign): where the tracks run at this pixel. The ballast bed follows the tracks, not the cells:
  // ground pixels inside its ragged edge are drawn as bed, RAIL-cell pixels outside it as ground.
  vec3 rl1 = vec3(99.0, 0.0, 1.0); vec3 rl2 = rl1; float railAv = 99.0;
  if (uHasRail > 0.5 && (mat == 0 || mat == 9 || mat == 10)) {
    rl1 = railAt(p - uCellOrigin, 0);
    if (rl1.x < 90.0) {
      rl2 = railAt(p - uCellOrigin, 1);
      railAv = min(abs(rl1.x), abs(rl2.x));
    }
    if (mat != 9 && (mat == 10 || railAv < 10.0)) {
      float edge = 7.7 + (vnoise(px * 0.3 + 5.0) - 0.5) * 1.6 + (hash12(px * 1.7 + 2.0) - 0.5) * 1.2;
      mat = railAv < edge ? 10 : 0;
    }
  }
  if (mat == 0) {
    // earth: dirt with gravel, pebbles, dry grass and cracks, all with height for the lighting
    float m1 = vnoise(px * 0.035);
    float m2 = vnoise(px * 0.08 + 11.0);
    float n = vnoise(px * 0.33) * 0.6 + hash12(px) * 0.4;
    vec3 base = uGround * (0.82 + 0.3 * m2) * (0.88 + 0.24 * n);
    h = 0.09 + n * 0.05 + m2 * 0.03;
    float gravel = smoothstep(0.62, 0.78, vnoise(px * 0.06 + 31.0));
    float pebble = step(1.0 - (0.05 + gravel * 0.3), hash12(floor(px * 0.5) * 1.37 + 3.0)) * step(0.3, hash12(px + 7.0));
    base = mix(base, base * vec3(1.05, 1.06, 1.1) * 1.08, gravel * 0.6);
    base = mix(base, uGround * vec3(1.35, 1.32, 1.28) * (0.8 + 0.4 * hash12(px * 3.1)), pebble * 0.85);
    h += pebble * 0.07;
    float grass = smoothstep(0.56, 0.72, m1 * 0.7 + vnoise(px * 0.22) * 0.3) * uGrass * (1.0 - gravel);
    float blade = step(0.6, hash12(vec2(px.x, floor(px.y / 3.0 + hash12(vec2(px.x, 1.0)) * 3.0))));
    vec3 gcol = vec3(0.3, 0.34, 0.14) * (0.75 + 0.5 * hash12(px * 0.71));
    base = mix(base, gcol, grass * 0.8);
    base = mix(base, gcol * 1.45, grass * blade * 0.7);
    h += grass * (0.02 + blade * 0.05);
    float cl = (1.0 - smoothstep(0.025, 0.06, voro(px * 0.055).y)) * smoothstep(0.55, 0.7, vnoise(px * 0.02 + 5.0));
    base *= 1.0 - cl * 0.35 * (1.0 - grass);
    h -= cl * 0.04;
    // ground kinds (campaign): floors, paving and crops laid by the region generators, one per cell
    float kSnow = 1.0;
    int kind = 0;
    bool kv = false;
    if (uHasKinds > 0.5) {
      ivec2 kc = ivec2(floor((p - uCellOrigin) / 4.0));
      if (kc.x >= 0 && kc.y >= 0 && kc.x < int(uCellSize.x) && kc.y < int(uCellSize.y)) {
        int kr = int(texelFetch(uKinds, kc, 0).r * 255.0 + 0.5);
        kind = kr & 15;
        kv = (kr & 16) != 0;
      }
    }
    if (kind != 0) {
      // colours are for daylight; each weather's ground tint carries over
      vec3 tone = uGround / vec3(0.34, 0.31, 0.26);
      float g1 = hash12(px * 1.7 + 4.0);
      vec2 kq = kv ? px.yx : px; // kq.x along the rows, kq.y across them
      if (kind == 1) {
        // planks: boards 4 px wide, their ends staggered, a dark joint between
        float row = floor(px.y / 4.0);
        float ly = px.y - row * 4.0;
        float xs = px.x + floor(hash12(vec2(row, 7.0)) * 16.0);
        float bk = floor(xs / 16.0);
        base = vec3(0.5, 0.35, 0.21) * (0.8 + 0.32 * hash12(vec2(bk, row) + 3.0)) * (0.94 + 0.1 * g1);
        h = 0.1;
        if (hash12(vec2(floor(xs / 3.0), px.y) + 9.0) > 0.86) base *= 0.88;
        if (ly > 2.5 || xs - bk * 16.0 < 0.5) { base *= 0.52; h = 0.08; }
        rough = 0.7;
        kSnow = 0.55;
      } else if (kind == 2) {
        // paving: 8 px slabs in staggered rows, worn joints with a little grass
        float row = floor(px.y / 8.0);
        float xs = px.x + mod(row, 2.0) * 4.0;
        vec2 sl = vec2(floor(xs / 8.0), row);
        vec2 l = vec2(xs - sl.x * 8.0, px.y - row * 8.0);
        float sh = hash12(sl * 1.3 + 2.0);
        base = vec3(0.47, 0.46, 0.44) * (0.84 + 0.26 * sh) * (0.94 + 0.1 * g1);
        h = 0.1;
        if (sh > 0.86) base *= vec3(0.9, 0.86, 0.82);
        if (l.x < 0.5 || l.y < 0.5) {
          base *= 0.6;
          h = 0.085;
          if (uGrass * hash12(px * 0.9 + 6.0) > 0.8) base = vec3(0.26, 0.31, 0.13);
        } else if (l.x > 6.5 || l.y > 6.5) base *= 0.88;
        else if (l.x < 1.5 || l.y < 1.5) base *= 1.1;
        rough = 0.6;
      } else if (kind >= 3 && kind <= 5) {
        // tilled soil in rows; the crop grows on the ridges
        vec3 soil = uGround * vec3(0.78, 0.68, 0.6) * (0.86 + 0.2 * m2) * (0.9 + 0.2 * n);
        float pitch = kind == 3 ? 4.0 : kind == 4 ? 3.0 : 6.0;
        float dead = clamp(uSnow / 0.45, 0.0, 1.0) * 0.85;
        vec3 straw = vec3(0.36, 0.31, 0.2) * tone;
        float rowi = floor(kq.y / pitch);
        float rr = kq.y - rowi * pitch;
        base = soil;
        h = 0.08;
        if (kind == 3) {
          // beets: a furrow, then a ridge with leafy tops in clumps
          if (rr < 1.0) { base *= 0.72; h = 0.06; }
          else if (rr < 3.0) {
            h = 0.1;
            float cl = hash12(vec2(floor((kq.x + rowi * 3.0) / 2.0), rowi) + 1.0);
            if (cl > 0.3) {
              base = mix((rr < 2.0 ? vec3(0.27, 0.47, 0.14) : vec3(0.17, 0.33, 0.1)) * (0.85 + 0.3 * cl) * tone, straw * (0.8 + 0.3 * cl), dead);
              h = 0.13;
            }
          }
        } else if (kind == 4) {
          // wheat: close gold rows with a thin line of soil between
          float st = hash12(vec2(kq.x, rowi) * 1.3 + 5.0);
          float sway = vnoise(px * 0.06 + 50.0);
          base = (rr < 1.0 ? vec3(0.47, 0.38, 0.17) : rr < 2.0 ? vec3(0.74, 0.62, 0.3) : vec3(0.62, 0.5, 0.23)) * (0.88 + 0.2 * st) * (0.9 + 0.2 * sway) * tone;
          h = 0.11 + st * 0.03 + (rr < 1.0 ? 0.0 : 0.02);
          if (st > 0.93) base *= 1.18; // ears catching the light
          base = mix(base, straw * (0.85 + 0.3 * st), dead);
        } else {
          // sunflowers: green rows 6 px apart, a 2 px yellow head with a dark heart every few px
          float cellA = floor((kq.x + mod(rowi, 2.0) * 2.5) / 5.0);
          float la = kq.x + mod(rowi, 2.0) * 2.5 - cellA * 5.0;
          float keep = step(0.12, hash12(vec2(cellA, rowi) + 8.0));
          if (rr >= 1.0 && rr < 4.0) {
            if (rr >= 2.0 && rr < 3.0 || hash12(px * 1.1 + 2.0) > 0.45) { base = mix(vec3(0.2, 0.36, 0.11) * (0.85 + 0.3 * g1) * tone, straw, dead); h = 0.12; }
            if (la >= 1.0 && la < 3.0 && rr < 3.0 && keep > 0.5) {
              base = mix((la < 2.0 && rr >= 2.0 ? vec3(0.4, 0.24, 0.07) : vec3(0.96, 0.76, 0.12)) * tone, straw * 0.8, dead);
              h = 0.17;
            }
          } else if (rr >= 4.5) { base *= 0.78; h = 0.065; }
        }
        rough = 0.85;
      } else if (kind == 6) {
        // poured concrete: 16 px bays with joints, stains
        vec2 l = mod(px, 16.0);
        base = vec3(0.45, 0.45, 0.46) * (0.9 + 0.14 * vnoise(px * 0.12 + 9.0)) * (0.95 + 0.08 * g1);
        base = mix(base, base * vec3(0.62, 0.6, 0.58), smoothstep(0.62, 0.8, vnoise(px * 0.05 + 21.0)) * 0.7);
        h = 0.1;
        if (l.x < 0.5 || l.y < 0.5) { base *= 0.62; h = 0.088; }
        if (hash12(px * 0.83 + 5.0) > 0.985) base *= 0.7;
        rough = 0.55;
        kSnow = 0.8;
      } else if (kind == 7) {
        // farmyard: cobbles set in packed earth, bare patches worn through
        vec3 cv = voro(px * 0.34);
        vec3 earth = uGround * vec3(1.12, 1.0, 0.86) * (0.9 + 0.14 * m2) * (0.94 + 0.1 * n);
        vec3 stone = vec3(0.5, 0.47, 0.42) * (0.8 + 0.36 * cv.z) * (0.95 + 0.08 * g1) * tone;
        float bare = smoothstep(0.58, 0.72, vnoise(px * 0.07 + 40.0));
        base = cv.y < 0.1 ? stone * 0.62 : stone * (1.0 + 0.1 * (0.5 - cv.x));
        h = cv.y < 0.1 ? 0.09 : 0.105;
        base = mix(base, earth, bare);
        h = mix(h, 0.095, bare);
        rough = 0.75;
      } else if (kind == 8) {
        // tiles: 4 px checker of pale and warm stone
        vec2 tl = floor(px / 4.0);
        vec2 l = px - tl * 4.0;
        bool dark = mod(tl.x + tl.y, 2.0) > 0.5;
        base = (dark ? vec3(0.4, 0.3, 0.26) : vec3(0.6, 0.57, 0.5)) * (0.9 + 0.16 * hash12(tl * 1.9 + 3.0)) * (0.95 + 0.08 * g1);
        h = 0.1;
        if (l.x < 0.5 || l.y < 0.5) base *= 0.8;
        rough = 0.45;
        kSnow = 0.55;
      } else if (kind == 9) {
        // trench floor: dug earth, darker and lower than the field, duckboards across it
        base = uGround * vec3(0.62, 0.55, 0.5) * (0.85 + 0.2 * n);
        h = 0.04;
        float sl = mod(kq.x, 4.0);
        if (sl < 2.0 && hash12(vec2(floor(kq.x / 4.0), floor(kq.y / 16.0)) + 2.0) > 0.25) {
          base = vec3(0.36, 0.27, 0.18) * (0.8 + 0.3 * hash12(vec2(floor(kq.x / 4.0), 3.0))) * (0.92 + 0.12 * g1) * tone;
          h = 0.055;
          if (sl < 1.0) base *= 1.12;
        }
        rough = 0.85;
        kSnow = 0.7;
      }
      if (kind != 3 && kind != 4 && kind != 5 && kind != 9 && kind != 7) base *= tone;
    }
    ivec2 dp = ivec2(px);
    vec4 dc = dp.x < 0 || dp.y < 0 || dp.x >= int(uTerrain.x) || dp.y >= int(uTerrain.y) ? vec4(0.0) : texelFetch(uDecal, dp, 0);
    alb = mix(base, dc.rgb, dc.a);
    spec = 0.06 * (1.0 - dc.a);
    rough = 0.8;
    if (uSnow > 0.0) {
      float sn = smoothstep(0.42, 0.6, vnoise(px * 0.07 + 3.0) * 0.7 + vnoise(px * 0.4) * 0.3) * uSnow * (1.0 - dc.a * 0.8) * kSnow;
      alb = mix(alb, vec3(0.6, 0.64, 0.72) * (0.85 + 0.15 * hash12(px)), sn);
      h += sn * 0.03;
      spec = mix(spec, 0.4, sn);
      rough = mix(rough, 0.35, sn);
    }
    if (uWet > 0.0) {
      float pud = smoothstep(0.56, 0.64, vnoise(px * 0.045 + 7.0) * 0.7 + vnoise(px * 0.13) * 0.3) * uWet;
      alb *= 1.0 - 0.35 * uWet;
      alb = mix(alb, alb * 0.45, pud);
      spec = mix(spec + 0.3 * uWet, 1.0, pud);
      refl = mix(0.08 * uWet, 0.7, pud);
      rough = mix(0.45, 0.04, pud);
      h = mix(h, 0.07 + ripple(px) * 0.025, pud);
    }
  } else if (mat == 3) {
    // water: deep in the middle, pale near the banks, with drifting currents (warped noise, never periodic)
    float t = uTime;
    float shore = edgeDist(p, 3);
    float depth = uHasCells > 0.5 ? clamp((shore - 0.5 + vnoise(p * 0.11 + 4.0) * 4.0 - 2.0) / 8.0, 0.0, 1.0) : 0.7;
    vec2 warp = vec2(vnoise(p * 0.045 + vec2(t * 0.05, 0.0)), vnoise(p * 0.045 + vec2(7.3, -t * 0.04)));
    float n1 = vnoise(p * vec2(0.08, 0.15) + warp * 3.0 + vec2(t * 0.35, t * 0.12));
    float n2 = vnoise(p * vec2(0.15, 0.08) - warp * 2.0 + vec2(-t * 0.22, t * 0.3) + 13.0);
    float w = n1 * 0.6 + n2 * 0.4;
    float lv = clamp(w * 0.75 + (1.0 - depth) * 0.42 - 0.08, 0.0, 0.999);
    float band = floor(lv * 4.0);
    alb = band < 0.5 ? vec3(0.04, 0.07, 0.3) : band < 1.5 ? vec3(0.07, 0.13, 0.46) : band < 2.5 ? vec3(0.12, 0.24, 0.64) : vec3(0.2, 0.38, 0.78);
    // glints where the two currents cross: short bright pixel streaks that come and go
    if (abs(n1 - n2) < 0.016 && hash12(floor(px * vec2(0.5, 1.0)) + floor(t * 3.0)) > 0.5) alb = vec3(0.55, 0.7, 1.0);
    alb *= uWaterK;
    float wv = texelFetch(uWave, sx, 0).r;
    h = 0.015 + w * 0.04 + ripple(px) * 0.02 * uWet + clamp(wv, -1.0, 1.0) * 0.1;
    // caustics on the river bed, only where it is shallow
    float caus = 1.0 - smoothstep(0.0, 0.07, voro(p * 0.11 + warp * 1.5 + vec2(t * 0.12, -t * 0.08)).y);
    alb += vec3(0.1, 0.18, 0.34) * caus * (1.0 - depth) * 0.55;
    // ripple rings as crisp pixel bands: light crests, dark troughs, plus slope shading
    if (wv > 0.22) alb = mix(alb, vec3(0.62, 0.76, 1.0), 0.6);
    else if (wv < -0.22) alb *= 0.62;
    float wgx = texelFetch(uWave, sx + ivec2(1, 0), 0).r - texelFetch(uWave, sx - ivec2(1, 0), 0).r;
    float wgy = texelFetch(uWave, sx + ivec2(0, 1), 0).r - texelFetch(uWave, sx - ivec2(0, 1), 0).r;
    alb *= 1.0 + clamp(-(wgx + wgy) * 1.2, -0.3, 0.4);
    spec = 1.0;
    refl = mix(0.45, 0.65, depth);
    rough = 0.14;
    // foam lapping at the banks
    float fn = vnoise(p * 0.5 + vec2(t * 1.6, -t * 1.1));
    float lap = 0.5 + 0.5 * sin(t * 2.1 + vnoise(p * 0.07) * 9.0);
    float foam = step(shore, 1.0) * step(0.55, fn) + step(shore, 1.5 + lap * 1.5) * step(0.8, fn) * 0.6 + smoothstep(0.8, 1.3, wv) * 0.5;
    foam = clamp(foam, 0.0, 1.0);
    alb = mix(alb, vec3(0.86, 0.93, 1.0), foam * 0.85);
    h += foam * 0.02;
    refl *= 1.0 - foam;
    rough = mix(rough, 0.7, foam);
  } else if (mat == 4) {
    // ice: frozen floes split by cracks, frosty streaks at a different angle on each floe
    vec3 v = voro(p / 9.0);
    float crk = 1.0 - smoothstep(0.0, 0.06, v.y);
    float ang = v.z * 6.2831853;
    vec2 dir = vec2(cos(ang), sin(ang));
    float streak = step(0.8, vnoise(vec2(dot(p, dir) * 0.7, dot(p, vec2(-dir.y, dir.x)) * 0.07) + v.z * 50.0));
    alb = vec3(0.72, 0.78, 0.87) * (0.92 + 0.12 * v.z);
    alb = mix(alb, vec3(0.94, 0.97, 1.0), streak * 0.75);
    alb *= 0.95 + 0.1 * hash12(px);
    alb = mix(alb, vec3(0.42, 0.52, 0.66), crk * 0.8);
    if (edgeDist(p, 5) < 1.0) alb *= 0.86;
    h = 0.1 - crk * 0.02;
    spec = 1.0;
    refl = 0.35 * (1.0 - crk * 0.6);
    rough = mix(0.12, 0.35, crk);
    if (hash12(px + floor(uTime * 3.0) * 17.0) > 0.992) em += vec3(0.5, 0.6, 0.7);
  } else if (mat == 6) {
    // foliage: overlapping round leaf clumps on a jittered grid, lit from the top left and
    // banded into a pixel-art palette; dark rim where the canopy meets open ground
    vec2 sw = vec2(sin(uTime * 1.3 + p.y * 0.07), cos(uTime * 1.1 + p.x * 0.06)) * 0.3;
    vec2 q = (p + sw) / 6.0;
    vec2 qi = floor(q);
    vec2 qf = fract(q);
    float dome = 0.0;
    vec2 off = vec2(0.0);
    float id = 0.0;
    for (int y = -1; y <= 1; y++) for (int x = -1; x <= 1; x++) {
      vec2 g = vec2(float(x), float(y));
      vec2 c = qi + g;
      vec2 o = vec2(hash12(c * 1.7 + 3.0), hash12(c * 1.3 + 9.0)) * 0.8 + 0.1;
      float r = 0.55 + 0.4 * hash12(c + 21.0);
      vec2 dv = (g + o - qf) / r;
      float dd = 1.0 - dot(dv, dv);
      if (dd > dome) { dome = dd; off = dv; id = hash12(c + 40.0); }
    }
    float edge = edgeDist(p, 4);
    float lit = dome * 0.55 - (off.x + off.y) * 0.3 + 0.22 + (hash12(px) - 0.5) * 0.12 + (id - 0.5) * 0.18;
    if (dome <= 0.0) lit = 0.08 + hash12(px) * 0.1;
    if (edge < 1.0 && (dome < 0.55 || hash12(px * 3.3) > 0.65)) lit -= 0.4;
    else if (edge < 2.0 && dome < 0.3) lit -= 0.12;
    float band = clamp(floor(lit * 5.0), 0.0, 4.0);
    alb = band < 0.5 ? vec3(0.1, 0.27, 0.06) : band < 1.5 ? vec3(0.17, 0.42, 0.07) : band < 2.5 ? vec3(0.33, 0.63, 0.09)
        : band < 3.5 ? vec3(0.53, 0.82, 0.15) : vec3(0.74, 0.93, 0.36);
    if (band > 2.5) alb = mix(alb, band < 3.5 ? vec3(0.4, 0.5, 0.14) : vec3(0.56, 0.62, 0.26), uLeafOlive);
    alb = mix(alb, uLeafWash.rgb * (dot(alb, vec3(0.3, 0.5, 0.2)) / 0.4), uLeafWash.a) * uLeaf;
    alb *= mix(vec3(1.06, 1.0, 0.82), vec3(0.9, 1.0, 1.1), id) * (0.94 + 0.12 * id);
    h = clamp(0.82 + max(dome, 0.0) * 0.16 - (edge < 1.0 ? 0.04 : 0.0), 0.0, 1.0);
    spec = 0.1;
    rough = 0.8;
    if (uSnow > 0.0) {
      // winter: cold dark greens, a snow cap on the lit (top-left) shoulder of every leaf clump with a pale blue rim
      // under it, and snow piled along the canopy's top and left edges; banded like the summer palette
      float sk = clamp(uSnow / 0.45, 0.0, 1.0);
      vec3 cold = band < 0.5 ? vec3(0.04, 0.1, 0.09) : band < 1.5 ? vec3(0.07, 0.17, 0.14) : band < 2.5 ? vec3(0.11, 0.26, 0.2)
          : band < 3.5 ? vec3(0.18, 0.36, 0.29) : vec3(0.28, 0.46, 0.4);
      alb = mix(alb, cold * (0.94 + 0.12 * id), sk);
      float capv = dome * 0.45 - (off.x + off.y) * 0.5 + (hash12(px * 2.1) - 0.5) * 0.16 + (id - 0.5) * 0.25;
      float cap = dome > 0.08 ? step(0.56, capv) : 0.0;
      float rim = dome > 0.08 ? step(0.46, capv) * (1.0 - cap) : 0.0;
      ivec2 cc = ivec2(floor((p - uCellOrigin) / 4.0));
      vec2 cf = mod(p - uCellOrigin, 4.0);
      bool tl = uHasCells > 0.5 && ((cf.y < 1.0 && cellType(cc - ivec2(0, 1)) != 4) || (cf.x < 1.0 && cellType(cc - ivec2(1, 0)) != 4));
      float drift = tl && hash12(px * 3.7) > 0.15 ? 1.0 : 0.0;
      cap = max(cap, drift);
      alb = mix(alb, vec3(0.5, 0.62, 0.72), rim * sk * 0.7);
      alb = mix(alb, vec3(0.88, 0.93, 1.0) * (0.94 + 0.08 * hash12(px)), cap * sk);
      h += cap * 0.02 * sk;
      spec = mix(spec, 0.35, cap * sk);
      rough = mix(rough, 0.45, cap * sk);
    }
  } else if (mat == 7) {
    // brick: courses 4 px tall, bricks of uneven length, staggered at random, each with its own
    // colour and wear; chipped where a wall meets anything else
    float row = floor(px.y / 4.0);
    float ly = px.y - row * 4.0;
    float xs = px.x + floor(hash12(vec2(row, 3.0)) * 8.0);
    float k = floor(xs / 8.0);
    float s = k * 8.0 + floor(hash12(vec2(k, row) + 0.5) * 3.0);
    if (xs < s) {
      k -= 1.0;
      s = k * 8.0 + floor(hash12(vec2(k, row) + 0.5) * 3.0);
    }
    float lx = xs - s;
    vec2 bid = vec2(k, row);
    float g = hash12(px * 1.91);
    if (ly > 2.5 || lx < 0.5) {
      alb = vec3(0.56, 0.55, 0.53) * (0.82 + 0.25 * hash12(px));
      h = 0.6;
    } else {
      alb = ly < 0.5 ? vec3(0.91, 0.54, 0.16) : ly < 1.5 ? vec3(0.78, 0.44, 0.0) : vec3(0.6, 0.19, 0.0);
      if (lx < 1.5) alb = mix(alb, vec3(0.94, 0.63, 0.31), 0.35);
      alb = mix(alb, uBrickWash.rgb * (dot(alb, vec3(0.3, 0.5, 0.2)) / 0.42), uBrickWash.a) * uBrickTint;
      alb *= 0.84 + 0.3 * hash12(bid * 1.13 + 2.0);
      if (hash12(bid + 9.0) > 0.82) alb *= vec3(0.85, 0.72, 0.72);
      if (hash12(bid + 23.0) > 0.9) alb = mix(alb, vec3(0.28, 0.22, 0.2), 0.45);
      alb *= 0.9 + 0.2 * g;
      h = 0.8 + (ly < 0.5 ? 0.04 : 0.0) + g * 0.03;
      if (g > 0.93) { h -= 0.06; alb *= 0.75; }
    }
    if (edgeDist(p, 1) < 1.0 && hash12(px * 2.3 + 1.0) > 0.6) { h -= 0.1; alb *= 0.55; }
    spec = 0.12;
    rough = 0.7;
    if (uSnow > 0.0) {
      float sk = clamp(uSnow / 0.45, 0.0, 1.0);
      alb = mix(alb, vec3(dot(alb, vec3(0.3, 0.5, 0.2))) * vec3(0.92, 0.97, 1.08), 0.22 * sk) * (1.0 - 0.12 * sk);
      float cap = wallSnow(p, px);
      alb = mix(alb, vec3(0.88, 0.93, 1.0) * (0.94 + 0.08 * hash12(px)), cap * sk);
      h += cap * 0.02 * sk;
      spec = mix(spec, 0.35, cap * sk);
      rough = mix(rough, 0.45, cap * sk);
    }
  } else if (mat == 8) {
    // steel: 8 px plates (one per destructible tile), each with its own tint, inset, rivets,
    // scratches and rust
    vec2 pl = floor(px / 8.0);
    vec2 l = px - pl * 8.0;
    float hp = hash12(pl * 1.31 + 7.0);
    float inset = hp < 0.6 ? 2.0 : 1.0;
    vec3 tint = mix(vec3(0.95, 0.97, 1.05), vec3(1.04, 1.0, 0.95), hash12(pl + 3.0));
    alb = vec3(0.61, 0.61, 0.65);
    h = 0.86;
    if (l.x < 0.5 || l.y < 0.5) { alb = vec3(0.85, 0.85, 0.88); h = 0.84; }
    if (l.x > 6.5 || l.y > 6.5) { alb = vec3(0.38, 0.38, 0.42); h = 0.8; }
    if (l.x >= inset && l.y >= inset && l.x <= 7.0 - inset && l.y <= 7.0 - inset) {
      alb = (l.x > 6.5 - inset || l.y > 6.5 - inset) ? vec3(0.55, 0.55, 0.59) : vec3(0.82, 0.82, 0.85);
      h = 0.92;
    } else if (inset > 1.5 && hash12(pl + 11.0) > 0.45 && (l.x == 1.0 || l.x == 6.0) && (l.y == 1.0 || l.y == 6.0)) {
      alb = vec3(0.9, 0.9, 0.94);
      h = 0.9;
    }
    alb *= tint * (0.92 + 0.12 * hash12(pl + 5.0)) * (0.96 + 0.08 * hash12(px));
    refl = 0.22;
    rough = 0.3;
    float sa = hash12(pl + 17.0) * 3.14159;
    float sd = abs(dot(l - 3.5 - (hash12(pl + 19.0) - 0.5) * 3.0, vec2(-sin(sa), cos(sa))));
    if (sd < 0.5 && hash12(pl + 29.0) > 0.4) { alb *= 1.22; rough = 0.15; }
    if (hash12(px * 1.37) > 0.975) alb *= 0.7;
    float rust = smoothstep(0.65, 0.85, vnoise(px * 0.09 + 13.0));
    alb = mix(alb, vec3(0.45, 0.28, 0.16), rust * 0.35);
    rough = mix(rough, 0.7, rust);
    refl *= 1.0 - rust;
    spec = 0.7;
    if (uSnow > 0.0) {
      float sk = clamp(uSnow / 0.45, 0.0, 1.0);
      float cap = wallSnow(p, px);
      alb = mix(alb, vec3(0.88, 0.93, 1.0) * (0.94 + 0.08 * hash12(px)), cap * sk);
      h += cap * 0.02 * sk;
      spec = mix(spec, 0.35, cap * sk);
      refl *= 1.0 - cap * sk;
      rough = mix(rough, 0.45, cap * sk);
    }
  } else if (mat == 9) {
    // road: packed dirt track a little below the fields: two worn ruts along the road with a grassy crown between,
    // small stones, ragged verges; churned where roads meet; plank deck where it crosses water. The direction
    // comes from the cell map: how far the road runs left/right/up/down from this cell (roads are 4 cells wide).
    vec2 lp = p - uCellOrigin;
    ivec2 c0 = ivec2(floor(lp / 4.0));
    vec2 f = lp - vec2(c0) * 4.0;
    int rl = 0; int rr = 0; int ru = 0; int rd = 0;
    int tl = 6; int tr = 6; int tu = 6; int td = 6;
    if (uHasCells > 0.5) {
      for (int i = 1; i <= 4; i++) { int t = cellType(c0 - ivec2(i, 0)); if (t != 6 && t >= 0) { tl = t; break; } rl = i; }
      for (int i = 1; i <= 4; i++) { int t = cellType(c0 + ivec2(i, 0)); if (t != 6 && t >= 0) { tr = t; break; } rr = i; }
      for (int i = 1; i <= 4; i++) { int t = cellType(c0 - ivec2(0, i)); if (t != 6 && t >= 0) { tu = t; break; } ru = i; }
      for (int i = 1; i <= 4; i++) { int t = cellType(c0 + ivec2(0, i)); if (t != 6 && t >= 0) { td = t; break; } rd = i; }
    } else { tl = 0; tr = 0; }
    // px from here to the road's edge on each side (99 = the road carries on)
    float dl = tl != 6 ? float(rl) * 4.0 + f.x : 99.0;
    float dr = tr != 6 ? float(rr) * 4.0 + 4.0 - f.x : 99.0;
    float du = tu != 6 ? float(ru) * 4.0 + f.y : 99.0;
    float dd = td != 6 ? float(rd) * 4.0 + 4.0 - f.y : 99.0;
    bool vert = dl + dr < 20.0;
    bool horz = du + dd < 20.0;
    bool lane = vert != horz;
    float wid = vert ? dl + dr : du + dd;
    float u = vert ? dl : du;          // across the road, from its left/top edge
    float along = vert ? p.y : p.x;
    float edge = min(min(dl, dr), min(du, dd));
    float wob = (vnoise(vec2(along * 0.05, wid + 7.0)) - 0.5) * 1.4;
    float rut = 0.0;
    float crown = 0.0;
    float rd0 = min(abs(u - 4.5 - wob), abs(u - (wid - 4.5) - wob)); // px from the nearest rut centre
    if (lane) {
      rut = 1.0 - smoothstep(0.6, 1.4, rd0);
      crown = 1.0 - smoothstep(0.8, 2.0, abs(u - wid * 0.5 - wob));
    } else {
      rut = smoothstep(0.55, 0.7, vnoise(p * 0.3 + 3.0)) * 0.6; // junction: churned by turning tracks
    }
    float m2 = vnoise(px * 0.08 + 11.0);
    float n = vnoise(px * 0.4) * 0.5 + hash12(px) * 0.5;
    // packed dirt: warmer than the fields and smooth (traffic has pressed it flat)
    vec3 base = uGround * vec3(1.22, 1.07, 0.88) * (0.9 + 0.14 * m2) * (0.95 + 0.1 * n);
    h = 0.09 + n * 0.01;
    // ruts: darker and sunk a little, with a slightly raised lip beside them
    float lip = lane ? (1.0 - smoothstep(0.0, 0.7, abs(rd0 - 1.9))) * (1.0 - rut) : 0.0;
    base = mix(base, base * vec3(0.8, 0.77, 0.74), rut);
    base *= 1.0 + lip * 0.06;
    h += lip * 0.012 - rut * 0.03 + crown * 0.008;
    float stone = step(0.97, hash12(floor(px * 0.5) * 1.7 + 9.0)) * step(0.4, hash12(px + 3.0)) * (1.0 - rut);
    base = mix(base, uGround * vec3(1.32, 1.28, 1.22) * (0.85 + 0.3 * hash12(px * 2.3)), stone * 0.8);
    h += stone * 0.04;
    float tuft = crown * uGrass * step(0.6, vnoise(px * 0.35 + 2.0) * 0.6 + hash12(px * 1.3) * 0.4);
    base = mix(base, vec3(0.3, 0.34, 0.14) * (0.8 + 0.4 * hash12(px * 0.7)), tuft * 0.75);
    h += tuft * 0.025;
    // verge: ragged edge that fades into the field
    float rag = vnoise(px * 0.21 + 17.0) * 2.0 + hash12(px * 0.9) * 0.8;
    float verge = 1.0 - smoothstep(0.0, 1.5, edge - rag);
    vec3 field = uGround * (0.82 + 0.3 * m2) * (0.88 + 0.24 * n);
    field = mix(field, vec3(0.3, 0.34, 0.14) * (0.75 + 0.5 * hash12(px * 0.71)), 0.5 * uGrass * step(0.5, hash12(px * 1.9)));
    base = mix(base, field, verge * 0.8);
    h = mix(h, 0.12, verge);
    rut *= 1.0 - verge;
    rough = 0.85;
    spec = 0.05;
    // bridge: water beside the road -> timber deck, planks across the road, kerb beams along the sides
    bool deck = lane && (vert ? (tl == 3 || tr == 3) : (tu == 3 || td == 3));
    if (deck) {
      float k = floor(along / 3.0);
      float la = along - k * 3.0;
      base = vec3(0.47, 0.33, 0.2) * (0.78 + 0.34 * hash12(vec2(k, 4.0))) * (0.92 + 0.12 * hash12(px));
      h = 0.34 + hash12(vec2(k, 9.0)) * 0.02;
      if (la < 1.0) { base *= 0.5; h -= 0.03; }
      base *= 1.0 - rut * 0.18;
      if (u < 1.5 || u > wid - 1.5) { base = vec3(0.3, 0.2, 0.12) * (0.9 + 0.2 * hash12(px)); h = 0.42; }
      else if (hash12(vec2(k, floor(u / 4.0))) > 0.8 && la > 1.5 && abs(fract(u / 4.0) - 0.5) < 0.13) { base = vec3(0.6, 0.6, 0.62); h += 0.01; } // nails
      rough = 0.7;
      spec = 0.1;
      rut = 0.0;
    }
    // level crossing (Phase 4): where a track runs through the road, timber boards along the track with the rails
    // let into them, on the track's own line
    if (!deck && railAv < 6.0) {
      vec3 rc = abs(rl1.x) <= abs(rl2.x) ? rl1 : rl2;
      float vv = rc.x;
      float bk = floor((vv + 6.0) / 3.0);
      base = vec3(0.36, 0.27, 0.18) * (0.8 + 0.3 * hash12(vec2(bk, 5.0))) * (0.92 + 0.12 * hash12(px));
      if (fract((vv + 6.0) / 3.0) < 0.34) base *= 0.7;
      h = 0.1; rough = 0.75; spec = 0.08; rut = 0.0;
      float rdx = min(abs(abs(rl1.x) - 3.0) * rl1.z, abs(abs(rl2.x) - 3.0) * rl2.z);
      if (rdx < 0.5) { base = vec3(0.6, 0.6, 0.64); h = 0.11; spec = 1.0; refl = 0.35; rough = 0.15; }
    }
    ivec2 dp = ivec2(px);
    vec4 dc = dp.x < 0 || dp.y < 0 || dp.x >= int(uTerrain.x) || dp.y >= int(uTerrain.y) ? vec4(0.0) : texelFetch(uDecal, dp, 0);
    alb = mix(base, dc.rgb, dc.a);
    if (uSnow > 0.0) {
      // loose snow on the crown and verges; packed, greyer and glossy in the ruts
      float sn = smoothstep(0.35, 0.55, vnoise(px * 0.07 + 3.0) * 0.6 + vnoise(px * 0.4) * 0.4) * uSnow * (1.0 - dc.a * 0.8);
      // traffic keeps the lanes half clear, so the road still reads as a dark track through the white fields
      sn *= lane ? 0.55 : 0.8;
      alb = mix(alb, vec3(0.6, 0.64, 0.72) * (0.85 + 0.15 * hash12(px)), sn * (1.0 - rut));
      alb = mix(alb, vec3(0.34, 0.33, 0.35) * (0.9 + 0.1 * hash12(px)), rut * uSnow * 0.85);
      h += sn * (1.0 - rut) * 0.03;
      spec = mix(spec, 0.5, max(sn, rut * uSnow));
      rough = mix(rough, 0.3, max(sn, rut * uSnow));
    }
    if (uWet > 0.0) {
      // puddles collect in the ruts (and the churned junctions)
      float pud = smoothstep(0.22, 0.36, vnoise(px * vec2(lane && vert ? 0.15 : 0.06, lane && !vert ? 0.15 : 0.06) + 7.0)) * smoothstep(0.2, 0.6, rut) * uWet;
      if (deck) pud = 0.0;
      alb *= 1.0 - 0.32 * uWet;
      alb = mix(alb, alb * 0.45, pud);
      spec = mix(spec + 0.28 * uWet, 1.0, pud);
      refl = mix(0.06 * uWet, 0.7, pud);
      rough = mix(0.5, 0.04, pud);
      h = mix(h, 0.04 + ripple(px) * 0.02, pud);
    }
  } else if (mat == 10) {
    // rail (Phase 4): ballast bed, timber sleepers every 4 px along the track and square to it, and two steel
    // rails 6 px apart, all placed from the tracks' true centre lines (railAt), so curves are smooth pixel lines.
    // Where two tracks run together (turnouts) both are drawn: the rails cross, the sleepers stay in step.
    float av = uHasRail > 0.5 ? railAv : 7.0; // no geometry for this map: plain ballast
    alb = ballast(px, av, h); spec = 0.08; rough = 0.85;
    // sleepers: 2 px of dark timber, 11 px long, each its own shade, ends sometimes buried
    float sid = 0.0; float sa = 9.0;
    for (int i = 1; i >= 0; i--) {
      vec3 rl = i == 0 ? rl1 : rl2;
      float k = floor(rl.y / 4.0);
      float a = rl.y - k * 4.0;
      if (a < 2.0 && abs(rl.x) < 5.5 + (hash12(vec2(k, 7.0)) > 0.5 ? 0.0 : -1.0)) { sid = k; sa = a; }
    }
    if (sa < 2.0) {
      alb = vec3(0.27, 0.19, 0.13) * (0.7 + 0.45 * hash12(vec2(sid, 3.0))) * (0.9 + 0.15 * hash12(px * 1.3));
      if (sa < 1.0) alb *= 1.15;
      if (hash12(vec2(sid, 11.0)) > 0.85) alb = mix(alb, vec3(0.2, 0.2, 0.19), 0.5); // a concrete one
      h = 0.165;
      spec = 0.05;
      rough = 0.8;
    }
    // rails: a 1 px polished head (glints at a low sun) on a rusty foot showing 1 px either side
    float rd = min(abs(abs(rl1.x) - 3.0) * rl1.z, abs(abs(rl2.x) - 3.0) * rl2.z);
    if (rd < 0.5) {
      alb = vec3(0.6, 0.6, 0.64) * (0.92 + 0.12 * hash12(px));
      h = 0.25; spec = 1.0; refl = 0.4; rough = 0.12;
    } else if (rd < 1.5) {
      alb = vec3(0.33, 0.22, 0.15) * (0.85 + 0.25 * hash12(px * 0.9));
      h = 0.2; spec = 0.3; rough = 0.5;
    }
    ivec2 dp = ivec2(px);
    vec4 dc = dp.x < 0 || dp.y < 0 || dp.x >= int(uTerrain.x) || dp.y >= int(uTerrain.y) ? vec4(0.0) : texelFetch(uDecal, dp, 0);
    alb = mix(alb, dc.rgb, dc.a);
    if (uSnow > 0.0) {
      // snow lies on the ballast and sleepers; the rails stay dark lines
      float sn = smoothstep(0.3, 0.5, vnoise(px * 0.09 + 3.0) * 0.6 + vnoise(px * 0.5) * 0.4) * uSnow * (1.0 - dc.a * 0.8);
      if (rd >= 0.5) {
        alb = mix(alb, vec3(0.62, 0.66, 0.74) * (0.85 + 0.15 * hash12(px)), sn);
        h += sn * 0.02;
        spec = mix(spec, 0.4, sn);
        rough = mix(rough, 0.35, sn);
      }
    }
    if (uWet > 0.0) {
      alb *= 1.0 - 0.28 * uWet;
      spec = min(1.0, spec + 0.3 * uWet);
      rough *= 1.0 - 0.45 * uWet;
      refl = max(refl, (rd < 0.5 ? 0.55 : 0.06) * uWet);
    }
  } else {
    // a sprite turned to any angle (Renderer.sprRot flags it with colour alpha 2): pick the texel RotSprite-style
    vec2 uv = vColor.a > 1.5 ? vec2(rotPick(vUV)) + 0.5 : vUV;
    vec4 a = texture(uAlb, uv / uAtlas);
    if (a.a < 0.5) discard;
    vec4 hs = texture(uHS, uv / uAtlas);
    alb = mix(a.rgb, a.rgb * vColor.rgb, hs.b);
    alb = mix(alb, vec3(1.0), vParam.w);
    h = clamp(hs.r + vParam.y, 0.0, 1.0);
    spec = hs.g;
    em = texture(uEm, uv / uAtlas).rgb * vParam.z * mix(vec3(1.0), vColor.rgb, hs.b);
    rough = mix(0.6, 0.3, spec);
    if (mat == 2) {
      refl = 0.22;
      rough = 0.3;
    }
  }
  if (uWet > 0.0 && mat != 0 && mat != 3 && mat != 4 && mat != 9 && mat != 10) {
    alb *= 1.0 - 0.18 * uWet;
    spec = min(1.0, spec + 0.25 * uWet);
    rough *= 1.0 - 0.4 * uWet;
    refl = max(refl, 0.04 * uWet);
  }
  oAlb = vec4(alb, spec);
  oAux = vec4(h, float(mat) / 255.0, refl, rough);
  oEm = vec4(em, 1.0);
}`;

export const FULL_VS = `${HEAD}
out vec2 vUV;
void main(){
  vec2 p = vec2(float((gl_VertexID << 1) & 2), float(gl_VertexID & 2)) * 2.0 - 1.0;
  vUV = p * 0.5 + 0.5;
  gl_Position = vec4(p, 0.0, 1.0);
}`;

// Sun / moon with contact-hardening soft shadows, moving cloud shadows, GGX spec and emissive.
// Ambient is added later in the composite pass (needs ray-traced AO).
export const BASE_FS = `${HEAD}${COMMON}${GBUF_READ}
uniform float uK; uniform float uTime;
uniform vec3 uSunCol; uniform vec3 uSunDir; uniform float uEmGain; uniform float uClouds;
uniform sampler2D uDye; uniform float uPixel; uniform vec2 uScroll;
out vec4 o;
void main(){
  vec2 sp = gl_FragCoord.xy / uK;
  if (uPixel > 0.5) sp = floor(sp) + 0.5;
  ivec2 ip = ivec2(sp);
  vec4 A = texelFetch(uGA, ip, 0);
  vec4 X = texelFetch(uGX, ip, 0);
  vec3 E = texelFetch(uGE, ip, 0).rgb;
  int mat = matAt(X);
  vec3 alb = pow(A.rgb, vec3(2.2));
  if (mat == 5) { o = vec4(alb, 1.0); return; }
  vec3 N = nrm(ip);
  float h = X.r * HPX;
  vec3 Ls = normalize(uSunDir);
  vec2 sd = normalize(uSunDir.xy);
  float slope = uSunDir.z / length(uSunDir.xy);
  float pen = 1.0;
  float leaf = 0.0;
  for (int i = 1; i <= 18; i++) {
    float fi = float(i) * 0.75;
    vec2 q = sp + sd * fi;
    vec4 Xq = GX(q);
    float occ = clamp(0.5 + (h + slope * fi - Xq.r * HPX) * 1.4 / (0.35 + fi * 0.14), 0.0, 1.0);
    if (matAt(Xq) == 6 && mat != 6) {
      float dap = vnoise((q + uScroll + uTime * vec2(3.0, 1.5)) * 0.7);
      leaf = max(leaf, 1.0 - occ);
      occ = mix(occ, 1.0, 0.2 + 0.55 * dap * dap);
    }
    pen = min(pen, occ);
  }
  pen *= 1.0 - (1.0 - exp(-texture(uDye, (sp + sd * 4.0) / uNative).r * 1.3)) * 0.6;
  if (uPixel > 0.5) pen = floor(pen * 3.0 + 0.5) / 3.0;
  float cloud = 1.0;
  if (uClouds > 0.0) {
    vec2 wp = sp + uScroll;
    float c = vnoise((wp + uTime * vec2(7.0, 3.0)) * 0.011) * 0.65 + vnoise((wp - uTime * vec2(3.0, 5.0)) * 0.03) * 0.35;
    cloud = mix(1.0, 0.45 + 0.55 * smoothstep(0.32, 0.62, c), uClouds);
  }
  float ndl = max(dot(N, Ls), 0.0);
  vec3 sun = uSunCol * pen * cloud * mix(vec3(1.0), LEAF, leaf * 0.75);
  vec3 col = alb * sun * ndl;
  if (mat == 6) col += alb * uSunCol * cloud * vec3(0.7, 1.0, 0.4) * (0.05 + 0.12 * (1.0 - ndl));
  float spc = ggx(N, Ls, X.a) * ndl * A.a * 0.22;
  col += sun * spc * (isMetal(mat) ? alb * 0.9 + 0.05 : vec3(0.6));
  col += pow(E, vec3(2.2)) * uEmGain;
  o = vec4(col, 1.0);
}`;

export const LIGHT_VS = `${HEAD}
layout(location=0) in vec2 aCorner;
layout(location=1) in vec4 aL0; // x, y, z, radius
layout(location=2) in vec4 aL1; // r, g, b, shadow
layout(location=3) in vec4 aL2; // dirx, diry, cosOuter, cosInner (cosOuter < -1.5 = omni)
uniform vec2 uNative;
flat out vec4 vL0; flat out vec4 vL1; flat out vec4 vL2;
void main(){
  vec2 p = aL0.xy + aCorner * aL0.w;
  gl_Position = vec4(p / uNative * 2.0 - 1.0, 0.0, 1.0);
  vL0 = aL0; vL1 = aL1; vL2 = aL2;
}`;

// Point/spot light: soft shadows that harden near the occluder, GGX spec and in-scattering
// through fog (shafts get cut by walls because the air sample is shadow-tested too).
export const LIGHT_FS = `${HEAD}${COMMON}${GBUF_READ}
uniform float uK; uniform float uFog; uniform float uPixel; uniform vec2 uScroll;
flat in vec4 vL0; flat in vec4 vL1; flat in vec4 vL2;
layout(location=0) out vec4 o;
layout(location=1) out vec4 oS; // light reaching the air here, for lighting smoke
void main(){
  vec2 sp = gl_FragCoord.xy / uK;
  if (uPixel > 0.5) sp = floor(sp) + 0.5;
  vec2 d = vL0.xy - sp;
  float dist = length(d);
  float R = vL0.w;
  if (dist >= R) discard;
  float x = dist / R;
  float cone = 1.0;
  float near = 1.0;
  bool isSpot = vL2.z > -1.5;
  if (isSpot) {
    // the lamp is ~5 px across: the cone is measured from 3 px behind it, so the beam leaves the lamp already
    // a few px wide and its edges stay soft right up to the lamp; nothing shines back past the lamp's face
    vec2 fromApex = -d + vL2.xy * 3.0;
    float c = dot(fromApex / max(length(fromApex), 0.001), vL2.xy);
    cone = smoothstep(vL2.z, vL2.w, c) * smoothstep(-1.5, 1.5, dot(-d, vL2.xy));
    if (cone <= 0.001) discard;
    near = 0.4 + 0.6 * smoothstep(0.0, 14.0, dist); // the beam's air glow builds up over its first px
  }
  ivec2 ip = ivec2(sp);
  vec4 X = texelFetch(uGX, ip, 0);
  int mat = matAt(X);
  if (mat == 5) discard;
  vec4 A = texelFetch(uGA, ip, 0);
  vec3 alb = pow(A.rgb, vec3(2.2));
  float h = X.r * HPX;
  vec3 Ln = normalize(vec3(d, vL0.z - h));
  vec3 N = nrm(ip);
  float ndl = max(dot(N, Ln), 0.0);
  float att = (1.0 - x) * (1.0 - x) / (1.0 + dist * dist * 0.0015) * cone;
  if (isSpot) att *= smoothstep(1.0, 4.0, dist); // no hot spot on the lamp's own housing (a gun barrel's tip)
  if (uPixel > 0.5) att = (floor(att * 7.0) + 0.5) / 7.0 * step(0.02, att);
  float pen = 1.0;
  float air = 1.0;
  float leaf = 0.0;
  // shadow rays stop at the lamp's rim (2.5 px out): the lamp's own housing (a tank's hull, the muzzle brake over a
  // headlight) must not shadow it. Same 20 samples at every distance, so no rings where the step count changes.
  float span = dist - 2.5;
  if (vL1.w > 0.5 && span > 0.0) {
    float hAir = max(h, 3.0) + 2.5;
    const float steps = 20.0;
    float tEnd = span / dist;
    // the light is ~5 px wide: rays to its two edges give shadows in the air a soft penumbra
    vec2 side = vec2(-d.y, d.x) / max(dist, 0.001) * 2.5;
    float airC = 1.0;
    float airL = 1.0;
    float airR = 1.0;
    for (int i = 1; i <= 20; i++) {
      float fi = float(i);
      float t = fi / steps * tEnd;
      vec2 q = mix(sp, vL0.xy, t);
      vec4 Xq = GX(q);
      float hq = Xq.r * HPX;
      float dr = t * dist;
      float occ = clamp(0.5 + (mix(h, vL0.z, t) - hq) * 1.3 / (0.35 + dr * 0.1), 0.0, 1.0);
      if (matAt(Xq) == 6 && mat != 6) {
        leaf = max(leaf, 1.0 - occ);
        occ = mix(occ, 1.0, 0.25 + 0.4 * vnoise((q + uScroll) * 0.3));
      }
      pen = min(pen, occ);
      float ra = mix(hAir, vL0.z, t);
      airC = min(airC, clamp(0.5 + (ra - hq) * 0.6, 0.0, 1.0));
      airL = min(airL, clamp(0.5 + (ra - H(q - side * t)) * 0.6, 0.0, 1.0));
      airR = min(airR, clamp(0.5 + (ra - H(q + side * t)) * 0.6, 0.0, 1.0));
      if (pen < 0.01 && airC + airL + airR < 0.03) break;
    }
    air = (airC + airL + airR) / 3.0;
    // right at the rim the few px of ray left only see the pixel's own bumps: ease the shadow in
    float sk = smoothstep(0.0, 3.0, span);
    pen = mix(1.0, pen, sk);
    leaf *= sk;
    air = mix(1.0, air, sk);
  }
  if (uPixel > 0.5) pen = floor(pen * 3.0 + 0.5) / 3.0;
  float spc = ggx(N, Ln, X.a) * ndl * A.a * 0.5;
  vec3 lc = vL1.rgb * mix(vec3(1.0), LEAF, leaf * 0.7);
  vec3 c = lc * att * pen * (alb * ndl + spc * (isMetal(mat) ? alb + 0.15 : vec3(1.0)));
  if (mat == 6) c += vL1.rgb * att * alb * vec3(0.7, 1.0, 0.4) * 0.22;
  float inAir = (1.0 - x) * (1.0 - x) * cone * air * near;
  c += vL1.rgb * uFog * inAir * 0.55;
  o = vec4(c, 1.0);
  oS = vec4(vL1.rgb * inAir, 1.0);
}`;

// FX modes: 0 atlas additive, 1 glow additive, 2 soft circle alpha, 3 solid alpha, 4 atlas alpha (unlit)
export const FX_FS = `${HEAD}
uniform sampler2D uAlb; uniform vec2 uAtlas; uniform float uLin;
in vec2 vUV; in vec4 vColor; in vec4 vParam; in vec2 vWorld;
out vec4 o;
float hash12(vec2 p){ vec3 p3 = fract(vec3(p.xyx) * 0.1031); p3 += dot(p3, p3.yzx + 33.33); return fract((p3.x + p3.y) * p3.z); }
vec3 lin(vec3 c){ return uLin > 0.5 ? pow(c, vec3(2.2)) : c; }
void main(){
  int mode = int(vParam.x + 0.5);
  float I = vParam.y;
  if (mode == 0) {
    vec4 t = texture(uAlb, vUV / uAtlas);
    if (t.a < 0.5) discard;
    o = vec4(pow(t.rgb, vec3(2.2)) * vColor.rgb * I * vColor.a, 1.0);
  } else if (mode == 1) {
    float r = length(vUV);
    if (r > 1.0) discard;
    float g = exp(-r * r * 5.0) * (1.0 - r);
    o = vec4(vColor.rgb * I * g * vColor.a, 1.0);
  } else if (mode == 2) {
    float r = length(vUV);
    if (r > 1.0) discard;
    float n = hash12(floor(vWorld));
    float a = smoothstep(1.0, 0.25, r) * vColor.a * (0.8 + 0.2 * n);
    o = vec4(lin(vColor.rgb), a);
  } else if (mode == 3) {
    o = vec4(lin(vColor.rgb), vColor.a);
  } else {
    vec4 t = texture(uAlb, vUV / uAtlas);
    if (t.a < 0.5) discard;
    o = vec4(lin(t.rgb * vColor.rgb), vColor.a);
  }
}`;

// HDR (k-res) -> native radiance, plus last frame's GI for a cheap second bounce.
export const RADIANCE_FS = `${HEAD}${COMMON}
uniform sampler2D uHDR; uniform sampler2D uGA; uniform sampler2D uGX; uniform sampler2D uHist;
uniform float uK; uniform float uBounce;
out vec4 o;
void main(){
  ivec2 ip = ivec2(gl_FragCoord.xy);
  vec2 c = (vec2(ip) + 0.5) / uNative;
  vec2 tx = 1.0 / (uNative * uK);
  float q = uK * 0.25;
  vec3 s = texture(uHDR, c + tx * vec2(-q, -q)).rgb + texture(uHDR, c + tx * vec2(q, -q)).rgb
         + texture(uHDR, c + tx * vec2(-q, q)).rgb + texture(uHDR, c + tx * vec2(q, q)).rgb;
  s *= 0.25;
  vec4 X = texelFetch(uGX, ip, 0);
  if (int(X.g * 255.0 + 0.5) == 5) { o = vec4(0.0); return; }
  vec3 alb = pow(texelFetch(uGA, ip, 0).rgb, vec3(2.2));
  s += alb * texelFetch(uHist, ip, 0).rgb * uBounce;
  o = vec4(min(s, vec3(16.0)), 1.0);
}`;

// Ray-traced ambient occlusion over the height field: 8 jittered rays per pixel, accumulated over
// frames. Stored in .a; the bounce light itself comes from the radiance cascades.
export const GI_FS = `${HEAD}${COMMON}${GBUF_READ}${HIST}
uniform sampler2D uHist; uniform float uFrame; uniform float uBlend; uniform vec4 uField;
out vec4 o;
void main(){
  ivec2 ip = ivec2(gl_FragCoord.xy);
  vec2 sp = vec2(ip) + 0.5;
  vec4 X = texelFetch(uGX, ip, 0);
  if (matAt(X) == 5) { o = vec4(0.0, 0.0, 0.0, 1.0); return; }
  float h = X.r * HPX;
  float jit = hash12(sp + fract(uFrame * 0.6180339) * 113.0);
  float vis = 0.0;
  for (int r = 0; r < 8; r++) {
    float a = (float(r) + jit) * 0.7853982;
    vec2 dir = vec2(cos(a), sin(a));
    float t = 1.0 + jit;
    float st = 1.0;
    float v = 1.0;
    for (int s = 0; s < 11; s++) {
      vec2 q = sp + dir * t;
      if (q.x < uField.x || q.y < uField.y || q.x > uField.x + uField.z || q.y > uField.y + uField.w) break;
      if (H(q) > h + 1.0 + t * 0.06) {
        v = smoothstep(0.0, 26.0, t);
        break;
      }
      t += st;
      st *= 1.27;
    }
    vis += v;
  }
  vec4 cur = vec4(0.0, 0.0, 0.0, vis / 8.0);
  ivec2 hp;
  o = histAt(ip, hp) ? mix(texelFetch(uHist, hp, 0), cur, uBlend) : cur;
}`;

// Glossy reflections for water, ice, steel and puddles: march "up" the screen through the height
// field, mirror what we hit, fall back to sky. Temporally accumulated so the roughness jitter smooths out.
export const REFL_FS = `${HEAD}${COMMON}${GBUF_READ}${HIST}
uniform sampler2D uRad; uniform sampler2D uHist; uniform float uFrame; uniform float uBlend; uniform vec3 uSky; uniform vec4 uField;
out vec4 o;
void main(){
  ivec2 ip = ivec2(gl_FragCoord.xy);
  vec2 sp = vec2(ip) + 0.5;
  vec4 X = texelFetch(uGX, ip, 0);
  ivec2 hp;
  bool hok = histAt(ip, hp);
  vec4 hist = texelFetch(uHist, hp, 0);
  float rf = X.b;
  if (rf < 0.01 || matAt(X) == 5) { o = vec4(0.0); return; }
  float h = X.r * HPX;
  vec3 N = nrm(ip);
  float j = hash12(sp + fract(uFrame * 0.7548777) * 71.0) - 0.5;
  float rough = X.a;
  vec2 dir = normalize(vec2(N.x * 1.5 + j * rough * 1.6, -1.0));
  vec2 p = sp + N.xy * 2.5;
  vec3 col = uSky * (0.6 + 0.4 * smoothstep(0.0, 1.0, -N.y + 0.5));
  for (int i = 1; i <= 26; i++) {
    float t = float(i) * 1.5;
    vec2 q = p + dir * t;
    if (q.y < uField.y) break;
    float hq = H(q);
    if (hq > h + t * 0.45) {
      vec2 m = min(q + dir * min(t, hq * 1.2), uLimit - 0.5);
      col = texture(uRad, m / uNative).rgb / (1.0 + t * 0.015);
      break;
    }
  }
  o = vec4(hok ? mix(hist.rgb, col, uBlend) : col, 1.0);
}`;

// Adds ambient (with ray-traced AO + fine contact AO), bounce light and reflections into HDR.
export const COMPOSITE_FS = `${HEAD}${COMMON}${GBUF_READ}
uniform sampler2D uGI; uniform sampler2D uRefl; uniform sampler2D uRC; uniform float uK; uniform vec3 uAmbient;
uniform float uGIStr; uniform float uRTX; uniform float uPixel;
out vec4 o;
void main(){
  vec2 sp = gl_FragCoord.xy / uK;
  if (uPixel > 0.5) sp = floor(sp) + 0.5;
  ivec2 ip = ivec2(sp);
  vec4 X = texelFetch(uGX, ip, 0);
  if (matAt(X) == 5) discard;
  vec3 alb = pow(texelFetch(uGA, ip, 0).rgb, vec3(2.2));
  float h = X.r * HPX;
  float ao = 0.0;
  for (int i = 0; i < 8; i++) {
    float ang = float(i) * 0.785398;
    ao += clamp((H(sp + vec2(cos(ang), sin(ang)) * 2.5) - h) * 0.22, 0.0, 1.0);
  }
  ao = 1.0 - ao / 8.0 * 0.85;
  vec3 col;
  if (uRTX > 0.5) {
    float vis = texture(uGI, sp / uNative).a;
    vec3 rc = texture(uRC, sp / uNative).rgb;
    col = alb * (uAmbient * ao * mix(0.3, 1.0, vis) + rc * uGIStr);
    col += texture(uRefl, sp / uNative).rgb * X.b;
  } else {
    col = alb * uAmbient * ao;
  }
  o = vec4(col, 1.0);
}`;

// Fluid smoke over the lit scene: lit by ambient, sun and every point light that reaches the air,
// with glowing fire where explosions are still burning. Blend: ONE, ONE_MINUS_SRC_ALPHA.
export const SMOKE_FS = `${HEAD}
uniform sampler2D uDye; uniform sampler2D uSmokeL; uniform vec2 uNative; uniform float uK; uniform float uPixel;
uniform vec3 uAmbient; uniform vec3 uSunCol;
out vec4 o;
void main(){
  vec2 sp = gl_FragCoord.xy / uK;
  if (uPixel > 0.5) sp = floor(sp) + 0.5;
  vec4 d = texture(uDye, sp / uNative);
  float a = min(0.9, 1.0 - exp(-d.r * 1.5));
  float f = d.b;
  if (a < 0.003 && f < 0.003) discard;
  vec2 ts = 1.0 / (uNative * uK);
  vec2 kc = gl_FragCoord.xy;
  vec3 inL = (texture(uSmokeL, kc * ts).rgb * 2.0
    + texture(uSmokeL, (kc + vec2(uK, uK)) * ts).rgb + texture(uSmokeL, (kc + vec2(-uK, uK)) * ts).rgb
    + texture(uSmokeL, (kc + vec2(uK, -uK)) * ts).rgb + texture(uSmokeL, (kc - vec2(uK, uK)) * ts).rgb) / 6.0;
  vec3 lit = vec3(0.3, 0.29, 0.28) * (uAmbient * 1.3 + uSunCol * 0.45) + inL * 0.32;
  vec3 fire = vec3(1.0, 0.42, 0.1) * f * 2.2 + vec3(1.0, 0.85, 0.55) * max(f - 0.7, 0.0) * 5.0;
  o = vec4(lit * a + fire, a);
}`;

export const PREFILTER_FS = `${HEAD}
uniform sampler2D uSrc; uniform vec2 uTexel; uniform float uThreshold; uniform vec2 uScale;
in vec2 vUV; out vec4 o;
void main(){
  vec2 uv = vUV * uScale; // the screen part of the HDR (it has a guard on the right/bottom)
  vec3 c = texture(uSrc, uv + uTexel * vec2(-0.5, -0.5)).rgb + texture(uSrc, uv + uTexel * vec2(0.5, -0.5)).rgb
         + texture(uSrc, uv + uTexel * vec2(-0.5, 0.5)).rgb + texture(uSrc, uv + uTexel * vec2(0.5, 0.5)).rgb;
  c *= 0.25;
  float br = max(c.r, max(c.g, c.b));
  float knee = uThreshold * 0.5;
  float soft = clamp(br - uThreshold + knee, 0.0, 2.0 * knee);
  soft = soft * soft / (4.0 * knee + 1e-4);
  float w = max(soft, br - uThreshold) / max(br, 1e-4);
  o = vec4(c * w, 1.0);
}`;

export const DOWN_FS = `${HEAD}
uniform sampler2D uSrc; uniform vec2 uTexel;
in vec2 vUV; out vec4 o;
void main(){
  vec3 s = texture(uSrc, vUV).rgb * 4.0;
  s += texture(uSrc, vUV + uTexel * vec2(-1.0, -1.0)).rgb;
  s += texture(uSrc, vUV + uTexel * vec2(1.0, -1.0)).rgb;
  s += texture(uSrc, vUV + uTexel * vec2(-1.0, 1.0)).rgb;
  s += texture(uSrc, vUV + uTexel * vec2(1.0, 1.0)).rgb;
  o = vec4(s / 8.0, 1.0);
}`;

export const UP_FS = `${HEAD}
uniform sampler2D uSrc; uniform vec2 uTexel;
in vec2 vUV; out vec4 o;
void main(){
  vec2 h = uTexel;
  vec3 s = texture(uSrc, vUV + vec2(-h.x * 2.0, 0.0)).rgb;
  s += texture(uSrc, vUV + vec2(-h.x, h.y)).rgb * 2.0;
  s += texture(uSrc, vUV + vec2(0.0, h.y * 2.0)).rgb;
  s += texture(uSrc, vUV + vec2(h.x, h.y)).rgb * 2.0;
  s += texture(uSrc, vUV + vec2(h.x * 2.0, 0.0)).rgb;
  s += texture(uSrc, vUV + vec2(h.x, -h.y)).rgb * 2.0;
  s += texture(uSrc, vUV + vec2(0.0, -h.y * 2.0)).rgb;
  s += texture(uSrc, vUV + vec2(-h.x, -h.y)).rgb * 2.0;
  o = vec4(s / 12.0, 1.0);
}`;

export const FINAL_FS = `${HEAD}
uniform sampler2D uHDR; uniform sampler2D uBloom; uniform sampler2D uGlow;
uniform vec2 uCanvas; uniform vec4 uView; uniform vec2 uNative; uniform vec4 uField;
uniform float uTime; uniform float uBloomStr; uniform float uExposure; uniform float uCRT; uniform float uAberr;
uniform vec3 uFlash; uniform vec2 uShake; uniform vec3 uGradeLo; uniform vec3 uGradeHi; uniform float uSat;
uniform vec3 uBackdrop; uniform float uFeather;
uniform sampler2D uDye; uniform float uPixel; uniform float uHaze; uniform vec3 uHorizon;
uniform vec4 uShock[8]; uniform int uShockN;
uniform vec2 uSub; uniform vec2 uScroll; // sub-pixel camera offset (native px), whole-px scroll
uniform vec2 uBuf; // size of the HDR and dye buffers in native px (the screen plus a guard right/bottom)
uniform vec2 uLitMax; // last lit HDR texel centre, native px (screen, + 1 px while uSub is nonzero)
uniform sampler2D uOv; // the top overlay: premultiplied linear colour, native px, laid over the graded image
out vec4 o;
vec3 aces(vec3 x){ return clamp((x * (2.51 * x + 0.03)) / (x * (2.43 * x + 0.59) + 0.14), 0.0, 1.0); }
vec2 curve(vec2 uv){ uv = uv * 2.0 - 1.0; vec2 off = abs(uv.yx) / vec2(5.5, 4.5); uv = uv + uv * off * off; return uv * 0.5 + 0.5; }
vec3 grade(vec3 c){
  float l = dot(c, vec3(0.2126, 0.7152, 0.0722));
  c = mix(vec3(l), c, uSat);
  return c * mix(uGradeLo, uGradeHi, smoothstep(0.05, 0.75, l));
}
float rnd(vec2 p){ return fract(sin(dot(p, vec2(12.9898, 78.233))) * 43758.5453); }
float bayer4(vec2 p){
  ivec2 q = ivec2(mod(p, 4.0));
  int b[16] = int[16](0, 8, 2, 10, 12, 4, 14, 6, 3, 11, 1, 9, 15, 7, 13, 5);
  return (float(b[q.x + q.y * 4]) + 0.5) / 16.0;
}
void main(){
  vec2 fc = vec2(gl_FragCoord.x, uCanvas.y - gl_FragCoord.y);
  vec2 uv = (fc - uView.xy) / uView.zw;
  if (uCRT > 0.5) uv = curve(uv);
  vec2 sp0 = uv * uNative;
  vec2 fmin = uField.xy;
  vec2 fmax = uField.xy + uField.zw;
  vec3 c;
  if (sp0.x < fmin.x || sp0.y < fmin.y || sp0.x > fmax.x || sp0.y > fmax.y) {
    // backdrop: dark, with the arena's light spilling outward (ambilight)
    vec2 cp = clamp(sp0, fmin, fmax);
    float d = length(sp0 - cp);
    vec3 glow = texture(uGlow, cp / uNative).rgb;
    c = uBackdrop * (1.0 - smoothstep(0.0, 260.0, length(sp0 - (fmin + fmax) * 0.5)) * 0.5);
    c += min(glow, vec3(1.5)) * 0.28 * exp(-d * 0.045) + texture(uBloom, clamp(sp0 / uNative, 0.0, 1.0)).rgb * uBloomStr * 0.35;
    c = aces(c * uExposure);
    c = grade(c);
  } else {
    // the lit image is one px larger than the field on the right/bottom while uSub is nonzero
    vec2 sp = sp0 + uShake + uSub;
    vec2 so = sp; // the top overlay moves with the world but skips shockwaves, heat haze and fringes
    for (int i = 0; i < 8; i++) {
      if (i >= uShockN) break;
      vec4 s = uShock[i];
      vec2 d = sp - s.xy;
      float r = length(d);
      float ring = 1.0 - smoothstep(0.0, 7.0, abs(r - s.z));
      sp -= (d / max(r, 0.001)) * ring * s.w;
    }
    float heat = texture(uDye, min(sp, uLitMax) / uBuf).g;
    vec2 wp = sp + uScroll;
    if (heat > 0.002) sp += vec2(sin(uTime * 13.0 + wp.y * 1.3), cos(uTime * 11.0 + wp.x * 1.1)) * min(heat, 1.5) * uHaze;
    if (uPixel > 0.5) sp = floor(sp) + 0.5;
    // samples stay inside the lit image (clamp-to-edge as if the HDR ended there, not in the guard)
    vec2 dir = sp / uNative - 0.5;
    vec2 off = dir * uAberr * 0.006 * (0.4 + length(dir)) * uNative;
    c.r = texture(uHDR, min(sp + off, uLitMax) / uBuf).r;
    c.g = texture(uHDR, min(sp, uLitMax) / uBuf).g;
    c.b = texture(uHDR, min(sp - off, uLitMax) / uBuf).b;
    c += texture(uBloom, sp / uNative).rgb * uBloomStr; // bloom covers the screen only, no guard
    // distant fires: a warm glow along the top edge (and faintly the sides), breathing slowly, anchored to the world
    if (uHorizon.r > 0.0) {
      float wx = (sp0.x + uScroll.x) * 0.021;
      float beat = 0.62 + 0.22 * sin(wx * 1.7 + uTime * 0.6) + 0.16 * sin(wx * 4.3 - uTime * 1.3 + sin(uTime * 0.37) * 2.0);
      float side = min(sp0.x - fmin.x, fmax.x - sp0.x);
      c += uHorizon * (beat * exp(-(sp0.y - fmin.y) / 34.0) + 0.35 * exp(-side / 26.0) * (0.7 + 0.3 * beat));
    }
    c = c * uExposure + uFlash;
    c = aces(c);
    c = grade(c);
    vec4 ov = texture(uOv, min(floor(so) + 0.5, uLitMax) / uBuf);
    c = c * (1.0 - ov.a) + ov.rgb;
    vec2 vv = uv - 0.5;
    c *= 1.0 - dot(vv, vv) * 0.45;
    if (uFeather > 0.0) {
      vec2 e = min(sp0 - fmin, fmax - sp0);
      float k = smoothstep(0.0, uFeather, min(e.x, e.y));
      c = mix(aces(uBackdrop * uExposure), c, k);
    }
  }
  if (uCRT > 0.5) {
    float sl = 0.5 + 0.5 * cos(uv.y * uNative.y * 6.2831853);
    c *= 0.72 + 0.28 * sl;
    float m = mod(fc.x, 3.0);
    vec3 mask = vec3(m < 1.0 ? 1.0 : 0.78, (m >= 1.0 && m < 2.0) ? 1.0 : 0.78, m >= 2.0 ? 1.0 : 0.78);
    c *= mask * 1.18;
  }
  c = pow(max(c, 0.0), vec3(1.0 / 2.2));
  c += (rnd(fc + fract(uTime) * 91.0) - 0.5) * 0.022;
  o = vec4(c, 1.0);
}`;
