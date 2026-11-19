// Stage layouts on the 13x13 block grid (each block = 16x16 px).
// .  empty      #  brick     @  steel    ~  water    %  trees    -  ice
// l r t b = left/right/top/bottom half brick, L R T B = half steel
// Keep (0,0) (6,0) (12,0) clear for enemy spawns, (4,12) (8,12) for players,
// and blocks (5..7, 11..12) for the base; the fortress is added automatically.

export interface StageDef {
  name: string;
  rows: string[];
  enemies: [number, number, number, number]; // basic, fast, power, armor
}

export const STAGES: StageDef[] = [
  {
    name: 'OUTPOST',
    rows: [
      '.............',
      '.#.#.#.#.#.#.',
      '.#.#.#.#.#.#.',
      '.#.#.#@#.#.#.',
      '.#.#.....#.#.',
      '.....#.#.....',
      'B.bb.....bb.B',
      '.....#.#.....',
      '.#.#.###.#.#.',
      '.#.#.#.#.#.#.',
      '.#.#.....#.#.',
      '.#.#.....#.#.',
      '.............',
    ],
    enemies: [18, 2, 0, 0],
  },
  {
    name: 'STEEL GARDEN',
    rows: [
      '...@.....@...',
      '.#.@.#.#.@.#.',
      '.#...#.#...#.',
      '.#.%%%.%%%.#.',
      '...%#%.%#%...',
      '@@.%%%.%%%.@@',
      '....#...#....',
      '.##.#.@.#.##.',
      '.#.........#.',
      '.#.##.#.##.#.',
      '...#.....#...',
      '.%%#.....#%%.',
      '.%%.......%%.',
    ],
    enemies: [14, 4, 0, 2],
  },
  {
    name: 'RIVER CROSSING',
    rows: [
      '.............',
      '.#.#.#.#.#.#.',
      '.#.#.#.#.#.#.',
      '.............',
      '..%%%...%%%..',
      '.~~~~.@.~~~~.',
      '.~~~~...~~~~.',
      '..%%%...%%%..',
      '..#.......#..',
      '.###.#.#.###.',
      '.#.........#.',
      '.#.#.....#.#.',
      '.............',
    ],
    enemies: [14, 4, 0, 2],
  },
  {
    name: 'DEEP FOREST',
    rows: [
      '..%%%...%%%..',
      '.%%#%%.%%#%%.',
      '.%###%.%###%.',
      '.%%#%%.%%#%%.',
      '....%%%%%....',
      '@.#.%@%@%.#.@',
      '..#.%%%%%.#..',
      '%%#.......#%%',
      '%%..##@##..%%',
      '...#%%.%%#...',
      '.#.#%%.%%#.#.',
      '.#.%.....%.#.',
      '%%%.......%%%',
    ],
    enemies: [2, 5, 10, 3],
  },
  {
    name: 'ICE FIELD',
    rows: [
      '.............',
      '.@.-------.@.',
      '..#-#####-#..',
      '.#.-#...#-.#.',
      '.#.-#.@.#-.#.',
      '...---.---...',
      '@@.--@@@--.@@',
      '...---.---...',
      '.#.-#.#.#-.#.',
      '.#.-#...#-.#.',
      '..#-#####-#..',
      '.@.--...--.@.',
      '---.......---',
    ],
    enemies: [8, 5, 5, 2],
  },
  {
    name: 'FROZEN GROVE',
    rows: [
      '.--.-...-.--.',
      '.#..#.@.#..#.',
      '-#.%%%.%%%.#-',
      '-..%#%.%#%..-',
      '##.%%%#%%%.##',
      '~---.....---~',
      '@@#.#%%%#.#@@',
      '...-.%%%.-...',
      '-#--.....--#-',
      '-#..#@.@#..#-',
      '..@.......@..',
      '%%.#.....#.%%',
      '%%.........%%',
    ],
    enemies: [9, 2, 7, 2],
  },
  {
    name: 'ISLANDS',
    rows: [
      '.............',
      '.~~~.#.#.~~~.',
      '.~%~.#.#.~%~.',
      '.~~~.....~~~.',
      '...#.~~~.#...',
      '##.#.~@~.#.##',
      '...#.~~~.#...',
      '.~~~.....~~~.',
      '.~%~.#.#.~%~.',
      '.~~~.#.#.~~~.',
      '.............',
      '##.#.....#.##',
      '.............',
    ],
    enemies: [7, 4, 6, 3],
  },
  {
    name: 'LABYRINTH',
    rows: [
      '..#.......#..',
      '#.#.#####.#.#',
      '#...#...#...#',
      '@@@.#.#.#.@@@',
      '....#.#.#....',
      '.####.#.####.',
      '......#......',
      '.####.#.####.',
      '.#.........#.',
      '.#.###.###.#.',
      '...#.....#...',
      '##.#.....#.##',
      '.............',
    ],
    enemies: [7, 4, 7, 2],
  },
  {
    name: 'STEEL MAZE',
    rows: [
      '....@...@....',
      '.@@.@.#.@.@@.',
      '.#....#....#.',
      '.#.@@###@@.#.',
      '...#.....#...',
      '@#.#.@@@.#.#@',
      '...#..#..#...',
      '.@@@.###.@@@.',
      '.....#.#.....',
      '#.@#.....#@.#',
      '#..#.###.#..#',
      '..@.......@..',
      '..@.......@..',
    ],
    enemies: [6, 4, 6, 4],
  },
];

export function mulberry32(a: number): () => number {
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const MIRROR: Record<string, string> = { l: 'r', r: 'l', L: 'R', R: 'L' };
const PROTECT = [[0, 0], [6, 0], [12, 0], [4, 12], [8, 12], [5, 11], [6, 11], [7, 11], [5, 12], [6, 12], [7, 12]];

/** Symmetric procedural stage for numbers past the hand-made list. */
export function generateStage(n: number): StageDef {
  const rnd = mulberry32(n * 7919 + 13);
  const themes = [
    { '#': 0.34, '@': 0.06, '%': 0.1, '~': 0.04, '-': 0.04, h: 0.06 },
    { '#': 0.24, '@': 0.05, '%': 0.06, '~': 0.02, '-': 0.18, h: 0.04 },
    { '#': 0.22, '@': 0.08, '%': 0.22, '~': 0.06, '-': 0.02, h: 0.04 },
    { '#': 0.3, '@': 0.12, '%': 0.05, '~': 0.1, '-': 0.03, h: 0.08 },
  ];
  const th = themes[n % themes.length];
  for (let attempt = 0; attempt < 50; attempt++) {
    const g: string[][] = Array.from({ length: 13 }, () => Array(13).fill('.'));
    for (let y = 0; y < 13; y++) {
      for (let x = 0; x <= 6; x++) {
        let r = rnd();
        let ch = '.';
        for (const k of ['#', '@', '%', '~', '-'] as const) {
          if (r < th[k]) { ch = k; break; }
          r -= th[k];
        }
        if (ch === '.' && r < th.h) ch = 'lrtbLRTB'[Math.floor(rnd() * 8)];
        if ((y === 0 || y === 12) && ch !== '%' && ch !== '-') ch = rnd() < 0.2 ? '#' : '.';
        g[y][x] = ch;
        g[y][12 - x] = x === 6 ? ch : MIRROR[ch] ?? ch;
      }
    }
    // keep a steel block somewhere in the centre lane so the top spawn can't snipe the base
    if (![2, 3, 4, 5, 6, 7, 8].some((y) => g[y][6] === '@')) g[3 + Math.floor(rnd() * 5)][6] = '@';
    for (const [x, y] of PROTECT) g[y][x] = '.';
    const rows = g.map((r) => r.join(''));
    if (connected(rows)) {
      const armor = Math.min(8, 2 + Math.floor(n / 4));
      const power = Math.min(8, 3 + Math.floor(n / 5));
      const fast = 5;
      return { name: `SECTOR ${n}`, rows, enemies: [Math.max(0, 20 - armor - power - fast), fast, power, armor] };
    }
  }
  return { ...STAGES[0], name: `SECTOR ${n}` };
}

/** Every spawn can reach the base if bricks are shot away (steel/water are walls). */
function connected(rows: string[]): boolean {
  const open = (x: number, y: number) => x >= 0 && y >= 0 && x < 13 && y < 13 && !'@~LRTB'.includes(rows[y][x]);
  const seen = new Set<number>();
  const q: [number, number][] = [[6, 10]];
  seen.add(10 * 13 + 6);
  while (q.length) {
    const [x, y] = q.pop()!;
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const nx = x + dx;
      const ny = y + dy;
      if (open(nx, ny) && !seen.has(ny * 13 + nx)) {
        seen.add(ny * 13 + nx);
        q.push([nx, ny]);
      }
    }
  }
  return [[0, 0], [6, 0], [12, 0], [4, 12], [8, 12]].every(([x, y]) => seen.has(y * 13 + x));
}

export function stageDef(n: number): StageDef {
  return n <= STAGES.length ? STAGES[n - 1] : generateStage(n);
}

/** Enemy spawn order: a shuffled mix, gentler at the start. */
export function enemyQueue(def: StageDef, n: number): number[] {
  const rnd = mulberry32(n * 31 + 7);
  const list: number[] = [];
  def.enemies.forEach((c, t) => {
    for (let i = 0; i < c; i++) list.push(t);
  });
  for (let i = list.length - 1; i > 0; i--) {
    const j = Math.floor(rnd() * (i + 1));
    [list[i], list[j]] = [list[j], list[i]];
  }
  // open with the weakest tank if the stage has one
  const firstBasic = list.indexOf(0);
  if (firstBasic > 0) [list[0], list[firstBasic]] = [list[firstBasic], list[0]];
  return list;
}

export type EnvName = 'day' | 'dusk' | 'night' | 'snow' | 'rain';
export const ENV_LABEL: Record<EnvName, string> = { day: 'DAY · CLEAR', dusk: 'DUSK · HAZE', night: 'NIGHT · STORM', snow: 'WINTER · SNOW', rain: 'RAIN · OVERCAST' };
export function envFor(n: number): EnvName {
  if (n === 5 || n === 6 || (n > 9 && n % 4 === 0)) return 'snow';
  return (['day', 'dusk', 'night'] as const)[(n - 1) % 3];
}
