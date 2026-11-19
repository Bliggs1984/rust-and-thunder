// How full the sprite atlas is, and an optional dump of sprites for a contact sheet.
// npx vite build --ssr tools/atlas-check.ts --outDir dist-sim/atlas && node dist-sim/atlas/atlas-check.js [prefix ...]
// With prefixes, writes dist-sim/atlas/sprites.json: { name: { w, h, px: [r, g, b, a, tintMask, height] per pixel } }.
import { writeFileSync } from 'node:fs';
import { buildAtlas } from '../src/art/sprites';

const at = buildAtlas();
let maxY = 0;
for (const s of Object.values(at.S)) maxY = Math.max(maxY, s.y + s.h);
console.log(`sprites ${Object.keys(at.S).length}, lowest row used ${maxY} of ${at.H} (width ${at.W})`);
const prefixes = process.argv.slice(2);
if (prefixes.length) {
  const out: Record<string, { w: number; h: number; px: number[] }> = {};
  for (const [name, s] of Object.entries(at.S)) {
    if (!prefixes.some((p) => name.startsWith(p))) continue;
    const px: number[] = [];
    for (let y = 0; y < s.h; y++) for (let x = 0; x < s.w; x++) {
      const i = ((s.y + y) * at.W + s.x + x) * 4;
      px.push(at.alb[i], at.alb[i + 1], at.alb[i + 2], at.alb[i + 3], at.hs[i + 2], at.hs[i]);
    }
    out[name] = { w: s.w, h: s.h, px };
  }
  writeFileSync(new URL('./sprites.json', import.meta.url), JSON.stringify(out));
  console.log(`dumped ${Object.keys(out).length} sprites`);
}
