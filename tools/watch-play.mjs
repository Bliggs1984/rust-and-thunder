// Watch an AI play test live: serves a page on 127.0.0.1 that always shows the newest screenshot the play
// server (tools/play-server.mjs) wrote, with the action count. Read-only; doesn't touch the game.
// Usage: node tools/watch-play.mjs <shots folder> [port=4190]
import { createServer } from 'node:http';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { resolve } from 'node:path';

const dir = resolve(process.argv[2] ?? 'shots/play');
const port = Number(process.argv[3] ?? 4190);

const latest = () => {
  const pngs = readdirSync(dir).filter((f) => f.endsWith('.png')).sort();
  return pngs.length ? { name: pngs[pngs.length - 1], count: pngs.length } : null;
};

const PAGE = `<!doctype html><meta charset="utf-8"><title>AI play test (live)</title>
<style>body{margin:0;background:#111;color:#ccc;font:14px system-ui}#i{display:block;width:100vw;height:calc(100vh - 28px);object-fit:contain;image-rendering:pixelated}#t{height:28px;line-height:28px;padding:0 10px}</style>
<div id="t">waiting for the first screenshot…</div><img id="i">
<script>
let last = '';
async function tick(){
  try {
    const r = await (await fetch('/latest.json', { cache: 'no-store' })).json();
    if (r && r.name !== last) {
      last = r.name;
      document.getElementById('i').src = '/shot/' + r.name;
      document.getElementById('t').textContent = 'action ' + r.count + ' · ' + r.name + ' · ' + new Date().toLocaleTimeString() + ' (updates when the AI acts, every ~20-30 s)';
    }
  } catch {}
  setTimeout(tick, 1000);
}
tick();
</script>`;

createServer((req, res) => {
  const u = new URL(req.url ?? '/', 'http://x');
  if (u.pathname === '/') return res.writeHead(200, { 'content-type': 'text/html' }).end(PAGE);
  if (u.pathname === '/latest.json') return res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(latest()));
  const m = u.pathname.match(/^\/shot\/(play-\d+\.png)$/);
  if (m) {
    const f = resolve(dir, m[1]);
    if (statSync(f, { throwIfNoEntry: false })) return res.writeHead(200, { 'content-type': 'image/png' }).end(readFileSync(f));
  }
  res.writeHead(404).end();
}).listen(port, '127.0.0.1', () => console.log(`watch at http://127.0.0.1:${port}/ (${dir})`));
