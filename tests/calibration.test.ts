/**
 * Pinned external calibration.
 *
 * The battery in data/calibration-builds.json is the only oracle in the repo that comes from
 * outside the wiki/WFCD. It used to be sampled live, which made the bar move; now the same
 * builds are checked every run, including melee and secondary weapons.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { loadSnapshot } from '../src/data.ts';
import { resolveBuild } from '../src/engine/build.ts';
import {
  diffOracle,
  loadOracleExceptions,
  nonApplicableFields,
  type Oracle,
} from '../tools/lib/overframe.ts';

const fixture = JSON.parse(
  readFileSync(new URL('../data/calibration-builds.json', import.meta.url), 'utf8'),
) as {
  builds: Array<{
    id: number; weapon: string; mods: Array<{ name: string; rank: number }>;
    arcanes: Array<{ name: string; rank: number }>; oracle: Oracle;
  }>;
};
const snapshot = loadSnapshot();
const exceptions = loadOracleExceptions();

/** Same choice the calibration tool makes: the fire mode with the fewest diffs. */
function matches(entry: (typeof fixture.builds)[number]): string[] {
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

test('the pinned battery covers melee and secondary weapons', () => {
  const category = (weapon: string) => snapshot.weapons[weapon]?.category;
  const melee = fixture.builds.filter((entry) => category(entry.weapon) === 'melee');
  const secondary = fixture.builds.filter((entry) => category(entry.weapon) === 'secondary');
  assert.ok(melee.length >= 5, `only ${melee.length} melee builds in the battery`);
  assert.ok(secondary.length >= 5, `only ${secondary.length} secondary builds in the battery`);
});

test('every pinned melee and secondary build matches the Overframe oracle', () => {
  const category = (weapon: string) => snapshot.weapons[weapon]?.category;
  const relevant = fixture.builds.filter((entry) => ['melee', 'secondary'].includes(category(entry.weapon) ?? ''));
  for (const entry of relevant) {
    const diffs = matches(entry);
    assert.deepEqual(diffs, [], `${entry.id} ${entry.weapon}: ${diffs.join('; ')}`);
  }
});
