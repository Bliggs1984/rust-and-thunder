# Campaign mode: design

Agreed in the design interview of 2026-10-13. Arcade mode stays exactly as it is; the campaign is a new
menu entry.

## Pitch

An easy roguelite tank RPG set during the invasion of a made-up country, clearly modelled on the war in Ukraine.
You drive one battered tank, later two in co-op, across big scrolling regions. You free towns, strip enemy wrecks
for scrap and parts, and bolt them onto your own tank. Each region ends with a boss. Tone: scrappy underdog,
hopeful and defiant, with dry crew humour. Serious about the war, but fun with friends.

## Setting rules

- The country, the invader, places and people are all invented. The gear and the feel are borrowed: improvised
  armour, drones, captured tanks turned against their owners.
- No real politicians, units or named events. Civilians are never targets. Towns are places you free and defend.

## A run

- 4-5 regions, 1-2 hours in total, saved between sessions.
- Each region is one large, procedurally generated, smoothly scrolling map. Towns to free, supply depots to
  destroy and map events are scattered across it, and you choose the order. Freeing enough of the region
  reveals where its boss is.
- Defeat means a retreat. You keep garage parts, crew and story progress, and restart from the latest region you
  reached. Each attempt leaves you stronger, which is the "easy" part.
- No eagle base. The open map replaces it.

## Regions and bosses (draft order)

| Region | Look (existing weather/env) | Boss |
|---|---|---|
| 1 Farmland | sunny day, fields, tree lines | Heavy tank ace: huge, escorted, weak points shot off one by one |
| 2 Rail junction / forest | dusk haze | Armoured train: runs along tracks, turret cars destroyed one by one |
| 3 River delta | rain, water | River flagship: shells the banks; drones and ambushes are the counters |
| 4 Ruined town | night storm | Attack helicopter: flies over walls and water, fires rockets |
| 5 Winter front (optional) | snow | Final fight: a mix of earlier bosses, to be decided later |

## Your tank

- **Reload time** instead of the arcade's one-shell-in-flight rule (decided 2026-10-14): one shot per reload however far the shell flies. Fire rate is an upgrade stat: power-up stars now; barrel/autoloader parts, the gunner's perk and veterancy later (Tank.reloadMul). A thin line under the armour pips shows the reload.
- **Armour bar** instead of one-hit deaths. Patch it with scrap in the field or at a workshop. A field patch has a
  15 s cooldown per player (decided 2026-11-18), so a burst can still knock you out; scrap is scarce enough that charges
  and repairs are a choice (wrecks 3-6, villages 10, depots 30, bosses 25-100).
- **Part slots** (draft): armour plates, engine, barrel, tracks, drone jammer, mine plough. Fitted parts show on
  the sprite as bolted-on plates and mismatched pieces.
- Salvage loop: destroyed enemies drop scrap and the odd part; drive over them to collect. Workshops in freed
  towns are where the mechanic strips parts, fits upgrades, repairs, and crafts ability charges.

## Crew

Named crew with pixel portraits, recruited during a run, one per region (WASP, AUNTIE, OWL, STITCH, STATIC), after the 2nd freed town or, from region 2, from a map event; none from events in region 1. Each has one perk and
unlocks one ability type. They talk in story scenes and briefings. Draft roles: driver, gunner, mechanic, drone
operator, scout.

## Abilities

Crew unlock an ability *type*; *charges* are crafted from scrap at a workshop.

- **FPV drone strike:** aim a reticle; a drone dives in and hits the top armour. Strong against bosses and
  armoured tanks. Since 2026-11-18 every boss has a counter with a visible tell, so drones are a tool and not an
  instant win (playtest: "you just had to launch drones at it"): GRINDER and FROSTBITE pop smoke after a drone hit
  (drones lose them for 7 s), ANVIL's AA car and MORAY's deck MG shoot drones down until destroyed, VULTURE drops
  flares (drones only hit it flying low, one per pass).
- **Infantry ambush:** hide an anti-tank squad in trees or ruins. They fire when enemies pass.
- **Recon drone:** shows hidden enemies, mines and ambushes for a short time.

## Enemy tricks

Enemy drones (audible before visible, can be shot down), hidden infantry in trees and ruins, minefields on roads
and fields, and off-screen artillery (warning circles, then shells land).

## Enemy AI

Decided 2026-10-14: the arcade's random roaming and firing won't carry a campaign. Enemies fight as groups with
jobs, loosely inspired by the invader's tank tactics as publicly reported from the war in Ukraine, turned into
readable game patterns (invented units and names, as in the setting rules). Defenders and attackers are one idea,
not the limit. Draft roles:

- **Garrison (defenders):** hold a town, depot or crossroads from dug-in spots (hull-down behind brick or in tree
  lines: harder to hit). They don't chase far, and radio for help when attacked.
- **Assault group (attackers):** 2-4 tanks drive in a column along roads, then spread into a line near the target.
  Sometimes led by a mine-plough tank. Retake towns you freed (counterattacks).
- **Overwatch:** a tank firing from long range at the edge of the screen, a few shots and then it moves
  (shoot and scoot).
- **Recon and spotting:** a fast scout or a drone finds you, then artillery or an assault group comes. Kill the
  spotter first and the follow-up is weaker.
- **Artillery prep:** warning circles over a position before an assault group moves in.
- **Supply convoys:** trucks and escorts moving along roads between depots; ambush them for scrap and parts.
- **Morale:** damaged tanks pull back to repair; a crew may abandon a tank, leaving it to capture or strip for
  parts (feeds the salvage loop).

How it works: a group layer (each group has a job: hold an area, move along a route, attack a target, retreat)
on top of the existing per-tank movement and distance fields, plus perception (line of sight; trees hide you;
noise and muzzle flashes give you away). Tuned "easy": readable tells before every attack (tracks heard, column
dust, radio chatter on the HUD), so the player can outthink groups rather than out-aim them. `npm run sim` gains
checks per role (garrisons stay put, assaults reach their targets, no stuck groups).

## Story

Two layers: a line or two of radio chatter on every mission card and event, plus short scenes with portraits and
dialogue between regions that carry the plot.

Built 2026-10-14 (Phase 5, `src/game/story.ts` holds the text; screens in `src/ui-story.ts`). Draft plot:

- **Opening** (new campaign): the Dominion has crossed the border. Its tank crew abandons a tank in Mykola's beet
  field when they see his combine. Yurko gets it running; Mykola names it BABUSYA after his grandmother. Major Koval
  (district HQ) finds a Dominion tank on the farm road flying our flag: "You have a tank. You are now a unit."
- **I Farmland:** free the farm villages along the river road; the farmers talk of GRINDER, a heavy tank.
- **II Rail Junction** (the approved mockup's lines): Staryi Mlyn junction; the railwaymen call the armoured train ANVIL.
- **III River Delta:** the Dominion falls back into the Synia delta; the fishermen call the gunboat MORAY.
- **IV Ruined Town:** Bilohir, people still in the cellars; a gunship with a searchlight, VULTURE.
- **V Winter Front:** the command post on the Hran ridge, BASTION. "Take it and the Dominion goes home."
- **Ending:** the front holds; the roads home (two crew quips); spring: "Go home and plant something." Then THE END /
  CAMPAIGN COMPLETE with the run's totals, and the save carries on as LIBERATION mode.

Flow: new campaign = opening + briefing I before region 1; after each region: region-clear card with HQ's debrief
line, the camp, then the next briefing, then the region's intro card with one HQ line. Each briefing has three answers:
a charge, scrap, or ASK FIRST (a hint Koval answers, repeated on the radio when the region starts). A charge the crew
can't use yet becomes its scrap price. ESC held skips to the answers; held again takes answer 1 and its reward.

## Map events

Text events found on the map, each with a choice and a reward or risk. For example: "A village asks for help
clearing mines...". Some lead to recruiting crew or getting supply drops.

## Campaign UI

Decided 2026-10-13: redesign the campaign UI completely, "RPG meets Company of Heroes", in the same pixel style.
CoH side: bottom command bar (tank card, armour, ability buttons with hotkeys and cooldowns), resource strip,
tactical minimap with sector control, objective tracker. RPG side: crew roster with portraits and perks, garage
paper-doll with part slots, dialogue scenes, strategic region map. Mockups: mockups/campaign-ui/.

Decided 2026-10-14: gameplay fills the whole window, no side margins: in campaign the native view widens
to the window's aspect (224 px tall, e.g. ~400 px wide at 16:9; arcade stays 256×224). The HUD floats over the
map. Bottom command bar = yes, but compact, hugging the tank card and ability buttons, no dead space. Ability
charges are shared by both tanks. Ability buttons keep text labels, except co-op at small sizes.

## Co-op

One or two players. A shared camera follows both tanks and zooms out a little as they spread apart; neither tank
can leave the screen.

## Build order

Each phase ends with something playable and checked on a real GPU with the screenshot tools.

0. **Scrolling engine.** Camera over a map bigger than the screen: chunked cell map, terrain shader with a
   camera offset, the fluid/smoke grid scrolling with the view, lights and bounce light in view space. Perf gate:
   friends' PCs must hold 60 fps at the auto-lowered resolution before anything else is built on it.
1. **Driving a region.** Region generator (terrain, roads, towns), armour bar, scrap drops, minimap, campaign
   HUD from the mockups, and the enemy group layer with the first roles: garrisons and road-bound assault groups.
2. **Run loop.** Objectives (free towns, destroy depots), workshop and garage, parts, save/load, retreat on
   defeat. Enemy counterattacks on freed towns, overwatch, morale and abandoned tanks.
3. **Crew and abilities.** Crew, portraits, the three abilities, then the enemy tricks (recon and spotting,
   artillery prep, drones, mines, ambush infantry) and supply convoys.
4. **Bosses**, one per region.
5. **Story and events.** Briefings, scenes, map events, polish and balance (`npm run sim` gains campaign
   checks).

## Still to decide

- Names: the country, the invader, the campaign title, crew names. Current draft (Phase 5 story, change in
  `src/game/story.ts`): the country **ZORIANA** (from *zorya*, dawn; flag sunflower gold over green), the invader
  **THE VORSK DOMINION** ("the Dominion"), the campaign title **BABUSYA'S ROAD**, places Staryi Mlyn, the Synia delta,
  Bilohir, the Hran ridge.
- ~~Screen layout while scrolling~~: decided 2026-10-13, the map fills the whole 256×224 view (HUD over or
  around it; arcade keeps its 208×208 field).
- Ability and repair keys for each player in keyboard co-op.
