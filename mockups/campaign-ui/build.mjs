// Builds the self-contained mockup HTML files from src/ and renders each to PNG with headless Chromium.
// Run from the repo root: node mockups/campaign-ui/build.mjs [name-filter]
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { chromium } from 'playwright-core';

const DIR = dirname(fileURLToPath(import.meta.url));
const SRC = join(DIR, 'src');
const css = readFileSync(join(SRC, 'common.css'), 'utf8');
const js = readFileSync(join(SRC, 'common.js'), 'utf8');
const dataURI = (name) => `data:image/png;base64,${readFileSync(join(DIR, 'img', name)).toString('base64')}`;

// output html <- source page + variables
const PAGES = [
  ['hud-1p', 'hud', { PLAYERS: 1 }],
  ['hud-2p', 'hud', { PLAYERS: 2 }],
  ['garage', 'garage', {}],
  ['crew', 'crew', {}],
  ['region-map', 'map', {}],
  ['briefing', 'briefing', {}],
  ['system', 'system', {}],
];
// png <- html at a viewport size
const SHOTS = [
  ['hud-1p', 'hud-1p-1080', 1920, 1080],
  ['hud-1p', 'hud-1p-720', 1280, 720],
  ['hud-2p', 'hud-2p-1080', 1920, 1080],
  ['hud-2p', 'hud-2p-720', 1280, 720],
  ['hud-1p', 'hud-1p-portrait', 1080, 1920],
  ['garage', 'garage-1080', 1920, 1080],
  ['crew', 'crew-1080', 1920, 1080],
  ['region-map', 'region-map-1080', 1920, 1080],
  ['briefing', 'briefing-1080', 1920, 1080],
  ['system', 'system-1080', 1920, 1080],
];

const filter = process.argv[2] || '';
for (const [out, src, vars] of PAGES) {
  let html = readFileSync(join(SRC, `${src}.html`), 'utf8');
  html = html.replace('/*COMMON_CSS*/', () => css)
    .replace('/*COMMON_JS*/', () => js)
    .replace('/*VARS*/', () => Object.entries(vars).map(([k, v]) => `const ${k} = ${JSON.stringify(v)};`).join('\n'))
    .replace(/IMG\(([\w.-]+)\)/g, (_, n) => dataURI(n));
  writeFileSync(join(DIR, `${out}.html`), html);
}

const local = process.env.LOCALAPPDATA;
const exe = ['chromium-1234', 'chromium-1223'].map((d) => join(local, 'ms-playwright', d, 'chrome-win64', 'chrome.exe')).find(existsSync);
const browser = await chromium.launch({ executablePath: exe, headless: true });
for (const [html, png, w, h] of SHOTS) {
  if (filter && !png.includes(filter)) continue;
  const page = await browser.newPage({ viewport: { width: w, height: h }, deviceScaleFactor: 1 });
  const errs = [];
  page.on('pageerror', (e) => errs.push(e.message));
  page.on('console', (m) => { if (m.type() === 'error') errs.push(m.text()); });
  await page.goto(pathToFileURL(join(DIR, `${html}.html`)).href);
  try {
    await page.waitForSelector('body[data-ready="1"]', { timeout: 10000 });
  } catch { errs.push('never ready'); }
  await page.waitForTimeout(150);
  await page.screenshot({ path: join(DIR, `${png}.png`), animations: 'disabled' });
  console.log(png, errs.length ? `ERRORS: ${errs.join(' | ')}` : 'ok');
  await page.close();
}
await browser.close();
