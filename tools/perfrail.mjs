// Uncapped frame rate with the camera on the railway (Rail Junction, map seed 1): the junction yard, then the
// steepest curve. Like tools/perf.mjs, in a hidden browser on the real GPU.
// Usage: node tools/perfrail.mjs [seconds per spot]
import { openRunner } from './browser.mjs';

const secs = Number(process.argv[2] ?? 6);
const runner = await openRunner();
console.log(`browser: ${runner.where}`);
const wait = "eval:new Promise((ok) => { const t0 = Date.now(); const id = setInterval(() => { if (window.__app.mode === 'play' || Date.now() - t0 > 30000) { clearInterval(id); ok(window.__app.mode); } }, 50); })";
const tp = (spot) => `eval:{ const w = window.__app.world; w.freeze = 1e6; const p = w.players[0]; const s = ${spot}; p.x = s[0]; p.y = s[1]; p.shield = 0; JSON.stringify(s); }`;
const yard = '(() => { const t = w.region.towns[0], r = w.region.rail; let b = r[0]; for (const q of r) if (Math.hypot(q[0] - t.cx, q[1] - t.cy) < Math.hypot(b[0] - t.cx, b[1] - t.cy)) b = q; return [Math.round(b[0] / 8) * 8, Math.round(b[1] / 8) * 8 + 24]; })()';
const curve = '(() => { const r = w.region.rail; let b = 9, bs = -1; for (let i = 9; i < r.length - 8; i++) { const s = Math.abs(r[i][1] - r[i - 1][1]) / Math.abs(r[i][0] - r[i - 1][0]); if (s > bs) { bs = s; b = i; } } return [Math.round(r[b][0] / 8) * 8, Math.round(r[b][1] / 8) * 8 + 24]; })()';
const sample = 'eval:window.__app.fpsValue';
const samples = Array.from({ length: secs }, () => [1000, sample]).flat();
const r = await runner.run({
  name: 'perfrail', q: '?mute=1&autostart=1&region=1&stage=2&debug=1', vp: { width: 1920, height: 1080 },
  steps: [wait, 2000, tp(yard), 1500, ...samples, tp(curve), 1500, ...samples],
});
const nums = r.values.filter((v) => typeof v === 'number');
const avg = (a) => Math.round(a.slice(1).reduce((s, v) => s + v, 0) / (a.length - 1));
console.log(`yard  ${avg(nums.slice(0, secs))} fps  (${nums.slice(0, secs).join(' ')})`);
console.log(`curve ${avg(nums.slice(secs))} fps  (${nums.slice(secs).join(' ')})`);
for (const e of r.errors) console.log('ERR', e);
await runner.close();
