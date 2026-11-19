// Wide balance sweep: runs the built balance sim (npm run balance builds it) for many seeds per region, in parallel
// processes, and prints one row per region with the spread. The sim's dice are not seeded, so one 8-seed run moves a
// region's "retreats per clear" by +-0.4; this gives a mean with its standard error to tune against.
// Usage: npm run balance:many [-- --seeds 48 --chunk 8 --regions 0,1,2,3,4 --js dist-sim/balance/balance.js --keep dir]
import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import os from 'node:os';

const arg = (k, d) => {
  const i = process.argv.indexOf(`--${k}`);
  return i >= 0 ? process.argv[i + 1] : d;
};
const SEEDS = Number(arg('seeds', '48'));
const CHUNK = Number(arg('chunk', '8'));
const REGIONS = arg('regions', '0,1,2,3,4').split(',').map(Number);
const JS = arg('js', 'dist-sim/balance/balance.js');
const KEEP = arg('keep', '');
const JOBS = Math.max(1, Math.min(os.cpus().length - 2, Number(arg('jobs', '16'))));

const jobs = [];
for (const r of REGIONS) for (let s0 = 1; s0 <= SEEDS; s0 += CHUNK) jobs.push({ r, s0, n: Math.min(CHUNK, SEEDS - s0 + 1) });
const out = new Map();
const run = (j) => new Promise((res) => {
  const p = spawn(process.execPath, [JS, '--regions', String(j.r), '--seeds', String(j.n), '--seed0', String(j.s0)], { stdio: ['ignore', 'pipe', 'inherit'] });
  let txt = '';
  p.stdout.on('data', (d) => { txt += d; });
  p.on('close', () => { out.set(j, txt); res(); });
});
let next = 0;
const t0 = Date.now();
await Promise.all(Array.from({ length: JOBS }, async () => { while (next < jobs.length) await run(jobs[next++]); }));
if (KEEP) {
  mkdirSync(KEEP, { recursive: true });
  for (const [j, txt] of out) writeFileSync(`${KEEP}/r${j.r}-s${j.s0}.txt`, txt);
}

const mean = (a) => (a.length ? a.reduce((s, x) => s + x, 0) / a.length : 0);
const se = (a) => (a.length > 1 ? Math.sqrt(a.reduce((s, x) => s + (x - mean(a)) ** 2, 0) / (a.length - 1) / a.length) : 0);
console.log(`--- ${SEEDS} seeds per region in chunks of ${CHUNK} (${((Date.now() - t0) / 1000).toFixed(0)} s) ---`);
console.log('region            retreats/clear (+-SE)  chunk range   failed  timeouts  knockouts  minutes  boss min  armour lost to boss');
for (const r of REGIONS) {
  const retreats = [];
  const chunkMeans = [];
  let failed = 0;
  let timeouts = 0;
  const ko = [];
  const mins = [];
  const bossMin = [];
  const bossDmg = [];
  let name = '';
  for (const [j, txt] of out) {
    if (j.r !== r) continue;
    const mine = [];
    for (const m of txt.matchAll(/^seed \d+: (CLEARED|FAILED ) retreats (\d+) total ([\d.]+)m ko (\d+)/gm)) {
      mine.push(Number(m[2]));
      if (m[1] !== 'CLEARED') failed++;
      mins.push(Number(m[3]));
      ko.push(Number(m[4]));
    }
    timeouts += (txt.match(/TIMEOUT@/g) ?? []).length;
    // per attempt: minutes from the boss reveal to its kill
    for (const m of txt.matchAll(/CLEAR@[\d.]+m ko \d+ towns \S+ \(reveal ([\d.]+), all [\d.-]+\) boss .*? kill ([\d.]+)/g)) bossMin.push(Number(m[2]) - Number(m[1]));
    const s = txt.match(/^ *\d+ (.+?) +cleared/m);
    if (s) name = s[1];
    const d = txt.match(/armour lost per seed[^\n]*?\bboss (\d+)/);
    bossDmg.push(d ? Number(d[1]) : 0);
    retreats.push(...mine);
    chunkMeans.push(mean(mine));
  }
  console.log(`${String(r + 1)} ${name.padEnd(15)}  ${mean(retreats).toFixed(2)} +-${se(retreats).toFixed(2)}`.padEnd(41)
    + `${Math.min(...chunkMeans).toFixed(1)}-${Math.max(...chunkMeans).toFixed(1)}`.padEnd(14)
    + `${failed}/${retreats.length}`.padEnd(8) + String(timeouts).padEnd(10) + mean(ko).toFixed(1).padEnd(11) + mean(mins).toFixed(1).padEnd(9)
    + mean(bossMin).toFixed(1).padEnd(10) + mean(bossDmg).toFixed(0));
}
