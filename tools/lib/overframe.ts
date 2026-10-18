/**
 * Shared Overframe helpers for the calibration tools.
 *
 * Overframe's public API (`/api/v1/builds/<id>`) gives a build's mod ids, ranks and the
 * game's own modifier block. `tools/fetch-overframe-db.ts` learns what those ids are,
 * which makes the whole comparison unattended.
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { normalizeName } from '../../src/data.ts';
import type { Snapshot } from '../../src/types.ts';

const ROOT = new URL('../..', import.meta.url).pathname;
export const DB_FILE = join(ROOT, 'data/raw/overframe-db.json');

export interface OverframeDb {
  mods: Record<string, string>;
  arcanes: Record<string, string>;
  items: Record<string, string>;
}

export function loadOverframeDb(): OverframeDb {
  if (!existsSync(DB_FILE)) {
    throw new Error('data/raw/overframe-db.json missing — run: node tools/fetch-overframe-db.ts');
  }
  return JSON.parse(readFileSync(DB_FILE, 'utf8'));
}

const API = 'https://overframe.gg/api/v1';

export async function getBuild(id: number | string): Promise<any> {
  const response = await fetch(`${API}/builds/${id}`, {
    headers: { 'user-agent': 'Mozilla/5.0 wfcalc/0.1', accept: 'application/json' },
  });
  if (!response.ok) throw new Error(`Overframe API ${response.status} for build ${id}`);
  return response.json();
}

export async function listBuilds(page = 1, limit = 100): Promise<{ results: any[]; next: string | null }> {
  const response = await fetch(`${API}/builds?limit=${limit}&page=${page}`, {
    headers: { 'user-agent': 'Mozilla/5.0 wfcalc/0.1', accept: 'application/json' },
  });
  if (!response.ok) throw new Error(`Overframe API ${response.status} for the build list`);
  const data: any = await response.json();
  return { results: data.results ?? [], next: data.next ?? null };
}

/** Case- and punctuation-insensitive weapon lookup, since URLs are slugs. */
export function findWeaponName(snapshot: Snapshot, name: string): string | null {
  if (snapshot.weapons[name]) return name;
  const wanted = normalizeName(name);
  for (const candidate of Object.keys(snapshot.weapons)) {
    if (normalizeName(candidate) === wanted) return candidate;
  }
  return null;
}

/** `/build/374539/revenant-prime/...` -> `Revenant Prime`. */
export function weaponNameFromUrl(url: string): string | null {
  const match = /\/build\/\d+\/([^/]+)\//.exec(url);
  return match ? match[1].replace(/-/g, ' ') : null;
}

export interface Oracle {
  multishot: number;
  critChance: number;
  critMultiplier: number;
  statusChance: number;
  fireRate: number;
  magazine: number;
  reload: number;
  punchThrough: number;
}

/**
 * The stats Overframe exposes, which are the game's own modifier keys. They are computed
 * *without* conditional toggles, which is what makes them comparable to an unstacked build.
 */
export function oracleOf(build: any): Oracle | null {
  const stats = build?.stats ?? {};
  const pick = (key: string): number | null => (typeof stats[key] === 'number' ? stats[key] : null);
  const values = {
    multishot: pick('WEAPON_FIRE_ITERATIONS'),
    critChance: pick('WEAPON_CRIT_CHANCE'),
    critMultiplier: pick('WEAPON_CRIT_DAMAGE'),
    statusChance: pick('WEAPON_PROC_CHANCE'),
    fireRate: pick('WEAPON_FIRE_RATE'),
    magazine: pick('WEAPON_CLIP_MAX'),
    reload: pick('WEAPON_RELOAD_TIME'),
    punchThrough: pick('WEAPON_PUNCTURE_DEPTH'),
  };
  if (Object.values(values).some((value) => value === null)) return null;
  return values as Oracle;
}

export interface ResolvedBuildInput {
  weapon: string;
  mods: Array<{ name: string; rank: number }>;
  arcanes: Array<{ name: string; rank: number }>;
  /** Ids that could not be resolved to a name in our snapshot. */
  unknown: string[];
}

/**
 * Turns an Overframe build into names our engine understands, using the learned id map.
 * Weapon and mods are matched against the snapshot so an Overframe-only item is reported
 * instead of silently skipped.
 */
export function resolveBuildInput(build: any, db: OverframeDb, snapshot: Snapshot): ResolvedBuildInput | null {
  const weaponId = String(build.item_data?.id ?? build.item ?? '');
  const slug = weaponNameFromUrl(build.url ?? '') ?? '';
  const weaponName = findWeaponName(snapshot, db.items[weaponId] ?? slug) ?? '';
  if (!weaponName) return null;

  const mods: Array<{ name: string; rank: number }> = [];
  const arcanes: Array<{ name: string; rank: number }> = [];
  const unknown: string[] = [];

  for (const slot of build.slots ?? []) {
    const id = String(slot?.mod ?? '');
    if (!id || slot.rank === undefined) continue;
    const rank = Number(slot.rank);

    const modName = db.mods[id];
    if (modName) {
      if (!snapshot.mods[modName]) unknown.push(`mod ${id}=${modName}`);
      else mods.push({ name: modName, rank });
      continue;
    }
    const arcaneName = db.arcanes[id];
    if (arcaneName) {
      if (!snapshot.arcanes[arcaneName]) unknown.push(`arcane ${id}=${arcaneName}`);
      else arcanes.push({ name: arcaneName, rank });
      continue;
    }
    unknown.push(`id ${id}`);
  }

  if (!mods.length) return null;
  return { weapon: weaponName, mods, arcanes, unknown };
}

export interface StatDiff {
  field: string;
  expected: number;
  actual: number;
}

/**
 * Fields that do not apply to a weapon and must not be compared.
 *
 * Overframe reports a 2 s reload and a 1 round magazine for every melee weapon, and a
 * 1 round magazine for bows, where the game has neither. Our data has 0, so comparing
 * them directly would be a false mismatch.
 */
export function nonApplicableFields(resolved: ReturnType<typeof import('../../src/engine/build.ts').resolveBuild>): Set<string> {
  const skip = new Set<string>();
  if (resolved.weapon.category === 'melee') {
    skip.add('reload');
    skip.add('magazine');
  }
  if (resolved.reloadTime === 0) skip.add('reload');
  if (resolved.magazineSize === 0) skip.add('magazine');
  return skip;
}

/**
 * Picks the fire mode whose unstacked stats match the oracle best, so a calibration run
 * measures the *formulas* rather than our default mode choice. Charge weapons (Nataruk)
 * are the reason this exists: the arsenal block is the quick shot, and Overframe reports
 * the charged one.
 */
export function bestModeFor(snapshot: Snapshot, weaponName: string, oracle: Oracle): string | undefined {
  const weapon = snapshot.weapons[weaponName];
  if (!weapon?.modes.length) return undefined;
  let best: { name: string; score: number } | null = null;
  for (const mode of weapon.modes) {
    const score =
      Math.abs(mode.stats.critChance - weapon.stats.critChance) +
      Math.abs(mode.stats.critMultiplier - weapon.stats.critMultiplier) * 0.1;
    if (!best || score > best.score) best = { name: mode.name, score };
  }
  // Only override the default when the default's own crit is far from the oracle's shape.
  const defaultCrit = weapon.stats.critChance || 1;
  const oracleRatio = oracle.critChance / defaultCrit;
  const variants = [undefined, ...weapon.modes.map((mode) => mode.name)];
  let chosen: string | undefined;
  let bestError = Infinity;
  for (const variant of variants) {
    const stats = variant ? weapon.modes.find((mode) => mode.name === variant)!.stats : weapon.stats;
    const error = Math.abs(stats.critChance / defaultCrit - oracleRatio);
    if (error < bestError - 1e-9) {
      bestError = error;
      chosen = variant;
    }
  }
  return chosen;
}

const near = (actual: number, expected: number, tolerance = 3e-3): boolean =>
  Math.abs(actual - expected) <= Math.max(1e-3, Math.abs(expected) * tolerance);

/** Compares an oracle against a resolved build; an empty list means full agreement. */
export function diffOracle(oracle: Oracle, resolved: ReturnType<typeof import('../../src/engine/build.ts').resolveBuild>): StatDiff[] {
  const checks: Array<[keyof Oracle, number]> = [
    ['multishot', resolved.multishot],
    ['critChance', resolved.critChance],
    ['critMultiplier', resolved.critMultiplier],
    ['statusChance', resolved.statusChance],
    ['fireRate', resolved.fireRate],
    ['magazine', resolved.magazineSize],
    ['reload', resolved.reloadTime],
  ];
  const out: StatDiff[] = [];
  for (const [field, actual] of checks) {
    const expected = oracle[field];
    if (!near(actual, expected)) out.push({ field, expected, actual });
  }
  return out;
}

/**
 * Fields where Overframe's oracle is demonstrably wrong and our data is verified in game.
 * Kept in data/oracle-exceptions.json with the evidence, so a green calibration run means
 * something instead of being gamed by silent overrides.
 */
export interface OracleException {
  ours: number;
  oracle: number;
  evidence: string;
}

export function loadOracleExceptions(): Record<string, Record<string, OracleException>> {
  const file = join(ROOT, 'data/oracle-exceptions.json');
  if (!existsSync(file)) return {};
  const raw = JSON.parse(readFileSync(file, 'utf8'));
  delete raw._comment;
  return raw;
}

export const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));
