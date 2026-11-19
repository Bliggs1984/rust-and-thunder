// Region 5 "Winter front": snowy fields under the snow env. A frozen river (ice a tank can cross, with holes of open
// water blown in it) runs the length of the map; a long front road runs edge to edge on the player's side; trench
// lines of broken brick, dug-in positions, forests, frozen ponds, 4 villages and the depots fill the land. Near the
// far edge the enemy holds a fortified lair: an open arena ringed by a broken trench, tank traps and bunkers, where
// the final fight happens (`lair` = its centre).
import { BRICK, EMPTY, GK_CONCRETE, GK_CROPS, GK_TRENCH, GK_VERT, ICE, ROAD, STEEL, WATER } from '../constants';
import { building } from './build';
import type { RegionSpec } from '../region';
import { Farm, vnoise, type Rect } from './gen';

const VILLAGE_NAMES = [
  'SNIHURIVKA', 'MOROZIVKA', 'ZYMNYKY', 'BILOSNIZHNE', 'KRYZHANE', 'INIIVKA', 'HOLODNYI YAR', 'ZAMETIL', 'VIKHOLY',
  'SVITANOK', 'LEDOVE', 'TYKHA PRYSTAN',
];

export class Winter extends Farm {
  override regionName = 'WINTER FRONT';
  override env = 'snow' as const;
  override boss = 'final' as const;
  override townNames = VILLAGE_NAMES;
  override fordChance = 0;
  /** the fortified lair (cells) and the side of the map the player starts on (v: 0 = low edge, 1 = high edge) */
  lair: Rect = { x: 0, y: 0, w: 0, h: 0 };
  pSide = 0;
  /** trench lines (u range, base v) for the dug-in positions */
  trenches: [number, number, number][] = [];

  override barrier(t: number): boolean { return t === WATER || t === ICE; }

  /** Winter fields: most lie fallow under the snow, some still show last year's furrows. */
  override cropField(r: Rect): void {
    if (this.rng() < 0.3) this.kind(r.x + 3, r.y + 3, r.w - 6, r.h - 6, GK_CROPS | (this.rng() < 0.5 ? GK_VERT : 0), true);
  }

  // ---------- frozen river ----------
  override terrain(): void {
    this.makeRiver();
    const { W, H } = this;
    for (let i = 0; i < W * H; i++) if (this.c[i] === WATER) this.c[i] = ICE;
    // holes of open water blown in the ice, away from the banks
    const U = this.horiz ? W : H;
    const n = this.ri(4, 7);
    for (let k = 0; k < n; k++) {
      const u = this.ri(10, U - 11);
      const v = (this.rTop[u] + this.rBot[u]) / 2;
      const r = 1.5 + this.rng() * 1.5;
      for (let dv = -3; dv <= 3; dv++) for (let du = -4; du <= 4; du++) {
        if ((du * du) / (r * r * 1.6) + (dv * dv) / (r * r) > 1) continue;
        const uu = u + du;
        const vv = Math.round(v + dv);
        if (uu < 0 || uu >= U || vv <= this.rTop[uu] || vv >= this.rBot[uu] - 1) continue;
        this.setUV(uu, vv, WATER);
      }
    }
  }

  override townCount(fit: number): number { return Math.min(4, fit); }
  override minTowns(fit: number): number { return Math.min(3, fit); }

  // ---------- player entry, the front road and the lair ----------
  override placeEntry(): boolean {
    if (!super.placeEntry()) return false;
    const e0 = this.entry[0];
    const V = this.horiz ? this.H : this.W;
    const U = this.horiz ? this.W : this.H;
    this.pSide = (this.horiz ? this.ny(e0) : this.nx(e0)) === 0 ? 0 : 1;
    // the lair: an arena near the far edge, away from the river
    const lw = 64;
    const lh = 48;
    let placed = false;
    for (let tries = 0; tries < 30 && !placed; tries++) {
      const u0 = this.even(this.ri(Math.round(U * 0.25), Math.round(U * 0.75) - lw));
      const v0 = this.pSide === 0 ? V - 8 - lh - this.even(this.ri(0, 6)) : 8 + this.even(this.ri(0, 6));
      const r = this.rectUV(u0, v0, lw, lh);
      if (this.rectHasWater(r, 5)) continue;
      this.lair = r;
      placed = true;
    }
    if (!placed) return false;
    this.reserved.push(this.lair);
    this.blockRect(this.lair, -2);
    // a road from the lair's middle out through the side facing the player
    const L = this.lair;
    const cn = this.node((L.x + L.w / 2 - 2) >> 1, (L.y + L.h / 2 - 2) >> 1);
    const dOut = this.horiz ? (this.pSide === 0 ? 0 : 2) : this.pSide === 0 ? 3 : 1;
    const steps = (this.horiz ? lh : lw) / 4 + 4;
    const lane = this.line(this.nx(cn), this.ny(cn), dOut, steps);
    if (lane.some((n) => !this.inNodes(this.nx(n), this.ny(n)) || this.nodeBarrier(n) || this.lane[n])) return false;
    const s = this.newSite('lair', lane[lane.length - 1]);
    this.layPath(lane, s);
    // the front road: edge to edge across the map on the player's side of the river, through two waypoints
    const NU = this.horiz ? this.NX : this.NY;
    let vMid = 0;
    for (let u = 0; u < U; u += 8) vMid += this.pSide === 0 ? this.rTop[u] : this.rBot[u];
    vMid /= Math.ceil(U / 8);
    const vEdge = this.pSide === 0 ? 0 : V;
    const vn = Math.round(((vEdge + vMid) / 2) / 2);
    const wp = (f: number) => this.uvNode(Math.round(NU * f), Math.max(4, Math.min((V >> 1) - 6, vn + this.ri(-6, 6))));
    const stubA = this.edgeLane(this.horiz ? 3 : 0, Math.max(4, Math.min((V >> 1) - 6, vn + this.ri(-4, 4))), 3);
    const stubB = this.edgeLane(this.horiz ? 1 : 2, Math.max(4, Math.min((V >> 1) - 6, vn + this.ri(-4, 4))), 3);
    if ([...stubA, ...stubB].some((n) => this.nodeBarrier(n) || this.lane[n])) return false;
    const site = this.newSite('front', stubA[stubA.length - 1]);
    this.layPath(stubA, site);
    let from = [stubA[stubA.length - 1]];
    for (const target of [wp(0.36), wp(0.66), stubB[stubB.length - 1]]) {
      const goal = target;
      if (this.blocked[goal] && !this.lane[goal]) return false;
      const path = this.route(from, (n) => n === goal, goal);
      if (!path) return false;
      this.layPath(path, site);
      from = [goal];
    }
    this.layPath([...stubB].reverse(), site);
    // its ends are where enemy columns drive in from the flanks
    const pn = this.playerNode();
    for (const st of [stubA, stubB]) {
      const end = st[st.length - 1];
      if (Math.abs(this.nx(end) - this.nx(pn)) + Math.abs(this.ny(end) - this.ny(pn)) >= 40) this.exits.push(st);
    }
    return true;
  }

  /** The front road's flank ends come first; then 2-3 more exits as usual (the far edge first). */
  override placeExits(): boolean {
    const flanks = this.exits;
    this.exits = [];
    const ok = super.placeExits();
    this.exits.push(...flanks);
    return ok;
  }

  // ---------- dressing ----------
  override dress(): void {
    const { W, H } = this;
    this.protectNear(ROAD, 1);
    this.buildLair();
    const seed = (this.rng() * 1e9) | 0;
    // frozen ponds with a ring of trees
    for (let k = 0; k < this.ri(2, 4); k++) {
      for (let tries = 0; tries < 40; tries++) {
        const rx = this.ri(4, 8);
        const ry = this.ri(3, 6);
        const px = this.ri(rx + 8, W - rx - 8);
        const py = this.ri(ry + 8, H - ry - 8);
        if (!this.free(px - rx - 4, py - ry - 4, 2 * rx + 9, 2 * ry + 9)) continue;
        for (let y = -ry - 2; y <= ry + 2; y++) for (let x = -rx - 2; x <= rx + 2; x++) {
          const e = (x * x) / (rx * rx) + (y * y) / (ry * ry);
          if (e <= 1) this.set(px + x, py + y, ICE);
          else if (e <= 1.8 && Math.sin(Math.atan2(y, x) * 2 + px) > 0.1) this.plant(px + x, py + y);
        }
        this.protect(px - rx - 3, py - ry - 3, 2 * rx + 7, 2 * ry + 7);
        break;
      }
    }
    this.trenchLines();
    this.dugIn();
    // forests: dark blocks of pine where the noise is high, thinner copses elsewhere
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        const n = vnoise(x / 24, y / 24, seed) * 0.7 + vnoise(x / 6, y / 6, seed + 3) * 0.3;
        if (n > 0.66) this.plant(x, y);
      }
    }
    this.roadsideTrees();
    this.fields({ x: 0, y: 0, w: W, h: H }, 1);
  }

  /** Brick (or steel) on free, unprotected ground only, in river space. */
  putUV(u0: number, v0: number, lu: number, lv: number, t: number): void {
    for (let v = v0; v < v0 + lv; v++) for (let u = u0; u < u0 + lu; u++) {
      const [x, y] = this.uv(u, v);
      this.put(x, y, t);
    }
  }

  /**
   * The fortified line: three trench systems along the front. Each is a run of bays 12-20 cells long: a sandbag
   * parapet (brick, 2 cells thick) on the side facing the player and a tank-wide trench floor behind it, every bay
   * stepped 2 cells forward or back from the last (the traverses). Every 2-4 bays the line is cut by a gap 8 cells
   * wide with steel tank traps out in front; some bays begin with a pillbox (steel corners, concrete floor, its door to
   * the rear). Roads and other protected ground pass straight through.
   */
  trenchLines(): void {
    const U = this.horiz ? this.W : this.H;
    const V = this.horiz ? this.H : this.W;
    // v bands: two on the enemy's side of the river, one each side of the front road on the player's side
    const vRiver = (u: number) => (this.pSide === 0 ? this.rBot[u] : this.rTop[u]);
    const rear = this.pSide === 0 ? 1 : -1; // from a parapet back towards the enemy's edge
    const lines: { off: (u: number) => number; u0: number; u1: number }[] = [];
    for (let k = 0; k < 2; k++) {
      const d = 12 + k * this.ri(14, 20);
      const u0 = this.ri(4, Math.round(U * 0.3));
      const u1 = this.ri(Math.round(U * 0.6), U - 4);
      lines.push({ off: (u) => vRiver(Math.max(0, Math.min(U - 1, u))) + rear * d, u0, u1 });
    }
    const vp = this.pSide === 0 ? Math.round(V * 0.22) : Math.round(V * 0.78);
    const u0 = this.ri(10, Math.round(U * 0.4));
    lines.push({ off: () => vp, u0, u1: Math.min(U - 4, u0 + this.ri(70, 130)) });
    const floorKind = GK_TRENCH | (this.horiz ? 0 : GK_VERT);
    const rearSide = this.horiz ? (rear > 0 ? 2 : 0) : rear > 0 ? 1 : 3;
    for (const ln of lines) {
      let u = this.even(ln.u0);
      let step = 0;
      let bays = this.ri(2, 4);
      let first = true;
      let prevPv = 0;
      // each stretch between two gaps is dug along one straight line; the next stretch picks up the river again
      let base = this.even(ln.off(u + bays * 8));
      while (u < ln.u1 - 8) {
        const len = Math.min(2 * this.ri(6, 10), (ln.u1 - u) & ~1);
        const v = base + (step ? 2 : 0);
        const pv = rear > 0 ? v : v + 4; // parapet rows pv, pv + 1
        const tv = rear > 0 ? v + 2 : v; // trench floor, 4 cells deep
        let from = u;
        // a pillbox at the head of the bay, flush with the parapet
        const bv = rear > 0 ? pv : pv - 6;
        if (len >= 14 && this.rng() < 0.4 && this.freeUV(u, bv, 8, 8)) {
          building(this, this.rectUV(u, bv, 8, 8), GK_CONCRETE, [{ side: rearSide, at: 2 }], true);
          from = u + 8;
        } else if (!first && prevPv !== pv) {
          // make the step solid without blocking the trench: the parapet nearer the player runs 2 cells on
          if (rear > 0 ? prevPv < pv : prevPv > pv) this.putUV(u, prevPv, 2, 2, BRICK);
          else from = u - 2;
        }
        this.putUV(from, pv, u + len - from, 2, BRICK);
        const fr = this.rectUV(u, tv, len, 4);
        this.kind(fr.x, fr.y, fr.w, fr.h, floorKind, true);
        this.protectUV(u, v, len, 6); // no trees in the trench
        u += len;
        step ^= 1;
        first = false;
        prevPv = pv;
        if (--bays <= 0) {
          // the gap, with a pair of tank traps out in front of it
          const tvv = rear > 0 ? pv - 6 : pv + 6;
          this.putUV(u - 2, tvv, 2, 2, STEEL);
          this.putUV(u + 8, tvv, 2, 2, STEEL);
          u += 8;
          bays = this.ri(2, 4);
          first = true;
          base = this.even(ln.off(u + bays * 8));
        }
      }
      this.trenches.push([ln.u0, ln.u1, Math.round(ln.off((ln.u0 + ln.u1) >> 1))]);
    }
  }

  /** Tank revetments behind the trench lines: a U of brick 2 cells thick round a tank-sized pit, open to the rear. */
  dugIn(): void {
    let made = 0;
    const rear = this.pSide === 0 ? 1 : -1; // the defenders face the player; their rear points away
    for (let tries = 0; tries < 300 && made < 10; tries++) {
      const t = this.trenches[this.ri(0, this.trenches.length - 1)];
      if (!t) break;
      const u = this.even(this.ri(t[0], t[1] - 8));
      const v = this.even(t[2] + rear * this.ri(12, 18) - (rear < 0 ? 8 : 0));
      if (!this.freeUV(u - 2, v - 2, 12, 12)) continue;
      const fr = this.rectUV(u, v, 8, 8);
      this.kind(fr.x, fr.y, fr.w, fr.h, GK_TRENCH | (this.horiz ? GK_VERT : 0));
      this.fillUV(u, rear > 0 ? v : v + 6, 8, 2, BRICK);
      this.fillUV(u, v, 2, 8, BRICK);
      this.fillUV(u + 6, v, 2, 8, BRICK);
      this.protectUV(u - 2, v - 2, 12, 12);
      made++;
    }
  }

  /** The fortified lair: a broken trench ring with gaps, tank traps on the approach, bunkers at the back. */
  buildLair(): void {
    const L = this.lair;
    const inner = { x: L.x + 6, y: L.y + 6, w: L.w - 12, h: L.h - 12 };
    this.protect(inner.x, inner.y, inner.w, inner.h);
    // the ring wall 2 cells in from the edge: brick 2 cells thick, an 8-cell gateway in the middle of every side and a
    // tank-wide breach or two shot through each, steel bastions on the corners
    const ringX0 = L.x + 2;
    const ringY0 = L.y + 2;
    const ringX1 = L.x + L.w - 4;
    const ringY1 = L.y + L.h - 4;
    const holes = (len: number): number[] => {
      const out = [this.even(len / 2) - 4, this.even(len / 2) - 2, this.even(len / 2), this.even(len / 2) + 2];
      for (let k = 0; k < this.ri(1, 2); k++) { const a = 2 * this.ri(4, (len >> 1) - 6); out.push(a, a + 2); }
      return out;
    };
    for (const y of [ringY0, ringY1]) {
      const hs = holes(L.w - 4);
      for (let a = 0; a < L.w - 4; a += 2) if (!hs.includes(a)) for (let j = 0; j < 2; j++) for (let i = 0; i < 2; i++) this.put(ringX0 + a + i, y + j, BRICK);
    }
    for (const x of [ringX0, ringX1]) {
      const hs = holes(L.h - 4);
      for (let a = 0; a < L.h - 4; a += 2) if (!hs.includes(a)) for (let j = 0; j < 2; j++) for (let i = 0; i < 2; i++) this.put(x + i, ringY0 + a + j, BRICK);
    }
    for (const [bx, by] of [[ringX0, ringY0], [ringX1 - 2, ringY0], [ringX0, ringY1 - 2], [ringX1 - 2, ringY1 - 2]]) {
      for (let j = 0; j < 4; j++) for (let i = 0; i < 4; i++) if (this.at(bx + i, by + j) !== ROAD) this.set(bx + i, by + j, STEEL);
    }
    // tank traps (steel hedgehogs) in a loose row outside the ring, on the three sides facing away from the far edge
    const farEdge = this.horiz ? (this.pSide === 0 ? 2 : 0) : this.pSide === 0 ? 1 : 3;
    for (let d = 0; d < 4; d++) {
      if (d === farEdge) continue;
      const len = d === 0 || d === 2 ? L.w : L.h;
      for (let a = 4; a < len - 4; a += this.ri(6, 9)) {
        if (Math.abs(a - len / 2) < 8) continue;
        const x = d === 0 || d === 2 ? L.x + a : d === 1 ? L.x + L.w + 2 : L.x - 4;
        const y = d === 1 || d === 3 ? L.y + a : d === 2 ? L.y + L.h + 2 : L.y - 4;
        if (this.free(x, y, 2, 2)) this.fill(x, y, 2, 2, STEEL);
      }
    }
    // two bunkers (steel with brick sides) in the back corners, an emplacement each side of the gate
    const back = farEdge;
    const corners: [number, number][] = back === 0 ? [[L.x + 7, L.y + 7], [L.x + L.w - 13, L.y + 7]]
      : back === 2 ? [[L.x + 7, L.y + L.h - 11], [L.x + L.w - 13, L.y + L.h - 11]]
        : back === 3 ? [[L.x + 7, L.y + 7], [L.x + 7, L.y + L.h - 11]] : [[L.x + L.w - 11, L.y + 7], [L.x + L.w - 11, L.y + L.h - 13]];
    for (const [x, y] of corners) {
      this.fill(x, y, 6, 4, STEEL);
      this.fill(x - 2, y, 2, 4, BRICK);
      this.fill(x + 6, y, 2, 4, BRICK);
    }
  }

  override extra(spec: RegionSpec): void {
    const L = this.lair;
    spec.lair = [(L.x + L.w / 2) * 4, (L.y + L.h / 2) * 4];
  }
}
