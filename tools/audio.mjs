// Renders every sound and two music styles offline in headless Chrome and prints peak / RMS /
// audible length, so levels can be checked without listening. Run after `npx vite build`.
// --wav name ... also saves those sounds as shots/<name>.wav to listen to (music-boss: 32 s, its A and B sections).
// Sound renders on the CPU, so this always runs a local browser, even on a machine without a GPU.
import { chromium } from 'playwright-core';
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { SOFT_ARGS, windowsChrome } from './browser.mjs';

const root = resolve(import.meta.dirname, '..');
const names = ['shoot', 'eshoot', 'brick', 'steel', 'thud', 'ricochet', 'armor', 'explode', 'bigexplode', 'powerup', 'pickup',
  'grenade', 'emp', 'shieldbreak', 'life', 'ui-move', 'ui-ok', 'ui-back', 'pause', 'start', 'clear', 'gameover', 'tick', 'thunder', 'thunder-far', 'rain',
  'scrap', 'part', 'armour-hit', 'armour-low', 'patch', 'radio', 'column', 'town-freed', 'capture-tick',
  'trick-drone', 'trick-whistle', 'trick-rocket', 'heli-chop', 'heli-pitch', 'firework', 'boss-horn',
  'boss-charge', 'boss-cannon', 'boss-gun', 'boss-part', 'shoot-burst',
  'music-menu', 'music-play', 'music-boss', 'music-boss2',
  ...['farm', 'rail', 'delta', 'ruins', 'winter'].flatMap((n) => [`music-${n}`, `music-${n}-fight`]),
];
const wi = process.argv.indexOf('--wav');
const wavs = wi >= 0 ? process.argv.slice(wi + 1) : [];
const browser = await chromium.launch({ executablePath: windowsChrome(), headless: true, args: SOFT_ARGS });
const p = await browser.newPage();
const errors = [];
p.on('pageerror', (e) => errors.push(String(e)));
await p.goto(`${pathToFileURL(resolve(root, 'dist/index.html')).href}?mute=1`);
await p.waitForTimeout(500);
for (const n of wavs.length ? wavs : names) {
  const r = await p.evaluate(([n, w]) => window.__measure(n, w).catch((e) => ({ name: n, error: String(e) })), [n, wavs.length > 0]);
  if (r.wav) {
    mkdirSync(resolve(root, 'shots'), { recursive: true });
    writeFileSync(resolve(root, 'shots', `${n}.wav`), Buffer.from(r.wav, 'base64'));
    console.log(`saved shots/${n}.wav`);
  } else {
    console.log(JSON.stringify(r));
  }
}
for (const e of errors) console.log('ERR', e);
await browser.close();
