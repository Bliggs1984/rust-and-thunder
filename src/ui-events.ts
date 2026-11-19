// Phase 5 map event card: the briefing scene (ui-story.ts) with one page: the speaker's portrait, their lines, and the
// answers with what each pays and risks. Also gives the event speakers who are not crew a portrait in the cast's
// pixel style (ui-campaign.ts portraits) and a name plate. The events themselves are src/game/events.ts.
import { CIVILIANS, type EventCard } from './game/events';
import type { RegionKind } from './game/region';
import type { Backdrop, Choice, Line } from './game/story';
import { addPortrait, type PortraitDef } from './ui-campaign';
import { PLATES, openStory } from './ui-story';

const BG: Record<RegionKind, Backdrop> = { farm: 'farm', rail: 'rail', delta: 'delta', ruins: 'ruins', winter: 'winter' };

// ---------- portraits (32x32, same layers as the crew) ----------
const FACES: Record<string, PortraitDef> = {
  OLHA: { // villager: red headscarf with white dots, grey fringe
    skin: 'light', hair: ['#c6ccd4', '#8a919b'], clothes: ['#3e5a3a', '#2c4228'], collar: '#e8d8a8', smile: true, wrinkles: true, bg: ['#3a2c22', '#2c2018'],
    extra(a) {
      const S1 = '#c8302a';
      const S2 = '#8a1a14';
      for (let y = 2; y < 14; y++) for (let x = 6; x < 26; x++) {
        const dx = (x + 0.5 - 16) / 9.4;
        const dy = (y + 0.5 - 12) / 9.6;
        if (dx * dx + dy * dy <= 1) a.set(x, y, x > 20 ? S2 : S1);
      }
      a.rect(6, 12, 3, 9, S1); a.rect(23, 12, 3, 9, S2);
      a.rect(8, 19, 2, 3, S1); a.rect(22, 19, 2, 3, S2);
      a.rect(14, 23, 4, 2, S1); a.set(13, 24, S2); a.set(18, 24, S2);
      for (const [x, y] of [[10, 5], [15, 4], [20, 6], [12, 9], [18, 8], [23, 10], [7, 15], [24, 17], [9, 11]]) a.set(x, y, '#f4efe2');
      a.rect(11, 11, 10, 1, '#c6ccd4');
    },
  },
  PETRO: { // farmer: flat cap, big grey moustache
    skin: 'tan', hair: ['#9aa0a8', '#6a707a'], brow: '#c6ccd4', clothes: ['#3a5a8a', '#2a4066'], collar: '#c8b890', wrinkles: true, bg: ['#3a3420', '#2c2818'],
    extra(a, c) {
      for (let y = 3; y < 11; y++) for (let x = 7; x < 25; x++) {
        const dx = (x + 0.5 - 16) / 8.8;
        const dy = (y + 0.5 - 10) / 7;
        if (dx * dx + dy * dy <= 1) a.set(x, y, (x + y) % 3 ? '#6a5a40' : '#4a3e2a');
      }
      a.rect(7, 9, 19, 2, '#4a3e2a'); a.rect(17, 10, 10, 1, '#3a3020');
      a.rect(8, 11, 2, 4, c.hair[0]); a.rect(22, 11, 2, 4, c.hair[1]);
      a.rect(12, 18, 8, 1, '#e4e8ec'); a.rect(11, 19, 3, 1, '#b0b6be'); a.rect(18, 19, 3, 1, '#b0b6be');
    },
  },
  IVAN: { // railwayman: navy peaked cap with a gold badge, brass buttons
    skin: 'mid', hair: ['#4a3020', '#2e1c12'], clothes: ['#2a3450', '#1a2238'], collar: '#c6ccd4', frown: true, bg: ['#1c2230', '#161a26'],
    extra(a, c) {
      for (let y = 3; y < 10; y++) for (let x = 7; x < 25; x++) if (Math.abs(x + 0.5 - 16) <= 8.5 - (y < 5 ? 5 - y : 0)) a.set(x, y, x > 20 ? '#1a2238' : '#2a3450');
      a.rect(7, 9, 18, 1, '#1a2238'); a.rect(9, 10, 14, 1, '#0e1220');
      a.rect(15, 5, 2, 2, '#f8b800'); a.set(15, 5, '#ffe08a');
      a.rect(8, 11, 2, 5, c.hair[0]); a.rect(22, 11, 2, 5, c.hair[1]);
      for (const y of [27, 30]) { a.set(14, y, '#f8b800'); a.set(17, y, '#f8b800'); }
    },
  },
  LEV: { // fisherman: yellow sou'wester, white beard
    skin: 'tan', hair: ['#e8eaee', '#c6ccd4'], brow: '#e8eaee', clothes: ['#d8a020', '#a87810'], collar: '#4a3020', wrinkles: true, bg: ['#22303a', '#1a262e'],
    extra(a) {
      for (let y = 2; y < 11; y++) for (let x = 7; x < 25; x++) {
        const dx = (x + 0.5 - 16) / 8.4;
        const dy = (y + 0.5 - 10) / 7.5;
        if (dx * dx + dy * dy <= 1) a.set(x, y, x > 20 ? '#b88a10' : '#f0c020');
      }
      a.rect(5, 9, 22, 2, '#b88a10'); a.rect(5, 9, 22, 1, '#f0c020');
      a.rect(5, 11, 3, 5, '#b88a10'); a.rect(24, 11, 3, 5, '#b88a10');
      for (let y = 17; y < 25; y++) for (let x = 9; x < 23; x++) {
        const dx = (x + 0.5 - 16) / 7;
        const dy = (y + 0.5 - 17) / 7.5;
        if (dx * dx + dy * dy <= 1 && !(y === 19 && x >= 14 && x <= 17)) a.set(x, y, (x + y) % 3 ? '#e8eaee' : '#c6ccd4');
      }
      a.rect(12, 17, 8, 1, '#f4f4f4');
    },
  },
  VASYL: { // bell ringer: bald crown, thick brows, full dark beard
    skin: 'mid', hair: ['#3a2a1e', '#22160e'], clothes: ['#6a6258', '#4a443c'], collar: '#2a2620', bg: ['#2a2430', '#201a26'],
    extra(a, c) {
      a.rect(7, 10, 3, 6, c.hair[0]); a.rect(22, 10, 3, 6, c.hair[1]);
      a.set(15, 6, '#f0c8a0'); a.set(16, 6, '#f0c8a0'); a.set(15, 7, '#f0c8a0');
      for (let y = 16; y < 25; y++) for (let x = 8; x < 24; x++) {
        const dx = (x + 0.5 - 16) / 8;
        const dy = (y + 0.5 - 16) / 8.5;
        if (dx * dx + dy * dy <= 1 && !(y === 19 && x >= 14 && x <= 17) && !(y < 18 && x > 12 && x < 19)) a.set(x, y, (x + y) % 3 ? c.hair[0] : c.hair[1]);
      }
      a.rect(10, 11, 4, 2, c.hair[1]); a.rect(18, 11, 4, 2, c.hair[1]);
    },
  },
  MILA: { // neighbour: dark hair in a bun, cardigan
    skin: 'light', hair: ['#3a2418', '#24140c'], clothes: ['#7a2a3a', '#5a1a28'], collar: '#e8d8a8', freckles: true, bg: ['#2a2224', '#1e181a'],
    extra(a, c) {
      const [H, Hd] = c.hair;
      for (let y = 3; y < 12; y++) for (let x = 7; x < 25; x++) {
        const dx = (x + 0.5 - 16) / 8.6;
        const dy = (y + 0.5 - 11) / 8.2;
        if (dx * dx + dy * dy <= 1) a.set(x, y, x > 19 ? Hd : H);
      }
      a.ell(16, 2.5, 3.5, 2.5, Hd);
      a.rect(7, 11, 3, 9, H); a.rect(22, 11, 3, 9, Hd);
      a.rect(10, 10, 7, 2, H);
    },
  },
  DMYTRO: { // tank crew, cut off: padded helmet, a bandage, soot
    skin: 'mid', hair: ['#2a1c14', '#1a100a'], clothes: ['#4a5634', '#343d24'], collar: '#2a2418', frown: true, bg: ['#30261e', '#241c16'],
    extra(a) {
      for (let y = 3; y < 13; y++) for (let x = 7; x < 25; x++) {
        const dx = (x + 0.5 - 16) / 8.6;
        const dy = (y + 0.5 - 12) / 8.6;
        if (dx * dx + dy * dy <= 1) a.set(x, y, x === 12 || x === 16 || x === 20 ? '#1a1a14' : x < 12 ? '#3a3a2a' : '#2a2a1e');
      }
      a.rect(7, 11, 3, 8, '#2a2a1e'); a.rect(22, 11, 3, 8, '#1a1a14');
      a.rect(8, 9, 16, 2, '#f4efe2'); a.set(12, 9, '#c8302a'); a.set(12, 10, '#983000');
      a.set(19, 17, '#5a4a40'); a.set(20, 18, '#5a4a40'); a.set(11, 18, '#5a4a40');
    },
  },
  BOHDAN: { // truck driver: knit beanie, stubble, red scarf
    skin: 'light', hair: ['#5a3a1a', '#3a2410'], clothes: ['#5a4a3a', '#3e3228'], bg: ['#26303a', '#1c242c'],
    extra(a, c) {
      for (let y = 2; y < 12; y++) for (let x = 7; x < 25; x++) {
        const dx = (x + 0.5 - 16) / 8.4;
        const dy = (y + 0.5 - 11) / 8.6;
        if (dx * dx + dy * dy <= 1) a.set(x, y, x % 2 ? '#4a5a7a' : '#3a4a66');
      }
      a.rect(7, 10, 18, 2, '#2a3450');
      for (let y = 17; y < 22; y++) for (let x = 9; x < 23; x++) if (a.get(x, y) && (x + y) % 2 === 0 && !(y === 19 && x >= 14 && x <= 17)) a.set(x, y, c.sd);
      a.rect(9, 24, 14, 3, '#c8302a'); a.rect(9, 26, 14, 1, '#8a1a14');
    },
  },
};

let registered = false;
/** Portraits and name plates for the event speakers who are not crew (once). */
export function registerEventFaces(): void {
  if (registered) return;
  registered = true;
  for (const [who, f] of Object.entries(FACES)) addPortrait(`ev-${who.toLowerCase()}`, f, [who]);
  for (const [who, c] of Object.entries(CIVILIANS)) PLATES.set(who, { name: c.name, sub: c.role });
}

export interface EventCardOpts {
  card: EventCard;
  /** an answer was picked: apply it; returns the speaker's reply (typed out before the card closes) */
  onAnswer: (i: number) => Line | null;
  onLine?: (who: string) => void;
  /** skipped = ESC held before answering: the players walked away (the event stays) */
  onClose: (skipped: boolean) => void;
}

/** The map event card, over everything (the app pauses the world while it is open). */
export function openEventCard(o: EventCardOpts): void {
  registerEventFaces();
  const card = o.card;
  const choices: Choice[] = card.choices.map((c) => ({ text: c.text, reward: { kind: 'hint' } }));
  const labels = new Map(choices.map((c, i) => [c, card.choices[i].label]));
  openStory({
    pages: [{ tag: 'MAP EVENT', sub: card.place, title: card.title, bg: BG[card.kind] ?? 'farm', lines: card.lines, choices }],
    label: (c) => labels.get(c) ?? { text: '', icon: '', cls: '' },
    onAnswer: o.onAnswer,
    onLine: o.onLine,
    onClose: o.onClose,
  });
}
