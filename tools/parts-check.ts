// Checks the parts catalogue and the loadout rules (src/game/parts.ts), headless.
// Build + run: npx vite build --ssr tools/parts-check.ts --outDir dist-sim/parts && node dist-sim/parts/parts-check.js
import { BASE_ARMOUR, PARTS, applyLoadout, loadoutStats, partById, rollPart, statLines } from '../src/game/parts';
import { SLOTS, type Loadout } from '../src/game/run';
import type { Tank } from '../src/game/world';

let fails = 0;
const check = (ok: boolean, what: string) => {
  if (!ok) { fails++; console.log(`FAIL ${what}`); }
};
const near = (a: number, b: number) => Math.abs(a - b) < 1e-9;

// ---- catalogue ----
const SAFE = /^[A-Z0-9 .,'!?\-:+%"()=#&]*$/;
const ids = new Set<string>();
for (const p of PARTS) {
  check(!ids.has(p.id), `duplicate id ${p.id}`);
  ids.add(p.id);
  check(SLOTS.includes(p.slot), `${p.id}: bad slot ${p.slot}`);
  check(SAFE.test(p.name), `${p.id}: name not font-safe: ${p.name}`);
  check(SAFE.test(p.desc), `${p.id}: desc not font-safe: ${p.desc}`);
  check(p.name.length <= 14, `${p.id}: name longer than 14 (garage slot): ${p.name}`);
  check(p.desc.length <= 80, `${p.id}: desc longer than 80: ${p.desc.length}`);
  check(Number.isInteger(p.scrap) && p.scrap > 0, `${p.id}: scrap ${p.scrap}`);
  for (const [k, v] of Object.entries(p.stats)) check(Number.isInteger(v) && Math.abs(v) <= 4 && v !== 0, `${p.id}: stat ${k}=${v}`);
  if ((p.slot === 'jammer' || p.slot === 'plough') && !Object.keys(p.stats).length) check(/SHOW UP/.test(p.desc), `${p.id}: future part should say when it works`);
  check(partById(p.id) === p, `partById(${p.id})`);
}
for (const s of SLOTS) check(PARTS.some((p) => p.slot === s), `no part for slot ${s}`);
const cap = PARTS.filter((p) => p.captured).length;
check(cap >= PARTS.length / 4 && cap <= PARTS.length / 2, `captured share ${cap}/${PARTS.length}`);
check(PARTS.length >= 16 && PARTS.length <= 20, `catalogue size ${PARTS.length}`);

// ---- rollPart ----
let seed = 7;
const rng = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
for (let i = 0; i < 200; i++) {
  const a = rollPart(rng, false);
  const b = rollPart(rng, true);
  check(!!a && !partById(a)!.captured, `rollPart(false) gave ${a}`);
  check(!!b && !!partById(b)!.captured, `rollPart(true) gave ${b}`);
}
check(rollPart(() => 0.999999, true) !== null && rollPart(() => 0, false) !== null, 'rollPart at the rng ends');

// ---- applyLoadout ----
const tank = (vet: number, armour: number) => ({ vet, armour, armourMax: 0, speedMul: 1, firepower: 0, reloadMul: 1 }) as unknown as Tank;
const cases: { name: string; L: Loadout; vet: number; armour: number; want: [number, number, number, number, number] }[] = [
  // want: armourMax, armour, speedMul, firepower, reloadMul
  { name: 'bare', L: {}, vet: 0, armour: 10, want: [10, 10, 1, 0, 1] },
  { name: 'vet 2 + scrap plates', L: { armour: 'scrap-plates' }, vet: 2, armour: 7, want: [14, 7, 1, 0, 1] },
  { name: '125 barrel', L: { barrel: 'barrel-125' }, vet: 0, armour: 10, want: [10, 10, 1, 2, 1.1] },
  { name: 'fast build', L: { engine: 'turbo-diesel', tracks: 'racing-tracks' }, vet: 1, armour: 11, want: [9, 9, 1.4, 0, 1] },
  { name: 'heavy build', L: { armour: 'reactive', plough: 'mine-roller', tracks: 'wide-tracks' }, vet: 0, armour: 3, want: [15, 3, 0.92, 0, 1] },
  { name: 'slowest', L: { armour: 'sandbags', plough: 'mine-roller' }, vet: 0, armour: 1, want: [14, 1, 0.84, 0, 1] },
  { name: 'trade-offs cancel', L: { armour: 'sandbags', plough: 'mine-roller', engine: 'bus-engine' }, vet: 0, armour: 1, want: [14, 1, 1, 0, 1.1] },
  { name: 'loader', L: { barrel: 'autoloader', engine: 'tractor-diesel' }, vet: 3, armour: 20, want: [12, 12, 1.08, 0, 0.7] },
  { name: 'unknown id ignored', L: { barrel: 'nope' }, vet: 0, armour: 5, want: [10, 5, 1, 0, 1] },
];
for (const c of cases) {
  const t = tank(c.vet, c.armour);
  applyLoadout(t, c.L);
  const got = [t.armourMax, t.armour, t.speedMul, t.firepower, t.reloadMul];
  check(got.every((v, i) => near(v, c.want[i])), `${c.name}: got ${got.join(', ')} want ${c.want.join(', ')}`);
}
// the clamps: speed never below 0.76, reload never below 0.5, firepower never negative
{
  const t = tank(0, 10);
  applyLoadout(t, { armour: 'reactive', plough: 'mine-roller', engine: 'bus-engine', tracks: 'racing-tracks' });
  const s = loadoutStats({ armour: 'reactive', plough: 'mine-roller', engine: 'bus-engine', tracks: 'racing-tracks' });
  check(s.speed === 2 && near(t.speedMul, 1.16), `mixed speed ${s.speed} -> ${t.speedMul}`);
  check(t.armourMax === BASE_ARMOUR + 4 + 1 - 1, `mixed armour ${t.armourMax}`);
}
check(statLines({ firepower: 2, reload: -1 }).map((l) => l.text).join('|') === '+2 FIREPOWER|-1 RELOAD', 'statLines order');

console.log(`${PARTS.length} parts (${cap} captured), ${cases.length} loadout cases: ${fails ? `${fails} FAILED` : 'all OK'}`);
for (const p of PARTS) console.log(`  ${p.slot.padEnd(7)} ${p.name.padEnd(15)} ${statLines(p.stats).map((l) => l.text).join(' ').padEnd(24)} ${String(p.scrap).padStart(3)}${p.captured ? '  captured' : ''}`);
process.exit(fails ? 1 : 0);
