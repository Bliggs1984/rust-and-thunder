<img src="assets/icon.svg" width="64" height="64" alt="">

# RUST & THUNDER

RUST & THUNDER is a top-down tank game for the browser, inspired by the 8-bit tank-and-base arcade games of the 1980s: guard your base, clear each stage of enemy tanks. It keeps the pixel-art look and adds modern lighting, weather and a campaign.

## Play

Double-click **`RustAndThunder.html`**. It is one self-contained file and runs in any modern browser.

| | Player 1 | Player 2 (2-player mode) |
|---|---|---|
| Move | Arrows or WASD (2P: WASD) | Arrows |
| Fire | Space (2P: Space / E) | Enter / Right Shift / Right Ctrl |

Pause: Esc or P. R toggles RTX lighting, M mutes, C toggles the CRT effect, F goes fullscreen, ` shows FPS. Gamepads work too.
On the first stage screen, press Up/Down to choose a starting stage.

**Campaign (in development):** title menu → CAMPAIGN opens a small menu: CONTINUE (only when a run is saved; it
shows the region and your scrap), NEW CAMPAIGN (asks first if it would replace a save), CREW (1 or 2 tanks) and
BACK. A run is a chain of big scrolling regions (all farmland for now; the weather goes day, dusk, night, snow).
Free villages (park at its flag with no enemies inside): once three are free, HQ finds the region's boss (a toast,
a crosshair on both maps, the boss line on the objectives plate). Destroying the boss clears the region. The
Region 1 boss is GRINDER, a 48 px heavy tank ace with an escort: a main gun that glows and beeps for a second before
its heavy shell (3 armour), two machine-gun sponsons, and side skirts. Boss guns are not tied to the 4 directions:
main guns turn to you and fire along the dotted warning line at any angle (keep moving during the glow), and
machine guns and bunker guns fire diagonally too. Shoot off the guns and skirts; its turret
only takes shells once a skirt is gone (or from behind), while FPV drones hit any part for double damage. Every
boss has an answer to drones, each with its own tell, so a drone is a big hit and never a way to skip the fight:
GRINDER pops smoke after a drone hit and the next drones lose it for 7 s ("LOST IN SMOKE"); the train's AA car and
the flagship's deck MG shoot some drones down until you destroy them; the helicopter drops flares, so drones only
get through while it flies low, one per pass ("DECOYED"). A bar
at the top shows its parts while it is near. It is worth 25-100 scrap and two captured parts. Supply depots are optional:
six shells destroy the fuel tanks or ammo stack in the middle for 30 scrap and a part. Your tank has armour
(about 4 hits), wrecks drop scrap and parts, and 4 patches armour (a charge or 15 scrap; then 15 s before that tank can patch again: the slot shows a dark wipe and the seconds left). Keys 1-4 are the ability
buttons (co-op: player 2 uses numpad 1-4), TAB opens the big map. Gamepad: hold LB or RB and press the d-pad for
abilities, Back/View for the map.

At a freed village's flag with no enemy near, Enter (pad: Start, or A while standing still) opens the workshop
camp; the game waits while it is open. Clearing a region shows a tally, then the camp, then the next region.
Losing every life is a retreat, not game over: you keep scrap, parts, charges, veterancy, the villages you freed
and the depots you destroyed, and replay the same region with +1 life per retreat (up to +2) and slower enemies (10%
per retreat, up to 30%; Farmland, Rail Junction and River Delta already start 20%, 10% and 25% slower and have
smaller garrisons, while Ruined Town and Winter Front start 10% and 20% quicker with larger ones). The run saves
itself in the browser (when a village is freed or lost, a depot destroyed, the camp closes, a region is cleared, and
on a retreat or quit). CONTINUE puts you back at the region's start road with freed villages still free (their
workshops open, the last one freed is where a knocked-out tank comes back), destroyed depots still down and finished
map events still finished; the boss starts over at full strength. See CAMPAIGN.md for the plan.

## Features

- **RTX lighting** (press R to compare on and off):
  - noise-free bounce light (radiance cascades): every glowing thing lights its surroundings with soft shadows
  - light bounces off walls and colours what's around them
  - reflections on water, ice, steel and rain puddles
  - soft shadows, plus headlight beams you can see through fog and rain
  - every bullet and explosion lights the scene
- **Weather and time of day:** sunny days on textured earth (dirt, grass, pebbles, cracks) with drifting cloud shadows, hazy dusk, night storms with lightning and thunder, and snow.
- **Title screen:** the RUST & THUNDER logo in the game's pixel font over a night storm; a lightning bolt strikes soon after it appears and every 6-12 s, flashing the screen and the logo, with thunder once sound is unlocked (softer flash when the OS asks for reduced motion). `node tools/shot.mjs title-logo` captures it.
- **Shader-drawn terrain:** water, trees, bricks, steel, ice and ground are all generated per pixel by shader code, so nothing repeats on a grid. Water is deep in the middle and pale at the banks; trees are lit leaf clumps; bricks vary in length and chip at the edges; every steel plate differs.
- **Foliage** lets dappled green light through and glows when lit from behind. Trees are slightly see-through (tanks show faintly underneath).
- **Live fluid simulation** (inspired by Animal Well): smoke from explosions, guns and the burning base swirls, drifts on the wind, flows around walls and gets pushed by tanks and bullets. It is lit by headlights and blasts, fire glows inside it, and hot air shimmers.
- **Interactive water:** ripples from tanks, bullets, blasts and rain spread and bounce off the banks; foam along the shore and light patterns on the river bed.
- **Light style setting:** SMOOTH (modern) or PIXEL (stepped, Animal Well-style).
- **Interface in the game's own style:** riveted steel panels and the game's pixel font, with sprite icons for lives, power and gear. Side panels show the stage, incoming tanks and base status. Stage cards, a results screen, pop-up messages and a settings menu (music and effects volume, CRT filter, FPS counter).
- **Modern sound:** layered cannon shots, deep explosions with reverb, sounds placed left or right by where they happen, an engine rumble, rain and wind, and generated synthwave music. In the campaign each region has its own folk tune, with drums and bass that come in when enemies are near; bosses get folk metal.
- **Smarter enemies:** some find a path to your base, some hunt you, the rest wander like classic arcade tanks.
- **Base shield** absorbs one hit per stage.
- **New power-ups:** EMP blast, Ricochet rounds, Hover (cross water), Max Gun, plus the classic set. Arcade only: campaign regions have no flashing bonus tanks and no power-up drops (scrap, parts and loot instead).
- 9 hand-made stages, then endless generated ones. If a PC struggles, the game lowers its own resolution to keep things smooth.

## For developers

```
npm install
npm run dev      # live dev server at http://localhost:5199
npm run build    # type-check, build, and refresh RustAndThunder.html
npm run sim      # headless balance check (game logic only)
node tools/shot.mjs title stage1 night   # headless screenshots into shots/
node tools/audio.mjs                     # renders every sound offline and prints levels
node tools/perf.mjs 3 10                 # frame rate on this PC's GPU (hidden browser)
node tools/perf.mjs 1 10 region=1        # same, in campaign region 1
node tools/perfspots.mjs 1 1             # frame rate parked on a town, depot, farmyard and crop fields (stage, map seed)
node tools/perfgate.mjs                  # frame times at each fallback resolution, with a 4x slower CPU
node tools/play-server.mjs               # keys in, screenshots out: lets an AI agent play (see the file)
```

URL flags for testing: `?mute=1&autostart=1&stage=5&players=2&autoplay=1&debug=1&crt=1`.
With `debug=1`: N skips the stage, K kills all enemies, B reveals the region's boss (again: destroys it), number keys
1–0 give each power-up (in campaign regions Shift + 1–0, since the digits are ability keys there). `npm run aisim`
checks the campaign enemy AI headless, `npm run bosssim` the bosses (`node tools/shot.mjs bossday bossnight
bossreveal` for pictures).
`?region=N` plays campaign test region N (a scrolling map; a throwaway run that is never saved), `?speed=0.25` slows
the game down, `?abil=1` unlocks the three crew abilities with 9 charges each (`npm run abilsim` checks them),
`&crew=all` puts the whole crew aboard a `?region=N` run (every ability unlocked, no recruit cards);
`?arena=tricks` starts a small test map for ability and enemy-trick checks (src/game/arena.ts; throwaway run, whole crew,
9 charges of each ability, 9 lives): a wounded enemy tank on 1 hp ("1 HP"), an enemy tank passing back and forth on
the cross road (never fires), trees beside the start road to ambush from, a hidden minefield ("MINES"), a hidden rocket
team ("ROCKETS"), an artillery pad ("ARTY": drive onto it and a barrage lands there) and an attack drone every 10 s or
so; everything used up comes back after a few seconds (`node tools/shot.mjs arena` for pictures).
`?camp=1` opens the camp screen on a demo run (`&crew=all` / `&crew=start` for the full or starting roster). The saved run is the JSON in localStorage key `tank1990neo.run` (the key keeps the game's old name so existing saves still load) (`{ v: 1, at, run: RunState }`,
src/game/save.ts); an unreadable or older-version save is dropped. The four first-play prompts (move and fire, park
at the flag, 4 patches armour, TAB map; `src/tips.ts`) remember what was shown in `tank1990neo.tips`: remove that
key to see them again.
In a region the map fills the whole window: the native screen takes the window's shape (224 px tall and
256–480 wide, or 256 wide and 224–448 tall on portrait windows), so pixels stay square. Past those limits
(wider than about 2.1:1) dark bars fill the sides. Arcade stages, the title and game over stay 256×224.

Code map: `src/gl` (WebGL2 renderer and shaders), `src/art` (pixel art generated in code, font),
`src/game` (rules, stages, drawing), `src/app.ts` (screens), `src/audio.ts` (synthesised sound).
