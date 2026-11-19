export const FX = 24; // playfield origin on screen (centred)
export const FY = 8;
export const FS = 208; // playfield size in px
export const NC = 52; // 4px cells per side
export const NN = 25; // 8px tank nodes per side (0..24)

export const EMPTY = 0;
export const BRICK = 1;
export const STEEL = 2;
export const WATER = 3;
export const TREES = 4;
export const ICE = 5;
/** Campaign: dirt road. Drives like open ground; drawn as a track; assault groups and convoys follow it. */
export const ROAD = 6;
/** Campaign (Phase 4): railway track. Tanks drive over it like a road; the armoured train runs on it. */
export const RAIL = 7;

export const UP = 0;
export const RIGHT = 1;
export const DOWN = 2;
export const LEFT = 3;
export const DX = [0, 1, 0, -1];
export const DY = [-1, 0, 1, 0];

export const MAT_GROUND = 0;
export const MAT_STD = 1;
export const MAT_METAL = 2;
export const MAT_WATER = 3;
export const MAT_ICE = 4;
export const MAT_FOLIAGE = 6;
export const MAT_BRICK = 7;
export const MAT_STEEL = 8;
export const MAT_ROAD = 9;
/** Phase 4: railway track (ballast, sleepers, two steel rails), drawn in GBUFFER_FS along the tracks' centre lines (railgeo.ts). */
export const MAT_RAIL = 10;

export const EAGLE_X = 96;
export const EAGLE_Y = 192;
export const P_SPAWN: [number, number][] = [[64, 192], [128, 192]];
export const E_SPAWN: [number, number][] = [[96, 0], [192, 0], [0, 0]];

export const ENEMY = [
  { name: 'basic', speed: 0.55, bullet: 2.2, hp: 1, pts: 100, fire: 0.7 },
  { name: 'fast', speed: 1.25, bullet: 2.8, hp: 1, pts: 200, fire: 0.7 },
  { name: 'power', speed: 0.8, bullet: 4.4, hp: 1, pts: 300, fire: 1.1 },
  { name: 'armor', speed: 0.7, bullet: 3.0, hp: 4, pts: 400, fire: 0.9 },
];

export const PLAYER_SPEED = 1.0;

export const PW = {
  HELMET: 0,
  CLOCK: 1,
  SHOVEL: 2,
  STAR: 3,
  GRENADE: 4,
  TANK: 5,
  GUN: 6,
  SHIP: 7,
  EMP: 8,
  RICOCHET: 9,
};
export const PW_NAMES = ['SHIELD', 'FREEZE', 'FORTRESS', 'POWER UP', 'GRENADE', '1UP', 'MAX GUN', 'HOVER', 'EMP BLAST', 'RICOCHET'];
export const PW_COLORS: [number, number, number][] = [
  [0.5, 0.9, 1.0], [0.6, 0.7, 1.0], [1.0, 0.75, 0.4], [1.0, 0.9, 0.3], [0.6, 1.0, 0.4],
  [1.0, 0.7, 0.2], [1.0, 0.5, 0.3], [0.4, 0.7, 1.0], [0.4, 0.6, 1.0], [1.0, 0.6, 0.2],
];

// Campaign ground kinds (RegionSpec.kinds, one per cell; visual only: the cell type stays EMPTY where tanks drive).
// Written by the region generators (src/game/regions/), drawn by the ground material in GBUFFER_FS.
export const GK_NONE = 0;
/** house floor: planks */
export const GK_PLANKS = 1;
/** paving slabs: town squares, pavements, platforms */
export const GK_PAVING = 2;
/** crop rows: green tops (beets) */
export const GK_CROPS = 3;
/** crop rows: gold (wheat stubble) */
export const GK_WHEAT = 4;
/** sunflowers */
export const GK_SUNFLOWER = 5;
/** poured concrete: depots, factories, bunkers */
export const GK_CONCRETE = 6;
/** farmyard: packed earth and cobbles */
export const GK_YARD = 7;
/** tiled floor: churches, halls, stations, city buildings */
export const GK_TILES = 8;
/** trench floor: dug earth with duckboards */
export const GK_TRENCH = 9;
/** added to a crop kind when its rows run north-south */
export const GK_VERT = 16;
