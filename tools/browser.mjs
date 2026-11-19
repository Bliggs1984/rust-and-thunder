// Where the test tools run their scenes (see tools/scene-runner.mjs for the scene format).
// - Normally: a local headless Chromium on the real GPU, loading dist/ from disk.
// - On a dev server with no GPU: a GPU PC through the optional test link (tools/pc-link.mjs, kept private)
//   while it is open. The server only sends scenes; the PC runs them and sends back screenshots.
//   If the link file exists but the PC doesn't answer: exit with "PC not available".
// SOFTGL=1 forces software rendering anywhere (1-2 fps without a GPU, so only good for crash checks).
import { chromium } from 'playwright-core';
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { runScene } from './scene-runner.mjs';

const root = resolve(import.meta.dirname, '..');
export const LINK_FILE = resolve(homedir(), '.cache/battletank/pc-link.json');
export const GPU_ARGS = ['--enable-gpu', '--use-angle=d3d11', '--ignore-gpu-blocklist', '--mute-audio',
  '--autoplay-policy=no-user-gesture-required', '--disable-gpu-vsync', '--disable-frame-rate-limit'];
export const SOFT_ARGS = ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--mute-audio', '--autoplay-policy=no-user-gesture-required'];

/** The Playwright Chromium installed on the Windows dev PC (undefined elsewhere, where Playwright finds its own). */
export function windowsChrome() {
  if (process.platform !== 'win32') return undefined;
  const pw = resolve(process.env.LOCALAPPDATA ?? '', 'ms-playwright');
  return ['chromium-1234/chrome-win64/chrome.exe', 'chromium-1223/chrome-win64/chrome.exe'].map((p) => resolve(pw, p)).find(existsSync);
}

async function localRunner(args, where) {
  const browser = await chromium.launch({ executablePath: windowsChrome(), headless: true, args });
  const game = pathToFileURL(resolve(root, 'dist/index.html')).href;
  return { where, run: (scene) => runScene(browser, game, scene), close: () => browser.close() };
}

async function linkRunner() {
  if (!existsSync(LINK_FILE)) return null;
  const { url, token } = JSON.parse(readFileSync(LINK_FILE, 'utf8'));
  const call = async (path, body, ms) => {
    const res = await fetch(`${url}${path}`, {
      method: body ? 'POST' : 'GET', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(ms),
    });
    if (!res.ok) throw new Error(`test link: ${res.status} ${await res.text()}`);
    return res.json();
  };
  try {
    await call('/ping', null, 4000);
  } catch {
    return null; // stale link file: the PC is off or the link window was closed
  }
  return { where: 'the linked PC (GPU, via the test link)', run: (scene) => call('/scene', scene, 15 * 60000), close: async () => {} };
}

/** Returns { where, run(scene), close() }. */
export async function openRunner() {
  if (process.env.SOFTGL) return localRunner(SOFT_ARGS, 'software rendering (slow)');
  if (process.platform === 'win32' || !existsSync(LINK_FILE)) return localRunner(GPU_ARGS, 'this PC (GPU)');
  const link = await linkRunner();
  if (link) return link;
  console.error("PC not available: the linked GPU PC is off or its test link isn't open. Open it "
    + '(desktop shortcut "Tank test link"), or set SOFTGL=1 for slow software rendering.');
  process.exit(2);
}
