# Builds the game-view backdrops for the mockups from screenshots in shots/.
# Run from the repo root: py mockups/campaign-ui/prep_bg.py [shots-dir]
#
# HUD backdrops. In campaign the native view widens (or grows taller) to the window's aspect at the same
# pixel scale, so the HUD mockups need a 400x224 native map for 16:9 and a 256x456 one for 9:16 portrait.
# They are stitched from the 256x224 region screenshots (`node tools/shot.mjs region` and `region2p`):
# - region-a/b/c are three frames of one autopilot run over the same ground, so they are laid out by their
#   measured camera offsets (b = c + (12, 17), a = c + (0, 105) native px) into one patch of real map;
# - the edges are filled from other ground (region-2p) and joined along a minimum-difference seam cut on
#   whole native pixels (image quilting), with the brightness matched, so joins run through dirt.
# Each shot is first resampled so one native pixel is exactly 4x4; output stays at 4x native and the HUD
# page scales it to the window with nearest-neighbour. The shots are re-rendered whenever the renderer
# changes, so the frames (and the offsets above) only fit the 2026-10-14 set; the PNGs in img/ are the
# record.
import sys
import numpy as np
from PIL import Image

SHOTS = sys.argv[1] if len(sys.argv) > 1 else 'shots'
OUT = 'mockups/campaign-ui/img/'
K = 4  # output px per native px
VIEW = (286, 0, 286 + 256 * 900 / 224, 900)  # the 256x224 native view inside a 1600x900 region shot


def shot(name):
    """The shot's game view as a (224*K, 256*K, 3) float array, one native px = KxK."""
    im = Image.open(f'{SHOTS}/{name}.png').convert('RGB').crop(tuple(round(v) for v in VIEW))
    return np.asarray(im.resize((256 * K, 224 * K), Image.LANCZOS)).astype(np.float32)


def up(m):
    return np.repeat(np.repeat(m, K, axis=0), K, axis=1)


def native(a):
    h, w = a.shape[0] // K, a.shape[1] // K
    return a.reshape(h, K, w, K, 3).mean(axis=(1, 3))


class Canvas:
    """Native-grid canvas: pixels at K x native, plus a native validity mask."""

    def __init__(self, w, h):
        self.w, self.h = w, h
        self.px = np.zeros((h * K, w * K, 3), np.float32)
        self.ok = np.zeros((h, w), bool)

    def _region(self, img, x, y, valid):
        """Clip a patch placed at native (x, y) to the canvas. Returns canvas slices, patch pixels, patch mask."""
        ph, pw = img.shape[0] // K, img.shape[1] // K
        if valid is None:
            valid = np.ones((ph, pw), bool)
        x0, y0, x1, y1 = max(0, x), max(0, y), min(self.w, x + pw), min(self.h, y + ph)
        sub = img[(y0 - y) * K:(y1 - y) * K, (x0 - x) * K:(x1 - x) * K]
        return (slice(y0, y1), slice(x0, x1)), sub, valid[y0 - y:y1 - y, x0 - x:x1 - x]

    def paint(self, img, x, y, valid=None, under=False):
        """Hard paste. under=True only fills cells the canvas doesn't have yet."""
        (sy, sx), sub, v = self._region(img, x, y, valid)
        take = v & ~self.ok[sy, sx] if under else v
        cur = self.px[sy.start * K:sy.stop * K, sx.start * K:sx.stop * K]
        cur[:] = np.where(up(take)[..., None], sub, cur)
        self.ok[sy, sx] |= take

    def join(self, img, x, y, side, valid=None, match=True):
        """Lay a patch next to what is there, cutting the overlap along the least-visible seam.
        side: where the patch lies relative to the canvas content: 'left', 'right', 'top' or 'bottom'."""
        (sy, sx), sub, v = self._region(img, x, y, valid)
        cur = self.px[sy.start * K:sy.stop * K, sx.start * K:sx.stop * K]
        ok = self.ok[sy, sx]
        both = ok & v
        if match and both.any():  # match the patch's brightness to the canvas over the overlap
            m = up(both)
            gain = cur[m].mean(axis=0) / np.maximum(sub[m].mean(axis=0), 1)
            sub = np.clip(sub * np.clip(gain, 0.8, 1.25), 0, 255)
        # orient so the seam runs top to bottom with the canvas on the left
        t = side in ('top', 'bottom')
        flip = side in ('left', 'top')
        def o(a):
            a = a.transpose(1, 0, *range(2, a.ndim)) if t else a
            return a[:, ::-1] if flip else a
        C, P, okC, okP = o(native(cur)), o(native(sub)), o(ok), o(v)
        h, w = okC.shape
        # path position p in row r: cells < p from the canvas, cells >= p from the patch
        INF = 1e12
        cost = np.full((h, w + 1), INF)
        diff = ((C - P) ** 2).sum(axis=2)
        for r in range(h):
            for p in range(w + 1):
                lo_bad = (~okC[r, :p] & okP[r, :p]).any()   # would take a canvas hole the patch could fill
                hi_bad = (~okP[r, p:] & okC[r, p:]).any()   # would take a patch hole the canvas could fill
                if lo_bad or hi_bad:
                    continue
                d = diff[r, max(0, p - 1):p + 1]
                cost[r, p] = d.sum() if len(d) else 0
        acc = cost.copy()
        back = np.zeros((h, w + 1), int)
        for r in range(1, h):
            for p in range(w + 1):
                lo, hi = max(0, p - 1), min(w + 1, p + 2)
                j = lo + int(np.argmin(acc[r - 1, lo:hi]))
                back[r, p] = j
                acc[r, p] = cost[r, p] + acc[r - 1, j]
        mask = np.zeros((h, w), bool)  # True = keep canvas
        p = int(np.argmin(acc[-1]))
        for r in range(h - 1, -1, -1):
            mask[r, :p] = True
            p = back[r, p]
        if flip:
            mask = mask[:, ::-1]
        if t:
            mask = mask.T
        keep = mask & ok | ~v
        # soften the cut by one native pixel either side
        a = up(keep).astype(np.float32)
        k = K + 1
        pad = np.pad(a, k, mode='edge')
        cs = pad.cumsum(0).cumsum(1)
        n = 2 * k + 1
        cs = np.pad(cs, ((1, 0), (1, 0)))
        a = (cs[n:, n:] - cs[:-n, n:] - cs[n:, :-n] + cs[:-n, :-n]) / n ** 2
        a = np.where(up(ok & v)[..., None], a[..., None], up(keep)[..., None])
        cur[:] = cur * a + sub * (1 - a)
        self.ok[sy, sx] |= v

    def save(self, name):
        if not self.ok.all():
            print('  holes:', int((~self.ok).sum()), 'native px')
        Image.fromarray(np.clip(self.px, 0, 255).astype(np.uint8)).save(OUT + name)
        print(name, self.w, 'x', self.h, 'native')


A, B, C, P2 = shot('region-a'), shot('region-b'), shot('region-c'), shot('region-2p')
# region-c, the hero frame: your tank (119,122) between brick blocks, an enemy (178,74), a shell in flight.
# Its "200" score popup is patched out from region-b, which saw the same ground a moment earlier.
C[104 * K:114 * K, 104 * K:120 * K] = B[87 * K:97 * K, 92 * K:108 * K]


def rect(w, h, holes=()):
    m = np.ones((h, w), bool)
    for x0, y0, x1, y1 in holes:
        m[y0:y1, x0:x1] = False
    return m


# ---- 1P wide, 400x224: region-c in the middle (world x = canvas x - 72), region-b adding 12 columns of the
# same ground on the right, region-2p's open ground at both edges.
cv = Canvas(400, 224)
cv.paint(B, 72 + 12, 17)
cv.join(C, 72, 0, 'left', match=False)
cv.join(P2[:, :96 * K], 0, 0, 'left')
cv.join(P2[:, 150 * K:240 * K], 310, 0, 'right')
cv.save('bg-wide-1p.png')

# ---- 2P wide, 400x224: region-2p (both tanks, centred) with region-c's left and region-b's brick and hedges.
cv = Canvas(400, 224)
cv.paint(P2, 72, 0)
cv.join(C[:, :96 * K], 0, 0, 'left')
cv.join(B[:, 160 * K:256 * K], 304, 0, 'right')
cv.save('bg-wide-2p.png')

# ---- 1P portrait, 256x456 (world y = canvas y - 90): region-c, then the bottom rows of region-b and of
# region-a below it (region-a's own tank is cut out and region-b fills the gap), region-2p's ground above and below.
cv = Canvas(256, 456)
cv.paint(C, 0, 90)
cv.join(B, 12, 90 + 17, 'bottom', valid=rect(256, 224, [(0, 0, 256, 186)]), match=False)
cv.join(A, 0, 90 + 105, 'bottom', valid=rect(256, 224, [(0, 0, 256, 100), (66, 100, 126, 136)]), match=False)
cv.join(P2[:140 * K], 0, 0, 'top', valid=rect(256, 140, [(80, 92, 156, 140)]))  # not region-2p's tanks
cv.join(P2[140 * K:], 0, 372, 'bottom')
cv.save('bg-tall-1p.png')

# dusk stage for menu backdrops behind veils (camp screens)
FIELD = (382, 32, 1218, 868)  # the 208x208 arcade field inside a 1600x900 shot
Image.open('shots/dusk.png').convert('RGB').crop(FIELD).crop((0, 0, 836, 731)).save(OUT + 'bg-dusk.png')
print('ok')
