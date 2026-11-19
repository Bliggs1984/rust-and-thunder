// Railway geometry for the renderer (visual only: the rules read the RAIL cells and RegionSpec.rail, never this).
// The generators know every track's exact centre line (RegionSpec.tracks). bakeRailGeo turns them into two texels
// per map cell: for each of the two tracks nearest the cell's centre, the track's direction there, the signed
// distance of the cell centre from it and the arc length along it. The terrain shader (GBUFFER_FS, railAt) extends
// that straight across the 4 px cell, so the rails come out as smooth pixel lines and the sleepers lie square to
// the track at a steady spacing, however the cells step.
import type { RegionSpec } from './region';

/** One track's centre line as a polyline of px points. The sleepers are spaced along `s0 + sk * arc length`. */
export interface RailTrack { pts: [number, number][]; s0?: number; sk?: number }

/** px from a cell's centre within which a track is recorded for it */
const REACH = 15;
/** "no track" marker in the distance channel */
export const RAIL_NONE = 1e4;

/**
 * w*2 x h texels of 4 floats, row-major: texel (x, y) = the nearest track at cell (x, y), texel (x + w, y) = the
 * second nearest. Each is (tx, ty, d, s): the unit direction along the track, the cell centre's distance from the
 * centre line measured along (-ty, tx), and the arc length at the nearest point. d = RAIL_NONE where there is none.
 */
export function bakeRailGeo(w: number, h: number, tracks: RailTrack[]): Float32Array {
  const out = new Float32Array(w * 2 * h * 4);
  for (let i = 2; i < out.length; i += 4) out[i] = RAIL_NONE;
  const best = new Float32Array(w * h);
  const cand = new Float32Array(w * h * 4);
  for (const t of tracks) {
    const P = t.pts;
    if (P.length < 2) continue;
    best.fill(1e9);
    const touched: number[] = [];
    let cum = 0;
    for (let k = 0; k + 1 < P.length; k++) {
      const [ax, ay] = P[k];
      const [bx, by] = P[k + 1];
      const L = Math.hypot(bx - ax, by - ay);
      if (L < 1e-6) continue;
      const ux = (bx - ax) / L;
      const uy = (by - ay) / L;
      const first = k === 0;
      const last = k + 2 === P.length;
      const x0 = Math.max(0, Math.floor((Math.min(ax, bx) - REACH) / 4));
      const x1 = Math.min(w - 1, Math.floor((Math.max(ax, bx) + REACH) / 4));
      const y0 = Math.max(0, Math.floor((Math.min(ay, by) - REACH) / 4));
      const y1 = Math.min(h - 1, Math.floor((Math.max(ay, by) + REACH) / 4));
      for (let cy = y0; cy <= y1; cy++) {
        for (let cx = x0; cx <= x1; cx++) {
          const px = cx * 4 + 2 - ax;
          const py = cy * 4 + 2 - ay;
          let a = px * ux + py * uy; // px along the segment
          // past the end of the track: nothing there (a little is allowed so the last cells are covered)
          if ((first && a < -3) || (last && a > L + 3)) continue;
          let tx = ux;
          let ty = uy;
          let d = py * ux - px * uy; // along (-uy, ux)
          const over = a < 0 && !first ? a : a > L && !last ? a - L : 0;
          if (over !== 0) {
            // beyond an inner corner of the polyline: measured from the corner point, the track turned to match
            a = a < 0 ? 0 : L;
            const qx = px - a * ux;
            const qy = py - a * uy;
            const r = Math.hypot(qx, qy);
            if (r > 1e-3) {
              const side = d < 0 ? -1 : 1;
              tx = (side * qy) / r;
              ty = (-side * qx) / r;
              d = side * r;
            }
          }
          const ad = Math.abs(d);
          if (ad > REACH) continue;
          const i = cy * w + cx;
          if (ad >= best[i]) continue;
          if (best[i] > 1e8) touched.push(i);
          best[i] = ad;
          cand[i * 4] = tx;
          cand[i * 4 + 1] = ty;
          cand[i * 4 + 2] = d;
          cand[i * 4 + 3] = (t.s0 ?? 0) + (t.sk ?? 1) * (cum + a);
        }
      }
      cum += L;
    }
    // into the cell's two slots, nearest first
    for (const i of touched) {
      const cy = (i / w) | 0;
      const a = (cy * 2 * w + (i - cy * w)) * 4;
      const b = a + w * 4;
      const ad = best[i];
      if (ad < Math.abs(out[a + 2])) {
        out.copyWithin(b, a, a + 4);
        out.set(cand.subarray(i * 4, i * 4 + 4), a);
      } else if (ad < Math.abs(out[b + 2])) {
        out.set(cand.subarray(i * 4, i * 4 + 4), b);
      }
    }
  }
  return out;
}

const cache = new WeakMap<RegionSpec, Float32Array | null>();

/** The baked geometry of a region's railway (made once per map), or null when it has none. */
export function railGeoFor(spec: RegionSpec | null | undefined): Float32Array | null {
  if (!spec) return null;
  let g = cache.get(spec);
  if (g === undefined) {
    const tracks = spec.tracks ?? (spec.rail && spec.rail.length >= 2 ? [{ pts: spec.rail }] : []);
    g = tracks.length ? bakeRailGeo(spec.w, spec.h, tracks) : null;
    cache.set(spec, g);
  }
  return g;
}

/**
 * A polyline with its corners rounded to arcs of radius r (points about every 4 px along each arc), for
 * hand-made lines with square corners.
 */
export function roundCorners(pts: [number, number][], r: number): [number, number][] {
  const out: [number, number][] = [pts[0]];
  for (let k = 1; k + 1 < pts.length; k++) {
    const [px, py] = pts[k - 1];
    const [qx, qy] = pts[k];
    const [nx, ny] = pts[k + 1];
    const l1 = Math.hypot(qx - px, qy - py);
    const l2 = Math.hypot(nx - qx, ny - qy);
    const ax = (qx - px) / l1;
    const ay = (qy - py) / l1;
    const bx = (nx - qx) / l2;
    const by = (ny - qy) / l2;
    const turn = Math.acos(Math.max(-1, Math.min(1, ax * bx + ay * by)));
    if (turn < 0.02) { out.push(pts[k]); continue; }
    // tangent length from the corner, kept inside both legs
    const tl = Math.min(r * Math.tan(turn / 2), l1 * 0.45, l2 * 0.45);
    const rr = tl / Math.tan(turn / 2);
    const side = ax * by - ay * bx > 0 ? 1 : -1;
    const cx = qx - ax * tl - ay * side * rr;
    const cy = qy - ay * tl + ax * side * rr;
    const a0 = Math.atan2(qy - ay * tl - cy, qx - ax * tl - cx);
    const n = Math.max(2, Math.ceil((rr * turn) / 4));
    for (let i = 0; i <= n; i++) {
      const a = a0 + (side * turn * i) / n;
      out.push([cx + Math.cos(a) * rr, cy + Math.sin(a) * rr]);
    }
  }
  out.push(pts[pts.length - 1]);
  return out;
}
