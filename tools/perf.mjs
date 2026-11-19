// Measures the real, uncapped frame rate on this PC's graphics card in a hidden (headless) browser
// (see tools/browser.mjs).
// Usage: node tools/perf.mjs [stage] [seconds] [extra query, e.g. region=1]
import { resolve } from 'node:path';
import { writeFileSync } from 'node:fs';
import { openRunner } from './browser.mjs';

const root = resolve(import.meta.dirname, '..');
const stage = process.argv[2] ?? '3';
const secs = Number(process.argv[3] ?? 12);
const extra = process.argv[4] ? `&${process.argv[4]}` : ''; // e.g. region=1
const runner = await openRunner();
console.log(`browser: ${runner.where}`);
const gpu = "eval:(() => { const gl = window.__app.r.gl; const e = gl.getExtension('WEBGL_debug_renderer_info'); return e ? gl.getParameter(e.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER); })()";
const sample = 'eval:({ fps: window.__app.fpsValue, mode: window.__app.mode, k: window.__app.r.k, frame: window.__app.world?.frame })';
const r = await runner.run({
  name: 'perf', q: `?mute=1&autostart=1&autoplay=1&debug=1&stage=${stage}${extra}`, vp: { width: 1920, height: 1080 },
  steps: [gpu, ...Array.from({ length: secs }, () => [1000, sample]).flat(), 'shot'],
});
console.log('GPU:', r.values[0]);
for (const v of r.values.slice(1)) console.log(JSON.stringify(v));
writeFileSync(resolve(root, 'shots/perf.png'), Buffer.from(r.shots[0].png, 'base64'));
for (const e of r.errors) console.log('ERR', e);
await runner.close();
