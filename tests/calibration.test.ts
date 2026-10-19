/**
 * Pinned external calibration.
 *
 * The battery in data/calibration-builds.json is the only oracle from outside the wiki/WFCD.
 * It is local and gitignored (no third-party build pages are redistributed), so this test is
 * skipped in a fresh clone or CI; run `npm run calibrate:refresh` to create it.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { loadSnapshot } from '../src/data.ts';
import { resolveBuild } from '../src/engine/build.ts';
import {
  diffOracle,
  loadOracleExceptions,
  nonApplicableFields,
  type Oracle,
} from '../tools/lib/oracle.ts';

type PinnedBuild = {
  id: number; weapon: string; mods: Array<{ name: string; rank: number }>;
  arcanes: Array<{ name: string; rank: number }>; oracle: Oracle;
};

const FIXTURE = new URL('../data/calibration-builds.json', import.meta.url);
const fixture: { builds: PinnedBuild[] } | null = existsSync(FIXTURE)
  ? JSON.parse(readFileSync(FIXTURE, 'utf8')) as { builds: PinnedBuild[] }
  : null;
const snapshot = loadSnapshot();
const exceptions = loadOracleExceptions();

/** Same choice the calibration tool makes: the fire mode with the fewest diffs. */
function matches(entry: PinnedBuild): string[] {
  const weapon = snapshot.weapons[entry.weapon];
  const variants: Array<string | undefined> = [undefined, ...(weapon?.modes ?? []).map((mode) => mode.name)];
  let best: string[] | null = null;
  for (const mode of variants) {
    let resolved;
    try {
      resolved = resolveBuild(snapshot, { weapon: entry.weapon, mods: entry.mods, arcanes: entry.arcanes, mode });
    } catch (error) {
      best ??= [String((error as Error).message)];
      continue;
    }
    const diffs = diffOracle(entry.oracle, resolved)
      .filter((diff) => !nonApplicableFields(resolved).has(diff.field))
      .filter((diff) => !exceptions[entry.weapon]?.[diff.field])
      .map((diff) => `${diff.field} ${diff.actual.toFixed(3)} vs ${diff.expected.toFixed(3)}`);
    if (!diffs.length) return [];
    if (!best || diffs.length < best.length) best = diffs;
  }
  return best ?? ['could not resolve'];
}

const skip = fixture ? false : 'local calibration battery not present; run npm run calibrate:refresh';

test('the pinned battery covers melee and secondary weapons', { skip }, () => {
  const data = fixture!;
  const category = (weapon: string) => snapshot.weapons[weapon]?.category;
  const melee = data.builds.filter((entry) => category(entry.weapon) === 'melee');
  const secondary = data.builds.filter((entry) => category(entry.weapon) === 'secondary');
  assert.ok(melee.length >= 5, `only ${melee.length} melee builds in the battery`);
  assert.ok(secondary.length >= 5, `only ${secondary.length} secondary builds in the battery`);
});

test('every pinned melee and secondary build matches the external oracle', { skip }, () => {
  const data = fixture!;
  const category = (weapon: string) => snapshot.weapons[weapon]?.category;
  const relevant = data.builds.filter((entry) => ['melee', 'secondary'].includes(category(entry.weapon) ?? ''));
  for (const entry of relevant) {
    const diffs = matches(entry);
    assert.deepEqual(diffs, [], `${entry.id} ${entry.weapon}: ${diffs.join('; ')}`);
  }
});
