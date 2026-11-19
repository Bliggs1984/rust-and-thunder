// Perf gate for ordinary PCs, measured on this PC: frame rate at each internal resolution step the game can
// fall back to (k = native-pixel scale of the lighting buffers), with and without a 4x CPU slowdown (Chrome's
// CPU throttling). A weaker GPU is estimated from the frame times: see the printed GPU budget column.
// Usage: node tools/perfgate.mjs [seconds per sample=5] [case name filter, e.g. ruins]   (build first; runs headless on the GPU)
import { chromium } from 'playwright-core';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { GPU_ARGS, windowsChrome } from './browser.mjs';

const root = resolve(import.meta.dirname, '..');
const secs = Number(process.argv[2] ?? 5);
const game = pathToFileURL(resolve(root, 'dist/index.html')).href;
const CASES = [
  { name: 'campaign region', q: '?mute=1&autostart=1&autoplay=1&region=1' },
  { name: 'arcade night', q: '?mute=1&autostart=1&autoplay=1&stage=3' },
  // Ruined Town at night: the most lights on screen (fires, streetlamps, src/game/ambient.ts), rain, smoke
  { name: 'ruins night', q: '?mute=1&autostart=1&autoplay=1&region=1&stage=4' },
];

const browser = await chromium.launch({ executablePath: windowsChrome(), headless: true, args: GPU_ARGS });
const rows = [];
const only = process.argv[3]; // optional: only cases whose name contains this
for (const c of CASES.filter((cc) => !only || cc.name.includes(only))) {
  const page = await browser.newPage({ viewport: { width: 1920, height: 1080 } });
  const cdp = await page.context().newCDPSession(page);
  await page.goto(game + c.q);
  await page.waitForTimeout(6000); // past the intro into play
  for (const throttle of [1, 4]) {
    await cdp.send('Emulation.setCPUThrottlingRate', { rate: throttle });
    for (const k of [5, 4, 3, 2]) {
      await page.evaluate((kk) => { window.__app.r.maxK = kk; }, k);
      await page.waitForTimeout(800);
      const f0 = await page.evaluate(() => ({ n: window.__frames ?? 0, t: performance.now() }));
      // count rendered frames ourselves (fpsValue is a 0.5 s average)
      await page.evaluate(() => {
        window.__frames = 0;
        const tick = () => { window.__frames++; window.__raf = requestAnimationFrame(tick); };
        cancelAnimationFrame(window.__raf);
        window.__raf = requestAnimationFrame(tick);
      });
      await page.waitForTimeout(secs * 1000);
      const f1 = await page.evaluate(() => ({ n: window.__frames, t: performance.now(), k: window.__app.r.k, nw: window.__app.r.nw ?? 256, nh: window.__app.r.nh ?? 224, mode: window.__app.mode }));
      const fps = f1.n / ((f1.t - f0.t) / 1000);
      rows.push({ case: c.name, cpu: `${throttle}x slower`, k: f1.k, native: `${f1.nw}x${f1.nh}`, mode: f1.mode, fps: Math.round(fps), ms: +(1000 / fps).toFixed(2) });
    }
  }
  await page.close();
}
await browser.close();
console.table(rows);
