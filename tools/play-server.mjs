// Lets an outside AI agent play the game like computer use, without touching the desktop: a hidden
// (headless) Chromium on this PC's GPU runs the game, and a small HTTP server on 127.0.0.1 takes key
// presses and returns screenshots saved as PNG files.
// Usage: node tools/play-server.mjs [port=4180] [gameUrl=http://127.0.0.1:4173/] [outDir=shots/play]
// Endpoints (all GET; each returns JSON { shot: <png path>, info }):
//   /open?q=<query>             load the game with this query string, e.g. ?mute=1&region=1&autostart=1&speed=0.25
//   /hold?keys=ArrowUp,Space&ms=800   hold keys for ms (real time), then screenshot
//   /tap?keys=Enter             press and release keys, then screenshot
//   /down?keys=Digit1&ms=100    press keys and keep them held (until /up), wait ms, then screenshot
//   /up?keys=Digit1             release held keys, then screenshot
//   /wait?ms=1000               wait, then screenshot
//   /shot                       screenshot only
import { chromium } from 'playwright-core';
import { createServer } from 'node:http';
import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { GPU_ARGS, windowsChrome } from './browser.mjs';

const root = resolve(import.meta.dirname, '..');
const port = Number(process.argv[2] ?? 4180);
const game = process.argv[3] ?? 'http://127.0.0.1:4173/';
const outDir = resolve(process.argv[4] ?? resolve(root, 'shots/play'));
mkdirSync(outDir, { recursive: true });

const browser = await chromium.launch({ executablePath: windowsChrome(), headless: true, args: GPU_ARGS });
const page = await browser.newPage({ viewport: { width: 1600, height: 900 } });
const errors = [];
page.on('pageerror', (e) => errors.push(String(e)));
let n = 0;

const INFO = () => {
  const a = window.__app;
  const w = a?.world;
  return a ? {
    mode: a.mode, paused: a.paused, stage: a.stage, score: a.ps?.[0]?.score, lives: a.ps?.[0]?.lives,
    enemiesOnMap: w?.enemies.filter((e) => e.alive).length, enemiesQueued: w?.queue.length, done: w?.done, fps: a.fpsValue,
  } : null;
};

async function shot() {
  const file = resolve(outDir, `play-${String(++n).padStart(4, '0')}.png`);
  await page.screenshot({ path: file });
  const info = await page.evaluate(INFO).catch(() => null);
  return { shot: file, info, errors: errors.splice(0) };
}

const keysOf = (u) => (u.searchParams.get('keys') ?? '').split(',').map((k) => k.trim()).filter((k) => /^\w+$/.test(k));
const msOf = (u, d) => Math.max(0, Math.min(20000, Number(u.searchParams.get('ms') ?? d) || 0));

let queue = Promise.resolve();
const server = createServer((req, res) => {
  queue = queue.then(async () => {
    const u = new URL(req.url ?? '/', 'http://x');
    let out;
    try {
      if (u.pathname === '/open') {
        const q = u.searchParams.get('q') ?? '?mute=1';
        if (!/^\?[A-Za-z0-9=&._%-]*$/.test(q)) throw new Error('bad query');
        await page.goto(game + q);
        await page.waitForTimeout(1500);
        out = await shot();
      } else if (u.pathname === '/hold') {
        const keys = keysOf(u);
        for (const k of keys) await page.keyboard.down(k);
        await page.waitForTimeout(msOf(u, 500));
        for (const k of keys.reverse()) await page.keyboard.up(k);
        out = await shot();
      } else if (u.pathname === '/down' || u.pathname === '/up') {
        // press or release keys and leave them that way (e.g. /down?keys=Digit1, /shot, /tap?keys=Space, /up?keys=Digit1)
        for (const k of keysOf(u)) await (u.pathname === '/down' ? page.keyboard.down(k) : page.keyboard.up(k));
        await page.waitForTimeout(msOf(u, 100));
        out = await shot();
      } else if (u.pathname === '/tap') {
        for (const k of keysOf(u)) {
          await page.keyboard.press(k);
          await page.waitForTimeout(120);
        }
        out = await shot();
      } else if (u.pathname === '/wait') {
        await page.waitForTimeout(msOf(u, 1000));
        out = await shot();
      } else if (u.pathname === '/shot') {
        out = await shot();
      } else {
        res.writeHead(404).end('unknown endpoint');
        return;
      }
      res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(out));
    } catch (e) {
      res.writeHead(500).end(String(e));
    }
  });
});
server.listen(port, '127.0.0.1', () => console.log(`play server on http://127.0.0.1:${port}, game ${game}, shots in ${outDir}`));
