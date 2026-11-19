// Imported first by ai-sim.ts: swaps Math.random for a seeded generator before world.ts and ai.ts capture it,
// so every scenario replays the same way.
import { mulberry32 } from '../src/game/stages';

let r = mulberry32(1);
Math.random = () => r();

export function reseed(n: number): void {
  r = mulberry32(n * 7907 + 3);
}
