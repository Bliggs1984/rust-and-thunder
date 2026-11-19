// Runs one scripted scene in a browser and returns its screenshots and values. Used locally by the
// test tools, and by the optional remote test link (tools/pc-link.mjs, private), which receives scenes as JSON.
// That makes this file the link's contract: keep the scene format stable, because the PC only picks
// up a new version of this file when its copy of the repo is pulled.
//
// A scene: { name, q, vp?, steps }
//   q      query string for the game page, e.g. '?mute=1&autostart=1&stage=3'
//   vp     viewport, default 1600x900
//   steps  number = wait ms | 'key:Code' | 'eval:js' (runs in the page; its value is kept) | 'shot' | 'shot:name'
// Returns { shots: [{ name, info, png }], values: [...], errors: [...], failed }

const INFO = () => {
  const a = window.__app;
  const w = a?.world;
  return a ? {
    mode: a.mode, stage: a.stage, score: a.ps?.[0]?.score, lives: a.ps?.[0]?.lives,
    enemies: w?.enemies.length, queue: w?.queue.length, frame: w?.frame, k: a.r.k, hdr: a.r.hdrOK,
  } : null;
};

const QUERY = /^\?[A-Za-z0-9=&._%-]*$/;

/** Throws on anything that isn't a well-formed scene (the link runs scenes sent from another machine). */
export function checkScene(sc) {
  if (!sc || typeof sc !== 'object') throw new Error('scene must be an object');
  if (typeof sc.name !== 'string' || !/^[\w-]{1,40}$/.test(sc.name)) throw new Error('bad scene name');
  if (typeof sc.q !== 'string' || !QUERY.test(sc.q)) throw new Error('bad query string');
  if (sc.vp !== undefined) {
    const ok = (n) => Number.isInteger(n) && n >= 200 && n <= 3840;
    if (!ok(sc.vp?.width) || !ok(sc.vp?.height)) throw new Error('bad viewport');
  }
  if (!Array.isArray(sc.steps) || sc.steps.length > 400) throw new Error('bad steps');
  let wait = 0;
  for (const st of sc.steps) {
    if (typeof st === 'number') {
      if (!(st >= 0 && st <= 120000)) throw new Error('bad wait');
      wait += st;
    } else if (typeof st !== 'string' || !/^(key:\w+|eval:[\s\S]{1,20000}|shot(:[\w-]{1,40})?)$/.test(st)) {
      throw new Error(`bad step: ${String(st).slice(0, 40)}`);
    }
  }
  if (wait > 600000) throw new Error('scene waits too long');
}

/**
 * Allow only the game's own origin (the test link passes lock = true): every other request and every
 * WebSocket is refused, so page scripts can't reach other sites, devices on the network, or files.
 */
async function lockToGame(ctx, gameUrl) {
  const origin = new URL(gameUrl).origin;
  await ctx.route('**/*', (route) => (route.request().url().startsWith(`${origin}/`) ? route.continue() : route.abort()));
  await ctx.routeWebSocket(/.*/, (ws) => ws.close());
}

export async function runScene(browser, gameUrl, sc, { lock = false } = {}) {
  checkScene(sc);
  const ctx = await browser.newContext({ viewport: sc.vp ?? { width: 1600, height: 900 } });
  try {
    if (lock) await lockToGame(ctx, gameUrl);
    const p = await ctx.newPage();
    const errors = [];
    p.on('pageerror', (e) => errors.push(String(e)));
    p.on('console', (m) => {
      if (m.type() === 'error' || m.type() === 'warning') errors.push(`${m.type()}: ${m.text()}`);
    });
    await p.goto(`${gameUrl}${sc.q}`);
    const shots = [];
    const values = [];
    for (const st of sc.steps) {
      if (typeof st === 'number') await p.waitForTimeout(st);
      else if (st.startsWith('key:')) {
        await p.keyboard.press(st.slice(4));
        await p.waitForTimeout(60);
      } else if (st.startsWith('eval:')) {
        values.push(await p.evaluate(st.slice(5)));
      } else {
        const info = await p.evaluate(INFO);
        const png = await p.screenshot({ timeout: 60000 });
        shots.push({ name: st.includes(':') ? st.slice(5) : sc.name, info, png: png.toString('base64') });
      }
    }
    const err = await p.evaluate(() => document.getElementById('err')?.textContent ?? '');
    if (err) errors.unshift(`ERROR BOX: ${err.slice(0, 2000)}`);
    return { shots, values, errors: errors.slice(0, 20), failed: !!err };
  } finally {
    await ctx.close();
  }
}
