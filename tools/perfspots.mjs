// Frame rate with the camera parked on set pieces of a campaign region (enemies frozen), to price the terrain
// shader where it works hardest: a town, a depot, and (when the map has ground kinds) a farmyard, a sunflower field
// and a crop field. Prints the median and best of 6 one-second samples per spot.
// Usage: node tools/perfspots.mjs [stage 1-5] [map seed]   (build first; runs on this PC's GPU like tools/perf.mjs)
import { openRunner } from './browser.mjs';

const stage = process.argv[2] ?? '1';
const seed = process.argv[3] ?? '1';
const TP = (spot) => `eval:{ const w = window.__app.world; w.freeze = 1e6; const p = w.players[0]; const s = ${spot}; p.x = s[0]; p.y = s[1]; p.dir = 0; p.shield = 600; JSON.stringify(s); }`;
const WAIT = "eval:new Promise((ok) => { const t0 = Date.now(); const id = setInterval(() => { if (window.__app.mode === 'play' || Date.now() - t0 > 30000) { clearInterval(id); ok(window.__app.mode); } }, 50); })";
const KIND = (kind) => `(() => { const m = w.map, kd = w.region.kinds, c = []; if (kd) for (let y = 4; y < m.h - 8; y += 4) for (let x = 4; x < m.w - 8; x += 4) { let n = 0; for (let j = 0; j < 4; j++) for (let i = 0; i < 4; i++) if (m.c[(y + j) * m.w + x + i] === 0 && (kd[(y + j) * m.w + x + i] & 15) === ${kind}) n++; if (n === 16) c.push([x, y]); } if (!c.length) return [Math.round(m.w / 4) * 8, Math.round(m.h / 4) * 8]; const b = c[Math.floor(c.length / 2)]; return [b[0] * 4, b[1] * 4]; })()`;
const SPOTS = [
  ['town', '[w.region.towns[0].cx - 8, w.region.towns[0].cy + 8]'],
  ['depot', '[Math.round((w.region.depots[0].cx - 8) / 8) * 8, Math.round((w.region.depots[0].cy - 8) / 8) * 8 + 16]'],
  ['yard (kind 7)', KIND(7)], ['sunflowers (kind 5)', KIND(5)], ['crops (kind 3)', KIND(3)], ['paving (kind 2)', KIND(2)],
];
const SAMPLE = 'eval:window.__app.fpsValue';
const steps = [WAIT, 2500];
for (const [, spot] of SPOTS) steps.push(TP(spot), 2500, ...Array.from({ length: 6 }, () => [1000, SAMPLE]).flat());
const runner = await openRunner();
const r = await runner.run({ name: 'perfspots', q: `?mute=1&autostart=1&debug=1&region=${seed}&stage=${stage}`, vp: { width: 1920, height: 1080 }, steps });
const vals = r.values.filter((v) => v !== undefined && v !== null);
// values: WAIT result, then per spot: the spot (string) and 6 samples
let i = 1;
for (const [name] of SPOTS) {
  const at = vals[i];
  const s = vals.slice(i + 1, i + 7).map(Number).sort((a, b) => a - b);
  console.log(`${name.padEnd(20)} at ${String(at).padEnd(10)} median ${s[s.length >> 1]} best ${s[s.length - 1]}  (${s.join(' ')})`);
  i += 7;
}
for (const e of r.errors) console.log('ERR', e);
await runner.close();
