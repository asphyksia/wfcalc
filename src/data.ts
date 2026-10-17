/**
 * Snapshot loading and name lookup.
 *
 * The snapshot is a single JSON file built by `npm run update`. It is loaded once
 * and kept in memory; lookups are case-insensitive and tolerant of partial names
 * ("lex prime", "LEX P", "kuva bramma").
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { EnemyData, ModData, Snapshot, WarframeData, WeaponData } from './types.ts';

const DEFAULT_PATH = new URL('../data/snapshot.json', import.meta.url).pathname;

let cached: Snapshot | null = null;

export function loadSnapshot(path: string = DEFAULT_PATH): Snapshot {
  if (cached && path === DEFAULT_PATH) return cached;
  const snapshot = JSON.parse(readFileSync(path, 'utf8')) as Snapshot;
  if (path === DEFAULT_PATH) cached = snapshot;
  return snapshot;
}

/** Normalises a name for matching: lowercase, no punctuation, single spaces. */
export function normalizeName(name: string): string {
  return name
    .toLowerCase()
    .replace(/[''`]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

interface LookupOptions {
  /** Show "did you mean" candidates. */
  limit?: number;
}

/** Generic fuzzy lookup over a name-keyed record. */
export function findByName<T extends { name: string }>(
  items: Record<string, T>,
  query: string,
  options: LookupOptions = {},
): { item: T | null; suggestions: string[] } {
  const wanted = normalizeName(query);
  if (items[query]) return { item: items[query], suggestions: [] };

  for (const item of Object.values(items)) {
    if (normalizeName(item.name) === wanted) return { item, suggestions: [] };
  }
  // Prefix / substring matches, shortest name first (so "lex" finds "Lex" before "Lex Prime").
  const partial = Object.values(items)
    .filter((item) => normalizeName(item.name).includes(wanted))
    .sort((a, b) => a.name.length - b.name.length);
  if (partial.length && normalizeName(partial[0].name).startsWith(wanted)) {
    return { item: partial[0], suggestions: partial.slice(0, options.limit ?? 5).map((i) => i.name) };
  }
  return { item: null, suggestions: partial.slice(0, options.limit ?? 5).map((i) => i.name) };
}

export const findWeapon = (snap: Snapshot, query: string) => findByName(snap.weapons, query);
export const findMod = (snap: Snapshot, query: string) => findByName(snap.mods, query);
export const findEnemy = (snap: Snapshot, query: string) => findByName(snap.enemies, query);
export const findWarframe = (snap: Snapshot, query: string) => findByName(snap.warframes, query);

/** Mods that fit a weapon, cheapest filter to build pickers from. */
export function modsForWeapon(snap: Snapshot, weapon: WeaponData): ModData[] {
  const classes = new Set(weapon.modClasses.map((c) => c.toLowerCase()));
  // Family-wide classes that fit every weapon of the category.
  const wildcards = new Set(['mod', 'antique']);
  const categoryWildcards: Record<string, string[]> = {
    primary: ['primary'],
    secondary: ['secondary'],
    melee: ['melee'],
    archgun: ['archgun'],
    archmelee: ['archmelee'],
    sentinel: ['companion', 'companion weapon', 'sentinel', 'robotic'],
  };
  const extra = (categoryWildcards[weapon.category] ?? []).map((c) => c.toLowerCase());

  return Object.values(snap.mods).filter((mod) =>
    mod.classes.some((c) => {
      const key = c.toLowerCase();
      return classes.has(key) || wildcards.has(key) || extra.includes(key);
    }),
  );
}

export type { EnemyData, ModData, Snapshot, WarframeData, WeaponData };
export { join as _join };
