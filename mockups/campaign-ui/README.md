# Campaign UI mockups

Static mockups of the campaign-mode UI, made for approval before anything was built. The brief: RPG meets
Company of Heroes, in the game's pixel style. Nothing here touches the game code.

| Screen | HTML | PNG |
|---|---|---|
| In-mission HUD, 1 player | `hud-1p.html` | `hud-1p-1080.png`, `hud-1p-720.png`, `hud-1p-portrait.png` (1080x1920) |
| In-mission HUD, 2-player co-op | `hud-2p.html` | `hud-2p-1080.png`, `hud-2p-720.png` |
| Garage / workshop | `garage.html` | `garage-1080.png` |
| Crew roster | `crew.html` | `crew-1080.png` |
| Region map / mission select | `region-map.html` | `region-map-1080.png` |
| Briefing / dialogue scene | `briefing.html` | `briefing-1080.png` |
| Design-system sheet | `system.html` | `system-1080.png` |

Each HTML file is self-contained and lays itself out for whatever window it opens in. To change them, edit
`src/` and run `node mockups/campaign-ui/build.mjs [filter]` from the repo root. It inlines `src/common.*` and
`img/` into the HTML, then renders the PNGs with headless Chromium. `prep_bg.py` makes the game-view
backdrops from screenshots in `shots/`.

## Design system

**One UI pixel.** Everything sits on one grid. One UI pixel (`--u`) is 3 screen px at 1080p, 2 at 720p and
4 at 1440p. Narrow windows size it from the width instead. Every size, gap, border and icon is a whole number
of UI pixels, so edges stay hard at every resolution.

**Palette (16 colours).** The arcade UI's NES-style set, with fixed meanings:

| Colour | Used for |
|---|---|
| Gold `#f8b800` (hi `#ffe08a`, shade `#c87000`) | you and player 1, freed towns, the current focus or selection |
| Green `#7cd83a` | player 2, and gains (+ stats) |
| Red `#f0482a` | enemy, held towns, danger, losses |
| Blue `#6c9cff` | intel: recon, radio from HQ, map events, XP |
| Ink / dim / mute (`#f4efe2` / `#9aa0a8` / `#5d636c`) | three levels of text importance |
| Plate greys (`#0b0c0e` line, `#1c1f24` plate, `#2b2f36` raised, `#4a4f58` bevel) | all panels |

Fills are flat. The only "gradients" are hard bands on headline text, with the stops on glyph rows.

**Plates.** These are the arcade plates, flattened:
- A 1 px black outline, a 1 px light bevel top-left and a dark bevel bottom-right.
- Corner rivets and a hard 2 px drop shadow.
- Headers use the diagonal hazard stripe, drawn as a pixel tile rather than a CSS gradient.
- Sunken "wells" hold portraits, icons and maps.
- Ownership is a 1 px coloured rim inside the outline: gold for P1, green for P2, gold for the selected card.

**Type.** All text is the game's 5x7 font, drawn as masked glyphs (the `PixelText` approach from `src/ui.ts`),
at whole-pixel scales:

| Name | Glyph scale | Used for |
|---|---|---|
| SM | 2 | labels, hints, flavour text |
| MD | `u` | body text, names |
| LG | `u + 1` | resource numbers, the current dialogue line |
| XL | `2u` | screen titles |
| XXL | `3u` | big numbers |

The mockups add seven glyphs to `src/art/font.ts`: `% " ( ) = # &`.

**Icons.**
- Most are 16x16 pixel art with a 1 px outline, lit from the top-left, and at most 4 colours plus outline.
- Small marks (veterancy chevron, objective diamond, town pip, lock, d-pad, signal) are 7 to 12 px.
- All are drawn at 1 UI pixel per art pixel. Recolouring is done by palette swap: held = red, empty = grey.
- Portraits are 32x32, built from shared layers (head, hair, kit) so the crew look like one cast.
- The tank is 32x32, and the fitted parts are drawn onto it.

**Hierarchy.** Each panel has at most one gold item: the thing to look at or press next. Everything else is
ink, dim or mute.

## Layout zones (in-mission HUD)

Revised 2026-10-14 from playtest feedback ("a lot of dead space on the bar", "the gameplay should be full
screen").

**The map fills the window.** No side margins and no full-width bar. Campaign keeps the arcade's pixel scale
and widens the native view to the window's aspect instead: 224 native px tall on wide windows (about 400x224
at 16:9, so 4.82 screen px per native px at 1080p and 3.2 at 720p), or 256 wide on windows narrower than 8:7
(256x455 at 1080x1920, 4.22 px). The arcade keeps 256x224. The mockup backdrops are stitched from real
region screenshots at that scale (`prep_bg.py`).

**Every HUD element floats over the map** as a compact plate, slightly see-through (86% opaque) with the usual
crisp outline and bevel. Each plate hugs its contents, sits 4 UI px from the window edge, and leaves the middle
of the screen (your tank) clear. Together they cover about 15% of the window in 1P and 17-19% in co-op
(the old layout lost about 45% to the bar and the side margins).

| Zone | Holds | Size at 1080p (720p) |
|---|---|---|
| Top left | Objectives: towns-freed pips in the header, current objective with progress, depots, locked boss | 318x189 (262x126) |
| Top right | Scrap and parts, then the pause key (`ESC PAUSE`) tucked in at the end | 402x60 (308x40) |
| Bottom centre | Command cluster: tank card and the four ability buttons in one plate, nothing else | 846x126 (632x86) |
| Bottom left | Minimap, 80x80 map pixels, region name and the `TAB MAP` key in its header | 258x295 (172x202) |
| Bottom right | Radio: portrait, speaker, channel and one short line | 336x114 (300x94) |

- The command cluster has 3 UI px of padding top and bottom, and is as tall as the tank card (42 UI px). The
  tank card shows the sprite, tag, name, veterancy chevrons, armour segments with the number, and the XP bar.
  Ability buttons have hotkeys, charges, a pixel cooldown sweep, and text labels underneath.
- The key hints moved out of the bar: `TAB` sits on the minimap it opens and `ESC` on the resource strip.
- On the map: an armour bar over your tank, the capture ring on the town you're freeing, and an edge warning
  at the top when an enemy drone is heard.
- If the minimap or radio would touch the cluster, it moves up to sit above it instead (portrait, and the
  radio in co-op at 720p).

**Co-op.**
- One cluster: P1's tank card on the left (gold), the shared ability buttons in the middle, P2's card mirrored
  on the right (green). Charges are shared by both tanks, so there is one set of buttons. Each shows P1's
  keycap (1-4) top left and P2's d-pad direction top right, and ready buttons get a neutral steel rim rather
  than one player's colour.
- The cards drop the words ARMOUR and VET to save width.
- At 720p the labels under the ability buttons are dropped (the decided exception). The cluster is
  1197x126 at 1080p and 816x84 at 720p.
- Tags over the tanks (IP / IIP) match the cards.

**Portrait (narrower than 8:7).**
- Same floating plates. Objectives and resources sit at the top; the cluster sits at the bottom with the
  minimap and radio on top of it at the two edges. The taller view shows more map above and below the tank.

**Camp screens (garage, crew, map).**
- These are tabs of one screen (Q/E or LB/RB to switch), with the camp name at top left and the resource
  strip at top right.
- Each tab has one hero panel: the tank on its blueprint, the five crew cards, or the region map.
- A key-hint line runs along the bottom.

## Where each CAMPAIGN.md feature lives

| Feature | Where |
|---|---|
| Armour bar instead of one-hit deaths | tank card in the command cluster, a small bar over each tank, garage repair panel |
| Scrap and parts salvage | resource strip on every screen, part rewards on the map card, garage parts bin |
| Part slots shown on the tank (armour, engine, barrel, tracks, jammer, plough) | garage blueprint with leader lines; the same sprite in the HUD tank card |
| Workshop: repair, fit, strip, craft charges | garage (repair, fit/strip, craft panel with costs) |
| Abilities (FPV strike, infantry ambush, recon drone) | command-cluster buttons; crafting in the garage; each crew card's "unlocks" |
| Field patch with scrap | 4th command-cluster button (PATCH, costs scrap) |
| Named crew, portraits, one perk each, levels | crew roster cards (XP bar, perk, ability, quip, which tank they ride in) |
| Radio chatter on missions | HUD radio box (portrait + one line) |
| Story scenes between regions | briefing scene: two portraits, a radio transcript and choices with rewards |
| Map events with a choice | event marker on the region map and minimap; event card on the map tab |
| Towns to free, depots, any order | region map markers, objective tracker, sector tint on map and minimap |
| Boss revealed after enough towns | locked boss card ("free 1 more town") and boss line in the objective tracker |
| 4-5 regions | region strip on the map tab |
| Enemy drones, mines, artillery | drone edge warning on the HUD; mines on the map (artillery circles are drawn by the game) |
| Co-op 1-2 players | two-player HUD (one cluster: both tank cards around one set of shared ability buttons, tank tags) |
| Civilians never targets | towns show their population sheltering, and the briefing gives you a choice to ask about civilians first |

## Placeholders and limits

- The HUD backdrops are stitched from Phase 0 region screenshots (`shots/region-*.png`, 2026-10-14 renderer):
  region-a/b/c are one autopilot run over the same ground, laid out by their camera offsets; the edges come
  from the co-op region and are joined along least-visible seams. Faint seams remain in the portrait one (in
  the dirt below the brick blocks). Camp screens still use an arcade dusk stage behind a veil.
  The minimap and region map use the real test region from Phase 0 (`img/region.png`).
- All names are placeholders, made up for the mockups: towns, crew, the tanks "Babusya" (granny) and "Dido"
  (grandpa), and Major Koval.
- Ability keys for keyboard co-op are still undecided (CAMPAIGN.md).
