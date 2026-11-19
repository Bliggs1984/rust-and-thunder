import { App } from './app';
import { buildAtlas } from './art/sprites';
import { Sound } from './audio';
import { Renderer } from './gl/renderer';
import { Input } from './input';
import { campOpen, closeCamp, demoArmour, demoCampRun, openCamp } from './ui-garage';

const errBox = document.getElementById('err')!;
function showError(e: unknown): void {
  errBox.style.display = 'block';
  errBox.textContent = `Something went wrong:\n\n${e instanceof Error ? `${e.message}\n${e.stack ?? ''}` : String(e)}`;
  console.error(e);
}
window.addEventListener('error', (e) => showError(e.error ?? e.message));

const q = new URLSearchParams(location.search);
const flag = (k: string) => q.get(k) === '1';

try {
  const canvas = document.getElementById('c') as HTMLCanvasElement;
  const renderer = new Renderer(canvas, buildAtlas());
  renderer.crt = flag('crt');
  const input = new Input();
  const sfx = new Sound(flag('mute'));
  if (flag('audiotest')) sfx.init();
  const app = new App(renderer, input, sfx, {
    autoplay: flag('autoplay'),
    debug: flag('debug'),
    autostart: flag('autostart') || q.has('bosstest') || q.has('arena'),
    stage: Math.max(1, Number(q.get('stage')) || 1),
    players: q.get('players') === '2' ? 2 : 1,
    region: Math.max(0, Math.floor(Number(q.get('region')) || 0)),
  });
  if (flag('pixel') || q.get('rtx') === '0') {
    app.settings.pixel = flag('pixel');
    app.settings.rtx = q.get('rtx') !== '0';
    app.applySettings();
  }
  (window as unknown as { __app: App; __measure: typeof Sound.measure }).__app = app;
  (window as unknown as { __measure: typeof Sound.measure }).__measure = Sound.measure;
  // ?camp=1: the camp / garage screen over the title with a demo run (screenshots without the run flow);
  // window.__camp opens it again and window.__campResult holds what it handed back
  if (flag('camp')) {
    const W = window as unknown as Record<string, unknown>;
    const players = q.get('players') === '2' ? 2 : 1;
    const open = () => {
      const run = demoCampRun();
      openCamp({ run, players, place: 'VYSHNEVE WORKSHOP', armour: demoArmour(run, players), onClose: (r) => { W.__campResult = r; } });
    };
    W.__camp = { open, close: closeCamp, isOpen: campOpen };
    open();
  }

  const STEP = 1 / 60;
  // ?speed=0.25 slows the whole game down (play tests by AI agents that act every few seconds)
  const speed = Math.max(0.05, Math.min(1, Number(q.get('speed')) || 1));
  let acc = 0;
  let last = performance.now();
  let failed = false;
  let frames = 0;
  let fpsT = performance.now();
  const frame = (now: number) => {
    if (failed) return;
    try {
      acc += Math.min(0.1, (now - last) / 1000) * speed;
      last = now;
      while (acc >= STEP) {
        app.update();
        input.endFrame();
        acc -= STEP;
      }
      frames++;
      if (now - fpsT > 500) {
        app.fpsValue = Math.round((frames * 1000) / (now - fpsT));
        frames = 0;
        fpsT = now;
      }
      app.draw(now / 1000);
      renderer.render(now / 1000);
    } catch (e) {
      failed = true;
      showError(e);
      return;
    }
    requestAnimationFrame(frame);
  };
  requestAnimationFrame(frame);
} catch (e) {
  showError(e);
}
