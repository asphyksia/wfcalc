/**
 * Reports how much of the dataset the mod parser actually understands.
 *
 * Run: node tools/coverage.ts [--verbose]
 *
 * Prints, per mod category, how many mods have every stat line mapped to a
 * typed effect. Mods that are only partially understood are listed so the long
 * tail can be attacked in order of impact.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ModData, Snapshot } from '../src/types.ts';

const ROOT = new URL('..', import.meta.url).pathname;
const snapshot = JSON.parse(readFileSync(join(ROOT, 'data/snapshot.json'), 'utf8')) as Snapshot;
const verbose = process.argv.includes('--verbose');

/** Categories that affect weapon damage; warframe/railjack/K-drive mods are out of scope for now. */
const WEAPON_CLASSES = new Set([
  'rifle', 'shotgun', 'pistol', 'melee', 'bow', 'sniper', 'archgun', 'archmelee',
  'primary', 'secondary', 'assault rifle', 'thrown melee', 'claws', 'tome',
]);

const usesWeaponStats = (mod: ModData): boolean => mod.classes.some((c) => WEAPON_CLASSES.has(c.toLowerCase()));

const mods = Object.values(snapshot.mods);
const weaponMods = mods.filter(usesWeaponStats);
const partial = (list: ModData[]) => list.filter((m) => m.partial);

const ratio = (list: ModData[], subset: ModData[]): string =>
  `${subset.length}/${list.length} (${((100 * subset.length) / Math.max(1, list.length)).toFixed(0)}%)`;

const unknown = weaponMods.filter((m) => m.partial);
const usable = weaponMods.filter((m) => !m.partial);

console.log(`mods total:          ${mods.length}`);
console.log(`weapon-relevant:     ${weaponMods.length}`);
console.log(`fully modelled:      ${ratio(weaponMods, usable)}   (every stat line understood)`);
console.log(`unknown lines:       ${ratio(weaponMods, partial(weaponMods))}   (flagged as a lower bound)`);
console.log(`non-weapon mods:     ${mods.length - weaponMods.length} (outside weapon damage)`);
if (unknown.length) console.log(`\nunknown: ${unknown.map((m) => m.name).join(', ')}`);

if (verbose) {
  const lines = readFileSync(join(ROOT, 'docs/unmatched-mods.txt'), 'utf8').split('\n').filter(Boolean);
  const counts = new Map<string, number>();
  for (const line of lines) {
    const [mod, text] = line.split(' | ');
    const entry = snapshot.mods[mod];
    if (!entry || !usesWeaponStats(entry)) continue;
    const pattern = (text ?? '').replace(/[-+]?\d[\d.,]*/g, '#');
    counts.set(pattern, (counts.get(pattern) ?? 0) + 1);
  }
  console.log('\n-- most common unmapped lines in weapon mods --');
  for (const [pattern, count] of [...counts].sort((a, b) => b[1] - a[1]).slice(0, 25)) {
    console.log(`${String(count).padStart(4)}  ${pattern}`);
  }
}
